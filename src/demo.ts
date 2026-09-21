import { mkdirSync, rmSync } from 'node:fs';
import { ManualClock } from './clock';
import { createGate, FakeNotifier } from './fakeNotifier';
import { formatDetail } from './render';
import { advanceUntilSettled } from './settle';
import { ReminderService } from './service';
import { SqliteStore } from './store/sqliteStore';
import { Worker } from './worker';

const DB_PATH = 'data/demo.db';
const at = (iso: string) => Date.parse(iso);

/**
 * Scripted walkthrough with a controlled clock (no waiting). Follows the demo checklist:
 * 1 create + deliver, 2 restart recovery, 3 retry / edit / cancel, 4 duplicate execution, 5 benchmark pointer.
 */
export async function runDemo(): Promise<void> {
  mkdirSync('data', { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });

  const clock = new ManualClock(at('2026-03-07T00:00:00Z'));
  const say = (line = '') => console.log(line);
  const stamp = () => `[clock ${new Date(clock.now()).toISOString()}]`;
  const notifier = new FakeNotifier({ clock, log: say });
  const boot = (workerId: string) => {
    const store = new SqliteStore(DB_PATH);
    return { store, service: new ReminderService({ store, clock }), worker: new Worker({ store, notifier, clock, workerId }) };
  };

  let sys = boot('service-1');

  say('=== 1. Create a reminder in a named time zone, then advance controlled time to deliver it ===');
  say('A New York user asks for 02:30 on 8 March 2026. That local time does not exist (clocks jump 02:00 -> 03:00).');
  sys.service.create({ id: 'bank', content: 'Call the bank', timeZone: 'America/New_York', at: '2026-03-08T02:30' });
  say(formatDetail(sys.service.get('bank')));
  clock.set(at('2026-03-08T07:29:59Z'));
  say(`\n${stamp()} tick, one second before it is due:`);
  say(`  processed ${(await sys.worker.runUntilIdle()).length} attempts`);
  clock.set(at('2026-03-08T07:30:00Z'));
  say(`${stamp()} tick, at the scheduled instant:`);
  await sys.worker.runUntilIdle();
  say(formatDetail(sys.service.get('bank')));

  say('\n=== 2. Restart recovery: work becomes due while the service is stopped ===');
  sys.service.create({ id: 'first', content: 'Stand-up', timeZone: 'Asia/Kolkata', at: '2026-03-08T16:00' }); // 10:30Z
  sys.service.create({ id: 'second', content: 'Send the report', timeZone: 'UTC', at: '2026-03-08T11:00' });
  say('created two reminders due at 10:30Z and 11:00Z; now the service STOPS (process gone, only the database file remains)');
  sys.worker.stop();
  sys.store.close();
  clock.set(at('2026-03-08T12:00:00Z'));
  say(`${stamp()} service RESTARTS with a brand new store and worker`);
  sys = boot('service-2');
  await sys.worker.runUntilIdle();
  for (const id of ['first', 'second']) {
    const a = sys.service.get(id).attempts[0]!;
    say(`  ${id}: ${a.outcome}, delivered ${a.latenessMs / 60_000} minutes late (oldest due first)`);
  }

  say('\n=== 3a. Temporary failure: recorded, retried with bounded backoff, then delivered ===');
  sys.service.create({ id: 'flaky', content: 'Pay the invoice', timeZone: 'UTC', at: '2026-03-08T12:10:00Z' });
  notifier.plan('flaky:v1', 'temporary', 'temporary');
  clock.set(at('2026-03-08T12:10:00Z'));
  await advanceUntilSettled({ clock, worker: sys.worker, store: sys.store });
  say(formatDetail(sys.service.get('flaky')));

  say('\n=== 3b. Edit before delivery: the superseded schedule never fires ===');
  sys.service.create({ id: 'move-me', content: 'Original plan', timeZone: 'UTC', at: '2026-03-08T13:00:00Z' });
  sys.service.edit('move-me', { expectedVersion: 1, at: '2026-03-08T15:00:00Z', content: 'Updated plan' });
  await advanceUntilSettled({ clock, worker: sys.worker, store: sys.store });
  say(formatDetail(sys.service.get('move-me')));
  say(`  destination received keys: ${[...notifier.received.keys()].filter((k) => k.startsWith('move-me')).join(', ')}  (no move-me:v1)`);

  say('\n=== 3c. Cancellation: workers keep polling, nothing is delivered ===');
  sys.service.create({ id: 'nevermind', content: 'Cancel me', timeZone: 'UTC', at: '2026-03-08T16:00:00Z' });
  sys.service.cancel('nevermind');
  await advanceUntilSettled({ clock, worker: sys.worker, store: sys.store });
  say(`  nevermind: ${sys.service.get('nevermind').state}, sends to the destination: ${notifier.sendCount('nevermind:v1')}`);

  say('\n=== 4. Duplicate execution: two workers run the same occurrence ===');
  sys.service.create({ id: 'twice', content: 'Only once please', timeZone: 'UTC', at: '2026-03-08T17:00:00Z' });
  clock.set(at('2026-03-08T17:00:00Z'));
  const workerB = new Worker({ store: sys.store, notifier, clock, workerId: 'service-2-worker-b' });
  const gate = createGate();
  notifier.plan('twice:v1', { gate });
  say('worker A claims it and gets stuck while sending...');
  const tickA = sys.worker.tick();
  await gate.reached;
  clock.set(at('2026-03-08T17:00:31Z'));
  say(`${stamp()} A\'s 30 s lease has expired; worker B takes over and delivers:`);
  await workerB.tick();
  say('worker A finally gets through and sends the same delivery key again:');
  gate.open();
  await tickA;
  say(formatDetail(sys.service.get('twice')));
  say(`  destination was asked ${notifier.sendCount('twice:v1')} times, users saw ${notifier.logicalCount('twice:v1')} notification; delivery records: ${sys.store.listDeliveries().filter((d) => d.itemId === 'twice').length}`);

  say('\n=== 5. Verification benchmark ===');
  say('Run: npm run benchmark   (23 items, 3 zones, restart, duplicate execution, exactly-once accounting)');
  sys.store.close();
  say(`\nDatabase kept at ${DB_PATH}. Inspect it with: npm run cli -- show twice --db ${DB_PATH}`);
}
