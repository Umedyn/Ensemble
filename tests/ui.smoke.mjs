// Browser smoke test against fake model servers.
//   npm run test:ui
// Needs Playwright's Chromium once: `npx playwright install chromium`
// (or set CHROMIUM_PATH to an existing Chrome/Chromium binary).
// Screenshots land in tests/screenshots/ for a quick visual check.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from '../tools/serve.mjs';
import { startMocks } from './mock-servers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const PORT = 8123;
const BASE = `http://localhost:${PORT}/`;

const server = await startServer(PORT, true);
const mocks = await startMocks();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failures = 0;

async function check(name, fn) {
  const ctx = await browser.newContext(name.startsWith('phone') ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(BASE);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
    await fn(page);
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✕ ${name}\n  ${e.message.split('\n').join('\n  ')}`);
  } finally {
    await page.screenshot({ path: path.join(shots, name.replace(/\W+/g, '-') + '.png') });
    await ctx.close();
  }
}

const act = async (page, text, step) => {
  if (step) await page.selectOption('#timeStep', step);
  await page.fill('#actionInput', text);
  await page.click('#btnAct');
  await page.waitForFunction(() => !document.getElementById('btnAct').disabled, null, { timeout: 15000 });
};

await check('desktop turn with beats and stepping in', async (page) => {
  await page.click('#btnNew');
  await act(page, 'I open up the recycler.');
  assert.equal(await page.locator('button[data-cut]').count(), 2, 'two step-in points between three beats');
  await page.click('button[data-cut="1"]');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /What do you do at 07:00–07:30/);
  await act(page, 'Hold on, Teo. Show me the log.', 'moment');
  assert.equal(await page.locator('.beat.skipped').count(), 2, 'later beats marked as not happening');
  assert.match(await page.locator('.entry.action .when').first().textContent(), /07:00 → Sol 214, 07:15/);
});

await check('settings: API key errors and hybrid routing', async (page) => {
  mocks.log.length = 0;
  await page.click('#btnSettings');
  const ext = 'fieldset[data-backend="external"]';
  await page.selectOption(`${ext} .bPreset`, 'custom');
  await page.fill(`${ext} .bUrl`, 'http://localhost:5002/v1');
  await page.fill(`${ext} .bModel`, 'test/story-70b');
  await page.fill(`${ext} .bKey`, 'wrong');
  await page.click(`${ext} .bTest`);
  await page.waitForFunction((s) => /✕|✓/.test(document.querySelector(s).textContent), `${ext} .bStatus`);
  assert.match(await page.textContent(`${ext} .bStatus`), /rejected the API key/);
  await page.fill(`${ext} .bKey`, 'sk-test');
  await page.click(`${ext} .bTest`);
  await page.waitForFunction((s) => /✓/.test(document.querySelector(s).textContent), `${ext} .bStatus`);
  await page.click('button[data-route="hybrid"]');
  await page.click('button[value="save"]');
  await page.click('#btnNew');
  await act(page, 'Ask Teo about the rattle.');
  await act(page, 'Nod.', 'moment');
  const where = (kind) => mocks.log.filter((c) => kind.test(c.user)).map((c) => c.port);
  assert.ok(where(/Judge the player/).every((p) => p === 5002), 'characters & events go to the API');
  assert.ok(where(/Write the next scene/).every((p) => p === 5002), 'narration goes to the API');
  assert.deepEqual(where(/Record what changed/), [5001], 'memory updates stay local');
  const save = await page.evaluate(() => localStorage.getItem('ensemble.autosave'));
  assert.ok(!save.includes('sk-test'), 'API key never lands in the save');
});

await check('major-event skip with an empty plan', async (page) => {
  await page.evaluate(() => { window.Ensemble.rng = () => 0.995; });
  await page.click('#btnNew');
  await page.selectOption('#timeStep', 'major');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /downtime/);
  await page.click('#btnAct');
  await page.waitForFunction(() => !document.getElementById('btnAct').disabled, null, { timeout: 15000 });
  assert.match(await page.textContent('#sceneBar'), /Sol 215/, 'time jumped to the storm');
  assert.equal(await page.inputValue('#timeStep'), 'hour', 'step resets after a skip');
});

await check('phone layout', async (page) => {
  const box = await page.locator('#btnSettings').boundingBox();
  assert.ok(box && box.x + box.width <= 390, 'Settings button is on screen');
  await page.click('#btnNew');
  await act(page, 'Look around.');
  await page.click('#btnSide');
  await page.waitForTimeout(350);
  const side = await page.locator('#side').boundingBox();
  assert.ok(side.y < 844 * 0.5, 'situation sheet slides up');
});

await browser.close();
mocks.close();
server.close();
if (failures) { console.error(`${failures} UI check(s) failed`); process.exit(1); }
console.log(`All UI checks passed. Screenshots: ${path.relative(process.cwd(), shots)}`);
