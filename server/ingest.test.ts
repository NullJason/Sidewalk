import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { DataFileEvent } from './dataFile.js';
import type { DiscoveredEvent } from './discovery.js';
import { selectWeekendCandidates } from './events.js';
import { retainEvents, storeDiscoveredEvents } from './ingest.js';
import type { PlanStop } from './plan.js';
import { weekendWindow } from './weekend.js';

// Thu 2026-08-27 in New York, so the weekend is Sat 2026-08-29 / Sun 2026-08-30.
const weekend = weekendWindow(new Date('2026-08-27T18:00:00Z'));

const discovered = (overrides: Partial<DiscoveredEvent> = {}): DiscoveredEvent => ({
  title: 'Bryant Park Picnic Performance',
  time: '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z',
  url: 'https://www.nycgovparks.org/events/bryant-park',
  location: 'Bryant Park Lawn, Manhattan',
  event_type: 'concert',
  lat: 40.7536,
  lon: -73.9832,
  ...overrides
});

// The real schema, from db.ts. Copied rather than imported because openDatabase()
// opens a file on disk, and these tests must not touch the repo's sidewalk.db.
function emptyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, time TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
      location TEXT NOT NULL, lat REAL, lon REAL
    );
    CREATE TABLE event_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE event_tags (
      event_id INTEGER NOT NULL, event_type_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, event_type_id),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE CASCADE
    );
  `);

  return db;
}

const rows = (db: Database.Database) =>
  db.prepare('SELECT id, title, time, url, lat, lon FROM events ORDER BY id').all() as Array<{
    id: number;
    title: string;
    time: string;
    url: string;
    lat: number | null;
    lon: number | null;
  }>;

describe('storeDiscoveredEvents', () => {
  it('writes an event, its types, and the tags joining them', () => {
    const db = emptyDatabase();
    const result = storeDiscoveredEvents(db, [
      discovered({ event_type: 'fitness,outdoor fitness' })
    ]);

    assert.equal(result.inserted, 1);
    assert.equal(result.duplicates, 0);

    const [stored] = selectWeekendCandidates(db, weekend);
    assert.equal(stored?.title, 'Bryant Park Picnic Performance');
    assert.equal(stored?.event_type, 'fitness,outdoor fitness');
    assert.equal(stored?.lat, 40.7536);
  });

  it('stores an event with no coordinates rather than dropping it', () => {
    const db = emptyDatabase();
    storeDiscoveredEvents(db, [discovered({ lat: null, lon: null })]);

    const [stored] = rows(db);
    assert.equal(stored?.lat, null);
    assert.equal(stored?.lon, null);
    assert.equal(selectWeekendCandidates(db, weekend).length, 1);
  });

  it('adds nothing on a second run of the same events', () => {
    const db = emptyDatabase();
    const events = [discovered(), discovered({ title: 'Birding Tour', url: 'https://x/birding' })];

    storeDiscoveredEvents(db, events);
    const second = storeDiscoveredEvents(db, events);

    assert.equal(second.inserted, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(rows(db).length, 2);
  });

  it('recognises an event it already holds under a different url', () => {
    const db = emptyDatabase();
    storeDiscoveredEvents(db, [discovered()]);

    // Same night, same event, found on the venue's own site this time.
    const second = storeDiscoveredEvents(db, [
      discovered({ url: 'https://bryantpark.org/picnic', title: 'bryant park picnic performance' })
    ]);

    assert.equal(second.inserted, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(rows(db).length, 1);
  });

  it('stores the same event again when it runs on a different day', () => {
    const db = emptyDatabase();
    storeDiscoveredEvents(db, [discovered()]);

    const second = storeDiscoveredEvents(db, [
      discovered({
        time: '2026-08-30T21:00:00Z/2026-08-30T22:00:00Z',
        url: 'https://www.nycgovparks.org/events/bryant-park-sunday'
      })
    ]);

    assert.equal(second.inserted, 1);
    assert.equal(rows(db).length, 2);
  });

  it('leaves rows that were already there exactly as they were', () => {
    const db = emptyDatabase();
    db.prepare(
      'INSERT INTO events (title, time, url, location, lat, lon) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('Seeded Event', '2026-08-29T15:00:00Z', 'https://seed/1', 'Queens', null, null);

    storeDiscoveredEvents(db, [discovered()]);

    const [seeded] = rows(db);
    assert.deepEqual(seeded, {
      id: 1,
      title: 'Seeded Event',
      time: '2026-08-29T15:00:00Z',
      url: 'https://seed/1',
      lat: null,
      lon: null
    });
    assert.equal(rows(db).length, 2);
  });

  it('reuses an event type that another event already introduced', () => {
    const db = emptyDatabase();
    storeDiscoveredEvents(db, [
      discovered(),
      discovered({ title: 'Another Concert', url: 'https://x/another', event_type: 'concert' })
    ]);

    const types = db.prepare('SELECT name FROM event_types').all() as Array<{ name: string }>;
    assert.deepEqual(types, [{ name: 'concert' }]);
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM event_tags').get(), { n: 2 });
  });

  it('stores an event that arrived with no type at all', () => {
    const db = emptyDatabase();
    storeDiscoveredEvents(db, [discovered({ event_type: '' })]);

    const [stored] = selectWeekendCandidates(db, weekend);
    assert.equal(stored?.event_type, '');
  });

  it('writes nothing at all when the run found nothing', () => {
    const db = emptyDatabase();
    const result = storeDiscoveredEvents(db, []);

    assert.deepEqual(result, { inserted: 0, duplicates: 0 });
    assert.equal(rows(db).length, 0);
  });
});

describe('retainEvents', () => {
  // Never the repo's own server/data.json: these tests append, and the real file is the
  // only copy of the events that git tracks.
  const scratchPath = (): string => join(mkdtempSync(join(tmpdir(), 'sidewalk-')), 'data.json');
  const read = (path: string): DataFileEvent[] => JSON.parse(readFileSync(path, 'utf8'));

  it('writes an event to SQLite and to data.json in one call', () => {
    const db = emptyDatabase();
    const path = scratchPath();

    const result = retainEvents(db, [discovered()], path);

    assert.deepEqual(result, { inserted: 1, duplicates: 0, appended: 1 });
    assert.equal(rows(db).length, 1);
    assert.equal(read(path)[0]?.url, discovered().url);
  });

  it('mirrors rows an earlier run left stranded in the database', () => {
    // The case this exists for: 31 events had been discovered into a gitignored
    // sidewalk.db before anything mirrored, and no later run would have rescued them
    // if the mirror only ever carried the batch in hand.
    const db = emptyDatabase();
    const path = scratchPath();

    storeDiscoveredEvents(db, [discovered({ title: 'Stranded', url: 'https://x/stranded' })]);

    const result = retainEvents(db, [discovered()], path);

    assert.equal(result.appended, 2);
    assert.deepEqual(
      read(path).map((event) => event.url).sort(),
      ['https://www.nycgovparks.org/events/bryant-park', 'https://x/stranded']
    );
  });

  it('is safe to run twice — the second call stores and appends nothing', () => {
    const db = emptyDatabase();
    const path = scratchPath();

    retainEvents(db, [discovered()], path);
    const result = retainEvents(db, [discovered()], path);

    assert.deepEqual(result, { inserted: 0, duplicates: 1, appended: 0 });
    assert.equal(read(path).length, 1);
  });

  it('keeps the row from a plan stop and drops the lines Gemini wrote for it', () => {
    const db = emptyDatabase();
    const path = scratchPath();

    // Exactly what /api/plan hands over: a stored row plus the per-response fields,
    // which are never stored (spec.md — description and why are written fresh per call).
    const stop: PlanStop = {
      id: 4,
      title: 'Bryant Park Picnic Performance',
      time: '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z',
      url: 'https://www.nycgovparks.org/events/bryant-park',
      location: 'Bryant Park Lawn, Manhattan',
      event_type: 'concert',
      lat: 40.7536,
      lon: -73.9832,
      description: 'Circus on the lawn.',
      why: 'Free and outdoors.'
    };

    retainEvents(db, [stop], path);

    const [stored] = read(path);
    assert.equal(stored?.title, 'Bryant Park Picnic Performance');
    assert.equal('description' in (stored ?? {}), false);
    assert.equal('why' in (stored ?? {}), false);
    assert.equal('id' in (stored ?? {}), false);
  });
});
