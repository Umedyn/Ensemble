// The Debug panel.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

  // ---------- debug ----------
  // Generated sites (task 4-4), for Debug: everything, notes included.
  function sitesDebug() {
    return Object.values(U.state.sites).map((s) => [
      `${s.name} [${s.id}] · ${s.kind} · ${s.region || 'no region'} · ${s.stub ? 'stub (not built)' : `entry ${s.entry}`} · from ${s.from}${s.map ? ` (library map ${s.map})` : ''}`,
      `  why: ${s.why || '-'}`,
      s.stub ? `  summary: ${s.summary || '-'}` : `  rooms: ${s.rooms.join(', ')}; visits ${s.visits}; ${s.kept ? `kept (${s.keptWhy})` : 'fades if nothing happens there'}`,
      s.note ? `  note: ${s.note}` : null,
    ].filter(Boolean).join('\n')).join('\n\n');
  }
  function renderDebug() {
    U.renderRecorder();
    if ($('debug').classList.contains('hidden')) return;
    const calls = E.LLM.calls.slice().reverse();
    const facts = U.state ? U.state.facts.map((f) => `[T${f.turn} w${f.weight}] ${f.text}   (known by: ${f.known_by.join(', ')})`).join('\n') : '';
    $('debugBody').innerHTML =
      renderTelemetry() +
      (U.state ? `<details><summary>Fact store (${U.state.facts.length})</summary><pre>${esc(facts)}</pre></details>` : '') +
      (U.state ? `<details><summary>Characters: needs, tiers, mood and tags</summary><pre>${esc(characterDebug())}</pre></details>` : '') +
      (U.state && E.Timeline.all(U.state).length ? `<details><summary>Timeline (${E.Timeline.pending(U.state).length} upcoming)</summary><pre>${esc(timelineDebug())}</pre></details>` : '') +
      (U.state && Object.keys(U.state.sites || {}).length ? `<details><summary>Places made during the story (${Object.keys(U.state.sites).length})</summary><pre>${esc(sitesDebug())}</pre></details>` : '') +
      U.notes.slice().reverse().map((n) => `<details class="note"><summary><b>${esc(n.kind)}</b> · ${esc(n.summary)}</summary><pre>${esc(n.detail)}</pre></details>`).join('') +
      calls.map((c) => `<details><summary><b>${esc(c.kind)}</b> · ${esc(c.backend || '')} · ${c.ms} ms · ~${c.estTokens} tokens${c.overBudget ? ' <span class="fail">over context!</span>' : ''}${c.squeezed ? ` <span class="fail">squeezed to fit: ${esc(c.squeezed.join(', '))} left out</span>` : ''}${c.finish === 'length' ? ' <span class="fail">cut off at the token limit</span>' : ''}${c.salvaged ? ' <span class="fail">salvaged: kept the complete part</span>' : ''}${c.error ? ' <span class="fail">' + esc(c.error) + '</span>' : ''}</summary>
        <div class="muted">System (shared prefix)</div><pre>${esc(c.system)}</pre>
        <div class="muted">User</div><pre>${esc(c.user)}</pre>
        <div class="muted">Raw output</div><pre>${esc(c.raw)}</pre></details>`).join('') ||
      '<div class="muted">No model calls yet.</div>';
  }
  // The timeline (task 5-2): upcoming events with each precondition as it
  // stands now, then what became of the rest. Debug only: the future is hidden.
  function timelineDebug() {
    const TL = E.Timeline;
    const sc = U.state.scenario;
    const up = TL.pending(U.state).map((ev) => [`${TL.fmt(sc, ev.when)} [${ev.scope}${ev.projected ? ', projected' : ''}${ev.onBroken === 'diverge' ? ', diverges' : ''}] ${ev.id}: ${ev.text}`]
      .concat(TL.status(U.state, ev).map((p) => `    ${p.ok ? '✓' : '✗'} ${p.text}`)).join('\n'));
    const done = TL.all(U.state).filter((ev) => U.state.canon[ev.id] && U.state.canon[ev.id].status !== 'past')
      .map((ev) => { const st = U.state.canon[ev.id]; return `${ev.id}: ${st.status} (${st.time || ''})${st.why ? ` — ${st.why}` : st.text && st.text !== ev.text ? ` — ${st.text}` : ''}`; });
    return (up.length ? 'Upcoming:\n' + up.join('\n') : 'Nothing upcoming.') + (done.length ? '\n\nResolved:\n' + done.join('\n') : '') +
      (U.state.projection === false ? '\n\n(This game started before projected events; none are planned.)' : '');
  }
  // Minor people (task 2-3): where they are, how often you named them, promotion.
  function extrasDebug() {
    const xs = Object.values(U.state.extras || {});
    if (!xs.length) return '';
    return '\n\nMinor people:\n' + xs.map((x) => `  ${x.name} (${x.id}), ${x.role}; in ${x.location ? (U.state.locations[x.location] || {}).name || x.location : 'no particular place'}; ${x.from === 'model' ? `added turn ${x.born}` : x.from === 'standee' ? `singled out turn ${x.born}` : 'authored'}` +
      `; named ${x.mentions}×${x.promote ? `; promotion due (${x.tries} tries)` : ''}` + (x.note ? `\n    note: ${x.note}` : '')).join('\n');
  }
  // Unnamed groups (task 3-2): count, state, room, post or patrol.
  function standeesDebug() {
    const gs = Object.values(U.state.standees || {});
    if (!gs.length) return '';
    return '\n\nUnnamed groups:\n' + gs.map((g) => `  ${g.label} (${g.id}): ${g.count}, ${g.state}; in ${(U.state.locations[g.location] || {}).name || g.location}` +
      (g.faction ? `; ${g.faction}` : '') + (g.post ? `; post ${g.post}` : '') + (g.patrol ? `; patrol ${g.patrol.join(' → ')}` : '') + (g.note ? `\n    note: ${g.note}` : '')).join('\n');
  }

  // The raw numbers behind the cards (needs as 0–1, tag expiry, mood reasons).
  function characterDebug() {
    return E.Engine.cast(U.state).map((id) => {
      const c = U.state.characters[id];
      const needs = Object.entries(c.needs || {}).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') || 'no needs';
      const mood = c.mood ? `mood (turn ${c.mood.turn}): ${c.mood.text}${c.mood.reason ? ' — ' + c.mood.reason : ''}` : 'mood: none';
      const tags = (c.tags || []).map((t) => `${t.text} [${t.until == null ? 'lasting' : 'until turn ' + t.until}]${t.reason ? ' — ' + t.reason : ''}`);
      const tier = id === U.state.player ? '' : `; ${E.Engine.tier(U.state, id)}${c.pinned ? ' (pinned)' : ''}, last seen turn ${c.lastSeen || 0}`;
      // Agendas (task 2-2): goal, step k/n and progress; Debug only, since steps can be secret.
      const a = c.agenda;
      const agenda = id === U.state.player ? [] : [a
        ? `  agenda: ${a.goal} — ${a.done ? 'done' : `step ${a.step + 1}/${a.steps.length} "${a.steps[a.step].text}"${a.steps[a.step].contact ? ' (comes to you)' : ''}, ${Math.round(a.progress * 100)}%${a.due ? ', DUE' : ''}`}; ${a.hours} h a step, ${a.visibility}${a.followUp ? ', follow-up' : ''}`
        : 'agenda' in c ? '  agenda: routine' : '  agenda: none yet (the model will propose one when they are in the background)'];
      return [`${c.name} (${id}): ${E.healthWord(c.status.health)}; ${needs}${tier}`, '  ' + mood].concat(agenda).concat(tags.map((t) => '  tag: ' + t)).join('\n');
    }).join('\n') + extrasDebug() + standeesDebug() + (U.state.corrections && U.state.corrections.length
      ? '\n\nYour corrections:\n' + U.state.corrections.map((x) => `  turn ${x.turn}: ${U.state.characters[x.id] ? U.state.characters[x.id].name : x.id} ${x.delta > 0 ? '+' : ''}${x.delta} → ${x.value}${x.why ? ` (${x.why})` : ''}`).join('\n')
      : '');
  }

  // Where each turn's time and tokens went, and which guards fired. The newest
  // turn is open; "~" marks estimates (the backend didn't report usage).
  function renderTelemetry() {
    const reports = E.Engine.telemetry.slice().reverse();
    if (!reports.length) return '';
    const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
    const tok = (c, f) => (c.estimated !== false ? '~' : '') + (Number(c[f]) || 0).toLocaleString();
    const anyCache = (t) => t.calls.some((c) => c.cachedTokens != null);
    const anyPerf = (t) => t.calls.some((c) => c.perf);
    return reports.map((t, i) => {
      const tot = E.Engine.reportTotals(t);
      const cache = anyCache(t), perf = anyPerf(t);
      // Smaller calls (task L-3): a step's parts under one row with their sums.
      const stepOf = (c) => (/^[a-z]+:/.test(c.kind) ? c.kind.split(':')[0] : null);
      const groupRow = (i) => {
        const s = stepOf(t.calls[i]);
        if (!s || (i > 0 && stepOf(t.calls[i - 1]) === s)) return '';
        let j = i;
        while (j < t.calls.length && stepOf(t.calls[j]) === s) j++;
        const part = t.calls.slice(i, j);
        const sum = (f) => part.reduce((a, c) => a + (Number(c[f]) || 0), 0);
        const est = part.some((c) => c.estimated !== false) ? '~' : '';
        return `<tr class="call-group"><td>${esc(s)} · ${part.length} call${part.length === 1 ? '' : 's'}</td><td></td><td class="num">${est}${sum('promptTokens').toLocaleString()}</td><td class="num">${est}${sum('completionTokens').toLocaleString()}</td>` +
          (cache ? '<td></td>' : '') + (perf ? '<td></td>' : '') + `<td class="num">${sec(sum('ms'))}</td></tr>`;
      };
      const rows = t.calls.map((c, i) => groupRow(i) +
        `<tr class="${[c.error ? 'fail' : '', stepOf(c) ? 'call-part' : ''].filter(Boolean).join(' ')}"><td>${esc(c.kind)}${c.salvaged ? ' <span class="fail">salvaged</span>' : ''}${c.finish === 'length' ? ' <span class="fail">cut off</span>' : ''}${c.finish === 'stopped' ? ` <span class="muted" title="${esc(c.stopped || '')}">stopped at a paragraph</span>` : ''}</td><td>${esc(c.backend || '')}</td>` +
        `<td class="num">${tok(c, 'promptTokens')}</td><td class="num">${tok(c, 'completionTokens')}</td>` +
        (cache ? `<td class="num">${c.cachedTokens != null ? c.cachedTokens.toLocaleString() : ''}</td>` : '') +
        (perf ? `<td class="num">${c.perf ? sec(c.perf.processSec * 1000) : ''}</td>` : '') +
        `<td class="num">${sec(c.ms || 0)}</td></tr>`).join('');
      const est = tot.estimated ? '~' : '';
      const guards = t.guards.length
        ? `<ul class="guards">${t.guards.map((g) => `<li><b>${esc(g.type)}</b>${g.turn != null && g.turn !== t.turn ? ` <span class="muted">(turn ${g.turn})</span>` : ''}: ${esc(g.detail)}</li>`).join('')}</ul>`
        : '<div class="muted">No guards fired.</div>';
      return `<details class="telemetry"${i === 0 ? ' open' : ''}><summary><b>${t.kind === 'reroll' ? 'Reroll of turn' : 'Turn'} ${t.turn}</b> · ${sec(t.ms)} · ${tot.calls} call${tot.calls === 1 ? '' : 's'} · ${est}${tot.promptTokens.toLocaleString()} in / ${est}${tot.completionTokens.toLocaleString()} out` +
        `${t.guards.length ? ` · ${t.guards.length} guard${t.guards.length === 1 ? '' : 's'}` : ''}${t.error ? ' <span class="fail">failed</span>' : ''}</summary>` +
        `<table><thead><tr><th>step</th><th>backend</th><th class="num">in</th><th class="num">out</th>${cache ? '<th class="num" title="Prompt tokens the provider served from its cache">cached</th>' : ''}${perf ? '<th class="num" title="KoboldCpp prompt processing time; short means the shared prefix was reused">prompt</th>' : ''}<th class="num">time</th></tr></thead><tbody>${rows}</tbody></table>` +
        `<div class="muted small">Guards fired</div>${guards}` +
        ((t.lore || []).length ? `<div class="muted small">Lore included</div><ul class="guards">${t.lore.map((l) => `<li><b>${esc(l.title)}</b> <span class="muted">(${esc(l.call)})</span>: ${esc(l.why)}</li>`).join('')}</ul>` : '') +
        `<button type="button" class="small" data-copy-report="${E.Engine.telemetry.indexOf(t)}">Copy turn report</button></details>`;
    }).join('');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    // Fallback for pages opened from disk, where the clipboard API can be blocked.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  $('debugBody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-copy-report]');
    if (!btn) return;
    const t = E.Engine.telemetry[parseInt(btn.dataset.copyReport, 10)];
    if (!t) return;
    btn.textContent = (await copyText(E.Engine.turnReport(t))) ? 'Copied' : 'Copy failed (select the text in a call below instead)';
  });

  $('btnDebug').addEventListener('click', () => { $('debug').classList.toggle('hidden'); renderDebug(); });
  $('btnDebugClose').addEventListener('click', () => $('debug').classList.add('hidden'));
  Object.assign(U, { renderDebug });
})();
