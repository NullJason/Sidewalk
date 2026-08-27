import { GoogleGenAI } from '@google/genai';

import {
  buildDiscoveryPrompt,
  buildNormalizationPrompt,
  EVENTS_RESPONSE_SCHEMA,
  NORMALIZATION_SYSTEM_PROMPT
} from './discovery.js';
import type { StoredEvent } from './events.js';
import { buildUserPrompt, parsePlan, SYSTEM_PROMPT, type Plan } from './plan.js';
import type { WeekendWindow } from './weekend.js';

// Overridable so a model retirement is an .env edit, not a deploy. The 2.5 line is
// already closed to new keys; the API names its own replacement in the 404 body.
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.6-flash';

// The demo is live and on stage, but url_context fetches a page per candidate before
// the model writes a word, so this is slower than a bare completion — measured around
// 40s against the ten seeded events. Past this, the fallback (ticket 05) renders
// sooner than the real answer would.
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 75_000);

// Discovery is hand-run from a terminal with nobody waiting on a page, and grounded
// search across a whole weekend of listings takes minutes rather than seconds. The
// curation budget above would cut a good run off halfway.
const DISCOVERY_TIMEOUT_MS = Number(process.env.GEMINI_DISCOVERY_TIMEOUT_MS ?? 180_000);

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set — copy .env.example to .env and fill it in.');
  }

  // Built once and reused: the key does not change between requests.
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

/**
 * The curation call: rank and order events that are already in the database.
 *
 * `url_context` is the only tool. `google_search` is deliberately absent — discovery
 * is `refresh.ts`'s job, and a curation call that could search is a curation call
 * that can put an event in front of the user that nothing in our database backs.
 *
 * Structured output is not requested, because Gemini does not allow a response schema
 * alongside tools. The prompt asks for JSON and `parsePlan` is written to survive the
 * model wrapping it in prose.
 */
export async function curatePlan(
  vibe: string,
  candidates: StoredEvent[],
  window: WeekendWindow
): Promise<Plan> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);

  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: buildUserPrompt(vibe, candidates, window),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ urlContext: {} }],
      temperature: 0.7,
      abortSignal: timeout
    }
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned an empty response.');

  return parsePlan(text, candidates);
}

/**
 * Discovery, call one: search the web and write up what is on this weekend.
 *
 * `google_search` is the only tool, and this is the only function in the system that
 * gets it. The reply is prose — deliberately, because asking one call to both search
 * well and emit clean JSON gets a worse version of each. Normalizing is call two's job.
 */
export async function searchForEvents(window: WeekendWindow): Promise<string> {
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: buildDiscoveryPrompt(window),
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0.4,
      abortSignal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    }
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned no search results.');

  return text;
}

/**
 * Discovery, call two: turn that write-up into rows.
 *
 * No tools, which is what allows a response schema — Gemini does not accept both — and
 * which is also the point: this call can only transcribe what call one found. It cannot
 * go looking for an event to fill a gap, so nothing reaches SQLite that no search backed.
 *
 * Returns the raw text. Deciding what is usable is `parseDiscoveries`' job, and it is
 * written to survive a model that ignores the schema.
 */
export async function normalizeDiscoveries(
  prose: string,
  window: WeekendWindow
): Promise<string> {
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: buildNormalizationPrompt(prose, window),
    config: {
      systemInstruction: NORMALIZATION_SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseJsonSchema: EVENTS_RESPONSE_SCHEMA,
      // Transcription, not authorship: the same write-up should always come out the
      // same way, and a creative normalizer is one that edits an event's name.
      temperature: 0,
      abortSignal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    }
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned an empty normalization response.');

  return text;
}
