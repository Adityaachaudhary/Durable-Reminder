import { rmSync } from 'node:fs';
import {
  FakeNotifier,
  ManualClock,
  ReminderService,
  SqliteStore,
  Worker,
  type RetryPolicy,
} from '../src';

export const at = (iso: string): number => Date.parse(iso);

/** Every database connection a test opens is tracked and closed afterwards (Windows cannot delete open files). */
const opened: Array<{ close(): void }> = [];
export function track<T extends { close(): void }>(connection: T): T {
  opened.push(connection);
  return connection;
}
export function closeAll(): void {
  for (const connection of opened.splice(0)) {
    try {
      connection.close();
    } catch {
      /* already closed */
    }
  }
}
export const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

export interface SystemOptions {
  start?: number;
  retry?: RetryPolicy;
  leaseMs?: number;
  batchSize?: number;
  store?: SqliteStore;
  notifier?: FakeNotifier;
  clock?: ManualClock;
  workerId?: string;
}

/** A full system wired with a manual clock, in-memory SQLite and a fake destination. */
export function makeSystem(options: SystemOptions = {}) {
  const clock = options.clock ?? new ManualClock(options.start ?? at('2026-03-01T00:00:00Z'));
  const store = options.store ?? track(new SqliteStore(':memory:'));
  const notifier = options.notifier ?? new FakeNotifier({ clock });
  let counter = 0;
  const service = new ReminderService({ store, clock, ids: () => `item-${++counter}` });
  const errors: unknown[] = [];
  const makeWorker = (workerId: string) =>
    new Worker({
      store,
      notifier,
      clock,
      workerId,
      retry: options.retry,
      leaseMs: options.leaseMs,
      batchSize: options.batchSize,
      onError: (error) => errors.push(error),
    });
  const worker = makeWorker(options.workerId ?? 'w1');
  return { clock, store, notifier, service, worker, makeWorker, errors };
}

export const outcomes = (store: SqliteStore, id: string) => store.getAttempts(id).map((a) => a.outcome);

export const claimNow = (store: SqliteStore, now: number, workerId = 'manual', leaseMs = 30_000, maxAttempts = 4) =>
  store.claimDue({ now, workerId, leaseMs, limit: 50, maxAttempts, newToken: () => `${workerId}-${now}-${Math.random()}` });
