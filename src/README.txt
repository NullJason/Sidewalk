# Sidewalk frontend

Two-page Vite + TypeScript frontend for the Sidewalk weekend planner.

## Run

```bash
npm install
npm run dev
```

Then open the Vite development URL.

## Gemini integration

The frontend intentionally calls `POST /api/plan` instead of embedding a Gemini API key in browser code.

Request:

```json
{
  "model": "gemini-2.5-flash",
  "prompt": "…",
  "responseMimeType": "application/json",
  "responseSchema": {
    "...": "see PLAN_SCHEMA in src/main.ts"
  }
}
```

The endpoint should:
1. Authenticate/authorize the user if needed.
2. Call Gemini using a server-side secret.
3. Force structured JSON using the supplied schema.
4. Return `{ "events": [...] }` or `{ "data": { "events": [...] } }`.

## Database

The app supports Supabase through:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

`supabase-schema.sql` contains the base tables.

The browser never receives a Gemini secret. Supabase's browser key must still be protected with Row Level Security.

## Demo fallback

`public/demo-events.csv` is loaded when Gemini returns an error/empty plan. Because no sample CSV was available in the supplied files, this project includes a compatible demonstration CSV.

## Geocoding / map

The mapper uses Leaflet + OpenStreetMap tiles. Event locations are geocoded only when the user clicks "Reveal on map", then cached in `localStorage` for that browser session.
