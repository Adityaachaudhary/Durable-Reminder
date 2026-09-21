import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ManualClock, systemClock, type Clock } from './clock';
import { runDemo } from './demo';
import { FakeNotifier, type FakeStep } from './fakeNotifier';
import { formatDetail, formatRow } from './render';
import { ReminderService, ServiceError } from './service';
import { startServer } from './server';
import { SqliteStore } from './store/sqliteStore';
import { Worker } from './worker';

const USAGE = `Usage (add "--db path" to use another database, default data/reminders.db):
  npm run cli -- create --content "Call mom" --tz Asia/Kolkata --at 2026-03-08T09:00 [--id x] [--kind follow_up] [--conversation c1]
  npm run cli -- list [--state scheduled|running|delivered|cancelled|failed]
  npm run cli -- show <id>
  npm run cli -- edit <id> --expected-version 1 [--content "..."] [--at ...] [--tz ...]
  npm run cli -- cancel <id>
  npm run cli -- tick [--fault temporary|permanent|lost_ack]     process whatever is due now
  npm run serve                                                  REST API (see README)
  npm run demo                                                   scripted walkthrough

Controlled time: add --now 2026-03-08T03:30:00Z to any command to run it "at" that instant instead of the real time.
--at is a local wall-clock time ("2026-03-08T09:00") interpreted in --tz, or an instant with Z/offset.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    content: { type: 'string' },
    tz: { type: 'string' },
    at: { type: 'string' },
    id: { type: 'string' },
    kind: { type: 'string' },
    conversation: { type: 'string' },
    state: { type: 'string' },
    'expected-version': { type: 'string' },
    now: { type: 'string' },
    db: { type: 'string', default: 'data/reminders.db' },
    fault: { type: 'string' },
    port: { type: 'string', default: '3000' },
    'manual-clock': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command, argument] = positionals;

if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

function makeClock(): Clock {
  if (!values.now) return systemClock;
  const ms = Date.parse(values.now);
  if (Number.isNaN(ms)) {
    console.error(`--now must be an ISO instant such as 2026-03-08T03:30:00Z (got "${values.now}")`);
    process.exit(1);
  }
  return new ManualClock(ms);
}

function openStore(): SqliteStore {
  if (values.db !== ':memory:') mkdirSync(dirname(values.db!), { recursive: true });
  return new SqliteStore(values.db);
}

async function main(): Promise<void> {
  if (command === 'demo') return runDemo();

  if (command === 'serve') {
    const server = await startServer({ port: Number(values.port), dbPath: values.db, manualClock: values['manual-clock'] });
    console.log(`REST API listening on http://localhost:${server.port}  (database: ${values.db}${values['manual-clock'] ? ', manual clock + /admin endpoints' : ''})`);
    console.log('Deliveries are printed here by the local fake destination. Press Ctrl+C to stop.');
    return new Promise<void>(() => undefined);
  }

  const clock = makeClock();
  const store = openStore();
  const service = new ReminderService({ store, clock });
  try {
    switch (command) {
      case 'create': {
        const { item, created } = service.create({
          id: values.id,
          kind: values.kind as 'reminder' | 'follow_up' | undefined,
          content: values.content as string,
          timeZone: values.tz as string,
          at: values.at as string,
          conversationId: values.conversation,
        });
        console.log(created ? 'created' : 'already exists (same request)');
        console.log(formatDetail(service.get(item.id)));
        break;
      }
      case 'list':
        for (const item of service.list({ state: values.state })) console.log(formatRow(item));
        break;
      case 'show':
        if (!argument) throw new ServiceError('invalid_request', 'show needs an id');
        console.log(formatDetail(service.get(argument)));
        break;
      case 'edit': {
        if (!argument) throw new ServiceError('invalid_request', 'edit needs an id');
        const { item, changed } = service.edit(argument, {
          expectedVersion: Number(values['expected-version']),
          content: values.content,
          at: values.at,
          timeZone: values.tz,
        });
        console.log(changed ? `edited: now version ${item.version}` : 'nothing changed');
        console.log(formatDetail(service.get(item.id)));
        break;
      }
      case 'cancel': {
        if (!argument) throw new ServiceError('invalid_request', 'cancel needs an id');
        const { item, changed } = service.cancel(argument);
        console.log(changed ? 'cancelled' : 'was already cancelled');
        console.log(formatRow(item));
        break;
      }
      case 'tick': {
        const defaultSteps: FakeStep[] = values.fault ? [values.fault as FakeStep] : [];
        const notifier = new FakeNotifier({ clock, defaultSteps, log: (line) => console.log(line) });
        const worker = new Worker({ store, notifier, clock, workerId: 'cli-worker' });
        const results = await worker.runUntilIdle();
        console.log(`processed ${results.length} attempt(s) at ${new Date(clock.now()).toISOString()}`);
        for (const r of results) console.log(`  ${r.itemId} v${r.version} -> ${r.outcome}`);
        const wake = store.nextWakeTime();
        console.log(wake === undefined ? 'nothing left scheduled' : `next work due at ${new Date(wake).toISOString()}`);
        break;
      }
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ServiceError) {
    console.error(`error (${error.code}): ${error.message}${Object.keys(error.details).length ? ' ' + JSON.stringify(error.details) : ''}`);
    process.exit(1);
  }
  throw error;
}
