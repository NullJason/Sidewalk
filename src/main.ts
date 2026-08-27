import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

type UUID = string;

interface EventItem {
  id: UUID;
  title: string;
  location: string;
  description: string;
  time: string;
  fit: string;
  lat?: number;
  lon?: number;
  source: "gemini" | "db" | "csv";
}

interface WeekendPlan {
  id: UUID;
  prompt: string;
  createdAt: string;
  events: EventItem[];
}

interface GeminiPlanResponse {
  weekendTitle?: string;
  events: Array<{
    title: string;
    location: string;
    description: string;
    time: string;
    fit: string;
  }>;
}

interface AppConfig {
  geminiEndpoint: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

const config: AppConfig = {
  geminiEndpoint: import.meta.env.VITE_GEMINI_ENDPOINT || "/api/plan",
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
};


class SupabaseRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly anonKey: string
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Database request failed (${response.status})${body ? `: ${body.slice(0, 240)}` : ""}`);
    }

    if (response.status === 204) return undefined as T;
    const body = await response.text();
    if (!body.trim()) return undefined as T;

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error("Database returned an invalid JSON response.");
    }
  }

  select<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  insert<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(body)
    });
  }

  update<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(body)
    });
  }
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    weekendTitle: { type: "string" },
    events: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          location: { type: "string" },
          description: { type: "string" },
          time: { type: "string" },
          fit: { type: "string" }
        },
        required: ["title", "location", "description", "time", "fit"]
      }
    }
  },
  required: ["events"]
} as const;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root was not found.");

app.innerHTML = `
  <div class="shell">
    <div class="app-frame">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">S</span>
          <span>sidewalk</span>
        </div>
        <div id="mode-label" class="mode-label">Vibe planner</div>
      </header>

      <main id="page-one" class="page active" aria-label="Weekend planner">
        <section class="hero">
          <div class="kicker">A better kind of plan</div>
          <h1>What’s your vibe<br />this weekend?</h1>
          <p class="hero-copy">
            Give Sidewalk the loose version. Cheap. Outdoors. Somewhere quiet.
            A weird museum. Your exact address is optional, but the more context
            you give, the better the route.
          </p>

          <form id="plan-form" novalidate>
            <div class="prompt-wrap">
              <textarea
                id="prompt"
                class="prompt"
                maxlength="1000"
                autocomplete="off"
                placeholder="e.g. cheap, outdoors, don’t want to talk to anyone…"
                aria-label="Describe your weekend vibe"
              ></textarea>
              <div id="char-count" class="char-count">0 / 1000</div>
            </div>

            <div class="action-row">
              <div class="actions-left">
                <button id="mapper-btn" class="btn btn-quiet" type="button">Mapper</button>
              </div>
              <div class="actions-right">
                <button id="surprise-btn" class="btn" type="button">Surprise me</button>
                <button id="plan-btn" class="btn btn-primary" type="submit">
                  Plan my weekend
                </button>
              </div>
            </div>
          </form>

          <div id="status" class="status" role="status" aria-live="polite"></div>
        </section>
      </main>

      <main id="page-two" class="page" aria-label="Weekend map">
        <div class="mapper-bar">
          <button id="back-btn" class="btn btn-icon" type="button" aria-label="Return to planner">←</button>
          <div id="mapper-title" class="mapper-title">Your weekend</div>
          <button id="refresh-btn" class="btn btn-quiet" type="button">Refresh events</button>
        </div>

        <div class="mapper-layout">
          <aside class="event-panel">
            <div class="event-panel-head">
              <strong>Recent Sidewalks</strong><br />
              <small id="event-count">0 events</small>
            </div>
            <div id="events-scroll" class="events-scroll"></div>
          </aside>

          <section class="map-stage" aria-label="Event map">
            <div id="map"></div>
            <div class="map-overlay">
              Select “Reveal on map” on an event to place its pin and center the map.
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>
`;

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const pageOne = $<HTMLElement>("#page-one");
const pageTwo = $<HTMLElement>("#page-two");
const modeLabel = $<HTMLElement>("#mode-label");
const promptInput = $<HTMLTextAreaElement>("#prompt");
const charCount = $<HTMLElement>("#char-count");
const planForm = $<HTMLFormElement>("#plan-form");
const planButton = $<HTMLButtonElement>("#plan-btn");
const mapperButton = $<HTMLButtonElement>("#mapper-btn");
const surpriseButton = $<HTMLButtonElement>("#surprise-btn");
const backButton = $<HTMLButtonElement>("#back-btn");
const refreshButton = $<HTMLButtonElement>("#refresh-btn");
const status = $<HTMLElement>("#status");
const eventsScroll = $<HTMLElement>("#events-scroll");
const eventCount = $<HTMLElement>("#event-count");
const mapperTitle = $<HTMLElement>("#mapper-title");
const toast = $<HTMLElement>("#toast");

let currentPlan: WeekendPlan | null = null;
let plansCache: WeekendPlan[] = [];
let map: L.Map | null = null;
let mapLayer: L.LayerGroup | null = null;
let supabase: SupabaseRestClient | null = null;
let fallbackEvents: EventItem[] = [];
let toastTimer: number | undefined;

if (config.supabaseUrl && config.supabaseAnonKey) {
  supabase = new SupabaseRestClient(config.supabaseUrl, config.supabaseAnonKey);
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const uuid = (): UUID =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function setStatus(message: string, type: "" | "error" | "success" = ""): void {
  status.textContent = message;
  status.className = `status ${type}`.trim();
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("visible");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function setPage(page: "one" | "two"): void {
  pageOne.classList.toggle("active", page === "one");
  pageTwo.classList.toggle("active", page === "two");
  modeLabel.textContent = page === "one" ? "Vibe planner" : "Mapper";

  if (page === "two") {
    requestAnimationFrame(() => {
      initializeMap();
      map?.invalidateSize();
      renderEventList();
    });
  }
}

function normalizeEvent(raw: {
  title?: unknown;
  location?: unknown;
  description?: unknown;
  time?: unknown;
  fit?: unknown;
}, source: EventItem["source"]): EventItem | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const location = typeof raw.location === "string" ? raw.location.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const time = typeof raw.time === "string" ? raw.time.trim() : "";
  const fit = typeof raw.fit === "string" ? raw.fit.trim() : "";

  if (!title || !location || !description) return null;

  return {
    id: uuid(),
    title: title.slice(0, 180),
    location: location.slice(0, 240),
    description: description.slice(0, 1200),
    time: time.slice(0, 100) || "Flexible",
    fit: fit.slice(0, 500) || "Fits the vibe you gave Sidewalk.",
    source
  };
}

function sanitizeGeminiResponse(value: unknown): GeminiPlanResponse {
  if (!value || typeof value !== "object") return { events: [] };
  const candidate = value as Record<string, unknown>;
  const rawEvents = Array.isArray(candidate.events) ? candidate.events : [];

  const events = rawEvents
    .map((entry) => normalizeEvent(entry as GeminiPlanResponse["events"][number], "gemini"))
    .filter((event): event is EventItem => Boolean(event))
    .slice(0, 6)
    .map((event) => ({
      title: event.title,
      location: event.location,
      description: event.description,
      time: event.time,
      fit: event.fit
    }));

  return {
    weekendTitle:
      typeof candidate.weekendTitle === "string" ? candidate.weekendTitle.trim().slice(0, 120) : undefined,
    events
  };
}

async function callGemini(prompt: string): Promise<GeminiPlanResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch(config.geminiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        prompt,
        responseSchema: PLAN_SCHEMA,
        responseMimeType: "application/json"
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini endpoint returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    const payload: unknown = await response.json();

    // Supports either {events: [...]} or common wrappers such as {data: {events: [...]}}.
    if (payload && typeof payload === "object" && "data" in payload) {
      return sanitizeGeminiResponse((payload as { data: unknown }).data);
    }

    return sanitizeGeminiResponse(payload);
  } finally {
    window.clearTimeout(timeout);
  }
}

function buildGeminiPrompt(userVibe: string): string {
  return `
You are Sidewalk, a local-weekend itinerary curator.

Create a coherent Saturday-first weekend plan from the user's loose request below.

User request:
"${userVibe}"

Requirements:
- Return 3 to 6 real, geographically sensible events.
- Prefer low-friction plans when the user asks for solitude.
- Respect stated price, outdoor/indoor, accessibility, timing, neighborhood, food, transportation, and social-energy preferences.
- Do not invent impossible combinations or duplicate the same event.
- Each event must have a concise title, concrete location, useful time, plain-language description, and "fit" explaining why it matches the user's vibe.
- Prefer public places, parks, markets, cultural venues, walks, viewpoints, bookstores, neighborhood spots, and other plausible local experiences.
- Return ONLY valid JSON matching the supplied response schema.
`.trim();
}

async function loadCsvFallback(): Promise<EventItem[]> {
  if (fallbackEvents.length) return fallbackEvents;

  const response = await fetch("/demo-events.csv", { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load demo-events.csv (${response.status}).`);

  const text = await response.text();
  const lines = parseCsv(text);
  if (lines.length < 2) return [];

  const headers = lines[0].map((header) => header.trim().toLowerCase());
  const indexOf = (name: string) => headers.indexOf(name);

  const titleIndex = indexOf("title");
  const locationIndex = indexOf("location");
  const descriptionIndex = indexOf("description");
  const timeIndex = indexOf("time");

  if ([titleIndex, locationIndex, descriptionIndex].some((index) => index < 0)) {
    throw new Error("demo-events.csv must include title, location, description, and optionally time.");
  }

  fallbackEvents = lines.slice(1)
    .map((row) => normalizeEvent({
      title: row[titleIndex],
      location: row[locationIndex],
      description: row[descriptionIndex],
      time: timeIndex >= 0 ? row[timeIndex] : "Flexible",
      fit: "Demo Sidewalk quest loaded because live planning was unavailable."
    }, "csv"))
    .filter((event): event is EventItem => Boolean(event));

  return fallbackEvents;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((currentRow) => currentRow.some((value) => value.trim().length > 0));
}

async function fetchRecentPlans(): Promise<WeekendPlan[]> {
  if (!supabase) return plansCache;

  type EventRow = {
    id: string; title: string; location: string; description: string; time?: string; fit?: string;
    lat?: number | null; lon?: number | null; source?: string | null;
  };
  type PlanRow = {
    id: string; prompt?: string | null; created_at?: string | null; sidewalk_events?: EventRow[];
  };

  const rows = await supabase.select<PlanRow[]>(
    "sidewalk_plans?select=id,prompt,created_at,sidewalk_events(id,title,location,description,time,fit,lat,lon,source)&order=created_at.desc&limit=20"
  );

  return rows.map((row) => ({
    id: String(row.id),
    prompt: String(row.prompt ?? ""),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    events: (row.sidewalk_events ?? []).map((event) => ({
      id: String(event.id), title: String(event.title), location: String(event.location),
      description: String(event.description), time: String(event.time ?? "Flexible"), fit: String(event.fit ?? ""),
      lat: typeof event.lat === "number" ? event.lat : undefined,
      lon: typeof event.lon === "number" ? event.lon : undefined,
      source: event.source === "db" || event.source === "csv" ? event.source : "gemini"
    }))
  }));
}

async function fetchRandomCachedQuest(): Promise<WeekendPlan | null> {
  if (!supabase) {
    if (!plansCache.length) return null;
    return plansCache[Math.floor(Math.random() * plansCache.length)] ?? null;
  }

  type QuestRow = {
    id: string; prompt?: string | null; title: string; location: string; description: string;
    time?: string | null; fit?: string | null; lat?: number | null; lon?: number | null;
  };

  const rows = await supabase.select<QuestRow[]>(
    "sidewalk_quests?select=id,prompt,title,location,description,time,fit,lat,lon&limit=100"
  );
  if (!rows.length) return null;

  const chosen = rows[Math.floor(Math.random() * rows.length)];
  const event = normalizeEvent(chosen, "db");
  if (!event) return null;
  if (typeof chosen.lat === "number") event.lat = chosen.lat;
  if (typeof chosen.lon === "number") event.lon = chosen.lon;

  return {
    id: uuid(), prompt: String(chosen.prompt ?? "Surprise me"), createdAt: new Date().toISOString(), events: [event]
  };
}

async function persistPlan(plan: WeekendPlan): Promise<void> {
  plansCache = [plan, ...plansCache.filter((entry) => entry.id !== plan.id)].slice(0, 20);
  if (!supabase) return;

  await supabase.insert("sidewalk_plans", {
    id: plan.id, prompt: plan.prompt, created_at: plan.createdAt
  });

  const rows = plan.events.map((event) => ({
    id: event.id, plan_id: plan.id, title: event.title, location: event.location,
    description: event.description, time: event.time, fit: event.fit,
    lat: event.lat ?? null, lon: event.lon ?? null, source: event.source
  }));

  await supabase.insert("sidewalk_events", rows);
}

async function geocode(location: string): Promise<{ lat: number; lon: number } | null> {
  const cacheKey = `sidewalk-geocode:${location.trim().toLowerCase()}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { lat: number; lon: number };
      if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) return parsed;
    } catch {
      localStorage.removeItem(cacheKey);
    }
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", location);

  const response = await fetch(url, {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) return null;

  const results = await response.json() as Array<{ lat?: string; lon?: string }>;
  const first = results[0];
  if (!first?.lat || !first.lon) return null;

  const point = { lat: Number(first.lat), lon: Number(first.lon) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;

  localStorage.setItem(cacheKey, JSON.stringify(point));
  return point;
}

function initializeMap(): void {
  if (map) return;

  map = L.map("map", {
    zoomControl: true,
    attributionControl: true
  }).setView([40.7128, -74.0060], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  mapLayer = L.layerGroup().addTo(map);
}

async function revealOnMap(event: EventItem): Promise<void> {
  initializeMap();
  if (!map || !mapLayer) return;

  if (event.lat === undefined || event.lon === undefined) {
    showToast("Finding that location…");
    const point = await geocode(event.location);

    if (!point) {
      showToast("Could not locate this event. Try a more specific address.");
      return;
    }

    event.lat = point.lat;
    event.lon = point.lon;

    if (supabase) {
      await supabase.update(`sidewalk_events?id=eq.${encodeURIComponent(event.id)}`, { lat: point.lat, lon: point.lon });
    }
  }

  mapLayer.clearLayers();

  const marker = L.marker([event.lat, event.lon]).addTo(mapLayer);
  marker.bindPopup(`
    <strong>${escapeHtml(event.title)}</strong><br>
    <span>${escapeHtml(event.location)}</span>
  `).openPopup();

  map.setView([event.lat, event.lon], 15, { animate: true });
}

function getRecentEvents(): EventItem[] {
  const seen = new Set<string>();
  const events: EventItem[] = [];

  for (const plan of [currentPlan, ...plansCache]) {
    if (!plan) continue;
    for (const event of plan.events) {
      const key = `${event.title.toLowerCase()}|${event.location.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
      if (events.length >= 50) return events;
    }
  }

  return events;
}

function renderEventList(): void {
  const events = getRecentEvents();
  eventCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;

  if (!events.length) {
    eventsScroll.innerHTML = `
      <div class="empty-state">
        No events yet. Return to the planner and generate a weekend, or use the demo fallback.
      </div>
    `;
    return;
  }

  eventsScroll.innerHTML = events.map((event, index) => `
    <article class="event-card" data-event-id="${escapeHtml(event.id)}">
      <button class="event-summary" type="button" aria-expanded="false">
        <div>
          <div class="event-title">${index + 1}. ${escapeHtml(event.title)}</div>
          <div class="event-location">${escapeHtml(event.location)}</div>
          <div class="event-time">${escapeHtml(event.time)}</div>
        </div>
        <div class="chevron" aria-hidden="true">⌄</div>
      </button>
      <div class="event-detail">
        <p class="event-description">${escapeHtml(event.description)}</p>
        <div class="event-fit">${escapeHtml(event.fit)}</div>
        <button class="map-btn" type="button" data-map-event="${escapeHtml(event.id)}">
          Reveal on map
        </button>
      </div>
    </article>
  `).join("");
}

function findEvent(eventId: string): EventItem | undefined {
  return currentPlan?.events.find((event) => event.id === eventId);
}

eventsScroll.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const card = target.closest<HTMLElement>(".event-card");
  if (!card) return;

  const summary = target.closest<HTMLButtonElement>(".event-summary");
  if (summary) {
    const willOpen = !card.classList.contains("open");
    card.classList.toggle("open", willOpen);
    summary.setAttribute("aria-expanded", String(willOpen));
    return;
  }

  const mapButton = target.closest<HTMLButtonElement>("[data-map-event]");
  const eventId = mapButton?.dataset.mapEvent;
  if (!eventId) return;

  const item = findEvent(eventId);
  if (!item) return;

  try {
    await revealOnMap(item);
  } catch (error) {
    console.error(error);
    showToast("Map lookup failed.");
  }
});

async function useDemoPlan(prompt = "Demo fallback"): Promise<WeekendPlan> {
  const events = await loadCsvFallback();
  if (!events.length) throw new Error("Demo CSV contained no usable events.");

  return {
    id: uuid(),
    prompt,
    createdAt: new Date().toISOString(),
    events: events.slice(0, 4).map((event) => ({ ...event, id: uuid() }))
  };
}

async function generatePlan(userPrompt: string): Promise<void> {
  const trimmed = userPrompt.trim();
  if (!trimmed) {
    setStatus("Type a vibe first, or use Surprise me.", "error");
    promptInput.focus();
    return;
  }

  planButton.disabled = true;
  mapperButton.disabled = true;
  surpriseButton.disabled = true;
  planButton.classList.add("loading");
  setStatus("Sidewalk is mapping the vibe…");

  try {
    const result = await callGemini(buildGeminiPrompt(trimmed));

    if (!result.events.length) {
      throw new Error("Gemini returned no events.");
    }

    currentPlan = {
      id: uuid(),
      prompt: trimmed,
      createdAt: new Date().toISOString(),
      events: result.events.map((event) => ({
        ...normalizeEvent(event, "gemini")!,
        id: uuid()
      }))
    };

    try {
      await persistPlan(currentPlan);
    } catch (dbError) {
      console.warn("Plan generated but persistence failed:", dbError);
      showToast("Plan created. Database save was unavailable.");
    }

    mapperTitle.textContent = result.weekendTitle || "Your weekend";
    setStatus("Weekend mapped.", "success");
    setPage("two");
  } catch (error) {
    console.warn("Live planning failed; using CSV demo fallback.", error);
    try {
      currentPlan = await useDemoPlan(trimmed);
      mapperTitle.textContent = "A Sidewalk demo route";
      setStatus("Live planning was unavailable, so Sidewalk loaded a demo route.", "error");
      setPage("two");
    } catch (fallbackError) {
      console.error(fallbackError);
      setStatus("Could not generate a plan or load the demo events.", "error");
    }
  } finally {
    planButton.disabled = false;
    mapperButton.disabled = false;
    surpriseButton.disabled = false;
    planButton.classList.remove("loading");
  }
}

async function surpriseMe(): Promise<void> {
  surpriseButton.disabled = true;
  planButton.disabled = true;
  mapperButton.disabled = true;
  setStatus("Finding a cached Sidewalk quest…");

  try {
    let quest = await fetchRandomCachedQuest();

    if (!quest) {
      const demo = await useDemoPlan("Surprise me");
      quest = {
        ...demo,
        events: [demo.events[Math.floor(Math.random() * demo.events.length)]!]
      };
    }

    currentPlan = quest;
    mapperTitle.textContent = "A surprise sidewalk";
    setStatus("Quest selected.", "success");
    setPage("two");
  } catch (error) {
    console.error(error);
    setStatus("Surprise mode failed.", "error");
  } finally {
    surpriseButton.disabled = false;
    planButton.disabled = false;
    mapperButton.disabled = false;
  }
}

async function refreshFromDatabase(): Promise<void> {
  refreshButton.disabled = true;
  try {
    if (!supabase) {
      showToast("Database is not configured; showing the current plan.");
      renderEventList();
      return;
    }

    const plans = await fetchRecentPlans();
    plansCache = plans;

    if (plans.length) {
      currentPlan = plans[0];
      mapperTitle.textContent = currentPlan.events.length
        ? "Recent Sidewalk"
        : "Your weekend";
    }

    renderEventList();
    showToast(plans.length ? "Recent events refreshed." : "No saved Sidewalk plans yet.");
  } catch (error) {
    console.error(error);
    showToast("Could not refresh the database.");
  } finally {
    refreshButton.disabled = false;
  }
}

promptInput.addEventListener("input", () => {
  charCount.textContent = `${promptInput.value.length} / 1000`;
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    planForm.requestSubmit();
  }
});

planForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void generatePlan(promptInput.value);
});

surpriseButton.addEventListener("click", () => {
  void surpriseMe();
});

mapperButton.addEventListener("click", async () => {
  if (!currentPlan) {
    try {
      if (!plansCache.length && supabase) plansCache = await fetchRecentPlans();
      currentPlan = plansCache[0] ?? await useDemoPlan("Mapper");
      mapperTitle.textContent = plansCache.length ? "Recent Sidewalks" : "Demo Sidewalks";
    } catch (error) {
      console.warn("Could not preload mapper data:", error);
      currentPlan = await useDemoPlan("Mapper");
      mapperTitle.textContent = "Demo Sidewalks";
    }
  }
  setPage("two");
});

backButton.addEventListener("click", () => setPage("one"));
refreshButton.addEventListener("click", () => void refreshFromDatabase());

void (async () => {
  try {
    fallbackEvents = await loadCsvFallback();
  } catch (error) {
    console.warn("Demo CSV preload failed:", error);
  }

  try {
    if (supabase) {
      plansCache = await fetchRecentPlans();
      if (!currentPlan && plansCache[0]) currentPlan = plansCache[0];
    }
  } catch (error) {
    console.warn("Database preload failed:", error);
  }
})();
