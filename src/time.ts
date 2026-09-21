import { Temporal } from '@js-temporal/polyfill';
import type { TimeResolution } from './types';

/**
 * Turns "what the user typed" into an instant, with an explicit policy for the two awkward cases.
 *
 *  - Nonexistent local time (spring forward, e.g. 02:30 on 2026-03-08 in New York):
 *      moved FORWARD by the length of the gap -> 03:30 EDT. This is what calendar apps do
 *      (Temporal calls it disambiguation "compatible").
 *  - Ambiguous local time (fall back, e.g. 01:30 on 2026-11-01 in New York, which happens twice):
 *      the FIRST occurrence is used (01:30 EDT), so the reminder is never later than the user expects.
 *
 * The zone is kept with the item. The requested wall-clock time is kept too, so the interpretation
 * stays explainable after the fact.
 */
export class TimeError extends Error {
  constructor(
    readonly code: 'invalid_time' | 'invalid_time_zone',
    message: string,
  ) {
    super(message);
    this.name = 'TimeError';
  }
}

export interface ResolvedTime {
  scheduledAt: number;
  /** Wall-clock time as requested (normalised to seconds), e.g. 2026-03-08T02:30:00. */
  requestedLocalTime: string;
  timeZone: string;
  resolution: TimeResolution;
}

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Returns the canonical IANA identifier or throws. Fixed-offset "zones" such as +05:30 are not IANA identifiers. */
export function canonicalTimeZone(input: string): string {
  if (typeof input !== 'string' || input.trim() === '' || /^[+-]/.test(input.trim())) {
    throw new TimeError('invalid_time_zone', `"${String(input)}" is not an IANA time-zone identifier (e.g. Asia/Kolkata)`);
  }
  try {
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(input.trim()).timeZoneId;
  } catch {
    throw new TimeError('invalid_time_zone', `"${input}" is not a recognised IANA time-zone identifier`);
  }
}

const toSeconds = (pdt: Temporal.PlainDateTime): string => pdt.toString({ smallestUnit: 'second' });

/**
 * `at` is either a local wall-clock time without offset ("2026-03-08T02:30" or with seconds), interpreted in
 * `timeZone`, or an absolute instant with Z / an offset ("2026-03-08T07:30:00Z"), which needs no interpretation.
 */
export function resolveTime(at: string, timeZone: string): ResolvedTime {
  const zone = canonicalTimeZone(timeZone);
  const text = typeof at === 'string' ? at.trim() : '';

  if (INSTANT_RE.test(text)) {
    let instant: Temporal.Instant;
    try {
      instant = Temporal.Instant.from(text);
    } catch {
      throw new TimeError('invalid_time', `"${at}" is not a valid instant`);
    }
    return {
      scheduledAt: instant.epochMilliseconds,
      requestedLocalTime: toSeconds(instant.toZonedDateTimeISO(zone).toPlainDateTime()),
      timeZone: zone,
      resolution: 'instant',
    };
  }

  if (!LOCAL_RE.test(text)) {
    throw new TimeError(
      'invalid_time',
      `"${String(at)}" is not a valid time; use local "YYYY-MM-DDTHH:mm[:ss]" or an instant with Z/offset`,
    );
  }

  let local: Temporal.PlainDateTime;
  try {
    local = Temporal.PlainDateTime.from(text, { overflow: 'reject' }); // "2026-02-30" must fail, not silently become Feb 28
  } catch {
    throw new TimeError('invalid_time', `"${at}" is not a real calendar date/time`);
  }

  let resolution: TimeResolution = 'exact';
  try {
    local.toZonedDateTime(zone, { disambiguation: 'reject' });
  } catch {
    // Either the local time does not exist (gap) or it exists twice (overlap). Tell them apart:
    // the "compatible" answer keeps the wall time for an overlap and changes it for a gap.
    const compatible = local.toZonedDateTime(zone, { disambiguation: 'compatible' });
    resolution = Temporal.PlainDateTime.compare(compatible.toPlainDateTime(), local) === 0 ? 'ambiguous_first' : 'gap_shifted_forward';
  }
  const zoned = local.toZonedDateTime(zone, { disambiguation: 'compatible' });
  return { scheduledAt: zoned.epochMilliseconds, requestedLocalTime: toSeconds(local), timeZone: zone, resolution };
}

/** ISO string of an instant as seen in a zone, with offset, e.g. 2026-03-08T03:30:00-04:00. */
export function formatInZone(epochMs: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toString({ smallestUnit: 'second', timeZoneName: 'never' });
}

export const toIso = (epochMs: number): string => new Date(epochMs).toISOString();
