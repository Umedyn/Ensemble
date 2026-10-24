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

Battlemaps and floor plans can be turned into site maps in the creator's **Sites** tab: load the image, set the grid if it has one (for measuring only: play is never square by square), draw each room's outline, click the line between two rooms to put a door there, mark ways in from outside and spots (guard post, cover, hiding place, loot, where people turn up), and give it a type and tags ("tavern", "inn, pub"). **Save to the world** puts it in your world's `sites/`, and any story heading to that kind of place uses it instead of making one up; the matching box shows which map a place would get. **Export for the library** makes a folder anyone can add with **Open folder** in the game, for worlds whose setting tags match its `setting`. You can also keep a place the game made during play (**From a save…**). The format is in `docs/WORLDS.md` › Generated sites.

Fill in `credit` and `license` for every map you share. Many battlemaps sold online don't allow redistribution, so only share maps you made or have the right to share. Maps bundled with Ensemble (`library/`) are original or CC0 only.

## Real places

Worlds set in the real world, in any era, can share one topographic base map (`library/maps/world/`, from Natural Earth, public domain): start a **New world** in the creator on it and pick an area. Draw your era's borders in the Map tab, or import today's with `npm run basemap -- regions <world> --within --places capitals` and redraw them (run `npm run basemap -- fetch` once first). Only the main area needs detail; far-off countries can be outlines and names. Historical border datasets online are often GPL, so don't bundle them with a world you share; draw borders yourself or start from Natural Earth. See `docs/WORLDS.md` › Base maps and real places.

## Content

Adults choose their own stories. Mature content is opt-in and rated per world, and the player sets their own maximum. There is one hard line: **no sexual content involving minors**. The engine enforces it in every mode, whatever model or service you use.

## Voices

On your own text-to-speech setup, which voices you use is your choice and your responsibility. Voice packs shared in official Ensemble spaces must not imitate real people's voices without permission. Hosted narration only uses voices from the approved catalog.

## Your own setup vs official services

What you run on your own models and keys is up to you. Content and voices that run through an official Ensemble service follow that service's rules.

If an official hub for sharing worlds ever exists, uploads to it will follow user-upload rules: allowed, the uploader's responsibility, taken down on request, and never sold or featured by us. A scenario being free doesn't make it fair use there, since the service itself would be paid.

How such a hub would work (planned, like Bethesda's Creations):

- Community uploads are free, fan works included. Uploaders confirm they have the rights to what they upload and accept responsibility for it.
- A registered DMCA agent, a published takedown and counter-notice process, and a repeat-offender policy. Takedowns are acted on promptly.
- **Franchise content is never charged for, bundled, featured or placed behind a paywall.** A subscription pays for the service, not for access to someone else's franchise. Paid or featured content must be original or licensed, and original work gets the spotlight.
- The maintainer's own fan mods are posted elsewhere under a personal handle, never on or through the official hub.
- Until then, content shared on GitHub or Discord follows those platforms' takedown processes.

## Lore packs and real people

Lore is the game's wiki: the game pulls in only what fits where the player is and what's happening, so one world can hold very different lives. Planned add-on **lore packs** ("Tokyo school life", "Silicon Valley startups") plug into an existing world, a smaller way to contribute than a whole world. Write entries for what a small model gets wrong or vague, the world's deviations from reality, and the facts the story will lean on; short and specific beats long and general.

Real public figures belong in lore, not in the cast: they're news and background, met only if the player seeks them out. In real-world maps, people in lore count as real unless marked `fictional: true`, and real people are never part of mature content, in any mode. Fictional characters from other works aren't real people; for them only copyright matters (see Responsibility for mods). Portraits or voices imitating a real person, including the actor who played a fictional character, aren't allowed in official spaces without permission.

## Making a world

A world folder holds the setting and a pool of characters (`world.json`, `characters/`) plus one or more **starts** (`starts/`): different ways into the same world, as a different person, place or moment.

1. Copy a folder in `scenarios/` (for example `mars-station`) and rename it.
2. Edit `world.json`, the files in `starts/` (one per id in `"starts"`) and the files in `characters/` (one per id in `"characters"`).
3. Load it with **Open folder** in the game, or add it to `scenarios/index.json` when running with the local server.
4. If the game reports problems, the messages say which field is wrong. With Node installed, `npm run check` validates every world and start.

The **Creator** (top bar, or `creator.html`) edits a world without touching JSON: its world, groups, starts, characters, map, sites, lore and timeline, with problems shown as you edit, and exports the world folder as a zip. **New world** can start blank, on the shared base map, or from a template (One country with provinces, One city, Planets and travel).

**Regions in three steps:** a flat list of regions is a whole world; add `parent` where you want more detail; add `routes` and `map` only if travel or pictures matter. See `docs/WORLDS.md` › Regions in three steps, with worked examples (a country with zones, detail in one place, planets).

Older single-file scenario folders (`scenario.json` + `characters/`) still work and load as a world with one start.

The full field reference is in the README under "Making a world", and the spec is `docs/WORLDS.md`. Good worlds usually have:

- 4 to 6 characters, each with a clear want and a secret, and a `guard` that fits their personality
- relationships that already pull in different directions
- one or two pressure clocks, ideally with follow-ups (`then`) so long skips lead somewhere
- one or two groups whose stance can shift
- `eventSeeds` and `majorSeeds` lists in the world's own voice
- starts that see the same people from different angles: someone else's secret is more interesting when you're the one keeping yours
