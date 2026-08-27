# Sidewalk (server)

Express + SQLite. Run everything from the repo root — there is one `package.json`.

```bash
npm install
npm run seed     # one time, loads sampleData.json into a fresh sidewalk.db
npm run server   # http://localhost:3000
```

## Boot is non-destructive

`server/db.ts` owns the schema. Starting the server only ever creates what is
missing (`CREATE TABLE IF NOT EXISTS`, plus an `ALTER TABLE` for the `lat`/`lon`
columns on databases created before they existed). It never drops a table and
never seeds.

That split matters because `scripts/refresh.ts` — the discovery pipeline, not built
yet — will append discovered events to this same file. Anything it writes has to
survive a restart, which the old drop-and-reseed boot would not have allowed.

## Seeding

`npm run seed` loads `server/sampleData.json`. It is safe to run repeatedly:
`events.url` is UNIQUE, so a second run inserts nothing and says so rather than
duplicating rows. It also fills in `lat`/`lon` on seed rows that don't have them
yet, which is what upgrades a database seeded before the coordinates were
backfilled. It only ever writes into `NULL` columns, so once `refresh.ts` lands it
cannot overwrite a coordinate that discovery resolved.

Point it at a scratch database with `SIDEWALK_DB=/tmp/whatever.db` if you want to
try something without touching your real one.

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
```

`time` is an ISO 8601 interval, `start/end` — not an instant. Every filter, sort,
and display path splits on `/` and takes `[0]`.

An event can carry several types (`"fitness,outdoor fitness"` becomes two rows in
`event_types` and two in `event_tags`), which is what the join table is for.
