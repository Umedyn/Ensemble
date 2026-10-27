// Add-on lore packs (task 5-7): a folder that adds lore entries (and
// optionally timeline events and topics) to one world without changing it,
// so a modder can contribute "Tokyo school life" without making a world.
// Packs live in the shared packs/ folder (packs/index.json lists them, like
// library/), name the world they extend, and are turned on in the start
// picker. At New game the chosen ones are layered into the game's scenario
// after the world's own lore, in the order chosen, with ids namespaced
// "<pack>:<id>"; the save keeps them with the scenario. A pack only adds:
// replacing a world entry needs the world's "lorePacks": {"replace": true}.
// DOM-free.
(function (root) {
  const E = root.Ensemble;
  const PK = (E.Packs = {});
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  PK.FIELDS = ['format', 'id', 'title', 'world', 'version', 'credit', 'license', 'summary', 'lore', 'timeline', 'loreTopics'];
  PK.ID = /^[a-z0-9][a-z0-9_-]*$/;
  PK.ns = (pack, id) => `${pack}:${id}`;

  // A pack folder's files ({ "pack.json", "lore/<id>.json" }) → a pack:
  // { folder, id, title, world, version, credit, license, summary, entries,
  // timeline, loreTopics, problems }. Entries and events keep the ids their
  // author wrote; they are namespaced when the pack is applied.
  PK.read = function (folder, files) {
    const p = files && files['pack.json'];
    const pack = { folder, id: folder, title: folder, world: null, entries: [], timeline: [], loreTopics: null, problems: [] };
    if (!isObj(p)) { pack.problems.push(`pack "${folder}": no pack.json`); return pack; }
    const where = `pack "${p.id || folder}"`;
    const req = (cond, msg) => { if (!cond) pack.problems.push(`${where}: ${msg}`); };
    req(typeof p.id === 'string' && PK.ID.test(p.id), '"id" must be lowercase letters, digits, - or _');
    req(typeof p.title === 'string' && p.title.trim() && p.title.length <= 80, '"title" must be text of at most 80 characters');
    req(typeof p.world === 'string' && p.world.trim(), '"world" must be the id of the world it adds to');
    req(p.version == null || (typeof p.version === 'string' && p.version.length <= 20), '"version" must be short text, like "1.0"');
    req(typeof p.credit === 'string' && p.credit.trim() && p.credit.length <= 200, '"credit" must say who made it (at most 200 characters)');
    req(typeof p.license === 'string' && p.license.trim() && p.license.length <= 80, '"license" must name the license it is shared under');
    req(p.summary == null || (typeof p.summary === 'string' && p.summary.length <= 300), '"summary" must be text of at most 300 characters');
    req(p.timeline == null || Array.isArray(p.timeline), '"timeline" must be a list of events');
    Object.keys(p).filter((k) => !PK.FIELDS.includes(k)).forEach((k) => req(false, `unknown field "${k}"`));
    const { entries, problems } = E.Lore.resolve(p.lore, E.Scenario.loreFiles(files));
    problems.forEach((m) => pack.problems.push(`${where}: ${m}`));
    return Object.assign(pack, {
      id: typeof p.id === 'string' ? p.id : folder, title: typeof p.title === 'string' ? p.title : folder, world: p.world || null,
      version: p.version || '', credit: p.credit || '', license: p.license || '', summary: p.summary || '',
      entries, timeline: Array.isArray(p.timeline) ? p.timeline : [], loreTopics: p.loreTopics == null ? null : p.loreTopics,
    });
  };

  // A pack against the world it names (a loaded world, Scenario.prepareWorld)
  // → { problems, warnings }, in plain words. The same checks as the world's
  // own lore and timeline: shapes, topics, refs that exist in that world, no
  // one's secret, and replacing only where the world allows it.
  PK.check = function (pack, loaded) {
    const problems = pack.problems.slice();
    const warnings = [];
    const where = `pack "${pack.id}"`;
    const b = loaded.bundle;
    const w = b.world;
    if (pack.world !== loaded.id) {
      problems.push(`${where} is for the world "${pack.world}", not "${loaded.title}" (${loaded.id})`);
      return { problems, warnings };
    }
    const starts = Object.values(b.starts || {});
    const topics = new Set(E.Lore.topicIds(w));
    starts.forEach((s) => E.Lore.topicIds(s).forEach((t) => topics.add(t)));
    Object.keys(isObj(pack.loreTopics) ? pack.loreTopics : {}).forEach((t) => topics.add(t));
    problems.push(...E.Lore.topicProblems(pack.loreTopics, where));
    problems.push(...E.Lore.problems(pack.entries, where, topics));
    const ofAll = (k) => new Set([].concat(w[k] || [], ...starts.map((s) => s[k] || [])).map((x) => x && x.id));
    const known = { region: ofAll('regions'), location: ofAll('locations'), character: new Set(w.characters || []) };
    const people = Object.values(b.characters || {}).concat(...starts.map((s) => (s.cast || []).filter(isObj).map((c) => Object.assign({}, (b.characters || {})[c.id], c))));
    const own = new Set((Array.isArray(w.lore) ? w.lore : []).filter(isObj).map((e) => e.id));
    const word = { region: 'region', location: 'room', character: 'person' };
    pack.entries.filter(isObj).forEach((e) => {
      const at = `${where}: lore "${PK.ns(pack.id, e.id)}"`;
      if (E.Lore.REF_LEVELS.includes(e.level) && typeof e.ref === 'string' && !known[e.level].has(e.ref)) {
        // Generated starts and sites make rooms of their own (as for world lore).
        if (e.level === 'location') warnings.push(`${at} is about "${e.ref}", a room no start of "${loaded.title}" has (it comes up only by its keywords until one does)`);
        else problems.push(`${at} is about the ${word[e.level]} "${e.ref}", which "${loaded.title}" doesn't have`);
      }
      if (e.replaces != null) {
        if (!(isObj(w.lorePacks) && w.lorePacks.replace === true)) problems.push(`${at} replaces "${e.replaces}", but "${loaded.title}" doesn't let packs replace its lore (it would need "lorePacks": {"replace": true}); add an entry of your own instead`);
        else if (!own.has(e.replaces)) problems.push(`${at} replaces "${e.replaces}", which isn't one of the world's lore entries`);
      }
      const who = E.Lore.leak(e, people);
      if (who) problems.push(`${at} gives away ${who.name || who.id}'s secret (lore is public; secrets belong to characters)`);
    });
    if (pack.timeline.length) {
      const clocks = new Set();
      const addClocks = (cs) => (cs || []).forEach((c) => { if (c && c.id) { clocks.add(c.id); addClocks(c.then); } });
      addClocks(w.clocks);
      starts.forEach((s) => addClocks(s.clocks));
      const first = starts[0] && starts[0].start;
      const refs = {
        regions: known.region, groups: ofAll('factions'), clocks, characters: known.character, effectKeys: Object.keys(E.Engine.EFFECTS),
        start: first ? E.Timeline.at({ day: first.day ?? 1, hour: first.hour ?? 8 }) : null,
      };
      problems.push(...E.Timeline.problems(pack.timeline, where, refs, warnings));
      pack.timeline.filter((ev) => isObj(ev) && ev.visibility !== 'hidden').forEach((ev) => {
        const who = E.Lore.leak({ text: ev.text }, people);
        if (who) problems.push(`${where}: timeline "${PK.ns(pack.id, ev.id)}" gives away ${who.name || who.id}'s secret`);
      });
    }
    return { problems, warnings };
  };

  // The packs found for a world, checked: [{ pack, problems, warnings }].
  PK.forWorld = (packs, loaded) => (packs || []).filter((p) => p.world === loaded.id).map((pack) => Object.assign({ pack }, PK.check(pack, loaded)));

  // A composed scenario with packs layered on, in order → a new scenario.
  // Ids become "<pack>:<id>" (a pack's own "known" preconditions follow);
  // an entry that replaces one of the world's takes its place.
  PK.apply = function (sc, packs) {
    const out = E.clone(sc);
    if (!packs || !packs.length) return out;
    out.lore = Array.isArray(out.lore) ? out.lore : [];
    out.packs = (out.packs || []).slice();
    packs.forEach((pk) => {
      const ns = (id) => PK.ns(pk.id, id);
      pk.entries.filter(isObj).forEach((e) => {
        const n = Object.assign(E.clone(e), { id: ns(e.id), pack: pk.id });
        if (e.replaces != null) out.lore = out.lore.filter((x) => !(x && x.id === e.replaces));
        out.lore.push(n);
      });
      if (pk.timeline.length) {
        const mine = new Set(pk.timeline.filter(isObj).map((ev) => ev.id));
        const fix = (p) => {
          if (!isObj(p)) return p;
          if (typeof p.known === 'string' && mine.has(p.known)) return Object.assign({}, p, { known: ns(p.known) });
          if (isObj(p.not)) return Object.assign({}, p, { not: fix(p.not) });
          return p;
        };
        out.timeline = (Array.isArray(out.timeline) ? out.timeline : []).concat(pk.timeline.filter(isObj).map((ev) => {
          const n = Object.assign(E.clone(ev), { id: ns(ev.id), pack: pk.id });
          if (Array.isArray(n.preconditions)) n.preconditions = n.preconditions.map(fix);
          return n;
        }));
      }
      if (isObj(pk.loreTopics)) {
        out.loreTopics = Object.assign({}, out.loreTopics);
        Object.entries(pk.loreTopics).forEach(([t, ws]) => { out.loreTopics[t] = [...new Set((out.loreTopics[t] || []).concat(ws || []))]; });
      }
      out.packs.push(Object.assign({ id: pk.id, title: pk.title }, pk.version ? { version: pk.version } : {}, pk.credit ? { credit: pk.credit } : {}));
    });
    return out;
  };
  // A pack's title in a scenario (for Debug's "why").
  PK.title = (sc, id) => ((sc && sc.packs || []).find((p) => p.id === id) || {}).title || id;

  // ---------- loading ----------
  // The files a pack.json needs: its lore/ files.
  PK.neededFiles = (packJson) => (isObj(packJson) && Array.isArray(packJson.lore) ? packJson.lore : []).filter((x) => typeof x === 'string').map((id) => `lore/${id}.json`);
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }
  // packs/index.json: { "packs": ["folder", …] } (or [{folder}]). No index,
  // no packs. → [pack], with unreadable ones as packs carrying a problem.
  PK.listServer = async function () {
    let idx;
    try { idx = await getJSON('packs/index.json'); } catch (e) { return []; }
    const folders = (idx.packs || idx || []).map((x) => (typeof x === 'string' ? x : x && x.folder)).filter(Boolean);
    return Promise.all(folders.map(async (folder) => {
      const base = `packs/${folder}/`;
      const files = {};
      try { files['pack.json'] = await getJSON(base + 'pack.json'); } catch (e) { return PK.read(folder, {}); }
      await Promise.all(PK.neededFiles(files['pack.json']).map(async (p) => { try { files[p] = await getJSON(base + p); } catch (e) { /* named by read */ } }));
      return PK.read(folder, files);
    }));
  };
  // A picked folder (FileList): every pack.json in it, with its lore files.
  PK.readFolderFiles = async function (fileList) {
    const byPath = new Map(Array.from(fileList).map((f) => [f.webkitRelativePath || f.name, f]));
    const out = [];
    for (const path of byPath.keys()) {
      if (!/(^|\/)pack\.json$/.test(path)) continue;
      const dir = path.slice(0, path.length - 'pack.json'.length);
      const folder = dir.replace(/\/$/, '').split('/').pop() || 'pack';
      const files = {};
      try {
        files['pack.json'] = JSON.parse(await byPath.get(path).text());
        for (const p of PK.neededFiles(files['pack.json'])) if (byPath.has(dir + p)) files[p] = JSON.parse(await byPath.get(dir + p).text());
      } catch (err) { out.push(Object.assign(PK.read(folder, {}), { problems: [`pack "${folder}": ${err.message}`] })); continue; }
      out.push(PK.read(folder, files));
    }
    return out;
  };
  // A pack zip (the creator's own export, or any zip of a pack folder):
  // entries under one top folder or at the root → { folder, files }.
  PK.fromZip = function (entries, fallbackFolder) {
    const list = [...entries].filter((e) => !e.name.endsWith('/'));
    let prefix = '';
    if (!list.some((e) => e.name === 'pack.json')) {
      const top = list.find((e) => /^[^/]+\/pack\.json$/.test(e.name));
      if (!top) throw new Error('No pack.json in that zip.');
      prefix = top.name.split('/')[0] + '/';
    }
    const files = {};
    list.forEach((e) => {
      if (!e.name.startsWith(prefix) || !/\.json$/i.test(e.name)) return;
      const rel = e.name.slice(prefix.length);
      try { files[rel] = JSON.parse(E.Zip.text(e.data)); } catch (err) { throw new Error(`${rel} is not valid JSON: ${err.message}`); }
    });
    const folder = prefix ? prefix.slice(0, -1) : (files['pack.json'] && files['pack.json'].id) || fallbackFolder || 'pack';
    return { folder, files };
  };
})(typeof window !== 'undefined' ? window : globalThis);
