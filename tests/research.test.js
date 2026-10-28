// The research helper (ROADMAP Phase 5): the topic list from the world, the
// checks on every draft (copied text, size, refs, connection to the world,
// secrets, the start date), the command end to end on a copy of the holdout
// with a fake wiki and a fake model, resuming, re-applying, and drafts being
// ignored by the game until accepted in the creator.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, loadEngine, readWorld, worldFiles } = require('./helpers');

const plain = (x) => JSON.parse(JSON.stringify(x));
const cli = () => import(pathToFileURL(path.join(ROOT, 'tools', 'research.mjs')).href);

// A copy of the holdout to research in, removed when the tests end.
const temps = [];
test.after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function copyWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-research-'));
  temps.push(dir);
  const to = path.join(dir, 'zombie-holdout');
  fs.cpSync(path.join(ROOT, 'scenarios', 'zombie-holdout'), to, { recursive: true });
  return to;
}

// ---------- a fake wiki and a fake model behind one fetch ----------
const PAGES = {
  'Highway junction (Harmon County)': 'The Harmon County junction joins Route 9 to Interstate 40 beneath a concrete overpass built in 1971. Truckers called it the Knot because of the tangle of ramps.\n\nA weigh station sits on the eastbound ramp.\n\n== References ==\n1. Some book.',
  'Ridge, Harmon County': 'Ridge is a farming town of about nine hundred people at the top of Ridge Road. Its grain elevator is the tallest building in the county.',
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeFetch(model) {
  const calls = { wiki: [], model: [] };
  const fn = async (url, opts) => {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      const body = JSON.parse(opts.body);
      const call = { kind: body.messages ? null : null, user: body.messages[1].content, system: body.messages[0].content };
      calls.model.push(call);
      const out = await model(call, calls.model.length);
      return ok({ choices: [{ message: { content: typeof out === 'string' ? out : JSON.stringify(out) }, finish_reason: 'stop' }] });
    }
    if (u.includes('/api/extra/perf')) return { ok: false, status: 404 };
    calls.wiki.push(u);
    const params = new URL(u).searchParams;
    if (params.get('list') === 'search') {
      const s = params.get('srsearch');
      const title = s === 'Highway junction' ? 'Highway junction (Harmon County)' : s === 'Ridge' ? 'Ridge, Harmon County' : null;
      return ok({ query: { search: title ? [{ title }] : [] } });
    }
    if (params.get('prop') === 'extracts|info') {
      const t = params.get('titles');
      return ok({ query: { pages: [PAGES[t] ? { title: t, extract: PAGES[t], fullurl: `https://en.wikipedia.org/wiki/${encodeURIComponent(t)}` } : { title: t, missing: true }] } });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return { fn, calls };
}
const topicOf = (user) => (/=== RESEARCH: (.+) ===/.exec(user) || [])[1];
const retrying = (user) => user.includes('Your last reply had a problem');
const JUNCTION_ENTRY = { title: 'The Knot', about: 'region', ref: 'Highway junction', keywords: ['Knot', 'overpass'], text: 'Truckers know the highway junction as the Knot: a snarl of ramps under a 1970s concrete overpass where the two-lane road meets the interstate. A weigh station on the eastbound ramp gives a clear view down both roads, which makes it the obvious place to stop and search anyone passing through.' };
function goodModel(call) {
  const topic = topicOf(call.user);
  if (topic === 'Highway junction') {
    // The first try copies the source; the retry names the problem.
    if (!retrying(call.user)) return { entries: [{ title: 'The Knot', about: 'region', ref: 'junction', text: 'The Harmon County junction joins Route 9 to Interstate 40 beneath a concrete overpass built in 1971, and the area around it is busy with traffic and trucks all day long and through most nights.' }], later: [], secrets: [] };
    return { entries: [JUNCTION_ENTRY],
      later: [{ date: '2026-03-17', text: 'A National Guard column passes through the junction heading west.', scope: 'regional', region: 'Highway junction' }, { date: null, text: 'The weigh station is set on fire.', scope: 'regional', region: 'junction' }],
      secrets: [{ who: 'Ruth Han', text: 'She has been listening to convoy traffic on her radio.' }] };
  }
  if (topic === 'Ridge') {
    return { entries: [
      { title: 'Ridge', about: 'region', ref: 'ridge-town', keywords: ['Ridge Road'], text: 'Ridge is a farm town of roughly nine hundred, up where Ridge Road ends, and its grain elevator stands taller than anything else in the county. People there trade flour and feed, and they have always kept to themselves, so news from the town reaches the highway slowly and usually secondhand.' },
      { title: 'Grasshoppers', about: 'topic', ref: null, keywords: ['grasshopper'], text: 'Grasshoppers are insects of the suborder Caelifera. They eat plants, can jump many times their body length, and some species form huge swarms called locusts when conditions are right, stripping whole fields bare in a matter of days across large areas.' },
      { title: 'Radio rumours', about: 'topic', ref: null, keywords: ['radio'], text: 'In Ridge they say someone fixed a handheld radio and heard a rescue convoy broadcast about the coastal safe zone, and that it can take only three more people, which is why the town has started watching the road for anyone heading toward the coast.' },
    ], later: [], secrets: [] };
  }
  return { entries: [], later: [], secrets: [] };
}
// The holdout's start is Day 23; say that is 2026-03-14.
const PLAN = ['--date', '2026-03-14', '--as-of', 'March 2026, day 23 of the outbreak'];
// Only the junction, Ridge and the convoy (which the wiki doesn't have). The
// holdout has lore of its own for the junction and Ridge, so those are forced.
function trim(dir) {
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  job.topics.forEach((t) => {
    t.skip = !['region:junction', 'region:ridge-town', 'group:convoy'].includes(t.id);
    if (!t.skip) Object.assign(t, { force: true, status: 'todo' });
  });
  fs.writeFileSync(path.join(dir, 'research.json'), JSON.stringify(job, null, 2));
  return job;
}
const quiet = () => { const lines = []; return { log: (m) => lines.push(String(m)), lines }; };

// ---------- the command end to end ----------

test('plan lists topics from the world: the world, its regions, groups and characters', async () => {
  const { main } = await cli();
  const dir = copyWorld();
  const q = quiet();
  assert.equal(await main(['plan', dir, ...PLAN], { fetch: fakeFetch(goodModel).fn, log: q.log }), 0);
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  assert.deepEqual(job.topics.map((t) => t.id), ['world', 'region:highway-strip', 'region:main-street', 'region:residential', 'region:junction', 'region:ridge-town', 'region:town', 'group:convoy', 'group:ridge', 'character:pike', 'character:ortiz', 'character:coleman', 'character:han', 'character:ferris']);
  assert.deepEqual([job.calendar, job.asOf, job.wiki], [{ date: '2026-03-14' }, 'March 2026, day 23 of the outbreak', 'https://en.wikipedia.org/w/api.php']);
  assert.match(q.lines.join('\n'), /Trim it before running/);
  assert.equal(await main(['plan', dir], { fetch: fakeFetch(goodModel).fn, log: q.log }), 1, 'never overwrites a plan');
});

test('run turns sources into checked drafts: lore in a packet, dated events in the timeline, secrets and undated events as suggestions', async () => {
  const { main } = await cli();
  const dir = copyWorld();
  const f = fakeFetch(goodModel);
  const q = quiet();
  await main(['plan', dir, ...PLAN], { fetch: f.fn, log: q.log });
  trim(dir);
  assert.equal(await main(['run', dir], { fetch: f.fn, log: q.log }), 0, q.lines.join('\n'));
  const out = q.lines.join('\n');
  // The copied first try was sent back with the problem named.
  const junctionCalls = f.calls.model.filter((c) => topicOf(c.user) === 'Highway junction');
  assert.equal(junctionCalls.length, 2);
  assert.match(junctionCalls[1].user, /copies the source word for word/);
  assert.ok(!junctionCalls[0].user.includes('Some book'), 'nothing from the references on');
  assert.match(junctionCalls[0].user, /=== IN THIS WORLD ===\nregions: highway-strip \(The highway strip\)/);
  assert.match(junctionCalls[0].user, /The story starts in March 2026, day 23 of the outbreak \(2026-03-14\)\./);
  const packet = JSON.parse(fs.readFileSync(path.join(dir, 'lore', 'research.json'), 'utf8'));
  assert.deepEqual(packet.map((e) => e.id), ['knot', 'ridge']);
  const knot = packet[0];
  assert.deepEqual([knot.level, knot.ref, knot.draft], ['region', 'junction', true]);
  assert.deepEqual(knot.keywords, ['Knot', 'overpass', 'The Knot']);
  assert.deepEqual(knot.sources, [{ title: 'Highway junction (Harmon County)', url: 'https://en.wikipedia.org/wiki/Highway%20junction%20(Harmon%20County)' }]);
  const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.ok(world.lore.includes('research'));
  const guard = world.timeline.find((ev) => ev.draft);
  assert.deepEqual(guard, { id: 'research-a-national-guard-colu', when: { day: 26, hour: 9 }, scope: 'regional', text: 'A National Guard column passes through the junction heading west.', draft: true, region: 'junction' });
  assert.match(out, /Topics: 2 done, 0 already known to the model, 1 without a source, 0 failed, 0 with lore of yours already, 11 skipped\./);
  assert.match(out, /Secrets found[^]*han: She has been listening to convoy traffic/);
  assert.match(out, /Later events without a date[^]*The weigh station is set on fire\./);
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  assert.ok(job.log.some((l) => /not about this world, dropped: Grasshoppers/.test(l.warning)));
  assert.ok(job.log.some((l) => /gives away Ruth Han's secret, dropped: Radio rumours/.test(l.warning)));
  // The game ignores drafts until they are accepted in the creator.
  const E = loadEngine();
  const files = worldFiles(dir);
  const sc = E.Scenario.startScenario(E.Scenario.prepareWorld('zombie-holdout', plain(files)));
  const state = E.Engine.newGame(sc);
  assert.ok(!E.Lore.entries(sc).some((e) => e.id === 'knot'));
  assert.ok(!E.Timeline.all(state).some((ev) => ev.draft));
  assert.equal(E.LoreEdit.acceptAll(files, 'lore'), 2);
  assert.equal(E.LoreEdit.acceptAll(files, 'event'), 1);
  const accepted = E.Scenario.startScenario(E.Scenario.prepareWorld('zombie-holdout', plain(files)));
  assert.ok(E.Lore.entries(accepted).some((e) => e.id === 'knot'));
  assert.ok(E.Timeline.all(E.Engine.newGame(accepted)).some((ev) => ev.id === 'research-a-national-guard-colu'));
});

test('a failed topic is marked and the run goes on; running again retries it and leaves done topics alone', async () => {
  const { main } = await cli();
  const dir = copyWorld();
  const q = quiet();
  await main(['plan', dir, ...PLAN], { fetch: fakeFetch(goodModel).fn, log: q.log });
  trim(dir);
  const broken = fakeFetch((call) => (topicOf(call.user) === 'Ridge' ? 'not json' : goodModel(call)));
  await main(['run', dir], { fetch: broken.fn, log: q.log });
  let job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  assert.deepEqual(job.topics.filter((t) => !t.skip).map((t) => [t.id, t.status]), [['region:junction', 'done'], ['region:ridge-town', 'failed'], ['group:convoy', 'no source']]);
  assert.match(q.lines.join('\n'), /failed: Ridge: .* \(run again to retry\)/);
  const fixed = fakeFetch(goodModel);
  await main(['run', dir], { fetch: fixed.fn, log: q.log });
  job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  assert.equal(job.topics.find((t) => t.id === 'region:ridge-town').status, 'done');
  assert.deepEqual([...new Set(fixed.calls.model.map((c) => topicOf(c.user)))], ['Ridge'], 'only the failed topic again');
  assert.ok(!fixed.calls.wiki.some((u) => u.includes('Highway')), 'and no fetch for the done one');
});

test('apply writes the drafts again without the model, keeping what the author accepted and replacing untouched drafts', async () => {
  const { main } = await cli();
  const dir = copyWorld();
  const q = quiet();
  await main(['plan', dir, ...PLAN], { fetch: fakeFetch(goodModel).fn, log: q.log });
  trim(dir);
  await main(['run', dir], { fetch: fakeFetch(goodModel).fn, log: q.log });
  const packetPath = path.join(dir, 'lore', 'research.json');
  const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  delete packet[0].draft; // the creator accepted "knot", and edited it
  packet[0].text += ' Edited.';
  fs.writeFileSync(packetPath, JSON.stringify(packet));
  const f = fakeFetch(() => { throw new Error('no model calls'); });
  assert.equal(await main(['apply', dir], { fetch: f.fn, log: q.log }), 0);
  const after = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  assert.deepEqual(after.map((e) => [e.id, !!e.draft]), [['knot', false], ['ridge', true]], 'an accepted draft is not written again');
  assert.match(after[0].text, /Edited\.$/);
  assert.equal(f.calls.model.length + f.calls.wiki.length, 0);
  const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.equal(world.timeline.filter((ev) => ev.draft).length, 1, 'old timeline drafts replaced, not doubled');
  assert.equal(world.lore.filter((x) => x === 'research').length, 1);
});

test('research leaves the author\'s lore alone: topics that have it are skipped, and edited, accepted or deleted drafts are never written over', async () => {
  const { main } = await cli();
  const dir = copyWorld();
  const q = quiet();
  await main(['plan', dir, ...PLAN], { fetch: fakeFetch(goodModel).fn, log: q.log });
  let job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  const t = (id) => job.topics.find((x) => x.id === id);
  // The holdout's own lore: the junction, Ridge, the world and Ferris have it; the convoy and Pike don't.
  assert.deepEqual([t('region:junction').status, t('region:junction').skip], ['has lore', true]);
  assert.match(t('region:junction').note, /already has lore: /);
  assert.deepEqual(['world', 'character:ferris', 'region:ridge-town'].map((id) => t(id).status), ['has lore', 'has lore', 'has lore']);
  assert.deepEqual(['group:convoy', 'character:pike'].map((id) => t(id).status), ['todo', 'todo']);
  assert.match(q.lines.join('\n'), /Highway junction \(the region Highway junction\): skipped, already has lore/);
  // Lore written after the plan counts too: un-skipping without "force" still leaves it alone.
  job.topics.forEach((x) => { x.skip = x.id !== 'region:junction'; x.status = 'todo'; });
  fs.writeFileSync(path.join(dir, 'research.json'), JSON.stringify(job));
  const f = fakeFetch(goodModel);
  await main(['run', dir], { fetch: f.fn, log: q.log });
  job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  assert.equal(t('region:junction').status, 'has lore');
  assert.equal(f.calls.model.length + f.calls.wiki.length, 0, 'no research for it');
  // Forced, it is researched; then the author edits one draft, deletes another, and research applies again.
  trim(dir);
  await main(['run', dir], { fetch: fakeFetch(goodModel).fn, log: q.log });
  const packetPath = path.join(dir, 'lore', 'research.json');
  let packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  assert.deepEqual(packet.map((e) => e.id), ['knot', 'ridge']);
  packet[0].text = 'The Knot, in my own words: a tangle of ramps under the overpass, and the best place in the county to stop a car.';
  packet = [packet[0]];
  fs.writeFileSync(packetPath, JSON.stringify(packet));
  const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  world.timeline.find((ev) => ev.draft).text = 'A National Guard column rolls through the junction, as the author tells it.';
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(world));
  const q2 = quiet();
  assert.equal(await main(['apply', dir], { fetch: fakeFetch(goodModel).fn, log: q2.log }), 0);
  const after = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  assert.deepEqual(after.map((e) => [e.id, !!e.draft]), [['knot', true]], 'the edited draft stays as edited, and the deleted one stays deleted');
  assert.match(after[0].text, /in my own words/);
  const w2 = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.deepEqual(w2.timeline.filter((ev) => /^research-/.test(ev.id)).map((ev) => ev.text), ['A National Guard column rolls through the junction, as the author tells it.']);
  assert.match(q2.lines.join('\n'), /3 drafts you accepted, edited or deleted not written again/);
  // Applying again changes nothing.
  await main(['apply', dir], { fetch: fakeFetch(goodModel).fn, log: q2.log });
  assert.deepEqual(JSON.parse(fs.readFileSync(packetPath, 'utf8')), after);
});

test('asking the model first skips a topic it already knows', async () => {
  const { main } = await cli();
  const dir = copyWorld();
  const q = quiet();
  await main(['plan', dir, ...PLAN, '--check-known'], { fetch: fakeFetch(goodModel).fn, log: q.log });
  trim(dir);
  const f = fakeFetch((call) => (call.user.includes('say what you know about Highway junction')
    ? 'The Harmon County junction joins Route 9 and Interstate 40 under an overpass from 1971; truckers call it the Knot.'
    : call.user.includes('say what you know about') ? "I don't know." : goodModel(call)));
  await main(['run', dir], { fetch: f.fn, log: q.log });
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'research.json'), 'utf8'));
  assert.equal(job.topics.find((t) => t.id === 'region:junction').status, 'known');
  assert.equal(job.topics.find((t) => t.id === 'region:ridge-town').status, 'done');
  assert.ok(!f.calls.model.some((c) => topicOf(c.user) === 'Highway junction' && c.user.includes('=== SOURCE')));
});

test('an external backend needs a key from the environment and a model name; the key is never written', async () => {
  const { configure } = await cli();
  assert.throws(() => configure(loadEngine(), { backend: 'external', url: 'https://openrouter.ai/api/v1', model: 'x/y' }, {}), /ENSEMBLE_API_KEY/);
  assert.throws(() => configure(loadEngine(), { backend: 'external', url: 'https://api.example.com/v1' }, { ENSEMBLE_API_KEY: 'k' }), /--model/);
  const E = loadEngine();
  assert.equal(configure(E, { backend: 'external', url: 'https://openrouter.ai/api/v1', model: 'x/y' }, { ENSEMBLE_API_KEY: 'k' }), 'external');
  assert.deepEqual([E.settings.routing.worldbuild, E.settings.backends.external.preset], ['external', 'openrouter']);
  assert.equal(configure(loadEngine(), {}, {}), 'local', 'KoboldCpp on this computer by default');
});

// ---------- the checks ----------

function ctxFor() {
  const E = loadEngine();
  const loaded = readWorld('zombie-holdout', E);
  const job = E.Research.newJob(loaded, { calendar: { date: '2026-03-14' } });
  return { E, ctx: E.Research.context(loaded, job) };
}
const topic = (E, ctx, id) => ctx.job.topics.find((t) => t.id === id);
const entry = (more) => Object.assign({ title: 'The Knot', about: 'region', ref: 'junction', keywords: [], text: JUNCTION_ENTRY.text }, more);

test('the checks: copied runs and long entries are sent back; short, unconnected and secret-leaking ones dropped; refs resolved by name', () => {
  const { E, ctx } = ctxFor();
  const R = E.Research;
  const t = topic(E, ctx, 'region:junction');
  const src = { title: 'Page', url: 'https://example.org/p' };
  const runs = R.runs('one two three four five six seven eight nine ten', 8);
  const check = (entries) => R.check({ entries }, ctx, t, src, runs);
  assert.match(check([entry({ text: 'As they say, one two three four five six seven eight, and more words follow here to make it long enough for the check to read it all.' })]).error, /copies the source word for word \("one two three four five six seven eight…"\)/);
  assert.match(check([entry({ text: 'word '.repeat(111) })]).error, /is 111 words; keep each entry to 40–80 words/);
  assert.deepEqual([...check([entry({ text: 'Too short to be useful.' })].concat()).warnings], ['too short, dropped: The Knot']);
  const byName = check([entry({ ref: 'Highway junction' })]);
  assert.equal(byName.entries[0].ref, 'junction');
  const unknown = check([entry({ about: 'location', ref: 'the weigh station' })]);
  assert.deepEqual([unknown.entries[0].level, unknown.entries[0].ref], ['topic', undefined]);
  assert.match(unknown.warnings[0], /no location "the weigh station" in this world; kept as a topic/);
  assert.deepEqual([...check([entry({ title: 'Locusts', text: 'Locust swarms form when grasshoppers crowd together, changing colour and behaviour, and a single swarm can cover hundreds of square kilometres and eat as much as millions of people in a day, which is why farmers fear them more than drought.' })]).warnings], ['not about this world, dropped: Locusts']);
  assert.deepEqual(plain(check([entry()]).entries[0].sources), [{ title: 'Page', url: 'https://example.org/p' }]);
});

test("drafts keep only the topics the world knows, up to four, and the prompt offers the world's list and keeps lore broad", () => {
  const { E, ctx } = ctxFor();
  const R = E.Research;
  const t = topic(E, ctx, 'region:junction');
  const out = R.check({ entries: [entry({ topics: ['Travel', 'astrology', 'scavenging', 'crime', 'military', 'law', 'travel'] })] }, ctx, t, {}, new Set());
  assert.deepEqual([...out.entries[0].topics], ['travel', 'scavenging', 'crime', 'military']);
  assert.equal(R.check({ entries: [entry({ topics: ['astrology'] })] }, ctx, t, {}, new Set()).entries[0].topics, undefined);
  const user = E.Prompts.research(ctx, t, { title: 'Page' }, 'Some text.', 0, 1);
  assert.match(user, /"topics": up to 4 of school, work, .*, scavenging:/);
  assert.match(user, /Keep to the broad picture/);
});

test('later events are placed by the calendar (or kept as suggestions); secrets resolve to people', () => {
  const { E, ctx } = ctxFor();
  const R = E.Research;
  assert.equal(R.dayOf(ctx, '2026-03-14'), 23, 'the start');
  assert.equal(R.dayOf(ctx, '2026-04-01'), 41);
  assert.equal(R.dayOf(ctx, 'spring'), null);
  ctx.job.calendar = null;
  assert.equal(R.dayOf(ctx, '2026-04-01'), null, 'no calendar, no day');
  const out = R.check({ entries: [], later: [{ date: '2026-04-01', text: 'Rain.', scope: 'world' }], secrets: [{ who: 'Dex Coleman', text: 'hides a wound' }] }, ctx, topic(E, ctx, 'region:junction'), {}, new Set());
  assert.deepEqual(plain(out.events), [{ text: 'Rain.', scope: 'world', region: null, date: '2026-04-01', day: null }]);
  assert.deepEqual(plain(out.secrets), [{ who: 'coleman', text: 'hides a wound' }]);
});

test('sources: wiki addresses, Fandom pages without plain-text extracts, web pages, and text cut at the references', async () => {
  const E = loadEngine();
  const R = E.Research;
  assert.equal(R.apiOf('https://en.wikipedia.org'), 'https://en.wikipedia.org/w/api.php');
  assert.equal(R.apiOf('https://lotr.fandom.com/wiki'), 'https://lotr.fandom.com/api.php');
  assert.equal(R.apiOf('https://lotr.fandom.com/api.php'), 'https://lotr.fandom.com/api.php');
  const fandom = async (url) => {
    const p = new URL(url).searchParams;
    if (p.get('action') === 'parse') return ok({ parse: { text: '<div><p>Bree is a village<sup>[1]</sup> east of the Shire.</p><table class="infobox"><tr><td>junk</td></tr></table><script>x()</script><p>Its inn is &quot;The Prancing Pony&quot;&nbsp;&amp; more.</p></div>' } });
    return ok({ query: { pages: [{ title: 'Bree' }] } });
  };
  const page = await R.wikiPage(fandom, 'https://lotr.fandom.com/api.php', 'Bree');
  assert.equal(page.text, 'Bree is a village east of the Shire.\nIts inn is "The Prancing Pony" & more.');
  assert.equal(page.url, 'https://lotr.fandom.com/wiki/Bree');
  const web = await R.urlPage(async () => ({ ok: true, text: async () => '<html><title>Town &amp; Country</title><body><nav>menu</nav><h1>Hello</h1><p>World.</p></body></html>' }), 'https://example.org/x');
  assert.deepEqual([web.title, web.text], ['Town & Country', 'Hello\nWorld.']);
  assert.equal(R.cleanText('Intro.[2]\n\n== History ==\nOld.\n\n== See also ==\nOther'), 'Intro.\n\n== History ==\nOld.');
  const chunks = R.chunks('a'.repeat(50) + '\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50), 110, 4);
  assert.deepEqual([...chunks].map((c) => c.length), [102, 50]);
  assert.equal(R.chunks('x. '.repeat(100), 30, 2).length, 2, 'at most max chunks');
});

test('"already known" needs most of the source\'s opening names in the model\'s answer', () => {
  const E = loadEngine();
  const src = 'The Harmon County junction joins Route 9 to Interstate 40 beneath an overpass built in 1971.';
  assert.ok(E.Research.knownCheck('It joins Route 9 and Interstate 40 in Harmon County, under a 1971 overpass.', src));
  assert.ok(!E.Research.knownCheck('It is a highway junction somewhere in the county.', src));
  assert.ok(!E.Research.knownCheck('anything', 'a page with no names at all in its opening words'), 'too few names to judge: research it');
});
