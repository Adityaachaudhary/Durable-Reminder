import { describe, expect, it } from 'vitest';
import { runBenchmark } from '../src/benchmark/runBenchmark';

describe('verification benchmark', () => {
  it('23 items, 3 zones, a restart and a duplicate execution: every invariant holds and the run repeats identically', async () => {
    const report = await runBenchmark();
    expect(report.violations).toEqual([]);
    expect(report.items).toBeGreaterThanOrEqual(20);
    expect(report.zones.length).toBeGreaterThanOrEqual(2);
    expect(report.countsByState).toEqual({ delivered: 16, cancelled: 3, failed: 4 });
    expect(report.logicalNotifications).toBe(report.deliveredItems);
    expect(report.deliveryRecords).toBe(report.deliveredItems);
    expect(report.overdueAtRestart).toBeGreaterThan(0);
    expect(report.duplicateExecution).toEqual({ sendCalls: 2, logicalNotifications: 1, deliveryRecords: 1 });
    expect(report.repeatable).toBe(true);
    expect(report.passed).toBe(true);
  });
});
