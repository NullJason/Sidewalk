import 'dotenv/config';

import { countEvents, openDatabase } from '../server/db.js';
import { CITY, parseDiscoveries } from '../server/discovery.js';
import { normalizeDiscoveries, searchForEvents } from '../server/gemini.js';
import { retainEvents } from '../server/ingest.js';
import { setLastCheckedAt } from '../server/metadata.js';
import { weekendWindow } from '../server/weekend.js';

/**
 * The discovery pipeline, run by hand: `npm run refresh`.
 *
 * Two Gemini calls — search, then normalize — and an append-only write into the same
 * SQLite file the server reads. Nothing about this runs on a request; `/api/plan` only
 * ever ranks rows that a run of this script already put in the database.
 *
 * It is safe to run twice. The second run finds the same events and stores none of them.
 */
async function refresh(): Promise<void> {
  const weekend = weekendWindow(new Date());

  console.log(
    `Searching for ${CITY} events on Saturday ${weekend.saturday} and Sunday ${weekend.sunday}...`
  );
  const prose = await searchForEvents(weekend);

  console.log('Normalizing what came back...');
  const text = await normalizeDiscoveries(prose, weekend);

  const { events, dropped } = parseDiscoveries(text, weekend);

  // Worth printing even when it is all zeros: a run that finds twenty events and drops
  // eighteen looks identical to a quiet one from the row count alone.
  console.log(
    `${events.length} event(s) usable. Dropped ${dropped.noUrl} with no citation, ` +
      `${dropped.outsideWindow} outside the weekend, ${dropped.duplicate} already seen, ` +
      `${dropped.malformed} malformed.`
  );

  const db = openDatabase();

  try {
    const { inserted, duplicates, appended } = retainEvents(db, events);

    console.log(`Stored ${inserted} new event(s); ${duplicates} already in the database.`);
    console.log(`Appended ${appended} event(s) to server/data.json — commit it to keep them.`);

    // Last, and only on the way out: this is the timestamp /api/events shows, so it has
    // to mean "a run got all the way here", not "a run was attempted". A refresh that
    // threw on the way past leaves the old one standing, which is the honest answer.
    const at = setLastCheckedAt(db);

    console.log(`${countEvents(db)} event(s) in the database. Last checked ${at}.`);
  } finally {
    db.close();
  }
}

await refresh().catch((error: unknown) => {
  // A failed refresh changes nothing — the database is written in one transaction at
  // the end — so the fix is to read the message and run it again.
  console.error('Refresh failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
