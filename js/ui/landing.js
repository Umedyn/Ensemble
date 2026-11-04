// The landing page (task A-7): continue the last game in one click, recent
// saves, New game, the library, the creator and settings, and the first-run
// setup when no backend is configured. Old links still land where they meant:
// ?save= on the game, ?world=&start= on New game, ?testplay on Test play.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;
  const query = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } })();
  const RECENT = 6;

  // An old link: the page it meant, or null for the landing page itself.
  function redirect() {
    const q = (keys) => { const out = new URLSearchParams(); keys.forEach((k) => { if (query.has(k)) out.set(k, query.get(k)); }); const s = out.toString(); return s ? '?' + s : ''; };
    if (query.has('testplay')) return 'new.html?testplay=1';
    if (query.has('save')) return 'play.html' + q(['save']);
    if (query.has('world')) return 'new.html' + q(['world', 'start']);
    return null;
  }

  const playUrl = (id) => 'play.html?save=' + encodeURIComponent(id);
  const when = (t) => { try { return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } };
  const where = (m) => [m.worldTitle || m.world || 'A game', m.startTitle].filter(Boolean).join(' · ');
  const who = (m) => [m.player, `turn ${m.turn || 0}`].filter(Boolean).join(', ');

  async function renderSaves() {
    const list = await E.Saves.list();
    const last = list[0];
    $('lContinue').innerHTML = last
      ? `<div class="land-last"><div class="muted small">Your last game</div><div class="land-title">${esc(where(last))}</div><div>${esc(who(last))} <span class="muted small">· ${esc(when(last.date))}</span></div></div>
         <a id="btnContinue" class="btn primary land-go" href="${playUrl(last.id)}">Continue</a>`
      : `<div class="land-last"><div class="land-title">No saves yet. Pick a world to start.</div><div class="muted small">Your games are saved in this browser after every turn.</div></div>
         <a class="btn primary land-go" href="new.html">New game</a>`;
    $('lRecent').innerHTML = list.slice(1, RECENT + 1).map((m) => `<li><a href="${playUrl(m.id)}"><span>${esc(where(m))}</span> <span class="muted small">${esc(who(m))} · ${esc(when(m.date))}</span></a></li>`).join('');
    $('lRecentBox').classList.toggle('hidden', list.length < 2);
    $('lMore').textContent = list.length > RECENT + 1 ? `${list.length - RECENT - 1} more in Settings › Saved games, where you can also export or delete them.` : 'Export or delete saves in Settings › Saved games.';
  }

  async function boot() {
    E.Header.mount({ title: 'Ensemble' });
    await E.Store.ready();
    const to = redirect();
    // replace: Back from the next page doesn't come here and bounce again.
    if (to) return location.replace(to);
    E.pageCheck();
    // First run: no settings saved and the setup never answered.
    const firstRun = store.get('ensemble.settings') === null && store.get('ensemble.setupDone') === null;
    E.loadSettings();
    window.EnsembleAppearance(E.settings.appearance);
    E.Header.refresh();
    await renderSaves();
    document.body.dataset.ready = '1';
    // Settings › Setup guide comes here as ?setup=1.
    if (firstRun || query.has('setup')) {
      if (query.has('setup')) try { history.replaceState(null, '', location.pathname); } catch (e) { /* from disk */ }
      return U.openSetup(() => E.Header.checkConnection(false));
    }
    E.Header.checkConnection(false);
  }
  boot();
})();
