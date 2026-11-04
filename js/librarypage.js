// The library page (task A-5): every world as a card, filters by tag and
// source, a world's details with its starts, and opening worlds and lore
// packs from a folder or zip, which are kept (E.Library.keep) for every page.
// library.html?world=<id> opens a world's details. Remote lists (task A-8):
// lists the player adds, fetched when this page opens or on Refresh (never
// during play), their worlds as cards to download (E.Remote).
(function () {
  const E = window.Ensemble;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;
  const fromDisk = location.protocol === 'file:';

  // id -> { entry, world } (world: a loaded world, or { error }; for a list's
  // world not downloaded yet, what the list says, with remote: true)
  const worlds = new Map();
  let packs = []; // [{ entry, pack }]
  const filter = { tag: '', source: '' };
  const urls = new Map(); // "id/path" -> object URL, made per page from the stored blobs

  // ---------- pictures ----------
  // A stored world's pictures are Blobs; a bundled one's are on the server.
  function picUrl(id, w, path) {
    if (!path || w.remote) return null;
    if (w.assets && w.assets[path]) {
      const key = id + '/' + path;
      if (!urls.has(key)) urls.set(key, URL.createObjectURL(w.assets[path]));
      return urls.get(key);
    }
    if (E.Library.isStored(id) || fromDisk) return null;
    return `scenarios/${encodeURIComponent(w.folder)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  // The cover, else the world map's picture, else a drawn tile.
  function pictureHtml(id, w, big) {
    const map = w.bundle && w.bundle.world && w.bundle.world.map;
    const url = picUrl(id, w, w.cover) || picUrl(id, w, map && map.image);
    const cls = 'lib-pic' + (big ? ' big' : '');
    if (url) return `<div class="${cls}"><img src="${esc(url)}" alt="" loading="lazy"></div>`;
    const hue = E.hash(w.title || id) % 360;
    return `<div class="${cls} lib-tile" aria-hidden="true" style="background:hsl(${hue} 30% 30%)"><span>${esc((w.title || '?').trim().charAt(0).toUpperCase())}</span></div>`;
  }

  const listTitle = (url) => (E.Remote.lists().find((l) => l.url === url) || { title: 'a list' }).title;
  const sourceLabel = (id) => {
    const item = worlds.get(id);
    if (item && item.entry.source === 'remote') return `From ${item.entry.list.title}`;
    const from = item && item.entry.meta && item.entry.meta.from;
    if (from) return `Downloaded from ${listTitle(from.list)}`;
    return E.Library.isStored(id) ? 'Opened by you' : 'Comes with Ensemble';
  };
  const fromList = (id) => { const item = worlds.get(id); return !!item && (item.entry.source === 'remote' || !!(item.entry.meta && item.entry.meta.from)); };
  // A downloaded world whose list has another version: { w, list } or null.
  function updateFor(id) {
    const from = ((worlds.get(id) || {}).entry || {}).meta && worlds.get(id).entry.meta.from;
    if (!from) return null;
    const l = E.Remote.lists().find((x) => x.url === from.list);
    const w = l && (l.worlds || []).find((x) => x.id === from.id);
    return w && (w.version || '') !== (from.version || '') ? { w, list: l.url } : null;
  }
  const byline = (w) => [w.author && `by ${w.author}`, w.credit, w.license].filter(Boolean).join(' · ');
  const tagsHtml = (w) => (w.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  // ---------- the list ----------
  function shown() {
    return [...worlds.entries()].filter(([id, { world }]) =>
      (!filter.source || (filter.source === 'remote' ? fromList(id) : filter.source === 'stored' ? E.Library.isStored(id) && !fromList(id) : !E.Library.isStored(id) && !fromList(id))) &&
      (!filter.tag || (world.tags || []).includes(filter.tag)));
  }
  function renderTags() {
    const all = [...new Set([...worlds.values()].flatMap(({ world }) => world.tags || []))].sort();
    if (filter.tag && !all.includes(filter.tag)) filter.tag = '';
    $('lTags').innerHTML = all.length ? [''].concat(all).map((t) =>
      `<button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="${filter.tag === t}">${t ? esc(t) : 'All'}</button>`).join('') : '';
  }
  function renderGrid() {
    renderTags();
    const list = shown();
    $('lGrid').innerHTML = list.map(([id, { world: w }]) => `<a class="lib-card" href="?world=${encodeURIComponent(id)}" data-world="${esc(id)}">
      ${pictureHtml(id, w)}
      <div class="lib-body">
        <div class="lib-title">${esc(w.title)}</div>
        ${w.error ? `<div class="fail small">Has errors: ${esc(w.error)}</div>` : w.summary ? `<div class="lib-summary">${esc(w.summary)}</div>` : ''}
        <div>${tagsHtml(w)}</div>
        <div class="muted small">${esc([byline(w), sourceLabel(id)].filter(Boolean).join(' · '))}</div>
        ${w.remote ? `<div class="small lib-get">${esc(worlds.get(id).status === 'taken' ? 'A world of this name is already here' : `Download${w.size ? ` · ${E.Remote.mb(w.size)}` : ''}`)}</div>` : updateFor(id) ? '<div class="small lib-get">Update available</div>' : ''}
      </div></a>`).join('') ||
      `<div class="muted">${worlds.size ? 'No world matches. Pick All to see every world.' : fromDisk ? 'No worlds yet.' : 'No worlds yet. Use Open folder to add one.'}</div>`;
    $('lHelp').classList.toggle('hidden', !(fromDisk && ![...worlds.keys()].some((id) => E.Library.isStored(id))));
  }
  $('lTags').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tag]');
    if (!b) return;
    filter.tag = b.dataset.tag;
    renderGrid();
  });
  $('lSource').addEventListener('change', () => { filter.source = $('lSource').value; renderGrid(); });

  // ---------- a world's details ----------
  function renderDetails(id) {
    const item = worlds.get(id);
    if (!item) {
      $('lDetails').innerHTML = `<p><a href="library.html" data-all>← All worlds</a></p><p class="muted">That world isn't in the library. It may have been removed.</p>`;
      return;
    }
    const w = item.world;
    if (w.remote) return remoteDetails(id, item);
    const play = (startId) => `new.html?world=${encodeURIComponent(id)}${startId ? `&start=${encodeURIComponent(startId)}` : ''}`;
    const starts = (w.starts || []).map((s) => `<li class="lib-start">
      <div><b>${esc(s.title)}</b>${s.summary ? `<div class="small">${esc(s.summary)}</div>` : ''}${s.error ? `<div class="fail small">Can't be played: ${esc(s.error)}</div>` : ''}</div>
      ${s.error ? '' : `<a class="btn primary" href="${play(s.id)}" data-play="${esc(s.id)}">Play</a>`}</li>`).join('');
    const own = w.generate ? `<li class="lib-start"><div><b>✦ Make my own</b><div class="small">Pick where and who you are; the story engine builds the place, the people and an opening.</div></div><a class="btn" href="${play('__generate')}" data-play="__generate">Make my own</a></li>` : '';
    const forWorld = packs.filter(({ pack }) => pack.world === w.id);
    const meta = item.entry.meta;
    $('lDetails').innerHTML = `<p><a href="library.html" data-all>← All worlds</a></p>
      ${pictureHtml(id, w, true)}
      <h2 id="lTitle">${esc(w.title)}</h2>
      ${w.summary ? `<p>${esc(w.summary)}</p>` : ''}
      <div>${tagsHtml(w)}</div>
      <p class="muted small">${esc([byline(w), sourceLabel(id), meta ? sizeText(meta.size) : ''].filter(Boolean).join(' · '))}</p>
      ${w.error ? `<p class="fail">This world doesn't load: ${esc(w.error)}</p>` : `<h3>Where you start</h3><ul class="lib-starts">${starts}${own}</ul>`}
      ${forWorld.length ? `<h3>Lore packs for it</h3><ul class="lib-packs">${forWorld.map(({ entry, pack }) => `<li><b>${esc(pack.title)}</b> <span class="muted small">${esc([pack.credit, pack.license, sourceLabel(entry.id)].filter(Boolean).join(' · '))}</span>${E.Library.isStored(entry.id) ? ` <button type="button" class="ghost small" data-remove-pack="${esc(entry.id)}">Remove</button>` : ''}${pack.summary ? `<div class="small">${esc(pack.summary)}</div>` : ''}</li>`).join('')}</ul><p class="muted small">Turn packs on in the game, with Lore packs beside New game.</p>` : ''}
      ${updateFor(id) ? `<div class="row wrap"><button type="button" class="primary" data-get="${esc(id)}">Update to version ${esc(updateFor(id).w.version || 'new')}</button><span class="muted small" id="lGetStatus" aria-live="polite"></span></div>` : ''}
      ${E.Library.isStored(id) ? `<div class="row wrap"><button type="button" id="lRemove" class="danger">Remove from this browser</button></div>` : ''}`;
  }
  // A list's world not downloaded yet: what the list says, and Download.
  function remoteDetails(id, item) {
    const w = item.world;
    const taken = item.status === 'taken';
    $('lDetails').innerHTML = `<p><a href="library.html" data-all>← All worlds</a></p>
      ${pictureHtml(id, w, true)}
      <h2 id="lTitle">${esc(w.title)}</h2>
      ${w.summary ? `<p>${esc(w.summary)}</p>` : ''}
      <div>${tagsHtml(w)}</div>
      <p class="muted small">${esc([byline(w), sourceLabel(id), w.version ? `version ${w.version}` : '', w.size ? E.Remote.mb(w.size) : ''].filter(Boolean).join(' · '))}</p>
      ${taken ? `<p class="fail">There's already a world called "${esc(w.id)}" in your library from somewhere else. Remove it first to download this one.</p>`
        : `<div class="row wrap"><button type="button" class="primary" data-get="${esc(id)}">Download${w.size ? ` (${esc(E.Remote.mb(w.size))})` : ''}</button><span class="muted small" id="lGetStatus" aria-live="polite"></span></div>
      <p class="muted small">It is checked like any world you open, then kept in this browser and plays without the network.</p>`}`;
  }

  // ---------- which view ----------
  function route() {
    let id = null;
    try { id = new URLSearchParams(location.search).get('world'); } catch (e) {}
    $('lAll').classList.toggle('hidden', !!id);
    $('lDetails').classList.toggle('hidden', !id);
    if (id) { renderDetails(id); document.title = `${(worlds.get(id) || {}).world ? worlds.get(id).world.title : 'Library'} · Ensemble`; }
    else { renderGrid(); document.title = 'Library · Ensemble'; }
    window.scrollTo(0, 0);
    document.querySelector('main.page').scrollTop = 0;
  }
  function go(search) {
    history.pushState(null, '', location.pathname + search);
    route();
  }
  window.addEventListener('popstate', route);
  document.addEventListener('click', (ev) => {
    const card = ev.target.closest('a[data-world]');
    if (card && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) { ev.preventDefault(); go('?world=' + encodeURIComponent(card.dataset.world)); return; }
    if (ev.target.closest('a[data-all]')) { ev.preventDefault(); go(''); }
  });

  // ---------- remove ----------
  // Names what goes, and that saves keep playing (they carry their scenario).
  $('lDetails').addEventListener('click', async (ev) => {
    const get = ev.target.closest('[data-get]');
    if (get) {
      const item = worlds.get(get.dataset.get);
      const up = updateFor(get.dataset.get);
      const w = up ? up.w : item.world.remoteEntry;
      const listUrl = up ? up.list : item.entry.list.url;
      get.disabled = true;
      $('lGetStatus').textContent = 'Downloading…';
      try {
        const out = await E.Remote.download(w, listUrl);
        await load();
        status(`${out.status === 'updated' ? 'Updated' : out.status === 'same' ? 'Already in your library:' : 'Downloaded'} "${out.world.title}".`);
        go('?world=' + encodeURIComponent(out.id));
      } catch (e) {
        get.disabled = false;
        $('lGetStatus').textContent = '';
        status(e.message, true);
      }
      return;
    }
    if (ev.target.id === 'lRemove') {
      const id = new URLSearchParams(location.search).get('world');
      const w = worlds.get(id).world;
      const saves = (await E.Saves.list()).filter((m) => m.world === w.id).length;
      const ask = `Remove "${w.title}" from this browser?\n\n` +
        (saves ? `Your ${saves} saved game${saves === 1 ? '' : 's'} of it keep playing, without its pictures. ` : '') +
        'To play a new game of it again, open its folder or zip again.';
      if (!window.confirm(ask)) return;
      await E.Library.remove(id);
      worlds.delete(id);
      status(`Removed "${w.title}".`);
      go('');
      return;
    }
    const pid = ev.target.dataset && ev.target.dataset.removePack;
    if (pid) {
      const p = packs.find((x) => x.entry.id === pid);
      if (!window.confirm(`Remove the lore pack "${p.pack.title}" from this browser? Games that started with it keep it.`)) return;
      await E.Library.remove(pid);
      packs = packs.filter((x) => x !== p);
      status(`Removed the lore pack "${p.pack.title}".`);
      route();
    }
  });

  // ---------- opening worlds and packs ----------
  function status(text, bad) {
    $('lStatus').textContent = text;
    $('lStatus').classList.toggle('fail', !!bad);
    $('lStatus').classList.toggle('hidden', !text);
  }
  const SAID = { added: 'Added', updated: 'Updated', same: 'Already in your library:' };
  // raws: [{ kind, raw } | { error }] → kept, with one line saying what happened.
  async function keepAll(raws) {
    const done = [], errors = [];
    let last = null;
    for (const r of raws) {
      if (r.error) { errors.push(r.error); continue; }
      try {
        const out = await E.Library.keep(r.kind, r.raw);
        const title = out.world ? out.world.title : out.pack.title;
        done.push(`${SAID[out.status]} ${r.kind === 'pack' ? 'the lore pack ' : ''}"${title}"`);
        if (r.kind === 'world') last = out.id;
      } catch (e) { errors.push(`${r.raw.folder}: ${e.message}`); }
    }
    await load();
    if (!done.length && !errors.length) errors.push('No world.json, scenario.json or pack.json in that.');
    status([done.join('. ') + (done.length ? '.' : ''), errors.length ? `Skipped: ${errors.join('; ')}` : ''].filter(Boolean).join(' '), !done.length);
    if (last && done.length === 1) go('?world=' + encodeURIComponent(last));
    else route();
  }
  $('lFolder').addEventListener('change', async (ev) => {
    const files = ev.target.files;
    if (!files.length) return;
    status('Reading the folder…');
    const raw = await E.Scenario.readFolderFiles(files);
    const found = await E.Packs.readFolderRaw(files);
    ev.target.value = '';
    await keepAll(raw.worlds.map((w) => ({ kind: 'world', raw: w })).concat(raw.errors.map((error) => ({ error })),
      found.map((p) => (p.error ? { error: `${p.folder}: ${p.error}` } : { kind: 'pack', raw: p }))));
  });
  $('lZip').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    status('Reading the zip…');
    let entries;
    try { entries = await E.Zip.readAsync(new Uint8Array(await f.arrayBuffer())); }
    catch (e) { status(`That file isn't a zip Ensemble can read: ${e.message}`, true); return; }
    const name = f.name.replace(/\.zip$/i, '');
    let item;
    try { item = { kind: 'world', raw: E.Scenario.readZip(entries, name) }; }
    catch (e) {
      try { item = { kind: 'pack', raw: E.Packs.fromZip(entries, name) }; }
      catch (err) { item = { error: 'No world.json, scenario.json or pack.json in that zip.' }; }
    }
    await keepAll([item]);
  });

  // ---------- lists (task A-8) ----------
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  function renderLists() {
    const lists = E.Remote.lists();
    $('lLists').innerHTML = lists.map((l) => `<li class="lib-list">
      <div><b>${esc(l.title)}</b> <span class="muted small">${esc(l.url)}</span>
        <div class="small">${(l.worlds || []).length} world${(l.worlds || []).length === 1 ? '' : 's'} · fetched ${esc(ago(l.fetched))}${(l.skipped || []).length ? ` · <span class="muted">${(l.skipped || []).length} skipped</span>` : ''}</div>
        ${l.error ? `<div class="fail small">The last refresh failed: ${esc(l.error)}</div>` : ''}
        ${(l.skipped || []).length ? `<details class="small"><summary>Skipped</summary><ul>${l.skipped.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}</div>
      <div class="row"><button type="button" class="small" data-list-refresh="${esc(l.url)}">Refresh</button><button type="button" class="small ghost" data-list-remove="${esc(l.url)}">Remove</button></div></li>`).join('')
      || '<li class="muted small">No lists yet. A list is a link someone shares to a set of worlds you can download.</li>';
  }
  $('lListForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const url = $('lListUrl').value;
    $('lListAdd').disabled = true;
    status('Fetching the list…');
    try {
      const l = await E.Remote.add(url);
      $('lListUrl').value = '';
      await load();
      status(`Added "${l.title}": ${l.worlds.length} world${l.worlds.length === 1 ? '' : 's'}.${l.skipped.length ? ` ${l.skipped.length} skipped (see the list below).` : ''}`);
      route();
    } catch (e) { status(e.message, true); }
    $('lListAdd').disabled = false;
  });
  $('lLists').addEventListener('click', async (ev) => {
    const r = ev.target.closest('[data-list-refresh]'), x = ev.target.closest('[data-list-remove]');
    if (r) {
      r.disabled = true;
      const l = await E.Remote.refresh(r.dataset.listRefresh);
      await load();
      status(l.error ? `"${l.title}" couldn't be refreshed: ${l.error}` : `Refreshed "${l.title}".`, !!l.error);
      route();
    } else if (x) {
      const l = E.Remote.lists().find((y) => y.url === x.dataset.listRemove);
      if (!window.confirm(`Remove the list "${l ? l.title : x.dataset.listRemove}"? Worlds you downloaded from it stay.`)) return;
      await E.Remote.remove(x.dataset.listRemove);
      await load();
      status('List removed.');
      route();
    }
  });
  // Opening the library fetches every list again, quietly; a failure is
  // shown on its list and keeps what it had.
  async function refreshAll() {
    const lists = E.Remote.lists();
    if (!lists.length) return;
    for (const l of lists) await E.Remote.refresh(l.url);
    await load();
    route();
  }

  // ---------- loading ----------
  async function load() {
    const list = await E.Library.list('world');
    const loaded = await Promise.all(list.map((e) => E.Library.load(e.id).catch((err) => ({ folder: e.folder, title: e.title, error: err.message }))));
    worlds.clear();
    list.forEach((e, i) => { if (loaded[i]) worlds.set(e.id, { entry: e, world: loaded[i] }); });
    const plist = await E.Library.list('pack');
    const pl = await Promise.all(plist.map((e) => E.Library.load(e.id).catch(() => null)));
    packs = plist.map((entry, i) => ({ entry, pack: pl[i] })).filter((x) => x.pack);
    // A list's worlds, unless downloaded already (then they are stored cards).
    (await E.Library.list('remote')).forEach((e) => {
      const st = E.Remote.status(e.world, e.list.url, list);
      if (st === 'downloaded' || st === 'update') return;
      worlds.set(e.id, { entry: e, status: st, world: Object.assign({}, e.world, { remote: true, folder: e.world.id, remoteEntry: e.world }) });
    });
    renderLists();
    if (E.Library.failed.server) status('The worlds that come with Ensemble couldn\'t be listed (scenarios/index.json is missing).', true);
  }

  async function boot() {
    E.Header.mount({ title: 'Ensemble Library' });
    await E.Store.ready();
    E.pageCheck();
    E.loadSettings();
    window.EnsembleAppearance(E.settings.appearance);
    E.Header.refresh();
    E.Header.checkConnection(false);
    $('lHelp').innerHTML = 'Opened straight from a file, Ensemble can\'t see its <b>scenarios</b> folder by itself. Press <b>Open folder</b> and pick the <b>scenarios</b> folder (or one world\'s folder), or <b>Open zip</b> for a zipped world. The worlds you open are kept here, so you only do this once. (Or run <b>start.bat</b> / <b>start.sh</b> and every world shows on its own.)';
    // The shared site maps, so worlds that use them compose as in the game.
    try {
      const [shared] = await E.Library.list('library');
      if (shared) E.Scenario.library = await E.Library.load(shared.id);
    } catch (e) { /* worlds use their own maps */ }
    if (fromDisk) $('lListNote').classList.remove('hidden');
    await load();
    $('lGrid').textContent = '';
    route();
    refreshAll();
  }
  boot();
})();
