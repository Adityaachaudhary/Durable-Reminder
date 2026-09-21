import { startServer } from './server';

const at = (iso: string) => Date.parse(iso);

/**
 * REST walkthrough: starts the real HTTP server on a free port with a manual clock and calls it with fetch,
 * printing every request and response. Time moves only through POST /admin/clock.
 */
const server = await startServer({ port: 0, dbPath: ':memory:', manualClock: true, startAt: at('2026-03-07T00:00:00Z'), log: () => undefined });
const base = `http://localhost:${server.port}`;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as any;
  console.log(`\n> ${method} ${path}${body === undefined ? '' : '  ' + JSON.stringify(body)}`);
  console.log(`< ${res.status}  ${JSON.stringify(summary(json))}`);
  return json;
}

/** Keeps the printed responses short enough to read on screen. */
const summary = (json: any): unknown => {
  if (json?.error) return json;
  if (json?.items) return { items: json.items.map((i: any) => `${i.id}: ${i.state} v${i.version}`) };
  if (json?.processed) return json;
  if (json?.id) {
    const { id, state, version, deliveryKey, scheduledAt, timeResolution, changed, terminalReason } = json;
    const compact: Record<string, unknown> = { id, state, version, deliveryKey, scheduledAt, timeResolution };
    if (changed !== undefined) compact.changed = changed;
    if (terminalReason) compact.terminalReason = terminalReason;
    if (json.attempts) compact.attempts = json.attempts.map((a: any) => `${a.workerId} try ${a.occurrenceAttempt}: ${a.outcome}`);
    return compact;
  }
  return json;
};

try {
  console.log(`REST API on ${base} (manual clock starts at 2026-03-07T00:00:00Z)`);
  await call('POST', '/reminders', { id: 'call-bank', content: 'Call the bank', timeZone: 'Asia/Kolkata', at: '2026-03-07T09:00' });
  await call('POST', '/reminders', { id: 'call-bank', content: 'Call the bank', timeZone: 'Asia/Kolkata', at: '2026-03-07T09:00' }); // replay: 200, not a duplicate
  await call('POST', '/reminders', { id: 'call-bank', content: 'A different reminder', timeZone: 'Asia/Kolkata', at: '2026-03-07T09:00' }); // conflict
  await call('POST', '/reminders', { content: 'Bad zone', timeZone: 'Mars/Base', at: '2026-03-07T09:00' });
  await call('POST', '/admin/tick'); // nothing due yet
  await call('POST', '/admin/clock', { now: '2026-03-07T03:30:00Z' }); // 09:00 in Kolkata
  await call('POST', '/admin/tick'); // delivered
  await call('GET', '/reminders/call-bank');

  await call('POST', '/reminders', { id: 'movable', content: 'Team sync', timeZone: 'America/New_York', at: '2026-03-08T09:00' });
  await call('PATCH', '/reminders/movable', { expectedVersion: 1, at: '2026-03-08T10:00' });
  await call('PATCH', '/reminders/movable', { expectedVersion: 1, content: 'stale edit' }); // 409, someone changed it
  await call('POST', '/reminders/movable/cancel');
  await call('POST', '/reminders/movable/cancel'); // idempotent
  await call('GET', '/reminders?state=cancelled');
} finally {
  await server.close();
}
