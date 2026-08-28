import data from './data.json' with { type: 'json' };
import { countEvents, openDatabase } from './db.js';
import type { DataFileEvent } from './dataFile.js';

const db = openDatabase();

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (title, time, url, location, lat, lon)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const selectEventIdByUrl = db.prepare('SELECT id FROM events WHERE url = ?');

// Only ever fills in blanks. A database seeded before the coordinates were
// backfilled (spec.md Decision 4) already has these rows by url, so without this
// the new lat/lon would never reach it — and every seed event would show up
// pinless. Guarded on IS NULL so it can never overwrite what refresh.ts wrote.
const backfillCoordinates = db.prepare(`
  UPDATE events SET lat = ?, lon = ?
  WHERE url = ? AND lat IS NULL AND lon IS NULL
`);

const insertEventType = db.prepare('INSERT OR IGNORE INTO event_types (name) VALUES (?)');

const selectEventTypeIdByName = db.prepare('SELECT id FROM event_types WHERE name = ?');

const insertEventTag = db.prepare(
  'INSERT OR IGNORE INTO event_tags (event_id, event_type_id) VALUES (?, ?)'
);

/**
 * `events.url` is UNIQUE, so a second run inserts nothing rather than duplicating
 * the rows, and reports how many it skipped instead of doing it silently.
 *
 * `data.json` grows: `refresh.ts` and `/api/plan` both append what they find to it
 * (see `ingest.ts`'s `retainEvents`), so re-running the seed after a refresh is how a
 * database that was rebuilt from scratch catches up with everything discovered since.
 */
const seed = db.transaction((events: DataFileEvent[]) => {
  let inserted = 0;
  let skipped = 0;
  let backfilled = 0;

  for (const event of events) {
    const result = insertEvent.run(
      event.title,
      event.time,
      event.url,
      event.location,
      event.lat ?? null,
      event.lon ?? null
    );

    // lastInsertRowid is meaningless when the insert was ignored, so read the id
    // back by url — correct whether the row is new or was already there.
    const row = selectEventIdByUrl.get(event.url) as { id: number } | undefined;

    // OR IGNORE suppresses every constraint class, not just the UNIQUE url we are
    // relying on. If the row is absent afterwards the insert failed for some other
    // reason — a NOT NULL violation from a malformed seed entry — and staying quiet
    // about it would report a broken seed as a successful one.
    if (!row) {
      throw new Error(
        `Could not store seed event ${JSON.stringify(event.url)} (${event.title}). ` +
          'Check that title, time, url, and location are all present in data.json.'
      );
    }

    if (result.changes > 0) {
      inserted += 1;
    } else {
      skipped += 1;

      if (event.lat !== undefined && event.lon !== undefined) {
        backfilled += backfillCoordinates.run(event.lat, event.lon, event.url).changes;
      }
    }

    // An event can carry several types ("fitness,outdoor fitness"), which is what
    // the event_tags join table exists for.
    for (const type of event.event_type.split(',')) {
      const name = type.trim();
      if (!name) continue;

      insertEventType.run(name);
      const typeRow = selectEventTypeIdByName.get(name) as { id: number } | undefined;
      if (typeRow) insertEventTag.run(row.id, typeRow.id);
    }
  }

  return { inserted, skipped, backfilled };
});

const { inserted, skipped, backfilled } = seed(data as DataFileEvent[]);

console.log(`Seed complete: ${inserted} new event(s), ${skipped} already present.`);
if (backfilled > 0) console.log(`Filled in coordinates for ${backfilled} existing event(s).`);
console.log(`${countEvents(db)} event(s) in the database.`);

db.close();
