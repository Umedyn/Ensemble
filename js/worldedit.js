// World, group and start editing for the creator (task 6-1): fields bound to
// paths in the working copy's files, a blank world, starts (add, duplicate,
// rename, remove), rooms and their connections, the cast and its per-start
// overrides, groups and needs (renaming and removing with their references),
// zip import and the test-play payload. DOM-free; the forms are in creator.js.
(function (root) {
  const E = root.Ensemble;
  const WE = (E.WorldEdit = {});
  const S = () => E.Scenario;
  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const slug = (name, taken, fallback) => {
    const base = String(name || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || fallback;
    let id = base;
    for (let i = 2; (taken || []).includes(id); i++) id = `${base}-${i}`;
    return id;
  };
  WE.slug = slug;
  WE.ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
  WE.SKILLS = E.DEFAULT_SKILLS;
  WE.LINK_KINDS = ['open', 'door', 'locked door', 'vent', 'hatch', 'window', 'stairs'];

  // ---------- paths ----------
  // A path is "a.b.0.c" inside one file's JSON; numbers index lists.
  const segs = (path) => (path === '' || path == null ? [] : String(path).split('.'));
  WE.get = function (obj, path) {
    let cur = obj;
    for (const s of segs(path)) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[s]; }
    return cur;
  };
  // Text from a form field to a value. → { value } | { del: true } | { error }
  // kinds: text (blank deletes), str (blank kept), num, int, lines, csv,
  // json, bool (false deletes), unseen (checked deletes, unchecked false),
  // null (blank is null), features ("camera=on" is {name, state}).
  WE.parse = function (kind, raw) {
    const s = raw == null ? '' : String(raw);
    const t = s.trim();
    switch (kind) {
      case 'str': return { value: s };
      case 'num': case 'int': {
        if (!t) return { del: true };
        const n = Number(t);
        if (!Number.isFinite(n)) return { error: 'must be a number' };
        if (kind === 'int' && !Number.isInteger(n)) return { error: 'must be a whole number' };
        return { value: n };
      }
      case 'lines': { const l = s.split('\n').map((x) => x.trim()).filter(Boolean); return l.length ? { value: l } : { del: true }; }
      case 'csv': { const l = s.split(',').map((x) => x.trim()).filter(Boolean); return l.length ? { value: [...new Set(l)] } : { del: true }; }
      case 'features': {
        const l = s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
          const m = x.match(/^(.+?)\s*=\s*(.+)$/);
          return m ? { name: m[1], state: m[2] } : x;
        });
        return l.length ? { value: l } : { del: true };
      }
      case 'json': {
        if (!t) return { del: true };
        try { return { value: JSON.parse(t) }; } catch (e) { return { error: `not valid JSON yet (${e.message})` }; }
      }
      case 'bool': return raw === true || raw === 'true' ? { value: true } : { del: true };
      case 'unseen': return raw === true || raw === 'true' ? { del: true } : { value: false };
      case 'null': return t ? { value: t } : { value: null };
      default: return t ? { value: s } : { del: true };
    }
  };
  // The value a field shows.
  WE.show = function (kind, v) {
    if (kind === 'lines') return Array.isArray(v) ? v.join('\n') : '';
    if (kind === 'csv') return Array.isArray(v) ? v.join(', ') : '';
    if (kind === 'features') return Array.isArray(v) ? v.map((f) => (isObj(f) ? (f.state != null ? `${f.name}=${f.state}` : f.name) : f)).join(', ') : '';
    if (kind === 'json') return v === undefined ? '' : JSON.stringify(v, null, 2);
    return v == null ? '' : String(v);
  };
  // Sets (or deletes) the value at a path, making the objects and lists on
  // the way. A plain id in a cast list becomes {id} when something is set
  // inside it. Objects emptied by a delete are removed, up to the first list.
  WE.set = function (obj, path, kind, raw) {
    const p = WE.parse(kind, raw);
    if (p.error) return { error: p.error };
    const s = segs(path);
    if (!s.length) return { error: 'no path' };
    let cur = obj;
    const trail = [];
    for (let i = 0; i < s.length - 1; i++) {
      let next = cur[s[i]];
      if (typeof next === 'string' && s[0] === 'cast' && i === 1) next = cur[s[i]] = { id: next };
      if (next == null || typeof next !== 'object') {
        if (p.del) return {};
        next = cur[s[i]] = /^\d+$/.test(s[i + 1]) ? [] : {};
      }
      trail.push([cur, s[i]]);
      cur = next;
    }
    const last = s[s.length - 1];
    if (p.del) {
      if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last];
      for (let i = trail.length - 1; i >= 0; i--) {
        const [parent, key] = trail[i];
        const v = parent[key];
        if (Array.isArray(parent) || !isObj(v) || Object.keys(v).length) break;
        delete parent[key];
      }
    } else cur[last] = p.value;
    return {};
  };
  // Lists: add an item at a path, remove one by index.
  WE.addItem = function (obj, path, item) {
    const list = WE.get(obj, path);
    if (Array.isArray(list)) list.push(item);
    else WE.set(obj, path, 'json', JSON.stringify([item]));
    return (WE.get(obj, path) || []).length - 1;
  };
  WE.removeItem = function (obj, path, i) {
    const list = WE.get(obj, path);
    if (Array.isArray(list)) list.splice(Number(i), 1);
  };
  // Renames a key of a plain object, keeping its place. → error text or ''
  WE.renameKey = function (obj, from, to) {
    to = String(to || '').trim();
    if (!isObj(obj) || from === to) return '';
    if (!to || /\./.test(to)) return 'a key needs a name without dots';
    if (to in obj) return `"${to}" is already used`;
    const entries = Object.entries(obj);
    Object.keys(obj).forEach((k) => delete obj[k]);
    entries.forEach(([k, v]) => (obj[k === from ? to : k] = v));
    return '';
  };

  // ---------- the working copy ----------
  WE.world = (files) => files['world.json'];
  WE.startFile = (id) => `starts/${id}.json`;
  WE.starts = function (files) {
    const out = {};
    (WE.world(files).starts || []).forEach((id) => { if (files[WE.startFile(id)]) out[id] = files[WE.startFile(id)]; });
    return out;
  };
  WE.character = (files, id) => files[`characters/${id}.json`] || null;
  const castId = (c) => (typeof c === 'string' ? c : c && c.id);
  WE.castIds = (start) => (start.cast || []).map(castId).filter(Boolean);
  // Every room, region, character, extra and standee id in the world: new
  // ones must not clash with any of them.
  WE.takenIds = function (files) {
    const w = WE.world(files);
    const out = new Set();
    const add = (list) => (Array.isArray(list) ? list : []).forEach((x) => { const id = castId(x); if (id) out.add(id); });
    [w, ...Object.values(WE.starts(files))].forEach((src) => { add(src.locations); add(src.extras); add(src.standees); add(src.regions); });
    add(w.characters);
    Object.keys(files).forEach((p) => { const m = p.match(/^characters\/(.+)\.json$/); if (m) out.add(m[1]); });
    return [...out];
  };
  WE.clockIds = function (files) {
    const out = [];
    const walk = (list) => (list || []).forEach((c) => { if (c && c.id) { out.push(c.id); walk(c.then); } });
    [WE.world(files), ...Object.values(WE.starts(files))].forEach((s) => walk(s.clocks));
    return out;
  };

  // A legacy folder becomes a new-format world as soon as it is opened.
  WE.fromFiles = function (files) {
    if (files['world.json']) return files;
    const legacy = Object.assign({}, files['scenario.json'], {
      characterData: (files['scenario.json'].characters || []).map((id) => files[`characters/${id}.json`] || null),
    });
    const b = S().fromLegacy(legacy);
    const out = { 'world.json': Object.assign({ format: 2 }, b.world) };
    Object.entries(b.starts).forEach(([id, st]) => (out[WE.startFile(id)] = st));
    Object.entries(b.characters).forEach(([id, c]) => (out[`characters/${id}.json`] = c));
    return out;
  };

  // A world that loads from the first moment: one start, one room, and one
  // person to play, for the creator to change.
  WE.blankWorld = function (title, takenFolders) {
    title = String(title || '').trim() || 'New world';
    const folder = slug(title, takenFolders || [], 'world');
    const files = {
      'world.json': {
        format: 2, id: folder, title, summary: '',
        setting: `${title}: describe where and when this is, and what everyday life is like here.`,
        rules: [], tags: [], timeLabel: 'Day', wakeHour: 7, skills: WE.SKILLS.slice(), needs: [],
        world: {}, factions: [], facts: [], characters: ['you'], starts: ['start'],
      },
      'starts/start.json': {
        id: 'start', title: 'The beginning', summary: '', start: { day: 1, hour: 8 }, player: 'you',
        cast: [{ id: 'you', status: { location: 'main-room' } }],
        locations: [{ id: 'main-room', name: 'Main room', desc: '', connects: [] }],
        clocks: [], facts: [], opening: '',
      },
      'characters/you.json': { id: 'you', name: 'You', pronouns: 'they/them', role: 'newcomer', traits: [], want: '', guard: 'medium', skills: {} },
    };
    return { folder, files };
  };

  // ---------- templates for New world (R-4) ----------
  // A blank world with regions already shaped for a kind of story, labels
  // per level and route kinds set, so a creator starts from something that
  // plays. Names are original. Each loads valid: one start in a sensible
  // region, one room there, one person to play. New places are built when
  // the story goes somewhere (generatedSites), so routes lead somewhere.
  const R = (id, name, extra) => Object.assign({ id, name, controller: null, tags: [], status: '', lore: '' }, extra);
  WE.TEMPLATES = {
    country: {
      label: 'One country with provinces',
      start: 'northmarch', room: ['market-square', 'Market Square', 'Cobbles, a shuttered bank and a fountain that still runs.'],
      world: {
        regionLabels: ['country', 'province', 'town'],
        routeKinds: { road: { time: '3h' } },
        regions: [
          R('kestria', 'Kestria', { lore: 'A small country of farms, river towns and one long railway.' }),
          R('northmarch', 'Northmarch', { parent: 'kestria', neighbours: ['eastvale', 'lowfield'], routes: [{ to: 'saltcoast', kind: 'rail', time: '4h' }], lore: 'Hill country and mill towns along the border.' }),
          R('eastvale', 'Eastvale', { parent: 'kestria', neighbours: ['northmarch', 'saltcoast'], lore: 'Orchards and vineyards in a wide valley.' }),
          R('saltcoast', 'Saltcoast', { parent: 'kestria', neighbours: ['eastvale', 'lowfield'], lore: 'Fishing ports, the capital and the sea.' }),
          R('lowfield', 'Lowfield', { parent: 'kestria', neighbours: ['saltcoast', 'northmarch'], lore: 'Flat farmland and slow rivers.' }),
        ],
      },
    },
    city: {
      label: 'One city',
      start: 'old-town', room: ['corner-cafe', 'Corner Café', 'Six tables, a chalkboard menu and a window onto the square.'],
      world: {
        regionLabels: ['city', 'district'],
        routeKinds: { bus: { time: '20m' }, rail: { time: '15m' } },
        regions: [
          R('brightwater', 'Brightwater', { lore: 'A harbour city of a million people, old at the centre and new at the edges.' }),
          R('old-town', 'Old Town', { parent: 'brightwater', neighbours: ['harbour', 'university'], routes: [{ to: 'suburbs', kind: 'rail' }], lore: 'Narrow streets, cafés and the town hall.' }),
          R('harbour', 'The Harbour', { parent: 'brightwater', neighbours: ['old-town'], routes: [{ to: 'suburbs', kind: 'bus' }], lore: 'Docks, fish markets and warehouses turned into flats.' }),
          R('university', 'University Quarter', { parent: 'brightwater', neighbours: ['old-town'], routes: [{ to: 'suburbs', kind: 'bus' }], lore: 'Lecture halls, bookshops and cheap noodles.' }),
          R('suburbs', 'The Suburbs', { parent: 'brightwater', lore: 'Houses with gardens, schools and a shopping centre.' }),
        ],
      },
    },
    planets: {
      label: 'Planets and travel',
      start: 'veyra-port', room: ['docking-ring', 'Docking Ring', 'A curved concourse of airlocks, cargo sleds and departure boards.'],
      world: {
        regionLabels: ['planet', 'city'],
        world: { ship: 'ready' },
        routeKinds: { hyperlane: { time: '2d', requires: { world: 'ship', is: 'ready' } } },
        regions: [
          R('veyra', 'Veyra', { routes: [{ to: 'ossam', kind: 'hyperlane' }, { to: 'thule-drift', kind: 'hyperlane', time: '4d' }], lore: 'A temperate world of trade guilds and crowded starports.' }),
          R('veyra-port', 'Veyra Starport', { parent: 'veyra', lore: 'The busiest port in the sector, run by the guilds.' }),
          R('ossam', 'Ossam', { routes: [{ to: 'thule-drift', kind: 'hyperlane' }], lore: 'A desert moon of mines and water rights.' }),
          R('thule-drift', 'Thule Drift', { lore: 'An ice field of salvage stations at the edge of charted space.' }),
        ],
      },
    },
  };
  // → { folder, files }, like blankWorld.
  WE.templateWorld = function (kind, title, takenFolders) {
    const t = WE.TEMPLATES[kind];
    const b = WE.blankWorld(title, takenFolders);
    if (!t) return b;
    const w = b.files['world.json'];
    Object.assign(w, clone(t.world), { generatedSites: {} });
    if (t.world.world) w.world = Object.assign({}, w.world, clone(t.world.world));
    const st = b.files['starts/start.json'];
    const [id, name, desc] = t.room;
    st.region = t.start;
    st.locations = [{ id, name, desc, connects: [] }];
    st.cast = [{ id: 'you', status: { location: id } }];
    return b;
  };

  // A zip from the creator's own export (or any zip of a world folder):
  // entries under one top folder or at the root. → { folder, files, assets: {path: bytes} }
  WE.fromZip = function (entries, fallbackFolder) {
    const list = [...entries].filter((e) => !e.name.endsWith('/'));
    const isRoot = (n) => /^(world|scenario)\.json$/.test(n);
    let prefix = '';
    if (!list.some((e) => isRoot(e.name))) {
      const top = list.find((e) => /^[^/]+\/(world|scenario)\.json$/.test(e.name));
      if (!top) throw new Error('No world.json or scenario.json in that zip.');
      prefix = top.name.split('/')[0] + '/';
    }
    const files = {}, assets = {};
    list.forEach((e) => {
      if (!e.name.startsWith(prefix)) return;
      const rel = e.name.slice(prefix.length);
      if (/\.json$/i.test(rel)) {
        try { files[rel] = JSON.parse(E.Zip.text(e.data)); } catch (err) { throw new Error(`${rel} is not valid JSON: ${err.message}`); }
      } else if (E.isImagePath(rel)) assets[rel] = e.data;
    });
    const folder = prefix ? prefix.slice(0, -1) : (files['world.json'] && files['world.json'].id) || fallbackFolder || 'world';
    return { folder, files, assets };
  };

  // ---------- starts ----------
  WE.addStart = function (files, title) {
    const w = WE.world(files);
    const id = slug(title || 'new start', w.starts || [], 'start');
    const src = Object.values(WE.starts(files))[0];
    const room = { id: slug('main room', WE.takenIds(files), 'room'), name: 'Main room', desc: '', connects: [] };
    const st = { id, title: title || 'New start', summary: '', start: clone((src && src.start) || { day: 1, hour: 8 }), cast: [], locations: [room], clocks: [], facts: [], opening: '' };
    if (src && src.region) st.region = src.region;
    else if ((w.regions || [])[0]) st.region = w.regions[0].id;
    // Someone to play: the first person in the pool, in the new room.
    const first = (w.characters || [])[0];
    if (first) { st.player = first; st.cast.push({ id: first, status: { location: room.id } }); }
    files[WE.startFile(id)] = st;
    w.starts = (w.starts || []).concat(id);
    return id;
  };
  WE.duplicateStart = function (files, from) {
    const w = WE.world(files);
    const src = files[WE.startFile(from)];
    if (!src) return null;
    const id = slug(`${from} copy`, w.starts || [], 'start');
    const st = Object.assign(clone(src), { id, title: `${src.title || from} (copy)` });
    files[WE.startFile(id)] = st;
    const at = (w.starts || []).indexOf(from);
    w.starts = (w.starts || []).slice();
    w.starts.splice(at + 1, 0, id);
    return id;
  };
  // → error text, or '' when renamed.
  WE.renameStart = function (files, from, to) {
    to = String(to || '').trim();
    const w = WE.world(files);
    if (from === to) return '';
    if (!WE.ID_RE.test(to)) return 'ids are lowercase letters, digits, - or _';
    if ((w.starts || []).includes(to)) return `there is already a start "${to}"`;
    const st = files[WE.startFile(from)];
    st.id = to;
    files[WE.startFile(to)] = st;
    delete files[WE.startFile(from)];
    w.starts = w.starts.map((x) => (x === from ? to : x));
    return '';
  };
  WE.removeStart = function (files, id) {
    const w = WE.world(files);
    // A world left with no starts gets "Make my own" (R-0).
    w.starts = (w.starts || []).filter((x) => x !== id);
    delete files[WE.startFile(id)];
    return {};
  };

  // ---------- rooms ----------
  WE.addRoom = function (files, sid, name) {
    const st = files[WE.startFile(sid)];
    const id = slug(name || 'new room', WE.takenIds(files), 'room');
    st.locations = (st.locations || []).concat([{ id, name: name || 'New room', desc: '', connects: [] }]);
    return id;
  };
  // Room functions take a start, or a list of holders ([world, start]) when
  // the world's own rooms (shared by every start) count too.
  const rooms = (st) => [].concat(...(Array.isArray(st) ? st : [st]).map((h) => (h && h.locations) || []));
  const room = (st, id) => rooms(st).find((l) => l.id === id);
  WE.roomsOf = (files, sid) => rooms([WE.world(files), files[WE.startFile(sid)]]);
  // Rooms joined to this one, from either side: [{to, kind, key}], kind null
  // for a plain connection.
  WE.connections = function (st, id) {
    const out = new Map();
    const me = room(st, id);
    if (!me) return [];
    (me.connects || []).forEach((to) => out.set(to, { to, kind: null }));
    (me.links || []).forEach((k) => out.set(k.to, { to: k.to, kind: k.kind || 'open', key: k.key }));
    rooms(st).forEach((l) => {
      if (l.id === id || out.has(l.id)) return;
      const k = (l.links || []).find((x) => x.to === id);
      if (k) out.set(l.id, { to: l.id, kind: k.kind || 'open', key: k.key });
      else if ((l.connects || []).includes(id)) out.set(l.id, { to: l.id, kind: null });
    });
    return [...out.values()].filter((c) => room(st, c.to));
  };
  // Joins two rooms both ways; kind null keeps a plain connection, a kind
  // writes a link on both sides (key: who holds a locked door's key).
  // A world room joined to a start's room is written on the start's side
  // only (either side counts), so the other starts stay valid.
  WE.connect = function (st, a, b, kind, key) {
    const ra = room(st, a), rb = room(st, b);
    if (!ra || !rb || a === b) return;
    const list = Array.isArray(st) ? st : [st];
    const home = (id) => list.findIndex((h) => ((h && h.locations) || []).some((l) => l.id === id));
    WE.disconnect(st, a, b);
    [[ra, b, a], [rb, a, b]].filter(([, other, me]) => home(me) >= home(other)).forEach(([r, other]) => {
      r.connects = (r.connects || []).filter((x) => x !== other).concat(other);
      r.links = (r.links || []).filter((k) => k.to !== other);
      if (kind) r.links.push(Object.assign({ to: other, kind }, kind === 'locked door' && key && key.length ? { key: key.slice() } : {}));
      if (!r.links.length) delete r.links;
    });
  };
  WE.disconnect = function (st, a, b) {
    [[a, b], [b, a]].forEach(([x, other]) => {
      const r = room(st, x);
      if (!r) return;
      r.connects = (r.connects || []).filter((c) => c !== other);
      if (r.links) { r.links = r.links.filter((k) => k.to !== other); if (!r.links.length) delete r.links; }
    });
  };
  // Removes a room and everything pointing at it in the start. People there
  // move to the first room left. → { error } | { notes: [text] }
  WE.removeRoom = function (files, sid, id) {
    const st = files[WE.startFile(sid)];
    if (!(st.locations || []).some((l) => l.id === id)) return { error: 'That room is shared by every start: it is kept in world.json.' };
    if (WE.roomsOf(files, sid).length <= 1) return { error: 'A start needs at least one room.' };
    const notes = [];
    st.locations = st.locations.filter((l) => l.id !== id);
    const left = WE.roomsOf(files, sid);
    const fallback = left[0].id;
    const fbName = left[0].name;
    const holders = [WE.world(files), st];
    left.forEach((l) => WE.disconnect(holders, l.id, id));
    (st.cast || []).forEach((c, i) => {
      const cid = castId(c);
      const file = WE.character(files, cid) || {};
      const own = isObj(c) && c.status && c.status.location;
      if (own === id || (!own && file.status && file.status.location === id)) {
        WE.set(st, `cast.${i}.status.location`, 'text', fallback);
        notes.push(`${file.name || cid} now starts in ${fbName}`);
      }
    });
    if (st.playerSlot && st.playerSlot.location === id) st.playerSlot.location = fallback;
    (st.extras || []).forEach((x) => { if (x.location === id) { x.location = null; notes.push(`${x.name || x.id} is now nowhere in particular`); } });
    if (st.standees) {
      const before = st.standees.length;
      st.standees = st.standees.filter((g) => g.location !== id);
      if (st.standees.length < before) notes.push(`${before - st.standees.length} group(s) in that room were removed`);
      st.standees.forEach((g) => {
        if (g.post === id) delete g.post;
        if (Array.isArray(g.patrol) && g.patrol.includes(id)) {
          g.patrol = g.patrol.filter((r) => r !== id);
          if (g.patrol.length < 2) delete g.patrol;
        }
      });
    }
    if (st.entrances) st.entrances = st.entrances.filter((e) => e.room !== id);
    if (st.localMap && st.localMap.rooms) delete st.localMap.rooms[id];
    // The world's map and world-level people only lose the room when no
    // other start (or the world) still has one by that id.
    const w = WE.world(files);
    const elsewhere = [w, ...Object.values(WE.starts(files))].some((s) => (s.locations || []).some((l) => l.id === id));
    if (!elsewhere) {
      if (w.map && w.map.locations) delete w.map.locations[id];
      (w.extras || []).forEach((x) => { if (x.location === id) x.location = null; });
      if (w.standees) w.standees = w.standees.filter((g) => g.location !== id);
    }
    return { notes };
  };

  // ---------- the cast ----------
  WE.addToCast = function (files, sid, id, location) {
    const st = files[WE.startFile(sid)];
    if (WE.castIds(st).includes(id)) return;
    const file = WE.character(files, id) || {};
    const locIds = WE.roomsOf(files, sid).map((l) => l.id);
    const where = file.status && locIds.includes(file.status.location) ? null : location || locIds[0];
    st.cast = (st.cast || []).concat([where ? { id, status: { location: where } } : id]);
    if (!st.player && !st.playerSlot) st.player = id;
  };
  WE.removeFromCast = function (files, sid, id) {
    const st = files[WE.startFile(sid)];
    const notes = [];
    st.cast = (st.cast || []).filter((c) => castId(c) !== id);
    st.cast.forEach((c, i) => { if (isObj(c) && c.relations && id in c.relations) { WE.set(st, `cast.${i}.relations.${id}`, 'text', ''); WE.tidyCastEntry(files, sid, i); } });
    (st.locations || []).forEach((l) => (l.links || []).forEach((k) => {
      if (Array.isArray(k.key)) { k.key = k.key.filter((x) => x !== id); if (!k.key.length) delete k.key; }
    }));
    if (st.player === id) {
      delete st.player;
      const next = WE.castIds(st)[0];
      if (next && !st.playerSlot) { st.player = next; notes.push(`${(WE.character(files, next) || {}).name || next} is the player now`); }
      else if (!st.playerSlot) notes.push('Nobody is the player now: add someone, or let players make their own');
    }
    return notes;
  };
  // A cast override that says what the character file already says is
  // dropped, and an entry with nothing left is the plain id again.
  WE.tidyCastEntry = function (files, sid, i) {
    const st = files[WE.startFile(sid)];
    const c = st.cast && st.cast[i];
    if (!isObj(c)) return;
    const file = WE.character(files, c.id) || {};
    if (c.status && file.status && c.status.location === file.status.location) delete c.status.location;
    Object.keys(c.relations || {}).forEach((k) => { if (file.relations && file.relations[k] === c.relations[k]) delete c.relations[k]; });
    Object.keys(c.needs || {}).forEach((k) => { if (file.needs && file.needs[k] === c.needs[k]) delete c.needs[k]; });
    ['status', 'relations', 'needs'].forEach((k) => { if (isObj(c[k]) && !Object.keys(c[k]).length) delete c[k]; });
    if (Object.keys(c).length === 1) st.cast[i] = c.id;
  };
  // A minimal person for the pool (the full editor is task 6-2). → id
  WE.newPerson = function (files, p) {
    const w = WE.world(files);
    const name = String((p && p.name) || '').trim() || 'New person';
    const id = slug(name, WE.takenIds(files), 'person');
    files[`characters/${id}.json`] = {
      id, name, pronouns: String((p && p.pronouns) || '').trim() || 'they/them', role: String((p && p.role) || '').trim() || 'local',
      traits: [], want: '', guard: 'medium', skills: {},
    };
    w.characters = (w.characters || []).concat(id);
    return id;
  };
  // The player makes their own character: a slot that loads as it is.
  WE.ensureSlot = function (files, sid) {
    const st = files[WE.startFile(sid)];
    if (!st.playerSlot) st.playerSlot = { location: ((st.locations || [])[0] || {}).id, freeform: true, roles: [], skillPoints: 10, maxSkill: 3 };
    return st.playerSlot;
  };

  // ---------- the world's people (task 6-2) ----------
  // Every place a character id is used, outside its own file: the pool,
  // casts and players, feelings (files, cast entries, player slots), keys to
  // locked doors, timeline "who" and conditions, and lore about them.
  const loreAll = (files) => [].concat(
    ...eachStartAndWorld(files).map((s) => (Array.isArray(s.lore) ? s.lore : [])),
    ...Object.entries(files).filter(([p]) => /^lore\/[^/]+\.json$/.test(p)).map(([, d]) => (Array.isArray(d) ? d : [d])),
  ).filter(isObj);
  const conditionsOf = (p) => (!isObj(p) ? [] : p.not ? [p].concat(conditionsOf(p.not)) : [p]);
  // fn(id) → the new id, or null to drop the reference.
  function eachCharacterRef(files, fn, notes) {
    const w = WE.world(files);
    const keys = (o) => {
      if (!isObj(o)) return;
      Object.keys(o).forEach((k) => { const v = fn(k); if (v === k) return; const val = o[k]; delete o[k]; if (v) o[v] = val; });
    };
    w.characters = (w.characters || []).map(fn).filter(Boolean);
    Object.keys(files).filter((p) => p.startsWith('characters/')).forEach((p) => keys(files[p] && files[p].relations));
    Object.values(WE.starts(files)).forEach((st) => {
      (st.cast || []).forEach((c) => { if (isObj(c)) { c.id = fn(c.id) || c.id; keys(c.relations); } });
      st.cast = (st.cast || []).map((c) => (typeof c === 'string' ? fn(c) : c)).filter(Boolean);
      if (st.player) st.player = fn(st.player) || st.player;
      if (st.playerSlot) { keys(st.playerSlot.relationsDefault); keys(st.playerSlot.castFeelings); }
    });
    eachStartAndWorld(files).forEach((s) => (s.locations || []).forEach((l) => (l.links || []).forEach((k) => {
      if (Array.isArray(k.key)) { k.key = k.key.map(fn).filter(Boolean); if (!k.key.length) delete k.key; }
    })));
    events(files).forEach((ev) => {
      if (Array.isArray(ev.who)) { ev.who = ev.who.map(fn).filter(Boolean); if (!ev.who.length) delete ev.who; }
      if (!ev.preconditions) return;
      const kept = ev.preconditions.filter((p) => conditionsOf(p).every((q) => {
        if (q.alive != null && !fn(q.alive)) return false;
        if (q.known != null && q.by != null && !fn(q.by)) return false;
        if (q.alive != null) q.alive = fn(q.alive);
        if (q.by != null) q.by = fn(q.by);
        return true;
      }));
      if (kept.length < ev.preconditions.length && notes) notes.push(`timeline "${ev.id}" lost a condition about them`);
      ev.preconditions = kept;
      if (!kept.length) delete ev.preconditions;
    });
    loreAll(files).forEach((e) => {
      if (e.level !== 'character' || !e.ref) return;
      const v = fn(e.ref);
      if (v) e.ref = v;
      else { e.level = 'topic'; delete e.ref; if (notes) notes.push(`lore "${e.id}" is now a topic (it only comes up by its keywords)`); }
    });
  }
  // → error text, or '' when renamed.
  WE.renameCharacter = function (files, from, to) {
    to = String(to || '').trim();
    if (from === to) return '';
    if (!WE.ID_RE.test(to)) return 'ids are lowercase letters, digits, - or _';
    if (WE.takenIds(files).includes(to)) return `"${to}" is already used by someone or somewhere`;
    const file = files[`characters/${from}.json`];
    if (!file) return `no character "${from}"`;
    file.id = to;
    files[`characters/${to}.json`] = file;
    delete files[`characters/${from}.json`];
    eachCharacterRef(files, (x) => (x === from ? to : x));
    return '';
  };
  // Takes someone out of the world: every start's cast (the player part
  // passes on), feelings, keys, the timeline and lore. → notes for the page
  WE.removeCharacter = function (files, id) {
    const notes = [];
    Object.keys(WE.starts(files)).forEach((sid) => {
      if (WE.castIds(files[WE.startFile(sid)]).includes(id)) notes.push(...WE.removeFromCast(files, sid, id).map((n) => `start "${sid}": ${n}`));
    });
    eachCharacterRef(files, (x) => (x === id ? null : x), notes);
    delete files[`characters/${id}.json`];
    return notes;
  };
  // The starts someone is in.
  WE.startsWith = (files, id) => Object.entries(WE.starts(files)).filter(([, st]) => WE.castIds(st).includes(id)).map(([sid]) => sid);
  // A free path under portraits/ for an image file name.
  WE.portraitPath = function (files, assets, name, base) {
    const ext = (String(name).match(/\.(png|jpe?g|webp|gif|svg)$/i) || [, 'png'])[1].toLowerCase();
    const stem = slug(base || String(name).replace(/\.[^.]+$/, ''), [], 'portrait');
    const used = new Set(Object.keys(assets || {}).concat(WE.world(files).portraitSet || []));
    Object.keys(files).forEach((p) => { if (p.startsWith('characters/') && files[p] && typeof files[p].portrait === 'string') used.add(files[p].portrait); });
    let path = `portraits/${stem}.${ext}`;
    for (let i = 2; used.has(path); i++) path = `portraits/${stem}-${i}.${ext}`;
    return path;
  };

  // ---------- groups ----------
  const eachStartAndWorld = (files) => [WE.world(files), ...Object.values(WE.starts(files))];
  const events = (files) => eachStartAndWorld(files).flatMap((s) => (Array.isArray(s.timeline) ? s.timeline : [])).filter(isObj);
  const controlsOf = (p) => (!isObj(p) ? [] : p.controls ? [p.controls] : p.not ? controlsOf(p.not) : []);
  WE.addGroup = function (files, name) {
    const w = WE.world(files);
    const id = slug(name || 'new group', (w.factions || []).map((f) => f.id), 'group');
    w.factions = (w.factions || []).concat([{ id, name: name || 'New group', desc: 'Who they are and what they want.', stance: 'neutral' }]);
    return id;
  };
  WE.renameGroup = function (files, from, to) {
    to = String(to || '').trim();
    const w = WE.world(files);
    if (from === to) return '';
    if (!WE.ID_RE.test(to)) return 'ids are lowercase letters, digits, - or _';
    if ((w.factions || []).some((f) => f.id === to)) return `there is already a group "${to}"`;
    const map = (x) => (x === from ? to : x);
    eachStartAndWorld(files).forEach((s) => {
      (s.factions || []).forEach((f) => (f.id = map(f.id)));
      (s.regions || []).forEach((r) => { if (r.controller === from) r.controller = to; });
      (s.standees || []).forEach((g) => { if (g.faction === from) g.faction = to; });
      // Presence (R-5) is keyed by group.
      if (s.presence && s.presence[from]) { s.presence[to] = s.presence[from]; delete s.presence[from]; }
    });
    events(files).forEach((ev) => {
      (ev.preconditions || []).flatMap(controlsOf).forEach((c) => { if (c.group === from) c.group = to; });
      const fx = ev.effects || {};
      (fx.groups || []).forEach((g) => { if (g && g.id === from) g.id = to; });
      (fx.control || []).forEach((c) => { if (c && c.to === from) c.to = to; });
      (fx.presence || []).forEach((p) => { if (p && p.group === from) p.group = to; });
    });
    return '';
  };
  WE.removeGroup = function (files, id) {
    const notes = [];
    eachStartAndWorld(files).forEach((s) => {
      if (s.factions) s.factions = s.factions.filter((f) => f.id !== id);
      (s.regions || []).forEach((r) => { if (r.controller === id) { r.controller = null; notes.push(`${r.name || r.id} is held by no one now`); } });
      (s.standees || []).forEach((g) => { if (g.faction === id) delete g.faction; });
      if (s.presence && s.presence[id]) { delete s.presence[id]; notes.push(`${id} is present nowhere now`); if (!Object.keys(s.presence).length) delete s.presence; }
    });
    events(files).forEach((ev) => {
      if (ev.preconditions) {
        const before = ev.preconditions.length;
        ev.preconditions = ev.preconditions.filter((p) => !controlsOf(p).some((c) => c.group === id));
        if (ev.preconditions.length < before) notes.push(`timeline "${ev.id}" lost a condition about ${id}`);
        if (!ev.preconditions.length) delete ev.preconditions;
      }
      const fx = ev.effects;
      if (fx) {
        if (fx.groups) { fx.groups = fx.groups.filter((g) => !g || g.id !== id); if (!fx.groups.length) delete fx.groups; }
        if (fx.control) { fx.control = fx.control.filter((c) => !c || c.to !== id); if (!fx.control.length) delete fx.control; }
        if (fx.presence) { fx.presence = fx.presence.filter((p) => !p || p.group !== id); if (!fx.presence.length) delete fx.presence; }
        if (!Object.keys(fx).length) delete ev.effects;
      }
    });
    return notes;
  };

  // ---------- needs ----------
  // Need ids appear in thresholds, pressure lists, penalties, cast entries,
  // player slots and character files: all follow a rename or a removal.
  function eachNeedRef(files, fn) {
    const w = WE.world(files);
    const fixKeys = (o) => {
      if (!isObj(o)) return;
      Object.keys(o).forEach((k) => {
        const v = fn(k);
        if (v === k) return;
        const val = o[k];
        delete o[k];
        if (v) o[v] = val;
      });
    };
    eachStartAndWorld(files).forEach((s) => {
      fixKeys(s.tagThresholds);
      if (Array.isArray(s.revealPressure)) s.revealPressure = s.revealPressure.map(fn).filter(Boolean);
      if (s.skillPenalties && Array.isArray(s.skillPenalties.needs)) s.skillPenalties.needs = s.skillPenalties.needs.filter((n) => !n || fn(n.need)).map((n) => (n ? Object.assign(n, { need: fn(n.need) }) : n));
      (s.cast || []).forEach((c) => { if (isObj(c)) fixKeys(c.needs); });
      if (s.playerSlot) fixKeys(s.playerSlot.needs);
    });
    (w.characters || []).forEach((id) => { const c = WE.character(files, id); if (c) fixKeys(c.needs); });
  }
  WE.addNeed = function (files, label) {
    const w = WE.world(files);
    const id = slug(label || 'need', (w.needs || []).map((n) => n.id), 'need');
    w.needs = (w.needs || []).concat([{ id, label: label || 'New need', perHour: 0.02 }]);
    return id;
  };
  WE.renameNeed = function (files, from, to) {
    to = String(to || '').trim();
    const w = WE.world(files);
    if (from === to) return '';
    if (!WE.ID_RE.test(to)) return 'ids are lowercase letters, digits, - or _';
    if ((w.needs || []).some((n) => n.id === to)) return `there is already a need "${to}"`;
    (w.needs || []).forEach((n) => { if (n.id === from) n.id = to; });
    eachNeedRef(files, (k) => (k === from ? to : k));
    return '';
  };
  WE.removeNeed = function (files, id) {
    const w = WE.world(files);
    w.needs = (w.needs || []).filter((n) => n.id !== id);
    eachNeedRef(files, (k) => (k === id ? null : k));
  };

  // ---------- event seeds and clocks ----------
  // A seed is text or {text, region}: picking a region turns it into the
  // object, and picking none back into text.
  WE.setSeedRegion = function (world, tier, i, region) {
    const list = world.eventSeeds && world.eventSeeds[tier];
    if (!Array.isArray(list) || list[i] == null) return;
    const text = isObj(list[i]) ? list[i].text : list[i];
    list[i] = region ? { text, region } : text;
  };
  WE.seedPath = (world, tier, i) => `eventSeeds.${tier}.${i}${isObj(world.eventSeeds[tier][i]) ? '.text' : ''}`;
  WE.newClock = (files, name) => ({ id: slug(name || 'pressure', WE.clockIds(files), 'pressure'), name: name || 'New pressure', value: 0, max: 10, perHour: 0.2 });
  WE.uniqueId = (files, base) => slug(base, WE.takenIds(files), 'id');

  // ---------- test play ----------
  // What the creator sends the game tab: the files as they are now, the
  // images the creator holds (Blobs survive postMessage), and the start.
  WE.TEST_READY = 'ensemble-testplay-ready';
  WE.TEST_WORLD = 'ensemble-testplay';
  WE.testPlayPayload = function (folder, files, assets, startId) {
    return { type: WE.TEST_WORLD, folder, files: clone(files), assets: Object.assign({}, assets || {}), startId: startId || null };
  };
})(typeof window !== 'undefined' ? window : globalThis);
