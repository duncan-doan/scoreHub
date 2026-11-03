// Express server: the pages, the JSON API and the admin PIN check (docs/SPEC.md §9–§10).
import express from 'express';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyChange, computeState, RuleError } from './rules.js';
import { openDb } from './db.js';

const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_WRONG_PINS = 10;
// Rule error codes that aren't 409 Conflict (SPEC §10).
const STATUS = { not_found: 404, invalid_input: 422, invalid_set: 422, extra_set: 422, incomplete: 422, draw_mismatch: 422 };

const sha256 = (s) => createHash('sha256').update(s).digest();

// §9: every write needs the PIN. 10 wrong PINs from one address within 15 minutes block it for 15 minutes.
function requirePin(pin, now) {
  const expected = sha256(pin);
  const attempts = new Map(); // ip → { wrong: [times], blockedUntil }
  return (req, res, next) => {
    const t = now();
    const a = attempts.get(req.ip) ?? { wrong: [], blockedUntil: 0 };
    if (a.blockedUntil > t) return res.status(429).json({ error: 'too_many_attempts' });
    if (timingSafeEqual(sha256(req.get('X-Admin-Pin') ?? ''), expected)) {
      attempts.delete(req.ip);
      return next();
    }
    a.wrong = [...a.wrong.filter((w) => t - w < LOCKOUT_MS), t];
    if (a.wrong.length >= MAX_WRONG_PINS) a.blockedUntil = t + LOCKOUT_MS;
    attempts.set(req.ip, a);
    res.status(401).json({ error: 'wrong_pin' });
  };
}

export function createApp({ db, seed, pin, now = Date.now }) {
  const app = express();
  const admin = requirePin(pin, now);
  const state = () => {
    const { results, draws } = db.load();
    return computeState(seed, results, draws);
  };

  // Applies one change from the request, saves the row it touched and replies with the new state.
  // A refused change replies with the error code and the current state, so the page can reload it.
  const write = (toChange) => (req, res) => {
    const change = toChange(req.params, req.body ?? {});
    try {
      res.json(
        db.transaction(() => {
          const { results, draws } = db.load();
          const next = applyChange(seed, results, draws, change);
          if (change.type === 'draw') db.saveDraw(change.group, next.draws[change.group]);
          else db.saveResult(change.match, next.results[change.match]);
          return next.state;
        }),
      );
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      res.status(STATUS[err.code] ?? 409).json({ error: err.code, details: err.details, state: state() });
    }
  };

  // §10: player names are on a public address, so ask search engines not to index anything.
  app.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));
  // The browser uses the same rules engine for the winner preview while a score is typed.
  app.get('/rules.js', (req, res) => res.sendFile(fileURLToPath(new URL('./rules.js', import.meta.url))));
  app.use('/api', express.json({ limit: '10kb' }), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/state', (req, res) => res.json(state()));
  app.post('/api/login', admin, (req, res) => res.status(204).end());
  app.put('/api/matches/:id/sets', admin, write((p, b) => ({ type: 'sets', match: p.id, sets: b.sets })));
  app.put('/api/matches/:id/serve', admin, write((p, b) => ({ type: 'serve', match: p.id, side: b.side })));
  app.post('/api/matches/:id/point', admin, write((p, b) => ({ type: 'point', match: p.id, side: b.side, count: b.count })));
  app.post('/api/matches/:id/undo', admin, write((p, b) => ({ type: 'undo', match: p.id, count: b.count })));
  app.post('/api/matches/:id/walkover', admin, write((p, b) => ({ type: 'walkover', match: p.id, winner: b.winner })));
  app.delete('/api/matches/:id', admin, write((p) => ({ type: 'clear', match: p.id })));
  app.put('/api/draws/:group', admin, write((p, b) => ({ type: 'draw', group: p.group, order: b.order })));
  // §5.5–§5.6: clears everything after saving a backup file and, if anything was entered, a History entry.
  // The page sends the PIN typed again as the confirmation.
  app.delete('/api/results', admin, (req, res) => {
    const backup = db.snapshot();
    const archived = db.transaction(() => {
      const { results, draws } = db.load();
      const entered = Object.keys(results).length > 0 || Object.keys(draws).length > 0;
      const id = entered ? db.archive(computeState(seed, results, draws)) : null;
      db.clearAll();
      return id;
    });
    res.json({ ...state(), backup, archived });
  });
  app.get('/api/history', admin, (req, res) => res.json(db.historyList()));
  app.get('/api/history/:id', admin, (req, res) => {
    const entry = db.historyEntry(Number(req.params.id));
    if (entry) res.json(entry);
    else res.status(404).json({ error: 'not_found' });
  });
  app.delete('/api/history/:id', admin, (req, res) => {
    if (db.deleteHistory(Number(req.params.id))) res.json(db.historyList());
    else res.status(404).json({ error: 'not_found' });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(422).json({ error: 'invalid_input' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pin = process.env.ADMIN_PIN ?? '';
  if (pin.length < 6) {
    console.error('ADMIN_PIN must be set to at least 6 characters.');
    process.exit(1);
  }
  const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
  createApp({ db: openDb(), seed, pin }).listen(3000, () => console.log('Listening on http://localhost:3000'));
}
