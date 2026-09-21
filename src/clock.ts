/**
 * Time is injected so every time-dependent behaviour can run instantly and deterministically.
 * Production uses `systemClock`; tests, demos and the benchmark use `ManualClock`.
 */
export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Lets already-queued promise continuations run. Not a sleep: it waits for the microtask queue to drain. */
export const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface ManualTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic clock: time moves only when told to. Timers due at the same instant fire in creation order. */
export class ManualClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, ManualTimer>();

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** Jumps forward without firing timers (fine when nothing uses timers). */
  set(ms: number): void {
    if (ms < this.current) throw new RangeError(`clock cannot move backwards (${ms} < ${this.current})`);
    this.current = ms;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.current + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves time forward, firing every timer that falls due on the way (in time, then creation, order). */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await flushMicrotasks();
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.timers.delete(next.id);
      this.current = Math.max(this.current, next.at);
      next.fn();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }

  private nextDue(limit: number): ManualTimer | undefined {
    let best: ManualTimer | undefined;
    for (const timer of this.timers.values()) {
      if (timer.at > limit) continue;
      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer;
    }
    return best;
  }
}
