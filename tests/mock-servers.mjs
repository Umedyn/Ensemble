// Fake model servers for UI tests and manual poking:
//   KoboldCpp-style on :5001 (no key), OpenAI-style API on :5002 (key "sk-test", model "test/story-70b").
// Run standalone with `node tests/mock-servers.mjs`, then point Settings at them.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
  res.end(JSON.stringify(obj));
};
// Real servers report token usage; the counts here are rough but stable.
const reply = (res, content, prompt) => json(res, 200, {
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil((prompt.length + content.length) / 4) },
});

// Answers each pipeline step with plausible content, based on the prompt text.
function answer(user) {
  if (user.includes('=== DOWNTIME:')) {
    return JSON.stringify({ montage: [{ after: '2d', text: 'The crew settles into routines.' }], events: [], major_event: null,
      positions: [{ id: 'raman', where: 'commons', doing: 'dealing cards' }], player_where: 'commons' });
  }
  if (user.includes('=== DOWNTIME FRAME ===')) {
    return '[+0d] The days settle into a rhythm of fans and checklists.\n\n[+2d] Priya teaches everyone a card game with rules she keeps changing.\n\n[+3d] The alarm cuts through the commons. Priya drops her cards. "Tell me that is a sensor fault."';
  }
  if (user.includes('Judge the player')) {
    const out = { player: { summary: 'inspect the recycler', needs_roll: true, skill: 'tech', difficulty: 'normal', move_to: null },
      intents: [{ id: 'bauer', action: 'hovers nervously near the log panel', says: 'Probably just a sensor issue.', visible: true },
        { id: 'okafor', action: 'heads to Ops to draft a storm plan', visible: true, move_to: 'ops' }], events: [] };
    if (user.includes('WORLD event is due')) out.events.push({ text: 'Halvorsen Aerospace announces emergency cost cuts.', scope: 'world', visibility: 'heard',
      effects: { groups: [{ id: 'sponsor', stance: 'cutting costs; reviewing every crewed mission' }], new_clock: { name: 'Funding review', max: 8, perHour: 0.1, fireText: 'The board votes.' } } });
    return JSON.stringify(out);
  }
  if (user.includes('Write the next scene')) {
    return '[+0m] You pry the access panel off the recycler. Teo hovers at your shoulder.\n\n[+30m] Okafor gathers her tablet and heads for Ops.\n\n[+55m] Teo hands you a spanner. "Probably just a sensor issue," he says, a little too fast.';
  }
  if (user.includes(' an agenda: what ')) return JSON.stringify({ routine: true });
  if (user.includes('has come to matter in the story')) {
    return JSON.stringify({ pronouns: 'she/her', age: 52, traits: ['calm', 'precise', 'tired'], want: 'see this crew home on schedule', secret: null,
      voice: 'Measured, never rushed, even fourteen minutes late.', appearance: 'Grey-streaked hair in a clip, headset always on.', skills: {}, relations: {} });
  }
  if (user.includes('things Kit Navarro could do next')) {
    return JSON.stringify({ suggestions: ['Ask Teo when the rattle started.', '1. Check the recycler logs myself.', 'Ask Teo when the rattle started.', 'Tell Okafor about the storm plan.'] });
  }
  if (user.includes('Record what changed')) {
    return JSON.stringify({ facts: [{ about: ['bauer'], text: 'Teo blamed the rattle on a sensor issue.', known_by: ['navarro', 'bauer'], weight: 1 }],
      state: [{ target: 'char:bauer', field: 'mood', value: 'jumpy, talking too fast', reason: 'the rattle questions' },
        { target: 'char:bauer', field: 'add_tag', value: 'grease on his sleeves', turns: 6, reason: 'handled the spanner' }],
      relations: [{ from: 'bauer', to: 'navarro', delta: -2, reason: 'nervous' }], player_attitude: [] });
  }
  return JSON.stringify({ title: 'The Rattle', summary: 'Kit looked into the failing recycler while Teo hovered nervously.' });
}

function handler(requireKey) {
  return (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 200, {});
    const authed = !requireKey || req.headers.authorization === 'Bearer sk-test';
    const url = req.url;
    if (req.method === 'GET') {
      if (!authed) return json(res, 401, { error: { message: 'bad key' } });
      if (url.includes('true_max_context_length')) return json(res, 200, { value: 8192 });
      if (!requireKey && url.includes('/api/extra/perf')) return json(res, 200, { last_process_time: 0.35, last_eval_time: 2.4, last_process_speed: 5200, last_eval_speed: 24 });
      if (url.includes('/api/v1/model')) return json(res, 200, { result: 'koboldcpp/Mock-12B-Q4' });
      if (url.endsWith('/models')) return json(res, 200, { data: [{ id: 'test/story-70b' }] });
      return json(res, 404, {});
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!authed) return json(res, 401, { error: { message: 'bad key' } });
      const b = JSON.parse(body || '{}');
      handler.log.push({ port: requireKey ? 5002 : 5001, model: b.model, user: b.messages[1].content });
      reply(res, answer(b.messages[1].content), b.messages[0].content + b.messages[1].content);
    });
  };
}
handler.log = [];

export async function startMocks() {
  const kobold = http.createServer(handler(false));
  const api = http.createServer(handler(true));
  // A real KoboldCpp left running on 5001 would answer the tests instead (and
  // time every check out), so a busy port stops with a clear message.
  const listen = (server, port, what) => new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use (${what}). Close whatever is using it, such as a running KoboldCpp, and run the UI tests again.`)
      : err));
    server.listen(port, resolve);
  });
  await listen(kobold, 5001, 'the fake KoboldCpp needs it');
  await listen(api, 5002, 'the fake API needs it');
  return { log: handler.log, close: () => { kobold.close(); api.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMocks().then(() => console.log('Mock KoboldCpp on :5001, mock API on :5002 (key sk-test, model test/story-70b)'));
}
