// Tests for server/rules.js. Section numbers refer to docs/SPEC.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FORMATS, isFinishedSet, checkSets, liveScore, computeState, applyChange } from './rules.js';

const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const ONE_SET = FORMATS.group;
const BEST_OF_3 = FORMATS.final;

// { G1: [21, 15] } or { FINAL: [[15, 12], [13, 15]] } → stored typed results.
const typed = (scores) =>
  Object.fromEntries(
    Object.entries(scores).map(([id, s]) => [id, { kind: 'sets', data: { sets: Array.isArray(s[0]) ? s : [s] } }]),
  );
const live = (firstServer, points) => ({ kind: 'live', data: { firstServer, points } });
const times = (n, seq) => Array.from({ length: n }, () => seq).flat();
const order = (state, g) => state.groups[g].rows.map((r) => r.code);
const table = (state, g) => Object.fromEntries(state.groups[g].rows.map((r) => [r.code, [r.won, r.pf, r.pa, r.pd]]));
const match = (state, id) => state.matches.find((m) => m.id === id);
const teams = (state, id) => [match(state, id).team1, match(state, id).team2];
// Applies changes in order, returning the final { results, draws, state }.
const apply = (results, draws, ...changes) =>
  changes.reduce((acc, c) => applyChange(seed, acc.results, acc.draws, c), { results, draws });

// §6.4 worked examples.
const EX1 = { G1: [21, 15], G4: [21, 18], G7: [19, 21] };
const EX2 = { G1: [21, 10], G4: [21, 14], G7: [18, 21] };
const EX3 = { G2: [21, 19], G3: [15, 21], G5: [10, 21], G6: [21, 5], G8: [21, 19], G9: [21, 8] };
const EX4 = { G1: [21, 19], G4: [21, 19], G7: [19, 21] };
const EX5 = { G2: [21, 15], G3: [15, 21], G5: [21, 10], G6: [21, 15], G8: [21, 10], G9: [15, 21] };
const EX6 = { G2: [21, 15], G3: [21, 17] };
// Both groups complete: 1st A = A1, 2nd A = A3, 1st B = B1, 2nd B = B2.
const GROUPS_DONE = { ...EX1, ...EX3 };

describe('§4 valid scores', () => {
  test('21-point sets', () => {
    for (const s of [[21, 0], [21, 19], [22, 20], [29, 27], [30, 28], [30, 29], [19, 21]]) assert.ok(isFinishedSet(s, ONE_SET), `${s}`);
    for (const s of [[21, 20], [21, 21], [20, 18], [22, 19], [30, 27], [31, 29]]) assert.ok(!isFinishedSet(s, ONE_SET), `${s}`);
  });

  test('15-point sets', () => {
    for (const s of [[15, 0], [15, 13], [16, 14], [20, 18], [21, 19], [21, 20]]) assert.ok(isFinishedSet(s, BEST_OF_3), `${s}`);
    for (const s of [[15, 14], [16, 13], [21, 18], [22, 20]]) assert.ok(!isFinishedSet(s, BEST_OF_3), `${s}`);
  });

  test('best of 3 is decided at two sets', () => {
    assert.deepEqual(checkSets([[15, 12], [13, 15], [16, 14]], BEST_OF_3), { winner: 1, setsWon: [2, 1] });
    assert.deepEqual(checkSets([[10, 15], [14, 16]], BEST_OF_3), { winner: 2, setsWon: [0, 2] });
    assert.throws(() => checkSets([[15, 10], [15, 8], [15, 3]], BEST_OF_3), { code: 'extra_set', details: { set: 3 } });
    assert.throws(() => checkSets([[15, 10]], BEST_OF_3), { code: 'incomplete' });
    assert.throws(() => checkSets([[15, 14], [15, 10]], BEST_OF_3), { code: 'invalid_set', details: { set: 1 } });
  });

  test('one-set matches take exactly one set', () => {
    assert.deepEqual(checkSets([[21, 17]], ONE_SET), { winner: 1, setsWon: [1, 0] });
    assert.throws(() => checkSets([[21, 10], [21, 5]], ONE_SET), { code: 'extra_set', details: { set: 2 } });
    assert.throws(() => checkSets([], ONE_SET), { code: 'incomplete' });
  });

  test('malformed scores are rejected', () => {
    for (const bad of ['21-15', [[21, -1]], [[21.5, 3]], [[21]], null]) {
      assert.throws(() => checkSets(bad, ONE_SET), { code: 'invalid_input' });
    }
  });
});

describe('§6.4 group standings', () => {
  test('Example 1: three-way tie, point difference decides, head-to-head ignored', () => {
    const s = computeState(seed, typed(EX1));
    assert.deepEqual(table(s, 'A'), { A1: [1, 40, 36, 4], A2: [1, 36, 39, -3], A3: [1, 39, 40, -1] });
    assert.deepEqual(order(s, 'A'), ['A1', 'A3', 'A2']);
    assert.equal(s.groups.A.drawTie, null);
  });

  test('Example 2: two still level on point difference, points scored decides', () => {
    const s = computeState(seed, typed(EX2));
    assert.deepEqual(table(s, 'A'), { A1: [1, 39, 31, 8], A2: [1, 31, 35, -4], A3: [1, 35, 39, -4] });
    assert.deepEqual(order(s, 'A'), ['A1', 'A3', 'A2']);
  });

  test('Example 3: two-team ties, head-to-head beats point difference', () => {
    const s = computeState(seed, typed(EX3));
    assert.deepEqual(table(s, 'B'), { B1: [2, 52, 59, -7], B2: [2, 61, 34, 27], B3: [1, 44, 52, -8], B4: [1, 45, 57, -12] });
    assert.deepEqual(order(s, 'B'), ['B1', 'B2', 'B4', 'B3']);
  });

  test('Example 4: full tie needs a draw and holds up the semifinals', () => {
    const s = computeState(seed, typed({ ...EX4, ...EX3 }));
    assert.deepEqual(table(s, 'A'), { A1: [1, 40, 40, 0], A2: [1, 40, 40, 0], A3: [1, 40, 40, 0] });
    assert.deepEqual(order(s, 'A'), ['A1', 'A2', 'A3']);
    assert.deepEqual(s.groups.A.drawTie, { teams: ['A1', 'A2', 'A3'], order: null });
    assert.equal(s.groups.A.resolved, false);
    assert.equal(match(s, 'SF1').state, 'waiting');
    assert.equal(match(s, 'SF2').state, 'waiting');

    const drawn = apply(typed({ ...EX4, ...EX3 }), {}, { type: 'draw', group: 'A', order: ['A3', 'A1', 'A2'] });
    assert.deepEqual(order(drawn.state, 'A'), ['A3', 'A1', 'A2']);
    assert.deepEqual(teams(drawn.state, 'SF1'), ['A3', 'B2']);
    assert.deepEqual(teams(drawn.state, 'SF2'), ['B1', 'A1']);
  });

  test('Example 5: full tie for 3rd-4th only, no draw', () => {
    const s = computeState(seed, typed(EX5));
    assert.deepEqual(table(s, 'B'), { B1: [3, 63, 35, 28], B2: [1, 51, 57, -6], B3: [1, 46, 57, -11], B4: [1, 46, 57, -11] });
    assert.deepEqual(order(s, 'B'), ['B1', 'B2', 'B3', 'B4']);
    assert.equal(s.groups.B.drawTie, null);
    assert.equal(s.groups.B.resolved, true);
  });

  test('Example 6: group in progress, tied teams have not met', () => {
    const s = computeState(seed, typed(EX6));
    assert.deepEqual(order(s, 'B'), ['B1', 'B3', 'B4', 'B2']);
    assert.equal(s.groups.B.complete, false);
    assert.equal(s.groups.B.drawTie, null);
  });

  test('live and unplayed matches do not count', () => {
    const s = computeState(seed, { ...typed({ G1: [21, 15] }), G4: live(1, [1, 1, 2]) });
    assert.deepEqual(table(s, 'A'), { A1: [1, 21, 15, 6], A3: [0, 0, 0, 0], A2: [0, 15, 21, -6] });
  });
});

describe('§6.3 draws', () => {
  test('only a group with a tie that needs a draw accepts one', () => {
    assert.throws(() => apply(typed(GROUPS_DONE), {}, { type: 'draw', group: 'B', order: ['B1', 'B2', 'B3', 'B4'] }), {
      code: 'no_draw_needed',
    });
    assert.throws(() => apply(typed({ ...EX4, ...EX3 }), {}, { type: 'draw', group: 'A', order: ['A1', 'A2'] }), {
      code: 'draw_mismatch',
    });
  });

  test('a saved draw is ignored once the tie changes', () => {
    const s = computeState(seed, typed(GROUPS_DONE), { A: ['A3', 'A1', 'A2'] });
    assert.deepEqual(order(s, 'A'), ['A1', 'A3', 'A2']);
  });
});

describe('§5.3 walkover', () => {
  test('counts as 21-0 in a one-set match', () => {
    const r = apply({}, {}, { type: 'walkover', match: 'G4', winner: 2 });
    assert.deepEqual(match(r.state, 'G4').sets, [[0, 21]]);
    assert.deepEqual(table(r.state, 'A').A3, [1, 21, 0, 21]);
    assert.deepEqual(table(r.state, 'A').A2, [0, 0, 21, -21]);
  });

  test('counts as 15-0, 15-0 in a best of 3 and replaces live points', () => {
    const r = apply(typed({ ...GROUPS_DONE, SF1: [21, 15], SF2: [19, 21] }), {},
      { type: 'serve', match: 'THIRD', side: 1 },
      { type: 'point', match: 'THIRD', side: 1, count: 0 },
      { type: 'walkover', match: 'THIRD', winner: 1 });
    const third = match(r.state, 'THIRD');
    assert.equal(third.result, 'walkover');
    assert.deepEqual(third.sets, [[15, 0], [15, 0]]);
    assert.equal(third.winnerTeam, 'B2');
  });
});

describe('§5.2 live scoring', () => {
  test('a 21-point set goes past 21 until someone leads by 2, and ends at 30', () => {
    assert.deepEqual(liveScore(1, [...times(20, [1, 2]), 1], ONE_SET).current, [21, 20]);
    const won = liveScore(1, [...times(20, [1, 2]), 1, 1], ONE_SET);
    assert.deepEqual([won.sets, won.winner, won.current], [[[22, 20]], 1, null]);
    const capped = liveScore(1, [...times(29, [1, 2]), 2], ONE_SET);
    assert.deepEqual([capped.sets, capped.winner], [[[29, 30]], 2]);
  });

  test('serving follows the rally winner; court follows the server\'s score', () => {
    assert.deepEqual(liveScore(1, [], ONE_SET).serve, { side: 1, court: 'right' });
    assert.deepEqual(liveScore(1, [1], ONE_SET).serve, { side: 1, court: 'left' });
    assert.deepEqual(liveScore(1, [1, 2], ONE_SET).serve, { side: 2, court: 'left' });
    assert.deepEqual(liveScore(1, [1, 2, 2], ONE_SET).serve, { side: 2, court: 'right' });
  });

  test('the set winner serves first in the next set', () => {
    const s = liveScore(1, times(15, [2]), BEST_OF_3);
    assert.deepEqual([s.sets, s.current, s.serve], [[[0, 15]], [0, 0], { side: 2, court: 'right' }]);
  });

  test('change ends at 11 in a 21-point set, the first time only', () => {
    assert.equal(liveScore(1, times(11, [1]), ONE_SET).changeEnds, true);
    assert.equal(liveScore(1, times(12, [1]), ONE_SET).changeEnds, false);
    assert.equal(liveScore(1, [...times(10, [1, 2]), 2], ONE_SET).changeEnds, true);
    assert.equal(liveScore(1, [...times(10, [1, 2]), 2, 1], ONE_SET).changeEnds, false);
  });

  test('change ends between sets and at 8 in the deciding set of a best of 3', () => {
    assert.equal(liveScore(1, times(8, [1]), BEST_OF_3).changeEnds, false);
    assert.equal(liveScore(1, times(11, [1]), BEST_OF_3).changeEnds, false);
    assert.equal(liveScore(1, times(15, [1]), BEST_OF_3).changeEnds, true);
    const toDecider = [...times(15, [1]), ...times(15, [2])];
    assert.equal(liveScore(1, toDecider, BEST_OF_3).changeEnds, true);
    assert.equal(liveScore(1, [...toDecider, ...times(7, [1, 2]), 1], BEST_OF_3).changeEnds, true);
    assert.equal(liveScore(1, [...toDecider, ...times(7, [1, 2]), 1, 2], BEST_OF_3).changeEnds, false);
    assert.equal(liveScore(1, [...toDecider, ...times(15, [1])], BEST_OF_3).changeEnds, false);
  });

  test('a point needs the first server, the right count, and an undecided match', () => {
    assert.throws(() => apply({}, {}, { type: 'point', match: 'G1', side: 1, count: 0 }), { code: 'no_server' });
    const started = apply({}, {}, { type: 'serve', match: 'G1', side: 1 }, { type: 'point', match: 'G1', side: 1, count: 0 });
    assert.equal(match(started.state, 'G1').state, 'live');
    assert.throws(() => apply(started.results, {}, { type: 'point', match: 'G1', side: 1, count: 0 }), {
      code: 'count_mismatch',
      details: { count: 1 },
    });
    const decided = { G1: live(1, times(21, [1])) };
    assert.equal(computeState(seed, decided).matches[0].state, 'finished');
    assert.throws(() => apply(decided, {}, { type: 'point', match: 'G1', side: 2, count: 21 }), { code: 'match_decided' });
  });

  test('two phones on one match: the second tap with an old count is refused', () => {
    const atSeven = { G1: live(1, times(7, [1])) };
    const phoneA = apply(atSeven, {}, { type: 'point', match: 'G1', side: 2, count: 7 });
    assert.equal(match(phoneA.state, 'G1').points, 8);
    assert.throws(() => apply(phoneA.results, {}, { type: 'point', match: 'G1', side: 2, count: 7 }), {
      code: 'count_mismatch',
      details: { count: 8 },
    });
  });

  test('undo removes the last point and reopens a decided match', () => {
    const decided = { G1: live(1, times(21, [1])) };
    const reopened = apply(decided, {}, { type: 'undo', match: 'G1', count: 21 });
    assert.deepEqual([match(reopened.state, 'G1').state, match(reopened.state, 'G1').current], ['live', [20, 0]]);
    assert.throws(() => apply({ G1: live(1, []) }, {}, { type: 'undo', match: 'G1', count: 0 }), { code: 'nothing_to_undo' });
    assert.throws(() => apply({}, {}, { type: 'undo', match: 'G1', count: 0 }), { code: 'nothing_to_undo' });
  });

  test('typed scores replace live points; live scoring a typed result needs a clear first', () => {
    const typedOver = apply({ G1: live(1, [1, 2, 1]) }, {}, { type: 'sets', match: 'G1', sets: [[21, 17]] });
    assert.equal(match(typedOver.state, 'G1').result, 'sets');
    assert.throws(() => apply(typedOver.results, {}, { type: 'serve', match: 'G1', side: 1 }), { code: 'has_result' });
    assert.throws(() => apply(typedOver.results, {}, { type: 'point', match: 'G1', side: 1, count: 0 }), { code: 'has_result' });
    const cleared = apply(typedOver.results, {}, { type: 'clear', match: 'G1' }, { type: 'serve', match: 'G1', side: 2 });
    assert.equal(match(cleared.state, 'G1').state, 'ready');
  });
});

describe('§7 locking', () => {
  test('knockout matches need their teams first', () => {
    assert.throws(() => apply({}, {}, { type: 'sets', match: 'SF1', sets: [[21, 15]] }), { code: 'teams_unknown' });
  });

  test('a finished semifinal locks every group match until it is cleared', () => {
    const r = typed({ ...GROUPS_DONE, SF1: [21, 15] });
    assert.throws(() => apply(r, {}, { type: 'sets', match: 'G1', sets: [[21, 10]] }), { code: 'locked', details: { by: ['SF1'] } });
    assert.throws(() => apply(r, {}, { type: 'clear', match: 'G9' }), { code: 'locked', details: { by: ['SF1'] } });
    const both = typed({ ...GROUPS_DONE, SF1: [21, 15], SF2: [19, 21] });
    assert.throws(() => apply(both, {}, { type: 'clear', match: 'G1' }), { code: 'locked', details: { by: ['SF1', 'SF2'] } });
    const fixed = apply(both, {}, { type: 'clear', match: 'SF1' }, { type: 'clear', match: 'SF2' }, { type: 'sets', match: 'G1', sets: [[21, 10]] });
    assert.deepEqual(match(fixed.state, 'G1').sets, [[21, 10]]);
  });

  test('a finished final or 3rd-place match locks the semifinals', () => {
    const r = typed({ ...GROUPS_DONE, SF1: [21, 15], SF2: [19, 21], FINAL: [[15, 12], [15, 13]] });
    assert.throws(() => apply(r, {}, { type: 'clear', match: 'SF2' }), { code: 'locked', details: { by: ['FINAL'] } });
  });

  test('a finished semifinal locks the draws', () => {
    const r = apply(typed({ ...EX4, ...EX3 }), {}, { type: 'draw', group: 'A', order: ['A3', 'A1', 'A2'] },
      { type: 'sets', match: 'SF1', sets: [[21, 15]] });
    assert.throws(() => apply(r.results, r.draws, { type: 'draw', group: 'A', order: ['A1', 'A2', 'A3'] }), {
      code: 'locked',
      details: { by: ['SF1'] },
    });
  });

  test('§6.5: a live semifinal refuses only changes that alter its teams', () => {
    const sf2Live = apply(typed(GROUPS_DONE), {}, { type: 'serve', match: 'SF2', side: 1 }, { type: 'point', match: 'SF2', side: 1, count: 0 });
    assert.deepEqual(teams(sf2Live.state, 'SF2'), ['B1', 'A3']);
    const kept = apply(sf2Live.results, {}, { type: 'sets', match: 'G7', sets: [[18, 21]] });
    assert.deepEqual(order(kept.state, 'A'), ['A1', 'A3', 'A2']);
    assert.throws(() => apply(sf2Live.results, {}, { type: 'sets', match: 'G7', sets: [[21, 19]] }), {
      code: 'pairing_change',
      details: { match: 'SF2' },
    });
    assert.throws(() => apply(sf2Live.results, {}, { type: 'clear', match: 'G7' }), { code: 'pairing_change', details: { match: 'SF2' } });

    // The same correction is fine when only SF1, whose teams don't change, is live.
    const sf1Live = apply(typed(GROUPS_DONE), {}, { type: 'serve', match: 'SF1', side: 1 }, { type: 'point', match: 'SF1', side: 1, count: 0 });
    const changed = apply(sf1Live.results, {}, { type: 'sets', match: 'G7', sets: [[21, 19]] });
    assert.deepEqual(order(changed.state, 'A'), ['A1', 'A2', 'A3']);
  });

  test('undo on a finished semifinal unlocks the groups but protects its teams', () => {
    const sf1Done = { ...typed(GROUPS_DONE), SF1: live(1, times(21, [1])) };
    assert.throws(() => apply(sf1Done, {}, { type: 'sets', match: 'G7', sets: [[18, 21]] }), { code: 'locked' });
    const reopened = apply(sf1Done, {}, { type: 'undo', match: 'SF1', count: 21 }, { type: 'sets', match: 'G7', sets: [[18, 21]] });
    assert.equal(match(reopened.state, 'SF1').state, 'live');
    assert.throws(() => apply(reopened.results, {}, { type: 'clear', match: 'G1' }), { code: 'pairing_change', details: { match: 'SF1' } });
  });
});

describe('§8 knockout and podium', () => {
  test('a whole tournament from groups to podium', () => {
    const groups = computeState(seed, typed(GROUPS_DONE));
    assert.deepEqual(teams(groups, 'SF1'), ['A1', 'B2']);
    assert.deepEqual(teams(groups, 'SF2'), ['B1', 'A3']);
    assert.deepEqual([match(groups, 'FINAL').state, match(groups, 'THIRD').state], ['waiting', 'waiting']);

    const done = apply(typed(GROUPS_DONE), {},
      { type: 'sets', match: 'SF1', sets: [[21, 15]] },
      { type: 'sets', match: 'SF2', sets: [[19, 21]] },
      { type: 'sets', match: 'FINAL', sets: [[15, 12], [13, 15], [16, 14]] },
      { type: 'walkover', match: 'THIRD', winner: 2 }).state;
    assert.deepEqual(teams(done, 'FINAL'), ['A1', 'A3']);
    assert.deepEqual(teams(done, 'THIRD'), ['B2', 'B1']);
    assert.deepEqual(done.podium, { champion: 'A1', runnerUp: 'A3', third: 'B1' });
    assert.deepEqual(done.progress, { finished: 13, total: 13 });
  });

  test('nothing is decided at the start', () => {
    const s = computeState(seed);
    assert.deepEqual(s.podium, { champion: null, runnerUp: null, third: null });
    assert.deepEqual(s.progress, { finished: 0, total: 13 });
    assert.ok(s.matches.filter((m) => m.stage === 'group').every((m) => m.state === 'ready'));
    assert.ok(s.matches.filter((m) => m.stage !== 'group').every((m) => m.state === 'waiting'));
  });
});
