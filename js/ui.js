// UI wiring. All game logic lives in engine/memory/prompts.
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;

  let state = null;
  let busy = false;
  let uiCut = null; // beat number the player wants to step in after
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
      worlds.forEach((w, i) => { loaded.set('disk:' + w.folder, w); addScenarioOption('disk:' + w.folder, w.title + ' (disk)', i === 0); });
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
    try {
      const world = await resolveWorld($('scenarioSelect').value);
      state = E.Engine.newGame(E.Scenario.startScenario(world, $('startSelect').value || undefined));
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
      renderAll();
      $('actionInput').focus();
    } catch (e) {
      alert(e.message);
    }
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
  }

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
  function showWarning(msg) { showNote('⚠ ' + msg, 'warn'); }
  function showNote(msg, cls) {
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
      (present.length ? ` with ${esc(present.join(', '))}` : ', alone') + ` · Chapter ${state.chapter}, turn ${state.turn}`;
  }

  function renderSituation() {
    const clocks = state.clocks.map((c) => {
      const pct = Math.round((c.value / c.max) * 100);
      return `<div class="clock"><div class="label"><span>${esc(c.name)}</span><span class="muted">${c.fired ? 'happened' : pct + '%'}</span></div>` +
        `<div class="bar ${pct >= 75 || c.fired ? 'danger' : ''}"><i style="width:${c.fired ? 100 : pct}%"></i></div></div>`;
    }).join('');
    const world = Object.entries(state.world).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join('');
    const groups = (state.factions || []).map((f) => `<div title="${esc(f.desc)}"><b>${esc(f.name)}</b>: ${esc(f.stance)}</div>`).join('');
    $('situation').innerHTML = clocks + `<div class="world">${world}</div>` + (groups ? `<div class="world groups">${groups}</div>` : '');
  }

  function renderNews() {
    const news = (state.news || []).slice().reverse().slice(0, 6);
    $('newsPanel').classList.toggle('hidden', !news.length);
    $('news').innerHTML = news.map((n) =>
      `<div class="news-item"><span class="muted">${n.scope === 'world' ? '🌍' : '🗺️'} ${esc(n.time)}</span><div>${esc(n.text)}</div>` +
      (n.effects && n.effects.length ? `<div class="muted small">${n.effects.map(esc).join(' · ')}</div>` : '') + '</div>'
    ).join('');
  }

  // A cast card is composed from one function per section, in renderCast. Each
  // section returns its markup, or '' to leave it out.
  function renderCast() {
    $('castTitle').textContent = state.scenario.castLabel || 'People';
    const here = state.characters[state.player].status.location;
    $('cast').innerHTML = E.Engine.cast(state).map((id) => {
      const c = state.characters[id];
      const isPlayer = id === state.player;
      const dead = c.status.health === 'dead';
      const sections = [cardHeader(id, c, isPlayer), cardStatus(c), cardNeeds(c, dead), cardDetails(id, c)].filter(Boolean);
      return `<div class="card ${!isPlayer && c.status.location === here ? 'here' : ''} ${dead ? 'dead' : ''}">${sections.join('')}</div>`;
    }).join('');
  }

  // Name, role, how they and you feel about each other, and where they are.
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
    return `<div class="top"><div><div class="nm">${esc(c.name)}${isPlayer ? ' (you)' : ''}</div><div class="role">${esc(c.role)}</div></div>${rels}</div>` +
      `<div class="meta">${esc(loc ? loc.name : '?')}</div>`;
  }

  // Health and conditions.
  function cardStatus(c) {
    return `<div>${[E.healthWord(c.status.health)].concat(c.status.conditions).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
  }

  function cardNeeds(c, dead) {
    if (dead) return '';
    return `<div class="needs">${state.scenario.needs.map((n) => {
      const v = c.needs[n.id] || 0;
      return `<span>${esc(n.label || n.id)}</span><div class="bar ${v >= 0.85 ? 'danger' : ''}"><i style="width:${Math.round(v * 100)}%"></i></div>`;
    }).join('')}</div>`;
  }

  // Empty for now; the card redesign (task 1-7) fills it.
  function cardDetails() {
    return '';
  }

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
      notes.slice().reverse().map((n) => `<details class="note"><summary><b>${esc(n.kind)}</b> · ${esc(n.summary)}</summary><pre>${esc(n.detail)}</pre></details>`).join('') +
      calls.map((c) => `<details><summary><b>${esc(c.kind)}</b> · ${esc(c.backend || '')} · ${c.ms} ms · ~${c.estTokens} tokens${c.overBudget ? ' <span class="fail">over context!</span>' : ''}${c.finish === 'length' ? ' <span class="fail">cut off at the token limit</span>' : ''}${c.salvaged ? ' <span class="fail">salvaged: kept the complete part</span>' : ''}${c.error ? ' <span class="fail">' + esc(c.error) + '</span>' : ''}</summary>
        <div class="muted">System (shared prefix)</div><pre>${esc(c.system)}</pre>
        <div class="muted">User</div><pre>${esc(c.user)}</pre>
        <div class="muted">Raw output</div><pre>${esc(c.raw)}</pre></details>`).join('') ||
      '<div class="muted">No model calls yet.</div>';
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
    E.routeSteps.forEach((r) => { out[r.id] = mode === 'hybrid' ? (['intent', 'narrate'].includes(r.id) ? 'external' : 'local') : mode; });
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
  }
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
    initTimeSteps();
    await loadServerList();
    if (firstRun) openSetup();
    else checkConnection(false);
    const saved = store.get('ensemble.autosave');
    if (saved) {
      try {
        state = E.Engine.migrate(JSON.parse(saved));
        showPickInfo(false);
        renderAll();
      } catch (e) { state = null; }
    }
  }
  boot();
})();
