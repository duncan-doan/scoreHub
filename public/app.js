// The whole interface: spectator views, the hidden admin (#admin) and live scoring (docs/SPEC.md §5, §10).
// Everything shown comes from GET /api/state. The only thing worked out here is the winner preview while
// typing a score, and that uses the same rules.js as the server.
import { STRINGS } from './i18n.js';
import { checkSets } from './rules.js';
import { SPONSORS } from './sponsors.js';

const POLL_LIVE_MS = 3000;
const POLL_IDLE_MS = 15000;
const TAP_RETRIES = 5;
const NOTICE_MS = 5000;
const PUBLIC_VIEWS = ['groups', 'knockout', 'sponsors'];
const ADMIN_VIEWS = ['admin', 'edit', 'live', 'draw', 'reset', 'login'];
// Views with inputs: a poll must not re-render them while someone is typing.
const FORM_VIEWS = ['edit', 'draw', 'reset', 'login'];

const main = document.querySelector('main');

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
let state = null;
let notice = null; // { text, error, until }
let tapping = idleTapping();
let rendered = null; // the view last rendered, so polling can leave forms alone
let pollTimer;

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
  return t({ waiting: 'stateWaiting', ready: 'stateReady', live: 'stateLive', finished: 'stateFinished' }[m.state]);
}

function errorText({ error = 'server_error', details = {} } = {}) {
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
  if (r.ok) return { ok: true };
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
  try {
    const r = await api('GET', '/api/state');
    if (r.ok) {
      state = r.data;
      render({ fromPoll: true });
    }
  } catch {}
  schedule();
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
  if (m.state === 'live') cells.push(`<span class="set now">${m.current[side - 1]}</span>`);
  return cells.join('');
}

// extra goes under the two sides (admin buttons); mark goes in the header, before the state (the lock dot).
function matchCard(m, extra = '', mark = '') {
  const serving = (side) =>
    m.state === 'live' && m.serve.side === side
      ? `<span class="serve"><span class="sr">${t('serving', { court: courtText(m) })}</span></span>`
      : '';
  const row = (side) => `
    <div class="side${m.winner === side ? ' won' : ''}">
      <span class="name">${esc(sideText(m, side))}${serving(side)}</span>
      <span class="score">${scoreCells(m, side)}</span>
    </div>`;
  return `
    <article class="match is-${m.state}" data-match="${m.id}">
      <header><span>${matchText(m)}</span><span class="badge">${mark}${stateText(m)}</span></header>
      ${row(1)}${row(2)}${extra}
    </article>`;
}

function cardList(title, matches, empty) {
  const body = matches.length
    ? `<div class="cards">${matches.map((m) => matchCard(m)).join('')}</div>`
    : `<p class="empty">${empty}</p>`;
  return `<section><h2>${title}</h2>${body}</section>`;
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

const back = () => `<a class="back" href="#admin">← ${t('back')}</a>`;

const ICONS = {
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 21v-7.5H16l.4-3H13.5V8.7c0-.9.3-1.5 1.5-1.5h1.6V4.6c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.1H8v3h2.5V21z"/></svg>`,
  website: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z"/></svg>`,
};
const notFound = () => `${back()}<p class="note">${t('error_not_found')}</p>`;

// ---------- Views ----------

const views = {
  overview() {
    const { podium, progress, matches } = state;
    const place = (key, code) =>
      code ? `<li class="place-${key}"><span>${t(key)}</span><strong>${esc(teamText(code))}</strong></li>` : '';
    const podiumHtml =
      podium.champion || podium.third
        ? `<section class="podium"><h2>${t('podiumTitle')}</h2><ol>
            ${place('champion', podium.champion)}${place('runnerUp', podium.runnerUp)}${place('third', podium.third)}
          </ol></section>`
        : '';
    const next = matches.filter((m) => m.state === 'ready').slice(0, 4);
    const latest = matches.filter((m) => m.state === 'finished').reverse().slice(0, 4);
    return `
      <section class="progress">
        <p>${t('progress', { done: progress.finished, total: progress.total })}</p>
        <div class="bar"><span style="width: ${(100 * progress.finished) / progress.total}%"></span></div>
      </section>
      ${podiumHtml}
      ${cardList(t('liveNow'), matches.filter((m) => m.state === 'live'), t('noLive'))}
      ${next.length ? cardList(t('upNext'), next) : ''}
      ${latest.length ? cardList(t('latest'), latest) : ''}`;
  },

  groups() {
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
          <details class="group-matches" data-matches="${g}"${openMatchLists.has(g) ? ' open' : ''}>
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
          <a class="button small danger" href="#reset">${t('clearAll')}</a>
          <button type="button" class="button small secondary" data-action="logout">${t('logout')}</button>
        </div>
      </div>
      ${draws.join('')}
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
      (s) => `<li class="sponsor"><img src="${s.logo}" alt=""><strong>${esc(s.name)}</strong><div class="socials">${links(s)}</div></li>`,
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
    const walkovers = [1, 2]
      .map(
        (s) =>
          `<button type="button" class="button secondary" data-action="walkover" data-id="${m.id}" data-side="${s}">${t('walkoverWins', { team: esc(sideText(m, s)) })}</button>`,
      )
      .join('');
    return `
      ${back()}
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
      ${m.result ? `<button type="button" class="button danger" data-action="clear" data-id="${m.id}">${t('clear')}</button>` : ''}`;
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

// ---------- Typed-score form ----------

// Rows left completely empty are ignored; a half-filled row becomes NaN, which rules.js rejects.
function readSets(form) {
  const num = (v) => (v.trim() === '' ? NaN : Number(v));
  return [...form.querySelectorAll('.set-row:not(.head)')]
    .map((row) => [...row.querySelectorAll('input')].map((input) => input.value))
    .filter(([a, b]) => a.trim() !== '' || b.trim() !== '')
    .map(([a, b]) => [num(a), num(b)]);
}

function preview(form) {
  const m = byId(form.dataset.id);
  const out = form.querySelector('.preview');
  const sets = readSets(form);
  out.className = 'preview';
  out.textContent = '';
  if (!sets.length) return;
  try {
    out.textContent = t('winnerIs', { team: sideText(m, checkSets(sets, m.format).winner) });
    out.className = 'preview ok';
  } catch (err) {
    out.textContent = t(`error_${err.code}`, err.details);
  }
}

// ---------- Rendering and routing ----------

function route() {
  const [view, arg] = location.hash.slice(1).split('/');
  if (PUBLIC_VIEWS.includes(view)) return { view };
  if (ADMIN_VIEWS.includes(view) && view !== 'login') return pin ? { view, arg } : { view: 'login' };
  return { view: 'overview' };
}

function render({ fromPoll = false } = {}) {
  const { view, arg } = route();
  const key = `${view}/${arg ?? ''}`;
  document.documentElement.lang = lang;
  document.body.dataset.page = view; // lets the stylesheet adapt the referee's live screen
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-label]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nLabel)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  const tab = ADMIN_VIEWS.includes(view) ? 'admin' : view;
  document.querySelectorAll('nav [data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === tab));
  document.querySelector('.more-toggle').classList.toggle('active', tab === 'sponsors');
  document.querySelector('nav [data-view="admin"]').hidden = !pin;
  if (!state) return;
  if (fromPoll && FORM_VIEWS.includes(view) && rendered === key) return;

  const shown =
    notice && notice.until > Date.now()
      ? `<p class="notice${notice.error ? ' error' : ''}" role="status">${esc(notice.text)}</p>`
      : '';
  main.innerHTML = shown + views[view](arg);
  rendered = key;
  const form = main.querySelector('form[data-form="sets"]');
  if (form) preview(form);
}

// ---------- Events ----------

// The "More" sub-menu closes on any click outside it, on Escape and on navigation.
function closeMore() {
  document.querySelector('.more-menu').hidden = true;
  document.querySelector('.more-toggle').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', async (e) => {
  if (!e.target.closest('.more')) closeMore();
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  const side = Number(el.dataset.side);
  if (action === 'more') {
    const menu = document.querySelector('.more-menu');
    menu.hidden = !menu.hidden;
    el.setAttribute('aria-expanded', String(!menu.hidden));
  } else if (action === 'lang') {
    lang = lang === 'vi' ? 'en' : 'vi';
    remember('lang', lang);
    render();
  } else if (action === 'logout') {
    forgetPin();
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
  } else if (action === 'serve') {
    const r = await send('PUT', `/api/matches/${id}/serve`, { side });
    if (!r.ok) setNotice(r.message, true);
    render();
  } else if (action === 'walkover') {
    if (!confirm(t('confirmWalkover', { team: sideText(byId(id), side) }))) return;
    const r = await send('POST', `/api/matches/${id}/walkover`, { winner: side });
    setNotice(r.ok ? t('saved') : r.message, !r.ok);
    if (r.ok) location.hash = '#admin';
    else render();
  } else if (action === 'clear') {
    if (!confirm(t('confirmClear', { match: labelOf(id) }))) return;
    const r = await send('DELETE', `/api/matches/${id}`);
    setNotice(r.ok ? t('saved') : r.message, !r.ok);
    render();
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
    flipped.clear();
    remember('flipped', null);
    setNotice(res.data.backup ? t('resetDoneBackup', { file: res.data.backup }) : t('resetDone'));
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
    r = await send('PUT', `/api/matches/${form.dataset.id}/sets`, { sets: readSets(form) });
  } else if (form.dataset.form === 'draw') {
    const order = [...form.querySelectorAll('select')].map((select) => select.value);
    r = await send('PUT', `/api/draws/${form.dataset.group}`, { order });
  }
  if (r.ok) {
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
  const form = e.target.closest('form[data-form="sets"]');
  if (form) preview(form);
});

window.addEventListener('hashchange', () => {
  closeMore();
  if (tapping.match !== route().arg) tapping = idleTapping();
  render();
  window.scrollTo(0, 0);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMore();
});

// Remember which groups' match lists are open, so a poll's re-render doesn't fold them away again.
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
document.querySelector('.sponsor-logos').innerHTML = SPONSORS.map((s) => `<img src="${s.logo}" alt="${esc(s.name)}">`).join('');

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
  else clearTimeout(pollTimer);
});

render();
refresh();
