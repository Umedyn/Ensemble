// The header every page shares (task A-3): the title, page links, theme switch
// and connection status, added to the page's own <header class="topbar">,
// whose controls stay in its HTML. Needs no other UI module.
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);

  // The Creator opens beside the game, so a game in progress stays on screen.
  const PAGES = [
    { href: 'index.html', label: 'Game' },
    { href: 'creator.html', label: 'Creator', target: '_blank', cls: ' desktop-only', title: 'Build and edit worlds (opens in a new tab)' },
  ];
  const here = () => { const p = location.pathname.split('/').pop(); return p || 'index.html'; };

  function mount({ title }) {
    const bar = document.querySelector('header.topbar');
    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = title;
    bar.prepend(brand);
    const conn = document.createElement('span');
    conn.id = 'conn';
    conn.className = 'conn off';
    conn.title = 'Model connection';
    conn.textContent = '● offline';
    const theme = document.createElement('button');
    theme.id = 'headerTheme';
    theme.type = 'button';
    theme.className = 'desktop-only';
    theme.textContent = '◐';
    theme.addEventListener('click', nextTheme);
    const links = PAGES.filter((p) => p.href !== here()).map((p) => {
      const a = document.createElement('a');
      a.className = 'btn' + (p.cls || '');
      a.href = p.href;
      a.textContent = p.label;
      if (p.target) { a.target = p.target; a.rel = 'noopener'; }
      if (p.title) a.title = p.title;
      return a;
    });
    const groups = bar.querySelectorAll('.group');
    groups[groups.length - 1].prepend(conn, theme, ...links);
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

  E.Header = { mount, refresh, checkConnection };
})();
