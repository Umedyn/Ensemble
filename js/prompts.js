// Prompt builders. Order matters for KoboldCpp's prompt cache:
//   system = static header (rules, setting, places, cast) + story so far + player-known facts
//   user   = everything that changes per call (status, secrets, scene, task)
// The system part is identical across the intent/narrate/update calls of a turn
// and only grows at the end between turns, so most of it is reused.
(function (root) {
  const E = root.Ensemble;
  const P = (E.Prompts = {});
  const Mem = () => E.Memory;
  const Eng = () => E.Engine;

  const name = (state, id) => (state.characters[id] ? state.characters[id].name : id);

  // ---------- blocks ----------
  // Every prompt is an ordered list of named blocks (P.layouts), each built by
  // one function in P.blocks from the prompt's context object. A block returns
  // its text (or a list of lines), or null to leave it out; '' still adds an
  // empty line. The parts are joined with newlines. Adding a block is one
  // function here plus one position in a layout.
  //
  // Cache rule (CLAUDE.md rule 7): the header is identical for every call in a
  // turn and only grows at its end between turns. Blocks whose content changes
  // during play may only come at the end of the header (P.LIVE_HEADER, in that
  // order) or go in a user message. Static content (setting, places, cast,
  // later genre, lore titles, geography) goes before them.
  const B = (P.blocks = {});
  P.layouts = {};
  P.LIVE_HEADER = ['regionsFound', 'newcomers', 'chapters', 'facts'];
  P.build = function (layout, ctx) {
    const parts = [];
    P.layouts[layout].forEach((id) => {
      const out = B[id](ctx, layout);
      if (out == null) return;
      if (Array.isArray(out)) parts.push(...out); else parts.push(out);
    });
    return parts.join('\n');
  };

  P.layouts.header = ['intro', 'setting', 'genre', 'rules', 'places', 'regions', 'groups', 'loreAlways', 'cast', 'regionsFound', 'newcomers', 'chapters', 'facts'];
  P.header = (state) => P.build('header', { state, sc: state.scenario, pc: state.characters[state.player] });

  B.intro = () => 'You are the simulation engine and narrator for an interactive, character-driven story.';
  B.setting = ({ sc }) => `\n=== SETTING: ${sc.worldTitle || sc.title} ===\n${sc.setting}`;
  // Genre tags and tone note (js/genres.js); static for a game.
  B.genre = ({ sc }) => {
    const lines = E.Genres.guidance(sc);
    return lines ? ['\n=== GENRE AND TONE ==='].concat(lines) : null;
  };
  B.rules = ({ state, sc, pc }) => {
    const rules = [
      'The story is told at a personal scale, through individual people. Groups and factions (organizations, crews, gangs, governments) still exist and act collectively: show how individual choices ripple out to them, and how their moves land on individuals. The player commands no faction.',
      `The player controls only ${pc.name} (id: ${state.player}). Never decide ${pc.name}'s choices, words or feelings beyond what the player's action states.`,
      E.Genres.consequences(sc),
      'Characters act from their own personality, wants, needs, secrets and feelings, not to serve the player.',
      // Small models coddle the player; impartiality keeps lethal worlds lethal.
      `Tell the story impartially. Do not flatter, protect or favour ${pc.name}: people judge them by what they do, plans can fail, luck does not bend their way, and the world's dangers reach them as they would anyone.`,
    ].concat(sc.rules || []);
    return ['\n=== RULES ==='].concat(rules.map((r) => '- ' + r));
  };
  // A room's region is shown only when the rooms are in more than one.
  // The authored rooms (sc.locations), so a way inferred in play (task 3-6)
  // never changes the header; the live ways are in the user message.
  // In a region-focused world (R-8) rooms are flavour: names and links here,
  // and the current room's description in the user message (inRoom).
  B.places = ({ state, sc }) => {
    const rooms = sc.locations && sc.locations.length ? sc.locations : Object.values(state.locations);
    const many = new Set(rooms.map((l) => l.region)).size > 1;
    const brief = E.Sites.mapFocus(sc) === 'region';
    return ['\n=== LOCATIONS ==='].concat(rooms.map((l) => {
      const c = l.connects && l.connects.length ? ` (connects: ${l.connects.join(', ')})` : '';
      return `- ${l.id}: ${l.name}${brief ? '' : ` — ${l.desc}`}${c}${many && l.region ? ` [region: ${l.region}]` : ''}`;
    }));
  };
  // "Corner Café — six tables and a chalkboard menu" in a region-focused
  // world (the header leaves descriptions out), else the name.
  const inRoom = (state, loc, id) => (loc ? `${loc.name}${E.Sites.mapFocus(state.scenario) === 'region' && loc.desc ? ` (${loc.desc.replace(/\.$/, '')})` : ''}` : id);
  // Static geography (task 3-1): names, neighbours and lore. Who holds a
  // region, its tags and status change in play, so they go in the user
  // message (regionLines), never here.
  // The outline (R-1): a big map (a whole world of countries, task 4-5) or a
  // deep tree keeps the detail near the start. P.regionOutline walks out from
  // the start's region along neighbours and the tree (parent and children):
  // the start's chain, what is within two steps and "notable" regions are
  // shown in full; the rest are a line of names, top-level ones first. It
  // all comes from the start's region, so the header is the same for the
  // whole game (rule 7). Named places on the map are listed with their region.
  P.REGIONS_FULL = 24;
  P.REGION_NAMES_MAX = 60;
  // Regions known at the start (R-5): none hidden, nor inside a hidden one.
  // Regions made during the story (R-6) aren't: they join the live block too.
  P.knownAtStart = (sc) => (sc.regions || []).filter((r) => r && !r.generated && !E.Scenario.regionChainIn(sc.regions, r.id).some((x) => ((sc.regions || []).find((y) => y.id === x) || {}).known === false));
  P.regionOutline = function (sc) {
    const list = P.knownAtStart(sc);
    if (list.length <= P.REGIONS_FULL) return { full: list, far: [], chain: null };
    const S = E.Scenario;
    const byId = new Map(list.map((r) => [r.id, r]));
    const order = new Map(list.map((r, i) => [r.id, i]));
    // The start's region, or (a place made for the start, R-7) the nearest
    // region it is inside that the outline has.
    const anchor = sc.region ? S.regionChainIn(sc.regions, sc.region).find((x) => byId.has(x)) : null;
    const chain = anchor ? S.regionChainIn(list, anchor) : [];
    const links = (id) => (byId.get(id).neighbours || []).concat(byId.get(id).parent != null ? [byId.get(id).parent] : [], S.regionChildrenIn(list, id));
    const hops = new Map();
    let frontier = chain.slice(0, 1);
    frontier.forEach((id) => hops.set(id, 0));
    for (let d = 1; frontier.length; d++) {
      const next = [];
      frontier.forEach((id) => links(id).forEach((n) => { if (byId.has(n) && !hops.has(n)) { hops.set(n, d); next.push(n); } }));
      frontier = next;
    }
    const hop = (r) => (hops.has(r.id) ? hops.get(r.id) : 1e9);
    // The chain first, then the nearest, then the siblings along the chain
    // (the other zone of a split country), then notable ones; shown in the
    // world's order.
    const besideChain = (r) => r.parent != null && chain.includes(r.parent);
    const rank = (r) => (chain.includes(r.id) ? -1 : hop(r) <= 2 ? hop(r) : besideChain(r) ? 3 : 4);
    const full = list.filter((r) => chain.includes(r.id) || hop(r) <= 2 || besideChain(r) || r.notable === true)

      .sort((a, b) => rank(a) - rank(b) || order.get(a.id) - order.get(b.id)).slice(0, P.REGIONS_FULL)
      .sort((a, b) => order.get(a.id) - order.get(b.id));
    const shown = new Set(full.map((r) => r.id));
    const top = (r) => (r.parent == null || !byId.has(r.parent) ? 0 : 1);
    const far = list.filter((r) => !shown.has(r.id))
      .sort((a, b) => top(a) - top(b) || hop(a) - hop(b) || (a.name < b.name ? -1 : 1))
      .slice(0, P.REGION_NAMES_MAX);
    return { full, far, chain };
  };
  // ", a part of town in Harmon", ", a town", " in Harmon" or "" (R-1): the
  // region's label and what it is inside, by name, in plain words.
  P.regionWhat = function (sc, id, withParent) {
    const r = (sc.regions || []).find((x) => x.id === id);
    if (!r) return '';
    const label = E.Scenario.regionLabel(sc, id);
    const parent = withParent && r.parent != null && (sc.regions || []).find((x) => x.id === r.parent);
    return (label ? `, ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}` : '') + (parent ? ` in ${parent.name}` : '');
  };
  B.regions = ({ sc }) => {
    const known = P.knownAtStart(sc);
    if (!known.length) return null;
    const { full, far, chain } = P.regionOutline(sc);
    const shown = new Set(known.map((r) => r.id));
    // A big world's outline gives borders only along the start's chain (task
    // 7-1: twenty arrondissements listing each other): the routes line in
    // each turn's message has the rest.
    const borders = (r) => !chain || chain.includes(r.id);
    const places = E.Scenario.mapPlaces(sc);
    const placesIn = (id) => places.filter((p) => p.region === id).map((p) => (p.kind === 'capital' ? `${p.name} (capital)` : p.name));
    const lines = ['\n=== REGIONS ==='].concat(full.map((r) => {
      const pl = placesIn(r.id);
      const nb = borders(r) ? (r.neighbours || []).filter((n) => shown.has(n)) : [];
      return `- ${r.id}: ${r.name}${P.regionWhat(sc, r.id, true)}${r.lore ? ` — ${r.lore}` : ''}${nb.length ? ` (neighbours: ${nb.join(', ')})` : ''}${pl.length ? ` [places: ${pl.join(', ')}]` : ''}`;
    }));
    if (far.length) lines.push(`Further away: ${far.map((r) => r.name).join(', ')}${known.length > full.length + far.length ? ', and others' : ''}.`);
    return lines;
  };
  // Live (R-5): regions found during the story, in the world's order. It
  // sits with the other live blocks at the end of the header (rule 7).

  B.regionsFound = ({ state, sc }) => {
    const start = new Set(P.knownAtStart(sc).map((r) => r.id));
    const found = (sc.regions || []).filter((r) => !start.has(r.id) && Eng().regionKnown(state, r.id));
    return found.length ? ['\n=== PLACES FOUND DURING THE STORY ==='].concat(found.map((r) => `- ${r.id}: ${r.name}${P.regionWhat(sc, r.id, true)}${r.lore ? ` — ${r.lore}` : ''}`)) : null;
  };
  B.groups = ({ sc }) => (sc.factions && sc.factions.length
    ? ['\n=== GROUPS ==='].concat(sc.factions.map((f) => `- ${f.id}: ${f.name} — ${f.desc}`))
    : null);
  // Lore (task 5-1): always-on world entries are static, so they sit in the
  // header; the rest are chosen per call and go in the user message (B.lore).
  B.loreAlways = ({ sc }) => {
    const always = E.Lore.always(sc);
    return always.length ? ['\n=== WORLD LORE ==='].concat(always.map(E.Lore.line)) : null;
  };
  // The player's room and region at the time of the call (the end of the
  // player's move, for the scene) and their words pick the entries.
  B.lore = ({ state, action }, layout) => {
    const picks = E.Lore.select(state, { action });
    E.Lore.note(layout, picks);
    return picks.length ? ['\n=== LORE (public knowledge; use it when it fits) ==='].concat(picks.map(E.Lore.line)) : null;
  };
  const castLine = (state, id) => {
    const c = state.characters[id];
    const tag = id === state.player ? ' (PLAYER)' : '';
    const bits = [`${c.name}${c.pronouns ? ` (${c.pronouns})` : ''}, ${c.role}${c.people ? ` (${c.people})` : ''}${c.age ? ', ' + c.age : ''}.`];
    if (c.traits && c.traits.length) bits.push(`Traits: ${c.traits.join(', ')}.`);
    if (c.want && id !== state.player) bits.push(`Wants: ${c.want}.`);
    if (c.voice) bits.push(`Voice: ${c.voice}`);
    return `- ${id}${tag}: ${bits.join(' ')}`;
  };
  // Static: the starting cast. People promoted from extras (task 2-3) are
  // listed in "newcomers" instead, so the cast block never changes.
  B.cast = ({ state }) => ['\n=== CAST ==='].concat(Eng().cast(state).filter((id) => state.characters[id].joined == null).map((id) => castLine(state, id)));
  // Live: grows when someone joins the cast during play.
  B.newcomers = ({ state }) => {
    const ids = Eng().cast(state).filter((id) => state.characters[id].joined != null);
    return ids.length ? ['\n=== CAST: JOINED DURING THE STORY ==='].concat(ids.map((id) => castLine(state, id))) : null;
  };
  // Live: grows at the end of the header between turns.
  B.chapters = ({ state }) => {
    const story = Mem().storyBlock(state);
    return story ? '\n=== STORY SO FAR ===\n' + story : null;
  };
  B.facts = ({ state }) => {
    const facts = Mem().factsBlock(state);
    return facts ? '\n=== ESTABLISHED FACTS (known to the player) ===\n' + facts : null;
  };

  function worldLines(state) {
    const w = Object.entries(state.world).map(([k, v]) => `${k}: ${v}`).join('; ');
    const clocks = Eng().liveClocks(state)
      .map((c) => `${c.name} ${c.fired ? '(HAPPENED)' : Math.floor(c.value) + '/' + c.max}`)
      .join('; ');
    const groups = (state.factions || []).map((f) => `${f.name}: ${f.stance}`).join('; ');
    return `World: ${w || 'nothing notable'}\nPressures: ${clocks || 'none'}` + (groups ? `\nGroups: ${groups}` : '') + regionLines(state);
  }
  // Site rules (task 3-6): the ways out of a room as they are now, and the
  // things in it (with their state). Only for worlds with site data.
  const hasSite = (state) => Object.values(state.locations).some((l) => (l.features || []).length || (l.links || []).length);
  function wayText(state, from, to) {
    const k = Eng().linkInfo(state, from, to);
    if (!k || k.kind === 'open') return state.locations[to].name;
    // A route to another place (task 4-4): a journey, not a door.
    if (k.kind === 'trip') return `${state.locations[to].name} (the way to ${((state.sites || {})[E.Sites.siteOf(state, to)] || state.locations[to]).name})`;
    const st = k.kind === 'locked door' && k.locked ? 'locked' : k.open ? 'open' : 'shut';
    return `${state.locations[to].name} (${k.kind === 'locked door' ? 'door' : k.kind}, ${st})`;
  }
  function siteLines(state, room) {
    if (!hasSite(state)) return '';
    const ways = Eng().linkedRooms(state, room).map((o) => wayText(state, room, o));
    const things = Eng().features(state, room).map((f) => f.name + (f.state ? ` (${f.state})` : ''));
    return `Ways from here: ${ways.join(', ') || 'none'}` + (things.length ? `\nThings here: ${things.join(', ')}` : '');
  }
  const lockedHere = (state) => {
    const here = state.characters[state.player].status.location;
    return Eng().linkedRooms(state, here).filter((o) => { const k = Eng().linkInfo(state, here, o); return k && k.locked; });
  };

  // The current state of the player's region, the regions it is inside (R-1:
  // a line a level, so depth costs little and the tree's size nothing) and
  // what's near (capped) only.
  function regionLines(state) {
    const near = Eng().nearbyRegions(state);
    if (!near.length) return '';
    const desc = (id, withLabel) => {
      const def = Eng().regionDef(state, id);
      const r = state.regions[id];
      const bits = [`held by ${Eng().regionHolder(state, id).text}`];
      // Who else is there (R-5), in words.
      const present = Eng().presenceText(state, id);
      if (present) bits.push(`present: ${present}`);
      if (r.tags.length) bits.push(`tags: ${r.tags.join(', ')}`);
      if (r.status) bits.push(r.status);
      return `${def.name}${withLabel ? P.regionWhat(state.scenario, id) : ''} (${id}): ${bits.join('; ')}`;
    };

    const up = Eng().regionChain(state, near[0]).slice(1);
    return `\nRegion: ${desc(near[0], true)}` + (up.length ? `\nInside: ${up.map((id) => desc(id, true)).join(' › ')}` : '')
      + (near.length > 1 ? `\nNearby: ${near.slice(1).map((id) => desc(id)).join(' | ')}` : '') + routeLine(state, near[0]);
  }
  // Routes out of the player's region that say more than "next door" (R-2):
  // a kind, a time, a requirement or a risk. Plain borders are in Nearby.
  P.ROUTES_MAX = 8;
  function routeLine(state, id) {
    const S = E.Scenario;
    // A region-focused world (R-8) lists plain borders too: travel is how it moves.
    const all = E.Sites.mapFocus(state.scenario) === 'region';
    const list = Eng().routesFrom(state, id).filter((r) => all || r.kind !== 'border' || r.hours > 0 || r.closed || r.risky).slice(0, P.ROUTES_MAX);
    if (!list.length) return '';
    const one = (r) => {
      const bits = [r.kind].concat(r.hours ? [S.sayHours(r.hours)] : [], r.closed ? [`closed: ${r.closed.replace(/^the .*? needs /, 'needs ')}${r.risky ? ', but can be risked' : ''}`] : r.risky ? ['risky'] : []);
      return `${(Eng().regionDef(state, r.to) || {}).name || r.to} (${bits.join(', ')})`;
    };
    return `\nRoutes from here: ${list.map(one).join(' | ')}`;
  }
  // Regions the player doesn't know of yet (R-5): only in the intent calls'
  // user messages, like secrets (rule 6), so an event can reveal one.
  B.hiddenPlaces = ({ state }) => {
    const hidden = [...Eng().hiddenRegions(state)].map((id) => Eng().regionDef(state, id));
    if (!hidden.length) return null;
    return ['\n=== HIDDEN PLACES (the player doesn\'t know of them: never name one in public text unless the story makes it known; to make one known, add effects "reveal") ==='].concat(hidden.map((r) => {
      const up = E.Scenario.regionChainIn(state.scenario.regions, r.id).slice(1).map((x) => Eng().regionDef(state, x).name);
      return `- ${r.id}: ${r.name}${up.length ? ` (in ${up.join(' › ')})` : ''}${r.lore ? ` — ${r.lore}` : ''}`;
    }));
  };
  // Event ideas (eventSeeds) are text or {text, region}. Regional ideas for
  // regions away from the player are left out (an idea for a region the
  // player is inside counts, R-1); the rest say where they are.
  function seedTexts(state, scope) {
    const near = Eng().regionsAround(state);
    return ((state.scenario.eventSeeds || {})[scope] || []).map((s) => {
      if (typeof s === 'string') return s;
      if (!s.region) return s.text;
      if (!Eng().regionKnown(state, s.region)) return null; // hidden (R-5)
      if (scope === 'regional' && !near.includes(s.region)) return null;
      const def = Eng().regionDef(state, s.region);
      return `${s.text} (${def ? def.name : s.region})`;
    }).filter(Boolean);
  }
  // The JSON shape of an event's effects; region effects only when the world has regions.
  function effectShape(state) {
    const has = Object.keys(state.regions || {}).length;
    const region = has
      ? ',"control":[{"region":"region_id","to":"group_id or null"}],"add_tag":[{"region":"region_id","tag":"short tag"}],"remove_tag":[{"region":"region_id","tag":"existing tag"}],"region_status":[{"region":"region_id","status":"new status"}]'
        // Presence (R-5): only for worlds that use it; reveal only while something is hidden.
        + (Object.keys(state.presence || {}).length ? ',"presence":[{"group":"group_id","region":"region_id","to":0.5}]' : '')
        + (Eng().hiddenRegions(state).size ? ',"reveal":[{"region":"hidden_region_id"}]' : '')
      : '';
    const site = E.Sites.enabled(state.scenario) ? ',"new_site":null' : '';
    return `{"world":[{"key":"world_key","value":"new status"}],"groups":[{"id":"group_id","stance":"new stance"}],"clocks":[{"id":"clock_id","delta":2}],"new_clock":null${region}${site}}`;
  }
  // Valid ids for effects. Every region, not just nearby ones: the world can
  // shift far from the player (their current state stays nearby-only).
  function effectIds(state) {
    // Hidden regions (R-5) are listed apart, in the hidden places block.
    const hidden = Eng().hiddenRegions(state);
    const regions = Object.keys(state.regions || {}).filter((id) => !hidden.has(id));
    return `world keys: ${Object.keys(state.world).join(', ')}; groups: ${(state.factions || []).map((f) => f.id).join(', ') || 'none'}; clocks: ${state.clocks.filter((c) => !c.fired).map((c) => c.id).join(', ') || 'none'}${regions.length ? `; regions: ${regions.join(', ')}` : ''}`;
  }

  function needsText(state, c, onlyNotable) {
    return Object.entries(c.needs)
      .filter(([, v]) => !onlyNotable || v >= 0.6)
      .map(([k, v]) => `${k} ${E.needWord(v)}`)
      .join(', ');
  }

  // The player's own attitude toward the people around them, built only from
  // how the player has actually acted. Used so time skips stay in character.
  function playerAttitude(state, ids) {
    const pc = state.characters[state.player];
    const notes = pc.attitudeNotes || {};
    return ids
      .filter((o) => state.characters[o] && o !== state.player)
      .map((o) => {
        const v = pc.relations[o] || 0;
        return `${name(state, o)} ${E.relWord(v)} (${v}${notes[o] ? '; ' + notes[o] : ''})`;
      });
  }

  function statusLine(state, id, forNarrator, around) {
    const c = state.characters[id];
    const parts = [`health ${E.healthWord(c.status.health)}`];
    // The narrator sees how the people in the scene look: the first sentence of
    // their appearance, here (per call) rather than in the header.
    if (forNarrator && c.appearance) parts.push(`looks: ${E.shorten(String(c.appearance).split(/(?<=[.!?])\s/)[0], 160).replace(/[.!?]+$/, '')}`);
    if (c.mood && id !== state.player) parts.push(`mood: ${c.mood.text}`);
    if ((c.tags || []).length) parts.push(`tags: ${c.tags.map((t) => t.text).join(', ')}`);
    const needs = needsText(state, c, forNarrator);
    if (needs) parts.push(needs);
    if (id === state.player && around && around.length) {
      const att = playerAttitude(state, around);
      if (att.length) parts.push(`feels toward: ${att.join(', ')}`);
    }
    if (!forNarrator && id !== state.player) {
      const rel = c.relations[state.player] || 0;
      parts.push(`feels toward ${name(state, state.player)}: ${E.relWord(rel)} (${rel})`);
      const others = Object.entries(c.relations)
        .filter(([o]) => o !== state.player && state.characters[o] && state.characters[o].status.location === c.status.location)
        .map(([o, v]) => `${name(state, o)} ${E.relWord(v)}`);
      if (others.length) parts.push(`toward others here: ${others.join(', ')}`);
    }
    // The narrator gets no ids: it copied "[okafor]" into the prose (playtest-id-tags-in-prose).
    return `- ${c.name}${c.pronouns ? ` (${c.pronouns})` : ''}${forNarrator ? '' : ` [${id}]`}: ${parts.join('; ')}`;
  }

  // ---------- user-message blocks shared by several prompts ----------
  // Where the player is, the world, who is present and their status.
  B.now = ({ state, present, forNarrator }) => {
    const pc = state.characters[state.player];
    const loc = state.locations[pc.status.location];
    const elsewhere = Eng().offstage(state, present)
      .map((id) => `${name(state, id)} (${state.locations[state.characters[id].status.location]?.name || '?'})`);
    const lines = [
      `=== NOW: ${E.fmtTime(state)} ===`,
      `${pc.name} is in ${inRoom(state, loc, pc.status.location)}.`,
      worldLines(state),
      `Present with ${pc.name}: ${present.length ? present.map((id) => name(state, id)).join(', ') : 'no one'}`,
    ];
    const minor = Eng().extrasAt(state, pc.status.location);
    if (minor.length) lines.push(`Also here (minor people): ${minor.map((x) => Eng().extraLabel(x)).join('; ')}`);
    const groups = Eng().standeesAt(state, pc.status.location);
    if (groups.length) lines.push(`Unnamed groups here: ${groups.map((g) => Eng().standeeLabel(state, g)).join('; ')}`);
    const site = siteLines(state, pc.status.location);
    if (site) lines.push(site);
    if (elsewhere.length) lines.push(`Elsewhere: ${elsewhere.join(', ')}`);
    lines.push('\n=== STATUS ===');
    lines.push(statusLine(state, state.player, forNarrator, present));
    present.forEach((id) => lines.push(statusLine(state, id, forNarrator)));
    return lines;
  };

  // '' when there is none (an empty line, as the prompts have always had).
  B.lastScene = ({ state }) => {
    const r = state.recent[state.recent.length - 1];
    return r ? `\n=== LAST SCENE ===\n${r.text}` : '';
  };

  const EVENT_GUIDE = {
    minute: 'None, unless something was already about to happen this very minute.',
    moment: 'Usually none for a few minutes; at most 1, only if something is already about to happen.',
    hour: '0 or 1.',
    hours: '1 or 2.',
    morning: '1 to 3, spread over the day and night.',
  };

  // ---------- intent ----------
  P.layouts.intent = ['now', 'lore', 'knownPlaces', 'private', 'hiddenPlaces', 'extrasHere', 'standees', 'offstage', 'background', 'agendaDue', 'lastScene', 'crisisNow', 'reckoningNow', 'intentAction', 'intentTask'];
  // Places beyond the start's rooms (task 4-4): the rooms of the place the
  // player is in (made during the story, so not in the header) and the
  // places the story knows of. Only in worlds that build new places.
  B.knownPlaces = ({ state }) => {
    const ST = E.Sites;
    if (!ST.enabled(state.scenario)) return null;
    const lines = ['\n=== PLACES ==='];
    const here = ST.playerSite(state);
    if (here !== ST.HOME) lines.push(`${state.sites[here].name} has these rooms: ${ST.rooms(state, here).map((l) => `${l.id} (${l.name})`).join(', ')}.`);
    const known = Object.values(state.sites || {}).filter((s) => s.id !== here);
    lines.push(known.length ? `Places the story knows of: ${known.map((s) => `${s.name} (${s.kind}${s.region ? `, ${s.region}` : ''}${s.stub ? s.summary ? `; ${s.summary}` : '; not visited yet' : ''})`).join('; ')}.` : 'No other places yet beyond these rooms.');
    lines.push('If the player\'s action clearly heads somewhere that is none of these rooms (another building, a part of town, a hideout), set "new_place" to {"name":"the place in the player\'s own words (like \"the chop shop\")","kind":"what kind of place","region":"region id"} and leave move_to null; for a place listed above, use its name. The engine decides whether to build it.');
    // Generated regions (R-6): somewhere bigger than a building.
    if (ST.regionsEnabled(state.scenario)) lines.push('If it heads somewhere bigger that isn\'t one of the regions (another town, a district, a planet), set "new_region" to {"name":"in the player\'s own words","label":"what kind of region (town, district, planet)","parent":"the region id it is inside, or null"} instead. The engine decides whether to add it.');
    return lines;
  };
  P.intent = (state, present, action, stepLabel, stepId, due) =>
    P.build('intent', { state, sc: state.scenario, present, forNarrator: false, action, stepLabel, stepId, due: due || {} });

  // The step someone's agenda is on (task 2-2); intent-side only.
  const working = (c) => { const st = Eng().agendaStep(c); return st ? st.text : null; };

  // Secrets and private facts of the people present: only ever in the intent call.
  B.private = ({ state, present }) => {
    const priv = [];
    present.forEach((id) => {
      const c = state.characters[id];
      if (working(c)) priv.push(`- ${c.name}'s aim: ${c.agenda.goal} (next: ${working(c)})`);
      // Keys (task 3-6): who can lock and unlock the doors next to them.
      Eng().linkedRooms(state, c.status.location).forEach((o) => {
        const k = Eng().linkInfo(state, c.status.location, o);
        if (k && k.kind === 'locked door' && k.key.includes(id)) priv.push(`- ${c.name} has the key to the door to ${state.locations[o].name} (${k.locked ? 'locked' : 'unlocked'}; can set "${k.locked ? 'unlock' : 'lock'}":"${o}")`);
      });
      if (c.secret) priv.push(`- ${c.name}'s secret: ${c.secret} (guard: ${c.guard || 'medium'}; ${({ low: 'cracks easily when confronted', medium: 'holds up unless stressed or trusting', high: 'very hard to crack' })[c.guard || 'medium']})`);
      Mem().privateFacts(state, id).slice(-6).forEach((f) => priv.push(`- ${c.name} knows: ${f.text}`));
    });
    return priv.length ? '\n=== PRIVATE (each item is known ONLY to the character named) ===\n' + priv.join('\n') : null;
  };
  // Minor people with the player (task 2-3): ids for events, and their notes.
  // The rest go on one short line (no notes), so events can use their ids too.
  B.extrasHere = ({ state }) => {
    const here = state.characters[state.player].status.location;
    const all = Object.values(state.extras || {});
    const minor = all.filter((x) => x.location === here);
    const away = all.filter((x) => x.location !== here).slice(0, 8);
    if (!all.length) return null;
    const lines = ['\n=== MINOR PEOPLE (no intents; they can be in events, "who" by id) ==='];
    minor.forEach((x) => lines.push(`- here: ${x.id}: ${Eng().extraLabel(x)}${x.note ? ` — ${x.note}` : ''}`));
    if (away.length) lines.push(`- elsewhere: ${away.map((x) => `${x.id} (${x.name}${x.group ? ', a group' : ''}, ${x.location ? (state.locations[x.location] || {}).name || x.location : 'no particular place'})`).join('; ')}`);
    return lines;
  };
  // Groups (task 3-2): ids and notes for the ones here (one intent each), and
  // one short line for the rest, so events can use their ids.
  B.standees = ({ state, action }) => {
    const all = Object.values(state.standees || {});
    if (!all.length) return null;
    const here = state.characters[state.player].status.location;
    const engaged = Eng().engagedStandees(state, action);
    const lines = ['\n=== UNNAMED GROUPS (people as one entity: one intent per group, never per person) ==='];
    engaged.forEach((g) => lines.push(`- ${g.location === here ? 'here' : `next door in ${state.locations[g.location].name} (named in the action)`}: ${g.id}: ${Eng().standeeLabel(state, g)}${g.note ? ` — ${g.note}` : ''}`));
    const away = all.filter((g) => !engaged.includes(g)).slice(0, 8);
    if (away.length) lines.push(`- elsewhere: ${away.map((g) => `${g.id} (${g.label}, ${g.count}, ${g.state}, ${(state.locations[g.location] || {}).name || g.location})`).join('; ')}`);
    return lines;
  };
  const groupsHere = (state, action) => Eng().engagedStandees(state, action).filter((g) => Eng().standeeActive(g));
  const groupTask = (state, action) => {
    const here = groupsHere(state, action);
    const any = Eng().engagedStandees(state, action).length;
    if (!any) return '';
    const links = Eng().linkedRooms(state, state.characters[state.player].status.location).join(', ') || 'none';
    return (here.length ? `   Unnamed groups the player can deal with (${here.map((g) => g.id).join(', ')}): give each exactly one entry in "group_intents": what the group does as a group this span ("move_to" only to a room linked to where the group is; the player's room links to: ${links}; a group on guard holds its post unless hostile).\n` : '') +
      `   If the player's action is aimed at an unnamed group, set the player's "against" to that group id. If the player singles out one member of one, set "single_out": {"standee":"group_id","name":"short name or description","role":"short role"}.\n`;
  };

  const siteTask = (state) => {
    if (!hasSite(state)) return '';
    const locked = lockedHere(state);
    return (locked.length ? `   To pick or force a lock, set the player's "unlock" to the room on the other side (${locked.join(', ')}); it always takes a roll. Nobody walks through a locked door.\n` : '') +
      `   If the player's action uses something not listed for their room (a window, a vent, a fire extinguisher), set the player's "new_feature": {"name":"short name","to":null or the room id it leads to}.\n`;
  };
  const inventLine = (sc) => (sc.inventExtras
    ? `   If the scene truly needs a minor person or group who isn't listed anywhere (a guard, a shopkeeper, a crowd), add them to "new_extras": {"name","role","location","group":false}. At most 1. Never for someone already in the cast.\n`
    : '');

  // Local characters away from the player: what they want and hide, for events.
  B.offstage = ({ state, present }) => {
    const offstage = Eng().offstage(state, present).filter((id) => Eng().tier(state, id) === 'local');
    if (!offstage.length) return null;
    return '\n=== OFFSTAGE (not with the player; for events only) ===\n' + offstage.map((id) => {
      const c = state.characters[id];
      const loc = state.locations[c.status.location];
      return `- ${id} (${c.name}), in ${loc ? loc.name : c.status.location}: wants ${c.want || '?'}${c.secret ? '; secret: ' + c.secret : ''}${working(c) ? '; working on: ' + working(c) : ''}`;
    }).join('\n');
  };
  // Secondary characters (task 2-1): one short line each, no secrets, so a big
  // cast keeps this prompt small.
  B.background = ({ state, present }) => {
    const ids = Eng().offstage(state, present).filter((id) => Eng().tier(state, id) === 'secondary');
    if (!ids.length) return null;
    return ['\n=== BACKGROUND (not with the player; one line each; for events only) ==='].concat(ids.map((id) => {
      const c = state.characters[id];
      const loc = state.locations[c.status.location];
      return `- ${id} (${c.name}, ${E.shorten(c.role || '?', 40)}), in ${loc ? loc.name : c.status.location}${c.want ? '; wants: ' + E.shorten(c.want, 60) : ''}${working(c) ? '; now: ' + E.shorten(working(c), 50) : ''}`;
    }));
  };
  // Agenda steps the engine says are due: each becomes exactly one event.
  B.agendaDue = ({ state }) => {
    const ids = Eng().agendasDue(state);
    if (!ids.length) return null;
    const pc = state.characters[state.player];
    return ['\n=== AGENDA STEPS DUE (write each as exactly one event with "agenda" set to that id) ==='].concat(ids.map((id) => {
      const c = state.characters[id];
      const st = Eng().agendaStep(c);
      const how = st.contact ? `comes to ${pc.name} with it; "visibility":"seen"` : c.agenda.visibility === 'heard' ? '"visibility":"heard"' : '"visibility":"hidden", the player has no idea';
      return `- ${id} (${c.name}), working toward "${c.agenda.goal}": ${st.text} (${how})`;
    }), `   Shape: {"text":"one sentence, with names","agenda":"${ids[0]}","scope":"local","who":["${ids[0]}"],"where":"location_id","visibility":"hidden","moves":[]}. These are in addition to the other events.`);
  };
  // The emergency the last scene ended on (playtest-coffee-skips): it plays out
  // this span whatever the player does.
  B.crisisNow = ({ state, due }) => {
    if (!due.crisis) return null;
    const pc = state.characters[state.player].name;
    return `\n=== STILL HAPPENING ===\nThe last scene ended on an emergency: "${due.crisis.text}" It is still happening as this span starts and plays out during it whatever ${pc} does. If ${pc}'s action doesn't deal with it, the others act on it without ${pc} (in their intents and the events), and it costs something real. Set "player"."crisis_answered" to true only if ${pc}'s action deals with it (helps, goes to it, answers what they were asked), else false.`;
  };
  // Someone who has had enough of the player sitting emergencies out walks in
  // (playtest-coffee-bystander); the engine has already brought them here.
  B.reckoningNow = ({ state, due }) => {
    if (!due.reckoning) return null;
    const pc = state.characters[state.player].name;
    const c = state.characters[due.reckoning.id];
    return `\n=== SOMEONE HAS HAD ENOUGH ===\n${c.name} has come to confront ${pc}, who has sat out ${due.reckoning.sat.length} emergencies (${due.reckoning.sat.map((t) => `"${t}"`).join('; ')}). ${c.name}'s intent this span is that confrontation, and it comes with something real, true to who they are: an ultimatum, a decision about ${pc} made without them, or something taken away.`;
  };
  B.intentAction = ({ action, stepLabel }) => `\n=== PLAYER ACTION (time passing: ${stepLabel}) ===\n"${action}"\nThe player's action takes up this whole span. Others act during the same span.`;
  B.intentTask = ({ state, sc, present, stepId, due, action }) => {
    const ids = present.join(', ') || '(none)';
    return `
=== TASK ===
1. Judge the player's action. If it is risky, contested or depends on skill, set needs_roll to true and choose a skill (one of: ${sc.skills.join(', ')}) and a difficulty (easy, normal, hard). Talking, looking around and simple tasks need no roll. Everyone listed as present is in the same room as ${name(state, state.player)} right now, so an action about them needs no move. Only if the action clearly takes ${name(state, state.player)} somewhere else, set move_to to that location id (or to a character id to go where that character is).
2. You MUST give exactly one intent for EACH present character: ${ids}. Decide what each actually tries to do during this time, driven by their personality, wants, needs, secrets and feelings. They may help, argue, refuse, lie, deflect, pursue their own goals, or leave (move_to). Set visible to false if they act covertly so the player would not notice.
3. "says": the gist of anything they say aloud this turn (or null).
4. "reveals": almost always null. Only fill it if the character deliberately says their secret or private knowledge out loud this turn, and that matches their "says". Being asked once, or being nervous, is not enough: people deflect, make excuses or lie first.
5. "events": things that happen during this span outside the player's control, to keep the world moving: offstage characters pursuing their wants and secrets, groups making moves that affect the people here, someone arriving, a call or message, something breaking down, the pressures above getting closer. How many: ${EVENT_GUIDE[stepId] || EVENT_GUIDE.hour} Each event has:
   - "text": one sentence, with names.
   - "who": character ids involved (not the player).
   - "where": location id where it happens.
   - "visibility": "seen" (happens in the player's room), "heard" (the player gets a sound, call or message about it) or "hidden" (the player has no idea).
   - "moves": [{"id":"character_id","to":"location_id"}] for offstage characters who go somewhere because of it, else [].
   - "scope": "local" for these.
${groupTask(state, action)}${siteTask(state)}${inventLine(sc)}${tierTask(state, due)}${canonTask(state, due)}
Reply with JSON only, exactly in this shape:
${intentExample(state, present, action, due)}`;
  };

  // Timeline events due now whose preconditions broke (task 5-2): the model
  // writes what happens instead. Only when one is due, so prompts are
  // otherwise unchanged.
  function canonTask(state, due) {
    const list = (due && due.canon) || [];
    if (!list.length) return '';
    return '\n' + [`   EXPECTED EVENTS THE STORY HAS CHANGED: these were due during this span, but things are different now. For each, write what happens instead (the same occasion, altered by what changed) in "canon": [{"id":"event_id","text":"one sentence","effects":${effectShape(state)}}].`]
      .concat(list.map((d) => `   - ${d.ev.id}: was "${d.ev.text}" Changed: ${d.broken.join('; ')}.`)).join('\n');
  }

  function tierTask(state, due) {
    const seeds = { regional: seedTexts(state, 'regional'), world: seedTexts(state, 'world') };
    const lines = [];
    if (due.regional) {
      lines.push(`6. A REGIONAL event is due: add exactly one event with "scope":"regional" — something in the surroundings (terrain, weather, nearby places, infrastructure) that affects the people here.${seeds.regional.length ? ' Ideas: ' + seeds.regional.join('; ') + '.' : ''}`);
    }
    if (due.world) {
      lines.push(`${due.regional ? 7 : 6}. A WORLD event is due: add exactly one event with "scope":"world" — a broad shift far away (organizations, money, politics, disasters) whose effects reach the people here.${seeds.world.length ? ' Ideas: ' + seeds.world.join('; ') + '.' : ''}`);
    }
    if (!lines.length) return '   No regional or world events this turn; keep events local.';
    const near = Eng().regionsAround(state);
    if (near.length) lines.push(`   Give regional/world events a "region": the region id where it happens (regional events: ${near.join(', ')}; world events: any region, or null).`);
    lines.push(`   Give regional/world events concrete consequences in "effects":${effectShape(state)}. Use only existing keys/ids (${effectIds(state)}). Use new_clock {"name":"short name","max":8,"perHour":0.2,"fireText":"what happens when it runs out"} only for a genuinely new looming problem. Usually "visibility":"heard" (news, a message, an alarm).`);
    return lines.join('\n');
  }

  // The example is pre-filled with the real ids so small models don't drop anyone.
  function intentExample(state, present, action, due) {
    const canon = due && due.canon && due.canon.length ? `,\n "canon":[${due.canon.map((d) => `{"id":"${d.ev.id}","text":"one sentence","effects":null}`).join(',')}]` : '';
    const intents = present.map((id) =>
      `  {"id":"${id}","action":"one sentence","says":null,"reveals":null,"visible":true,"needs_roll":false,"skill":null,"difficulty":"normal","move_to":null}`
    );
    const groups = groupsHere(state, action).map((g) => `  {"id":"${g.id}","action":"one sentence","visible":true,"move_to":null}`);
    const anyGroups = Eng().engagedStandees(state, action).length;
    const site = hasSite(state) ? `${lockedHere(state).length ? ',"unlock":null' : ''},"new_feature":null` : '';
    return `{"player":{"summary":"the player's action restated as a concrete attempt","needs_roll":false,"skill":null,"difficulty":"normal","move_to":null${anyGroups ? ',"against":null,"single_out":null' : ''}${site}${due && due.crisis ? ',"crisis_answered":false' : ''}},
 "intents":[${intents.length ? '\n' + intents.join(',\n') + '\n ' : ''}],${groups.length ? `\n "group_intents":[\n${groups.join(',\n')}\n ],` : ''}
 "events":[{"text":"one sentence","scope":"local","who":["character_id"],"where":"location_id","visibility":"heard","moves":[]}]${state.scenario.inventExtras ? ',\n "new_extras":[]' : ''}${canon}}`.replace('"move_to":null', E.Sites.enabled(state.scenario) ? `"move_to":null,"new_place":null${E.Sites.regionsEnabled(state.scenario) ? ',"new_region":null' : ''}` : '"move_to":null');
  }

  function outcomeLines(state, res, forNarrator) {
    const lines = [];
    res.outcomes.forEach((o) => {
      const who = o.id === state.player ? `You (${name(state, o.id)})` : name(state, o.id);
      if (forNarrator && !o.visible && o.id !== state.player) {
        lines.push(`- ${name(state, o.id)} does something out of your sight. At most hint at it.`);
        return;
      }
      const roll = o.roll ? ` → ${o.roll.result.toUpperCase()} (${o.skill} check: rolled ${o.roll.total} vs ${o.roll.dc}${o.dcWhy ? `; ${o.dcWhy}` : ''})` : ' → happens (no roll needed)';
      const move = o.moved ? ` [moves to ${state.locations[o.moved].name}${o.via && o.via.length ? `, through ${o.via.map((r) => state.locations[r].name).join(', ')}` : ''}]` : '';
      const hidden = !forNarrator && !o.visible ? ' [HIDDEN from player]' : '';
      lines.push(`- ${who}: ${o.action}${roll}${move}${hidden}`);
      if (o.says) lines.push(`    says (gist): ${o.says}`);
      if (o.reveals) lines.push(`    REVEALS: ${o.reveals}`);
    });
    // Groups (task 3-2): one line per group, and exactly what the engine changed.
    (res.groups || []).forEach((g) => {
      const st = state.standees && state.standees[g.id];
      const label = st ? `${st.label} (group of ${st.count})` : g.id;
      if (forNarrator && !g.visible) return lines.push(`- ${label} do something out of your sight. At most hint at it.`);
      lines.push(`- ${label}: ${g.action}${g.moved ? ` [moves to ${state.locations[g.moved].name}]` : ''}${!forNarrator && !g.visible ? ' [HIDDEN from player]' : ''}`);
    });
    (res.standeeChanges || []).forEach((t) => lines.push(`- CHANGED: ${t}`));
    res.events.forEach((e) => lines.push(`- EVENT: ${e}`));
    return lines.join('\n');
  }

  // How much the narrator may fill in for the player depends on the time step:
  // short steps are beat-by-beat, long ones hand routine over to the narrator.
  const STEP_GUIDE = {
    minute: "This covers about a minute: the next exchange of the conversation, or one quick action. Play just that: the player character's words or deed and how the others answer. Nothing else happens to the player character, and the scene doesn't move on.",
    moment: 'This covers only a few minutes. Play out the stated action beat by beat. Add nothing else for the player character beyond small gestures and a line of dialogue.',
    hour: 'This covers about an hour, all spent on the stated action. Play the key exchange as a live scene and compress the rest of the hour with a line or two ("For the next forty minutes…"). You may show how it naturally unfolds, but the player character starts no new activities and goes nowhere else. Their manner toward others matches the feelings listed in STATUS.',
    hours: 'This covers a few hours. You may compress time ("By midday…") and show the stated action carried through, plus routine (eating, working). In that routine the player character treats each person according to the feelings listed in STATUS (no friendly chats with someone they resent). No big decisions or new plans for the player character.',
    morning: 'This covers the rest of the day and the night. Summarize briefly in a few sentences (routine work, a meal, sleep), then open the next morning as a live scene. The player character keeps to the feelings listed in STATUS: they avoid people they resent and seek out people they like. No big decisions for the player character.',
  };

  // Length as paragraphs: the 12B writes about twice the words it is asked
  // for, and follows a count of short paragraphs better (playtest-r2-drive-to-ridge).
  const PARA_GUIDE = { minute: '1 or 2', moment: '2 or 3', hour: '3 to 5', hours: '4 to 6', morning: '5 to 7' };
  const BEAT_GUIDE = {
    minute: '1 beat: [+0m].',
    moment: '1 beat: [+0m].',
    hour: '2 or 3 beats.',
    hours: '2 to 4 beats.',
    morning: '3 or 4 beats: the rest of the day, the evening, the night, then the morning.',
  };

  // ---------- scene and its continuation ----------
  // Frame, status, last scene, player action and resolved outcomes are shared
  // by the scene and its continuation.
  const SCENE_CONTEXT = ['sceneFrame', 'status', 'lore', 'lastScene', 'sceneAction', 'resolved'];
  P.layouts.narrate = SCENE_CONTEXT.concat(['worn', 'narrateTask', 'endingClose']);
  P.layouts.narrateMore = SCENE_CONTEXT.concat(['sceneSoFar', 'worn', 'narrateMoreTask', 'endingClose']);
  // An ending the engine reached this turn: the scene closes the story, after
  // the task (so it wins over "end on a moment for the player").
  const ENDING_TONE = { win: 'a hard-won success', loss: 'a defeat', bittersweet: 'bittersweet: something won, something lost', neutral: 'an ending, neither triumph nor defeat' };
  B.endingClose = ({ res }) => (res && res.ending
    ? `\n=== THIS SCENE ENDS THE STORY ===\n"${res.ending.title}" (${ENDING_TONE[res.ending.kind] || ENDING_TONE.neutral}): ${res.ending.why}.${res.ending.epilogue ? ` ${res.ending.epilogue}` : ''}\nThe final beat shows this ending and closes on it, with how the people here take it. This overrides the rule about ending on a moment for the player: no question, no open choice.`
    : null);
  // Phrases recent scenes keep repeating (playtest-coffee-skips: "the pot is the
  // only instrument anyone trusts"), found by the engine.
  B.worn = ({ state }) => {
    const worn = Eng().wornPhrases(state);
    return worn.length ? '\n=== WORN PHRASES (recent scenes keep using these: do not use them or close variants) ===\n' + worn.map((w) => `- "${w}"`).join('\n') : null;
  };
  P.narrate = (state, presentStart, action, frame, res) =>
    P.build('narrate', sceneContext(state, presentStart, action, frame, res));
  // sceneSoFar carries its time markers; fromMinutes is the last one.
  P.narrateMore = (state, presentStart, action, frame, res, sceneSoFar, fromMinutes) =>
    P.build('narrateMore', Object.assign(sceneContext(state, presentStart, action, frame, res), { sceneSoFar, fromMinutes }));

  function sceneContext(state, presentStart, action, frame, res) {
    const pc = state.characters[state.player];
    const startLoc = state.locations[frame.startLoc];
    const endLocId = pc.status.location;
    const endLoc = state.locations[endLocId];
    const moved = endLocId !== frame.startLoc;
    const nowHere = Eng().present(state, endLocId);
    const left = presentStart.filter((id) => !nowHere.includes(id));
    const arrived = nowHere.filter((id) => !presentStart.includes(id));
    return { state, presentStart, action, frame, res, pc, startLoc, endLoc, moved, left, arrived, statusIds: presentStart.concat(arrived), span: frame.spanMinutes || 60 };
  }

  // Minor people in the scene's rooms (task 2-3): name and role, never the note.
  function minorLine(state, locs, engaged) {
    const minor = [...new Set(locs)].flatMap((l) => Eng().extrasAt(state, l));
    const groups = [...new Set(locs)].flatMap((l) => Eng().standeesAt(state, l))
      .concat((engaged || []).map((id) => state.standees[id]).filter((g) => g && !locs.includes(g.location)));
    return (minor.length ? `\nAlso around (minor people, they may appear): ${minor.map((x) => Eng().extraLabel(x)).join('; ')}.` : '') +
      (groups.length ? `\nUnnamed groups around (exactly these, no more): ${groups.map((g) => `${Eng().standeeLabel(state, g)} in ${state.locations[g.location].name}`).join('; ')}.` : '');
  }
  B.sceneFrame = ({ state, presentStart, frame, pc, startLoc, endLoc, moved, left, arrived, res }) => `=== SCENE FRAME ===
Starts: ${frame.startTime}, in ${startLoc ? inRoom(state, startLoc, frame.startLoc) : frame.startLoc}, with ${presentStart.length ? presentStart.map((id) => name(state, id)).join(', ') : 'no one'}.
Ends: ${E.fmtTime(state)}, ${pc.name} ${moved ? `now in ${endLoc.name}` : `still in ${startLoc ? startLoc.name : frame.startLoc}`}.` +
      // When the player moves, people who stay put are left behind, not leaving.
      (left.length ? `\nDuring the scene, ${left.map((id) => state.characters[id].status.location === frame.startLoc
        ? `${name(state, id)} stays behind in ${startLoc ? startLoc.name : frame.startLoc}`
        : `${name(state, id)} leaves for ${state.locations[state.characters[id].status.location].name}`).join('; ')}.` : '') +
      (arrived.length ? `\n${arrived.map((id) => name(state, id)).join(', ')} ${arrived.length > 1 ? 'are' : 'is'} there at the end.` : '') +
      minorLine(state, [frame.startLoc, state.characters[state.player].status.location], res && res.engaged) +
      `\n${worldLines(state)}`;
  // Narrator-side status (no secrets, notable needs only) for the player and statusIds.
  B.status = ({ state, statusIds }) => ['\n=== STATUS ===', statusLine(state, state.player, true, statusIds)]
    .concat(statusIds.map((id) => statusLine(state, id, true)));
  B.sceneAction = ({ frame, action }) => `\n=== PLAYER ACTION (time span: ${frame.stepLabel}) ===\n"${action}"`;
  B.resolved = ({ state, res }) => '\n=== RESOLVED (final — narrate these faithfully) ===\n' + outcomeLines(state, res, true);

  // Steps with a loose length, where the beats should spread across the span.
  const SPREAD_STEPS = ['hour', 'hours'];

  B.narrateTask = ({ frame, pc, startLoc, endLoc, moved, span }) => {
    const spread = SPREAD_STEPS.includes(frame.stepId) ? ` Spread the beats across the whole span: the last one starts around [+${Math.round(span * 0.75)}m].` : '';
    return `
=== TASK ===
Write the next scene in second person, present tense ("you" is ${pc.name}): ${PARA_GUIDE[frame.stepId] || PARA_GUIDE.hour} short paragraphs in all, each 2 to 4 sentences (${frame.words || '100–200'} words). Bring the characters to life through dialogue and small actions in their own voices.
Time: ${STEP_GUIDE[frame.stepId] || STEP_GUIDE.hour}
Beats: ${BEAT_GUIDE[frame.stepId] || BEAT_GUIDE.hour} Start each beat on its own line with a time marker in brackets: minutes since the scene started, like [+0m], [+25m], [+50m] (use hours for long spans, like [+5h]). The last marker is at most [+${span}m].${spread} End each beat on something the player could react to, since the player may step in between beats.
Structure:
1. The scene is set in ${moved ? `${startLoc.name}, then ${endLoc.name}` : (startLoc ? startLoc.name : frame.startLoc)}. Open with ${pc.name}'s action, carried out in the first paragraph.
2. Then show how the others react to it and what they do, in the order that makes sense.
3. End on the others' latest move: a reply, a look, a question or a new problem the player can respond to. The final paragraph must NEVER be ${pc.name}'s own line or action; leave ${pc.name}'s response open for the player.
Hard rules:
- Narrate ONLY the resolved outcomes above, faithfully. Failures should cost something.
- Play ${pc.name} naturally, in character${pc.voice ? ` (voice: ${pc.voice})` : ''}. If the action is vague, fill it in the way ${pc.name} would: small gestures, a line or two of dialogue, how they go about it.
- Do not make big choices for ${pc.name}: no agreeing to plans, making promises, starting new tasks, revealing what ${pc.name} knows beyond the action, or deciding what to do next. When a real choice comes up, stop there and leave it to the player.
- ${moved ? `${pc.name} goes only to ${endLoc.name}.` : `${pc.name} never leaves ${startLoc ? startLoc.name : 'this room'}.`} Do not take ${pc.name} anywhere else.
- Only the characters in the frame appear. Anyone "out of your sight" is NOT seen doing it; at most a sound or a hint.
- Characters may leave or arrive when it fits the outcomes and events; anyone who leaves is seen leaving, not followed.
- EVENTs tagged [regional] or [world] reach the scene the way they realistically would (a tremor, an alarm, a message or news report), and the present characters react to them in character.
- Use each character's pronouns exactly as given in STATUS (e.g. he/him means "he", never "they").
- Characters reveal only what is listed under REVEALS. Anything else they keep to themselves: they deflect, stall, joke or lie.
- Do not invent new events, confessions or discoveries.
- Stop at the end of these outcomes, on a moment that invites the player's response. Do not continue past it.` +
      (frame.correction ? `\n\nCORRECTION: ${frame.correction}` : '') +
      `\nReply with the scene text only.`;
  };

  // The scene stopped well short of the time step: ask for the rest of it.
  B.sceneSoFar = ({ sceneSoFar }) => `\n=== SCENE SO FAR ===\n${sceneSoFar}`;
  B.narrateMoreTask = ({ frame, pc, startLoc, endLoc, moved, span, fromMinutes }) => `
=== TASK ===
Continue the scene above. It stops at [+${fromMinutes}m], but this turn covers ${frame.stepLabel} (${span} minutes). Write 1 or 2 more beats, 1 or 2 short paragraphs in all (40–100 words), in second person, present tense ("you" is ${pc.name}). Start each beat on its own line with a time marker counted from the start of the scene, later than [+${fromMinutes}m]; the last one around [+${Math.round(span * 0.85)}m] and at most [+${span}m].
Time: ${STEP_GUIDE[frame.stepId] || STEP_GUIDE.hour} Compress the routine part ("For the next half hour…").
Hard rules:
- Carry on from where the scene stops. Do not repeat or rewrite it.
- Do not make big choices for ${pc.name}: no agreeing to plans, making promises, starting new tasks or deciding what to do next.
- ${moved ? `${pc.name} stays in ${endLoc.name}.` : `${pc.name} never leaves ${startLoc ? startLoc.name : 'this room'}.`}
- Use each character's pronouns exactly as given in STATUS.
- No new events, confessions, reveals or discoveries beyond what the scene already shows.
- End on the others' latest move. The final paragraph must NEVER be ${pc.name}'s own line or action.
Reply with the new beats only.`;

  // ---------- downtime skip ----------
  function crewBrief(state, withSecrets) {
    return Eng().cast(state, { alive: true, includePlayer: false }).map((id) => {
      const c = state.characters[id];
      const loc = state.locations[c.status.location];
      const rel = c.relations[state.player] || 0;
      const mine = state.characters[state.player].relations[id] || 0;
      return `- ${id} (${c.name}${c.pronouns ? ', ' + c.pronouns : ''}), in ${loc ? loc.name : c.status.location}; wants ${c.want || '?'}; feels toward the player: ${E.relWord(rel)}; the player feels: ${E.relWord(mine)}` +
        (withSecrets && c.secret ? `; secret (guard ${c.guard || 'medium'}): ${c.secret}` : '') +
        (withSecrets && working(c) ? `; aim: ${c.agenda.goal}` : '');
    }).join('\n');
  }

  // What a major event looks like: the leading genre tag's meaning, else the
  // original survival-minded list.
  function majorKinds(state) {
    const lead = E.Genres.lead(state.scenario);
    return lead
      ? `In this story a major event means ${lead.major}. It can be local, regional, or world news that changes everything.`
      : 'It can be local (an accident, equipment failure, illness, a conflict boiling over, a secret coming out), regional, or world news that changes everything.';
  }

  function majorIdeas(state) {
    return [].concat(state.scenario.majorSeeds || [], seedTexts(state, 'regional').slice(0, 3), seedTexts(state, 'world').slice(0, 3));
  }

  // How long a downtime lasts, in words: "about 3 days", "about 5 hours"
  // (playtest-coffee-skips: a one-hour skip was "about 0 days" and "a long stretch").
  function spanWords(frame) {
    if (frame.days >= 1) return `about ${frame.days} ${frame.days === 1 ? 'day' : 'days'}`;
    const h = Math.round((frame.spanMinutes || frame.days * 1440) / 60);
    return h >= 1 ? `about ${h} ${h === 1 ? 'hour' : 'hours'}` : 'under an hour';
  }

  P.layouts.skipIntent = ['skipFrame', 'lore', 'people', 'hiddenPlaces', 'agendaDuring', 'lastScene', 'skipTask'];
  P.skipIntent = (state, action, plan, frame, res, agendaSteps) =>
    P.build('skipIntent', { state, pc: state.characters[state.player], action, plan, frame, res, agendaSteps: agendaSteps || [] });

  B.skipFrame = ({ state, pc, action, frame }) => `=== DOWNTIME: ${frame.startTime} → ${frame.endTime} (${spanWords(frame)}) ===
${pc.name} was in ${state.locations[frame.startLoc] ? state.locations[frame.startLoc].name : frame.startLoc} when it began.
${pc.name}'s plan for the downtime: "${action || 'keep to routine'}"${frame.journey ? `\nThe downtime is a journey: ${frame.journey}.` : ''}
${worldLines(state)}`;
  B.people = ({ state, pc }) => {
    const n = Eng().cast(state, { alive: true, includePlayer: false }).length;
    return `\n=== PEOPLE (everyone alive: these ${n} and ${pc.name}; including private secrets, which the player sees none of) ===\n` + crewBrief(state, true);
  };
  // What people's agendas got done during the downtime (task 2-2).
  B.agendaDuring = ({ state, agendaSteps }) => (agendaSteps.length
    ? ['\n=== WHAT PEOPLE GOT DONE (their own plans; hint at hidden ones at most) ==='].concat(agendaSteps.map((a) => `- ${a.text}${a.visibility === 'hidden' ? ' (hidden from the player)' : ''}`))
    : null);
  B.skipTask = ({ state, pc, plan, res, frame, action }) => {
    const who = plan.agenda && state.characters[plan.agenda.id];
    const rk = plan.reckoning && state.characters[plan.reckoning.id];
    const ends = plan.reason === 'arrive'
      ? `The downtime is the journey, and it ends when ${pc.name} arrives at ${state.locations[plan.journey.dest].name}${plan.journey.companions.length ? ` with ${plan.journey.companions.map((id) => name(state, id)).join(', ')}` : ''}. The montage is the trip itself and what happens back where they left. Set "major_event" to null; your positions should fit that moment (people who stayed behind are where they were).`
      : plan.reason === 'body'
      ? `The downtime ends when ${pc.name}'s body gives out: their plan left no room for ${Eng().needLimit(state, plan.body.need).missing}, and ${plan.body.text} Set "major_event" to null; your positions should fit that moment (who is there, who finds them).`
      : plan.reason === 'reckoning'
      ? `The downtime ends when ${rk.name} comes to confront ${pc.name}, who has sat out ${plan.reckoning.sat.length} emergencies (${plan.reckoning.sat.map((t) => `"${t}"`).join('; ')}). ${rk.name} has had enough and comes with something real, true to who they are: an ultimatum, a decision about ${pc.name} made without them, or something taken away. Write it in "reckoning", and set "major_event" to null; ${rk.name} is with ${pc.name} at the end, and your positions should fit that moment.`
      : plan.reason === 'agenda'
      ? `The downtime ends when ${who.name} comes to find ${pc.name}: "${plan.agenda.text}". Set "major_event" to null; ${who.name} is with ${pc.name} at the end, and your positions should fit that moment.`
      // An ending set for this time (the engine checks it, and the scene closes the story).
      : plan.reason === 'ending'
      ? `The downtime ends at ${frame.endTime || 'the time the story was set to end'}, with no new event: the story reaches its ending here. Set "major_event" to null; your positions should fit that moment.`
      : plan.reason === 'clock'
      ? `The downtime ends because a pressure comes to a head: "${res.events[res.events.length - 1] || plan.clock.name}". Set "major_event" to null; your positions should fit that moment.`
      // The timeline (task 5-2): an event as written, or one the story changed.
      : plan.reason === 'canon' && plan.canonMode === 'fired'
      ? `The downtime ends with an expected event: "${plan.canonText}". Set "major_event" to null; your positions should fit that moment.`
      : plan.reason === 'canon'
      ? `The downtime ends at the moment something long expected was due: "${plan.canonEvent.text}" But the story has changed things: ${plan.canonEvent.broken.join('; ')}. Write in "major_event" what happens instead at that moment, given those changes: the same occasion, altered.`
      // Right after an emergency, the next random stop grows out of the people,
      // not another disaster (playtest-coffee-skips: one failure after another).
      : plan.crisis
      ? `The downtime ends with a turning point that grows out of the people, not another disaster: a secret coming out, an agenda or a quarrel coming to a head, a discovery, or the fallout of what already went wrong forcing a hard choice. No new equipment failure, accident or natural disaster. Write it in "major_event".`
      : `The downtime ends with a MAJOR EVENT that you choose: something serious and unexpected that demands a response right now. ${majorKinds(state)}${majorIdeas(state).length ? ` Ideas: ${majorIdeas(state).join('; ')}.` : ''}`;
    // A player who keeps sitting things out is in this one (playtest-coffee-bystander).
    const here = state.characters[state.player].status.location;
    const onPlayer = plan.onPlayer ? ` ${pc.name} has sat things out long enough: this one happens where they are (${here}) and to them, so they can't stay out of it; "where" is ${here}, and they may be among those it hurts.` : '';
    const reg = Eng().nearbyRegions(state).length ? '"region":"region_id",' : '';
    const climb = Eng().unmetNeeds(state, action);
    const writesMajor = plan.reason === 'random' || (plan.reason === 'canon' && plan.canonMode === 'diverge');
    const harmShape = '[{"id":"character_id","health":"hurt|badly_hurt|dead"}]';
    return `
=== TASK ===
${frame.days >= 1 ? 'This covers a long stretch of downtime.' : 'This covers a short stretch of time.'} ${plan.crisis ? `It starts with an emergency ${pc.name}'s plan ignores: the last scene ended on "${plan.crisis.text}" ` : ''}${ends}${onPlayer}
Reply with JSON only:
{${plan.crisis ? `"crisis":{"outcome":"one or two sentences","harm":${harmShape}},\n ` : ''}${rk ? `"reckoning":"one sentence: what ${rk.name} demands, decides or takes away",\n ` : ''}"montage":[{"after":"2d","text":"one or two sentences"}],
 "events":[{"text":"one sentence","scope":"local|regional|world","who":["character_id"],"where":"location_id",${reg}"visibility":"heard","moves":[],"effects":null}],
 "major_event":{"text":"one or two sentences","scope":"local|regional|world","who":["character_id"],"where":"location_id",${reg}${writesMajor ? `"harm":${harmShape},` : ''}"effects":${effectShape(state)}},
 "positions":[{"id":"character_id","where":"location_id","doing":"what they are doing when it hits"}],
 "player_where":"location_id"}
Guidelines:${plan.crisis ? `
- crisis: how that emergency plays out first, without ${pc.name}, in "outcome", and what it costs: ignored emergencies cost something real. List anyone it hurts in "harm" (only people who were there), or [] if the cost is something else.` : ''}
- montage: 2 to 4 moments in order, spread across the downtime ("after" = time since it began, like "3d" or "10h"), all after the last scene (never retell it). How people pass the time, relationships shifting, small incidents, secrets being worked on. ${pc.name} does only what their plan says ("${action || 'keep to routine'}"): no repairs, decisions or leading anyone that the plan doesn't name. Others deal with what comes up, or fail to.${climb.length ? ` The plan leaves out ${climb.map((id) => Eng().needLimit(state, id).missing).filter((w, i, a) => a.indexOf(w) === i).join(' and ')}: show it wearing on ${pc.name}.` : ''}${writesMajor ? `
- major_event.harm: anyone it hurts (only people it names or who are where it happens), or []. Danger here is real.` : ''}
- events: 0 to 2 newsworthy things during the downtime, with concrete effects for regional/world ones (use only existing ids/keys: ${effectIds(state)}).
- positions: one entry for EVERY other character: ${Eng().cast(state, { alive: true, includePlayer: false }).join(', ')}. Locations: ${Object.keys(state.locations).join(', ')}.
- player_where: where ${pc.name} is when it hits, consistent with their plan.`;
  };

  P.layouts.narrateSkip = ['downtimeFrame', 'status', 'lore', 'lastScene', 'montage', 'alsoDuring', 'endsIt', 'whereEveryone', 'worn', 'narrateSkipTask', 'endingClose'];
  P.narrateSkip = function (state, action, frame, montage, doings, res, presentStart) {
    const pc = state.characters[state.player];
    const here = pc.status.location;
    const present = Eng().present(state, here);
    return P.build('narrateSkip', { state, pc, here, loc: state.locations[here], present, statusIds: present, action, frame, montage, doings, res });
  };

  B.downtimeFrame = ({ state, pc, here, loc, present, action, frame }) => `=== DOWNTIME FRAME ===
From ${frame.startTime} to ${frame.endTime} (${spanWords(frame)}).
${pc.name}'s plan for the downtime: "${action || 'keep to routine'}"${frame.journey ? `\nThe downtime is a journey: ${frame.journey}.` : ''}
When it ends, ${pc.name} is in ${loc ? loc.name : here} with ${present.length ? present.map((id) => name(state, id)).join(', ') : 'no one'}.
${worldLines(state)}`;
  B.montage = ({ montage }) => (montage.length ? '\n=== DURING THE DOWNTIME ===\n' + montage.map((m) => `- after ${m.after || '?'}: ${m.text}`).join('\n') : null);
  B.alsoDuring = ({ res }) => {
    const others = res.events.filter((e) => !/^\[major\]/.test(e));
    return others.length ? '\n=== ALSO DURING THE DOWNTIME ===\n' + others.map((e) => '- ' + e).join('\n') : null;
  };
  B.endsIt = ({ res, frame }) => `\n=== WHAT ENDS IT ===\n${res.major ? res.major.text.replace(/^\[major\]\s*/, '') : frame.arrival ? `The journey's end: arriving at ${frame.arrival}.` : '?'}`;
  B.whereEveryone = ({ state, doings }) => (doings.length
    ? '\n=== WHERE EVERYONE IS WHEN IT HITS ===\n' + doings.map((p) => `- ${name(state, p.id)}: in ${state.locations[state.characters[p.id].status.location].name}, ${p.doing}`).join('\n')
    : null);
  B.narrateSkipTask = ({ pc, loc, frame }) => {
    const dead = pc.status.health === 'dead';
    const useDays = frame.days >= 2;
    const mins = frame.spanMinutes || Math.round(frame.days * 1440);
    const useMins = !useDays && mins < 180;
    const endMark = useDays ? `[+${frame.days}d]` : useMins ? `[+${mins}m]` : `[+${Math.round(mins / 60)}h]`;
    return `
=== TASK ===
Write 3 or 4 beats in second person ("you" is ${pc.name}): one short paragraph each, 2 to 4 sentences, and at most two for the final beat (250–350 words in total). Start each beat on its own line with a time marker since the downtime began: ${useDays ? '[+0d], [+3d], [+8d]' : useMins ? '[+0m], [+20m], [+45m]' : '[+0h], [+6h], [+15h]'} and so on.
1. The first beats are a brief montage of the downtime, starting after the last scene (never retell it), a few sentences each: how the days pass, how people get along, the small things. ${pc.name} does only what their plan says and treats people according to the feelings in STATUS; others deal with whatever comes up.
2. The final beat starts with ${endMark} and is a live scene in present tense: ${frame.arrival ? `${pc.name} arrives at ${frame.arrival}, and whoever is there notices` : `the thing that ends the downtime hits ${loc ? loc.name : 'where ' + pc.name + ' is'}, and the people there react in their own voices`}.
Hard rules:
- Use each character's pronouns exactly as given in STATUS.
- Do not reveal anyone's secrets unless the montage above says it came out.
${dead ? `- ${pc.name} dies here (STATUS). The final beat is their death and how the others take it. This ends the story: close on it, not on a question.` : `- No big decisions for ${pc.name}. End the final beat on a moment that demands the player's response; the last paragraph is never ${pc.name}'s own line or action.`}
Reply with the beats only.`;
  };

  // ---------- update ----------
  P.layouts.update = ['validIds', 'whatHappened', 'sceneNarrated', 'updateCrisis', 'updateTask', 'updateEndings'];
  // Endings the model rules on (judged): only those on offer now, with a
  // quote the engine looks for in the scene.
  B.updateEndings = ({ state }) => {
    const list = Eng().judgedEndings(state);
    return list.length
      ? ['\n=== ENDINGS ===', 'The story ends if the scene above SHOWS one of these happening (not planned, hoped for, attempted or nearly):']
        .concat(list.map((e) => `- ${e.id}: ${e.when.judged}`))
        .concat(['If one happened, add to your JSON "ending": {"id": "the id", "quote": "the exact words from the scene that show it"}. Otherwise leave "ending" out.'])
      : null;
  };
  // The closing scene of an ending the update found (judged endings).
  P.layouts.closing = ['closingScene', 'closingTask'];
  P.closing = (state, ending) => P.build('closing', { state, ending, pc: state.characters[state.player] });
  B.closingScene = ({ state }) => {
    const r = state.recent && state.recent[state.recent.length - 1];
    return r ? `=== THE LAST SCENE ===\n${r.text}` : null;
  };
  B.closingTask = ({ ending, pc }) => `
=== TASK ===
That scene ended the story: "${ending.title}" (${ENDING_TONE[ending.kind] || ENDING_TONE.neutral}). ${ending.judged ? `It happened: ${ending.judged}.` : ''}${ending.epilogue ? ` ${ending.epilogue}` : ''}
Write the closing in second person, present tense ("you" is ${pc.name}): 2 or 3 short paragraphs (100–180 words). Pick up right after the last scene, show the ending settle, then a brief look at what it means for the people in this story. Use only what has happened; invent no new turns. Close on it: no question, no choice left open.
Reply with the closing text only.`;
  B.updateCrisis = ({ state, res }) => (res && res.crisisText
    ? `\n=== AN EMERGENCY WAS STILL HAPPENING ===\nThe scene began with an emergency still unanswered: "${res.crisisText}" If ${state.characters[state.player].name}'s action ignored it, the people who needed ${state.characters[state.player].name} may think less of them: record that in relations, with the reason.`
    : null);
  P.update = (state, action, res, prose, present, cut) =>
    P.build('update', { state, sc: state.scenario, action, res, prose, present, cut });

  B.validIds = ({ state, sc, present }) => `=== VALID IDS ===
characters: ${Eng().cast(state).join(', ')}
locations: ${Object.keys(state.locations).join(', ')}
world keys: ${Object.keys(state.world).join(', ') || '(none)'}
groups: ${(state.factions || []).map((f) => f.id).join(', ') || '(none)'}
clocks (higher = closer to going off; a negative delta puts it off): ${state.clocks.filter((c) => !c.fired).map((c) => `${c.id} ("${c.name}")`).join(', ') || '(none)'}
${updateSiteIds(state)}${Object.keys(state.standees || {}).length ? `unnamed groups (count, state, location only): ${Object.values(state.standees).map((g) => `${g.id} (${g.count}, ${g.state}) in ${g.location}`).join(', ')}\n` : ''}${Object.keys(state.extras || {}).length ? `minor people (facts and location only): ${Object.values(state.extras).map((x) => `${x.id}${x.location ? ' in ' + x.location : ''}`).join(', ')}\n` : ''}${sc.needs.length ? `needs: ${sc.needs.map((n) => n.id).join(', ')}\n` : ''}present this turn: ${[state.player].concat(present).join(', ')}`;
  // Doors next to the player, features with a state there, and unknown rooms (task 3-6).
  function updateSiteParts(state) {
    const here = state.characters[state.player].status.location;
    const ways = Eng().linkedRooms(state, here).filter((o) => { const k = Eng().linkInfo(state, here, o); return k && k.kind !== 'open'; })
      .map((o) => `${[here, o].sort().join('|')} (${wayText(state, here, o).replace(/^[^(]*\(|\)$/g, '')})`);
    const feats = Eng().features(state, here).filter((f) => f.state).map((f) => `${here}|${f.name} (${f.state})`);
    const unseen = Object.keys(state.locations).filter((r) => !(state.seenRooms || []).includes(r));
    return { ways, feats, unseen };
  }
  function updateSiteShape(state) {
    const { ways, feats, unseen } = updateSiteParts(state);
    return (ways.length ? '          {"target":"link:room_a|room_b","field":"open","value":true},\n' : '') +
      (feats.length ? '          {"target":"feature:room_id|name","field":"state","value":"new state"},\n' : '') +
      (unseen.length ? '          {"target":"room:room_id","field":"seen","value":true},\n' : '');
  }
  function siteGuide(state) {
    const { ways, feats, unseen } = updateSiteParts(state);
    const bits = [];
    if (ways.length) bits.push('a door, hatch or window is opened or shut only when the scene shows it, and a locked one never opens here');
    if (feats.length) bits.push("a thing's state changes only when the scene shows it (a camera switched off)");
    if (unseen.length) bits.push('a room is revealed only when the scene shows a plan of it or someone describes it');
    return bits.length ? `\n- the place: ${bits.join('; ')}.` : '';
  }
  function updateSiteIds(state) {
    const { ways, feats, unseen } = updateSiteParts(state);
    return (ways.length ? `ways here (open or shut): ${ways.join(', ')}\n` : '') + (feats.length ? `things here with a state: ${feats.join(', ')}\n` : '') +
      (unseen.length ? `rooms the player doesn't know yet: ${unseen.join(', ')}\n` : '');
  }
  B.whatHappened = ({ state, action, res, cut }) => (cut
      ? '\n=== WHAT WAS PLANNED THIS TURN (the player stepped in partway: only what the scene below shows actually happened; moves, events and lines it does not show did NOT happen) ===\n'
      : '\n=== WHAT HAPPENED THIS TURN (full truth, including hidden actions) ===\n') + `Player action: "${action}"\n` + outcomeLines(state, res, false);
  B.sceneNarrated = ({ prose, cut }) => '\n=== SCENE AS NARRATED ===\n' + prose + (cut ? '\n\n[The player stepped in here. Anything planned above that is not in this scene did NOT happen; record only what is in the scene.]' : '');
  // Needs lines appear only for worlds that track needs (task 1-5).
  const needsList = (sc) => {
    const labels = sc.needs.map((n) => (n.label || n.id).toLowerCase());
    return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} are` : `${labels[0]} is`;
  };
  B.updateTask = ({ state, sc }) => `
=== TASK ===
Record what changed this turn. Reply with JSON only, exactly in this shape:
{"facts":[{"about":["character_id"],"text":"one short sentence using names, not pronouns","known_by":["character_id"],"weight":2}],
 "state":[{"target":"char:character_id","field":"health","value":"ok|hurt|badly_hurt|dead"},
          {"target":"char:character_id","field":"location","value":"location_id"},
          {"target":"char:character_id","field":"add_tag","value":"short visible state","turns":6,"reason":"why"},
          {"target":"char:character_id","field":"remove_tag","value":"existing tag"},
          {"target":"char:character_id","field":"mood","value":"how they come across now","reason":"why"},${sc.needs.length ? `
          {"target":"char:character_id","field":"need","need":"need_id","delta":-0.5},` : ''}
${Object.keys(state.standees || {}).length ? `          {"target":"standee:group_id","field":"count","delta":-1},
          {"target":"standee:group_id","field":"state","value":"calm|alert|hostile|fled|down"},
` : ''}${updateSiteShape(state)}          {"target":"world:key","value":"new short description"},
          {"target":"faction:group_id","value":"new short stance"},
          {"target":"clock:clock_id","delta":-2}],
 "relations":[{"from":"character_id","to":"character_id","delta":5,"reason":"short reason"}],
 "player_attitude":[{"to":"character_id","delta":-5,"reason":"short reason in past tense"}],${sc.inventExtras ? `
 "new_extras":[],` : ''}
 "chapter_worthy":false}
Guidelines:
- 1 to 5 facts. Only things that actually happened or were revealed. Skip trivia.
- known_by lists who witnessed or was told. Use ["all"] only when everyone at the location would know. Hidden actions are known only by the actor and anyone who caught them.
- What ${name(state, state.player)} knows is limited to what they could see or hear in the narrated scene. Other characters' motives, plans and secrets are NOT known by ${name(state, state.player)} unless explicitly revealed; record those as known only by that character.
- weight: 1 minor detail, 2 notable, 3 major turning point (injury, death, betrayal, discovery, confession).
- Anything listed under REVEALS should become a fact known by the revealer and whoever was told.
- state: only real changes.${sc.needs.length ? ' Eating or resting lowers needs (negative delta).' : ''} Repairs or sabotage can move clocks (negative delta delays, positive hastens). location: only for other characters who were seen leaving or arriving in the scene (where they went or came from). Never for ${name(state, state.player)}.
- groups: update a group's stance only when this turn's events would realistically change how that group sees things.
- world values are short factual status (e.g. "degraded, about 70% output"). Only change one when that status actually changed this turn.
- tags: short visible states or situations (e.g. "sprained ankle", "covered in dust", "on night shift"), at most 5 words, with "turns" for how long they last (default 6). Remove tags that no longer fit. Not feelings${sc.needs.length ? `; ${needsList(sc)} tracked as needs` : ''}.
- mood: for each non-player character present, at most one short line on how they come across right now, as others could read it (e.g. "short with everyone, avoiding Okafor"). Only when it changed. Never for ${name(state, state.player)}, and never hint at anyone's secret.
- relations: how this turn changed how non-player characters feel about others (never ${name(state, state.player)}'s own feelings), delta between -15 and 15. Leave empty if nothing changed.
- player_attitude: how ${name(state, state.player)}'s own feelings toward someone shifted, judged ONLY from the player action as quoted above (their words and tone), never from how the narrator embellished it. Snapping, mocking or threatening lowers it; thanking, helping, joking warmly or confiding raises it. Delta between -10 and 10. Leave empty if the action was neutral.
- chapter_worthy: true only for a major turning point.${Object.keys(state.extras || {}).length ? `
- minor people: may be in facts (about, known_by) and may change location; no relations, moods, tags or needs.` : ''}${Object.keys(state.standees || {}).length ? `
- unnamed groups: count goes down for members killed, captured or gone (it only goes up if an event brought more); state when the scene shows them change (fled: they leave for good); location only one linked room, when seen leaving.` : ''}${siteGuide(state)}${sc.inventExtras ? `
- new_extras: only if the scene clearly brought in a new minor person or group not listed above: {"name","role","location","group":false}. At most 1.` : ''}
Use [] for any list with nothing to record.`;

  // ---------- suggested actions ----------
  // Ideas for the player's next action. Only what the player knows: the
  // header, the narrator-side status (no secrets, no one else's feelings) and
  // the scene as far as the player has read it.
  P.layouts.suggest = ['now', 'suggestScene', 'suggestTask'];
  P.suggest = (state, sceneText) =>
    P.build('suggest', { state, pc: state.characters[state.player], present: Eng().present(state), forNarrator: true, sceneText });
  B.suggestScene = ({ state, sceneText }) => {
    if (sceneText != null) return `\n=== LAST SCENE ===\n${sceneText}`;
    return B.lastScene({ state });
  };
  B.suggestTask = ({ pc }) => `
=== TASK ===
Suggest 4 different things ${pc.name} could do next, written the way the player would type them (like "Ask Teo where he was last night."), one short sentence each, under 15 words.${pc.want ? ` ${pc.name}'s own goal: ${pc.want}.` : ''}
Make them different: one that talks to someone here, one practical task, one that pursues ${pc.name}'s goal or a pressure above, and one bolder or riskier.
Use only people, places and things from the scene and the lists above. Say what ${pc.name} tries, never how it turns out.
Reply with JSON only: {"suggestions":["...","...","...","..."]}`;

  // ---------- agenda proposal (task 2-2) ----------
  // One person in the background gets a goal of their own. Like the intent
  // call, it sees their secret; it never reaches the narrator.
  P.layouts.agenda = ['agendaPerson', 'agendaTask'];
  P.agenda = (state, id, previous) => P.build('agenda', { state, c: state.characters[id], id, previous });
  B.agendaPerson = ({ state, c, id, previous }) => {
    const loc = state.locations[c.status.location];
    const lines = [`=== ${c.name.toUpperCase()} (${id}) ===`, `${c.role}${c.pronouns ? ', ' + c.pronouns : ''}, in ${loc ? loc.name : c.status.location}. ${E.fmtTime(state)}.`];
    if (c.traits && c.traits.length) lines.push(`Traits: ${c.traits.join(', ')}.`);
    if (c.want) lines.push(`Wants: ${c.want}.`);
    if (c.secret) lines.push(`Secret (private): ${c.secret}`);
    Mem().privateFacts(state, id).slice(-3).forEach((f) => lines.push(`Knows: ${f.text}`));
    if (previous) lines.push(`Just finished working toward: ${previous}.`);
    return lines;
  };
  B.agendaTask = ({ state, c, previous }) => `
=== TASK ===
Give ${c.name} an agenda: what ${c.pronouns && /^she/.test(c.pronouns) ? 'she' : c.pronouns && /^he/.test(c.pronouns) ? 'he' : 'they'} quietly works toward over the next few days while ${state.characters[state.player].name} is elsewhere, driven by ${previous ? 'what comes next after that goal' : 'their want and secret'}.
- goal: one short phrase.
- steps: 2 to 4 short actions in order, each starting with a verb, without the name (like "runs a second test on the ice cultures").
- hours: how long each step takes, 4 to 48.
- contact_step: the index (0-based) of a step that brings ${c.name} to find ${state.characters[state.player].name}, or null.
If ${c.name} would simply keep to routine, reply {"routine":true}.
Reply with JSON only: {"goal":"...","steps":["...","..."],"hours":12,"contact_step":null}`;

  // ---------- promoting an extra (task 2-3) ----------
  // Turns a minor person into a full character. Sees everything known about
  // them, private facts included; the result is checked like a character file.
  P.layouts.fleshOut = ['extraStub', 'fleshOutTask'];
  P.fleshOut = (state, id) => P.build('fleshOut', { state, x: state.extras[id], id });
  B.extraStub = ({ state, x, id }) => {
    const loc = x.location && state.locations[x.location];
    const lines = [`=== ${x.name.toUpperCase()} (${id}) ===`, `${x.role}${x.pronouns ? ', ' + x.pronouns : ''}${loc ? `, usually in ${loc.name}` : ''}.${x.note ? ' ' + x.note : ''}`];
    const facts = state.facts.filter((f) => (f.about || []).includes(id) || (f.known_by || []).includes(id)).slice(-8);
    if (facts.length) lines.push('What has happened with them:', ...facts.map((f) => `- ${f.text}`));
    // How the last scene showed them, so the sheet doesn't contradict it
    // (playtest-albee-promoted: curlers and a reedy voice became a neat bun
    // and a crisp one).
    const surname = x.name.split(/\s+/).pop().toLowerCase();
    const shown = (state.log || []).filter((e) => e.type === 'scene' && e.text && e.text.toLowerCase().includes(surname)).slice(-2).map((e) => e.text);
    if (shown.length) lines.push('\n=== HOW THE STORY HAS SHOWN THEM ===', E.shorten(shown.join('\n\n'), 1600));
    return lines;
  };
  B.fleshOutTask = ({ state, x }) => `
=== TASK ===
${x.name} has come to matter in the story. Write their character sheet. Keep the name and the role. Stay consistent with how the story has shown them: their looks, voice and what they said or did, and the note above.
Reply with JSON only:
{"pronouns":"she/her","age":40,"role":"${x.role}","traits":["three","short","traits"],"want":"what they want, one phrase","secret":"something they hide, or null","guard":"low|medium|high","voice":"how they talk, one sentence","appearance":"one or two sentences, the first a good one-line look","description":"who they are, one or two sentences","skills":{${state.scenario.skills.map((k) => `"${k}":1`).join(',')}},"relations":{"character_id":10},"agenda":{"goal":"what they work toward next","steps":["verb phrase","verb phrase"],"hours":12,"contact_step":null}}
- skills from 0 to 4. relations: how they feel about cast members they have met, from -30 to 30 (ids: ${Eng().cast(state).join(', ')}).`;

  // ---------- character creator (task 4-1) ----------
  // One field for the character the player is making, from what they have
  // filled in so far. state is the draft game (CharMaker.draftState), so the
  // header is the one the game will use. The player's own secret stays out:
  // the suggestion is shown to them, and nothing needs it.
  P.layouts.charSuggest = ['charDraft', 'charSuggestTask'];
  P.charSuggest = (state, field, form) => P.build('charSuggest', { state, sc: state.scenario, field, form: form || {} });
  B.charDraft = ({ state, sc, form }) => {
    const slot = sc.playerSlot || {};
    const choice = (list, id, free) => {
      const r = (list || []).find((x) => x.id === id);
      return r ? `${r.label}${r.desc ? ` — ${r.desc}` : ''}` : (free || '').trim() || null;
    };
    const loc = state.locations[slot.location];
    const lines = ['=== MAKING A CHARACTER ===', `The player is making the character they will play, joining this story in ${loc ? loc.name : slot.location}.`];
    const add = (label, v) => { if (v != null && String(v).trim()) lines.push(`${label}: ${String(v).trim()}`); };
    add('Name', form.name);
    add('Pronouns', form.pronouns);
    add('Age', form.age);
    add('Role', choice(slot.roles, form.role, form.roleText));
    add('People', choice(slot.peoples, form.people, form.peopleText));
    add('Traits', (form.traits || []).join(', '));
    add('Wants', form.want);
    add('Voice', form.voice);
    add('Appearance', form.appearance);
    add('Description', form.description);
    return lines;
  };
  const CHAR_ASK = {
    traits: ['Suggest 4 short personality traits (one or two words each) that fit this character and differ from the ones they already have.', '{"traits":["...","...","...","..."]}'],
    voice: ['Suggest how this character talks: one sentence, under 25 words, like "Few words, dry humor, calm under pressure."', '{"voice":"..."}'],
    description: ['Suggest a short description of who this character is: two sentences, under 60 words, about their past and their place here. No secrets, nothing about the future.', '{"description":"..."}'],
  };
  B.charSuggestTask = ({ field }) => `
=== TASK ===
${CHAR_ASK[field][0]} Keep to the setting and to what the player has filled in.
Reply with JSON only: ${CHAR_ASK[field][1]}`;

  // ---------- character cards (task 6-2) ----------
  // A Tavern card turned into a sheet for this world. System: the generated
  // starts' header (setting, genre, rules, places, groups, names in use).
  // User: only the card's description, personality and example dialogue; its
  // scenario, first message and system prompt are never sent.
  P.cardConvert = function (sc, card) {
    const names = (sc.characterData || []).map((c) => c.name).filter((n) => n !== card.name);
    const u = E.Cards.used(card);
    const lines = ['=== A CHARACTER CARD ===', `Name: ${card.name}`];
    if (u.description) lines.push(`Description:\n${u.description}`);
    if (u.personality) lines.push(`Personality:\n${u.personality}`);
    if (u.examples) lines.push(`How they talk (examples):\n${u.examples}`);
    lines.push(`
=== TASK ===
Turn this character into a person who lives in the world above. Keep their personality, manner and voice; give them a role, a want and a past that fit this world. Leave out whatever the card says about a scene, a meeting or a relationship with the reader: they haven't met the player. Write about them in the third person, never to "you".
Reply with JSON only:
{"pronouns":"she/her","age":30,"role":"their place in this world, a few words","people":"a people or origin, or null","traits":["three","short","traits"],"want":"what they want, one phrase","voice":"how they talk, one sentence","appearance":"one or two sentences, the first a good one-line look","description":"who they are here, one or two sentences","secret":"something they hide, only if the card implies one, or null","guard":"low|medium|high","skills":{${(sc.skills || []).map((k) => `"${k}":1`).join(',')}}}
- skills from 0 to 4.`);
    return { system: P.genHeader(sc, { names: new Set(names) }), user: lines.join('\n') };
  };

  // ---------- generated starts (task 4-2) ----------
  // System: the same header for every step of a job (setting, genre, rules,
  // geography, groups, names already used), so KoboldCpp reuses it. User:
  // where it starts, a short summary of what earlier steps made (one line per
  // item, not their JSON) and the step's task. Secrets appear only in the
  // ties step, which builds tensions from them.
  P.layouts.genHeader = ['genIntro', 'setting', 'genre', 'genRules', 'regions', 'groups', 'loreAlways', 'genNames'];
  P.genHeader = (sc, taken) => P.build('genHeader', { sc, taken });
  B.genIntro = () => 'You are building the starting situation for an interactive, character-driven story set in the world below. The player plays one person; everyone else is simulated, each with their own wants, needs, secrets and feelings. Write grounded, specific material that fits the setting.';
  B.genRules = ({ sc }) => ((sc.rules || []).length ? ['\n=== RULES ==='].concat(sc.rules.map((r) => '- ' + r)) : null);
  B.genNames = ({ taken }) => {
    const names = [...((taken && taken.names) || [])];
    return names.length ? `\n=== NAMES ALREADY IN THE WORLD (don't reuse them) ===\n${names.join(', ')}` : null;
  };

  const GEN_TASKS = {};
  P.genStep = (ctx, step, index) => P.build('gen', Object.assign({}, ctx, { step, index }));
  P.layouts.gen = ['genPlace', 'genSoFar', 'genTask'];
  B.genPlace = ({ sc, job }) => {
    const r = (sc.regions || []).find((x) => x.id === job.region);
    const lines = ['=== WHERE THIS STARTS ==='];
    if (r) {
      const holder = (sc.factions || []).find((f) => f.id === r.controller);
      lines.push(`Region: ${r.name}${r.lore ? ` — ${r.lore}` : ''}`);
      lines.push(`Held by: ${holder ? holder.name : 'no one'}.${r.status ? ` Right now: ${r.status}.` : ''}${(r.tags || []).length ? ` (${r.tags.join(', ')})` : ''}`);
      const nameOf = (id) => ((sc.regions || []).find((x) => x.id === id) || {}).name;
      const up = E.Scenario.regionChainIn(sc.regions, r.id).slice(1).map(nameOf).filter(Boolean);
      if (up.length) lines.push(`Inside: ${up.join(' › ')}.`);
      // Not a hidden region (R-5).
      const seen = new Set(P.knownAtStart(sc).map((x) => x.id));
      const near = E.Scenario.regionNearIn(sc.regions, r.id).filter((x) => seen.has(x)).map(nameOf).filter(Boolean);
      if (near.length) lines.push(`Next to: ${near.join(', ')}.`);
    }
    // Somewhere not on the map (R-7): the story starts there, inside the region above.
    if (job.place) lines.push(`Where exactly: the player starts at ${job.place}${r ? `, in ${r.name}` : ''}.`);
    const g = sc.start;
    if (g) lines.push(`When: ${E.dayName(sc, g.day)}, ${String(g.hour).padStart(2, '0')}:00.`);
    if (job.note) lines.push(`What the player wants from this story: ${job.note}`);
    return lines;
  };
  const sheetLine = (c, secrets, rooms) => {
    const room = (rooms || []).find((r) => c.status && r.id === c.status.location);
    return `- ${c.id}: ${c.name}${c.pronouns ? ` (${c.pronouns})` : ''}, ${c.role}${c.age ? ', ' + c.age : ''}${room ? `, in ${room.name}` : ''}. Traits: ${(c.traits || []).join(', ')}. Wants: ${c.want}.${secrets && c.secret ? ` Secret: ${c.secret}` : ''}`;
  };
  B.genSoFar = ({ job, step, reroll }) => {
    const s = job.steps;
    const lines = [];
    const pc = s.player && s.player.character;
    if (pc && step !== 'player') lines.push(`The player: ${pc.name}${pc.pronouns ? ` (${pc.pronouns})` : ''}, ${pc.role}${pc.age ? ', ' + pc.age : ''}. Traits: ${(pc.traits || []).join(', ')}. Wants: ${pc.want}.${pc.description ? ' ' + pc.description : ''}`);
    if (s.rooms && step !== 'rooms') {
      const here = s.rooms.rooms.find((r) => r.id === s.rooms.playerRoom);
      lines.push(`Rooms (the player starts in ${here.name}):`);
      s.rooms.rooms.forEach((r) => lines.push(`- ${r.id}: ${r.name} — ${r.desc} (connects: ${r.connects.join(', ')})`));
    }
    if (s.plan && step !== 'plan' && !s.cast) {
      lines.push('People planned:');
      s.plan.people.forEach((p) => lines.push(`- ${p.name}, ${p.role}${p.hook ? `: ${p.hook}` : ''}`));
    }
    // Rerolling one person (task 4-3) shows the others, not the sheet being replaced.
    const people = s.cast ? s.cast.people.filter((c) => c.id !== reroll) : (step === 'person' && job.partial.cast) || [];
    if (people.length && step !== 'cast') {
      lines.push(step === 'person' ? 'People already written:' : 'People:');
      people.forEach((c) => lines.push(sheetLine(c, step === 'ties', s.rooms && s.rooms.rooms)));
    }
    if (s.ties && step !== 'ties') {
      lines.push('Pressures:');
      s.ties.clocks.forEach((c) => lines.push(`- ${c.name} (when it comes to a head: ${c.fireText}${(c.then || []).map((t) => `; then ${t.name}`).join('')})`));
    }
    // Local lore (task 5-6) is written knowing the start's title and summary.
    if (s.opening && step === 'lore') lines.push(`The start: ${s.opening.title}. ${s.opening.summary}`);
    if (s.extras && step === 'opening') {
      s.extras.extras.forEach((x) => lines.push(`- minor person: ${x.name}, ${x.role}${x.location ? ` (in ${x.location})` : ''}`));
      s.extras.standees.forEach((g) => lines.push(`- group: ${g.count} ${g.label} (in ${g.location}, ${g.state})`));
    }
    return lines.length ? ['\n=== MADE SO FAR ==='].concat(lines) : null;
  };
  B.genTask = (ctx) => '\n' + GEN_TASKS[ctx.step](ctx);

  const skillJson = (sc, n) => `{${sc.skills.map((k) => `"${k}":${n}`).join(',')}}`;
  // A world the player describes (customSetting): its setting comes first,
  // and every later step's header uses it.
  GEN_TASKS.setting = ({ job }) => `=== TASK: THE WORLD ===
The player describes the world they want this story set in: "${job.worldText}"
Write the setting the storyteller will keep to for the whole story: 3 to 5 sentences on where and when it is, what daily life is like, who holds power, and what is at stake or dangerous. Keep everything the player said (names, places, era) and fill in the rest so it fits. Write about the world in the third person; no characters yet, no plot and no secrets.
Also give up to ${E.StartGen.SETTING.tags} genre tags, most important first (known ones: ${Object.keys(E.Genres.table).join(', ')}; others are fine) and a one-sentence tone note.
Reply with JSON only: {"setting":"3 to 5 sentences","tags":["slice-of-life"],"toneNote":"one sentence"}`;
  GEN_TASKS.player = ({ sc, job, loaded }) => {
    const g = E.StartGen.slot(loaded.bundle.world);
    const roles = g.roles.map((r) => r.label);
    return `=== TASK: THE PLAYER'S CHARACTER ===
The player describes the character they want to play: "${job.line}"
Write their character sheet. Keep to what they said and fill in the rest so it fits the setting.${roles.length ? ` Roles that fit here: ${roles.join(', ')} (or another).` : ''} Skills: up to ${g.skillPoints} points in all, each from 0 to ${g.maxSkill}.
Reply with JSON only: {"name":"Full Name","pronouns":"she/her","age":30,"role":"short role","traits":["three","short","traits"],"want":"what they want, one phrase","secret":"something they hide, or null","guard":"low|medium|high","voice":"how they talk, one sentence","appearance":"one or two sentences, the first a good one-line look","description":"who they are, one or two sentences","skills":${skillJson(sc, 1)}}`;
  };
  GEN_TASKS.rooms = ({ sc, job }) => {
    const r = (sc.regions || []).find((x) => x.id === job.region);
    return `=== TASK: THE PLACE ===
Invent where the story starts${job.place ? `, at ${job.place}` : r ? `, somewhere in ${r.name}` : ''}: 3 to 6 rooms or areas the player can walk between (inside one building, or a few spots close together outdoors). Each needs a short id (lowercase, dashes), a name, one sentence of description and the rooms it connects to. Every room must be reachable. Pick the room the player starts in.
Reply with JSON only: {"rooms":[{"id":"back-room","name":"Back Room","desc":"One sentence.","connects":["shop-floor"],"outside":false}],"player_room":"back-room"}`;
  };
  GEN_TASKS.plan = ({ loaded }) => {
    const [min, max] = E.StartGen.castSize(loaded.bundle.world);
    return `=== TASK: WHO IS HERE ===
Plan the ${min} to ${max} people (not counting the player) who are in or around these rooms when the story starts. Make them different from each other in age, background, temperament and what they want, and give each a hook: something about them that will cause trouble. Someone may be the player's family or an old friend when that fits the player's description or the story they asked for; otherwise they are people the player is only now getting to know. One line each.
Reply with JSON only: {"people":[{"name":"Full Name","role":"short role","hook":"one line"}]}`;
  };
  const SHEET = (sc) => `"pronouns":"she/her","age":40,"traits":["three","short","traits"],"want":"what they want, one phrase","secret":"something they hide from the others","guard":"low|medium|high","voice":"how they talk, one sentence","appearance":"one or two sentences, the first a good one-line look","description":"who they are, one or two sentences","skills":${skillJson(sc, 1)},"room":"room-id"`;
  GEN_TASKS.person = ({ sc, job, index, reroll }) => {
    const p = job.steps.plan.people[index];
    return `=== TASK: WRITE ONE PERSON ===
Write the character sheet for ${p.name}, ${p.role}${p.hook ? ` (${p.hook})` : ''}. Keep the name and the role. Give them a want, and a secret they hide from the others (and how well they guard it: low, medium or high). Pick the room they are in at the start. Make them different from the people already written.${reroll ? ' This replaces an earlier sheet the player didn\'t like: write a fresh take on the same name and role.' : ''}
Reply with JSON only: {${SHEET(sc)}}
- skills from 0 to 4.`;
  };
  GEN_TASKS.room = ({ job, index }) => {
    const rooms = job.steps.rooms.rooms;
    const room = rooms.find((r) => r.id === index);
    const names = room.connects.map((id) => rooms.find((r) => r.id === id).name);
    return `=== TASK: REWRITE ONE ROOM ===
The player wants a different take on ${room.name} (connects to ${names.join(', ') || 'nothing'}). Keep where it is and what it connects to; give it a new name and one sentence of description that fit with the other rooms.
Reply with JSON only: {"name":"...","desc":"One sentence.","outside":false}`;
  };
  GEN_TASKS.cast = ({ sc, job }) => `=== TASK: WRITE THE PEOPLE ===
People planned:
${job.steps.plan.people.map((p) => `- ${p.name}, ${p.role}${p.hook ? `: ${p.hook}` : ''}`).join('\n')}
Write a character sheet for each of them. Keep each name and role. Give each a want, and a secret they hide from the others (and how well they guard it: low, medium or high). Pick the room each is in at the start.
Reply with JSON only: {"people":[{"name":"Full Name",${SHEET(sc)}}]}
- skills from 0 to 4.`;
  GEN_TASKS.ties = ({ job }) => `=== TASK: TIES AND PRESSURES ===
1. relations: how these people feel about each other and about the player at the start, from -50 (hostile) to 50 (close). Use the ids above ("${job.steps.player.character.id}" is the player). The player has only just met them unless the player's description or note says otherwise, so feelings toward the player are mild (-25 to 25). Only pairs that matter; leave out how the player feels.
2. knows: one private thing each person knows that the others don't (about someone else, the place or the situation; not their own secret).
3. pressures: 1 or 2 things getting worse over time that will force choices, like food running out or a deadline. "max" is how many steps until it comes to a head and "perHour" how many steps it grows each hour (max 8 with perHour 0.1 is about 80 hours); "fireText" is what happens then. Pressures are public: never about a secret. Optionally "then": the next pressure that starts once this one comes to a head (the power dies, then the cold sets in), in the same shape.
4. events: up to 3 short ideas for things that could happen around this place later (weather, neighbours, a supply run going wrong). Public too.
Reply with JSON only: {"relations":[{"from":"id","to":"id","value":20}],"knows":[{"id":"id","text":"..."}],"pressures":[{"name":"...","max":8,"perHour":0.1,"fireText":"...","then":{"name":"...","max":6,"perHour":0.2,"fireText":"..."}}],"events":["..."]}`;
  GEN_TASKS.extras = () => `=== TASK: MINOR PEOPLE AND GROUPS ===
Add up to 4 minor people (neighbours, passers-by, a voice on the radio) and up to 2 unnamed groups (guards, a crowd, a few of the dead) that fit this place. Put each in one of the rooms, or "room": null for a minor person who is nowhere in particular. Notes are for the story engine and never shown to the player. Adding none is fine.
Reply with JSON only: {"extras":[{"name":"...","role":"...","pronouns":"he/him","room":"room-id","note":"..."}],"groups":[{"label":"...","count":5,"room":"room-id","state":"calm|alert|hostile","note":"..."}]}`;
  GEN_TASKS.opening = ({ job }) => {
    const here = job.steps.rooms.rooms.find((r) => r.id === job.steps.rooms.playerRoom);
    return `=== TASK: THE OPENING ===
Write the opening scene the player reads first: 2 to 4 short paragraphs in second person ("you"), present tense, in ${here.name}, showing who is there and what is going on, and ending on someone else's move or line. Never decide what the player does, says or feels. Don't reveal anyone's secret.
List in "with_you" the ids of the people who are in ${here.name} with the player when it opens; they start there, whatever room their sheet gave them. People elsewhere can be heard or glimpsed at most.
Also give the start a short title, a one-sentence summary for the player (second person: who they are and what's going on) and up to 3 public facts everyone here knows.
Reply with JSON only: {"title":"...","summary":"You are ...","opening":"...","with_you":["id"],"facts":["..."]}`;
  };

  // Local lore (task 5-6): a few public entries about this start's places.
  // Never sees secrets (the checker does); the world lore it must not repeat
  // is named by title only.
  GEN_TASKS.lore = (ctx) => {
    const regions = E.StartGen.loreRegions(ctx);
    const covered = E.Lore.entries(ctx.sc).filter((e) => e.level === 'world' || e.level === 'topic' || (e.level === 'region' && regions.some((r) => r.id === e.ref))).map((e) => e.title);
    const L = E.StartGen.LORE;
    return `=== TASK: LOCAL LORE ===
Write ${L.min} to ${L.max} short notes on local things this story will come back to, so they stay the same from scene to scene: this place itself, its street or neighbourhood, a workplace, a club, a local custom or rule. Each is public knowledge anyone here knows, 40–80 words on one thing, in plain third person.
- "about": "location" with "ref" one of the room ids above${regions.length ? `, or "region" with "ref" ${regions.map((r) => `"${r.id}" (${r.name})`).join(' or ')}` : ''}.
- "keywords": the words someone would use for it, with nicknames. "topics": up to ${E.Lore.LIMITS.topics} of ${E.Lore.topicIds(ctx.sc).join(', ')}, or [].
- Never anyone's secret, nothing that hasn't happened yet, nothing about the player's past, and never "you".${covered.length ? ` The world's lore already covers ${covered.join('; ')}: don't repeat it.` : ''}
Reply with JSON only: {"entries":[{"title":"short title","about":"location","ref":"room-id","keywords":["name"],"topics":[],"text":"40–80 words"}]}`;
  };

  // ---------- generated sites (task 4-4) ----------
  // Building a place mid-turn. System: the turn's header (the same prefix,
  // so the cache holds). User: the request, the region, where the player is
  // coming from and the task. The layout and the people are separate calls,
  // each checked (js/sites.js).
  // A new region's lore (R-6): one call, the turn's header as its system message.
  P.layouts.regionLore = ['regionLoreTask'];
  P.regionLore = (state, req) => P.build('regionLore', { state, req });
  B.regionLoreTask = ({ state, req }) => {
    const parent = req.parent && Eng().regionDef(state, req.parent);
    const label = req.label ? `${/^[aeiou]/i.test(req.label) ? 'an' : 'a'} ${req.label}` : 'a place';
    return `=== TASK: A NEW REGION ===
The story heads to ${req.name}, ${label} ${parent ? `in ${parent.name}` : 'in this world'}, which isn't on the map yet.${req.stub && req.stub.summary ? ` The player has been there before (${req.stub.summary}).` : ''}
Write what everyone here knows about it, in one or two sentences: what kind of place it is, who lives there and how things are there now. Public knowledge only: no one's secrets, nothing that hasn't happened yet, and none of the story's people by name.
Reply with JSON only: {"lore":"one or two sentences"}`;
  };
  // A flavour place (R-8): rooms and who is there in one call, small and
  // without guards on posts or patrols.
  P.layouts.siteFlavour = ['siteRequest', 'siteFlavourTask'];
  P.siteFlavour = (state, req) => P.build('siteFlavour', { state, req });
  B.siteFlavourTask = () => `
=== TASK: THE PLACE AND WHO IS THERE ===
Describe this place in 1 to 3 rooms or areas (one is fine for a café or a room), one short sentence each, with an id (lowercase, dashes), the rooms it links to, up to 3 features that matter, and "outside": true for open ground. Name the room the player arrives in. Then who is there when the player arrives: up to 2 named people (with a role, the room and a note for the story engine) and up to 2 unnamed groups (a crowd, regulars) with how many and the room. Add a short note of what there is to find or do here (never shown to the player). An empty place is fine.
Reply with JSON only: {"rooms":[{"id":"cafe","name":"Café","desc":"One sentence.","links":[],"features":["counter"],"outside":false}],"entry":"cafe","people":[{"name":"...","role":"...","pronouns":"she/her","room":"cafe","note":"..."}],"groups":[{"label":"regulars","count":4,"room":"cafe","state":"calm"}],"note":"..."}`;
  // A flavour place turning tactical (R-8): more rooms around the ones it
  // has, which never move.
  P.layouts.siteGrow = ['siteRequest', 'siteRooms', 'siteGrowTask'];
  P.siteGrow = (state, req, layout) => P.build('siteGrow', { state, req, layout });
  B.siteGrowTask = ({ layout }) => `
=== TASK: MORE OF THIS PLACE ===
Things have turned dangerous here, so the place needs more of its layout: add 2 to 4 rooms or areas around the ones above (a back room, a stairwell, a yard, the way out the back). Keep the rooms above exactly as they are; only add new ones, each linked to a room above or to another new one, with a kind (open, door, locked door, vent, hatch, window, stairs), up to 3 features, "outside": true for open ground and "secure": true for a vault or cell (one way in only).
Reply with JSON only: {"rooms":[{"id":"stairwell","name":"Stairwell","desc":"One sentence.","links":[{"to":"${layout.rooms[0] ? layout.rooms[0].id : 'room-id'}","kind":"door"}],"features":[],"outside":false,"secure":false}]}`;
  P.layouts.siteLayout = ['siteRequest', 'siteLayoutTask'];
  P.siteLayout = (state, req) => P.build('siteLayout', { state, req });
  P.layouts.siteOccupants = ['siteRequest', 'siteRooms', 'siteOccupantsTask'];
  P.siteOccupants = (state, req, layout, library) => P.build('siteOccupants', { state, req, layout, library });
  B.siteRequest = ({ state, req }) => {
    const sc = state.scenario;
    const r = (sc.regions || []).find((x) => x.id === req.region);
    const live = r && state.regions[r.id];
    const holder = live && (sc.factions || []).find((f) => f.id === live.controller);
    const from = state.locations[state.characters[state.player].status.location];
    const lines = ['=== A NEW PLACE ===', `${req.name} (${req.kind})${r ? `, in ${r.name}${r.lore ? ` — ${r.lore.replace(/\.$/, '')}` : ''}` : ''}.`];
    if (r) lines.push(`Held by: ${holder ? `${holder.name} (${holder.id})` : 'no one'}.${live.status ? ` Right now: ${live.status}.` : ''}`);
    lines.push(`The player is coming from ${from ? from.name : 'nearby'}, ${E.fmtTime(state)}.`);
    if (req.why) lines.push(`Why it matters: ${req.why}`);
    if (req.stub && req.stub.summary) lines.push(`The player has been here before: ${req.stub.summary}.`);
    return lines;
  };
  B.siteLayoutTask = () => `
=== TASK: THE LAYOUT ===
Lay out this place: 2 to 6 rooms or areas, with one short sentence each. Give each room an id (lowercase, dashes), its links to other rooms with a kind (open, door, locked door, vent, hatch, window, stairs), up to 3 features (things that matter: "camera", "crates", "ledger terminal"), "outside": true for open ground, and "secure": true for a vault, cell or armory (one way in only). Name the entry room the player arrives in, and the ways in from outside ("entrances", "watched": true if guarded or covered by a camera).
Reply with JSON only: {"rooms":[{"id":"loading-bay","name":"Loading Bay","desc":"One sentence.","links":[{"to":"office","kind":"door"}],"features":["camera"],"outside":false,"secure":false}],"entry":"loading-bay","entrances":[{"room":"loading-bay","kind":"roller door","watched":true}]}`;
  B.siteRooms = ({ state, layout }) => ['\n=== ROOMS ==='].concat(layout.rooms.map((r) => {
    // Each link's kind from whichever side declared it (playtest-api-kessler-lobby).
    const kindTo = (c) => ((r.links || []).find((k) => k.to === c) || ((layout.rooms.find((o) => o.id === c) || {}).links || []).find((k) => k.to === r.id) || { kind: 'open' }).kind;
    const links = r.connects.filter((c) => layout.rooms.some((o) => o.id === c)).map((c) => `${kindTo(c)} to ${c}`);
    const feats = (r.features || []).map((f) => (typeof f === 'string' ? f : f.name));
    return `- ${r.id}: ${r.name} — ${r.desc}${links.length ? ` (${links.join(', ')})` : ''}${feats.length ? ` [${feats.join(', ')}]` : ''}${r.id === layout.entry ? ' (the way in)' : ''}`;
  }));
  B.siteOccupantsTask = ({ state, library }) => {
    const groups = (state.scenario.factions || []).map((f) => f.id).join(', ');
    return `
=== TASK: WHO AND WHAT IS HERE ===
Who is in this place when the player arrives: up to 2 named people (with a role, the room they're in and a note for the story engine: what they want here, what they know) and up to 3 unnamed groups (guards, a crowd, a few of the dead) with how many, the room, their state (calm, alert, hostile)${groups ? `, the group they belong to (${groups}) if any` : ''}, and "post": true if they hold that room or "patrol": a loop of linked room ids. Add a short note of what there is to find or do here (never shown to the player). An empty place is fine.${library ? ' The rooms come from a map: you may rename them to fit ("rooms": [{"id","name","desc"}]); keep the ids.' : ''}
Reply with JSON only: {"people":[{"name":"...","role":"...","pronouns":"she/her","room":"room-id","note":"..."}],"groups":[{"label":"...","count":3,"room":"room-id","state":"alert","faction":null,"post":true}],"note":"..."${library ? ',"rooms":[]' : ''}}`;
  };

  // ---------- chapter ----------
  // ---------- projected timeline events (task 5-2) ----------
  // When nothing is planned for the next few days, the model plans a few
  // likely, public events. It sees where things stand and the timeline so far
  // (for pacing), never secrets or future canon events.
  P.layouts.project = ['projectNow', 'projectPace', 'projectTask'];
  P.project = (state, cfg) => P.build('project', { state, sc: state.scenario, cfg, TL: E.Timeline });
  B.projectNow = ({ state }) => `=== PLANNING AHEAD: ${E.fmtTime(state)} ===\n${worldLines(state)}`;
  B.projectPace = ({ state, sc, TL }) => {
    const past = TL.history(state).slice(-5);
    const gap = TL.gap(state);
    const lines = ['\n=== THE TIMELINE SO FAR ==='];
    if (past.length) past.forEach((x) => lines.push(`- ${TL.fmt(sc, x.when)}: ${x.text}`));
    else lines.push('(nothing yet)');
    lines.push(gap ? `Events have come about every ${gap >= 36 ? `${Math.round(gap / 24)} days` : `${gap} hours`}.` : 'Aim for about one event a day.');
    return lines;
  };
  B.projectTask = ({ state, sc, cfg, TL }) => {
    const now = TL.now(state);
    const first = TL.fmt(sc, { day: Math.floor((now + 1) / 24), hour: (Math.floor(now) + 1) % 24 });
    const last = TL.fmt(sc, { day: Math.floor((now + cfg.days * 24) / 24), hour: Math.floor(now + cfg.days * 24) % 24 });
    // Never a hidden region (R-5; playtest-r7-tessk-workshop).
    const regions = (sc.regions || []).map((r) => r.id).filter((id) => Eng().regionKnown(state, id));
    return `
=== TASK ===
Plan what is most likely to happen in this world over the next ${cfg.days} days, between ${first} and ${last}: things everyone expects (a delivery, an exam, a holiday or festival, a meeting, a scheduled broadcast) or the likely next developments of the situation, spaced like the timeline above. Write 1 to ${cfg.max} events.
- Public things only: never anyone's secret.
- Nothing about ${state.characters[state.player].name}'s own choices, and nothing that decides how the story turns out.
- Modest and plausible: these happen only if the story hasn't changed things.
- "when" is {"day": number, "hour": 0-23}. "scope": "regional" (nearby) or "world" (far away, broad).${regions.length ? ` "region": one of ${regions.join(', ')}, or null for a world event.` : ''}
- "effects" only if the event clearly changes something: ${effectShape(state)}, with existing ids only (${effectIds(state)}); otherwise null.
Reply with JSON only:
{"events":[{"when":{"day":${Math.floor((now + 24) / 24)},"hour":9},"scope":"regional",${regions.length ? '"region":"region_id",' : ''}"text":"one sentence","visibility":"heard","effects":null}]}`;
  };

  // ---------- research (build time, tools/research.mjs) ----------
  // System: the world's generator header. User: the topic, the start, the
  // ids drafts may point at, one chunk of the source, the task.
  P.layouts.research = ['researchTopic', 'researchIds', 'researchSource', 'researchTask'];
  P.research = (ctx, topic, src, chunk, i, n, brief) => P.build(brief ? 'researchBrief' : 'research', { ctx, topic, src, chunk, i, n });
  // Brief research: the page's opening, summarised in one entry.
  P.layouts.researchBrief = ['researchTopic', 'researchIds', 'researchSource', 'researchBriefTask'];
  const asOfLine = (ctx) => `The story starts ${ctx.job.asOf ? `in ${ctx.job.asOf}` : 'at the start date of this world'}${ctx.job.calendar ? ` (${ctx.job.calendar.date})` : ''}.`;
  B.researchTopic = ({ ctx, topic }) => `=== RESEARCH: ${topic.name} ===\nFor this world, about ${topic.about}.\n${asOfLine(ctx)}`;
  // A big world (more than RESEARCH_REGIONS regions) lists only the regions
  // around a region topic: its own, the ones it's inside, what's near it and
  // inside it; for any other topic, the first of the top level. Refs are
  // still resolved against every region.
  P.RESEARCH_REGIONS = 40;
  const researchRegions = (ctx, topic) => {
    const all = ctx.refs.regions;
    if (all.length <= P.RESEARCH_REGIONS) return all;
    const S = E.Scenario, defs = ctx.loaded.bundle.world.regions || [];
    const at = topic.level === 'region' && topic.ref ? topic.ref : null;
    const keep = new Set(at ? [].concat(S.regionChainIn(defs, at), S.regionNearIn(defs, at, 12), S.regionChildrenIn(defs, at).slice(0, 12)) : []);
    const top = S.regionChildrenIn(defs, null);
    if (at) return all.filter((x) => keep.has(x.id));
    return all.filter((x) => top.includes(x.id)).slice(0, P.RESEARCH_REGIONS);
  };
  B.researchIds = ({ ctx, topic }) => {
    const r = ctx.refs;
    const list = (xs) => xs.map((x) => `${x.id} (${x.name})`).join(', ') || 'none';
    const regions = researchRegions(ctx, topic);
    const more = r.regions.length - regions.length;
    return `\n=== IN THIS WORLD ===\nregions: ${list(regions)}${more > 0 ? ` (and ${more} more)` : ''}\nplaces: ${list(r.rooms)}\npeople: ${list(r.characters)}\ngroups: ${list(r.groups)}`;
  };
  B.researchSource = ({ src, chunk, i, n }) => `\n=== SOURCE: ${src.title}${n > 1 ? ` (part ${i + 1} of ${n})` : ''} ===\n${chunk}`;
  B.researchTask = ({ ctx, topic }) => `
=== TASK ===
Turn what in the source matters for stories set in this world into lore: short notes the narrator can draw on.
- Keep to the broad picture: regions, major institutions, big groups, the era's defining events. Not every slice of life.
- Only what a storyteller here needs and might not know or get wrong: places, groups, people, customs, how things work here, recent or local events, how this world differs from the real one. Skip general knowledge any model knows (what an animal is, how a car works).
- Up to ${ctx.job.perTopic || 4} entries, each ONE topic in 40–80 words, written entirely in your own words: never copy sentences or phrases from the source.
- Everything as it stands when the story starts. Anything that happens after that goes in "later" (with "date" as YYYY-MM-DD if the source gives one, else null), never in an entry.
- Secrets (what some people hide from others) go in "secrets", never in an entry: entries are public knowledge.
- "about": world, region, location, character or topic; "ref": the id from IN THIS WORLD it is about (for region, location, character), else null.
- "keywords": the words a player would use for it, with nicknames, titles and other spellings.
- "topics": up to ${E.Lore.LIMITS.topics} of ${E.Lore.topicIds(ctx.loaded.bundle.world).join(', ')}: the kinds of life it matters most to (school for the schools, business for the companies), or [] when it matters to everyone.
Reply with JSON only:
{"entries":[{"title":"short title","about":"${topic.level}","ref":${topic.ref ? `"${topic.ref}"` : 'null'},"keywords":["name","alias"],"topics":[],"text":"40–80 words"}],
 "later":[{"date":null,"text":"one sentence","scope":"regional","region":null}],
 "secrets":[{"who":"person","text":"what they hide"}]}`;
  B.researchBriefTask = ({ ctx, topic }) => `
=== TASK ===
Summarise ${topic.name} as one lore note the narrator can draw on when a scene is set there.
- ONE entry of 40–80 words, written entirely in your own words: never copy sentences or phrases from the source.
- What a storyteller setting a scene there needs: what and where it is, how big, what it is known for, and what it is like to be there (the people and languages, the look of the place, how life runs).
- Everything as it stands when the story starts. Anything that happens after that goes in "later" (with "date" as YYYY-MM-DD if the source gives one, else null), never in the entry.
- Secrets (what some people hide from others) go in "secrets", never in the entry: entries are public knowledge.
- "keywords": the names a player would use for it, with other spellings and nicknames.
- "topics": up to ${E.Lore.LIMITS.topics} of ${E.Lore.topicIds(ctx.loaded.bundle.world).join(', ')}, or [] when it matters to everyone (usual for a place).
Reply with JSON only:
{"entries":[{"title":${JSON.stringify(topic.name)},"about":"${topic.level}","ref":${topic.ref ? `"${topic.ref}"` : 'null'},"keywords":[${JSON.stringify(topic.name)}],"topics":[],"text":"40–80 words"}],
 "later":[],
 "secrets":[]}`;
  P.layouts.researchKnown = ['researchTopic', 'researchKnownTask'];
  P.researchKnown = (ctx, topic) => P.build('researchKnown', { ctx, topic });
  B.researchKnownTask = ({ topic }) => `\n=== TASK ===\nIn two or three sentences, say what you know about ${topic.name}: names, places, dates. If you don't know it, say "I don't know." Plain text, no lists.`;

  P.layouts.chapter = ['chapterEvents', 'chapterTask'];
  P.chapter = (state) => P.build('chapter', { state, pc: state.characters[state.player] });

  B.chapterEvents = ({ state }) => {
    const facts = E.Memory.chapterFacts(state).map((f) => `- [T${f.turn}] ${f.text}`).join('\n') || '- (quiet stretch, little of note)';
    return `=== CHAPTER ${state.chapter} (turns ${state.chapterStartTurn}–${state.turn}) — EVENTS ===
${facts}`;
  };
  B.chapterTask = ({ pc }) => `
=== TASK ===
Write a short journal entry summarizing this chapter for ${pc.name}'s story. Use only the events listed. Third person, past tense, 2 to 4 sentences, keep names and the most important consequences. Also give the chapter a short evocative title.
Reply with JSON only: {"title":"...","summary":"..."}`;
})(typeof window !== 'undefined' ? window : globalThis);
