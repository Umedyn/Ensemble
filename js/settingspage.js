// The Settings page (task A-4): models and routing, appearance, story, voice
// and saved games. Every change is kept as it is made; the page that sent the
// player here reads the settings again on return.
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;
  const query = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } })();

  // ---------- backends ----------
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
    showPreset(box, b.preset);
    // Runs before the form's own change handler saves.
    sel.addEventListener('change', () => {
      const p = E.backendPresets[sel.value] || {};
      box.querySelector('.bUrl').value = p.url || '';
      box.querySelector('.bModel').value = p.model || '';
      box.querySelector('.bConstrain').checked = E.LLM.constrainDefault(sel.value);
      box.querySelector('.bSmaller').checked = E.LLM.smallerDefault(sel.value, parseInt(box.querySelector('.bContext').value, 10) || 0);
      showPreset(box, sel.value);
    });
    box.querySelector('.bTest').addEventListener('click', async () => {
      const st = box.querySelector('.bStatus');
      st.textContent = 'Testing…';
      try {
        const info = await E.LLM.ping(id);
        st.textContent = `✓ ${info.model}${info.context ? ` · context ${info.context}` : ''}`;
        if (info.context) { box.querySelector('.bContext').value = info.context; save(); }
      } catch (e) {
        st.textContent = '✕ ' + e.message;
      }
    });
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
  function showMemory() {
    const m = E.memoryContext();
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
  document.querySelectorAll('[data-route]').forEach((btn) => btn.addEventListener('click', () => {
    const routes = E.routingFor(btn.dataset.route);
    E.routeSteps.forEach((r) => { $('routing').querySelector(`[data-step="${r.id}"]`).value = routes[r.id]; });
    save();
  }));

  // ---------- appearance ----------
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
  // "Same as my device" follows the OS while the page is open.
  ['(prefers-color-scheme: light)', '(prefers-reduced-motion: reduce)'].forEach((q) => {
    try { window.matchMedia(q).addEventListener('change', () => window.EnsembleAppearance(E.settings.appearance)); } catch (e) {}
  });

  // ---------- the whole form ----------
  function fill() {
    fillBackend('local');
    fillBackend('external');
    fillRouting();
    $('sMemoryCap').value = E.settings.memoryCap;
    $('sNarrate').value = E.settings.narrateTokens;
    $('sTemp').value = E.settings.temperature;
    $('sChapter').value = E.settings.chapterLength;
    fillAppearance();
    showMemory();
  }
  function read() {
    readBackend('local');
    readBackend('external');
    E.routeSteps.forEach((r) => { E.settings.routing[r.id] = $('routing').querySelector(`[data-step="${r.id}"]`).value; });
    E.settings.memoryCap = Math.max(4096, parseInt($('sMemoryCap').value, 10) || E.defaults.memoryCap);
    E.settings.narrateTokens = E.clamp(parseInt($('sNarrate').value, 10) || E.defaults.narrateTokens, 150, 1200);
    E.settings.temperature = E.clamp(parseFloat($('sTemp').value) || E.defaults.temperature, 0, 2);
    E.settings.chapterLength = E.clamp(parseInt($('sChapter').value, 10) || E.defaults.chapterLength, 4, 40);
    E.settings.appearance = readAppearance();
  }
  // Kept as it is made: a page left by any link has its changes.
  let saving = null;
  function save() {
    read();
    $('aTextSizeOut').textContent = E.settings.appearance.textSize + '%';
    window.EnsembleAppearance(E.settings.appearance);
    E.Header.refresh();
    showMemory();
    const now = E.saveSettings();
    saving = now;
    Promise.resolve(now).then((ok) => {
      if (saving !== now) return;
      $('sStatus').textContent = ok === false ? 'Couldn\'t save the settings in this browser.' : 'Saved.';
    });
  }
  // Typing in a field and the storage section's file input don't count.
  $('settings').addEventListener('input', (ev) => { if (!ev.target.closest('[data-section="storage"]')) save(); });
  $('settings').addEventListener('change', (ev) => { if (!ev.target.closest('[data-section="storage"]')) save(); });

  // ---------- saved games ----------
  const saveLine = (m) => [m.worldTitle || m.world || 'A game', m.startTitle].filter(Boolean).join(' · ') +
    (m.player ? ` — ${m.player}` : '') + `, turn ${m.turn || 0}`;
  async function showSaves() {
    const list = await E.Saves.list();
    $('sSaves').textContent = list.length ? `${list.length} saved game${list.length === 1 ? '' : 's'} in this browser:` : 'No saved games yet.';
    $('sSaveList').innerHTML = list.map((m) => `<li>${esc(saveLine(m))} <span class="muted">${esc(new Date(m.date).toLocaleString())}</span></li>`).join('');
    $('sExport').disabled = !list.length;
    $('sClear').disabled = !list.length;
    return list;
  }
  $('sExport').addEventListener('click', async () => {
    const file = await E.Saves.exportAll();
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ensemble-saves-${file.exported.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    $('sStoreStatus').textContent = `Exported ${file.saves.length} saved game${file.saves.length === 1 ? '' : 's'}.`;
  });
  $('sImport').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const r = await E.Saves.importAll(JSON.parse(await f.text()));
      const parts = [];
      if (r.added) parts.push(`${r.added} added`);
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.kept) parts.push(`${r.kept} kept as they were (the copy here was newer)`);
      if (r.refused) parts.push(`${r.refused} skipped (not a game this version can read)`);
      $('sStoreStatus').textContent = parts.length ? `Imported: ${parts.join(', ')}.` : 'That file has no saved games.';
    } catch (e) {
      $('sStoreStatus').textContent = e instanceof SyntaxError ? 'That file is not an Ensemble saves file.' : e.message;
    }
    showSaves();
  });
  // Names what will go before anything does.
  $('sClear').addEventListener('click', async () => {
    const list = await showSaves();
    if (!list.length) return;
    const shown = list.slice(0, 12).map((m) => '• ' + saveLine(m));
    if (list.length > shown.length) shown.push(`…and ${list.length - shown.length} more`);
    const ask = `Delete all ${list.length} saved game${list.length === 1 ? '' : 's'} from this browser?\n\n${shown.join('\n')}\n\n` +
      'This can\'t be undone: export them first to keep a copy. Settings and API keys stay.';
    if (!window.confirm(ask)) return;
    const n = await E.Saves.clearAll();
    $('sStoreStatus').textContent = `Deleted ${n} saved game${n === 1 ? '' : 's'}.`;
    showSaves();
  });

  // ---------- sections ----------
  // Sections remember whether they were left open; the first-run setup opens
  // the one that still needs filling in.
  function restoreSections() {
    document.querySelectorAll('#settings details.section').forEach((d) => {
      const k = 'ensemble.section.' + d.dataset.section;
      const v = E.Prefs.get(k);
      if (v !== null) d.open = v === '1';
      d.addEventListener('toggle', () => E.Prefs.set(k, d.open ? '1' : '0'));
    });
  }
  function fromSetup() {
    const section = query.get('section');
    if (!['local', 'external'].includes(section)) return;
    document.querySelectorAll('#settings details.section').forEach((d) => {
      if (['local', 'external', 'routing'].includes(d.dataset.section)) d.open = d.dataset.section === section || d.dataset.section === 'routing';
    });
    if (query.has('setup')) {
      $('sSetupNote').textContent = section === 'local'
        ? 'Start KoboldCpp, then press Test. Go back when it shows a ✓.'
        : 'Paste your API key and a model name, then press Test. Go back when it shows a ✓.';
      $('sSetupNote').classList.remove('hidden');
    }
    const box = backendBox(section);
    (section === 'local' ? box.querySelector('.bTest') : box.querySelector('.bKey')).focus();
  }

  // ---------- boot ----------
  async function boot() {
    E.Header.mount({ title: 'Ensemble Settings', settingsChanged: fill });
    await E.Store.ready();
    E.pageCheck();
    E.loadSettings();
    window.EnsembleAppearance(E.settings.appearance);
    E.Header.refresh();
    const back = E.Header.backHref();
    if (back) {
      $('sBack').href = back;
      $('sBack').textContent = back.startsWith('creator.html') ? '← Back to the Creator' : back.startsWith('library.html') ? '← Back to the library' : '← Back to the game';
      $('sBack').classList.remove('hidden');
      // Straight back when that page is the one behind this, so it comes back
      // as it was left (a scene part read, the map open); otherwise it loads.
      $('sBack').addEventListener('click', (ev) => {
        let came = '';
        try { came = new URL(document.referrer).pathname.split('/').pop() || 'index.html'; } catch (e) {}
        if (history.length > 1 && came === back.split('?')[0]) { ev.preventDefault(); history.back(); }
      });
    }
    fill();
    restoreSections();
    fromSetup();
    $('sVoice').textContent = E.Voice.available ? 'A voice is available.' : 'Reading the story aloud isn\'t available yet.';
    E.Header.checkConnection(false);
    showSaves();
  }
  boot();
})();
