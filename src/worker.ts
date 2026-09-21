import { randomUUID } from 'node:crypto';
import type { Clock, TimerHandle } from './clock';
import { classifyError, describeError, type Notifier } from './notifier';
import { DEFAULT_RETRY_POLICY, delayAfterFailure, validateRetryPolicy, type RetryPolicy } from './retryPolicy';
import type { SchedulerStore } from './store/store';
import type { ClaimLossReason } from './store/store';
import type { AttemptOutcome, Claim } from './types';

export interface WorkerOptions {
  store: SchedulerStore;
  notifier: Notifier;
  clock: Clock;
  workerId?: string;
  retry?: RetryPolicy;
  /** How long a claim is valid. A worker that vanishes is taken over after this. */
  leaseMs?: number;
  /** Most items claimed per tick. */
  batchSize?: number;
  onError?: (error: unknown) => void;
}

export interface ExecutionResult {
  itemId: string;
  version: number;
  outcome: AttemptOutcome;
}

export interface TickResult {
  claimed: number;
  results: ExecutionResult[];
}

/** Attempt outcome to record when the claim was lost before/after sending. */
const BEFORE_SEND: Record<ClaimLossReason, AttemptOutcome> = {
  cancelled: 'aborted_cancelled',
  superseded: 'aborted_superseded',
  already_delivered: 'duplicate_acknowledged',
  lease_lost: 'abandoned',
};
const AFTER_SEND: Record<ClaimLossReason, AttemptOutcome> = {
  cancelled: 'sent_but_cancelled',
  superseded: 'sent_but_superseded',
  already_delivered: 'duplicate_acknowledged',
  lease_lost: 'sent_lease_lost',
};

/**
 * Discovers due work, claims it, delivers it through the notifier and records the outcome.
 * It keeps no schedule in memory: the store is the only source of truth, so a fresh worker after a restart
 * simply finds whatever is due (or whose lease expired) and carries on.
 *
 * Per item: claim (lease + attempt row) -> fence check -> send -> guarded commit / retry / fail.
 */
export class Worker {
  readonly workerId: string;
  private readonly retry: RetryPolicy;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private ticking = false;
  private running = false;
  private timer: TimerHandle | undefined;

  constructor(private readonly options: WorkerOptions) {
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.retry = validateRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
    this.leaseMs = options.leaseMs ?? 30_000;
    this.batchSize = options.batchSize ?? 50;
  }

  /** One discovery pass: claims what is due right now and processes it, oldest first. */
  async tick(): Promise<TickResult> {
    if (this.ticking) return { claimed: 0, results: [] }; // never overlap two passes of the same worker
    this.ticking = true;
    try {
      const { store, clock } = this.options;
      const claims = store.claimDue({
        now: clock.now(),
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        limit: this.batchSize,
        maxAttempts: this.retry.maxAttempts,
        newToken: randomUUID,
      });
      const results: ExecutionResult[] = [];
      for (const claim of claims) results.push(await this.execute(claim));
      return { claimed: claims.length, results };
    } finally {
      this.ticking = false;
    }
  }

  /** Ticks until nothing more is due at the current time (retries are scheduled in the future, so this ends). */
  async runUntilIdle(maxRounds = 100): Promise<ExecutionResult[]> {
    const all: ExecutionResult[] = [];
    for (let round = 0; round < maxRounds; round++) {
      const { claimed, results } = await this.tick();
      all.push(...results);
      if (claimed === 0) break;
    }
    return all;
  }

  /** Polling loop on the injected clock. Safe to stop and start again; state lives in the store. */
  start(pollMs = 1000): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      try {
        await this.runUntilIdle();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (this.running) this.timer = this.options.clock.setTimeout(loop, pollMs);
    };
    this.timer = this.options.clock.setTimeout(loop, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Executes one claim. Exposed for tests that need to run the same claim twice. */
  async execute(claim: Claim): Promise<ExecutionResult> {
    const { store, notifier, clock } = this.options;
    const done = (outcome: AttemptOutcome): ExecutionResult => ({ itemId: claim.itemId, version: claim.version, outcome });

    // Fence: if the item was cancelled or edited after we claimed it, do not send at all.
    const fence = store.fence(claim);
    if (!fence.valid) {
      const outcome = BEFORE_SEND[fence.reason];
      store.finishAttempt(claim.itemId, claim.attemptSeq, outcome, `claim lost before sending (${fence.reason})`, clock.now());
      return done(outcome);
    }

    let ack: 'accepted' | 'duplicate';
    try {
      ack = (await notifier.send(claim.notification)).status;
    } catch (error) {
      return this.handleFailure(claim, error);
    }

    const commit = store.completeDelivered(claim, { ack, now: clock.now() });
    if (commit.committed) return done(ack === 'accepted' ? 'delivered' : 'duplicate_acknowledged');
    // We sent, but the item is no longer ours to complete: cancelled, edited, delivered by someone else, or re-claimed.
    const outcome = AFTER_SEND[commit.reason];
    store.finishAttempt(claim.itemId, claim.attemptSeq, outcome, `send happened, then the claim was lost (${commit.reason})`, clock.now());
    return done(outcome);
  }

  private handleFailure(claim: Claim, error: unknown): ExecutionResult {
    const { store, clock } = this.options;
    const now = clock.now();
    const detail = describeError(error);
    const done = (outcome: AttemptOutcome): ExecutionResult => ({ itemId: claim.itemId, version: claim.version, outcome });

    if (classifyError(error) === 'permanent') {
      store.markFailed(claim, { reason: 'permanent_failure', outcome: 'permanent_failure', detail, now });
      return done('permanent_failure');
    }
    const delay = delayAfterFailure(this.retry, claim.occurrenceAttempt);
    if (delay === undefined) {
      store.markFailed(claim, { reason: 'retries_exhausted', outcome: 'temporary_failure', detail, now });
    } else {
      store.markRetry(claim, { retryAt: now + delay, detail, now });
    }
    return done('temporary_failure');
  }
}
