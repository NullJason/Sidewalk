import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';

import { getLastCheckedAt, setLastCheckedAt } from './metadata.js';

// The real table, from db.ts. Copied rather than imported because openDatabase()
// opens a file on disk, and these tests must not touch the repo's sidewalk.db.
function emptyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

describe('lastCheckedAt', () => {
  it('is null until a refresh run has completed once', () => {
    assert.equal(getLastCheckedAt(emptyDatabase()), null);
  });

  it('reads back what was written, as an ISO instant', () => {
    const db = emptyDatabase();
    const at = setLastCheckedAt(db, new Date('2026-08-27T18:30:00Z'));

    assert.equal(at, '2026-08-27T18:30:00.000Z');
    assert.equal(getLastCheckedAt(db), at);
  });

  it('replaces the old timestamp instead of adding a second row', () => {
    const db = emptyDatabase();

    setLastCheckedAt(db, new Date('2026-08-27T18:30:00Z'));
    setLastCheckedAt(db, new Date('2026-08-28T09:00:00Z'));

    assert.equal(getLastCheckedAt(db), '2026-08-28T09:00:00.000Z');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM metadata').get() as { n: number }).n, 1);
  });
});
