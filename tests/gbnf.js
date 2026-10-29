// A small GBNF reader and matcher for the tests (task L-1), no dependency.
// It reads the subset js/jsonshape.js writes (one rule per line; literals,
// character classes, groups, alternatives, rule names and ? * +) and says
// whether a whole text matches the root rule, the way KoboldCpp's grammar
// sampler would allow it.

function parse(grammar) {
  const rules = new Map();
  for (const line of String(grammar).split('\n')) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9_-]+)\s*::=\s*(.*)$/.exec(line);
    if (!m) throw new Error(`Not a rule: ${line}`);
    if (rules.has(m[1])) throw new Error(`Rule written twice: ${m[1]}`);
    rules.set(m[1], parseBody(m[2], m[1]));
  }
  for (const [name, body] of rules) checkRefs(body, rules, name);
  if (!rules.has('root')) throw new Error('No root rule');
  return rules;
}

function parseBody(src, name) {
  let i = 0;
  const fail = (msg) => { throw new Error(`${name}: ${msg} at ${i} in ${src}`); };
  const ws = () => { while (i < src.length && src[i] === ' ') i++; };
  const esc = () => {
    const c = src[i++];
    if (c === 'x') { const h = src.slice(i, i + 2); i += 2; return String.fromCodePoint(parseInt(h, 16)); }
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '\\' || c === '"' || c === ']' || c === '[' || c === '-' || c === '^') return c;
    return fail(`unknown escape \\${c}`);
  };
  function alt() {
    const seqs = [seq()];
    while (src[i] === '|') { i++; seqs.push(seq()); }
    return { t: 'alt', seqs };
  }
  function seq() {
    const items = [];
    ws();
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      let item;
      if (src[i] === '"') {
        i++;
        let s = '';
        while (src[i] !== '"') { if (i >= src.length) fail('open string'); s += src[i] === '\\' ? (i++, esc()) : src[i++]; }
        i++;
        item = { t: 'lit', cps: Array.from(s) };
      } else if (src[i] === '[') {
        i++;
        const neg = src[i] === '^';
        if (neg) i++;
        const ranges = [];
        while (src[i] !== ']') {
          if (i >= src.length) fail('open class');
          const a = src[i] === '\\' ? (i++, esc()) : src[i++];
          let b = a;
          if (src[i] === '-' && src[i + 1] !== ']') { i++; b = src[i] === '\\' ? (i++, esc()) : src[i++]; }
          ranges.push([a.codePointAt(0), b.codePointAt(0)]);
        }
        i++;
        item = { t: 'cls', neg, ranges };
      } else if (src[i] === '(') {
        i++;
        item = alt();
        if (src[i] !== ')') fail('missing )');
        i++;
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
        if (!m) fail(`unexpected "${src[i]}"`);
        i += m[0].length;
        item = { t: 'ref', name: m[0] };
      }
      if ('?*+'.includes(src[i]) && src[i]) item = { t: 'rep', op: src[i++], item };
      items.push(item);
      ws();
    }
    return { t: 'seq', items };
  }
  const out = alt();
  if (i < src.length) fail('trailing text');
  return out;
}

function checkRefs(node, rules, name) {
  if (node.t === 'ref' && !rules.has(node.name)) throw new Error(`${name} names an unknown rule ${node.name}`);
  (node.seqs || node.items || []).forEach((x) => checkRefs(x, rules, name));
  if (node.item) checkRefs(node.item, rules, name);
}

// → true when the whole text matches root.
function matches(grammar, text) {
  const rules = typeof grammar === 'string' ? parse(grammar) : grammar;
  const cps = Array.from(String(text)).map((c) => c.codePointAt(0));
  const memo = new Map();
  // Every end position reachable by matching node from position i.
  function m(node, i) {
    switch (node.t) {
      case 'lit': {
        for (let k = 0; k < node.cps.length; k++) if (cps[i + k] !== node.cps[k].codePointAt(0)) return [];
        return [i + node.cps.length];
      }
      case 'cls': {
        if (i >= cps.length) return [];
        const c = cps[i];
        const inside = node.ranges.some(([a, b]) => c >= a && c <= b);
        return inside !== node.neg ? [i + 1] : [];
      }
      case 'ref': {
        const key = node.name + '@' + i;
        if (memo.has(key)) return memo.get(key);
        memo.set(key, []);
        const out = m(rules.get(node.name), i);
        memo.set(key, out);
        return out;
      }
      case 'alt': return [...new Set([].concat(...node.seqs.map((s) => m(s, i))))];
      case 'seq': {
        let at = [i];
        for (const it of node.items) {
          const next = new Set();
          at.forEach((p) => m(it, p).forEach((e) => next.add(e)));
          at = [...next];
          if (!at.length) return [];
        }
        return at;
      }
      case 'rep': {
        // ? and * may match nothing; + needs one round. Only new ends go on.
        const out = new Set(node.op === '+' ? [] : [i]);
        let frontier = [i];
        while (frontier.length) {
          const next = [];
          for (const p of frontier) for (const e of m(node.item, p)) if (!out.has(e)) { out.add(e); next.push(e); }
          if (node.op === '?') break;
          frontier = next;
        }
        return [...out];
      }
    }
    throw new Error('Unknown node ' + node.t);
  }
  return m({ t: 'ref', name: 'root' }, 0).includes(cps.length);
}

module.exports = { parse, matches };
