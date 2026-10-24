// The creator (task 3-5): a separate page for building worlds without
// editing JSON. It keeps a working copy of one world's raw files in memory
// and in localStorage (images by object URL only, never stored), validates
// it live with the game's own Scenario checks, and exports the world folder
// as a zip. The only creator file that touches the DOM; the editing logic is
// in mapedit.js, drawing in mapdraw.js. Tabs are a registry so later phases
// add their own.
(function () {
  const E = window.Ensemble;
  const S = E.Scenario, M = E.MapEdit, D = E.MapDraw, LE = E.LoreEdit, WE = E.WorldEdit;
  const $ = (id) => document.getElementById(id);
  const esc = D.esc;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    keys() { try { return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)); } catch (e) { return []; } },
  };
  const SAVE_KEY = (folder) => `ensemble.creator.${folder}`;

  // The working copy: { folder, files: {path: JSON}, assets: {path: File|Blob}, server }
  let cw = null;
  // Map tab state.
  const ui = { tab: 'map', mode: 'select', sel: null, drawing: [], room: '', vb: null, autoIds: new Set(), confirmDelete: false, piece: null, place: null, addPiece: false, mapOwner: null, kindOpen: null, confirmDropMap: null };
  // Lore and timeline tabs (task 5-3): the entry or event being edited, the
  // region a link from the map points at, and the lore test box's inputs.
  const lui = { sel: null, confirm: false, focus: null, test: { startId: '', room: '', action: '', scene: '' } };
  const tui = { sel: null, confirm: false, focus: null, startId: '', effectsError: '' };
  // World, groups and starts tabs (task 6-1).
  const gui = { sel: null, confirm: false };
  const sui = { sel: null, confirm: false, confirmRoom: null, newPerson: false, openRoom: null };
  // Characters tab (task 6-2): the person being edited, the form's values and
  // scenario, and a card being imported.
  const cui = { sel: null, confirm: false, sc: null, form: null, errors: [], review: null, cf: null };
  // Sites tab (task 6-3): the map and room being edited, the tool, the view,
  // the matching box and a save being read.
  const XUI = () => ({ sel: null, room: null, mode: 'select', drawing: [], vb: null, snap: true, doorKind: 'door', spotKind: 'cover', preview: false, confirm: false, roomConfirm: false, match: { kind: '', setting: '' }, save: null });
  const xui = XUI();
  const urls = new Map(); // asset path -> object URL
  const diskWorlds = new Map(); // "disk:folder" -> { folder, files, assets }

  // ---------- tabs ----------
  const TABS = [
    // Task 6-1.
    { id: 'world', label: 'World', render: renderWorldTab },
    { id: 'groups', label: 'Groups', render: renderGroupsTab },
    { id: 'map', label: 'Map', render: renderMapTab },
    // Task 6-3.
    { id: 'sites', label: 'Sites', render: renderSitesTab },
    // Task 5-3. Lore is public: no secrets; the future goes in the timeline.
    { id: 'lore', label: 'Lore', render: renderLoreTab },
    { id: 'timeline', label: 'Timeline', render: renderTimelineTab },
    // Task 6-2.
    { id: 'characters', label: 'Characters', render: renderCharactersTab },
    { id: 'starts', label: 'Starts', render: renderStartsTab },
    { id: 'portraits', label: 'Portraits', render: renderPortraitsTab },
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
  const normalise = (files) => WE.fromFiles(files);
  function banner(html, cls) {
    const el = $('cBanner');
    el.className = `c-banner${html ? '' : ' hidden'}${cls ? ' ' + cls : ''}`;
    el.innerHTML = html || '';
  }
  // draft: a world that exists only in this browser (made with New world,
  // or edits kept from a folder that isn't on the server).
  function open(folder, files, assets, server, draft) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
    const original = normalise(JSON.parse(JSON.stringify(files)));
    cw = { folder, files: original, assets: Object.assign({}, assets || {}), server: !!server, original, draft: !!draft };
    Object.assign(ui, { mode: 'select', sel: null, drawing: [], room: '', vb: null, confirmDelete: false, piece: null, place: null, addPiece: false });
    Object.assign(lui, { sel: null, confirm: false, focus: null, test: { startId: '', room: '', action: '', scene: '' } });
    Object.assign(tui, { sel: null, confirm: false, focus: null, startId: '', effectsError: '' });
    Object.assign(gui, { sel: null, confirm: false });
    Object.assign(sui, { sel: null, confirm: false, confirmRoom: null, newPerson: false, openRoom: null });
    Object.assign(cui, { sel: null, confirm: false, sc: null, form: null, errors: [], review: null, cf: null });
    Object.assign(xui, XUI());
    ui.autoIds = new Set();
    Object.assign(ui, { mapOwner: null, kindOpen: null, confirmDropMap: null });
    banner('');
    let saved = null;
    try { saved = JSON.parse(store.get(SAVE_KEY(folder))); } catch (e) { saved = null; }
    if (draft) banner('This world is kept only in this browser until you export it. <button type="button" id="cDeleteDraft" class="small">Delete this draft</button>');
    else if (saved && saved.files && saved.files['world.json']) {
      cw.files = saved.files;
      banner(`Restored your unsaved edits from ${esc(new Date(saved.at).toLocaleString())}. <button type="button" id="cDiscard" class="small">Discard edits</button>`);
    }
    $('cExport').disabled = false;
    $('cJson').disabled = false;
    $('cTest').disabled = false;
    render();
    recropIfMissing();
  }
  $('cBanner').addEventListener('click', (ev) => {
    if (ev.target.id === 'cDeleteDraft' && cw) {
      if (!cw.confirmDraft) { cw.confirmDraft = true; ev.target.textContent = 'Click again to delete it for good'; return; }
      store.del(SAVE_KEY(cw.folder));
      const opt = Array.from($('cWorld').options).find((o) => o.value === 'draft:' + cw.folder);
      if (opt) opt.remove();
      cw = null;
      $('cWorld').value = '';
      ['cExport', 'cJson', 'cTest'].forEach((id) => ($(id).disabled = true));
      $('cMain').innerHTML = '<div class="c-empty">Draft deleted. Pick a world to edit, or make a new one.</div>';
      banner('');
      return render();
    }
    if (ev.target.id === 'cNewGo') return newWorld($('cNewTitle').value);
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
    const c = cw;
    saveTimer = setTimeout(() => store.set(SAVE_KEY(c.folder), JSON.stringify({ files: c.files, at: Date.now(), draft: c.draft || undefined })), 400);
    clearTimeout(checkTimer);
    checkTimer = setTimeout(renderValidation, 250);
    const PARTS = { all: render, canvas: renderCanvas, list: renderRegionList, lorelist: renderLoreList, evlist: renderEventList, startlist: renderStartList, charlist: renderCharList, sitecanvas: renderSiteCanvas, sitelist: renderSiteList, grouplist: renderGroupList, genre: renderGenre, preview: renderPreview };
    (parts || ['all']).forEach((p) => PARTS[p] && PARTS[p]());
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
      // By id ("region "x"") or by name: tree and route messages name regions (R-1).
      const reg = (world().regions || []).find((x) => x.id === ui.sel);
      const named = reg && reg.name && reg.name.length >= 3 ? reg.name : null;
      const mine = r.problems.filter((p) => p.includes(`"${ui.sel}"`) || (named && p.includes(named)));
      form.innerHTML = mine.map((p) => `<div class="bad small">${esc(p)}</div>`).join('');
    }
    // The lore entry or timeline event being edited: its own problems and warnings.
    const own = (el, key) => {
      if (!el) return;
      el.innerHTML = r.problems.filter((p) => p.includes(key)).map((p) => `<div class="bad small">${esc(p)}</div>`).join('') +
        r.warnings.filter((p) => p.includes(key)).map((p) => `<div class="muted small">${esc(p)}</div>`).join('');
    };
    if (lui.sel) own($('cLoreProblems'), `lore "${lui.sel}"`);
    if (tui.sel) own($('cEventProblems'), `timeline "${tui.sel}"`);
    if (sui.sel) own($('cStartProblems'), `start "${sui.sel}"`);
    if (cui.sel) own($('cCharProblems'), `character "${cui.sel}"`);
    if (ui.tab === 'sites') renderSiteChecks();
    if (gui.sel) own($('cGroupProblems'), `"${gui.sel}"`);
    const wp = $('cWorldProblems');
    if (wp) wp.innerHTML = r.problems.filter((p) => !/^start "/.test(p)).map((p) => `<div class="bad small">${esc(p)}</div>`).join('');
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
  // ---------- which map is being edited (R-4) ----------
  // The world's map, or a region's own (R-3). mh() is what holds it (the
  // world or that region), so every tool below edits mh().map; mapPath() is
  // where it is in world.json, for bound fields.
  const ownerRegion = () => (ui.mapOwner ? (world().regions || []).find((r) => r.id === ui.mapOwner) || null : null);
  function mh() { const r = ownerRegion(); if (!r) ui.mapOwner = null; return r || world(); }
  const mapPath = () => { const r = ownerRegion(); return r ? `regions.${world().regions.indexOf(r)}.map` : 'map'; };
  // Regions this map can show: all for the world's, those inside the owner for a region's.
  const insideOwner = (id) => !ui.mapOwner || (id !== ui.mapOwner && S.regionChainIn(world().regions || [], id).includes(ui.mapOwner));
  const regionsHere = () => (world().regions || []).filter((r) => insideOwner(r.id));
  const mapName = () => (ownerRegion() ? `${ownerRegion().name}'s map` : 'the world map');
  function loadImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = world();
      const path = 'maps/' + file.name.replace(/[^\w .-]+/g, '_');
      const width = img.naturalWidth || 800, height = img.naturalHeight || 600;
      const scaleX = mh().map ? width / mh().map.width : 1, scaleY = mh().map ? height / mh().map.height : 1;
      // Shapes drawn on a previous image are scaled to the new one.
      const scale = (p) => [Math.round(p[0] * scaleX), Math.round(p[1] * scaleY)];
      const regions = {};
      Object.entries((mh().map && mh().map.regions) || {}).forEach(([id, sh]) => (regions[id] = sh.polygons ? { polygons: sh.polygons.map((r) => r.map(scale)) } : sh.polygon ? { polygon: sh.polygon.map(scale) } : { point: scale(sh.point) }));
      const locations = {};
      Object.entries((mh().map && mh().map.locations) || {}).forEach(([id, p]) => (locations[id] = scale(p)));
      const places = ((mh().map && mh().map.places) || []).map((pl) => Object.assign({}, pl, { at: scale(pl.at) }));
      // Another picture: where it is on the globe isn't known any more.
      if (mh().map && mh().map.projection) banner('The new picture has no latitude and longitude: to keep them, crop it with npm run basemap instead.');
      mh().map = Object.assign({ image: path, width, height, regions, locations }, places.length ? { places } : {});
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
    place: 'Click where a town or city is to add it as a named place (task 4-5): the story knows it by name.',
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
          ${M.maps(w).length > 1 || ui.mapOwner ? `<label class="c-row small">Editing <select id="cMapOwner" aria-label="Which map">${M.maps(w).map((m) => `<option value="${esc(m.owner || '')}"${(m.owner || null) === (ui.mapOwner || null) ? ' selected' : ''}>${m.owner ? `${esc(regions.find((r) => r.id === m.owner).name)}'s map` : 'the world map'}</option>`).join('')}${ui.mapOwner && !mh().map ? `<option value="${esc(ui.mapOwner)}" selected>${esc(ownerRegion().name)}'s map (no image yet)</option>` : ''}</select></label><span class="sep"></span>` : ''}
          ${['select', 'draw', 'point', 'room', 'place'].map((m) => `<button type="button" data-mode="${m}" aria-pressed="${ui.mode === m}">${({ select: 'Select', draw: 'Draw region', point: 'Point', room: 'Place room', place: 'Add place' })[m]}</button>`).join('')}
          ${ui.mode === 'draw' ? `<label class="c-check small"><input type="checkbox" id="cAddPiece"${ui.addPiece ? ' checked' : ''}> add as another piece</label>` : ''}
          <span class="sep"></span>
          <label class="btn">${mh().map ? 'Change image' : 'Load image'}<input type="file" id="cImage" accept="image/*" hidden></label>
          ${mh().map ? '<button type="button" id="cNoImage" title="Use the automatic node map instead">Remove image</button>' : ''}
          <span class="zoom"><button type="button" data-czoom="in" aria-label="Zoom in">+</button><button type="button" data-czoom="out" aria-label="Zoom out">−</button><button type="button" data-czoom="reset" aria-label="Reset the view">⟲</button></span>
        </div>
        <div id="cCanvas" class="c-canvas"></div>
        <div class="c-hint" id="cHint">${esc(mh().map ? HINTS[ui.mode] + (ui.mapOwner ? ` This is ${mapName()}: it shows the regions inside ${ownerRegion().name}.` : '') : ui.mapOwner ? `Load a picture for ${ownerRegion().name}: it will show the regions inside it.` : 'Load a map image to draw regions on it. Without one, the game lays the regions out from their neighbours, as shown here.')} <span id="cCoords" class="c-coords"></span></div>
      </div>
      <aside class="c-panel">
        <section><h3>Regions</h3><p class="muted small">A list is a whole world. Drag a region onto another to put it inside; drop it on <i>Top level</i> to take it out.</p>
          <div id="cRegionList" class="c-list c-tree"></div>
          <button type="button" id="cAddRegion" class="small">+ Region</button>${ui.sel && regions.some((r) => r.id === ui.sel) ? ` <button type="button" id="cAddInside" class="small">+ Inside ${esc(regions.find((r) => r.id === ui.sel).name)}</button> <button type="button" id="cAddNext" class="small">+ Next to it</button>` : ''}</section>
        <section id="cRegionForm">${regionForm()}</section>
        ${mh().map ? `<section><h3>Rooms on the map</h3><select id="cRoomPick" aria-label="Room to place"><option value="">Pick a room…</option>${rooms().map((r) => `<option value="${esc(r.id)}"${r.id === ui.room ? ' selected' : ''}>${esc(r.name)}${r.from !== 'world' ? ` (${esc(r.from)})` : ''}${mh().map.locations && mh().map.locations[r.id] ? ' ✓' : ''}</option>`).join('')}</select>
          <ul class="c-placed">${Object.keys(mh().map.locations || {}).map((id) => `<li>${esc((rooms().find((r) => r.id === id) || { name: id }).name)} <span class="muted">${esc(M.regionAt(mh().map, mh().map.locations[id]) || 'outside every region')}</span> <button type="button" class="small ghost" data-unplace="${esc(id)}" aria-label="Remove ${esc(id)} from the map">✕</button></li>`).join('')}</ul></section>` : ''}
        ${mh().map ? placesSection(w) : ''}
        ${regions.length ? `<section><h3>Where each start begins</h3>${startList.map(([sid, st]) => `<label class="c-row">${esc(st.title || sid)} <select data-startregion="${esc(sid)}">${regions.map((r) => `<option value="${esc(r.id)}"${st.region === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}${st.region ? '' : '<option value="" selected>(none)</option>'}</select></label>`).join('')}</section>` : ''}
        ${regions.length > 1 ? routeKindsSection(w) : ''}
        ${factions.length ? `<section><h3>Group colours</h3>${factions.map((f) => `<label class="c-row"><span><span class="swatch ${D.factionClass(factions, f.id)}"></span>${esc(f.name)}</span> <select data-fcolor="${esc(f.id)}"><option value="">auto</option>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}"${f.color === n ? ' selected' : ''}>colour ${n}</option>`).join('')}</select></label>`).join('')}</section>` : ''}
      </aside>
    </div>`;
  }
  // The route kinds table (R-4): the built-in kinds and the world's own,
  // each with its time, whether it's risky and what it needs; the world
  // keeps only what differs from the defaults (routeKinds).
  function routeKindsSection(w) {
    const refs = LE.refs(cw.files);
    const rows = M.routeKindRows(w).map((k) => `<details class="c-kind"${ui.kindOpen === k.kind ? ' open' : ''} data-kindcard="${esc(k.kind)}"><summary><b>${esc(k.kind)}</b> <span class="muted small">${esc(k.time)}${k.risky ? ', risky' : ''}${k.requires ? ', needs something' : ''}${k.builtIn ? '' : ' (this world\'s own)'}</span></summary>
      <div class="c-row2"><label>Time <input data-kind="${esc(k.kind)}" data-kf="time" value="${esc(k.time)}" placeholder="45m, 4h, 2d" size="8"></label>
      <label class="c-check small"><input type="checkbox" data-kind="${esc(k.kind)}" data-kf="risky"${k.risky ? ' checked' : ''}> risky: the player can try anyway, as a roll</label></div>
      <label>Roll with <select data-kind="${esc(k.kind)}" data-kf="skill"><option value="">stealth, or the first skill</option>${(w.skills || E.DEFAULT_SKILLS).map((s) => `<option value="${esc(s)}"${k.skill === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <div class="small">Needs: ${k.requires ? preRow(LE.rowOf(k.requires), `k:${k.kind}`, refs, 'rq') : `<button type="button" class="small" data-rqadd="k:${esc(k.kind)}">+ a condition</button>`}</div>
      ${k.builtIn ? '' : `<button type="button" class="small danger" data-kinddel="${esc(k.kind)}">Remove this kind</button>`}</details>`).join('');
    return `<section><h3>Route kinds</h3><p class="muted small">How each way of travelling works in this world. A route's own time or needs win over its kind's.</p>${rows}
      <div class="c-row"><input id="cNewKind" placeholder="ferry, mule track…" maxlength="30" aria-label="A new kind"> <button type="button" id="cAddKind" class="small">+ Kind</button></div></section>`;
  }
  // Named places on the map (task 4-5): capitals, cities, towns. Bound fields
  // on world.json; latitude and longitude when the map is projected.
  function placesSection(w) {
    const list = mh().map.places || [];
    const i = list.findIndex((pl) => pl.id === ui.place);
    const pl = list[i];
    const G = E.Geo;
    let form = '';
    if (pl) {
      const ll = G.projected(mh().map) && Array.isArray(pl.at) ? G.toLonLat(mh().map, pl.at) : null;
      form = `<div class="c-card">${fld('world.json', `${mapPath()}.places.${i}.name`, 'text', 'Name', { max: 60, live: 'canvas' })}
        <div class="c-row2">${fld('world.json', `${mapPath()}.places.${i}.kind`, 'text', 'Kind', { blank: 'place', options: ['capital', 'city', 'town'].map((x) => ({ id: x, name: x })) })}
        ${fld('world.json', `${mapPath()}.places.${i}.region`, 'text', 'Region', { blank: 'none', options: idList(w.regions) })}</div>
        ${ll ? `<div class="c-row2"><label>Latitude <input type="number" step="0.01" data-placell="1" value="${ll[1].toFixed(2)}"></label><label>Longitude <input type="number" step="0.01" data-placell="0" value="${ll[0].toFixed(2)}"></label></div>` : ''}
        ${fld('world.json', `${mapPath()}.places.${i}.notable`, 'bool', 'Named on the map even zoomed out')}
        <button type="button" id="cDelPlace" class="small danger">Remove place</button></div>`;
    }
    return `<section><h3>Places <span class="muted small">${list.length}</span></h3>
      <select id="cPlacePick" aria-label="A place on the map"><option value="">${list.length ? 'Pick a place…' : 'No places yet: use Add place'}</option>${list.map((x) => `<option value="${esc(x.id)}"${x.id === ui.place ? ' selected' : ''}>${esc(x.name)}${x.kind === 'capital' ? ' ★' : ''}</option>`).join('')}</select>
      ${form}</section>`;
  }
  function regionForm() {
    const w = world();
    const r = ui.sel && (w.regions || []).find((x) => x.id === ui.sel);
    if (!r) return '<p class="muted">Pick a region on the map or in the list, or add one.</p>';
    const others = (w.regions || []).filter((x) => x.id !== r.id);
    const touching = new Set(mh().map ? M.suggestNeighbours(mh().map).filter((p) => p.includes(r.id)).map((p) => (p[0] === r.id ? p[1] : p[0])) : []);
    const sh = mh().map && mh().map.regions && mh().map.regions[r.id];
    return `<h3>${esc(r.name)} <span class="muted small">(${esc(r.id)})</span></h3>
      <div id="cRegionProblems"></div>
      <label>Name <input data-field="name" value="${esc(r.name)}" maxlength="40"></label>
      <label>Inside <select data-field="parent"><option value="">the world (top level)</option>${M.parentChoices(w, r.id).map((x) => `<option value="${esc(x.id)}"${r.parent === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>Label <span class="muted small">(a word such as province, city or planet; display only)</span><input data-field="label" value="${esc(r.label || '')}" maxlength="30" placeholder="${esc((w.regionLabels || [])[S.regionChainIn(w.regions, r.id).length - 1] || '')}"></label>
      <label>Held by <select data-field="controller"><option value="">no one</option>${(w.factions || []).map((f) => `<option value="${esc(f.id)}"${r.controller === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label>Start here <span class="muted small">(for Make my own start)</span><select data-field="startable"><option value="">as the region it's in</option><option value="true"${r.startable === true ? ' selected' : ''}>yes, and everywhere inside it</option><option value="false"${r.startable === false ? ' selected' : ''}>no, nor anywhere inside it</option></select></label>
      <label class="c-check"><input type="checkbox" data-field="hidden"${r.known === false ? ' checked' : ''}> Hidden until the story reveals it <span class="muted small">(and everything inside it)</span></label>
      ${(w.factions || []).length ? `<fieldset class="c-neigh"><legend>Present here <span class="muted small">(0 to 1; several groups can be; empty: none)</span></legend>${(w.factions || []).map((f) => `<label class="c-row"><span><span class="swatch ${D.factionClass(w.factions, f.id)}"></span>${esc(f.name)}</span> <input type="number" min="0" max="1" step="0.05" data-presence="${esc(f.id)}" value="${esc(((w.presence || {})[f.id] || {})[r.id] ?? '')}" aria-label="${esc(f.name)} present in ${esc(r.name)}"></label>`).join('')}</fieldset>` : ''}
      <label>Tags <span class="muted small">(comma-separated, up to ${S.REGION_TAGS})</span><input data-field="tags" value="${esc((r.tags || []).join(', '))}"></label>
      <label>Status <input data-field="status" value="${esc(r.status || '')}" maxlength="120"></label>
      <label>Lore summary <span class="muted small" id="cLoreCount">${(r.lore || '').length}/400</span> <span class="muted small">Public knowledge: secrets go in a character's secret, events still to come in the timeline.</span><textarea data-field="lore" rows="3" maxlength="400">${esc(r.lore || '')}</textarea></label>
      <fieldset class="c-neigh"><legend>Borders <span class="muted small">(next door: no travel time)</span></legend>${others.map((o) => `<label><input type="checkbox" data-neigh="${esc(o.id)}"${M.areNeighbours(w, r.id, o.id) ? ' checked' : ''}> ${esc(o.name)}${touching.has(o.id) ? ' <span class="muted small">(touching)</span>' : ''}</label>`).join('') || '<span class="muted">No other regions.</span>'}
        ${touching.size ? '<button type="button" id="cAddTouching" class="small">Add touching regions</button>' : ''}</fieldset>
      ${routeRows(w, r)}
      <div class="c-mapbtns small">${r.map ? `<span>🗺 Has its own map.</span> ${ui.mapOwner === r.id ? '' : `<button type="button" class="small" data-editmap="${esc(r.id)}">Edit its map</button>`} <button type="button" class="small danger" data-dropmap="${esc(r.id)}">${ui.confirmDropMap === r.id ? 'Click again to remove' : 'Remove its map'}</button>`
        : `<label class="btn small">Attach a map…<input type="file" data-attachmap="${esc(r.id)}" accept="image/*" hidden></label>${M.baseOf(w) && (S.library.baseMaps || {})[M.baseOf(w)] && M.regionBounds(w, r.id) ? ` <button type="button" class="small" data-cutmap="${esc(r.id)}">Cut from the base map</button>` : ''} <span class="muted">a picture of the regions inside ${esc(r.name)}</span>`}</div>
      <div class="muted small">${!insideOwner(r.id) ? `Not inside ${esc(ownerRegion().name)}, so not on ${esc(mapName())}.` : mh().map ? (sh ? (sh.polygon ? `Outlined with ${sh.polygon.length} corners.` : sh.polygons ? `Outlined in ${sh.polygons.length} pieces (islands and parts). Click a piece to pick it.` : 'Placed as a point.') : 'Not on the map yet: draw it or place it as a point.') : ''}</div>
      ${sh && sh.polygons && ui.piece != null && sh.polygons[ui.piece] ? `<button type="button" id="cRemovePiece" class="small">Remove piece ${ui.piece + 1} of ${sh.polygons.length}</button>` : ''}
      ${r.wiki && r.wiki.title ? `<div class="small">Wikipedia: <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(r.wiki.title.replace(/ /g, '_'))}" target="_blank" rel="noopener noreferrer">${esc(r.wiki.title)}</a> <span class="muted">(for the research helper)</span></div>` : ''}
      ${(() => { const u = LE.regionUse(cw.files, r.id); return `<div class="small c-uses">Lore: <button type="button" class="linkish" data-golore="${esc(r.id)}">${u.lore} entr${u.lore === 1 ? 'y' : 'ies'}</button> · Timeline: <button type="button" class="linkish" data-gotimeline="${esc(r.id)}">${u.events} event${u.events === 1 ? '' : 's'}</button></div>`; })()}
      <button type="button" id="cDeleteRegion" class="small danger">${ui.confirmDelete ? 'Click again to delete' : 'Delete region'}</button>`;
  }
  // A region's routes (R-2), each a row: where, how, how long, one way,
  // risky, and what it needs (the timeline's condition rows).
  function routeRows(w, r) {
    const refs = LE.refs(cw.files);
    const kinds = M.routeKindRows(w).map((k) => k.kind);
    const rows = (Array.isArray(r.routes) ? r.routes : []).map((x, i) => `<div class="c-route">
      <div class="c-row2"><label>To <select data-route="${i}" data-rf="to">${(w.regions || []).filter((o) => o.id !== r.id).map((o) => `<option value="${esc(o.id)}"${x.to === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
      <label>By <input data-route="${i}" data-rf="kind" value="${esc(x.kind || '')}" list="cKindList" placeholder="road" size="9"></label>
      <label>Time <input data-route="${i}" data-rf="time" value="${esc(x.time ?? '')}" placeholder="${esc((M.routeKindRows(w).find((k) => k.kind === (x.kind || 'border')) || {}).time || '1h')}" size="6"></label></div>
      <label class="c-check small"><input type="checkbox" data-route="${i}" data-rf="oneWay"${x.oneWay ? ' checked' : ''}> one way</label>
      <label class="c-check small"><input type="checkbox" data-route="${i}" data-rf="risky"${x.risky ? ' checked' : ''}> risky</label>
      <div class="small">Needs: ${x.requires ? preRow(LE.rowOf(x.requires), `r:${i}`, refs, 'rq') : `<button type="button" class="small" data-rqadd="r:${i}">+ a condition</button>`}</div>
      <button type="button" class="small ghost" data-routedel="${i}" aria-label="Remove this route">✕ Remove route</button></div>`).join('');
    return `<fieldset class="c-routes"><legend>Routes <span class="muted small">(travel with a kind, a time or a condition)</span></legend>${rows}
      <datalist id="cKindList">${kinds.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
      ${(w.regions || []).length > 1 ? '<button type="button" id="cAddRoute" class="small">+ Route</button>' : ''}</fieldset>`;
  }
  function renderRegionList() {
    const el = $('cRegionList');
    if (!el) return;
    const w = world();
    // In tree order, the regions inside another indented under it (R-1).
    const list = w.regions || [];
    const order = [];
    const walk = (id) => S.regionChildrenIn(list, id).forEach((c) => { order.push(list.find((x) => x.id === c)); walk(c); });
    walk(null);
    list.forEach((r) => { if (!order.includes(r)) order.push(r); }); // in a loop: listed anyway, validation says why
    // Each row can be dragged onto another (inside it) or onto Top level (R-4).
    el.innerHTML = (list.length > 1 ? '<div class="c-drop-top" data-droptop="1">Top level</div>' : '') + order.map((r) => {
      const kids = S.regionChildrenIn(list, r.id).length;
      const here = insideOwner(r.id);
      const placed = !here || !mh().map || kids || (mh().map.regions && mh().map.regions[r.id]);
      const depth = S.regionChainIn(list, r.id).length - 1;
      return `<button type="button" draggable="true" data-sel="${esc(r.id)}" aria-pressed="${r.id === ui.sel}"${depth ? ` style="margin-left:${depth}rem"` : ''}${here ? '' : ' class="c-outside"'}><span class="swatch ${D.factionClass(w.factions, r.controller)}"></span>${esc(r.name)}${r.map ? ' <span title="Has its own map">🗺</span>' : ''}${placed ? '' : ' <span class="muted small">(not on the map)</span>'}</button>`;
    }).join('') || '<span class="muted">No regions yet.</span>';
  }
  // What the canvas shows: the regions on the map being edited.
  function geometry() { const w = world(); return D.geometry(regionsHere(), mh().map || null, w.id || cw.folder); }
  function renderCanvas() {
    const el = $('cCanvas');
    if (!el) return;
    const w = world();
    const g = geometry();
    const vb = ui.vb || g.full;
    const unit = vb[2] / 120; // handle size that stays the same on screen
    let overlay = '';
    const sh = mh().map && ui.sel && mh().map.regions && mh().map.regions[ui.sel];
    // Handles on every piece of the selected region (task 4-5: islands).
    if (sh && ui.mode === 'select') E.Geo.pieces(sh).forEach((ring, k) => { overlay += ring.map((p, i) => `<circle class="c-handle${ui.piece === k ? ' piece' : ''}" data-i="${k}:${i}" cx="${p[0]}" cy="${p[1]}" r="${unit}"/>`).join(''); });
    const selPlace = mh().map && ui.place && (mh().map.places || []).find((x) => x.id === ui.place);
    if (selPlace) overlay += `<circle class="c-place-sel" cx="${selPlace.at[0]}" cy="${selPlace.at[1]}" r="${unit * 1.8}"/>`;
    if (ui.drawing.length) {
      overlay += `<polyline class="c-draw" points="${ui.drawing.map((p) => p.join(',')).join(' ')}" style="stroke-width:${unit / 3}"/>`;
      overlay += ui.drawing.map((p, i) => `<circle class="c-draw-pt${i === 0 ? ' first' : ''}" cx="${p[0]}" cy="${p[1]}" r="${i === 0 ? unit * 1.3 : unit * 0.8}"/>`).join('');
    }
    const roomList = rooms();
    const placed = mh().map ? Object.entries(mh().map.locations || {}).map(([id, p]) => ({ x: p[0], y: p[1], name: (roomList.find((r) => r.id === id) || { name: id }).name })) : [];
    const imageUrl = mh().map ? assetUrl(mh().map.image) : null;
    el.innerHTML = D.worldSvg({ g, regions: regionsHere(), factions: w.factions, selected: ui.sel, imageUrl, viewBox: vb, id: 'cSvg', view: 'world', label: 'Map being edited', rooms: placed, places: D.placesOf(mh().map), overlay })
      + (mh().map && !imageUrl ? `<div class="c-missing">The image <b>${esc(mh().map.image)}</b> isn't loaded. Pick it again with <b>Change image</b> (shapes stay where they are).</div>` : '');
  }
  // Replacing the tab blurs a focused field, whose change handler may ask
  // for another render while this one runs: that one waits and runs after.
  let rendering = false, renderAgain = false;
  function render() {
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    try {
      renderTabs();
      if (!cw) return;
      const tab = TABS.find((t) => t.id === ui.tab);
      $('cMain').innerHTML = tab && tab.render ? tab.render() : '';
      if (ui.tab === 'map') { renderRegionList(); renderCanvas(); }
      if (ui.tab === 'lore') { renderLoreList(); renderLoreTest(); }
      if (ui.tab === 'timeline') renderEventList();
      if (ui.tab === 'world') renderGenre();
      if (ui.tab === 'groups') renderGroupList();
      if (ui.tab === 'starts') { renderStartList(); renderPreview(); }
      if (ui.tab === 'characters') { renderCharList(); mountCharForm(); }
      if (ui.tab === 'sites') { renderSiteCanvas(); renderSiteMatch(); }
      renderValidation();
    } finally { rendering = false; }
    if (renderAgain) { renderAgain = false; render(); }
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
  // A new region: inside `parent` (default: the region whose map is being
  // edited, so it can go on that map; R-4), or at the top level.
  function addRegion(name, parent) {
    const w = world();
    const id = M.addRegion(w, name, parent === undefined ? ui.mapOwner : parent, rooms().map((r) => r.id));
    ui.autoIds.add(id);
    // The first region: every start begins in it, so the world stays valid.
    if (w.regions.length === 1) Object.values(starts()).forEach((st) => { if (!st.region) st.region = id; });
    ui.sel = id;
    return id;
  }
  // A region outside the one whose map this is can't be drawn on it.
  function notHere(id) {
    if (!id || insideOwner(id)) return false;
    banner(esc(`${(world().regions || []).find((r) => r.id === id).name} isn't inside ${ownerRegion().name}, so it can't go on ${mapName()}. Pick a region inside it, or switch to the map it belongs on.`), 'bad');
    return true;
  }
  function finishDrawing() {
    const w = world();
    if (ui.drawing.length < 3 || !mh().map) return;
    if (notHere(ui.sel)) { ui.drawing = []; return renderCanvas(); }
    const id = ui.sel || addRegion();
    mh().map.regions = mh().map.regions || {};
    const had = E.Geo.pieces(mh().map.regions[id]);
    // "Add as another piece": an island or an exclave of the same region.
    if (ui.addPiece && had.length) { mh().map.regions[id] = { polygons: had.concat([ui.drawing.slice()]) }; ui.piece = had.length; }
    else { mh().map.regions[id] = { polygon: ui.drawing.slice() }; ui.piece = null; }
    // Places inside it that belong to no region yet are in it now.
    (mh().map.places || []).forEach((pl) => { if (!pl.region && E.Geo.inside(pl.at, ui.drawing)) pl.region = id; });
    ui.drawing = [];
    ui.mode = 'select';
    changed();
  }
  // A corner of a region's shape: "piece:index" (one piece: "0:index").
  const ringOf = (sh, k) => (sh.polygons ? sh.polygons[k] : sh.polygon);
  function setRing(sh, k, ring) { if (sh.polygons) sh.polygons[k] = ring; else sh.polygon = ring; }
  let drag = null;
  $('cMain').addEventListener('pointerdown', (ev) => {
    if (!cw || !ev.target.closest || !ev.target.closest('#cSvg')) return;
    const handle = ev.target.closest('.c-handle');
    drag = { start: [ev.clientX, ev.clientY], moved: false, vb: (ui.vb || geometry().full).slice(), vertex: handle && !ev.altKey ? handle.dataset.i : null };
    if (drag.vertex != null) { try { $('cSvg').setPointerCapture(ev.pointerId); } catch (e) {} }
  });
  $('cMain').addEventListener('pointermove', (ev) => {
    if (!drag || !cw) return;
    const dx = ev.clientX - drag.start[0], dy = ev.clientY - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const w = world();
    if (drag.vertex != null) {
      const [k, i] = drag.vertex.split(':').map(Number);
      ringOf(mh().map.regions[ui.sel], k)[i] = toSvg(ev);
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
        const sh = mh().map.regions[ui.sel];
        const [k, i] = handle.dataset.i.split(':').map(Number);
        setRing(sh, k, M.removeVertex(ringOf(sh, k), i));
        return changed(['canvas']);
      }
      const g = ev.target.closest('.region-g');
      const id = g ? g.dataset.region : mh().map ? M.regionAt(mh().map, p) : null;
      // A second click on the selected region picks the piece under it.
      const sh = id && mh().map && mh().map.regions && mh().map.regions[id];
      ui.piece = sh && sh.polygons ? sh.polygons.findIndex((ring) => E.Geo.inside(p, ring)) : null;
      if (ui.piece === -1) ui.piece = null;
      ui.sel = id;
      ui.confirmDelete = false;
      return render();
    }
    if (!mh().map) return;
    if (ui.mode === 'draw') {
      const unit = (ui.vb || geometry().full)[2] / 120;
      if (ui.drawing.length >= 3 && Math.hypot(p[0] - ui.drawing[0][0], p[1] - ui.drawing[0][1]) <= unit * 2) return finishDrawing();
      ui.drawing.push(p);
      return renderCanvas();
    }
    if (ui.mode === 'point') {
      if (!ui.sel) return banner('Pick a region first, then place it.');
      if (notHere(ui.sel)) return;
      mh().map.regions = mh().map.regions || {};
      mh().map.regions[ui.sel] = { point: p };
      return changed();
    }
    if (ui.mode === 'place') {
      mh().map.places = mh().map.places || [];
      const taken = mh().map.places.map((x) => x.id).concat((w.regions || []).map((r) => r.id), rooms().map((r) => r.id));
      const id = M.slug('new place', taken);
      const region = M.regionAt(mh().map, p);
      mh().map.places.push(Object.assign({ id, name: 'New place', kind: 'town', at: p }, region ? { region } : {}));
      ui.place = id;
      ui.mode = 'select';
      return changed();
    }
    if (ui.mode === 'room') {
      if (!ui.room) return banner('Pick a room first, then click where it is.');
      mh().map.locations = mh().map.locations || {};
      mh().map.locations[ui.room] = p;
      return changed();
    }
  });
  $('cMain').addEventListener('dblclick', (ev) => {
    if (!cw || ui.mode !== 'select' || !ev.target.closest || !ev.target.closest('#cSvg')) return;
    const w = world();
    const sh = mh().map && ui.sel && mh().map.regions && mh().map.regions[ui.sel];
    if (!sh || !(sh.polygon || sh.polygons)) return;
    const p = toSvg(ev);
    let best = null;
    E.Geo.pieces(sh).forEach((ring, k) => { const e = M.nearestEdge(ring, p); if (!best || e.dist < best.e.dist) best = { k, e }; });
    if (best.e.dist > (ui.vb || geometry().full)[2] / 40) return;
    setRing(sh, best.k, M.insertVertex(ringOf(sh, best.k), best.e.index, p));
    changed(['canvas']);
  });
  // Where the pointer is on the globe, for a projected map (task 4-5).
  $('cMain').addEventListener('pointermove', (ev) => {
    const out = $('cCoords');
    if (!cw || !out || ui.tab !== 'map') return;
    const w = world();
    out.textContent = mh().map && E.Geo.projected(mh().map) && ev.target.closest && ev.target.closest('#cSvg') ? E.Geo.fmtLonLat(E.Geo.toLonLat(mh().map, toSvg(ev))) : '';
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
    if (t.id === 'cNoImage') { delete mh().map; ui.vb = null; return changed(); }
    if (t.id === 'cAddTouching') {
      M.suggestNeighbours(mh().map).filter((p) => p.includes(ui.sel)).forEach(([a, b]) => M.setNeighbour(w, a, b, true));
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
    if (un) { delete mh().map.locations[un.dataset.unplace]; return changed(); }
    if (t.id === 'cRemovePiece') {
      const sh = mh().map.regions[ui.sel];
      sh.polygons.splice(ui.piece, 1);
      if (sh.polygons.length === 1) mh().map.regions[ui.sel] = { polygon: sh.polygons[0] };
      ui.piece = null;
      return changed();
    }
    if (t.id === 'cDelPlace') {
      mh().map.places = (mh().map.places || []).filter((x) => x.id !== ui.place);
      if (!mh().map.places.length) delete mh().map.places;
      ui.place = null;
      return changed();
    }
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
    else if (f === 'label') { if (t.value.trim()) r.label = t.value.trim(); else delete r.label; }
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
    if (t.id === 'cPlacePick') { ui.place = t.value || null; return render(); }
    if (t.id === 'cAddPiece') { ui.addPiece = t.checked; return; }
    if (t.dataset.placell != null) {
      const pl = (mh().map.places || []).find((x) => x.id === ui.place);
      const ll = E.Geo.toLonLat(mh().map, pl.at);
      ll[Number(t.dataset.placell)] = Number(t.value);
      const at = E.Geo.toPixel(mh().map, ll).map(Math.round);
      if (at[0] < 0 || at[1] < 0 || at[0] > mh().map.width || at[1] > mh().map.height) { banner('That is off this map.', 'bad'); return render(); }
      pl.at = at;
      return changed();
    }
    if (t.dataset.startregion) { starts()[t.dataset.startregion].region = t.value || undefined; return changed(); }
    if (t.dataset.fcolor) {
      const f = (w.factions || []).find((x) => x.id === t.dataset.fcolor);
      if (t.value) f.color = Number(t.value); else delete f.color;
      return changed();
    }
    const r = ui.sel && (w.regions || []).find((x) => x.id === ui.sel);
    if (!r) return;
    if (t.dataset.field === 'controller') { r.controller = t.value || null; return changed(); }
    // Unknown regions and presence (R-5).
    // Where a generated start may begin (R-7): a branch at a time.
    if (t.dataset.field === 'startable') { if (t.value === '') delete r.startable; else r.startable = t.value === 'true'; return changed(); }
    if (t.dataset.field === 'hidden') { if (t.checked) r.known = false; else delete r.known; return changed(); }
    if (t.dataset.presence) {
      const g = t.dataset.presence;
      const v = t.value === '' ? null : Number(t.value);
      w.presence = w.presence || {};
      w.presence[g] = Object.assign({}, w.presence[g]);
      if (v == null || !Number.isFinite(v) || v <= 0) delete w.presence[g][r.id]; else w.presence[g][r.id] = Math.min(1, v);
      if (!Object.keys(w.presence[g]).length) delete w.presence[g];
      if (!Object.keys(w.presence).length) delete w.presence;
      return changed();
    }
    if (t.dataset.field === 'parent') { if (t.value) r.parent = t.value; else delete r.parent; return changed(['canvas', 'list']); }
    if (t.dataset.neigh) { M.setNeighbour(w, r.id, t.dataset.neigh, t.checked); return changed(); }
  });

  // ---------- the region tree, region maps, routes and route kinds (R-4) ----------
  // A route's or route kind's condition, by the key its rows carry: "r:<i>"
  // (the selected region's route i) or "k:<kind>". → { get, set }.
  function rqTarget(key) {
    const w = world();
    if (key.startsWith('k:')) {
      const kind = key.slice(2);
      return { get: () => ((w.routeKinds || {})[kind] || {}).requires || null, set: (p) => { M.setRouteKind(w, kind, 'requires', p); ui.kindOpen = kind; } };
    }
    const r = (w.regions || []).find((x) => x.id === ui.sel);
    const i = Number(key.slice(2));
    return { get: () => (r && r.routes && r.routes[i] ? r.routes[i].requires || null : null), set: (p) => M.setRouteField(w, ui.sel, i, 'requires', p) };
  }
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'map') return;
    const t = ev.target;
    const w = world();
    const sel = ui.sel && (w.regions || []).find((r) => r.id === ui.sel);
    if (t.id === 'cAddInside' && sel) { addRegion(undefined, sel.id); return changed(); }
    if (t.id === 'cAddNext' && sel) { addRegion(undefined, sel.parent != null ? sel.parent : null); return changed(); }
    const em = t.closest('[data-editmap]');
    if (em) { ui.mapOwner = em.dataset.editmap; ui.vb = null; ui.mode = 'select'; return render(); }
    // A region's own map cut from the base map the world is on (R-9): framed
    // by its outline, with what's inside it moved onto the new picture.
    const cm = t.closest('[data-cutmap]');
    if (cm) {
      const r = w.regions.find((x) => x.id === cm.dataset.cutmap);
      const base = S.library.baseMaps[M.baseOf(w)];
      const bounds = M.regionBounds(w, r.id);
      cropBase(base, bounds).then((c) => {
        const file = `maps/${r.id}.jpg`;
        cw.assets[file] = c.blob;
        urls.delete(file);
        const n = M.cropRegion(w, r.id, { image: file, width: c.width, height: c.height, projection: 'equirectangular', bounds, base: base.id, regions: {}, credit: base.credit, license: base.license });
        ui.mapOwner = r.id; ui.vb = null; ui.mode = 'select';
        banner(`${esc(r.name)} has its own map, cut from the base map${n.moved || n.places ? `, with ${n.moved} region${n.moved === 1 ? '' : 's'} and ${n.places} place${n.places === 1 ? '' : 's'} inside it moved onto it` : ''}. For a sharper picture: <code>npm run basemap -- crop &lt;world folder&gt; --region ${esc(r.id)}</code>.`);
        changed();
      }).catch((err) => banner(`Couldn't cut the map: ${esc(err.message)}`, 'bad'));
      return;
    }
    const dm = t.closest('[data-dropmap]');
    if (dm) {
      if (ui.confirmDropMap !== dm.dataset.dropmap) { ui.confirmDropMap = dm.dataset.dropmap; return render(); }
      const r = w.regions.find((x) => x.id === dm.dataset.dropmap);
      delete r.map;
      if (ui.mapOwner === r.id) ui.mapOwner = null;
      ui.confirmDropMap = null;
      ui.vb = null;
      return changed();
    }
    if (t.id === 'cAddRoute' && sel) { M.addRoute(w, sel.id); return changed(); }
    const rd = t.closest('[data-routedel]');
    if (rd && sel) { M.removeRoute(w, sel.id, Number(rd.dataset.routedel)); return changed(); }
    const ra = t.closest('[data-rqadd]');
    if (ra) { rqTarget(ra.dataset.rqadd).set(LE.preOf(LE.newRow('world', LE.refs(cw.files)))); return changed(); }
    const rx = t.closest('[data-rqdel]');
    if (rx) { rqTarget(rx.dataset.rqdel).set(null); return changed(); }
    if (t.id === 'cAddKind') {
      const out = M.addRouteKind(w, $('cNewKind').value);
      if (out.error) return banner(esc(`That kind can't be added: ${out.error}.`), 'bad');
      banner('');
      ui.kindOpen = out.kind;
      return changed();
    }
    const kd = t.closest('[data-kinddel]');
    if (kd) { M.removeRouteKind(w, kd.dataset.kinddel); return changed(); }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'map') return;
    const t = ev.target;
    const w = world();
    if (t.id === 'cMapOwner') { ui.mapOwner = t.value || null; ui.vb = null; ui.mode = 'select'; return render(); }
    if (t.dataset.attachmap && t.files && t.files[0]) { ui.mapOwner = t.dataset.attachmap; return loadImage(t.files[0]); }
    if (t.dataset.route != null && ui.sel) {
      const v = t.type === 'checkbox' ? t.checked : t.value;
      M.setRouteField(w, ui.sel, Number(t.dataset.route), t.dataset.rf, v);
      return changed();
    }
    if (t.dataset.kind != null) {
      M.setRouteKind(w, t.dataset.kind, t.dataset.kf, t.type === 'checkbox' ? t.checked : t.value);
      ui.kindOpen = t.dataset.kind;
      return changed();
    }
    if (t.dataset.rq != null) {
      const target = rqTarget(t.dataset.rq);
      let row = LE.rowOf(target.get());
      if (t.dataset.pf === 'kind') row = Object.assign(LE.newRow(t.value, LE.refs(cw.files)), { negate: row.negate });
      else if (t.dataset.pf === 'negate') row.negate = t.checked;
      else row[t.dataset.pf] = t.value;
      target.set(LE.preOf(row));
      return changed();
    }
  });
  $('cMain').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.dataset && d.dataset.kindcard) { if (d.open) ui.kindOpen = d.dataset.kindcard; else if (ui.kindOpen === d.dataset.kindcard) ui.kindOpen = null; }
  }, true);
  // Dragging a region onto another puts it inside; onto Top level, out.
  $('cMain').addEventListener('dragstart', (ev) => {
    const b = ev.target.closest && ev.target.closest('#cRegionList [data-sel]');
    if (!b) return;
    ev.dataTransfer.setData('text/plain', b.dataset.sel);
    ev.dataTransfer.effectAllowed = 'move';
  });
  $('cMain').addEventListener('dragover', (ev) => {
    if (ev.target.closest && ev.target.closest('#cRegionList [data-sel], #cRegionList [data-droptop]')) ev.preventDefault();
  });
  $('cMain').addEventListener('drop', (ev) => {
    const onto = ev.target.closest && ev.target.closest('#cRegionList [data-sel], #cRegionList [data-droptop]');
    if (!onto || !cw) return;
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    if (!id || id === onto.dataset.sel) return;
    const out = M.setParent(world(), id, onto.dataset.droptop ? null : onto.dataset.sel);
    if (out.error) return banner(esc(`Not moved: ${out.error}.`), 'bad');
    banner(out.notes.length ? esc(out.notes.join('; ')) : '');
    ui.sel = id;
    changed();
  });

  // ---------- links between tabs ----------
  // Region chips in lore and the timeline open the map with that region
  // selected; the map's region form links back to its lore and events.
  $('cMain').addEventListener('click', (ev) => {
    if (!cw) return;
    const go = ev.target.closest('[data-goregion],[data-golore],[data-gotimeline]');
    if (!go) return;
    if (go.dataset.goregion) { ui.tab = 'map'; ui.sel = go.dataset.goregion; ui.confirmDelete = false; }
    else if (go.dataset.golore) { ui.tab = 'lore'; lui.focus = go.dataset.golore; }
    else { ui.tab = 'timeline'; tui.focus = go.dataset.gotimeline; }
    render();
  });
  const regionName = (id) => { const r = LE.refs(cw.files).regions.find((x) => x.id === id); return r ? r.name : id; };
  const regionChip = (id) => (id ? `<button type="button" class="linkish small" data-goregion="${esc(id)}" title="Show on the map">◈ ${esc(regionName(id))}</button>` : '');
  const options = (list, value, blank) => (blank != null ? `<option value=""${!value ? ' selected' : ''}>${esc(blank)}</option>` : '') +
    list.map((x) => `<option value="${esc(x.id)}"${x.id === value ? ' selected' : ''}>${esc(x.name)}</option>`).join('');

  // ---------- the lore tab (task 5-3) ----------
  const LEVEL_LABEL = { world: 'World', region: 'Region', location: 'Room', character: 'Person', topic: 'Topic' };
  function renderLoreTab() {
    return `<div class="c-split">
      <div class="c-scroll-col">
        <p class="muted small">Lore is public knowledge: the narrator may use any of it. Secrets go in a character's secret, and things that haven't happened yet go in the timeline. Each turn the game includes the entries for the player's room, region and the people there, plus any whose keywords the player or the last scene uses, best first within about a tenth of the context.</p>
        <div id="cLoreDrafts"></div>
        <div id="cLoreList" class="c-groups"></div>
        <section class="c-test"><h3>Test the selection</h3>${loreTestForm()}<div id="cLoreTest" aria-live="polite"></div></section>
      </div>
      <aside class="c-panel" id="cLoreForm">${loreForm()}</aside>
    </div>`;
  }
  // Drafts from the research helper or an imported packet wait for review.
  function draftsBar(id, n, what, button) {
    const d = $(id);
    if (d) d.innerHTML = n ? `<div class="c-draft-note"><b>${n} draft ${what}</b> from the research helper or an imported packet. The game uses none of them until you accept them: read each one first. <button type="button" id="${button}" class="small">Accept all</button></div>` : '';
  }
  function renderLoreList() {
    const el = $('cLoreList');
    if (!el) return;
    const nd = LE.drafts(cw.files).lore.length;
    draftsBar('cLoreDrafts', nd, nd === 1 ? 'entry' : 'entries', 'cAcceptAllLore');
    el.innerHTML = LE.loreGroups(cw.files).map((g) => {
      const key = `${g.level}|${g.ref || ''}`;
      const focus = lui.focus && g.level === 'region' && g.ref === lui.focus;
      // Rooms and people without entries stay out of the way.
      if (!g.items.length && ['location', 'character'].includes(g.level)) return '';
      return `<section class="c-group${focus ? ' focus' : ''}" data-group="${esc(key)}">
        <h4>${esc(g.label)} <span class="muted small">${esc(LEVEL_LABEL[g.level] || g.level)}</span> ${g.level === 'region' ? regionChip(g.ref) : ''}
          <button type="button" class="small" data-loreadd="${esc(key)}" aria-label="Add an entry to ${esc(g.label)}">+ entry</button></h4>
        ${g.items.map((it) => { const e = it.entry; return `<button type="button" class="c-item" data-loresel="${esc(e.id)}" aria-pressed="${e.id === lui.sel}">${esc(e.title || e.id)}${e.alwaysOn ? ' <span class="muted small">always on</span>' : ''}${e.priority && e.priority !== 3 ? ` <span class="muted small">priority ${e.priority}</span>` : ''}${it.file !== 'world.json' ? ` <span class="muted small">${esc(it.file)}</span>` : ''}${e.draft ? ' <span class="badge-draft">draft</span>' : ''}</button>`; }).join('') || '<div class="muted small">No entries.</div>'}
      </section>`;
    }).join('') + `<p class="small"><button type="button" class="small" data-loreadd="location|">+ entry about a room</button> <button type="button" class="small" data-loreadd="character|">+ entry about a person</button></p>`;
    const f = el.querySelector('.c-group.focus');
    if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
  }
  function loreForm() {
    const it = lui.sel && LE.findLore(cw.files, lui.sel);
    if (!it) return '<p class="muted">Pick an entry, or add one to a group.</p>';
    const e = it.entry;
    const refs = LE.refs(cw.files);
    const refList = { region: refs.regions, location: refs.rooms, character: refs.characters }[e.level];
    const words = String(e.text || '').trim().split(/\s+/).filter(Boolean).length;
    return `<h3>${esc(e.title || e.id)} <span class="muted small">(${esc(e.id)})</span></h3>
      ${e.draft ? `<div class="c-draft-note">Draft: the game doesn't use it yet. Check it is in your own words, public, and right for this world. <button type="button" id="cAcceptLore" class="small">Accept</button></div>` : ''}
      <div id="cLoreProblems"></div>
      <label>Title <input data-lf="title" value="${esc(e.title || '')}" maxlength="${E.Lore.LIMITS.title}"></label>
      <label>About <select data-lf="level">${E.Lore.LEVELS.map((l) => `<option value="${l}"${e.level === l ? ' selected' : ''}>${LEVEL_LABEL[l]}</option>`).join('')}</select></label>
      ${refList ? `<label>Which ${esc(LEVEL_LABEL[e.level].toLowerCase())} <select data-lf="ref">${options(refList, e.ref)}</select></label>${e.level === 'region' ? regionChip(e.ref) : ''}` : ''}
      ${e.level === 'world' ? `<label class="c-check"><input type="checkbox" data-lf="alwaysOn"${e.alwaysOn ? ' checked' : ''}> Always in the prompt (keep these few and short)</label>` : ''}
      <label>Priority <select data-lf="priority">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}"${(e.priority || 3) === n ? ' selected' : ''}>${n}${n === 3 ? ' (normal)' : n === 5 ? ' (first)' : n === 1 ? ' (last)' : ''}</option>`).join('')}</select></label>
      <div class="c-field"><span>Keywords <span class="muted small">(whole words, any case; include nicknames and other spellings)</span></span>
        <div class="c-chips">${(e.keywords || []).map((k, i) => `<button type="button" class="chip" data-kwdel="${i}" aria-label="Remove keyword ${esc(k)}">${esc(k)} ✕</button>`).join('')}</div>
        <input id="cKwAdd" placeholder="Add keywords, then Enter (commas for several)" aria-label="Add keywords"></div>
      <label>Text <span class="muted small" id="cLoreTextCount">${String(e.text || '').length}/${E.Lore.LIMITS.text} · ${words} words (40–80 works best)</span><textarea data-lf="text" rows="6" maxlength="${E.Lore.LIMITS.text}">${esc(e.text || '')}</textarea></label>
      <fieldset class="c-neigh"><legend>Sources <span class="muted small">(for you; never sent to the model)</span></legend>
        ${(e.sources || []).map((s, i) => `<div class="c-source"><input data-src="${i}" data-srcf="title" value="${esc(s.title || '')}" placeholder="Title" aria-label="Source title"><input data-src="${i}" data-srcf="url" value="${esc(s.url || '')}" placeholder="https://…" aria-label="Source link">${/^https?:\/\//.test(s.url || '') ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="small">open</a>` : ''}<button type="button" class="small ghost" data-srcdel="${i}" aria-label="Remove source">✕</button></div>`).join('')}
        <button type="button" id="cSrcAdd" class="small">+ Source</button></fieldset>
      <div class="muted small">Stored in ${esc(it.file)}.</div>
      <button type="button" id="cDeleteLore" class="small danger">${lui.confirm ? 'Click again to delete' : 'Delete entry'}</button>`;
  }
  function loreTestForm() {
    const refs = LE.refs(cw.files);
    const t = lui.test;
    return `<div class="c-testform">
      ${refs.starts.length > 1 ? `<label>Start <select data-lt="startId">${options(refs.starts, t.startId || refs.starts[0].id)}</select></label>` : ''}
      <label>The player is in <select data-lt="room">${options(refs.rooms, t.room, 'where the start begins')}</select></label>
      <label>The player's action <input data-lt="action" value="${esc(t.action)}" placeholder="Ask Ruth about the convoy"></label>
      <label>The last scene <span class="muted small">(optional)</span><textarea data-lt="scene" rows="2">${esc(t.scene)}</textarea></label></div>`;
  }
  let testTimer = null;
  function renderLoreTest() {
    const el = $('cLoreTest');
    if (!el) return;
    const t = lui.test;
    const r = LE.testSelection(cw.files, cw.folder, t);
    if (r.error) { el.innerHTML = `<div class="bad small">${esc(r.error)}</div>`; return; }
    el.innerHTML = `<div class="small"><b>${r.picks.length} entr${r.picks.length === 1 ? 'y' : 'ies'}</b>, about ${r.used} of ${r.budget} tokens.</div>` +
      (r.picks.length ? `<ol class="c-picks">${r.picks.map((p) => `<li><button type="button" class="linkish" data-loresel="${esc(p.id)}">${esc(p.title)}</button> <span class="muted small">${esc(p.why)} · ~${p.tokens}</span></li>`).join('')}</ol>` : '<div class="muted small">Nothing would be included.</div>') +
      (r.always.length ? `<div class="muted small">Always in the header: ${r.always.map((a) => `${esc(a.title)} (~${a.tokens})`).join(', ')}.</div>` : '');
  }
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'lore') return;
    const t = ev.target;
    const add = t.closest('[data-loreadd]');
    if (add) {
      const [level, ref] = add.dataset.loreadd.split('|');
      const refs = LE.refs(cw.files);
      const fallback = { location: refs.rooms, character: refs.characters, region: refs.regions }[level];
      lui.sel = LE.addLore(cw.files, level, ref || (fallback && fallback[0] ? fallback[0].id : undefined));
      lui.confirm = false;
      return changed();
    }
    const sel = t.closest('[data-loresel]');
    if (sel) { lui.sel = sel.dataset.loresel; lui.confirm = false; return render(); }
    if (t.id === 'cAcceptAllLore') { LE.acceptAll(cw.files, 'lore'); return changed(); }
    const it = lui.sel && LE.findLore(cw.files, lui.sel);
    if (!it) return;
    const e = it.entry;
    const kw = t.closest('[data-kwdel]');
    if (kw) { e.keywords.splice(Number(kw.dataset.kwdel), 1); return changed(); }
    if (t.id === 'cAcceptLore') { LE.accept(cw.files, 'lore', lui.sel); return changed(); }
    if (t.id === 'cSrcAdd') { e.sources = (e.sources || []).concat([{ title: '', url: '' }]); return changed(); }
    const sd = t.closest('[data-srcdel]');
    if (sd) { e.sources.splice(Number(sd.dataset.srcdel), 1); if (!e.sources.length) delete e.sources; return changed(); }
    if (t.id === 'cDeleteLore') {
      if (!lui.confirm) { lui.confirm = true; return render(); }
      LE.removeLore(cw.files, lui.sel);
      lui.sel = null;
      lui.confirm = false;
      return changed();
    }
  });
  $('cMain').addEventListener('input', (ev) => {
    if (!cw || ui.tab !== 'lore') return;
    const t = ev.target;
    if (t.dataset.lt) {
      lui.test[t.dataset.lt] = t.value;
      clearTimeout(testTimer);
      testTimer = setTimeout(renderLoreTest, 250);
      return;
    }
    const it = lui.sel && LE.findLore(cw.files, lui.sel);
    if (!it) return;
    const e = it.entry;
    if (t.dataset.lf === 'title') { e.title = t.value; return changed(['lorelist']); }
    if (t.dataset.lf === 'text') {
      e.text = t.value;
      const c = $('cLoreTextCount');
      if (c) c.textContent = `${t.value.length}/${E.Lore.LIMITS.text} · ${t.value.trim().split(/\s+/).filter(Boolean).length} words (40–80 works best)`;
      return changed([]);
    }
    if (t.dataset.src != null) {
      e.sources[Number(t.dataset.src)][t.dataset.srcf] = t.value;
      return changed([]);
    }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'lore') return;
    const t = ev.target;
    if (t.dataset.lt) { lui.test[t.dataset.lt] = t.value; return renderLoreTest(); }
    const it = lui.sel && LE.findLore(cw.files, lui.sel);
    if (!it) return;
    const e = it.entry;
    if (t.dataset.lf === 'level') { LE.setLevel(cw.files, e, t.value); return changed(); }
    if (t.dataset.lf === 'ref') { e.ref = t.value; return changed(); }
    if (t.dataset.lf === 'priority') { if (Number(t.value) === 3) delete e.priority; else e.priority = Number(t.value); return changed(); }
    if (t.dataset.lf === 'alwaysOn') { if (t.checked) e.alwaysOn = true; else delete e.alwaysOn; return changed(); }
    if (t.id === 'cKwAdd' && t.value.trim()) { LE.addKeywords(e, t.value); return changed(); }
  });
  $('cMain').addEventListener('keydown', (ev) => {
    if (!cw || ui.tab !== 'lore' || ev.target.id !== 'cKwAdd' || ev.key !== 'Enter') return;
    ev.preventDefault();
    const it = lui.sel && LE.findLore(cw.files, lui.sel);
    if (!it || !ev.target.value.trim()) return;
    LE.addKeywords(it.entry, ev.target.value);
    ev.target.value = ''; // so the blur as it is replaced doesn't add them again
    changed();
    const inp = $('cKwAdd');
    if (inp) inp.focus();
  });

  // ---------- the timeline tab (task 5-3) ----------
  function renderTimelineTab() {
    const refs = LE.refs(cw.files);
    const w = world();
    const cfg = E.Timeline.config(w);
    return `<div class="c-split">
      <div class="c-scroll-col">
        <div class="c-toolbar">
          ${refs.starts.length > 1 ? `<label class="small">Past and future as seen from <select id="cTlStart">${options(refs.starts, tui.startId || refs.starts[0].id)}</select></label>` : ''}
          <button type="button" id="cAddEvent">+ Event</button>
        </div>
        <p class="muted small">Events before the start become facts and the "Before the story" chapter. Later ones happen on their date if their conditions still hold; the model never sees one before it is due.</p>
        <fieldset class="c-neigh c-project"><legend>When nothing is planned</legend>
          <label class="c-check"><input type="checkbox" id="cProjOn"${cfg ? ' checked' : ''}> Let the model plan likely events for the next few days (an exam, a holiday, a delivery), so the story keeps its pace</label>
          ${cfg ? `<label class="c-inline">Days ahead <input type="number" id="cProjDays" min="1" max="14" value="${cfg.days}"></label> <label class="c-inline">At most <input type="number" id="cProjMax" min="1" max="5" value="${cfg.max}"> at a time</label>` : ''}
        </fieldset>
        <div id="cEventDrafts"></div>
        <div id="cEventList"></div>
      </div>
      <aside class="c-panel" id="cEventForm">${eventForm()}</aside>
    </div>`;
  }
  function renderEventList() {
    const el = $('cEventList');
    if (!el) return;
    const nd = LE.drafts(cw.files).events.length;
    draftsBar('cEventDrafts', nd, nd === 1 ? 'event' : 'events', 'cAcceptAllEvents');
    const sc = world();
    const { past, future } = LE.splitEvents(cw.files, tui.startId);
    const row = (x) => {
      const e = x.ev;
      const when = e.when && Number.isFinite(e.when.day) ? E.Timeline.fmt(sc, e.when) : '(no date)';
      const focus = tui.focus && LE.eventMentions(e, tui.focus);
      return `<button type="button" class="c-item c-event${focus ? ' focus' : ''}" data-evsel="${esc(e.id)}" aria-pressed="${e.id === tui.sel}"><span class="when">${esc(when)}</span> ${esc(E.shorten(e.text || e.id, 110))}
        <span class="muted small">${esc(e.scope || '?')}${e.region ? ` · ${esc(regionName(e.region))}` : ''}${(e.preconditions || []).length ? ` · ${e.preconditions.length} condition${e.preconditions.length === 1 ? '' : 's'}` : ''}${e.onBroken === 'diverge' ? ' · diverges' : ''}${e.visibility === 'hidden' ? ' · hidden' : ''}${x.file !== 'world.json' ? ` · ${esc(x.file)}` : ''}${e.draft ? ' <span class="badge-draft">draft</span>' : ''}</span></button>`;
    };
    el.innerHTML = `<section class="c-group"><h4>Before the start <span class="muted small">the past</span></h4>${past.map(row).join('') || '<div class="muted small">No past events.</div>'}</section>
      <section class="c-group"><h4>From the start on <span class="muted small">the future</span></h4>${future.map(row).join('') || '<div class="muted small">No future events.</div>'}</section>`;
    const f = el.querySelector('.c-event.focus');
    if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
  }
  const PRE_LABEL = { alive: 'is alive', controls: 'holds a region', clock: 'a pressure is at least', world: 'a world value is', event: 'knows about an event', words: 'knows something (words)' };
  // attr: the data attribute the rows answer to ("pre" for timeline events,
  // "rq" for a route's or route kind's condition, R-4).
  function preRow(row, i, refs, attr = 'pre') {
    const by = `<select data-${attr}="${i}" data-pf="by" aria-label="Who knows">${options(refs.characters, row.by, 'the player')}</select>`;
    const sel = (f, list, v, blank) => `<select data-${attr}="${i}" data-pf="${f}">${options(list, v, blank)}</select>`;
    const inp = (f, v, type, ph) => `<input data-${attr}="${i}" data-pf="${f}" value="${esc(v ?? '')}"${type ? ` type="${type}"` : ''}${ph ? ` placeholder="${esc(ph)}"` : ''}>`;
    const values = {
      alive: sel('a', refs.characters, row.a),
      controls: `${sel('a', refs.groups, row.a, 'no one')} holds ${sel('b', refs.regions, row.b)}`,
      clock: `${refs.clocks.length ? sel('a', refs.clocks, row.a) : inp('a', row.a, null, 'clock id')} ≥ ${inp('b', row.b, 'number')}`,
      world: `${refs.worldKeys.length ? sel('a', refs.worldKeys.map((k) => ({ id: k, name: k })), row.a) : inp('a', row.a, null, 'world key')} is ${inp('b', row.b, null, 'exact value')}`,
      event: `${by} knows about ${sel('a', refs.events.filter((x) => x.id !== tui.sel).map((x) => ({ id: x.id, name: E.shorten(x.name, 50) })), row.a)}`,
      words: `${by} knows ${inp('a', row.a, null, 'convoy, coast')}`,
    }[row.kind];
    return `<div class="c-pre"><select data-${attr}="${i}" data-pf="kind" aria-label="Kind of condition">${LE.PRE_ROWS.map((k) => `<option value="${k}"${k === row.kind ? ' selected' : ''}>${esc(PRE_LABEL[k])}</option>`).join('')}</select>
      <label class="c-check small"><input type="checkbox" data-${attr}="${i}" data-pf="negate"${row.negate ? ' checked' : ''}> not</label>
      <div class="c-pre-values">${values}</div><button type="button" class="small ghost" data-${attr}del="${i}" aria-label="Remove condition">✕</button></div>`;
  }
  function eventForm() {
    const x = tui.sel && LE.findEvent(cw.files, tui.sel);
    if (!x) return '<p class="muted">Pick an event, or add one.</p>';
    const e = x.ev;
    const refs = LE.refs(cw.files);
    const w = e.when || {};
    const isPast = Number.isFinite(w.day) && Number.isFinite(w.hour) && E.Timeline.at(w) < LE.startHours(cw.files, tui.startId);
    const effectsText = e.effects == null ? '' : JSON.stringify(e.effects, null, 2);
    return `<h3>${esc(e.id)} ${isPast ? '<span class="muted small">(before the start)</span>' : ''}</h3>
      ${e.draft ? `<div class="c-draft-note">Draft: it won't happen until you accept it. Check the date, the place and the wording. <button type="button" id="cAcceptEvent" class="small">Accept</button></div>` : ''}
      <div id="cEventProblems"></div>
      <label>Id <input data-ef="id" value="${esc(e.id)}" aria-describedby="cEvIdNote"></label><div class="muted small" id="cEvIdNote">Conditions that point at this event follow a rename.</div>
      <div class="c-row2"><label>${esc(world().timeLabel || 'Day')} <input type="number" data-ef="day" min="0" value="${esc(w.day ?? '')}"></label><label>Hour <input type="number" data-ef="hour" min="0" max="23" value="${esc(w.hour ?? '')}"></label></div>
      <div class="c-row2"><label>Scope <select data-ef="scope">${['regional', 'world'].map((s) => `<option value="${s}"${e.scope === s ? ' selected' : ''}>${s === 'regional' ? 'nearby (regional)' : 'far away (world)'}</option>`).join('')}</select></label>
        <label>Region <select data-ef="region">${options(refs.regions, e.region, e.scope === 'world' ? 'none in particular' : 'pick a region')}</select></label></div>
      ${regionChip(e.region)}
      <label>What happens <span class="muted small" id="cEvTextCount">${String(e.text || '').length}/${E.Timeline.TEXT_MAX}</span><textarea data-ef="text" rows="3" maxlength="${E.Timeline.TEXT_MAX}">${esc(e.text || '')}</textarea></label>
      <label>Who hears of it <select data-ef="visibility">${[['heard', 'news reaches the player (default)'], ['seen', 'the player sees it'], ['hidden', 'only the people involved know']].map(([v, l]) => `<option value="${v}"${(e.visibility || 'heard') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <fieldset class="c-neigh"><legend>People involved</legend>${refs.characters.map((c) => `<label><input type="checkbox" data-efwho="${esc(c.id)}"${(e.who || []).includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('') || '<span class="muted">No characters.</span>'}</fieldset>
      ${isPast ? '<p class="muted small">Before the start, an event becomes a fact (a private one for the people involved, when hidden). Conditions and effects don\'t apply: write the world as it is at the start.</p>' : `
      <fieldset class="c-neigh"><legend>Only if <span class="muted small">(all must hold when it is due)</span></legend>
        ${(e.preconditions || []).map((p, i) => preRow(LE.rowOf(p), i, refs)).join('') || '<div class="muted small">No conditions: it always happens.</div>'}
        <button type="button" id="cAddPre" class="small">+ Condition</button></fieldset>
      <label>If a condition broke <select data-ef="onBroken"><option value="drop"${e.onBroken !== 'diverge' ? ' selected' : ''}>drop it: it doesn't happen</option><option value="diverge"${e.onBroken === 'diverge' ? ' selected' : ''}>diverge: the model writes what happens instead</option></select></label>
      <div class="c-field"><span>Effects <span class="muted small">(JSON; checked when it happens)</span></span>
        <select id="cAddEffect" aria-label="Add an effect"><option value="">Add an effect…</option>${Object.keys(E.Engine.EFFECTS).map((k) => `<option value="${k}">${esc(k.replace(/_/g, ' '))}</option>`).join('')}</select>
        <textarea data-ef="effects" rows="6" spellcheck="false" aria-describedby="cEffectsError">${esc(effectsText)}</textarea>
        <div id="cEffectsError" class="bad small">${esc(tui.effectsError)}</div></div>`}
      <div class="muted small">Stored in ${esc(x.file)}.</div>
      <button type="button" id="cDeleteEvent" class="small danger">${tui.confirm ? 'Click again to delete' : 'Delete event'}</button>`;
  }
  const currentEvent = () => { const x = tui.sel && LE.findEvent(cw.files, tui.sel); return x ? x.ev : null; };
  function setPre(e, i, row) { e.preconditions[i] = LE.preOf(row); }
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'timeline') return;
    const t = ev.target;
    if (t.id === 'cAcceptAllEvents') { LE.acceptAll(cw.files, 'event'); return changed(); }
    if (t.id === 'cAddEvent') { tui.sel = LE.addEvent(cw.files, tui.startId); tui.confirm = false; tui.effectsError = ''; return changed(); }
    const sel = t.closest('[data-evsel]');
    if (sel) { tui.sel = sel.dataset.evsel; tui.confirm = false; tui.effectsError = ''; return render(); }
    const e = currentEvent();
    if (!e) return;
    if (t.id === 'cAcceptEvent') { LE.accept(cw.files, 'event', tui.sel); return changed(); }
    if (t.id === 'cAddPre') { e.preconditions = (e.preconditions || []).concat([LE.preOf(LE.newRow('alive', LE.refs(cw.files)))]); return changed(); }
    const del = t.closest('[data-predel]');
    if (del) { e.preconditions.splice(Number(del.dataset.predel), 1); if (!e.preconditions.length) delete e.preconditions; return changed(); }
    if (t.id === 'cDeleteEvent') {
      if (!tui.confirm) { tui.confirm = true; return render(); }
      LE.removeEvent(cw.files, tui.sel);
      tui.sel = null;
      tui.confirm = false;
      return changed();
    }
  });
  $('cMain').addEventListener('input', (ev) => {
    if (!cw || ui.tab !== 'timeline') return;
    const t = ev.target;
    const e = currentEvent();
    if (!e) return;
    if (t.dataset.ef === 'text') {
      e.text = t.value;
      const c = $('cEvTextCount');
      if (c) c.textContent = `${t.value.length}/${E.Timeline.TEXT_MAX}`;
      return changed(['evlist']);
    }
    if (t.dataset.ef === 'day' || t.dataset.ef === 'hour') {
      e.when = Object.assign({}, e.when);
      e.when[t.dataset.ef] = t.value === '' ? null : Number(t.value);
      return changed(['evlist']);
    }
    if (t.dataset.ef === 'effects') {
      const v = t.value.trim();
      try {
        const parsed = v ? JSON.parse(v) : null;
        if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('effects must be an object, like {"world": [...]}');
        if (parsed == null) delete e.effects; else e.effects = parsed;
        tui.effectsError = '';
      } catch (err) { tui.effectsError = `Not saved yet: ${err.message}`; }
      const el = $('cEffectsError');
      if (el) el.textContent = tui.effectsError;
      return changed([]);
    }
    if (t.dataset.pre != null && (t.dataset.pf === 'a' || t.dataset.pf === 'b') && t.tagName === 'INPUT') {
      const i = Number(t.dataset.pre);
      const row = LE.rowOf(e.preconditions[i]);
      row[t.dataset.pf] = t.value;
      setPre(e, i, row);
      return changed([]);
    }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'timeline') return;
    const t = ev.target;
    if (t.id === 'cTlStart') { tui.startId = t.value; return render(); }
    if (t.id === 'cProjOn' || t.id === 'cProjDays' || t.id === 'cProjMax') {
      LE.setProjection(cw.files, $('cProjOn').checked, $('cProjDays') && $('cProjDays').value, $('cProjMax') && $('cProjMax').value);
      return changed(t.id === 'cProjOn' ? ['all'] : []);
    }
    const e = currentEvent();
    if (!e) return;
    if (t.dataset.ef === 'id') {
      const id = t.value.trim();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || LE.findEvent(cw.files, id)) { banner(`"${esc(id)}" can't be used: ids are lowercase letters, digits, - or _, and each is used once.`, 'bad'); return render(); }
      LE.renameEvent(cw.files, e.id, id);
      tui.sel = id;
      banner('');
      return changed();
    }
    // A new date may move it across the start (past ↔ future): redraw the form.
    if (t.dataset.ef === 'day' || t.dataset.ef === 'hour') return changed();
    if (t.dataset.ef === 'scope') { e.scope = t.value; return changed(); }
    if (t.dataset.ef === 'region') { if (t.value) e.region = t.value; else delete e.region; return changed(); }
    if (t.dataset.ef === 'visibility') { if (t.value === 'heard') delete e.visibility; else e.visibility = t.value; return changed(['evlist']); }
    if (t.dataset.ef === 'onBroken') { if (t.value === 'drop') delete e.onBroken; else e.onBroken = t.value; return changed(['evlist']); }
    if (t.dataset.efwho) {
      const who = new Set(e.who || []);
      if (t.checked) who.add(t.dataset.efwho); else who.delete(t.dataset.efwho);
      if (who.size) e.who = [...who]; else delete e.who;
      return changed([]);
    }
    if (t.id === 'cAddEffect' && t.value) { LE.addEffect(e, t.value, LE.refs(cw.files)); tui.effectsError = ''; return changed(); }
    if (t.dataset.pre != null) {
      const i = Number(t.dataset.pre);
      let row = LE.rowOf(e.preconditions[i]);
      if (t.dataset.pf === 'kind') row = Object.assign(LE.newRow(t.value, LE.refs(cw.files)), { negate: row.negate });
      else if (t.dataset.pf === 'negate') row.negate = t.checked;
      else row[t.dataset.pf] = t.value;
      setPre(e, i, row);
      return changed(t.dataset.pf === 'kind' ? ['all'] : ['evlist']);
    }
  });

  // ---------- bound fields (task 6-1) ----------
  // A form field bound to a path in one file of the working copy; typing
  // and picking go through WorldEdit.set (kinds there). label is HTML.
  // o: { rows, options: [{id, name}], blank, placeholder, max, min, maxv, step, live, hint, aria }
  function fld(file, path, kind, label, o = {}) {
    const v = WE.get(cw.files[file], path);
    const attrs = `data-file="${esc(file)}" data-path="${esc(path)}" data-kind="${kind}"${o.live ? ` data-live="${o.live}"` : ''}${o.aria ? ` aria-label="${esc(o.aria)}"` : ''}`;
    const ph = o.placeholder != null && o.placeholder !== '' ? ` placeholder="${esc(o.placeholder)}"` : '';
    const hint = o.hint ? ` <span class="muted small">${o.hint}</span>` : '';
    if (kind === 'bool' || kind === 'unseen') return `<label class="c-check"><input type="checkbox" ${attrs}${(kind === 'bool' ? v === true : v !== false) ? ' checked' : ''}> <span>${label}${hint}</span></label>`;
    let input;
    if (o.options) {
      input = `<select ${attrs}>${o.blank != null ? `<option value="">${esc(o.blank)}</option>` : ''}${o.options.map((x) => `<option value="${esc(x.id)}"${String(v ?? '') === String(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
    } else if (o.rows || kind === 'lines' || kind === 'json') {
      input = `<textarea ${attrs} rows="${o.rows || 3}"${ph}${o.max ? ` maxlength="${o.max}"` : ''}${kind === 'json' ? ' spellcheck="false"' : ''}>${esc(WE.show(kind, v))}</textarea>`;
    } else {
      const num = kind === 'num' || kind === 'int';
      input = `<input ${attrs}${num ? ` type="number" step="${o.step || (kind === 'int' ? 1 : 'any')}"${o.min != null ? ` min="${o.min}"` : ''}${o.maxv != null ? ` max="${o.maxv}"` : ''}` : ''} value="${esc(WE.show(kind, v))}"${ph}${o.max ? ` maxlength="${o.max}"` : ''}>`;
    }
    const err = ['json', 'num', 'int'].includes(kind) ? `<span class="bad small c-err" data-err="${esc(file + '|' + path)}"></span>` : '';
    return label == null ? input + err : `<label>${label}${hint}${input}${err}</label>`;
  }
  const count = (file, path, max) => `<span class="muted small" data-count="${esc(file + '|' + path)}" data-max="${max}">${String(WE.get(cw.files[file], path) || '').length}/${max}</span>`;
  function setField(t, parts) {
    const file = cw.files[t.dataset.file];
    if (!file) return;
    const r = WE.set(file, t.dataset.path, t.dataset.kind, t.type === 'checkbox' ? t.checked : t.value);
    const key = t.dataset.file + '|' + t.dataset.path;
    $('cMain').querySelectorAll('[data-err]').forEach((el) => { if (el.dataset.err === key) el.textContent = r.error ? `Not saved yet: ${r.error}` : ''; });
    $('cMain').querySelectorAll('[data-count]').forEach((el) => { if (el.dataset.count === key) el.textContent = `${t.value.length}/${el.dataset.max}`; });
    if (r.error) return;
    const m = t.dataset.file.match(/^starts\/(.+)\.json$/), c = t.dataset.path.match(/^cast\.(\d+)\./);
    if (m && c) WE.tidyCastEntry(cw.files, m[1], Number(c[1]));
    changed(parts.concat(t.dataset.live ? t.dataset.live.split(' ') : []));
  }
  $('cMain').addEventListener('input', (ev) => {
    const t = ev.target;
    if (!cw || !t.dataset || !t.dataset.path || t.type === 'checkbox' || t.tagName === 'SELECT') return;
    setField(t, []);
  });
  $('cMain').addEventListener('change', (ev) => {
    const t = ev.target;
    if (!cw || !t.dataset || !t.dataset.path || !(t.type === 'checkbox' || t.tagName === 'SELECT')) return;
    setField(t, ['all']);
  });
  // Key/value rows (world status, a clock's fireWorld).
  function kvRows(file, path, list) {
    const obj = WE.get(cw.files[file], path) || {};
    return `<div class="c-kv">${Object.keys(obj).map((k) => `<div class="c-kvrow"><input value="${esc(k)}" data-rekey="${esc(`${file}|${path}|${k}`)}" aria-label="Key"${list ? ` list="${list}"` : ''}>${fld(file, `${path}.${k}`, 'str', null, { aria: `Value of ${k}` })}<button type="button" class="small ghost" data-delkey="${esc(`${file}|${path}|${k}`)}" aria-label="Remove ${esc(k)}">✕</button></div>`).join('')}
      <button type="button" class="small" data-addkey="${esc(`${file}|${path}`)}">+ Key</button></div>`;
  }
  const addBtn = (file, path, tpl, label) => `<button type="button" class="small" data-add="${esc(`${file}|${path}`)}" data-tpl="${esc(JSON.stringify(tpl))}">${esc(label)}</button>`;
  const delBtn = (file, path, i, what) => `<button type="button" class="small ghost" data-del="${esc(`${file}|${path}|${i}`)}" aria-label="Remove ${esc(what)}">✕</button>`;
  // Generic list and key edits, on every tab.
  $('cMain').addEventListener('click', (ev) => {
    if (!cw) return;
    const t = ev.target;
    const add = t.closest('[data-add]'), del = t.closest('[data-del]'), addKey = t.closest('[data-addkey]'), delKey = t.closest('[data-delkey]'), addClock = t.closest('[data-addclock]');
    if (add) { const [f, p] = add.dataset.add.split('|'); WE.addItem(cw.files[f], p, JSON.parse(add.dataset.tpl)); return changed(); }
    if (addClock) { const [f, p] = addClock.dataset.addclock.split('|'); WE.addItem(cw.files[f], p, WE.newClock(cw.files)); return changed(); }
    if (del) { const [f, p, i] = del.dataset.del.split('|'); WE.removeItem(cw.files[f], p, i); return changed(); }
    if (addKey) {
      const [f, p] = addKey.dataset.addkey.split('|');
      const obj = WE.get(cw.files[f], p) || {};
      let k = 'new-key';
      for (let i = 2; k in obj; i++) k = `new-key-${i}`;
      WE.set(cw.files[f], `${p}.${k}`, 'str', '');
      return changed();
    }
    if (delKey) { const [f, p, k] = delKey.dataset.delkey.split('|'); WE.set(cw.files[f], `${p}.${k}`, 'text', ''); return changed(); }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || !ev.target.dataset.rekey) return;
    const [f, p, k] = ev.target.dataset.rekey.split('|');
    const err = WE.renameKey(WE.get(cw.files[f], p), k, ev.target.value);
    banner(err ? esc(`"${ev.target.value}" can't be used: ${err}.`) : '', err ? 'bad' : '');
    changed();
  });
  const idList = (list) => (list || []).filter((x) => x && x.id).map((x) => ({ id: x.id, name: x.name || x.label || x.id }));

  // ---------- the world tab (task 6-1) ----------
  function renderWorldTab() {
    const w = world(), F = 'world.json';
    const pace = E.Genres.pacing(Object.assign({}, w, { eventRates: {}, majorEventDays: null }));
    const regions = idList(w.regions);
    const seeds = (tier) => {
      const list = (w.eventSeeds && w.eventSeeds[tier]) || [];
      return `<div class="c-rows">${list.map((sd, i) => `<div class="c-kvrow">${fld(F, WE.seedPath(w, tier, i), 'str', null, { aria: `${tier} idea ${i + 1}` })}${regions.length ? `<select data-seedregion="${tier}|${i}" aria-label="Region">${options(regions, sd && sd.region, 'anywhere')}</select>` : ''}${delBtn(F, `eventSeeds.${tier}`, i, 'idea')}</div>`).join('')}
        ${addBtn(F, `eventSeeds.${tier}`, '', '+ Idea')}</div>`;
    };
    return `<div class="c-form">
      <div id="cWorldProblems"></div>
      <section><h3>About</h3>
        ${fld(F, 'title', 'text', 'Title', { max: 80 })}
        ${fld(F, 'summary', 'text', 'Summary', { rows: 2, hint: 'one or two lines for the world picker' })}
        ${fld(F, 'setting', 'str', 'Setting', { rows: 6, hint: 'always in the prompt: keep it broad, and put regional detail in region lore' })}
        ${fld(F, 'rules', 'lines', 'Rules', { rows: 4, hint: 'one per line: what is and isn\'t possible here' })}</section>
      <section><h3>Genre and tone</h3>
        ${fld(F, 'tags', 'csv', 'Genre tags', { live: 'genre', hint: 'comma-separated, most important first', placeholder: Object.keys(E.Genres.table).join(', ') })}
        <div id="cGenre" class="c-genre"></div>
        <label>Tone note ${count(F, 'toneNote', 300)}${fld(F, 'toneNote', 'text', null, { rows: 2, max: 300 })}</label></section>
      <section><h3>Time</h3><div class="c-row2">
        ${fld(F, 'timeLabel', 'text', 'Name of a day', { placeholder: 'Day', hint: '("Sol", "Day")' })}
        ${fld(F, 'wakeHour', 'int', 'Waking hour', { min: 0, maxv: 23, placeholder: '7' })}</div></section>
      <section><h3>Skills</h3>${fld(F, 'skills', 'csv', 'Skills', { hint: 'comma-separated; what people roll for' })}</section>
      <section><h3>Needs</h3>
        ${(w.needs || []).length ? '' : '<p class="muted small">No needs: no bars and no need penalties. That suits worlds where bodies aren\'t the story.</p>'}
        ${(w.needs || []).map((n, i) => `<div class="c-card"><div class="c-row3">
          <label>Id <input value="${esc(n.id)}" data-idof="need" data-old="${esc(n.id)}"></label>
          ${fld(F, `needs.${i}.label`, 'text', 'Label')}
          ${fld(F, `needs.${i}.perHour`, 'num', 'Rises per hour', { step: 0.005, min: 0 })}</div>
          <details><summary class="small">When it is pushed too far (JSON)</summary>${fld(F, `needs.${i}.limit`, 'json', null, { rows: 3, placeholder: '{"text": "blacks out from exhaustion"}' })}</details>
          <button type="button" class="small danger" data-delneed="${esc(n.id)}">Remove need</button></div>`).join('')}
        <button type="button" class="small" id="cAddNeed">+ Need</button></section>
      <section><h3>Pacing</h3>
        <p class="muted small">Blank uses what the genre tags give (shown greyed).</p>
        <div class="c-row2">${fld(F, 'eventRates.regional', 'num', 'Hours between nearby events', { min: 1, placeholder: pace.eventRates.regional })}
        ${fld(F, 'eventRates.world', 'num', 'Hours between far-away events', { min: 1, placeholder: pace.eventRates.world })}
        ${fld(F, 'majorEventDays', 'num', 'Days to a major event (skipping)', { min: 1, placeholder: pace.majorEventDays })}
        ${fld(F, 'majorHorizonDays', 'num', 'Longest skip, in days', { min: 1, placeholder: 30 })}
        ${fld(F, 'tiers.demoteAfter', 'int', 'Turns before someone out of the scene fades back', { min: 1, placeholder: 4 })}
        ${fld(F, 'tiers.maxLocal', 'int', 'Most people in the foreground', { min: 1, placeholder: 6 })}</div>
        ${fld(F, 'inventExtras', 'bool', 'Let the story add minor people during play')}</section>
      <section><h3>Event ideas</h3>
        <h4 class="small">Nearby</h4>${seeds('regional')}
        <h4 class="small">Far away</h4>${seeds('world')}
        ${fld(F, 'majorSeeds', 'lines', 'Major events', { rows: 4, hint: 'one per line; used when a major event rolls' })}</section>
      <section><h3>World status</h3><p class="muted small">Public values the story can change (power, weather, what's open). Starts may add or change them.</p>${kvRows(F, 'world')}</section>
      <section><h3>Public facts</h3>${fld(F, 'facts', 'lines', null, { rows: 4, placeholder: 'One per line: true everywhere, known to everyone' })}</section>
      <section><h3>Advanced</h3>
        ${fld(F, 'regionLabels', 'csv', 'Region labels by level', { placeholder: 'nation, province, city', hint: 'from the top; a region\'s own label wins' })}
        ${fld(F, 'revealSkills', 'csv', 'Skills that can pry secrets loose', { placeholder: 'social' })}

        ${(w.needs || []).length ? fld(F, 'revealPressure', 'csv', 'Needs that count as pressure on secrets', { placeholder: (w.needs || []).map((n) => n.id).join(', ') }) : ''}
        ${fld(F, 'skillPenalties', 'json', 'Roll penalties (JSON)', { rows: 3, placeholder: '{"health": {"hurt": -1}, "needs": [{"need": "fatigue", "at": 0.8, "penalty": -1}]}' })}
        ${fld(F, 'tagThresholds', 'json', 'Card tags from needs (JSON)', { rows: 2, placeholder: '{"fatigue": {"at": 0.8, "tag": "exhausted"}}' })}
        ${fld(F, 'date', 'json', 'Start date (JSON)', { rows: 1, placeholder: '{"day": 1, "hour": 9}', hint: 'for Make my own, and starts that give none' })}
        ${fld(F, 'generatedStarts', 'json', 'Generated starts (JSON)', { rows: 3, hint: 'optional tuning; a world with no starts has them anyway (see docs/WORLDS.md)' })}
        ${fld(F, 'generatedSites', 'json', 'Generated sites (JSON)', { rows: 2, placeholder: '{"maxSites": 8, "keepDays": 3}' })}
        ${fld(F, 'generatedRegions', 'json', 'Generated regions (JSON)', { rows: 2, placeholder: '{"maxRegions": 6, "keepDays": 7, "routeKind": "road"}', hint: 'new towns or planets the story heads for; needs generated sites' })}</section>

    </div>`;
  }
  function renderGenre() {
    const el = $('cGenre');
    if (!el) return;
    const { known, free } = E.Genres.split(world().tags);
    const DANGER = { lethal: 'people can die', serious: 'people can be badly hurt; death is rare', mild: 'harm is mostly social or emotional' };
    el.innerHTML = known.map((k, i) => { const g = E.Genres.table[k]; return `<div class="small"><b>${esc(k)}</b>${i === 0 ? ' <span class="muted">(leads)</span>' : ''}: ${esc(g.tone)}${i === 0 ? `<br><span class="muted">A major event means ${esc(g.major)}. Danger: ${esc(DANGER[g.danger])}.</span>` : ''}</div>`; }).join('') +
      (free.length ? `<div class="small muted">Passed on as written: ${esc(free.join(', '))}.</div>` : '') +
      (!known.length && !free.length ? '<div class="small muted">No tags: the story plays as grounded survival by default.</div>' : '');
  }
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'world') return;
    const t = ev.target;
    if (t.id === 'cAddNeed') { WE.addNeed(cw.files); return changed(); }
    if (t.dataset.delneed) { WE.removeNeed(cw.files, t.dataset.delneed); return changed(); }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'world') return;
    const t = ev.target;
    if (t.dataset.idof === 'need') {
      const err = WE.renameNeed(cw.files, t.dataset.old, t.value);
      banner(err ? esc(`"${t.value}" can't be used: ${err}.`) : '', err ? 'bad' : '');
      return changed();
    }
    if (t.dataset.seedregion) { const [tier, i] = t.dataset.seedregion.split('|'); WE.setSeedRegion(world(), tier, Number(i), t.value); return changed(); }
  });

  // ---------- the groups tab (task 6-1) ----------
  function renderGroupsTab() {
    return `<div class="c-split">
      <div class="c-scroll-col"><p class="muted small">Groups are the factions, crews and institutions of the world: who holds each region, who a group of people on the map belongs to, and whose stance the story can shift.</p>
        <div id="cGroupList" class="c-list"></div><button type="button" id="cAddGroup" class="small">+ Group</button></div>
      <aside class="c-panel" id="cGroupForm">${groupForm()}</aside></div>`;
  }
  function renderGroupList() {
    const el = $('cGroupList');
    if (!el) return;
    const fs = world().factions || [];
    el.innerHTML = fs.map((f) => `<button type="button" data-gsel="${esc(f.id)}" aria-pressed="${f.id === gui.sel}"><span class="swatch ${D.factionClass(fs, f.id)}"></span>${esc(f.name || f.id)}${f.stance ? ` <span class="muted small">${esc(E.shorten(f.stance, 60))}</span>` : ''}</button>`).join('') || '<span class="muted">No groups yet.</span>';
  }
  function groupForm() {
    const w = world(), F = 'world.json';
    const i = (w.factions || []).findIndex((f) => f.id === gui.sel);
    if (i < 0) return '<p class="muted">Pick a group, or add one.</p>';
    const f = w.factions[i];
    const held = (w.regions || []).filter((r) => r.controller === f.id);
    return `<h3><span class="swatch ${D.factionClass(w.factions, f.id)}"></span>${esc(f.name || f.id)}</h3>
      <div id="cGroupProblems"></div>
      <label>Id <input value="${esc(f.id)}" data-idof="group" data-old="${esc(f.id)}"></label><div class="muted small">Regions, groups on the map and timeline events that name it follow a rename.</div>
      ${fld(F, `factions.${i}.name`, 'text', 'Name', { live: 'grouplist', max: 60 })}
      ${fld(F, `factions.${i}.desc`, 'text', 'Who they are', { rows: 3 })}
      ${fld(F, `factions.${i}.stance`, 'text', 'Stance at the start', { live: 'grouplist', hint: 'toward the player\'s people; starts may change it', max: 140 })}
      ${fld(F, `factions.${i}.color`, 'int', 'Colour on the map', { blank: 'auto (from the id)', options: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: String(n), name: `colour ${n}` })) })}
      <div class="small">${held.length ? `Holds ${held.map((r) => regionChip(r.id)).join(', ')}` : '<span class="muted">Holds no region.</span>'}</div>
      <button type="button" id="cDelGroup" class="small danger">${gui.confirm ? 'Click again to delete' : 'Delete group'}</button>`;
  }
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'groups') return;
    const t = ev.target;
    const sel = t.closest('[data-gsel]');
    if (sel) { gui.sel = sel.dataset.gsel; gui.confirm = false; return render(); }
    if (t.id === 'cAddGroup') { gui.sel = WE.addGroup(cw.files); gui.confirm = false; return changed(); }
    if (t.id === 'cDelGroup') {
      if (!gui.confirm) { gui.confirm = true; return render(); }
      const notes = WE.removeGroup(cw.files, gui.sel);
      gui.sel = null; gui.confirm = false;
      banner(notes.length ? esc(notes.join('; ')) : '');
      return changed();
    }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'groups' || ev.target.dataset.idof !== 'group') return;
    const t = ev.target;
    const err = WE.renameGroup(cw.files, t.dataset.old, t.value.trim());
    if (err) banner(esc(`"${t.value}" can't be used: ${err}.`), 'bad'); else { banner(''); gui.sel = t.value.trim(); }
    changed();
  });

  // ---------- the starts tab (task 6-1) ----------
  const startSel = () => { const ids = world().starts || []; if (!ids.includes(sui.sel)) sui.sel = ids[0] || null; return sui.sel; };
  function renderStartsTab() {
    const sid = startSel();
    return `<div class="c-split">
      <div class="c-scroll-col" id="cStartForm">${sid ? startForm(sid) : '<p class="muted">No starts: add one.</p>'}</div>
      <aside class="c-panel"><section><h3>Starts</h3><div id="cStartList" class="c-list"></div>
        <button type="button" id="cAddStart" class="small">+ Start</button> ${sid ? `<button type="button" id="cDupStart" class="small">Duplicate</button>
        <button type="button" id="cDelStart" class="small danger">${sui.confirm ? 'Click again to delete' : 'Delete'}</button>` : ''}</section>
        ${sid ? `<section><button type="button" data-testplay="${esc(sid)}">▶ Test play this start</button><div class="muted small">Opens the game in a new tab with the world as it is now, without exporting.</div></section>
        <section><h3>Rooms</h3><div id="cPreview" class="c-preview"></div></section>` : ''}</aside></div>`;
  }
  function renderStartList() {
    const el = $('cStartList');
    if (!el) return;
    el.innerHTML = Object.entries(starts()).map(([id, st]) => `<button type="button" data-ssel="${esc(id)}" aria-pressed="${id === sui.sel}">${esc(st.title || id)}${id === (world().starts || [])[0] ? ' <span class="muted small">default</span>' : ''}</button>`).join('');
  }
  // The local map as the game draws it, everything in view.
  function renderPreview() {
    const el = $('cPreview');
    const st = sui.sel && starts()[sui.sel];
    if (!el || !st) return;
    const locs = [].concat(world().locations || [], st.locations || []).filter((l) => l && l.id);
    try {
      const seed = `${world().id || cw.folder}:${sui.sel}`;
      const plan = E.Layouts.plan(locs, { type: (st.site || world().site || {}).type, seed });
      const rooms = {};
      locs.forEach((l) => (rooms[l.id] = { name: l.name || l.id, outside: !!l.outside, features: (l.features || []).map((f) => (typeof f === 'string' ? { name: f } : { name: f.name, state: f.state })) }));
      el.innerHTML = E.SiteDraw.render(plan, rooms, { inView: Object.keys(plan.rooms), remembered: [], here: null, seed, links: {}, tokens: {}, tokenSvg: () => '' });
    } catch (e) { el.innerHTML = `<div class="muted small">The map can't be drawn yet: ${esc(e.message)}</div>`; }
  }
  function startForm(sid) {
    const w = world(), st = starts()[sid], F = WE.startFile(sid);
    const roomList = idList(WE.roomsOf(cw.files, sid));
    const cast = WE.castIds(st);
    const person = (id) => WE.character(cw.files, id) || { name: id };
    const castList = cast.map((id) => ({ id, name: person(id).name || id }));
    const needs = w.needs || [];
    return `<div class="c-form">
      <div id="cStartProblems"></div>
      <section><h3>Basics</h3>
        <label>Id <input value="${esc(sid)}" data-idof="start" data-old="${esc(sid)}"></label>
        ${fld(F, 'title', 'text', 'Title', { live: 'startlist', max: 80, placeholder: 'Sol 214: the recycler' })}
        ${fld(F, 'summary', 'text', 'Summary', { rows: 2, hint: 'shown in the start picker: who you are and what\'s going on' })}
        <div class="c-row3">${fld(F, 'start.day', 'int', esc(w.timeLabel || 'Day'), { min: 0 })}${fld(F, 'start.hour', 'int', 'Hour', { min: 0, maxv: 23 })}
        ${fld(F, 'castLabel', 'text', 'Sidebar heading', { placeholder: 'Crew' })}</div>
        ${(w.regions || []).length ? fld(F, 'region', 'text', 'Region', { options: idList(w.regions), blank: 'pick a region' }) : ''}</section>
      <section><h3>Who you play</h3>
        <label>The player <select id="cPlayer">${options(castList, st.player)}<option value=""${st.player ? '' : ' selected'}>no one: each player makes their own</option></select></label>
        <label class="c-check"><input type="checkbox" id="cSlotOn"${st.playerSlot ? ' checked' : ''}${st.player ? '' : ' disabled'}> <span>Players may make their own character</span></label>
        ${st.playerSlot ? slotForm(F, st, roomList, needs) : ''}</section>
      <section><h3>Cast</h3>
        ${(st.cast || []).map((c, i) => castCard(F, st, i, castList, roomList, needs)).join('') || '<p class="muted small">Nobody yet.</p>'}
        <div class="c-kvrow"><select id="cCastAdd" aria-label="Add someone from the world's people"><option value="">Add someone from the world's people…</option>${options((w.characters || []).filter((id) => !cast.includes(id)).map((id) => ({ id, name: person(id).name || id })))}</select>
          <button type="button" id="cNewPerson" class="small">+ New person</button></div>
        ${sui.newPerson ? `<div class="c-card" id="cNewPersonForm"><div class="c-row3"><label>Name <input id="cNpName" maxlength="60"></label><label>Role <input id="cNpRole" placeholder="mechanic"></label><label>Pronouns <input id="cNpPronouns" placeholder="they/them"></label></div>
          <button type="button" id="cNpAdd" class="small">Add to the cast</button> <span class="muted small">The rest of who they are (traits, want, secret, skills) comes with the character editor.</span></div>` : ''}</section>
      <section><h3>Rooms</h3>
        ${(w.locations || []).length ? '<p class="muted small">Rooms marked "every start" are kept in world.json and shared by all the starts.</p>' : ''}
        ${(w.locations || []).map((l, j) => roomCard('world.json', st, l, j, castList)).join('')}
        ${(st.locations || []).map((l, j) => roomCard(F, st, l, j, castList)).join('')}
        <div class="c-kvrow"><input id="cNewRoom" placeholder="Name of a new room" aria-label="Name of a new room"><button type="button" id="cAddRoom" class="small">+ Room</button></div>
        <div class="c-row2">${fld(F, 'site.type', 'text', 'Layout style', { blank: w.site && w.site.type ? `as every start (${w.site.type})` : 'generic', options: E.Layouts.STYLES.filter((x) => x !== 'generic').map((x) => ({ id: x, name: x === 'hall' ? 'hall (the biggest room in the middle)' : 'corridor (rooms off a spine)' })) })}</div>
        <h4 class="small">Ways in from outside</h4>
        ${(w.entrances || []).length ? `<p class="muted small">Every start: ${esc(w.entrances.map((e) => `${(roomList.find((r) => r.id === e.room) || { name: e.room }).name} (${e.kind}${e.watched ? ', watched' : ''})`).join(', '))}. A start's own list replaces it.</p>` : ''}
        ${(st.entrances || []).map((e, k) => `<div class="c-kvrow">${fld(F, `entrances.${k}.room`, 'text', null, { options: roomList, aria: 'Room' })}${fld(F, `entrances.${k}.kind`, 'text', null, { placeholder: 'roller door', aria: 'Kind' })}${fld(F, `entrances.${k}.watched`, 'bool', 'watched')}${delBtn(F, 'entrances', k, 'way in')}</div>`).join('')}
        ${roomList.length ? addBtn(F, 'entrances', { room: roomList[0].id, kind: 'door', watched: false }, '+ Way in') : ''}</section>
      <section><h3>Pressures</h3><p class="muted small">Clocks that fill by the hour and go off at their maximum; a follow-up starts when its clock goes off.</p>
        <datalist id="cWorldKeys">${[...new Set(Object.keys(w.world || {}).concat(Object.keys(st.world || {})))].map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
        ${clockRows(F, 'clocks', st.clocks, 0)}
        <button type="button" class="small" data-addclock="${esc(F + '|clocks')}">+ Pressure</button></section>
      <section><h3>Minor people</h3>
        ${(st.extras || []).map((x, k) => `<div class="c-card"><div class="c-row3">${fld(F, `extras.${k}.id`, 'text', 'Id')}${fld(F, `extras.${k}.name`, 'text', 'Name', { max: 40 })}${fld(F, `extras.${k}.role`, 'text', 'Role', { max: 60 })}
          ${fld(F, `extras.${k}.location`, 'null', 'Where', { options: roomList, blank: 'nowhere in particular' })}${fld(F, `extras.${k}.pronouns`, 'text', 'Pronouns', { max: 20 })}</div>
          ${fld(F, `extras.${k}.note`, 'text', 'Note', { max: 200 })}${delBtn(F, 'extras', k, x.name || 'minor person')}</div>`).join('')}
        ${addBtn(F, 'extras', { id: WE.uniqueId(cw.files, 'someone'), name: 'Someone', role: 'bystander', location: null }, '+ Minor person')}
        <h4 class="small">Groups of people in rooms</h4>
        ${(st.standees || []).map((g, k) => `<div class="c-card"><div class="c-row3">${fld(F, `standees.${k}.id`, 'text', 'Id')}${fld(F, `standees.${k}.label`, 'text', 'Label')}${fld(F, `standees.${k}.count`, 'int', 'How many', { min: 1, maxv: 999 })}
          ${fld(F, `standees.${k}.location`, 'text', 'Where', { options: roomList, blank: 'pick a room' })}${fld(F, `standees.${k}.state`, 'text', 'State', { blank: 'calm', options: ['alert', 'hostile', 'down'].map((x) => ({ id: x, name: x })) })}
          ${fld(F, `standees.${k}.faction`, 'text', 'Group', { blank: 'none', options: idList(w.factions) })}${fld(F, `standees.${k}.post`, 'text', 'Holds', { blank: 'no room', options: roomList })}
          ${fld(F, `standees.${k}.patrol`, 'csv', 'Patrol (room ids)', { placeholder: roomList.slice(0, 2).map((r) => r.id).join(', ') })}</div>
          ${fld(F, `standees.${k}.note`, 'text', 'Note (never shown to the player)', { max: 200 })}${delBtn(F, 'standees', k, g.label || 'group')}</div>`).join('')}
        ${roomList.length ? addBtn(F, 'standees', { id: WE.uniqueId(cw.files, 'group'), label: 'group', count: 3, location: roomList[0].id }, '+ Group of people') : ''}</section>
      <section><h3>Facts and opening</h3>
        ${fld(F, 'facts', 'lines', 'Public facts for this start', { rows: 3 })}
        ${fld(F, 'opening', 'str', 'Opening scene', { rows: 8, hint: 'the first thing the player reads; end on a moment that asks for a choice' })}</section>
    </div>`;
  }
  function slotForm(F, st, roomList, needs) {
    const skills = world().skills || WE.SKILLS;
    const roles = st.playerSlot.roles || [];
    return `<div class="c-card">
      <div class="c-row3">${fld(F, 'playerSlot.location', 'text', 'Starts in', { options: roomList, blank: 'pick a room' })}
        ${fld(F, 'playerSlot.skillPoints', 'int', 'Skill points', { min: 0 })}${fld(F, 'playerSlot.maxSkill', 'int', 'Highest skill', { min: 1, maxv: 4 })}</div>
      ${fld(F, 'playerSlot.summary', 'text', 'Summary for "Make my own"', { rows: 2, max: 400 })}
      ${fld(F, 'playerSlot.freeform', 'bool', 'Players may write their own role')}
      ${st.player ? fld(F, 'playerSlot.keepDefault', 'bool', 'Keep the usual player in the story as someone else') : ''}
      <h4 class="small">Roles</h4>
      ${roles.map((r, j) => `<div class="c-card c-sub"><div class="c-row3">${fld(F, `playerSlot.roles.${j}.label`, 'text', 'Label')}${fld(F, `playerSlot.roles.${j}.id`, 'text', 'Id')}${fld(F, `playerSlot.roles.${j}.suggestedTraits`, 'csv', 'Suggested traits')}</div>
        ${fld(F, `playerSlot.roles.${j}.desc`, 'text', 'Description')}
        <div class="c-skills">${skills.map((k) => fld(F, `playerSlot.roles.${j}.skills.${k}`, 'int', esc(k), { min: 0, maxv: 4 })).join('')}</div>${delBtn(F, 'playerSlot.roles', j, r.label || 'role')}</div>`).join('')}
      ${addBtn(F, 'playerSlot.roles', { id: WE.slug('role', roles.map((r) => r.id), 'role'), label: 'New role', desc: '', skills: {} }, '+ Role')}
      ${fld(F, 'playerSlot.knows', 'lines', 'What they know at the start', { rows: 2 })}
      ${needs.length ? `<div class="c-skills">${needs.map((n) => fld(F, `playerSlot.needs.${n.id}`, 'num', esc(n.label || n.id), { min: 0, maxv: 1, step: 0.05 })).join('')}</div>` : ''}
      <details><summary class="small">Peoples and feelings (JSON)</summary>
        ${fld(F, 'playerSlot.peoples', 'json', 'Peoples', { rows: 2, placeholder: '[{"id": "local", "label": "Harbor-born", "desc": "..."}]' })}
        ${fld(F, 'playerSlot.relationsDefault', 'json', 'How they feel about the cast', { rows: 1, placeholder: '10, or {"okafor": 20}' })}
        ${fld(F, 'playerSlot.castFeelings', 'json', 'How the cast feels about them', { rows: 1, placeholder: '0' })}</details></div>`;
  }
  function castCard(F, st, i, castList, roomList, needs) {
    const c = st.cast[i];
    const id = typeof c === 'string' ? c : c && c.id;
    const file = WE.character(cw.files, id);
    if (!file) return `<div class="c-card"><b class="bad">${esc(id)}</b>: no character file. ${delBtn(F, 'cast', i, id)}</div>`;
    const where = file.status && (roomList.find((r) => r.id === file.status.location) || {}).name;
    const p = `cast.${i}`;
    return `<details class="c-card" data-castcard="${esc(id)}"${id === st.player ? ' open' : ''}><summary><b>${esc(file.name || id)}</b> <span class="muted small">${esc(file.role || '')}${id === st.player ? ' · the player' : ''}</span>
        <button type="button" class="small ghost" data-uncast="${esc(id)}" aria-label="Take ${esc(file.name || id)} out of this start">✕</button></summary>
      <div class="c-row3">${fld(F, `${p}.status.location`, 'text', 'Starts in', { options: roomList, blank: where ? `as in their file (${where})` : 'pick a room' })}
        ${fld(F, `${p}.tier`, 'text', 'In the foreground', { blank: 'if in the player\'s room', options: [{ id: 'local', name: 'yes' }, { id: 'secondary', name: 'no, offstage' }] })}
        ${fld(F, `${p}.pinned`, 'bool', 'Always in the foreground')}</div>
      ${castList.length > 1 ? `<div class="small">Feelings toward the others <span class="muted">(−100 to 100; blank: as in their file)</span></div><div class="c-skills">${castList.filter((o) => o.id !== id).map((o) => fld(F, `${p}.relations.${o.id}`, 'int', esc(o.name), { min: -100, maxv: 100, placeholder: (file.relations || {})[o.id] ?? 0 })).join('')}</div>` : ''}
      ${needs.length ? `<div class="c-skills">${needs.map((n) => fld(F, `${p}.needs.${n.id}`, 'num', esc(n.label || n.id), { min: 0, maxv: 1, step: 0.05, placeholder: (file.needs || {})[n.id] ?? 0 })).join('')}</div>` : ''}
      ${fld(F, `${p}.knows`, 'lines', 'What they know here', { rows: 2, placeholder: (file.knows || []).join('\n') || 'One per line; private to them' })}</details>`;
  }
  const KIND_LABEL = { '': 'connected', open: 'open', door: 'door', 'locked door': 'locked door', vent: 'vent', hatch: 'hatch', window: 'window', stairs: 'stairs' };
  // F: the file the room is kept in (the start's, or world.json for rooms
  // every start shares); connections are read across both.
  function roomCard(F, st, l, j, castList) {
    const p = `locations.${j}`;
    const holders = [world(), st];
    const all = WE.roomsOf(cw.files, sui.sel);
    const conns = WE.connections(holders, l.id);
    const others = all.filter((o) => o.id !== l.id && !conns.some((c) => c.to === o.id));
    const nameOf = (id) => (all.find((o) => o.id === id) || { name: id }).name;
    const shared = F === 'world.json';
    const open = sui.openRoom === l.id ? ' open' : '';
    return `<details class="c-card" data-roomcard="${esc(l.id)}"${open}><summary><b>${esc(l.name || l.id)}</b> <span class="muted small">(${esc(l.id)})${shared ? ' every start' : ''} ${conns.length ? `· ${esc(conns.map((c) => nameOf(c.to)).join(', '))}` : '· not connected'}</span></summary>
      <div class="c-row3">${fld(F, `${p}.name`, 'text', 'Name', { live: 'preview', max: 40 })}${fld(F, `${p}.size`, 'text', 'Size', { blank: 'medium', options: ['small', 'large'].map((x) => ({ id: x, name: x })) })}
        ${fld(F, `${p}.level`, 'int', 'Level', { min: -3, maxv: 5, placeholder: '0 (ground)' })}
        ${(world().regions || []).length ? fld(F, `${p}.region`, 'text', 'Region', { blank: 'the start\'s', options: idList(world().regions) }) : ''}</div>
      ${fld(F, `${p}.desc`, 'text', 'Description', { rows: 2 })}
      ${fld(F, `${p}.features`, 'features', 'Features', { live: 'preview', hint: 'up to 6, comma-separated; "camera=on" for one the story tracks' })}
      <div class="c-checks">${fld(F, `${p}.outside`, 'bool', 'Outside')}${fld(F, `${p}.secure`, 'bool', 'One way in only')}${fld(F, `${p}.seen`, 'unseen', 'The player knows it at the start')}</div>
      <div class="small">Ways through</div>
      ${conns.map((c) => { const key = `${l.id}|${c.to}`; return `<div class="c-conn"><span>${esc(nameOf(c.to))}</span><select data-conn="${esc(key)}" aria-label="Kind of way to ${esc(nameOf(c.to))}">${Object.entries(KIND_LABEL).map(([k, lab]) => `<option value="${esc(k)}"${(c.kind || '') === k ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select>
        ${c.kind === 'locked door' ? `<span class="small">key: ${castList.map((o) => `<label class="c-inline-check"><input type="checkbox" data-connkey="${esc(key)}" value="${esc(o.id)}"${(c.key || []).includes(o.id) ? ' checked' : ''}> ${esc(o.name)}</label>`).join('')}</span>` : ''}
        <button type="button" class="small ghost" data-disconn="${esc(key)}" aria-label="Disconnect ${esc(nameOf(c.to))}">✕</button></div>`; }).join('')}
      ${others.length ? `<select data-connadd="${esc(l.id)}" aria-label="Connect ${esc(l.name || l.id)} to"><option value="">Connect to…</option>${options(others.map((o) => ({ id: o.id, name: o.name || o.id })))}</select>` : ''}
      ${shared ? '' : `<button type="button" class="small danger" data-delroom="${esc(l.id)}">${sui.confirmRoom === l.id ? 'Click again to remove' : 'Remove room'}</button>`}</details>`;
  }
  function clockRows(F, base, list, depth) {
    return (list || []).map((c, i) => {
      const p = `${base}.${i}`;
      return `<div class="c-card${depth ? ' c-sub' : ''}"><div class="c-row3">${fld(F, `${p}.id`, 'text', 'Id')}${fld(F, `${p}.name`, 'text', 'Name', { max: 40 })}
        ${fld(F, `${p}.value`, 'num', 'Now', { min: 0 })}${fld(F, `${p}.max`, 'num', 'Goes off at', { min: 1 })}${fld(F, `${p}.perHour`, 'num', 'Per hour', { min: 0, step: 0.005 })}
        ${fld(F, `${p}.fireHarm`, 'text', 'Hurts', { blank: 'no one', options: [{ id: 'all', name: 'everyone' }, { id: 'outside', name: 'anyone outside' }] })}</div>
        ${fld(F, `${p}.fireText`, 'text', 'When it goes off', { rows: 2 })}
        ${fld(F, `${p}.repeat`, 'bool', 'Starts again after going off')}
        <div class="small">World status it sets</div>${kvRows(F, `${p}.fireWorld`, 'cWorldKeys')}
        ${(c.then || []).length ? `<div class="small">Then</div>${clockRows(F, `${p}.then`, c.then, depth + 1)}` : ''}
        <button type="button" class="small" data-addclock="${esc(`${F}|${p}.then`)}">+ Follow-up</button> ${delBtn(F, base, i, c.name || 'pressure')}</div>`;
    }).join('');
  }
  // A room card stays open across redraws while it is being edited.
  $('cMain').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.dataset && d.dataset.roomcard) { if (d.open) sui.openRoom = d.dataset.roomcard; else if (sui.openRoom === d.dataset.roomcard) sui.openRoom = null; }
  }, true);
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'starts') return;
    const t = ev.target;
    const sel = t.closest('[data-ssel]');
    if (sel) { sui.sel = sel.dataset.ssel; sui.confirm = false; sui.confirmRoom = null; return render(); }
    if (t.id === 'cAddStart') { sui.sel = WE.addStart(cw.files); sui.confirm = false; return changed(); }
    const sid = sui.sel;
    if (!sid) return;
    const st = starts()[sid];
    if (t.id === 'cDupStart') { sui.sel = WE.duplicateStart(cw.files, sid); return changed(); }
    if (t.id === 'cDelStart') {
      if (!sui.confirm) { sui.confirm = true; return render(); }
      const r = WE.removeStart(cw.files, sid);
      sui.confirm = false;
      if (r.error) { banner(esc(r.error), 'bad'); return render(); }
      sui.sel = null;
      return changed();
    }
    const un = t.closest('[data-uncast]');
    if (un) { ev.preventDefault(); const notes = WE.removeFromCast(cw.files, sid, un.dataset.uncast); banner(esc(notes.join('; '))); return changed(); }
    if (t.id === 'cNewPerson') { sui.newPerson = !sui.newPerson; return render(); }
    if (t.id === 'cNpAdd') {
      const name = $('cNpName').value.trim();
      if (!name) { banner('Give the new person a name first.', 'bad'); return; }
      const id = WE.newPerson(cw.files, { name, role: $('cNpRole').value, pronouns: $('cNpPronouns').value });
      WE.addToCast(cw.files, sid, id);
      sui.newPerson = false;
      banner('');
      return changed();
    }
    if (t.id === 'cAddRoom') {
      const name = $('cNewRoom').value.trim();
      sui.openRoom = WE.addRoom(cw.files, sid, name || undefined);
      return changed();
    }
    const dr = t.closest('[data-delroom]');
    if (dr) {
      if (sui.confirmRoom !== dr.dataset.delroom) { sui.confirmRoom = dr.dataset.delroom; return render(); }
      const r = WE.removeRoom(cw.files, sid, dr.dataset.delroom);
      sui.confirmRoom = null;
      banner(r.error ? esc(r.error) : esc(r.notes.join('; ')), r.error ? 'bad' : '');
      return changed();
    }
    const dc = t.closest('[data-disconn]');
    if (dc) { const [a, b] = dc.dataset.disconn.split('|'); WE.disconnect([world(), st], a, b); return changed(); }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'starts' || !sui.sel) return;
    const t = ev.target;
    const sid = sui.sel, st = starts()[sid];
    if (t.dataset.idof === 'start') {
      const err = WE.renameStart(cw.files, sid, t.value.trim());
      if (err) banner(esc(`"${t.value}" can't be used: ${err}.`), 'bad'); else { banner(''); sui.sel = t.value.trim(); }
      return changed();
    }
    if (t.id === 'cPlayer') {
      if (t.value) st.player = t.value;
      else { delete st.player; WE.ensureSlot(cw.files, sid); delete st.playerSlot.keepDefault; }
      return changed();
    }
    if (t.id === 'cSlotOn') { if (t.checked) WE.ensureSlot(cw.files, sid); else delete st.playerSlot; return changed(); }
    if (t.id === 'cCastAdd' && t.value) { WE.addToCast(cw.files, sid, t.value); return changed(); }
    if (t.dataset.conn) {
      const [a, b] = t.dataset.conn.split('|');
      const c = WE.connections([world(), st], a).find((x) => x.to === b);
      WE.connect([world(), st], a, b, t.value || null, c && c.key);
      return changed();
    }
    if (t.dataset.connkey) {
      const [a, b] = t.dataset.connkey.split('|');
      const c = WE.connections([world(), st], a).find((x) => x.to === b) || {};
      const key = new Set(c.key || []);
      if (t.checked) key.add(t.value); else key.delete(t.value);
      WE.connect([world(), st], a, b, 'locked door', [...key]);
      return changed();
    }
    if (t.dataset.connadd && t.value) { WE.connect([world(), st], t.dataset.connadd, t.value, null); return changed(); }
  });

  // ---------- the characters tab (task 6-2) ----------
  // The world's people in the shared character form (js/charform.js, author
  // mode). An edit is saved when the form builds; until then its problems
  // show under it. Card import: read the card, one conversion call, review
  // the sheet in the same form, then add it.
  const CM = E.CharMaker, Cards = E.Cards;
  const pool = () => { const out = {}; (world().characters || []).forEach((id) => { if (cw.files[`characters/${id}.json`]) out[id] = cw.files[`characters/${id}.json`]; }); return out; };
  // A composed start, for the form's header (Suggest) and the conversion.
  function baseScenario() {
    try {
      const w = S.prepareWorld(cw.folder, JSON.parse(JSON.stringify(cw.files)));
      const st = w.starts.find((s) => s.scenario);
      return st ? st.scenario : null;
    } catch (e) { return null; }
  }
  const worldImages = () => {
    const out = new Set(Object.keys(cw.assets).filter((p) => p.startsWith('portraits/')));
    Object.values(pool()).forEach((c) => { if (typeof c.portrait === 'string') out.add(c.portrait); });
    return [...out].filter(E.isImagePath);
  };
  function renderCharactersTab() {
    const c = cui.sel && cw.files[`characters/${cui.sel}.json`];
    const main = cui.review ? reviewPanel() : c ? `<h3>${esc(c.name || cui.sel)} <span class="muted small">(${esc(cui.sel)})</span></h3>
        <p class="muted small">Saved as you go, whenever the sheet is complete; until then the problems show below the form. Where they start, and how they feel in one start, is on the Starts tab.</p>
        <div class="settings maker c-charform"><div id="cCharBody" class="maker-body"></div><ul id="cCharErrors" class="maker-errors fail" aria-live="polite"></ul></div>`
      : '<p class="muted">Pick someone, add a character, or import a character card.</p>';
    return `<div class="c-split">
      <div class="c-scroll-col">${main}</div>
      <aside class="c-panel"><section><h3>The world's people</h3><div id="cCharList" class="c-list"></div>
        <button type="button" id="cAddChar" class="small">+ Character</button>
        <label class="btn small" title="A SillyTavern/Tavern card: PNG or JSON">Import a card<input type="file" id="cCardFile" accept=".png,.json,image/png,application/json" hidden></label></section>
        ${c && !cui.review ? `<section><label>Id <input value="${esc(cui.sel)}" data-idof="character" data-old="${esc(cui.sel)}"></label>
          <div class="muted small">Starts, feelings, keys, timeline events and lore that name them follow a rename.</div>
          <div class="small">${(() => { const s = WE.startsWith(cw.files, cui.sel); return s.length ? `In ${s.map((id) => esc((starts()[id] || {}).title || id)).join(', ')}.` : '<span class="muted">Not in any start yet: add them on the Starts tab.</span>'; })()}</div>
          <div id="cCharProblems"></div>
          <button type="button" id="cDelChar" class="small danger">${cui.confirm ? 'Click again to take them out of the world' : 'Delete character'}</button></section>` : ''}</aside></div>`;
  }
  function renderCharList() {
    const el = $('cCharList');
    if (!el) return;
    el.innerHTML = Object.entries(pool()).map(([id, c]) => `<button type="button" data-csel="${esc(id)}" aria-pressed="${id === cui.sel && !cui.review}">${esc(c.name || id)} <span class="muted small">${esc(c.role || '')}${WE.startsWith(cw.files, id).length ? '' : ' · in no start'}</span></button>`).join('') || '<span class="muted">Nobody yet.</span>';
  }
  // The form lives in the tab's HTML, so it is mounted again after each redraw.
  function mountCharForm() {
    const body = $('cCharBody');
    if (!body) return;
    const sc = cui.sc || (cui.sc = CM.authorScenario(world(), baseScenario(), pool(), cui.review ? null : cui.sel));
    if (!cui.form) cui.form = CM.authorForm(sc, cui.review ? cui.review.character : cw.files[`characters/${cui.sel}.json`]);
    const cf = E.CharForm.create(body, $('cCharErrors'));
    cf.open({
      sc, form: cui.form, author: true, assetUrl, images: worldImages(),
      onPortraitFile: async (file) => {
        const path = WE.portraitPath(cw.files, cw.assets, file.name, cui.review ? cui.review.character.name : cui.sel);
        cw.assets[path] = file;
        return path;
      },
      onChange: (form) => {
        if (cui.review) return;
        const path = `characters/${cui.sel}.json`;
        const out = CM.buildAuthor(sc, form, cw.files[path]);
        cf.setErrors(out.errors || []);
        if (out.character) { cw.files[path] = out.character; changed(['charlist']); }
      },
    });
    cf.setErrors(cui.errors || []);
    cui.cf = cf;
  }
  function selectChar(id) {
    Object.assign(cui, { sel: id, confirm: false, sc: null, form: null, errors: [], review: null });
  }
  // ---------- card import ----------
  function reviewPanel() {
    const r = cui.review;
    const card = r.card;
    if (r.step === 'card') {
      const used = Cards.used(card);
      return `<h3>Import a character card: ${esc(card.name)} <span class="muted small">(card v${card.version})</span></h3>
        <p class="small">One call to your model (routed with World building) turns the card into a person who lives in this world. It keeps the card's personality and leaves out its own story.</p>
        <ul class="small"><li><b>Used:</b> ${['description', 'personality', 'examples'].filter((k) => used[k]).map((k) => (k === 'examples' ? 'example dialogue' : k)).join(', ') || 'only the name'}.</li>
          ${Cards.dropped(card).length ? `<li><b>Left out:</b> the card's ${Cards.dropped(card).join(', ')}.</li>` : ''}</ul>
        ${used.description ? `<details class="small"><summary>The card's description</summary><p>${esc(used.description)}</p></details>` : ''}
        <div id="cCardNote" class="small" aria-live="polite">${r.busy ? 'Converting…' : r.error ? `<span class="bad">${esc(r.error)}</span>` : ''}</div>
        <button type="button" id="cCardConvert" class="primary"${r.busy ? ' disabled' : ''}>Convert with the model</button> <button type="button" id="cCardCancel">Cancel</button>`;
    }
    return `<h3>Review: ${esc(card.name)}</h3>
      <p class="small">Read it through and change anything; nothing is added until you press <b>Add to the world</b>.</p>
      ${r.notes.length ? `<ul class="small c-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${r.image ? `<img src="${esc(r.imageUrl)}" alt="The card's image" class="portrait c-cardpic"><label class="c-check small"><input type="checkbox" id="cCardRights"${r.rights ? ' checked' : ''}> <span>Use the card's image as the portrait. I have the right to use this image.</span></label>` : ''}
      <div class="settings maker c-charform"><div id="cCharBody" class="maker-body"></div><ul id="cCharErrors" class="maker-errors fail" aria-live="polite"></ul></div>
      <button type="button" id="cCardAdd" class="primary">Add to the world</button> <button type="button" id="cCardCancel">Cancel</button>`;
  }
  async function readCard(file) {
    try {
      const { card, image } = Cards.fromFile(new Uint8Array(await file.arrayBuffer()), file.name);
      if (cui.review && cui.review.imageUrl) URL.revokeObjectURL(cui.review.imageUrl);
      cui.review = { step: 'card', card, image, imageUrl: image ? URL.createObjectURL(new Blob([image], { type: 'image/png' })) : null, notes: [], busy: false, error: '', rights: false };
      cui.form = null; cui.sc = null; cui.errors = [];
      banner('');
    } catch (err) { banner(`Couldn't import that card: ${esc(err.message)}`, 'bad'); }
    render();
  }
  async function convertCard() {
    const r = cui.review;
    const base = baseScenario();
    if (!base) { r.error = 'The world has problems (see below), so it can\'t be described to the model yet. Fix them first.'; return render(); }
    r.busy = true; r.error = '';
    render();
    try {
      const out = await Cards.convert(base, r.card);
      if (cui.review !== r) return;
      Object.assign(r, { step: 'sheet', character: out.character, notes: out.notes, busy: false });
    } catch (err) { r.busy = false; r.error = `The conversion failed: ${err.message}`; }
    cui.sc = null; cui.form = null;
    render();
  }
  function addCard() {
    const r = cui.review;
    const out = CM.buildAuthor(cui.sc, cui.form, {});
    if (out.errors) { cui.errors = out.errors; if (cui.cf) cui.cf.setErrors(out.errors); return; }
    const c = out.character;
    const taken = WE.takenIds(cw.files);
    if (taken.includes(c.id)) c.id = WE.slug(c.name, taken, 'person');
    if (r.image && r.rights) {
      const path = WE.portraitPath(cw.files, cw.assets, 'card.png', c.id);
      cw.assets[path] = new Blob([r.image], { type: 'image/png' });
      c.portrait = path;
    }
    cw.files[`characters/${c.id}.json`] = c;
    world().characters = (world().characters || []).concat(c.id);
    selectChar(c.id);
    banner(`${esc(c.name)} joined the world's people. Add them to a start on the Starts tab.`);
    changed();
  }
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'characters') return;
    const t = ev.target;
    const sel = t.closest('[data-csel]');
    if (sel) { selectChar(sel.dataset.csel); return render(); }
    if (t.id === 'cAddChar') { selectChar(WE.newPerson(cw.files, { name: 'New person' })); return changed(); }
    if (t.id === 'cCardConvert') return void convertCard();
    if (t.id === 'cCardCancel') { cui.review = null; cui.form = null; cui.sc = null; return render(); }
    if (t.id === 'cCardAdd') return addCard();
    if (t.id === 'cDelChar') {
      if (!cui.confirm) { cui.confirm = true; return render(); }
      const notes = WE.removeCharacter(cw.files, cui.sel);
      selectChar(null);
      banner(notes.length ? esc(notes.join('; ')) : '');
      return changed();
    }
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'characters') return;
    const t = ev.target;
    if (t.id === 'cCardFile' && t.files && t.files[0]) { const f = t.files[0]; t.value = ''; return void readCard(f); }
    if (t.id === 'cCardRights') { cui.review.rights = t.checked; return; }
    if (t.dataset.idof === 'character') {
      const to = t.value.trim();
      const err = WE.renameCharacter(cw.files, t.dataset.old, to);
      if (err) banner(esc(`"${to}" can't be used: ${err}.`), 'bad'); else { banner(''); selectChar(to); }
      return changed();
    }
  });

  // ---------- the portraits tab (task 6-2) ----------
  // The world's stand-ins (portraitSet): people without their own portrait
  // get one, picked by their id so it never changes.
  function renderPortraitsTab() {
    const set = world().portraitSet || [];
    const people = Object.entries(pool());
    const standin = (id) => set[E.hash(id) % set.length];
    return `<div class="c-form">
      <section><h3>Stand-in portraits</h3><p class="muted small">Pictures for people who have no portrait of their own, including the ones the story makes up during play. Use your own images only (or ones you have the right to use); the game never makes portraits.</p>
        <div class="c-pics">${set.map((p, i) => { const u = assetUrl(p); return `<figure>${u ? `<img src="${esc(u)}" alt="" class="portrait">` : '<span class="muted small">not loaded</span>'}<figcaption class="small">${esc(p.split('/').pop())} <button type="button" class="small ghost" data-pdel="${i}" aria-label="Remove ${esc(p)}">✕</button></figcaption></figure>`; }).join('') || '<span class="muted">None: people without a portrait show their initials.</span>'}</div>
        <label class="btn small">Add images<input type="file" id="cPortraitAdd" accept="image/*" multiple hidden></label></section>
      <section><h3>Who gets which</h3><ul class="small">${people.map(([id, c]) => `<li>${esc(c.name || id)}: ${typeof c.portrait === 'string' ? `their own (${esc(c.portrait.split('/').pop())})` : c.portrait === false || !set.length ? 'initials' : `stand-in ${esc(standin(id).split('/').pop())}`}</li>`).join('')}</ul></section>
    </div>`;
  }
  $('cMain').addEventListener('click', (ev) => {
    if (!cw || ui.tab !== 'portraits') return;
    const d = ev.target.closest('[data-pdel]');
    if (!d) return;
    const w = world();
    w.portraitSet.splice(Number(d.dataset.pdel), 1);
    if (!w.portraitSet.length) delete w.portraitSet;
    changed();
  });
  $('cMain').addEventListener('change', (ev) => {
    if (!cw || ui.tab !== 'portraits' || ev.target.id !== 'cPortraitAdd') return;
    const w = world();
    [...ev.target.files].forEach((file) => {
      const path = WE.portraitPath(cw.files, cw.assets, file.name);
      cw.assets[path] = file;
      w.portraitSet = (w.portraitSet || []).concat(path);
    });
    changed();
  });

  // ---------- the sites tab (task 6-3) ----------
  // Site maps: rooms drawn on a battlemap or floor plan, doors on the edges
  // they share, entrances, spots, tags. A map is a draft until it is saved to
  // the world (world.sites); the game then uses it when a story goes to a
  // place of its type. Logic in js/siteedit.js; drawing in play is
  // SiteDraw.renderImage, used here for the preview.
  const SE = E.SiteEdit;
  const SITE_HINTS = {
    select: 'Click a room to edit it. Drag a corner to move it, Alt-click a corner to remove it, double-click an edge to add one. Drag empty space to pan; scroll to zoom.',
    draw: 'Click to add corners (they snap to the grid when it is on). Click the first corner or press Enter to finish; Backspace removes the last corner; Esc cancels.',
    door: 'Click on the line between two rooms to put a door there (the kind picked above).',
    entrance: 'Click on a room\'s outer wall to mark a way in from outside.',
    spot: 'Click inside a room to mark a spot (the kind picked above).',
  };
  const curSite = () => (xui.sel && cw.files[SE.path(xui.sel)]) || null;
  function renderSitesTab() {
    const list = SE.maps(cw.files);
    if (xui.sel && !cw.files[SE.path(xui.sel)]) xui.sel = null;
    const m = curSite();
    const shared = Object.values(S.library.maps || {});
    return `<div class="c-map">
      <div class="c-canvas-col">${m ? `${siteToolbar(m)}<div id="cSiteCanvas" class="c-canvas"></div><div class="c-hint">${esc(m.image ? (xui.preview ? 'The map as the game draws it, everything in view, with sample people.' : SITE_HINTS[xui.mode]) : 'No image: the game lays the rooms out from their links (shown here). Load a battlemap or floor plan to draw the rooms on it.')}</div>`
        : '<p class="muted c-intro">Site maps are places a story can go: a battlemap or floor plan with its rooms drawn on it, its doors and ways in, and tags. When the story heads somewhere new, the game uses a map whose type or tags fit before making one up. Make one, copy a shared one, or keep a place the game made during play.</p>'}</div>
      <aside class="c-panel">
        <section><h3>Site maps</h3><div class="c-list" id="cSiteList">${siteListHtml(list)}</div>
          <button type="button" id="cNewSite" class="small">+ Site map</button>
          ${shared.length ? `<select id="cSiteCopy" aria-label="Copy a shared map"><option value="">Copy a shared map…</option>${shared.map((x) => `<option value="${esc(x.id)}">${esc(x.name || x.id)} (${esc(x.type)}${(x.setting || []).length ? `, ${esc(x.setting.join(', '))}` : ''})</option>`).join('')}</select>` : ''}
          <label class="btn small" title="Keep a place the game made during play">From a save…<input type="file" id="cSiteSave" accept=".json,application/json" hidden></label>
          ${xui.save ? `<div class="c-kvrow"><select id="cSiteKeepSel" aria-label="A place from the save">${xui.save.sites.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} (${x.rooms} rooms)</option>`).join('')}</select><button type="button" id="cSiteKeep" class="small">Keep as a site map</button></div>` : ''}</section>
        ${m ? siteForm(m) : ''}
        <section class="c-test"><h3>Test the matching</h3>
          <label>A place the story heads to <input data-xm="kind" value="${esc(xui.match.kind)}" placeholder="the old tavern by the river"></label>
          <label>The world's setting <span class="muted small">(for shared maps)</span><input data-xm="setting" value="${esc(xui.match.setting)}" placeholder="${esc(((world().generatedSites || {}).library || ['modern']).join(', '))}"></label>
          <div id="cSiteMatch" aria-live="polite"></div></section>
      </aside></div>`;
  }
  function siteToolbar(m) {
    const F = SE.path(xui.sel);
    return `<div class="c-toolbar" role="toolbar" aria-label="Site map tools">
      ${['select', 'draw', 'door', 'entrance', 'spot'].map((k) => `<button type="button" data-xmode="${k}" aria-pressed="${!xui.preview && xui.mode === k}"${m.image ? '' : ' disabled'}>${({ select: 'Select', draw: 'Draw room', door: 'Door', entrance: 'Way in', spot: 'Spot' })[k]}</button>`).join('')}
      <select id="cDoorKind" aria-label="Kind of door">${E.Sites.KINDS.map((k) => `<option${k === xui.doorKind ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <select id="cSpotKind" aria-label="Kind of spot">${E.Sites.SPOTS.map((k) => `<option${k === xui.spotKind ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <span class="sep"></span>
      <label class="btn">${m.image ? 'Change image' : 'Load image'}<input type="file" id="cSiteImage" accept="image/*" hidden></label>
      <span class="c-grid-fields">${fld(F, 'grid.square', 'int', 'Grid', { min: 1, placeholder: 'px', aria: 'Grid square in pixels', live: 'sitecanvas' })}${fld(F, 'grid.unit', 'text', null, { placeholder: '5 ft', aria: 'What a square measures' })}</span>
      <label class="c-check small"><input type="checkbox" id="cSnap"${xui.snap ? ' checked' : ''}> snap</label>
      <button type="button" id="cSitePreview" aria-pressed="${xui.preview}">Preview</button>
      <span class="zoom"><button type="button" data-xzoom="in" aria-label="Zoom in">+</button><button type="button" data-xzoom="out" aria-label="Zoom out">−</button><button type="button" data-xzoom="reset" aria-label="Reset the view">⟲</button></span>
    </div>`;
  }
  function siteForm(m) {
    const id = xui.sel, F = SE.path(id);
    const listed = (world().sites || []).includes(id);
    const rooms = idList(m.rooms);
    return `<section><h3>${esc(m.name || id)} <span class="muted small">(${esc(id)})</span></h3>
        <div class="small">${listed ? '<b class="good">In the world</b>: stories use it.' : '<b>Draft</b>: not in the world yet.'}</div>
        <div id="cSiteProblems"></div>
        ${listed ? '<button type="button" id="cSiteOut" class="small">Take out of the world</button>' : '<button type="button" id="cSiteSaveWorld" class="small primary">Save to the world</button>'}
        <button type="button" id="cSiteExport" class="small" title="A folder for the shared library: open it with Open folder in the game, or add it to library/">Export for the library</button>
        <button type="button" id="cSiteDel" class="small danger">${xui.confirm ? 'Click again to delete' : 'Delete'}</button>
        ${fld(F, 'name', 'text', 'Name', { live: 'sitelist', max: 60 })}
        ${fld(F, 'type', 'text', 'Type', { hint: 'what kind of place: tavern, warehouse, farmhouse', live: 'sitelist' })}
        ${fld(F, 'tags', 'csv', 'Tags', { hint: 'other words a story might use for it' })}
        ${fld(F, 'setting', 'csv', 'Setting', { hint: 'for the shared library: modern, cyberpunk, fantasy…' })}
        ${rooms.length ? fld(F, 'entry', 'text', 'The way in', { options: rooms, blank: 'pick a room' }) : ''}
        <div class="c-row2">${fld(F, 'credit', 'text', 'Credit')}${fld(F, 'license', 'text', 'License', { placeholder: 'CC0-1.0' })}</div>
        <p class="muted small">Share only maps you made or have the right to share; many battlemaps sold online don't allow it.</p></section>
      <section><h3>Rooms</h3><div class="c-list">${(m.rooms || []).map((r) => `<button type="button" data-xroom="${esc(r.id)}" aria-pressed="${r.id === xui.room}">${esc(r.name || r.id)}${m.image && !r.shape ? ' <span class="muted small">(not drawn)</span>' : ''}</button>`).join('') || '<span class="muted">No rooms yet.</span>'}</div>
        <button type="button" id="cSiteAddRoom" class="small">+ Room${m.image ? ' (draw it after)' : ''}</button></section>
      ${roomFormSite(m)}`;
  }
  function roomFormSite(m) {
    const j = (m.rooms || []).findIndex((r) => r.id === xui.room);
    if (j < 0) return '';
    const r = m.rooms[j], F = SE.path(xui.sel), p = `rooms.${j}`;
    const others = (m.rooms || []).filter((o) => o.id !== r.id);
    const name = (id) => ((m.rooms || []).find((o) => o.id === id) || { name: id }).name;
    const links = SE.links(m).filter((k) => k.a === r.id || k.b === r.id);
    const auto = E.Sites.roomSize(r.shape, m.grid);
    return `<section><h3>${esc(r.name || r.id)}</h3>
      ${fld(F, `${p}.name`, 'text', 'Name', { max: 40, live: 'sitecanvas' })}
      ${fld(F, `${p}.desc`, 'text', 'Description', { rows: 2 })}
      <div class="c-row2">${fld(F, `${p}.size`, 'text', 'Size', { blank: auto ? `${auto} (from the grid)` : 'medium', options: ['small', 'medium', 'large'].map((x) => ({ id: x, name: x })) })}${fld(F, `${p}.level`, 'int', 'Level', { min: -3, maxv: 5, placeholder: '0' })}</div>
      ${E.Sites.dims(r.shape, m.grid) ? `<div class="muted small">The narrator hears it is ${esc(E.Sites.dims(r.shape, m.grid))}.</div>` : ''}
      ${fld(F, `${p}.features`, 'features', 'Features', { hint: 'what exists in play; "camera=on" for one the story tracks' })}
      <div class="c-checks">${fld(F, `${p}.outside`, 'bool', 'Outside')}${fld(F, `${p}.secure`, 'bool', 'Secure (one way in)')}</div>
      <div class="small">Ways through</div>
      ${links.map((k) => { const o = k.a === r.id ? k.b : k.a; const key = `${k.a}|${k.b}`; return `<div class="c-conn"><span>${esc(name(o))}</span><select data-xlinkkind="${esc(key)}" aria-label="Kind of way to ${esc(name(o))}">${E.Sites.KINDS.map((x) => `<option${x === k.kind ? ' selected' : ''}>${x}</option>`).join('')}</select><button type="button" class="small ghost" data-xlinkdel="${esc(key)}" aria-label="Remove the way to ${esc(name(o))}">✕</button></div>`; }).join('')}
      ${others.length ? `<select data-xlinkadd="${esc(r.id)}" aria-label="Join to"><option value="">Join to…</option>${options(others.filter((o) => !SE.link(m, r.id, o.id)).map((o) => ({ id: o.id, name: o.name || o.id })))}</select>` : ''}
      ${(m.entrances || []).map((e, k) => (e.room === r.id ? `<div class="c-kvrow"><span class="small">Way in:</span>${fld(F, `entrances.${k}.kind`, 'text', null, { aria: 'Kind of way in', placeholder: 'back door' })}${fld(F, `entrances.${k}.watched`, 'bool', 'watched')}${delBtn(F, 'entrances', k, 'way in')}</div>` : '')).join('')}
      ${(m.spots || []).map((s, k) => (s.room === r.id ? `<div class="c-kvrow"><span class="small">Spot:</span>${fld(F, `spots.${k}.kind`, 'text', null, { options: E.Sites.SPOTS.map((x) => ({ id: x, name: x })), aria: 'Kind of spot' })}${fld(F, `spots.${k}.label`, 'text', null, { placeholder: s.kind, aria: 'Label', max: 30 })}${delBtn(F, 'spots', k, 'spot')}</div>` : '')).join('')}
      <button type="button" id="cSiteDelRoom" class="small danger">${xui.roomConfirm ? 'Click again to remove' : 'Remove room'}</button></section>`;
  }
  const siteListHtml = (list) => list.map((x) => `<button type="button" data-xsel="${esc(x.id)}" aria-pressed="${x.id === xui.sel}">${esc(x.map.name || x.id)} <span class="muted small">${esc(x.map.type || '')}${x.listed ? '' : ' · draft'}</span></button>`).join('') || '<span class="muted">None yet.</span>';
  function renderSiteList() { const el = $('cSiteList'); if (el) el.innerHTML = siteListHtml(SE.maps(cw.files)); }
  function renderSiteChecks() {
    const el = $('cSiteProblems');
    const m = curSite();
    if (!el || !m) return;
    const r = SE.check(m, xui.sel);
    const strip = (x) => x.replace(/^sites\/[^:]+: /, '');
    el.innerHTML = r.problems.map((x) => `<div class="bad small">${esc(strip(x))}</div>`).join('') + r.warnings.map((x) => `<div class="muted small">⚠ ${esc(strip(x))}</div>`).join('');
  }
  function renderSiteMatch() {
    const el = $('cSiteMatch');
    if (!el || !xui.match.kind.trim()) { if (el) el.innerHTML = ''; return; }
    const setting = (xui.match.setting.trim() ? xui.match.setting : ((world().generatedSites || {}).library || []).join(',')).split(',').map((x) => x.trim()).filter(Boolean);
    const r = SE.testMatch(cw.files, xui.match.kind, setting, xui.sel);
    el.innerHTML = r.fits.length ? `<ol class="c-picks">${r.fits.map((f) => `<li>${esc(f.name)}${f.library ? ' <span class="muted small">shared</span>' : ''}${f.id === r.pick ? ' <b>← picked</b>' : ''}</li>`).join('')}</ol><div class="muted small">The pick depends on the place's id ("${esc(r.seed)}"), so the same place always gets the same map. The world's own maps come before shared ones.</div>`
      : '<div class="muted small">No map fits: the game would lay out the place itself.</div>';
  }
  const siteUrl = (m) => assetUrl(m.image);
  function renderSiteCanvas() {
    const el = $('cSiteCanvas');
    const m = curSite();
    if (!el || !m) return;
    if (!m.image || xui.preview) { el.innerHTML = sitePreview(m); return; }
    const W = m.width, H = m.height;
    const vb = xui.vb || [0, 0, W, H];
    const unit = vb[2] / 120;
    const pts = (poly) => poly.map((p) => p.join(',')).join(' ');
    const G = E.Sites.Geo;
    const out = [`<image href="${esc(siteUrl(m) || '')}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`];
    const sq = m.grid && m.grid.square;
    if (sq > 0) out.push(`<defs><pattern id="cGridPat" width="${sq}" height="${sq}" patternUnits="userSpaceOnUse"><path d="M${sq} 0H0V${sq}" class="c-grid"/></pattern></defs><rect x="0" y="0" width="${W}" height="${H}" fill="url(#cGridPat)" pointer-events="none"/>`);
    (m.rooms || []).filter((r) => Array.isArray(r.shape) && r.shape.length >= 3).forEach((r) => {
      const c = G.centroid(r.shape);
      out.push(`<g class="c-sroom${r.id === xui.room ? ' sel' : ''}" data-xroomg="${esc(r.id)}"><polygon points="${pts(r.shape)}"/><text x="${Math.round(c[0])}" y="${Math.round(c[1])}" text-anchor="middle" style="font-size:${(unit * 2.6).toFixed(1)}px">${esc(r.name || r.id)}</text></g>`);
    });
    SE.links(m).forEach((k) => {
      const at = E.Sites.doorAt(m, k.a, k.b);
      if (at) out.push(`<rect class="c-sdoor" x="${at[0] - unit}" y="${at[1] - unit}" width="${unit * 2}" height="${unit * 2}"><title>${esc(k.kind)}</title></rect>`);
    });
    (m.entrances || []).filter((e) => Array.isArray(e.at)).forEach((e) => out.push(`<circle class="c-sentr" cx="${e.at[0]}" cy="${e.at[1]}" r="${unit * 1.4}"><title>${esc(e.kind || 'way in')}</title></circle>`));
    (m.spots || []).filter((s) => Array.isArray(s.at)).forEach((s) => out.push(`<g class="c-sspot"><circle cx="${s.at[0]}" cy="${s.at[1]}" r="${unit * 1.3}"/><text x="${s.at[0]}" y="${s.at[1] + unit * 0.6}" text-anchor="middle" style="font-size:${(unit * 1.8).toFixed(1)}px">${esc(s.kind[0].toUpperCase())}</text><title>${esc(s.label || s.kind)}</title></g>`));
    const sel = (m.rooms || []).find((r) => r.id === xui.room);
    if (sel && sel.shape && xui.mode === 'select') out.push(sel.shape.map((p, i) => `<circle class="c-handle" data-xi="${i}" cx="${p[0]}" cy="${p[1]}" r="${unit}"/>`).join(''));
    if (xui.drawing.length) {
      out.push(`<polyline class="c-draw" points="${pts(xui.drawing)}" style="stroke-width:${unit / 3}"/>`);
      out.push(xui.drawing.map((p, i) => `<circle class="c-draw-pt${i === 0 ? ' first' : ''}" cx="${p[0]}" cy="${p[1]}" r="${i === 0 ? unit * 1.3 : unit * 0.8}"/>`).join(''));
    }
    el.innerHTML = `<svg id="cSiteSvg" class="c-site-svg" viewBox="${vb.join(' ')}" role="img" aria-label="Site map being edited">${out.join('')}</svg>` +
      (siteUrl(m) ? '' : `<div class="c-missing">The image <b>${esc(m.image)}</b> isn't loaded. Pick it again with <b>Change image</b> (shapes stay where they are).</div>`);
  }
  // As the game draws it: the image map (everything in view, sample people),
  // or the generated plan when there is no image.
  function sitePreview(m) {
    const rooms = {};
    (m.rooms || []).forEach((r) => (rooms[r.id] = { name: r.name || r.id, shape: r.shape, outside: !!r.outside, features: (r.features || []).map((f) => (typeof f === 'string' ? { name: f } : { name: f.name, state: f.state })) }));
    const ids = Object.keys(rooms);
    if (!ids.length) return '<p class="muted">Add a room to see the map.</p>';
    const other = ids.find((id) => id !== m.entry);
    const tokens = { [m.entry || ids[0]]: [{ kind: 'character', id: 'you', label: 'You', player: true }] };
    if (other) tokens[other] = [{ kind: 'standee', id: 'sample', label: 'a few people', count: 3 }];
    const tokenSvg = (t, cx, cy, r) => `<g class="c-tok${t.player ? ' you' : ''}"><circle cx="${cx}" cy="${cy}" r="${r}"/><text x="${cx}" y="${cy + r * 0.35}" text-anchor="middle" style="font-size:${(r * 1.1).toFixed(1)}px">${t.player ? 'You' : t.count}</text><title>${esc(t.label)}</title></g>`;
    try {
      if (m.image && ids.some((id) => rooms[id].shape)) {
        return E.SiteDraw.renderImage({ url: siteUrl(m), width: m.width, height: m.height }, rooms, { inView: ids, remembered: [], here: m.entry, seed: `preview-${xui.sel}`,
          links: SE.links(m).map((k) => ({ a: k.a, b: k.b, kind: k.kind, at: k.at })), tokens, tokenSvg });
      }
      const plan = E.Layouts.plan(m.rooms, { seed: `preview:${xui.sel}` });
      return E.SiteDraw.render(plan, rooms, { inView: ids, remembered: [], here: m.entry, seed: `preview:${xui.sel}`, links: {}, tokens, tokenSvg });
    } catch (e) { return `<div class="muted small">The map can't be drawn yet: ${esc(e.message)}</div>`; }
  }
  const siteToSvg = (ev) => {
    const svg = $('cSiteSvg');
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const mx = svg.getScreenCTM();
    const r = mx ? pt.matrixTransform(mx.inverse()) : { x: 0, y: 0 };
    return [r.x, r.y];
  };
  function finishSiteDrawing() {
    const m = curSite();
    if (!m || xui.drawing.length < 3) return;
    const sel = (m.rooms || []).find((r) => r.id === xui.room);
    if (sel && !sel.shape) sel.shape = xui.drawing.map((p) => p.map(Math.round));
    else xui.room = SE.addRoom(m, undefined, xui.drawing);
    xui.drawing = [];
    xui.mode = 'select';
    changed();
  }
  function zoomSite(f, at) {
    const m = curSite();
    const full = [0, 0, m.width, m.height];
    const [x, y, w, h] = xui.vb || full;
    const nw = Math.min(full[2] * 3, Math.max(full[2] / 12, w * f)), nh = h * (nw / w);
    const [px, py] = at || [x + w / 2, y + h / 2];
    xui.vb = [px - (px - x) * (nw / w), py - (py - y) * (nh / h), nw, nh];
    renderSiteCanvas();
  }
  let sdrag = null;
  $('cMain').addEventListener('pointerdown', (ev) => {
    if (!cw || ui.tab !== 'sites' || !ev.target.closest || !ev.target.closest('#cSiteSvg')) return;
    const m = curSite();
    const handle = ev.target.closest('.c-handle');
    sdrag = { start: [ev.clientX, ev.clientY], moved: false, vb: (xui.vb || [0, 0, m.width, m.height]).slice(), vertex: handle && !ev.altKey ? Number(handle.dataset.xi) : null };
    if (sdrag.vertex != null) { try { $('cSiteSvg').setPointerCapture(ev.pointerId); } catch (e) {} }
  });
  $('cMain').addEventListener('pointermove', (ev) => {
    if (!sdrag || !cw || ui.tab !== 'sites') return;
    const dx = ev.clientX - sdrag.start[0], dy = ev.clientY - sdrag.start[1];
    if (!sdrag.moved && Math.hypot(dx, dy) < 4) return;
    sdrag.moved = true;
    const m = curSite();
    if (sdrag.vertex != null) {
      const r = m.rooms.find((x) => x.id === xui.room);
      r.shape[sdrag.vertex] = SE.snap(siteToSvg(ev), m.grid, xui.snap);
      renderSiteCanvas();
    } else if (xui.mode === 'select') {
      const rect = $('cSiteSvg').getBoundingClientRect();
      const [x, y, w, h] = sdrag.vb;
      xui.vb = [x - dx * (w / rect.width), y - dy * (h / rect.height), w, h];
      renderSiteCanvas();
    }
  });
  $('cMain').addEventListener('pointerup', (ev) => {
    if (!sdrag || !cw || ui.tab !== 'sites') return;
    const d = sdrag;
    sdrag = null;
    const m = curSite();
    if (d.vertex != null && d.moved) return changed(['sitecanvas']);
    if (d.moved || !ev.target.closest || !ev.target.closest('#cSiteSvg')) return;
    const raw = siteToSvg(ev);
    const p = SE.snap(raw, m.grid, xui.snap);
    const unit = (xui.vb || [0, 0, m.width])[2] / 120;
    if (xui.mode === 'select') {
      const handle = ev.target.closest('.c-handle');
      if (handle && ev.altKey) {
        const r = m.rooms.find((x) => x.id === xui.room);
        r.shape = E.MapEdit.removeVertex(r.shape, Number(handle.dataset.xi));
        return changed(['sitecanvas']);
      }
      xui.room = SE.roomAt(m, raw);
      xui.roomConfirm = false;
      return render();
    }
    if (xui.mode === 'draw') {
      if (xui.drawing.length >= 3 && Math.hypot(raw[0] - xui.drawing[0][0], raw[1] - xui.drawing[0][1]) <= unit * 2) return finishSiteDrawing();
      xui.drawing.push(p);
      return renderSiteCanvas();
    }
    if (xui.mode === 'door') {
      const e = SE.edgeAt(m, raw, unit * 2.5);
      if (!e || !e.b) return banner('Click on the line between two rooms to put a door there.');
      SE.setLink(m, e.a, e.b, xui.doorKind, e.at);
      banner('');
      return changed();
    }
    if (xui.mode === 'entrance') {
      const e = SE.edgeAt(m, raw, unit * 2.5);
      if (!e || !e.room) return banner(e ? 'That line is between two rooms: use Door for it.' : 'Click on a room\'s outer wall.');
      SE.addEntrance(m, e.room, e.at);
      xui.room = e.room;
      banner('');
      return changed();
    }
    if (xui.mode === 'spot') {
      const room = SE.roomAt(m, raw);
      if (!room) return banner('Click inside a room to mark a spot there.');
      SE.addSpot(m, xui.spotKind, room, p);
      xui.room = room;
      banner('');
      return changed();
    }
  });
  $('cMain').addEventListener('dblclick', (ev) => {
    if (!cw || ui.tab !== 'sites' || xui.mode !== 'select' || !ev.target.closest || !ev.target.closest('#cSiteSvg')) return;
    const m = curSite();
    const r = (m.rooms || []).find((x) => x.id === xui.room);
    if (!r || !r.shape) return;
    const p = siteToSvg(ev);
    const e = E.MapEdit.nearestEdge(r.shape, p);
    if (e.dist > (xui.vb || [0, 0, m.width])[2] / 40) return;
    r.shape = E.MapEdit.insertVertex(r.shape, e.index, SE.snap(p, m.grid, xui.snap));
    changed(['sitecanvas']);
  });
  $('cMain').addEventListener('wheel', (ev) => {
    if (!cw || ui.tab !== 'sites' || !ev.target.closest || !ev.target.closest('#cSiteSvg')) return;
    ev.preventDefault();
    zoomSite(ev.deltaY > 0 ? 1.15 : 1 / 1.15, siteToSvg(ev));
  }, { passive: false });
  document.addEventListener('keydown', (ev) => {
    if (!cw || ui.tab !== 'sites' || xui.mode !== 'draw' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (ev.key === 'Enter') { ev.preventDefault(); finishSiteDrawing(); }
    else if (ev.key === 'Escape') { xui.drawing = []; renderSiteCanvas(); }
    else if (ev.key === 'Backspace') { ev.preventDefault(); xui.drawing.pop(); renderSiteCanvas(); }
  });
  // An image file into the working copy (fetched from a URL, or picked).
  async function copyImage(url, path) {
    try {
      const res = url && (await fetch(url));
      if (res && res.ok) { cw.assets[path] = await res.blob(); urls.delete(path); return true; }
    } catch (e) { /* reported below */ }
    return false;
  }
  $('cMain').addEventListener('click', async (ev) => {
    if (!cw || ui.tab !== 'sites') return;
    const t = ev.target;
    const m = curSite();
    const sel = t.closest('[data-xsel]');
    if (sel) { Object.assign(xui, { sel: sel.dataset.xsel, room: null, vb: null, drawing: [], confirm: false, roomConfirm: false, preview: false }); return render(); }
    if (t.id === 'cNewSite') { Object.assign(xui, { sel: SE.newMap(cw.files), room: null, vb: null, drawing: [], mode: 'select' }); return changed(); }
    if (t.id === 'cSiteKeep') {
      const sid = $('cSiteKeepSel').value;
      const id = SE.fromSave(cw.files, xui.save.state, sid);
      const map = cw.files[SE.path(id)];
      const from = xui.save.state.sites[sid].map && (xui.save.state.scenario.siteMaps || {})[xui.save.state.sites[sid].map];
      let note = '';
      if (map.image && from) {
        const ok = await copyImage(from.library ? `library/${from.image}` : assetUrl(from.image), map.image);
        if (!ok) note = ` Its image (${from.image}) isn't here: load it again with Change image.`;
      }
      Object.assign(xui, { sel: id, room: null, save: null, vb: null });
      banner(`Kept "${esc(map.name)}" as a draft site map. Add a credit and a license, check the rooms, then save it to the world.${esc(note)}`);
      return changed();
    }
    const room = t.closest('[data-xroom]');
    if (room) { xui.room = room.dataset.xroom; xui.roomConfirm = false; return render(); }
    if (!m) return;
    const mode = t.closest('[data-xmode]');
    if (mode) { Object.assign(xui, { mode: mode.dataset.xmode, drawing: [], preview: false }); return render(); }
    const z = t.closest('[data-xzoom]');
    if (z) { if (z.dataset.xzoom === 'reset') { xui.vb = null; return renderSiteCanvas(); } return zoomSite(z.dataset.xzoom === 'in' ? 1 / 1.4 : 1.4); }
    if (t.id === 'cSitePreview') { xui.preview = !xui.preview; return render(); }
    if (t.id === 'cSiteAddRoom') { xui.room = SE.addRoom(m); if (m.image) xui.mode = 'draw'; return changed(); }
    if (t.id === 'cSiteSaveWorld') {
      const r = SE.saveToWorld(cw.files, xui.sel);
      banner(r.error ? esc(r.error) : `${esc(m.name || xui.sel)} is in the world: stories heading to a ${esc(m.type)} can use it.`, r.error ? 'bad' : '');
      return changed();
    }
    if (t.id === 'cSiteOut') { SE.takeOut(cw.files, xui.sel); return changed(); }
    if (t.id === 'cSiteDel') {
      if (!xui.confirm) { xui.confirm = true; return render(); }
      if (m.image) delete cw.assets[m.image];
      SE.removeMap(cw.files, xui.sel);
      Object.assign(xui, { sel: null, room: null, confirm: false });
      return changed();
    }
    if (t.id === 'cSiteDelRoom') {
      if (!xui.roomConfirm) { xui.roomConfirm = true; return render(); }
      SE.removeRoom(m, xui.room);
      Object.assign(xui, { room: null, roomConfirm: false });
      return changed();
    }
    const ld = t.closest('[data-xlinkdel]');
    if (ld) { const [a, b] = ld.dataset.xlinkdel.split('|'); SE.removeLink(m, a, b); return changed(); }
    if (t.id === 'cSiteExport') {
      const lib = SE.libraryFiles(m);
      const dir = `${m.id}-library`;
      const entries = Object.entries(lib).map(([p, j]) => ({ name: `${dir}/${p}`, data: E.Zip.utf8(JSON.stringify(j, null, 2) + '\n') }));
      let missing = '';
      if (m.image) {
        try {
          const a = cw.assets[m.image];
          const data = a ? new Uint8Array(await a.arrayBuffer()) : new Uint8Array(await (await fetch(siteUrl(m))).arrayBuffer());
          entries.push({ name: `${dir}/${m.image}`, data });
        } catch (e) { missing = ` The image (${m.image}) wasn't loaded, so it isn't in it.`; }
      }
      download(`${dir}.zip`, new Blob([E.Zip.build(entries)], { type: 'application/zip' }));
      const p = SE.check(m, m.id).problems;
      banner(`Exported ${esc(dir)}.zip: unzip it and open the folder with Open folder in the game, or add its map to library/ (and its entry to library/index.json).${esc(missing)}${p.length ? ' It still has problems the game will refuse.' : ''}`, p.length || missing ? 'bad' : '');
    }
  });
  $('cMain').addEventListener('change', async (ev) => {
    if (!cw || ui.tab !== 'sites') return;
    const t = ev.target;
    const m = curSite();
    if (t.id === 'cSiteCopy' && t.value) {
      const src = S.library.maps[t.value];
      const id = SE.addCopy(cw.files, src);
      const map = cw.files[SE.path(id)];
      if (map.image && !(await copyImage(`library/${src.image}`, map.image))) banner(`Copied; its image (${esc(src.image)}) couldn't be fetched: load it with Change image.`, 'bad');
      Object.assign(xui, { sel: id, room: null, vb: null, mode: 'select', preview: false });
      return changed();
    }
    if (t.id === 'cSiteSave' && t.files && t.files[0]) {
      const f = t.files[0];
      t.value = '';
      try {
        const found = SE.savedSites(JSON.parse(await f.text()));
        if (!found.sites.length) { banner('That save has no places the game made during play.'); return; }
        xui.save = found;
        banner('');
      } catch (e) { banner(`That file isn't a save: ${esc(e.message)}`, 'bad'); }
      return render();
    }
    if (!m) return;
    if (t.id === 'cDoorKind') { xui.doorKind = t.value; return; }
    if (t.id === 'cSpotKind') { xui.spotKind = t.value; return; }
    if (t.id === 'cSnap') { xui.snap = t.checked; return; }
    if (t.id === 'cSiteImage' && t.files && t.files[0]) {
      const file = t.files[0];
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const path = `sites/${xui.sel}.${(file.name.split('.').pop() || 'png').toLowerCase()}`;
        if (m.image && m.image !== path) delete cw.assets[m.image];
        SE.setImage(m, path, img.naturalWidth || 800, img.naturalHeight || 600);
        cw.assets[path] = file;
        urls.set(path, url);
        xui.vb = null;
        changed();
      };
      img.onerror = () => banner(`That file couldn't be read as an image: ${esc(file.name)}`, 'bad');
      img.src = url;
      return;
    }
    if (t.dataset.xlinkkind) { const [a, b] = t.dataset.xlinkkind.split('|'); SE.setLink(m, a, b, t.value); return changed(); }
    if (t.dataset.xlinkadd && t.value) { SE.setLink(m, t.dataset.xlinkadd, t.value, 'door'); return changed(); }
  });
  $('cMain').addEventListener('input', (ev) => {
    if (!cw || ui.tab !== 'sites' || !ev.target.dataset.xm) return;
    xui.match[ev.target.dataset.xm] = ev.target.value;
    renderSiteMatch();
  });

  // ---------- test play ----------
  // The game opens in a new tab and asks for the world; the creator sends
  // the files as they are now (images as Blobs). Nothing is exported.
  const testTabs = new Map(); // window -> payload
  function testPlay(startId) {
    const win = window.open('index.html?testplay=1', '_blank');
    if (!win) return banner('The browser blocked the new tab: allow pop-ups for this page, then try again.', 'bad');
    testTabs.set(win, WE.testPlayPayload(cw.folder, cw.files, cw.assets, startId));
  }
  window.addEventListener('message', (ev) => {
    const payload = testTabs.get(ev.source);
    if (!payload || !ev.data || ev.data.type !== WE.TEST_READY) return;
    ev.source.postMessage(payload, '*');
    testTabs.delete(ev.source);
  });
  $('cMain').addEventListener('click', (ev) => {
    const b = cw && ev.target.closest('[data-testplay]');
    if (b) testPlay(b.dataset.testplay);
  });
  $('cTest').addEventListener('click', () => { if (cw) testPlay(ui.tab === 'starts' && sui.sel ? sui.sel : (world().starts || [])[0]); });

  // ---------- export ----------
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  // Every image the world uses: the map, floor plans, portraits, stand-ins,
  // site maps.
  function imagePaths() {
    const w = world();
    const out = new Set(Object.keys(cw.assets));
    if (w.map) out.add(w.map.image);
    if (w.localMap) out.add(w.localMap.image);
    (w.portraitSet || []).forEach((p) => out.add(p));
    Object.entries(cw.files).forEach(([path, j]) => {
      if (path.startsWith('characters/') && j && j.portrait) out.add(j.portrait);
      if (path.startsWith('starts/') && j && j.localMap) out.add(j.localMap.image);
      if (path.startsWith('sites/') && j && j.image) out.add(j.image);
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
      if (v.startsWith('draft:')) { const d = JSON.parse(store.get(SAVE_KEY(v.slice(6)))); return open(v.slice(6), d.files, {}, false, true); }
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
  // A zip of a world folder (the creator's own export, say).
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  $('cZip').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const z = WE.fromZip(E.Zip.read(new Uint8Array(await f.arrayBuffer())), f.name.replace(/\.zip$/i, ''));
      const assets = {};
      Object.entries(z.assets).forEach(([p, data]) => (assets[p] = new Blob([data], { type: MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream' })));
      const d = { folder: z.folder, files: z.files, assets };
      diskWorlds.set('disk:' + z.folder, d);
      addOption('disk:' + z.folder, `${(z.files['world.json'] || z.files['scenario.json'] || {}).title || z.folder} (zip)`);
      $('cWorld').value = 'disk:' + z.folder;
      open(d.folder, d.files, d.assets, false);
    } catch (err) { banner(`Couldn't open that zip: ${esc(err.message)}`, 'bad'); }
  });
  function addOption(value, label) {
    let o = Array.from($('cWorld').options).find((x) => x.value === value);
    if (!o) { o = document.createElement('option'); o.value = value; $('cWorld').appendChild(o); }
    o.textContent = label;
  }
  const folders = () => Array.from($('cWorld').options).map((o) => o.value.replace(/^\w+:/, '')).filter(Boolean);

  // New world (task 6-1): a blank world that loads as it is, kept in this
  // browser as a draft until it is exported.
  // Areas of the shared base map to start a world on (task 4-5): [west,
  // south, east, north] in degrees.
  const AREAS = [
    ['The whole world', [-180, -90, 180, 90]], ['Europe', [-25, 34, 45, 72]], ['Western Europe', [-11, 35, 30, 60]],
    ['The Mediterranean and the Middle East', [-10, 25, 60, 48]], ['East Asia', [95, 15, 150, 50]], ['Japan', [128, 30, 146, 46]],
    ['South Asia', [60, 5, 100, 38]], ['Africa', [-20, -36, 55, 38]], ['North America', [-170, 10, -50, 75]], ['South America', [-90, -57, -30, 15]],
  ];
  $('cNew').addEventListener('click', () => {
    const bases = Object.values(S.library.baseMaps || {});
    banner(`<label>Title of the new world <input id="cNewTitle" maxlength="80" placeholder="The Lighthouse"></label>
      <label>Start from <select id="cNewTemplate"><option value="">a blank world</option>${Object.entries(WE.TEMPLATES).map(([k, t]) => `<option value="${esc(k)}">${esc(t.label)}</option>`).join('')}</select></label>
      ${bases.length ? `<label>Map <select id="cNewBase"><option value="">none (draw your own, or no map)</option>${bases.map((b) => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join('')}</select></label>
      <label>Area <select id="cNewArea">${AREAS.map(([name], k) => `<option value="${k}">${esc(name)}</option>`).join('')}</select></label>
      <label>or bounds <input id="cNewBounds" placeholder="W,S,E,N in degrees" size="18"></label>` : ''}
      <button type="button" id="cNewGo" class="small">Create</button>`);
    const i = $('cNewTitle');
    i.focus();
    i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') newWorld(i.value); });
  });
  // A piece of a base map as a world's picture: cut in the browser from the
  // shared image (sharper: npm run basemap -- crop). → { blob, width, height }
  async function cropBase(base, bounds, width) {
    const img = await new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => fail(new Error(`the base map's picture (${base.dir}${base.image}) couldn't be loaded`)); im.src = base.dir + base.image; });
    const W = img.naturalWidth, H = img.naturalHeight;
    const [w, s, e, n] = base.bounds;
    const sx = ((bounds[0] - w) / (e - w)) * W, sw = ((bounds[2] - bounds[0]) / (e - w)) * W;
    const sy = ((n - bounds[3]) / (n - s)) * H, sh = ((bounds[3] - bounds[1]) / (n - s)) * H;
    const outW = width || Math.min(4096, Math.max(1200, Math.round(sw * 2)));
    const outH = Math.round(outW * (sh / sw));
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.88));
    return { blob, width: outW, height: outH };
  }
  async function newWorld(title) {
    // A template (R-4) shapes the regions, labels and route kinds; blank otherwise.
    const kind = $('cNewTemplate') ? $('cNewTemplate').value : '';
    const b = kind ? WE.templateWorld(kind, title, folders()) : WE.blankWorld(title, folders());
    const assets = {};
    const baseId = $('cNewBase') ? $('cNewBase').value : '';
    if (baseId) {
      const base = S.library.baseMaps[baseId];
      const typed = ($('cNewBounds').value || '').split(',').map((x) => Number(x.trim()));
      const bounds = typed.length === 4 && typed.every(Number.isFinite) ? typed : AREAS[Number($('cNewArea').value) || 0][1];
      const p = E.Geo.projectionProblems({ projection: 'equirectangular', bounds });
      const [w, s, e, n] = base.bounds;
      if (p.length || bounds[0] < w || bounds[2] > e || bounds[1] < s || bounds[3] > n) return banner(esc(p[0] || 'Those bounds are outside the base map.') + ' Bounds are west,south,east,north in degrees, like -11,35,30,60.', 'bad');
      try {
        const c = await cropBase(base, bounds);
        assets['maps/base.jpg'] = c.blob;
        b.files['world.json'].map = { image: 'maps/base.jpg', width: c.width, height: c.height, projection: 'equirectangular', bounds, base: base.id, regions: {}, credit: base.credit, license: base.license };
      } catch (err) { return banner(`Couldn't use the base map: ${esc(err.message)}`, 'bad'); }
    }
    store.set(SAVE_KEY(b.folder), JSON.stringify({ files: b.files, at: Date.now(), draft: true }));
    addOption('draft:' + b.folder, `${b.files['world.json'].title} (draft)`);
    $('cWorld').value = 'draft:' + b.folder;
    ui.tab = baseId || kind ? 'map' : 'world';
    open(b.folder, b.files, assets, false, true);
    if (baseId) {
      const m = b.files['world.json'].map;
      banner(`Started on the base map, ${esc(m.bounds.join(', '))}. Add regions here, or import real countries and capitals: <code>npm run basemap -- regions &lt;world folder&gt; --within --places capitals</code> (after exporting). For a sharper picture of a small area: <code>npm run basemap -- crop &lt;world folder&gt; --bounds ${esc(m.bounds.join(','))}</code>. For more detail in one country: <code>crop &lt;world folder&gt; --region &lt;id&gt;</code> gives it its own map (or "Cut from the base map" on the region), <code>regions &lt;world folder&gt; --from states --within --places cities</code> puts its provinces under it and its cities in them.`);
    }
  }
  // A world started on a base map gets its picture cut again after a reload
  // (drafts don't keep images).
  async function recropIfMissing() {
    if (!cw || cw.server) return;
    // The world's map and any region's own (R-9).
    let cut = false;
    for (const { map: m } of M.maps(world())) {
      const base = m.base && (S.library.baseMaps || {})[m.base];
      if (!base || cw.assets[m.image]) continue;
      try {
        const c = await cropBase(base, m.bounds, m.width);
        cw.assets[m.image] = c.blob;
        urls.delete(m.image);
        cut = true;
      } catch (e) { /* the "isn't loaded" note stays */ }
    }
    if (cut) render();
  }
  // Drafts: working copies in this browser whose world isn't on the server.
  function listDrafts() {
    const taken = new Set(folders());
    store.keys().filter((k) => k && k.startsWith('ensemble.creator.')).forEach((k) => {
      const folder = k.slice('ensemble.creator.'.length);
      if (taken.has(folder)) return;
      let saved = null;
      try { saved = JSON.parse(store.get(k)); } catch (e) { return; }
      if (!saved || !saved.files || !saved.files['world.json']) return;
      addOption('draft:' + folder, `${saved.files['world.json'].title || folder} (${saved.draft ? 'draft' : 'edits kept in this browser'})`);
    });
  }
  (async () => {
    E.loadSettings(); // Suggest and card conversion use the game's model settings
    renderTabs();
    if (location.protocol !== 'file:') {
      // The shared site map library (task 6-3): worlds that ask for it, the
      // Sites tab's copies and its matching box.
      try { S.library = await S.loadLibraryServer(); } catch (e) { /* no library/ */ }
      try { (await S.listServer()).forEach((w) => addOption('server:' + w.folder, w.title || w.folder)); }
      catch (e) { /* opened without the server: folder picker only */ }
    }
    listDrafts();
  })();
})();
