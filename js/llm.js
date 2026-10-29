// KoboldCpp client. Uses the OpenAI-compatible chat endpoint so the model's
// own chat template is applied, plus tolerant JSON extraction with one retry.
(function (root) {
  const E = root.Ensemble;
  const LLM = (E.LLM = {});

  LLM.calls = []; // debug history: {kind, system, user, raw, ms, error}
  LLM.maxHistory = 30;
  LLM.onCall = null; // UI hook

  // ---------- backends ----------
  // A split call's kind names its part after a colon ("intent:char", task L-3).
  LLM.stepOf = (kind) => String(kind || '').split(/[ :]/)[0];
  LLM.backend = function (id) {
    const b = E.settings.backends[id] || E.settings.backends.local;
    const preset = E.backendPresets[b.preset] || {};
    let url = String(b.url || preset.url || '').trim().replace(/\/+$/, '');
    if (preset.kobold && url && !/\/v\d+$/.test(url)) url += '/v1';
    // Constrain JSON (task L-1): KoboldCpp samples under a grammar; a hosted
    // API whose preset knows a JSON mode gets response_format.
    const constrain = (b.constrainJSON != null ? !!b.constrainJSON : LLM.constrainDefault(b.preset)) && (!!preset.kobold || !!preset.jsonMode);
    // Smaller calls (task L-3): the intent and the update in short parts.
    const smaller = b.smallerCalls != null ? !!b.smallerCalls : LLM.smallerDefault(b.preset, b.context);
    return { id, preset: b.preset, kobold: !!preset.kobold, url, key: String(b.key || '').trim(), model: String(b.model || preset.model || '').trim(), label: preset.label || b.preset, context: b.context || 0, constrain, smaller };
  };
  // On by default for KoboldCpp and for any backend at 16K context or less.
  LLM.SMALLER_UP_TO = 16384;
  LLM.smallerDefault = (presetId, context) => !!(E.backendPresets[presetId] || {}).kobold || (!!context && context <= LLM.SMALLER_UP_TO);
  // On by default for KoboldCpp and for APIs with a known JSON mode.
  LLM.constrainDefault = (presetId) => { const p = E.backendPresets[presetId] || {}; return !!(p.kobold || p.jsonMode); };
  // APIs that refused response_format this session (HTTP 400): url + model.
  LLM.noJsonMode = new Set();
  // Steps without their own routing setting go with another step's backend.
  LLM.ROUTE_AS = { suggest: 'intent' };
  LLM.backendFor = (kind) => {
    const step = LLM.stepOf(kind);
    return LLM.backend(E.settings.routing[step] || E.settings.routing[LLM.ROUTE_AS[step]] || 'local');
  };
  LLM.usesExternal = () => Object.values(E.settings.routing).includes('external');
  const host = (url) => { try { return new URL(url).host; } catch (e) { return url || '(no URL)'; } };

  function friendlyHttpError(status, b, detail) {
    const where = host(b.url);
    if (status === 401 || status === 403) return `${where} rejected the API key (HTTP ${status}). Check the key in Settings.`;
    if (status === 402) return `${where} says the account is out of credits (HTTP 402).`;
    if (status === 404) return `${where} returned 404. Check the base URL and the model name ("${b.model}").`;
    if (status === 429) return `${where} is rate-limiting requests (HTTP 429). Wait a moment and try again.`;
    return `${where} returned HTTP ${status}${detail ? ': ' + detail : ''}`;
  }

  // Swappable transport (the test harness replaces this with a mock).
  // stream (task L-2): { onText(textSoFar) → { at, why } to stop there, or
  // nothing }. Used only when body.stream is set; a transport that ignores it
  // (the replays, the test mocks) returns the whole text as before.
  LLM.transport = async function (url, body, kind, b, stream) {
    const headers = { 'Content-Type': 'application/json' };
    if (b && b.key) headers.Authorization = 'Bearer ' + b.key;
    const ctrl = body.stream && typeof AbortController !== 'undefined' ? new AbortController() : null;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch (e) {}
      throw new Error(friendlyHttpError(r.status, b || { url }, detail));
    }
    // A server that ignores "stream" answers with plain JSON, read below.
    if (body.stream && r.body && /event-stream/.test((r.headers && r.headers.get('content-type')) || '')) return readStream(r, body, b, stream, ctrl);
    const j = await r.json();
    if (j.error) throw new Error(`${host(url)}: ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
    const choice = (j.choices && j.choices[0]) || {};
    // finish "length" = cut off at max_tokens (reasoning models count their thinking too)
    return { text: (choice.message && choice.message.content) || '', finish: choice.finish_reason || '', usage: j.usage || null };
  };

  // Server-sent events from an OpenAI-style chat endpoint: only the reply's
  // text (never a reasoning stream), its finish reason and usage. A soft stop
  // aborts the request and, for KoboldCpp, tells the server to stop too.
  async function readStream(r, body, b, stream, ctrl) {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', text = '', finish = '', usage = null;
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) { if (ctrl && ctrl.signal.aborted) break; throw e; }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const data = line.replace(/^data:\s?/, '').trim();
        if (!line.startsWith('data:') || !data || data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error(`${host(b.url)}: ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
        const choice = (j.choices && j.choices[0]) || {};
        if (choice.delta && typeof choice.delta.content === 'string') text += choice.delta.content;
        if (choice.finish_reason) finish = choice.finish_reason;
        if (j.usage) usage = j.usage;
      }
      const stop = stream && stream.onText ? stream.onText(text) : null;
      if (stop && stop.at != null) {
        if (ctrl) ctrl.abort();
        try { await reader.cancel(); } catch (e) {}
        if (b.kobold) await LLM.abort(b, body.genkey);
        return { text: text.slice(0, stop.at), finish: 'stopped', usage: null, stopped: stop.why || '' };
      }
    }
    return { text, finish, usage };
  }
  // Stops our own generation on KoboldCpp (its genkey), so the GPU is free
  // for the next call. A failure here changes nothing.
  LLM.abort = async function (b, genkey) {
    if (typeof fetch !== 'function') return;
    const headers = { 'Content-Type': 'application/json' };
    if (b.key) headers.Authorization = 'Bearer ' + b.key;
    try { await fetch(b.url.replace(/\/v\d+$/, '') + '/api/extra/abort', { method: 'POST', headers, body: JSON.stringify({ genkey }) }); } catch (e) {}
  };

  // Token counts from the response's usage block; estimates (marked) when absent.
  // Cached prompt tokens only when the provider reports them.
  LLM.readUsage = function (usage, system, user, raw) {
    const u = usage && typeof usage === 'object' ? usage : {};
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
    const prompt = num(u.prompt_tokens ?? u.input_tokens);
    const completion = num(u.completion_tokens ?? u.output_tokens);
    const details = u.prompt_tokens_details || u.input_tokens_details || {};
    const cached = num(details.cached_tokens ?? u.cache_read_input_tokens);
    return {
      promptTokens: prompt ?? E.estTokens(system) + E.estTokens(user),
      completionTokens: completion ?? E.estTokens(raw),
      estimated: prompt == null || completion == null,
      cachedTokens: cached,
    };
  };

  // KoboldCpp's perf endpoint: how long the last prompt took to process and
  // how long generation took. Prompt time is the cache signal: a reused prefix
  // processes in a fraction of the time. Swappable for tests; null when absent.
  LLM.perf = async function (b) {
    if (!b.kobold || typeof fetch !== 'function') return null;
    try {
      const r = await fetch(b.url.replace(/\/v\d+$/, '') + '/api/extra/perf', { headers: b.key ? { Authorization: 'Bearer ' + b.key } : {} });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.last_process_time == null && j.last_eval_time == null) return null;
      return { processSec: Number(j.last_process_time) || 0, evalSec: Number(j.last_eval_time) || 0, processTps: Number(j.last_process_speed) || null, evalTps: Number(j.last_eval_speed) || null };
    } catch (e) { return null; }
  };

  // While a turn runs, every call is also added to this list (see Engine.runTurn).
  LLM.collector = null;

  // A reply cut off at the token cap before it said anything usable gets one
  // retry with this much more room (hosted reasoning models think first).
  LLM.moreRoom = () => 2;
  LLM.hostedJSONTokens = 10000; // JSON steps on hosted backends
  // Prose steps on hosted backends get this much extra room: reasoning models
  // spend part of max_tokens thinking even when asked not to, and only tokens
  // actually generated are billed. Length is steered by the prompt's word count.
  LLM.hostedTextHeadroom = 1024;

  // Test a backend. KoboldCpp reports its model and context; other APIs are
  // checked with their model list.
  LLM.ping = async function (id) {
    const b = LLM.backend(id || 'local');
    if (!b.url) throw new Error('No URL set.');
    const headers = b.key ? { Authorization: 'Bearer ' + b.key } : {};
    if (b.kobold) {
      const root = b.url.replace(/\/v\d+$/, '');
      const r = await fetch(root + '/api/v1/model', { headers });
      if (!r.ok) throw new Error(friendlyHttpError(r.status, b));
      const j = await r.json();
      let context = null;
      try {
        const c = await fetch(root + '/api/extra/true_max_context_length', { headers });
        if (c.ok) context = (await c.json()).value || null;
      } catch (e) { /* older KoboldCpp */ }
      return { model: String(j.result || 'unknown').replace(/^koboldcpp\//, ''), context };
    }
    if (!b.model) throw new Error('Set a model name for this backend.');
    const r = await fetch(b.url + '/models', { headers });
    if (!r.ok) throw new Error(friendlyHttpError(r.status, b));
    let known = null, context = null;
    try {
      const j = await r.json();
      const list = j.data || [];
      if (list.length) {
        const m = list.find((x) => x.id === b.model);
        known = !!m;
        // OpenRouter lists each model's context; other providers may not.
        if (m) context = parseInt(m.context_length || m.context_window, 10) || null;
      }
    } catch (e) {}
    if (known === false) throw new Error(`${host(b.url)} is reachable, but doesn't list a model called "${b.model}".`);
    return { model: b.model, context };
  };

  function stripThink(text) {
    let t = String(text || '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    t = t.replace(/^[\s\S]*?<\/think>/i, ''); // unopened tag from templates that prefill <think>
    t = t.replace(/<think>[\s\S]*$/i, ''); // thinking cut off before it closed
    return t.trim();
  }

  // A reply that is a list ("[{...}]") is read as the list, when it parses
  // whole; LLM.pickShape then finds the object in it.
  LLM.extractJSON = function (text) {
    const t = String(text || '').replace(/```(?:json)?/gi, '');
    const arr = t.indexOf('[');
    if (arr >= 0 && arr < t.indexOf('{') && !t.slice(0, arr).trim()) {
      try { return JSON.parse(t.slice(arr, t.lastIndexOf(']') + 1)); } catch (e) {}
      try { return JSON.parse(t.slice(arr, t.lastIndexOf(']') + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
    }
    return firstObject(t);
  };
  // The object a step asked for, inside whatever came back: a list around it,
  // a wrapper object ({"response": {...}}), or JSON written into a string (a
  // chat log's "value"). expect: its top-level keys, any one of which will do;
  // without it, the first object. → the object or null.
  LLM.pickShape = function (v, expect, depth) {
    depth = depth || 0;
    if (v == null || depth > 4) return null;
    if (typeof v === 'string') return depth && /[{[]/.test(v) ? LLM.pickShape(LLM.extractJSON(v), expect, depth + 1) : null;
    if (Array.isArray(v)) {
      for (const x of v) { const hit = LLM.pickShape(x, expect, depth + 1); if (hit) return hit; }
      return null;
    }
    if (typeof v !== 'object') return null;
    if (!expect || !expect.length || expect.some((k) => k in v)) return v;
    for (const x of Object.values(v)) { const hit = LLM.pickShape(x, expect, depth + 1); if (hit) return hit; }
    return null;
  };
  function firstObject(t) {
    const start = t.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    const open = [];
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') { open.push(c === '{' ? '}' : ']'); if (c === '{') depth++; }
      else if (c === '}' || c === ']') { open.pop(); if (c === '}') { depth--; if (depth === 0) { end = i; break; } } }
    }
    const chunk = end > 0 ? t.slice(start, end + 1) : t.slice(start);
    const attempts = [chunk, chunk.replace(/,\s*([}\]])/g, '$1')];
    // A closing brace the model forgot (playtest-coffee-toothless: "major_event"
    // left open, so "positions" ended up inside it): close what is still open.
    if (end < 0 && !inStr && open.length) attempts.push(chunk.replace(/\s+$/, '') + open.reverse().join(''));
    for (const a of attempts) {
      try { return JSON.parse(a); } catch (e) {}
    }
    return null;
  }

  // Last resort for JSON cut off at the token cap: keep everything up to the
  // last complete item (cut at the last comma outside a string) and close the
  // open brackets. Returns null if nothing usable is left.
  LLM.salvageJSON = function (text) {
    const t = String(text || '').replace(/```(?:json)?/gi, '');
    const start = t.indexOf('{');
    if (start < 0) return null;
    const stack = [];
    const cuts = []; // [index of comma, closers needed there]
    let inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') stack.push('}');
      else if (c === '[') stack.push(']');
      else if (c === '}' || c === ']') stack.pop();
      else if (c === ',') cuts.push([i, stack.slice().reverse().join('')]);
    }
    for (let k = cuts.length - 1; k >= 0; k--) {
      try { return JSON.parse(t.slice(start, cuts[k][0]) + cuts[k][1]); } catch (e) {}
    }
    return null;
  };

  function record(entry) {
    LLM.calls.push(entry);
    if (LLM.calls.length > LLM.maxHistory) LLM.calls.shift();
    if (LLM.collector) LLM.collector.push(entry);
    if (LLM.onCall) try { LLM.onCall(entry); } catch (e) {}
  }

  LLM.lastFinish = ''; // finish reason of the most recent call

  // A call that would overflow the backend's context (task G-4) loses parts of
  // its user message, never the header (rule 7): the lore, then all but the
  // end of the last scene, then the nearby regions. → { user, cut: [what went] }
  LLM.squeeze = function (user, over) {
    let text = user;
    const cut = [];
    const tokens = () => E.estTokens(user) - E.estTokens(text);
    const steps = [
      ['lore', (t) => t.replace(/\n=== LORE\b[^\n]*===\n[\s\S]*?(?=\n=== |$)/, '')],
      ['the start of the last scene', (t) => t.replace(/(\n=== LAST SCENE ===\n)([\s\S]*?)(?=\n=== |$)/, (m, head, body) => {
        const paras = body.split(/\n\n+/);
        return paras.length > 2 ? head + '[…]\n\n' + paras.slice(-2).join('\n\n') : m;
      })],
      ['nearby regions', (t) => t.replace(/\nNearby: [^\n]*/, '')],
    ];
    for (const [name, step] of steps) {
      if (tokens() >= over) break;
      const next = step(text);
      if (next !== text) { text = next; cut.push(name); }
    }
    return { user: text, cut };
  };

  LLM.chat = async function (opts) {
    const { kind, system, maxTokens, temperature } = opts;
    let { user } = opts;
    const b = LLM.backendFor(kind);
    const reply = (maxTokens || 400) + (!b.kobold && (maxTokens || 400) < LLM.hostedJSONTokens ? LLM.hostedTextHeadroom : 0);
    let squeezed = null;
    if (b.context && E.estTokens(system) + E.estTokens(user) + reply > b.context) {
      const sq = LLM.squeeze(user, E.estTokens(system) + E.estTokens(user) + reply - b.context);
      if (sq.cut.length) { user = sq.user; squeezed = sq.cut; }
    }
    if (!b.url) throw new Error(`No URL is set for the ${b.id} backend (used for ${LLM.stepOf(kind)}). Check Settings.`);
    if (!b.kobold && !b.model) throw new Error(`No model name is set for the ${b.id} backend. Check Settings.`);
    const body = {
      model: b.model || 'koboldcpp',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: reply,
      temperature: temperature ?? E.settings.temperature,
      stream: false,
    };
    // Keep OpenRouter's reasoning models from spending the budget thinking.
    if (b.preset === 'openrouter') body.reasoning = { effort: 'low', exclude: true };
    // The reply's shape (task L-1): KoboldCpp takes a GBNF grammar on its chat
    // endpoint and allows nothing outside it; other APIs get their JSON mode.
    const jsonKey = b.url + ' ' + b.model;
    if (opts.shape && b.constrain) {
      if (b.kobold) body.grammar = E.Shape.gbnf(opts.shape);
      else if (!LLM.noJsonMode.has(jsonKey)) body.response_format = { type: 'json_object' };
    }
    // Narration streams (task L-2): opts.stopAt(text) → { at, why } stops it
    // at a paragraph; opts.onText(text) sees it grow. KoboldCpp gets a genkey
    // so the abort stops only this generation.
    let stream = null;
    if (opts.stopAt || opts.onText) {
      body.stream = true;
      if (b.kobold) body.genkey = 'ENS' + Math.floor(Math.random() * 1e9).toString(36);
      else body.stream_options = { include_usage: true };
      stream = { onText: (t) => { if (opts.onText) opts.onText(t); return opts.stopAt ? opts.stopAt(t) : null; } };
    }
    const est = E.estTokens(system) + E.estTokens(user) + body.max_tokens;
    const t0 = Date.now();
    const entry = { kind, step: LLM.stepOf(kind), backend: `${b.id}: ${b.model || b.label}`, system, user, raw: '', ms: 0, estTokens: est, overBudget: !!b.context && est > b.context, squeezed,
      retry: /\((retry|more room)\)/.test(kind) };
    if (body.grammar) entry.grammar = body.grammar.length;
    if (body.response_format) entry.jsonMode = true;
    try {
      const out = await LLM.transport(b.url + '/chat/completions', body, kind, b, stream);
      const r = typeof out === 'string' ? { text: out, finish: '' } : out;
      entry.raw = r.text || '';
      entry.finish = r.finish || '';
      if (body.stream) entry.streamed = true;
      if (r.finish === 'stopped') entry.stopped = r.stopped || 'a paragraph';
      entry.ms = Date.now() - t0;
      Object.assign(entry, LLM.readUsage(r.usage, system, user, entry.raw));
      entry.perf = await LLM.perf(b);
      record(entry);
      LLM.lastFinish = entry.finish;
      const text = stripThink(entry.raw);
      if (!text && entry.finish === 'length' && !opts.moreRoom) {
        return LLM.chat(Object.assign({}, opts, { kind: kind + ' (more room)', maxTokens: body.max_tokens * LLM.moreRoom(b), moreRoom: true }));
      }
      return text;
    } catch (err) {
      entry.ms = Date.now() - t0;
      entry.error = String(err.message || err);
      record(entry);
      // An API that doesn't take response_format: once more without it, and
      // not again this session.
      if (body.response_format && /HTTP 400/.test(entry.error)) {
        LLM.noJsonMode.add(jsonKey);
        return LLM.chat(Object.assign({}, opts, { kind: kind + ' (no JSON mode)' }));
      }
      if (err && err.name === 'TypeError') { // network failure (fetch throws TypeError)
        throw new Error(b.kobold
          ? `Couldn't reach KoboldCpp at ${host(b.url)}. Is it running, and is the URL right?`
          : `Couldn't reach ${host(b.url)}. Check the URL and your connection; some providers also block calls from web pages.`);
      }
      throw err;
    }
  };

  LLM.chatJSON = async function (opts) {
    // Hosted models write richer JSON than the local 12B the limits were sized
    // for (DeepSeek overran even double), and only generated tokens are billed,
    // so they get a flat, generous limit.
    if (!LLM.backendFor(opts.kind).kobold) opts = Object.assign({}, opts, { maxTokens: Math.max(opts.maxTokens || 400, LLM.hostedJSONTokens) });
    // opts.shape (task L-1): the reply's shape, or the one the prompt was
    // built with (E.Prompts.shapeFor). It gives the grammar and the keys.
    const shape = opts.shape || (E.Prompts && E.Prompts.shapeFor ? E.Prompts.shapeFor(opts.user) : null);
    if (shape) opts = Object.assign({}, opts, { shape });
    // opts.expect: the reply's top-level keys (any one will do). A reply in
    // another shape (a list of chat turns, an event log) is retried, not taken
    // half-read (playtest-seiryo-goes-to-school: the update came back as a list).
    const keys = Array.isArray(opts.expect) && opts.expect.length ? opts.expect : shape ? E.Shape.keys(shape) : [];
    const expect = keys.length ? keys : null;
    const read = (t) => LLM.pickShape(LLM.extractJSON(t), expect);
    let text = await LLM.chat(opts);
    let obj = read(text);
    if (!obj) {
      // cut off mid-JSON: the same limit would fail the same way
      const cutOff = LLM.lastFinish === 'length';
      text = await LLM.chat(Object.assign({}, opts, {
        kind: opts.kind + ' (retry)',
        temperature: 0.3,
        maxTokens: cutOff ? (opts.maxTokens || 400) * LLM.moreRoom(LLM.backendFor(opts.kind)) : opts.maxTokens,
        moreRoom: cutOff || opts.moreRoom,
        user: opts.user + `\n\nIMPORTANT: Reply with ONLY the JSON object${expect ? `, starting with {"${expect[0]}":` : ''}. No prose, no code fences, no list around it.`,
      }));
      obj = read(text);
      if (!obj && LLM.lastFinish === 'length') {
        obj = LLM.pickShape(LLM.salvageJSON(text), expect);
        const last = LLM.calls[LLM.calls.length - 1];
        if (obj && last) last.salvaged = true;
      }
    }
    if (!obj) throw new Error(`The model didn't return valid JSON for the ${opts.kind} step.`);
    return obj;
  };
})(typeof window !== 'undefined' ? window : globalThis);
