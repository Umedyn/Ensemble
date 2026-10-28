// The map builder for scenarios/frontier (task 7-4). Build time only:
// nothing here runs in the game.
//
//   node tools/frontier.mjs build     the pictures in maps/, and the regions and maps in world.json
//
// Sources: Natural Earth (public domain; "Made with Natural Earth"): the base
// raster, 1:50m countries and 1:10m states, from .cache/basemap/ (run "npm
// run basemap -- fetch --states" first). Nothing else is downloaded.
//
// The United States of spring 1866 from today's outlines: the Dakotas and
// Wyoming one Dakota Territory, Oklahoma's panhandle the unclaimed strip and
// the rest Indian Territory; the country in six sections; the lands of the
// Native nations drawn over the territories by hand from the period's
// treaty maps, so their edges are approximate; forts, landmarks and towns
// as points, joined by the trails, stage lines, rails, rivers and the sea,
// with travel times of the time. Boston and San Francisco get maps of their
// own: the shore of 1866 (Boston's Back Bay half filled, San Francisco's
// Mission Bay still water) traced by hand from the U.S. Coast Survey charts
// of the 1850s and 1860s (public domain), districts as cells around
// landmarks clipped to it, and the main streets of the time as decoration.
//
// Building again keeps every field it doesn't own (lore, tags, status,
// startable, known…) on regions with the same id, the maps' room points, and
// the rest of world.json as it is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readTiff, cut, writeJpeg, SOURCES } from './basemap.mjs';
import { ringsOf, open, union, intersect } from './polygons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadEngine } = require(path.join(root, 'tests', 'helpers.js'));
const E = loadEngine();
const G = E.Geo;
const WORLD = path.join(root, 'scenarios', 'frontier');
const NE = path.join(root, '.cache', 'basemap');
const CREDIT_NE = 'Made with Natural Earth (naturalearthdata.com): 1:50m cross-blended hypsometric tints with shaded relief and water; borders of 1866 and the nations\' lands drawn for the game, approximate';
const CREDIT_CITY = 'Drawn for Ensemble: the shore and streets of 1866 traced by hand from U.S. Coast Survey charts of the 1850s–1860s (public domain); district edges approximate';

// ---------- the map's frame ----------
const AMERICA = [-125.5, 24, -66, 50.5];

// ---------- the country in 1866 ----------
const SECTIONS = [
  { id: 'northeast', name: 'The Northeast', states: ['ME', 'NH', 'VT', 'MA', 'RI', 'CT', 'NY', 'NJ', 'PA', 'DE', 'MD', 'WV'] },
  { id: 'midwest', name: 'The Midwest', states: ['OH', 'IN', 'IL', 'MI', 'WI', 'MN', 'IA', 'MO', 'KY'] },
  { id: 'south', name: 'The South', states: ['VA', 'NC', 'SC', 'GA', 'FL', 'AL', 'MS', 'LA', 'AR', 'TN', 'TX'] },
  { id: 'plains', name: 'The Great Plains', states: ['KS', 'NE', 'DAKOTA', 'IT', 'STRIP'] },
  { id: 'mountain-west', name: 'The Mountain West', states: ['MT', 'ID', 'CO', 'UT', 'NV', 'NM', 'AZ'] },
  { id: 'pacific', name: 'The Pacific Coast', states: ['CA', 'OR', 'WA'] },
];
// Natural Earth postal codes → regions of 1866. Several codes make one.
const MERGED = {
  DAKOTA: { id: 'dakota', name: 'Dakota Territory', codes: ['ND', 'SD', 'WY'], label: 'territory' },
};
const TERRITORIES = new Set(['NE', 'MT', 'ID', 'CO', 'UT', 'NM', 'AZ', 'WA', 'DAKOTA', 'IT']);
const NAME_OF = { NE: 'Nebraska Territory', MT: 'Montana Territory', ID: 'Idaho Territory', CO: 'Colorado Territory', UT: 'Utah Territory', NM: 'New Mexico Territory', AZ: 'Arizona Territory', WA: 'Washington Territory' };
// Oklahoma: Indian Territory east of the 100th meridian, the unclaimed strip west of it.
const PANHANDLE = [[-103.1, 36.4], [-100.0, 36.4], [-100.0, 37.1], [-103.1, 37.1]];
const NOT_PANHANDLE = [[-100.0, 33.5], [-94.3, 33.5], [-94.3, 37.1], [-100.0, 37.1]];

// ---------- the lands of the Native nations ----------
// Drawn by hand, [lon, lat], over the territory that holds most of them,
// and clipped to it. Approximate, as the treaty lines of the time were.
const LANDS = [
  { id: 'powder-river', name: 'Powder River Country', in: 'dakota', controller: 'lakota',
    ring: [[-108.4, 45.0], [-104.05, 45.0], [-104.05, 43.4], [-105.2, 42.95], [-107.3, 42.95], [-108.4, 43.7]] },
  { id: 'black-hills', name: 'The Black Hills (Paha Sapa)', in: 'dakota', controller: 'lakota',
    ring: [[-104.3, 44.65], [-103.35, 44.6], [-103.15, 44.0], [-103.4, 43.45], [-104.15, 43.5], [-104.4, 44.0]] },
  { id: 'wind-river', name: 'The Wind River country', in: 'dakota', controller: 'shoshone',
    ring: [[-110.0, 43.75], [-108.3, 43.85], [-107.55, 43.1], [-108.2, 42.25], [-109.4, 42.2], [-110.1, 42.9]] },
  { id: 'smoky-hill', name: 'The Smoky Hill and Republican country', in: 'kansas', controller: 'cheyenne',
    ring: [[-102.1, 40.05], [-99.4, 40.05], [-99.4, 38.35], [-102.1, 38.35]] },
  { id: 'comancheria', name: 'Comanchería (the Llano Estacado)', in: 'texas', controller: 'comanche',
    ring: [[-103.1, 36.55], [-100.0, 36.55], [-98.6, 34.1], [-99.3, 31.6], [-103.1, 31.9]] },
  { id: 'ute-country', name: 'The Ute country', in: 'colorado', controller: 'ute',
    ring: [[-109.1, 41.05], [-106.3, 41.05], [-105.9, 39.0], [-106.3, 36.95], [-109.1, 36.95]] },
  { id: 'apacheria', name: 'Apachería (the Apache country)', in: 'arizona', controller: 'apache',
    ring: [[-112.1, 34.7], [-109.0, 34.7], [-109.0, 31.3], [-111.4, 31.3], [-112.4, 32.8]] },
  { id: 'dinetah', name: 'Dinétah (the Navajo country)', in: 'arizona', controller: null,
    ring: [[-111.3, 37.05], [-109.0, 37.05], [-109.0, 35.1], [-110.9, 35.3]] },
  { id: 'crow-country', name: 'The Crow country (the Yellowstone)', in: 'montana', controller: 'crow',
    ring: [[-111.1, 46.25], [-107.5, 46.6], [-104.0, 45.9], [-104.0, 44.95], [-111.1, 44.95]] },
  { id: 'blackfeet-country', name: 'The Blackfeet country', in: 'montana', controller: 'blackfeet',
    ring: [[-114.1, 49.05], [-107.9, 49.05], [-108.4, 47.3], [-113.1, 47.2]] },
  { id: 'nez-perce-country', name: 'The Nez Perce country (the Clearwater)', in: 'idaho', controller: 'nez-perce',
    ring: [[-117.3, 46.7], [-115.1, 46.7], [-115.3, 45.4], [-117.3, 45.4]] },
];

// ---------- places as regions: cities, forts, landmarks, towns ----------
// [id, name, label, lon, lat, extra]. Each goes under the land or state
// whose outline holds it, unless "in" says otherwise.
const POINTS = [
  // Cities.
  ['boston', 'Boston', 'city', -71.06, 42.36, { notable: true }],
  ['new-york-city', 'New York', 'city', -74.0, 40.71],
  ['philadelphia', 'Philadelphia', 'city', -75.16, 39.95],
  ['washington', 'Washington', 'capital', -77.04, 38.9, { in: 'northeast' }],
  ['chicago', 'Chicago', 'city', -87.63, 41.88],
  ['st-louis', 'St. Louis', 'city', -90.2, 38.63],
  ['new-orleans', 'New Orleans', 'city', -90.07, 29.95],
  ['san-antonio', 'San Antonio', 'town', -98.49, 29.42],
  ['denver', 'Denver', 'town', -104.99, 39.74],
  ['salt-lake-city', 'Great Salt Lake City', 'city', -111.89, 40.76],
  ['sacramento', 'Sacramento', 'city', -121.49, 38.58],
  ['san-francisco', 'San Francisco', 'city', -122.42, 37.78, { notable: true }],
  ['portland', 'Portland', 'town', -122.68, 45.52],
  ['santa-fe', 'Santa Fe', 'town', -105.94, 35.69],
  ['tucson', 'Tucson', 'town', -110.97, 32.22],
  ['virginia-city-nv', 'Virginia City (the Comstock)', 'town', -119.65, 39.31],
  ['virginia-city-mt', 'Virginia City (Alder Gulch)', 'town', -111.94, 45.29],
  ['helena', 'Helena (Last Chance Gulch)', 'town', -112.03, 46.59],
  ['omaha', 'Omaha', 'town', -95.94, 41.26],
  ['st-joseph', 'St. Joseph', 'town', -94.85, 39.77],
  ['kansas-city', 'Kansas City and Westport', 'town', -94.58, 39.1],
  ['sedalia', 'Sedalia', 'town', -93.23, 38.7],
  ['tahlequah', 'Tahlequah (the Cherokee capital)', 'town', -94.97, 35.91],
  // The four towns the story lives in (three of them made up; Julesburg real).
  ['haddon', 'Haddon', 'town', -99.95, 40.87, { notable: true }],
  ['salt-lick', 'Salt Lick', 'town', -98.05, 38.98, { notable: true }],
  ['julesburg', 'Julesburg', 'town', -102.3, 40.98, { notable: true }],
  ['poormans-gulch', 'Poorman\'s Gulch', 'camp', -108.72, 42.55],
  // Forts and landmarks.
  ['fort-kearny', 'Fort Kearny', 'fort', -99.0, 40.64, { controller: 'army' }],
  ['pawnee-reservation', 'The Pawnee reservation (the Loup)', 'reservation', -98.0, 41.4, { controller: 'pawnee' }],
  ['chimney-rock', 'Chimney Rock and Scotts Bluff', 'landmark', -103.5, 41.75],
  ['fort-laramie', 'Fort Laramie', 'fort', -104.56, 42.21, { controller: 'army' }],
  ['platte-bridge', 'Platte Bridge (Fort Caspar)', 'fort', -106.36, 42.84, { controller: 'army' }],
  ['independence-rock', 'Independence Rock and the Sweetwater', 'landmark', -107.13, 42.49],
  ['south-pass', 'South Pass', 'landmark', -108.88, 42.36],
  ['fort-bridger', 'Fort Bridger', 'fort', -110.38, 41.32, { controller: 'army' }],
  ['fort-reno', 'Fort Reno', 'fort', -106.09, 43.84, { controller: 'army' }],
  ['fort-phil-kearny', 'Fort Phil Kearny', 'fort', -106.82, 44.53, { controller: 'army' }],
  ['cheyenne-town', 'Cheyenne (Crow Creek Crossing)', 'town', -104.82, 41.14],
  ['fort-hall', 'Fort Hall', 'fort', -112.44, 43.03],
  ['boise', 'Boise City and Fort Boise', 'town', -116.2, 43.62],
  ['the-dalles', 'The Dalles', 'town', -121.18, 45.6],
  ['oregon-city', 'Oregon City', 'town', -122.61, 45.36],
  ['humboldt-sink', 'The Humboldt Sink', 'landmark', -118.55, 39.95],
  ['dutch-flat', 'Dutch Flat and the Sierra grade', 'camp', -120.84, 39.21],
  ['donner-summit', 'Donner Summit', 'landmark', -120.33, 39.32],
  ['promontory', 'The Promontory Mountains', 'landmark', -112.55, 41.62],
  ['fort-benton', 'Fort Benton', 'town', -110.67, 47.82],
  ['council-grove', 'Council Grove', 'town', -96.49, 38.66],
  ['fort-larned', 'Fort Larned', 'fort', -99.22, 38.18, { controller: 'army' }],
  ['fort-lyon', 'Fort Lyon (by Bent\'s old fort)', 'fort', -103.0, 38.08, { controller: 'army' }],
  ['fort-union', 'Fort Union', 'fort', -105.0, 35.9, { controller: 'army' }],
  ['bosque-redondo', 'Bosque Redondo (Fort Sumner)', 'reservation', -104.25, 34.4, { controller: 'army' }],
  ['fort-bowie', 'Fort Bowie and Apache Pass', 'fort', -109.43, 32.15, { controller: 'army' }],
  ['red-river', 'The Red River crossing', 'landmark', -97.75, 33.85],
];

// ---------- routes ----------
// Kinds, and what each needs (the time on each route is its own).
const ROUTE_KINDS = {
  wagon: { time: '10d' },
  'cattle trail': { time: '20d' },
  stage: { time: '2d' },
  rail: { time: '1d' },
  steamboat: { time: '3d' },
  sea: { time: '20d' },
  ferry: { time: '30m' },
  bridge: { time: '15m' },
  overland: { time: '10d' },
};
const PASSES = { requires: { world: 'mountain passes', is: 'open' }, risky: true, skill: 'trailcraft', failHarm: true };
const SIERRA = { requires: { world: 'Sierra passes', is: 'open' }, risky: true, skill: 'trailcraft', failHarm: true };
const RIVER = { requires: { world: 'rivers', is: 'fordable' }, risky: true, skill: 'trailcraft', failHarm: true };
const BOZEMAN = { requires: { world: 'Bozeman Trail', is: 'open' }, risky: true, skill: 'trailcraft', failHarm: true };
const rails = (key) => ({ requires: { world: key, is: 'laid' } });
// [from, to, kind, time, extra]
const ROUTES = [
  // The East by rail.
  ['boston', 'new-york-city', 'rail', '10h'], ['new-york-city', 'philadelphia', 'rail', '4h'], ['philadelphia', 'washington', 'rail', '6h'],
  ['new-york-city', 'chicago', 'rail', '2d'], ['chicago', 'st-louis', 'rail', '14h'], ['chicago', 'st-joseph', 'rail', '1d'],
  ['st-louis', 'sedalia', 'rail', '8h'], ['sedalia', 'kansas-city', 'rail', '5h'], ['st-louis', 'new-orleans', 'steamboat', '6d'],
  ['chicago', 'omaha', 'stage', '3d'], ['chicago', 'omaha', 'rail', '1d', rails('rails to Council Bluffs')],
  // The sea.
  ['new-york-city', 'san-francisco', 'sea', '22d'], ['boston', 'san-francisco', 'sea', '110d'], ['new-york-city', 'new-orleans', 'sea', '7d'],
  ['san-francisco', 'portland', 'sea', '4d'], ['new-orleans', 'san-antonio', 'stage', '6d'],
  // The Missouri.
  ['st-louis', 'omaha', 'steamboat', '6d'], ['omaha', 'fort-benton', 'steamboat', '35d', { requires: { world: 'upper Missouri', is: 'navigable' } }],
  ['st-joseph', 'omaha', 'steamboat', '2d'], ['kansas-city', 'st-joseph', 'steamboat', '1d'],
  // The Oregon and California trail, and the Union Pacific along it.
  ['omaha', 'fort-kearny', 'wagon', '12d'], ['omaha', 'fort-kearny', 'stage', '2d'], ['omaha', 'fort-kearny', 'rail', '12h', rails('rails to Fort Kearny')],
  ['st-joseph', 'fort-kearny', 'wagon', '18d'], ['st-joseph', 'fort-kearny', 'stage', '3d'],
  ['fort-kearny', 'haddon', 'wagon', '4d'], ['fort-kearny', 'haddon', 'stage', '12h'], ['fort-kearny', 'haddon', 'rail', '4h', rails('rails to Haddon')],
  ['fort-kearny', 'pawnee-reservation', 'wagon', '5d'],
  ['haddon', 'julesburg', 'wagon', '10d'], ['haddon', 'julesburg', 'stage', '2d'], ['haddon', 'julesburg', 'rail', '8h', rails('rails to Julesburg')],
  ['julesburg', 'chimney-rock', 'wagon', '7d'], ['julesburg', 'denver', 'stage', '2d'], ['julesburg', 'denver', 'wagon', '14d'],
  ['julesburg', 'cheyenne-town', 'wagon', '9d'], ['julesburg', 'cheyenne-town', 'rail', '8h', rails('rails to Cheyenne')],
  ['chimney-rock', 'fort-laramie', 'wagon', '5d'],
  ['fort-laramie', 'platte-bridge', 'wagon', '8d'], ['platte-bridge', 'independence-rock', 'wagon', '4d', RIVER],
  ['independence-rock', 'south-pass', 'wagon', '7d'], ['south-pass', 'poormans-gulch', 'wagon', '1d'],
  ['south-pass', 'fort-bridger', 'wagon', '8d', RIVER], ['fort-bridger', 'salt-lake-city', 'wagon', '7d', PASSES], ['fort-bridger', 'fort-hall', 'wagon', '12d'],
  ['salt-lake-city', 'fort-hall', 'wagon', '8d'], ['salt-lake-city', 'promontory', 'wagon', '4d'],
  ['fort-hall', 'boise', 'wagon', '18d', RIVER], ['boise', 'the-dalles', 'wagon', '20d', PASSES],
  ['the-dalles', 'oregon-city', 'wagon', '10d', PASSES], ['the-dalles', 'portland', 'steamboat', '1d'], ['oregon-city', 'portland', 'wagon', '4h'],
  ['fort-hall', 'humboldt-sink', 'wagon', '25d'], ['humboldt-sink', 'virginia-city-nv', 'wagon', '4d'],
  ['virginia-city-nv', 'donner-summit', 'wagon', '3d'], ['virginia-city-nv', 'sacramento', 'stage', '2d', SIERRA],
  ['donner-summit', 'dutch-flat', 'wagon', '2d', SIERRA], ['dutch-flat', 'sacramento', 'rail', '5h'], ['sacramento', 'san-francisco', 'steamboat', '10h'],
  ['donner-summit', 'virginia-city-nv', 'rail', '10h', rails('rails over the Sierra')],
  ['omaha', 'sacramento', 'rail', '4d', { requires: { world: 'Pacific railroad', is: 'complete' } }], ['salt-lake-city', 'promontory', 'rail', '6h', { requires: { world: 'Pacific railroad', is: 'complete' } }],
  // The stage lines across the middle.
  ['denver', 'salt-lake-city', 'stage', '6d', PASSES], ['salt-lake-city', 'virginia-city-nv', 'stage', '5d'],
  ['salt-lake-city', 'virginia-city-mt', 'stage', '4d'], ['fort-hall', 'virginia-city-mt', 'wagon', '9d'],
  ['virginia-city-mt', 'helena', 'stage', '1d'], ['helena', 'fort-benton', 'wagon', '5d'], ['boise', 'virginia-city-mt', 'wagon', '16d'],
  // The Bozeman Trail through the Powder River country.
  ['fort-laramie', 'fort-reno', 'wagon', '8d', BOZEMAN], ['fort-reno', 'fort-phil-kearny', 'wagon', '3d', BOZEMAN],
  ['fort-phil-kearny', 'virginia-city-mt', 'wagon', '20d', BOZEMAN],
  ['fort-laramie', 'black-hills', 'wagon', '8d'], ['fort-laramie', 'powder-river', 'wagon', '8d'], ['fort-laramie', 'cheyenne-town', 'wagon', '5d'],
  ['south-pass', 'wind-river', 'wagon', '3d'], ['fort-bridger', 'wind-river', 'wagon', '6d'],
  // The Santa Fe Trail, and the Smoky Hill.
  ['kansas-city', 'council-grove', 'wagon', '8d'], ['council-grove', 'fort-larned', 'wagon', '9d'],
  ['fort-larned', 'fort-lyon', 'wagon', '12d'], ['fort-lyon', 'fort-union', 'wagon', '12d', PASSES],
  ['fort-larned', 'fort-union', 'wagon', '16d', { requires: { world: 'Cimarron route', is: 'quiet' }, risky: true, skill: 'trailcraft', failHarm: true }],
  ['fort-union', 'santa-fe', 'wagon', '4d'], ['santa-fe', 'bosque-redondo', 'wagon', '6d'], ['santa-fe', 'denver', 'stage', '6d', PASSES],
  ['fort-lyon', 'denver', 'wagon', '8d'], ['santa-fe', 'tucson', 'wagon', '20d'], ['tucson', 'fort-bowie', 'wagon', '4d'],
  ['santa-fe', 'dinetah', 'wagon', '10d'], ['tucson', 'apacheria', 'wagon', '3d'],
  ['kansas-city', 'salt-lick', 'stage', '3d'], ['kansas-city', 'salt-lick', 'wagon', '12d'], ['kansas-city', 'salt-lick', 'rail', '1d', rails('rails to Salt Lick')],
  ['salt-lick', 'fort-larned', 'wagon', '5d'], ['salt-lick', 'smoky-hill', 'wagon', '4d'], ['salt-lick', 'denver', 'stage', '5d'],
  ['council-grove', 'salt-lick', 'wagon', '5d'],
  // The cattle trails north from Texas.
  ['san-antonio', 'red-river', 'cattle trail', '25d'], ['red-river', 'salt-lick', 'cattle trail', '30d'],
  ['red-river', 'sedalia', 'cattle trail', '35d', { requires: { world: 'Missouri border', is: 'open to Texas cattle' }, risky: true, skill: 'persuasion' }],
  ['red-river', 'tahlequah', 'wagon', '10d'], ['tahlequah', 'kansas-city', 'wagon', '10d'],
  ['san-antonio', 'comancheria', 'wagon', '8d'], ['san-antonio', 'santa-fe', 'wagon', '30d'],
  // The rest of the West's lands, from the nearest place.
  ['denver', 'ute-country', 'wagon', '6d', PASSES], ['virginia-city-mt', 'crow-country', 'wagon', '6d'], ['fort-benton', 'blackfeet-country', 'wagon', '3d'],
  ['boise', 'nez-perce-country', 'wagon', '8d'], ['the-dalles', 'nez-perce-country', 'wagon', '12d'],
  ['fort-phil-kearny', 'crow-country', 'wagon', '5d', BOZEMAN],
];
// Sections next door to each other.
const SECTION_ROUTES = [['northeast', 'midwest'], ['northeast', 'south'], ['midwest', 'south'], ['midwest', 'plains'], ['south', 'plains'], ['plains', 'mountain-west'],
  ['south', 'mountain-west'], ['mountain-west', 'pacific']];
// Countries next door.
const ABROAD = [
  { id: 'british-north-america', name: 'British North America', codes: ['CAN'] },
  { id: 'mexico', name: 'Mexico', codes: ['MEX'] },
];
const ABROAD_ROUTES = [
  ['british-north-america', 'new-york-city', 'rail', '2d'], ['british-north-america', 'washington-territory', 'sea', '2d'],
  ['british-north-america', 'blackfeet-country', 'wagon', '5d'],
  ['mexico', 'san-antonio', 'wagon', '10d'], ['mexico', 'tucson', 'wagon', '8d'], ['mexico', 'san-francisco', 'sea', '10d'],
];

// ---------- the two cities ----------
// Land of 1866, [lon, lat], counter-clockwise or not (fixed when used).
const CITIES = [
  { id: 'boston', bounds: [-71.13, 42.31, -71.0, 42.395], width: 1800,
    land: [
      // Boston proper, the Neck, the South End and the Back Bay as far as it
      // was filled; the mainland south and west; South Boston and Dorchester.
      [[-71.062, 42.3672], [-71.056, 42.3692], [-71.0525, 42.3685], [-71.05, 42.366], [-71.05, 42.363], [-71.0485, 42.3602], [-71.0505, 42.3585],
        [-71.05, 42.356], [-71.051, 42.3535], [-71.053, 42.352], [-71.0555, 42.3495], [-71.058, 42.3465], [-71.06, 42.343], [-71.063, 42.34],
        [-71.065, 42.337], [-71.067, 42.334], [-71.069, 42.331], [-71.066, 42.329], [-71.061, 42.33], [-71.057, 42.334], [-71.056, 42.339],
        [-71.0545, 42.344], [-71.0525, 42.348], [-71.0505, 42.351], [-71.046, 42.348], [-71.04, 42.344], [-71.033, 42.34], [-71.025, 42.338],
        [-71.02, 42.334], [-71.025, 42.331], [-71.035, 42.33], [-71.042, 42.329], [-71.045, 42.324], [-71.047, 42.315], [-71.05, 42.305],
        [-71.14, 42.305], [-71.14, 42.36], [-71.11, 42.356], [-71.1, 42.352], [-71.095, 42.348], [-71.09, 42.346], [-71.082, 42.346],
        [-71.0755, 42.3475], [-71.0755, 42.3557], [-71.0705, 42.3565], [-71.0712, 42.36], [-71.0705, 42.3625], [-71.067, 42.3655], [-71.064, 42.3665]],
      // Charlestown, and the mainland north of the river (Cambridge).
      [[-71.065, 42.369], [-71.06, 42.37], [-71.056, 42.371], [-71.051, 42.3715], [-71.05, 42.3745], [-71.054, 42.377], [-71.062, 42.38],
        [-71.07, 42.383], [-71.076, 42.386], [-71.08, 42.4], [-71.14, 42.4], [-71.14, 42.365], [-71.11, 42.362], [-71.09, 42.359], [-71.08, 42.3605],
        [-71.073, 42.364], [-71.07, 42.369]],
      // East Boston.
      [[-71.043, 42.364], [-71.041, 42.368], [-71.039, 42.374], [-71.035, 42.378], [-71.028, 42.381], [-71.02, 42.383], [-71.015, 42.379],
        [-71.017, 42.372], [-71.023, 42.366], [-71.03, 42.362], [-71.037, 42.3605]],
    ],
    // Water drawn over the land: the Back Bay's open basin is outside the
    // land already; the Mill Dam across it is a road.
    cells: [
      { id: 'boston-north-end', name: 'The North End', at: [-71.0545, 42.365] },
      { id: 'boston-west-end', name: 'Beacon Hill and the West End', at: [-71.066, 42.3605] },
      { id: 'boston-downtown', name: 'State Street and the market', at: [-71.0575, 42.3595] },
      { id: 'boston-fort-hill', name: 'Fort Hill and the wharves', at: [-71.0535, 42.3548] },
      { id: 'boston-common', name: 'The Common and Washington Street', at: [-71.063, 42.3545] },
      { id: 'boston-back-bay', name: 'The Back Bay (the new land)', at: [-71.0725, 42.3515] },
      { id: 'boston-south-end', name: 'The South End', at: [-71.0705, 42.341] },
      { id: 'roxbury', name: 'Roxbury', at: [-71.092, 42.326], label: 'town' },
      { id: 'south-boston', name: 'South Boston', at: [-71.042, 42.336] },
      { id: 'charlestown', name: 'Charlestown', at: [-71.062, 42.376], label: 'town' },
      { id: 'cambridge', name: 'Cambridge', at: [-71.11, 42.375], label: 'town' },
      { id: 'east-boston', name: 'East Boston', at: [-71.03, 42.372] },
    ],
    // Across the water: bridges and the ferry.
    links: [['boston-north-end', 'charlestown', 'bridge', '15m'], ['boston-north-end', 'east-boston', 'ferry', '20m'], ['boston-west-end', 'cambridge', 'bridge', '30m'],
      ['boston-fort-hill', 'south-boston', 'bridge', '20m'], ['boston-south-end', 'south-boston', 'bridge', '20m'], ['boston-back-bay', 'cambridge', 'bridge', '45m']],
    places: [['The State House', -71.0637, 42.3587], ['Faneuil Hall', -71.0562, 42.36], ['Old North Church', -71.0544, 42.3663], ['Long Wharf', -71.05, 42.3601],
      ['Boston Common', -71.066, 42.355], ['The Public Garden', -71.0697, 42.354], ['Massachusetts General Hospital', -71.0687, 42.3627],
      ['Boston and Worcester depot', -71.059, 42.3497], ['Boston and Providence depot (Park Square)', -71.068, 42.3505], ['The Navy Yard', -71.0545, 42.3735],
      ['Bunker Hill Monument', -71.0608, 42.3763], ['Harvard College', -71.1167, 42.3744], ['Cunard wharf', -71.039, 42.3665], ['The Mill Dam', -71.085, 42.352]],
    // Decoration (rule 11): the street grids of the new land, the old town's
    // main streets, wharves, bridges and the Mill Dam across the water,
    // railroads, and the names of the water.
    grids: [
      { area: [[-71.0712, 42.3562], [-71.0755, 42.3557], [-71.0755, 42.3478], [-71.068, 42.3497], [-71.0697, 42.352]], angle: 22, along: 0.0008, across: 0.0016 },
      { area: [[-71.0655, 42.3488], [-71.07, 42.3458], [-71.0795, 42.3378], [-71.073, 42.333], [-71.0665, 42.3395], [-71.0635, 42.3435]], angle: 65, along: 0.0011, across: 0.0011 },
      { area: [[-71.0505, 42.3508], [-71.025, 42.3388], [-71.021, 42.3345], [-71.035, 42.3305], [-71.046, 42.3295], [-71.052, 42.3335], [-71.0545, 42.343]], angle: -8, along: 0.0011, across: 0.0016 },
      { area: [[-71.043, 42.364], [-71.039, 42.374], [-71.028, 42.381], [-71.017, 42.372], [-71.03, 42.362]], angle: 80, along: 0.0013, across: 0.0011 },
      { area: [[-71.066, 42.371], [-71.051, 42.3715], [-71.05, 42.3745], [-71.062, 42.38], [-71.072, 42.381]], angle: 50, along: 0.0011, across: 0.0013 },
    ],
    streets: [
      [[-71.0585, 42.36], [-71.061, 42.353], [-71.064, 42.349], [-71.068, 42.342], [-71.073, 42.335], [-71.079, 42.328], [-71.085, 42.32], [-71.09, 42.31]],
      [[-71.0598, 42.3586], [-71.063, 42.3556], [-71.065, 42.351], [-71.07, 42.345], [-71.079, 42.337], [-71.088, 42.331]],
      [[-71.062, 42.3583], [-71.0705, 42.3565]], [[-71.0705, 42.3565], [-71.0705, 42.361]], [[-71.0585, 42.3588], [-71.049, 42.36]],
      [[-71.0592, 42.3602], [-71.0545, 42.3648], [-71.0525, 42.3672]], [[-71.0565, 42.3637], [-71.0545, 42.3668]], [[-71.0565, 42.3605], [-71.0535, 42.3635], [-71.0505, 42.3655]],
      [[-71.056, 42.369], [-71.0515, 42.366], [-71.0505, 42.3625]], [[-71.06, 42.3605], [-71.0705, 42.3612]], [[-71.058, 42.357], [-71.0525, 42.3575]],
      [[-71.0605, 42.3545], [-71.056, 42.353]], [[-71.0575, 42.357], [-71.0555, 42.353]], [[-71.063, 42.3525], [-71.0697, 42.351]], [[-71.061, 42.3515], [-71.056, 42.35]],
      [[-71.06, 42.3605], [-71.062, 42.3655], [-71.064, 42.3665]], [[-71.06, 42.3465], [-71.064, 42.341]], [[-71.061, 42.351], [-71.065, 42.344]],
      [[-71.0625, 42.3695], [-71.068, 42.375], [-71.075, 42.384], [-71.08, 42.4]], [[-71.08, 42.3626], [-71.1, 42.366], [-71.1167, 42.3735], [-71.135, 42.38]],
      [[-71.057, 42.342], [-71.058, 42.33], [-71.06, 42.31]], [[-71.095, 42.3485], [-71.13, 42.343]], [[-71.088, 42.331], [-71.1, 42.33], [-71.12, 42.32]],
      [[-71.0705, 42.3612], [-71.073, 42.364]],
    ],
    bridges: [[[-71.0605, 42.3675], [-71.0625, 42.3695]], [[-71.0625, 42.3668], [-71.0645, 42.3692]], [[-71.0705, 42.3612], [-71.08, 42.3626]],
      [[-71.0755, 42.3556], [-71.085, 42.3512], [-71.095, 42.3485]], [[-71.065, 42.342], [-71.056, 42.3415]], [[-71.0555, 42.3527], [-71.051, 42.3512]],
      [[-71.067, 42.3655], [-71.0725, 42.367]]],
    wharves: [[[-71.0505, 42.3665], [-71.0482, 42.3668]], [[-71.05, 42.3632], [-71.0475, 42.3634]], [[-71.0495, 42.3616], [-71.047, 42.3617]], [[-71.0485, 42.3601], [-71.0455, 42.3602]],
      [[-71.0502, 42.3577], [-71.0477, 42.3576]], [[-71.05, 42.3558], [-71.0475, 42.3557]], [[-71.0508, 42.354], [-71.0487, 42.3537]], [[-71.0512, 42.3725], [-71.0492, 42.3712]],
      [[-71.0505, 42.374], [-71.0485, 42.373]], [[-71.0412, 42.367], [-71.0438, 42.3664]], [[-71.0398, 42.3715], [-71.0425, 42.371]]],
    rails: [[[-71.059, 42.3497], [-71.075, 42.3468], [-71.09, 42.3462], [-71.14, 42.35]], [[-71.068, 42.3505], [-71.08, 42.342], [-71.1, 42.32], [-71.11, 42.305]],
      [[-71.06, 42.366], [-71.068, 42.372], [-71.09, 42.385], [-71.12, 42.395]]],
    lakes: [[-71.118, 42.3165, 0.0035, 0.0025]],
    water: [['Boston Harbor', -71.032, 42.353, 30], ['Charles River', -71.105, 42.3575], ['The Back Bay (still water)', -71.086, 42.349, 20], ['South Bay', -71.0625, 42.3355, 18],
      ['Mystic River', -71.052, 42.386], ['Fort Point Channel', -71.0505, 42.3455, 16]],
  },
  { id: 'san-francisco', bounds: [-122.535, 37.7, -122.355, 37.815], width: 1800,
    land: [
      [[-122.5115, 37.695], [-122.5115, 37.735], [-122.5105, 37.765], [-122.5135, 37.78], [-122.505, 37.788], [-122.49, 37.79], [-122.4775, 37.81],
        [-122.465, 37.8065], [-122.448, 37.8045], [-122.432, 37.806], [-122.426, 37.809], [-122.42, 37.807], [-122.414, 37.8065], [-122.411, 37.808],
        [-122.405, 37.806], [-122.4025, 37.8035], [-122.4005, 37.801], [-122.3995, 37.797], [-122.3965, 37.7965], [-122.3945, 37.7935], [-122.392, 37.7905],
        [-122.389, 37.7868], [-122.391, 37.783], [-122.393, 37.78], [-122.396, 37.7785], [-122.4, 37.776], [-122.405, 37.7725], [-122.408, 37.77],
        [-122.412, 37.768], [-122.406, 37.766], [-122.4, 37.765], [-122.392, 37.764], [-122.385, 37.762], [-122.388, 37.755], [-122.387, 37.745],
        [-122.38, 37.738], [-122.37, 37.728], [-122.37, 37.725], [-122.378, 37.718], [-122.388, 37.71], [-122.39, 37.695]],
    ],
    cells: [
      { id: 'sf-barbary-coast', name: 'The Barbary Coast', at: [-122.4025, 37.7975] },
      { id: 'sf-chinatown', name: 'Chinatown and Portsmouth Square', at: [-122.4065, 37.7945] },
      { id: 'sf-montgomery', name: 'Montgomery Street and the made land', at: [-122.3985, 37.7925] },
      { id: 'sf-north-beach', name: 'Telegraph Hill and North Beach', at: [-122.408, 37.802] },
      { id: 'sf-russian-hill', name: 'Russian Hill', at: [-122.419, 37.8] },
      { id: 'sf-union-square', name: 'Union Square and the hills', at: [-122.412, 37.789] },
      { id: 'sf-rincon', name: 'Rincon Hill and South Park', at: [-122.393, 37.785] },
      { id: 'sf-south-of-market', name: 'South of Market (Happy Valley)', at: [-122.405, 37.7795] },
      { id: 'sf-mission', name: 'Mission Dolores', at: [-122.423, 37.759] },
      { id: 'sf-western-addition', name: 'The Western Addition', at: [-122.435, 37.785] },
      { id: 'sf-presidio', name: 'The Presidio and Fort Point', at: [-122.465, 37.798] },
      { id: 'sf-outside-lands', name: 'The Outside Lands (the sand hills)', at: [-122.48, 37.755] },
      { id: 'sf-potrero', name: 'Potrero and Hunters Point', at: [-122.393, 37.745] },
    ],
    links: [],
    places: [['Portsmouth Square', -122.4055, 37.7948], ['The Montgomery Block', -122.4025, 37.7955], ['The Mint', -122.4035, 37.794], ['Meiggs\' Wharf', -122.411, 37.8075],
      ['Pacific Mail dock (First and Brannan)', -122.3905, 37.7835], ['Mission Dolores', -122.4269, 37.7643], ['The Presidio', -122.4595, 37.7985], ['Fort Point', -122.4775, 37.8095],
      ['Woodward\'s Gardens', -122.42, 37.7675], ['Lone Mountain Cemetery', -122.452, 37.779], ['The Cliff House', -122.5137, 37.7784], ['Telegraph Hill signal station', -122.4058, 37.8025],
      ['Union Square', -122.4075, 37.788], ['Rincon Point', -122.389, 37.7865]],
    // Decoration (rule 11): north of Market the grid square to the compass,
    // south of it square to Market; the roads out, the wharves, the Long
    // Bridge, the railroad to San Jose, lakes and the names of the water.
    grids: [
      { area: [[-122.3995, 37.797], [-122.3945, 37.7952], [-122.4035, 37.788], [-122.413, 37.7805], [-122.4235, 37.7725], [-122.446, 37.7725], [-122.446, 37.808], [-122.405, 37.808]], angle: 0, along: 0.0012, across: 0.0015 },
      { area: [[-122.3945, 37.795], [-122.388, 37.788], [-122.397, 37.776], [-122.41, 37.768], [-122.4235, 37.7725], [-122.413, 37.7805], [-122.4035, 37.788]], angle: 44, along: 0.0015, across: 0.0022 },
      { area: [[-122.4235, 37.7725], [-122.433, 37.7655], [-122.433, 37.752], [-122.41, 37.752], [-122.41, 37.768]], angle: 0, along: 0.0013, across: 0.0016 },
    ],
    streets: [[[-122.3945, 37.795], [-122.4035, 37.788], [-122.413, 37.7805], [-122.4235, 37.7725], [-122.434, 37.7645]],
      [[-122.4185, 37.7745], [-122.4205, 37.76], [-122.42, 37.735], [-122.43, 37.7]], [[-122.4045, 37.7875], [-122.44, 37.7835], [-122.46, 37.781], [-122.49, 37.7795], [-122.5135, 37.778]],
      [[-122.42, 37.8], [-122.447, 37.799], [-122.4595, 37.7985], [-122.4775, 37.8085]], [[-122.392, 37.764], [-122.388, 37.74], [-122.378, 37.72]],
      [[-122.4269, 37.7643], [-122.445, 37.762], [-122.48, 37.74], [-122.5, 37.72]]],
    bridges: [[[-122.394, 37.7775], [-122.389, 37.7625]]],
    wharves: [[[-122.4, 37.7995], [-122.3955, 37.8008]], [[-122.3985, 37.7975], [-122.394, 37.799]], [[-122.3962, 37.7962], [-122.391, 37.7975]], [[-122.3945, 37.7942], [-122.3895, 37.796]],
      [[-122.3925, 37.7915], [-122.3875, 37.7932]], [[-122.3905, 37.7888], [-122.386, 37.79]], [[-122.3905, 37.7835], [-122.386, 37.7825]], [[-122.411, 37.808], [-122.4105, 37.8115]]],
    rails: [[[-122.403, 37.788], [-122.418, 37.766], [-122.42, 37.745], [-122.408, 37.7]]],
    lakes: [[-122.4935, 37.7225, 0.0055, 0.0105], [-122.433, 37.8015, 0.0028, 0.0012]],
    water: [['San Francisco Bay', -122.375, 37.795, 32], ['The Golden Gate', -122.492, 37.811], ['Pacific Ocean', -122.527, 37.74, 22], ['Mission Bay', -122.397, 37.7705, 18],
      ['Lake Merced', -122.4935, 37.709, 18]],
  },
];

// ---------- geometry in degrees ----------
function halfPlane(ring, a, b, k) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n = [(b[0] - a[0]) * k * k, b[1] - a[1]];
  const side = (p) => (p[0] - m[0]) * n[0] + (p[1] - m[1]) * n[1];
  const out = [];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  });
  return out.length >= 3 ? out : null;
}
// Each seed's cell, then the land inside it.
function cells(land, seeds) {
  const k = Math.cos((seeds[0].at[1] * Math.PI) / 180);
  const [w, s, e, n] = G.bbox(land);
  const box = [[w - 1, s - 1], [e + 1, s - 1], [e + 1, n + 1], [w - 1, n + 1]];
  return Object.fromEntries(seeds.map((seed) => {
    const cell = seeds.reduce((ring, o) => (ring && o !== seed ? halfPlane(ring, seed.at, o.at, k) : ring), box);
    return [seed.id, cell ? land.flatMap((r) => intersect(r, cell)).filter((r) => G.area(r) > 1e-8) : []];
  }));
}
const miles = (a, b) => {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * 69 * k, (a[1] - b[1]) * 69);
};
const days = (d) => `${Math.max(1, Math.round(d))}d`;
// The farthest two regions' outlines are apart, in miles. A route on a
// region serves everything inside it and arriving reaches everything inside
// (R-2), so a border between two big territories is timed for the longest
// way across both: it is the way to go only where no trail runs.
function farthest(a, b) {
  const pick = (rings) => rings.flatMap((r) => r.filter((p, i) => i % Math.max(1, Math.floor(r.length / 60)) === 0));
  const pa = pick(a), pb = pick(b);
  let best = 0;
  pa.forEach((p) => pb.forEach((q) => { const d = miles(p, q); if (d > best) best = d; }));
  return best;
}

// ---------- pictures ----------
const frame = (bounds, width) => {
  const [w, s, e, n] = bounds;
  const k = Math.cos(((s + n) / 2) * Math.PI / 180);
  const height = Math.round(width * ((n - s) / ((e - w) * k)));
  return { width, height, px: ([lon, lat]) => [((lon - w) / (e - w)) * width, ((n - lat) / (n - s)) * height] };
};
const pathOf = (rings, f) => rings.map((r) => 'M' + open(r).map((p) => f.px(p).map((v) => v.toFixed(1)).join(',')).join('L') + 'Z').join('');
const lineOf = (lines, f) => lines.map((l) => 'M' + l.map((p) => f.px(p).map((v) => v.toFixed(1)).join(',')).join('L')).join('');
const svg = (f, parts) => `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}">\n${parts.join('\n')}\n</svg>\n`;
const toPx = (f, rings, tol) => rings.map((r) => G.simplify(open(r).map((p) => f.px(p)), tol)).filter(Boolean)
  .map((r) => r.map((p) => [Math.round(Math.max(0, Math.min(f.width, p[0]))), Math.round(Math.max(0, Math.min(f.height, p[1])))]))
  .filter((r) => r.length >= 3 && G.area(r) >= 2);
const shapeOf = (rings) => (rings.length === 1 ? { polygon: rings[0] } : { polygons: rings });
// The parts of a line where test(point) holds (sampled; decoration only).
function sampled(line, test, step) {
  const out = [];
  let cur = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let j = i ? 1 : 0; j <= n; j++) {
      const p = [a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n];
      if (test(p)) cur.push(p);
      else { if (cur.length > 1) out.push(cur); cur = []; }
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
// A street grid over an area (a ring), clipped to the land: streets at
// "angle" degrees from east (in a true-scale frame) "along" degrees apart,
// and the cross streets "across" apart.
function gridLines(g, land) {
  const k = Math.cos((g.area[0][1] * Math.PI) / 180);
  const a = (g.angle * Math.PI) / 180;
  const u = [Math.cos(a), Math.sin(a)], v = [-Math.sin(a), Math.cos(a)];
  const ll = (q) => [q[0] / k, q[1]];
  const pts = g.area.map((p) => [p[0] * k, p[1]]);
  const proj = (q, d) => q[0] * d[0] + q[1] * d[1];
  const span = (d) => [Math.min(...pts.map((q) => proj(q, d))), Math.max(...pts.map((q) => proj(q, d)))];
  const [u0, u1] = span(u), [v0, v1] = span(v);
  const test = (p) => G.inside(p, g.area) && G.insideAny(p, land);
  const at = (s, t) => ll([u[0] * s + v[0] * t, u[1] * s + v[1] * t]);
  const lines = [];
  for (let t = v0 + g.along / 2; t < v1; t += g.along) lines.push(...sampled([at(u0, t), at(u1, t)], test, 0.0001));
  for (let s = u0 + g.across / 2; s < u1; s += g.across) lines.push(...sampled([at(s, v0), at(s, v1)], test, 0.0001));
  return lines;
}
const label = (f, [text, lon, lat, size]) => {
  const [x, y] = f.px([lon, lat]);
  return `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="${size || 24}" fill="#6f8fa0">${text}</text>`;
};
function cityPicture(c, f, file, districts) {
  const onLand = (p) => G.insideAny(p, c.land);
  const parts = [`<rect width="${f.width}" height="${f.height}" fill="#a9c3cf"/>`];
  parts.push(`<path d="${pathOf(c.land, f)}" fill="#e3dcc6" stroke="#9fb7c2" stroke-width="2"/>`);
  parts.push(`<path d="${pathOf(districts, f)}" fill="#efe9d8" stroke="#cbc1a5" stroke-width="1.5"/>`);
  (c.lakes || []).forEach(([lon, lat, rx, ry]) => {
    const [cx, cy] = f.px([lon, lat]);
    const [ex] = f.px([lon + rx, lat]);
    const [, ey] = f.px([lon, lat - ry]);
    parts.push(`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(ex - cx).toFixed(1)}" ry="${(ey - cy).toFixed(1)}" fill="#a9c3cf" stroke="#9fb7c2" stroke-width="2"/>`);
  });
  const grid = c.grids.flatMap((g) => gridLines(g, c.land));
  parts.push(`<path d="${lineOf(grid, f)}" fill="none" stroke="#d6c9a6" stroke-width="2.5" stroke-linecap="round"/>`);
  parts.push(`<path d="${lineOf(c.wharves, f)}" fill="none" stroke="#a08f6c" stroke-width="7" stroke-linecap="butt"/>`);
  parts.push(`<path d="${lineOf(c.streets.flatMap((l) => sampled(l, onLand, 0.0002)), f)}" fill="none" stroke="#b8a77f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`);
  parts.push(`<path d="${lineOf(c.bridges, f)}" fill="none" stroke="#9a8962" stroke-width="5" stroke-linecap="round"/>`);
  parts.push(`<path d="${lineOf(c.rails, f)}" fill="none" stroke="#6d6658" stroke-width="2.5" stroke-dasharray="10 5"/>`);
  (c.water || []).forEach((w) => parts.push(label(f, w)));
  fs.writeFileSync(path.join(WORLD, file), svg(f, parts));
}

// ---------- build ----------
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJSON(file, data) {
  const crlf = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('\r\n');
  const s = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s);
}

function build() {
  const need = [path.join(NE, SOURCES.countries.file), path.join(NE, SOURCES.states.file), path.join(NE, SOURCES.raster.tif)];
  need.forEach((f) => { if (!fs.existsSync(f)) throw new Error(`Missing ${path.relative(root, f)}: run "npm run basemap -- fetch --states".`); });
  const worldFile = path.join(WORLD, 'world.json');
  const world = fs.existsSync(worldFile) ? readJSON(worldFile) : { title: 'The Frontier, 1866', setting: 'America after the Civil War.' };
  const kept = new Map((world.regions || []).map((r) => [r.id, r]));
  const keptMaps = new Map((world.regions || []).filter((r) => r.map).map((r) => [r.id, r.map]));
  const regions = [];
  const OWN = ['id', 'name', 'parent', 'label', 'controller', 'neighbours', 'routes', 'key', 'map', 'notable'];
  const put = (r) => {
    const old = kept.get(r.id) || {};
    const def = Object.assign({}, r);
    Object.keys(old).filter((k) => !OWN.includes(k)).forEach((k) => { def[k] = old[k]; });
    regions.push(def);
    return def;
  };
  const keepRooms = (map, old) => { if (old && old.locations) map.locations = old.locations; return map; };

  console.log('Reading the base raster…');
  const src = readTiff(fs.readFileSync(path.join(NE, SOURCES.raster.tif)));
  const c = cut(src, AMERICA, 2800);
  writeJpeg(path.join(WORLD, 'maps/america.jpg'), c.rgba, c.width, c.height, 85);
  const america = keepRooms({ image: 'maps/america.jpg', width: c.width, height: c.height, projection: 'equirectangular', bounds: AMERICA, base: 'world', credit: CREDIT_NE, license: 'Public domain', regions: {} }, world.map);

  // The country, its sections and its states and territories.
  put({ id: 'united-states', name: 'The United States', label: 'country' });
  SECTIONS.forEach((s) => put(Object.assign({ id: s.id, name: s.name, parent: 'united-states', label: 'section' }, s.notable ? { notable: true } : {})));
  const states = readJSON(path.join(NE, SOURCES.states.file)).features.filter((f) => f.properties.adm0_a3 === 'USA');
  const byCode = new Map(states.map((f) => [f.properties.postal, f]));
  const lower48 = (r) => r.some(([x, y]) => x > AMERICA[0] && x < AMERICA[2] && y > AMERICA[1] && y < AMERICA[3]);
  const stateRings = {};
  const stateInfo = {};
  SECTIONS.forEach((s) => s.states.forEach((code) => {
    let id, name, label = TERRITORIES.has(code) ? 'territory' : 'state', rings;
    if (MERGED[code]) {
      const m = MERGED[code];
      id = m.id; name = m.name; label = m.label;
      const lists = m.codes.map((k) => ringsOf(byCode.get(k).geometry).filter(lower48));
      rings = union(lists);
      if (!rings.length) throw new Error(`${name}: the union failed`);
    } else if (code === 'IT' || code === 'STRIP') {
      const ok = ringsOf(byCode.get('OK').geometry);
      rings = ok.flatMap((r) => intersect(r, code === 'IT' ? NOT_PANHANDLE : PANHANDLE)).filter((r) => G.area(r) > 0.01);
      id = code === 'IT' ? 'indian-territory' : 'neutral-strip';
      name = code === 'IT' ? 'Indian Territory' : 'The Neutral Strip';
      label = code === 'IT' ? 'territory' : 'unorganized land';
    } else {
      const f = byCode.get(code);
      if (!f) throw new Error(`no state ${code}`);
      name = NAME_OF[code] || f.properties.name;
      id = G.slug(name.replace(/ Territory$/, '')) + (code === 'WA' ? '-territory' : '');
      rings = ringsOf(f.geometry).filter(lower48);
    }
    stateRings[id] = rings;
    stateInfo[id] = { id, name, label, section: s.id, code, territory: label === 'territory' };
  }));
  // Sections next door to each other.
const SECTION_ROUTES = [['northeast', 'midwest'], ['northeast', 'south'], ['midwest', 'south'], ['midwest', 'plains'], ['south', 'plains'], ['plains', 'mountain-west'],
  ['south', 'mountain-west'], ['mountain-west', 'pacific']];
// Countries next door.
  const ne = readJSON(path.join(NE, SOURCES.countries.file)).features;
  const near = (r) => r.some(([x, y]) => x > AMERICA[0] - 3 && x < AMERICA[2] + 3 && y > AMERICA[1] - 3 && y < AMERICA[3] + 3);
  ABROAD.forEach((a) => {
    const rings = ne.filter((f) => a.codes.includes(f.properties.ADM0_A3)).flatMap((f) => ringsOf(f.geometry)).filter(near);
    america.regions[a.id] = shapeOf(G.fitRings(america, rings, { tol: 1.2, minArea: 30 }));
    put({ id: a.id, name: a.name, label: 'country', routes: [] });
  });
  // Borders between states and territories: overland in the West at a
  // wagon's pace, by rail in the East, timed for the longest way across both.
  const nb = G.neighbours(stateRings, 0.02);
  const EASTERN = new Set(['northeast', 'midwest', 'south']);
  Object.values(stateInfo).forEach((s) => {
    const rings = G.fitRings(america, stateRings[s.id], { tol: 1, minArea: 4 });
    america.regions[s.id] = shapeOf(rings);
    const routes = nb.filter((p) => p.includes(s.id)).map((p) => (p[0] === s.id ? p[1] : p[0])).filter((to) => s.id < to).map((to) => {
      const d = farthest(stateRings[s.id], stateRings[to]);
      const east = EASTERN.has(s.section) && EASTERN.has(stateInfo[to].section);
      return east ? { to, kind: 'rail', time: `${Math.max(6, Math.round(d / 25))}h` } : { to, kind: 'overland', time: days(d / 15) };
    });
    const controller = s.id === 'indian-territory' ? 'five-tribes' : s.territory ? 'federal' : null;
    put({ id: s.id, name: s.name, parent: s.section, label: s.label, controller, routes, key: `US-${s.code}` });
  });
  // Between the sections too, so they are never free borders to each other
  // (R-2: siblings without routes are next door): by rail in the East, at a
  // wagon's pace in the West, timed for the longest way across both.
  const sectionRings = (s) => Object.values(stateInfo).filter((x) => x.section === s).flatMap((x) => stateRings[x.id]);
  SECTION_ROUTES.forEach(([a, b]) => {
    const r = regions.find((x) => x.id === a);
    const east = EASTERN.has(a) && EASTERN.has(b);
    const d = farthest(sectionRings(a), sectionRings(b));
    r.routes = (r.routes || []).concat(east ? { to: b, kind: 'rail', time: days(d / 600) } : { to: b, kind: 'overland', time: days(d / 15) });
  });
  // The lands of the Native nations, inside the territory that holds them.
  const landRings = {};
  LANDS.forEach((l) => {
    const parts = stateRings[l.in].flatMap((r) => intersect(r, l.ring)).filter((r) => G.area(r) > 0.01);
    if (!parts.length) throw new Error(`${l.name}: nothing inside ${l.in}`);
    landRings[l.id] = parts;
    america.regions[l.id] = shapeOf(G.fitRings(america, parts, { tol: 1, minArea: 4 }));
    put(Object.assign({ id: l.id, name: l.name, parent: l.in, label: 'homeland', controller: l.controller, routes: [] }, l.notable ? { notable: true } : {}));
  });
  // Places: in the land that holds them, else the state.
  const holder = (lon, lat) => Object.keys(landRings).find((id) => G.insideAny([lon, lat], landRings[id].map(open)))
    || Object.keys(stateRings).find((id) => G.insideAny([lon, lat], stateRings[id].map(open)));
  POINTS.forEach(([id, name, label, lon, lat, extra]) => {
    const x = extra || {};
    const parent = x.in || holder(lon, lat);
    if (!parent) throw new Error(`${name}: in no state`);
    america.regions[id] = { point: G.toPixel(america, [lon, lat]).map(Math.round) };
    put(Object.assign({ id, name, parent, label, routes: [] }, 'controller' in x ? { controller: x.controller } : {}, x.notable ? { notable: true } : {}));
  });
  // Routes, on the region they leave from (both ways).
  const byId = new Map(regions.map((r) => [r.id, r]));
  ROUTES.concat(ABROAD_ROUTES).forEach(([from, to, kind, time, extra]) => {
    const r = byId.get(from);
    if (!r || !byId.has(to)) throw new Error(`route ${from} → ${to}: no such region`);
    r.routes = r.routes || [];
    r.routes.push(Object.assign({ to, kind, time }, extra || {}));
  });
  regions.forEach((r) => { if (Array.isArray(r.routes) && !r.routes.length) delete r.routes; });

  // The cities' own maps.
  CITIES.forEach((cityDef) => {
    const f = frame(cityDef.bounds, cityDef.width);
    const map = keepRooms({ image: `maps/${cityDef.id}.svg`, width: f.width, height: f.height, credit: CREDIT_CITY, license: 'PolyForm Noncommercial 1.0.0, with the game (drawing); public domain (Coast Survey sources)', regions: {}, places: [] }, keptMaps.get(cityDef.id));
    const parts = cells(cityDef.land, cityDef.cells);
    const nbs = G.neighbours(parts, 0.0003);
    const extraLinks = cityDef.links;
    cityDef.cells.forEach((cell) => {
      if (!parts[cell.id].length) throw new Error(`${cityDef.id}: ${cell.name} has no ground (move its point)`);
      map.regions[cell.id] = shapeOf(toPx(f, parts[cell.id], 0.8));
      const routes = extraLinks.filter((l) => l[0] === cell.id).map(([, to, kind, time]) => ({ to, kind, time }));
      put(Object.assign({ id: cell.id, name: cell.name, parent: cityDef.id, label: cell.label || 'district', neighbours: nbs.filter((p) => p.includes(cell.id)).map((p) => (p[0] === cell.id ? p[1] : p[0])) },
        routes.length ? { routes } : {}, cell.notable ? { notable: true } : {}));
    });
    const cellOf = (lon, lat) => cityDef.cells.find((cell) => G.insideAny([lon, lat], parts[cell.id]));
    map.places = cityDef.places.map(([name, lon, lat]) => Object.assign({ id: `${cityDef.id}-${G.slug(name)}`, name, kind: 'place', at: f.px([lon, lat]).map(Math.round) }, cellOf(lon, lat) ? { region: cellOf(lon, lat).id } : {}));
    cityPicture(cityDef, f, map.image, Object.values(parts).flat());
    regions.find((r) => r.id === cityDef.id).map = map;
    console.log(`  ${regions.find((r) => r.id === cityDef.id).name}: ${cityDef.cells.length} districts, ${map.places.length} places`);
  });

  world.regions = regions;
  world.regionLabels = ['country', 'section', 'state', 'place', 'district'];
  world.routeKinds = Object.assign({}, ROUTE_KINDS, world.routeKinds || {});
  world.map = america;
  kept.forEach((r, id) => { if (!regions.some((x) => x.id === id)) { regions.push(r); console.log(`  kept ${id} (not built here)`); } });
  writeJSON(worldFile, world);
  console.log(`${regions.length} regions: ${Object.keys(stateInfo).length} states and territories, ${LANDS.length} nations' lands, ${POINTS.length} places.`);
}

export const _test = { cells, halfPlane, gridLines, CITIES, ROUTES };
const cmd = process.argv[2];
if (cmd === 'build') build();
else if (cmd) console.log('Usage: node tools/frontier.mjs build');
