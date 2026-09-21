import { describe, expect, it } from 'vitest';
import { advanceUntilSettled, createGate, toIso } from '../src';
import { at, claimNow, makeSystem, outcomes } from './helpers';

const DUE = at('2026-03-01T10:00:00Z');
const create = (sys: ReturnType<typeof makeSystem>, id = 'r1', when = '2026-03-01T10:00:00Z') =>
  sys.service.create({ id, content: `content of ${id}`, timeZone: 'Asia/Kolkata', at: when });

describe('AC1: scheduled delivery', () => {
  it('delivers exactly once when the injected clock reaches the instant, in a named zone', async () => {
    const sys = makeSystem({ start: at('2026-03-07T00:00:00Z') });
    sys.service.create({ id: 'ny', content: 'Stand-up', timeZone: 'America/New_York', at: '2026-03-07T09:00' }); // 14:00Z

    sys.clock.set(at('2026-03-07T13:59:59.999Z'));
    await sys.worker.tick();
    expect(sys.notifier.received.size).toBe(0);
    expect(sys.store.getItem('ny')?.state).toBe('scheduled');

    sys.clock.set(at('2026-03-07T14:00:00.000Z'));
    const { claimed } = await sys.worker.tick();
    expect(claimed).toBe(1);

    const item = sys.service.get('ny');
    expect(item).toMatchObject({ state: 'delivered', version: 1 });
    expect(sys.notifier.logicalCount('ny:v1')).toBe(1);
    expect(sys.notifier.received.get('ny:v1')?.notification).toMatchObject({ content: 'Stand-up', itemId: 'ny', version: 1, timeZone: 'America/New_York' });
    expect(item.attempts).toHaveLength(1);
    expect(item.attempts[0]).toMatchObject({ outcome: 'delivered', occurrenceAttempt: 1, latenessMs: 0, deliveryKey: 'ny:v1' });
    expect(sys.store.getDelivery('ny:v1')).toMatchObject({ itemId: 'ny', version: 1 });
  });

  it('a delivered item is never delivered again, however often the worker polls', async () => {
    const sys = makeSystem();
    create(sys);
    sys.clock.set(DUE);
    for (let i = 0; i < 5; i++) await sys.worker.tick();
    await sys.clock.advance(3_600_000);
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toEqual(['r1:v1']);
  });
});

describe('due-work discovery with an injected clock', () => {
  it('finds only work that is due, oldest first', async () => {
    const sys = makeSystem();
    create(sys, 'late', '2026-03-01T12:00:00Z');
    create(sys, 'early', '2026-03-01T10:00:00Z');
    create(sys, 'middle', '2026-03-01T11:00:00Z');
    create(sys, 'future', '2026-03-02T00:00:00Z');

    sys.clock.set(at('2026-03-01T12:30:00Z'));
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toEqual(['early:v1', 'middle:v1', 'late:v1']);
    expect(sys.store.getItem('future')?.state).toBe('scheduled');
    expect(sys.store.nextWakeTime()).toBe(at('2026-03-02T00:00:00Z'));
  });

  it('respects the batch size and picks up the rest on the next pass', async () => {
    const sys = makeSystem({ batchSize: 2 });
    for (const id of ['a', 'b', 'c']) create(sys, id);
    sys.clock.set(DUE);
    expect((await sys.worker.tick()).claimed).toBe(2);
    expect((await sys.worker.tick()).claimed).toBe(1);
    expect((await sys.worker.tick()).claimed).toBe(0);
    expect(sys.notifier.received.size).toBe(3);
  });

  it('two workers polling the same store never take the same item', async () => {
    const sys = makeSystem({ batchSize: 3 });
    const other = sys.makeWorker('w2');
    for (const id of ['a', 'b', 'c', 'd', 'e']) create(sys, id);
    sys.clock.set(DUE);
    const [first, second] = await Promise.all([sys.worker.tick(), other.tick()]);
    expect(first.claimed + second.claimed).toBe(5);
    expect([...sys.notifier.sendLog].sort()).toEqual(['a:v1', 'b:v1', 'c:v1', 'd:v1', 'e:v1']);
    expect(sys.notifier.sendLog).toHaveLength(5); // nothing sent twice
  });

  it('never claims anything while nothing is scheduled', async () => {
    const sys = makeSystem();
    expect(await sys.worker.tick()).toEqual({ claimed: 0, results: [] });
    expect(sys.store.nextWakeTime()).toBeUndefined();
  });
});

describe('AC3: temporary failure and bounded retry', () => {
  it('records each failure, waits 30 s then 2 min, and succeeds on the third attempt', async () => {
    const sys = makeSystem();
    create(sys);
    sys.notifier.plan('r1:v1', 'temporary', 'temporary');

    sys.clock.set(DUE);
    await sys.worker.runUntilIdle();
    let item = sys.store.getItem('r1')!;
    expect(item).toMatchObject({ state: 'scheduled', nextAttemptAt: DUE + 30_000 }); // retry is visible, item not lost

    sys.clock.set(DUE + 29_999);
    expect((await sys.worker.tick()).claimed).toBe(0); // too early

    sys.clock.set(DUE + 30_000);
    await sys.worker.runUntilIdle();
    item = sys.store.getItem('r1')!;
    expect(item).toMatchObject({ state: 'scheduled', nextAttemptAt: DUE + 30_000 + 120_000 });

    sys.clock.set(DUE + 150_000);
    await sys.worker.runUntilIdle();

    expect(sys.store.getItem('r1')?.state).toBe('delivered');
    expect(outcomes(sys.store, 'r1')).toEqual(['temporary_failure', 'temporary_failure', 'delivered']);
    const attempts = sys.service.get('r1').attempts;
    expect(attempts.map((a) => a.occurrenceAttempt)).toEqual([1, 2, 3]);
    expect(attempts[0]?.detail).toContain('503');
    expect(sys.notifier.logicalCount('r1:v1')).toBe(1);
  });

  it('AC3 retry exhaustion: gives up after the bounded number of attempts and ends visibly failed', async () => {
    const sys = makeSystem();
    create(sys);
    sys.notifier.plan('r1:v1', 'temporary', 'temporary', 'temporary', 'temporary', 'temporary');
    sys.clock.set(DUE);
    const { settled } = await advanceUntilSettled(sys);

    expect(settled).toBe(true);
    const item = sys.service.get('r1');
    expect(item).toMatchObject({ state: 'failed', terminalReason: 'retries_exhausted' });
    expect(item.attempts).toHaveLength(4); // default maxAttempts
    expect(item.attempts.map((a) => a.claimedAt)).toEqual([
      toIso(DUE),
      toIso(DUE + 30_000),
      toIso(DUE + 30_000 + 120_000),
      toIso(DUE + 30_000 + 120_000 + 600_000),
    ]);
    expect(outcomes(sys.store, 'r1')).toEqual(Array(4).fill('temporary_failure'));
    expect(sys.store.getDelivery('r1:v1')).toBeUndefined();
    expect(sys.notifier.received.size).toBe(0);

    await sys.clock.advance(86_400_000); // a day later: still failed, no more sends
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toHaveLength(4);
  });

  it('honours a custom retry policy', async () => {
    const sys = makeSystem({ retry: { maxAttempts: 2, delaysMs: [1_000] } });
    create(sys);
    sys.notifier.plan('r1:v1', 'temporary', 'temporary', 'temporary');
    sys.clock.set(DUE);
    await advanceUntilSettled(sys);
    expect(sys.store.getAttempts('r1')).toHaveLength(2);
    expect(sys.store.getItem('r1')).toMatchObject({ state: 'failed', terminalReason: 'retries_exhausted' });
  });

  it('a permanent failure is not retried', async () => {
    const sys = makeSystem();
    create(sys);
    sys.notifier.plan('r1:v1', 'permanent');
    sys.clock.set(DUE);
    await advanceUntilSettled(sys);
    expect(sys.store.getItem('r1')).toMatchObject({ state: 'failed', terminalReason: 'permanent_failure' });
    expect(outcomes(sys.store, 'r1')).toEqual(['permanent_failure']);
    expect(sys.notifier.sendLog).toHaveLength(1);
  });

  it('unknown errors are treated as temporary (safe: delivery is idempotent and retries are bounded)', async () => {
    const sys = makeSystem();
    create(sys);
    sys.notifier.send = async () => {
      throw new Error('ECONNRESET');
    };
    sys.clock.set(DUE);
    await advanceUntilSettled(sys);
    expect(sys.store.getAttempts('r1')).toHaveLength(4);
    expect(sys.store.getItem('r1')?.terminalReason).toBe('retries_exhausted');
  });

  it('a lost acknowledgement is retried under the same key and the destination shows one notification', async () => {
    const sys = makeSystem();
    create(sys);
    sys.notifier.plan('r1:v1', 'lost_ack');
    sys.clock.set(DUE);
    await advanceUntilSettled(sys);

    expect(sys.store.getItem('r1')?.state).toBe('delivered');
    expect(outcomes(sys.store, 'r1')).toEqual(['temporary_failure', 'duplicate_acknowledged']);
    expect(sys.notifier.sendCount('r1:v1')).toBe(2);
    expect(sys.notifier.logicalCount('r1:v1')).toBe(1);
    expect(sys.store.listDeliveries()).toHaveLength(1);
  });
});

describe('AC4: duplicate execution', () => {
  it('two workers execute the same occurrence (lease expired mid-send): one logical notification, one delivery record', async () => {
    const sys = makeSystem({ leaseMs: 30_000 });
    const workerB = sys.makeWorker('w2');
    create(sys);
    const gate = createGate();
    sys.notifier.plan('r1:v1', { gate });

    sys.clock.set(DUE);
    const tickA = sys.worker.tick(); // A claims and is stuck inside send()
    await gate.reached;
    expect(sys.store.getItem('r1')?.state).toBe('running');

    sys.clock.set(DUE + 31_000); // A's lease has expired
    const tickB = await workerB.tick(); // B takes over, sends, commits
    expect(tickB.results[0]?.outcome).toBe('delivered');

    gate.open(); // A finally gets through
    const resultA = await tickA;
    expect(resultA.results[0]?.outcome).toBe('duplicate_acknowledged');

    expect(sys.notifier.sendCount('r1:v1')).toBe(2); // the destination was asked twice...
    expect(sys.notifier.logicalCount('r1:v1')).toBe(1); // ...and shows it once
    expect(sys.store.listDeliveries()).toHaveLength(1);
    expect(sys.store.getItem('r1')?.state).toBe('delivered');
    const attempts = sys.store.getAttempts('r1');
    expect(attempts.map((a) => [a.workerId, a.outcome])).toEqual([
      ['w1', 'duplicate_acknowledged'],
      ['w2', 'delivered'],
    ]);
  });

  it('executing the same claim twice sends once (duplicate acknowledgement)', async () => {
    const sys = makeSystem();
    create(sys);
    const [claim] = claimNow(sys.store, DUE);
    expect(claim).toBeDefined();
    expect((await sys.worker.execute(claim!)).outcome).toBe('delivered');
    expect((await sys.worker.execute(claim!)).outcome).toBe('duplicate_acknowledged');
    expect(sys.notifier.sendLog).toEqual(['r1:v1']);
    expect(outcomes(sys.store, 'r1')).toEqual(['delivered']);
  });

  it('the store itself refuses a second delivery record for one occurrence', async () => {
    const sys = makeSystem();
    create(sys);
    const [claim] = claimNow(sys.store, DUE);
    expect(sys.store.completeDelivered(claim!, { ack: 'accepted', now: DUE })).toEqual({ committed: true });
    expect(sys.store.completeDelivered(claim!, { ack: 'accepted', now: DUE })).toEqual({ committed: false, reason: 'already_delivered' });
    expect(sys.store.listDeliveries()).toHaveLength(1);
  });

  it('an item whose attempts keep vanishing (dead workers) is failed instead of looping forever', () => {
    const sys = makeSystem({ leaseMs: 30_000 });
    create(sys);
    let now = DUE;
    for (let i = 0; i < 4; i++) {
      expect(claimNow(sys.store, now)).toHaveLength(1); // claimed by a worker that then dies
      now += 31_000;
    }
    expect(claimNow(sys.store, now)).toHaveLength(0); // budget spent: nothing is claimed...
    expect(sys.store.getItem('r1')).toMatchObject({ state: 'failed', terminalReason: 'retries_exhausted' }); // ...and the item ends visibly
    expect(outcomes(sys.store, 'r1')).toEqual(Array(4).fill('abandoned'));
  });
});

describe('AC5: edit before execution', () => {
  it('the superseded schedule never fires; only the effective version is delivered', async () => {
    const sys = makeSystem();
    create(sys, 'r1', '2026-03-01T10:00:00Z');
    sys.service.edit('r1', { expectedVersion: 1, at: '2026-03-01T12:00:00Z', content: 'moved and rewritten' });

    sys.clock.set(at('2026-03-01T11:00:00Z')); // old time has passed
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toEqual([]);
    expect(sys.store.getItem('r1')).toMatchObject({ state: 'scheduled', version: 2 });

    sys.clock.set(at('2026-03-01T12:00:00Z'));
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toEqual(['r1:v2']);
    expect(sys.notifier.received.get('r1:v2')?.notification.content).toBe('moved and rewritten');
    expect(sys.store.getDelivery('r1:v1')).toBeUndefined();
    expect(sys.store.getDelivery('r1:v2')).toBeDefined();
  });

  it('editing a retrying item starts the new version with a fresh attempt budget', async () => {
    const sys = makeSystem();
    create(sys);
    sys.notifier.plan('r1:v1', 'temporary');
    sys.clock.set(DUE);
    await sys.worker.runUntilIdle(); // attempt 1 fails, retry pending
    sys.service.edit('r1', { expectedVersion: 1, content: 'new text' });
    expect(sys.store.getItem('r1')).toMatchObject({ version: 2, nextAttemptAt: null }); // due right away (time unchanged)
    await sys.worker.runUntilIdle();
    expect(sys.store.getItem('r1')?.state).toBe('delivered');
    expect(sys.store.getAttempts('r1').map((a) => [a.version, a.occurrenceAttempt, a.outcome])).toEqual([
      [1, 1, 'temporary_failure'],
      [2, 1, 'delivered'],
    ]);
  });
});

describe('AC6: cancellation', () => {
  it('cancelled before it is due: workers keep polling, nothing is ever sent or recorded', async () => {
    const sys = makeSystem();
    create(sys);
    sys.service.cancel('r1');
    sys.clock.set(DUE);
    for (let i = 0; i < 3; i++) await sys.worker.tick();
    await sys.clock.advance(86_400_000);
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toEqual([]);
    expect(sys.store.listDeliveries()).toEqual([]);
    expect(sys.store.getItem('r1')?.state).toBe('cancelled');
  });

  it('cancelled while a retry is pending: the retry never happens', async () => {
    const sys = makeSystem();
    create(sys);
    sys.notifier.plan('r1:v1', 'temporary');
    sys.clock.set(DUE);
    await sys.worker.runUntilIdle();
    sys.service.cancel('r1');
    await sys.clock.advance(3_600_000);
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toHaveLength(1);
    expect(sys.store.getItem('r1')?.state).toBe('cancelled');
    expect(sys.store.getDelivery('r1:v1')).toBeUndefined();
  });

  it('cancelled after the worker claimed it but before it sent: nothing is sent (fence)', async () => {
    const sys = makeSystem();
    create(sys);
    const [claim] = claimNow(sys.store, DUE);
    sys.service.cancel('r1');
    expect((await sys.worker.execute(claim!)).outcome).toBe('aborted_cancelled');
    expect(sys.notifier.sendLog).toEqual([]);
    expect(sys.store.getItem('r1')?.state).toBe('cancelled');
  });

  it('cancelled while the send is in flight: cancel wins, no delivery is recorded, the attempt says what really happened', async () => {
    const sys = makeSystem();
    create(sys);
    const gate = createGate();
    sys.notifier.plan('r1:v1', { gate });
    sys.clock.set(DUE);
    const tick = sys.worker.tick();
    await gate.reached;

    sys.service.cancel('r1');
    gate.open();
    const { results } = await tick;

    expect(results[0]?.outcome).toBe('sent_but_cancelled');
    expect(sys.store.getItem('r1')?.state).toBe('cancelled'); // still cancelled
    expect(sys.store.getDelivery('r1:v1')).toBeUndefined(); // no successful delivery recorded
    await sys.clock.advance(3_600_000);
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toHaveLength(1); // and nothing later
  });
});

describe('edit racing with execution (the follow-up question)', () => {
  it('edit after the claim, before the send: the old version is not sent; the new version is delivered once', async () => {
    const sys = makeSystem();
    create(sys);
    const [claim] = claimNow(sys.store, DUE);
    sys.service.edit('r1', { expectedVersion: 1, at: '2026-03-01T11:00:00Z' });
    expect((await sys.worker.execute(claim!)).outcome).toBe('aborted_superseded');
    expect(sys.notifier.sendLog).toEqual([]);

    sys.clock.set(at('2026-03-01T11:00:00Z'));
    await sys.worker.runUntilIdle();
    expect(sys.notifier.sendLog).toEqual(['r1:v2']);
    expect(sys.store.getItem('r1')).toMatchObject({ state: 'delivered', version: 2 });
  });

  it('edit while the old version is being sent: the edit wins; the in-flight send is recorded, never committed', async () => {
    const sys = makeSystem();
    create(sys);
    const gate = createGate();
    sys.notifier.plan('r1:v1', { gate });
    sys.clock.set(DUE);
    const tick = sys.worker.tick();
    await gate.reached;

    sys.service.edit('r1', { expectedVersion: 1, at: '2026-03-01T11:00:00Z', content: 'rescheduled' });
    gate.open();
    expect((await tick).results[0]?.outcome).toBe('sent_but_superseded');

    // Version 1 was handed to the destination before the edit landed: visible in history, but not a recorded delivery.
    expect(sys.store.getDelivery('r1:v1')).toBeUndefined();
    expect(sys.store.getItem('r1')).toMatchObject({ state: 'scheduled', version: 2 });

    sys.clock.set(at('2026-03-01T11:00:00Z'));
    await sys.worker.runUntilIdle();
    expect(sys.store.getItem('r1')).toMatchObject({ state: 'delivered', version: 2 });
    expect(sys.store.listDeliveries().map((d) => d.deliveryKey)).toEqual(['r1:v2']);
    expect(sys.store.getAttempts('r1').map((a) => [a.version, a.outcome])).toEqual([
      [1, 'sent_but_superseded'],
      [2, 'delivered'],
    ]);
  });

  it('a claim taken over by another worker loses its right to commit', async () => {
    const sys = makeSystem({ leaseMs: 30_000 });
    create(sys);
    const [stale] = claimNow(sys.store, DUE, 'slow');
    const [fresh] = claimNow(sys.store, DUE + 31_000, 'fast');
    expect(fresh?.occurrenceAttempt).toBe(2);
    expect(sys.store.fence(stale!)).toEqual({ valid: false, reason: 'lease_lost' });
    expect(sys.store.completeDelivered(stale!, { ack: 'accepted', now: DUE + 32_000 })).toEqual({ committed: false, reason: 'lease_lost' });
    expect(sys.store.completeDelivered(fresh!, { ack: 'accepted', now: DUE + 32_000 })).toEqual({ committed: true });
  });
});

describe('polling loop on the injected clock', () => {
  it('start() discovers due work as time passes and stop() ends the loop', async () => {
    const sys = makeSystem();
    create(sys, 'r1', '2026-03-01T10:00:05Z');
    sys.clock.set(DUE);
    sys.worker.start(1_000);
    await sys.clock.advance(4_000);
    expect(sys.notifier.received.size).toBe(0);
    await sys.clock.advance(2_000);
    expect(sys.notifier.logicalCount('r1:v1')).toBe(1);
    sys.worker.stop();
    expect(sys.clock.pendingTimers).toBe(0);
    expect(sys.errors).toEqual([]);
  });
});
