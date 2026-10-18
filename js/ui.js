// UI wiring. All game logic lives in engine/memory/prompts.
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;

  let state = null;
  let busy = false;
  let uiCut = null; // beat number the player wants to step in after
  const loaded = new Map(); // key -> scenario object (from disk) or {folder} (from server)

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

  // ---------- scenarios ----------
  function addScenarioOption(key, title, select) {
    const sel = $('scenarioSelect');
    let opt = Array.from(sel.options).find((o) => o.value === key);
    if (!opt) { opt = document.createElement('option'); opt.value = key; sel.appendChild(opt); }
    opt.textContent = title;
    if (select) sel.value = key;
  }

  async function loadServerList() {
    if (location.protocol === 'file:') {
      addScenarioOption('', '— use Open folder —', true);
      return;
    }
    try {
      const list = await E.Scenario.listServer();
      list.forEach((s) => { loaded.set('server:' + s.folder, { folder: s.folder }); addScenarioOption('server:' + s.folder, s.title); });
    } catch (e) {
      addScenarioOption('', '— no scenarios/index.json —', true);
    }
  }

  async function resolveScenario(key) {
    const item = loaded.get(key);
    if (!item) throw new Error('Pick a scenario first (or use Open folder).');
    if (item.characterData) return item;
    return E.Scenario.loadServer(item.folder);
  }

  $('folderInput').addEventListener('change', async (ev) => {
    if (!ev.target.files.length) return;
    try {
      const { scenarios, errors } = await E.Scenario.loadFromFiles(ev.target.files);
      scenarios.forEach((sc, i) => { loaded.set('disk:' + sc.folder, sc); addScenarioOption('disk:' + sc.folder, sc.title + ' (disk)', i === 0); });
      if (errors.length) alert('Some scenarios were skipped:\n\n' + errors.join('\n\n'));
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
      const sc = await resolveScenario($('scenarioSelect').value);
      state = E.Engine.newGame(sc);
      uiCut = null;
      E.LLM.calls.length = 0;
      autosave();
      renderAll();
      $('actionInput').focus();
    } catch (e) {
      alert(e.message);
    }
  });

  function autosave() { if (state) store.set('ensemble.autosave', JSON.stringify(state)); }

  $('btnSave').addEventListener('click', () => {
    if (!state) return;
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ensemble-${state.scenario.folder || state.scenario.id}-turn${state.turn}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $('loadInput').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s.scenario || !s.characters || !s.player) throw new Error('That file is not an Ensemble save.');
      state = s;
      uiCut = null;
      autosave();
      renderAll();
    } catch (e) {
      alert('Could not load: ' + e.message);
    }
  });

  // ---------- acting ----------
  async function act() {
    if (busy || !state) return;
    const skip = $('timeStep').value === 'major';
    const text = $('actionInput').value.trim();
    if (!text && !skip) return;
    setBusy(true);
    try {
      const result = await E.Engine.runTurn(state, text, $('timeStep').value, setPhase, uiCut);
      uiCut = null;
      if ($('timeStep').value === 'major') $('timeStep').value = 'hour';
      $('actionInput').value = '';
      $('actionInput').placeholder = 'What do you do? (Ctrl+Enter to act)';
      autosave();
      renderAll();
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

  function setBusy(b) {
    busy = b;
    $('btnAct').disabled = b;
    $('btnNew').disabled = b;
    $('actionInput').disabled = b;
  }
  function setPhase(text) {
    const el = $('phase');
    el.textContent = text;
    el.classList.toggle('busy', !!text);
  }
  function showWarning(msg) {
    const div = document.createElement('div');
    div.className = 'entry warn';
    div.textContent = '⚠ ' + msg;
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
  }

  // ---------- rendering ----------
  function renderAll() {
    renderLog();
    renderSceneBar();
    renderSituation();
    renderNews();
    renderCast();
    renderJournal();
    renderDebug();
  }

  function nm(id) { return state.characters[id] ? state.characters[id].name : id; }

  function renderLog() {
    const log = $('log');
    if (!state) return;
    const html = state.log.map((e) => {
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
    }).join('');
    log.innerHTML = html || '<div class="empty">Write your first action below.</div>';
    if (state.flags.gameOver) log.insertAdjacentHTML('beforeend', '<div class="entry chapter"><b>Your story ends here.</b>Load a save or start a new game.</div>');
    log.scrollTop = log.scrollHeight;
  }

  function beatClock(e, b) {
    const total = (e.startMinutes || 0) + b.at;
    const day = (e.startDay || 0) + Math.floor(total / 1440);
    const m = total % 1440;
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return day !== e.startDay ? `${state.scenario.timeLabel || 'Day'} ${day}, ${hhmm}` : hhmm;
  }

  function renderScene(e) {
    if (!e.beats || e.beats.length < 2) return `<div class="entry scene">${esc(e.text)}</div>`;
    const live = state.pending && state.pending.turn === e.turn;
    const cut = live ? uiCut : e.cutAt;
    return e.beats.map((b, i) => {
      const skipped = cut && i >= cut;
      let h = `<div class="beat ${skipped ? 'skipped' : ''}"><div class="beat-time">${beatClock(e, b)}${skipped && !live ? ' · didn\'t happen, you stepped in' : ''}</div>` +
        `<div class="entry scene">${esc(b.text)}</div></div>`;
      if (live && i < e.beats.length - 1) {
        const on = uiCut === i + 1;
        h += `<div class="interject"><button type="button" data-cut="${i + 1}" class="${on ? 'active' : ''}">${on ? '✓ Stepping in here (click to cancel)' : '↩ Step in here'}</button></div>`;
      }
      return h;
    }).join('');
  }

  $('log').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-cut]');
    if (!btn || busy) return;
    const n = parseInt(btn.dataset.cut, 10);
    uiCut = uiCut === n ? null : n;
    const top = $('log').scrollTop;
    renderLog();
    $('log').scrollTop = top;
    const entry = state.log.find((x) => x.type === 'scene' && state.pending && x.turn === state.pending.turn);
    $('actionInput').placeholder = uiCut && entry
      ? `What do you do at ${beatClock(entry, entry.beats[uiCut - 1])}–${beatClock(entry, entry.beats[uiCut])}? (Ctrl+Enter to act)`
      : 'What do you do? (Ctrl+Enter to act)';
    $('actionInput').focus();
  });

  function renderSceneBar() {
    const pc = state.characters[state.player];
    const loc = state.locations[pc.status.location];
    const present = E.Engine.present(state).map(nm);
    $('sceneBar').innerHTML = `<b>${esc(E.fmtTime(state))}</b> · ${esc(state.scenario.title)} · You are in <b>${esc(loc ? loc.name : '?')}</b>` +
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

  function renderCast() {
    $('castTitle').textContent = state.scenario.castLabel || 'People';
    const here = state.characters[state.player].status.location;
    $('cast').innerHTML = state.order.map((id) => {
      const c = state.characters[id];
      const isPlayer = id === state.player;
      const dead = c.status.health === 'dead';
      const loc = state.locations[c.status.location];
      const rel = c.relations[state.player] || 0;
      const relW = E.relWord(rel);
      const needs = state.scenario.needs.map((n) => {
        const v = c.needs[n.id] || 0;
        return `<span>${esc(n.label || n.id)}</span><div class="bar ${v >= 0.85 ? 'danger' : ''}"><i style="width:${Math.round(v * 100)}%"></i></div>`;
      }).join('');
      const tags = [E.healthWord(c.status.health)].concat(c.status.conditions).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      return `<div class="card ${!isPlayer && c.status.location === here ? 'here' : ''} ${dead ? 'dead' : ''}">
        <div class="top"><div><div class="nm">${esc(c.name)}${isPlayer ? ' (you)' : ''}</div><div class="role">${esc(c.role)}</div></div>
        ${isPlayer ? '' : (() => {
          const mine = state.characters[state.player].relations[id] || 0;
          const myW = E.relWord(mine);
          const why = (state.characters[state.player].attitudeNotes || {})[id];
          return `<div class="rels"><div class="rel-${relW}" title="How they feel about you">them: ${relW} ${rel > 0 ? '+' : ''}${rel}</div>` +
            `<div class="rel-${myW}" title="${esc(why ? 'How you feel about them: ' + why : 'How you feel about them')}">you: ${myW} ${mine > 0 ? '+' : ''}${mine}</div></div>`;
        })()}</div>
        <div class="meta">${esc(loc ? loc.name : '?')}</div>
        <div>${tags}</div>
        ${dead ? '' : `<div class="needs">${needs}</div>`}
      </div>`;
    }).join('');
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
    if ($('debug').classList.contains('hidden')) return;
    const calls = E.LLM.calls.slice().reverse();
    const facts = state ? state.facts.map((f) => `[T${f.turn} w${f.weight}] ${f.text}   (known by: ${f.known_by.join(', ')})`).join('\n') : '';
    $('debugBody').innerHTML =
      (state ? `<details><summary>Fact store (${state.facts.length})</summary><pre>${esc(facts)}</pre></details>` : '') +
      calls.map((c) => `<details><summary><b>${esc(c.kind)}</b> · ${esc(c.backend || '')} · ${c.ms} ms · ~${c.estTokens} tokens${c.overBudget ? ' <span class="fail">over context!</span>' : ''}${c.error ? ' <span class="fail">' + esc(c.error) + '</span>' : ''}</summary>
        <div class="muted">System (shared prefix)</div><pre>${esc(c.system)}</pre>
        <div class="muted">User</div><pre>${esc(c.user)}</pre>
        <div class="muted">Raw output</div><pre>${esc(c.raw)}</pre></details>`).join('') ||
      '<div class="muted">No model calls yet.</div>';
  }
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
    };
  }

  function fillRouting() {
    $('routing').innerHTML = E.routeSteps.map((r) =>
      `<label>${esc(r.label)} <select data-step="${r.id}"><option value="local">Local</option><option value="external">External</option></select></label>`
    ).join('');
    E.routeSteps.forEach((r) => { $('routing').querySelector(`[data-step="${r.id}"]`).value = E.settings.routing[r.id] || 'local'; });
  }
  document.querySelectorAll('[data-route]').forEach((btn) => btn.addEventListener('click', () => {
    const mode = btn.dataset.route;
    E.routeSteps.forEach((r) => {
      const v = mode === 'hybrid' ? (['intent', 'narrate'].includes(r.id) ? 'external' : 'local') : mode;
      $('routing').querySelector(`[data-step="${r.id}"]`).value = v;
    });
  }));

  function fillSettings() {
    fillBackend('local');
    fillBackend('external');
    fillRouting();
    $('sContext').value = E.settings.contextSize;
    $('sNarrate').value = E.settings.narrateTokens;
    $('sTemp').value = E.settings.temperature;
    $('sChapter').value = E.settings.chapterLength;
    $('sStatus').textContent = '';
  }
  function readSettings() {
    readBackend('local');
    readBackend('external');
    E.routeSteps.forEach((r) => { E.settings.routing[r.id] = $('routing').querySelector(`[data-step="${r.id}"]`).value; });
    E.settings.contextSize = Math.max(2048, parseInt($('sContext').value, 10) || E.defaults.contextSize);
    E.settings.narrateTokens = E.clamp(parseInt($('sNarrate').value, 10) || E.defaults.narrateTokens, 150, 1200);
    E.settings.temperature = E.clamp(parseFloat($('sTemp').value) || E.defaults.temperature, 0, 2);
    E.settings.chapterLength = E.clamp(parseInt($('sChapter').value, 10) || E.defaults.chapterLength, 2, 20);
  }
  $('btnSettings').addEventListener('click', () => { fillSettings(); $('settings').showModal(); });
  $('btnDetect').addEventListener('click', async () => {
    readSettings();
    $('sStatus').textContent = 'Detecting…';
    try {
      const info = await E.LLM.ping('local');
      if (info.context) { $('sContext').value = info.context; $('sStatus').textContent = `Local model context: ${info.context}`; }
      else $('sStatus').textContent = 'The local backend did not report a context size.';
    } catch (e) { $('sStatus').textContent = e.message; }
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
      if (uiCut) return;
      $('actionInput').placeholder = $('timeStep').value === 'major'
        ? 'How do you spend the downtime? (optional, e.g. "Keep the arrays clean and avoid Teo")'
        : 'What do you do? (Ctrl+Enter to act)';
    });
  }

  async function boot() {
    E.loadSettings();
    initTimeSteps();
    await loadServerList();
    checkConnection(false);
    const saved = store.get('ensemble.autosave');
    if (saved) {
      try {
        state = JSON.parse(saved);
        renderAll();
      } catch (e) { state = null; }
    }
  }
  boot();
})();
