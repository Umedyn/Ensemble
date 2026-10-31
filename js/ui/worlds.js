// Worlds and starts, lore packs, the game lifecycle, the character maker and generated starts.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

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
    const w = U.loaded.get($('scenarioSelect').value);
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
    const w = U.loaded.get($('scenarioSelect').value);
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
    const w = U.loaded.get($('scenarioSelect').value);
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
    const w = U.loaded.get($('scenarioSelect').value);
    const list = packsFor(w);
    const on = w ? chosenPacks(w).length : 0;
    $('btnPacks').classList.toggle('hidden', !list.length);
    $('btnPacks').textContent = on ? `Lore packs (${on})` : 'Lore packs';
  }
  function renderPackList() {
    const w = U.loaded.get($('scenarioSelect').value);
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
    const w = U.loaded.get($('scenarioSelect').value);
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
    worlds.forEach((w, i) => { U.loaded.set(list[i].id, w); addScenarioOption(list[i].id, worldLabel(w)); });
    const pick = rememberedPick();
    if (pick.world && U.loaded.has(pick.world)) $('scenarioSelect').value = pick.world;
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
    const item = U.loaded.get(key);
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
      U.libraryAssets = Object.assign({}, U.libraryAssets, lib.assets);
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
      worlds.forEach((w, i) => { const id = E.Library.open('world', w.folder, w.title, w); U.loaded.set(id, w); U.diskAssets.set(w.folder, w.assets || {}); addScenarioOption(id, w.title + ' (disk)', i === 0); });
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
    if (U.busy) return;
    if (U.state && U.state.turn > 0 && !confirm('Start a new game? Unsaved progress will be lost.')) return;
    // Busy while the world loads, so Act can't fire into the old (or no) game.
    U.setBusy(true);
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
      U.setBusy(false);
    }
    // Make my own (task 4-1): the game starts from the character form.
    if (world && startId === GEN_OPTION) return openGenerator(world);
    if (world && makingOwn()) return openMaker(world, startId || world.defaultStart);
    if (U.state) U.renderAll();
    $('actionInput').focus();
  });

  // A fresh game from a scenario, with the page reset for it.
  function beginGame(world, scenario) {
    // Lore packs (task 5-7): every new game goes through here.
    scenario = withPacks(world, scenario);
    U.state = E.Engine.newGame(scenario);
    U.saveId = null;
    U.restoreView();
    rememberPick();
    showPickInfo(false);
    U.uiCut = null;
    U.uiShown = 1;
    U.openTurns.clear();
    E.LLM.calls.length = 0;
    E.Engine.telemetry.length = 0;
    U.stopRecording();
    U.notes.length = 0;
    if (world.warnings.length) U.notes.push({ kind: 'world', summary: `${world.warnings.length} unknown field${world.warnings.length === 1 ? '' : 's'} ignored in "${world.title}"`, detail: world.warnings.join('\n') });
    if ((scenario.packs || []).length) U.notes.push({ kind: 'packs', summary: `lore packs: ${scenario.packs.map((p) => p.title).join(', ')}`, detail: scenario.packs.map((p) => `${p.title}${p.version ? ` v${p.version}` : ''} (${p.id})${p.credit ? `, by ${p.credit}` : ''}`).join('\n') });
    if (scenario.madePlayer) U.notes.push({ kind: 'character', summary: `you made ${U.state.characters[U.state.player].name}`, detail: JSON.stringify(E.CharMaker.toFile(U.state.characters[U.state.player]), null, 1) });
    U.autosave();
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
        U.renderAll();
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
    charForm.open({ sc: opts.sc, form, assetUrl: (p) => U.assetUrl(opts.sc.folder, p), onChange: saveDraft });
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
    if (out.character) U.download(`${out.character.id}.json`, CM.toFile(out.character));
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
  const GEN = E.StartGen;
  const JOB_KEY = 'ensemble.genJob';
  function savedJob(key) {
    try { const d = JSON.parse(store.get(JOB_KEY)); return d && d.key === key ? d.job : null; } catch (e) { return null; }
  }
  const saveJob = (job) => { if (U.gen) store.set(JOB_KEY, JSON.stringify({ key: U.gen.key, job })); };
  const dropJob = () => store.set(JOB_KEY, '');

  function openGenerator(world) {
    const key = `${world.folder}/${world.id}`;
    if (!U.gen || U.gen.key !== key) {
      const regions = GEN.regions(world.bundle.world);
      U.gen = { world, key, job: null, mode: 'form', region: regions.length ? regions[0].id : null, character: null, line: '', note: '', running: false, progress: null, error: '' };
    }
    U.gen.world = world;
    U.renderGen();
    $('genDialog').showModal();
  }
  Object.assign(U, { worldLabel, addScenarioOption, renderStarts, showPickInfo, loadServerList, beginGame, openCharacterForm, GEN, savedJob, saveJob, dropJob });
})();
