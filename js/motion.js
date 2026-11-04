// Moving pieces on the map (task A-10): which tokens walk when a beat is
// revealed, along which rooms and doors, what pulses, and how much motion the
// player wants. Decided from the game's data, never from the picture, and
// only for what the player saw (rules 6 and 11): seen moves walk, a path never
// crosses a room the player hasn't seen, covert moves never move anything.
// DOM-free; js/ui/motion.js plays it.
(function (root) {
  const E = root.Ensemble;
  const M = (E.Motion = {});

  // 'on' | 'reduced' | 'off'. Reduce motion in force (by the setting, or the
  // device when it is "same as my device") caps it at 'reduced'.
  M.mode = function (appearance, deviceReduced) {
    const a = appearance || {};
    const want = ['on', 'reduced', 'off'].includes(a.mapMotion) ? a.mapMotion : 'on';
    const reduce = a.motion === 'on' || (a.motion !== 'off' && !!deviceReduced);
    return reduce && want === 'on' ? 'reduced' : want;
  };

  // What one drawing of the local map showed: { key (the place drawn), turn,
  // shown (beats revealed), cut (a step-in point), rooms: {token id: room},
  // links: {"a|b": kind}, features: {"room|name": state}, groups: {id: state} }.
  // tokens: {room: [token]} as the map drew them; inView: rooms in view.
  M.snapshot = function (state, o) {
    const rooms = {};
    Object.entries(o.tokens || {}).forEach(([room, list]) => list.forEach((t) => { rooms[t.id] = room; }));
    const inView = o.inView || [];
    const links = {};
    inView.forEach((a) => E.Engine.linkedRooms(state, a).forEach((b) => {
      const key = [a, b].sort().join('|');
      if (!(key in links)) links[key] = E.Engine.linkShown(state, a, b) || '';
    }));
    const features = {};
    inView.forEach((r) => E.Engine.features(state, r).forEach((f) => { features[`${r}|${f.name}`] = f.state == null ? '' : String(f.state); }));
    const groups = {};
    Object.values(state.standees || {}).forEach((g) => { if (inView.includes(g.location)) groups[g.id] = g.state; });
    return { key: o.key, turn: state.turn, shown: o.shown || 1, cut: o.cut || null, rooms, links, features, groups };
  };

  // Is now the scene read on from prev: the same place, and the next beats
  // of the same turn, or a new turn's first? Undo, a reroll, a step-in, a
  // load and a move to another place never animate.
  M.forward = (prev, now) => !!(prev && now && prev.key === now.key && !now.cut &&
    ((now.turn === prev.turn && now.shown > prev.shown) || (now.turn === prev.turn + 1 && now.shown === 1)));

  // The beats now revealed for the first time (0-based).
  const revealed = (prev, now) => {
    const from = now.turn === prev.turn ? prev.shown : 0;
    const out = [];
    for (let i = from; i < now.shown; i++) out.push(i);
    return out;
  };

  // The moves to play between two drawings: [{ id, path: [rooms], seen:
  // [bool per room] }]. A token walks when its room as drawn changed, it was
  // drawn in its old room or appears in its new one, and the move is one the
  // player saw: their own, a companion's on their trip, or one of
  // Eng.sceneMoves in a beat just revealed.
  M.moves = function (state, prev, now) {
    if (!M.forward(prev, now)) return [];
    const beats = new Set(revealed(prev, now));
    const seenMoves = E.Engine.sceneMoves(state).filter((m) => beats.has(m.beat));
    const companions = (state.pending && state.pending.travel && state.pending.travel.companions) || [];
    const seen = new Set(state.seenRooms || []);
    const out = [];
    const add = (id, from, to) => {
      if (!from || !to || from === to || !state.locations[from] || !state.locations[to]) return;
      let path = E.Engine.route(state, from, to, { who: id });
      if (!path.length) path = E.Engine.route(state, from, to);
      if (!path.length) path = [from, to];
      out.push({ id, path, seen: path.map((r) => seen.has(r)) });
    };
    Object.keys(Object.assign({}, prev.rooms, now.rooms)).forEach((id) => {
      const a = prev.rooms[id], b = now.rooms[id];
      if (a === b) return;
      if (id === state.player || companions.includes(id)) {
        if (a && b) add(id, a, b);
        return;
      }
      const m = seenMoves.find((x) => x.id === id);
      if (!m) return;
      // Drawn at either end: walks out of view, or comes into it.
      if ((a || b) && (!a || a === m.from) && (!b || b === m.to)) add(id, m.from, m.to);
    });
    return out;
  };

  // A move's points, from the geometry the map was drawn with: geom = {
  // rooms: {id: {x, y}} (a room's middle), doors: {"a|b": {x, y}} } in map
  // units. start and end: where the token stood and stands (null when it
  // wasn't, or isn't, drawn). → [{ x, y, o (opacity), pause }]: the token
  // walks room to room through the doors, pausing in each, and fades out at
  // the door into a room the player hasn't seen and in at the door out of one.
  M.points = function (geom, move, start, end) {
    const door = (a, b) => (geom.doors || {})[[a, b].sort().join('|')] || mid((geom.rooms || {})[a], (geom.rooms || {})[b]);
    const pts = [];
    const push = (p, o, pause) => { if (p) pts.push({ x: p.x, y: p.y, o, pause: !!pause }); };
    const { path, seen } = move;
    if (seen[0] && start) push(start, 1);
    for (let i = 0; i + 1 < path.length; i++) {
      const d = door(path[i], path[i + 1]);
      if (!d) continue;
      if (seen[i] && seen[i + 1]) push(d, 1, true);
      else if (seen[i] && !seen[i + 1]) { push(d, 1); push(d, 0); }
      else if (!seen[i] && seen[i + 1]) { push(d, 0); push(d, 1); }
      // Through rooms in between, by their middle, but never one unseen.
      if (i + 2 < path.length && seen[i + 1]) push((geom.rooms || {})[path[i + 1]], 1);
    }
    if (seen[seen.length - 1] && end) push(end, 1);
    // Nothing to show: no walk.
    return pts.some((p) => p.o) && pts.length > 1 ? pts : [];
  };
  function mid(a, b) { return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; }

  // What to pulse once: doors, features and groups in view whose state
  // changed since the last drawing, and features that are new. Only after a
  // turn was played in the same place (not on a load or a move elsewhere).
  M.pulses = function (prev, now) {
    const out = { links: [], features: [], groups: [] };
    if (!prev || !now || prev.key !== now.key || now.turn <= prev.turn) return out;
    Object.entries(now.links).forEach(([k, v]) => { if (k in prev.links && prev.links[k] !== v) out.links.push(k); });
    const prevRooms = new Set(Object.keys(prev.features).map((k) => k.split('|')[0]));
    Object.entries(now.features).forEach(([k, v]) => {
      if (k in prev.features ? prev.features[k] !== v : prevRooms.has(k.split('|')[0])) out.features.push(k);
    });
    Object.entries(now.groups).forEach(([id, st]) => { if (id in prev.groups && prev.groups[id] !== st) out.groups.push(id); });
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
