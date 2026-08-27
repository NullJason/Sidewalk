import 'dotenv/config';

import express from 'express';
import { countEvents, openDatabase } from './db.js';
import { selectRandomEvents, selectWeekendCandidates } from './events.js';
import { curatePlan } from './gemini.js';
import { weekendWindow } from './weekend.js';

// Render (and the Vite dev proxy, via its own default) supply the port; 3000 is the
// local default the proxy in vite.config.ts targets.
const PORT = Number(process.env.PORT ?? 3000);

// How many events "Surprise me" hands back. One thing to go do, not a plan —
// planning is what /api/plan is for.
const SURPRISE_COUNT = 1;

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
  const body = (req.body ?? {}) as { prompt?: unknown };
  const vibe = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 1000) : '';

  const weekend = weekendWindow(new Date());
  const candidates = selectWeekendCandidates(db, weekend);

  if (!candidates.length) {
    res.json({ planTitle: 'Nothing on this weekend', stops: [] });
    return;
  }

  try {
    res.json(await curatePlan(vibe, candidates, weekend));
  } catch (error) {
    // Ticket 05 turns this into a fallback plan so the endpoint always answers 200.
    // Until then, failing loudly beats failing silently.
    console.error('Curation failed:', error);
    res.status(500).json({ error: 'Curation failed.' });
  }
});

// Lets the Vite dev proxy be checked end to end before any real /api route exists.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Random stored events, straight from SQLite. No Gemini call, so no `description`
// or `why` — the card renders without them rather than rendering them blank.
// An empty database answers with `[]`, which the client reports as "run the seed".
app.get('/api/surprise', (req, res) => {
  res.json(selectRandomEvents(db, SURPRISE_COUNT));
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
