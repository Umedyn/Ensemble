// Appearance and first-run setup. The settings themselves are on their own
// page (settings.html, task A-4); the header links there and back.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, store } = U;

  // ---------- appearance ----------
  const applyAppearance = (a) => window.EnsembleAppearance && window.EnsembleAppearance(a);
  // "Same as my device" follows the OS while the page is open.
  ['(prefers-color-scheme: light)', '(prefers-reduced-motion: reduce)'].forEach((q) => {
    try { window.matchMedia(q).addEventListener('change', () => applyAppearance(E.settings.appearance)); } catch (e) {}
  });

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
  $('setup').addEventListener('close', async () => {
    await store.set('ensemble.setupDone', '1');
    const mode = $('setup').returnValue;
    if (!['external', 'local', 'hybrid'].includes(mode)) { E.Header.checkConnection(false); return; }
    E.settings.routing = E.routingFor(mode);
    await E.saveSettings();
    location.href = E.Header.settingsHref({ section: mode === 'local' ? 'local' : 'external', setup: '1' });
  });
  Object.assign(U, { applyAppearance, openSetup });
})();
