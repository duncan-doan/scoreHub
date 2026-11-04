// Tests for server/votes.js: what a phone sees for each fan award (docs/SPEC.md §5.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voteSummary } from './votes.js';

const teams = [{ code: 'A1' }, { code: 'A2' }, { code: 'B1' }];
const byId = (awards) => Object.fromEntries(awards.map((a) => [a.id, a]));

test('every award starts not open, with no votes', () => {
  assert.deepEqual(voteSummary({ teams }).map((a) => [a.id, a.status, a.total, a.mine, a.results]), [
    ['best_rally', 'not_open', 0, null, null],
    ['fan_favourite', 'not_open', 0, null, null],
    ['fair_play', 'not_open', 0, null, null],
  ]);
});

test('while open, only the total and the phone\'s own vote show; closed, every count and the winner', () => {
  const counts = { fan_favourite: { A2: 3, B1: 1 } };
  const open = byId(voteSummary({ teams, counts, statuses: { fan_favourite: 'open' }, mine: { fan_favourite: 'B1' } })).fan_favourite;
  assert.deepEqual([open.total, open.mine, open.results, open.winners], [4, 'B1', null, []]);
  const closed = byId(voteSummary({ teams, counts, statuses: { fan_favourite: 'closed' } })).fan_favourite;
  assert.deepEqual(closed.results, [{ code: 'A2', votes: 3 }, { code: 'B1', votes: 1 }, { code: 'A1', votes: 0 }]);
  assert.deepEqual(closed.winners, ['A2']);
});

test('a tie gives joint winners; no votes gives no winner; History reveals every award', () => {
  const statuses = { best_rally: 'closed', fair_play: 'closed' };
  const awards = byId(voteSummary({ teams, statuses, counts: { best_rally: { A1: 2, B1: 2, A2: 1 } } }));
  assert.deepEqual(awards.best_rally.winners, ['A1', 'B1']);
  assert.deepEqual(awards.fair_play.winners, []);
  const history = byId(voteSummary({ teams, statuses: { fan_favourite: 'open' }, counts: { fan_favourite: { A1: 1 } }, reveal: true }));
  assert.deepEqual(history.fan_favourite.winners, ['A1']);
});
