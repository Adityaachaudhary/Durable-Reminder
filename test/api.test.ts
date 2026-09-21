import { describe, expect, it } from 'vitest';
import { createApp, systemClock } from '../src';
import { at, makeSystem } from './helpers';

const setup = () => {
  const sys = makeSystem();
  const app = createApp({ service: sys.service, clock: sys.clock, worker: sys.worker });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ...sys, app, call };
};

const NEW = { id: 'api-1', content: 'Call mom', timeZone: 'Asia/Kolkata', at: '2026-03-01T15:30' };

describe('REST API: create and inspect', () => {
  it('POST /reminders creates (201) and GET returns the item with history', async () => {
    const { call } = setup();
    const created = await call('POST', '/reminders', NEW);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'api-1', state: 'scheduled', version: 1, deliveryKey: 'api-1:v1', scheduledAt: '2026-03-01T10:00:00.000Z' });

    const got = await call('GET', '/reminders/api-1');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: 'api-1', attempts: [], revisions: [{ version: 1 }] });
    expect(got.body.token).toBeUndefined();
    expect(got.body.claimToken).toBeUndefined(); // internal fields are not exposed
  });

  it('replaying the same create is 200 (idempotent); the same id with different content is 409', async () => {
    const { call } = setup();
    await call('POST', '/reminders', NEW);
    expect((await call('POST', '/reminders', NEW)).status).toBe(200);
    const conflict = await call('POST', '/reminders', { ...NEW, content: 'other' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('id_conflict');
  });

  it('validation errors are 400 / 422 with a machine-readable code', async () => {
    const { call } = setup();
    expect((await call('POST', '/reminders', '{ not json')).body.error.code).toBe('invalid_request');
    expect((await call('POST', '/reminders', '[1,2]')).status).toBe(400);
    expect((await call('POST', '/reminders', { ...NEW, content: '' })).status).toBe(400);
    const zone = await call('POST', '/reminders', { ...NEW, timeZone: 'Mars/Base' });
    expect([zone.status, zone.body.error.code]).toEqual([400, 'invalid_time_zone']);
    const time = await call('POST', '/reminders', { ...NEW, at: '2026-02-30T10:00' });
    expect([time.status, time.body.error.code]).toEqual([400, 'invalid_time']);
    const past = await call('POST', '/reminders', { ...NEW, at: '2026-02-01T10:00' });
    expect([past.status, past.body.error.code]).toEqual([422, 'time_in_past']);
  });

  it('GET unknown id is 404, unknown route is 404 JSON, list filters by state', async () => {
    const { call } = setup();
    expect((await call('GET', '/reminders/nope')).status).toBe(404);
    expect((await call('GET', '/nowhere')).body.error.code).toBe('not_found');
    await call('POST', '/reminders', NEW);
    await call('POST', '/reminders', { ...NEW, id: 'api-2', at: '2026-03-01T16:30' });
    await call('POST', '/reminders/api-2/cancel');
    expect((await call('GET', '/reminders')).body.items).toHaveLength(2);
    expect((await call('GET', '/reminders?state=cancelled')).body.items.map((i: any) => i.id)).toEqual(['api-2']);
    expect((await call('GET', '/reminders?state=bogus')).status).toBe(400);
  });
});

describe('REST API: edit and cancel', () => {
  it('PATCH edits with expectedVersion; a stale version is 409 and reports the current one', async () => {
    const { call } = setup();
    await call('POST', '/reminders', NEW);
    const ok = await call('PATCH', '/reminders/api-1', { expectedVersion: 1, at: '2026-03-01T18:00' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ version: 2, changed: true, deliveryKey: 'api-1:v2', scheduledAt: '2026-03-01T12:30:00.000Z' });

    const stale = await call('PATCH', '/reminders/api-1', { expectedVersion: 1, content: 'late writer' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'version_mismatch', currentVersion: 2 });

    expect((await call('PATCH', '/reminders/api-1', { content: 'no version' })).status).toBe(400);
    expect((await call('PATCH', '/reminders/nope', { expectedVersion: 1, content: 'x' })).status).toBe(404);
  });

  it('POST /cancel is idempotent, and a finished item cannot be cancelled or edited', async () => {
    const { call, clock, worker } = setup();
    await call('POST', '/reminders', NEW);
    expect((await call('POST', '/reminders/api-1/cancel')).body).toMatchObject({ state: 'cancelled', changed: true });
    expect((await call('POST', '/reminders/api-1/cancel')).body).toMatchObject({ state: 'cancelled', changed: false });
    expect((await call('PATCH', '/reminders/api-1', { expectedVersion: 1, content: 'x' })).body.error.code).toBe('already_terminal');

    await call('POST', '/reminders', { ...NEW, id: 'api-2' });
    clock.set(at('2026-03-01T10:00:00Z'));
    await worker.runUntilIdle();
    const late = await call('POST', '/reminders/api-2/cancel');
    expect([late.status, late.body.error.code]).toEqual([409, 'already_terminal']);
  });
});

describe('REST API: controlled time (admin endpoints)', () => {
  it('create -> tick too early does nothing -> advance the clock -> tick delivers, and the history is inspectable', async () => {
    const { call, notifier } = setup();
    await call('POST', '/reminders', NEW); // due 2026-03-01T10:00:00Z, clock starts 2026-03-01T00:00:00Z

    expect((await call('POST', '/admin/tick')).body.processed).toEqual([]);
    const advanced = await call('POST', '/admin/clock', { now: '2026-03-01T10:00:00Z' });
    expect(advanced.body.now).toBe('2026-03-01T10:00:00.000Z');
    const tick = await call('POST', '/admin/tick');
    expect(tick.body.processed).toEqual([{ itemId: 'api-1', version: 1, outcome: 'delivered' }]);

    const item = await call('GET', '/reminders/api-1');
    expect(item.body.state).toBe('delivered');
    expect(item.body.attempts[0]).toMatchObject({ outcome: 'delivered', latenessMs: 0 });
    expect(notifier.logicalCount('api-1:v1')).toBe(1);
  });

  it('the clock cannot go backwards and bad bodies are rejected', async () => {
    const { call } = setup();
    expect((await call('POST', '/admin/clock', { now: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await call('POST', '/admin/clock', { advanceMs: -5 })).status).toBe(400);
    expect((await call('POST', '/admin/clock', { advanceMs: 60_000 })).status).toBe(200);
    expect((await call('GET', '/admin/clock')).body.now).toBe('2026-03-01T00:01:00.000Z');
  });

  it('admin endpoints do not exist when the clock is the real one', async () => {
    const sys = makeSystem();
    const app = createApp({ service: sys.service, clock: systemClock });
    expect((await app.request('/admin/clock')).status).toBe(404);
    expect((await app.request('/health')).status).toBe(200);
  });
});
