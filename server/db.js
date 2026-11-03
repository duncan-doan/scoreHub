// SQLite storage for what people enter (docs/ARCHITECTURE.md §3). Everything else is computed by rules.js.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
export const DB_FILE = join(DATA_DIR, 'tournament.db');

export function openDb(file = DB_FILE) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS results (
      match_id   TEXT PRIMARY KEY,
      kind       TEXT NOT NULL CHECK (kind IN ('sets', 'live', 'walkover')),
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS draws (
      group_id   TEXT PRIMARY KEY,
      team_codes TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const q = {
    results: db.prepare('SELECT match_id, kind, data FROM results'),
    draws: db.prepare('SELECT group_id, team_codes FROM draws'),
    putResult: db.prepare(`
      INSERT INTO results (match_id, kind, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (match_id) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at`),
    deleteResult: db.prepare('DELETE FROM results WHERE match_id = ?'),
    putDraw: db.prepare(`
      INSERT INTO draws (group_id, team_codes, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (group_id) DO UPDATE SET team_codes = excluded.team_codes, updated_at = excluded.updated_at`),
    clearResults: db.prepare('DELETE FROM results'),
    clearDraws: db.prepare('DELETE FROM draws'),
  };

  return {
    // The inputs rules.js expects: { results: { [matchId]: { kind, data } }, draws: { [group]: [codes] } }.
    load() {
      const results = Object.fromEntries(q.results.all().map((r) => [r.match_id, { kind: r.kind, data: JSON.parse(r.data) }]));
      const draws = Object.fromEntries(q.draws.all().map((r) => [r.group_id, JSON.parse(r.team_codes)]));
      return { results, draws };
    },
    // A missing result means the match was cleared.
    saveResult(matchId, result) {
      if (result) q.putResult.run(matchId, result.kind, JSON.stringify(result.data), new Date().toISOString());
      else q.deleteResult.run(matchId);
    },
    saveDraw(group, order) {
      q.putDraw.run(group, JSON.stringify(order), new Date().toISOString());
    },
    // SPEC §5.5: everything people entered, removed at once.
    clearAll() {
      db.transaction(() => {
        q.clearResults.run();
        q.clearDraws.run();
      })();
    },
    // A full copy next to the database, taken just before clearing everything; returns its file name.
    // An in-memory database (tests) has no file to copy.
    snapshot() {
      if (file === ':memory:') return null;
      const name = `backup-before-clear-${new Date().toISOString().replace(/:/g, '')}.db`;
      db.prepare('VACUUM INTO ?').run(join(dirname(file), name));
      return name;
    },
    transaction: (fn) => db.transaction(fn)(),
    backup: (dest) => db.backup(dest),
    close: () => db.close(),
  };
}
