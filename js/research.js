// The research helper (ROADMAP Phase 5): turns wiki pages and other sources
// into draft lore entries and timeline events at build time, never during
// play. What to research comes from the world itself (a topic list the
// creator trims), never from following links. Each source is read a chunk at
// a time; the model drafts, and the engine checks every draft (rule 1): its
// own words (no copied runs), small entries, connected to the world, no
// secrets, as of the start (later things become dated timeline drafts). The
// job is plain JSON so a run resumes where it stopped. DOM-free; the command
// is tools/research.mjs, which supplies fetch and saves the files.
(function (root) {
  const E = root.Ensemble;
  const R = (E.Research = {});
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  R.UA = 'Ensemble-research/1.0 (local world-building tool)';
  R.WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
  // words: what a good entry has; longer ones are sent back to be split.
  R.LIMITS = { minWords: 15, maxWords: 110, perTopic: 4, worldPerTopic: 1, chunks: 4, copyRun: 8, keywords: 12 };

  // ---------- the job ----------
  // Topics from the world: the world itself, its regions, its groups and its
  // named characters. The creator sets skip, or a page, url or pasted text,
  // before running. With the world's files, a topic that already has lore of
  // the author's (R.ownedLore) starts skipped.
  R.topics = function (loaded, files) {
    const w = loaded.bundle.world;
    const topic = (id, name, level, ref, about) => ({ id, name, level, ref, about, query: name, page: null, url: null, text: null, skip: false, status: 'todo' });
    const out = [topic('world', w.title, 'world', null, 'the world as a whole')];
    // A region imported from open data (task 4-5) brings its Wikipedia page.
    (w.regions || []).forEach((r) => out.push(Object.assign(topic(`region:${r.id}`, r.name, 'region', r.id, `the region ${r.name}`), r.wiki && r.wiki.title ? { page: r.wiki.title } : {})));
    (w.factions || []).forEach((f) => out.push(topic(`group:${f.id}`, f.name, 'topic', null, `the group ${f.name}`)));
    Object.entries(loaded.bundle.characters || {}).forEach(([id, c]) => out.push(topic(`character:${id}`, c.name || id, 'character', id, `${c.name || id}, ${c.role || 'a character'}`)));
    const owned = files ? R.ownedLore(files) : null;
    if (owned) out.forEach((t) => { const has = owned.get(R.loreKey(t)); if (has) Object.assign(t, { skip: true, status: 'has lore', note: `already has lore: ${has.join(', ')}` }); });
    return out;
  };
  // Lore the author owns, so research leaves it alone: every entry that isn't
  // a draft waiting for review, by what it is about ("world", "region:<id>",
  // "character:<id>"). → Map(key → [titles])
  R.loreKey = (t) => (t.level === 'world' ? 'world' : (t.level === 'region' || t.level === 'character') && t.ref ? `${t.level}:${t.ref}` : null);
  R.ownedLore = function (files) {
    const out = new Map();
    E.LoreEdit.loreItems(files).forEach(({ entry: e }) => {
      if (e.draft === true) return;
      const key = R.loreKey(e);
      if (key) out.set(key, (out.get(key) || []).concat(e.title || e.id));
    });
    return out;
  };
  // opts: files (the world's raw files, lore included: topics that have lore
  // start skipped), wiki (a MediaWiki API URL or wiki address), startId, asOf (the start
  // in words, like "March 2024"), calendar ({date: "YYYY-MM-DD"}: the real
  // date of the start, so dated events can be placed), perTopic, checkKnown.
  R.newJob = function (loaded, opts) {
    const o = opts || {};
    return {
      version: 1, world: loaded.folder, wiki: o.wiki || R.WIKIPEDIA, startId: o.startId || loaded.defaultStart || null,
      asOf: o.asOf || '', calendar: isObj(o.calendar) && o.calendar.date ? { date: o.calendar.date } : null,
      perTopic: o.perTopic || R.LIMITS.perTopic, checkKnown: !!o.checkKnown,
      topics: R.topics(loaded, o.files), log: [], suggestions: { secrets: [], events: [] },
    };
  };

  // What every call shares: the world's generator header (setting, genre,
  // regions, groups), the ids drafts may point at, and the start.
  // files (optional): the world's raw files, so a topic that has gained lore
  // of the author's since the plan is skipped.
  R.context = function (loaded, job, files) {
    const sc = E.StartGen.contextScenario(loaded, (loaded.bundle.world.regions || [])[0] && loaded.bundle.world.regions[0].id);
    const st = loaded.bundle.starts[job.startId] || loaded.bundle.starts[loaded.defaultStart] || {};
    const refs = E.LoreEdit.refs(R.filesOf(loaded));
    return { loaded, job, sc, owned: files ? R.ownedLore(files) : null, header: E.Prompts.genHeader(sc, []), refs, start: { day: (st.start && st.start.day) ?? 1, hour: (st.start && st.start.hour) ?? 8 }, title: loaded.bundle.world.title };
  };
  // The raw files of a loaded world, as the creator keeps them.
  R.filesOf = function (loaded) {
    const b = loaded.bundle;
    const files = { 'world.json': b.world };
    Object.entries(b.starts || {}).forEach(([id, s]) => (files[`starts/${id}.json`] = s));
    Object.entries(b.characters || {}).forEach(([id, c]) => (files[`characters/${id}.json`] = c));
    return files;
  };

  // ---------- sources ----------
  const host = (u) => { try { return new URL(u).host; } catch (e) { return u; } };
  R.apiOf = (wiki) => (/api\.php$/.test(wiki) ? wiki : String(wiki).replace(/\/+$/, '').replace(/\/wiki$/, '') + (/wikipedia\.org/.test(wiki) ? '/w/api.php' : '/api.php'));
  R.getJSON = async function (fetchFn, url) {
    const r = await fetchFn(url, { headers: { 'User-Agent': R.UA, 'Api-User-Agent': R.UA } });
    if (!r.ok) throw new Error(`${host(url)}: HTTP ${r.status}`);
    return r.json();
  };
  const q = (params) => Object.entries(Object.assign({ format: 'json', formatversion: 2, origin: '*' }, params)).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  // The best-matching page title for a search, or null.
  R.findPage = async function (fetchFn, api, query) {
    const j = await R.getJSON(fetchFn, `${api}?${q({ action: 'query', list: 'search', srsearch: query, srlimit: 1 })}`);
    const hit = j.query && j.query.search && j.query.search[0];
    return hit ? hit.title : null;
  };
  // A page's plain text: TextExtracts where the wiki has it (Wikipedia), else
  // the parsed page's HTML with the markup stripped (Fandom and others).
  R.wikiPage = async function (fetchFn, api, title) {
    const j = await R.getJSON(fetchFn, `${api}?${q({ action: 'query', prop: 'extracts|info', explaintext: 1, inprop: 'url', redirects: 1, titles: title })}`);
    const page = j.query && j.query.pages && j.query.pages[0];
    if (!page || page.missing) return null;
    let text = page.extract;
    if (!text) {
      const p = await R.getJSON(fetchFn, `${api}?${q({ action: 'parse', page: page.title, prop: 'text', redirects: 1 })}`);
      text = R.htmlText((p.parse && p.parse.text) || '');
    }
    return { title: page.title, url: page.fullurl || api.replace(/\/(w\/)?api\.php$/, '') + '/wiki/' + encodeURIComponent(page.title.replace(/ /g, '_')), text: R.cleanText(text) };
  };
  R.urlPage = async function (fetchFn, url) {
    const r = await fetchFn(url, { headers: { 'User-Agent': R.UA } });
    if (!r.ok) throw new Error(`${host(url)}: HTTP ${r.status}`);
    const html = await r.text();
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return { title: t ? R.htmlText(t[1]).trim() : host(url), url, text: R.cleanText(R.htmlText(html)) };
  };
  // The topic's source: pasted text, a URL, a named page, or the wiki's best
  // match for the topic. null when nothing was found.
  R.source = async function (fetchFn, job, topic) {
    if (topic.text) return { title: topic.page || topic.name, url: topic.url || null, text: R.cleanText(topic.text) };
    if (topic.url) return R.urlPage(fetchFn, topic.url);
    const api = R.apiOf(job.wiki);
    const title = topic.page || (await R.findPage(fetchFn, api, topic.query || topic.name));
    return title ? R.wikiPage(fetchFn, api, title) : null;
  };

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  R.htmlText = (html) => String(html || '')
    .replace(/<(head|title|script|style|noscript|nav|header|footer|aside|figure|sup)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<table\b[^>]*class="[^"]*(infobox|navbox|metadata)[^"]*"[\s\S]*?<\/table>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));
  // Plain text ready to read: no reference marks or edit links, nothing from
  // the reference sections on, tidy spacing.
  R.cleanText = (text) => {
    let t = String(text || '').replace(/\r/g, '');
    const end = t.search(/^\s*=+\s*(See also|References|External links|Notes|Further reading|Bibliography|Sources|Citations)\s*=+\s*$/im);
    if (end > 0) t = t.slice(0, end);
    return t.replace(/\[(\d+|edit|citation needed)\]/gi, '').replace(/[ \t]+/g, ' ').replace(/ ([,.;:!?)])/g, '$1').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  // Paragraphs packed into chunks of at most maxChars (a long paragraph is
  // cut at sentences), at most `max` chunks: the start of a page matters most.
  R.chunks = function (text, maxChars, max) {
    const paras = String(text || '').split(/\n\s*\n|\n(?==)/).map((p) => p.trim()).filter(Boolean);
    const pieces = [];
    paras.forEach((p) => {
      if (p.length <= maxChars) return pieces.push(p);
      let cur = '';
      p.split(/(?<=[.!?])\s+/).forEach((s) => { if (cur && (cur + ' ' + s).length > maxChars) { pieces.push(cur); cur = ''; } cur = cur ? cur + ' ' + s : s.slice(0, maxChars); });
      if (cur) pieces.push(cur);
    });
    const out = [];
    let cur = '';
    pieces.forEach((p) => {
      if (cur && cur.length + p.length + 2 > maxChars) { out.push(cur); cur = ''; }
      cur = cur ? `${cur}\n\n${p}` : p;
    });
    if (cur) out.push(cur);
    return out.slice(0, max || R.LIMITS.chunks);
  };
  // How much source text a call may carry: about a third of the research
  // backend's context, at most 3000 tokens.
  R.chunkChars = () => {
    const b = E.LLM.backendFor('worldbuild');
    return Math.round(Math.min(3000, (b.context || 8192) * 0.33) * 3.6);
  };

  // ---------- checks ----------
  const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);
  const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  // The source's runs of n words, to spot copied text.
  R.runs = function (text, n) {
    const w = norm(text);
    const set = new Set();
    for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '));
    return set;
  };
  // The first run of n words a text shares with the source runs, or null.
  R.copied = function (text, runs, n) {
    const w = norm(text);
    for (let i = 0; i + n <= w.length; i++) { const r = w.slice(i, i + n).join(' '); if (runs.has(r)) return r; }
    return null;
  };
  // A name or id → an id of the given kind, or null.
  R.resolve = function (refs, level, value) {
    const list = { region: refs.regions, location: refs.rooms, character: refs.characters }[level];
    if (!list || value == null) return null;
    const v = String(value).trim().toLowerCase();
    const hit = list.find((x) => x.id.toLowerCase() === v || String(x.name).toLowerCase() === v)
      || list.find((x) => String(x.name).toLowerCase().includes(v) || v.includes(String(x.name).toLowerCase()));
    return hit ? hit.id : null;
  };
  // Names an entry may mention to count as part of this world.
  function worldNames(ctx, topic) {
    const r = ctx.refs;
    const names = [topic.name, ctx.title].concat(r.regions.map((x) => x.name), r.groups.map((x) => x.name), r.characters.map((x) => x.name), r.rooms.map((x) => x.name));
    // Each name's significant words too ("Halvorsen" for "Halvorsen Aerospace").
    const parts = names.flatMap((n) => String(n || '').split(/[\s,()'’-]+/).filter((p) => p.length >= 4 && /^\p{Lu}/u.test(p)));
    return [...new Set(names.concat(parts).filter(Boolean))];
  }
  const connected = (ctx, topic, e) => worldNames(ctx, topic).some((n) => E.Lore.matches(n, `${e.title} ${e.text} ${(e.keywords || []).join(' ')}`));
  // Real date → the world's day count, when the job knows the start's date.
  R.dayOf = function (ctx, date) {
    const cal = ctx.job.calendar;
    if (!cal || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const d = Date.parse(date + 'T00:00:00Z'), s = Date.parse(cal.date + 'T00:00:00Z');
    if (!Number.isFinite(d) || !Number.isFinite(s)) return null;
    return ctx.start.day + Math.round((d - s) / 86400000);
  };

  // One chunk's reply → { entries, events, secrets, warnings } or { error }
  // (which StartGen's retry loop names in the next try).
  R.check = function (raw, ctx, topic, src, runs) {
    if (!isObj(raw)) return { error: 'reply with one JSON object' };
    const L = R.LIMITS;
    const warnings = [];
    const people = Object.values(ctx.loaded.bundle.characters || {});
    const entries = [];
    for (const r of Array.isArray(raw.entries) ? raw.entries : []) {
      if (!isObj(r)) continue;
      const title = String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, E.Lore.LIMITS.title);
      const text = String(r.text || '').replace(/\s+/g, ' ').trim();
      if (!title || !text) continue;
      const n = words(text).length;
      if (n > L.maxWords) return { error: `"${title}" is ${n} words; keep each entry to 40–80 words on one topic and split a long one into several entries` };
      if (n < L.minWords) { warnings.push(`too short, dropped: ${title}`); continue; }
      const copy = R.copied(text, runs, L.copyRun);
      if (copy) return { error: `"${title}" copies the source word for word ("${copy}…"); write every entry in your own words` };
      let level = E.Lore.LEVELS.includes(r.about) ? r.about : topic.level;
      let ref = null;
      if (E.Lore.REF_LEVELS.includes(level)) {
        ref = R.resolve(ctx.refs, level, r.ref) || (level === topic.level ? topic.ref : null);
        if (!ref) { warnings.push(`"${title}": no ${level} "${r.ref}" in this world; kept as a topic`); level = 'topic'; }
      }
      const kws = [];
      [].concat(Array.isArray(r.keywords) ? r.keywords : [], words(title).length <= 3 ? [title] : []).forEach((k) => {
        const kw = String(k || '').trim().slice(0, E.Lore.LIMITS.keyword);
        if (kw && !kws.some((x) => x.toLowerCase() === kw.toLowerCase())) kws.push(kw);
      });
      const e = { title, level, text: text.slice(0, E.Lore.LIMITS.text), keywords: kws.slice(0, L.keywords) };
      if (ref) e.ref = ref;
      // Topic tags (task 5-5): only ones the world knows, up to four.
      const known = E.Lore.topicIds(ctx.loaded.bundle.world);
      const tags = [...new Set((Array.isArray(r.topics) ? r.topics : []).map((t) => String(t || '').trim().toLowerCase()).filter((t) => known.includes(t)))];
      if (tags.length) e.topics = tags.slice(0, E.Lore.LIMITS.topics);
      if (!connected(ctx, topic, e)) { warnings.push(`not about this world, dropped: ${title}`); continue; }
      const leak = E.Lore.leak(e, people);
      if (leak) { warnings.push(`gives away ${leak.name || leak.id}'s secret, dropped: ${title}`); continue; }
      if (src.url) e.sources = [{ title: src.title, url: src.url }];
      entries.push(e);
    }
    const events = [];
    for (const r of Array.isArray(raw.later) ? raw.later : []) {
      if (!isObj(r)) continue;
      const text = E.shorten(String(r.text || '').replace(/\s+/g, ' ').trim(), E.Timeline.TEXT_MAX);
      if (!text) continue;
      if (E.Lore.leak({ text }, people)) { warnings.push(`a later event gives away a secret, dropped: ${text}`); continue; }
      const scope = r.scope === 'world' ? 'world' : 'regional';
      const region = R.resolve(ctx.refs, 'region', r.region) || (scope === 'regional' ? (topic.level === 'region' ? topic.ref : null) : null);
      const day = R.dayOf(ctx, r.date);
      events.push({ text, scope, region, date: r.date || null, day });
    }
    const secrets = (Array.isArray(raw.secrets) ? raw.secrets : []).filter(isObj).map((s) => ({ who: R.resolve(ctx.refs, 'character', s.who) || String(s.who || ''), text: String(s.text || '').trim() })).filter((s) => s.text);
    return { entries, events, secrets, warnings };
  };

  // "Does the model already know this?": the source's opening names and
  // numbers, and how many of them the model's own answer has.
  const COMMON = new Set('The A An In On At It He She They This That These Those His Her Its Their There When Where While After Before During From For With And But Or As If Of By To Is Was Are Were Be Been Since Until Although However Also Its'.split(' '));
  R.knownCheck = function (answer, sourceText) {
    const opening = words(sourceText).slice(0, 80).join(' ');
    const names = [...new Set((opening.match(/\b(\p{Lu}[\p{L}'’-]{2,}|\d{3,4})\b/gu) || []).filter((w) => !COMMON.has(w)))];
    if (names.length < 3) return false;
    const hits = names.filter((n) => E.Lore.matches(n, answer)).length;
    return hits / names.length >= 0.7;
  };

  // ---------- running ----------
  // One topic: find its source, optionally ask the model what it knows, then
  // each chunk through the model and the checks. Saves after every chunk via
  // deps.save, so a stopped run resumes at the next chunk.
  R.runTopic = async function (ctx, topic, deps) {
    const job = ctx.job;
    const say = (m) => deps.onProgress && deps.onProgress(m);
    if (!topic.source) {
      say(`${topic.name}: finding a source…`);
      const src = await R.source(deps.fetch, job, topic);
      if (!src || !src.text) { topic.status = 'no source'; deps.save(); return; }
      topic.source = { title: src.title, url: src.url };
      topic.chunks = R.chunks(src.text, R.chunkChars(), R.LIMITS.chunks);
      topic.done = 0;
      topic.entries = []; topic.events = [];
      deps.save();
    }
    if (job.checkKnown && topic.done === 0 && !topic.knownAsked) {
      say(`${topic.name}: asking the model what it already knows…`);
      const answer = await E.LLM.chat({ kind: `worldbuild (research: known ${topic.name})`, system: ctx.header, user: E.Prompts.researchKnown(ctx, topic), maxTokens: 200, temperature: 0.3 });
      topic.knownAsked = true;
      if (R.knownCheck(answer, topic.chunks.join('\n\n'))) { topic.status = 'known'; deps.save(); return; }
    }
    const src = { title: topic.source.title, url: topic.source.url };
    for (let i = topic.done; i < topic.chunks.length; i++) {
      say(`${topic.name}: reading part ${i + 1} of ${topic.chunks.length}…`);
      const runs = R.runs(topic.chunks[i], R.LIMITS.copyRun);
      const out = await E.StartGen.attempt(ctx, `worldbuild (research: ${topic.name})`, E.Prompts.research(ctx, topic, src, topic.chunks[i], i, topic.chunks.length), 1100, (raw) => R.check(raw, ctx, topic, src, runs));
      out.warnings.forEach((w) => job.log.push({ step: topic.name, warning: w }));
      topic.entries = topic.entries.concat(out.entries);
      out.events.forEach((ev) => (ev.day != null ? topic.events.push(ev) : job.suggestions.events.push(Object.assign({ topic: topic.name }, ev))));
      out.secrets.forEach((s) => job.suggestions.secrets.push(Object.assign({ topic: topic.name }, s)));
      topic.done = i + 1;
      deps.save();
    }
    // A few entries per topic, and at most one about the world as a whole.
    let world = 0;
    topic.entries = topic.entries.filter((e) => (e.level === 'world' ? ++world <= R.LIMITS.worldPerTopic : true)).slice(0, job.perTopic || R.LIMITS.perTopic);
    topic.status = 'done';
    deps.save();
  };
  // Every topic not done or skipped. A topic that fails is marked and the run
  // goes on; running again retries it. One whose subject has lore of the
  // author's is left alone (checked each run), unless it says "force": true.
  R.run = async function (ctx, deps) {
    for (const topic of ctx.job.topics) {
      if (topic.skip || ['done', 'known', 'no source'].includes(topic.status)) continue;
      const has = !topic.force && ctx.owned && ctx.owned.get(R.loreKey(topic));
      if (has) {
        Object.assign(topic, { status: 'has lore', note: `already has lore: ${has.join(', ')}` });
        deps.save();
        if (deps.onProgress) deps.onProgress(`${topic.name}: already has lore, left alone`);
        continue;
      }
      try {
        topic.status = 'running';
        await R.runTopic(ctx, topic, deps);
        delete topic.error;
      } catch (err) {
        topic.status = 'failed';
        topic.error = String(err.message || err);
        deps.save();
        if (deps.onProgress) deps.onProgress(`${topic.name}: failed (${topic.error})`);
      }
    }
    return ctx.job;
  };

  // ---------- output ----------
  // The job's drafts into the world's files: lore in lore/research.json (a
  // packet, listed in world.json) and dated events in world.json's timeline,
  // all with "draft": true until accepted in the creator. Research never
  // overwrites the author: apply remembers what it wrote (job.written), and
  // only a draft still exactly as written is written again. Anything else is
  // the author's (accepted, edited, or not from research) and stays as it is,
  // and what research wrote that the author accepted, edited or deleted isn't
  // written again. An older job without job.written replaces every draft, as
  // before, but still skips what matches an accepted entry's title and ref.
  R.PACKET = 'research';
  const canon = (x) => JSON.stringify(Object.keys(x).filter((k) => k !== 'id' && k !== 'draft' && k !== 'wroteAs').sort().reduce((o, k) => ((o[k] = x[k]), o), {}));
  const same = (t) => String(t || '').trim().toLowerCase();
  R.apply = function (files, job) {
    const w = files['world.json'];
    const path = `lore/${R.PACKET}.json`;
    const before = job.written || null;
    const written = { lore: {}, events: {} };
    const done = job.topics.filter((t) => t.status === 'done');
    // Lore.
    const packet = (Array.isArray(files[path]) ? files[path] : []).filter(isObj);
    const oursLore = (e) => e.draft === true && (!before || (before.lore || {})[e.id] === canon(e));
    const kept = packet.filter((e) => !oursLore(e));
    const keptIds = new Set(kept.map((e) => e.id));
    const goneLore = (id) => !!before && id in (before.lore || {}) && !packet.some((e) => e.id === id);
    const settledLore = (e) => (e.wroteAs && (keptIds.has(e.wroteAs) || goneLore(e.wroteAs)))
      || kept.some((k) => !k.draft && same(k.title) === same(e.title) && (k.ref ?? null) === (e.ref ?? null));
    const taken = E.LoreEdit.loreItems(files).filter((x) => x.file !== path).map((x) => x.entry.id).concat([...keptIds]);
    const fresh = [];
    let settled = 0;
    done.forEach((t) => (t.entries || []).forEach((e) => {
      if (settledLore(e)) {
        // Remembered, so it stays settled (a deleted one stays deleted) next time.
        if (before && e.wroteAs && e.wroteAs in (before.lore || {})) written.lore[e.wroteAs] = before.lore[e.wroteAs];
        settled++;
        return;
      }
      const { wroteAs, ...body } = e;
      const id = wroteAs && !taken.includes(wroteAs) ? wroteAs : E.MapEdit.slug(e.title, taken);
      taken.push(id);
      const out = Object.assign({ id }, body, { draft: true });
      e.wroteAs = id;
      written.lore[id] = canon(out);
      fresh.push(out);
    }));
    files[path] = kept.concat(fresh);
    w.lore = Array.isArray(w.lore) ? w.lore : [];
    if (!w.lore.includes(R.PACKET)) w.lore.push(R.PACKET);
    // Timeline events, the same way.
    const timeline = Array.isArray(w.timeline) ? w.timeline : [];
    const oursEvent = (ev) => ev.draft === true && /^research-/.test(ev.id) && (!before || (before.events || {})[ev.id] === canon(ev));
    const tl = timeline.filter((ev) => !oursEvent(ev));
    const tlIds = new Set(tl.map((ev) => ev.id));
    const goneEvent = (id) => !!before && id in (before.events || {}) && !timeline.some((ev) => ev.id === id);
    const settledEvent = (ev) => (ev.wroteAs && (tlIds.has(ev.wroteAs) || goneEvent(ev.wroteAs))) || tl.some((x) => !x.draft && same(x.text) === same(ev.text));
    const evTaken = [...tlIds];
    const start = E.LoreEdit.startHours(files, job.startId);
    let events = 0;
    done.forEach((t) => (t.events || []).forEach((ev) => {
      // Only what comes after the start: earlier things are lore.
      if (ev.day == null || ev.day * 24 + 9 < start) return;
      if (settledEvent(ev)) {
        if (before && ev.wroteAs && ev.wroteAs in (before.events || {})) written.events[ev.wroteAs] = before.events[ev.wroteAs];
        settled++;
        return;
      }
      const id = ev.wroteAs && !evTaken.includes(ev.wroteAs) ? ev.wroteAs : E.MapEdit.slug(`research ${ev.text.split(/\s+/).slice(0, 4).join(' ')}`, evTaken);
      evTaken.push(id);
      const out = { id, when: { day: ev.day, hour: 9 }, scope: ev.scope, text: ev.text, draft: true };
      if (ev.region) out.region = ev.region;
      else if (ev.scope === 'regional') out.scope = 'world';
      ev.wroteAs = id;
      written.events[id] = canon(out);
      tl.push(out);
      events++;
    }));
    if (tl.length) w.timeline = tl;
    job.written = written;
    return { entries: fresh.length, events, kept: kept.length, settled };
  };
})(typeof window !== 'undefined' ? window : globalThis);
