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
    maps/                    map images (phase 3)
    lore/<id>.json           lore files listed in world.json "lore" (task 5-1): one entry, or a list of entries
```

The top folder stays named `scenarios/`; renaming it would only add churn. In code and docs, "scenario" now means **the composed object**, "world" the folder, and "start" the entry point.

`index.json` keeps its shape: `{ "scenarios": [{ "folder": "mars-station", "title": "..." }] }`. The title shown is the world's.

Static servers can't list directories, so `world.json` lists its starts and characters by id, the same way `scenario.json` lists characters now.

## world.json

### The minimum world

A title and a setting are a whole world (R-0; `tests/fixtures/minimum-world/`):

```json
{
  "title": "The Lighthouse",
  "setting": "A lighthouse on a cold northern coast, some years after the lights went out everywhere else."
}
```

With no `starts` the picker offers only **✦ Make my own start** (as if the world had `"generatedStarts": {}`): the player makes a character and the story engine builds the place, the people and the opening. With no `characters` the pool is empty (generated starts make their own people). With no `skills` the engine's five (`physical`, `technical`, `social`, `knowledge`, `stealth`) apply; no `needs`, groups, regions, clocks, map, lore or timeline means none. The date is day 1, 9:00 unless the world gives a `date`. Every field below is an addition the creator chooses, and the minimum-world test keeps it that way.

### Fields

| field | type | notes |
|---|---|---|
| `format` | `2` | optional in `world.json` (default `2`); any other value is an error. A folder with `scenario.json` instead is a legacy folder |
| `id`, `title` | string | `title` required; `id` defaults to the folder name |
| `date` | `{day, hour}` | optional (R-0): the date a generated start begins on, and of an authored start that gives no `start`. Default day 1, 9:00 |
| `summary` | string | one or two lines for the world picker |
| `setting` | string | the always-on world context (keep it broad; regional detail goes in region lore) |
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
| `characters` | string[] | optional: the character pool (ids in `characters/`). Open worlds may have none |
| `starts` | string[] | optional: start ids in `starts/`; the first is the default. None (missing or empty) means generated starts, as if `generatedStarts: {}` |
| `generatedStarts` | object | optional (task 4-2): lets players build a start beside the authored ones, or tunes it in a world with none. Every field has a default. See [Generated starts](#generated-starts) |
| `generatedSites` | object | optional (task 4-4): `{maxSites, keepDays, library}` (defaults 8 and 3; 1–30 and 1–60): the engine builds places the story goes that the map doesn't have. `library` (task 6-3) is a list of setting tags, such as `["modern"]`: shared site maps whose `setting` overlaps join the world's own. See [Generated sites](#generated-sites) |
| `sites` | string[] | optional: library site maps in `sites/<id>.json`, used first when a new place fits one (task 4-4) |
| `locations`, `clocks` | | optional world-wide ones (rare); usually per start. A location may set `region` (default: the start's `region`) |
| `regions` | object[] | the map above the rooms (task 3-1): `{id, name, controller, tags, status, neighbours, lore}`. `controller` is a group id or `null`; `tags` up to 6 (30 characters each); `status` up to 120 characters; `lore` a summary up to 400, always in the prompt (no secrets or future events; the heavier detail goes in `region` lore entries, below). `startable: true` marks the regions a generated start can begin in (none marked: all). Neighbour links are made two-way when validated. Starts change them by `id`. Once a world has regions, every start needs `region` and every location a known region. Since R-1, regions form a tree: `parent` (a region id) puts a region inside another, `label` is its display word (up to 30 characters). See [The region tree](#the-region-tree) |
| `regionLabels` | string[] | optional (R-1): the display word for each level of the region tree, from the top (`["nation", "province", "city"]`, at most 6); a region's own `label` wins. Display only: the engine never branches on a label |
| `portraitSet` | string[] | optional; image paths in the world folder used as stand-ins for characters without a `portrait`, picked by a hash of the id (task 1-7). Without it, a monogram |
| `map` | object | optional world map (task 3-4): `{image, width, height, regions: {id: {polygon: [[x, y], …]} or {polygons: [[[x, y], …], …]} or {point: [x, y]}}, locations: {roomId: [x, y]}}`, in image pixels. Polygons need 3+ points; every point inside the image; region ids must exist, and room ids must exist in the world or in some start (the map is the world's, rooms are usually a start's). A region left off gets a point placed automatically (with a warning). Without a map, the world view draws a node map from the regions' `neighbours`. Since task 4-5: `polygons` for a region in several pieces (islands); `projection: "equirectangular"` and `bounds: [west, south, east, north]` in degrees for a map on the globe; `places` (named points, below); `base` (the base map it was cut from) and `credit`, `license`. See [Base maps and real places](#base-maps-and-real-places) |
| `lore` | (object \| string)[] | lore entries (task 5-1), each inline or the id of a file in `lore/` (a file holds one entry, its `id` defaulting to the file name, or a list: a lore packet). See [Lore](#lore). Starts add to or replace entries by `id`, inline only |
| `timeline` | object[] | canon events (task 5-2), past and future. See [Canon timeline](#canon-timeline). Starts add to or replace events by `id` |
| `projectTimeline` | false \| object | default on: when no event is planned in the next few days, the model projects likely ones. `false` turns it off; `{days, max}` (1–14 and 1–5; defaults 3 and 3) tunes it. Starts may override |

### The region tree

Task R-1. A flat list of regions is a whole world; add `parent` only where the story needs more detail. France can go four levels deep while the rest of Europe stays one region each:

```json
"regionLabels": ["nation", "zone", "department", "city"],
"regions": [
  { "id": "france", "name": "France" },
  { "id": "occupied", "name": "Occupied Zone", "parent": "france", "controller": "germany" },
  { "id": "free", "name": "Free Zone", "parent": "france", "controller": "vichy" },
  { "id": "paris", "name": "Paris", "parent": "occupied", "label": "city" },
  { "id": "spain", "name": "Spain", "neighbours": ["france"] }
]
```

- **Every field is optional.** A region without `parent` sits directly under the world. Depth varies by branch, up to 6 levels. Validation names regions by name: "Paris is inside Lyon, which is inside Paris", "Lyon is inside "x", which isn't one of the regions", "The Vault is 7 levels deep (inside …); 6 is the most".
- **Rooms and sites hang off any region**, as before (`region` on a location, or the start's).
- **Who holds what.** `controller` works at any level. A parent with no controller of its own shows its children's state in summary ("no single holder (The Occupation holds 1 of 2, …)"); it never gets a made-up owner.
- **Near.** What counts as near a region (`Engine.regionNear`): its neighbours, then its siblings under the same parent (not at the top level: the other countries of a world map aren't near), then its children, at most 8. The player's region and what's near get their current state in the prompt; each region the player's is inside gets one entry on an `Inside:` line.
- **The prompt.** The header's region block is an outline built once from the start's region: the start's chain, what's within two steps (neighbours, parent, children), the siblings along the chain and `notable` regions in full (up to 24), then names for the rest, top-level ones first. A line reads `- paris: Paris, a city in Occupied Zone — lore`. It is the same for the whole game, so a deep tree costs nothing per turn. A flat world gets the lines it always had.
- **Lore and events up the chain.** Region lore for the regions the player's is inside comes in after the region's own (a ward with no lore still gets its city's); an event idea tied to an ancestor counts as near, and a regional event may name any of them.
- **The map.** A region with regions inside it is drawn only when the map gives it a shape of its own (under its children); otherwise its children stand for it, and it needs no shape and gets no automatic point. Named `places` on the map stay pins in a region, not regions.

## starts/&lt;id&gt;.json

| field | type | notes |
|---|---|---|
| `id`, `title` | string | e.g. "Sol 214: the recycler" |
| `summary` | string | shown on the start picker: who you are and what's going on |
| `start` | `{day, hour}` | |
| `player` | id | must be in `cast`; may be left out when the start has a `playerSlot` (then every player makes their own) |
| `cast` | (id \| object)[] | who's in this start; see below |
| `locations` | | the local rooms: `{id, name, desc, connects}`, plus optional site layout fields (task 3-3): `size` (`small`, `medium`, `large`), `level` (0 the ground floor, 1 upstairs or the roof, −1 a basement; −3 to 5), `outside` (true for open ground), `features` (up to 6 short names, such as "forklift", or `{name, state}` for one the engine tracks, such as `{"name": "camera", "state": "on"}`), `secure` (exactly one way in), `seen` (false: the player doesn't know the room yet) and `links` (`[{to, kind}]`, kind `open`, `door`, `locked door`, `vent`, `hatch`, `window` or `stairs`; a link is also a connection, added to `connects` when validated; a `locked door` may name `key: [character ids]`, the people who pass, lock and unlock it freely). Since task 3-6 the engine plays by them: nobody passes a locked door without the key, shut doors block sight. On the detailed map (task 3-7), room and feature names choose how a room is furnished ("Galley", "bunks", "glovebox", "bar", "shelving"), and a feature named "window" goes on an outside wall; every feature is drawn even when nothing matches, and the rest is decoration that never counts as a fact |
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
3. **Lists of objects with `id`** (`locations`, `clocks`, `factions`, `extras`, `regions`, `standees`, `lore`, `timeline`): merge by id, with start entries replacing world entries field by field. New ids are appended.
4. **Lists of strings** (`rules`, `facts`, `tags`): world first, then the start's, without duplicates.
5. **Plain objects** (`world`, `eventRates`, `eventSeeds`, `tiers`): shallow merge, with the start winning.
6. `characters` = the start's cast ids in order; `characterData` = each pool file deep-merged with its cast entry (cast entry wins; plain objects such as `status`, `needs` and `relations` merge field by field, lists such as `knows` are replaced). Relations to pool characters who aren't in this start's cast are dropped (they're checked against the pool by `validateWorld` instead).
7. When the result has `regions`, each location without a `region` gets the start's `region`. Group extras become standees (`S.groupsToStandees`). World-level extras and standees placed in a room this start doesn't have are, respectively, nowhere in particular (`location: null`) and left out; `validateWorld` checks that their room exists in the world or in some start, so a typo still fails.
8. The composed scenario gets `worldId`, `startId`, `folder` (the world folder) and `title` (`"<world title>: <start title>"` for display, or just the world title when the start has none, plus `worldTitle` and `startTitle` separately). `format` and `starts` are dropped. The prompt header's `SETTING:` line uses `worldTitle`, so start titles stay out of prompts.
9. Then `S.validate(composed)`: today's checks, unchanged. `S.compose` itself doesn't validate; `S.prepareWorld` does both.

A **world validation** (`S.validateWorld(bundle)`, where `bundle` is `{ world, starts: {id: start}, characters: {id: data}, legacy }` with missing files left out) runs first and catches mistakes that composing would hide: missing start or character files, duplicate ids, cast ids not in the pool, a `player` not in the cast, a `format` other than 2, and relations to ids outside the pool. Each start is composed and validated when the world loads, so a broken start shows its error in the picker instead of failing at "New game".

## Legacy folders

A folder with `scenario.json` and no `world.json` loads through `S.fromLegacy(sc)`. That produces a world (everything except the start-only fields) with one start, id `default` and no title, built from `start`, `player`, `characters` (as `cast`), `locations`, `clocks`, `opening` and `castLabel`. The composed scenario is the one the old loader produced plus `worldId`, `startId`, `worldTitle` and `startTitle`. Character files are used as they are. Legacy loading stays permanently, since players' own scenarios use it; a test keeps the legacy fixture `tests/fixtures/legacy-scenario/` loading.

The bundled `mars-station` and `zombie-holdout` folders were converted in task 1-2. Their old versions are frozen as `tests/fixtures/legacy-scenario/` (Ares Deep) and `tests/fixtures/legacy-zombie-holdout/`, and a test checks each converted default start begins the same game. Ares Deep has a second start, `garage` (Priya Raman), as the worked example of one world with several starts.

## Generated starts

Task 4-2. A world with no `starts` always has them (R-0); a world with authored starts opts in with `generatedStarts`, and the picker lists its starts first, then "✦ Make my own start". Every field is optional (`{}` works):

```json
"generatedStarts": { "roles": [{ "id": "trucker", "label": "Long-haul trucker", "skills": { "fighting": 2 } }], "skillPoints": 10, "maxSkill": 3, "castSize": [3, 5], "castLabel": "Group", "start": { "day": 23, "hour": 9 } }
```

`roles`, `skillPoints` and `maxSkill` work as in a `playerSlot` (defaults: no roles, 10 points, 3 at most each; freeform roles are always allowed); `castSize` is how many people to make besides the player (default `[3, 5]`, 1–8; a player's note may still ask for a lone start); `castLabel` the sidebar heading; `start` the date (default: the world's `date`, else the default start's, else day 1, 9:00). Leave it out for closed settings (Ares Deep has none: it is a five-person station).

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

Rooms use the start room format (task 3-3). `type`, `credit` and `license` are required. A new place uses a map when a word of its kind matches the map's `type` or a tag; the world's own maps come before shared ones, and among several the pick is seeded by the site id, so it is the same every time. Ids that clash with the game's are renamed. The maps travel in the composed scenario (`siteMaps`), so saves keep them. `tests/fixtures/chrome-district/` is the worked example (the Saints' chop shop).

**Drawn maps** (task 6-3, made in the creator's Sites tab). All optional, so a map without them is laid out by the game as before:

| field | notes |
|---|---|
| `image`, `width`, `height` | the battlemap or floor plan, beside the map (`sites/<id>.png`), and its size in pixels. In play the place is drawn on it: the picture shows only through rooms the player knows, dimmed where they only remember them, with a "?" past a door into an unknown room |
| `grid` | `{"square": 50, "unit": "5 ft"}`: pixels per square and what a square measures. **For measuring only**, never squares to move on: a room without a `size` gets one from its area (under 10 squares small, under 30 medium, else large), and its description gets "about 30 × 20 ft" for the narrator |
| `rooms[].shape` | the room as a polygon on the image, `[[x, y], …]` (3+ points inside it) |
| `links[].at`, `entrances[].at` | where the door or way in is drawn; a link without one is drawn in the middle of the edge the two rooms share |
| `spots` | `[{kind, room, at, label}]`, kind `guard post`, `cover`, `hide`, `loot` or `spawn`. In play a spot is a feature of its room (its label, or the kind); a group the people step puts in a room with a guard post holds it; someone it doesn't place starts at a spawn point. Authored features are what exists; where the author marks nothing, play may still infer features (task 3-6) |
| `setting` | setting tags (`modern`, `cyberpunk`, `fantasy`…) for the shared library |

Validation warns (without refusing the map) about a `secure` room with more than one way in, shapes that overlap on the same level, and a door between rooms whose shapes don't touch (stairs, hatches and vents may join rooms anywhere).

### The shared library

`library/index.json` (`{"sites": [{id, name, type, tags, setting, rooms}]}`, one entry per map, made by `Scenario.libraryEntry`) and `library/sites/<id>.json` with their images. Bundled maps are original or CC0 only: the roadside diner (modern) and the chop shop (cyberpunk). A world that sets `generatedSites.library` gets the shared maps whose `setting` overlaps, after its own (a world map with the same id wins); Harmon's uses `["modern"]`, so a trip to "the diner" uses the drawn diner. In the game, **Open folder** on a library folder (an `index.json` with `sites`, and no `world.json`) adds its maps; the creator's **Export for the library** makes such a folder. `npm run check` validates the library and keeps the index in step.

## Base maps and real places

Task 4-5. One shared topographic picture of the world, for any historical or modern world to start from; each world draws (or imports) only the regions it needs, for its own era.

**The base map**: `library/maps/world/` holds `world.jpg` (8192 × 4096, Natural Earth's 1:50m cross-blended hypsometric tints with shaded relief and water; public domain, "Made with Natural Earth") and `map.json` (`{id, title, image, width, height, projection, bounds, credit, license}`), listed in `library/index.json` under `maps`. **New world** in the creator can start on it: pick an area (or type bounds) and the picture is cut for that world (`maps/base.jpg`), with `projection`, `bounds` and `base` set, so a point on the map has a latitude and longitude (the Map tab shows them under the pointer). Borders are never in the base map: they change by era, so each world has its own.

**Eras** (decided 2026-10-22): a real-world setting is split by era into separate worlds that share the base map, not one map that shifts across centuries. Each era world names its places for the period ("Florida" is an anachronism in a Roman-era world; a neutral descriptive name works when there's no known one), fills distant land with the peoples who lived there rather than leaving it empty, and can be rich where stories happen and broad elsewhere. Settlements come and go; the land stays. Within an era, the world still changes in play through region control, tags and the canon timeline. (The region rework, ROADMAP › Region rework, gives this its structure: a region tree, routes, maps on any region, and presence for overlapping groups.)

**A map on the globe**: `projection` (`equirectangular`: longitude and latitude placed linearly, as Natural Earth draws its rasters) and `bounds` (`[west, south, east, north]`, in degrees, west < east, south < north). Without them a map is just a picture, as before.

**Regions in pieces**: `{polygons: [ring, …]}`, each ring 3+ points inside the image. Drawn as one shape, clicked on any piece, labelled inside the biggest. Regions may also have `notable: true` (always in full in the prompt, below), `wiki` (`{title, wikidata}`, the Wikipedia page the research helper reads) and `key` (the source's id, so importing again updates the same region).

**Places**: `map.places`, `[{id, name, kind, at, region, notable}]`: capitals, cities and towns as named points without rooms. `kind` is `capital`, `city`, `town` or `place` (default); `at` a point inside the image; `region` a known region (drawing a region claims the places inside it that have none); `notable: true` names it on the map even zoomed out. Ids must not clash with regions or rooms. The story knows them by name: each region in the prompt lists its places, and a trip to one (in the player's region or a neighbour) builds it as a generated site (task 4-4).

**The prompt budget**: up to 24 regions, every region is in the prompt header in full, as before. A bigger map (a world of countries) shows in full the start's region, the regions up to two borders away and `notable` ones, then "Further away:" with up to 60 more names, nearest first. Both come from the start's region, so the header stays the same for the whole game (rule 7).

**The tool** (`npm run basemap`, `tools/basemap.mjs`; build time only, never in play):

- `fetch [--states]`: downloads the source picture and Natural Earth's 1:50m countries and populated places (and 1:10m states and provinces) into `.cache/basemap/`.
- `world [--width 8192]`: writes the shared base map.
- `crop <world> --bounds W,S,E,N [--width 2400]`: cuts a world's picture from the full source (sharper than the creator's cut for a small area). A world that already has a projected map keeps its regions, places and rooms, moved onto the new picture.
- `regions <world> [--from countries|states] [--pick "France, Italy"] [--within] [--places capitals|cities] [--wiki]`: adds today's countries (or states) to a world on a projected map: outlines fitted to its picture, simplified, small islands dropped, neighbours from shared borders, each region's Wikipedia page (`--wiki` looks the titles up on Wikidata), and the capitals or cities as places. Importing again updates the regions by their `key` and keeps their other fields. A start without a region is put in the first one (change it in the Map tab). Today's borders are a starting point for other eras: redraw, merge or split them in the creator.

## Lore

Task 5-1. A lore entry is public world knowledge, chosen per turn so a big world fits a small context (how it is chosen: `docs/DESIGN.md` › Lore).

```json
{ "id": "rim-work", "title": "Working on the rim", "level": "region", "ref": "crater-rim",
  "keywords": ["EVA", "dust devil", "ice drill"], "priority": 3,
  "text": "Every trip outside needs two people, a filed route and a suit check...",
  "sources": [{ "title": "Where this came from", "url": "https://example.org/page" }] }
```

| field | notes |
|---|---|
| `id` | lowercase letters, digits, `-` or `_`; unique across the world and its starts (a start's entry with the same id replaces the world's) |
| `title` | up to 80 characters; shown to the model before the text |
| `level` | `world`, `region`, `location`, `character` or `topic` |
| `ref` | for `region`, `location` and `character` entries: the region, room or character it is about (a region or character must exist; a room that no start has is only a warning, since generated starts and sites make their own). Not allowed on `world` and `topic` |
| `keywords` | up to 12 words or phrases (40 characters each). Matched as whole words, ignoring case, in the player's action and the last scene. Include aliases: nicknames, titles, other spellings |
| `text` | up to 800 characters; 40–80 words on one topic works best |
| `priority` | 1–5 (default 3); higher wins when the budget is tight |
| `alwaysOn` | `world` entries only: always in the prompt header (keep these few and short) |
| `sources` | optional `[{title, url}]`; for the creator, never sent to the model |
| `draft` | `true` while the entry waits for review (from the research helper or an imported packet): validated, but the game ignores it until it is accepted in the creator |

**Lore is public.** It reaches the narrator, which never sees secrets, so anything secret belongs in a character's `secret` or in private facts, and anything that hasn't happened yet as of the start belongs in the canon timeline, never in lore. Validation enforces the first part: an entry that shares 4 or more content words with someone's secret is an error.

`mars-station` keeps its entries inline in `world.json`; `zombie-holdout` keeps them in `lore/town.json` and `lore/store.json` (packets) and lists `"lore": ["town", "store"]`.

## Canon timeline

Task 5-2. Events that happen at a set time whatever the player does, unless the story has broken them (how they play: `docs/DESIGN.md` › Canon timeline).

```json
{ "id": "convoy-checkpoint", "when": { "day": 26, "hour": 9 }, "scope": "regional", "region": "junction",
  "text": "The rescue convoy reaches the highway junction and sets up a checkpoint under the overpass.",
  "visibility": "heard", "effects": { "control": [{ "region": "junction", "to": "convoy" }] },
  "preconditions": [{ "controls": { "group": null, "region": "junction" } }], "onBroken": "diverge" }
```

| field | notes |
|---|---|
| `id` | lowercase letters, digits, `-` or `_`; a start's event with the same id replaces the world's |
| `when` | `{day, hour}`, whole numbers (hour 0–23), on the same clock as the start's `start`. Before the start it is the **past** |
| `scope` | `regional` (needs a `region` when the world has regions) or `world` (`region` optional) |
| `text` | up to 240 characters, as the news will say it |
| `visibility` | `heard` (default), `seen` or `hidden` (only the people in `who` learn of it, as a private fact; it changes nothing public) |
| `who` | optional character ids involved |
| `effects` | as for events: `world`, `groups`, `clocks`, `new_clock`, `control`, `add_tag`, `remove_tag`, `region_status`; checked when it happens |
| `preconditions` | all must hold when it comes due: `{"alive": id}`, `{"controls": {"group": id or null, "region": id}}`, `{"clock": id, "atLeast": n}` (or fired), `{"world": key, "is": "value"}`, `{"known": "event id"}` or `{"known": {"words": [...]}}` with optional `"by": id` (default the player), `{"not": {...}}` |
| `onBroken` | `drop` (default: it doesn't happen) or `diverge` (the model writes what happens instead) |
| `draft` | `true` while the event waits for review (from the research helper): validated, but it never happens until accepted in the creator |

**The past** becomes public facts and a "Before the story" chapter at New game; hidden past events become private facts for `who`. Past events don't use `effects`, `preconditions` or `onBroken` (a warning): write the world as it is at the start. **The future** never reaches a prompt before it is due, so lore and descriptions must not mention it either. A public event that shares 4+ content words with someone's secret is an error, as for lore.

**Projected events.** When nothing is planned for the next few days (`projectTimeline.days`), the model plans 1–`max` likely public events in that window, from where things stand and the timeline so far (its spacing sets the pace). They are checked like authored ones (dates in the window, real ids, no secrets, no one dead, no repeats), kept in the save (`state.timeline`) and play like canon events, without preconditions. So a school world whose canon ends at the spring festival goes on to the next exam or Golden Week, and a world with no future timeline gets one.

`mars-station` and `zombie-holdout` each have a past and future events with preconditions, one of which diverges.

## Saves

- Bump the state `version` to `2`. New states store `scenario.worldId` and `scenario.startId`.
- `Engine.migrate(state)` runs when a game is loaded (from browser storage or a file). For version 1 it sets `worldId = scenario.folder || scenario.id`, `startId = 'default'`, and `version = 2`. Nothing else changes, because the composed scenario has the same shape. A state with no `version` counts as 1.
- Migration is a chain (`Engine.migrations[n]` takes version n to n + 1; `Engine.STATE_VERSION` is the current one), each step tested. The undo copy inside a state is migrated too. A save from a newer version is refused with a message. Replay fixtures are migrated before they play.
- Later tasks added steps the same way; task 4-4 took it to `12` (`sites`, and `site` on generated rooms; older saves get `sites: {}`), and task 5-2 to `13` (`canon` outcomes and projected `timeline` events; older saves get none and `projection: false`, so they never start projecting).

## The picker

1. **World**: title, summary and tags (`index.json` order; "Open folder" adds more).
2. **Start**: title and summary for each start, the default selected. If a world has one start, this step is skipped.
3. **Make my own start** (task 4-2): a world with `generatedStarts`, or with no starts (R-0), adds "✦ Make my own start" after its starts; New game then opens the generator.
4. **Who you play** (task 4-1): a start with a `playerSlot` adds a third select, "Play as <name>" (when it has a `player`) or "Make my own". New game with "Make my own" opens the character form; Start game there begins the game. Generated starts (task 4-2) will add their own entry.

Phone layout: two stacked selects, nothing more.

As built (task 1-3): two selects in the top bar, the start one hidden when a world has a single start. On desktop a line under them shows the world's title, summary and tags and the picked start's summary; it folds away once a game is running and comes back when either select changes. Server worlds are all loaded when the page opens (so a broken world or start is visible before New game) and the picked one is fetched again at New game, so edited files show up without a reload. A broken world or start is labelled "(has errors)" and the line shows the validation error; New game on it shows the same message and starts nothing. The last world and start are remembered (`ensemble.pick` in `localStorage`). The scene bar shows the world title, with the start title on desktop, and save and recording file names use both titles (`ensemble-ares-deep-sol-214-the-mule-turn3.json`).

## Reserved fields policy

`S.validateWorld` and `S.validate` **accept and ignore** the reserved fields listed above (none at the moment), so creators can write content before the engine uses it. Unknown fields that aren't reserved are also accepted, but reported as a warning in the console and the Debug panel (a typo like `oppening` shouldn't silently do nothing). Warnings cover `world.json`, start files, cast entries and legacy `scenario.json`; character files aren't checked, since later phases add many character fields. `npm run check` prints them too.

## Tests

In `tests/worlds.test.js` (task 1-1), except the picker smoke test (task 1-3):


- Composing: the scalar, id-list, string-list and object merge rules, each with a small inline world.
- A cast entry overrides location, relations and knows; a plain id uses the file.
- `validateWorld`: missing start file, cast id not in pool, player not in cast, duplicate ids.
- The minimum world (R-0, `tests/minimum-world.test.js`): only a title and a setting validates, composes and starts a generated game; so does the same world with a few regions.
- The region tree (R-1, `tests/regiontree.test.js`): chain, children and nearby on a branch-deep tree; validation in plain words; who holds a parent; the header outline stays the same across turns and moves; the user message doesn't grow with the tree; lore, event ideas and new places up the chain; the map and the creator; every bundled and fixture world still loads.
- A legacy folder composes to the same scenario it produced before (snapshot of the `newGame` state's characters, locations and clocks).
- Every bundled world validates with no warnings, and every start in it starts a game and plays a turn.
- Each converted bundled world's default start begins the same game as its legacy version.
- Save migration v1→v2.
- UI smoke: pick world, pick start, play a turn against the mock server.
