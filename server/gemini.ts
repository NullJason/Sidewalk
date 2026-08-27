import { GoogleGenAI } from '@google/genai';

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
