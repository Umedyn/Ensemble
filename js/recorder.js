// Session recorder for replay tests. While recording, every random number the
// engine draws and every model call (request text and reply) is kept per
// action, starting from a copy of the game state. The result is a JSON fixture
// that tests/replay.js plays back without a model. Never records API keys or
// URLs: keys travel only in request headers, which are never stored.
(function (root) {
  const E = root.Ensemble;
  const R = (E.Recorder = {});
  let rec = null; // the live recording
  let last = null; // the most recent fixture, kept after stop for export

  R.active = () => !!rec;
  R.fixture = () => (rec ? rec.fixture : last);
  R.count = () => { const f = R.fixture(); return f ? f.actions.length : 0; };

  // Settings that change prompts or call limits; no keys, no URLs.
  R.settingsSnapshot = function () {
    const s = E.settings;
    const backends = {};
    Object.keys(s.backends || {}).forEach((id) => {
      const b = s.backends[id] || {};
      backends[id] = { preset: b.preset, model: b.model || '', context: b.context || null };
    });
    return {
      narrateTokens: s.narrateTokens, temperature: s.temperature, chapterLength: s.chapterLength,
      memoryCap: s.memoryCap, routing: Object.assign({}, s.routing), backends,
    };
  };

  R.start = function (state, note) {
    if (rec) R.stop();
    const start = E.clone(state);
    delete start.undo;
    const fixture = {
      format: 'ensemble-recording', version: 1, recorded: new Date().toISOString(), note: note || '',
      settings: R.settingsSnapshot(), start, actions: [],
    };
    const innerRng = E.rng;
    const innerTransport = E.LLM.transport;
    const rng = function () {
      const v = innerRng();
      if (rec && rec.current && rec.current.rng) rec.current.rng.push(v);
      return v;
    };
    const transport = async function (url, body, kind, b) {
      const call = {
        kind, backend: b ? b.id : null,
        request: { system: body.messages[0].content, user: body.messages[1].content, max_tokens: body.max_tokens, temperature: body.temperature },
      };
      if (rec && rec.current && rec.current.calls) rec.current.calls.push(call);
      try {
        const out = await innerTransport(url, body, kind, b);
        const r = typeof out === 'string' ? { text: out, finish: '' } : out || {};
        call.response = { text: r.text || '', finish: r.finish || '', usage: r.usage || null };
        return out;
      } catch (err) {
        call.error = { name: err && err.name, message: String((err && err.message) || err) };
        throw err;
      }
    };
    E.rng = rng;
    E.LLM.transport = transport;
    rec = { fixture, current: null, rng, transport, innerRng, innerTransport };
    last = fixture;
    return fixture;
  };

  R.stop = function () {
    if (!rec) return last;
    if (E.rng === rec.rng) E.rng = rec.innerRng;
    if (E.LLM.transport === rec.transport) E.LLM.transport = rec.innerTransport;
    last = rec.fixture;
    rec = null;
    return last;
  };

  // Called by the engine at the start of each action (turn, reroll, undo).
  // Returns a handle whose end(err) closes the action, or null when idle.
  R.begin = function (type, args) {
    if (!rec) return null;
    const entry = Object.assign({ type }, args || {}, type === 'undo' ? {} : { rng: [], calls: [] });
    rec.fixture.actions.push(entry);
    rec.current = entry;
    return {
      end(err) {
        if (err) entry.error = { name: err.name, message: String(err.message || err) };
        if (rec && rec.current === entry) rec.current = null;
      },
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
