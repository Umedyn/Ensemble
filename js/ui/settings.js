// The first-run setup, on index.html until the landing page (task A-7). The
// settings themselves are on their own page (settings.html, task A-4).
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, store } = U;

  // Shown once, before any settings are saved: pick how to run the model, then
  // Settings opens on the section that still needs filling in. onSkip: what
  // happens after "Decide later".
  let onSkip = null;
  function openSetup(skip) {
    onSkip = skip || null;
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
    if (!['external', 'local', 'hybrid'].includes(mode)) { if (onSkip) onSkip(); return; }
    E.settings.routing = E.routingFor(mode);
    await E.saveSettings();
    location.href = E.Header.settingsHref({ section: mode === 'local' ? 'local' : 'external', setup: '1' });
  });
  Object.assign(U, { openSetup });
})();
