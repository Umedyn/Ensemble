// A parsed reply written out the way its grammar would have had it (task
// L-1): keys in the shape's order, compact, keys the shape doesn't know
// dropped and required ones it left out filled from the shape's sample. What
// is left to fail against the grammar is the content: ids, enums, numbers
// and list lengths. Used by tests/jsonshape.test.js.
const { matches } = require('./gbnf');

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// How well a value fits an object alternative: its literal and enum fields.
function fit(v, n) {
  if (!isObj(v) || n.t !== 'obj') return n.t === 'lit' ? (v === n.v ? 2 : -1) : 0;
  let score = 0;
  for (const [k, p] of Object.entries(n.props)) {
    if (!(k in v)) { if (p.t !== 'opt') score -= 1; continue; }
    if (p.t === 'lit') score += v[k] === p.v ? 3 : -5;
    else if (p.t === 'enum') score += p.values.includes(v[k]) ? 2 : 0;
    else score += 1;
  }
  return score - Object.keys(v).filter((k) => !(k in n.props)).length;
}

function value(E, v, n) {
  switch (n.t) {
    case 'opt': return value(E, v, n.node);
    case 'obj': {
      if (!isObj(v)) return v;
      const out = {};
      for (const [k, p] of Object.entries(n.props)) {
        if (k in v) out[k] = value(E, v[k], p);
        else if (p.t !== 'opt') out[k] = JSON.parse(E.Shape.sample(p));
      }
      return out;
    }
    case 'list': return Array.isArray(v) ? v.map((x) => value(E, x, n.item)) : v;
    case 'tuple': {
      if (!Array.isArray(v)) return v;
      // Items with a fixed id (the intents) go in the tuple's order.
      const idOf = (s) => (s && s.t === 'obj' && s.props.id && s.props.id.t === 'lit' ? s.props.id.v : undefined);
      const order = n.items.map(idOf);
      const xs = order.every((id) => id !== undefined)
        ? [...v].sort((a, b) => (order.indexOf(a && a.id) + 1 || 1e9) - (order.indexOf(b && b.id) + 1 || 1e9))
        : v;
      return xs.map((x, i) => (n.items[i] ? value(E, x, n.items[i]) : x));
    }
    case 'or': {
      const best = n.alts.map((a) => [fit(v, a), a]).sort((a, b) => b[0] - a[0])[0][1];
      return value(E, v, best);
    }
    default: return v;
  }
}

const text = (E, v, shape) => JSON.stringify(value(E, v, shape));

// Which top-level keys the grammar refuses: each is swapped for the sample
// in turn; the ones whose swap alone makes the reply match are named.
function why(E, v, shape, grammar) {
  const c = value(E, v, shape);
  if (!isObj(c) || shape.t !== 'obj') return '(not an object)';
  const bad = Object.keys(c).filter((k) => {
    const p = shape.props[k];
    const sample = JSON.parse(E.Shape.sample(p.t === 'opt' ? p.node : p));
    return matches(grammar, JSON.stringify(Object.assign({}, c, { [k]: sample })));
  });
  return bad.length ? bad.map((k) => `${k}: ${JSON.stringify(c[k]).slice(0, 160)}`).join(' | ') : '(more than one key)';
}

module.exports = { value, text, why };
