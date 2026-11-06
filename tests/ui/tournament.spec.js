// Plays a whole tournament on a phone-sized screen in both languages, with one match scored live
// (docs/ARCHITECTURE.md §9, step 4). Runs against tests/ui/server.js, which starts empty.
import { test, expect, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Team names come from seed.json, so renaming a team (e.g. a substitution) never breaks a test.
const NAME = Object.fromEntries(JSON.parse(readFileSync(new URL('../../server/seed.json', import.meta.url), 'utf8')).teams.map((t) => [t.code, t.name]));

const PIN = 'court-21';
// The browser type is fixed in playwright.config.js, so only the screen settings are taken here.
const { defaultBrowserType, ...LANDSCAPE } = devices['Pixel 7 landscape'];
// SPEC §6.4 Examples 1 and 3: group A ends A1, A3, A2 and group B ends B1, B2, B4, B3.
const GROUP_SCORES = { G1: [21, 15], G2: [21, 19], G3: [15, 21], G4: [21, 18], G5: [10, 21], G6: [21, 5], G7: [19, 21], G8: [21, 19], G9: [21, 8] };

async function typeScore(page, id, sets, saveLabel) {
  await page.goto(`/#edit/${id}`);
  for (const [i, [a, b]] of sets.entries()) {
    await page.locator(`input[name="s${i}-1"]`).fill(String(a));
    await page.locator(`input[name="s${i}-2"]`).fill(String(b));
  }
  await expect(page.locator('.preview.ok')).toBeVisible();
  await page.getByRole('button', { name: saveLabel }).click();
  await expect(page).toHaveURL(/#admin$/);
}

const standings = (page, g) => page.locator(`[data-group="${g}"] tbody .team .name`);
const tabsFit = (page) => page.locator('nav.tabs').evaluate((nav) => nav.scrollWidth <= nav.clientWidth);

test.describe('a phone turned sideways', () => {
  test.use(LANDSCAPE);

  test('the live screen fits without scrolling, and Swap sides swaps the panels', async ({ page, request }) => {
    await page.goto('/');
    await page.evaluate((pin) => localStorage.setItem('pin', pin), PIN);
    await page.goto('/#live/G1');
    await page.reload();
    await page.getByRole('button', { name: `${NAME.A1} giao trước` }).click();
    await page.locator('.court[data-side="1"]').click();
    await expect(page.locator('.court[data-side="1"] .big')).toHaveText('1');
    const swap = page.getByRole('button', { name: 'Đổi sân', exact: true });
    for (const el of [page.locator('.court[data-side="1"]'), page.locator('.court[data-side="2"]'), page.getByRole('button', { name: 'Hoàn tác' }), swap]) {
      await expect(el).toBeInViewport({ ratio: 1 });
    }
    await expect(page.locator('.court .name')).toHaveText([`${NAME.A1}`, `${NAME.A2}`]);
    await swap.click();
    await expect(page.locator('.court .name')).toHaveText([`${NAME.A2}`, `${NAME.A1}`]);
    // Leave the tournament empty for the next test.
    expect((await request.delete('/api/matches/G1', { headers: { 'X-Admin-Pin': PIN } })).ok()).toBe(true);
  });
});

test('a whole tournament on a phone, in both languages', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());

  await test.step('spectators get Vietnamese by default and no admin tab', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Trueson 1st Badminton Championship' })).toBeVisible();
    await expect(page.getByText('Đã đấu 0/13 trận')).toBeVisible();
    // Before the final results: the matches, then the prizes at the bottom; no final results yet.
    await expect(page.locator('main h2')).toHaveText(['Đang thi đấu', 'Trận sắp tới', /^Giải thưởng/]);
    // Up next is folded until tapped.
    const upNext = page.locator('details.up-next');
    await expect(upNext.locator('.cards')).toBeHidden();
    await upNext.getByText('Trận sắp tới').click();
    await expect(upNext.locator('.cards')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quản lý' })).toBeHidden();
  });

  await test.step('the language switch is remembered', async () => {
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByText('0 of 13 matches played')).toBeVisible();
    // The page re-rendered in English; the opened Up next stays open.
    await expect(page.locator('details.up-next .cards')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
  });

  await test.step('the hidden admin link asks for the PIN', async () => {
    await page.goto('/#admin');
    await page.getByLabel('PIN').fill('not-the-pin');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong PIN.');
    await page.getByLabel('PIN').fill(PIN);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Enter results' })).toBeVisible();
    await expect(page.locator('nav.tabs > a')).toHaveText(['Overview', 'Admin', 'Groups', 'Knockout', 'Sponsors']);
    expect(await tabsFit(page)).toBe(true);
  });

  await test.step('an invalid score is explained before saving', async () => {
    await page.goto('/#edit/G1');
    await page.locator('input[name="s0-1"]').fill('21');
    await page.locator('input[name="s0-2"]').fill('20');
    await expect(page.locator('.preview')).toHaveText('Set 1: must be won by 2 points. From 20–20, play goes on until one side leads by 2.');
    await expect(page.getByRole('button', { name: 'Save result' })).toBeDisabled();
  });

  await test.step('typing all nine group scores', async () => {
    for (const [id, set] of Object.entries(GROUP_SCORES)) await typeScore(page, id, [set], 'Save result');
  });

  await test.step('standings, qualifiers and semifinal pairings', async () => {
    await page.getByRole('link', { name: 'Groups' }).click();
    await expect(standings(page, 'A')).toHaveText([`${NAME.A1}`, `${NAME.A3}`, `${NAME.A2}`]);
    await expect(standings(page, 'B')).toHaveText([`${NAME.B1}`, `${NAME.B2}`, `${NAME.B4}`, `${NAME.B3}`]);
    await expect(page.locator('[data-group="A"] tr.qualified')).toHaveCount(2);
    await page.getByRole('link', { name: 'Knockout' }).click();
    await expect(page.locator('[data-match="SF1"]')).toContainText(`${NAME.A1}`);
    await expect(page.locator('[data-match="SF1"]')).toContainText(`${NAME.B2}`);
  });

  await test.step('scoring SF1 live, with undo, the change-ends reminder and a spectator watching', async () => {
    await page.goto('/#live/SF1');
    await page.getByRole('button', { name: `${NAME.A1} serves first` }).click();
    const [side1, side2] = [1, 2].map((s) => page.locator(`.court[data-side="${s}"]`));
    await expect(side1).toContainText('Serving · right court');
    await side2.click();
    await expect(side2.locator('.big')).toHaveText('1');
    await expect(side2).toContainText('Serving · left court');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(side2.locator('.big')).toHaveText('0');

    let spectator;
    const spectatorScore = () => spectator.locator('[data-match="SF1"] .side').first().locator('.set.now');
    for (let n = 1; n <= 21; n++) {
      await side1.click();
      if (n === 11) {
        await expect(page.locator('.overlay')).toContainText('Change ends!');
        await page.locator('.overlay').click();
        // The teams changed ends on court, so the screen swaps its panels.
        await expect(page.locator('.court .name')).toHaveText([`${NAME.B2}`, `${NAME.A1}`]);
      }
      await expect(side1.locator('.big')).toHaveText(String(n));
      if (n === 3) {
        spectator = await page.context().newPage();
        await spectator.goto('/');
        await expect(spectatorScore()).toHaveText('3');
      }
      if (n === 6) await expect(spectatorScore()).toHaveText('6', { timeout: 10_000 }); // picked up by polling
    }
    await expect(page.locator('.result')).toHaveText(`${NAME.A1} wins`);
    await spectator.close();
  });

  await test.step('the rest of the knockout, in Vietnamese', async () => {
    await page.getByRole('button', { name: 'Tiếng Việt' }).click();
    expect(await tabsFit(page)).toBe(true);
    await typeScore(page, 'SF2', [[19, 21]], 'Lưu kết quả');
    await expect(page.locator('[data-match="G1"] .lock-dot')).toHaveAttribute('title', 'Đã khóa vì Bán kết 1, Bán kết 2 đã có kết quả.');
    await typeScore(page, 'FINAL', [[15, 12], [13, 15], [16, 14]], 'Lưu kết quả');
    await page.goto('/');
    await expect(page.locator('.podium')).toHaveCount(0); // the 3rd-place match isn't decided yet
    await page.goto('/#edit/THIRD');
    await page.getByRole('button', { name: `${NAME.B1} thắng W/O` }).click();
    await expect(page.locator('.confirm')).toContainText(`Ghi nhận ${NAME.B1} thắng W/O?`);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(/#admin$/);
    await expect(page.locator('[data-match="THIRD"] .badge')).toHaveText('W/O');
  });

  await test.step('spectators see the podium', async () => {
    await page.getByRole('button', { name: 'Đăng xuất' }).click();
    await expect(page.getByRole('link', { name: 'Quản lý' })).toBeHidden();
    await expect(page.getByText('Đã đấu 13/13 trận')).toBeVisible();
    // After the final results: they come first, under the progress, then the matches, then the prizes.
    await expect(page.locator('main h2')).toHaveText(['Kết quả chung cuộc', 'Đang thi đấu', 'Kết quả mới nhất', /^Giải thưởng/]);
    await expect(page.locator('.podium li')).toHaveText([new RegExp(`Vô địch\\s*${NAME.A1}`), new RegExp(`Giải Nhì\\s*${NAME.A3}`), new RegExp(`Giải Ba\\s*${NAME.B1}`)]);
    // Gold, silver and bronze.
    const colours = await page.locator('.podium li').evaluateAll((items) => items.map((li) => getComputedStyle(li).backgroundColor));
    expect(colours).toEqual(['rgb(226, 196, 106)', 'rgb(212, 216, 221)', 'rgb(217, 166, 121)']);
  });
});

test('sponsors: logos next to the Trueson logo, and the last tab of the menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sponsor-logos img')).toHaveCount(2);
  for (const name of ['Anh Sơn Movement', 'Kenichi Miyoshi']) await expect(page.getByRole('img', { name })).toBeVisible();
  expect(await tabsFit(page)).toBe(true);
  await expect(page.locator('nav.tabs > a:visible')).toHaveText(['Tổng quan', 'Vòng bảng', 'Loại trực tiếp', 'Tài trợ']);

  await page.locator('nav').getByRole('link', { name: 'Tài trợ' }).click();
  await expect(page.getByRole('heading', { name: 'Nhà tài trợ' })).toBeVisible();
  await expect(page.locator('.sponsor strong')).toHaveText(['Anh Sơn Movement', 'Kenichi Miyoshi']);
  await expect(page.locator('nav [data-view="sponsors"]')).toHaveClass(/active/);

  await page.goto('/');
  await page.locator('header .sponsor-logos').click(); // the sponsors' logos lead there too
  await expect(page).toHaveURL(/#sponsors$/);

  // Typing History's address without the PIN only shows the login form.
  await page.goto('/#history');
  await expect(page.getByRole('heading', { name: 'Đăng nhập quản lý' })).toBeVisible();
});

// Runs after the whole tournament above, so there is everything to clear.
test('clearing every result needs the PIN typed again', async ({ page }) => {
  await page.goto('/#admin');
  await page.getByLabel('Mã PIN').fill(PIN);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  // "Lịch sử" and "Xóa tất cả" sit at the top of the admin page, next to "Đăng xuất".
  await expect(page.locator('.admin-head .actions > *')).toHaveText(['Lịch sử', 'Xóa tất cả', 'Đăng xuất']);
  await page.getByRole('link', { name: 'Xóa tất cả' }).click();
  await expect(page.getByRole('heading', { name: 'Xóa toàn bộ kết quả' })).toBeVisible();

  await page.getByLabel('Nhập lại mã PIN để xác nhận').fill('not-the-pin');
  await page.getByRole('button', { name: 'Xóa toàn bộ', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Sai mã PIN.');
  await expect(page.getByRole('link', { name: 'Quản lý' })).toBeVisible(); // still logged in

  // A refresh that fetched the old results just before the clear, but only arrives after it, must not bring
  // them back (a slow phone connection while the page refreshes).
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/state', async (route) => {
    const old = await route.fetch();
    await held;
    await route.fulfill({ response: old });
  }, { times: 1 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // starts a refresh
  await page.getByLabel('Nhập lại mã PIN để xác nhận').fill(PIN);
  await page.getByRole('button', { name: 'Xóa toàn bộ', exact: true }).click();
  await expect(page).toHaveURL(/#admin$/);
  await expect(page.getByText('Đã xóa toàn bộ kết quả.')).toBeVisible();
  const late = page.waitForResponse('**/api/state');
  release();
  await late;
  await expect(page.locator('[data-match="FINAL"] .badge')).toHaveText('Chờ xác định đội');
  await expect(page.getByText('Kết quả cũ đã được lưu vào Lịch sử.')).toBeVisible();
  await page.getByRole('link', { name: 'Tổng quan' }).click();
  await expect(page.getByText('Đã đấu 0/13 trận')).toBeVisible();

  // The cleared tournament is the newest entry in History (on the admin page), as a read-only copy.
  await page.getByRole('link', { name: 'Quản lý' }).click();
  await page.locator('.admin-head').getByRole('link', { name: 'Lịch sử' }).click();
  await expect(page.locator('nav [data-view="admin"]')).toHaveClass(/active/);
  const newest = page.locator('.history-item').first();
  await expect(newest).toContainText(`Vô địch: ${NAME.A1}`);
  await expect(newest).toContainText('Đã đấu 13/13 trận');
  const entries = await page.locator('.history-item').count();
  await newest.getByRole('link', { name: 'Xem' }).click();
  await expect(page.locator('.podium li')).toHaveText([new RegExp(`Vô địch\\s*${NAME.A1}`), new RegExp(`Giải Nhì\\s*${NAME.A3}`), new RegExp(`Giải Ba\\s*${NAME.B1}`)]);
  await expect(page.locator('[data-match="FINAL"] .side').first()).toContainText('151316');
  await expect(page.locator('[data-group="B"] tbody .team .name')).toHaveText([`${NAME.B1}`, `${NAME.B2}`, `${NAME.B4}`, `${NAME.B3}`]);
  await expect(page.locator('main a[href^="#edit"], main a[href^="#live"], main form')).toHaveCount(0); // nothing editable

  // Deleting it, after confirming.
  await page.getByRole('button', { name: 'Xóa bản lưu' }).click();
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page).toHaveURL(/#history$/);
  await expect(page.getByText('Đã xóa bản lưu.')).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(entries - 1);
});
