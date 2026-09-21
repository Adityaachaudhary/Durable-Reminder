import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src';
import { at, makeSystem } from './helpers';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'no error';
};

describe('creating and inspecting scheduled work', () => {
  it('creates an item with a stable id, version 1, delivery key and both the local and UTC views', () => {
    const { service } = makeSystem();
    const { item, created } = service.create({ content: '  Call the bank  ', timeZone: 'Asia/Kolkata', at: '2026-03-08T09:00' });
    expect(created).toBe(true);
    expect(item).toMatchObject({
      id: 'item-1',
      kind: 'reminder',
      content: 'Call the bank',
      state: 'scheduled',
      version: 1,
      deliveryKey: 'item-1:v1',
      timeZone: 'Asia/Kolkata',
      requestedLocalTime: '2026-03-08T09:00:00',
      timeResolution: 'exact',
      scheduledAt: '2026-03-08T03:30:00.000Z',
      scheduledLocal: '2026-03-08T09:00:00+05:30',
    });
  });

  it('supports follow-ups tied to a conversation', () => {
    const { service } = makeSystem();
    const { item } = service.create({ kind: 'follow_up', conversationId: 'conv-42', content: 'Continue our chat', timeZone: 'Europe/London', at: '2026-03-06T10:00' });
    expect(item).toMatchObject({ kind: 'follow_up', conversationId: 'conv-42' });
  });

  it('inspect shows the item, its (empty) attempt history and its version history', () => {
    const { service } = makeSystem();
    service.create({ id: 'a', content: 'x', timeZone: 'Asia/Kolkata', at: '2026-03-08T09:00' });
    const detail = service.get('a');
    expect(detail.attempts).toEqual([]);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]).toMatchObject({ version: 1, supersededAt: null });
  });

  it('records the DST interpretation on the item', () => {
    const { service } = makeSystem();
    const { item } = service.create({ content: 'x', timeZone: 'America/New_York', at: '2026-03-08T02:30' });
    expect(item).toMatchObject({ timeResolution: 'gap_shifted_forward', scheduledAt: '2026-03-08T07:30:00.000Z', requestedLocalTime: '2026-03-08T02:30:00' });
  });

  it('create is idempotent by id: replaying the same request returns the same item, a different one conflicts', () => {
    const { service } = makeSystem();
    const request = { id: 'r-1', content: 'x', timeZone: 'Asia/Kolkata', at: '2026-03-08T09:00' };
    expect(service.create(request).created).toBe(true);
    const replay = service.create(request);
    expect(replay.created).toBe(false);
    expect(replay.item.version).toBe(1);
    expect(code(() => service.create({ ...request, content: 'different' }))).toBe('id_conflict');
    expect(service.list()).toHaveLength(1);
  });

  it('rejects invalid input with specific codes', () => {
    const { service } = makeSystem();
    const ok = { content: 'x', timeZone: 'Asia/Kolkata', at: '2026-03-08T09:00' };
    expect(code(() => service.create({ ...ok, content: '   ' }))).toBe('invalid_request');
    expect(code(() => service.create({ ...ok, content: 'x'.repeat(2001) }))).toBe('invalid_request');
    expect(code(() => service.create({ ...ok, timeZone: 'Nowhere/Land' }))).toBe('invalid_time_zone');
    expect(code(() => service.create({ ...ok, at: '2026-02-30T09:00' }))).toBe('invalid_time');
    expect(code(() => service.create({ ...ok, id: 'has space' }))).toBe('invalid_request');
    expect(code(() => service.create({ ...ok, id: 'a:b' }))).toBe('invalid_request');
    expect(code(() => service.create({ ...ok, kind: 'alarm' as never }))).toBe('invalid_request');
    expect(code(() => service.create({ ...ok, at: undefined as never }))).toBe('invalid_request');
  });

  it('refuses to schedule in the past but accepts "right now"', () => {
    const { service } = makeSystem({ start: at('2026-03-08T00:00:00Z') });
    expect(code(() => service.create({ content: 'x', timeZone: 'UTC', at: '2026-03-07T23:59:59Z' }))).toBe('time_in_past');
    expect(service.create({ content: 'x', timeZone: 'UTC', at: '2026-03-08T00:00:00Z' }).created).toBe(true);
  });

  it('reports unknown ids and filters lists by state', () => {
    const { service } = makeSystem();
    expect(code(() => service.get('nope'))).toBe('not_found');
    service.create({ id: 'a', content: 'x', timeZone: 'UTC', at: '2026-03-08T09:00' });
    service.create({ id: 'b', content: 'y', timeZone: 'UTC', at: '2026-03-08T10:00' });
    service.cancel('b');
    expect(service.list({ state: 'scheduled' }).map((i) => i.id)).toEqual(['a']);
    expect(service.list({ state: 'cancelled' }).map((i) => i.id)).toEqual(['b']);
    expect(code(() => service.list({ state: 'bogus' }))).toBe('invalid_request');
  });
});

describe('editing before delivery', () => {
  const setup = () => {
    const sys = makeSystem();
    sys.service.create({ id: 'r', content: 'original', timeZone: 'Asia/Kolkata', at: '2026-03-08T09:00' });
    return sys;
  };

  it('a time change creates version 2 with a new delivery key and keeps the history', () => {
    const { service } = setup();
    const { item, changed } = service.edit('r', { expectedVersion: 1, at: '2026-03-08T11:00' });
    expect(changed).toBe(true);
    expect(item).toMatchObject({ version: 2, deliveryKey: 'r:v2', scheduledAt: '2026-03-08T05:30:00.000Z', content: 'original' });
    const detail = service.get('r');
    expect(detail.revisions.map((r) => [r.version, r.scheduledAt, r.supersededAt !== null])).toEqual([
      [1, '2026-03-08T03:30:00.000Z', true],
      [2, '2026-03-08T05:30:00.000Z', false],
    ]);
  });

  it('a content-only change also creates a new version', () => {
    const { service } = setup();
    const { item } = service.edit('r', { expectedVersion: 1, content: 'updated' });
    expect(item).toMatchObject({ version: 2, content: 'updated', scheduledAt: '2026-03-08T03:30:00.000Z' });
  });

  it('changing only the zone keeps the wall-clock time and re-reads it in the new zone', () => {
    const { service } = setup();
    const { item } = service.edit('r', { expectedVersion: 1, timeZone: 'America/New_York' });
    expect(item).toMatchObject({ timeZone: 'America/New_York', requestedLocalTime: '2026-03-08T09:00:00', scheduledAt: '2026-03-08T13:00:00.000Z' });
  });

  it('an edit that changes nothing is a no-op and does not bump the version', () => {
    const { service } = setup();
    const { item, changed } = service.edit('r', { expectedVersion: 1, content: 'original', at: '2026-03-08T09:00' });
    expect(changed).toBe(false);
    expect(item.version).toBe(1);
  });

  it('a stale expectedVersion is rejected and reports the current version', () => {
    const { service } = setup();
    service.edit('r', { expectedVersion: 1, content: 'first writer' });
    try {
      service.edit('r', { expectedVersion: 1, content: 'second writer, stale' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'version_mismatch', details: { currentVersion: 2 }, status: 409 });
    }
    expect(service.get('r').content).toBe('first writer');
  });

  it('validates the patch', () => {
    const { service } = setup();
    expect(code(() => service.edit('r', {} as never))).toBe('invalid_request');
    expect(code(() => service.edit('r', { expectedVersion: 1 }))).toBe('invalid_request');
    expect(code(() => service.edit('r', { expectedVersion: 1, content: '' }))).toBe('invalid_request');
    expect(code(() => service.edit('r', { expectedVersion: 1, at: '2026-02-01T00:00' }))).toBe('time_in_past');
    expect(code(() => service.edit('nope', { expectedVersion: 1, content: 'x' }))).toBe('not_found');
  });

  it('cannot edit an item that is already cancelled or delivered', () => {
    const { service } = setup();
    service.cancel('r');
    expect(code(() => service.edit('r', { expectedVersion: 1, content: 'x' }))).toBe('already_terminal');
  });
});

describe('cancelling before delivery', () => {
  it('cancels, records why, and is idempotent', () => {
    const { service } = makeSystem();
    service.create({ id: 'r', content: 'x', timeZone: 'UTC', at: '2026-03-08T09:00' });
    const first = service.cancel('r');
    expect(first).toMatchObject({ changed: true, item: { state: 'cancelled', terminalReason: 'cancelled_by_user' } });
    expect(service.cancel('r')).toMatchObject({ changed: false, item: { state: 'cancelled' } });
  });

  it('unknown ids are reported', () => {
    expect(code(() => makeSystem().service.cancel('nope'))).toBe('not_found');
  });
});
