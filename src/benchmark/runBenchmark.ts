import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeNotifier,
  ManualClock,
  ReminderService,
  SqliteStore,
  TERMINAL_STATES,
  Worker,
  advanceUntilSettled,
  createGate,
  deliveryKeyOf,
  type FakeStep,
  type TerminalState,
} from '../index';

/**
 * Deterministic workflow-correctness benchmark (no real time, no network, no live provider).
 *
 * 23 items across 3 IANA zones: delivered (incl. a DST gap), edited, cancelled, temporarily failing,
 * permanently failing, retry-exhausted, lost-acknowledgement and duplicate-execution items.
 * The service is stopped and restarted (new store/worker on the same database file) while work is overdue,
 * a duplicate execution is forced, and an injected clock is advanced until everything settles.
 * Every check reads PERSISTED state plus what the destination actually received.
 */

const at = (iso: string) => Date.parse(iso);
const T0 = at('2026-03-07T00:00:00Z'); // the day before US daylight saving starts
const STOP_AT = at('2026-03-07T14:30:00Z'); // service stopped here, with work still to do
const RESTART_AT = at('2026-03-08T08:00:00Z'); // ...and restarted here

type Group = 'delivered' | 'edited' | 'cancelled' | 'temporary-then-success' | 'retries-exhausted' | 'permanent-failure' | 'lost-ack' | 'duplicate-execution';

interface Spec {
  id: string;
  group: Group;
  zone: string;
  at: string;
  plan?: FakeStep[];
}

const SPECS: Spec[] = [
  // plain delivered, several zones, one DST gap (a-5)
  { id: 'a-1', group: 'delivered', zone: 'Asia/Kolkata', at: '2026-03-07T09:00' },
  { id: 'a-2', group: 'delivered', zone: 'America/New_York', at: '2026-03-07T09:00' },
  { id: 'a-3', group: 'delivered', zone: 'Asia/Kolkata', at: '2026-03-07T18:30' },
  { id: 'a-4', group: 'delivered', zone: 'America/New_York', at: '2026-03-07T20:00' },
  { id: 'a-5', group: 'delivered', zone: 'America/New_York', at: '2026-03-08T02:30' }, // does not exist: becomes 03:30 EDT
  { id: 'a-6', group: 'delivered', zone: 'Asia/Kolkata', at: '2026-03-08T09:00' },
  { id: 'a-7', group: 'delivered', zone: 'America/New_York', at: '2026-03-08T09:00' },
  { id: 'a-8', group: 'delivered', zone: 'Europe/London', at: '2026-03-08T09:00' },
  // edited before delivery (their original schedules must never fire)
  { id: 'e-1', group: 'edited', zone: 'Asia/Kolkata', at: '2026-03-07T10:00' },
  { id: 'e-2', group: 'edited', zone: 'America/New_York', at: '2026-03-07T09:30' },
  { id: 'e-3', group: 'edited', zone: 'Asia/Kolkata', at: '2026-03-07T11:00' },
  // cancelled: before due, while a retry was pending, and while overdue after the restart
  { id: 'c-1', group: 'cancelled', zone: 'Asia/Kolkata', at: '2026-03-07T12:00' },
  { id: 'c-2', group: 'cancelled', zone: 'America/New_York', at: '2026-03-07T09:15', plan: ['temporary', 'temporary'] },
  { id: 'c-3', group: 'cancelled', zone: 'UTC', at: '2026-03-08T02:00' },
  // temporary failures that recover (the last one succeeds on the final allowed attempt)
  { id: 't-1', group: 'temporary-then-success', zone: 'UTC', at: '2026-03-07T05:00', plan: ['temporary'] },
  { id: 't-2', group: 'temporary-then-success', zone: 'UTC', at: '2026-03-07T06:00', plan: ['temporary', 'temporary'] },
  { id: 't-3', group: 'temporary-then-success', zone: 'UTC', at: '2026-03-07T07:00', plan: ['temporary', 'temporary', 'temporary'] },
  // always failing temporarily: bounded, ends visibly failed
  { id: 'x-1', group: 'retries-exhausted', zone: 'UTC', at: '2026-03-07T08:00', plan: Array(6).fill('temporary') },
  { id: 'x-2', group: 'retries-exhausted', zone: 'UTC', at: '2026-03-07T09:00', plan: Array(6).fill('temporary') },
  // permanent failures (one becomes due while the service is down)
  { id: 'p-1', group: 'permanent-failure', zone: 'UTC', at: '2026-03-07T10:00', plan: ['permanent'] },
  { id: 'p-2', group: 'permanent-failure', zone: 'UTC', at: '2026-03-08T05:00', plan: ['permanent'] },
  // destination accepts but the acknowledgement is lost
  { id: 'l-1', group: 'lost-ack', zone: 'UTC', at: '2026-03-07T11:00', plan: ['lost_ack'] },
  // two workers execute the same occurrence
  { id: 'd-1', group: 'duplicate-execution', zone: 'UTC', at: '2026-03-08T09:30' },
];

interface Expectation {
  state: TerminalState;
  version: number;
  attempts: string[];
  terminalReason?: string;
}
const delivered = (attempts: string[] = ['delivered'], version = 1): Expectation => ({ state: 'delivered', version, attempts });
const failed = (terminalReason: string, attempts: string[]): Expectation => ({ state: 'failed', version: 1, attempts, terminalReason });
const TF = 'temporary_failure';

const EXPECTED: Record<string, Expectation> = {
  'a-1': delivered(), 'a-2': delivered(), 'a-3': delivered(), 'a-4': delivered(), 'a-5': delivered(), 'a-6': delivered(), 'a-7': delivered(), 'a-8': delivered(),
  'e-1': delivered(['delivered'], 2),
  'e-2': delivered(['delivered'], 2),
  'e-3': delivered(['delivered'], 3),
  'c-1': { state: 'cancelled', version: 1, attempts: [], terminalReason: 'cancelled_by_user' },
  'c-2': { state: 'cancelled', version: 1, attempts: [TF], terminalReason: 'cancelled_by_user' },
  'c-3': { state: 'cancelled', version: 1, attempts: [], terminalReason: 'cancelled_by_user' },
  't-1': delivered([TF, 'delivered']),
  't-2': delivered([TF, TF, 'delivered']),
  't-3': delivered([TF, TF, TF, 'delivered']),
  'x-1': failed('retries_exhausted', [TF, TF, TF, TF]),
  'x-2': failed('retries_exhausted', [TF, TF, TF, TF]),
  'p-1': failed('permanent_failure', ['permanent_failure']),
  'p-2': failed('permanent_failure', ['permanent_failure']),
  'l-1': delivered([TF, 'duplicate_acknowledged']),
  'd-1': delivered(['duplicate_acknowledged', 'delivered']),
};

export interface BenchmarkReport {
  items: number;
  zones: string[];
  countsByState: Record<TerminalState, number>;
  deliveredItems: number;
  logicalNotifications: number;
  deliveryRecords: number;
  overdueAtRestart: number;
  duplicateExecution: { sendCalls: number; logicalNotifications: number; deliveryRecords: number };
  perGroup: Array<{ group: string; items: number; finalStates: string; violations: number }>;
  violations: string[];
  digests: [string, string];
  repeatable: boolean;
  passed: boolean;
}

interface PassResult {
  report: Omit<BenchmarkReport, 'digests' | 'repeatable' | 'passed'>;
  digest: string;
}

async function runPass(): Promise<PassResult> {
  const dir = mkdtempSync(join(tmpdir(), 'reminders-bench-'));
  const path = join(dir, 'bench.db');
  const errors: unknown[] = [];
  const stores: SqliteStore[] = [];
  const violations: string[] = [];
  const violate = (id: string, message: string) => violations.push(`${id}: ${message}`);
  try {
    const clock = new ManualClock(T0);
    const notifier = new FakeNotifier({ clock }); // the destination outlives service restarts, like a real one

    const boot = (workerId: string) => {
      const store = new SqliteStore(path);
      stores.push(store);
      const service = new ReminderService({ store, clock });
      const worker = new Worker({ store, notifier, clock, workerId, onError: (e) => errors.push(e) });
      return { store, service, worker };
    };
    const runTo = async (sys: ReturnType<typeof boot>, target: number) => {
      await advanceUntilSettled({ clock, worker: sys.worker, store: sys.store }, { until: target });
      if (clock.now() < target) clock.set(target);
    };

    // ---------------------------------------------------------------- phase 1: service running
    let sys = boot('service-1');
    for (const spec of SPECS) {
      sys.service.create({ id: spec.id, content: `Reminder ${spec.id}`, timeZone: spec.zone, at: spec.at });
      if (spec.plan) notifier.plan(deliveryKeyOf(spec.id, 1), ...spec.plan);
    }
    sys.service.edit('e-1', { expectedVersion: 1, at: '2026-03-08T16:00' }); // moved to the next day
    sys.service.edit('e-2', { expectedVersion: 1, content: 'e-2 rewritten' }); // content only
    sys.service.edit('e-3', { expectedVersion: 1, timeZone: 'America/New_York', at: '2026-03-08T04:00' }); // new zone and time...
    sys.service.edit('e-3', { expectedVersion: 2, content: 'e-3 rewritten twice' }); // ...then new content
    sys.service.cancel('c-1');

    await runTo(sys, at('2026-03-07T14:15:10Z')); // c-2 failed once at 14:15:00 and is waiting to retry
    sys.service.cancel('c-2');
    await runTo(sys, STOP_AT);

    // ---------------------------------------------------------------- phase 2: service stopped, work becomes overdue
    sys.worker.stop();
    sys.store.close();
    clock.set(RESTART_AT);

    // ---------------------------------------------------------------- phase 3: restart
    sys = boot('service-2');
    const overdueAtRestart = sys.store.listItems({ state: 'scheduled' }).filter((i) => (i.nextAttemptAt ?? i.scheduledAt) <= clock.now()).length;
    if (overdueAtRestart === 0) violate('restart', 'nothing was overdue at restart, so recovery was not exercised');
    sys.service.cancel('c-3'); // cancelled while overdue, before the restarted worker's first pass
    await runTo(sys, at('2026-03-08T09:29:59Z'));

    // duplicate execution: worker A is stuck in send(), its lease expires, worker B takes over, then A wakes up
    clock.set(at('2026-03-08T09:30:00Z'));
    const workerB = new Worker({ store: sys.store, notifier, clock, workerId: 'service-2-worker-b', onError: (e) => errors.push(e) });
    const gate = createGate();
    notifier.plan('d-1:v1', { gate });
    const tickA = sys.worker.tick();
    await gate.reached;
    clock.set(at('2026-03-08T09:30:31Z'));
    await workerB.tick();
    gate.open();
    await tickA;

    const { settled } = await advanceUntilSettled({ clock, worker: sys.worker, store: sys.store });
    if (!settled) violate('run', 'processing did not settle');

    // ---------------------------------------------------------------- verification against persisted state
    const items = sys.store.listItems();
    const deliveries = sys.store.listDeliveries();
    const deliveredIds = new Set<string>();
    const signature: unknown[] = [];

    for (const spec of SPECS) {
      const item = sys.store.getItem(spec.id);
      const expected = EXPECTED[spec.id];
      if (!item || !expected) {
        violate(spec.id, 'missing item or expectation');
        continue;
      }
      const attempts = sys.store.getAttempts(spec.id);
      const revisions = sys.store.getRevisions(spec.id);
      const finalKey = deliveryKeyOf(spec.id, item.version);

      if (item.state !== expected.state) violate(spec.id, `state ${item.state}, expected ${expected.state}`);
      if (item.version !== expected.version) violate(spec.id, `version ${item.version}, expected ${expected.version}`);
      if (expected.terminalReason && item.terminalReason !== expected.terminalReason) violate(spec.id, `reason ${String(item.terminalReason)}, expected ${expected.terminalReason}`);
      if (JSON.stringify(attempts.map((a) => a.outcome)) !== JSON.stringify(expected.attempts)) {
        violate(spec.id, `attempt outcomes [${attempts.map((a) => a.outcome).join(', ')}], expected [${expected.attempts.join(', ')}]`);
      }
      if (revisions.length !== item.version) violate(spec.id, `expected ${item.version} revisions, found ${revisions.length}`);

      // attempt history is complete, ordered and resolved
      attempts.forEach((a, i) => {
        if (a.seq !== i + 1) violate(spec.id, 'attempt sequence has gaps');
        if (a.finishedAt === null || a.outcome === 'in_flight') violate(spec.id, `attempt ${a.seq} was never resolved`);
        if (i > 0 && a.claimedAt < attempts[i - 1]!.claimedAt) violate(spec.id, 'attempts are out of time order');
      });

      // superseded versions never produced a notification
      for (let v = 1; v < item.version; v++) {
        if (notifier.received.has(deliveryKeyOf(spec.id, v))) violate(spec.id, `superseded version ${v} produced a notification`);
        if (sys.store.getDelivery(deliveryKeyOf(spec.id, v))) violate(spec.id, `superseded version ${v} has a delivery record`);
      }

      const logical = notifier.logicalCount(finalKey);
      const record = sys.store.getDelivery(finalKey);
      if (item.state === 'delivered') {
        deliveredIds.add(spec.id);
        if (logical !== 1) violate(spec.id, `destination saw ${logical} notifications for ${finalKey}, expected exactly 1`);
        if (!record) violate(spec.id, 'delivered without a delivery record');
        else if (record.deliveredAt < item.scheduledAt) violate(spec.id, 'delivered before its scheduled instant');
        const content = notifier.received.get(finalKey)?.notification.content;
        if (content !== (spec.id === 'e-2' ? 'e-2 rewritten' : spec.id === 'e-3' ? 'e-3 rewritten twice' : `Reminder ${spec.id}`)) {
          violate(spec.id, `destination received unexpected content "${String(content)}"`);
        }
      } else {
        if (logical !== 0) violate(spec.id, `${item.state} item still produced ${logical} notification(s)`);
        if (record) violate(spec.id, `${item.state} item has a delivery record`);
      }

      signature.push([spec.id, item.state, item.version, item.terminalReason, attempts.map((a) => [a.version, a.occurrenceAttempt, a.workerId, a.outcome, a.claimedAt]), record ? [record.deliveryKey, record.deliveredAt] : null]);
    }

    // global exactly-once accounting
    if (items.some((i) => i.state === 'scheduled' || i.state === 'running')) violate('run', 'some items did not reach a terminal state');
    if (notifier.received.size !== deliveredIds.size) violate('run', `destination saw ${notifier.received.size} logical notifications for ${deliveredIds.size} delivered items`);
    if (deliveries.length !== deliveredIds.size) violate('run', `${deliveries.length} delivery records for ${deliveredIds.size} delivered items`);
    if (errors.length > 0) violate('run', `${errors.length} internal error(s) reported`);

    // scenario-specific proofs
    const dupSendCalls = notifier.sendCount('d-1:v1');
    if (dupSendCalls < 2) violate('d-1', 'duplicate execution did not actually reach the destination twice');
    if (notifier.sendCount('l-1:v1') !== 2) violate('l-1', 'lost acknowledgement should cause exactly one retry');
    const restartAttempt = sys.store.getAttempts('a-4')[0];
    if (!restartAttempt || restartAttempt.claimedAt < RESTART_AT || restartAttempt.claimedAt - restartAttempt.dueAt <= 0) violate('a-4', 'overdue item was not delivered late after the restart');

    const zones = [...new Set(SPECS.map((s) => s.zone))].sort();
    const countsByState = Object.fromEntries(TERMINAL_STATES.map((s) => [s, items.filter((i) => i.state === s).length])) as Record<TerminalState, number>;
    const perGroup = [...new Set(SPECS.map((s) => s.group))].map((group) => {
      const ids = SPECS.filter((s) => s.group === group).map((s) => s.id);
      const states = [...new Set(ids.map((id) => sys.store.getItem(id)?.state ?? '?'))].join('/');
      return { group, items: ids.length, finalStates: states, violations: violations.filter((v) => ids.includes(v.split(':')[0]!)).length };
    });

    const report = {
      items: items.length,
      zones,
      countsByState,
      deliveredItems: deliveredIds.size,
      logicalNotifications: notifier.received.size,
      deliveryRecords: deliveries.length,
      overdueAtRestart,
      duplicateExecution: { sendCalls: dupSendCalls, logicalNotifications: notifier.logicalCount('d-1:v1'), deliveryRecords: deliveries.filter((d) => d.itemId === 'd-1').length },
      perGroup,
      violations,
    };
    return { report, digest: createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 16) };
  } finally {
    for (const store of stores) {
      try {
        store.close(); // Windows cannot delete a database file that is still open
      } catch {
        /* already closed */
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

export async function runBenchmark(): Promise<BenchmarkReport> {
  const first = await runPass();
  const second = await runPass(); // the whole scenario again: results must be identical
  const repeatable = first.digest === second.digest;
  const violations = [...first.report.violations, ...second.report.violations];
  return { ...first.report, violations, digests: [first.digest, second.digest], repeatable, passed: violations.length === 0 && repeatable };
}
