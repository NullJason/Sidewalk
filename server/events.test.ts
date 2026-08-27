import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';

import { selectWeekendCandidates } from './events.js';
import { weekendWindow } from './weekend.js';

// Thu 2026-08-27 in New York, so the weekend is Sat 2026-08-29 / Sun 2026-08-30.
const weekend = weekendWindow(new Date('2026-08-27T18:00:00Z'));

function withEvents(times: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, time TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
      location TEXT NOT NULL, lat REAL, lon REAL
    );
    CREATE TABLE event_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE event_tags (
      event_id INTEGER NOT NULL, event_type_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, event_type_id)
    );
  `);

  const insert = db.prepare(
    'INSERT INTO events (title, time, url, location) VALUES (?, ?, ?, ?)'
  );
  times.forEach((time, index) => insert.run(`Event ${index}`, time, `https://x/${index}`, 'NYC'));

  return db;
}

const urls = (db: Database.Database): string[] =>
  selectWeekendCandidates(db, weekend).map((event) => event.url);

describe('selectWeekendCandidates', () => {
  it('keeps events inside the weekend and drops the ones outside it', () => {
    const db = withEvents([
      '2026-08-22T21:00:00Z/2026-08-22T22:00:00Z', // last weekend
      '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z', // in
      '2026-08-30T15:00:00Z/2026-08-30T17:00:00Z', // in
      '2026-09-05T21:00:00Z/2026-09-05T22:00:00Z' // next weekend
    ]);

    assert.deepEqual(urls(db), ['https://x/1', 'https://x/2']);
  });

  it('drops a Friday-night event (spec.md Decision 5: Saturday-Sunday only)', () => {
    // Fri 2026-08-28, 9pm New York — already Saturday in UTC.
    const db = withEvents(['2026-08-29T01:00:00Z/2026-08-29T03:00:00Z']);

    assert.deepEqual(urls(db), []);
  });

  it('keeps a Sunday-night event whose UTC date has rolled to Monday', () => {
    // Sun 2026-08-30, 11pm New York.
    const db = withEvents(['2026-08-31T03:00:00Z/2026-08-31T04:00:00Z']);

    assert.deepEqual(urls(db), ['https://x/0']);
  });

  it('keeps an in-window event stored with a numeric offset instead of Z', () => {
    // Saturday 00:30 in New York — 04:30Z, comfortably inside the window. As a string
    // it sorts *below* the window's own start bound ("2026-08-29T04:00:00Z"), so a
    // tight SQL comparison drops it before isInWindow can rescue it. refresh.ts writes
    // into this same table and nothing guarantees it normalises to Z.
    const db = withEvents(['2026-08-29T00:30:00-04:00/2026-08-29T02:00:00-04:00']);

    assert.deepEqual(urls(db), ['https://x/0']);
  });

  it('keeps an event sitting exactly on the opening bound', () => {
    // New York midnight, Saturday — inclusive end of the half-open window.
    const db = withEvents(['2026-08-29T04:00:00.000Z/2026-08-29T06:00:00.000Z']);

    assert.deepEqual(urls(db), ['https://x/0']);
  });

  it('drops an event sitting exactly on the closing bound', () => {
    // New York midnight, Monday — exclusive.
    const db = withEvents(['2026-08-31T04:00:00Z/2026-08-31T05:00:00Z']);

    assert.deepEqual(urls(db), []);
  });

  it('orders candidates by start time', () => {
    const db = withEvents([
      '2026-08-30T15:00:00Z/2026-08-30T17:00:00Z',
      '2026-08-29T12:00:00Z/2026-08-29T14:00:00Z',
      '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z'
    ]);

    assert.deepEqual(urls(db), ['https://x/1', 'https://x/2', 'https://x/0']);
  });
});
