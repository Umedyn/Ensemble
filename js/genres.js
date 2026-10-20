// Genre tags: engine-owned guidance for how a world's story plays out (tone,
// what counts as a major event, how lethal danger is) and default event
// pacing. A world lists tags in order of importance: where they pull apart,
// the first one leads. Unknown tags are freeform and passed on as written.
(function (root) {
  const E = root.Ensemble;
  const G = (E.Genres = {});

  const DANGER = {
    lethal: 'lethal. Injuries are serious and people can die.',
    serious: 'real. People can be badly hurt, but death is rare and meaningful.',
    mild: 'low. Harm is mostly social or emotional; serious injury or death only if the player clearly courts it.',
  };

  // eventRates: average in-game hours between regional/world events;
  // majorEventDays: average days to a random major event when skipping.
  G.table = {
    survival: {
      tone: 'Scarcity, exposure and exhaustion press on every choice; ordinary tasks take real effort.',
      major: "a threat to the group's survival (supplies lost, shelter breached, someone badly hurt)",
      danger: 'lethal', eventRates: { regional: 18, world: 96 }, majorEventDays: 9,
    },
    'slice-of-life': {
      tone: 'Everyday routines, small moments and ordinary friction; let quiet scenes breathe.',
      major: "a change in someone's life (a fight, a confession, news from home, a job lost)",
      danger: 'mild', eventRates: { regional: 48, world: 240 }, majorEventDays: 14,
    },
    romance: {
      tone: 'Attraction, hesitation and what goes unsaid; feelings get room and have consequences.',
      major: 'a turning point between two people (a confession, a betrayal, a rival)',
      danger: 'mild',
    },
    intrigue: {
      tone: 'Secrets, leverage and divided loyalties; people say less than they know.',
      major: 'a secret exposed, a betrayal, or a shift in who holds power',
      danger: 'serious',
    },
    war: {
      tone: "Orders, fear, comradeship and violence at close range; the front moves whether or not anyone's ready.",
      major: 'an attack, a loss, new orders, or the front shifting',
      danger: 'lethal', eventRates: { regional: 12, world: 48 }, majorEventDays: 5,
    },
    horror: {
      tone: 'Dread builds slowly; imply more than you show; quiet moments feel uneasy.',
      major: 'the threat showing itself, someone taken, or a safe place no longer safe',
      danger: 'lethal',
    },
    mystery: {
      tone: 'Clues, contradictions and people with something to hide; answers are earned.',
      major: 'a discovery that changes the picture (a body, a clue, a lie exposed)',
      danger: 'serious',
    },
    comedy: {
      tone: 'Misunderstandings, bad timing and people being themselves at the worst moment; stakes stay personal.',
      major: 'a plan collapsing spectacularly or an embarrassing reveal',
      danger: 'mild',
    },
    cozy: {
      tone: 'Warmth, small comforts and community; trouble is real, but kind people can fix it.',
      major: 'a problem the community has to come together over',
      danger: 'mild', eventRates: { regional: 72, world: 336 }, majorEventDays: 14,
    },
    grim: {
      tone: 'Hard choices without good options; kindness costs something, and losses stay lost.',
      major: "a loss that can't be undone",
      danger: 'lethal',
    },
    adventure: {
      tone: 'Momentum, discovery and daring; set pieces, chases and places no one has seen.',
      major: 'a new danger or discovery that changes the course',
      danger: 'serious', eventRates: { regional: 12 },
    },
    political: {
      tone: 'Factions, deals, public faces and private ambitions; every choice has a constituency.',
      major: 'a vote, a scandal, an alliance made or broken, or a leader falling',
      danger: 'serious', eventRates: { world: 48 },
    },
  };

  // Engine defaults when neither a tag nor the world sets a value.
  G.DEFAULTS = { eventRates: { regional: 18, world: 96 }, majorEventDays: 9 };

  // The world's tags split into known table entries (in order, no repeats)
  // and freeform text.
  G.split = function (tags) {
    const known = [];
    const free = [];
    (tags || []).forEach((t) => {
      const s = String(t).trim();
      const k = s.toLowerCase();
      if (!s) return;
      if (G.table[k]) { if (!known.includes(k)) known.push(k); }
      else if (!free.includes(s)) free.push(s);
    });
    return { known, free };
  };

  // The leading (first known) tag's table entry, or null.
  G.lead = function (sc) {
    const { known } = G.split(sc.tags);
    return known.length ? G.table[known[0]] : null;
  };

  // The rule line on what failure and harm cost, by the leading tag's danger.
  // No known tag keeps the original survival-minded line.
  const CONSEQUENCES = {
    lethal: 'Outcomes marked RESOLVED are final. Failures have real consequences. Injuries and deaths are permanent.',
    serious: 'Outcomes marked RESOLVED are final. Failures have real consequences. Injuries last; death is rare and permanent.',
    mild: 'Outcomes marked RESOLVED are final. Failures cost something: embarrassment, strain, a setback.',
  };
  G.consequences = (sc) => CONSEQUENCES[(G.lead(sc) || { danger: 'lethal' }).danger];

  // Effective pacing: the world's own values, else the first tag that sets
  // one, else the engine default. Each eventRates tier is settled separately.
  G.pacing = function (sc) {
    const { known } = G.split(sc.tags);
    const fromTags = (get) => { for (const k of known) { const v = get(G.table[k]); if (v != null) return v; } return null; };
    const rates = Object.assign({}, sc.eventRates || {});
    ['regional', 'world'].forEach((t) => {
      if (rates[t] == null) rates[t] = fromTags((g) => g.eventRates && g.eventRates[t]) ?? G.DEFAULTS.eventRates[t];
    });
    return {
      eventRates: rates,
      majorEventDays: sc.majorEventDays ?? fromTags((g) => g.majorEventDays) ?? G.DEFAULTS.majorEventDays,
    };
  };

  // Lines for the prompt header's genre block, or null when the world has no
  // tags and no tone note. Static for a game, so the prompt cache holds.
  G.guidance = function (sc) {
    const { known, free } = G.split(sc.tags);
    const note = String(sc.toneNote || '').trim();
    if (!known.length && !free.length && !note) return null;
    const lines = [];
    const all = known.concat(free);
    if (all.length) lines.push(`This story is: ${all.join(', ')}.${all.length > 1 ? ' Blend them; where they pull apart, the first leads.' : ''}`);
    known.forEach((k) => lines.push(`- ${k}: ${G.table[k].tone}`));
    if (known.length) {
      const lead = G.table[known[0]];
      lines.push(`A major event here means: ${lead.major}.`);
      lines.push(`Danger is ${DANGER[lead.danger]}`);
    }
    if (note) lines.push(`Tone: ${note}`);
    return lines;
  };
})(typeof window !== 'undefined' ? window : globalThis);
