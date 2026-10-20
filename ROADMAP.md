# Roadmap

The plan from here to a game that can host any kind of story: a Mars crew, a zombie holdout, a French resistance cell, an anime high school, a family in the suburbs, or a hobbit in a world someone else built.

**How to use this file.** Work top to bottom; phases depend on the ones before them. Check items off as they land (`[x]`) and move finished phases to **Done** with a one-line summary. If a phase changes shape while you build it, edit the plan here first. **Groundwork** lists small changes to make whenever you're editing nearby code anyway, so later phases are easier.

## Principles for every phase

- **Playable on the reference setup.** Each phase has to work on the 12B model with 8K context (see `CLAUDE.md`). Bigger worlds stay affordable through cast tiers, lore that's only included when relevant, and putting only the scene's map state into prompts.
- **Prompts suggest, the engine enforces**, and that includes generated content. Generated characters, rooms and sites go through the same validation as hand-written ones, and the player reviews them before play.
- **Prompt cache layout (rule 7).** Static content (geography, lore titles, cast) goes in the system header. State that changes during play (who controls a region, tags, moods, standees) goes in the user message.
- **No AI-generated art from us.** Portraits and maps come from scenario creators. Generated characters use a stand-in portrait set with a license compatible with a paid build (CC0 or similar, credited in `CREDITS.md`).
- **Shipped scenarios are original.** Players can build whatever world they like (`MODDING.md`).
- **Nothing old breaks.** Old scenario folders and saves keep loading through a migration step. Every new field gets `Scenario.validate`, a line in the README's scenario format section, and a test.

## Done

- [x] **Core loop.** Intent → resolve → narrate → update, with the engine owning facts, validating and clamping model output, and reporting rejections in Debug.
- [x] **Secrets and knowledge.** Guards (low/medium/high), leak detection, and `known_by` on every fact; the narrator never sees secrets.
- [x] **Time.** Five time steps, beats with time markers, step in / next, filling short scenes, and the "until something major happens" downtime skip with clocks and `then` chains.
- [x] **Events.** Local, regional and world tiers, rationed by `tiersDue`, with effects on world status, group stance and clocks.
- [x] **Memory.** Chapters, fact budgets scaled to context, memory cap, and committing memory at the start of the next turn.
- [x] **Backends.** Local and external presets, per-step routing (Hybrid), JSON salvage and retry, first-run setup.
- [x] **Two scenarios.** Ares Deep (Mars) and the zombie holdout; engine and UI smoke tests.
- [x] **License setup.** PolyForm Noncommercial, `CONTRIBUTING.md`, `MODDING.md`.

## Phase 0: Playtest tools

Every later phase needs fast testing against a real model, and turns take 30–60 seconds.

- [x] **Undo last turn.** Restore the state from before the last action (one level, `state.undo`).
- [x] **Reroll narration.** Keep the intent and resolution, and only rewrite the scene.
- [x] **Turn telemetry in Debug.** Tokens in and out per call, cache reuse (cached tokens where the provider reports them; KoboldCpp's prompt processing time from its perf endpoint), seconds per step, and which guards fired.
- [x] **Turn recorder and replay tests.** Export a session's raw model responses as a fixture, and add a fake backend that replays them so a real bad log becomes a regression test. Fixtures live in `tests/fixtures/`.
- [ ] **Validation pass (carried over).** Play every time step on the reference setup; run several major-event skips in a row; compare Hybrid with all-local; tune reveal thresholds, event rates and scene lengths; play the zombie holdout end to end.

## Phase 1: Foundations

The format change everything else builds on, plus visible improvements to the character cards.

**World and Start split**
- [ ] A **world** holds the setting, rules, genre tags, groups, map (once phase 3 lands), lore, timeline, the skill and needs definitions, and event rates.
- [ ] A **start** is one way into that world: where the player begins (region and location), the player character or a slot to fill in, the local cast, the local rooms, the start date and opening situation, and optional allowed roles or peoples for the character creator.
- [ ] Folder layout: `scenarios/<world>/world.json`, `starts/<id>.json`, `characters/<id>.json`, plus later `maps/`, `lore/`, `portraits/`. The scenario picker becomes a world picker, then a start picker.
- [ ] A `format` field on world files, and a migration that loads today's `scenario.json` as one world with one start. Bump the save `version` and migrate old saves.
- [ ] Write `docs/WORLDS.md` (spec for the split) before coding.

**Genre and mood tags**
- [ ] `tags` on the world (for example `survival`, `slice-of-life`, `romance`, `intrigue`, `war`, `horror`, `comedy`, `cozy`, `grim`) plus a freeform `toneNote`.
- [ ] Engine-owned guidance blocks per tag: narrator tone and pacing, what counts as "major", how lethal danger is, and default event rates. These go in the static header.
- [ ] Audit survival-specific assumptions: the injury and exhaustion penalties, needs being required, and event seeds that assume danger. A scenario with no needs at all must work.

**Character presentation**
- [ ] The card leads with portrait, name, role, a **mood** line and **tags**. Needs bars move into an expandable details section; the raw numbers are also shown in Debug.
- [ ] **Derived tags** come from engine numbers (stress ≥ 0.8 shows as "on edge", fatigue ≥ 0.8 as "exhausted", plus health). Thresholds are per scenario and have defaults.
- [ ] **Freeform tags and mood** are proposed by the update step and validated: at most 4 per character, a short phrase each, an expiry in turns, and a reason logged in Debug.
- [ ] Optional `portrait` on characters (a path inside the world folder). Characters without one get a stand-in from the generic set, chosen deterministically by id so it never changes.
- [ ] Cards can be minimized (to a portrait, name and mood row), remembered per character in `localStorage` with the usual try/catch.
- [ ] **Character details:** description, appearance, pronouns, and what the player knows about them (player-known facts that name them).
- [ ] **Correct your feelings:** nudge your own attitude when the model misreads your tone.

**Themes and accessibility**
- [ ] Themes in Settings › Appearance: Dark (today's), Light, **High visibility** (high contrast, no colour-only meaning, strong focus outlines) and System.
- [ ] Text size, story font (serif or sans), line spacing and reduce motion; applied before first paint.
- [ ] Contrast check for every theme in tests; `aria-label`s on icon-only buttons.

## Phase 2: Cast tiers

Lets big casts fit in 8K and makes the world move without the player.

- [ ] **Local** characters (in the scene, named by the player, or flagged important) get the full simulation: an intent each turn, needs, and full presence in prompts.
- [ ] **Secondary** characters get a one-line brief and an **agenda**: a goal, its steps, progress and a pace. "Keep routine" is a valid agenda. The engine advances agendas between turns, like clocks; the model only writes a step when one completes, as a local or hidden event.
- [ ] **Promotion and demotion** rules live in the engine: a character becomes local when they enter the scene, are named by the player, or their agenda brings them into contact. They drop back to secondary after N turns without appearing. Every change is shown in Debug.
- [ ] **Extras**: one-line stubs (name, role, location) with no sheet. When promoted, one generation call turns an extra into a full character, validated and kept from then on.
- [ ] **Relationship web** (from the old Later list): a small graph of how people feel about each other, local characters first.

## Phase 3: Maps

Pax Historia's map at personal scale: World → Regional → Local.

**Data**
- [ ] **Regions**: id, name, a controlling group, tags ("occupied", "famine", "battle", "quarantine"), a status line, neighbours, and a `lore` entry. In the lore hierarchy, regions carry the most detail and the world only the broad context (the Shire doesn't need Mordor's politics).
- [ ] Every location gets a `region`. Locations are the local level.
- [ ] Event effects gain `control` (a region changes hands), `addTag`/`removeTag` on regions, and `regionStatus`, all rationed by `tiersDue` like the existing effects.
- [ ] Prompts get static geography in the header, and the control and tags of the current region and its neighbours in the user message only.

**Local map: tokens on nodes**
- [ ] Every character is a **token** on a location node, named characters and **standees** alike.
- [ ] **Standees** are unnamed groups such as gang members, guards or a mob: label, count, location, state (calm, alert, hostile, fled, down). The engine tracks them; the model can propose moves, count changes and state changes, and the engine validates and clamps them. A standee can be promoted to an extra or a named character when the player singles one out.
- [ ] Later, possibly: positions inside a room (doorway, cover, back wall) for a more hands-on feel. Decide after playing with tokens.

**Views**
- [ ] **World view**: the map image with creator-drawn region polygons coloured by controller, and tag badges. Without an image, a node map laid out automatically.
- [ ] **Regional view**: the world view zoomed to the current region and its neighbours.
- [ ] **Local view**: the room graph laid out automatically from `connects`, or an optional floor-plan image with room hotspots, showing tokens. Clicking a room or token fills in the action box ("go to the lab", "talk to Teo").
- [ ] Phone layout: one view at a time with a switcher.

**First creator tab**
- [ ] `creator.html`, the **map editor**: load an image, draw and edit region polygons, set controllers, tags and neighbours, place locations, and export JSON. Shares `scenario.js` validation.

## Phase 4: Creation and generation

Make your own character and start, and have the engine fill in the world around you.

- [ ] **Character creator**: a form producing the same character JSON: name, pronouns, description, appearance, role, people or origin (from the start's allowed list, or freeform), traits, voice, skills (point-buy within the world's skill list), want, an optional secret, and a portrait from the world's set or the stand-in set.
- [ ] **Generated starts**: the player picks a world, a region and a role. Generation runs as small calls, each validated before the next: local rooms, then the cast one character at a time, then relationships and tensions, then extras and standees, then the opening situation.
- [ ] **Review screen**: edit or reroll any generated room or character before starting. The result can be saved as a reusable start.
- [ ] **Generated sites**: on-the-fly local maps for places the story goes (a gang base, a corporate floor, a ruined farmhouse), with rooms, named characters, standees and loot. They're attached to a region and either kept or discarded after the visit. Triggered by the player's intent (`move_to` an unknown place) or by an event.
- [ ] Generation is a routable pipeline step ("world building") so it can go to an API model when one is set up.

## Phase 5: Lore and canon

- [ ] **Lore entries** at four levels (world, region, location, character): title, keywords, text and a priority. Regions are the heaviest level. The world gets a short always-on summary in the header; other entries go in the user message only when triggered (the player's region, the location, people present, or keywords in the player's action or the recent scene), within a budget (around 10% of context).
- [ ] **Canon timeline.** Past events seed facts and a "chapter zero" summary. Future events are dated, with **preconditions** the engine checks (a character alive, a group controls a region, a clock above a value, a fact known). They fire on their date as a regional or world event, outside the normal rationing. When a precondition breaks, the creator chooses per event: `drop`, or `diverge` (the model writes the altered version).
- [ ] The downtime skip treats the next canon event as a stopping point, like a clock.
- [ ] Creator tabs: lore editor and timeline editor.

## Phase 6: Creator suite

Everything a creator needs to build a world without touching JSON.

- [ ] Tabs: World (setting, rules, tags, skills, needs, event rates), Groups, Map (from phase 3), Lore, Timeline, Characters, Starts, Portraits.
- [ ] **Character editor**, including **character card import** (SillyTavern/Tavern PNG or JSON): one conversion call, a review step, then add to the cast. It keeps the card's personality and drops the card's original scenario framing.
- [ ] Export as a folder (or a zip); import an existing world to edit it; validation errors shown inline.
- [ ] Test play: start the edited world straight from the creator.

## Phase 7: Genre proof

- [ ] Two new original scenarios in very different genres, such as a resistance cell in an occupied city and a high-school slice-of-life. At least one uses a map image with regions, and one uses generated starts.
- [ ] Fix whatever turns out to be survival-specific. Add a test named after each fix.

## Groundwork

Small changes to make whenever you're editing nearby code anyway.

- [x] **Read the cast through helpers.** There are about 70 direct `state.characters` reads across `engine.js`, `prompts.js` and `ui.js`. Add `E.present(state)`, `E.offstage(state)` and `E.cast(state)` in `engine.js` and switch call sites as you touch them, so tiers (phase 2) and standees (phase 3) only change one place.
- [ ] **Let `Scenario.validate` accept and ignore future fields** (`tags`, `portrait`, `region`, `tier`, `lore`) instead of rejecting them, so new content can be authored before the engine uses it.
- [ ] **Keep prompt sections as named builder functions** (setting block, cast block, facts block, scene block) so lore, regions and genre guidance can be added as new blocks without reordering the header.
- [ ] **Generate card markup from one function per section** (header, mood/tags, needs, details) so phase 1's card redesign is a swap, not a rewrite.
- [x] **Keep every event effect in `applyEffects`** (`engine.js`), which already handles both normal and skip events. Turn its body into a table of effect handlers so `control`, `addTag` and agenda effects can be added as entries.
- [ ] **Keep ids opaque and stable.** Never derive behaviour from an id's text, since generated content will have ids like `extra-3`.
- [ ] **Keep display text out of the engine.** Labels like "on edge" come from scenario or default tables, so genres can retheme them.

## Later

- **Director**: tension tracking that nudges events up or down to keep pacing interesting.
- **Streaming narration**: show the scene as it's written. It doesn't depend on any phase, so it can go in whenever there's a gap.
- **Arc memory** for long campaigns: summarize every ~5 chapters into an arc, keep weight-3 facts verbatim, and give each character a running "history with you" line.
- **Save slots and autosave**, and an in-game **journal** (what you know, by person, and the chapters).
- **Endings**: optional win/loss/epilogue conditions on clocks, regions and timeline events, with a closing "what became of everyone" scene.
- **Inventory and resources**, owned by the engine.
- **Promises ledger**: the engine tracks what the player committed to, with deadlines.
- **Voices**: per-character Piper voices (reuse StreamTTS pieces).
- **Stream mode**: Twitch chat votes on the player's action.
- **Installable app (PWA)** and optional save sync to the player's own cloud drive.
- **Native port** (e.g. Godot) if it outgrows the browser; the JSON state and prompt chain port as-is.

## Open questions

- Should random major events have a minimum delay, or is "anything can happen" the right feel? (Current answer: anything goes; the skip means "let's see what happens".)
- Standees: is room-level placement enough, or does the local level need positions inside rooms? Decide after phase 3 playtesting.
- Generated sites: keep them on the map permanently, or let them fade unless revisited?
- Canon `diverge`: how much freedom does the model get when rewriting a broken canon event?
- Stand-in portraits: which CC0 set, how many, and how to cover a range of genres (modern, historical, sci-fi, fantasy)?
- Recommended API models for narration quality vs cost.

## Before publishing

- [x] License: PolyForm Noncommercial 1.0.0 (`LICENSE`), contributor terms (`CONTRIBUTING.md`), mod policy (`MODDING.md`).
- [ ] Check the name "Ensemble" for conflicts.
- [ ] Short privacy note: everything stays in the browser; API calls go directly to the provider the player chose.
- [ ] **Hosting**: turn on GitHub Pages for the repo so the game has a link for phones and friends.
- [ ] `CREDITS.md` for any bundled portrait or icon sets, with their licenses.
- [ ] Before selling anything: a short EULA for the paid build, and a quick legal review of the license setup.

## Revenue (low-key, optional)

Code stays public and the game stays free. Possible income, in order: a Ko-fi or itch.io pay-what-you-want page once people are playing; supporters get builds or scenarios early (everything goes public later); a paid one-click desktop build (KoboldCpp and a model bundled) if there's demand. A hosted token service is deliberately out of scope for now: inference costs, accounts, billing and content moderation make it a separate business.
