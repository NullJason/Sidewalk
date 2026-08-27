//https://sidewalk-gamma.vercel.app/

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

interface EventItem {
  id: number;
  title: string;
  time: string; // ISO 8601 interval, "start/end"
  url: string;
  location: string;
  event_type: string; // comma-joined when an event has several
  lat?: number;
  lon?: number;
  description?: string; // /api/plan only — generated per response, never stored
  why?: string; // /api/plan only — generated per response, never stored
}

interface PlanResponse {
  planTitle: string;
  stops: EventItem[];
}

const PLAN_ENDPOINT = "/api/plan";
const SURPRISE_ENDPOINT = "/api/surprise";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root was not found.");

app.innerHTML = `
  <div class="shell">
    <div class="app-frame">
      <header class="topbar">
        <div class="brand">
          <span>Sidewalk</span>
        </div>
        <div id="mode-label" class="mode-label">Finder</div>
      </header>

      <main id="page-one" class="page active" aria-label="Weekend planner">
        <section class="hero">
          <div class="kicker">Find your weekend</div>
          <h1>What's your plan<br />this weekend?</h1>
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

let currentEvents: EventItem[] = [];
let map: L.Map | null = null;
let mapLayer: L.LayerGroup | null = null;
let toastTimer: number | undefined;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

// `time` is an ISO interval, "start/end". Every display path takes the start.
function formatTime(interval: string): string {
  const start = interval.split("/")[0] ?? "";
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return interval || "Flexible";

  return parsed.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

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

function normalizeEvent(value: unknown): EventItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const time = typeof raw.time === "string" ? raw.time.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const location = typeof raw.location === "string" ? raw.location.trim() : "";
  const eventType = typeof raw.event_type === "string" ? raw.event_type.trim() : "";

  if (!Number.isFinite(id) || !title || !time || !url || !location) return null;

  const event: EventItem = {
    id,
    title: title.slice(0, 180),
    time,
    url,
    location: location.slice(0, 240),
    event_type: eventType
  };

  // lat/lon are nullable everywhere: an event without them lists and plans
  // normally, it just has no pin.
  if (typeof raw.lat === "number" && Number.isFinite(raw.lat)) event.lat = raw.lat;
  if (typeof raw.lon === "number" && Number.isFinite(raw.lon)) event.lon = raw.lon;

  if (typeof raw.description === "string" && raw.description.trim()) {
    event.description = raw.description.trim().slice(0, 1200);
  }
  if (typeof raw.why === "string" && raw.why.trim()) {
    event.why = raw.why.trim().slice(0, 500);
  }

  return event;
}

function normalizeEvents(value: unknown): EventItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeEvent)
    .filter((event): event is EventItem => Boolean(event));
}

// Longer than the server's own Gemini timeout, deliberately. /api/plan spends most of
// its time in url_context fetching a page per candidate — measured around 30s — and a
// client that gave up first would turn a good plan into "could not reach the server".
const REQUEST_TIMEOUT_MS = 90_000;

async function fetchJson(input: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(input, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${input} returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

// POST /api/plan always answers 200 with a renderable body — the server owns the
// Gemini key, the prompt, and the fallback. There is no failure case on this side.
async function requestPlan(prompt: string): Promise<PlanResponse> {
  const payload = await fetchJson(PLAN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt })
  });

  const candidate = (payload ?? {}) as Record<string, unknown>;

  return {
    planTitle:
      typeof candidate.planTitle === "string" && candidate.planTitle.trim()
        ? candidate.planTitle.trim().slice(0, 120)
        : "Your weekend",
    stops: normalizeEvents(candidate.stops)
  };
}

// GET /api/surprise returns stored events straight from SQLite, with no
// description/why. It may answer with a single event or a short list.
async function requestSurprise(): Promise<EventItem[]> {
  const payload = await fetchJson(SURPRISE_ENDPOINT);
  if (Array.isArray(payload)) return normalizeEvents(payload);

  const single = normalizeEvent(payload);
  return single ? [single] : [];
}

// lat/lon are always both set or both absent, so one predicate answers "can this
// event be pinned" for every caller.
function hasCoordinates(event: EventItem): event is EventItem & { lat: number; lon: number } {
  return event.lat !== undefined && event.lon !== undefined;
}

function initializeMap(): void {
  if (map) return;

  map = L.map("map", {
    zoomControl: true,
    attributionControl: true
  }).setView([40.7128, -74.0060], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  mapLayer = L.layerGroup().addTo(map);
}

// Coordinates are resolved once at write time and stored on the row. The browser
// reads them as given, geocodes nothing, and caches nothing.
function revealOnMap(event: EventItem): void {
  if (!hasCoordinates(event)) return;

  initializeMap();
  if (!map || !mapLayer) return;

  mapLayer.clearLayers();

  const marker = L.marker([event.lat, event.lon]).addTo(mapLayer);
  marker.bindPopup(`
    <strong>${escapeHtml(event.title)}</strong><br>
    <span>${escapeHtml(event.location)}</span>
  `).openPopup();

  map.setView([event.lat, event.lon], 15, { animate: true });
}

// `event_type` is comma-joined when an event carries several ("fitness,outdoor
// fitness"), so one badge per type. An event with no types renders no badge row
// at all rather than an empty one.
function renderTypeTags(eventType: string): string {
  const types = eventType
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);

  if (!types.length) return "";

  const tags = types
    .map((type) => `<span class="event-tag">${escapeHtml(type)}</span>`)
    .join("");

  return `<div class="event-tags">${tags}</div>`;
}

function renderEventList(): void {
  const events = currentEvents;
  eventCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;

  if (!events.length) {
    eventsScroll.innerHTML = `
      <div class="empty-state">
        No events yet. Return to the planner and generate a weekend, or try Surprise me.
      </div>
    `;
    return;
  }

  eventsScroll.innerHTML = events.map((event, index) => {
    const hasPin = hasCoordinates(event);

    // Surprise Me events carry no description/why, and an event can arrive with no
    // coordinates, so the detail body can be empty. When it is, the card drops the
    // chevron and the panel entirely rather than expanding onto nothing.
    const hasDetail = Boolean(event.description || event.why || hasPin);

    const summary = `
        <div>
          <div class="event-title">${index + 1}. ${escapeHtml(event.title)}</div>
          <div class="event-location">${escapeHtml(event.location)}</div>
          <div class="event-time">${escapeHtml(formatTime(event.time))}</div>
          ${renderTypeTags(event.event_type)}
        </div>
        ${hasDetail ? `<div class="chevron" aria-hidden="true">⌄</div>` : ""}`;

    return `
    <article class="event-card" data-event-id="${event.id}">
      ${
        hasDetail
          ? `<button class="event-summary" type="button" aria-expanded="false">${summary}</button>`
          : `<div class="event-summary is-static">${summary}</div>`
      }
      ${
        hasDetail
          ? `<div class="event-detail">
        ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ""}
        ${event.why ? `<div class="event-fit">${escapeHtml(event.why)}</div>` : ""}
        ${hasPin ? `<button class="map-btn" type="button" data-map-event="${event.id}">Reveal on map</button>` : ""}
      </div>`
          : ""
      }
    </article>
  `;
  }).join("");
}

function findEvent(eventId: number): EventItem | undefined {
  return currentEvents.find((event) => event.id === eventId);
}

eventsScroll.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const card = target.closest<HTMLElement>(".event-card");
  if (!card) return;

  const summary = target.closest<HTMLElement>(".event-summary");
  // A card with nothing to reveal renders its summary as a static div and no
  // detail panel, so there is nothing to toggle.
  if (summary && !summary.classList.contains("is-static")) {
    const willOpen = !card.classList.contains("open");
    card.classList.toggle("open", willOpen);
    summary.setAttribute("aria-expanded", String(willOpen));
    return;
  }

  const mapButton = target.closest<HTMLButtonElement>("[data-map-event]");
  if (!mapButton?.dataset.mapEvent) return;

  const item = findEvent(Number(mapButton.dataset.mapEvent));
  if (!item) return;

  revealOnMap(item);
});

function setBusy(busy: boolean): void {
  planButton.disabled = busy;
  mapperButton.disabled = busy;
  surpriseButton.disabled = busy;
  planButton.classList.toggle("loading", busy);
}

async function generatePlan(userPrompt: string): Promise<void> {
  const trimmed = userPrompt.trim();
  if (!trimmed) {
    setStatus("Type a vibe first, or use Surprise me.", "error");
    promptInput.focus();
    return;
  }

  setBusy(true);
  setStatus("Sidewalk is mapping the vibe…");

  try {
    const plan = await requestPlan(trimmed);

    currentEvents = plan.stops;
    mapperTitle.textContent = plan.planTitle;
    setStatus(
      plan.stops.length ? "Weekend mapped." : "No events matched this weekend.",
      plan.stops.length ? "success" : "error"
    );
    setPage("two");
  } catch (error) {
    console.error(error);
    setStatus("Could not reach the Sidewalk server.", "error");
  } finally {
    setBusy(false);
  }
}

async function surpriseMe(): Promise<void> {
  setBusy(true);
  setStatus("Finding a Sidewalk quest…");

  try {
    const events = await requestSurprise();

    if (!events.length) {
      setStatus("No stored events yet. Run the seed and try again.", "error");
      return;
    }

    currentEvents = events;
    mapperTitle.textContent = "A surprise sidewalk";
    setStatus("Quest selected.", "success");
    setPage("two");
  } catch (error) {
    console.error(error);
    setStatus("Surprise mode failed.", "error");
  } finally {
    setBusy(false);
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

mapperButton.addEventListener("click", () => {
  setPage("two");
});

backButton.addEventListener("click", () => setPage("one"));

refreshButton.addEventListener("click", () => {
  renderEventList();
  showToast(currentEvents.length ? "Events refreshed." : "No events to show yet.");
});
