/**
 * Bounded retries for TEMPORARY delivery failures.
 *
 * `maxAttempts` counts every attempt of one occurrence, including attempts that were abandoned by a dead
 * worker, so a poison item cannot loop forever. `delaysMs[i]` is the wait after the (i+1)-th failed attempt.
 * Delays are fixed (no jitter) to keep every run reproducible; production would add jitter.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly delaysMs: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4, // 1 first try + 3 retries
  delaysMs: [30_000, 120_000, 600_000], // 30 s, 2 min, 10 min
};

export function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new RangeError('maxAttempts must be an integer >= 1');
  if (policy.delaysMs.length < policy.maxAttempts - 1) throw new RangeError('delaysMs needs one entry per retry (maxAttempts - 1)');
  if (policy.delaysMs.some((d) => !Number.isFinite(d) || d < 0)) throw new RangeError('delays must be non-negative numbers');
  return policy;
}

/** Wait before the next attempt after `failedAttempts` failures, or undefined when the budget is used up. */
export function delayAfterFailure(policy: RetryPolicy, failedAttempts: number): number | undefined {
  if (failedAttempts >= policy.maxAttempts) return undefined;
  return policy.delaysMs[failedAttempts - 1];
}
