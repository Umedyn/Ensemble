// Scenario loading. A scenario is a folder:
//   scenarios/<folder>/scenario.json
//   scenarios/<folder>/characters/<id>.json   (one per id in scenario.characters)
// Loaded either from a local server (scenarios/index.json lists folders) or
// from a folder picked on disk (works when index.html is opened directly).
(function (root) {
  const E = root.Ensemble;
  const S = (E.Scenario = {});

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  S.listServer = async function () {
    const idx = await getJSON('scenarios/index.json');
    return (idx.scenarios || idx).map((x) => (typeof x === 'string' ? { folder: x, title: x } : x));
  };

  S.loadServer = async function (folder) {
    const sc = await getJSON(`scenarios/${folder}/scenario.json`);
    sc.characterData = await Promise.all(sc.characters.map((id) => getJSON(`scenarios/${folder}/characters/${id}.json`)));
    sc.folder = folder;
    return S.validate(sc);
  };

  // FileList from <input webkitdirectory>. Finds every scenario.json in it, so
  // picking either one scenario folder or the whole scenarios/ folder works.
  S.loadFromFiles = async function (fileList) {
    const files = Array.from(fileList);
    const byPath = new Map(files.map((f) => [f.webkitRelativePath || f.name, f]));
    const readJSON = async (f) => JSON.parse(await f.text());
    const results = [];
    const errors = [];
    for (const [path, f] of byPath) {
      if (!/(^|\/)scenario\.json$/.test(path)) continue;
      const dir = path.slice(0, path.length - 'scenario.json'.length);
      try {
        const sc = await readJSON(f);
        sc.characterData = [];
        for (const id of sc.characters || []) {
          const cf = byPath.get(`${dir}characters/${id}.json`);
          if (!cf) throw new Error(`missing characters/${id}.json`);
          sc.characterData.push(await readJSON(cf));
        }
        sc.folder = dir.replace(/\/$/, '').split('/').pop() || sc.id;
        results.push(S.validate(sc));
      } catch (err) {
        errors.push(`${dir || '(root)'}: ${err.message}`);
      }
    }
    if (!results.length) {
      throw new Error(errors.length ? errors.join('\n') : 'No scenario.json found in that folder.');
    }
    return { scenarios: results, errors };
  };

  // Catches authoring mistakes early with readable messages.
  S.validate = function (sc) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    req(sc.title, 'missing "title"');
    req(sc.setting, 'missing "setting"');
    req(Array.isArray(sc.characters) && sc.characters.length, 'missing "characters" list');
    req(sc.characters && sc.characters.includes(sc.player), '"player" must be one of "characters"');
    req(Array.isArray(sc.locations) && sc.locations.length, 'missing "locations"');
    sc.skills = sc.skills || ['physical', 'technical', 'social', 'knowledge', 'stealth'];
    sc.needs = sc.needs || [{ id: 'hunger', label: 'Hunger', perHour: 0.03 }, { id: 'fatigue', label: 'Fatigue', perHour: 0.04 }];
    const locIds = new Set((sc.locations || []).map((l) => l.id));
    (sc.locations || []).forEach((l) => (l.connects || []).forEach((c) => req(locIds.has(c), `location "${l.id}" connects to unknown "${c}"`)));
    (sc.characterData || []).forEach((c, i) => {
      const expected = sc.characters[i];
      req(c.id === expected, `characters/${expected}.json has id "${c.id}"`);
      req(c.name, `character "${c.id}" missing "name"`);
      req(!c.guard || ['low', 'medium', 'high'].includes(c.guard), `character "${c.id}" guard must be low, medium or high`);
      req(c.status && locIds.has(c.status.location), `character "${c.id}" starts at unknown location "${c.status && c.status.location}"`);
      Object.keys(c.skills || {}).forEach((k) => req(sc.skills.includes(k), `character "${c.id}" has skill "${k}" not in scenario skills`));
      Object.keys(c.relations || {}).forEach((k) => req(sc.characters.includes(k), `character "${c.id}" has relation to unknown "${k}"`));
    });
    Object.entries(sc.eventRates || {}).forEach(([k, v]) => req(['regional', 'world'].includes(k) && typeof v === 'number' && v >= 0, `eventRates.${k} must be regional/world with hours >= 0 (0 turns it off)`));
    (sc.factions || []).forEach((f) => req(f.id && f.name && f.desc && f.stance, `group "${f.id || '?'}" needs id, name, desc and stance`));
    (sc.clocks || []).forEach((c) => {
      req(c.id && c.name && c.max > 0, `clock "${c.id || '?'}" needs id, name and max`);
      Object.keys(c.fireWorld || {}).forEach((k) => req(sc.world && k in sc.world, `clock "${c.id}" fireWorld key "${k}" not in world`));
      (c.then || []).forEach((t) => {
        req(t.id && t.name && t.max > 0, `clock "${c.id}" has a follow-up ("then") without id, name and max`);
        Object.keys(t.fireWorld || {}).forEach((k) => req(sc.world && k in sc.world, `follow-up clock "${t.id}" fireWorld key "${k}" not in world`));
      });
    });
    if (problems.length) throw new Error(`Scenario "${sc.title || sc.folder}" has problems:\n- ` + problems.join('\n- '));
    return sc;
  };
})(typeof window !== 'undefined' ? window : globalThis);
