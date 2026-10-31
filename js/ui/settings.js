// Settings, appearance and first-run setup.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

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
    if (id === 'aMapDetail') { U.mapDetailPreview = $('aMapDetail').value; if (U.state) U.renderMap(); }
    if (id === 'aStoryLinks') { U.storyLinksPreview = $('aStoryLinks').value; if (U.state) U.renderLog(); }
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
    if (!['external', 'local', 'hybrid'].includes(mode)) { E.Header.checkConnection(false); return; }
    E.settings.routing = routingFor(mode);
    E.saveSettings();
    E.Header.checkConnection(false);
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
      E.Header.checkConnection(false);
      if (U.state) U.renderJournal();
    }
    applyAppearance(E.settings.appearance);
    if (U.mapDetailPreview) { U.mapDetailPreview = null; if (U.state) U.renderMap(); }
    if (U.storyLinksPreview) { U.storyLinksPreview = null; if (U.state) U.renderLog(); }
  });
  Object.assign(U, { applyAppearance, openSetup, restoreSections });
})();
