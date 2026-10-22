# Worlds and starts

Spec for roadmap phase 1, part one: splitting a scenario into a **world** and one or more **starts**. Read this before changing `js/scenario.js`, the scenario folders or the scenario picker.

## Why

Today a scenario is one fixed situation: a setting, a player character, a cast and some rooms. That can't express "the same world, entered from different places as different people": a hobbit in the Shire, a rider in Rohan and an orc in Mordor all share one world. Character creation, generated starts, maps, lore and the creator suite all need a world that exists independently of where the player starts.

- A **world** is everything true wherever you start: setting, rules, genre tags, skills, needs, groups, event pacing, world-wide facts, a pool of characters, and later regions, maps, lore and a timeline.
- A **start** is one way into that world: when, where, who you are, who's around you, the rooms you start in, local pressures and the opening scene.

## Key decision: compose, don't rewrite the engine

The loader **composes** a world and a start into one flat **scenario object**, with the same shape `Engine.newGame` takes today. The engine, prompts and saves keep reading `state.scenario.*` as they do now. Only `js/scenario.js`, the picker UI and the scenario folders change in phase 1.

```
world.json + starts/<id>.json + characters/*.json   (or a legacy scenario.json)
        │ S.loadWorldServer(folder) / S.loadFromFiles(fileList) / tests: readWorld(folder)
        │   all gather { relative path: JSON } and call S.prepareWorld(folder, files):
        │     S.fromLegacy(sc)           (legacy only) → { world, starts{}, characters{} }
        │     S.validateWorld(bundle)    → throws on problems, returns warnings
        │     for each start: S.validate(S.compose(world, start, characters, folder))
        │   → loaded world { folder, title, summary, tags, defaultStart, warnings,
        │                    starts: [{ id, title, summary, scenario | error }] }
        │ S.startScenario(loaded, startId?)  → a copy of that start's scenario
        ▼
Engine.newGame(scenario)
```

Saves already embed the scenario, so a save never needs its world folder again.

## Folder layout

```
scenarios/
  index.json                 lists world folders
  <world>/
    world.json
    starts/<startId>.json    one per id in world.json "starts"
    characters/<id>.json     the world's character pool
    portraits/               images referenced by characters (`portrait`) and the stand-in set (`portraitSet`)
    maps/  lore/             (phases 3 and 5) reserved
```

The top folder stays named `scenarios/`; renaming it would only add churn. In code and docs, "scenario" now means **the composed object**, "world" the folder, and "start" the entry point.

`index.json` keeps its shape: `{ "scenarios": [{ "folder": "mars-station", "title": "..." }] }`. The title shown is the world's.

Static servers can't list directories, so `world.json` lists its starts and characters by id, the same way `scenario.json` lists characters now.

## world.json

| field | type | notes |
|---|---|---|
| `format` | `2` | required in new-format worlds; its absence marks a legacy folder |
| `id`, `title` | string | |
| `summary` | string | one or two lines for the world picker |
| `setting` | string | the always-on world context (keep it broad; regional detail goes in region lore later) |
| `rules` | string[] | |
| `tags`, `toneNote` | string[], string | genre tags in order of importance (up to 8; known ones: `survival`, `slice-of-life`, `romance`, `intrigue`, `war`, `horror`, `mystery`, `comedy`, `cozy`, `grim`, `adventure`, `political`; others are freeform) and a short tone note (up to 300 characters). See `js/genres.js` |
| `timeLabel`, `wakeHour` | | as today |
| `skills`, `needs` | | as today; no `needs` (or `[]`) means none: no bars, no need penalties (task 1-5) |
| `tagThresholds` | object | optional; need id → `{at, tag}` for the derived card tags (task 1-6). Starts may override |
| `skillPenalties`, `revealPressure` | object, string[] | optional; roll penalties from health and needs, and which needs count as pressure on secrets. Defaults are today's values. Starts may override |
| `factions` | | as today; starts may override `stance`. Optional `color` (1–8) picks one of eight theme colours for the regions a group holds on the world map; without it, one is picked from the id |
| `world` | object | world-status defaults; starts may add or override keys |
| `eventRates`, `eventSeeds`, `majorEventDays`, `majorHorizonDays`, `majorSeeds`, `revealSkills` | | as today; starts may override. An `eventSeeds` idea is text or `{text, region}` (a known region id); regional ideas for regions away from the player are left out of prompts |
| `tiers` | object | optional `{demoteAfter, maxLocal}` (whole numbers ≥ 1; defaults 4 and 6) for cast tiers (task 2-1). Starts may override field by field |
| `extras` | object[] | minor people (task 2-3): `{id, name, role, location, note, pronouns}`. `location` may be `null` (nowhere in particular). Ids must not clash with characters or locations. Starts add to or change them by `id`. The older `group: true` form (with `count`) loads as a standee when it has a room and is left out with a warning when it doesn't |
| `standees` | object[] | unnamed groups on the local map (task 3-2): `{id, label, count, location, state, faction, post, patrol, note}`. `count` 1–999; `location` a room (groups exist only in rooms; elsewhere they are their faction's business); `state` `calm` (default), `alert`, `hostile` or `down`; `faction` a group id; `post` a room it holds, or `patrol` a loop of at least 2 linked rooms that includes `location` (not both); `note` up to 200 characters, never shown to the player. Ids must not clash with characters, extras or locations. Starts add to or change them by `id` |
| `inventExtras` | boolean | default false; true lets the model add minor people during play (one a turn, 30 in all). Leave it off for closed settings |
| `facts` | string[] | public facts true everywhere |
| `characters` | string[] | the character pool (ids in `characters/`) |
| `starts` | string[] | start ids in `starts/`; the first is the default. May be empty when the world has `generatedStarts` |
| `generatedStarts` | object | optional (task 4-2): lets players build a start. See [Generated starts](#generated-starts) |
| `generatedSites` | object | optional (task 4-4): `{maxSites, keepDays}` (defaults 8 and 3; 1–30 and 1–60): the engine builds places the story goes that the map doesn't have. See [Generated sites](#generated-sites) |
| `sites` | string[] | optional: library site maps in `sites/<id>.json`, used first when a new place fits one (task 4-4) |
| `locations`, `clocks` | | optional world-wide ones (rare); usually per start. A location may set `region` (default: the start's `region`) |
| `regions` | object[] | the map above the rooms (task 3-1): `{id, name, controller, tags, status, neighbours, lore}`. `controller` is a group id or `null`; `tags` up to 6 (30 characters each); `status` up to 120 characters; `lore` a summary up to 400 (no secrets or future events; full lore entries come in phase 5). `startable: true` marks the regions a generated start can begin in (none marked: all). Neighbour links are made two-way when validated. Starts change them by `id`. Once a world has regions, every start needs `region` and every location a known region |
| `portraitSet` | string[] | optional; image paths in the world folder used as stand-ins for characters without a `portrait`, picked by a hash of the id (task 1-7). Without it, a monogram |
| `map` | object | optional world map (task 3-4): `{image, width, height, regions: {id: {polygon: [[x, y], …]} or {point: [x, y]}}, locations: {roomId: [x, y]}}`, in image pixels. Polygons need 3+ points; every point inside the image; region ids must exist, and room ids must exist in the world or in some start (the map is the world's, rooms are usually a start's). A region left off gets a point placed automatically (with a warning). Without a map, the world view draws a node map from the regions' `neighbours` |
| reserved | | `lore`, `timeline`: accepted and ignored until their phase |

## starts/&lt;id&gt;.json

| field | type | notes |
|---|---|---|
| `id`, `title` | string | e.g. "Sol 214: the recycler" |
| `summary` | string | shown on the start picker: who you are and what's going on |
| `start` | `{day, hour}` | |
| `player` | id | must be in `cast`; may be left out when the start has a `playerSlot` (then every player makes their own) |
| `cast` | (id \| object)[] | who's in this start; see below |
| `locations` | | the local rooms: `{id, name, desc, connects}`, plus optional site layout fields (task 3-3): `size` (`small`, `medium`, `large`), `level` (0 the ground floor, 1 upstairs or the roof, −1 a basement; −3 to 5), `outside` (true for open ground), `features` (up to 6 short names, such as "forklift", or `{name, state}` for one the engine tracks, such as `{"name": "camera", "state": "on"}`), `secure` (exactly one way in), `seen` (false: the player doesn't know the room yet) and `links` (`[{to, kind}]`, kind `open`, `door`, `locked door`, `vent`, `hatch`, `window` or `stairs`; a link is also a connection, added to `connects` when validated; a `locked door` may name `key: [character ids]`, the people who pass, lock and unlock it freely). Since task 3-6 the engine plays by them: nobody passes a locked door without the key, shut doors block sight |
| `entrances` | object[] | optional `[{room, kind, watched}]`: ways in from outside (task 3-6). Watched ones make sneaking through that room harder. May be set in the world or a start |
| `site` | object | optional `{type}`: the layout style for the map, `generic` (default), `hall` (the biggest room in the middle, as in a store or warehouse) or `corridor` (a spine with rooms off it). May be set in the world when every start shares the rooms |
| `localMap` | object | optional `{image, width, height, rooms: {id: {x, y, w, h}}}`: a floor-plan image in the world folder, drawn with the rooms as hotspots instead of the generated plan. Pixel coordinates inside the image |
| `clocks` | | local pressures, same shape as today |
| `world`, `factions`, `eventRates`, … | | overrides of world fields (see merge rules) |
| `facts` | string[] | public facts specific to this start |
| `opening` | string | first scene |
| `castLabel` | string | sidebar heading ("Crew", "Survivors") |
| `region` | id | where the player starts; required when the world has `regions`, and the default region of the start's locations |
| `playerSlot` | object | optional (task 4-1): lets the player make their own character. See below |

### cast entries

A character file is the person's **identity**: name, pronouns, role, age, traits, want, secret, guard, voice, skills, and (later) `portrait`, `description`, `appearance`. Where they are and how they feel at the start depends on the start, so a cast entry may override it:

```json
"cast": [
  "okafor",
  { "id": "bauer", "status": { "location": "hydro" }, "needs": { "stress": 0.7 },
    "relations": { "navarro": 20 }, "knows": ["Hydroponics lost three racks of soy last week..."] }
]
```

### playerSlot (the character creator)

```json
"playerSlot": {
  "location": "commons",
  "summary": "You make your own crew member...",
  "knows": ["The recycler's rattle started six nights ago..."],
  "needs": { "stress": 0.3 },
  "roles": [{ "id": "systems", "label": "Systems engineer", "desc": "...", "skills": { "tech": 3 }, "suggestedTraits": ["practical"] }],
  "peoples": [{ "id": "local", "label": "Harbor-born", "desc": "...", "suggestedTraits": ["wry"] }],
  "freeform": false,
  "skillPoints": 10, "maxSkill": 3,
  "relationsDefault": 10, "castFeelings": 10,
  "keepDefault": false
}
```

| field | notes |
|---|---|
| `location` | required; a room of the start, where the made character begins |
| `summary` | optional, up to 400 characters; shown in the picker instead of the start's summary (which usually names the authored player) |
| `knows`, `needs` | optional; the made character's private starting facts and starting needs (the world's need ids, 0–1) |
| `roles` | `{id, label, desc, skills, suggestedTraits}`; at least one unless `freeform`. A role's `skills` fill in the point-buy (within its limits) and the player can change them |
| `peoples` | optional, same shape without `skills`; a people or origin, stored as the character's `people` |
| `freeform` | true lets the player write their own role (and people) |
| `skillPoints`, `maxSkill` | required; the point-buy budget across the world's skills, and the highest any one skill can be (1–4) |
| `relationsDefault` | the player's starting feelings toward the cast: a number, or `{id: n}` (−100..100; default 0). The form starts from these and the player can change them |
| `castFeelings` | how the cast feels about the newcomer, same shape (default 0) |
| `keepDefault` | false (default): the authored `player` leaves the cast when someone makes their own; true keeps them on as a non-player character |

The made character is a character file like any other (`id` from the name, made unique; `people` when a people was picked; `portrait` a path from the world's `portraitSet`, left out for the stand-in, or `false` for initials only), checked by `Scenario.characterProblems`. `CharMaker.withPlayer` adds it to the composed scenario as the player, at the front of the cast, sets `madePlayer`, applies `castFeelings`, drops the authored player (and feelings about them) unless `keepDefault`, and validates the result. When a world loads, each start with a slot is checked with a sample made character, so a slot that can't produce a playable game shows "(has errors)" in the picker. Saves embed the scenario, so the character travels with the game.

Overridable per start: `status`, `needs`, `relations`, `knows`, `want`, `secret`, `guard`, `tags`. A cast entry may also set `tier` (`"local"` or `"secondary"`; default: local if they start in the player's room) and `pinned` (`true`: always local); see Cast tiers in `docs/DESIGN.md`. `agenda` (`{goal, steps, hours, visibility}`, steps as text or `{text, contact}`; `null` for routine) is usually in the character file and may be overridden per start; see Agendas in `docs/DESIGN.md`. With no `agenda` field at all, the model proposes one in play. A plain id uses the file as it is. Character files may still contain `status`, `needs`, `relations` and `knows` as defaults; existing files therefore stay valid.

## Merge rules (`S.compose`)

1. Start with a deep clone of the world.
2. **Scalars, strings and every other field** (`setting`, `timeLabel`, `majorEventDays`, and lists not named below such as `skills`, `needs`, `majorSeeds`, `revealSkills`): the start's value replaces the world's.
3. **Lists of objects with `id`** (`locations`, `clocks`, `factions`, `extras`, `regions`, `standees`): merge by id, with start entries replacing world entries field by field. New ids are appended.
4. **Lists of strings** (`rules`, `facts`, `tags`): world first, then the start's, without duplicates.
5. **Plain objects** (`world`, `eventRates`, `eventSeeds`, `tiers`): shallow merge, with the start winning.
6. `characters` = the start's cast ids in order; `characterData` = each pool file deep-merged with its cast entry (cast entry wins; plain objects such as `status`, `needs` and `relations` merge field by field, lists such as `knows` are replaced). Relations to pool characters who aren't in this start's cast are dropped (they're checked against the pool by `validateWorld` instead).
7. When the result has `regions`, each location without a `region` gets the start's `region`. Group extras become standees (`S.groupsToStandees`). World-level extras and standees placed in a room this start doesn't have are, respectively, nowhere in particular (`location: null`) and left out; `validateWorld` checks that their room exists in the world or in some start, so a typo still fails.
8. The composed scenario gets `worldId`, `startId`, `folder` (the world folder) and `title` (`"<world title>: <start title>"` for display, or just the world title when the start has none, plus `worldTitle` and `startTitle` separately). `format` and `starts` are dropped. The prompt header's `SETTING:` line uses `worldTitle`, so start titles stay out of prompts.
9. Then `S.validate(composed)`: today's checks, unchanged. `S.compose` itself doesn't validate; `S.prepareWorld` does both.

A **world validation** (`S.validateWorld(bundle)`, where `bundle` is `{ world, starts: {id: start}, characters: {id: data}, legacy }` with missing files left out) runs first and catches mistakes that composing would hide: missing start or character files, duplicate ids, cast ids not in the pool, a `player` not in the cast, a missing `format: 2`, and relations to ids outside the pool. Each start is composed and validated when the world loads, so a broken start shows its error in the picker instead of failing at "New game".

## Legacy folders

A folder with `scenario.json` and no `world.json` loads through `S.fromLegacy(sc)`. That produces a world (everything except the start-only fields) with one start, id `default` and no title, built from `start`, `player`, `characters` (as `cast`), `locations`, `clocks`, `opening` and `castLabel`. The composed scenario is the one the old loader produced plus `worldId`, `startId`, `worldTitle` and `startTitle`. Character files are used as they are. Legacy loading stays permanently, since players' own scenarios use it; a test keeps the legacy fixture `tests/fixtures/legacy-scenario/` loading.

The bundled `mars-station` and `zombie-holdout` folders were converted in task 1-2. Their old versions are frozen as `tests/fixtures/legacy-scenario/` (Ares Deep) and `tests/fixtures/legacy-zombie-holdout/`, and a test checks each converted default start begins the same game. Ares Deep has a second start, `garage` (Priya Raman), as the worked example of one world with several starts.

## Generated starts

Task 4-2. A world opts in with `generatedStarts`:

```json
"generatedStarts": { "roles": [{ "id": "trucker", "label": "Long-haul trucker", "skills": { "fighting": 2 } }], "skillPoints": 10, "maxSkill": 3, "castSize": [3, 5], "castLabel": "Group", "start": { "day": 23, "hour": 9 } }
```

`roles`, `skillPoints` and `maxSkill` work as in a `playerSlot` (freeform roles are always allowed); `castSize` is how many people to make besides the player (default `[3, 5]`, 1–8); `castLabel` the sidebar heading; `start` the date (default: the default start's). Leave it out for closed settings (Ares Deep has none: it is a five-person station).

The player picks a region (`startable` ones), makes a character with the 4-1 form or describes one in a line, and may add a note on the kind of story. `js/startgen.js` then runs small `worldbuild` calls, each checked before the next: the player's sheet (only for a line), rooms, who is here (a one-line plan per person), the people (one call each on KoboldCpp, all in one call on an API model), ties and pressures, minor people and groups, and the opening with a title, summary and public facts. The result is an ordinary start with `"generated": true` plus a character file per new person; it goes through `validateWorld`, `compose` and `validate` like an authored start, and the save embeds it. Generated people are new: the world's character pool is not used, and their names and ids never clash with it.

Before playing, a review (task 4-3) lets the player edit any field (`StartGen.setField`, checked per field), reroll one room (`rerollRoom`: same id and connections), one person (`rerollPerson`: same id, name and role), or the pressures, minor people or opening alone (`redoOnly`), with everything checked again (`reviewProblems`: the validation above plus secrets in public text). **Save as start** (`StartGen.files`) writes `starts/<id>.json`, `characters/<id>.json` for each new person and `world.json` with both added to its `starts` and `characters` lists, in a zip under the world's folder name; unzipped over the world folder, it loads as an authored start (it keeps `"generated": true`).

## Generated sites

Task 4-4. In a world with `generatedSites`, the intent step may propose `new_place: {name, kind, region}` when the player's action heads somewhere that is none of the rooms. The engine decides: the player's words must name it, the region must be theirs or a neighbour, the way out of where they stand must be open (rule 4: a locked door stops the trip before any call is made), and the world must be under `maxSites`. A regional event may add `effects.new_site` (a **stub**: a known place with no rooms yet, built on the first visit).

Building takes up to two `worldbuild` calls, each checked and retried with the problem named (`js/sites.js`):

1. **Layout** (skipped when a library map fits): 2–6 rooms with link kinds, features, `outside` and `secure`, an entry room and entrances. Cut-off rooms get a door to the entry; a `secure` room with more than one way in loses the flag.
2. **Who is there**: up to 2 named people (as extras, so promotion can make them characters), up to 3 groups (with a faction, a post or a patrol loop of linked rooms) and a note of what there is to find, for the story engine only. With a library map the model may also rename its rooms, keeping their ids.

The rooms join the game with `site` (the site id) and the region; a **route** link (an engine-only kind) joins the entry room to open ground at street level in the site the player left (or to the room they left from). Routes are never locked, don't let anyone see through, take whatever the time step is, and groups never cross them. The local map shows only the place the player is in, with routes as "Ways to other places".

Sites **fade unless something happened there**: a fact of weight 2+ recorded while the player was there, a second visit, or one of its people joining the cast keeps a site; otherwise, `keepDays` after the last visit, with the player and the cast elsewhere, its rooms, links, extras and groups are removed and it becomes a stub again (name, kind, region and a line about the visit, which the next build sees).

### sites/&lt;id&gt;.json (library maps)

```json
{ "id": "chop-shop", "name": "Chop shop", "type": "warehouse", "tags": ["chop shop", "gang"], "credit": "...", "license": "CC0-1.0",
  "entry": "loading-bay", "rooms": [{ "id": "loading-bay", "name": "Loading Bay", "desc": "...", "features": [{ "name": "camera", "state": "on" }], "links": [{ "to": "garage-floor", "kind": "open" }] }],
  "entrances": [{ "room": "loading-bay", "kind": "roller door", "watched": true }] }
```

Rooms use the start room format (task 3-3). `type`, `credit` and `license` are required. A new place uses a map when a word of its kind matches the map's `type` or a tag; among several, the pick is seeded by the site id, so it is the same every time. Ids that clash with the game's are renamed. The maps travel in the composed scenario (`siteMaps`), so saves keep them. The shared cross-world library comes with task 6-3. `tests/fixtures/chrome-district/` is the worked example (the Saints' chop shop).

## Saves

- Bump the state `version` to `2`. New states store `scenario.worldId` and `scenario.startId`.
- `Engine.migrate(state)` runs when a game is loaded (from browser storage or a file). For version 1 it sets `worldId = scenario.folder || scenario.id`, `startId = 'default'`, and `version = 2`. Nothing else changes, because the composed scenario has the same shape. A state with no `version` counts as 1.
- Migration is a chain (`Engine.migrations[n]` takes version n to n + 1; `Engine.STATE_VERSION` is the current one), each step tested. The undo copy inside a state is migrated too. A save from a newer version is refused with a message. Replay fixtures are migrated before they play.
- Later tasks added steps the same way; task 4-4 took it to `12` (`sites`, and `site` on generated rooms; older saves get `sites: {}`).

## The picker

1. **World**: title, summary and tags (`index.json` order; "Open folder" adds more).
2. **Start**: title and summary for each start, the default selected. If a world has one start, this step is skipped.
3. **Make my own start** (task 4-2): a world with `generatedStarts` adds "✦ Make my own start" to the start select; New game then opens the generator.
4. **Who you play** (task 4-1): a start with a `playerSlot` adds a third select, "Play as <name>" (when it has a `player`) or "Make my own". New game with "Make my own" opens the character form; Start game there begins the game. Generated starts (task 4-2) will add their own entry.

Phone layout: two stacked selects, nothing more.

As built (task 1-3): two selects in the top bar, the start one hidden when a world has a single start. On desktop a line under them shows the world's title, summary and tags and the picked start's summary; it folds away once a game is running and comes back when either select changes. Server worlds are all loaded when the page opens (so a broken world or start is visible before New game) and the picked one is fetched again at New game, so edited files show up without a reload. A broken world or start is labelled "(has errors)" and the line shows the validation error; New game on it shows the same message and starts nothing. The last world and start are remembered (`ensemble.pick` in `localStorage`). The scene bar shows the world title, with the start title on desktop, and save and recording file names use both titles (`ensemble-ares-deep-sol-214-the-mule-turn3.json`).

## Reserved fields policy

`S.validateWorld` and `S.validate` **accept and ignore** the reserved fields listed above, so creators can write content before the engine uses it. Unknown fields that aren't reserved are also accepted, but reported as a warning in the console and the Debug panel (a typo like `oppening` shouldn't silently do nothing). Warnings cover `world.json`, start files, cast entries and legacy `scenario.json`; character files aren't checked, since later phases add many character fields. `npm run check` prints them too.

## Tests

In `tests/worlds.test.js` (task 1-1), except the picker smoke test (task 1-3):


- Composing: the scalar, id-list, string-list and object merge rules, each with a small inline world.
- A cast entry overrides location, relations and knows; a plain id uses the file.
- `validateWorld`: missing start file, cast id not in pool, player not in cast, duplicate ids.
- A legacy folder composes to the same scenario it produced before (snapshot of the `newGame` state's characters, locations and clocks).
- Every bundled world validates with no warnings, and every start in it starts a game and plays a turn.
- Each converted bundled world's default start begins the same game as its legacy version.
- Save migration v1→v2.
- UI smoke: pick world, pick start, play a turn against the mock server.
