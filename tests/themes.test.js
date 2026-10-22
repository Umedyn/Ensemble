// Theme contrast (task 1-9): reads each theme's colour variables from
// css/style.css and checks every text/background pair the page uses.
// Targets: WCAG AA 4.5:1 for text in every theme; high visibility needs AAA
// 7:1 for body text. Focus rings and (in high visibility) borders need 3:1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

function block(selector) {
  const i = css.indexOf(selector + ' {');
  assert.ok(i >= 0, `${selector} is defined`);
  const body = css.slice(i, css.indexOf('}', i));
  const vars = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) vars[m[1]] = m[2];
  return vars;
}
const dark = block(':root');
const themes = {
  dark,
  light: Object.assign({}, dark, block(':root[data-theme="light"]')),
  hv: Object.assign({}, dark, block(':root[data-theme="hv"]')),
};

function hex(h) {
  h = h.replace('#', '');
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const SURFACES = ['bg', 'panel', 'panel-2'];
// [foreground, backgrounds, minimum (normal themes), minimum (high visibility)]
const PAIRS = [
  ['text', [...SURFACES, 'tag-bg'], 4.5, 7],
  ['muted', SURFACES, 4.5, 4.5],
  ['accent', SURFACES, 4.5, 4.5],
  ['good', SURFACES, 4.5, 4.5],
  ['bad', SURFACES, 4.5, 4.5],
  ['hidden', SURFACES, 4.5, 4.5],
  ['on-accent', ['accent'], 4.5, 7],
  ['focus', SURFACES, 3, 3],
  // Faction colours on the world map (task 3-4): shapes, so 3:1 against the page.
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`f${n}`, ['bg'], 3, 3]),
  // The detailed local map (task 3-7): room labels on the floor, walls and
  // outlines as shapes (3:1).
  ['muted', ['map-floor', 'map-ground'], 4.5, 4.5],
  ['map-wall', ['bg', 'panel', 'map-floor'], 3, 3],
  ['map-furn-line', ['map-furn', 'map-floor'], 3, 3],
  ['accent', ['map-floor', 'map-furn'], 3, 3],
  ['text', ['map-floor'], 3, 3],
  ['bad', ['map-floor'], 3, 3],
  ['map-ground-dot', ['map-ground'], 3, 3],
];

for (const [name, vars] of Object.entries(themes)) {
  test(`theme "${name}" meets its contrast targets`, () => {
    const fails = [];
    for (const [fg, bgs, min, minHv] of PAIRS) {
      const need = name === 'hv' ? minHv : min;
      for (const bg of bgs) {
        assert.ok(vars[fg] && vars[bg], `--${fg} and --${bg} are set`);
        const r = ratio(vars[fg], vars[bg]);
        if (r < need) fails.push(`--${fg} on --${bg}: ${r.toFixed(2)}:1 (needs ${need}:1)`);
      }
    }
    if (name === 'hv') {
      for (const bg of SURFACES) if (ratio(vars.line, vars[bg]) < 3) fails.push(`--line on --${bg} is too faint for borders`);
    }
    assert.deepEqual(fails, []);
  });
}

test('every theme sets every colour the dark theme defines', () => {
  const colours = Object.keys(dark);
  for (const sel of [':root[data-theme="light"]', ':root[data-theme="hv"]']) {
    const own = block(sel);
    assert.deepEqual(colours.filter((k) => !(k in own) && !['shadow', 'backdrop'].includes(k)), [], sel);
  }
});

test('the creator stylesheet uses theme colours only (task 3-5)', () => {
  const creator = fs.readFileSync(path.join(__dirname, '..', 'css', 'creator.css'), 'utf8');
  assert.deepEqual(creator.match(/#[0-9a-fA-F]{3,8}/g) || [], []);
});

test('no hard-coded colours outside the theme blocks', () => {
  const rules = css.replace(/:root(\[data-theme="\w+"\])? \{[^}]*\}/g, '').replace(/repeating-linear-gradient\([^)]*\)/g, '');
  assert.deepEqual(rules.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
});
