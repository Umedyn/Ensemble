// Portraits, the relationship web, the cast's cards and the journal.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

  // ---------- portraits ----------
  // Paths in the scenario are relative to the world folder. Server worlds load
  // them from scenarios/<folder>/; worlds opened from disk use object URLs made
  // from the picked files. Neither URL is ever saved. A picture that fails to
  // load falls back to the monogram.
  const diskAssets = new Map(); // world folder -> { path: File }
  const assetUrls = new Map(); // "folder/path" -> object URL
  const portraitUrl = (path) => assetUrl(U.state.scenario.folder, path);
  // Site maps from the shared library (task 6-3) have their images there:
  // picked with Open folder (object URLs) or on the server.
  const siteMapUrl = (m) => {
    if (!m.library) return portraitUrl(m.image);
    const f = U.libraryAssets[m.image];
    if (f) { const key = 'library/' + m.image; if (!assetUrls.has(key)) assetUrls.set(key, URL.createObjectURL(f)); return assetUrls.get(key); }
    return location.protocol === 'file:' ? null : `library/${m.image.split('/').map(encodeURIComponent).join('/')}`;
  };
  function assetUrl(folder, path) {
    const files = diskAssets.get(folder);
    if (files && files[path]) {
      const key = folder + '/' + path;
      if (!assetUrls.has(key)) assetUrls.set(key, URL.createObjectURL(files[path]));
      return assetUrls.get(key);
    }
    return location.protocol === 'file:' ? null : `scenarios/${encodeURIComponent(folder)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  function monogramHtml(id) {
    const m = E.Engine.monogram(U.state, id);
    return `<span class="portrait monogram" aria-hidden="true" style="background:hsl(${m.hue} 38% 32%)">${esc(m.monogram)}</span>`;
  }
  const failedUrls = new Set(); // pictures that didn't load: monogram from then on, no flicker
  function portraitHtml(id) {
    const p = E.Engine.portrait(U.state, id);
    const url = p.path && portraitUrl(p.path);
    return url && !failedUrls.has(url) ? `<img class="portrait" src="${esc(url)}" alt="" data-fallback="${esc(id)}">` : monogramHtml(id);
  }
  // error doesn't bubble, so listen in the capture phase.
  const portraitFallback = (ev) => {
    const img = ev.target;
    if (img.tagName !== 'IMG' || !img.dataset.fallback) return;
    failedUrls.add(img.getAttribute('src'));
    img.outerHTML = monogramHtml(img.dataset.fallback);
  };
  $('cast').addEventListener('error', portraitFallback, true);
  $('termDialog').addEventListener('error', portraitFallback, true);

  // ---------- relationship web (task 2-4) ----------
  // E.Engine.relationWeb decides what the player may see; this only draws it:
  // an SVG with a small force layout (you fixed in the middle), two curves per
  // pair so A→B and B→A can differ, and a plain list for screen readers.
  const WEB = 360;
  function layoutWeb(nodes, edges) {
    const c = WEB / 2;
    const others = nodes.filter((n) => !n.isPlayer);
    const pos = {};
    nodes.forEach((n) => { pos[n.id] = { x: c, y: c }; });
    others.forEach((n, i) => {
      const a = (i / Math.max(1, others.length)) * 2 * Math.PI - Math.PI / 2;
      pos[n.id] = { x: c + Math.cos(a) * WEB * 0.34, y: c + Math.sin(a) * WEB * 0.34 };
    });
    const pairs = new Map();
    edges.forEach((e) => { const k = [e.from, e.to].sort().join('|'); pairs.set(k, Math.max(pairs.get(k) || 0, e.level)); });
    const k = WEB / Math.sqrt(nodes.length + 1);
    for (let it = 0; it < 220; it++) {
      const step = 6 * (1 - it / 220) + 0.3;
      const force = {};
      nodes.forEach((n) => { force[n.id] = { x: 0, y: 0 }; });
      nodes.forEach((a) => nodes.forEach((b) => {
        if (a === b) return;
        const dx = pos[a.id].x - pos[b.id].x, dy = pos[a.id].y - pos[b.id].y;
        const d = Math.max(1, Math.hypot(dx, dy));
        force[a.id].x += (dx / d) * (k * k) / d;
        force[a.id].y += (dy / d) * (k * k) / d;
      }));
      pairs.forEach((level, key) => {
        const [a, b] = key.split('|');
        const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const pull = (d * d) / k * (0.6 + level * 0.25);
        force[a].x -= (dx / d) * pull; force[a].y -= (dy / d) * pull;
        force[b].x += (dx / d) * pull; force[b].y += (dy / d) * pull;
      });
      others.forEach((n) => {
        const f = force[n.id];
        const m = Math.max(1, Math.hypot(f.x, f.y));
        pos[n.id].x = E.clamp(pos[n.id].x + (f.x / m) * step, 34, WEB - 34);
        pos[n.id].y = E.clamp(pos[n.id].y + (f.y / m) * step, 30, WEB - 40);
      });
    }
    return pos;
  }
  function webNode(n, p) {
    const pic = E.Engine.portrait(U.state, n.id);
    const url = pic.path && portraitUrl(pic.path);
    const r = 18;
    const face = url && !failedUrls.has(url)
      ? `<clipPath id="webclip-${esc(n.id)}"><circle cx="${p.x}" cy="${p.y}" r="${r}"/></clipPath><image href="${esc(url)}" x="${p.x - r}" y="${p.y - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#webclip-${esc(n.id)})" preserveAspectRatio="xMidYMid slice"/>`
      : ((m) => `<circle cx="${p.x}" cy="${p.y}" r="${r}" style="fill:hsl(${m.hue} 38% 32%)"/><text class="web-mono" x="${p.x}" y="${p.y}" dy="0.35em" text-anchor="middle">${esc(m.monogram)}</text>`)(E.Engine.monogram(U.state, n.id));
    const short = n.isPlayer ? 'You' : E.Engine.shortName(U.state.characters[n.id]);
    return `<g class="web-node${n.isPlayer ? ' you' : ''}" data-id="${esc(n.id)}"><title>${esc(U.state.characters[n.id].name)}${n.isPlayer ? ' (you)' : ''}</title>${face}` +
      `<circle class="web-ring" cx="${p.x}" cy="${p.y}" r="${r}"/><text class="web-label" x="${p.x}" y="${p.y + r + 12}" text-anchor="middle">${esc(short)}</text></g>`;
  }
  function webEdge(e, pos) {
    const a = pos[e.from], b = pos[e.to];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / d, uy = dy / d;
    // Bend to the left of the direction of travel, so the two ways of a pair part.
    const mx = (a.x + b.x) / 2 - uy * 16, my = (a.y + b.y) / 2 + ux * 16;
    const sx = a.x + ux * 20 - uy * 4, sy = a.y + uy * 20 + ux * 4;
    const ex = b.x - ux * 24 - uy * 4, ey = b.y - uy * 24 + ux * 4;
    const cls = e.sign > 0 ? 'pos' : e.sign < 0 ? 'neg' : 'neu';
    const nm = (id) => (id === U.state.player ? 'You' : U.state.characters[id].name);
    const title = `${nm(e.from)} → ${nm(e.to)}: ${e.word}${e.why ? ` (${e.source === 'seen' ? 'you know: ' : ''}${e.why})` : ''}`;
    return `<path class="web-edge ${cls}${e.source === 'seen' ? ' seen' : ''}" d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" style="stroke-width:${1 + e.level * 1.5}" marker-end="url(#web-arrow-${cls})"><title>${esc(title)}</title></path>`;
  }
  function renderWeb() {
    const web = E.Engine.relationWeb(U.state, { secondary: $('webSecondary').checked });
    const pos = layoutWeb(web.nodes, web.edges);
    const arrows = ['pos', 'neg', 'neu'].map((c) => `<marker id="web-arrow-${c}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="web-arrow ${c}" d="M0,0 L10,5 L0,10 z"/></marker>`).join('');
    $('webGraph').innerHTML = `<svg viewBox="0 0 ${WEB} ${WEB}" role="img" aria-label="Relationship web: ${web.nodes.length} people">` +
      `<defs>${arrows}</defs>${web.edges.map((e) => webEdge(e, pos)).join('')}${web.nodes.map((n) => webNode(n, pos[n.id])).join('')}</svg>`;
    const nm = (id) => (id === U.state.player ? 'You' : U.state.characters[id].name);
    const lines = web.edges.map((e) => `<li class="${e.source === 'seen' ? 'seen' : ''}">${esc(nm(e.from))} ${e.from === U.state.player ? 'feel' : 'feels'} <b class="rel-${e.word}">${e.word === 'trusts' ? 'trusting' : e.word}</b> toward ${esc(e.to === U.state.player ? 'you' : nm(e.to))}` +
      `${e.why ? ` <span class="muted">— ${e.source === 'seen' ? 'you know: ' : ''}${esc(e.why)}</span>` : ''}</li>`);
    $('webList').innerHTML = lines.join('') || '<li class="muted">No one else here yet.</li>';
  }
  $('btnWeb').addEventListener('click', () => {
    if (!U.state) return;
    renderWeb();
    $('webDialog').showModal();
  });
  $('webSecondary').addEventListener('change', () => { if (U.state) renderWeb(); });

  // ---------- minimized cards ----------
  // Remembered per world and character: { worldId: [ids] }.
  const MIN_KEY = 'ensemble.cards.min';
  function minimized() {
    try { return JSON.parse(store.get(MIN_KEY)) || {}; } catch (e) { return {}; }
  }
  function isMinimized(id) { return (minimized()[U.state.scenario.worldId] || []).includes(id); }
  function setMinimized(ids, on) {
    const all = minimized();
    const w = new Set(all[U.state.scenario.worldId] || []);
    ids.forEach((id) => (on ? w.add(id) : w.delete(id)));
    all[U.state.scenario.worldId] = [...w];
    store.set(MIN_KEY, JSON.stringify(all));
    U.renderCast();
  }
  $('cast').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-min]');
    if (btn) setMinimized([btn.dataset.min], !isMinimized(btn.dataset.min));
  });
  $('btnCollapseAll').addEventListener('click', () => {
    if (!U.state) return;
    const ids = E.Engine.cast(U.state);
    setMinimized(ids, !ids.every(isMinimized));
  });
  const minButton = (id, c, min) =>
    `<button type="button" class="ghost card-min" data-min="${esc(id)}" aria-label="${min ? 'Expand' : 'Minimize'} ${esc(c.name)}" title="${min ? 'Expand' : 'Minimize'}">${min ? '+' : '–'}</button>`;

  // One row: portrait, name, mood.
  function cardMini(id, c, isPlayer) {
    const mood = !isPlayer && c.mood ? `<span class="mini-mood">${esc(c.mood.text)}</span>` : '';
    return `<div class="mini">${portraitHtml(id)}<span class="nm">${esc(c.name)}${isPlayer ? ' (you)' : ''}</span>${mood}${minButton(id, c, true)}</div>`;
  }

  // Portrait, name, role, how they and you feel about each other, and where they are.
  // bare: without the minimize button (the popup card).
  function cardHeader(id, c, isPlayer, bare) {
    const loc = U.state.locations[c.status.location];
    let rels = '';
    if (!isPlayer) {
      const rel = c.relations[U.state.player] || 0;
      const relW = E.relWord(rel);
      const mine = U.state.characters[U.state.player].relations[id] || 0;
      const myW = E.relWord(mine);
      const why = (U.state.characters[U.state.player].attitudeNotes || {})[id];
      rels = `<div class="rels"><div class="rel-${relW}" title="How they feel about you">them: ${relW} ${rel > 0 ? '+' : ''}${rel}</div>` +
        `<div class="rel-${myW}" title="${esc(why ? 'How you feel about them: ' + why : 'How you feel about them')}">you: ${myW} ${mine > 0 ? '+' : ''}${mine}</div></div>`;
    }
    return `<div class="top">${portraitHtml(id)}<div class="who"><div class="nm">${esc(c.name)}${isPlayer ? ' (you)' : ''}${c.pinned && !isPlayer ? ' <span title="Pinned" aria-label="pinned">📌</span>' : ''}</div><div class="role">${esc(c.role)}</div></div>${rels}${bare ? '' : minButton(id, c, false)}</div>` +
      `<div class="meta">${esc(whereText(id, isPlayer, loc))}</div>`;
  }
  // Where the card says someone is (task 3-3): where you last saw them, so a
  // covert move never shows.
  function whereText(id, isPlayer, loc) {
    if (isPlayer) return loc ? loc.name : '?';
    const kw = E.Engine.knownWhere(U.state, id);
    if (kw && kw.away) return kw.away;
    const room = kw && U.state.locations[kw.loc];
    if (!room) return 'whereabouts unknown';
    return kw.now ? room.name : `last seen in ${room.name}${kw.turn ? ` (turn ${kw.turn})` : ''}`;
  }

  // Who they are right now: the mood line (others only; it fades when it hasn't
  // been updated for a while), then tags from the numbers and from the story.
  function cardStatus(c, isPlayer) {
    const mood = !isPlayer && c.mood
      ? `<div class="mood${U.state.turn - c.mood.turn > E.Engine.MOOD_STALE ? ' stale' : ''}" title="${esc(c.mood.reason ? 'Why: ' + c.mood.reason : '')}">${esc(c.mood.text)}</div>`
      : '';
    const derived = E.Engine.derivedTags(U.state, c).map((t) => `<span class="tag derived">${esc(t)}</span>`);
    const story = (c.tags || []).map((t) => {
      const tip = [t.reason, t.until != null ? `until turn ${t.until}` : ''].filter(Boolean).join(' · ');
      return `<span class="tag" title="${esc(tip)}">${esc(t.text)}</span>`;
    });
    const tags = derived.concat(story);
    return mood + (tags.length ? `<div class="tags">${tags.join('')}</div>` : '');
  }

  function cardNeeds(c, dead) {
    // Only the needs this person has (task G-5).
    const has = U.state.scenario.needs.filter((n) => E.Scenario.hasNeed(c, n.id));
    if (dead || !has.length) return '';
    return `<div class="needs">${has.map((n) => {
      const v = c.needs[n.id] || 0;
      return `<span>${esc(n.label || n.id)}</span><div class="bar ${v >= 0.85 ? 'danger' : ''}"><i style="width:${Math.round(v * 100)}%"></i></div>`;
    }).join('')}</div>`;
  }

  // Collapsed details about the person: who they are, needs, and what you know
  // about them (only facts the player knows). Open ones stay open across re-renders.
  const openCards = new Set();
  const KNOWN_SHOWN = 6;
  function cardDetails(id, c, dead) {
    return `<details class="card-details" data-card="${esc(id)}"${openCards.has(id) ? ' open' : ''}><summary>Details</summary>${cardBody(id, c, dead, true)}</details>`;
  }
  // The details themselves; interactive: with the pin, feelings and save
  // controls (the People panel), else to read only (the popup card).
  function cardBody(id, c, dead, interactive) {
    const who = [c.pronouns, c.role, c.age, E.Standing.membership(U.state, c)].filter(Boolean).map(esc).join(' · ');
    const known = E.Engine.knownAbout(U.state, id);
    const knownHtml = known.length
      ? `<ul class="known">${known.slice(0, KNOWN_SHOWN).map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` +
        (known.length > KNOWN_SHOWN ? `<div class="muted small">and ${known.length - KNOWN_SHOWN} more in Debug › Fact store</div>` : '')
      : '<div class="muted small">Nothing yet.</div>';
    return `<div class="small muted">${who}</div>` +
      (c.description ? `<p class="desc">${esc(c.description)}</p>` : '') +
      (c.appearance ? `<p class="desc"><span class="muted">Looks:</span> ${esc(c.appearance)}</p>` : '') +
      (interactive && id !== U.state.player && !dead ? cardPin(id, c) + cardFeelings(id, c) : '') +
      (interactive && id === U.state.player && U.state.scenario.madePlayer === id ? '<button type="button" class="small" data-save-char>Save this character</button>' : '') +
      cardNeeds(c, dead) +
      `<div class="known-head">What you know</div>${knownHtml}`;
  }
  // Pin: they stay in the foreground (full detail every turn) even while unseen.
  function cardPin(id, c) {
    return `<div class="pin-row"><button type="button" class="small" data-pin="${esc(id)}" aria-pressed="${c.pinned ? 'true' : 'false'}">${c.pinned ? 'Unpin' : '📌 Pin'}</button>` +
      `<span class="small muted">${c.pinned ? 'Pinned: the story keeps them in mind even when you haven\'t seen them for a while.' : 'Keep them in mind even when you haven\'t seen them for a while.'}</span></div>`;
  }
  // Your feelings toward them, with −/+ (5 a step) and an optional "why" that
  // replaces the note (task 1-8): for when the model misread your tone.
  function cardFeelings(id, c) {
    const v = U.state.characters[U.state.player].relations[id] || 0;
    const note = (U.state.characters[U.state.player].attitudeNotes || {})[id];
    const nm = esc(c.name);
    return `<div class="feel" data-feel="${esc(id)}"><div class="known-head">Your feelings</div>` +
      `<div class="feel-row"><button type="button" class="small" data-feel-step="-5" aria-label="Feel 5 worse toward ${nm}">−</button>` +
      `<span class="rel-${E.relWord(v)}">${E.relWord(v)} ${v > 0 ? '+' : ''}${v}</span>` +
      `<button type="button" class="small" data-feel-step="5" aria-label="Feel 5 better toward ${nm}">+</button>` +
      `<input type="text" class="feel-why" maxlength="80" placeholder="Why (optional)" aria-label="Why you feel this way about ${nm}"></div>` +
      (note ? `<div class="small muted">${esc(note)}</div>` : '') +
      '<div class="small muted">Fix this when the story misread your tone. Undo also undoes changes made since your last action.</div></div>';
  }
  $('cast').addEventListener('click', (ev) => {
    if (ev.target.closest('button[data-save-char]') && U.state) return void U.download(U.state.player + '.json', E.CharMaker.toFile(U.state.characters[U.state.player]));
    const pin = ev.target.closest('button[data-pin]');
    if (pin && U.state && !U.busy) {
      const id = pin.dataset.pin;
      const out = E.Engine.setPinned(U.state, id, !U.state.characters[id].pinned);
      if (out.error) return void alert(out.error);
      U.notes.push({ kind: 'cast tier', summary: out.note, detail: out.pinned ? 'Pinned people stay local: full detail in every prompt, never moved to the background.' : 'They go back to the usual rules and drop to the background after a few turns unseen.' });
      U.autosave();
      return void U.renderAll();
    }
    const btn = ev.target.closest('button[data-feel-step]');
    if (!btn || !U.state || U.busy) return;
    const box = btn.closest('[data-feel]');
    const id = box.dataset.feel;
    const why = box.querySelector('.feel-why').value;
    const out = E.Engine.correctAttitude(U.state, id, parseInt(btn.dataset.feelStep, 10), why);
    if (out.error) return;
    U.notes.push({ kind: 'feelings', summary: `you corrected your feelings toward ${U.state.characters[id].name}: now ${out.value}`, detail: `Step: ${btn.dataset.feelStep}${why.trim() ? `\nWhy: ${why.trim()}` : ''}\nThe next turn's prompts use the new value.` });
    U.autosave();
    U.renderAll();
  });

  // toggle doesn't bubble, so listen in the capture phase.
  $('cast').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.matches || !d.matches('details.card-details')) return;
    if (d.open) openCards.add(d.dataset.card); else openCards.delete(d.dataset.card);
  }, true);

  function renderJournal() {
    if (!U.state.chapters.length) {
      $('journal').innerHTML = `<div class="muted">Chapter ${U.state.chapter} in progress${U.state.turn ? ` (turn ${E.Memory.turnsInChapter(U.state)}; it closes when its notes fill the memory, or after ${E.settings.chapterLength} turns)` : ''}.</div>`;
      return;
    }
    // The latest chapter is shown in full; earlier ones fold to their title
    // and stay as the player leaves them.
    const latest = U.state.chapters[U.state.chapters.length - 1].n;
    $('journal').innerHTML = U.state.chapters.slice().reverse().map((c) =>
      `<details class="journal-entry" data-journal="${c.n}"${c.n === latest || U.openJournal.has(c.n) ? ' open' : ''}><summary><b>${c.n}. ${esc(c.title)}</b> <span class="turns">turns ${c.fromTurn}–${c.toTurn}</span></summary><div>${esc(c.summary)}</div></details>`
    ).join('');
  }
  $('journal').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.matches || !d.matches('details.journal-entry') || !U.state || !U.state.chapters.length) return;
    const n = Number(d.dataset.journal);
    if (n === U.state.chapters[U.state.chapters.length - 1].n) return;
    if (d.open) U.openJournal.add(n); else U.openJournal.delete(n);
  }, true);
  Object.assign(U, { diskAssets, portraitUrl, siteMapUrl, assetUrl, failedUrls, isMinimized, cardMini, cardHeader, cardStatus, cardDetails, cardBody, renderJournal });
})();
