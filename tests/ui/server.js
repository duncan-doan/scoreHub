// The app for the Playwright checks: an empty in-memory tournament, a fixed PIN, port 3100.
import { readFileSync } from 'node:fs';
import { createApp } from '../../server/index.js';
import { openDb } from '../../server/db.js';

const seed = JSON.parse(readFileSync(new URL('../../server/seed.json', import.meta.url), 'utf8'));
createApp({ db: openDb(':memory:'), seed, pin: 'court-21' }).listen(3100, () => console.log('UI test app on http://localhost:3100'));
