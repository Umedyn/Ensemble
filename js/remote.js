// Remote library lists (task A-8): a list URL the player adds on the library
// page, its worlds as cards, and downloading one into the library as a kept
// bundle (E.Library.keep), checked like any world opened from a folder.
// Loaded only by the library page: nothing here is fetched during play.
// Remote content is untrusted: lists and zips are size-capped, every field is
// checked, and a failure says why in plain words and changes nothing.
// DOM-free.
(function (root) {
  const E = root.Ensemble;
  const R = (E.Remote = {});
  const KEY = 'ensemble.lists';
  const MB = 1048576;
  R.FORMAT = 'ensemble-list';
  R.LIMITS = { list: 512 * 1024, worlds: 500, download: 50 * MB, entry: 20 * MB, total: 200 * MB, count: 2000 };
  const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const text = (v, max) => typeof v === 'string' && v.trim() && v.length <= max;
  const mb = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  R.mb = mb;

  // ---------- the lists added ----------
  // [{ url, title, fetched, worlds: [entry], skipped: [why], error }], kept in
  // the browser. A fresh install has none.
  R.lists = function () {
    try { const v = JSON.parse(E.Prefs.get(KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  };
  const save = (lists) => E.Prefs.set(KEY, JSON.stringify(lists));

  // An address the player typed: http(s) only. → the full URL, or throws.
  R.address = function (s) {
    let u;
    try { u = new URL(String(s || '').trim()); } catch (e) { throw new Error('That isn\'t a web address. A list\'s address starts with https://'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('A list\'s address starts with https:// (or http://).');
    return u.href;
  };

  // ---------- checking a list ----------
  // The list's JSON → { title, worlds, skipped }: each world checked in plain
  // words; a world with a problem is skipped (and said), the rest kept. Its
  // url is made absolute against the list's own address.
  R.check = function (json, base) {
    if (!isObj(json) || json.format !== R.FORMAT) throw new Error(`That isn't an Ensemble list: it needs "format": "${R.FORMAT}".`);
    if (json.version != null && json.version !== 1) throw new Error('That list is for a newer version of Ensemble.');
    if (!Array.isArray(json.worlds)) throw new Error('That list has no "worlds".');
    const title = text(json.title, 80) ? json.title.trim() : new URL(base).host;
    const worlds = [], skipped = [], seen = new Set();
    json.worlds.slice(0, R.LIMITS.worlds).forEach((w, i) => {
      const why = worldProblem(w, base);
      const name = isObj(w) && typeof w.title === 'string' ? `"${w.title.slice(0, 80)}"` : `world ${i + 1}`;
      if (why) return skipped.push(`${name}: ${why}`);
      if (seen.has(w.id)) return skipped.push(`${name}: the id "${w.id}" is listed twice`);
      seen.add(w.id);
      worlds.push({
        id: w.id, title: w.title.trim(), summary: typeof w.summary === 'string' ? w.summary.trim() : '',
        tags: Array.isArray(w.tags) ? w.tags.slice() : [], author: typeof w.author === 'string' ? w.author.trim() : '',
        credit: w.credit.trim(), license: w.license.trim(), url: new URL(w.url, base).href,
        size: typeof w.size === 'number' ? w.size : null, version: typeof w.version === 'string' ? w.version : '',
      });
    });
    if (json.worlds.length > R.LIMITS.worlds) skipped.push(`only the first ${R.LIMITS.worlds} worlds are read`);
    return { title, worlds, skipped };
  };
  function worldProblem(w, base) {
    if (!isObj(w)) return 'not a world entry';
    if (typeof w.id !== 'string' || !ID.test(w.id)) return '"id" must be lowercase letters, digits, - or _ (it becomes the folder name)';
    if (!text(w.title, 80)) return '"title" must be text of at most 80 characters';
    if (w.summary != null && !(typeof w.summary === 'string' && w.summary.length <= 400)) return '"summary" must be text of at most 400 characters';
    if (w.tags != null && !(Array.isArray(w.tags) && w.tags.length <= 8 && w.tags.every((t) => text(t, 30)))) return '"tags" must be up to 8 short words';
    if (w.author != null && !(typeof w.author === 'string' && w.author.length <= 80)) return '"author" must be text of at most 80 characters';
    if (!text(w.credit, 200)) return '"credit" must say who made it (at most 200 characters)';
    if (!text(w.license, 80)) return '"license" must name the license it is shared under';
    if (w.size != null && !(typeof w.size === 'number' && w.size > 0)) return '"size" must be the zip\'s size in bytes';
    if (w.size > R.LIMITS.download) return `it is ${mb(w.size)}; downloads are at most ${mb(R.LIMITS.download)}`;
    if (w.version != null && !(typeof w.version === 'string' && w.version.length <= 20)) return '"version" must be short text, like "1.2"';
    let u;
    try { u = new URL(w.url, base); } catch (e) { return '"url" isn\'t an address'; }
    if (typeof w.url !== 'string' || !/^https?:$/.test(u.protocol)) return '"url" must be a web address (https://…) of a zip';
    return null;
  }

  // ---------- fetching, capped ----------
  // A response's bytes, at most max: its declared length first, then what
  // actually arrives. what: the words for it in a message.
  async function capped(url, max, what) {
    let res;
    try { res = await root.fetch(url, { cache: 'no-store', credentials: 'omit' }); }
    catch (e) { throw new Error(`Couldn't reach ${new URL(url).host}. Check the address and your connection; a list must also allow other sites to read it (GitHub's raw files do).`); }
    if (!res.ok) throw new Error(`${what} answered "HTTP ${res.status}" (${res.status === 404 ? 'not found' : 'not available'}).`);
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (declared > max) throw new Error(`${what} is ${mb(declared)}; at most ${mb(max)} is allowed.`);
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const parts = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > max) { try { reader.cancel(); } catch (e) { /* gone */ } throw new Error(`${what} is more than ${mb(max)}; at most ${mb(max)} is allowed.`); }
        parts.push(value);
      }
      const out = new Uint8Array(n);
      let at = 0;
      parts.forEach((p) => { out.set(p, at); at += p.length; });
      return out;
    }
    const out = new Uint8Array(await res.arrayBuffer());
    if (out.length > max) throw new Error(`${what} is more than ${mb(max)}; at most ${mb(max)} is allowed.`);
    return out;
  }

  // Fetches and checks a list. → { title, worlds, skipped }
  R.fetchList = async function (url) {
    const bytes = await capped(url, R.LIMITS.list, 'The list');
    let json;
    try { json = JSON.parse(E.Zip.text(bytes)); } catch (e) { throw new Error('That isn\'t an Ensemble list (it isn\'t JSON).'); }
    return R.check(json, url);
  };

  // Adds a list: fetched and checked first, so a bad one adds nothing.
  R.add = async function (address) {
    const url = R.address(address);
    const lists = R.lists();
    if (lists.some((l) => l.url === url)) throw new Error('That list is already in your library.');
    const got = await R.fetchList(url);
    const list = Object.assign({ url, fetched: Date.now(), error: '' }, got);
    lists.push(list);
    await save(lists);
    return list;
  };
  // Fetches a list again. A failure keeps what was fetched before and says why.
  R.refresh = async function (url) {
    const lists = R.lists();
    const l = lists.find((x) => x.url === url);
    if (!l) throw new Error('That list isn\'t in your library.');
    try {
      Object.assign(l, await R.fetchList(url), { fetched: Date.now(), error: '' });
    } catch (e) { l.error = e.message; }
    await save(lists);
    return l;
  };
  R.remove = async function (url) {
    await save(R.lists().filter((l) => l.url !== url));
  };

  // ---------- downloading ----------
  // Where a list's world stands here: 'download', 'downloaded', 'update' (the
  // list has another version), or 'taken' (a world of that name came from
  // somewhere else). stored: E.Library.list('world') entries.
  R.status = function (w, listUrl, stored) {
    const s = (stored || []).find((x) => x.source === 'stored' && x.folder === w.id);
    if (!s) return 'download';
    const from = s.meta && s.meta.from;
    if (!from || from.list !== listUrl) return 'taken';
    return (from.version || '') === (w.version || '') ? 'downloaded' : 'update';
  };
  // Downloads a list's world into the library, checked like any world opened
  // from a folder. → { id, status, world }
  R.download = async function (w, listUrl) {
    const stored = await E.Library.list('world');
    if (R.status(w, listUrl, stored) === 'taken') throw new Error(`There's already a world called "${w.id}" in your library from somewhere else. Remove it first to download this one.`);
    if (w.size > R.LIMITS.download) throw new Error(`"${w.title}" is ${mb(w.size)}; downloads are at most ${mb(R.LIMITS.download)}.`);
    const bytes = await capped(w.url, R.LIMITS.download, `"${w.title}"`);
    let entries;
    try { entries = await E.Zip.readAsync(bytes, R.LIMITS); }
    catch (e) { throw new Error(`"${w.title}" isn't a zip Ensemble can read: ${e.message}.`); }
    let raw;
    try { raw = E.Scenario.readZip(entries, w.id); }
    catch (e) { throw new Error(`"${w.title}" isn't a world: ${e.message}`); }
    raw.folder = w.id;
    raw.from = { list: listUrl, id: w.id, version: w.version || '' };
    try { return await E.Library.keep('world', raw); }
    catch (e) { throw new Error(`"${w.title}" doesn't load, so it wasn't added: ${e.message}`); }
  };

  // The lists' worlds as library entries of their own kind ('remote'), so the
  // game and New game, which list 'world', never see or fetch them.
  E.Library.addSource({
    id: 'remote',
    async list(kind) {
      if (kind !== 'remote') return [];
      return R.lists().flatMap((l) => (l.worlds || []).map((w) => ({ id: `remote:${encodeURIComponent(l.url)}:${w.id}`, kind: 'remote', source: 'remote', title: w.title, folder: w.id, world: w, list: { url: l.url, title: l.title } })));
    },
    async load() { return null; },
  });
})(typeof window !== 'undefined' ? window : globalThis);
