// Faction standing (task G-6): how each faction regards the player, who
// belongs to which faction, and the player's role in one. DOM-free.
//
// Membership: a character's `groups`, [{id, role}] or plain ids (members);
// roles are member, favored (an important person: their word carries weight)
// and leader. The player uses the same field. Standing: −100..100 per
// faction, in the feelings' words, changed by what the player does and is
// known to have done. The engine owns it (rules 1 and 2): every change is
// clamped, needs a reason and a faction that could know, and reaches the
// faction's people (their feelings toward the player) and its allies and
// enemies, a share each.
(function (root) {
  const E = root.Ensemble;
  const St = (E.Standing = {});
  const Eng = () => E.Engine;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  St.ROLES = ['member', 'favored', 'leader'];
  St.TURN_MAX = 10; // a turn's change, per faction, from the update step
  St.EVENT_MAX = 15; // an event's, per faction
  St.SPREAD = 0.25; // to allies (the same way) and enemies (the other way)
  St.MEMBER_SHARE = 0.5; // to each member's feelings toward the player…
  St.MEMBER_MAX = 5; // …at most this much a change
  // A role the story can give the player, from standing high enough; lost
  // when standing falls below the other line.
  St.ROLE_AT = { member: -20, favored: 40, leader: 60 };
  St.ROLE_LOST = { favored: 10, leader: 0 };
  St.CHALLENGE = 20; // a leader below this is questioned (the reckoning)
  St.HOSTILE = -50; // its groups on watch turn alert when the player is around
  St.TRUSTED = 50; // its groups let the player by

  // ---------- data ----------
  // A character's memberships, [{id, role}].
  St.groupsOf = (c) => (Array.isArray(c && c.groups) ? c.groups : []).map((g) => (typeof g === 'string' ? { id: g, role: 'member' } : isObj(g) ? { id: g.id, role: g.role || 'member' } : null)).filter((g) => g && g.id);
  St.roleOf = (state, group, id) => { const g = St.groupsOf(state.characters[id || state.player]).find((x) => x.id === group); return g ? g.role : null; };
  St.members = (state, group) => Eng().cast(state, { alive: true }).filter((id) => id !== state.player && St.groupsOf(state.characters[id]).some((g) => g.id === group));
  St.value = (state, group) => ((state.reputation || {})[group] || { value: 0 }).value;
  St.word = (v) => E.relWord(v);
  St.groupName = (state, id) => ((state.factions || []).find((f) => f.id === id) || { name: id }).name;

  // Validation (Scenario): a character's or cast entry's groups, and a
  // world's, start's or slot's starting standing.
  St.groupsProblems = function (groups, groupIds, who) {
    if (groups == null) return [];
    if (!Array.isArray(groups)) return [`${who}: "groups" must be a list of group ids or {id, role}`];
    const out = [];
    groups.forEach((g) => {
      const id = typeof g === 'string' ? g : isObj(g) ? g.id : null;
      if (!id) return out.push(`${who}: "groups" must be a list of group ids or {id, role}`);
      if (!groupIds.has(id)) out.push(`${who}: "${id}" in "groups" isn't one of the world's groups`);
      if (isObj(g) && g.role != null && !St.ROLES.includes(g.role)) out.push(`${who}: the role in ${id} must be ${St.ROLES.join(', ')}`);
    });
    return out;
  };
  St.reputationProblems = function (rep, groupIds, who) {
    if (rep == null) return [];
    if (!isObj(rep)) return [`${who}: "reputation" must map group ids to numbers from -100 to 100`];
    return Object.entries(rep).flatMap(([k, v]) => [].concat(groupIds.has(k) ? [] : [`${who}: "reputation" names "${k}", which isn't one of the world's groups`],
      typeof v === 'number' && v >= -100 && v <= 100 ? [] : [`${who}: "reputation" for ${k} must be a number from -100 to 100`]));
  };
  // A faction's allies and enemies (group ids).
  St.factionProblems = function (f, groupIds) {
    const out = [];
    ['allies', 'enemies'].forEach((k) => {
      if (f[k] == null) return;
      if (!Array.isArray(f[k]) || !f[k].every((x) => typeof x === 'string')) return out.push(`group "${f.id}": "${k}" must be a list of group ids`);
      f[k].filter((x) => !groupIds.has(x) || x === f.id).forEach((x) => out.push(`group "${f.id}": "${x}" in "${k}" isn't another of the world's groups`));
    });
    return out;
  };

  // New game: standing from the scenario (the start's own and the player
  // slot's merged over the world's), memberships tidied.
  St.init = function (state, sc) {
    state.reputation = {};
    const start = isObj(sc.reputation) ? sc.reputation : {};
    (sc.factions || []).forEach((f) => {
      state.reputation[f.id] = { value: E.clamp(Math.round(Number(start[f.id]) || 0), -100, 100), why: '', turn: 0 };
    });
    Object.values(state.characters).forEach((c) => { if (c.groups != null) c.groups = St.groupsOf(c); });
  };

  // ---------- changing it ----------
  // Who of a faction could know what the player did in this scene: a member
  // there (or in its events), one of its groups in the scene's rooms, or a
  // public event. ctx: { witnesses (ids), rooms (room ids), public }.
  St.couldKnow = function (state, group, ctx) {
    if (ctx && ctx.public) return true;
    const who = new Set((ctx && ctx.witnesses) || []);
    if (St.members(state, group).some((id) => who.has(id))) return true;
    const rooms = new Set((ctx && ctx.rooms) || []);
    return Object.values(state.standees || {}).some((g) => g.faction === group && rooms.has(g.location) && Eng().standeeActive(g));
  };
  // One change: clamped to max, recorded with its reason, spread to the
  // faction's people (their feelings), its allies and enemies, its groups on
  // watch, and roles that no longer hold. → lines for Debug.
  St.change = function (state, group, delta, why, opts) {
    const o = Object.assign({ max: St.TURN_MAX, spread: true, turn: state.turn }, opts || {});
    const r = state.reputation && state.reputation[group];
    if (!r) return [];
    const d = E.clamp(Math.round(Number(delta) || 0), -o.max, o.max);
    if (!d) return [];
    const before = r.value;
    r.value = E.clamp(before + d, -100, 100);
    if (r.value === before) return [];
    r.why = E.shorten(String(why || ''), 100);
    r.turn = o.turn;
    const name = St.groupName(state, group);
    const lines = [`${name}: ${before} → ${r.value} (${d > 0 ? '+' : ''}${d}${r.why ? `, ${r.why}` : ''})`];
    // Word gets around: each member's feelings toward the player move a share.
    const share = E.clamp(Math.round(d * St.MEMBER_SHARE), -St.MEMBER_MAX, St.MEMBER_MAX);
    if (share) {
      St.members(state, group).forEach((id) => {
        const c = state.characters[id];
        c.relations[state.player] = E.clamp((c.relations[state.player] || 0) + share, -100, 100);
        lines.push(`word gets around: ${c.name} ${share > 0 ? '+' : ''}${share} toward ${state.characters[state.player].name}`);
      });
    }
    // Its groups on watch: hostile standing puts the calm ones around the player on alert.
    if (r.value <= St.HOSTILE && before > St.HOSTILE) {
      const here = state.characters[state.player].status.location;
      Object.values(state.standees || {}).filter((g) => g.faction === group && g.location === here && g.state === 'calm').forEach((g) => {
        g.state = 'alert';
        lines.push(`${g.label} (${name}) are on alert around ${state.characters[state.player].name}`);
      });
    }
    // Allies the same way, enemies the other, a share each (once, not on).
    if (o.spread) {
      const f = (state.factions || []).find((x) => x.id === group) || {};
      const step = (ids, sign) => (ids || []).forEach((id) => {
        const s = Math.round(d * St.SPREAD) * sign;
        if (s) lines.push(...St.change(state, id, s, `${name}'s ${sign > 0 ? 'ally' : 'enemy'}: ${r.why || 'what the player did'}`, Object.assign({}, o, { spread: false, max: Math.abs(s) })));
      });
      step(f.allies, 1);
      step(f.enemies, -1);
    }
    // A leader slipping (below CHALLENGE) is questioned: it counts toward
    // the reckoning, when someone comes to confront the player (Eng).
    if (St.roleOf(state, group) === 'leader' && r.value < St.CHALLENGE && before >= St.CHALLENGE) {
      state.ignored = (state.ignored || []).concat(`${name} question ${state.characters[state.player].name}'s leadership`).slice(-4);
      lines.push(`${name} begin to question the player's leadership`);
    }
    lines.push(...St.checkRoles(state, group));
    return lines;
  };
  // Roles that standing no longer holds up (favored below 10, leader below 0).
  St.checkRoles = function (state, group) {
    const role = St.roleOf(state, group);
    const v = St.value(state, group);
    if (role === 'leader' && v < St.ROLE_LOST.leader) return St.setRole(state, group, v >= St.ROLE_LOST.favored ? 'favored' : 'member', 'lost the group\'s trust', { force: true });
    if (role === 'favored' && v < St.ROLE_LOST.favored) return St.setRole(state, group, 'member', 'lost the group\'s trust', { force: true });
    return [];
  };
  // The player's role in a faction: member, favored, leader, or none (left or
  // thrown out). Without force (the model's proposal), standing must be high
  // enough. A new leader replaces any other. → lines, or { error }.
  St.setRole = function (state, group, role, why, opts) {
    const o = opts || {};
    if (!state.reputation || !state.reputation[group]) return { error: `unknown group "${group}"` };
    if (role !== 'none' && !St.ROLES.includes(role)) return { error: `role must be ${St.ROLES.join(', ')} or none` };
    const pc = state.characters[state.player];
    const now = St.roleOf(state, group);
    if ((now || 'none') === role) return [];
    const v = St.value(state, group);
    if (!o.force && role !== 'none' && v < St.ROLE_AT[role]) return { error: `${St.groupName(state, group)} doesn't think enough of ${pc.name} for that (${v}; ${role} takes ${St.ROLE_AT[role]})` };
    const list = St.groupsOf(pc).filter((g) => g.id !== group);
    if (role !== 'none') list.push({ id: group, role });
    pc.groups = list;
    const lines = [`${pc.name}: ${now || 'not a member'} → ${role === 'none' ? 'not a member' : role} of ${St.groupName(state, group)}${why ? ` (${E.shorten(String(why), 80)})` : ''}`];
    if (role === 'leader') {
      St.members(state, group).forEach((id) => {
        const c = state.characters[id];
        const g = St.groupsOf(c).find((x) => x.id === group);
        if (g && g.role === 'leader') { c.groups = St.groupsOf(c).map((x) => (x.id === group ? { id: group, role: 'favored' } : x)); lines.push(`${c.name} is no longer the leader of ${St.groupName(state, group)}`); }
      });
    }
    return lines;
  };

  // The update step's proposals (rules 1, 2 and 6): reputation changes with a
  // reason that a faction could know about, and a role the scene shows given.
  // ctx: from Eng.applyUpdate (startLoc, endLoc, involved, prose, turn).
  St.applyUpdate = function (state, upd, present, ctx, reject, applied) {
    if (!state.reputation || !Object.keys(state.reputation).length) return;
    const seen = { witnesses: [state.player].concat(present || [], ctx.involved || []), rooms: [ctx.startLoc, ctx.endLoc].filter(Boolean) };
    const used = {};
    (Array.isArray(upd.reputation) ? upd.reputation : []).slice(0, 3).forEach((x) => {
      const label = 'reputation ' + JSON.stringify(x);
      if (!x || !state.reputation[x.group]) return reject(label, 'unknown group');
      if (!String(x.reason || '').trim()) return reject(label, 'a change in standing needs a reason');
      if (!St.couldKnow(state, x.group, seen)) return reject(label, `nobody from ${St.groupName(state, x.group)} saw it, and it isn't public`);
      const room = St.TURN_MAX - Math.abs(used[x.group] || 0);
      if (room <= 0) return reject(label, `${St.groupName(state, x.group)} already changed its mind this turn`);
      const d = E.clamp(Math.round(Number(x.delta) || 0), -room, room);
      used[x.group] = (used[x.group] || 0) + d;
      St.change(state, x.group, d, x.reason, { turn: ctx.turn ?? state.turn }).forEach((l) => applied(l));
    });
    (Array.isArray(upd.group_role) ? upd.group_role : upd.group_role ? [upd.group_role] : []).slice(0, 1).forEach((x) => {
      const label = 'group_role ' + JSON.stringify(x);
      if (!x || !state.reputation[x.group]) return reject(label, 'unknown group');
      // The scene must show it (a quote of 4+ words that is really there), as for judged endings.
      const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const quote = norm(x.quote);
      if (quote.split(' ').length < 4 || !norm(ctx.prose).includes(quote)) return reject(label, 'the quote isn\'t in the scene');
      const out = St.setRole(state, x.group, x.role, x.reason || x.quote);
      if (out.error) return reject(label, out.error);
      out.forEach((l) => applied(l));
    });
  };

  // ---------- prompts ----------
  // "Standing: The convoy: trusted (+42; brought back the radio), you are
  // favored | The Ridge: wary (-20)". All groups, or (a compact context) the
  // ones not at 0 or where the player has a role. In the user message: it
  // changes in play (rule 7).
  St.line = function (state) {
    const reps = state.reputation || {};
    const ids = Object.keys(reps);
    if (!ids.length) return '';
    const compact = E.contextTier().id === 'compact';
    const one = (id) => {
      const r = reps[id];
      const role = St.roleOf(state, id);
      const bits = [`${St.word(r.value)} (${r.value > 0 ? '+' : ''}${r.value}${r.why ? `; ${r.why}` : ''})`];
      if (role) bits.push(role === 'leader' ? 'you lead it' : role === 'favored' ? 'you are favored: your requests carry weight' : 'you are a member');
      return `${St.groupName(state, id)}: ${bits.join(', ')}`;
    };
    const shown = ids.filter((id) => !compact || reps[id].value !== 0 || St.roleOf(state, id));
    return shown.length ? `\nStanding with the groups: ${shown.map(one).join(' | ')}` : '';
  };
  // A person's memberships for the cast line and cards: "The Resistance (favored)".
  St.membership = (state, c) => St.groupsOf(c).filter((g) => (state.factions || []).some((f) => f.id === g.id))
    .map((g) => `${St.groupName(state, g.id)}${g.role !== 'member' ? ` (${g.role})` : ''}`).join(', ');
})(typeof window !== 'undefined' ? window : globalThis);
