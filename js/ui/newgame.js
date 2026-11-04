// Boots the New game page (task A-6): new.html, with ?world=<id>&start=<id>
// from the library, or ?testplay for the creator's Test play. Loaded last.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $ } = U;

  E.Header.mount({ title: 'New game' });
  const query = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } })();
  const TEST_PLAY = query.has('testplay');

  // Test play (task 6-1): the creator opened this tab with ?testplay and
  // sends its working copy once the page is ready. Only the tab that opened
  // this one is listened to; the world goes through the same checks as any.
  // It is kept in Test play's own slot (E.TestPlay) for the game page.
  function startTestPlay() {
    if (!window.opener) { $('pickInfo').innerHTML = '<span class="fail">Test play starts from the creator: use ▶ Test play there.</span>'; return; }
    window.addEventListener('message', async (ev) => {
      const d = ev.data;
      if (ev.source !== window.opener || !d || d.type !== E.WorldEdit.TEST_WORLD) return;
      const key = 'test:' + d.folder;
      let world;
      try { world = E.Scenario.prepareWorld(d.folder, d.files); }
      catch (e) { world = { folder: d.folder, title: (d.files['world.json'] || {}).title || d.folder, error: e.message }; }
      const assets = {};
      Object.entries(d.assets || {}).forEach(([p, a]) => { assets[p] = a instanceof Blob ? a : new Blob([a]); });
      await E.TestPlay.putWorld(d.folder, d.files, assets);
      U.loaded.set(key, world);
      U.diskAssets.set(d.folder, assets);
      U.addScenarioOption(key, `${U.worldLabel(world)} (test play)`, true);
      U.renderStarts(d.startId);
      document.title = `Test play: ${world.title} · Ensemble`;
      if (!world.error) $('btnNew').click();
    });
    window.opener.postMessage({ type: E.WorldEdit.TEST_READY }, '*');
  }

  // The page says when it has finished starting (for the smoke tests).
  async function boot() {
    await start();
    document.body.dataset.ready = '1';
  }
  async function start() {
    await E.Store.ready();
    E.pageCheck();
    E.loadSettings();
    window.EnsembleAppearance(E.settings.appearance);
    E.Header.refresh();
    E.Header.checkConnection(false);
    // The shared site map library (task 6-3), before the worlds that use it.
    try {
      const [shared] = await E.Library.list('library');
      if (shared) E.Scenario.library = await E.Library.load(shared.id);
    } catch (e) { /* no library/: worlds use their own maps */ }
    if (TEST_PLAY) return startTestPlay();
    await U.loadServerList();
    // From the library (task A-5): that world and start, ready to Start.
    if (query.has('world') && U.pickWorld(query.get('world'), query.get('start'))) $('btnNew').focus();
  }
  Object.assign(U, { TEST_PLAY });
  boot();
})();
