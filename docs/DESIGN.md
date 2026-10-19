# Ensemble design

How the engine works and why it works that way. Most of the "why" comes from playtesting with a local 12B model; the decision log at the end records what went wrong and what fixed it.

## What it is

Pax Historia is AI-driven grand strategy: you play a nation, and other nations react. Ensemble keeps Pax's loop (state an action, time passes, the world responds, events happen) but at personal scale. You are one person in a group, and everyone else is an individual with wants, needs, secrets, guarded knowledge and feelings about each other. Groups and factions still exist (Mission Control, a corporate sponsor, a rescue convoy) and act collectively; the story shows how individual choices ripple out to them and how their moves land on people.

It sits between SillyTavern (rich characters, but the model holds all the state) and Pax (rich world state, but no one to know). The distinguishing features are an engine that owns the facts, secrets with owners, and a world that keeps moving on its own.

It is local-first: KoboldCpp on your own GPU by default, with OpenAI-compatible APIs (e.g. OpenRouter) as a first-class option for people without a GPU or on phones.

## Core principle: the engine owns facts, the model proposes

The model is used for judgment and prose. Everything that must stay true (where people are, who knows what, health, needs, relationships, time, clocks) lives in a JSON state that only the engine changes, after validating what the model proposed. This is what keeps a long story consistent with a small model, and it's why most fixes in the decision log are engine-side guards rather than prompt wording.

## State

`Engine.newGame(scenario)` builds:

- `characters[id]`: sheet (name, pronouns, role, traits, want, secret, guard, voice, skills), `needs` (0–1), `status` (health, location, conditions), `relations[otherId]` (−100..100: how this person feels about the other), and for the player `attitudeNotes` (latest reason per person)
- `locations`, `world` (key → short status), `factions` (name, desc, stance), `clocks` (pressures with `value/max/perHour`, `fireText`, `fireWorld`, follow-up `then` clocks)
- `facts[]`: `{ text, about[], known_by[] | ['all'], weight 1–3, turn, chapter }`
- `chapters[]`, `recent` (last scene), `log` (display only), `news`, `pending` (the last turn awaiting memory), `undo` (the whole state from before the last action), `tierLast` (when regional/world events last happened)

## The turn

1. **Commit the previous turn** (`commitPending`). Run the update step on the scene as it actually played out. If the player stepped in after beat *k*, first rebuild the turn from its starting snapshot: re-apply the player's own move, advance time to the midpoint between beat *k* and *k+1*, and give the update step only beats 1..*k*. Then close a chapter if due.
2. **Roll event tiers** (`tiersDue`): are a regional and/or world event due, given elapsed time, scenario rates and cooldowns?
3. **Intent call** (model): judge the player's action (roll needed? skill, difficulty, move); one intent per present character (action, says, reveals, visibility, move); events for the span (local, plus regional/world only if due, with effects). Sees secrets and private knowledge of present characters, and one-line briefs of offstage characters.
4. **Resolve** (engine): cancel moves away from the person the action names; gate reveals by guard; detect leaks; roll d20 + 2×skill vs 8/12/16 with injury and exhaustion penalties; apply moves; apply events and their effects; hidden events become private facts.
5. **Advance time**: needs tick (or settle, for downtime), clocks advance and may fire (adding follow-up clocks).
6. **Narrate call** (model): a scene frame (starts where/with whom, ends where, who left or arrived), status with pronouns, the player's attitude toward those present, resolved outcomes (covert ones only as "out of sight"), and beat instructions. The narrator never sees secrets.
7. **Clean the prose**: drop repeated paragraphs, cut back to the last full sentence, drop trailing paragraphs that are the player's own action, regenerate once if it walks the player into another room.
7b. **Fill a short scene, then settle the clock** (about an hour, a few hours only): if the last beat is before half the step, one continuation call asks for 1–2 closing beats (same cleanup; dropped if it relocates the player). Then time is wound back to the last beat plus 10% of the step, unless a pressure clock fired during the step. The other steps keep their full span.
8. **Store as pending** with beats, the starting snapshot, everything the update step will need, and `narration` (the turn's system prompt, step, and the time state before and after the step) for Reroll.

A normal turn is three model calls (intent, narrate, update), plus an occasional chapter summary or narration retry.

**Undo and reroll** (playtest tools). `runTurn` clones the whole state before step 1; when the turn succeeds the clone (minus its own `undo`) becomes `state.undo`, so there is one level of undo. Undo swaps it back in: facts, time, clocks, rolls, any chapter the commit closed, and the previous scene pending again with all its beats (a step-in is undone too; the page re-selects it). Reroll works only on the pending turn: it puts `recent` and time/needs/clock values back to just after step 5 and re-runs steps 6–7b with the stored system prompt, so rolls, moves, events and clocks stay and only the prose, beats and settled time change. Save files leave `undo` out; the autosave keeps it.

## Prompts and the cache

`system` is identical for every call in a turn: setting, rules, locations, groups, cast (public sheet with pronouns), chapter summaries, and player-known facts. It only grows at the end between turns, so KoboldCpp reuses most of it (in logs, 1,800 tokens processed for the first call and only ~600–1,000 for the next two). Anything that changes per call (status, needs, relations, clocks, secrets, the scene, the task) goes in `user`.

**Telemetry.** Each turn (and each reroll) leaves a report in `Engine.telemetry` (the last 20, in memory only): every model call with tokens in and out (from the reply's `usage`, or an estimate marked `~`), wall time, retries and salvage, plus the guards that fired. KoboldCpp doesn't report how much of the prompt it reused, so for KoboldCpp backends the report shows prompt processing time from `/api/extra/perf` after each call: a reused prefix processes in a fraction of the time. Providers that report `prompt_tokens_details.cached_tokens` get a cached column. Debug shows the reports as tables, and "Copy turn report" gives plain text for pasting into a chat.

**Recordings.** Debug › Record starts `E.Recorder` (`js/recorder.js`): from a copy of the state, it wraps `E.rng` and `LLM.transport` and keeps, per action (turn, reroll, undo, marked by the engine), every random number drawn and every model request and reply. The export is a replay fixture (`tests/fixtures/README.md`); `tests/replay.js` plays it back with the same dice and replies and fails on any different call. No keys or URLs are recorded.

**Guards.** Whenever the engine overrules or cleans up the model it records `{ stage, type, detail }` in the turn's `res.guards`: `move cancelled`, `reveal blocked`, `leak deflected`, `event dropped` (resolve); `cut to last sentence`, `repeated paragraph removed`, `player ending trimmed`, `relocation regenerated`, `continuation dropped` (scene; Reroll replaces these); `update rejected`, `update failed` (memory, recorded at the next turn's commit and reported with that turn, tagged with the scene's turn). New guards should call `guard()` in `engine.js` so they show up in reports.

Budgets scale with `E.memoryContext()`: the smallest context among the backends routing uses, capped by `memoryCap` (default 32K). Facts ~20%, chapter summaries ~12%. Weight-3 facts are always kept; minor ones go first.

## Memory

- **Facts** are short sentences with names, an owner list (`known_by`) and a weight. Facts the player could not have seen or heard are recorded as known only by whoever did.
- **Chapters** close every N turns (default 5), early on a big moment (after at least 2 turns), when facts outgrow their budget, and after a major-event skip. Minor player-known facts are folded into a 2–4 sentence journal entry; weight-3 facts and private facts are kept individually.
- **The player's feelings** are a separate tally, changed only by `player_attitude` judged from the player's own words (±10 per turn), with a note of why. Longer time steps tell the narrator to keep the player's routine consistent with those feelings.

## Secrets

Each secret-keeper has a `guard`:

| guard | cracks when |
|---|---|
| low | confronted directly, stress ≥ 0.6, or trust ≥ 30 |
| medium | stress ≥ 0.85, trust ≥ 50, or confronted while stress ≥ 0.6 |
| high | stress ≥ 0.95 or trust ≥ 70 |

A successful social roll works on anyone. A reveal attempt is either the `reveals` field (any truthy value) or a leak: 3+ content words shared with the secret, or a confession verb plus 1+. Unearned attempts become "is pressed about it but keeps the secret".

## Time

| step | span | narration | events |
|---|---|---|---|
| a few minutes | 15 min | 60–120 words, beat by beat | usually none |
| about an hour | about 1 h (follows the scene) | 100–200, key exchange live, rest compressed | 0–1 |
| a few hours | up to 3 h (follows the scene) | 150–250, routine allowed | 1–2 |
| until next morning | to wake hour | 200–300, summary then live morning | 1–3 |
| until something major happens | to the next clock, random major event, or horizon | 250–350, day-stamped montage then live crisis | up to 2 + the interrupting event |

The longer the step, the more the narrator may fill in for the player, but never big decisions. Scenes are written as beats with time markers (`[+0m]`, `[+40m]`, `[+3d]`); the page reveals them one at a time, offering **Step in here** or **Next ▸** after each; acting early counts as stepping in.

## Events

- **Local**: people in and around the scene (an intercom call, someone arriving, an offstage character pursuing a secret).
- **Regional**: the surroundings (terrain, weather, nearby places). Default about one per 18 in-game hours on Mars, 4-hour cooldown.
- **World**: broad shifts far away (money, politics, disasters). Default about one per 96 hours, 24-hour cooldown.

The engine decides when bigger events are due; the model only writes them, guided by `eventSeeds`. Effects can change world status, a group's stance, clock values, or add a new clock (at most 5 active). Visibility is seen (in the player's room), heard (a sound, call or message) or hidden (private knowledge for those involved; changes nothing public).

## Downtime skip

`planMajorSkip` simulates clocks hour by hour (following `then` chains) and compares the first firing with a random major event drawn from an exponential distribution (`majorEventDays`), capped by `majorHorizonDays`. Time advances in routine mode (hunger and fatigue settle near normal). One model call writes the montage, any news, the interrupting event (unless a clock caused it) and where everyone is; the narration is a day-stamped montage ending in a live scene. Choosing it means "let's see what happens", so very short skips are allowed.

## Backends

Two backends (local and external), each a preset: KoboldCpp on this computer, KoboldCpp remote (tunnel URL), OpenRouter, or any OpenAI-compatible API. Each pipeline step (characters & events, narration, memory updates, chapter summaries) is routed to one of them; "Hybrid" sends the judgment and prose steps external and keeps bookkeeping local. Keys live in browser settings, never in saves.

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
