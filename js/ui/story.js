// Saving, the recorder, acting, undo and reroll, suggestions, the story log and names in it.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

  // File names: world and start titles, e.g. "ares-deep-sol-214-the-mule".
  function gameSlug(sc) {
    const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return [sc.worldTitle || sc.title, sc.startTitle].map(slug).filter(Boolean).join('-') || slug(sc.folder || sc.id) || 'game';
  }

  // A test-play tab (task 6-1) never overwrites the player's own game.
  function autosave() {
    if (!U.state || U.TEST_PLAY) return;
    if (!U.saveId) U.saveId = E.Saves.newId();
    E.Saves.save(U.saveId, U.state);
  }

  // obj: a Blob as it is, or anything else as JSON.
  function download(name, obj) {
    const blob = obj instanceof Blob ? obj : new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  $('btnSave').addEventListener('click', () => {
    if (!U.state) return;
    // The undo snapshot is a second copy of the game; save files leave it out.
    download(`ensemble-${gameSlug(U.state.scenario)}-turn${U.state.turn}.json`, Object.assign({}, U.state, { undo: undefined }));
  });

  // ---------- recorder (Debug) ----------
  function renderRecorder() {
    const on = E.Recorder.active();
    const f = E.Recorder.fixture();
    const n = E.Recorder.count();
    $('btnRecord').textContent = on ? `■ Stop recording (${n})` : '● Record';
    $('btnRecord').classList.toggle('recording', on);
    $('btnExportRec').disabled = !f;
    $('btnExportRec').textContent = f ? `Export recording (${n} action${n === 1 ? '' : 's'})` : 'Export recording';
  }
  // A new game or a loaded save ends the recording; it can still be exported.
  function stopRecording() { if (E.Recorder.active()) E.Recorder.stop(); renderRecorder(); }

  $('btnRecord').addEventListener('click', () => {
    if (U.busy) return;
    if (E.Recorder.active()) E.Recorder.stop();
    else if (!U.state) { alert('Start or load a game first, then record.'); return; }
    else E.Recorder.start(U.state);
    renderRecorder();
  });
  $('btnExportRec').addEventListener('click', () => {
    const f = E.Recorder.fixture();
    if (!f) return;
    const sc = f.start.scenario || {};
    download(`ensemble-recording-${gameSlug(sc)}-${f.recorded.slice(0, 16).replace(/[:T]/g, '-')}.json`, f);
  });

  $('loadInput').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s.scenario || !s.characters || !s.player) throw new Error('That file is not an Ensemble save.');
      stopRecording();
      U.state = E.Engine.migrate(s);
      U.saveId = null;
      U.restoreView();
      U.showPickInfo(false);
      U.openTurns.clear();
      U.uiCut = null;
      U.uiShown = 1;
      autosave();
      renderAll();
    } catch (e) {
      alert('Could not load: ' + e.message);
    }
  });

  // ---------- acting ----------
  async function act() {
    if (U.busy || !U.state || !canAct()) return;
    const skip = $('timeStep').value === 'major';
    const text = $('actionInput').value.trim();
    if (!text && !skip) return;
    setBusy(true);
    try {
      const result = await E.Engine.runTurn(U.state, text, $('timeStep').value, setPhase, U.uiCut);
      U.uiCut = null;
      U.uiShown = 1;
      U.openTurns.clear();
      if ($('timeStep').value === 'major') $('timeStep').value = 'hour';
      // A judged ending plays its closing instead of the action, which goes back in the box.
      $('actionInput').value = result.held || '';
      autosave();
      renderAll();
      announceBeat(0);
      $('actionInput').placeholder = actionPlaceholder();
      if (result.report && result.report.warning) showWarning(result.report.warning);
    } catch (e) {
      setPhase('');
      showWarning(e.message);
    } finally {
      setBusy(false);
      U.renderDebug();
    }
  }
  $('actionForm').addEventListener('submit', (ev) => { ev.preventDefault(); act(); });
  // Going on past an ending (not after death).
  $('log').addEventListener('click', (ev) => {
    if (ev.target.id !== 'btnKeepPlaying' || U.busy || !U.state) return;
    if (E.Engine.keepPlaying(U.state)) { autosave(); renderAll(); $('actionInput').focus(); }
  });
  $('actionInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); act(); }
  });

  // ---------- undo and reroll ----------
  $('btnUndo').addEventListener('click', () => {
    if (U.busy || !E.Engine.canUndo(U.state)) return;
    const info = E.Engine.undo(U.state);
    $('actionInput').value = info.action || '';
    if (E.timeSteps.some((s) => s.id === info.stepId)) $('timeStep').value = info.stepId;
    // Back on the previous scene, as far as it had been read, with the step-in point re-selected.
    const live = liveScene();
    U.uiCut = live && info.cutAt && info.cutAt < live.beats.length ? info.cutAt : null;
    U.uiShown = live ? U.uiCut || live.beats.length : 1;
    const removed = info.chaptersRemoved.length ? ` Removed chapter ${info.chaptersRemoved.join(', ')}.` : '';
    U.notes.push({ kind: 'undo', summary: `turn ${info.turn} undone, back to ${info.to}.${removed}`, detail: `Action: ${info.action || '(downtime)'}\nTime step: ${info.stepId}${info.cutAt ? `\nIt had stepped in after beat ${info.cutAt}; that beat choice is restored.` : ''}` });
    autosave();
    renderAll();
    $('actionInput').placeholder = actionPlaceholder();
    showNote(`Turn ${info.turn} undone; your action is back in the box.${removed} Only one turn can be undone.`);
    $('actionInput').focus();
  });

  $('btnReroll').addEventListener('click', async () => {
    if (U.busy || !E.Engine.canReroll(U.state)) return;
    setBusy(true);
    try {
      const out = await E.Engine.rerollNarration(U.state, setPhase);
      U.uiCut = null;
      U.uiShown = 1;
      U.notes.push({ kind: 'reroll', summary: `turn ${out.turn} rewritten (same rolls, moves and events)`, detail: `Old scene:\n${out.oldText}\n\nNew scene:\n${out.prose}` });
      autosave();
      renderAll();
      announceBeat(0);
    } catch (e) {
      setPhase('');
      showWarning(e.message);
    } finally {
      setBusy(false);
      U.renderDebug();
    }
  });

  // Acting is only possible at the end of the scene, or after choosing
  // "Step in here"; acting never steps in by accident.
  function canAct() {
    const live = liveScene();
    return !live || U.uiShown >= live.beats.length || U.uiCut != null;
  }

  function renderControls() {
    const blocked = !!U.state && !canAct();
    $('btnAct').disabled = U.busy || blocked;
    $('btnAct').title = blocked ? 'Read to the end of the scene (Next ▸), or press "Step in here" to act now' : '';
    $('actionInput').placeholder = actionPlaceholder();
    $('btnUndo').disabled = U.busy || !E.Engine.canUndo(U.state);
    $('btnReroll').disabled = U.busy || !E.Engine.canReroll(U.state);
    $('btnSuggest').disabled = U.busy || !U.state || blocked || U.state.flags.gameOver;
    // An unfinished trip (R-10): the rest of it as one journey.
    const trip = U.state && !U.state.flags.gameOver && U.state.travel;
    $('btnTravel').classList.toggle('hidden', !trip);
    $('btnTravel').disabled = U.busy || blocked || !trip;
    if (trip) $('btnTravel').title = `Go on to ${trip.destName} until you arrive, or something major happens`;
    renderSuggestions();
  }

  // ---------- suggested actions ----------
  // A few ideas from the model; clicking one fills the action box (the player
  // still presses Act). They belong to the moment they were asked for: a new
  // turn, step-in point or game hides them.
  const suggestKey = () => `${U.state.turn}:${U.uiCut || ''}`;
  function renderSuggestions() {
    const el = $('suggestions');
    const list = U.suggested && U.suggested.state === U.state && U.suggested.key === suggestKey() ? U.suggested.list : [];
    el.innerHTML = list.map((t, i) => `<button type="button" class="suggestion" data-suggest="${i}">${esc(t)}</button>`).join('');
    el.classList.toggle('hidden', !list.length);
  }
  $('btnTravel').addEventListener('click', () => {
    if (!U.state || !U.state.travel) return;
    $('timeStep').value = 'major';
    $('actionInput').value = `Keep going to ${U.state.travel.destName}.`;
    $('btnAct').click();
  });
  $('btnSuggest').addEventListener('click', async () => {
    if (U.busy || !U.state || !canAct()) return;
    const live = liveScene();
    // Only what the player has read: up to the step-in point if one is chosen.
    const sceneText = live && U.uiCut ? live.beats.slice(0, U.uiCut).map((b) => b.text).join('\n\n') + `\n\n[${U.state.characters[U.state.player].name} steps in here.]` : undefined;
    setBusy(true);
    setPhase('Thinking of ideas…');
    try {
      U.suggested = { state: U.state, key: suggestKey(), list: await E.Engine.suggestActions(U.state, sceneText) };
      announce(`${U.suggested.list.length} suggestions.`);
    } catch (e) {
      showWarning(e.message);
    } finally {
      setPhase('');
      setBusy(false);
      U.renderDebug();
    }
  });
  $('suggestions').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-suggest]');
    if (!btn || U.busy) return;
    $('actionInput').value = btn.textContent;
    $('actionInput').focus();
  });

  function setBusy(b) {
    U.busy = b;
    $('btnNew').disabled = b;
    $('actionInput').disabled = b;
    renderControls();
  }
  function setPhase(text) {
    const el = $('phase');
    el.textContent = text;
    el.classList.toggle('busy', !!text);
  }
  // ---------- screen readers ----------
  // The log is redrawn as a whole, so it can't be a live region itself; instead
  // each newly shown beat (and every note) is read out from #srAnnounce.
  function announce(text) {
    const el = $('srAnnounce');
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 30);
  }
  // The newest scene's beat n (0-based), with what to do next.
  function announceBeat(n) {
    const e = U.state && [...U.state.log].reverse().find((x) => x.type === 'scene');
    if (!e) return;
    const beats = e.beats && e.beats.length ? e.beats : [{ text: e.text }];
    const b = beats[Math.min(n, beats.length - 1)];
    const more = n < beats.length - 1 && liveScene();
    announce(`${b.text}${more ? ' (Next for more, or Step in here.)' : ' (Your turn.)'}`);
  }

  function showWarning(msg) { showNote('⚠ ' + msg, 'warn'); }
  function showNote(msg, cls) {
    announce(msg);
    const div = document.createElement('div');
    div.className = 'entry ' + (cls || 'note');
    div.textContent = msg;
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
  }

  // ---------- rendering ----------
  function renderAll() {
    renderControls();
    renderLog();
    renderSceneBar();
    renderSituation();
    renderNews();
    U.renderCast();
    U.renderMap();
    U.renderJournal();
    U.renderDebug();
  }

  function nm(id) { return U.state.characters[id] ? U.state.characters[id].name : id; }

  // Earlier turns fold into a closed "Turn N" row; only the latest turn is
  // shown in full. Rows the player opens stay open until the next turn starts.
  function renderLog() {
    const log = $('log');
    if (!U.state) return;
    const groups = [];
    U.state.log.forEach((e) => {
      const last = groups[groups.length - 1];
      if (e.type === 'chapter') groups.push({ chapter: e });
      else if (last && !last.chapter && last.turn === e.turn) last.entries.push(e);
      else groups.push({ turn: e.turn, entries: [e] });
    });
    const turnHtml = (g) => {
      const body = g.entries.map(renderEntry).join('');
      if (g.turn === U.state.turn) return `<div class="turn-current" data-turn="${g.turn}">${body}</div>`;
      return `<details class="turn-group" data-turn="${g.turn}"${U.openTurns.has(g.turn) ? ' open' : ''}><summary>${turnSummary(g)}</summary>${body}</details>`;
    };
    // A closed chapter folds its turns under one row: its title, its turns
    // and its summary, opened on demand (and kept open until reloaded).
    const out = [];
    let since = [];
    groups.forEach((g) => {
      if (!g.chapter) return since.push(g);
      const c = g.chapter.chapter;
      out.push(`<details class="chapter-group" data-chapter="${c.n}"${U.openChapters.has(c.n) ? ' open' : ''}><summary><span class="chapter-n">Chapter ${c.n}</span><b>${esc(c.title)}</b><span class="when">turns ${c.fromTurn}–${c.toTurn}</span></summary>` +
        `<div class="chapter-summary">${esc(c.summary)}</div>${since.map(turnHtml).join('')}</details>`);
      since = [];
    });
    const html = out.concat(since.map(turnHtml)).join('');
    log.innerHTML = html || '<div class="empty">Write your first action below.</div>';
    if (U.state.flags.gameOver) log.insertAdjacentHTML('beforeend', '<div class="entry chapter"><b>Your story ends here.</b>Load a save or start a new game.</div>');
    // An ending (not death): the player may go on past it, once the scene is read.
    else if (E.Engine.ended(U.state) && canAct()) log.insertAdjacentHTML('beforeend', '<div class="entry chapter end-card"><b>The story has reached an ending.</b>Keep playing to see what comes after, or start a new game. <button type="button" id="btnKeepPlaying" class="primary small">Keep playing</button></div>');
    // Land at the start of the latest turn, or at the bottom if it's short.
    const cur = log.querySelector('.turn-current');
    log.scrollTop = cur ? Math.min(offsetIn(log, cur) - 8, log.scrollHeight) : log.scrollHeight;
  }

  // An element's position inside the scrolling story panel.
  const offsetIn = (log, el) => el.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;

  function turnSummary(g) {
    const action = g.entries.find((e) => e.type === 'action');
    const scene = g.entries.find((e) => e.type === 'scene');
    const label = g.turn === 0 ? 'Opening' : `Turn ${g.turn}`;
    const what = action ? `${action.skip ? '⏭ ' : ''}${E.shorten(action.text, 90)}` : '';
    const when = action ? action.time : '';
    return `<span class="turn-n">${label}</span>${esc(what)}<span class="when">${esc(when || '')}${scene && scene.cutAt ? ' · stepped in' : ''}</span>`;
  }

  function renderEntry(e) {
    if (e.type === 'scene') return renderScene(e);
    if (e.type === 'action') return `<div class="entry action">${e.skip ? '⏭ ' : ''}${esc(e.text)}<span class="when">${esc(e.time || '')}${e.until ? ' → ' + esc(e.until) : ''}</span></div>`;
    if (e.type === 'chapter') return `<div class="entry chapter">Chapter ${e.chapter.n} ends<b>${esc(e.chapter.title)}</b></div>`;
    // An ending: its closing scene (a judged one) and the title, once the scene before it is read.
    if (e.type === 'ending') {
      const live = liveScene();
      if (live && live.turn === e.turn && !canAct()) return '';
      const word = { win: 'A win', loss: 'A loss', bittersweet: 'Bittersweet', neutral: 'An ending' }[e.kind] || 'An ending';
      return (e.text ? `<div class="entry scene ending">${String(e.text).split(/\n\s*\n/).map((p) => `<p>${storyHtml(p.trim())}</p>`).join('')}</div>` : '') +
        `<div class="entry chapter ending-title">${word}<b>The end: ${esc(e.title)}</b></div>`;
    }
    if (e.type === 'note') return `<div class="entry note muted small">${esc(e.text)}</div>`;
    if (e.type === 'resolve') {
      const items = e.outcomes.map((o) => {
        const hidden = !o.visible && o.id !== U.state.player;
        // Covert actions stay secret from the player; the Debug panel shows the truth.
        if (hidden) return `<li class="hid">🔒 <b>${esc(nm(o.id))}</b>: something you didn't see</li>`;
        const res = o.roll
          ? ` — <span class="${/success/.test(o.roll.result) ? 'ok' : 'fail'}">${o.roll.result}</span> <span class="muted">(${esc(o.skill)}: d20 ${o.roll.d} → ${o.roll.total} vs ${o.roll.dc})</span>`
          : '';
        const extra = (o.reveals ? `<br><span class="ok">reveals:</span> ${esc(o.reveals)}` : '') +
          (o.missing ? ' <span class="muted">(model gave no intent)</span>' : '') +
          (o.id === U.state.player && o.note ? ` <span class="muted">(${esc(o.note)})</span>` : '');
        return `<li><b>${esc(nm(o.id))}</b>: ${esc(o.action)}${res}${extra}</li>`;
      }).concat(e.events.map((t) => {
        const heard = /^\(heard from elsewhere[^)]*\)\s*/.test(t);
        let body = t.replace(/^\(heard from elsewhere[^)]*\)\s*/, '');
        const tier = (body.match(/^\[(regional|world)\]\s*/) || [])[1];
        body = body.replace(/^\[(regional|world)\]\s*/, '');
        const icon = tier === 'world' ? '🌍' : tier === 'regional' ? '🗺️' : heard ? '🔊' : '⚡';
        return `<li class="${heard && !tier ? 'muted' : 'fail'}">${icon} ${esc(body)}</li>`;
      }));
      return `<details class="entry rolls"><summary>What everyone tried (turn ${e.turn})</summary><ul>${items.join('')}</ul></details>`;
    }
    return '';
  }

  // Which folded turns the player has opened; cleared when a new turn starts.
  // Opened chapters stay open.
  $('log').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.classList && d.classList.contains('chapter-group')) {
      const n = Number(d.dataset.chapter);
      if (d.open) U.openChapters.add(n); else U.openChapters.delete(n);
      return;
    }
    if (!d.classList || !d.classList.contains('turn-group')) return;
    const n = Number(d.dataset.turn);
    if (d.open) U.openTurns.add(n); else U.openTurns.delete(n);
  }, true);

  // A beat's game date and time, like a log line: "Sol 214, 07:30".
  // With sameDayAs (another beat), the date is left out when it matches.
  function beatClock(e, b, sameDayAs) {
    const at = (x) => {
      const total = (e.startMinutes || 0) + x.at;
      const m = total % 1440;
      return { day: (e.startDay || 0) + Math.floor(total / 1440), hhmm: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` };
    };
    const t = at(b);
    if (sameDayAs && at(sameDayAs).day === t.day) return t.hhmm;
    return `${E.dayName(U.state.scenario, t.day)}, ${t.hhmm}`;
  }

  function liveScene() {
    const e = U.state && U.state.pending && U.state.log.find((x) => x.type === 'scene' && x.turn === U.state.pending.turn);
    return e && e.beats && e.beats.length > 1 ? e : null;
  }

  // The live scene is revealed one beat at a time. Under the newest beat the
  // player either steps in or moves on; moving on settles that beat for good.
  // Beats after a step-in never happened, so they are never shown.
  function renderScene(e) {
    // What is still to go on a trip (R-10): the engine's line, outside the prose.
    const travel = (read) => (e.travel && read ? `<div class="beat-note travel-note">${esc(e.travel)}</div>` : '');
    const live = U.state.pending && U.state.pending.turn === e.turn;
    if (!e.beats || e.beats.length < 2) return `<div class="entry scene">${storyHtml(e.text)}</div>${travel(true)}`;
    const shown = live ? Math.min(U.uiShown, e.beats.length) : (e.cutAt || e.beats.length);
    let h = e.beats.slice(0, shown).map((b, i) =>
      `<div class="beat" data-beat="${i}"><div class="beat-time">${beatClock(e, b)}</div><div class="entry scene">${storyHtml(b.text)}</div></div>`
    ).join('');
    if (live && shown < e.beats.length) {
      const on = U.uiCut === shown;
      h += `<div class="interject"><button type="button" data-cut="${shown}" class="${on ? 'active' : ''}">${on ? '✓ Stepping in here (click to cancel)' : '↩ Step in here'}</button>` +
        `<button type="button" data-next>Next ▸</button></div>`;
    } else if (!live && e.cutAt) {
      h += '<div class="beat-note">You stepped in here; the rest didn\'t happen.</div>';
    }
    return h + travel(!live || shown >= e.beats.length);
  }

  // ---------- names in the story ----------
  // Places, people and lore terms in a scene are linked (E.Glossary decides
  // which, and only with what the player may know): hovering or focusing one
  // shows a short box, a click or tap opens the whole entry, and a person's
  // opens their card.
  function storyHtml(text) {
    const on = (U.storyLinksPreview || E.settings.appearance.storyLinks) !== 'off';
    return on && U.state ? E.Glossary.markup(U.state, text, esc) : esc(text);
  }
  const termInfo = (el) => E.Glossary.info(U.state, E.Glossary.parse(el.dataset.term));
  function termHtml(info, short) {
    const text = short ? (info.text[0] ? [E.shorten(info.text[0], 220)] : []) : info.text;
    return `<div class="term-title"${short ? '' : ' id="termTitle"'}><b>${esc(info.title)}</b>${info.feel ? ` <span class="rel-${esc(info.feel.split(' ')[0])}">you: ${esc(info.feel)}</span>` : ''}</div>` +
      (info.sub ? `<div class="muted small">${esc(info.sub)}</div>` : '') +
      text.map((t) => `<p>${esc(t)}</p>`).join('') +
      (!text.length ? '<div class="muted small">Nothing more is known yet.</div>' : '') +
      (short ? `<div class="muted small">${info.person ? 'Click for their card.' : 'Click for more.'}</div>` : '');
  }
  function showTip(el) {
    const info = termInfo(el);
    const tip = $('termTip');
    if (!info) return hideTip();
    tip.innerHTML = termHtml(info, true);
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  }
  function hideTip() { $('termTip').hidden = true; }
  function openTerm(el) {
    hideTip();
    const info = termInfo(el);
    if (!info) return;
    $('termBody').innerHTML = info.person ? popupCard(info.person) : termHtml(info, false);
    $('termDialog').showModal();
  }
  // A person's card in the popup: what the People panel shows, to read only.
  function popupCard(id) {
    const c = U.state.characters[id];
    const dead = c.status.health === 'dead';
    return `<div class="card popup-card${dead ? ' dead' : ''}" id="termTitle">${U.cardHeader(id, c, id === U.state.player, true)}${U.cardStatus(c, id === U.state.player)}${U.cardBody(id, c, dead, false)}</div>`;
  }
  $('log').addEventListener('pointerover', (ev) => {
    const el = ev.pointerType === 'mouse' && ev.target.closest('.term');
    if (el) showTip(el);
  });
  $('log').addEventListener('pointerout', (ev) => { if (ev.target.closest('.term')) hideTip(); });
  $('log').addEventListener('focusin', (ev) => { const el = ev.target.closest('.term'); if (el) showTip(el); });
  $('log').addEventListener('focusout', (ev) => { if (ev.target.closest('.term')) hideTip(); });
  $('log').addEventListener('scroll', hideTip, { passive: true });
  $('log').addEventListener('click', (ev) => { const el = ev.target.closest('.term'); if (el && U.state) openTerm(el); });
  $('log').addEventListener('keydown', (ev) => {
    const el = ev.target.closest && ev.target.closest('.term');
    if (!el || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    openTerm(el);
  });

  function actionPlaceholder() {
    const entry = liveScene();
    if (entry && !canAct()) return 'Read on with Next ▸, or press "Step in here" to act now. (You can type ahead.)';
    if (U.uiCut && entry) return `What do you do at ${beatClock(entry, entry.beats[U.uiCut - 1])}–${beatClock(entry, entry.beats[U.uiCut], entry.beats[U.uiCut - 1])}? (Ctrl+Enter to act)`;
    return $('timeStep').value === 'major'
      ? 'How do you spend the downtime? (optional, e.g. "Keep the arrays clean and avoid Teo")'
      : 'What do you do? (Ctrl+Enter to act)';
  }

  $('log').addEventListener('click', (ev) => {
    const cutBtn = ev.target.closest('button[data-cut]');
    const nextBtn = ev.target.closest('button[data-next]');
    if ((!cutBtn && !nextBtn) || U.busy) return;
    if (cutBtn) {
      const n = parseInt(cutBtn.dataset.cut, 10);
      U.uiCut = U.uiCut === n ? null : n;
    } else {
      U.uiCut = null;
      U.uiShown++;
    }
    const log = $('log');
    const top = log.scrollTop;
    renderLog();
    renderControls();
    // People who move in this beat move on the map now.
    U.renderMap();
    log.scrollTop = top;
    if (nextBtn) {
      announceBeat(U.uiShown - 1);
      // Bring the new beat into view from its top, scrolling only the story
      // panel and only downward. (Earlier turns have beats with the same
      // numbers, so look only inside the current turn.)
      const beat = log.querySelector(`.turn-current .beat[data-beat="${U.uiShown - 1}"]`);
      if (beat) log.scrollTop = Math.max(top, Math.min(offsetIn(log, beat) - 8, log.scrollHeight - log.clientHeight));
    } else {
      $('actionInput').focus();
    }
  });

  function renderSceneBar() {
    const pc = U.state.characters[U.state.player];
    const loc = U.state.locations[pc.status.location];
    const present = E.Engine.present(U.state).map(nm);
    $('sceneBar').innerHTML = `<b>${esc(E.fmtTime(U.state))}</b> · ${esc(U.state.scenario.worldTitle || U.state.scenario.title)}${U.state.scenario.startTitle ? `<span class="desktop-only"> (${esc(U.state.scenario.startTitle)})</span>` : ''} · You are in <b>${esc(loc ? loc.name : '?')}</b>` +
      (present.length ? ` with ${esc(present.join(', '))}` : ', alone') +
      ((m) => (m.length ? `<span class="desktop-only"> · also here: ${esc(m.map((x) => `${x.name} (${x.role})`).join(', '))}</span>` : ''))(E.Engine.extrasAt(U.state, pc.status.location)) +
      // Unnamed groups (task 3-2) on every screen size: a hostile crowd matters.
      ((g) => (g.length ? ` · ${esc(g.map((x) => `${x.count} ${x.label}, ${x.state}`).join('; '))}` : ''))(E.Engine.standeesAt(U.state, pc.status.location)) +
      ` · Chapter ${U.state.chapter}, turn ${U.state.turn}`;
  }

  function renderSituation() {
    const clocks = E.Engine.liveClocks(U.state).map((c) => {
      const pct = Math.round((c.value / c.max) * 100);
      return `<div class="clock"><div class="label"><span>${esc(c.name)}</span><span class="muted">${c.fired ? 'happened' : pct + '%'}</span></div>` +
        `<div class="bar ${pct >= 75 || c.fired ? 'danger' : ''}"><i style="width:${c.fired ? 100 : pct}%"></i></div></div>`;
    }).join('');
    const world = Object.entries(U.state.world).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join('');
    // Each group's stance, and (task G-6) where the player stands with it: the
    // number and the word, their role, and the latest reason.
    const groups = (U.state.factions || []).map((f) => {
      const r = (U.state.reputation || {})[f.id];
      const role = E.Standing.roleOf(U.state, f.id);
      const standing = r ? ` <span class="standing">· you: <span class="rel-${E.Standing.word(r.value)}">${E.Standing.word(r.value)} ${r.value > 0 ? '+' : ''}${r.value}</span>${role ? ` (${role === 'leader' ? 'you lead it' : role})` : ''}${r.why ? ` <span class="muted">${esc(r.why)}</span>` : ''}</span>` : '';
      return `<div title="${esc(f.desc)}" data-group="${esc(f.id)}"><b>${esc(f.name)}</b>: ${esc(f.stance)}${standing}</div>`;
    }).join('');
    $('situation').innerHTML = clocks + `<div class="world">${world}</div>` + regionHtml() + (groups ? `<div class="world groups">${groups}</div>` : '');
  }

  // The player's region (task 3-1): who holds it, its tags and status. The map views come later.
  function regionHtml() {
    const id = E.Engine.playerRegion(U.state);
    const def = id && E.Engine.regionDef(U.state, id);
    const r = def && U.state.regions && U.state.regions[id];
    if (!r) return '';
    const present = E.Engine.presenceText(U.state, id);
    const bits = [`held by ${E.Engine.regionHolder(U.state, id).text}`].concat(present ? [`present: ${present}`] : [], r.tags.length ? [r.tags.join(', ')] : [], r.status ? [r.status] : []);
    // The regions it is inside (R-1): "in Harmon County".
    const up = E.Engine.regionChain(U.state, id).slice(1).map((x) => E.Engine.regionDef(U.state, x).name);
    return `<div class="world groups" title="${esc(def.lore || '')}"><b>${esc(def.name)}</b>${up.length ? ` <span class="muted">(in ${esc(up.join(', '))})</span>` : ''}: ${esc(bits.join('; '))}</div>`;
  }

  const newsRegion = (id) => { const d = id && E.Engine.regionDef(U.state, id); return d ? ` · ${esc(d.name)}` : ''; };
  function renderNews() {
    const news = (U.state.news || []).slice().reverse().slice(0, 6);
    $('newsPanel').classList.toggle('hidden', !news.length);
    $('news').innerHTML = news.map((n) =>
      `<div class="news-item"><span class="muted">${n.scope === 'world' ? '🌍' : '🗺️'} ${esc(n.time)}${newsRegion(n.region)}</span><div>${esc(n.text)}</div>` +
      (n.effects && n.effects.length ? `<div class="muted small">${n.effects.map(esc).join(' · ')}</div>` : '') + '</div>'
    ).join('');
  }
  Object.assign(U, { autosave, download, renderRecorder, stopRecording, setBusy, renderAll, renderLog, liveScene, actionPlaceholder });
})();
