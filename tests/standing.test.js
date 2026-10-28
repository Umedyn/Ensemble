// Faction standing and leading a faction (task G-6): who belongs to which
// group, how each group regards the player, how that reaches its people, its
// allies and its groups on watch, roles the story gives and takes, and orders.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, worldFiles, newGame, mockLLM } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const rel = (state, id) => state.characters[id].relations[state.player] || 0;

test('a new game starts with the world\'s standing, the start\'s and the slot\'s over it, and memberships tidied', () => {
  const { state } = newGame('occupied-france', 'roquette');
  assert.equal(state.reputation.resistance.value, 20);
  assert.equal(state.reputation.vichy.value, 0);
  assert.deepEqual(plain(state.characters.leroy.groups), [{ id: 'resistance', role: 'member' }]);
  assert.deepEqual(plain(state.characters.vidal ? state.characters.vidal.groups : null), null, 'Odette is in the Lyon start');
  const lyon = newGame('occupied-france', 'traboules').state;
  assert.deepEqual(plain(lyon.characters.rey.groups), [{ id: 'resistance', role: 'favored' }]);
  assert.deepEqual(plain(lyon.characters.vidal.groups.map((g) => g.id)), ['vichy', 'resistance']);
  // A world with no groups has no standing at all.
  assert.deepEqual(plain(newGame(require('path').join(__dirname, 'fixtures', 'slice-of-life')).state.reputation), { landlord: { value: 0, why: '', turn: 0 } });
});

test('word gets around: a change reaches every member\'s feelings, a share at most 5, and allies and enemies a quarter', () => {
  const { E, state } = newGame('occupied-france', 'roquette');
  const before = { ferrand: rel(state, 'ferrand'), brossard: rel(state, 'brossard') };
  const lines = E.Standing.change(state, 'resistance', 10, 'got the issue out under the police\'s noses');
  assert.equal(state.reputation.resistance.value, 30);
  assert.equal(state.reputation.resistance.why, 'got the issue out under the police\'s noses');
  assert.equal(rel(state, 'ferrand'), before.ferrand + 5, 'a member: half the change');
  assert.equal(rel(state, 'brossard'), before.brossard - 1, 'not a member, but one of Vichy\'s people: the enemy\'s -3, halved');
  assert.equal(state.reputation['free-french'].value, 5 + 3, 'an ally: a quarter, the same way');
  assert.equal(state.reputation.vichy.value, -3, 'an enemy: a quarter, the other way');
  assert.ok(lines.some((l) => /word gets around: Auguste Ferrand \+5/.test(l)));
  // Clamped: a turn's change is at most 10 unless the caller says otherwise.
  E.Standing.change(state, 'germany', -40, 'shot a sentry');
  assert.equal(state.reputation.germany.value, -13, "the -3 the Resistance's change spread to its enemy, then -10 at most");
});

test('the update step changes standing only with a reason and a group that could know', () => {
  const { E, state } = newGame('occupied-france', 'roquette');
  const upd = (reputation) => E.Engine.applyUpdate(state, { reputation }, E.Engine.present(state), { startLoc: 'shop', endLoc: 'shop', prose: 'x' });
  // Nobody from Vichy is in the shop; the Resistance's Nadine is.
  let r = upd([{ group: 'vichy', delta: -8, reason: 'hid the bundles' }, { group: 'resistance', delta: 30, reason: 'hid the bundles' }, { group: 'germany', delta: 5 }]);
  assert.ok(r.rejected.some((x) => /nobody from The French State \(Vichy\) saw it/.test(x)));
  assert.ok(r.rejected.some((x) => /needs a reason/.test(x)));
  assert.equal(state.reputation.vichy.value, -3, 'only the Resistance\'s spread, as its enemy');
  assert.equal(state.reputation.resistance.value, 30, 'clamped to 10 a turn');
  assert.ok(r.rejected.length === 2);
  // At most 10 a group in one turn's update.
  r = upd([{ group: 'resistance', delta: 6, reason: 'first' }, { group: 'resistance', delta: 6, reason: 'and again' }]);
  assert.equal(state.reputation.resistance.value, 40);
  r = upd([{ group: 'resistance', delta: 10, reason: 'once' }, { group: 'resistance', delta: 5, reason: 'twice' }]);
  assert.ok(r.rejected.some((x) => /already changed its mind this turn/.test(x)));
  // The watchers in the street are Vichy's: a scene there counts.
  r = E.Engine.applyUpdate(state, { reputation: [{ group: 'vichy', delta: -6, reason: 'stared down the watchers' }] }, [], { startLoc: 'street', endLoc: 'street', prose: 'x' });
  const v = state.reputation.vichy.value;
  r = E.Engine.applyUpdate(state, { reputation: [{ group: 'vichy', delta: -6, reason: 'stared down the watchers again' }] }, [], { startLoc: 'street', endLoc: 'street', prose: 'x' });
  assert.equal(state.reputation.vichy.value, v - 6);
  assert.ok(r.standing.some((l) => /The French State \(Vichy\): /.test(l)));
});

test('roles: the scene must show it and standing must allow it; events can set one outright; falling standing takes it away', () => {
  const { E, state } = newGame('zombie-holdout');
  const prose = 'Marlene hands you the radio. "The convoy says you speak for us now," she says, and nobody argues.';
  const give = (role, quote) => E.Engine.applyUpdate(state, { group_role: { group: 'convoy', role, quote } }, [], { prose });
  let r = give('favored', 'you speak for us now');
  assert.ok(r.rejected.some((x) => /doesn't think enough of Jordan Pike for that \(0; favored takes 40\)/.test(x)));
  state.reputation.convoy.value = 45;
  r = give('favored', 'words that are not there');
  assert.ok(r.rejected.some((x) => /quote isn't in the scene/.test(x)));
  give('favored', 'you speak for us now');
  assert.equal(E.Standing.roleOf(state, 'convoy'), 'favored');
  // An authored event: an election, whatever the standing.
  const res = { guards: [] };
  E.Engine.applyEffects(state, { group_role: [{ group: 'ridge', role: 'leader', reason: 'elected' }] }, 'regional', res, { authored: true });
  assert.equal(E.Standing.roleOf(state, 'ridge'), 'leader');
  // The model's own event can't: standing too low.
  E.Engine.applyEffects(state, { group_role: [{ group: 'convoy', role: 'leader' }] }, 'regional', res);
  assert.equal(E.Standing.roleOf(state, 'convoy'), 'favored');
  assert.ok(res.guards.some((g) => g.type === 'effect rejected' && /leader takes 60/.test(g.detail)));
  // A leader slipping is questioned (the reckoning), then loses it.
  state.reputation.ridge.value = 25;
  E.Standing.change(state, 'ridge', -10, 'lost the trucks');
  assert.ok(state.ignored.some((x) => /The Ridge question Jordan Pike's leadership/.test(x)));
  E.Standing.change(state, 'ridge', -10, 'lost the fuel', { turn: 2 });
  E.Standing.change(state, 'ridge', -10, 'ran', { turn: 3 });
  assert.equal(E.Standing.roleOf(state, 'ridge'), 'member', 'below 0: no longer the leader');
});

test('orders: a leader orders and the group answers with one event of its own; a member\'s orders are only words', () => {
  const { E, state } = newGame('zombie-holdout');
  const intent = (orders, events) => ({ player: { summary: 'x', needs_roll: false, orders }, intents: [], events });
  const answer = { text: 'The convoy turns two trucks toward Harmon\'s.', scope: 'regional', faction: 'convoy', visibility: 'heard', effects: { presence: [{ group: 'convoy', region: 'highway-strip', to: 0.3 }] } };
  let res = E.Engine.resolve(state, intent({ group: 'convoy', order: 'Send trucks to the store' }, [answer]), [], 'Tell the convoy to send trucks.', 'hour', {});
  assert.ok(res.guards.some((g) => g.type === 'orders refused' && /no say in Coastal rescue convoy \(not a member\)/.test(g.detail)));
  assert.ok(res.guards.some((g) => g.type === 'event dropped' && /no orders for convoy/.test(g.detail)));
  E.Standing.setRole(state, 'convoy', 'leader', 'test', { force: true });
  res = E.Engine.resolve(state, intent({ group: 'convoy', order: 'Send trucks to the store' }, [answer, Object.assign({}, answer, { text: 'A second answer.' })]), [], 'Tell the convoy to send trucks.', 'hour', {});
  assert.ok(res.guards.some((g) => g.type === 'orders' && /order "Send trucks to the store"/.test(g.detail)));
  assert.ok(res.guards.some((g) => g.type === 'orders answered'));
  assert.equal(state.presence.convoy['highway-strip'], 0.3, 'its effects apply, rationed as any event\'s');
  assert.ok(res.guards.some((g) => g.type === 'event dropped' && /A second answer/.test(g.detail)), 'one answer a turn');
});

test('the prompts: standing in the turn\'s message, orders only for a leader or favored player, memberships on the cast line', () => {
  const { E, state } = newGame('occupied-france', 'roquette');
  const header = E.Prompts.header(state);
  assert.match(header, /The player commands no faction unless "Standing with the groups" says they lead one/);
  assert.match(header, /- leroy: Nadine Leroy .*Belongs to: The Resistance\./);
  let user = E.Prompts.intent(state, E.Engine.present(state), 'Look around.', 'a few minutes', 'moment', {});
  assert.match(user, /\nStanding with the groups: The Resistance: friendly \(\+20\), you are a member/);
  assert.doesNotMatch(user, /"orders"/);
  E.Standing.setRole(state, 'resistance', 'favored', 'test', { force: true });
  user = E.Prompts.intent(state, E.Engine.present(state), 'Look around.', 'a few minutes', 'moment', {});
  assert.match(user, /you are favored: your requests carry weight/);
  assert.match(user, /"orders":null/);
  assert.match(user, /resistance \(Jeanne Vasseur is favored: a request\)/);
  const upd = E.Prompts.update(state, 'Look.', { outcomes: [], events: [] }, 'You look.', [], false);
  assert.match(upd, /"reputation":\[\{"group":"group_id"/);
  assert.match(upd, /"group_role":null/);
  // A world without groups keeps its old rule and has no standing line.
  const flat = newGame(require('path').join(__dirname, 'fixtures', 'droid-ship'));
  assert.match(flat.E.Prompts.header(flat.state), /The player commands no faction\.\n/);
  assert.doesNotMatch(flat.E.Prompts.intent(flat.state, [], 'Look.', 'a few minutes', 'moment', {}), /Standing with the groups/);
});

test('standing in conditions: routes and timeline events can test it and the player\'s role', () => {
  const { E, state } = newGame('zombie-holdout');
  const p = { reputation: { group: 'convoy', atLeast: 30 } };
  assert.equal(E.Timeline.holds(state, p), false);
  assert.equal(E.Timeline.say(state, p), 'standing with Coastal rescue convoy is 30 or more');
  state.reputation.convoy.value = 30;
  assert.equal(E.Timeline.holds(state, p), true);
  assert.equal(E.Timeline.holds(state, { role: { group: 'convoy', is: 'none' } }), true);
  assert.equal(E.Timeline.holds(state, { reputation: { group: 'ridge', below: 0 } }), false);
  assert.match(E.Timeline.preconditionProblems({ role: { group: 'convoy', is: 'boss' } }, 'x', {})[0], /"role" must be \{group, is: member\|favored\|leader\|none\}/);
});

test('a group that trusts the player lets them by; hostile standing puts its groups on watch', () => {
  const { E, state } = newGame('occupied-france', 'roquette');
  state.characters.vasseur.status.location = 'street';
  const sneak = () => E.Engine.standeeDC(state, { skill: 'stealth', moveTo: 'cafe', against: 'watchers' });
  const cold = sneak();
  state.reputation.vichy.value = 60;
  const warm = sneak();
  assert.ok(warm.mod < cold.mod, `${cold.mod} → ${warm.mod}`);
  assert.ok(warm.why.some((w) => /trust you/.test(w)));
  assert.deepEqual(plain(E.Engine.standeesNotice(state, { moveTo: 'cafe' })), [], 'a failed sneak doesn\'t make them wary');
  state.reputation.vichy.value = -45;
  E.Standing.change(state, 'vichy', -10, 'caught with leaflets');
  assert.equal(state.standees.watchers.state, 'alert');
});

test('validation in plain words, and older saves start neutral', () => {
  const E = loadEngine();
  const ids = new Set(['convoy']);
  assert.match(E.Standing.groupsProblems(['ridge'], ids, 'character "x"')[0], /"ridge" in "groups" isn't one of the world's groups/);
  assert.match(E.Standing.groupsProblems([{ id: 'convoy', role: 'boss' }], ids, 'x')[0], /role in convoy must be member, favored, leader/);
  assert.match(E.Standing.reputationProblems({ convoy: 200 }, ids, 'x')[0], /must be a number from -100 to 100/);
  const files = worldFiles('zombie-holdout');
  files['world.json'].factions[0].allies = ['nobody'];
  assert.match(E.Scenario.prepareWorld('zombie-holdout', files).starts[0].error, /"nobody" in "allies" isn't another of the world's groups/);
  assert.deepEqual([...readWorld('occupied-france').warnings], []);
  // A save from before standing.
  const { state } = newGame('zombie-holdout');
  delete state.reputation;
  state.version = 15;
  const up = E.Engine.migrate(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(plain(up.reputation), { convoy: { value: 0, why: '', turn: 0 }, ridge: { value: 0, why: '', turn: 0 } });
});

test('the creator: renaming a group follows memberships, standing, allies and conditions; removing one drops them', () => {
  const E = loadEngine();
  const files = worldFiles('occupied-france');
  files['world.json'].timeline.push({ id: 'test-ev', when: { day: 1200, hour: 9 }, scope: 'world', text: 'Something.', preconditions: [{ reputation: { group: 'resistance', atLeast: 10 } }], effects: { reputation: [{ group: 'resistance', delta: 5, reason: 'x' }] } });
  assert.equal(E.WorldEdit.renameGroup(files, 'resistance', 'underground'), '');
  assert.deepEqual(plain(files['characters/rey.json'].groups), [{ id: 'underground', role: 'favored' }]);
  assert.deepEqual(plain(files['characters/vidal.json'].groups), ['vichy', 'underground']);
  assert.equal(files['world.json'].reputation.underground, 20);
  assert.ok(files['world.json'].factions.find((f) => f.id === 'free-french').allies.includes('underground'));
  assert.deepEqual(plain(files['starts/roquette.json'].playerSlot.groups), ['underground']);
  const ev = files['world.json'].timeline.find((x) => x.id === 'test-ev');
  assert.equal(ev.preconditions[0].reputation.group, 'underground');
  assert.equal(ev.effects.reputation[0].group, 'underground');
  E.WorldEdit.removeGroup(files, 'underground');
  assert.equal(files['characters/ferrand.json'].groups, undefined);
  assert.equal(files['world.json'].reputation.underground, undefined);
  assert.equal(ev.preconditions, undefined);
  assert.equal(ev.effects, undefined);
});

test('the creator\'s groups field reads and writes memberships in plain text', () => {
  const E = loadEngine();
  const v = E.WorldEdit.parse('groups', 'resistance, vichy=favored, allies=member').value;
  assert.deepEqual(plain(v), ['resistance', { id: 'vichy', role: 'favored' }, 'allies']);
  assert.equal(E.WorldEdit.show('groups', v), 'resistance, vichy=favored, allies');
  assert.equal(E.WorldEdit.parse('groups', '  ').del, true);
});
