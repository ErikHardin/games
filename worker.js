// Hardin Games — Cloudflare Worker
// Routes:
//   POST /tts       { text }                         -> audio/mpeg in your cloned voice (ElevenLabs)
//   POST /question  { count, topic, family, avoid }  -> { questions: [{ text, answer, decoys }] } (Claude)
//
// Secrets / vars (wrangler secret put ...):
//   ELEVENLABS_API_KEY, ELEVEN_VOICE_ID, ANTHROPIC_API_KEY
//   ALLOWED_ORIGINS  e.g. "https://ech-technicalsolutions.com"
//   ELEVEN_MODEL (optional, default eleven_multilingual_v2), CLAUDE_MODEL (optional)
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
      return json({ ok: true, name: 'Hardin Games worker', voiceKey: !!env.ELEVENLABS_API_KEY, voiceId: !!env.ELEVEN_VOICE_ID, aiKey: !!env.ANTHROPIC_API_KEY, originLock: allowed.length > 0 }, cors);
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
