import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredEvent } from './events.js';
import { fallbackPlan, MAX_STOPS, parsePlan } from './plan.js';

const candidates: StoredEvent[] = [
  {
    id: 1,
    title: 'Bryant Park Picnic Performance',
    time: '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z',
    url: 'https://www.nycgovparks.org/events/bryant-park',
    location: 'Bryant Park Lawn, Manhattan',
    event_type: 'concert',
    lat: 40.7536,
    lon: -73.9832
  },
  {
    id: 2,
    title: 'Birding Tour',
    time: '2026-08-29T12:00:00Z/2026-08-29T14:00:00Z',
    url: 'https://www.nycgovparks.org/events/birding',
    location: 'Riverside Drive, Manhattan',
    event_type: 'birding',
    lat: 40.8087,
    lon: -73.9664
  },
  {
    // No coordinates: this one plans and lists, it just gets no pin.
    id: 3,
    title: 'Circuit Training',
    time: '2026-08-30T13:30:00Z/2026-08-30T14:15:00Z',
    url: 'https://www.nycgovparks.org/events/circuit',
    location: 'St Johns Recreation Center, Brooklyn',
    event_type: 'fitness,recreation center'
  }
];

const reply = (body: unknown): string => JSON.stringify(body);
const ids = (plan: { stops: StoredEvent[] }): number[] => plan.stops.map((stop) => stop.id);

describe('parsePlan', () => {
  it('reads the plan title and the selected stop', () => {
    const plan = parsePlan(
      reply({
        planTitle: 'Cheap and Outside Saturday',
        stops: [{ id: 2, description: 'Binoculars optional.', why: 'Free and outdoors.' }]
      }),
      candidates
    );

    assert.equal(plan.planTitle, 'Cheap and Outside Saturday');
    assert.equal(plan.stops[0]?.title, 'Birding Tour');
    assert.equal(plan.stops[0]?.description, 'Binoculars optional.');
    assert.equal(plan.stops[0]?.why, 'Free and outdoors.');
  });

  it('keeps the model ordering', () => {
    const plan = parsePlan(
      reply({ planTitle: 'x', stops: [{ id: 3 }, { id: 1 }, { id: 2 }] }),
      candidates
    );

    assert.deepEqual(ids(plan), [3, 1, 2]);
  });

  it('takes every stored field from the database row, never from the model', () => {
    // Gemini echoing a mangled url or a shifted time is the failure this guards.
    const plan = parsePlan(
      reply({
        planTitle: 'Anything',
        stops: [
          {
            id: 1,
            title: 'A Completely Different Party',
            url: 'https://example.com/invented',
            time: '2026-12-25T00:00:00Z/2026-12-25T01:00:00Z',
            location: 'Somewhere else',
            event_type: 'rave',
            lat: 0,
            lon: 0,
            why: 'Trust me.'
          }
        ]
      }),
      candidates
    );

    const [stop] = plan.stops;
    assert.equal(stop?.title, 'Bryant Park Picnic Performance');
    assert.equal(stop?.url, 'https://www.nycgovparks.org/events/bryant-park');
    assert.equal(stop?.time, '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z');
    assert.equal(stop?.location, 'Bryant Park Lawn, Manhattan');
    assert.equal(stop?.event_type, 'concert');
    assert.equal(stop?.lat, 40.7536);
    assert.equal(stop?.lon, -73.9832);
    // Only these two are the model's to write.
    assert.equal(stop?.why, 'Trust me.');
  });

  it('drops a stop whose id was not among the candidates', () => {
    const plan = parsePlan(
      reply({ planTitle: 'x', stops: [{ id: 999, why: 'invented' }, { id: 1, why: 'real' }] }),
      candidates
    );

    assert.equal(plan.stops[0]?.id, 1);
    assert.equal(
      plan.stops.some((stop) => stop.id === 999),
      false
    );
  });

  it('caps the itinerary at three stops', () => {
    const plan = parsePlan(
      reply({ planTitle: 'x', stops: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 1 }] }),
      candidates
    );

    assert.equal(plan.stops.length, 3);
  });

  it('does not repeat an event the model listed twice', () => {
    const plan = parsePlan(reply({ planTitle: 'x', stops: [{ id: 1 }, { id: 1 }] }), candidates);

    assert.equal(new Set(ids(plan)).size, plan.stops.length);
    assert.equal(plan.stops[0]?.id, 1);
  });

  it('tops up to three stops when the model under-delivers', () => {
    // Two picks against three candidates breaks "exactly 3 stops"; the third comes
    // from what the model left on the table, in start order.
    const plan = parsePlan(reply({ planTitle: 'x', stops: [{ id: 3 }, { id: 1 }] }), candidates);

    assert.deepEqual(ids(plan), [3, 1, 2]);
  });

  it('leaves a topped-up stop without a description or why, rather than inventing one', () => {
    const plan = parsePlan(
      reply({ planTitle: 'x', stops: [{ id: 1, description: 'Real.', why: 'Real.' }] }),
      candidates
    );

    assert.equal(plan.stops[0]?.why, 'Real.');
    assert.equal('why' in (plan.stops[1] ?? {}), false);
    assert.equal('description' in (plan.stops[1] ?? {}), false);
  });

  it('returns fewer than three only when fewer candidates exist', () => {
    const plan = parsePlan(reply({ planTitle: 'x', stops: [{ id: 1 }] }), [candidates[0]!]);

    assert.equal(plan.stops.length, 1);
  });

  it('omits lat/lon for a stored event that has none, rather than guessing', () => {
    const plan = parsePlan(reply({ planTitle: 'x', stops: [{ id: 3 }] }), [candidates[2]!]);

    assert.equal('lat' in (plan.stops[0] ?? {}), false);
    assert.equal('lon' in (plan.stops[0] ?? {}), false);
  });

  it('omits an empty description instead of rendering a blank line', () => {
    // url_context may not yield enough to summarize; the ticket allows this.
    const plan = parsePlan(
      reply({ planTitle: 'x', stops: [{ id: 1, description: '   ', why: 'Fits.' }] }),
      candidates
    );

    assert.equal('description' in (plan.stops[0] ?? {}), false);
    assert.equal(plan.stops[0]?.why, 'Fits.');
  });

  it('unwraps a fenced JSON code block', () => {
    const fenced = ['```json', '{"planTitle":"Fenced","stops":[{"id":1}]}', '```'].join('\n');
    const plan = parsePlan(fenced, candidates);

    assert.equal(plan.planTitle, 'Fenced');
    assert.equal(plan.stops[0]?.id, 1);
  });

  it('finds the JSON object inside surrounding prose', () => {
    const plan = parsePlan(
      'Here you go!\n{"planTitle":"Chatty","stops":[{"id":1}]}\nHope that helps.',
      candidates
    );

    assert.equal(plan.planTitle, 'Chatty');
  });

  it('falls back to a default title when the model omits one', () => {
    const plan = parsePlan(reply({ stops: [{ id: 1 }] }), candidates);

    assert.equal(plan.planTitle, 'Your weekend');
  });

  it('throws when the reply is not JSON at all, so the caller can fall back', () => {
    assert.throws(() => parsePlan('I could not find anything, sorry.', candidates));
  });

  it('throws when no stop survives validation', () => {
    // Nothing the model said was real, so there is no curation to top up.
    assert.throws(() => parsePlan(reply({ planTitle: 'x', stops: [{ id: 999 }] }), candidates));
  });
});

describe('fallbackPlan', () => {
  it('answers with the same shape as a curated plan', () => {
    const plan = fallbackPlan(candidates);

    assert.ok(plan.planTitle);
    assert.deepEqual(ids(plan), [1, 2, 3]);
    // The frontend has no special case for a failed curation, so every stop has to
    // carry the fields a curated stop carries.
    for (const stop of plan.stops) {
      assert.ok(stop.description);
      assert.ok(stop.why);
    }
  });

  it('stops at MAX_STOPS however many events it is handed', () => {
    const many = [...candidates, ...candidates.map((c) => ({ ...c, id: c.id + 100 }))];

    assert.equal(fallbackPlan(many).stops.length, MAX_STOPS);
  });

  it('copies the stored row through untouched, coordinates included', () => {
    const [first, , third] = fallbackPlan(candidates).stops;

    assert.equal(first?.title, 'Bryant Park Picnic Performance');
    assert.equal(first?.url, 'https://www.nycgovparks.org/events/bryant-park');
    assert.equal(first?.lat, 40.7536);
    // No coordinates in, no coordinates out — this stop simply gets no pin.
    assert.equal(third?.lat, undefined);
    assert.equal(third?.lon, undefined);
  });

  it('still returns a renderable body when there is nothing to pick from', () => {
    const plan = fallbackPlan([]);

    assert.ok(plan.planTitle);
    assert.deepEqual(plan.stops, []);
  });
});
