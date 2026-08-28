import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dedupeKey } from './discovery.js';

/**
 * An event as it is written to `server/data.json`, which is the shape `seed.ts` reads.
 *
 * No `id`: those are assigned by SQLite and differ between databases, so carrying one
 * here would only be a number that happens to be right on the machine that wrote it.
 * `lat`/`lon` are omitted rather than written as null, matching the file as authored.
 */
export interface DataFileEvent {
  title: string;
  time: string; // ISO 8601 interval, "start/end"
  url: string;
  location: string;
  event_type: string; // comma-joined when an event has several
  lat?: number;
  lon?: number;
}

/**
 * An event as any path can hand it over to be kept: the fields a row is made of, and
 * either spelling of "no coordinates" — `null` from discovery, absent from a stored row.
 * Anything else the caller is carrying (`id`, `description`, `why`) is ignored.
 */
export interface StorableEvent {
  title: string;
  time: string;
  url: string;
  location: string;
  event_type: string;
  lat?: number | null;
  lon?: number | null;
}

export interface AppendResult {
  appended: number;
  skipped: number;
}

/**
 * Overridable the same way `SIDEWALK_DB` overrides the database, and for the same
 * reason: trying something out should not mean appending to the list the repo commits.
 */
export const DATA_FILE_PATH =
  process.env.SIDEWALK_DATA ?? fileURLToPath(new URL('./data.json', import.meta.url));

/** Strips everything that is not part of the file's shape — `id`, `description`, `why`. */
function toDataFileEvent(event: StorableEvent): DataFileEvent {
  const stored: DataFileEvent = {
    title: event.title,
    time: event.time,
    url: event.url,
    location: event.location,
    event_type: event.event_type
  };

  // Both or neither, the same rule the rest of the system uses: a half-resolved
  // coordinate cannot be pinned, so writing one half would only mislead a later read.
  if (typeof event.lat === 'number' && typeof event.lon === 'number') {
    stored.lat = event.lat;
    stored.lon = event.lon;
  }

  return stored;
}

/**
 * Adds what is new to the end of the list, in order, and leaves everything already
 * there exactly as it is.
 *
 * Deduped the same two ways `ingest.ts` dedupes against SQLite — on url, and on
 * `dedupeKey`'s title+date — so the file and the database agree about what counts as
 * the same event. They have to: the file is what seeds the database.
 *
 * Pure, and separate from the write, because this is the part worth testing.
 */
export function mergeEvents(
  existing: DataFileEvent[],
  incoming: StorableEvent[]
): { merged: DataFileEvent[]; appended: number; skipped: number } {
  const keys = new Set(existing.map(dedupeKey));
  const urls = new Set(existing.map((event) => event.url));

  const merged = [...existing];
  let appended = 0;
  let skipped = 0;

  for (const event of incoming) {
    const key = dedupeKey(event);

    if (keys.has(key) || urls.has(event.url)) {
      skipped += 1;
      continue;
    }

    keys.add(key);
    urls.add(event.url);
    merged.push(toDataFileEvent(event));
    appended += 1;
  }

  return { merged, appended, skipped };
}

/**
 * Reads the list. A missing file is an empty list; an unreadable one throws.
 *
 * That difference matters. `data.json` is the only copy of this data that git tracks —
 * `sidewalk.db` is ignored — so treating a half-written or hand-broken file as empty
 * would quietly replace every event we have ever found with whatever is in hand.
 */
export function readDataFile(path: string = DATA_FILE_PATH): DataFileEvent[] {
  if (!existsSync(path)) return [];

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON array of events.`);
  }

  return parsed as DataFileEvent[];
}

/**
 * Appends events to `data.json`, the list that outlives the database.
 *
 * `sidewalk.db` is gitignored and disposable; this file is committed, so an event only
 * really joins the collection once it lands here. Every path that stores an event
 * mirrors it in, which is what makes the pool grow run over run — a bigger Surprise Me
 * on a fresh clone, and less that a future refresh has to go and find again.
 *
 * Written through a temp file and a rename so an interrupted write cannot leave the
 * committed list truncated. The read-modify-write is synchronous on purpose: Node runs
 * one request at a time, so two overlapping `/api/plan` calls cannot interleave here.
 */
export function appendToDataFile(
  events: StorableEvent[],
  path: string = DATA_FILE_PATH
): AppendResult {
  const { merged, appended, skipped } = mergeEvents(readDataFile(path), events);

  if (appended > 0) {
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  }

  return { appended, skipped };
}
