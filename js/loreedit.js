// Lore and timeline editing for the creator (task 5-3), with no DOM so Node
// tests can check it. "files" is the creator's working copy ({ path: JSON }):
// lore lives inline in world.json and starts, or in lore/ files (one entry or
// a packet); timeline events live in world.json and starts.
(function (root) {
  const E = root.Ensemble;
  const LE = (E.LoreEdit = {});
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const world = (files) => files['world.json'];
  const startIds = (files) => (world(files).starts || []).filter((id) => files[`starts/${id}.json`]);
  const startFiles = (files) => startIds(files).map((id) => [`starts/${id}.json`, files[`starts/${id}.json`]]);

  // ---------- what the world has ----------
  // Ids and names for the editors' dropdowns.
  LE.refs = function (files) {
    const w = world(files);
    const byId = (list) => { const out = []; list.forEach((x) => { if (isObj(x) && x.id && !out.some((o) => o.id === x.id)) out.push({ id: x.id, name: x.name || x.id }); }); return out; };
    const fromStarts = (k) => [].concat(w[k] || [], ...startFiles(files).map(([, s]) => s[k] || []));
    const clocks = [];
    const addClocks = (cs) => (cs || []).forEach((c) => { if (isObj(c) && c.id) { if (!clocks.some((x) => x.id === c.id)) clocks.push({ id: c.id, name: c.name || c.id }); addClocks(c.then); } });
    addClocks(w.clocks);
    startFiles(files).forEach(([, s]) => addClocks(s.clocks));
    const worldKeys = [...new Set([].concat(Object.keys(w.world || {}), ...startFiles(files).map(([, s]) => Object.keys(s.world || {}))))];
    return {
      characters: (w.characters || []).map((id) => ({ id, name: (files[`characters/${id}.json`] || {}).name || id })),
      groups: byId(fromStarts('factions')),
      regions: byId(fromStarts('regions')),
      rooms: byId(fromStarts('locations')),
      clocks,
      worldKeys,
      events: LE.events(files).map((x) => ({ id: x.ev.id, name: x.ev.text || x.ev.id })),
      starts: startIds(files).map((id) => ({ id, name: files[`starts/${id}.json`].title || id })),
    };
  };
  const taken = (list) => list.map((x) => x.id);

  // ---------- lore ----------
  // Every entry with where it is stored: [{ entry, file, index }], index null
  // for a lore file that holds a single entry.
  LE.loreItems = function (files) {
    const out = [];
    (Array.isArray(world(files).lore) ? world(files).lore : []).forEach((item, i) => {
      if (isObj(item)) return out.push({ entry: item, file: 'world.json', index: i });
      const f = files[`lore/${item}.json`];
      if (Array.isArray(f)) f.forEach((e, j) => { if (isObj(e)) out.push({ entry: e, file: `lore/${item}.json`, index: j }); });
      else if (isObj(f)) { if (f.id == null) f.id = item; out.push({ entry: f, file: `lore/${item}.json`, index: null }); }
    });
    startFiles(files).forEach(([path, s]) => (Array.isArray(s.lore) ? s.lore : []).forEach((e, i) => { if (isObj(e)) out.push({ entry: e, file: path, index: i }); }));
    return out;
  };
  // A pack's entry is found by "<pack>:<id>", as the game names it (task 5-7).
  LE.findLore = (files, id) => {
    const i = String(id || '').indexOf(':');
    if (i > 0) return LE.packItems(files, id.slice(0, i)).find((x) => x.entry.id === id.slice(i + 1)) || null;
    return LE.loreItems(files).find((x) => x.entry.id === id) || null;
  };

  // ---------- lore packs (task 5-7) ----------
  // A pack being edited sits in the working copy as packs/<id>/pack.json and
  // packs/<id>/lore/<file>.json; the world's checks and its export leave
  // packs/ out, and the pack exports on its own.
  LE.packIds = (files) => Object.keys(files).map((p) => /^packs\/([^/]+)\/pack\.json$/.exec(p)).filter(Boolean).map((m) => m[1]);
  LE.worldFiles = (files) => Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith('packs/')));
  // A pack's own files, by their path inside the pack folder.
  LE.packFiles = (files, pid) => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(`packs/${pid}/`)).map(([p, j]) => [p.slice(`packs/${pid}/`.length), j]));
  // Its entries with where they are stored, like loreItems, plus the key the
  // editor selects them by.
  LE.packItems = function (files, pid) {
    const p = files[`packs/${pid}/pack.json`];
    const out = [];
    if (!isObj(p)) return out;
    const push = (entry, file, index) => out.push({ entry, file, index, pack: pid, key: `${pid}:${entry.id}` });
    (Array.isArray(p.lore) ? p.lore : []).forEach((item, i) => {
      if (isObj(item)) return push(item, `packs/${pid}/pack.json`, i);
      const path = `packs/${pid}/lore/${item}.json`;
      const f = files[path];
      if (Array.isArray(f)) f.forEach((e, j) => { if (isObj(e)) push(e, path, j); });
      else if (isObj(f)) { if (f.id == null) f.id = item; push(f, path, null); }
    });
    return out;
  };
  // A new pack for this world, or an imported one ({ folder, files } from
  // Packs.fromZip), put in the working copy. Returns its id.
  LE.addPack = function (files, title, worldId) {
    const id = E.MapEdit.slug(title || 'new pack', LE.packIds(files));
    files[`packs/${id}/pack.json`] = { format: 1, id, title: title || 'New pack', world: worldId || world(files).id || '', version: '1.0', summary: '', credit: '', license: '', lore: [] };
    return id;
  };
  LE.importPack = function (files, z) {
    const id = (isObj(z.files['pack.json']) && z.files['pack.json'].id) || z.folder;
    LE.removePack(files, id);
    Object.entries(z.files).forEach(([rel, j]) => { files[`packs/${id}/${rel}`] = j; });
    return id;
  };
  LE.removePack = function (files, pid) {
    Object.keys(files).filter((p) => p.startsWith(`packs/${pid}/`)).forEach((p) => { delete files[p]; });
  };
  // A new entry, inline in the pack's pack.json. Returns its key.
  LE.addPackLore = function (files, pid, level, ref) {
    const p = files[`packs/${pid}/pack.json`];
    const id = E.MapEdit.slug('new entry', LE.packItems(files, pid).map((x) => x.entry.id));
    const e = { id, title: 'New entry', level: level || 'topic', keywords: [], text: 'What everyone here knows about it.' };
    if (E.Lore.REF_LEVELS.includes(e.level)) e.ref = ref;
    p.lore = (Array.isArray(p.lore) ? p.lore : []).concat([e]);
    return `${pid}:${id}`;
  };
  // The pack as the game would read it, checked against the world being
  // edited → { pack, problems, warnings }.
  LE.packCheck = function (files, folder, pid) {
    const pack = E.Packs.read(pid, LE.packFiles(files, pid));
    try {
      return Object.assign({ pack }, E.Packs.check(pack, E.Scenario.prepareWorld(folder, JSON.parse(JSON.stringify(LE.worldFiles(files))))));
    } catch (err) {
      return { pack, problems: pack.problems.concat(`pack "${pid}" can't be checked until the world loads`), warnings: [] };
    }
  };

  // Entries grouped for the list: the world, each region, room and person
  // (refs the world doesn't have are grouped as unknown), then topics.
  LE.loreGroups = function (files) {
    const refs = LE.refs(files);
    const items = LE.loreItems(files);
    const groups = [{ level: 'world', ref: null, label: 'The world', items: [] }];
    [['region', refs.regions], ['location', refs.rooms], ['character', refs.characters]].forEach(([level, list]) =>
      list.forEach((r) => groups.push({ level, ref: r.id, label: r.name, items: [] })));
    groups.push({ level: 'topic', ref: null, label: 'Topics', items: [] });
    items.forEach((it) => {
      const e = it.entry;
      const own = E.Lore.REF_LEVELS.includes(e.level);
      let g = groups.find((x) => x.level === e.level && (own ? x.ref === e.ref : x.ref === null));
      if (!g) { g = { level: e.level || 'topic', ref: e.ref || null, label: `${e.ref || '?'} (unknown ${e.level || 'level'})`, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    return groups;
  };

  // A new entry, inline in world.json. Returns its id.
  LE.addLore = function (files, level, ref) {
    const w = world(files);
    const id = E.MapEdit.slug('new entry', LE.loreItems(files).map((x) => x.entry.id));
    const e = { id, title: 'New entry', level: level || 'topic', keywords: [], text: 'What everyone here knows about it.' };
    if (E.Lore.REF_LEVELS.includes(e.level)) e.ref = ref;
    w.lore = (Array.isArray(w.lore) ? w.lore : []).concat([e]);
    return id;
  };
  // Removes an entry from wherever it is stored (a single-entry file goes,
  // with its id in world.json).
  LE.removeLore = function (files, id) {
    const it = LE.findLore(files, id);
    if (!it) return false;
    if (it.pack) {
      const p = files[`packs/${it.pack}/pack.json`];
      if (it.file.endsWith('/pack.json')) p.lore.splice(it.index, 1);
      else if (it.index != null) files[it.file].splice(it.index, 1);
      else {
        delete files[it.file];
        const fid = it.file.replace(/^.*\/lore\/|\.json$/g, '');
        p.lore = p.lore.filter((x) => x !== fid);
      }
      return true;
    }
    if (it.file === 'world.json') world(files).lore.splice(it.index, 1);
    else if (it.file.startsWith('starts/')) files[it.file].lore.splice(it.index, 1);
    else if (it.index != null) files[it.file].splice(it.index, 1);
    else {
      delete files[it.file];
      const fid = it.file.replace(/^lore\/|\.json$/g, '');
      world(files).lore = world(files).lore.filter((x) => x !== fid);
    }
    return true;
  };
  // Changing an entry's level keeps "ref" in step: dropped for world and
  // topic entries, the first fitting id for the others.
  LE.setLevel = function (files, entry, level) {
    entry.level = level;
    const refs = LE.refs(files);
    const list = { region: refs.regions, location: refs.rooms, character: refs.characters }[level];
    if (!list) delete entry.ref;
    else if (!list.some((r) => r.id === entry.ref)) entry.ref = list[0] ? list[0].id : '';
    if (level !== 'world') delete entry.alwaysOn;
  };
  // Keywords from typed text: split on commas, trimmed, no repeats (any case).
  LE.addKeywords = function (entry, text) {
    const now = Array.isArray(entry.keywords) ? entry.keywords : [];
    String(text || '').split(',').map((k) => k.trim()).filter(Boolean).forEach((k) => {
      if (!now.some((x) => x.toLowerCase() === k.toLowerCase())) now.push(k.slice(0, E.Lore.LIMITS.keyword));
    });
    entry.keywords = now;
  };
  // Topic tags (task 5-5): the built-in ones and the world's own (and any a
  // start adds), for the tag picker.
  // pid: a pack being edited (task 5-7), whose own topics count too.
  LE.topics = function (files, pid) {
    const out = E.Lore.topicIds(world(files));
    startFiles(files).forEach(([, s]) => E.Lore.topicIds(s).forEach((t) => { if (!out.includes(t)) out.push(t); }));
    const p = pid && files[`packs/${pid}/pack.json`];
    if (p) Object.keys(isObj(p.loreTopics) ? p.loreTopics : {}).forEach((t) => { if (!out.includes(t)) out.push(t); });
    return out;
  };
  // On or off; a fifth tag is refused (→ false) so the entry stays valid.
  LE.toggleTopic = function (entry, topic) {
    const now = Array.isArray(entry.topics) ? entry.topics.slice() : [];
    if (now.includes(topic)) now.splice(now.indexOf(topic), 1);
    else if (now.length >= E.Lore.LIMITS.topics) return false;
    else now.push(topic);
    if (now.length) entry.topics = now;
    else delete entry.topics;
    return true;
  };
  // A new topic of the world's own: a short lowercase tag and the words that
  // bring it up ("mining: miner, ore"), added to world.json's loreTopics. →
  // the tag, or null when the text has none.
  // pid: added to that pack's loreTopics instead (task 5-7).
  LE.addTopic = function (files, text, pid) {
    const [name, rest] = String(text || '').split(':');
    const id = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 24);
    if (!id) return null;
    const w = (pid && files[`packs/${pid}/pack.json`]) || world(files);
    w.loreTopics = isObj(w.loreTopics) ? w.loreTopics : {};
    const words = (rest || '').split(',').map((k) => k.trim().slice(0, E.Lore.LIMITS.keyword)).filter(Boolean);
    w.loreTopics[id] = [...new Set((w.loreTopics[id] || []).concat(words))].slice(0, E.Lore.LIMITS.topicWords);
    return id;
  };

  // What the game would include: the world composed with a start, the player
  // moved to a room, then Lore.select. → { picks, always, used, budget, error }.
  LE.testSelection = function (files, folder, opts) {
    const o = opts || {};
    try {
      const loaded = E.Scenario.prepareWorld(folder, JSON.parse(JSON.stringify(LE.worldFiles(files))));
      const st = loaded.starts.find((s) => s.id === o.startId) || loaded.starts[0];
      if (!st) return { error: 'The world has no start to test with.' };
      if (st.error) return { error: `That start has problems: ${st.error.split('\n- ').slice(1).join('; ') || st.error}` };
      // The packs being edited are in, when they pass their checks (task 5-7).
      const packs = LE.packIds(files).map((pid) => E.Packs.read(pid, JSON.parse(JSON.stringify(LE.packFiles(files, pid)))))
        .filter((p) => !E.Packs.check(p, loaded).problems.length);
      let sc = E.Packs.apply(st.scenario, packs);
      if (sc.player == null) sc = E.CharMaker.withPlayer(sc, E.CharMaker.sample(sc));
      const state = E.Engine.newGame(sc);
      if (o.room && state.locations[o.room]) state.characters[state.player].status.location = o.room;
      const picks = E.Lore.select(state, { action: o.action || '', scene: o.scene || '' });
      const always = E.Lore.always(sc).map((e) => ({ id: e.id, title: e.title, tokens: E.estTokens(E.Lore.line(e)) }));
      return { picks, always, used: picks.reduce((n, p) => n + p.tokens, 0), budget: E.Memory.budgets().lore, room: state.characters[state.player].status.location };
    } catch (err) {
      return { error: String(err.message || err).split('\n- ').slice(1).join('; ') || String(err.message || err) };
    }
  };

  // ---------- timeline ----------
  // Every event with where it is stored: [{ ev, file, index }].
  LE.events = function (files) {
    const out = [];
    (Array.isArray(world(files).timeline) ? world(files).timeline : []).forEach((ev, i) => { if (isObj(ev)) out.push({ ev, file: 'world.json', index: i }); });
    startFiles(files).forEach(([path, s]) => (Array.isArray(s.timeline) ? s.timeline : []).forEach((ev, i) => { if (isObj(ev)) out.push({ ev, file: path, index: i }); }));
    return out;
  };
  LE.findEvent = (files, id) => LE.events(files).find((x) => x.ev.id === id) || null;
  // The start's time in hours (default: the first start's).
  LE.startHours = function (files, startId) {
    const id = startId && files[`starts/${startId}.json`] ? startId : startIds(files)[0];
    const s = id && files[`starts/${id}.json`].start;
    return E.Timeline.at({ day: (s && s.day) ?? 1, hour: (s && s.hour) ?? 8 });
  };
  const at = (ev) => (isObj(ev.when) && Number.isFinite(ev.when.day) && Number.isFinite(ev.when.hour) ? E.Timeline.at(ev.when) : Infinity);
  // Chronological, split at the start: { past, future }.
  LE.splitEvents = function (files, startId) {
    const start = LE.startHours(files, startId);
    const all = LE.events(files).sort((a, b) => at(a.ev) - at(b.ev));
    return { past: all.filter((x) => at(x.ev) < start), future: all.filter((x) => at(x.ev) >= start) };
  };
  // A new event a day after the start (or after the latest one), in world.json.
  LE.addEvent = function (files, startId) {
    const w = world(files);
    const latest = Math.max(LE.startHours(files, startId), ...LE.events(files).map((x) => at(x.ev)).filter(Number.isFinite));
    const h = latest + 24;
    const id = E.MapEdit.slug('new event', LE.events(files).map((x) => x.ev.id));
    w.timeline = (Array.isArray(w.timeline) ? w.timeline : []).concat([{ id, when: { day: Math.floor(h / 24), hour: 9 }, scope: 'world', text: 'Something everyone expected happens.' }]);
    return id;
  };
  LE.removeEvent = function (files, id) {
    const it = LE.findEvent(files, id);
    if (!it) return false;
    (it.file === 'world.json' ? world(files) : files[it.file]).timeline.splice(it.index, 1);
    return true;
  };
  // Renames an event and every "known" precondition that points at it.
  LE.renameEvent = function (files, from, to) {
    const it = LE.findEvent(files, from);
    if (!it || from === to) return;
    it.ev.id = to;
    const fix = (p) => { if (!isObj(p)) return; if (p.known === from) p.known = to; if (p.not) fix(p.not); };
    LE.events(files).forEach((x) => (x.ev.preconditions || []).forEach(fix));
  };

  // ---------- preconditions as editor rows ----------
  // A row is { kind, negate, a, b, by }: alive (a: character), controls (a:
  // group or '' for no one, b: region), clock (a: clock, b: at least), world
  // (a: key, b: value), event (a: event id), words (a: "word, word"), with
  // "by" for the two known kinds. negate wraps it in {not}.
  LE.PRE_ROWS = ['alive', 'controls', 'clock', 'world', 'event', 'words'];
  LE.rowOf = function (p) {
    let negate = false;
    while (isObj(p) && p.not) { negate = !negate; p = p.not; }
    if (!isObj(p)) return { kind: 'alive', negate, a: '', b: '' };
    if ('alive' in p) return { kind: 'alive', negate, a: p.alive, b: '' };
    if ('controls' in p) return { kind: 'controls', negate, a: (p.controls && p.controls.group) || '', b: (p.controls && p.controls.region) || '' };
    if ('clock' in p) return { kind: 'clock', negate, a: p.clock, b: p.atLeast };
    if ('world' in p) return { kind: 'world', negate, a: p.world, b: p.is };
    if ('known' in p && typeof p.known === 'string') return { kind: 'event', negate, a: p.known, b: '', by: p.by || '' };
    if ('known' in p) return { kind: 'words', negate, a: ((p.known && p.known.words) || []).join(', '), b: '', by: p.by || '' };
    return { kind: 'alive', negate, a: '', b: '' };
  };
  LE.preOf = function (row) {
    let p;
    if (row.kind === 'alive') p = { alive: row.a };
    else if (row.kind === 'controls') p = { controls: { group: row.a || null, region: row.b } };
    else if (row.kind === 'clock') p = { clock: row.a, atLeast: Number(row.b) || 0 };
    else if (row.kind === 'world') p = { world: row.a, is: String(row.b ?? '') };
    else if (row.kind === 'event') p = { known: row.a };
    else p = { known: { words: String(row.a || '').split(',').map((w) => w.trim()).filter(Boolean) } };
    if ((row.kind === 'event' || row.kind === 'words') && row.by) p.by = row.by;
    return row.negate ? { not: p } : p;
  };
  // A fresh row of a kind, filled with the world's first fitting ids.
  LE.newRow = function (kind, refs) {
    const first = (list) => (list[0] ? list[0].id : '');
    if (kind === 'alive') return { kind, negate: false, a: first(refs.characters), b: '' };
    if (kind === 'controls') return { kind, negate: false, a: first(refs.groups), b: first(refs.regions) };
    if (kind === 'clock') return { kind, negate: false, a: first(refs.clocks), b: 1 };
    if (kind === 'world') return { kind, negate: false, a: refs.worldKeys[0] || '', b: '' };
    if (kind === 'event') return { kind, negate: false, a: first(refs.events), b: '', by: '' };
    return { kind: 'words', negate: false, a: '', b: '', by: '' };
  };

  // ---------- effects ----------
  // A starting item for each effect, with the world's first fitting ids, to
  // add to an event's effects and then edit.
  LE.effectTemplate = function (key, refs) {
    const first = (list, d) => (list[0] ? list[0].id : d);
    const r = first(refs.regions, 'region_id');
    return ({
      world: [{ key: refs.worldKeys[0] || 'key', value: 'new status' }],
      groups: [{ id: first(refs.groups, 'group_id'), stance: 'new stance' }],
      clocks: [{ id: first(refs.clocks, 'clock_id'), delta: 2 }],
      new_clock: { name: 'short name', max: 8, perHour: 0.2, fireText: 'what happens when it runs out' },
      control: [{ region: r, to: first(refs.groups, null) }],
      add_tag: [{ region: r, tag: 'short tag' }],
      remove_tag: [{ region: r, tag: 'existing tag' }],
      region_status: [{ region: r, status: 'new status' }],
    })[key];
  };
  // Adds one effect to an event (lists grow; a single object is replaced).
  LE.addEffect = function (ev, key, refs) {
    const t = LE.effectTemplate(key, refs);
    if (t === undefined) return;
    ev.effects = isObj(ev.effects) ? ev.effects : {};
    ev.effects[key] = Array.isArray(t) ? (Array.isArray(ev.effects[key]) ? ev.effects[key] : []).concat(t) : t;
  };

  // ---------- projection setting ----------
  // on: false turns it off; days/max: numbers, or null for the defaults.
  LE.setProjection = function (files, on, days, max) {
    const w = world(files);
    if (!on) { w.projectTimeline = false; return; }
    const cfg = {};
    if (days != null && days !== '' && Number(days) !== E.Timeline.PROJECT.days) cfg.days = Math.round(Number(days));
    if (max != null && max !== '' && Number(max) !== E.Timeline.PROJECT.max) cfg.max = Math.round(Number(max));
    if (Object.keys(cfg).length) w.projectTimeline = cfg; else delete w.projectTimeline;
  };

  // ---------- drafts (from the research helper or an imported packet) ----------
  // A draft is validated but unused until accepted: accepting drops the flag.
  LE.drafts = (files) => ({
    lore: LE.loreItems(files).filter((x) => x.entry.draft === true).map((x) => x.entry.id),
    events: LE.events(files).filter((x) => x.ev.draft === true).map((x) => x.ev.id),
  });
  LE.accept = function (files, kind, id) {
    const it = kind === 'event' ? LE.findEvent(files, id) : LE.findLore(files, id);
    const obj = it && (kind === 'event' ? it.ev : it.entry);
    if (!obj || obj.draft !== true) return false;
    delete obj.draft;
    return true;
  };
  // Accepts every draft of a kind ('lore' or 'event'); returns how many.
  LE.acceptAll = function (files, kind) {
    const ids = LE.drafts(files)[kind === 'event' ? 'events' : 'lore'];
    ids.forEach((id) => LE.accept(files, kind === 'event' ? 'event' : 'lore', id));
    return ids.length;
  };

  // ---------- links to the map ----------
  // How much lore and timeline mention a region, for the map tab's form.
  // True when an event happens in a region or has a condition about who holds it.
  LE.eventMentions = function (ev, regionId) {
    const pre = (p) => isObj(p) && ((isObj(p.controls) && p.controls.region === regionId) || pre(p.not));
    return ev.region === regionId || (ev.preconditions || []).some(pre);
  };
  LE.regionUse = (files, regionId) => ({
    lore: LE.loreItems(files).filter((x) => x.entry.level === 'region' && x.entry.ref === regionId).length,
    events: LE.events(files).filter((x) => LE.eventMentions(x.ev, regionId)).length,
  });
})(typeof window !== 'undefined' ? window : globalThis);
