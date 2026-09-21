/**
 * Shared vocabulary.
 *
 * An item moves scheduled -> running -> (delivered | scheduled again for a retry | failed),
 * and can be cancelled while scheduled or running. delivered / cancelled / failed are final.
 */
export const TERMINAL_STATES = ['delivered', 'cancelled', 'failed'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type ItemState = 'scheduled' | 'running' | TerminalState;
export const ITEM_STATES: readonly ItemState[] = ['scheduled', 'running', ...TERMINAL_STATES];

export type ItemKind = 'reminder' | 'follow_up';

/**
 * How the requested time became an instant:
 *  - exact:               the local time existed once (the normal case)
 *  - gap_shifted_forward: the local time did not exist (clocks jumped forward); moved forward by the gap
 *  - ambiguous_first:     the local time happened twice (clocks fell back); the first occurrence was used
 *  - instant:             the caller supplied an absolute instant, so no interpretation was needed
 */
export type TimeResolution = 'exact' | 'gap_shifted_forward' | 'ambiguous_first' | 'instant';

/** Why an item ended up failed / cancelled. */
export type TerminalReason = 'retries_exhausted' | 'permanent_failure' | 'cancelled_by_user';

/**
 * What happened to one execution attempt.
 *  in_flight              claimed, outcome not known yet
 *  delivered              destination accepted; this attempt committed the delivery
 *  duplicate_acknowledged destination (or the store) had already seen this occurrence; no second notification
 *  temporary_failure      retryable failure
 *  permanent_failure      non-retryable failure
 *  abandoned              the worker vanished (lease expired) before finishing
 *  aborted_cancelled      cancelled before anything was sent
 *  aborted_superseded     edited before anything was sent
 *  sent_but_cancelled     the send had already happened when the cancel landed (see SUBMISSION.md)
 *  sent_but_superseded    the send had already happened when the edit landed
 *  sent_lease_lost        the send happened after this worker's claim had been taken over
 */
export type AttemptOutcome =
  | 'in_flight'
  | 'delivered'
  | 'duplicate_acknowledged'
  | 'temporary_failure'
  | 'permanent_failure'
  | 'abandoned'
  | 'aborted_cancelled'
  | 'aborted_superseded'
  | 'sent_but_cancelled'
  | 'sent_but_superseded'
  | 'sent_lease_lost';

export interface ItemRecord {
  id: string;
  kind: ItemKind;
  content: string;
  conversationId: string | null;
  state: ItemState;
  /** Increments on every edit. (id, version) is the unit of delivery: one "occurrence". */
  version: number;
  timeZone: string;
  /** The wall-clock time as requested, e.g. 2026-03-08T02:30:00 (may not exist in that zone). */
  requestedLocalTime: string;
  timeResolution: TimeResolution;
  /** Effective instant of the current version, epoch ms (UTC). */
  scheduledAt: number;
  /** Retry time after a temporary failure; null means "use scheduledAt". */
  nextAttemptAt: number | null;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  terminalReason: TerminalReason | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** The stable delivery key for an occurrence. Identical for every attempt and every worker. */
export const deliveryKeyOf = (itemId: string, version: number): string => `${itemId}:v${version}`;

export interface AttemptRecord {
  seq: number;
  version: number;
  occurrenceAttempt: number;
  deliveryKey: string;
  workerId: string;
  dueAt: number;
  claimedAt: number;
  leaseExpiresAt: number;
  finishedAt: number | null;
  outcome: AttemptOutcome;
  detail: string | null;
}

export interface RevisionRecord {
  version: number;
  content: string;
  timeZone: string;
  requestedLocalTime: string;
  timeResolution: TimeResolution;
  scheduledAt: number;
  createdAt: number;
  supersededAt: number | null;
}

export interface DeliveryRecord {
  deliveryKey: string;
  itemId: string;
  version: number;
  deliveredAt: number;
  attemptSeq: number;
}

/** What the destination receives. */
export interface Notification {
  deliveryKey: string;
  itemId: string;
  version: number;
  kind: ItemKind;
  content: string;
  conversationId: string | null;
  scheduledAt: number;
  timeZone: string;
}

/** A worker's temporary right to execute one occurrence. */
export interface Claim {
  itemId: string;
  version: number;
  token: string;
  attemptSeq: number;
  occurrenceAttempt: number;
  deliveryKey: string;
  workerId: string;
  dueAt: number;
  claimedAt: number;
  leaseExpiresAt: number;
  notification: Notification;
}
