import type { Clock } from './clock';
import type { Notifier, SendAck } from './notifier';
import { PermanentDeliveryError, TemporaryDeliveryError } from './notifier';
import type { Notification } from './types';

export interface Gate {
  
  reached: Promise<void>;
  open(): void;
  enter(): Promise<void>;
}

/** A hold-point inside `send`, so tests can interleave other operations while a send is "in flight". */
export function createGate(): Gate {
  let markReached!: () => void;
  let openGate!: () => void;
  const reached = new Promise<void>((resolve) => (markReached = resolve));
  const opened = new Promise<void>((resolve) => (openGate = resolve));
  return {
    reached,
    open: () => openGate(),
    enter: () => {
      markReached();
      return opened;
    },
  };
}

/**
 * What the fake destination does on the next send for a key:
 *  ok         accept
 *  temporary  fail with a retryable error, nothing recorded
 *  permanent  fail with a non-retryable error, nothing recorded
 *  lost_ack   ACCEPT (recorded) but fail the response, like a timeout after the message was stored
 *  {gate}     wait at the gate, then accept
 */
export type FakeStep = 'ok' | 'temporary' | 'permanent' | 'lost_ack' | { gate: Gate };

export interface ReceivedNotification {
  notification: Notification;
  receivedAt: number | null;
  sendCount: number;
}

/**
 * Local notification destination. It is idempotent by delivery key, like a real destination must be,
 * and counts both "logical" notifications (what a user would see) and raw send calls.
 */
export class FakeNotifier implements Notifier {
  /** Logical notifications: one entry per distinct delivery key. */
  readonly received = new Map<string, ReceivedNotification>();
  /** Every send call, in order (including retries and duplicates). */
  readonly sendLog: string[] = [];
  private readonly plans = new Map<string, FakeStep[]>();

  constructor(
    private readonly options: {
      clock?: Clock;
      defaultSteps?: FakeStep[];
      log?: (line: string) => void;
    } = {},
  ) {}

  /** Script the next sends for one delivery key (consumed in order; after that the destination accepts). */
  plan(deliveryKey: string, ...steps: FakeStep[]): void {
    this.plans.set(deliveryKey, [...steps]);
  }

  logicalCount(deliveryKey: string): number {
    return this.received.has(deliveryKey) ? 1 : 0;
  }

  sendCount(deliveryKey: string): number {
    return this.sendLog.filter((key) => key === deliveryKey).length;
  }

  async send(notification: Notification): Promise<SendAck> {
    const key = notification.deliveryKey;
    this.sendLog.push(key);
    if (!this.plans.has(key)) this.plans.set(key, [...(this.options.defaultSteps ?? [])]);
    const step = this.plans.get(key)!.shift() ?? 'ok';

    if (step === 'temporary') {
      this.options.log?.(`  destination: 503 unavailable for ${key} (temporary)`);
      throw new TemporaryDeliveryError('503 destination unavailable');
    }
    if (step === 'permanent') {
      this.options.log?.(`  destination: 400 rejected ${key} (permanent)`);
      throw new PermanentDeliveryError('400 recipient rejected the notification');
    }
    if (typeof step === 'object') await step.gate.enter();

    const existing = this.received.get(key);
    let ack: SendAck;
    if (existing) {
      existing.sendCount += 1;
      ack = { status: 'duplicate' };
      this.options.log?.(`  destination: ${key} already delivered, duplicate ignored (user sees it once)`);
    } else {
      this.received.set(key, { notification, receivedAt: this.options.clock?.now() ?? null, sendCount: 1 });
      ack = { status: 'accepted' };
      this.options.log?.(`  NOTIFY ${key} -> "${notification.content}"`);
    }
    if (step === 'lost_ack') {
      this.options.log?.(`  destination: accepted ${key} but the acknowledgement was lost`);
      throw new TemporaryDeliveryError('timeout waiting for acknowledgement');
    }
    return ack;
  }
}
