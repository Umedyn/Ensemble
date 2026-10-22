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

**Fan worlds** based on other people's settings are fine for your own play and noncommercial sharing, at your own responsibility. Ensemble never bundles, sells or features them, and they're removed from official Ensemble spaces on a rights holder's request. Don't make mods designed to produce content that's illegal.

## Site maps

Battlemaps and floor plans can be turned into site maps (planned: the Sites tab of the world maker): draw the rooms, doors and entrances on the image and tag it ("warehouse", "cyberpunk"), and any story that needs that kind of place can use it. Fill in `credit` and `license` for every map you share. Many battlemaps sold online don't allow redistribution, so only share maps you made or have the right to share.

## Content

Adults choose their own stories. Mature content is opt-in and rated per world, and the player sets their own maximum. There is one hard line: **no sexual content involving minors**. The engine enforces it in every mode, whatever model or service you use.

## Voices

On your own text-to-speech setup, which voices you use is your choice and your responsibility. Voice packs shared in official Ensemble spaces must not imitate real people's voices without permission. Hosted narration only uses voices from the approved catalog.

## Your own setup vs official services

What you run on your own models and keys is up to you. Content and voices that run through an official Ensemble service follow that service's rules.

If an official hub for sharing worlds ever exists, uploads to it will follow user-upload rules: allowed, the uploader's responsibility, taken down on request, and never sold or featured by us. A scenario being free doesn't make it fair use there, since the service itself would be paid.

## Making a world

A world folder holds the setting and a pool of characters (`world.json`, `characters/`) plus one or more **starts** (`starts/`): different ways into the same world, as a different person, place or moment.

1. Copy a folder in `scenarios/` (for example `mars-station`) and rename it.
2. Edit `world.json`, the files in `starts/` (one per id in `"starts"`) and the files in `characters/` (one per id in `"characters"`).
3. Load it with **Open folder** in the game, or add it to `scenarios/index.json` when running with the local server.
4. If the game reports problems, the messages say which field is wrong. With Node installed, `npm run check` validates every world and start.

The **Creator** (top bar, or `creator.html`) edits a world without touching JSON. So far it has the Map tab: load a map image, draw regions on it, set who holds them, their tags, neighbours and lore, place rooms, pick where each start begins and each group's colour, and export the world folder as a zip. Problems show as you edit. More tabs follow.

Older single-file scenario folders (`scenario.json` + `characters/`) still work and load as a world with one start.

The full field reference is in the README under "Making a world", and the spec is `docs/WORLDS.md`. Good worlds usually have:

- 4 to 6 characters, each with a clear want and a secret, and a `guard` that fits their personality
- relationships that already pull in different directions
- one or two pressure clocks, ideally with follow-ups (`then`) so long skips lead somewhere
- one or two groups whose stance can shift
- `eventSeeds` and `majorSeeds` lists in the world's own voice
- starts that see the same people from different angles: someone else's secret is more interesting when you're the one keeping yours
