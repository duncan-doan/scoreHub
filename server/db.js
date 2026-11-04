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
    CREATE TABLE IF NOT EXISTS history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cleared_at TEXT NOT NULL,
      state      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS votes (
      award      TEXT NOT NULL,
      voter      TEXT NOT NULL,
      team_code  TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (award, voter)
    );
    CREATE TABLE IF NOT EXISTS awards (
      award  TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('not_open', 'open', 'closed'))
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
    addHistory: db.prepare('INSERT INTO history (cleared_at, state) VALUES (?, ?)'),
    history: db.prepare('SELECT id, cleared_at, state FROM history ORDER BY id DESC'),
    historyEntry: db.prepare('SELECT id, cleared_at, state FROM history WHERE id = ?'),
    deleteHistory: db.prepare('DELETE FROM history WHERE id = ?'),
    statuses: db.prepare('SELECT award, status FROM awards'),
    putStatus: db.prepare('INSERT INTO awards (award, status) VALUES (?, ?) ON CONFLICT (award) DO UPDATE SET status = excluded.status'),
    counts: db.prepare('SELECT award, team_code, COUNT(*) AS n FROM votes GROUP BY award, team_code'),
    mine: db.prepare('SELECT award, team_code FROM votes WHERE voter = ?'),
    putVote: db.prepare(`
      INSERT INTO votes (award, voter, team_code, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (award, voter) DO UPDATE SET team_code = excluded.team_code, updated_at = excluded.updated_at`),
    clearVotes: db.prepare('DELETE FROM votes'),
    clearStatuses: db.prepare('DELETE FROM awards'),
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
        q.clearVotes.run();
        q.clearStatuses.run();
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
    // SPEC §5.6: the computed tournament, saved as it was just before Clear All; returns the new entry's id.
    archive(state) {
      return Number(q.addHistory.run(new Date().toISOString(), JSON.stringify(state)).lastInsertRowid);
    },
    // Newest first, with what the list shows: when it was cleared, who won, how far it got.
    historyList() {
      return q.history.all().map((r) => {
        const s = JSON.parse(r.state);
        const champion = s.teams.find((t) => t.code === s.podium.champion)?.name ?? null;
        return { id: r.id, clearedAt: r.cleared_at, champion, finished: s.progress.finished, total: s.progress.total };
      });
    },
    historyEntry(id) {
      const r = q.historyEntry.get(id);
      return r ? { id: r.id, clearedAt: r.cleared_at, state: JSON.parse(r.state) } : null;
    },
    deleteHistory: (id) => q.deleteHistory.run(id).changes > 0,
    // SPEC §5.7: what votes.js voteSummary needs; voter is the phone asking (null for none).
    votesInput(voter) {
      const statuses = Object.fromEntries(q.statuses.all().map((r) => [r.award, r.status]));
      const counts = {};
      for (const r of q.counts.all()) (counts[r.award] ??= {})[r.team_code] = r.n;
      const mine = voter ? Object.fromEntries(q.mine.all(voter).map((r) => [r.award, r.team_code])) : {};
      return { statuses, counts, mine };
    },
    vote: (award, voter, team) => q.putVote.run(award, voter, team, new Date().toISOString()),
    setAwardStatus: (award, status) => q.putStatus.run(award, status),
    transaction: (fn) => db.transaction(fn)(),
    backup: (dest) => db.backup(dest),
    close: () => db.close(),
  };
}
