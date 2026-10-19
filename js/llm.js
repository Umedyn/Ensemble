// KoboldCpp client. Uses the OpenAI-compatible chat endpoint so the model's
// own chat template is applied, plus tolerant JSON extraction with one retry.
(function (root) {
  const E = root.Ensemble;
  const LLM = (E.LLM = {});

  LLM.calls = []; // debug history: {kind, system, user, raw, ms, error}
  LLM.maxHistory = 30;
  LLM.onCall = null; // UI hook

  // ---------- backends ----------
  LLM.stepOf = (kind) => String(kind || '').split(' ')[0];
  LLM.backend = function (id) {
    const b = E.settings.backends[id] || E.settings.backends.local;
    const preset = E.backendPresets[b.preset] || {};
    let url = String(b.url || preset.url || '').trim().replace(/\/+$/, '');
    if (preset.kobold && url && !/\/v\d+$/.test(url)) url += '/v1';
    return { id, preset: b.preset, kobold: !!preset.kobold, url, key: String(b.key || '').trim(), model: String(b.model || preset.model || '').trim(), label: preset.label || b.preset };
  };
  LLM.backendFor = (kind) => LLM.backend(E.settings.routing[LLM.stepOf(kind)] || 'local');
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
  LLM.transport = async function (url, body, kind, b) {
    const headers = { 'Content-Type': 'application/json' };
    if (b && b.key) headers.Authorization = 'Bearer ' + b.key;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch (e) {}
      throw new Error(friendlyHttpError(r.status, b || { url }, detail));
    }
    const j = await r.json();
    if (j.error) throw new Error(`${host(url)}: ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
    const choice = (j.choices && j.choices[0]) || {};
    // finish "length" = cut off at max_tokens (reasoning models count their thinking too)
    return { text: (choice.message && choice.message.content) || '', finish: choice.finish_reason || '' };
  };

  // A reply cut off at the token cap before it said anything usable gets one
  // retry with this much more room (hosted reasoning models think first).
  LLM.moreRoom = (b) => (b.kobold ? 2 : 4);

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
    let known = null;
    try {
      const j = await r.json();
      const list = (j.data || []).map((m) => m.id);
      if (list.length) known = list.includes(b.model);
    } catch (e) {}
    if (known === false) throw new Error(`${host(b.url)} is reachable, but doesn't list a model called "${b.model}".`);
    return { model: b.model, context: null };
  };

  function stripThink(text) {
    let t = String(text || '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    t = t.replace(/^[\s\S]*?<\/think>/i, ''); // unopened tag from templates that prefill <think>
    t = t.replace(/<think>[\s\S]*$/i, ''); // thinking cut off before it closed
    return t.trim();
  }

  LLM.extractJSON = function (text) {
    let t = String(text || '').replace(/```(?:json)?/gi, '');
    const start = t.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const chunk = end > 0 ? t.slice(start, end + 1) : t.slice(start);
    const attempts = [chunk, chunk.replace(/,\s*([}\]])/g, '$1')];
    for (const a of attempts) {
      try { return JSON.parse(a); } catch (e) {}
    }
    return null;
  };

  function record(entry) {
    LLM.calls.push(entry);
    if (LLM.calls.length > LLM.maxHistory) LLM.calls.shift();
    if (LLM.onCall) try { LLM.onCall(entry); } catch (e) {}
  }

  LLM.lastFinish = ''; // finish reason of the most recent call

  LLM.chat = async function (opts) {
    const { kind, system, user, maxTokens, temperature } = opts;
    const b = LLM.backendFor(kind);
    if (!b.url) throw new Error(`No URL is set for the ${b.id} backend (used for ${LLM.stepOf(kind)}). Check Settings.`);
    if (!b.kobold && !b.model) throw new Error(`No model name is set for the ${b.id} backend. Check Settings.`);
    const body = {
      model: b.model || 'koboldcpp',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens || 400,
      temperature: temperature ?? E.settings.temperature,
      stream: false,
    };
    // Keep OpenRouter's reasoning models from spending the budget thinking.
    if (b.preset === 'openrouter') body.reasoning = { effort: 'low', exclude: true };
    const est = E.estTokens(system) + E.estTokens(user) + body.max_tokens;
    const t0 = Date.now();
    const entry = { kind, backend: `${b.id}: ${b.model || b.label}`, system, user, raw: '', ms: 0, estTokens: est, overBudget: est > E.settings.contextSize };
    try {
      const out = await LLM.transport(b.url + '/chat/completions', body, kind, b);
      const r = typeof out === 'string' ? { text: out, finish: '' } : out;
      entry.raw = r.text || '';
      entry.finish = r.finish || '';
      entry.ms = Date.now() - t0;
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
      if (err && err.name === 'TypeError') { // network failure (fetch throws TypeError)
        throw new Error(b.kobold
          ? `Couldn't reach KoboldCpp at ${host(b.url)}. Is it running, and is the URL right?`
          : `Couldn't reach ${host(b.url)}. Check the URL and your connection; some providers also block calls from web pages.`);
      }
      throw err;
    }
  };

  LLM.chatJSON = async function (opts) {
    let text = await LLM.chat(opts);
    let obj = LLM.extractJSON(text);
    if (!obj) {
      // cut off mid-JSON: the same limit would fail the same way
      const cutOff = LLM.lastFinish === 'length';
      text = await LLM.chat(Object.assign({}, opts, {
        kind: opts.kind + ' (retry)',
        temperature: 0.3,
        maxTokens: cutOff ? (opts.maxTokens || 400) * LLM.moreRoom(LLM.backendFor(opts.kind)) : opts.maxTokens,
        moreRoom: cutOff || opts.moreRoom,
        user: opts.user + '\n\nIMPORTANT: Reply with ONLY the JSON object. No prose, no code fences.',
      }));
      obj = LLM.extractJSON(text);
    }
    if (!obj) throw new Error(`The model didn't return valid JSON for the ${opts.kind} step.`);
    return obj;
  };
})(typeof window !== 'undefined' ? window : globalThis);
