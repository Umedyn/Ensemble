// The game page's modules (task A-3): a missed rename would only fail when
// that code runs, so names are checked here. js/ui/ stays under the limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'js', 'ui');
const files = fs.readdirSync(DIR);
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

// Identifiers in code: not in strings or comments, with what comes before.
function idents(text) {
  const out = [];
  let i = 0, prev = '';
  const quoted = (q) => { i++; while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; } i++; };
  const template = () => {
    i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '`') { i++; return; }
      if (text[i] === '$' && text[i + 1] === '{') { i += 2; code(true); continue; }
      i++;
    }
  };
  function code(inTemplate) {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 2; continue; }
      if (c === "'" || c === '"') { quoted(c); prev = 'str'; continue; }
      if (c === '`') { template(); prev = 'str'; continue; }
      if (c === '/' && /^[(,=:[!&|?{};+]$|^return$|^$/.test(prev)) {
        i++;
        let cls = false;
        while (i < text.length && (text[i] !== '/' || cls)) { if (text[i] === '\\') i++; else if (text[i] === '[') cls = true; else if (text[i] === ']') cls = false; i++; }
        i++;
        while (/[a-z]/.test(text[i] || '')) i++;
        prev = 'str';
        continue;
      }
      if (inTemplate && c === '{') depth++;
      if (inTemplate && c === '}') { if (!depth) { i++; return; } depth--; }
      if (/[A-Za-z_$]/.test(c)) {
        const st = i;
        while (/[\w$]/.test(text[i] || '')) i++;
        const w = text.slice(st, i);
        out.push({ w, prev, next: /^\s*(.)/.exec(text.slice(i, i + 30))?.[1] });
        prev = w === 'return' ? 'return' : 'id';
        continue;
      }
      if (/\s/.test(c)) { i++; continue; }
      if (text.startsWith('...', i)) { i += 3; prev = '...'; continue; } // a spread, not a property
      prev = c;
      i++;
    }
  }
  code(false);
  return out;
}
const sharedKeys = [...read('shared.js').matchAll(/^    (\w+|\$):/gm)].map((m) => m[1]);
const exportedBy = {};
files.forEach((f) => {
  const m = /Object\.assign\(U, \{ ([^}]*) \}\);/.exec(read(f));
  exportedBy[f] = m ? m[1].split(',').map((s) => s.trim()) : [];
});
const defined = new Set([...sharedKeys, ...Object.values(exportedBy).flat()]);
// A name the module declares for itself is its own, whatever others export.
const declares = (text, name) => new RegExp(`\\b(?:const|let|function) ${name.replace('$', '\\$')}\\b|[(,{] *${name}\\b[^\\n]*=>|\\b${name} =>`).test(text);

test('no file in js/ui is over about 1,000 lines', () => {
  files.forEach((f) => assert.ok(read(f).split('\n').length <= 1050, f));
});

test('every U.name a module uses is set somewhere', () => {
  for (const f of files) {
    if (f === 'header.js') continue;
    for (const m of read(f).matchAll(/\bU\.(\w+)/g)) assert.ok(defined.has(m[1]), `${f} uses U.${m[1]}, which nothing sets`);
  }
});

test('a name shared between modules is never used bare in another module', () => {
  const names = [...defined].filter((n) => !['$', 'esc', 'store'].includes(n));
  for (const f of files) {
    const text = read(f);
    for (const t of idents(text)) {
      if (!names.includes(t.w) || t.prev === '.' || exportedBy[f].includes(t.w)) continue;
      if (['{', ','].includes(t.prev) && t.next === ':') continue; // an object's key
      if (f === 'shared.js' || declares(text, t.w)) continue;
      assert.fail(`${f} uses ${t.w} bare; it lives on E.UI`);
    }
  }
});

test('the header needs no other UI module, so any page can load it', () => {
  assert.ok(!/\bE\.UI\b|\bU\./.test(read('header.js')));
  const load = (page) => fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
  ['index.html', 'creator.html'].forEach((p) => assert.ok(load(p).includes('js/ui/header.js'), p));
  assert.ok(!load('creator.html').includes('js/ui/shared.js'), 'the creator stays its own page');
});
