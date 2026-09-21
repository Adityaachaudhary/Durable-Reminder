import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, delayAfterFailure, validateRetryPolicy } from '../src';

describe('retry policy', () => {
  it('waits 30 s, 2 min, 10 min after the 1st, 2nd and 3rd failure, then gives up', () => {
    expect(delayAfterFailure(DEFAULT_RETRY_POLICY, 1)).toBe(30_000);
    expect(delayAfterFailure(DEFAULT_RETRY_POLICY, 2)).toBe(120_000);
    expect(delayAfterFailure(DEFAULT_RETRY_POLICY, 3)).toBe(600_000);
    expect(delayAfterFailure(DEFAULT_RETRY_POLICY, 4)).toBeUndefined();
    expect(delayAfterFailure(DEFAULT_RETRY_POLICY, 99)).toBeUndefined();
  });

  it('validates its shape', () => {
    expect(() => validateRetryPolicy({ maxAttempts: 0, delaysMs: [] })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ maxAttempts: 3, delaysMs: [1] })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ maxAttempts: 2, delaysMs: [-1] })).toThrow(RangeError);
    expect(validateRetryPolicy({ maxAttempts: 1, delaysMs: [] })).toEqual({ maxAttempts: 1, delaysMs: [] });
  });
});
