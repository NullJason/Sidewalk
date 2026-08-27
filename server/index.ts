import 'dotenv/config';

import express from 'express';
import { countEvents, openDatabase } from './db.js';
import { selectAllEvents, selectRandomEvents, selectWeekendCandidates } from './events.js';
import { curatePlan } from './gemini.js';
import { retainEvents } from './ingest.js';
import { getLastCheckedAt } from './metadata.js';
import { fallbackPlan, MAX_STOPS, type Plan } from './plan.js';
import { weekendWindow } from './weekend.js';

// Render (and the Vite dev proxy, via its own default) supply the port; 3000 is the
// local default the proxy in vite.config.ts targets.
const PORT = Number(process.env.PORT ?? 3000);

// How many events "Surprise me" hands back. One thing to go do, not a plan —
// planning is what /api/plan is for.
const SURPRISE_COUNT = 3;

// A ceiling on how many ids a client may ask us to skip. The list is a hint about what
// would be boring to return, so it is bounded rather than validated — it only has to be
// long enough to hold a weekend of stored events.
const MAX_EXCLUDE = 200;

/**
 * The ids a client already has on screen, so a repeat press can pick past them.
 *
 * Accepts the query-string form (`?exclude=12,3,40`) and the JSON body form (an array
 * of numbers), because "Surprise me" is a GET and "Plan my weekend" is a POST. Anything
 * that is not a positive integer is dropped rather than rejected: this is a preference,
 * not an instruction the request depends on, so a malformed one costs a repeated event
 * rather than an error the user has to read.
 */
function parseExclude(value: unknown): number[] {
  const parts =
    typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];

  return parts
    .map((part) => Number(typeof part === 'string' ? part.trim() : part))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, MAX_EXCLUDE);
}

const app = express();

// Creates missing tables and columns, and nothing else. Seeding is a separate,
// explicitly-run step: `npm run seed`.
const db = openDatabase();

app.use(express.json({ limit: '16kb' }));

app.get('/', (req, res) => {
  res.send('Hello World');
});

/**
 * The demo path. A loose vibe in, a 3-stop itinerary out, curated by Gemini from rows
 * already in SQLite.
 *
 * The weekend window is computed here, per request, and independently of refresh.ts —
 * the two agree by both following spec.md Decision 5, not by sharing state. Filtering
 * before the model runs is what makes "never invent an event" enforceable: an event
 * from a past weekend is not something Gemini has to be told to avoid, it is simply
 * not in the list it is given.
 */
app.post('/api/plan', async (req, res) => {
  const body = (req.body ?? {}) as { prompt?: unknown; exclude?: unknown };
  const vibe = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 1000) : '';
  const exclude = new Set(parseExclude(body.exclude));

  const weekend = weekendWindow(new Date());
  const weekendEvents = selectWeekendCandidates(db, weekend);

  if (!weekendEvents.length) {
    res.json({ planTitle: 'Nothing on this weekend', stops: [] });
    return;
  }

  // Planning the same vibe again should move the itinerary on rather than re-serve the
  // three stops already on screen, so what the client is showing is withheld from the
  // model. Withheld, not removed: once fewer than a full itinerary is left unseen the
  // whole weekend comes back, because three good stops the user has seen before beat an
  // itinerary one stop long. That reset is also what stops the sequence dead-ending.
  const unseen = weekendEvents.filter((event) => !exclude.has(event.id));
  const candidates = unseen.length >= MAX_STOPS ? unseen : weekendEvents;

  try {
    const plan = await curatePlan(vibe, candidates, weekend);

    res.json(plan);
    keep(plan);
  } catch (error) {
    // This endpoint always answers 200 with a renderable body, so the frontend has no
    // special case for a failed curation — from its side there isn't one. Losing
    // Gemini costs the ordering and the two written lines, not the answer.
    console.error('Curation failed, falling back to random stored events:', error);
    res.json(fallbackPlan(selectRandomEvents(db, MAX_STOPS, [...exclude])));
  }
});

/**
 * Puts the three events Gemini just chose back into the collection.
 *
 * Runs after the response, never before it: this is bookkeeping, and a plan the user is
 * waiting on should not be held up by a file write, nor lost to one that fails.
 *
 * The SQLite half is a no-op by construction — a stop can only ever be a row `/api/plan`
 * read out of SQLite a moment earlier, since that is what makes "never invent an event"
 * enforceable. The `data.json` half is the one that does work: the database is gitignored
 * and disposable, the file is committed, so this is where a refresh run's findings stop
 * living on one machine. `retainEvents` writes a row's own fields only, so the two lines
 * Gemini wrote per stop are dropped here rather than stored — `description` and `why` are
 * per-response, always.
 */
function keep(plan: Plan): void {
  try {
    const { inserted, appended } = retainEvents(db, plan.stops);
    if (inserted || appended) {
      console.log(`Kept ${inserted} new row(s) and ${appended} new data.json entry(s).`);
    }
  } catch (error) {
    console.error('Could not keep the events from this plan:', error);
  }
}

// Lets the Vite dev proxy be checked end to end before any real /api route exists.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Random stored events, straight from SQLite. No Gemini call, so no `description`
// or `why` — the card renders without them rather than rendering them blank.
// An empty database answers with `[]`, which the client reports as "run the seed".
app.get('/api/surprise', (req, res) => {
  res.json(selectRandomEvents(db, SURPRISE_COUNT, parseExclude(req.query.exclude)));
});

/**
 * Everything stored, and when a discovery run last finished.
 *
 * Feeds the "N events - last refreshed <time>" badge, whose job is to make "this data is
 * real and recent" something the demo can show rather than assert. `lastCheckedAt` is
 * `null` until `npm run refresh` completes once; it is deliberately not touched on boot,
 * because a timestamp that moved on every restart would say nothing about the data.
 */
app.get('/api/events', (req, res) => {
  res.json({ events: selectAllEvents(db), lastCheckedAt: getLastCheckedAt(db) });
});

app.listen(PORT, () => {
  const stored = countEvents(db);

  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(
    stored > 0
      ? `${stored} event(s) in the database.`
      : 'No events in the database yet — run `npm run seed`.'
  );
});
