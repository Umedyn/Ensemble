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
      // A need the character doesn't have (needsOff, task G-5) isn't kept at all.
      sc.needs.forEach((n) => {
        if (!E.Scenario.hasNeed(c, n.id)) delete c.needs[n.id];
        else if (c.needs[n.id] == null) c.needs[n.id] = 0.2;
      });
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
    Eng.setAsideJoiners(state);
    Eng.initTiers(state);
    // Standing with each faction, and who belongs to which (task G-6).
    E.Standing.init(state, sc);
    state.extras = {};
    (sc.extras || []).forEach((x) => { state.extras[x.id] = Eng.newExtra(x, 'author', 0); });
    state.standees = {};
    (sc.standees || []).forEach((g) => { state.standees[g.id] = Eng.newStandee(g); });
    // The local map (task 3-3): rooms the player knows, and where they last saw everyone.
    state.seenRooms = Object.values(state.locations).filter((l) => l.seen !== false).map((l) => l.id);
    Eng.initSite(state);
    E.Sites.initAuthored(state);
    state.known = {};
    Eng.knowAll(state, 0);
    Eng.noteSeen(state, null, 0);
    // Starting knowledge becomes private facts; scenario facts are public.
    sc.characterData.filter((c) => !state.waiting[c.id]).forEach((c) =>
      (c.knows || []).forEach((text) =>
        E.Memory.addFact(state, { about: [c.id], text, known_by: [c.id], weight: 2 })
      )
    );
    (sc.facts || []).forEach((text) => E.Memory.addFact(state, { about: [], text, known_by: ['all'], weight: 2 }));
    // The canon timeline (task 5-2): the past becomes facts and chapter zero.
    E.Timeline.seed(state);
    E.Memory.freezeCore(state);
    // Where the player starts counts as reached (task 7-7).
    Eng.noteReached(state);
    if (sc.opening) {
      state.recent = [{ turn: 0, action: null, text: sc.opening }];
      state.log.push({ turn: 0, type: 'scene', text: sc.opening });
    }
    return state;
  };

  // Saves and autosaves from older versions are upgraded one step at a time
  // when loaded. Each step takes a state at version n and returns n + 1.
  Eng.STATE_VERSION = 17;
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
    // Standing (task G-6): older games start neutral with every group, and
    // nobody belongs to one.
    15: (state) => {
      [state, state.pending && state.pending.pre].filter(Boolean).forEach((s) => {
        if (!s.reputation) { s.reputation = {}; (s.factions || []).forEach((f) => { s.reputation[f.id] = { value: 0, why: '', turn: 0 }; }); }
      });
      state.version = 16;
      return state;
    },
    // Scoped facts (task B-0): old facts have no "where", and the header's
    // core starts as the facts an old save has now.
    16: (state) => {
      E.Memory.freezeCore(state);
      const pre = state.pending && state.pending.pre;
      if (pre && pre.facts) pre.factCore = state.factCore.slice();
      state.version = 17;
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
    // A border both sides list (neighbours made two-way) is one way, not two
    // (task 7-1: "Entrepôt (10th) (border) | Entrepôt (10th) (border)").
    const add = (from, e) => {
      const has = out.get(from).some((x) => x.to === e.to && x.kind === e.kind && x.hours === e.hours && JSON.stringify(x.requires) === JSON.stringify(e.requires) && x.risky === e.risky);
      if (!has) out.get(from).push(e);
    };
    list.forEach((r) => (r.routes || []).forEach((x) => {
      if (!x || !out.has(x.to) || x.to === r.id) return;
      const e = S.routeOf(sc, x);
      add(r.id, Object.assign({}, e, { from: r.id }));
      if (!e.oneWay) add(x.to, Object.assign({}, e, { from: x.to, to: r.id }));
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
  // opts.kinds: only routes of these kinds (task 7-7: a wagon company), and
  // the free ways inside a region (borders between its parts); opts.all: the
  // way as if every route were open (the road a party means to take).
  Eng.regionTrip = function (state, from, to, opts) {
    const kinds = opts && Array.isArray(opts.kinds) ? opts.kinds : null;
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
          if (!open(e) || (kinds && !kinds.includes(e.kind) && !(e.kind === 'border' && !e.hours))) return;
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
    const found = search((e) => (opts && opts.all) || legOpen(state, e));
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
    Eng.noteReached(state);
    if (!Eng.hiddenRegions(state).size) return;
    const here = Eng.playerRegion(state);
    if (here && !Eng.regionKnown(state, here)) Eng.revealRegion(state, here, res, 'the player is there');
    (state.facts || []).filter((f) => E.Memory.knows(f, state.player) && !E.Memory.narrated(f)).forEach((f) => Eng.revealNamed(state, f.text, res, 'the player knows a fact about it'));
  };
  // ---------- where the player has been (task 7-7) ----------
  // Every region the player has been in, with the regions it is inside;
  // journeys add the regions their legs went through. Arrival events and the
  // "reached" condition read it.
  Eng.noteReached = function (state, region) {
    const r = region || Eng.playerRegion(state);
    if (!r || !Eng.regionDef(state, r)) return;
    const have = new Set(state.reached || []);
    const before = have.size;
    E.Scenario.regionChainIn(state.scenario.regions, r).forEach((x) => have.add(x));
    if (have.size !== before) state.reached = [...have];
  };
  Eng.hasReached = (state, id) => (state.reached || []).includes(id);
  // Lots built on in a place (task 7-7).
  Eng.builtLots = (state, place) => Object.values(state.locations).filter((l) => l.lot && l.site === place && (state.features || {})[`${l.id}|lot`] === 'built').length;

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
    const kids = (x) => Eng.regionChildren(state, x).filter((k) => Eng.regionKnown(state, k));
    if (!kids(id).length) return { text: 'no one', controller: null, mixed: false };
    // A child with no holder of its own counts for the one group that holds
    // everything inside it, if one does (task 7-1: France → its zones → départements).
    const sole = (x, depth) => {
      if (state.regions[x].controller) return state.regions[x].controller;
      const cs = depth < E.Scenario.REGION_DEPTH ? kids(x).map((k) => sole(k, depth + 1)) : [];
      return cs.length && cs.every((c) => c && c === cs[0]) ? cs[0] : null;
    };
    const counts = new Map();
    kids(id).forEach((k) => { const c = sole(k, 1); counts.set(c, (counts.get(c) || 0) + 1); });
    const held = [...counts.entries()].filter(([c]) => c);
    if (!held.length) return { text: 'no one', controller: null, mixed: false };
    if (held.length === 1 && held[0][1] === kids(id).length) return { text: `${name(held[0][0])} (all of it)`, controller: null, mixed: false };
    return { text: `no single holder (${held.map(([c, n]) => `${name(c)} holds ${n} of ${kids(id).length}`).join(', ')})`, controller: null, mixed: true };
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
    return Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => Eng.isAt(state, id, here));
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
      .filter((id) => Eng.alive(state, id) && Eng.isAt(state, id, loc))
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
    // A group whose faction trusts the player (task G-6) lets them by.
    const trusts = (g) => g.faction && E.Standing.value(state, g.faction) >= E.Standing.TRUSTED;
    if (target && trusts(target)) why.push(`${target.label} trust you (${E.Standing.groupName(state, target.faction)})`);
    else if (target) {
      const m = (STATE_DC[target.state] || 0) + sizeDC(target.count);
      if (m) { mod += m; why.push(`${target.count} ${target.state} ${target.label} +${m}`); }
    }
    // Every room on the way (task 3-6) and the rooms next to them; cameras
    // that are on and watched entrances on the way count too.
    const route = it.moveTo ? Eng.route(state, here, it.moveTo, { who: state.player }) : [here];
    const onRoute = route.length ? route : [here];
    const eyes = Eng.STEALTH_SKILLS.includes(it.skill) ? onRoute.flatMap((r) => Eng.ruleFeatures(state, r).filter((f) => /camera/i.test(f.name) && f.state === 'on').map((f) => `${f.name} in ${state.locations[r].name}`))
      .concat(E.Sites.entrances(state).filter((e) => e.watched && onRoute.includes(e.room)).map((e) => `watched ${e.kind || 'entrance'} in ${state.locations[e.room].name}`)) : [];
    // Worlds with watchers of any kind (groups, cameras, watched entrances).
    const watchful = Object.keys(state.standees || {}).length || E.Sites.entrances(state).some((e) => e.watched) ||
      Object.keys(state.locations).some((r) => Eng.ruleFeatures(state, r).some((f) => /camera/i.test(f.name)));
    if (Eng.STEALTH_SKILLS.includes(it.skill) && watchful) {
      const rooms = new Set(onRoute.flatMap((r) => [r].concat(Eng.linkedRooms(state, r))));
      const watchers = Object.values(state.standees || {}).filter((g) => rooms.has(g.location) && Eng.standeeActive(g) && !trusts(g));
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
    const g = Object.values(state.standees || {}).filter((x) => Eng.standeeActive(x) && x.state !== 'hostile' && (x.location === here || near.has(x.location))
      && !(x.faction && E.Standing.value(state, x.faction) >= E.Standing.TRUSTED))
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
    // A lot (task 7-7) starts staked out.
    Object.values(st.locations || {}).filter((l) => l.lot && st.features[`${l.id}|lot`] == null).forEach((l) => { st.features[`${l.id}|lot`] = 'staked'; });
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
    name: featName(f), state: (state.features || {})[`${room}|${featName(f)}`] ?? null, inferred: !!(f && f.inferred), narrated: !!(f && f.source === 'narration'),
  }));
  // Narrated features (task B-0b) are on the map and in the scene, and never
  // drive rules: conditions, sight, or the check that the player stayed put.
  Eng.ruleFeatures = (state, room) => Eng.features(state, room).filter((f) => !f.narrated);
  Eng.narratedFeature = function (state, key) {
    const i = String(key).indexOf('|');
    return ((state.locations || {})[String(key).slice(0, i)] || { features: [] }).features.some((f) => f && f.source === 'narration' && f.name === String(key).slice(i + 1));
  };
  // Where a tracked feature may go from here (task 7-3): the states it may take
  // and, for each one held back by its "requires", what the scene shows instead.
  // → { states (null: any), blocked: {state: otherwise text} }.
  Eng.featureOptions = function (state, room, name) {
    const f = ((state.locations[room] || {}).features || []).find((x) => x && typeof x === 'object' && x.name === name) || {};
    const blocked = {};
    Object.entries(f.requires || {}).forEach(([to, r]) => {
      if (r && Array.isArray(r.if) && !r.if.every((p) => E.Timeline.holds(state, p))) blocked[to.toLowerCase()] = r.otherwise || '';
    });
    return { states: Array.isArray(f.states) ? f.states.map((x) => String(x).toLowerCase()) : null, blocked, requires: f.requires || {} };
  };
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
    // An authored place (task 7-2) may name its layout style.
    if (site !== E.Sites.HOME) return E.Layouts.plan(E.Sites.rooms(state, site).map((l) => Object.assign({}, l, { links: (l.links || []).filter((k) => k.kind !== 'trip') })), { type: ((state.sites || {})[site] || {}).layout, seed: `${sc.worldId}:${site}` });
    if (!planCache.has(sc)) planCache.set(sc, E.Layouts.plan((sc.locations || []).filter((l) => !l.site), { type: sc.site && sc.site.type, seed: `${sc.worldId}:${sc.startId}` }));
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
    room.features = (room.features || []).concat([{ name, inferred: true, source: 'intent' }]);
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
    Object.values(state.characters || {}).forEach((c) => { if (c.id !== state.player && !c.status.away) state.known[c.id] = { loc: c.status.location, turn }; });
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
      (res.routineMoves || []).forEach((m) => mark(m.id, m.to));
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
    // Away: nowhere on the map, and the card says so in words.
    if (Eng.isAway(state, id)) return { loc: null, turn: k.turn, now: false, away: Eng.awayWords(state.characters[id].status.away) };
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
    (p.res.routineMoves || []).forEach((m) => add(m.id, m.to));
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
  const whereIs =(state, id) => (state.characters[id] ? (state.characters[id].status.away ? null : state.characters[id].status.location) : state.extras && state.extras[id] ? state.extras[id].location : state.standees && state.standees[id] ? state.standees[id].location : null);
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
      else if (c.tier !== 'local' && c.tier !== 'secondary') c.tier = !c.status.away && c.status.location === here ? 'local' : 'secondary';
    });
  };

  // ---------- the scene's foreground (task 7-2) ----------
  // A crowded room (Class 1-B: nine named classmates) can't give everyone an
  // intent on a small context: the prompt and the reply grow with each one
  // (11,000 tokens at 8K). The first sceneFull people of the tier take part
  // this turn: those the player's action names, the one who came to the
  // player, those the last action named, then the locals who feel most
  // strongly about the player, then cast order. The rest are in the
  // background: still present (they see and hear, and can be named next
  // turn), with no intent of their own. → ids in the order of present.
  Eng.sceneFront = function (state, present, action) {
    const cap = E.contextTier().sceneFull;
    if (present.length <= cap) return present.slice();
    const last = (state.recent && state.recent.length && state.recent[state.recent.length - 1].action) || '';
    const ask = state.ask && state.ask.who;
    const score = (id) => {
      const c = state.characters[id];
      return (mentions(action, c) ? 1e6 : 0) + (id === ask ? 1e5 : 0) + (mentions(last, c) ? 1e4 : 0) + (Eng.tier(state, id) === 'local' ? 1e3 : 0)
        + Math.abs(c.relations[state.player] || 0) + Math.abs((state.characters[state.player].relations || {})[id] || 0);
    };
    const keep = new Set(present.map((id, i) => [id, score(id), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, cap).map((x) => x[0]));
    return present.filter((id) => keep.has(id));
  };

  // ---------- people who join later (task 7-2) ----------
  // A character with "joins" (a timeline event id) waits outside the story:
  // not in the cast, the prompts or anyone's feelings until the event happens.
  // Feelings toward them wait with them.
  Eng.setAsideJoiners = function (state) {
    state.waiting = {};
    Object.values(state.characters).forEach((c) => {
      if (c.joins == null || c.id === state.player) return delete c.joins;
      state.waiting[c.id] = c;
      delete state.characters[c.id];
    });
    state.order = state.order.filter((id) => state.characters[id]);
    Object.values(state.characters).forEach((c) => Object.keys(c.relations || {}).forEach((k) => {
      const w = state.waiting[k];
      if (!w) return;
      (w.feltBy = w.feltBy || {})[c.id] = c.relations[k];
      delete c.relations[k];
    }));
  };
  // The event has happened: its people join the cast, as newcomers (the
  // header's live block), where their file puts them. → names.
  Eng.joinStory = function (state, eventId, res) {
    const ids = Object.keys(state.waiting || {}).filter((id) => state.waiting[id].joins === eventId);
    ids.forEach((id) => {
      const c = state.waiting[id];
      delete state.waiting[id];
      delete c.joins;
      Object.entries(c.feltBy || {}).forEach(([k, v]) => { if (state.characters[k]) state.characters[k].relations[id] = v; });
      delete c.feltBy;
      Object.keys(c.relations || {}).forEach((k) => { if (!state.characters[k]) delete c.relations[k]; });
      if (!state.locations[c.status.location]) c.status.location = state.characters[state.player].status.location;
      const here = state.characters[state.player].status.location;
      Object.assign(c, { joined: state.turn, lastSeen: state.turn, tier: c.pinned || c.status.location === here ? 'local' : 'secondary' });
      if (c.groups != null) c.groups = E.Standing.groupsOf(c);
      state.characters[id] = c;
      state.order.push(id);
      (c.knows || []).forEach((text) => E.Memory.addFact(state, { about: [id], text, known_by: [id], weight: 2 }));
      if (res) guard(res, 'resolve', 'joined', `${c.name} joins the story (${eventId})`);
    });
    return ids.map((id) => state.characters[id].name);
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
        if (where !== here || c.status.away) { Eng.storyMove(state, id, here); moved.push(`${c.name} → ${state.locations[here].name}`); }
        where = here;
      } else if (ev && !present.includes(id)) {
        const to = Eng.resolveLocation(state, ev.where, false);
        if (to && to !== where && to !== here) { Eng.storyMove(state, id, to); where = to; moved.push(`${c.name} → ${state.locations[to].name}`); }
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
    if (allowCharacter && state.characters[key]) return whereIs(state, key);
    return null;
  };
  // Whether text names a room: a word of its name that says which room it is
  // ("Lantern", "garage"), not "room" or "the".
  const ROOM_WORDS_SKIP = new Set(['the', 'and', 'room', 'rooms', 'your', 'with', 'from', 'floor', 'side', 'area', 'front', 'back', 'first', 'second', 'third']);
  Eng.namesRoom = function (text, loc) {
    const t = String(text || '').toLowerCase();
    return String(loc && loc.name || '').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3 && !ROOM_WORDS_SKIP.has(w))
      .some((w) => new RegExp(`\\b${w.replace(/'/g, "'?")}(?:s|es)?\\b`).test(t));
  };
  // Where the player means to go, as a room (playtest-seiryo-goes-to-school:
  // "I go to Seiryo High" came back as the region "mito-senba", twice, and
  // the player never left the living room): a room or character as above, a
  // place's id or name (its way in), or a region (the place in it the words
  // name, else its only place). → room id or null.
  Eng.resolvePlace = function (state, v, words) {
    const room = Eng.resolveLocation(state, v, true);
    if (room) return room;
    const key = String(v || '').trim().toLowerCase();
    if (!key) return null;
    const places = Object.values(state.sites || {}).filter((s) => s && s.entry && state.locations[s.entry]);
    const site = places.find((s) => s.id.toLowerCase() === key || String(s.name || '').toLowerCase() === key);
    if (site) return site.entry;
    const region = (state.scenario.regions || []).find((r) => r && (r.id.toLowerCase() === key || String(r.name || '').toLowerCase() === key));
    if (!region || !Eng.regionKnown(state, region.id)) return null;
    const inside = places.filter((s) => s.region && E.Scenario.regionChainIn(state.scenario.regions, s.region).includes(region.id));
    const named = inside.filter((s) => s.name && mentionsName(words, s.name)).sort((a, b) => b.name.length - a.name.length);
    if (named.length) return named[0].entry;
    return inside.length === 1 ? inside[0].entry : null;
  };
  // A place the player's own words go to ("I go to Seiryo High", "head over
  // to the cafe"): a place's name (its way in) or a room's, the player's own
  // place first, then the longest name. → room id or null.
  // A ride counts ("I take the bus to Seiryo High"), and joining people
  // somewhere ("I join the others in the gym"); a room's id is a name too
  // ("gym" for the Gymnasium). playtest-seiryo-bad-model: both stayed home.
  const GO_VERBS = 'go|goes|going|head|heads|heading|walk|walks|run|runs|hurry|return|cycle|make (?:my|our) way|set (?:out|off)|leave|take|takes|taking|catch|catches|ride|rides|drive|drives|travel|travels';
  const GO_TO = `(?:\\b(?:${GO_VERBS})\\b[^.!?]{0,30}?\\b(?:to|into|for|toward|towards)|\\bjoin(?:s|ing)?\\b[^.!?]{0,30}?\\b(?:in|at))\\s+(?:the\\s+)?`;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  Eng.placeInWords = function (state, text) {
    const t = String(text || '');
    const esc = escRe;
    const mine = E.Sites ? E.Sites.playerSite(state) : null;
    const cands = Object.values(state.sites || {}).filter((s) => s && s.entry && state.locations[s.entry] && s.name).map((s) => ({ name: s.name, room: s.entry, site: s.id }))
      .concat(Object.values(state.locations).map((l) => ({ name: l.name, room: l.id, site: l.site })))
      .concat(Object.values(state.locations).filter((l) => l.id.replace(/-/g, ' ') !== String(l.name || '').toLowerCase()).map((l) => ({ name: l.id.replace(/-/g, ' '), room: l.id, site: l.site })))
      .map((c) => Object.assign(c, { name: String(c.name).replace(/^the\s+/i, '').trim() }))
      // A place in a region faded to a stub waits for the region's rebuild.
      .filter((c) => !(c.site && state.sites[c.site] && (Eng.regionDef(state, state.sites[c.site].region) || {}).stub))
      .filter((c) => c.name.length > 2 && new RegExp(GO_TO + esc(c.name) + '(?![\\w])', 'i').test(t));
    cands.sort((a, b) => (b.site === mine) - (a.site === mine) || b.name.length - a.name.length);
    return cands.length ? cands[0].room : null;
  };
  // The player's own rooms: one named from their side ("Your room"), after
  // them ("Sora's room"), or named in their role ("first-year, Class 1-B").
  Eng.ownRooms = function (state) {
    const pc = state.characters[state.player];
    const role = String(pc.role || '').toLowerCase();
    const first = String(pc.name || '').split(/\s+/)[0].toLowerCase();
    return Object.values(state.locations).filter((l) => {
      const n = String(l.name || '').toLowerCase();
      return /^your\s/.test(n) || (first && n.startsWith(first + "'s ")) || (n.length > 3 && new RegExp(`(?:^|[^\\w])${escRe(n)}(?![\\w])`).test(role));
    });
  };
  // "go to class", "head to my room": the one own room with that word in its
  // name. → room id or null. playtest-seiryo-bad-model: "I go to class" went
  // to Class 1-A, and Sora is in 1-B.
  Eng.ownPlaceInWords = function (state, text) {
    const t = String(text || '');
    const first = String(state.characters[state.player].name || '').split(/\s+/)[0].toLowerCase();
    const hits = Eng.ownRooms(state).filter((l) => String(l.name).toLowerCase().replace(/'s\b/g, '').split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !['your', 'the', 'and', first].includes(w))
      .some((w) => new RegExp(`\\b(?:${GO_VERBS})\\b[^.!?]{0,30}?\\b(?:to|into|for)\\s+(?:my\\s+|our\\s+)?${escRe(w)}s?\\b`, 'i').test(t)));
    return hits.length === 1 ? hits[0].id : null;
  };
  // The player's move as a room before anything else reads it: a place or
  // region the intent named, or one the player's words go to. → a note, or null.
  // The place the words name wins over the model's guess at another one
  // (playtest-seiryo-goes-downtown: "I go to Seiryo High" came back as
  // "mito-downtown", and the player ended up in the shopping arcade).
  Eng.placeMove = function (state, intentObj, action) {
    const p = intentObj && intentObj.player;
    if (!p || typeof p !== 'object') return null;
    const named = Eng.placeInWords(state, action);
    // The player's own room wins over the model's guess even next door.
    const own = named ? null : Eng.ownPlaceInWords(state, action);
    const said = named || own;
    const room = typeof p.move_to === 'string' ? Eng.resolveLocation(state, p.move_to, true) : null;
    if (room && (!said || room === said || !own && E.Sites.siteOf(state, said) === E.Sites.siteOf(state, room))) return null;
    const here = state.characters[state.player].status.location;
    const to = said || Eng.resolvePlace(state, p.move_to, action);
    if (!to) return null;
    const was = p.move_to;
    p.new_place = null;
    p.new_region = null;
    if (to === here || E.Sites.siteOf(state, to) === E.Sites.siteOf(state, here) && !said) {
      // Already there: "I go to Seiryo High" from its gate.
      p.move_to = null;
      return was ? { type: 'move dropped', detail: `"${was}": the player is already at ${state.locations[here].name}` } : null;
    }
    p.move_to = to;
    return { type: 'move resolved', detail: `${was ? `"${was}"` : "the player's words"} → ${state.locations[to].name}` };
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
  // The player's move taking someone present along: "with Aoi", "with his
  // family" (those who share the player's family name), "with everyone"
  // (playtest-seiryo-goes-downtown: the family walked Sora to the ceremony
  // while the frame kept them home).
  Eng.takesAlong = function (state, text, c) {
    const pc = state.characters[state.player];
    const family = (x) => String(x.name || '').trim().split(/\s+/).pop().toLowerCase();
    const re = /\b(?:talk\w*|speak\w*|chat\w*|argu\w*|meet\w*|deal\w*|fight\w*|break\w*)?\s*\bwith\s+([^.!?;:]{1,60})/gi;
    let m;
    while ((m = re.exec(String(text || '')))) {
      if (/^\s*(?:talk|speak|chat|argu|meet|deal|fight|break)/i.test(m[0])) continue;
      const g = m[1];
      if (mentions(g, c)) return true;
      if (/\b(?:everyone|everybody|all of them|the others)\b/i.test(g)) return true;
      if (/\b(?:family|parents)\b/i.test(g) && family(c).length > 1 && family(c) === family(pc)) return true;
    }
    return false;
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
      resumed: !!(raw && raw.resumed), // an unfinished trip going on (R-10)
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
  Eng.EVENT_CAP = EVENT_CAP;

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
        if (cl.fixed || cl.stopped) return reject(`${cl.id}: ${cl.stopped ? 'has stopped' : 'only time moves it'}`);
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
        if (E.Sites.generatedCount(state) >= E.Sites.config(state.scenario).maxSites) return reject(`too many places already for "${name}"`);
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
    // Standing (task G-6): how a group regards the player, from what it hears
    // (an event is public, so its group needs no witness). Rationed: two a
    // time, ±15 each.
    reputation: {
      list: true, max: 2,
      apply(state, x, scope, opts) {
        if (!x || !(state.reputation || {})[x.group]) return reject(`unknown group "${x && x.group}" for standing`);
        if (!String(x.reason || '').trim()) return reject(`a change in standing with ${x.group} needs a reason`);
        const lines = E.Standing.change(state, x.group, x.delta, x.reason, { max: E.Standing.EVENT_MAX });
        return lines.length ? lines.join('; ') : null;
      },
    },
    // The player's role in a group: an authored event sets it outright (an
    // election, a coup); the model's events only where standing allows it.
    group_role: {
      list: true, max: 1,
      apply(state, x, scope, opts) {
        if (!x) return reject('no group_role');
        const out = E.Standing.setRole(state, x.group, x.role, x.reason, { force: !!(opts && opts.authored) });
        if (out.error) return reject(out.error);
        return out.length ? out.join('; ') : null;
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
    // Building on a lot (task 7-7): a room marked "lot" in a place becomes what
    // is put up there, {room, name, desc, as} ("as": "tent" first, or "built",
    // the default). Only once someone holds the region (the town is founded),
    // and never on a lot already built on.
    build: {
      list: true, max: 1,
      apply(state, b) {
        const l = b && state.locations[b.room];
        if (!l || !l.lot) return reject(`"${b && b.room}" is not a lot that can be built on`);
        const key = `${l.id}|lot`;
        const was = state.features[key] || 'staked';
        const to = b.as === 'tent' ? 'tent' : 'built';
        if (was === 'built') return reject(`${l.name} is already built on`);
        if (was === to) return reject(`${l.name} is already a tent`);
        const held = l.region && state.regions && state.regions[l.region] && state.regions[l.region].controller;
        const where = (Eng.regionDef(state, l.region) || {}).name || l.region;
        if (!held) return reject(`nobody holds ${where} yet: the town isn't founded`);
        const name = E.shorten(String(b.name || '').replace(/\s+/g, ' ').trim(), 40);
        if (!name) return reject(`no name for what is built on ${l.name}`);
        const before = l.name;
        l.name = name;
        if (String(b.desc || '').trim()) l.desc = E.shorten(String(b.desc).replace(/\s+/g, ' ').trim(), 240);
        state.features[key] = to;
        return `${where}: ${name} ${to === 'tent' ? 'goes up in canvas' : 'is built'} (${before})`;
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
  // opts.authored: an authored canon event as written, which the per-event
  // limits don't ration (task 7-1: occupying a zone hands over 40 départements
  // at once); the model's events and versions keep them.
  Eng.AUTHORED_MAX = 200;
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
        const max = opts && opts.authored ? Eng.AUTHORED_MAX : h.max;
        items = v.slice(0, max);
        if (v.length > max) no(key, `only ${max} allowed, dropped ${v.length - max}`);
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
    let answered = false;
    raw.forEach((ev) => {
      if (!ev || typeof ev.text !== 'string' || !ev.text.trim() || /^one sentence$/i.test(ev.text.trim())) return;
      const scope = ['regional', 'world'].includes(ev.scope) ? ev.scope : 'local';
      // A group answering the player's orders (task G-6): one event, outside the
      // caps (the player made it happen), its effects rationed as for any event.
      const answer = ev.faction && res.orders && ev.faction === res.orders.group && !answered;
      if (ev.faction && !answer) return guard(res, 'resolve', 'event dropped', `no orders for ${ev.faction} to answer: ${ev.text}`);
      if (answer) answered = true;
      else if (used[scope] >= caps[scope]) return guard(res, 'resolve', 'event dropped', `${scope} event not due or over the cap: ${ev.text}`);
      else used[scope]++;
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
        Eng.storyMove(state, m.id, to);
        moved.push(`${state.characters[m.id].name} → ${state.locations[to].name}`);
      });
      // Hidden big events stay hidden: no public status changes, only private knowledge.
      const effects = (scope !== 'local' || answer) && vis !== 'hidden' ? applyEffects(state, ev.effects, scope, res) : [];
      const region = eventRegion(state, ev, scope, res);
      if (scope !== 'local' && !answer) state.tierLast[scope] = absHours(state);
      if (answer) guard(res, 'resolve', 'orders answered', `${E.Standing.groupName(state, ev.faction)}: ${text}`);
      const tag = scope === 'local' ? '' : `[${scope}] `;
      if (vis === 'hidden') {
        if (who.length) E.Memory.addFact(state, { about: who, text, known_by: who, weight: 2 });
      } else {
        // A public event somewhere hidden, or naming it, makes it known (R-5).
        if (region && !Eng.regionKnown(state, region)) Eng.revealRegion(state, region, res, 'a public event happens there');
        Eng.revealNamed(state, text, res, 'a public event names it');
        res.events.push((vis === 'heard' ? '(heard from elsewhere; only a sound, call or message reaches the player) ' : '') + tag + text);
        if (scope !== 'local') {
          E.Memory.addFact(state, { about: who, text, known_by: ['all'], weight: scope === 'world' ? 3 : 2, where: scope === 'regional' ? region : null });
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
    // People in the background of a crowded room (task 7-2) were asked for no
    // intent: they carry on quietly, and whatever the model gave them anyway is set aside.
    const front = (opts && opts.front) || present;
    if (front.length < present.length) res.front = front.slice();
    present.forEach((id) => list.push(front.includes(id) ? cleanIntent(state, given.find((g) => g && g.id === id), id)
      : Object.assign(cleanIntent(state, null, id), { missing: false, background: true, action: 'stays in the background' })));
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
    // Orders to a group (task G-6): a leader orders, a favored player asks; the
    // group answers with one event of its own this turn (applyEvents). Anyone
    // else's orders are only words.
    const ord = intentObj.player && intentObj.player.orders;
    if (ord && typeof ord === 'object' && ord.group) {
      const role = E.Standing.roleOf(state, ord.group);
      if (!(state.reputation || {})[ord.group]) guard(res, 'resolve', 'orders refused', `unknown group "${ord.group}"`);
      else if (role !== 'leader' && role !== 'favored') guard(res, 'resolve', 'orders refused', `${state.characters[state.player].name} has no say in ${E.Standing.groupName(state, ord.group)} (${role || 'not a member'}): only words`);
      else {
        res.orders = { group: ord.group, order: E.clip(String(ord.order || actionText), 200), kind: role === 'leader' ? 'order' : 'request' };
        guard(res, 'resolve', 'orders', `${E.Standing.groupName(state, ord.group)}: ${res.orders.kind} "${res.orders.order}"`);
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
      // A longer trip the player's words set out on goes as far as the step
      // allows (R-10, the travel plan below).
      if (t && !t.blocked && t.hours > E.stepHours(state, stepId).hours && !p.resumed && !Eng.travelWanted(state, actionText, p.moveTo)) {
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
      // A trip the words set out on (R-10: "Jo and I take the train to the city square") or go on with.
      const statesMove = PLAYER_MOVES.test(String(actionText || '')) || about.some(goingThere) || p.resumed || (SETS_OUT.test(String(actionText || '')) && Eng.travelWanted(state, actionText, p.moveTo)) ||
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
      // Just "says" (a Seiryo reroll) reads badly in RESOLVED: "Kenji: says → happens".
      if (it.says && /^(says?|speaks?|talks?|replies|answers)\.?$/i.test(String(it.action || '').trim())) it.action = 'speaks up';
      const o = { id: it.id, action: it.action, says: it.says, reveals: it.reveals, missing: it.missing, visible: it.visible, skill: it.skill, roll: null, moved: null };
      if (it.background) o.background = true;
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
      if (it.id !== state.player && !it.moveTo && outcomes[0] && outcomes[0].moved
        && (Eng.comesAlong(state, `${it.action} ${it.says || ''}`) || Eng.takesAlong(state, outcomes[0].action, c))) {
        it.moveTo = outcomes[0].moved;
        guard(res, 'resolve', 'came along', `${c.name} goes with ${state.characters[state.player].name}`);
      }
      // The player's own move follows a travel plan (R-10): as far as the
      // step goes, stopping before a locked door or a closed route.
      if (it.id === state.player && it.moveTo && it.moveTo !== c.status.location && !failed && !it.viaRoom) {
        travelMove(state, it, o, res, stepId);
        outcomes.push(o);
        return;
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
          Eng.storyMove(state, it.id, it.moveTo);
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
  // ---------- routines (task G-7) ----------
  // Where people usually are, hour by hour. A character's `routine` names one
  // of the world's `routines`: { dayTypes: { school: { days, dates, except,
  // default } }, slots: { school: [{ from, to, at }] } }, or a plain slots list
  // for a world where every day is alike. Their own `slots` come first; their
  // `places` fill in the place words (`home`, `class`; null: away, off the map).
  const routineOf = (state, c) => (c && c.routine && (state.scenario.routines || {})[c.routine]) || null;
  // Today's type of day for a routine: named dates, then weekdays, then the default.
  Eng.dayType = function (state, routine, day) {
    const types = Object.entries(routine.dayTypes || {});
    if (!types.length) return null;
    if (types.length === 1) return types[0][0];
    const sc = state.scenario;
    const within = (list) => (list || []).some((r) => {
      const from = E.dayOfDate(sc, typeof r === 'string' ? r : r.from), to = E.dayOfDate(sc, typeof r === 'string' ? r : r.to);
      return from != null && to != null && day >= from && day <= to;
    });
    const date = E.dateOfDay(sc, day);
    const weekday = date ? date.weekday.slice(0, 3).toLowerCase() : null;
    const open = types.filter(([, t]) => !within(t.except));
    const hit = open.find(([, t]) => within(t.dates))
      || open.find(([, t]) => (t.days || []).some((d) => String(d).slice(0, 3).toLowerCase() === weekday))
      || open.find(([, t]) => t.default);
    return hit ? hit[0] : null;
  };
  const slotList = (slots, type) => (Array.isArray(slots) ? slots : (slots && slots[type]) || []);
  // The slot that holds an hour: one begun today, else one wrapping past
  // midnight from yesterday. A person's own slots come before the routine's.
  // → { slot, day (the day it began), key } or null.
  Eng.routineSlot = function (state, id, time) {
    const c = state.characters[id];
    const routine = routineOf(state, c);
    if (!routine) return null;
    const hour = Math.floor(time.hour);
    const lists = (day) => { const type = Eng.dayType(state, routine, day); return [slotList(c.slots, type), slotList(routine.slots, type)]; };
    const today = lists(time.day), yesterday = lists(time.day - 1);
    const begun = (s) => (s.from < s.to ? hour >= s.from && hour < s.to : hour >= s.from);
    const wrapped = (s) => s.from > s.to && hour < s.to;
    for (let i = 0; i < 2; i++) {
      const s = today[i].find(begun);
      const y = s ? null : yesterday[i].find(wrapped);
      if (s || y) return { slot: s || y, day: s ? time.day : time.day - 1, key: `${s ? time.day : time.day - 1}:${(s || y).from}-${(s || y).to}` };
    }
    return null;
  };
  const hashText = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return h >>> 0; };
  // What a place in a slot means for this person: { room }, { away: word }, or
  // null (a word they don't have, a room this start doesn't have).
  function routinePlace(state, id, place) {
    const c = state.characters[id];
    const own = !!c.places && Object.prototype.hasOwnProperty.call(c.places, place);
    if (own && c.places[place] == null) return { away: place, own };
    let room = own ? c.places[place] : place;
    // A made character's class: the room their role names (the way Eng.ownRooms finds it).
    if (!own && place === 'class' && id === state.player) {
      const role = String(c.role || '').toLowerCase();
      room = (Eng.ownRooms(state).find((l) => role.includes(String(l.name).toLowerCase())) || {}).id;
    }
    return state.locations[room] ? { room, own } : null;
  }
  // The choice among a slot's places: fixed for the person and the day, never
  // dice, so reroll, undo and replays agree. The player's is their own entry,
  // else the first listed.
  function routineTarget(state, id, time) {
    const at = Eng.routineSlot(state, id, time);
    if (!at) return null;
    const places = (at.slot.at || []).map((p) => routinePlace(state, id, p)).filter(Boolean);
    if (!places.length) return null;
    const place = id === state.player ? places.find((p) => p.own) || places[0] : places[hashText(`${id}|${at.day}|${at.slot.from}`) % places.length];
    return Object.assign({ key: at.key }, place);
  }
  // Where someone should be at a time, whether or not they are following it:
  // a room id, 'away', or null (no routine, or none for this hour).
  Eng.routineAt = function (state, id, time) {
    const t = routineTarget(state, id, time);
    return !t ? null : t.away ? 'away' : t.room;
  };

  // Breaking routine is a clue (task B-1): someone who should be in the room
  // the scene ends in and is in none of their slot's places, or someone here
  // whose slot has them elsewhere. Says that and nothing of why: at most one
  // a scene, once a person a slot, three turns apart, people with an agenda
  // or a secret first. Only people the player has seen, and only what a card
  // would tell them. → { id, kind, room, line, fact } or null.
  Eng.NOTICE_GAP = 3;
  Eng.routineBreak = function (state, res, presentStart) {
    const notes = state.routineNoticed || { turn: -Infinity, seen: {} };
    if (state.turn - notes.turn < Eng.NOTICE_GAP) return null;
    const here = state.characters[state.player].status.location;
    const room = state.locations[here];
    const touched = new Set((res.routineMoves || []).map((m) => m.id).concat(Object.keys(res.staying || {}), state.ask ? [state.ask.who] : []));
    (res.outcomes || []).forEach((o) => { if (o.moved) touched.add(o.id); });
    // What the player was shown explains itself.
    (res.director || []).filter((d) => d.visibility !== 'hidden').forEach((d) => (d.who || []).forEach((id) => touched.add(id)));
    const known = (id) => state.characters[id].status.health !== 'dead'
      || !Eng.knownAbout(state, id).some((f) => /\b(dead|died|dies|killed)\b/i.test(f.text));
    const found = [];
    Eng.cast(state, { includePlayer: false }).forEach((id) => {
      const c = state.characters[id];
      const at = Eng.routineSlot(state, id, state.time);
      if (!at || at.slot.private || touched.has(id) || !(state.known || {})[id] || !known(id) || notes.seen[id] === at.key) return;
      // Where the story began them, or a day still catching up with the clock: no reason of note.
      const rs = c.routineState;
      if (!rs || rs.seeded || rs.trip || (rs.slot !== at.key && !routinePaused(state, id))) return;
      const places = (at.slot.at || []).map((p) => routinePlace(state, id, p)).filter(Boolean);
      const usual = c.status.away ? places.some((p) => p.away) : places.some((p) => p.room === c.status.location);
      if (usual || !places.length) return;
      if (places.some((p) => p.room === here)) found.push({ id, key: at.key, kind: 'absence' });
      else if (Eng.isAt(state, id, here) && !presentStart.includes(id)) found.push({ id, key: at.key, kind: 'presence' });
    });
    if (!found.length) return null;
    const rank = (x) => { const c = state.characters[x.id]; return activeAgenda(c) ? 0 : c.secret ? 1 : 2; };
    const pick = found.slice().sort((a, b) => rank(a) - rank(b))[0];
    const name = state.characters[pick.id].name;
    state.routineNoticed = { turn: state.turn, seen: Object.assign(notes.seen, { [pick.id]: pick.key }) };
    const absent = pick.kind === 'absence';
    return {
      id: pick.id, kind: pick.kind, room: here,
      line: absent ? `${name} isn't here, though they usually are at this hour.` : `${name} is here, which isn't usual at this hour.`,
      fact: absent ? `${name} wasn't in ${room.name} on ${E.fmtTime(state)}, though they usually are.` : `${name} was in ${room.name} on ${E.fmtTime(state)}, which isn't usual.`,
    };
  };

  // Off the map: `location` stays the room they left by, and they are nowhere.
  Eng.isAway = (state, id) => !!(state.characters[id] && state.characters[id].status.away);
  Eng.isAt = (state, id, room) => state.characters[id].status.location === room && !state.characters[id].status.away;
  Eng.awayWords = (word) => ({ home: 'at home', bed: 'at home', work: 'at work', school: 'at school' }[word] || 'away');
  // Someone's usual day in words, for their card (task G-9): today's slots in
  // order, private ones left out. → "8–12 Class 1-B; 12–13 Cafeteria or Courtyard", or null.
  Eng.routineWords = function (state, id, day) {
    const c = state.characters[id];
    const today = day ?? state.time.day;
    const seen = new Map();
    for (let hour = 0; hour < 24; hour++) {
      const at = Eng.routineSlot(state, id, { day: today, hour });
      if (at && at.day === today && !at.slot.private) seen.set(at.key, at.slot);
    }
    const parts = [...seen.values()].sort((a, b) => a.from - b.from).map((s) => {
      const names = [...new Set((s.at || []).map((p) => routinePlace(state, id, p)).filter(Boolean).map((p) => (p.away ? Eng.awayWords(p.away) : state.locations[p.room].name)))];
      const said = names.length > 3 ? `${names.slice(0, 3).join(', ')} or elsewhere` : names.join(' or ');
      return said ? { from: s.from, to: s.to, said } : null;
    }).filter(Boolean);
    const merged = [];
    parts.forEach((p) => { const last = merged[merged.length - 1]; if (last && last.said === p.said && last.to === p.from) last.to = p.to; else merged.push(Object.assign({}, p)); });
    return c && merged.length ? merged.map((p) => `${p.from}–${p.to} ${p.said}`).join('; ') : null;
  };
  // Where someone is, in words for a prompt: "in the Commons", "at home".
  Eng.inWords = function (state, id) {
    const c = state.characters[id];
    if (c.status.away) return Eng.awayWords(c.status.away);
    const loc = state.locations[c.status.location];
    return `in ${loc ? loc.name : c.status.location}`;
  };
  // Every move of a person goes through here: it brings them back from away.
  Eng.setLocation = function (state, id, room) {
    const c = state.characters[id];
    c.status.location = room;
    delete c.status.away;
  };
  // A move the story made before the step's time passes: it holds even when
  // a new slot begins during that step.
  Eng.storyMove = function (state, id, room) {
    Eng.setLocation(state, id, room);
    if (state.characters[id].routine) state.characters[id].routineHold = true;
  };
  // Routines stop for the badly hurt, a person whose needs have given out, and
  // an open emergency around them (a pressure firing opens one too).
  function routinePaused(state, id, beforeFire) {
    const c = state.characters[id];
    if (c.status.health === 'badly_hurt') return true;
    // Given out: they miss this slot and rest, then pick their day up again.
    if (state.scenario.needs.some((n) => E.Scenario.hasNeed(c, n.id) && (c.needs[n.id] || 0) >= 1)) { c.routineRest = true; return true; }
    return !beforeFire && !!(state.crisis && state.crisis.turn >= state.turn - 1 && (state.crisis.who || []).includes(id));
  }
  // People here whose routine takes them elsewhere during a span (task G-8):
  // [{ id, to (null: off the map), at (minutes in) }]. Moves nothing.
  Eng.routineLeaving = function (state, present, hours) {
    const here = state.characters[state.player].status.location;
    const start = state.time.day * 24 + state.time.hour;
    const out = [];
    present.filter((id) => routineOf(state, state.characters[id])).forEach((id) => {
      let key = (state.characters[id].routineState || {}).slot;
      if (key === undefined) key = (Eng.routineSlot(state, id, state.time) || {}).key;
      for (let h = Math.floor(start) + 1; h <= Math.floor(start + hours); h++) {
        const t = routineTarget(state, id, { day: Math.floor(h / 24), hour: h % 24 });
        if (!t || t.key === key) continue;
        key = t.key;
        if (t.room === here) continue;
        out.push({ id, to: t.away ? null : t.room, at: Math.round((h - start) * 60) });
        break;
      }
    });
    return out;
  };
  // Who keeps their place in the scene through a new slot: { id: why }. The
  // player dealing with them (this turn or the last), an ask they brought, an
  // event here they are part of, and what the scene demands of anyone: a
  // hostile group here, someone badly hurt. Anything else that needs them
  // (a fight to break up) is the model's `stays_for`, only for people leaving.
  Eng.routineStaying = function (state, action, present, res, intents, leaving) {
    const here = state.characters[state.player].status.location;
    const out = {};
    const stay = (id, why) => { if (!out[id]) out[id] = why; };
    const people = present.filter((id) => routineOf(state, state.characters[id]) && Eng.isAt(state, id, here));
    const named = people.filter((id) => mentions(action, state.characters[id]));
    const last = state.routineEngaged && state.routineEngaged.turn === state.turn - 1 ? state.routineEngaged.ids : [];
    named.forEach((id) => stay(id, 'the player is dealing with them'));
    people.filter((id) => last.includes(id)).forEach((id) => stay(id, 'still with the player'));
    if (state.ask && people.includes(state.ask.who)) stay(state.ask.who, 'came to the player');
    (res.director || []).filter((d) => d.visibility === 'seen' && d.where === here).forEach((d) => (d.who || []).filter((id) => people.includes(id)).forEach((id) => stay(id, 'part of what is happening here')));
    const hostile = Object.values(state.standees || {}).some((g) => g.location === here && g.state === 'hostile' && Eng.standeeActive(g));
    const hurt = [state.player].concat(present).find((id) => state.characters[id].status.health === 'badly_hurt' && (id === state.player || Eng.isAt(state, id, here)));
    if (hostile || hurt) people.forEach((id) => stay(id, hostile ? 'danger here' : `${state.characters[hurt].name} needs help`));
    const due = new Set(leaving.map((l) => l.id));
    (Array.isArray(intents) ? intents : []).forEach((it) => {
      if (!it || !due.has(it.id) || !people.includes(it.id) || typeof it.stays_for !== 'string') return;
      const why = it.stays_for.trim();
      if (why && !/^(null|none|no|n\/a)$/i.test(why)) stay(it.id, E.clip(why, 80));
    });
    leaving.filter((l) => out[l.id]).forEach((l) => guard(res, 'resolve', 'stays', `${state.characters[l.id].name} misses their routine: ${out[l.id]}`));
    if (people.length) state.routineEngaged = { turn: state.turn, ids: named };
    return out;
  };
  // Handing the hours to routine, in the player's own words (rule 3). Not
  // ROUTINE_PLAN: a skip's plan has no deed in it, a turn's action might
  // ("I check the shift logs").
  const HANDS_DAY = new RegExp('\\b(?:sit through|sit in (?:on )?(?:class|lessons?|the)|go about (?:my|our|the) (?:day|business)|get through (?:the|my) (?:day|classes|lessons|shift)'
    + '|attend (?:my |the )?(?:classes|class|lessons|school|work)|(?:until|till|through|for) the (?:end|rest) of the (?:school |work )?(?:day|shift|lessons?|classes)'
    + '|(?:keep to|stick to|follow|go about|get on with|carry on with|do)\\b[^.!?]{0,20}\\b(?:routine|usual|chores|duties|shift))\\b', 'i');
  const sayMinutes = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`);
  Eng.sayDay = (day) => day.stops.map((s) => `${s.name} +${sayMinutes(s.at)}`).join('; ');
  // The player's day on their routine, planned like a trip (task G-8): the
  // stops with their minutes, getting to the first in time when it can. An
  // action naming a person or another place wins, and the routine waits. A
  // clock going off ends the day there. → { stops, via, end, stopped } or null.
  Eng.routineDay = function (state, action, step, crisis) {
    const pid = state.player;
    if (!routineOf(state, state.characters[pid]) || step.id === 'major' || !(step.hours >= 1) || state.travel || crisis || !HANDS_DAY.test(String(action || ''))) return null;
    if (Eng.cast(state, { includePlayer: false }).some((id) => mentions(action, state.characters[id]))) return null;
    const span = Math.round(step.hours * 60);
    const fire = Math.min(...state.clocks.filter((c) => !c.fired && !c.stopped && c.perHour > 0).map((c) => (c.max - c.value) / c.perHour * 60), Infinity);
    const limit = Math.min(span, fire);
    const start = state.time.day * 24 + state.time.hour;
    let room = state.characters[pid].status.location, free = 0, key = null;
    const stops = [], via = [];
    for (let h = Math.floor(start); h < start + step.hours; h++) {
      const t = routineTarget(state, pid, h === Math.floor(start) ? state.time : { day: Math.floor(h / 24), hour: h % 24 });
      if (!t || t.key === key) continue;
      key = t.key;
      if (t.away) break; // the player stays on the map
      if (t.room === room) { if (!stops.length) stops.push({ room, name: state.locations[room].name, at: 0 }); continue; }
      const plan = Eng.travelPlan(state, room, t.room, pid);
      if (!plan || plan.blocked) break;
      const at = Math.round(Math.max(free, (h - start) * 60 - plan.minutes) + plan.minutes);
      if (at > limit) break;
      via.push(...plan.steps.map((s) => s.to));
      room = t.room;
      free = at;
      stops.push({ room, name: state.locations[room].name, at });
    }
    const placed = Eng.placeInWords(state, action) || Eng.placeNamed(state, action);
    if (!stops.length || (placed && !stops.some((s) => s.room === placed))) return null;
    return { stops, via: via.slice(0, -1), end: room, stopped: fire < span };
  };
  // One whole hour for one person. A routine only moves someone when a new
  // slot begins or a trip is under way, so anything else that moved them keeps
  // that place until the next slot without having to say so.
  function routineHour(state, id, time, res, minutes) {
    const c = state.characters[id];
    const was = c.status.away ? null : c.status.location;
    routineStep(state, id, time, res);
    const now = c.status.away ? null : c.status.location;
    const here = state.characters[state.player].status.location;
    // What the player can see: someone leaving their room or coming into it.
    if (was !== now && (was === here || now === here)) res.routineMoves.push({ id, to: now, at: minutes });
  }
  function routineStep(state, id, time, res) {
    const c = state.characters[id];
    const t = routineTarget(state, id, time);
    if (!t) return;
    const rs = c.routineState;
    if (c.routineHold) { rs.slot = t.key; delete rs.trip; return; }
    const newSlot = rs.slot !== t.key;
    if (!newSlot && !rs.trip) return;
    if (!newSlot && c.status.location !== rs.left) { delete rs.trip; return; } // the story took them off their way
    if (routinePaused(state, id, res.beforeFire) || (res.staying || {})[id]) return;
    const walked = !newSlot && rs.trip ? rs.trip.minutes : 0;
    rs.slot = t.key;
    delete rs.seeded;
    delete rs.trip;
    if (t.away) { c.status.away = t.away; rs.left = c.status.location; return; }
    const from = c.status.location;
    const plan = from === t.room ? null : Eng.travelPlan(state, from, t.room, id);
    if (from === t.room) delete c.status.away;
    else if (!plan || plan.blocked || Eng.moveProblem(state, id, from, t.room)) rs.trip = { to: t.room, minutes: 0 }; // tried again next hour
    else {
      // A trip longer than the hour waits in the last room reached, and goes on.
      const reach = Eng.travelReach(plan, walked + 60);
      Eng.setLocation(state, id, reach.room);
      if (!reach.arrived) rs.trip = { to: t.room, minutes: walked + 60 - reach.at };
    }
    rs.left = c.status.location;
  }
  // Each whole hour between two times, for everyone offscreen with a routine.
  function runRoutines(state, people, before, res, fireIn) {
    const start = before.day * 24 + before.hour;
    const end = state.time.day * 24 + state.time.hour;
    res.routineMoves = [];
    for (let h = Math.floor(start) + 1; h <= Math.floor(end); h++) {
      const time = { day: Math.floor(h / 24), hour: h % 24 };
      // The hours before a pressure went off in this step ran as usual.
      res.beforeFire = h - start < fireIn;
      people.forEach((id) => { if (Eng.alive(state, id)) routineHour(state, id, time, res, Math.round((h - start) * 60)); });
    }
    delete res.beforeFire;
    people.forEach((id) => { delete state.characters[id].routineHold; });
  }

  Eng.advanceTime = function (state, hours, res, routine) {
    const clockBefore = { day: state.time.day, hour: state.time.hour };
    const here = state.characters[state.player].status.location;
    const onRoutine = Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => routineOf(state, state.characters[id]));
    // Where they stand when a routine first sees them holds until the next slot.
    onRoutine.forEach((id) => {
      const c = state.characters[id];
      if (!c.routineState) c.routineState = { slot: (Eng.routineSlot(state, id, clockBefore) || {}).key || null, left: c.status.location, seeded: true };
    });
    state.time.hour += hours;
    while (state.time.hour >= 24) { state.time.hour -= 24; state.time.day += 1; }
    const climb = (routine && routine.climb) || [];
    state.scenario.needs.forEach((n) => {
      Eng.cast(state, { alive: true }).forEach((id) => {
        const c = state.characters[id];
        if (!E.Scenario.hasNeed(c, n.id)) return; // a need this character doesn't have (task G-5)
        const v = c.needs[n.id] || 0;
        const unmet = id === state.player && climb.includes(n.id);
        // People in the background live their routine: needs settle, not climb.
        const settles = !unmet && (routine || Eng.tier(state, id) === 'secondary' || (onRoutine.includes(id) && (c.routineRest || (!Eng.isAt(state, id, here) && (c.needs[n.id] || 0) < 1))));
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
    onRoutine.forEach((id) => { delete state.characters[id].routineRest; });
    Eng.stopClocks(state, res);
    const crisisBefore = state.crisis;
    const fireIn = Math.min(...state.clocks.filter((cl) => !cl.fired && !cl.stopped && cl.perHour > 0).map((cl) => (cl.max - cl.value) / cl.perHour), Infinity);
    state.clocks.slice().forEach((cl) => {
      if (cl.fired || cl.stopped) return;
      cl.value = E.clamp(cl.value + (cl.perHour || 0) * hours, 0, cl.max);
      if (cl.value >= cl.max) Eng.fireClock(state, cl, res);
    });
    fadeRegionTags(state, res);
    // Downtime runs agendas itself (Eng.runAgendas), step by step.
    if (!routine) advanceAgendas(state, hours);
    advancePatrols(state, hours);
    if (onRoutine.length) runRoutines(state, onRoutine, clockBefore, res, state.crisis !== crisisBefore ? fireIn : 0);
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
    return Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => !Eng.isAway(state, id) && E.Sites.siteOf(state, state.characters[id].status.location) === site);
  };
  Eng.openCrisis = (state) => (state.crisis && state.crisis.turn === state.turn ? state.crisis : null);

  // Pressures still in play: those that haven't gone off, and one that went off
  // this turn. After that it lives on as a fact and in the journal, not in the
  // Situation panel or the prompts (playtest-coffee-skips: six "(HAPPENED)" by Sol 328).
  Eng.liveClocks = (state) => state.clocks.filter((c) => (!c.fired && !c.stopped) || c.firedTurn === state.turn);
  // A pressure with "stopIf" stops for good once its conditions all hold
  // (task 7-3: the reactor shut down before it blows): it never moves or goes
  // off again. → the names of those that stopped now.
  Eng.stopClocks = function (state, res) {
    const out = [];
    state.clocks.forEach((cl) => {
      if (cl.fired || cl.stopped || !Array.isArray(cl.stopIf) || !cl.stopIf.length) return;
      if (!cl.stopIf.every((p) => E.Timeline.holds(state, p))) return;
      cl.stopped = true;
      cl.stoppedTurn = state.turn;
      out.push(cl.name);
      if (res) guard(res, 'resolve', 'clock stopped', `${cl.name}: ${cl.stopIf.map((p) => E.Timeline.say(state, p)).join('; ')}`);
    });
    return out;
  };

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
        .filter((id) => cl.fireHarm === 'all' || (!Eng.isAway(state, id) && (state.locations[state.characters[id].status.location] || {}).outside));
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
  const CARE = /\b(treat|medic|doctor|bandage|stitch|heal|patch me|first aid|med ?bay|infirmary|hospital)/;
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
    const pc = state.characters[state.player];
    // Only the needs the player has (task G-5): a robot's plan needn't say it eats.
    return state.scenario.needs.map((n) => n.id).filter((id) => { const lim = Eng.needLimit(state, id); return E.Scenario.hasNeed(pc, id) && lim && !lim.relief.test(t); });
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
  // opts.covered: a routine that covers the body's needs (a camp that travels).
  Eng.planMajorSkip = function (state, action, opts) {
    const plan = planWorldStop(state);
    const body = opts && opts.covered ? null : bodyStop(state, action);
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
    const clocks = E.clone(state.clocks).filter((c) => !c.fired && !c.stopped);
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
    const out = first ? { hours: canon.hours, reason: 'canon', canon } : plan;
    // An ending set for a time stops the skip there, before anything later.
    const end = Eng.nextEndingTime(state);
    return end && end.hours > 0 && end.hours < out.hours ? { hours: end.hours, reason: 'ending', ending: end.id } : out;
  };

  // ---------- endings ----------
  // A world or start may say how the story can end: "endings": [{ id, title,
  // kind (win, loss, bittersweet, neutral), when, if, epilogue }]. "when" is
  // what the engine checks itself ({event}: a timeline event happened; {after:
  // {day, hour}}; {clock}: a pressure came to a head) or what the model judges
  // from the scene ({judged: "the player gets out of the city"}, ruled on in
  // the memory update with a quote the engine finds in the scene); "if" is a
  // list of timeline preconditions that must hold too (an ending with only
  // "if" fires as soon as they all do). An engine ending is checked after
  // each turn's events, so its scene closes the story; a judged one is found
  // when the next action commits the scene, and a short closing scene plays
  // instead of that action. The story then stops, like a death, until the
  // player chooses to keep playing.
  Eng.ENDING_KINDS = ['win', 'loss', 'bittersweet', 'neutral'];
  const isObjE = (v) => v && typeof v === 'object' && !Array.isArray(v);
  // The "endings" list and the timeline events and pressures marked as endings.
  Eng.endingsOf = (state) => E.Scenario.allEndings(state.scenario).filter(isObjE);
  const endingOpen = (state, e) => !(state.endingsReached || []).includes(e.id) && (!Array.isArray(e.if) || e.if.every((p) => E.Timeline.holds(state, p)));
  // Hours until the next ending set for a time: { id, hours } or null.
  Eng.nextEndingTime = function (state) {
    const now = absHours(state);
    const next = Eng.endingsOf(state).filter((e) => isObjE(e.when) && isObjE(e.when.after) && !(state.endingsReached || []).includes(e.id))
      .map((e) => ({ id: e.id, hours: E.Timeline.at(e.when.after) - now })).filter((x) => x.hours > 0).sort((a, b) => a.hours - b.hours);
    return next[0] || null;
  };
  // The story stopped at an ending the player hasn't chosen to go past.
  Eng.ended = (state) => !!(state.ending && !state.ending.continued);
  // Engine endings, checked after a turn's (or a skip's) events: the first
  // that holds is reached. → the ending, or null.
  Eng.checkEndings = function (state, res, extra) {
    if (state.flags.gameOver || Eng.ended(state)) return null;
    const now = absHours(state);
    for (const e of Eng.endingsOf(state)) {
      const w = isObjE(e.when) ? e.when : {};
      if (w.judged || !endingOpen(state, e)) continue;
      let why;
      if (w.event) {
        const c = state.canon && state.canon[w.event];
        if (!c || c.status === 'dropped' || c.status === 'past') continue;
        why = `the timeline event "${w.event}" happened`;
      } else if (w.after) {
        if (now < E.Timeline.at(w.after)) continue;
        why = `it is past ${E.Timeline.fmt(state.scenario, w.after)}`;
      } else if (w.clock) {
        const cl = (state.clocks || []).find((c) => c.id === w.clock);
        if (!cl || !cl.fired) continue;
        why = `"${cl.name}" came to a head`;
      } else if (w.reach) {
        // The player got there: the room itself, or anywhere inside the region.
        const here = state.characters[state.player].status.location;
        const region = Eng.regionOf(state, here);
        if (here !== w.reach && !(region && Eng.regionChain(state, region).includes(w.reach))) continue;
        const def = state.locations[w.reach] || Eng.regionDef(state, w.reach) || {};
        why = `the player reached ${def.name || w.reach}`;
      } else if (Array.isArray(e.if) && e.if.length) {
        why = 'all of: ' + e.if.map((p) => E.Timeline.say(state, p)).join('; ');
      } else continue;
      return Eng.reachEnding(state, e, why, res, extra);
    }
    return null;
  };
  // An ending reached: recorded once, as a public fact, and on the turn.
  Eng.reachEnding = function (state, e, why, res, extra) {
    state.endingsReached = (state.endingsReached || []).concat(e.id);
    state.ending = Object.assign({ id: e.id, title: e.title || e.id, kind: Eng.ENDING_KINDS.includes(e.kind) ? e.kind : 'neutral', why, turn: state.turn, time: E.fmtTime(state) },
      e.epilogue ? { epilogue: e.epilogue } : {}, isObjE(e.when) && e.when.judged ? { judged: e.when.judged } : {}, extra || {});
    E.Memory.addFact(state, { about: [state.player], text: `The story reached an ending: ${state.ending.title}.`, known_by: ['all'], weight: 3 });
    if (res) { res.ending = state.ending; guard(res, 'resolve', 'ending', `${state.ending.title} (${state.ending.kind}): ${why}`); }
    return state.ending;
  };
  // The judged endings the memory update may rule on now: not reached yet,
  // their "if" holding.
  Eng.judgedEndings = (state) => (Eng.ended(state) || state.flags.gameOver ? [] : Eng.endingsOf(state).filter((e) => isObjE(e.when) && typeof e.when.judged === 'string' && endingOpen(state, e)));
  // The update's verdict: { id, quote }. Accepted only for a judged ending on
  // offer, with a quote of 4+ words that is really in the scene (rule 1).
  Eng.judgeEnding = function (state, verdict, prose, res) {
    if (!isObjE(verdict) || verdict.id == null || verdict.id === '' || verdict.id === 'null') return null;
    const e = Eng.judgedEndings(state).find((x) => x.id === verdict.id);
    const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const quote = norm(verdict.quote);
    if (!e) { guard(res, 'memory', 'ending refused', `"${verdict.id}" isn't an ending the story can reach now`); return null; }
    if (quote.split(' ').length < 4 || !norm(prose).includes(quote)) { guard(res, 'memory', 'ending refused', `${e.title || e.id}: the quote isn't in the scene ("${E.shorten(String(verdict.quote || ''), 80)}")`); return null; }
    return Eng.reachEnding(state, e, `the scene shows it: "${E.shorten(String(verdict.quote), 160)}"`, res, { closing: true });
  };
  // The player chooses to go on past an ending: the story carries on as an
  // epilogue, the ending stays reached.
  Eng.keepPlaying = function (state) {
    if (!Eng.ended(state)) return false;
    state.ending.continued = true;
    state.log.push({ turn: state.turn, type: 'note', text: `The story goes on after "${state.ending.title}".` });
    return true;
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
    // Ids written the way targets are ("char:yumiko") in lists that want them
    // bare (playtest-seiryo-goes-to-school: every fact lost its "about").
    const bare = (x) => (typeof x === 'string' ? x.replace(/^\s*(?:char|character|standee)\s*:\s*/i, '').trim() : x);
    const idList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []).map(bare);
    // An old fact saying the same, among those these people know.
    const recorded = function (text, known) {
      const words = contentWords(text);
      return words.size >= 5 && state.facts.find((old) => {
        const ow = contentWords(old.text);
        if (ow.size < 5 || !(old.known_by.includes('all') || known.every((x) => x !== 'all' && old.known_by.includes(x)))) return false;
        let hit = 0;
        words.forEach((w) => { if (ow.has(w)) hit++; });
        return hit / Math.min(words.size, ow.size) >= 0.75;
      });
    };
    // A fact's home (task B-0): the place the model gives, if it's real, or
    // the room when the scene stayed in one.
    const home = function (f, what) {
      const place = f.where == null || f.where === '' ? null : bare(f.where);
      const real = place && (state.locations[place] || (state.regions || {})[place] || (state.sites || {})[place]);
      if (place && !real) reject(`${what} where`, `dropped ${place}: no such place (${String(f.text).slice(0, 60)})`);
      return real ? place : ctx.startLoc && ctx.startLoc === ctx.endLoc ? ctx.startLoc : null;
    };
    (Array.isArray(upd.relations) ? upd.relations : []).forEach((r) => { if (r && typeof r === 'object') { r.from = bare(r.from); r.to = bare(r.to); } });
    (Array.isArray(upd.player_attitude) ? upd.player_attitude : []).forEach((a) => { if (a && typeof a === 'object') a.to = bare(a.to); });

    (Array.isArray(upd.facts) ? upd.facts : []).slice(0, 6).forEach((f) => {
      if (!f || !f.text) return reject('fact', 'no text');
      f.about = idList(f.about);
      f.known_by = idList(f.known_by);
      // Facts may be about a group (task 3-2), though a group knows nothing.
      const about = f.about.filter((x) => named(x) || isStandee(state, x));
      // A fact written as a bare verb phrase ("takes photos of Sora at the
      // gate") gets its one subject's name in front.
      const people = about.filter(named);
      if (people.length === 1 && /^[a-z]/.test(String(f.text).trim()) && !/^(?:the|a|an|it|its|there|this|that|everyone|someone|nobody|no one|all)\b/.test(String(f.text).trim())) {
        const who = state.characters[people[0]] || state.extras[people[0]];
        f.text = `${who.name} ${String(f.text).trim()}`;
      }
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
      const same = recorded(f.text, known);
      if (same) return reject('fact', `already recorded: "${E.shorten(same.text, 80)}" (${E.shorten(String(f.text), 60)})`);
      const where = home(f, 'fact');
      const fact = E.Memory.addFact(state, { about, text: f.text, known_by: known, weight: f.weight, where, source: 'intent' });
      if (fact.weight >= 3) state.flags.chapterWorthy = true;
      // An individual extra in a notable fact comes to matter (task 2-3).
      about.filter((x) => extraIds.has(x) && !state.extras[x].group && !state.extras[x].promote && fact.weight >= 2).forEach((x) => {
        state.extras[x].promote = true;
        report.extras.push(`${state.extras[x].name}: in a notable fact, will become a full character`);
      });
      report.applied.push(`fact: ${fact.text} (w${fact.weight}, known by ${fact.known_by.join('/')}${where ? `, at ${where}` : ''}${addedPlayer ? '; the player added: it is about their own action' : ''})`);
    });

    // Someone in the scene only goes elsewhere if the scene shows them leaving,
    // or going along with the player (playtest-seiryo-goes-to-school: Mom
    // moved to the school gate while the scene had her kneading dough). After
    // a step-in, a planned exit only happened if the kept scene shows it.
    const scene = ctx.prose != null ? ctx.prose : ctx.keptProse;
    const shownMoving = (who, from, dest) => scene == null || dest === from || ![ctx.startLoc, ctx.endLoc].includes(from)
      || Eng.seenLeaving(scene, who) || (dest === ctx.endLoc && ctx.startLoc !== ctx.endLoc && Eng.seenGoingAlong(state, scene, who));
    const notShown = ctx.keptProse != null ? 'the player stepped in before they left' : 'the scene never shows them leaving';
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
        if (!shownMoving(x, x.location, dest)) return reject(label, notShown);
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
          const inScene = (!c.status.away && [ctx.startLoc, ctx.endLoc].includes(c.status.location)) || dest === ctx.endLoc;
          if (!inScene) return reject(label, 'nobody in the scene could have seen that move');
          if (!shownMoving(c, c.status.location, dest)) return reject(label, notShown);
          const blocked = Eng.moveProblem(state, key, c.status.location, dest);
          if (blocked) return reject(label, blocked);
          Eng.setLocation(state, key, dest);
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
          if (c.needs[s.need] == null) return reject(label, state.scenario.needs.some((n) => n.id === s.need) ? `${c.name} doesn't have that need` : 'unknown need');
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
        // Only a way the scene goes near (playtest-seiryo-goes-downtown: the
        // arcade's coffee-shop door "opened" in a scene that never named it).
        const far = [a, b].filter((r) => r !== ctx.startLoc && r !== ctx.endLoc);
        if (scene != null && far.length && !far.some((r) => Eng.namesRoom(scene, state.locations[r]))) return reject(label, 'the scene never names the room on the other side');
        state.links[Eng.linkKey(a, b)].open = s.value;
      } else if (kind === 'feature') {
        const i = String(key || '').indexOf('|');
        const room = String(key).slice(0, i), name = String(key).slice(i + 1);
        if (!state.locations[room] || state.features[`${room}|${name}`] == null) return reject(label, 'no feature with a state there');
        if (name === 'lot' && state.locations[room].lot) return reject(label, 'a lot is built on by an event ("build"), with a name for what goes up');
        if (s.field !== 'state' || typeof s.value !== 'string' || !s.value.trim()) return reject(label, 'a feature only changes its "state"');
        if (![ctx.startLoc, ctx.endLoc].includes(room)) return reject(label, 'nobody in the scene was there');
        // Only the states it may take, and none held back by what it requires (task 7-3).
        const to = s.value.trim().toLowerCase().slice(0, 20);
        const opt = Eng.featureOptions(state, room, name);
        if (opt.states && !opt.states.includes(to)) return reject(label, `the ${name} can only be: ${opt.states.join(', ')}`);
        if (to in opt.blocked) {
          const r = opt.requires[Object.keys(opt.requires).find((k) => k.toLowerCase() === to)];
          return reject(label, `the ${name} can't be ${to} yet: needs ${r.if.filter((p) => !E.Timeline.holds(state, p)).map((p) => E.Timeline.say(state, p)).join('; ')}`);
        }
        state.features[`${room}|${name}`] = to;
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
        // A status, not scenery (playtest-seiryo-goes-downtown: the weather
        // became a sentence of the scene's prose).
        if (v.split(/\s+/).length > 14) return reject(label, 'too long for a status (14 words at most)');
        state.world[key] = String(s.value || '').slice(0, 120);
      } else if (kind === 'faction') {
        const f = (state.factions || []).find((x) => x.id === key);
        if (!f) return reject(label, 'unknown group');
        f.stance = String(s.value || '').slice(0, 140);
      } else if (kind === 'clock') {
        const cl = state.clocks.find((x) => x.id === key);
        if (!cl) return reject(label, 'unknown clock');
        if (cl.fired) return reject(label, 'clock already fired');
        if (cl.fixed) return reject(label, 'only time moves this pressure');
        if (cl.stopped) return reject(label, 'this pressure has stopped');
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

    // Standing with the groups, and a role the scene gives the player (task G-6).
    report.standing = [];
    E.Standing.applyUpdate(state, upd, present, ctx, reject, (line) => report.standing.push(line));

    applyNewExtras(state, upd.new_extras, ctx.turn ?? state.turn, ctx.endLoc || state.characters[state.player].status.location,
      (why) => reject('new_extras', why), (note) => report.extras.push(note));

    // Narrated details (task B-0b), last: what they say is checked against
    // where people are after this turn's moves, so a walk-in stays.
    (Array.isArray(upd.details) ? upd.details : []).slice(0, Eng.DETAILS_MAX).forEach((d) => {
      if (!d || !d.text) return reject('detail', 'no text');
      const text = String(d.text).trim();
      const short = E.shorten(text, 60);
      const about = idList(d.about).filter((x) => named(x) || isStandee(state, x));
      const where = home(d, 'detail');
      if (!where && !about.length) return reject('detail', `no home: no place or person (${short})`);
      if (scene != null && !saidIn(text, scene)) return reject('detail', `the scene doesn't say that (${short})`);
      const same = recorded(text, witnesses);
      if (same) return reject('detail', `already recorded: "${E.shorten(same.text, 80)}" (${short})`);
      const room = state.locations[where] ? where : null;
      const thing = typeof d.thing === 'string' ? d.thing.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 30) : '';
      const told = typeof d.state === 'string' ? d.state.trim().toLowerCase().slice(0, 20) : '';
      const wrong = Eng.detailProblem(state, { text, about, room, thing, state: told }, ctx);
      if (wrong) return reject('detail', `${wrong} (${short})`);
      const fact = E.Memory.addFact(state, { about, text, known_by: witnesses.slice(), weight: 1, where, source: 'narration' });
      report.applied.push(`detail: ${fact.text}${where ? ` (at ${where})` : ''}`);
      E.Memory.capDetails(state, fact).forEach((f) => reject('detail', `the oldest at this home gives way: "${E.shorten(f.text, 60)}"`));
      if (!thing || !room) return;
      const made = Eng.narrateFeature(state, room, thing, told, ctx);
      if (made.error) reject('detail feature', `${made.error} (${short})`);
      else if (made.note) report.applied.push(`feature: ${made.note}`);
    });

    return report;
  };

  // ---------- narrated details (task B-0b) ----------
  Eng.DETAILS_MAX = 3;
  Eng.NARRATED_FEATURES_MAX = 3;
  // The update step sees hidden actions too, so a detail has to be something
  // the scene says: at least half its words are in the prose.
  function saidIn(text, prose) {
    const words = contentWords(text);
    const said = contentWords(prose);
    let hit = 0;
    words.forEach((w) => { if (said.has(w)) hit++; });
    return !words.size || hit / words.size >= 0.5;
  }
  const WAY_OPEN = /\b(?:door|hatch|gate)s?\b[^.!?]{0,30}\b(?:open|opened|ajar|unlocked|propped)\b|\b(?:open|opened|unlocked)\s+(?:door|hatch|gate)\b/i;
  const AT_ROOM = /\b(?:is|are|stays?|waits?|sits?|stands?|sleeps?|remains?)\b[^.!?]{0,30}\b(?:in|at|inside)\b/i;
  const HOLDS = /\b(?:has|holds|carries|keeps|owns|pockets)\b/i;
  const PAST_ON = /\b(?:body|corpse|grave|dead|died|death|killed|buried|was|were|had|used to)\b/i;
  // What a detail says against what the engine owns, after the turn's moves.
  // d: { text, about, room, thing, state }. → the reason, or null. New things
  // the engine doesn't track are never contradictions.
  Eng.detailProblem = function (state, d, ctx) {
    const person = (id) => state.characters[id] || (state.extras || {})[id];
    const where = (id) => whereIs(state, id);
    const dead = d.about.find((id) => state.characters[id] && state.characters[id].status.health === 'dead');
    if (dead && !PAST_ON.test(d.text)) return `${state.characters[dead].name} is dead`;
    const at = AT_ROOM.exec(d.text);
    if (at) {
      const rest = d.text.slice(at.index + at[0].length);
      for (const id of d.about) {
        const now = state.locations[where(id)];
        if (!now || Eng.namesRoom(rest, now)) continue;
        const other = Object.values(state.locations).find((l) => l.id !== now.id && Eng.namesRoom(rest, l));
        if (other) return `${person(id).name} is in ${now.name}, not ${other.name}`;
      }
    }
    if (WAY_OPEN.test(d.text)) {
      const rooms = [...new Set([d.room, ctx.startLoc, ctx.endLoc].filter(Boolean))];
      for (const r of rooms) {
        const ways = Eng.linkedRooms(state, r).map((o) => ({ o, k: Eng.linkInfo(state, r, o) })).filter((w) => w.k && !['open', 'trip'].includes(w.k.kind));
        const shut = ways.find((w) => w.k.locked && (Eng.namesRoom(d.text, state.locations[w.o]) || ways.every((x) => x.k.locked)));
        if (shut) return `the way to ${state.locations[shut.o].name} is locked`;
      }
    }
    if (/\bkeys?\b/i.test(d.text) && HOLDS.test(d.text)) {
      for (const l of Object.values(state.locations)) {
        for (const k of (l.links || []).filter((x) => (x.key || []).length && state.locations[x.to])) {
          if (!Eng.namesRoom(d.text, state.locations[k.to])) continue;
          const other = d.about.find((id) => !k.key.includes(id));
          if (other) return `${person(other).name} doesn't hold the key to ${state.locations[k.to].name}`;
        }
      }
    }
    if (d.thing && d.room && d.state) {
      const f = Eng.features(state, d.room).find((x) => x.name.toLowerCase() === d.thing);
      if (f && f.state != null && f.state.toLowerCase() !== d.state) return `the ${f.name} is ${f.state}`;
    }
    return null;
  };
  // An object a detail names becomes a feature of its room, by the same limits
  // as an inferred one, only where the scene was. One the room already has
  // stays as it is. → { note } or { error }, or {} when there is nothing to add.
  Eng.narrateFeature = function (state, room, name, told, ctx) {
    const l = state.locations[room];
    if (![ctx.startLoc, ctx.endLoc].includes(room)) return { error: 'nobody in the scene was there' };
    if (Eng.features(state, room).some((f) => f.name.toLowerCase() === name)) return {};
    if ((l.features || []).length >= Eng.FEATURES_MAX) return { error: `${l.name} already has ${Eng.FEATURES_MAX} features` };
    if (Eng.features(state, room).filter((f) => f.narrated).length >= Eng.NARRATED_FEATURES_MAX) return { error: `${l.name} already has ${Eng.NARRATED_FEATURES_MAX} narrated features` };
    l.features = (l.features || []).concat([{ name, inferred: true, source: 'narration' }]);
    if (told) state.features[`${room}|${name}`] = told;
    return { note: `${l.name}: + ${name}${told ? ` (${told})` : ''}` };
  };

  // True when a paragraph naming the character also shows someone leaving
  // ("She's gone toward Ops", "He's backing toward the corridor").
  const LEAVING = /\b(?:leaves|left|leaving|exits|disappears|(?:storms|stomps|runs|rushes|marches|stalks)\s+(?:out|off|away)|slams\s+the\s+door\s+behind|out\s+the\s+door|(?:is|'s|was)\s+gone|heads?\s+(?:out|off|for|to|toward|towards|back)|heading\s+(?:out|off|for|to|toward|towards)|goes\s+(?:out|off|to|back)|(?:walks|slips|steps|ducks|hurries)\s+(?:out|off|away)|backing\s+(?:out|away|toward|towards))\b/i;
  Eng.seenLeaving = (prose, c) =>
    String(prose || '').split(/\n\s*\n/).some((p) => mentions(p, c) && LEAVING.test(p.replace(/[‘’]/g, "'")));
  // True when a paragraph naming the character has them go with the player
  // ("Mom walks with you to the station", "Kenji tags along").
  Eng.seenGoingAlong = (state, prose, c) =>
    String(prose || '').split(/\n\s*\n/).some((p) => mentions(p, c) && Eng.comesAlong(state, p));

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
      for (const f of Eng.ruleFeatures(state, l.id)) {
        const n = bare(f.name);
        if (n.length < 4 || mine.has(n)) continue;
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\byou(?:'re| are)?\\b[^.!?\\n]{0,30}(?:\\b(?:${reach})\\b|\\b(?:almost|nearly|right) (?:to|at|by|beside|behind)\\b)[^.!?\\n]{0,30}\\b${esc}\\b`, 'i');
        if (re.test(prose)) return l;
      }
    }
    return null;
  };

  // The scene up to the first paragraph that moves the player, or ''.
  Eng.untilRelocation = function (state, prose, startLoc, via) {
    const kept = [];
    for (const p of String(prose || '').split(/\n\s*\n/)) {
      if (Eng.findRelocation(state, p, startLoc, via)) break;
      kept.push(p);
    }
    const out = kept.join('\n\n').trim();
    return out.replace(markRe('gi'), '').trim() ? out : '';
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

  // ---------- travel plans (R-10) ----------
  // The model says where the player wants to go; the engine finds the way and
  // how long each part takes. A link's own "time" first; a trip link takes
  // the region legs between its rooms (a timed route its hours, a free border
  // the time for the label of the region it enters); else the kind's default
  // (Scenario.LINK_MINUTES, BORDER_MINUTES, a world's travelTimes).
  const linkOf = (state, a, b) => (state.locations[a].links || []).find((x) => x.to === b) || (state.locations[b].links || []).find((x) => x.to === a) || { kind: 'open' };
  Eng.legMinutes = function (state, e) {
    if (e.hours > 0) return e.hours * 60;
    if (e.kind !== 'border') return 0;
    const r = Eng.regionDef(state, e.to) || {};
    return E.Scenario.borderMinutes(state.scenario, r.id ? E.Scenario.regionLabel(state.scenario, r.id) : null);
  };
  Eng.linkMinutes = function (state, a, b) {
    const k = linkOf(state, a, b);
    const own = E.Scenario.linkTime(k);
    if (own != null) return own;
    const base = E.Scenario.linkMinutes(state.scenario, k.kind);
    // Between regions: the region legs. A timed route counts (the author's
    // times are the whole way: R-2's numbers stand, whatever the link). Only
    // a trip link that crosses nothing but free borders takes the border
    // defaults (Seiryo: home to school was zero minutes); a door or an
    // airlock onto the next region is the step through it.
    const legs = (Eng.tripBetween(state, a, b) || {}).legs || [];
    const timed = legs.some((e) => e.hours > 0);
    const m = timed ? legs.reduce((sum, e) => sum + e.hours * 60, 0) : k.kind === 'trip' ? legs.reduce((sum, e) => sum + Eng.legMinutes(state, e), 0) : 0;
    return Math.max(m, base);
  };
  // → { from, to, steps: [{ from, to, kind, minutes, at (minutes when it
  // ends) }], minutes, blocked: null | { index, why, risky, closed } }, or
  // null when there is no way at all. A blocked plan lists the whole way; its
  // steps from `index` on can't be taken (a locked door, a closed route).
  Eng.travelPlan = function (state, from, to, who) {
    if (!state.locations[from] || !state.locations[to]) return null;
    if (from === to) return { from, to, steps: [], minutes: 0, blocked: null };
    const tripClosed = (a, b) => !!(Eng.tripBetween(state, a, b) || {}).blocked;
    const search = (open) => {
      const best = new Map([[from, 0]]);
      const prev = new Map();
      const queue = [from];
      while (queue.length) {
        queue.sort((x, y) => best.get(x) - best.get(y));
        const id = queue.shift();
        if (id === to) break;
        Eng.linkedRooms(state, id).forEach((next) => {
          if (!state.locations[next] || !open(id, next)) return;
          const cost = best.get(id) + Eng.linkMinutes(state, id, next) + 1e-6; // fewer links on a tie
          if (best.has(next) && best.get(next) <= cost) return;
          best.set(next, cost);
          prev.set(next, id);
          if (!queue.includes(next)) queue.push(next);
        });
      }
      if (!best.has(to)) return null;
      const path = [to];
      for (let at = to; prev.has(at); at = prev.get(at)) path.unshift(prev.get(at));
      return path;
    };
    let path = search((a, b) => Eng.passable(state, a, b, who) && !tripClosed(a, b));
    let blocked = null;
    if (!path) {
      path = search(() => true);
      if (!path) return null;
      for (let i = 0; i + 1 < path.length && !blocked; i++) {
        if (!Eng.passable(state, path[i], path[i + 1], who)) blocked = { index: i, why: blockText(state, { a: path[i], b: path[i + 1] }), risky: false };
        else if (tripClosed(path[i], path[i + 1])) {
          const t = Eng.tripBetween(state, path[i], path[i + 1]);
          blocked = { index: i, why: t.why, risky: !!t.risky, closed: t.closed };
        }
      }
    }
    let at = 0;
    const steps = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const minutes = Math.round(Eng.linkMinutes(state, path[i], path[i + 1]) * 10) / 10;
      at += minutes;
      steps.push({ from: path[i], to: path[i + 1], kind: linkOf(state, path[i], path[i + 1]).kind, minutes, at: Math.round(at * 10) / 10 });
    }
    return { from, to, steps, minutes: Math.round(at * 10) / 10, blocked };
  };
  // Where a plan has someone after so many minutes. → { room (the last room
  // reached), at (when they got there), arrived, step (the one under way, or
  // null), into (minutes into it), left (minutes still to go), blockedHere }.
  // A blocked plan stops at the room before the block.
  Eng.TRANSIT_MIN = 10; // further than this into a link, they are on the way, not in the last room
  Eng.travelReach = function (plan, minutes) {
    const open = plan.blocked ? plan.steps.slice(0, plan.blocked.index) : plan.steps;
    let room = plan.from, at = 0, i = 0;
    for (; i < open.length; i++) {
      if (open[i].at > minutes + 1e-6) break;
      room = open[i].to;
      at = open[i].at;
    }
    if (i === open.length) return { room, at, arrived: !plan.blocked, step: null, into: 0, left: plan.blocked ? null : 0, blockedHere: !!plan.blocked };
    const into = minutes - at;
    return { room, at, arrived: false, step: open[i], into, left: Math.max(0, plan.minutes - minutes), blockedHere: false };
  };
  // Puts the people on a plan where it has them after so many minutes: the
  // last room reached, or an "On the way to …" room past TRANSIT_MIN into a
  // link (its links carry the time left each way). → { room, reach }.
  Eng.placeOnPlan = function (state, plan, minutes, ids) {
    const reach = Eng.travelReach(plan, minutes);
    let room = reach.room;
    if (!reach.arrived && reach.step && reach.into > Eng.TRANSIT_MIN) {
      const st = reach.step;
      const trip = Eng.tripBetween(state, st.from, st.to);
      const hoursIn = reach.into / 60;
      let region = Eng.regionOf(state, st.from);
      let done = 0;
      for (const e of (trip && trip.legs) || []) { const h = Eng.legMinutes(state, e) / 60; if (done + h > hoursIn) break; done += h; region = e.to; }
      room = transitAt(state, { region, toward: plan.to, next: st.to, nextMinutes: Math.round(st.minutes - reach.into), back: st.from, backMinutes: Math.round(reach.into) });
    }
    (ids || []).filter((id) => state.characters[id]).forEach((id) => { Eng.setLocation(state, id, room); });
    return { room, reach };
  };
  // "the School gate is still about 1h 05m away"
  Eng.sayLeft = (minutes) => E.Scenario.sayHours(Math.max(1, Math.round(minutes)) / 60);
  // The stops worth naming on a plan: where each trip ends, and the end.
  const planStops = (state, plan, upTo) => plan.steps.filter((s, i) => (s.kind === 'trip' || i === plan.steps.length - 1) && s.at <= upTo + 1e-6)
    .map((s) => ({ room: s.to, name: state.locations[s.to].name, at: Math.round(s.at) }));

  // The player's move in resolve (R-10). Sets o.moved, o.via, o.travel and
  // res.travel ({ dest, destName, plan, arriveAt, stops, left, stopName,
  // blocked }), and state.travel while the trip is unfinished.
  function travelMove(state, it, o, res, stepId) {
    const c = state.characters[it.id];
    const from = c.status.location;
    const plan = Eng.travelPlan(state, from, it.moveTo, it.id);
    const dest = state.locations[it.moveTo];
    if (!plan) {
      const why = Eng.moveProblem(state, it.id, from, it.moveTo) || `there is no way to ${dest.name}`;
      guard(res, 'resolve', 'move blocked', `${c.name} → ${it.moveTo}: ${why}`);
      o.action += ` (but ${why}, so you stay in ${state.locations[from].name})`;
      return;
    }
    // A risky closed route the roll got past counts as open (R-2).
    if (plan.blocked && plan.blocked.risky && o.roll) {
      guard(res, 'resolve', 'crossed', `${c.name}: ${plan.blocked.why}, and gets through anyway`);
      plan.crossed = plan.blocked.why;
      plan.blocked = null;
    }
    const span = Math.round(E.stepHours(state, stepId).hours * 60);
    const { room, reach } = Eng.placeOnPlan(state, plan, span, [it.id]);
    const t = { dest: it.moveTo, destName: dest.name, plan, from, stops: planStops(state, plan, reach.arrived ? plan.minutes : span) };
    if (plan.blocked) {
      t.blocked = plan.blocked.why;
      guard(res, 'resolve', 'move blocked', `${c.name} → ${it.moveTo}: ${plan.blocked.why}${room !== from ? `; stops at ${state.locations[room].name}` : ''}`);
      delete state.travel;
    }
    if (reach.arrived) {
      t.arriveAt = Math.round(plan.minutes);
      delete state.travel;
    } else if (!plan.blocked) {
      t.left = reach.left;
      t.stopName = state.locations[room].name;
      state.travel = { dest: it.moveTo, destName: dest.name, turn: state.turn };
      guard(res, 'resolve', 'travel', `${dest.name} is ${Eng.sayLeft(plan.minutes)} away; the step ends ${state.locations[room].transit ? 'on the way' : `at ${state.locations[room].name}`}, ${Eng.sayLeft(reach.left)} short`);
    }
    if (room === from) {
      o.action += ` (but ${plan.blocked ? plan.blocked.why : 'there is no time to get anywhere'}, so you stay in ${state.locations[from].name})`;
      return;
    }
    const path = [from].concat(plan.steps.map((s) => s.to));
    const upTo = path.indexOf(room);
    if (upTo > 1) o.via = path.slice(1, upTo);
    o.moved = room;
    o.travel = t;
    res.travel = t;
    const trip = Eng.tripBetween(state, from, room);
    if (trip && trip.legs && trip.hours > 0) o.trip = Eng.sayTrip(state, trip);
    o.action += ` (the way, planned by the engine: ${o.trip ? `${o.trip}; ` : ''}${Eng.sayPlan(t)}${plan.crossed ? `; gets past although ${plan.crossed}` : ''})`;
  }
  // The line under a scene (outside the prose): what is still to go.
  Eng.travelNote = (t) => (t.blocked ? `The way to ${t.destName} is blocked: ${t.blocked}.` : t.left != null ? `${t.destName} is still about ${Eng.sayLeft(t.left)} away.` : null);
  // "leaves +0m; Mito Station plaza +12m; arrives at the School gate +43m"
  Eng.sayPlan = (t) => ['leaves +0m'].concat(t.stops.filter((s) => s.room !== t.dest).map((s) => `${s.name} +${s.at}m`))
    .concat(t.arriveAt != null ? [`arrives at ${t.destName} +${t.arriveAt}m`] : t.blocked ? [`stopped: ${t.blocked}`] : [`still ${Eng.sayLeft(t.left)} from ${t.destName} when the time runs out`]).join('; ');

  // The journey a "until something major happens" step makes (R-10): an
  // unfinished trip the words go on with (or the Travel there button), or a
  // place the words go to an hour or more away. → a journey for skipTurn, or null.
  Eng.JOURNEY_MIN = 60;
  // A place or room the words name ("take the train to the city square"):
  // the player's own place first, then the longest name. → room id or null.
  Eng.placeNamed = function (state, text) {
    const mine = E.Sites ? E.Sites.playerSite(state) : null;
    const cands = Object.values(state.sites || {}).filter((s) => s && s.entry && state.locations[s.entry] && s.name).map((s) => ({ name: s.name, room: s.entry, site: s.id }))
      .concat(Object.values(state.locations).filter((l) => !l.transit).map((l) => ({ name: l.name, room: l.id, site: l.site })))
      .map((c) => Object.assign(c, { name: String(c.name).replace(/^the\s+/i, '').trim() }))
      .filter((c) => c.name.length > 2 && mentionsName(text, c.name));
    cands.sort((x, y) => (y.site === mine) - (x.site === mine) || y.name.length - x.name.length);
    if (cands.length) return cands[0].room;
    // A region the words name ("the train to Tokyo"): its place, when it has one.
    const here = Eng.playerRegion(state);
    const region = (state.scenario.regions || []).filter((r) => r && r.name && r.id !== here && Eng.regionKnown(state, r.id) && mentionsName(text, r.name))
      .sort((x, y) => y.name.length - x.name.length)[0];
    return region ? Eng.resolvePlace(state, region.id, text) : null;
  };
  Eng.majorJourney = function (state, action) {
    const here = state.characters[state.player].status.location;
    const t = state.travel;
    const going = t && state.locations[t.dest] && (KEEP_GOING.test(String(action || '')) || mentionsName(action, t.destName));
    const dest = going ? t.dest : Eng.placeInWords(state, action) || (Eng.setsOut(action) ? Eng.placeNamed(state, action) : null);
    if (!dest || dest === here) return null;
    const plan = Eng.travelPlan(state, here, dest, state.player);
    if (!plan || plan.blocked || !(going || plan.minutes >= Eng.JOURNEY_MIN)) return null;
    const trip = Eng.tripBetween(state, here, dest) || { legs: [] };
    const all = /\b(we|us|everyone|all of us|together)\b/i.test(String(action || ''));
    const companions = Eng.present(state).filter((id) => Eng.alive(state, id) && (all || mentions(action, state.characters[id])));
    // A journey is told in hours and days: its time to the nearest 5 minutes.
    return { dest, trip: { legs: trip.legs || [], hours: Math.max(5, Math.round(plan.minutes / 5) * 5) / 60 }, roll: null, companions, plan };
  };

  // The player's words want this trip (rule 3): they set out, or name the
  // place, its room or its region.
  Eng.travelWanted = function (state, action, dest) {
    if (Eng.setsOut(action) || planNames(state, action, dest)) return true;
    const site = (state.sites || {})[E.Sites.siteOf(state, dest)];
    return [site && site.name, (Eng.regionDef(state, Eng.regionOf(state, dest)) || {}).name].filter(Boolean).some((n) => mentionsName(action, n));
  };
  // An unfinished trip (R-10) goes on when the player's words say so ("keep
  // going", "carry on") or name where it goes; the engine sets the move, with
  // no model choice of the way. A move anywhere else drops it. → a guard, or null.
  const KEEP_GOING = /\b(keep (?:going|walking|driving|riding|on)|carry on|go on|press on|push on|continue(?: on)?(?: the (?:trip|journey|way))?|on (?:we|I) go)\b/i;
  Eng.travelResume = function (state, intentObj, action) {
    const t = state.travel;
    if (!t) return null;
    const p = intentObj && intentObj.player;
    if (!state.locations[t.dest]) { delete state.travel; return null; }
    if (KEEP_GOING.test(String(action || '')) || mentionsName(action, t.destName)) {
      if (p && typeof p === 'object') Object.assign(p, { move_to: t.dest, new_place: null, new_region: null, resumed: true });
      return { type: 'travel resumed', detail: `on to ${t.destName}` };
    }
    const to = p && typeof p.move_to === 'string' ? Eng.resolvePlace(state, p.move_to, action) : null;
    if (to && to !== t.dest) { delete state.travel; return { type: 'travel dropped', detail: `heading for ${state.locations[to].name} instead of ${t.destName}` }; }
    return null;
  };

  // Drops trailing paragraphs that are the player character's own action or
  // thoughts ("You turn back to…"), so the scene ends on someone else's move.
  // A beat that is only the player's action goes too. But once a paragraph
  // has been dropped, the paragraph that opens its beat (a time marker) stays:
  // dropping both lost the whole live scene that ends a skip
  // (playtest-agenda-skips).
  // names: the people in the story, so a paragraph that hands over to one of
  // them is not the player's (without names, only "he" or "she" count).
  // A paragraph that is the player's own action or line, and doesn't hand
  // over to someone else. Also the player's own quoted line ("Just looking,"
  // you say…; playtest-office-window). But not a paragraph that opens on the
  // player and hands over ("You turn to go, but Dex hesitates. "Wait…"";
  // playtest-r2-drive-to-ridge: trimming it lost the hook the scene ended on).
  Eng.playerParagraph = function (p, names) {
    const who = ['he', 'she', 'He', 'She'].concat((names || []).filter((n) => /^[A-Z][\w'-]+$/.test(n)));
    const turn = new RegExp(`(?:[.!?]["”]?\\s+|,\\s*(?:but|and|while|as|when|until|then)\\s+)(?:${who.join('|')})\\s+[a-z]+(?:s|ed)\\b`, 'g');
    const handsOver = () => {
      const at = [...p.matchAll(turn)].pop();
      return !!at && !/[.!?]["”]?\s+(?:You|Your)\b/.test(p.slice(at.index + at[0].length));
    };
    return (/^\s*(\[[^\]]*\]\s*)?(you|your)\b/i.test(p) && !handsOver()) || /^\s*(\[[^\]]*\]\s*)?["“][^"”]*["”],?\s*you\s+(?:say|said|ask|asked|reply|replied|tell|told|answer|answered|add|added|murmur|mutter|whisper|call|shrug)\b/i.test(p);
  };
  Eng.trimPlayerEnding = function (prose, names) {
    const paras = String(prose || '').split(/\n\s*\n/);
    let dropped = 0;
    const mine = (p) => Eng.playerParagraph(p, names);
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
    let kept = paras.filter((para) => !retold(para));
    if (!kept.length) return text;
    if (kept.length < paras.length) guard(res, 'scene', 'retold last scene', `dropped ${paras.length - kept.length} of ${paras.length} paragraphs`);
    // Sentences copied word for word from the last scene, or said twice here
    // (playtest-seiryo-goes-downtown: "The gate's wide open and the cherry
    // trees frame it like a painting." ended three scenes running).
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const before = ' ' + norm(last.text) + ' ';
    const said = new Set();
    let cut = 0;
    kept = kept.map((para) => {
      const lead = (/^\s*\[\s*\+\s*\d[^\]]*\]\s*/.exec(para) || [''])[0];
      const parts = para.slice(lead.length).split(/(?<=[.!?]["”’']?)\s+(?=["“‘'(]?[A-Z])/);
      const out = parts.filter((s) => {
        const n = norm(s.replace(MARK, ''));
        if (n.split(' ').length < 6) return true;
        const copy = before.includes(' ' + n + ' ') || said.has(n);
        said.add(n);
        if (copy) cut++;
        return !copy;
      });
      if (out.length === parts.length) return para;
      return out.length ? lead + out.join(' ') : '';
    }).filter((para) => para.replace(MARK, '').trim());
    if (!kept.length || !cut && kept.length === paras.length) return text;
    if (cut) guard(res, 'scene', 'copied sentence dropped', `${cut} sentence${cut > 1 ? 's' : ''} copied from the last scene or repeated`);
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
    // "You:" too, and after "You (Sora):" the player's own action copied in
    // the first person goes with it (playtest-seiryo-bad-model: "+0m] You
    // (Sora Hayakawa): I join the others in the gym.").
    const out = String(text).split(/\n\s*\n/).map((para) => {
      let mine = false;
      const rest = para.replace(/^(\s*(?:\[[^\]]*\]\s*)?)(?:(you(?:\s*\([^)\n]{1,40}\))?)|([A-Z][\w.' -]{1,40}?))\s*:\s+(?=\S)/i, (all, lead, you, label) => {
        if (!you && !names.has(label.trim().toLowerCase())) return all;
        n++;
        mine = !!you;
        return lead;
      });
      if (!mine) return rest;
      const lead = (/^\s*(?:\[[^\]]*\]\s*)?/.exec(rest) || [''])[0];
      return lead + rest.slice(lead.length).replace(/^I\b[^.!?\n]*[.!?]+\s*/, '');
    }).filter((para) => para.replace(markRe('gi'), '').trim()).join('\n\n');
    if (n) guard(res, 'scene', 'speaker label removed', `${n} paragraph${n > 1 ? 's' : ''}`);
    return n ? out : text;
  };

  // With state, character id tags in brackets become names, speaker labels
  // and retellings of the last scene go, first.
  // A marker that lost its opening bracket at the start of a paragraph
  // ("+0m] You…"; playtest-seiryo-bad-model) gets it back.
  Eng.repairMarkers = (text) => String(text || '').replace(new RegExp(`(^|\\n)([ \\t]*)\\+\\s*((?:\\d+(?:\\.\\d+)?\\s*(?:${MARK_UNIT})?\\s*){1,3})\\]`, 'gi'), '$1$2[+$3]');
  Eng.cleanScene = function (text, res, state) {
    const raw = state ? Eng.dropRetold(state, Eng.dropSpeakerLabels(state, Eng.replaceIdTags(state, Eng.repairMarkers(String(text || '').trim()), res), res), res) : String(text || '').trim();
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
  // Time markers ("[+25m]"). Seconds too, alone or after minutes ("[+30s]",
  // "[+1m 15s]"): a 12B wrote them for a few-minute step and they stayed in
  // the prose (playtest-stragglers-sneak). Compound marks too ("[+0h06]",
  // "[+1d 20h]"): a number without a unit after another is the next smaller
  // unit (playtest-coffee-skips).
  const MARK_UNIT = 'days?|day|sols?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s';
  const markRe = (flags) => new RegExp(`\\[\\s*\\+\\s*((?:\\d+(?:\\.\\d+)?\\s*(?:${MARK_UNIT})?\\s*){1,3})\\]`, flags);
  const minutesOf = (inner) => {
    const per = { d: 1440, h: 60, m: 1, s: 1 / 60 };
    const smaller = { d: 'h', h: 'm', m: 's', s: 's' };
    const kind = (u) => (/^(d|sol)/.test(u) ? 'd' : u.startsWith('h') ? 'h' : /^s/.test(u) ? 's' : 'm');
    let total = 0;
    let prev = null;
    const part = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${MARK_UNIT})?`, 'gi');
    let p;
    while ((p = part.exec(inner))) {
      const u = p[2] ? kind(p[2].toLowerCase()) : prev ? smaller[prev] : 'm';
      total += parseFloat(p[1]) * per[u];
      prev = u;
    }
    return total;
  };
  // The minutes of the marker a paragraph opens with, or null.
  Eng.markerAt = (para) => { const m = new RegExp('^\\s*' + markRe('i').source, 'i').exec(String(para || '')); return m ? minutesOf(m[1]) : null; };
  Eng.parseBeats = function (prose, spanMinutes) {
    const re = markRe('gi');
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
    // Routines move people as time passes, so winding it back puts them back.
    routines: E.clone(Eng.cast(state).filter((id) => state.characters[id].routine).map((id) => {
      const c = state.characters[id];
      return { id, location: c.status.location, away: c.status.away, routineState: c.routineState, routineHold: c.routineHold };
    })),
  });

  // Winds the clock back to where the scene actually ended: the last beat plus
  // a little for the beat itself. Keeps the full step if a pressure clock fired
  // (the scene is built around it). Returns true when time changed.
  const restoreTime = (state, snap) => {
    state.time = E.clone(snap.time);
    Eng.cast(state).forEach((id, i) => { state.characters[id].needs = E.clone(snap.needs[i]); });
    state.clocks.forEach((c, i) => { if (snap.clocks[i]) c.value = snap.clocks[i].value; });
    if (snap.agendas) Eng.cast(state).forEach((id, i) => { if (snap.agendas[i]) state.characters[id].agenda = E.clone(snap.agendas[i]); });
    (snap.routines || []).forEach((r) => {
      const c = state.characters[r.id];
      if (!c) return;
      c.status.location = r.location;
      if (r.away == null) delete c.status.away; else c.status.away = r.away;
      ['routineState', 'routineHold'].forEach((k) => { if (r[k] == null) delete c[k]; else c[k] = E.clone(r[k]); });
    });
  };

  // A planned trip is a floor: the player can't be there before the plan
  // arrives, or anywhere short of the whole step when it runs out on the way
  // (playtest-seiryo-bad-model: a scene with no markers settled the trip to
  // the gate at +6m, half an hour before it could arrive).
  Eng.settleSceneTime = function (state, beats, spanMinutes, before, res) {
    const t = res && res.travel;
    const trip = !t || t.blocked ? 0 : t.arriveAt != null ? t.arriveAt + Math.round(spanMinutes * 0.1) : spanMinutes;
    // Nor before what the narrator was told happens: routine moves, the day's last stop (task G-8).
    const told = (res && res.routineMoves ? res.routineMoves.map((m) => m.at + 1) : []).concat(res && res.routineDay ? res.routineDay.stops[res.routineDay.stops.length - 1].at : []);
    const floor = Math.max(trip, ...told);
    const end = Math.min(spanMinutes, Math.max(floor, beats[beats.length - 1].at + Math.round(spanMinutes * 0.1)));
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
      // A trip (R-10): where the plan has the travellers at the cut.
      if (p.travel) {
        const { room, reach } = Eng.placeOnPlan(state, p.travel.plan, minutes, [state.player].concat(p.travel.companions));
        const dest = state.locations[p.travel.plan.to];
        if (reach.arrived || p.travel.plan.blocked) delete state.travel;
        else state.travel = { dest: p.travel.plan.to, destName: dest.name, turn: p.turn };
        const entry = state.log.find((e) => e.turn === p.turn && e.type === 'scene');
        const note = !reach.arrived && !p.travel.plan.blocked ? `${dest.name} is still about ${Eng.sayLeft(reach.left)} away.` : null;
        if (entry) { if (note) entry.travel = note; else if (reach.arrived) delete entry.travel; }
        if (room !== p.playerMovedTo) guard(p.res, 'memory', 'travel', `stepped in on the way: at ${state.locations[room].name}`);
      }
      // A routine day (task G-8): the stop the plan had reached.
      if (p.routineDay) {
        const stop = p.routineDay.stops.filter((s) => s.at <= minutes).pop();
        Eng.setLocation(state, state.player, stop ? stop.room : p.frame.startLoc);
      }
      // Corrections the player made while this turn was pending still stand.
      (p.corrections || []).forEach((c) => applyCorrection(state, c));
      (p.pins || []).forEach((x) => applyPin(state, x));
      endLoc = state.characters[state.player].status.location;
      Eng.advanceTime(state, minutes / 60, { events: [], staying: p.res.staying }, p.routine === true ? true : p.routine || false);
      const entry = state.log.find((e) => e.turn === p.turn && e.type === 'scene');
      if (entry) entry.cutAt = cut;
      const actionEntry = state.log.find((e) => e.turn === p.turn && e.type === 'action');
      if (actionEntry) actionEntry.until = E.fmtTime(state);
      state.recent = [{ turn: p.turn, action: p.action, text: beatsText(kept) + `\n\n[${state.characters[state.player].name} steps in here, at ${E.fmtTime(state)}.]` }];
    }

    // A routine broken (task B-1), once the scene has played to its end.
    if (!cut && p.res.noticed) E.Memory.addFact(state, { about: [p.res.noticed.id], text: p.res.noticed.fact, known_by: [state.player], weight: 1, where: p.res.noticed.room });
    phase('Updating memory…');
    const prose = beatsText(kept);
    let report;
    try {
      const upd = await Eng.updateCalls(state, { system: E.Prompts.header(state), action: p.action, res: p.res, prose, present: p.present, cut: !!cut, stepId: p.frame && p.frame.stepId });
      // A judged ending the scene shows (taken out before the update is applied).
      if (upd && typeof upd === 'object' && 'ending' in upd) { Eng.judgeEnding(state, upd.ending, prose, p.res); delete upd.ending; }
      const expired = Eng.expireTags(state, p.turn);
      const before = {};
      Eng.cast(state, { includePlayer: false }).forEach((id) => (before[id] = state.characters[id].status.location));
      const factsBefore = state.facts.length;
      report = Eng.applyUpdate(state, upd, p.present, { startLoc: p.frame.startLoc, endLoc, prose, keptProse: cut ? prose : null, involved: p.res.involved, turn: p.turn, action: p.action, playerHarmed: (p.res.guards || []).some((g) => g.type === 'harm' && g.detail.startsWith(state.characters[state.player].name + ':')), extrasPresent: p.extrasPresent || [], engaged: p.res.engaged || [] });
      report.rejected.forEach((r) => guard(p.res, 'memory', 'update rejected', r));
      // What the scene changed may stop a pressure, or reach an ending the
      // engine checks (task 7-3: the reactor shut down); that ending closes
      // the story like a judged one, before the next action.
      Eng.stopClocks(state, p.res);
      if (!Eng.ended(state)) Eng.checkEndings(state, p.res, { closing: true });
      expired.concat(report.tags).forEach((t) => guard(p.res, 'memory', 'tags & mood', t));
      report.extras.forEach((t) => guard(p.res, 'memory', 'extras', t));
      (report.standing || []).forEach((t) => guard(p.res, 'memory', 'standing', t));
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
  // ---------- a place that travels (task 7-7) ----------
  // A place whose siteInfo has "travel" ({group, kinds, toward}: a wagon
  // company's camp) moves as one: its rooms, and everyone and everything in
  // them, go to another region by routes of its kinds only. The player's
  // words must set out and speak for the party ("we", "the company", "the
  // wagons", "roll on"); the destination is a region they name. Its leader
  // (or a favored member) can take it anywhere; anyone else only along the
  // way it is already heading ("toward"). → null, { refused }, { failed }, or
  // a journey: { camp, destRegion, destName, dest (the player's room), trip,
  // roll, companions: [] }.
  const PARTY = /\b(we|us|our|everyone|all of us|the (?:company|wagons?|train|outfit|party|camp)|roll (?:out|on)|move on|break camp|hitch up)\b/i;
  const CAMP_GOES = /\b(roll (?:out|on)|move on|break camp|hitch up|push on|press on|head (?:out|on|west|east|north|south))\b/i;
  Eng.travelOf = (state, site) => (site && ((state.scenario.siteInfo || {})[site] || {}).travel) || null;
  Eng.campJourneyFor = function (state, intentObj, action, step) {
    const site = E.Sites.playerSite(state);
    const t = Eng.travelOf(state, site);
    if (!t || !(Eng.setsOut(action) || CAMP_GOES.test(String(action || ''))) || !PARTY.test(String(action || ''))) return null;
    const from = Eng.playerRegion(state);
    const chain = E.Scenario.regionChainIn(state.scenario.regions, from);
    const bare = (n) => String(n).replace(/\s*\(.*\)\s*$/, '');
    const named = (state.scenario.regions || []).filter((r) => r && !chain.includes(r.id) && Eng.regionKnown(state, r.id) && (mentionsName(action, r.name) || mentionsName(action, bare(r.name))))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!named) return null;
    const dest = named.id;
    const kinds = Array.isArray(t.kinds) ? t.kinds : null;
    const trip = Eng.regionTrip(state, from, dest, { kinds });
    if (!trip.blocked && !(trip.hours > 0)) return null;
    const role = t.group ? E.Standing.roleOf(state, t.group) : 'leader';
    if (role !== 'leader' && role !== 'favored' && t.toward && dest !== t.toward) {
      const way = Eng.regionTrip(state, from, t.toward, { kinds, all: true });
      const onWay = (way.legs || []).some((e) => E.Scenario.regionChainIn(state.scenario.regions, e.to).includes(dest));
      if (!onWay) return { refused: `${E.Standing.groupName(state, t.group)} is heading for ${(Eng.regionDef(state, t.toward) || {}).name || t.toward}; only its leader can turn it toward ${named.name}` };
    }
    const pc = state.characters[state.player];
    let roll = null;
    if (trip.blocked) {
      if (!trip.risky || !trip.closed) return { refused: trip.why };
      roll = { skill: trip.closed.skill, roll: Eng.roll(pc, trip.closed.skill, 'hard', state.scenario, 0) };
      if (/failure/.test(roll.roll.result)) return { failed: roll, why: trip.why };
    }
    return { camp: site, destRegion: dest, destName: named.name, dest: pc.status.location, trip, roll, companions: [] };
  };
  // The camp's rooms move to a region (and its place with them).
  Eng.moveCamp = function (state, site, region) {
    Object.values(state.locations).filter((l) => l.site === site).forEach((l) => { l.region = region; });
    if (state.sites && state.sites[site]) state.sites[site].region = region;
  };
  // The regions a journey's legs reached in its first `hours`.
  Eng.legsPassed = (trip, hours) => {
    let done = 0;
    const out = [];
    for (const e of trip.legs || []) { if (done + e.hours > hours + 1e-6) break; done += e.hours; out.push(e.to); }
    return out;
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
    const left = Math.round(Math.max(0, journey.trip.hours - hoursDone) * 60);
    return transitAt(state, { region, toward: journey.dest, next: journey.dest, nextMinutes: left || null, back: origin, backMinutes: Math.round(hoursDone * 60) || null });
  }
  // A room on the way (R-10): toward is where the trip goes (for its name),
  // next and back the rooms it links to, with the minutes each way (null:
  // the usual time for a trip link).
  function transitAt(state, o) {
    const dest = state.locations[o.toward];
    let id = 'on-the-way';
    for (let n = 2; state.locations[id]; n++) id = `on-the-way-${n}`;
    const rname = (Eng.regionDef(state, o.region) || {}).name || o.region;
    const link = (to, m) => Object.assign({ to, kind: 'trip' }, m ? { time: `${m}m` } : {});
    state.locations[id] = {
      id, name: E.shorten(`On the way to ${dest.name}`, 40), desc: `Somewhere on the way to ${dest.name}${rname ? `, in ${rname}` : ''}.`, outside: true, region: o.region, site: id, transit: true,
      connects: [o.next, o.back], links: [link(o.next, o.nextMinutes), link(o.back, o.backMinutes)],
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
    if (j.camp) {
      // The camp travels (task 7-7): it stops where its legs got to.
      const passed = Eng.legsPassed(j.trip, plan.hours);
      const at = plan.hours >= j.trip.hours ? j.destRegion : passed[passed.length - 1] || Eng.playerRegion(state);
      Eng.moveCamp(state, j.camp, at);
      const where = (Eng.regionDef(state, at) || {}).name || at;
      guard(res, 'resolve', 'journey', at === j.destRegion ? `the camp reached ${j.destName} after ${E.Scenario.sayHours(j.trip.hours)}`
        : `the camp stopped ${E.Scenario.sayHours(plan.hours) || 'early'} into ${E.Scenario.sayHours(j.trip.hours)} on the way to ${j.destName}, at ${where}`);
      return;
    }
    const arrived = plan.reason === 'arrive' || (plan.stage && plan.stage.hours >= j.trip.hours);
    const to = arrived ? j.dest : transitRoom(state, j, plan.hours, frame.startLoc);
    [state.player].concat(j.companions).filter((id) => Eng.alive(state, id)).forEach((id) => { Eng.setLocation(state, id, to); });
    // The trip still to go (R-10), for "keep going" and Travel there.
    if (arrived) delete state.travel;
    else state.travel = { dest: j.dest, destName: state.locations[j.dest].name, turn: state.turn };
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
    let plan = Eng.planMajorSkip(state, action, { covered: !!(journey && journey.camp) });
    // A journey ends on arrival, unless something stops it first.
    if (journey) {
      if (plan.hours >= journey.trip.hours) plan = { hours: journey.trip.hours, reason: 'arrive' };
      // A stage of the way with an arrival event (task 7-7) stops the journey
      // there, and the event is what happens.
      const stage = E.Timeline.stageOnTrip(state, journey.trip.legs);
      if (stage && stage.hours <= plan.hours) plan = { hours: stage.hours, reason: 'canon', canon: { id: stage.ev.id }, stage };
      plan.journey = journey;
      Eng.legsPassed(journey.trip, plan.hours).forEach((r) => Eng.noteReached(state, r));
    }
    // A camp that travels (task 7-7) eats at its fires and sleeps in its
    // wagons: its routine covers the body's needs, whatever the words said.
    const routine = { climb: journey && journey.camp ? [] : Eng.unmetNeeds(state, action) };
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
      // A camp (task 7-7) goes to a region and takes its people with it.
      const destName = journey.camp ? journey.destName : state.locations[journey.dest].name;
      const where = journey.camp ? destName : `${destName} in ${reg(journey.dest)}`;
      frame.stepLabel = `the journey to ${destName}`;
      frame.journey = `travelling from ${reg(frame.startLoc)} to ${where}: ${Eng.sayTrip(state, journey.trip)}, ${E.Scenario.sayHours(journey.trip.hours)} in all${journey.camp ? `, the whole camp moving together (${E.Standing.groupName(state, Eng.travelOf(state, journey.camp).group)} and everyone in it)` : journey.companions.length ? `, with ${journey.companions.map((id) => state.characters[id].name).join(', ')}` : ''}`;
      if (journey.roll) frame.journey += `; got past although ${journey.trip.why}`;
      if (plan.stage && plan.stage.hours < journey.trip.hours) frame.journey += `. It stops at ${(Eng.regionDef(state, plan.stage.region) || {}).name || plan.stage.region}, ${E.Scenario.sayHours(plan.hours)} in`;
      else if (plan.reason !== 'arrive' && !plan.stage) frame.journey += `. It is cut short ${E.Scenario.sayHours(plan.hours) || 'early'} in`;
      else frame.arrival = destName;

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
    } else if (plan.reason === 'ending') {
      // the time an ending was set for (checked below)
    } else if (plan.reason !== 'clock') {
      const m = obj.major_event && typeof obj.major_event.text === 'string' ? obj.major_event : { text: 'Something goes badly wrong, and the routine ends.' };
      const text = E.clip(m.text, 240);
      const scope = ['regional', 'world'].includes(m.scope) ? m.scope : 'local';
      const effects = applyEffects(state, m.effects, scope, res);
      const region = eventRegion(state, m, scope, res);
      // Who it hurts: people it names or who are where it happens.
      const where = plan.onPlayer ? state.characters[state.player].status.location : Eng.resolveLocation(state, m.where, false);
      const hit = new Set((Array.isArray(m.who) ? m.who : []).filter((id) => state.characters[id])
        .concat([state.player].concat(Eng.cast(state, { alive: true, includePlayer: false })).filter((id) => where && Eng.isAt(state, id, where))));
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
      // Their routine has placed them; only the story moves them from it (task G-8).
      if (c.routine && !(res.major && mentions(res.major.text, c))) return guard(res, 'resolve', 'position dropped', `${c.name} keeps to their routine`);
      const why = Eng.moveProblem(state, p.id, c.status.location, loc);
      if (why) return guard(res, 'resolve', 'move blocked', `${c.name} → ${loc}: ${why}`);
      Eng.setLocation(state, p.id, loc);
    });
    // The player ends up somewhere else only if their plan names it (rule 3;
    // playtest-agenda-skips: "keep to routine" put Kit outside as the storm hit).
    const pw = journey ? null : Eng.resolveLocation(state, obj.player_where, false);
    if (journey) endJourney(state, plan, frame, res);
    // Arriving somewhere hidden, or a major event naming it, reveals it (R-5).
    if (res.major && res.major.text) Eng.revealNamed(state, res.major.text, res, 'the event that ends the downtime names it');
    // A routine plan puts the player where their routine has them (task G-8).
    const usual = !journey && !plan.crisis && (!String(action || '').trim() || ROUTINE_PLAN.test(String(action).toLowerCase())) ? Eng.routineAt(state, state.player, state.time) : null;
    if (usual && usual !== 'away' && !Eng.moveProblem(state, state.player, frame.startLoc, usual)) {
      Eng.setLocation(state, state.player, usual);
      if (usual !== frame.startLoc) guard(res, 'resolve', 'routine day', `the plan keeps to routine: ${state.locations[usual].name}`);
    } else if (pw && pw !== frame.startLoc) {
      if (planNames(state, action, pw)) state.characters[state.player].status.location = pw;
      else guard(res, 'resolve', 'move cancelled', `the downtime put the player in ${pw}; their plan doesn't take them there`);
    }
    Eng.revealAround(state, res);
    // An ending the engine checks closes the downtime's scene; one set for
    // this time that doesn't hold lets the time pass quietly.
    if (Eng.checkEndings(state, res)) res.major = res.major || { text: `${res.ending.title}: ${res.ending.why}.`, scope: 'ending' };
    else if (plan.reason === 'ending') res.major = { text: `${E.fmtTime(state)} comes and goes.`, scope: 'quiet' };
    // A journey's arrival is a visit, as in a played turn.
    E.Sites.noteVisit(state, frame.startLoc);
    E.Sites.noteRegionVisit(state, frame.startLoc);
    // The agenda that ends the downtime brings its person to the player.


    if (plan.reason === 'agenda') {
      const c = state.characters[plan.agenda.id];
      if (activeAgenda(c) && c.agenda.due) {
        Eng.setLocation(state, c.id, state.characters[state.player].status.location);
        E.Memory.addFact(state, { about: [c.id], text: res.major.text, known_by: [c.id, state.player], weight: 2 });
        completeStep(state, c, res, 'ends the downtime');
      }
    }
    // The person who has had enough comes to the player, and the slate is clean.
    if (plan.reason === 'reckoning') {
      const c = state.characters[plan.reckoning.id];
      Eng.setLocation(state, c.id, state.characters[state.player].status.location);
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
    if (res.ending) state.log.push({ turn: state.turn, type: 'ending', id: res.ending.id, title: res.ending.title, kind: res.ending.kind });
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

  // Token caps that fit the turn (task L-2), for the local model (hosted
  // backends get a flat, generous one: LLM.hostedJSONTokens). The intent:
  // the player block, one entry per person here, and the extras the turn
  // asks for; a player alone still gets the player block and an event or two
  // (the Seiryo rerun hit 260 on its own). The update grows with the people
  // present and the length of the step: compact replies in the recordings
  // ran 60–300 tokens, and an hour with two others in Seiryo past 520.
  Eng.INTENT_ALONE = 360;
  Eng.intentTokens = (state, front, due) => (front.length ? 260 : Eng.INTENT_ALONE) + 150 * front.length
    + 60 * Eng.standeesAt(state, state.characters[state.player].status.location).length + 80 * Eng.agendasDue(state).length
    + (due.regional ? 120 : 0) + (due.world ? 140 : 0) + 120 * (due.canon || []).length;
  Eng.UPDATE_TOKENS = { base: 360, perPerson: 80, people: 6, step: { minute: 0, moment: 0, hour: 120, hours: 180, morning: 240, major: 240 } };
  Eng.updateTokens = (state, present, stepId) => {
    const U = Eng.UPDATE_TOKENS;
    const others = (present || []).filter((id) => id !== state.player).length;
    // Never past the reply the context tier leaves room for (800 at 8K).
    return Math.min(E.contextTier().reply, U.base + U.perPerson * Math.min(others, U.people) + (U.step[stepId] ?? U.step.hour));
  };

  // ---------- smaller calls (task L-3) ----------
  // On the local model the intent and the update are several short calls,
  // each asking for one thing; their replies merge into the object the single
  // call returns, so everything after them is the same. A part that fails
  // costs that part (a guard), not the turn; only the player's part failing
  // fails the turn, as the single intent does.
  Eng.smallerCalls = (step) => !!E.LLM.backendFor(step).smaller;
  Eng.PAIR_ABOVE = 4; // more people than this in the scene: two to a call
  Eng.SPLIT_TOKENS = { player: 200, person: 170, pair: 300, facts: 300, statePerPerson: 50, state: 120, feelings: 100, feelingsPerPerson: 40 };
  // The events call is skipped for a minute or a few minutes when nothing is
  // due: the single prompt already asks for none there.
  Eng.eventsDue = (state, stepId, due, action) => !['minute', 'moment'].includes(stepId) || !!(due.regional || due.world || (due.canon || []).length || due.crisis || due.reckoning)
    || Eng.agendasDue(state).length > 0 || E.Prompts.commandable(state).length > 0 || E.Prompts.groupsHere(state, action).length > 0;

  // → the intent object. o: { system, present, front, action, step, due, phase, early (guards) }.
  Eng.intentCalls = async function (state, o) {
    const { system, present, front, action, step, due } = o;
    const P = E.Prompts;
    if (!Eng.smallerCalls('intent')) {
      return E.LLM.chatJSON({ kind: 'intent', expect: ['player', 'intents'], system, user: P.intent(state, present, action, step.label, step.id, due, front), maxTokens: Eng.intentTokens(state, front, due), temperature: 0.7 });
    }
    const T = Eng.SPLIT_TOKENS;
    const args = [state, present, action, step.label, step.id, due, front];
    o.phase('Judging your action…');
    const mine = await E.LLM.chatJSON({ kind: 'intent:player', system, user: P.intentPart(...args, { part: 'player' }), maxTokens: T.player, temperature: 0.7 });
    const player = mine && typeof mine.player === 'object' ? mine.player : mine;
    const out = { player, intents: [] };
    const groups = [];
    for (let i = 0; i < front.length; i += front.length > Eng.PAIR_ABOVE ? 2 : 1) groups.push(front.slice(i, i + (front.length > Eng.PAIR_ABOVE ? 2 : 1)));
    for (const who of groups) {
      o.phase(`${who.map((id) => state.characters[id].name).join(' and ')} deciding…`);
      try {
        const r = await E.LLM.chatJSON({ kind: 'intent:char', system, user: P.intentPart(...args, { part: 'chars', who, player }), maxTokens: who.length > 1 ? T.pair : T.person, temperature: 0.7 });
        const got = (Array.isArray(r && r.intents) ? r.intents : [r]).filter((x) => x && typeof x === 'object' && who.includes(x.id));
        who.forEach((id) => out.intents.push(got.find((x) => x.id === id) || { id, action: 'stays where they are, watching', visible: true }));
      } catch (err) {
        who.forEach((id) => out.intents.push({ id, action: 'stays where they are, watching', visible: true }));
        guard(o.early, 'resolve', 'intent part failed', `${who.join(', ')}: ${err.message}`);
      }
    }
    if (Eng.eventsDue(state, step.id, due, action)) {
      o.phase(due.world ? 'The wider world stirs…' : due.regional ? 'Something stirs nearby…' : 'The world moves…');
      try {
        const ev = await E.LLM.chatJSON({ kind: 'intent:events', system, user: P.intentPart(...args, { part: 'events', player, intents: out.intents }),
          maxTokens: Eng.intentTokens(state, [], due) - Eng.INTENT_ALONE + 260, temperature: 0.7 });
        P.INTENT_PARTS.events.forEach((k) => { if (ev && ev[k] !== undefined) out[k] = ev[k]; });
      } catch (err) {
        guard(o.early, 'resolve', 'intent part failed', `events: ${err.message}`);
      }
    }
    return out;
  };

  // → the update object. o: { system, action, res, prose, present, cut, stepId }.
  Eng.updateCalls = async function (state, o) {
    const P = E.Prompts;
    const args = [state, o.action, o.res, o.prose, o.present, o.cut];
    if (!Eng.smallerCalls('update')) {
      return E.LLM.chatJSON({ kind: 'update', expect: ['facts', 'state', 'relations', 'player_attitude'], system: o.system, user: P.update(...args), maxTokens: Eng.updateTokens(state, o.present, o.stepId), temperature: 0.3 });
    }
    const T = Eng.SPLIT_TOKENS;
    const others = Math.min((o.present || []).filter((id) => id !== state.player).length, Eng.UPDATE_TOKENS.people);
    const cap = (n) => Math.min(E.contextTier().reply, n);
    const tokens = {
      facts: cap(T.facts),
      state: cap(T.state + T.statePerPerson * others + (Eng.UPDATE_TOKENS.step[o.stepId] ?? Eng.UPDATE_TOKENS.step.hour)),
      feelings: cap(T.feelings + T.feelingsPerPerson * others),
    };
    const out = {};
    const failed = [];
    for (const part of Object.keys(P.UPDATE_PARTS)) {
      try {
        const r = await E.LLM.chatJSON({ kind: `update:${part}`, system: o.system, user: P.updatePart(...args, part), maxTokens: tokens[part], temperature: 0.3 });
        P.UPDATE_PARTS[part].keys.forEach((k) => { if (r && r[k] !== undefined) out[k] = r[k]; });
      } catch (err) {
        failed.push(part);
        guard(o.res, 'memory', 'update part failed', `${part}: ${err.message}`);
      }
    }
    if (failed.length === Object.keys(P.UPDATE_PARTS).length) throw new Error('every part of the update failed');
    return out;
  };

  // The soft stop (task L-2): a streamed scene ends at the first paragraph
  // break where it has said enough, instead of running on to the token cap
  // mid-sentence (the Seiryo rerun: 500 words and 9 beats for 100–200 and 3,
  // so the cut lost the paragraph where Ozaki met Sora). t: { words: [low,
  // top], beats: [low, top] or null, span: the last marker allowed, in
  // minutes, or null, names: Eng.peopleWords }. It stops after the paragraph
  // that reaches the top word count; before a paragraph opening a beat past
  // the top or a marker past the span; and, once the scene has its lower
  // word count or beats, before a finished paragraph that is the player's
  // own line or action. A beat past the top waits while t.unplayed(text) still
  // lists something (task L-4: the stop cut scenes before their outcomes); the
  // word count and the span still end them. → { at, why } or null.
  Eng.softStop = function (text, t) {
    const s = String(text || '');
    const words = (x) => x.replace(markRe('gi'), ' ').split(/\s+/).filter(Boolean).length;
    const re = /\n[ \t]*\n\s*/g;
    let m, start = 0, said = 0, beats = 0, before = -1;
    while ((m = re.exec(s))) {
      const para = s.slice(start, m.index);
      start = re.lastIndex;
      if (!para.trim()) continue;
      const enough = said >= t.words[0] || (!!t.beats && beats >= t.beats[0]);
      if (before >= 0 && enough && Eng.playerParagraph(para, t.names)) return { at: before, why: "the player's own line" };
      said += words(para);
      beats += (para.match(markRe('gi')) || []).length;
      if (said >= t.words[1]) return { at: m.index, why: `${said} words` };
      const next = Eng.markerAt(s.slice(start));
      const unplayed = () => t.unplayed && t.unplayed(s.slice(0, m.index)).length;
      if (next != null && t.beats && beats >= t.beats[1] && !unplayed()) return { at: m.index, why: `${beats} beat${beats > 1 ? 's' : ''}, all that was asked` };
      if (next != null && t.span && next > t.span) return { at: m.index, why: `a marker past [+${t.span}m]` };
      before = m.index;
    }
    return null;
  };
  // What a scene left out (task L-4): the player's action, and anyone visible
  // who speaks or rolls. NemoMix took the action as done and carried on from
  // the last scene, so nothing was smiled at and no photo taken. Only what is
  // clearly missing counts, since a rewrite costs a narrate call: a quoted line
  // or a move is the narrator's to phrase (the room is checked elsewhere), and
  // common verbs prove nothing. One-beat scenes only (Eng.oneBeat): a longer
  // one compresses and paraphrases, and in the recordings the check there
  // mostly fired on good scenes. → a list of things to say to the narrator.
  const SCENE_STEM = (w) => w.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
  const SCENE_PLAIN = new Set('look talk speak answer reply try attempt want keep stay wait think decide go get ask say tell show help check'.split(' ').map(SCENE_STEM));
  const KIN = { mother: ['mom', 'mum', 'mama'], father: ['dad', 'papa'], grandmother: ['grandma', 'granny'], grandfather: ['grandpa'] };
  Eng.oneBeat = (stepId) => (E.Prompts.LENGTH.beats[stepId] || [])[1] === 1;
  Eng.sceneMissing = function (state, prose, res, action) {
    const said = new Set(String(prose || '').toLowerCase().match(/[a-z']+/g) || []);
    const heard = new Set([...said].map(SCENE_STEM));
    const me = state.characters[state.player];
    const mine = new Set(namesOf(me).join(' ').split(/\s+/));
    // Two words need both ("smile", "camera": the last scene left the camera
    // in view); more need half. A name, or nickname, that is in the scene will do.
    const shown = (t) => {
      if ((String(t || '').slice(1).match(/[A-Z][a-z'-]+/g) || []).some((x) => prose.includes(x))) return true;
      const all = [...contentWords(t)].filter((x) => !mine.has(x));
      const w = [...new Set(all.map(SCENE_STEM))].filter((x) => !SCENE_PLAIN.has(x));
      const hits = w.filter((x) => heard.has(x)).length;
      return !w.length || (w.length > 2 ? hits * 2 >= w.length : hits === w.length);
    };
    const missing = [];
    (res.outcomes || []).forEach((o) => {
      const c = state.characters[o.id];
      if (!c) return;
      if (o.id === state.player) {
        if (!o.moved && !/["“]/.test(action || '') && !shown(action) && !shown(o.action)) missing.push(`your action: ${action}`);
        return;
      }
      if (o.visible === false || (!o.says && !o.roll)) return;
      const words = namesOf(c).join(' ').split(/\s+/).concat([...contentWords(c.role)]);
      words.slice().forEach((w) => (KIN[w] || []).forEach((k) => words.push(k)));
      if (!words.some((w) => said.has(w)) && !(o.says && shown(o.says))) missing.push(`${c.name}: ${o.says ? `says ${o.says}` : o.action}`);
    });
    return missing;
  };
  // The low and top of a range in words ("100–200").
  const range = (r) => { const n = String(r).match(/\d+/g) || ['0']; return [Number(n[0]), Number(n[n.length - 1])]; };
  // A narration call's stopAt, and onText for the phase line ("… 140 words").
  const streamOpts = (state, phase, label, t) => {
    let shown = -1;
    return {
      stopAt: (text) => Eng.softStop(text, Object.assign({ names: Eng.peopleWords(state), beats: null, span: null }, t)),
      onText: (text) => {
        const n = text.split(/\s+/).filter(Boolean).length;
        if (Math.floor(n / 10) !== shown) { shown = Math.floor(n / 10); phase(`${label} ${n} words`); }
      },
    };
  };

  async function writeSkipScene(state, n, p, phase) {
    phase('Writing the downtime…');
    const prose = Eng.cleanScene(await sceneCall(Object.assign({
      kind: 'narrate', system: n.system, user: E.Prompts.narrateSkip(state, n.action, p.frame, n.montage, n.doings, p.res, n.presentStart),
      maxTokens: Math.round(E.settings.narrateTokens * 2.2),
    }, streamOpts(state, phase, 'Writing the downtime…', { words: range(E.Prompts.LENGTH.downtime.words), beats: E.Prompts.LENGTH.downtime.beats, span: p.frame.spanMinutes })), p.res), p.res, state);
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
    const target = { words: range(frame.words || E.Prompts.LENGTH.scene.words), beats: E.Prompts.LENGTH.beats[frame.stepId] || E.Prompts.LENGTH.beats.hour, span: frame.spanMinutes, unplayed: Eng.oneBeat(frame.stepId) ? (text) => Eng.sceneMissing(state, text, res, action) : null };
    const narrateOnce = async () => Eng.cleanScene(await sceneCall(Object.assign({
      kind: frame.correction ? 'narrate (retry)' : 'narrate', system, user: E.Prompts.narrate(state, present, action, frame, res),
      maxTokens: Math.round(E.settings.narrateTokens * (step.lengthMult || 1)),
    }, streamOpts(state, phase, frame.correction ? 'Rewriting the scene…' : 'Writing the scene…', target)), res), res, state);
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
      const again = retry && Eng.findRelocation(state, retry, frame.startLoc, via);
      if (retry && !again) prose = retry;
      else if (again) {
        // The rewrite strays too (playtest-seiryo-bad-model: it walked Sora
        // into Class 1-B and was kept): the scene stops before the move.
        const kept = [Eng.untilRelocation(state, retry, frame.startLoc, via), Eng.untilRelocation(state, prose, frame.startLoc, via)]
          .sort((a, b) => b.length - a.length)[0];
        guard(res, 'scene', 'relocation cut', `the rewrite took the player ${again.to || `to ${again.name}`} too; ${kept ? 'the scene stops before that' : 'nothing came before it, so it stays'}`);
        prose = kept || retry;
      }
    }
    if (!prose) throw new Error('The model returned an empty scene.');
    // One rewrite for a turn (task L-4): after a relocation retry, the scene stands.
    const left = strayed || !Eng.oneBeat(frame.stepId) ? [] : Eng.sceneMissing(state, prose, res, action);
    if (left.length) {
      guard(res, 'scene', 'outcome regenerated', `the first draft left out ${left.join('; ')}`);
      phase('Rewriting the scene…');
      frame.correction = `Your previous draft left this out: ${left.join('; ')}. It happens in this scene, as RESOLVED says.`;
      const retry = await narrateOnce();
      const better = retry && !Eng.findRelocation(state, retry, frame.startLoc, via) && Eng.sceneMissing(state, retry, res, action).length < left.length;
      if (better) prose = retry;
      else guard(res, 'scene', 'outcome still missing', 'the rewrite was no better, so the first draft stands');
    }

    let beats = Eng.parseBeats(prose, frame.spanMinutes);
    let until;
    if (Eng.LOOSE_STEPS.includes(step.id)) {
      const lastAt = beats[beats.length - 1].at;
      if (lastAt < frame.spanMinutes / 2) {
        phase('Finishing the scene…');
        const more = Eng.cleanScene(await sceneCall(Object.assign({
          kind: 'narrate (continue)', system, user: E.Prompts.narrateMore(state, present, action, frame, res, markedBeats(beats), lastAt),
          maxTokens: Math.round(E.settings.narrateTokens * 0.8),
        }, streamOpts(state, phase, 'Finishing the scene…', { words: range(E.Prompts.LENGTH.more.words), beats: E.Prompts.LENGTH.more.beats, span: frame.spanMinutes })), res), res, state);
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
    if (Eng.ended(state)) throw new Error('This story has reached an ending. Choose Keep playing to go on, or start a new game.');
    // The scene that ended the story plays out whole when the player goes on.
    if (state.ending && state.pending && state.ending.turn === state.pending.turn) cutAt = null;
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
    const t = { kind, turn, action: action || '', stepId, calls: [], guards: [], lore: [], facts: [], ms: 0, started: Date.now() };
    E.LLM.collector = t.calls;
    E.Lore.collector = t.lore;
    E.Memory.collector = t.facts;
    return t;
  }
  function finishReport(t, guards, err) {
    if (E.LLM.collector === t.calls) E.LLM.collector = null;
    if (E.Lore.collector === t.lore) E.Lore.collector = null;
    if (E.Memory.collector === t.facts) E.Memory.collector = null;
    t.ms = Date.now() - t.started;
    t.guards = guards || [];
    if (err) t.error = String(err.message || err);
    Eng.telemetry.push(t);
    if (Eng.telemetry.length > Eng.telemetryMax) Eng.telemetry.shift();
    tallyGuards(t.guards);
  }
  // How often each guard has fired, across every game on this machine: the
  // evidence for retiring one (rule 1 wants a reason). Kept in E.Prefs.
  const GUARD_TALLY = 'ensemble.guardTally';
  function tallyGuards(guards) {
    try {
      const old = E.Prefs.get(GUARD_TALLY) || {};
      const types = Object.assign({}, old.types);
      guards.forEach((g) => { types[g.type] = (types[g.type] || 0) + 1; });
      Promise.resolve(E.Prefs.set(GUARD_TALLY, { turns: (old.turns || 0) + 1, types })).catch(() => {});
    } catch (e) { /* a tally is never worth a turn */ }
  }
  // The tally as text, most fired first.
  Eng.guardTally = function () {
    const t = E.Prefs.get(GUARD_TALLY) || {};
    const rows = Object.entries(t.types || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [`Guards over ${t.turns || 0} turns:`].concat(rows.map(([k, n]) => `${n}  ${k}`)).join('\n');
  };

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
      // How the calls ended (task L-2): on their own, at a soft stop, or at the cap.
      complete: t.calls.filter((c) => !c.error && c.finish !== 'length' && c.finish !== 'stopped').length,
      stopped: t.calls.filter((c) => c.finish === 'stopped').length, cutOff: t.calls.filter((c) => c.finish === 'length').length,
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
    lines.push(`Ended: ${tot.complete} complete, ${tot.stopped} stopped at a paragraph, ${tot.cutOff} cut off`);
    t.calls.forEach((c) => {
      const extra = [];
      if (c.cachedTokens != null) extra.push(`${c.cachedTokens} cached`);
      if (c.perf) extra.push(`prompt ${c.perf.processSec.toFixed(1)} s, gen ${c.perf.evalSec.toFixed(1)} s`);
      if (c.grammar) extra.push(`grammar ${c.grammar} chars`);
      if (c.jsonMode) extra.push('JSON mode');
      if (c.finish === 'length') extra.push('cut off');
      if (c.finish === 'stopped') extra.push(`stopped at a paragraph: ${c.stopped}`);
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
    if ((t.facts || []).length) {
      lines.push('Facts included:');
      t.facts.forEach((f) => lines.push(`- ${f.call} · ${f.compartment}: ${f.count} (~${f.tokens} tokens)`));
    }
    if (t.outcomes && t.outcomes.length) {
      lines.push('What happened:');
      t.outcomes.forEach((o) => lines.push('- ' + o));
    }
    if (t.scene) lines.push('Scene:', t.scene);
    return lines.join('\n');
  };

  const replaceState = (state, from) => { Object.keys(state).forEach((k) => delete state[k]); Object.assign(state, from); };

  // The closing scene of a judged ending: one narration call from the last
  // scene, logged as the ending's own entry.
  async function closeStory(state, phase) {
    phase('Closing the story…');
    const raw = await E.LLM.chat(Object.assign({ kind: 'narrate', system: E.Prompts.header(state), user: E.Prompts.closing(state, state.ending), maxTokens: Math.round(E.settings.narrateTokens * 1.2), temperature: 0.8 },
      streamOpts(state, phase, 'Closing the story…', { words: range(E.Prompts.LENGTH.closing.words) })));
    const text = Eng.cleanProse(String(raw && raw.text != null ? raw.text : raw || '')).replace(/^\[\+?\d+[mhd]\]\s*/gm, '').trim();
    state.ending.closed = true;
    state.log.push({ turn: state.ending.turn, type: 'ending', id: state.ending.id, title: state.ending.title, kind: state.ending.kind, text });
    phase('');
  }

  async function playTurn(state, action, stepId, phase, cutAt) {
    const report = await Eng.commitPending(state, cutAt, phase);
    if (state.flags.gameOver) { phase(''); return { report, ended: true }; }
    // A judged ending found in the scene just recorded: a closing scene
    // instead of this action (the page puts the action back in the box).
    if (Eng.ended(state) && state.ending.closing && !state.ending.closed) {
      await closeStory(state, phase);
      return { report, ended: true, ending: state.ending, held: action };
    }
    Eng.clearTransit(state);
    // Facts the player learned last turn may name a hidden region (R-5).
    const early = { guards: [] };
    Eng.revealAround(state, early);
    // A flavour place where danger has come grows into a tactical one (R-8).
    (await E.Sites.growIfDanger(state, phase)).forEach((t) => guard(early, 'resolve', 'site grown', t));
    if (stepId === 'major') {
      // A trip on this step is the whole journey (R-10), interrupted the way a skip is.
      const journey = Eng.majorJourney(state, action);
      const out = await skipTurn(state, action, phase, journey ? { journey, notes: [{ type: 'journey', detail: `${Eng.sayLeft(journey.trip.hours * 60)} to ${state.locations[journey.dest].name}: the turn is the journey` }] } : undefined);
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
      Eng.setLocation(state, reckon.id, state.characters[state.player].status.location);
      state.ignored = [];
    }
    const present = Eng.present(state);
    // Who takes part this turn in a crowded room (task 7-2); the rest are in the background.
    const front = Eng.sceneFront(state, present, action);
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
    const leaving = Eng.routineLeaving(state, present, step.hours);
    const intentObj = await Eng.intentCalls(state, { system, present, front, action, step, due, phase, early });

    const frame = { startTime: E.fmtTime(state), startLoc: state.characters[state.player].status.location, stepId: step.id, stepLabel: step.label, words: step.words, spanMinutes: Math.round(step.hours * 60) };
    // A new place the player is heading for (task 4-4), built before the
    // moves are resolved; the start-of-turn copy gets it too.
    const siteNotes = [];
    // The player's own words hand the hours to their routine (task G-8): the
    // engine plans the day, and the model's move doesn't count.
    const routineDay = Eng.routineDay(state, action, step, crisis);
    if (routineDay) {
      const p = intentObj && intentObj.player;
      if (p && typeof p === 'object') Object.assign(p, { move_to: null, new_place: null, new_region: null });
      siteNotes.push({ type: 'routine day', detail: Eng.sayDay(routineDay) });
    }
    // An unfinished trip going on, or dropped (R-10).
    const resumed = Eng.travelResume(state, intentObj, action);
    if (resumed) siteNotes.push(resumed);
    const placed = Eng.placeMove(state, intentObj, action);
    if (placed) siteNotes.push(placed);
    // A camp that travels (task 7-7) moves before any place is built: the
    // party sets out for a region, and nothing is built there for it.
    const camp = Eng.campJourneyFor(state, intentObj, action, step);
    if (camp && (camp.refused || camp.failed)) {
      siteNotes.push({ type: 'camp stays', detail: camp.refused || `turned back: ${camp.why}` });
      const p = intentObj && intentObj.player;
      if (p) { p.move_to = null; p.new_place = null; p.new_region = null; }
    } else if (!camp) {
      // A new region first (R-6), then a place to arrive at inside it.
      await E.Sites.regionForIntent(state, intentObj, action, pre, phase, siteNotes);
      await E.Sites.forIntent(state, intentObj, action, pre, phase, siteNotes);
    }
    // A camp's trip is a journey turn (task 7-7): back to the start of the
    // turn and on through the skip machinery, with the destination. Anyone
    // else's trip follows a travel plan as far as the step goes (R-10); the
    // whole journey is the "until something major happens" step.
    const journey = camp && !camp.refused ? camp : null;
    if (journey && !journey.failed) {
      const log = state.log;
      replaceState(state, Object.assign(pre, { log }));
      const notes = early.guards.map((g) => ({ type: g.type, detail: g.detail })).concat(siteNotes, timelineNotes, [{ type: 'journey', detail: `a trip of ${E.Scenario.sayHours(journey.trip.hours)} is longer than ${step.label}: the turn is the journey (the scene's intent call is set aside)` }]);
      const out = await skipTurn(state, action, phase, { journey, notes });
      out.report = report || { applied: [], rejected: [] };
      return out;
    }
    const res = Eng.resolve(state, intentObj, present, action, step.id, due, { crossingRoll: journey && journey.failed, front });
    res.guards.unshift(...early.guards);
    if (routineDay) {
      res.routineDay = routineDay;
      const o = res.outcomes.find((x) => x.id === state.player);
      if (routineDay.end !== frame.startLoc) {
        Eng.setLocation(state, state.player, routineDay.end);
        if (o) o.moved = routineDay.end;
      }
      if (o && routineDay.via.length) o.via = routineDay.via;
      if (o) o.action += ` (the day, planned by the engine: ${Eng.sayDay(routineDay)})`;
    }
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
    res.staying = Eng.routineStaying(state, action, present, res, intentObj && intentObj.intents, leaving);
    const before = timeSnapshot(state);
    Eng.advanceTime(state, step.hours, res);
    res.noticed = Eng.routineBreak(state, res, present);
    if (res.noticed) guard(res, 'resolve', 'routine noticed', `${res.noticed.line} (${Eng.inWords(state, res.noticed.id)})`);
    E.Sites.noteVisit(state, frame.startLoc);
    E.Sites.fade(state).forEach((t) => guard(res, 'resolve', 'site faded', t));
    E.Sites.noteRegionVisit(state, frame.startLoc);
    E.Sites.fadeRegions(state).forEach((t) => guard(res, 'resolve', 'region faded', t));
    // An ending the engine checks (a time, a timeline event, a pressure): this scene closes the story.
    Eng.checkEndings(state, res);

    // Everything Reroll needs to write this scene again from the same resolution.
    const narration = { system, step, before, after: timeSnapshot(state) };
    const { beats, until } = await writeScene(state, narration, { present, action, frame, res }, phase);
    const text = beatsText(beats);
    const startMinutes = Math.round(pre.time.hour * 60);
    state.log.push({ turn: state.turn, type: 'action', text: action, time: frame.startTime, until });
    state.log.push({ turn: state.turn, type: 'resolve', outcomes: res.outcomes, events: res.events });
    state.log.push(Object.assign({ turn: state.turn, type: 'scene', text, beats, startDay: pre.time.day, startMinutes }, res.travel && Eng.travelNote(res.travel) ? { travel: Eng.travelNote(res.travel) } : {}));
    if (res.ending) state.log.push({ turn: state.turn, type: 'ending', id: res.ending.id, title: res.ending.title, kind: res.ending.kind });
    state.recent = [{ turn: state.turn, action, text }];

    // Memory is recorded at the start of the next turn, once we know how
    // much of this scene the player let play out.
    const playerOut = res.outcomes.find((o) => o.id === state.player);
    Eng.noteSeen(state, res, state.turn);
    // A trip (R-10): its plan, who went along and the trip still to go, so a
    // step-in puts them where the plan has them at that minute.
    const travel = res.travel ? { plan: res.travel.plan, companions: res.outcomes.filter((o) => o.id !== state.player && o.moved && o.moved === playerOut.moved).map((o) => o.id), keep: state.travel ? E.clone(state.travel) : null } : null;
    state.pending = { turn: state.turn, action, res, frame, present, extrasPresent, beats, pre, playerMovedTo: playerOut && playerOut.moved, narration, travel, routineDay: res.routineDay };

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
