// The local map as floor plans (task 3-7): walls, openings, floors and
// furniture chosen by an inferred room kind, drawn only where the player is
// looking. Rooms in view get full detail, remembered rooms structure only (no
// feature state), unknown rooms nothing but a "?" just past each opening that
// leads into one. Every room is laid out (Layouts.plan) and only some drawn,
// so nothing moves as more are found. Deterministic: everything comes from the
// room data and a seed, nothing is saved. DOM-free; it never reads the game
// state: ui.js builds its inputs, so the knowledge rule stays in one place.
// Decoration (chairs, rocks) is visual only and never reaches the engine;
// only features from the data are gameplay pieces.
(function (root) {
  const E = root.Ensemble;
  const SD = (E.SiteDraw = {});
  const esc = E.esc;
  const CELL = (SD.CELL = 30);
  // Sizes below are in grid cells: padding from the walls, and the strip at
  // the bottom of each room kept clear for its label.
  const PAD = 0.25, STRIP = 0.45;
  const n1 = (v) => Math.round(v * 10) / 10;
  const px = (v) => n1(v * CELL);
  const featName = (f) => (typeof f === 'string' ? f : (f && f.name) || '');

  // Room kinds from words in the id, name and feature names; first match wins.
  SD.KINDS = [
    ['alley', (l, t) => l.outside && /\balley/.test(t)],
    ['street', (l, t) => l.outside && /\b(street|road|lot|parking|plaza|square|car park)/.test(t)],
    ['outdoor', (l) => !!l.outside],
    ['galley', /\b(commons|galley|mess|kitchen|canteen|cafeteria|diner)/],
    ['bar', /\b(bar|tavern|pub|saloon|lounge)\b/],
    ['ops', /\b(ops|comms?|console|bridge|control room)\b/],
    ['med', /\b(med|medical|infirmary|clinic|sickbay|cots?|scanner|surgery)\b/],
    ['lab', /\b(lab|laboratory|glovebox|incubators?)\b/],
    ['hydro', /\b(hydro\w*|grow|greenhouse|garden)/],
    ['quarters', /\b(quarters|bunks?|dorm\w*|barracks)\b/],
    ['suits', /\b(suit\w*|lockers?|eva)\b/],
    ['garage', /\b(garage|rover|vehicles?|hangar|motor pool)\b/],
    ['cell', /\b(cells?|jail|brig|holding|lockup)\b/],
    ['armory', /\b(armou?ry|weapons?|guns?|ammo)\b/],
    ['server', /\b(servers?|data cent(er|re)|mainframe)\b/],
    ['office', /\b(office|desk|study|records)\b/],
    ['store', /\b(store|shop|sales|aisles?|pharmacy|checkout)\b/],
    ['warehouse', /\b(warehouse|stockroom|storage|storeroom|shelving|dock|loading|forklift|crates)\b/],
    ['apartment', /\b(apartment|flat|bedroom|living room|loft)\b/],
  ];
  SD.kindOf = function (l) {
    const text = [l.id, l.name, ...(l.features || []).map(featName)].join(' ').toLowerCase();
    for (const [k, test] of SD.KINDS) if (typeof test === 'function' ? test(l, text) : test.test(text)) return k;
    return 'generic';
  };
  SD.FLOOR = {
    galley: 'tile', ops: 'plate', med: 'clean', lab: 'clean', hydro: 'grate', quarters: 'plain', suits: 'diamond', garage: 'diamond',
    bar: 'plain', office: 'plain', store: 'tile', warehouse: 'plate', cell: 'plate', armory: 'diamond', server: 'clean', apartment: 'plain',
    generic: 'plain', outdoor: 'ground', street: 'ground', alley: 'ground',
  };

  // Seeded 0..1 stream, so scatter is the same on every redraw.
  function rng(seed) {
    let s = E.hash(seed) || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
  }
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  // "two cots" → 2
  SD.countIn = (s) => WORDS[(String(s || '').toLowerCase().match(/\b(one|two|three|four|five|six)\b/) || [])[1]] || parseInt(String(s || ''), 10) || null;

  // ---------- furniture templates ----------
  // Each takes the room's free rect (in cells, label strip removed) and its
  // data, and returns pieces {sym, x, y, w, h, rot?, feature?, decor?, back?}.
  // A piece with a feature is gameplay; decor is set dressing. find() claims
  // a feature so it is drawn once.
  const T = {
    galley(r, find) {
      const tw = Math.min(r.w * 0.55, 3.7), th = 0.73, tx = r.x + (r.w - tw) / 2, ty = r.y + r.h / 2 - th / 2 + 0.2;
      const out = [piece('table', tx, ty, tw, th, find(/table/))];
      const n = Math.floor(tw / 0.73);
      for (let i = 0; i < n; i++) {
        const cx = tx + (i + 0.5) * (tw / n) - 0.2;
        out.push({ sym: 'chair', x: cx, y: ty - 0.47, w: 0.4, h: 0.4, decor: true }, { sym: 'chair', x: cx, y: ty + th + 0.07, w: 0.4, h: 0.4, decor: true });
      }
      out.push(piece('counter', r.x + PAD, r.y + PAD, Math.min(2.33, r.w * 0.4), 0.4, find(/counter|stove|oven|fridge/)));
      return out;
    },
    ops(r, find) {
      const out = [];
      const n = Math.max(2, Math.floor((r.w - 2 * PAD) / 1.33));
      const cw = (r.w - 2 * PAD - (n - 1) * 0.2) / n;
      const comm = find(/comm|console|terminal|radio/);
      for (let i = 0; i < n; i++) {
        const x = r.x + PAD + i * (cw + 0.2);
        out.push(i === 0 ? piece('console', x, r.y + PAD, cw, 0.53, comm) : { sym: 'console', x, y: r.y + PAD, w: cw, h: 0.53, decor: true });
        out.push({ sym: 'chair', x: x + cw / 2 - 0.2, y: r.y + PAD + 0.67, w: 0.4, h: 0.4, decor: true });
      }
      out.push(piece('board', r.x + r.w - PAD - 0.17, r.y + r.h * 0.45, 0.17, r.h * 0.45 - PAD, find(/board|screen|monitor/)));
      return out;
    },
    med(r, find, l) {
      const cots = find(/cot|bed/);
      const n = Math.max(1, Math.min(SD.countIn(cots && cots.name) || 2, Math.floor((r.w - 2 * PAD - 0.7) / 0.57)));
      const out = [];
      for (let i = 0; i < n; i++) out.push(i === 0 ? piece('cot', r.x + PAD, r.y + PAD, 0.47, 1, cots) : { sym: 'cot', x: r.x + PAD + i * 0.57, y: r.y + PAD, w: 0.47, h: 1, decor: true });
      out.push(piece('scanner', r.x + r.w - PAD - 0.63, r.y + PAD, 0.63, 1, find(/scanner/)));
      const cab = find(/cabinet|medicine|drugs?\b/);
      if (cab) out.push(piece('cabinet', r.x + PAD + n * 0.57 + 0.07, r.y + PAD, 0.6, 0.3, cab));
      return out;
    },
    lab(r, find) {
      const out = [piece('rack', r.x + PAD, r.y + PAD, r.w - 2 * PAD, 0.33, find(/rack|shel/))];
      out.push(piece('glovebox', r.x + r.w / 2 - 0.6, r.y + r.h / 2 - 0.2, 1.2, 0.73, find(/glovebox|bench|hood/)));
      const inc = find(/incubator|freezer|fridge/);
      for (let i = 0; i < 3; i++) out.push(i === 0 ? piece('incubator', r.x + PAD, r.y + r.h - PAD - 0.47, 0.47, 0.47, inc) : { sym: 'incubator', x: r.x + PAD + i * 0.57, y: r.y + r.h - PAD - 0.47, w: 0.47, h: 0.47, decor: true });
      return out;
    },
    hydro(r, find) {
      const racks = find(/rack|grow|bed|plant/);
      const rows = Math.max(1, Math.floor((r.h - 2 * PAD + 0.33) / 0.73));
      const out = [];
      for (let i = 0; i < rows; i++) out.push(i === 0 ? piece('grow', r.x + PAD, r.y + PAD, r.w - 2 * PAD - 0.6, 0.37, racks) : { sym: 'grow', x: r.x + PAD, y: r.y + PAD + i * 0.73, w: r.w - 2 * PAD - 0.6, h: 0.37, decor: true });
      out.push({ sym: 'tank', x: r.x + r.w - PAD - 0.47, y: r.y + r.h - PAD - 0.73, w: 0.47, h: 0.73, decor: true });
      return out;
    },
    quarters(r, find) {
      const bunks = find(/bunk|bed|cot/);
      const per = Math.floor((r.w - 2 * PAD + 0.2) / 0.73);
      const ys = r.h >= 2.3 ? [r.y + PAD, r.y + r.h - PAD - 1] : [r.y + PAD];
      const out = [];
      let k = 0;
      ys.forEach((y, row) => {
        for (let i = 0; i < per && k < 5; i++, k++) {
          const p = { sym: 'bunk', x: r.x + PAD + i * 0.73, y, w: 0.53, h: 1, rot: row ? 180 : 0 };
          out.push(k === 0 ? Object.assign(p, bunks ? { feature: bunks } : { decor: true }) : Object.assign(p, { decor: true }));
        }
      });
      return out;
    },
    suits(r, find) {
      const lockers = find(/locker/);
      const n = Math.max(1, Math.min(Math.floor((r.w - 2 * PAD) / 0.5) - 2, 5));
      const out = [];
      for (let i = 0; i < n; i++) out.push(i === 0 ? piece('locker', r.x + PAD, r.y + PAD, 0.4, 0.5, lockers) : { sym: 'locker', x: r.x + PAD + i * 0.5, y: r.y + PAD, w: 0.4, h: 0.5, decor: true });
      const al = find(/airlock/);
      if (al) out.push(piece('airlock', r.x + r.w - PAD - 0.8, r.y + r.h - PAD - 0.54, 0.8, 0.67, al));
      return out;
    },
    garage(r, find) {
      const out = [piece('rover', r.x + r.w / 2 - 1.13, r.y + r.h / 2 - 0.67, 2.27, 1.33, find(/\b(mule|rover|truck|car|van|jeep|buggy|bike)\b/))];
      out.push(piece('toolbench', r.x + PAD, r.y + PAD, 1.33, 0.33, find(/bench|tools?\b/)));
      const big = find(/vehicle airlock|bay door|garage door|shutter/);
      if (big) out.push(piece('bigdoor', r.x + r.w - PAD - 0.27, r.y + r.h / 2 - 0.73, 0.27, 1.47, big));
      return out;
    },
    bar(r, find) {
      const bw = Math.min(r.w - 2 * PAD, 3.3);
      const out = [piece('counter', r.x + PAD, r.y + PAD, bw, 0.4, find(/\bbar\b|counter/))];
      for (let i = 0; i < Math.floor(bw / 0.6); i++) out.push({ sym: 'stool', x: r.x + PAD + 0.1 + i * 0.6, y: r.y + PAD + 0.5, w: 0.3, h: 0.3, decor: true });
      const tables = Math.floor((r.w - 2 * PAD) / 1.4);
      for (let i = 0; i < Math.min(tables, 3); i++) out.push({ sym: 'round', x: r.x + PAD + 0.2 + i * 1.4, y: r.y + r.h - PAD - 0.7, w: 0.7, h: 0.7, decor: true });
      return out;
    },
    office(r, find) {
      return [
        piece('desk', r.x + r.w / 2 - 0.6, r.y + r.h / 2 - 0.4, 1.2, 0.55, find(/desk|table/)),
        { sym: 'chair', x: r.x + r.w / 2 - 0.2, y: r.y + r.h / 2 + 0.2, w: 0.4, h: 0.4, decor: true },
        piece('cabinet', r.x + r.w - PAD - 0.6, r.y + PAD, 0.6, 0.3, find(/cabinet|files?\b|filing|safe/)),
      ];
    },
    store(r, find) {
      const out = [];
      const aisles = find(/aisle|shel|rack/);
      const rows = Math.max(1, Math.floor((r.h - 2 * PAD - 0.6) / 0.8));
      for (let i = 0; i < rows; i++) out.push(i === 0 ? piece('shelf', r.x + PAD + 0.5, r.y + PAD + i * 0.8, r.w - 2 * PAD - 1.4, 0.3, aisles) : { sym: 'shelf', x: r.x + PAD + 0.5, y: r.y + PAD + i * 0.8, w: r.w - 2 * PAD - 1.4, h: 0.3, decor: true });
      out.push(piece('counter', r.x + r.w - PAD - 0.5, r.y + r.h - PAD - 1.1, 0.4, 1.1, find(/counter|register|checkout/)));
      return out;
    },
    warehouse(r, find) {
      const out = [piece('shelf', r.x + PAD, r.y + PAD, r.w - 2 * PAD, 0.33, find(/shel|rack/))];
      const pile = find(/crates?|pallets?|boxes|pile|supplies|stock/);
      out.push(piece('crate', r.x + r.w - PAD - 0.55, r.y + r.h - PAD - 0.55, 0.55, 0.55, pile));
      out.push({ sym: 'crate', x: r.x + r.w - PAD - 1.15, y: r.y + r.h - PAD - 0.5, w: 0.5, h: 0.5, decor: true });
      return out;
    },
    cell(r, find) {
      return [
        piece('cot', r.x + PAD, r.y + PAD, 0.47, 1, find(/bed|cot|bunk/)),
        { sym: 'toilet', x: r.x + r.w - PAD - 0.35, y: r.y + PAD, w: 0.35, h: 0.45, decor: true },
      ];
    },
    armory(r, find) {
      const racks = find(/rack|weapon|gun|locker/);
      const n = Math.max(1, Math.min(4, Math.floor((r.w - 2 * PAD) / 0.8)));
      const out = [];
      for (let i = 0; i < n; i++) out.push(i === 0 ? piece('gunrack', r.x + PAD + i * 0.8, r.y + PAD, 0.7, 0.3, racks) : { sym: 'gunrack', x: r.x + PAD + i * 0.8, y: r.y + PAD, w: 0.7, h: 0.3, decor: true });
      out.push({ sym: 'crate', x: r.x + PAD, y: r.y + r.h - PAD - 0.5, w: 0.5, h: 0.5, decor: true });
      return out;
    },
    server(r, find) {
      const racks = find(/server|rack/);
      const rows = Math.max(1, Math.floor((r.h - 2 * PAD) / 0.8));
      const out = [];
      for (let i = 0; i < rows; i++) out.push(i === 0 ? piece('rack', r.x + PAD, r.y + PAD + i * 0.8, r.w - 2 * PAD - 0.6, 0.35, racks) : { sym: 'rack', x: r.x + PAD, y: r.y + PAD + i * 0.8, w: r.w - 2 * PAD - 0.6, h: 0.35, decor: true });
      return out;
    },
    apartment(r, find) {
      return [
        piece('bed', r.x + PAD, r.y + PAD, 0.8, 1.1, find(/bed|mattress/)),
        piece('sofa', r.x + r.w - PAD - 1.2, r.y + r.h - PAD - 0.45, 1.2, 0.45, find(/sofa|couch/)),
        { sym: 'round', x: r.x + r.w / 2 - 0.3, y: r.y + PAD + 0.2, w: 0.6, h: 0.6, decor: true },
      ];
    },
    outdoor(r, find, l, rand) {
      const out = [];
      const solar = find(/solar/);
      if (solar) {
        const cols = Math.max(1, Math.min(4, Math.floor((r.w * 0.6) / 0.8)));
        for (let row = 0; row < 3; row++) for (let i = 0; i < cols; i++) {
          out.push(row === 0 && i === 0 ? piece('panel', r.x + PAD, r.y + PAD, 0.67, 0.4, solar) : { sym: 'panel', x: r.x + PAD + i * 0.8, y: r.y + PAD + row * 0.6, w: 0.67, h: 0.4, decor: true });
        }
      }
      const rig = find(/drill|rig\b|derrick|antenna|mast/);
      if (rig) out.push(piece('rig', r.x + r.w - PAD - 0.93, r.y + r.h - PAD - 0.93, 0.93, 0.93, rig));
      return out.concat(scatter(r, rand, 'rock', 0.6));
    },
    street(r, find, l, rand) {
      const car = find(/\b(cars?|pickup|truck|van|vehicles?|bus)\b/);
      const n = Math.max(1, Math.min(SD.countIn(car && car.name) || (car && /s\b/.test(car.name) ? 2 : 1), Math.floor((r.w - 2 * PAD) / 1.5)));
      const out = [];
      for (let i = 0; i < n; i++) out.push(i === 0 ? piece('car', r.x + PAD + 0.2, r.y + PAD + 0.2, 1.2, 0.67, car) : { sym: 'car', x: r.x + PAD + 0.2 + i * 1.5, y: r.y + PAD + 0.2, w: 1.2, h: 0.67, decor: true });
      return out.concat(scatter(r, rand, 'debris', 0.3));
    },
    alley(r, find, l, rand) {
      const bin = find(/dumpster|bins?\b|trash/);
      return [piece('dumpster', r.x + PAD, r.y + PAD, 1, 0.55, bin)].concat(scatter(r, rand, 'debris', 0.5));
    },
    generic() { return []; },
  };
  // A piece that is the feature when there is one, decoration otherwise.
  function piece(sym, x, y, w, h, feature) { return feature ? { sym, x, y, w, h, feature } : { sym, x, y, w, h, decor: true }; }
  function scatter(r, rand, sym, density) {
    const out = [];
    const n = Math.round(r.w * r.h * density);
    for (let i = 0; i < n; i++) {
      const s = 0.1 + rand() * 0.2;
      out.push({ sym, x: r.x + 0.13 + rand() * (r.w - 0.4), y: r.y + 0.13 + rand() * (r.h - 0.4), w: s, h: s, rot: Math.floor(rand() * 360), decor: true, back: true });
    }
    return out;
  }

  // What a feature no template knows looks like, from its name.
  const GUESS = [
    [/ladder|stairs/, 'ladder', 0.35, 0.7], [/hatch|vent|duct|grate|skylight|trapdoor|door/, 'hatch', 0.5, 0.5],
    [/\b(cars?|pickup|truck|van|vehicles?|trailer|rover|bike|forklift|bus)\b/, 'car', 1.2, 0.67],
    [/generator|engine|pump|boiler|furnace|machine|reactor/, 'machine', 0.6, 0.6],
    [/desk|table|bench|counter/, 'table', 0.9, 0.45], [/shel|rack|aisle/, 'shelf', 1.2, 0.3],
    [/\b(beds?|cots?|bunks?|bedrolls?|mattress\w*|sleeping)\b/, 'cot', 0.47, 1],
    [/console|terminal|computer|screen|monitor|camera|phone|landline|radio|panel|board|window|view/, 'panel', 0.5, 0.35],
    [/plant|tree|garden|flowers/, 'plant', 0.45, 0.45],
  ];
  SD.guess = function (name) {
    const t = String(name).toLowerCase();
    const g = GUESS.find(([re]) => re.test(t));
    return g ? { sym: g[1], w: g[2], h: g[3] } : { sym: 'crate', w: 0.5, h: 0.5 };
  };
  // A free spot for a w×h piece: nearest a wall first, then top to bottom,
  // left to right; never on another piece. Null when the room is full.
  function freeSpot(r, pieces, w, h) {
    const hit = (x, y) => pieces.some((p) => !p.back && x < p.x + p.w + 0.08 && p.x < x + w + 0.08 && y < p.y + p.h + 0.08 && p.y < y + h + 0.08);
    let best = null;
    for (let y = r.y + PAD; y + h <= r.y + r.h - PAD + 1e-9; y += 0.25) {
      for (let x = r.x + PAD; x + w <= r.x + r.w - PAD + 1e-9; x += 0.25) {
        const d = Math.min(x - r.x, y - r.y, r.x + r.w - x - w, r.y + r.h - y - h);
        if ((!best || d < best.d - 1e-9) && !hit(x, y)) best = { x, y, d };
      }
    }
    return best;
  }
  // Every feature gets a piece: the template's, else a guessed one in a free
  // spot (dropping decoration to make room, else on top of what's there).
  function placeExtra(r, pieces, f, i) {
    const g = SD.guess(f.name);
    for (;;) {
      const s = freeSpot(r, pieces, g.w, g.h);
      if (s) return { sym: g.sym, x: s.x, y: s.y, w: g.w, h: g.h, feature: f };
      const t = freeSpot(r, pieces, 0.45, 0.45);
      if (t) return { sym: g.sym, x: t.x, y: t.y, w: 0.45, h: 0.45, feature: f };
      const k = pieces.map((p) => !!p.decor && !p.back).lastIndexOf(true);
      if (k < 0) break;
      pieces.splice(k, 1);
    }
    return { sym: g.sym, x: r.x + PAD + (i % 4) * 0.5, y: r.y + PAD, w: 0.45, h: 0.45, feature: f };
  }
  // The room's pieces: its template, then the features nobody placed. Ways
  // out claimed by an opening (claimed) are skipped.
  SD.furnish = function (rect, l, seed, claimed) {
    const r = { x: rect.x, y: rect.y, w: rect.w, h: Math.max(0.6, rect.h - STRIP) };
    const feats = (l.features || []).map((f) => (typeof f === 'string' ? { name: f, state: null } : f)).filter((f) => !(claimed || new Set()).has(f.name));
    const taken = new Set();
    const find = (re) => { const f = feats.find((x) => !taken.has(x) && re.test(x.name.toLowerCase())); if (f) taken.add(f); return f || null; };
    const kind = SD.kindOf(l);
    const pieces = (T[kind] || T.generic)(r, find, l, rng(`${seed}:${l.id}`));
    feats.filter((f) => !taken.has(f)).forEach((f, i) => pieces.push(placeExtra(r, pieces, f, i)));
    return pieces;
  };

  // The outline of a room in several rectangles on the grid (task 7-2): the
  // cell edges with no cell of the room on the other side, joined into runs.
  function outlinePath(parts) {
    const cells = new Set();
    parts.forEach((p) => { for (let i = 0; i < p.w; i++) for (let j = 0; j < p.h; j++) cells.add(`${p.x + i},${p.y + j}`); });
    const has = (x, y) => cells.has(`${x},${y}`);
    const hz = {}, vt = {};
    cells.forEach((c) => {
      const [x, y] = c.split(',').map(Number);
      if (!has(x, y - 1)) (hz[y] = hz[y] || []).push(x);
      if (!has(x, y + 1)) (hz[y + 1] = hz[y + 1] || []).push(x);
      if (!has(x - 1, y)) (vt[x] = vt[x] || []).push(y);
      if (!has(x + 1, y)) (vt[x + 1] = vt[x + 1] || []).push(y);
    });
    const runs = (list) => {
      const out = [];
      [...new Set(list)].sort((a, b) => a - b).forEach((v) => { const last = out[out.length - 1]; if (last && last[1] === v) last[1] = v + 1; else out.push([v, v + 1]); });
      return out;
    };
    const d = [];
    Object.entries(hz).forEach(([y, xs]) => runs(xs).forEach(([a, b]) => d.push(`M${px(a)} ${px(+y)}H${px(b)}`)));
    Object.entries(vt).forEach(([x, ys]) => runs(ys).forEach(([a, b]) => d.push(`M${px(+x)} ${px(a)}V${px(b)}`)));
    return d.join('');
  }
  // Free (outside) runs of cells along each side of an indoor room, longest
  // first. Outdoor ground doesn't cover a wall; the room's own growth does.
  SD.exteriorRuns = function (plan, id, indoor) {
    const r = plan.rooms[id];
    const others = indoor.filter((o) => o !== id && plan.rooms[o].level === r.level).flatMap((o) => E.Layouts.parts(plan.rooms[o])).concat(r.extra || []);
    const covered = (x, y) => others.some((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
    const sides = {
      top: Array.from({ length: r.w }, (_, i) => [r.x + i, r.y - 1]),
      bottom: Array.from({ length: r.w }, (_, i) => [r.x + i, r.y + r.h]),
      left: Array.from({ length: r.h }, (_, i) => [r.x - 1, r.y + i]),
      right: Array.from({ length: r.h }, (_, i) => [r.x + r.w, r.y + i]),
    };
    const runs = [];
    Object.entries(sides).forEach(([side, cells]) => {
      let start = null;
      cells.forEach(([x, y], i) => {
        const free = !covered(x, y);
        if (free && start === null) start = i;
        if ((!free || i === cells.length - 1) && start !== null) { runs.push({ side, start, end: free ? i + 1 : i }); start = null; }
      });
    });
    return runs.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  };

  // Which link kind a feature named like a way out is drawn as.
  const WAY_KIND = [[/window|skylight/, ['window']], [/vent|duct/, ['vent']], [/hatch/, ['hatch']], [/door/, ['door', 'locked door']]];
  const KIND_WORD = { open: 'way', door: 'door', 'locked door': 'locked door', vent: 'vent', hatch: 'hatch', window: 'window', stairs: 'stairs' };
  const LEVEL_NAME = (lv) => (lv === 0 ? 'ground floor' : lv > 0 ? `level ${lv}` : `below ${-lv}`);

  // A gameplay piece: accent outline, tooltip, state icon only in view,
  // clickable. inView false draws it as a remembered outline with no state.
  function featureSvg(id, f, inner, box, inView, used, tf) {
    const st = inView && f.state != null && f.state !== '' ? String(f.state) : null;
    if (st === 'locked') used.add('lock');
    const tip = `${f.name}${st ? ` (${st})` : ''}`;
    const ring = `<rect class="sd-ring" x="${px(box.x) - 2}" y="${px(box.y) - 2}" width="${px(box.w) + 4}" height="${px(box.h) + 4}" rx="3"${tf || ''}/>`;
    let icon = '';
    if (st === 'locked') icon = `<use href="#sd-lock" x="${px(box.x + box.w) - 4}" y="${px(box.y) - 6}" width="9" height="11"/>`;
    else if (st === 'on') icon = `<circle class="sd-on" cx="${px(box.x + box.w)}" cy="${px(box.y)}" r="2.5"/>`;
    return `<g class="sd-piece map-feature${inView ? '' : ' sd-remembered'}" tabindex="0" role="button" data-room="${esc(id)}" data-feature="${esc(f.name)}" aria-label="${esc(tip)}"><title>${esc(tip)}</title>${inner}${ring}${icon}</g>`;
  }

  // plan: Layouts.plan(); rooms: {id: {name, outside, features: [{name,
  // state, inferred}]}} for the rooms that may be drawn; view: { inView: [ids],
  // remembered: [ids], here, seed, links: {"a|b": kind as shown}, tokens:
  // {id: [token]}, tokenSvg(t, cx, cy, r), decor (default true) }.
  SD.render = function (plan, rooms, view) {
    view = view || {};
    const inView = new Set((view.inView || []).filter((id) => plan.rooms[id] && rooms[id]));
    const drawn = new Set([...inView, ...(view.remembered || []).filter((id) => plan.rooms[id] && rooms[id])]);
    const ids = Object.keys(plan.rooms).filter((id) => drawn.has(id)).sort();
    const decor = view.decor !== false;
    const seed = String(view.seed || '');
    const used = new Set();
    const L = { ground: [], back: [], wallsOuter: [], floors: [], wallsInner: [], openings: [], furniture: [], here: [], labels: [], stubs: [], tokens: [] };
    const indoor = ids.filter((id) => !rooms[id].outside);
    const allIndoor = Object.keys(plan.rooms).filter((id) => !(rooms[id] && rooms[id].outside));
    const shownKind = (k) => (view.links && view.links[[k.a, k.b].sort().join('|')]) || k.kind;
    const roomLabel = (id) => (drawn.has(id) ? rooms[id].name : 'an unknown room');

    // Ways out that are features ("the window" with a window link): drawn as
    // that opening, once.
    const claimed = {};
    const linkFeature = {};
    plan.links.forEach((k) => {
      if (k.remote) return;
      [k.a, k.b].forEach((id) => {
        if (!drawn.has(id) || linkFeature[k.a + '|' + k.b]) return;
        const f = (rooms[id].features || []).find((x) => !(claimed[id] || new Set()).has(x.name) && WAY_KIND.some(([re, kinds]) => re.test(x.name.toLowerCase()) && kinds.includes(k.kind)));
        if (!f) return;
        (claimed[id] = claimed[id] || new Set()).add(f.name);
        linkFeature[k.a + '|' + k.b] = { id, f };
      });
    });

    // Floors and walls: a thick stroke on every indoor room, floors over all
    // of them (so shared walls vanish), then a thin stroke on top.
    ids.forEach((id) => {
      const r = plan.rooms[id], l = rooms[id];
      const x = px(r.x), y = px(r.y), w = px(r.w), h = px(r.h);
      const kind = SD.kindOf(Object.assign({ id }, l));
      const pat = inView.has(id) ? SD.FLOOR[kind] : null;
      if (pat) used.add('p-' + pat);
      // A room that grew (task 7-2) is all its parts, with one outline.
      const parts = E.Layouts.parts(r);
      const rects = (cls, extra) => parts.map((p) => `<rect class="${cls}" x="${px(p.x)}" y="${px(p.y)}" width="${px(p.w)}" height="${px(p.h)}"${extra || ''}/>`).join('');
      const edge = (cls) => (r.extra ? `<path class="${cls}" d="${outlinePath(parts)}"/>` : `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`);
      const patRect = pat ? rects('sd-pat', ` fill="url(#sd-p-${pat})"`) : '';
      const cls = `map-room${l.outside ? ' outside' : ''}${id === view.here ? ' here' : ''}${inView.has(id) ? ' sd-view' : ' sd-past'}`;
      const g = `<g class="${cls}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(l.name)}">${rects(l.outside ? 'sd-ground' : 'sd-floor')}${patRect}`;
      if (l.outside) {
        L.ground.push(`${g}${edge('sd-ground-edge')}</g>`);
      } else {
        L.wallsOuter.push(rects('sd-wall-outer'));
        L.floors.push(g + '</g>');
        L.wallsInner.push(edge('sd-wall-inner'));
      }
      if (id === view.here) L.here.push(`<rect class="sd-here" x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${h - 4}"/>`);
    });

    // Windows from features: on the room's longest outside wall (one with
    // none is furnished like any other feature).
    indoor.forEach((id) => {
      const r = plan.rooms[id];
      const runs = SD.exteriorRuns(plan, id, allIndoor);
      const wins = (rooms[id].features || []).filter((f) => /window/i.test(f.name) && !(claimed[id] || new Set()).has(f.name)).slice(0, runs.length);
      wins.forEach((f, i) => {
        (claimed[id] = claimed[id] || new Set()).add(f.name);
        const run = runs[i];
        const len = Math.min(2, run.end - run.start), mid = (run.start + run.end) / 2;
        const across = run.side === 'top' || run.side === 'bottom';
        const at = across ? (run.side === 'top' ? r.y : r.y + r.h) : (run.side === 'left' ? r.x : r.x + r.w);
        const from = (across ? r.x : r.y) + mid - len / 2;
        const box = across ? { x: from, y: at - 0.12, w: len, h: 0.24 } : { x: at - 0.12, y: from, w: 0.24, h: len };
        const inner = `<rect class="sd-window" x="${px(box.x)}" y="${px(box.y)}" width="${px(box.w)}" height="${px(box.h)}"/>` +
          (across ? `<line class="sd-window-line" x1="${px(from)}" y1="${px(at)}" x2="${px(from + len)}" y2="${px(at)}"/>` : `<line class="sd-window-line" x1="${px(at)}" y1="${px(from)}" x2="${px(at)}" y2="${px(from + len)}"/>`);
        L.openings.push(featureSvg(id, f, inner, box, inView.has(id), used));
      });
    });

    // Furniture: in view, everything (decoration unless turned off) with
    // feature state; remembered, the gameplay pieces only, with no state.
    // What stands on the floor is kept, so tokens can stand clear of it.
    const furniture = {};
    ids.forEach((id) => {
      const l = Object.assign({ id }, rooms[id]);
      const see = inView.has(id);
      furniture[id] = [];
      SD.furnish(plan.rooms[id], l, seed, claimed[id]).forEach((p) => {
        if (!p.feature && (!see || !decor)) return;
        if (!p.back) furniture[id].push(p);
        used.add(p.sym);
        const cx = px(p.x + p.w / 2), cy = px(p.y + p.h / 2);
        const tf = p.rot ? ` transform="rotate(${p.rot} ${cx} ${cy})"` : '';
        const use = `<use href="#sd-${p.sym}" x="${px(p.x)}" y="${px(p.y)}" width="${px(p.w)}" height="${px(p.h)}"${tf}/>`;
        if (p.feature) L.furniture.push(featureSvg(id, p.feature, use, p, see, used, tf));
        else (p.back ? L.back : L.furniture).push(`<g class="sd-decor">${use}</g>`);
      });
    });

    // Openings on shared walls, as shown; a "?" just past any that leads
    // into an unknown room.
    plan.links.forEach((k) => {
      const da = drawn.has(k.a), db = drawn.has(k.b);
      if (!da && !db) return;
      if (k.remote) {
        if (da && db && plan.rooms[k.a].level === plan.rooms[k.b].level) {
          const a = plan.rooms[k.a], b = plan.rooms[k.b];
          L.openings.push(`<line class="sd-remote" x1="${px(a.x + a.w / 2)}" y1="${px(a.y + a.h / 2)}" x2="${px(b.x + b.w / 2)}" y2="${px(b.y + b.h / 2)}"/>`);
        }
        return;
      }
      const kind = shownKind(k);
      const into = da ? k.a : k.b;
      const svg = openingSvg(k, kind, plan.rooms[into], used);
      const lf = linkFeature[k.a + '|' + k.b];
      const tip = `${KIND_WORD[kind] || kind}: ${roomLabel(k.a)} – ${roomLabel(k.b)}`;
      if (lf) {
        const len = k.kind === 'open' ? 0.87 : 0.6;
        const box = k.orient === 'v' ? { x: k.x - 0.17, y: k.y - len / 2, w: 0.33, h: len } : { x: k.x - len / 2, y: k.y - 0.17, w: len, h: 0.33 };
        L.openings.push(featureSvg(lf.id, lf.f, svg, box, inView.has(lf.id), used));
      } else {
        L.openings.push(`<g class="sd-door"><title>${esc(tip)}</title>${svg}</g>`);
      }
      const unknown = !da ? k.a : !db ? k.b : null;
      if (unknown) {
        const u = plan.rooms[unknown];
        const sx = k.orient === 'v' ? k.x + (u.x >= k.x ? 0.6 : -0.6) : k.x;
        const sy = k.orient === 'h' ? k.y + (u.y >= k.y ? 0.6 : -0.6) : k.y;
        L.stubs.push(`<g class="map-room sd-stub" tabindex="0" role="button" data-room="${esc(unknown)}" aria-label="An unknown room"><title>Unknown: what is through there?</title><circle cx="${px(sx)}" cy="${px(sy)}" r="8"/><text x="${px(sx)}" y="${px(sy) + 3.5}" text-anchor="middle">?</text></g>`);
      }
    });

    // Labels, ways to other levels (or unseen places), tokens.
    ids.forEach((id) => {
      const r = plan.rooms[id], l = rooms[id];
      const x = px(r.x), w = px(r.w), bottom = px(r.y + r.h);
      const fs = Math.max(7, Math.min(10, (w - 10) / (l.name.length * 0.66)));
      const name = E.shorten(l.name, Math.max(4, Math.floor((w - 8) / (fs * 0.66))));
      L.labels.push(`<text class="sd-label" x="${n1(x + w / 2)}" y="${n1(bottom - 4)}" text-anchor="middle" style="font-size:${n1(fs)}px">${esc(name)}</text>`);
      const notes = plan.links.filter((k) => k.remote && (k.a === id || k.b === id)).map((k) => {
        const o = k.a === id ? k.b : k.a;
        const other = plan.rooms[o].level !== r.level;
        return other || !drawn.has(o) ? `${other ? '↕' : '↗'} ${KIND_WORD[shownKind(k)] || 'way'} to ${roomLabel(o)}` : null;
      }).filter(Boolean);
      if (notes.length) L.labels.push(`<text class="sd-note" x="${x + 5}" y="${n1(bottom - 15)}">${esc(E.shorten(notes.join(', '), Math.floor((w - 8) / 4.6)))}</text>`);
      const list = (view.tokens || {})[id] || [];
      if (list.length && view.tokenSvg) L.tokens.push(SD.tokensIn(list, { x, y: px(r.y), w, h: px(r.h - STRIP) - (notes.length ? 11 : 0) }, (furniture[id] || []).map(pieceBox), id, view.tokenSvg));
    });

    // Level captions, for levels with something drawn.
    if (plan.levels.length > 1) plan.levels.forEach((b) => {
      const mine = ids.filter((id) => plan.rooms[id].level === b.level);
      if (!mine.length) return;
      const mx = Math.min(...mine.map((id) => plan.rooms[id].x)), my = Math.min(...mine.map((id) => plan.rooms[id].y));
      L.labels.push(`<text class="map-level" x="${px(mx)}" y="${px(my) - 9}">${LEVEL_NAME(b.level)}</text>`);
    });

    // Crop to what's drawn, plus a cell of margin.
    let box = [0, 0, 0, 0];
    if (ids.length) {
      const all = ids.flatMap((id) => E.Layouts.parts(plan.rooms[id]));
      const x0 = Math.min(...all.map((p) => p.x)) - 1, y0 = Math.min(...all.map((p) => p.y)) - 1;
      const x1 = Math.max(...all.map((p) => p.x + p.w)) + 1, y1 = Math.max(...all.map((p) => p.y + p.h)) + 1;
      box = [px(x0), px(y0), px(x1 - x0), px(y1 - y0)];
    }
    // Never smaller than about three quarters of full size (the pane
    // scrolls), nor blown up past one and a half (a place of one room).
    // view.fit (task 7-2): the pane's width, zoomed and panned in the game.
    const size = view.fit ? `width:100%;max-width:${Math.round(box[2] * 1.5)}px` : `min-width:${Math.round(box[2] * 0.75)}px;max-width:${Math.round(box[2] * 1.5)}px`;
    return `<svg class="map-svg sd" viewBox="${box.join(' ')}" style="${size}" role="img" aria-label="Map">` +
      `<defs>${SD.defs(used)}</defs>` +
      `<g>${L.ground.join('')}</g><g class="sd-scatter">${L.back.join('')}</g><g>${L.wallsOuter.join('')}</g><g>${L.floors.join('')}</g><g>${L.wallsInner.join('')}</g>` +
      `<g>${L.furniture.join('')}</g><g>${L.openings.join('')}</g><g>${L.here.join('')}</g><g class="sd-labels">${L.labels.join('')}</g><g>${L.stubs.join('')}</g><g class="map-tokens">${L.tokens.join('')}</g></svg>`;
  };

  // A furniture piece's box in pixels (a quarter turn swaps its sides).
  const pieceBox = (p) => {
    const turned = p.rot && Math.abs(p.rot) % 180 === 90;
    const cx = px(p.x + p.w / 2), cy = px(p.y + p.h / 2), w = px(turned ? p.h : p.w), h = px(turned ? p.w : p.h);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  };
  // Where tokens stand in a room: spots on a grid over its free floor
  // (box, in pixels, above the label), clear of the furniture first. Each
  // token takes the spot its id and the room pick, or the next free one, so
  // people spread around the room and keep their places as others come and
  // go. opts: r (token radius), inside(spot) (a room that isn't a box).
  // → { placed: [{ t, x, y }], more (how many didn't fit), last spot }.
  SD.SPOT = { r: 9, gap: 4 };
  SD.tokenSpots = function (list, box, blocked, roomId, opts) {
    const o = opts || {};
    const r = o.r || SD.SPOT.r, step = 2 * r + SD.SPOT.gap;
    const cols = Math.max(1, Math.floor((box.w - 8) / step));
    const rows = Math.max(1, Math.floor((box.h - 4) / step));
    // The grid centred in the box.
    const x0 = box.x + (box.w - cols * step) / 2 + step / 2, y0 = box.y + (box.h - rows * step) / 2 + step / 2;
    const spots = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) spots.push({ x: n1(x0 + i * step), y: n1(y0 + j * step) });
    if (o.inside) { const inner = spots.filter(o.inside); if (inner.length) spots.splice(0, spots.length, ...inner); }
    const hits = (s) => blocked.some((b) => s.x + r > b.x && s.x - r < b.x + b.w && s.y + r > b.y && s.y - r < b.y + b.h);
    const clear = spots.filter((s) => !hits(s));
    const pool = clear.length >= Math.min(list.length, spots.length) ? clear : clear.concat(spots.filter(hits));
    const fit = list.length > pool.length ? pool.length - 1 : list.length;
    const taken = new Set();
    const out = list.slice(0, Math.max(0, fit)).map((t) => {
      let k = (E.hash(`${roomId}|${t.id}`) >>> 0) % pool.length;
      while (taken.has(k)) k = (k + 1) % pool.length;
      taken.add(k);
      return { t, x: pool[k].x, y: pool[k].y };
    });
    return { placed: out, more: list.length - out.length, last: pool[pool.length - 1] };
  };
  // Tokens drawn at their spots; the rest as "+N".
  SD.tokensIn = function (list, box, blocked, roomId, tokenSvg) {
    const { placed, more, last } = SD.tokenSpots(list, box, blocked, roomId);
    const r = SD.SPOT.r;
    let out = placed.map((p) => tokenSvg(p.t, p.x, p.y, r)).join('');
    if (more > 0 && last) out += `<text class="map-more" x="${n1(last.x - r + 2)}" y="${n1(last.y + 4)}">+${more}</text>`;
    return out;
  };

  // One opening on a shared wall: a gap with posts (open), a leaf and swing
  // into the room it opens into (door, padlock when locked), vents and
  // hatches, a double line (window), treads (stairs).
  function openingSvg(k, kind, into, used) {
    const x = px(k.x), y = px(k.y), v = k.orient === 'v';
    const len = px(kind === 'open' ? 0.87 : 0.6);
    const gap = v ? `<rect class="sd-gap" x="${x - 5}" y="${y - len / 2}" width="10" height="${len}"/>` : `<rect class="sd-gap" x="${x - len / 2}" y="${y - 5}" width="${len}" height="10"/>`;
    switch (kind) {
      case 'door': case 'locked door': {
        const dir = v ? (into.x * CELL < x ? -1 : 1) : (into.y * CELL < y ? -1 : 1);
        let leaf;
        if (v) {
          const hy = y - len / 2;
          leaf = `<line class="sd-leaf" x1="${x}" y1="${hy}" x2="${x + dir * len}" y2="${hy}"/><path class="sd-swing" d="M ${x + dir * len} ${hy} A ${len} ${len} 0 0 ${dir > 0 ? 1 : 0} ${x} ${hy + len}"/>`;
        } else {
          const hx = x - len / 2;
          leaf = `<line class="sd-leaf" x1="${hx}" y1="${y}" x2="${hx}" y2="${y + dir * len}"/><path class="sd-swing" d="M ${hx} ${y + dir * len} A ${len} ${len} 0 0 ${dir > 0 ? 0 : 1} ${hx + len} ${y}"/>`;
        }
        if (kind === 'locked door') { used.add('lock'); leaf += `<use class="sd-lock" href="#sd-lock" x="${x - 4.5}" y="${y - 5.5}" width="9" height="11"/>`; }
        return gap + leaf;
      }
      case 'vent': case 'hatch': {
        const cross = kind === 'hatch' ? (v ? `<line class="sd-leaf" x1="${x - 4}" y1="${y}" x2="${x + 4}" y2="${y}"/>` : `<line class="sd-leaf" x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}"/>`) : '';
        return (v ? `<rect class="sd-vent" x="${x - 4}" y="${y - 7}" width="8" height="14"/>` : `<rect class="sd-vent" x="${x - 7}" y="${y - 4}" width="14" height="8"/>`) + cross;
      }
      case 'window':
        return gap + (v ? `<line class="sd-window-line" x1="${x - 2}" y1="${y - len / 2}" x2="${x - 2}" y2="${y + len / 2}"/><line class="sd-window-line" x1="${x + 2}" y1="${y - len / 2}" x2="${x + 2}" y2="${y + len / 2}"/>`
          : `<line class="sd-window-line" x1="${x - len / 2}" y1="${y - 2}" x2="${x + len / 2}" y2="${y - 2}"/><line class="sd-window-line" x1="${x - len / 2}" y1="${y + 2}" x2="${x + len / 2}" y2="${y + 2}"/>`);
      case 'stairs':
        return gap + [-4, 0, 4].map((d) => (v ? `<line class="sd-leaf" x1="${x - 4}" y1="${y + d}" x2="${x + 4}" y2="${y + d}"/>` : `<line class="sd-leaf" x1="${x + d}" y1="${y - 4}" x2="${x + d}" y2="${y + 4}"/>`)).join('');
      default:
        return gap + (v ? `<rect class="sd-post" x="${x - 4}" y="${y - len / 2 - 2}" width="8" height="3"/><rect class="sd-post" x="${x - 4}" y="${y + len / 2 - 1}" width="8" height="3"/>`
          : `<rect class="sd-post" x="${x - len / 2 - 2}" y="${y - 4}" width="3" height="8"/><rect class="sd-post" x="${x + len / 2 - 1}" y="${y - 4}" width="3" height="8"/>`);
    }
  }

  // ---------- symbols and patterns ----------
  // One <symbol> per piece, used through <use>, and only those drawn, so a
  // site stays at a few KB. Colours are theme classes (css/style.css).
  const DEFS = {
    'p-tile': '<pattern id="sd-p-tile" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0V10M0 10H10" class="sd-pl"/></pattern>',
    'p-plate': '<pattern id="sd-p-plate" width="15" height="15" patternUnits="userSpaceOnUse"><path d="M15 0V15M0 15H15" class="sd-pl"/><circle cx="2" cy="2" r=".8" class="sd-pd"/><circle cx="13" cy="13" r=".8" class="sd-pd"/></pattern>',
    'p-clean': '<pattern id="sd-p-clean" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M12 0V12M0 12H12" class="sd-pl sd-faint"/></pattern>',
    'p-grate': '<pattern id="sd-p-grate" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.1" class="sd-pd"/></pattern>',
    'p-plain': '<pattern id="sd-p-plain" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M0 20H20" class="sd-pl sd-faint"/></pattern>',
    'p-diamond': '<pattern id="sd-p-diamond" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M2 3l3-1M6 8l3-1M7 2l1 3M1 7l1 3" class="sd-pl"/></pattern>',
    'p-ground': '<pattern id="sd-p-ground" width="23" height="19" patternUnits="userSpaceOnUse"><circle cx="4" cy="5" r=".9" class="sd-pr"/><circle cx="15" cy="3" r=".6" class="sd-pr"/><circle cx="19" cy="13" r="1.1" class="sd-pr"/><circle cx="9" cy="15" r=".7" class="sd-pr"/></pattern>',
    table: '<symbol id="sd-table" viewBox="0 0 100 22" preserveAspectRatio="none"><rect x="1" y="1" width="98" height="20" rx="4" class="sd-fu"/></symbol>',
    chair: '<symbol id="sd-chair" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2.5" class="sd-fu"/></symbol>',
    stool: '<symbol id="sd-stool" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" class="sd-fu"/></symbol>',
    round: '<symbol id="sd-round" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" class="sd-fu"/></symbol>',
    counter: '<symbol id="sd-counter" viewBox="0 0 70 14" preserveAspectRatio="none"><rect x="1" y="1" width="68" height="12" class="sd-fu"/></symbol>',
    console: '<symbol id="sd-console" viewBox="0 0 40 16" preserveAspectRatio="none"><rect x="1" y="1" width="38" height="14" rx="2" class="sd-fu"/><rect x="5" y="3" width="30" height="5" class="sd-screen"/></symbol>',
    board: '<symbol id="sd-board" viewBox="0 0 5 50" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="4" height="49" class="sd-screen"/></symbol>',
    cot: '<symbol id="sd-cot" viewBox="0 0 15 32" preserveAspectRatio="none"><rect x="1" y="1" width="13" height="30" rx="2" class="sd-fu"/><rect x="3" y="3" width="9" height="6" rx="2" class="sd-fd"/></symbol>',
    bed: '<symbol id="sd-bed" viewBox="0 0 24 33" preserveAspectRatio="none"><rect x="1" y="1" width="22" height="31" rx="2" class="sd-fu"/><rect x="3" y="3" width="8" height="6" rx="2" class="sd-fd"/><rect x="13" y="3" width="8" height="6" rx="2" class="sd-fd"/></symbol>',
    sofa: '<symbol id="sd-sofa" viewBox="0 0 36 14" preserveAspectRatio="none"><rect x="1" y="1" width="34" height="12" rx="3" class="sd-fu"/><line x1="4" y1="4" x2="32" y2="4" class="sd-fl"/></symbol>',
    scanner: '<symbol id="sd-scanner" viewBox="0 0 20 34"><rect x="2" y="6" width="16" height="26" rx="3" class="sd-fu"/><path d="M1 12 A9 9 0 0 1 19 12" class="sd-arch"/></symbol>',
    cabinet: '<symbol id="sd-cabinet" viewBox="0 0 24 9" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="23" height="8" class="sd-fu"/><line x1="12" y1="1" x2="12" y2="8" class="sd-fl"/></symbol>',
    rack: '<symbol id="sd-rack" viewBox="0 0 100 10" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="99" height="9" class="sd-fu"/><path d="M12 1V9M24 1V9M36 1V9M48 1V9M60 1V9M72 1V9M84 1V9" class="sd-fl"/></symbol>',
    shelf: '<symbol id="sd-shelf" viewBox="0 0 100 10" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="99" height="9" class="sd-fu"/><line x1="1" y1="5" x2="99" y2="5" class="sd-fl"/></symbol>',
    gunrack: '<symbol id="sd-gunrack" viewBox="0 0 21 9" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="20" height="8" class="sd-fu"/><path d="M4 2V7M8 2V7M12 2V7M16 2V7" class="sd-fl"/></symbol>',
    glovebox: '<symbol id="sd-glovebox" viewBox="0 0 36 22"><rect x="1" y="1" width="34" height="20" rx="2" class="sd-fu"/><circle cx="12" cy="14" r="4" class="sd-fd"/><circle cx="24" cy="14" r="4" class="sd-fd"/></symbol>',
    incubator: '<symbol id="sd-incubator" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="2" class="sd-fu"/><circle cx="7" cy="7" r="3" class="sd-screen"/></symbol>',
    grow: '<symbol id="sd-grow" viewBox="0 0 100 11" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="99" height="10" class="sd-fu"/><path d="M5 5.5h90" class="sd-leaves"/></symbol>',
    plant: '<symbol id="sd-plant" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" class="sd-fu"/><path d="M7 2V12M2 7H12" class="sd-leaves"/></symbol>',
    tank: '<symbol id="sd-tank" viewBox="0 0 14 22"><rect x="1" y="1" width="12" height="20" rx="6" class="sd-fu"/><line x1="3" y1="11" x2="11" y2="11" class="sd-fl"/></symbol>',
    bunk: '<symbol id="sd-bunk" viewBox="0 0 16 30" preserveAspectRatio="none"><rect x="1" y="1" width="14" height="28" rx="2" class="sd-fu"/><rect x="3" y="3" width="10" height="5" rx="2" class="sd-fd"/><line x1="1" y1="29.5" x2="15" y2="29.5" class="sd-curtain"/></symbol>',
    locker: '<symbol id="sd-locker" viewBox="0 0 12 15"><rect x="0.5" y="0.5" width="11" height="14" class="sd-fu"/><circle cx="6" cy="5" r="2.6" class="sd-fd"/></symbol>',
    airlock: '<symbol id="sd-airlock" viewBox="0 0 26 22"><rect x="1" y="1" width="24" height="20" class="sd-fu"/><line x1="4" y1="1" x2="4" y2="21" class="sd-hazard"/><line x1="22" y1="1" x2="22" y2="21" class="sd-hazard"/><circle cx="13" cy="11" r="3" class="sd-fd"/></symbol>',
    rover: '<symbol id="sd-rover" viewBox="0 0 68 40"><rect x="8" y="6" width="52" height="28" rx="5" class="sd-fu"/><rect x="44" y="10" width="13" height="20" rx="2" class="sd-screen"/>' + [10, 30, 50].map((x) => `<rect x="${x}" y="1" width="9" height="6" rx="2" class="sd-fd"/><rect x="${x}" y="33" width="9" height="6" rx="2" class="sd-fd"/>`).join('') + '</symbol>',
    car: '<symbol id="sd-car" viewBox="0 0 36 20"><rect x="1" y="2" width="34" height="16" rx="5" class="sd-fu"/><rect x="22" y="4" width="7" height="12" rx="2" class="sd-screen"/><rect x="6" y="4" width="5" height="12" rx="1" class="sd-fd"/></symbol>',
    toolbench: '<symbol id="sd-toolbench" viewBox="0 0 40 10"><rect x="0.5" y="0.5" width="39" height="9" class="sd-fu"/><path d="M6 3h6M18 3v4M28 5h6" class="sd-fl"/></symbol>',
    desk: '<symbol id="sd-desk" viewBox="0 0 36 16" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="35" height="15" rx="1" class="sd-fu"/><rect x="24" y="3" width="8" height="5" class="sd-screen"/></symbol>',
    bigdoor: '<symbol id="sd-bigdoor" viewBox="0 0 8 44" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="7" height="43" class="sd-fu"/><path d="M1 4l6 4M1 12l6 4M1 20l6 4M1 28l6 4M1 36l6 4" class="sd-hazard"/></symbol>',
    panel: '<symbol id="sd-panel" viewBox="0 0 20 12" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="19" height="11" class="sd-screen"/><path d="M5 1V11M10 1V11M15 1V11M1 6H19" class="sd-fl"/></symbol>',
    rig: '<symbol id="sd-rig" viewBox="0 0 28 28"><path d="M14 3L3 25M14 3L25 25M14 3V25" class="sd-rig"/><circle cx="14" cy="15" r="3.5" class="sd-fd"/></symbol>',
    machine: '<symbol id="sd-machine" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="2" class="sd-fu"/><circle cx="8" cy="8" r="4" class="sd-fd"/><line x1="3" y1="3" x2="5" y2="3" class="sd-hazard"/></symbol>',
    dumpster: '<symbol id="sd-dumpster" viewBox="0 0 30 16" preserveAspectRatio="none"><rect x="1" y="1" width="28" height="14" rx="1" class="sd-fu"/><line x1="15" y1="1" x2="15" y2="15" class="sd-fl"/></symbol>',
    toilet: '<symbol id="sd-toilet" viewBox="0 0 10 13"><rect x="1" y="0.5" width="8" height="4" class="sd-fu"/><ellipse cx="5" cy="8.5" rx="4" ry="4" class="sd-fu"/></symbol>',
    crate: '<symbol id="sd-crate" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" class="sd-fu"/><path d="M1 1L13 13M13 1L1 13" class="sd-fl"/></symbol>',
    hatch: '<symbol id="sd-hatch" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" class="sd-fu"/><path d="M3 5H11M3 7H11M3 9H11" class="sd-fl"/></symbol>',
    ladder: '<symbol id="sd-ladder" viewBox="0 0 10 20" preserveAspectRatio="none"><path d="M2 0V20M8 0V20M2 4H8M2 9H8M2 14H8M2 19H8" class="sd-rig"/></symbol>',
    rock: '<symbol id="sd-rock" viewBox="0 0 10 10"><path d="M2 6L4 2L8 3L9 7L5 9Z" class="sd-rock"/></symbol>',
    debris: '<symbol id="sd-debris" viewBox="0 0 10 10"><path d="M1 5L5 2L9 4L6 8Z" class="sd-rock"/></symbol>',
    lock: '<symbol id="sd-lock" viewBox="0 0 9 11"><path d="M2.2 5V3.4a2.3 2.3 0 0 1 4.6 0V5" class="sd-lock-shackle"/><rect x="1" y="5" width="7" height="5.5" rx="1" class="sd-lock-body"/></symbol>',
  };
  // ---------- a site map drawn on its own image (task 6-3) ----------
  // map: { url, width, height }; rooms: {id: {name, shape, outside}} for the
  // rooms of the place; view: { inView, remembered, here, links: [{a, b,
  // kind, at}] (kinds as last seen), tokens, tokenSvg, seed }. The picture
  // shows only through rooms the player knows (a mask), dimmed where they
  // only remember it; unknown rooms are not drawn, only a "?" past a door
  // from a known room (rule 11). The image is the author's; nothing is
  // invented on top of it.
  SD.renderImage = function (map, rooms, view) {
    view = view || {};
    const W = map.width, H = map.height;
    const inView = new Set((view.inView || []).filter((id) => rooms[id]));
    const remembered = new Set((view.remembered || []).filter((id) => rooms[id] && !inView.has(id)));
    const known = (id) => inView.has(id) || remembered.has(id);
    const ids = Object.keys(rooms).filter((id) => Array.isArray(rooms[id].shape) && rooms[id].shape.length >= 3).sort();
    const pts = (poly) => poly.map((p) => `${n1(p[0])},${n1(p[1])}`).join(' ');
    const Geo = E.Sites.Geo;
    const mid = `sdmask-${String(view.seed || 'map').replace(/[^a-z0-9_-]/gi, '')}`;
    const unit = W / 100;
    const out = [`<rect class="sd-img-fog" x="0" y="0" width="${W}" height="${H}"/>`,
      `<mask id="${mid}"><rect x="0" y="0" width="${W}" height="${H}" fill="black"/>${ids.filter(known).map((id) => `<polygon points="${pts(rooms[id].shape)}" fill="white"/>`).join('')}</mask>`,
      map.url ? `<image href="${esc(map.url)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" mask="url(#${mid})"/>` : ''];
    ids.filter(known).forEach((id) => {
      const r = rooms[id];
      const c = Geo.centroid(r.shape);
      const cls = `map-room${id === view.here ? ' here' : ''}${remembered.has(id) ? ' sd-remembered' : ''}${r.outside ? ' outside' : ''}`;
      // The label fits its room (task 7-2: a school sheet of small rooms):
      // smaller for a narrow room, and cut short if it still doesn't fit.
      const bw = Geo.bbox(r.shape).w;
      const fs = Math.max(unit * 0.9, Math.min(unit * 2.4, (bw * 0.9) / (r.name.length * 0.56)));
      const name = E.shorten(r.name, Math.max(4, Math.floor((bw * 0.9) / (fs * 0.56))));
      out.push(`<g class="${cls}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(r.name)}"><polygon class="sd-img-room" points="${pts(r.shape)}"/>` +
        `<text class="sd-img-label" x="${n1(c[0])}" y="${n1(Geo.bbox(r.shape).y + fs * 1.3)}" text-anchor="middle" style="font-size:${n1(fs)}px">${esc(name)}</text></g>`);
    });
    // Doors: at the link's point, else the middle of the shared edge.
    (view.links || []).forEach((k) => {
      if (!known(k.a) && !known(k.b)) return;
      const A = rooms[k.a], B = rooms[k.b];
      if (!A || !B || !A.shape || !B.shape) return;
      const s = Array.isArray(k.at) ? { mid: k.at } : Geo.shared(A.shape, B.shape, unit);
      if (!s) return;
      const [x, y] = s.mid;
      const word = { open: 'opening', 'locked door': 'locked door' }[k.kind] || k.kind;
      out.push(`<g class="sd-img-door sd-img-${String(k.kind).replace(/\s+/g, '-')}"><title>${esc(word)}</title><rect x="${n1(x - unit)}" y="${n1(y - unit)}" width="${n1(unit * 2)}" height="${n1(unit * 2)}" rx="${n1(unit / 3)}"/></g>`);
      const unknown = known(k.a) ? (known(k.b) ? null : k.b) : k.a;
      if (unknown) {
        const c = Geo.centroid(rooms[unknown].shape);
        const len = Math.hypot(c[0] - x, c[1] - y) || 1;
        out.push(`<text class="sd-img-unknown" x="${n1(x + ((c[0] - x) / len) * unit * 4)}" y="${n1(y + ((c[1] - y) / len) * unit * 4 + unit)}" text-anchor="middle" style="font-size:${n1(unit * 3)}px">?</text>`);
      }
    });
    // Tokens spread around their room, inside its outline (as on drawn plans).
    const r = Math.max(8, Math.round(unit * 1.6));
    Object.entries(view.tokens || {}).forEach(([id, list]) => {
      if (!known(id) || !rooms[id] || !rooms[id].shape || !view.tokenSvg) return;
      const ring = rooms[id].shape;
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const spots = SD.tokenSpots(list, box, [], id, { r, inside: (s) => Geo.inside([s.x, s.y], ring) });
      spots.placed.forEach((p) => out.push(view.tokenSvg(p.t, p.x, p.y, r)));
      if (spots.more > 0 && spots.last) out.push(`<text class="map-more" x="${n1(spots.last.x - r + 2)}" y="${n1(spots.last.y + 4)}">+${spots.more}</text>`);
    });
    return `<svg class="map-svg sd-image" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map">${out.join('')}</svg>`;
  };

  SD.defs = (used) => Object.keys(DEFS).filter((k) => !used || used.has(k)).map((k) => DEFS[k]).join('');
})(typeof window !== 'undefined' ? window : globalThis);
