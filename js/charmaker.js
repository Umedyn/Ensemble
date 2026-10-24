// The character creator (task 4-1). A start's "playerSlot" lets the player
// make their own character instead of (or as well as) the authored one. The
// form's values become the same character JSON an authored file holds, checked
// by Scenario.characterProblems like any other, and added to the composed
// scenario at New game. "Suggest" asks the model for one field; the page only
// offers what comes back. DOM-free, so the Node tests run it.
(function (root) {
  const E = root.Ensemble;
  const CM = (E.CharMaker = {});

  CM.SLOT_FIELDS = ['location', 'summary', 'knows', 'needs', 'roles', 'peoples', 'freeform', 'skillPoints', 'maxSkill', 'relationsDefault', 'castFeelings', 'keepDefault'];
  CM.MAX_SKILL = 4; // the cap for every character
  CM.LIMITS = { name: 40, pronouns: 20, role: 60, people: 60, description: 600, appearance: 400, trait: 30, traits: 6, voice: 160, want: 160, secret: 300 };
  CM.SUGGEST_FIELDS = ['traits', 'voice', 'description'];

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const ID = /^[a-z0-9][a-z0-9_-]*$/;
  const text = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

  // ---------- the slot ----------
  // The cast someone making their own character meets: the start's cast,
  // without the authored player unless the slot keeps them.
  CM.castFor = (sc) => (sc.characters || []).filter((id) => !(id === sc.player && !(sc.playerSlot && sc.playerSlot.keepDefault)));

  // Problems with a composed scenario's playerSlot (S.validate calls this).
  CM.slotProblems = function (sc) {
    const slot = sc.playerSlot;
    if (slot == null) return [];
    if (!isObj(slot)) return ['"playerSlot" must be an object with "location", "roles", "skillPoints" and "maxSkill"'];
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push('playerSlot: ' + msg); };
    const skills = sc.skills || [];
    const locIds = new Set((sc.locations || []).map((l) => l && l.id));
    const cast = CM.castFor(sc);
    Object.keys(slot).filter((k) => !CM.SLOT_FIELDS.includes(k)).forEach((k) => req(false, `unknown field "${k}"`));
    req(locIds.has(slot.location), `"location" must be one of the start's rooms (got "${slot.location}")`);
    req(slot.summary == null || (typeof slot.summary === 'string' && slot.summary.length <= 400), '"summary" must be text of at most 400 characters');
    req(slot.knows == null || (Array.isArray(slot.knows) && slot.knows.every((t) => typeof t === 'string' && t.trim())), '"knows" must be a list of facts (text)');
    req(slot.needs == null || (isObj(slot.needs) && Object.entries(slot.needs).every(([k, v]) => (sc.needs || []).some((n) => n.id === k) && typeof v === 'number' && v >= 0 && v <= 1)),
      '"needs" must map the world\'s needs to numbers from 0 to 1');
    req(slot.freeform == null || typeof slot.freeform === 'boolean', '"freeform" must be true or false');
    req(slot.keepDefault == null || typeof slot.keepDefault === 'boolean', '"keepDefault" must be true or false');
    req(Number.isInteger(slot.maxSkill) && slot.maxSkill >= 1 && slot.maxSkill <= CM.MAX_SKILL, `"maxSkill" must be a whole number from 1 to ${CM.MAX_SKILL}`);
    req(Number.isInteger(slot.skillPoints) && slot.skillPoints >= 0, '"skillPoints" must be a whole number (0 or more)');
    const choices = (key, withSkills) => {
      const list = slot[key];
      if (list == null) return;
      if (!Array.isArray(list)) return req(false, `"${key}" must be a list of {id, label, desc}`);
      const seen = new Set();
      list.forEach((r) => {
        const where = `${key} "${(r && r.id) || '?'}"`;
        if (!isObj(r)) return req(false, `"${key}" must be a list of {id, label, desc}`);
        req(typeof r.id === 'string' && ID.test(r.id), `${where}: "id" must be lowercase letters, digits, - or _`);
        req(!seen.has(r.id), `${where} is listed twice`);
        seen.add(r.id);
        req(typeof r.label === 'string' && r.label.trim() && r.label.length <= CM.LIMITS.role, `${where}: "label" must be text of at most ${CM.LIMITS.role} characters`);
        req(r.desc == null || (typeof r.desc === 'string' && r.desc.length <= 300), `${where}: "desc" must be text of at most 300 characters`);
        req(r.suggestedTraits == null || (Array.isArray(r.suggestedTraits) && r.suggestedTraits.every((t) => typeof t === 'string' && t.trim() && t.length <= CM.LIMITS.trait)),
          `${where}: "suggestedTraits" must be a list of short traits (${CM.LIMITS.trait} characters each)`);
        if (!withSkills) return req(r.skills == null, `${where}: only roles have "skills"`);
        if (r.skills == null) return;
        if (!isObj(r.skills)) return req(false, `${where}: "skills" must map skills to numbers`);
        Object.entries(r.skills).forEach(([k, v]) => {
          req(skills.includes(k), `${where}: skill "${k}" is not one of the world's skills`);
          req(Number.isInteger(v) && v >= 0 && v <= slot.maxSkill, `${where}: skill "${k}" must be a whole number from 0 to maxSkill (${slot.maxSkill})`);
        });
        req(CM.pointsUsed(r.skills) <= slot.skillPoints, `${where}: its skills use ${CM.pointsUsed(r.skills)} points, more than skillPoints (${slot.skillPoints})`);
      });
    };
    choices('roles', true);
    choices('peoples', false);
    req((Array.isArray(slot.roles) && slot.roles.length) || slot.freeform === true, 'needs at least one entry in "roles", or "freeform": true');
    ['relationsDefault', 'castFeelings'].forEach((k) => {
      const v = slot[k];
      if (v == null || typeof v === 'number') return req(v == null || (v >= -100 && v <= 100), `"${k}" must be from -100 to 100`);
      if (!isObj(v)) return req(false, `"${k}" must be a number or {character id: number}`);
      Object.entries(v).forEach(([id, n]) => {
        req(cast.includes(id), `"${k}" names "${id}", who isn't in this start's cast`);
        req(typeof n === 'number' && n >= -100 && n <= 100, `"${k}.${id}" must be from -100 to 100`);
      });
    });
    return problems;
  };

  // A slot's feeling value toward (or from) one cast member.
  const feelingFor = (v, id) => E.clamp(Math.round(Number(typeof v === 'number' ? v : isObj(v) ? v[id] || 0 : 0) || 0), -100, 100);

  // ---------- skills (point-buy) ----------
  CM.pointsUsed = (skills) => Object.values(skills || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
  CM.pointsLeft = (sc, skills) => sc.playerSlot.skillPoints - CM.pointsUsed(skills);
  // Every world skill, from the role's preset (0 for the rest).
  CM.roleSkills = function (sc, roleId) {
    const role = (sc.playerSlot.roles || []).find((r) => r.id === roleId);
    const out = {};
    sc.skills.forEach((k) => { out[k] = (role && role.skills && role.skills[k]) || 0; });
    return out;
  };
  // Problems with a set of skills against the slot's limits (refused, never clamped).
  CM.skillProblems = function (sc, skills) {
    const slot = sc.playerSlot;
    const problems = [];
    Object.entries(skills || {}).forEach(([k, v]) => {
      if (!sc.skills.includes(k)) problems.push(`"${k}" is not one of this world's skills`);
      else if (!Number.isInteger(v) || v < 0 || v > slot.maxSkill) problems.push(`${k} must be from 0 to ${slot.maxSkill}`);
    });
    const used = CM.pointsUsed(skills);
    if (used > slot.skillPoints) problems.push(`skills use ${used} points; you have ${slot.skillPoints}`);
    return problems;
  };

  // ---------- the form ----------
  // A blank form for a start: the first role and people, the role's skills,
  // the slot's feelings, a stand-in portrait.
  CM.defaults = function (sc) {
    const slot = sc.playerSlot;
    const role = (slot.roles || [])[0];
    const feelings = {};
    CM.castFor(sc).forEach((id) => { feelings[id] = feelingFor(slot.relationsDefault, id); });
    return {
      name: '', pronouns: 'they/them', age: null,
      role: role ? role.id : '', roleText: '', people: slot.peoples && slot.peoples.length ? slot.peoples[0].id : '', peopleText: '',
      description: '', appearance: '', traits: [], voice: '', want: '', secret: '', guard: 'medium',
      skills: CM.roleSkills(sc, role && role.id), portrait: 'standin', feelings,
    };
  };

  // Trait ideas from the chosen role and people.
  CM.suggestedTraits = function (sc, form) {
    const slot = sc.playerSlot;
    const pick = (list, id) => ((list || []).find((r) => r.id === id) || {}).suggestedTraits || [];
    return [...new Set([...pick(slot.roles, form.role), ...pick(slot.peoples, form.people)])];
  };

  // An id from the name: lowercase words joined by "-", made unique against
  // every character, extra, group and room in the scenario.
  CM.slugId = function (sc, name) {
    const base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/^(dr|mr|mrs|ms|mx|prof)\.?\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'me';
    const taken = new Set([].concat(sc.reservedIds || [], sc.characters || [], (sc.extras || []).map((x) => x && x.id), (sc.standees || []).map((x) => x && x.id),
      (sc.locations || []).map((l) => l && l.id), (sc.regions || []).map((r) => r && r.id), (sc.factions || []).map((f) => f && f.id)));
    let id = ID.test(base) ? base : 'me';
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  };

  // The form → { character } or { errors: [...] }, in plain language. The
  // character is checked like an authored file.
  CM.build = function (sc, form) {
    const slot = sc.playerSlot;
    const errors = [];
    const f = form || {};
    const L = CM.LIMITS;
    const name = text(f.name, 200);
    if (!name) errors.push('Give your character a name.');
    else if (name.length > L.name) errors.push(`The name can be at most ${L.name} characters.`);
    const pick = (list, id, free, label) => {
      const hit = (list || []).find((r) => r.id === id);
      if (hit) return hit.label;
      if (slot.freeform && text(free, L.role)) return text(free, L.role);
      if ((list || []).length) errors.push(`Pick a ${label}${slot.freeform ? ', or write your own' : ''}.`);
      return '';
    };
    const role = pick(slot.roles, f.role, f.roleText, 'role');
    if (!role && !(slot.roles || []).length) errors.push('Write your role.');
    const people = slot.peoples && slot.peoples.length ? pick(slot.peoples, f.people, f.peopleText, 'people') : slot.freeform ? text(f.peopleText, L.people) : '';
    const want = text(f.want, L.want + 1);
    if (!want) errors.push('Say what your character wants.');
    else if (want.length > L.want) errors.push(`"Wants" can be at most ${L.want} characters.`);
    [['description', 'The description'], ['appearance', 'Appearance'], ['voice', 'Voice'], ['secret', 'The secret']].forEach(([k, label]) => {
      if (typeof f[k] === 'string' && f[k].replace(/\s+/g, ' ').trim().length > L[k]) errors.push(`${label} can be at most ${L[k]} characters.`);
    });
    const traits = [...new Set((Array.isArray(f.traits) ? f.traits : []).map((t) => text(t, 200)).filter(Boolean))];
    if (!traits.length) errors.push('Add at least one trait.');
    if (traits.length > L.traits) errors.push(`Use at most ${L.traits} traits.`);
    if (traits.some((t) => t.length > L.trait)) errors.push(`Each trait can be at most ${L.trait} characters.`);
    const skills = {};
    sc.skills.forEach((k) => { skills[k] = Number((f.skills || {})[k]) || 0; });
    Object.keys(f.skills || {}).forEach((k) => { if (!(k in skills)) skills[k] = f.skills[k]; });
    CM.skillProblems(sc, skills).forEach((p) => errors.push(p[0].toUpperCase() + p.slice(1) + '.'));
    const age = f.age == null || f.age === '' ? null : Math.round(Number(f.age));
    if (age != null && !(age > 0 && age < 130)) errors.push('Age must be a number from 1 to 129, or left empty.');
    let portrait;
    if (f.portrait === 'none') portrait = false;
    else if (f.portrait && f.portrait !== 'standin') {
      if ((sc.portraitSet || []).includes(f.portrait)) portrait = f.portrait;
      else errors.push('Pick a portrait from the list.');
    }
    if (errors.length) return { errors };

    const id = CM.slugId(sc, name);
    const c = {
      id, name, pronouns: text(f.pronouns, L.pronouns) || 'they/them', role: role || people,
      traits, want, skills, relations: {}, status: { health: 'ok', location: slot.location },
    };
    if (people && role) c.people = people;
    if (age != null) c.age = age;
    ['description', 'appearance', 'voice'].forEach((k) => { const v = text(f[k], L[k]); if (v) c[k] = v; });
    const secret = text(f.secret, L.secret);
    if (secret) {
      c.secret = secret;
      c.guard = ['low', 'medium', 'high'].includes(f.guard) ? f.guard : 'medium';
    }
    if (portrait !== undefined) c.portrait = portrait;
    if (slot.needs) c.needs = E.clone(slot.needs);
    if (slot.knows && slot.knows.length) c.knows = slot.knows.slice();
    const cast = CM.castFor(sc);
    cast.forEach((other) => {
      const v = f.feelings && f.feelings[other] != null ? f.feelings[other] : feelingFor(slot.relationsDefault, other);
      c.relations[other] = E.clamp(Math.round(Number(v) || 0), -100, 100);
    });
    const locIds = new Set((sc.locations || []).map((l) => l.id));
    const problems = E.Scenario.characterProblems(c, sc, locIds, cast.concat(id));
    return problems.length ? { errors: problems } : { character: c };
  };

  // The composed scenario with the made character as the player: the
  // authored player leaves the cast (unless keepDefault), everyone's
  // feelings toward the newcomer come from castFeelings. Validated.
  CM.withPlayer = function (scenario, character) {
    const sc = E.clone(scenario);
    const slot = sc.playerSlot;
    if (!slot) throw new Error('This start has no player slot, so you play the character it gives you.');
    const c = E.clone(character);
    const cast = CM.castFor(sc);
    sc.characterData = sc.characterData.filter((d) => cast.includes(d.id));
    sc.characters = cast.slice();
    sc.characterData.forEach((d) => {
      d.relations = Object.assign({}, d.relations);
      Object.keys(d.relations).forEach((k) => { if (!cast.includes(k)) delete d.relations[k]; });
      d.relations[c.id] = feelingFor(slot.castFeelings, d.id);
    });
    sc.characters.unshift(c.id);
    sc.characterData.unshift(c);
    sc.player = c.id;
    sc.madePlayer = c.id;
    return E.Scenario.validate(sc);
  };

  // A character that fills the slot with its defaults, for checking a start
  // when the world loads (Scenario.prepareWorld).
  CM.sample = function (sc) {
    const f = CM.defaults(sc);
    Object.assign(f, { name: 'Sample Person', want: 'get through the day', traits: ['curious'], roleText: 'newcomer', peopleText: 'local' });
    const out = CM.build(sc, f);
    if (out.errors) throw new Error('playerSlot: a character made with the defaults fails: ' + out.errors.join(' '));
    return out.character;
  };

  // A character file read back in (a saved character, or any character JSON)
  // → form values for this start. Unknown roles become free text.
  CM.formFrom = function (sc, data) {
    const f = CM.defaults(sc);
    if (!isObj(data)) return f;
    const slot = sc.playerSlot;
    ['name', 'pronouns', 'description', 'appearance', 'voice', 'want', 'secret'].forEach((k) => { if (typeof data[k] === 'string') f[k] = data[k]; });
    if (['low', 'medium', 'high'].includes(data.guard)) f.guard = data.guard;
    if (Number.isFinite(data.age)) f.age = data.age;
    if (Array.isArray(data.traits)) f.traits = data.traits.filter((t) => typeof t === 'string');
    const match = (list, label) => (list || []).find((r) => r.label.toLowerCase() === String(label || '').toLowerCase());
    const role = match(slot.roles, data.role);
    if (role) f.role = role.id; else if (data.role) { f.role = ''; f.roleText = String(data.role); }
    const people = match(slot.peoples, data.people);
    if (people) f.people = people.id; else if (data.people) { f.people = ''; f.peopleText = String(data.people); }
    if (isObj(data.skills)) sc.skills.forEach((k) => { f.skills[k] = Number.isInteger(data.skills[k]) ? data.skills[k] : 0; });
    if (data.portrait === false) f.portrait = 'none';
    else if ((sc.portraitSet || []).includes(data.portrait)) f.portrait = data.portrait;
    Object.keys(f.feelings).forEach((id) => { if (isObj(data.relations) && typeof data.relations[id] === 'number') f.feelings[id] = data.relations[id]; });
    return f;
  };

  // The character as a file to keep: what an authored character file holds,
  // without play state.
  CM.toFile = function (c) {
    const keep = ['id', 'name', 'pronouns', 'role', 'people', 'age', 'traits', 'want', 'secret', 'guard', 'voice', 'description', 'appearance', 'portrait', 'skills', 'relations'];
    const out = {};
    keep.forEach((k) => { if (c[k] !== undefined) out[k] = E.clone(c[k]); });
    return out;
  };

  // ---------- the author's editor (task 6-2) ----------
  // The creator edits the world's people with the same form in author mode:
  // free role and people text, no point budget (only the 0–4 cap), feelings
  // toward everyone in the pool, and the fields a player never sets (what
  // they know, an agenda, the default tier, tags, lore topics, needs). base: a composed
  // start of the world (its header for Suggest), or null; pool: {id: file}.
  CM.authorScenario = function (world, base, pool, editingId) {
    const sc = E.clone(base || {
      title: world.title, worldTitle: world.title, setting: world.setting || '', rules: world.rules || [], tags: world.tags || [],
      skills: world.skills, needs: world.needs || [], world: world.world || {}, factions: world.factions || [], regions: world.regions, loreTopics: world.loreTopics,
      locations: [{ id: 'here', name: 'Here', desc: '', connects: [] }], start: { day: 1, hour: 8 }, timeLabel: world.timeLabel,
    });
    sc.skills = sc.skills || E.DEFAULT_SKILLS.slice();
    sc.portraitSet = (world.portraitSet || []).slice();
    const room = ((sc.locations || [])[0] || {}).id;
    const others = Object.keys(pool).filter((id) => id !== editingId && pool[id]);
    sc.characters = others;
    sc.characterData = others.map((id) => Object.assign(E.clone(pool[id]), { id, status: Object.assign({ health: 'ok' }, pool[id].status, { location: room }) }));
    delete sc.player;
    sc.playerSlot = { location: room, freeform: true, roles: [], peoples: [], skillPoints: sc.skills.length * CM.MAX_SKILL, maxSkill: CM.MAX_SKILL };
    sc.reservedIds = Object.keys(pool).filter((id) => id !== editingId);
    sc.author = true;
    return sc;
  };
  // A character file → author form values (formFrom plus the author fields).
  CM.authorForm = function (sc, data) {
    const d = isObj(data) ? data : {};
    const f = CM.formFrom(sc, d);
    f.id = d.id || '';
    if (typeof d.portrait === 'string' && E.isImagePath(d.portrait)) f.portrait = d.portrait;
    f.knows = Array.isArray(d.knows) ? d.knows.filter((x) => typeof x === 'string') : [];
    f.agendaMode = d.agenda === undefined ? 'model' : d.agenda === null ? 'none' : 'set';
    const a = isObj(d.agenda) ? d.agenda : {};
    f.agenda = {
      goal: typeof a.goal === 'string' ? a.goal : '', hours: Number.isFinite(a.hours) ? a.hours : null, visibility: a.visibility || '',
      steps: (Array.isArray(a.steps) ? a.steps : []).map((s) => (typeof s === 'string' ? { text: s, contact: false } : { text: String((s && s.text) || ''), contact: !!(s && s.contact) })),
    };
    f.tier = ['local', 'secondary'].includes(d.tier) ? d.tier : '';
    f.pinned = d.pinned === true;
    f.tags = Array.isArray(d.tags) ? d.tags.filter((x) => typeof x === 'string') : [];
    f.topics = Array.isArray(d.topics) ? d.topics.filter((x) => typeof x === 'string') : [];
    f.needs = isObj(d.needs) ? Object.assign({}, d.needs) : {};
    return f;
  };
  // The form → { character } (a pool file) or { errors }. original: the file
  // being edited; fields the form doesn't show (status, anything newer) are
  // kept, and an unchanged file comes back as it was.
  CM.buildAuthor = function (sc, form, original) {
    const f = form || {};
    const scb = E.clone(sc);
    if (typeof f.portrait === 'string' && E.isImagePath(f.portrait) && !scb.portraitSet.includes(f.portrait)) scb.portraitSet.push(f.portrait);
    const out = CM.build(scb, f);
    if (out.errors) return out;
    const made = out.character;
    const o = isObj(original) ? original : {};
    const c = E.clone(o);
    const set = (k, v) => {
      const empty = v === undefined || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
      if (empty) delete c[k]; else c[k] = v;
    };
    c.id = f.id || made.id;
    ['name', 'pronouns', 'role', 'traits', 'want'].forEach((k) => (c[k] = made[k]));
    ['people', 'age', 'description', 'appearance', 'voice', 'secret'].forEach((k) => set(k, made[k]));
    if (made.secret) c.guard = made.guard;
    if (made.portrait === undefined) delete c.portrait; else c.portrait = made.portrait;
    const keep = (from, had) => {
      const r = {};
      Object.entries(from).forEach(([k, v]) => { if (v !== 0 || (isObj(had) && k in had)) r[k] = v; });
      return r;
    };
    set('skills', keep(made.skills, o.skills));
    set('relations', keep(made.relations, o.relations));
    set('knows', (f.knows || []).map((x) => text(x, 400)).filter(Boolean));
    if (f.agendaMode === 'model') delete c.agenda;
    else if (f.agendaMode === 'none') c.agenda = null;
    else {
      const a = f.agenda || {};
      const ag = { goal: text(a.goal, 200), steps: (a.steps || []).map((s) => ({ text: text(s.text, 200), contact: !!s.contact })).filter((s) => s.text).map((s) => (s.contact ? s : s.text)) };
      if (Number.isFinite(Number(a.hours)) && a.hours !== null && a.hours !== '') ag.hours = Number(a.hours);
      if (a.visibility) ag.visibility = a.visibility;
      c.agenda = ag;
    }
    set('tier', f.tier || undefined);
    set('pinned', f.pinned ? true : undefined);
    set('tags', (f.tags || []).map((x) => text(x, 100)).filter(Boolean));
    set('topics', [...new Set((f.topics || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))]);
    const needs = {};
    const errors = [];
    Object.entries(f.needs || {}).forEach(([k, v]) => {
      if (v === '' || v == null) return;
      if (!(sc.needs || []).some((n) => n.id === k)) return;
      const n = Number(v);
      if (!(n >= 0 && n <= 1)) errors.push(`Starting ${k} must be from 0 to 1.`);
      else needs[k] = n;
    });
    set('needs', needs);
    const locIds = new Set((sc.locations || []).map((l) => l.id));
    const check = Object.assign({}, c, { status: Object.assign({}, c.status, { location: sc.playerSlot.location }) });
    errors.push(...E.Scenario.characterProblems(check, sc, locIds, sc.characters.concat(c.id)));
    return errors.length ? { errors } : { character: c };
  };

  // ---------- Suggest (one field from the model) ----------
  // A game state for the draft, so the prompt header is the one the game
  // will use (and KoboldCpp's cache is warm for the first turn). Missing
  // name or want get placeholders; nothing here is kept.
  CM.draftState = function (sc, form) {
    const f = Object.assign({}, form);
    if (!text(f.name, 40)) f.name = 'the new character';
    if (!text(f.want, 160)) f.want = '(not decided yet)';
    if (!(f.traits || []).length) f.traits = ['(not decided yet)'];
    if (!f.role && !text(f.roleText, 60) && !(sc.playerSlot.roles || []).length) f.roleText = 'newcomer';
    const out = CM.build(sc, f);
    const c = out.character || Object.assign(CM.sample(sc), { name: text(f.name, 40) || 'the new character' });
    const scen = E.clone(sc);
    const cast = CM.castFor(scen);
    scen.characterData = scen.characterData.filter((d) => cast.includes(d.id));
    scen.characters = [c.id].concat(cast);
    scen.characterData.unshift(c);
    scen.player = c.id;
    return E.Engine.newGame(scen);
  };
  CM.suggest = async function (sc, field, form) {
    if (!CM.SUGGEST_FIELDS.includes(field)) throw new Error(`Nothing to suggest for "${field}".`);
    const state = CM.draftState(sc, form);
    const raw = await E.LLM.chatJSON({
      kind: 'worldbuild (character)', system: E.Prompts.header(state), user: E.Prompts.charSuggest(state, field, form),
      maxTokens: field === 'description' ? 220 : 120, temperature: 0.9,
    });
    const out = CM.cleanSuggestion(field, raw, form);
    if (out.error) throw new Error(`The model's suggestion didn't fit (${out.error}). Try again.`);
    return out.value;
  };
  // The model's reply → { value } or { error }. Traits: new ones only, short,
  // no repeats; text fields: one paragraph within the field's limit.
  CM.cleanSuggestion = function (field, raw, form) {
    const obj = isObj(raw) ? raw : {};
    if (field === 'traits') {
      const have = new Set(((form && form.traits) || []).map((t) => String(t).toLowerCase()));
      const list = (Array.isArray(obj.traits) ? obj.traits : Array.isArray(raw) ? raw : [])
        .map((t) => text(typeof t === 'string' ? t : '', 100).replace(/^["“']+|["”'.]+$/g, '').toLowerCase())
        .filter((t) => t && t.length <= CM.LIMITS.trait && !have.has(t));
      const value = [...new Set(list)].slice(0, 5);
      return value.length ? { value } : { error: 'no usable traits' };
    }
    const v = text(typeof obj[field] === 'string' ? obj[field] : typeof raw === 'string' ? raw : '', 2000).replace(/^["“]+|["”]+$/g, '');
    if (!v) return { error: `no "${field}"` };
    if (v.length > CM.LIMITS[field]) return { error: `longer than ${CM.LIMITS[field]} characters` };
    return { value: v };
  };
})(typeof window !== 'undefined' ? window : globalThis);
