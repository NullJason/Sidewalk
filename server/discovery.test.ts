import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDiscoveryPrompt, dedupeKey, parseDiscoveries } from './discovery.js';
import { weekendWindow } from './weekend.js';

// Thu 2026-08-27 in New York, so the weekend is Sat 2026-08-29 / Sun 2026-08-30.
const weekend = weekendWindow(new Date('2026-08-27T18:00:00Z'));

interface RawEvent {
  title?: unknown;
  time?: unknown;
  url?: unknown;
  location?: unknown;
  event_type?: unknown;
  lat?: unknown;
  lon?: unknown;
}

const saturday: RawEvent = {
  title: 'Bryant Park Picnic Performance',
  time: '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z',
  url: 'https://www.nycgovparks.org/events/bryant-park',
  location: 'Bryant Park Lawn, Manhattan',
  event_type: 'concert',
  lat: 40.7536,
  lon: -73.9832
};

const reply = (...events: RawEvent[]): string => JSON.stringify({ events });
const parse = (...events: RawEvent[]) => parseDiscoveries(reply(...events), weekend);
const titles = (...events: RawEvent[]): string[] =>
  parse(...events).events.map((event) => event.title);

describe('buildDiscoveryPrompt', () => {
  it('anchors the search on the exact weekend dates, not on "this weekend"', () => {
    const prompt = buildDiscoveryPrompt(weekend);

    assert.match(prompt, /2026-08-27/); // today
    assert.match(prompt, /2026-08-29/); // saturday
    assert.match(prompt, /2026-08-30/); // sunday
    assert.match(prompt, /New York City/);
  });
});

describe('parseDiscoveries', () => {
  it('keeps a well-formed event', () => {
    const [event] = parse(saturday).events;

    assert.equal(event?.title, 'Bryant Park Picnic Performance');
    assert.equal(event?.url, 'https://www.nycgovparks.org/events/bryant-park');
    assert.equal(event?.location, 'Bryant Park Lawn, Manhattan');
    assert.equal(event?.event_type, 'concert');
    assert.equal(event?.lat, 40.7536);
    assert.equal(event?.lon, -73.9832);
  });

  it('reads the events out of JSON the model wrapped in prose', () => {
    const text = ['Here you go:', '```json', reply(saturday), '```', 'Hope that helps.'].join('\n');

    assert.deepEqual(
      parseDiscoveries(text, weekend).events.map((event) => event.title),
      ['Bryant Park Picnic Performance']
    );
  });

  it('rewrites a local-offset interval as UTC, so stored times are all one shape', () => {
    const [event] = parse({
      ...saturday,
      time: '2026-08-29T17:00:00-04:00/2026-08-29T18:00:00-04:00'
    }).events;

    assert.equal(event?.time, '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z');
  });

  it('reads a time with no offset as New York, not as the machine running this', () => {
    // 5pm on an August Saturday in New York is 21:00Z. Bare "T17:00:00" would otherwise
    // mean whatever the host's clock means by it — UTC on the deploy box.
    const [event] = parse({ ...saturday, time: '2026-08-29T17:00:00/2026-08-29T18:00:00' }).events;

    assert.equal(event?.time, '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z');
  });

  it('reads a bare date as New York midnight', () => {
    const [event] = parse({ ...saturday, time: '2026-08-29' }).events;

    assert.equal(event?.time, '2026-08-29T04:00:00Z');
  });

  it('accepts a bare start with no end half', () => {
    const [event] = parse({ ...saturday, time: '2026-08-29T21:00:00Z' }).events;

    assert.equal(event?.time, '2026-08-29T21:00:00Z');
  });

  it('joins several types into the comma-separated shape the column stores', () => {
    const [event] = parse({ ...saturday, event_type: ['fitness', 'outdoor fitness'] }).events;

    assert.equal(event?.event_type, 'fitness,outdoor fitness');
  });

  it('drops an event with no citation url', () => {
    const result = parse({ ...saturday, url: '' }, { ...saturday, url: undefined });

    assert.deepEqual(result.events, []);
    assert.equal(result.dropped.noUrl, 2);
  });

  it('drops an event whose url is not a web address', () => {
    const result = parse({ ...saturday, url: 'nycgovparks.org/events' });

    assert.deepEqual(result.events, []);
    assert.equal(result.dropped.noUrl, 1);
  });

  it('drops a Friday-night event, whatever the prompt asked for', () => {
    // Fri 2026-08-28, 9pm New York — already Saturday in UTC.
    const result = parse({ ...saturday, time: '2026-08-29T01:00:00Z/2026-08-29T03:00:00Z' });

    assert.deepEqual(result.events, []);
    assert.equal(result.dropped.outsideWindow, 1);
  });

  it('drops a stale event from a past weekend', () => {
    const result = parse({ ...saturday, time: '2026-08-22T21:00:00Z/2026-08-22T22:00:00Z' });

    assert.deepEqual(result.events, []);
    assert.equal(result.dropped.outsideWindow, 1);
  });

  it('keeps a Sunday-night event whose UTC date has rolled to Monday', () => {
    assert.deepEqual(titles({ ...saturday, time: '2026-08-31T03:00:00Z' }), [
      'Bryant Park Picnic Performance'
    ]);
  });

  it('drops an entry missing a title, a location, or a usable time', () => {
    const result = parse(
      { ...saturday, title: '' },
      { ...saturday, location: undefined },
      { ...saturday, time: 'this Saturday evening' }
    );

    assert.deepEqual(result.events, []);
    assert.equal(result.dropped.malformed, 3);
  });

  it('drops later copies of an event found twice in one run', () => {
    const result = parse(saturday, {
      ...saturday,
      title: '  bryant park   PICNIC performance ',
      url: 'https://bryantpark.org/events/picnic'
    });

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.url, 'https://www.nycgovparks.org/events/bryant-park');
    assert.equal(result.dropped.duplicate, 1);
  });

  it('drops a second event that repeats a url under a different name', () => {
    const result = parse(saturday, { ...saturday, title: 'Sunset Circus' });

    assert.equal(result.events.length, 1);
    assert.equal(result.dropped.duplicate, 1);
  });

  it('keeps the same event running on both days of the weekend', () => {
    const sunday = {
      ...saturday,
      time: '2026-08-30T21:00:00Z/2026-08-30T22:00:00Z',
      url: 'https://www.nycgovparks.org/events/bryant-park-sunday'
    };

    assert.deepEqual(titles(saturday, sunday), [
      'Bryant Park Picnic Performance',
      'Bryant Park Picnic Performance'
    ]);
  });

  it('keeps an event that has no coordinates, with nothing filled in for them', () => {
    const [event] = parse({ ...saturday, lat: null, lon: undefined }).events;

    assert.equal(event?.title, 'Bryant Park Picnic Performance');
    assert.equal(event?.lat, null);
    assert.equal(event?.lon, null);
  });

  it('keeps an event but not a placeholder coordinate', () => {
    // 0,0 is the Atlantic. A model that could not resolve a location writes it anyway.
    const [nullIsland] = parse({ ...saturday, lat: 0, lon: 0 }).events;
    assert.equal(nullIsland?.lat, null);

    // Paris is a hallucination, not a New York venue.
    const [elsewhere] = parse({ ...saturday, lat: 48.8584, lon: 2.2945 }).events;
    assert.equal(elsewhere?.title, 'Bryant Park Picnic Performance');
    assert.equal(elsewhere?.lat, null);
    assert.equal(elsewhere?.lon, null);
  });

  it('drops half a coordinate rather than pinning an event to a meridian', () => {
    const [event] = parse({ ...saturday, lon: undefined }).events;

    assert.equal(event?.lat, null);
    assert.equal(event?.lon, null);
  });

  it('returns nothing rather than throwing when the model answers with prose', () => {
    const result = parseDiscoveries('I could not find any events this weekend.', weekend);

    assert.deepEqual(result.events, []);
  });

  it('returns nothing rather than throwing when "events" is not a list', () => {
    const result = parseDiscoveries(JSON.stringify({ events: 'none found' }), weekend);

    assert.deepEqual(result.events, []);
  });
});

describe('dedupeKey', () => {
  it('reads the same event stored two ways as one event', () => {
    assert.equal(
      dedupeKey({ title: 'Birding Tour', time: '2026-08-29T12:00:00Z/2026-08-29T14:00:00Z' }),
      dedupeKey({ title: '  birding   tour ', time: '2026-08-29T08:00:00-04:00' })
    );
  });

  it('reads past two sites punctuating the same title differently', () => {
    // Seen in a real run: the parks calendar and the venue's own page disagreed on
    // which apostrophe to use, and the screening was stored twice.
    assert.equal(
      dedupeKey({ title: 'Soundtrack to a Coup d’Etat', time: '2026-08-29T22:00:00Z' }),
      dedupeKey({ title: "Soundtrack to a Coup d'Etat", time: '2026-08-29T22:00:00Z' })
    );
  });

  it('separates the same event on two different days', () => {
    assert.notEqual(
      dedupeKey({ title: 'Birding Tour', time: '2026-08-29T12:00:00Z' }),
      dedupeKey({ title: 'Birding Tour', time: '2026-08-30T12:00:00Z' })
    );
  });

  it('keys a Sunday-night event on its New York date, not its UTC one', () => {
    // Sun 2026-08-30, 11pm New York is Mon 2026-08-31 in UTC. Both spellings of the
    // same instant have to key alike, or a re-run stores the event a second time.
    assert.equal(
      dedupeKey({ title: 'Late Show', time: '2026-08-31T03:00:00Z' }),
      dedupeKey({ title: 'Late Show', time: '2026-08-30T23:00:00-04:00' })
    );
  });
});
