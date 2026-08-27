import express from 'express';
import Database from 'better-sqlite3';
import data from './sampleData.json' with { type: 'json' };

const app = express();
const db = new Database('sidewalk.db');

// create events table
db.prepare(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    time TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    location TEXT NOT NULL
  )
`).run();

// create event_types table
db.prepare(`
  CREATE TABLE IF NOT EXISTS event_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )
`).run();

// create event_tags table
db.prepare(`
  CREATE TABLE IF NOT EXISTS event_tags (
    event_id INTEGER NOT NULL,
    event_type_id INTEGER NOT NULL,
    PRIMARY KEY (event_id, event_type_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE CASCADE
  )
`).run();

// create insert into events statement
const insertEvent = db.prepare(`
  INSERT INTO events (title, time, url, location)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(url) DO NOTHING
`);

// create insert into event_types statement
const insertEventType = db.prepare(
  'INSERT OR IGNORE INTO event_types (name) VALUES (?)'
);

const getType = db.prepare(
  'SELECT id FROM event_types WHERE name = ?'
);

// create insert into event_tags statement
const insertEventTag = db.prepare(
  'INSERT OR IGNORE INTO event_tags (event_id, event_type_id) VALUES(?, ?)'
);

const getEvent = db.prepare(
  'SELECT id FROM events WHERE url = ?'
);

// read sample data into tables
for (const event of data) {
  insertEvent.run(
    event.title,
    event.time,
    event.url,
    event.location
  );

  const existingEvent = getEvent.get(event.url);

  // typescript warns that existingEvent is an unknown type
  const eventId = existingEvent.id;
  const types = event.event_type.split(',');

  for (const type of types) {
    const name = type.trim();

    insertEventType.run(name);

    const eventType = getType.get(name);

    insertEventTag.run(
      eventId,
      eventType.id
    )
  }
}

app.get('/', (req, res) => {
  res.send('Hello World');
});

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});
