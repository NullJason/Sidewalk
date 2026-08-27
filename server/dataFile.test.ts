import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { appendToDataFile, mergeEvents, type DataFileEvent } from './dataFile.js';

const existing: DataFileEvent[] = [
  {
    title: 'Bryant Park Picnic Performance',
    time: '2026-08-29T21:00:00Z/2026-08-29T22:00:00Z',
    url: 'https://www.nycgovparks.org/events/bryant-park',
    location: 'Bryant Park Lawn, Manhattan',
    event_type: 'concert',
    lat: 40.7536,
    lon: -73.9832
  }
];

const incoming = (overrides: Record<string, unknown> = {}) => ({
  title: 'Prospect Park Night Market',
  time: '2026-08-30T22:00:00Z/2026-08-31T01:00:00Z',
  url: 'https://www.prospectpark.org/night-market',
  location: 'Grand Army Plaza, Brooklyn',
  event_type: 'market',
  lat: 40.6743,
  lon: -73.9707,
  ...overrides
});

function scratchFile(contents?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'sidewalk-')), 'data.json');
  if (contents !== undefined) writeFileSync(path, contents, 'utf8');
  return path;
}

const read = (path: string): DataFileEvent[] => JSON.parse(readFileSync(path, 'utf8'));

describe('mergeEvents', () => {
  it('appends what is new and leaves what was already there in place', () => {
    const { merged, appended, skipped } = mergeEvents(existing, [incoming()]);

    assert.equal(appended, 1);
    assert.equal(skipped, 0);
    assert.deepEqual(merged[0], existing[0]);
    assert.equal(merged[1]?.title, 'Prospect Park Night Market');
  });

  it('drops fields that are not part of the file — id, description, why', () => {
    const stop = { ...incoming(), id: 7, description: 'Stalls and string lights.', why: 'Cheap.' };
    const [, added] = mergeEvents(existing, [stop]).merged;

    assert.deepEqual(Object.keys(added ?? {}), [
      'title',
      'time',
      'url',
      'location',
      'event_type',
      'lat',
      'lon'
    ]);
  });

  it('writes no coordinate at all when either half is missing', () => {
    const { merged } = mergeEvents(existing, [incoming({ lat: null, lon: null })]);

    assert.equal('lat' in (merged[1] ?? {}), false);
    assert.equal('lon' in (merged[1] ?? {}), false);
  });

  it('skips an event it already holds, by url', () => {
    const again = incoming({ url: existing[0]?.url, title: 'A different name entirely' });

    assert.deepEqual(mergeEvents(existing, [again]), { merged: existing, appended: 0, skipped: 1 });
  });

  it('skips the same event found on another page, by title and date', () => {
    // The two sites punctuate it differently and the urls differ; dedupeKey folds the
    // punctuation away, which is the same call ingest.ts makes against SQLite.
    const again = incoming({
      title: 'Bryant Park Picnic Performance!',
      time: '2026-08-29T23:00:00Z',
      url: 'https://bryantpark.org/whats-on/picnic-performance'
    });

    assert.equal(mergeEvents(existing, [again]).appended, 0);
  });

  it('dedupes a batch against itself, not only against the file', () => {
    const { appended, skipped } = mergeEvents([], [incoming(), incoming()]);

    assert.equal(appended, 1);
    assert.equal(skipped, 1);
  });
});

describe('appendToDataFile', () => {
  it('creates the list when there is no file yet', () => {
    const path = scratchFile();

    assert.equal(appendToDataFile([incoming()], path).appended, 1);
    assert.equal(read(path).length, 1);
  });

  it('appends to what is on disk and leaves it formatted as authored', () => {
    const path = scratchFile(`${JSON.stringify(existing, null, 2)}\n`);

    appendToDataFile([incoming()], path);

    const text = readFileSync(path, 'utf8');
    assert.equal(read(path).length, 2);
    assert.ok(text.includes('\n  {\n    "title"'), 'two-space indented');
    assert.ok(text.endsWith('}\n]\n'), 'trailing newline');
  });

  it('is safe to run twice — the second run writes nothing', () => {
    const path = scratchFile(`${JSON.stringify(existing, null, 2)}\n`);

    appendToDataFile([incoming()], path);
    const after = readFileSync(path, 'utf8');

    assert.deepEqual(appendToDataFile([incoming()], path), { appended: 0, skipped: 1 });
    assert.equal(readFileSync(path, 'utf8'), after, 'untouched when nothing is new');
  });

  it('refuses to overwrite a file it cannot read rather than starting a new list', () => {
    // data.json is the only copy of this data that git tracks, so treating a broken
    // file as an empty one would replace every event we hold with whatever is in hand.
    const path = scratchFile('{ not json at all');

    assert.throws(() => appendToDataFile([incoming()], path));
    assert.equal(readFileSync(path, 'utf8'), '{ not json at all');
  });
});
