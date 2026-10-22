// Fact points, chapter rollups and prompt budgets.
(function (root) {
  const E = root.Ensemble;
  const Mem = (E.Memory = {});

  Mem.addFact = function (state, f) {
    const fact = {
      id: 'f' + state.nextFactId++,
      turn: state.turn,
      chapter: state.chapter,
      about: f.about || [],
      text: String(f.text).slice(0, 220),
      known_by: f.known_by && f.known_by.length ? f.known_by : ['all'],
      weight: E.clamp(Math.round(Number(f.weight) || 1), 1, 3),
    };
    state.facts.push(fact);
    return fact;
  };

  Mem.knows = (fact, id) => fact.known_by.includes('all') || fact.known_by.includes(id);
  Mem.playerFacts = (state) => state.facts.filter((f) => Mem.knows(f, state.player));
  // Facts a given character knows that the player does not.
  Mem.privateFacts = (state, id) =>
    state.facts.filter((f) => !Mem.knows(f, state.player) && Mem.knows(f, id));

  Mem.budgets = function () {
    const ctx = E.memoryContext().tokens;
    // Lore (task 5-1) gets about a tenth, in the user message.
    return { facts: Math.floor(ctx * 0.2), story: Math.floor(ctx * 0.12), lore: Math.floor(ctx * 0.1) };
  };

  const factLine = (f) => `- [T${f.turn}] ${f.text}`;

  // Player-known facts for the shared prompt prefix. Always keeps weight-3
  // facts; if over budget, drops the oldest minor ones first.
  Mem.factsBlock = function (state) {
    const facts = Mem.playerFacts(state);
    const budget = Mem.budgets().facts;
    let lines = facts.map(factLine);
    if (E.estTokens(lines.join('\n')) <= budget) return lines.join('\n');
    const keep = new Set(facts.filter((f) => f.weight >= 3).map((f) => f.id));
    let used = facts.filter((f) => keep.has(f.id)).reduce((n, f) => n + E.estTokens(factLine(f)), 0);
    for (let i = facts.length - 1; i >= 0; i--) {
      const f = facts[i];
      if (keep.has(f.id)) continue;
      const cost = E.estTokens(factLine(f));
      if (used + cost > budget) break;
      keep.add(f.id);
      used += cost;
    }
    return facts.filter((f) => keep.has(f.id)).map(factLine).join('\n');
  };

  Mem.storyBlock = function (state) {
    const budget = Mem.budgets().story;
    const out = [];
    let used = 0;
    for (let i = state.chapters.length - 1; i >= 0; i--) {
      const c = state.chapters[i];
      const line = `Chapter ${c.n} — ${c.title}: ${c.summary}`;
      const cost = E.estTokens(line);
      if (used + cost > budget) break;
      out.unshift(line);
      used += cost;
    }
    return out.join('\n');
  };

  Mem.turnsInChapter = (state) => state.turn - state.chapterStartTurn + 1;

  Mem.needsChapter = function (state) {
    if (state.turn < state.chapterStartTurn) return false;
    if (Mem.turnsInChapter(state) >= E.settings.chapterLength) return 'length';
    // Big moments close a chapter early, but never after a single turn.
    if (state.flags.chapterWorthy && Mem.turnsInChapter(state) >= 2) return 'story beat';
    const playerFacts = Mem.playerFacts(state).map(factLine).join('\n');
    if (E.estTokens(playerFacts) > Mem.budgets().facts) return 'size';
    return false;
  };

  Mem.chapterFacts = (state) =>
    state.facts.filter((f) => f.chapter === state.chapter && Mem.knows(f, state.player));

  // Roll the current chapter up: minor player-known facts are replaced by the
  // summary; major (weight 3) and private facts are kept individually.
  Mem.closeChapter = function (state, summary, reason) {
    const n = state.chapter;
    state.chapters.push({
      n,
      title: String(summary.title || `Chapter ${n}`).slice(0, 80),
      summary: String(summary.summary || '').slice(0, 700),
      fromTurn: state.chapterStartTurn,
      toTurn: state.turn,
      reason,
    });
    state.facts = state.facts.filter(
      (f) => f.chapter !== n || f.weight >= 3 || !Mem.knows(f, state.player)
    );
    state.chapter = n + 1;
    state.chapterStartTurn = state.turn + 1;
    state.flags.chapterWorthy = false;
  };
})(typeof window !== 'undefined' ? window : globalThis);
