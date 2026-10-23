# Roadmap

The plan from here to a game that can host any kind of story: a Mars crew, a zombie holdout, a French resistance cell, an anime high school, a family in the suburbs, or a hobbit in a world someone else built.

**How to use this file.** Work top to bottom; phases depend on the ones before them. Check items off as they land (`[x]`) and move finished phases to **Done** with a one-line summary. If a phase changes shape while you build it, edit the plan here first.

## Principles for every phase

- **Playable on the reference setup.** Each phase has to work on the 12B model with 8K context (see `CLAUDE.md`). Bigger worlds stay affordable through cast tiers, lore that's only included when relevant, and putting only the scene's map state into prompts.
- **Prompts suggest, the engine enforces**, and that includes generated content. Generated characters, rooms and sites go through the same validation as hand-written ones, and the player reviews them before play.
- **Prompt cache layout (rule 7).** Static content (geography, lore titles, cast) goes in the system header. State that changes during play (who controls a region, tags, moods, standees) goes in the user message.
- **No AI-generated art from us.** Portraits and maps come from scenario creators. Generated characters use a stand-in portrait set with a license compatible with a paid build (CC0 or similar, credited in `CREDITS.md`).
- **Shipped scenarios are original.** Players can build whatever world they like (`MODDING.md`).
- **Nothing old breaks.** Old scenario folders and saves keep loading through a migration step. Every new field gets `Scenario.validate`, a line in the README's scenario format section, and a test.
- **Ids are opaque and stable.** Never derive behaviour from an id's text, since generated content will have ids like `extra-3`.
- **Display text stays out of the engine.** Labels like "on edge" come from scenario or default tables, so genres can retheme them.

## Done

- [x] **Core loop.** Intent → resolve → narrate → update, with the engine owning facts, validating and clamping model output, and reporting rejections in Debug.
- [x] **Secrets and knowledge.** Guards (low/medium/high), leak detection, and `known_by` on every fact; the narrator never sees secrets.
- [x] **Time.** Five time steps, beats with time markers, step in / next, filling short scenes, and the "until something major happens" downtime skip with clocks and `then` chains.
- [x] **Events.** Local, regional and world tiers, rationed by `tiersDue`, with effects on world status, group stance and clocks.
- [x] **Memory.** Chapters, fact budgets scaled to context, memory cap, and committing memory at the start of the next turn.
- [x] **Backends.** Local and external presets, per-step routing (Hybrid), JSON salvage and retry, first-run setup.
- [x] **Two scenarios.** Ares Deep (Mars) and the zombie holdout; engine and UI smoke tests.
- [x] **License setup.** PolyForm Noncommercial, `CONTRIBUTING.md`, `MODDING.md`.
- [x] **Groundwork** (tasks G-1 to G-3). Cast lists go through `Eng.cast`/`present`/`offstage`; event effects are a handler table (`Eng.EFFECTS`) with rejections reported in Debug; prompts are built from named blocks (`P.blocks`/`P.layouts`) with the live header blocks kept last; cast cards are built from one function per section; `Scenario.validate` ignores fields it doesn't use yet. A prompt snapshot test pins every prompt.

## Phase 0: Playtest tools

Every later phase needs fast testing against a real model, and turns take 30–60 seconds.

- [x] **Undo last turn.** Restore the state from before the last action (one level, `state.undo`).
- [x] **Reroll narration.** Keep the intent and resolution, and only rewrite the scene.
- [x] **Turn telemetry in Debug.** Tokens in and out per call, cache reuse (cached tokens where the provider reports them; KoboldCpp's prompt processing time from its perf endpoint), seconds per step, and which guards fired.
- [x] **Suggested actions** (task 0-5). A 💡 Suggest button asks for 3–4 ideas from what the player knows; clicking one fills the action box, and the player still acts.
- [x] **Turn recorder and replay tests.** Export a session's raw model responses as a fixture, and add a fake backend that replays them so a real bad log becomes a regression test. Fixtures live in `tests/fixtures/`.
- [ ] **Validation pass (carried over; needs the real model, task 0-4).** Play every time step on the reference setup; run several major-event skips in a row; compare Hybrid with all-local; tune reveal thresholds, event rates and scene lengths; play the zombie holdout end to end.
- [x] **Reveals must carry the secret.** Playtest 2026-10-21 (DeepSeek, Ares Deep): Teo's intent put his deflection ("probably just a bubble in the line") in `reveals`; the guard allowed it on stress alone, so prompts listed a non-secret under REVEALS. A reveal that shares no content word with the secret or private facts is now dropped (`reveal dropped` guard; no recording was kept, so the test builds the turn by hand).
- [x] **Flaky UI check.** "portraits, minimized cards and the details view" timed out about one run in five. Cause: New game loads the world asynchronously without going busy, so a test (or a player) could press Act before the game existed and the action was silently dropped. New game is now busy while it loads, and the UI tests wait for turn 0 before acting (`newGame()` in `tests/ui.smoke.mjs`).
- [x] **Mood repeats.** The update step re-set near-identical moods ("clipped and businesslike, eyes fixed on the weather relay" → "clipped and fixed on the weather relay"). A mood sharing three quarters of the shorter one's content words with the current one is now rejected (`Eng.sameMood`), so the turn it was set stays meaningful.

## Phase 1: Foundations

The format change everything else builds on, plus visible improvements to the character cards.

**World and Start split**
- [x] A **world** holds the setting, rules, genre tags, groups, the skill and needs definitions, and event rates. (Its map comes with phase 3, its lore and timeline with phase 5; the fields are reserved in `docs/WORLDS.md`.)
- [x] A **start** is one way into that world: where the player begins, the player character, the local cast, the local rooms, the start date and opening situation. (The region comes with phase 3; a slot to fill in and allowed roles or peoples with the character creator in phase 4.)
- [x] Folder layout: `scenarios/<world>/world.json`, `starts/<id>.json`, `characters/<id>.json`, plus later `maps/`, `lore/`, `portraits/`. The scenario picker becomes a world picker, then a start picker.
- [x] A `format` field on world files, and a migration that loads today's `scenario.json` as one world with one start. Bump the save `version` and migrate old saves.
- [x] Write `docs/WORLDS.md` (spec for the split) before coding.

**Genre and mood tags**
- [x] `tags` on the world (for example `survival`, `slice-of-life`, `romance`, `intrigue`, `war`, `horror`, `comedy`, `cozy`, `grim`) plus a freeform `toneNote`.
- [x] Engine-owned guidance blocks per tag: narrator tone and pacing, what counts as "major", how lethal danger is, and default event rates. These go in the static header.
- [x] Audit survival-specific assumptions: the injury and exhaustion penalties, needs being required, and event seeds that assume danger. A scenario with no needs at all must work.

**Character presentation**
- [x] The card leads with portrait, name, role, a **mood** line and **tags**. Needs bars move into an expandable details section; the raw numbers are also shown in Debug.
- [x] **Derived tags** come from engine numbers (stress ≥ 0.8 shows as "on edge", fatigue ≥ 0.8 as "exhausted", plus health). Thresholds are per scenario and have defaults.
- [x] **Freeform tags and mood** are proposed by the update step and validated: at most 4 per character, a short phrase each, an expiry in turns, and a reason logged in Debug.
- [x] Optional `portrait` on characters (a path inside the world folder). Characters without one get a stand-in from the world's `portraitSet`, chosen deterministically by id so it never changes, or a monogram.
- [ ] **Bundled stand-in portrait set** (waiting on the owner's pick): pick a CC0 (or similarly permissive) set with the owner, credit it in `CREDITS.md`, and use it when a world has no `portraitSet` (monograms until then; see the open question below).
- [x] Cards can be minimized (to a portrait, name and mood row), remembered per character in `localStorage` with the usual try/catch.
- [x] **Character details:** description, appearance, pronouns, and what the player knows about them (player-known facts that name them).
- [x] **Correct your feelings:** nudge your own attitude when the model misreads your tone.

**Themes and accessibility**
- [x] Themes in Settings › Appearance: Dark (today's), Light, **High visibility** (high contrast, no colour-only meaning, strong focus outlines) and System.
- [x] Text size, story font (serif or sans), line spacing and reduce motion; applied before first paint.
- [x] Contrast check for every theme in tests; `aria-label`s on icon-only buttons.
- [x] Screen readers: announce new beats and scene text through an `aria-live` region, and check the reading order of a turn.

## Phase 2: Cast tiers

Lets big casts fit in 8K and makes the world move without the player.

- [x] **Local** characters (in the scene, named by the player, or flagged important) get the full simulation: an intent each turn, needs, and full presence in prompts.
- [x] **Secondary** characters get a one-line brief and an **agenda**: a goal, its steps, progress and a pace. "Keep routine" is a valid agenda. The engine advances agendas between turns, like clocks; the model only writes a step when one completes, as a local or hidden event. (Tasks 2-1 and 2-2.)
- [x] **Promotion and demotion** rules live in the engine: a character becomes local when they enter the scene, are named by the player, or their agenda brings them into contact. They drop back to secondary after N turns without appearing. Every change is shown in Debug. (Agenda contact steps since 2-2.)
- [x] **Pin from the card**: 📌 Pin under a card's Details keeps someone local (`Eng.setPinned`, capped at `maxLocal`, kept through a step-in, recorded for replays).
- [x] **Extras**: one-line stubs (name, role, location) with no sheet. When promoted, one generation call turns an extra into a full character, validated and kept from then on. (Task 2-3; a group, like a patrol or the herd, can be one extra and never promotes.)
- [x] **Relationship web** (from the old Later list): a small graph of how people feel about each other, local characters first. (Task 2-4: feelings between others show only once a fact you know involves both.)

## Phase 3: Maps

Pax Historia's map at personal scale: World → Regional → Local.

**Data**
- [x] **Regions**: id, name, a controlling group, tags ("occupied", "famine", "battle", "quarantine"), a status line, neighbours, and a `lore` entry. In the lore hierarchy, regions carry the most detail and the world only the broad context (the Shire doesn't need Mordor's politics).
- [x] Every location gets a `region`. Locations are the local level.
- [x] Event effects gain `control` (a region changes hands), `add_tag`/`remove_tag` on regions, and `region_status`, all rationed by `tiersDue` like the existing effects.
- [x] Prompts get static geography in the header, and the control and tags of the current region and its neighbours in the user message only.

**Local map: tokens on nodes**
- [x] Every character is a **token** on a location node, named characters and **standees** alike.
- [x] **Standees** are unnamed groups such as gang members, guards or a mob: label, count, location, state (calm, alert, hostile, fled, down). The engine tracks them; the model can propose moves, count changes and state changes, and the engine validates and clamps them. A standee can be promoted to an extra or a named character when the player singles one out.
- [x] **Guard posts and patrols**: standees can hold a post or follow a patrol route through the room graph; whether the player is seen depends on who is in or next to their room.

**Site layouts: the model describes, the engine draws**
- [x] **Site data**: rooms (size, purpose, features), links with a kind (`open`, `door`, `locked door`, `vent`, `hatch`, `window`, `stairs`), entrances from outside (watched or not), and stateful features the engine tracks (a door locked or open, a camera on or off). The model never draws: grids and ASCII from a 12B are unreliable, and a drawing can't be validated.
- [x] **Layout styles** per site type in a DOM-free `js/layouts.js`: deterministic placement from sizes and links, so the same site always lays out the same way and survives saves. Built: `generic`, `hall` (warehouse, store), `corridor` (apartment floor, station ring).
- [x] **SVG floor plan**: walls, door gaps, locked-door, vent and hatch symbols, labels and tokens, in theme colours (high visibility included), never generated art.
- [x] **What the player has seen**: unknown rooms aren't drawn; a "?" marks where a known opening leads. A room shows once entered, seen or revealed (a floor plan bought from a fixer is a real advantage).
- [x] **Detailed local maps with fog** (task 3-7): floor plans with walls, doors, windows, floors and furniture chosen by inferred room kind, still procedural SVG and deterministic. Rooms in view get full detail, remembered rooms structure only (no feature state the player didn't see), and unknown rooms aren't drawn. Decoration is visual only; only features from the data are gameplay. Includes a "Map detail: simple / detailed" setting.
- [x] **Movement follows links**: you can only step into a room linked to the one you're in. Naming a farther room walks the route (`Eng.route`) through the rooms in between, and each one counts for time and for being seen; a locked link blocks the route until it's opened.
- [x] **Authored features are the truth**: doors, windows, vents and objects a map maker placed are what exists, and the game goes off them.
- [x] **Inferred features**: where the map is silent, the model may propose a plausible feature when the player tries to use one ("I climb out the window"). The engine accepts it only if it doesn't contradict the map: windows only on exterior walls (the layout knows which those are), never into a secure room, and never over a feature the author placed. Once accepted it's recorded on the site, so it's there next time and for everyone.
- [x] **Secure rooms** (`secure: true`, defaulted for types like vault, armory, cell, server room): exactly one way in and out, through a guard post, security point or hallway. Layout styles place them as dead ends, generation is rejected if it gives them a second link, and inference can never add one.

**Views**
- [x] **World view**: the map image with creator-drawn region polygons coloured by controller, and tag badges. Without an image, a node map laid out automatically.
- [x] **Regional view**: the world view zoomed to the current region and its neighbours.
- [x] **Local view**: the room graph laid out automatically from `connects`, or an optional floor-plan image with room hotspots, showing tokens. Clicking a room or token fills in the action box ("go to the lab", "talk to Teo").
- [x] Phone layout: one view at a time with a switcher.

**First creator tab**
- [x] `creator.html`, the **map editor**: load an image, draw and edit region polygons, set controllers, tags and neighbours, place locations, and export JSON. Shares `scenario.js` validation.

## Phase 4: Creation and generation

Make your own character and start, and have the engine fill in the world around you.

- [x] **Character creator**: a form producing the same character JSON: name, pronouns, description, appearance, role, people or origin (from the start's allowed list, or freeform), traits, voice, skills (point-buy within the world's skill list), want, an optional secret, and a portrait from the world's set or the stand-in set.
- [x] **Generated starts**: the player picks a world, a region and a role. Generation runs as small calls, each validated before the next: local rooms, then the cast one character at a time, then relationships and tensions, then extras and standees, then the opening situation.
  - **Plan first, then fill in.** Call 1 writes a skeleton: setting summary, tone tags, groups, skill list, and a cast plan with one line per slot ("the station lead with something to hide"). Each later call fills one slot, which keeps characters distinct.
  - **Carry a compact summary forward**, not full JSON: premise, skeleton, and one line per item already made (id, role, key trait, secret hint).
  - **Relationships and secrets get their own pass** after all characters exist.
  - **Validate and retry per stage**, not the whole run; one bad character is regenerated alone.
  - **Checkpoint after each stage**, so a failure or a closed tab resumes where it stopped, and show progress ("Places ✓, Characters 3 of 5…"). A full world is roughly 10–15 calls on the reference 12B setup.
  - **Call size depends on the backend**: a large API model can do the whole cast in one call; a local 12B gets one character per call. One pipeline, with a granularity setting.
  - Stage order: skeleton → places → characters (one per call) → relationships and secrets → clocks, follow-ups and event seeds → opening scene → engine validation → review screen. Each stage only depends on earlier ones, so any piece can be rerolled from the review screen.
  - The same pattern applies to lore research (phase 5): one source page per call.
  - [x] Left over from 4-2: the ties step now gives each pressure an optional follow-up (`then`) and up to 3 regional event ideas for the start (`eventSeeds.regional`, ahead of the world's), with the same leak check as pressures; both show in the review.
- [ ] **Real-place map import** (task 4-5; a `tools/` script or Claude Code skill, outside the game, like the lore research helper): builds a world's regions and locations from open data, for **open-world "make your own start" worlds** (the real world, the US, Mars). Story-driven worlds keep hand-made maps.
  - **City maps** work at either scale. Inside a big world they're the regional level. For "live your life" worlds (a school slice-of-life, a zombie outbreak in one town) **the city is the world map**: districts and neighbourhoods are regions, and the local level is a building, a street or a block. The three map levels are relative, not fixed to planet → country → room.
  - Sources: Natural Earth (countries, provinces, cities; public domain), US Census boundaries and places (public domain), the IAU/USGS list of Mars features (public domain), Wikidata coordinates (CC0), and OpenStreetMap or city open-data portals for cities (OSM is ODbL: attribution required and shared extracts stay ODbL, so check before bundling anything in a paid build).
  - Steps: name the place and detail level → fetch → project onto the creator's image (or draw a plain base map from the boundaries, avoiding image licensing) → simplify borders → compute neighbours from shared borders → write region and location data with `credit` and `license` → check and adjust in the map editor (3-5).
- [x] **Review screen**: edit or reroll any generated room or character before starting. The result can be saved as a reusable start.
- [x] **Generated sites**: on-the-fly local maps for places the story goes (a gang base, a corporate floor, a ruined farmhouse), with rooms, named characters, standees and loot. They're attached to a region and either kept or discarded after the visit. Triggered by the player's intent (`move_to` an unknown place) or by an event.
  - **Library first**: look for a matching authored site map (below) by type, tags and size. If one fits, use its layout and have the model fill in only the people, names and details. Otherwise generate the site data and let the layout styles draw it.
  - Generation produces the site data described in phase 3 (rooms, links with kinds, entrances, features, people with posts or patrols), validated before use; a bad piece is regenerated alone.
- [ ] **Site map library** (task 6-3, with the site map editor): authored maps (battlemaps, floor plans) that creators and modders draw and tag once, for reuse by any story that needs that kind of place.
  - A site map is an image plus data: room shapes drawn on it, doors and their kinds, entrances, spots (guard post, cover, hiding place, loot), and an optional grid scale for battlemaps. **Grids are for measurement only** (room sizes and distances the narrator can use: "the guard is thirty feet away"), never for movement: play stays free-form, not a tactics simulator.
  - Tags for matching: `type` (warehouse, tavern, starship deck…), genre and setting tags (cyberpunk, fantasy, modern), size and room count.
  - Sources, in order: the world's own `sites/` (done in 4-4, with matching by type and tags), then a shared library folder (bundled maps plus ones the player adds with Open folder). The pick among matches is deterministic, so a reload picks the same map.
  - Every map carries `credit` and `license`. Bundled maps are original or CC0; shared maps are their creators' responsibility (`MODDING.md`).
- [x] Generation is a routable pipeline step ("world building") so it can go to an API model when one is set up. (Every start, site and flesh-out call is a `worldbuild (…)` kind, routed with Settings › World building.)

## Phase 5: Lore and canon

- [x] **Lore entries** at four levels (world, region, location, character): title, keywords, text and a priority. Regions are the heaviest level. The world gets a short always-on summary in the header; other entries go in the user message only when triggered (the player's region, the location, people present, or keywords in the player's action or the recent scene), within a budget (around 10% of context).
- [x] **Canon timeline.** Past events seed facts and a "chapter zero" summary. Future events are dated, with **preconditions** the engine checks (a character alive, a group controls a region, a clock above a value, a fact known). They fire on their date as a regional or world event, outside the normal rationing. When a precondition breaks, the creator chooses per event: `drop`, or `diverge` (the model writes the altered version).
- [x] The downtime skip treats the next canon event as a stopping point, like a clock.
- [x] **Projected events**: when nothing is planned for the next few days, the model plans a few likely public events (an exam, Golden Week, a delivery) from where things stand and the timeline's pacing, checked like authored ones; worlds can turn it off or tune it (`projectTimeline`). Covers worlds whose canon has run out and worlds with no future timeline at all.
- [x] Creator tabs: lore editor and timeline editor.

**Lore from wikis and other sources**
- [x] **Lore sources**: optional `sources` on each entry (title + URL). Shown in the creator, never sent to the model.
- [x] **Lore packet import**: a `lore/` folder of entries that outside tools can produce, validated like everything else and reviewed in the lore editor before use. (Entries marked `"draft": true` wait for Accept in the Lore tab; the game ignores them until then.)
- [x] **Research helper** (`npm run research`, `tools/research.mjs`: outside the game, but running the game's own engine and model code, so it uses the local KoboldCpp or an external API like the game; the biggest model available does it best, since it's a one-time authoring step). **All web work happens at build time** (authoring a world, or importing a real place), never during play: play stays offline apart from the model backend, sends no place names anywhere, and never waits on a fetch. A place the story reaches without lore is handled as generated sites are, from the model's own knowledge, checked by the engine.
  - **What to research comes from the world, not from crawling.** Lore is for what the model doesn't know or would get wrong about this world: the places the story uses, its groups and people, where it differs from reality, things after the model's training cutoff or too obscure for it. General knowledge (grasshoppers, how cars work) is never researched. The helper builds a topic list from the world data (regions, groups, named characters, starting areas, tags and setting); the creator approves or trims it, and only those topics are fetched. It never follows links.
  - **Relevance and caps**: an entry must connect to something in the world (a region, group or person, or a keyword the story will likely use); generic encyclopedia facts are dropped. A few entries per region and topic (about 3–5), and few world entries.
  - Optional: ask the model about a topic first ("what do you know about …"), and skip the topic when its answer already matches the source.
  - Real places: the real-place map import (task 4-5) fetches each region's Wikipedia summary along with its boundaries, and the helper turns those into lore for review.
  - For each source page it:
    - writes entries **as of the start date**; anything later goes to the canon timeline as dated future events, never into lore (otherwise the narrator "knows the future");
    - splits **secrets** out of public lore into character `secret` fields or private facts, since lore can reach the narrator and the narrator must never see secrets;
    - writes **small entries**: 40–80 words, one topic each (a person, place, group or custom); a long page becomes several entries;
    - lists **keywords including aliases** (names, nicknames, titles, spellings), since matching runs on the player's own words;
    - tags each entry's **level** (world, region, location, character) and keeps the page URL in `sources`;
    - summarizes **in its own words**, with no copied text (Wikipedia and most fan wikis are CC BY-SA, which would attach share-alike terms to copied text).
- Franchise worlds built this way are fine for players' own play and mods; they are never shipped, bundled or featured (see "Shipped scenarios are original").

## Phase 6: Creator suite

Everything a creator needs to build a world without touching JSON.

- [ ] Tabs: World (setting, rules, tags, skills, needs, event rates), Groups, Map (from phase 3), Sites, Lore, Timeline, Characters, Starts, Portraits. (All but Sites done; Sites is 6-3.)
- [ ] **Site map editor** (Sites tab): load a battlemap or floor-plan image, draw room shapes, mark doors and their kinds, entrances and spots, set the grid scale, tag it, and save it to the world's `sites/` or export it for the shared library. Also: open a generated site and save it as an authored map.
- [x] **Character editor**, including **character card import** (SillyTavern/Tavern PNG or JSON): one conversion call, a review step, then add to the cast. It keeps the card's personality and drops the card's original scenario framing.
- [x] Export as a folder (or a zip); import an existing world to edit it; validation errors shown inline. (task 6-1)
- [x] Test play: start the edited world straight from the creator. (task 6-1)

## Phase 7: Genre proof

- [ ] Two new original scenarios in very different genres, such as a resistance cell in an occupied city and a high-school slice-of-life. At least one uses a map image with regions, and one uses generated starts.
- [ ] Fix whatever turns out to be survival-specific. Add a test named after each fix.
- [ ] More layout styles (`office floor`, `club`, `compound`, `sewer`, …) for `js/layouts.js`, added when a new world's generated sites need them (from phase 3).
- [ ] More room kinds for the detailed map (3-7), added with the new settings (worlds) that need them: sci-fi (engine room or reactor, cryo, hangar; "cargo"/"hold" as warehouse) and medieval (great hall, chapel, forge, stable, throne room, courtyard). Break ties with the world's genre tags first ("hall", "bridge", "keep" mean different rooms in different genres), with tests that pin those words per genre.

## Content settings

No phase dependency (it builds on the genre guidance blocks from phase 1); must be done before publishing.

**Principle (owner's position):** Ensemble doesn't police content beyond what the law requires or what a service we depend on requires. Adults choose their own stories. Tasteful 18+ roleplay is a supported use.

- [ ] **Content rating**: `contentRating` on worlds (next to genre tags) and a player maximum in settings; the effective level is the lower of the two. It selects a narrator guidance block (e.g. fade to black vs explicit allowed), like genre tags do.
- [ ] **Mature content is opt-in**, off by default.
- [ ] **Character age**: an `age` (or `adult: true`) on characters, required by validation once a world allows mature content.
- [ ] **Hard rule in every mode, including bring-your-own API and local models**: when mature content is on and any character in the scene is under 18 or has no age set, the engine forces fade-to-black guidance and drops romantic or sexual intents involving them. A test pins it. Local roleplay models often have no guardrails, and the engine is the only layer that knows who's in the scene, so this lives in the engine.
- **Hosted service only (Side B, later):** moderation on both input and output; only route to model providers whose terms allow adult fiction; real age assurance where required (UK and several US states); a payment processor that allows adult content.

## Voiced narration

No phase dependency beyond mood tags (phase 1, done). Reuses StreamTTS pieces.

- [ ] **TTS backends**, like LLM backends: off, Piper locally (the hobbyist default), a hosted TTS provider (bring-your-own key), and later the paid side's bundled catalog.
- [ ] **No separate transcript.** The narrated scene is the script; split it into narrator lines and dialogue.
- [ ] **Speaker attribution**: heuristics first (`"…," Teo says`, using present characters' names and pronouns), then one small JSON call per scene for unresolved lines, validated against the present cast. It can run on the local model even when narration is external. **Don't ask the narrator to tag speakers in the prose**: models leak tags (see the "id tags in prose" playtest fix).
- [ ] **Per-beat audio**: synthesize the beat being read and prefetch the next; step-in points keep working.
- [ ] **Voice per character**: a `ttsVoice` id with a provider prefix (`piper:<model>`, `elevenlabs:<id>`, `ensemble:<catalog-id>`), separate from the existing `voice` text field (speaking style), plus a narrator voice per world. Characters without one get a voice picked deterministically from a pool by id (like stand-in portraits).
- [ ] **Mood to delivery**: mood tags (e.g. "on edge") map to speaking style on providers that support it.
- [ ] **Cache audio per beat** in the save, so scrolling back or replaying doesn't synthesize again.
- [ ] **Hosted enforcement**: when the TTS backend is our hosted service, only `ensemble:` catalog voices are accepted; anything else falls back to the deterministic pick. Bring-your-own keys accept any voice the player sets up.

## Later

- **Director**: tension tracking that nudges events up or down to keep pacing interesting.
- **Streaming narration**: show the scene as it's written. It doesn't depend on any phase, so it can go in whenever there's a gap.
- **Arc memory** for long campaigns: summarize every ~5 chapters into an arc, keep weight-3 facts verbatim, and give each character a running "history with you" line.
- **Save slots and autosave**, and an in-game **journal** (what you know, by person, and the chapters).
- **Endings**: optional win/loss/epilogue conditions on clocks, regions and timeline events, with a closing "what became of everyone" scene.
- **Inventory and resources**, owned by the engine.
- **Positions inside a room** (doorway, cover, back wall) for a more hands-on feel; site layouts already give every room coordinates. Decide after playing with tokens (from phase 3).
- **Remembered feature state**: remember each feature's last-seen state (as `state.known` does for people), so a remembered room shows the cabinet as you left it. Today remembered rooms show features with no state, and doors out of sight show as plain doors (from phase 3).
- **Promises ledger**: the engine tracks what the player committed to, with deadlines.
- **Stream mode**: Twitch chat votes on the player's action.
- **Installable app (PWA)** and optional save sync to the player's own cloud drive.
- **Native port** (e.g. Godot) if it outgrows the browser; the JSON state and prompt chain port as-is.

## Open questions

- Should random major events have a minimum delay, or is "anything can happen" the right feel? (Current answer: anything goes; the skip means "let's see what happens".)
- Standees: is room-level placement enough, or does the local level need positions inside rooms? Decide after phase 3 playtesting.
- ~~Generated sites: keep them on the map permanently, or let them fade unless revisited?~~ Answered in 4-4: they fade unless something notable happened there (a weight-2 fact, a second visit, someone from there joining the cast), back to a stub that a return rebuilds.
- ~~Canon `diverge`: how much freedom does the model get when rewriting a broken canon event?~~ Settled in 5-2: the same occasion at the same time, rewritten given what broke; the model writes the text and proposes effects, which the engine checks like any event's.
- Stand-in portraits: which CC0 set, how many, and how to cover a range of genres (modern, historical, sci-fi, fantasy)?
- Recommended API models for narration quality vs cost.
- Hosted TTS: cost per turn and how to budget it (priced by characters, like tokens).
- Which TTS providers' voices are licensed for commercial bundling?

## Before publishing

- [x] License: PolyForm Noncommercial 1.0.0 (`LICENSE`), contributor terms (`CONTRIBUTING.md`), mod policy (`MODDING.md`).
- [ ] Check the name "Ensemble" for conflicts.
- [ ] Short privacy note: everything stays in the browser; API calls go directly to the provider the player chose.
- [ ] **Hosting**: turn on GitHub Pages for the repo so the game has a link for phones and friends.
- [ ] `CREDITS.md` for any bundled portrait or icon sets, with their licenses.
- [ ] Before selling anything: a short EULA for the paid build, and a quick legal review of the license setup.

## Revenue (low-key, optional)

A long-term possibility, not a plan of record.

- **Side A (now):** the public GitHub project. Free, open (PolyForm Noncommercial), set it up however you like. Ko-fi or donations; possibly a paid one-click desktop build (KoboldCpp and a model bundled) later.
- **Side B (much later, only if Side A shows real demand):** a separate site focused on convenience. A subscription for an out-of-the-box setup, a community hub for user-made maps, worlds and characters, a curated voice catalog for narration, and hosted tokens with a small free daily allowance as a loss leader (free tier on a cheaper model; paid tiers get the stronger narrator).
- Side B is a different kind of project: inference and TTS costs, accounts, billing, moderation, age assurance, privacy (GDPR), and hosting user uploads with a takedown process and a registered DMCA agent. Form an LLC and get a legal review of the terms before launching it.
- **Order:** Side A with real players → community on existing platforms (Discord, itch.io/GitHub) → paid desktop build → Side B.
- **A lighter Side B to consider:** a subscription for the polished app, the hub, cloud saves and premium content, with play on the user's own GPU or key and hosted tokens as an optional add-on.
