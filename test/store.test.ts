import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore, loadSqlite } from '../src';
import { at, claimNow, closeAll, makeSystem, removeDir, track } from './helpers';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reminders-guard-'));
  path = join(dir, 'reminders.db');
});
afterEach(() => {
  closeAll();
  removeDir(dir);
});

/** A second, raw connection: tries to break the rules the way a buggy or rogue writer might. */
const rawConnection = () => track(new (loadSqlite().DatabaseSync)(path));

describe('schema guards (defence in depth behind the application rules)', () => {
  const DUE = at('2026-03-01T10:00:00Z');
  const seed = () => {
    const sys = makeSystem({ store: track(new SqliteStore(path)) });
    sys.service.create({ id: 'r', content: 'x', timeZone: 'UTC', at: '2026-03-01T10:00:00Z' });
    return sys;
  };

  it('an item cannot become delivered without a delivery record for its current occurrence', () => {
    const sys = seed();
    claimNow(sys.store, DUE);
    const raw = rawConnection();
    expect(() => raw.exec(`UPDATE items SET state = 'delivered' WHERE id = 'r'`)).toThrow(/delivery record/);
    expect(sys.store.getItem('r')?.state).toBe('running');
  });

  it('a delivery record cannot be created for a scheduled, cancelled or edited item', () => {
    const sys = seed();
    const raw = rawConnection();
    const insert = (version: number) => `INSERT INTO deliveries VALUES ('r:v${version}', 'r', ${version}, 0, 1)`;
    expect(() => raw.exec(insert(1))).toThrow(/running item/); // scheduled
    claimNow(sys.store, DUE);
    expect(() => raw.exec(insert(2))).toThrow(/same version/); // wrong version
    sys.service.cancel('r');
    expect(() => raw.exec(insert(1))).toThrow(/running item/); // cancelled
  });

  it('terminal items are immutable', () => {
    const sys = seed();
    sys.service.cancel('r');
    const raw = rawConnection();
    expect(() => raw.exec(`UPDATE items SET state = 'scheduled' WHERE id = 'r'`)).toThrow(/immutable/);
    expect(() => raw.exec(`UPDATE items SET content = 'tampered' WHERE id = 'r'`)).toThrow(/immutable/);
  });

  it('there can be only one delivery record per delivery key', () => {
    const sys = seed();
    const [claim] = claimNow(sys.store, DUE);
    sys.store.completeDelivered(claim!, { ack: 'accepted', now: DUE });
    const raw = rawConnection();
    expect(() => raw.exec(`INSERT INTO deliveries VALUES ('r:v1', 'r', 1, 0, 1)`)).toThrow();
  });

  it('two connections cannot both claim the same item', () => {
    const sys = seed();
    const other = track(new SqliteStore(path));
    const a = claimNow(sys.store, DUE, 'a');
    const b = claimNow(other, DUE, 'b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    other.close();
  });
});
