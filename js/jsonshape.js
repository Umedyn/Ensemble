// JSON reply shapes (task L-1). One description per JSON call gives the
// prompt's example, the GBNF grammar KoboldCpp samples under and the keys the
// repair path looks for, so the three can't drift apart. DOM-free.
//
// A node's `ex` is what the prompt's example shows: a hint like
// "character_id" or "low|medium|high" may stand for any allowed value.
// S.sample() writes a value the grammar accepts instead (tests use it).
(function (root) {
  const E = root.Ensemble;
  const S = (E.Shape = {});

  S.str = (ex) => ({ t: 'str', ex: ex == null ? '...' : ex });
  S.lit = (v) => ({ t: 'lit', v });
  S.nul = S.lit(null);
  // A string from a list (ids, enums). An empty list allows any string: the
  // engine's checks still apply.
  S.oneOf = (values, ex) => {
    const vs = [...new Set((values || []).filter((v) => v != null).map(String))];
    if (!vs.length) return S.str(ex);
    return { t: 'enum', values: vs, ex: ex === undefined ? vs[0] : ex };
  };
  S.int = (min, max, ex) => ({ t: 'int', min, max, ex: ex == null ? Math.max(min, Math.min(max, 0)) : ex });
  S.num = (ex) => ({ t: 'num', ex: ex == null ? 0 : ex });
  S.bool = (ex) => ({ t: 'bool', ex: !!ex });
  // The first alternative is the one the example shows.
  S.or = (...alts) => ({ t: 'or', alts });
  S.maybe = (x) => S.or(S.nul, x);
  // o: { max, min, n: how many items the example shows (default 1), all:
  // the example shows one of each alternative of an S.or item }.
  S.list = (item, o) => Object.assign({ t: 'list', item, min: 0, max: null, n: 1 }, o || {});
  S.tuple = (items) => ({ t: 'tuple', items });
  S.obj = (props) => ({ t: 'obj', props });
  // A key the reply may leave out (in its place in the order). shown: false
  // keeps it out of the example (the prompt describes it elsewhere). An
  // object's first key is never optional.
  S.opt = (node, shown) => ({ t: 'opt', node, shown: shown !== false });
  // An object whose keys come from a list (skills, relations by id).
  S.map = (keys, value, exKeys) => ({ t: 'map', keys: [...new Set(keys)], value, exKeys: exKeys || [keys[0] || 'id'] });
  // The same node shown differently in the example.
  S.show = (node, ex) => Object.assign({}, node, { raw: ex });

  // ---------- the example (compact, one line) ----------
  const listCount = (n) => Math.max(n.min || 0, n.max != null ? Math.min(n.n, n.max) : n.n);
  function show(n, valid) {
    if (!valid && n.raw != null) return n.raw;
    switch (n.t) {
      case 'str': return JSON.stringify(String(n.ex));
      case 'lit': return JSON.stringify(n.v);
      case 'enum': return JSON.stringify(valid && !n.values.includes(n.ex) ? n.values[0] : n.ex);
      case 'int': return String(valid ? Math.max(n.min, Math.min(n.max, Math.round(Number(n.ex) || 0))) : n.ex);
      case 'num': case 'bool': return String(n.ex);
      case 'or': return show(n.alts[0], valid);
      case 'list':
        // all: a list of alternatives shows one of each.
        if (n.all && n.item.t === 'or') return '[' + n.item.alts.slice(0, valid && n.max != null ? n.max : undefined).map((x) => show(x, valid)).join(',') + ']';
        return '[' + Array.from({ length: valid ? listCount(n) : n.n }, () => show(n.item, valid)).join(',') + ']';
      case 'tuple': return '[' + n.items.map((x) => show(x, valid)).join(',') + ']';
      case 'obj': return '{' + Object.entries(n.props).filter(([, v]) => v.t !== 'opt' || v.shown).map(([k, v]) => `${JSON.stringify(k)}:${show(v.t === 'opt' ? v.node : v, valid)}`).join(',') + '}';
      case 'map': {
        const keys = valid ? n.exKeys.filter((k) => n.keys.includes(k)).concat(n.keys.length && !n.exKeys.some((k) => n.keys.includes(k)) ? [n.keys[0]] : []) : n.exKeys;
        return '{' + keys.map((k) => `${JSON.stringify(k)}:${show(n.value, valid)}`).join(',') + '}';
      }
    }
    throw new Error('Unknown shape node: ' + n.t);
  }
  S.example = (n) => show(n, false);
  S.sample = (n) => show(n, true);

  // The reply's top-level keys (any one will do for LLM.pickShape).
  S.keys = (n) => (n.t === 'obj' ? Object.keys(n.props).filter((k) => n.props[k].t !== 'opt') : n.t === 'or' ? [...new Set([].concat(...n.alts.map(S.keys)))] : []);

  // ---------- the grammar ----------
  // GBNF as llama.cpp (and so KoboldCpp) reads it. Compact: an optional
  // single space after ":" and ",", nothing else between tokens, nothing
  // before or after the object. Repeats are written out as nested optionals,
  // so no {m,n} is needed. Identical rules are written once.
  const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const BASE = {
    sp: '" "?',
    str: '"\\"" ch* "\\""',
    ch: '[^"\\\\\\x00-\\x1f] | "\\\\" (["\\\\/bfnrt] | "u" hx hx hx hx)',
    hx: '[0-9a-fA-F]',
    num: '"-"? [0-9]+ ("." [0-9]+)?',
    bool: '"true" | "false"',
  };
  const NEEDS = { str: ['ch'], ch: ['hx'] };
  S.gbnf = function (shape) {
    const rules = []; // [name, body]
    const byBody = new Map();
    const used = new Set();
    const base = (id) => { if (!used.has(id)) { used.add(id); (NEEDS[id] || []).forEach(base); } return id; };
    const rule = (hint, body) => {
      if (byBody.has(body)) return byBody.get(body);
      const nm = hint + rules.length;
      byBody.set(body, nm);
      rules.push([nm, body]);
      return nm;
    };
    const sep = () => `"," ${base('sp')}`;
    function expr(n) {
      switch (n.t) {
        case 'str': return base('str');
        case 'lit': return q(JSON.stringify(n.v));
        case 'enum': return rule('id', n.values.map((v) => q(JSON.stringify(v))).join(' | '));
        case 'int': {
          const digits = String(Math.max(Math.abs(n.min), Math.abs(n.max))).length;
          return rule('int', (n.min < 0 ? '"-"? ' : '') + '[0-9]' + ' [0-9]?'.repeat(digits - 1));
        }
        case 'num': return base('num');
        case 'bool': return base('bool');
        case 'or': return rule('or', n.alts.map(expr).join(' | '));
        case 'list': {
          if (n.max === 0) return '"[]"';
          const it = expr(n.item);
          // Items after the first `from`: any number, or up to max.
          const more = (from) => {
            if (n.max == null) return ` (${sep()} ${it})*`;
            let rest = '';
            for (let k = from; k < n.max; k++) rest = ` (${sep()} ${it}${rest})?`;
            return rest;
          };
          if (n.min >= 1) return rule('list', `"[" ${Array.from({ length: n.min }, () => it).join(` ${sep()} `)}${more(n.min)} "]"`);
          return rule('list', `"[" (${it}${more(1)})? "]"`);
        }
        case 'tuple': return n.items.length ? rule('tup', `"[" ${n.items.map(expr).join(` ${sep()} `)} "]"`) : '"[]"';
        case 'obj': {
          const props = Object.entries(n.props);
          if (!props.length) return '"{}"';
          if (props[0][1].t === 'opt') throw new Error(`The first key of a shape can't be optional ("${props[0][0]}")`);
          const pair = (k, v) => `${q(JSON.stringify(k) + ':')} ${base('sp')} ${expr(v)}`;
          const parts = props.map(([k, v], i) => (i === 0 ? pair(k, v) : v.t === 'opt' ? `(${sep()} ${pair(k, v.node)})?` : `${sep()} ${pair(k, v)}`));
          return rule('obj', `"{" ${parts.join(' ')} "}"`);
        }
        case 'map': {
          const pair = rule('pair', `${n.keys.length ? expr(S.oneOf(n.keys)) : base('str')} ":" ${base('sp')} ${expr(n.value)}`);
          return rule('map', `"{" (${pair} (${sep()} ${pair})*)? "}"`);
        }
      }
      throw new Error('Unknown shape node: ' + n.t);
    }
    const top = expr(shape);
    const lines = [`root ::= ${top}`];
    rules.forEach(([nm, body]) => lines.push(`${nm} ::= ${body}`));
    Object.keys(BASE).forEach((id) => { if (used.has(id)) lines.push(`${id} ::= ${BASE[id]}`); });
    return lines.join('\n') + '\n';
  };

  // A short, stable hash of a grammar for recordings (FNV-1a, 32 bits).
  S.hash = function (text) {
    let h = 0x811c9dc5;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
})(typeof window !== 'undefined' ? window : globalThis);
