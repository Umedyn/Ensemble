// UI wiring. All game logic lives in engine/memory/prompts.
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;

  let state = null;
  let busy = false;
  let uiCut = null; // beat number the player wants to step in after
  let suggested = null; // suggested actions: { state, key, list } (see renderSuggestions)
  let uiShown = 1; // beats of the live scene revealed so far
  const openTurns = new Set(); // folded earlier turns the player has opened
  const notes = []; // undo/reroll history for the Debug panel
  const loaded = new Map(); // worlds in the picker; see "worlds and starts"

  // ---------- storage helpers (never fatal) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

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
  // loaded: key ("server:<folder>" or "disk:<folder>") -> a loaded world
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
    const show = !!(st && st.slot && !st.error);
    sel.innerHTML = !show ? '' : (st.defaultPlayer ? `<option value="default">Play as ${esc(st.defaultPlayer)}</option>` : '') + '<option value="own">Make my own</option>';
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
    try { list = await E.Scenario.listServer(); }
    catch (e) { addScenarioOption('', '— no scenarios/index.json —', true); return; }
    const worlds = await Promise.all(list.map((s) => E.Scenario.loadWorldServer(s.folder)
      .catch((e) => ({ folder: s.folder, title: s.title, error: e.message }))));
    // Options appear once every world is loaded, in index.json order.
    worlds.forEach((w, i) => { loaded.set('server:' + list[i].folder, w); addScenarioOption('server:' + list[i].folder, worldLabel(w)); });
    const pick = rememberedPick();
    if (pick.world && loaded.has(pick.world)) $('scenarioSelect').value = pick.world;
    renderStarts(pick.world === $('scenarioSelect').value ? pick.start : null, pick.who);
  }

  // The picked world, fetched again from the server so edited files show up
  // without a reload. Throws a world's load error.
  async function resolveWorld(key) {
    const item = loaded.get(key);
    if (!item) throw new Error('Pick a world first (or use Open folder).');
    if (item.error) throw new Error(item.error);
    const world = key.startsWith('server:') ? await E.Scenario.loadWorldServer(item.folder) : item;
    if (world.warnings.length) console.warn(`World "${world.title}":\n` + world.warnings.join('\n'));
    return world;
  }

  $('folderInput').addEventListener('change', async (ev) => {
    if (!ev.target.files.length) return;
    try {
      const { worlds, errors } = await E.Scenario.loadFromFiles(ev.target.files);
      worlds.forEach((w, i) => { loaded.set('disk:' + w.folder, w); diskAssets.set(w.folder, w.assets || {}); addScenarioOption('disk:' + w.folder, w.title + ' (disk)', i === 0); });
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
      if (startId === GEN_OPTION) { /* the generator below */ } else if (!makingOwn()) beginGame(world, E.Scenario.startScenario(world, startId));
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
    state = E.Engine.newGame(scenario);
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
    if (scenario.madePlayer) notes.push({ kind: 'character', summary: `you made ${state.characters[state.player].name}`, detail: JSON.stringify(E.CharMaker.toFile(state.characters[state.player]), null, 1) });
    autosave();
  }

  // ---------- character creator (task 4-1) ----------
  // The form for a start's playerSlot. E.CharMaker decides what's allowed and
  // builds the character; this only draws the form and keeps its values. The
  // draft is kept in this browser, so closing the form loses nothing.
  let maker = null; // { world, startId, sc, key, form, offers, pending, note, errors }
  const DRAFT_KEY = 'ensemble.makerDraft';
  const CM = E.CharMaker;
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
    maker = { sc: opts.sc, key: opts.key, onDone: opts.onDone, form, offers: {}, pending: null, note: '', errors: [] };
    $('makerTitle').textContent = opts.title;
    $('mkStart').textContent = opts.done;
    renderMaker();
    $('makerDialog').showModal();
  }
  const saveDraft = () => { if (maker) store.set(DRAFT_KEY, JSON.stringify({ key: maker.key, form: maker.form })); };

  function renderMaker() {
    if (!maker) return;
    const { sc, form, offers } = maker;
    const slot = sc.playerSlot;
    const L = CM.LIMITS;
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    const val = (k) => esc(form[k] == null ? '' : String(form[k]));
    const suggestBtn = (field) => `<button type="button" class="small mk-suggest" data-suggest="${field}" data-fk="sg-${field}"${maker.pending ? ' disabled' : ''} title="Ask the model for an idea; nothing changes until you pick it">${maker.pending === field ? 'Thinking…' : '💡 Suggest'}</button>`;
    const offerBox = (field) => (offers[field] ? `<div class="mk-offer"><span class="muted">Suggestion:</span> ${esc(offers[field])} <button type="button" class="small" data-offer-use="${field}" data-fk="use-${field}">Use</button> <button type="button" class="small ghost" data-offer-dismiss="${field}">Dismiss</button></div>` : '');
    const text = (k, label, max, rows) => `<label>${label}${rows ? `<textarea data-f="${k}" maxlength="${max}" rows="${rows}">${val(k)}</textarea>` : `<input type="text" data-f="${k}" maxlength="${max}" value="${val(k)}">`}</label>`;
    const choices = (key, list, title, freeText) => {
      if (!(list || []).length && !slot.freeform) return '';
      const listed = (list || []).some((r) => r.id === form[key]);
      const own = slot.freeform ? `<label class="mk-option"><input type="radio" name="mk-${key}" value="" data-choice="${key}"${listed ? '' : ' checked'}> <span><b>Something else</b> <input type="text" data-f="${freeText}" maxlength="60" value="${val(freeText)}" placeholder="Write your own" aria-label="Your own ${title.toLowerCase()}"></span></label>` : '';
      return `<fieldset class="mk-choices"><legend>${title}</legend>${(list || []).map((r) => `<label class="mk-option"><input type="radio" name="mk-${key}" value="${esc(r.id)}" data-choice="${key}"${form[key] === r.id ? ' checked' : ''}> <span><b>${esc(r.label)}</b>${r.desc ? ` <span class="muted">${esc(r.desc)}</span>` : ''}</span></label>`).join('')}${own}</fieldset>`;
    };
    const traitIdeas = [...new Set(CM.suggestedTraits(sc, form).concat(offers.traits || []))].filter((t) => !form.traits.some((x) => x.toLowerCase() === t.toLowerCase()));
    const left = CM.pointsLeft(sc, form.skills);
    const skills = sc.skills.map((k) => {
      const v = form.skills[k] || 0;
      return `<div class="mk-skill"><span>${esc(k)}</span><button type="button" class="small" data-skill="${esc(k)}" data-step="-1" data-fk="sk-${esc(k)}-" aria-label="Less ${esc(k)}"${v <= 0 ? ' disabled' : ''}>−</button><b>${v}</b><button type="button" class="small" data-skill="${esc(k)}" data-step="1" data-fk="sk-${esc(k)}+" aria-label="More ${esc(k)}"${v >= slot.maxSkill || left <= 0 ? ' disabled' : ''}>+</button></div>`;
    }).join('');
    const pics = [['standin', 'Stand-in'], ['none', 'Initials only']].concat((sc.portraitSet || []).map((p) => [p, null]));
    const portraits = pics.map(([v, label]) => {
      const url = label ? null : assetUrl(sc.folder, v);
      const name = v.split('/').pop();
      return `<label class="mk-pic"><input type="radio" name="mk-portrait" value="${esc(v)}" data-portrait="1"${form.portrait === v ? ' checked' : ''}> ${label ? esc(label) : url ? `<img src="${esc(url)}" alt="${esc(name)}" class="portrait">` : esc(name)}</label>`;
    }).join('');
    const feelings = CM.castFor(sc).map((id) => {
      const c = sc.characterData.find((d) => d.id === id);
      const v = form.feelings[id] || 0;
      return `<label class="mk-feel"><span>${esc(c.name)} <span class="muted small">${esc(c.role || '')}</span></span><input type="range" min="-100" max="100" step="5" value="${v}" data-feel-id="${esc(id)}" aria-label="Your feelings toward ${esc(c.name)}"><span class="rel-${E.relWord(v)}" data-feel-out="${esc(id)}">${E.relWord(v)} ${v > 0 ? '+' : ''}${v}</span></label>`;
    }).join('');
    $('makerBody').innerHTML =
      '<div class="mk-row">' +
        `<label class="mk-name">Name<input type="text" data-f="name" maxlength="${L.name}" value="${val('name')}" autocomplete="off"></label>` +
        `<label>Pronouns<input type="text" data-f="pronouns" maxlength="${L.pronouns}" value="${val('pronouns')}" list="mkPronouns"></label>` +
        `<label class="mk-age">Age<input type="number" data-f="age" min="1" max="129" value="${val('age')}"></label>` +
      '</div><datalist id="mkPronouns"><option value="she/her"><option value="he/him"><option value="they/them"></datalist>' +
      choices('role', slot.roles, 'Role', 'roleText') +
      choices('people', slot.peoples, 'People', 'peopleText') +
      `<div class="mk-field">${text('description', 'Who you are', L.description, 3)}${suggestBtn('description')}${offerBox('description')}</div>` +
      text('appearance', 'Appearance (the first sentence is how the story sees you)', L.appearance, 2) +
      `<fieldset class="mk-traits"><legend>Traits</legend><div>${form.traits.map((t, i) => `<span class="tag mk-chip">${esc(t)} <button type="button" class="ghost" data-trait-remove="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('') || '<span class="muted small">None yet.</span>'}</div>` +
        `<div class="row"><input type="text" id="mkTrait" maxlength="${L.trait}" placeholder="Add a trait" aria-label="Add a trait" data-fk="trait-in"><button type="button" class="small" id="mkTraitAdd">Add</button>${suggestBtn('traits')}</div>` +
        (traitIdeas.length ? `<div class="mk-ideas"><span class="muted small">Ideas:</span> ${traitIdeas.map((t) => `<button type="button" class="small mk-idea" data-trait-add="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>` : '') +
      '</fieldset>' +
      `<div class="mk-field">${text('voice', 'Voice (how you talk)', L.voice)}${suggestBtn('voice')}${offerBox('voice')}</div>` +
      text('want', 'What you want', L.want) +
      `<div class="mk-row">${text('secret', 'A secret (optional; the others may find it out)', L.secret, 2)}<label class="mk-guard">How well you keep it<select data-f="guard">${['low', 'medium', 'high'].map((g) => `<option value="${g}"${form.guard === g ? ' selected' : ''}>${g}</option>`).join('')}</select></label></div>` +
      `<fieldset class="mk-skills"><legend>Skills: <span class="${left < 0 ? 'fail' : ''}">${left} of ${slot.skillPoints} points left</span>, up to ${slot.maxSkill} each</legend>${skills}</fieldset>` +
      `<fieldset class="mk-pics"><legend>Portrait</legend>${portraits}</fieldset>` +
      (feelings ? `<fieldset class="mk-feelings"><legend>How you feel about them at the start</legend>${feelings}</fieldset>` : '') +
      (maker.note ? `<div class="fail small">${esc(maker.note)}</div>` : '');
    $('makerErrors').innerHTML = maker.errors.map((e) => `<li>${esc(e)}</li>`).join('');
    if (focusKey) { const el = $('makerBody').querySelector(`[data-fk="${focusKey}"]`); if (el && !el.disabled) el.focus(); }
  }

  $('makerBody').addEventListener('input', (ev) => {
    if (!maker) return;
    const t = ev.target;
    if (t.dataset.f) maker.form[t.dataset.f] = t.dataset.f === 'age' ? (t.value === '' ? null : Number(t.value)) : t.value;
    // Typing your own role or people picks "Something else".
    if (t.dataset.f === 'roleText' || t.dataset.f === 'peopleText') {
      const radio = t.closest('.mk-option').querySelector('input[type=radio]');
      radio.checked = true;
      maker.form[radio.dataset.choice] = '';
    }
    if (t.dataset.feelId) {
      const v = Number(t.value);
      maker.form.feelings[t.dataset.feelId] = v;
      const out = $('makerBody').querySelector(`[data-feel-out="${t.dataset.feelId}"]`);
      out.textContent = `${E.relWord(v)} ${v > 0 ? '+' : ''}${v}`;
      out.className = 'rel-' + E.relWord(v);
    }
    saveDraft();
  });
  $('makerBody').addEventListener('change', (ev) => {
    if (!maker) return;
    const t = ev.target;
    if (t.dataset.choice) {
      maker.form[t.dataset.choice] = t.value;
      // A listed role brings its skills; your own keeps what you set.
      if (t.dataset.choice === 'role' && t.value) maker.form.skills = CM.roleSkills(maker.sc, t.value);
    } else if (t.dataset.portrait) maker.form.portrait = t.value;
    else return;
    saveDraft();
    renderMaker();
  });
  function addTrait(t) {
    const v = String(t || '').trim().slice(0, CM.LIMITS.trait);
    if (maker.offers.traits) maker.offers.traits = maker.offers.traits.filter((x) => x !== t);
    if (!v || maker.form.traits.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    maker.form.traits.push(v);
  }
  $('makerBody').addEventListener('keydown', (ev) => {
    if (!maker || ev.target.id !== 'mkTrait' || ev.key !== 'Enter') return;
    ev.preventDefault();
    addTrait(ev.target.value);
    saveDraft();
    renderMaker();
    $('mkTrait').focus();
  });
  $('makerBody').addEventListener('click', (ev) => {
    if (!maker) return;
    const b = ev.target.closest('button');
    if (!b) return;
    const f = maker.form;
    if (b.dataset.skill) {
      const k = b.dataset.skill;
      const next = Object.assign({}, f.skills, { [k]: (f.skills[k] || 0) + Number(b.dataset.step) });
      if (CM.skillProblems(maker.sc, next).length) return;
      f.skills = next;
    } else if (b.dataset.traitRemove != null) f.traits.splice(Number(b.dataset.traitRemove), 1);
    else if (b.dataset.traitAdd != null) addTrait(b.dataset.traitAdd);
    else if (b.id === 'mkTraitAdd') addTrait($('mkTrait').value);
    else if (b.dataset.suggest) return void runSuggest(b.dataset.suggest);
    else if (b.dataset.offerUse) { f[b.dataset.offerUse] = maker.offers[b.dataset.offerUse]; maker.offers[b.dataset.offerUse] = null; }
    else if (b.dataset.offerDismiss) maker.offers[b.dataset.offerDismiss] = null;
    else return;
    saveDraft();
    renderMaker();
  });
  // One field from the model, offered and never applied on its own.
  async function runSuggest(field) {
    if (!maker || maker.pending) return;
    const m = maker;
    m.pending = field;
    m.note = '';
    renderMaker();
    try { m.offers[field] = await CM.suggest(m.sc, field, m.form); }
    catch (e) { m.note = e.message; }
    m.pending = null;
    if (maker === m) renderMaker();
  }
  $('makerForm').addEventListener('submit', (ev) => ev.preventDefault());
  $('mkClose').addEventListener('click', () => $('makerDialog').close());
  $('makerDialog').addEventListener('close', () => { maker = null; });
  $('mkSave').addEventListener('click', () => {
    if (!maker) return;
    const out = CM.build(maker.sc, maker.form);
    maker.errors = out.errors || [];
    renderMaker();
    if (out.character) download(`${out.character.id}.json`, CM.toFile(out.character));
  });
  $('mkLoad').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file || !maker) return;
    try {
      maker.form = CM.formFrom(maker.sc, JSON.parse(await file.text()));
      maker.offers = {};
      maker.errors = [];
      saveDraft();
    } catch (e) {
      maker.errors = [`That file isn't a character: ${e.message}`];
    }
    renderMaker();
  });
  $('mkStart').addEventListener('click', () => {
    if (!maker) return;
    const out = CM.build(maker.sc, maker.form);
    const errors = out.errors || maker.onDone(out.character);
    if (errors && maker) { maker.errors = errors; renderMaker(); }
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
      const regions = GEN.regions(w);
      if (regions.length) {
        html += `<fieldset class="mk-choices"><legend>Where</legend>${regions.map((r) => `<label class="mk-option"><input type="radio" name="gen-region" value="${esc(r.id)}"${gen.region === r.id ? ' checked' : ''}> <span><b>${esc(r.name)}</b>${r.lore ? ` <span class="muted">${esc(r.lore)}</span>` : ''}</span></label>`).join('')}</fieldset>`;
      }
      const c = gen.character;
      html += '<fieldset class="mk-choices"><legend>You</legend>' +
        `<label class="mk-option"><input type="radio" name="gen-mode" value="form"${gen.mode === 'form' ? ' checked' : ''}> <span><b>Make a character</b> ${c ? `<span class="muted">${esc(c.name)}, ${esc(c.role)}</span> ` : ''}<button type="button" id="genMake" class="small">${c ? 'Edit' : 'Make one'}</button></span></label>` +
        `<label class="mk-option"><input type="radio" name="gen-mode" value="line"${gen.mode === 'line' ? ' checked' : ''}> <span><b>Describe one in a line</b> <input type="text" id="genLine" maxlength="300" value="${esc(gen.line)}" placeholder="a trucker who just wants to get to the coast" aria-label="Describe your character in a line"></span></label>` +
        '</fieldset>' +
        `<label>What kind of story (optional)<textarea id="genNote" maxlength="400" rows="2" placeholder="quiet and tense; someone here is lying">${esc(gen.note)}</textarea></label>` +
        '<div class="muted small">The story engine writes the place, the people, their ties and an opening, one small step at a time (about 9 calls; several minutes on a local model). You can retry any step.</div>' +
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
  });
  $('genBody').addEventListener('click', (ev) => {
    if (!gen) return;
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.id === 'genMake') {
      gen.mode = 'form';
      const g = gen;
      openCharacterForm({
        sc: GEN.slotScenario(g.world, g.region), key: `${g.key}/generated`, title: `Make your character: ${g.world.title}`, done: 'Use this character',
        onDone: (c) => { g.character = c; $('makerDialog').close(); renderGen(); return null; },
      });
    } else if (b.id === 'genGo') {
      try {
        gen.job = GEN.newJob(gen.world, { region: gen.region, note: gen.note, character: gen.mode === 'form' ? gen.character : null, line: gen.mode === 'line' ? gen.line : '' });
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
      const label = { opening: 'the opening', ties: 'the pressures', extras: 'the minor people' }[b.dataset.rvRedo];
      rerollRun(`Rerolling ${label}`, () => GEN.redoOnly(gen.world, gen.job, b.dataset.rvRedo));
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
    const roomName = (id) => (s.rooms.rooms.find((r) => r.id === id) || {}).name || id;
    const o = s.opening;
    const hidden = '<div class="muted small">Hidden. Turn on spoilers to see or edit it.</div>';
    let html = `<label class="web-toggle rv-spoil"><input type="checkbox" id="rvSpoil"${gen.spoilers ? ' checked' : ''}> Show spoilers (secrets, private facts, notes for the story engine)</label>`;
    html += `<section class="rv-section"><div class="rv-head"><h4>Opening</h4>${reroll('data-rv-redo="opening"', 'Reroll', 'Write the opening again; everything else stays')}</div>` +
      field('opening', '', 'title', o.title, { label: 'Title' }) +
      field('opening', '', 'summary', o.summary, { label: 'Summary (shown in the picker)', rows: 2 }) +
      field('opening', '', 'opening', o.opening, { label: 'Opening scene', rows: 8 }) +
      field('opening', '', 'facts', (o.facts || []).join('\n'), { label: 'Facts everyone knows (one per line)', rows: 3 }) + '</section>';
    html += '<section class="rv-section"><div class="rv-head"><h4>Places</h4></div>' +
      `<div id="rvMap" class="rv-map">${previewMapHtml()}</div>` +
      s.rooms.rooms.map((r) => `<div class="rv-card"><div class="rv-head"><b>${esc(r.name)}</b>${r.id === s.rooms.playerRoom ? ' <span class="tag">you start here</span>' : ''}${reroll(`data-rv-room="${esc(r.id)}"`, 'Reroll', 'A new name and description; it stays where it is')}</div>` +
        field('room', r.id, 'name', r.name, { label: 'Name' }) + field('room', r.id, 'desc', r.desc, { label: 'Description', rows: 2 }) +
        `<div class="muted small">Connects to ${esc(r.connects.map(roomName).join(', ') || 'nothing')}</div></div>`).join('') + '</section>';
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
      s.ties.clocks.map((c) => `<div class="rv-card">${field('clock', c.id, 'name', c.name, { label: 'Name' })}` +
        `<div class="rv-row">${field('clock', c.id, 'max', c.max, { label: 'Steps until it comes to a head', type: 'number' })}${field('clock', c.id, 'perHour', c.perHour, { label: 'Steps per hour', type: 'number', step: '0.01' })}</div>` +
        field('clock', c.id, 'fireText', c.fireText, { label: 'What happens then', rows: 2 }) + '</div>').join('') + '</section>';
    const ex = s.extras;
    html += `<section class="rv-section"><div class="rv-head"><h4>Minor people and groups</h4>${reroll('data-rv-redo="extras"', 'Reroll', 'New minor people and groups')}</div>` +
      (ex.extras.length || ex.standees.length ? `<ul class="rv-list">${ex.extras.map((x) => `<li><b>${esc(x.name)}</b>, ${esc(x.role)}${x.location ? `, in ${esc(roomName(x.location))}` : ''}${gen.spoilers && x.note ? ` <span class="muted">${esc(x.note)}</span>` : ''}</li>`).join('')}` +
        `${ex.standees.map((g) => `<li><b>${g.count} ${esc(g.label)}</b>, ${esc(g.state)}, in ${esc(roomName(g.location))}${gen.spoilers && g.note ? ` <span class="muted">${esc(g.note)}</span>` : ''}</li>`).join('')}</ul>` : '<div class="muted small">None.</div>') + '</section>';
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

  function autosave() { if (state) store.set('ensemble.autosave', JSON.stringify(state)); }

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
      $('actionInput').value = '';
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
    const html = groups.map((g) => {
      if (g.chapter) return renderEntry(g.chapter);
      const body = g.entries.map(renderEntry).join('');
      if (g.turn === state.turn) return `<div class="turn-current" data-turn="${g.turn}">${body}</div>`;
      return `<details class="turn-group" data-turn="${g.turn}"${openTurns.has(g.turn) ? ' open' : ''}><summary>${turnSummary(g)}</summary>${body}</details>`;
    }).join('');
    log.innerHTML = html || '<div class="empty">Write your first action below.</div>';
    if (state.flags.gameOver) log.insertAdjacentHTML('beforeend', '<div class="entry chapter"><b>Your story ends here.</b>Load a save or start a new game.</div>');
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
  $('log').addEventListener('toggle', (ev) => {
    const d = ev.target;
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
    return `${state.scenario.timeLabel || 'Day'} ${t.day}, ${t.hhmm}`;
  }

  function liveScene() {
    const e = state && state.pending && state.log.find((x) => x.type === 'scene' && x.turn === state.pending.turn);
    return e && e.beats && e.beats.length > 1 ? e : null;
  }

  // The live scene is revealed one beat at a time. Under the newest beat the
  // player either steps in or moves on; moving on settles that beat for good.
  // Beats after a step-in never happened, so they are never shown.
  function renderScene(e) {
    if (!e.beats || e.beats.length < 2) return `<div class="entry scene">${esc(e.text)}</div>`;
    const live = state.pending && state.pending.turn === e.turn;
    const shown = live ? Math.min(uiShown, e.beats.length) : (e.cutAt || e.beats.length);
    let h = e.beats.slice(0, shown).map((b, i) =>
      `<div class="beat" data-beat="${i}"><div class="beat-time">${beatClock(e, b)}</div><div class="entry scene">${esc(b.text)}</div></div>`
    ).join('');
    if (live && shown < e.beats.length) {
      const on = uiCut === shown;
      h += `<div class="interject"><button type="button" data-cut="${shown}" class="${on ? 'active' : ''}">${on ? '✓ Stepping in here (click to cancel)' : '↩ Step in here'}</button>` +
        `<button type="button" data-next>Next ▸</button></div>`;
    } else if (!live && e.cutAt) {
      h += '<div class="beat-note">You stepped in here; the rest didn\'t happen.</div>';
    }
    return h;
  }

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
    const clocks = state.clocks.map((c) => {
      const pct = Math.round((c.value / c.max) * 100);
      return `<div class="clock"><div class="label"><span>${esc(c.name)}</span><span class="muted">${c.fired ? 'happened' : pct + '%'}</span></div>` +
        `<div class="bar ${pct >= 75 || c.fired ? 'danger' : ''}"><i style="width:${c.fired ? 100 : pct}%"></i></div></div>`;
    }).join('');
    const world = Object.entries(state.world).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join('');
    const groups = (state.factions || []).map((f) => `<div title="${esc(f.desc)}"><b>${esc(f.name)}</b>: ${esc(f.stance)}</div>`).join('');
    $('situation').innerHTML = clocks + `<div class="world">${world}</div>` + regionHtml() + (groups ? `<div class="world groups">${groups}</div>` : '');
  }

  // The player's region (task 3-1): who holds it, its tags and status. The map views come later.
  function regionHtml() {
    const id = E.Engine.playerRegion(state);
    const def = id && E.Engine.regionDef(state, id);
    const r = def && state.regions && state.regions[id];
    if (!r) return '';
    const f = r.controller && (state.factions || []).find((x) => x.id === r.controller);
    const bits = [`held by ${f ? f.name : 'no one'}`].concat(r.tags.length ? [r.tags.join(', ')] : [], r.status ? [r.status] : []);
    return `<div class="world groups" title="${esc(def.lore || '')}"><b>${esc(def.name)}</b>: ${esc(bits.join('; '))}</div>`;
  }

  const regionName = (id) => { const d = id && E.Engine.regionDef(state, id); return d ? ` · ${esc(d.name)}` : ''; };
  function renderNews() {
    const news = (state.news || []).slice().reverse().slice(0, 6);
    $('newsPanel').classList.toggle('hidden', !news.length);
    $('news').innerHTML = news.map((n) =>
      `<div class="news-item"><span class="muted">${n.scope === 'world' ? '🌍' : '🗺️'} ${esc(n.time)}${regionName(n.region)}</span><div>${esc(n.text)}</div>` +
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
    const authored = home ? (sc.locations && sc.locations.length ? sc.locations : Object.values(state.locations).filter((l) => !l.site)) : E.Sites.rooms(state, site);
    if (planCache.key !== key) planCache = { key, plan: E.Layouts.plan(authored, { type: home && sc.site ? sc.site.type : null, seed: `${sc.worldId}:${home ? sc.startId : site}`, linkLocs: state.locations }) };
    return planCache.plan;
  }
  // Tokens by room, as the player knows them.
  function mapTokens() {
    const byRoom = {};
    const add = (loc, t) => { if (loc && state.seenRooms.includes(loc)) (byRoom[loc] = byRoom[loc] || []).push(t); };
    const pc = state.characters[state.player];
    add(pc.status.location, { kind: 'character', id: state.player, label: pc.name, player: true, now: true });
    E.Engine.cast(state, { alive: true, includePlayer: false }).forEach((id) => {
      const kw = E.Engine.knownWhere(state, id);
      if (kw) add(kw.loc, { kind: 'character', id, label: state.characters[id].name, now: kw.now, turn: kw.turn });
    });
    Object.values(state.extras || {}).forEach((x) => {
      const kw = E.Engine.knownWhere(state, x.id);
      if (kw) add(kw.loc, { kind: 'extra', id: x.id, label: x.name, now: kw.now, turn: kw.turn });
    });
    Object.values(state.standees || {}).forEach((g) => {
      const kw = E.Engine.knownWhere(state, g.id);
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
  // Tokens in a row (wrapping) inside a room's box; the rest as "+N".
  function roomTokens(list, x, y, w, h) {
    const r = 9, step = 2 * r + 4;
    const cols = Math.max(1, Math.floor((w - 8) / step));
    const rows = Math.max(1, Math.floor((h - 4) / step));
    const fit = cols * rows;
    const shown = list.length > fit ? list.slice(0, fit - 1) : list;
    let out = shown.map((t, i) => tokenSvg(t, x + 4 + r + (i % cols) * step, y + r + 2 + Math.floor(i / cols) * step, r)).join('');
    if (list.length > shown.length) {
      const i = shown.length;
      out += `<text class="map-more" x="${x + 4 + (i % cols) * step + 2}" y="${y + r + 6 + Math.floor(i / cols) * step}">+${list.length - shown.length}</text>`;
    }
    return out;
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
    return E.SiteDraw.render(plan, rooms, { inView, remembered, here, seed: `${sc.worldId}:${site === E.Sites.HOME ? sc.startId : site}`, links, tokens, tokenSvg });
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
  function localMapHtml() {
    const here = state.characters[state.player].status.location;
    const tokens = mapTokens();
    const seen = (id) => state.seenRooms.includes(id);
    const roomName = (id) => (seen(id) ? state.locations[id].name : 'unknown room');
    const site = E.Sites.playerSite(state);
    const lm = site === E.Sites.HOME ? state.scenario.localMap : null;
    let svg;
    if (lm) {
      const url = portraitUrl(lm.image);
      const rooms = Object.entries(lm.rooms).map(([id, r]) => `<g class="map-room${id === here ? ' here' : ''}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(roomName(id))}"><rect class="floor" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" style="fill-opacity:0.15"/>${roomTokens(tokens[id] || [], r.x, r.y, r.w, r.h)}</g>`).join('');
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
        const toks = roomTokens(tokens[id] || [], x, y + 18, w, h - (up.length ? 42 : 30));
        return `<g class="${cls}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(roomName(id))}"><rect class="floor" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>${label}${upText}${feats}</g><g class="map-tokens">${toks}</g>`;
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
    // Ways to other places (routes, task 4-4): clicking one fills in the action box.
    const routes = E.Sites.routes(state, site);
    if (routes.length) svg += `<div class="map-routes">Ways to other places: ${routes.map((r) => `<button type="button" class="small map-route" data-name="${esc(r.name)}" title="From ${esc(state.locations[r.from].name)}">↗ ${esc(r.name)}</button>`).join(' ')}</div>`;
    // The same in words, for screen readers.
    const list = Object.keys(state.locations).filter((id) => seen(id) && E.Sites.siteOf(state, id) === site).map((id) => {
      const who = (tokens[id] || []).map((t) => (t.player ? 'you' : t.kind === 'standee' ? `${t.count} ${t.label}` : t.label) + (t.now ? '' : ' (last seen)'));
      return `<li>${esc(state.locations[id].name)}${id === here ? ' (you are here)' : ''}: ${esc(who.join(', ') || 'no one you know of')}</li>`;
    }).join('');
    return svg + `<ul class="sr-only" id="mapList">${list}</ul>`;
  }

  // ---------- world and regional views (task 3-4) ----------
  // Regions coloured by who holds them (theme colours --f1…--f8, picked by
  // the faction's "color" or a hash of its id), tag badges, your region
  // marked, and an info strip for the region you pick. Public state only:
  // controller, tags, status and the lore summary. The regional view is the
  // same map zoomed to your region and its neighbours. Drag to pan; wheel,
  // pinch or the buttons to zoom.
  const MAPVIEW_KEY = 'ensemble.mapview';
  let mapSel = null; // the region picked for the info strip
  const viewBoxes = {}; // per view: the panned/zoomed viewBox, until reset or a new game
  const pulsed = new Set(); // "id@turn": a change pulses once
  function mapViewAll() { try { return JSON.parse(store.get(MAPVIEW_KEY)) || {}; } catch (e) { return {}; } }
  const hasRegions = () => !!(state && (state.scenario.regions || []).length);
  function mapView() {
    const v = hasRegions() ? mapViewAll()[state.scenario.worldId] : null;
    return ['local', 'region', 'world'].includes(v) ? v : 'local';
  }
  const factionClass = (fid) => E.MapDraw.factionClass(state.factions, fid);
  const factionName = (fid) => E.MapDraw.factionName(state.factions, fid);
  const worldGeometry = () => E.MapDraw.geometry(state.scenario.regions, state.scenario.map, state.scenario.worldId);
  function worldMapHtml(view) {
    const g = worldGeometry();
    const mine = E.Engine.playerRegion(state);
    const near = E.Engine.nearbyRegions(state);
    const defaultBox = view === 'region' && near.length ? E.MapDraw.focusBox(g, mine, near) : g.full;
    // A region changed this turn pulses once.
    const pulse = (state.scenario.regions || []).filter((r) => {
      const ch = (state.regionChanged || {})[r.id];
      const key = `${r.id}@${state.turn}`;
      if (!ch || ch.turn !== state.turn || pulsed.has(key)) return false;
      pulsed.add(key);
      return true;
    }).map((r) => r.id);
    // Rooms placed on the map, in the regional view.
    const rooms = view === 'region' && g.image && g.image.locations
      ? Object.entries(g.image.locations).filter(([id]) => state.locations[id] && state.seenRooms.includes(id)).map(([id, p]) => ({ x: p[0], y: p[1], name: state.locations[id].name }))
      : [];
    return E.MapDraw.worldSvg({
      g, regions: state.scenario.regions, now: state.regions, factions: state.factions, mine, selected: mapSel, pulse, rooms,
      imageUrl: g.image && portraitUrl(g.image.image), viewBox: viewBoxes[view] || defaultBox, id: 'worldSvg', view,
      label: view === 'world' ? 'World map' : 'Map of your region and its neighbours',
    }) + regionInfoHtml(view);
  }
  function regionInfoHtml(view) {
    const id = mapSel || E.Engine.playerRegion(state);
    const r = id && E.Engine.regionDef(state, id);
    if (!r) return '<div class="region-info muted">Pick a region to see who holds it.</div>';
    const now = state.regions[id];
    const ch = (state.regionChanged || {})[id];
    const fc = factionClass(now.controller);
    const bits = [`<b>${esc(r.name)}</b>${id === E.Engine.playerRegion(state) ? ' (you are here)' : ''}`,
      `<span class="swatch ${fc}"></span>held by ${esc(factionName(now.controller))}`];
    if (now.status) bits.push(esc(now.status));
    if (now.tags.length) bits.push(`tags: ${esc(now.tags.join(', '))}`);
    let html = `<div class="region-info" id="regionInfo">${bits.join(' · ')}`;
    if (ch && ch.turn === state.turn) html += `<div class="changed">This turn: ${esc(ch.what.join(', '))}.</div>`;
    if (r.lore) html += `<div class="muted">${esc(r.lore)}</div>`;
    if (view === 'region' && id === E.Engine.playerRegion(state)) {
      const placed = (state.scenario.map && state.scenario.map.locations) || {};
      const rest = Object.values(state.locations).filter((l) => l.region === id && !l.site && !placed[l.id] && state.seenRooms.includes(l.id)).map((l) => l.name);
      if (rest.length) html += `<div class="muted">Rooms here: ${esc(rest.join(', '))}</div>`;
    }
    // Places made during the story (task 4-4), in this region.
    const places = Object.values(state.sites || {}).filter((s) => s.region === id);
    if (places.length) html += `<div class="muted">Places: ${places.map((s) => esc(s.name) + (s.stub ? (s.visits ? ' (been there)' : ' (not visited yet)') : '')).join(', ')}</div>`;
    return html + '</div>';
  }
  function renderMap() {
    const pane = $('mapPane');
    if (!state) { pane.innerHTML = ''; return; }
    const view = mapView();
    const tabs = hasRegions()
      ? `<div class="map-tabs" role="group" aria-label="Map level">${['local', 'region', 'world'].map((v, i) => `<button type="button" data-mapview="${v}" class="${i === 2 ? 'last' : ''}" aria-pressed="${v === view}">${({ local: 'Local', region: 'Region', world: 'World' })[v]}</button>`).join('')}` +
        (view === 'local' ? '' : `<span class="zoom"><button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button><button type="button" data-zoom="reset" aria-label="Reset the view" title="Reset the view">⟲</button></span>`) + '</div>'
      : '';
    pane.innerHTML = tabs + (view === 'local' ? localMapHtml() : worldMapHtml(view));
    sizeDetailedMap();
  }
  // Zoom the world map's viewBox around a point (in map units), within limits.
  function zoomWorld(factor, cx, cy) {
    const svg = $('worldSvg');
    if (!svg) return;
    const view = svg.dataset.view;
    const [x, y, w, h] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    const full = worldGeometry().full;
    const nw = Math.min(full[2] * 2, Math.max(full[2] / 8, w * factor)), nh = h * (nw / w);
    const px = cx == null ? x + w / 2 : cx, py = cy == null ? y + h / 2 : cy;
    viewBoxes[view] = [px - (px - x) * (nw / w), py - (py - y) * (nh / h), nw, nh];
    svg.setAttribute('viewBox', viewBoxes[view].map((n) => Math.round(n)).join(' '));
  }
  const toMap = (svg, ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
  };
  const pointers = new Map();
  let drag = null;
  $('mapPane').addEventListener('pointerdown', (ev) => {
    const svg = ev.target.closest && ev.target.closest('#worldSvg');
    if (!svg) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    drag = { moved: false, start: { x: ev.clientX, y: ev.clientY }, vb: svg.getAttribute('viewBox').split(/\s+/).map(Number), dist: null };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag.dist = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  $('mapPane').addEventListener('pointermove', (ev) => {
    const svg = $('worldSvg');
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
    const svg = $('worldSvg');
    if (svg) svg.classList.remove('panning');
    const wasDrag = drag && drag.moved;
    if (!pointers.size) drag = null;
    if (ev.type === 'pointerup' && !wasDrag && ev.target.closest) {
      const g = ev.target.closest('.region-g');
      if (g) { mapSel = g.dataset.region; renderMap(); }
    }
  };
  $('mapPane').addEventListener('pointerup', endDrag);
  $('mapPane').addEventListener('pointercancel', endDrag);
  $('mapPane').addEventListener('wheel', (ev) => {
    const svg = ev.target.closest && ev.target.closest('#worldSvg');
    if (!svg) return;
    ev.preventDefault();
    const p = toMap(svg, ev);
    zoomWorld(ev.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  }, { passive: false });
  $('mapPane').addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-mapview]');
    if (tab && state) {
      const all = mapViewAll();
      all[state.scenario.worldId] = tab.dataset.mapview;
      store.set(MAPVIEW_KEY, JSON.stringify(all));
      mapSel = null;
      return renderMap();
    }
    const z = ev.target.closest('[data-zoom]');
    if (z) {
      if (z.dataset.zoom === 'reset') { const v = mapView(); delete viewBoxes[v]; return renderMap(); }
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
    const route = el.closest('.map-route');
    if (route) return fillAction(`Go to ${route.dataset.name}.`);
    // A gameplay piece on the detailed map (task 3-7); decoration has no data.
    const feat = el.closest('.map-feature');
    if (feat) return fillAction(`Look at ${/^(the|a|an|my|your|his|her|their|\w+'s)\b/i.test(feat.dataset.feature) ? '' : 'the '}${feat.dataset.feature}.`);
    const room = el.closest('.map-room');
    if (!room) return;
    const id = room.dataset.room;
    if (id === state.characters[state.player].status.location) return;
    fillAction(state.seenRooms.includes(id) ? `Go to the ${state.locations[id].name}.` : 'Find out what is through there.');
  }
  $('mapPane').addEventListener('click', (ev) => mapActivate(ev.target));
  $('mapPane').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const reg = ev.target.closest && ev.target.closest('.region-g');
    if (reg) { ev.preventDefault(); mapSel = reg.dataset.region; renderMap(); const el = document.querySelector(`.region-g[data-region="${reg.dataset.region}"]`); if (el) el.focus(); return; }
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
  $('cast').addEventListener('error', (ev) => {
    const img = ev.target;
    if (img.tagName !== 'IMG' || !img.dataset.fallback) return;
    failedUrls.add(img.getAttribute('src'));
    img.outerHTML = monogramHtml(img.dataset.fallback);
  }, true);

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
  function cardHeader(id, c, isPlayer) {
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
    return `<div class="top">${portraitHtml(id)}<div class="who"><div class="nm">${esc(c.name)}${isPlayer ? ' (you)' : ''}</div><div class="role">${esc(c.role)}</div></div>${rels}${minButton(id, c, false)}</div>` +
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
    if (dead || !state.scenario.needs.length) return '';
    return `<div class="needs">${state.scenario.needs.map((n) => {
      const v = c.needs[n.id] || 0;
      return `<span>${esc(n.label || n.id)}</span><div class="bar ${v >= 0.85 ? 'danger' : ''}"><i style="width:${Math.round(v * 100)}%"></i></div>`;
    }).join('')}</div>`;
  }

  // Collapsed details about the person: who they are, needs, and what you know
  // about them (only facts the player knows). Open ones stay open across re-renders.
  const openCards = new Set();
  const KNOWN_SHOWN = 6;
  function cardDetails(id, c, dead) {
    const who = [c.pronouns, c.role, c.age].filter(Boolean).map(esc).join(' · ');
    const known = E.Engine.knownAbout(state, id);
    const knownHtml = known.length
      ? `<ul class="known">${known.slice(0, KNOWN_SHOWN).map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` +
        (known.length > KNOWN_SHOWN ? `<div class="muted small">and ${known.length - KNOWN_SHOWN} more in Debug › Fact store</div>` : '')
      : '<div class="muted small">Nothing yet.</div>';
    const body = `<div class="small muted">${who}</div>` +
      (c.description ? `<p class="desc">${esc(c.description)}</p>` : '') +
      (c.appearance ? `<p class="desc"><span class="muted">Looks:</span> ${esc(c.appearance)}</p>` : '') +
      (id !== state.player && !dead ? cardFeelings(id, c) : '') +
      (id === state.player && state.scenario.madePlayer === id ? '<button type="button" class="small" data-save-char>Save this character</button>' : '') +
      cardNeeds(c, dead) +
      `<div class="known-head">What you know</div>${knownHtml}`;
    return `<details class="card-details" data-card="${esc(id)}"${openCards.has(id) ? ' open' : ''}><summary>Details</summary>${body}</details>`;
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
      const left = E.settings.chapterLength - E.Memory.turnsInChapter(state);
      $('journal').innerHTML = `<div class="muted">Chapter ${state.chapter} in progress${state.turn ? ` (closes in about ${Math.max(left, 0)} turns)` : ''}.</div>`;
      return;
    }
    $('journal').innerHTML = state.chapters.slice().reverse().map((c) =>
      `<div class="journal-entry"><b>${c.n}. ${esc(c.title)}</b> <span class="turns">turns ${c.fromTurn}–${c.toTurn}</span><div>${esc(c.summary)}</div></div>`
    ).join('');
  }

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
      (state && Object.keys(state.sites || {}).length ? `<details><summary>Places made during the story (${Object.keys(state.sites).length})</summary><pre>${esc(sitesDebug())}</pre></details>` : '') +
      notes.slice().reverse().map((n) => `<details class="note"><summary><b>${esc(n.kind)}</b> · ${esc(n.summary)}</summary><pre>${esc(n.detail)}</pre></details>`).join('') +
      calls.map((c) => `<details><summary><b>${esc(c.kind)}</b> · ${esc(c.backend || '')} · ${c.ms} ms · ~${c.estTokens} tokens${c.overBudget ? ' <span class="fail">over context!</span>' : ''}${c.finish === 'length' ? ' <span class="fail">cut off at the token limit</span>' : ''}${c.salvaged ? ' <span class="fail">salvaged: kept the complete part</span>' : ''}${c.error ? ' <span class="fail">' + esc(c.error) + '</span>' : ''}</summary>
        <div class="muted">System (shared prefix)</div><pre>${esc(c.system)}</pre>
        <div class="muted">User</div><pre>${esc(c.user)}</pre>
        <div class="muted">Raw output</div><pre>${esc(c.raw)}</pre></details>`).join('') ||
      '<div class="muted">No model calls yet.</div>';
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
      const rows = t.calls.map((c) =>
        `<tr${c.error ? ' class="fail"' : ''}><td>${esc(c.kind)}${c.salvaged ? ' <span class="fail">salvaged</span>' : ''}${c.finish === 'length' ? ' <span class="fail">cut off</span>' : ''}</td><td>${esc(c.backend || '')}</td>` +
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
    box.querySelector('.bStatus').textContent = '';
    showPreset(box, b.preset);
    sel.onchange = () => {
      const p = E.backendPresets[sel.value] || {};
      box.querySelector('.bUrl').value = p.url || '';
      box.querySelector('.bModel').value = p.model || '';
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
    E.settings.chapterLength = E.clamp(parseInt($('sChapter').value, 10) || E.defaults.chapterLength, 2, 20);
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
  }
  function readAppearance() {
    return {
      theme: $('aTheme').value,
      textSize: E.clamp(parseInt($('aTextSize').value, 10) || 100, 90, 150),
      storyFont: $('aFont').value,
      lineSpacing: $('aSpacing').value,
      motion: $('aMotion').value,
      mapDetail: $('aMapDetail').value,
    };
  }
  ['aTheme', 'aTextSize', 'aFont', 'aSpacing', 'aMotion', 'aMapDetail'].forEach((id) => $(id).addEventListener('input', () => {
    $('aTextSizeOut').textContent = $('aTextSize').value + '%';
    applyAppearance(readAppearance());
    if (id === 'aMapDetail') { mapDetailPreview = $('aMapDetail').value; if (state) renderMap(); }
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
  document.querySelectorAll('#settings details.section').forEach((d) => {
    const k = 'ensemble.section.' + d.dataset.section;
    const v = store.get(k);
    if (v !== null) d.open = v === '1';
    d.addEventListener('toggle', () => store.set(k, d.open ? '1' : '0'));
  });
  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue === 'save') {
      readSettings();
      E.saveSettings();
      checkConnection(false);
      if (state) renderJournal();
    }
    applyAppearance(E.settings.appearance);
    if (mapDetailPreview) { mapDetailPreview = null; if (state) renderMap(); }
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

  async function boot() {
    const firstRun = store.get('ensemble.settings') === null && store.get('ensemble.setupDone') === null;
    E.loadSettings();
    applyAppearance(E.settings.appearance);
    initTimeSteps();
    await loadServerList();
    if (firstRun) openSetup();
    else checkConnection(false);
    const saved = store.get('ensemble.autosave');
    if (saved) {
      try {
        state = E.Engine.migrate(JSON.parse(saved));
        restoreView();
        showPickInfo(false);
        renderAll();
      } catch (e) { state = null; }
    }
  }
  boot();
})();
