import type Database from 'better-sqlite3';

/**
 * A one-row-per-fact table for things that are true of the database rather than of any
 * event in it. Only `lastCheckedAt` lives here today.
 */
const LAST_CHECKED_AT = 'lastCheckedAt';

/**
 * When a discovery run last finished — not when the server last booted.
 *
 * That distinction is the whole point of the badge it feeds. "N events · last refreshed
 * <time>" is meant to show that the data is real and recent; a timestamp that moved
 * every time the process restarted would say nothing about the data at all, and would
 * say it convincingly.
 *
 * `null` on a database that has never been refreshed — a fresh seed, most often — which
 * the client renders as "seeded" rather than inventing a time.
 */
export function getLastCheckedAt(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(LAST_CHECKED_AT) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

/** Called by `scripts/refresh.ts` when a run completes, and by nothing else. */
export function setLastCheckedAt(db: Database.Database, at: Date = new Date()): string {
  const iso = at.toISOString();

  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
    LAST_CHECKED_AT,
    iso
  );

  return iso;
}
