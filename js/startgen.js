// Generated starts (task 4-2). A world with "generatedStarts" lets the
// player build a start instead of picking one: a region, a character (the
// 4-1 form, or a line the model turns into a sheet) and an optional note go
// in; a pipeline of small worldbuild calls comes out, each checked before
// the next: rooms → who is here → the people → ties and pressures → minor
// people and groups → the opening. The result is a normal start (plus its
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
    { id: 'player', label: 'Your character' },
    { id: 'rooms', label: 'Places' },
    { id: 'plan', label: 'Who is here' },
    { id: 'cast', label: 'Characters' },
    { id: 'ties', label: 'Ties and pressures' },
    { id: 'extras', label: 'Minor people and groups' },
    { id: 'opening', label: 'Opening scene' },
  ];
  GEN.TRIES = 3; // one call plus two reruns with the problem named
  GEN.PLAYER_FEELING = 25; // the cast has only just met the player
  GEN.PLURAL = /\b(couple|family|pair|twins|group|kids|children|people|men|women|survivors|neighbou?rs|brothers|sisters)\b/i;
  GEN.CONFIG_FIELDS = ['start', 'roles', 'skillPoints', 'maxSkill', 'castSize', 'castLabel'];

  // ---------- the world's settings ----------
  GEN.configProblems = function (world) {
    const g = world.generatedStarts;
    if (!isObj(g)) return ['"generatedStarts" must be an object with "skillPoints" and "maxSkill"'];
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push('generatedStarts: ' + msg); };
    Object.keys(g).filter((k) => !GEN.CONFIG_FIELDS.includes(k)).forEach((k) => req(false, `unknown field "${k}"`));
    req(g.start == null || (isObj(g.start) && Number.isFinite(g.start.day) && Number.isFinite(g.start.hour)), '"start" must be {day, hour}');
    req(g.castSize == null || (Array.isArray(g.castSize) && g.castSize.length === 2 && g.castSize.every((n) => Number.isInteger(n) && n >= 1 && n <= 8) && g.castSize[0] <= g.castSize[1]),
      '"castSize" must be [fewest, most], whole numbers from 1 to 8');
    req(g.castLabel == null || (typeof g.castLabel === 'string' && g.castLabel.length <= 30), '"castLabel" must be short text');
    // Roles and point-buy work like a start's playerSlot (task 4-1).
    const sc = { skills: world.skills || [], needs: world.needs || [], locations: [{ id: '__here' }], characters: [], playerSlot: GEN.slot(world, '__here') };
    E.CharMaker.slotProblems(sc).forEach((p) => problems.push(p.replace(/^playerSlot: /, 'generatedStarts: ')));
    return problems;
  };
  GEN.slot = (world, location) => {
    const g = world.generatedStarts || {};
    return { location, roles: g.roles || [], freeform: true, skillPoints: g.skillPoints, maxSkill: g.maxSkill };
  };
  // Regions marked startable, or every region when none is.
  GEN.regions = function (world) {
    const all = (world.regions || []).filter(isObj);
    const marked = all.filter((r) => r.startable === true);
    return marked.length ? marked : all;
  };

  // The world composed with an empty start in a region: the context every
  // step sees (setting, rules, regions, groups), and what the 4-1 form needs.
  GEN.contextScenario = function (loaded, region) {
    const w = loaded.bundle.world;
    const sc = E.Scenario.compose(w, { id: 'generated', cast: [], region }, {}, loaded.folder);
    sc.skills = sc.skills || ['physical', 'technical', 'social', 'knowledge', 'stealth'];
    sc.needs = sc.needs || [];
    // The date: the world's setting for generated starts, else the default start's.
    const def = loaded.defaultStart && loaded.bundle.starts[loaded.defaultStart];
    sc.start = E.clone((w.generatedStarts && w.generatedStarts.start) || (def && def.start) || { day: 1, hour: 8 });
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
    return { ids, names, people };
  };

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
    return {
      v: 1, world: loaded.id, folder: loaded.folder, id: 'gen-' + Math.random().toString(36).slice(2, 8),
      region, note: text(o.note, 400), line: o.character ? '' : text(o.line, 300),
      onePass: o.onePass != null ? !!o.onePass : !E.LLM.backendFor('worldbuild').kobold,
      steps: o.character ? { player: { character: E.clone(o.character) } } : {},
      partial: {}, log: [], failed: null,
    };
  };
  GEN.order = (job) => GEN.STEPS.filter((s) => s.id !== 'player' || job.line || (job.steps.player && job.steps.player.character)).map((s) => s.id);
  GEN.done = (job) => GEN.order(job).every((id) => job.steps[id]);
  GEN.nextStep = (job) => GEN.order(job).find((id) => !job.steps[id]) || null;

  // ---------- what earlier steps made, for later prompts ----------
  GEN.player = (job) => job.steps.player && job.steps.player.character;
  GEN.people = (job) => (job.steps.cast ? job.steps.cast.people : []);

  // ---------- step checkers ----------
  // Each turns the model's reply into checked data, or { error } in words
  // the next try can be told. ctx: { loaded, job, sc, taken }.
  const C = (GEN.check = {});

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

  const castSize = (ctx) => (ctx.loaded.bundle.world.generatedStarts.castSize || [3, 5]);
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
      const hook = clip(p.hook, 160);
      // The player's past is theirs (rule 3; playtest-12b: "Sarah Thompson,
      // teenage daughter of Emma Thompson", who had never met anyone here).
      const surname = (n) => String(n).trim().split(/\s+/).pop().toLowerCase();
      if (pc && String(pc.name).trim().split(/\s+/).length > 1 && String(name).trim().split(/\s+/).length > 1 && surname(name) === surname(pc.name)) return { error: `${name} shares the player's surname; don't make anyone the player's family (the player's story is theirs)` };
      if (GEN.namesPlayer(ctx.job, role + ' ' + hook)) return { error: `${name}'s role ties them to the player; leave the player's past to the player` };
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
    if (GEN.namesPlayer(ctx.job, prose)) return { error: `the sheet for ${plan.name} decides things about the player; leave the player out of it` };
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

  // ---------- running ----------
  GEN.context = function (loaded, job) {
    const sc = GEN.contextScenario(loaded, job.region);
    const taken = GEN.taken(loaded);
    return { loaded, job, sc, taken, header: E.Prompts.genHeader(sc, taken) };
  };
  const tokens = { player: 600, rooms: 700, plan: 400, cast: 700, castAll: 2400, ties: 700, extras: 500, opening: 900 };

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
    } else if (type === 'traits') {
      const list = [...new Set(String(v).split(',').map((t) => t.trim()).filter(Boolean))];
      if (!list.length || list.length > 6) return { error: 'One to six traits, separated by commas.' };
      if (list.some((t) => t.length > 30)) return { error: 'Each trait at most 30 characters.' };
      out = list;
    } else if (type === 'facts') {
      const list = String(v).split(/\n+/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (list.length > 3 || list.some((t) => t.length > 200)) return { error: 'Up to 3 facts, one per line, 200 characters each.' };
      out = list;
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
    if (!['ties', 'extras', 'opening'].includes(stepId)) throw new Error(`"${stepId}" can't be redone on its own; use Redo, which redoes the steps after it too.`);
    return GEN.runStep(loaded, job, stepId);
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
    const g = w.generatedStarts;
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
    const bundle = { world, starts: Object.assign({}, b.starts, { [start.id]: start }), characters: Object.assign({}, b.characters, characters), legacy: loaded.legacy, folder: loaded.folder };
    E.Scenario.validateWorld(bundle);
    return E.Scenario.validate(E.Scenario.compose(world, start, bundle.characters, loaded.folder, b.siteMaps));
  };
})(typeof window !== 'undefined' ? window : globalThis);
