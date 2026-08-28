# Sidewalk frontend

Two-page Vite + TypeScript frontend for the Sidewalk weekend planner.

## Run

```bash
npm install     # one install at the repo root covers frontend and server
npm run server  # Express on http://localhost:3000
npm run dev     # Vite; open the URL it prints
```

`vite.config.ts` proxies `/api/*` to the Express server, so the browser stays on
Vite's origin and there is no CORS to configure.

## Talking to the server

The frontend holds no API keys and reads no `VITE_*` variables. It calls two
endpoints, both same-origin through the dev proxy. Neither is implemented on the
server yet — until they are, both buttons report that the server is unreachable:

- `POST /api/plan` with `{ "prompt": "…" }`, answering
  `{ "planTitle": "…", "stops": EventItem[] }`. It always returns 200 with a
  renderable body — the server owns the Gemini key, the prompt, and the
  fallback — so there is no failure branch on this side.
- `GET /api/surprise`, answering stored events straight from SQLite with no
  Gemini call, and therefore no `description` or `why`.

`EventItem` is defined once at the top of `src/main.ts`. Its `time` field is an
ISO 8601 interval, `start/end` — every display path splits on `/` and takes the
start.

## Map

The mapper uses Leaflet + OpenStreetMap tiles. Coordinates are resolved once at
write time and stored on the event row; the browser does no geocoding and keeps
no geocode cache. `lat`/`lon` are optional — an event without them lists
normally, it just has no pin and no "Reveal on map" button.
