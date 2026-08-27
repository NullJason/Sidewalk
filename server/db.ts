import Database from 'better-sqlite3';

export const DEFAULT_DB_PATH = 'sidewalk.db';

/**
 * Opens the database and brings its schema up to date.
 *
 * Boot is non-destructive: it only ever creates what is missing. `refresh.ts`
 * appends discovered events to this same file, so dropping tables on startup
 * would throw away every discovery on the next restart.
 */
export function openDatabase(): Database.Database {
  const db = new Database(process.env.SIDEWALK_DB ?? DEFAULT_DB_PATH);
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      time TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      location TEXT NOT NULL,
      lat REAL,
      lon REAL
    );

    CREATE TABLE IF NOT EXISTS event_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS event_tags (
      event_id INTEGER NOT NULL,
      event_type_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, event_type_id),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE CASCADE
    );
  `);

  // lat/lon arrived after the first version of this schema (spec.md Decision 2).
  // A database created before then already has an `events` table, so CREATE TABLE
  // IF NOT EXISTS will not add the columns and every read of them would fail.
  const columns = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has('lat')) db.exec('ALTER TABLE events ADD COLUMN lat REAL');
  if (!existing.has('lon')) db.exec('ALTER TABLE events ADD COLUMN lon REAL');
}

export function countEvents(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
  return row.count;
}
