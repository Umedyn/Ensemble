// What the pages' modules share (tasks A-3, A-6). All game logic lives in
// engine/memory/prompts. A module's own names stay in its closure; names other
// modules use are on E.UI, set here or at the end of the module that has them.
(function () {
  const E = window.Ensemble;
  // obj: a Blob as it is, or anything else as JSON.
  function download(name, obj) {
    const blob = obj instanceof Blob ? obj : new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  E.UI = {
    download,
    $: (id) => document.getElementById(id),
    esc: E.esc,
    store: E.Prefs,
    state: null,
    saveId: null, // this game's entry in E.Saves; set on its first autosave
    busy: false,
    uiCut: null, // beat number the player wants to step in after
    suggested: null, // suggested actions: { state, key, list } (see renderSuggestions)
    uiShown: 1, // beats of the live scene revealed so far
    gen: null, // the generated start being made
    libraryAssets: {},
    openTurns: new Set(), // folded earlier turns the player has opened
    openChapters: new Set(), // closed chapters the player has opened
    openJournal: new Set(), // earlier journal chapters the player has opened
    notes: [], // undo/reroll history for the Debug panel
    loaded: new Map(), // worlds in the picker; see "worlds and starts"
  };
})();
