// Where to start in a big world, and the review of a generated start.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

  // ---------- where to start (R-7) ----------
  // A few places to start (12 or fewer): the plain list, as before. A big
  // world: search by name, a tree, the zooming map, and Surprise me.
  // Only startable regions can be picked; hidden ones never show.
  const GEN_LIST_MAX = 12;
  const regionChainText = (w, id) => S().regionChainIn(w.regions, id).slice(1).map((x) => (w.regions.find((r) => r.id === x) || {}).name).filter(Boolean).join(' › ');
  const S = () => E.Scenario;
  function genWhereHtml(w, regions) {
    const all = (w.regions || []).filter((r) => r && r.id);
    if (regions.length <= GEN_LIST_MAX) {
      return `<fieldset class="mk-choices"><legend>Where</legend>${regions.map((r) => `<label class="mk-option"><input type="radio" name="gen-region" value="${esc(r.id)}"${U.gen.region === r.id ? ' checked' : ''}> <span><b>${esc(r.name)}</b>${r.lore ? ` <span class="muted">${esc(r.lore)}</span>` : ''}</span></label>`).join('')}</fieldset>`;
    }
    const ok = new Set(regions.map((r) => r.id));
    const hidden = new Set(all.filter((r) => S().regionChainIn(all, r.id).some((x) => (all.find((y) => y.id === x) || {}).known === false)).map((r) => r.id));
    const chosen = all.find((r) => r.id === U.gen.region);
    const view = U.gen.whereView || 'tree';
    let html = `<fieldset class="mk-choices gen-where"><legend>Where</legend>
      <div class="gen-chosen" id="genChosen">${chosen ? `Starting in <b>${esc(chosen.name)}</b>${regionChainText(w, chosen.id) ? ` <span class="muted">in ${esc(regionChainText(w, chosen.id))}</span>` : ''}` : 'Pick where to start.'} <button type="button" id="genSurprise" class="small">🎲 Surprise me</button></div>
      <input type="search" id="genSearch" placeholder="Search places by name" aria-label="Search places by name" value="${esc(U.gen.search || '')}">
      <div id="genResults" class="gen-results">${genResultsHtml(w, regions)}</div>
      <div class="gen-views" role="group" aria-label="Browse places"><button type="button" class="small" data-genview="tree" aria-pressed="${view === 'tree'}">List</button><button type="button" class="small" data-genview="map" aria-pressed="${view === 'map'}">Map</button></div>`;
    if (view === 'map') html += genMapHtml(w, ok, hidden);
    else {
      const branch = (parent, depth) => S().regionChildrenIn(all, parent).filter((id) => !hidden.has(id)).map((id) => {
        const r = all.find((x) => x.id === id);
        const kids = S().regionChildrenIn(all, id).filter((x) => !hidden.has(x));
        const row = ok.has(id) ? `<button type="button" class="gen-pick" data-genpick="${esc(id)}" aria-pressed="${U.gen.region === id}">${esc(r.name)}</button>` : `<span class="muted gen-closed" title="Not a place to start">${esc(r.name)}</span>`;
        const open = depth === 0 || (chosen && S().regionChainIn(all, chosen.id).includes(id));
        return kids.length ? `<li><details${open ? ' open' : ''}><summary>${row}</summary><ul>${branch(id, depth + 1)}</ul></details></li>` : `<li>${row}</li>`;
      }).join('');
      html += `<ul class="gen-tree" id="genTree">${branch(null, 0)}</ul>`;
    }
    // Where exactly (R-7): the place the rooms are made as, inside the region picked.
    html += `<label>Where exactly <span class="muted small">(optional; inside the place picked above)</span><input type="text" id="genPlace" maxlength="60" value="${esc(U.gen.place || '')}" placeholder="a moisture farm outside the city"></label>`;
    return html + '</fieldset>';
  }
  function genResultsHtml(w, regions) {
    const q = String(U.gen.search || '').trim().toLowerCase();
    if (!q) return '';
    const hits = regions.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 12);
    return hits.length ? hits.map((r) => `<button type="button" class="gen-pick" data-genpick="${esc(r.id)}" aria-pressed="${U.gen.region === r.id}">${esc(r.name)}${regionChainText(w, r.id) ? ` <span class="muted">in ${esc(regionChainText(w, r.id))}</span>` : ''}</button>`).join('') : '<span class="muted small">No place to start by that name.</span>';
  }
  // The game's zooming map, inside the dialog: click a region with regions
  // inside to zoom, a startable one to pick it.
  function genMapHtml(w, ok, hidden) {
    const sc = { regions: w.regions, map: w.map, worldId: U.gen.world.id };
    const lv = E.MapDraw.level(sc, U.gen.mapLevel || null, { hidden });
    const path = E.MapDraw.levelPath(sc, lv.id);
    const crumbs = path.map((id, i) => `${i ? '<span class="sep" aria-hidden="true">›</span>' : ''}<button type="button" data-genlevel="${esc(id == null ? '' : id)}"${i === path.length - 1 ? ' aria-current="true"' : ''}>${esc(id == null ? U.gen.world.title : (w.regions.find((r) => r.id === id) || {}).name)}</button>`).join('');
    const svg = E.MapDraw.worldSvg({
      g: lv.g, regions: lv.regions, factions: w.factions || [], selected: U.gen.region, dim: lv.dim.concat(lv.regions.map((r) => r.id).filter((id) => !ok.has(id) && !E.MapDraw.hasLevel(sc, id, hidden))),
      zoomable: lv.children.filter((id) => E.MapDraw.hasLevel(sc, id, hidden)), places: [], imageUrl: lv.picture && U.assetUrl(U.gen.world.folder, lv.picture.image),
      viewBox: lv.viewBox, id: 'genMapSvg', view: lv.id == null ? 'root' : lv.id, label: 'Where to start',
    });
    return `<div class="map-bar"><nav class="map-crumbs" aria-label="Map levels">${crumbs}</nav></div><div id="genMap">${svg}</div>`;
  }
  function genPick(id) {
    U.gen.region = id;
    renderGen();
  }

  function renderGen() {
    if (!U.gen) return;
    const w = U.gen.world.bundle.world;
    const saved = !U.gen.job && U.savedJob(U.gen.key);
    let html = '';
    if (!U.gen.job) {
      if (saved) {
        const n = U.GEN.order(saved).filter((id) => saved.steps[id]).length;
        html += `<div class="gen-resume"><b>${U.GEN.done(saved) ? 'You have a finished start you haven\'t played.' : `You have an unfinished start (${n} of ${U.GEN.order(saved).length} steps done).`}</b> <button type="button" id="genResume" class="primary small">${U.GEN.done(saved) ? 'Open it' : 'Resume'}</button> <button type="button" id="genDiscard" class="small ghost">Discard</button></div>`;
      }
      // A world the player describes (customSetting): their words come first.
      if (U.GEN.custom(w)) html += `<label><b>Your world</b> <span class="muted small">where and when, and what it's like; the story keeps to it</span><textarea id="genWorld" maxlength="${U.GEN.SETTING.world}" rows="3" placeholder="a fishing village on a Scottish island in the 1950s, where everyone knows everyone's business">${esc(U.gen.worldText || '')}</textarea></label>`;
      const regions = U.GEN.regions(w);
      if (regions.length) html += genWhereHtml(w, regions);
      const c = U.gen.character;
      html += '<fieldset class="mk-choices"><legend>You</legend>' +
        `<label class="mk-option"><input type="radio" name="gen-mode" value="form"${U.gen.mode === 'form' ? ' checked' : ''}> <span><b>Make a character</b> ${c ? `<span class="muted">${esc(c.name)}, ${esc(c.role)}</span> ` : ''}<button type="button" id="genMake" class="small">${c ? 'Edit' : 'Make one'}</button></span></label>` +
        `<label class="mk-option"><input type="radio" name="gen-mode" value="line"${U.gen.mode === 'line' ? ' checked' : ''}> <span><b>Describe one in a line</b> <input type="text" id="genLine" maxlength="300" value="${esc(U.gen.line)}" placeholder="a trucker who just wants to get to the coast" aria-label="Describe your character in a line"></span></label>` +
        '</fieldset>' +
        `<label>What kind of story (optional)<textarea id="genNote" maxlength="400" rows="2" placeholder="quiet and tense; someone here is lying">${esc(U.gen.note)}</textarea></label>` +
        '<div class="muted small">The story engine writes the place, the people, their ties and an opening, one small step at a time (about 10 calls; several minutes on a local model). You can retry any step.</div>' +
        '<div class="row end"><button type="button" id="genGo" class="primary">Generate</button></div>';
    } else {
      const job = U.gen.job;
      const steps = U.GEN.order(job).map((id) => {
        const label = U.GEN.STEPS.find((s) => s.id === id).label;
        const running = U.gen.running && U.gen.progress && U.gen.progress.step === id;
        const failed = !U.gen.running && job.failed === id;
        const mark = job.steps[id] ? '✓' : running ? '…' : failed ? '✕' : '·';
        const count = running && U.gen.progress.of ? ` ${U.gen.progress.index} of ${U.gen.progress.of}` : id === 'cast' && !job.steps.cast && (job.partial.cast || []).length ? ` (${job.partial.cast.length} done)` : '';
        const redo = !U.gen.running && job.steps[id] && (id !== 'player' || job.line) ? ` <button type="button" class="small ghost" data-gen-redo="${id}" title="Make this again, and everything after it">Redo</button>` : '';
        return `<li class="gen-step ${job.steps[id] ? 'done' : running ? 'running' : failed ? 'failed' : ''}"><span class="gen-mark" aria-hidden="true">${mark}</span> ${esc(label)}${count}${redo}</li>`;
      }).join('');
      const list = `<ol class="gen-steps" aria-live="polite">${steps}</ol>`;
      html += U.GEN.done(job) ? `<details class="gen-steps-done"><summary>All steps done${U.gen.running && U.gen.progress ? ` · ${esc(U.gen.progress.label)}…` : ''}</summary>${list}</details>` : list;
      if (U.gen.error) html += `<div class="fail small">${esc(U.gen.error)}</div><div class="row"><button type="button" id="genRetry" class="primary">Retry this step</button></div>`;
      if (U.GEN.done(job)) html += (U.gen.running && U.gen.progress ? `<div class="small rv-note">${esc(U.gen.progress.label)}…</div>` : '') + reviewHtml();
      html += `<div class="row end gen-foot"><button type="button" id="genOver" class="ghost"${U.gen.running ? ' disabled' : ''}>Start over</button>${U.GEN.done(job) ? '<button type="button" id="genSave" title="Download the start and its people as a zip, ready to unzip over the world folder">Save as start</button><button type="button" id="genPlay" class="primary">Play</button>' : ''}</div>`;
    }
    $('genBody').innerHTML = html;
    renderProblems();
  }

  async function runGen(fromStep) {
    if (!U.gen || U.gen.running) return;
    const g = U.gen;
    if (fromStep) U.GEN.clearFrom(g.job, fromStep);
    g.running = true;
    g.error = '';
    renderGen();
    try {
      await U.GEN.run(g.world, g.job, { save: U.saveJob, onProgress: (p) => { g.progress = p; if (U.gen === g) renderGen(); } });
    } catch (e) {
      g.error = e.message;
    }
    g.running = false;
    g.progress = null;
    if (U.gen === g) renderGen();
  }

  $('genBody').addEventListener('change', (ev) => {
    if (!U.gen) return;
    const t = ev.target;
    if (t.id === 'rvSpoil') { U.gen.spoilers = t.checked; renderGen(); return; }
    // The map follows room edits once a field is left.
    if (t.dataset.rv && $('rvMap')) { $('rvMap').innerHTML = previewMapHtml(); return; }
    if (t.name === 'gen-region') U.gen.region = t.value;
    if (t.name === 'gen-mode') U.gen.mode = t.value;
  });
  $('genBody').addEventListener('input', (ev) => {
    if (!U.gen) return;
    // A review field: checked and stored now; the problems list follows.
    if (ev.target.dataset.rv) {
      const [kind, id, name] = ev.target.dataset.rv.split('|');
      const out = U.GEN.setField(U.gen.world, U.gen.job, kind, id || null, name, ev.target.value);
      U.gen.fieldErrors = U.gen.fieldErrors || {};
      U.gen.fieldErrors[ev.target.dataset.rv] = out.error || '';
      ev.target.parentElement.querySelector('.rv-err').textContent = out.error || '';
      if (!out.error) U.saveJob(U.gen.job);
      renderProblems();
      return;
    }
    if (ev.target.id === 'genLine') { U.gen.line = ev.target.value; U.gen.mode = 'line'; ev.target.closest('.mk-option').querySelector('input[type=radio]').checked = true; }
    if (ev.target.id === 'genNote') U.gen.note = ev.target.value;
    if (ev.target.id === 'genWorld') U.gen.worldText = ev.target.value;
    if (ev.target.id === 'genPlace') U.gen.place = ev.target.value;
    // Search fills in the results without redrawing the box (keeps focus).
    if (ev.target.id === 'genSearch') { U.gen.search = ev.target.value; $('genResults').innerHTML = genResultsHtml(U.gen.world.bundle.world, U.GEN.regions(U.gen.world.bundle.world)); }
  });
  $('genBody').addEventListener('click', (ev) => {
    if (!U.gen) return;
    // The map in the picker (R-7): zoom into a region with regions inside, pick a startable one.
    const reg = ev.target.closest && ev.target.closest('#genMap .region-g');
    if (reg) {
      if (reg.dataset.zoomable) { U.gen.mapLevel = reg.dataset.region; return renderGen(); }
      if (U.GEN.regions(U.gen.world.bundle.world).some((r) => r.id === reg.dataset.region)) return genPick(reg.dataset.region);
      return;
    }
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.genpick) return genPick(b.dataset.genpick);
    if (b.dataset.genview) { U.gen.whereView = b.dataset.genview; return renderGen(); }
    if (b.dataset.genlevel != null) { U.gen.mapLevel = b.dataset.genlevel || null; return renderGen(); }
    if (b.id === 'genSurprise') return genPick(U.GEN.surprise(U.gen.world.bundle.world));
    if (b.id === 'genMake') {
      U.gen.mode = 'form';
      const g = U.gen;
      U.openCharacterForm({
        // In a world the player describes, Suggest ideas fit what they wrote so far.
        sc: Object.assign(U.GEN.slotScenario(g.world, g.region), U.GEN.custom(g.world.bundle.world) && (g.worldText || '').trim() ? { setting: g.worldText.trim() } : {}), key: `${g.key}/generated`, title: `Make your character: ${g.world.title}`, done: 'Use this character',
        onDone: (c) => { g.character = c; $('makerDialog').close(); renderGen(); return null; },
      });
    } else if (b.id === 'genGo') {
      try {
        U.gen.job = U.GEN.newJob(U.gen.world, { region: U.gen.region, note: U.gen.note, character: U.gen.mode === 'form' ? U.gen.character : null, line: U.gen.mode === 'line' ? U.gen.line : '', place: U.gen.place || '', world: U.gen.worldText || '' });
      } catch (e) {
        U.gen.error = '';
        alert(e.message);
        return;
      }
      U.saveJob(U.gen.job);
      runGen();
    } else if (b.id === 'genResume') {
      U.gen.job = U.savedJob(U.gen.key);
      renderGen();
      if (!U.GEN.done(U.gen.job)) runGen();
    } else if (b.id === 'genDiscard') {
      U.dropJob();
      renderGen();
    } else if (b.id === 'genRetry') runGen();
    else if (b.dataset.genRedo) runGen(b.dataset.genRedo);
    else if (b.id === 'genOver') {
      U.dropJob();
      U.gen.job = null;
      U.gen.error = '';
      renderGen();
    } else if (b.dataset.rvPerson) {
      const c = U.GEN.target(U.gen.job, 'person', b.dataset.rvPerson);
      rerollRun(`Rerolling ${c.name}`, () => U.GEN.rerollPerson(U.gen.world, U.gen.job, c.id));
    } else if (b.dataset.rvRoom) {
      const r = U.GEN.target(U.gen.job, 'room', b.dataset.rvRoom);
      rerollRun(`Rerolling ${r.name}`, () => U.GEN.rerollRoom(U.gen.world, U.gen.job, r.id));
    } else if (b.dataset.rvRedo) {
      const label = { opening: 'the opening', ties: 'the pressures', extras: 'the minor people', lore: 'the local lore' }[b.dataset.rvRedo];
      rerollRun(`Rerolling ${label}`, () => U.GEN.redoOnly(U.gen.world, U.gen.job, b.dataset.rvRedo));
    } else if (b.dataset.rvLoreDel) {
      U.GEN.removeLore(U.gen.job, b.dataset.rvLoreDel);
      U.saveJob(U.gen.job);
      renderGen();
    } else if (b.id === 'genSave') {
      if (!U.GEN.reviewProblems(U.gen.world, U.gen.job).length) saveStart();
    } else if (b.id === 'genPlay') {
      if (U.GEN.reviewProblems(U.gen.world, U.gen.job).length) return;
      let scenario;
      try { scenario = U.GEN.scenario(U.gen.world, U.gen.job); } catch (e) { U.gen.error = e.message; renderGen(); return; }
      const world = U.gen.world;
      U.dropJob();
      U.gen = null;
      $('genDialog').close();
      U.beginGame(world, scenario);
      U.renderAll();
      $('actionInput').focus();
    }
  });
  // ---------- review (task 4-3) ----------
  // A finished start, before playing: every field editable and checked as
  // it's typed (E.StartGen.setField), one room, one person, the pressures,
  // the minor people or the opening rerollable, secrets behind a spoiler
  // toggle, and Save as start. Play and Save wait until reviewProblems is empty.
  function reviewHtml() {
    const job = U.gen.job;
    const s = job.steps;
    const off = U.gen.running ? ' disabled' : '';
    const errs = U.gen.fieldErrors || {};
    const field = (kind, id, name, value, o = {}) => {
      const key = `${kind}|${id || ''}|${name}`;
      const v = esc(value == null ? '' : String(value));
      const input = o.options ? `<select data-rv="${esc(key)}">${o.options.map((x) => `<option${x === value ? ' selected' : ''}>${x}</option>`).join('')}</select>`
        : o.rows ? `<textarea data-rv="${esc(key)}" rows="${o.rows}">${v}</textarea>`
          : `<input type="${o.type || 'text'}" data-rv="${esc(key)}" value="${v}"${o.step ? ` step="${o.step}"` : ''}>`;
      return `<label class="rv-field${o.cls ? ' ' + o.cls : ''}">${esc(o.label)}${input}<span class="fail small rv-err">${esc(errs[key] || '')}</span></label>`;
    };
    const reroll = (attr, label, title) => `<button type="button" class="small" ${attr}${off} title="${esc(title)}">↻ ${esc(label)}</button>`;
    const clockFields = (c) => field('clock', c.id, 'name', c.name, { label: 'Name' }) +
      `<div class="rv-row">${field('clock', c.id, 'max', c.max, { label: 'Steps until it comes to a head', type: 'number' })}${field('clock', c.id, 'perHour', c.perHour, { label: 'Steps per hour', type: 'number', step: '0.01' })}</div>` +
      field('clock', c.id, 'fireText', c.fireText, { label: 'What happens then', rows: 2 });
    const roomName = (id) => (s.rooms.rooms.find((r) => r.id === id) || {}).name || id;
    const o = s.opening;
    const hidden = '<div class="muted small">Hidden. Turn on spoilers to see or edit it.</div>';
    let html = `<label class="web-toggle rv-spoil"><input type="checkbox" id="rvSpoil"${U.gen.spoilers ? ' checked' : ''}> Show spoilers (secrets, private facts, notes for the story engine)</label>`;
    // The world the player described (customSetting): what the story keeps to.
    if (s.setting) {
      html += '<section class="rv-section"><div class="rv-head"><h4>Your world</h4></div>' +
        `<div class="muted small">You asked for: ${esc(job.worldText)}</div>` +
        field('setting', '', 'setting', s.setting.setting, { label: 'Setting (the story keeps to this)', rows: 4 }) +
        `<div class="rv-row">${field('setting', '', 'tags', (s.setting.tags || []).join(', '), { label: 'Genre tags (separated by commas)', cls: 'rv-grow' })}</div>` +
        field('setting', '', 'toneNote', s.setting.toneNote, { label: 'Tone' }) + '</section>';
    }
    html += `<section class="rv-section"><div class="rv-head"><h4>Opening</h4>${reroll('data-rv-redo="opening"', 'Reroll', 'Write the opening again; everything else stays')}</div>` +
      field('opening', '', 'title', o.title, { label: 'Title' }) +
      field('opening', '', 'summary', o.summary, { label: 'Summary (shown in the picker)', rows: 2 }) +
      field('opening', '', 'opening', o.opening, { label: 'Opening scene', rows: 8 }) +
      field('opening', '', 'facts', (o.facts || []).join('\n'), { label: 'Facts everyone knows (one per line)', rows: 3 }) + '</section>';
    html += '<section class="rv-section"><div class="rv-head"><h4>Places</h4></div>' +
      `<div id="rvMap" class="rv-map">${previewMapHtml()}</div>` +
      // One of the world's own places (task 7-4): shown, not edited here.
      (s.rooms.place ? `<div class="muted small">You start in ${esc(roomName(s.rooms.playerRoom))}, in one of the world's own places: ${esc(s.rooms.rooms.map((r) => r.name).join(', '))}.</div>` : s.rooms.rooms.map((r) => `<div class="rv-card"><div class="rv-head"><b>${esc(r.name)}</b>${r.id === s.rooms.playerRoom ? ' <span class="tag">you start here</span>' : ''}${reroll(`data-rv-room="${esc(r.id)}"`, 'Reroll', 'A new name and description; it stays where it is')}</div>` +
        field('room', r.id, 'name', r.name, { label: 'Name' }) + field('room', r.id, 'desc', r.desc, { label: 'Description', rows: 2 }) +
        `<div class="muted small">Connects to ${esc(r.connects.map(roomName).join(', ') || 'nothing')}</div></div>`).join('')) + '</section>';
    const withYou = new Set(o.withYou || []);
    const person = (c, you) => {
      const where = you || withYou.has(c.id) ? s.rooms.playerRoom : c.status.location;
      const secret = you || U.gen.spoilers
        ? `<div class="rv-row">${field('person', c.id, 'secret', c.secret, { label: you ? 'Your secret (optional)' : 'Secret', rows: 2, cls: 'rv-grow' })}${c.secret ? field('person', c.id, 'guard', c.guard || 'medium', { label: 'Guard', options: ['low', 'medium', 'high'] }) : ''}</div>` +
          (!you && (c.knows || []).length ? `<div class="known-head">Knows</div><ul class="known">${c.knows.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : '')
        : hidden;
      return `<div class="rv-card"><div class="rv-head"><b>${esc(c.name)}</b> <span class="muted small">${you ? 'you · ' : ''}starts in ${esc(roomName(where))}</span>${you ? '' : reroll(`data-rv-person="${esc(c.id)}"`, 'Reroll', 'A new sheet for the same name and role; the others stay')}</div>` +
        `<div class="rv-row">${field('person', c.id, 'name', c.name, { label: 'Name', cls: 'rv-grow' })}${field('person', c.id, 'pronouns', c.pronouns, { label: 'Pronouns' })}${field('person', c.id, 'age', c.age, { label: 'Age', type: 'number', cls: 'rv-age' })}</div>` +
        field('person', c.id, 'role', c.role, { label: 'Role' }) +
        field('person', c.id, 'traits', (c.traits || []).join(', '), { label: 'Traits (separated by commas)' }) +
        field('person', c.id, 'want', c.want, { label: 'Wants' }) +
        field('person', c.id, 'voice', c.voice, { label: 'Voice' }) +
        field('person', c.id, 'appearance', c.appearance, { label: 'Appearance', rows: 2 }) +
        field('person', c.id, 'description', c.description, { label: 'Who they are', rows: 2 }) + secret + '</div>';
    };
    html += `<section class="rv-section"><div class="rv-head"><h4>People</h4></div>${person(s.player.character, true)}${s.cast.people.map((c) => person(c, false)).join('')}</section>`;
    html += `<section class="rv-section"><div class="rv-head"><h4>Pressures</h4>${reroll('data-rv-redo="ties"', 'Reroll', 'New pressures, feelings and private facts; the people stay')}</div>` +
      s.ties.clocks.map((c) => `<div class="rv-card">${clockFields(c)}` +
        (c.then || []).map((t) => `<div class="rv-then"><div class="small muted">Then, once that happens:</div>${clockFields(t)}</div>`).join('') + '</div>').join('') +
      ((s.ties.events || []).length ? `<div class="small muted">Ideas for later events here:</div><ul class="rv-list">${s.ties.events.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '') + '</section>';
    const ex = s.extras;
    html += `<section class="rv-section"><div class="rv-head"><h4>Minor people and groups</h4>${reroll('data-rv-redo="extras"', 'Reroll', 'New minor people and groups')}</div>` +
      (ex.extras.length || ex.standees.length ? `<ul class="rv-list">${ex.extras.map((x) => `<li><b>${esc(x.name)}</b>, ${esc(x.role)}${x.location ? `, in ${esc(roomName(x.location))}` : ''}${U.gen.spoilers && x.note ? ` <span class="muted">${esc(x.note)}</span>` : ''}</li>`).join('')}` +
        `${ex.standees.map((g) => `<li><b>${g.count} ${esc(g.label)}</b>, ${esc(g.state)}, in ${esc(roomName(g.location))}${U.gen.spoilers && g.note ? ` <span class="muted">${esc(g.note)}</span>` : ''}</li>`).join('')}</ul>` : '<div class="muted small">None.</div>') + '</section>';
    // Local lore (task 5-6): public notes the story keeps to; editable, and
    // one can be taken out. A step that failed leaves a note, not a blocked start.
    const lore = s.lore || { entries: [] };
    const regionName = (id) => ((U.gen.world.bundle.world.regions || []).find((r) => r.id === id) || {}).name || id;
    html += `<section class="rv-section"><div class="rv-head"><h4>Local lore</h4>${reroll('data-rv-redo="lore"', 'Reroll', 'New notes on this place; everything else stays')}</div>` +
      (lore.dropped ? `<div class="muted small">No local lore this time (${esc(lore.dropped)}). The start plays without it; Reroll to try again.</div>` : '') +
      lore.entries.map((e) => `<div class="rv-card"><div class="rv-head"><b>${esc(e.title)}</b> <span class="muted small">about ${esc(e.level === 'region' ? regionName(e.ref) : roomName(e.ref))}${(e.topics || []).length ? ` · ${esc(e.topics.join(', '))}` : ''}</span><button type="button" class="small ghost" data-rv-lore-del="${esc(e.id)}"${off} aria-label="Remove ${esc(e.title)}">✕</button></div>` +
        field('lore', e.id, 'title', e.title, { label: 'Title' }) + field('lore', e.id, 'text', e.text, { label: 'Text (public: the story engine sees it)', rows: 3 }) +
        field('lore', e.id, 'keywords', (e.keywords || []).join(', '), { label: 'Keywords (separated by commas)' }) + '</div>').join('') +
      (!lore.entries.length && !lore.dropped ? '<div class="muted small">None.</div>' : '') + '</section>';
    if (U.gen.rvNote) html += `<div class="small rv-note">${esc(U.gen.rvNote)}</div>`;
    html += '<ul id="rvProblems" class="maker-errors fail" aria-live="polite"></ul>';
    return html;
  }
  // The start's local map, drawn by the game's own map code against a
  // throwaway game of this start (localMapHtml reads the page's state, so it
  // is swapped for the call and put back).
  function previewMapHtml() {
    let preview;
    try { preview = E.Engine.newGame(U.GEN.scenario(U.gen.world, U.gen.job)); } catch (e) { return '<div class="muted small">Fix the problems below to see the map.</div>'; }
    const saved = U.state;
    U.state = preview;
    try { return U.localMapHtml().replace(' id="mapList"', ''); } finally { U.state = saved; }
  }
  function renderProblems() {
    if (!U.gen || !U.gen.job || !U.GEN.done(U.gen.job) || !$('rvProblems')) return;
    const problems = U.GEN.reviewProblems(U.gen.world, U.gen.job);
    $('rvProblems').innerHTML = problems.map((p) => `<li>${esc(p)}</li>`).join('');
    ['genPlay', 'genSave'].forEach((id) => { if ($(id)) $(id).disabled = U.gen.running || problems.length > 0; });
  }
  async function rerollRun(label, fn) {
    if (!U.gen || U.gen.running) return;
    const g = U.gen;
    g.running = true;
    g.rvNote = '';
    g.progress = { label };
    renderGen();
    try {
      const out = await fn();
      g.rvNote = (out && out.note) || '';
    } catch (e) {
      g.rvNote = e.message;
    }
    g.running = false;
    g.progress = null;
    U.saveJob(g.job);
    if (U.gen === g) renderGen();
  }
  function saveStart() {
    const files = U.GEN.files(U.gen.world, U.gen.job);
    const folder = U.gen.world.folder;
    const entries = Object.entries(files).map(([p, obj]) => ({ name: `${folder}/${p}`, data: E.Zip.utf8(JSON.stringify(obj, null, 2) + '\n') }));
    U.download(`${folder}-${U.gen.job.id}.zip`, new Blob([E.Zip.build(entries)], { type: 'application/zip' }));
  }
  $('genForm').addEventListener('submit', (ev) => ev.preventDefault());
  $('genClose').addEventListener('click', () => $('genDialog').close());
  Object.assign(U, { renderGen });
})();
