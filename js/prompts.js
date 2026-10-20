// Prompt builders. Order matters for KoboldCpp's prompt cache:
//   system = static header (rules, setting, places, cast) + story so far + player-known facts
//   user   = everything that changes per call (status, secrets, scene, task)
// The system part is identical across the intent/narrate/update calls of a turn
// and only grows at the end between turns, so most of it is reused.
(function (root) {
  const E = root.Ensemble;
  const P = (E.Prompts = {});
  const Mem = () => E.Memory;
  const Eng = () => E.Engine;

  const name = (state, id) => (state.characters[id] ? state.characters[id].name : id);

  // ---------- blocks ----------
  // Every prompt is an ordered list of named blocks (P.layouts), each built by
  // one function in P.blocks from the prompt's context object. A block returns
  // its text (or a list of lines), or null to leave it out; '' still adds an
  // empty line. The parts are joined with newlines. Adding a block is one
  // function here plus one position in a layout.
  //
  // Cache rule (CLAUDE.md rule 7): the header is identical for every call in a
  // turn and only grows at its end between turns. Blocks whose content changes
  // during play may only come at the end of the header (P.LIVE_HEADER, in that
  // order) or go in a user message. Static content (setting, places, cast,
  // later genre, lore titles, geography) goes before them.
  const B = (P.blocks = {});
  P.layouts = {};
  P.LIVE_HEADER = ['chapters', 'facts'];
  P.build = function (layout, ctx) {
    const parts = [];
    P.layouts[layout].forEach((id) => {
      const out = B[id](ctx);
      if (out == null) return;
      if (Array.isArray(out)) parts.push(...out); else parts.push(out);
    });
    return parts.join('\n');
  };

  P.layouts.header = ['intro', 'setting', 'rules', 'places', 'groups', 'cast', 'chapters', 'facts'];
  P.header = (state) => P.build('header', { state, sc: state.scenario, pc: state.characters[state.player] });

  B.intro = () => 'You are the simulation engine and narrator for an interactive, character-driven story.';
  B.setting = ({ sc }) => `\n=== SETTING: ${sc.worldTitle || sc.title} ===\n${sc.setting}`;
  B.rules = ({ state, sc, pc }) => {
    const rules = [
      'The story is told at a personal scale, through individual people. Groups and factions (organizations, crews, gangs, governments) still exist and act collectively: show how individual choices ripple out to them, and how their moves land on individuals. The player commands no faction.',
      `The player controls only ${pc.name} (id: ${state.player}). Never decide ${pc.name}'s choices, words or feelings beyond what the player's action states.`,
      'Outcomes marked RESOLVED are final. Failures have real consequences. Injuries and deaths are permanent.',
      'Characters act from their own personality, wants, needs, secrets and feelings, not to serve the player.',
    ].concat(sc.rules || []);
    return ['\n=== RULES ==='].concat(rules.map((r) => '- ' + r));
  };
  B.places = ({ state }) => ['\n=== LOCATIONS ==='].concat(Object.values(state.locations).map((l) => {
    const c = l.connects && l.connects.length ? ` (connects: ${l.connects.join(', ')})` : '';
    return `- ${l.id}: ${l.name} — ${l.desc}${c}`;
  }));
  B.groups = ({ sc }) => (sc.factions && sc.factions.length
    ? ['\n=== GROUPS ==='].concat(sc.factions.map((f) => `- ${f.id}: ${f.name} — ${f.desc}`))
    : null);
  B.cast = ({ state }) => ['\n=== CAST ==='].concat(Eng().cast(state).map((id) => {
    const c = state.characters[id];
    const tag = id === state.player ? ' (PLAYER)' : '';
    const bits = [`${c.name}${c.pronouns ? ` (${c.pronouns})` : ''}, ${c.role}${c.age ? ', ' + c.age : ''}.`];
    if (c.traits && c.traits.length) bits.push(`Traits: ${c.traits.join(', ')}.`);
    if (c.want && id !== state.player) bits.push(`Wants: ${c.want}.`);
    if (c.voice) bits.push(`Voice: ${c.voice}`);
    return `- ${id}${tag}: ${bits.join(' ')}`;
  }));
  // Live: grows at the end of the header between turns.
  B.chapters = ({ state }) => {
    const story = Mem().storyBlock(state);
    return story ? '\n=== STORY SO FAR ===\n' + story : null;
  };
  B.facts = ({ state }) => {
    const facts = Mem().factsBlock(state);
    return facts ? '\n=== ESTABLISHED FACTS (known to the player) ===\n' + facts : null;
  };

  function worldLines(state) {
    const w = Object.entries(state.world).map(([k, v]) => `${k}: ${v}`).join('; ');
    const clocks = state.clocks
      .map((c) => `${c.name} ${c.fired ? '(HAPPENED)' : Math.floor(c.value) + '/' + c.max}`)
      .join('; ');
    const groups = (state.factions || []).map((f) => `${f.name}: ${f.stance}`).join('; ');
    return `World: ${w || 'nothing notable'}\nPressures: ${clocks || 'none'}` + (groups ? `\nGroups: ${groups}` : '');
  }

  function needsText(state, c, onlyNotable) {
    return Object.entries(c.needs)
      .filter(([, v]) => !onlyNotable || v >= 0.6)
      .map(([k, v]) => `${k} ${E.needWord(v)}`)
      .join(', ');
  }

  // The player's own attitude toward the people around them, built only from
  // how the player has actually acted. Used so time skips stay in character.
  function playerAttitude(state, ids) {
    const pc = state.characters[state.player];
    const notes = pc.attitudeNotes || {};
    return ids
      .filter((o) => state.characters[o] && o !== state.player)
      .map((o) => {
        const v = pc.relations[o] || 0;
        return `${name(state, o)} ${E.relWord(v)} (${v}${notes[o] ? '; ' + notes[o] : ''})`;
      });
  }

  function statusLine(state, id, forNarrator, around) {
    const c = state.characters[id];
    const parts = [`health ${E.healthWord(c.status.health)}`];
    if (c.status.conditions.length) parts.push(`conditions: ${c.status.conditions.join(', ')}`);
    const needs = needsText(state, c, forNarrator);
    if (needs) parts.push(needs);
    if (id === state.player && around && around.length) {
      const att = playerAttitude(state, around);
      if (att.length) parts.push(`feels toward: ${att.join(', ')}`);
    }
    if (!forNarrator && id !== state.player) {
      const rel = c.relations[state.player] || 0;
      parts.push(`feels toward ${name(state, state.player)}: ${E.relWord(rel)} (${rel})`);
      const others = Object.entries(c.relations)
        .filter(([o]) => o !== state.player && state.characters[o] && state.characters[o].status.location === c.status.location)
        .map(([o, v]) => `${name(state, o)} ${E.relWord(v)}`);
      if (others.length) parts.push(`toward others here: ${others.join(', ')}`);
    }
    return `- ${c.name}${c.pronouns ? ` (${c.pronouns})` : ''} [${id}]: ${parts.join('; ')}`;
  }

  // ---------- user-message blocks shared by several prompts ----------
  // Where the player is, the world, who is present and their status.
  B.now = ({ state, present, forNarrator }) => {
    const pc = state.characters[state.player];
    const loc = state.locations[pc.status.location];
    const elsewhere = Eng().offstage(state, present)
      .map((id) => `${name(state, id)} (${state.locations[state.characters[id].status.location]?.name || '?'})`);
    const lines = [
      `=== NOW: ${E.fmtTime(state)} ===`,
      `${pc.name} is in ${loc ? loc.name : pc.status.location}.`,
      worldLines(state),
      `Present with ${pc.name}: ${present.length ? present.map((id) => name(state, id)).join(', ') : 'no one'}`,
    ];
    if (elsewhere.length) lines.push(`Elsewhere: ${elsewhere.join(', ')}`);
    lines.push('\n=== STATUS ===');
    lines.push(statusLine(state, state.player, forNarrator, present));
    present.forEach((id) => lines.push(statusLine(state, id, forNarrator)));
    return lines;
  };

  // '' when there is none (an empty line, as the prompts have always had).
  B.lastScene = ({ state }) => {
    const r = state.recent[state.recent.length - 1];
    return r ? `\n=== LAST SCENE ===\n${r.text}` : '';
  };

  const EVENT_GUIDE = {
    moment: 'Usually none for a few minutes; at most 1, only if something is already about to happen.',
    hour: '0 or 1.',
    hours: '1 or 2.',
    morning: '1 to 3, spread over the day and night.',
  };

  // ---------- intent ----------
  P.layouts.intent = ['now', 'private', 'offstage', 'lastScene', 'intentAction', 'intentTask'];
  P.intent = (state, present, action, stepLabel, stepId, due) =>
    P.build('intent', { state, sc: state.scenario, present, forNarrator: false, action, stepLabel, stepId, due: due || {} });

  // Secrets and private facts of the people present: only ever in the intent call.
  B.private = ({ state, present }) => {
    const priv = [];
    present.forEach((id) => {
      const c = state.characters[id];
      if (c.secret) priv.push(`- ${c.name}'s secret: ${c.secret} (guard: ${c.guard || 'medium'}; ${({ low: 'cracks easily when confronted', medium: 'holds up unless stressed or trusting', high: 'very hard to crack' })[c.guard || 'medium']})`);
      Mem().privateFacts(state, id).slice(-6).forEach((f) => priv.push(`- ${c.name} knows: ${f.text}`));
    });
    return priv.length ? '\n=== PRIVATE (each item is known ONLY to the character named) ===\n' + priv.join('\n') : null;
  };
  B.offstage = ({ state, present }) => {
    const offstage = Eng().offstage(state, present);
    if (!offstage.length) return null;
    return '\n=== OFFSTAGE (not with the player; for events only) ===\n' + offstage.map((id) => {
      const c = state.characters[id];
      const loc = state.locations[c.status.location];
      return `- ${id} (${c.name}), in ${loc ? loc.name : c.status.location}: wants ${c.want || '?'}${c.secret ? '; secret: ' + c.secret : ''}`;
    }).join('\n');
  };
  B.intentAction = ({ action, stepLabel }) => `\n=== PLAYER ACTION (time passing: ${stepLabel}) ===\n"${action}"\nThe player's action takes up this whole span. Others act during the same span.`;
  B.intentTask = ({ state, sc, present, stepId, due }) => {
    const ids = present.join(', ') || '(none)';
    return `
=== TASK ===
1. Judge the player's action. If it is risky, contested or depends on skill, set needs_roll to true and choose a skill (one of: ${sc.skills.join(', ')}) and a difficulty (easy, normal, hard). Talking, looking around and simple tasks need no roll. Everyone listed as present is in the same room as ${name(state, state.player)} right now, so an action about them needs no move. Only if the action clearly takes ${name(state, state.player)} somewhere else, set move_to to that location id (or to a character id to go where that character is).
2. You MUST give exactly one intent for EACH present character: ${ids}. Decide what each actually tries to do during this time, driven by their personality, wants, needs, secrets and feelings. They may help, argue, refuse, lie, deflect, pursue their own goals, or leave (move_to). Set visible to false if they act covertly so the player would not notice.
3. "says": the gist of anything they say aloud this turn (or null).
4. "reveals": almost always null. Only fill it if the character deliberately says their secret or private knowledge out loud this turn, and that matches their "says". Being asked once, or being nervous, is not enough: people deflect, make excuses or lie first.
5. "events": things that happen during this span outside the player's control, to keep the world moving: offstage characters pursuing their wants and secrets, groups making moves that affect the people here, someone arriving, a call over the intercom, equipment trouble, the pressures above getting closer. How many: ${EVENT_GUIDE[stepId] || EVENT_GUIDE.hour} Each event has:
   - "text": one sentence, with names.
   - "who": character ids involved (not the player).
   - "where": location id where it happens.
   - "visibility": "seen" (happens in the player's room), "heard" (the player gets a sound, call or message about it) or "hidden" (the player has no idea).
   - "moves": [{"id":"character_id","to":"location_id"}] for offstage characters who go somewhere because of it, else [].
   - "scope": "local" for these.
${tierTask(state, due)}
Reply with JSON only, exactly in this shape:
${intentExample(state, present)}`;
  };

  function tierTask(state, due) {
    const seeds = state.scenario.eventSeeds || {};
    const lines = [];
    const effectShape = `"effects":{"world":[{"key":"world_key","value":"new status"}],"groups":[{"id":"group_id","stance":"new stance"}],"clocks":[{"id":"clock_id","delta":2}],"new_clock":null}`;
    if (due.regional) {
      lines.push(`6. A REGIONAL event is due: add exactly one event with "scope":"regional" — something in the surroundings (terrain, weather, nearby places, infrastructure) that affects the people here.${seeds.regional ? ' Ideas: ' + seeds.regional.join('; ') + '.' : ''}`);
    }
    if (due.world) {
      lines.push(`${due.regional ? 7 : 6}. A WORLD event is due: add exactly one event with "scope":"world" — a broad shift far away (organizations, money, politics, disasters) whose effects reach the people here.${seeds.world ? ' Ideas: ' + seeds.world.join('; ') + '.' : ''}`);
    }
    if (!lines.length) return '   No regional or world events this turn; keep events local.';
    lines.push(`   Give regional/world events concrete consequences in ${effectShape}. Use only existing keys/ids (world keys: ${Object.keys(state.world).join(', ')}; groups: ${(state.factions || []).map((f) => f.id).join(', ') || 'none'}; clocks: ${state.clocks.filter((c) => !c.fired).map((c) => c.id).join(', ') || 'none'}). Use new_clock {"name":"short name","max":8,"perHour":0.2,"fireText":"what happens when it runs out"} only for a genuinely new looming problem. Usually "visibility":"heard" (news, a message, an alarm).`);
    return lines.join('\n');
  }

  // The example is pre-filled with the real ids so small models don't drop anyone.
  function intentExample(state, present) {
    const intents = present.map((id) =>
      `  {"id":"${id}","action":"one sentence","says":null,"reveals":null,"visible":true,"needs_roll":false,"skill":null,"difficulty":"normal","move_to":null}`
    );
    return `{"player":{"summary":"the player's action restated as a concrete attempt","needs_roll":false,"skill":null,"difficulty":"normal","move_to":null},
 "intents":[${intents.length ? '\n' + intents.join(',\n') + '\n ' : ''}],
 "events":[{"text":"one sentence","scope":"local","who":["character_id"],"where":"location_id","visibility":"heard","moves":[]}]}`;
  }

  function outcomeLines(state, res, forNarrator) {
    const lines = [];
    res.outcomes.forEach((o) => {
      const who = o.id === state.player ? `You (${name(state, o.id)})` : name(state, o.id);
      if (forNarrator && !o.visible && o.id !== state.player) {
        lines.push(`- ${name(state, o.id)} does something out of your sight. At most hint at it.`);
        return;
      }
      const roll = o.roll ? ` → ${o.roll.result.toUpperCase()} (${o.skill} check: rolled ${o.roll.total} vs ${o.roll.dc})` : ' → happens (no roll needed)';
      const move = o.moved ? ` [moves to ${state.locations[o.moved].name}]` : '';
      const hidden = !forNarrator && !o.visible ? ' [HIDDEN from player]' : '';
      lines.push(`- ${who}: ${o.action}${roll}${move}${hidden}`);
      if (o.says) lines.push(`    says (gist): ${o.says}`);
      if (o.reveals) lines.push(`    REVEALS: ${o.reveals}`);
    });
    res.events.forEach((e) => lines.push(`- EVENT: ${e}`));
    return lines.join('\n');
  }

  // How much the narrator may fill in for the player depends on the time step:
  // short steps are beat-by-beat, long ones hand routine over to the narrator.
  const STEP_GUIDE = {
    moment: 'This covers only a few minutes. Play out the stated action beat by beat. Add nothing else for the player character beyond small gestures and a line of dialogue.',
    hour: 'This covers about an hour, all spent on the stated action. Play the key exchange as a live scene and compress the rest of the hour with a line or two ("For the next forty minutes…"). You may show how it naturally unfolds, but the player character starts no new activities and goes nowhere else. Their manner toward others matches the feelings listed in STATUS.',
    hours: 'This covers a few hours. You may compress time ("By midday…") and show the stated action carried through, plus routine (eating, working). In that routine the player character treats each person according to the feelings listed in STATUS (no friendly chats with someone they resent). No big decisions or new plans for the player character.',
    morning: 'This covers the rest of the day and the night. Summarize briefly in a few sentences (routine work, a meal, sleep), then open the next morning as a live scene. The player character keeps to the feelings listed in STATUS: they avoid people they resent and seek out people they like. No big decisions for the player character.',
  };

  const BEAT_GUIDE = {
    moment: '1 beat: [+0m].',
    hour: '2 or 3 beats.',
    hours: '2 to 4 beats.',
    morning: '3 or 4 beats: the rest of the day, the evening, the night, then the morning.',
  };

  // ---------- scene and its continuation ----------
  // Frame, status, last scene, player action and resolved outcomes are shared
  // by the scene and its continuation.
  const SCENE_CONTEXT = ['sceneFrame', 'status', 'lastScene', 'sceneAction', 'resolved'];
  P.layouts.narrate = SCENE_CONTEXT.concat(['narrateTask']);
  P.layouts.narrateMore = SCENE_CONTEXT.concat(['sceneSoFar', 'narrateMoreTask']);
  P.narrate = (state, presentStart, action, frame, res) =>
    P.build('narrate', sceneContext(state, presentStart, action, frame, res));
  // sceneSoFar carries its time markers; fromMinutes is the last one.
  P.narrateMore = (state, presentStart, action, frame, res, sceneSoFar, fromMinutes) =>
    P.build('narrateMore', Object.assign(sceneContext(state, presentStart, action, frame, res), { sceneSoFar, fromMinutes }));

  function sceneContext(state, presentStart, action, frame, res) {
    const pc = state.characters[state.player];
    const startLoc = state.locations[frame.startLoc];
    const endLocId = pc.status.location;
    const endLoc = state.locations[endLocId];
    const moved = endLocId !== frame.startLoc;
    const nowHere = Eng().present(state, endLocId);
    const left = presentStart.filter((id) => !nowHere.includes(id));
    const arrived = nowHere.filter((id) => !presentStart.includes(id));
    return { state, presentStart, action, frame, res, pc, startLoc, endLoc, moved, left, arrived, statusIds: presentStart.concat(arrived), span: frame.spanMinutes || 60 };
  }

  B.sceneFrame = ({ state, presentStart, frame, pc, startLoc, endLoc, moved, left, arrived }) => `=== SCENE FRAME ===
Starts: ${frame.startTime}, in ${startLoc ? startLoc.name : frame.startLoc}, with ${presentStart.length ? presentStart.map((id) => name(state, id)).join(', ') : 'no one'}.
Ends: ${E.fmtTime(state)}, ${pc.name} ${moved ? `now in ${endLoc.name}` : `still in ${startLoc ? startLoc.name : frame.startLoc}`}.` +
      // When the player moves, people who stay put are left behind, not leaving.
      (left.length ? `\nDuring the scene, ${left.map((id) => state.characters[id].status.location === frame.startLoc
        ? `${name(state, id)} stays behind in ${startLoc ? startLoc.name : frame.startLoc}`
        : `${name(state, id)} leaves for ${state.locations[state.characters[id].status.location].name}`).join('; ')}.` : '') +
      (arrived.length ? `\n${arrived.map((id) => name(state, id)).join(', ')} ${arrived.length > 1 ? 'are' : 'is'} there at the end.` : '') +
      `\n${worldLines(state)}`;
  // Narrator-side status (no secrets, notable needs only) for the player and statusIds.
  B.status = ({ state, statusIds }) => ['\n=== STATUS ===', statusLine(state, state.player, true, statusIds)]
    .concat(statusIds.map((id) => statusLine(state, id, true)));
  B.sceneAction = ({ frame, action }) => `\n=== PLAYER ACTION (time span: ${frame.stepLabel}) ===\n"${action}"`;
  B.resolved = ({ state, res }) => '\n=== RESOLVED (final — narrate these faithfully) ===\n' + outcomeLines(state, res, true);

  // Steps with a loose length, where the beats should spread across the span.
  const SPREAD_STEPS = ['hour', 'hours'];

  B.narrateTask = ({ frame, pc, startLoc, endLoc, moved, span }) => {
    const spread = SPREAD_STEPS.includes(frame.stepId) ? ` Spread the beats across the whole span: the last one starts around [+${Math.round(span * 0.75)}m].` : '';
    return `
=== TASK ===
Write the next scene in second person, present tense ("you" is ${pc.name}), ${frame.words || '100–200'} words. Bring the characters to life through dialogue and small actions in their own voices.
Time: ${STEP_GUIDE[frame.stepId] || STEP_GUIDE.hour}
Beats: ${BEAT_GUIDE[frame.stepId] || BEAT_GUIDE.hour} Start each beat on its own line with a time marker in brackets: minutes since the scene started, like [+0m], [+25m], [+50m] (use hours for long spans, like [+5h]). The last marker is at most [+${span}m].${spread} End each beat on something the player could react to, since the player may step in between beats.
Structure:
1. The scene is set in ${moved ? `${startLoc.name}, then ${endLoc.name}` : (startLoc ? startLoc.name : frame.startLoc)}. Open with ${pc.name}'s action, carried out in the first paragraph.
2. Then show how the others react to it and what they do, in the order that makes sense.
3. End on the others' latest move: a reply, a look, a question or a new problem the player can respond to. The final paragraph must NEVER be ${pc.name}'s own line or action; leave ${pc.name}'s response open for the player.
Hard rules:
- Narrate ONLY the resolved outcomes above, faithfully. Failures should cost something.
- Play ${pc.name} naturally, in character${pc.voice ? ` (voice: ${pc.voice})` : ''}. If the action is vague, fill it in the way ${pc.name} would: small gestures, a line or two of dialogue, how they go about it.
- Do not make big choices for ${pc.name}: no agreeing to plans, making promises, starting new tasks, revealing what ${pc.name} knows beyond the action, or deciding what to do next. When a real choice comes up, stop there and leave it to the player.
- ${moved ? `${pc.name} goes only to ${endLoc.name}.` : `${pc.name} never leaves ${startLoc ? startLoc.name : 'this room'}.`} Do not take ${pc.name} anywhere else.
- Only the characters in the frame appear. Anyone "out of your sight" is NOT seen doing it; at most a sound or a hint.
- Characters may leave or arrive when it fits the outcomes and events; anyone who leaves is seen leaving, not followed.
- EVENTs tagged [regional] or [world] reach the scene the way they realistically would (a tremor, an alarm, a message or news report), and the present characters react to them in character.
- Use each character's pronouns exactly as given in STATUS (e.g. he/him means "he", never "they").
- Characters reveal only what is listed under REVEALS. Anything else they keep to themselves: they deflect, stall, joke or lie.
- Do not invent new events, confessions or discoveries.
- Stop at the end of these outcomes, on a moment that invites the player's response. Do not continue past it.` +
      (frame.correction ? `\n\nCORRECTION: ${frame.correction}` : '') +
      `\nReply with the scene text only.`;
  };

  // The scene stopped well short of the time step: ask for the rest of it.
  B.sceneSoFar = ({ sceneSoFar }) => `\n=== SCENE SO FAR ===\n${sceneSoFar}`;
  B.narrateMoreTask = ({ frame, pc, startLoc, endLoc, moved, span, fromMinutes }) => `
=== TASK ===
Continue the scene above. It stops at [+${fromMinutes}m], but this turn covers ${frame.stepLabel} (${span} minutes). Write 1 or 2 more beats, 40–100 words in total, in second person, present tense ("you" is ${pc.name}). Start each beat on its own line with a time marker counted from the start of the scene, later than [+${fromMinutes}m]; the last one around [+${Math.round(span * 0.85)}m] and at most [+${span}m].
Time: ${STEP_GUIDE[frame.stepId] || STEP_GUIDE.hour} Compress the routine part ("For the next half hour…").
Hard rules:
- Carry on from where the scene stops. Do not repeat or rewrite it.
- Do not make big choices for ${pc.name}: no agreeing to plans, making promises, starting new tasks or deciding what to do next.
- ${moved ? `${pc.name} stays in ${endLoc.name}.` : `${pc.name} never leaves ${startLoc ? startLoc.name : 'this room'}.`}
- Use each character's pronouns exactly as given in STATUS.
- No new events, confessions, reveals or discoveries beyond what the scene already shows.
- End on the others' latest move. The final paragraph must NEVER be ${pc.name}'s own line or action.
Reply with the new beats only.`;

  // ---------- downtime skip ----------
  function crewBrief(state, withSecrets) {
    return Eng().cast(state, { alive: true, includePlayer: false }).map((id) => {
      const c = state.characters[id];
      const loc = state.locations[c.status.location];
      const rel = c.relations[state.player] || 0;
      const mine = state.characters[state.player].relations[id] || 0;
      return `- ${id} (${c.name}${c.pronouns ? ', ' + c.pronouns : ''}), in ${loc ? loc.name : c.status.location}; wants ${c.want || '?'}; feels toward the player: ${E.relWord(rel)}; the player feels: ${E.relWord(mine)}` +
        (withSecrets && c.secret ? `; secret (guard ${c.guard || 'medium'}): ${c.secret}` : '');
    }).join('\n');
  }

  function majorIdeas(state) {
    const s = state.scenario.eventSeeds || {};
    return [].concat(state.scenario.majorSeeds || [], (s.regional || []).slice(0, 3), (s.world || []).slice(0, 3));
  }

  P.layouts.skipIntent = ['skipFrame', 'people', 'lastScene', 'skipTask'];
  P.skipIntent = (state, action, plan, frame, res) =>
    P.build('skipIntent', { state, pc: state.characters[state.player], action, plan, frame, res });

  B.skipFrame = ({ state, pc, action, frame }) => `=== DOWNTIME: ${frame.startTime} → ${frame.endTime} (about ${frame.days} days) ===
${pc.name} was in ${state.locations[frame.startLoc] ? state.locations[frame.startLoc].name : frame.startLoc} when it began.
${pc.name}'s plan for the downtime: "${action || 'keep to routine'}"
${worldLines(state)}`;
  B.people = ({ state }) => '\n=== PEOPLE (everyone, including private secrets; the player sees none of these secrets) ===\n' + crewBrief(state, true);
  B.skipTask = ({ state, pc, plan, res }) => {
    const ends = plan.reason === 'clock'
      ? `The downtime ends because a pressure comes to a head: "${res.events[res.events.length - 1] || plan.clock.name}". Set "major_event" to null; your positions should fit that moment.`
      : `The downtime ends with a MAJOR EVENT that you choose: something serious and unexpected that demands a response right now. It can be local (an accident, equipment failure, illness, a conflict boiling over, a secret coming out), regional, or world news that changes everything. Ideas: ${majorIdeas(state).join('; ')}.`;
    return `
=== TASK ===
This covers a long stretch of downtime. ${ends}
Reply with JSON only:
{"montage":[{"after":"2d","text":"one or two sentences"}],
 "events":[{"text":"one sentence","scope":"local|regional|world","who":["character_id"],"where":"location_id","visibility":"heard","moves":[],"effects":null}],
 "major_event":{"text":"one or two sentences","scope":"local|regional|world","who":["character_id"],"where":"location_id","effects":{"world":[{"key":"world_key","value":"new status"}],"groups":[{"id":"group_id","stance":"new stance"}],"clocks":[{"id":"clock_id","delta":2}],"new_clock":null}},
 "positions":[{"id":"character_id","where":"location_id","doing":"what they are doing when it hits"}],
 "player_where":"location_id"}
Guidelines:
- montage: 2 to 4 moments in order, spread across the downtime ("after" = time since it began, like "3d" or "10h"). How people pass the time, relationships shifting, small incidents, secrets being worked on. ${pc.name} follows their plan and their feelings.
- events: 0 to 2 newsworthy things during the downtime, with concrete effects for regional/world ones (use only existing ids/keys: world ${Object.keys(state.world).join(', ')}; groups ${(state.factions || []).map((f) => f.id).join(', ') || 'none'}; clocks ${state.clocks.filter((c) => !c.fired).map((c) => c.id).join(', ') || 'none'}).
- positions: one entry for EVERY other character: ${Eng().cast(state, { alive: true, includePlayer: false }).join(', ')}. Locations: ${Object.keys(state.locations).join(', ')}.
- player_where: where ${pc.name} is when it hits, consistent with their plan.`;
  };

  P.layouts.narrateSkip = ['downtimeFrame', 'status', 'lastScene', 'montage', 'alsoDuring', 'endsIt', 'whereEveryone', 'narrateSkipTask'];
  P.narrateSkip = function (state, action, frame, montage, doings, res, presentStart) {
    const pc = state.characters[state.player];
    const here = pc.status.location;
    const present = Eng().present(state, here);
    return P.build('narrateSkip', { state, pc, here, loc: state.locations[here], present, statusIds: present, action, frame, montage, doings, res });
  };

  B.downtimeFrame = ({ state, pc, here, loc, present, action, frame }) => `=== DOWNTIME FRAME ===
From ${frame.startTime} to ${frame.endTime} (about ${frame.days} days).
${pc.name}'s plan for the downtime: "${action || 'keep to routine'}"
When it ends, ${pc.name} is in ${loc ? loc.name : here} with ${present.length ? present.map((id) => name(state, id)).join(', ') : 'no one'}.
${worldLines(state)}`;
  B.montage = ({ montage }) => (montage.length ? '\n=== DURING THE DOWNTIME ===\n' + montage.map((m) => `- after ${m.after || '?'}: ${m.text}`).join('\n') : null);
  B.alsoDuring = ({ res }) => {
    const others = res.events.filter((e) => !/^\[major\]/.test(e));
    return others.length ? '\n=== ALSO DURING THE DOWNTIME ===\n' + others.map((e) => '- ' + e).join('\n') : null;
  };
  B.endsIt = ({ res }) => `\n=== WHAT ENDS IT ===\n${res.major ? res.major.text.replace(/^\[major\]\s*/, '') : '?'}`;
  B.whereEveryone = ({ state, doings }) => (doings.length
    ? '\n=== WHERE EVERYONE IS WHEN IT HITS ===\n' + doings.map((p) => `- ${name(state, p.id)}: in ${state.locations[state.characters[p.id].status.location].name}, ${p.doing}`).join('\n')
    : null);
  B.narrateSkipTask = ({ pc, loc, frame }) => {
    const useDays = frame.days >= 2;
    const endMark = useDays ? `[+${frame.days}d]` : `[+${Math.round(frame.days * 24)}h]`;
    return `
=== TASK ===
Write 3 or 4 beats in second person ("you" is ${pc.name}), 250–350 words in total. Start each beat on its own line with a time marker since the downtime began: ${useDays ? '[+0d], [+3d], [+8d]' : '[+0h], [+6h], [+15h]'} and so on.
1. The first beats are a brief montage of the downtime, a few sentences each: how the days pass, how people get along, the small things. ${pc.name} follows their plan and treats people according to the feelings in STATUS.
2. The final beat starts with ${endMark} and is a live scene in present tense: the thing that ends the downtime hits ${loc ? loc.name : 'where ' + pc.name + ' is'}, and the people there react in their own voices.
Hard rules:
- Use each character's pronouns exactly as given in STATUS.
- Do not reveal anyone's secrets unless the montage above says it came out.
- No big decisions for ${pc.name}. End the final beat on a moment that demands the player's response; the last paragraph is never ${pc.name}'s own line or action.
Reply with the beats only.`;
  };

  // ---------- update ----------
  P.layouts.update = ['validIds', 'whatHappened', 'sceneNarrated', 'updateTask'];
  P.update = (state, action, res, prose, present, cut) =>
    P.build('update', { state, sc: state.scenario, action, res, prose, present, cut });

  B.validIds = ({ state, sc, present }) => `=== VALID IDS ===
characters: ${Eng().cast(state).join(', ')}
locations: ${Object.keys(state.locations).join(', ')}
world keys: ${Object.keys(state.world).join(', ') || '(none)'}
groups: ${(state.factions || []).map((f) => f.id).join(', ') || '(none)'}
clocks: ${state.clocks.map((c) => c.id).join(', ') || '(none)'}
needs: ${sc.needs.map((n) => n.id).join(', ')}
present this turn: ${[state.player].concat(present).join(', ')}`;
  B.whatHappened = ({ state, action, res, cut }) => (cut
      ? '\n=== WHAT WAS PLANNED THIS TURN (the player stepped in partway: only what the scene below shows actually happened; moves, events and lines it does not show did NOT happen) ===\n'
      : '\n=== WHAT HAPPENED THIS TURN (full truth, including hidden actions) ===\n') + `Player action: "${action}"\n` + outcomeLines(state, res, false);
  B.sceneNarrated = ({ prose, cut }) => '\n=== SCENE AS NARRATED ===\n' + prose + (cut ? '\n\n[The player stepped in here. Anything planned above that is not in this scene did NOT happen; record only what is in the scene.]' : '');
  B.updateTask = ({ state }) => `
=== TASK ===
Record what changed this turn. Reply with JSON only, exactly in this shape:
{"facts":[{"about":["character_id"],"text":"one short sentence using names, not pronouns","known_by":["character_id"],"weight":2}],
 "state":[{"target":"char:character_id","field":"health","value":"ok|hurt|badly_hurt|dead"},
          {"target":"char:character_id","field":"location","value":"location_id"},
          {"target":"char:character_id","field":"add_condition","value":"short condition"},
          {"target":"char:character_id","field":"remove_condition","value":"existing condition"},
          {"target":"char:character_id","field":"need","need":"need_id","delta":-0.5},
          {"target":"world:key","value":"new short description"},
          {"target":"faction:group_id","value":"new short stance"},
          {"target":"clock:clock_id","delta":-2}],
 "relations":[{"from":"character_id","to":"character_id","delta":5,"reason":"short reason"}],
 "player_attitude":[{"to":"character_id","delta":-5,"reason":"short reason in past tense"}],
 "chapter_worthy":false}
Guidelines:
- 1 to 5 facts. Only things that actually happened or were revealed. Skip trivia.
- known_by lists who witnessed or was told. Use ["all"] only when everyone at the station/location would know. Hidden actions are known only by the actor and anyone who caught them.
- What ${name(state, state.player)} knows is limited to what they could see or hear in the narrated scene. Other characters' motives, plans and secrets are NOT known by ${name(state, state.player)} unless explicitly revealed; record those as known only by that character.
- weight: 1 minor detail, 2 notable, 3 major turning point (injury, death, betrayal, discovery, confession).
- Anything listed under REVEALS should become a fact known by the revealer and whoever was told.
- state: only real changes. Eating or resting lowers needs (negative delta). Repairs or sabotage can move clocks (negative delta delays, positive hastens). location: only for other characters who were seen leaving or arriving in the scene (where they went or came from). Never for ${name(state, state.player)}.
- groups: update a group's stance only when this turn's events would realistically change how that group sees things.
- world values are short factual status (e.g. "degraded, about 70% output"). Only change one when that status actually changed this turn.
- Conditions are physical or situational (e.g. "sprained ankle", "covered in dust"), not moods; stress and fear are needs.
- relations: how this turn changed how non-player characters feel about others (never ${name(state, state.player)}'s own feelings), delta between -15 and 15. Leave empty if nothing changed.
- player_attitude: how ${name(state, state.player)}'s own feelings toward someone shifted, judged ONLY from the player action as quoted above (their words and tone), never from how the narrator embellished it. Snapping, mocking or threatening lowers it; thanking, helping, joking warmly or confiding raises it. Delta between -10 and 10. Leave empty if the action was neutral.
- chapter_worthy: true only for a major turning point.
Use [] for any list with nothing to record.`;

  // ---------- chapter ----------
  P.layouts.chapter = ['chapterEvents', 'chapterTask'];
  P.chapter = (state) => P.build('chapter', { state, pc: state.characters[state.player] });

  B.chapterEvents = ({ state }) => {
    const facts = E.Memory.chapterFacts(state).map((f) => `- [T${f.turn}] ${f.text}`).join('\n') || '- (quiet stretch, little of note)';
    return `=== CHAPTER ${state.chapter} (turns ${state.chapterStartTurn}–${state.turn}) — EVENTS ===
${facts}`;
  };
  B.chapterTask = ({ pc }) => `
=== TASK ===
Write a short journal entry summarizing this chapter for ${pc.name}'s story. Use only the events listed. Third person, past tense, 2 to 4 sentences, keep names and the most important consequences. Also give the chapter a short evocative title.
Reply with JSON only: {"title":"...","summary":"..."}`;
})(typeof window !== 'undefined' ? window : globalThis);
