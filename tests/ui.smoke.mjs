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
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ensemble.setupDone', '1'); });
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
  assert.equal(await page.locator('.beat').count(), 1, 'scene opens on its first beat only');
  assert.equal(await page.locator('button[data-cut]').count(), 1, 'one step-in point, under the newest beat');
  assert.equal(await page.locator('button[data-next]').count(), 1);
  await page.click('button[data-cut="1"]');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /What do you do at 07:00–07:30/);
  await act(page, 'Hold on, Teo. Show me the log.', 'moment');
  assert.equal(await page.locator('.beat-note').count(), 1, 'beats after the step-in are not shown');
  assert.match(await page.locator('.entry.action .when').first().textContent(), /07:00 → Sol 214, 07:15/);
});

await check('next settles a beat; acting early steps in', async (page) => {
  await page.click('#btnNew');
  await act(page, 'I open up the recycler.');
  await page.click('button[data-cut="1"]');
  await page.click('button[data-next]');
  assert.equal(await page.locator('.beat').count(), 2, 'next reveals the second beat');
  assert.equal(await page.locator('button[data-cut="1"]').count(), 0, 'passed step-in point is gone');
  assert.equal(await page.locator('button[data-cut="2"].active').count(), 0, 'next cancels a pending step-in');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /^What do you do\?/);
  await act(page, 'Wait, what was that?', 'moment');
  assert.equal(await page.locator('.beat-note').count(), 1, 'unread third beat never happened');
});

await check('undo and reroll', async (page) => {
  await page.click('#btnNew');
  assert.ok(await page.locator('#btnUndo').isDisabled(), 'nothing to undo yet');
  assert.ok(await page.locator('#btnReroll').isDisabled(), 'nothing to reroll yet');
  await act(page, 'I open up the recycler.');
  mocks.log.length = 0;
  await page.click('button[data-next]');
  await page.click('#btnReroll');
  await page.waitForFunction(() => !document.getElementById('btnReroll').disabled, null, { timeout: 15000 });
  assert.equal(mocks.log.filter((c) => /Write the next scene/.test(c.user)).length, 1, 'one new narration call');
  assert.equal(mocks.log.filter((c) => /Judge the player/.test(c.user)).length, 0, 'no new intent call');
  assert.equal(await page.locator('.beat').count(), 1, 'the new scene starts again at its first beat');
  await act(page, 'Hold on, Teo.', 'moment');
  assert.match(await page.textContent('#sceneBar'), /turn 2/);
  await page.click('#btnUndo');
  assert.equal(await page.inputValue('#actionInput'), 'Hold on, Teo.', 'action back in the box');
  assert.equal(await page.inputValue('#timeStep'), 'moment');
  assert.match(await page.textContent('#sceneBar'), /turn 1/);
  assert.equal(await page.locator('button[data-cut="1"].active').count(), 1, 'the step-in point is selected again');
  assert.match(await page.textContent('#log'), /Only one turn can be undone/);
  assert.ok(await page.locator('#btnUndo').isDisabled(), 'one level only');
  assert.ok(!(await page.locator('#btnReroll').isDisabled()), 'turn 1 is pending again, so it can be rerolled');
  await page.click('#btnDebug');
  assert.equal(await page.locator('#debugBody details.note').count(), 2, 'Debug lists the undo and the reroll');
});

await check('debug shows a turn report with tokens, prompt time and guards', async (page) => {
  await page.click('#btnNew');
  await act(page, 'I open up the recycler.');
  await act(page, 'Hold on, Teo.', 'moment');
  await page.click('#btnDebug');
  const report = page.locator('#debugBody details.telemetry[open]');
  assert.equal(await report.count(), 1, 'the newest turn is open');
  assert.match(await report.locator('summary').textContent(), /^Turn 2 · [\d.]+ s · 3 calls · \d[\d,]* in/, 'mocks report usage, so no estimates');
  assert.deepEqual(await report.locator('tbody td:first-child').allTextContents(), ['update', 'intent', 'narrate']);
  assert.equal(await report.locator('th', { hasText: 'prompt' }).count(), 1, 'KoboldCpp perf column shown');
  assert.equal(await report.locator('th', { hasText: 'cached' }).count(), 0, 'no cache column when nobody reports it');
  assert.match(await report.textContent(), /update rejected|No guards fired/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await report.locator('button[data-copy-report]').click();
  await page.waitForFunction(() => /Copied|failed/.test(document.querySelector('#debugBody details.telemetry[open] button[data-copy-report]').textContent));
  assert.equal(await report.locator('button[data-copy-report]').textContent(), 'Copied');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Turn 2 · "Hold on, Teo\." · moment[\s\S]*Guards fired/);
});

// Also writes the sample fixture when run as `npm run fixture:mock`.
await check('record a session and export it as a fixture', async (page) => {
  // A key and a private URL that must never reach the recording.
  await page.evaluate(() => Object.assign(window.Ensemble.settings.backends.external, { key: 'sk-secret-test', url: 'https://private-tunnel.example/v1' }));
  await page.click('#btnNew');
  await page.click('#btnDebug');
  assert.ok(await page.locator('#btnExportRec').isDisabled(), 'nothing to export yet');
  await page.click('#btnRecord');
  await page.click('#btnDebugClose');
  await act(page, 'I open up the recycler.');
  await page.click('button[data-next]');
  await act(page, 'Hold on, Teo.', 'moment');
  await page.click('#btnReroll');
  await page.waitForFunction(() => !document.getElementById('btnReroll').disabled, null, { timeout: 15000 });
  await act(page, 'Show me the log.', 'moment');
  await page.click('#btnUndo');
  await act(page, 'Ask Teo what he wiped from the log.', 'moment');
  await page.click('#btnDebug');
  assert.match(await page.textContent('#btnRecord'), /Stop recording \(6\)/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportRec')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.ok(!text.includes('sk-secret-test') && !text.includes('private-tunnel'), 'no keys or URLs in the recording');
  const f = JSON.parse(text);
  assert.equal(f.format, 'ensemble-recording');
  assert.deepEqual(f.actions.map((a) => a.type), ['turn', 'turn', 'reroll', 'turn', 'undo', 'turn']);
  assert.equal(f.actions[1].cutAt, 2, 'acting after reading two beats steps in after beat 2');
  assert.ok(f.actions[0].calls.every((c) => c.response && c.request.user));
  if (process.argv.includes('--save-fixture')) {
    f.note = 'Recorded from the mock servers by `npm run fixture:mock`: two turns, a step-in, a reroll, an undo and a redo.';
    fs.writeFileSync(path.join(here, 'fixtures', 'mock-session.json'), JSON.stringify(f, null, 1) + '\n');
    console.log('  wrote tests/fixtures/mock-session.json');
  }
});

await check('first run: setup picks a hosted model and opens its settings', async (page) => {
  await page.evaluate(() => localStorage.removeItem('ensemble.setupDone'));
  await page.reload();
  await page.waitForSelector('#setup[open]');
  await page.waitForFunction(() => /KoboldCpp is running here/.test(document.getElementById('setupLocal').textContent));
  await page.click('#setup button[value="external"]');
  await page.waitForSelector('#settings[open]');
  assert.ok(await page.locator('details[data-section="external"]').evaluate((d) => d.open), 'external section open');
  assert.equal(await page.inputValue('#routing [data-step="narrate"]'), 'external');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'bKey', 'cursor in the API key field');
  await page.click('#settings button[value="cancel"]');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  assert.equal(await page.locator('#setup[open]').count(), 0, 'asked only once');
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
  for (const id of ['#btnUndo', '#btnReroll', '#btnAct']) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 390, `${id} is on screen`);
  }
  await page.click('#btnReroll');
  await page.waitForFunction(() => !document.getElementById('btnReroll').disabled, null, { timeout: 15000 });
  await page.click('#btnUndo');
  assert.equal(await page.inputValue('#actionInput'), 'Look around.');
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
