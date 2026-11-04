// The three fan awards (docs/SPEC.md §5.7). Everyone votes for one of the teams, with one vote per phone per
// award that can be changed while the award is open. Pure: the counts come from db.js.

export const AWARDS = ['best_rally', 'fan_favourite', 'fair_play'];
export const AWARD_STATUSES = ['not_open', 'open', 'closed'];

// What a phone sees for each award: its status, how many votes so far, the phone's own vote, and, once the
// award is closed (or for History, which is organizers-only), every team's count and the winner(s).
// statuses: { [award]: status }; counts: { [award]: { [teamCode]: n } }; mine: { [award]: teamCode }.
export function voteSummary({ teams, statuses = {}, counts = {}, mine = {}, reveal = false }) {
  return AWARDS.map((id) => {
    const status = statuses[id] ?? 'not_open';
    const byTeam = counts[id] ?? {};
    const total = Object.values(byTeam).reduce((sum, n) => sum + n, 0);
    const award = { id, status, total, mine: mine[id] ?? null, results: null, winners: [] };
    if (status === 'closed' || reveal) {
      award.results = teams
        .map((t) => ({ code: t.code, votes: byTeam[t.code] ?? 0 }))
        .sort((a, b) => b.votes - a.votes || a.code.localeCompare(b.code));
      const top = award.results[0]?.votes ?? 0;
      award.winners = top > 0 ? award.results.filter((r) => r.votes === top).map((r) => r.code) : [];
    }
    return award;
  });
}
