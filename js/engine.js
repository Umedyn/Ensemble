// Game state + turn loop. The engine owns every fact; the model only proposes.
(function (root) {
  const E = root.Ensemble;
  const Eng = (E.Engine = {});
  const HEALTH = ['ok', 'hurt', 'badly_hurt', 'dead'];
  const DC = { easy: 8, normal: 12, hard: 16 };
  const MOODS = /^(stressed|anxious|nervous|scared|afraid|fearful|worried|angry|upset|sad|happy|guilty|tense|tired|hungry|exhausted|frustrated|calm|relieved|panicked|on edge)$/;

  // ---------- setup ----------
  Eng.newGame = function (scenario) {
    const sc = E.clone(scenario);
    if (sc.worldId == null) sc.worldId = sc.folder || sc.id;
    if (sc.startId == null) sc.startId = 'default';
    const state = {
      version: Eng.STATE_VERSION,
      scenario: sc,
      player: sc.player,
      order: sc.characters.slice(),
      characters: {},
      locations: {},
      world: Object.assign({}, sc.world || {}),
      factions: (sc.factions || []).map((f) => Object.assign({}, f)),
      clocks: (sc.clocks || []).map((c) => Object.assign({ value: 0, perHour: 0, fired: false }, c)),
      time: { day: sc.start?.day ?? 1, hour: sc.start?.hour ?? 8 },
      turn: 0,
      chapter: 1,
      chapterStartTurn: 1,
      facts: [],
      nextFactId: 1,
      chapters: [],
      recent: [],
      log: [],
      flags: { chapterWorthy: false, gameOver: false },
      tierLast: {},
      news: [],
      regions: {},
    };
    // Regions (task 3-1): what changes in play; the definition stays in the scenario.
    (sc.regions || []).forEach((r) => { state.regions[r.id] = { controller: r.controller ?? null, tags: (r.tags || []).slice(), status: r.status || '' }; });
    (sc.locations || []).forEach((l) => (state.locations[l.id] = Object.assign({ connects: [] }, l)));
    sc.characterData.forEach((raw) => {
      const c = E.clone(raw);
      c.needs = c.needs || {};
      sc.needs.forEach((n) => { if (c.needs[n.id] == null) c.needs[n.id] = 0.2; });
      c.status = Object.assign({ health: 'ok' }, c.status || {});
      // Authored conditions and tags last until the story removes them.
      c.tags = [...new Set([].concat(c.status.conditions || [], raw.tags || []).map(String))].map((text) => ({ text, set: 0, until: null }));
      delete c.status.conditions;
      c.relations = c.relations || {};
      c.skills = c.skills || {};
      if (c.id === sc.player) delete c.agenda;
      else if ('agenda' in c) c.agenda = Eng.cleanAgenda(c.agenda).agenda || null;
      state.characters[c.id] = c;
    });
    Eng.initTiers(state);
    state.extras = {};
    (sc.extras || []).forEach((x) => { state.extras[x.id] = Eng.newExtra(x, 'author', 0); });
    // Starting knowledge becomes private facts; scenario facts are public.
    sc.characterData.forEach((c) =>
      (c.knows || []).forEach((text) =>
        E.Memory.addFact(state, { about: [c.id], text, known_by: [c.id], weight: 2 })
      )
    );
    (sc.facts || []).forEach((text) => E.Memory.addFact(state, { about: [], text, known_by: ['all'], weight: 2 }));
    if (sc.opening) {
      state.recent = [{ turn: 0, action: null, text: sc.opening }];
      state.log.push({ turn: 0, type: 'scene', text: sc.opening });
    }
    return state;
  };

  // Saves and autosaves from older versions are upgraded one step at a time
  // when loaded. Each step takes a state at version n and returns n + 1.
  Eng.STATE_VERSION = 7;
  Eng.migrations = {
    // Worlds and starts (docs/WORLDS.md): the scenario records where it came from.
    1: (state) => {
      const sc = state.scenario;
      if (sc.worldId == null) sc.worldId = sc.folder || sc.id;
      if (sc.startId == null) sc.startId = 'default';
      state.version = 2;
      return state;
    },
    // Tags and mood (task 1-6): conditions become lasting tags.
    2: (state) => {
      const move = (chars, turn) => Object.values(chars || {}).forEach((c) => {
        if (c.tags) return;
        c.tags = ((c.status && c.status.conditions) || []).map((text) => ({ text, set: turn, until: null }));
        if (c.status) delete c.status.conditions;
      });
      move(state.characters, state.turn);
      if (state.pending && state.pending.pre) move(state.pending.pre.characters, state.turn);
      state.version = 3;
      return state;
    },
    // Cast tiers (task 2-1): the default rule, everyone last seen now.
    3: (state) => {
      Eng.initTiers(state, state.turn);
      const pre = state.pending && state.pending.pre;
      if (pre && pre.characters) Eng.initTiers({ player: state.player, characters: pre.characters }, state.turn);
      state.version = 4;
      return state;
    },
    // Agendas (task 2-2): people in older saves keep to routine, so loading
    // one never starts proposal calls.
    4: (state) => {
      const fill = (chars) => Object.values(chars || {}).forEach((c) => { if (c.id !== state.player && !('agenda' in c)) c.agenda = null; });
      fill(state.characters);
      if (state.pending && state.pending.pre) fill(state.pending.pre.characters);
      state.version = 5;
      return state;
    },
    // Extras (task 2-3): older saves have none.
    5: (state) => {
      if (!state.extras) state.extras = {};
      if (state.pending && state.pending.pre && !state.pending.pre.extras) state.pending.pre.extras = {};
      state.version = 6;
      return state;
    },
    // Regions (task 3-1): older saves have none.
    6: (state) => {
      if (!state.regions) state.regions = {};
      if (state.pending && state.pending.pre && !state.pending.pre.regions) state.pending.pre.regions = {};
      state.version = 7;
      return state;
    },
  };
  Eng.migrate = function (state) {
    if (state.version == null) state.version = 1;
    if (state.version > Eng.STATE_VERSION) throw new Error('This save was made by a newer version of Ensemble.');
    while (state.version < Eng.STATE_VERSION) state = Eng.migrations[state.version](state);
    // An autosave keeps the turn it can undo back to, which is a whole state too.
    if (state.undo && state.undo.state) state.undo.state = Eng.migrate(state.undo.state);
    return state;
  };

  // Regions (task 3-1). The player's region is the region of the room they're
  // in; "nearby" is that region and its neighbours, the only ones whose
  // current state goes in prompts.
  Eng.regionDef = (state, id) => (state.scenario.regions || []).find((r) => r.id === id) || null;
  Eng.regionOf = (state, loc) => (state.locations[loc] && state.locations[loc].region) || null;
  Eng.playerRegion = (state) => Eng.regionOf(state, state.characters[state.player].status.location);
  Eng.nearbyRegions = (state) => {
    const id = Eng.playerRegion(state);
    const def = id && Eng.regionDef(state, id);
    if (!def || !state.regions || !state.regions[id]) return [];
    return [id].concat((def.neighbours || []).filter((n) => state.regions[n]));
  };
  // Where a bigger event happens: a known region id, or the player's region
  // for a regional event that names none (or an unknown one). World events
  // may be nowhere in particular.
  function eventRegion(state, ev, scope, res) {
    if (scope === 'local' || !state.regions || !Object.keys(state.regions).length) return null;
    let r = ev && ev.region;
    if (r != null && r !== '' && !state.regions[r]) {
      guard(res, 'resolve', 'event region', `unknown region "${r}" for: ${ev.text}`);
      r = null;
    }
    return r || (scope === 'regional' ? Eng.playerRegion(state) : null);
  }

  // Every time the engine overrules or cleans up the model, it records it in
  // the turn's res.guards, so Debug can list what fired. stage: resolve |
  // scene | memory (Reroll replaces the scene ones).
  const guard = (res, stage, type, detail) => {
    if (!res) return;
    (res.guards = res.guards || []).push({ stage, type, detail: String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  };

  // Cast lists. Everything that lists characters goes through these (ids in
  // state.order), so cast tiers and standees only change them here. Lookups by
  // id stay state.characters[id].
  Eng.alive = (state, id) => state.characters[id] && state.characters[id].status.health !== 'dead';
  // tier: 'local' or 'secondary' keeps only that tier (the player is local).
  Eng.cast = (state, opts) => {
    const { alive = false, includePlayer = true, tier = null } = opts || {};
    return state.order.filter((id) => (includePlayer || id !== state.player) && (!alive || Eng.alive(state, id)) && (!tier || Eng.tier(state, id) === tier));
  };
  // Living non-player characters at a location (default: where the player is).
  Eng.present = (state, loc) => {
    const here = loc || state.characters[state.player].status.location;
    return Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => state.characters[id].status.location === here);
  };
  // Living non-player characters not in the scene (default: not with the player).
  // ---------- extras (task 2-3) ----------
  // Minor people (the innkeeper, a neighbour) or a group as one entity (a
  // patrol, the herd): a name, a role, a location (null: nowhere in
  // particular) and a note. They are not in the cast: no intents, needs,
  // relations or cards. Events can involve and move them, facts can be about
  // them, and an individual who comes to matter is promoted to a character.
  Eng.EXTRAS_MAX = 30;
  Eng.EXTRAS_PER_TURN = 1;
  Eng.PROMOTE_MENTIONS = 2;
  Eng.newExtra = (x, from, turn) => ({
    id: x.id, name: x.name, role: x.role, pronouns: x.pronouns || null, location: x.location == null ? null : x.location,
    note: x.note || '', group: !!x.group, count: x.group ? x.count || null : null,
    from, born: turn, mentions: 0, lastMention: null, promote: false, tries: 0,
  });
  Eng.extrasAt = (state, loc) => Object.values(state.extras || {}).filter((x) => x.location && x.location === loc);
  // "Mrs. Albee (elderly neighbour)", "the herd (group, hundreds)"
  Eng.extraLabel = (x) => `${x.name}${x.pronouns ? ` (${x.pronouns})` : ''}, ${x.role}${x.group ? `, a group${x.count ? ' of ' + x.count : ''}` : ''}`;
  const slug = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/^(dr|mr|mrs|ms|mx|capt|sgt|prof)\.?\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

  // A minor person the model proposes ("new_extras"), in worlds that allow
  // it: one per turn, 30 in all, checked like an authored one, with an id the
  // engine makes. A name already in use means that person. Returns
  // { id, note } or { error }.
  Eng.proposeExtra = function (state, raw, turn, defaultLoc) {
    if (!state.scenario.inventExtras) return { error: 'this world has no invented minor people' };
    if (!raw || typeof raw !== 'object') return { error: 'not an object' };
    const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : '';
    const role = typeof raw.role === 'string' ? raw.role.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > 40) return { error: `name must be 1–40 characters ("${name}")` };
    if (!role || role.length > 60) return { error: `role must be 1–60 characters for ${name}` };
    const low = name.toLowerCase();
    const known = Object.values(state.characters).find((c) => c.name.toLowerCase() === low) || Object.values(state.extras).find((x) => x.name.toLowerCase() === low);
    if (known) return { id: known.id, note: `${name} is already ${known.id}` };
    const added = state.newExtras && state.newExtras.turn === turn ? state.newExtras.n : 0;
    if (added >= Eng.EXTRAS_PER_TURN) return { error: `only ${Eng.EXTRAS_PER_TURN} new minor person per turn (${name})` };
    if (Object.keys(state.extras).length >= Eng.EXTRAS_MAX) return { error: `already ${Eng.EXTRAS_MAX} minor people (${name})` };
    const loc = raw.location == null || raw.location === '' ? defaultLoc : Eng.resolveLocation(state, raw.location, false);
    if (raw.location != null && raw.location !== '' && !loc) return { error: `unknown location "${raw.location}" for ${name}` };
    const base = slug(name) || 'extra';
    let id = base;
    for (let i = 2; state.characters[id] || state.extras[id] || state.locations[id]; i++) id = `${base}-${i}`;
    const group = raw.group === true;
    state.extras[id] = Eng.newExtra({ id, name, role, location: loc || null, group, count: group && typeof raw.count === 'string' ? raw.count.slice(0, 30) : null }, 'model', turn);
    state.newExtras = { turn, n: added + 1 };
    return { id, note: `+${Eng.extraLabel(state.extras[id])} in ${loc ? state.locations[loc].name : 'no particular place'} (${id})` };
  };

  // Being named in the player's action, on different turns, makes an
  // individual extra due for promotion. Returns Debug lines.
  Eng.noteExtraMentions = function (state, action, turn) {
    const out = [];
    Object.values(state.extras || {}).forEach((x) => {
      if (x.group || x.lastMention === turn || !mentions(action, x)) return;
      x.mentions += 1;
      x.lastMention = turn;
      if (x.mentions >= Eng.PROMOTE_MENTIONS && !x.promote) {
        x.promote = true;
        out.push(`${x.name}: named ${x.mentions} times, will become a full character`);
      }
    });
    return out;
  };

  // Where someone is, character or extra.
  const whereIs = (state, id) => (state.characters[id] ? state.characters[id].status.location : state.extras && state.extras[id] ? state.extras[id].location : null);
  const isExtra = (state, id) => !!(state.extras && state.extras[id]);

  Eng.offstage = (state, present) => {
    present = present || Eng.present(state);
    return Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => !present.includes(id));
  };

  // ---------- cast tiers (task 2-1) ----------
  // Local characters (with the player, or important right now) get the full
  // simulation; secondary ones are in the background with a one-line brief in
  // the intent call, no intent, and needs that settle like downtime routine.
  // The header's cast block never looks at tiers (cache rule). The engine
  // decides every change and logs it as a 'cast tier' guard.
  Eng.TIERS = { demoteAfter: 4, maxLocal: 6 };
  Eng.tierRules = (state) => Object.assign({}, Eng.TIERS, state.scenario.tiers || {});
  Eng.tier = (state, id) => (id === state.player || state.characters[id].tier !== 'secondary' ? 'local' : 'secondary');

  // Authored tier and pinned win; otherwise people in the player's room are
  // local and the rest secondary. Fills in only what is missing.
  Eng.initTiers = function (state, turn) {
    const here = state.characters[state.player].status.location;
    Object.values(state.characters).forEach((c) => {
      if (c.lastSeen == null) c.lastSeen = turn || 0;
      if (c.id === state.player || c.pinned) c.tier = 'local';
      else if (c.tier !== 'local' && c.tier !== 'secondary') c.tier = c.status.location === here ? 'local' : 'secondary';
    });
  };

  function promote(state, ids, turn, why, out) {
    ids.forEach((id) => {
      const c = state.characters[id];
      if (!c || id === state.player) return;
      c.lastSeen = Math.max(c.lastSeen || 0, turn);
      if (c.tier === 'secondary') {
        c.tier = 'local';
        out.push(`${c.name} → local (${why})`);
      }
    });
    return out;
  }

  // Before the intent call: the people with the player and anyone the
  // player's action names come to the foreground, so they get full detail now.
  Eng.promoteForAction = function (state, present, action, turn) {
    const out = promote(state, present, turn, 'in the scene', []);
    const named = Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => !present.includes(id) && mentions(action, state.characters[id]));
    return promote(state, named, turn, 'named in your action', out);
  };

  // When a turn is committed: who ended up in the scene and who was in a seen
  // or heard event come forward; locals not seen for demoteAfter turns go to
  // the background (unless pinned), and so do the longest-unseen offstage
  // locals beyond maxLocal. Returns Debug lines.
  Eng.updateTiers = function (state, turn, ctx) {
    const rules = Eng.tierRules(state);
    const here = (ctx && ctx.here) || [];
    const out = promote(state, here, turn, 'in the scene', []);
    promote(state, ((ctx && ctx.events) || []).filter((id) => !here.includes(id)), turn, 'in an event you saw or heard', out);
    const demote = (c, why) => { c.tier = 'secondary'; out.push(`${c.name} → secondary (${why})`); };
    const offstage = () => Eng.cast(state, { alive: true, includePlayer: false, tier: 'local' })
      .filter((id) => !here.includes(id) && !state.characters[id].pinned).map((id) => state.characters[id]);
    offstage().forEach((c) => {
      const gone = turn - (c.lastSeen || 0);
      if (gone >= rules.demoteAfter) demote(c, `not seen for ${gone} turns`);
    });
    const locals = Eng.cast(state, { alive: true, includePlayer: false, tier: 'local' }).filter((id) => !here.includes(id)).length;
    let over = locals - rules.maxLocal;
    offstage().sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0)).forEach((c) => {
      if (over-- > 0) demote(c, `more than ${rules.maxLocal} people in the foreground offstage`);
    });
    return out;
  };

  // ---------- agendas (task 2-2) ----------
  // A character's own goal as a few steps at a pace (hours per step). The
  // engine advances them like clocks (secondary characters only during turns,
  // everyone during a downtime skip); when a step completes it is due, and the
  // next intent call writes it as one event tagged with the agenda, or the
  // engine writes it from the step text. A contact step brings the person to
  // the player. null (or no steps) is routine: nothing fires.
  Eng.AGENDA_HOURS = 12;
  Eng.AGENDA_STEPS = 5;
  const ROUTINE = /^(keep(s|ing)? (to )?)?(the |their |his |her )?(usual )?routine\.?$/i;
  // raw (authored or proposed) → { agenda } (null for routine) or { error }.
  // proposed: the model's shape, { goal, steps, hours, contact_step } or { routine: true }.
  Eng.cleanAgenda = function (raw, proposed) {
    if (raw == null) return { agenda: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'agenda must be an object with "goal" and "steps"' };
    if (raw.routine === true) return { agenda: null };
    const goal = typeof raw.goal === 'string' ? raw.goal.replace(/\s+/g, ' ').trim() : '';
    if (!goal) return { error: 'agenda has no "goal"' };
    if (goal.length > 120) return { error: 'agenda goal is longer than 120 characters' };
    const list = raw.steps == null ? [] : raw.steps;
    if (!Array.isArray(list)) return { error: 'agenda "steps" must be a list' };
    if (!list.length) return ROUTINE.test(goal) ? { agenda: null } : { error: 'agenda has no steps (use "keep routine" for none)' };
    const max = proposed ? 4 : Eng.AGENDA_STEPS;
    if (list.length > max) return { error: `agenda has more than ${max} steps` };
    const steps = [];
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      const text = (typeof st === 'string' ? st : st && typeof st.text === 'string' ? st.text : '').replace(/\s+/g, ' ').trim();
      if (!text || /^(one sentence|\.\.\.|…)$/i.test(text)) return { error: `agenda step ${i + 1} has no text` };
      if (text.length > 140) return { error: `agenda step ${i + 1} is longer than 140 characters` };
      steps.push({ text, contact: !!((st && st.contact === true) || (proposed && raw.contact_step === i)) });
    }
    let hours = raw.hours == null ? Eng.AGENDA_HOURS : Number(raw.hours);
    if (!(hours > 0)) return { error: 'agenda "hours" must be a number of hours per step' };
    hours = proposed ? E.clamp(Math.round(hours), 2, 72) : hours;
    if (hours < 1 || hours > 240) return { error: 'agenda "hours" must be between 1 and 240' };
    const visibility = raw.visibility == null || proposed ? 'hidden' : raw.visibility;
    if (!['hidden', 'heard'].includes(visibility)) return { error: 'agenda "visibility" must be hidden or heard' };
    const step = E.clamp(Math.round(Number(raw.step) || 0), 0, steps.length);
    return { agenda: { goal, steps, hours, visibility, step, progress: E.clamp(Number(raw.progress) || 0, 0, 1), due: !!raw.due, done: step >= steps.length, followUp: !!raw.followUp } };
  };
  const activeAgenda = (c) => (c && c.agenda && !c.agenda.done && c.agenda.steps[c.agenda.step] ? c.agenda : null);
  Eng.agendaStep = (c) => { const a = activeAgenda(c); return a ? a.steps[a.step] : null; };
  // Ids whose current step is due, in cast order.
  Eng.agendasDue = (state) => Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => { const a = activeAgenda(state.characters[id]); return a && a.due; });

  // During turns only secondary characters advance; locals act through intents.
  function advanceAgendas(state, hours) {
    Eng.cast(state, { alive: true, includePlayer: false, tier: 'secondary' }).forEach((id) => {
      const a = activeAgenda(state.characters[id]);
      if (!a || a.due) return;
      a.progress = Math.min(1, a.progress + hours / a.hours);
      if (a.progress >= 1) a.due = true;
    });
  }

  // A step is done: the next one starts, or the agenda is finished.
  function completeStep(state, c, res, how) {
    const a = c.agenda;
    const st = a.steps[a.step];
    a.step += 1;
    a.progress = 0;
    a.due = false;
    if (a.step >= a.steps.length) a.done = true;
    guard(res, 'resolve', 'agenda step', `${c.name}: step ${a.step}/${a.steps.length} "${st.text}"${how ? ` (${how})` : ''}${a.done ? '; agenda done' : ''}`);
  }

  // The event the engine writes when the model left a due step out.
  const stepSentence = (c, st) => `${Eng.shortName(c)} ${st.text.replace(/[.!?]+$/, '')}.`;

  // Applies the due steps for one intent result: one event per due step (the
  // model's, tagged "agenda": id, or the engine's), hidden agendas stay
  // hidden, a contact step brings the person into the player's room.
  // Returns the events that were not agenda events.
  function applyAgendaEvents(state, raw, present, res) {
    const due = Eng.agendasDue(state);
    if (!due.length && !raw.some((ev) => ev && ev.agenda)) return raw;
    const here = state.characters[state.player].status.location;
    const written = new Set();
    const rest = [];
    const write = (id, ev) => {
      const c = state.characters[id];
      const a = c.agenda;
      const st = a.steps[a.step];
      const text = (ev && typeof ev.text === 'string' && ev.text.trim() && !/^one sentence$/i.test(ev.text.trim()) ? ev.text.trim() : stepSentence(c, st)).slice(0, 220);
      const who = [id].concat((ev && Array.isArray(ev.who) ? ev.who : []).filter((x) => x !== id && state.characters[x] && x !== state.player));
      let where = c.status.location;
      const moved = [];
      if (st.contact) {
        if (where !== here) { c.status.location = here; moved.push(`${c.name} → ${state.locations[here].name}`); }
        where = here;
      } else if (ev && !present.includes(id)) {
        const to = Eng.resolveLocation(state, ev.where, false);
        if (to && to !== where && to !== here) { c.status.location = to; where = to; moved.push(`${c.name} → ${state.locations[to].name}`); }
      }
      const vis = st.contact ? 'seen' : a.visibility === 'heard' ? (where === here ? 'seen' : 'heard') : 'hidden';
      res.involved = [...new Set((res.involved || []).concat(who))];
      if (vis === 'hidden') E.Memory.addFact(state, { about: [id], text, known_by: who, weight: 2 });
      else res.events.push((vis === 'heard' ? '(heard from elsewhere; only a sound, call or message reaches the player) ' : '') + text);
      res.director.push({ scope: 'local', text, visibility: vis, who, where, moved, effects: [], agenda: id });
      completeStep(state, c, res, ev ? null : 'written by the engine');
    };
    raw.forEach((ev) => {
      if (!ev || !ev.agenda) return rest.push(ev);
      const id = String(ev.agenda);
      if (!due.includes(id) || written.has(id)) return guard(res, 'resolve', 'event dropped', `agenda event for ${id} not due or already written: ${ev.text || ''}`);
      written.add(id);
      write(id, ev);
    });
    due.filter((id) => !written.has(id)).forEach((id) => write(id, null));
    return rest;
  }

  // Downtime: every living non-player agenda runs for the whole span. Steps
  // completed on the way are recorded (hidden ones as private facts); the
  // contact step the skip stops at (plan.agenda) is left due for skipTurn.
  // Returns [{ id, text, visibility }] for the downtime prompt.
  Eng.runAgendas = function (state, hours, plan, res) {
    const out = [];
    const stop = plan && plan.agenda;
    Eng.cast(state, { alive: true, includePlayer: false }).forEach((id) => {
      const c = state.characters[id];
      let left = hours;
      for (let a = activeAgenda(c); a && left > 0; a = activeAgenda(c)) {
        const st = a.steps[a.step];
        const need = (a.due ? 0 : 1 - a.progress) * a.hours;
        if (need > left + 1e-9) { a.progress += left / a.hours; break; }
        left -= need;
        if (st.contact) { a.progress = 1; a.due = true; if (!(stop && stop.id === id)) guard(res, 'resolve', 'agenda step', `${c.name}: "${st.text}" is due (comes to you next)`); break; }
        const text = stepSentence(c, st);
        if (a.visibility === 'heard') E.Memory.addFact(state, { about: [id], text, known_by: [id, state.player], weight: 1 });
        else E.Memory.addFact(state, { about: [id], text, known_by: [id], weight: 2 });
        out.push({ id, text, visibility: a.visibility });
        completeStep(state, c, res, 'during the downtime');
      }
    });
    return out;
  };

  // Hours until each living non-player's next contact step completes, if any.
  function nextContact(state) {
    let best = null;
    Eng.cast(state, { alive: true, includePlayer: false }).forEach((id) => {
      const a = activeAgenda(state.characters[id]);
      if (!a) return;
      let h = (a.due ? 0 : 1 - a.progress) * a.hours;
      for (let i = a.step; i < a.steps.length; i++) {
        if (i > a.step) h += a.hours;
        if (a.steps[i].contact) {
          if (!best || h < best.hours) best = { hours: Math.max(1, Math.ceil(h)), id, step: i, text: a.steps[i].text };
          return;
        }
      }
    });
    return best;
  }

  // ---------- resolution ----------
  // Roll penalties from health and needs. A world can set its own
  // (skillPenalties); a need it doesn't track never applies.
  Eng.SKILL_PENALTIES = { health: { hurt: -2, badly_hurt: -4 }, needs: [{ need: 'fatigue', at: 0.85, penalty: -2 }] };
  function skillPenalty(c, sc) {
    const cfg = (sc && sc.skillPenalties) || Eng.SKILL_PENALTIES;
    let p = Number((cfg.health || {})[c.status.health]) || 0;
    (cfg.needs || []).forEach((n) => { if (c.needs[n.need] != null && c.needs[n.need] >= n.at) p += Number(n.penalty) || 0; });
    return p;
  }

  Eng.roll = function (c, skill, difficulty, sc) {
    const d = 1 + Math.floor(E.rng() * 20);
    const dc = DC[difficulty] || DC.normal;
    const total = d + (Number(c.skills[skill]) || 0) * 2 + skillPenalty(c, sc);
    const result = d === 1 ? 'critical failure' : d === 20 ? 'critical success' : total >= dc ? 'success' : 'failure';
    return { d, total, dc, result };
  };

  // Accepts a location id, a location name ("Hydroponics"), or — when allowed —
  // a character id meaning "wherever that character is".
  Eng.resolveLocation = function (state, v, allowCharacter) {
    if (!v || typeof v !== 'string') return null;
    const key = v.trim();
    if (state.locations[key]) return key;
    const low = key.toLowerCase();
    const byName = Object.values(state.locations).find((l) => l.name.toLowerCase() === low || l.id.toLowerCase() === low);
    if (byName) return byName.id;
    if (allowCharacter && state.characters[key]) return state.characters[key].status.location;
    return null;
  };

  function cleanIntent(state, raw, id) {
    const sc = state.scenario;
    const skill = sc.skills.includes(raw && raw.skill) ? raw.skill : null;
    const text = (v, n) => (v && typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, n) : null);
    return {
      id,
      missing: !raw,
      says: id === state.player ? null : text(raw && raw.says, 240),
      reveals: id === state.player ? null : text(raw && raw.reveals, 280),
      revealFlag: id !== state.player && !!(raw && raw.reveals && raw.reveals !== false && String(raw.reveals).trim().toLowerCase() !== 'null'),
      action: String((raw && (raw.action || raw.summary)) || 'waits and watches').slice(0, 240),
      visible: id === state.player ? true : raw && raw.visible === false ? false : true,
      needsRoll: !!(raw && raw.needs_roll && skill),
      skill,
      difficulty: DC[raw && raw.difficulty] ? raw.difficulty : 'normal',
      moveTo: raw ? Eng.resolveLocation(state, raw.move_to, true) : null,
    };
  }

  // Words that identify a character in the player's text: id, first and last name.
  function nameTokens(c) {
    const parts = c.name.replace(/^(dr|mr|mrs|ms|mx|capt|sgt)\.?\s+/i, '').split(/\s+/);
    return [c.id].concat(parts).filter((w) => w && w.length > 1).map((w) => w.toLowerCase());
  }
  const mentions = (text, c) => {
    const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9']+/g, ' ') + ' ';
    return nameTokens(c).some((w) => t.includes(' ' + w + ' ') || t.includes(' ' + w + "'s "));
  };

  // The player saying they go somewhere: "I head down to…", "then go…", "Go to…".
  // "Ask Teo to go…" is someone else moving, so a subject or sentence start is required.
  const PLAYER_MOVES = /(^|\b(?:i|we|then|and)\s+|[,;.]\s*)(?:(?:get up (?:and |to )?)?(?:go|head|walk|return|leave|hurry|follow|make (?:my|our) way|move over|come back|tag along))\b/i;

  // Secrets have to be earned: a successful social check this turn, a character
  // at breaking point (critical stress/fear), or one who already trusts the player.
  // How much pressure it takes depends on the character's guard (low/medium/high):
  // a successful social roll always works; otherwise stress/fear, trust in the
  // player, or (for the easily rattled) being confronted directly.
  const GUARD = {
    low: { pressure: 0.6, trust: 30, confront: true },
    medium: { pressure: 0.85, trust: 50, confront: 'stressed' },
    high: { pressure: 0.95, trust: 70, confront: false },
  };
  const CONFRONT = /\b(ask|asks|confront|press|pressure|demand|accuse|question|interrogate|why|tell me|come clean|truth|hiding|explain|up to)\b/i;

  function revealAllowed(state, id, playerOutcome, actionText) {
    const c = state.characters[id];
    const g = GUARD[c.guard] || GUARD.medium;
    const socialSkills = state.scenario.revealSkills || ['social', 'persuasion'];
    const r = playerOutcome && playerOutcome.roll;
    if (r && /success/.test(r.result) && socialSkills.includes(playerOutcome.skill)) return true;
    // Pressure comes from the needs a world names (revealPressure); none, none.
    const stress = Math.max(0, ...(state.scenario.revealPressure || ['stress', 'fear']).map((n) => c.needs[n] || 0));
    if (stress >= g.pressure) return true;
    if ((c.relations[state.player] || 0) >= g.trust) return true;
    const confronted = mentions(actionText, c) && CONFRONT.test(String(actionText || ''));
    if (confronted && (g.confront === true || (g.confront === 'stressed' && stress >= 0.6))) return true;
    return false;
  }


  const EVENT_CAP = { moment: 1, hour: 1, hours: 2, morning: 3 };

  // Director events: things that happen during the span outside the player's
  // control. Seen/heard ones reach the narrator; hidden ones become private facts.
  // ---------- event tiers ----------
  // local: the scene and the people around it (every turn, capped by time step)
  // regional: the surroundings (terrain, weather, nearby places)
  // world: broad shifts far away whose effects reach the group
  // The engine decides when regional/world events are due; the model only writes them.
  const absHours = (state) => state.time.day * 24 + state.time.hour;
  const TIER_COOLDOWN = { regional: 4, world: 24 };

  Eng.tiersDue = function (state, hours) {
    const rates = E.Genres.pacing(state.scenario).eventRates;
    state.tierLast = state.tierLast || {};
    const now = absHours(state);
    const due = {};
    ['regional', 'world'].forEach((t) => {
      const last = state.tierLast[t];
      if (!(rates[t] > 0) || (last != null && now - last < TIER_COOLDOWN[t])) { due[t] = false; return; }
      due[t] = E.rng() < 1 - Math.exp(-hours / rates[t]);
    });
    return due;
  };

  // Concrete consequences of bigger events, as a table keyed by the payload
  // field the prompts ask for. Each handler checks one item and returns a
  // display line (shown in the news), { reject: why } (reported in Debug), or
  // null when there is nothing to do. list: the field holds up to max items;
  // otherwise it holds one object. Handlers run in table order.
  const reject = (why) => ({ reject: why });
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const EFFECTS = {
    world: {
      list: true, max: 3,
      apply(state, w) {
        if (!w || !own(state.world, w.key)) return reject(`unknown world key "${w && w.key}"`);
        if (!w.value) return reject(`no value for ${w.key}`);
        state.world[w.key] = String(w.value).slice(0, 120);
        return `${w.key}: ${state.world[w.key]}`;
      },
    },
    groups: {
      list: true, max: 2,
      apply(state, g) {
        const f = g && (state.factions || []).find((x) => x.id === g.id);
        if (!f) return reject(`unknown group "${g && g.id}"`);
        if (!g.stance) return reject(`no stance for ${g.id}`);
        f.stance = String(g.stance).slice(0, 140);
        return `${f.name}: ${f.stance}`;
      },
    },
    clocks: {
      list: true, max: 2,
      apply(state, c) {
        const cl = c && state.clocks.find((x) => x.id === c.id);
        if (!cl) return reject(`unknown clock "${c && c.id}"`);
        if (cl.fired) return reject(`${cl.id} has already fired`);
        const d = E.clamp(Number(c.delta) || 0, -cl.max / 2, cl.max / 2);
        if (!d) return null;
        cl.value = E.clamp(cl.value + d, 0, cl.max);
        return `${cl.name} ${d > 0 ? '+' : ''}${d}`;
      },
    },
    new_clock: {
      apply(state, nc, scope) {
        if (!nc.name) return reject('new pressure has no name');
        if (state.clocks.filter((c) => !c.fired).length >= 5) return reject(`too many pressures already for "${nc.name}"`);
        const id = String(nc.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'pressure';
        if (state.clocks.find((c) => c.id === id)) return reject(`pressure "${id}" already exists`);
        state.clocks.push({
          id, name: String(nc.name).slice(0, 40), value: 0,
          max: E.clamp(Math.round(Number(nc.max) || 8), 4, 12),
          perHour: E.clamp(Number(nc.perHour) || 0.2, 0.05, 1),
          fireText: String(nc.fireText || `${nc.name} comes to a head.`).slice(0, 220), fired: false, from: scope,
        });
        return `new pressure: ${nc.name}`;
      },
    },
    // Regions (task 3-1).
    control: {
      list: true, max: 1,
      apply(state, c) {
        const r = region(state, c);
        if (r.reject) return r;
        const to = c.to == null || c.to === '' || c.to === 'none' ? null : c.to;
        const f = to && (state.factions || []).find((x) => x.id === to);
        if (to && !f) return reject(`unknown group "${to}" for ${c.region}`);
        if (r.now.controller === to) return reject(`${c.region} is already held by ${f ? f.id : 'no one'}`);
        r.now.controller = to;
        return `${r.def.name}: now held by ${f ? f.name : 'no one'}`;
      },
    },
    add_tag: {
      list: true, max: 2,
      apply(state, t) {
        const r = region(state, t);
        if (r.reject) return r;
        const tag = String(t.tag || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 30);
        if (!tag) return reject(`no tag for ${t.region}`);
        if (r.now.tags.some((x) => x.toLowerCase() === tag)) return null;
        if (r.now.tags.length >= E.Scenario.REGION_TAGS) return reject(`${t.region} already has ${E.Scenario.REGION_TAGS} tags; not adding "${tag}"`);
        r.now.tags.push(tag);
        return `${r.def.name}: ${tag}`;
      },
    },
    remove_tag: {
      list: true, max: 2,
      apply(state, t) {
        const r = region(state, t);
        if (r.reject) return r;
        const tag = String(t.tag || '').trim().toLowerCase();
        const i = r.now.tags.findIndex((x) => x.toLowerCase() === tag);
        if (i < 0) return reject(`${t.region} has no tag "${t.tag}"`);
        const [gone] = r.now.tags.splice(i, 1);
        return `${r.def.name}: no longer ${gone}`;
      },
    },
    region_status: {
      list: true, max: 2,
      apply(state, s) {
        const r = region(state, s);
        if (r.reject) return r;
        if (!s.status) return reject(`no status for ${s.region}`);
        r.now.status = String(s.status).slice(0, 120);
        return `${r.def.name}: ${r.now.status}`;
      },
    },
  };
  // The region an effect item names: { def, now } or a rejection.
  function region(state, item) {
    const id = item && item.region;
    const now = id != null && state.regions && own(state.regions, id) ? state.regions[id] : null;
    const def = now && Eng.regionDef(state, id);
    return def ? { def, now } : reject(`unknown region "${id}"`);
  }
  Eng.EFFECTS = EFFECTS;

  // Applies an event's effects. Returns the display lines; rejections become
  // 'effect rejected' guards on res.
  function applyEffects(state, eff, scope, res) {
    const done = [];
    if (!eff || typeof eff !== 'object') return done;
    const no = (key, why) => guard(res, 'resolve', 'effect rejected', `${key}: ${why}`);
    Object.keys(EFFECTS).forEach((key) => {
      const h = EFFECTS[key];
      const v = eff[key];
      if (v == null) return;
      let items;
      if (h.list) {
        if (!Array.isArray(v)) return no(key, 'not a list');
        items = v.slice(0, h.max);
        if (v.length > h.max) no(key, `only ${h.max} allowed, dropped ${v.length - h.max}`);
      } else {
        if (typeof v !== 'object' || Array.isArray(v)) return no(key, 'not an object');
        items = [v];
      }
      items.forEach((it) => {
        const out = h.apply(state, it, scope);
        if (out && out.reject) no(key, out.reject);
        else if (out) done.push(out);
      });
    });
    Object.keys(eff).filter((k) => !own(EFFECTS, k)).forEach((k) => no(k, 'unknown effect'));
    return done;
  }

  Eng.applyEvents = (...a) => applyEvents(...a);
  // noAgendas: the downtime skip leaves due agenda steps for the next turn.
  function applyEvents(state, intentObj, present, stepId, res, due, capsOverride, noAgendas) {
    due = due || {};
    const here = state.characters[state.player].status.location;
    res.director = [];
    // Agenda steps that are due (task 2-2) don't count toward the caps.
    const all = Array.isArray(intentObj.events) ? intentObj.events : [];
    const raw = noAgendas ? all.filter((ev) => !(ev && ev.agenda)) : applyAgendaEvents(state, all, present, res);
    const caps = capsOverride || { local: EVENT_CAP[stepId] ?? 1, regional: due.regional ? 1 : 0, world: due.world ? 1 : 0 };
    const used = { local: 0, regional: 0, world: 0 };
    state.news = state.news || [];
    state.tierLast = state.tierLast || {};
    raw.forEach((ev) => {
      if (!ev || typeof ev.text !== 'string' || !ev.text.trim() || /^one sentence$/i.test(ev.text.trim())) return;
      const scope = ['regional', 'world'].includes(ev.scope) ? ev.scope : 'local';
      if (used[scope] >= caps[scope]) return guard(res, 'resolve', 'event dropped', `${scope} event not due or over the cap: ${ev.text}`);
      used[scope]++;
      const text = ev.text.trim().slice(0, 220);
      const who = (Array.isArray(ev.who) ? ev.who : []).filter((id) => (state.characters[id] || isExtra(state, id)) && id !== state.player);
      // Offstage people in an event may know facts about it (see applyUpdate).
      res.involved = [...new Set((res.involved || []).concat(who))];
      const where = Eng.resolveLocation(state, ev.where, false) || (scope === 'local' && who[0] ? whereIs(state, who[0]) : null);
      let vis = ['seen', 'heard', 'hidden'].includes(ev.visibility) ? ev.visibility : 'heard';
      if (vis === 'seen' && where !== here) vis = 'heard';
      const moved = [];
      (Array.isArray(ev.moves) ? ev.moves : []).forEach((m) => {
        if (m && isExtra(state, m.id)) {
          const to = Eng.resolveLocation(state, m.to, false);
          if (!to) return;
          state.extras[m.id].location = to;
          moved.push(`${state.extras[m.id].name} → ${state.locations[to].name}`);
          return;
        }
        if (!m || !state.characters[m.id] || m.id === state.player || present.includes(m.id)) return;
        const to = Eng.resolveLocation(state, m.to, false);
        if (!to || !Eng.alive(state, m.id)) return;
        state.characters[m.id].status.location = to;
        moved.push(`${state.characters[m.id].name} → ${state.locations[to].name}`);
      });
      // Hidden big events stay hidden: no public status changes, only private knowledge.
      const effects = scope !== 'local' && vis !== 'hidden' ? applyEffects(state, ev.effects, scope, res) : [];
      const region = eventRegion(state, ev, scope, res);
      if (scope !== 'local') state.tierLast[scope] = absHours(state);
      const tag = scope === 'local' ? '' : `[${scope}] `;
      if (vis === 'hidden') {
        if (who.length) E.Memory.addFact(state, { about: who, text, known_by: who, weight: 2 });
      } else {
        res.events.push((vis === 'heard' ? '(heard from elsewhere; only a sound, call or message reaches the player) ' : '') + tag + text);
        if (scope !== 'local') {
          E.Memory.addFact(state, { about: who, text, known_by: ['all'], weight: scope === 'world' ? 3 : 2 });
          state.news.push({ scope, text, time: E.fmtTime(state), effects, region });
          if (state.news.length > 12) state.news.shift();
        }
      }
      res.director.push({ scope, text, visibility: vis, who, where, region, moved, effects });
    });
    res.due = due;
  }

  const STOP = new Set('that this with from have been were they them their there what when where which would could should about after before into than then while your just only also very some more most other each such over under because being does doing having made make told tell said says hers his him she he'.split(' '));
  const contentWords = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).map((w) => w.replace(/'s$/, '')).filter((w) => w.length >= 4 && !STOP.has(w)));

  // True when a character's own words/action carry their secret or private
  // knowledge (3+ distinct content words in common, or a confession verb plus 1+).
  function leaksSecret(state, id, text) {
    const c = state.characters[id];
    if (!c || !text) return false;
    const secretWords = contentWords([c.secret].concat(E.Memory.privateFacts(state, id).map((f) => f.text)).join(' '));
    const said = contentWords(text);
    let hits = 0;
    said.forEach((w) => { if (secretWords.has(w)) hits++; });
    if (hits >= 3) return true;
    return hits >= 1 && /\b(admit|admits|admitted|confess|confesses|confessed|reveal|reveals|revealed|owns up|comes clean)\b/i.test(text);
  }

  Eng.resolve = function (state, intentObj, present, actionText, stepId, due) {
    const outcomes = [];
    const res = { outcomes, events: [], guards: [] };
    const list = [cleanIntent(state, intentObj.player, state.player)];
    const given = Array.isArray(intentObj.intents) ? intentObj.intents : [];
    present.forEach((id) => list.push(cleanIntent(state, given.find((g) => g && g.id === id), id)));
    // If the player's action is about someone already in the room, they don't go
    // anywhere, unless the action says so ("…then head to the garage") or names
    // someone who is at the destination.
    const p = list[0];
    if (p.moveTo) {
      const about = present.filter((id) => mentions(actionText, state.characters[id]));
      // Someone named who is heading the same way this turn counts as being there.
      const goingThere = (id) => (list.find((it) => it.id === id) || {}).moveTo === p.moveTo;
      const statesMove = PLAYER_MOVES.test(String(actionText || '')) || about.some(goingThere) ||
        Eng.cast(state, { includePlayer: false }).some((id) => !present.includes(id) && state.characters[id].status.location === p.moveTo && mentions(actionText, state.characters[id]));
      if (about.length && !statesMove && about.every((id) => state.characters[id].status.location !== p.moveTo)) {
        guard(res, 'resolve', 'move cancelled', `model moved the player to ${p.moveTo}; the action is about ${about.map((id) => state.characters[id].name).join(', ')}, who is here`);
        p.moveTo = null;
        p.moveCancelled = `stayed with ${about.map((id) => state.characters[id].name).join(', ')}`;
        const here = state.locations[state.characters[state.player].status.location];
        p.action = `${String(actionText).trim()} (right here in ${here ? here.name : 'the same room'})`;
      }
    }
    list.forEach((it) => {
      const c = state.characters[it.id];
      const o = { id: it.id, action: it.action, says: it.says, reveals: it.reveals, missing: it.missing, visible: it.visible, skill: it.skill, roll: null, moved: null };
      if (it.moveCancelled) o.note = it.moveCancelled;
      // A reveal attempt is either the reveals field or a secret leaking into
      // the character's own action/dialogue. Unearned attempts become deflection.
      const attempt = it.revealFlag || leaksSecret(state, it.id, `${o.action} ${o.says || ''}`);
      if (it.id !== state.player && attempt) {
        if (revealAllowed(state, it.id, outcomes[0], actionText)) {
          if (!o.reveals) o.reveals = o.says || o.action;
        } else {
          o.note = 'reveal held back (not enough pressure yet)';
          guard(res, 'resolve', it.revealFlag ? 'reveal blocked' : 'leak deflected', `${c.name}: ${o.reveals || `${o.action} ${o.says || ''}`}`);
          o.reveals = null;
          o.action = 'is pressed about it but keeps the secret: deflects, makes an excuse or changes the subject';
          o.says = null;
        }
      }
      if (it.needsRoll) o.roll = Eng.roll(c, it.skill, it.difficulty, state.scenario);
      const failed = o.roll && /failure/.test(o.roll.result);
      if (it.moveTo && it.moveTo !== c.status.location && !failed) {
        c.status.location = it.moveTo;
        o.moved = it.moveTo;
      }
      outcomes.push(o);
    });
    applyEvents(state, intentObj, present, stepId || 'hour', res, due);
    applyNewExtras(state, intentObj.new_extras, state.turn, state.characters[state.player].status.location, (why) => guard(res, 'resolve', 'extra rejected', why), (note) => guard(res, 'resolve', 'extra added', note));
    return res;
  };

  function applyNewExtras(state, list, turn, defaultLoc, no, yes) {
    if (list == null || (Array.isArray(list) && !list.length)) return;
    if (!Array.isArray(list)) return no('"new_extras" is not a list');
    list.slice(0, 3).forEach((raw) => {
      const out = Eng.proposeExtra(state, raw, turn, defaultLoc);
      if (out.error) no(out.error); else yes(out.note);
    });
  }

  // routine = long downtime: people eat and sleep, so hunger/fatigue settle
  // toward normal instead of climbing; stress drifts toward a calm baseline.
  Eng.advanceTime = function (state, hours, res, routine) {
    state.time.hour += hours;
    while (state.time.hour >= 24) { state.time.hour -= 24; state.time.day += 1; }
    state.scenario.needs.forEach((n) => {
      Eng.cast(state, { alive: true }).forEach((id) => {
        const c = state.characters[id];
        const v = c.needs[n.id] || 0;
        // People in the background live their routine: needs settle, not climb.
        c.needs[n.id] = routine || Eng.tier(state, id) === 'secondary'
          ? E.clamp(0.35 + (v - 0.35) * Math.exp(-hours / 24), 0, 1)
          : E.clamp(v + (n.perHour || 0) * hours, 0, 1);
      });
    });
    state.clocks.slice().forEach((cl) => {
      if (cl.fired) return;
      cl.value = E.clamp(cl.value + (cl.perHour || 0) * hours, 0, cl.max);
      if (cl.value >= cl.max) Eng.fireClock(state, cl, res);
    });
    // Downtime runs agendas itself (Eng.runAgendas), step by step.
    if (!routine) advanceAgendas(state, hours);
  };

  Eng.fireClock = function (state, cl, res) {
    cl.fired = true;
    if (cl.fireWorld) {
      Object.assign(state.world, cl.fireWorld);
      // The update step can't undo these in the same turn (playtest-agenda-skips).
      state.worldSetBy = state.worldSetBy || {};
      Object.keys(cl.fireWorld).forEach((k) => { state.worldSetBy[k] = { turn: state.turn, clock: cl.name }; });
    }
    const text = cl.fireText || `${cl.name} has come to pass.`;
    res.events.push(text);
    E.Memory.addFact(state, { about: [], text, known_by: ['all'], weight: 3 });
    state.flags.chapterWorthy = true;
    // Follow-up pressures: e.g. the storm arriving starts "Storm clears" and "Battery reserve".
    (cl.then || []).forEach((t) => {
      if (!t || !t.id || state.clocks.find((x) => x.id === t.id)) return;
      state.clocks.push(Object.assign({ value: 0, perHour: 0, fired: false }, E.clone(t)));
    });
  };

  // ---------- skipping to the next major event ----------
  // Fast-forwards without the model: stops at the first clock to fire, a
  // random major event, or the horizon, whichever comes first.
  Eng.planMajorSkip = function (state) {
    const sc = state.scenario;
    const horizon = (sc.majorHorizonDays ?? 30) * 24;
    const meanDays = E.Genres.pacing(sc).majorEventDays;
    // first clock to fire, following chains of follow-up clocks
    const clocks = E.clone(state.clocks).filter((c) => !c.fired);
    let clockHit = null;
    for (let h = 1; h <= horizon && !clockHit; h++) {
      for (const c of clocks) {
        if (c.fired || !(c.perHour > 0)) continue;
        c.value += c.perHour;
        if (c.value >= c.max) { clockHit = { hours: h, id: c.id, name: c.name }; break; }
      }
    }
    const randomHours = meanDays > 0 ? Math.max(6, -Math.log(1 - E.rng()) * meanDays * 24) : Infinity;
    // Someone's agenda bringing them to the player stops the skip too (task 2-2).
    const contact = nextContact(state);
    if (contact && contact.hours <= horizon && contact.hours <= randomHours && (!clockHit || contact.hours < clockHit.hours)) {
      return { hours: contact.hours, reason: 'agenda', agenda: contact };
    }
    if (clockHit && clockHit.hours <= randomHours) return { hours: clockHit.hours, reason: 'clock', clock: clockHit };
    if (randomHours <= horizon) return { hours: Math.round(randomHours), reason: 'random' };
    return { hours: horizon, reason: 'horizon' };
  };

  // ---------- tags and mood (task 1-6) ----------
  // Tags are short visible states ("limping", "covered in dust"), each with an
  // expiry turn (until; null = lasting). Mood is how a non-player character
  // comes across right now. The model proposes both; these guards decide.
  Eng.TAG_CAP = 4;
  Eng.TAG_TURNS = 6;
  Eng.MOOD_STALE = 6;
  const cleanPhrase = (v) => String(v || '').replace(/[\r\n]+/g, ' ').replace(/["“”[\]{}<>*_`#]/g, '').replace(/\s+/g, ' ').trim();
  // Content words of a tag, without people's names, for spotting near-duplicates.
  function tagWords(state, text) {
    const names = new Set();
    Object.values(state.characters).forEach((ch) => String(ch.name || '').toLowerCase().split(/[^a-z]+/).forEach((w) => names.add(w)));
    return [...contentWords(text)].filter((w) => !names.has(w));
  }

  Eng.addTag = function (state, c, value, turns, reason, turn) {
    const text = cleanPhrase(value);
    if (!text) return { error: 'empty tag' };
    if (text.length > 32 || text.split(' ').length > 5) return { error: 'tag too long (32 characters, 5 words at most)' };
    const low = text.toLowerCase();
    if (MOODS.test(low) || low.split(' ').some((w) => MOODS.test(w)) || /on edge/.test(low) || state.scenario.needs.some((n) => low.includes(n.id) || low.includes((n.label || '').toLowerCase()))) {
      return { error: 'a feeling, not a tag (moods and needs are tracked separately)' };
    }
    const n = E.clamp(Math.round(Number(turns)) || Eng.TAG_TURNS, 1, 30);
    const why = cleanPhrase(reason).slice(0, 100);
    c.tags = c.tags || [];
    const same = c.tags.find((t) => t.text.toLowerCase() === low);
    if (same) {
      if (same.until != null) same.until = turn + n;
      if (why) same.reason = why;
      return { note: `kept "${same.text}"${same.until != null ? ` until turn ${same.until}` : ''}` };
    }
    const tag = { text, set: turn, until: turn + n, reason: why };
    const words = tagWords(state, text);
    const near = c.tags.findIndex((t) => tagWords(state, t.text).some((w) => words.includes(w)));
    if (near >= 0) {
      const old = c.tags[near].text;
      c.tags[near] = tag;
      return { note: `"${text}" replaces "${old}"${why ? ` (${why})` : ''}` };
    }
    c.tags.push(tag);
    let dropped = '';
    if (c.tags.length > Eng.TAG_CAP) {
      // Drop the oldest tag that expires, else the oldest.
      const pool = c.tags.filter((t) => t !== tag);
      const victim = pool.filter((t) => t.until != null).sort((a, b) => a.set - b.set)[0] || pool.sort((a, b) => a.set - b.set)[0];
      c.tags = c.tags.filter((t) => t !== victim);
      dropped = `; dropped "${victim.text}" (at most ${Eng.TAG_CAP})`;
    }
    return { note: `+"${text}" for ${n} turns${why ? ` (${why})` : ''}${dropped}` };
  };

  Eng.removeTag = function (c, value) {
    const low = cleanPhrase(value).toLowerCase();
    const before = (c.tags || []).length;
    c.tags = (c.tags || []).filter((t) => t.text.toLowerCase() !== low);
    return c.tags.length < before;
  };

  // Tags past their turn go; returns Debug lines.
  Eng.expireTags = function (state, turn) {
    const gone = [];
    Eng.cast(state).forEach((id) => {
      const c = state.characters[id];
      (c.tags || []).filter((t) => t.until != null && t.until < turn).forEach((t) => gone.push(`${c.name}: "${t.text}" expired`));
      c.tags = (c.tags || []).filter((t) => t.until == null || t.until >= turn);
    });
    return gone;
  };

  Eng.setMood = function (state, c, value, reason, turn) {
    let text = cleanPhrase(value);
    if (!text) return { error: 'empty mood' };
    if (text.length > 60) text = E.shorten(text, 60);
    if (leaksSecret(state, c.id, text)) return { error: 'the mood gives away their secret' };
    c.mood = { text, turn, reason: cleanPhrase(reason).slice(0, 100) };
    return {};
  };

  // Tags from engine numbers, computed when shown and never stored. A world can
  // change or add need thresholds with tagThresholds: { need: { at, tag } }.
  Eng.DERIVED_TAGS = {
    needs: { stress: { at: 0.8, tag: 'on edge' }, fatigue: { at: 0.8, tag: 'exhausted' }, hunger: { at: 0.8, tag: 'starving' }, fear: { at: 0.8, tag: 'terrified' } },
    health: { hurt: 'hurt', badly_hurt: 'badly hurt', dead: 'dead' },
  };
  Eng.derivedTags = function (state, c) {
    const out = [];
    const h = Eng.DERIVED_TAGS.health[c.status.health];
    if (h) out.push(h);
    if (c.status.health === 'dead') return out;
    const table = Object.assign({}, Eng.DERIVED_TAGS.needs, state.scenario.tagThresholds || {});
    state.scenario.needs.forEach((n) => {
      const t = table[n.id];
      if (t && t.tag && c.needs[n.id] != null && c.needs[n.id] >= t.at) out.push(t.tag);
    });
    return out;
  };

  // ---------- portraits and what you know (task 1-7) ----------
  // A character's picture: their own portrait, else a stand-in from the world's
  // portraitSet picked by hashing the id (so it never changes), else a monogram
  // (initials on a colour from the same hash). Paths are relative to the world
  // folder; the page turns them into URLs, and saves keep only the paths.
  Eng.portrait = function (state, id) {
    const c = state.characters[id];
    if (c.portrait) return { path: c.portrait };
    const set = state.scenario.portraitSet || [];
    if (set.length) return { path: set[E.hash(id) % set.length], standIn: true };
    return Eng.monogram(state, id);
  };
  // Initials (titles like "Dr." skipped) on a hue from the id.
  Eng.monogram = function (state, id) {
    const c = state.characters[id];
    const words = String(c.name || id).replace(/^(dr|mr|mrs|ms|mx|prof)\.?\s+/i, '').split(/\s+/).filter(Boolean);
    const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || id).slice(0, 2)).toUpperCase();
    return { monogram: initials, hue: E.hash(id) % 360 };
  };

  // Facts the player knows that are about this person, newest first.
  Eng.knownAbout = function (state, id) {
    return state.facts.filter((f) => (f.about || []).includes(id) && E.Memory.knows(f, state.player)).slice().reverse();
  };

  // ---------- relationship web (task 2-4) ----------
  // Who feels what about whom, as the player could know it. Nodes: you, the
  // local characters (and secondary ones on request), never the dead or
  // extras. Edges, as words only (numbers stay in Debug):
  //   you → them: your own feelings, with your note (source 'you')
  //   them → you: how they treat you, already on their card ('them')
  //   between two others: only when you know a fact about both ('seen'),
  //   with the latest such fact as the reason. Hidden feelings never show.
  const relLevel = (w) => ({ trusts: 2, hostile: 2, friendly: 1, wary: 1 }[w] || 0);
  Eng.relationWeb = function (state, opts) {
    const secondary = !!(opts && opts.secondary);
    const pc = state.characters[state.player];
    const nodes = Eng.cast(state, { alive: true }).filter((id) => id === state.player || secondary || Eng.tier(state, id) === 'local')
      .map((id) => ({ id, name: state.characters[id].name, isPlayer: id === state.player, tier: Eng.tier(state, id) }));
    const ids = nodes.map((n) => n.id);
    const edges = [];
    const add = (from, to, v, source, why) => {
      const word = E.relWord(v);
      edges.push({ from, to, word, level: relLevel(word), sign: v >= 15 ? 1 : v <= -15 ? -1 : 0, source, why: why || null });
    };
    ids.filter((id) => id !== state.player).forEach((id) => {
      add(state.player, id, pc.relations[id] || 0, 'you', (pc.attitudeNotes || {})[id]);
      add(id, state.player, state.characters[id].relations[state.player] || 0, 'them');
    });
    const known = state.facts.filter((f) => E.Memory.knows(f, state.player));
    ids.forEach((a) => ids.forEach((b) => {
      if (a === b || a === state.player || b === state.player) return;
      const fact = known.filter((f) => (f.about || []).includes(a) && (f.about || []).includes(b)).pop();
      if (fact) add(a, b, state.characters[a].relations[b] || 0, 'seen', fact.text);
    }));
    return { nodes, edges };
  };

  // ---------- applying the model's update ----------
  Eng.applyUpdate = function (state, upd, present, ctx) {
    ctx = ctx || {};
    const report = { applied: [], rejected: [], tags: [], extras: [] };
    const ids = new Set(Eng.cast(state));
    const extraIds = new Set(Object.keys(state.extras || {}));
    const reject = (what, why) => report.rejected.push(`${what} — ${why}`);
    const witnesses = [state.player].concat(present);
    // Who could know this turn's facts: the player, the people present and
    // anyone in this turn's events (hidden ones included). Playtest
    // (playtest-zombie-steps-outside): a scene fact was given to two people
    // in other rooms.
    const couldKnow = new Set(witnesses.concat(ctx.involved || [], ctx.extrasPresent || []));
    const named = (x) => ids.has(x) || extraIds.has(x);

    (Array.isArray(upd.facts) ? upd.facts : []).slice(0, 6).forEach((f) => {
      if (!f || !f.text) return reject('fact', 'no text');
      const about = (f.about || []).filter(named);
      let known = (f.known_by || []).filter((x) => x === 'all' || named(x));
      if (!known.includes('all')) {
        const absent = known.filter((x) => !couldKnow.has(x));
        if (absent.length) reject('fact known_by', `dropped ${absent.join(', ')}: not in the scene (${String(f.text).slice(0, 60)})`);
        known = known.filter((x) => couldKnow.has(x));
      }
      if (!known.length) known = witnesses.slice();
      const words = contentWords(f.text);
      const same = words.size >= 5 && state.facts.find((old) => {
        const ow = contentWords(old.text);
        if (ow.size < 5 || !(old.known_by.includes('all') || known.every((x) => x !== 'all' && old.known_by.includes(x)))) return false;
        let hit = 0;
        words.forEach((w) => { if (ow.has(w)) hit++; });
        return hit / Math.min(words.size, ow.size) >= 0.75;
      });
      if (same) return reject('fact', `already recorded: "${E.shorten(same.text, 80)}" (${E.shorten(String(f.text), 60)})`);
      const fact = E.Memory.addFact(state, { about, text: f.text, known_by: known, weight: f.weight });
      if (fact.weight >= 3) state.flags.chapterWorthy = true;
      // An individual extra in a notable fact comes to matter (task 2-3).
      about.filter((x) => extraIds.has(x) && !state.extras[x].group && !state.extras[x].promote && fact.weight >= 2).forEach((x) => {
        state.extras[x].promote = true;
        report.extras.push(`${state.extras[x].name}: in a notable fact, will become a full character`);
      });
      report.applied.push(`fact: ${fact.text} (w${fact.weight}, known by ${fact.known_by.join('/')})`);
    });

    (Array.isArray(upd.state) ? upd.state : []).forEach((s) => {
      if (!s || typeof s.target !== 'string') return reject('state', 'no target');
      const [kind, key] = s.target.split(':');
      const label = JSON.stringify(s);
      if (kind === 'char' && extraIds.has(key)) {
        // Minor people have only a place.
        const x = state.extras[key];
        if (s.field !== 'location') return reject(label, 'minor people have only a location');
        const dest = Eng.resolveLocation(state, s.value, false);
        if (!dest) return reject(label, 'unknown location');
        if (![ctx.startLoc, ctx.endLoc].includes(x.location) && dest !== ctx.endLoc) return reject(label, 'nobody in the scene could have seen that move');
        if (ctx.keptProse != null && !Eng.seenLeaving(ctx.keptProse, x)) return reject(label, 'the player stepped in before they left');
        x.location = dest;
      } else if (kind === 'char') {
        const c = state.characters[key];
        if (!c) return reject(label, 'unknown character');
        if (s.field === 'health') {
          if (!HEALTH.includes(s.value)) return reject(label, 'bad health value');
          c.status.health = s.value;
          if (s.value === 'dead') {
            state.flags.chapterWorthy = true;
            if (key === state.player) state.flags.gameOver = true;
          }
        } else if (s.field === 'location') {
          if (key === state.player) return reject(label, "the player only moves through the player's own action");
          const dest = Eng.resolveLocation(state, s.value, false);
          if (!dest) return reject(label, 'unknown location');
          const inScene = [ctx.startLoc, ctx.endLoc].includes(c.status.location) || dest === ctx.endLoc;
          if (!inScene) return reject(label, 'nobody in the scene could have seen that move');
          // After a step-in, a planned exit only happened if the kept scene shows it.
          if (ctx.keptProse != null && !Eng.seenLeaving(ctx.keptProse, c)) return reject(label, 'the player stepped in before they left');
          c.status.location = dest;
        } else if (s.field === 'add_tag' || s.field === 'add_condition') {
          // add_condition: the name before tags (task 1-6); recordings still use it.
          const out = Eng.addTag(state, c, s.value, s.turns, s.reason, ctx.turn ?? state.turn);
          if (out.error) return reject(label, out.error);
          report.tags.push(`${c.name}: ${out.note}`);
        } else if (s.field === 'remove_tag' || s.field === 'remove_condition') {
          if (!Eng.removeTag(c, s.value)) return reject(label, 'tag not present');
          report.tags.push(`${c.name}: removed "${String(s.value)}"`);
        } else if (s.field === 'mood') {
          if (key === state.player) return reject(label, "the player's mood comes from the player, not the model");
          const out = Eng.setMood(state, c, s.value, s.reason, ctx.turn ?? state.turn);
          if (out.error) return reject(label, out.error);
          report.tags.push(`${c.name}: mood "${c.mood.text}"${c.mood.reason ? ` (${c.mood.reason})` : ''}`);
        } else if (s.field === 'need') {
          if (c.needs[s.need] == null) return reject(label, 'unknown need');
          c.needs[s.need] = E.clamp(c.needs[s.need] + E.clamp(Number(s.delta) || 0, -1, 1), 0, 1);
        } else return reject(label, 'unknown field');
      } else if (kind === 'world') {
        if (!(key in state.world)) return reject(label, 'unknown world key');
        const lock = (state.worldSetBy || {})[key];
        if (lock && lock.turn === (ctx.turn ?? state.turn)) return reject(label, `set by "${lock.clock}" this turn`);
        state.world[key] = String(s.value || '').slice(0, 120);
      } else if (kind === 'faction') {
        const f = (state.factions || []).find((x) => x.id === key);
        if (!f) return reject(label, 'unknown group');
        f.stance = String(s.value || '').slice(0, 140);
      } else if (kind === 'clock') {
        const cl = state.clocks.find((x) => x.id === key);
        if (!cl) return reject(label, 'unknown clock');
        if (cl.fired) return reject(label, 'clock already fired');
        cl.value = E.clamp(cl.value + E.clamp(Number(s.delta) || 0, -cl.max, cl.max), 0, cl.max);
        if (cl.value >= cl.max) Eng.fireClock(state, cl, { events: [] });
      } else return reject(label, 'unknown target kind');
      report.applied.push('state: ' + label);
    });

    (Array.isArray(upd.relations) ? upd.relations : []).forEach((r) => {
      if (r && (extraIds.has(r.from) || extraIds.has(r.to))) return reject('relation ' + JSON.stringify(r), 'minor people have no feelings tracked');
      if (!r || !ids.has(r.from) || !ids.has(r.to) || r.from === r.to) return reject('relation ' + JSON.stringify(r), 'bad ids');
      if (r.from === state.player) return reject('relation ' + JSON.stringify(r), "the player's feelings only change through player_attitude, from the player's own action");
      const c = state.characters[r.from];
      const d = E.clamp(Math.round(Number(r.delta) || 0), -15, 15);
      c.relations[r.to] = E.clamp((c.relations[r.to] || 0) + d, -100, 100);
      report.applied.push(`relation: ${r.from}→${r.to} ${d >= 0 ? '+' : ''}${d}${r.reason ? ' (' + r.reason + ')' : ''}`);
    });

    // The player's attitude is grounded in the player's own action text only.
    const pc = state.characters[state.player];
    pc.attitudeNotes = pc.attitudeNotes || {};
    (Array.isArray(upd.player_attitude) ? upd.player_attitude : []).slice(0, 4).forEach((a) => {
      if (a && extraIds.has(a.to)) return reject('player_attitude ' + JSON.stringify(a), 'minor people have no feelings tracked');
      if (!a || !ids.has(a.to) || a.to === state.player) return reject('player_attitude ' + JSON.stringify(a), 'bad id');
      const d = E.clamp(Math.round(Number(a.delta) || 0), -10, 10);
      if (!d) return;
      pc.relations[a.to] = E.clamp((pc.relations[a.to] || 0) + d, -100, 100);
      if (a.reason) pc.attitudeNotes[a.to] = E.shorten(a.reason, 80);
      report.applied.push(`your attitude: →${a.to} ${d > 0 ? '+' : ''}${d}${a.reason ? ' (' + a.reason + ')' : ''}`);
    });

    applyNewExtras(state, upd.new_extras, ctx.turn ?? state.turn, ctx.endLoc || state.characters[state.player].status.location,
      (why) => reject('new_extras', why), (note) => report.extras.push(note));

    if (upd.chapter_worthy === true) state.flags.chapterWorthy = true;
    return report;
  };

  // True when a paragraph naming the character also shows someone leaving
  // ("She's gone toward Ops", "He's backing toward the corridor").
  const LEAVING = /\b(?:leaves|left|leaving|exits|disappears|(?:is|'s|was)\s+gone|heads?\s+(?:out|off|for|to|toward|towards|back)|heading\s+(?:out|off|for|to|toward|towards)|goes\s+(?:out|off|to|back)|(?:walks|slips|steps|ducks|hurries)\s+(?:out|off|away)|backing\s+(?:out|away|toward|towards))\b/i;
  Eng.seenLeaving = (prose, c) =>
    String(prose || '').split(/\n\s*\n/).some((p) => mentions(p, c) && LEAVING.test(p.replace(/[‘’]/g, "'")));

  // Removes repeated paragraphs (a common small-model loop), ignoring quotes and spacing.
  // If generation hit the token cap mid-sentence, cut back to the last full sentence.
  Eng.trimIncomplete = function (text) {
    const t = String(text || '').trim();
    if (!t || /[.!?…]["'”’)*]*$/.test(t)) return t;
    const m = t.match(/^[\s\S]*[.!?…]["'”’)*]*/);
    if (!m) return t;
    // Cut inside a line of dialogue ("Y-yes, Imani. Just trying to…"): close it.
    const out = m[0].trim();
    const last = out.split(/\n\s*\n/).pop();
    if ((last.match(/"/g) || []).length % 2) return out + '"';
    if ((last.match(/“/g) || []).length > (last.match(/”/g) || []).length) return out + '”';
    return out;
  };

  // The narrator sometimes copies the "[okafor]" id tags it has seen in
  // prompts into the prose (playtest-id-tags-in-prose). Ids and names in
  // brackets become the name people use: the surname after a title
  // ("Dr. Imani Okafor" → "Okafor"), else the first name.
  Eng.shortName = (c) => {
    const m = /^(?:dr|mr|mrs|ms|mx|capt|sgt|prof)\.?\s+(.+)$/i.exec(c.name || '');
    const words = (m ? m[1] : String(c.name || c.id)).split(/\s+/);
    return m ? words[words.length - 1] : words[0];
  };
  Eng.replaceIdTags = function (state, text, res) {
    const seen = {};
    const out = String(text || '').replace(/\[([A-Za-z][\w .'-]{0,40})\]/g, (all, inner) => {
      const key = inner.trim().toLowerCase();
      const c = Object.values(state.characters).find((ch) => ch.id.toLowerCase() === key || String(ch.name || '').toLowerCase() === key);
      if (!c) return all;
      const name = Eng.shortName(c);
      seen[`${all} → ${name}`] = (seen[`${all} → ${name}`] || 0) + 1;
      return name;
    });
    Object.entries(seen).forEach(([k, n]) => guard(res, 'scene', 'id tag replaced', `${k}${n > 1 ? ` (×${n})` : ''}`));
    return out;
  };

  Eng.cleanProse = function (text) {
    text = Eng.trimIncomplete(text);
    const seen = new Set();
    const norm = (p) => p.toLowerCase().replace(/^\s*\[[^\]]*\]/, '').replace(/["'\u201c\u201d\u2018\u2019*]/g, '').replace(/\s+/g, ' ').trim();
    return String(text || '')
      .split(/\n\s*\n/)
      .filter((p) => {
        const k = norm(p);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .join('\n\n')
      .trim();
  };

  // Detects narration that walks the player into a room they never moved to,
  // e.g. "You head to hydroponics". Returns the location or null.
  Eng.findRelocation = function (state, prose, startLoc) {
    const endLoc = state.characters[state.player].status.location;
    // Rooms passed through on the way are fine ("you cross the commons to the med bay").
    const allowed = new Set([startLoc, endLoc].concat(Eng.route(state, startLoc, endLoc)));
    const verbs = "head|heads|heading|walk|walks|go|goes|step|steps|stepping|make your way|enter|enters|duck|ducks|push open|pushes open|slip|slips|hurry|hurries|return|returns|wander|wanders|move|moves|cross|crosses";
    // Going outside names no room (playtest-zombie-steps-outside: "You nod, then
    // step outside into the cool morning air"). Only when the player isn't moving:
    // a stated move outdoors is checked by room name below.
    if (startLoc === endLoc && new RegExp(`\\byou\\b[^.!?\\n]{0,30}\\b(?:${verbs})\\b\\s+(?:back\\s+)?(?:outside|outdoors|out into|out the (?:front |back )?door)\\b`, 'i').test(prose)) {
      return { id: null, name: 'outside', to: 'outside' };
    }
    for (const l of Object.values(state.locations)) {
      if (allowed.has(l.id)) continue;
      const names = [l.name, l.id].concat(l.name.split(/\s*&\s*|\s+and\s+/)).filter((n) => n && n.length > 2);
      for (const n of names) {
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\byou\\b[^.!?\\n]{0,30}\\b(?:${verbs})\\b[^.!?\\n]{0,40}\\b${esc}\\b`, 'i');
        if (re.test(prose)) return l;
      }
    }
    return null;
  };

  // Shortest path between two locations through `connects`, both ends included.
  // Empty when either is unknown or there is no way through.
  Eng.route = function (state, from, to) {
    if (!state.locations[from] || !state.locations[to]) return [];
    if (from === to) return [from];
    const prev = { [from]: null };
    const queue = [from];
    while (queue.length) {
      const id = queue.shift();
      for (const next of state.locations[id].connects || []) {
        if (!state.locations[next] || next in prev) continue;
        prev[next] = id;
        if (next === to) {
          const path = [to];
          for (let at = id; at !== null; at = prev[at]) path.unshift(at);
          return path;
        }
        queue.push(next);
      }
    }
    return [];
  };

  // Drops trailing paragraphs that are the player character's own action or
  // thoughts ("You turn back to…"), so the scene ends on someone else's move.
  // A beat that is only the player's action goes too. But once a paragraph
  // has been dropped, the paragraph that opens its beat (a time marker) stays:
  // dropping both lost the whole live scene that ends a skip
  // (playtest-agenda-skips).
  Eng.trimPlayerEnding = function (prose) {
    const paras = String(prose || '').split(/\n\s*\n/);
    let dropped = 0;
    while (paras.length > 1 && dropped < 2 && /^\s*(\[[^\]]*\]\s*)?(you|your)\b/i.test(paras[paras.length - 1])) {
      if (dropped && /^\s*\[\s*\+/.test(paras[paras.length - 1])) break;
      paras.pop();
      dropped++;
    }
    return paras.join('\n\n').trim();
  };

  // The full cleanup for a model-written scene, recording what it changed.
  // Paragraphs that retell the previous scene (80% of their content words in
  // it) are dropped; inline time markers start their own paragraph first.
  // playtest-agenda-skips: a downtime scene opened by repeating the last one.
  Eng.dropRetold = function (state, text, res) {
    const last = state.recent && state.recent[state.recent.length - 1];
    const prev = contentWords(last && last.text);
    if (prev.size < 8) return text;
    const MARK = /\[\s*\+\s*\d[^\]]*\]/g;
    const paras = String(text).replace(/[ \t]+(\[\s*\+\s*\d[^\]]*\])/g, '\n\n$1').split(/\n\s*\n/);
    const retold = (para) => {
      const w = [...contentWords(para.replace(MARK, ''))];
      return w.length >= 8 && w.filter((x) => prev.has(x)).length / w.length >= 0.8;
    };
    const kept = paras.filter((para) => !retold(para));
    if (kept.length === paras.length || !kept.length) return text;
    guard(res, 'scene', 'retold last scene', `dropped ${paras.length - kept.length} of ${paras.length} paragraphs`);
    return kept.join('\n\n');
  };

  // Script-style speaker labels at the start of a paragraph ("You (Jordan
  // Pike): ...", "Mrs. Albee: ...") copy the outcome list's format; the label
  // goes and the line stays (playtest-albee-promoted).
  Eng.dropSpeakerLabels = function (state, text, res) {
    const names = new Set();
    Object.values(state.characters).concat(Object.values(state.extras || {})).forEach((c) => {
      [c.name, Eng.shortName(c), String(c.name || '').split(/\s+/)[0]].forEach((n) => n && n.length > 1 && names.add(n.toLowerCase()));
    });
    let n = 0;
    const out = String(text).split(/\n\s*\n/).map((para) => para.replace(/^(\s*(?:\[[^\]]*\]\s*)?)(?:you\s*\([^)\n]{1,40}\)|([A-Z][\w.' -]{1,40}?))\s*:\s+(?=\S)/i, (all, lead, label) => {
      if (label && !names.has(label.trim().toLowerCase())) return all;
      n++;
      return lead;
    })).join('\n\n');
    if (n) guard(res, 'scene', 'speaker label removed', `${n} paragraph${n > 1 ? 's' : ''}`);
    return n ? out : text;
  };

  // With state, character id tags in brackets become names, speaker labels
  // and retellings of the last scene go, first.
  Eng.cleanScene = function (text, res, state) {
    const raw = state ? Eng.dropRetold(state, Eng.dropSpeakerLabels(state, Eng.replaceIdTags(state, String(text || '').trim(), res), res), res) : String(text || '').trim();
    const whole = Eng.trimIncomplete(raw);
    if (whole !== raw) guard(res, 'scene', 'cut to last sentence', '…' + raw.slice(raw.startsWith(whole) ? whole.length : whole.length - 1));
    const paras = (t) => t.split(/\n\s*\n/).filter((p) => p.trim()).length;
    const clean = Eng.cleanProse(whole);
    if (paras(clean) < paras(whole)) guard(res, 'scene', 'repeated paragraph removed', `${paras(whole) - paras(clean)} of ${paras(whole)}`);
    const out = Eng.trimPlayerEnding(clean);
    if (out !== clean) guard(res, 'scene', 'player ending trimmed', clean.slice(out.length));
    return out;
  };

  // ---------- the turn ----------
  // ---------- beats ----------
  // The narrator marks beats with [+Nm] / [+Nh]. Returns [{at (minutes), text}].
  Eng.parseBeats = function (prose, spanMinutes) {
    const re = /\[\s*\+\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|sols?)?\s*\]/gi;
    const marks = [];
    let m;
    while ((m = re.exec(prose))) {
      const n = parseFloat(m[1]);
      const unit = (m[2] || 'm').toLowerCase();
      marks.push({ index: m.index, end: re.lastIndex, at: /^(d|sol)/.test(unit) ? n * 1440 : unit.startsWith('h') ? n * 60 : n });
    }
    if (!marks.length) return [{ at: 0, text: String(prose).trim() }];
    const beats = [];
    const lead = prose.slice(0, marks[0].index).trim();
    let last = 0;
    marks.forEach((mk, i) => {
      let text = prose.slice(mk.end, i + 1 < marks.length ? marks[i + 1].index : prose.length).trim();
      if (i === 0 && lead) text = lead + '\n\n' + text;
      const at = Math.round(E.clamp(Math.max(mk.at, last), 0, spanMinutes));
      last = at;
      if (text) beats.push({ at, text });
    });
    if (beats.length) beats[0].at = 0;
    return beats.length ? beats : [{ at: 0, text: String(prose).replace(re, '').trim() }];
  };

  const beatsText = (beats) => beats.map((b) => b.text).join('\n\n');
  const markedBeats = (beats) => beats.map((b) => `[+${b.at}m] ${b.text}`).join('\n\n');

  // Steps whose length is approximate ("about an hour", "a few hours"). A scene
  // covering under half the step gets one continuation; then the clock follows
  // the scene instead of the step. Other steps keep their fixed span.
  Eng.LOOSE_STEPS = ['hour', 'hours'];

  const timeSnapshot = (state) => ({
    time: E.clone(state.time),
    needs: E.clone(Eng.cast(state).map((id) => state.characters[id].needs)),
    clocks: state.clocks.map((c) => ({ value: c.value, fired: c.fired })),
    agendas: E.clone(Eng.cast(state).map((id) => state.characters[id].agenda || null)),
  });

  // Winds the clock back to where the scene actually ended: the last beat plus
  // a little for the beat itself. Keeps the full step if a pressure clock fired
  // (the scene is built around it). Returns true when time changed.
  const restoreTime = (state, snap) => {
    state.time = E.clone(snap.time);
    Eng.cast(state).forEach((id, i) => { state.characters[id].needs = E.clone(snap.needs[i]); });
    state.clocks.forEach((c, i) => { if (snap.clocks[i]) c.value = snap.clocks[i].value; });
    if (snap.agendas) Eng.cast(state).forEach((id, i) => { if (snap.agendas[i]) state.characters[id].agenda = E.clone(snap.agendas[i]); });
  };

  Eng.settleSceneTime = function (state, beats, spanMinutes, before, res) {
    const end = Math.min(spanMinutes, beats[beats.length - 1].at + Math.round(spanMinutes * 0.1));
    if (end >= spanMinutes) return false;
    if (state.clocks.length !== before.clocks.length || state.clocks.some((c, i) => c.fired !== before.clocks[i].fired)) return false;
    restoreTime(state, before);
    Eng.advanceTime(state, end / 60, res);
    return true;
  };

  // Records the previous turn's scene into memory. With cutAt = k, only beats
  // 1..k happened: the turn is rebuilt from its starting state, time advances
  // only to beat k, and later beats (and their moves) never happen.
  Eng.commitPending = async function (state, cutAt, phase) {
    const p = state.pending;
    if (!p) return null;
    const total = p.beats.length;
    const cut = cutAt && cutAt >= 1 && cutAt < total ? cutAt : null;
    let kept = p.beats;
    let endLoc = state.characters[state.player].status.location;

    if (cut) {
      kept = p.beats.slice(0, cut);
      const lastBeat = kept[kept.length - 1];
      const nextBeat = p.beats[cut];
      // the player steps in between the two beats
      const minutes = Math.round((lastBeat.at + nextBeat.at) / 2);
      const keepLog = state.log, keepTurn = state.turn, keepChapters = state.chapters;
      const pre = E.clone(p.pre);
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, pre);
      state.log = keepLog; state.turn = keepTurn; state.chapters = keepChapters;
      if (p.playerMovedTo) state.characters[state.player].status.location = p.playerMovedTo;
      // Corrections the player made while this turn was pending still stand.
      (p.corrections || []).forEach((c) => applyCorrection(state, c));
      endLoc = state.characters[state.player].status.location;
      Eng.advanceTime(state, minutes / 60, { events: [] }, !!p.routine);
      const entry = state.log.find((e) => e.turn === p.turn && e.type === 'scene');
      if (entry) entry.cutAt = cut;
      const actionEntry = state.log.find((e) => e.turn === p.turn && e.type === 'action');
      if (actionEntry) actionEntry.until = E.fmtTime(state);
      state.recent = [{ turn: p.turn, action: p.action, text: beatsText(kept) + `\n\n[${state.characters[state.player].name} steps in here, at ${E.fmtTime(state)}.]` }];
    }

    phase('Updating memory…');
    const prose = beatsText(kept);
    let report;
    try {
      const upd = await E.LLM.chatJSON({
        kind: 'update', system: E.Prompts.header(state), user: E.Prompts.update(state, p.action, p.res, prose, p.present, !!cut),
        maxTokens: 520, temperature: 0.3,
      });
      const expired = Eng.expireTags(state, p.turn);
      report = Eng.applyUpdate(state, upd, p.present, { startLoc: p.frame.startLoc, endLoc, keptProse: cut ? prose : null, involved: p.res.involved, turn: p.turn, extrasPresent: p.extrasPresent || [] });
      report.rejected.forEach((r) => guard(p.res, 'memory', 'update rejected', r));
      expired.concat(report.tags).forEach((t) => guard(p.res, 'memory', 'tags & mood', t));
      report.extras.forEach((t) => guard(p.res, 'memory', 'extras', t));
    } catch (err) {
      E.Memory.addFact(state, { about: [state.player], text: `${state.characters[state.player].name}: ${p.action}`.slice(0, 200), known_by: ['all'], weight: 1 });
      report = { applied: [], rejected: [], warning: 'Update step failed: ' + err.message };
      guard(p.res, 'memory', 'update failed', err.message);
    }
    if (cut) report.applied.unshift(`interjected after beat ${cut} of ${total}`);
    // Tiers follow the scene as it played out. After a step-in the events may
    // not have reached the player, so only the people there count.
    const eventWho = cut ? [] : [].concat(...(p.res.director || []).filter((d) => d.visibility !== 'hidden').map((d) => d.who || []));
    Eng.updateTiers(state, p.turn, { here: Eng.present(state), events: eventWho }).forEach((t) => guard(p.res, 'memory', 'cast tier', t));
    delete state.pending;
    await promoteExtra(state, p.turn, p.res, phase);
    await proposeAgenda(state, p.res, phase);

    const why = E.Memory.needsChapter(state);
    if (why) {
      phase('Closing the chapter…');
      try {
        const sum = await E.LLM.chatJSON({ kind: 'chapter', system: E.Prompts.header(state), user: E.Prompts.chapter(state), maxTokens: 260, temperature: 0.4 });
        E.Memory.closeChapter(state, sum, why);
        state.log.push({ turn: state.turn, type: 'chapter', chapter: state.chapters[state.chapters.length - 1] });
      } catch (err) {
        report.warning = (report.warning ? report.warning + ' ' : '') + 'Chapter summary failed; will retry next turn.';
      }
    }
    return report;
  };

  // An extra who has come to matter becomes a full character: one
  // "worldbuild" call per turn at most, checked like a character file. The id
  // stays, so facts about them still hold. They join as local, in the header's
  // newcomers block (the cast block never changes). Two tries, then they stay
  // an extra.
  Eng.PROMOTE_TRIES = 2;
  async function promoteExtra(state, turn, res, phase) {
    const x = Object.values(state.extras || {}).find((e) => e.promote && !e.group && e.tries < Eng.PROMOTE_TRIES);
    if (!x) return;
    x.tries += 1;
    phase(`Getting to know ${x.name}…`);
    let c;
    try {
      const raw = await E.LLM.chatJSON({ kind: 'worldbuild', system: E.Prompts.header(state), user: E.Prompts.fleshOut(state, x.id), maxTokens: 700, temperature: 0.7 });
      c = Eng.characterFromExtra(state, x, raw, turn);
    } catch (err) {
      c = { error: 'the call failed: ' + err.message };
    }
    if (c.error) return guard(res, 'memory', 'promotion rejected', `${x.name}: ${c.error}${x.tries < Eng.PROMOTE_TRIES ? '; will try again' : '; stays a minor person'}`);
    state.characters[c.id] = c;
    state.order.push(c.id);
    delete state.extras[x.id];
    guard(res, 'memory', 'extra promoted', `${c.name} (${c.pronouns}), ${c.role}: wants ${c.want}${c.agenda ? `; agenda: ${c.agenda.goal}` : ''}`);
  }

  // The model's sheet for an extra → a character, or { error }.
  const text = (v, n) => (typeof v === 'string' && v.replace(/\s+/g, ' ').trim() ? v.replace(/\s+/g, ' ').trim().slice(0, n) : null);
  Eng.characterFromExtra = function (state, x, raw, turn) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not a character sheet' };
    const sc = state.scenario;
    const want = text(raw.want, 160);
    if (!want) return { error: 'no "want"' };
    const traits = (Array.isArray(raw.traits) ? raw.traits : []).map((t) => text(t, 30)).filter(Boolean).slice(0, 4);
    if (!traits.length) return { error: 'no "traits"' };
    const c = {
      id: x.id, name: x.name, pronouns: text(raw.pronouns, 20) || x.pronouns || 'they/them', role: text(raw.role, 60) || x.role,
      traits, want, voice: text(raw.voice, 160) || undefined,
      description: text(raw.description, 600) || undefined, appearance: text(raw.appearance, 400) || undefined,
      skills: {}, relations: {}, status: { health: 'ok', location: x.location || state.characters[state.player].status.location },
      needs: {}, tags: [], tier: 'local', lastSeen: turn, joined: turn,
    };
    const age = Math.round(Number(raw.age));
    if (age > 0 && age < 130) c.age = age;
    const secret = text(raw.secret, 300);
    if (secret && !/^(none|null|no secret)\.?$/i.test(secret)) {
      c.secret = secret;
      c.guard = ['low', 'medium', 'high'].includes(raw.guard) ? raw.guard : 'medium';
    }
    sc.skills.forEach((k) => { c.skills[k] = E.clamp(Math.round(Number((raw.skills || {})[k]) || 1), 0, 4); });
    Object.entries(raw.relations && typeof raw.relations === 'object' ? raw.relations : {}).forEach(([k, v]) => {
      if (state.characters[k] && k !== x.id) c.relations[k] = E.clamp(Math.round(Number(v) || 0), -30, 30);
    });
    sc.needs.forEach((n) => { c.needs[n.id] = 0.2; });
    if (raw.agenda != null) {
      const a = Eng.cleanAgenda(raw.agenda, true);
      if (!a.error) c.agenda = a.agenda;
    }
    Object.keys(c).forEach((k) => c[k] === undefined && delete c[k]);
    const problems = E.Scenario.characterProblems(c, sc, new Set(Object.keys(state.locations)), Object.keys(state.characters));
    return problems.length ? { error: problems.join('; ') } : c;
  };

  // Someone in the background with no agenda (no field at all), or a finished
  // one not yet followed up, gets one from the model: one call per turn at
  // most, validated; anything invalid (or a failed call) is routine.
  Eng.needsAgenda = (state) => Eng.cast(state, { alive: true, includePlayer: false, tier: 'secondary' }).find((id) => {
    const c = state.characters[id];
    return !('agenda' in c) || (c.agenda && c.agenda.done && !c.agenda.followUp);
  });
  async function proposeAgenda(state, res, phase) {
    const id = Eng.needsAgenda(state);
    if (!id) return;
    const c = state.characters[id];
    const previous = c.agenda && c.agenda.done ? c.agenda.goal : null;
    phase('Planning ahead…');
    let out;
    try {
      const raw = await E.LLM.chatJSON({ kind: 'intent (agenda)', system: E.Prompts.header(state), user: E.Prompts.agenda(state, id, previous), maxTokens: 220, temperature: 0.7 });
      out = Eng.cleanAgenda(raw, true);
    } catch (err) {
      out = { error: 'the call failed: ' + err.message };
    }
    if (out.error) {
      c.agenda = null;
      guard(res, 'memory', 'agenda rejected', `${c.name}: ${out.error}; keeps to routine`);
      return;
    }
    c.agenda = out.agenda;
    if (c.agenda && previous) c.agenda.followUp = true;
    guard(res, 'memory', 'agenda set', c.agenda
      ? `${c.name}: ${c.agenda.goal} (${c.agenda.steps.length} steps, ${c.agenda.hours} h each${c.agenda.steps.some((st) => st.contact) ? ', comes to you' : ''})`
      : `${c.name}: keeps to routine`);
  }

  // True when the player's own words name a location ("work in the lab").
  function planNames(state, text, locId) {
    const l = state.locations[locId];
    const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    return [l.id, l.name].concat(l.name.split(/\s*&\s*|\s+and\s+/))
      .map((n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
      .some((n) => n.length > 2 && t.includes(' ' + n + ' '));
  }

  // The downtime turn: simulate time, ask the model for a montage and (if
  // needed) the interrupting event, then narrate it with day-stamped beats.
  async function skipTurn(state, action, phase) {
    const plan = Eng.planMajorSkip(state);
    const tierChanges = Eng.promoteForAction(state, Eng.present(state), action, state.turn + 1);
    const pre = E.clone(state);
    delete pre.log; delete pre.pending; delete pre.undo;
    state.turn += 1;
    const system = E.Prompts.header(state);
    const frame = { startTime: E.fmtTime(state), startLoc: state.characters[state.player].status.location, stepId: 'major', stepLabel: 'until something major happens', spanMinutes: Math.round(plan.hours * 60) };
    const presentStart = Eng.present(state);
    const res = { outcomes: [], events: [], guards: [] };
    tierChanges.forEach((t) => guard(res, 'resolve', 'cast tier', t));

    phase('Fast-forwarding…');
    Eng.advanceTime(state, plan.hours, res, true);
    const agendaSteps = Eng.runAgendas(state, plan.hours, plan, res);
    frame.endTime = E.fmtTime(state);
    frame.days = Math.round(plan.hours / 24 * 10) / 10;

    phase('Simulating the downtime…');
    const obj = await E.LLM.chatJSON({
      kind: 'intent', system, user: E.Prompts.skipIntent(state, action, plan, frame, res, agendaSteps),
      maxTokens: 900, temperature: 0.8,
    });

    // what happened in the meantime
    Eng.applyEvents(state, { events: Array.isArray(obj.events) ? obj.events : [] }, [], 'hours', res,
      { regional: true, world: plan.hours >= 72 }, { local: 2, regional: 2, world: plan.hours >= 72 ? 1 : 0 }, true);
    // the interrupting event, when it isn't a pressure clock firing or someone's agenda
    if (plan.reason === 'agenda') {
      const c = state.characters[plan.agenda.id];
      const text = stepSentence(c, plan.agenda);
      res.events.push(`[major] ${text}`);
      res.major = { text, scope: 'agenda', who: plan.agenda.id };
    } else if (plan.reason !== 'clock') {
      const m = obj.major_event && typeof obj.major_event.text === 'string' ? obj.major_event : { text: 'Something goes badly wrong, and the routine ends.' };
      const text = m.text.trim().slice(0, 240);
      const scope = ['regional', 'world'].includes(m.scope) ? m.scope : 'local';
      const effects = applyEffects(state, m.effects, scope, res);
      const region = eventRegion(state, m, scope, res);
      res.events.push(`[major] ${text}`);
      E.Memory.addFact(state, { about: (m.who || []).filter((id) => state.characters[id]), text, known_by: ['all'], weight: 3 });
      if (scope !== 'local') { state.news.push({ scope, text, time: E.fmtTime(state), effects, region }); state.tierLast[scope] = absHours(state); }
      res.major = { text, scope, effects, region };
    } else {
      // The planned clock's own text: model events were applied after it (playtest-agenda-skips).
      const cl = state.clocks.find((c) => c.id === plan.clock.id);
      res.major = { text: (cl && cl.fireText) || `${plan.clock.name} has come to pass.`, scope: 'clock' };
    }
    // where everyone is when it hits
    (Array.isArray(obj.positions) ? obj.positions : []).forEach((p) => {
      const c = p && state.characters[p.id];
      const loc = c && Eng.resolveLocation(state, p.where, false);
      if (c && loc && Eng.alive(state, p.id)) c.status.location = loc;
    });
    // The player ends up somewhere else only if their plan names it (rule 3;
    // playtest-agenda-skips: "keep to routine" put Kit outside as the storm hit).
    const pw = Eng.resolveLocation(state, obj.player_where, false);
    if (pw && pw !== frame.startLoc) {
      if (planNames(state, action, pw)) state.characters[state.player].status.location = pw;
      else guard(res, 'resolve', 'move cancelled', `the downtime put the player in ${pw}; their plan doesn't take them there`);
    }
    // The agenda that ends the downtime brings its person to the player.
    if (plan.reason === 'agenda') {
      const c = state.characters[plan.agenda.id];
      if (activeAgenda(c) && c.agenda.due) {
        c.status.location = state.characters[state.player].status.location;
        E.Memory.addFact(state, { about: [c.id], text: res.major.text, known_by: [c.id, state.player], weight: 2 });
        completeStep(state, c, res, 'ends the downtime');
      }
    }
    res.outcomes.push({ id: state.player, action: action || 'keeps to routine through the downtime', visible: true, roll: null, moved: null });
    state.flags.chapterWorthy = true;

    const montage = Array.isArray(obj.montage) ? obj.montage.filter((x) => x && x.text).slice(0, 5) : [];
    const doings = (Array.isArray(obj.positions) ? obj.positions.filter((p) => p && state.characters[p.id] && p.doing) : [])
      .map((p) => (plan.reason === 'agenda' && p.id === plan.agenda.id ? Object.assign({}, p, { doing: plan.agenda.text }) : p));
    if (plan.reason === 'agenda' && !doings.some((p) => p.id === plan.agenda.id)) doings.push({ id: plan.agenda.id, doing: plan.agenda.text });
    const narration = { skip: true, system, action, montage, doings, presentStart };
    const beats = await writeSkipScene(state, narration, { frame, res }, phase);
    const text = beatsText(beats);
    state.log.push({ turn: state.turn, type: 'action', text: action || '(downtime)', time: frame.startTime, until: frame.endTime, skip: plan.reason });
    state.log.push({ turn: state.turn, type: 'resolve', outcomes: res.outcomes, events: res.events });
    state.log.push({ turn: state.turn, type: 'scene', text, beats, startDay: pre.time.day, startMinutes: Math.round(pre.time.hour * 60) });
    state.recent = [{ turn: state.turn, action, text }];
    const here = state.characters[state.player].status.location;
    const witnesses = Eng.present(state);
    frame.startLoc = here;
    state.pending = { turn: state.turn, action: action || 'Keeps to routine through the downtime.', res, frame, present: witnesses, beats, pre, routine: true, narration };
    phase('');
    return { prose: text, beats, res, plan };
  }

  async function writeSkipScene(state, n, p, phase) {
    phase('Writing the downtime…');
    const prose = Eng.cleanScene(await E.LLM.chat({
      kind: 'narrate', system: n.system, user: E.Prompts.narrateSkip(state, n.action, p.frame, n.montage, n.doings, p.res, n.presentStart),
      maxTokens: Math.round(E.settings.narrateTokens * 2.2),
    }), p.res, state);
    if (!prose) throw new Error('The model returned an empty scene.');
    return Eng.parseBeats(prose, p.frame.spanMinutes);
  }

  // Writes the scene for a resolved turn: narrate, keep the player in the room,
  // fill a short scene, settle the clock. Shared by the turn and Reroll.
  // n: what the narrate call needs (system, step, time before the step);
  // p: present, action, frame, res. Returns { beats, until }.
  async function writeScene(state, n, p, phase) {
    const { step, system } = n;
    const { present, action, frame, res } = p;
    phase('Writing the scene…');
    const narrateOnce = async () => Eng.cleanScene(await E.LLM.chat({
      kind: frame.correction ? 'narrate (retry)' : 'narrate', system, user: E.Prompts.narrate(state, present, action, frame, res),
      maxTokens: Math.round(E.settings.narrateTokens * (step.lengthMult || 1)),
    }), res, state);
    let prose = await narrateOnce();
    const strayed = Eng.findRelocation(state, prose, frame.startLoc);
    if (strayed) {
      const where = strayed.to || `to ${strayed.name}`;
      guard(res, 'scene', 'relocation regenerated', `first draft took the player ${where}`);
      phase('Rewriting the scene…');
      const here = state.locations[state.characters[state.player].status.location].name;
      frame.correction = `Your previous draft took the player character ${where}, which did not happen. The whole scene stays in ${here}${state.characters[state.player].status.location !== frame.startLoc ? ' (after the move shown above)' : ''}.`;
      const retry = await narrateOnce();
      if (retry) prose = retry;
    }
    if (!prose) throw new Error('The model returned an empty scene.');

    let beats = Eng.parseBeats(prose, frame.spanMinutes);
    let until;
    if (Eng.LOOSE_STEPS.includes(step.id)) {
      const lastAt = beats[beats.length - 1].at;
      if (lastAt < frame.spanMinutes / 2) {
        phase('Finishing the scene…');
        const more = Eng.cleanScene(await E.LLM.chat({
          kind: 'narrate (continue)', system, user: E.Prompts.narrateMore(state, present, action, frame, res, markedBeats(beats), lastAt),
          maxTokens: Math.round(E.settings.narrateTokens * 0.8),
        }), res, state);
        const away = more && Eng.findRelocation(state, more, frame.startLoc);
        if (away) guard(res, 'scene', 'continuation dropped', `it took the player ${away.to || `to ${away.name}`}`);
        else if (more) {
          beats = Eng.parseBeats(Eng.trimPlayerEnding(Eng.cleanProse(markedBeats(beats) + '\n\n' + more)), frame.spanMinutes);
        }
      }
      if (Eng.settleSceneTime(state, beats, frame.spanMinutes, n.before, res)) until = E.fmtTime(state);
    }
    return { beats, until };
  }

  // ---------- the turn ----------
  // cutAt: when the player interjects, the beat number they step in after.
  // A finished turn keeps the state it started from in state.undo (one level).
  Eng.runTurn = async function (state, action, stepId, onPhase, cutAt) {
    const phase = onPhase || (() => {});
    if (state.flags.gameOver) throw new Error('This story has ended. Start a new game or load a save.');
    const snapshot = E.clone(state);
    const committing = state.pending ? { turn: state.pending.turn, res: state.pending.res } : null;
    const tel = startReport('turn', state.turn + 1, action, stepId);
    const rec = E.Recorder && E.Recorder.begin('turn', { action, stepId, cutAt: cutAt || null });
    // The update step's guards belong to the scene it records, the turn before this one.
    const guardsOf = () => [].concat(
      committing && committing.res && committing.res.guards ? committing.res.guards.filter((g) => g.stage === 'memory').map((g) => Object.assign({ turn: committing.turn }, g)) : [],
      state.pending && state.pending.turn === state.turn && state.pending.res !== (committing && committing.res) ? (state.pending.res.guards || []).map((g) => Object.assign({ turn: state.turn }, g)) : []);
    try {
      const out = await playTurn(state, action, stepId, phase, cutAt);
      delete snapshot.undo;
      state.undo = { state: snapshot, turn: state.turn, action, stepId, cutAt: cutAt || null };
      if (state.pending && state.pending.turn === state.turn) Object.assign(tel, describeTurn(state, state.pending));
      finishReport(tel, guardsOf());
      if (rec) rec.end();
      return out;
    } catch (err) {
      finishReport(tel, guardsOf(), err);
      if (rec) rec.end(err);
      replaceState(state, snapshot);
      phase('');
      throw err;
    }
  };

  // ---------- telemetry ----------
  // One report per turn (and per reroll): its model calls with tokens and
  // timing, and the guards that fired. In memory only, never saved.
  Eng.telemetry = [];
  Eng.telemetryMax = 20;

  function startReport(kind, turn, action, stepId) {
    const t = { kind, turn, action: action || '', stepId, calls: [], guards: [], ms: 0, started: Date.now() };
    E.LLM.collector = t.calls;
    return t;
  }
  function finishReport(t, guards, err) {
    if (E.LLM.collector === t.calls) E.LLM.collector = null;
    t.ms = Date.now() - t.started;
    t.guards = guards || [];
    if (err) t.error = String(err.message || err);
    Eng.telemetry.push(t);
    if (Eng.telemetry.length > Eng.telemetryMax) Eng.telemetry.shift();
  }

  // What the engine decided and the scene as written, for the copied report.
  // This is Debug, so covert actions and hidden events are shown as they are.
  function describeTurn(state, p) {
    const nm = (id) => (state.characters[id] ? state.characters[id].name : id);
    const outcomes = (p.res.outcomes || []).map((o) => {
      const bits = [`${nm(o.id)}: ${o.action}`];
      if (o.roll) bits.push(`${o.skill} d20 ${o.roll.d} → ${o.roll.total} vs ${o.roll.dc}: ${o.roll.result}`);
      if (o.moved) bits.push(`moved to ${state.locations[o.moved] ? state.locations[o.moved].name : o.moved}`);
      if (o.says) bits.push(`says "${o.says}"`);
      if (o.reveals) bits.push(`REVEALS: ${o.reveals}`);
      if (o.note) bits.push(o.note);
      if (o.visible === false) bits.push('unseen by the player');
      return bits.join(' · ');
    });
    const events = (p.res.director || []).map((d) => `event [${d.scope}, ${d.visibility}]: ${d.text}${d.effects && d.effects.length ? ` (${d.effects.join('; ')})` : ''}`);
    if (p.res.major) events.push(`major: ${p.res.major.text}`);
    return { outcomes: outcomes.concat(events), scene: markedBeats(p.beats) };
  }

  // Totals for a report; tokens marked estimated if any call lacked usage.
  Eng.reportTotals = function (t) {
    const sum = (f) => t.calls.reduce((a, c) => a + (Number(c[f]) || 0), 0);
    return {
      calls: t.calls.length, promptTokens: sum('promptTokens'), completionTokens: sum('completionTokens'),
      estimated: t.calls.some((c) => c.estimated !== false), modelMs: sum('ms'),
      retries: t.calls.filter((c) => c.retry).length, salvaged: t.calls.filter((c) => c.salvaged).length,
    };
  };

  // Plain text, for pasting into a chat. "~" marks estimated token counts.
  Eng.turnReport = function (t) {
    const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
    const tok = (c, f) => (c.estimated !== false ? '~' : '') + (Number(c[f]) || 0);
    const tot = Eng.reportTotals(t);
    const lines = [];
    lines.push(`${t.kind === 'reroll' ? 'Reroll of turn' : 'Turn'} ${t.turn}${t.action ? ` · "${t.action}"` : ''}${t.stepId ? ` · ${t.stepId}` : ''} · ${sec(t.ms)}${t.error ? ` · FAILED: ${t.error}` : ''}`);
    lines.push(`${tot.calls} call(s), ${tot.estimated ? '~' : ''}${tot.promptTokens} tokens in, ${tot.estimated ? '~' : ''}${tot.completionTokens} out, ${sec(tot.modelMs)} waiting on the model` +
      (tot.retries ? `, ${tot.retries} retr${tot.retries > 1 ? 'ies' : 'y'}` : '') + (tot.salvaged ? `, ${tot.salvaged} salvaged` : ''));
    t.calls.forEach((c) => {
      const extra = [];
      if (c.cachedTokens != null) extra.push(`${c.cachedTokens} cached`);
      if (c.perf) extra.push(`prompt ${c.perf.processSec.toFixed(1)} s, gen ${c.perf.evalSec.toFixed(1)} s`);
      if (c.finish === 'length') extra.push('cut off');
      if (c.salvaged) extra.push('salvaged');
      if (c.error) extra.push('error: ' + c.error);
      lines.push(`- ${c.kind} [${c.backend}]: ${tok(c, 'promptTokens')} in, ${tok(c, 'completionTokens')} out, ${sec(c.ms || 0)}${extra.length ? ' (' + extra.join('; ') + ')' : ''}`);
    });
    lines.push(t.guards.length ? `Guards fired (${t.guards.length}):` : 'Guards fired: none');
    t.guards.forEach((g) => lines.push(`- ${g.type}${g.turn != null && g.turn !== t.turn ? ` (turn ${g.turn})` : ''}: ${g.detail}`));
    if (t.outcomes && t.outcomes.length) {
      lines.push('What happened:');
      t.outcomes.forEach((o) => lines.push('- ' + o));
    }
    if (t.scene) lines.push('Scene:', t.scene);
    return lines.join('\n');
  };

  const replaceState = (state, from) => { Object.keys(state).forEach((k) => delete state[k]); Object.assign(state, from); };

  async function playTurn(state, action, stepId, phase, cutAt) {
    const report = await Eng.commitPending(state, cutAt, phase);
    if (state.flags.gameOver) { phase(''); return { report, ended: true }; }
    if (stepId === 'major') {
      const out = await skipTurn(state, action, phase);
      out.report = report || { applied: [], rejected: [] };
      return out;
    }
    const step = E.stepHours(state, stepId);

    // Before the start snapshot, so a step-in (which rewinds to it) keeps it.
    const tierChanges = Eng.promoteForAction(state, Eng.present(state), action, state.turn + 1);
    const extraNotes = Eng.noteExtraMentions(state, action, state.turn + 1);
    const pre = E.clone(state);
    delete pre.log; delete pre.pending; delete pre.undo;
    state.turn += 1;
    const present = Eng.present(state);
    const extrasPresent = Eng.extrasAt(state, state.characters[state.player].status.location).map((x) => x.id);
    const system = E.Prompts.header(state); // same prefix for all calls this turn

    const due = Eng.tiersDue(state, step.hours);
    phase(due.world ? 'The wider world stirs…' : due.regional ? 'Something stirs nearby…' : 'Characters deciding…');
    const intentObj = await E.LLM.chatJSON({
      kind: 'intent', system, user: E.Prompts.intent(state, present, action, step.label, step.id, due),
      maxTokens: 260 + 150 * present.length + 80 * Eng.agendasDue(state).length + (due.regional ? 120 : 0) + (due.world ? 140 : 0), temperature: 0.7,
    });

    const frame = { startTime: E.fmtTime(state), startLoc: state.characters[state.player].status.location, stepId: step.id, stepLabel: step.label, words: step.words, spanMinutes: Math.round(step.hours * 60) };
    const res = Eng.resolve(state, intentObj, present, action, step.id, due);
    tierChanges.forEach((t) => guard(res, 'resolve', 'cast tier', t));
    extraNotes.forEach((t) => guard(res, 'resolve', 'extras', t));
    const before = timeSnapshot(state);
    Eng.advanceTime(state, step.hours, res);

    // Everything Reroll needs to write this scene again from the same resolution.
    const narration = { system, step, before, after: timeSnapshot(state) };
    const { beats, until } = await writeScene(state, narration, { present, action, frame, res }, phase);
    const text = beatsText(beats);
    const startMinutes = Math.round(pre.time.hour * 60);
    state.log.push({ turn: state.turn, type: 'action', text: action, time: frame.startTime, until });
    state.log.push({ turn: state.turn, type: 'resolve', outcomes: res.outcomes, events: res.events });
    state.log.push({ turn: state.turn, type: 'scene', text, beats, startDay: pre.time.day, startMinutes });
    state.recent = [{ turn: state.turn, action, text }];

    // Memory is recorded at the start of the next turn, once we know how
    // much of this scene the player let play out.
    const playerOut = res.outcomes.find((o) => o.id === state.player);
    state.pending = { turn: state.turn, action, res, frame, present, extrasPresent, beats, pre, playerMovedTo: playerOut && playerOut.moved, narration };

    phase('');
    return { prose: text, beats, res, report: report || { applied: [], rejected: [] } };
  }

  // ---------- correcting your feelings (task 1-8) ----------
  // The player fixes their own attitude when the model misread their tone. It
  // changes only the player's feelings, applies at once, and reaches the next
  // turn's prompts like any other attitude. A "why" replaces the note.
  // Corrections are logged in state.corrections (Debug), kept on a pending
  // turn so a step-in commit (which rewinds to the turn's start) re-applies
  // them, and recorded for replays. Undo goes back to before the last action,
  // so it also drops corrections made since then.
  Eng.correctAttitude = function (state, id, delta, why) {
    const pc = state.characters[state.player];
    if (!state.characters[id] || id === state.player || !Eng.cast(state).includes(id)) return { error: 'unknown person' };
    const d = E.clamp(Math.round(Number(delta) || 0), -20, 20);
    const note = String(why || '').replace(/\s+/g, ' ').trim();
    if (!d && !note) return { error: 'nothing to change' };
    const rec = E.Recorder && E.Recorder.begin('correct', { id, delta: d, why: note });
    if (rec) rec.end();
    applyCorrection(state, { id, delta: d, why: note });
    const entry = { turn: state.turn, id, delta: d, why: note, value: pc.relations[id] };
    (state.corrections = state.corrections || []).push(entry);
    if (state.corrections.length > 50) state.corrections.shift();
    if (state.pending) (state.pending.corrections = state.pending.corrections || []).push({ id, delta: d, why: note });
    return { value: pc.relations[id], note: (pc.attitudeNotes || {})[id] || '' };
  };
  function applyCorrection(state, c) {
    const pc = state.characters[state.player];
    pc.relations[c.id] = E.clamp((pc.relations[c.id] || 0) + c.delta, -100, 100);
    pc.attitudeNotes = pc.attitudeNotes || {};
    if (c.why) pc.attitudeNotes[c.id] = E.shorten(c.why, 80);
  }

  // ---------- suggested actions ----------
  // Ideas for the player's next action, for the page to offer as buttons that
  // fill the action box. Changes nothing: the player still edits and acts.
  // sceneText: the scene as far as the player has read it (default: all of it).
  Eng.SUGGEST_MAX = 4;
  Eng.suggestActions = async function (state, sceneText) {
    if (state.flags.gameOver) throw new Error('This story has ended.');
    const obj = await E.LLM.chatJSON({
      kind: 'suggest', system: E.Prompts.header(state), user: E.Prompts.suggest(state, sceneText),
      maxTokens: 180, temperature: 0.9,
    });
    const list = Eng.cleanSuggestions(obj);
    if (!list.length) throw new Error('The model gave no usable suggestions. Try again.');
    return list;
  };
  // Strings (or {text}) only, without list marks or quotes, short, no repeats.
  Eng.cleanSuggestions = function (obj) {
    const raw = Array.isArray(obj) ? obj : obj && Array.isArray(obj.suggestions) ? obj.suggestions : [];
    const seen = new Set();
    const out = [];
    raw.forEach((s) => {
      let t = typeof s === 'string' ? s : s && typeof s.text === 'string' ? s.text : '';
      t = t.replace(/[\r\n]+/g, ' ').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["“'‘]+|["”'’]+$/g, '').replace(/\s+/g, ' ').trim();
      if (!t || /^\.{2,}$|^…$/.test(t) || t.length > 160) return;
      const k = t.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      if (!k || seen.has(k) || out.length >= Eng.SUGGEST_MAX) return;
      seen.add(k);
      out.push(t);
    });
    return out;
  };

  // ---------- undo and reroll ----------
  Eng.canUndo = (state) => !!(state && state.undo && state.undo.state);

  // Puts the whole state back to how it was before the last action: facts,
  // time, clocks, rolls, chapters, and the previous scene pending again.
  // Returns what was undone so the page can refill the action box.
  Eng.undo = function (state) {
    if (!Eng.canUndo(state)) return null;
    const rec = E.Recorder && E.Recorder.begin('undo', {});
    if (rec) rec.end();
    const u = state.undo;
    const before = u.state;
    const info = {
      turn: u.turn, action: u.action, stepId: u.stepId, cutAt: u.cutAt,
      from: E.fmtTime(state), to: E.fmtTime(before),
      chaptersRemoved: state.chapters.slice(before.chapters.length).map((c) => c.n),
    };
    replaceState(state, before);
    return info;
  };

  Eng.canReroll = (state) => !!(state && state.pending && state.pending.narration && !state.flags.gameOver);

  // Writes the pending scene again. The intent call's result and the engine's
  // resolution (rolls, moves, events, clocks) stay; only the prose, its beats
  // and the time a loose step settles on change.
  Eng.rerollNarration = async function (state, onPhase) {
    const phase = onPhase || (() => {});
    if (!Eng.canReroll(state)) throw new Error('There is no scene to rewrite.');
    const snapshot = E.clone(state);
    const p = state.pending;
    const n = p.narration;
    const oldText = beatsText(p.beats);
    const tel = startReport('reroll', p.turn, p.action, p.frame.stepId);
    const rec = E.Recorder && E.Recorder.begin('reroll', {});
    const sceneGuards = () => (p.res.guards || []).filter((g) => g.stage === 'scene').map((g) => Object.assign({ turn: p.turn }, g));
    try {
      // back to the moment the scene was first written; the old draft's cleanup no longer applies
      state.recent = E.clone(p.pre.recent || []);
      delete p.frame.correction;
      p.res.guards = (p.res.guards || []).filter((g) => g.stage !== 'scene');
      if (n.after) restoreTime(state, n.after);
      let beats, until;
      if (n.skip) beats = await writeSkipScene(state, n, p, phase);
      else ({ beats, until } = await writeScene(state, n, p, phase));
      const text = beatsText(beats);
      const scene = state.log.find((e) => e.turn === p.turn && e.type === 'scene');
      if (scene) { scene.text = text; scene.beats = beats; }
      const act = state.log.find((e) => e.turn === p.turn && e.type === 'action');
      if (act && !n.skip) { if (until) act.until = until; else delete act.until; }
      state.recent = [{ turn: p.turn, action: n.skip ? n.action : p.action, text }];
      p.beats = beats;
      Object.assign(tel, describeTurn(state, p));
      finishReport(tel, sceneGuards());
      if (rec) rec.end();
      phase('');
      return { turn: p.turn, oldText, prose: text, beats, until };
    } catch (err) {
      finishReport(tel, sceneGuards(), err);
      if (rec) rec.end(err);
      replaceState(state, snapshot);
      phase('');
      throw err;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
