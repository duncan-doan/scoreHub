// Feature checks beyond the main tournament run (docs/SPEC.md): the Trueson logo link, sponsor links, draws,
// locks, a refused correction and a best-of-3 match scored live. Runs first (files run in name order) and
// leaves the tournament empty for the files after it.
import { test, expect } from '@playwright/test';

const PIN = 'court-21';
const HEADERS = { 'X-Admin-Pin': PIN };
// SPEC §6.4 Examples 1 and 3: SF1 is Duyên – Khải v Huệ – Trinh, SF2 is Bảo – Miyoshi v Nguyên – Quỳnh.
const GROUPS_DONE = { G1: [21, 15], G2: [21, 19], G3: [15, 21], G4: [21, 18], G5: [10, 21], G6: [21, 5], G7: [19, 21], G8: [21, 19], G9: [21, 8] };
// SPEC §6.4 Example 4: group A level on everything, so it needs a draw.
const FULL_TIE_A = { G1: [21, 19], G4: [21, 19], G7: [19, 21] };

test.describe.configure({ mode: 'serial' });

async function enter(request, scores) {
  for (const [id, set] of Object.entries(scores)) {
    const sets = Array.isArray(set[0]) ? set : [set];
    expect((await request.put(`/api/matches/${id}/sets`, { headers: HEADERS, data: { sets } })).ok(), id).toBe(true);
  }
}

async function clearAll(request) {
  expect((await request.delete('/api/results', { headers: HEADERS })).ok()).toBe(true);
}

async function logIn(page) {
  await page.goto('/');
  await page.evaluate((pin) => localStorage.setItem('pin', pin), PIN);
  await page.reload();
}

test.afterAll(async ({ request }) => clearAll(request));

test('opening or refreshing the admin page keeps the Admin tab', async ({ page }) => {
  await logIn(page);
  for (const hash of ['#admin', '#reset', '#live/G1']) {
    await page.goto(`/${hash}`);
    await page.reload();
    await expect(page.locator('nav [data-view="admin"]')).toBeVisible();
    await expect(page.locator('nav [data-view="admin"]')).toHaveClass(/active/);
  }
});

test('the Trueson logo leads back to Overview', async ({ page }) => {
  await page.goto('/#groups');
  await expect(page.getByRole('heading', { name: 'Bảng A' })).toBeVisible();
  await page.getByRole('link', { name: 'Trueson', exact: true }).click();
  await expect(page.getByText('Đã đấu 0/13 trận')).toBeVisible();
  await expect(page.locator('nav [data-view="overview"]')).toHaveClass(/active/);
});

test('each sponsor links to its Facebook page and website, in a new tab', async ({ page }) => {
  await page.goto('/#sponsors');
  const expected = [
    ['Anh Sơn Movement · Facebook', 'https://www.facebook.com/profile.php?id=61590551370829'],
    ['Anh Sơn Movement · Trang web', 'https://www.anhsonmovement.org/#/home'],
    ['Kenichi Miyoshi · Facebook', 'https://www.facebook.com/kenichi.miyoshi'],
  ];
  await expect(page.locator('.social')).toHaveCount(expected.length);
  for (const [name, href] of expected) {
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
});

test("the sponsors' Facebook buttons line up across the cards", async ({ page }) => {
  for (const width of [360, 412, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#sponsors');
    const tops = await page.locator('.social.facebook').evaluateAll((links) => links.map((a) => Math.round(a.getBoundingClientRect().top)));
    expect(new Set(tops).size, `${width}px: ${tops}`).toBe(1);
  }
});

test('the Groups tab shows the tables, with each group\'s matches folded away', async ({ page }) => {
  await page.goto('/#groups');
  await expect(page.locator('[data-group="A"] .standings')).toBeVisible();
  const matches = page.locator('[data-matches="A"]');
  await expect(matches.locator('summary')).toHaveText('Các trận đấu (3)');
  await expect(matches.locator('.match').first()).toBeHidden();
  await matches.locator('summary').click();
  await expect(matches.locator('.match')).toHaveCount(3);
  await expect(matches.locator('.match').first()).toBeVisible();
  // A re-render (here the language switch; on the venue's phones, the 15-second refresh) keeps it open.
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('[data-matches="A"] summary')).toHaveText('Matches (3)');
  await expect(page.locator('[data-matches="A"] .match').first()).toBeVisible();
  await expect(page.locator('[data-matches="B"] .match').first()).toBeHidden();
});

test('the Knockout tab lists the final first, then the 3rd-place match, then the semifinals', async ({ page }) => {
  await page.goto('/#knockout');
  await expect(page.locator('main h2')).toHaveText(['Chung kết', 'Tranh hạng Ba', 'Bán kết']);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('main h2')).toHaveText(['Final', '3rd-place match', 'Semi-finals']);
  await expect(page.locator('main .match header > span:first-child')).toHaveText(['Final', '3rd-place match', 'Semi-final 1', 'Semi-final 2']);
});

test('an organizer records the draw for a full tie', async ({ page, request }) => {
  await enter(request, { ...GROUPS_DONE, ...FULL_TIE_A });
  await logIn(page);
  await page.goto('/#admin');
  await expect(page.locator('.note-row')).toContainText('Cần bốc thăm giữa Duyên – Khải, Triều – Đạt, Nguyên – Quỳnh.');
  await page.getByRole('link', { name: 'Nhập kết quả bốc thăm' }).click();
  await page.getByLabel('Hạng 1').selectOption({ label: 'Nguyên – Quỳnh' });
  await page.getByLabel('Hạng 2').selectOption({ label: 'Duyên – Khải' });
  await page.getByLabel('Hạng 3').selectOption({ label: 'Triều – Đạt' });
  await page.getByRole('button', { name: 'Lưu kết quả bốc thăm' }).click();
  await expect(page).toHaveURL(/#admin$/);
  await page.goto('/#groups');
  await expect(page.locator('[data-group="A"] tbody .team .name')).toHaveText(['Nguyên – Quỳnh', 'Duyên – Khải', 'Triều – Đạt']);
  await expect(page.locator('[data-group="A"] .note')).toHaveText('Thứ tự giữa Duyên – Khải, Triều – Đạt, Nguyên – Quỳnh theo kết quả bốc thăm.');
});

test('a finished semifinal locks the groups until it is cleared', async ({ page, request }) => {
  await enter(request, { SF1: [21, 15] }); // after the draw above, SF1 is Nguyên – Quỳnh v Huệ – Trinh
  await logIn(page);
  await page.goto('/#admin');
  // In the list: a red dot, the reason on hover, and one explanation at the bottom of the page.
  await expect(page.locator('[data-match="G1"] .lock-dot')).toHaveAttribute('title', 'Đã khóa vì Bán kết 1 đã có kết quả.');
  await expect(page.locator('main > :last-child')).toHaveClass(/lock-legend/);
  await expect(page.locator('.lock-legend')).toContainText('Đã khóa: không sửa được vì một trận ở vòng sau đã có kết quả.');
  await expect(page.locator('[data-match="SF1"] .lock-dot')).toHaveCount(0);
  // On the match's own page: the full sentence, and no form.
  await page.goto('/#edit/G1');
  await expect(page.locator('.locked')).toHaveText('Đã khóa vì Bán kết 1 đã có kết quả.');
  await expect(page.locator('form[data-form="sets"]')).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.goto('/#edit/SF1');
  await page.getByRole('button', { name: 'Xóa kết quả' }).click();
  await expect(page.locator('.notice')).toHaveText('Đã lưu.');
  await page.goto('/#edit/G1');
  await expect(page.locator('form[data-form="sets"]')).toBeVisible();
});

test("a correction that would change a live semifinal's teams is refused", async ({ page, request }) => {
  await clearAll(request);
  await enter(request, GROUPS_DONE);
  await request.put('/api/matches/SF2/serve', { headers: HEADERS, data: { side: 1 } });
  await request.post('/api/matches/SF2/point', { headers: HEADERS, data: { side: 1, count: 0 } });
  await logIn(page);
  await page.goto('/#edit/G7');
  await page.locator('input[name="s0-1"]').fill('21');
  await page.locator('input[name="s0-2"]').fill('19');
  await page.getByRole('button', { name: 'Lưu kết quả' }).click();
  await expect(page.locator('.preview')).toHaveText(
    'Không sửa được vì sẽ làm đổi đội của Bán kết 2 đang thi đấu. Hãy xóa tỷ số trực tiếp của Bán kết 2 trước.',
  );
  await expect(page).toHaveURL(/#edit\/G7$/);
  // A correction that keeps the same teams is fine (SPEC §6.5).
  await page.locator('input[name="s0-1"]').fill('18');
  await page.locator('input[name="s0-2"]').fill('21');
  await page.getByRole('button', { name: 'Lưu kết quả' }).click();
  await expect(page).toHaveURL(/#admin$/);
});

test('a best-of-3 final scored live: ends change between sets and at 8 in the decider', async ({ page, request }) => {
  await enter(request, { SF1: [21, 15], SF2: [19, 21] }); // the final is Duyên – Khải v Nguyên – Quỳnh
  await logIn(page);
  await page.goto('/#live/FINAL');
  await page.getByRole('button', { name: 'Nguyên – Quỳnh giao trước' }).click();
  await page.getByRole('button', { name: 'Đổi đội giao trước' }).click(); // the toss went the other way
  const side = (s) => page.locator(`.court[data-side="${s}"]`);
  const names = page.locator('.court .name');
  const overlay = page.locator('.overlay');
  const point = async (s, expected) => {
    await side(s).click();
    await expect(side(s).locator('.big')).toHaveText(String(expected));
  };
  await expect(side(1)).toContainText('Giao cầu · ô phải');

  // Set 1 to Duyên – Khải: ends change, the panels swap, and the set winner serves first.
  for (let n = 1; n <= 14; n++) await point(1, n);
  await side(1).click();
  await expect(overlay).toContainText('Đổi sân!');
  await overlay.click();
  await expect(names).toHaveText(['Nguyên – Quỳnh', 'Duyên – Khải']);
  await expect(side(1)).toContainText('Thắng 1 séc');
  await expect(side(1)).toContainText('Giao cầu · ô phải');
  await expect(page.locator('.history')).toHaveText('15–0');

  // Set 2 to Nguyên – Quỳnh: ends change again.
  for (let n = 1; n <= 14; n++) await point(2, n);
  await side(2).click();
  await overlay.click();
  await expect(names).toHaveText(['Duyên – Khải', 'Nguyên – Quỳnh']);

  // Deciding set: at 7-7 the first side to reach 8 changes ends; then Duyên – Khải wins it.
  for (let n = 1; n <= 7; n++) {
    await point(1, n);
    await point(2, n);
  }
  await side(1).click();
  await expect(overlay).toBeVisible();
  await overlay.click();
  for (let n = 9; n <= 15; n++) await point(1, n);
  await expect(page.locator('.result')).toHaveText('Duyên – Khải thắng');
  await expect(page.locator('.history')).toHaveText('15–0 · 0–15 · 15–7');
  await expect(side(1)).toBeDisabled();

  // Undo reopens the match at 14-7.
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(side(1).locator('.big')).toHaveText('14');
  await expect(side(1)).toBeEnabled();
});
