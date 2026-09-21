import type {
  AttemptOutcome,
  AttemptRecord,
  Claim,
  DeliveryRecord,
  ItemKind,
  ItemRecord,
  ItemState,
  RevisionRecord,
  TerminalReason,
  TimeResolution,
} from '../types';

export interface NewItemInput {
  id: string;
  kind: ItemKind;
  content: string;
  conversationId: string | null;
  timeZone: string;
  requestedLocalTime: string;
  timeResolution: TimeResolution;
  scheduledAt: number;
  /** Hash of the original create request; makes create idempotent by id. */
  requestHash: string;
  now: number;
}

export type CreateOutcome =
  | { created: true; item: ItemRecord }
  | { created: false; item: ItemRecord; sameRequest: boolean };

export interface EditInput {
  id: string;
  expectedVersion: number;
  content: string;
  timeZone: string;
  requestedLocalTime: string;
  timeResolution: TimeResolution;
  scheduledAt: number;
  now: number;
}

export type EditOutcome =
  | { ok: true; item: ItemRecord; releasedRunningClaim: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'terminal'; state: ItemState }
  | { ok: false; reason: 'version_mismatch'; currentVersion: number };

export type CancelOutcome =
  | { ok: true; item: ItemRecord; changed: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'terminal'; state: ItemState };

export interface ClaimInput {
  now: number;
  workerId: string;
  leaseMs: number;
  limit: number;
  /** Attempts (of any outcome) one occurrence may consume. Beyond this the item is failed instead of claimed. */
  maxAttempts: number;
  newToken: () => string;
}

/** Why a worker's claim is no longer good. */
export type ClaimLossReason = 'cancelled' | 'superseded' | 'already_delivered' | 'lease_lost';

export type FenceResult = { valid: true } | { valid: false; reason: ClaimLossReason };
export type CommitResult = { committed: true } | { committed: false; reason: ClaimLossReason };

/**
 * Persistence for scheduled work. Every state change is a guarded, transactional operation, so when two
 * actors race (a worker and an edit, two workers, a cancel) exactly one wins and the loser is told why.
 * The interface is synchronous on purpose (see SUBMISSION.md, "Trade-offs").
 */
export interface SchedulerStore {
  createItem(input: NewItemInput): CreateOutcome;
  getItem(id: string): ItemRecord | undefined;
  listItems(filter?: { state?: ItemState }): ItemRecord[];
  getAttempts(itemId: string): AttemptRecord[];
  getRevisions(itemId: string): RevisionRecord[];
  getDelivery(deliveryKey: string): DeliveryRecord | undefined;
  listDeliveries(): DeliveryRecord[];

  editItem(input: EditInput): EditOutcome;
  cancelItem(id: string, now: number): CancelOutcome;

  /** Atomically claims due work (and work whose lease expired). */
  claimDue(input: ClaimInput): Claim[];
  /** Read-only check, done just before sending: is this claim still the one that may deliver? */
  fence(claim: Claim): FenceResult;
  /** Commits a delivery: delivery record + item state + attempt outcome, atomically, only if the claim is still valid. */
  completeDelivered(claim: Claim, input: { ack: 'accepted' | 'duplicate'; now: number }): CommitResult;
  /** Temporary failure with retries left: back to scheduled at `retryAt`. Returns false if the claim was lost meanwhile. */
  markRetry(claim: Claim, input: { retryAt: number; detail: string; now: number }): boolean;
  /** Terminal failure. Returns false if the claim was lost meanwhile (the item is left alone). */
  markFailed(claim: Claim, input: { reason: 'retries_exhausted' | 'permanent_failure'; outcome: AttemptOutcome; detail: string; now: number }): boolean;
  /** Records the outcome of an attempt without touching the item. */
  finishAttempt(itemId: string, attemptSeq: number, outcome: AttemptOutcome, detail: string | null, now: number): void;

  /** Earliest moment at which something needs attention (a due item or an expiring lease), or undefined when settled. */
  nextWakeTime(): number | undefined;
  counts(): Record<ItemState, number>;
  close(): void;
}

export type { TerminalReason };
