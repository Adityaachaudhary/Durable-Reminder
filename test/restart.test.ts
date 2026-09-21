import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeNotifier, ManualClock, SqliteStore, advanceUntilSettled } from '../src';
import { at, claimNow, closeAll, makeSystem, outcomes, removeDir, track } from './helpers';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reminders-'));
  path = join(dir, 'reminders.db');
});
afterEach(() => {
  closeAll();
  removeDir(dir);
});

/** "Restart" = a brand new store, worker and clock object on the same database file; nothing else is carried over. */
const boot = (start: number, notifier = new FakeNotifier()) => {
  const clock = new ManualClock(start);
  const store = track(new SqliteStore(path));
  return makeSystem({ clock, store, notifier });
};

describe('AC2: restart recovery', () => {
  it('work that became due while the service was stopped is delivered after restart, oldest first, with lateness recorded', async () => {
    const first = boot(at('2026-03-01T00:00:00Z'));
    const create = (id: string, when: string) => first.service.create({ id, content: id, timeZone: 'Asia/Kolkata', at: when });
    create('c-third', '2026-03-01T12:00:00Z');
    create('a-first', '2026-03-01T10:00:00Z');
    create('b-second', '2026-03-01T11:00:00Z');
    create('d-not-yet', '2026-03-03T00:00:00Z');
    first.store.close(); // service stopped; nothing is running when these become due

    const notifier = new FakeNotifier();
    const second = boot(at('2026-03-01T13:00:00Z'), notifier); // service restarted three hours after the first due time
    await second.worker.runUntilIdle();

    expect(notifier.sendLog).toEqual(['a-first:v1', 'b-second:v1', 'c-third:v1']);
    expect(second.store.getItem('d-not-yet')?.state).toBe('scheduled');
    expect(second.service.get('a-first').attempts[0]?.latenessMs).toBe(3 * 3_600_000);
    expect(second.service.get('c-third').attempts[0]?.latenessMs).toBe(3_600_000);
    expect(second.store.nextWakeTime()).toBe(at('2026-03-03T00:00:00Z'));
  });

  it('a pending retry survives a restart and keeps its schedule and attempt count', async () => {
    const first = boot(at('2026-03-01T10:00:00Z'));
    first.service.create({ id: 'r', content: 'x', timeZone: 'UTC', at: '2026-03-01T10:00:00Z' });
    first.notifier.plan('r:v1', 'temporary');
    await first.worker.runUntilIdle();
    expect(first.store.getItem('r')?.nextAttemptAt).toBe(at('2026-03-01T10:00:30Z'));
    first.store.close();

    const notifier = new FakeNotifier();
    const second = boot(at('2026-03-01T10:00:29Z'), notifier);
    expect((await second.worker.tick()).claimed).toBe(0);
    second.clock.set(at('2026-03-01T10:00:30Z'));
    await second.worker.runUntilIdle();

    expect(second.store.getItem('r')?.state).toBe('delivered');
    expect(outcomes(second.store, 'r')).toEqual(['temporary_failure', 'delivered']);
    expect(second.store.getAttempts('r').map((a) => a.occurrenceAttempt)).toEqual([1, 2]);
  });

  it('a worker that claimed an item and died is taken over after its lease expires; the earlier attempt is marked abandoned', async () => {
    const first = boot(at('2026-03-01T10:00:00Z'));
    first.service.create({ id: 'r', content: 'x', timeZone: 'UTC', at: '2026-03-01T10:00:00Z' });
    claimNow(first.store, at('2026-03-01T10:00:00Z'), 'dead-worker', 30_000); // claimed, then the process died
    first.store.close();

    const notifier = new FakeNotifier();
    const second = boot(at('2026-03-01T10:00:10Z'), notifier);
    expect((await second.worker.tick()).claimed).toBe(0); // lease still valid: not stolen early
    expect(second.store.getItem('r')?.state).toBe('running');

    second.clock.set(at('2026-03-01T10:00:30Z')); // lease expires
    await second.worker.runUntilIdle();

    expect(second.store.getItem('r')?.state).toBe('delivered');
    expect(second.store.getAttempts('r').map((a) => [a.workerId, a.outcome])).toEqual([
      ['dead-worker', 'abandoned'],
      ['w1', 'delivered'],
    ]);
    expect(notifier.sendLog).toEqual(['r:v1']);
  });

  it('crash after the destination accepted but before the commit: the retry is a duplicate for the destination, one notification', async () => {
    const notifier = new FakeNotifier();
    const first = boot(at('2026-03-01T10:00:00Z'), notifier);
    first.service.create({ id: 'r', content: 'x', timeZone: 'UTC', at: '2026-03-01T10:00:00Z' });
    const [claim] = claimNow(first.store, at('2026-03-01T10:00:00Z'), 'dead-worker', 30_000);
    await notifier.send(claim!.notification); // the message went out, then the process died before committing
    first.store.close();

    const second = boot(at('2026-03-01T10:01:00Z'), notifier);
    await second.worker.runUntilIdle();

    expect(second.store.getItem('r')?.state).toBe('delivered');
    expect(notifier.sendCount('r:v1')).toBe(2);
    expect(notifier.logicalCount('r:v1')).toBe(1);
    expect(outcomes(second.store, 'r')).toEqual(['abandoned', 'duplicate_acknowledged']);
    expect(second.store.listDeliveries()).toHaveLength(1);
  });

  it('terminal states persist: delivered, cancelled and failed items stay put after a restart', async () => {
    const first = boot(at('2026-03-01T09:00:00Z'));
    for (const id of ['done', 'gone', 'bad']) first.service.create({ id, content: id, timeZone: 'UTC', at: '2026-03-01T10:00:00Z' });
    first.service.cancel('gone');
    first.notifier.plan('bad:v1', 'permanent');
    first.clock.set(at('2026-03-01T10:00:00Z'));
    await advanceUntilSettled(first);
    first.store.close();

    const second = boot(at('2026-03-05T00:00:00Z'));
    await second.worker.runUntilIdle();
    expect(second.store.counts()).toMatchObject({ delivered: 1, cancelled: 1, failed: 1, scheduled: 0, running: 0 });
    expect(second.notifier.sendLog).toEqual([]);
  });
});
