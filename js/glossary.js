// Links in the story text: the names of places, people and lore terms in a
// scene, each with what the player may know about it (shown on hover, or in
// a popup on a click or tap). Only public things are linked: known regions,
// places the story has made, rooms the player has seen that have lore, the
// people in the story and the minor people who have turned up, and lore
// titles and capitalised keywords (lore is public by rule) whose place or
// person is linked too. Secrets, private facts and hidden regions never are.
// DOM-free; ui.js draws the boxes.
(function (root) {
  const E = root.Ensemble;
  const G = (E.Glossary = {});
  const Eng = () => E.Engine;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const capital = (s) => /^[A-ZÀ-ɏ]/.test(s);
  // "The Seiryo dorm" → "Seiryo dorm"; a title that is then no name ("A school day") links nothing.
  const bare = (s) => String(s || '').trim().replace(/^(?:the|a|an)\s+/i, '');
  // Words before a name that aren't one ("Principal Matsudaira", "Uncle Fujiwara").
  const TITLES = /^(?:the|a|an|mr|mrs|ms|mx|dr|prof|professor|capt|captain|sgt|sergeant|lt|lieutenant|col|colonel|gen|general|major|sir|lady|lord|miss|madam|madame|mme|mlle|m|monsieur|herr|frau|father|mother|sister|brother|uncle|aunt|auntie|grandma|grandpa|granny|old|young|little|big|doc|doctor|nurse|officer|sheriff|marshal|deputy|mayor|chief|principal|coach|sensei|reverend|rev|pastor|judge|commander|cmdr|private|corporal|agent|detective|inspector|elder|chief)\.?$/i;

  // Rooms with lore of their own, and lore entries the player may see.
  const loreFor = (state, level, ref) => E.Lore.entries(state.scenario).filter((e) => e.level === level && e.ref === ref);
  function loreVisible(state, e) {
    if (e.level === 'region') return regionVisible(state, e.ref);
    if (e.level === 'location') return (state.seenRooms || []).includes(e.ref);
    if (e.level === 'character') return !!state.characters[e.ref];
    return true;
  }
  const regionVisible = (state, id) => !!(state.regions && state.regions[id]) && Eng().regionKnown(state, id);

  // Every linkable term → its target ({ kind, id }). The first source to claim
  // a term keeps it: people, then regions, places, rooms and lore.
  // → { terms: Map(term → target), re: RegExp or null }
  G.build = function (state) {
    const terms = new Map();
    const add = (term, target) => {
      const t = bare(term);
      if (t.length < 3 || !capital(t) || terms.has(t)) return;
      terms.set(t, target);
    };
    // People: full names, and name parts no one else in the story shares
    // ("Saeki" for Ms. Saeki; never "Hayakawa" in a family of four).
    const people = Eng().cast(state).filter((id) => id !== state.player).map((id) => ({ name: state.characters[id].name, target: { kind: 'person', id } }))
      .concat(Object.values(state.extras || {}).filter((x) => x && x.name).map((x) => ({ name: x.name, target: { kind: 'extra', id: x.id } })));
    const pc = state.characters[state.player];
    const parts = (n) => String(n || '').split(/\s+/).map((w) => w.replace(/[^\w'’-]/g, '')).filter((w) => w && !TITLES.test(w));
    const count = {};
    people.map((p) => p.name).concat(pc ? [pc.name] : []).forEach((n) => new Set(parts(n)).forEach((w) => { count[w] = (count[w] || 0) + 1; }));
    people.forEach((p) => add(p.name, p.target));
    people.forEach((p) => parts(p.name).forEach((w) => { if (count[w] === 1) add(w, p.target); }));
    (state.scenario.regions || []).filter((r) => r && regionVisible(state, r.id)).forEach((r) => add(r.name, { kind: 'region', id: r.id }));
    Object.values(state.sites || {}).filter((s) => s && s.name && (!s.region || regionVisible(state, s.region))).forEach((s) => add(s.name, { kind: 'site', id: s.id }));
    Object.values(state.locations).filter((l) => (state.seenRooms || []).includes(l.id) && loreFor(state, 'location', l.id).length).forEach((l) => add(l.name, { kind: 'room', id: l.id }));
    E.Lore.entries(state.scenario).filter((e) => loreVisible(state, e)).forEach((e) => {
      add(e.title, { kind: 'lore', id: e.id });
      (e.keywords || []).forEach((k) => add(k, { kind: 'lore', id: e.id }));
    });
    const keys = [...terms.keys()].sort((a, b) => b.length - a.length).map(escRe);
    // Not inside a longer word; "Aoi's" still finds Aoi.
    const re = keys.length ? new RegExp(`(?<![\\w-])(?:${keys.join('|')})(?![\\w-])`, 'g') : null;
    return { terms, re };
  };

  // The index for this state, rebuilt when anything it reads may have changed.
  const cache = new WeakMap();
  G.index = function (state) {
    const sig = [state.turn, Object.keys(state.characters).length, Object.keys(state.extras || {}).length, Object.keys(state.sites || {}).length,
      (state.seenRooms || []).length, (state.scenario.regions || []).length, Object.values(state.regions || {}).filter((r) => r && r.known === false).length,
      E.Lore.entries(state.scenario).length].join('|');
    const hit = cache.get(state);
    if (hit && hit.sig === sig) return hit.idx;
    const idx = G.build(state);
    cache.set(state, { sig, idx });
    return idx;
  };
  G.key = (t) => `${t.kind}:${t.id}`;
  G.parse = (key) => { const i = String(key).indexOf(':'); return i > 0 ? { kind: key.slice(0, i), id: key.slice(i + 1) } : null; };

  // Story text → HTML: escaped, with the first mention of each thing in a
  // paragraph marked as a term. esc: the page's HTML escaper.
  G.markup = function (state, text, esc) {
    const s = String(text || '');
    const { terms, re } = G.index(state);
    if (!re) return esc(s);
    return s.split(/(\n\s*\n)/).map((para, i) => {
      if (i % 2) return para;
      const seen = new Set();
      let out = '';
      let at = 0;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(para))) {
        const key = G.key(terms.get(m[0]));
        if (seen.has(key)) continue;
        seen.add(key);
        out += esc(para.slice(at, m.index)) + `<span class="term" tabindex="0" role="button" data-term="${esc(key)}">${esc(m[0])}</span>`;
        at = m.index + m[0].length;
      }
      return out + esc(para.slice(at));
    }).join('');
  };

  const firstSentences = (s, n) => {
    const parts = String(s || '').trim().split(/(?<=[.!?])\s+(?=[A-Z"“])/);
    return parts.slice(0, n).join(' ');
  };
  const regionName = (state, id) => { const r = Eng().regionDef(state, id); return r ? r.name : id; };
  const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

  // What the player may know about a term's target. → { title, sub, text: [],
  // person (a cast id, for the card) } or null. Never secrets or private facts.
  G.info = function (state, target) {
    if (!target) return null;
    const { kind, id } = target;
    if (kind === 'person') {
      const c = state.characters[id];
      if (!c) return null;
      const mine = (state.characters[state.player].relations || {})[id] || 0;
      return {
        title: c.name,
        sub: [c.role, c.pronouns, c.age].filter(Boolean).join(' · '),
        text: [firstSentences(c.description, 2) || firstSentences(c.appearance, 1)].filter(Boolean),
        feel: `${E.relWord(mine)} ${mine > 0 ? '+' : ''}${mine}`,
        person: id,
      };
    }
    if (kind === 'extra') {
      const x = (state.extras || {})[id];
      if (!x) return null;
      return { title: x.name, sub: x.role || '', text: [x.desc || x.description || ''].filter(Boolean) };
    }
    if (kind === 'region') {
      const r = Eng().regionDef(state, id);
      if (!r || !regionVisible(state, id)) return null;
      const label = E.Scenario.regionLabel(state.scenario, id);
      const up = Eng().regionChain(state, id).slice(1).map((x) => regionName(state, x));
      const holder = Eng().regionHolder(state, id);
      const sub = [label ? `${article(label)} ${label}` : '', up.length ? `in ${up.join(', ')}` : ''].filter(Boolean).join(' ');
      const now = state.regions[id];
      const text = [r.lore].concat(loreFor(state, 'region', id).map((e) => e.text)).filter(Boolean);
      return {
        title: r.name,
        sub: (sub ? sub[0].toUpperCase() + sub.slice(1) : '') + (holder.controller ? `${sub ? '; ' : ''}held by ${holder.text}` : '') + (now && now.status ? ` · ${now.status}` : ''),
        text: [...new Set(text)],
      };
    }
    if (kind === 'site') {
      const s = (state.sites || {})[id];
      if (!s) return null;
      const rooms = (s.rooms || []).concat(s.entry ? [s.entry] : []);
      const text = [...new Set(rooms)].filter((r) => (state.seenRooms || []).includes(r)).flatMap((r) => loreFor(state, 'location', r).map((e) => e.text));
      return { title: s.name, sub: [s.kind && s.kind !== s.name ? s.kind : '', s.region ? `in ${regionName(state, s.region)}` : ''].filter(Boolean).join(' '), text };
    }
    if (kind === 'room') {
      const l = state.locations[id];
      if (!l) return null;
      return { title: l.name, sub: l.region ? `in ${regionName(state, l.region)}` : '', text: [l.desc].concat(loreFor(state, 'location', id).map((e) => e.text)).filter(Boolean) };
    }
    if (kind === 'lore') {
      const e = E.Lore.entries(state.scenario).find((x) => x.id === id);
      if (!e || !loreVisible(state, e)) return null;
      const about = e.level === 'region' ? regionName(state, e.ref) : e.level === 'location' ? (state.locations[e.ref] || {}).name : e.level === 'character' ? (state.characters[e.ref] || {}).name : '';
      return { title: e.title, sub: about ? `About ${about}` : '', text: [e.text] };
    }
    return null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
