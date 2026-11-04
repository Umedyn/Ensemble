// Boots the game page (task A-6): play.html?save=<id>, or ?testplay for the
// creator's Test play. Loaded last.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc } = U;

  // A setting changed on the Settings page shows here on return.
  E.Header.mount({ title: 'Ensemble', settingsChanged: () => { if (U.state) U.renderAll(); } });

  // The save id stays in the address (task A-4), so Settings, refresh and back
  // come back to this game; Load switches it to the loaded game's.
  const query = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } })();
  const TEST_PLAY = query.has('testplay');
  function showSaveId() {
    if (!U.saveId || TEST_PLAY || query.get('save') === U.saveId) return;
    query.set('save', U.saveId);
    try { history.replaceState(null, '', location.pathname + '?' + query.toString()); } catch (e) { /* a file:// page that can't */ }
  }

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
  // No game to show: say so plainly, with the way on.
  function nothing(text) {
    $('log').innerHTML = `<div class="empty">${text}<br><a class="btn primary" href="new.html">New game</a> <a class="btn" href="library.html">Library</a></div>`;
    $('actionInput').disabled = true;
  }
  // A world kept from a folder or zip (task A-5) has its pictures in the store.
  async function pictures(folder) {
    if (U.diskAssets.has(folder)) return;
    const kept = (await E.Library.list('world')).find((w) => E.Library.isStored(w.id) && w.folder === folder);
    if (!kept) return;
    try { U.diskAssets.set(folder, (await E.Library.load(kept.id)).assets || {}); } catch (e) { /* monograms instead */ }
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
    initTimeSteps();
    // The shared site map library (task 6-3): places the story adds may use it.
    try {
      const [shared] = await E.Library.list('library');
      if (shared) E.Scenario.library = await E.Library.load(shared.id);
    } catch (e) { /* no library/: worlds use their own maps */ }
    let saved = null, newGameNotes = [];
    if (TEST_PLAY) {
      // Test play (task 6-1): the world and game New game kept for it.
      const t = await E.TestPlay.load();
      if (!t) return nothing('Test play starts from the creator: use ▶ Test play there.');
      const w = await E.TestPlay.world();
      if (w) U.diskAssets.set(w.folder, w.assets || {});
      saved = t.state;
      newGameNotes = t.notes;
    } else {
      const id = query.get('save');
      if (!id) return nothing('No game is open. Start a new one, or pick a world in the library.');
      saved = await E.Saves.load(id);
      // Nothing kept (a private window, or storage turned off): the game New
      // game made is already gone, so say why rather than "not found".
      if (!saved && !E.Store.kept) return nothing('This browser isn\'t keeping anything Ensemble saves, so a game can\'t move from New game to here. Open Ensemble in a normal window, with site storage allowed.');
      if (!saved) return nothing('That saved game isn\'t in this browser. It may have been deleted, or saved in another browser.');
      U.saveId = id;
      newGameNotes = await E.Saves.notes(id);
    }
    try { U.state = E.Engine.migrate(saved); }
    catch (e) { return nothing(`That saved game couldn't be read: ${esc(e.message)}`); }
    if (TEST_PLAY) document.title = `Test play: ${U.state.scenario.worldTitle || U.state.scenario.title} · Ensemble`;
    U.notes.push(...newGameNotes);
    await pictures(U.state.scenario.folder);
    U.restoreView();
    U.renderAll();
    $('actionInput').focus();
  }
  Object.assign(U, { TEST_PLAY, showSaveId });
  boot();
})();
