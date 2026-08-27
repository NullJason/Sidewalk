import type Database from 'better-sqlite3';

import { appendToDataFile, DATA_FILE_PATH, type StorableEvent } from './dataFile.js';
import { dedupeKey } from './discovery.js';
import { selectAllEvents } from './events.js';

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

export interface RetainResult extends IngestResult {
  appended: number; // rows new to data.json
}

/**
 * Writes discovered events into `events`/`event_types`/`event_tags`.
 *
 * Append-only, and deliberately so: `refresh.ts` runs against the same database the
 * seed and every earlier run wrote to, so anything that updated or deleted here would
 * quietly undo work nobody asked it to touch. An event we already hold is skipped
 * whole — not merged, not re-tagged, not re-coordinated.
 *
 * Duplicates are caught two ways. `url` is UNIQUE, which catches the same page found
 * twice; `dedupeKey` catches the same event found on two different pages, which is the
 * common case when a run turns up both the venue's listing and an aggregator's.
 */
export function storeDiscoveredEvents(
  db: Database.Database,
  events: StorableEvent[]
): IngestResult {
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (title, time, url, location, lat, lon)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const selectEventIdByUrl = db.prepare('SELECT id FROM events WHERE url = ?');
  const insertEventType = db.prepare('INSERT OR IGNORE INTO event_types (name) VALUES (?)');
  const selectEventTypeIdByName = db.prepare('SELECT id FROM event_types WHERE name = ?');
  const insertEventTag = db.prepare(
    'INSERT OR IGNORE INTO event_tags (event_id, event_type_id) VALUES (?, ?)'
  );

  const selectExisting = db.prepare('SELECT title, time, url FROM events');

  const store = db.transaction((batch: StorableEvent[]) => {
    const stored = selectExisting.all() as Array<{ title: string; time: string; url: string }>;

    // Read once and kept up to date as we go, so the run dedupes against itself and
    // against the database through the same set — a second run of an unchanged
    // weekend inserts nothing.
    const keys = new Set(stored.map(dedupeKey));
    const urls = new Set(stored.map((row) => row.url));

    let inserted = 0;
    let duplicates = 0;

    for (const event of batch) {
      const key = dedupeKey(event);

      if (keys.has(key) || urls.has(event.url)) {
        duplicates += 1;
        continue;
      }

      keys.add(key);
      urls.add(event.url);

      const result = insertEvent.run(
        event.title,
        event.time,
        event.url,
        event.location,
        event.lat ?? null,
        event.lon ?? null
      );

      // OR IGNORE suppresses every constraint class, not just the UNIQUE url. If the
      // row is absent afterwards the insert failed for another reason entirely, and
      // reporting that run as a success would hide a broken pipeline.
      const row = selectEventIdByUrl.get(event.url) as { id: number } | undefined;
      if (!row) {
        throw new Error(
          `Could not store discovered event ${JSON.stringify(event.url)} (${event.title}).`
        );
      }

      if (result.changes === 0) {
        duplicates += 1;
        continue;
      }

      inserted += 1;

      // An event can carry several types ("fitness,outdoor fitness"), which is what
      // the event_tags join table exists for.
      for (const name of event.event_type.split(',')) {
        const type = name.trim();
        if (!type) continue;

        insertEventType.run(type);
        const typeRow = selectEventTypeIdByName.get(type) as { id: number } | undefined;
        if (typeRow) insertEventTag.run(row.id, typeRow.id);
      }
    }

    return { inserted, duplicates };
  });

  return store(events);
}

/**
 * Keeps events in both places that outlive a single run: SQLite, and `data.json`.
 *
 * `sidewalk.db` is gitignored, so it is the copy that disappears with a laptop, a
 * teammate's clone, or a redeploy; `data.json` is committed, and seeding a fresh
 * database from it is how the events come back. An event stored in only one of the two
 * either cannot be queried or cannot survive, so every path that decides an event is
 * worth keeping comes through here and writes both.
 *
 * The mirror is of the whole table, not of `events` alone. That is the difference
 * between a file that grows and a file that keeps up: rows a run stored before anything
 * mirrored — and there were thirty-one of them when this was written — would otherwise
 * stay stranded in an ignored database no matter how many times this ran afterwards.
 * Both halves are append-only and dedupe on the same keys, so a call with nothing new
 * in it writes nothing and says so.
 *
 * `dataFilePath` is a seam for the tests, which must not append to the repo's own file.
 */
export function retainEvents(
  db: Database.Database,
  events: StorableEvent[],
  dataFilePath: string = DATA_FILE_PATH
): RetainResult {
  const { inserted, duplicates } = storeDiscoveredEvents(db, events);
  const { appended } = appendToDataFile(selectAllEvents(db), dataFilePath);

  return { inserted, duplicates, appended };
}
