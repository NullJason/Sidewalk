import {
  eventStart,
  isInWindow,
  newYorkDate,
  newYorkInstant,
  type WeekendWindow
} from './weekend.js';

/** Hardcoded, per spec.md. Changing it is a variable's worth of work, and not today's. */
export const CITY = 'New York City';

/**
 * An event as it comes back from the discovery pipeline, on its way into SQLite.
 *
 * `lat`/`lon` are `null` rather than absent, because that is what the columns take
 * and there is nothing else honest to write. A coordinate we could not resolve is
 * missing data; a guessed one is a pin in the wrong place, which reads as a bug.
 */
export interface DiscoveredEvent {
  title: string;
  time: string; // ISO 8601 interval, "start/end", always UTC
  url: string;
  location: string;
  event_type: string; // comma-joined when an event has several
  lat: number | null;
  lon: number | null;
}

/** Why events did not make it through, so a hand-run gets a report rather than a number. */
export interface DropCounts {
  malformed: number;
  noUrl: number;
  outsideWindow: number;
  duplicate: number;
}

export interface DiscoveryBatch {
  events: DiscoveredEvent[];
  dropped: DropCounts;
}

/**
 * The discovery prompt: the only place in the system that is allowed to search the
 * web. Curation (`plan.ts`) picks from what this writes and may never look further.
 *
 * The dates are spelled out rather than described. "This weekend" invites the model to
 * answer from whatever it remembers a weekend looking like, which is how stale events
 * get in; exact dates give grounded search something to match against and give the
 * write-up something to be wrong about visibly. The code-level filter in
 * `parseDiscoveries` is the second half of that defence, not a substitute for it.
 */
export function buildDiscoveryPrompt(window: WeekendWindow): string {
  return `You are a local events researcher. Today is ${window.today}. Search the web and find real public events in ${CITY} happening between Saturday ${window.saturday} and Sunday ${window.sunday}.

What counts:
- The event happens on ${window.saturday} or ${window.sunday}. Nothing on Friday, nothing next weekend, nothing that has already been and gone.
- It is open to the public — no private parties, no ticketed-out shows, no "members only".
- It has a real page on the web that says when and where it is.

For each event, write down:
- the name, exactly as the page gives it
- the day and start time, and the end time if the page lists one
- the venue and the borough
- what kind of thing it is (a concert, a market, a walking tour, a film screening)
- the address of the page you found it on — the page for this particular event, not the
  venue's homepage and not a listing of the whole series it belongs to

Cite the page for every event. An event you cannot point at a page for is an event we
cannot use, so leave it out rather than describing it from memory.

Aim for 10 to 20 events across different boroughs and different kinds of thing — a
list that all reads the same way is a worse answer than a short one. Prefer official
venue, park, museum, and library pages over aggregators.

Write your findings as prose or a list. The format does not matter; the dates, the
addresses, and the citations do.`;
}

/**
 * The normalization prompt: the write-up above, turned into rows.
 *
 * This call gets no tools, which is what lets it take a response schema — Gemini does
 * not allow both. It also means it cannot go looking for anything the researcher did
 * not already find, which is the point: this call transcribes, it does not discover.
 */
export const NORMALIZATION_SYSTEM_PROMPT = `You turn a write-up of events into structured JSON.

Rules:
1. Only include events that appear in the write-up. Never add one, never merge two into one, never split one into two.
2. Copy each event's url from the write-up exactly. If an event has no url there, leave the url empty — do not substitute a search page, a homepage, or a url you assume exists.
3. "time" is an ISO 8601 interval, "start/end", in UTC with a trailing Z, for example "2026-08-29T21:00:00Z/2026-08-29T22:00:00Z". New York is UTC-4 in the summer and UTC-5 in the winter, so a 5pm event in August is 21:00Z. If no end time is given, write the start alone with no slash.
4. "location" is the venue and the borough, as the write-up gives them.
5. "event_type" is one or more lowercase kinds, comma-separated, like "concert" or "fitness,outdoor fitness".
6. "lat" and "lon" are the venue's coordinates, to four decimal places. These are almost all named parks, libraries, museums, plazas, and street corners in New York, so place each one on the map and give its coordinates. Write null for both only when the write-up does not say where the event is, or names a venue you genuinely cannot place. Never write 0, and never fall back to the middle of the borough or of Manhattan — a pin in the wrong place is worse than no pin, and null is the honest answer when you do not know.`;

export function buildNormalizationPrompt(prose: string, window: WeekendWindow): string {
  return [
    `Today is ${window.today}. The weekend in question is Saturday ${window.saturday} and Sunday ${window.sunday}, in ${CITY}.`,
    '',
    'Here is the write-up to convert:',
    '',
    prose
  ].join('\n');
}

/**
 * The response schema for the normalization call. `lat`/`lon` are not required and are
 * explicitly nullable, so "I do not know where this is" has a way to be said.
 */
export const EVENTS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          time: { type: 'string' },
          url: { type: 'string' },
          location: { type: 'string' },
          event_type: { type: 'string' },
          lat: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: "The venue's latitude, or null if the venue cannot be placed."
          },
          lon: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: "The venue's longitude, or null if the venue cannot be placed."
          }
        },
        required: ['title', 'time', 'url', 'location', 'event_type']
      }
    }
  },
  required: ['events']
};

/**
 * Generous bounds around the five boroughs. The city is hardcoded, so a venue outside
 * this box is not a New York venue that drifted — it is a coordinate the model made
 * up for a name it recognised. Wide enough that a rooftop in the Rockaways is fine.
 */
const NYC_BOUNDS = { minLat: 40.4, maxLat: 41.1, minLon: -74.4, maxLon: -73.5 };

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, limit) : null;
}

/** A citation is an address we can fetch later; anything else is not a citation. */
function cleanUrl(value: unknown): string | null {
  const text = cleanText(value, 2000);
  if (!text) return null;

  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Ends in "Z" or a numeric offset, so it names an instant rather than a wall clock. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A time from the model, as a UTC instant.
 *
 * The prompt asks for UTC, and a reply that gives one is taken at its word. A reply
 * that leaves the offset off is read as New York rather than as whatever zone the
 * machine running the refresh happens to be in — the model was asked about New York
 * events, and `new Date` would otherwise silently answer differently on a laptop here
 * and on the deploy box.
 */
function toUtcInstant(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const parsed = HAS_OFFSET.test(trimmed) ? new Date(trimmed) : newYorkInstant(trimmed);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;

  return `${parsed.toISOString().slice(0, 19)}Z`;
}

/**
 * Every stored time is rewritten to UTC with a trailing Z, whatever the model wrote.
 *
 * The interval is the single most likely source of a silent bug here (spec.md), and a
 * row spelled "2026-08-29T17:00:00-04:00" is the same instant as the seed's
 * "2026-08-29T21:00:00Z" but a different string — which matters, because the candidate
 * query in `events.ts` narrows by string comparison before anything parses a date.
 * An unparseable end half is dropped; an unparseable start drops the event.
 */
function normalizeInterval(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const [rawStart, rawEnd] = value.split('/');

  const start = toUtcInstant(rawStart);
  if (!start) return null;

  const end = toUtcInstant(rawEnd);
  return end ? `${start}/${end}` : start;
}

/** One or several types, however the model spelled them, in the column's shape. */
function normalizeTypes(value: unknown): string {
  const parts = Array.isArray(value) ? value : [value];
  const names: string[] = [];

  for (const part of parts) {
    if (typeof part !== 'string') continue;

    for (const name of part.split(',')) {
      const cleaned = cleanText(name, 60)?.toLowerCase();
      if (cleaned && !names.includes(cleaned)) names.push(cleaned);
    }
  }

  return names.join(',');
}

/**
 * Both coordinates or neither, and only when they land in New York.
 *
 * A half-resolved pair cannot be pinned, and 0,0 — the Atlantic — is what a model
 * writes when it has nothing. Neither disqualifies the event: it lists and plans
 * fine without a pin (spec.md Decision 2).
 */
function normalizeCoordinates(rawLat: unknown, rawLon: unknown): { lat: number | null; lon: number | null } {
  const lat = typeof rawLat === 'number' ? rawLat : Number.NaN;
  const lon = typeof rawLon === 'number' ? rawLon : Number.NaN;

  const inNewYork =
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= NYC_BOUNDS.minLat &&
    lat <= NYC_BOUNDS.maxLat &&
    lon >= NYC_BOUNDS.minLon &&
    lon <= NYC_BOUNDS.maxLon;

  return inNewYork ? { lat, lon } : { lat: null, lon: null };
}

/**
 * A title reduced to its letters, digits, and spaces.
 *
 * Two sites listing the same event rarely punctuate it the same way — the parks
 * calendar wrote "Coup d’Etat" with a typographic apostrophe and the venue's own page
 * wrote "Coup d'Etat" with a straight one, which was enough to store that screening
 * twice. Dropping punctuation entirely is blunter than mapping the quote characters,
 * and blunt is what this needs: the date is doing the real work of telling events
 * apart, so the title only has to be recognisable.
 */
function foldTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * How two events are judged to be the same one: title and the New York calendar date
 * it starts on.
 *
 * The date has to be the local one. A Sunday 11pm show is Monday in UTC, so keying on
 * the raw string would file the same event under two different days depending on how
 * the model spelled the time, and a second run would store it again.
 *
 * Exported because the run-side dedupe and the against-the-database dedupe must agree
 * exactly; two nearly-identical keys would let duplicates through the seam between them.
 */
export function dedupeKey(event: { title: string; time: string }): string {
  const title = foldTitle(event.title);
  const start = eventStart(event.time);

  // Nothing unparseable gets this far from `parseDiscoveries`, but a row already in the
  // database might be. Keying it on its raw time keeps it comparable with itself, which
  // is all dedupe needs, without a second place that knows how an interval is spelled.
  const date = start ? newYorkDate(start) : event.time.trim();

  return `${title}|${date}`;
}

/**
 * Models wrap JSON in prose or a fenced block often enough to plan for, and a run that
 * threw away a good search because of a stray sentence would be an expensive way to
 * find that out. Take the outermost braces and let JSON.parse judge the rest; a reply
 * with no JSON in it at all is an empty run, not an exception.
 */
function readEntries(text: string): unknown[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  if (Array.isArray(payload)) return payload;

  const events = (payload as Record<string, unknown> | null)?.events;
  return Array.isArray(events) ? events : [];
}

/**
 * The gate between Gemini and the database. Four things get dropped here:
 *
 * - anything missing a title, a location, or a time we can parse
 * - anything with no citation url — the one rule a missing field cannot survive
 * - anything outside the Saturday-Sunday window, however firmly the prompt asked
 * - anything already seen in this run, by title+date or by url
 *
 * The window check is the belt to the prompt's braces. The prompt names the dates so
 * grounded search has something to match; this drops what comes back anyway, because
 * a stale event that reaches SQLite is one `/api/plan` can put on stage.
 */
export function parseDiscoveries(text: string, window: WeekendWindow): DiscoveryBatch {
  const dropped: DropCounts = { malformed: 0, noUrl: 0, outsideWindow: 0, duplicate: 0 };
  const events: DiscoveredEvent[] = [];
  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();

  for (const entry of readEntries(text)) {
    if (!entry || typeof entry !== 'object') {
      dropped.malformed += 1;
      continue;
    }

    const raw = entry as Record<string, unknown>;
    const title = cleanText(raw.title, 300);
    const location = cleanText(raw.location, 300);
    const time = normalizeInterval(raw.time);

    if (!title || !location || !time) {
      dropped.malformed += 1;
      continue;
    }

    const url = cleanUrl(raw.url);
    if (!url) {
      dropped.noUrl += 1;
      continue;
    }

    if (!isInWindow(time, window)) {
      dropped.outsideWindow += 1;
      continue;
    }

    const key = dedupeKey({ title, time });
    if (seenKeys.has(key) || seenUrls.has(url)) {
      dropped.duplicate += 1;
      continue;
    }

    seenKeys.add(key);
    seenUrls.add(url);

    events.push({
      title,
      time,
      url,
      location,
      event_type: normalizeTypes(raw.event_type),
      ...normalizeCoordinates(raw.lat, raw.lon)
    });
  }

  return { events, dropped };
}
