// The creator (task 3-5): a separate page for building worlds without
// editing JSON. It keeps a working copy of one world's raw files in memory
// and in localStorage (images by object URL only, never stored), validates
// it live with the game's own Scenario checks, and exports the world folder
// as a zip. The only creator file that touches the DOM; the editing logic is
// in mapedit.js, drawing in mapdraw.js. Tabs are a registry so later phases
// add their own.
(function () {
  const E = window.Ensemble;
  const S = E.Scenario, M = E.MapEdit, D = E.MapDraw;
  const $ = (id) => document.getElementById(id);
  const esc = D.esc;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const SAVE_KEY = (folder) => `ensemble.creator.${folder}`;

  // The working copy: { folder, files: {path: JSON}, assets: {path: File|Blob}, server }
  let cw = null;
  // Map tab state.
  const ui = { tab: 'map', mode: 'select', sel: null, drawing: [], room: '', vb: null, autoIds: new Set(), confirmDelete: false };
  const urls = new Map(); // asset path -> object URL
  const diskWorlds = new Map(); // "disk:folder" -> { folder, files, assets }

  // ---------- tabs ----------
  const TABS = [
    { id: 'world', label: 'World', soon: 'phase 6' },
    { id: 'groups', label: 'Groups', soon: 'phase 6' },
    { id: 'map', label: 'Map', render: renderMapTab },
    { id: 'sites', label: 'Sites', soon: 'phase 6' },
    // Lore entries load and play (task 5-1); their editor is task 5-3. Lore is public: no secrets.
    { id: 'lore', label: 'Lore', soon: 'phase 5' },
    { id: 'timeline', label: 'Timeline', soon: 'phase 5' },
    { id: 'characters', label: 'Characters', soon: 'phase 6' },
    { id: 'starts', label: 'Starts', soon: 'phase 6' },
    { id: 'portraits', label: 'Portraits', soon: 'phase 6' },
  ];
  function renderTabs() {
    $('cTabs').innerHTML = TABS.map((t) => `<button type="button" data-tab="${t.id}" ${t.soon ? `disabled title="Coming in ${t.soon}"` : ''} aria-pressed="${t.id === ui.tab}">${esc(t.label)}${t.soon ? '<span class="soon"> · soon</span>' : ''}</button>`).join('');
  }
  $('cTabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b || b.disabled) return;
    ui.tab = b.dataset.tab;
    render();
  });

  // ---------- the working copy ----------
  const world = () => cw.files['world.json'];
  const starts = () => {
    const out = {};
    (world().starts || []).forEach((id) => { if (cw.files[`starts/${id}.json`]) out[id] = cw.files[`starts/${id}.json`]; });
    return out;
  };
  // A legacy folder becomes a new-format world as soon as it is opened.
  function normalise(files) {
    if (files['world.json']) return files;
    const legacy = Object.assign({}, files['scenario.json'], {
      characterData: (files['scenario.json'].characters || []).map((id) => files[`characters/${id}.json`] || null),
    });
    const b = S.fromLegacy(legacy);
    const out = { 'world.json': Object.assign({ format: 2 }, b.world) };
    Object.entries(b.starts).forEach(([id, st]) => (out[`starts/${id}.json`] = st));
    Object.entries(b.characters).forEach(([id, c]) => (out[`characters/${id}.json`] = c));
    return out;
  }
  function banner(html, cls) {
    const el = $('cBanner');
    el.className = `c-banner${html ? '' : ' hidden'}${cls ? ' ' + cls : ''}`;
    el.innerHTML = html || '';
  }
  function open(folder, files, assets, server) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
    const original = normalise(JSON.parse(JSON.stringify(files)));
    cw = { folder, files: original, assets: Object.assign({}, assets || {}), server: !!server, original };
    Object.assign(ui, { mode: 'select', sel: null, drawing: [], room: '', vb: null, confirmDelete: false });
    ui.autoIds = new Set();
    banner('');
    let saved = null;
    try { saved = JSON.parse(store.get(SAVE_KEY(folder))); } catch (e) { saved = null; }
    if (saved && saved.files && saved.files['world.json']) {
      cw.files = saved.files;
      banner(`Restored your unsaved edits from ${esc(new Date(saved.at).toLocaleString())}. <button type="button" id="cDiscard" class="small">Discard edits</button>`);
    }
    $('cExport').disabled = false;
    $('cJson').disabled = false;
    render();
  }
  $('cBanner').addEventListener('click', (ev) => {
    if (ev.target.id !== 'cDiscard' || !cw) return;
    store.del(SAVE_KEY(cw.folder));
    cw.files = JSON.parse(JSON.stringify(cw.original));
    banner('Edits discarded.');
    render();
  });
  let saveTimer = null, checkTimer = null;
  // After every edit: autosave and validate (debounced), redraw the parts asked for.
  function changed(parts) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(SAVE_KEY(cw.folder), JSON.stringify({ files: cw.files, at: Date.now() })), 400);
    clearTimeout(checkTimer);
    checkTimer = setTimeout(renderValidation, 250);
    (parts || ['all']).forEach((p) => (p === 'all' ? render() : p === 'canvas' ? renderCanvas() : p === 'list' ? renderRegionList() : null));
  }

  // ---------- validation ----------
  // Runs the game's own checks on the working copy: the world, then every
  // start composed. Returns { problems: [text], warnings: [text] }.
  function check() {
    const files = JSON.parse(JSON.stringify(cw.files));
    const out = { problems: [], warnings: [] };
    const split = (msg) => String(msg).split('\n- ').slice(1).map((s) => s.trim()).filter(Boolean);
    try {
      const w = S.prepareWorld(cw.folder, files);
      out.warnings = [...w.warnings];
      // The same problem in every start is the world's: show it once.
      const byMsg = new Map();
      w.starts.forEach((s) => { if (s.error) (split(s.error).length ? split(s.error) : [s.error]).forEach((m) => byMsg.set(m, (byMsg.get(m) || []).concat(s.id))); });
      byMsg.forEach((ids, m) => out.problems.push(...(ids.length === w.starts.length ? [m] : ids.map((id) => `start "${id}": ${m}`))));
    } catch (err) {
      out.problems = split(err.message).length ? split(err.message) : [err.message];
    }
    return out;
  }
  function renderValidation() {
    if (!cw) { $('cValidation').innerHTML = ''; return; }
    const r = check();
    $('cValidation').innerHTML = r.problems.length
      ? `<b class="bad">${r.problems.length} problem${r.problems.length > 1 ? 's' : ''}</b> (the game won't load this world until they're fixed):<ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
      : `<b class="good">No problems.</b>${r.warnings.length ? ` Warnings:<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
    const form = $('cRegionProblems');
    if (form && ui.sel) {
      const mine = r.problems.filter((p) => p.includes(`"${ui.sel}"`));
      form.innerHTML = mine.map((p) => `<div class="bad small">${esc(p)}</div>`).join('');
    }
  }

  // ---------- images ----------
  function assetUrl(path) {
    if (!path) return null;
    const a = cw.assets[path];
    if (a) {
      if (!urls.has(path)) urls.set(path, URL.createObjectURL(a));
      return urls.get(path);
    }
    return cw.server && location.protocol !== 'file:' ? `scenarios/${encodeURIComponent(cw.folder)}/${path.split('/').map(encodeURIComponent).join('/')}` : null;
  }
  function loadImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = world();
      const path = 'maps/' + file.name.replace(/[^\w .-]+/g, '_');
      const width = img.naturalWidth || 800, height = img.naturalHeight || 600;
      const scaleX = w.map ? width / w.map.width : 1, scaleY = w.map ? height / w.map.height : 1;
      // Shapes drawn on a previous image are scaled to the new one.
      const scale = (p) => [Math.round(p[0] * scaleX), Math.round(p[1] * scaleY)];
      const regions = {};
      Object.entries((w.map && w.map.regions) || {}).forEach(([id, sh]) => (regions[id] = sh.polygon ? { polygon: sh.polygon.map(scale) } : { point: scale(sh.point) }));
      const locations = {};
      Object.entries((w.map && w.map.locations) || {}).forEach(([id, p]) => (locations[id] = scale(p)));
      w.map = { image: path, width, height, regions, locations };
      cw.assets[path] = file;
      urls.set(path, url);
      ui.vb = null;
      changed();
    };
    img.onerror = () => banner(`That file couldn't be read as an image: ${esc(file.name)}`, 'bad');
    img.src = url;
  }

  // ---------- the map tab ----------
  const HINTS = {
    select: 'Click a region to edit it. Drag a corner to move it, Alt-click a corner to remove it, double-click an edge to add one. Drag empty space to pan; scroll to zoom.',
    draw: 'Click to add corners. Click the first corner or press Enter to finish; Backspace removes the last corner; Esc cancels. The shape goes to the selected region (or a new one).',
    point: 'Click to place the selected region as a point (for places too small or vague to outline).',
    room: 'Pick a room, then click where it is on the map.',
  };
  function rooms() {
    const out = [];
    (world().locations || []).forEach((l) => out.push({ id: l.id, name: l.name, from: 'world' }));
    Object.entries(starts()).forEach(([sid, st]) => (st.locations || []).forEach((l) => { if (!out.some((o) => o.id === l.id)) out.push({ id: l.id, name: l.name, from: sid }); }));
    return out;
  }
  function renderMapTab() {
    const w = world();
    const regions = w.regions || [];
    const factions = w.factions || [];
    const startList = Object.entries(starts());
    return `<div class="c-map">
      <div class="c-canvas-col">
        <div class="c-toolbar" role="toolbar" aria-label="Map tools">
          ${['select', 'draw', 'point', 'room'].map((m) => `<button type="button" data-mode="${m}" aria-pressed="${ui.mode === m}">${({ select: 'Select', draw: 'Draw region', point: 'Point', room: 'Place room' })[m]}</button>`).join('')}
          <span class="sep"></span>
          <label class="btn">${w.map ? 'Change image' : 'Load image'}<input type="file" id="cImage" accept="image/*" hidden></label>
          ${w.map ? '<button type="button" id="cNoImage" title="Use the automatic node map instead">Remove image</button>' : ''}
          <span class="zoom"><button type="button" data-czoom="in" aria-label="Zoom in">+</button><button type="button" data-czoom="out" aria-label="Zoom out">−</button><button type="button" data-czoom="reset" aria-label="Reset the view">⟲</button></span>
        </div>
        <div id="cCanvas" class="c-canvas"></div>
        <div class="c-hint" id="cHint">${esc(w.map ? HINTS[ui.mode] : 'Load a map image to draw regions on it. Without one, the game lays the regions out from their neighbours, as shown here.')}</div>
      </div>
      <aside class="c-panel">
        <section><h3>Regions</h3><div id="cRegionList" class="c-list"></div><button type="button" id="cAddRegion" class="small">+ Region</button></section>
        <section id="cRegionForm">${regionForm()}</section>
        ${w.map ? `<section><h3>Rooms on the map</h3><select id="cRoomPick" aria-label="Room to place"><option value="">Pick a room…</option>${rooms().map((r) => `<option value="${esc(r.id)}"${r.id === ui.room ? ' selected' : ''}>${esc(r.name)}${r.from !== 'world' ? ` (${esc(r.from)})` : ''}${w.map.locations && w.map.locations[r.id] ? ' ✓' : ''}</option>`).join('')}</select>
          <ul class="c-placed">${Object.keys(w.map.locations || {}).map((id) => `<li>${esc((rooms().find((r) => r.id === id) || { name: id }).name)} <span class="muted">${esc(M.regionAt(w.map, w.map.locations[id]) || 'outside every region')}</span> <button type="button" class="small ghost" data-unplace="${esc(id)}" aria-label="Remove ${esc(id)} from the map">✕</button></li>`).join('')}</ul></section>` : ''}
        ${regions.length ? `<section><h3>Where each start begins</h3>${startList.map(([sid, st]) => `<label class="c-row">${esc(st.title || sid)} <select data-startregion="${esc(sid)}">${regions.map((r) => `<option value="${esc(r.id)}"${st.region === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}${st.region ? '' : '<option value="" selected>(none)</option>'}</select></label>`).join('')}</section>` : ''}
        ${factions.length ? `<section><h3>Group colours</h3>${factions.map((f) => `<label class="c-row"><span><span class="swatch ${D.factionClass(factions, f.id)}"></span>${esc(f.name)}</span> <select data-fcolor="${esc(f.id)}"><option value="">auto</option>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}"${f.color === n ? ' selected' : ''}>colour ${n}</option>`).join('')}</select></label>`).join('')}</section>` : ''}
      </aside>
    </div>`;
  }
  function regionForm() {
    const w = world();
    const r = ui.sel && (w.regions || []).find((x) => x.id === ui.sel);
    if (!r) return '<p class="muted">Pick a region on the map or in the list, or add one.</p>';
    const others = (w.regions || []).filter((x) => x.id !== r.id);
    const touching = new Set(w.map ? M.suggestNeighbours(w.map).filter((p) => p.includes(r.id)).map((p) => (p[0] === r.id ? p[1] : p[0])) : []);
    const sh = w.map && w.map.regions && w.map.regions[r.id];
    return `<h3>${esc(r.name)} <span class="muted small">(${esc(r.id)})</span></h3>
      <div id="cRegionProblems"></div>
      <label>Name <input data-field="name" value="${esc(r.name)}" maxlength="40"></label>
      <label>Held by <select data-field="controller"><option value="">no one</option>${(w.factions || []).map((f) => `<option value="${esc(f.id)}"${r.controller === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label>Tags <span class="muted small">(comma-separated, up to ${S.REGION_TAGS})</span><input data-field="tags" value="${esc((r.tags || []).join(', '))}"></label>
      <label>Status <input data-field="status" value="${esc(r.status || '')}" maxlength="120"></label>
      <label>Lore summary <span class="muted small" id="cLoreCount">${(r.lore || '').length}/400</span> <span class="muted small">Public knowledge: secrets go in a character's secret, events still to come in the timeline.</span><textarea data-field="lore" rows="3" maxlength="400">${esc(r.lore || '')}</textarea></label>
      <fieldset class="c-neigh"><legend>Neighbours</legend>${others.map((o) => `<label><input type="checkbox" data-neigh="${esc(o.id)}"${M.areNeighbours(w, r.id, o.id) ? ' checked' : ''}> ${esc(o.name)}${touching.has(o.id) ? ' <span class="muted small">(touching)</span>' : ''}</label>`).join('') || '<span class="muted">No other regions.</span>'}
        ${touching.size ? '<button type="button" id="cAddTouching" class="small">Add touching regions</button>' : ''}</fieldset>
      <div class="muted small">${w.map ? (sh ? (sh.polygon ? `Outlined with ${sh.polygon.length} corners.` : 'Placed as a point.') : 'Not on the map yet: draw it or place it as a point.') : ''}</div>
      <button type="button" id="cDeleteRegion" class="small danger">${ui.confirmDelete ? 'Click again to delete' : 'Delete region'}</button>`;
  }
  function renderRegionList() {
    const el = $('cRegionList');
    if (!el) return;
    const w = world();
    el.innerHTML = (w.regions || []).map((r) => {
      const placed = !w.map || (w.map.regions && w.map.regions[r.id]);
      return `<button type="button" data-sel="${esc(r.id)}" aria-pressed="${r.id === ui.sel}"><span class="swatch ${D.factionClass(w.factions, r.controller)}"></span>${esc(r.name)}${placed ? '' : ' <span class="muted small">(not on the map)</span>'}</button>`;
    }).join('') || '<span class="muted">No regions yet.</span>';
  }
  function geometry() { const w = world(); return D.geometry(w.regions || [], w.map || null, w.id || cw.folder); }
  function renderCanvas() {
    const el = $('cCanvas');
    if (!el) return;
    const w = world();
    const g = geometry();
    const vb = ui.vb || g.full;
    const unit = vb[2] / 120; // handle size that stays the same on screen
    let overlay = '';
    const sh = w.map && ui.sel && w.map.regions && w.map.regions[ui.sel];
    if (sh && sh.polygon && ui.mode === 'select') overlay += sh.polygon.map((p, i) => `<circle class="c-handle" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="${unit}"/>`).join('');
    if (ui.drawing.length) {
      overlay += `<polyline class="c-draw" points="${ui.drawing.map((p) => p.join(',')).join(' ')}" style="stroke-width:${unit / 3}"/>`;
      overlay += ui.drawing.map((p, i) => `<circle class="c-draw-pt${i === 0 ? ' first' : ''}" cx="${p[0]}" cy="${p[1]}" r="${i === 0 ? unit * 1.3 : unit * 0.8}"/>`).join('');
    }
    const roomList = rooms();
    const placed = w.map ? Object.entries(w.map.locations || {}).map(([id, p]) => ({ x: p[0], y: p[1], name: (roomList.find((r) => r.id === id) || { name: id }).name })) : [];
    const imageUrl = w.map ? assetUrl(w.map.image) : null;
    el.innerHTML = D.worldSvg({ g, regions: w.regions || [], factions: w.factions, selected: ui.sel, imageUrl, viewBox: vb, id: 'cSvg', view: 'world', label: 'Map being edited', rooms: placed, overlay })
      + (w.map && !imageUrl ? `<div class="c-missing">The image <b>${esc(w.map.image)}</b> isn't loaded. Pick it again with <b>Change image</b> (shapes stay where they are).</div>` : '');
  }
  function render() {
    renderTabs();
    if (!cw) return;
    const tab = TABS.find((t) => t.id === ui.tab);
    $('cMain').innerHTML = tab && tab.render ? tab.render() : '';
    if (ui.tab === 'map') { renderRegionList(); renderCanvas(); }
    renderValidation();
  }

  // ---------- map tab events ----------
  const toSvg = (ev) => {
    const svg = $('cSvg');
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    const r = m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
    return [Math.round(r.x), Math.round(r.y)];
  };
  function addRegion(name) {
    const w = world();
    const id = M.slug(name || 'new region', (w.regions || []).map((r) => r.id).concat(rooms().map((r) => r.id)));
    w.regions = (w.regions || []).concat([{ id, name: name || 'New region', controller: null, tags: [], status: '', neighbours: [], lore: '' }]);
    ui.autoIds.add(id);
    // The first region: every start begins in it, so the world stays valid.
    if (w.regions.length === 1) Object.values(starts()).forEach((st) => { if (!st.region) st.region = id; });
    ui.sel = id;
    return id;
  }
  function finishDrawing() {
    const w = world();
    if (ui.drawing.length < 3 || !w.map) return;
    const id = ui.sel || addRegion();
    w.map.regions = w.map.regions || {};
    w.map.regions[id] = { polygon: ui.drawing.slice() };
    ui.drawing = [];
    ui.mode = 'select';
    changed();
  }
  let drag = null;
  $('cMain').addEventListener('pointerdown', (ev) => {
    if (!cw || !ev.target.closest || !ev.target.closest('#cSvg')) return;
    const handle = ev.target.closest('.c-handle');
    drag = { start: [ev.clientX, ev.clientY], moved: false, vb: (ui.vb || geometry().full).slice(), vertex: handle && !ev.altKey ? Number(handle.dataset.i) : null };
    if (drag.vertex != null) { try { $('cSvg').setPointerCapture(ev.pointerId); } catch (e) {} }
  });
  $('cMain').addEventListener('pointermove', (ev) => {
    if (!drag || !cw) return;
    const dx = ev.clientX - drag.start[0], dy = ev.clientY - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const w = world();
    if (drag.vertex != null) {
      w.map.regions[ui.sel].polygon[drag.vertex] = toSvg(ev);
      renderCanvas();
    } else if (ui.mode === 'select') {
      const rect = $('cSvg').getBoundingClientRect();
      const [x, y, vw, vh] = drag.vb;
      ui.vb = [x - dx * (vw / rect.width), y - dy * (vh / rect.height), vw, vh];
      renderCanvas();
    }
  });
  $('cMain').addEventListener('pointerup', (ev) => {
    if (!drag || !cw) return;
    const d = drag;
    drag = null;
    const w = world();
    if (d.vertex != null && d.moved) return changed(['canvas']);
    if (d.moved || !ev.target.closest || !ev.target.closest('#cSvg')) return;
    const p = toSvg(ev);
    const handle = ev.target.closest('.c-handle');
    if (ui.mode === 'select') {
      if (handle && ev.altKey) {
        const poly = w.map.regions[ui.sel].polygon;
        w.map.regions[ui.sel].polygon = M.removeVertex(poly, Number(handle.dataset.i));
        return changed(['canvas']);
      }
      const g = ev.target.closest('.region-g');
      const id = g ? g.dataset.region : w.map ? M.regionAt(w.map, p) : null;
      ui.sel = id;
      ui.confirmDelete = false;
      return render();
    }
    if (!w.map) return;
    if (ui.mode === 'draw') {
      const unit = (ui.vb || geometry().full)[2] / 120;
      if (ui.drawing.length >= 3 && Math.hypot(p[0] - ui.drawing[0][0], p[1] - ui.drawing[0][1]) <= unit * 2) return finishDrawing();
      ui.drawing.push(p);
      return renderCanvas();
    }
    if (ui.mode === 'point') {
      if (!ui.sel) return banner('Pick a region first, then place it.');
      w.map.regions = w.map.regions || {};
      w.map.regions[ui.sel] = { point: p };
      return changed();
    }
    if (ui.mode === 'room') {
      if (!ui.room) return banner('Pick a room first, then click where it is.');
      w.map.locations = w.map.locations || {};
      w.map.locations[ui.room] = p;
      return changed();
    }
  });
  $('cMain').addEventListener('dblclick', (ev) => {
    if (!cw || ui.mode !== 'select' || !ev.target.closest || !ev.target.closest('#cSvg')) return;
    const w = world();
    const sh = w.map && ui.sel && w.map.regions && w.map.regions[ui.sel];
    if (!sh || !sh.polygon) return;
    const p = toSvg(ev);
    const e = M.nearestEdge(sh.polygon, p);
    if (e.dist > (ui.vb || geometry().full)[2] / 40) return;
    sh.polygon = M.insertVertex(sh.polygon, e.index, p);
    changed(['canvas']);
  });
  $('cMain').addEventListener('wheel', (ev) => {
    if (!cw || !ev.target.closest || !ev.target.closest('#cSvg')) return;
    ev.preventDefault();
    zoom(ev.deltaY > 0 ? 1.15 : 1 / 1.15, toSvg(ev));
  }, { passive: false });
  function zoom(f, at) {
    const full = geometry().full;
    const [x, y, w, h] = ui.vb || full;
    const nw = Math.min(full[2] * 3, Math.max(full[2] / 12, w * f)), nh = h * (nw / w);
    const [px, py] = at || [x + w / 2, y + h / 2];
    ui.vb = [px - (px - x) * (nw / w), py - (py - y) * (nh / h), nw, nh];
    renderCanvas();
  }
  document.addEventListener('keydown', (ev) => {
    if (!cw || ui.tab !== 'map' || ui.mode !== 'draw' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (ev.key === 'Enter') { ev.preventDefault(); finishDrawing(); }
    else if (ev.key === 'Escape') { ui.drawing = []; renderCanvas(); }
    else if (ev.key === 'Backspace') { ev.preventDefault(); ui.drawing.pop(); renderCanvas(); }
  });
  $('cMain').addEventListener('click', (ev) => {
    if (!cw) return;
    const t = ev.target;
    const w = world();
    const mode = t.closest('[data-mode]');
    if (mode) { ui.mode = mode.dataset.mode; ui.drawing = []; return render(); }
    const z = t.closest('[data-czoom]');
    if (z) { if (z.dataset.czoom === 'reset') { ui.vb = null; return renderCanvas(); } return zoom(z.dataset.czoom === 'in' ? 1 / 1.4 : 1.4); }
    const sel = t.closest('[data-sel]');
    if (sel) { ui.sel = sel.dataset.sel; ui.confirmDelete = false; return render(); }
    if (t.id === 'cAddRegion') { addRegion(); return changed(); }
    if (t.id === 'cNoImage') { delete w.map; ui.vb = null; return changed(); }
    if (t.id === 'cAddTouching') {
      M.suggestNeighbours(w.map).filter((p) => p.includes(ui.sel)).forEach(([a, b]) => M.setNeighbour(w, a, b, true));
      return changed();
    }
    if (t.id === 'cDeleteRegion') {
      if (!ui.confirmDelete) { ui.confirmDelete = true; return render(); }
      const notes = M.deleteRegion(w, starts(), ui.sel, cw.files);
      ui.sel = null;
      ui.confirmDelete = false;
      banner(notes.length ? esc(notes.join('; ')) : '');
      return changed();
    }
    const un = t.closest('[data-unplace]');
    if (un) { delete w.map.locations[un.dataset.unplace]; return changed(); }
  });
  // Typing updates the map and list without redrawing the form (keeps focus).
  $('cMain').addEventListener('input', (ev) => {
    if (!cw) return;
    const t = ev.target;
    const w = world();
    const r = ui.sel && (w.regions || []).find((x) => x.id === ui.sel);
    if (!r || !t.dataset.field) return;
    const f = t.dataset.field;
    if (f === 'name') {
      r.name = t.value;
      // A new region takes its id from its name until saved elsewhere.
      if (ui.autoIds.has(r.id) && t.value.trim()) {
        const id = M.slug(t.value, (w.regions || []).filter((x) => x !== r).map((x) => x.id).concat(rooms().map((x) => x.id)));
        if (id !== r.id) { ui.autoIds.delete(r.id); M.renameRegion(w, starts(), r.id, id, cw.files); ui.autoIds.add(id); ui.sel = id; }
      }
    } else if (f === 'tags') r.tags = t.value.split(',').map((x) => x.trim()).filter(Boolean);
    else if (f === 'status') r.status = t.value;
    else if (f === 'lore') { r.lore = t.value; const c = $('cLoreCount'); if (c) c.textContent = `${t.value.length}/400`; }
    else return;
    changed(['canvas', 'list']);
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw) return;
    const t = ev.target;
    const w = world();
    if (t.id === 'cImage' && t.files && t.files[0]) return loadImage(t.files[0]);
    if (t.id === 'cRoomPick') { ui.room = t.value; if (t.value) ui.mode = 'room'; return render(); }
    if (t.dataset.startregion) { starts()[t.dataset.startregion].region = t.value || undefined; return changed(); }
    if (t.dataset.fcolor) {
      const f = (w.factions || []).find((x) => x.id === t.dataset.fcolor);
      if (t.value) f.color = Number(t.value); else delete f.color;
      return changed();
    }
    const r = ui.sel && (w.regions || []).find((x) => x.id === ui.sel);
    if (!r) return;
    if (t.dataset.field === 'controller') { r.controller = t.value || null; return changed(); }
    if (t.dataset.neigh) { M.setNeighbour(w, r.id, t.dataset.neigh, t.checked); return changed(); }
  });

  // ---------- export ----------
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  // Every image the world uses: the map, floor plans, portraits, stand-ins.
  function imagePaths() {
    const w = world();
    const out = new Set(Object.keys(cw.assets));
    if (w.map) out.add(w.map.image);
    if (w.localMap) out.add(w.localMap.image);
    (w.portraitSet || []).forEach((p) => out.add(p));
    Object.entries(cw.files).forEach(([path, j]) => {
      if (path.startsWith('characters/') && j && j.portrait) out.add(j.portrait);
      if (path.startsWith('starts/') && j && j.localMap) out.add(j.localMap.image);
    });
    return [...out].filter(E.isImagePath);
  }
  $('cExport').addEventListener('click', async () => {
    if (!cw) return;
    const entries = Object.entries(cw.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, j]) => ({ name: `${cw.folder}/${path}`, data: E.Zip.utf8(JSON.stringify(j, null, 2) + '\n') }));
    const missing = [];
    for (const path of imagePaths()) {
      try {
        let data;
        if (cw.assets[path]) data = new Uint8Array(await cw.assets[path].arrayBuffer());
        else {
          const url = assetUrl(path);
          const res = url && (await fetch(url));
          if (!res || !res.ok) throw new Error('not found');
          data = new Uint8Array(await res.arrayBuffer());
        }
        entries.push({ name: `${cw.folder}/${path}`, data });
      } catch (e) { missing.push(path); }
    }
    download(`${cw.folder}.zip`, new Blob([E.Zip.build(entries)], { type: 'application/zip' }));
    const r = check();
    banner(`Exported ${esc(cw.folder)}.zip.${missing.length ? ` Not included (not loaded): ${esc(missing.join(', '))}.` : ''}${r.problems.length ? ' It still has problems the game will refuse; see below.' : ''}`, r.problems.length || missing.length ? 'bad' : '');
  });
  $('cJson').addEventListener('click', () => {
    if (cw) download('world.json', new Blob([JSON.stringify(world(), null, 2) + '\n'], { type: 'application/json' }));
  });

  // ---------- opening worlds ----------
  $('cWorld').addEventListener('change', async () => {
    const v = $('cWorld').value;
    if (!v) return;
    try {
      if (v.startsWith('disk:')) { const d = diskWorlds.get(v); return open(d.folder, d.files, d.assets, false); }
      const folder = v.slice('server:'.length);
      open(folder, await S.fetchWorldFiles(folder), {}, true);
    } catch (err) { banner(`Couldn't open that world: ${esc(err.message)}`, 'bad'); }
  });
  $('cFolder').addEventListener('change', async (ev) => {
    try {
      const { worlds, errors } = await S.readFolderFiles(ev.target.files);
      if (!worlds.length) throw new Error(errors.join('\n') || 'No world.json or scenario.json found in that folder.');
      worlds.forEach((w, i) => {
        diskWorlds.set('disk:' + w.folder, w);
        const o = document.createElement('option');
        o.value = 'disk:' + w.folder;
        o.textContent = `${(w.files['world.json'] || w.files['scenario.json']).title || w.folder} (disk)`;
        $('cWorld').appendChild(o);
        if (i === 0) $('cWorld').value = o.value;
      });
      const d = diskWorlds.get($('cWorld').value);
      open(d.folder, d.files, d.assets, false);
    } catch (err) { banner(`Couldn't open that folder: ${esc(err.message)}`, 'bad'); }
    ev.target.value = '';
  });
  (async () => {
    renderTabs();
    if (location.protocol === 'file:') return;
    try {
      (await S.listServer()).forEach((w) => {
        const o = document.createElement('option');
        o.value = 'server:' + w.folder;
        o.textContent = w.title || w.folder;
        $('cWorld').appendChild(o);
      });
    } catch (e) { /* opened without the server: folder picker only */ }
  })();
})();
