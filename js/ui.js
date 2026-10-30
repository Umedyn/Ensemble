// UI wiring. All game logic lives in engine/memory/prompts.
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;

  let state = null;
  let saveId = null; // this game's entry in E.Saves; set on its first autosave
  let busy = false;
  let uiCut = null; // beat number the player wants to step in after
  let suggested = null; // suggested actions: { state, key, list } (see renderSuggestions)
  let uiShown = 1; // beats of the live scene revealed so far
  const openTurns = new Set(); // folded earlier turns the player has opened
  const openChapters = new Set(); // closed chapters the player has opened
  const openJournal = new Set(); // earlier journal chapters the player has opened
  const notes = []; // undo/reroll history for the Debug panel
  const loaded = new Map(); // worlds in the picker; see "worlds and starts"

  // ---------- storage helpers (never fatal) ----------
  const store = E.Prefs;

  // ---------- connection ----------
  async function checkConnection(showStatus) {
    const el = $('conn');
    const ids = Array.from(new Set(Object.values(E.settings.routing)));
    const parts = [];
    let ok = true, ctx = null;
    for (const id of ids) {
      try {
        const info = await E.LLM.ping(id);
        parts.push(info.model);
        if (id === 'local' && info.context) ctx = info.context;
      } catch (e) {
        ok = false;
        parts.push(`${id} offline`);
        if (showStatus) $('sStatus').textContent = `${id}: ${e.message}`;
      }
    }
    el.textContent = '● ' + parts.join(' + ');
    el.className = 'conn ' + (ok ? 'on' : 'off');
    el.title = ctx ? `Local context: ${ctx} tokens` : '';
    return { ok, context: ctx };
  }

  // ---------- worlds and starts ----------
  // loaded: E.Library id ("server:<folder>", "disk:<folder>", or "test:…" for
  // test play) -> a loaded world
  // (Scenario.prepareWorld) or { folder, title, error } when it failed to load.
  // The last pick is remembered across visits.
  const PICK_KEY = 'ensemble.pick';
  function rememberedPick() {
    try { return JSON.parse(store.get(PICK_KEY)) || {}; } catch (e) { return {}; }
  }
  function rememberPick() {
    store.set(PICK_KEY, JSON.stringify({ world: $('scenarioSelect').value, start: $('startSelect').value, who: $('whoSelect').value }));
  }

  const worldLabel = (w) => (w.error ? `${w.title} (has errors)` : w.title);
  function addScenarioOption(key, title, select) {
    const sel = $('scenarioSelect');
    let opt = Array.from(sel.options).find((o) => o.value === key);
    if (!opt) { opt = document.createElement('option'); opt.value = key; sel.appendChild(opt); }
    opt.textContent = title;
    if (select) sel.value = key;
  }

  // Fills the start select for the picked world. With one start (or none
  // usable) it stays hidden and New game plays the default. A world with
  // generated starts (task 4-2) adds "Make my own start".
  const GEN_OPTION = '__generate';
  function renderStarts(preferred, preferredWho) {
    const w = loaded.get($('scenarioSelect').value);
    const sel = $('startSelect');
    const starts = w && w.starts ? w.starts : [];
    const generate = !!(w && w.generate);
    sel.innerHTML = starts.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}${s.error ? ' (has errors)' : ''}</option>`).join('') +
      (generate ? `<option value="${GEN_OPTION}">✦ Make my own start</option>` : '');
    sel.value = starts.some((s) => s.id === preferred) || (generate && preferred === GEN_OPTION) ? preferred : (w && w.defaultStart) || (generate ? GEN_OPTION : '');
    sel.classList.toggle('hidden', sel.options.length < 2);
    renderWho(preferredWho);
  }

  // Who you play (task 4-1): a start with a playerSlot offers its own
  // character ("Play as …", when it has one) and "Make my own".
  const pickedStart = () => {
    const w = loaded.get($('scenarioSelect').value);
    return w && w.starts ? w.starts.find((s) => s.id === $('startSelect').value) : null;
  };
  function renderWho(preferred) {
    const st = pickedStart();
    const sel = $('whoSelect');
    // Its own player, anyone else in its playable cast (task 7-6), and Make my own.
    const others = (st && !st.error && st.playable) || [];
    const show = !!(st && !st.error && (st.slot || others.length));
    sel.innerHTML = !show ? '' : (st.defaultPlayer ? `<option value="default">Play as ${esc(st.defaultPlayer)}</option>` : '')
      + others.map((p) => `<option value="as:${esc(p.id)}">Play as ${esc(p.name)}, ${esc(p.role)}</option>`).join('')
      + (st.slot ? '<option value="own">Make my own</option>' : '');
    if (show) sel.value = Array.from(sel.options).some((o) => o.value === preferred) ? preferred : sel.options[0].value;
    sel.classList.toggle('hidden', !show);
    renderPickInfo();
  }
  const makingOwn = () => !$('whoSelect').classList.contains('hidden') && $('whoSelect').value === 'own';

  // Desktop line under the pickers: the world's summary and tags, then who
  // you are in the picked start, or why it won't load.
  function renderPickInfo() {
    const w = loaded.get($('scenarioSelect').value);
    if (!w) { $('pickInfo').innerHTML = ''; return; }
    if (w.error) { $('pickInfo').innerHTML = `<span class="fail">${esc(w.error)}</span>`; return; }
    const st = w.starts.find((s) => s.id === $('startSelect').value);
    const tags = (w.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const summary = st && ((makingOwn() && st.slotSummary) || st.summary);
    const start = $('startSelect').value === GEN_OPTION
      ? '<br><b>Make my own start:</b> pick where and who you are; the story engine builds the place, the people and an opening.'
      : !st ? '' : st.error
      ? `<br><span class="fail">This start can't be played: ${esc(st.error)}</span>`
      : summary ? `<br>${w.starts.length > 1 ? `<b>${esc(st.title)}:</b> ` : ''}${esc(summary)}` : '';
    $('pickInfo').innerHTML = `<b>${esc(w.title)}</b>${w.summary ? ' · ' + esc(w.summary) : ''}${tags}${start}`;
    renderPackButton();
  }

  // ---------- lore packs (task 5-7) ----------
  // Every pack found (packs/ on the server, or a picked folder), and the ones
  // ticked per world, in the order ticked (kept in the browser).
  let allPacks = [];
  const PACKS_KEY = 'ensemble.packs';
  const tickedPacks = (worldId) => { try { return (JSON.parse(store.get(PACKS_KEY)) || {})[worldId] || []; } catch (e) { return []; } };
  function setTicked(worldId, ids) {
    let all = {};
    try { all = JSON.parse(store.get(PACKS_KEY)) || {}; } catch (e) { /* start over */ }
    all[worldId] = ids;
    store.set(PACKS_KEY, JSON.stringify(all));
  }
  // The packs for a loaded world, checked: [{ pack, problems, warnings }].
  const packsFor = (w) => (w && !w.error ? E.Packs.forWorld(allPacks, w) : []);
  // The ticked packs that pass their checks, in the order ticked.
  function chosenPacks(w) {
    const ok = packsFor(w).filter((x) => !x.problems.length);
    return tickedPacks(w.id).map((id) => ok.find((x) => x.pack.id === id)).filter(Boolean).map((x) => x.pack);
  }
  function renderPackButton() {
    const w = loaded.get($('scenarioSelect').value);
    const list = packsFor(w);
    const on = w ? chosenPacks(w).length : 0;
    $('btnPacks').classList.toggle('hidden', !list.length);
    $('btnPacks').textContent = on ? `Lore packs (${on})` : 'Lore packs';
  }
  function renderPackList() {
    const w = loaded.get($('scenarioSelect').value);
    const ticked = w ? tickedPacks(w.id) : [];
    $('packList').innerHTML = packsFor(w).map(({ pack, problems }) => {
      const order = ticked.indexOf(pack.id);
      return `<li><label class="web-toggle"><input type="checkbox" data-pack="${esc(pack.id)}"${order >= 0 && !problems.length ? ' checked' : ''}${problems.length ? ' disabled' : ''}> <b>${esc(pack.title)}</b>${pack.version ? ` <span class="muted small">v${esc(pack.version)}</span>` : ''}${order >= 0 && !problems.length ? ` <span class="tag">${order + 1}</span>` : ''}</label>` +
        (pack.summary ? `<div class="small">${esc(pack.summary)}</div>` : '') +
        `<div class="muted small">${pack.entries.length} entr${pack.entries.length === 1 ? 'y' : 'ies'}${pack.timeline.length ? `, ${pack.timeline.length} event${pack.timeline.length === 1 ? '' : 's'}` : ''} · by ${esc(pack.credit)} · ${esc(pack.license)}</div>` +
        (problems.length ? `<div class="fail small">Can't be used: ${esc(problems.join('; '))}</div>` : '') + '</li>';
    }).join('') || '<li class="muted">No packs for this world.</li>';
  }
  $('btnPacks').addEventListener('click', () => { renderPackList(); $('packDialog').showModal(); });
  $('packList').addEventListener('change', (ev) => {
    const w = loaded.get($('scenarioSelect').value);
    const id = ev.target.dataset.pack;
    if (!w || !id) return;
    const now = tickedPacks(w.id).filter((x) => x !== id);
    setTicked(w.id, ev.target.checked ? now.concat(id) : now);
    renderPackList();
    renderPackButton();
  });
  // A new game's scenario with the ticked packs layered on (checked again
  // with the scenario), or as it was if that fails (the reason in an alert).
  function withPacks(world, scenario) {
    const packs = chosenPacks(world);
    if (!packs.length) return scenario;
    try { return E.Scenario.validate(E.Packs.apply(scenario, packs)); }
    catch (e) { alert(`The lore packs couldn't be added, so this game starts without them:\n\n${e.message}`); return scenario; }
  }

  // The summary line shows while picking and folds away once a game is running.
  const showPickInfo = (on) => $('pickInfo').classList.toggle('hidden', !on);
  $('scenarioSelect').addEventListener('change', () => { renderStarts(); rememberPick(); showPickInfo(true); });
  $('startSelect').addEventListener('change', () => { renderWho($('whoSelect').value); rememberPick(); showPickInfo(true); });
  $('whoSelect').addEventListener('change', () => { renderPickInfo(); rememberPick(); showPickInfo(true); });

  // Server worlds load up front so the picker can show their summaries and starts.
  async function loadServerList() {
    if (location.protocol === 'file:') {
      addScenarioOption('', '— use Open folder —', true);
      return;
    }
    let list;
    try { list = await E.Library.list('world'); }
    catch (e) { addScenarioOption('', '— no scenarios/index.json —', true); return; }
    const worlds = await Promise.all(list.map((s) => E.Library.load(s.id)
      .catch((e) => ({ folder: s.folder, title: s.title, error: e.message }))));
    allPacks = await readPacks();
    // Options appear once every world is loaded, in index.json order.
    worlds.forEach((w, i) => { loaded.set(list[i].id, w); addScenarioOption(list[i].id, worldLabel(w)); });
    const pick = rememberedPick();
    if (pick.world && loaded.has(pick.world)) $('scenarioSelect').value = pick.world;
    renderStarts(pick.world === $('scenarioSelect').value ? pick.start : null, pick.who);
  }

  // Every lore pack in the library; a pack opened later replaces one of its id.
  async function readPacks() {
    const packs = await Promise.all((await E.Library.list('pack')).map((p) => E.Library.load(p.id)));
    return packs.filter((p, i) => !packs.slice(i + 1).some((q) => q.id === p.id));
  }

  // The picked world, loaded again so a server's edited files show up without
  // a reload. Throws a world's load error.
  async function resolveWorld(key) {
    const item = loaded.get(key);
    if (!item) throw new Error('Pick a world first (or use Open folder).');
    if (item.error) throw new Error(item.error);
    const world = key.startsWith('test:') ? item : await E.Library.load(key);
    if (world.warnings.length) console.warn(`World "${world.title}":\n` + world.warnings.join('\n'));
    return world;
  }

  $('folderInput').addEventListener('change', async (ev) => {
    if (!ev.target.files.length) return;
    // A site map library (task 6-3) instead of a world: its maps join the
    // shared ones; worlds that ask for them get them at New game.
    const lib = await E.Scenario.readLibraryFiles(ev.target.files);
    if (lib) {
      E.Scenario.library = { maps: Object.assign({}, E.Scenario.library.maps, lib.maps), assets: {}, errors: lib.errors };
      libraryAssets = Object.assign({}, libraryAssets, lib.assets);
      E.Library.open('library', 'opened', 'Opened maps', lib);
      alert(`Added ${Object.keys(lib.maps).length} site map${Object.keys(lib.maps).length === 1 ? '' : 's'} to the library.${lib.errors.length ? `\n\nSkipped:\n${lib.errors.join('\n')}` : ''}`);
      ev.target.value = '';
      return;
    }
    // Lore packs in the folder (task 5-7) join the ones found; a folder of
    // packs alone is fine.
    const found = await E.Packs.readFolderFiles(ev.target.files);
    if (found.length) {
      found.forEach((p) => E.Library.open('pack', p.folder, p.title, p));
      allPacks = await readPacks();
      renderPackButton();
      if (!Array.from(ev.target.files).some((f) => /(^|\/)(world|scenario)\.json$/.test(f.webkitRelativePath || f.name))) {
        alert(`Found ${found.length} lore pack${found.length === 1 ? '' : 's'}: ${found.map((p) => p.title).join(', ')}. Pick their world, then Lore packs to turn them on.`);
        ev.target.value = '';
        return;
      }
    }
    try {
      const { worlds, errors } = await E.Scenario.loadFromFiles(ev.target.files);
      worlds.forEach((w, i) => { const id = E.Library.open('world', w.folder, w.title, w); loaded.set(id, w); diskAssets.set(w.folder, w.assets || {}); addScenarioOption(id, w.title + ' (disk)', i === 0); });
      renderStarts();
      rememberPick();
      if (errors.length) alert('Some worlds were skipped:\n\n' + errors.join('\n\n'));
    } catch (e) {
      alert(e.message);
    }
    ev.target.value = '';
  });

  // ---------- game lifecycle ----------
  $('btnNew').addEventListener('click', async () => {
    if (busy) return;
    if (state && state.turn > 0 && !confirm('Start a new game? Unsaved progress will be lost.')) return;
    // Busy while the world loads, so Act can't fire into the old (or no) game.
    setBusy(true);
    let world = null;
    const startId = $('startSelect').value || undefined;
    try {
      world = await resolveWorld($('scenarioSelect').value);
      // Someone else of the start's cast (task 7-6): "as:<id>".
      const as = !$('whoSelect').classList.contains('hidden') && /^as:/.test($('whoSelect').value) ? $('whoSelect').value.slice(3) : undefined;
      if (startId === GEN_OPTION) { /* the generator below */ } else if (!makingOwn()) beginGame(world, E.Scenario.startScenario(world, startId, as));
    } catch (e) {
      world = null;
      alert(e.message);
    } finally {
      setBusy(false);
    }
    // Make my own (task 4-1): the game starts from the character form.
    if (world && startId === GEN_OPTION) return openGenerator(world);
    if (world && makingOwn()) return openMaker(world, startId || world.defaultStart);
    if (state) renderAll();
    $('actionInput').focus();
  });

  // A fresh game from a scenario, with the page reset for it.
  function beginGame(world, scenario) {
    // Lore packs (task 5-7): every new game goes through here.
    scenario = withPacks(world, scenario);
    state = E.Engine.newGame(scenario);
    saveId = null;
    restoreView();
    rememberPick();
    showPickInfo(false);
    uiCut = null;
    uiShown = 1;
    openTurns.clear();
    E.LLM.calls.length = 0;
    E.Engine.telemetry.length = 0;
    stopRecording();
    notes.length = 0;
    if (world.warnings.length) notes.push({ kind: 'world', summary: `${world.warnings.length} unknown field${world.warnings.length === 1 ? '' : 's'} ignored in "${world.title}"`, detail: world.warnings.join('\n') });
    if ((scenario.packs || []).length) notes.push({ kind: 'packs', summary: `lore packs: ${scenario.packs.map((p) => p.title).join(', ')}`, detail: scenario.packs.map((p) => `${p.title}${p.version ? ` v${p.version}` : ''} (${p.id})${p.credit ? `, by ${p.credit}` : ''}`).join('\n') });
    if (scenario.madePlayer) notes.push({ kind: 'character', summary: `you made ${state.characters[state.player].name}`, detail: JSON.stringify(E.CharMaker.toFile(state.characters[state.player]), null, 1) });
    autosave();
  }

  // ---------- character creator (task 4-1) ----------
  // The form for a start's playerSlot. E.CharMaker decides what's allowed and
  // builds the character.
  // The form itself is js/charform.js (shared with the creator, task 6-2).
  const DRAFT_KEY = 'ensemble.makerDraft';
  const CM = E.CharMaker;
  const charForm = E.CharForm.create($('makerBody'), $('makerErrors'));
  let makerOpts = null; // { key, onDone } while the form is open
  // A start's slot: Start game begins that start with the character.
  function openMaker(world, startId) {
    const st = world.starts.find((s) => s.id === startId);
    openCharacterForm({
      sc: st.scenario, key: `${world.folder}/${startId}`, title: `Make your character: ${st.title}`, done: 'Start game',
      onDone: (c) => {
        let scenario;
        try { scenario = E.Scenario.startScenario(world, startId, c); } catch (e) { return [e.message]; }
        $('makerDialog').close();
        beginGame(world, scenario);
        renderAll();
        $('actionInput').focus();
        return null;
      },
    });
  }
  // opts: { sc (with a playerSlot), key (for the draft), title, done (the
  // button's label), onDone(character) → null, or a list of errors to show }.
  function openCharacterForm(opts) {
    const form = CM.defaults(opts.sc);
    try {
      const d = JSON.parse(store.get(DRAFT_KEY));
      if (d && d.key === opts.key && d.form) Object.assign(form, d.form, { feelings: Object.assign(form.feelings, d.form.feelings) });
    } catch (e) { /* no draft */ }
    makerOpts = opts;
    $('makerTitle').textContent = opts.title;
    $('mkStart').textContent = opts.done;
    charForm.open({ sc: opts.sc, form, assetUrl: (p) => assetUrl(opts.sc.folder, p), onChange: saveDraft });
    $('makerDialog').showModal();
  }
  // The draft is kept in this browser, so closing the form loses nothing.
  const saveDraft = () => { if (charForm.state && makerOpts) store.set(DRAFT_KEY, JSON.stringify({ key: makerOpts.key, form: charForm.state.form })); };
  $('makerForm').addEventListener('submit', (ev) => ev.preventDefault());
  $('mkClose').addEventListener('click', () => $('makerDialog').close());
  $('makerDialog').addEventListener('close', () => { charForm.close(); makerOpts = null; });
  $('mkSave').addEventListener('click', () => {
    const m = charForm.state;
    if (!m) return;
    const out = CM.build(m.sc, m.form);
    charForm.setErrors(out.errors || []);
    if (out.character) download(`${out.character.id}.json`, CM.toFile(out.character));
  });
  $('mkLoad').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    const m = charForm.state;
    if (!file || !m) return;
    try {
      m.form = CM.formFrom(m.sc, JSON.parse(await file.text()));
      m.offers = {};
      m.errors = [];
      saveDraft();
    } catch (e) {
      m.errors = [`That file isn't a character: ${e.message}`];
    }
    charForm.render();
  });
  $('mkStart').addEventListener('click', () => {
    const m = charForm.state;
    if (!m) return;
    const out = CM.build(m.sc, m.form);
    const errors = out.errors || makerOpts.onDone(out.character);
    if (errors && charForm.state) charForm.setErrors(errors);
  });

  // ---------- generated starts (task 4-2) ----------
  // E.StartGen runs and checks the steps; this draws the setup (region,
  // character, note), the progress list and the result. The job is kept in
  // this browser after every step, so a closed tab resumes where it stopped.
  // gen: { world, key, job, mode, region, character, line, note, running, progress, error }
  let gen = null;
  const GEN = E.StartGen;
  const JOB_KEY = 'ensemble.genJob';
  function savedJob(key) {
    try { const d = JSON.parse(store.get(JOB_KEY)); return d && d.key === key ? d.job : null; } catch (e) { return null; }
  }
  const saveJob = (job) => { if (gen) store.set(JOB_KEY, JSON.stringify({ key: gen.key, job })); };
  const dropJob = () => store.set(JOB_KEY, '');

  function openGenerator(world) {
    const key = `${world.folder}/${world.id}`;
    if (!gen || gen.key !== key) {
      const regions = GEN.regions(world.bundle.world);
      gen = { world, key, job: null, mode: 'form', region: regions.length ? regions[0].id : null, character: null, line: '', note: '', running: false, progress: null, error: '' };
    }
    gen.world = world;
    renderGen();
    $('genDialog').showModal();
  }

  // ---------- where to start (R-7) ----------
  // A few places to start (12 or fewer): the plain list, as before. A big
  // world: search by name, a tree, the zooming map, and Surprise me.
  // Only startable regions can be picked; hidden ones never show.
  const GEN_LIST_MAX = 12;
  const regionChainText = (w, id) => S().regionChainIn(w.regions, id).slice(1).map((x) => (w.regions.find((r) => r.id === x) || {}).name).filter(Boolean).join(' › ');
  const S = () => E.Scenario;
  function genWhereHtml(w, regions) {
    const all = (w.regions || []).filter((r) => r && r.id);
    if (regions.length <= GEN_LIST_MAX) {
      return `<fieldset class="mk-choices"><legend>Where</legend>${regions.map((r) => `<label class="mk-option"><input type="radio" name="gen-region" value="${esc(r.id)}"${gen.region === r.id ? ' checked' : ''}> <span><b>${esc(r.name)}</b>${r.lore ? ` <span class="muted">${esc(r.lore)}</span>` : ''}</span></label>`).join('')}</fieldset>`;
    }
    const ok = new Set(regions.map((r) => r.id));
    const hidden = new Set(all.filter((r) => S().regionChainIn(all, r.id).some((x) => (all.find((y) => y.id === x) || {}).known === false)).map((r) => r.id));
    const chosen = all.find((r) => r.id === gen.region);
    const view = gen.whereView || 'tree';
    let html = `<fieldset class="mk-choices gen-where"><legend>Where</legend>
      <div class="gen-chosen" id="genChosen">${chosen ? `Starting in <b>${esc(chosen.name)}</b>${regionChainText(w, chosen.id) ? ` <span class="muted">in ${esc(regionChainText(w, chosen.id))}</span>` : ''}` : 'Pick where to start.'} <button type="button" id="genSurprise" class="small">🎲 Surprise me</button></div>
      <input type="search" id="genSearch" placeholder="Search places by name" aria-label="Search places by name" value="${esc(gen.search || '')}">
      <div id="genResults" class="gen-results">${genResultsHtml(w, regions)}</div>
      <div class="gen-views" role="group" aria-label="Browse places"><button type="button" class="small" data-genview="tree" aria-pressed="${view === 'tree'}">List</button><button type="button" class="small" data-genview="map" aria-pressed="${view === 'map'}">Map</button></div>`;
    if (view === 'map') html += genMapHtml(w, ok, hidden);
    else {
      const branch = (parent, depth) => S().regionChildrenIn(all, parent).filter((id) => !hidden.has(id)).map((id) => {
        const r = all.find((x) => x.id === id);
        const kids = S().regionChildrenIn(all, id).filter((x) => !hidden.has(x));
        const row = ok.has(id) ? `<button type="button" class="gen-pick" data-genpick="${esc(id)}" aria-pressed="${gen.region === id}">${esc(r.name)}</button>` : `<span class="muted gen-closed" title="Not a place to start">${esc(r.name)}</span>`;
        const open = depth === 0 || (chosen && S().regionChainIn(all, chosen.id).includes(id));
        return kids.length ? `<li><details${open ? ' open' : ''}><summary>${row}</summary><ul>${branch(id, depth + 1)}</ul></details></li>` : `<li>${row}</li>`;
      }).join('');
      html += `<ul class="gen-tree" id="genTree">${branch(null, 0)}</ul>`;
    }
    // Where exactly (R-7): the place the rooms are made as, inside the region picked.
    html += `<label>Where exactly <span class="muted small">(optional; inside the place picked above)</span><input type="text" id="genPlace" maxlength="60" value="${esc(gen.place || '')}" placeholder="a moisture farm outside the city"></label>`;
    return html + '</fieldset>';
  }
  function genResultsHtml(w, regions) {
    const q = String(gen.search || '').trim().toLowerCase();
    if (!q) return '';
    const hits = regions.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 12);
    return hits.length ? hits.map((r) => `<button type="button" class="gen-pick" data-genpick="${esc(r.id)}" aria-pressed="${gen.region === r.id}">${esc(r.name)}${regionChainText(w, r.id) ? ` <span class="muted">in ${esc(regionChainText(w, r.id))}</span>` : ''}</button>`).join('') : '<span class="muted small">No place to start by that name.</span>';
  }
  // The game's zooming map, inside the dialog: click a region with regions
  // inside to zoom, a startable one to pick it.
  function genMapHtml(w, ok, hidden) {
    const sc = { regions: w.regions, map: w.map, worldId: gen.world.id };
    const lv = E.MapDraw.level(sc, gen.mapLevel || null, { hidden });
    const path = E.MapDraw.levelPath(sc, lv.id);
    const crumbs = path.map((id, i) => `${i ? '<span class="sep" aria-hidden="true">›</span>' : ''}<button type="button" data-genlevel="${esc(id == null ? '' : id)}"${i === path.length - 1 ? ' aria-current="true"' : ''}>${esc(id == null ? gen.world.title : (w.regions.find((r) => r.id === id) || {}).name)}</button>`).join('');
    const svg = E.MapDraw.worldSvg({
      g: lv.g, regions: lv.regions, factions: w.factions || [], selected: gen.region, dim: lv.dim.concat(lv.regions.map((r) => r.id).filter((id) => !ok.has(id) && !E.MapDraw.hasLevel(sc, id, hidden))),
      zoomable: lv.children.filter((id) => E.MapDraw.hasLevel(sc, id, hidden)), places: [], imageUrl: lv.picture && assetUrl(gen.world.folder, lv.picture.image),
      viewBox: lv.viewBox, id: 'genMapSvg', view: lv.id == null ? 'root' : lv.id, label: 'Where to start',
    });
    return `<div class="map-bar"><nav class="map-crumbs" aria-label="Map levels">${crumbs}</nav></div><div id="genMap">${svg}</div>`;
  }
  function genPick(id) {
    gen.region = id;
    renderGen();
  }

  function renderGen() {
    if (!gen) return;
    const w = gen.world.bundle.world;
    const saved = !gen.job && savedJob(gen.key);
    let html = '';
    if (!gen.job) {
      if (saved) {
        const n = GEN.order(saved).filter((id) => saved.steps[id]).length;
        html += `<div class="gen-resume"><b>${GEN.done(saved) ? 'You have a finished start you haven\'t played.' : `You have an unfinished start (${n} of ${GEN.order(saved).length} steps done).`}</b> <button type="button" id="genResume" class="primary small">${GEN.done(saved) ? 'Open it' : 'Resume'}</button> <button type="button" id="genDiscard" class="small ghost">Discard</button></div>`;
      }
      // A world the player describes (customSetting): their words come first.
      if (GEN.custom(w)) html += `<label><b>Your world</b> <span class="muted small">where and when, and what it's like; the story keeps to it</span><textarea id="genWorld" maxlength="${GEN.SETTING.world}" rows="3" placeholder="a fishing village on a Scottish island in the 1950s, where everyone knows everyone's business">${esc(gen.worldText || '')}</textarea></label>`;
      const regions = GEN.regions(w);
      if (regions.length) html += genWhereHtml(w, regions);
      const c = gen.character;
      html += '<fieldset class="mk-choices"><legend>You</legend>' +
        `<label class="mk-option"><input type="radio" name="gen-mode" value="form"${gen.mode === 'form' ? ' checked' : ''}> <span><b>Make a character</b> ${c ? `<span class="muted">${esc(c.name)}, ${esc(c.role)}</span> ` : ''}<button type="button" id="genMake" class="small">${c ? 'Edit' : 'Make one'}</button></span></label>` +
        `<label class="mk-option"><input type="radio" name="gen-mode" value="line"${gen.mode === 'line' ? ' checked' : ''}> <span><b>Describe one in a line</b> <input type="text" id="genLine" maxlength="300" value="${esc(gen.line)}" placeholder="a trucker who just wants to get to the coast" aria-label="Describe your character in a line"></span></label>` +
        '</fieldset>' +
        `<label>What kind of story (optional)<textarea id="genNote" maxlength="400" rows="2" placeholder="quiet and tense; someone here is lying">${esc(gen.note)}</textarea></label>` +
        '<div class="muted small">The story engine writes the place, the people, their ties and an opening, one small step at a time (about 10 calls; several minutes on a local model). You can retry any step.</div>' +
        '<div class="row end"><button type="button" id="genGo" class="primary">Generate</button></div>';
    } else {
      const job = gen.job;
      const steps = GEN.order(job).map((id) => {
        const label = GEN.STEPS.find((s) => s.id === id).label;
        const running = gen.running && gen.progress && gen.progress.step === id;
        const failed = !gen.running && job.failed === id;
        const mark = job.steps[id] ? '✓' : running ? '…' : failed ? '✕' : '·';
        const count = running && gen.progress.of ? ` ${gen.progress.index} of ${gen.progress.of}` : id === 'cast' && !job.steps.cast && (job.partial.cast || []).length ? ` (${job.partial.cast.length} done)` : '';
        const redo = !gen.running && job.steps[id] && (id !== 'player' || job.line) ? ` <button type="button" class="small ghost" data-gen-redo="${id}" title="Make this again, and everything after it">Redo</button>` : '';
        return `<li class="gen-step ${job.steps[id] ? 'done' : running ? 'running' : failed ? 'failed' : ''}"><span class="gen-mark" aria-hidden="true">${mark}</span> ${esc(label)}${count}${redo}</li>`;
      }).join('');
      const list = `<ol class="gen-steps" aria-live="polite">${steps}</ol>`;
      html += GEN.done(job) ? `<details class="gen-steps-done"><summary>All steps done${gen.running && gen.progress ? ` · ${esc(gen.progress.label)}…` : ''}</summary>${list}</details>` : list;
      if (gen.error) html += `<div class="fail small">${esc(gen.error)}</div><div class="row"><button type="button" id="genRetry" class="primary">Retry this step</button></div>`;
      if (GEN.done(job)) html += (gen.running && gen.progress ? `<div class="small rv-note">${esc(gen.progress.label)}…</div>` : '') + reviewHtml();
      html += `<div class="row end gen-foot"><button type="button" id="genOver" class="ghost"${gen.running ? ' disabled' : ''}>Start over</button>${GEN.done(job) ? '<button type="button" id="genSave" title="Download the start and its people as a zip, ready to unzip over the world folder">Save as start</button><button type="button" id="genPlay" class="primary">Play</button>' : ''}</div>`;
    }
    $('genBody').innerHTML = html;
    renderProblems();
  }

  async function runGen(fromStep) {
    if (!gen || gen.running) return;
    const g = gen;
    if (fromStep) GEN.clearFrom(g.job, fromStep);
    g.running = true;
    g.error = '';
    renderGen();
    try {
      await GEN.run(g.world, g.job, { save: saveJob, onProgress: (p) => { g.progress = p; if (gen === g) renderGen(); } });
    } catch (e) {
      g.error = e.message;
    }
    g.running = false;
    g.progress = null;
    if (gen === g) renderGen();
  }

  $('genBody').addEventListener('change', (ev) => {
    if (!gen) return;
    const t = ev.target;
    if (t.id === 'rvSpoil') { gen.spoilers = t.checked; renderGen(); return; }
    // The map follows room edits once a field is left.
    if (t.dataset.rv && $('rvMap')) { $('rvMap').innerHTML = previewMapHtml(); return; }
    if (t.name === 'gen-region') gen.region = t.value;
    if (t.name === 'gen-mode') gen.mode = t.value;
  });
  $('genBody').addEventListener('input', (ev) => {
    if (!gen) return;
    // A review field: checked and stored now; the problems list follows.
    if (ev.target.dataset.rv) {
      const [kind, id, name] = ev.target.dataset.rv.split('|');
      const out = GEN.setField(gen.world, gen.job, kind, id || null, name, ev.target.value);
      gen.fieldErrors = gen.fieldErrors || {};
      gen.fieldErrors[ev.target.dataset.rv] = out.error || '';
      ev.target.parentElement.querySelector('.rv-err').textContent = out.error || '';
      if (!out.error) saveJob(gen.job);
      renderProblems();
      return;
    }
    if (ev.target.id === 'genLine') { gen.line = ev.target.value; gen.mode = 'line'; ev.target.closest('.mk-option').querySelector('input[type=radio]').checked = true; }
    if (ev.target.id === 'genNote') gen.note = ev.target.value;
    if (ev.target.id === 'genWorld') gen.worldText = ev.target.value;
    if (ev.target.id === 'genPlace') gen.place = ev.target.value;
    // Search fills in the results without redrawing the box (keeps focus).
    if (ev.target.id === 'genSearch') { gen.search = ev.target.value; $('genResults').innerHTML = genResultsHtml(gen.world.bundle.world, GEN.regions(gen.world.bundle.world)); }
  });
  $('genBody').addEventListener('click', (ev) => {
    if (!gen) return;
    // The map in the picker (R-7): zoom into a region with regions inside, pick a startable one.
    const reg = ev.target.closest && ev.target.closest('#genMap .region-g');
    if (reg) {
      if (reg.dataset.zoomable) { gen.mapLevel = reg.dataset.region; return renderGen(); }
      if (GEN.regions(gen.world.bundle.world).some((r) => r.id === reg.dataset.region)) return genPick(reg.dataset.region);
      return;
    }
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.genpick) return genPick(b.dataset.genpick);
    if (b.dataset.genview) { gen.whereView = b.dataset.genview; return renderGen(); }
    if (b.dataset.genlevel != null) { gen.mapLevel = b.dataset.genlevel || null; return renderGen(); }
    if (b.id === 'genSurprise') return genPick(GEN.surprise(gen.world.bundle.world));
    if (b.id === 'genMake') {
      gen.mode = 'form';
      const g = gen;
      openCharacterForm({
        // In a world the player describes, Suggest ideas fit what they wrote so far.
        sc: Object.assign(GEN.slotScenario(g.world, g.region), GEN.custom(g.world.bundle.world) && (g.worldText || '').trim() ? { setting: g.worldText.trim() } : {}), key: `${g.key}/generated`, title: `Make your character: ${g.world.title}`, done: 'Use this character',
        onDone: (c) => { g.character = c; $('makerDialog').close(); renderGen(); return null; },
      });
    } else if (b.id === 'genGo') {
      try {
        gen.job = GEN.newJob(gen.world, { region: gen.region, note: gen.note, character: gen.mode === 'form' ? gen.character : null, line: gen.mode === 'line' ? gen.line : '', place: gen.place || '', world: gen.worldText || '' });
      } catch (e) {
        gen.error = '';
        alert(e.message);
        return;
      }
      saveJob(gen.job);
      runGen();
    } else if (b.id === 'genResume') {
      gen.job = savedJob(gen.key);
      renderGen();
      if (!GEN.done(gen.job)) runGen();
    } else if (b.id === 'genDiscard') {
      dropJob();
      renderGen();
    } else if (b.id === 'genRetry') runGen();
    else if (b.dataset.genRedo) runGen(b.dataset.genRedo);
    else if (b.id === 'genOver') {
      dropJob();
      gen.job = null;
      gen.error = '';
      renderGen();
    } else if (b.dataset.rvPerson) {
      const c = GEN.target(gen.job, 'person', b.dataset.rvPerson);
      rerollRun(`Rerolling ${c.name}`, () => GEN.rerollPerson(gen.world, gen.job, c.id));
    } else if (b.dataset.rvRoom) {
      const r = GEN.target(gen.job, 'room', b.dataset.rvRoom);
      rerollRun(`Rerolling ${r.name}`, () => GEN.rerollRoom(gen.world, gen.job, r.id));
    } else if (b.dataset.rvRedo) {
      const label = { opening: 'the opening', ties: 'the pressures', extras: 'the minor people', lore: 'the local lore' }[b.dataset.rvRedo];
      rerollRun(`Rerolling ${label}`, () => GEN.redoOnly(gen.world, gen.job, b.dataset.rvRedo));
    } else if (b.dataset.rvLoreDel) {
      GEN.removeLore(gen.job, b.dataset.rvLoreDel);
      saveJob(gen.job);
      renderGen();
    } else if (b.id === 'genSave') {
      if (!GEN.reviewProblems(gen.world, gen.job).length) saveStart();
    } else if (b.id === 'genPlay') {
      if (GEN.reviewProblems(gen.world, gen.job).length) return;
      let scenario;
      try { scenario = GEN.scenario(gen.world, gen.job); } catch (e) { gen.error = e.message; renderGen(); return; }
      const world = gen.world;
      dropJob();
      gen = null;
      $('genDialog').close();
      beginGame(world, scenario);
      renderAll();
      $('actionInput').focus();
    }
  });
  // ---------- review (task 4-3) ----------
  // A finished start, before playing: every field editable and checked as
  // it's typed (E.StartGen.setField), one room, one person, the pressures,
  // the minor people or the opening rerollable, secrets behind a spoiler
  // toggle, and Save as start. Play and Save wait until reviewProblems is empty.
  function reviewHtml() {
    const job = gen.job;
    const s = job.steps;
    const off = gen.running ? ' disabled' : '';
    const errs = gen.fieldErrors || {};
    const field = (kind, id, name, value, o = {}) => {
      const key = `${kind}|${id || ''}|${name}`;
      const v = esc(value == null ? '' : String(value));
      const input = o.options ? `<select data-rv="${esc(key)}">${o.options.map((x) => `<option${x === value ? ' selected' : ''}>${x}</option>`).join('')}</select>`
        : o.rows ? `<textarea data-rv="${esc(key)}" rows="${o.rows}">${v}</textarea>`
          : `<input type="${o.type || 'text'}" data-rv="${esc(key)}" value="${v}"${o.step ? ` step="${o.step}"` : ''}>`;
      return `<label class="rv-field${o.cls ? ' ' + o.cls : ''}">${esc(o.label)}${input}<span class="fail small rv-err">${esc(errs[key] || '')}</span></label>`;
    };
    const reroll = (attr, label, title) => `<button type="button" class="small" ${attr}${off} title="${esc(title)}">↻ ${esc(label)}</button>`;
    const clockFields = (c) => field('clock', c.id, 'name', c.name, { label: 'Name' }) +
      `<div class="rv-row">${field('clock', c.id, 'max', c.max, { label: 'Steps until it comes to a head', type: 'number' })}${field('clock', c.id, 'perHour', c.perHour, { label: 'Steps per hour', type: 'number', step: '0.01' })}</div>` +
      field('clock', c.id, 'fireText', c.fireText, { label: 'What happens then', rows: 2 });
    const roomName = (id) => (s.rooms.rooms.find((r) => r.id === id) || {}).name || id;
    const o = s.opening;
    const hidden = '<div class="muted small">Hidden. Turn on spoilers to see or edit it.</div>';
    let html = `<label class="web-toggle rv-spoil"><input type="checkbox" id="rvSpoil"${gen.spoilers ? ' checked' : ''}> Show spoilers (secrets, private facts, notes for the story engine)</label>`;
    // The world the player described (customSetting): what the story keeps to.
    if (s.setting) {
      html += '<section class="rv-section"><div class="rv-head"><h4>Your world</h4></div>' +
        `<div class="muted small">You asked for: ${esc(job.worldText)}</div>` +
        field('setting', '', 'setting', s.setting.setting, { label: 'Setting (the story keeps to this)', rows: 4 }) +
        `<div class="rv-row">${field('setting', '', 'tags', (s.setting.tags || []).join(', '), { label: 'Genre tags (separated by commas)', cls: 'rv-grow' })}</div>` +
        field('setting', '', 'toneNote', s.setting.toneNote, { label: 'Tone' }) + '</section>';
    }
    html += `<section class="rv-section"><div class="rv-head"><h4>Opening</h4>${reroll('data-rv-redo="opening"', 'Reroll', 'Write the opening again; everything else stays')}</div>` +
      field('opening', '', 'title', o.title, { label: 'Title' }) +
      field('opening', '', 'summary', o.summary, { label: 'Summary (shown in the picker)', rows: 2 }) +
      field('opening', '', 'opening', o.opening, { label: 'Opening scene', rows: 8 }) +
      field('opening', '', 'facts', (o.facts || []).join('\n'), { label: 'Facts everyone knows (one per line)', rows: 3 }) + '</section>';
    html += '<section class="rv-section"><div class="rv-head"><h4>Places</h4></div>' +
      `<div id="rvMap" class="rv-map">${previewMapHtml()}</div>` +
      // One of the world's own places (task 7-4): shown, not edited here.
      (s.rooms.place ? `<div class="muted small">You start in ${esc(roomName(s.rooms.playerRoom))}, in one of the world's own places: ${esc(s.rooms.rooms.map((r) => r.name).join(', '))}.</div>` : s.rooms.rooms.map((r) => `<div class="rv-card"><div class="rv-head"><b>${esc(r.name)}</b>${r.id === s.rooms.playerRoom ? ' <span class="tag">you start here</span>' : ''}${reroll(`data-rv-room="${esc(r.id)}"`, 'Reroll', 'A new name and description; it stays where it is')}</div>` +
        field('room', r.id, 'name', r.name, { label: 'Name' }) + field('room', r.id, 'desc', r.desc, { label: 'Description', rows: 2 }) +
        `<div class="muted small">Connects to ${esc(r.connects.map(roomName).join(', ') || 'nothing')}</div></div>`).join('')) + '</section>';
    const withYou = new Set(o.withYou || []);
    const person = (c, you) => {
      const where = you || withYou.has(c.id) ? s.rooms.playerRoom : c.status.location;
      const secret = you || gen.spoilers
        ? `<div class="rv-row">${field('person', c.id, 'secret', c.secret, { label: you ? 'Your secret (optional)' : 'Secret', rows: 2, cls: 'rv-grow' })}${c.secret ? field('person', c.id, 'guard', c.guard || 'medium', { label: 'Guard', options: ['low', 'medium', 'high'] }) : ''}</div>` +
          (!you && (c.knows || []).length ? `<div class="known-head">Knows</div><ul class="known">${c.knows.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : '')
        : hidden;
      return `<div class="rv-card"><div class="rv-head"><b>${esc(c.name)}</b> <span class="muted small">${you ? 'you · ' : ''}starts in ${esc(roomName(where))}</span>${you ? '' : reroll(`data-rv-person="${esc(c.id)}"`, 'Reroll', 'A new sheet for the same name and role; the others stay')}</div>` +
        `<div class="rv-row">${field('person', c.id, 'name', c.name, { label: 'Name', cls: 'rv-grow' })}${field('person', c.id, 'pronouns', c.pronouns, { label: 'Pronouns' })}${field('person', c.id, 'age', c.age, { label: 'Age', type: 'number', cls: 'rv-age' })}</div>` +
        field('person', c.id, 'role', c.role, { label: 'Role' }) +
        field('person', c.id, 'traits', (c.traits || []).join(', '), { label: 'Traits (separated by commas)' }) +
        field('person', c.id, 'want', c.want, { label: 'Wants' }) +
        field('person', c.id, 'voice', c.voice, { label: 'Voice' }) +
        field('person', c.id, 'appearance', c.appearance, { label: 'Appearance', rows: 2 }) +
        field('person', c.id, 'description', c.description, { label: 'Who they are', rows: 2 }) + secret + '</div>';
    };
    html += `<section class="rv-section"><div class="rv-head"><h4>People</h4></div>${person(s.player.character, true)}${s.cast.people.map((c) => person(c, false)).join('')}</section>`;
    html += `<section class="rv-section"><div class="rv-head"><h4>Pressures</h4>${reroll('data-rv-redo="ties"', 'Reroll', 'New pressures, feelings and private facts; the people stay')}</div>` +
      s.ties.clocks.map((c) => `<div class="rv-card">${clockFields(c)}` +
        (c.then || []).map((t) => `<div class="rv-then"><div class="small muted">Then, once that happens:</div>${clockFields(t)}</div>`).join('') + '</div>').join('') +
      ((s.ties.events || []).length ? `<div class="small muted">Ideas for later events here:</div><ul class="rv-list">${s.ties.events.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '') + '</section>';
    const ex = s.extras;
    html += `<section class="rv-section"><div class="rv-head"><h4>Minor people and groups</h4>${reroll('data-rv-redo="extras"', 'Reroll', 'New minor people and groups')}</div>` +
      (ex.extras.length || ex.standees.length ? `<ul class="rv-list">${ex.extras.map((x) => `<li><b>${esc(x.name)}</b>, ${esc(x.role)}${x.location ? `, in ${esc(roomName(x.location))}` : ''}${gen.spoilers && x.note ? ` <span class="muted">${esc(x.note)}</span>` : ''}</li>`).join('')}` +
        `${ex.standees.map((g) => `<li><b>${g.count} ${esc(g.label)}</b>, ${esc(g.state)}, in ${esc(roomName(g.location))}${gen.spoilers && g.note ? ` <span class="muted">${esc(g.note)}</span>` : ''}</li>`).join('')}</ul>` : '<div class="muted small">None.</div>') + '</section>';
    // Local lore (task 5-6): public notes the story keeps to; editable, and
    // one can be taken out. A step that failed leaves a note, not a blocked start.
    const lore = s.lore || { entries: [] };
    const regionName = (id) => ((gen.world.bundle.world.regions || []).find((r) => r.id === id) || {}).name || id;
    html += `<section class="rv-section"><div class="rv-head"><h4>Local lore</h4>${reroll('data-rv-redo="lore"', 'Reroll', 'New notes on this place; everything else stays')}</div>` +
      (lore.dropped ? `<div class="muted small">No local lore this time (${esc(lore.dropped)}). The start plays without it; Reroll to try again.</div>` : '') +
      lore.entries.map((e) => `<div class="rv-card"><div class="rv-head"><b>${esc(e.title)}</b> <span class="muted small">about ${esc(e.level === 'region' ? regionName(e.ref) : roomName(e.ref))}${(e.topics || []).length ? ` · ${esc(e.topics.join(', '))}` : ''}</span><button type="button" class="small ghost" data-rv-lore-del="${esc(e.id)}"${off} aria-label="Remove ${esc(e.title)}">✕</button></div>` +
        field('lore', e.id, 'title', e.title, { label: 'Title' }) + field('lore', e.id, 'text', e.text, { label: 'Text (public: the story engine sees it)', rows: 3 }) +
        field('lore', e.id, 'keywords', (e.keywords || []).join(', '), { label: 'Keywords (separated by commas)' }) + '</div>').join('') +
      (!lore.entries.length && !lore.dropped ? '<div class="muted small">None.</div>' : '') + '</section>';
    if (gen.rvNote) html += `<div class="small rv-note">${esc(gen.rvNote)}</div>`;
    html += '<ul id="rvProblems" class="maker-errors fail" aria-live="polite"></ul>';
    return html;
  }
  // The start's local map, drawn by the game's own map code against a
  // throwaway game of this start (localMapHtml reads the page's state, so it
  // is swapped for the call and put back).
  function previewMapHtml() {
    let preview;
    try { preview = E.Engine.newGame(GEN.scenario(gen.world, gen.job)); } catch (e) { return '<div class="muted small">Fix the problems below to see the map.</div>'; }
    const saved = state;
    state = preview;
    try { return localMapHtml().replace(' id="mapList"', ''); } finally { state = saved; }
  }
  function renderProblems() {
    if (!gen || !gen.job || !GEN.done(gen.job) || !$('rvProblems')) return;
    const problems = GEN.reviewProblems(gen.world, gen.job);
    $('rvProblems').innerHTML = problems.map((p) => `<li>${esc(p)}</li>`).join('');
    ['genPlay', 'genSave'].forEach((id) => { if ($(id)) $(id).disabled = gen.running || problems.length > 0; });
  }
  async function rerollRun(label, fn) {
    if (!gen || gen.running) return;
    const g = gen;
    g.running = true;
    g.rvNote = '';
    g.progress = { label };
    renderGen();
    try {
      const out = await fn();
      g.rvNote = (out && out.note) || '';
    } catch (e) {
      g.rvNote = e.message;
    }
    g.running = false;
    g.progress = null;
    saveJob(g.job);
    if (gen === g) renderGen();
  }
  function saveStart() {
    const files = GEN.files(gen.world, gen.job);
    const folder = gen.world.folder;
    const entries = Object.entries(files).map(([p, obj]) => ({ name: `${folder}/${p}`, data: E.Zip.utf8(JSON.stringify(obj, null, 2) + '\n') }));
    download(`${folder}-${gen.job.id}.zip`, new Blob([E.Zip.build(entries)], { type: 'application/zip' }));
  }
  $('genForm').addEventListener('submit', (ev) => ev.preventDefault());
  $('genClose').addEventListener('click', () => $('genDialog').close());

  // File names: world and start titles, e.g. "ares-deep-sol-214-the-mule".
  function gameSlug(sc) {
    const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return [sc.worldTitle || sc.title, sc.startTitle].map(slug).filter(Boolean).join('-') || slug(sc.folder || sc.id) || 'game';
  }

  // A test-play tab (task 6-1) never overwrites the player's own game.
  function autosave() {
    if (!state || TEST_PLAY) return;
    if (!saveId) saveId = E.Saves.newId();
    E.Saves.save(saveId, state);
  }

  // obj: a Blob as it is, or anything else as JSON.
  function download(name, obj) {
    const blob = obj instanceof Blob ? obj : new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  $('btnSave').addEventListener('click', () => {
    if (!state) return;
    // The undo snapshot is a second copy of the game; save files leave it out.
    download(`ensemble-${gameSlug(state.scenario)}-turn${state.turn}.json`, Object.assign({}, state, { undo: undefined }));
  });

  // ---------- recorder (Debug) ----------
  function renderRecorder() {
    const on = E.Recorder.active();
    const f = E.Recorder.fixture();
    const n = E.Recorder.count();
    $('btnRecord').textContent = on ? `■ Stop recording (${n})` : '● Record';
    $('btnRecord').classList.toggle('recording', on);
    $('btnExportRec').disabled = !f;
    $('btnExportRec').textContent = f ? `Export recording (${n} action${n === 1 ? '' : 's'})` : 'Export recording';
  }
  // A new game or a loaded save ends the recording; it can still be exported.
  function stopRecording() { if (E.Recorder.active()) E.Recorder.stop(); renderRecorder(); }

  $('btnRecord').addEventListener('click', () => {
    if (busy) return;
    if (E.Recorder.active()) E.Recorder.stop();
    else if (!state) { alert('Start or load a game first, then record.'); return; }
    else E.Recorder.start(state);
    renderRecorder();
  });
  $('btnExportRec').addEventListener('click', () => {
    const f = E.Recorder.fixture();
    if (!f) return;
    const sc = f.start.scenario || {};
    download(`ensemble-recording-${gameSlug(sc)}-${f.recorded.slice(0, 16).replace(/[:T]/g, '-')}.json`, f);
  });

  $('loadInput').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s.scenario || !s.characters || !s.player) throw new Error('That file is not an Ensemble save.');
      stopRecording();
      state = E.Engine.migrate(s);
      saveId = null;
      restoreView();
      showPickInfo(false);
      openTurns.clear();
      uiCut = null;
      uiShown = 1;
      autosave();
      renderAll();
    } catch (e) {
      alert('Could not load: ' + e.message);
    }
  });

  // ---------- acting ----------
  async function act() {
    if (busy || !state || !canAct()) return;
    const skip = $('timeStep').value === 'major';
    const text = $('actionInput').value.trim();
    if (!text && !skip) return;
    setBusy(true);
    try {
      const result = await E.Engine.runTurn(state, text, $('timeStep').value, setPhase, uiCut);
      uiCut = null;
      uiShown = 1;
      openTurns.clear();
      if ($('timeStep').value === 'major') $('timeStep').value = 'hour';
      // A judged ending plays its closing instead of the action, which goes back in the box.
      $('actionInput').value = result.held || '';
      autosave();
      renderAll();
      announceBeat(0);
      $('actionInput').placeholder = actionPlaceholder();
      if (result.report && result.report.warning) showWarning(result.report.warning);
    } catch (e) {
      setPhase('');
      showWarning(e.message);
    } finally {
      setBusy(false);
      renderDebug();
    }
  }
  $('actionForm').addEventListener('submit', (ev) => { ev.preventDefault(); act(); });
  // Going on past an ending (not after death).
  $('log').addEventListener('click', (ev) => {
    if (ev.target.id !== 'btnKeepPlaying' || busy || !state) return;
    if (E.Engine.keepPlaying(state)) { autosave(); renderAll(); $('actionInput').focus(); }
  });
  $('actionInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); act(); }
  });

  // ---------- undo and reroll ----------
  $('btnUndo').addEventListener('click', () => {
    if (busy || !E.Engine.canUndo(state)) return;
    const info = E.Engine.undo(state);
    $('actionInput').value = info.action || '';
    if (E.timeSteps.some((s) => s.id === info.stepId)) $('timeStep').value = info.stepId;
    // Back on the previous scene, as far as it had been read, with the step-in point re-selected.
    const live = liveScene();
    uiCut = live && info.cutAt && info.cutAt < live.beats.length ? info.cutAt : null;
    uiShown = live ? uiCut || live.beats.length : 1;
    const removed = info.chaptersRemoved.length ? ` Removed chapter ${info.chaptersRemoved.join(', ')}.` : '';
    notes.push({ kind: 'undo', summary: `turn ${info.turn} undone, back to ${info.to}.${removed}`, detail: `Action: ${info.action || '(downtime)'}\nTime step: ${info.stepId}${info.cutAt ? `\nIt had stepped in after beat ${info.cutAt}; that beat choice is restored.` : ''}` });
    autosave();
    renderAll();
    $('actionInput').placeholder = actionPlaceholder();
    showNote(`Turn ${info.turn} undone; your action is back in the box.${removed} Only one turn can be undone.`);
    $('actionInput').focus();
  });

  $('btnReroll').addEventListener('click', async () => {
    if (busy || !E.Engine.canReroll(state)) return;
    setBusy(true);
    try {
      const out = await E.Engine.rerollNarration(state, setPhase);
      uiCut = null;
      uiShown = 1;
      notes.push({ kind: 'reroll', summary: `turn ${out.turn} rewritten (same rolls, moves and events)`, detail: `Old scene:\n${out.oldText}\n\nNew scene:\n${out.prose}` });
      autosave();
      renderAll();
      announceBeat(0);
    } catch (e) {
      setPhase('');
      showWarning(e.message);
    } finally {
      setBusy(false);
      renderDebug();
    }
  });

  // Acting is only possible at the end of the scene, or after choosing
  // "Step in here"; acting never steps in by accident.
  function canAct() {
    const live = liveScene();
    return !live || uiShown >= live.beats.length || uiCut != null;
  }

  function renderControls() {
    const blocked = !!state && !canAct();
    $('btnAct').disabled = busy || blocked;
    $('btnAct').title = blocked ? 'Read to the end of the scene (Next ▸), or press "Step in here" to act now' : '';
    $('actionInput').placeholder = actionPlaceholder();
    $('btnUndo').disabled = busy || !E.Engine.canUndo(state);
    $('btnReroll').disabled = busy || !E.Engine.canReroll(state);
    $('btnSuggest').disabled = busy || !state || blocked || state.flags.gameOver;
    // An unfinished trip (R-10): the rest of it as one journey.
    const trip = state && !state.flags.gameOver && state.travel;
    $('btnTravel').classList.toggle('hidden', !trip);
    $('btnTravel').disabled = busy || blocked || !trip;
    if (trip) $('btnTravel').title = `Go on to ${trip.destName} until you arrive, or something major happens`;
    renderSuggestions();
  }

  // ---------- suggested actions ----------
  // A few ideas from the model; clicking one fills the action box (the player
  // still presses Act). They belong to the moment they were asked for: a new
  // turn, step-in point or game hides them.
  const suggestKey = () => `${state.turn}:${uiCut || ''}`;
  function renderSuggestions() {
    const el = $('suggestions');
    const list = suggested && suggested.state === state && suggested.key === suggestKey() ? suggested.list : [];
    el.innerHTML = list.map((t, i) => `<button type="button" class="suggestion" data-suggest="${i}">${esc(t)}</button>`).join('');
    el.classList.toggle('hidden', !list.length);
  }
  $('btnTravel').addEventListener('click', () => {
    if (!state || !state.travel) return;
    $('timeStep').value = 'major';
    $('actionInput').value = `Keep going to ${state.travel.destName}.`;
    $('btnAct').click();
  });
  $('btnSuggest').addEventListener('click', async () => {
    if (busy || !state || !canAct()) return;
    const live = liveScene();
    // Only what the player has read: up to the step-in point if one is chosen.
    const sceneText = live && uiCut ? live.beats.slice(0, uiCut).map((b) => b.text).join('\n\n') + `\n\n[${state.characters[state.player].name} steps in here.]` : undefined;
    setBusy(true);
    setPhase('Thinking of ideas…');
    try {
      suggested = { state, key: suggestKey(), list: await E.Engine.suggestActions(state, sceneText) };
      announce(`${suggested.list.length} suggestions.`);
    } catch (e) {
      showWarning(e.message);
    } finally {
      setPhase('');
      setBusy(false);
      renderDebug();
    }
  });
  $('suggestions').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-suggest]');
    if (!btn || busy) return;
    $('actionInput').value = btn.textContent;
    $('actionInput').focus();
  });

  function setBusy(b) {
    busy = b;
    $('btnNew').disabled = b;
    $('actionInput').disabled = b;
    renderControls();
  }
  function setPhase(text) {
    const el = $('phase');
    el.textContent = text;
    el.classList.toggle('busy', !!text);
  }
  // ---------- screen readers ----------
  // The log is redrawn as a whole, so it can't be a live region itself; instead
  // each newly shown beat (and every note) is read out from #srAnnounce.
  function announce(text) {
    const el = $('srAnnounce');
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 30);
  }
  // The newest scene's beat n (0-based), with what to do next.
  function announceBeat(n) {
    const e = state && [...state.log].reverse().find((x) => x.type === 'scene');
    if (!e) return;
    const beats = e.beats && e.beats.length ? e.beats : [{ text: e.text }];
    const b = beats[Math.min(n, beats.length - 1)];
    const more = n < beats.length - 1 && liveScene();
    announce(`${b.text}${more ? ' (Next for more, or Step in here.)' : ' (Your turn.)'}`);
  }

  function showWarning(msg) { showNote('⚠ ' + msg, 'warn'); }
  function showNote(msg, cls) {
    announce(msg);
    const div = document.createElement('div');
    div.className = 'entry ' + (cls || 'note');
    div.textContent = msg;
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
  }

  // ---------- rendering ----------
  function renderAll() {
    renderControls();
    renderLog();
    renderSceneBar();
    renderSituation();
    renderNews();
    renderCast();
    renderMap();
    renderJournal();
    renderDebug();
  }

  function nm(id) { return state.characters[id] ? state.characters[id].name : id; }

  // Earlier turns fold into a closed "Turn N" row; only the latest turn is
  // shown in full. Rows the player opens stay open until the next turn starts.
  function renderLog() {
    const log = $('log');
    if (!state) return;
    const groups = [];
    state.log.forEach((e) => {
      const last = groups[groups.length - 1];
      if (e.type === 'chapter') groups.push({ chapter: e });
      else if (last && !last.chapter && last.turn === e.turn) last.entries.push(e);
      else groups.push({ turn: e.turn, entries: [e] });
    });
    const turnHtml = (g) => {
      const body = g.entries.map(renderEntry).join('');
      if (g.turn === state.turn) return `<div class="turn-current" data-turn="${g.turn}">${body}</div>`;
      return `<details class="turn-group" data-turn="${g.turn}"${openTurns.has(g.turn) ? ' open' : ''}><summary>${turnSummary(g)}</summary>${body}</details>`;
    };
    // A closed chapter folds its turns under one row: its title, its turns
    // and its summary, opened on demand (and kept open until reloaded).
    const out = [];
    let since = [];
    groups.forEach((g) => {
      if (!g.chapter) return since.push(g);
      const c = g.chapter.chapter;
      out.push(`<details class="chapter-group" data-chapter="${c.n}"${openChapters.has(c.n) ? ' open' : ''}><summary><span class="chapter-n">Chapter ${c.n}</span><b>${esc(c.title)}</b><span class="when">turns ${c.fromTurn}–${c.toTurn}</span></summary>` +
        `<div class="chapter-summary">${esc(c.summary)}</div>${since.map(turnHtml).join('')}</details>`);
      since = [];
    });
    const html = out.concat(since.map(turnHtml)).join('');
    log.innerHTML = html || '<div class="empty">Write your first action below.</div>';
    if (state.flags.gameOver) log.insertAdjacentHTML('beforeend', '<div class="entry chapter"><b>Your story ends here.</b>Load a save or start a new game.</div>');
    // An ending (not death): the player may go on past it, once the scene is read.
    else if (E.Engine.ended(state) && canAct()) log.insertAdjacentHTML('beforeend', '<div class="entry chapter end-card"><b>The story has reached an ending.</b>Keep playing to see what comes after, or start a new game. <button type="button" id="btnKeepPlaying" class="primary small">Keep playing</button></div>');
    // Land at the start of the latest turn, or at the bottom if it's short.
    const cur = log.querySelector('.turn-current');
    log.scrollTop = cur ? Math.min(offsetIn(log, cur) - 8, log.scrollHeight) : log.scrollHeight;
  }

  // An element's position inside the scrolling story panel.
  const offsetIn = (log, el) => el.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;

  function turnSummary(g) {
    const action = g.entries.find((e) => e.type === 'action');
    const scene = g.entries.find((e) => e.type === 'scene');
    const label = g.turn === 0 ? 'Opening' : `Turn ${g.turn}`;
    const what = action ? `${action.skip ? '⏭ ' : ''}${E.shorten(action.text, 90)}` : '';
    const when = action ? action.time : '';
    return `<span class="turn-n">${label}</span>${esc(what)}<span class="when">${esc(when || '')}${scene && scene.cutAt ? ' · stepped in' : ''}</span>`;
  }

  function renderEntry(e) {
    if (e.type === 'scene') return renderScene(e);
    if (e.type === 'action') return `<div class="entry action">${e.skip ? '⏭ ' : ''}${esc(e.text)}<span class="when">${esc(e.time || '')}${e.until ? ' → ' + esc(e.until) : ''}</span></div>`;
    if (e.type === 'chapter') return `<div class="entry chapter">Chapter ${e.chapter.n} ends<b>${esc(e.chapter.title)}</b></div>`;
    // An ending: its closing scene (a judged one) and the title, once the scene before it is read.
    if (e.type === 'ending') {
      const live = liveScene();
      if (live && live.turn === e.turn && !canAct()) return '';
      const word = { win: 'A win', loss: 'A loss', bittersweet: 'Bittersweet', neutral: 'An ending' }[e.kind] || 'An ending';
      return (e.text ? `<div class="entry scene ending">${String(e.text).split(/\n\s*\n/).map((p) => `<p>${storyHtml(p.trim())}</p>`).join('')}</div>` : '') +
        `<div class="entry chapter ending-title">${word}<b>The end: ${esc(e.title)}</b></div>`;
    }
    if (e.type === 'note') return `<div class="entry note muted small">${esc(e.text)}</div>`;
    if (e.type === 'resolve') {
      const items = e.outcomes.map((o) => {
        const hidden = !o.visible && o.id !== state.player;
        // Covert actions stay secret from the player; the Debug panel shows the truth.
        if (hidden) return `<li class="hid">🔒 <b>${esc(nm(o.id))}</b>: something you didn't see</li>`;
        const res = o.roll
          ? ` — <span class="${/success/.test(o.roll.result) ? 'ok' : 'fail'}">${o.roll.result}</span> <span class="muted">(${esc(o.skill)}: d20 ${o.roll.d} → ${o.roll.total} vs ${o.roll.dc})</span>`
          : '';
        const extra = (o.reveals ? `<br><span class="ok">reveals:</span> ${esc(o.reveals)}` : '') +
          (o.missing ? ' <span class="muted">(model gave no intent)</span>' : '') +
          (o.id === state.player && o.note ? ` <span class="muted">(${esc(o.note)})</span>` : '');
        return `<li><b>${esc(nm(o.id))}</b>: ${esc(o.action)}${res}${extra}</li>`;
      }).concat(e.events.map((t) => {
        const heard = /^\(heard from elsewhere[^)]*\)\s*/.test(t);
        let body = t.replace(/^\(heard from elsewhere[^)]*\)\s*/, '');
        const tier = (body.match(/^\[(regional|world)\]\s*/) || [])[1];
        body = body.replace(/^\[(regional|world)\]\s*/, '');
        const icon = tier === 'world' ? '🌍' : tier === 'regional' ? '🗺️' : heard ? '🔊' : '⚡';
        return `<li class="${heard && !tier ? 'muted' : 'fail'}">${icon} ${esc(body)}</li>`;
      }));
      return `<details class="entry rolls"><summary>What everyone tried (turn ${e.turn})</summary><ul>${items.join('')}</ul></details>`;
    }
    return '';
  }

  // Which folded turns the player has opened; cleared when a new turn starts.
  // Opened chapters stay open.
  $('log').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.classList && d.classList.contains('chapter-group')) {
      const n = Number(d.dataset.chapter);
      if (d.open) openChapters.add(n); else openChapters.delete(n);
      return;
    }
    if (!d.classList || !d.classList.contains('turn-group')) return;
    const n = Number(d.dataset.turn);
    if (d.open) openTurns.add(n); else openTurns.delete(n);
  }, true);

  // A beat's game date and time, like a log line: "Sol 214, 07:30".
  // With sameDayAs (another beat), the date is left out when it matches.
  function beatClock(e, b, sameDayAs) {
    const at = (x) => {
      const total = (e.startMinutes || 0) + x.at;
      const m = total % 1440;
      return { day: (e.startDay || 0) + Math.floor(total / 1440), hhmm: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` };
    };
    const t = at(b);
    if (sameDayAs && at(sameDayAs).day === t.day) return t.hhmm;
    return `${E.dayName(state.scenario, t.day)}, ${t.hhmm}`;
  }

  function liveScene() {
    const e = state && state.pending && state.log.find((x) => x.type === 'scene' && x.turn === state.pending.turn);
    return e && e.beats && e.beats.length > 1 ? e : null;
  }

  // The live scene is revealed one beat at a time. Under the newest beat the
  // player either steps in or moves on; moving on settles that beat for good.
  // Beats after a step-in never happened, so they are never shown.
  function renderScene(e) {
    // What is still to go on a trip (R-10): the engine's line, outside the prose.
    const travel = (read) => (e.travel && read ? `<div class="beat-note travel-note">${esc(e.travel)}</div>` : '');
    const live = state.pending && state.pending.turn === e.turn;
    if (!e.beats || e.beats.length < 2) return `<div class="entry scene">${storyHtml(e.text)}</div>${travel(true)}`;
    const shown = live ? Math.min(uiShown, e.beats.length) : (e.cutAt || e.beats.length);
    let h = e.beats.slice(0, shown).map((b, i) =>
      `<div class="beat" data-beat="${i}"><div class="beat-time">${beatClock(e, b)}</div><div class="entry scene">${storyHtml(b.text)}</div></div>`
    ).join('');
    if (live && shown < e.beats.length) {
      const on = uiCut === shown;
      h += `<div class="interject"><button type="button" data-cut="${shown}" class="${on ? 'active' : ''}">${on ? '✓ Stepping in here (click to cancel)' : '↩ Step in here'}</button>` +
        `<button type="button" data-next>Next ▸</button></div>`;
    } else if (!live && e.cutAt) {
      h += '<div class="beat-note">You stepped in here; the rest didn\'t happen.</div>';
    }
    return h + travel(!live || shown >= e.beats.length);
  }

  // ---------- names in the story ----------
  // Places, people and lore terms in a scene are linked (E.Glossary decides
  // which, and only with what the player may know): hovering or focusing one
  // shows a short box, a click or tap opens the whole entry, and a person's
  // opens their card.
  function storyHtml(text) {
    const on = (storyLinksPreview || E.settings.appearance.storyLinks) !== 'off';
    return on && state ? E.Glossary.markup(state, text, esc) : esc(text);
  }
  const termInfo = (el) => E.Glossary.info(state, E.Glossary.parse(el.dataset.term));
  function termHtml(info, short) {
    const text = short ? (info.text[0] ? [E.shorten(info.text[0], 220)] : []) : info.text;
    return `<div class="term-title"${short ? '' : ' id="termTitle"'}><b>${esc(info.title)}</b>${info.feel ? ` <span class="rel-${esc(info.feel.split(' ')[0])}">you: ${esc(info.feel)}</span>` : ''}</div>` +
      (info.sub ? `<div class="muted small">${esc(info.sub)}</div>` : '') +
      text.map((t) => `<p>${esc(t)}</p>`).join('') +
      (!text.length ? '<div class="muted small">Nothing more is known yet.</div>' : '') +
      (short ? `<div class="muted small">${info.person ? 'Click for their card.' : 'Click for more.'}</div>` : '');
  }
  function showTip(el) {
    const info = termInfo(el);
    const tip = $('termTip');
    if (!info) return hideTip();
    tip.innerHTML = termHtml(info, true);
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  }
  function hideTip() { $('termTip').hidden = true; }
  function openTerm(el) {
    hideTip();
    const info = termInfo(el);
    if (!info) return;
    $('termBody').innerHTML = info.person ? popupCard(info.person) : termHtml(info, false);
    $('termDialog').showModal();
  }
  // A person's card in the popup: what the People panel shows, to read only.
  function popupCard(id) {
    const c = state.characters[id];
    const dead = c.status.health === 'dead';
    return `<div class="card popup-card${dead ? ' dead' : ''}" id="termTitle">${cardHeader(id, c, id === state.player, true)}${cardStatus(c, id === state.player)}${cardBody(id, c, dead, false)}</div>`;
  }
  $('log').addEventListener('pointerover', (ev) => {
    const el = ev.pointerType === 'mouse' && ev.target.closest('.term');
    if (el) showTip(el);
  });
  $('log').addEventListener('pointerout', (ev) => { if (ev.target.closest('.term')) hideTip(); });
  $('log').addEventListener('focusin', (ev) => { const el = ev.target.closest('.term'); if (el) showTip(el); });
  $('log').addEventListener('focusout', (ev) => { if (ev.target.closest('.term')) hideTip(); });
  $('log').addEventListener('scroll', hideTip, { passive: true });
  $('log').addEventListener('click', (ev) => { const el = ev.target.closest('.term'); if (el && state) openTerm(el); });
  $('log').addEventListener('keydown', (ev) => {
    const el = ev.target.closest && ev.target.closest('.term');
    if (!el || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    openTerm(el);
  });

  function actionPlaceholder() {
    const entry = liveScene();
    if (entry && !canAct()) return 'Read on with Next ▸, or press "Step in here" to act now. (You can type ahead.)';
    if (uiCut && entry) return `What do you do at ${beatClock(entry, entry.beats[uiCut - 1])}–${beatClock(entry, entry.beats[uiCut], entry.beats[uiCut - 1])}? (Ctrl+Enter to act)`;
    return $('timeStep').value === 'major'
      ? 'How do you spend the downtime? (optional, e.g. "Keep the arrays clean and avoid Teo")'
      : 'What do you do? (Ctrl+Enter to act)';
  }

  $('log').addEventListener('click', (ev) => {
    const cutBtn = ev.target.closest('button[data-cut]');
    const nextBtn = ev.target.closest('button[data-next]');
    if ((!cutBtn && !nextBtn) || busy) return;
    if (cutBtn) {
      const n = parseInt(cutBtn.dataset.cut, 10);
      uiCut = uiCut === n ? null : n;
    } else {
      uiCut = null;
      uiShown++;
    }
    const log = $('log');
    const top = log.scrollTop;
    renderLog();
    renderControls();
    // People who move in this beat move on the map now.
    renderMap();
    log.scrollTop = top;
    if (nextBtn) {
      announceBeat(uiShown - 1);
      // Bring the new beat into view from its top, scrolling only the story
      // panel and only downward. (Earlier turns have beats with the same
      // numbers, so look only inside the current turn.)
      const beat = log.querySelector(`.turn-current .beat[data-beat="${uiShown - 1}"]`);
      if (beat) log.scrollTop = Math.max(top, Math.min(offsetIn(log, beat) - 8, log.scrollHeight - log.clientHeight));
    } else {
      $('actionInput').focus();
    }
  });

  function renderSceneBar() {
    const pc = state.characters[state.player];
    const loc = state.locations[pc.status.location];
    const present = E.Engine.present(state).map(nm);
    $('sceneBar').innerHTML = `<b>${esc(E.fmtTime(state))}</b> · ${esc(state.scenario.worldTitle || state.scenario.title)}${state.scenario.startTitle ? `<span class="desktop-only"> (${esc(state.scenario.startTitle)})</span>` : ''} · You are in <b>${esc(loc ? loc.name : '?')}</b>` +
      (present.length ? ` with ${esc(present.join(', '))}` : ', alone') +
      ((m) => (m.length ? `<span class="desktop-only"> · also here: ${esc(m.map((x) => `${x.name} (${x.role})`).join(', '))}</span>` : ''))(E.Engine.extrasAt(state, pc.status.location)) +
      // Unnamed groups (task 3-2) on every screen size: a hostile crowd matters.
      ((g) => (g.length ? ` · ${esc(g.map((x) => `${x.count} ${x.label}, ${x.state}`).join('; '))}` : ''))(E.Engine.standeesAt(state, pc.status.location)) +
      ` · Chapter ${state.chapter}, turn ${state.turn}`;
  }

  function renderSituation() {
    const clocks = E.Engine.liveClocks(state).map((c) => {
      const pct = Math.round((c.value / c.max) * 100);
      return `<div class="clock"><div class="label"><span>${esc(c.name)}</span><span class="muted">${c.fired ? 'happened' : pct + '%'}</span></div>` +
        `<div class="bar ${pct >= 75 || c.fired ? 'danger' : ''}"><i style="width:${c.fired ? 100 : pct}%"></i></div></div>`;
    }).join('');
    const world = Object.entries(state.world).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join('');
    // Each group's stance, and (task G-6) where the player stands with it: the
    // number and the word, their role, and the latest reason.
    const groups = (state.factions || []).map((f) => {
      const r = (state.reputation || {})[f.id];
      const role = E.Standing.roleOf(state, f.id);
      const standing = r ? ` <span class="standing">· you: <span class="rel-${E.Standing.word(r.value)}">${E.Standing.word(r.value)} ${r.value > 0 ? '+' : ''}${r.value}</span>${role ? ` (${role === 'leader' ? 'you lead it' : role})` : ''}${r.why ? ` <span class="muted">${esc(r.why)}</span>` : ''}</span>` : '';
      return `<div title="${esc(f.desc)}" data-group="${esc(f.id)}"><b>${esc(f.name)}</b>: ${esc(f.stance)}${standing}</div>`;
    }).join('');
    $('situation').innerHTML = clocks + `<div class="world">${world}</div>` + regionHtml() + (groups ? `<div class="world groups">${groups}</div>` : '');
  }

  // The player's region (task 3-1): who holds it, its tags and status. The map views come later.
  function regionHtml() {
    const id = E.Engine.playerRegion(state);
    const def = id && E.Engine.regionDef(state, id);
    const r = def && state.regions && state.regions[id];
    if (!r) return '';
    const present = E.Engine.presenceText(state, id);
    const bits = [`held by ${E.Engine.regionHolder(state, id).text}`].concat(present ? [`present: ${present}`] : [], r.tags.length ? [r.tags.join(', ')] : [], r.status ? [r.status] : []);
    // The regions it is inside (R-1): "in Harmon County".
    const up = E.Engine.regionChain(state, id).slice(1).map((x) => E.Engine.regionDef(state, x).name);
    return `<div class="world groups" title="${esc(def.lore || '')}"><b>${esc(def.name)}</b>${up.length ? ` <span class="muted">(in ${esc(up.join(', '))})</span>` : ''}: ${esc(bits.join('; '))}</div>`;
  }

  const newsRegion = (id) => { const d = id && E.Engine.regionDef(state, id); return d ? ` · ${esc(d.name)}` : ''; };
  function renderNews() {
    const news = (state.news || []).slice().reverse().slice(0, 6);
    $('newsPanel').classList.toggle('hidden', !news.length);
    $('news').innerHTML = news.map((n) =>
      `<div class="news-item"><span class="muted">${n.scope === 'world' ? '🌍' : '🗺️'} ${esc(n.time)}${newsRegion(n.region)}</span><div>${esc(n.text)}</div>` +
      (n.effects && n.effects.length ? `<div class="muted small">${n.effects.map(esc).join(' · ')}</div>` : '') + '</div>'
    ).join('');
  }

  // ---------- local map (task 3-3) ----------
  // E.Layouts.plan places the rooms; E.SiteDraw draws them as floor plans
  // (task 3-7) from what the player knows, built here: rooms in view, rooms
  // remembered, doors as last seen. "Map detail: simple" draws plain boxes
  // with theme colours: walls, a mark for each kind of link, labels,
  // features. Tokens go where the player last saw everyone (faded when out of
  // sight). Clicking fills in the action box and never acts. A start's
  // "localMap" draws its floor-plan image with room hotspots instead.
  const CELL = E.SiteDraw.CELL;
  let mapDetailPreview = null; // Settings › Map detail while the dialog is open
  let storyLinksPreview = null; // Settings › Names in the story, likewise
  let planCache = { key: null, plan: null };
  function mapPlan() {
    const sc = state.scenario;
    // Rooms placed from the authored ones (the map never moves); links drawn
    // from the live rooms, so an inferred window shows (task 3-6).
    // Only the place the player is in (task 4-4): the start's rooms, or a
    // generated site's. Routes to other places are listed under the map.
    const site = E.Sites.playerSite(state);
    const key = `${sc.worldId}|${sc.startId}|${site}|${Object.values(state.locations).map((l) => l.id + ':' + (l.connects || []).join('+')).join(',')}`;
    const home = site === E.Sites.HOME;
    // An authored place (task 7-2) is drawn on its own, with its own layout style.
    const authored = home ? (sc.locations && sc.locations.length ? sc.locations : Object.values(state.locations)).filter((l) => !l.site) : E.Sites.rooms(state, site);
    if (planCache.key !== key) planCache = { key, plan: E.Layouts.plan(authored, { type: home ? (sc.site ? sc.site.type : null) : ((state.sites || {})[site] || {}).layout, seed: `${sc.worldId}:${home ? sc.startId : site}`, linkLocs: state.locations }) };
    return planCache.plan;
  }
  // Tokens by room, as the player knows them.
  function mapTokens() {
    const byRoom = {};
    const add = (loc, t) => { if (loc && state.seenRooms.includes(loc)) (byRoom[loc] = byRoom[loc] || []).push(t); };
    const pc = state.characters[state.player];
    add(pc.status.location, { kind: 'character', id: state.player, label: pc.name, player: true, now: true });
    // While the scene is read beat by beat, someone who moves in a beat not
    // shown yet is still where they were (up to the step-in point, if one is
    // chosen), so the map follows the scene instead of jumping to its end.
    const live = liveScene();
    const read = live ? uiCut || uiShown : Infinity;
    const later = {};
    if (live) E.Engine.sceneMoves(state).forEach((m) => { if (m.beat >= read) later[m.id] = m.from; });
    const where = (id) => (later[id] ? { loc: later[id], now: true, turn: state.turn } : E.Engine.knownWhere(state, id));
    E.Engine.cast(state, { alive: true, includePlayer: false }).forEach((id) => {
      const kw = where(id);
      if (kw) add(kw.loc, { kind: 'character', id, label: state.characters[id].name, now: kw.now, turn: kw.turn });
    });
    Object.values(state.extras || {}).forEach((x) => {
      const kw = where(x.id);
      if (kw) add(kw.loc, { kind: 'extra', id: x.id, label: x.name, now: kw.now, turn: kw.turn });
    });
    Object.values(state.standees || {}).forEach((g) => {
      const kw = where(g.id);
      if (kw) add(kw.loc, { kind: 'standee', id: g.id, label: g.label, count: g.count, state: g.state, now: kw.now, turn: kw.turn });
    });
    return byRoom;
  }
  function tokenSvg(t, cx, cy, r) {
    const tip = t.player ? `${t.label} (you)` : `${t.label}${t.kind === 'standee' ? `: ${t.count}, ${t.state}` : ''}${t.now ? '' : ` (last seen turn ${t.turn})`}`;
    const attrs = `class="map-token${t.now ? '' : ' stale'}" tabindex="0" role="button" data-kind="${t.kind}" data-id="${esc(t.id)}" aria-label="${esc(tip)}"`;
    let body;
    if (t.kind === 'standee') {
      body = `<circle class="tok badge badge-${esc(t.state)}" cx="${cx}" cy="${cy}" r="${r}"/><text class="count" x="${cx}" y="${cy + 3.5}" text-anchor="middle">${t.count}</text>`;
    } else {
      const m = E.Engine.monogram(state, t.id);
      const p = t.kind === 'character' ? E.Engine.portrait(state, t.id) : {};
      const url = p.path && portraitUrl(p.path);
      const clip = `clip-${t.id.replace(/[^a-z0-9_-]/gi, '')}`;
      body = url && !failedUrls.has(url)
        ? `<clipPath id="${clip}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath><circle class="tok" cx="${cx}" cy="${cy}" r="${r}" style="fill:hsl(${m.hue} 38% 32%)"/><image href="${esc(url)}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>`
        : `<circle class="tok" cx="${cx}" cy="${cy}" r="${t.kind === 'extra' ? r - 2 : r}" style="fill:hsl(${m.hue} 38% 32%)"/><text x="${cx}" y="${cy + 3}" text-anchor="middle">${esc(m.monogram)}</text>`;
      if (t.player) body += `<circle class="ring" cx="${cx}" cy="${cy}" r="${r + 2.5}"/>`;
    }
    return `<g ${attrs}><title>${esc(tip)}</title>${body}</g>`;
  }
  // Tokens spread around a room's box, each keeping its spot (the same
  // placement as the detailed map); the rest as "+N".
  function roomTokens(list, x, y, w, h, id) {
    return E.SiteDraw.tokensIn(list, { x, y, w, h }, [], id || '', tokenSvg);
  }
  function linkMark(k) {
    const len = 0.9 * CELL, x = k.x * CELL, y = k.y * CELL;
    const v = k.orient === 'v';
    const gap = v ? `<rect class="map-gap" x="${x - 2}" y="${y - len / 2}" width="4" height="${len}"/>` : `<rect class="map-gap" x="${x - len / 2}" y="${y - 2}" width="${len}" height="4"/>`;
    const leaf = v ? `<line class="map-door" x1="${x}" y1="${y - len / 2}" x2="${x + len * 0.6}" y2="${y - len / 2 + 4}"/>` : `<line class="map-door" x1="${x - len / 2}" y1="${y}" x2="${x - len / 2 + 4}" y2="${y + len * 0.6}"/>`;
    switch (k.kind) {
      case 'door': return gap + leaf;
      case 'locked door': return gap + leaf + `<rect class="map-lock" x="${x - 3}" y="${y - 3}" width="6" height="6"/>`;
      case 'vent': case 'hatch': return v ? `<rect class="map-vent" x="${x - 3}" y="${y - 6}" width="6" height="12"/>` : `<rect class="map-vent" x="${x - 6}" y="${y - 3}" width="12" height="6"/>`;
      case 'window': return gap + (v ? `<line class="map-window" x1="${x - 2}" y1="${y - len / 2}" x2="${x - 2}" y2="${y + len / 2}"/><line class="map-window" x1="${x + 2}" y1="${y - len / 2}" x2="${x + 2}" y2="${y + len / 2}"/>`
        : `<line class="map-window" x1="${x - len / 2}" y1="${y - 2}" x2="${x + len / 2}" y2="${y - 2}"/><line class="map-window" x1="${x - len / 2}" y1="${y + 2}" x2="${x + len / 2}" y2="${y + 2}"/>`);
      case 'stairs': return gap + [-4, 0, 4].map((d) => (v ? `<line class="map-door" x1="${x - 4}" y1="${y + d}" x2="${x + 4}" y2="${y + d}"/>` : `<line class="map-door" x1="${x + d}" y1="${y - 4}" x2="${x + d}" y2="${y + 4}"/>`)).join('');
      default: return gap;
    }
  }
  // The detailed map's inputs (task 3-7), so what the player knows is decided
  // here: rooms in view (full detail, feature state), remembered rooms (no
  // state), the rest unknown. A door out of sight is drawn as a plain door,
  // since it may have changed since.
  function detailedMapSvg(here, tokens) {
    const plan = mapPlan();
    const inView = E.Engine.visibleRooms(state).filter((id) => plan.rooms[id]);
    const remembered = Object.keys(plan.rooms).filter((id) => !inView.includes(id) && state.seenRooms.includes(id));
    const rooms = {};
    Object.keys(plan.rooms).forEach((id) => {
      const l = state.locations[id];
      const feats = E.Engine.features(state, id);
      rooms[id] = { name: l.name, outside: !!l.outside, features: inView.includes(id) ? feats : feats.map((f) => ({ name: f.name, state: null, inferred: f.inferred })) };
    });
    const links = {};
    plan.links.forEach((k) => {
      const live = inView.includes(k.a) || inView.includes(k.b);
      links[[k.a, k.b].sort().join('|')] = live ? E.Engine.linkShown(state, k.a, k.b) || k.kind : k.kind === 'locked door' ? 'door' : k.kind;
    });
    const sc = state.scenario;
    const site = E.Sites.playerSite(state);
    return E.SiteDraw.render(plan, rooms, { inView, remembered, here, seed: `${sc.worldId}:${site === E.Sites.HOME ? sc.startId : site}`, links, tokens, tokenSvg, fit: true });
  }
  // A place built from a site map drawn on an image (task 6-3): what the
  // player knows is decided here, as for the detailed map; doors out of
  // sight as last seen (a locked one just a door).
  function imageMapSvg(site, m, here, tokens) {
    const ids = E.Sites.rooms(state, site).map((l) => l.id);
    const inView = E.Engine.visibleRooms(state).filter((id) => ids.includes(id));
    const remembered = ids.filter((id) => !inView.includes(id) && state.seenRooms.includes(id));
    const rooms = {};
    ids.forEach((id) => { const l = state.locations[id]; if (l.shape) rooms[id] = { name: l.name, shape: l.shape, outside: !!l.outside }; });
    const links = [];
    const seen = new Set();
    ids.forEach((a) => {
      const l = state.locations[a];
      const ways = (l.links || []).filter((k) => k.kind !== 'trip').map((k) => ({ to: k.to, kind: k.kind, at: k.at })).concat((l.connects || []).map((to) => ({ to, kind: 'open' })));
      ways.forEach((k) => {
        const key = [a, k.to].sort().join('|');
        if (!ids.includes(k.to) || seen.has(key)) return;
        seen.add(key);
        const live = inView.includes(a) || inView.includes(k.to);
        links.push({ a, b: k.to, at: k.at, kind: live ? E.Engine.linkShown(state, a, k.to) || k.kind : k.kind === 'locked door' ? 'door' : k.kind });
      });
    });
    return E.SiteDraw.renderImage({ url: siteMapUrl(m), width: m.width, height: m.height }, rooms, { inView, remembered, here, links, tokens, tokenSvg, seed: site });
  }
  // Decoration drops out when the map is drawn small (task 3-7).
  function sizeDetailedMap() {
    const svg = document.querySelector('#mapPane svg.sd');
    if (!svg) return;
    const vb = svg.viewBox.baseVal;
    const w = svg.getBoundingClientRect().width;
    svg.classList.toggle('sd-small', !!(vb && vb.width && w && w / vb.width < 0.85));
  }
  try { new ResizeObserver(sizeDetailedMap).observe($('mapPane')); } catch (e) {}
  const KIND_WORD = { open: 'way', door: 'door', 'locked door': 'locked door', vent: 'vent', hatch: 'hatch', window: 'window', stairs: 'stairs' };
  // Region routes as travel buttons (R-3): an icon and the words the engine
  // reads as setting out ("I drive to Ridge.").
  const TRAVEL = {
    border: ['🚶', 'I go to'], checkpoint: ['🛂', 'I go to'], road: ['🚗', 'I drive to'], rail: ['🚆', 'I take the train to'],
    sea: ['⛵', 'I sail to'], air: ['✈️', 'I fly to'], hyperlane: ['🚀', 'I travel to'], portal: ['🌀', 'I travel to'],
  };
  // The routes out of the player's region that can lead somewhere: the world
  // builds places, or the story already has a room or place there.
  function travelRoutes() {
    const from = E.Engine.playerRegion(state);
    if (!from) return [];
    const sc = state.scenario;
    const somewhere = (id) => E.Sites.enabled(sc) || Object.values(state.locations).some((l) => l.region && E.Engine.regionChain(state, l.region).includes(id))
      || Object.values(state.sites || {}).some((s) => s.region && E.Engine.regionChain(state, s.region).includes(id));
    return E.Engine.routesFrom(state, from).filter((r) => somewhere(r.to)).map((r) => {
      const [icon, verb] = TRAVEL[r.kind] || ['🧭', 'I travel to'];
      const name = regionName(r.to);
      const time = E.Scenario.sayHours(r.hours);
      return { to: r.to, name, icon, time, closed: r.closed, risky: r.risky, say: `${verb} ${name}.`,
        title: `${r.kind}${time ? `, ${time}` : ''}${r.closed ? `; closed: ${r.closed}${r.risky ? ' (you could risk it)' : ''}` : r.risky ? '; risky' : ''}` };
    });
  }
  // Waiting on the road (R-2): where the journey stopped, and the way on or back.
  function travelCardHtml(here) {
    const l = state.locations[here];
    const [on, back] = l.connects || [];
    const btn = (to, say, icon) => (state.locations[to] ? `<button type="button" class="small map-route" data-say="${esc(say)}">${icon} ${esc(say.replace(/^I go /, '').replace(/\.$/, ''))}</button>` : '');
    return `<div class="travel-card"><p><b>${esc(l.name)}</b>${l.region ? `, in ${esc(regionName(l.region))}` : ''}.</p><p>${esc(l.desc || '')}</p><div class="map-routes">` +
      btn(on, `I go on to ${state.locations[on] ? state.locations[on].name : ''}.`, '↗') + ' ' + btn(back, `I go back to ${state.locations[back] ? state.locations[back].name : ''}.`, '↩') +
      `</div></div><ul class="sr-only" id="mapList"><li>${esc(l.name)} (you are here)</li></ul>`;
  }
  // Ways to other places: trips to places made during the story (task
  // 4-4), then the routes out of this region (R-3) with kind and time.
  // Clicking one fills in the action box; the engine decides the rest.
  function waysHtml(site) {
    const routes = E.Sites.trips(state, site);
    const regionRoutes = travelRoutes();
    if (!routes.length && !regionRoutes.length) return '';
    return `<div class="map-routes">Ways to other places: ${routes.map((r) => `<button type="button" class="small map-route" data-name="${esc(r.name)}" title="From ${esc(state.locations[r.from].name)}">↗ ${esc(r.name)}</button>`).join(' ')}` +
      regionRoutes.map((r) => `<button type="button" class="small map-route" data-say="${esc(r.say)}"${r.closed && !r.risky ? ' disabled' : ''} title="${esc(r.title)}">${r.icon} ${esc(r.name)}${r.time ? ` · ${esc(r.time)}` : ''}${r.closed ? (r.risky ? ' ⚠' : ' (closed)') : ''}</button>`).join(' ') + '</div>';
  }
  // The places the player knows on a region level (R-8): pins with the
  // time to get there; clicking one fills in the action box.
  function placePinsHtml(levelId) {
    const pins = E.Sites.regularPlaces(state, levelId);
    if (!pins.length) return '';
    return `<div class="map-routes map-places">Places: ${pins.map((p) => {
      const time = p.here ? 'you are here' : p.hours ? E.Scenario.sayHours(p.hours) : p.hours === 0 ? 'nearby' : '';
      return `<button type="button" class="small map-route" data-say="${esc(`I go to ${p.name}.`)}"${p.here ? ' disabled' : ''} title="${esc(`${p.name}, in ${regionName(p.region)}${p.visited ? '' : ' (not visited yet)'}`)}">📌 ${esc(p.name)}${time ? ` · ${esc(time)}` : ''}</button>`;
    }).join(' ')}</div>`;
  }
  // A flavour place (R-8): a scene card, the room you're in, the others by
  // name, who is here, and the floor plan a toggle away.
  const floorPlans = new Set(); // sites whose floor plan was asked for
  function sceneCardHtml(site, here, tokens) {
    const l = state.locations[here];
    const s = (state.sites || {})[site];
    const others = E.Sites.rooms(state, site).filter((r) => r.id !== here && state.seenRooms.includes(r.id));
    const who = (tokens[here] || []).filter((t) => !t.player && t.now).map((t) => (t.kind === 'standee' ? `${t.count} ${t.label}` : t.label));
    const feats = E.Engine.features(state, here).map((f) => f.name + (f.state ? ` (${f.state})` : ''));
    return `<div class="travel-card scene-card"><p><b>${esc(s && s.name !== l.name ? `${s.name}: ${l.name}` : l.name)}</b>${l.region ? `, in ${esc(regionName(l.region))}` : ''}.</p><p>${esc(l.desc || '')}</p>` +
      (feats.length ? `<p class="muted">${esc(feats.join(' · '))}</p>` : '') +
      `<p class="muted">${who.length ? `Here: ${esc(who.join(', '))}.` : 'No one else you know of here.'}</p>` +
      (others.length ? `<div class="map-routes">${others.map((r) => `<button type="button" class="small map-route" data-say="${esc(`I go to the ${r.name}.`)}">↗ ${esc(r.name)}</button>`).join(' ')}</div>` : '') +
      `<button type="button" class="small" data-floorplan="${esc(site)}">Show the floor plan</button></div>` + waysHtml(site) +
      `<ul class="sr-only" id="mapList"><li>${esc(l.name)} (you are here): ${esc(who.join(', ') || 'no one you know of')}</li></ul>`;
  }
  function localMapHtml() {
    const here = state.characters[state.player].status.location;
    const tokens = mapTokens();
    const seen = (id) => state.seenRooms.includes(id);
    const roomName = (id) => (seen(id) ? state.locations[id].name : 'unknown room');
    const site = E.Sites.playerSite(state);
    const lm = site === E.Sites.HOME ? state.scenario.localMap : null;
    const im = site !== E.Sites.HOME ? E.Sites.imageMap(state, site) : null;
    let svg;
    // Stopped on a journey (R-2): no floor plan, just the way on and back.
    if (state.locations[here].transit) return travelCardHtml(here);
    // A flavour place (R-8) is a scene card until the player asks for the plan.
    if (!im && !lm && !E.Sites.tactical(state, site) && !floorPlans.has(site)) return sceneCardHtml(site, here, tokens);
    if (im) svg = imageMapSvg(site, im, here, tokens);
    else if (lm) {
      const url = portraitUrl(lm.image);
      const rooms = Object.entries(lm.rooms).map(([id, r]) => `<g class="map-room${id === here ? ' here' : ''}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(roomName(id))}"><rect class="floor" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" style="fill-opacity:0.15"/>${roomTokens(tokens[id] || [], r.x, r.y, r.w, r.h, id)}</g>`).join('');
      svg = `<svg class="map-svg" viewBox="0 0 ${lm.width} ${lm.height}" role="img" aria-label="Map">${url ? `<image href="${esc(url)}" x="0" y="0" width="${lm.width}" height="${lm.height}"/>` : ''}${rooms}</svg>`;
    } else if ((mapDetailPreview || E.settings.appearance.mapDetail) !== 'simple') {
      svg = detailedMapSvg(here, tokens);
    } else {
      const plan = mapPlan();
      const W = plan.width * CELL, H = plan.height * CELL;
      const levels = plan.levels.length > 1 ? plan.levels.map((b) => `<text class="map-level" x="${b.x * CELL}" y="${b.y * CELL - 9}">${b.level === 0 ? 'ground floor' : b.level > 0 ? `level ${b.level}` : `below ${-b.level}`}</text>`).join('') : '';
      const rooms = Object.entries(plan.rooms).map(([id, r]) => {
        const l = state.locations[id];
        const x = r.x * CELL, y = r.y * CELL, w = r.w * CELL, h = r.h * CELL;
        const cls = `map-room${l.outside ? ' outside' : ''}${id === here ? ' here' : ''}${seen(id) ? '' : ' unseen'}`;
        const label = seen(id) ? `<text class="map-label" x="${x + 5}" y="${y + 13}">${esc(E.shorten(l.name, Math.floor((w - 8) / 6.5)))}</text>` : `<text class="map-feat" x="${x + w / 2}" y="${y + h / 2 + 3}" text-anchor="middle">?</text>`;
        const fl = E.Engine.features(state, id).map((f) => f.name + (f.state ? ` (${f.state})` : ''));
        const feats = seen(id) && fl.length ? `<text class="map-feat" x="${x + 5}" y="${y + h - 5}">${esc(E.shorten(fl.join(' · '), Math.floor(w / 5)))}</text>` : '';
        // Ways to another level: a note in the room.
        const up = plan.links.filter((k) => k.remote && (k.a === id || k.b === id) && plan.rooms[k.a].level !== plan.rooms[k.b].level)
          .map((k) => { const o = k.a === id ? k.b : k.a; return `${KIND_WORD[k.kind]} to ${roomName(o)}`; });
        const upText = up.length ? `<text class="map-feat" x="${x + 5}" y="${y + h - (feats ? 16 : 5)}">↕ ${esc(E.shorten(up.join(', '), Math.floor((w - 8) / 5)))}</text>` : '';
        const toks = roomTokens(tokens[id] || [], x, y + 18, w, h - (up.length ? 42 : 30), id);
        return `<g class="${cls}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(roomName(id))}">${(r.extra || []).map((e) => `<rect class="floor" x="${e.x * CELL}" y="${e.y * CELL}" width="${e.w * CELL}" height="${e.h * CELL}" rx="2"/>`).join('')}<rect class="floor" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>${label}${upText}${feats}</g><g class="map-tokens">${toks}</g>`;
      }).join('');
      const remote = plan.links.filter((k) => k.remote && plan.rooms[k.a].level === plan.rooms[k.b].level).map((k) => {
        const a = plan.rooms[k.a], b = plan.rooms[k.b];
        return `<line class="map-remote" x1="${(a.x + a.w / 2) * CELL}" y1="${(a.y + a.h / 2) * CELL}" x2="${(b.x + b.w / 2) * CELL}" y2="${(b.y + b.h / 2) * CELL}"/>`;
      }).join('');
      // Doors as they are now: unlocked, open or shut (task 3-6).
      const marks = plan.links.filter((k) => !k.remote).map((k) => linkMark(Object.assign({}, k, { kind: E.Engine.linkShown(state, k.a, k.b) || k.kind }))).join('');
      // Never smaller than about three quarters of full size (the pane scrolls).
      svg = `<svg class="map-svg" viewBox="-4 -4 ${W + 8} ${H + 8}" style="min-width:${Math.round(W * 0.75)}px" role="img" aria-label="Map">${remote}${rooms}${marks}${levels}</svg>`;
    }
    // Zoom and pan on the floor plan (task 7-2: the school is 28 rooms): it
    // fits the pane, and its view is kept per place until reset.
    const key = `site:${site}`;
    const full = (/viewBox="([^"]*)"/.exec(svg) || [])[1] || '';
    svg = svg.replace('<svg ', `<svg id="siteSvg" data-view="${esc(key)}" data-full="${esc(full)}" `);
    if (viewBoxes[key]) svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBoxes[key].map((n) => Math.round(n)).join(' ')}"`);
    if (floorPlans.has(site) && !im && !lm && !E.Sites.tactical(state, site)) svg += `<button type="button" class="small" data-scenecard="${esc(site)}">Show the scene card</button>`;
    svg += waysHtml(site);
    // The same in words, for screen readers.
    const list = Object.keys(state.locations).filter((id) => seen(id) && E.Sites.siteOf(state, id) === site).map((id) => {
      const who = (tokens[id] || []).map((t) => (t.player ? 'you' : t.kind === 'standee' ? `${t.count} ${t.label}` : t.label) + (t.now ? '' : ' (last seen)'));
      return `<li>${esc(state.locations[id].name)}${id === here ? ' (you are here)' : ''}: ${esc(who.join(', ') || 'no one you know of')}</li>`;
    }).join('');
    return svg + `<ul class="sr-only" id="mapList">${list}</ul>`;
  }

  // ---------- the zooming map (task 3-4; one map through the tree, R-3) ----------
  // A breadcrumb from the world down to the player's room: each level is a
  // region (MapDraw.level: its picture, zoomed, or a node map of its
  // children), and the bottom is the local map. Regions are coloured by who
  // holds them (theme colours --f1…--f8), with tag badges, your region and
  // your branch marked, and an info strip for the region you pick. Public
  // state only: controller, tags, status and the lore summary. Clicking a
  // region with regions inside it zooms in; any other picks it. Drag to pan;
  // wheel, pinch or the buttons to zoom.
  const MAPVIEW_KEY = 'ensemble.mapview';
  let mapSel = null; // the region picked for the info strip
  let curLevel = null; // the level drawn last (MapDraw.level)
  const viewBoxes = {}; // per level: the panned/zoomed viewBox, until reset or a new game
  const pulsed = new Set(); // "id@turn": a change pulses once
  function mapViewAll() { try { return JSON.parse(store.get(MAPVIEW_KEY)) || {}; } catch (e) { return {}; } }
  const hasRegions = () => !!(state && (state.scenario.regions || []).length);
  // The level shown: "local", "root" (the world) or a region id. Saved
  // before R-3: "world" is the root, "region" the player's region.
  function mapView() {
    if (!hasRegions()) return 'local';
    const v = mapViewAll()[state.scenario.worldId];
    if (v === 'world') return 'root';
    if (v === 'region') return E.Engine.playerRegion(state) || 'root';
    if (v === 'root' || v === 'local' || (v && E.Engine.regionDef(state, v) && E.Engine.regionKnown(state, v))) return v;
    // Nothing picked yet: a region-focused world (R-8) opens at the player's
    // region, unless they are in a tactical place (task 7-4: a town's drawn
    // plan), which opens on its floor plan.
    const region = E.Sites.mapFocus(state.scenario) === 'region' && E.Engine.playerRegion(state);
    return region && !E.Sites.tactical(state, E.Sites.playerSite(state)) ? region : 'local';
  }
  function setMapView(v) {
    const all = mapViewAll();
    all[state.scenario.worldId] = v;
    store.set(MAPVIEW_KEY, JSON.stringify(all));
    mapSel = null;
    renderMap();
  }
  const factionClass = (fid) => E.MapDraw.factionClass(state.factions, fid);
  const regionName = (id) => (id && E.Engine.regionDef(state, id) ? E.Engine.regionDef(state, id).name : id);
  // Connections on a node map that are closed now: every route behind one
  // (between the regions shown, or regions inside them) needs something
  // that doesn't hold. As "a|b" keys.
  function closedEdges(lv) {
    const tally = new Map();
    (state.scenario.regions || []).forEach((r) => E.Engine.routesFrom(state, r.id).forEach((x) => {
      const a = lv.liftTo(r.id), b = lv.liftTo(x.to);
      if (!a || !b || a === b) return;
      const key = [a, b].sort().join('|');
      const t = tally.get(key) || { open: 0, closed: 0 };
      t[x.closed ? 'closed' : 'open']++;
      tally.set(key, t);
    }));
    return new Set([...tally].filter(([, t]) => t.closed && !t.open).map(([k]) => k));
  }
  function levelHtml(levelId) {
    const sc = state.scenario;
    // Regions the player doesn't know of are left out (R-5); contested ones marked.
    const hidden = E.Engine.hiddenRegions(state);
    const lv = curLevel = E.MapDraw.level(sc, levelId, { hidden });
    const contested = lv.regions.map((r) => r.id).filter((id) => E.Engine.presenceIn(state, id).contested);
    const mine = E.Engine.playerRegion(state);
    const branch = mine ? E.Engine.regionChain(state, mine) : [];
    // A region changed this turn pulses once.
    const pulse = (sc.regions || []).filter((r) => {
      const ch = (state.regionChanged || {})[r.id];
      const key = `${r.id}@${state.turn}`;
      if (!ch || ch.turn !== state.turn || pulsed.has(key)) return false;
      pulsed.add(key);
      return true;
    }).map((r) => r.id);
    // Rooms placed on the picture, at a leaf (as the regional view had them).
    const rooms = lv.leaf ? lv.rooms.filter((p) => state.locations[p.id] && state.seenRooms.includes(p.id)).map((p) => ({ x: p.x, y: p.y, name: state.locations[p.id].name })) : [];
    const key = levelId == null ? 'root' : levelId;
    // The pin stands on the player's room when the picture places it.
    const where = state.characters[state.player].status.location;
    const placed = lv.rooms.find((p) => p.id === where);
    return E.MapDraw.worldSvg({
      g: lv.g, regions: lv.regions, now: state.regions, factions: state.factions, mine, branch, selected: mapSel, pulse, rooms, contested,
      here: placed ? { x: placed.x, y: placed.y } : null,
      places: lv.picture ? E.MapDraw.placesOf(lv.picture) : [], dim: lv.dim, closed: lv.picture ? null : closedEdges(lv),

      zoomable: lv.children.filter((id) => E.MapDraw.hasLevel(sc, id, hidden)),
      imageUrl: lv.picture && portraitUrl(lv.picture.image), viewBox: viewBoxes[key] || lv.viewBox, id: 'worldSvg', view: key,
      label: levelId == null ? 'World map' : `Map of ${regionName(levelId)}`,
    }) + regionInfoHtml(lv) + (E.Sites.mapFocus(sc) === 'region' ? regionMoveHtml(levelId) : '');
  }
  // A region-focused world (R-8) moves at the region level: the places you
  // know as pins, and, on your own branch, the ways out.
  function regionMoveHtml(levelId) {
    const mine = E.Engine.playerRegion(state);
    const onBranch = mine && (levelId == null || E.Engine.regionChain(state, mine).includes(levelId));
    return placePinsHtml(levelId) + (onBranch ? waysHtml(E.Sites.playerSite(state)) : '');
  }
  function regionInfoHtml(lv) {
    const id = mapSel || (lv.id != null ? lv.id : E.Engine.playerRegion(state));
    const r = id && E.Engine.regionDef(state, id);
    if (!r) return '<div class="region-info muted">Pick a region to see who holds it.</div>';
    const now = state.regions[id];
    const ch = (state.regionChanged || {})[id];
    const fc = factionClass(now.controller);
    // Where it sits in the tree (R-1): the regions it is inside, each a level to go to.
    const up = E.Engine.regionChain(state, id).slice(1);
    const label = E.Scenario.regionLabel(state.scenario, id);
    const inWords = up.length ? ` in ${up.map((x) => `<button type="button" class="linkish" data-maplevel="${esc(x)}">${esc(regionName(x))}</button>`).join(' › ')}` : '';
    const zoom = id !== lv.id ? ` <button type="button" class="small" data-maplevel="${esc(id)}">Zoom in ›</button>` : '';
    const bits = [`<b>${esc(r.name)}</b>${label ? `, ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${esc(label)}` : ''}${inWords}${id === E.Engine.playerRegion(state) ? ' (you are here)' : ''}${zoom}`,
      `<span class="swatch ${fc}"></span>held by ${esc(E.Engine.regionHolder(state, id).text)}`];
    if (now.status) bits.push(esc(now.status));
    if (now.tags.length) bits.push(`tags: ${esc(now.tags.join(', '))}`);
    // Who else is there (R-5).
    const present = E.Engine.presenceText(state, id);
    if (present) bits.push(`present: ${esc(present)}`);
    let html = `<div class="region-info" id="regionInfo">${bits.join(' · ')}`;
    if (ch && ch.turn === state.turn) html += `<div class="changed">This turn: ${esc(ch.what.join(', '))}.</div>`;
    if (r.lore) html += `<div class="muted">${esc(r.lore)}</div>`;
    if (lv.leaf && id === E.Engine.playerRegion(state)) {
      const placed = new Set(lv.rooms.map((p) => p.id));
      const rest = Object.values(state.locations).filter((l) => l.region === id && !l.site && !placed.has(l.id) && state.seenRooms.includes(l.id)).map((l) => l.name);
      if (rest.length) html += `<div class="muted">Rooms here: ${esc(rest.join(', '))}</div>`;
    }
    // Places made during the story (task 4-4), in this region.
    const places = Object.values(state.sites || {}).filter((s) => s.region === id);
    if (places.length) html += `<div class="muted">Places: ${places.map((s) => esc(s.name) + (s.stub ? (s.visits ? ' (been there)' : ' (not visited yet)') : '')).join(', ')}</div>`;
    return html + '</div>';
  }
  // The breadcrumb: the world, the regions down to the level shown, and (at
  // the bottom) the room the player is in. "Where I am" and "Whole world" jump.
  function mapBarHtml(view) {
    const sc = state.scenario;
    const here = state.characters[state.player].status.location;
    const levelId = view === 'local' ? E.Engine.playerRegion(state) : view === 'root' ? null : view;
    const path = E.MapDraw.levelPath(sc, levelId).map((id) => ({ key: id == null ? 'root' : id, name: id == null ? (sc.worldTitle || sc.title) : regionName(id) }));
    if (view === 'local') path.push({ key: 'local', name: state.locations[here] ? state.locations[here].name : 'Here' });
    const crumbs = path.map((c, i) => `${i ? '<span class="sep" aria-hidden="true">›</span>' : ''}<button type="button" data-maplevel="${esc(c.key)}"${i === path.length - 1 ? ' aria-current="true"' : ''}>${esc(c.name)}</button>`).join('');
    const zoom = `<span class="zoom"><button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button><button type="button" data-zoom="reset" aria-label="Reset the view" title="Reset the view">⟲</button></span>`;
    return `<div class="map-bar"><nav class="map-crumbs" aria-label="Map levels">${crumbs}</nav>${zoom}<span class="jumps"><button type="button" data-maplevel="local" title="Where I am">📍 Where I am</button><button type="button" data-maplevel="root" title="The whole world">🌍 Whole world</button></span></div>`;
  }
  function renderMap() {
    const pane = $('mapPane');
    if (!state) { pane.innerHTML = ''; return; }
    const view = mapView();
    pane.innerHTML = (hasRegions() ? mapBarHtml(view) : '') + (view === 'local' ? localMapHtml() : levelHtml(view === 'root' ? null : view));
    sizeDetailedMap();
  }
  // Zoom the map's viewBox around a point (in map units), within limits: the
  // world map, or a place's floor plan (task 7-2).
  const mapSvg = () => $('worldSvg') || $('siteSvg');
  function zoomWorld(factor, cx, cy) {
    const svg = mapSvg();
    if (!svg) return;
    const view = svg.dataset.view;
    const site = svg.id === 'siteSvg';
    const [x, y, w, h] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    const full = site ? svg.dataset.full.split(/\s+/).map(Number) : curLevel ? curLevel.g.full : [0, 0, 800, 560];
    const nw = Math.min(full[2] * (site ? 1 : 2), Math.max(full[2] / 8, w * factor)), nh = h * (nw / w);
    const px = cx == null ? x + w / 2 : cx, py = cy == null ? y + h / 2 : cy;
    viewBoxes[view] = [px - (px - x) * (nw / w), py - (py - y) * (nh / h), nw, nh];
    svg.setAttribute('viewBox', viewBoxes[view].map((n) => Math.round(n)).join(' '));
    if (site) return sizeDetailedMap();
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(redrawZoomed, 150);
  }
  // Once a zoom settles, the map is drawn again for the new view: the detail
  // that fits it (MapDraw.detailShown) and labels sized for it. The picture
  // stays as it is, so it doesn't flicker.
  let zoomTimer = null;
  function redrawZoomed() {
    const svg = $('worldSvg');
    if (!svg || !state) return;
    if (drag) { zoomTimer = setTimeout(redrawZoomed, 150); return; }
    const view = svg.dataset.view;
    const t = document.createElement('template');
    t.innerHTML = levelHtml(view === 'root' ? null : view);
    const fresh = t.content.querySelector('#worldSvg');
    if (!fresh) return;
    const keep = (c) => c.tagName.toLowerCase() === 'image';
    [...svg.children].forEach((c) => { if (!keep(c)) c.remove(); });
    [...fresh.children].forEach((c) => { if (!keep(c)) svg.appendChild(c); });
  }
  const toMap = (svg, ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
  };
  const pointers = new Map();
  let drag = null;
  let draggedAt = 0; // a pan never counts as a click on a room
  $('mapPane').addEventListener('pointerdown', (ev) => {
    const svg = ev.target.closest && ev.target.closest('#worldSvg, #siteSvg');
    if (!svg) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    drag = { svg, moved: false, start: { x: ev.clientX, y: ev.clientY }, vb: svg.getAttribute('viewBox').split(/\s+/).map(Number), dist: null };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag.dist = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  $('mapPane').addEventListener('pointermove', (ev) => {
    const svg = drag && drag.svg;
    if (!svg || !drag || !pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const rect = svg.getBoundingClientRect();
    if (pointers.size === 2 && drag.dist) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.abs(d - drag.dist) > 4) { zoomWorld(drag.dist / d); drag.dist = d; drag.moved = true; }
      return;
    }
    const dx = ev.clientX - drag.start.x, dy = ev.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; try { svg.setPointerCapture(ev.pointerId); } catch (e) {} }
    svg.classList.add('panning');
    const [x, y, w, h] = drag.vb;
    viewBoxes[svg.dataset.view] = [x - dx * (w / rect.width), y - dy * (h / rect.height), w, h];
    svg.setAttribute('viewBox', viewBoxes[svg.dataset.view].map((n) => Math.round(n)).join(' '));
  });
  const endDrag = (ev) => {
    pointers.delete(ev.pointerId);
    const svg = drag && drag.svg;
    if (svg) svg.classList.remove('panning');
    const wasDrag = drag && drag.moved;
    if (wasDrag) draggedAt = Date.now();
    if (!pointers.size) drag = null;
    if (ev.type === 'pointerup' && !wasDrag && ev.target.closest) {
      const g = ev.target.closest('.region-g');
      if (g) pickRegion(g.dataset.region, !!g.dataset.zoomable);
    }
  };
  // A region on the map: one with regions inside it zooms in (R-3); any
  // other is picked for the info strip.
  function pickRegion(id, zoomable) {
    if (zoomable) return setMapView(id);
    mapSel = id;
    renderMap();
  }

  $('mapPane').addEventListener('pointerup', endDrag);
  $('mapPane').addEventListener('pointercancel', endDrag);
  $('mapPane').addEventListener('wheel', (ev) => {
    const svg = ev.target.closest && ev.target.closest('#worldSvg, #siteSvg');
    if (!svg) return;
    ev.preventDefault();
    const p = toMap(svg, ev);
    zoomWorld(ev.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  }, { passive: false });
  $('mapPane').addEventListener('click', (ev) => {
    const lvl = ev.target.closest('[data-maplevel]');
    if (lvl && state) return setMapView(lvl.dataset.maplevel);
    const z = ev.target.closest('[data-zoom]');
    if (z) {
      if (z.dataset.zoom === 'reset') { const s = mapSvg(); delete viewBoxes[s && s.id === 'siteSvg' ? s.dataset.view : mapView()]; return renderMap(); }
      zoomWorld(z.dataset.zoom === 'in' ? 1 / 1.4 : 1.4);
    }
  });
  // Clicking fills in the action box (never acts).
  function fillAction(text) {
    const box = $('actionInput');
    box.value = box.value.trim() ? `${box.value.trim()} ${text}` : text;
    box.focus();
  }
  function mapActivate(el) {
    if (!state || !el) return;
    const tok = el.closest('.map-token');
    if (tok) {
      const id = tok.dataset.id;
      if (id === state.player) return;
      if (tok.dataset.kind === 'standee') return fillAction(`Watch the ${state.standees[id] ? state.standees[id].label : id}.`);
      const who = tok.dataset.kind === 'extra' ? state.extras[id] : state.characters[id];
      return fillAction(`Talk to ${who ? (tok.dataset.kind === 'extra' ? who.name : E.Engine.shortName(who)) : id}.`);
    }
    const plan = el.closest('[data-floorplan],[data-scenecard]');
    if (plan) {
      if (plan.dataset.floorplan != null) floorPlans.add(plan.dataset.floorplan); else floorPlans.delete(plan.dataset.scenecard);
      return renderMap();
    }
    const route = el.closest('.map-route');
    if (route) return route.disabled ? null : fillAction(route.dataset.say || `Go to ${route.dataset.name}.`);
    // A gameplay piece on the detailed map (task 3-7); decoration has no data.
    const feat = el.closest('.map-feature');
    if (feat) return fillAction(`Look at ${/^(the|a|an|my|your|his|her|their|\w+'s)\b/i.test(feat.dataset.feature) ? '' : 'the '}${feat.dataset.feature}.`);
    const room = el.closest('.map-room');
    if (!room) return;
    const id = room.dataset.room;
    if (id === state.characters[state.player].status.location) return;
    fillAction(state.seenRooms.includes(id) ? `Go to the ${state.locations[id].name}.` : 'Find out what is through there.');
  }
  $('mapPane').addEventListener('click', (ev) => { if (Date.now() - draggedAt > 300) mapActivate(ev.target); });
  $('mapPane').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const reg = ev.target.closest && ev.target.closest('.region-g');
    if (reg) {
      ev.preventDefault();
      pickRegion(reg.dataset.region, !!reg.dataset.zoomable);
      const el = document.querySelector(`.region-g[data-region="${reg.dataset.region}"]`) || document.querySelector('.region-g');
      if (el) el.focus();
      return;
    }
    if (!ev.target.closest('.map-token, .map-room, .map-feature')) return;
    ev.preventDefault();
    mapActivate(ev.target);
  });
  // Text, split or map: per world on desktop; the phone button switches text and map.
  const VIEW_KEY = 'ensemble.view';
  function viewAll() { try { return JSON.parse(store.get(VIEW_KEY)) || {}; } catch (e) { return {}; } }
  function setView(mode, remember) {
    const story = $('story');
    story.classList.remove('view-text', 'view-split', 'view-map');
    story.classList.add('view-' + mode);
    document.querySelectorAll('.view-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === mode)));
    $('btnMapPhone').setAttribute('aria-pressed', String(mode === 'map'));
    if (remember && state) { const all = viewAll(); all[state.scenario.worldId] = mode; store.set(VIEW_KEY, JSON.stringify(all)); }
  }
  function restoreView() {
    setView((state && viewAll()[state.scenario.worldId]) || 'split', false);
    Object.keys(viewBoxes).forEach((k) => delete viewBoxes[k]);
    mapSel = null;
  }
  document.querySelectorAll('.view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view, true)));
  $('btnMapPhone').addEventListener('click', () => setView($('story').classList.contains('view-map') ? 'text' : 'map', false));
  setView('split', false);

  // A cast card is composed from one function per section, in renderCast. Each
  // section returns its markup, or '' to leave it out.
  // You, then the people with you, then other local characters; secondary
  // characters (task 2-1) in a collapsed "Elsewhere" list below.
  function renderCast() {
    $('castTitle').textContent = state.scenario.castLabel || 'People';
    const here = state.characters[state.player].status.location;
    const ids = E.Engine.cast(state);
    const card = (id) => {
      const c = state.characters[id];
      const isPlayer = id === state.player;
      const dead = c.status.health === 'dead';
      const min = isMinimized(id);
      const sections = min ? [cardMini(id, c, isPlayer)] : [cardHeader(id, c, isPlayer), cardStatus(c, isPlayer), cardDetails(id, c, dead)].filter(Boolean);
      return `<div class="card ${!isPlayer && c.status.location === here ? 'here' : ''} ${dead ? 'dead' : ''} ${min ? 'min' : ''}" data-id="${esc(id)}">${sections.join('')}</div>`;
    };
    const others = ids.filter((id) => id !== state.player);
    const withYou = others.filter((id) => state.characters[id].status.location === here);
    const local = others.filter((id) => !withYou.includes(id) && E.Engine.tier(state, id) === 'local');
    const away = others.filter((id) => !withYou.includes(id) && !local.includes(id));
    $('cast').innerHTML = [state.player].concat(withYou, local).map(card).join('') + (away.length
      ? `<details class="elsewhere"${elsewhereOpen() ? ' open' : ''}><summary>Elsewhere (${away.length})</summary>${away.map(card).join('')}</details>`
      : '');
    $('btnCollapseAll').textContent = ids.every(isMinimized) ? 'Expand all' : 'Collapse all';
  }
  // Whether the Elsewhere list is open, remembered per world.
  const ELSEWHERE_KEY = 'ensemble.cards.elsewhere';
  function elsewhereAll() {
    try { return JSON.parse(store.get(ELSEWHERE_KEY)) || {}; } catch (e) { return {}; }
  }
  const elsewhereOpen = () => !!elsewhereAll()[state.scenario.worldId];
  $('cast').addEventListener('toggle', (ev) => {
    if (!ev.target.matches || !ev.target.matches('details.elsewhere')) return;
    const all = elsewhereAll();
    all[state.scenario.worldId] = ev.target.open;
    store.set(ELSEWHERE_KEY, JSON.stringify(all));
  }, true);

  // ---------- portraits ----------
  // Paths in the scenario are relative to the world folder. Server worlds load
  // them from scenarios/<folder>/; worlds opened from disk use object URLs made
  // from the picked files. Neither URL is ever saved. A picture that fails to
  // load falls back to the monogram.
  const diskAssets = new Map(); // world folder -> { path: File }
  const assetUrls = new Map(); // "folder/path" -> object URL
  const portraitUrl = (path) => assetUrl(state.scenario.folder, path);
  // Site maps from the shared library (task 6-3) have their images there:
  // picked with Open folder (object URLs) or on the server.
  let libraryAssets = {};
  const siteMapUrl = (m) => {
    if (!m.library) return portraitUrl(m.image);
    const f = libraryAssets[m.image];
    if (f) { const key = 'library/' + m.image; if (!assetUrls.has(key)) assetUrls.set(key, URL.createObjectURL(f)); return assetUrls.get(key); }
    return location.protocol === 'file:' ? null : `library/${m.image.split('/').map(encodeURIComponent).join('/')}`;
  };
  function assetUrl(folder, path) {
    const files = diskAssets.get(folder);
    if (files && files[path]) {
      const key = folder + '/' + path;
      if (!assetUrls.has(key)) assetUrls.set(key, URL.createObjectURL(files[path]));
      return assetUrls.get(key);
    }
    return location.protocol === 'file:' ? null : `scenarios/${encodeURIComponent(folder)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  function monogramHtml(id) {
    const m = E.Engine.monogram(state, id);
    return `<span class="portrait monogram" aria-hidden="true" style="background:hsl(${m.hue} 38% 32%)">${esc(m.monogram)}</span>`;
  }
  const failedUrls = new Set(); // pictures that didn't load: monogram from then on, no flicker
  function portraitHtml(id) {
    const p = E.Engine.portrait(state, id);
    const url = p.path && portraitUrl(p.path);
    return url && !failedUrls.has(url) ? `<img class="portrait" src="${esc(url)}" alt="" data-fallback="${esc(id)}">` : monogramHtml(id);
  }
  // error doesn't bubble, so listen in the capture phase.
  const portraitFallback = (ev) => {
    const img = ev.target;
    if (img.tagName !== 'IMG' || !img.dataset.fallback) return;
    failedUrls.add(img.getAttribute('src'));
    img.outerHTML = monogramHtml(img.dataset.fallback);
  };
  $('cast').addEventListener('error', portraitFallback, true);
  $('termDialog').addEventListener('error', portraitFallback, true);

  // ---------- relationship web (task 2-4) ----------
  // E.Engine.relationWeb decides what the player may see; this only draws it:
  // an SVG with a small force layout (you fixed in the middle), two curves per
  // pair so A→B and B→A can differ, and a plain list for screen readers.
  const WEB = 360;
  function layoutWeb(nodes, edges) {
    const c = WEB / 2;
    const others = nodes.filter((n) => !n.isPlayer);
    const pos = {};
    nodes.forEach((n) => { pos[n.id] = { x: c, y: c }; });
    others.forEach((n, i) => {
      const a = (i / Math.max(1, others.length)) * 2 * Math.PI - Math.PI / 2;
      pos[n.id] = { x: c + Math.cos(a) * WEB * 0.34, y: c + Math.sin(a) * WEB * 0.34 };
    });
    const pairs = new Map();
    edges.forEach((e) => { const k = [e.from, e.to].sort().join('|'); pairs.set(k, Math.max(pairs.get(k) || 0, e.level)); });
    const k = WEB / Math.sqrt(nodes.length + 1);
    for (let it = 0; it < 220; it++) {
      const step = 6 * (1 - it / 220) + 0.3;
      const force = {};
      nodes.forEach((n) => { force[n.id] = { x: 0, y: 0 }; });
      nodes.forEach((a) => nodes.forEach((b) => {
        if (a === b) return;
        const dx = pos[a.id].x - pos[b.id].x, dy = pos[a.id].y - pos[b.id].y;
        const d = Math.max(1, Math.hypot(dx, dy));
        force[a.id].x += (dx / d) * (k * k) / d;
        force[a.id].y += (dy / d) * (k * k) / d;
      }));
      pairs.forEach((level, key) => {
        const [a, b] = key.split('|');
        const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const pull = (d * d) / k * (0.6 + level * 0.25);
        force[a].x -= (dx / d) * pull; force[a].y -= (dy / d) * pull;
        force[b].x += (dx / d) * pull; force[b].y += (dy / d) * pull;
      });
      others.forEach((n) => {
        const f = force[n.id];
        const m = Math.max(1, Math.hypot(f.x, f.y));
        pos[n.id].x = E.clamp(pos[n.id].x + (f.x / m) * step, 34, WEB - 34);
        pos[n.id].y = E.clamp(pos[n.id].y + (f.y / m) * step, 30, WEB - 40);
      });
    }
    return pos;
  }
  function webNode(n, p) {
    const pic = E.Engine.portrait(state, n.id);
    const url = pic.path && portraitUrl(pic.path);
    const r = 18;
    const face = url && !failedUrls.has(url)
      ? `<clipPath id="webclip-${esc(n.id)}"><circle cx="${p.x}" cy="${p.y}" r="${r}"/></clipPath><image href="${esc(url)}" x="${p.x - r}" y="${p.y - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#webclip-${esc(n.id)})" preserveAspectRatio="xMidYMid slice"/>`
      : ((m) => `<circle cx="${p.x}" cy="${p.y}" r="${r}" style="fill:hsl(${m.hue} 38% 32%)"/><text class="web-mono" x="${p.x}" y="${p.y}" dy="0.35em" text-anchor="middle">${esc(m.monogram)}</text>`)(E.Engine.monogram(state, n.id));
    const short = n.isPlayer ? 'You' : E.Engine.shortName(state.characters[n.id]);
    return `<g class="web-node${n.isPlayer ? ' you' : ''}" data-id="${esc(n.id)}"><title>${esc(state.characters[n.id].name)}${n.isPlayer ? ' (you)' : ''}</title>${face}` +
      `<circle class="web-ring" cx="${p.x}" cy="${p.y}" r="${r}"/><text class="web-label" x="${p.x}" y="${p.y + r + 12}" text-anchor="middle">${esc(short)}</text></g>`;
  }
  function webEdge(e, pos) {
    const a = pos[e.from], b = pos[e.to];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / d, uy = dy / d;
    // Bend to the left of the direction of travel, so the two ways of a pair part.
    const mx = (a.x + b.x) / 2 - uy * 16, my = (a.y + b.y) / 2 + ux * 16;
    const sx = a.x + ux * 20 - uy * 4, sy = a.y + uy * 20 + ux * 4;
    const ex = b.x - ux * 24 - uy * 4, ey = b.y - uy * 24 + ux * 4;
    const cls = e.sign > 0 ? 'pos' : e.sign < 0 ? 'neg' : 'neu';
    const nm = (id) => (id === state.player ? 'You' : state.characters[id].name);
    const title = `${nm(e.from)} → ${nm(e.to)}: ${e.word}${e.why ? ` (${e.source === 'seen' ? 'you know: ' : ''}${e.why})` : ''}`;
    return `<path class="web-edge ${cls}${e.source === 'seen' ? ' seen' : ''}" d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" style="stroke-width:${1 + e.level * 1.5}" marker-end="url(#web-arrow-${cls})"><title>${esc(title)}</title></path>`;
  }
  function renderWeb() {
    const web = E.Engine.relationWeb(state, { secondary: $('webSecondary').checked });
    const pos = layoutWeb(web.nodes, web.edges);
    const arrows = ['pos', 'neg', 'neu'].map((c) => `<marker id="web-arrow-${c}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="web-arrow ${c}" d="M0,0 L10,5 L0,10 z"/></marker>`).join('');
    $('webGraph').innerHTML = `<svg viewBox="0 0 ${WEB} ${WEB}" role="img" aria-label="Relationship web: ${web.nodes.length} people">` +
      `<defs>${arrows}</defs>${web.edges.map((e) => webEdge(e, pos)).join('')}${web.nodes.map((n) => webNode(n, pos[n.id])).join('')}</svg>`;
    const nm = (id) => (id === state.player ? 'You' : state.characters[id].name);
    const lines = web.edges.map((e) => `<li class="${e.source === 'seen' ? 'seen' : ''}">${esc(nm(e.from))} ${e.from === state.player ? 'feel' : 'feels'} <b class="rel-${e.word}">${e.word === 'trusts' ? 'trusting' : e.word}</b> toward ${esc(e.to === state.player ? 'you' : nm(e.to))}` +
      `${e.why ? ` <span class="muted">— ${e.source === 'seen' ? 'you know: ' : ''}${esc(e.why)}</span>` : ''}</li>`);
    $('webList').innerHTML = lines.join('') || '<li class="muted">No one else here yet.</li>';
  }
  $('btnWeb').addEventListener('click', () => {
    if (!state) return;
    renderWeb();
    $('webDialog').showModal();
  });
  $('webSecondary').addEventListener('change', () => { if (state) renderWeb(); });

  // ---------- minimized cards ----------
  // Remembered per world and character: { worldId: [ids] }.
  const MIN_KEY = 'ensemble.cards.min';
  function minimized() {
    try { return JSON.parse(store.get(MIN_KEY)) || {}; } catch (e) { return {}; }
  }
  function isMinimized(id) { return (minimized()[state.scenario.worldId] || []).includes(id); }
  function setMinimized(ids, on) {
    const all = minimized();
    const w = new Set(all[state.scenario.worldId] || []);
    ids.forEach((id) => (on ? w.add(id) : w.delete(id)));
    all[state.scenario.worldId] = [...w];
    store.set(MIN_KEY, JSON.stringify(all));
    renderCast();
  }
  $('cast').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-min]');
    if (btn) setMinimized([btn.dataset.min], !isMinimized(btn.dataset.min));
  });
  $('btnCollapseAll').addEventListener('click', () => {
    if (!state) return;
    const ids = E.Engine.cast(state);
    setMinimized(ids, !ids.every(isMinimized));
  });
  const minButton = (id, c, min) =>
    `<button type="button" class="ghost card-min" data-min="${esc(id)}" aria-label="${min ? 'Expand' : 'Minimize'} ${esc(c.name)}" title="${min ? 'Expand' : 'Minimize'}">${min ? '+' : '–'}</button>`;

  // One row: portrait, name, mood.
  function cardMini(id, c, isPlayer) {
    const mood = !isPlayer && c.mood ? `<span class="mini-mood">${esc(c.mood.text)}</span>` : '';
    return `<div class="mini">${portraitHtml(id)}<span class="nm">${esc(c.name)}${isPlayer ? ' (you)' : ''}</span>${mood}${minButton(id, c, true)}</div>`;
  }

  // Portrait, name, role, how they and you feel about each other, and where they are.
  // bare: without the minimize button (the popup card).
  function cardHeader(id, c, isPlayer, bare) {
    const loc = state.locations[c.status.location];
    let rels = '';
    if (!isPlayer) {
      const rel = c.relations[state.player] || 0;
      const relW = E.relWord(rel);
      const mine = state.characters[state.player].relations[id] || 0;
      const myW = E.relWord(mine);
      const why = (state.characters[state.player].attitudeNotes || {})[id];
      rels = `<div class="rels"><div class="rel-${relW}" title="How they feel about you">them: ${relW} ${rel > 0 ? '+' : ''}${rel}</div>` +
        `<div class="rel-${myW}" title="${esc(why ? 'How you feel about them: ' + why : 'How you feel about them')}">you: ${myW} ${mine > 0 ? '+' : ''}${mine}</div></div>`;
    }
    return `<div class="top">${portraitHtml(id)}<div class="who"><div class="nm">${esc(c.name)}${isPlayer ? ' (you)' : ''}${c.pinned && !isPlayer ? ' <span title="Pinned" aria-label="pinned">📌</span>' : ''}</div><div class="role">${esc(c.role)}</div></div>${rels}${bare ? '' : minButton(id, c, false)}</div>` +
      `<div class="meta">${esc(whereText(id, isPlayer, loc))}</div>`;
  }
  // Where the card says someone is (task 3-3): where you last saw them, so a
  // covert move never shows.
  function whereText(id, isPlayer, loc) {
    if (isPlayer) return loc ? loc.name : '?';
    const kw = E.Engine.knownWhere(state, id);
    const room = kw && state.locations[kw.loc];
    if (!room) return 'whereabouts unknown';
    return kw.now ? room.name : `last seen in ${room.name}${kw.turn ? ` (turn ${kw.turn})` : ''}`;
  }

  // Who they are right now: the mood line (others only; it fades when it hasn't
  // been updated for a while), then tags from the numbers and from the story.
  function cardStatus(c, isPlayer) {
    const mood = !isPlayer && c.mood
      ? `<div class="mood${state.turn - c.mood.turn > E.Engine.MOOD_STALE ? ' stale' : ''}" title="${esc(c.mood.reason ? 'Why: ' + c.mood.reason : '')}">${esc(c.mood.text)}</div>`
      : '';
    const derived = E.Engine.derivedTags(state, c).map((t) => `<span class="tag derived">${esc(t)}</span>`);
    const story = (c.tags || []).map((t) => {
      const tip = [t.reason, t.until != null ? `until turn ${t.until}` : ''].filter(Boolean).join(' · ');
      return `<span class="tag" title="${esc(tip)}">${esc(t.text)}</span>`;
    });
    const tags = derived.concat(story);
    return mood + (tags.length ? `<div class="tags">${tags.join('')}</div>` : '');
  }

  function cardNeeds(c, dead) {
    // Only the needs this person has (task G-5).
    const has = state.scenario.needs.filter((n) => E.Scenario.hasNeed(c, n.id));
    if (dead || !has.length) return '';
    return `<div class="needs">${has.map((n) => {
      const v = c.needs[n.id] || 0;
      return `<span>${esc(n.label || n.id)}</span><div class="bar ${v >= 0.85 ? 'danger' : ''}"><i style="width:${Math.round(v * 100)}%"></i></div>`;
    }).join('')}</div>`;
  }

  // Collapsed details about the person: who they are, needs, and what you know
  // about them (only facts the player knows). Open ones stay open across re-renders.
  const openCards = new Set();
  const KNOWN_SHOWN = 6;
  function cardDetails(id, c, dead) {
    return `<details class="card-details" data-card="${esc(id)}"${openCards.has(id) ? ' open' : ''}><summary>Details</summary>${cardBody(id, c, dead, true)}</details>`;
  }
  // The details themselves; interactive: with the pin, feelings and save
  // controls (the People panel), else to read only (the popup card).
  function cardBody(id, c, dead, interactive) {
    const who = [c.pronouns, c.role, c.age, E.Standing.membership(state, c)].filter(Boolean).map(esc).join(' · ');
    const known = E.Engine.knownAbout(state, id);
    const knownHtml = known.length
      ? `<ul class="known">${known.slice(0, KNOWN_SHOWN).map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` +
        (known.length > KNOWN_SHOWN ? `<div class="muted small">and ${known.length - KNOWN_SHOWN} more in Debug › Fact store</div>` : '')
      : '<div class="muted small">Nothing yet.</div>';
    return `<div class="small muted">${who}</div>` +
      (c.description ? `<p class="desc">${esc(c.description)}</p>` : '') +
      (c.appearance ? `<p class="desc"><span class="muted">Looks:</span> ${esc(c.appearance)}</p>` : '') +
      (interactive && id !== state.player && !dead ? cardPin(id, c) + cardFeelings(id, c) : '') +
      (interactive && id === state.player && state.scenario.madePlayer === id ? '<button type="button" class="small" data-save-char>Save this character</button>' : '') +
      cardNeeds(c, dead) +
      `<div class="known-head">What you know</div>${knownHtml}`;
  }
  // Pin: they stay in the foreground (full detail every turn) even while unseen.
  function cardPin(id, c) {
    return `<div class="pin-row"><button type="button" class="small" data-pin="${esc(id)}" aria-pressed="${c.pinned ? 'true' : 'false'}">${c.pinned ? 'Unpin' : '📌 Pin'}</button>` +
      `<span class="small muted">${c.pinned ? 'Pinned: the story keeps them in mind even when you haven\'t seen them for a while.' : 'Keep them in mind even when you haven\'t seen them for a while.'}</span></div>`;
  }
  // Your feelings toward them, with −/+ (5 a step) and an optional "why" that
  // replaces the note (task 1-8): for when the model misread your tone.
  function cardFeelings(id, c) {
    const v = state.characters[state.player].relations[id] || 0;
    const note = (state.characters[state.player].attitudeNotes || {})[id];
    const nm = esc(c.name);
    return `<div class="feel" data-feel="${esc(id)}"><div class="known-head">Your feelings</div>` +
      `<div class="feel-row"><button type="button" class="small" data-feel-step="-5" aria-label="Feel 5 worse toward ${nm}">−</button>` +
      `<span class="rel-${E.relWord(v)}">${E.relWord(v)} ${v > 0 ? '+' : ''}${v}</span>` +
      `<button type="button" class="small" data-feel-step="5" aria-label="Feel 5 better toward ${nm}">+</button>` +
      `<input type="text" class="feel-why" maxlength="80" placeholder="Why (optional)" aria-label="Why you feel this way about ${nm}"></div>` +
      (note ? `<div class="small muted">${esc(note)}</div>` : '') +
      '<div class="small muted">Fix this when the story misread your tone. Undo also undoes changes made since your last action.</div></div>';
  }
  $('cast').addEventListener('click', (ev) => {
    if (ev.target.closest('button[data-save-char]') && state) return void download(state.player + '.json', E.CharMaker.toFile(state.characters[state.player]));
    const pin = ev.target.closest('button[data-pin]');
    if (pin && state && !busy) {
      const id = pin.dataset.pin;
      const out = E.Engine.setPinned(state, id, !state.characters[id].pinned);
      if (out.error) return void alert(out.error);
      notes.push({ kind: 'cast tier', summary: out.note, detail: out.pinned ? 'Pinned people stay local: full detail in every prompt, never moved to the background.' : 'They go back to the usual rules and drop to the background after a few turns unseen.' });
      autosave();
      return void renderAll();
    }
    const btn = ev.target.closest('button[data-feel-step]');
    if (!btn || !state || busy) return;
    const box = btn.closest('[data-feel]');
    const id = box.dataset.feel;
    const why = box.querySelector('.feel-why').value;
    const out = E.Engine.correctAttitude(state, id, parseInt(btn.dataset.feelStep, 10), why);
    if (out.error) return;
    notes.push({ kind: 'feelings', summary: `you corrected your feelings toward ${state.characters[id].name}: now ${out.value}`, detail: `Step: ${btn.dataset.feelStep}${why.trim() ? `\nWhy: ${why.trim()}` : ''}\nThe next turn's prompts use the new value.` });
    autosave();
    renderAll();
  });

  // toggle doesn't bubble, so listen in the capture phase.
  $('cast').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.matches || !d.matches('details.card-details')) return;
    if (d.open) openCards.add(d.dataset.card); else openCards.delete(d.dataset.card);
  }, true);

  function renderJournal() {
    if (!state.chapters.length) {
      $('journal').innerHTML = `<div class="muted">Chapter ${state.chapter} in progress${state.turn ? ` (turn ${E.Memory.turnsInChapter(state)}; it closes when its notes fill the memory, or after ${E.settings.chapterLength} turns)` : ''}.</div>`;
      return;
    }
    // The latest chapter is shown in full; earlier ones fold to their title
    // and stay as the player leaves them.
    const latest = state.chapters[state.chapters.length - 1].n;
    $('journal').innerHTML = state.chapters.slice().reverse().map((c) =>
      `<details class="journal-entry" data-journal="${c.n}"${c.n === latest || openJournal.has(c.n) ? ' open' : ''}><summary><b>${c.n}. ${esc(c.title)}</b> <span class="turns">turns ${c.fromTurn}–${c.toTurn}</span></summary><div>${esc(c.summary)}</div></details>`
    ).join('');
  }
  $('journal').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.matches || !d.matches('details.journal-entry') || !state || !state.chapters.length) return;
    const n = Number(d.dataset.journal);
    if (n === state.chapters[state.chapters.length - 1].n) return;
    if (d.open) openJournal.add(n); else openJournal.delete(n);
  }, true);

  // ---------- debug ----------
  // Generated sites (task 4-4), for Debug: everything, notes included.
  function sitesDebug() {
    return Object.values(state.sites).map((s) => [
      `${s.name} [${s.id}] · ${s.kind} · ${s.region || 'no region'} · ${s.stub ? 'stub (not built)' : `entry ${s.entry}`} · from ${s.from}${s.map ? ` (library map ${s.map})` : ''}`,
      `  why: ${s.why || '-'}`,
      s.stub ? `  summary: ${s.summary || '-'}` : `  rooms: ${s.rooms.join(', ')}; visits ${s.visits}; ${s.kept ? `kept (${s.keptWhy})` : 'fades if nothing happens there'}`,
      s.note ? `  note: ${s.note}` : null,
    ].filter(Boolean).join('\n')).join('\n\n');
  }
  function renderDebug() {
    renderRecorder();
    if ($('debug').classList.contains('hidden')) return;
    const calls = E.LLM.calls.slice().reverse();
    const facts = state ? state.facts.map((f) => `[T${f.turn} w${f.weight}] ${f.text}   (known by: ${f.known_by.join(', ')})`).join('\n') : '';
    $('debugBody').innerHTML =
      renderTelemetry() +
      (state ? `<details><summary>Fact store (${state.facts.length})</summary><pre>${esc(facts)}</pre></details>` : '') +
      (state ? `<details><summary>Characters: needs, tiers, mood and tags</summary><pre>${esc(characterDebug())}</pre></details>` : '') +
      (state && E.Timeline.all(state).length ? `<details><summary>Timeline (${E.Timeline.pending(state).length} upcoming)</summary><pre>${esc(timelineDebug())}</pre></details>` : '') +
      (state && Object.keys(state.sites || {}).length ? `<details><summary>Places made during the story (${Object.keys(state.sites).length})</summary><pre>${esc(sitesDebug())}</pre></details>` : '') +
      notes.slice().reverse().map((n) => `<details class="note"><summary><b>${esc(n.kind)}</b> · ${esc(n.summary)}</summary><pre>${esc(n.detail)}</pre></details>`).join('') +
      calls.map((c) => `<details><summary><b>${esc(c.kind)}</b> · ${esc(c.backend || '')} · ${c.ms} ms · ~${c.estTokens} tokens${c.overBudget ? ' <span class="fail">over context!</span>' : ''}${c.squeezed ? ` <span class="fail">squeezed to fit: ${esc(c.squeezed.join(', '))} left out</span>` : ''}${c.finish === 'length' ? ' <span class="fail">cut off at the token limit</span>' : ''}${c.salvaged ? ' <span class="fail">salvaged: kept the complete part</span>' : ''}${c.error ? ' <span class="fail">' + esc(c.error) + '</span>' : ''}</summary>
        <div class="muted">System (shared prefix)</div><pre>${esc(c.system)}</pre>
        <div class="muted">User</div><pre>${esc(c.user)}</pre>
        <div class="muted">Raw output</div><pre>${esc(c.raw)}</pre></details>`).join('') ||
      '<div class="muted">No model calls yet.</div>';
  }
  // The timeline (task 5-2): upcoming events with each precondition as it
  // stands now, then what became of the rest. Debug only: the future is hidden.
  function timelineDebug() {
    const TL = E.Timeline;
    const sc = state.scenario;
    const up = TL.pending(state).map((ev) => [`${TL.fmt(sc, ev.when)} [${ev.scope}${ev.projected ? ', projected' : ''}${ev.onBroken === 'diverge' ? ', diverges' : ''}] ${ev.id}: ${ev.text}`]
      .concat(TL.status(state, ev).map((p) => `    ${p.ok ? '✓' : '✗'} ${p.text}`)).join('\n'));
    const done = TL.all(state).filter((ev) => state.canon[ev.id] && state.canon[ev.id].status !== 'past')
      .map((ev) => { const st = state.canon[ev.id]; return `${ev.id}: ${st.status} (${st.time || ''})${st.why ? ` — ${st.why}` : st.text && st.text !== ev.text ? ` — ${st.text}` : ''}`; });
    return (up.length ? 'Upcoming:\n' + up.join('\n') : 'Nothing upcoming.') + (done.length ? '\n\nResolved:\n' + done.join('\n') : '') +
      (state.projection === false ? '\n\n(This game started before projected events; none are planned.)' : '');
  }
  // Minor people (task 2-3): where they are, how often you named them, promotion.
  function extrasDebug() {
    const xs = Object.values(state.extras || {});
    if (!xs.length) return '';
    return '\n\nMinor people:\n' + xs.map((x) => `  ${x.name} (${x.id}), ${x.role}; in ${x.location ? (state.locations[x.location] || {}).name || x.location : 'no particular place'}; ${x.from === 'model' ? `added turn ${x.born}` : x.from === 'standee' ? `singled out turn ${x.born}` : 'authored'}` +
      `; named ${x.mentions}×${x.promote ? `; promotion due (${x.tries} tries)` : ''}` + (x.note ? `\n    note: ${x.note}` : '')).join('\n');
  }
  // Unnamed groups (task 3-2): count, state, room, post or patrol.
  function standeesDebug() {
    const gs = Object.values(state.standees || {});
    if (!gs.length) return '';
    return '\n\nUnnamed groups:\n' + gs.map((g) => `  ${g.label} (${g.id}): ${g.count}, ${g.state}; in ${(state.locations[g.location] || {}).name || g.location}` +
      (g.faction ? `; ${g.faction}` : '') + (g.post ? `; post ${g.post}` : '') + (g.patrol ? `; patrol ${g.patrol.join(' → ')}` : '') + (g.note ? `\n    note: ${g.note}` : '')).join('\n');
  }

  // The raw numbers behind the cards (needs as 0–1, tag expiry, mood reasons).
  function characterDebug() {
    return E.Engine.cast(state).map((id) => {
      const c = state.characters[id];
      const needs = Object.entries(c.needs || {}).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') || 'no needs';
      const mood = c.mood ? `mood (turn ${c.mood.turn}): ${c.mood.text}${c.mood.reason ? ' — ' + c.mood.reason : ''}` : 'mood: none';
      const tags = (c.tags || []).map((t) => `${t.text} [${t.until == null ? 'lasting' : 'until turn ' + t.until}]${t.reason ? ' — ' + t.reason : ''}`);
      const tier = id === state.player ? '' : `; ${E.Engine.tier(state, id)}${c.pinned ? ' (pinned)' : ''}, last seen turn ${c.lastSeen || 0}`;
      // Agendas (task 2-2): goal, step k/n and progress; Debug only, since steps can be secret.
      const a = c.agenda;
      const agenda = id === state.player ? [] : [a
        ? `  agenda: ${a.goal} — ${a.done ? 'done' : `step ${a.step + 1}/${a.steps.length} "${a.steps[a.step].text}"${a.steps[a.step].contact ? ' (comes to you)' : ''}, ${Math.round(a.progress * 100)}%${a.due ? ', DUE' : ''}`}; ${a.hours} h a step, ${a.visibility}${a.followUp ? ', follow-up' : ''}`
        : 'agenda' in c ? '  agenda: routine' : '  agenda: none yet (the model will propose one when they are in the background)'];
      return [`${c.name} (${id}): ${E.healthWord(c.status.health)}; ${needs}${tier}`, '  ' + mood].concat(agenda).concat(tags.map((t) => '  tag: ' + t)).join('\n');
    }).join('\n') + extrasDebug() + standeesDebug() + (state.corrections && state.corrections.length
      ? '\n\nYour corrections:\n' + state.corrections.map((x) => `  turn ${x.turn}: ${state.characters[x.id] ? state.characters[x.id].name : x.id} ${x.delta > 0 ? '+' : ''}${x.delta} → ${x.value}${x.why ? ` (${x.why})` : ''}`).join('\n')
      : '');
  }

  // Where each turn's time and tokens went, and which guards fired. The newest
  // turn is open; "~" marks estimates (the backend didn't report usage).
  function renderTelemetry() {
    const reports = E.Engine.telemetry.slice().reverse();
    if (!reports.length) return '';
    const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
    const tok = (c, f) => (c.estimated !== false ? '~' : '') + (Number(c[f]) || 0).toLocaleString();
    const anyCache = (t) => t.calls.some((c) => c.cachedTokens != null);
    const anyPerf = (t) => t.calls.some((c) => c.perf);
    return reports.map((t, i) => {
      const tot = E.Engine.reportTotals(t);
      const cache = anyCache(t), perf = anyPerf(t);
      // Smaller calls (task L-3): a step's parts under one row with their sums.
      const stepOf = (c) => (/^[a-z]+:/.test(c.kind) ? c.kind.split(':')[0] : null);
      const groupRow = (i) => {
        const s = stepOf(t.calls[i]);
        if (!s || (i > 0 && stepOf(t.calls[i - 1]) === s)) return '';
        let j = i;
        while (j < t.calls.length && stepOf(t.calls[j]) === s) j++;
        const part = t.calls.slice(i, j);
        const sum = (f) => part.reduce((a, c) => a + (Number(c[f]) || 0), 0);
        const est = part.some((c) => c.estimated !== false) ? '~' : '';
        return `<tr class="call-group"><td>${esc(s)} · ${part.length} call${part.length === 1 ? '' : 's'}</td><td></td><td class="num">${est}${sum('promptTokens').toLocaleString()}</td><td class="num">${est}${sum('completionTokens').toLocaleString()}</td>` +
          (cache ? '<td></td>' : '') + (perf ? '<td></td>' : '') + `<td class="num">${sec(sum('ms'))}</td></tr>`;
      };
      const rows = t.calls.map((c, i) => groupRow(i) +
        `<tr class="${[c.error ? 'fail' : '', stepOf(c) ? 'call-part' : ''].filter(Boolean).join(' ')}"><td>${esc(c.kind)}${c.salvaged ? ' <span class="fail">salvaged</span>' : ''}${c.finish === 'length' ? ' <span class="fail">cut off</span>' : ''}${c.finish === 'stopped' ? ` <span class="muted" title="${esc(c.stopped || '')}">stopped at a paragraph</span>` : ''}</td><td>${esc(c.backend || '')}</td>` +
        `<td class="num">${tok(c, 'promptTokens')}</td><td class="num">${tok(c, 'completionTokens')}</td>` +
        (cache ? `<td class="num">${c.cachedTokens != null ? c.cachedTokens.toLocaleString() : ''}</td>` : '') +
        (perf ? `<td class="num">${c.perf ? sec(c.perf.processSec * 1000) : ''}</td>` : '') +
        `<td class="num">${sec(c.ms || 0)}</td></tr>`).join('');
      const est = tot.estimated ? '~' : '';
      const guards = t.guards.length
        ? `<ul class="guards">${t.guards.map((g) => `<li><b>${esc(g.type)}</b>${g.turn != null && g.turn !== t.turn ? ` <span class="muted">(turn ${g.turn})</span>` : ''}: ${esc(g.detail)}</li>`).join('')}</ul>`
        : '<div class="muted">No guards fired.</div>';
      return `<details class="telemetry"${i === 0 ? ' open' : ''}><summary><b>${t.kind === 'reroll' ? 'Reroll of turn' : 'Turn'} ${t.turn}</b> · ${sec(t.ms)} · ${tot.calls} call${tot.calls === 1 ? '' : 's'} · ${est}${tot.promptTokens.toLocaleString()} in / ${est}${tot.completionTokens.toLocaleString()} out` +
        `${t.guards.length ? ` · ${t.guards.length} guard${t.guards.length === 1 ? '' : 's'}` : ''}${t.error ? ' <span class="fail">failed</span>' : ''}</summary>` +
        `<table><thead><tr><th>step</th><th>backend</th><th class="num">in</th><th class="num">out</th>${cache ? '<th class="num" title="Prompt tokens the provider served from its cache">cached</th>' : ''}${perf ? '<th class="num" title="KoboldCpp prompt processing time; short means the shared prefix was reused">prompt</th>' : ''}<th class="num">time</th></tr></thead><tbody>${rows}</tbody></table>` +
        `<div class="muted small">Guards fired</div>${guards}` +
        ((t.lore || []).length ? `<div class="muted small">Lore included</div><ul class="guards">${t.lore.map((l) => `<li><b>${esc(l.title)}</b> <span class="muted">(${esc(l.call)})</span>: ${esc(l.why)}</li>`).join('')}</ul>` : '') +
        `<button type="button" class="small" data-copy-report="${E.Engine.telemetry.indexOf(t)}">Copy turn report</button></details>`;
    }).join('');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    // Fallback for pages opened from disk, where the clipboard API can be blocked.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  $('debugBody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-copy-report]');
    if (!btn) return;
    const t = E.Engine.telemetry[parseInt(btn.dataset.copyReport, 10)];
    if (!t) return;
    btn.textContent = (await copyText(E.Engine.turnReport(t))) ? 'Copied' : 'Copy failed (select the text in a call below instead)';
  });

  $('btnDebug').addEventListener('click', () => { $('debug').classList.toggle('hidden'); renderDebug(); });
  $('btnDebugClose').addEventListener('click', () => $('debug').classList.add('hidden'));

  // ---------- settings ----------
  function backendBox(id) { return document.querySelector(`fieldset.backend[data-backend="${id}"]`); }

  function showPreset(box, presetId) {
    const p = E.backendPresets[presetId] || {};
    box.querySelector('.hint').textContent = p.hint || '';
    box.querySelector('.keyRow').classList.toggle('hidden', p.key === false);
    box.querySelector('.modelRow').classList.toggle('hidden', !!p.kobold);
    // Constrain JSON (task L-1): a grammar for KoboldCpp, JSON mode where the API has one.
    box.querySelector('.constrainRow').classList.toggle('hidden', !p.kobold && !p.jsonMode);
  }

  function fillBackend(id) {
    const box = backendBox(id);
    const b = E.settings.backends[id];
    const sel = box.querySelector('.bPreset');
    sel.innerHTML = Object.entries(E.backendPresets).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
    sel.value = b.preset;
    box.querySelector('.bUrl').value = b.url || '';
    box.querySelector('.bKey').value = b.key || '';
    box.querySelector('.bModel').value = b.model || '';
    box.querySelector('.bContext').value = b.context || E.defaults.backends[id].context;
    box.querySelector('.bConstrain').checked = b.constrainJSON != null ? !!b.constrainJSON : E.LLM.constrainDefault(b.preset);
    box.querySelector('.bSmaller').checked = b.smallerCalls != null ? !!b.smallerCalls : E.LLM.smallerDefault(b.preset, b.context);
    box.querySelector('.bStatus').textContent = '';
    showPreset(box, b.preset);
    sel.onchange = () => {
      const p = E.backendPresets[sel.value] || {};
      box.querySelector('.bUrl').value = p.url || '';
      box.querySelector('.bModel').value = p.model || '';
      box.querySelector('.bConstrain').checked = E.LLM.constrainDefault(sel.value);
      box.querySelector('.bSmaller').checked = E.LLM.smallerDefault(sel.value, parseInt(box.querySelector('.bContext').value, 10) || 0);
      showPreset(box, sel.value);
    };
    box.querySelector('.bTest').onclick = async () => {
      readSettings();
      const st = box.querySelector('.bStatus');
      st.textContent = 'Testing…';
      try {
        const info = await E.LLM.ping(id);
        st.textContent = `✓ ${info.model}${info.context ? ` · context ${info.context}` : ''}`;
        if (info.context) { box.querySelector('.bContext').value = info.context; showMemory(); }
      } catch (e) {
        st.textContent = '✕ ' + e.message;
      }
    };
  }

  function readBackend(id) {
    const box = backendBox(id);
    E.settings.backends[id] = {
      preset: box.querySelector('.bPreset').value,
      url: box.querySelector('.bUrl').value.trim(),
      key: box.querySelector('.bKey').value.trim(),
      model: box.querySelector('.bModel').value.trim(),
      context: Math.max(2048, parseInt(box.querySelector('.bContext').value, 10) || E.defaults.backends[id].context),
      constrainJSON: box.querySelector('.bConstrain').checked,
      smallerCalls: box.querySelector('.bSmaller').checked,
    };
  }

  // Which context the memory budgets use, so it is clear it follows routing.
  // Reads the form into a preview without changing the live settings.
  function showMemory() {
    const keep = E.clone(E.settings);
    readSettings();
    const m = E.memoryContext();
    Object.keys(E.settings).forEach((k) => delete E.settings[k]);
    Object.assign(E.settings, keep);
    const name = m.from === 'external' ? 'the external model' : 'the local model';
    $('sMemory').textContent = `Memory is planned for ${m.tokens.toLocaleString()} tokens of context: ` +
      (m.capped ? 'the memory cap.' : `${name}, the smallest in use.`);
  }

  function fillRouting() {
    $('routing').innerHTML = E.routeSteps.map((r) =>
      `<label>${esc(r.label)} <select data-step="${r.id}"><option value="local">Local</option><option value="external">External</option></select></label>`
    ).join('');
    E.routeSteps.forEach((r) => { $('routing').querySelector(`[data-step="${r.id}"]`).value = E.settings.routing[r.id] || 'local'; });
  }
  // local | external | hybrid (characters and narration external, bookkeeping local)
  function routingFor(mode) {
    const out = {};
    E.routeSteps.forEach((r) => { out[r.id] = mode === 'hybrid' ? (['intent', 'narrate', 'worldbuild'].includes(r.id) ? 'external' : 'local') : mode; });
    return out;
  }
  document.querySelectorAll('[data-route]').forEach((btn) => btn.addEventListener('click', () => {
    const routes = routingFor(btn.dataset.route);
    E.routeSteps.forEach((r) => { $('routing').querySelector(`[data-step="${r.id}"]`).value = routes[r.id]; });
    showMemory();
  }));
  // Keep the memory line current while the dialog is open.
  $('settings').addEventListener('change', (ev) => {
    if (ev.target.matches('[data-step], .bContext, #sMemoryCap')) showMemory();
  });

  function fillSettings() {
    fillBackend('local');
    fillBackend('external');
    fillRouting();
    $('sMemoryCap').value = E.settings.memoryCap;
    showMemory();
    $('sNarrate').value = E.settings.narrateTokens;
    $('sTemp').value = E.settings.temperature;
    $('sChapter').value = E.settings.chapterLength;
    fillAppearance();
    $('sStatus').textContent = '';
  }
  function readSettings() {
    readBackend('local');
    readBackend('external');
    E.routeSteps.forEach((r) => { E.settings.routing[r.id] = $('routing').querySelector(`[data-step="${r.id}"]`).value; });
    E.settings.memoryCap = Math.max(4096, parseInt($('sMemoryCap').value, 10) || E.defaults.memoryCap);
    E.settings.narrateTokens = E.clamp(parseInt($('sNarrate').value, 10) || E.defaults.narrateTokens, 150, 1200);
    E.settings.temperature = E.clamp(parseFloat($('sTemp').value) || E.defaults.temperature, 0, 2);
    E.settings.chapterLength = E.clamp(parseInt($('sChapter').value, 10) || E.defaults.chapterLength, 4, 40);
    E.settings.appearance = readAppearance();
  }

  // ---------- appearance ----------
  // The page previews choices as they are made; closing without Save puts the
  // saved look back.
  const applyAppearance = (a) => window.EnsembleAppearance && window.EnsembleAppearance(a);
  function fillAppearance() {
    const a = E.settings.appearance;
    $('aTheme').value = a.theme;
    $('aTextSize').value = a.textSize;
    $('aTextSizeOut').textContent = a.textSize + '%';
    $('aFont').value = a.storyFont;
    $('aSpacing').value = a.lineSpacing;
    $('aMotion').value = a.motion;
    $('aMapDetail').value = a.mapDetail === 'simple' ? 'simple' : 'detailed';
    $('aStoryLinks').value = a.storyLinks === 'off' ? 'off' : 'on';
  }
  function readAppearance() {
    return {
      theme: $('aTheme').value,
      textSize: E.clamp(parseInt($('aTextSize').value, 10) || 100, 90, 150),
      storyFont: $('aFont').value,
      lineSpacing: $('aSpacing').value,
      motion: $('aMotion').value,
      mapDetail: $('aMapDetail').value,
      storyLinks: $('aStoryLinks').value,
    };
  }
  ['aTheme', 'aTextSize', 'aFont', 'aSpacing', 'aMotion', 'aMapDetail', 'aStoryLinks'].forEach((id) => $(id).addEventListener('input', () => {
    $('aTextSizeOut').textContent = $('aTextSize').value + '%';
    applyAppearance(readAppearance());
    if (id === 'aMapDetail') { mapDetailPreview = $('aMapDetail').value; if (state) renderMap(); }
    if (id === 'aStoryLinks') { storyLinksPreview = $('aStoryLinks').value; if (state) renderLog(); }
  }));
  // "Same as my device" follows the OS while the page is open.
  ['(prefers-color-scheme: light)', '(prefers-reduced-motion: reduce)'].forEach((q) => {
    try { window.matchMedia(q).addEventListener('change', () => applyAppearance(E.settings.appearance)); } catch (e) {}
  });
  $('btnSettings').addEventListener('click', () => { fillSettings(); $('settings').showModal(); });

  // ---------- first-run setup ----------
  // Shown once, before any settings are saved: pick how to run the model, then
  // Settings opens on the section that still needs filling in.
  function openSetup() {
    $('setupLocal').textContent = 'Checking for KoboldCpp…';
    $('setupLocal').className = 'small';
    E.LLM.ping('local').then(
      (info) => { $('setupLocal').textContent = `✓ KoboldCpp is running here (${info.model}).`; $('setupLocal').className = 'small ok'; },
      () => { $('setupLocal').textContent = 'KoboldCpp isn\'t running right now.'; },
    );
    $('setup').showModal();
  }
  $('setup').addEventListener('close', () => {
    store.set('ensemble.setupDone', '1');
    const mode = $('setup').returnValue;
    if (!['external', 'local', 'hybrid'].includes(mode)) { checkConnection(false); return; }
    E.settings.routing = routingFor(mode);
    E.saveSettings();
    checkConnection(false);
    fillSettings();
    document.querySelectorAll('#settings details.section').forEach((d) => {
      d.open = d.dataset.section === (mode === 'local' ? 'local' : 'external') || d.dataset.section === 'routing';
    });
    $('settings').showModal();
    const box = backendBox(mode === 'local' ? 'local' : 'external');
    (mode === 'local' ? box.querySelector('.bTest') : box.querySelector('.bKey')).focus();
  });
  $('btnSetup').addEventListener('click', () => { $('settings').close('cancel'); openSetup(); });
  // Settings sections remember whether they were left open.
  function restoreSections() {
    document.querySelectorAll('#settings details.section').forEach((d) => {
      const k = 'ensemble.section.' + d.dataset.section;
      const v = store.get(k);
      if (v !== null) d.open = v === '1';
      d.addEventListener('toggle', () => store.set(k, d.open ? '1' : '0'));
    });
  }
  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue === 'save') {
      readSettings();
      E.saveSettings();
      checkConnection(false);
      if (state) renderJournal();
    }
    applyAppearance(E.settings.appearance);
    if (mapDetailPreview) { mapDetailPreview = null; if (state) renderMap(); }
    if (storyLinksPreview) { storyLinksPreview = null; if (state) renderLog(); }
  });

  // ---------- mobile side sheet ----------
  $('btnSide').addEventListener('click', () => $('side').classList.add('open'));
  $('btnSideClose').addEventListener('click', () => $('side').classList.remove('open'));

  // ---------- boot ----------
  function initTimeSteps() {
    $('timeStep').innerHTML = E.timeSteps.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
    $('timeStep').value = 'hour';
    $('timeStep').addEventListener('change', () => {
      $('actionInput').placeholder = actionPlaceholder();
    });
  }

  // Test play (task 6-1): the creator opened this tab with ?testplay and
  // sends its working copy once the page is ready. Only the tab that opened
  // this one is listened to; the world goes through the same checks as any.
  const TEST_PLAY = (() => { try { return new URLSearchParams(location.search).has('testplay'); } catch (e) { return false; } })();
  function startTestPlay() {
    if (!window.opener) { $('pickInfo').innerHTML = '<span class="fail">Test play starts from the creator: use ▶ Test play there.</span>'; showPickInfo(true); return; }
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (ev.source !== window.opener || !d || d.type !== E.WorldEdit.TEST_WORLD) return;
      const key = 'test:' + d.folder;
      let world;
      try { world = E.Scenario.prepareWorld(d.folder, d.files); }
      catch (e) { world = { folder: d.folder, title: (d.files['world.json'] || {}).title || d.folder, error: e.message }; }
      loaded.set(key, world);
      diskAssets.set(d.folder, d.assets || {});
      addScenarioOption(key, `${worldLabel(world)} (test play)`, true);
      renderStarts(d.startId);
      showPickInfo(true);
      document.title = `Test play: ${world.title} · Ensemble`;
      if (!world.error) $('btnNew').click();
    });
    window.opener.postMessage({ type: E.WorldEdit.TEST_READY }, '*');
  }

  async function boot() {
    await E.Store.ready();
    E.pageCheck();
    restoreSections();
    const firstRun = store.get('ensemble.settings') === null && store.get('ensemble.setupDone') === null;
    E.loadSettings();
    applyAppearance(E.settings.appearance);
    initTimeSteps();
    // The shared site map library (task 6-3), before the worlds that use it.
    try {
      const [shared] = await E.Library.list('library');
      if (shared) E.Scenario.library = await E.Library.load(shared.id);
    } catch (e) { /* no library/: worlds use their own maps */ }
    await loadServerList();
    if (firstRun) openSetup();
    else checkConnection(false);
    if (TEST_PLAY) return startTestPlay();
    const last = await E.Saves.last();
    const saved = last && await E.Saves.load(last.id);
    if (saved) {
      try {
        state = E.Engine.migrate(saved);
        saveId = last.id;
        restoreView();
        showPickInfo(false);
        renderAll();
      } catch (e) { state = null; }
    }
  }
  boot();
})();
