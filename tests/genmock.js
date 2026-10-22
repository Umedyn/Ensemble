// Model replies for every step of a generated start (task 4-2), for the
// engine tests, the prompt snapshots and the fake model servers. Written for
// Holdout at Harmon's (zombie-holdout).
// Good replies for every step, by the task in the prompt. over(step) can
// replace one (a function of the call, or a value).
const SHEETS = {
  'Lena Marsh': { pronouns: 'she/her', age: 52, traits: ['tired', 'generous'], want: 'keep the diner open for whoever comes', secret: 'She has been trading food to the Ridge people for fuel.', guard: 'medium', voice: 'Warm, clipped.', skills: { scavenging: 3, medicine: 9 }, room: 'Kitchen' },
  'Owen Pruitt': { pronouns: 'he/him', age: 34, traits: ['rigid', 'brave'], want: 'find the sheriff alive', secret: 'He ran from the clinic on the first night and left people behind.', guard: 'high', skills: { shooting: 3 }, room: 'counter' },
  'Kay Dunbar': { pronouns: 'she/her', age: 16, traits: ['restless'], want: 'get to her brother at the junction', secret: 'She was bitten on the hand two days ago and hides it in a glove.', guard: 'low', skills: { stealth: 3 }, room: 'nowhere' },
};
function replies(over = {}) {
  const base = {
    player: { name: 'Sam Whitlock', pronouns: 'he/him', age: 41, role: 'Long-haul trucker', traits: ['blunt'], want: 'get to the coast', secret: null, skills: { fighting: 4, shooting: 4, mechanics: 4 } },
    rooms: { rooms: [
      { id: 'counter', name: 'Diner Counter', desc: 'A long counter with stools bolted to the floor.', connects: ['kitchen'] },
      { id: 'kitchen', name: 'Kitchen', desc: 'Grease and a cold grill.', connects: ['Back Lot'] },
      { name: 'Back Lot', desc: 'Gravel, bins and a dead car.', connects: [] },
      { id: 'booths', name: 'Booths', desc: 'Torn vinyl booths by the windows.', connects: [] },
    ], player_room: 'counter' },
    plan: { people: [{ name: 'Lena Marsh', role: 'diner cook', hook: 'trades with the wrong people' }, { name: 'Owen Pruitt', role: 'sheriff\'s deputy', hook: 'ran once' }, { name: 'Kay Dunbar', role: 'runaway teenager', hook: 'hiding a bite' }] },
    person: (user) => SHEETS[/sheet for ([^,]+),/.exec(user)[1]],
    cast: { people: Object.entries(SHEETS).map(([name, s]) => Object.assign({ name }, s)) },
    ties: { relations: [{ from: 'Lena', to: 'owen-pruitt', value: 30 }, { from: 'kay-dunbar', to: 'player', value: 90 }, { from: 'player', to: 'Lena Marsh', value: 40 }, { from: 'nobody', to: 'kay-dunbar', value: 5 }],
      knows: [{ id: 'Owen Pruitt', text: 'The radio in the booths still picks up the convoy at night.' }], pressures: [{ name: 'The fuel runs out', max: 8, perHour: 0.1, fireText: 'The generator dies and the lights go out.' }] },
    extras: { extras: [{ name: 'Father Abel', role: 'priest on the radio', room: null, note: 'calls every night at nine' }], groups: [{ label: 'the dead', count: 'a dozen', room: 'back-lot', state: 'alert' }, { label: 'raiders', count: 3, room: 'roof' }] },
    opening: { title: 'Day 23: the diner', summary: 'You are a trucker sheltering in a highway diner.', facts: ['The town clinic burned on the first night.'],
      opening: 'Rain drums on the diner roof, steady and close. The coffee machine is dead, but Lena pours you a cup of cold tea anyway and slides it down the counter without a word.\n\nOwen stands by the window with his hat in his hands, watching the road like it owes him something.\n\nKay sits in the far booth, one gloved hand in her lap. "Are we staying here tonight?" she asks.' },
  };
  return Object.assign(base, over);
}
const STEP_OF = [
  ["THE PLAYER'S CHARACTER", 'player'], ['TASK: THE PLACE', 'rooms'], ['TASK: WHO IS HERE', 'plan'], ['TASK: WRITE ONE PERSON', 'person'],
  ['TASK: WRITE THE PEOPLE', 'cast'], ['TASK: TIES AND PRESSURES', 'ties'], ['TASK: MINOR PEOPLE AND GROUPS', 'extras'], ['TASK: THE OPENING', 'opening'],
];
const stepOf = (user) => (STEP_OF.find(([k]) => user.includes(k)) || [])[1];

module.exports = { SHEETS, replies, stepOf };
