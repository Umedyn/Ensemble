// Boots the game page. Loaded last.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

  E.Header.mount({ title: 'Ensemble' });

  // ---------- mobile side sheet ----------
  $('btnSide').addEventListener('click', () => $('side').classList.add('open'));
  $('btnSideClose').addEventListener('click', () => $('side').classList.remove('open'));

  // ---------- boot ----------
  function initTimeSteps() {
    $('timeStep').innerHTML = E.timeSteps.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
    $('timeStep').value = 'hour';
    $('timeStep').addEventListener('change', () => {
      $('actionInput').placeholder = U.actionPlaceholder();
    });
  }

  // Test play (task 6-1): the creator opened this tab with ?testplay and
  // sends its working copy once the page is ready. Only the tab that opened
  // this one is listened to; the world goes through the same checks as any.
  const TEST_PLAY = (() => { try { return new URLSearchParams(location.search).has('testplay'); } catch (e) { return false; } })();
  function startTestPlay() {
    if (!window.opener) { $('pickInfo').innerHTML = '<span class="fail">Test play starts from the creator: use ▶ Test play there.</span>'; U.showPickInfo(true); return; }
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (ev.source !== window.opener || !d || d.type !== E.WorldEdit.TEST_WORLD) return;
      const key = 'test:' + d.folder;
      let world;
      try { world = E.Scenario.prepareWorld(d.folder, d.files); }
      catch (e) { world = { folder: d.folder, title: (d.files['world.json'] || {}).title || d.folder, error: e.message }; }
      U.loaded.set(key, world);
      U.diskAssets.set(d.folder, d.assets || {});
      U.addScenarioOption(key, `${U.worldLabel(world)} (test play)`, true);
      U.renderStarts(d.startId);
      U.showPickInfo(true);
      document.title = `Test play: ${world.title} · Ensemble`;
      if (!world.error) $('btnNew').click();
    });
    window.opener.postMessage({ type: E.WorldEdit.TEST_READY }, '*');
  }

  async function boot() {
    await E.Store.ready();
    E.pageCheck();
    U.restoreSections();
    const firstRun = store.get('ensemble.settings') === null && store.get('ensemble.setupDone') === null;
    E.loadSettings();
    U.applyAppearance(E.settings.appearance);
    E.Header.refresh();
    initTimeSteps();
    // The shared site map library (task 6-3), before the worlds that use it.
    try {
      const [shared] = await E.Library.list('library');
      if (shared) E.Scenario.library = await E.Library.load(shared.id);
    } catch (e) { /* no library/: worlds use their own maps */ }
    await U.loadServerList();
    if (firstRun) U.openSetup();
    else E.Header.checkConnection(false);
    if (TEST_PLAY) return startTestPlay();
    const last = await E.Saves.last();
    const saved = last && await E.Saves.load(last.id);
    if (saved) {
      try {
        U.state = E.Engine.migrate(saved);
        U.saveId = last.id;
        U.restoreView();
        U.showPickInfo(false);
        U.renderAll();
      } catch (e) { U.state = null; }
    }
  }
  Object.assign(U, { TEST_PLAY });
  boot();
})();
