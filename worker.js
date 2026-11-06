// Hardin Games — Cloudflare Worker
// Routes:
//   POST /tts       { text }                         -> audio/mpeg in your cloned voice (ElevenLabs)
//   POST /question  { count, topic, family, avoid }  -> { questions: [{ text, answer, decoys }] } (Claude)
//
// Secrets / vars (wrangler secret put ...):
//   ELEVENLABS_API_KEY, ELEVEN_VOICE_ID, ANTHROPIC_API_KEY, ADMIN_PIN (4-digit admin code), YOUTUBE_API_KEY (Mic Drop song search)
//   ALLOWED_ORIGINS  e.g. "https://ech-technicalsolutions.com"
//   ELEVEN_MODEL (optional, default eleven_multilingual_v2), CLAUDE_MODEL (optional), FAKES_MODEL (optional)
//
// Test in Safari (no setup needed):
//   GET /       -> {"ok":true,...} plus which secrets are set
//   GET /tts    -> plays a short fixed test line in your voice, or shows the exact error

export default {
  async fetch(req, rawEnv, ctx) {
    // Ignore stray spaces / line breaks pasted into secrets
    const env = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    const path = new URL(req.url).pathname;
    const origin = (req.headers.get('Origin') || '').replace(/\/$/, '');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
    // Typing the Worker URL into Safari sends no Origin: allow the health check and the fixed test line
    const browserTest = req.method === 'GET' && !origin && (path === '/' || path === '/tts');
    const okOrigin = !allowed.length || allowed.includes(origin) || browserTest;
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!okOrigin) return new Response('Forbidden', { status: 403, headers: cors });
    try {
      if (path === '/tts' && req.method === 'POST') { const { text } = await req.json(); return await tts(text, env, ctx, cors); }
      if (path === '/tts' && req.method === 'GET') return await tts('Testing, testing. This is Hardin Games!', env, ctx, cors);
      if (path === '/question' && req.method === 'POST') return await question(req, env, cors);
      if (path === '/admin' && req.method === 'POST') return await admin(req, env, cors);
      if (path === '/fakes' && req.method === 'POST') return await fakes(req, env, cors);
      if (path === '/trivia' && req.method === 'POST') return await trivia(req, env, cors);
      if (path === '/prompts' && req.method === 'POST') return await prompts(req, env, cors);
      if (path === '/yt' && req.method === 'POST') { const { q = '', family = false } = await req.json(); return json({ results: await ytSearch(String(q).slice(0, 120), family, env) }, cors); }
      if (path === '/surprise' && req.method === 'POST') return await surprise(req, env, cors);
      return json({ ok: true, name: 'Hardin Games worker', voiceKey: !!env.ELEVENLABS_API_KEY, voiceId: !!env.ELEVEN_VOICE_ID, aiKey: !!env.ANTHROPIC_API_KEY, originLock: allowed.length > 0, adminPin: !!env.ADMIN_PIN, youtubeKey: !!env.YOUTUBE_API_KEY }, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, cors, 500);
    }
  }
};

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function tts(text, env, ctx, cors) {
  if (!text || typeof text !== 'string' || text.length > 800) return json({ error: 'bad text' }, cors, 400);
  if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY is not set in Cloudflare' }, cors, 500);
  if (!env.ELEVEN_VOICE_ID) return json({ error: 'ELEVEN_VOICE_ID is not set in Cloudflare' }, cors, 500);
  const model = env.ELEVEN_MODEL || 'eleven_multilingual_v2';
  const key = new Request(`https://tts-cache.hardin/${env.ELEVEN_VOICE_ID}/${model}/${await sha(text)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVEN_VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.3 } })
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 400);
    let detail = body; try { const d = JSON.parse(body).detail; detail = typeof d === 'string' ? d : (d && (d.message || d.status)) || body; } catch (e) {}
    console.error('ElevenLabs error', r.status, body);
    return json({ error: `ElevenLabs ${r.status}: ${detail}` }, cors, 502);
  }
  const audio = await r.arrayBuffer();
  ctx.waitUntil(cache.put(key, new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=2592000' } })));
  return new Response(audio, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
}

async function question(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { count = 1, topic = '', family = false, avoid = [] } = await req.json();
  const n = Math.min(Math.max(1, count | 0), 10);
  const prompt = `Write ${n} fill-in-the-blank trivia prompts for a family party game where players invent fake answers to fool each other.

Rules:
- Each prompt states a surprising but TRUE, well-documented fact, with exactly one blank written as "_____".
- The real answer is 1-4 words and hard to guess, so fake answers can compete with it.
- Give 2 decoys: plausible-sounding answers that are definitely FALSE.
- ${family ? 'Family friendly, fine for kids 8 and up.' : 'Keep it PG-13.'}
- ${topic ? `Topic: ${topic}.` : 'Mix of topics: history, animals, food, science, pop culture, places.'}
${avoid.length ? `- Do not repeat these facts:\n${avoid.slice(0, 25).map(t => '  * ' + t).join('\n')}` : ''}

Respond with only JSON, no other text:
{"questions":[{"text":"...","answer":"...","decoys":["...","..."]}]}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) { console.error('Anthropic error', r.status, JSON.stringify(j).slice(0, 300)); return json({ error: (j.error && j.error.message) || `HTTP ${r.status}` }, cors, 502); }
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: 'No JSON in reply' }, cors, 502);
  const data = JSON.parse(m[0]);
  const questions = (data.questions || [])
    .filter(q => q && /_{3,}/.test(q.text || '') && q.answer)
    .map(q => ({ text: q.text, answer: String(q.answer), decoys: (q.decoys || []).map(String).slice(0, 3) }));
  return json({ questions }, cors);
}

// ---- Admin lock ----
// POST /admin {pin}   -> {ok, token} (token good for 30 days on that device)
// POST /admin {token} -> {ok} if still valid. Changing ADMIN_PIN signs everyone out.
const DAY = 24 * 3600 * 1000;
async function sign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('hg-admin:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function admin(req, env, cors) {
  if (!env.ADMIN_PIN) return json({ ok: true, open: true }, cors);
  let body = {}; try { body = await req.json(); } catch (e) {}
  if (typeof body.token === 'string' && body.token.includes('.')) {
    const [exp, sig] = body.token.split('.');
    if (Number(exp) > Date.now() && same(sig, await sign(env.ADMIN_PIN, exp))) return json({ ok: true }, cors);
    return json({ ok: false, error: 'Signed out' }, cors, 401);
  }
  if (typeof body.pin === 'string' && same(body.pin, String(env.ADMIN_PIN))) {
    const exp = String(Date.now() + 30 * DAY);
    return json({ ok: true, token: exp + '.' + await sign(env.ADMIN_PIN, exp) }, cors);
  }
  if (body.pin) await new Promise(r => setTimeout(r, 1000));   // slow down guessing
  return json({ ok: false, error: 'Wrong code' }, cors, 401);
}

// ---- "Lie for me": believable wrong answers for one question ----
async function fakes(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { question = '', answer = '', count = 8, family = false } = await req.json();
  if (!question || !answer || question.length > 300 || answer.length > 80) return json({ error: 'bad question' }, cors, 400);
  const n = Math.min(Math.max(3, count | 0), 12);
  const prompt = `In the party game "Fibs", players invent fake answers to a fill-in-the-blank fact, hoping others pick their lie instead of the truth.

Fact: "${question}"
Real answer: "${answer}"

Write ${n} fake answers for the blank that could fool people:
- Same kind of thing as the real answer (a number becomes other numbers in the same units, a name becomes similar names, an object becomes similar objects)
- Similar length to the real answer (1-4 words), and each must fit the sentence
- Definitely FALSE, all different from each other and from the real answer
- Mostly believable; one or two can be a little playful
- ${family ? 'Family friendly.' : 'Keep it PG-13.'}

Respond with only JSON, no other text: {"fakes":["...","..."]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.FAKES_MODEL || 'claude-haiku-5-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) { console.error('Anthropic error (fakes)', r.status, JSON.stringify(j).slice(0, 300)); return json({ error: (j.error && j.error.message) || `HTTP ${r.status}` }, cors, 502); }
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  let list = [];
  try { list = (JSON.parse(m ? m[0] : '{}').fakes || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 12); } catch (e) {}
  return json({ fakes: list }, cors);
}

// ---- Smarty Pants: trivia questions for one category ----
async function trivia(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { category = '', count = 5, numbers = 1, family = false, hard = false, avoid = [] } = await req.json();
  if (!category || category.length > 60) return json({ error: 'bad category' }, cors, 400);
  const n = Math.min(Math.max(1, count | 0), 10), nn = Math.min(Math.max(0, numbers | 0), n), mc = n - nn;
  const prompt = `Write trivia questions about "${category}" for a family party game played on phones.

Write ${mc} multiple-choice question(s)${nn ? ` and ${nn} "closest number" question(s)` : ''}.
- Multiple choice: one correct answer and 3 wrong answers that sound believable. Choices under 40 characters.
${nn ? '- Closest number: the answer is a single, widely cited number, such as a year, a count, or a measurement in US units (feet, miles, pounds, degrees Fahrenheit). Never metric. Never something that changes over time.\n' : ''}- Only use facts you are certain are true and well documented. No trick questions, no "as of" facts, no records that keep changing, nothing disputed.
- ${hard ? 'This is the final question: make it medium-hard.' : 'Mix easy and medium.'} Questions under 120 characters.
- ${family ? 'Family friendly, fine for kids 8 and up.' : 'Keep it PG-13.'}
${avoid.length ? `- Don't repeat any of these:\n${avoid.slice(0, 60).map(t => '  * ' + String(t).slice(0, 140)).join('\n')}` : ''}

Respond with only JSON, no other text:
{"questions":[{"type":"mc","q":"...","correct":"...","wrong":["...","...","..."]}${nn ? ',{"type":"num","q":"...","answer":1969,"unit":"year"}' : ''}]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) { console.error('Anthropic error (trivia)', r.status, JSON.stringify(j).slice(0, 300)); return json({ error: (j.error && j.error.message) || `HTTP ${r.status}` }, cors, 502); }
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  let qs = [];
  try { qs = (JSON.parse(m ? m[0] : '{}').questions || []).slice(0, 12); } catch (e) { return json({ error: 'AI reply was not valid JSON' }, cors, 502); }
  return json({ questions: qs }, cors);
}

// ---- Doodle Duel: silly drawing prompts ----
async function prompts(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { count = 20, family = false, avoid = [] } = await req.json();
  const n = Math.min(Math.max(5, count | 0), 40);
  const prompt = `Write ${n} funny drawing prompts for a party game. Players draw the prompt with a finger on a phone in 60 seconds, then everyone else tries to guess the real title.

- 2 to 6 words each, like "a nervous hot dog", "grandma riding a shark", "a cactus at the beach"
- Easy to sketch, with a silly twist: mix animals, food, everyday objects, jobs, places, and feelings
- No real people, no brands, no characters from movies, TV, books, or games
- ${family ? 'Family friendly, fine for kids 8 and up.' : 'Keep it PG-13.'}
${avoid.length ? `- Don't reuse any of these:\n${avoid.slice(0, 40).map(t => '  * ' + String(t).slice(0, 60)).join('\n')}` : ''}

Respond with only JSON, no other text: {"prompts":["...","..."]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.FAKES_MODEL || 'claude-haiku-5-5', max_tokens: 900, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) { console.error('Anthropic error (prompts)', r.status, JSON.stringify(j).slice(0, 300)); return json({ error: (j.error && j.error.message) || `HTTP ${r.status}` }, cors, 502); }
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  let list = [];
  try { list = (JSON.parse(m ? m[0] : '{}').prompts || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 40); } catch (e) {}
  return json({ prompts: list }, cors);
}

// ---- Mic Drop: karaoke video search (YouTube Data API) ----
const unent = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function ytSearch(q, family, env) {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set in Cloudflare');
  if (!q) return [];
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '8', videoEmbeddable: 'true', safeSearch: family ? 'strict' : 'moderate', q, key: env.YOUTUBE_API_KEY }).toString();
  const r = await fetch(u.toString());
  const j = await r.json();
  if (!r.ok) { console.error('YouTube error', r.status, JSON.stringify(j).slice(0, 300)); throw new Error((j.error && j.error.message) || `YouTube ${r.status}`); }
  return (j.items || []).filter(x => x.id && x.id.videoId).map(x => ({ id: x.id.videoId, title: unent(x.snippet.title), channel: unent(x.snippet.channelTitle) }));
}
async function surprise(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { family = false, avoid = [] } = await req.json();
  const prompt = `Suggest ONE well-known, fun sing-along song for family karaoke night that most people know the words to.
- ${family ? 'Clean and kid-friendly.' : 'Keep it PG-13.'}
- Pick something different from: ${avoid.slice(0, 30).map(t => String(t).slice(0, 80)).join('; ') || 'nothing yet'}
Respond with only JSON, no other text: {"title":"...","artist":"..."}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.FAKES_MODEL || 'claude-haiku-5-5', max_tokens: 120, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) return json({ error: (j.error && j.error.message) || `HTTP ${r.status}` }, cors, 502);
  const m = ((j.content || []).map(c => c.text || '').join('')).match(/\{[\s\S]*\}/);
  let song = null; try { song = JSON.parse(m ? m[0] : '{}'); } catch (e) {}
  if (!song || !song.title) return json({ error: 'No song suggestion' }, cors, 502);
  song = { title: String(song.title).slice(0, 80), artist: String(song.artist || '').slice(0, 60) };
  try { return json({ song, results: await ytSearch(`${song.title} ${song.artist} karaoke`, family, env) }, cors); }
  catch (e) { return json({ error: e.message, song }, cors, 500); }
}
