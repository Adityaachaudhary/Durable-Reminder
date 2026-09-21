import { randomUUID } from 'node:crypto';
import type { Clock } from './clock';
import { canonicalTimeZone, formatInZone, resolveTime, TimeError, toIso, type ResolvedTime } from './time';
import { hashRequest } from './store/sqliteStore';
import type { SchedulerStore } from './store/store';
import { deliveryKeyOf, type AttemptRecord, type ItemKind, type ItemRecord, type ItemState, type RevisionRecord } from './types';

export type ServiceErrorCode =
  | 'invalid_request'
  | 'invalid_time'
  | 'invalid_time_zone'
  | 'time_in_past'
  | 'not_found'
  | 'id_conflict'
  | 'version_mismatch'
  | 'already_terminal';

const STATUS: Record<ServiceErrorCode, number> = {
  invalid_request: 400,
  invalid_time: 400,
  invalid_time_zone: 400,
  time_in_past: 422,
  not_found: 404,
  id_conflict: 409,
  version_mismatch: 409,
  already_terminal: 409,
};

export class ServiceError extends Error {
  readonly status: number;
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
    this.status = STATUS[code];
  }
}

export interface CreateInput {
  id?: string;
  kind?: ItemKind;
  content: string;
  timeZone: string;
  /** Local wall time ("2026-03-08T09:00") in `timeZone`, or an absolute instant ("...Z" / offset). */
  at: string;
  conversationId?: string;
}

export interface EditPatch {
  /** Required: the version the caller last saw. A stale value is rejected, so concurrent edits cannot clobber each other. */
  expectedVersion: number;
  content?: string;
  at?: string;
  timeZone?: string;
}

/** API-facing shape: ISO strings, no internal tokens. */
export interface ItemView {
  id: string;
  kind: ItemKind;
  content: string;
  conversationId: string | null;
  state: ItemState;
  version: number;
  deliveryKey: string;
  timeZone: string;
  requestedLocalTime: string;
  timeResolution: ItemRecord['timeResolution'];
  scheduledAt: string;
  scheduledLocal: string;
  nextAttemptAt: string | null;
  terminalReason: ItemRecord['terminalReason'];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AttemptView {
  seq: number;
  version: number;
  occurrenceAttempt: number;
  deliveryKey: string;
  workerId: string;
  dueAt: string;
  claimedAt: string;
  latenessMs: number;
  finishedAt: string | null;
  outcome: AttemptRecord['outcome'];
  detail: string | null;
}

export interface RevisionView {
  version: number;
  content: string;
  timeZone: string;
  requestedLocalTime: string;
  timeResolution: RevisionRecord['timeResolution'];
  scheduledAt: string;
  createdAt: string;
  supersededAt: string | null;
}

export interface ItemDetail extends ItemView {
  attempts: AttemptView[];
  revisions: RevisionView[];
}

export const toView = (item: ItemRecord): ItemView => ({
  id: item.id,
  kind: item.kind,
  content: item.content,
  conversationId: item.conversationId,
  state: item.state,
  version: item.version,
  deliveryKey: deliveryKeyOf(item.id, item.version),
  timeZone: item.timeZone,
  requestedLocalTime: item.requestedLocalTime,
  timeResolution: item.timeResolution,
  scheduledAt: toIso(item.scheduledAt),
  scheduledLocal: formatInZone(item.scheduledAt, item.timeZone),
  nextAttemptAt: item.nextAttemptAt === null ? null : toIso(item.nextAttemptAt),
  terminalReason: item.terminalReason,
  createdAt: toIso(item.createdAt),
  updatedAt: toIso(item.updatedAt),
  finishedAt: item.finishedAt === null ? null : toIso(item.finishedAt),
});

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CONTENT = 2000;

export class ReminderService {
  private readonly ids: () => string;

  constructor(
    private readonly deps: { store: SchedulerStore; clock: Clock; ids?: () => string },
  ) {
    this.ids = deps.ids ?? randomUUID;
  }

  create(input: CreateInput): { item: ItemView; created: boolean } {
    const content = this.validContent(input.content);
    if (input.kind !== undefined && input.kind !== 'reminder' && input.kind !== 'follow_up') {
      throw new ServiceError('invalid_request', 'kind must be "reminder" or "follow_up"');
    }
    if (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || input.conversationId.length > 100)) {
      throw new ServiceError('invalid_request', 'conversationId must be a string of at most 100 characters');
    }
    if (input.id !== undefined && (typeof input.id !== 'string' || !ID_RE.test(input.id))) {
      throw new ServiceError('invalid_request', 'id must match [A-Za-z0-9._-] and be 1 to 64 characters');
    }
    const resolved = this.resolve(input.at, input.timeZone);
    const now = this.deps.clock.now();
    if (resolved.scheduledAt < now) {
      throw new ServiceError('time_in_past', 'The requested time is already in the past', { scheduledAt: toIso(resolved.scheduledAt) });
    }

    const id = input.id ?? this.ids();
    const kind = input.kind ?? 'reminder';
    const conversationId = input.conversationId ?? null;
    const outcome = this.deps.store.createItem({
      id,
      kind,
      content,
      conversationId,
      timeZone: resolved.timeZone,
      requestedLocalTime: resolved.requestedLocalTime,
      timeResolution: resolved.resolution,
      scheduledAt: resolved.scheduledAt,
      requestHash: hashRequest([id, kind, content, conversationId, resolved.timeZone, input.at.trim()]),
      now,
    });
    if (outcome.created) return { item: toView(outcome.item), created: true };
    // Same id again: a replay of the same request is harmless (idempotent create), a different one is a conflict.
    if (!outcome.sameRequest) throw new ServiceError('id_conflict', `An item with id "${id}" already exists with different content`, { id });
    return { item: toView(outcome.item), created: false };
  }

  get(id: string): ItemDetail {
    const item = this.deps.store.getItem(id);
    if (!item) throw new ServiceError('not_found', `No item with id "${id}"`, { id });
    return {
      ...toView(item),
      attempts: this.deps.store.getAttempts(id).map((a) => ({
        seq: a.seq,
        version: a.version,
        occurrenceAttempt: a.occurrenceAttempt,
        deliveryKey: a.deliveryKey,
        workerId: a.workerId,
        dueAt: toIso(a.dueAt),
        claimedAt: toIso(a.claimedAt),
        latenessMs: Math.max(0, a.claimedAt - a.dueAt),
        finishedAt: a.finishedAt === null ? null : toIso(a.finishedAt),
        outcome: a.outcome,
        detail: a.detail,
      })),
      revisions: this.deps.store.getRevisions(id).map((r) => ({
        version: r.version,
        content: r.content,
        timeZone: r.timeZone,
        requestedLocalTime: r.requestedLocalTime,
        timeResolution: r.timeResolution,
        scheduledAt: toIso(r.scheduledAt),
        createdAt: toIso(r.createdAt),
        supersededAt: r.supersededAt === null ? null : toIso(r.supersededAt),
      })),
    };
  }

  list(filter: { state?: string } = {}): ItemView[] {
    if (filter.state !== undefined && !['scheduled', 'running', 'delivered', 'cancelled', 'failed'].includes(filter.state)) {
      throw new ServiceError('invalid_request', 'state must be one of scheduled, running, delivered, cancelled, failed');
    }
    return this.deps.store.listItems(filter.state ? { state: filter.state as ItemState } : {}).map(toView);
  }

  /**
   * Edit before delivery. Changing the time or content creates a new version (a new occurrence with a new delivery
   * key); the previous occurrence can never be delivered afterwards. An edit that changes nothing is a no-op.
   */
  edit(id: string, patch: EditPatch): { item: ItemView; changed: boolean } {
    if (!Number.isInteger(patch.expectedVersion) || patch.expectedVersion < 1) {
      throw new ServiceError('invalid_request', 'expectedVersion (the version you last saw) is required');
    }
    if (patch.content === undefined && patch.at === undefined && patch.timeZone === undefined) {
      throw new ServiceError('invalid_request', 'Nothing to change: provide content, at and/or timeZone');
    }
    const current = this.deps.store.getItem(id);
    if (!current) throw new ServiceError('not_found', `No item with id "${id}"`, { id });
    if (current.state === 'delivered' || current.state === 'cancelled' || current.state === 'failed') {
      throw new ServiceError('already_terminal', `Item is ${current.state} and can no longer be edited`, { state: current.state });
    }
    if (current.version !== patch.expectedVersion) {
      throw new ServiceError('version_mismatch', 'The item changed since you read it', { currentVersion: current.version });
    }

    const content = patch.content === undefined ? current.content : this.validContent(patch.content);
    let time: ResolvedTime = {
      scheduledAt: current.scheduledAt,
      requestedLocalTime: current.requestedLocalTime,
      timeZone: current.timeZone,
      resolution: current.timeResolution,
    };
    const zone = patch.timeZone === undefined ? current.timeZone : this.canonicalZone(patch.timeZone);
    if (patch.at !== undefined) {
      time = this.resolve(patch.at, zone);
    } else if (zone !== current.timeZone) {
      // Zone changed without a new time: keep the WALL-CLOCK time the user asked for and read it in the new zone.
      time = this.resolve(current.requestedLocalTime, zone);
    }

    const timeChanged = time.scheduledAt !== current.scheduledAt || time.timeZone !== current.timeZone || time.requestedLocalTime !== current.requestedLocalTime;
    const now = this.deps.clock.now();
    if (timeChanged && time.scheduledAt < now) {
      throw new ServiceError('time_in_past', 'The requested time is already in the past', { scheduledAt: toIso(time.scheduledAt) });
    }
    if (!timeChanged && content === current.content) return { item: toView(current), changed: false };

    const outcome = this.deps.store.editItem({
      id,
      expectedVersion: patch.expectedVersion,
      content,
      timeZone: time.timeZone,
      requestedLocalTime: time.requestedLocalTime,
      timeResolution: time.resolution,
      scheduledAt: time.scheduledAt,
      now,
    });
    if (outcome.ok) return { item: toView(outcome.item), changed: true };
    if (outcome.reason === 'not_found') throw new ServiceError('not_found', `No item with id "${id}"`, { id });
    if (outcome.reason === 'terminal') throw new ServiceError('already_terminal', `Item is ${outcome.state} and can no longer be edited`, { state: outcome.state });
    throw new ServiceError('version_mismatch', 'The item changed since you read it', { currentVersion: outcome.currentVersion });
  }

  /** Idempotent: cancelling an already cancelled item succeeds and changes nothing. */
  cancel(id: string): { item: ItemView; changed: boolean } {
    const outcome = this.deps.store.cancelItem(id, this.deps.clock.now());
    if (outcome.ok) return { item: toView(outcome.item), changed: outcome.changed };
    if (outcome.reason === 'not_found') throw new ServiceError('not_found', `No item with id "${id}"`, { id });
    throw new ServiceError('already_terminal', `Item is already ${outcome.state}; it can no longer be cancelled`, { state: outcome.state });
  }

  private validContent(content: unknown): string {
    if (typeof content !== 'string' || content.trim() === '') throw new ServiceError('invalid_request', 'content is required');
    if (content.length > MAX_CONTENT) throw new ServiceError('invalid_request', `content is limited to ${MAX_CONTENT} characters`);
    return content.trim();
  }

  private canonicalZone(timeZone: string): string {
    try {
      return canonicalTimeZone(timeZone);
    } catch (error) {
      throw this.asServiceError(error);
    }
  }

  private resolve(at: unknown, timeZone: unknown): ResolvedTime {
    if (typeof at !== 'string') throw new ServiceError('invalid_request', 'at is required (local "YYYY-MM-DDTHH:mm" or an instant)');
    if (typeof timeZone !== 'string') throw new ServiceError('invalid_request', 'timeZone is required (IANA identifier such as Asia/Kolkata)');
    try {
      return resolveTime(at, timeZone);
    } catch (error) {
      throw this.asServiceError(error);
    }
  }

  private asServiceError(error: unknown): unknown {
    return error instanceof TimeError ? new ServiceError(error.code, error.message) : error;
  }
}
