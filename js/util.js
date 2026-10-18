// Shared namespace, settings and small helpers. No DOM access here.
(function (root) {
  const E = (root.Ensemble = root.Ensemble || {});

  // Backend presets. Every backend speaks the OpenAI-style chat API; KoboldCpp
  // also gets its native model/context endpoints for the Test button.
  E.backendPresets = {
    'kobold-local': { label: 'KoboldCpp on this computer', url: 'http://localhost:5001/v1', model: 'koboldcpp', kobold: true, key: false },
    'kobold-remote': { label: 'KoboldCpp on my machine (remote)', url: '', model: 'koboldcpp', kobold: true, key: 'optional',
      hint: 'Paste the public URL KoboldCpp prints when started with its remote tunnel option (ends in trycloudflare.com), or your PC\'s address on your home Wi-Fi.' },
    openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: '', key: true,
      hint: 'Create a key at openrouter.ai, then paste a model name from its model list (vendor/model-name).' },
    custom: { label: 'Other OpenAI-compatible API', url: '', model: '', key: true,
      hint: 'Base URL ending in /v1 (or the provider\'s documented base), plus key and model name.' },
  };
  E.routeSteps = [
    { id: 'intent', label: 'Characters & events' },
    { id: 'narrate', label: 'Narration' },
    { id: 'update', label: 'Memory updates' },
    { id: 'chapter', label: 'Chapter summaries' },
  ];

  E.defaults = {
    backends: {
      local: { preset: 'kobold-local', url: 'http://localhost:5001/v1', key: '', model: 'koboldcpp' },
      external: { preset: 'openrouter', url: 'https://openrouter.ai/api/v1', key: '', model: '' },
    },
    routing: { intent: 'local', narrate: 'local', update: 'local', chapter: 'local' },
    contextSize: 8192,
    temperature: 0.8,
    narrateTokens: 320,
    chapterLength: 5,
    debug: false,
  };
  E.settings = JSON.parse(JSON.stringify(E.defaults));

  E.loadSettings = function () {
    try {
      const raw = root.localStorage && root.localStorage.getItem('ensemble.settings');
      if (raw) {
        const saved = JSON.parse(raw);
        // Older versions had a single KoboldCpp "endpoint".
        if (saved.endpoint && !saved.backends) {
          saved.backends = JSON.parse(JSON.stringify(E.defaults.backends));
          saved.backends.local.url = String(saved.endpoint).replace(/\/+$/, '') + '/v1';
        }
        delete saved.endpoint;
        Object.assign(E.settings, saved);
        E.settings.backends = Object.assign(JSON.parse(JSON.stringify(E.defaults.backends)), E.settings.backends || {});
        E.settings.routing = Object.assign({}, E.defaults.routing, E.settings.routing || {});
      }
      // Migrate the old scene-length default; newer prompts target 100-200 words.
      if (E.settings.narrateTokens === 420) E.settings.narrateTokens = E.defaults.narrateTokens;
    } catch (e) { /* storage unavailable */ }
  };
  E.saveSettings = function () {
    try { root.localStorage.setItem('ensemble.settings', JSON.stringify(E.settings)); } catch (e) {}
  };

  E.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  E.clone = (o) => JSON.parse(JSON.stringify(o));
  E.estTokens = (s) => Math.ceil((s || '').length / 3.6);
  E.rng = Math.random;

  E.needWord = (v) => (v < 0.3 ? 'low' : v < 0.6 ? 'moderate' : v < 0.85 ? 'high' : 'critical');
  E.relWord = (v) =>
    v >= 50 ? 'trusts' : v >= 15 ? 'friendly' : v > -15 ? 'neutral' : v > -50 ? 'wary' : 'hostile';
  E.healthWord = (h) => ({ ok: 'unhurt', hurt: 'hurt', badly_hurt: 'badly hurt', dead: 'dead' }[h] || h);

  E.fmtTime = function (state) {
    const label = state.scenario.timeLabel || 'Day';
    const mins = Math.round(state.time.hour * 60);
    const hh = String(Math.floor(mins / 60) % 24).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    return `${label} ${state.time.day}, ${hh}:${mm}`;
  };

  E.esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Time steps the player can choose per action. "nextMorning" is computed.
  E.timeSteps = [
    { id: 'moment', label: 'A few minutes', hours: 0.25, words: '60–120', lengthMult: 0.7 },
    { id: 'hour', label: 'About an hour', hours: 1, words: '100–200', lengthMult: 1.2 },
    { id: 'hours', label: 'A few hours', hours: 3, words: '150–250', lengthMult: 1.45 },
    { id: 'morning', label: 'Until next morning', hours: null, words: '200–300', lengthMult: 1.75 },
    { id: 'major', label: '⏭ Until something major happens', hours: null, words: '250–350', lengthMult: 2.2 },
  ];
  E.stepHours = function (state, stepId) {
    const step = E.timeSteps.find((s) => s.id === stepId) || E.timeSteps[1];
    if (step.id === 'major') return { id: 'major', hours: 0, label: 'until something major happens', words: step.words, lengthMult: step.lengthMult };
    if (step.hours != null) return { id: step.id, hours: step.hours, label: step.label.toLowerCase(), words: step.words, lengthMult: step.lengthMult };
    const wake = state.scenario.wakeHour ?? 7;
    const h = state.time.hour;
    const hours = h < wake ? wake - h : 24 - h + wake;
    return { id: 'morning', hours, label: 'until next morning', words: step.words, lengthMult: step.lengthMult };
  };
})(typeof window !== 'undefined' ? window : globalThis);
