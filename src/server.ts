import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './api';
import { ManualClock, systemClock, type Clock } from './clock';
import { FakeNotifier } from './fakeNotifier';
import { ReminderService } from './service';
import { SqliteStore } from './store/sqliteStore';
import { Worker } from './worker';

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  /**
   * Start with a controllable clock and the /admin endpoints (for demos and reviewers). Time then moves only through
   * POST /admin/clock, and work is processed only through POST /admin/tick (no background polling).
   */
  manualClock?: boolean;
  /** Initial time for the manual clock (epoch ms). Defaults to now. */
  startAt?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

/**
 * Wires everything for a local run: SQLite file, a fake local notification destination that prints deliveries,
 * one worker polling the store, and the REST API. Nothing is kept in memory that the database cannot rebuild.
 */
export async function startServer(options: ServerOptions = {}) {
  const dbPath = options.dbPath ?? 'data/reminders.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const log = options.log ?? ((line: string) => console.log(line));

  const clock: Clock = options.manualClock ? new ManualClock(options.startAt ?? Date.now()) : systemClock;
  const store = new SqliteStore(dbPath);
  const notifier = new FakeNotifier({ clock, log });
  const service = new ReminderService({ store, clock });
  const worker = new Worker({ store, notifier, clock, workerId: 'server-worker', onError: (e) => log(`[worker] ${String(e)}`) });
  if (!options.manualClock) worker.start(options.pollMs ?? 500);

  const app = createApp({ service, clock, worker });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const started = serve({ fetch: app.fetch, port: options.port ?? 3000 }, (info) => resolve({ server: started, port: info.port }));
  });

  return {
    port,
    app,
    store,
    notifier,
    worker,
    clock,
    close: () =>
      new Promise<void>((resolve) => {
        worker.stop();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}
