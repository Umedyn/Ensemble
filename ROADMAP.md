# Roadmap

## Now: validate with real models

The engine has grown faster than real playtesting. Before adding features:

- [ ] Play each time step with the real model (KoboldCpp, Mistral-Tekken adapter) and check: beat markers written reliably, step-in works mid-scene, events feel meaningful rather than filler.
- [ ] Run several major-event skips in a row; check montage quality and that positions and needs make sense afterward.
- [ ] Try Hybrid routing with a large API model for intent and narration; compare against all-local.
- [ ] Tune from logs: reveal thresholds, event rates, chapter length, scene lengths.
- [ ] Play the zombie holdout end to end (it has had far less testing than Mars).

## Next

- **Custom player character.** A form that produces the same character JSON: name, pronouns, gender, description/appearance, role, traits, voice, skills, starting feelings toward each person. The scenario provides the slot (start location, skill list, suggested role).
- **Character details.** Expandable section on each person's card: description, appearance, pronouns, what the player knows about them.
- **Correct your feelings.** Let the player nudge their own attitude toward someone when the model misreads tone (sarcasm read as hostility).
- **Character card import** (SillyTavern/Tavern PNG or JSON). Read the card, run one conversion call into a character sheet (traits, want, voice, a secret if implied), show it for review, add it to a scenario's cast. Keep the personality, drop the card's original scenario framing.
- **Hosting.** Turn on GitHub Pages for the repo so the game has a link for phones and friends.

## Later

- **Relationship web**: a small force-directed graph of how people feel about each other.
- **Location map**: clickable floor plan or node map with who is where.
- **Director**: tension tracking that nudges events up or down to keep pacing interesting.
- **Scenario editor**: create and edit scenarios in the browser, export as a folder.
- **Streaming narration**: show the scene as it's written.
- **Voices**: per-character Piper voices (reuse StreamTTS pieces).
- **Stream mode**: Twitch chat votes on the player's action.
- **Installable app (PWA)** and optional save sync to the player's own cloud drive.
- **Native port** (e.g. Godot) if it outgrows the browser; the JSON state and prompt chain port as-is.

## Open questions

- Should random major events have a minimum delay, or is "anything can happen" the right feel? (Current answer: anything goes; the skip means "let's see what happens".)
- How should very long campaigns handle context: summarize chapters into arcs?
- Recommended API models for narration quality vs cost.

## Before publishing

- [x] License: PolyForm Noncommercial 1.0.0 (`LICENSE`), contributor terms (`CONTRIBUTING.md`), mod policy (`MODDING.md`).
- [ ] Check the name "Ensemble" for conflicts.
- [ ] Short privacy note: everything stays in the browser; API calls go directly to the provider the player chose.
- [ ] Before selling anything: a short EULA for the paid build, and a quick legal review of the license setup.

## Revenue (low-key, optional)

Code stays public and the game stays free. Possible income, in order: a Ko-fi or itch.io pay-what-you-want page once people are playing; supporters get builds or scenarios early (everything goes public later); a paid one-click desktop build (KoboldCpp and a model bundled) if there's demand. A hosted token service is deliberately out of scope for now: inference costs, accounts, billing and content moderation make it a separate business.
