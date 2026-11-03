// Every page at phone, tablet and desktop sizes, upright and sideways (docs/SPEC.md §10). Nothing may stick
// out sideways or have its label cut off, and the referee's live controls must fit without scrolling.
// Runs before tournament.spec.js (files run in name order) and clears the tournament again afterwards.
import { test, expect } from '@playwright/test';

const PIN = 'court-21';
const HEADERS = { 'X-Admin-Pin': PIN };
// [width, height]. Some heights are what's left once the browser's address bar takes its share.
const SIZES = [
  [320, 568], [360, 640], [375, 553], [375, 667], [390, 664], [412, 915], [430, 932], [768, 1024],
  [568, 320], [667, 320], [667, 375], [740, 360], [844, 340], [844, 390], [932, 430], [1024, 768], [1280, 800],
];
const VIEWS = ['', '#groups', '#knockout', '#sponsors', '#admin', '#edit/FINAL', '#edit/G1', '#live/FINAL', '#live/THIRD', '#reset'];
// Both groups done (SPEC §6.4 Examples 1 and 3) and both semifinals typed, so the final can be scored live.
const TYPED = { G1: [21, 15], G2: [21, 19], G3: [15, 21], G4: [21, 18], G5: [10, 21], G6: [21, 5], G7: [19, 21], G8: [21, 19], G9: [21, 8], SF1: [21, 15], SF2: [19, 21] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  for (const [id, set] of Object.entries(TYPED)) {
    expect((await request.put(`/api/matches/${id}/sets`, { headers: HEADERS, data: { sets: [set] } })).ok()).toBe(true);
  }
  // The final live: set 1 to 15-10, then 7-6 in set 2, so the screen shows set history and sets won.
  await request.put('/api/matches/FINAL/serve', { headers: HEADERS, data: { side: 1 } });
  const points = [...Array(15).fill(1), ...Array(10).fill(2)].sort((a, b) => a - b).reverse(); // 2s first, then 1s
  points.push(...[1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1]);
  for (const [count, side] of points.entries()) {
    expect((await request.post('/api/matches/FINAL/point', { headers: HEADERS, data: { side, count } })).ok()).toBe(true);
  }
});

test.afterAll(async ({ request }) => {
  expect((await request.delete('/api/results', { headers: HEADERS })).ok()).toBe(true);
});

// Runs in the page: anything wider than the screen, sticking out of it, or with its label cut off.
function layoutProblems(checkLabels) {
  const width = document.documentElement.clientWidth;
  const problems = [];
  if (document.documentElement.scrollWidth > width) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${width})`);
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.table-wrap, [hidden], svg')) continue; // tables scroll inside their own box
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > width + 1 || r.left < -1)) problems.push(`${el.tagName.toLowerCase()}.${el.className} sticks out (${Math.round(r.left)}–${Math.round(r.right)})`);
  }
  if (checkLabels) {
    for (const el of document.querySelectorAll('.tabs > a:not([hidden]), .more-toggle, .button, .pill, .social')) {
      if (el.scrollWidth > el.clientWidth + 1) problems.push(`label cut off: "${el.textContent.trim()}"`);
    }
  }
  return problems.slice(0, 5);
}

for (const lang of ['vi', 'en']) {
  for (const [width, height] of SIZES) {
    test(`${lang} ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await page.evaluate(([pin, l]) => (localStorage.setItem('pin', pin), localStorage.setItem('lang', l)), [PIN, lang]);
      await page.reload();
      for (const hash of VIEWS) {
        await page.goto(`/${hash}`);
        await expect(page.locator('main > *').first()).toBeVisible();
        // A 320px phone can't fit all five organizer menu labels; there they end in "…" (SPEC §10).
        expect(await page.evaluate(layoutProblems, width >= 360), hash || '#overview').toEqual([]);
        if (hash === '#live/FINAL') {
          for (const el of ['.court[data-side="1"]', '.court[data-side="2"]', '[data-action="undo"]', '[data-action="swap"]']) {
            await expect(page.locator(el), `${el} on the live screen`).toBeInViewport({ ratio: 1 });
          }
        }
      }
    });
  }
}
