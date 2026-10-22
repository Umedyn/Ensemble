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
    store.set(PICK_KEY, JSON.stringify({ world: $('scenarioSelect').value, start: $('startSelect').value }));
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
  // usable) it stays hidden and New game plays the default.
  function renderStarts(preferred) {
    const w = loaded.get($('scenarioSelect').value);
    const sel = $('startSelect');
    const starts = w && w.starts ? w.starts : [];
    sel.innerHTML = starts.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}${s.error ? ' (has errors)' : ''}</option>`).join('');
    sel.value = starts.some((s) => s.id === preferred) ? preferred : (w && w.defaultStart) || '';
    sel.classList.toggle('hidden', starts.length < 2);
    renderPickInfo();
  }

  // Desktop line under the pickers: the world's summary and tags, then who
  // you are in the picked start, or why it won't load.
  function renderPickInfo() {
    const w = loaded.get($('scenarioSelect').value);
    if (!w) { $('pickInfo').innerHTML = ''; return; }
    if (w.error) { $('pickInfo').innerHTML = `<span class="fail">${esc(w.error)}</span>`; return; }
    const st = w.starts.find((s) => s.id === $('startSelect').value);
    const tags = (w.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const start = !st ? '' : st.error
      ? `<br><span class="fail">This start can't be played: ${esc(st.error)}</span>`
      : st.summary ? `<br>${w.starts.length > 1 ? `<b>${esc(st.title)}:</b> ` : ''}${esc(st.summary)}` : '';
    $('pickInfo').innerHTML = `<b>${esc(w.title)}</b>${w.summary ? ' · ' + esc(w.summary) : ''}${tags}${start}`;
  }

  // The summary line shows while picking and folds away once a game is running.
  const showPickInfo = (on) => $('pickInfo').classList.toggle('hidden', !on);
  $('scenarioSelect').addEventListener('change', () => { renderStarts(); rememberPick(); showPickInfo(true); });
  $('startSelect').addEventListener('change', () => { renderPickInfo(); rememberPick(); showPickInfo(true); });

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
    renderStarts(pick.world === $('scenarioSelect').value ? pick.start : null);
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
    try {
      const world = await resolveWorld($('scenarioSelect').value);
      state = E.Engine.newGame(E.Scenario.startScenario(world, $('startSelect').value || undefined));
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
      autosave();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
    if (state) renderAll();
    $('actionInput').focus();
  });

  // File names: world and start titles, e.g. "ares-deep-sol-214-the-mule".
  function gameSlug(sc) {
    const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return [sc.worldTitle || sc.title, sc.startTitle].map(slug).filter(Boolean).join('-') || slug(sc.folder || sc.id) || 'game';
  }

  function autosave() { if (state) store.set('ensemble.autosave', JSON.stringify(state)); }

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
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
  // E.Layouts.plan places the rooms; this draws them as plain SVG with theme
  // colours: walls, a mark for each kind of link, labels, features, and
  // tokens where the player last saw everyone (faded when out of sight).
  // Clicking fills in the action box and never acts. A start's "localMap"
  // draws its floor-plan image with room hotspots instead.
  const CELL = 30;
  let planCache = { key: null, plan: null };
  function mapPlan() {
    const sc = state.scenario;
    const key = `${sc.worldId}|${sc.startId}|${Object.keys(state.locations).join(',')}`;
    if (planCache.key !== key) planCache = { key, plan: E.Layouts.plan(state.locations, { type: sc.site && sc.site.type, seed: `${sc.worldId}:${sc.startId}` }) };
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
  const KIND_WORD = { open: 'way', door: 'door', 'locked door': 'locked door', vent: 'vent', hatch: 'hatch', window: 'window', stairs: 'stairs' };
  function renderMap() {
    const pane = $('mapPane');
    if (!state) { pane.innerHTML = ''; return; }
    const here = state.characters[state.player].status.location;
    const tokens = mapTokens();
    const seen = (id) => state.seenRooms.includes(id);
    const roomName = (id) => (seen(id) ? state.locations[id].name : 'unknown room');
    const lm = state.scenario.localMap;
    let svg;
    if (lm) {
      const url = portraitUrl(lm.image);
      const rooms = Object.entries(lm.rooms).map(([id, r]) => `<g class="map-room${id === here ? ' here' : ''}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(roomName(id))}"><rect class="floor" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" style="fill-opacity:0.15"/>${roomTokens(tokens[id] || [], r.x, r.y, r.w, r.h)}</g>`).join('');
      svg = `<svg class="map-svg" viewBox="0 0 ${lm.width} ${lm.height}" role="img" aria-label="Map">${url ? `<image href="${esc(url)}" x="0" y="0" width="${lm.width}" height="${lm.height}"/>` : ''}${rooms}</svg>`;
    } else {
      const plan = mapPlan();
      const W = plan.width * CELL, H = plan.height * CELL;
      const levels = plan.levels.length > 1 ? plan.levels.map((b) => `<text class="map-level" x="${b.x * CELL}" y="${b.y * CELL - 9}">${b.level === 0 ? 'ground floor' : b.level > 0 ? `level ${b.level}` : `below ${-b.level}`}</text>`).join('') : '';
      const rooms = Object.entries(plan.rooms).map(([id, r]) => {
        const l = state.locations[id];
        const x = r.x * CELL, y = r.y * CELL, w = r.w * CELL, h = r.h * CELL;
        const cls = `map-room${l.outside ? ' outside' : ''}${id === here ? ' here' : ''}${seen(id) ? '' : ' unseen'}`;
        const label = seen(id) ? `<text class="map-label" x="${x + 5}" y="${y + 13}">${esc(E.shorten(l.name, Math.floor((w - 8) / 6.5)))}</text>` : `<text class="map-feat" x="${x + w / 2}" y="${y + h / 2 + 3}" text-anchor="middle">?</text>`;
        const feats = seen(id) && (l.features || []).length ? `<text class="map-feat" x="${x + 5}" y="${y + h - 5}">${esc(E.shorten(l.features.join(' · '), Math.floor(w / 5)))}</text>` : '';
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
      const marks = plan.links.filter((k) => !k.remote).map(linkMark).join('');
      // Never smaller than about three quarters of full size (the pane scrolls).
      svg = `<svg class="map-svg" viewBox="-4 -4 ${W + 8} ${H + 8}" style="min-width:${Math.round(W * 0.75)}px" role="img" aria-label="Map">${remote}${rooms}${marks}${levels}</svg>`;
    }
    // The same in words, for screen readers.
    const list = Object.keys(state.locations).filter(seen).map((id) => {
      const who = (tokens[id] || []).map((t) => (t.player ? 'you' : t.kind === 'standee' ? `${t.count} ${t.label}` : t.label) + (t.now ? '' : ' (last seen)'));
      return `<li>${esc(state.locations[id].name)}${id === here ? ' (you are here)' : ''}: ${esc(who.join(', ') || 'no one you know of')}</li>`;
    }).join('');
    pane.innerHTML = svg + `<ul class="sr-only" id="mapList">${list}</ul>`;
  }
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
    const room = el.closest('.map-room');
    if (!room) return;
    const id = room.dataset.room;
    if (id === state.characters[state.player].status.location) return;
    fillAction(state.seenRooms.includes(id) ? `Go to the ${state.locations[id].name}.` : 'Find out what is through there.');
  }
  $('mapPane').addEventListener('click', (ev) => mapActivate(ev.target));
  $('mapPane').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (!ev.target.closest('.map-token, .map-room')) return;
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
  function restoreView() { setView((state && viewAll()[state.scenario.worldId]) || 'split', false); }
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
  function portraitUrl(path) {
    const folder = state.scenario.folder;
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
  function renderDebug() {
    renderRecorder();
    if ($('debug').classList.contains('hidden')) return;
    const calls = E.LLM.calls.slice().reverse();
    const facts = state ? state.facts.map((f) => `[T${f.turn} w${f.weight}] ${f.text}   (known by: ${f.known_by.join(', ')})`).join('\n') : '';
    $('debugBody').innerHTML =
      renderTelemetry() +
      (state ? `<details><summary>Fact store (${state.facts.length})</summary><pre>${esc(facts)}</pre></details>` : '') +
      (state ? `<details><summary>Characters: needs, tiers, mood and tags</summary><pre>${esc(characterDebug())}</pre></details>` : '') +
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
  }
  function readAppearance() {
    return {
      theme: $('aTheme').value,
      textSize: E.clamp(parseInt($('aTextSize').value, 10) || 100, 90, 150),
      storyFont: $('aFont').value,
      lineSpacing: $('aSpacing').value,
      motion: $('aMotion').value,
    };
  }
  ['aTheme', 'aTextSize', 'aFont', 'aSpacing', 'aMotion'].forEach((id) => $(id).addEventListener('input', () => {
    $('aTextSizeOut').textContent = $('aTextSize').value + '%';
    applyAppearance(readAppearance());
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
