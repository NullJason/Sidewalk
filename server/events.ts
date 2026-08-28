import type Database from 'better-sqlite3';

import { isInWindow, type WeekendWindow } from './weekend.js';

/**
 * An event as it leaves the database, matching the client-facing shape in
 * `src/main.ts` minus `description`/`why` — those are written fresh by Gemini on
 * `/api/plan` and are never stored.
 *
 * `lat`/`lon` are nullable in the schema (spec.md Decision 2), so they come back
 * as `null` rather than absent. `toEventItem` drops them instead of shipping
 * nulls the client would have to special-case.
 */
interface EventRow {
  id: number;
  title: string;
  time: string;
  url: string;
  location: string;
  lat: number | null;
  lon: number | null;
  event_type: string;
}

export interface StoredEvent {
  id: number;
  title: string;
  time: string; // ISO 8601 interval, "start/end"
  url: string;
  location: string;
  event_type: string; // comma-joined when an event has several
  lat?: number;
  lon?: number;
}

/**
 * Every read of an event needs the same columns and the same type join, so the shape
 * is written once and each query supplies only what makes it different.
 */
const selectEvents = (clauses: string): string => `
  SELECT
    e.id, e.title, e.time, e.url, e.location, e.lat, e.lon,
    COALESCE(GROUP_CONCAT(types.name, ','), '') AS event_type
  FROM events AS e
  LEFT JOIN event_tags AS tags ON tags.event_id = e.id
  LEFT JOIN event_types AS types ON types.id = tags.event_type_id
  ${clauses}
`;

/**
 * The random pick happens in the subquery, over `events` alone. Selecting at the
 * top level instead would shuffle the *joined* rows, so an event with three types
 * would be three times as likely to come up as one with a single type.
 *
 * `excludeCount` widens the statement rather than the values: the ids arrive from a
 * query string, so they go in as placeholders and only their *number* is allowed to
 * shape the SQL.
 */
const randomEventsSql = (excludeCount: number): string => {
  const holes = new Array(excludeCount).fill('?').join(', ');

  return selectEvents(`
    WHERE e.id IN (
      SELECT id FROM events
      ${excludeCount ? `WHERE id NOT IN (${holes})` : ''}
      ORDER BY RANDOM() LIMIT ?
    )
    GROUP BY e.id
  `);
};

/**
 * A deliberately loose pre-filter, padded by a day at each end.
 *
 * `time` is an ISO interval, so comparing the whole stored string against a bound
 * only works while every row is fixed-width UTC (`...Z`) — and a row written with a
 * numeric offset, or with milliseconds, sorts differently. Since `isInWindow` is
 * applied afterwards it can only ever narrow this result, so a tight bound here
 * would silently drop events that genuinely are in the window, with no second chance
 * to rescue them.
 *
 * Padding wider than any real offset makes that impossible: the SQL is a cheap way to
 * avoid reading the whole table, and `isInWindow` alone decides what is in.
 */
const WEEKEND_EVENTS_SQL = selectEvents(`
  WHERE e.time >= ? AND e.time < ?
  GROUP BY e.id
  ORDER BY e.time ASC
`);

/**
 * Everything stored, in start order. No window and no limit: this backs `/api/events`,
 * whose job is to say what the database actually holds — including the past weekends
 * that `selectWeekendCandidates` exists to keep away from Gemini.
 */
const ALL_EVENTS_SQL = selectEvents(`
  GROUP BY e.id
  ORDER BY e.time ASC
`);

/** Comfortably more than the largest real UTC offset (14 hours). */
const PRE_FILTER_PADDING_MS = 24 * 60 * 60 * 1000;

function shiftIso(iso: string, deltaMs: number): string {
  return `${new Date(Date.parse(iso) + deltaMs).toISOString().slice(0, 19)}Z`;
}

function toEventItem(row: EventRow): StoredEvent {
  const event: StoredEvent = {
    id: row.id,
    title: row.title,
    time: row.time,
    url: row.url,
    location: row.location,
    event_type: row.event_type
  };

  // Both or neither: a half-resolved coordinate cannot be pinned, and the client
  // treats "has lat and lon" as the one test for whether a map button appears.
  if (row.lat !== null && row.lon !== null) {
    event.lat = row.lat;
    event.lon = row.lon;
  }

  return event;
}

function pickRandom(
  db: Database.Database,
  limit: number,
  exclude: number[]
): StoredEvent[] {
  const rows = db.prepare(randomEventsSql(exclude.length)).all(...exclude, limit) as EventRow[];
  return rows.map(toEventItem);
}

/**
 * Returns up to `limit` random stored events, preferring ones not in `exclude`.
 *
 * `exclude` is what the client already has on screen, so that pressing "Surprise me"
 * a second time moves on rather than re-serving the same pick. It is a preference and
 * not a filter: once fewer than `limit` unseen events are left, the remainder is
 * topped up from the excluded ones instead of returning a short set. Running out of
 * new events is the honest end of the sequence, but handing back one card where there
 * were three reads as a bug rather than as an ending.
 *
 * Fewer than `limit` still comes back when the database genuinely holds fewer, and an
 * empty array on an unseeded one — callers render what they get.
 */
export function selectRandomEvents(
  db: Database.Database,
  limit: number,
  exclude: number[] = []
): StoredEvent[] {
  const picked = pickRandom(db, limit, exclude);
  if (picked.length >= limit || !exclude.length) return picked;

  // Top up from everything except what this call has already chosen, which is what
  // keeps a wrapped-around set free of duplicates within itself.
  const topUp = pickRandom(db, limit - picked.length, picked.map((event) => event.id));

  return [...picked, ...topUp];
}

/**
 * Candidates for `/api/plan`: stored events inside this weekend, ordered by start so
 * the model is shown them in the order a day actually runs.
 *
 * Stale rows from past weekends must never reach Gemini as candidates, and that is
 * `isInWindow`'s call, made on a parsed instant — the SQL above only trims the table
 * down to a range around the weekend.
 */
export function selectWeekendCandidates(
  db: Database.Database,
  weekend: WeekendWindow
): StoredEvent[] {
  const rows = db
    .prepare(WEEKEND_EVENTS_SQL)
    .all(
      shiftIso(weekend.startIso, -PRE_FILTER_PADDING_MS),
      shiftIso(weekend.endIso, PRE_FILTER_PADDING_MS)
    ) as EventRow[];

  return rows.map(toEventItem).filter((event) => isInWindow(event.time, weekend));
}

/** Every stored event, oldest first. An empty database answers with an empty list. */
export function selectAllEvents(db: Database.Database): StoredEvent[] {
  const rows = db.prepare(ALL_EVENTS_SQL).all() as EventRow[];
  return rows.map(toEventItem);
}
