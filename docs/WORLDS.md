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
| `factions` | | as today; starts may override `stance` |
| `world` | object | world-status defaults; starts may add or override keys |
| `eventRates`, `eventSeeds`, `majorEventDays`, `majorHorizonDays`, `majorSeeds`, `revealSkills` | | as today; starts may override. An `eventSeeds` idea is text or `{text, region}` (a known region id); regional ideas for regions away from the player are left out of prompts |
| `tiers` | object | optional `{demoteAfter, maxLocal}` (whole numbers ≥ 1; defaults 4 and 6) for cast tiers (task 2-1). Starts may override field by field |
| `extras` | object[] | minor people (task 2-3): `{id, name, role, location, note, pronouns}`. `location` may be `null` (nowhere in particular). Ids must not clash with characters or locations. Starts add to or change them by `id`. The older `group: true` form (with `count`) loads as a standee when it has a room and is left out with a warning when it doesn't |
| `standees` | object[] | unnamed groups on the local map (task 3-2): `{id, label, count, location, state, faction, post, patrol, note}`. `count` 1–999; `location` a room (groups exist only in rooms; elsewhere they are their faction's business); `state` `calm` (default), `alert`, `hostile` or `down`; `faction` a group id; `post` a room it holds, or `patrol` a loop of at least 2 linked rooms that includes `location` (not both); `note` up to 200 characters, never shown to the player. Ids must not clash with characters, extras or locations. Starts add to or change them by `id` |
| `inventExtras` | boolean | default false; true lets the model add minor people during play (one a turn, 30 in all). Leave it off for closed settings |
| `facts` | string[] | public facts true everywhere |
| `characters` | string[] | the character pool (ids in `characters/`) |
| `starts` | string[] | start ids in `starts/`; the first is the default |
| `locations`, `clocks` | | optional world-wide ones (rare); usually per start. A location may set `region` (default: the start's `region`) |
| `regions` | object[] | the map above the rooms (task 3-1): `{id, name, controller, tags, status, neighbours, lore}`. `controller` is a group id or `null`; `tags` up to 6 (30 characters each); `status` up to 120 characters; `lore` a summary up to 400 (no secrets or future events; full lore entries come in phase 5). Neighbour links are made two-way when validated. Starts change them by `id`. Once a world has regions, every start needs `region` and every location a known region |
| `portraitSet` | string[] | optional; image paths in the world folder used as stand-ins for characters without a `portrait`, picked by a hash of the id (task 1-7). Without it, a monogram |
| reserved | | `map`, `lore`, `timeline`: accepted and ignored until their phase |

## starts/&lt;id&gt;.json

| field | type | notes |
|---|---|---|
| `id`, `title` | string | e.g. "Sol 214: the recycler" |
| `summary` | string | shown on the start picker: who you are and what's going on |
| `start` | `{day, hour}` | |
| `player` | id | must be in `cast` |
| `cast` | (id \| object)[] | who's in this start; see below |
| `locations` | | the local rooms: `{id, name, desc, connects}`, plus optional site layout fields (task 3-3): `size` (`small`, `medium`, `large`), `level` (0 the ground floor, 1 upstairs or the roof, −1 a basement; −3 to 5), `outside` (true for open ground), `features` (up to 6 short names, such as "forklift"), `secure` (exactly one way in), `seen` (false: the player doesn't know the room yet) and `links` (`[{to, kind}]`, kind `open`, `door`, `locked door`, `vent`, `hatch`, `window` or `stairs`; a link is also a connection, added to `connects` when validated). Links only change how the map draws a way through until task 3-6 |
| `site` | object | optional `{type}`: the layout style for the map, `generic` (default), `hall` (the biggest room in the middle, as in a store or warehouse) or `corridor` (a spine with rooms off it). May be set in the world when every start shares the rooms |
| `localMap` | object | optional `{image, width, height, rooms: {id: {x, y, w, h}}}`: a floor-plan image in the world folder, drawn with the rooms as hotspots instead of the generated plan. Pixel coordinates inside the image |
| `clocks` | | local pressures, same shape as today |
| `world`, `factions`, `eventRates`, … | | overrides of world fields (see merge rules) |
| `facts` | string[] | public facts specific to this start |
| `opening` | string | first scene |
| `castLabel` | string | sidebar heading ("Crew", "Survivors") |
| `region` | id | where the player starts; required when the world has `regions`, and the default region of the start's locations |
| reserved | | `playerSlot` (phase 4: lets the player make their own character) |

### cast entries

A character file is the person's **identity**: name, pronouns, role, age, traits, want, secret, guard, voice, skills, and (later) `portrait`, `description`, `appearance`. Where they are and how they feel at the start depends on the start, so a cast entry may override it:

```json
"cast": [
  "okafor",
  { "id": "bauer", "status": { "location": "hydro" }, "needs": { "stress": 0.7 },
    "relations": { "navarro": 20 }, "knows": ["Hydroponics lost three racks of soy last week..."] }
]
```

Overridable per start: `status`, `needs`, `relations`, `knows`, `want`, `secret`, `guard`, `tags`. A cast entry may also set `tier` (`"local"` or `"secondary"`; default: local if they start in the player's room) and `pinned` (`true`: always local); see Cast tiers in `docs/DESIGN.md`. `agenda` (`{goal, steps, hours, visibility}`, steps as text or `{text, contact}`; `null` for routine) is usually in the character file and may be overridden per start; see Agendas in `docs/DESIGN.md`. With no `agenda` field at all, the model proposes one in play. A plain id uses the file as it is. Character files may still contain `status`, `needs`, `relations` and `knows` as defaults; existing files therefore stay valid.

## Merge rules (`S.compose`)

1. Start with a deep clone of the world.
2. **Scalars, strings and every other field** (`setting`, `timeLabel`, `majorEventDays`, and lists not named below such as `skills`, `needs`, `majorSeeds`, `revealSkills`): the start's value replaces the world's.
3. **Lists of objects with `id`** (`locations`, `clocks`, `factions`, `extras`, `regions`, `standees`): merge by id, with start entries replacing world entries field by field. New ids are appended.
4. **Lists of strings** (`rules`, `facts`, `tags`): world first, then the start's, without duplicates.
5. **Plain objects** (`world`, `eventRates`, `eventSeeds`, `tiers`): shallow merge, with the start winning.
6. `characters` = the start's cast ids in order; `characterData` = each pool file deep-merged with its cast entry (cast entry wins; plain objects such as `status`, `needs` and `relations` merge field by field, lists such as `knows` are replaced). Relations to pool characters who aren't in this start's cast are dropped (they're checked against the pool by `validateWorld` instead).
7. When the result has `regions`, each location without a `region` gets the start's `region`. Group extras become standees (`S.groupsToStandees`).
8. The composed scenario gets `worldId`, `startId`, `folder` (the world folder) and `title` (`"<world title>: <start title>"` for display, or just the world title when the start has none, plus `worldTitle` and `startTitle` separately). `format` and `starts` are dropped. The prompt header's `SETTING:` line uses `worldTitle`, so start titles stay out of prompts.
9. Then `S.validate(composed)`: today's checks, unchanged. `S.compose` itself doesn't validate; `S.prepareWorld` does both.

A **world validation** (`S.validateWorld(bundle)`, where `bundle` is `{ world, starts: {id: start}, characters: {id: data}, legacy }` with missing files left out) runs first and catches mistakes that composing would hide: missing start or character files, duplicate ids, cast ids not in the pool, a `player` not in the cast, a missing `format: 2`, and relations to ids outside the pool. Each start is composed and validated when the world loads, so a broken start shows its error in the picker instead of failing at "New game".

## Legacy folders

A folder with `scenario.json` and no `world.json` loads through `S.fromLegacy(sc)`. That produces a world (everything except the start-only fields) with one start, id `default` and no title, built from `start`, `player`, `characters` (as `cast`), `locations`, `clocks`, `opening` and `castLabel`. The composed scenario is the one the old loader produced plus `worldId`, `startId`, `worldTitle` and `startTitle`. Character files are used as they are. Legacy loading stays permanently, since players' own scenarios use it; a test keeps the legacy fixture `tests/fixtures/legacy-scenario/` loading.

The bundled `mars-station` and `zombie-holdout` folders were converted in task 1-2. Their old versions are frozen as `tests/fixtures/legacy-scenario/` (Ares Deep) and `tests/fixtures/legacy-zombie-holdout/`, and a test checks each converted default start begins the same game. Ares Deep has a second start, `garage` (Priya Raman), as the worked example of one world with several starts.

## Saves

- Bump the state `version` to `2`. New states store `scenario.worldId` and `scenario.startId`.
- `Engine.migrate(state)` runs when a game is loaded (from browser storage or a file). For version 1 it sets `worldId = scenario.folder || scenario.id`, `startId = 'default'`, and `version = 2`. Nothing else changes, because the composed scenario has the same shape. A state with no `version` counts as 1.
- Migration is a chain (`Engine.migrations[n]` takes version n to n + 1; `Engine.STATE_VERSION` is the current one), each step tested. The undo copy inside a state is migrated too. A save from a newer version is refused with a message. Replay fixtures are migrated before they play.

## The picker

1. **World**: title, summary and tags (`index.json` order; "Open folder" adds more).
2. **Start**: title and summary for each start, the default selected. If a world has one start, this step is skipped.
3. (Phase 4) **"Make my own"** appears when a start has a `playerSlot`, or when the world allows generated starts.

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
