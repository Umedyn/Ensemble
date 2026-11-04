// The header every page shares (task A-3): the title, page links, theme switch
// and connection status, added to the page's own <header class="topbar">,
// whose controls stay in its HTML. Needs no other UI module.
// Settings has its own page (task A-4): the link says where to come back to,
// and a page shown again re-reads the settings in case they changed there.
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);

  // The Creator opens beside the game, so a game in progress stays on screen,
  // and Settings opens beside the Creator, whose working copy isn't kept.
  const PAGES = [
    // The landing page (task A-7): Continue, recent games and the rest.
    { href: 'index.html', label: 'Home', id: 'btnHome', title: 'Continue your last game, or start another', first: true },
    { href: 'library.html', label: 'Library', title: 'Every world, and opening your own', desktopOnlyOn: ['play.html'] },
    { href: 'creator.html', label: 'Creator', target: '_blank', cls: ' desktop-only', title: 'Build and edit worlds (opens in a new tab)' },
    { href: 'settings.html', label: 'Settings', id: 'btnSettings', last: true, title: 'Models, appearance and saves', newTabFrom: ['creator.html'] },
  ];
  const here = () => { const p = location.pathname.split('/').pop(); return p || 'index.html'; };

  // settings.html?back=<this page and its query>, plus any of opts
  // (section: a section to open; setup: the first-run setup sent the player).
  function settingsHref(opts = {}) {
    const q = new URLSearchParams(Object.assign({ back: here() + location.search }, opts));
    return 'settings.html?' + q.toString();
  }
  // Only a page of this app, never another site.
  function backHref() {
    let b = null;
    try { b = new URLSearchParams(location.search).get('back'); } catch (e) {}
    return b && /^(index|creator|library|play|new)\.html(\?[^#]*)?$/.test(b) ? b : null;
  }

  let onSettings = null;
  function mount({ title, settingsChanged }) {
    onSettings = settingsChanged || null;
    const bar = document.querySelector('header.topbar');
    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = title;
    bar.prepend(brand);
    const conn = document.createElement('span');
    conn.id = 'conn';
    conn.className = 'conn';
    conn.title = 'Model connection';
    conn.textContent = '● checking…';
    const theme = document.createElement('button');
    theme.id = 'headerTheme';
    theme.type = 'button';
    theme.className = 'desktop-only';
    theme.textContent = '◐';
    theme.addEventListener('click', nextTheme);
    const pages = PAGES.filter((p) => p.href !== here());
    const back = backHref();
    const links = pages.map((p) => {
      const a = document.createElement('a');
      // The game's top bar on a phone has no room for it.
      a.className = 'btn' + (p.cls || '') + ((p.desktopOnlyOn || []).includes(here()) ? ' desktop-only' : '');
      const backTo = back && back.split('?')[0];
      a.href = backTo === p.href ? back : p.href;
      a.textContent = p.label;
      const newTab = p.target || (p.newTabFrom || []).includes(here());
      if (newTab) { a.target = '_blank'; a.rel = 'noopener'; }
      else if (p.href === 'settings.html') a.addEventListener('click', () => { a.href = settingsHref(); });
      if (p.id) a.id = p.id;
      if (p.title) a.title = p.title + (p.target ? '' : newTab ? ' (opens in a new tab)' : '');
      return a;
    });
    // Home leads the first group, beside the page's own controls (on the
    // game's phone bar, where it has room); the rest go to the last.
    const groups = bar.querySelectorAll('.group');
    const group = groups[groups.length - 1];
    groups[0].prepend(...links.filter((a, i) => pages[i].first));
    group.prepend(conn, theme, ...links.filter((a, i) => !pages[i].last && !pages[i].first));
    group.append(...links.filter((a, i) => pages[i].last));
    window.addEventListener('pageshow', (ev) => { if (ev.persisted) reread(); });
    // "Same as my device" follows the OS while the page is open.
    ['(prefers-color-scheme: light)', '(prefers-reduced-motion: reduce)'].forEach((q) => {
      try { window.matchMedia(q).addEventListener('change', () => window.EnsembleAppearance(E.settings.appearance)); } catch (e) {}
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reread(); });
  }

  // Back from Settings, or back to a tab while Settings was open in another:
  // the settings as stored now, if they changed.
  async function reread() {
    if (!E.Prefs.ready()) return;
    const before = E.readSettings();
    if ((await E.Prefs.reload('ensemble.settings')) === before) return;
    E.loadSettings();
    window.EnsembleAppearance(E.settings.appearance);
    refresh();
    checkConnection(false);
    if (onSettings) onSettings();
  }

  // Shows the saved theme, once settings are loaded.
  function refresh() {
    const now = E.themes.find((t) => t.id === E.settings.appearance.theme) || E.themes[0];
    $('headerTheme').title = `Theme: ${now.label}. Press for the next one.`;
    $('headerTheme').setAttribute('aria-label', $('headerTheme').title);
  }
  function nextTheme() {
    const at = E.themes.findIndex((t) => t.id === E.settings.appearance.theme);
    setTheme(E.themes[(at + 1) % E.themes.length].id);
  }

  // Another page may have changed the settings since this one loaded, so only
  // the theme goes into what is stored now.
  async function setTheme(theme) {
    E.settings.appearance.theme = theme;
    window.EnsembleAppearance(E.settings.appearance);
    refresh();
    const raw = await E.Store.get('ensemble.settings');
    let saved = E.settings;
    try { if (raw) saved = JSON.parse(raw); } catch (e) { /* a broken copy is replaced */ }
    saved.appearance = Object.assign({}, saved.appearance, { theme });
    E.writeSettings(saved);
  }

  async function checkConnection(showStatus) {
    const el = $('conn');
    const ids = Array.from(new Set(Object.values(E.settings.routing)));
    const parts = [];
    let ok = true, ctx = null;
    for (const id of ids) {
      try {
        const info = await E.LLM.ping(id);
        parts.push(info.model);
        if (id === 'local' && info.context) ctx = info.context;
      } catch (e) {
        ok = false;
        parts.push(`${id} offline`);
        if (showStatus) $('sStatus').textContent = `${id}: ${e.message}`;
      }
    }
    el.textContent = '● ' + parts.join(' + ');
    el.className = 'conn ' + (ok ? 'on' : 'off');
    el.title = ctx ? `Local context: ${ctx} tokens` : '';
    return { ok, context: ctx };
  }

  E.Header = { mount, refresh, checkConnection, settingsHref, backHref };
})();
