# Ensemble

A local, character-driven story sim in the spirit of Pax Historia, but at personal scale: you play one person in a group, and every other member is their own character with wants, needs, secrets and feelings. Runs entirely in the browser against KoboldCpp.

## Running it

1. For a local model, start KoboldCpp with any instruct or roleplay model. 8K context or more is recommended. Set the **chat completions adapter** to match your model's format (for Mistral Nemo-based models such as NemoMix, pick the Mistral/Nemo adapter). If the console says "Chat template heuristics failed… Alpaca will be used", the model is being prompted in the wrong format and quality will suffer. Using a hosted model instead? Skip this step; you only need an API key (see below).
2. Double-click `start.bat` (Windows) or run `./start.sh`. This serves the folder at http://localhost:8000 (using Node if installed, otherwise Python) and opens your browser. With Node you can also run `npm run serve`.
3. On your first visit, a short setup asks how you want to run the model (hosted, KoboldCpp, or both), checks whether KoboldCpp is running, and opens Settings where you finish up. **Settings → Setup guide** brings it back.
4. Pick a world (and, if it has more than one, where you start), press **New game**, and type what you do.

No Python? Open `index.html` directly and use **Open folder** to pick the `scenarios` folder (or a single world folder).

Each backend has its own context size: **Test** reads it from KoboldCpp, or from the provider's model list when it has one (OpenRouter does). Settings also has the memory cap, scene length, temperature and turns per chapter.

**Settings → Appearance** sets the theme (Dark, Light, **High visibility** for low vision, or the same as your device), text size (90–150%), story font (serif or sans), line spacing and reduce motion. Changes show as you pick them and are kept in this browser. With a screen reader, each new beat and note is read out as it appears.

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
   Events come in three tiers. **Local** events involve the people in and around the scene. **Regional** events happen in the surroundings (terrain, weather, nearby places) and **world** events are broad shifts far away (organizations, money, politics, disasters). The engine decides when a regional or world event is due from the scenario's `eventRates`, with cooldowns, so they stay rare; bigger events carry concrete effects on world status, group stances, pressure clocks and regions (who holds one, its tags and status line), and can add a new pressure. Known regional and world events appear under **News**.
2. **Resolve** (no model call): d20 + skill×2 vs a difficulty (8 / 12 / 16), with penalties for injury and exhaustion. Time advances, needs tick, crisis clocks advance and can fire.
3. **Narrate** (1 call): writes the scene from your point of view. The narrator never sees anyone's secrets, and covert actions are only hinted at.
3b. **Beats:** the scene is written in beats, each starting with a time marker (`[+0m]`, `[+40m]`…): one for a few minutes, up to four overnight. The page shows one beat at a time, with **Step in here** and **Next ▸** under the newest one. Next settles that beat and shows the following one. Stepping in (or simply acting before you reach the last beat) cuts the turn at that point: later beats never happen and are never shown, time only advances to that moment, and your next action starts there. "About an hour" and "A few hours" are approximate: the clock follows where the scene actually ends, and a scene that stops before half the step is asked to continue once.
4. **Update** (1 call, at the start of your next turn, so it only records the part of the scene you let play out): returns facts, state changes and relationship shifts as JSON. The engine validates everything (real IDs, allowed fields, clamped values) and rejects the rest; the Debug panel shows what was accepted or rejected.
5. **Chapter** (occasional call): every 5 turns, or early after a big moment (at least 2 turns in), minor facts are rolled into a journal entry. Major facts (weight 3) and characters' private knowledge are kept individually.

If a call fails, the turn is rolled back. If only the update step fails, the scene is kept and a basic fact is recorded instead.

**💡 Suggest** (optional, 1 call) asks for three or four ideas for your next action. Clicking one puts it in the action box, where you can edit it; nothing happens until you press **Act**. The model sees only what you know and the scene as far as you've read it (up to your step-in point), and the call goes to the backend routed for characters & events.

## Skipping to the next major event

**⏭ Until something major happens** fast-forwards through downtime (days or weeks) and stops at whichever comes first: a pressure clock running out, a random major event (on average every `majorEventDays`), or the horizon (`majorHorizonDays`, default 30). During downtime people eat and sleep, so hunger and fatigue settle instead of climbing. The scene comes back as a short montage of day-stamped beats followed by the interrupting event as a live scene, with everyone wherever they were when it hit. You can type a plan for the downtime ("keep the arrays clean and avoid Teo") or leave it empty, and you can still step in after any montage beat.

Clocks can have follow-ups (`then`): when one fires, new pressures start. In Ares Deep, the storm arriving starts "Storm clears" and "Battery reserve depleted"; whichever runs out first is what the next big skip stops at, unless something else happens sooner.

## Memory and context

Prompts are ordered for KoboldCpp's prompt cache: a fixed header (rules, setting, places, cast), then chapter summaries and facts the player knows, then everything that changes per call. The header is identical for all calls in a turn and only grows at its end between turns, so most of it is reused. Budgets: facts ≈ 20% of context, chapter summaries ≈ 12%, where context is the smallest among the backends in use (the shared header goes to all of them), capped by the memory cap (default 32K) so a huge hosted context doesn't inflate every prompt.

Every fact records who knows it (`known_by`). The narrator only gets facts the player knows; each character's intent only gets their own private knowledge.

## Making a world

A **world** is everything that's true wherever you start: the setting, rules, skills, groups, event pacing and a pool of characters. A **start** is one way into it: when, where, who you play, who's around you, the local pressures and the opening scene. One world can have several starts; Ares Deep has two (Kit in the commons, Priya in the garage).

Copy a folder in `scenarios/` and edit it:

```
scenarios/my-world/
  world.json
  starts/<id>.json       one file per id listed in world.json "starts" (the first is the default)
  characters/<id>.json   one file per id listed in world.json "characters"
```

Then add the folder to `scenarios/index.json` (only needed when running with the server; **Open folder** finds worlds on its own). Worlds are validated on load, with readable errors for unknown locations, skills, relations, cast members and so on. With Node installed, `npm run check` validates every world and every start, and warns about field names it doesn't know (a typo like `oppening`).

**world.json** fields: `format` (always `2`), `id`, `title`, `summary` (one or two lines for the picker), `tags` (genre tags, most important first: `survival`, `slice-of-life`, `romance`, `intrigue`, `war`, `horror`, `mystery`, `comedy`, `cozy`, `grim`, `adventure`, `political`, or your own words; up to 8), `toneNote` (a sentence on the tone you want), `setting`, `rules` (list), `timeLabel` ("Sol", "Day"), `wakeHour`, `skills` (list), `needs` (`{id, label, perHour}`; leave it out, or use `[]`, for a world without needs: no bars, no penalties), `skillPenalties` (optional: `{health: {hurt: -2, badly_hurt: -4}, needs: [{need: "fatigue", at: 0.85, penalty: -2}]}`, today's values shown; a need the world doesn't have never applies), `revealPressure` (optional: which needs count as pressure for cracking secrets, default `["stress", "fear"]`), `world` (key → short description), `factions` (groups such as an organization, gang or government: `{id, name, desc, stance}`; their stance can shift as events ripple out), `eventRates` (`{regional, world}`: average in-game hours between regional and world events; 0 turns a tier off), `eventSeeds` (`{regional: [...], world: [...]}`: idea lists that steer what those events are about; an idea can be `{"text": "...", "region": "region_id"}` for something that happens in one region), `regions` (see below), `majorEventDays`, `majorHorizonDays` and `majorSeeds` (for the major-event skip), `tiers` (optional: `{demoteAfter: 4, maxLocal: 6}`, see cast tiers below), `extras` and `inventExtras` (minor people, see below), `facts` (public facts true everywhere), `characters` (the pool: ids), `starts` (ids). `locations` can go here too when every start shares the same rooms, as in Ares Deep.

**starts/&lt;id&gt;.json** fields: `id`, `title`, `summary` (who you are and what's going on), `start` `{day, hour}`, `player` (a cast id), `region` (where the player starts, when the world has regions), `cast` (who's in this start), `castLabel` (sidebar heading), `locations` (`{id, name, desc, connects, region}`; `region` defaults to the start's), `clocks` (`{id, name, value, max, perHour, fireText, fireWorld}`, with `then` for follow-up clocks started when a clock fires), `facts` (public starting facts), `opening` (first scene). A start can also override world fields: a different `world` status, a group's `stance`, extra `rules`, and so on. Lists of rules and facts add to the world's; rooms, clocks and groups with the same `id` change the world's version field by field.

**Regions.** The map above the rooms: `"regions": [{"id": "junction", "name": "Highway junction", "controller": "convoy", "tags": ["blocked"], "status": "abandoned cars across two lanes", "neighbours": ["highway-strip"], "lore": "Where the highway meets the interstate..."}]`. `controller` is a group id or `null` (no one), `tags` are up to 6 short words, `status` is a line up to 120 characters, `lore` a summary up to 400 (no secrets). Neighbour links work both ways, so listing one side is enough. Every room belongs to a region (the start's unless it says otherwise). Regional and world events can hand a region to another group, add or remove its tags and change its status, as rarely as the event rates allow. The sidebar shows your region; the story engine sees every region's name, neighbours and lore, but who holds what only for your region and its neighbours. A start can change a region by `id`.

**cast** entries are a character id, or an object that sets where that person is and how they feel in this start: `{ "id": "bauer", "status": { "location": "hydro" }, "needs": { "stress": 0.7 }, "knows": ["..."] }`. An entry can override `status`, `needs`, `relations`, `knows`, `want`, `secret`, `guard` and `tags`, and can set `tier` (`"local"` or `"secondary"`), `pinned` (`true` keeps that person local) and `agenda` (see below).

**The map.** Next to the story there's a map of the rooms you know, with everyone where you last saw them (people out of sight are faded; the cards say "last seen in…" too). Switch between Text, Split and Map above the story; on a phone, 🗺 swaps the story for the map. Clicking a room or a person fills in the action box. A world can shape it: rooms take `size` (`small`, `medium`, `large`), `level` (1 for upstairs or a roof), `outside`, `features` ("forklift", "the pickup"), `seen: false` for a room you don't know yet, and `links` (`[{"to": "roof", "kind": "hatch"}]`; kinds `open`, `door`, `locked door`, `vent`, `hatch`, `window`, `stairs`). `"site": {"type": "hall"}` or `"corridor"` picks a layout style, and `localMap` (`{image, width, height, rooms: {id: {x, y, w, h}}}`) uses your own floor-plan picture instead.

**The world map.** In a world with regions the map has Local, Region and World views: regions in the colour of the group that holds them (a group's `color`, 1–8, picks the colour), with their tags, and your region marked; click one to see who holds it, its status and its lore. Add `"map": {"image": "maps/town.svg", "width": 800, "height": 560, "regions": {"junction": {"polygon": [[300, 150], [620, 150], [640, 290]]}}, "locations": {"floor": [515, 322]}}` to `world.json` to draw it on your own picture (the holdout's `maps/town.svg` is an example); without one, the game lays out the regions from their neighbours.

**Cast tiers.** Big casts stay cheap because only **local** people (with you, or important right now) get the full simulation. **Secondary** people are in the background: no turn-by-turn intent, one short line (role, where they are, what they want) for the story's events, never their secret, and their needs settle as if they're keeping to their routine. They're listed under **Elsewhere** in the sidebar. By default the people in your starting room are local and the rest secondary. Someone becomes local when they enter your scene, when your action names them, or when they're in an event you see or hear. They drop back to secondary after `demoteAfter` turns (default 4) without being seen, and if more than `maxLocal` (default 6) local people are away from you, the ones you haven't seen for longest go first. `pinned` people never drop. Every change shows in Debug.

**Agendas.** A character file (or a cast entry, per start) can give someone a goal they work on while you're elsewhere: `"agenda": {"goal": "prove the deep-ice cultures are alive", "hours": 14, "steps": ["runs a second culture in the unlogged incubator", "checks the results against the controls", {"text": "comes to find Kit, wanting a second opinion", "contact": true}]}`. Steps are short actions without the name, `hours` is how long each takes (1–240, default 12), and `visibility` is `"hidden"` (default: the player never sees the step happen) or `"heard"`. A `contact` step brings them to you, and a long skip can stop there. People in the background make progress; people with you act turn by turn instead. Use `"agenda": null` (or `{"goal": "keep routine"}`) for no agenda; leave the field out and the model proposes one when they first end up in the background. Agendas never show on cards; Debug lists them.

**Relationship web.** **Web** in the people panel shows who feels what about whom: your feelings, how each person treats you, and, between other people, only what you have seen or been told (dashed lines, with the fact that showed it). Words only; exact numbers are in Debug. A toggle adds the people in the background.

**Extras.** Minor people who don't need a full sheet: `"extras": [{"id": "albee", "name": "Mrs. Albee", "pronouns": "she/her", "role": "elderly neighbour", "location": "dock", "note": "keeps a shotgun she says is not loaded"}]`, in `world.json` or a start. `"location": null` means nowhere in particular. Crowds, patrols and hordes are standees (below). Extras have no turn of their own, needs, feelings or card: they show in the scene bar when they're with you, can be part of events and facts, and can move. The `note` is for the story engine and never shown. Name someone twice (on different turns), or have them in an important fact, and one **World building** call (routable in Settings) writes them a full character sheet; they join the cast from then on, keeping everything known about them. With `"inventExtras": true` the model may add new minor people (or a group, as a standee) as scenes need them (one a turn); leave it off for closed settings like a five-person Mars station.

**Standees.** Unnamed groups on the map, such as guards, a gang or a few of the dead: `"standees": [{"id": "stragglers", "label": "stragglers", "count": 5, "location": "lot", "state": "calm", "note": "they bunch up at the dock door when they hear noise"}]`. `state` is `calm`, `alert`, `hostile` or `down`; `faction` (a group id) says who they belong to; `post` (a room they hold) or `patrol` (a loop of linked rooms, one room an hour) make guards. A group acts as one, moves only to a linked room, gets harder to fight or sneak past the more of them there are and the warier they are, and notices you when a sneak fails. Name one in your action ("I grab the nearest straggler") and they become a minor person. A group that is wiped out or flees leaves the map. Groups exist only in rooms; a horde far away is a pressure or a faction. The old `"group": true` extras still load, as standees when they have a room.

**Character files** hold who the person is: `id`, `name`, `pronouns`, `role`, `age`, `traits`, `want`, `secret`, `guard` (`low`, `medium` or `high`: how hard the secret is to crack), `voice`, `skills` (0–4), `relations` (id → −100..100, how they feel about that person), and optionally `portrait` (an image in the world folder, like `"portraits/okafor.png"`; png, jpg, webp, gif or svg), `description` (who they are, up to 600 characters) and `appearance` (up to 400; keep the first sentence a good one-line look, since the narrator sees that sentence for the people in each scene). They may also hold `needs` (0–1), `status` `{health, location}`, `knows` (private starting facts) and `tags` (short visible states such as `"bandaged left forearm"`, 32 characters each; they last until the story removes them) as defaults for every start. `status.conditions` from older files is read as tags.

During play, each card shows a **mood** line (how that person comes across right now) and **tags**: ones the story adds (each lasts a few turns, at most 4) and ones from the numbers, such as "on edge" at stress 0.8 or "hurt". A world can change those thresholds with `tagThresholds`: `{"stress": {"at": 0.7, "tag": "frayed"}}`. Needs bars are under **Details** on each card, with the description, appearance and **what you know** about that person (facts you have seen or been told). Details also has **your feelings** toward that person, with − and + (5 a step) and an optional "why": use it when the story misread your tone (sarcasm taken as hostility). Only your own feelings change, the next turn uses the new value, and Undo also undoes corrections made since your last action. A card can be minimized to one row, or all of them with **Collapse all**; the game remembers this per world. People without a `portrait` get a stand-in from the world's `portraitSet` (a list of image paths, picked by id so it never changes) or, without one, their initials. Saves keep only the image paths.

The full spec, including the merge rules, is [docs/WORLDS.md](docs/WORLDS.md). The game lists every start under the world picker; a start with mistakes in it is marked "(has errors)" and shows why.

**Older scenario folders** (one `scenario.json` + `characters/`, no `world.json`) still load, as a world with a single start. `scenario.json` has the world and start fields together, with `characters` as the cast.

Health is one of `ok`, `hurt`, `badly_hurt`, `dead`. Death is permanent; if the player dies, the story ends.

## Saves

Progress autosaves to the browser after every turn. **Save** downloads a JSON file that includes the scenario, so saves work even if the scenario folder changes later.

## Files

- `js/engine.js`: state, resolution, applying validated updates, the turn loop
- `js/memory.js`: facts, `known_by` filtering, chapter rollups, budgets
- `js/genres.js`: genre tags: narrator guidance and default event pacing
- `js/prompts.js`: the four prompt builders
- `js/llm.js`: KoboldCpp client (OpenAI-compatible endpoint), tolerant JSON parsing with one retry
- `js/scenario.js`: loading and validating scenario folders
- `js/ui.js`: the page

## Next steps

See `ROADMAP.md`: worlds with multiple starts, character creation, cast tiers, world/regional/local maps, lore and a canon timeline, and a creator suite.

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
npm run fixture:mock # re-record the sample replay fixture (tests/fixtures/README.md)
```

## License

Ensemble is free to play, study, modify and share for noncommercial purposes under the [PolyForm Noncommercial License 1.0.0](LICENSE). Selling it, selling modified versions, or running it as a paid service isn't allowed without permission.

Scenarios and characters you create are yours; see [MODDING.md](MODDING.md). Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md).

Copyright 2026 Umedyn.
