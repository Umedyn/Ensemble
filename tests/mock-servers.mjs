// Fake model servers for UI tests and manual poking:
//   KoboldCpp-style on :5001 (no key), OpenAI-style API on :5002 (key "sk-test", model "test/story-70b").
// Run standalone with `node tests/mock-servers.mjs`, then point Settings at them.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import genMock from './genmock.js';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
  res.end(JSON.stringify(obj));
};
// Real servers report token usage; the counts here are rough but stable.
const reply = (res, content, prompt) => json(res, 200, {
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil((prompt.length + content.length) / 4) },
});

// Streamed replies (task L-2): server-sent events, a few words a chunk, so a
// soft stop lands mid-stream. A stream ends early when its genkey is aborted
// (KoboldCpp's /api/extra/abort) or the client hangs up; both are logged.
const streams = new Map(); // genkey → { aborted }
function streamReply(res, content, prompt, genkey) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
  const parts = content.match(/\S+\s*/g) || [];
  const me = { aborted: false };
  if (genkey) streams.set(genkey, me);
  let i = 0, gone = false;
  res.on('close', () => { if (i < parts.length && !me.aborted) { gone = true; handler.log.push({ disconnected: genkey || true }); } });
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  const tick = () => {
    if (gone || me.aborted) return res.end();
    if (i >= parts.length) {
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(content.length / 4) } });
      res.write('data: [DONE]\n\n');
      streams.delete(genkey);
      return res.end();
    }
    send({ choices: [{ delta: { content: parts.slice(i, i + 3).join('') }, finish_reason: null }] });
    i += 3;
    setTimeout(tick, 4);
  };
  tick();
}

// A scene that runs on past what it was asked for: six beats for an hour.
const LONG_SCENE = [
  '[+0m] You sit Teo down by the recycler and ask him to tell you everything, from the first rattle to this morning. He rubs his hands on his knees and starts slowly.',
  '[+10m] "It began three sols ago," he says. "A tick, then a knock, then the rattle. I logged it as a sensor fault because that is what it sounded like."',
  '[+25m] Okafor leans in the hatch, listening. She says nothing, but her eyes stay on Teo, and he talks faster while she is there.',
  '[+40m] Teo shows you the log on his tablet. Two entries are missing from the night shift, and he swears he never touched them.',
  '[+50m] Priya calls from hydroponics: the pressure in her racks dropped at the same minute the entries vanished.',
  '[+70m] The rattle starts again behind the panel, louder now, and Teo goes pale.',
].join('\n\n');

// Answers each pipeline step with plausible content, based on the prompt text.
function answer(user) {
  // Generated starts (task 4-2): the shared replies for Holdout at Harmon's.
  const genStep = genMock.stepOf(user);
  if (genStep) {
    const v = genMock.replies()[genStep];
    return JSON.stringify(typeof v === 'function' ? v(user) : v);
  }
  // Projected timeline events (task 5-2): one, a day out.
  if (user.includes('=== PLANNING AHEAD:')) {
    const m = /"when":\{"day":(\d+)/.exec(user);
    return JSON.stringify({ events: [{ when: { day: m ? Number(m[1]) : 2, hour: 10 }, scope: 'world', region: null, text: 'Mission Control schedules a routine systems check across every module.', visibility: 'heard', effects: null }] });
  }
  // Character card import (task 6-2): one line written to the player, which the engine leaves out.
  if (user.includes('=== A CHARACTER CARD ===')) {
    return JSON.stringify({ pronouns: 'she/her', age: 34, role: 'keeps the old harbor light', traits: ['dry', 'patient', 'honest'], want: 'keep the light burning whatever happens',
      voice: 'Few words, all of them true.', appearance: 'Wiry and sunburnt, with salt-stiff hair.', description: 'Juniper has kept the light for ten years and logs every ship in a ledger. She pulled you out of the surf.',
      secret: null, guard: 'medium', skills: { tech: 2, science: 1, athletics: 2, social: 1 } });
  }
  if (user.includes('=== MAKING A CHARACTER ===')) {
    if (user.includes('personality traits')) return JSON.stringify({ traits: ['sharp-eyed', 'restless', 'loyal'] });
    if (user.includes('how this character talks')) return JSON.stringify({ voice: 'Quick and wry, trails off when nervous.' });
    return JSON.stringify({ description: 'Came up on the supply rotation two years ago and never quite left.' });
  }
  if (user.includes('=== DOWNTIME:')) {
    return JSON.stringify({ montage: [{ after: '2d', text: 'The crew settles into routines.' }], events: [], major_event: null,
      positions: [{ id: 'raman', where: 'commons', doing: 'dealing cards' }], player_where: 'commons' });
  }
  if (user.includes('=== DOWNTIME FRAME ===')) {
    return '[+0d] The days settle into a rhythm of fans and checklists.\n\n[+2d] Priya teaches everyone a card game with rules she keeps changing.\n\n[+3d] The alarm cuts through the commons. Priya drops her cards. "Tell me that is a sensor fault."';
  }
  // The intent in parts (task L-3): each part of the same reply.
  const intentPart = /Judge only [^\n]*'s action/.test(user) ? 'player' : user.includes('=== WHAT THE PEOPLE HERE DO THIS SPAN ===') ? 'events' : /\n=== WHAT [^\n]* IS DOING ===\n/.test(user) ? 'chars' : null;
  if (user.includes('Judge the player') || intentPart) {
    const out = { player: { summary: 'inspect the recycler', needs_roll: true, skill: 'tech', difficulty: 'normal', move_to: null },
      intents: [{ id: 'bauer', action: 'hovers nervously near the log panel', says: 'Probably just a sensor issue.', visible: true },
        { id: 'okafor', action: 'heads to Ops to draft a storm plan', visible: true, move_to: 'ops' }], events: [] };
    // Generated sites (task 4-4): heading for the pharmacy asks for a new place.
    // Task 6-3: a site map drawn in the creator fits a tavern.
    if (/=== PLAYER ACTION[^\n]*\n"[^"\n]*tavern/i.test(user)) Object.assign(out.player, { summary: 'go to the tavern', needs_roll: false, move_to: null, new_place: { name: 'the tavern', kind: 'tavern', region: 'main-street' } });
    // Task R-10: Ridge is 45 minutes down the road from the holdout.
    if (/=== PLAYER ACTION[^\n]*\n"[^"\n]*drive to Ridge/i.test(user)) Object.assign(out.player, { summary: 'drive to Ridge', needs_roll: false, move_to: null, new_place: { name: 'Ridge', kind: 'town', region: 'ridge-town' } });
    if (/=== PLAYER ACTION[^\n]*\n"[^"\n]*pharmacy/i.test(user)) Object.assign(out.player, { summary: 'go to the pharmacy', needs_roll: false, move_to: null, new_place: { name: 'the pharmacy', kind: 'pharmacy', region: 'main-street' } });
    if (user.includes('WORLD event is due')) out.events.push({ text: 'Halvorsen Aerospace announces emergency cost cuts.', scope: 'world', visibility: 'heard',
      effects: { groups: [{ id: 'sponsor', stance: 'cutting costs; reviewing every crewed mission' }], new_clock: { name: 'Funding review', max: 8, perHour: 0.1, fireText: 'The board votes.' } } });
    if (intentPart === 'player') return JSON.stringify({ player: out.player });
    if (intentPart === 'chars') return JSON.stringify({ intents: out.intents });
    if (intentPart === 'events') return JSON.stringify({ events: out.events });
    return JSON.stringify(out);
  }
  if (user.includes('Write the next scene')) {
    if (/=== PLAYER ACTION[^\n]*\n"[^"\n]*tell me everything/i.test(user)) return LONG_SCENE;
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
  // The update in parts (task L-3): "Record the facts…", "Record what changed
  // this turn in people's state…", "Record how feelings changed…".
  const updatePart = /\nRecord the facts this turn/.test(user) ? ['facts'] : /\nRecord what changed this turn in people's state/.test(user) ? ['state'] : /\nRecord how feelings changed/.test(user) ? ['relations', 'player_attitude'] : null;
  if (user.includes('Record what changed') || updatePart) {
    const all = {
      facts: [{ about: ['bauer'], text: 'Teo blamed the rattle on a sensor issue.', known_by: ['navarro', 'bauer'], weight: 1 }],
      state: [{ target: 'char:bauer', field: 'mood', value: 'jumpy, talking too fast', reason: 'the rattle questions' },
        { target: 'char:bauer', field: 'add_tag', value: 'grease on his sleeves', turns: 6, reason: 'handled the spanner' }],
      relations: [{ from: 'bauer', to: 'navarro', delta: -2, reason: 'nervous' }], player_attitude: [] };
    return JSON.stringify(updatePart ? Object.fromEntries(updatePart.map((k) => [k, all[k]])) : all);
  }
  return JSON.stringify({ title: 'The Rattle', summary: 'Kit looked into the failing recycler while Teo hovered nervously.' });
}

function handler(requireKey) {
  return (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 200, {});
    const authed = !requireKey || req.headers.authorization === 'Bearer sk-test';
    const url = req.url;
    if (req.method === 'POST' && !requireKey && url.endsWith('/api/extra/abort')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const key = (JSON.parse(body || '{}').genkey) || '';
        const s = streams.get(key);
        if (s) s.aborted = true;
        handler.log.push({ abort: key, running: !!s });
        json(res, 200, { success: s ? 'true' : 'false', done: 'true' });
      });
      return;
    }
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
      handler.log.push({ port: requireKey ? 5002 : 5001, model: b.model, user: b.messages[1].content, grammar: !!b.grammar, jsonMode: !!b.response_format, stream: !!b.stream });
      const content = answer(b.messages[1].content), prompt = b.messages[0].content + b.messages[1].content;
      if (b.stream) return streamReply(res, content, prompt, b.genkey);
      reply(res, content, prompt);
    });
  };
}
handler.log = [];

// ports: { kobold, api } (default 5001 and 5002); 0 picks a free one, and the
// result says which (npm test uses free ones, so a running KoboldCpp is fine).
export async function startMocks(ports = {}) {
  const kobold = http.createServer(handler(false));
  const api = http.createServer(handler(true));
  // A real KoboldCpp left running on 5001 would answer the tests instead (and
  // time every check out), so a busy port stops with a clear message.
  const busy = (port, what) => new Error(`Port ${port} is already in use (${what}). Close whatever is using it, such as a running KoboldCpp, and run the UI tests again.`);
  // On Windows a program already listening on 5001 doesn't stop Node
  // listening there too, and the browser's "localhost" then reaches that
  // program instead (2026-10-22: a real KoboldCpp timed out 21 checks). So
  // first see whether anything answers on the port.
  const probe = (port, what) => new Promise((resolve, reject) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); reject(busy(port, what)); });
    s.once('timeout', () => { s.destroy(); resolve(); });
    s.once('error', () => resolve());
  });
  const listen = async (server, port, what) => {
    if (port) await probe(port, what);
    await new Promise((resolve, reject) => {
      server.once('error', (err) => reject(err.code === 'EADDRINUSE' ? busy(port, what) : err));
      server.listen(port, resolve);
    });
  };
  await listen(kobold, ports.kobold ?? 5001, 'the fake KoboldCpp needs it');
  await listen(api, ports.api ?? 5002, 'the fake API needs it');
  return { log: handler.log, ports: { kobold: kobold.address().port, api: api.address().port }, close: () => { kobold.close(); api.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMocks().then(() => console.log('Mock KoboldCpp on :5001, mock API on :5002 (key sk-test, model test/story-70b)'));
}
