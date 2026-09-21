import type { Notification } from './types';

/**
 * The delivery boundary. Implementations MUST be idempotent on `deliveryKey`: receiving the same key again
 * (a retry, a duplicate worker, a lost acknowledgement) must not produce a second user-visible notification,
 * and should answer `duplicate`. That is what turns at-least-once sending into exactly-once *logical* delivery.
 */
export type SendAck = { status: 'accepted' } | { status: 'duplicate' };

export interface Notifier {
  send(notification: Notification): Promise<SendAck>;
}

/** Worth retrying: timeouts, 5xx, rate limits, connection resets, lost acknowledgements. */
export class TemporaryDeliveryError extends Error {
  override name = 'TemporaryDeliveryError';
}

/** Retrying cannot help: the destination rejected the request itself (bad recipient, content refused, 4xx). */
export class PermanentDeliveryError extends Error {
  override name = 'PermanentDeliveryError';
}

/** Unknown errors are treated as temporary: retrying is safe because delivery is idempotent, and it is bounded. */
export function classifyError(error: unknown): 'temporary' | 'permanent' {
  return error instanceof PermanentDeliveryError ? 'permanent' : 'temporary';
}

export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 300);
}
