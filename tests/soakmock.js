// The soak's mock model (task B-9): a seeded stand-in for a modest local
// model. It reads the live game, so it uses real ids, moves people along real
// links and writes the events the engine asks for, and now and then it gets
// something wrong on purpose, so the guards have work to do. Unknown calls
// get the sample of their reply shape.
const genMock = require('./genmock');

// One seeded stream of numbers in [0, 1) (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPENERS = ['Dust turns in the light', 'A draught finds the back of your neck', 'Somewhere a door settles', 'The hum of the place rises and falls', 'Footsteps pass and fade', 'A cold cup sits forgotten', 'Someone laughs too loudly nearby', 'The light shifts along the wall', 'A chair scrapes on the floor', 'Rain ticks at the edge of hearing', 'Paper rustles at the far end', 'A distant engine coughs and dies'];
const AFTERS = ['nobody remarks on it', 'and the talk moves on', 'which suits you well enough', 'and you let it pass', 'though it hardly matters', 'and the moment goes', 'as if nothing were different', 'and you keep your thoughts to yourself', 'while the hours go on working', 'and the quiet comes back'];
const DOINGS = ['checks the stores again', 'goes over an old list', 'mends something small', 'keeps busy near the door', 'looks for a moment alone', 'talks quietly with no one in particular', 'watches the others', 'works without looking up'];
const HAPPENINGS = ['A shipment comes up short', 'A message arrives garbled', 'An old argument starts up again', 'A stranger is seen near the edge of town', 'Something small goes missing', 'A rumour goes around at supper', 'A repair turns out worse than it looked', 'A neighbour asks for a favour', 'Bad news comes from up the road', 'A long-delayed reply finally comes'];
const WHENS = ['before noon', 'after dark', 'without warning', 'for the second time', 'at the worst moment', 'late in the shift', 'to everyone\'s surprise', 'with little fuss'];
const MOODS = ['quiet and watchful', 'short with everyone', 'easier than yesterday', 'tired but steady', 'distracted, eyes elsewhere', 'brisk and busy', 'wound tight', 'almost cheerful'];

function createMock(E, game, seed, opts = {}) {
  const rand = seeded(seed);
  const errorRate = opts.errorRate ?? 0.06;
  let n = 0;
  const chance = (p) => rand() < p;
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const line = (a, b) => `${pick(a)}, ${pick(b)}`;
  const Eng = E.Engine;
  const props = (shape) => (shape && shape.t === 'obj' ? shape.props : {});
  const tupleIds = (node) => (node && node.items ? node.items.map((x) => x.props.id.v) : []);
  const only = (obj, shape) => {
    if (!shape) return obj;
    return Object.fromEntries(Object.entries(obj).filter(([k]) => props(shape)[k]));
  };
  const here = () => game.state.characters[game.state.player].status.location;
  const exitFrom = (loc) => {
    const out = Eng.linkedRooms(game.state, loc);
    return out.length ? pick(out) : null;
  };
  const stance = () => {
    const f = game.state.factions || [];
    return f.length ? { groups: [{ id: pick(f).id, stance: `${pick(MOODS)}, watching events` }] } : null;
  };

  function intent(user, shape) {
    const state = game.state;
    const plan = game.plan || {};
    const p = props(shape);
    const player = { summary: plan.summary || 'look around', needs_roll: !!plan.roll, skill: plan.roll ? pick(state.scenario.skills) : null, difficulty: pick(['easy', 'normal', 'hard']), move_to: plan.moveTo || null };
    const fields = p.player ? props(p.player) : {};
    if (fields.crisis_answered) player.crisis_answered = plan.mode !== 'passive' && plan.mode !== 'skip';
    const intents = tupleIds(p.intents).map((id) => {
      const c = state.characters[id];
      const move = c && chance(0.2) ? exitFrom(c.status.location) : null;
      return { id, action: `${c ? c.name : id} ${pick(DOINGS)}.`, says: chance(0.3) ? pick(['Not now.', 'Later, maybe.', 'I saw it too.', 'Leave it with me.']) : null, reveals: null, visible: chance(0.9), needs_roll: false, skill: null, difficulty: 'normal',
        move_to: chance(errorRate) ? 'no-such-room' : move };
    });
    const events = [];
    // Numbered, so only the engine or a world's own text can repeat an event.
    const ev = (scope) => ({ text: `Report ${++n}: ${line(HAPPENINGS, WHENS)}.`, scope, who: [], where: here(), visibility: 'heard', moves: [] });
    if (p.events) {
      if (chance(0.2)) events.push(ev('local'));
      if (user.includes('A REGIONAL event is due')) events.push(Object.assign(ev('regional'), { effects: stance() }));
      if (user.includes('A WORLD event is due')) events.push(Object.assign(ev('world'), { effects: chance(0.2) ? { new_clock: { name: `Trouble ${++n}`, max: 8, perHour: 0.1, fireText: `${line(HAPPENINGS, WHENS)}.` } } : stance() }));
      Eng.agendasDue(state).forEach((id) => events.push(Object.assign(ev('local'), { who: [id], visibility: 'hidden', agenda: id })));
    }
    return only({ player,
      intents,
      group_intents: tupleIds(p.group_intents).map((id) => ({ id, action: 'holds where it is', visible: true, move_to: null })),
      events,
      canon: tupleIds(p.canon).map((id) => ({ id, text: 'It happens as everyone feared.', effects: null })),
    }, shape);
  }

  function update(shape) {
    const state = game.state;
    const pl = state.player;
    const people = Eng.present(state).filter((id) => state.characters[id]);
    const facts = [], changes = [], relations = [], attitude = [];
    if (chance(0.5)) facts.push({ about: people.length ? [pick(people)] : [pl], text: `${line(HAPPENINGS, WHENS)}.`, known_by: chance(0.5) ? ['all'] : [pl].concat(people), weight: pick([1, 1, 2, 2, 3]) });
    people.forEach((id) => {
      if (chance(0.2)) changes.push({ target: `char:${id}`, field: 'mood', value: pick(MOODS), reason: 'the day so far' });
      if (chance(0.1)) changes.push({ target: `char:${id}`, field: 'add_tag', value: pick(['ink on the cuffs', 'hoarse', 'favouring one knee']), turns: 6, reason: 'the day so far' });
      if (chance(0.25)) relations.push({ from: id, to: pick([pl].concat(people)), delta: Math.round(rand() * 8 - 4), reason: 'how the day went' });
    });
    if (people.length && chance(0.15)) attitude.push({ to: pick(people), delta: 2, reason: 'a kind word' });
    (state.scenario.needs || []).forEach((need) => {
      people.forEach((id) => { if (chance(0.1)) changes.push({ target: `char:${id}`, field: 'need', need: need.id, delta: -0.2 }); });
    });
    // The player's own rest counts, as it would from a model reading the scene.
    if (/Eat|Sleep|rest/.test((game.plan || {}).action || '')) (state.scenario.needs || []).forEach((need) => { if (state.characters[pl].needs[need.id] != null) changes.push({ target: `char:${pl}`, field: 'need', need: need.id, delta: -0.5 }); });
    // A detail in the scene's own words, as a model reading it would file one.
    const details = [];
    const said = ((state.recent || []).slice(-1)[0] || {}).text || '';
    const sentence = (said.match(/[A-Z][^.!?\n]{20,120}[.!?]/) || [])[0];
    if (sentence && state.turn % 3 === 0) details.push({ about: people.slice(0, 1), text: sentence });
    if (chance(errorRate)) facts.push({ about: ['nobody-at-all'], text: 'A person who does not exist did something.', known_by: ['nobody-at-all'], weight: 2 });
    if (chance(errorRate) && people.length) relations.push({ from: people[0], to: 'nobody-at-all', delta: 99, reason: 'a slip' });
    return only({ facts, details, state: changes, relations, player_attitude: attitude, reputation: [], group_role: null, new_extras: [] }, shape);
  }

  function skip(shape) {
    const state = game.state;
    const p = props(shape);
    const out = { montage: [{ after: '1d', text: `${line(OPENERS, AFTERS)}.` }, { after: '2d', text: `${line(OPENERS, AFTERS)}.` }], events: [], major_event: null, positions: [], player_where: here() };
    const live = Eng.cast(state, { alive: true, includePlayer: false }).filter((id) => Eng.linkedRooms(state, state.characters[id].status.location).length);
    for (let i = 0; i < 2 && live.length; i++) {
      const id = pick(live);
      if (!out.positions.some((x) => x.id === id)) out.positions.push({ id, where: exitFrom(state.characters[id].status.location), doing: pick(DOINGS) });
    }
    if (p.crisis) out.crisis = { outcome: 'It plays out without much fuss, and costs less than it might have.', harm: [] };
    if (p.reckoning) out.reckoning = 'They want to know where you have been.';
    const alt = p.major_event && p.major_event.alts && p.major_event.alts[0];
    if (alt) {
      out.major_event = { text: `Report ${++n}: ${line(HAPPENINGS, WHENS)}.`, scope: 'local', who: [], where: here(), effects: null };
      if (props(alt).harm) out.major_event.harm = chance(0.15) ? [{ id: state.player, health: 'hurt' }] : [];
    }
    return only(out, shape);
  }

  function narrate(frame, user) {
    const step = (game.plan || {}).step;
    const span = { minute: 1, moment: 15, hour: 60, hours: 180 }[step] || 60;
    const p = () => `${line(OPENERS, AFTERS)}, day ${++n}. ${line(HAPPENINGS, WHENS)}, and hour ${++n} goes by.`;
    if (frame) return `[+0d] ${p()}\n\n[+1d] ${p()}\n\n[+2d] ${p()}`;
    // Plays what RESOLVED says, as a model should, so the scene check (task L-4)
    // doesn't rewrite every one-beat turn and shift the seeded dice.
    const done = String(user || '').match(/=== PLAYER ACTION[^\n]*\n"([^\n]*)"/);
    const resolved = (String(user || '').match(/=== RESOLVED[^\n]*\n([\s\S]*?)\n\n=== /) || [])[1] || '';
    const played = `${done ? `You ${done[1]} ` : ''}${resolved.replace(/\s+/g, ' ').replace(/[[\]]/g, '')}`.trim();
    return `[+0m] ${played} ${p()}\n\n[+${Math.round(span / 2)}m] ${p()}\n\n[+${Math.max(1, span - 5)}m] ${p()}`;
  }

  // ({ kind, user }) → the reply's text.
  return function reply({ kind, user }) {
    const gen = genMock.stepOf(user);
    if (gen) {
      const v = (game.genReplies || genMock.replies())[gen];
      return JSON.stringify(typeof v === 'function' ? v(user) : v);
    }
    const shape = E.Prompts.shapeFor(user);
    if (user.includes(' an agenda: what ')) return JSON.stringify({ routine: true });
    if (/^intent/.test(kind)) return JSON.stringify(intent(user, shape));
    if (/^update/.test(kind)) return JSON.stringify(update(shape));
    if (user.includes('=== DOWNTIME:')) return JSON.stringify(skip(shape));
    if (user.includes('=== DOWNTIME FRAME ===')) return narrate(true);
    if (/^narrate/.test(kind)) return narrate(false, user);
    if (kind === 'chapter') return JSON.stringify({ title: `Chapter ${++n}`, summary: `${line(OPENERS, AFTERS)}. ${line(HAPPENINGS, WHENS)}.` });
    if (user.includes('=== PLANNING AHEAD:')) {
      const m = /"when":\{"day":(\d+)/.exec(user);
      return JSON.stringify({ events: m ? [{ when: { day: Number(m[1]), hour: 10 }, scope: 'world', region: null, text: `${line(HAPPENINGS, WHENS)}.`, visibility: 'heard', effects: null }] : [] });
    }
    if (user.includes('has come to matter in the story')) {
      return JSON.stringify({ pronouns: 'they/them', age: 40, traits: ['calm', 'tired'], want: 'get through the week', secret: null, voice: 'Plain and slow.', appearance: 'Nothing you would remember.', skills: {}, relations: {} });
    }
    return shape ? E.Shape.sample(shape) : '{}';
  };
}

module.exports = { createMock, seeded };
