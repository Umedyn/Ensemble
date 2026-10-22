# Replay fixtures

Recordings of real (or mock) play sessions, replayed by `tests/replay.js` without a model. Each one is a regression test: the engine has to make the same calls, draw the same dice and reach the same states as when it was recorded.

## Making one

1. In the game, open **Debug** and press **● Record**. Recording starts from the game as it is now (a new game or a loaded save both work).
2. Play the turns that show the problem. Undo and Reroll are recorded too.
3. Press **Export recording** and copy the file here with a name that says what it shows, e.g. `teo-confesses-on-first-ask.json`.
4. Write a test in `tests/replay.test.js` (or a new `*.test.js`) that replays it and asserts the behaviour, named after it.

`npm run fixture:mock` re-records `mock-session.json` from the mock servers.

## Format (version 1)

```json
{
  "format": "ensemble-recording",
  "version": 1,
  "recorded": "2026-10-19T09:06:00.000Z",
  "note": "free text",
  "settings": {
    "narrateTokens": 320, "temperature": 0.8, "chapterLength": 5, "memoryCap": 32768,
    "routing": { "intent": "local", "narrate": "local", "update": "local", "chapter": "local" },
    "backends": { "local": { "preset": "kobold-local", "model": "koboldcpp", "context": 8192 }, "external": { "preset": "openrouter", "model": "", "context": 32768 } }
  },
  "start": { "...": "the full game state when recording began, scenario included (no undo copy)" },
  "actions": [
    { "type": "turn", "action": "Ask Teo about the rattle.", "stepId": "hour", "cutAt": null,
      "rng": [0.53, 0.91],
      "calls": [
        { "kind": "intent", "backend": "local",
          "request": { "system": "...", "user": "...", "max_tokens": 560, "temperature": 0.7 },
          "response": { "text": "...", "finish": "stop", "usage": { "prompt_tokens": 2400, "completion_tokens": 180 } } }
      ] },
    { "type": "reroll", "rng": [], "calls": [ "..." ] },
    { "type": "undo" }
  ]
}
```

- `settings`: only what changes prompts, call limits or memory budgets. Never API keys or URLs; replay uses placeholder URLs.
- `start`: the scenario travels inside the state, so a fixture keeps working when scenario files change.
- `actions`, in order. `turn` is `Engine.runTurn(state, action, stepId, cutAt)`; `cutAt` is the beat the player stepped in after. `reroll` and `undo` are the Debug/scene buttons. `correct` is a feelings correction from a card: `{ "type": "correct", "id": "okafor", "delta": -5, "why": "..." }` (no dice, no calls). `pin` is the card's 📌 Pin: `{ "type": "pin", "id": "sorensen", "on": true }` (no dice, no calls).
- `rng`: every `E.rng()` value the engine drew during the action, in order (the browser's random numbers can't be seeded, so the values themselves are kept).
- `calls`: every model call in order. `kind` is the step name (`intent`, `narrate`, `narrate (retry)`, `update`, `chapter`, ...). A failed call has `error: { name, message }` instead of `response`.
- `error` on an action: it failed when recorded (for example the model was unreachable), so the replay expects it to fail too.

## What replay checks

Step names, the number of calls, and the number of dice drawn, per action; plus that recorded failures fail again and nothing else fails. Prompt text is not compared, so editing a prompt doesn't break fixtures. Adding or removing a model call does: the replay stops with a message like

```
Replay mismatch at action 3 (turn "Ask Teo"), call 2: engine made "narrate (retry)", recording has "narrate"
```

When that change is intended, re-record the fixture (or edit its `calls` by hand).

## Using it in a test

```js
const { replay } = require('./replay');

test('Teo does not confess on the first question', async () => {
  const { steps, state } = await replay('teo-confesses-on-first-ask', { until: 3 });
  const teo = steps[2].state.pending.res.outcomes.find((o) => o.id === 'bauer');
  assert.equal(teo.reveals, null);
});
```

`replay(fixtureOrName, { until })` returns `{ E, state, steps }`; each step has `index`, `action`, a copy of `state` after it, `result`, and `error` (for recorded failures).

## Other fixtures

- `legacy-scenario/` and `legacy-zombie-holdout/`: the bundled Ares Deep and Holdout at Harmon's in the old single-file format (`scenario.json` + `characters/`), frozen before they were converted to worlds. Legacy loading stays permanently (players' own scenarios use it); `tests/worlds.test.js` checks they still load, and that each converted world's default start begins the same game.
- `slice-of-life/`: a small world with no needs and `slice-of-life, comedy` tags (three flatmates, two rooms). `tests/genre-neutral.test.js` plays it to keep survival assumptions out of the engine.
- `chrome-district/`: a small cyberpunk world with `generatedSites` and one library map (`sites/chop-shop.json`, the Saints' chop shop), for generated sites (task 4-4, `tests/sites.test.js`). Load it with Open folder to try new places by hand; the recordings `playtest-api-chop-shop` and `playtest-api-kessler-lobby` were made in it.
- `prompt-snapshots.json`: every prompt for a fixed state, byte for byte (`prompts.snapshot.test.js`).
