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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('./helpers.js');

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

const sceneReady = (page) => page.waitForFunction(() => document.getElementById('sceneBar').textContent.trim() !== '');

// Act is only enabled at the end of a scene or after choosing "Step in here",
// so unless a test picked a step-in point, read the scene to the end first.
// New game loads the world before it starts, so wait for turn 0 on the scene
// bar before acting (acting too early was silently ignored: the flaky
// portraits check, 2026-10-20).
const newGame = async (page) => {
  await page.click('#btnNew');
  await page.waitForFunction(() => /turn 0$/.test(document.getElementById('sceneBar').textContent.trim()));
};
const turnDone = (page) => page.waitForFunction(() => !document.getElementById('btnNew').disabled, null, { timeout: 15000 });
const act = async (page, text, step) => {
  if (!(await page.locator('button[data-cut].active').count())) {
    while (await page.locator('button[data-next]').count()) await page.click('button[data-next]');
  }
  if (step) await page.selectOption('#timeStep', step);
  await page.fill('#actionInput', text);
  await page.click('#btnAct');
  await turnDone(page);
};

await check('desktop turn with beats and stepping in', async (page) => {
  await newGame(page);
  await act(page, 'I open up the recycler.');
  assert.equal(await page.locator('.beat').count(), 1, 'scene opens on its first beat only');
  assert.equal(await page.locator('button[data-cut]').count(), 1, 'one step-in point, under the newest beat');
  assert.equal(await page.locator('button[data-next]').count(), 1);
  await page.click('button[data-cut="1"]');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /What do you do at Sol 214, 07:00–07:30\?/);
  assert.equal(await page.locator('.turn-current .beat-time').first().textContent(), 'Sol 214, 07:00', 'beat headings carry the game date, like a log');
  await act(page, 'Hold on, Teo. Show me the log.', 'moment');
  assert.equal(await page.locator('.beat-note').count(), 1, 'beats after the step-in are not shown');
  assert.match(await page.locator('.entry.action .when').first().textContent(), /07:00 → Sol 214, 07:15/);
});

await check('act is greyed out until the scene is read or the player steps in', async (page) => {
  await newGame(page);
  await act(page, 'I open up the recycler.');
  assert.ok(await page.locator('#btnAct').isDisabled(), 'unread beats: no acting yet');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /Step in here/);
  assert.ok(!(await page.locator('#actionInput').isDisabled()), 'typing ahead is fine');
  await page.click('button[data-cut="1"]');
  assert.ok(!(await page.locator('#btnAct').isDisabled()), 'choosing a step-in point enables Act');
  await page.click('button[data-next]');
  assert.equal(await page.locator('.beat').count(), 2, 'next reveals the second beat');
  assert.equal(await page.locator('button[data-cut="1"]').count(), 0, 'passed step-in point is gone');
  assert.equal(await page.locator('button[data-cut="2"].active').count(), 0, 'next cancels a pending step-in');
  assert.ok(await page.locator('#btnAct').isDisabled(), 'and Act is greyed out again');
  await page.fill('#actionInput', 'Wait, what was that?');
  await page.press('#actionInput', 'Control+Enter');
  assert.equal(await page.locator('.entry.action').count(), 1, 'Ctrl+Enter does not get around it (only turn 1 so far)');
  await page.click('button[data-next]');
  assert.ok(!(await page.locator('#btnAct').isDisabled()), 'end of the scene: Act is back');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /^What do you do\?/);
  await act(page, 'Wait, what was that?', 'moment');
  assert.equal(await page.locator('.beat-note').count(), 0, 'read to the end, so nothing was cut');
});

await check('earlier turns fold away; Next never scrolls up to an old turn', async (page) => {
  await newGame(page);
  await act(page, 'I open up the recycler.');
  await act(page, 'Ask Teo about the log.');
  assert.deepEqual(await page.locator('#log details.turn-group').evaluateAll((ds) => ds.map((d) => [d.dataset.turn, d.open])), [['0', false], ['1', false]], 'opening and turn 1 are folded');
  assert.match(await page.locator('details.turn-group[data-turn="1"] > summary').textContent(), /Turn 1\s*I open up the recycler\./);
  assert.equal(await page.locator('.turn-current[data-turn="2"]').count(), 1, 'the latest turn is shown in full');
  await page.click('details.turn-group[data-turn="1"] > summary');
  const log = page.locator('#log');
  const before = await log.evaluate((el) => el.scrollTop);
  await page.click('button[data-next]');
  const after = await log.evaluate((el) => el.scrollTop);
  assert.ok(after >= before, `Next scrolled up (${before} → ${after})`);
  const inView = await page.evaluate(() => {
    const log = document.getElementById('log'), b = document.querySelector('.turn-current .beat[data-beat="1"]');
    const l = log.getBoundingClientRect(), r = b.getBoundingClientRect();
    return r.top >= l.top - 1 && r.top < l.bottom;
  });
  assert.ok(inView, 'the new beat of the current turn is in view');
  assert.ok(await page.locator('details.turn-group[data-turn="1"]').evaluate((d) => d.open), 'an opened turn stays open while reading');
  await act(page, 'Nod.', 'moment');
  assert.ok(!(await page.locator('details.turn-group[data-turn="1"]').evaluate((d) => d.open)), 'and closes when a new turn starts');
});

await check('undo and reroll', async (page) => {
  await newGame(page);
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
  await page.click('button[data-cut="1"]');
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
  await newGame(page);
  await act(page, 'I open up the recycler.');
  await act(page, 'Hold on, Teo.', 'moment');
  await page.click('#btnDebug');
  const report = page.locator('#debugBody details.telemetry[open]');
  assert.equal(await report.count(), 1, 'the newest turn is open');
  assert.match(await report.locator('summary').textContent(), /^Turn 2 · [\d.]+ s · 3 calls · \d[\d,]* in/, 'mocks report usage, so no estimates');
  assert.deepEqual(await report.locator('tbody td:first-child').allTextContents(), ['update', 'intent', 'narrate']);
  assert.equal(await report.locator('th', { hasText: 'prompt' }).count(), 1, 'KoboldCpp perf column shown');
  assert.equal(await report.locator('th', { hasText: 'cached' }).count(), 0, 'no cache column when nobody reports it');
  assert.match(await report.textContent(), /update rejected|tags & mood|No guards fired/);
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
  await newGame(page);
  await page.click('#btnDebug');
  assert.ok(await page.locator('#btnExportRec').isDisabled(), 'nothing to export yet');
  await page.click('#btnRecord');
  await page.click('#btnDebugClose');
  await act(page, 'I open up the recycler.');
  await page.click('button[data-next]');
  await page.click('button[data-cut="2"]');
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
  assert.equal(f.actions[1].cutAt, 2, 'stepped in after beat 2');
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
  await newGame(page);
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
  await newGame(page);
  await page.selectOption('#timeStep', 'major');
  assert.match(await page.getAttribute('#actionInput', 'placeholder'), /downtime/);
  await page.click('#btnAct');
  await turnDone(page);
  assert.match(await page.textContent('#sceneBar'), /Sol 215/, 'time jumped to the storm');
  assert.equal(await page.inputValue('#timeStep'), 'hour', 'step resets after a skip');
});

await check('phone layout', async (page) => {
  const box = await page.locator('#btnSettings').boundingBox();
  assert.ok(box && box.x + box.width <= 390, 'Settings button is on screen');
  await newGame(page);
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

await check('pick a world, then a start, and play a turn', async (page) => {
  assert.equal(await page.inputValue('#scenarioSelect'), 'server:mars-station');
  assert.ok(await page.isVisible('#startSelect'), 'Ares Deep has two starts');
  assert.equal(await page.inputValue('#startSelect'), 'recycler', 'the default start is selected');
  assert.match(await page.textContent('#pickInfo'), /Kit Navarro/);
  await page.selectOption('#startSelect', 'garage');
  assert.match(await page.textContent('#pickInfo'), /Priya Raman/);
  await newGame(page);
  await sceneReady(page);
  assert.match(await page.textContent('#sceneBar'), /Ares Deep \(Sol 214: the Mule\).*Rover Garage/);
  assert.match(await page.textContent('#log'), /battery pack/, "Priya's opening");
  await act(page, 'Look around.');
  assert.equal(await page.locator('.entry.action').count(), 1);
  // remembered after a reload
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  assert.equal(await page.inputValue('#startSelect'), 'garage');
  // a world with one start skips the start step
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  assert.ok(!(await page.isVisible('#startSelect')), 'one start: no start picker');
  assert.match(await page.textContent('#pickInfo'), /Jordan Pike/);
});

await check('a broken start shows its error in the picker instead of starting', async (page) => {
  await page.route('**/scenarios/mars-station/starts/garage.json', async (route) => {
    const res = await route.fetch();
    const st = await res.json();
    st.cast.find((c) => c.id === 'raman').status.location = 'orbit';
    await route.fulfill({ response: res, json: st });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  await page.selectOption('#startSelect', 'garage');
  assert.match(await page.textContent('#startSelect option[value="garage"]'), /has errors/);
  assert.match(await page.textContent('#pickInfo'), /can't be played[\s\S]*unknown location "orbit"/);
  const dialog = page.waitForEvent('dialog');
  await page.click('#btnNew');
  const d = await dialog;
  assert.match(d.message(), /unknown location "orbit"/);
  await d.accept();
  assert.equal(await page.locator('.entry').count(), 0, 'no game started');
  await page.selectOption('#startSelect', 'recycler');
  await newGame(page);
  await sceneReady(page);
  assert.match(await page.textContent('#sceneBar'), /Commons/, 'the other start still plays');
});

await check('phone: pick a world and a start, and play a turn', async (page) => {
  const world = await page.locator('#scenarioSelect').boundingBox();
  const start = await page.locator('#startSelect').boundingBox();
  assert.ok(start && start.y > world.y && start.x + start.width <= 390, 'two stacked selects, on screen');
  assert.ok(!(await page.isVisible('#pickInfo')), 'no summaries on a phone');
  await page.selectOption('#startSelect', 'garage');
  await newGame(page);
  await sceneReady(page);
  assert.match(await page.textContent('#sceneBar'), /Rover Garage/);
  await act(page, 'Look around.');
  assert.equal(await page.locator('.entry.action').count(), 1);
});

// Task 1-6: the card leads with mood and tags; needs sit in a collapsed Details.
await check('cards show mood and tags, with needs tucked into Details that stay open', async (page) => {
  await newGame(page);
  await act(page, 'Look around.');
  await act(page, 'Ask Teo about the rattle.'); // the first turn's memory (mood, tag) is recorded now
  const teo = page.locator('#cast .card', { hasText: 'Teo Bauer' });
  assert.equal(await teo.locator('.mood').textContent(), 'jumpy, talking too fast');
  assert.ok(await teo.locator('.tag', { hasText: 'grease on his sleeves' }).count());
  assert.ok(!(await page.locator('#cast .card .tag', { hasText: 'unhurt' }).count()), 'no "unhurt" chip');
  const details = teo.locator('details.card-details');
  assert.ok(!(await teo.locator('.needs').isVisible()), 'needs start collapsed');
  await details.locator('summary').click();
  assert.ok(await teo.locator('.needs').isVisible());
  await act(page, 'Wait.');
  assert.ok(await page.locator('#cast .card', { hasText: 'Teo Bauer' }).locator('.needs').isVisible(), 'still open after the cast re-renders');
  await page.screenshot({ path: path.join(shots, 'cards-mood-tags.png') });
});

// Task 1-7: portraits (with a monogram when an image is missing), minimized
// cards remembered per world, and the details view.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function withPortraits(page) {
  // Okafor gets a portrait that exists, Teo one that doesn't, plus a description.
  for (const [id, extra] of [['okafor', { portrait: 'portraits/okafor.png', description: 'Runs the station like a lab: precise, proud, hard to read.' }], ['bauer', { portrait: 'portraits/missing.png' }]]) {
    await page.route(`**/scenarios/mars-station/characters/${id}.json`, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: Object.assign(await res.json(), extra) });
    });
  }
  await page.route('**/scenarios/mars-station/portraits/okafor.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
}
const card = (page, name) => page.locator('#cast .card', { hasText: name });

for (const phone of [false, true]) {
  await check(`${phone ? 'phone: ' : ''}portraits, minimized cards and the details view`, async (page) => {
    await withPortraits(page);
    await newGame(page);
    await act(page, 'Look around.');
    await act(page, 'Ask Teo about the rattle.');
    if (phone) { await page.click('#btnSide'); await page.waitForTimeout(350); }
    assert.ok(await card(page, 'Imani Okafor').locator('img.portrait').count(), 'Okafor has her portrait');
    await page.waitForFunction(() => [...document.querySelectorAll('#cast .card')].find((c) => c.textContent.includes('Teo Bauer')).querySelector('.monogram'));
    assert.equal(await card(page, 'Teo Bauer').locator('.monogram').textContent(), 'TB', 'a missing image falls back to the monogram');
    assert.equal(await card(page, 'Lev Sorensen').locator('.monogram').textContent(), 'LS', 'no portrait: monogram, "Dr." skipped');
    // details: who they are, description, and what you know
    const teo = card(page, 'Teo Bauer');
    await teo.locator('details.card-details summary').click();
    assert.match(await teo.locator('details.card-details').textContent(), /he\/him · hydroponics technician · 24/);
    assert.match(await teo.locator('.known').textContent(), /sensor issue/, 'the fact recorded about Teo');
    await card(page, 'Imani Okafor').locator('details.card-details summary').click();
    assert.match(await card(page, 'Imani Okafor').locator('.desc').first().textContent(), /Runs the station like a lab/);
    assert.match(await card(page, 'Imani Okafor').locator('.desc').nth(1).textContent(), /Looks: Tall and straight-backed/, 'the bundled appearance');
    // minimize one card: a single row with name and mood
    await card(page, 'Teo Bauer').locator('button.card-min').click();
    assert.ok(await card(page, 'Teo Bauer').evaluate((el) => el.classList.contains('min')));
    assert.equal(await card(page, 'Teo Bauer').locator('.mini-mood').textContent(), 'jumpy, talking too fast');
    assert.ok(!(await card(page, 'Teo Bauer').locator('details').count()), 'no details when minimized');
    // collapse all, then the choice survives a reload
    await page.click('#btnCollapseAll');
    assert.equal(await page.locator('#cast .card.min').count(), 5);
    assert.equal(await page.textContent('#btnCollapseAll'), 'Expand all');
    await page.screenshot({ path: path.join(shots, `${phone ? 'phone-' : ''}cards-minimized.png`) });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#cast .card').length > 0);
    assert.equal(await page.locator('#cast .card.min').count(), 5, 'remembered');
    await page.click(phone ? '#btnSide' : '#btnCollapseAll');
    if (phone) { await page.waitForTimeout(350); await page.click('#btnCollapseAll'); }
    assert.equal(await page.locator('#cast .card.min').count(), 0);
    const box = await card(page, 'Imani Okafor').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= (phone ? 390 : 1360), 'card fits the screen');
    await page.screenshot({ path: path.join(shots, `${phone ? 'phone-' : ''}cards-expanded.png`) });
  });
}

// Task 2-1: background (secondary) people sit in a collapsed Elsewhere list.
await check('background people are under a collapsed Elsewhere list that remembers being opened', async (page) => {
  await newGame(page);
  await page.waitForFunction(() => document.querySelectorAll('#cast .card').length > 0);
  const front = await page.locator('#cast > .card .nm').allTextContents();
  assert.match(front[0], /Kit Navarro/, 'you first');
  assert.ok(front.some((n) => /Teo Bauer/.test(n)) && !front.some((n) => /Sorensen|Raman/.test(n)), 'the people with you, not the background');
  const away = page.locator('#cast details.elsewhere');
  assert.match(await away.locator(':scope > summary').textContent(), /Elsewhere \(2\)/);
  assert.ok(!(await card(page, 'Lev Sorensen').isVisible()), 'collapsed at first');
  await away.locator(':scope > summary').click();
  assert.ok(await card(page, 'Lev Sorensen').isVisible());
  // toggle fires after the click returns; wait until it is saved.
  await page.waitForFunction(() => /true/.test(localStorage.getItem('ensemble.cards.elsewhere') || ''));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#cast .card').length > 0);
  assert.ok(await card(page, 'Lev Sorensen').isVisible(), 'still open after a reload');
});

// Task 2-4: the relationship web, desktop and phone.
for (const phone of [false, true]) {
  await check(`${phone ? 'phone: ' : ''}the relationship web shows what you could know, as words`, async (page) => {
    await newGame(page);
    await act(page, 'Ask Teo about the rattle.');
    if (phone) { await page.click('#btnSide'); await page.waitForTimeout(350); }
    await page.click('#btnWeb');
    await page.waitForSelector('#webDialog[open] svg');
    const nodes = await page.locator('#webGraph .web-node').evaluateAll((els) => els.map((e) => e.dataset.id));
    assert.deepEqual(nodes, ['navarro', 'okafor', 'bauer'], 'you and the local people (Okafor walked to Ops but is still local)');
    const list = await page.textContent('#webList');
    assert.match(list, /You feel friendly toward Teo Bauer/);
    assert.match(list, /Teo Bauer feels \w+ toward you/);
    assert.doesNotMatch(list, /[+-]\d/, 'no numbers');
    assert.equal(await page.locator('#webGraph .web-edge.seen').count(), 0, 'nothing seen between others yet');
    await page.check('#webSecondary');
    assert.equal(await page.locator('#webGraph .web-node').count(), 5, 'everyone, with the background');
    const box = await page.locator('#webDialog').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= (phone ? 390 : 1360), 'the dialog fits the screen');
    await page.screenshot({ path: path.join(shots, `${phone ? 'phone-' : ''}relationship-web.png`) });
    await page.click('#webDialog button[value="close"]');
    assert.ok(!(await page.isVisible('#webDialog')));
  });
}

// Suggested actions fill the box; the player still presses Act.
await check('suggestions fill the action box without acting', async (page) => {
  await newGame(page);
  await act(page, 'Look around.');
  assert.ok(await page.locator('#btnSuggest').isDisabled(), 'greyed out until the scene is read, like Act');
  while (await page.locator('button[data-next]').count()) await page.click('button[data-next]');
  await page.click('#btnSuggest');
  await page.waitForSelector('#suggestions .suggestion');
  assert.deepEqual(await page.locator('#suggestions .suggestion').allTextContents(),
    ['Ask Teo when the rattle started.', 'Check the recycler logs myself.', 'Tell Okafor about the storm plan.'], 'cleaned: no list marks or repeats');
  await page.locator('#suggestions .suggestion').nth(1).click();
  assert.equal(await page.inputValue('#actionInput'), 'Check the recycler logs myself.');
  assert.equal(await page.locator('#log .entry.action').count(), 1, 'nothing was played');
  await page.click('#btnAct');
  await turnDone(page);
  assert.ok(await page.locator('#suggestions').isHidden(), 'gone after the turn');
});

// Task 3-3: the local map next to the story; clicking fills in the box, never acts.
await check('the map sits beside the story, switches views, and clicking fills in the action box', async (page) => {
  await newGame(page);
  await sceneReady(page);
  assert.ok(await page.isVisible('#mapPane svg'), 'split view by default on desktop');
  assert.ok(await page.isVisible('#log'));
  assert.equal(await page.locator('#mapPane .map-room').count(), 9, "Ares Deep's nine rooms");
  assert.ok(await page.locator('#mapPane .map-room.here[data-room="commons"]').count(), 'you are in the Commons');
  assert.match(await page.textContent('#mapList'), /Commons \(you are here\): you, Dr\. Imani Okafor, Teo Bauer/);
  await page.locator('#mapPane .map-room[data-room="lab"] .floor').click();
  assert.equal(await page.inputValue('#actionInput'), 'Go to the Lab.');
  await page.fill('#actionInput', '');
  await page.locator('#mapPane .map-token[data-id="bauer"]').click();
  assert.equal(await page.inputValue('#actionInput'), 'Talk to Teo.');
  assert.equal(await page.locator('#log .entry.action').count(), 0, 'nothing was played');
  await page.click('.view-switch button[data-view="map"]');
  assert.ok(!(await page.isVisible('#log')) && (await page.isVisible('#mapPane svg')), 'map only');
  await page.click('.view-switch button[data-view="text"]');
  assert.ok((await page.isVisible('#log')) && !(await page.isVisible('#mapPane')), 'text only');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  await sceneReady(page);
  assert.ok(!(await page.isVisible('#mapPane')), 'the view is remembered for this world');
  await page.click('.view-switch button[data-view="split"]');
  await page.screenshot({ path: path.join(shots, 'map-split.png') });
});

await check('phone: the map button swaps the story for the map', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  await sceneReady(page);
  assert.ok(!(await page.isVisible('#mapPane')), 'story first on a phone');
  await page.click('#btnMapPhone');
  assert.ok((await page.isVisible('#mapPane svg')) && !(await page.isVisible('#log')));
  const svg = await page.locator('#mapPane svg').boundingBox();
  assert.ok(svg.x >= 0 && svg.x + svg.width <= 390, 'the map fits the screen');
  await page.locator('#mapPane .map-room[data-room="dock"] .floor').click();
  assert.equal(await page.inputValue('#actionInput'), 'Go to the Loading Dock.');
  await page.screenshot({ path: path.join(shots, 'phone-map.png') });
  await page.click('#btnMapPhone');
  assert.ok(await page.isVisible('#log'));
});

// Task 3-4: world and regional views, with a map image (the holdout's town) and without (Ares Deep).
await check('world and regional views: regions by who holds them, the info strip, zoom', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-mapview="world"]');
  assert.equal(await page.locator('#worldSvg image').count(), 1, 'the town map image');
  assert.equal(await page.locator('#worldSvg .region-g').count(), 5);
  assert.ok(await page.locator('.region-g[data-region="ridge-town"] .region-shape.fc-1').count(), 'Ridge in The Ridge\'s colour');
  assert.ok(await page.locator('.region-g[data-region="highway-strip"] .region-shape.here').count(), 'your region is marked');
  assert.match(await page.textContent('#regionInfo'), /The highway strip \(you are here\).*held by no one.*quiet except for stragglers.*dead nearby/);
  await page.locator('.region-g[data-region="ridge-town"] .region-shape').click({ position: { x: 40, y: 40 } });
  const info = await page.textContent('#regionInfo');
  assert.match(info, /Ridge.*held by The Ridge.*trucks seen coming and going.*fortified/);
  assert.match(info, /walled off the school/, 'the lore summary');
  const full = (await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number);
  await page.click('[data-zoom="in"]');
  const zoomed = (await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number);
  assert.ok(zoomed[2] < full[2], 'zoomed in');
  await page.click('[data-zoom="reset"]');
  assert.deepEqual((await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number), full);
  await page.screenshot({ path: path.join(shots, 'map-world.png') });
  await page.click('[data-mapview="region"]');
  const region = (await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number);
  assert.ok(region[2] < full[2], 'zoomed to your region and its neighbours');
  assert.match(await page.textContent('#worldSvg'), /Sales Floor/, 'rooms placed on the map');
  await page.screenshot({ path: path.join(shots, 'map-region.png') });
  await page.click('[data-mapview="local"]');
  assert.ok(await page.locator('#mapPane .map-room').count(), 'back to the rooms');
  assert.equal(await page.locator('#mapPane .map-lock').count(), 1, "the office door is locked (task 3-6)");
  assert.match(await page.textContent('#mapPane'), /forklift/);
  // Ares Deep has no map image: a node map from the neighbours.
  await page.selectOption('#scenarioSelect', 'server:mars-station');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-mapview="world"]');
  assert.equal(await page.locator('#worldSvg image').count(), 0);
  assert.equal(await page.locator('#worldSvg .region-g').count(), 4);
  assert.equal(await page.locator('#worldSvg .region-edge').count(), 3);
  await page.screenshot({ path: path.join(shots, 'map-world-nodes.png') });
});

await check('phone: the world view fits and the level switch works', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  await sceneReady(page);
  await page.click('#btnMapPhone');
  await page.click('[data-mapview="world"]');
  const box = await page.locator('#worldSvg').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'fits the screen');
  await page.screenshot({ path: path.join(shots, 'phone-map-world.png') });
});

// Task 3-5: the creator. Draw a region on a map image, export the world as
// a zip, check the zip loads, then play it in the game from disk.
await check('creator: draw a region on a map image, export, and play the export', async (page) => {
  await page.goto(BASE + 'creator.html');
  await page.waitForFunction(() => document.querySelectorAll('#cWorld option').length > 1);
  assert.ok(await page.locator('#cTabs [data-tab="world"]').isDisabled(), 'later tabs are shown, not ready');
  await page.selectOption('#cWorld', 'server:mars-station');
  await page.waitForSelector('#cSvg');
  assert.match(await page.textContent('#cValidation'), /No problems/);
  await page.setInputFiles('#cImage', path.join(here, '..', 'scenarios', 'zombie-holdout', 'maps', 'town.svg'));
  await page.waitForSelector('#cSvg image');
  await page.click('#cRegionList [data-sel="station"]');
  await page.click('[data-mode="draw"]');
  const box = await page.locator('#cSvg').boundingBox();
  for (const [fx, fy] of [[0.2, 0.2], [0.45, 0.2], [0.45, 0.5], [0.2, 0.5]]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.keyboard.press('Enter');
  assert.match(await page.textContent('#cRegionForm'), /Outlined with 4 corners/);
  await page.selectOption('[data-field="controller"]', 'sponsor');
  await page.selectOption('[data-startregion="garage"]', 'crater-rim');
  // Problems show inline, next to the region, as you type.
  await page.fill('[data-field="tags"]', 'a, b, c, d, e, f, g');
  await page.waitForFunction(() => /"tags" must be a list of at most 6/.test(document.getElementById('cRegionProblems').textContent));
  assert.match(await page.textContent('#cValidation'), /1 problem/);
  await page.fill('[data-field="tags"]', 'cramped');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  await page.screenshot({ path: path.join(shots, 'creator-map.png') });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#cExport')]);
  const bytes = new Uint8Array(fs.readFileSync(await download.path()));
  const E = helpers.loadEngine();
  const out = path.join(shots, 'creator-export');
  fs.rmSync(out, { recursive: true, force: true });
  const names = [];
  for (const e of E.Zip.read(bytes)) {
    names.push(e.name);
    fs.mkdirSync(path.dirname(path.join(out, e.name)), { recursive: true });
    fs.writeFileSync(path.join(out, e.name), e.data);
  }
  assert.ok(names.includes('mars-station/maps/town.svg') && names.includes('mars-station/world.json') && names.includes('mars-station/starts/garage.json'));
  const w = helpers.readWorld(path.join(out, 'mars-station'), E);
  assert.ok(w.starts.every((s) => s.scenario), 'the export loads');
  const sc = w.starts.find((s) => s.id === 'garage').scenario;
  assert.equal(sc.map.image, 'maps/town.svg');
  assert.equal(sc.map.regions.station.polygon.length, 4);
  assert.equal(sc.regions.find((r) => r.id === 'station').controller, 'sponsor');
  assert.equal(sc.region, 'crater-rim');
  // Play it: open the exported folder in the game and look at the world map.
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  await page.setInputFiles('#folderInput', path.join(out, 'mars-station'));
  await page.waitForFunction(() => [...document.querySelectorAll('#scenarioSelect option')].some((o) => o.value === 'disk:mars-station'));
  await page.selectOption('#scenarioSelect', 'disk:mars-station');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-mapview="world"]');
  assert.equal(await page.locator('#worldSvg image').count(), 1, 'the map image came from the export');
  assert.ok(await page.locator('.region-g[data-region="station"] polygon.fc-4').count(), 'drawn, in the sponsor\'s colour');
});

// Task 1-8: fix your own feelings toward someone from their details.
await check('correct your feelings from a card', async (page) => {
  await newGame(page);
  await act(page, 'Look around.');
  const teo = card(page, 'Teo Bauer');
  await teo.locator('details.card-details summary').click();
  await teo.locator('.feel-why').fill('he was joking, I overreacted');
  await teo.locator('button[data-feel-step="5"]').click();
  const now = card(page, 'Teo Bauer');
  assert.match(await now.locator('.rels').textContent(), /you: friendly \+25/);
  assert.match(await now.locator('.feel').textContent(), /friendly \+25[\s\S]*he was joking, I overreacted/);
  assert.ok(await now.locator('details.card-details').evaluate((d) => d.open), 'details stay open');
  await page.click('#btnDebug');
  assert.match(await page.textContent('#debugBody'), /you corrected your feelings toward Teo Bauer: now 25/);
});

// Screen readers hear each new beat from a polite live region.
await check('screen readers hear each new beat', async (page) => {
  assert.equal(await page.getAttribute('#srAnnounce', 'aria-live'), 'polite');
  await newGame(page);
  await page.fill('#actionInput', 'Look around.');
  await page.click('#btnAct');
  await turnDone(page);
  const said = () => page.waitForFunction(() => document.getElementById('srAnnounce').textContent.trim() !== '').then(() => page.textContent('#srAnnounce'));
  assert.match(await said(), /^You pry the access panel off the recycler\.[\s\S]*Next for more/);
  await page.click('button[data-next]');
  await page.waitForFunction(() => /Okafor gathers her tablet/.test(document.getElementById('srAnnounce').textContent));
  while (await page.locator('button[data-next]').count()) await page.click('button[data-next]');
  await page.waitForFunction(() => /Your turn\.\)$/.test(document.getElementById('srAnnounce').textContent));
});

// Settings › Appearance (task 1-9). Sets the controls, then Save or cancel.
async function setAppearance(page, { theme, textSize, font, spacing, motion }, save = true) {
  await page.click('#btnSettings');
  const section = page.locator('#settings details[data-section="appearance"]');
  if (!(await section.evaluate((d) => d.open))) await section.locator('summary').click();
  if (theme) await page.selectOption('#aTheme', theme);
  if (font) await page.selectOption('#aFont', font);
  if (spacing) await page.selectOption('#aSpacing', spacing);
  if (motion) await page.selectOption('#aMotion', motion);
  if (textSize) await page.locator('#aTextSize').evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, textSize);
  await page.click(save ? '#settings button[value="save"]' : '#settings button[value="cancel"]');
}
const rootAttr = (page, name) => page.evaluate((n) => document.documentElement.getAttribute(n), name);
const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

await check('appearance: themes, text size and story font apply, survive a reload, and cancel restores', async (page) => {
  await newGame(page);
  await act(page, 'Look around.');
  assert.equal(await rootAttr(page, 'data-theme'), 'dark', 'dark by default');
  const darkBg = await bodyBg(page);
  for (const theme of ['light', 'hv', 'dark']) {
    await setAppearance(page, { theme });
    assert.equal(await rootAttr(page, 'data-theme'), theme);
    await page.screenshot({ path: path.join(shots, `appearance-${theme}.png`) });
  }
  await setAppearance(page, { theme: 'light', textSize: 150, font: 'sans', spacing: 'relaxed', motion: 'on' });
  assert.notEqual(await bodyBg(page), darkBg);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '24px', '150% of 16px');
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.entry.scene')).fontFamily), /system-ui|sans/);
  assert.equal(await rootAttr(page, 'data-motion'), 'reduce');
  await page.screenshot({ path: path.join(shots, 'appearance-light-150.png') });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  assert.equal(await rootAttr(page, 'data-theme'), 'light', 'saved and applied on load');
  assert.equal(await rootAttr(page, 'data-spacing'), 'relaxed');
  // previewing then closing without Save puts the saved look back
  await setAppearance(page, { theme: 'hv' }, false);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 2000 });
});

await check('phone: high visibility at 150% fits the screen', async (page) => {
  await setAppearance(page, { theme: 'hv', textSize: 150 });
  await newGame(page);
  await act(page, 'Look around.');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no sideways scrolling (${overflow}px too wide)`);
  for (const id of ['#btnSettings', '#btnNew', '#btnAct', '#btnUndo', '#btnSide']) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 390, `${id} is on screen`);
  }
  await page.screenshot({ path: path.join(shots, 'phone-hv-150-story.png') });
  await page.click('#btnSide');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, 'phone-hv-150-side.png') });
});

await browser.close();
mocks.close();
server.close();
if (failures) { console.error(`${failures} UI check(s) failed`); process.exit(1); }
console.log(`All UI checks passed. Screenshots: ${path.relative(process.cwd(), shots)}`);
