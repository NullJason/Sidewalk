import type Database from 'better-sqlite3';

import { dedupeKey, type DiscoveredEvent } from './discovery.js';

export interface IngestResult {
  inserted: number;
  duplicates: number;
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
  events: DiscoveredEvent[]
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

  const store = db.transaction((batch: DiscoveredEvent[]) => {
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
        event.lat,
        event.lon
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
