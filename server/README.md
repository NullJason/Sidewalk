# Sidewalk (server)

Express + SQLite. Run everything from the repo root — there is one `package.json`.

```bash
npm install
npm run seed     # loads data.json into sidewalk.db; re-run after a refresh
npm run server   # http://localhost:3000
```

## Boot is non-destructive

`server/db.ts` owns the schema. Starting the server only ever creates what is
missing (`CREATE TABLE IF NOT EXISTS`, plus an `ALTER TABLE` for the `lat`/`lon`
columns on databases created before they existed). It never drops a table and
never seeds.

That split matters because `scripts/refresh.ts` — the discovery pipeline — appends
discovered events to this same file. Anything it writes has to survive a restart,
which the old drop-and-reseed boot would not have allowed.

## The two copies: `data.json` and `sidewalk.db`

`server/data.json` is the events list, and it is the copy that lasts. `sidewalk.db`
is gitignored — it belongs to one machine and goes away with a reinstall, a clone,
or a redeploy — so an event only really joins the collection once it is in the file.

The two are kept in step in opposite directions:

- `npm run seed` loads `data.json` into the database.
- `retainEvents` (`server/ingest.ts`) mirrors the database back into `data.json`,
  and both `npm run refresh` and `/api/plan` call it.

The mirror copies the whole table rather than the events in hand, so rows an earlier
run stored before any of this existed get picked up too. Both directions are
append-only and dedupe on url and on title+date, so nothing is ever overwritten and
running either twice does nothing the second time. **`data.json` is tracked — commit
it after a refresh, or the events stay on your laptop.**

Seeding is safe to run repeatedly: `events.url` is UNIQUE, so a second run inserts
nothing and says so rather than duplicating rows. It also fills in `lat`/`lon` on
rows that don't have them yet, which is what upgrades a database seeded before the
coordinates were backfilled. It only ever writes into `NULL` columns, so it cannot
overwrite a coordinate that discovery resolved.

Point either copy somewhere scratch if you want to try something without touching
the real ones: `SIDEWALK_DB=/tmp/whatever.db`, `SIDEWALK_DATA=/tmp/whatever.json`.

## Discovery

`npm run refresh` finds real events for the coming Saturday and Sunday and appends
them. It needs `GEMINI_API_KEY`, makes two calls — a grounded `google_search` one
that writes a prose report, then a tool-less one that turns that into rows — and
takes a couple of minutes.

The prompts and the drop rules live in `server/discovery.ts`, the write in
`server/ingest.ts`; `scripts/refresh.ts` is only the shell that runs them in order.
It drops anything with no citation url and anything outside the weekend, and skips
anything it already holds (matched on title + start date, or on url), so running it
twice in a row stores nothing the second time. It never updates or deletes a row.

Nothing here runs on a request. `/api/plan` only ever ranks rows a refresh already
stored, which is what keeps it fast and keeps "never invent an event" true.

## Endpoints

| | |
|---|---|
| `POST /api/plan` | A vibe in, a 3-stop itinerary out, curated by Gemini from stored rows. Always 200 with a renderable body: a failed curation falls back to random stored events. |
| `GET /api/surprise` | One random stored event. No Gemini call, so no `description`/`why`. |
| `GET /api/events` | Everything stored, plus `lastCheckedAt`. Backs the counter in the header. |
| `GET /api/health` | `{ ok: true }`, for checking the dev proxy. |

`lastCheckedAt` is written by `npm run refresh` when a run *completes*, and by nothing
else — deliberately not on boot. The counter's job is to show that the data is real and
recent, and a timestamp that moved every time the process restarted would say nothing
about the data while looking like it did. It is `null` until the first refresh finishes,
which the frontend renders as "not refreshed yet" rather than inventing a time.

## Schema

```
events                          event_types            event_tags
  id        INTEGER PK            id    INTEGER PK       event_id      INTEGER FK
  title     TEXT NOT NULL         name  TEXT UNIQUE      event_type_id INTEGER FK
  time      TEXT NOT NULL                                PK (event_id, event_type_id)
  url       TEXT NOT NULL UNIQUE
  location  TEXT NOT NULL
  lat       REAL                -- nullable
  lon       REAL                -- nullable

metadata
  key       TEXT PK             -- 'lastCheckedAt' is the only one so far
  value     TEXT NOT NULL
```

`time` is an ISO 8601 interval, `start/end` — not an instant. Every filter, sort,
and display path splits on `/` and takes `[0]`.

An event can carry several types (`"fitness,outdoor fitness"` becomes two rows in
`event_types` and two in `event_tags`), which is what the join table is for.
