import type { StoredEvent } from './events.js';
import type { WeekendWindow } from './weekend.js';

/** Exactly three stops, fewer only when fewer candidates exist for the weekend. */
export const MAX_STOPS = 3;

const DEFAULT_PLAN_TITLE = 'Your weekend';

/**
 * What a fallback plan says instead of the two generated lines. Static, because the
 * curation call is exactly what failed — nothing wrote them. They are still filled in
 * rather than omitted so the card reads as a deliberate answer rather than a plan that
 * came back half-empty.
 */
const FALLBACK_PLAN_TITLE = 'A weekend, picked at random';
const FALLBACK_DESCRIPTION = 'Straight from our events list — no write-up this time.';
const FALLBACK_WHY = 'Picked while our planner was catching its breath.';

export interface PlanStop extends StoredEvent {
  description?: string; // generated per response, never stored
  why?: string; // generated per response, never stored
}

export interface Plan {
  planTitle: string;
  stops: PlanStop[];
}

/**
 * The curation prompt. Two jobs it must do and one it must not: pick and order from
 * the supplied list, write one line of `description` and one of `why` per pick — and
 * never search, never invent, never edit a stored field.
 *
 * Only `id`, `description` and `why` are read back off the model (see `parsePlan`),
 * so a hallucinated title or url cannot reach the client even if the model writes
 * one. Asking for the full row anyway keeps the model's attention on the real event
 * rather than a bare number.
 */
export const SYSTEM_PROMPT = `You are a weekend planning guru for New York City.

You are given a list of real events that are already happening this weekend, and a
person's loose description of what they feel like doing. Build them a short itinerary.

Rules, in order of importance:
1. Only use events from the list provided. Never invent one. If nothing fits the vibe
   well, pick the closest events in the list anyway — an imperfect real event beats a
   perfect imaginary one.
2. Copy the id and source_url through unchanged, exactly as given.
3. Pick exactly ${MAX_STOPS} events, or every event in the list if fewer than
   ${MAX_STOPS} are provided. Never repeat an event.
4. Order the stops so the itinerary works as a day: earlier start times first, and
   keep the travel between locations sensible.
5. For each stop, use the url_context tool on its source_url to write "description":
   one line, plain and concrete, about what the event actually is. If the page does
   not give you enough to say, return an empty string rather than guessing.
6. For each stop, write "why": one line on why this event suits what the person asked
   for. Speak to them directly.
7. Write "planTitle": a short, specific name for the itinerary. No more than six words.

Reply with JSON and nothing else, in exactly this shape:

{"planTitle":"...","stops":[{"id":1,"description":"...","why":"..."}]}`;

/**
 * What the model is shown per candidate. `source_url` is named the way the system
 * prompt names it, and it is the url_context tool's input.
 */
function candidateLine(event: StoredEvent): string {
  return JSON.stringify({
    id: event.id,
    title: event.title,
    time: event.time,
    source_url: event.url,
    location: event.location,
    event_type: event.event_type
  });
}

export function buildUserPrompt(
  vibe: string,
  candidates: StoredEvent[],
  window: WeekendWindow
): string {
  return [
    `Today is ${window.today}.`,
    `This weekend is Saturday ${window.saturday} and Sunday ${window.sunday}.`,
    '',
    'What the person said they want:',
    vibe,
    '',
    `Events available this weekend (${candidates.length}):`,
    ...candidates.map(candidateLine)
  ].join('\n');
}

/**
 * Models wrap JSON in prose or a fenced block often enough that failing on it would
 * turn a good plan into a fallback. Take the outermost braces and let JSON.parse be
 * the judge of what is inside.
 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end <= start) {
    throw new Error('Gemini did not return a JSON object.');
  }

  return JSON.parse(text.slice(start, end + 1));
}

function cleanLine(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

/**
 * Joins the model's picks back onto the stored rows.
 *
 * This is where "never invent an event" is actually enforced, rather than merely
 * requested: the only things read off the model are the id — which must match a
 * candidate — and the two generated lines. Every other field is copied from SQLite,
 * so a model that renames an event, moves it, or edits its url changes nothing that
 * reaches the client.
 *
 * Throws when nothing usable comes back, which is the signal for the caller to fall
 * back (ticket 05) rather than return an empty itinerary.
 */
export function parsePlan(text: string, candidates: StoredEvent[]): Plan {
  const payload = extractJson(text);

  if (!payload || typeof payload !== 'object') {
    throw new Error('Gemini returned JSON that was not an object.');
  }

  const raw = payload as Record<string, unknown>;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<number>();
  const stops: PlanStop[] = [];

  for (const entry of Array.isArray(raw.stops) ? raw.stops : []) {
    if (stops.length >= MAX_STOPS) break;
    if (!entry || typeof entry !== 'object') continue;

    const pick = entry as Record<string, unknown>;
    const id = Number(pick.id);

    const candidate = byId.get(id);
    if (!candidate || seen.has(id)) continue;
    seen.add(id);

    const stop: PlanStop = { ...candidate };

    const description = cleanLine(pick.description, 1200);
    const why = cleanLine(pick.why, 500);
    if (description) stop.description = description;
    if (why) stop.why = why;

    stops.push(stop);
  }

  if (!stops.length) {
    throw new Error('Gemini selected no events that were actually on the candidate list.');
  }

  // "Exactly 3 stops, fewer only if fewer candidates exist." A model that returns two
  // picks against ten candidates has under-delivered, and shipping a two-stop
  // itinerary would quietly break that contract. Top up from the candidates it did
  // not use, in start order. These carry no description or why — nothing wrote them —
  // and a card without them renders without them.
  for (const candidate of candidates) {
    if (stops.length >= MAX_STOPS) break;
    if (seen.has(candidate.id)) continue;

    seen.add(candidate.id);
    stops.push({ ...candidate });
  }

  return {
    planTitle: cleanLine(raw.planTitle, 120) ?? DEFAULT_PLAN_TITLE,
    stops
  };
}

/**
 * The plan `/api/plan` answers with when the Gemini curation call throws or times out.
 *
 * Same shape as the happy path, so the client has no failure case to handle: a 200 from
 * `/api/plan` is always renderable the same way. The stops are random stored events —
 * the same pick `/api/surprise` makes — because the one thing that failed is precisely
 * the part that would have chosen better ones.
 */
export function fallbackPlan(events: StoredEvent[]): Plan {
  return {
    planTitle: FALLBACK_PLAN_TITLE,
    stops: events.slice(0, MAX_STOPS).map((event) => ({
      ...event,
      description: FALLBACK_DESCRIPTION,
      why: FALLBACK_WHY
    }))
  };
}
