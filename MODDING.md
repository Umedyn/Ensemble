# Modding Ensemble

Ensemble is built to be modded. A world (setting, cast, places, groups, pressures, events, and the starts that lead into it) is a folder of JSON files, and the world folder is the official mod format. Older single-file scenario folders work too.

## What you own

**Worlds, scenarios, characters and other content you create are yours.** You can share them, give them away, and choose your own terms for them. They aren't covered by Ensemble's license, because they don't contain Ensemble's code.

The two bundled scenarios (Ares Deep and Holdout at Harmon's) are part of Ensemble and covered by its license. You're welcome to use them as templates and to share modified versions noncommercially.

## What the license allows

Under the PolyForm Noncommercial License you can, for any noncommercial purpose:

- play, study and modify the engine
- share copies and modified versions (include the `LICENSE` file, or its URL, and the `Required Notice` line)
- build tools, scenario editors and other projects on top of it

What you can't do is use the engine commercially: sell it, sell a modified version, or run it as a paid service. If you have a commercial idea, get in touch; the owner may be able to license it separately.

## Responsibility for mods

Mods made and shared by the community are the responsibility of their creators. Ensemble's maintainers don't review, host or endorse mods unless they are published on an official Ensemble site, in which case that site's rules apply.

Please don't make mods that use other people's copyrighted characters or settings without permission, or that are designed to produce content that's illegal.

## Making a world

A world folder holds the setting and a pool of characters (`world.json`, `characters/`) plus one or more **starts** (`starts/`): different ways into the same world, as a different person, place or moment.

1. Copy a folder in `scenarios/` (for example `mars-station`) and rename it.
2. Edit `world.json`, the files in `starts/` (one per id in `"starts"`) and the files in `characters/` (one per id in `"characters"`).
3. Load it with **Open folder** in the game, or add it to `scenarios/index.json` when running with the local server.
4. If the game reports problems, the messages say which field is wrong. With Node installed, `npm run check` validates every world and start.

Older single-file scenario folders (`scenario.json` + `characters/`) still work and load as a world with one start.

The full field reference is in the README under "Making a world", and the spec is `docs/WORLDS.md`. Good worlds usually have:

- 4 to 6 characters, each with a clear want and a secret, and a `guard` that fits their personality
- relationships that already pull in different directions
- one or two pressure clocks, ideally with follow-ups (`then`) so long skips lead somewhere
- one or two groups whose stance can shift
- `eventSeeds` and `majorSeeds` lists in the world's own voice
- starts that see the same people from different angles: someone else's secret is more interesting when you're the one keeping yours
