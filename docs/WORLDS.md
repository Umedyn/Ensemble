# Worlds and starts

Spec for roadmap phase 1, part one: splitting a scenario into a **world** and one or more **starts**. Read this before changing `js/scenario.js`, the scenario folders or the scenario picker.

## Why

Today a scenario is one fixed situation: a setting, a player character, a cast and some rooms. That can't express "the same world, entered from different places as different people": a hobbit in the Shire, a rider in Rohan and an orc in Mordor all share one world. Character creation, generated starts, maps, lore and the creator suite all need a world that exists independently of where the player starts.

- A **world** is everything true wherever you start: setting, rules, genre tags, skills, needs, groups, event pacing, world-wide facts, a pool of characters, and later regions, maps, lore and a timeline.
- A **start** is one way into that world: when, where, who you are, who's around you, the rooms you start in, local pressures and the opening scene.

## Key decision: compose, don't rewrite the engine

The loader **composes** a world and a start into one flat **scenario object**, with the same shape `Engine.newGame` takes today. The engine, prompts and saves keep reading `state.scenario.*` as they do now. Only `js/scenario.js`, the picker UI and the scenario folders change in phase 1.

```
world.json + starts/<id>.json + characters/*.json
        │ S.loadWorld()  →  { world, starts[], characters{} }
        │ S.compose(world, start)  →  scenario (today's flat shape + worldId/startId)
        │ S.validate(scenario)     ←  today's validator, unchanged in spirit
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
    portraits/               (phase 1, later task) images referenced by characters
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
| `tags`, `toneNote` | string[], string | genre and mood tags (a separate task; validated as optional now) |
| `timeLabel`, `wakeHour` | | as today |
| `skills`, `needs` | | as today; `needs` may be `[]` |
| `factions` | | as today; starts may override `stance` |
| `world` | object | world-status defaults; starts may add or override keys |
| `eventRates`, `eventSeeds`, `majorEventDays`, `majorHorizonDays`, `majorSeeds`, `revealSkills` | | as today; starts may override |
| `facts` | string[] | public facts true everywhere |
| `characters` | string[] | the character pool (ids in `characters/`) |
| `starts` | string[] | start ids in `starts/`; the first is the default |
| `locations`, `clocks` | | optional world-wide ones (rare); usually per start |
| reserved | | `regions`, `map`, `lore`, `timeline`, `portraitSet`: accepted and ignored until their phase |

## starts/&lt;id&gt;.json

| field | type | notes |
|---|---|---|
| `id`, `title` | string | e.g. "Sol 214: the recycler" |
| `summary` | string | shown on the start picker: who you are and what's going on |
| `start` | `{day, hour}` | |
| `player` | id | must be in `cast` |
| `cast` | (id \| object)[] | who's in this start; see below |
| `locations` | | the local rooms, same shape as today |
| `clocks` | | local pressures, same shape as today |
| `world`, `factions`, `eventRates`, … | | overrides of world fields (see merge rules) |
| `facts` | string[] | public facts specific to this start |
| `opening` | string | first scene |
| `castLabel` | string | sidebar heading ("Crew", "Survivors") |
| reserved | | `region` (phase 3), `playerSlot` (phase 4: lets the player make their own character), `extras`, `standees` (phases 2 and 3) |

### cast entries

A character file is the person's **identity**: name, pronouns, role, age, traits, want, secret, guard, voice, skills, and (later) `portrait`, `description`, `appearance`. Where they are and how they feel at the start depends on the start, so a cast entry may override it:

```json
"cast": [
  "okafor",
  { "id": "bauer", "status": { "location": "hydro" }, "needs": { "stress": 0.7 },
    "relations": { "navarro": 20 }, "knows": ["Hydroponics lost three racks of soy last week..."] }
]
```

Overridable per start: `status`, `needs`, `relations`, `knows`, `want`, `secret`, `guard`. A plain id uses the file as it is. Character files may still contain `status`, `needs`, `relations` and `knows` as defaults; existing files therefore stay valid.

## Merge rules (`S.compose`)

1. Start with a deep clone of the world.
2. **Scalars and strings** (`setting`, `timeLabel`, `majorEventDays`, …): the start's value replaces the world's.
3. **Lists of objects with `id`** (`locations`, `clocks`, `factions`): merge by id, with start entries replacing world entries field by field. New ids are appended.
4. **Lists of strings** (`rules`, `facts`, `tags`): world first, then the start's, without duplicates.
5. **Plain objects** (`world`, `eventRates`, `eventSeeds`): shallow merge, with the start winning.
6. `characters` = the start's cast ids in order; `characterData` = each pool file deep-merged with its cast entry (cast entry wins; `status` merged field by field).
7. The composed scenario gets `worldId`, `startId`, `folder` (the world folder) and `title` (`"<world title>: <start title>"` for display, plus `worldTitle` and `startTitle` separately).
8. Then `S.validate(composed)`: today's checks, unchanged.

A **world validation** (`S.validateWorld`) runs first and catches mistakes that composing would hide: missing start or character files, duplicate ids, cast ids not in the pool, and a `player` not in the cast. Each start is composed and validated when the world loads, so a broken start shows its error in the picker instead of failing at "New game".

## Legacy folders

A folder with `scenario.json` and no `world.json` loads through `S.fromLegacy(sc)`. That produces a world (everything except the start-only fields) with one start, id `default`, built from `start`, `player`, `characters`, `locations`, `clocks`, `opening` and `castLabel`. Character files are used as they are. Legacy loading stays permanently, since players' own scenarios use it; a test keeps a legacy fixture loading.

The bundled `mars-station` and `zombie-holdout` folders are converted to the new format in their own task.

## Saves

- Bump the state `version` to `2`. New states store `scenario.worldId` and `scenario.startId`.
- `Engine.migrate(state)` runs when a game is loaded (from browser storage or a file). For version 1 it sets `worldId = scenario.folder || scenario.id`, `startId = 'default'`, and `version = 2`. Nothing else changes, because the composed scenario has the same shape.
- Migration is a chain (`1→2`, later `2→3` …), each step tested.

## The picker

1. **World**: title, summary and tags (`index.json` order; "Open folder" adds more).
2. **Start**: title and summary for each start, the default selected. If a world has one start, this step is skipped.
3. (Phase 4) **"Make my own"** appears when a start has a `playerSlot`, or when the world allows generated starts.

Phone layout: two stacked selects, nothing more.

## Reserved fields policy

`S.validateWorld` and `S.validate` **accept and ignore** the reserved fields listed above, so creators can write content before the engine uses it. Unknown fields that aren't reserved are also accepted, but reported as a warning in the console and the Debug panel (a typo like `oppening` shouldn't silently do nothing).

## Tests to add

- Composing: the scalar, id-list, string-list and object merge rules, each with a small inline world.
- A cast entry overrides location, relations and knows; a plain id uses the file.
- `validateWorld`: missing start file, cast id not in pool, player not in cast, duplicate ids.
- A legacy folder composes to the same scenario it produced before (snapshot of the `newGame` state's characters, locations and clocks).
- Every bundled world validates, and every start in it starts a game (extends the existing "every bundled scenario" test).
- Save migration v1→v2.
- UI smoke: pick world, pick start, play a turn against the mock server.
