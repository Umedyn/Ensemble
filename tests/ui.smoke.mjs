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

// Clicks a room's floor on the detailed map, near its bottom-left corner
// (clear of furniture, under the label strip).
const clickFloor = async (page, id) => {
  const box = await page.locator(`#mapPane .map-room[data-room="${id}"] .sd-floor, #mapPane .map-room[data-room="${id}"] .sd-ground`).first().boundingBox();
  await page.mouse.click(box.x + 6, box.y + box.height - 6);
};
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

// Task 5-7: lore packs from packs/, turned on per world in the picker.
await check('lore packs: only for their world, ticked in the picker, in the game and its Debug notes', async (page) => {
  assert.equal(await page.isVisible('#btnPacks'), false, 'Ares Deep has no packs');
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await page.waitForSelector('#btnPacks:not(.hidden)');
  assert.equal(await page.textContent('#btnPacks'), 'Lore packs');
  await page.click('#btnPacks');
  assert.match(await page.textContent('#packList'), /Harmon County life[\s\S]*4 entries, 1 event/);
  await page.check('[data-pack="harmon-county"]');
  await page.locator('#packDialog form').screenshot({ path: path.join(shots, 'lore-packs.png') });
  await page.click('#packDialog button[value="close"]');
  assert.equal(await page.textContent('#btnPacks'), 'Lore packs (1)');
  await newGame(page);
  await sceneReady(page);
  await page.click('#btnDebug');
  assert.match(await page.textContent('#debugBody'), /lore packs: Harmon County life/);
  // Remembered for the world after a reload.
  await page.reload();
  await page.waitForSelector('#btnPacks:not(.hidden)');
  assert.equal(await page.textContent('#btnPacks'), 'Lore packs (1)');
});

// Chapters: a closed one folds its turns under one row that opens to its summary.
await check('chapters fold their turns under one row, with the summary inside', async (page) => {
  const { state } = helpers.newGame('mars-station');
  for (let t = 1; t <= 3; t++) {
    state.log.push({ turn: t, type: 'action', text: `Action ${t}.`, time: `Sol 214, 0${t}:00` });
    state.log.push({ turn: t, type: 'scene', text: `Scene ${t}.`, beats: [{ at: 0, text: `Scene ${t}.` }] });
  }
  const chapter = { n: 1, title: 'The rattle in the recycler', summary: 'Kit and Teo traced the rattle to a failing pump.', fromTurn: 0, toTurn: 3, reason: 'size' };
  state.chapters.push(chapter);
  state.log.push({ turn: 3, type: 'chapter', chapter });
  state.log.push({ turn: 4, type: 'action', text: 'Action 4.', time: 'Sol 214, 04:00' });
  state.log.push({ turn: 4, type: 'scene', text: 'Scene 4.', beats: [{ at: 0, text: 'Scene 4.' }] });
  Object.assign(state, { turn: 4, chapter: 2, chapterStartTurn: 4 });
  await page.setInputFiles('#loadInput', { name: 'chapters.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(state)) });
  await page.waitForSelector('.chapter-group');
  assert.equal(await page.locator('.chapter-group[open]').count(), 0, 'folded');
  assert.match(await page.textContent('.chapter-group > summary'), /Chapter 1\s*The rattle in the recycler\s*turns 0–3/);
  assert.equal(await page.isVisible('.chapter-summary'), false);
  assert.equal(await page.locator('.chapter-group .turn-group').count(), 4, 'the opening and turns 1–3 inside');
  assert.match(await page.textContent('.turn-current'), /Scene 4/, 'the latest turn stays out');
  await page.click('.chapter-group > summary');
  assert.equal(await page.isVisible('.chapter-summary'), true);
  assert.match(await page.textContent('.chapter-summary'), /failing pump/);
  await page.locator('#log').screenshot({ path: path.join(shots, 'chapters.png') });
});

// Endings: a story that reached one shows it and an end card; Keep playing goes on.
await check('endings: the end card after a story reaches an ending, and Keep playing', async (page) => {
  const { E, state } = helpers.newGame('zombie-holdout');
  E.Engine.reachEnding(state, { id: 'got-out', title: 'Out of Harmon', kind: 'win', when: { judged: 'out' } }, 'the scene shows it', null, { closing: true, closed: true });
  state.log.push({ turn: 0, type: 'ending', id: 'got-out', title: 'Out of Harmon', kind: 'win', text: 'The road opens ahead of you.\n\nBehind you, Harmon shrinks to smoke.' });
  await page.setInputFiles('#loadInput', { name: 'ended.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(state)) });
  await page.waitForSelector('#btnKeepPlaying');
  assert.match(await page.textContent('#log'), /The road opens ahead of you\.[\s\S]*A win\s*The end: Out of Harmon[\s\S]*The story has reached an ending/);
  await page.locator('#log').screenshot({ path: path.join(shots, 'ending.png') });
  await page.click('#btnKeepPlaying');
  await page.waitForFunction(() => !document.getElementById('btnKeepPlaying'));
  assert.match(await page.textContent('#log'), /The story goes on after "Out of Harmon"\./);
  await act(page, 'Look back at the town.');
  assert.equal(await page.locator('.entry.action').count(), 1, 'and the story goes on');
});

await check('debug shows a turn report with tokens, prompt time and guards', async (page) => {
  await newGame(page);
  await act(page, 'I open up the recycler.');
  await act(page, 'Hold on, Teo.', 'moment');
  await page.click('#btnDebug');
  const report = page.locator('#debugBody details.telemetry[open]');
  assert.equal(await report.count(), 1, 'the newest turn is open');
  // The mock's three beats run past the one a moment asks for: that scene is
  // stopped at a paragraph (task L-2), and a stopped stream has no usage to report.
  assert.match(await report.locator('summary').textContent(), /^Turn 2 · [\d.]+ s · \d+ calls · ~\d[\d,]* in/, 'the stopped scene is estimated');
  assert.match(await report.textContent(), /stopped at a paragraph/);
  // Smaller calls (task L-3), on by default for KoboldCpp: each step's parts under one row.
  const steps = await report.locator('tbody td:first-child').allTextContents();
  assert.deepEqual(steps.slice(0, 4), ['update · 3 calls', 'update:facts', 'update:state', 'update:feelings']);
  assert.match(steps[4], /^intent · \d+ calls$/);
  assert.equal(steps[5], 'intent:player');
  assert.ok(steps.slice(6, -1).every((s) => s === 'intent:char'), 'one call per person; no events call on a quiet moment');
  assert.equal(steps[steps.length - 1], 'narrate stopped at a paragraph');
  assert.equal(await report.locator('th', { hasText: 'prompt' }).count(), 1, 'KoboldCpp perf column shown');
  assert.equal(await report.locator('th', { hasText: 'cached' }).count(), 0, 'no cache column when nobody reports it');
  assert.match(await report.textContent(), /update rejected|tags & mood|No guards fired/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await report.locator('button[data-copy-report]').click();
  await page.waitForFunction(() => /Copied|failed/.test(document.querySelector('#debugBody details.telemetry[open] button[data-copy-report]').textContent));
  assert.equal(await report.locator('button[data-copy-report]').textContent(), 'Copied');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Turn 2 · "Hold on, Teo\." · moment[\s\S]*Guards fired/);
});

// Task L-2: the narration streams, and a scene that runs on stops at a paragraph.
await check('a scene that runs long stops at a paragraph, and KoboldCpp is told to stop', async (page) => {
  mocks.log.length = 0;
  await newGame(page);
  await act(page, 'Tell me everything.', 'hour');
  while (await page.locator('button[data-next]').count()) await page.click('button[data-next]');
  const beats = await page.locator('.turn-current .beat').count();
  assert.ok(beats >= 2 && beats <= 3, `three beats at most (${beats})`);
  assert.ok(!(await page.locator('.turn-current').textContent()).includes('two entries are missing'), 'the fourth beat never arrives');
  assert.ok(mocks.log.some((l) => /Write the next scene/.test(l.user || '') && l.stream), 'narration streamed');
  assert.ok(mocks.log.some((l) => l.abort && l.running), 'the abort reached the server');
  await page.click('#btnDebug');
  assert.match(await page.locator('#debugBody details.telemetry[open]').textContent(), /stopped at a paragraph/);
});

// Task R-10: a trip longer than the step stops on the way, says what is left,
// and Travel there goes on with it.
await check('a trip longer than the step stops on the way, and Travel there goes on', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  assert.ok(await page.locator('#btnTravel').evaluate((b) => b.classList.contains('hidden')), 'no trip, no button');
  await act(page, 'I drive to Ridge.', 'moment');
  while (await page.locator('button[data-next]').count()) await page.click('button[data-next]');
  assert.match(await page.locator('.turn-current .travel-note').textContent(), /^.+ is still about \d+m away\.$/);
  assert.ok(!(await page.locator('#btnTravel').evaluate((b) => b.classList.contains('hidden'))), 'the button shows while the trip is unfinished');
  await page.click('#btnTravel');
  await turnDone(page);
  while (await page.locator('button[data-next]').count()) await page.click('button[data-next]');
  assert.ok(await page.locator('#btnTravel').evaluate((b) => b.classList.contains('hidden')), 'arrived: no more trip');
  assert.equal(await page.locator('.turn-current .travel-note').count(), 0);
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
  // Constrain JSON (task L-1): on for KoboldCpp; no JSON mode known for another API.
  assert.ok(await page.isChecked('fieldset[data-backend="local"] .bConstrain'), 'on for KoboldCpp');
  assert.ok(await page.locator(`${ext} .constrainRow`).evaluate((r) => r.classList.contains('hidden')), 'not offered for another API');
  await page.click('button[data-route="hybrid"]');
  await page.click('button[value="save"]');
  await newGame(page);
  await act(page, 'Ask Teo about the rattle.');
  await act(page, 'Nod.', 'moment');
  const where = (kind) => mocks.log.filter((c) => kind.test(c.user)).map((c) => c.port);
  assert.ok(where(/Judge the player/).every((p) => p === 5002), 'characters & events go to the API');
  assert.ok(where(/Write the next scene/).every((p) => p === 5002), 'narration goes to the API');
  assert.deepEqual(where(/\nRecord (the facts|what changed|how feelings)/), [5001, 5001, 5001], 'memory updates stay local, in three smaller calls (task L-3)');
  assert.ok(where(/Judge only/).length === 0, 'the 32K API keeps the single intent call');
  const json = mocks.log.filter((c) => /Judge the player|Record what changed/.test(c.user));
  assert.deepEqual(json.map((c) => [c.port, c.grammar, c.jsonMode]), json.map((c) => [c.port, c.port === 5001, false]), 'a grammar for KoboldCpp only');
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
  // a world with one start skips the start step, unless it can also generate one (task 4-2)
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  assert.deepEqual(await page.locator('#startSelect option').evaluateAll((els) => els.map((e) => e.value)), ['herd', '__generate'], 'its start, or make one');
  assert.equal(await page.inputValue('#startSelect'), 'herd');
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

// Task 4-1: the character creator.
const makerOpen = async (page) => {
  await page.click('#btnNew');
  await page.waitForSelector('#makerDialog[open]');
};
const gameStarted = (page) => page.waitForFunction(() => /turn 0$/.test(document.getElementById('sceneBar').textContent.trim()));

await check('make my own character and play a turn', async (page) => {
  assert.ok(await page.isVisible('#whoSelect'), 'the recycler start has a player slot');
  assert.equal(await page.inputValue('#whoSelect'), 'default');
  assert.match(await page.textContent('#whoSelect'), /Play as Kit Navarro/);
  await page.selectOption('#whoSelect', 'own');
  assert.match(await page.textContent('#pickInfo'), /your own crew member/);
  await makerOpen(page);
  await page.click('#mkStart');
  assert.match(await page.textContent('#makerErrors'), /Give your character a name/);
  assert.equal(await page.locator('.entry').count(), 0, 'no game yet');
  await page.fill('[data-f="name"]', 'Ada Brandt');
  // the draft survives closing the form
  await page.click('#mkClose');
  await makerOpen(page);
  assert.equal(await page.inputValue('[data-f="name"]'), 'Ada Brandt');
  await page.fill('[data-f="want"]', 'see the storm through');
  await page.check('input[name="mk-role"][value="logistics"]');
  assert.match(await page.textContent('.mk-skills legend'), /5 of 10 points left, up to 3 each/);
  await page.click('[data-skill="tech"][data-step="1"]');
  assert.ok(await page.locator('[data-skill="tech"][data-step="1"]').isDisabled(), 'tech is at the cap (3)');
  assert.match(await page.textContent('.mk-skills legend'), /4 of 10 points left/);
  await page.click('[data-trait-add="organized"]');
  assert.equal(await page.locator('.mk-chip').count(), 1);
  // Suggest offers; nothing changes until the player picks it
  await page.click('[data-suggest="voice"]');
  await page.waitForSelector('.mk-offer');
  assert.equal(await page.inputValue('[data-f="voice"]'), '');
  await page.click('[data-offer-use="voice"]');
  assert.match(await page.inputValue('[data-f="voice"]'), /Quick and wry/);
  await page.click('[data-suggest="traits"]');
  await page.waitForSelector('[data-trait-add="restless"]');
  assert.equal(await page.locator('.mk-chip').count(), 1, 'suggested traits are only ideas');
  assert.equal(await page.locator('.mk-feel').count(), 4, 'feelings toward the four crew members, Kit left out');
  await page.screenshot({ path: path.join(shots, 'character-creator.png') });
  await page.click('#mkStart');
  await gameStarted(page);
  assert.ok(!(await page.isVisible('#makerDialog')));
  assert.match(await page.textContent('#cast'), /Ada Brandt/);
  assert.doesNotMatch(await page.textContent('#cast'), /Kit Navarro/);
  await act(page, 'Ask Teo about the rattle.');
  assert.equal(await page.locator('.entry.action').count(), 1);
  const card = page.locator('#cast .card', { hasText: 'Ada Brandt' });
  await card.locator('details.card-details summary').click();
  const download = page.waitForEvent('download');
  await card.locator('[data-save-char]').click();
  assert.equal((await download).suggestedFilename(), 'ada-brandt.json');
});

await check('phone: make my own character and play a turn', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  const who = await page.locator('#whoSelect').boundingBox();
  assert.ok(who && who.x + who.width <= 390, 'who you play: a third stacked select, on screen');
  await page.selectOption('#whoSelect', 'own');
  await makerOpen(page);
  const box = await page.locator('#makerDialog').boundingBox();
  assert.ok(box.width >= 380 && box.width <= 390, 'the form fills the screen');
  assert.ok(await page.evaluate(() => { const d = document.getElementById('makerDialog'); return d.scrollWidth <= d.clientWidth; }), 'no sideways scrolling');
  await page.fill('[data-f="name"]', 'Sam Whitlock');
  await page.fill('[data-f="want"]', 'get to the coast');
  await page.fill('input[name="mk-role"][value=""] ~ span input', 'tow truck driver');
  await page.fill('#mkTrait', 'blunt');
  await page.press('#mkTrait', 'Enter');
  assert.equal(await page.locator('.mk-chip').count(), 1);
  assert.ok(await page.isVisible('#mkStart'), 'Start game stays in reach');
  await page.click('#mkStart');
  await gameStarted(page);
  await act(page, 'Look around.');
  assert.equal(await page.locator('.entry.action').count(), 1);
});

// R-7: start anywhere in a big world (tests/fixtures/open-galaxy: three
// levels of regions, the Throne Spire shut out, a hidden relay). Search,
// the zooming map and Surprise me; the plain list is for small worlds only.
await check('start anywhere in a big world: search, the map, Surprise me; a branch shut out can\'t be picked', async (page) => {
  await page.setInputFiles('#folderInput', path.join(here, 'fixtures', 'open-galaxy'));
  await page.waitForFunction(() => [...document.querySelectorAll('#scenarioSelect option')].some((o) => o.value === 'disk:open-galaxy'));
  await page.selectOption('#scenarioSelect', 'disk:open-galaxy');
  await page.click('#btnNew');
  await page.waitForSelector('#genDialog[open]');
  assert.equal(await page.locator('input[name="gen-region"]').count(), 0, 'not the plain list');
  // Search by name.
  await page.fill('#genSearch', 'tessk');
  assert.match(await page.textContent('#genResults'), /Tessk Crossing in Tessk › The Outer Rim/);
  await page.click('#genResults [data-genpick="tessk-crossing"]');
  assert.match(await page.textContent('#genChosen'), /Starting in Tessk Crossing in Tessk › The Outer Rim/);
  // The tree: the Spire shows as context, but can't be picked; the hidden relay doesn't show.
  assert.match(await page.textContent('#genTree'), /The Throne Spire/);
  assert.equal(await page.locator('#genTree [data-genpick="throne-spire"], #genTree [data-genpick="spire-vaults"]').count(), 0);
  assert.ok(!/Ghost Relay/.test(await page.textContent('#genBody')));
  // The map: zoom into the Rim, then Morrow, and pick Morrow Port.
  await page.click('[data-genview="map"]');
  await page.click('#genMap .region-g[data-region="rim"]');
  await page.click('#genMap .region-g[data-region="morrow"]');
  await page.click('#genMap .region-g[data-region="morrow-port"]');
  assert.match(await page.textContent('#genChosen'), /Starting in Morrow Port in Morrow › The Outer Rim/);
  await page.screenshot({ path: path.join(shots, 'gen-where-map.png') });
  // Inside the Spire nothing can be picked.
  await page.click('.map-crumbs [data-genlevel=""]');
  await page.click('#genMap .region-g[data-region="core"]');
  await page.click('#genMap .region-g[data-region="aurel"]');
  await page.click('#genMap .region-g[data-region="throne-spire"]');
  await page.click('#genMap .region-g[data-region="spire-vaults"]');
  assert.match(await page.textContent('#genChosen'), /Starting in Morrow Port/, 'still Morrow Port');
  // Surprise me: somewhere startable, never the Spire.
  for (let i = 0; i < 5; i++) {
    await page.click('#genSurprise');
    const t = await page.textContent('#genChosen');
    assert.match(t, /Starting in /);
    assert.ok(!/Spire|Ghost Relay/.test(t), t);
  }
  // Somewhere not on the map: the world makes regions, so the field is there.
  await page.fill('#genPlace', 'a moisture farm outside Tessk Crossing');
  await page.click('[data-genview="tree"]');
  assert.equal(await page.inputValue('#genPlace'), 'a moisture farm outside Tessk Crossing', 'kept across views');
  await page.screenshot({ path: path.join(shots, 'gen-where-tree.png') });
});

// Task 4-2: generated starts.
const genOpen = async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await page.selectOption('#startSelect', '__generate');
  await page.click('#btnNew');
  await page.waitForSelector('#genDialog[open]');
};
const genDone = (page) => page.waitForSelector('#genPlay', { timeout: 20000 });

// Task 7-4: a start in a region with one of the world's drawn places begins there.
// Task 7-6: a start's whole cast is playable.
await check('the frontier: play Salt Lick as anyone in its cast', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:frontier');
  await page.selectOption('#startSelect', 'salt-lick');
  const who = await page.locator('#whoSelect option').evaluateAll((els) => els.map((e) => e.textContent));
  assert.deepEqual(who, ['Play as Hollis Brandt', 'Play as Rosa Delgado, owner of the Drovers\' Rest', 'Play as Amos Tull, speculator who built the shipping pens',
    'Play as Josiah Reed, schoolteacher and preacher', 'Play as Wes Calhoun, Texas trail boss', 'Make my own']);
  await page.selectOption('#whoSelect', 'as:rosa-delgado');
  await page.click('#btnNew');
  await gameStarted(page);
  assert.match(await page.textContent('#sceneBar'), /The Drovers' Rest/);
  assert.match(await page.textContent('#cast'), /Hollis Brandt/);
});

await check('the frontier: make my own start in Salt Lick, and play on its drawn town plan', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:frontier');
  await page.selectOption('#startSelect', '__generate');
  await page.click('#btnNew');
  await page.waitForSelector('#genDialog[open]');
  await page.fill('#genSearch', 'salt lick');
  await page.click('#genResults [data-genpick="salt-lick"]');
  await page.fill('#genLine', 'a drover from Texas, owed three months of wages');
  await page.click('#genGo');
  await genDone(page);
  assert.match(await page.textContent('#genBody'), /You start in Front Street, in one of the world's own places/);
  await page.click('#genPlay');
  await gameStarted(page);
  assert.match(await page.textContent('#sceneBar'), /Front Street/);
  assert.match(await page.textContent('#mapPane'), /The Drovers' Rest/);
  await page.locator('#mapPane').screenshot({ path: path.join(shots, 'frontier-salt-lick.png') });
  await act(page, 'I walk over to the Drovers\' Rest.');
  assert.equal(await page.locator('.entry.action').count(), 1);
});

await check('make my own start: generate a place and people, retry a failed step, and play', async (page) => {
  // The first three replies for the rooms step are unusable: the step fails, then Retry works.
  let bad = 3;
  await page.route('http://localhost:5001/v1/chat/completions', async (route) => {
    const body = route.request().postData() || '';
    if (body.includes('TASK: THE PLACE') && bad-- > 0) {
      return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"rooms":[]}' }, finish_reason: 'stop' }] }) });
    }
    return route.continue();
  });
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  assert.ok(await page.isVisible('#startSelect'), 'the holdout now has a start to pick: its own, or make one');
  await page.selectOption('#startSelect', '__generate');
  assert.ok(!(await page.isVisible('#whoSelect')));
  assert.match(await page.textContent('#pickInfo'), /Make my own start/);
  await page.click('#btnNew');
  await page.waitForSelector('#genDialog[open]');
  assert.deepEqual(await page.locator('input[name="gen-region"]').evaluateAll((els) => els.map((e) => e.value)), ['main-street', 'residential', 'junction'], 'startable regions only');
  await page.check('input[name="gen-region"][value="residential"]');
  await page.fill('#genLine', 'a trucker who just wants to get to the coast');
  await page.fill('#genNote', 'quiet and tense');
  await page.click('#genGo');
  await page.waitForSelector('#genRetry', { timeout: 20000 });
  assert.match(await page.textContent('#genBody'), /rooms: make 3 to 6 rooms \(got 0\)/);
  assert.equal(await page.locator('.gen-step.done').count(), 1, 'your character is kept');
  await page.click('#genRetry');
  await genDone(page);
  assert.equal(await page.locator('.gen-step.done').count(), 8);
  assert.equal(await page.inputValue('[data-rv="opening||title"]'), 'Day 23: the diner', 'the review screen (task 4-3)');
  // Task 5-6: local lore in the review; one taken out.
  assert.equal(await page.inputValue('[data-rv="lore|local-blue-plate|title"]'), 'The Blue Plate');
  await page.click('[data-rv-lore-del="local-back-lot"]');
  assert.equal(await page.locator('[data-rv-lore-del]').count(), 2);
  await page.locator('.rv-section', { hasText: 'Local lore' }).screenshot({ path: path.join(shots, 'generated-start-lore.png') });
  await page.screenshot({ path: path.join(shots, 'generated-start.png') });
  await page.click('#genPlay');
  await gameStarted(page);
  assert.match(await page.textContent('#sceneBar'), /Diner Counter/);
  assert.match(await page.textContent('#cast'), /Lena Marsh/);
  assert.match(await page.textContent('#log'), /Rain drums on the diner roof/);
  await act(page, 'Look around.');
  assert.equal(await page.locator('.entry.action').count(), 1);
});

// A world the player describes (customSetting): the bundled blank world.
await check('your own story: describe a world, generate a start there, review its setting and play', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:your-story');
  await page.click('#btnNew');
  await page.waitForSelector('#genDialog[open]');
  await page.check('input[name="gen-mode"][value="line"]');
  await page.fill('#genLine', 'a fisherman with debts');
  await page.click('#genGo');
  assert.equal(await page.isVisible('#genWorld'), true, 'nothing starts without a world');
  await page.fill('#genWorld', 'a fishing village on a Scottish island in the 1950s, where everyone knows everyone');
  await page.click('#genGo');
  await genDone(page);
  assert.match(await page.textContent('.gen-steps'), /Your world/);
  assert.match(await page.inputValue('[data-rv="setting||setting"]'), /Scottish island in the 1950s/);
  await page.click('#genPlay');
  await gameStarted(page);
  assert.match(await page.textContent('#log'), /Rain drums on the diner roof/);
});

// Task 4-3: the review screen.
await check('review a generated start: spoilers, live checks, reroll one person, save as start, play', async (page) => {
  await page.route('http://localhost:5001/v1/chat/completions', async (route) => {
    const body = route.request().postData() || '';
    if (!body.includes('fresh take on the same name and role')) return route.continue();
    const sheet = { pronouns: 'he/him', age: 34, traits: ['rigid'], want: 'get his badge back', secret: 'He sold the station guns for a convoy seat.', guard: 'high', skills: {}, room: 'counter' };
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(sheet) }, finish_reason: 'stop' }] }) });
  });
  await genOpen(page);
  await page.fill('#genLine', 'a trucker who just wants to get to the coast');
  await page.click('#genGo');
  await genDone(page);
  assert.doesNotMatch(await page.textContent('#genBody'), /bitten on the hand/, 'secrets start hidden');
  await page.check('#rvSpoil');
  assert.match(await page.inputValue('[data-rv="person|kay-dunbar|secret"]'), /bitten on the hand/);
  // a room edit shows on the map once the field is left
  await page.fill('[data-rv="room|booths|name"]', 'Window Booths');
  await page.press('[data-rv="room|booths|name"]', 'Tab');
  assert.match(await page.textContent('#rvMap'), /Window Booths/);
  // a bad edit is refused on the spot
  await page.fill('[data-rv="room|kitchen|name"]', '');
  assert.match(await page.locator('[data-rv="room|kitchen|name"] ~ .rv-err').textContent(), /can't be empty/);
  // a secret in the opening stops Play and Save until it's gone
  const opening = await page.inputValue('[data-rv="opening||opening"]');
  await page.fill('[data-rv="opening||opening"]', opening + '\n\nKay was bitten on the hand two days ago and hides it in a glove.');
  assert.match(await page.textContent('#rvProblems'), /gives away Kay Dunbar's secret/);
  assert.ok(await page.locator('#genPlay').isDisabled() && await page.locator('#genSave').isDisabled());
  await page.fill('[data-rv="opening||opening"]', opening);
  assert.equal(await page.textContent('#rvProblems'), '');
  assert.ok(!(await page.locator('#genPlay').isDisabled()));
  // reroll one person: the others stay
  await page.click('[data-rv-person="owen-pruitt"]');
  await page.waitForSelector('.rv-note:has-text("written for the earlier Owen Pruitt")');
  assert.equal(await page.inputValue('[data-rv="person|owen-pruitt|want"]'), 'get his badge back');
  assert.equal(await page.inputValue('[data-rv="person|lena-marsh|want"]'), 'keep the diner open for whoever comes');
  await page.screenshot({ path: path.join(shots, 'review.png') });
  const download = page.waitForEvent('download');
  await page.click('#genSave');
  assert.match((await download).suggestedFilename(), /^zombie-holdout-gen-\w+\.zip$/);
  await page.click('#genPlay');
  await gameStarted(page);
  assert.match(await page.textContent('#mapPane'), /Window Booths/, 'the edits are in the game');
  await act(page, 'Look around.');
  assert.equal(await page.locator('.entry.action').count(), 1);
});

await check('phone: make my own start with the character form, and resume it after a reload', async (page) => {
  await genOpen(page);
  await page.click('#genMake');
  await page.waitForSelector('#makerDialog[open]');
  assert.equal(await page.textContent('#mkStart'), 'Use this character');
  assert.equal(await page.locator('.mk-feel').count(), 0, 'nobody to have feelings about yet');
  await page.fill('[data-f="name"]', 'Ana Reyes');
  await page.fill('[data-f="want"]', 'find my sister');
  await page.fill('#mkTrait', 'stubborn');
  await page.press('#mkTrait', 'Enter');
  await page.click('#mkStart');
  await page.waitForFunction(() => !document.getElementById('makerDialog').open);
  assert.match(await page.textContent('#genBody'), /Ana Reyes, Local from town/);
  const box = await page.locator('#genDialog').boundingBox();
  assert.ok(box.width >= 380 && box.width <= 390, 'the generator fills the screen');
  await page.click('#genGo');
  await genDone(page);
  assert.equal(await page.locator('.gen-step.done').count(), 8);
  assert.equal(await page.locator('.gen-step').first().locator('[data-gen-redo]').count(), 0, 'the character you made is yours: no Redo, and no model call for it');
  assert.ok(await page.evaluate(() => { const d = document.getElementById('genDialog'); return d.scrollWidth <= d.clientWidth; }), 'the review fits the screen: no sideways scrolling');
  assert.ok(await page.isVisible('#genPlay'), 'Play stays in reach');
  // closed without playing, and the page reloaded: the finished start waits
  await page.click('#genClose');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  await genOpen(page);
  assert.match(await page.textContent('.gen-resume'), /finished start you haven't played/);
  await page.click('#genResume');
  await page.click('#genPlay');
  await gameStarted(page);
  await act(page, 'Look around.');
  assert.equal(await page.locator('.entry.action').count(), 1);
});

// Task 4-4: generated sites.
await check('go somewhere new: the engine builds the place, the map shows it, Debug says why', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await page.selectOption('#startSelect', 'herd');
  await newGame(page);
  await act(page, 'I head to the pharmacy on Main Street for antibiotics.');
  assert.match(await page.textContent('#sceneBar'), /Pharmacy Storefront/, 'arrived at the entry');
  assert.match(await page.textContent('#mapList'), /Pharmacy Storefront \(you are here\)/);
  assert.doesNotMatch(await page.textContent('#mapList'), /Sales Floor/, 'the map shows the place you are in');
  assert.match(await page.textContent('.map-routes'), /↗ Parking Lot/);
  await page.click('.map-route');
  assert.equal(await page.inputValue('#actionInput'), 'Go to Parking Lot.');
  // Task 3-7: a new place starts in fog; a "?" marks where a known way leads.
  await page.fill('#actionInput', '');
  assert.ok(await page.locator('#mapPane .sd-stub').count(), 'unknown rooms show only as "?"');
  await page.locator('#mapPane .sd-stub').first().click();
  assert.equal(await page.inputValue('#actionInput'), 'Find out what is through there.');
  await page.screenshot({ path: path.join(shots, 'generated-site.png') });
  await page.click('#btnDebug');
  assert.match(await page.textContent('#debugBody'), /Places made during the story \(1\)/);
  assert.match(await page.textContent('#debugBody'), /site built/);
  await page.click('#btnDebugClose');
  await act(page, 'Look around the storefront.');
  assert.equal(await page.locator('.entry.action').count(), 2, 'play goes on in the new place (route moves are covered by tests/sites.test.js)');
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
  assert.equal(await page.locator('#mapPane svg.sd .sd-stub').count(), 0, 'the crew knows its own base');
  await clickFloor(page, 'lab');
  assert.equal(await page.inputValue('#actionInput'), 'Go to the Lab.');
  await page.fill('#actionInput', '');
  // Task 3-7: a gameplay piece fills in the box too; decoration doesn't.
  await page.locator('#mapPane .map-feature[data-feature="galley table"]').click();
  assert.equal(await page.inputValue('#actionInput'), 'Look at the galley table.');
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
  await clickFloor(page, 'dock');
  assert.equal(await page.inputValue('#actionInput'), 'Go to the Loading Dock.');
  await page.screenshot({ path: path.join(shots, 'phone-map.png') });
  await page.click('#btnMapPhone');
  assert.ok(await page.isVisible('#log'));
});

// Task 3-4: world and regional views, with a map image (the holdout's town)
// and without (Ares Deep). Since R-3 the levels are the zooming map's: the
// world (root) and the player's region (a leaf, zoomed as the Region view was).
await check('world and regional views: regions by who holds them, the info strip, zoom', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-maplevel="root"]');
  assert.equal(await page.locator('#worldSvg image').count(), 1, 'the town map image');
  assert.equal(await page.locator('#worldSvg .region-g').count(), 5);
  assert.ok(await page.locator('.region-g[data-region="ridge-town"] .region-shape.fc-1').count(), 'Ridge in The Ridge\'s colour');
  assert.ok(await page.locator('.region-g[data-region="highway-strip"] .region-shape.here').count(), 'your region is marked');
  assert.equal(await page.locator('#worldSvg .you-here').count(), 1, 'one "You are here" pin');
  assert.match(await page.textContent('#worldSvg .you-here'), /You are here/);
  assert.match(await page.textContent('#regionInfo'), /The highway strip, a part of town in Harmon \(you are here\).*held by no one.*quiet except for stragglers.*dead nearby/
);
  await page.locator('.region-g[data-region="ridge-town"] .region-shape').click({ position: { x: 40, y: 40 } });
  const info = await page.textContent('#regionInfo');
  assert.match(info, /Ridge.*held by The Ridge.*trucks seen coming and going.*fortified/);
  assert.match(info, /walled off the school/, 'the lore summary');
  const full = (await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number);
  await page.click('[data-zoom="in"]');
  const zoomed = (await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number);
  assert.ok(zoomed[2] < full[2], 'zoomed in');
  // Once the zoom settles the map is drawn again for the new view (the
  // detail that fits it), keeping the picture so it doesn't flicker.
  await page.evaluate(() => { document.querySelector('#worldSvg image').dataset.kept = '1'; document.querySelector('#worldSvg .region-g').dataset.old = '1'; });
  await page.waitForFunction(() => !document.querySelector('#worldSvg [data-old]'));
  assert.equal(await page.locator('#worldSvg image[data-kept]').count(), 1, 'the same picture');
  assert.equal(await page.locator('#worldSvg .region-g').count(), 5);
  assert.deepEqual((await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number), zoomed, 'the view stays');
  await page.click('[data-zoom="reset"]');
  assert.deepEqual((await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number), full);
  await page.screenshot({ path: path.join(shots, 'map-world.png') });
  await page.click('[data-maplevel="local"]');
  await page.click('.map-crumbs [data-maplevel="highway-strip"]');
  const region = (await page.getAttribute('#worldSvg', 'viewBox')).split(' ').map(Number);
  assert.ok(region[2] < full[2], 'zoomed to your region and its neighbours');
  assert.match(await page.textContent('#worldSvg'), /Sales Floor/, 'rooms placed on the map');
  await page.screenshot({ path: path.join(shots, 'map-region.png') });
  await page.click('[data-maplevel="local"]');
  assert.ok(await page.locator('#mapPane .map-room').count(), 'back to the rooms');
  assert.equal(await page.locator('#mapPane .sd-lock').count(), 1, "the office door is locked (task 3-6)");
  assert.match(await page.textContent('#mapPane'), /forklift/);
  // Ares Deep has its own map image (the Hellas rim) since the coffee-skips playtest;
  // the node map for worlds without one is covered in worldmap.test.js.
  await page.selectOption('#scenarioSelect', 'server:mars-station');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-maplevel="root"]');
  assert.equal(await page.locator('#worldSvg image').count(), 1, 'the Hellas rim');
  assert.equal(await page.locator('#worldSvg .region-g').count(), 4);
  assert.equal(await page.locator('#worldSvg .region-edge').count(), 0);
  await page.screenshot({ path: path.join(shots, 'map-world-mars.png') });
  await page.click('[data-maplevel="local"]');
  await page.click('.map-crumbs [data-maplevel="station"]');

  assert.match(await page.textContent('#worldSvg'), /Rover Garage/, 'rooms placed on the regional map');
  await page.screenshot({ path: path.join(shots, 'map-region-mars.png') });
});

await check('phone: the world view fits and the level switch works', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  await sceneReady(page);
  await page.click('#btnMapPhone');
  await page.click('[data-maplevel="root"]');
  const box = await page.locator('#worldSvg').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'fits the screen');
  await page.screenshot({ path: path.join(shots, 'phone-map-world.png') });
  // One level at a time; the breadcrumb is the way back (R-3).
  await page.click('[data-maplevel="local"]');
  await page.click('.map-crumbs [data-maplevel="town"]');
  assert.equal(await page.getAttribute('#worldSvg', 'data-view'), 'town');
  const bar = await page.locator('.map-bar').boundingBox();
  assert.ok(bar.x >= 0 && bar.x + bar.width <= 390, 'the breadcrumb fits the screen');
  await page.screenshot({ path: path.join(shots, 'phone-map-zoom.png') });
  await page.click('.map-crumbs [data-maplevel="root"]');
  assert.equal(await page.getAttribute('#worldSvg', 'data-view'), 'root');
});

// R-5: presence and unknown regions. The holdout's junction is contested
// (the convoy and the Ridge); Ares Deep's lava tube is hidden until the
// story reveals it, then it is on the map.
await check('presence and unknown regions: a contested junction, a hidden lava tube', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-maplevel="root"]');
  assert.ok(await page.locator('.region-g[data-region="junction"] .region-shape.contested').count(), 'drawn as contested');
  await page.locator('.region-g[data-region="junction"] .region-shape').click({ position: { x: 60, y: 40 } });
  assert.match(await page.textContent('#regionInfo'), /present: Coastal rescue convoy \(some\), The Ridge \(a little\); contested/);
  await page.selectOption('#scenarioSelect', 'server:mars-station');
  await newGame(page);
  // The holdout's scene also ended on turn 0: wait for the station's.
  await page.waitForFunction(() => /Ares Deep/.test(document.getElementById('sceneBar').textContent));
  await page.click('[data-maplevel="root"]');
  assert.equal(await page.locator('.region-g[data-region="lava-tube"]').count(), 0, 'hidden: not on the map');
  assert.ok(!/lava/i.test(await page.textContent('#mapPane')));
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ensemble.autosave'));
    s.regions['lava-tube'].known = true;
    localStorage.setItem('ensemble.autosave', JSON.stringify(s));
  });
  await page.reload();
  await sceneReady(page);
  assert.equal(await page.locator('.region-g[data-region="lava-tube"]').count(), 1, 'revealed: on the map');
  await page.screenshot({ path: path.join(shots, 'map-revealed.png') });
});

// R-3: one map that zooms through the region tree. The breadcrumb from the
// world to the room; a level with a picture (Harmon's town map) and one
// without (the same world with its picture taken out: node maps of each
// level's children and their routes); travel buttons fill the action box.
await check('the zooming map: breadcrumb, levels with and without a picture, travel buttons', async (page) => {
  await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-maplevel="local"]');
  assert.match(await page.textContent('.map-crumbs'), /Holdout at Harmon's\s*›\s*Harmon\s*›\s*The highway strip\s*›\s*Sales Floor/);
  // Harmon has no picture of its own: the town map, zoomed to its parts, the rest dimmed.
  await page.click('.map-crumbs [data-maplevel="town"]');
  assert.equal(await page.locator('#worldSvg image').count(), 1, 'the picture is underneath');
  assert.equal(await page.evaluate(() => document.querySelector('#worldSvg').firstElementChild.tagName), 'image', 'drawn first, under everything');
  assert.equal(await page.locator('#worldSvg .region-g.dim').count(), 2, 'the junction and Ridge are outside Harmon');
  assert.ok(await page.locator('.region-g[data-region="highway-strip"] .region-shape.here').count());
  await page.screenshot({ path: path.join(shots, 'map-level-town.png') });
  // A leaf is picked, not zoomed; the info strip goes up a level by name.
  await page.locator('.region-g[data-region="main-street"] .region-shape').click({ position: { x: 30, y: 60 } });
  assert.equal(await page.getAttribute('#worldSvg', 'data-view'), 'town');
  assert.match(await page.textContent('#regionInfo'), /Main Street, a part of town in Harmon.*Zoom in/);
  await page.click('[data-maplevel="root"]');
  assert.equal(await page.getAttribute('#worldSvg', 'data-view'), 'root');
  // Remembered per world: a reload opens the same level.
  await page.reload();
  await sceneReady(page);
  assert.equal(await page.getAttribute('#worldSvg', 'data-view'), 'root');
  // Travel buttons: the routes out of the highway strip, clicking fills the action box.
  await page.click('[data-maplevel="local"]');
  await page.click('.map-route[data-say="I go to Highway junction."]');
  assert.equal(await page.inputValue('#actionInput'), 'I go to Highway junction.');
  await page.fill('#actionInput', '');
  // Without a picture: node maps of each level's children, routes by kind.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ensemble.autosave'));
    delete s.scenario.map;
    s.characters.pike.status.location = 'lot';
    s.locations.lot.region = 'junction';
    localStorage.setItem('ensemble.autosave', JSON.stringify(s));
  });
  await page.reload();
  await sceneReady(page);
  await page.click('[data-maplevel="root"]');
  assert.equal(await page.locator('#worldSvg image').count(), 0);
  assert.deepEqual((await page.locator('#worldSvg .region-g').evaluateAll((els) => els.map((e) => e.dataset.region))).sort(), ['junction', 'ridge-town', 'town'], 'the top level only');
  assert.equal(await page.locator('#worldSvg .region-edge.kind-road').count(), 1, 'the road to Ridge');
  await page.screenshot({ path: path.join(shots, 'map-level-nodes.png') });
  await page.click('.region-g[data-region="town"]');
  assert.equal(await page.getAttribute('#worldSvg', 'data-view'), 'town', 'a region with regions inside it zooms in');
  assert.deepEqual((await page.locator('#worldSvg .region-g').evaluateAll((els) => els.map((e) => e.dataset.region))).sort(), ['highway-strip', 'main-street', 'residential']);
  await page.click('[data-maplevel="local"]');
  await page.click('.map-route[data-say="I drive to Ridge."]');
  assert.equal(await page.inputValue('#actionInput'), 'I drive to Ridge.');
  assert.match(await page.getAttribute('.map-route[data-say="I drive to Ridge."]', 'title'), /road, 45m/);
  // Stopped on a journey (R-2): a travel card, not a floor plan.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ensemble.autosave'));
    s.locations['on-the-way'] = { id: 'on-the-way', name: 'On the way to Ridge', desc: 'Somewhere on the way to Ridge, in Highway junction.', outside: true, region: 'junction', site: 'on-the-way', transit: true, connects: ['lot', 'floor'], links: [] };
    s.characters.pike.status.location = 'on-the-way';
    localStorage.setItem('ensemble.autosave', JSON.stringify(s));
  });
  await page.reload();
  await sceneReady(page);
  assert.match(await page.textContent('.travel-card'), /On the way to Ridge, in Highway junction/);
  await page.click('.travel-card .map-route[data-say="I go back to Sales Floor."]');
  assert.equal(await page.inputValue('#actionInput'), 'I go back to Sales Floor.');
});


// Task 3-5: the creator. Draw a region on a map image, export the world as
// a zip, check the zip loads, then play it in the game from disk.
await check('creator: draw a region on a map image, export, and play the export', async (page) => {
  await page.goto(BASE + 'creator.html');
  await page.waitForFunction(() => document.querySelectorAll('#cWorld option').length > 1);
  assert.equal(await page.locator('#cTabs button:disabled').count(), 0, 'every tab is ready (task 6-3)');
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
  // Task 5-3: a lore entry for the station, tried in the test box.
  assert.match(await page.textContent('#cRegionForm'), /Lore: 1 entry/);
  await page.click('#cTabs [data-tab="lore"]');
  await page.click('[data-loreadd="region|station"]');
  await page.fill('[data-lf="title"]', 'Airlock drill');
  await page.fill('[data-lf="text"]', 'Every sol at noon the crew runs a two-minute airlock drill, and nobody skips it twice.');
  await page.fill('#cKwAdd', 'drill, airlock');
  await page.press('#cKwAdd', 'Enter');
  assert.match(await page.textContent('#cLoreForm .c-chips'), /drill[\s\S]*airlock/);
  // Task 5-5: topic tags, built in and the world's own.
  await page.click('[data-topic="work"]');
  await page.fill('#cTopicAdd', 'drills: drill, fire drill');
  await page.press('#cTopicAdd', 'Enter');
  assert.equal(await page.getAttribute('[data-topic="work"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('[data-topic="drills"]', 'aria-pressed'), 'true');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  await page.fill('[data-lt="action"]', 'Ask about the drill.');
  await page.waitForFunction(() => /Airlock drill the player's region; "drill" in the action/.test(document.getElementById('cLoreTest').textContent));
  await page.screenshot({ path: path.join(shots, 'creator-lore.png') });
  // Task 5-7: a new lore pack, its entry edited in the same form, problems named.
  await page.click('#cNewPack');
  await page.waitForSelector('#cPackList [data-pack="new-pack"]');
  assert.match(await page.textContent('#cLoreForm'), /Stored in packs\/new-pack\/pack\.json/);
  assert.match(await page.textContent('#cValidation'), /pack "new-pack": "credit" must say who made it/);
  await page.fill('[data-pf="new-pack|credit"]', 'Smoke Test');
  await page.fill('[data-pf="new-pack|license"]', 'CC BY 4.0');
  await page.fill('[data-lf="title"]', 'Station radio');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  assert.match(await page.textContent('#cPackList'), /Station radio[\s\S]*Ready to share/);
  await page.locator('.c-packs').screenshot({ path: path.join(shots, 'creator-packs.png') });
  // And a timeline event with a condition that diverges when it breaks.
  await page.click('#cTabs [data-tab="timeline"]');
  assert.match(await page.textContent('#cEventList'), /Before the start[\s\S]*Sol 1, 10:00[\s\S]*From the start on[\s\S]*Sol 216, 14:00/);
  await page.click('#cAddEvent');
  await page.fill('[data-ef="text"]', 'Mission Control runs a surprise systems audit over the uplink.');
  await page.click('#cAddPre');
  await page.selectOption('[data-pre="0"][data-pf="kind"]', 'world');
  await page.selectOption('[data-pre="0"][data-pf="a"]', 'comms');
  await page.fill('[data-pre="0"][data-pf="b"]', 'online, 14-minute delay');
  await page.selectOption('[data-ef="onBroken"]', 'diverge');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  await page.screenshot({ path: path.join(shots, 'creator-timeline.png') });
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
  const drill = sc.lore.find((e) => e.title === 'Airlock drill');
  assert.ok(drill && drill.ref === 'station' && drill.keywords.includes('airlock'), 'the lore entry was exported');
  const audit = sc.timeline.find((ev) => /surprise systems audit/.test(ev.text));
  assert.deepEqual(JSON.parse(JSON.stringify(audit.preconditions)), [{ world: 'comms', is: 'online, 14-minute delay' }]);
  assert.equal(audit.onBroken, 'diverge');
  // Play it: open the exported folder in the game and look at the world map.
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  await page.setInputFiles('#folderInput', path.join(out, 'mars-station'));
  await page.waitForFunction(() => [...document.querySelectorAll('#scenarioSelect option')].some((o) => o.value === 'disk:mars-station'));
  await page.selectOption('#scenarioSelect', 'disk:mars-station');
  await newGame(page);
  await sceneReady(page);
  await page.click('[data-maplevel="root"]');
  assert.equal(await page.locator('#worldSvg image').count(), 1, 'the map image came from the export');
  assert.ok(await page.locator('.region-g[data-region="station"] polygon.fc-4').count(), 'drawn, in the sponsor\'s colour');
});

// R-4: the region tree in the creator. A world from the "One city"
// template; regions added inside and next to, one dragged to another
// parent; a route kind of the world's own and a route using it; a map
// attached to a district, with a region drawn on it; test played. Then
// the other templates load with no problems.
await check('creator: a region tree, routes, route kinds and a map on a region, from a template', async (page) => {
  await page.goto(BASE + 'creator.html');
  await page.waitForFunction(() => document.querySelectorAll('#cWorld option').length > 1);
  await page.click('#cNew');
  await page.fill('#cNewTitle', 'Tree City');
  await page.selectOption('#cNewTemplate', 'city');
  await page.click('#cNewGo');
  await page.waitForSelector('#cRegionList [data-sel="brightwater"]');
  assert.match(await page.textContent('#cValidation'), /No problems/, 'the template loads as it is');
  // + Inside and + Next to.
  await page.click('#cRegionList [data-sel="old-town"]');
  await page.click('#cAddInside');
  await page.fill('[data-field="name"]', 'Market Lane');
  await page.click('#cAddNext');
  await page.fill('[data-field="name"]', 'Bell Street');
  assert.equal(await page.inputValue('[data-field="parent"]'), 'old-town', 'next to Market Lane: inside Old Town too');
  // Drag Bell Street onto the Harbour.
  await page.dragAndDrop('#cRegionList [data-sel="bell-street"]', '#cRegionList [data-sel="harbour"]');
  await page.click('#cRegionList [data-sel="bell-street"]');
  assert.equal(await page.inputValue('[data-field="parent"]'), 'harbour', 'dragged inside the Harbour');
  // Dragging a region into its own branch is refused, in words.
  await page.dragAndDrop('#cRegionList [data-sel="brightwater"]', '#cRegionList [data-sel="harbour"]');
  assert.match(await page.textContent('#cBanner'), /Not moved: Brightwater can't go inside The Harbour: The Harbour is inside Brightwater/);
  // A route kind of the world's own, and a route that uses it.
  await page.fill('#cNewKind', 'tram');
  await page.click('#cAddKind');
  await page.fill('[data-kind="tram"][data-kf="time"]', '10m');
  await page.press('[data-kind="tram"][data-kf="time"]', 'Tab');
  await page.click('#cRegionList [data-sel="old-town"]');
  await page.click('#cAddRoute');
  await page.selectOption('[data-route="1"][data-rf="to"]', 'university');
  await page.fill('[data-route="1"][data-rf="kind"]', 'tram');
  await page.press('[data-route="1"][data-rf="kind"]', 'Tab');
  await page.click('[data-rqadd="r:1"]');
  await page.fill('[data-rq="r:1"][data-pf="a"]', 'trams');
  await page.press('[data-rq="r:1"][data-pf="a"]', 'Tab');
  await page.fill('[data-rq="r:1"][data-pf="b"]', 'running');
  await page.press('[data-rq="r:1"][data-pf="b"]', 'Tab');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  // A bad time shows next to the region, by name.
  await page.fill('[data-route="1"][data-rf="time"]', 'soon');
  await page.press('[data-route="1"][data-rf="time"]', 'Tab');
  await page.waitForFunction(() => /Old Town's route to University Quarter: "time" must be like/.test(document.getElementById('cRegionProblems').textContent));
  await page.fill('[data-route="1"][data-rf="time"]', '');
  await page.press('[data-route="1"][data-rf="time"]', 'Tab');
  // A map of its own for Old Town, with Market Lane drawn on it.
  await page.setInputFiles('[data-attachmap="old-town"]', path.join(here, '..', 'scenarios', 'zombie-holdout', 'maps', 'town.svg'));
  await page.waitForSelector('#cSvg image');
  assert.match(await page.textContent('#cHint'), /This is Old Town's map: it shows the regions inside Old Town/);
  assert.match(await page.textContent('#cMapOwner'), /Old Town's map/);
  await page.click('#cRegionList [data-sel="market-lane"]');
  await page.click('[data-mode="draw"]');
  const box = await page.locator('#cSvg').boundingBox();
  for (const [fx, fy] of [[0.2, 0.2], [0.5, 0.2], [0.5, 0.6]]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.keyboard.press('Enter');
  assert.match(await page.textContent('#cRegionForm'), /Outlined with 3 corners/);
  assert.match(await page.textContent('#cRegionList'), /Old Town 🗺/);
  // The harbour isn't inside Old Town: not on this map.
  await page.click('#cRegionList [data-sel="harbour"]');
  assert.match(await page.textContent('#cRegionForm'), /Not inside Old Town, so not on Old Town's map/);
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  await page.screenshot({ path: path.join(shots, 'creator-region-tree.png') });
  // Test play: it loads in the game and plays a turn.
  const [game] = await Promise.all([page.context().waitForEvent('page'), page.click('#cTest')]);
  await game.waitForFunction(() => /turn 0$/.test(((document.getElementById('sceneBar') || {}).textContent || '').trim()), null, { timeout: 15000 });
  await act(game, 'I look around the café.');
  // A city is region-focused (R-8): the map opens at your district, with
  // the places you know as pins and the ways out under it.
  assert.equal(await game.textContent('.map-crumbs [aria-current="true"]'), 'Old Town');
  assert.match(await game.textContent('.map-places'), /Corner Café · you are here/);
  assert.match(await game.textContent('#mapPane'), /Ways to other places:/);
  await game.click('[data-maplevel="local"]');
  assert.match(await game.textContent('.map-crumbs'), /Tree City\s*›\s*Brightwater\s*›\s*Old Town\s*›\s*Corner Café/);
  // The café is flavour: a scene card, the floor plan a toggle away.
  assert.match(await game.textContent('.scene-card'), /Corner Café[\s\S]*Six tables/);
  await game.click('[data-floorplan]');
  await game.waitForSelector('#mapPane svg');
  await game.click('[data-scenecard]');
  await game.waitForSelector('.scene-card');
  await game.close();
  // The other templates load as they are.
  for (const kind of ['country', 'planets']) {
    await page.click('#cNew');
    await page.fill('#cNewTitle', `Template ${kind}`);
    await page.selectOption('#cNewTemplate', kind);
    await page.click('#cNewGo');
    await page.waitForSelector('#cRegionList');
    await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  }
  assert.match(await page.textContent('#cRegionList'), /Veyra[\s\S]*Veyra Starport[\s\S]*Ossam[\s\S]*Thule Drift/);
});

// Task 6-1: a world built entirely in the creator: New world, the World,
// Groups and Starts tabs, test play in a new tab (a turn against the mock
// model, the player's own game untouched), then export and load the zip.
await check('creator: a new world from nothing, test played and exported', async (page) => {
  await page.goto(BASE + 'creator.html');
  await page.waitForFunction(() => document.querySelectorAll('#cWorld option').length > 1);
  await page.click('#cNew');
  await page.fill('#cNewTitle', 'Harbor Watch');
  await page.click('#cNewGo');
  await page.waitForSelector('[data-path="setting"]');
  assert.match(await page.textContent('#cValidation'), /No problems/, 'a blank world loads as it is');
  await page.fill('[data-path="setting"]', 'A fishing harbor on a cold northern coast, where the boats go out before dawn and everyone knows whose nets are whose.');
  await page.fill('[data-path="tags"]', 'cozy, mystery');
  await page.waitForFunction(() => /cozy \(leads\)[\s\S]*mystery/.test(document.getElementById('cGenre').textContent));
  await page.click('#cAddNeed');
  await page.fill('[data-idof="need"]', 'sleep');
  await page.press('[data-idof="need"]', 'Tab');
  await page.fill('[data-path="needs.0.label"]', 'Sleep');
  await page.click('[data-addkey="world.json|world"]');
  await page.fill('[data-rekey="world.json|world|new-key"]', 'weather');
  await page.press('[data-rekey="world.json|world|new-key"]', 'Tab');
  await page.fill('[data-path="world.weather"]', 'grey and calm');
  await page.click('#cTabs [data-tab="groups"]');
  await page.click('#cAddGroup');
  await page.fill('[data-path="factions.0.name"]', 'Harbor Guild');
  await page.waitForFunction(() => /Harbor Guild/.test(document.getElementById('cGroupList').textContent));
  await page.click('#cTabs [data-tab="starts"]');
  await page.fill('[data-path="title"]', 'First light');
  await page.fill('#cNewRoom', 'Boathouse');
  await page.click('#cAddRoom');
  await page.selectOption('[data-connadd="boathouse"]', 'main-room');
  await page.selectOption('[data-conn="boathouse|main-room"]', 'door');
  await page.waitForSelector('#cPreview svg');
  await page.click('#cNewPerson');
  await page.fill('#cNpName', 'Ana Reyes');
  await page.fill('#cNpRole', 'harbormaster');
  await page.click('#cNpAdd');
  await page.waitForSelector('[data-castcard="ana-reyes"]');
  await page.click('[data-addclock="starts/start.json|clocks"]');
  await page.fill('[data-path="clocks.0.name"]', 'Storm coming in');
  await page.click('[data-addclock="starts/start.json|clocks.0.then"]');
  await page.fill('[data-path="opening"]', 'The harbor bell rings twice in the fog, which it never does. Ana is already on the quay, coat buttoned wrong, looking at you.');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  await page.screenshot({ path: path.join(shots, 'creator-starts.png') });
  // Test play: the game opens with the working copy and plays a turn.
  const [game] = await Promise.all([page.context().waitForEvent('page'), page.click('#cTest')]);
  game.on('pageerror', (e) => { throw e; });
  await game.waitForFunction(() => /turn 0$/.test(((document.getElementById('sceneBar') || {}).textContent || '').trim()), null, { timeout: 15000 });
  assert.equal(await game.inputValue('#scenarioSelect'), 'test:harbor-watch');
  assert.match(await game.textContent('#log'), /harbor bell rings twice/);
  await act(game, 'I walk over to Ana.');
  assert.equal(await game.evaluate(() => localStorage.getItem('ensemble.autosave')), null, "test play leaves the player's own game alone");
  await game.close();
  // Export: the zip loads as a world, and its start plays.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#cExport')]);
  const E = helpers.loadEngine();
  const out = path.join(shots, 'creator-new-world');
  fs.rmSync(out, { recursive: true, force: true });
  for (const e of E.Zip.read(new Uint8Array(fs.readFileSync(await download.path())))) {
    fs.mkdirSync(path.dirname(path.join(out, e.name)), { recursive: true });
    fs.writeFileSync(path.join(out, e.name), e.data);
  }
  const w = helpers.readWorld(path.join(out, 'harbor-watch'), E);
  assert.equal(w.starts[0].error, undefined);
  const sc = w.starts[0].scenario;
  assert.deepEqual([...sc.characters], ['you', 'ana-reyes']);
  assert.equal(sc.locations.find((l) => l.id === 'boathouse').links[0].kind, 'door');
  assert.equal(sc.clocks[0].then.length, 1);
  assert.equal(sc.world.weather, 'grey and calm');
  assert.equal(sc.needs[0].id, 'sleep');
  assert.equal(sc.factions[0].name, 'Harbor Guild');
  // The draft survives a reload of the creator.
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('#cWorld option')].some((o) => o.value === 'draft:harbor-watch'));
});

// Task 6-2: the Characters tab: edit someone in the shared form, make a new
// person, import a Tavern card (one conversion call, review, image rights),
// put them in a start, see them in test play, and export it all.
await check('creator: create, edit and import characters', async (page) => {
  await page.goto(BASE + 'creator.html');
  await page.waitForFunction(() => document.querySelectorAll('#cWorld option').length > 1);
  await page.selectOption('#cWorld', 'server:mars-station');
  await page.waitForSelector('#cSvg');
  await page.click('#cTabs [data-tab="characters"]');
  await page.click('[data-csel="okafor"]');
  await page.fill('#mkTrait', 'stubborn');
  await page.press('#mkTrait', 'Enter');
  await page.waitForFunction(() => /stubborn/.test(document.getElementById('cCharBody').textContent));
  assert.equal(await page.locator('#cCharErrors li').count(), 0);
  // A new person, built up in the author form.
  await page.click('#cAddChar');
  await page.fill('[data-f="name"]', 'Lena Sato');
  await page.fill('[data-f="roleText"]', 'cargo pilot');
  await page.fill('[data-f="want"]', 'fly the lander home');
  await page.fill('#mkTrait', 'calm');
  await page.press('#mkTrait', 'Enter');
  await page.click('[data-skill="piloting"][data-step="1"]');
  await page.selectOption('[data-af="agendaMode"]', 'none');
  await page.waitForFunction(() => !document.querySelector('#cCharErrors li'));
  await page.fill('[data-idof="character"]', 'lena-sato');
  await page.press('[data-idof="character"]', 'Tab');
  await page.waitForFunction(() => /Lena Sato/.test(document.getElementById('cCharList').textContent) && document.querySelector('[data-csel="lena-sato"]'));
  // A card: what is used and what is left out, then the conversion and review.
  await page.setInputFiles('#cCardFile', path.join(here, 'fixtures', 'cards', 'v2.png'));
  await page.waitForSelector('#cCardConvert');
  assert.match(await page.textContent('#cMain'), /Left out:.*scenario, first message, system prompt, other greetings/);
  await page.click('#cCardConvert');
  await page.waitForSelector('#cCardAdd');
  assert.match(await page.textContent('#cMain'), /Left out a line written to the player/);
  assert.equal(await page.inputValue('[data-f="name"]'), 'Juniper Vale');
  await page.screenshot({ path: path.join(shots, 'creator-card-review.png') });
  await page.check('#cCardRights');
  await page.click('#cCardAdd');
  await page.waitForSelector('[data-csel="juniper-vale"]');
  // Into a start, and into the game.
  await page.click('#cTabs [data-tab="starts"]');
  await page.selectOption('#cCastAdd', 'juniper-vale');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  await page.click('#cTabs [data-tab="portraits"]');
  assert.match(await page.textContent('#cMain'), /Juniper Vale: their own \(juniper-vale\.png\)/);
  const [game] = await Promise.all([page.context().waitForEvent('page'), page.click('#cTest')]);
  await game.waitForFunction(() => /turn 0$/.test(((document.getElementById('sceneBar') || {}).textContent || '').trim()), null, { timeout: 15000 });
  assert.match(await game.textContent('body'), /Juniper Vale/);
  await game.close();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#cExport')]);
  const E = helpers.loadEngine();
  const files = {};
  for (const e of E.Zip.read(new Uint8Array(fs.readFileSync(await download.path())))) files[e.name] = e.data;
  const json = (n) => JSON.parse(E.Zip.text(files[`mars-station/${n}`]));
  assert.ok(json('characters/okafor.json').traits.includes('stubborn'));
  const lena = json('characters/lena-sato.json');
  assert.equal(lena.role, 'cargo pilot');
  assert.equal(lena.skills.piloting, 1);
  assert.equal(lena.agenda, null);
  const jv = json('characters/juniper-vale.json');
  assert.equal(jv.portrait, 'portraits/juniper-vale.png');
  assert.ok(!/pulled you/.test(jv.description), 'the line to the player stayed out');
  assert.ok(files['mars-station/portraits/juniper-vale.png'], 'the card image is in the export');
  assert.ok(json('world.json').characters.includes('juniper-vale') && json('world.json').characters.includes('lena-sato'));
});

// Task 6-3: the Sites tab. Draw a tavern on a battlemap (three rooms, two
// doors, a way in, a spot), tag it, save it to the world, see the matching
// box pick it and the preview draw it; then play the exported world: a trip
// to "the tavern" builds the place from the map, drawn on its image in fog.
// The library export opens in the game as a library folder.
await check('creator: draw a site map on a battlemap, save it to the world, and play it', async (page) => {
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + 'creator.html');
  await page.waitForFunction(() => document.querySelectorAll('#cWorld option').length > 1);
  await page.selectOption('#cWorld', 'server:zombie-holdout');
  await page.waitForSelector('#cSvg');
  await page.click('#cTabs [data-tab="sites"]');
  await page.click('#cNewSite');
  await page.setInputFiles('#cSiteImage', path.join(here, 'fixtures', 'battlemap-tavern.svg'));
  await page.waitForSelector('#cSiteSvg image');
  await page.fill('[data-path="grid.square"]', '50');
  await page.fill('[data-path="grid.unit"]', '5 ft');
  // Image coordinates → where to click on screen.
  const at = (x, y) => page.evaluate(([x, y]) => { const s = document.getElementById('cSiteSvg'); const p = s.createSVGPoint(); p.x = x; p.y = y; const q = p.matrixTransform(s.getScreenCTM()); return [q.x, q.y]; }, [x, y]);
  const click = async (x, y) => { const [cx, cy] = await at(x, y); await page.mouse.click(cx, cy); };
  const draw = async (corners) => {
    await page.click('[data-xmode="draw"]');
    for (const [x, y] of corners) await click(x, y);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-xmode="select"][aria-pressed="true"]'));
  };
  // Corners a little off: they snap to the 50 px grid.
  await draw([[4, 6], [296, 3], [303, 397], [2, 395]]);
  await page.fill('[data-path="rooms.0.name"]', 'Common Room');
  await page.fill('[data-path="rooms.0.desc"]', 'Long tables, a cold hearth and a bar along the wall.');
  await draw([[302, 4], [597, 2], [598, 198], [304, 203]]);
  await page.fill('[data-path="rooms.1.name"]', 'Kitchen');
  await page.fill('[data-path="rooms.1.desc"]', 'A black stove and a hanging rack of pans.');
  await draw([[303, 204], [596, 202], [597, 396], [302, 398]]);
  await page.fill('[data-path="rooms.2.name"]', 'Cellar');
  await page.fill('[data-path="rooms.2.desc"]', 'Barrels in the dark under a low ceiling.');
  await page.click('[data-xmode="door"]');
  await click(301, 100);
  await click(301, 300);
  await page.click('[data-xmode="entrance"]');
  await click(2, 200);
  await page.selectOption('#cSpotKind', 'loot');
  await page.click('[data-xmode="spot"]');
  await click(500, 300);
  await page.fill('[data-path="type"]', 'tavern');
  await page.fill('[data-path="tags"]', 'inn, pub');
  await page.fill('[data-path="credit"]', 'Ensemble test fixture');
  await page.fill('[data-path="license"]', 'CC0-1.0');
  assert.equal(await page.locator('#cSiteSvg .c-sdoor').count(), 2);
  assert.equal(await page.locator('#cSiteSvg .c-sentr').count(), 1);
  assert.equal(await page.locator('#cSiteSvg .c-sspot').count(), 1);
  await page.screenshot({ path: path.join(shots, 'creator-sites.png') });
  await page.click('#cSiteSaveWorld');
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  assert.match(await page.textContent('#cMain'), /In the world/);
  await page.fill('[data-xm="kind"]', 'the old tavern');
  assert.match(await page.textContent('#cSiteMatch'), /New site ← picked/);
  await page.click('#cSitePreview');
  await page.waitForSelector('#cSiteCanvas svg.sd-image');
  assert.equal(await page.locator('#cSiteCanvas .c-tok').count(), 2, 'sample people in the preview');
  // Export the library folder and the world.
  const E = helpers.loadEngine();
  const unzip = async (download, dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const e of E.Zip.read(new Uint8Array(fs.readFileSync(await download.path())))) {
      fs.mkdirSync(path.dirname(path.join(dir, e.name)), { recursive: true });
      fs.writeFileSync(path.join(dir, e.name), e.data);
    }
  };
  const [libZip] = await Promise.all([page.waitForEvent('download'), page.click('#cSiteExport')]);
  const libDir = path.join(shots, 'creator-site-library');
  await unzip(libZip, libDir);
  const [worldZip] = await Promise.all([page.waitForEvent('download'), page.click('#cExport')]);
  const out = path.join(shots, 'creator-site-world');
  await unzip(worldZip, out);
  const map = JSON.parse(fs.readFileSync(path.join(out, 'zombie-holdout', 'sites', 'new-site.json'), 'utf8'));
  assert.deepEqual(map.rooms[0].shape, [[0, 0], [300, 0], [300, 400], [0, 400]], 'snapped to the grid');
  assert.ok(fs.existsSync(path.join(out, 'zombie-holdout', 'sites', 'new-site.svg')), 'the image is in the export');
  // Play it.
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelectorAll('#scenarioSelect option').length > 0);
  await page.setInputFiles('#folderInput', path.join(libDir, 'new-site-library'));
  await page.setInputFiles('#folderInput', path.join(out, 'zombie-holdout'));
  await page.waitForFunction(() => [...document.querySelectorAll('#scenarioSelect option')].some((o) => o.value === 'disk:zombie-holdout'));
  await page.selectOption('#scenarioSelect', 'disk:zombie-holdout');
  await page.selectOption('#startSelect', 'herd');
  await newGame(page);
  await act(page, 'I head to the tavern on Main Street.');
  assert.match(await page.textContent('#sceneBar'), /Common Room/, 'arrived at the way in');
  await page.waitForSelector('#mapPane svg.sd-image image');
  assert.equal(await page.locator('#mapPane .sd-image .map-room').count(), 1, 'only the room you are in shows; the rest is fog');
  assert.ok(await page.locator('#mapPane .sd-img-unknown').count(), 'a "?" past each door');
  await page.screenshot({ path: path.join(shots, 'site-image-map.png') });
});

// Task 4-5: a new world on the shared base map. The area is cut from the
// world picture, the map knows where it is on the globe (the readout over
// Lyon), a named place goes there, a region can have two pieces, and the
// export keeps the projection and the picture.
await check('creator: a new world on the base map, with real coordinates, places and a region in two pieces', async (page) => {
  await page.goto(BASE + 'creator.html');
  await page.waitForFunction(() => document.querySelectorAll('#cWorld option').length > 1);
  await page.click('#cNew');
  await page.fill('#cNewTitle', 'Lyon 1943');
  await page.selectOption('#cNewBase', 'world');
  await page.selectOption('#cNewArea', { label: 'Western Europe' });
  await page.click('#cNewGo');
  await page.waitForSelector('#cSvg image');
  assert.match(await page.textContent('#cBanner'), /Started on the base map/);
  // Image coordinates → screen; Lyon is 45.76° N, 4.84° E.
  const at = (x, y) => page.evaluate(([x, y]) => { const s = document.getElementById('cSvg'); const p = s.createSVGPoint(); p.x = x; p.y = y; const q = p.matrixTransform(s.getScreenCTM()); return [q.x, q.y]; }, [x, y]);
  const size = await page.evaluate(() => { const i = document.querySelector('#cSvg image'); return [Number(i.getAttribute('width')), Number(i.getAttribute('height'))]; });
  const lyon = [((4.84 + 11) / 41) * size[0], ((60 - 45.76) / 25) * size[1]];
  const [lx, ly] = await at(...lyon);
  await page.mouse.move(lx, ly);
  await page.waitForFunction(() => /45\.7\d° N, 4\.8\d° E/.test(document.getElementById('cCoords').textContent));
  await page.click('[data-mode="place"]');
  await page.mouse.click(lx, ly);
  await page.waitForSelector('[data-path="map.places.0.name"]');
  await page.fill('[data-path="map.places.0.name"]', 'Lyon');
  await page.selectOption('[data-path="map.places.0.kind"]', 'city');
  assert.equal(Number(await page.inputValue('[data-placell="1"]')).toFixed(1), '45.8');
  // A region with two pieces: the mainland and Corsica.
  const draw = async (pts, another) => {
    await page.click('[data-mode="draw"]');
    if (another) await page.check('#cAddPiece');
    for (const [lon, lat] of pts) { const [x, y] = await at(((lon + 11) / 41) * size[0], ((60 - lat) / 25) * size[1]); await page.mouse.click(x, y); }
    await page.keyboard.press('Enter');
  };
  await draw([[-1, 49], [7, 49], [7, 43], [-1, 43]]);
  await page.fill('[data-field="name"]', 'France');
  await draw([[8.5, 43], [9.6, 43], [9.6, 41.4], [8.5, 41.4]], true);
  await page.waitForFunction(() => /Outlined in 2 pieces/.test(document.getElementById('cRegionForm').textContent));
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  await page.screenshot({ path: path.join(shots, 'creator-basemap.png') });
  // France's own map, cut from the base map (R-9): Lyon moves onto it.
  await page.click('[data-cutmap="france"]');
  await page.waitForFunction(() => /France has its own map, cut from the base map, with 0 regions and 1 place inside it moved onto it/.test(document.getElementById('cBanner').textContent));
  assert.equal(await page.inputValue('#cMapOwner'), 'france', "now editing France's map");
  await page.waitForFunction(() => /No problems/.test(document.getElementById('cValidation').textContent));
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#cExport')]);
  const E = helpers.loadEngine();
  const files = {};
  for (const e of E.Zip.read(new Uint8Array(fs.readFileSync(await download.path())))) files[e.name] = e.data;
  const w = JSON.parse(E.Zip.text(files['lyon-1943/world.json']));
  assert.deepEqual(w.map.bounds, [-11, 35, 30, 60]);
  assert.equal(w.map.projection, 'equirectangular');
  assert.equal(w.map.base, 'world');
  assert.ok(files['lyon-1943/maps/base.jpg'] && files['lyon-1943/maps/base.jpg'].length > 10000, 'the cut picture is in the export');
  assert.equal(w.map.regions.france.polygons.length, 2);
  const fm = w.regions.find((r) => r.id === 'france').map;
  assert.deepEqual([fm.image, fm.base, fm.projection], ['maps/france.jpg', 'world', 'equirectangular']);
  assert.ok(files['lyon-1943/maps/france.jpg'] && files['lyon-1943/maps/france.jpg'].length > 10000, "France's picture is in the export");
  assert.ok(!(w.map.places || []).length, 'Lyon left the world map…');
  assert.equal(fm.places[0].region, 'france', "…for France's, still in the region drawn around it");
  const ll = E.Geo.toLonLat(fm, fm.places[0].at);
  assert.ok(Math.abs(ll[0] - 4.84) < 0.1 && Math.abs(ll[1] - 45.76) < 0.1, `Lyon at ${ll}`);
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

// Task 7-2: a place's floor plan zooms and pans (the school is 28 rooms on a drawn
// sheet; the dorm is laid out by the game, with rooms that grew), and a pan is
// never a click on a room.
await check('the floor plan zooms and pans: the drawn school and the laid-out dorm', async (page) => {
  for (const [start, room, kind] of [['hayakawa', 'classroom-1b', 'svg.sd-image'], ['dorm', 'kaede-room', 'svg.sd']]) {
    const { state } = helpers.newGame('seiryo-high', start);
    state.characters[state.player].status.location = room;
    await page.setInputFiles('#loadInput', { name: `${start}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(state)) });
    await page.waitForFunction(() => /turn 0$/.test(document.getElementById('sceneBar').textContent.trim()));
    await page.click('.view-switch button[data-view="map"]');
    await page.click('[data-maplevel="local"]');
    await page.waitForSelector(`#siteSvg${kind.replace('svg', '')}`);
    const vb = () => page.getAttribute('#siteSvg', 'viewBox');
    const full = await vb();
    await page.click('[data-zoom="in"]');
    const zoomed = await vb();
    assert.ok(Number(zoomed.split(' ')[2]) < Number(full.split(' ')[2]), `${start}: zoomed in (${full} → ${zoomed})`);
    const box = await page.locator('#siteSvg').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 3 + 40, { steps: 6 });
    await page.mouse.up();
    assert.notEqual(await vb(), zoomed, `${start}: panned`);
    assert.equal(await page.inputValue('#actionInput'), '', `${start}: a pan fills in nothing`);
    await page.click('[data-zoom="reset"]');
    assert.equal(await vb(), full, `${start}: reset`);
  }
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
async function setAppearance(page, { theme, textSize, font, spacing, motion, mapDetail }, save = true) {
  await page.click('#btnSettings');
  const section = page.locator('#settings details[data-section="appearance"]');
  if (!(await section.evaluate((d) => d.open))) await section.locator('summary').click();
  if (theme) await page.selectOption('#aTheme', theme);
  if (font) await page.selectOption('#aFont', font);
  if (spacing) await page.selectOption('#aSpacing', spacing);
  if (motion) await page.selectOption('#aMotion', motion);
  if (mapDetail) await page.selectOption('#aMapDetail', mapDetail);
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

// Task 3-7: the detailed map in every theme, on desktop and phone; "Map
// detail: simple" draws the boxes.
for (const phone of [false, true]) {
  await check(`${phone ? 'phone: ' : ''}the detailed map in every theme, and the simple one`, async (page) => {
    await page.selectOption('#scenarioSelect', 'server:zombie-holdout');
    await newGame(page);
    await sceneReady(page);
    if (phone) await page.click('#btnMapPhone');
    for (const theme of ['dark', 'light', 'hv']) {
      await setAppearance(page, { theme });
      assert.ok(await page.isVisible('#mapPane svg.sd'), theme);
      assert.equal(await page.locator('#mapPane svg.sd .map-room').count(), 6, `${theme}: the holdout's six rooms`);
      assert.equal(await page.locator('#mapPane svg.sd .map-feature').count(), 14, `${theme}: all fourteen features`);
      const hidden = await page.locator('#mapPane svg.sd .sd-decor').evaluateAll((els) => els.every((e) => getComputedStyle(e).display === 'none'));
      if (theme === 'hv') assert.ok(hidden, 'no decoration in high visibility');
      await page.screenshot({ path: path.join(shots, `map-detail-${phone ? 'phone-' : ''}${theme}.png`) });
    }
    await page.locator('#mapPane .map-feature[data-feature="generator"]').click();
    assert.equal(await page.inputValue('#actionInput'), 'Look at the generator.');
    await setAppearance(page, { mapDetail: 'simple' });
    assert.ok(!(await page.locator('#mapPane svg.sd').count()) && (await page.locator('#mapPane g.map-room').count()) === 6, 'simple: the boxes (a room that grew has a box for each part)');
  });
}

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
