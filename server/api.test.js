// Tests for the HTTP layer around rules.js: PIN, lockout, status codes and storage (docs/SPEC.md §9–§10).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.js';
import { openDb } from './db.js';

const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const PIN = 'court-21';
const MINUTE = 60 * 1000;

// Both groups complete (SPEC §6.4 Examples 1 and 3): SF1 is A1 v B2, SF2 is B1 v A3.
const GROUPS_DONE = { G1: [21, 15], G4: [21, 18], G7: [19, 21], G2: [21, 19], G3: [15, 21], G5: [10, 21], G6: [21, 5], G8: [21, 19], G9: [21, 8] };

// Starts the app on a free port with its own database and a clock the test controls.
async function start(file = ':memory:') {
  let clock = 0;
  const db = openDb(file);
  const server = createApp({ db, seed, pin: PIN, now: () => clock }).listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, body, pin = PIN) => {
    const headers = { 'Content-Type': 'application/json', ...(pin && { 'X-Admin-Pin': pin }) };
    const payload = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(base + path, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const enter = async (scores) => {
    for (const [id, s] of Object.entries(scores)) {
      const r = await call('PUT', `/api/matches/${id}/sets`, { sets: Array.isArray(s[0]) ? s : [s] });
      assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body?.error)}`);
    }
  };
  const close = async () => {
    server.close();
    await once(server, 'close');
    db.close();
  };
  return { call, enter, close, tick: (ms) => (clock += ms) };
}

const match = (state, id) => state.matches.find((m) => m.id === id);

describe('API', () => {
  let api;
  beforeEach(async () => (api = await start()));
  afterEach(() => api.close());

  test('the state is public, never cached and not indexed', async () => {
    const r = await api.call('GET', '/api/state', undefined, null);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.progress, { finished: 0, total: 13 });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('x-robots-tag'), /noindex/);
  });

  test('every write needs the PIN', async () => {
    const sets = { sets: [[21, 15]] };
    assert.deepEqual((await api.call('PUT', '/api/matches/G1/sets', sets, null)).body, { error: 'wrong_pin' });
    assert.equal((await api.call('PUT', '/api/matches/G1/sets', sets, 'guess-1')).status, 401);
    const ok = await api.call('PUT', '/api/matches/G1/sets', sets);
    assert.equal(ok.status, 200);
    assert.equal(match(ok.body, 'G1').state, 'finished');
    assert.equal((await api.call('POST', '/api/login')).status, 204);
    assert.equal((await api.call('POST', '/api/login', undefined, 'guess-2')).status, 401);
  });

  test('10 wrong PINs within 15 minutes block the address for 15 minutes', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await api.call('POST', '/api/login', undefined, `guess-${i}`)).status, 401);
    const blocked = await api.call('POST', '/api/login');
    assert.deepEqual([blocked.status, blocked.body], [429, { error: 'too_many_attempts' }]);
    api.tick(15 * MINUTE);
    assert.equal((await api.call('POST', '/api/login')).status, 204);
  });

  test('wrong PINs more than 15 minutes apart do not add up', async () => {
    for (let i = 0; i < 9; i++) await api.call('POST', '/api/login', undefined, `guess-${i}`);
    api.tick(16 * MINUTE);
    for (let i = 0; i < 9; i++) assert.equal((await api.call('POST', '/api/login', undefined, `guess-${i}`)).status, 401);
    assert.equal((await api.call('POST', '/api/login')).status, 204);
  });

  test('a whole tournament entered through the API gives the expected podium', async () => {
    await api.enter({ ...GROUPS_DONE, SF1: [21, 15], SF2: [19, 21], FINAL: [[15, 12], [13, 15], [16, 14]] });
    const last = await api.call('POST', '/api/matches/THIRD/walkover', { winner: 2 });
    assert.equal(last.status, 200);
    assert.deepEqual(last.body.podium, { champion: 'A1', runnerUp: 'A3', third: 'B1' });
    assert.deepEqual((await api.call('GET', '/api/state')).body.progress, { finished: 13, total: 13 });
  });

  test('a late group correction is refused, with the current state', async () => {
    await api.enter({ ...GROUPS_DONE, SF1: [21, 15] });
    const r = await api.call('PUT', '/api/matches/G1/sets', { sets: [[21, 10]] });
    assert.equal(r.status, 409);
    assert.deepEqual([r.body.error, r.body.details], ['locked', { by: ['SF1'] }]);
    assert.deepEqual(match(r.body.state, 'G1').sets, [[21, 15]]);
  });

  test('a duplicate live tap is refused, with the current score', async () => {
    assert.equal((await api.call('PUT', '/api/matches/G1/serve', { side: 1 })).status, 200);
    const first = await api.call('POST', '/api/matches/G1/point', { side: 1, count: 0 });
    assert.deepEqual([first.status, match(first.body, 'G1').current], [200, [1, 0]]);
    const again = await api.call('POST', '/api/matches/G1/point', { side: 1, count: 0 });
    assert.deepEqual([again.status, again.body.error, again.body.details], [409, 'count_mismatch', { count: 1 }]);
    assert.deepEqual(match(again.body.state, 'G1').current, [1, 0]);
    const undone = await api.call('POST', '/api/matches/G1/undo', { count: 1 });
    assert.deepEqual(match(undone.body, 'G1').current, [0, 0]);
  });

  test('draws and clears go through the API', async () => {
    await api.enter({ ...GROUPS_DONE, G1: [21, 19], G4: [21, 19], G7: [19, 21] });
    const drawn = await api.call('PUT', '/api/draws/A', { order: ['A3', 'A1', 'A2'] });
    assert.deepEqual(drawn.body.groups.A.rows.map((r) => r.code), ['A3', 'A1', 'A2']);
    const cleared = await api.call('DELETE', '/api/matches/G9');
    assert.equal(match(cleared.body, 'G9').state, 'ready');
  });

  test('clearing everything needs the PIN and empties the tournament', async () => {
    await api.enter({ ...GROUPS_DONE, G1: [21, 19], G4: [21, 19], G7: [19, 21] });
    await api.call('PUT', '/api/draws/A', { order: ['A3', 'A1', 'A2'] });
    assert.equal((await api.call('DELETE', '/api/results', undefined, null)).status, 401);
    const r = await api.call('DELETE', '/api/results');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.progress, { finished: 0, total: 13 });
    assert.equal(r.body.groups.A.drawTie, null);
    assert.equal(r.body.backup, null); // an in-memory database has no file to back up
  });

  test('Clear All saves the tournament in History first; History is for organizers only', async () => {
    await api.enter({ ...GROUPS_DONE, SF1: [21, 15] });
    const cleared = await api.call('DELETE', '/api/results');
    assert.equal(typeof cleared.body.archived, 'number');
    assert.equal(cleared.body.progress.finished, 0);

    assert.equal((await api.call('GET', '/api/history', undefined, null)).status, 401);
    const list = await api.call('GET', '/api/history');
    assert.equal(list.body.length, 1);
    assert.deepEqual({ ...list.body[0], clearedAt: 'x' }, { id: cleared.body.archived, clearedAt: 'x', champion: null, finished: 10, total: 13 });
    assert.ok(!Number.isNaN(Date.parse(list.body[0].clearedAt)));

    const entry = await api.call('GET', `/api/history/${cleared.body.archived}`);
    assert.equal(entry.body.state.progress.finished, 10);
    assert.deepEqual(entry.body.state.matches.find((m) => m.id === 'SF1').sets, [[21, 15]]);
    assert.equal((await api.call('GET', `/api/history/${cleared.body.archived}`, undefined, null)).status, 401);
  });

  test('History names the champion, and Clear All on an empty tournament saves nothing', async () => {
    assert.equal((await api.call('DELETE', '/api/results')).body.archived, null);
    assert.deepEqual((await api.call('GET', '/api/history')).body, []);
    await api.enter({ ...GROUPS_DONE, SF1: [21, 15], SF2: [19, 21], FINAL: [[15, 12], [13, 15], [16, 14]] });
    await api.call('DELETE', '/api/results');
    const [only] = (await api.call('GET', '/api/history')).body;
    assert.deepEqual([only.champion, only.finished], ['Duyên – Khải', 12]);
  });

  test('History entries can be deleted; unknown ones are not found', async () => {
    await api.enter({ G1: [21, 15] });
    const { archived } = (await api.call('DELETE', '/api/results')).body;
    assert.equal((await api.call('DELETE', `/api/history/${archived}`, undefined, null)).status, 401);
    assert.deepEqual((await api.call('DELETE', `/api/history/${archived}`)).body, []);
    for (const id of [archived, 999, 'abc']) {
      assert.deepEqual((await api.call('GET', `/api/history/${id}`)).body, { error: 'not_found' });
      assert.equal((await api.call('DELETE', `/api/history/${id}`)).status, 404);
    }
  });

  test('bad requests get 404 or 422 with an error code', async () => {
    const cases = [
      ['PUT', '/api/matches/G1/sets', { sets: [[21, 20]] }, 422, 'invalid_set'],
      ['PUT', '/api/matches/X9/sets', { sets: [[21, 15]] }, 404, 'not_found'],
      ['PUT', '/api/matches/G1/sets', '{"sets": [[21', 422, 'invalid_input'],
      ['PUT', '/api/matches/G1/sets', undefined, 422, 'invalid_input'],
      ['POST', '/api/matches/G1/point', { side: 1, count: 0 }, 409, 'no_server'],
      ['POST', '/api/matches/G1/point', { side: 1 }, 422, 'invalid_input'],
      ['PUT', '/api/draws/B', { order: [] }, 409, 'no_draw_needed'],
      ['GET', '/api/nothing-here', undefined, 404, 'not_found'],
    ];
    for (const [method, path, body, status, error] of cases) {
      const r = await api.call(method, path, body);
      assert.deepEqual([r.status, r.body.error], [status, error], `${method} ${path}`);
    }
  });
});

describe('storage', () => {
  test('results survive a restart and the backup has them too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badminton-test-'));
    try {
      const file = join(dir, 'tournament.db');
      const api = await start(file);
      await api.enter({ G1: [21, 15] });
      await api.call('PUT', '/api/matches/G2/serve', { side: 2 });
      await api.call('POST', '/api/matches/G2/point', { side: 1, count: 0 });
      await api.close();

      const expected = { G1: { kind: 'sets', data: { sets: [[21, 15]] } }, G2: { kind: 'live', data: { firstServer: 2, points: [1] } } };
      const reopened = openDb(file);
      assert.deepEqual(reopened.load(), { results: expected, draws: {} });
      await reopened.backup(join(dir, 'backup.db'));
      reopened.close();
      const copy = openDb(join(dir, 'backup.db'));
      assert.deepEqual(copy.load().results, expected);
      copy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clearing everything saves a backup of the old results first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badminton-test-'));
    try {
      const api = await start(join(dir, 'tournament.db'));
      await api.enter({ G1: [21, 15] });
      const r = await api.call('DELETE', '/api/results');
      assert.match(r.body.backup, /^backup-before-clear-.+\.db$/);
      assert.equal(r.body.progress.finished, 0);
      await api.close();

      const backup = openDb(join(dir, r.body.backup));
      assert.deepEqual(backup.load().results, { G1: { kind: 'sets', data: { sets: [[21, 15]] } } });
      backup.close();

      // The History entry survives a restart too.
      const reopened = openDb(join(dir, 'tournament.db'));
      assert.equal(reopened.historyList().length, 1);
      assert.deepEqual(reopened.historyEntry(r.body.archived).state.matches[0].sets, [[21, 15]]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
