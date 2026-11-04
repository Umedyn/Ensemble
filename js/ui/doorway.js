// index.html until the landing page (task A-7): the first-run setup, then on
// to the right page. Old links land where they meant: ?save= on the game,
// ?world=&start= on New game, ?testplay on Test play; with none, the last game,
// or New game when there is none yet.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { store } = U;
  const query = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } })();

  async function where() {
    const q = (keys) => { const out = new URLSearchParams(); keys.forEach((k) => { if (query.has(k)) out.set(k, query.get(k)); }); const s = out.toString(); return s ? '?' + s : ''; };
    if (query.has('testplay')) return 'new.html?testplay=1';
    if (query.has('save')) return 'play.html' + q(['save']);
    if (query.has('world')) return 'new.html' + q(['world', 'start']);
    const last = await E.Saves.last();
    return last ? 'play.html?save=' + encodeURIComponent(last.id) : 'new.html';
  }
  // replace: Back from the next page doesn't come here and bounce again.
  const go = async () => location.replace(await where());

  async function boot() {
    E.Header.mount({ title: 'Ensemble' });
    await E.Store.ready();
    E.pageCheck();
    const firstRun = store.get('ensemble.settings') === null && store.get('ensemble.setupDone') === null;
    E.loadSettings();
    window.EnsembleAppearance(E.settings.appearance);
    E.Header.refresh();
    // Settings › Setup guide comes here as ?setup=1.
    if (firstRun || query.has('setup')) return U.openSetup(go);
    go();
  }
  boot();
})();
