// The whole interface: spectator views, the hidden admin (#admin) and live scoring (docs/SPEC.md §5, §10).
// Everything shown comes from GET /api/state. The only thing worked out here is the winner preview while
// typing a score, and that uses the same rules.js as the server.
import { STRINGS } from './i18n.js';
import { setProblem } from './rules.js';
import { SPONSORS } from './sponsors.js';
import { PRIZES } from './prizes.js';

const POLL_LIVE_MS = 3000;
const POLL_IDLE_MS = 15000;
const TAP_RETRIES = 5;
const NOTICE_MS = 5000;
const PUBLIC_VIEWS = ['groups', 'knockout', 'sponsors'];
const AWARD_IDS = PRIZES.filter((p) => p.award).map((p) => p.award);
const ADMIN_VIEWS = ['admin', 'edit', 'live', 'draw', 'reset', 'history', 'login'];
// Views with inputs: a poll must not re-render them while someone is typing.
const FORM_VIEWS = ['edit', 'draw', 'reset', 'login'];

const main = document.querySelector('main');
const sheetLayer = document.querySelector('.sheet-layer');

// Browser storage can be unavailable (private mode); the app then just forgets between visits.
const recall = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
};

let lang = recall('lang') === 'en' ? 'en' : 'vi';
let pin = recall('pin');
// Matches whose two panels this phone shows swapped, to follow the teams changing ends on court.
let flipped;
try {
  flipped = new Set(JSON.parse(recall('flipped')) ?? []);
} catch {
  flipped = new Set();
}
// Groups whose match list is open on the Groups tab, kept across re-renders (polling) on this page.
const openMatchLists = new Set();
// §5.7: one vote per phone per award, tied to a random id this browser keeps. (crypto.randomUUID only works
// on HTTPS sites, so the id is built from random bytes, which works on the plain http:// address too.)
let voter = recall('voter');
if (!/^[0-9a-f]{32}$/.test(voter ?? '')) {
  voter = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  remember('voter', voter);
}
let votes = null; // { awards } as GET /api/votes returns it, fetched on Overview and the admin page
let state = null;
// Counts the changes this page has sent. A refresh that started before one of them may carry the data from
// before it (e.g. results that Clear All has just removed), so it is dropped.
let changes = 0;
let notice = null; // { text, error, until }
let tapping = idleTapping();
let rendered = null; // the view last rendered, so polling can leave forms alone
let pollTimer;
// §5.6: organizers' History, fetched when its pages are opened (it isn't part of /api/state).
let historyList = null; // [{ id, clearedAt, champion, finished, total }], or { error }
const historyEntries = {}; // id → { id, clearedAt, state }, or { error }
let historyLoading = null; // what is being fetched, so a render doesn't start it twice
let archived = false; // true while a saved copy is drawn, so nothing in it looks live
// An action waiting for the in-page Confirm (§5): { action, id, side }. The browser's own confirm() isn't used,
// because some in-app browsers (Zalo, Messenger, Facebook) block it and the button then silently does nothing.
let confirming = null;
let typing = false; // the organizer has typed in a form on this page, so a refresh must not redraw it
let sheetShown = null; // the vote popup's HTML as last drawn, so a refresh doesn't redraw (and unfocus) it
let sheetLinkTapped = false; // a link to a popup on this page was just tapped (see the hashchange handler)

function idleTapping() {
  return { match: null, busy: false, status: null, changeEnds: false };
}

// ---------- Text ----------

const t = (key, params = {}) => (STRINGS[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const signed = (n) => (n > 0 ? `+${n}` : String(n));

const byId = (id) => state.matches.find((m) => m.id === id);
const teamText = (code) => state.teams.find((team) => team.code === code)?.name ?? code;
const matchText = (m) =>
  m.stage === 'group'
    ? t('matchNo', { n: m.order })
    : m.stage === 'semifinal'
      ? t('semifinal', { n: m.id.slice(2) })
      : t(m.stage === 'final' ? 'final' : 'thirdPlace');
const labelOf = (id) => matchText(byId(id));
const courtText = (m) => t(m.serve.court === 'right' ? 'courtRight' : 'courtLeft');
const formatText = (m) => t(m.format.sets === 1 ? 'formatOne' : 'formatThree');

// A side's team name, or what decides it ("1st of Group A") while it isn't known. Plain text, not HTML.
function sideText(m, side) {
  const code = side === 1 ? m.team1 : m.team2;
  if (code) return teamText(code);
  const slot = m.slots[side - 1];
  if (slot.group) return t(`slotRank${slot.rank}`, { g: slot.group });
  return t(slot.winnerOf ? 'slotWinner' : 'slotLoser', { m: labelOf(slot.winnerOf ?? slot.loserOf) });
}

function stateText(m) {
  if (m.state === 'finished' && m.result === 'walkover') return t('walkover');
  if (archived && m.state === 'live') return t('stateUnfinished');
  return t({ waiting: 'stateWaiting', ready: 'stateReady', live: 'stateLive', finished: 'stateFinished' }[m.state]);
}

// §4: the rule an invalid set breaks, in words (details from rules.js setProblem / checkSets).
const setText = (reason, set, { to, max }) => t(`set_${reason}`, { set, to, max, deuce: to - 1, cap: max - 1 });

function errorText({ error = 'server_error', details = {} } = {}) {
  if (error === 'invalid_set' && details.reason) return setText(details.reason, details.set, details);
  const params = { ...details };
  if (details.by) params.by = details.by.map(labelOf).join(', ');
  if (details.match) params.match = labelOf(details.match);
  return t(`error_${error}`, params);
}

// ---------- Server ----------

// usePin replaces the remembered PIN, for the clear-all confirmation where the PIN is typed again.
async function api(method, path, body, usePin = pin) {
  const headers = { 'Content-Type': 'application/json' };
  if (usePin) headers['X-Admin-Pin'] = usePin;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

// Sends one organizer change. A refused change still carries the current state, so we take that too.
async function send(method, path, body) {
  let r;
  try {
    r = await api(method, path, body);
  } catch {
    return { ok: false, message: t('error_network') };
  }
  if (r.data?.matches) state = r.data;
  else if (r.data?.state) state = r.data.state;
  changes++;
  if (r.ok) return { ok: true, data: r.data };
  if (r.status === 401) forgetPin();
  return { ok: false, message: errorText(r.data ?? {}) };
}

// §5.2: each tap carries the point count shown on screen. A lost connection is retried with the same
// count, so a tap that did reach the server is refused rather than counted twice.
async function tap(id, kind, body) {
  if (tapping.busy) return;
  const sent = { ...body, count: byId(id).points };
  tapping = { ...tapping, match: id, busy: true, status: { key: 'statusSaving' } };
  render();
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await api('POST', `/api/matches/${id}/${kind}`, sent);
    } catch {
      if (attempt > TAP_RETRIES) {
        tapping = { ...tapping, busy: false, status: { key: 'statusFailed' } };
        render();
        return;
      }
      tapping.status = { key: 'statusRetrying' };
      render();
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)));
      continue;
    }
    tapping.busy = false;
    changes++;
    if (r.ok) {
      state = r.data;
      tapping.status = { key: 'statusSaved' };
      tapping.changeEnds = kind === 'point' && byId(id).changeEnds;
    } else {
      if (r.data?.state) state = r.data.state;
      if (r.status === 401) forgetPin();
      tapping.status = r.data?.error === 'count_mismatch' ? { key: 'statusReloaded' } : { error: r.data ?? {} };
    }
    render();
    return;
  }
}

async function refresh() {
  const seen = changes;
  try {
    const r = await api('GET', '/api/state');
    if (r.ok && seen === changes) state = r.data;
    if (['overview', 'admin'].includes(route().view)) await loadVotes();
    if (r.ok) render({ fromPoll: true });
  } catch {}
  schedule();
}

async function loadVotes() {
  const r = await api('GET', `/api/votes?voter=${voter}`);
  if (r.ok) votes = r.data;
}

// Poll every 3 s while a match is live, 15 s otherwise, and only while the page is visible.
function schedule() {
  clearTimeout(pollTimer);
  if (document.visibilityState !== 'visible') return;
  const live = state?.matches.some((m) => m.state === 'live');
  pollTimer = setTimeout(refresh, live ? POLL_LIVE_MS : POLL_IDLE_MS);
}

function forgetPin() {
  pin = null;
  remember('pin', null);
}

function setNotice(text, error = false) {
  notice = { text, error, until: Date.now() + NOTICE_MS };
}

// ---------- Pieces ----------

function scoreCells(m, side) {
  const cells = m.sets.map((s) => `<span class="set">${s[side - 1]}</span>`);
  if (m.state === 'live') cells.push(`<span class="set${archived ? '' : ' now'}">${m.current[side - 1]}</span>`);
  return cells.join('');
}

// extra goes under the two sides (admin buttons); mark goes in the header, before the state (the lock dot).
function matchCard(m, extra = '', mark = '') {
  const live = m.state === 'live' && !archived;
  const serving = (side) =>
    live && m.serve.side === side
      ? `<span class="serve"><span class="sr">${t('serving', { court: courtText(m) })}</span></span>`
      : '';
  const row = (side) => `
    <div class="side${m.winner === side ? ' won' : ''}">
      <span class="name">${esc(sideText(m, side))}${serving(side)}</span>
      <span class="score">${scoreCells(m, side)}</span>
    </div>`;
  // §3: the planned time and court, next to the match's name until the match starts.
  const plan = !archived && ['waiting', 'ready'].includes(m.state) ? `<span class="plan">${t('planned', m.plan)}</span>` : '';
  return `
    <article class="match is-${live || m.state !== 'live' ? m.state : 'unfinished'}" data-match="${m.id}">
      <header><span>${matchText(m)}</span>${plan}<span class="badge">${mark}${stateText(m)}</span></header>
      ${row(1)}${row(2)}${extra}
    </article>`;
}

function cardList(title, matches, empty) {
  const body = matches.length
    ? `<div class="cards">${matches.map((m) => matchCard(m)).join('')}</div>`
    : `<p class="empty">${empty}</p>`;
  return `<section><h2>${title}</h2>${body}</section>`;
}

// §10: on Overview, Up next is folded until tapped; the toggle listener keeps it open across polls.
function upNextHtml(matches) {
  return `
    <section>
      <details class="up-next" data-matches="upNext"${openMatchLists.has('upNext') ? ' open' : ''}>
        <summary><h2>${t('upNext')}</h2></summary>
        <div class="cards">${matches.map((m) => matchCard(m)).join('')}</div>
      </details>
    </section>`;
}

function tieNote(group) {
  if (!group.drawTie) return '';
  const teams = group.drawTie.teams.map((c) => esc(teamText(c))).join(', ');
  return `<p class="note">${t(group.drawTie.order ? 'drawDone' : 'drawNeeded', { teams })}</p>`;
}

const lockedText = (m) => t('lockedBy', { by: m.lockedBy.map(labelOf).join(', ') });
// §7: in the admin list a locked match shows a red dot (explained once at the bottom); hovering or a screen
// reader gives the reason. On the match's own page the full sentence is shown instead.
const lockDot = (m) =>
  m.lockedBy.length ? `<span class="lock-dot" title="${esc(lockedText(m))}"><span class="sr">${esc(lockedText(m))}</span></span>` : '';
const lockedNote = (m) => `<p class="locked">${lockedText(m)}</p>`;

function adminActions(m) {
  if (m.lockedBy.length || m.state === 'waiting') return '';
  // Live scoring a typed score or walkover needs a clear first (§5.2), so only offer it when it can work.
  const canGoLive = m.result === null || m.result === 'live';
  return `
    <div class="actions">
      ${canGoLive ? `<a class="button" href="#live/${m.id}">${t('scoreLive')}</a>` : ''}
      <a class="button secondary" href="#edit/${m.id}">${t('enterScore')}</a>
    </div>`;
}

function podiumHtml() {
  const { podium } = state;
  if (!podium.champion && !podium.third) return '';
  const place = (key, code) =>
    code ? `<li class="place-${key}"><span>${t(key)}</span><strong>${esc(teamText(code))}</strong></li>` : '';
  return `<section class="podium"><h2>${t('podiumTitle')}</h2><ol>
      ${place('champion', podium.champion)}${place('runnerUp', podium.runnerUp)}${place('third', podium.third)}
    </ol></section>`;
}

const back = () => `<a class="back" href="#admin">← ${t('back')}</a>`;

const awardTitle = (a) => t(`award_${a.id}`);

// A closed award (or any award in History): the winner(s), then every team's votes as a bar.
function voteResults(a) {
  const top = Math.max(1, ...a.results.map((r) => r.votes));
  const names = a.winners.map((c) => esc(teamText(c))).join(', ');
  const headline = !a.winners.length ? t('voteNoVotes') : t(a.winners.length > 1 ? 'voteWinners' : 'voteWinner', { team: names });
  const rows = a.results
    .map(
      (r) => `
      <li class="${a.winners.includes(r.code) ? 'winner' : ''}">
        <span class="name">${esc(teamText(r.code))}</span>
        <span class="bar"><span style="width: ${(100 * r.votes) / top}%"></span></span>
        <span class="n">${r.votes}</span>
      </li>`,
    )
    .join('');
  return `<p class="vote-headline">${headline}</p><ol class="vote-results">${rows}</ol>`;
}

function awardCard(a) {
  let body;
  if (a.status === 'not_open') body = `<p class="empty">${t('voteNotOpen')}</p>`;
  else if (a.status === 'closed') body = voteResults(a);
  else {
    const options = state.teams
      .map(
        (team) => `
        <button type="button" class="vote-option${a.mine === team.code ? ' chosen' : ''}" aria-pressed="${a.mine === team.code}"
          data-action="vote" data-award="${a.id}" data-team="${team.code}">${esc(team.name)}</button>`,
      )
      .join('');
    body = `
      <p class="hint">${a.mine ? t('voteYours', { team: esc(teamText(a.mine)) }) : t('votePick')} ${t('voteCount', { n: a.total })}</p>
      <div class="vote-options">${options}</div>`;
  }
  return `
    <section class="panel stack award" data-award="${a.id}">
      <div class="award-head"><h3>${awardTitle(a)}</h3><span class="badge status-${a.status}">${t(`voteStatus_${a.status}`)}</span></div>
      ${body}
    </section>`;
}

const money = (n) => new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-GB', { style: 'currency', currency: 'VND' }).format(n);

// §10: the prizes. The podium's as three medal tiles; the voted awards (§5.7) as a list, each row showing where
// its vote stands (Vote, Voted, not open yet, or the winner once closed) and opening it. The voted awards share
// one amount, shown once in their heading.
function prizesHtml() {
  const total = PRIZES.reduce((sum, p) => sum + p.amount, 0);
  const awards = PRIZES.filter((p) => p.award);
  const tiles = PRIZES.filter((p) => p.place).map(
    (p) => `<li><span class="medal ${p.place}"></span><span class="place">${t(p.place)}</span><span class="amount">${money(p.amount)}</span></li>`,
  );
  const rows = awards.map((p) => {
    const a = votes?.awards.find((x) => x.id === p.award);
    let vote = '';
    if (a?.status === 'open') vote = a.mine ? `<span class="button small secondary">${t('voteDone')}</span>` : `<span class="button small">${t('vote')}</span>`;
    else if (a?.status === 'closed' && a.winners.length) vote = `<span class="winner">${a.winners.map((c) => esc(teamText(c))).join(', ')}</span>`;
    else if (a) vote = `<span class="status">${t(`voteStatus_${a.status}`)}</span>`;
    return `<li><a class="prize-row" href="#vote/${p.award}"><span class="name">${t(`award_${p.award}`)}</span>${vote}</a></li>`;
  });
  return `
    <section class="prizes">
      <h2>${t('prizes')}<small>${money(total)}</small></h2>
      <ul class="prize-tiles">${tiles.join('')}</ul>
      <h3>${t('votedAwards')}<small>${t('eachPrize', { amount: money(awards[0].amount) })}</small></h3>
      <ul class="prize-list panel">${rows.join('')}</ul>
    </section>`;
}

// §5.7: the awards open for voting that this phone hasn't voted on yet, in a highlighted card at the top of Overview.
function voteCallHtml() {
  const open = votes?.awards.filter((a) => a.status === 'open' && !a.mine) ?? [];
  if (!open.length) return '';
  const rows = open.map((a) => `<li><span>${awardTitle(a)}</span><a class="button small" href="#vote/${a.id}">${t('vote')}</a></li>`);
  return `<section class="vote-call"><h2>${t('voteCallTitle')}</h2><ul>${rows.join('')}</ul></section>`;
}

// §5.7: one award's vote, in a popup over Overview. It has its own address (#vote/<award>), so the phone's
// Back button closes it and organizers can share a link straight to it.
function voteSheet(id) {
  const a = votes?.awards.find((x) => x.id === id);
  const prize = PRIZES.find((p) => p.award === id);
  return `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(t(`award_${id}`))}" tabindex="-1">
      <div class="sheet-head">
        <span class="amount">${t('prizeValue', { amount: money(prize.amount) })}</span>
        <button type="button" class="button small secondary" data-action="close-sheet">${t('close')}</button>
      </div>
      ${a ? awardCard(a) : `<p class="empty">${t('loading')}</p>`}
      <p class="hint">${t('voteHint')}</p>
    </div>`;
}

// Back to where the popup was opened from; a popup opened from a link outside the site goes to Overview.
function closeSheet() {
  if (history.state?.fromPage) history.back();
  else location.replace('#');
}

// Admin: open, close or reopen each award.
function awardControls() {
  if (!votes) return '';
  const next = { not_open: ['open', 'voteOpen'], open: ['closed', 'voteClose'], closed: ['open', 'voteReopen'] };
  const rows = votes.awards
    .map((a) => {
      const [status, label] = next[a.status];
      return `
        <li>
          <span><strong>${awardTitle(a)}</strong> · ${t(`voteStatus_${a.status}`)} · ${t('voteCount', { n: a.total })}</span>
          <button type="button" class="button small${a.status === 'open' ? '' : ' secondary'}" data-action="award-status" data-award="${a.id}" data-status="${status}">${t(label)}</button>
        </li>`;
    })
    .join('');
  return `<section><h2>${t('vote')}</h2><ul class="award-controls panel">${rows}</ul></section>`;
}

const isConfirming = (action, id) => confirming?.action === action && confirming.id === String(id);
// Shown in place of the button that asked for it; Confirm repeats that button's action with data-confirmed.
function confirmBox(message, { action, id, side = '' }, yesClass = 'danger') {
  return `
    <div class="confirm" role="alertdialog" aria-label="${esc(message)}">
      <p>${esc(message)}</p>
      <div class="actions">
        <button type="button" class="button ${yesClass}" data-action="${action}" data-id="${id}" data-side="${side}" data-confirmed="yes">${t('confirmYes')}</button>
        <button type="button" class="button secondary" data-action="cancel-confirm">${t('confirmNo')}</button>
      </div>
    </div>`;
}
const formatDate = (iso) =>
  new Date(iso).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const ICONS = {
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 21v-7.5H16l.4-3H13.5V8.7c0-.9.3-1.5 1.5-1.5h1.6V4.6c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.1H8v3h2.5V21z"/></svg>`,
  website: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z"/></svg>`,
};
const notFound = () => `${back()}<p class="note">${t('error_not_found')}</p>`;

// ---------- Views ----------

const views = {
  // §10: an open vote first, then the matches, then the prizes at the bottom; once the final and the 3rd-place
  // match are both decided, the final results come first, under the progress.
  overview() {
    const { progress, matches, podium } = state;
    const next = matches.filter((m) => m.state === 'ready').slice(0, 4);
    const latest = matches.filter((m) => m.state === 'finished').reverse().slice(0, 4);
    const decided = Boolean(podium.champion && podium.third);
    return `
      <section class="progress">
        <p>${t('progress', { done: progress.finished, total: progress.total })}</p>
        <div class="bar"><span style="width: ${(100 * progress.finished) / progress.total}%"></span></div>
      </section>
      ${voteCallHtml()}
      ${decided ? podiumHtml() : ''}
      ${cardList(t('liveNow'), matches.filter((m) => m.state === 'live'), t('noLive'))}
      ${next.length ? upNextHtml(next) : ''}
      ${latest.length ? cardList(t('latest'), latest) : ''}
      ${prizesHtml()}`;
  },

  groups(openAll = false) {
    const cols = ['colPlayed', 'colWon', 'colLost', 'colPf', 'colPa', 'colPd'];
    const sections = Object.entries(state.groups).map(([g, group]) => {
      const qualified = (r) => group.resolved && r.rank <= 2;
      const matches = state.matches.filter((m) => m.group === g);
      const rows = group.rows
        .map(
          (r) => `
          <tr class="${qualified(r) ? 'qualified' : ''}">
            <td><span class="rank">${r.rank}</span>${qualified(r) ? `<span class="sr">${t('qualified')}</span>` : ''}</td>
            <td class="team"><span class="name">${esc(teamText(r.code))}</span></td>
            <td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.pf}</td><td>${r.pa}</td><td>${signed(r.pd)}</td>
          </tr>`,
        )
        .join('');
      return `
        <section data-group="${g}">
          <h2>${t('group', { g })}<small>${t(group.complete ? 'groupDone' : 'provisional')}</small></h2>
          ${tieNote(group)}
          <div class="table-wrap"><table class="standings">
            <thead><tr><th>#</th><th>${t('colTeam')}</th>${cols.map((c) => `<th>${t(c)}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          ${group.resolved ? `<p class="legend"><span class="rank-key"></span>${t('qualified')}</p>` : ''}
          ${openAll ? '<details class="group-matches" open>' : `<details class="group-matches" data-matches="${g}"${openMatchLists.has(g) ? ' open' : ''}>`}
            <summary>${t('groupMatches', { n: matches.length })}</summary>
            <div class="cards">${matches.map((m) => matchCard(m)).join('')}</div>
          </details>
        </section>`;
    });
    return `${sections.join('')}<p class="legend">${t('tableLegend')}</p>`;
  },

  knockout() {
    const stage = (s) => state.matches.filter((m) => m.stage === s);
    return [
      cardList(t('final'), stage('final')),
      cardList(t('thirdPlace'), stage('third_place')),
      cardList(t('semifinals'), stage('semifinal')),
    ].join('');
  },

  login() {
    return `
      <section class="panel narrow">
        <form data-form="login" class="stack">
          <h2>${t('loginTitle')}</h2>
          <label for="pin">${t('pin')}</label>
          <input id="pin" name="pin" type="password" autocomplete="current-password" required>
          <p class="form-error" role="alert"></p>
          <button type="submit" class="button">${t('login')}</button>
        </form>
      </section>`;
  },

  admin() {
    const draws = Object.entries(state.groups)
      .filter(([, group]) => group.drawTie)
      .map(([g, group]) => `<div class="note-row">${tieNote(group)}<a class="button small" href="#draw/${g}">${t('enterDraw')}</a></div>`);
    const section = (title, matches) =>
      `<section><h2>${title}</h2><div class="cards">${matches.map((m) => matchCard(m, adminActions(m), lockDot(m))).join('')}</div></section>`;
    const anyLocked = state.matches.some((m) => m.lockedBy.length);
    return `
      <div class="admin-head">
        <h2>${t('adminTitle')}</h2>
        <div class="actions">
          <a class="button small secondary" href="#history">${t('history')}</a>
          <a class="button small danger" href="#reset">${t('clearAll')}</a>
          <button type="button" class="button small secondary" data-action="logout">${t('logout')}</button>
        </div>
      </div>
      ${draws.join('')}
      ${awardControls()}
      ${Object.keys(state.groups).map((g) => section(t('group', { g }), state.matches.filter((m) => m.group === g))).join('')}
      ${section(t('navKnockout'), state.matches.filter((m) => m.stage !== 'group'))}
      ${anyLocked ? `<p class="legend lock-legend"><span class="lock-dot"></span>${t('lockedLegend')}</p>` : ''}`;
  },

  // §5.5: clears every result and draw. Typing the PIN again is the confirmation.
  reset() {
    return `
      ${back()}
      <form data-form="reset" class="panel stack">
        <h2>${t('resetTitle')}</h2>
        <p class="note">${t('resetWarning')}</p>
        <label for="confirm-pin">${t('resetPin')}</label>
        <input id="confirm-pin" name="pin" type="password" autocomplete="off" required>
        <p class="form-error" role="alert"></p>
        <button type="submit" class="button danger">${t('resetButton')}</button>
      </form>`;
  },

  sponsors() {
    // Each link opens the sponsor's page in a new tab; the label names the sponsor for screen readers.
    const links = (s) =>
      Object.entries(s.links ?? {})
        .map(
          ([kind, url]) => `
          <a class="social ${kind}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`${s.name} · ${t(kind)}`)}">
            ${ICONS[kind]}<span>${t(kind)}</span>
          </a>`,
        )
        .join('');
    const cards = SPONSORS.map(
      (s) => `<li class="sponsor"><img src="${s.logo}" alt="" data-shape="${s.shape}"><strong>${esc(s.name)}</strong><div class="socials">${links(s)}</div></li>`,
    ).join('');
    return `
      <section>
        <h2>${t('sponsors')}</h2>
        <p class="hint">${t('sponsorsThanks')}</p>
        <ul class="sponsors">${cards}</ul>
      </section>`;
  },

  // §5.1, §5.3, §5.4: typed sets, walkover and clear for one match.
  edit(id) {
    const m = byId(id);
    if (!m) return notFound();
    if (m.state === 'waiting') return `${back()}${matchCard(m)}<p class="note">${t('teamsUnknown')}</p>`;
    if (m.lockedBy.length) return `${back()}${matchCard(m)}${lockedNote(m)}`;
    const prefill = m.result === 'sets' ? m.sets : [];
    const input = (i, side) => {
      const label = `${t('set', { n: i + 1 })}, ${sideText(m, side)}`;
      return `<input name="s${i}-${side}" inputmode="numeric" pattern="[0-9]*" maxlength="2" autocomplete="off"
        aria-label="${esc(label)}" value="${prefill[i]?.[side - 1] ?? ''}">`;
    };
    const rows = Array.from(
      { length: m.format.sets },
      (_, i) => `<div class="set-row"><span>${t('set', { n: i + 1 })}</span>${input(i, 1)}${input(i, 2)}</div>`,
    ).join('');
    const walkovers = isConfirming('walkover', m.id)
      ? confirmBox(t('confirmWalkover', { team: sideText(m, Number(confirming.side)) }), confirming, '')
      : [1, 2]
          .map(
            (s) =>
              `<button type="button" class="button secondary" data-action="walkover" data-id="${m.id}" data-side="${s}">${t('walkoverWins', { team: esc(sideText(m, s)) })}</button>`,
          )
          .join('');
    const clear = !m.result
      ? ''
      : isConfirming('clear', m.id)
        ? confirmBox(t('confirmClear', { match: matchText(m) }), confirming)
        : `<button type="button" class="button danger" data-action="clear" data-id="${m.id}">${t('clear')}</button>`;
    return `
      ${back()}
      ${matchCard(m)}
      <form data-form="sets" data-id="${m.id}" class="panel stack">
        <h2>${matchText(m)}</h2>
        <p class="hint">${formatText(m)}</p>
        <div class="set-row head"><span></span><strong>${esc(sideText(m, 1))}</strong><strong>${esc(sideText(m, 2))}</strong></div>
        ${rows}
        <p class="preview" aria-live="polite"></p>
        <button type="submit" class="button">${t('save')}</button>
      </form>
      <section class="panel stack">
        <h3>${t('walkoverTitle')}</h3>
        <div class="actions">${walkovers}</div>
      </section>
      ${clear}`;
  },

  // §5.2: the referee's screen. Each side is one big button; tapping it gives that side the rally.
  live(id) {
    const m = byId(id);
    if (!m) return notFound();
    const head = `<div class="live-head">${back()}<h2>${matchText(m)}</h2></div><p class="hint">${formatText(m)}</p>`;
    if (m.state === 'waiting') return `${head}<p class="note">${t('teamsUnknown')}</p>`;
    if (m.lockedBy.length) return `${head}${lockedNote(m)}`;
    if (m.result && m.result !== 'live') {
      return `${head}<p class="note">${t('hasResult')}</p><a class="button secondary" href="#edit/${m.id}">${t('enterScore')}</a>`;
    }
    if (m.firstServer === null) {
      const choices = [1, 2]
        .map(
          (s) =>
            `<button type="button" class="button big" data-action="serve" data-id="${m.id}" data-side="${s}">${t('servesFirst', { team: esc(sideText(m, s)) })}</button>`,
        )
        .join('');
      return `${head}<section class="panel stack"><h3>${t('whoServesFirst')}</h3>${choices}</section>`;
    }

    const decided = m.winner !== null;
    const shown = decided ? m.sets.at(-1) : m.current;
    const mine = tapping.match === m.id;
    const court = (s) => {
      const serving = !decided && m.serve.side === s;
      return `
        <button type="button" class="court${serving ? ' serving' : ''}${m.winner === s ? ' won' : ''}"
          data-action="point" data-id="${m.id}" data-side="${s}" ${decided || tapping.busy ? 'disabled' : ''}>
          <span class="name">${esc(sideText(m, s))}</span>
          <span class="big">${shown[s - 1]}</span>
          ${m.format.sets > 1 ? `<span class="sets-won">${t('setsWon', { n: m.setsWon[s - 1] })}</span>` : ''}
          ${serving ? `<span class="serve-label">${t('serving', { court: courtText(m) })}</span>` : ''}
        </button>`;
    };
    const status = mine && tapping.status ? (tapping.status.key ? t(tapping.status.key) : errorText(tapping.status.error)) : '';
    const order = flipped.has(m.id) ? [2, 1] : [1, 2];
    return `<div class="live">
      ${head}
      <div class="courts">${order.map(court).join('')}</div>
      ${decided ? `<p class="result">${t('matchWon', { team: esc(sideText(m, m.winner)) })}</p>` : ''}
      ${m.sets.length ? `<p class="history">${m.sets.map(([a, b]) => `${a}–${b}`).join(' · ')}</p>` : ''}
      <div class="live-bar">
        <button type="button" class="button secondary" data-action="undo" data-id="${m.id}" ${m.points === 0 || tapping.busy ? 'disabled' : ''}>${t('undo')}</button>
        <button type="button" class="button secondary" data-action="swap" data-id="${m.id}">${t('swapSides')}</button>
        <span class="status" role="status">${esc(status)}</span>
      </div>
      ${m.points === 0 ? `<button type="button" class="link" data-action="serve" data-id="${m.id}" data-side="${3 - m.firstServer}">${t('changeFirstServer')}</button>` : ''}
      ${mine && tapping.changeEnds ? `<button type="button" class="overlay" data-action="change-ends" data-id="${m.id}"><strong>${t('changeEnds')}</strong><span>${t('tapToSwap')}</span></button>` : ''}
    </div>`;
  },

  // §5.6: the list of saved tournaments, newest first, or one saved copy (read-only).
  history(id) {
    if (id) return historyEntry(id);
    if (historyList === null) return `<p class="empty">${t('loading')}</p>`;
    if (historyList.error) return `<p class="note">${esc(historyList.error)}</p>`;
    const item = (h) => {
      const date = formatDate(h.clearedAt);
      return `
        <article class="match history-item" data-history="${h.id}">
          <header><span>${esc(date)}</span><span class="badge">${t('progress', { done: h.finished, total: h.total })}</span></header>
          <p>${h.champion ? `${t('champion')}: <strong>${esc(h.champion)}</strong>` : t('historyNoChampion')}</p>
          <div class="actions">
            <a class="button small" href="#history/${h.id}">${t('historyView')}</a>
            ${isConfirming('delete-history', h.id) ? '' : `<button type="button" class="button small danger" data-action="delete-history" data-id="${h.id}">${t('historyDelete')}</button>`}
          </div>
          ${isConfirming('delete-history', h.id) ? confirmBox(t('confirmDeleteHistory', { date }), confirming) : ''}
        </article>`;
    };
    return `
      ${back()}
      <section>
        <h2>${t('history')}</h2>
        <p class="hint">${t('historyHint')}</p>
        ${historyList.length ? `<div class="cards history-list">${historyList.map(item).join('')}</div>` : `<p class="empty">${t('historyEmpty')}</p>`}
      </section>`;
  },

  // §6.3: the organizer records the order the tied teams were drawn in.
  draw(g) {
    const group = Object.hasOwn(state.groups, g) ? state.groups[g] : null;
    if (!group?.drawTie) return `${back()}<p class="note">${t('error_no_draw_needed')}</p>`;
    const { teams, order } = group.drawTie;
    const current = order ?? teams;
    const start = group.rows.findIndex((r) => teams.includes(r.code)) + 1;
    const selects = teams
      .map(
        (_, i) => `
        <label for="p${i}">${t('drawPosition', { n: start + i })}</label>
        <select id="p${i}" name="p${i}">
          ${teams.map((c) => `<option value="${c}"${c === current[i] ? ' selected' : ''}>${esc(teamText(c))}</option>`).join('')}
        </select>`,
      )
      .join('');
    return `
      ${back()}
      <form data-form="draw" data-group="${g}" class="panel stack">
        <h2>${t('drawTitle', { group: t('group', { g }) })}</h2>
        <p class="hint">${t('drawHelp')}</p>
        ${selects}
        <p class="form-error" role="alert"></p>
        <button type="submit" class="button">${t('saveDraw')}</button>
      </form>`;
  },
};

// One saved copy, drawn with the same pieces as the live tournament: the copy is swapped in while it renders.
function historyEntry(id) {
  const entry = historyEntries[id];
  const backToList = `<a class="back" href="#history">← ${t('history')}</a>`;
  if (!entry) return `${backToList}<p class="empty">${t('loading')}</p>`;
  if (entry.error) return `${backToList}<p class="note">${esc(entry.error)}</p>`;
  const date = formatDate(entry.clearedAt);
  const current = state;
  state = entry.state;
  archived = true;
  try {
    return `
      ${backToList}
      <div class="admin-head">
        <h2>${t('historyTitle', { date: esc(date) })}</h2>
        ${isConfirming('delete-history', entry.id) ? '' : `<button type="button" class="button small danger" data-action="delete-history" data-id="${entry.id}">${t('historyDelete')}</button>`}
      </div>
      ${isConfirming('delete-history', entry.id) ? confirmBox(t('confirmDeleteHistory', { date }), confirming) : ''}
      <p class="hint">${t('historyReadOnly')} ${t('progress', { done: state.progress.finished, total: state.progress.total })}.</p>
      ${podiumHtml()}
      ${(state.votes ?? []).map((a) => `<section class="panel stack award"><h3>${awardTitle(a)}</h3>${voteResults(a)}</section>`).join('')}
      ${views.knockout()}
      ${views.groups(true)}`;
  } finally {
    state = current;
    archived = false;
  }
}

async function loadHistory(id) {
  const key = id ?? 'list';
  if (historyLoading === key) return;
  historyLoading = key;
  let r;
  try {
    r = await api('GET', id ? `/api/history/${id}` : '/api/history');
  } catch {
    r = { ok: false, data: { error: 'network' } };
  }
  if (r.status === 401) forgetPin();
  const value = r.ok ? r.data : { error: errorText(r.data ?? {}) };
  if (id) historyEntries[id] = value;
  else historyList = value;
  historyLoading = null;
  render();
}

// ---------- Typed-score form ----------

// §4, §5.1: sets are entered one at a time. A set's boxes open only once every set before it is a valid
// finished set and the match isn't decided yet; sets after the deciding one are emptied. Each problem is
// explained with the rule it breaks, and Save works only once the match is decided. Returns the valid sets.
function checkScoreForm(form) {
  const m = byId(form.dataset.id);
  const rows = [...form.querySelectorAll('.set-row:not(.head)')];
  const need = Math.ceil(m.format.sets / 2);
  const won = [0, 0];
  const sets = [];
  let message = null;
  let isError = false;
  let open = true;
  let decided = false;
  rows.forEach((row, i) => {
    const inputs = [...row.querySelectorAll('input')];
    for (const input of inputs) {
      input.value = input.value.replace(/\D/g, '').slice(0, 2);
      if (decided) input.value = '';
      input.disabled = !open;
    }
    row.classList.toggle('closed', !open);
    if (!open) return;
    const [a, b] = inputs.map((input) => input.value);
    if (a === '' || b === '') {
      open = false;
      isError = a !== '' || b !== '';
      message = t(isError ? 'setHalf' : 'setNext', { set: i + 1 });
      return;
    }
    const set = [Number(a), Number(b)];
    const reason = setProblem(set, m.format);
    if (reason) {
      open = false;
      isError = true;
      message = setText(reason, i + 1, m.format);
      return;
    }
    sets.push(set);
    won[set[0] > set[1] ? 0 : 1]++;
    if (won.includes(need)) decided = true;
    open = !decided;
  });

  const out = form.querySelector('.preview');
  form.querySelector('button[type="submit"]').disabled = !decided;
  if (decided) {
    const winner = won[0] === need ? 1 : 2;
    const team = sideText(m, winner);
    const parts = [m.format.sets > 1 ? t('winnerIsSets', { team, score: `${won[winner - 1]}–${won[2 - winner]}` }) : t('winnerIs', { team })];
    if (sets.length < rows.length) parts.push(t('noMoreSets', { set: sets.length + 1 }));
    out.textContent = parts.join(' ');
    out.className = 'preview ok';
  } else {
    out.textContent = message ?? '';
    out.className = isError ? 'preview error' : 'preview';
  }
  return sets;
}

// ---------- Rendering and routing ----------

function route(hash = location.hash) {
  const [view, arg] = hash.slice(1).split('/');
  if (view === 'vote') return { view: 'overview', sheet: AWARD_IDS.includes(arg) ? arg : null };
  if (PUBLIC_VIEWS.includes(view)) return { view };
  if (ADMIN_VIEWS.includes(view) && view !== 'login') return pin ? { view, arg } : { view: 'login' };
  return { view: 'overview' };
}

function render({ fromPoll = false } = {}) {
  const { view, arg, sheet } = route();
  const key = `${view}/${arg ?? ''}`;
  document.documentElement.lang = lang;
  document.body.dataset.page = view; // lets the stylesheet adapt the referee's live screen
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-label]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nLabel)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  const tab = ADMIN_VIEWS.includes(view) ? 'admin' : view;
  document.querySelectorAll('nav [data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === tab));
  document.querySelectorAll('nav [data-admin-only]').forEach((el) => (el.hidden = !pin));
  if (view === 'history' && (arg ? !historyEntries[arg] : historyList === null)) loadHistory(arg);
  if (!state) return;
  // A red dot on Overview's tab while a match is live, so people on other tabs know there is something to watch.
  const overviewTab = document.querySelector('nav [data-view="overview"]');
  const live = state.matches.some((m) => m.state === 'live');
  overviewTab.classList.toggle('has-live', live);
  if (live) overviewTab.setAttribute('aria-label', `${t('navOverview')} · ${t('liveNow')}`);
  else overviewTab.removeAttribute('aria-label');
  renderSheet(sheet);
  const busy = typing || main.contains(document.activeElement) && document.activeElement.matches('input, select');
  if (fromPoll && FORM_VIEWS.includes(view) && rendered === key && busy) return;

  const shown =
    notice && notice.until > Date.now()
      ? `<p class="notice${notice.error ? ' error' : ''}" role="status">${esc(notice.text)}</p>`
      : '';
  main.innerHTML = shown + views[view](arg);
  rendered = key;
  const form = main.querySelector('form[data-form="sets"]');
  if (form) checkScoreForm(form);
}

function renderSheet(id) {
  const html = id ? voteSheet(id) : '';
  document.body.classList.toggle('sheet-open', Boolean(id));
  if (html === sheetShown) return;
  const opening = !sheetShown;
  sheetShown = html;
  sheetLayer.hidden = !id;
  sheetLayer.innerHTML = html;
  if (id && opening) sheetLayer.querySelector('.sheet').focus();
}

// ---------- Events ----------

document.addEventListener('click', async (e) => {
  if (e.target === sheetLayer) return closeSheet(); // a tap on the dimmed page around the popup
  if (e.target.closest('a[href^="#vote/"]')) sheetLinkTapped = true;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  const side = Number(el.dataset.side);
  if (['walkover', 'clear', 'delete-history'].includes(action)) {
    if (el.dataset.confirmed !== 'yes') {
      confirming = { action, id, side: el.dataset.side ?? '' };
      render();
      main.querySelector('.confirm [data-confirmed]')?.focus();
      return;
    }
    confirming = null;
  }
  if (action === 'cancel-confirm') {
    confirming = null;
    render();
  } else if (action === 'close-sheet') {
    closeSheet();
  } else if (action === 'lang') {
    lang = lang === 'vi' ? 'en' : 'vi';
    remember('lang', lang);
    render();
  } else if (action === 'logout') {
    forgetPin();
    historyList = null;
    for (const key of Object.keys(historyEntries)) delete historyEntries[key];
    location.hash = '';
    render();
  } else if (action === 'point') {
    await tap(id, 'point', { side });
  } else if (action === 'undo') {
    await tap(id, 'undo', {});
  } else if (action === 'swap' || action === 'change-ends') {
    // The teams have changed ends on court (§5.2), so this phone's screen swaps its panels too.
    if (action === 'change-ends') tapping.changeEnds = false;
    if (flipped.has(id)) flipped.delete(id);
    else flipped.add(id);
    remember('flipped', JSON.stringify([...flipped]));
    render();
  } else if (action === 'vote') {
    const r = await send('PUT', `/api/votes/${el.dataset.award}`, { voter, team: el.dataset.team });
    if (r.ok) votes = r.data;
    else await loadVotes(); // e.g. it was closed a moment ago: show its results
    if (!r.ok) setNotice(r.message, true);
    render();
    sheetLayer.querySelector('[aria-pressed="true"]')?.focus(); // the popup was redrawn; keep the place
  } else if (action === 'award-status') {
    const r = await send('PUT', `/api/awards/${el.dataset.award}`, { status: el.dataset.status });
    if (r.ok) votes = r.data;
    else setNotice(r.message, true);
    render();
  } else if (action === 'serve') {
    const r = await send('PUT', `/api/matches/${id}/serve`, { side });
    if (!r.ok) setNotice(r.message, true);
    render();
  } else if (action === 'walkover') {
    const r = await send('POST', `/api/matches/${id}/walkover`, { winner: side });
    setNotice(r.ok ? t('saved') : r.message, !r.ok);
    if (r.ok) location.hash = '#admin';
    else render();
  } else if (action === 'delete-history') {
    const r = await send('DELETE', `/api/history/${id}`);
    setNotice(r.ok ? t('historyDeleted') : r.message, !r.ok);
    delete historyEntries[id];
    historyList = null;
    if (location.hash === '#history') {
      render();
      window.scrollTo(0, 0);
    } else location.hash = '#history';
  } else if (action === 'clear') {
    const r = await send('DELETE', `/api/matches/${id}`);
    setNotice(r.ok ? t('cleared') : r.message, !r.ok);
    typing = false;
    render();
    window.scrollTo(0, 0); // the notice and the match card (now empty) are at the top
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const message = form.querySelector('.form-error, .preview');
  if (form.dataset.form === 'reset') {
    // The typed PIN is sent instead of the remembered one; a wrong one shows an error without logging out.
    let res;
    try {
      res = await api('DELETE', '/api/results', undefined, form.elements.pin.value);
    } catch {
      message.textContent = t('error_network');
      return;
    }
    if (!res.ok) {
      message.textContent = errorText(res.data ?? {});
      return;
    }
    state = res.data;
    changes++;
    flipped.clear();
    remember('flipped', null);
    historyList = null;
    const parts = [t('resetDone'), res.data.archived ? t('resetArchived') : '', res.data.backup ? t('resetBackup', { file: res.data.backup }) : ''];
    setNotice(parts.filter(Boolean).join(' '));
    location.hash = '#admin';
    render();
    return;
  }
  let r;
  if (form.dataset.form === 'login') {
    pin = form.elements.pin.value;
    r = await send('POST', '/api/login');
    if (r.ok) remember('pin', pin);
    else pin = null;
  } else if (form.dataset.form === 'sets') {
    r = await send('PUT', `/api/matches/${form.dataset.id}/sets`, { sets: checkScoreForm(form) });
  } else if (form.dataset.form === 'draw') {
    const order = [...form.querySelectorAll('select')].map((select) => select.value);
    r = await send('PUT', `/api/draws/${form.dataset.group}`, { order });
  }
  if (r.ok) {
    typing = false;
    if (form.dataset.form !== 'login') {
      setNotice(t('saved'));
      location.hash = '#admin';
    }
    render();
  } else if (!pin && form.dataset.form !== 'login') {
    render(); // the PIN stopped working: show the login form
  } else {
    message.textContent = r.message;
    message.classList.add('error');
  }
});

document.addEventListener('input', (e) => {
  if (e.target.closest('main form')) typing = true;
  const form = e.target.closest('form[data-form="sets"]');
  if (form) checkScoreForm(form);
});

window.addEventListener('hashchange', (e) => {
  confirming = null;
  typing = false;
  if (location.hash === '#history') historyList = null;
  if (tapping.match !== route().arg) tapping = idleTapping();
  // A popup opened from this page marks its history entry, so closing it can go back instead of adding a step.
  if (sheetLinkTapped && route().sheet) history.replaceState({ fromPage: true }, '');
  sheetLinkTapped = false;
  render();
  // Opening or closing a popup leaves Overview where it was.
  if (!route().sheet && !route(new URL(e.oldURL).hash).sheet) window.scrollTo(0, 0);
  refresh(); // fetch the latest data at once, e.g. a result another organizer just entered
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && route().sheet) closeSheet();
});

// Remember which match lists are open (each group's, and Up next on Overview), so a poll's re-render doesn't fold
// them away again.
// ("toggle" doesn't bubble, hence the capture phase.)
document.addEventListener(
  'toggle',
  (e) => {
    const g = e.target.dataset?.matches;
    if (!g) return;
    if (e.target.open) openMatchLists.add(g);
    else openMatchLists.delete(g);
  },
  true,
);

// §10: the sponsors' logos sit next to the Trueson logo and lead to the Sponsors page.
document.querySelector('.sponsor-logos').innerHTML = SPONSORS.map((s) => `<img src="${s.logo}" alt="${esc(s.name)}" data-shape="${s.shape}">`).join('');

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
  else clearTimeout(pollTimer);
});

render();
refresh();
