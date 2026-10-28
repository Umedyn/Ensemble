// Generated starts (task 4-2). A world with "generatedStarts" lets the
// player build a start instead of picking one: a region, a character (the
// 4-1 form, or a line the model turns into a sheet) and an optional note go
// in; a pipeline of small worldbuild calls comes out, each checked before
// the next: rooms → who is here → the people → ties and pressures → minor
// people and groups → the opening → local lore (task 5-6). The result is a normal start (plus its
// new characters), composed and validated like an authored one.
//
// A job is plain JSON (inputs plus each step's checked output), so the page
// can keep it after every step and resume it. DOM-free.
(function (root) {
  const E = root.Ensemble;
  const GEN = (E.StartGen = {});
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const ID = /^[a-z0-9][a-z0-9_-]*$/;
  const text = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  // Prose fields: cut at the last sentence (or word) that fits, never mid-word.
  const clip = (v, n) => (typeof v === 'string' ? E.clip(v, n) : '');
  GEN.clip = clip;
  const slug = (t) => String(t || '').replace(/["“][^"”]*["”]/g, ' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^(the|a|an)\s+/, '').replace(/^(dr|mr|mrs|ms|mx|capt|sgt|prof)\.?\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  const norm = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

  GEN.STEPS = [
    { id: 'setting', label: 'Your world' },
    { id: 'player', label: 'Your character' },
    { id: 'rooms', label: 'Places' },
    { id: 'plan', label: 'Who is here' },
    { id: 'cast', label: 'Characters' },
    { id: 'ties', label: 'Ties and pressures' },
    { id: 'extras', label: 'Minor people and groups' },
    { id: 'opening', label: 'Opening scene' },
    { id: 'lore', label: 'Local lore' },
  ];
  // Local lore (task 5-6): entries per start, and their length in words
  // (40–80 asked; shorter ones are dropped, longer ones sent back).
  GEN.LORE = { min: 3, max: 5, minWords: 25, maxWords: 100 };
  GEN.TRIES = 3; // one call plus two reruns with the problem named
  GEN.PLAYER_FEELING = 25; // the cast has only just met the player
  GEN.PLURAL = /\b(couple|family|pair|twins|group|kids|children|people|men|women|survivors|neighbou?rs|brothers|sisters)\b/i;
  GEN.CONFIG_FIELDS = ['start', 'roles', 'skillPoints', 'maxSkill', 'castSize', 'castLabel', 'customSetting'];
  // A world the player describes (customSetting): their words, and how long
  // the setting written from them may be.
  GEN.SETTING = { world: 600, setting: 900, minWords: 25, tags: 4 };
  GEN.custom = (world) => !!(world && world.generatedStarts && world.generatedStarts.customSetting === true);
  // Defaults for every generatedStarts field (R-0), so {} (or a world with
  // no starts) plays.
  GEN.DEFAULTS = { skillPoints: 10, maxSkill: 3, castSize: [3, 5] };
  GEN.DATE = { day: 1, hour: 9 };

  // ---------- the world's settings ----------
  GEN.configProblems = function (world) {
    const g = world.generatedStarts == null ? {} : world.generatedStarts;
    if (!isObj(g)) return ['"generatedStarts" must be an object (it may be empty)'];
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push('generatedStarts: ' + msg); };
    Object.keys(g).filter((k) => !GEN.CONFIG_FIELDS.includes(k)).forEach((k) => req(false, `unknown field "${k}"`));
    req(g.start == null || (isObj(g.start) && Number.isFinite(g.start.day) && Number.isFinite(g.start.hour)), '"start" must be {day, hour}');
    req(g.castSize == null || (Array.isArray(g.castSize) && g.castSize.length === 2 && g.castSize.every((n) => Number.isInteger(n) && n >= 1 && n <= 8) && g.castSize[0] <= g.castSize[1]),
      '"castSize" must be [fewest, most], whole numbers from 1 to 8');
    req(g.castLabel == null || (typeof g.castLabel === 'string' && g.castLabel.length <= 30), '"castLabel" must be short text');
    req(g.customSetting == null || typeof g.customSetting === 'boolean', '"customSetting" must be true or false');
    // Roles and point-buy work like a start's playerSlot (task 4-1).
    const sc = { skills: world.skills || E.DEFAULT_SKILLS.slice(), needs: world.needs || [], locations: [{ id: '__here' }], characters: [], playerSlot: GEN.slot(world, '__here') };
    E.CharMaker.slotProblems(sc).forEach((p) => problems.push(p.replace(/^playerSlot: /, 'generatedStarts: ')));
    return problems;
  };
  GEN.slot = (world, location) => {
    const g = world.generatedStarts || {};
    return { location, roles: g.roles || [], freeform: true, skillPoints: g.skillPoints != null ? g.skillPoints : GEN.DEFAULTS.skillPoints, maxSkill: g.maxSkill != null ? g.maxSkill : GEN.DEFAULTS.maxSkill };
  };
  // Regions marked startable, or every region when none is.
  // Where a generated start can begin (R-7): a region's own "startable"
  // wins, else the nearest region it is inside that says; with nothing said
  // in its chain, every region when the world marks none startable, else
  // none. So startable: true takes in a whole branch and startable: false
  // shuts one out. Never a hidden region (R-5), nor one inside it.
  GEN.regions = function (world) {
    const list = (world.regions || []).filter(isObj);
    const byId = new Map(list.map((r) => [r.id, r]));
    const chain = (id) => E.Scenario.regionChainIn(list, id).map((x) => byId.get(x));
    const anyMarked = list.some((r) => r.startable === true);
    return list.filter((r) => {
      const up = chain(r.id);
      if (up.some((x) => x.known === false)) return false;
      const said = up.find((x) => typeof x.startable === 'boolean');
      return said ? said.startable : !anyMarked;
    });
  };
  // "Surprise me" (R-7): a random startable region at the deepest level
  // with detail, one with no startable region inside it. Engine dice, so
  // tests can seed it.
  GEN.surprise = function (world) {
    const ok = GEN.regions(world);
    if (!ok.length) return null;
    const ids = new Set(ok.map((r) => r.id));
    const leaves = ok.filter((r) => !ok.some((x) => x.id !== r.id && E.Scenario.regionChainIn(world.regions, x.id).includes(r.id) && ids.has(x.id)));
    return leaves[Math.floor(E.rng() * leaves.length)].id;
  };

  // The world composed with an empty start in a region: the context every
  // step sees (setting, rules, regions, groups), and what the 4-1 form needs.
  GEN.contextScenario = function (loaded, region) {
    const w = loaded.bundle.world;
    const sc = E.Scenario.compose(w, { id: 'generated', cast: [], region }, {}, loaded.folder);
    sc.skills = sc.skills || E.DEFAULT_SKILLS.slice();
    sc.needs = sc.needs || [];
    // The date: the world's setting for generated starts, its date, the
    // default start's, else day 1, 9:00.
    const def = loaded.defaultStart && loaded.bundle.starts[loaded.defaultStart];
    sc.start = E.clone((w.generatedStarts && w.generatedStarts.start) || w.date || (def && def.start) || GEN.DATE);
    return sc;
  };
  // A scenario for the 4-1 form: one placeholder room (the real one comes
  // with the rooms step), no cast yet, the world's roles and point-buy.
  GEN.slotScenario = function (loaded, region) {
    const sc = GEN.contextScenario(loaded, region);
    sc.locations = [{ id: '__here', name: 'Where you start', desc: 'Not made yet.', connects: [] }];
    sc.characters = [];
    sc.characterData = [];
    sc.extras = [];
    sc.standees = [];
    sc.playerSlot = GEN.slot(loaded.bundle.world, '__here');
    // The made character's id must not clash with the world's people (CharMaker.slugId).
    sc.reservedIds = [...GEN.taken(loaded).ids];
    return sc;
  };

  // Ids and names the generated start must not reuse.
  GEN.taken = function (loaded) {
    const b = loaded.bundle;
    const w = b.world;
    const ids = new Set(['player', '__here']);
    const names = new Set();
    [].concat(w.locations || [], ...Object.values(b.starts || {}).map((s) => s.locations || [])).forEach((l) => { if (l) { ids.add(l.id); if (l.name) names.add(l.name); } });
    [].concat(w.regions || [], w.factions || [], w.extras || [], w.standees || [], ...Object.values(b.starts || {}).map((s) => [].concat(s.extras || [], s.standees || [])))
      .forEach((x) => { if (x) ids.add(x.id); });
    [].concat(w.extras || [], ...Object.values(b.starts || {}).map((s) => s.extras || [])).forEach((x) => { if (x && x.name) names.add(x.name); });
    Object.values(b.characters || {}).forEach((c) => { if (c) { ids.add(c.id); if (c.name) names.add(c.name); } });
    // People only (not places), for spotting text about someone who isn't here.
    const people = [].concat(Object.values(b.characters || {}), w.extras || [], ...Object.values(b.starts || {}).map((s) => s.extras || [])).filter((c) => c && c.name).map((c) => c.name);
    // Names from lore (R-7): its titles and keywords. Lore figures come into
    // the story only by the player's action, never in a generated cast.
    const lore = new Set([].concat(Array.isArray(w.lore) ? w.lore : [], ...Object.values(b.starts || {}).map((s) => (Array.isArray(s.lore) ? s.lore : [])))
      .filter(isObj).flatMap((e) => [e.title].concat(Array.isArray(e.keywords) ? e.keywords : [])).map(norm).filter(Boolean));
    return { ids, names, people, lore };
  };
  // A planned name that is someone (or something) from the world's lore.
  GEN.loreFigure = (ctx, name) => (ctx.taken.lore && ctx.taken.lore.has(norm(name)) ? name : null);

  // Words that name a person in text: the full name, and the surname when it
  // is 4+ letters (title case, whole word).
  const nameWords = (name) => {
    const bare = String(name).replace(/^(dr|mr|mrs|ms|mx|prof|capt|sgt)\.?\s+/i, '');
    const parts = bare.split(/\s+/).filter(Boolean);
    const surname = (parts.length > 1 || bare !== name) && parts[parts.length - 1].length >= 4 ? parts[parts.length - 1] : null;
    return [...new Set([name, surname].filter(Boolean))];
  };
  const mentions = (t, name) => nameWords(name).some((w) => new RegExp(`(^|[^\\w])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(String(t || '')));
  // "Teodora \"Teddy\" Marchetti" → ["Teddy"].
  const nicknames = (name) => [...String(name).matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]);
  // Crude stems, so "wrapped" and "wrapping" count as one word.
  const stems = (t) => new Set([...E.Engine.contentWords(t)].map((w) => w.replace(/(ing|ed|es|s)$/, '')));
  // A public text that names someone and shares 2+ stems with their secret,
  // or 4+ with anyone's.
  GEN.pressureLeak = function (job, t) {
    for (const c of GEN.people(job).concat(GEN.player(job) || [])) {
      if (!c.secret) continue;
      const first = String(c.name).replace(/["“][^"”]*["”]/g, ' ').trim().split(/\s+/)[0];
      const named = mentions(t, c.name) || (first.length >= 3 && mentions(t, first)) || nicknames(c.name).some((n) => mentions(t, n));
      const secret = stems(c.secret);
      let hits = 0;
      stems(t).forEach((w) => { if (secret.has(w)) hits++; });
      if (hits >= 4 || (named && hits >= 2)) return c;
    }
    return null;
  };
  // Someone from the world's authored cast named in a text (playtest-12b: a
  // generated shopkeeper's description was Marlene Ortiz's, from the holdout).
  GEN.namesSomeoneElse = (ctx, t) => ctx.taken.people.find((n) => mentions(t, n)) || null;
  // The player named in a text: their full name, surname or first name.
  GEN.namesPlayer = (job, t) => {
    const pc = GEN.player(job);
    if (!pc) return false;
    const first = String(pc.name).split(/\s+/)[0];
    return mentions(t, pc.name) || (first.length >= 3 && mentions(t, first));
  };

  // ---------- where exactly (R-7) ----------
  // The player may say where exactly they start ("a moisture farm outside
  // Tessk Crossing"): the place the rooms step builds, inside the region
  // they picked. Not a region of its own (playtest-r7-tessk-workshop:
  // "Engineer workshop and flat." became a region, and the rooms step then
  // built the workshop anyway).
  GEN.cleanPlace = (t) => text(t, 60).replace(/[\s.,;:!]+$/, '');
  GEN.placeProblem = function (loaded, place) {
    const taken = (loaded.bundle.world.regions || []).find((r) => norm(r.name) === norm(place));
    return taken ? `"${place}" is already on the map: pick it there` : null;
  };

  // ---------- jobs ----------
  // opts: { region, note, character (a made character, 4-1) | line (a
  // description), onePass (the whole cast in one call; default: when the
  // world-building backend isn't KoboldCpp) }.
  GEN.newJob = function (loaded, opts) {
    const o = opts || {};
    if (!loaded.generate) throw new Error(`"${loaded.title}" doesn't have generated starts.`);
    const region = o.region || (GEN.regions(loaded.bundle.world)[0] || {}).id || null;
    if ((loaded.bundle.world.regions || []).length && !GEN.regions(loaded.bundle.world).some((r) => r.id === region)) throw new Error(`You can't start in "${region}".`);
    if (!o.character && !text(o.line, 300)) throw new Error('Make a character, or describe one in a line.');
    // A world the player describes (customSetting): the first step writes its setting.
    const worldText = GEN.custom(loaded.bundle.world) ? clip(o.world, GEN.SETTING.world) : '';
    if (GEN.custom(loaded.bundle.world) && worldText.split(/\s+/).filter(Boolean).length < 3) throw new Error('Describe the world your story is set in: where, when, and what it is like.');
    const place = GEN.cleanPlace(o.place);
    if (place) {
      const why = GEN.placeProblem(loaded, place);
      if (why) throw new Error(why);
    }
    return {
      v: 1, world: loaded.id, folder: loaded.folder, id: 'gen-' + Math.random().toString(36).slice(2, 8),
      region, note: text(o.note, 400), line: o.character ? '' : text(o.line, 300), place: place || '', worldText,
      onePass: o.onePass != null ? !!o.onePass : !E.LLM.backendFor('worldbuild').kobold,
      steps: o.character ? { player: { character: E.clone(o.character) } } : {},
      partial: {}, log: [], failed: null,
    };
  };
  GEN.order = (job) => GEN.STEPS.filter((s) => (s.id !== 'player' || job.line || (job.steps.player && job.steps.player.character)) && (s.id !== 'setting' || job.worldText)).map((s) => s.id);
  GEN.done = (job) => GEN.order(job).every((id) => job.steps[id]);
  GEN.nextStep = (job) => GEN.order(job).find((id) => !job.steps[id]) || null;

  // ---------- what earlier steps made, for later prompts ----------
  GEN.player = (job) => job.steps.player && job.steps.player.character;
  GEN.people = (job) => (job.steps.cast ? job.steps.cast.people : []);

  // ---------- step checkers ----------
  // Each turns the model's reply into checked data, or { error } in words
  // the next try can be told. ctx: { loaded, job, sc, taken }.
  const C = (GEN.check = {});

  // The world the player described (customSetting) → the setting every
  // later step and the game keep to, with genre tags and a tone note. It
  // must keep to their words: most of what they named is in it.
  C.setting = function (raw, ctx) {
    if (!isObj(raw)) return { error: 'reply with one JSON object' };
    const L = GEN.SETTING;
    const setting = clip(raw.setting, L.setting);
    const n = setting.split(/\s+/).filter(Boolean).length;
    if (n < L.minWords) return { error: `write the setting in 3 to 5 sentences (got ${n} words)` };
    const theirs = [...E.Engine.contentWords(ctx.job.worldText)];
    const mine = E.Engine.contentWords(setting);
    const kept = theirs.filter((w) => mine.has(w));
    const need = Math.min(3, Math.ceil(theirs.length / 2));
    if (kept.length < need) return { error: `keep to the world the player described ("${ctx.job.worldText}"): use their names, place and time` };
    if (/\b(you|your|you're|yourself)\b/i.test(setting)) return { error: 'write the setting about the world, not to the player ("you")' };
    const tags = [];
    (Array.isArray(raw.tags) ? raw.tags : []).forEach((t) => {
      const tag = text(t, 40).toLowerCase();
      if (tag && !tags.includes(tag) && tags.length < L.tags) tags.push(tag);
    });
    const out = { setting, tags };
    const tone = clip(raw.toneNote, 300);
    if (tone) out.toneNote = tone;
    return out;
  };

  // Skills from the model, fitted to the point-buy: each 0..max, then the
  // highest come down until the total fits.
  GEN.fitSkills = function (skills, list, points, max) {
    const out = {};
    list.forEach((k) => { out[k] = E.clamp(Math.round(Number((skills || {})[k]) || 0), 0, max); });
    let total = Object.values(out).reduce((a, b) => a + b, 0);
    while (total > points) {
      const top = list.reduce((a, k) => (out[k] > out[a] ? k : a), list[0]);
      out[top] -= 1;
      total -= 1;
    }
    return out;
  };

  C.player = function (raw, ctx) {
    if (!isObj(raw)) return { error: 'reply with one JSON object, the character sheet' };
    const sc = GEN.slotScenario(ctx.loaded, ctx.job.region);
    const slot = sc.playerSlot;
    const form = Object.assign(E.CharMaker.defaults(sc), {
      name: text(raw.name, 40), pronouns: text(raw.pronouns, 20) || 'they/them', role: '', roleText: text(raw.role, 60),
      description: text(raw.description, 600), appearance: text(raw.appearance, 400), voice: text(raw.voice, 160), want: text(raw.want, 160),
      traits: (Array.isArray(raw.traits) ? raw.traits : []).map((t) => text(t, 30)).filter(Boolean).slice(0, 6),
      skills: GEN.fitSkills(raw.skills, sc.skills, slot.skillPoints, slot.maxSkill),
    });
    const age = Math.round(Number(raw.age));
    if (age > 0 && age < 130) form.age = age;
    const secret = text(raw.secret, 300);
    if (secret && !/^(none|null|no secret)\.?$/i.test(secret)) { form.secret = secret; form.guard = ['low', 'medium', 'high'].includes(raw.guard) ? raw.guard : 'medium'; }
    const role = (slot.roles || []).find((r) => norm(r.label) === norm(form.roleText));
    if (role) { form.role = role.id; form.roleText = ''; }
    if (ctx.taken.names.has(form.name)) return { error: `"${form.name}" is already someone in this world; pick another name` };
    // playtest-12b: a sheet without skills left a park ranger at 0 in everything.
    if (slot.skillPoints > 0 && !Object.values(form.skills).some((v) => v > 0)) return { error: `spend the skill points: up to ${slot.skillPoints} in all, each from 0 to ${slot.maxSkill} (the sheet had none)` };
    const out = E.CharMaker.build(sc, form);
    return out.errors ? { error: out.errors.join(' ') } : { character: out.character };
  };

  C.rooms = function (raw, ctx) {
    const list = isObj(raw) && Array.isArray(raw.rooms) ? raw.rooms.filter(isObj) : [];
    if (list.length < 3) return { error: `make 3 to 6 rooms (got ${list.length})` };
    const warnings = [];
    if (list.length > 6) warnings.push(`kept the first 6 of ${list.length} rooms`);
    const used = new Set(ctx.taken.ids);
    const rooms = [];
    for (const r of list.slice(0, 6)) {
      const name = text(r.name, 40);
      if (!name) return { error: 'every room needs a "name"' };
      const desc = clip(r.desc, 240);
      if (!desc) return { error: `room "${name}" needs a "desc"` };
      let id = ID.test(String(r.id || '')) && String(r.id).length <= 24 ? String(r.id) : slug(name) || 'room';
      for (let n = 2; used.has(id); n++) id = `${slug(name) || 'room'}-${n}`;
      used.add(id);
      const room = { id, name, desc, connects: [], _raw: (Array.isArray(r.connects) ? r.connects : []).map(String), _alias: [String(r.id || ''), name] };
      if (r.outside === true) room.outside = true;
      if (['small', 'medium', 'large'].includes(r.size)) room.size = r.size;
      rooms.push(room);
    }
    if (new Set(rooms.map((r) => norm(r.name))).size < rooms.length) return { error: 'two rooms have the same name' };
    const find = (ref) => rooms.find((r) => r._alias.some((a) => a && norm(a) === norm(ref)) || r.id === ref);
    rooms.forEach((r) => r._raw.forEach((ref) => {
      const to = find(ref);
      if (!to || to === r) return;
      if (!r.connects.includes(to.id)) r.connects.push(to.id);
      if (!to.connects.includes(r.id)) to.connects.push(r.id);
    }));
    const start = find(raw.player_room) || rooms[0];
    if (!find(raw.player_room)) warnings.push(`"player_room" ${raw.player_room ? `"${raw.player_room}" is not one of the rooms` : 'missing'}; the player starts in ${start.name}`);
    // Rooms nobody can reach are linked to the starting room (rule 1: fix in
    // the engine what a retry would likely get wrong again).
    const reach = new Set([start.id]);
    const queue = [start.id];
    while (queue.length) {
      const at = queue.shift();
      rooms.find((r) => r.id === at).connects.forEach((c) => { if (!reach.has(c)) { reach.add(c); queue.push(c); } });
    }
    rooms.filter((r) => !reach.has(r.id)).forEach((r) => {
      warnings.push(`${r.name} connected nowhere; linked to ${start.name}`);
      r.connects.push(start.id);
      start.connects.push(r.id);
    });
    rooms.forEach((r) => { delete r._raw; delete r._alias; });
    return { rooms, playerRoom: start.id, warnings };
  };

  GEN.castSize = (world) => ((world.generatedStarts || {}).castSize || GEN.DEFAULTS.castSize);
  const castSize = (ctx) => GEN.castSize(ctx.loaded.bundle.world);
  C.plan = function (raw, ctx) {
    const [min, max] = castSize(ctx);
    const list = (isObj(raw) && Array.isArray(raw.people) ? raw.people : []).filter(isObj);
    const pc = GEN.player(ctx.job);
    const people = [];
    for (const p of list) {
      const name = text(p.name, 40);
      // "Retired school-bus driver, 61": the age goes to the sheet (playtest-api).
      const rawRole = text(p.role, 80);
      const aged = /,\s*(\d{1,3})\s*$/.exec(rawRole);
      const role = text(aged ? rawRole.slice(0, aged.index) : rawRole, 60);
      if (!name || !role) return { error: 'every planned person needs a "name" and a "role"' };
      if (ctx.taken.names.has(name) || (pc && norm(pc.name) === norm(name)) || people.some((x) => norm(x.name) === norm(name))) return { error: `the name "${name}" is already used; every person needs their own name` };
      if (GEN.loreFigure(ctx, name)) return { error: `${name} is someone from the world's lore: make up someone new (people from the lore come into the story only when the player seeks them out)` };
      const hook = clip(p.hook, 160);
      // The player's family or old friends are allowed when the story calls
      // for them (a slice-of-life start has a family); the prompt asks for
      // them only when they fit.
      const other = GEN.namesSomeoneElse(ctx, role + ' ' + hook);
      if (other) return { error: `${name}'s line is about ${other}, who isn't in this start` };
      people.push(Object.assign({ name, role, hook }, aged ? { age: Number(aged[1]) } : {}));
    }
    if (people.length < min) return { error: `plan ${min} to ${max} people (got ${people.length})` };
    const warnings = people.length > max ? [`kept the first ${max} of ${people.length} people`] : [];
    return { people: people.slice(0, max), warnings };
  };

  // One sheet → a character, or { error }. plan: { name, role }.
  GEN.cleanPerson = function (raw, plan, ctx, usedIds) {
    if (!isObj(raw)) return { error: `the sheet for ${plan.name} is not a JSON object` };
    const sc = ctx.sc;
    const rooms = ctx.job.steps.rooms.rooms;
    const want = text(raw.want, 160);
    if (!want) return { error: `${plan.name} needs a "want"` };
    const traits = (Array.isArray(raw.traits) ? raw.traits : []).map((t) => text(t, 30)).filter(Boolean).slice(0, 4);
    if (!traits.length) return { error: `${plan.name} needs "traits"` };
    const secret = text(raw.secret, 300);
    if (!secret || /^(none|null|no secret)\.?$/i.test(secret)) return { error: `${plan.name} needs a "secret" they hide from the others` };
    const room = rooms.find((r) => r.id === raw.room || norm(r.name) === norm(raw.room)) || rooms.find((r) => r.id === ctx.job.steps.rooms.playerRoom);
    let id = slug(plan.name) || 'person';
    for (let n = 2; ctx.taken.ids.has(id) || usedIds.has(id); n++) id = `${slug(plan.name) || 'person'}-${n}`;
    const c = {
      id, name: plan.name, pronouns: text(raw.pronouns, 20) || 'they/them', role: plan.role, traits, want, secret,
      guard: ['low', 'medium', 'high'].includes(raw.guard) ? raw.guard : 'medium',
      voice: clip(raw.voice, 160) || undefined, appearance: clip(raw.appearance, 400) || undefined, description: clip(raw.description, 600) || undefined,
      skills: {}, relations: {}, status: { health: 'ok', location: room.id },
    };
    const age = Math.round(Number(raw.age)) || plan.age;
    if (age > 0 && age < 130) c.age = age;
    sc.skills.forEach((k) => { c.skills[k] = E.clamp(Math.round(Number((raw.skills || {})[k]) || 0), 0, 4); });
    Object.keys(c).forEach((k) => c[k] === undefined && delete c[k]);
    const prose = [c.description, c.appearance, c.want, c.secret, c.voice].filter(Boolean).join(' ');
    const other = GEN.namesSomeoneElse(ctx, prose);
    if (other) return { error: `the sheet for ${plan.name} talks about ${other}, who isn't in this start; write about ${plan.name}` };
    const problems = E.Scenario.characterProblems(c, sc, new Set(rooms.map((r) => r.id)), [id]);
    return problems.length ? { error: problems.join('; ') } : { character: c };
  };
  // The one-call form (an API model): { people: [sheet with name] }.
  C.cast = function (raw, ctx) {
    const plan = ctx.job.steps.plan.people;
    const sheets = isObj(raw) && Array.isArray(raw.people) ? raw.people.filter(isObj) : [];
    const used = new Set();
    const people = [];
    for (const p of plan) {
      const sheet = sheets.find((s) => norm(s.name) === norm(p.name));
      if (!sheet) return { error: `no sheet for ${p.name}` };
      const out = GEN.cleanPerson(sheet, p, ctx, used);
      if (out.error) return out;
      used.add(out.character.id);
      people.push(out.character);
    }
    return { people };
  };
  C.person = function (raw, ctx, index) {
    const used = new Set((ctx.job.partial.cast || []).map((c) => c.id));
    return GEN.cleanPerson(raw, ctx.job.steps.plan.people[index], ctx, used);
  };

  // Names or ids → ids of the player and the cast.
  const whoIs = (ctx, ref) => {
    const pc = GEN.player(ctx.job);
    const all = [pc].concat(GEN.people(ctx.job));
    if (ref === 'player' || norm(ref) === 'player' || norm(ref) === 'you') return pc.id;
    const hit = all.find((c) => c.id === ref || norm(c.name) === norm(ref) || norm(c.name.split(/\s+/)[0]) === norm(ref) || norm(c.name.split(/\s+/).pop()) === norm(ref));
    return hit ? hit.id : null;
  };
  C.ties = function (raw, ctx) {
    if (!isObj(raw)) return { error: 'reply with one JSON object' };
    const pc = GEN.player(ctx.job);
    const warnings = [];
    const relations = [];
    (Array.isArray(raw.relations) ? raw.relations : []).filter(isObj).forEach((r) => {
      const from = whoIs(ctx, r.from);
      const to = whoIs(ctx, r.to);
      if (!from || !to || from === to) return warnings.push(`relation ${r.from} → ${r.to} skipped (unknown or the same person)`);
      // Rule 3: the player's own feelings are theirs (the form, or neutral).
      if (from === pc.id) return warnings.push(`the player's own feelings toward ${to} are left to the player`);
      // Toward the player: mild, since they've only just met (playtest-12b:
      // +40 and +50 from people whose opening line was "I don't know who you are").
      const cap = to === pc.id ? GEN.PLAYER_FEELING : 50;
      const value = E.clamp(Math.round(Number(r.value) || 0), -cap, cap);
      if (value !== Math.round(Number(r.value) || 0)) warnings.push(`${from} → ${to} kept to ${value}`);
      relations.push({ from, to, value });
    });
    const knows = [];
    (Array.isArray(raw.knows) ? raw.knows : []).filter(isObj).forEach((k) => {
      const id = whoIs(ctx, k.id);
      const t = clip(k.text, 400);
      if (!id || id === pc.id || !t) return warnings.push(`private fact for "${k.id}" skipped`);
      // What the player carries or did is theirs to say (rule 3; playtest-12b:
      // "Emma has a first aid kit hidden in her backpack").
      if (GEN.namesPlayer(ctx.job, t)) return warnings.push(`private fact about the player left out: "${t}"`);
      const other = GEN.namesSomeoneElse(ctx, t);
      if (other) return warnings.push(`private fact about ${other}, who isn't here, left out`);
      if (knows.filter((x) => x.id === id).length < 2) knows.push({ id, text: t });
    });
    const list = (Array.isArray(raw.pressures) ? raw.pressures : Array.isArray(raw.clocks) ? raw.clocks : []).filter(isObj);
    if (!list.length) return { error: 'add 1 or 2 "pressures"' };
    const used = new Set(ctx.taken.ids);
    const clock = (p) => {
      const name = text(p.name, 40);
      let id = slug(name) || 'pressure';
      for (let n = 2; used.has(id); n++) id = `${slug(name) || 'pressure'}-${n}`;
      used.add(id);
      return { id, name, value: 0, max: E.clamp(Math.round(Number(p.max) || 8), 2, 24), perHour: E.clamp(Number(p.perHour) || 0.1, 0.01, 1), fireText: clip(p.fireText, 240) };
    };
    const clocks = list.slice(0, 2).map((p) => {
      const c = clock(p);
      // One follow-up each (task 4-2 leftover): starts when this one comes to a
      // head. A bad follow-up is dropped, not a reason to redo the step.
      const t = isObj(p.then) ? p.then : Array.isArray(p.then) && isObj(p.then[0]) ? p.then[0] : null;
      if (t) {
        const f = clock(t);
        const who = f.name && f.fireText && GEN.pressureLeak(ctx.job, f.name + '. ' + f.fireText);
        if (!f.name || !f.fireText) warnings.push(`follow-up to "${c.name}" left out (no name or fireText)`);
        else if (who) warnings.push(`follow-up "${f.name}" left out: it gives away ${who.name}'s secret`);
        else c.then = [f];
      }
      return c;
    });
    const bad = clocks.find((c) => !c.name || !c.fireText);
    if (bad) return { error: 'every pressure needs a "name" and a "fireText"' };
    // Pressures show in the Situation panel (playtest-api: "Renata's fever ...
    // the wrapping comes off" for a bite she's hiding).
    for (const c of clocks) {
      const who = GEN.pressureLeak(ctx.job, c.name + '. ' + c.fireText);
      if (who) return { error: `the pressure "${c.name}" gives away ${who.name}'s secret; pressures are shown to the player, so keep them about things everyone can see` };
    }
    // Event ideas for this start's regional events; they steer public events,
    // so the same leak check applies.
    const events = [];
    (Array.isArray(raw.events) ? raw.events : []).forEach((e) => {
      const t = clip(isObj(e) ? e.text : e, 160);
      if (!t) return;
      const who = GEN.pressureLeak(ctx.job, t);
      if (who) return warnings.push(`event idea left out: it gives away ${who.name}'s secret`);
      if (events.length < 3) events.push(t);
    });
    return { relations, knows, clocks, events, warnings };
  };

  C.extras = function (raw, ctx) {
    if (!isObj(raw)) return { error: 'reply with one JSON object' };
    const rooms = ctx.job.steps.rooms.rooms;
    const roomOf = (ref) => { const r = rooms.find((x) => x.id === ref || norm(x.name) === norm(ref)); return r ? r.id : null; };
    const used = new Set([...ctx.taken.ids, ...rooms.map((r) => r.id), GEN.player(ctx.job).id, ...GEN.people(ctx.job).map((c) => c.id)]);
    const names = new Set([...ctx.taken.names, GEN.player(ctx.job).name, ...GEN.people(ctx.job).map((c) => c.name)].map(norm));
    const newId = (t) => { let id = slug(t) || 'someone'; for (let n = 2; used.has(id); n++) id = `${slug(t) || 'someone'}-${n}`; used.add(id); return id; };
    const warnings = [];
    const extras = [];
    const pluralGroups = [];
    (Array.isArray(raw.extras) ? raw.extras : []).filter(isObj).slice(0, 4).forEach((x) => {
      const name = text(x.name, 40);
      const role = text(x.role, 60);
      if (!name || !role || names.has(norm(name))) return warnings.push(`minor person "${x.name || '?'}" skipped (needs a new name and a role)`);
      if (GEN.loreFigure(ctx, name)) return warnings.push(`minor person "${name}" skipped (someone from the world's lore: they come in only when the player seeks them out)`);

      names.add(norm(name));
      const loc = x.room == null || x.room === 'null' ? null : roomOf(x.room);
      // Several people under one name are a group (playtest-12b: "Young Couple").
      if (GEN.PLURAL.test(name)) {
        if (!loc) return warnings.push(`"${name}" is a group and needs a room; left out`);
        warnings.push(`"${name}" is a group, not one person`);
        return pluralGroups.push({ label: name, count: E.Scenario.parseCount(name), room: loc, state: 'calm', note: [role, text(x.note, 160)].filter(Boolean).join('; ') });
      }
      if (x.room != null && x.room !== 'null' && !loc) warnings.push(`${name}: room "${x.room}" unknown; nowhere in particular`);
      extras.push(Object.assign({ id: newId(name), name, role, location: loc, note: clip(x.note, 200) }, text(x.pronouns, 20) ? { pronouns: text(x.pronouns, 20) } : {}));
    });
    const groupIds = new Set((ctx.sc.factions || []).map((f) => f.id));
    const standees = [];
    (Array.isArray(raw.groups) ? raw.groups : Array.isArray(raw.standees) ? raw.standees : []).filter(isObj).slice(0, 2).concat(pluralGroups).slice(0, 3).forEach((g) => {
      const label = text(g.label, 40);
      const loc = roomOf(g.room);
      if (!label || !loc) return warnings.push(`group "${g.label || '?'}" skipped (needs a label and one of the rooms)`);
      const st = { id: newId(label), label, count: E.Scenario.parseCount(g.count), location: loc, state: ['calm', 'alert', 'hostile'].includes(g.state) ? g.state : 'calm', note: clip(g.note, 200) };
      if (groupIds.has(g.faction)) st.faction = g.faction;
      standees.push(st);
    });
    return { extras, standees, warnings };
  };

  // True when a text gives away someone's secret: 4+ content words in common
  // in one paragraph or fact.
  GEN.leak = function (job, t, min) {
    const words = (s) => E.Engine.contentWords(s);
    for (const c of GEN.people(job).concat(GEN.player(job) || [])) {
      if (!c.secret) continue;
      const secret = words(c.secret);
      for (const para of String(t).split(/\n\s*\n/)) {
        let hits = 0;
        words(para).forEach((w) => { if (secret.has(w)) hits++; });
        if (hits >= min) return c;
      }
    }
    return null;
  };
  C.opening = function (raw, ctx) {
    if (!isObj(raw)) return { error: 'reply with one JSON object' };
    const title = text(raw.title, 60);
    const summary = text(raw.summary, 300);
    if (!title || !summary) return { error: 'give a "title" and a "summary"' };
    let opening = String(raw.opening || '').replace(/\r/g, '').trim();
    opening = E.Engine.trimPlayerEnding(E.Engine.cleanProse(opening));
    const words = opening.split(/\s+/).filter(Boolean).length;
    if (words < 40) return { error: `the opening is too short (${words} words); write 2 to 4 paragraphs` };
    if (words > 450) return { error: `the opening is too long (${words} words); keep it under 400` };
    const away = GEN.namesSomeoneElse(ctx, opening);
    if (away) return { error: `the opening names ${away}, who isn't in this start` };
    const leak = GEN.leak(ctx.job, opening, 4);
    if (leak) return { error: `the opening gives away ${leak.name}'s secret; keep secrets hidden` };
    const facts = [];
    for (const f of (Array.isArray(raw.facts) ? raw.facts : []).slice(0, 3)) {
      const t = text(f, 200);
      if (!t) continue;
      const elsewhere = GEN.namesSomeoneElse(ctx, t);
      if (elsewhere) return { error: `a public fact names ${elsewhere}, who isn't in this start` };
      const who = GEN.leak(ctx.job, t, 4);
      if (who) return { error: `a public fact gives away ${who.name}'s secret` };
      // Not a fact addressed to the player ("As a newcomer, you're still
      // trying to…"): the player's past is theirs (rule 3; playtest-r7-tessk-workshop).
      if (/\b(you|your|you're|yours|yourself)\b/i.test(t)) continue;
      facts.push(t);
    }
    // Who is with the player when it opens (playtest-api: the opening put all
    // four in the kitchen, the sheets had them in four other rooms). Listed
    // by the model, or else everyone the opening names; they start in the
    // player's room.
    const cast = GEN.people(ctx.job);
    const listed = Array.isArray(raw.with_you) ? raw.with_you.map((r) => whoIs(ctx, r)).filter((id) => id && cast.some((c) => c.id === id)) : null;
    const withYou = [...new Set(listed || cast.filter((c) => mentions(opening, c.name) || mentions(opening, String(c.name).replace(/["“][^"”]*["”]/g, ' ').split(/\s+/)[0]) || nicknames(c.name).some((n) => mentions(opening, n))).map((c) => c.id))];
    return { title, summary, opening, facts, withYou };
  };

  // ---------- local lore (task 5-6) ----------
  // A few public entries about this start's places (the diner, the street,
  // the club), so their details stay the same from turn to turn. Checked
  // like authored lore, plus what only a generated text can get wrong.
  const stemShare = (a, b) => { const x = stems(a); let n = 0; stems(b).forEach((w) => { if (x.has(w)) n++; }); return n; };
  const wordRuns = (t, n) => {
    const w = String(t || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    const out = [];
    for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
    return out;
  };
  // The regions a local entry may be about: the start's and those it is inside.
  GEN.loreRegions = (ctx) => (ctx.job.region ? E.Scenario.regionChainIn(ctx.sc.regions, ctx.job.region).map((id) => (ctx.sc.regions || []).find((r) => r.id === id)).filter(Boolean) : []);
  // Timeline events still to come at the start (the narrator must not know them yet).
  GEN.futureEvents = (sc) => (Array.isArray(sc.timeline) ? sc.timeline : [])
    .filter((ev) => isObj(ev) && ev.draft !== true && ev.when && E.Timeline.at(ev.when) > E.Timeline.at(sc.start || GEN.DATE));
  // People in the world's lore (its entries about characters): they come into
  // the story only when the player seeks them out (R-7), never in local lore.
  const loreFigures = (sc) => (Array.isArray(sc.lore) ? sc.lore : []).filter((e) => isObj(e) && e.level === 'character')
    .flatMap((e) => [e.title].concat(Array.isArray(e.keywords) ? e.keywords : [])).filter((n) => typeof n === 'string' && n.trim());
  // What is wrong with an entry's words, or null. Shared by the step and the review.
  GEN.loreProblem = function (ctx, e) {
    const t = `${e.title || ''}. ${e.text || ''}`;
    if (/\b(you|your|you're|yours|yourself)\b/i.test(t)) return 'talks to the player ("you"); write about the place, as public knowledge';
    if (GEN.namesPlayer(ctx.job, t)) return `names ${GEN.player(ctx.job).name}, the player: their past is theirs to tell`;
    const away = GEN.namesSomeoneElse(ctx, t);
    if (away) return `names ${away}, who isn't in this start`;
    const fig = loreFigures(ctx.sc).find((n) => E.Lore.matches(n, t));
    if (fig) return `puts ${fig} in this place; people from the world's lore come into the story only when the player seeks them out`;
    const who = GEN.pressureLeak(ctx.job, t);
    if (who) return `gives away ${who.name}'s secret; lore is public`;
    if (GEN.futureEvents(ctx.sc).some((ev) => stemShare(ev.text, t) >= 4)) return 'tells something that hasn\'t happened yet; write the place as it is now';
    const theirs = new Set(E.Lore.entries(ctx.sc).flatMap((x) => wordRuns(x.text, 8)));
    const copy = wordRuns(e.text, 8).find((r) => theirs.has(r));
    if (copy) return `copies the world's lore ("${copy}…"); write something new about this place`;
    return null;
  };
  C.lore = function (raw, ctx) {
    if (!isObj(raw) || !Array.isArray(raw.entries)) return { error: 'reply with {"entries": [...]}' };
    const L = GEN.LORE;
    const rooms = ctx.job.steps.rooms.rooms;
    const regions = GEN.loreRegions(ctx);
    const known = E.Lore.topicIds(ctx.sc);
    const used = new Set(E.Lore.entries(ctx.sc).map((e) => e.id));
    const warnings = [];
    const entries = [];
    for (const r of raw.entries.filter(isObj).slice(0, L.max)) {
      const title = text(r.title, E.Lore.LIMITS.title);
      const body = String(r.text || '').replace(/\s+/g, ' ').trim();
      if (!title || !body) { warnings.push('an entry without a title or text, dropped'); continue; }
      const n = body.split(' ').length;
      if (n > L.maxWords || body.length > E.Lore.LIMITS.text) return { error: `"${title}" is ${n} words; keep each entry to 40–80 words on one thing` };
      if (n < L.minWords) { warnings.push(`too short, dropped: ${title}`); continue; }
      const level = r.about === 'region' ? 'region' : 'location';
      let ref;
      if (level === 'location') {
        const room = rooms.find((x) => x.id === r.ref || norm(x.name) === norm(r.ref));
        if (!room) return { error: `"${title}" is about "${r.ref}", which isn't one of the rooms (${rooms.map((x) => x.id).join(', ')})` };
        ref = room.id;
      } else {
        if (!regions.length) return { error: `"${title}" is about a region, but there is none here; make it about one of the rooms` };
        const rg = r.ref == null || r.ref === '' ? regions[0] : regions.find((x) => x.id === r.ref || norm(x.name) === norm(r.ref));
        if (!rg) return { error: `"${title}" is about "${r.ref}"; a region entry is about ${regions.map((x) => `${x.id} (${x.name})`).join(' or ')}` };
        ref = rg.id;
      }
      let id = 'local-' + (slug(title) || 'place');
      for (let k = 2; used.has(id); k++) id = `local-${slug(title) || 'place'}-${k}`;
      used.add(id);
      const e = { id, title, level, ref, text: body };
      const kws = [];
      [].concat(Array.isArray(r.keywords) ? r.keywords : [], title.split(/\s+/).length <= 3 ? [title] : []).forEach((k) => {
        const kw = text(k, E.Lore.LIMITS.keyword);
        if (kw && !kws.some((x) => x.toLowerCase() === kw.toLowerCase())) kws.push(kw);
      });
      if (kws.length) e.keywords = kws.slice(0, E.Lore.LIMITS.keywords);
      const topics = [...new Set((Array.isArray(r.topics) ? r.topics : []).map((t) => String(t || '').trim().toLowerCase()).filter((t) => known.includes(t)))];
      if (topics.length) e.topics = topics.slice(0, E.Lore.LIMITS.topics);
      const why = GEN.loreProblem(ctx, e);
      if (why) return { error: `"${title}" ${why}` };
      entries.push(e);
    }
    if (!entries.length) return { error: `write ${L.min} to ${L.max} entries of 40–80 words each` };
    return { entries, warnings };
  };

  // A scenario with the setting the player's world step wrote (customSetting),
  // so every later step's header keeps to it.
  GEN.withSetting = function (sc, job) {
    const s = job && job.steps.setting;
    if (!s) return sc;
    sc.setting = s.setting;
    sc.tags = (s.tags || []).slice();
    if (s.toneNote) sc.toneNote = s.toneNote; else delete sc.toneNote;
    return sc;
  };

  // ---------- running ----------
  GEN.context = function (loaded, job) {
    const sc = GEN.withSetting(GEN.contextScenario(loaded, job.region), job);
    const taken = GEN.taken(loaded);
    return { loaded, job, sc, taken, header: E.Prompts.genHeader(sc, taken) };
  };
  const tokens = { player: 600, rooms: 700, plan: 400, cast: 700, castAll: 2400, ties: 700, extras: 500, opening: 900, lore: 650, setting: 450 };

  // One call (with up to TRIES attempts) → checked data. A failed check is
  // named in the next attempt; every attempt is logged on the job.
  // Also used by generated sites (task 4-4).
  GEN.attempt = (...a) => attempt(...a);
  async function attempt(ctx, kind, user, maxTokens, check) {
    let problem = null;
    for (let i = 1; i <= GEN.TRIES; i++) {
      let out;
      try {
        const raw = await E.LLM.chatJSON({
          kind, system: ctx.header, maxTokens, temperature: i === 1 ? 0.8 : 0.6,
          user: user + (problem ? `\n\nYour last reply had a problem: ${problem}. Fix it and reply again.` : ''),
        });
        out = check(raw);
      } catch (err) {
        out = { error: err.message };
      }
      ctx.job.log.push({ step: kind.replace(/^worldbuild \(start: |\)$/g, ''), attempt: i, error: out.error || null, warnings: out.warnings || [] });
      if (!out.error) return out;
      problem = out.error;
    }
    const err = new Error(`${kind.replace(/^worldbuild \(start: |\)$/g, '')}: ${problem}`);
    err.name = 'StepError';
    throw err;
  }

  // Runs one step. Progress: onProgress({ step, label, index, of }).
  GEN.runStep = async function (loaded, job, stepId, onProgress) {
    const ctx = GEN.context(loaded, job);
    const P = E.Prompts;
    const kind = (s) => `worldbuild (start: ${s})`;
    const say = (extra) => onProgress && onProgress(Object.assign({ step: stepId, label: GEN.STEPS.find((s) => s.id === stepId).label }, extra));
    say({});
    let out;
    if (stepId === 'cast' && !job.onePass) {
      const plan = job.steps.plan.people;
      job.partial.cast = job.partial.cast || [];
      for (let i = job.partial.cast.length; i < plan.length; i++) {
        say({ index: i + 1, of: plan.length });
        const one = await attempt(ctx, kind(`character ${i + 1}`), P.genStep(ctx, 'person', i), tokens.cast, (raw) => C.person(raw, ctx, i));
        job.partial.cast.push(one.character);
        if (onProgress) say({ index: i + 1, of: plan.length, saved: true });
      }
      out = { people: job.partial.cast };
    } else if (stepId === 'lore') {
      // Local lore never blocks the start (task 5-6): after the last try the
      // step is dropped with a note, and the start plays without it.
      try {
        out = await attempt(ctx, kind(stepId), P.genStep(ctx, stepId), tokens.lore, (raw) => C.lore(raw, ctx));
      } catch (err) {
        if (err.name !== 'StepError') throw err;
        out = { entries: [], dropped: err.message.replace(/^lore: /, '') };
      }
    } else {
      const max = stepId === 'cast' ? tokens.castAll : tokens[stepId];
      out = await attempt(ctx, kind(stepId), P.genStep(ctx, stepId), max, (raw) => C[stepId](raw, ctx));
    }
    delete out.warnings;
    job.steps[stepId] = out;
    delete job.partial[stepId];
    job.failed = null;
    return out;
  };

  // Runs every step not done yet, in order. Stops at the first that fails
  // (job.failed names it; the error is thrown). save(job) after each step.
  GEN.run = async function (loaded, job, opts) {
    const o = opts || {};
    for (let id = GEN.nextStep(job); id; id = GEN.nextStep(job)) {
      try {
        await GEN.runStep(loaded, job, id, o.onProgress);
      } catch (err) {
        job.failed = id;
        if (o.save) o.save(job);
        throw err;
      }
      if (o.save) o.save(job);
    }
    return job;
  };
  // Clears a step and every step after it, so the next run redoes them.
  GEN.clearFrom = function (job, stepId) {
    const order = GEN.order(job);
    order.slice(order.indexOf(stepId)).forEach((id) => { if (id !== 'player' || job.line) delete job.steps[id]; delete job.partial[id]; });
    job.failed = null;
    return job;
  };

  // ---------- review (task 4-3) ----------
  // Before playing, the player can edit any field and reroll one room, one
  // person, the pressures or the opening. Edits go through setField (one
  // field, checked now); reviewProblems checks the whole start the way Play
  // and Save will.
  const FIELDS = {
    room: { name: ['text', 40, true], desc: ['prose', 240, true] },
    person: {
      name: ['text', 40, true], pronouns: ['text', 20, false], role: ['text', 60, true], age: ['age'], traits: ['traits'], want: ['prose', 160, true],
      secret: ['prose', 300, false], guard: ['guard'], voice: ['prose', 160, false], appearance: ['prose', 400, false], description: ['prose', 600, false],
    },
    clock: { name: ['text', 40, true], max: ['int', 2, 24], perHour: ['num', 0.01, 1], fireText: ['prose', 240, true] },
    opening: { title: ['text', 60, true], summary: ['prose', 300, true], opening: ['opening'], facts: ['facts'] },
    setting: { setting: ['prose', 900, true], tags: ['tags'], toneNote: ['prose', 300, false] },
    lore: { title: ['text', 80, true], text: ['prose', 800, true], keywords: ['keywords'] },
  };
  GEN.FIELDS = FIELDS;
  // The object an edit changes: a room, a person (the player too), a
  // pressure, or the opening.
  GEN.target = function (job, kind, id) {
    const s = job.steps;
    if (kind === 'room') return s.rooms && s.rooms.rooms.find((r) => r.id === id);
    if (kind === 'person') return [GEN.player(job)].concat(GEN.people(job)).find((c) => c && c.id === id);
    if (kind === 'clock') return s.ties && GEN.clocks(job).find((c) => c.id === id);
    if (kind === 'opening') return s.opening;
    if (kind === 'setting') return s.setting;
    if (kind === 'lore') return s.lore && s.lore.entries.find((e) => e.id === id);
    return null;
  };
  // One field → { value } (stored) or { error } (nothing changed).
  GEN.setField = function (loaded, job, kind, id, field, value) {
    const obj = GEN.target(job, kind, id);
    const spec = FIELDS[kind] && FIELDS[kind][field];
    if (!obj || !spec) return { error: `nothing to change at ${kind} ${id || ''} ${field}` };
    const v = value == null ? '' : value;
    const [type, a, b] = spec;
    let out;
    if (type === 'text' || type === 'prose') {
      const t = String(v).replace(/\s+/g, ' ').trim();
      if (b && !t) return { error: 'This can\'t be empty.' };
      if (t.length > a) return { error: `At most ${a} characters (now ${t.length}).` };
      out = t;
    } else if (type === 'int' || type === 'num') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < a || n > b || (type === 'int' && !Number.isInteger(n))) return { error: `A ${type === 'int' ? 'whole number' : 'number'} from ${a} to ${b}.` };
      out = n;
    } else if (type === 'age') {
      if (String(v).trim() === '') out = null;
      else { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 129) return { error: 'A whole number from 1 to 129, or empty.' }; out = n; }
    } else if (type === 'guard') {
      if (!['low', 'medium', 'high'].includes(v)) return { error: 'low, medium or high' };
      out = v;
    } else if (type === 'tags') {
      const list = [...new Set(String(v).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
      if (list.length > GEN.SETTING.tags || list.some((t) => t.length > 40)) return { error: `Up to ${GEN.SETTING.tags} genre tags, separated by commas.` };
      out = list;
    } else if (type === 'traits') {
      const list = [...new Set(String(v).split(',').map((t) => t.trim()).filter(Boolean))];
      if (!list.length || list.length > 6) return { error: 'One to six traits, separated by commas.' };
      if (list.some((t) => t.length > 30)) return { error: 'Each trait at most 30 characters.' };
      out = list;
    } else if (type === 'facts') {
      const list = String(v).split(/\n+/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (list.length > 3 || list.some((t) => t.length > 200)) return { error: 'Up to 3 facts, one per line, 200 characters each.' };
      out = list;
    } else if (type === 'keywords') {
      const list = [...new Set(String(v).split(',').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
      if (list.length > E.Lore.LIMITS.keywords || list.some((t) => t.length > E.Lore.LIMITS.keyword)) return { error: `Up to ${E.Lore.LIMITS.keywords} keywords, separated by commas, ${E.Lore.LIMITS.keyword} characters each.` };
      out = list.length ? list : null;
    } else if (type === 'opening') {
      const t = String(v).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (t.split(/\s+/).filter(Boolean).length < 20) return { error: 'The opening needs at least a few sentences.' };
      out = t;
    }
    // Names stay unique; a person in the cast keeps a secret (the engine needs one).
    if (field === 'name' && kind === 'person') {
      const others = [GEN.player(job)].concat(GEN.people(job)).filter((c) => c.id !== id).map((c) => norm(c.name));
      if (others.includes(norm(out)) || GEN.taken(loaded).names.has(out)) return { error: 'Someone already has that name.' };
    }
    if (field === 'name' && kind === 'room' && job.steps.rooms.rooms.some((r) => r.id !== id && norm(r.name) === norm(out))) return { error: 'Another room has that name.' };
    if (field === 'secret' && kind === 'person' && !out && id !== GEN.player(job).id) return { error: 'Everyone here keeps a secret; write one.' };
    if (out === null || out === '') {
      delete obj[field];
      if (field === 'secret') delete obj.guard;
    } else {
      obj[field] = out;
      if (field === 'secret' && !obj.guard) obj.guard = 'medium';
    }
    return { value: out };
  };

  // Every pressure, follow-ups included.
  GEN.clocks = (job) => ((job.steps.ties && job.steps.ties.clocks) || []).flatMap((c) => [c].concat(c.then || []));

  // Everything that would stop Play or Save, in words: the same validation
  // as an authored start, plus the leaks the steps check.
  GEN.reviewProblems = function (loaded, job) {
    const problems = [];
    try { GEN.scenario(loaded, job); } catch (err) {
      problems.push(...String(err.message).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)));
      if (!problems.length) problems.push(err.message);
    }
    const ctx = { job, taken: GEN.taken(loaded) };
    const o = job.steps.opening;
    if (o) {
      const away = GEN.namesSomeoneElse(ctx, [o.opening].concat(o.facts).join('\n\n'));
      if (away) problems.push(`The opening or a fact names ${away}, who isn't in this start.`);
      const leak = GEN.leak(job, o.opening, 4);
      if (leak) problems.push(`The opening gives away ${leak.name}'s secret.`);
      o.facts.forEach((f) => { const who = GEN.leak(job, f, 4); if (who) problems.push(`A public fact gives away ${who.name}'s secret.`); });
    }
    GEN.clocks(job).forEach((c) => {
      const who = GEN.pressureLeak(job, c.name + '. ' + c.fireText);
      if (who) problems.push(`The pressure "${c.name}" gives away ${who.name}'s secret (pressures are shown to the player).`);
    });
    // Local lore (task 5-6), as edited: the same checks as the step.
    if (job.steps.lore && job.steps.lore.entries.length) {
      const full = GEN.context(loaded, job);
      job.steps.lore.entries.forEach((e) => { const why = GEN.loreProblem(full, e); if (why) problems.push(`Local lore "${e.title}" ${why}.`); });
    }
    return [...new Set(problems)];
  };

  // Rerolls one person: the same name, role and id (so ties, minor people and
  // the opening still point at them), a new sheet. Returns a note when the
  // ties or opening may now be out of date.
  GEN.rerollPerson = async function (loaded, job, id) {
    const people = job.steps.cast.people;
    const index = people.findIndex((c) => c.id === id);
    if (index < 0) throw new Error(`No one with the id "${id}" to reroll.`);
    const ctx = GEN.context(loaded, job);
    const plan = job.steps.plan.people.find((p) => norm(p.name) === norm(people[index].name)) || { name: people[index].name, role: people[index].role, age: people[index].age };
    const planIndex = job.steps.plan.people.indexOf(plan);
    const user = E.Prompts.genStep(Object.assign({}, ctx, { reroll: id }), 'person', planIndex >= 0 ? planIndex : 0);
    const others = new Set(people.filter((c) => c.id !== id).map((c) => c.id));
    const out = await attempt(ctx, `worldbuild (start: reroll ${people[index].name})`, user, tokens.cast, (raw) => {
      const r = GEN.cleanPerson(raw, plan, ctx, others);
      if (r.character) r.character.id = id; // the same person, written again
      return r;
    });
    people[index] = out.character;
    return { character: out.character, note: `Ties, private facts and the opening were written for the earlier ${out.character.name}; reroll them too if they no longer fit.` };
  };

  // Rerolls one room's name and description; its id and connections stay.
  GEN.rerollRoom = async function (loaded, job, roomId) {
    const room = job.steps.rooms.rooms.find((r) => r.id === roomId);
    if (!room) throw new Error(`No room "${roomId}" to reroll.`);
    const ctx = GEN.context(loaded, job);
    const out = await attempt(ctx, `worldbuild (start: reroll ${room.name})`, E.Prompts.genStep(ctx, 'room', roomId), tokens.extras, (raw) => C.room(raw, ctx, roomId));
    room.name = out.name;
    room.desc = out.desc;
    if (out.outside) room.outside = true; else delete room.outside;
    return room;
  };
  C.room = function (raw, ctx, roomId) {
    if (!isObj(raw)) return { error: 'reply with one JSON object' };
    const name = text(raw.name, 40);
    const desc = clip(raw.desc, 240);
    if (!name || !desc) return { error: 'give the room a "name" and a "desc"' };
    if (ctx.job.steps.rooms.rooms.some((r) => r.id !== roomId && norm(r.name) === norm(name))) return { error: `another room is already called "${name}"` };
    if (ctx.taken.names.has(name)) return { error: `"${name}" is already a place in this world` };
    return { name, desc, outside: raw.outside === true };
  };

  // Redoes one step and keeps the rest (the pressures, or the opening).
  GEN.redoOnly = async function (loaded, job, stepId) {
    if (!['ties', 'extras', 'opening', 'lore'].includes(stepId)) throw new Error(`"${stepId}" can't be redone on its own; use Redo, which redoes the steps after it too.`);
    return GEN.runStep(loaded, job, stepId);
  };

  // Takes one local lore entry out (task 5-6).
  GEN.removeLore = function (job, id) {
    const s = job.steps.lore;
    const i = s ? s.entries.findIndex((e) => e.id === id) : -1;
    if (i >= 0) s.entries.splice(i, 1);
    return i >= 0;
  };

  // The files "Save as start" writes, in the world format: world.json with
  // the start and the new people added to its lists, the start, and a
  // character file per new person.
  GEN.files = function (loaded, job) {
    const { start, characters } = GEN.toStart(loaded, job);
    const world = E.clone(loaded.bundle.world);
    world.starts = [...new Set((world.starts || []).concat(start.id))];
    world.characters = [...new Set((world.characters || []).concat(Object.keys(characters)))];
    const files = { 'world.json': world, [`starts/${start.id}.json`]: start };
    Object.values(characters).forEach((c) => { files[`characters/${c.id}.json`] = c; });
    return files;
  };

  // ---------- the result ----------
  // A finished job → { start, characters } in the authored formats.
  GEN.toStart = function (loaded, job) {
    if (!GEN.done(job)) throw new Error('This start is not finished yet.');
    const w = loaded.bundle.world;
    const g = w.generatedStarts || {};
    const s = job.steps;
    const def = loaded.defaultStart && loaded.bundle.starts[loaded.defaultStart];
    const pc = E.clone(s.player.character);
    pc.status = Object.assign({ health: 'ok' }, pc.status, { location: s.rooms.playerRoom });
    // The player's own feelings: from the form (none toward people made
    // later), so 0 for the generated cast.
    pc.relations = {};
    const people = s.cast.people.map((c) => E.clone(c));
    const all = [pc].concat(people);
    s.ties.relations.forEach((r) => { const c = all.find((x) => x.id === r.from); if (c) c.relations[r.to] = r.value; });
    s.ties.knows.forEach((k) => { const c = people.find((x) => x.id === k.id); if (c) (c.knows = c.knows || []).push(k.text); });
    (s.opening.withYou || []).forEach((id) => { const c = people.find((x) => x.id === id); if (c) c.status = Object.assign({}, c.status, { location: s.rooms.playerRoom }); });
    const start = {
      id: job.id, title: s.opening.title, summary: s.opening.summary, generated: true,
      start: E.clone(GEN.contextScenario(loaded, job.region).start),
      // The world the player described (customSetting) is the start's own setting.
      ...(s.setting ? Object.assign({ setting: s.setting.setting, tags: s.setting.tags.slice() }, s.setting.toneNote ? { toneNote: s.setting.toneNote } : {}) : {}),
      player: pc.id, castLabel: g.castLabel || (def && def.castLabel) || 'People',
      cast: all.map((c) => c.id),
      locations: s.rooms.rooms.map((r) => E.clone(r)),
      clocks: s.ties.clocks.map((c) => E.clone(c)),
      extras: s.extras.extras.map((x) => E.clone(x)),
      standees: s.extras.standees.map((x) => E.clone(x)),
      facts: s.opening.facts.slice(),
      opening: s.opening.opening,
    };
    if (job.region) start.region = job.region;
    // Local lore (task 5-6) is the start's own, so it is in the game's
    // scenario, its saves and Save as start.
    if (s.lore && s.lore.entries.length) start.lore = s.lore.entries.map((e) => E.clone(e));
    // The start's regional ideas replace the world's (a shallow merge), so the
    // world's own go after them.
    const ideas = (s.ties.events || []).map((t) => (job.region ? { text: t, region: job.region } : t));
    if (ideas.length) start.eventSeeds = { regional: ideas.concat(E.clone(((w.eventSeeds || {}).regional) || [])) };
    const characters = {};
    all.forEach((c) => { characters[c.id] = c; });
    return { start, characters };
  };

  // A finished job → a validated scenario, through the same checks as an
  // authored start (validateWorld, compose, validate).
  GEN.scenario = function (loaded, job) {
    const { start, characters } = GEN.toStart(loaded, job);
    const b = loaded.bundle;
    const world = E.clone(b.world);
    world.starts = (world.starts || []).concat(start.id);
    world.characters = (world.characters || []).concat(Object.keys(characters));
    const bundle = { world, starts: Object.assign({}, b.starts, { [start.id]: start }), characters: Object.assign({}, b.characters, characters), legacy: loaded.legacy, folder: loaded.folder, siteMaps: b.siteMaps };
    E.Scenario.validateWorld(bundle);
    return E.Scenario.validate(E.Scenario.compose(world, start, bundle.characters, loaded.folder, b.siteMaps));
  };
})(typeof window !== 'undefined' ? window : globalThis);
