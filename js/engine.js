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
    const state = {
      version: 1,
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
    };
    (sc.locations || []).forEach((l) => (state.locations[l.id] = Object.assign({ connects: [] }, l)));
    sc.characterData.forEach((raw) => {
      const c = E.clone(raw);
      c.needs = c.needs || {};
      sc.needs.forEach((n) => { if (c.needs[n.id] == null) c.needs[n.id] = 0.2; });
      c.status = Object.assign({ health: 'ok', conditions: [] }, c.status || {});
      c.relations = c.relations || {};
      c.skills = c.skills || {};
      state.characters[c.id] = c;
    });
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

  // Every time the engine overrules or cleans up the model, it records it in
  // the turn's res.guards, so Debug can list what fired. stage: resolve |
  // scene | memory (Reroll replaces the scene ones).
  const guard = (res, stage, type, detail) => {
    if (!res) return;
    (res.guards = res.guards || []).push({ stage, type, detail: String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  };

  Eng.alive = (state, id) => state.characters[id] && state.characters[id].status.health !== 'dead';
  Eng.present = (state) => {
    const here = state.characters[state.player].status.location;
    return state.order.filter((id) => id !== state.player && Eng.alive(state, id) && state.characters[id].status.location === here);
  };

  // ---------- resolution ----------
  function skillPenalty(c) {
    let p = 0;
    if (c.status.health === 'hurt') p -= 2;
    if (c.status.health === 'badly_hurt') p -= 4;
    if ((c.needs.fatigue || 0) >= 0.85) p -= 2;
    return p;
  }

  Eng.roll = function (c, skill, difficulty) {
    const d = 1 + Math.floor(E.rng() * 20);
    const dc = DC[difficulty] || DC.normal;
    const total = d + (Number(c.skills[skill]) || 0) * 2 + skillPenalty(c);
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
    const stress = Math.max(c.needs.stress || 0, c.needs.fear || 0);
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
    const rates = Object.assign({ regional: 18, world: 96 }, state.scenario.eventRates || {});
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

  // Concrete consequences of bigger events: world status, group stance,
  // pressure clocks, and occasionally a new pressure.
  function applyEffects(state, eff, scope) {
    const done = [];
    if (!eff || typeof eff !== 'object') return done;
    (Array.isArray(eff.world) ? eff.world : []).slice(0, 3).forEach((w) => {
      if (w && w.key in state.world && w.value) { state.world[w.key] = String(w.value).slice(0, 120); done.push(`${w.key}: ${state.world[w.key]}`); }
    });
    (Array.isArray(eff.groups) ? eff.groups : []).slice(0, 2).forEach((g) => {
      const f = g && (state.factions || []).find((x) => x.id === g.id);
      if (f && g.stance) { f.stance = String(g.stance).slice(0, 140); done.push(`${f.name}: ${f.stance}`); }
    });
    (Array.isArray(eff.clocks) ? eff.clocks : []).slice(0, 2).forEach((c) => {
      const cl = c && state.clocks.find((x) => x.id === c.id);
      if (!cl || cl.fired) return;
      const d = E.clamp(Number(c.delta) || 0, -cl.max / 2, cl.max / 2);
      if (!d) return;
      cl.value = E.clamp(cl.value + d, 0, cl.max);
      done.push(`${cl.name} ${d > 0 ? '+' : ''}${d}`);
    });
    const nc = eff.new_clock;
    if (nc && nc.name && state.clocks.filter((c) => !c.fired).length < 5) {
      const id = String(nc.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'pressure';
      if (!state.clocks.find((c) => c.id === id)) {
        state.clocks.push({
          id, name: String(nc.name).slice(0, 40), value: 0,
          max: E.clamp(Math.round(Number(nc.max) || 8), 4, 12),
          perHour: E.clamp(Number(nc.perHour) || 0.2, 0.05, 1),
          fireText: String(nc.fireText || `${nc.name} comes to a head.`).slice(0, 220), fired: false, from: scope,
        });
        done.push(`new pressure: ${nc.name}`);
      }
    }
    return done;
  }

  Eng.applyEvents = (...a) => applyEvents(...a);
  function applyEvents(state, intentObj, present, stepId, res, due, capsOverride) {
    due = due || {};
    const here = state.characters[state.player].status.location;
    const raw = Array.isArray(intentObj.events) ? intentObj.events : [];
    const caps = capsOverride || { local: EVENT_CAP[stepId] ?? 1, regional: due.regional ? 1 : 0, world: due.world ? 1 : 0 };
    const used = { local: 0, regional: 0, world: 0 };
    res.director = [];
    state.news = state.news || [];
    state.tierLast = state.tierLast || {};
    raw.forEach((ev) => {
      if (!ev || typeof ev.text !== 'string' || !ev.text.trim() || /^one sentence$/i.test(ev.text.trim())) return;
      const scope = ['regional', 'world'].includes(ev.scope) ? ev.scope : 'local';
      if (used[scope] >= caps[scope]) return guard(res, 'resolve', 'event dropped', `${scope} event not due or over the cap: ${ev.text}`);
      used[scope]++;
      const text = ev.text.trim().slice(0, 220);
      const who = (Array.isArray(ev.who) ? ev.who : []).filter((id) => state.characters[id] && id !== state.player);
      const where = Eng.resolveLocation(state, ev.where, false) || (scope === 'local' && who[0] ? state.characters[who[0]].status.location : null);
      let vis = ['seen', 'heard', 'hidden'].includes(ev.visibility) ? ev.visibility : 'heard';
      if (vis === 'seen' && where !== here) vis = 'heard';
      const moved = [];
      (Array.isArray(ev.moves) ? ev.moves : []).forEach((m) => {
        if (!m || !state.characters[m.id] || m.id === state.player || present.includes(m.id)) return;
        const to = Eng.resolveLocation(state, m.to, false);
        if (!to || !Eng.alive(state, m.id)) return;
        state.characters[m.id].status.location = to;
        moved.push(`${state.characters[m.id].name} → ${state.locations[to].name}`);
      });
      // Hidden big events stay hidden: no public status changes, only private knowledge.
      const effects = scope !== 'local' && vis !== 'hidden' ? applyEffects(state, ev.effects, scope) : [];
      if (scope !== 'local') state.tierLast[scope] = absHours(state);
      const tag = scope === 'local' ? '' : `[${scope}] `;
      if (vis === 'hidden') {
        if (who.length) E.Memory.addFact(state, { about: who, text, known_by: who, weight: 2 });
      } else {
        res.events.push((vis === 'heard' ? '(heard from elsewhere; only a sound, call or message reaches the player) ' : '') + tag + text);
        if (scope !== 'local') {
          E.Memory.addFact(state, { about: who, text, known_by: ['all'], weight: scope === 'world' ? 3 : 2 });
          state.news.push({ scope, text, time: E.fmtTime(state), effects });
          if (state.news.length > 12) state.news.shift();
        }
      }
      res.director.push({ scope, text, visibility: vis, who, where, moved, effects });
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
    // If the player's action is about someone already in the room, they don't go anywhere.
    const p = list[0];
    if (p.moveTo) {
      const about = present.filter((id) => mentions(actionText, state.characters[id]));
      if (about.length && about.every((id) => state.characters[id].status.location !== p.moveTo)) {
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
      if (it.needsRoll) o.roll = Eng.roll(c, it.skill, it.difficulty);
      const failed = o.roll && /failure/.test(o.roll.result);
      if (it.moveTo && it.moveTo !== c.status.location && !failed) {
        c.status.location = it.moveTo;
        o.moved = it.moveTo;
      }
      outcomes.push(o);
    });
    applyEvents(state, intentObj, present, stepId || 'hour', res, due);
    return res;
  };

  // routine = long downtime: people eat and sleep, so hunger/fatigue settle
  // toward normal instead of climbing; stress drifts toward a calm baseline.
  Eng.advanceTime = function (state, hours, res, routine) {
    state.time.hour += hours;
    while (state.time.hour >= 24) { state.time.hour -= 24; state.time.day += 1; }
    state.scenario.needs.forEach((n) => {
      state.order.forEach((id) => {
        const c = state.characters[id];
        if (c.status.health === 'dead') return;
        const v = c.needs[n.id] || 0;
        c.needs[n.id] = routine
          ? E.clamp(0.35 + (v - 0.35) * Math.exp(-hours / 24), 0, 1)
          : E.clamp(v + (n.perHour || 0) * hours, 0, 1);
      });
    });
    state.clocks.slice().forEach((cl) => {
      if (cl.fired) return;
      cl.value = E.clamp(cl.value + (cl.perHour || 0) * hours, 0, cl.max);
      if (cl.value >= cl.max) Eng.fireClock(state, cl, res);
    });
  };

  Eng.fireClock = function (state, cl, res) {
    cl.fired = true;
    if (cl.fireWorld) Object.assign(state.world, cl.fireWorld);
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
    const meanDays = sc.majorEventDays ?? 9;
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
    if (clockHit && clockHit.hours <= randomHours) return { hours: clockHit.hours, reason: 'clock', clock: clockHit };
    if (randomHours <= horizon) return { hours: Math.round(randomHours), reason: 'random' };
    return { hours: horizon, reason: 'horizon' };
  };

  // ---------- applying the model's update ----------
  Eng.applyUpdate = function (state, upd, present, ctx) {
    ctx = ctx || {};
    const report = { applied: [], rejected: [] };
    const ids = new Set(state.order);
    const reject = (what, why) => report.rejected.push(`${what} — ${why}`);
    const witnesses = [state.player].concat(present);

    (Array.isArray(upd.facts) ? upd.facts : []).slice(0, 6).forEach((f) => {
      if (!f || !f.text) return reject('fact', 'no text');
      const about = (f.about || []).filter((x) => ids.has(x));
      let known = (f.known_by || []).filter((x) => x === 'all' || ids.has(x));
      if (!known.length) known = witnesses.slice();
      const fact = E.Memory.addFact(state, { about, text: f.text, known_by: known, weight: f.weight });
      if (fact.weight >= 3) state.flags.chapterWorthy = true;
      report.applied.push(`fact: ${fact.text} (w${fact.weight}, known by ${fact.known_by.join('/')})`);
    });

    (Array.isArray(upd.state) ? upd.state : []).forEach((s) => {
      if (!s || typeof s.target !== 'string') return reject('state', 'no target');
      const [kind, key] = s.target.split(':');
      const label = JSON.stringify(s);
      if (kind === 'char') {
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
          c.status.location = dest;
        } else if (s.field === 'add_condition') {
          const v = String(s.value || '').slice(0, 40).trim();
          if (!v) return reject(label, 'empty condition');
          // Moods are already tracked as needs; keep conditions physical/situational.
          const low = v.toLowerCase();
          if (state.scenario.needs.some((n) => low.includes(n.id) || low.includes((n.label || '').toLowerCase())) || MOODS.test(low)) {
            return reject(label, 'mood, not a condition (tracked as a need)');
          }
          if (!c.status.conditions.includes(v)) c.status.conditions.push(v);
        } else if (s.field === 'remove_condition') {
          const before = c.status.conditions.length;
          c.status.conditions = c.status.conditions.filter((x) => x.toLowerCase() !== String(s.value).toLowerCase());
          if (before === c.status.conditions.length) return reject(label, 'condition not present');
        } else if (s.field === 'need') {
          if (c.needs[s.need] == null) return reject(label, 'unknown need');
          c.needs[s.need] = E.clamp(c.needs[s.need] + E.clamp(Number(s.delta) || 0, -1, 1), 0, 1);
        } else return reject(label, 'unknown field');
      } else if (kind === 'world') {
        if (!(key in state.world)) return reject(label, 'unknown world key');
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
      if (!a || !ids.has(a.to) || a.to === state.player) return reject('player_attitude ' + JSON.stringify(a), 'bad id');
      const d = E.clamp(Math.round(Number(a.delta) || 0), -10, 10);
      if (!d) return;
      pc.relations[a.to] = E.clamp((pc.relations[a.to] || 0) + d, -100, 100);
      if (a.reason) pc.attitudeNotes[a.to] = String(a.reason).slice(0, 80);
      report.applied.push(`your attitude: →${a.to} ${d > 0 ? '+' : ''}${d}${a.reason ? ' (' + a.reason + ')' : ''}`);
    });

    if (upd.chapter_worthy === true) state.flags.chapterWorthy = true;
    return report;
  };

  // Removes repeated paragraphs (a common small-model loop), ignoring quotes and spacing.
  // If generation hit the token cap mid-sentence, cut back to the last full sentence.
  Eng.trimIncomplete = function (text) {
    const t = String(text || '').trim();
    if (!t || /[.!?…]["'”’)*]*$/.test(t)) return t;
    const m = t.match(/^[\s\S]*[.!?…]["'”’)*]*/);
    return m ? m[0].trim() : t;
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
    const allowed = new Set([startLoc, state.characters[state.player].status.location]);
    const verbs = "head|heads|heading|walk|walks|go|goes|step|steps|stepping|make your way|enter|enters|duck|ducks|push open|pushes open|slip|slips|hurry|hurries|return|returns|wander|wanders|move|moves|cross|crosses";
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

  // Drops trailing paragraphs that are the player character's own action or
  // thoughts ("You turn back to…"), so the scene ends on someone else's move.
  Eng.trimPlayerEnding = function (prose) {
    const paras = String(prose || '').split(/\n\s*\n/);
    let dropped = 0;
    while (paras.length > 1 && dropped < 2 && /^\s*(\[[^\]]*\]\s*)?(you|your)\b/i.test(paras[paras.length - 1])) {
      paras.pop();
      dropped++;
    }
    return paras.join('\n\n').trim();
  };

  // The full cleanup for a model-written scene, recording what it changed.
  Eng.cleanScene = function (text, res) {
    const raw = String(text || '').trim();
    const whole = Eng.trimIncomplete(raw);
    if (whole !== raw) guard(res, 'scene', 'cut to last sentence', '…' + raw.slice(whole.length));
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
    needs: E.clone(state.order.map((id) => state.characters[id].needs)),
    clocks: state.clocks.map((c) => ({ value: c.value, fired: c.fired })),
  });

  // Winds the clock back to where the scene actually ended: the last beat plus
  // a little for the beat itself. Keeps the full step if a pressure clock fired
  // (the scene is built around it). Returns true when time changed.
  const restoreTime = (state, snap) => {
    state.time = E.clone(snap.time);
    state.order.forEach((id, i) => { state.characters[id].needs = E.clone(snap.needs[i]); });
    state.clocks.forEach((c, i) => { if (snap.clocks[i]) c.value = snap.clocks[i].value; });
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
      report = Eng.applyUpdate(state, upd, p.present, { startLoc: p.frame.startLoc, endLoc });
      report.rejected.forEach((r) => guard(p.res, 'memory', 'update rejected', r));
    } catch (err) {
      E.Memory.addFact(state, { about: [state.player], text: `${state.characters[state.player].name}: ${p.action}`.slice(0, 200), known_by: ['all'], weight: 1 });
      report = { applied: [], rejected: [], warning: 'Update step failed: ' + err.message };
      guard(p.res, 'memory', 'update failed', err.message);
    }
    if (cut) report.applied.unshift(`interjected after beat ${cut} of ${total}`);
    delete state.pending;

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

  // The downtime turn: simulate time, ask the model for a montage and (if
  // needed) the interrupting event, then narrate it with day-stamped beats.
  async function skipTurn(state, action, phase) {
    const plan = Eng.planMajorSkip(state);
    const pre = E.clone(state);
    delete pre.log; delete pre.pending; delete pre.undo;
    state.turn += 1;
    const system = E.Prompts.header(state);
    const frame = { startTime: E.fmtTime(state), startLoc: state.characters[state.player].status.location, stepId: 'major', stepLabel: 'until something major happens', spanMinutes: Math.round(plan.hours * 60) };
    const presentStart = Eng.present(state);
    const res = { outcomes: [], events: [], guards: [] };

    phase('Fast-forwarding…');
    Eng.advanceTime(state, plan.hours, res, true);
    frame.endTime = E.fmtTime(state);
    frame.days = Math.round(plan.hours / 24 * 10) / 10;

    phase('Simulating the downtime…');
    const obj = await E.LLM.chatJSON({
      kind: 'intent', system, user: E.Prompts.skipIntent(state, action, plan, frame, res),
      maxTokens: 900, temperature: 0.8,
    });

    // what happened in the meantime
    Eng.applyEvents(state, { events: Array.isArray(obj.events) ? obj.events : [] }, [], 'hours', res,
      { regional: true, world: plan.hours >= 72 }, { local: 2, regional: 2, world: plan.hours >= 72 ? 1 : 0 });
    // the interrupting event, when it isn't a pressure clock firing
    if (plan.reason !== 'clock') {
      const m = obj.major_event && typeof obj.major_event.text === 'string' ? obj.major_event : { text: 'Something goes badly wrong, and the routine ends.' };
      const text = m.text.trim().slice(0, 240);
      const scope = ['regional', 'world'].includes(m.scope) ? m.scope : 'local';
      const effects = applyEffects(state, m.effects, scope);
      res.events.push(`[major] ${text}`);
      E.Memory.addFact(state, { about: (m.who || []).filter((id) => state.characters[id]), text, known_by: ['all'], weight: 3 });
      if (scope !== 'local') { state.news.push({ scope, text, time: E.fmtTime(state), effects }); state.tierLast[scope] = absHours(state); }
      res.major = { text, scope, effects };
    } else {
      res.major = { text: res.events[res.events.length - 1] || plan.clock.name, scope: 'clock' };
    }
    // where everyone is when it hits
    (Array.isArray(obj.positions) ? obj.positions : []).forEach((p) => {
      const c = p && state.characters[p.id];
      const loc = c && Eng.resolveLocation(state, p.where, false);
      if (c && loc && Eng.alive(state, p.id)) c.status.location = loc;
    });
    const pw = Eng.resolveLocation(state, obj.player_where, false);
    if (pw) state.characters[state.player].status.location = pw;
    res.outcomes.push({ id: state.player, action: action || 'keeps to routine through the downtime', visible: true, roll: null, moved: null });
    state.flags.chapterWorthy = true;

    const montage = Array.isArray(obj.montage) ? obj.montage.filter((x) => x && x.text).slice(0, 5) : [];
    const doings = Array.isArray(obj.positions) ? obj.positions.filter((p) => p && state.characters[p.id] && p.doing) : [];
    const narration = { skip: true, system, action, montage, doings, presentStart };
    const beats = await writeSkipScene(state, narration, { frame, res }, phase);
    const text = beatsText(beats);
    state.log.push({ turn: state.turn, type: 'action', text: action || '(downtime)', time: frame.startTime, until: frame.endTime, skip: plan.reason });
    state.log.push({ turn: state.turn, type: 'resolve', outcomes: res.outcomes, events: res.events });
    state.log.push({ turn: state.turn, type: 'scene', text, beats, startDay: pre.time.day, startMinutes: Math.round(pre.time.hour * 60) });
    state.recent = [{ turn: state.turn, action, text }];
    const here = state.characters[state.player].status.location;
    const witnesses = state.order.filter((id) => id !== state.player && Eng.alive(state, id) && state.characters[id].status.location === here);
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
    }), p.res);
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
    }), res);
    let prose = await narrateOnce();
    const strayed = Eng.findRelocation(state, prose, frame.startLoc);
    if (strayed) {
      guard(res, 'scene', 'relocation regenerated', `first draft took the player to ${strayed.name}`);
      phase('Rewriting the scene…');
      const here = state.locations[state.characters[state.player].status.location].name;
      frame.correction = `Your previous draft took the player character to ${strayed.name}, which did not happen. The whole scene stays in ${here}${state.characters[state.player].status.location !== frame.startLoc ? ' (after the move shown above)' : ''}.`;
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
        }), res);
        const away = more && Eng.findRelocation(state, more, frame.startLoc);
        if (away) guard(res, 'scene', 'continuation dropped', `it took the player to ${away.name}`);
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
    // The update step's guards belong to the scene it records, the turn before this one.
    const guardsOf = () => [].concat(
      committing && committing.res && committing.res.guards ? committing.res.guards.filter((g) => g.stage === 'memory').map((g) => Object.assign({ turn: committing.turn }, g)) : [],
      state.pending && state.pending.turn === state.turn && state.pending.res !== (committing && committing.res) ? (state.pending.res.guards || []).map((g) => Object.assign({ turn: state.turn }, g)) : []);
    try {
      const out = await playTurn(state, action, stepId, phase, cutAt);
      delete snapshot.undo;
      state.undo = { state: snapshot, turn: state.turn, action, stepId, cutAt: cutAt || null };
      finishReport(tel, guardsOf());
      return out;
    } catch (err) {
      finishReport(tel, guardsOf(), err);
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

    const pre = E.clone(state);
    delete pre.log; delete pre.pending; delete pre.undo;
    state.turn += 1;
    const present = Eng.present(state);
    const system = E.Prompts.header(state); // same prefix for all calls this turn

    const due = Eng.tiersDue(state, step.hours);
    phase(due.world ? 'The wider world stirs…' : due.regional ? 'Something stirs nearby…' : 'Characters deciding…');
    const intentObj = await E.LLM.chatJSON({
      kind: 'intent', system, user: E.Prompts.intent(state, present, action, step.label, step.id, due),
      maxTokens: 260 + 150 * present.length + (due.regional ? 120 : 0) + (due.world ? 140 : 0), temperature: 0.7,
    });

    const frame = { startTime: E.fmtTime(state), startLoc: state.characters[state.player].status.location, stepId: step.id, stepLabel: step.label, words: step.words, spanMinutes: Math.round(step.hours * 60) };
    const res = Eng.resolve(state, intentObj, present, action, step.id, due);
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
    state.pending = { turn: state.turn, action, res, frame, present, beats, pre, playerMovedTo: playerOut && playerOut.moved, narration };

    phase('');
    return { prose: text, beats, res, report: report || { applied: [], rejected: [] } };
  }

  // ---------- undo and reroll ----------
  Eng.canUndo = (state) => !!(state && state.undo && state.undo.state);

  // Puts the whole state back to how it was before the last action: facts,
  // time, clocks, rolls, chapters, and the previous scene pending again.
  // Returns what was undone so the page can refill the action box.
  Eng.undo = function (state) {
    if (!Eng.canUndo(state)) return null;
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
      finishReport(tel, sceneGuards());
      phase('');
      return { turn: p.turn, oldText, prose: text, beats, until };
    } catch (err) {
      finishReport(tel, sceneGuards(), err);
      replaceState(state, snapshot);
      phase('');
      throw err;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
