import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  deliveryKeyOf,
  ITEM_STATES,
  type AttemptOutcome,
  type AttemptRecord,
  type Claim,
  type DeliveryRecord,
  type ItemRecord,
  type ItemState,
  type RevisionRecord,
} from '../types';
import type {
  CancelOutcome,
  ClaimInput,
  ClaimLossReason,
  CommitResult,
  CreateOutcome,
  EditInput,
  EditOutcome,
  FenceResult,
  NewItemInput,
  SchedulerStore,
} from './store';

/**
 * Uses Node's built-in SQLite (`node:sqlite`, Node 22.13+): nothing native to compile or download.
 * Loaded through `createRequire` so test runners/bundlers need not know the module; the one-line
 * "experimental" warning older Node versions print is silenced.
 */
export function loadSqlite(): typeof import('node:sqlite') {
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite')) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch (error) {
    throw new Error('This project needs Node.js 22.13 or newer (built-in node:sqlite). Run `node -v` to check.', { cause: error });
  } finally {
    process.emitWarning = original;
  }
}

const TERMINAL = `('delivered','cancelled','failed')`;

/**
 * Besides application logic, the schema enforces the rules that matter most, so a bug or a second writer
 * cannot break them:
 *   1. terminal items are immutable;
 *   2. an item can become `delivered` only if a delivery record exists for its CURRENT occurrence;
 *   3. a delivery record can only be created for an item that is `running` at that same version
 *      (never for a cancelled, edited or already-finished one);
 *   4. one delivery record per delivery key (primary key).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reminder','follow_up')),
  content TEXT NOT NULL,
  conversation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('scheduled','running','delivered','cancelled','failed')),
  version INTEGER NOT NULL CHECK (version >= 1),
  time_zone TEXT NOT NULL,
  requested_local_time TEXT NOT NULL,
  time_resolution TEXT NOT NULL CHECK (time_resolution IN ('exact','gap_shifted_forward','ambiguous_first','instant')),
  scheduled_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  claim_token TEXT,
  lease_expires_at INTEGER,
  terminal_reason TEXT,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS items_by_state ON items(state);

CREATE TABLE IF NOT EXISTS revisions (
  item_id TEXT NOT NULL REFERENCES items(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  requested_local_time TEXT NOT NULL,
  time_resolution TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  superseded_at INTEGER,
  PRIMARY KEY (item_id, version)
);

CREATE TABLE IF NOT EXISTS attempts (
  item_id TEXT NOT NULL REFERENCES items(id),
  seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  occurrence_attempt INTEGER NOT NULL,
  delivery_key TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (item_id, seq),
  UNIQUE (item_id, version, occurrence_attempt)
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  version INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL,
  attempt_seq INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS items_terminal_are_immutable
BEFORE UPDATE ON items
WHEN OLD.state IN ${TERMINAL}
BEGIN
  SELECT RAISE(ABORT, 'terminal items are immutable');
END;

CREATE TRIGGER IF NOT EXISTS delivered_requires_delivery_record
BEFORE UPDATE OF state ON items
WHEN NEW.state = 'delivered'
  AND NOT EXISTS (SELECT 1 FROM deliveries WHERE delivery_key = NEW.id || ':v' || NEW.version)
BEGIN
  SELECT RAISE(ABORT, 'delivered requires a delivery record for the current occurrence');
END;

CREATE TRIGGER IF NOT EXISTS delivery_record_requires_running_item
BEFORE INSERT ON deliveries
WHEN (SELECT state FROM items WHERE id = NEW.item_id) IS NOT 'running'
  OR (SELECT version FROM items WHERE id = NEW.item_id) IS NOT NEW.version
BEGIN
  SELECT RAISE(ABORT, 'a delivery can only be recorded for a running item at the same version');
END;
`;

interface ItemRow {
  id: string;
  kind: ItemRecord['kind'];
  content: string;
  conversation_id: string | null;
  state: ItemState;
  version: number;
  time_zone: string;
  requested_local_time: string;
  time_resolution: ItemRecord['timeResolution'];
  scheduled_at: number;
  next_attempt_at: number | null;
  claim_token: string | null;
  lease_expires_at: number | null;
  terminal_reason: ItemRecord['terminalReason'];
  request_hash: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const toItem = (row: ItemRow): ItemRecord => ({
  id: row.id,
  kind: row.kind,
  content: row.content,
  conversationId: row.conversation_id,
  state: row.state,
  version: row.version,
  timeZone: row.time_zone,
  requestedLocalTime: row.requested_local_time,
  timeResolution: row.time_resolution,
  scheduledAt: row.scheduled_at,
  nextAttemptAt: row.next_attempt_at,
  claimToken: row.claim_token,
  leaseExpiresAt: row.lease_expires_at,
  terminalReason: row.terminal_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
});

export const hashRequest = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export class SqliteStore implements SchedulerStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    const { DatabaseSync: Database } = loadSqlite();
    this.db = new Database(path);
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
    }
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so read-then-write sequences cannot interleave with other writers. */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private row(id: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow | undefined;
  }

  // ------------------------------------------------------------------ create / read

  createItem(input: NewItemInput): CreateOutcome {
    return this.transaction(() => {
      const existing = this.row(input.id);
      if (existing) return { created: false as const, item: toItem(existing), sameRequest: existing.request_hash === input.requestHash };
      this.db
        .prepare(
          `INSERT INTO items (id, kind, content, conversation_id, state, version, time_zone, requested_local_time,
             time_resolution, scheduled_at, request_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'scheduled', 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.kind,
          input.content,
          input.conversationId,
          input.timeZone,
          input.requestedLocalTime,
          input.timeResolution,
          input.scheduledAt,
          input.requestHash,
          input.now,
          input.now,
        );
      this.insertRevision(input.id, 1, input, input.now);
      return { created: true as const, item: toItem(this.row(input.id)!) };
    });
  }

  private insertRevision(
    itemId: string,
    version: number,
    r: { content: string; timeZone: string; requestedLocalTime: string; timeResolution: string; scheduledAt: number },
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO revisions (item_id, version, content, time_zone, requested_local_time, time_resolution, scheduled_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(itemId, version, r.content, r.timeZone, r.requestedLocalTime, r.timeResolution, r.scheduledAt, now);
  }

  getItem(id: string): ItemRecord | undefined {
    const row = this.row(id);
    return row ? toItem(row) : undefined;
  }

  listItems(filter: { state?: ItemState } = {}): ItemRecord[] {
    const rows = (
      filter.state
        ? this.db.prepare('SELECT * FROM items WHERE state = ? ORDER BY created_at, id').all(filter.state)
        : this.db.prepare('SELECT * FROM items ORDER BY created_at, id').all()
    ) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  getAttempts(itemId: string): AttemptRecord[] {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE item_id = ? ORDER BY seq').all(itemId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number,
      version: r.version as number,
      occurrenceAttempt: r.occurrence_attempt as number,
      deliveryKey: r.delivery_key as string,
      workerId: r.worker_id as string,
      dueAt: r.due_at as number,
      claimedAt: r.claimed_at as number,
      leaseExpiresAt: r.lease_expires_at as number,
      finishedAt: (r.finished_at as number | null) ?? null,
      outcome: r.outcome as AttemptOutcome,
      detail: (r.detail as string | null) ?? null,
    }));
  }

  getRevisions(itemId: string): RevisionRecord[] {
    const rows = this.db.prepare('SELECT * FROM revisions WHERE item_id = ? ORDER BY version').all(itemId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      version: r.version as number,
      content: r.content as string,
      timeZone: r.time_zone as string,
      requestedLocalTime: r.requested_local_time as string,
      timeResolution: r.time_resolution as RevisionRecord['timeResolution'],
      scheduledAt: r.scheduled_at as number,
      createdAt: r.created_at as number,
      supersededAt: (r.superseded_at as number | null) ?? null,
    }));
  }

  private toDelivery(r: Record<string, unknown>): DeliveryRecord {
    return {
      deliveryKey: r.delivery_key as string,
      itemId: r.item_id as string,
      version: r.version as number,
      deliveredAt: r.delivered_at as number,
      attemptSeq: r.attempt_seq as number,
    };
  }

  getDelivery(deliveryKey: string): DeliveryRecord | undefined {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ?').get(deliveryKey) as unknown as Record<string, unknown> | undefined;
    return r ? this.toDelivery(r) : undefined;
  }

  listDeliveries(): DeliveryRecord[] {
    return (this.db.prepare('SELECT * FROM deliveries ORDER BY delivered_at, delivery_key').all() as unknown as Array<Record<string, unknown>>).map((r) =>
      this.toDelivery(r),
    );
  }

  // ------------------------------------------------------------------ edit / cancel

  /**
   * Edit policy (deterministic): the edit wins over any in-flight claim. It bumps the version, so the old
   * occurrence can no longer be committed, and puts the item back to `scheduled` at the new time.
   */
  editItem(input: EditInput): EditOutcome {
    return this.transaction(() => {
      const row = this.row(input.id);
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      if (row.state === 'delivered' || row.state === 'cancelled' || row.state === 'failed') {
        return { ok: false as const, reason: 'terminal' as const, state: row.state };
      }
      if (row.version !== input.expectedVersion) {
        return { ok: false as const, reason: 'version_mismatch' as const, currentVersion: row.version };
      }
      const newVersion = row.version + 1;
      const result = this.db
        .prepare(
          `UPDATE items SET version = ?, content = ?, time_zone = ?, requested_local_time = ?, time_resolution = ?,
             scheduled_at = ?, next_attempt_at = NULL, state = 'scheduled', claim_token = NULL, lease_expires_at = NULL,
             updated_at = ?
           WHERE id = ? AND version = ? AND state IN ('scheduled','running')`,
        )
        .run(newVersion, input.content, input.timeZone, input.requestedLocalTime, input.timeResolution, input.scheduledAt, input.now, input.id, input.expectedVersion);
      if (result.changes !== 1) throw new Error('edit guard failed');
      this.db.prepare('UPDATE revisions SET superseded_at = ? WHERE item_id = ? AND version = ?').run(input.now, input.id, row.version);
      this.insertRevision(input.id, newVersion, input, input.now);
      return { ok: true as const, item: toItem(this.row(input.id)!), releasedRunningClaim: row.state === 'running' };
    });
  }

  /**
   * Cancellation policy (deterministic): cancel wins over any delivery that has not committed. Once the item is
   * cancelled no delivery record can be created for it (schema trigger), so no later delivery is ever recorded.
   * A message that was already handed to the destination cannot be recalled; the attempt is then labelled
   * `sent_but_cancelled` so the history stays honest.
   */
  cancelItem(id: string, now: number): CancelOutcome {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      if (row.state === 'cancelled') return { ok: true as const, item: toItem(row), changed: false };
      if (row.state === 'delivered' || row.state === 'failed') return { ok: false as const, reason: 'terminal' as const, state: row.state };
      this.db
        .prepare(
          `UPDATE items SET state = 'cancelled', terminal_reason = 'cancelled_by_user', claim_token = NULL,
             lease_expires_at = NULL, next_attempt_at = NULL, finished_at = ?, updated_at = ?
           WHERE id = ? AND state IN ('scheduled','running')`,
        )
        .run(now, now, id);
      return { ok: true as const, item: toItem(this.row(id)!), changed: true };
    });
  }

  // ------------------------------------------------------------------ claiming and finishing

  claimDue(input: ClaimInput): Claim[] {
    return this.transaction(() => {
      const { now } = input;
      // Attempts whose lease ran out belong to workers that are gone (or too slow). Say so in the history.
      this.db
        .prepare(
          `UPDATE attempts SET outcome = 'abandoned', finished_at = ?, detail = 'lease expired before the attempt finished'
           WHERE outcome = 'in_flight' AND lease_expires_at <= ?`,
        )
        .run(now, now);

      const rows = this.db
        .prepare(
          `SELECT * FROM items
           WHERE (state = 'scheduled' AND COALESCE(next_attempt_at, scheduled_at) <= ?)
              OR (state = 'running' AND lease_expires_at <= ?)
           ORDER BY COALESCE(next_attempt_at, scheduled_at), id
           LIMIT ?`,
        )
        .all(now, now, input.limit) as unknown as ItemRow[];

      const claims: Claim[] = [];
      for (const row of rows) {
        const used = (this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE item_id = ? AND version = ?').get(row.id, row.version) as unknown as { n: number }).n;
        if (used >= input.maxAttempts) {
          // The attempt budget (abandoned attempts included) is spent: end the item instead of trying again.
          this.db
            .prepare(
              `UPDATE items SET state = 'failed', terminal_reason = 'retries_exhausted', claim_token = NULL,
                 lease_expires_at = NULL, next_attempt_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(now, now, row.id);
          continue;
        }
        const dueAt = row.state === 'running' ? (row.lease_expires_at as number) : (row.next_attempt_at ?? row.scheduled_at);
        const token = input.newToken();
        const leaseExpiresAt = now + input.leaseMs;
        this.db
          .prepare(`UPDATE items SET state = 'running', claim_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
          .run(token, leaseExpiresAt, now, row.id);
        const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attempts WHERE item_id = ?').get(row.id) as unknown as { n: number }).n;
        const deliveryKey = deliveryKeyOf(row.id, row.version);
        this.db
          .prepare(
            `INSERT INTO attempts (item_id, seq, version, occurrence_attempt, delivery_key, worker_id, due_at, claimed_at, lease_expires_at, outcome)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight')`,
          )
          .run(row.id, seq, row.version, used + 1, deliveryKey, input.workerId, dueAt, now, leaseExpiresAt);
        claims.push({
          itemId: row.id,
          version: row.version,
          token,
          attemptSeq: seq,
          occurrenceAttempt: used + 1,
          deliveryKey,
          workerId: input.workerId,
          dueAt,
          claimedAt: now,
          leaseExpiresAt,
          notification: {
            deliveryKey,
            itemId: row.id,
            version: row.version,
            kind: row.kind,
            content: row.content,
            conversationId: row.conversation_id,
            scheduledAt: row.scheduled_at,
            timeZone: row.time_zone,
          },
        });
      }
      return claims;
    });
  }

  private lossReason(row: ItemRow | undefined, claim: Claim): ClaimLossReason {
    if (!row) return 'superseded';
    if (row.state === 'cancelled') return 'cancelled';
    if (row.version !== claim.version) return 'superseded';
    if (row.state === 'delivered') return 'already_delivered';
    return 'lease_lost';
  }

  private holdsClaim(row: ItemRow | undefined, claim: Claim): row is ItemRow {
    return !!row && row.state === 'running' && row.version === claim.version && row.claim_token === claim.token;
  }

  fence(claim: Claim): FenceResult {
    const row = this.row(claim.itemId);
    return this.holdsClaim(row, claim) ? { valid: true } : { valid: false, reason: this.lossReason(row, claim) };
  }

  completeDelivered(claim: Claim, input: { ack: 'accepted' | 'duplicate'; now: number }): CommitResult {
    return this.transaction((): CommitResult => {
      const row = this.row(claim.itemId);
      if (!this.holdsClaim(row, claim)) return { committed: false, reason: this.lossReason(row, claim) };
      // Order matters: the delivery record first (its PK makes a second delivery of the key impossible),
      // then the state change (its trigger requires the record).
      this.db
        .prepare('INSERT INTO deliveries (delivery_key, item_id, version, delivered_at, attempt_seq) VALUES (?, ?, ?, ?, ?)')
        .run(claim.deliveryKey, claim.itemId, claim.version, input.now, claim.attemptSeq);
      const result = this.db
        .prepare(
          `UPDATE items SET state = 'delivered', claim_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
             finished_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND version = ? AND claim_token = ?`,
        )
        .run(input.now, input.now, claim.itemId, claim.version, claim.token);
      if (result.changes !== 1) throw new Error('delivery commit guard failed');
      this.writeAttemptOutcome(claim.itemId, claim.attemptSeq, input.ack === 'accepted' ? 'delivered' : 'duplicate_acknowledged', null, input.now);
      return { committed: true };
    });
  }

  markRetry(claim: Claim, input: { retryAt: number; detail: string; now: number }): boolean {
    return this.transaction(() => {
      this.writeAttemptOutcome(claim.itemId, claim.attemptSeq, 'temporary_failure', input.detail, input.now);
      if (!this.holdsClaim(this.row(claim.itemId), claim)) return false;
      const result = this.db
        .prepare(
          `UPDATE items SET state = 'scheduled', next_attempt_at = ?, claim_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'running' AND version = ? AND claim_token = ?`,
        )
        .run(input.retryAt, input.now, claim.itemId, claim.version, claim.token);
      return result.changes === 1;
    });
  }

  markFailed(claim: Claim, input: { reason: 'retries_exhausted' | 'permanent_failure'; outcome: AttemptOutcome; detail: string; now: number }): boolean {
    return this.transaction(() => {
      this.writeAttemptOutcome(claim.itemId, claim.attemptSeq, input.outcome, input.detail, input.now);
      if (!this.holdsClaim(this.row(claim.itemId), claim)) return false;
      const result = this.db
        .prepare(
          `UPDATE items SET state = 'failed', terminal_reason = ?, claim_token = NULL, lease_expires_at = NULL,
             next_attempt_at = NULL, finished_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND version = ? AND claim_token = ?`,
        )
        .run(input.reason, input.now, input.now, claim.itemId, claim.version, claim.token);
      return result.changes === 1;
    });
  }

  finishAttempt(itemId: string, attemptSeq: number, outcome: AttemptOutcome, detail: string | null, now: number): void {
    this.transaction(() => this.writeAttemptOutcome(itemId, attemptSeq, outcome, detail, now));
  }

  /** A worker that turns out to be slow (attempt already marked abandoned) may still record what really happened. */
  private writeAttemptOutcome(itemId: string, seq: number, outcome: AttemptOutcome, detail: string | null, now: number): void {
    this.db
      .prepare(`UPDATE attempts SET outcome = ?, detail = ?, finished_at = ? WHERE item_id = ? AND seq = ? AND outcome IN ('in_flight','abandoned')`)
      .run(outcome, detail, now, itemId, seq);
  }

  // ------------------------------------------------------------------ misc

  nextWakeTime(): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(t) AS t FROM (
           SELECT COALESCE(next_attempt_at, scheduled_at) AS t FROM items WHERE state = 'scheduled'
           UNION ALL
           SELECT lease_expires_at AS t FROM items WHERE state = 'running'
         )`,
      )
      .get() as unknown as { t: number | null };
    return row.t ?? undefined;
  }

  counts(): Record<ItemState, number> {
    const counts = Object.fromEntries(ITEM_STATES.map((s) => [s, 0])) as Record<ItemState, number>;
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all() as unknown as Array<{ state: ItemState; n: number }>;
    for (const { state, n } of rows) counts[state] = n;
    return counts;
  }

  close(): void {
    this.db.close();
  }
}
