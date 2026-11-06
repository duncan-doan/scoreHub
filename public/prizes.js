// The prizes, in the order shown on Overview (docs/SPEC.md §10), in VND: 2,000,000 in total.
// place: a podium place (its name is in i18n.js); award: one of the voted awards (§5.7), whose row opens its vote.
// The voted awards share one amount: Overview shows it once, as "… each", in their heading.
export const PRIZES = [
  { place: 'champion', amount: 700000 },
  { place: 'runnerUp', amount: 400000 },
  { place: 'third', amount: 300000 },
  { award: 'fair_play', amount: 200000 },
  { award: 'fan_favourite', amount: 200000 },
  { award: 'best_rally', amount: 200000 },
];
