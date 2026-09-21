import type { ManualClock } from './clock';
import type { SchedulerStore } from './store/store';
import type { Worker } from './worker';

/**
 * Advances a manual clock event by event until nothing is scheduled any more: process what is due, then jump
 * to the next moment something needs attention (a due item, a retry, an expiring lease). Deterministic and instant.
 */
export async function advanceUntilSettled(
  deps: { clock: ManualClock; worker: Worker; store: SchedulerStore },
  options: { maxSteps?: number; until?: number } = {},
): Promise<{ steps: number; settled: boolean }> {
  const { clock, worker, store } = deps;
  const maxSteps = options.maxSteps ?? 1000;
  for (let steps = 0; steps < maxSteps; steps++) {
    await worker.runUntilIdle();
    const wake = store.nextWakeTime();
    if (wake === undefined) return { steps, settled: true };
    if (options.until !== undefined && wake > options.until) return { steps, settled: false };
    if (wake > clock.now()) clock.set(wake);
  }
  return { steps: maxSteps, settled: false };
}
