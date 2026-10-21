# Ensemble

A local-first, character-driven story sim in the spirit of Pax Historia, at personal scale: the player is one person in a group (a Mars crew, survivors in a hardware store), and every other member is an individual with wants, needs, secrets and feelings. Plain HTML/JS in the browser, talking to KoboldCpp locally or any OpenAI-compatible API.

Read `docs/DESIGN.md` before changing the turn pipeline, prompts or memory, and `docs/WORLDS.md` before changing the scenario format or loader. `ROADMAP.md` has the plan.

## Commands

- `npm test`: engine tests (Node's built-in runner, no browser, no model). Run after every change.
- `npm run test:ui`: browser smoke tests against fake model servers (desktop, phone, routing, skip). Needs `npx playwright install chromium` once.
- `npm run check`: syntax-checks every script and validates every scenario folder.
- `npm run serve`: serves the app at http://localhost:8000.
- `npm run mocks`: fake KoboldCpp on :5001 and fake API on :5002 (key `sk-test`, model `test/story-70b`) for manual testing without a model.
- `npm run fixture:mock`: re-records `tests/fixtures/mock-session.json` from the mock servers (runs the UI smoke tests).

No build step and no runtime dependencies. Playwright is a dev dependency for UI tests only.

## Layout

- `js/util.js`: namespace (`window.Ensemble`), settings, backend presets, time steps, helpers
- `js/llm.js`: backends, per-step routing, transport, tolerant JSON extraction with one retry, token usage
- `js/recorder.js`: records dice and model calls per action into a replay fixture
- `js/memory.js`: facts with `known_by`, chapter rollups, prompt budgets
- `js/genres.js`: genre tag table (tone, what "major" means, danger, default pacing) and the header guidance
- `js/prompts.js`: every prompt (intent, narrate, update, chapter, downtime intent, downtime narration, suggested actions)
- `js/engine.js`: game state, resolution, guards, events, time, beats, skip, the turn loop
- `js/scenario.js`: loading worlds (and legacy scenario folders), composing a world + start into the flat scenario, validation
- `js/ui.js`: the page; the only file that touches the DOM
- `scenarios/<folder>/`: a world (`world.json` + `starts/<id>.json` + `characters/<id>.json`) or a legacy `scenario.json` + `characters/`, listed in `scenarios/index.json`
- `tests/`: `helpers.js` loads the engine into a Node VM (`readWorld`, `newGame(folder, startId)`); `engine.test.js`; `worlds.test.js` (compose, world validation, legacy, save migration); `genres.test.js`; `themes.test.js` (contrast of every theme); `tags.test.js` (mood and tags); `portraits.test.js` (stand-ins, card details); `feelings.test.js` (correcting your feelings); `tiers.test.js` (cast tiers); `agendas.test.js` (agendas); `extras.test.js` (extras and promotion); `web.test.js` (relationship web filter); `suggest.test.js` (suggested actions); `genre-neutral.test.js` (the no-needs `fixtures/slice-of-life/` world); `prompts.snapshot.test.js` (every prompt for a fixed state, byte for byte; re-record with `UPDATE_SNAPSHOTS=1` after an intended prompt change); `replay.js` + `replay.test.js` + `fixtures/` (recorded sessions); `ui.smoke.mjs`; `mock-servers.mjs`

## Rules that keep the game working

These came from playtesting a 12B local model. Each has a test; don't loosen one without a reason and a new test.

1. **Prompts suggest, the engine enforces.** Small models ignore instructions often enough that every rule that matters is also checked in code (`Eng.resolve`, `Eng.applyUpdate`, the prose cleanup). When a log shows the model misbehaving, prefer an engine-side guard over another prompt sentence.
2. **The engine owns facts; the model proposes.** All model output is validated: real ids only, allowed fields only, clamped deltas. Rejections are reported in the Debug panel, never silently applied.
3. **The player controls the player character.** Only the player's own intent moves them (`move_to`, or a character id meaning "go where they are"). Their feelings change only through `player_attitude`, judged from the player's own words, or the player's own correction on a card (`Eng.correctAttitude`); the model never sets them. The narrator may fill in small gestures for a vague action, but never big choices; scenes never end on the player's own line or action (`trimPlayerEnding`).
4. **Movement is grounded.** If the action names someone already in the room, a model-proposed move elsewhere is cancelled, unless the player states the move ("…then head to the garage", "follow him") or names someone at the destination or heading there. The update step may only move non-player characters who were in the scene (seen leaving or arriving). A relocation check regenerates a scene that walks the player into another room, or outside when they aren't moving.
5. **Secrets are earned.** Each character has a `guard` (low/medium/high). Reveals pass only with a successful social roll, enough stress, enough trust, or (low/stressed medium guard) direct confrontation. Leaks through `action`/`says` are detected by word overlap with the secret and turned into deflection.
6. **Knowledge has owners.** Every fact has `known_by`; the update step can only give a fact to the player, the people present and those in the turn's events (or `all`). The narrator only ever sees player-known facts and no secrets; secrets and private facts appear only in the intent call's user message.
7. **Prompt layout serves KoboldCpp's cache.** `system` = static header (setting, rules, places, groups, cast) + chapter summaries + player-known facts, identical for every call in a turn and only growing at its end. Everything that changes per call goes in `user`. Don't put changing values (needs, relations, clocks, time) in the header.
8. **Memory is recorded at the start of the next turn** (`commitPending`), once we know how much of the scene happened. "Step in here" (`cutAt`) rewinds the turn to its start state, advances time only to the cut, and the update step sees only the kept beats and may only move people those beats show leaving.
9. **The time step is the player's control dial.** Short steps play beat by beat; longer ones may compress routine but not make decisions. "Until something major happens" fast-forwards until a clock fires, a random major event rolls, or the horizon.
10. **Bigger events are rationed by the engine.** Regional/world events happen only when `tiersDue` says so (rates + cooldowns per scenario); the model just writes them. Their `effects` change world status, group stance and clocks; hidden ones change nothing public.

## Conventions

- Engine files are classic scripts sharing `window.Ensemble`, not ES modules, so `index.html` works when opened straight from disk. Keep them DOM-free so they run in the Node VM tests.
- User-facing text is plain language. Player-facing UI never reveals hidden information (covert actions show as "something you didn't see"; the truth is in Debug).
- New scenario or character fields: update `Scenario.validate`, the README's scenario format section, and add a test.
- Keep the bundled worlds current: when the engine gains a world, start or character field, fill it in for `mars-station` and `zombie-holdout` in the same task (they are the examples creators copy, and the playtest ground). Secrets never go in anything the player sees, such as descriptions.
- Colours live only in the theme blocks at the top of `css/style.css` (`tests/themes.test.js` fails on a hard-coded colour elsewhere); sizes are `rem` so the text-size setting scales them.
- `localStorage` can throw or be empty: wrap every access. API keys live in settings only, never in save files.
- In tests, objects come from another VM realm: compare arrays as `[...arr]`, check errors by `err.name`, not `instanceof`.

## Content

- **Content rules are engine rules.** The minors safeguard (ROADMAP › Content settings) applies in every mode and backend and must not be weakened or made optional; it has a test. Everything else about mature content follows the world's rating and the player's settings.
- **Generated content goes through the same validation as authored content**, one stage at a time (ROADMAP Phase 4).
- **Lore never contains secrets or future events**; those belong in character secrets and the canon timeline.

## License

PolyForm Noncommercial 1.0.0 (`LICENSE`). Keep the `Required Notice` line. Contributions come in under the broader grant in `CONTRIBUTING.md` so the owner can include them in paid builds. Player-made scenarios belong to their creators (`MODDING.md`). Don't add dependencies whose licenses conflict with possible paid distribution (e.g. GPL code bundled into the app).

## Playtesting workflow

The loop that built this: play a turn with the real model, read the KoboldCpp console log (or the Debug panel), find what went wrong, fix it in the engine where possible, and add a test named after the behavior. Debug › "Copy turn report" gives the calls, tokens, times, guards fired, what the engine decided and the scene, in one paste. Reference setup: NemoMix-Unleashed-12B Q4_K_M in KoboldCpp on an RTX 4060 laptop (8 GB), 8K context, **chat adapter set to Mistral-Tekken** (AutoGuess falls back to Alpaca, which caused repetition and ignored rules). Roughly 30–60 seconds per turn; generation speed is the bottleneck, so output length is the main lever.

### Turn a bad log into a test

1. Before playing the turns that go wrong, open Debug and press **● Record** (or record from a loaded save just before the problem).
2. Play until it goes wrong, then **Export recording** and copy the file into `tests/fixtures/` with a name that describes the problem.
3. Write a test named after the behaviour that replays it (`replay('name', { until })` from `tests/replay.js`) and asserts the right outcome at that turn. It should fail.
4. Fix the engine (guard first, rule 1) until it passes. If the fix adds or removes a model call, the replay reports a mismatch: re-record, or edit that fixture's `calls`. Format and details: `tests/fixtures/README.md`.
