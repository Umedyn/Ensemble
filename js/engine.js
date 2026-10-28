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
      sites: {}, // generated places (task 4-4)
    };
    // Regions (task 3-1): what changes in play; the definition stays in the scenario.
    (sc.regions || []).forEach((r) => { state.regions[r.id] = Object.assign({ controller: r.controller ?? null, tags: (r.tags || []).slice(), status: r.status || '' }, r.known === false ? { known: false } : {}); });
    state.regionChanged = {};
    // Presence (R-5): {group: {region: 0–1}}, changed by events.
    state.presence = E.clone(sc.presence || {});
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
    state.standees = {};
    (sc.standees || []).forEach((g) => { state.standees[g.id] = Eng.newStandee(g); });
    // The local map (task 3-3): rooms the player knows, and where they last saw everyone.
    state.seenRooms = Object.values(state.locations).filter((l) => l.seen !== false).map((l) => l.id);
    Eng.initSite(state);
    state.known = {};
    Eng.knowAll(state, 0);
    Eng.noteSeen(state, null, 0);
    // Starting knowledge becomes private facts; scenario facts are public.
    sc.characterData.forEach((c) =>
      (c.knows || []).forEach((text) =>
        E.Memory.addFact(state, { about: [c.id], text, known_by: [c.id], weight: 2 })
      )
    );
    (sc.facts || []).forEach((text) => E.Memory.addFact(state, { about: [], text, known_by: ['all'], weight: 2 }));
    // The canon timeline (task 5-2): the past becomes facts and chapter zero.
    E.Timeline.seed(state);
    if (sc.opening) {
      state.recent = [{ turn: 0, action: null, text: sc.opening }];
      state.log.push({ turn: 0, type: 'scene', text: sc.opening });
    }
    return state;
  };

  // Saves and autosaves from older versions are upgraded one step at a time
  // when loaded. Each step takes a state at version n and returns n + 1.
  Eng.STATE_VERSION = 15;
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
    // Standees (task 3-2): group extras in a room become standees; groups in
    // no room are dropped (groups exist only on the local map).
    7: (state) => {
      const convert = (st) => {
        st.standees = st.standees || {};
        Object.values(st.extras || {}).filter((x) => x.group).forEach((x) => {
          if (x.location && !st.standees[x.id]) {
            st.standees[x.id] = Eng.newStandee({ id: x.id, label: x.name, count: E.Scenario.parseCount(x.count), location: x.location, note: [x.role, x.note].filter(Boolean).join('; ') });
          }
          delete st.extras[x.id];
        });
      };
      convert(state);
      if (state.pending && state.pending.pre) convert(state.pending.pre);
      state.version = 8;
      return state;
    },
    // The local map (task 3-3): every room seen, everyone where they are now.
    8: (state) => {
      const fill = (st, turn) => {
        if (!st.seenRooms) st.seenRooms = Object.keys(st.locations || {});
        if (!st.known) { st.known = {}; if (st.characters) Eng.knowAll(st, turn); }
      };
      fill(state, state.turn);
      if (state.pending && state.pending.pre) fill(Object.assign(state.pending.pre, { player: state.player }), state.turn);
      state.version = 9;
      return state;
    },
    // World views (task 3-4): when each region last changed, for highlighting.
    9: (state) => {
      if (!state.regionChanged) state.regionChanged = {};
      if (state.pending && state.pending.pre && !state.pending.pre.regionChanged) state.pending.pre.regionChanged = {};
      state.version = 10;
      return state;
    },
    // Site rules (task 3-6): link and feature state from the authored rooms.
    10: (state) => {
      Eng.initSite(state);
      if (state.pending && state.pending.pre && state.pending.pre.locations) Eng.initSite(state.pending.pre);
      state.version = 11;
      return state;
    },
    // Generated sites (task 4-4): older saves have none (every room is home).
    11: (state) => {
      if (!state.sites) state.sites = {};
      if (state.pending && state.pending.pre && !state.pending.pre.sites) state.pending.pre.sites = {};
      state.version = 12;
      return state;
    },
    // The canon timeline (task 5-2): older games have no outcomes yet, and
    // don't start projecting events they never planned.
    12: (state) => {
      [state, state.pending && state.pending.pre].filter(Boolean).forEach((s) => {
        if (!s.canon) s.canon = {};
        if (!s.timeline) s.timeline = [];
        if (s.projection == null) s.projection = false;
      });
      state.version = 13;
      return state;
    },
    // Routes (R-2): neighbours become border routes in the saved scenario,
    // and a generated site's room-to-room link is a "trip", not a "route".
    13: (state) => {
      [state, state.pending && state.pending.pre].filter(Boolean).forEach((s) => {
        if (s.scenario) E.Scenario.deriveRoutes(s.scenario.regions);
        Object.values(s.locations || {}).forEach((l) => (l.links || []).forEach((k) => { if (k.kind === 'route') k.kind = 'trip'; }));
      });
      state.version = 14;
      return state;
    },
    // Presence (R-5): older games have none. Unknown regions need nothing:
    // a region with no "known" is known.
    14: (state) => {
      [state, state.pending && state.pending.pre].filter(Boolean).forEach((s) => { if (!s.presence) s.presence = {}; });
      state.version = 15;
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
  // in; "nearby" is that region and what's near it (R-1: neighbours, siblings
  // under the same parent, children), the only ones whose current state goes
  // in prompts. The tree (R-1): Eng.regionChain is a region and its
  // ancestors, nearest first; the helpers are in Scenario.
  Eng.regionDef = (state, id) => (state.scenario.regions || []).find((r) => r.id === id) || null;
  Eng.regionOf = (state, loc) => (state.locations[loc] && state.locations[loc].region) || null;
  Eng.playerRegion = (state) => Eng.regionOf(state, state.characters[state.player].status.location);
  Eng.regionChain = (state, id) => E.Scenario.regionChainIn(state.scenario.regions, id).filter((r) => state.regions && state.regions[r]);
  Eng.regionChildren = (state, id) => E.Scenario.regionChildrenIn(state.scenario.regions, id).filter((r) => state.regions && state.regions[r]);
  // A region-focused world (R-8) gives regions more of the prompt: 12 near, not 8.
  Eng.regionNear = (state, id) => E.Scenario.regionNearIn(state.scenario.regions, id, E.Sites.mapFocus(state.scenario) === 'region' ? 12 : E.Scenario.REGION_NEAR).filter((r) => state.regions && state.regions[r]);
  // Hidden regions (R-5) are never near: the player doesn't know of them.
  Eng.nearbyRegions = (state) => {
    const id = Eng.playerRegion(state);
    if (!id || !Eng.regionDef(state, id) || !state.regions || !state.regions[id]) return [];
    return [id].concat(Eng.regionNear(state, id).filter((x) => Eng.regionKnown(state, x)));
  };
  // ---------- routes and trips (R-2) ----------
  // Every way out of each region: its own routes, routes to it that aren't
  // one-way, and a free border between siblings under a real parent when
  // either has no routes at all (a creator who didn't model travel there).
  // → Map(region id → [{ from, to, kind, hours, requires, risky, skill, failHarm, implicit }])
  function routeEdges(sc) {
    const S = E.Scenario;
    const list = (sc.regions || []).filter((r) => r && r.id);
    const out = new Map(list.map((r) => [r.id, []]));
    list.forEach((r) => (r.routes || []).forEach((x) => {
      if (!x || !out.has(x.to) || x.to === r.id) return;
      const e = S.routeOf(sc, x);
      out.get(r.id).push(Object.assign({}, e, { from: r.id }));
      if (!e.oneWay) out.get(x.to).push(Object.assign({}, e, { from: x.to, to: r.id }));
    }));
    const bare = new Set(list.filter((r) => !out.get(r.id).length).map((r) => r.id));
    list.filter((p) => S.regionChildrenIn(list, p.id).length > 1).forEach((p) => {
      const kids = S.regionChildrenIn(list, p.id);
      kids.forEach((a) => kids.forEach((b) => {
        if (a === b || !(bare.has(a) || bare.has(b)) || out.get(a).some((e) => e.to === b)) return;
        out.get(a).push({ from: a, to: b, kind: 'border', hours: 0, requires: null, risky: false, skill: null, failHarm: false, oneWay: false, implicit: true });
      }));
    });
    return out;
  }
  const legOpen = (state, e) => !e.requires || E.Timeline.holds(state, e.requires);
  const legWhy = (state, e) => `the ${e.kind} to ${(Eng.regionDef(state, e.to) || {}).name || e.to} needs ${E.Timeline.say(state, e.requires)}`;
  // The routes out of a region as they are now, for the prompt: [{ to, kind,
  // hours, closed (why, or null), risky }], explicit ones only.
  Eng.routesFrom = (state, id) => (routeEdges(state.scenario).get(id) || []).filter((e) => !e.implicit && Eng.regionKnown(state, e.to))

    .map((e) => ({ to: e.to, kind: e.kind, hours: e.hours, risky: e.risky, closed: legOpen(state, e) ? null : legWhy(state, e) }));
  // The way from one region to another: { legs: [edge], hours } along the
  // quickest open path, or { blocked: true, why, legs (the path if its
  // closed legs were open, or null), risky (every closed leg is risky),
  // closed (the first closed leg) }. Inside counts as there: a region and the
  // regions it is inside cost nothing, a route on a region serves everything
  // inside it, and arriving at a region reaches what's inside it. Regions
  // both are inside don't count (Paris to Lyon is not free for being in France).
  Eng.regionTrip = function (state, from, to) {
    const S = E.Scenario;
    const list = state.scenario.regions || [];
    if (!from || !to || from === to) return { legs: [], hours: 0 };
    const up = S.regionChainIn(list, from), down = S.regionChainIn(list, to);
    if (up.includes(to) || down.includes(from)) return { legs: [], hours: 0 };
    const starts = up.filter((id) => !down.includes(id));
    const goals = new Set(down.filter((id) => !up.includes(id)));
    const edges = routeEdges(state.scenario);
    const search = (open) => {
      const best = new Map(starts.map((id) => [id, { cost: 0, legs: [] }]));
      const queue = starts.slice();
      while (queue.length) {
        queue.sort((a, b) => best.get(a).cost - best.get(b).cost);
        const id = queue.shift();
        const at = best.get(id);
        if (goals.has(id)) return at;
        (edges.get(id) || []).forEach((e) => {
          if (!open(e)) return;
          const cost = at.cost + e.hours + 1e-6; // fewer legs on a tie
          const seen = best.get(e.to);
          if (seen && seen.cost <= cost) return;
          best.set(e.to, { cost, legs: at.legs.concat(e) });
          if (!queue.includes(e.to)) queue.push(e.to);
        });
      }
      return null;
    };
    const sum = (legs) => Math.round(legs.reduce((h, e) => h + e.hours, 0) * 100) / 100;
    const found = search((e) => legOpen(state, e));
    if (found) return { legs: found.legs, hours: sum(found.legs) };
    const any = search(() => true);
    if (!any) return { blocked: true, legs: null, why: `there is no way from ${(Eng.regionDef(state, from) || {}).name || from} to ${(Eng.regionDef(state, to) || {}).name || to}`, risky: false };
    const closed = any.legs.filter((e) => !legOpen(state, e));
    return { blocked: true, legs: any.legs, hours: sum(any.legs), closed: closed[0], why: legWhy(state, closed[0]), risky: closed.every((e) => e.risky) };
  };
  // The region trip a move between two rooms makes, or null (same region,
  // or a world without regions).
  Eng.tripBetween = function (state, fromRoom, toRoom) {
    const a = Eng.regionOf(state, fromRoom), b = Eng.regionOf(state, toRoom);
    if (!a || !b || a === b || !Eng.regionDef(state, a) || !Eng.regionDef(state, b)) return null;
    return Eng.regionTrip(state, a, b);
  };
  // "by road to Ridge (45m), then by rail to Kessel (2h)"
  // Free borders go unsaid ("by border to Highway junction" told nothing).
  Eng.sayTrip = (state, trip) => (trip.legs || []).filter((e) => e.kind !== 'border' || e.hours).map(
(e) => `by ${e.kind} to ${(Eng.regionDef(state, e.to) || {}).name || e.to}${e.hours ? ` (${E.Scenario.sayHours(e.hours)})` : ''}`).join(', then ') || 'a short way';

  // ---------- unknown regions and presence (R-5) ----------
  // A region with "known": false, and everything inside it, is hidden from
  // the player (map, sidebar) and the narrator (every prompt line) until the
  // story reveals it: an effect, the player being there, or the player
  // knowing a fact (or hearing an event) that names it.
  Eng.regionKnown = (state, id) => E.Scenario.regionChainIn(state.scenario.regions, id).every((x) => !(state.regions && state.regions[x] && state.regions[x].known === false));
  Eng.hiddenRegions = (state) => new Set((state.scenario.regions || []).map((r) => r.id).filter((id) => !Eng.regionKnown(state, id)));
  // Reveals a region and the hidden regions it is inside. → names revealed.
  Eng.revealRegion = function (state, id, res, why) {
    const out = [];
    E.Scenario.regionChainIn(state.scenario.regions, id).forEach((x) => {
      const now = state.regions && state.regions[x];
      if (!now || now.known !== false) return;
      now.known = true;
      state.regionChanged = state.regionChanged || {};
      state.regionChanged[x] = { turn: state.turn, what: ['found'] };
      out.push(Eng.regionDef(state, x).name);
    });
    if (out.length && res) guard(res, 'resolve', 'region revealed', `${out.join(', ')}: ${why}`);
    return out;
  };
  const nameIn = (text, name) => new RegExp(`(^|[^\\w])${String(name).replace(/^the\s+/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(String(text || ''));
  // Hidden regions a text names (public event text, a fact the player knows).
  Eng.revealNamed = function (state, text, res, why) {
    Eng.hiddenRegions(state).forEach((id) => { if (Eng.regionKnown(state, id)) return; if (nameIn(text, Eng.regionDef(state, id).name)) Eng.revealRegion(state, id, res, why); });
  };
  // At the start of a turn, and after moves: the player is in it, or knows a
  // fact naming it.
  Eng.revealAround = function (state, res) {
    if (!Eng.hiddenRegions(state).size) return;
    const here = Eng.playerRegion(state);
    if (here && !Eng.regionKnown(state, here)) Eng.revealRegion(state, here, res, 'the player is there');
    (state.facts || []).filter((f) => E.Memory.knows(f, state.player)).forEach((f) => Eng.revealNamed(state, f.text, res, 'the player knows a fact about it'));
  };
  // Who is present in a region, strongest first, in words; contested when
  // the two strongest are both at least 0.25 and within 0.2 of each other.
  // → { groups: [{ id, name, strength, word }], contested }
  Eng.PRESENCE_WORDS = [[0.67, 'strong'], [0.34, 'some'], [0, 'a little']];
  Eng.presenceIn = function (state, id) {
    const groups = Object.entries(state.presence || {}).map(([g, m]) => ({ id: g, strength: Number((m || {})[id]) || 0 }))
      .filter((x) => x.strength > 0).sort((a, b) => b.strength - a.strength)
      .map((x) => Object.assign(x, { name: ((state.factions || []).find((f) => f.id === x.id) || { name: x.id }).name, word: Eng.PRESENCE_WORDS.find(([at]) => x.strength >= at)[1] }));
    const contested = groups.length >= 2 && groups[1].strength >= 0.25 && groups[0].strength - groups[1].strength <= 0.2;
    return { groups, contested };
  };
  // "the Ridge (strong), the convoy (some); contested" or "".
  Eng.presenceText = function (state, id) {
    const p = Eng.presenceIn(state, id);
    return p.groups.length ? `${p.groups.map((g) => `${g.name} (${g.word})`).join(', ')}${p.contested ? '; contested' : ''}` : '';
  };

  // The player's region, its ancestors and what's near: where a regional
  // event may happen and which event ideas apply (a seed on France counts in Paris).
  Eng.regionsAround = (state) => {
    const near = Eng.nearbyRegions(state);
    return near.length ? [...new Set(Eng.regionChain(state, near[0]).concat(near))] : [];
  };
  // Who holds a region, in words: its controller; for a parent with none of
  // its own, a summary of its children (never a made-up owner); else no one.
  // → { text, controller, mixed }
  Eng.regionHolder = (state, id) => {
    const now = state.regions && state.regions[id];
    const name = (fid) => { const f = fid && (state.factions || []).find((x) => x.id === fid); return f ? f.name : 'no one'; };
    if (!now) return { text: 'no one', controller: null, mixed: false };
    if (now.controller) return { text: name(now.controller), controller: now.controller, mixed: false };
    // Hidden ones (R-5) don't count: the summary would give them away.
    const kids = Eng.regionChildren(state, id).filter((k) => Eng.regionKnown(state, k));
    if (!kids.length) return { text: 'no one', controller: null, mixed: false };
    const counts = new Map();
    kids.forEach((k) => { const c = state.regions[k].controller || null; counts.set(c, (counts.get(c) || 0) + 1); });
    const held = [...counts.entries()].filter(([c]) => c);
    if (!held.length) return { text: 'no one', controller: null, mixed: false };
    return { text: `no single holder (${held.map(([c, n]) => `${name(c)} holds ${n} of ${kids.length}`).join(', ')})`, controller: null, mixed: true };
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
  Eng.guard = guard;

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
    for (let i = 2; state.standees && state.standees[id]; i++) id = `${base}-${i}`;
    state.newExtras = { turn, n: added + 1 };
    // A group is a standee (task 3-2), and groups are always in a room.
    if (raw.group === true) {
      if (!loc) return { error: `a group needs a room (${name})` };
      state.standees[id] = Eng.newStandee({ id, label: name, count: E.Scenario.parseCount(raw.count), location: loc, note: role });
      return { id, note: `+group ${Eng.standeeLabel(state, state.standees[id])} in ${state.locations[loc].name} (${id})` };
    }
    state.extras[id] = Eng.newExtra({ id, name, role, location: loc || null }, 'model', turn);
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

  // ---------- standees (task 3-2) ----------
  // Unnamed groups on the local map (guards, a gang, the dead): a label, a
  // count, a room and a state. One intent per group, never per person. A
  // group that is wiped out or flees leaves the map and is folded back into
  // its faction; groups exist only in rooms.
  Eng.newStandee = (g) => ({
    id: g.id, label: g.label, count: g.count, location: g.location, state: g.state || 'calm', faction: g.faction || null,
    post: g.post || null, patrol: g.patrol ? g.patrol.slice() : null, patrolHours: 0, note: g.note || '',
  });
  // Groups that can act: here, and not down.
  const ACTIVE = ['calm', 'alert', 'hostile'];
  Eng.standeesAt = (state, loc) => Object.values(state.standees || {}).filter((g) => g.location === loc && g.count > 0);
  Eng.standeeActive = (g) => !!g && g.count > 0 && ACTIVE.includes(g.state);
  // "3 Chrome Saints (alert)", "the dead (12, hostile)"
  Eng.standeeLabel = (state, g) => {
    const f = g.faction && (state.factions || []).find((x) => x.id === g.faction);
    return `${g.label} (${g.count}, ${g.state}${f ? `, ${f.name}` : ''}${g.post ? ', on guard' : g.patrol ? ', on patrol' : ''})`;
  };
  // Every token on a room, for the map view (3-3) and the prompts: the
  // player and living characters, then extras, then standees.
  Eng.tokens = function (state, loc) {
    const chars = [state.player].concat(Eng.cast(state, { alive: true, includePlayer: false }))
      .filter((id) => Eng.alive(state, id) && state.characters[id].status.location === loc)
      .map((id) => ({ kind: 'character', id, label: state.characters[id].name, player: id === state.player }));
    const extras = Eng.extrasAt(state, loc).map((x) => ({ kind: 'extra', id: x.id, label: x.name }));
    const groups = Eng.standeesAt(state, loc).map((g) => ({ kind: 'standee', id: g.id, label: g.label, count: g.count, state: g.state, faction: g.faction }));
    return chars.concat(extras, groups);
  };
  const linked = (state, a, b) => {
    const la = state.locations[a], lb = state.locations[b];
    return !!((la && (la.connects || []).includes(b)) || (lb && (lb.connects || []).includes(a)));
  };
  Eng.linkedRooms = (state, loc) => Object.keys(state.locations).filter((l) => l !== loc && linked(state, loc, l));
  // Leaves the map: wiped out or fled. Returns a Debug line.
  function removeStandee(state, g, why) {
    delete state.standees[g.id];
    const f = g.faction && (state.factions || []).find((x) => x.id === g.faction);
    return `${g.label} ${why}${f ? `; folded back into ${f.name}` : ''}`;
  }
  // A group moves one linked step, unless it holds a post (only hostile
  // groups leave a post). Returns null or why not.
  function standeeMoveProblem(state, g, dest) {
    if (!dest) return 'unknown location';
    if (dest === g.location) return 'already there';
    if (!linked(state, g.location, dest)) return `${dest} is not linked to ${g.location}`;
    if ((Eng.linkInfo(state, g.location, dest) || {}).kind === 'trip') return 'groups stay in their own place';
    if (!Eng.passable(state, g.location, dest, g.id)) return `the way to ${dest} is locked`;
    if (g.post && g.state !== 'hostile') return `holds its post in ${g.post}`;
    return null;
  }
  // Harder rolls against groups: state plus size. Stealth also counts who
  // could notice: alert or hostile groups in the player's room, a linked
  // room or the destination; an empty route makes it easier.
  const STATE_DC = { calm: 0, alert: 2, hostile: 4 };
  const sizeDC = (n) => (n >= 20 ? 4 : n >= 8 ? 3 : n >= 4 ? 2 : n >= 2 ? 1 : 0);
  Eng.STEALTH_SKILLS = ['stealth'];
  Eng.standeeDC = function (state, it) {
    const here = state.characters[state.player].status.location;
    let mod = 0;
    const why = [];
    const target = it.against && state.standees[it.against];
    if (target) {
      const m = (STATE_DC[target.state] || 0) + sizeDC(target.count);
      if (m) { mod += m; why.push(`${target.count} ${target.state} ${target.label} +${m}`); }
    }
    // Every room on the way (task 3-6) and the rooms next to them; cameras
    // that are on and watched entrances on the way count too.
    const route = it.moveTo ? Eng.route(state, here, it.moveTo, { who: state.player }) : [here];
    const onRoute = route.length ? route : [here];
    const eyes = Eng.STEALTH_SKILLS.includes(it.skill) ? onRoute.flatMap((r) => Eng.features(state, r).filter((f) => /camera/i.test(f.name) && f.state === 'on').map((f) => `${f.name} in ${state.locations[r].name}`))
      .concat(E.Sites.entrances(state).filter((e) => e.watched && onRoute.includes(e.room)).map((e) => `watched ${e.kind || 'entrance'} in ${state.locations[e.room].name}`)) : [];
    // Worlds with watchers of any kind (groups, cameras, watched entrances).
    const watchful = Object.keys(state.standees || {}).length || E.Sites.entrances(state).some((e) => e.watched) ||
      Object.keys(state.locations).some((r) => Eng.features(state, r).some((f) => /camera/i.test(f.name)));
    if (Eng.STEALTH_SKILLS.includes(it.skill) && watchful) {
      const rooms = new Set(onRoute.flatMap((r) => [r].concat(Eng.linkedRooms(state, r))));
      const watchers = Object.values(state.standees || {}).filter((g) => rooms.has(g.location) && Eng.standeeActive(g));
      const sharp = watchers.filter((g) => g.state !== 'calm' && g !== target);
      const seenBy = sharp.map((g) => g.label).concat(eyes);
      if (seenBy.length) { const m = Math.min(4, 2 * seenBy.length); mod += m; why.push(`watched by ${seenBy.join(', ')} +${m}`); }
      else if (!watchers.length) { mod -= 2; why.push('nobody on the route −2'); }
    }
    return { mod, why };
  };
  // A failed stealth roll: the nearest group that could notice gets warier
  // (calm → alert → hostile); one that turns hostile next door and holds no
  // post steps toward the player. Returns lines for the narrator (exactly what changed).
  Eng.standeesNotice = function (state, it) {
    const here = state.characters[state.player].status.location;
    const near = new Set(Eng.linkedRooms(state, here).concat(it.moveTo ? [it.moveTo] : []));
    const order = (g) => (g.location === here ? 0 : g.location === it.moveTo ? 1 : 2);
    const g = Object.values(state.standees || {}).filter((x) => Eng.standeeActive(x) && x.state !== 'hostile' && (x.location === here || near.has(x.location)))
      .sort((a, b) => order(a) - order(b))[0];
    if (!g) return [];
    const was = g.state;
    g.state = was === 'calm' ? 'alert' : 'hostile';
    const lines = [`${g.label} ${g.state === 'alert' ? 'notice something and are now alert' : 'spot the player and turn hostile'} (were ${was})`];
    if (g.state === 'hostile' && g.location !== here && !g.post && linked(state, g.location, here)) {
      g.location = here;
      lines.push(`${g.label} come into ${state.locations[here].name}`);
    }
    return lines;
  };
  // Groups the player can deal with this turn: the ones in their room, and
  // ones in a linked room that the player's own words name ("sneak past the
  // stragglers" from the dock; playtest-stragglers-sneak). They get an
  // intent, can be a roll's target, and the update step may change them.
  const labelHit = (g, text) => {
    const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).map((w) => w.replace(/s$/, ''));
    return labelWords(g.label).some((w) => words.includes(w));
  };
  Eng.engagedStandees = function (state, actionText) {
    const here = state.characters[state.player].status.location;
    const next = new Set(Eng.linkedRooms(state, here));
    return Object.values(state.standees || {}).filter((g) => g.count > 0 && (g.location === here || (next.has(g.location) && labelHit(g, actionText))));
  };
  // Sneaking near a group always rolls, even when the model says it doesn't
  // need to (playtest-stragglers-sneak: "I sneak around the side of the truck"
  // with the dead next door, no roll).
  const SNEAKING = /\b(?:sneak|sneaks|sneaking|creep|creeps|creeping|tiptoe|tiptoes|quietly|silently|stay(?:ing)? (?:low|hidden|out of sight)|keep(?:ing)? low|slip(?:s|ping)? (?:past|by|around|behind)|without being (?:seen|noticed|heard))\b/i;
  Eng.sneakNeedsRoll = function (state, actionText) {
    if (!SNEAKING.test(String(actionText || ''))) return false;
    const here = state.characters[state.player].status.location;
    const rooms = new Set([here].concat(Eng.linkedRooms(state, here)));
    return Object.values(state.standees || {}).some((g) => rooms.has(g.location) && Eng.standeeActive(g));
  };

  // Patrols advance one room per in-game hour while calm or alert.
  function advancePatrols(state, hours) {
    Object.values(state.standees || {}).forEach((g) => {
      if (!g.patrol || !['calm', 'alert'].includes(g.state)) return;
      g.patrolHours = (g.patrolHours || 0) + hours;
      const steps = Math.floor(g.patrolHours);
      if (!steps) return;
      g.patrolHours -= steps;
      // The place in the loop, so an out-and-back patrol (a, b, c, b) comes
      // back to a instead of bouncing between b and c.
      const i = g.patrolAt != null && g.patrol[g.patrolAt] === g.location ? g.patrolAt : Math.max(0, g.patrol.indexOf(g.location));
      g.patrolAt = (i + steps) % g.patrol.length;
      g.location = g.patrol[g.patrolAt];
    });
  }
  // The player singles one member out ("I grab the nearest straggler"): only
  // when the player's own words refer to the group. The count drops by one
  // and an individual extra stands in the same room. Returns { note } or { error }.
  const labelWords = (label) => String(label).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['the', 'and'].includes(w)).map((w) => w.replace(/s$/, ''));
  Eng.singleOut = function (state, raw, actionText, turn) {
    const g = raw && state.standees[raw.standee];
    if (!g) return { error: `unknown group "${raw && raw.standee}"` };
    if (g.location !== state.characters[state.player].status.location) return { error: `${g.label} is not here` };
    if (!Eng.standeeActive(g) && g.state !== 'down') return { error: `${g.label} can't be singled out` };
    if (!labelHit(g, actionText)) return { error: `the player's action doesn't name ${g.label}` };
    if (Object.keys(state.extras).length >= Eng.EXTRAS_MAX) return { error: `already ${Eng.EXTRAS_MAX} minor people` };
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 40) : `one of the ${g.label}`.slice(0, 40);
    const role = typeof raw.role === 'string' && raw.role.trim() ? raw.role.replace(/\s+/g, ' ').trim().slice(0, 60) : `one of the ${g.label}`.slice(0, 60);
    const base = slug(name === `one of the ${g.label}`.slice(0, 40) ? `${g.id}-one` : name) || 'extra';
    let id = base;
    for (let i = 2; state.characters[id] || state.extras[id] || state.locations[id] || state.standees[id]; i++) id = `${base}-${i}`;
    state.extras[id] = Eng.newExtra({ id, name, role, location: g.location, note: `singled out from ${g.label}${g.note ? '; ' + g.note : ''}` }, 'standee', turn);
    g.count -= 1;
    const gone = g.count <= 0 ? '; ' + removeStandee(state, g, 'is down to no one') : '';
    return { id, note: `${name} singled out from ${g.label} (${id}); ${g.label} now ${Math.max(0, g.count)}${gone}` };
  };

  // ---------- site rules (task 3-6) ----------
  // The engine plays by the map: state.links["a|b"] = { locked, open } for
  // every link that isn't an open way (a locked door starts locked; doors,
  // hatches, windows and vents start shut), and state.features["room|name"]
  // = state for features with a state (a camera "on"). Shut links block
  // sight; locked ones block movement, except for whoever holds the key.
  Eng.linkKey = (a, b) => [a, b].sort().join('|');
  const featName = (f) => (typeof f === 'string' ? f : f && f.name) || '';
  Eng.featName = featName;
  Eng.initSite = function (st) {
    st.links = st.links || {};
    E.Layouts.links(Object.values(st.locations || {})).forEach((k) => {
      if (k.kind === 'open' || st.links[Eng.linkKey(k.a, k.b)]) return;
      st.links[Eng.linkKey(k.a, k.b)] = { locked: k.kind === 'locked door', open: false };
    });
    st.features = st.features || {};
    Object.values(st.locations || {}).forEach((l) => (l.features || []).forEach((f) => {
      if (f && typeof f === 'object' && f.state != null && st.features[`${l.id}|${f.name}`] == null) st.features[`${l.id}|${f.name}`] = String(f.state);
    }));
  };
  // A link between two rooms as it is now: { kind, locked, open, key } or null.
  Eng.linkInfo = function (state, a, b) {
    const la = state.locations[a], lb = state.locations[b];
    if (!la || !lb || !((la.connects || []).includes(b) || (lb.connects || []).includes(a))) return null;
    const auth = (la.links || []).find((k) => k.to === b) || (lb.links || []).find((k) => k.to === a) || { kind: 'open' };
    const live = (state.links || {})[Eng.linkKey(a, b)];
    if (auth.kind === 'open' || !live) return { kind: auth.kind, locked: false, open: true, key: [] };
    return { kind: auth.kind, locked: !!live.locked, open: !!live.open, key: auth.key || [] };
  };
  // How the map should draw a link now: an unlocked "locked door" is a door,
  // an open door is a gap.
  Eng.linkShown = function (state, a, b) {
    const k = Eng.linkInfo(state, a, b);
    if (!k) return null;
    if (k.kind === 'open' || k.open) return 'open';
    return k.kind === 'locked door' && !k.locked ? 'door' : k.kind;
  };
  Eng.passable = function (state, a, b, who) {
    const k = Eng.linkInfo(state, a, b);
    return !!k && (!k.locked || (who != null && k.key.includes(who)));
  };
  // The first locked link on the way from one room to another (ignoring
  // locks), for "the way is blocked" messages: { a, b } or null.
  Eng.blockedBy = function (state, from, to, who) {
    const path = Eng.route(state, from, to);
    for (let i = 0; i + 1 < path.length; i++) if (!Eng.passable(state, path[i], path[i + 1], who)) return { a: path[i], b: path[i + 1] };
    return null;
  };
  const blockText = (state, b) => {
    const k = Eng.linkInfo(state, b.a, b.b);
    return `the ${k ? (k.kind === 'locked door' ? 'door' : k.kind) : 'way'} between ${state.locations[b.a].name} and ${state.locations[b.b].name} is locked`;
  };
  // Can someone get from one room to another (through unlocked ways, or ones
  // they hold the key to)? Returns null, or why not.
  Eng.moveProblem = function (state, who, from, to) {
    if (!from || !to || from === to) return null;
    if (Eng.route(state, from, to, { who }).length) return null;
    const b = Eng.blockedBy(state, from, to, who);
    return b ? blockText(state, b) : `there is no way from ${state.locations[from] ? state.locations[from].name : from} to ${state.locations[to] ? state.locations[to].name : to}`;
  };
  // Locking and unlocking (intent step): the person must be on one side.
  function setLock(state, who, here, to, lock) {
    const k = Eng.linkInfo(state, here, to);
    if (!k) return `${state.locations[to] ? state.locations[to].name : to} is not next to ${state.locations[here].name}`;
    if (k.kind !== 'locked door') return `the way to ${state.locations[to].name} has no lock`;
    if (k.locked === lock) return `it is already ${lock ? 'locked' : 'unlocked'}`;
    state.links[Eng.linkKey(here, to)].locked = lock;
    if (lock) state.links[Eng.linkKey(here, to)].open = false;
    return null;
  }
  // Features as they are now: [{ name, state, inferred }].
  Eng.features = (state, room) => ((state.locations[room] || {}).features || []).map((f) => ({
    name: featName(f), state: (state.features || {})[`${room}|${featName(f)}`] ?? null, inferred: !!(f && f.inferred),
  }));
  // Inferred features (intent step: "new_feature"): something the map is
  // silent about that the player's own action uses. Accepted only if nothing
  // contradicts it: the player's room, not over an authored feature, a way
  // out only through an outside wall (from the layout, placed from authored
  // rooms) to a neighbouring or outside room, never into or out of a secure
  // room. Returns { note } or { error }.
  Eng.FEATURES_MAX = 8;
  const planCache = new WeakMap();
  Eng.sitePlan = function (state, room) {
    const sc = state.scenario;
    // A generated site (task 4-4) is planned from its own rooms.
    const site = room ? E.Sites.siteOf(state, room) : E.Sites.HOME;
    if (site !== E.Sites.HOME) return E.Layouts.plan(E.Sites.rooms(state, site).map((l) => Object.assign({}, l, { links: (l.links || []).filter((k) => k.kind !== 'trip') })), { seed: `${sc.worldId}:${site}` });
    if (!planCache.has(sc)) planCache.set(sc, E.Layouts.plan(sc.locations || [], { type: sc.site && sc.site.type, seed: `${sc.worldId}:${sc.startId}` }));
    return planCache.get(sc);
  };
  // A way out ("to") may be in a room on the player's way this turn (the
  // stockroom's back window, from the office; playtest-office-window): the
  // player walks there first. Anything else only in the player's room.
  Eng.inferFeature = function (state, raw, actionText) {
    const at = state.characters[state.player].status.location;
    if (!raw || typeof raw !== 'object') return { error: 'not an object' };
    const asked = raw.room != null && raw.room !== '' ? Eng.resolveLocation(state, raw.room, false) : at;
    const reachable = asked && raw.to != null && raw.to !== '' && Eng.route(state, at, asked, { who: state.player }).length;
    if (asked !== at && !reachable) return { error: `only in the player's room (${state.locations[at].name})` };
    const here = asked;
    const room = state.locations[here];
    const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 30) : '';
    if (!name) return { error: 'no name' };
    const words = String(actionText || '').toLowerCase().split(/[^a-z0-9]+/);
    if (!name.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && words.includes(w))) return { error: `the player's action doesn't use "${name}"` };
    if (Eng.features(state, here).some((f) => f.name.toLowerCase() === name)) return { error: `${room.name} already has "${name}"` };
    if ((room.features || []).length >= Eng.FEATURES_MAX) return { error: `${room.name} already has ${Eng.FEATURES_MAX} features` };
    let to = null;
    if (raw.to != null && raw.to !== '') {
      to = Eng.resolveLocation(state, raw.to, false);
      if (!to || to === here) return { error: `"${name}" leads nowhere known` };
      const target = state.locations[to];
      if (room.secure || target.secure) return { error: `a secure room never gets another way in (${room.secure ? room.name : target.name})` };
      if (Eng.linkInfo(state, here, to)) return { error: `there is already a way to ${target.name}` };
      const plan = Eng.sitePlan(state, here);
      if (!E.Layouts.hasOutsideWall(plan, here)) return { error: `${room.name} has no outside wall for "${name}"` };
      const shared = plan.rooms[here] && plan.rooms[to] && E.Layouts.sharesWall(plan.rooms[here], plan.rooms[to]);
      if (!target.outside && !shared) return { error: `${target.name} is not on the other side of a wall of ${room.name}` };
    }
    room.features = (room.features || []).concat([{ name, inferred: true }]);
    if (to) {
      const kind = /vent|duct/.test(name) ? 'vent' : /hatch/.test(name) ? 'hatch' : /door/.test(name) ? 'door' : 'window';
      room.links = (room.links || []).concat([{ to, kind, inferred: true }]);
      room.connects = (room.connects || []).concat([to]);
      state.links[Eng.linkKey(here, to)] = { locked: false, open: false };
    }
    return { to, room: here, note: `${room.name}: + ${name}${to ? ` (a way to ${state.locations[to].name})` : ''}` };
  };
  // The engine's own reading when the model leaves "new_feature" out but the
  // player's words name a way out and the model moved them: the way, in the
  // room the words name (else the player's room), to where they went.
  const WAY_OUT = /\b((?:back|side|front|rear|broken|small|open|bathroom|office|kitchen)\s+)?(window|air vent|vent|duct|skylight|hatch|fire escape|crawlspace)\b/i;
  Eng.wayFromWords = function (state, actionText, moveTo) {
    const m = WAY_OUT.exec(String(actionText || ''));
    if (!m || !moveTo) return null;
    const words = String(actionText).toLowerCase().replace(/'s\b/g, '');
    const named = Object.values(state.locations).find((l) => l.id !== moveTo && (new RegExp(`\\b${l.id}\\b`).test(words) || words.includes(l.name.toLowerCase())));
    return { name: (m[1] || '') + m[2], room: named ? named.id : null, to: moveTo };
  };

  // ---------- what the player knows of the map (task 3-3) ----------
  // state.seenRooms: rooms the player has been in or seen into (unseen rooms
  // are drawn dark). state.known[id] = { loc, turn }: where the player last
  // saw each character, extra and group. Covert moves and hidden events never
  // update it, so the map and the cards never show what the player didn't see.
  Eng.knowAll = function (state, turn) {
    Object.values(state.characters || {}).forEach((c) => { if (c.id !== state.player) state.known[c.id] = { loc: c.status.location, turn }; });
    Object.values(state.extras || {}).forEach((x) => { if (x.location) state.known[x.id] = { loc: x.location, turn }; });
    Object.values(state.standees || {}).forEach((g) => { state.known[g.id] = { loc: g.location, turn }; });
  };
  // Rooms the player can see into from where they stand: through open links.
  Eng.visibleRooms = function (state) {
    const here = state.characters[state.player].status.location;
    const l = state.locations[here];
    return [here].concat(l ? Eng.linkedRooms(state, here).filter((o) => Eng.linkShown(state, here, o) === 'open') : []);
  };
  // Records what the player can see now: the rooms in view, everyone in the
  // player's room, groups in view, and (when res is given) visible moves and
  // seen or heard events. Called after a turn is played and again at commit.
  Eng.noteSeen = function (state, res, turn) {
    state.seenRooms = state.seenRooms || [];
    state.known = state.known || {};
    const here = state.characters[state.player].status.location;
    const view = Eng.visibleRooms(state);
    view.forEach((r) => { if (!state.seenRooms.includes(r)) state.seenRooms.push(r); });
    const mark = (id, loc) => { if (id && id !== state.player && loc) state.known[id] = { loc, turn }; };
    if (res) {
      (res.outcomes || []).forEach((o) => { if (o.visible && o.moved && o.id !== state.player) mark(o.id, o.moved); });
      (res.groups || []).forEach((g) => { if (g.visible && g.moved) mark(g.id, g.moved); });
      (res.director || []).forEach((d) => { if (d.visibility !== 'hidden' && d.where) (d.who || []).forEach((id) => mark(id, whereIs(state, id) || d.where)); });
    }
    Eng.present(state).forEach((id) => mark(id, here));
    Eng.extrasAt(state, here).forEach((x) => mark(x.id, here));
    Object.values(state.standees || {}).forEach((g) => { if (view.includes(g.location)) mark(g.id, g.location); });
    // Gone for good: no longer on the map.
    Object.keys(state.known).forEach((id) => { if (!state.characters[id] && !(state.extras || {})[id] && !(state.standees || {})[id]) delete state.known[id]; });
  };
  // Where the player believes someone is: { loc, turn, now } (now: in view
  // this turn), or null when they've never seen them.
  Eng.knownWhere = function (state, id) {
    if (id === state.player) return { loc: state.characters[id].status.location, turn: state.turn, now: true };
    const k = state.known && state.known[id];
    if (!k) return null;
    const actual = whereIs(state, id);
    const view = Eng.visibleRooms(state);
    return { loc: k.loc, turn: k.turn, now: k.loc === actual && view.includes(actual) && (k.loc === state.characters[state.player].status.location || !!(state.standees || {})[id]) };
  };

  // The moves the player sees in the pending turn's scene, each with the beat
  // it happens in, so the map can follow the scene as it is read instead of
  // jumping to the end: [{ id, from, to, beat }] (beat: 0-based). The
  // player's own move is the first beat; anyone else's is the first beat
  // that names them with a coming-or-going word or the room they go to, else
  // the end of the scene (being named isn't leaving).
  // Real coming and going ("heads off", "leaves", "out the door"), not any
  // movement ("steps closer", "shakes his head").
  const GOING = new RegExp('\\b(?:leaves|left|leaving|exits?|exited|departs?|departed|arrives?|arrived|enters?|entered|follows?|followed|disappears?|disappeared|retreats?|retreated|out the door|upstairs|downstairs'
    + '|excuses (?:him|her|them)sel(?:f|ves)'
    + '|(?:walks?|walked|steps?|stepped|slips?|slipped|ducks?|ducked|hurries|hurried|storms?|stormed|wanders?|wandered|runs?|ran|goes|went|heads|headed|heading|comes?|came|makes? (?:his|her|their) way)'
    + ' (?:out|off|away|outside|inside|in|back|upstairs|downstairs|over to|to|into|through|toward|towards|for))\\b', 'i');
  Eng.sceneMoves = function (state) {
    const p = state.pending;
    if (!p || !p.pre || !p.res) return [];
    const beats = p.beats || [];
    const last = Math.max(0, beats.length - 1);
    const out = [];
    const add = (id, to) => {
      const from = whereIs(p.pre, id);
      if (!to || !from || from === to) return;
      const names = Eng.moverNames(state, id);
      const room = state.locations[to] && state.locations[to].name;
      const named = (t) => names.some((n) => E.Lore.matches(n, t));
      const beat = beats.findIndex((b) => named(b.text) && (GOING.test(b.text) || (room && E.Lore.matches(room, b.text))));
      out.push({ id, from, to, beat: beat < 0 ? last : beat });
    };
    (p.res.outcomes || []).forEach((o) => { if (o.visible && o.moved && o.id !== state.player) add(o.id, o.moved); });
    (p.res.groups || []).forEach((g) => { if (g.visible && g.moved) add(g.id, g.moved); });
    return out;
  };
  // The words a scene uses for someone: their full name, a first name or
  // surname of 3+ letters, or a group's label ("the dead", "stragglers").
  Eng.moverNames = function (state, id) {
    const c = state.characters[id] || (state.extras || {})[id];
    if (c && c.name) {
      const parts = String(c.name).replace(/["“][^"”]*["”]/g, ' ').replace(/^(dr|mr|mrs|ms|mx|prof|capt|sgt)\.?\s+/i, '').split(/\s+/).filter((w) => w.length >= 3);
      return [c.name].concat(parts);
    }
    const g = (state.standees || {})[id];
    return g ? [g.label, String(g.label).replace(/^(the|a|an)\s+/i, '')].filter(Boolean) : [];
  };

  // Where someone is, character, extra or group.
  const whereIs =(state, id) => (state.characters[id] ? state.characters[id].status.location : state.extras && state.extras[id] ? state.extras[id].location : state.standees && state.standees[id] ? state.standees[id].location : null);
  const isExtra = (state, id) => !!(state.extras && state.extras[id]);
  const isStandee = (state, id) => !!(state.standees && state.standees[id]);

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
      const raw = (ev && typeof ev.text === 'string' && ev.text.trim() && !/^one sentence$/i.test(ev.text.trim()) ? ev.text.trim() : stepSentence(c, st));
      const text = E.clip(raw, 220);
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

  Eng.roll = function (c, skill, difficulty, sc, mod) {
    const d = 1 + Math.floor(E.rng() * 20);
    const dc = (DC[difficulty] || DC.normal) + (Number(mod) || 0);
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

  // Words that say someone goes with the player ("comes along", "rides with
  // you", "follows Rook"), unless negated ("refuses to come along").
  Eng.comesAlong = function (state, text) {
    const pc = state.characters[state.player];
    const who = ['you', 'them', 'him', 'her', 'the crew', 'the group'].concat(nameTokens(pc)).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`\\b(?:come|comes|coming|tags?|tagging)\\s+along\\b|\\b(?:ride|rides|riding|go|goes|going|head|heads|come|comes)\\s+(?:along\\s+)?with\\s+(?:${who})\\b|\\bfollows?\\s+(?:${who})\\b|\\bjoins?\\s+(?:${who})\\b`, 'i');
    const m = re.exec(String(text || ''));
    if (!m) return false;
    return !/\b(?:refus\w*|won't|will not|doesn't|does not|not|never|instead of)\b[^.!?]{0,25}$/i.test(String(text).slice(0, m.index));
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
      against: id === state.player && raw && typeof raw.against === 'string' ? raw.against : null,
      singleOut: id === state.player && raw && raw.single_out && typeof raw.single_out === 'object' ? raw.single_out : null,
      unlock: raw && raw.unlock ? Eng.resolveLocation(state, raw.unlock, false) || String(raw.unlock) : null,
      lock: raw && raw.lock ? Eng.resolveLocation(state, raw.lock, false) || String(raw.lock) : null,
      newFeature: id === state.player && raw && raw.new_feature && typeof raw.new_feature === 'object' ? raw.new_feature : null,
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


  const EVENT_CAP = { minute: 1, moment: 1, hour: 1, hours: 2, morning: 3 };

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
          fireText: E.clip(nc.fireText || `${nc.name} comes to a head.`, 220), fired: false, from: scope,
        });
        return `new pressure: ${nc.name}`;
      },
    },
    // Generated sites (task 4-4): a place the story now knows of, built on
    // the player's first visit.
    new_site: {
      apply(state, s) {
        if (!E.Sites.enabled(state.scenario)) return reject('this world doesn\'t build new places');
        const name = String(s.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!name) return reject('new place has no name');
        if (E.Sites.byName(state, name) || Eng.resolveLocation(state, name, false)) return reject(`"${name}" is already a place`);
        if (Object.keys(state.sites || {}).length >= E.Sites.config(state.scenario).maxSites) return reject(`too many places already for "${name}"`);
        const regions = state.scenario.regions || [];
        if (regions.length && !regions.some((r) => r.id === s.region)) return reject(`unknown region "${s.region}" for "${name}"`);
        const st = E.Sites.addStub(state, { name, kind: String(s.kind || name).slice(0, 40), region: regions.length ? s.region : null, from: 'event', why: String(s.why || '').slice(0, 200) });
        return `new place: ${st.name}${st.region ? ` (${st.region})` : ''}`;
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
        r.stamp('changed hands');
        return `${r.def.name}: now held by ${f ? f.name : 'no one'}`;
      },
    },
    add_tag: {
      list: true, max: 2,
      apply(state, t, scope, opts) {
        const r = region(state, t);
        if (r.reject) return r;
        const tag = String(t.tag || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!tag) return reject(`no tag for ${t.region}`);
        // Too long is refused, not cut mid-word (playtest-coffee-skips: "commons losing pressure at the").
        if (tag.length > 30) return reject(`tag too long for ${t.region} (30 characters at most): "${tag}"`);
        if (r.now.tags.some((x) => x.toLowerCase() === tag)) return null;
        // A full region drops its oldest event tag, so the newest situation shows and
        // a crisis from weeks ago doesn't (playtest-coffee-skips: "co2 above emergency
        // threshold" for 80 sols). Authored tags stay.
        let dropped = null;
        if (r.now.tags.length >= E.Scenario.REGION_TAGS) {
          const authored = new Set((r.def.tags || []).map((x) => x.toLowerCase()));
          const i = r.now.tags.findIndex((x) => !authored.has(x.toLowerCase()));
          if (i < 0) return reject(`${t.region} already has ${E.Scenario.REGION_TAGS} tags; not adding "${tag}"`);
          [dropped] = r.now.tags.splice(i, 1);
          if (state.regionTagUntil) delete state.regionTagUntil[`${t.region}|${dropped.toLowerCase()}`];
        }
        r.now.tags.push(tag);
        // A tag an event adds fades after a few days, unless something renews it
        // (playtest-coffee-skips: "co2 above emergency threshold" for weeks).
        if (!(opts && opts.lasting)) {
          state.regionTagUntil = state.regionTagUntil || {};
          state.regionTagUntil[`${t.region}|${tag}`] = absHours(state) + Eng.REGION_TAG_HOURS;
        }
        r.stamp('new tag');
        return `${r.def.name}: ${tag}${dropped ? ` (no longer ${dropped})` : ''}`;
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
        if (state.regionTagUntil) delete state.regionTagUntil[`${t.region}|${gone.toLowerCase()}`];
        r.stamp('tag gone');
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
        r.stamp('new status');
        return `${r.def.name}: ${r.now.status}`;
      },
    },
    // Presence (R-5): how strongly a group is in a region, 0–1. The engine
    // rations the swing: at most 0.5 a change.
    presence: {
      list: true, max: 2,
      apply(state, p) {
        const r = region(state, p);
        if (r.reject) return r;
        const f = p.group && (state.factions || []).find((x) => x.id === p.group);
        if (!f) return reject(`unknown group "${p.group}" for presence in ${p.region}`);
        const to = Number(p.to);
        if (!Number.isFinite(to)) return reject(`no "to" (0 to 1) for ${f.id} in ${p.region}`);
        state.presence = state.presence || {};
        const was = Number((state.presence[f.id] || {})[p.region]) || 0;
        const now = Math.round(E.clamp(E.clamp(to, 0, 1), was - Eng.PRESENCE_STEP, was + Eng.PRESENCE_STEP) * 100) / 100;
        if (now === was) return null;
        state.presence[f.id] = Object.assign({}, state.presence[f.id], { [p.region]: now });
        if (!now) delete state.presence[f.id][p.region];
        r.stamp('presence changed');
        const word = now ? Eng.PRESENCE_WORDS.find(([at]) => now >= at)[1] : 'gone';
        return `${r.def.name}: ${f.name} ${word}${Eng.presenceIn(state, p.region).contested ? ' (contested)' : ''}`;
      },
    },
    // Unknown regions (R-5): the story reveals one (and what it is inside).
    reveal: {
      list: true, max: 1,
      apply(state, v) {
        const r = region(state, v);
        if (r.reject) return r;
        if (Eng.regionKnown(state, v.region)) return null;
        const names = Eng.revealRegion(state, v.region, null, '');
        return `found: ${names.join(', ')}`;
      },
    },
  };
  Eng.PRESENCE_STEP = 0.5;
  // The region an effect item names: { def, now } or a rejection. stamp()
  // records what changed this turn, for the world view (task 3-4).
  function region(state, item) {
    const id = item && item.region;
    const now = id != null && state.regions && own(state.regions, id) ? state.regions[id] : null;
    const def = now && Eng.regionDef(state, id);
    if (!def) return reject(`unknown region "${id}"`);
    const stamp = (what) => {
      state.regionChanged = state.regionChanged || {};
      const c = state.regionChanged[id];
      state.regionChanged[id] = { turn: state.turn, what: c && c.turn === state.turn && !c.what.includes(what) ? c.what.concat(what) : c && c.turn === state.turn ? c.what : [what] };
    };
    return { def, now, stamp };
  }
  Eng.EFFECTS = EFFECTS;

  // Applies an event's effects. Returns the display lines; rejections become
  // 'effect rejected' guards on res.
  // opts.lasting: tags it adds don't fade (the timeline's authored events).
  function applyEffects(state, eff, scope, res, opts) {
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
        const out = h.apply(state, it, scope, opts || {});
        if (out && out.reject) no(key, out.reject);
        else if (out) done.push(out);
      });
    });
    Object.keys(eff).filter((k) => !own(EFFECTS, k)).forEach((k) => no(k, 'unknown effect'));
    return done;
  }

  Eng.applyEffects = applyEffects;
  Eng.applyEvents = (...a) => applyEvents(...a);
  // noAgendas: the downtime skip leaves due agenda steps for the next turn.
  function applyEvents(state, intentObj, present, stepId, res, due, capsOverride, noAgendas) {
    due = due || {};
    const here = state.characters[state.player].status.location;
    res.director = res.director || [];
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
      const text = E.clip(ev.text, 220);
      const who = (Array.isArray(ev.who) ? ev.who : []).filter((id) => (state.characters[id] || isExtra(state, id) || isStandee(state, id)) && id !== state.player);
      // Offstage people in an event may know facts about it (see applyUpdate).
      res.involved = [...new Set((res.involved || []).concat(who))];
      const where = Eng.resolveLocation(state, ev.where, false) || (scope === 'local' && who[0] ? whereIs(state, who[0]) : null);
      let vis = ['seen', 'heard', 'hidden'].includes(ev.visibility) ? ev.visibility : 'heard';
      if (vis === 'seen' && where !== here) vis = 'heard';
      const moved = [];
      (Array.isArray(ev.moves) ? ev.moves : []).forEach((m) => {
        if (m && isStandee(state, m.id)) {
          const g = state.standees[m.id];
          const dest = Eng.resolveLocation(state, m.to, false);
          const why = standeeMoveProblem(state, g, dest);
          if (why) return guard(res, 'resolve', 'standee move', `${g.label} → ${m.to}: ${why}`);
          g.location = dest;
          moved.push(`${g.label} → ${state.locations[dest].name}`);
          return;
        }
        if (m && isExtra(state, m.id)) {
          const to = Eng.resolveLocation(state, m.to, false);
          if (!to) return;
          const why = Eng.moveProblem(state, m.id, state.extras[m.id].location, to);
          if (why && state.extras[m.id].location) return guard(res, 'resolve', 'move blocked', `${state.extras[m.id].name} → ${to}: ${why}`);
          state.extras[m.id].location = to;
          moved.push(`${state.extras[m.id].name} → ${state.locations[to].name}`);
          return;
        }
        if (!m || !state.characters[m.id] || m.id === state.player || present.includes(m.id)) return;
        const to = Eng.resolveLocation(state, m.to, false);
        if (!to || !Eng.alive(state, m.id)) return;
        const why = Eng.moveProblem(state, m.id, state.characters[m.id].status.location, to);
        if (why) return guard(res, 'resolve', 'move blocked', `${state.characters[m.id].name} → ${to}: ${why}`);
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
        // A public event somewhere hidden, or naming it, makes it known (R-5).
        if (region && !Eng.regionKnown(state, region)) Eng.revealRegion(state, region, res, 'a public event happens there');
        Eng.revealNamed(state, text, res, 'a public event names it');
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
  Eng.contentWords = contentWords;

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
  // True when a reveal shares at least one content word with what the
  // character hides (their secret or private facts).
  function touchesSecret(state, id, text) {
    const c = state.characters[id];
    const secretWords = contentWords([c.secret].concat(E.Memory.privateFacts(state, id).map((f) => f.text)).join(' '));
    return [...contentWords(text)].some((w) => secretWords.has(w));
  }

  // opts.crossingRoll: a risky crossing's roll already made by the journey
  // check (R-2), so it isn't rolled twice.
  Eng.resolve = function (state, intentObj, present, actionText, stepId, due, opts) {
    const outcomes = [];
    const res = { outcomes, events: [], guards: [] };
    const list = [cleanIntent(state, intentObj.player, state.player)];
    const given = Array.isArray(intentObj.intents) ? intentObj.intents : [];
    present.forEach((id) => list.push(cleanIntent(state, given.find((g) => g && g.id === id), id)));
    // If the player's action is about someone already in the room, they don't go
    // anywhere, unless the action says so ("…then head to the garage") or names
    // someone who is at the destination.
    const p = list[0];
    if (opts && opts.crossingRoll) Object.assign(p, { presetRoll: opts.crossingRoll.roll, needsRoll: true, skill: opts.crossingRoll.skill, difficulty: 'hard' });
    // Standees (task 3-2): who the player can deal with, and sneaking always rolls.
    res.engaged = Eng.engagedStandees(state, actionText).map((g) => g.id);
    const here0 = state.characters[state.player].status.location;
    // Site rules (task 3-6): something the map is silent about, first, so a
    // window the player climbs out of exists before the move.
    const ownWay = !p.newFeature && Eng.wayFromWords(state, actionText, p.moveTo);
    const wayExists = ownWay && Eng.features(state, ownWay.room || here0).some((f) => f.name.toLowerCase().includes(ownWay.name.split(' ').pop()));
    const feature = p.newFeature || (ownWay && !wayExists ? ownWay : null);
    if (feature) {
      const out = Eng.inferFeature(state, feature, actionText);
      if (out.error) guard(res, 'resolve', 'feature rejected', out.error);
      else {
        guard(res, 'resolve', 'feature added', out.note + (p.newFeature ? '' : " (from the player's words)"));
        // Out through it: walk to that room, then through the new way.
        if (out.to && out.to === p.moveTo && out.room !== here0) p.viaRoom = out.room;
      }
    }
    // Picking a lock always rolls, unless the player holds the key.
    if (p.unlock && !p.needsRoll) {
      const k = Eng.linkInfo(state, here0, p.unlock);
      if (k && k.locked && !k.key.includes(state.player)) {
        const sk = state.scenario.skills;
        Object.assign(p, { needsRoll: true, skill: sk.includes('mechanics') ? 'mechanics' : sk.includes('technical') ? 'technical' : sk[0], difficulty: 'normal' });
        guard(res, 'resolve', 'roll required', `unlocking the way to ${state.locations[p.unlock] ? state.locations[p.unlock].name : p.unlock}`);
      }
    }
    // Routes (R-2): a closed way between regions blocks the move with no
    // model call; a risky one can be tried as a hard roll (a roll from the
    // journey check, when there was one, counts). A trip longer than the
    // step that the player didn't ask for is cancelled (rule 3).
    if (p.moveTo && state.locations[p.moveTo]) {
      p.trip = Eng.tripBetween(state, here0, p.moveTo);
      const t = p.trip;
      if (t && t.blocked && t.risky && !p.needsRoll) {
        Object.assign(p, { needsRoll: true, skill: t.closed.skill, difficulty: 'hard' });
        guard(res, 'resolve', 'roll required', `crossing: ${t.why}; the player tries anyway`);
      }
      if (t && !t.blocked && t.hours > E.stepHours(state, stepId).hours) {
        guard(res, 'resolve', 'move cancelled', `a trip of ${E.Scenario.sayHours(t.hours)} to ${state.locations[p.moveTo].name} the player's words don't set out on`);
        p.moveTo = null;
        p.trip = null;
      }
    }
    if (!p.needsRoll && state.scenario.skills.includes('stealth') && Eng.sneakNeedsRoll(state, actionText)) {
      Object.assign(p, { needsRoll: true, skill: 'stealth', difficulty: 'normal' });
      guard(res, 'resolve', 'roll required', 'the player sneaks with a group close by: stealth roll');
    }
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
      const leaks = leaksSecret(state, it.id, `${o.action} ${o.says || ''}`);
      let flagged = it.revealFlag;
      // A reveal has to carry the secret (playtest 2026-10-21: Teo's deflection
      // "probably just a bubble in the line" went in reveals and passed on stress).
      if (flagged && !leaks && it.id !== state.player) {
        const shown = o.reveals && !/^(true|yes)$/i.test(o.reveals) ? o.reveals : `${o.action} ${o.says || ''}`;
        if (!touchesSecret(state, it.id, shown)) {
          guard(res, 'resolve', 'reveal dropped', `${c.name}: "${shown.trim()}" isn't about what they hide`);
          o.reveals = null;
          flagged = false;
        }
      }
      const attempt = flagged || leaks;
      if (it.id !== state.player && attempt) {
        if (revealAllowed(state, it.id, outcomes[0], actionText)) {
          if (!o.reveals) o.reveals = o.says || o.action;
        } else {
          o.note = 'reveal held back (not enough pressure yet)';
          guard(res, 'resolve', flagged ? 'reveal blocked' : 'leak deflected',`${c.name}: ${o.reveals || `${o.action} ${o.says || ''}`}`);
          o.reveals = null;
          o.action = 'is pressed about it but keeps the secret: deflects, makes an excuse or changes the subject';
          o.says = null;
        }
      }
      if (it.needsRoll) {
        let mod = 0;
        if (it.id === state.player) {
          // Standees (task 3-2): a target must be a group that is here and able to resist.
          if (it.against && !(res.engaged.includes(it.against) && Eng.standeeActive(state.standees[it.against]))) {
            guard(res, 'resolve', 'standee rejected', `roll against "${it.against}": no such group here that can resist`);
            it.against = null;
          }
          const dc = Eng.standeeDC(state, it);
          mod = dc.mod;
          if (dc.why.length) { o.dcWhy = dc.why.join('; '); guard(res, 'resolve', 'difficulty', o.dcWhy); }
        }
        o.roll = it.presetRoll || Eng.roll(c, it.skill, it.difficulty, state.scenario, mod);
      }
      const failed = o.roll && /failure/.test(o.roll.result);
      // A risky crossing that failed: turned back at it, and hurt if the route says so.
      if (it.id === state.player && failed && it.trip && it.trip.blocked && it.trip.risky) {
        guard(res, 'resolve', 'turned back', `${c.name}: ${it.trip.why}; the attempt failed`);
        o.action += ` (but is turned back: ${it.trip.why})`;
        if (it.trip.closed.failHarm) {
          const h = Eng.harm(state, it.id, 'hurt', res, `crossing ${it.trip.closed.kind}`);
          if (h && h.reject) guard(res, 'resolve', 'harm rejected', h.reject);
        }
      }
      if (it.id === state.player && failed && Eng.STEALTH_SKILLS.includes(it.skill)) {
        const seen = Eng.standeesNotice(state, it);
        if (seen.length) { res.standeeChanges = (res.standeeChanges || []).concat(seen); seen.forEach((l) => guard(res, 'resolve', 'noticed', l)); }
      }
      // Locks: the player unlocks on a success (or with the key); others only with the key.
      ['unlock', 'lock'].forEach((verb) => {
        const to = it[verb];
        if (!to) return;
        const k = Eng.linkInfo(state, c.status.location, to);
        const holder = k && k.key.includes(it.id);
        if (!holder && (it.id !== state.player || verb === 'lock')) return guard(res, 'resolve', 'lock rejected', `${c.name} has no key to ${verb} the way to ${state.locations[to] ? state.locations[to].name : to}`);
        if (!holder && failed) return;
        const why = setLock(state, it.id, c.status.location, to, verb === 'lock');
        if (why) return guard(res, 'resolve', 'lock rejected', `${c.name} ${verb}: ${why}`);
        guard(res, 'resolve', verb === 'lock' ? 'locked' : 'unlocked', `${c.name}: the way between ${state.locations[c.status.location].name} and ${state.locations[to].name}`);
        o.action += ` [${verb}s the way to ${state.locations[to].name}]`;
      });
      // Coming along (playtest-api-chop-shop: Juno "pulls on her coat to come
      // along" with no move, so the frame kept her home and the narrator took
      // her anyway): someone present who says they go with the player, and
      // sets no move of their own, goes where the player went.
      if (it.id !== state.player && !it.moveTo && outcomes[0] && outcomes[0].moved && Eng.comesAlong(state, `${it.action} ${it.says || ''}`)) {
        it.moveTo = outcomes[0].moved;
        guard(res, 'resolve', 'came along', `${c.name} goes with ${state.characters[state.player].name}`);
      }
      if (it.moveTo && it.moveTo !== c.status.location && !failed) {
        // Movement follows links (task 3-6): no way through, no move. Between
        // regions it follows routes too (R-2).
        const trip = it.id === state.player ? it.trip : Eng.tripBetween(state, c.status.location, it.moveTo);
        const crossed = trip && trip.blocked && it.id === state.player && trip.risky && o.roll && !failed;
        const why = Eng.moveProblem(state, it.id, c.status.location, it.moveTo)
          || (trip && trip.blocked && !crossed ? trip.why : null)
          || (trip && it.id !== state.player && trip.hours > E.stepHours(state, stepId).hours ? `${state.locations[it.moveTo].name} is ${E.Scenario.sayHours(trip.hours)} away` : null);
        if (why) {
          guard(res, 'resolve', 'move blocked', `${c.name} → ${it.moveTo}: ${why}`);
          o.action += ` (but ${why}, so ${it.id === state.player ? 'you stay' : 'they stay'} in ${state.locations[c.status.location].name})`;
        } else {
          let path = Eng.route(state, c.status.location, it.moveTo, { who: it.id });
          // Through a way the player named in another room (the stockroom window).
          if (it.viaRoom) { const leg = Eng.route(state, c.status.location, it.viaRoom, { who: it.id }); if (leg.length) path = leg.concat([it.moveTo]); }
          if (path.length > 2) o.via = path.slice(1, -1);
          c.status.location = it.moveTo;
          o.moved = it.moveTo;
          if (crossed) guard(res, 'resolve', 'crossed', `${c.name}: ${trip.why}, and gets through anyway`);
          // The way, for the narrator: legs that take time, or a crossing.
          if (trip && trip.legs && (trip.hours > 0 || crossed)) {
            o.trip = Eng.sayTrip(state, trip);
            o.action += ` (the way: ${o.trip}${crossed ? `; gets past although ${trip.why}` : ''})`;
          }
        }
      }
      outcomes.push(o);
    });
    resolveGroups(state, intentObj, res, res.engaged);
    if (list[0].singleOut) {
      const out = Eng.singleOut(state, list[0].singleOut, actionText, state.turn);
      if (out.error) guard(res, 'resolve', 'standee rejected', `single out: ${out.error}`);
      else { guard(res, 'resolve', 'singled out', out.note); res.standeeChanges = (res.standeeChanges || []).concat(out.note); }
    }
    applyEvents(state, intentObj, present, stepId || 'hour', res, due);
    applyNewExtras(state, intentObj.new_extras, state.turn, state.characters[state.player].status.location, (why) => guard(res, 'resolve', 'extra rejected', why), (note) => guard(res, 'resolve', 'extra added', note));
    return res;
  };

  // One intent per group with the player (task 3-2): what the group does, and
  // at most one linked step away. Groups that are down can't act; unknown or
  // absent ids are dropped.
  function resolveGroups(state, intentObj, res, engaged) {
    res.groups = [];
    const given = Array.isArray(intentObj.group_intents) ? intentObj.group_intents.slice(0, 6) : [];
    given.forEach((gi) => {
      const g = gi && state.standees[gi.id];
      if (g && res.groups.some((x) => x.id === g.id)) return;
      if (!g || !engaged.includes(g.id)) return guard(res, 'resolve', 'standee rejected', `group intent for "${gi && gi.id}": no such group here`);
      if (!Eng.standeeActive(g)) return guard(res, 'resolve', 'standee rejected', `${g.label} is ${g.state} and can't act`);
      const o = { id: g.id, action: String(gi.action || 'hold where they are').slice(0, 200), visible: gi.visible !== false, moved: null };
      if (gi.move_to != null && gi.move_to !== '') {
        const dest = Eng.resolveLocation(state, gi.move_to, false);
        const why = standeeMoveProblem(state, g, dest);
        if (why) guard(res, 'resolve', 'standee move', `${g.label} → ${gi.move_to}: ${why}`);
        else { g.location = dest; o.moved = dest; }
      }
      res.groups.push(o);
    });
  }

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
  // routine.climb: the player's needs their plan doesn't cover, which climb anyway.
  Eng.advanceTime = function (state, hours, res, routine) {
    state.time.hour += hours;
    while (state.time.hour >= 24) { state.time.hour -= 24; state.time.day += 1; }
    const climb = (routine && routine.climb) || [];
    state.scenario.needs.forEach((n) => {
      Eng.cast(state, { alive: true }).forEach((id) => {
        const c = state.characters[id];
        const v = c.needs[n.id] || 0;
        const unmet = id === state.player && climb.includes(n.id);
        // People in the background live their routine: needs settle, not climb.
        const settles = !unmet && (routine || Eng.tier(state, id) === 'secondary');
        c.needs[n.id] = settles
          ? E.clamp(0.35 + (v - 0.35) * Math.exp(-hours / 24), 0, 1)
          : E.clamp(v + (n.perHour || 0) * hours, 0, 1);
        // How long the player has been at a need's limit (the body gives out after a while).
        if (id === state.player) {
          c.needsOver = c.needsOver || {};
          if (c.needs[n.id] < 1) delete c.needsOver[n.id];
          else if (!settles && n.perHour > 0) c.needsOver[n.id] = (c.needsOver[n.id] || 0) + Math.min(hours, (v + n.perHour * hours - 1) / n.perHour);
        }
      });
    });
    state.clocks.slice().forEach((cl) => {
      if (cl.fired) return;
      cl.value = E.clamp(cl.value + (cl.perHour || 0) * hours, 0, cl.max);
      if (cl.value >= cl.max) Eng.fireClock(state, cl, res);
    });
    fadeRegionTags(state, res);
    // Downtime runs agendas itself (Eng.runAgendas), step by step.
    if (!routine) advanceAgendas(state, hours);
    advancePatrols(state, hours);
  };

  // ---------- worn phrases ----------
  // Runs of 4 to 12 words that two or more of the last four scenes share, with
  // at least two content words that aren't names; longest first, 6 at most
  // (playtest-coffee-skips: "the pot is the only instrument anyone trusts").
  const JOINERS = new Set(['and', 'but', 'or', 'so', 'then', 'while', 'as', 'with', 'of', 'to', 'at', 'in', 'on', 'for']);
  Eng.wornPhrases = function (state) {
    const scenes = (state.log || []).filter((l) => l.type === 'scene').slice(-4).map((l) => String(l.text || ''));
    if (scenes.length < 2) return [];
    const names = new Set();
    Object.values(state.characters).forEach((c) => String(c.name || '').toLowerCase().split(/[^a-z]+/).forEach((w) => names.add(w)));
    const words = (t) => t.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
    const scenesOf = new Map();
    scenes.forEach((t, i) => {
      const mine = new Set();
      // Within a sentence or clause, and never starting or ending on a joining word.
      t.split(/[.!?,;:\n\u2014\u2013]+|\s-\s/).forEach((clause) => {
        const w = words(clause);
        for (let n = 4; n <= 12; n++) {
          for (let k = 0; k + n <= w.length; k++) {
            if (JOINERS.has(w[k]) || JOINERS.has(w[k + n - 1])) continue;
            mine.add(w.slice(k, k + n).join(' '));
          }
        }
      });
      mine.forEach((g) => { if (!scenesOf.has(g)) scenesOf.set(g, new Set()); scenesOf.get(g).add(i); });
    });
    const picked = [];
    // Two phrases are the same when they share four words in a row.
    const fours = (g) => { const w = g.split(' '); const out = []; for (let k = 0; k + 4 <= w.length; k++) out.push(w.slice(k, k + 4).join(' ')); return out; };
    [...scenesOf.entries()]
      .filter(([g, at]) => at.size >= 2 && [...contentWords(g)].filter((w) => !names.has(w)).length >= 2)
      .map(([g]) => g)
      .sort((a, b) => b.length - a.length)
      .forEach((g) => { if (picked.length < 6 && !picked.some((p) => fours(g).some((f) => p.includes(f)))) picked.push(g); });
    return picked;
  };

  // ---------- harm and open emergencies ----------
  // Health only gets worse here, never back from the dead; the player by one
  // step per blow. Death of the player ends the story (playtest-coffee-skips:
  // nothing could hurt anyone, so the story could never end).
  Eng.harm = function (state, id, health, res, why) {
    const c = state.characters[id];
    if (!c || !Eng.alive(state, id)) return { reject: `${id}: not a living character` };
    const now = Math.max(0, HEALTH.indexOf(c.status.health));
    let to = HEALTH.indexOf(health);
    if (to < 0) return { reject: `${c.name}: bad health "${health}"` };
    if (to <= now) return { reject: `${c.name}: no worse than ${E.healthWord(c.status.health)}` };
    if (id === state.player) to = now + 1;
    c.status.health = HEALTH[to];
    if (HEALTH[to] === 'dead') {
      state.flags.chapterWorthy = true;
      if (id === state.player) state.flags.gameOver = true;
    }
    const line = `${c.name}: ${E.healthWord(HEALTH[to])}${why ? ` (${why})` : ''}`;
    guard(res, 'resolve', 'harm', line);
    return line;
  };
  // A model's harm list ([{id, health}], 3 at most), only for people in `allowed`.
  Eng.applyHarm = function (state, list, allowed, res, why) {
    if (!Array.isArray(list)) return [];
    const done = [];
    list.slice(0, 3).forEach((h) => {
      const id = h && h.id;
      if (!state.characters[id]) return guard(res, 'resolve', 'harm rejected', `unknown character "${id}"`);
      if (allowed && !allowed.has(id)) return guard(res, 'resolve', 'harm rejected', `${state.characters[id].name} wasn't there`);
      const out = Eng.harm(state, id, h.health, res, why);
      if (out && out.reject) guard(res, 'resolve', 'harm rejected', out.reject);
      else if (out) done.push(out);
    });
    return done;
  };
  // The emergency the last turn ended on, while it is still the next turn's
  // problem: { turn, text, who }. Call before the turn number advances.
  // Who an emergency concerns: everyone alive at the player's site, not just the
  // room (playtest-coffee-skips: Kit was alone in the commons for every crisis).
  Eng.crisisPeople = (state) => {
    const site = E.Sites.playerSite(state);
    return Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => E.Sites.siteOf(state, state.characters[id].status.location) === site);
  };
  Eng.openCrisis = (state) => (state.crisis && state.crisis.turn === state.turn ? state.crisis : null);

  // Pressures still in play: those that haven't gone off, and one that went off
  // this turn. After that it lives on as a fact and in the journal, not in the
  // Situation panel or the prompts (playtest-coffee-skips: six "(HAPPENED)" by Sol 328).
  Eng.liveClocks = (state) => state.clocks.filter((c) => !c.fired || c.firedTurn === state.turn);

  Eng.REGION_TAG_HOURS = 72;
  function fadeRegionTags(state, res) {
    Object.entries(state.regionTagUntil || {}).forEach(([key, until]) => {
      if (until > absHours(state)) return;
      delete state.regionTagUntil[key];
      const cut = key.indexOf('|');
      const r = state.regions && state.regions[key.slice(0, cut)];
      const i = r ? r.tags.findIndex((x) => x.toLowerCase() === key.slice(cut + 1)) : -1;
      if (i < 0) return;
      r.tags.splice(i, 1);
      guard(res, 'resolve', 'region tag faded', `${key.slice(0, cut)}: ${key.slice(cut + 1)}`);
    });
  }

  Eng.fireClock = function (state, cl, res) {
    cl.fired = true;
    cl.firedTurn = state.turn;
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
    state.crisis = { turn: state.turn, text, who: Eng.crisisPeople(state) };
    // An authored pressure can hurt people when it goes off: everyone, or
    // everyone outside (thirst, cold, air running out).
    if (cl.fireHarm) {
      const ids = [state.player].concat(Eng.cast(state, { alive: true, includePlayer: false }))
        .filter((id) => cl.fireHarm === 'all' || (state.locations[state.characters[id].status.location] || {}).outside);
      ids.forEach((id) => Eng.harm(state, id, HEALTH[Math.min(3, HEALTH.indexOf(state.characters[id].status.health) + 1)], res, cl.name));
    }
    // A repeating pressure starts again: it keeps hurting until someone deals with it.
    if (cl.repeat) { cl.fired = false; cl.value = 0; cl.lastFired = state.turn; }
    // Follow-up pressures: e.g. the storm arriving starts "Storm clears" and "Battery reserve".
    (cl.then || []).forEach((t) => {
      if (!t || !t.id || state.clocks.find((x) => x.id === t.id)) return;
      state.clocks.push(Object.assign({ value: 0, perHour: 0, fired: false }, E.clone(t)));
    });
  };

  // ---------- the player's body and conscience during a skip ----------
  // A skip settles the player's needs only when their plan covers them (rule 3:
  // they do only what the plan says). A need that runs out stops the skip and
  // happens to the player (playtest-coffee-skips 2: four sols awake on coffee,
  // and nothing ever happened to Kit).
  Eng.NEED_LIMITS = {
    fatigue: { relief: /\b(sleep|slept|rest|nap|bed|bunk|doze|lie down|turn in)/, missing: 'sleep', text: 'collapses from exhaustion', worst: 'badly_hurt', after: 0.3, grace: 12 },
    hunger: { relief: /\b(eat|ate|food|meal|cook|breakfast|lunch|dinner|supper|snack|ration)/, missing: 'food', text: 'collapses, weak from hunger', worst: 'dead', after: 0.6, grace: 48 },
    thirst: { relief: /\b(water|drink)/, missing: 'water', text: 'collapses from thirst', worst: 'dead', after: 0.6, grace: 12 },
    stress: { relief: /\b(rest|relax|sleep|talk|read|music|game|exercise|walk|meditat|pray|unwind)/, missing: 'rest', text: 'breaks down under the strain', worst: 'ok', after: 0.6, grace: 24 },
    fear: { relief: /\b(rest|relax|sleep|talk|hide|pray|meditat|unwind)/, missing: 'rest', text: 'freezes up, overwhelmed by fear', worst: 'ok', after: 0.6, grace: 12 },
  };
  const ROUTINE_PLAN = /\b(routine|usual|normal|daily|chores|duties|shifts?|carry on|get on with|keep busy)\b/;
  const wordsPattern = (words) => new RegExp('\\b(' + words.map((w) => String(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i');
  // A need's limit in any world: the built-in one for its id, or a plain one
  // (its own name is its relief), with the world's own `limit` fields on top.
  Eng.needLimit = function (state, id) {
    const n = state.scenario.needs.find((x) => x.id === id);
    if (!n) return null;
    const label = String(n.label || n.id).toLowerCase();
    const base = Eng.NEED_LIMITS[id] || { relief: wordsPattern(label.split(/\s+/).concat(id)), missing: label, text: `gives out, worn down by ${label}`, worst: 'hurt', after: 0.6, grace: 24 };
    const own = n.limit || {};
    const lim = Object.assign({}, base, own);
    if (Array.isArray(own.relief) && own.relief.length) lim.relief = wordsPattern(own.relief);
    return lim;
  };
  // Does an action rest or seek care? (Sleep, rest, or treatment by someone.)
  const CARE = /(treat|medic|doctor|bandage|stitch|heal|patch me|first aid|med ?bay|infirmary|hospital)/;
  Eng.restsOrHeals = function (state, action) {
    const t = String(action || '').toLowerCase();
    if (CARE.test(t)) return true;
    const f = state.scenario.needs.some((n) => n.id === 'fatigue') ? Eng.needLimit(state, 'fatigue') : Eng.NEED_LIMITS.fatigue;
    return f.relief.test(t);
  };
  // The player's needs their skip plan leaves out. An empty or routine plan covers them all.
  Eng.unmetNeeds = function (state, action) {
    const t = String(action || '').toLowerCase();
    if (!t.trim() || ROUTINE_PLAN.test(t)) return [];
    return state.scenario.needs.map((n) => n.id).filter((id) => { const lim = Eng.needLimit(state, id); return lim && !lim.relief.test(t); });
  };
  function bodyStop(state, action) {
    const pc = state.characters[state.player];
    let best = null;
    Eng.unmetNeeds(state, action).forEach((id) => {
      const n = state.scenario.needs.find((x) => x.id === id);
      if (!(n.perHour > 0)) return;
      // Time to the limit, then the hours a body lasts past it.
      const lim = Eng.needLimit(state, id);
      const hours = Math.max(1, Math.ceil((1 - (pc.needs[id] || 0)) / n.perHour + lim.grace - ((pc.needsOver || {})[id] || 0)));
      if (!best || hours < best.hours) best = { hours, need: id, text: `${pc.name} ${lim.text}.` };
    });
    return best;
  }
  function bodyGivesOut(state, body, action, res) {
    const pc = state.characters[state.player];
    const lim = Eng.needLimit(state, body.need);
    const label = (state.scenario.needs.find((n) => n.id === body.need) || {}).label || body.need;
    const now = Math.max(0, HEALTH.indexOf(pc.status.health));
    // The same limit pushed again, by a body already as worn as it makes it,
    // goes one step further (playtest-coffee-toothless: Kit blacked out eight
    // times and stayed "badly hurt"). Death that way only where danger is lethal.
    pc.collapses = pc.collapses || {};
    const times = pc.collapses[body.need] = (pc.collapses[body.need] || 0) + 1;
    let cap = HEALTH.indexOf(lim.worst);
    if (cap > 0 && times > 1 && now >= cap) cap += 1;
    if (cap >= 3 && HEALTH.indexOf(lim.worst) < 3 && (E.Genres.lead(state.scenario) || { danger: 'lethal' }).danger !== 'lethal') cap = 2;
    if (cap > now) Eng.harm(state, state.player, HEALTH[now + 1], res, `no ${lim.missing}${times > 1 ? `, again (${times} times)` : ''}`);
    pc.needs[body.need] = lim.after;
    if (pc.needsOver) delete pc.needsOver[body.need];
    E.Memory.addFact(state, { about: [state.player], text: body.text, known_by: ['all'], weight: 2 });
    guard(res, 'resolve', 'body gives out', `${body.text} (${label} at its limit; the plan "${action}" left no room for ${lim.missing})`);
    // The others have to drop everything for it: it counts as sitting things out.
    state.ignored = (state.ignored || []).concat(E.shorten(body.text, 120)).slice(-4);
  }

  // Sitting out emergencies has a reckoning: after RECKONING_AFTER of them in a
  // row, the person who thinks least of the player comes to confront them.
  Eng.RECKONING_AFTER = 2;
  Eng.RECKONING_HOURS = 3;
  // In a skip, the open emergency it is about to sit out counts too.
  function reckoningStop(state, countOpen = true) {
    const open = countOpen && Eng.openCrisis(state);
    const sat = (state.ignored || []).concat(open ? [open.text] : []);
    if (sat.length < Eng.RECKONING_AFTER) return null;
    const pid = state.player;
    const who = Eng.crisisPeople(state).sort((a, b) => (state.characters[a].relations[pid] || 0) - (state.characters[b].relations[pid] || 0))[0];
    return who ? { hours: Eng.RECKONING_HOURS, id: who, sat: sat.slice(-3) } : null;
  }

  // ---------- skipping to the next major event ----------
  // Fast-forwards without the model: stops at the first clock to fire, a
  // random major event, or the horizon, whichever comes first; earlier than
  // that, the player's body giving out or someone coming to confront them.
  Eng.planMajorSkip = function (state, action) {
    const plan = planWorldStop(state);
    const body = bodyStop(state, action);
    const reckon = reckoningStop(state);
    if (body && body.hours < plan.hours && (!reckon || body.hours <= reckon.hours)) return { hours: body.hours, reason: 'body', body };
    if (reckon && reckon.hours < plan.hours) return { hours: reckon.hours, reason: 'reckoning', reckoning: reckon };
    return plan;
  };
  function planWorldStop(state) {
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
    let plan;
    if (contact && contact.hours <= horizon && contact.hours <= randomHours && (!clockHit || contact.hours < clockHit.hours)) {
      plan = { hours: contact.hours, reason: 'agenda', agenda: contact };
    } else if (clockHit && clockHit.hours <= randomHours) plan = { hours: clockHit.hours, reason: 'clock', clock: clockHit };
    else if (randomHours <= horizon) plan = { hours: Math.round(randomHours), reason: 'random' };
    else plan = { hours: horizon, reason: 'horizon' };
    // The next timeline event stops the skip like a clock (task 5-2); a clock
    // or someone's agenda at the same hour comes first.
    const canon = E.Timeline.next(state);
    const first = canon && (canon.hours < plan.hours || (canon.hours === plan.hours && !['agenda', 'clock'].includes(plan.reason)));
    return first ? { hours: canon.hours, reason: 'canon', canon } : plan;
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
    if (MOODS.test(low) || low.split(' ').some((w) => MOODS.test(w)) || /\bon edge\b/.test(low) || state.scenario.needs.some((n) => low.includes(n.id) || low.includes((n.label || '').toLowerCase()))) {
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

  // Most of the shorter mood's content words are in the other one.
  Eng.sameMood = function (a, b) {
    const x = contentWords(a), y = contentWords(b);
    const small = x.size <= y.size ? x : y, big = small === x ? y : x;
    if (!small.size) return cleanPhrase(a).toLowerCase() === cleanPhrase(b).toLowerCase();
    return [...small].filter((w) => big.has(w)).length / small.size >= 0.75;
  };
  Eng.setMood = function (state, c, value, reason, turn) {
    let text = cleanPhrase(value);
    if (!text) return { error: 'empty mood' };
    if (text.length > 60) text = E.shorten(text, 60);
    if (leaksSecret(state, c.id, text)) return { error: 'the mood gives away their secret' };
    // A near-repeat keeps the turn the mood was set, so it can still go stale
    // ("clipped and businesslike, eyes fixed on the weather relay" → "clipped
    // and fixed on the weather relay").
    if (c.mood && Eng.sameMood(c.mood.text, text)) return { error: `nearly the same as the current mood ("${c.mood.text}")` };
    c.mood ={ text, turn, reason: cleanPhrase(reason).slice(0, 100) };
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
    if (c.portrait === false) return Eng.monogram(state, id);
    const set = state.scenario.portraitSet || [];
    if (set.length) return { path: set[E.hash(id) % set.length], standIn: true };
    return Eng.monogram(state, id);
  };
  // Initials (titles like "Dr." skipped) on a hue from the id.
  // Characters and extras (the map shows both).
  Eng.monogram = function (state, id) {
    const c = state.characters[id] || (state.extras && state.extras[id]) || {};
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
  // Placeholder values from the update prompt's shape and guidelines.
  Eng.PROMPT_EXAMPLES = ['new short description', 'degraded, about 70% output', 'new short stance'];
  Eng.applyUpdate = function (state, upd, present, ctx) {
    ctx = ctx || {};
    const report = { applied: [], rejected: [], tags: [], extras: [], standees: [] };
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
      // Facts may be about a group (task 3-2), though a group knows nothing.
      const about = (f.about || []).filter((x) => named(x) || isStandee(state, x));
      let known = (f.known_by || []).filter((x) => x === 'all' || named(x));
      if (!known.includes('all')) {
        const absent = known.filter((x) => !couldKnow.has(x));
        if (absent.length) reject('fact known_by', `dropped ${absent.join(', ')}: not in the scene (${String(f.text).slice(0, 60)})`);
        known = known.filter((x) => couldKnow.has(x));
      }
      if (!known.length) known = witnesses.slice();
      // A fact only about the player is about what they did: they know it
      // (playtest-stragglers-sneak, playtest-office-window: "Jordan knocked on
      // the office door" known only by Dex and Ruth). Facts that also name
      // someone else ("Okafor suspects Kit…") stay as given.
      let addedPlayer = false;
      if (!known.includes('all') && about.length && about.every((x) => x === state.player) && !known.includes(state.player)) { known.push(state.player); addedPlayer = true; }
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
      report.applied.push(`fact: ${fact.text} (w${fact.weight}, known by ${fact.known_by.join('/')}${addedPlayer ? '; the player added: it is about their own action' : ''})`);
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
        const blocked = x.location && Eng.moveProblem(state, key, x.location, dest);
        if (blocked) return reject(label, blocked);
        x.location = dest;
      } else if (kind === 'char') {
        const c = state.characters[key];
        if (!c) return reject(label, 'unknown character');
        if (s.field === 'health') {
          if (!HEALTH.includes(s.value)) return reject(label, 'bad health value');
          if (c.status.health === 'dead' && s.value !== 'dead') return reject(label, 'the dead stay dead');
          const now = HEALTH.indexOf(c.status.health), to = HEALTH.indexOf(s.value);
          if (to === now) return reject(label, 'no change');
          // The player gets worse one blow at a time (rule 12), and nobody
          // mends faster than a step a turn; the player only mends when their
          // own action rests or seeks care (playtest-coffee-toothless: the
          // update step healed Kit between collapses, so nothing ever stuck).
          if (key === state.player && to > now) {
            if (ctx.playerHarmed) return reject(label, 'the engine already counted the blow this turn');
            const out = Eng.harm(state, key, HEALTH[now + 1], null, 'the scene');
            if (out && out.reject) return reject(label, out.reject);
          } else {
            if (to < now - 1) return reject(label, 'mending happens a step at a time');
            if (to < now && key === state.player && !Eng.restsOrHeals(state, ctx.action)) return reject(label, 'the player only mends when their own action rests or seeks care');
            c.status.health = s.value;
          }
          if (c.status.health === 'dead') {
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
          const blocked = Eng.moveProblem(state, key, c.status.location, dest);
          if (blocked) return reject(label, blocked);
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
          // The player's needs climb on the engine's clock; the model can only
          // ease them (playtest-coffee-toothless: +1 fatigue after each collapse).
          if (key === state.player && Number(s.delta) > 0) return reject(label, "the player's needs only climb with time");
          c.needs[s.need] = E.clamp(c.needs[s.need] + E.clamp(Number(s.delta) || 0, -1, 1), 0, 1);
        } else return reject(label, 'unknown field');
      } else if (kind === 'standee') {
        // Groups (task 3-2): count, state and location, clamped.
        const g = state.standees[key];
        if (!g) return reject(label, 'unknown group');
        if (s.field === 'count') {
          const d = Math.round(Number(s.delta) || 0);
          if (!d) return reject(label, 'no change');
          if (d > 0 && !(ctx.involved || []).includes(key)) return reject(label, "a group only grows when one of this turn's events brings more");
          const n = E.clamp(g.count + E.clamp(d, -g.count, Math.max(1, Math.ceil(g.count / 2))), 0, 999);
          g.count = n;
          if (n <= 0) report.standees.push(removeStandee(state, g, 'is down to no one'));
        } else if (s.field === 'state') {
          if (!E.Scenario.STANDEE_STATES.includes(s.value)) return reject(label, 'state must be calm, alert, hostile, fled or down');
          if (![ctx.startLoc, ctx.endLoc].includes(g.location) && !(ctx.engaged || []).includes(key)) return reject(label, 'nobody in the scene could have seen that');
          g.state = s.value;
          if (s.value === 'fled') report.standees.push(removeStandee(state, g, 'fled'));
        } else if (s.field === 'location') {
          const dest = Eng.resolveLocation(state, s.value, false);
          const why = standeeMoveProblem(state, g, dest);
          if (why) return reject(label, why);
          if (![ctx.startLoc, ctx.endLoc].includes(g.location) && dest !== ctx.endLoc && !(ctx.engaged || []).includes(key)) return reject(label, 'nobody in the scene could have seen that move');
          if (ctx.keptProse != null && !Eng.seenLeaving(ctx.keptProse, { id: g.id, name: g.label })) return reject(label, 'the player stepped in before they left');
          g.location = dest;
        } else return reject(label, 'groups have only count, state and location');
      } else if (kind === 'link') {
        // Site rules (task 3-6): a door opened or shut in the scene.
        const [a, b] = String(key || '').split('|');
        const k = a && b && Eng.linkInfo(state, a, b);
        if (!k || k.kind === 'open') return reject(label, 'no door, hatch or window there');
        if (s.field !== 'open' || typeof s.value !== 'boolean') return reject(label, 'a way can only be opened or shut ("open": true or false)');
        if (![ctx.startLoc, ctx.endLoc].some((r) => r === a || r === b)) return reject(label, 'nobody in the scene was there');
        if (s.value && k.locked) return reject(label, 'it is locked');
        state.links[Eng.linkKey(a, b)].open = s.value;
      } else if (kind === 'feature') {
        const i = String(key || '').indexOf('|');
        const room = String(key).slice(0, i), name = String(key).slice(i + 1);
        if (!state.locations[room] || state.features[`${room}|${name}`] == null) return reject(label, 'no feature with a state there');
        if (s.field !== 'state' || typeof s.value !== 'string' || !s.value.trim()) return reject(label, 'a feature only changes its "state"');
        if (![ctx.startLoc, ctx.endLoc].includes(room)) return reject(label, 'nobody in the scene was there');
        state.features[`${room}|${name}`] = s.value.trim().toLowerCase().slice(0, 20);
      } else if (kind === 'room') {
        if (!state.locations[key]) return reject(label, 'unknown room');
        if (s.field !== 'seen' || s.value !== true) return reject(label, 'a room can only be revealed ("seen": true)');
        if (!state.seenRooms.includes(key)) state.seenRooms.push(key);
      } else if (kind === 'world') {
        if (!(key in state.world)) return reject(label, 'unknown world key');
        const lock = (state.worldSetBy || {})[key];
        if (lock && lock.turn === (ctx.turn ?? state.turn)) return reject(label, `set by "${lock.clock}" this turn`);
        // The prompt's own examples are not news (playtest-stragglers-sneak:
        // the holdout's barricades became "degraded, about 70% output").
        const v = String(s.value || '').trim().toLowerCase();
        if (Eng.PROMPT_EXAMPLES.includes(v) && String(state.world[key]).toLowerCase() !== v) return reject(label, "copied the prompt's example");
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
  // via: the rooms the player actually passed through this turn, if known.
  Eng.findRelocation = function (state, prose, startLoc, via) {
    const endLoc = state.characters[state.player].status.location;
    // Rooms passed through on the way are fine ("you cross the commons to the med bay").
    const allowed = new Set([startLoc, endLoc].concat(via && via.length ? via : Eng.route(state, startLoc, endLoc)));
    // After a move, walking back out of the room they moved to (task 3-6;
    // playtest-office-window: "You slip out of the office, leaving it
    // unlocked. Ruth is waiting for you" while Jordan stayed in the office).
    if (startLoc !== endLoc && state.locations[endLoc]) {
      const end = state.locations[endLoc];
      const words = [end.name, end.id, end.name.split(/\s+/).pop()].filter((n) => n && n.length > 3).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const names = `(?:the\\s+)?(?:[\\w']+\\s+)?(?:${[...new Set(words)].join('|')})`;
      const out = new RegExp(`\\byou\\b[^.!?\\n]{0,30}\\b(?:slip|slips|step|steps|walk|walks|head|heads|go|goes|come|comes|get|gets|duck|ducks|hurry|hurries|climb|climbs|back|edge|edges)\\s+(?:back\\s+)?out\\s+of\\s+${names}\\b|\\byou\\b[^.!?\\n]{0,30}\\b(?:leave|leaves|exit|exits)\\s+${names}\\b`, 'i');
      if (out.test(prose)) return { id: null, name: end.name, to: `back out of ${end.name}` };
    }
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
    // A feature only another room has (task 3-6; playtest-stragglers-sneak:
    // "You're almost to the abandoned pickup" while Jordan stayed on the dock).
    const bare = (n) => n.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/'s\b.*$/, '');
    const mine = new Set([...allowed].flatMap((r) => Eng.features(state, r).map((f) => bare(f.name))));
    const reach = `${verbs}|reach|reaches|get to|gets to|make it to|crouch(?:es)? (?:behind|by|beside)|hide(?:s)? behind`;
    for (const l of Object.values(state.locations)) {
      if (allowed.has(l.id)) continue;
      for (const f of Eng.features(state, l.id)) {
        const n = bare(f.name);
        if (n.length < 4 || mine.has(n)) continue;
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\byou(?:'re| are)?\\b[^.!?\\n]{0,30}(?:\\b(?:${reach})\\b|\\b(?:almost|nearly|right) (?:to|at|by|beside|behind)\\b)[^.!?\\n]{0,30}\\b${esc}\\b`, 'i');
        if (re.test(prose)) return l;
      }
    }
    return null;
  };

  // Shortest path between two locations through `connects`, both ends included.
  // Empty when either is unknown or there is no way through.
  // opts.who (task 3-6): only through ways that person can pass (locked
  // doors block unless they hold the key). Without opts every link counts.
  Eng.route = function (state, from, to, opts) {
    if (!state.locations[from] || !state.locations[to]) return [];
    if (from === to) return [from];
    const prev = { [from]: null };
    const queue = [from];
    const nexts = (id) => (opts ? Eng.linkedRooms(state, id) : state.locations[id].connects || []);
    while (queue.length) {
      const id = queue.shift();
      for (const next of nexts(id)) {
        if (!state.locations[next] || next in prev) continue;
        if (opts && !Eng.passable(state, id, next, opts.who)) continue;
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
  // names: the people in the story, so a paragraph that hands over to one of
  // them is not the player's (without names, only "he" or "she" count).
  Eng.trimPlayerEnding = function (prose, names) {
    const paras = String(prose || '').split(/\n\s*\n/);
    let dropped = 0;
    // Also the player's own quoted line ("Just looking," you say…;
    // playtest-office-window).
    // But not a paragraph that opens on the player and hands over to someone
    // else ("You turn to go, but Dex hesitates. "Wait…""; playtest-r2-drive-to-ridge:
    // trimming it lost the hook the scene ended on).
    const who = ['he', 'she', 'He', 'She'].concat((names || []).filter((n) => /^[A-Z][\w'-]+$/.test(n)));
    const turn = new RegExp(`(?:[.!?]["”]?\\s+|,\\s*(?:but|and|while|as|when|until|then)\\s+)(?:${who.join('|')})\\s+[a-z]+(?:s|ed)\\b`, 'g');
    const handsOver = (p) => {
      const at = [...p.matchAll(turn)].pop();
      return !!at && !/[.!?]["”]?\s+(?:You|Your)\b/.test(p.slice(at.index + at[0].length));
    };
    const mine = (p) => (/^\s*(\[[^\]]*\]\s*)?(you|your)\b/i.test(p) && !handsOver(p)) || /^\s*(\[[^\]]*\]\s*)?["“][^"”]*["”],?\s*you\s+(?:say|said|ask|asked|reply|replied|tell|told|answer|answered|add|added|murmur|mutter|whisper|call|shrug)\b/i.test(p);
    while (paras.length > 1 && dropped < 2 && mine(paras[paras.length - 1])) {
      if (dropped && /^\s*\[\s*\+/.test(paras[paras.length - 1])) break;
      paras.pop();
      dropped++;
    }
    return paras.join('\n\n').trim();
  };

  // Every word of the names of the people besides the player ("Dex",
  // "Coleman", "Mrs.", "Albee"), for spotting someone else taking a turn.
  Eng.peopleWords = (state) => [...new Set(Object.values(state.characters).filter((c) => c.id !== state.player).map((c) => c.name)
    .concat(Object.values(state.extras || {}).map((x) => x.name)).join(' ').split(/\s+/).map((w) => w.replace(/[^\w'-]/g, '')).filter((w) => w.length > 1))];

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
    const out = Eng.trimPlayerEnding(clean, state ? Eng.peopleWords(state) : null);
    if (out !== clean) guard(res, 'scene', 'player ending trimmed', clean.slice(out.length));
    return out;
  };

  // ---------- the turn ----------
  // ---------- beats ----------
  // The narrator marks beats with [+Nm] / [+Nh]. Returns [{at (minutes), text}].
  Eng.parseBeats = function (prose, spanMinutes) {
    // Seconds too, alone or after minutes ("[+30s]", "[+1m 15s]"): a 12B wrote
    // them for a few-minute step and they stayed in the prose
    // (playtest-stragglers-sneak). Compound marks too ("[+0h06]", "[+1d 20h]"):
    // a number without a unit after another is the next smaller unit
    // (playtest-coffee-skips).
    const UNIT = 'days?|day|sols?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s';
    const re = new RegExp(`\\[\\s*\\+\\s*((?:\\d+(?:\\.\\d+)?\\s*(?:${UNIT})?\\s*){1,3})\\]`, 'gi');
    const per = { d: 1440, h: 60, m: 1, s: 1 / 60 };
    const smaller = { d: 'h', h: 'm', m: 's', s: 's' };
    const kind = (u) => (/^(d|sol)/.test(u) ? 'd' : u.startsWith('h') ? 'h' : /^s/.test(u) ? 's' : 'm');
    const minutesOf = (inner) => {
      let total = 0;
      let prev = null;
      const part = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})?`, 'gi');
      let p;
      while ((p = part.exec(inner))) {
        const u = p[2] ? kind(p[2].toLowerCase()) : prev ? smaller[prev] : 'm';
        total += parseFloat(p[1]) * per[u];
        prev = u;
      }
      return total;
    };
    const marks = [];
    let m;
    while ((m = re.exec(prose))) marks.push({ index: m.index, end: re.lastIndex, at: minutesOf(m[1]) });
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
      (p.pins || []).forEach((x) => applyPin(state, x));
      endLoc = state.characters[state.player].status.location;
      Eng.advanceTime(state, minutes / 60, { events: [] }, p.routine === true ? true : p.routine || false);
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
      const before = {};
      Eng.cast(state, { includePlayer: false }).forEach((id) => (before[id] = state.characters[id].status.location));
      const factsBefore = state.facts.length;
      report = Eng.applyUpdate(state, upd, p.present, { startLoc: p.frame.startLoc, endLoc, keptProse: cut ? prose : null, involved: p.res.involved, turn: p.turn, action: p.action, playerHarmed: (p.res.guards || []).some((g) => g.type === 'harm' && g.detail.startsWith(state.characters[state.player].name + ':')), extrasPresent: p.extrasPresent || [], engaged: p.res.engaged || [] });
      report.rejected.forEach((r) => guard(p.res, 'memory', 'update rejected', r));
      expired.concat(report.tags).forEach((t) => guard(p.res, 'memory', 'tags & mood', t));
      report.extras.forEach((t) => guard(p.res, 'memory', 'extras', t));
      const kept = [];
      E.Sites.noteFacts(state, factsBefore, [p.frame.startLoc, endLoc], kept);
      kept.forEach((t) => guard(p.res, 'memory', 'site kept', t));
      const keptRegions = [];
      E.Sites.noteRegionFacts(state, factsBefore, [p.frame.startLoc, endLoc], keptRegions);
      keptRegions.forEach((t) => guard(p.res, 'memory', 'region kept', t));
      // People the update step moved were seen leaving or arriving.
      Object.entries(before).forEach(([id, loc]) => {
        const now = state.characters[id] && state.characters[id].status.location;
        if (now && now !== loc && [p.frame.startLoc, endLoc].includes(loc)) state.known[id] = { loc: now, turn: p.turn };
      });
    } catch (err) {
      E.Memory.addFact(state, { about: [state.player], text: `${state.characters[state.player].name}: ${p.action}`.slice(0, 200), known_by: ['all'], weight: 1 });
      report = { applied: [], rejected: [], warning: 'Update step failed: ' + err.message };
      guard(p.res, 'memory', 'update failed', err.message);
    }
    if (cut) report.applied.unshift(`interjected after beat ${cut} of ${total}`);
    Eng.noteSeen(state, cut ? null : p.res, p.turn);
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

  // ---------- journeys (R-2) ----------
  // A trip longer than the time step is the turn: a downtime stretch with a
  // destination, interrupted the way a skip is. Only when the player's own
  // words set out (rule 3). → null, { dest, trip, roll, companions }, or
  // { failed } (a risky crossing whose roll failed, for resolve to report).
  const SETS_OUT = /\b(travel|drive|ride|fly|sail|set (?:out|off)|journey|take the (?:road|train|bus|boat|ship|ferry))\b/i;
  Eng.journeyFor = function (state, intentObj, action, step) {
    const p = intentObj && intentObj.player;
    if (!p || step.id === 'major' || typeof p.move_to !== 'string') return null;
    const pc = state.characters[state.player];
    const here = pc.status.location;
    const dest = Eng.resolveLocation(state, p.move_to, true);
    if (!dest || dest === here || Eng.moveProblem(state, state.player, here, dest)) return null;
    const trip = Eng.tripBetween(state, here, dest);
    if (!trip || !trip.legs || !(trip.hours > step.hours)) return null;
    const site = (state.sites || {})[E.Sites.siteOf(state, dest)];
    const named = [site && site.name, (Eng.regionDef(state, Eng.regionOf(state, dest)) || {}).name].filter(Boolean).some((n) => mentionsName(action, n));
    if (!(Eng.setsOut(action) || planNames(state, action, dest) || named)) return null;
    let roll = null;
    if (trip.blocked) {
      if (!trip.risky) return null; // resolve blocks it and says why
      roll = { skill: trip.closed.skill, roll: Eng.roll(pc, trip.closed.skill, 'hard', state.scenario, 0) };
      if (/failure/.test(roll.roll.result)) return { failed: roll };
    }
    const all = /\b(we|us|everyone|all of us|together)\b/i.test(String(action || ''));
    const companions = Eng.present(state).filter((id) => Eng.alive(state, id) && (all || mentions(action, state.characters[id])));
    return { dest, trip, roll, companions };
  };
  // The player's words set out somewhere: a move ("I head…") or travel ("I drive…").
  Eng.setsOut = (action) => PLAYER_MOVES.test(String(action || '')) || SETS_OUT.test(String(action || ''));
  const mentionsName = (text, name) => new RegExp(`\\b${String(name).replace(/^the\s+/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(text || ''));
  // Where a journey stopped short: a plain outdoor room in the region the
  // trip had reached, with the way on and the way back. No model call; it
  // never enters the header, and it goes once nobody is in it (clearTransit).
  function transitRoom(state, journey, hoursDone, origin) {
    let done = 0;
    let region = Eng.regionOf(state, origin);
    for (const e of journey.trip.legs) {
      if (done + e.hours > hoursDone) break;
      done += e.hours;
      region = e.to;
    }
    const dest = state.locations[journey.dest];
    let id = 'on-the-way';
    for (let n = 2; state.locations[id]; n++) id = `on-the-way-${n}`;
    const rname = (Eng.regionDef(state, region) || {}).name || region;
    state.locations[id] = {
      id, name: E.shorten(`On the way to ${dest.name}`, 40), desc: `Somewhere on the way to ${dest.name}, in ${rname}.`, outside: true, region, site: id, transit: true,
      connects: [journey.dest, origin], links: [{ to: journey.dest, kind: 'trip' }, { to: origin, kind: 'trip' }],
    };
    state.seenRooms = [...new Set((state.seenRooms || []).concat(id))];
    return id;
  }
  // Rooms a journey stopped in, once no one is there or last known there.
  Eng.clearTransit = function (state) {
    Object.values(state.locations).filter((l) => l.transit).forEach((l) => {
      const used = Object.values(state.characters).some((c) => c.status.location === l.id)
        || Object.values(state.extras || {}).some((x) => x.location === l.id) || Object.values(state.standees || {}).some((g) => g.location === l.id)
        || Object.values(state.known || {}).some((k) => k && k.loc === l.id);
      if (used) return;
      delete state.locations[l.id];
      state.seenRooms = (state.seenRooms || []).filter((x) => x !== l.id);
      if (state.links) Object.keys(state.links).filter((k) => k.split('|').includes(l.id)).forEach((k) => delete state.links[k]);
    });
  };
  // The end of a journey: the player (and whoever came along) arrives, or
  // waits where the trip stopped.
  function endJourney(state, plan, frame, res) {
    const j = plan.journey;
    const arrived = plan.reason === 'arrive';
    const to = arrived ? j.dest : transitRoom(state, j, plan.hours, frame.startLoc);
    [state.player].concat(j.companions).filter((id) => Eng.alive(state, id)).forEach((id) => { state.characters[id].status.location = to; });
    const dname = state.locations[j.dest].name;
    guard(res, 'resolve', 'journey', arrived ? `arrived at ${dname} after ${E.Scenario.sayHours(j.trip.hours)}`
      : `stopped ${E.Scenario.sayHours(plan.hours) || 'early'} into ${E.Scenario.sayHours(j.trip.hours)} on the way to ${dname}; waiting in ${state.locations[to].name}`);
    if (j.companions.length) guard(res, 'resolve', 'came along', `${j.companions.map((id) => state.characters[id].name).join(', ')} travel with ${state.characters[state.player].name}`);
  }

  // The downtime turn: simulate time, ask the model for a montage and (if
  // needed) the interrupting event, then narrate it with day-stamped beats.
  // opts.journey (R-2): the trip it is, from Eng.journeyFor; opts.notes: guards
  // from the played turn it replaced.
  async function skipTurn(state, action, phase, opts) {
    const journey = opts && opts.journey;
    const timelineNotes = (opts && opts.notes) || [];
    if (E.Timeline.needsProjection(state)) { phase('Planning the days ahead…'); await E.Timeline.project(state, timelineNotes); }
    const askNotes = checkAsk(state, action);
    let plan = Eng.planMajorSkip(state, action);
    // A journey ends on arrival, unless something stops it first.
    if (journey) {
      if (plan.hours >= journey.trip.hours) plan = { hours: journey.trip.hours, reason: 'arrive' };
      plan.journey = journey;
    }
    const routine = { climb: Eng.unmetNeeds(state, action) };
    // Skipping while the last scene's emergency is unanswered: it plays out
    // without the player, and it costs something (playtest-coffee-skips).
    plan.crisis = Eng.openCrisis(state);
    // A player who keeps sitting things out can't stay out of the next major
    // event: it happens where they are (playtest-coffee-bystander).
    plan.onPlayer = plan.reason === 'random' && ((state.ignored || []).length + (plan.crisis ? 1 : 0) >= 1 || (state.skipStreak || 0) >= 2);
    if (!journey) state.skipStreak = (state.skipStreak || 0) + 1;
    const tierChanges = Eng.promoteForAction(state, Eng.present(state), action, state.turn + 1);
    const pre = E.clone(state);
    delete pre.log; delete pre.pending; delete pre.undo;
    state.turn += 1;
    const system = E.Prompts.header(state);
    const frame = { startTime: E.fmtTime(state), startLoc: state.characters[state.player].status.location, stepId: 'major', stepLabel: 'until something major happens', spanMinutes: Math.round(plan.hours * 60) };
    if (journey) {
      const reg = (loc) => (Eng.regionDef(state, Eng.regionOf(state, loc)) || {}).name;
      frame.stepLabel = `the journey to ${state.locations[journey.dest].name}`;
      frame.journey = `travelling from ${reg(frame.startLoc)} to ${state.locations[journey.dest].name} in ${reg(journey.dest)}: ${Eng.sayTrip(state, journey.trip)}, ${E.Scenario.sayHours(journey.trip.hours)} in all${journey.companions.length ? `, with ${journey.companions.map((id) => state.characters[id].name).join(', ')}` : ''}`;
      if (journey.roll) frame.journey += `; got past although ${journey.trip.why}`;
      if (plan.reason !== 'arrive') frame.journey += `. It is cut short ${E.Scenario.sayHours(plan.hours) || 'early'} in`;
      else frame.arrival = state.locations[journey.dest].name;

    }
    const presentStart = Eng.present(state);
    const res = { outcomes: [], events: [], guards: [] };
    tierChanges.forEach((t) => guard(res, 'resolve', 'cast tier', t));
    timelineNotes.concat(askNotes).forEach((n) => guard(res, 'resolve', n.type, n.detail));

    phase('Fast-forwarding…');
    Eng.advanceTime(state, plan.hours, res, routine);
    const agendaSteps = Eng.runAgendas(state, plan.hours, plan, res);
    frame.endTime = E.fmtTime(state);
    frame.days = Math.round(plan.hours / 24 * 10) / 10;
    // A timeline event ends the skip (task 5-2), checked now. As written, it
    // is the interrupting event (like a clock); broken and "diverge", the
    // model writes the altered version as the major event; dropped, the model
    // picks a major event as it would for a random one.
    let canonLead = null;
    let canonRest = [];
    if (plan.reason === 'canon') {
      const due = E.Timeline.due(state, 0);
      canonLead = due.find((d) => d.ev.id === plan.canon.id) || due[0] || null;
      canonRest = due.filter((d) => d !== canonLead);
      if (!canonLead) plan.reason = 'random';
      else if (!canonLead.broken.length) plan.canonMode = 'fired';
      else if (canonLead.ev.onBroken === 'diverge') plan.canonMode = 'diverge';
      else { plan.canonMode = 'drop'; plan.reason = 'random'; }
      if (canonLead && plan.canonMode !== 'diverge') { E.Timeline.resolveDue(state, [canonLead], [], res); }
      if (plan.canonMode === 'fired') plan.canonText = state.canon[canonLead.ev.id].text;
      if (plan.canonMode === 'diverge') plan.canonEvent = { text: canonLead.ev.text, broken: canonLead.broken };
    }

    phase('Simulating the downtime…');
    const obj = await E.LLM.chatJSON({
      kind: 'intent', system, user: E.Prompts.skipIntent(state, action, plan, frame, res, agendaSteps),
      maxTokens: 900, temperature: 0.8,
    });
    // Keys left inside an unclosed "major_event" belong to the reply itself.
    const mj = obj.major_event && typeof obj.major_event === 'object' ? obj.major_event : null;
    if (mj) ['positions', 'player_where', 'reckoning'].forEach((k) => { if (obj[k] == null && mj[k] != null) { obj[k] = mj[k]; delete mj[k]; } });

    // The emergency the player left: its outcome, its cost, and what the
    // people who needed them now think of them.
    if (plan.crisis) ignoredCrisis(state, plan.crisis, obj.crisis, res);
    // what happened in the meantime, without the timeline event repeated as one
    const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const canonTexts = [plan.canonText].concat(canonRest.map((d) => d.ev.text)).filter(Boolean).map(norm);
    const events = (Array.isArray(obj.events) ? obj.events : []).filter((e) => {
      if (!(e && canonTexts.includes(norm(e.text)))) return true;
      guard(res, 'resolve', 'event dropped', `repeats the timeline event: ${E.shorten(e.text, 80)}`);
      return false;
    });
    Eng.applyEvents(state, { events }, [], 'hours', res,
      { regional: true, world: plan.hours >= 72 }, { local: 2, regional: 2, world: plan.hours >= 72 ? 1 : 0 }, true);
    // Other timeline events due at the same hour happen too (as news).
    if (canonRest.length) E.Timeline.resolveDue(state, canonRest, obj.canon, res);
    if (plan.canonMode === 'diverge') {
      const m = obj.major_event;
      const done = E.Timeline.resolveDue(state, [canonLead], m && typeof m === 'object' ? [{ id: canonLead.ev.id, text: m.text, effects: m.effects }] : [], res);
      if (done.length) res.major = { text: done[0], scope: 'canon' };
    }
    // the interrupting event, when it isn't a pressure clock firing or someone's agenda
    if (res.major) {
      // a rewritten timeline event (above)
    } else if (plan.reason === 'canon' && plan.canonMode === 'fired') {
      res.major = { text: plan.canonText, scope: 'canon' };
    } else if (plan.reason === 'agenda') {
      const c = state.characters[plan.agenda.id];
      const text = stepSentence(c, plan.agenda);
      res.events.push(`[major] ${text}`);
      res.major = { text, scope: 'agenda', who: plan.agenda.id };
    } else if (plan.reason === 'body') {
      bodyGivesOut(state, plan.body, action, res);
      res.events.push(`[major] ${plan.body.text}`);
      res.major = { text: plan.body.text, scope: 'body', who: state.player };
    } else if (plan.reason === 'reckoning') {
      const c = state.characters[plan.reckoning.id];
      // What they demand or take away, in the model's words (playtest-coffee-toothless:
      // the ultimatum was written, then lost, and the narrator softened it to a talk).
      const said = [obj.reckoning, obj.major_event && obj.major_event.text].find((x) => typeof x === 'string' && x.trim() && !/^one (short )?sentence/i.test(x.trim()));
      const text = said ? E.clip(said, 240) : `${c.name} comes to confront ${state.characters[state.player].name} about sitting out the emergencies.`;
      res.events.push(`[major] ${text}`);
      res.major = { text, scope: 'reckoning', who: c.id };
    } else if (plan.reason === 'arrive') {
      // a journey that got there: no major event
    } else if (plan.reason !== 'clock') {
      const m = obj.major_event && typeof obj.major_event.text === 'string' ? obj.major_event : { text: 'Something goes badly wrong, and the routine ends.' };
      const text = E.clip(m.text, 240);
      const scope = ['regional', 'world'].includes(m.scope) ? m.scope : 'local';
      const effects = applyEffects(state, m.effects, scope, res);
      const region = eventRegion(state, m, scope, res);
      // Who it hurts: people it names or who are where it happens.
      const where = plan.onPlayer ? state.characters[state.player].status.location : Eng.resolveLocation(state, m.where, false);
      const hit = new Set((Array.isArray(m.who) ? m.who : []).filter((id) => state.characters[id])
        .concat([state.player].concat(Eng.cast(state, { alive: true, includePlayer: false })).filter((id) => where && state.characters[id].status.location === where)));
      Eng.applyHarm(state, m.harm, hit, res, 'the major event');
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
      if (!c || !loc || !Eng.alive(state, p.id)) return;
      const why = Eng.moveProblem(state, p.id, c.status.location, loc);
      if (why) return guard(res, 'resolve', 'move blocked', `${c.name} → ${loc}: ${why}`);
      c.status.location = loc;
    });
    // The player ends up somewhere else only if their plan names it (rule 3;
    // playtest-agenda-skips: "keep to routine" put Kit outside as the storm hit).
    const pw = journey ? null : Eng.resolveLocation(state, obj.player_where, false);
    if (journey) endJourney(state, plan, frame, res);
    // Arriving somewhere hidden, or a major event naming it, reveals it (R-5).
    if (res.major && res.major.text) Eng.revealNamed(state, res.major.text, res, 'the event that ends the downtime names it');
    if (pw && pw !== frame.startLoc) {
      if (planNames(state, action, pw)) state.characters[state.player].status.location = pw;
      else guard(res, 'resolve', 'move cancelled', `the downtime put the player in ${pw}; their plan doesn't take them there`);
    }
    Eng.revealAround(state, res);
    // A journey's arrival is a visit, as in a played turn.
    E.Sites.noteVisit(state, frame.startLoc);
    E.Sites.noteRegionVisit(state, frame.startLoc);
    // The agenda that ends the downtime brings its person to the player.


    if (plan.reason === 'agenda') {
      const c = state.characters[plan.agenda.id];
      if (activeAgenda(c) && c.agenda.due) {
        c.status.location = state.characters[state.player].status.location;
        E.Memory.addFact(state, { about: [c.id], text: res.major.text, known_by: [c.id, state.player], weight: 2 });
        completeStep(state, c, res, 'ends the downtime');
      }
    }
    // The person who has had enough comes to the player, and the slate is clean.
    if (plan.reason === 'reckoning') {
      const c = state.characters[plan.reckoning.id];
      c.status.location = state.characters[state.player].status.location;
      E.Memory.addFact(state, { about: [c.id, state.player], text: res.major.text, known_by: [c.id, state.player], weight: 2 });
      guard(res, 'resolve', 'reckoning', `${c.name} confronts ${state.characters[state.player].name} after ${plan.reckoning.sat.length} emergencies sat out`);
      state.ignored = [];
    }
    // Someone came to the player: the next action answers them or turns them away.
    if (plan.reason === 'agenda' || plan.reason === 'reckoning') {
      const id = plan.reason === 'agenda' ? plan.agenda.id : plan.reckoning.id;
      state.ask = { turn: state.turn, who: id, text: res.major.text, reckoning: plan.reason === 'reckoning' };
    }
    res.outcomes.push({ id: state.player, action: action || 'keeps to routine through the downtime', visible: true, roll: null, moved: null });
    // A skip that ends on a clock, a timeline event or a major event closes a
    // chapter; one that ends with someone coming to talk doesn't (playtest-coffee-skips:
    // a chapter every two turns). A clock or a random major event also leaves an
    // emergency for the next turn; timeline news doesn't (playtest-coffee-skips 2:
    // the sponsor's review and a break in the dust became "emergencies").
    if (['clock', 'random', 'canon'].includes(plan.reason) && res.major) state.flags.chapterWorthy = true;
    if (['clock', 'random'].includes(plan.reason) && res.major) {
      state.crisis = { turn: state.turn, text: res.major.text, who: Eng.crisisPeople(state) };
    } else delete state.crisis;

    const montage = checkMontage(state, action, Array.isArray(obj.montage) ? obj.montage.filter((x) => x && x.text).slice(0, 5) : [], res);
    const doings = (Array.isArray(obj.positions) ? obj.positions.filter((p) => p && state.characters[p.id] && p.doing) : [])
      .map((p) => (plan.reason === 'agenda' && p.id === plan.agenda.id ? Object.assign({}, p, { doing: plan.agenda.text }) : p));
    if (plan.reason === 'agenda' && !doings.some((p) => p.id === plan.agenda.id)) doings.push({ id: plan.agenda.id, doing: plan.agenda.text });
    if (plan.reason === 'reckoning') {
      const i = doings.findIndex((p) => p.id === plan.reckoning.id);
      const d = { id: plan.reckoning.id, doing: `comes to confront ${state.characters[state.player].name}` };
      if (i >= 0) doings[i] = d; else doings.push(d);
    }
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
    Eng.noteSeen(state, null, state.turn);
    state.pending = { turn: state.turn, action: action || 'Keeps to routine through the downtime.', res, frame, present: witnesses, beats, pre, routine, narration };
    phase('');
    return { prose: text, beats, res, plan };
  }

  // The emergency the player didn't answer, during a skip: the model's outcome
  // (or a plain one), the harm it names among the people who were there, a
  // public fact, and those people's feelings toward the player drop. Engine-owned,
  // so ignoring someone in trouble always costs something.
  Eng.CRISIS_TRUST = 6;
  function ignoredCrisis(state, crisis, cr, res) {
    const pc = state.characters[state.player];
    cr = cr && typeof cr === 'object' ? cr : {};
    const outcome = typeof cr.outcome === 'string' && cr.outcome.trim() && !/^one or two sentences/i.test(cr.outcome.trim())
      ? E.clip(cr.outcome, 220) : `The emergency played out without ${pc.name}.`;
    const there = new Set((crisis.who || []).concat(state.player).filter((id) => state.characters[id]));
    const hurt = Eng.applyHarm(state, cr.harm, there, res, `while ${pc.name} stayed out of it`);
    res.events.unshift(outcome);
    E.Memory.addFact(state, { about: (crisis.who || []).filter((id) => state.characters[id]), text: outcome, known_by: ['all'], weight: 3 });
    const cooled = sitOut(state, crisis);
    guard(res, 'resolve', 'crisis ignored', `${E.shorten(crisis.text, 80)} → ${outcome}${hurt.length ? '' : ' (no one hurt)'}${trustNote(state, cooled)}`);
  }
  // Sitting an emergency out, in a skip or a played turn: it counts toward a
  // reckoning, and the people it concerned trust the player less.
  function sitOut(state, crisis) {
    state.ignored = (state.ignored || []).concat(E.shorten(crisis.text, 120)).slice(-4);
    const cooled = (crisis.who || []).filter((id) => id !== state.player && Eng.alive(state, id));
    cooled.forEach((id) => {
      const c = state.characters[id];
      c.relations[state.player] = E.clamp((c.relations[state.player] || 0) - Eng.CRISIS_TRUST, -100, 100);
    });
    return cooled;
  }
  const trustNote = (state, cooled) => (cooled.length ? `; trust toward ${state.characters[state.player].name} −${Eng.CRISIS_TRUST}: ${cooled.map((id) => state.characters[id].name).join(', ')}` : '');
  // Did a played turn's action deal with the open emergency? The intent call
  // says; without an answer, the action has to share a word with it.
  function answersCrisis(intentObj, action, crisis) {
    const said = intentObj && intentObj.player && intentObj.player.crisis_answered;
    if (typeof said === 'boolean') return said;
    const words = stems(crisis.text);
    return [...stems(action)].some((w) => words.has(w));
  }

  // Someone came to the player at the end of the last turn (an agenda's contact
  // step, or a reckoning): the next action answers them or turns them away. Turned
  // away, it counts as sitting things out; a reckoning turned away costs the
  // player their place: everyone trusts them less and they're sidelined
  // (playtest-coffee-toothless: an ultimatum, then "drink more coffee", and nothing).
  Eng.ASK_TRUST = 6;
  Eng.SIDELINED_TRUST = 10;
  Eng.openAsk = (state) => (state.ask && state.ask.turn === state.turn && Eng.alive(state, state.ask.who) ? state.ask : null);
  Eng.answersAsk = function (state, action, ask) {
    const t = String(action || '').toLowerCase();
    const c = state.characters[ask.who];
    const said = new Set(t.split(/[^a-z']+/));
    if (namesOf(c).some((n) => said.has(n))) return true;
    const own = new Set(namesOf(state.characters[state.player]).concat(namesOf(c)));
    const words = stems(ask.text);
    return [...stems(action)].some((w) => !own.has(w) && words.has(w));
  };
  function checkAsk(state, action) {
    const ask = Eng.openAsk(state);
    delete state.ask;
    if (!ask || Eng.answersAsk(state, action, ask)) return [];
    const pc = state.characters[state.player];
    const c = state.characters[ask.who];
    const notes = [];
    if (!ask.reckoning) {
      state.ignored = (state.ignored || []).concat(E.shorten(`${c.name} came to ${pc.name} and was turned away`, 120)).slice(-4);
      c.relations[state.player] = E.clamp((c.relations[state.player] || 0) - Eng.ASK_TRUST, -100, 100);
      notes.push({ type: 'ask ignored', detail: `${c.name}: "${E.shorten(ask.text, 70)}" — the action didn't answer; trust toward ${pc.name} −${Eng.ASK_TRUST}` });
      return notes;
    }
    const others = Eng.cast(state, { alive: true, includePlayer: false });
    others.forEach((id) => {
      const x = state.characters[id];
      x.relations[state.player] = E.clamp((x.relations[state.player] || 0) - Eng.SIDELINED_TRUST, -100, 100);
    });
    const group = String(state.scenario.castLabel || 'group').toLowerCase();
    Eng.addTag(state, pc, `sidelined by the ${group}`.split(' ').slice(0, 5).join(' '), 30, `ignored ${c.name}'s ultimatum`, state.turn);
    state.reckonings = (state.reckonings || 0) + 1;
    state.flags.chapterWorthy = true;
    E.Memory.addFact(state, { about: [state.player, c.id], text: `${pc.name} ignored ${c.name}'s ultimatum, and the ${group} stopped counting on ${pc.name}.`, known_by: ['all'], weight: 3 });
    notes.push({ type: 'sidelined', detail: `${pc.name} ignored ${c.name}'s ultimatum: trust −${Eng.SIDELINED_TRUST} from everyone, tagged "sidelined"` });
    return notes;
  }

  // Montage moments the narrator gets: none where the player does more than
  // their plan (rule 3: "Kit cuts a brace…" from "keep drinking coffee"), and
  // none that gives a secret away (rule 5). Both seen in playtest-coffee-skips.
  // Words by stem, so "drinks" and "drinking" are the same word.
  const stems = (t) => new Set([...contentWords(t)].map((w) => w.replace(/(ing|ed|es|s)$/, '')));
  const namesOf = (c) => [c.name].concat(String(c.name || '').replace(/^(dr|mr|mrs|ms|mx|capt|sgt|prof)\.?\s+/i, '').split(/\s+/))
    .filter((n) => n && n.length > 2).map((n) => n.toLowerCase());
  // A montage moment gives a secret away when it names its keeper and shares 3+
  // words with the secret itself, or 1+ with a confession word. Stricter than
  // for a person's own lines: a montage is full of the station's everyday words.
  function montageLeaks(state, id, text) {
    const c = state.characters[id];
    const words = new Set(text.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z'-]+/));
    if (!namesOf(c).some((n) => words.has(n))) return false;
    const secret = contentWords(c.secret);
    const hits = [...contentWords(text)].filter((w) => secret.has(w)).length;
    return hits >= 3 || (hits >= 1 && /\b(admit|admits|admitted|confess|confesses|confessed|reveal|reveals|revealed|owns up|comes clean)\b/i.test(text));
  }

  function checkMontage(state, action, montage, res) {
    const names = namesOf(state.characters[state.player]);
    const planWords = stems(action);
    return montage.filter((m) => {
      const t = String(m.text).trim();
      const lead = t.toLowerCase();
      const playerLeads = /^you\b/.test(lead) || names.some((n) => lead.startsWith(n + ' ') || lead.startsWith(n + "'"));
      // The sentence the player leads: later ones are about others ("the number keeps climbing").
      const first = t.split(/(?<=[.!?])\s/)[0];
      if (playerLeads && planWords.size && ![...stems(first)].some((w) => planWords.has(w))) {
        guard(res, 'resolve', 'montage dropped', `the player does more than their plan ("${action}"): ${E.shorten(t, 120)}`);
        return false;
      }
      const leaker = Eng.cast(state, { alive: true, includePlayer: false }).find((id) => state.characters[id].secret && montageLeaks(state, id, t));
      if (leaker) {
        guard(res, 'resolve', 'leak deflected', `${state.characters[leaker].name}, in the montage: ${E.shorten(t, 120)}`);
        return false;
      }
      return true;
    });
  }

  // A scene call: its text, without the paragraph the token limit cut off
  // (playtest-r2-drive-to-ridge: the 12B writes about twice the words asked
  // for, so the limit lands mid-paragraph in the last beat). The complete
  // paragraphs before it stay, so the scene ends on one that was written to
  // end. A scene of one paragraph is left to the cut to the last sentence.
  Eng.dropCutParagraph = function (text, res) {
    const paras = String(text || '').trim().split(/\n\s*\n/);
    if (paras.length < 2) return text;
    const gone = paras.pop();
    guard(res, 'scene', 'cut-off paragraph dropped', E.shorten(gone.replace(/\s+/g, ' ').trim(), 120));
    return paras.join('\n\n');
  };
  async function sceneCall(opts, res) {
    const text = await E.LLM.chat(opts);
    return E.LLM.lastFinish === 'length' ? Eng.dropCutParagraph(text, res) : text;
  }

  async function writeSkipScene(state, n, p, phase) {
    phase('Writing the downtime…');
    const prose = Eng.cleanScene(await sceneCall({
      kind: 'narrate', system: n.system, user: E.Prompts.narrateSkip(state, n.action, p.frame, n.montage, n.doings, p.res, n.presentStart),
      maxTokens: Math.round(E.settings.narrateTokens * 2.2),
    }, p.res), p.res, state);
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
    const narrateOnce = async () => Eng.cleanScene(await sceneCall({
      kind: frame.correction ? 'narrate (retry)' : 'narrate', system, user: E.Prompts.narrate(state, present, action, frame, res),
      maxTokens: Math.round(E.settings.narrateTokens * (step.lengthMult || 1)),
    }, res), res, state);
    let prose = await narrateOnce();
    const playerOut = res.outcomes && res.outcomes.find((o) => o.id === state.player);
    const via = playerOut && playerOut.via ? [frame.startLoc].concat(playerOut.via) : null;
    const strayed = Eng.findRelocation(state, prose, frame.startLoc, via);
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
        const more = Eng.cleanScene(await sceneCall({
          kind: 'narrate (continue)', system, user: E.Prompts.narrateMore(state, present, action, frame, res, markedBeats(beats), lastAt),
          maxTokens: Math.round(E.settings.narrateTokens * 0.8),
        }, res), res, state);
        const away = more && Eng.findRelocation(state, more, frame.startLoc, via);
        if (away) guard(res, 'scene', 'continuation dropped', `it took the player ${away.to || `to ${away.name}`}`);
        else if (more) {
          beats = Eng.parseBeats(Eng.trimPlayerEnding(Eng.cleanProse(markedBeats(beats) + '\n\n' + more), Eng.peopleWords(state)), frame.spanMinutes);
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
    const t = { kind, turn, action: action || '', stepId, calls: [], guards: [], lore: [], ms: 0, started: Date.now() };
    E.LLM.collector = t.calls;
    E.Lore.collector = t.lore;
    return t;
  }
  function finishReport(t, guards, err) {
    if (E.LLM.collector === t.calls) E.LLM.collector = null;
    if (E.Lore.collector === t.lore) E.Lore.collector = null;
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
    if ((t.lore || []).length) {
      lines.push(`Lore included (${t.lore.length}):`);
      t.lore.forEach((l) => lines.push(`- ${l.call} · ${l.id} (${l.title}): ${l.why}`));
    }
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
    Eng.clearTransit(state);
    // Facts the player learned last turn may name a hidden region (R-5).
    const early = { guards: [] };
    Eng.revealAround(state, early);
    // A flavour place where danger has come grows into a tactical one (R-8).
    (await E.Sites.growIfDanger(state, phase)).forEach((t) => guard(early, 'resolve', 'site grown', t));
    if (stepId === 'major') {
      const out = await skipTurn(state, action, phase);
      out.report = report || { applied: [], rejected: [] };
      return out;
    }
    const step = E.stepHours(state, stepId);

    // Before the start snapshot, so a step-in (which rewinds to it) keeps it.
    const tierChanges = Eng.promoteForAction(state, Eng.present(state), action, state.turn + 1);
    const extraNotes = Eng.noteExtraMentions(state, action, state.turn + 1);
    // Nothing planned for the next few days: the model projects some (task 5-2).
    const timelineNotes = [];
    if (E.Timeline.needsProjection(state)) { phase('Planning the days ahead…'); await E.Timeline.project(state, timelineNotes); }
    const crisis = Eng.openCrisis(state);
    const pre = E.clone(state);
    delete pre.log; delete pre.pending; delete pre.undo;
    state.turn += 1;
    state.skipStreak = 0;
    state.turn -= 1;
    const askNotes = checkAsk(state, action);
    state.turn += 1;
    // Emergencies sat out in played turns count too: the person who has had
    // enough walks in this span (playtest-coffee-bystander).
    const reckon = reckoningStop(state, false);
    if (reckon) {
      state.characters[reckon.id].status.location = state.characters[state.player].status.location;
      state.ignored = [];
    }
    const present = Eng.present(state);
    const extrasPresent = Eng.extrasAt(state, state.characters[state.player].status.location).map((x) => x.id);
    const system = E.Prompts.header(state); // same prefix for all calls this turn

    const due = Eng.tiersDue(state, step.hours);
    due.crisis = crisis;
    due.reckoning = reckon;
    // Canon events due this span, checked now; broken "diverge" ones are
    // rewritten by the intent call. They are outside the tier rationing.
    const canonDue = E.Timeline.due(state, step.hours);
    due.canon = E.Timeline.diverging(canonDue);
    phase(due.world ? 'The wider world stirs…' : due.regional ? 'Something stirs nearby…' : 'Characters deciding…');
    const intentObj = await E.LLM.chatJSON({
      kind: 'intent', system, user: E.Prompts.intent(state, present, action, step.label, step.id, due),
      maxTokens: 260 + 150 * present.length + 60 * Eng.standeesAt(state, state.characters[state.player].status.location).length + 80 * Eng.agendasDue(state).length + (due.regional ? 120 : 0) + (due.world ? 140 : 0) + 120 * due.canon.length, temperature: 0.7,
    });

    const frame = { startTime: E.fmtTime(state), startLoc: state.characters[state.player].status.location, stepId: step.id, stepLabel: step.label, words: step.words, spanMinutes: Math.round(step.hours * 60) };
    // A new place the player is heading for (task 4-4), built before the
    // moves are resolved; the start-of-turn copy gets it too.
    const siteNotes = [];
    // A new region first (R-6), then a place to arrive at inside it.
    await E.Sites.regionForIntent(state, intentObj, action, pre, phase, siteNotes);
    await E.Sites.forIntent(state, intentObj, action, pre, phase, siteNotes);
    // A trip longer than the step is a journey turn instead (R-2): back to
    // the start of the turn (which has any new place too) and on through the
    // skip machinery, with the destination.
    const journey = Eng.journeyFor(state, intentObj, action, step);
    if (journey && !journey.failed) {
      const log = state.log;
      replaceState(state, Object.assign(pre, { log }));
      const notes = early.guards.map((g) => ({ type: g.type, detail: g.detail })).concat(siteNotes, timelineNotes, [{ type: 'journey', detail: `a trip of ${E.Scenario.sayHours(journey.trip.hours)} is longer than ${step.label}: the turn is the journey (the scene's intent call is set aside)` }]);
      const out = await skipTurn(state, action, phase, { journey, notes });
      out.report = report || { applied: [], rejected: [] };
      return out;
    }
    const res = Eng.resolve(state, intentObj, present, action, step.id, due, { crossingRoll: journey && journey.failed });
    res.guards.unshift(...early.guards);
    // Moving into a hidden region reveals it.
    Eng.revealAround(state, res);
    if (crisis) {
      res.crisisText = crisis.text;
      if (answersCrisis(intentObj, action, crisis)) state.ignored = [];
      else guard(res, 'resolve', 'crisis ignored', `${E.shorten(crisis.text, 80)}: the action didn't deal with it${trustNote(state, sitOut(state, crisis))}`);
    }
    if (reckon) {
      const c = state.characters[reckon.id];
      E.Memory.addFact(state, { about: [c.id, state.player], text: `${c.name} came to confront ${state.characters[state.player].name} about sitting out the emergencies.`, known_by: [c.id, state.player], weight: 2 });
      guard(res, 'resolve', 'reckoning', `${c.name} confronts ${state.characters[state.player].name} after ${reckon.sat.length} emergencies sat out`);
      state.ask = { turn: state.turn, who: c.id, text: `${c.name} came to confront ${state.characters[state.player].name} about sitting out the emergencies.`, reckoning: true };
    }
    askNotes.forEach((n) => guard(res, 'resolve', n.type, n.detail));
    E.Timeline.resolveDue(state, canonDue, intentObj.canon, res);
    tierChanges.forEach((t) => guard(res, 'resolve', 'cast tier', t));
    extraNotes.forEach((t) => guard(res, 'resolve', 'extras', t));
    siteNotes.concat(timelineNotes).forEach((n) => guard(res, 'resolve', n.type, n.detail));
    const before = timeSnapshot(state);
    Eng.advanceTime(state, step.hours, res);
    E.Sites.noteVisit(state, frame.startLoc);
    E.Sites.fade(state).forEach((t) => guard(res, 'resolve', 'site faded', t));
    E.Sites.noteRegionVisit(state, frame.startLoc);
    E.Sites.fadeRegions(state).forEach((t) => guard(res, 'resolve', 'region faded', t));

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
    Eng.noteSeen(state, res, state.turn);
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
  // Pinning from the card: a pinned person stays local (full detail in every
  // prompt) however long they're unseen. Capped at the world's maxLocal so the
  // prompts still fit. Kept through a step-in commit like a correction.
  Eng.setPinned = function (state, id, on) {
    const c = state.characters[id];
    if (!c || id === state.player || !Eng.cast(state).includes(id)) return { error: 'unknown person' };
    const max = Eng.tierRules(state).maxLocal;
    if (on && !c.pinned && Eng.cast(state, { includePlayer: false }).filter((x) => state.characters[x].pinned).length >= max) {
      return { error: `You can pin up to ${max} people. Unpin someone first.` };
    }
    const rec = E.Recorder && E.Recorder.begin('pin', { id, on: !!on });
    if (rec) rec.end();
    const note = applyPin(state, { id, on: !!on });
    if (state.pending) (state.pending.pins = state.pending.pins || []).push({ id, on: !!on });
    return { pinned: !!c.pinned, note };
  };
  function applyPin(state, p) {
    const c = state.characters[p.id];
    c.pinned = p.on;
    if (p.on && c.tier === 'secondary') { c.tier = 'local'; return `${c.name} → local (pinned)`; }
    return `${c.name} ${p.on ? 'pinned' : 'unpinned'}`;
  }

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
