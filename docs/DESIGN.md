# Ensemble design

How the engine works and why it works that way. Most of the "why" comes from playtesting with a local 12B model; the decision log at the end records what went wrong and what fixed it.

## What it is

Pax Historia is AI-driven grand strategy: you play a nation, and other nations react. Ensemble keeps Pax's loop (state an action, time passes, the world responds, events happen) but at personal scale. You are one person in a group, and everyone else is an individual with wants, needs, secrets, guarded knowledge and feelings about each other. Groups and factions still exist (Mission Control, a corporate sponsor, a rescue convoy) and act collectively; the story shows how individual choices ripple out to them and how their moves land on people.

It sits between SillyTavern (rich characters, but the model holds all the state) and Pax (rich world state, but no one to know). The distinguishing features are an engine that owns the facts, secrets with owners, and a world that keeps moving on its own.

It is local-first: KoboldCpp on your own GPU by default, with OpenAI-compatible APIs (e.g. OpenRouter) as a first-class option for people without a GPU or on phones.

## Core principle: the engine owns facts, the model proposes

The model is used for judgment and prose. Everything that must stay true (where people are, who knows what, health, needs, relationships, time, clocks) lives in a JSON state that only the engine changes, after validating what the model proposed. This is what keeps a long story consistent with a small model, and it's why most fixes in the decision log are engine-side guards rather than prompt wording.

## Content principles

Ensemble doesn't police content beyond what the law requires or what a service it depends on requires. Adults choose their own stories, and tasteful 18+ roleplay is a supported use. Mature content is opt-in: a world declares a rating, the player sets a maximum, and the lower of the two selects the narrator's guidance.

One hard line holds in every mode: no sexual content involving minors. When mature content is on and anyone in the scene is under 18 or has no age set, the engine forces fade-to-black guidance and drops romantic or sexual intents involving them. This belongs in the engine, not the prompt or the provider: inference engines like KoboldCpp and llama.cpp don't filter anything and don't know who is in a scene. Ensemble does, because it owns the cast and the scene. (Planned: ROADMAP › Content settings.)

## State

`Engine.newGame(scenario)` builds:

- `characters[id]`: sheet (name, pronouns, role, traits, want, secret, guard, voice, skills), `needs` (0–1), `status` (health, location), `tags` ([{text, set, until, reason}]), `mood` ({text, turn, reason}; non-player only), `relations[otherId]` (−100..100: how this person feels about the other), `tier` (`local` | `secondary`), `pinned`, `lastSeen` (turn), `agenda` (`{goal, steps: [{text, contact}], hours, visibility, step, progress, due, done, followUp}`, or `null` for routine; non-player only), and for the player `attitudeNotes` (latest reason per person)
- `locations`, `world` (key → short status), `factions` (name, desc, stance), `clocks` (pressures with `value/max/perHour`, `fireText`, `fireWorld`, follow-up `then` clocks)
- `facts[]`: `{ text, about[], known_by[] | ['all'], weight 1–3, turn, chapter }`
- `chapters[]`, `recent` (last scene), `log` (display only), `news`, `pending` (the last turn awaiting memory), `undo` (the whole state from before the last action), `tierLast` (when regional/world events last happened)

## The turn

0. **Promote for the action** (`promoteForAction`, before the turn's start snapshot): the people present and anyone the action names become local.
1. **Commit the previous turn** (`commitPending`). Run the update step on the scene as it actually played out, then update cast tiers (`updateTiers`). If the player stepped in after beat *k*, first rebuild the turn from its starting snapshot: re-apply the player's own move, advance time to the midpoint between beat *k* and *k+1*, and give the update step only beats 1..*k*. Then close a chapter if due.
2. **Roll event tiers** (`tiersDue`): are a regional and/or world event due, given elapsed time, scenario rates and cooldowns?
3. **Intent call** (model): judge the player's action (roll needed? skill, difficulty, move); one intent per present character (action, says, reveals, visibility, move); events for the span (local, plus regional/world only if due, with effects). Sees secrets and private knowledge of present characters, a brief (want, secret) of offstage local characters, and one line (role, place, want) per secondary character.
4. **Resolve** (engine): cancel moves away from the person the action names (unless the player states the move or names someone at the destination); gate reveals by guard; detect leaks; roll d20 + 2×skill vs 8/12/16 with injury and exhaustion penalties; apply moves; apply events and their effects; hidden events become private facts.
5. **Advance time**: needs tick (or settle, for downtime), clocks advance and may fire (adding follow-up clocks).
6. **Narrate call** (model): a scene frame (starts where/with whom, ends where, who left or arrived), status with pronouns, the player's attitude toward those present, resolved outcomes (covert ones only as "out of sight"), and beat instructions. The narrator never sees secrets.
7. **Clean the prose**: drop repeated paragraphs, cut back to the last full sentence, drop trailing paragraphs that are the player's own action, regenerate once if it walks the player into another room.
7b. **Fill a short scene, then settle the clock** (about an hour, a few hours only): if the last beat is before half the step, one continuation call asks for 1–2 closing beats (same cleanup; dropped if it relocates the player). Then time is wound back to the last beat plus 10% of the step, unless a pressure clock fired during the step. The other steps keep their full span.
8. **Store as pending** with beats, the starting snapshot, everything the update step will need, and `narration` (the turn's system prompt, step, and the time state before and after the step) for Reroll.

A normal turn is three model calls (intent, narrate, update), plus an occasional chapter summary or narration retry.

**Suggested actions** (`Eng.suggestActions`, outside the turn): one call with the shared header and a user message of the narrator-side `now` block (no secrets, no one else's feelings), the scene up to the player's step-in point, and the player character's own `want`. The engine keeps at most 4 short distinct strings (`cleanSuggestions`) and changes no state; the page shows them as buttons that fill the action box. It routes with the intent step (`LLM.ROUTE_AS`), and isn't recorded, since it never changes the game.

**Undo and reroll** (playtest tools). `runTurn` clones the whole state before step 1; when the turn succeeds the clone (minus its own `undo`) becomes `state.undo`, so there is one level of undo. Undo swaps it back in: facts, time, clocks, rolls, any chapter the commit closed, and the previous scene pending again with all its beats (a step-in is undone too; the page re-selects it). Reroll works only on the pending turn: it puts `recent` and time/needs/clock values back to just after step 5 and re-runs steps 6–7b with the stored system prompt, so rolls, moves, events and clocks stay and only the prose, beats and settled time change. Save files leave `undo` out; the autosave keeps it.

## Prompts and the cache

`system` is identical for every call in a turn: setting, genre guidance, rules, locations, groups, cast (public sheet with pronouns), chapter summaries, and player-known facts. It only grows at the end between turns, so KoboldCpp reuses most of it (in logs, 1,800 tokens processed for the first call and only ~600–1,000 for the next two). Anything that changes per call (status, needs, relations, clocks, secrets, the scene, the task) goes in `user`. That includes how people look: the narrator's status lines carry the first sentence of `appearance` for the people in the scene only, so a cast of twenty doesn't grow every prompt.

**Blocks.** Every prompt is an ordered list of named blocks: `P.layouts.<prompt>` lists block ids, `P.blocks.<id>` builds one from the prompt's context (text, a list of lines, or `null` to leave it out), and `P.build` joins them. A new section (genre guidance, lore, regions) is one block function plus one position in a layout. In the header, only the blocks in `P.LIVE_HEADER` (`newcomers`, `chapters`, `facts`) may change during play, and they stay last (`newcomers` lists people promoted from extras, so the static cast block never changes); a test enforces this, and `tests/prompts.snapshot.test.js` pins every prompt byte for byte.

**Genre.** The `genre` block (after the setting) comes from the world's `tags` and `toneNote` through `js/genres.js`: one tone line per known tag, then what a major event means and how lethal danger is, both from the first known tag (tags are listed most important first, so `cozy, horror` is gentle dread and `horror, cozy` is lethal with warm moments). Freeform tags are named as written; a world with no tags and no tone note gets no block. It is static for a game, so it never disturbs the cache.

**Telemetry.** Each turn (and each reroll) leaves a report in `Engine.telemetry` (the last 20, in memory only): every model call with tokens in and out (from the reply's `usage`, or an estimate marked `~`), wall time, retries and salvage, plus the guards that fired. KoboldCpp doesn't report how much of the prompt it reused, so for KoboldCpp backends the report shows prompt processing time from `/api/extra/perf` after each call: a reused prefix processes in a fraction of the time. Providers that report `prompt_tokens_details.cached_tokens` get a cached column. Debug shows the reports as tables, and "Copy turn report" gives plain text for pasting into a chat.

**Recordings.** Debug › Record starts `E.Recorder` (`js/recorder.js`): from a copy of the state, it wraps `E.rng` and `LLM.transport` and keeps, per action (turn, reroll, undo, marked by the engine), every random number drawn and every model request and reply. The export is a replay fixture (`tests/fixtures/README.md`); `tests/replay.js` plays it back with the same dice and replies and fails on any different call. No keys or URLs are recorded.

**Guards.** Whenever the engine overrules or cleans up the model it records `{ stage, type, detail }` in the turn's `res.guards`: `move cancelled`, `reveal blocked`, `leak deflected`, `event dropped` (resolve); `agenda step` (resolve); `id tag replaced`, `speaker label removed`, `retold last scene`, `cut to last sentence` (a line of dialogue it stops in is closed), `repeated paragraph removed`, `player ending trimmed`, `relocation regenerated`, `continuation dropped` (scene; Reroll replaces these); `update rejected`, `update failed`, `cast tier`, `agenda set`, `agenda rejected` (memory, recorded at the next turn's commit and reported with that turn, tagged with the scene's turn). New guards should call `guard()` in `engine.js` so they show up in reports.

Budgets scale with `E.memoryContext()`: the smallest context among the backends routing uses, capped by `memoryCap` (default 32K). Facts ~20%, chapter summaries ~12%. Weight-3 facts are always kept; minor ones go first.

## Cast tiers

Task 2-1. Every non-player character is **local** or **secondary**; the player is always local.

- **Local**: the full simulation. Present locals get an intent; offstage locals get the OFFSTAGE brief (where, want, secret) in the intent call. Needs tick at the world's rates.
- **Secondary**: in the background. No intent, one line in the intent call's BACKGROUND block (`id (Name, role), in Place: wants …`, want cut to 60 characters, never the secret), so adding people adds one short line each and richer sheets add nothing. Needs settle as in downtime routine. Events can still move them and give them private facts.
- **Start**: authored `tier` or `pinned` on the cast entry, else local when in the player's starting room.
- **Promotion** (engine only): present at the start of a turn or named in the player's action (`mentions`, before the intent call and before the turn's snapshot, so a step-in keeps it); at commit, anyone in the player's room after the update step and anyone in a seen or heard event (none after a step-in: the event may not have reached the player; hidden events never). Each also sets `lastSeen`.
- **Demotion** at commit: non-pinned offstage locals with `turn − lastSeen ≥ demoteAfter` (default 4); then, if more than `maxLocal` (default 6) locals are away from the player, the longest-unseen non-pinned ones. Settings: the world's `tiers`, over `Eng.TIERS`.
- **Cache**: the header's cast block lists everyone the same way whatever their tier, so a tier change never disturbs the cached prefix; all tier-dependent detail is in the intent user message. The downtime skip still briefs everyone (its positions need the whole cast).
- **Debug**: every change is a `cast tier` guard (resolve stage for promotions before the intent call, memory stage at commit), and the characters view shows each tier, pin and `lastSeen`. The sidebar lists you, the people with you and other locals, then secondary people in a collapsed **Elsewhere** list.
- `Eng.cast(state, { tier })` filters by tier; `Eng.tier(state, id)` reads one.

## Agendas

Task 2-2. A non-player character's own goal, as 1–5 steps at a pace (`hours` per step). `null`, or a goal like "keep routine" with no steps, is routine: nothing fires.

- **Advancing** (engine only, like clocks): during turns, `advanceTime` moves only **secondary** characters' agendas (`progress += hours / agenda.hours`); local ones pause, because they act through intents. A step reaching 1 is **due** and waits there until it is written. The time snapshots that wind a short scene's clock back (and Reroll) carry agendas too.
- **Due steps become events**: the next intent call's user message lists them under AGENDA STEPS DUE, each asking for one event tagged `"agenda": id` (outside the local event cap). `applyAgendaEvents` takes the first tagged event per due step, drops others (`event dropped`), and writes the step itself ("Sorensen runs a second culture…") when the model left it out. A `hidden` agenda's event is always hidden (a private fact for that person); a `heard` one is heard (or seen in the player's room). A **contact** step moves the person into the player's room and is seen; the commit's tier update then makes them local. Every completed step is an `agenda step` guard. A step-in rewinds the turn, so the step is due again and is written the next turn.
- **Context**: the step someone is on appears only in the intent call (PRIVATE for present people, the OFFSTAGE brief, `now:` on a background line, cut to 50 characters), never in the header or the narrator's prompt.
- **Proposals**: at commit, the first living secondary character with no `agenda` field at all (or a finished agenda that hasn't had its follow-up) gets one `intent (agenda)` call: their role, traits, want, secret and a few private facts in the user message, asking for `{goal, steps (2–4), hours, contact_step}` or `{"routine": true}`. One call per turn at most. `cleanAgenda(raw, true)` validates it (hours clamped to 2–72, proposals always hidden); anything invalid, or a failed call, is routine (`agenda rejected`), and a good one is `agenda set`. A follow-up is offered once, then the person settles into routine. Saves from before 2-2 load with `agenda: null`, so they never start proposal calls.
- **Downtime**: see below. Debug's characters view shows each agenda's goal, step, progress and whether it is due.

## Extras

Task 2-3. Minor people kept as stubs in `state.extras` (`{id, name, role, pronouns, location|null, note}`; groups are standees since task 3-2), outside `state.order`, so the cast helpers, tiers, cards and needs never see them.

- **Prompts**: never the header. The intent call lists the ones with the player (with their notes) and the rest on one line (ids, so events can use them); the `now` block and the narrator's frame give name and role only, never the note; the update step's valid ids list them. The scene bar shows who is with you.
- **Events and facts**: event `who` and `moves` may use extras; facts may be `about` them or `known_by` the ones present (`ctx.extrasPresent`). The update step may move an extra under the same "seen in the scene" rule; moods, tags, needs, relations and `player_attitude` toward them are rejected.
- **New ones**: only when the world sets `inventExtras`. The intent and update replies may carry `new_extras` (`{name, role, location, group}`); `Eng.proposeExtra` allows one a turn and 30 in all, makes the id, and treats a name already in use as that person (`extra added` / `extra rejected`). A proposed group becomes a standee in a room.
- **Promotion**: an individual named in the player's action on two different turns, or `about` a fact of weight 2+, is due. At commit, at most once a turn, a `worldbuild` call (its own routing step, "World building"; Hybrid sends it external) gets the stub, every fact about them and the last two scenes that mention them (so the sheet matches how they were shown), and returns a sheet. `Eng.characterFromExtra` keeps the id, name and place, clamps skills (0–4) and relations (±30, cast ids only), defaults the guard, validates any agenda, and runs `Scenario.characterProblems` (the same checks as character files). They join the cast as local with `joined: turn`, listed in the header's `newcomers` block. A bad sheet or failed call leaves them an extra (`promotion rejected`), with one retry.
- **Bundled**: Ares Deep has Dana Ruiz (CAPCOM, a voice in Ops) and no invented extras; the holdout has Mrs. Albee and allows invented ones.

## Standees

Task 3-2. Unnamed groups (guards, a gang, the dead) as one entity in `state.standees`: `{id, label, count, location, state, faction, post, patrol, patrolHours, note}`. Groups exist only on the local map: a group that is wiped out (count 0) or flees leaves the map and is folded back into its faction (Debug says so). `Eng.tokens(state, loc)` lists every token on a room (the player and living characters, then extras, then standees) for the map view and prompts.

- **Prompts**: never the header. The `now` block says "Unnamed groups here" (label, count, state); the intent call has an UNNAMED GROUPS block with ids and notes for the ones here and one line for the rest; the narrator's frame lists the groups around as "exactly these, no more", and gets one outcome line per group plus a `CHANGED:` line for everything the engine changed. The update step lists them with the three fields it may change.
- **Engaged groups** (`Eng.engagedStandees`): the groups in the player's room, plus groups in a linked room that the player's own words name ("sneak past the stragglers" from the dock). Only they get intents, can be a roll's target, and can have their state or room changed by the update step from outside the scene's rooms (`res.engaged`, passed to the commit). The narrator's frame lists them too.
- **Group intents**: the intent reply's `group_intents` holds one entry per engaged group (`{id, action, visible, move_to}`). Unknown, absent, repeated or `down` groups are dropped (`standee rejected`). Every group move, whether from an intent, an event or the update step, is one linked step (`connects`, either direction), and a group on a `post` holds it unless hostile (`standee move`).
- **Rolls**: the player's intent may set `against` (an engaged group that can resist). An action that sneaks ("sneak", "creep", "keep low", "slip past"…) with an able group in the player's room or a linked room always rolls stealth, normal difficulty, when the model asked for no roll (`roll required`). The DC rises by state (calm 0, alert +2, hostile +4) plus size (2–3 +1, 4–7 +2, 8–19 +3, 20+ +4). A stealth roll (`Eng.STEALTH_SKILLS`) in a world with groups also counts who could notice: each alert or hostile group in the player's room, a linked room or the destination adds +2 (at most +4); nobody on the route gives −2. The reason shows in the roll line and as a `difficulty` guard.
- **Failed stealth**: the nearest group that could notice gets warier (calm → alert → hostile); one that turns hostile next door and holds no post comes into the player's room. Each change is a `noticed` guard and a `CHANGED:` line for the narrator.
- **Update step**: `standee:<id>` with `count` (a delta; it only rises when one of this turn's events lists the group in `who`, then by at most half again), `state` (seen in the scene; `fled` removes the group) and `location` (one linked step, seen leaving).
- **Patrols** move one room an in-game hour, round the loop, while calm or alert (`advanceTime`, skips included).
- **Singling one out**: the player's intent may set `single_out: {standee, name, role}`. It is accepted only when the player's own words name the group (a word of its label), so the model can't decide it for them. The count drops by one and an individual extra (`from: 'standee'`) stands in the same room; the usual promotion path can make them a character. The last one singled out ends the group.
- **Bundled**: the holdout has `stragglers` (5 dead, calm) in the parking lot. Ares Deep has no crowds.

## Local map

Task 3-3. The model describes, the engine draws. `js/layouts.js` (DOM-free) turns the rooms into rectangles on a grid: `Layouts.plan(locations, {type, seed})` places each level breadth-first from a hub (the biggest room for `hall`, a long corridor for `corridor`, the best-linked room for `generic`), preferring spots that share a wall with every placed room it links to, and gives each link its spot on the shared wall (or `remote`: a dashed line on the same level, a "↕ hatch to …" note across levels). Levels stack top to bottom, ground floor first. It is seeded by the world and start, never random, and uses only authored data, so it is the same every time, survives saves without being stored, and never moves when people do.

- **What the player knows**: `state.seenRooms` (authored rooms start seen unless `seen: false`; entering a room, or standing next to it through an `open` link, reveals it) and `state.known[id] = {loc, turn}`, where the player last saw each character, extra and group. `Eng.noteSeen` updates both after a turn is played and again at commit (a step-in rewinds to the turn's start first): everyone in the player's room, visible moves (`outcomes`, `groups`), seen or heard events, groups in view, and people the update step moved who were in the scene. Covert moves and hidden events never update it. `Eng.knownWhere` returns `{loc, turn, now}`.
- **The cards follow the same rule**: a card says where you last saw someone ("last seen in the Office (turn 3)"), never where they really are.
- **The view**: plain SVG in theme colours. Rooms with walls, labels, features and a mark per link kind; unseen rooms dark with "?"; tokens (portraits or monograms, a counted badge for a group in its state's colour, a ring for you), faded for anyone not in view. A text list of rooms and who is known to be there is there for screen readers. Clicking a room fills in "Go to the …", a person "Talk to …", a group "Watch the …"; nothing is sent. A start's `localMap` draws its image with room hotspots instead.
- **Layout**: on desktop the story area switches between Text, Split (story and map side by side, the default) and Map, remembered per world. On a phone the 🗺 button swaps the story for the map.

**World and regional views** (task 3-4). In worlds with regions the Map pane has a Local / Region / World switch (remembered per world). The world view draws the world's `map` image with a polygon or point per region (`Layouts.regionAnchors` places labels, and regions left off the map along the bottom), or, without an image, a node map from `neighbours` (`Layouts.regionMap`: a fixed-step force layout seeded by the world, boxes never overlapping). Regions are filled with their controller's colour (theme variables `--f1`…`--f8`, picked by the faction's `color` or a hash of its id; no one: a dashed neutral), with up to two tag badges and your region outlined with a pin. Picking a region (click, tap or Enter) shows its public state in an info strip: name, who holds it, status, tags, the lore summary, and what changed this turn. All regions show, since region state is public (hidden events change nothing). The regional view is the same map, centred on your region at twice its size within the box of its neighbours, with rooms placed by `map.locations` and the rest of your region's rooms listed. Each region effect stamps `state.regionChanged[id] = {turn, what}`; a region changed this turn pulses once (not with reduced motion). Drag to pan, wheel or pinch to zoom, or use + − ⟲; plain SVG viewBox maths, kept per view until reset or a new game.

## Creator

Task 3-5. `creator.html` is a separate page that reuses the engine scripts. `js/creator.js` (the only creator file that touches the DOM) keeps a working copy of one world's raw files (`Scenario.fetchWorldFiles` or `Scenario.readFolderFiles`; a legacy folder is converted with `fromLegacy` on opening) in memory and in `localStorage` under `ensemble.creator.<folder>` (images only as object URLs, never stored), and runs the game's own checks on every edit: `prepareWorld` on a copy, with a problem every start reports shown once as the world's. Tabs are a registry (`TABS`); only Map works so far, the rest say which phase brings them.

- **Map tab**: the world map is drawn by `js/mapdraw.js` (shared with the game, DOM-free), with editing handles on top: draw a polygon (click corners; Enter or the first corner closes it), place a point, drag, add (double-click an edge) or remove (Alt-click) corners, place rooms (`map.locations`). The region panel edits name (a new region's id follows its name), controller, tags, status, lore and neighbours (`MapEdit.suggestNeighbours`: outlines within 10px). Renaming or deleting a region updates every reference (`MapEdit.renameRegion`, `deleteRegion`: neighbours, the map, starts, rooms, event seeds). Loading a new image scales existing shapes to it.
- **Export**: a store-only zip (`js/zip.js`, CRC-32, fixed dates so the same files make the same zip) of every file plus every image the world uses, fetched from the server or the picked folder.

## Relationship web

Task 2-4. **Web** (in the cast panel) opens a graph of who feels what about whom. `Eng.relationWeb(state, {secondary})` decides what the player may see, as words only (`relWord`, with a level 0–2 and a sign); the numbers stay in Debug:

- you → them, with your attitude note, and them → you (both already on the cards);
- between two other people, only when the player knows a fact `about` both of them, with the latest such fact as the reason. Private facts don't count, so hidden feelings never show.

Nodes are you and the local characters (secondary ones with the toggle), never the dead or extras. The page draws plain SVG with a small deterministic force layout (`layoutWeb` in `ui.js`: you fixed in the middle, two curves per pair so A→B and B→A can differ, colour by sign, thickness by level, dashed for what you only know from a fact) and the same edges as a text list for screen readers.

## Memory

- **Facts** are short sentences with names, an owner list (`known_by`) and a weight. The update step can't record a fact again that the same people already know (75% of the content words shared), and can't change a world value a clock set earlier in the same turn. Facts the player could not have seen or heard are recorded as known only by whoever did. The engine drops anyone the update step names who wasn't there: a fact can be known only by the player, the people present, those in the turn's events (hidden ones included), or `all`.
- **Chapters** close every N turns (default 5), early on a big moment (after at least 2 turns), when facts outgrow their budget, and after a major-event skip. Minor player-known facts are folded into a 2–4 sentence journal entry; weight-3 facts and private facts are kept individually.
- **Mood and tags** (task 1-6). The update step may set a non-player character's `mood` (how they come across, ≤ 60 characters) and add or remove `tags` (short visible states, ≤ 32 characters and 5 words, lasting `turns`, default 6). The engine rejects moods for the player, moods that overlap the character's secret (the card shows them), and feelings or need names as tags; merges a tag that shares a content word with an existing one (names excluded); keeps at most 4, dropping the oldest expiring one; and removes expired tags when the next turn commits. Changes and expiries show in Debug as `tags & mood`. Authored tags (and old `conditions`) last. Derived tags ("on edge", "hurt") are computed from needs and health for the card and never stored. Moods and tags go in the user message's status lines, never the header.
- **The player's feelings** are a separate tally, changed only by `player_attitude` judged from the player's own words (±10 per turn), with a note of why, or by the player's own correction on a card (`Eng.correctAttitude`, ±5 a step, an optional why that replaces the note; logged in `state.corrections` and Debug, recorded as a `correct` action). A correction made while a turn is pending is kept on `pending.corrections` and re-applied if the player steps in (which rewinds to the turn's start). Undo goes back to before the last action, so it drops corrections made since then. Longer time steps tell the narrator to keep the player's routine consistent with those feelings.

## Secrets

Each secret-keeper has a `guard`:

| guard | cracks when |
|---|---|
| low | confronted directly, stress ≥ 0.6, or trust ≥ 30 |
| medium | stress ≥ 0.85, trust ≥ 50, or confronted while stress ≥ 0.6 |
| high | stress ≥ 0.95 or trust ≥ 70 |

"Stress" here is the highest of the needs listed in the world's `revealPressure` (default `stress` and `fear`); a world without those needs cracks secrets only through trust, confrontation (low guard) or a social roll. A successful social roll works on anyone. A reveal attempt is either the `reveals` field (any truthy value) or a leak: 3+ content words shared with the secret, or a confession verb plus 1+. Unearned attempts become "is pressed about it but keeps the secret".

## Time

| step | span | narration | events |
|---|---|---|---|
| a few minutes | 15 min | 60–120 words, beat by beat | usually none |
| about an hour | about 1 h (follows the scene) | 100–200, key exchange live, rest compressed | 0–1 |
| a few hours | up to 3 h (follows the scene) | 150–250, routine allowed | 1–2 |
| until next morning | to wake hour | 200–300, summary then live morning | 1–3 |
| until something major happens | to the next clock, random major event, or horizon | 250–350, day-stamped montage then live crisis | up to 2 + the interrupting event |

The longer the step, the more the narrator may fill in for the player, but never big decisions. Scenes are written as beats with time markers (`[+0m]`, `[+40m]`, `[+3d]`); the page reveals them one at a time, offering **Step in here** or **Next ▸** after each. **Act** stays greyed out until the scene is read to the end or a step-in point is chosen, so the player never cuts a scene short by accident (they can type ahead).

## Events

- **Local**: people in and around the scene (an intercom call, someone arriving, an offstage character pursuing a secret).
- **Regional**: the surroundings (terrain, weather, nearby places). Default about one per 18 in-game hours on Mars, 4-hour cooldown.
- **World**: broad shifts far away (money, politics, disasters). Default about one per 96 hours, 24-hour cooldown.

The rates above are engine defaults. A world's genre tags can set others (`js/genres.js`: `cozy` is about one regional event every 72 hours, `war` every 12), and a world's own `eventRates` and `majorEventDays` always win; `Genres.pacing` settles each value in that order. The engine decides when bigger events are due; the model only writes them, guided by `eventSeeds`. Effects can change world status, a group's stance, clock values, add a new clock (at most 5 active), or change a region: `control` (it changes hands, to a group or no one), `add_tag` / `remove_tag` (up to 6 tags) and `region_status`. Each effect is one entry in the `EFFECTS` table in `engine.js` (keyed by the payload field: `world`, `groups`, `clocks`, `new_clock`, `control`, `add_tag`, `remove_tag`, `region_status`); a handler validates its own item and returns a news line or a rejection. Rejected items and unknown effect fields show in Debug as "effect rejected"; a new effect is a new table entry plus its line in the prompts' effect shape. Visibility is seen (in the player's room), heard (a sound, call or message) or hidden (private knowledge for those involved; changes nothing public).

**Regions** (task 3-1). The world's `regions` are static (name, neighbours, lore) and go in the header's REGIONS block; their changing part (controller, tags, status) is `state.regions` and goes in the user message for the player's region (the region of their room) and its neighbours only, so a change of control never touches the header. Regional and world events carry a `region`: an unknown id is reported as `event region` and a regional event falls back to the player's region; a world event may have none. It is kept on the news item and in Debug. Regional `eventSeeds` tied to a region away from the player are left out. Effects may change any region, near or far, so the world shifts around the story; the prompt lists every region id for effects, but only nearby regions' current state. Only events change regions; the update step can't.

## Downtime skip

`planMajorSkip` simulates clocks hour by hour (following `then` chains), finds the next agenda **contact** step (anyone's), and compares them with a random major event drawn from an exponential distribution (`majorEventDays`), capped by `majorHorizonDays`. Time advances in routine mode (hunger and fatigue settle near normal). Every living non-player agenda runs through the downtime (`Eng.runAgendas`): steps completed on the way become facts (private for hidden agendas) and are listed for the montage, and a contact step waits, due. When a contact step ends the skip (`reason: 'agenda'`), that person comes to find the player: it is the interrupting event, they end up with the player whatever the positions say, and the step completes. Due agenda steps are never written by the skip's own events. The player ends up somewhere else only if their plan names that place (`player_where` is otherwise ignored, as `move cancelled`). One model call writes the montage, any news, the interrupting event (unless a clock or an agenda caused it) and where everyone is; the narration is a day-stamped montage ending in a live scene. Choosing it means "let's see what happens", so very short skips are allowed.

## Backends

Two backends (local and external), each a preset: KoboldCpp on this computer, KoboldCpp remote (tunnel URL), OpenRouter, or any OpenAI-compatible API. Each pipeline step (characters & events, narration, memory updates, chapter summaries, world building) is routed to one of them; "Hybrid" sends the judgment, prose and world-building steps external and keeps bookkeeping local. Keys live in browser settings, never in saves.

## Decision log

| log | what went wrong | what fixed it |
|---|---|---|
| 1 | KoboldCpp used the Alpaca template; one character got no intent; narrator wrote the player's dialogue and decisions; invented a confession that contradicted the real secret | Mistral-Tekken adapter; intent example pre-filled with every present id; `says`/`reveals` decided in the intent step (which knows secrets); narrator rules |
| 2 | Player's line ended the scene with no reaction | Scene structure: player action first, others react, end on their move |
| 3 | Model moved the player away from the person they meant; narrator ignored "out of sight"; hidden motive recorded as player knowledge | Present people are in the room; `move_to` can be a character; observable-only knowledge rule |
| 4 | Duplicate paragraph; secret confessed on first question | Repeated-paragraph removal; reveal gate |
| 5 | Narrator followed the model's summary into the wrong room; update step moved everyone to match | Player's own words used when a move is cancelled; update step can't move the player |
| 6 | Narrator invented an hour of player activity to explain the end state | Scene frame with start and end; time step as control dial; relocation check; player feelings not set by the model |
| 7 | "They" for everyone; ending on the player; departure not reflected in state | Pronouns; trimming player endings; in-scene NPC moves allowed in the update step |
| 8 | `reveals: true` and a confession in dialogue bypassed the gate; scene hit the token cap | Leak detection; per-step scene length; trim to last sentence; then guard levels (confronting low-guard Teo should work) |
| 9 | (DeepSeek via OpenRouter, recorded) The stay-with-them guard cancelled 4 moves the player asked for ("…while I head down to the garage"), so Kit never reached the garage; the frame said people left behind "leave for" their own room; passing through the Commons triggered a scene rewrite; reasoning used up a scene's token limit twice | Moves the player states, or toward someone named who is there, are kept; "stays behind in" wording; rooms on the route are allowed; hosted prose calls get +1024 tokens of headroom. Replay fixture `playtest-deepseek-storm` |
| 10 | (friend, DeepSeek, recorded) "…then i get up to follow him" was cancelled while Teo walked off; after stepping in on Teo mid-scene, the update step moved him to Ops (his plan for later), so the confrontation that followed had no one in the room and the narrator wrote him in anyway | "follow" counts as a stated move, and so does going where someone named is heading this turn; after a step-in, location updates need the kept beats to show the person leaving, and the update prompt calls the resolution a plan. Fixture `playtest-friend-stepin` |
| 11 | (NemoMix 12B, recorded, after tasks 1-x and 2-1) The narrator copied the `[okafor]` id tags from its STATUS lines into the prose; the update step tagged Teo "anxious about recycler"; a scene cut at the token limit ended inside a quote | Ids in brackets become short names in the prose (`replaceIdTags`) and the narrator's status lines carry no ids; a tag with any feeling word is rejected; a cut inside dialogue closes the quote. Fixture `playtest-id-tags-in-prose` |
| 12 | (NemoMix 12B, recorded, first agenda skips) Two skips with no plan. The narrator was told the skip ended with a sponsor message instead of the storm; the model put Kit outside as the storm hit; the player-ending trim cut the whole live beat; the update set power back to "degraded" right after the storm collapsed it, and recorded the storm a second time; the second downtime retold the last scene before Teo arrived | The planned clock's own text ends the skip; `player_where` only counts when the plan names the place; a beat keeps its opening paragraph once its ending is trimmed; world values a clock set hold for that turn and duplicate facts are rejected; paragraphs that retell the last scene are dropped (`dropRetold`), with a prompt nudge. Fixture `playtest-agenda-skips` |
| 13 | (NemoMix 12B, recorded, first promotion) Mrs. Albee was promoted after two mentions, but her sheet gave her a neat bun and a crisp voice right after the scene showed curlers and a reedy one; the narrator wrote dialogue as a script ("You (Jordan Pike): …", "Mrs. Albee: …"); every "a few minutes" scene hit its 224-token cap | The flesh-out call sees the last two scenes that mention them; speaker labels at the start of a paragraph are removed; the moment step's budget went from 0.7× to 1.1× of the narration setting. Fixture `playtest-albee-promoted` |
| 14 | (NemoMix 12B, recorded, task 3-2 check) Sneaking past the stragglers in the next room gave no group intent or target; a sneak with the dead next door got no roll; `[+30s]` markers stayed in the prose; the update step copied the prompt's example world value | Named groups in a linked room are engaged; sneaking near a group always rolls; seconds are beat markers; prompt example values are rejected. Fixture `playtest-stragglers-sneak` |
