// The canon timeline (task 5-2): dated events that happen whatever the player
// does, unless the story has broken them. Past events (before the start)
// become facts and a "chapter zero" at New game. Future events are checked by
// the engine when due: they happen as written, are dropped, or (onBroken
// "diverge") the model writes the altered version. When nothing is planned for
// the next few days, the model projects a few likely events (rule 1: the
// engine checks them like authored ones), so the world keeps its pacing.
// Future events never reach a prompt before they are due.
(function (root) {
  const E = root.Ensemble;
  const TL = (E.Timeline = {});
  const Eng = () => E.Engine;

  TL.SCOPES = ['regional', 'world'];
  TL.VISIBILITY = ['seen', 'heard', 'hidden'];
  TL.ON_BROKEN = ['drop', 'diverge'];
  TL.PRE_KEYS = ['alive', 'controls', 'clock', 'world', 'feature', 'known', 'reputation', 'role', 'reached', 'built', 'not'];
  TL.PROJECT = { days: 3, max: 3 };
  TL.TEXT_MAX = 240;
  // Hours between projection attempts, so an empty or failed one isn't
  // retried every turn.
  TL.RETRY_HOURS = 6;

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const nm = (state, id) => (state.characters[id] ? state.characters[id].name : id);
  // An event on a date, or one that happens on arrival (task 7-7: {"reach":
  // region id}, the first time the player reaches that region): it has no
  // time until it happens, so it sorts last and never stops a skip by date.
  TL.arrival = (ev) => !!(ev && isObj(ev.when) && typeof ev.when.reach === 'string');
  TL.at = (when) => (isObj(when) && Number.isFinite(when.day) ? when.day * 24 + when.hour : Infinity);
  TL.now = (state) => state.time.day * 24 + state.time.hour;
  TL.fmt = (sc, when) => (isObj(when) && typeof when.reach === 'string'
    ? `on reaching ${((sc.regions || []).find((r) => r.id === when.reach) || {}).name || when.reach}`
    : `${E.dayName(sc, when.day)}, ${String(when.hour).padStart(2, '0')}:00`);

  // Projection settings, or null when the world turns it off.
  TL.config = (sc) => (sc.projectTimeline === false ? null : Object.assign({}, TL.PROJECT, isObj(sc.projectTimeline) ? sc.projectTimeline : {}));

  // Every event: the scenario's canon, then the ones projected in play.
  // Drafts ("draft": true, from the research helper) wait for review in the
  // creator and never happen.
  TL.all = (state) => (Array.isArray(state.scenario.timeline) ? state.scenario.timeline.filter((ev) => isObj(ev) && ev.draft !== true) : []).concat(state.timeline || []);
  const byTime = (a, b) => TL.at(a.when) - TL.at(b.when);
  // Not yet happened, dropped or seeded as the past; soonest first.
  TL.pending = (state) => TL.all(state).filter((ev) => !(state.canon || {})[ev.id]).sort(byTime);

  // ---------- preconditions ----------
  // Engine-checked, never judged by the model. Each is one object with one of
  // TL.PRE_KEYS; an event's preconditions must all hold.
  const PRE = {
    alive: {
      holds: (s, p) => Eng().alive(s, p.alive),
      say: (s, p) => `${nm(s, p.alive)} is alive`,
    },
    controls: {
      holds: (s, p) => { const r = (s.regions || {})[p.controls.region]; return !!r && r.controller === (p.controls.group ?? null); },
      say: (s, p) => {
        const f = (s.factions || []).find((x) => x.id === p.controls.group);
        const r = Eng().regionDef(s, p.controls.region);
        return `${p.controls.group == null ? 'no one' : f ? f.name : p.controls.group} holds ${r ? r.name : p.controls.region}`;
      },
    },
    clock: {
      holds: (s, p) => { const c = s.clocks.find((x) => x.id === p.clock); return !!c && (c.fired || c.value >= p.atLeast); },
      say: (s, p) => { const c = s.clocks.find((x) => x.id === p.clock); return `${c ? c.name : p.clock} is at ${p.atLeast} or more`; },
    },
    world: {
      holds: (s, p) => s.world[p.world] === p.is,
      say: (s, p) => `${p.world} is "${p.is}"`,
    },
    // A tracked feature's state (task 7-3): {"feature": "room|name", "is": "shut down"}.
    feature: {
      holds: (s, p) => !Eng().narratedFeature(s, p.feature) && String((s.features || {})[p.feature] ?? '').toLowerCase() === String(p.is).toLowerCase(),
      say: (s, p) => {
        const i = p.feature.indexOf('|'), room = s.locations && s.locations[p.feature.slice(0, i)];
        return `the ${p.feature.slice(i + 1)} in ${room ? room.name : p.feature.slice(0, i)} is "${p.is}"`;
      },
    },
    // A fact someone knows (default: the player): the one a canon event made
    // (by event id), or one that has all the words.
    known: {
      holds: (s, p) => {
        const by = p.by || s.player;
        // Narrated details never drive rules (task B-0b).
        const facts = s.facts.filter((f) => E.Memory.knows(f, by) && !E.Memory.narrated(f));
        if (typeof p.known === 'string') return facts.some((f) => f.canon === p.known);
        return facts.some((f) => p.known.words.every((w) => E.Lore.matches(w, f.text)));
      },
      say: (s, p) => `${p.by ? nm(s, p.by) : 'the player'} knows ${typeof p.known === 'string' ? `about "${p.known}"` : `something about ${p.known.words.join(' + ')}`}`,
    },
    // Standing (task G-6): {"reputation": {group, atLeast}} or {group, below};
    // {"role": {group, is}} (member, favored, leader, or none).
    // Where the player has been (task 7-7): {"reached": region id}, the region
    // or anywhere inside it, at any time since the start.
    reached: {
      holds: (s, p) => Eng().hasReached(s, p.reached),
      say: (s, p) => `the player has reached ${(Eng().regionDef(s, p.reached) || {}).name || p.reached}`,
    },
    // Lots built on in a place (task 7-7): {"built": {place, atLeast}}.
    built: {
      holds: (s, p) => Eng().builtLots(s, p.built.place) >= p.built.atLeast,
      say: (s, p) => `${p.built.atLeast} or more lots are built on in ${(((s.scenario.siteInfo || {})[p.built.place]) || {}).name || p.built.place}`,
    },
    reputation: {
      holds: (s, p) => { const v = E.Standing.value(s, p.reputation.group); return p.reputation.atLeast != null ? v >= p.reputation.atLeast : v < p.reputation.below; },
      say: (s, p) => `standing with ${E.Standing.groupName(s, p.reputation.group)} is ${p.reputation.atLeast != null ? `${p.reputation.atLeast} or more` : `below ${p.reputation.below}`}`,
    },
    role: {
      holds: (s, p) => (E.Standing.roleOf(s, p.role.group) || 'none') === p.role.is,
      say: (s, p) => (p.role.is === 'none' ? `the player isn't in ${E.Standing.groupName(s, p.role.group)}` : `the player is ${p.role.is === 'member' ? 'a member' : p.role.is === 'leader' ? 'the leader' : 'favored'} in ${E.Standing.groupName(s, p.role.group)}`),
    },
    not: {
      holds: (s, p) => !TL.holds(s, p.not),
      say: (s, p) => `not: ${TL.say(s, p.not)}`,
    },
  };
  const preKey = (p) => (isObj(p) ? TL.PRE_KEYS.find((k) => k in p) : null);
  TL.holds = (state, p) => { const k = preKey(p); return !!k && PRE[k].holds(state, p); };
  TL.say = (state, p) => { const k = preKey(p); return k ? PRE[k].say(state, p) : '?'; };
  // [{ text, ok }] for each precondition (Debug).
  TL.status = (state, ev) => (ev.preconditions || []).map((p) => ({ text: TL.say(state, p), ok: TL.holds(state, p) }));
  // The ones that don't hold, in words.
  TL.broken = (state, ev) => TL.status(state, ev).filter((x) => !x.ok).map((x) => x.text);

  // Pending events due within `hours`, with what broke: [{ ev, broken }].
  // Checked once, against the state at the start of the turn.
  // Arrival events are due once the player has reached their region.
  TL.due = (state, hours) => {
    const until = TL.now(state) + hours;
    return TL.pending(state).filter((ev) => (TL.arrival(ev) ? Eng().hasReached(state, ev.when.reach) : TL.at(ev.when) <= until)).map((ev) => ({ ev, broken: TL.broken(state, ev) }));
  };
  // The first arrival event a trip comes to on the way (a stage of the
  // trail): the leg it ends and the hours to there, or null.
  TL.stageOnTrip = function (state, legs) {
    const waiting = TL.pending(state).filter(TL.arrival);
    if (!waiting.length) return null;
    let hours = 0;
    for (let i = 0; i < (legs || []).length; i++) {
      hours += legs[i].hours;
      const chain = E.Scenario.regionChainIn(state.scenario.regions, legs[i].to);
      const ev = waiting.find((x) => chain.includes(x.when.reach));
      if (ev) return { ev, leg: i, hours, region: legs[i].to };
    }
    return null;
  };
  // Due events whose preconditions broke and that the model rewrites.
  TL.diverging = (due) => (due || []).filter((d) => d.broken.length && d.ev.onBroken === 'diverge');

  // ---------- happening ----------
  const guard = (res, type, detail) => Eng().guard(res, 'resolve', type, detail);
  const cleanText = (t) => E.shorten(String(t || '').replace(/\s+/g, ' ').trim(), TL.TEXT_MAX);
  const peopleWithSecrets = (state) => Object.values(state.characters).filter((c) => c.secret);

  // One event happens: effects (not for hidden ones), a fact, news, and a line
  // for the narrator. how: fired | diverged.
  TL.happen = function (state, ev, version, res, how) {
    const scope = TL.SCOPES.includes(ev.scope) ? ev.scope : 'world';
    const vis = TL.VISIBILITY.includes(ev.visibility) ? ev.visibility : 'heard';
    const text = cleanText(version.text);
    // Its people who were waiting come into the story first (task 7-2).
    Eng().joinStory(state, ev.id, res);
    const who = (ev.who || []).filter((id) => state.characters[id] && id !== state.player);
    // As written, its "moves" send people where it says (the third-years off to
    // Tokyo at graduation), wherever they are: the author's word, no route.
    const moved = [];
    if (how === 'fired') (Array.isArray(ev.moves) ? ev.moves : []).forEach((m) => {
      const c = m && state.characters[m.id];
      if (!c || m.id === state.player || !Eng().alive(state, m.id) || !state.locations[m.to] || Eng().isAt(state, m.id, m.to)) return;
      Eng().storyMove(state, m.id, m.to);
      moved.push(`${c.name} → ${state.locations[m.to].name}`);
      guard(res, 'canon moved', `${c.name} → ${state.locations[m.to].name} (${ev.id})`);
    });
    const region = ev.region || (scope === 'regional' ? Eng().playerRegion(state) : null);
    // As written, an authored event's effects aren't rationed (projected events and
    // the model's diverged versions are).
    const effects = vis !== 'hidden' ? Eng().applyEffects(state, version.effects, scope, res, { lasting: true, authored: how === 'fired' && !ev.projected }) : [];
    let fact = null;
    if (vis === 'hidden') {
      if (who.length) fact = E.Memory.addFact(state, { about: who, text, known_by: who, weight: 2 });
    } else {
      fact = E.Memory.addFact(state, { about: who, text, known_by: ['all'], weight: 3, where: region });
      res.events.push((vis === 'heard' ? '(heard from elsewhere; only a sound, call or message reaches the player) ' : '') + `[${scope}] ${text}`);
      state.news = state.news || [];
      state.news.push({ scope, text, time: E.fmtTime(state), effects, region });
      if (state.news.length > 12) state.news.shift();
      if (scope === 'world') state.flags.chapterWorthy = true;
    }
    if (fact) fact.canon = ev.id;
    (res.director = res.director || []).push({ scope, text, visibility: vis, who, where: null, region, moved, effects, canon: ev.id });
    state.canon[ev.id] = { status: how, turn: state.turn, time: E.fmtTime(state), at: TL.now(state), text };
    return text;
  };

  // The due events of a turn: as written when their preconditions hold;
  // otherwise dropped, or the model's altered version (replies: the intent's
  // "canon" list, [{id, text, effects}]). Returns the texts that happened.
  TL.resolveDue = function (state, due, replies, res) {
    const list = Array.isArray(replies) ? replies.filter(isObj) : [];
    const diverging = TL.diverging(due).map((d) => d.ev.id);
    list.filter((r) => !diverging.includes(r.id)).forEach((r) => guard(res, 'canon rejected', `"${r.id}" is not an event being rewritten now`));
    const done = [];
    (due || []).forEach(({ ev, broken }) => {
      if (!broken.length) {
        done.push(TL.happen(state, ev, ev, res, 'fired'));
        return guard(res, 'canon fired', `${ev.id}${ev.projected ? ' (projected)' : ''}: ${ev.text}`);
      }
      const drop = (type, why) => {
        state.canon[ev.id] = { status: 'dropped', turn: state.turn, time: E.fmtTime(state), why };
        guard(res, type, `${ev.id}: ${why}`);
      };
      if (ev.onBroken !== 'diverge') return drop('canon dropped', broken.join('; '));
      const r = list.find((x) => x.id === ev.id);
      const text = r && cleanText(r.text);
      if (!text) return drop('canon diverge missing', `the model wrote no altered version (${broken.join('; ')})`);
      const leak = E.Lore.leak({ text }, peopleWithSecrets(state));
      if (leak) return drop('canon diverge missing', `the altered version gave away ${leak.name}'s secret: ${text}`);
      done.push(TL.happen(state, ev, { text, effects: r.effects }, res, 'diverged'));
      guard(res, 'canon diverged', `${ev.id} (${broken.join('; ')}): ${text}`);
    });
    return done;
  };

  // ---------- New game ----------
  // Events before the start: public ones become facts and the chapter-zero
  // summary (those facts stay out of the header's facts block, since the
  // summary already says them); hidden ones become private facts for "who".
  // Their effects are never applied: the world is authored as of the start.
  TL.seed = function (state) {
    state.canon = {};
    state.timeline = [];
    state.projection = true;
    const start = TL.now(state);
    const sc = state.scenario;
    const past = TL.all(state).filter((ev) => !TL.arrival(ev) && TL.at(ev.when) < start).sort(byTime);
    const lines = [];
    past.forEach((ev) => {
      state.canon[ev.id] = { status: 'past' };
      const who = (ev.who || []).filter((id) => state.characters[id]);
      if (ev.visibility === 'hidden') {
        if (!who.length) return;
        const f = E.Memory.addFact(state, { about: who, text: ev.text, known_by: who, weight: 2 });
        Object.assign(f, { canon: ev.id, chapter: 0, turn: 0 });
        return;
      }
      const f = E.Memory.addFact(state, { about: who, text: ev.text, known_by: ['all'], weight: 2 });
      Object.assign(f, { canon: ev.id, chapter: 0, turn: 0, inSummary: true });
      lines.push(`${E.dayName(sc, ev.when.day)}: ${ev.text}`);
    });
    if (lines.length) state.chapters.unshift({ n: 0, title: 'Before the story', summary: lines.join(' '), fromTurn: 0, toTurn: 0, reason: 'canon' });
  };

  // ---------- the downtime skip ----------
  // The next pending event, in hours from now (at least 1).
  // Only world events and those near the player stop a skip or a journey
  // (task 7-7: weeks on the trail were cut short by a riot in Memphis);
  // regional news from far away happens at the next turn, heard late.
  TL.next = function (state) {
    const here = Eng().playerRegion(state);
    const near = new Set(here ? E.Scenario.regionChainIn(state.scenario.regions, here).concat(Eng().regionNear(state, here)) : []);
    const ev = TL.pending(state).filter((x) => !TL.arrival(x) && (x.scope === 'world' || !x.region || !here || near.has(x.region)))[0];
    return ev ? { hours: Math.max(1, TL.at(ev.when) - TL.now(state)), id: ev.id } : null;
  };

  // ---------- projection ----------
  TL.needsProjection = function (state) {
    const cfg = TL.config(state.scenario);
    if (!cfg || !state.projection) return false;
    const now = TL.now(state);
    if (state.projectTried != null && now - state.projectTried < TL.RETRY_HOURS) return false;
    return !TL.pending(state).some((ev) => !TL.arrival(ev) && TL.at(ev.when) <= now + cfg.days * 24);
  };

  // Resolved events, newest last, for the projection prompt's pacing.
  TL.history = (state) => TL.all(state).filter((ev) => {
    const st = (state.canon || {})[ev.id];
    return st && st.status !== 'dropped' && ev.visibility !== 'hidden';
  }).map((ev) => {
    // An arrival event's time is when it happened.
    const at = TL.arrival(ev) ? state.canon[ev.id].at : null;
    return { when: at != null ? { day: Math.floor(at / 24), hour: at % 24 } : ev.when, text: (state.canon[ev.id] && state.canon[ev.id].text) || ev.text };
  }).filter((x) => Number.isFinite(TL.at(x.when))).sort(byTime);
  // The usual gap between events, in hours (null with fewer than two).
  TL.gap = function (state) {
    const times = TL.all(state).map((ev) => TL.at(ev.when)).filter(Number.isFinite).sort((a, b) => a - b);
    if (times.length < 2) return null;
    return Math.round((times[times.length - 1] - times[0]) / (times.length - 1));
  };

  // Checks a projection reply → { events, rejected: [why] }.
  TL.checkProjected = function (state, raw, cfg) {
    const out = { events: [], rejected: [] };
    const list = isObj(raw) && Array.isArray(raw.events) ? raw.events : [];
    const now = TL.now(state);
    const until = now + cfg.days * 24;
    const regionIds = (state.scenario.regions || []).map((r) => r.id);
    const dead = Object.values(state.characters).filter((c) => c.status.health === 'dead');
    const taken = new Set(TL.all(state).map((ev) => ev.id));
    const pendingWords = TL.pending(state).map((ev) => Eng().contentWords(ev.text));
    list.slice(0, cfg.max).forEach((r, i) => {
      if (!isObj(r)) return;
      const text = cleanText(r.text);
      const no = (why) => out.rejected.push(`${why}${text ? `: ${text}` : ''}`);
      if (!text) return no('no text');
      const w = r.when;
      if (!isObj(w) || !Number.isInteger(w.day) || !Number.isInteger(w.hour) || w.hour < 0 || w.hour > 23) return no('no valid "when" {day, hour}');
      const at = TL.at(w);
      if (at <= now || at > until) return no(`dated outside the next ${cfg.days} days`);
      const scope = TL.SCOPES.includes(r.scope) ? r.scope : 'regional';
      let region = r.region == null || r.region === '' ? null : r.region;
      if (region != null && !regionIds.includes(region)) return no(`unknown region "${region}"`);
      if (scope === 'regional' && region == null && regionIds.length) region = Eng().playerRegion(state);
      const leak = E.Lore.leak({ text }, peopleWithSecrets(state));
      if (leak) return no(`gives away ${leak.name}'s secret`);
      const low = text.toLowerCase();
      const ghost = dead.find((c) => low.includes(String(c.name).toLowerCase()) || String(c.name).toLowerCase().split(/\s+/).filter((p) => p.length > 3).some((p) => E.Lore.matches(p, text)));
      if (ghost) return no(`names ${ghost.name}, who is dead`);
      const words = Eng().contentWords(text);
      if (pendingWords.some((pw) => [...words].filter((x) => pw.has(x)).length >= Math.max(3, Math.ceil(words.size * 0.75)))) return no('repeats an event already planned');
      let effects = isObj(r.effects) ? r.effects : null;
      if (effects && Object.keys(effects).some((k) => !Eng().EFFECTS[k])) { out.rejected.push(`unknown effects dropped: ${text}`); effects = null; }
      let id = `projected-${state.turn}-${i + 1}`;
      while (taken.has(id)) id += 'b';
      taken.add(id);
      const vis = TL.VISIBILITY.includes(r.visibility) && r.visibility !== 'hidden' ? r.visibility : 'heard';
      out.events.push({ id, when: { day: w.day, hour: w.hour }, scope, region, text, visibility: vis, effects, projected: true, planned: state.turn });
    });
    return out;
  };

  // One call: the next few days' likely events. notes: [{type, detail}] for
  // Debug. Never throws; a failed call waits TL.RETRY_HOURS.
  TL.project = async function (state, notes) {
    const cfg = TL.config(state.scenario);
    state.projectTried = TL.now(state);
    let raw;
    try {
      raw = await E.LLM.chatJSON({ kind: 'worldbuild (timeline)', system: E.Prompts.header(state), user: E.Prompts.project(state, cfg), maxTokens: 160 + 120 * cfg.max, temperature: 0.8 });
    } catch (err) {
      notes.push({ type: 'timeline failed', detail: err.message });
      return [];
    }
    const out = TL.checkProjected(state, raw, cfg);
    out.rejected.forEach((why) => notes.push({ type: 'timeline rejected', detail: why }));
    out.events.forEach((ev) => notes.push({ type: 'timeline planned', detail: `${TL.fmt(state.scenario, ev.when)}: ${ev.text}` }));
    state.timeline = (state.timeline || []).concat(out.events);
    return out.events;
  };

  // ---------- validation ----------
  // Shape and refs of a timeline list. refs: { regions, characters, groups,
  // clocks } as Sets (clocks: unknown ones are warnings, since a follow-up
  // clock exists only once its parent fires), start: the start time in hours
  // (events before it are the past), effectKeys.
  TL.problems = function (list, where, refs, warnings) {
    const problems = [];
    if (list == null) return problems;
    if (!Array.isArray(list)) return [`${where}: "timeline" must be a list of events`];
    const seen = new Set();
    list.forEach((ev) => {
      if (!isObj(ev)) return problems.push(`${where}: each timeline event must be {id, when, scope, text}`);
      const at = `${where}: timeline "${ev.id || '?'}"`;
      const req = (cond, msg) => { if (!cond) problems.push(`${at}: ${msg}`); };
      req(typeof ev.id === 'string' && /^([a-z0-9][a-z0-9_-]*:)?[a-z0-9][a-z0-9_-]*$/.test(ev.id), '"id" must be lowercase letters, digits, - or _');
      if (seen.has(ev.id)) problems.push(`${at} is listed twice`);
      seen.add(ev.id);
      const w = ev.when;
      const okWhen = isObj(w) && Number.isInteger(w.day) && w.day >= 0 && Number.isInteger(w.hour) && w.hour >= 0 && w.hour <= 23;
      if (TL.arrival(ev)) {
        req(Object.keys(w).length === 1, '"when" must be {day, hour} or {"reach": region id}, not both');
        if (refs.regions) req(refs.regions.has(w.reach), `"when": no region "${w.reach}" to reach`);
        req(!ev.projected, 'a projected event cannot wait for an arrival');
      } else req(okWhen, '"when" must be {day, hour} with whole numbers (hour 0–23), or {"reach": region id}');
      req(TL.SCOPES.includes(ev.scope), '"scope" must be regional or world');
      req(typeof ev.text === 'string' && ev.text.trim() && ev.text.length <= TL.TEXT_MAX, `"text" must be text of at most ${TL.TEXT_MAX} characters`);
      req(ev.visibility == null || TL.VISIBILITY.includes(ev.visibility), '"visibility" must be seen, heard or hidden');
      req(ev.onBroken == null || TL.ON_BROKEN.includes(ev.onBroken), '"onBroken" must be drop or diverge');
      req(ev.draft == null || typeof ev.draft === 'boolean', '"draft" must be true or false');
      if (ev.scope === 'regional' && refs.regions && refs.regions.size) req(typeof ev.region === 'string', 'a regional event needs a "region"');
      if (ev.region != null && refs.regions) req(refs.regions.has(ev.region), `unknown region "${ev.region}"`);
      req(ev.who == null || (Array.isArray(ev.who) && ev.who.every((id) => !refs.characters || refs.characters.has(id))), '"who" must be a list of character ids');
      req(ev.moves == null || (Array.isArray(ev.moves) && ev.moves.every((m) => isObj(m) && (!refs.characters || refs.characters.has(m.id)))), '"moves" must be a list of {id, to} with character ids');
      if (ev.effects != null) {
        if (!isObj(ev.effects)) problems.push(`${at}: "effects" must be an object`);
        else Object.keys(ev.effects).filter((k) => !refs.effectKeys.includes(k)).forEach((k) => problems.push(`${at}: unknown effect "${k}"`));
      }
      req(ev.preconditions == null || Array.isArray(ev.preconditions), '"preconditions" must be a list');
      req(ev.ending == null || ev.ending === true || isObj(ev.ending), '"ending" must be true, or {title, kind, epilogue, if}: the story ends when it happens');
      (Array.isArray(ev.preconditions) ? ev.preconditions : []).forEach((p) => preProblems(p, at, refs, problems, warnings));
      if (okWhen && refs.start != null && TL.at(w) < refs.start) {
        ['effects', 'moves', 'preconditions', 'onBroken'].filter((k) => ev[k] != null).forEach((k) =>
          warnings.push(`${at}: "${k}" is ignored on an event before the start (the world is written as it is at the start)`));
      }
    });
    return problems;
  };
  // One condition in this grammar, checked on its own (R-2: a route's
  // "requires"). → problems; warnings go to the list given, if any.
  TL.preconditionProblems = function (p, at, refs, warnings) {
    const problems = [];
    preProblems(p, at, refs || {}, problems, warnings || []);
    return problems;
  };
  function preProblems(p, at, refs, problems, warnings) {
    const k = preKey(p);
    const no = (msg) => problems.push(`${at}: precondition ${msg}`);
    if (!k) return no(`must be one of {${TL.PRE_KEYS.join('|')}: …}`);
    if (k === 'alive' && !(typeof p.alive === 'string' && (!refs.characters || refs.characters.has(p.alive)))) no(`"alive": unknown character "${p.alive}"`);
    if (k === 'controls') {
      const c = p.controls;
      if (!isObj(c) || typeof c.region !== 'string') return no('"controls" must be {group, region}');
      if (refs.regions && !refs.regions.has(c.region)) no(`"controls": unknown region "${c.region}"`);
      if (c.group != null && refs.groups && !refs.groups.has(c.group)) no(`"controls": unknown group "${c.group}"`);
    }
    if (k === 'clock') {
      if (typeof p.clock !== 'string' || typeof p.atLeast !== 'number') return no('"clock" needs a clock id and "atLeast" (a number)');
      if (refs.clocks && !refs.clocks.has(p.clock)) warnings.push(`${at}: precondition clock "${p.clock}" is not a clock of the world or any start (fine for a follow-up clock; otherwise it never holds)`);
    }
    if (k === 'world' && !(typeof p.world === 'string' && typeof p.is === 'string')) no('"world" needs a world key and "is" (text)');
    if (k === 'feature') {
      if (!(typeof p.feature === 'string' && p.feature.indexOf('|') > 0 && typeof p.is === 'string')) return no('"feature" needs "room|name" and "is" (text)');
      if (refs.features && !refs.features.has(p.feature)) no(`"feature": no tracked feature "${p.feature}" (a room's {name, state})`);
      else if (refs.featureStates && refs.featureStates[p.feature] && !refs.featureStates[p.feature].includes(p.is.toLowerCase())) no(`"feature": "${p.feature}" can't be "${p.is}" (its states: ${refs.featureStates[p.feature].join(', ')})`);
    }
    if (k === 'known') {
      const ok = typeof p.known === 'string' || (isObj(p.known) && Array.isArray(p.known.words) && p.known.words.length && p.known.words.every((x) => typeof x === 'string' && x.trim()));
      if (!ok) no('"known" must be an event id or {words: [...]}');
      if (p.by != null && !(typeof p.by === 'string' && (!refs.characters || refs.characters.has(p.by)))) no(`"known": unknown character "${p.by}" in "by"`);
    }
    if (k === 'reputation') {
      const r = p.reputation;
      if (!isObj(r) || typeof r.group !== 'string' || (typeof r.atLeast !== 'number' && typeof r.below !== 'number')) return no('"reputation" must be {group, atLeast} or {group, below}');
      if (refs.groups && !refs.groups.has(r.group)) no(`"reputation": unknown group "${r.group}"`);
    }
    if (k === 'role') {
      const r = p.role;
      if (!isObj(r) || typeof r.group !== 'string' || !E.Standing.ROLES.concat('none').includes(r.is)) return no(`"role" must be {group, is: ${E.Standing.ROLES.join('|')}|none}`);
      if (refs.groups && !refs.groups.has(r.group)) no(`"role": unknown group "${r.group}"`);
    }
    if (k === 'reached' && !(typeof p.reached === 'string' && (!refs.regions || refs.regions.has(p.reached)))) no(`"reached": unknown region "${p.reached}"`);
    if (k === 'built') {
      const b = p.built;
      if (!isObj(b) || typeof b.place !== 'string' || !Number.isInteger(b.atLeast) || b.atLeast < 1) return no('"built" must be {place, atLeast} (a whole number from 1)');
      if (refs.places && !refs.places.has(b.place)) no(`"built": no place "${b.place}" (a room's "site")`);
    }
    if (k === 'not') preProblems(p.not, at, refs, problems, warnings);
  }
})(typeof window !== 'undefined' ? window : globalThis);
