import { describe, expect, it } from 'vitest';
import { canonicalTimeZone, formatInZone, resolveTime, TimeError, toIso } from '../src';

const iso = (ms: number) => toIso(ms);

describe('AC7: time zones become deterministic instants', () => {
  it('Asia/Kolkata has no DST: 09:00 local is 03:30 UTC', () => {
    const r = resolveTime('2026-03-08T09:00', 'Asia/Kolkata');
    expect(iso(r.scheduledAt)).toBe('2026-03-08T03:30:00.000Z');
    expect(r).toMatchObject({ timeZone: 'Asia/Kolkata', resolution: 'exact', requestedLocalTime: '2026-03-08T09:00:00' });
  });

  it('nonexistent local time (spring forward) moves FORWARD by the gap: NY 02:30 -> 03:30 EDT = 07:30Z', () => {
    const r = resolveTime('2026-03-08T02:30', 'America/New_York');
    expect(iso(r.scheduledAt)).toBe('2026-03-08T07:30:00.000Z');
    expect(r.resolution).toBe('gap_shifted_forward');
    expect(r.requestedLocalTime).toBe('2026-03-08T02:30:00'); // what the user asked for is kept
    expect(formatInZone(r.scheduledAt, 'America/New_York')).toBe('2026-03-08T03:30:00-04:00');
  });

  it('ambiguous local time (fall back) uses the FIRST occurrence: NY 01:30 -> 01:30 EDT = 05:30Z, not 06:30Z', () => {
    const r = resolveTime('2026-11-01T01:30', 'America/New_York');
    expect(iso(r.scheduledAt)).toBe('2026-11-01T05:30:00.000Z');
    expect(r.resolution).toBe('ambiguous_first');
  });

  it('a second zone with its own boundary: London 01:30 on 29 Mar does not exist -> 02:30 BST = 01:30Z', () => {
    const r = resolveTime('2026-03-29T01:30', 'Europe/London');
    expect(iso(r.scheduledAt)).toBe('2026-03-29T01:30:00.000Z');
    expect(r.resolution).toBe('gap_shifted_forward');
  });

  it('the same wall-clock time on either side of a DST change is 23 hours apart in UTC', () => {
    const before = resolveTime('2026-03-07T09:00', 'America/New_York'); // EST, UTC-5
    const after = resolveTime('2026-03-08T09:00', 'America/New_York'); // EDT, UTC-4
    expect(iso(before.scheduledAt)).toBe('2026-03-07T14:00:00.000Z');
    expect(iso(after.scheduledAt)).toBe('2026-03-08T13:00:00.000Z');
    expect((after.scheduledAt - before.scheduledAt) / 3_600_000).toBe(23);
  });

  it('different zones, same wall-clock time, different instants', () => {
    const kolkata = resolveTime('2026-06-01T09:00', 'Asia/Kolkata');
    const newYork = resolveTime('2026-06-01T09:00', 'America/New_York');
    expect(iso(kolkata.scheduledAt)).toBe('2026-06-01T03:30:00.000Z');
    expect(iso(newYork.scheduledAt)).toBe('2026-06-01T13:00:00.000Z');
  });

  it('an absolute instant needs no interpretation, and the zone is kept for display', () => {
    const r = resolveTime('2026-03-08T09:00:00+05:30', 'America/New_York');
    expect(iso(r.scheduledAt)).toBe('2026-03-08T03:30:00.000Z');
    expect(r).toMatchObject({ resolution: 'instant', timeZone: 'America/New_York', requestedLocalTime: '2026-03-07T22:30:00' });
  });

  it('accepts seconds and is deterministic across calls', () => {
    expect(resolveTime('2026-03-08T09:00:30', 'Asia/Kolkata')).toEqual(resolveTime('2026-03-08T09:00:30', 'Asia/Kolkata'));
  });
});

describe('time input validation', () => {
  it('canonicalises identifiers', () => {
    expect(canonicalTimeZone('asia/kolkata')).toBe('Asia/Kolkata');
  });

  it.each(['Not/AZone', '+05:30', '', '   ', 'IST-ish'])('rejects %j as a time zone', (zone) => {
    expect(() => resolveTime('2026-03-08T09:00', zone)).toThrow(expect.objectContaining({ code: 'invalid_time_zone' }));
  });

  it.each(['2026-02-30T10:00', 'tomorrow 9am', '2026-03-08 09:00', '2026-03-08T25:00', '2026-03-08T09:00+', '2026-13-01T09:00', ''])(
    'rejects %j as a time',
    (value) => {
      expect(() => resolveTime(value, 'Asia/Kolkata')).toThrow(TimeError);
      expect(() => resolveTime(value, 'Asia/Kolkata')).toThrow(expect.objectContaining({ code: 'invalid_time' }));
    },
  );
});
