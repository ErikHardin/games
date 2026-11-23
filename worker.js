// Hardin Games — Cloudflare Worker
// Routes:
//   POST /tts       { text }                         -> audio/mpeg in your cloned voice (ElevenLabs)
//   POST /question  { count, topic, family, avoid }  -> { questions: [{ text, answer, decoys }] } (Claude)
//   POST /song      { title, artist, family }        -> { id, dur, title, channel } (Earworm: the real song on YouTube, with its length)
//   POST /songs     { theme, count, family, avoid }  -> { songs: [{ title, artist, decoys: [{ title, artist }] }] } (Earworm: AI song lists)
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
      if (path === '/tts' && req.method === 'POST') { const { text, take = 0, steady = false } = await req.json(); return await tts(text, env, ctx, cors, take | 0, !!steady); }
      if (path === '/tts' && req.method === 'GET') return await tts('Testing, testing. This is Hardin Games!', env, ctx, cors);
      if (path === '/question' && req.method === 'POST') return await question(req, env, cors);
      if (path === '/admin' && req.method === 'POST') return await admin(req, env, cors);
      if (path === '/usage' && req.method === 'POST') return await usage(req, env, cors);
      if (path === '/quips' && req.method === 'POST') return await quips(req, env, cors);
      if (path === '/fakes' && req.method === 'POST') return await fakes(req, env, cors);
      if (path === '/trivia' && req.method === 'POST') return await trivia(req, env, cors);
      if (path === '/prompts' && req.method === 'POST') return await prompts(req, env, cors);
      if (path === '/yt' && req.method === 'POST') { const { q = '', family = false, trusted = false, channels } = await req.json(); return json({ results: await ytSearch(String(q).slice(0, 120), family, env, channels || trusted) }, cors); }
      if (path === '/surprise' && req.method === 'POST') return await surprise(req, env, cors);
      if (path === '/song' && req.method === 'POST') return await songVideo(req, env, cors);
      if (path === '/songs' && req.method === 'POST') return await songIdeas(req, env, cors);
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

async function tts(text, env, ctx, cors, take = 0, steady = false) {
  if (!text || typeof text !== 'string' || text.length > 800) return json({ error: 'bad text' }, cors, 400);
  if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY is not set in Cloudflare' }, cors, 500);
  if (!env.ELEVEN_VOICE_ID) return json({ error: 'ELEVEN_VOICE_ID is not set in Cloudflare' }, cors, 500);
  const model = env.ELEVEN_MODEL || 'eleven_multilingual_v2';
  const key = new Request(`https://tts-cache.hardin/${env.ELEVEN_VOICE_ID}/${model}/${await sha(text)}${take ? `/t${take}${steady ? 's' : ''}` : ''}`);   // a new take = a fresh recording
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVEN_VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, voice_settings: steady ? { stability: 0.7, similarity_boost: 0.85, style: 0.1 } : { stability: 0.45, similarity_boost: 0.85, style: 0.3 } })
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
- The real answer is WORDS: a name, thing, place, word or phrase. Never a number, year, date, amount, measurement or percentage. Decoys follow the same rule.
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

async function tokenOk(env, token) {
  if (!env.ADMIN_PIN) return true;
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [exp, sig] = token.split('.'); return Number(exp) > Date.now() && same(sig, await sign(env.ADMIN_PIN, exp));
}
// ---- Admin: ElevenLabs credits used this month (key needs User -> Read) ----
async function usage(req, env, cors) {
  let body = {}; try { body = await req.json(); } catch (e) {}
  if (!(await tokenOk(env, body.token))) return json({ error: 'Signed out' }, cors, 401);
  if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY is not set in Cloudflare' }, cors, 500);
  const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: r.status === 401 ? 'The ElevenLabs key needs the User → Read permission' : ((j.detail && (j.detail.message || j.detail.status)) || `ElevenLabs ${r.status}`) }, cors, 502);
  return json({ used: j.character_count, limit: j.character_limit, reset: j.next_character_count_reset_unix, tier: j.tier }, cors);
}
// ---- Fibs chatty host: a short joke for each lie and the truth, written while people vote ----
async function quips(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { question = '', truth = '', lies = [], family = false } = await req.json();
  if (!question || !truth || question.length > 300 || !Array.isArray(lies) || lies.length > 12) return json({ error: 'bad request' }, cors, 400);
  const list = lies.map((l, i) => `${i + 1}. "${String(l.text).slice(0, 80)}"${l.by ? ` (written by ${String(l.by).slice(0, 20)})` : ' (a fake the game made up)'}`).join('\n');
  const prompt = `You're the playful host of a family party game like Fibbage. Players invented fake answers to a fill-in-the-blank fact, then everyone voted on which answer was true.

Fact: ${question.slice(0, 300)}
Real answer: ${truth.slice(0, 80)}
Fake answers:
${list}

Write one short, funny host comment (under 14 words) for EACH fake answer, and one for the real answer.
- Playful teasing is fine; never mean, never about anyone's looks, age or intelligence. ${family ? 'Clean enough for kids.' : 'PG-13 at most.'}
- You may use the writer's first name. Don't mention who voted for it (you don't know yet).
- Make them varied: puns, mock outrage, fake admiration, a silly observation. No emoji, no hashtags.
- For the real answer, react to how surprising or funny the true fact is.

Respond with only JSON, no other text: {"lies":["comment for 1","comment for 2"],"truth":"comment for the real answer"}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.FAKES_MODEL || 'claude-haiku-5-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: (j.error && j.error.message) || `HTTP ${r.status}` }, cors, 502);
  const txt = (j.content || []).map(c => c.text || '').join('').replace(/```(json)?/g, '');
  const m = txt.match(/\{[\s\S]*\}/); let o = {}; try { o = JSON.parse(m ? m[0] : '{}'); } catch (e) {}
  const clean = s => String(s || '').replace(/[\u{1F000}-\u{1FFFF}]/gu, '').trim().slice(0, 120);
  return json({ lies: (o.lies || []).slice(0, lies.length).map(clean), truth: clean(o.truth) }, cors);
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
  const { count = 20, family = false, avoid = [], kind = 'draw' } = await req.json();
  const n = Math.min(Math.max(5, count | 0), 40);
  const prompt = kind === 'who' ? `Write ${n} questions for a family party game called "Who Said It?". Everyone answers the same question about themselves on their phone, then the group guesses who wrote each answer.

- Questions about the player's own life, habits, tastes, memories, and opinions, like "What's the worst job you've ever had?", "What's your most useless talent?", "What would your last meal be?"
- Fun to answer in a few words, and the answers should be revealing or funny
- Works for adults and teens; nothing too personal, sad, romantic, or about money, health, politics, or religion
- ${family ? 'Family friendly, fine for kids 10 and up.' : 'Keep it PG-13.'}
- Each one ends with a question mark and is under 80 characters
${avoid.length ? `- Don't reuse any of these:\n${avoid.slice(0, 40).map(t => '  * ' + String(t).slice(0, 90)).join('\n')}` : ''}

Respond with only JSON, no other text: {"prompts":["...","..."]}` : `Write ${n} funny drawing prompts for a party game. Players draw the prompt with a finger on a phone in 60 seconds, then everyone else tries to guess the real title.

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
// Karaoke channels that reliably have backing tracks with on-screen lyrics
const GOOD_CHANNELS = /sing king|karafun|stingray karaoke|party tyme|zoom karaoke|karaoke version|sunfly|singsong|karaoke hits|lugn|bandaid|global karaoke|songjam|pro sound karaoke/i;
function karaokeScore(x) {
  const t = (x.title || '').toLowerCase(), c = x.channel || '';
  let s = 0;
  if (/karaoke/.test(t)) s += 4;
  if (/instrumental|backing track|sing ?along|with lyrics/.test(t)) s += 1;
  if (GOOD_CHANNELS.test(c)) s += 6;
  if (/karaoke/i.test(c)) s += 2;
  if (/\blyrics?\b/.test(t) && !/karaoke/.test(t)) s -= 4;   // lyric videos usually still have the original vocals
  if (/\b(cover|live|reaction|tutorial|lesson|how to|official (music )?video|remix|piano|guitar|8d|slowed|sped up)\b/.test(t)) s -= 5;
  return s;
}
/* Zoom Karaoke has a consistent layout and allows its videos to play in other sites (Sing King blocks that) */
const TRUSTED = /^zoom karaoke( official)?$/i;
let SK_ID = null;
async function ytRaw(q, family, env, max, channelId) {
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  const p = { part: 'snippet', type: 'video', maxResults: String(max), videoEmbeddable: 'true', safeSearch: family ? 'strict' : 'moderate', q, key: env.YOUTUBE_API_KEY };
  if (channelId) p.channelId = channelId;
  u.search = new URLSearchParams(p).toString();
  const r = await fetch(u.toString());
  const j = await r.json();
  if (!r.ok) { console.error('YouTube error', r.status, JSON.stringify(j).slice(0, 300)); throw new Error((j.error && j.error.message) || `YouTube ${r.status}`); }
  const items = (j.items || []).filter(x => x.id && x.id.videoId);
  const sk = items.find(x => TRUSTED.test(x.snippet.channelTitle || ''));
  if (sk && !SK_ID) { SK_ID = sk.snippet.channelId; await saveSkId(SK_ID); }
  return items.map((x, i) => ({ id: x.id.videoId, title: unent(x.snippet.title), channel: unent(x.snippet.channelTitle), i }))
    .filter(x => !/#shorts?\b|\bshorts\b/i.test(x.title));   /* Shorts are vertical teasers, not the full karaoke video */
}
const SK_KEY = 'https://hardin-games.cache/zoom-karaoke-channel-id';
async function saveSkId(id) { try { await caches.default.put(SK_KEY, new Response(id, { headers: { 'Cache-Control': 'max-age=2592000' } })); } catch (e) {} }
async function singKingId(env) {
  if (SK_ID) return SK_ID;
  try { const c = await caches.default.match(SK_KEY); if (c) { SK_ID = await c.text(); return SK_ID; } } catch (e) {}
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.search = new URLSearchParams({ part: 'snippet', type: 'channel', maxResults: '5', q: 'Zoom Karaoke Official', key: env.YOUTUBE_API_KEY }).toString();
  const r = await fetch(u.toString()); const j = await r.json().catch(() => ({}));
  const ch = (j.items || []).find(x => TRUSTED.test((x.snippet && x.snippet.title) || ''));
  if (ch) { SK_ID = ch.snippet.channelId || (ch.id && ch.id.channelId); await saveSkId(SK_ID); }
  return SK_ID;
}
/* the result has to be the song that was asked for */
const STOP = new Set(['karaoke', 'version', 'zoom', 'from', 'the', 'a', 'an', 'by', 'lyrics', 'official', 'song', 'and', 'of', 'feat', 'ft']);
const words = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
function relevant(q, title) { const need = words(q); if (!need.length) return true; const have = new Set(words(title)); const hit = need.filter(w => have.has(w)).length; return hit >= Math.ceil(need.length * 0.6); }
async function ytSearch(q, family, env, channels) {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set in Cloudflare');
  if (!q) return [];
  const mode = channels === true ? 'prefer' : (channels || 'any');
  const base = q.replace(/\bkaraoke\b/ig, '').trim();
  let list = (await ytRaw(q, family, env, mode === 'any' ? 15 : 25)).filter(x => relevant(base, x.title));
  if (mode !== 'any') {
    let sk = list.filter(x => TRUSTED.test(x.channel));
    if (!sk.length) {   /* look inside the Zoom Karaoke channel itself */
      const id = await singKingId(env);
      if (id) sk = (await ytRaw(base, family, env, 10, id)).filter(x => relevant(base, x.title));
    }
    const mark = x => ({ id: x.id, title: x.title, channel: x.channel, ok: true });
    const skOut = sk.map(x => ({ ...x, s: karaokeScore(x) })).sort((a, b) => (b.s - a.s) || (a.i - b.i)).slice(0, 4).map(mark);
    if (mode === 'only' || skOut.length) return skOut;   /* if Zoom Karaoke has it, show only Zoom Karaoke */
    const seen = new Set(skOut.map(x => x.id));
    const rest = list.filter(x => !seen.has(x.id) && !TRUSTED.test(x.channel)).map(x => ({ ...x, s: karaokeScore(x) })).filter(x => x.s > -3)
      .sort((a, b) => (b.s - a.s) || (a.i - b.i)).map(({ id, title, channel }) => ({ id, title, channel }));
    return [...skOut, ...rest].slice(0, 9);
  }
  return list.map(x => ({ ...x, s: karaokeScore(x) })).filter(x => x.s > -3)
    .sort((a, b) => (b.s - a.s) || (a.i - b.i)).slice(0, 9).map(({ id, title, channel }) => ({ id, title, channel }));
}
const POP_SONGS = [['Shallow','Lady Gaga & Bradley Cooper'],['Someone Like You','Adele'],['Rolling in the Deep','Adele'],['Shake It Off','Taylor Swift'],['Love Story','Taylor Swift'],['Uptown Funk','Mark Ronson ft. Bruno Mars'],
  ['Just the Way You Are','Bruno Mars'],['Perfect','Ed Sheeran'],['Shape of You','Ed Sheeran'],['Let It Go','Idina Menzel'],['Bohemian Rhapsody','Queen'],['Livin\' on a Prayer','Bon Jovi'],['Don\'t Stop Believin\'','Journey'],
  ['Sweet Caroline','Neil Diamond'],['I Want It That Way','Backstreet Boys'],['Wannabe','Spice Girls'],['Halo','Beyonce'],['Firework','Katy Perry'],['Roar','Katy Perry'],['Happy','Pharrell Williams'],
  ['Can\'t Stop the Feeling','Justin Timberlake'],['Count on Me','Bruno Mars'],['Riptide','Vance Joy'],['Someone You Loved','Lewis Capaldi'],['Hallelujah','Leonard Cohen'],['Jolene','Dolly Parton'],
  ['I Will Survive','Gloria Gaynor'],['Girls Just Want to Have Fun','Cyndi Lauper'],['Total Eclipse of the Heart','Bonnie Tyler'],['Mr. Brightside','The Killers'],['Wonderwall','Oasis'],['Hey Jude','The Beatles'],
  ['Valerie','Amy Winehouse'],['Flowers','Miley Cyrus'],['Party in the U.S.A.','Miley Cyrus'],['Drivers License','Olivia Rodrigo'],['A Thousand Years','Christina Perri'],['Viva la Vida','Coldplay'],['Shut Up and Dance','Walk the Moon'],['Dynamite','BTS']];
function backupSongs(avoid) { const a = new Set((avoid || []).map(s => String(s).toLowerCase()));
  return POP_SONGS.filter(([t]) => ![...a].some(x => x.includes(t.toLowerCase()))).sort(() => Math.random() - 0.5).slice(0, 3).map(([title, artist]) => ({ title, artist })); }
async function surprise(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { family = false, avoid = [], trusted = false, channels } = await req.json();
  const mode = channels || (trusted ? 'prefer' : 'any');
  const prompt = `Suggest THREE different well-known, fun sing-along songs for family karaoke night that most people know the words to.
- Big popular hits that a major karaoke channel like Zoom Karaoke would have.
- ${family ? 'Clean and kid-friendly.' : 'Keep it PG-13.'}
- Pick something different from: ${avoid.slice(0, 30).map(t => String(t).slice(0, 80)).join('; ') || 'nothing yet'}
Respond with only JSON, no other text: {"songs":[{"title":"...","artist":"..."}]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.FAKES_MODEL || 'claude-haiku-5-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.warn('surprise AI failed', r.status, JSON.stringify(j).slice(0, 200));
  const txt = (j.content || []).map(c => c.text || '').join('').replace(/```(json)?/g, '').trim();
  let songs = [];
  for (const cand of [txt, (txt.match(/\{[\s\S]*\}/) || [])[0], (txt.match(/\[[\s\S]*\]/) || [])[0]]) {
    if (!cand) continue;
    try { const o = JSON.parse(cand); songs = Array.isArray(o) ? o : (o.songs || (o.title ? [o] : [])); if (songs.length) break; } catch (e) {}
  }
  if (!songs.length) songs = backupSongs(avoid);   /* AI hiccup: fall back to a built-in list */
  songs = songs.map(s => typeof s === 'string' ? { title: s } : s).map(s => s && ({ title: s.title || s.song || s.name, artist: s.artist || s.by || '' }))
    .filter(s => s && s.title).slice(0, 3).map(s => ({ title: String(s.title).slice(0, 80), artist: String(s.artist || '').slice(0, 60) }));
  if (!songs.length) songs = backupSongs(avoid);
  if (!songs.length) songs = backupSongs([]);
  try {
    let fallback = null;
    for (const song of songs) {   /* first song with a Zoom Karaoke version wins */
      const results = await ytSearch(`${song.title} ${song.artist} karaoke`, family, env, mode);
      if (results.length && (mode === 'any' || results[0].ok)) return json({ song, results }, cors);
      if (results.length && !fallback) fallback = { song, results };
    }
    return json(fallback || { song: songs[0], results: [] }, cors);
  } catch (e) { return json({ error: e.message, song: songs[0] }, cors, 500); }
}

// ---- Earworm: find the original recording of a song (not karaoke), with its length ----
const isoSecs = d => { const m = String(d || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
function originalScore(x, artist) {
  const t = (x.title || '').toLowerCase(), c = (x.channel || '').toLowerCase(), a = words(artist);
  let s = 0;
  if (/official (audio|music video|video|lyric video)/.test(t)) s += 3;
  if (/ - topic$/.test(c) || /vevo/.test(c)) s += 4;
  if (a.length && a.some(w => c.includes(w))) s += 3;
  if (/\b(karaoke|instrumental|cover|live|reaction|tutorial|lesson|remix|piano|guitar|8d|slowed|sped up|nightcore|acoustic|mashup|parody|1 hour|10 hours|extended|bass boosted)\b/.test(t)) s -= 8;
  return s;
}
async function songVideo(req, env, cors) {
  if (!env.YOUTUBE_API_KEY) return json({ error: 'YOUTUBE_API_KEY is not set in Cloudflare' }, cors, 500);
  const { title = '', artist = '', family = false } = await req.json();
  const t = String(title).slice(0, 80).trim(), a = String(artist).slice(0, 60).trim();
  if (!t) return json({ error: 'No song title' }, cors, 400);
  const key = 'https://hardin-games.cache/song/' + encodeURIComponent((t + ' ' + a).toLowerCase());
  try { const c = await caches.default.match(key); if (c) return json(await c.json(), cors); } catch (e) {}
  const list = (await ytRaw(`${t} ${a} official audio`, family, env, 10)).filter(x => relevant(t, x.title))
    .map(x => ({ ...x, s: originalScore(x, a) })).filter(x => x.s > -3).sort((p, q) => (q.s - p.s) || (p.i - q.i)).slice(0, 6);
  if (!list.length) return json({ error: 'Song not found' }, cors, 404);
  const u = new URL('https://www.googleapis.com/youtube/v3/videos');
  u.search = new URLSearchParams({ part: 'contentDetails,status', id: list.map(x => x.id).join(','), key: env.YOUTUBE_API_KEY }).toString();
  const r = await fetch(u.toString()); const j = await r.json().catch(() => ({}));
  const info = {}; for (const v of (j.items || [])) info[v.id] = { dur: isoSecs(v.contentDetails && v.contentDetails.duration), embed: !(v.status && v.status.embeddable === false) };
  const pick = list.find(x => info[x.id] && info[x.id].embed && info[x.id].dur >= 90 && info[x.id].dur <= 600) || list.find(x => !info[x.id] || info[x.id].embed);
  if (!pick) return json({ error: 'No playable version' }, cors, 404);
  const out = { id: pick.id, dur: (info[pick.id] || {}).dur || 0, title: pick.title, channel: pick.channel };
  try { await caches.default.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2592000' } })); } catch (e) {}
  return json(out, cors);
}
// ---- Earworm: AI song lists for a theme, each with three believable wrong answers ----
async function songIdeas(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set in Cloudflare' }, cors, 500);
  const { theme = 'Big hits', count = 8, family = false, avoid = [] } = await req.json();
  const n = Math.min(Math.max(3, count | 0), 15);
  const prompt = `Pick ${n} songs for a family party game called "Earworm". The TV plays 10 seconds from the middle of a song and everyone picks the title from 4 choices.

Theme: ${String(theme).slice(0, 80)}
- Real, well-known songs that fit the theme and that most of the room would recognize from the chorus
- Use the original artist and the exact official song title
- For each song give 3 wrong answers: other real songs from the same era and style, so the choice is not obvious
- ${family ? 'Clean, kid-friendly songs only.' : 'Keep it PG-13.'}
${avoid.length ? `- Don't use any of these:\n${avoid.slice(0, 40).map(t => '  * ' + String(t).slice(0, 80)).join('\n')}` : ''}

Respond with only JSON, no other text: {"songs":[{"title":"...","artist":"...","decoys":[{"title":"...","artist":"..."}]}]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.FAKES_MODEL || 'claude-haiku-5-5', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: (j.error && j.error.message) || `HTTP ${r.status}` }, cors, 502);
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  let songs = [];
  try { songs = JSON.parse(m ? m[0] : '{}').songs || []; } catch (e) { return json({ error: 'AI reply was not valid JSON' }, cors, 502); }
  const clean = s => s && s.title ? { title: String(s.title).slice(0, 80), artist: String(s.artist || '').slice(0, 60) } : null;
  songs = songs.map(s => { const a = clean(s); if (!a) return null; const d = (s.decoys || []).map(clean).filter(x => x && x.title.toLowerCase() !== a.title.toLowerCase()).slice(0, 3);
    return d.length === 3 ? { ...a, decoys: d } : null; }).filter(Boolean).slice(0, n);
  return json({ songs }, cors);
}
