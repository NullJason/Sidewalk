import express from 'express';
import { countEvents, openDatabase } from './db.js';

const PORT = 3000;

const app = express();

// Creates missing tables and columns, and nothing else. Seeding is a separate,
// explicitly-run step: `npm run seed`.
const db = openDatabase();

app.get('/', (req, res) => {
  res.send('Hello World');
});

// Lets the Vite dev proxy be checked end to end before any real /api route exists.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  const stored = countEvents(db);

  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(
    stored > 0
      ? `${stored} event(s) in the database.`
      : 'No events in the database yet — run `npm run seed`.'
  );
});
