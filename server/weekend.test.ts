import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isInWindow, weekendWindow } from './weekend.js';

// Every fixture below is stated as a UTC instant with its New York wall-clock
// equivalent in the comment, because the two disagree for exactly the events this
// window has to get right — a Sunday-night show in NYC is Monday in UTC.
describe('weekendWindow', () => {
  it('points at the upcoming Saturday and Sunday on a weekday', () => {
    // Thu 2026-08-27, 2pm New York.
    const window = weekendWindow(new Date('2026-08-27T18:00:00Z'));

    assert.equal(window.today, '2026-08-27');
    assert.equal(window.saturday, '2026-08-29');
    assert.equal(window.sunday, '2026-08-30');
  });

  it('spans New York midnight Saturday to New York midnight Monday', () => {
    const window = weekendWindow(new Date('2026-08-27T18:00:00Z'));

    // EDT is UTC-4, so New York midnight is 04:00Z.
    assert.equal(window.startIso, '2026-08-29T04:00:00Z');
    assert.equal(window.endIso, '2026-08-31T04:00:00Z');
  });

  it('shifts the bounds by an hour in winter, when New York is on EST', () => {
    // Thu 2027-01-07, 7am New York. EST is UTC-5.
    const window = weekendWindow(new Date('2027-01-07T12:00:00Z'));

    assert.equal(window.saturday, '2027-01-09');
    assert.equal(window.startIso, '2027-01-09T05:00:00Z');
    assert.equal(window.endIso, '2027-01-11T05:00:00Z');
  });

  it('treats Saturday itself as this weekend, not the next one', () => {
    // Sat 2026-08-29, 8am New York.
    const window = weekendWindow(new Date('2026-08-29T12:00:00Z'));

    assert.equal(window.saturday, '2026-08-29');
    assert.equal(window.sunday, '2026-08-30');
  });

  it('treats Sunday as the tail of the weekend that has already started', () => {
    // Sun 2026-08-30, 8am New York.
    const window = weekendWindow(new Date('2026-08-30T12:00:00Z'));

    assert.equal(window.saturday, '2026-08-29');
    assert.equal(window.sunday, '2026-08-30');
  });

  it('still says "this weekend" late on Sunday night, when UTC has rolled to Monday', () => {
    // Sun 2026-08-30, 10pm New York — but 2026-08-31 in UTC.
    const window = weekendWindow(new Date('2026-08-31T02:00:00Z'));

    assert.equal(window.today, '2026-08-30');
    assert.equal(window.saturday, '2026-08-29');
  });

  it('rolls over to the next weekend on Monday', () => {
    // Mon 2026-08-31, 8am New York.
    const window = weekendWindow(new Date('2026-08-31T12:00:00Z'));

    assert.equal(window.saturday, '2026-09-05');
    assert.equal(window.sunday, '2026-09-06');
  });

  it('crosses a year boundary without arithmetic on the month', () => {
    // Thu 2026-12-31, 7am New York.
    const window = weekendWindow(new Date('2026-12-31T12:00:00Z'));

    assert.equal(window.saturday, '2027-01-02');
    assert.equal(window.sunday, '2027-01-03');
  });
});

describe('isInWindow', () => {
  const window = weekendWindow(new Date('2026-08-27T18:00:00Z'));

  it('accepts an event starting inside the weekend', () => {
    assert.equal(isInWindow('2026-08-29T21:00:00Z/2026-08-29T22:00:00Z', window), true);
  });

  it('judges the interval by its start, not its end', () => {
    // Starts Sat 6pm New York, ends after midnight. The Saturday start is what counts.
    assert.equal(isInWindow('2026-08-29T22:00:00Z/2026-08-30T01:30:00Z', window), true);
  });

  it('accepts a Sunday-night event whose UTC date is already Monday', () => {
    // Sun 2026-08-30, 11pm New York.
    assert.equal(isInWindow('2026-08-31T03:00:00Z/2026-08-31T04:00:00Z', window), true);
  });

  it('rejects a Friday-night event (spec.md Decision 5: Saturday-Sunday only)', () => {
    // Fri 2026-08-28, 9pm New York.
    assert.equal(isInWindow('2026-08-29T01:00:00Z/2026-08-29T03:00:00Z', window), false);
  });

  it('rejects last weekend and next weekend', () => {
    assert.equal(isInWindow('2026-08-22T21:00:00Z/2026-08-22T22:00:00Z', window), false);
    assert.equal(isInWindow('2026-09-05T21:00:00Z/2026-09-05T22:00:00Z', window), false);
  });

  it('accepts a bare instant with no end half', () => {
    assert.equal(isInWindow('2026-08-29T21:00:00Z', window), true);
  });

  it('rejects an unparseable time rather than throwing', () => {
    assert.equal(isInWindow('sometime saturday', window), false);
    assert.equal(isInWindow('', window), false);
  });
});
