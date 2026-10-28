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
    { id: 'worldbuild', label: 'World building (characters, starts, sites)' },
  ];

  E.defaults = {
    backends: {
      local: { preset: 'kobold-local', url: 'http://localhost:5001/v1', key: '', model: 'koboldcpp', context: 8192 },
      external: { preset: 'openrouter', url: 'https://openrouter.ai/api/v1', key: '', model: '', context: 32768 },
    },
    routing: { intent: 'local', narrate: 'local', update: 'local', chapter: 'local', worldbuild: 'local' },
    memoryCap: 32768, // the most context memory is planned for, however big the model's
    temperature: 0.8,
    narrateTokens: 320,
    // The most turns a chapter runs; chapters mostly close when their facts
    // fill a share of the memory budget (Memory.needsChapter).
    chapterLength: 12,
    chapterRule: 2,
    debug: false,
    // Settings › Appearance; index.html applies it before first paint.
    appearance: { theme: 'dark', textSize: 100, storyFont: 'serif', lineSpacing: 'normal', motion: 'system', mapDetail: 'detailed' },
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
        // Older versions had one global context size, meant for the local model.
        if (saved.contextSize) {
          saved.backends = saved.backends || JSON.parse(JSON.stringify(E.defaults.backends));
          saved.backends.local = Object.assign({}, E.defaults.backends.local, saved.backends.local, { context: saved.contextSize });
        }
        delete saved.contextSize;
        // Chapters used to close every 5 turns by default; now they close
        // by size, with a longer backstop.
        if (!saved.chapterRule) { if (saved.chapterLength === 5) delete saved.chapterLength; saved.chapterRule = 2; }
        Object.assign(E.settings, saved);
        E.settings.backends = Object.assign(JSON.parse(JSON.stringify(E.defaults.backends)), E.settings.backends || {});
        Object.keys(E.defaults.backends).forEach((id) => {
          if (!E.settings.backends[id].context) E.settings.backends[id].context = E.defaults.backends[id].context;
        });
        E.settings.routing = Object.assign({}, E.defaults.routing, E.settings.routing || {});
        E.settings.appearance = Object.assign({}, E.defaults.appearance, E.settings.appearance || {});
      }
      // Migrate the old scene-length default; newer prompts target 100-200 words.
      if (E.settings.narrateTokens === 420) E.settings.narrateTokens = E.defaults.narrateTokens;
    } catch (e) { /* storage unavailable */ }
  };
  // The context memory budgets are planned for: the smallest among the
  // backends in use (the shared prompt prefix goes to all of them), capped.
  E.memoryContext = function () {
    const ids = Array.from(new Set(Object.values(E.settings.routing)));
    let tokens = Infinity, from = ids[0] || 'local';
    ids.forEach((id) => {
      const b = E.settings.backends[id] || {};
      const c = b.context || (E.defaults.backends[id] || E.defaults.backends.local).context;
      if (c < tokens) { tokens = c; from = id; }
    });
    const cap = E.settings.memoryCap || E.defaults.memoryCap;
    return tokens > cap ? { tokens: cap, from, capped: true } : { tokens, from, capped: false };
  };

  E.saveSettings = function () {
    try { root.localStorage.setItem('ensemble.settings', JSON.stringify(E.settings)); } catch (e) {}
  };

  E.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  E.clone = (o) => JSON.parse(JSON.stringify(o));
  // Skills for a world that lists none.
  E.DEFAULT_SKILLS = ['physical', 'technical', 'social', 'knowledge', 'stealth'];
  // Cuts at a word boundary with an ellipsis instead of mid-word.
  // Stable 32-bit hash (FNV-1a) for picks that must never change, like a stand-in portrait.
  E.hash = (s) => {
    let h = 0x811c9dc5;
    for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  // A file inside a world folder: relative, no "..", no URL, an image type.
  E.isImagePath = (p) => typeof p === 'string' && /^[\w][\w ./-]*\.(png|jpe?g|webp|gif|svg)$/i.test(p) && !p.split('/').includes('..');

  E.shorten = (s, n) => {
    const t = String(s == null ? '' : s).trim();
    if (t.length <= n) return t;
    const cut = t.slice(0, n - 1);
    const sp = cut.lastIndexOf(' ');
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '') + '…';
  };
  // Prose: cut at the last sentence (or word) that fits, never mid-word
  // (playtest-api: "will trade water fo"; playtest-coffee-skips: "The only spare cartridge is").
  E.clip = (v, n) => {
    const t = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end > n * 0.5 ? cut.slice(0, end + 1) : E.shorten(t, n);
  };
  E.estTokens = (s) => Math.ceil((s || '').length / 3.6);
  E.rng = Math.random;

  E.needWord = (v) => (v < 0.3 ? 'low' : v < 0.6 ? 'moderate' : v < 0.85 ? 'high' : 'critical');
  E.relWord = (v) =>
    v >= 50 ? 'trusts' : v >= 15 ? 'friendly' : v > -15 ? 'neutral' : v > -50 ? 'wary' : 'hostile';
  E.healthWord = (h) => ({ ok: 'unhurt', hurt: 'hurt', badly_hurt: 'badly hurt', dead: 'dead' }[h] || h);

  // A world with a real calendar (task 7-1, `calendar: {day1: "1939-09-01"}`)
  // names its days as dates; any other names them "Day 12" ("Sol 214").
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // A "YYYY-MM-DD" date in milliseconds (UTC), or null when it isn't a real date.
  const utcDate = (ymd) => {
    const m = typeof ymd === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
  };
  E.calendarDay1 = (cal) => utcDate(cal && cal.day1);
  // A day number's date: { y, m (1–12), d, weekday }, or null without a calendar.
  E.dateOfDay = function (sc, day) {
    const t0 = E.calendarDay1(sc && sc.calendar);
    if (t0 == null) return null;
    const d = new Date(t0 + (Math.floor(day) - 1) * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), weekday: WEEKDAYS[d.getUTCDay()] };
  };
  // The day number of "YYYY-MM-DD" on the world's calendar, or null.
  E.dayOfDate = function (sc, ymd) {
    const t0 = E.calendarDay1(sc && sc.calendar), t = utcDate(ymd);
    return t0 == null || t == null ? null : Math.round((t - t0) / 86400000) + 1;
  };
  // "Thursday 16 April 1942", or "Day 12".
  E.dayName = function (sc, day) {
    const g = E.dateOfDay(sc, day);
    return g ? `${g.weekday} ${g.d} ${MONTHS[g.m - 1]} ${g.y}` : `${(sc && sc.timeLabel) || 'Day'} ${day}`;
  };
  E.fmtTime = function (state) {
    const mins = Math.round(state.time.hour * 60);
    const hh = String(Math.floor(mins / 60) % 24).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    return `${E.dayName(state.scenario, state.time.day)}, ${hh}:${mm}`;
  };

  E.esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Time steps the player can choose per action. "nextMorning" is computed.
  E.timeSteps = [
    // One exchange of a conversation, so a long talk doesn't eat the evening
    // a few minutes at a time.
    { id: 'minute', label: 'A minute', hours: 1 / 60, words: '40–90', lengthMult: 1 },
    // 0.7 cut nearly every moment scene off on the 12B (playtest-albee-promoted).
    { id: 'moment', label: 'A few minutes', hours: 0.25, words: '60–120', lengthMult: 1.1 },
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
