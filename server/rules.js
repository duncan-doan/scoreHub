// Tournament rules from docs/SPEC.md. Pure: no database, no Express, no clock.
// Sides are 1 and 2 (team1 and team2 of a match); every score pair is [team1, team2].

export const FORMATS = {
  group: { sets: 1, to: 21, max: 30 },
  semifinal: { sets: 1, to: 21, max: 30 },
  third_place: { sets: 3, to: 15, max: 21 },
  final: { sets: 3, to: 15, max: 21 },
};

export class RuleError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const setsToWin = (format) => Math.ceil(format.sets / 2);
const isPoints = (n) => Number.isInteger(n) && n >= 0;
const isSide = (s) => s === 1 || s === 2;
const sameMembers = (list, codes) => list.length === codes.length && codes.every((c) => list.includes(c));

// §4: a finished set is valid only in one of three shapes.
export function isFinishedSet([a, b], { to, max }) {
  const w = Math.max(a, b);
  const l = Math.min(a, b);
  return (w === to && l <= to - 2) || (w > to && w <= max && w - l === 2) || (w === max && l === max - 1);
}

// §4, §5.1: checks typed sets; returns the winning side and sets won.
export function checkSets(sets, format) {
  if (!Array.isArray(sets) || !sets.every((s) => Array.isArray(s) && s.length === 2 && s.every(isPoints))) {
    throw new RuleError('invalid_input');
  }
  const need = setsToWin(format);
  const won = [0, 0];
  sets.forEach((set, i) => {
    if (won.includes(need)) throw new RuleError('extra_set', { set: i + 1 });
    if (!isFinishedSet(set, format)) throw new RuleError('invalid_set', { set: i + 1 });
    won[set[0] > set[1] ? 0 : 1]++;
  });
  if (!won.includes(need)) throw new RuleError('incomplete');
  return { winner: won[0] === need ? 1 : 2, setsWon: won };
}

// §5.2: replays a live point list into finished sets, the current set, the serve and the change-ends reminder.
// changeEnds says whether the last point should trigger the reminder.
export function liveScore(firstServer, points, format) {
  const need = setsToWin(format);
  const sets = [];
  const won = [0, 0];
  let current = [0, 0];
  let server = firstServer;
  let winner = null;
  let changeEnds = false;
  for (const side of points) {
    current[side - 1]++;
    server = side;
    if (isFinishedSet(current, format)) {
      sets.push(current);
      won[side - 1]++;
      if (won[side - 1] === need) {
        winner = side;
      } else {
        current = [0, 0];
      }
      changeEnds = winner === null;
    } else {
      // Mid-set change: at 11 in a one-set match, at 8 in the deciding set of a best of 3.
      const at = format.sets === 1 ? 11 : sets.length === format.sets - 1 ? 8 : null;
      changeEnds = current[side - 1] === at && current[2 - side] < at;
    }
  }
  return {
    sets,
    current: winner ? null : current,
    setsWon: won,
    winner,
    serve: winner ? null : { side: server, court: current[server - 1] % 2 === 0 ? 'right' : 'left' },
    changeEnds,
  };
}

// §5.3: a walkover counts as the minimum winning score in every set needed.
function walkoverSets(winner, format) {
  return Array.from({ length: setsToWin(format) }, () => (winner === 1 ? [format.to, 0] : [0, format.to]));
}

function evaluate(result, format) {
  const score = { result: null, sets: [], current: null, setsWon: [0, 0], winner: null, serve: null, changeEnds: false, firstServer: null, points: 0 };
  if (!result) return score;
  const { kind, data } = result;
  score.result = kind;
  if (kind === 'sets') return { ...score, sets: data.sets, ...checkSets(data.sets, format) };
  if (kind === 'walkover') {
    const need = setsToWin(format);
    return { ...score, sets: walkoverSets(data.winner, format), setsWon: data.winner === 1 ? [need, 0] : [0, need], winner: data.winner };
  }
  return { ...score, ...liveScore(data.firstServer, data.points, format), firstServer: data.firstServer, points: data.points.length };
}

// §7: which knockout matches depend on each match or draw ('draw:A'), read from the seed's slots.
function dependents(seed) {
  const deps = {};
  const add = (target, id) => (deps[target] ??= []).push(id);
  for (const m of seed.matches.filter((m) => m.stage !== 'group')) {
    for (const slot of [m.team1, m.team2]) {
      if (slot.group) {
        seed.matches.filter((g) => g.group === slot.group).forEach((g) => add(g.id, m.id));
        add(`draw:${slot.group}`, m.id);
      } else {
        add(slot.winnerOf ?? slot.loserOf, m.id);
      }
    }
  }
  return deps;
}

// Sorts rows by the keys, highest first, and returns runs of rows that are equal on all of them.
function splitBy(rows, keys) {
  const sorted = [...rows].sort((a, b) => {
    for (const k of keys) if (a[k] !== b[k]) return b[k] - a[k];
    return 0;
  });
  const runs = [];
  for (const r of sorted) {
    const run = runs.at(-1);
    if (run && keys.every((k) => run[0][k] === r[k])) run.push(r);
    else runs.push([r]);
  }
  return runs;
}

// §6.2 step 2: the winner of the two teams' match ranks higher; null if they haven't played.
function headToHead([a, b], finished) {
  const m = finished.find((m) => [m.team1, m.team2].includes(a.code) && [m.team1, m.team2].includes(b.code));
  if (!m) return null;
  return m.winnerTeam === a.code ? [[a], [b]] : [[b], [a]];
}

// §6: table and ranking for one group. drawTie is set only when a draw is needed (§6.3).
function rankGroup(group, seed, matches, draw) {
  const own = matches.filter((m) => m.group === group);
  const finished = own.filter((m) => m.state === 'finished');
  const rows = seed.teams
    .filter((t) => t.group === group)
    .map((t) => ({ code: t.code, played: 0, won: 0, lost: 0, pf: 0, pa: 0, pd: 0 }));
  const row = Object.fromEntries(rows.map((r) => [r.code, r]));
  for (const m of finished) {
    const [p1, p2] = m.sets.reduce(([a, b], [x, y]) => [a + x, b + y], [0, 0]);
    for (const [code, pf, pa] of [[m.team1, p1, p2], [m.team2, p2, p1]]) {
      const r = row[code];
      r.played++;
      r.pf += pf;
      r.pa += pa;
      r.pd = r.pf - r.pa;
      if (code === m.winnerTeam) r.won++;
      else r.lost++;
    }
  }

  const complete = own.every((m) => m.state === 'finished');
  const ranked = [];
  let drawTie = null;
  for (const block of splitBy(rows, ['won'])) {
    const parts = (block.length === 2 && headToHead(block, finished)) || splitBy(block, ['pd', 'pf']);
    for (const part of parts) {
      if (part.length > 1) {
        part.sort((a, b) => a.code.localeCompare(b.code));
        if (complete && ranked.length < 2) {
          const teams = part.map((r) => r.code);
          const order = draw && sameMembers(draw, teams) ? draw : null;
          drawTie = { teams, order };
          if (order) part.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
        }
      }
      ranked.push(...part);
    }
  }
  return {
    rows: ranked.map((r, i) => ({ ...r, rank: i + 1 })),
    complete,
    resolved: complete && (!drawTie || drawTie.order !== null),
    drawTie,
  };
}

// The whole tournament, computed from the seed and what people entered (§6–§8).
// results: { [matchId]: { kind: 'sets' | 'live' | 'walkover', data } }; draws: { [group]: [codes] }.
export function computeState(seed, results = {}, draws = {}) {
  const deps = dependents(seed);
  const byId = {};
  const groups = {};

  const add = (m, team1, team2) => {
    const format = FORMATS[m.stage];
    const known = team1 !== null && team2 !== null;
    const score = evaluate(known ? results[m.id] : undefined, format);
    const state = !known ? 'waiting' : score.winner ? 'finished' : score.points > 0 ? 'live' : 'ready';
    byId[m.id] = {
      id: m.id,
      stage: m.stage,
      group: m.group ?? null,
      order: m.order,
      format,
      slots: m.stage === 'group' ? null : [m.team1, m.team2],
      team1,
      team2,
      state,
      ...score,
      winnerTeam: score.winner ? (score.winner === 1 ? team1 : team2) : null,
      loserTeam: score.winner ? (score.winner === 1 ? team2 : team1) : null,
    };
  };
  const slotTeam = (slot) => {
    if (slot.group) {
      const g = groups[slot.group];
      return g.resolved ? g.rows[slot.rank - 1].code : null;
    }
    const source = byId[slot.winnerOf ?? slot.loserOf];
    return slot.winnerOf ? source.winnerTeam : source.loserTeam;
  };

  const groupIds = [...new Set(seed.teams.map((t) => t.group))];
  seed.matches.filter((m) => m.stage === 'group').forEach((m) => add(m, m.team1, m.team2));
  for (const g of groupIds) groups[g] = rankGroup(g, seed, Object.values(byId), draws[g]);
  // The seed lists knockout matches after the matches they depend on.
  seed.matches.filter((m) => m.stage !== 'group').forEach((m) => add(m, slotTeam(m.team1), slotTeam(m.team2)));

  const finishedDependents = (target) => (deps[target] ?? []).filter((id) => byId[id].state === 'finished');
  for (const m of Object.values(byId)) m.lockedBy = finishedDependents(m.id);
  for (const g of groupIds) groups[g].lockedBy = finishedDependents(`draw:${g}`);

  const matches = Object.values(byId).sort((a, b) => a.order - b.order);
  const final = matches.find((m) => m.stage === 'final');
  const third = matches.find((m) => m.stage === 'third_place');
  return {
    teams: seed.teams,
    matches,
    groups,
    podium: { champion: final.winnerTeam, runnerUp: final.loserTeam, third: third.winnerTeam },
    progress: { finished: matches.filter((m) => m.state === 'finished').length, total: matches.length },
  };
}

// §5: the new stored result for one match change, or undefined when it is cleared.
function changeResult(match, current, change) {
  const live = current?.kind === 'live' ? current.data : null;
  switch (change.type) {
    case 'sets':
      checkSets(change.sets, match.format);
      return { kind: 'sets', data: { sets: change.sets } };
    case 'walkover':
      if (!isSide(change.winner)) throw new RuleError('invalid_input');
      return { kind: 'walkover', data: { winner: change.winner } };
    case 'clear':
      return undefined;
    case 'serve':
      if (!isSide(change.side)) throw new RuleError('invalid_input');
      if (current && !live) throw new RuleError('has_result');
      return { kind: 'live', data: { firstServer: change.side, points: live?.points ?? [] } };
    case 'point':
    case 'undo': {
      if (change.type === 'point' && !isSide(change.side)) throw new RuleError('invalid_input');
      if (current && !live) throw new RuleError('has_result');
      if (!live) throw new RuleError(change.type === 'point' ? 'no_server' : 'nothing_to_undo');
      if (change.count !== live.points.length) throw new RuleError('count_mismatch', { count: live.points.length });
      if (change.type === 'undo') {
        if (live.points.length === 0) throw new RuleError('nothing_to_undo');
        return { kind: 'live', data: { ...live, points: live.points.slice(0, -1) } };
      }
      if (match.winner) throw new RuleError('match_decided');
      return { kind: 'live', data: { ...live, points: [...live.points, change.side] } };
    }
    default:
      throw new RuleError('invalid_input');
  }
}

// Applies one organizer change and returns the new inputs plus the new state, or throws a RuleError.
// change: { type: 'sets' | 'serve' | 'point' | 'undo' | 'walkover' | 'clear', match, ... } or { type: 'draw', group, order }.
export function applyChange(seed, results, draws, change) {
  const before = computeState(seed, results, draws);
  const next = { results: { ...results }, draws: { ...draws } };
  const target = change.type === 'draw' ? before.groups[change.group] : before.matches.find((m) => m.id === change.match);
  if (!target) throw new RuleError('not_found');
  if (target.lockedBy.length) throw new RuleError('locked', { by: target.lockedBy });

  if (change.type === 'draw') {
    if (!target.drawTie) throw new RuleError('no_draw_needed');
    if (!Array.isArray(change.order) || !sameMembers(change.order, target.drawTie.teams)) {
      throw new RuleError('draw_mismatch');
    }
    next.draws[change.group] = [...change.order];
  } else {
    if (target.state === 'waiting') throw new RuleError('teams_unknown');
    const result = changeResult(target, results[target.id], change);
    if (result) next.results[target.id] = result;
    else delete next.results[target.id];
  }

  // §7: a live match keeps its teams; refuse any change that would swap them.
  const after = computeState(seed, next.results, next.draws);
  for (const m of before.matches) {
    if (m.state !== 'live' || m.id === change.match) continue;
    const now = after.matches.find((n) => n.id === m.id);
    if (now.team1 !== m.team1 || now.team2 !== m.team2) throw new RuleError('pairing_change', { match: m.id });
  }
  return { ...next, state: after };
}
