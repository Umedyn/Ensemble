# Ensemble

A local, character-driven story sim in the spirit of Pax Historia, but at personal scale: you play one person in a group, and every other member is their own character with wants, needs, secrets and feelings. Runs entirely in the browser against KoboldCpp.

## Running it

1. Start KoboldCpp with any instruct or roleplay model. 8K context or more is recommended. Set the **chat completions adapter** to match your model's format (for Mistral Nemo-based models such as NemoMix, pick the Mistral/Nemo adapter). If the console says "Chat template heuristics failed… Alpaca will be used", the model is being prompted in the wrong format and quality will suffer.
2. Double-click `start.bat` (Windows) or run `./start.sh`. This serves the folder at http://localhost:8000 (using Node if installed, otherwise Python) and opens your browser. With Node you can also run `npm run serve`.
3. Pick a scenario, press **New game**, and type what you do.

No Python? Open `index.html` directly and use **Open folder** to pick the `scenarios` folder (or a single scenario folder).

Settings also has context size (the **Detect** button reads it from KoboldCpp), scene length, temperature and turns per chapter.

## Models: local, remote or API

**Settings** has two backends, each with presets:

- **KoboldCpp on this computer** (default, `http://localhost:5001`)
- **KoboldCpp on my machine (remote)**: start KoboldCpp with its remote tunnel option and paste the public URL it prints, or use your PC's address on your home Wi-Fi. Lets you play on your phone with your own GPU doing the work.
- **OpenRouter**: one API key, many models. Paste a model name from its list (`vendor/model-name`).
- **Other OpenAI-compatible API**: any provider that speaks the OpenAI chat format and allows calls from a web page.

Under **Which model does what**, each step (characters & events, narration, memory updates, chapter summaries) can use either backend. **Hybrid** sends characters, events and narration to the external model and keeps bookkeeping local. Use **Test** on each backend; errors say what's wrong (bad key, unknown model, out of credits, can't reach).

API keys are stored only in your browser and are never written into save files.

## Playing on a phone, or sharing a prototype

Ensemble is plain HTML and JavaScript, so it can be hosted as-is on any static host (GitHub Pages, itch.io as an HTML game, Netlify). Open the link on a phone; the crew and situation panel slides up from the 👥 button.

To hand it to someone without a GPU: send them the link, have them open **Settings → External model → OpenRouter**, paste their key and a model name, then press **All external**.

Note: a page hosted on `https://` usually can't reach `http://localhost`, so on a hosted copy use the remote KoboldCpp URL (which is `https://`) rather than localhost.

## How a turn works

1. **Intent** (1 model call): judges your action (does it need a skill roll? does it move you?), decides what each character in the room tries to do (including covert actions), and sets **events** for the timeframe: offstage characters pursuing their own goals, arrivals, calls, equipment trouble. Events are *seen* (in your room), *heard* (a sound, call or message) or *hidden* (recorded as private knowledge for whoever was involved). Longer time steps allow more events.
   Events come in three tiers. **Local** events involve the people in and around the scene. **Regional** events happen in the surroundings (terrain, weather, nearby places) and **world** events are broad shifts far away (organizations, money, politics, disasters). The engine decides when a regional or world event is due from the scenario's `eventRates`, with cooldowns, so they stay rare; bigger events carry concrete effects on world status, group stances and pressure clocks, and can add a new pressure. Known regional and world events appear under **News**.
2. **Resolve** (no model call): d20 + skill×2 vs a difficulty (8 / 12 / 16), with penalties for injury and exhaustion. Time advances, needs tick, crisis clocks advance and can fire.
3. **Narrate** (1 call): writes the scene from your point of view. The narrator never sees anyone's secrets, and covert actions are only hinted at.
3b. **Beats:** the scene is written in beats, each starting with a time marker (`[+0m]`, `[+40m]`…): one for a few minutes, up to four overnight. Between beats the page shows **Step in here**. Stepping in cuts the turn at that point: later beats never happen, time only advances to that moment, and your next action starts there.
4. **Update** (1 call, at the start of your next turn, so it only records the part of the scene you let play out): returns facts, state changes and relationship shifts as JSON. The engine validates everything (real IDs, allowed fields, clamped values) and rejects the rest; the Debug panel shows what was accepted or rejected.
5. **Chapter** (occasional call): every 5 turns, or early after a big moment (at least 2 turns in), minor facts are rolled into a journal entry. Major facts (weight 3) and characters' private knowledge are kept individually.

If a call fails, the turn is rolled back. If only the update step fails, the scene is kept and a basic fact is recorded instead.

## Skipping to the next major event

**⏭ Until something major happens** fast-forwards through downtime (days or weeks) and stops at whichever comes first: a pressure clock running out, a random major event (on average every `majorEventDays`), or the horizon (`majorHorizonDays`, default 30). During downtime people eat and sleep, so hunger and fatigue settle instead of climbing. The scene comes back as a short montage of day-stamped beats followed by the interrupting event as a live scene, with everyone wherever they were when it hit. You can type a plan for the downtime ("keep the arrays clean and avoid Teo") or leave it empty, and you can still step in between montage beats.

Clocks can have follow-ups (`then`): when one fires, new pressures start. In Ares Deep, the storm arriving starts "Storm clears" and "Battery reserve depleted"; whichever runs out first is what the next big skip stops at, unless something else happens sooner.

## Memory and context

Prompts are ordered for KoboldCpp's prompt cache: a fixed header (rules, setting, places, cast), then chapter summaries and facts the player knows, then everything that changes per call. The header is identical for all calls in a turn and only grows at its end between turns, so most of it is reused. Budgets: facts ≈ 20% of context, chapter summaries ≈ 12%.

Every fact records who knows it (`known_by`). The narrator only gets facts the player knows; each character's intent only gets their own private knowledge.

## Making a scenario

Copy a folder in `scenarios/` and edit it:

```
scenarios/my-scenario/
  scenario.json
  characters/<id>.json   one file per id listed in scenario.json "characters"
```

Then add the folder to `scenarios/index.json` (only needed when running with the server; **Open folder** finds scenarios on its own). Scenarios are validated on load, with readable errors for unknown locations, skills, relations and so on.

**scenario.json** fields: `title`, `setting`, `rules` (list), `timeLabel` ("Sol", "Day"), `start` `{day, hour}`, `wakeHour`, `player` (character id), `characters` (ids), `skills` (list), `needs` (`{id, label, perHour}`), `locations` (`{id, name, desc, connects}`), `world` (key → short description), `factions` (groups such as an organization, gang or government: `{id, name, desc, stance}`; their stance can shift as events ripple out), `clocks` (`{id, name, value, max, perHour, fireText, fireWorld}`), `eventRates` (`{regional, world}`: average in-game hours between regional and world events; 0 turns a tier off), `eventSeeds` (`{regional: [...], world: [...]}`: idea lists that steer what those events are about), `majorEventDays`, `majorHorizonDays` and `majorSeeds` (for the major-event skip), clock `then` (follow-up clocks started when a clock fires), `facts` (public starting facts), `opening` (first scene), `castLabel` (sidebar heading).

**Character files**: `id`, `name`, `pronouns`, `role`, `age`, `traits`, `want`, `secret`, `guard` (`low`, `medium` or `high`: how hard the secret is to crack), `voice`, `skills` (0–4), `needs` (0–1), `status` `{health, location, conditions}`, `relations` (id → −100..100, how they feel about that person), `knows` (private starting facts).

Health is one of `ok`, `hurt`, `badly_hurt`, `dead`. Death is permanent; if the player dies, the story ends.

## Saves

Progress autosaves to the browser after every turn. **Save** downloads a JSON file that includes the scenario, so saves work even if the scenario folder changes later.

## Files

- `js/engine.js`: state, resolution, applying validated updates, the turn loop
- `js/memory.js`: facts, `known_by` filtering, chapter rollups, budgets
- `js/prompts.js`: the four prompt builders
- `js/llm.js`: KoboldCpp client (OpenAI-compatible endpoint), tolerant JSON parsing with one retry
- `js/scenario.js`: loading and validating scenario folders
- `js/ui.js`: the page

## Next steps

Location map, relationship web graph, a director that tracks tension and injects events, and a scenario editor.

## Development

- `CLAUDE.md`: architecture, the rules that keep the game consistent, and the playtesting workflow (read by Claude Code at the start of every session).
- `docs/DESIGN.md`: how the engine works and why, including a log of what each playtest fixed.
- `ROADMAP.md`: what's next.

```
npm install          # dev dependency for UI tests only
npm test             # engine tests, no browser or model needed
npm run test:ui      # browser smoke tests against fake model servers (npx playwright install chromium once)
npm run check        # syntax + scenario validation
npm run mocks        # fake KoboldCpp on :5001 and fake API on :5002 for manual testing
```

## License

Ensemble is free to play, study, modify and share for noncommercial purposes under the [PolyForm Noncommercial License 1.0.0](LICENSE). Selling it, selling modified versions, or running it as a paid service isn't allowed without permission.

Scenarios and characters you create are yours; see [MODDING.md](MODDING.md). Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md).

Copyright 2026 Umedyn.
