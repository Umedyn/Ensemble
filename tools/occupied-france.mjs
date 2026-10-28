// The map builder for scenarios/occupied-france (task 7-1). Build time only:
// nothing here runs in the game.
//
//   node tools/occupied-france.mjs fetch     the arrondissement outlines and rivers into .cache/france/
//   node tools/occupied-france.mjs build     the pictures in maps/, and the regions and maps in world.json
//
// Sources: Natural Earth (public domain; "Made with Natural Earth"): the base
// raster, 1:50m countries, 1:10m départements, 1:10m rivers, from
// .cache/basemap/ (run "npm run basemap -- fetch --states" first); the
// arrondissements of Paris, Lyon and Marseille from geo.api.gouv.fr (IGN
// Admin Express, Licence Ouverte 2.0 / Etalab), and the communes around
// them for the pictures.
//
// The France of spring 1942 from today's outlines: the Paris ring merged
// back into Seine (75, 92, 93, 94) and Seine-et-Oise (78, 91, 95), Corsica
// one département, names of the time (Basses-Pyrénées, Loire-Inférieure…);
// the thirteen départements the demarcation line cut split along it, so the
// line is a border between regions; zones over the départements, with the
// line's crossings as routes; Lyon's seven arrondissements of the time (its
// 8th and 9th are later) and Marseille's districts drawn on today's lines
// (it had none until 1946). Seine's outline is approximate: a few communes
// changed sides in 1968.
//
// Building again keeps every field it doesn't own (lore, tags, status,
// notable, startable, presence…) on regions with the same id, and the
// rest of world.json as it is.
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
const WORLD = path.join(root, 'scenarios', 'occupied-france');
const NE = path.join(root, '.cache', 'basemap');
const CACHE = path.join(root, '.cache', 'france');
const NEGEO = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const FETCH = {
  'arrondissements.geojson': 'https://geo.api.gouv.fr/communes?type=arrondissement-municipal&format=geojson&geometry=contour&fields=nom,code',
  'rivers-europe.geojson': `${NEGEO}/ne_10m_rivers_europe.geojson`,
  'rivers.geojson': `${NEGEO}/ne_10m_rivers_lake_centerlines.geojson`,
  'communes-13.geojson': 'https://geo.api.gouv.fr/departements/13/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-69.geojson': 'https://geo.api.gouv.fr/departements/69/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-75.geojson': 'https://geo.api.gouv.fr/departements/75/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-78.geojson': 'https://geo.api.gouv.fr/departements/78/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-91.geojson': 'https://geo.api.gouv.fr/departements/91/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-92.geojson': 'https://geo.api.gouv.fr/departements/92/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-93.geojson': 'https://geo.api.gouv.fr/departements/93/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-94.geojson': 'https://geo.api.gouv.fr/departements/94/communes?format=geojson&geometry=contour&fields=nom,code',
  'communes-95.geojson': 'https://geo.api.gouv.fr/departements/95/communes?format=geojson&geometry=contour&fields=nom,code',
};
const CREDIT_NE = 'Made with Natural Earth (naturalearthdata.com): 1:50m cross-blended hypsometric tints with shaded relief and water; borders adapted for 1942';
const CREDIT_CITY = 'Arrondissements and communes: IGN Admin Express via geo.api.gouv.fr (Licence Ouverte 2.0, Etalab), adapted; rivers outside the city: Natural Earth';

// ---------- the map's frames ----------
const EUROPE = [-11, 33.5, 17, 57.5];
const FRANCE = [-5.4, 41.2, 9.9, 51.3];

// ---------- countries (Natural Earth ADM0_A3 → regions of 1942) ----------
// One region per country; several codes make one (the Reich).
const COUNTRIES = [
  { id: 'france', name: 'France', codes: ['FRA'], controller: null, notable: true },
  { id: 'reich', name: 'Greater German Reich', codes: ['DEU', 'AUT', 'LUX', 'CZE', 'POL'], controller: 'germany' },
  { id: 'britain', name: 'Britain', codes: ['GBR'], controller: 'allies' },
  { id: 'belgium', name: 'Belgium', codes: ['BEL'], controller: 'germany' },
  { id: 'netherlands', name: 'The Netherlands', codes: ['NLD'], controller: 'germany' },
  { id: 'denmark', name: 'Denmark', codes: ['DNK'], controller: 'germany' },
  { id: 'channel-islands', name: 'The Channel Islands', codes: ['JEY', 'GGY'], controller: 'germany' },
  { id: 'ireland', name: 'Ireland', codes: ['IRL'], controller: null },
  { id: 'spain', name: 'Spain', codes: ['ESP'], controller: null },
  { id: 'portugal', name: 'Portugal', codes: ['PRT'], controller: null },
  { id: 'andorra', name: 'Andorra', codes: ['AND'], controller: null },
  { id: 'switzerland', name: 'Switzerland', codes: ['CHE', 'LIE'], controller: null },
  { id: 'italy', name: 'Italy', codes: ['ITA', 'SMR', 'VAT'], controller: 'italy' },
  { id: 'monaco', name: 'Monaco', codes: ['MCO'], controller: null },
  { id: 'sweden', name: 'Sweden', codes: ['SWE'], controller: null },
  { id: 'morocco', name: 'French Morocco', codes: ['MAR'], controller: 'vichy' },
  { id: 'algeria', name: 'French Algeria', codes: ['DZA'], controller: 'vichy' },
  { id: 'tunisia', name: 'Tunisia', codes: ['TUN'], controller: 'vichy' },
];
// Travel France has that a border doesn't say: the escape lines, the sea.
const FRANCE_ROUTES = [
  { to: 'spain', kind: 'mountain crossing', time: '2d', requires: { world: 'Spanish frontier', is: 'open' }, risky: true, skill: 'stealth', failHarm: true },
  { to: 'andorra', kind: 'mountain crossing', time: '2d', requires: { world: 'Spanish frontier', is: 'open' }, risky: true, skill: 'stealth', failHarm: true },
  { to: 'switzerland', kind: 'frontier', time: '6h', requires: { world: 'Swiss frontier', is: 'open' }, risky: true, skill: 'stealth', failHarm: true },
  { to: 'britain', kind: 'sea', time: '1d', requires: { world: 'Channel', is: 'open' }, risky: true, skill: 'stealth', failHarm: true },
  { to: 'algeria', kind: 'sea', time: '1d', requires: { world: 'Mediterranean crossings', is: 'running' } },
  { to: 'channel-islands', kind: 'sea', time: '6h', requires: { world: 'Channel', is: 'open' }, risky: true, skill: 'stealth' },
];
// Borders that are routes above, or not borders that matter.
// Switzerland and Spain are reached only by the risky crossings above (not
// round by Italy, the Reich, Andorra or Morocco).
const NOT_NEIGHBOURS = ['france|spain', 'france|switzerland', 'britain|france', 'channel-islands|france', 'andorra|france', 'italy|switzerland', 'reich|switzerland', 'morocco|spain'];

// ---------- départements ----------
const MERGE = { seine: ['75', '92', '93', '94'], 'seine-et-oise': ['78', '91', '95'], corse: ['2A', '2B'] };
const NAMES = { '04': 'Basses-Alpes', 22: 'Côtes-du-Nord', 44: 'Loire-Inférieure', 64: 'Basses-Pyrénées', 76: 'Seine-Inférieure', 68: 'Haut-Rhin', 77: 'Seine-et-Marne',
  seine: 'Seine', 'seine-et-oise': 'Seine-et-Oise', corse: 'Corse' };
// The zones of spring 1942 (Natural Earth codes; the rest is occupied).
const ZONE_OF = {
  annexed: ['57', '67', '68'],
  attached: ['59', '62'],
  free: ['09', '11', '31', '65', '32', '47', '82', '46', '81', '12', '34', '30', '48', '15', '19', '87', '23', '36', '63', '43', '42', '69', '38', '26', '07', '84', '13', '83', '06', '04', '05', '73', '74', '66', 'corse'],
};
const CUT = ['01', '39', '71', '03', '18', '41', '37', '86', '16', '24', '33', '40', '64'];
const ZONES = [
  { id: 'occupied', name: 'Occupied Zone', controller: null, notable: true,
    routes: [
      { to: 'free', kind: 'demarcation line', time: '2h', requires: { world: 'demarcation line', is: 'lifted' }, risky: true, skill: 'stealth', failHarm: true },
      { to: 'annexed', kind: 'checkpoint', time: '1h', requires: { world: 'Alsace-Moselle border', is: 'open' }, risky: true, skill: 'stealth', failHarm: true },
    ],
    neighbours: ['attached'] },
  { id: 'free', name: 'Free Zone', controller: null, notable: true },
  { id: 'attached', name: 'Nord and Pas-de-Calais (under Brussels)', controller: null },
  { id: 'annexed', name: 'Alsace and Moselle (annexed)', controller: null },
];
// The demarcation line, [lon, lat], from the Spanish frontier near Arnéguy
// to the Swiss one by the Rhône, through the towns it ran by (Orthez,
// Mont-de-Marsan, Langon, Castillon, Montpon, Confolens, Chauvigny, Loches,
// Montrichard and the Cher, Vierzon, Moulins, Digoin, Paray-le-Monial,
// Chalon-sur-Saône, south of Dole and Poligny, the Valserine). Its ends are
// outside France, so it cuts the country in two.
const LINE = [[-1.3, 42.7], [-1.28, 43.11], [-1.05, 43.33], [-0.78, 43.49], [-0.59, 43.66], [-0.4, 43.9], [-0.32, 44.03], [-0.26, 44.29], [-0.15, 44.55], [-0.04, 44.85],
  [0.16, 45.01], [0.4, 45.25], [0.55, 45.65], [0.72, 45.87], [0.67, 46.01], [0.66, 46.12], [0.68, 46.23], [0.87, 46.43], [0.85, 46.6], [0.81, 46.79], [0.7, 46.97],
  [1.0, 47.18], [0.99, 47.33], [1.18, 47.34], [1.38, 47.27], [1.55, 47.27], [2.07, 47.22], [2.45, 47.1], [2.7, 46.9], [3.0, 46.72], [3.33, 46.55], [3.68, 46.52],
  [3.98, 46.48], [4.12, 46.45], [4.24, 46.58], [4.47, 46.75], [4.85, 46.78], [5.25, 46.78], [5.55, 46.8], [5.75, 46.78], [5.91, 46.7], [5.95, 46.45], [5.9, 46.25],
  [5.83, 46.11], [5.97, 46.15], [6.3, 46.2]];
// The occupied side of the line: the line, then round by the north and west.
const OCCUPIED_SIDE = LINE.concat([[20, 46.2], [20, 60], [-20, 60], [-20, 42.7]]);
const FREE_SIDE = LINE.concat([[20, 46.2], [20, 30], [-20, 30], [-20, 42.7]]);

// ---------- cities ----------
// Regions with a point on France's map, in the département that holds them.
const CITY_POINTS = [
  { id: 'vichy', name: 'Vichy', at: [3.426, 46.127], label: 'city', tags: ['seat of government'], notable: true },
  { id: 'menton', name: 'Menton', at: [7.5, 43.775], label: 'town', controller: 'italy', tags: ['italian-held'] },
];
// Pins on France's map (each in the département whose outline holds it).
const FRANCE_PLACES = [
  ['Bordeaux', -0.58, 44.84], ['Lille', 3.06, 50.63], ['Toulouse', 1.44, 43.6], ['Nantes', -1.55, 47.22], ['Strasbourg', 7.75, 48.58], ['Nice', 7.27, 43.7],
  ['Toulon', 5.93, 43.12], ['Clermont-Ferrand', 3.08, 45.78], ['Limoges', 1.26, 45.83], ['Rouen', 1.1, 49.44], ['Le Havre', 0.11, 49.49], ['Brest', -4.49, 48.39],
  ['Lorient', -3.37, 47.75], ['Saint-Nazaire', -2.21, 47.27], ['Cherbourg', -1.62, 49.64], ['Caen', -0.37, 49.18], ['Rennes', -1.68, 48.11], ['Orléans', 1.91, 47.9],
  ['Tours', 0.69, 47.39], ['Dijon', 5.04, 47.32], ['Reims', 4.03, 49.26], ['Nancy', 6.18, 48.69], ['Metz', 6.18, 49.12], ['Grenoble', 5.72, 45.19],
  ['Saint-Étienne', 4.39, 45.44], ['Montpellier', 3.88, 43.61], ['Perpignan', 2.9, 42.7], ['Annecy', 6.13, 45.9], ['Besançon', 6.02, 47.24], ['Amiens', 2.3, 49.89],
  ['Calais', 1.86, 50.95], ['Dunkirk', 2.38, 51.03], ['Pau', -0.37, 43.3], ['Limoges', 1.26, 45.83], ['Bourges', 2.4, 47.08], ['Poitiers', 0.34, 46.58],
  ['Angoulême', 0.16, 45.65], ['Moulins', 3.33, 46.57], ['Chalon-sur-Saône', 4.85, 46.78], ['Avignon', 4.81, 43.95], ['Nîmes', 4.36, 43.84], ['Ajaccio', 8.74, 41.92],
  ['Bastia', 9.45, 42.7], ['Le Mans', 0.2, 48.0], ['Angers', -0.55, 47.47], ['Troyes', 4.07, 48.3], ['Mulhouse', 7.34, 47.75], ['Belfort', 6.86, 47.64],
  ['Vierzon', 2.07, 47.22], ['Bayonne', -1.47, 43.49], ['Annemasse', 6.24, 46.19], ['Chartres', 1.49, 48.45], ['Versailles', 2.13, 48.8],
];
const CAPITALS = { france: null, britain: ['London', -0.13, 51.51], spain: ['Madrid', -3.7, 40.42], reich: ['Berlin', 13.4, 52.52], italy: ['Rome', 12.5, 41.9], switzerland: ['Bern', 7.45, 46.95],
  belgium: ['Brussels', 4.35, 50.85], netherlands: ['Amsterdam', 4.9, 52.37], algeria: ['Algiers', 3.06, 36.75], morocco: ['Rabat', -6.84, 34.02], tunisia: ['Tunis', 10.18, 36.8], portugal: ['Lisbon', -9.14, 38.72] };

// The three city maps: arrondissement codes → regions of the time.
const CITIES = [
  { id: 'paris', name: 'Paris', in: 'seine', label: 'city', notable: true, mapOn: 'seine', communes: ['75', '92', '93', '94', '78', '91', '95'], code: (n) => `751${n.padStart(2, '0')}`, bounds: [2.14, 48.73, 2.62, 48.96], width: 1800,
    districts: [
      ['1', 'Louvre (1st)'], ['2', 'Bourse (2nd)'], ['3', 'Temple (3rd)'], ['4', 'Hôtel-de-Ville (4th)'], ['5', 'Panthéon (5th)'], ['6', 'Luxembourg (6th)'],
      ['7', 'Palais-Bourbon (7th)'], ['8', 'Élysée (8th)'], ['9', 'Opéra (9th)'], ['10', 'Entrepôt (10th)'], ['11', 'Popincourt (11th)'], ['12', 'Reuilly (12th)'],
      ['13', 'Gobelins (13th)'], ['14', 'Observatoire (14th)'], ['15', 'Vaugirard (15th)'], ['16', 'Passy (16th)'], ['17', 'Batignolles-Monceau (17th)'],
      ['18', 'Butte-Montmartre (18th)'], ['19', 'Buttes-Chaumont (19th)'], ['20', 'Ménilmontant (20th)'],
    ].map(([n, name]) => ({ id: `paris-${n}`, name, codes: [`751${n.padStart(2, '0')}`] })),
    // Arrondissement edges down the middle of the river.
    rivers: [{ name: 'Seine', a: ['1', '4', '8', '12', '16'], b: ['5', '6', '7', '13', '15'] }],
    ne: ['Seine', 'Marne'],
    places: [['Drancy', 2.445, 48.923, 'seine'], ['Saint-Denis', 2.357, 48.936, 'seine'], ['Boulogne-Billancourt', 2.24, 48.835, 'seine'], ['Mont-Valérien', 2.212, 48.871, 'seine'],
      ['Fresnes prison', 2.322, 48.757, 'seine'],
      ['Gare du Nord', 2.355, 48.881, 'paris-10'], ['Gare de l\'Est', 2.359, 48.877, 'paris-10'], ['Gare de Lyon', 2.373, 48.845, 'paris-12'], ['Gare Montparnasse', 2.32, 48.841, 'paris-15'],
      ['Gare Saint-Lazare', 2.325, 48.876, 'paris-8'], ['Hôtel Majestic', 2.294, 48.871, 'paris-16'], ['Avenue Foch', 2.282, 48.872, 'paris-16'],
      ['Rue Lauriston', 2.289, 48.869, 'paris-16'], ['Rue des Saussaies', 2.318, 48.871, 'paris-8'], ['Hôtel Lutetia', 2.327, 48.851, 'paris-6'],
      ['Préfecture de police', 2.347, 48.854, 'paris-4'], ['La Santé prison', 2.342, 48.834, 'paris-14'], ['Cherche-Midi prison', 2.326, 48.848, 'paris-6'],
      ['Place de la Bastille', 2.369, 48.853, 'paris-11'], ['Vélodrome d\'Hiver', 2.288, 48.854, 'paris-15'], ['Sorbonne', 2.343, 48.848, 'paris-5'],
      ['Montmartre', 2.343, 48.886, 'paris-18'], ['Belleville', 2.38, 48.872, 'paris-20']] },
  { id: 'lyon', name: 'Lyon', in: 'rhone', label: 'city', notable: true, mapOn: 'lyon', communes: ['69'], code: (n) => `6938${n}`, bounds: [4.765, 45.705, 4.905, 45.81], width: 1600,
    districts: [
      { n: '1', name: 'Terreaux and the Slopes (1st)', codes: ['69381'] }, { n: '2', name: 'Presqu\'île (2nd)', codes: ['69382'] },
      { n: '3', name: 'Part-Dieu and Villette (3rd)', codes: ['69383'] }, { n: '4', name: 'Croix-Rousse (4th)', codes: ['69384'] },
      { n: '5', name: 'Vieux Lyon and Fourvière (5th)', codes: ['69385', '69389'] }, { n: '6', name: 'Brotteaux (6th)', codes: ['69386'] },
      { n: '7', name: 'Guillotière and Gerland (7th)', codes: ['69387', '69388'] },
    ].map((d) => ({ id: `lyon-${d.n}`, name: d.name, codes: d.codes })),
    rivers: [{ name: 'Rhône', a: ['1', '2', '4'], b: ['3', '6', '7', '8'] }, { name: 'Saône', a: ['5', '9'], b: ['1', '2', '4'] }],
    ne: ['Rhône', 'Saône'],
    places: [['Place Bellecour', 4.832, 45.758, 'lyon-2'], ['Perrache station', 4.826, 45.749, 'lyon-2'], ['Hôtel Terminus', 4.828, 45.75, 'lyon-2'], ['Montluc prison', 4.865, 45.749, 'lyon-3'],
      ['Fourvière', 4.822, 45.762, 'lyon-5'], ['Saint-Jean', 4.827, 45.761, 'lyon-5'], ['Place des Terreaux', 4.834, 45.767, 'lyon-1'], ['Croix-Rousse plateau', 4.832, 45.776, 'lyon-4'],
      ['Brotteaux station', 4.853, 45.767, 'lyon-6'], ['Military health school', 4.844, 45.745, 'lyon-7'], ['Part-Dieu barracks', 4.858, 45.761, 'lyon-3'], ['Vaise', 4.805, 45.775, 'lyon-5']] },
  { id: 'marseille', name: 'Marseille', in: 'bouches-du-rhone', label: 'city', notable: true, mapOn: 'marseille', communes: ['13'], code: (n) => `132${n.padStart(2, '0')}`, bounds: [5.22, 43.16, 5.56, 43.4], width: 1600, sea: true,
    districts: [
      ['1', 'Canebière and Belsunce'], ['2', 'Le Panier and La Joliette'], ['3', 'Belle de Mai'], ['4', 'Les Chartreux'], ['5', 'La Plaine and Baille'],
      ['6', 'Préfecture and Notre-Dame-du-Mont'], ['7', 'Saint-Victor and Endoume'], ['8', 'Le Prado and the beaches'], ['9', 'Mazargues and the calanques'],
      ['10', 'La Capelette'], ['11', 'La Valentine'], ['12', 'Saint-Barnabé'], ['13', 'Château-Gombert'], ['14', 'Saint-Just'], ['15', 'Saint-Louis and the northern docks'],
      ['16', 'L\'Estaque'],
    ].map(([n, name]) => ({ id: `marseille-${n}`, name, codes: [`132${n.padStart(2, '0')}`] })),
    rivers: [], ne: [],
    places: [['Vieux-Port', 5.374, 43.295, 'marseille-1'], ['Saint-Charles station', 5.381, 43.303, 'marseille-1'], ['Notre-Dame de la Garde', 5.371, 43.284, 'marseille-6'],
      ['Fort Saint-Jean', 5.362, 43.296, 'marseille-2'], ['Hôtel de Ville', 5.37, 43.297, 'marseille-2'], ['Rue Paradis', 5.38, 43.284, 'marseille-6'],
      ['La Joliette docks', 5.363, 43.307, 'marseille-2'], ['Les Baumettes prison', 5.414, 43.226, 'marseille-9'], ['L\'Estaque harbour', 5.317, 43.362, 'marseille-16'],
      ['Château d\'If', 5.325, 43.28, 'marseille-7']] },
];

// ---------- geometry in degrees ----------
const areaDeg = (rings) => rings.reduce((t, r) => t + G.area(r), 0);

// ---------- pictures ----------
const lonlatFrame = (bounds, width) => {
  // A city map is a plain picture (no projection): x scaled by the latitude,
  // so streets keep their shape.
  const [w, s, e, n] = bounds;
  const k = Math.cos(((s + n) / 2) * Math.PI / 180);
  const height = Math.round(width * ((n - s) / ((e - w) * k)));
  return { width, height, px: ([lon, lat]) => [((lon - w) / (e - w)) * width, ((n - lat) / (n - s)) * height] };
};
const pathOf = (rings, f) => rings.map((r) => 'M' + r.map((p) => f.px(p).map((v) => v.toFixed(1)).join(',')).join('L') + 'Z').join('');
// Simplified in pixels first (tol px), for outlines drawn only as decoration.
const pathSimple = (rings, f, tol) => rings.map((r) => G.simplify(r.map((p) => f.px(p)), tol)).filter(Boolean)
  .map((r) => 'M' + r.map((p) => p.map((v) => v.toFixed(1)).join(',')).join('L') + 'Z').join('');
const lineOf = (lines, f) => lines.map((l) => 'M' + l.map((p) => f.px(p).map((v) => v.toFixed(1)).join(',')).join('L')).join('');
function svg(f, parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}">\n${parts.join('\n')}\n</svg>\n`;
}
// River centre lines inside a city: the edges two banks' arrondissements share.
function sharedEdges(ringsA, ringsB) {
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const inB = new Set();
  ringsB.forEach((r) => open(r).forEach((a, i, rr) => { const b = rr[(i + 1) % rr.length]; inB.add(`${key(a)}|${key(b)}`); inB.add(`${key(b)}|${key(a)}`); }));
  const segs = [];
  ringsA.forEach((r) => open(r).forEach((a, i, rr) => { const b = rr[(i + 1) % rr.length]; if (inB.has(`${key(a)}|${key(b)}`)) segs.push([a, b]); }));
  // Chain the segments into lines.
  const lines = [];
  const left = segs.slice();
  while (left.length) {
    const line = left.shift().slice();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const [a, b] = left[i];
        const end = line[line.length - 1], start = line[0];
        if (key(a) === key(end)) { line.push(b); left.splice(i, 1); grew = true; break; }
        if (key(b) === key(end)) { line.push(a); left.splice(i, 1); grew = true; break; }
        if (key(b) === key(start)) { line.unshift(a); left.splice(i, 1); grew = true; break; }
        if (key(a) === key(start)) { line.unshift(b); left.splice(i, 1); grew = true; break; }
      }
    }
    lines.push(line);
  }
  return lines;
}
const linesOf = (geom) => (!geom ? [] : geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : []);

// ---------- build ----------
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, data) {
  const crlf = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\r\n');
  const s = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
}
const round = (rings, map, o) => G.fitRings(map, rings, o);
const shapeOf = (rings) => (rings.length === 1 ? { polygon: rings[0] } : { polygons: rings });

function build() {
  const need = [path.join(NE, SOURCES.countries.file), path.join(NE, SOURCES.states.file), path.join(NE, SOURCES.raster.tif)].concat(Object.keys(FETCH).map((f) => path.join(CACHE, f)));
  need.forEach((f) => { if (!fs.existsSync(f)) throw new Error(`Missing ${path.relative(root, f)}: run "npm run basemap -- fetch --states" and "node tools/occupied-france.mjs fetch".`); });
  const worldFile = path.join(WORLD, 'world.json');
  const world = fs.existsSync(worldFile) ? readJSON(worldFile) : { title: 'Occupied France', setting: 'France under the German occupation.' };
  const kept = new Map((world.regions || []).map((r) => [r.id, r]));
  const regions = [];
  const OWN = ['id', 'name', 'parent', 'label', 'controller', 'neighbours', 'routes', 'key', 'map', 'notable'];
  // A region: the builder's fields, then whatever the author added.
  const put = (r) => {
    const old = kept.get(r.id) || {};
    const def = Object.assign({}, r);
    Object.keys(old).filter((k) => !OWN.includes(k)).forEach((k) => { def[k] = old[k]; });
    if (old.routes && !r.routes) def.routes = old.routes;
    regions.push(def);
    return def;
  };

  // The pictures.
  console.log('Reading the base raster…');
  const src = readTiff(fs.readFileSync(path.join(NE, SOURCES.raster.tif)));
  const pic = (bounds, width, file) => {
    const c = cut(src, bounds, width);
    writeJpeg(path.join(WORLD, file), c.rgba, c.width, c.height, 85);
    return { image: file, width: c.width, height: c.height, projection: 'equirectangular', bounds, base: 'world', credit: CREDIT_NE, license: 'Public domain', regions: {} };
  };
  const europe = pic(EUROPE, 2400, 'maps/europe.jpg');
  const france = pic(FRANCE, 2400, 'maps/france.jpg');

  // Countries.
  const ne = readJSON(path.join(NE, SOURCES.countries.file)).features;
  const countryRings = {};
  COUNTRIES.forEach((c) => {
    const feats = ne.filter((f) => c.codes.includes(f.properties.ADM0_A3));
    if (!feats.length) throw new Error(`no country ${c.codes}`);
    // Only the pieces near the map (France's overseas lands aren't France here).
    const near = (r) => r.some(([x, y]) => x > EUROPE[0] - 5 && x < EUROPE[2] + 5 && y > EUROPE[1] - 5 && y < EUROPE[3] + 5);
    const lists = feats.map((f) => ringsOf(f.geometry).filter(near));
    const u = feats.length > 1 ? union(lists) : lists[0];
    countryRings[c.id] = u.length ? u : lists.flat();
  });
  const countryNb = G.neighbours(countryRings, 0.02).filter(([a, b]) => !NOT_NEIGHBOURS.includes(`${a}|${b}`));
  COUNTRIES.forEach((c) => {
    const rings = round(countryRings[c.id], europe, { tol: 1, minArea: 4 });
    const big = countryRings[c.id].slice().sort((a, b) => G.area(b) - G.area(a))[0];
    europe.regions[c.id] = rings.length ? shapeOf(rings) : { point: G.toPixel(europe, G.centroid(big)).map(Math.round) };
    const nb = countryNb.filter((p) => p.includes(c.id)).map((p) => (p[0] === c.id ? p[1] : p[0]));
    put(Object.assign({ id: c.id, name: c.name, label: 'country', controller: c.controller, neighbours: nb }, c.id === 'france' ? { routes: FRANCE_ROUTES } : {}, c.notable ? { notable: true } : {}));
  });
  europe.places = Object.entries(CAPITALS).filter(([, v]) => v).map(([region, [name, lon, lat]]) => ({ id: G.slug(name), name, kind: 'capital', at: G.toPixel(europe, [lon, lat]).map(Math.round), region, notable: true }));

  // Zones.
  ZONES.forEach((z) => put(Object.assign({ id: z.id, name: z.name, parent: 'france', label: 'zone', controller: z.controller }, z.routes ? { routes: z.routes } : {}, z.neighbours ? { neighbours: z.neighbours } : {}, z.notable ? { notable: true } : {})));

  // Départements.
  const states = readJSON(path.join(NE, SOURCES.states.file)).features.filter((f) => f.properties.adm0_a3 === 'FRA' && f.properties.type_en === 'Metropolitan department');
  const byCode = new Map(states.map((f) => [f.properties.iso_3166_2.slice(3), f]));
  const merged = new Set(Object.values(MERGE).flat());
  const depts = [];
  states.forEach((f) => {
    const code = f.properties.iso_3166_2.slice(3);
    if (merged.has(code)) return;
    depts.push({ code, name: NAMES[code] || f.properties.name, rings: ringsOf(f.geometry) });
  });
  Object.entries(MERGE).forEach(([code, codes]) => {
    const lists = codes.map((c) => ringsOf(byCode.get(c).geometry));
    const u = union(lists);
    depts.push({ code, name: NAMES[code], rings: u.length ? u : lists.flat(), id: code });
    if (!u.length) console.warn(`  ${code}: the union failed; kept as pieces`);
  });
  const zoneOf = (code) => Object.keys(ZONE_OF).find((z) => ZONE_OF[z].includes(code)) || 'occupied';
  const deptRegions = [];
  depts.forEach((d) => {
    const id = d.id || G.slug(d.name);
    if (!CUT.includes(d.code)) return deptRegions.push({ id, name: d.name, zone: zoneOf(d.code), rings: d.rings, code: d.code });
    // Split along the line; slivers where the line runs along a border are dropped.
    const sides = { occupied: OCCUPIED_SIDE, free: FREE_SIDE };
    const total = areaDeg(d.rings);
    Object.entries(sides).forEach(([zone, side]) => {
      const parts = d.rings.flatMap((r) => intersect(r, side)).filter((r) => G.area(r) > total * 0.02);
      if (!parts.length) return console.warn(`  ${d.name}: nothing on the ${zone} side`);
      deptRegions.push({ id: `${id}-${zone}`, name: `${d.name} (${zone === 'free' ? 'free zone' : 'occupied'})`, zone, rings: parts, code: d.code, cut: true });
    });
  });
  deptRegions.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const deptLonLat = Object.fromEntries(deptRegions.map((d) => [d.id, d.rings]));
  const zoneById = Object.fromEntries(deptRegions.map((d) => [d.id, d.zone]));
  // Borders across zones are the zones' routes, not free borders, except
  // between the occupied zone and the Nord.
  const together = (a, b) => a === b || [a, b].sort().join('|') === 'attached|occupied';
  const deptNb = G.neighbours(deptLonLat, 0.01).filter(([a, b]) => together(zoneById[a], zoneById[b]));
  const controllerOf = { occupied: 'germany', free: 'vichy', attached: 'germany', annexed: 'germany' };
  deptRegions.forEach((d) => {
    const rings = round(d.rings, france, { tol: 0.8, minArea: 3 });
    france.regions[d.id] = shapeOf(rings);
    const nb = deptNb.filter((p) => p.includes(d.id)).map((p) => (p[0] === d.id ? p[1] : p[0]));
    put({ id: d.id, name: d.name, parent: d.zone, label: 'département', controller: controllerOf[d.zone], neighbours: nb, key: `FR-${d.code}` });
  });
  // Corsica is an island: by sea from Marseille and Nice.
  const corse = regions.find((r) => r.id === 'corse');
  corse.routes = [{ to: 'bouches-du-rhone', kind: 'sea', time: '12h' }, { to: 'alpes-maritimes', kind: 'sea', time: '10h' }];
  // The département whose outline holds a point; on the coast, the nearest.
  const dist = (d, lon, lat) => Math.min(...d.rings.flatMap((r) => r.map((p) => Math.hypot(p[0] - lon, p[1] - lat))));
  const holder = (lon, lat) => deptRegions.find((d) => G.insideAny([lon, lat], d.rings.map(open)))
    || deptRegions.slice().sort((a, b) => dist(a, lon, lat) - dist(b, lon, lat))[0];

  // Cities with a point, and pins.
  CITY_POINTS.forEach((c) => {
    const d = holder(...c.at);
    france.regions[c.id] = { point: G.toPixel(france, c.at).map(Math.round) };
    put(Object.assign({ id: c.id, name: c.name, parent: d.id, label: c.label, controller: c.controller || controllerOf[d.zone] }, c.tags && !kept.has(c.id) ? { tags: c.tags } : {}, c.notable ? { notable: true } : {}));
  });
  const seenPlace = new Set();
  france.places = FRANCE_PLACES.filter(([name]) => !seenPlace.has(name) && seenPlace.add(name)).map(([name, lon, lat]) => {
    const d = holder(lon, lat);
    if (!d) console.warn(`  ${name}: in no département`);
    return Object.assign({ id: G.slug(name), name, kind: 'city', at: G.toPixel(france, [lon, lat]).map(Math.round) }, d ? { region: d.id } : {});
  });

  // The three cities: their arrondissements, a picture, pins.
  const arr = readJSON(path.join(CACHE, 'arrondissements.geojson')).features;
  const ringsByCode = Object.fromEntries(arr.map((f) => [f.properties.code, ringsOf(f.geometry)]));
  const riversNE = readJSON(path.join(CACHE, 'rivers-europe.geojson')).features.concat(readJSON(path.join(CACHE, 'rivers.geojson')).features);
  const cityMaps = {};
  CITIES.forEach((c) => {
    const f = lonlatFrame(c.bounds, c.width);
    const all = c.districts.flatMap((d) => d.codes.map((k) => ringsByCode[k]));
    if (all.some((x) => !x)) throw new Error(`${c.name}: an arrondissement is missing`);
    const outline = union(all);
    const toPx = (rings, tol) => rings.map((r) => G.simplify(open(r).map((p) => f.px(p)), tol)).filter(Boolean).map((r) => r.map((p) => [Math.round(p[0]), Math.round(p[1])]));
    const map = { image: `maps/${c.id}.svg`, width: f.width, height: f.height, credit: CREDIT_CITY, license: 'Licence Ouverte 2.0 (arrondissements); public domain (Natural Earth)', regions: {}, places: [] };
    // The city's own outline: on France's map (Lyon, Marseille) or Seine's (Paris).
    const d = holder(...G.centroid(outline.slice().sort((a, b) => G.area(b) - G.area(a))[0]));
    if (c.mapOn === 'seine') map.regions[c.id] = shapeOf(toPx(outline, 0.8));
    else france.regions[c.id] = shapeOf(round(outline, france, { tol: 0.5, minArea: 1 }));
    put({ id: c.id, name: c.name, parent: c.in, label: 'city', controller: controllerOf[d.zone], notable: true });
    const dLonLat = {};
    c.districts.forEach((x) => {
      const u = x.codes.length > 1 ? union(x.codes.map((k) => ringsByCode[k])) : ringsByCode[x.codes[0]];
      dLonLat[x.id] = u;
      map.regions[x.id] = shapeOf(toPx(u, 0.8));
    });
    const nb = G.neighbours(dLonLat, 0.00005);
    c.districts.forEach((x) => put({ id: x.id, name: x.name, parent: c.id, label: c.id === 'marseille' ? 'district' : 'arrondissement', controller: controllerOf[d.zone],
      neighbours: nb.filter((p) => p.includes(x.id)).map((p) => (p[0] === x.id ? p[1] : p[0])) }));
    map.places = c.places.map(([name, lon, lat, region]) => ({ id: `${c.id}-${G.slug(name)}`, name, kind: 'place', at: f.px([lon, lat]).map(Math.round), region }));
    // The picture: the sea, the communes around (land, faint borders), the
    // city, its rivers. Decoration only (rule 11).
    const box = c.bounds;
    const pad = [box[0] - 0.02, box[1] - 0.02, box[2] + 0.02, box[3] + 0.02];
    const parts = [`<rect width="${f.width}" height="${f.height}" fill="${c.sea ? '#a9c3cf' : '#ddd5bf'}"/>`];
    const communes = c.communes.flatMap((dep) => readJSON(path.join(CACHE, `communes-${dep}.geojson`)).features)
      .flatMap((x) => ringsOf(x.geometry)).map((r) => G.clip(open(r), pad)).filter(Boolean);
    parts.push(`<path d="${pathSimple(communes, f, 0.7)}" fill="#e3dcc6" stroke="#cbc1a5" stroke-width="1"/>`);
    parts.push(`<path d="${pathOf(outline.map(open), f)}" fill="#efe9d8" stroke="#a89c7c" stroke-width="2.5"/>`);
    const wide = Math.max(4, Math.round(c.width / 260));
    const river = (ls, w) => parts.push(`<path d="${lineOf(ls, f)}" fill="none" stroke="#7fa6bb" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`);
    // Natural Earth's rivers only outside the city: inside, the banks' own edges.
    const inCity = (p) => outline.some((r) => G.inside(p, open(r)));
    riversNE.filter((x) => c.ne.includes(x.properties.name)).forEach((x) => {
      const ls = [];
      linesOf(x.geometry).forEach((l) => {
        let cur = [];
        l.forEach((p) => { if (inCity(p) || p[0] < pad[0] || p[0] > pad[2] || p[1] < pad[1] || p[1] > pad[3]) { if (cur.length > 1) ls.push(cur); cur = []; } else cur.push(p); });
        if (cur.length > 1) ls.push(cur);
      });
      if (ls.length) river(ls, wide);
    });
    c.rivers.forEach((rv) => {
      const A = rv.a.flatMap((n) => ringsByCode[c.code(n)]);
      const B = rv.b.flatMap((n) => ringsByCode[c.code(n)]);
      const ls = sharedEdges(A, B);
      if (ls.length) river(ls, wide + 2);
      else console.warn(`  ${c.name}: no ${rv.name} found between the banks`);
    });
    fs.writeFileSync(path.join(WORLD, map.image), svg(f, parts));
    cityMaps[c.mapOn] = map;
    console.log(`  ${c.name}: ${c.districts.length} districts, ${map.places.length} places`);
  });
  // Seine's map: Paris, its arrondissements and the suburbs' pins.
  regions.forEach((r) => {
    if (cityMaps[r.id]) r.map = cityMaps[r.id];
  });
  // Cities' pins outside them (the suburbs) are on Seine's map but in Seine.
  world.regions = regions;
  world.regionLabels = ['country', 'zone', 'département', 'city', 'district'];
  world.map = europe;
  regions.find((r) => r.id === 'france').map = france;
  // Regions earlier builds made that this one didn't: the author's own, kept.
  kept.forEach((r, id) => { if (!regions.some((x) => x.id === id)) { regions.push(r); console.log(`  kept ${id} (not built here)`); } });
  writeJSON(worldFile, world);
  console.log(`${regions.length} regions: ${COUNTRIES.length} countries, ${ZONES.length} zones, ${deptRegions.length} départements and parts, ${CITY_POINTS.length + CITIES.length} cities.`);
}

async function fetchAll() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const [file, url] of Object.entries(FETCH)) {
    console.log(`Fetching ${file}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(CACHE, file), Buffer.from(await res.arrayBuffer()));
  }
}

export const _test = { intersect, union, OCCUPIED_SIDE, FREE_SIDE, ringsOf, G };
const cmd = process.argv[2];
if (cmd === 'fetch') await fetchAll();
else if (cmd === 'build') build();
else console.log('Usage: node tools/occupied-france.mjs fetch | build');
