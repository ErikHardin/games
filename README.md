# Hardin Games — setup

One file (`index.html`) runs everything:

| URL | What it is |
|---|---|
| `index.html` | Home screen |
| `?host` | TV screen (creates a room) |
| `?join=CODE` | Player phone (the QR code on the TV goes here) |
| `?admin` | Settings, family question pack, voice and AI tests |
| `?demo=1&game=fibs` or `&game=trivia` | Preview with 4 bot players, TV and your phone side by side |

Games: **Fibs** (lie-guessing) and **Smarty Pants** (trivia: category vote, AI questions with a built-in backup bank, closest-number questions, final wager). **Doodle Duel** (draw a secret prompt, everyone writes fake titles, find the real one; gallery at the end), and **Mic Drop** (sing along to a YouTube karaoke video until it stops, then finish the line; the room judges).

With no config it runs in **local mode**. That works for the demo, or for tabs on one device. Add Firebase to play across phones.

## 1. Firebase (rooms + live sync)

1. Use your existing Firebase project, or create one, and enable **Realtime Database**.
2. Copy the web config into `CONFIG.FIREBASE` at the top of the script in `index.html`.
3. Database rules (family use; locks everything outside `hardinGames`):

```json
{ "rules": { "hardinGames": { ".read": true, ".write": true } } }
```

## 2. Your cloned voice (ElevenLabs)

1. Make an ElevenLabs account on a plan that includes **Instant Voice Cloning**.
2. Go to Voices → Add voice → Instant Voice Clone. Upload or record 1–2 minutes of you talking clearly, in a game-show-host energy.
3. Copy the new **Voice ID** and your **API key**.

## 3. Cloudflare Worker (voice + AI questions)

The Worker **games** (https://games.erikchardin.workers.dev) deploys automatically from this repo via Cloudflare Workers Builds, using `wrangler.toml`.

Add these in Cloudflare → Workers → games → **Settings → Variables and Secrets** (type: Secret):

- `ELEVENLABS_API_KEY`
- `ELEVEN_VOICE_ID`
- `ANTHROPIC_API_KEY`
- `ALLOWED_ORIGINS` = `https://ech-technicalsolutions.com`
- `YOUTUBE_API_KEY` = YouTube Data API v3 key (Mic Drop song search; pasting a YouTube link works without it)
- `ADMIN_PIN` = your 4-digit admin code (devices stay unlocked 30 days; changing it signs everyone out)

**Quick checks in Safari:**
- `https://games.erikchardin.workers.dev/` shows which secrets are set
- `https://games.erikchardin.workers.dev/tts` plays a short test line in your voice, or shows ElevenLabs' exact error

The ElevenLabs API key needs **Text to Speech** access (and **Voices → Read**).

Then go to **Admin → Sound & Voice**, set Voice to **My cloned voice**, and tap **Test voice**. Set **AI questions** to "One per round" and tap **Test an AI question**.

Spoken lines are cached at the Worker, so repeated phrases don't cost twice. If the Worker fails, the game falls back to the built-in voice and pack questions automatically.

## 4. Host

Push `index.html` to a GitHub Pages repo under ech-technicalsolutions.com, for example `/games/`.

**On the TV:** open `…/games/?host` on the iPad and AirPlay it, or open that URL in the TV's browser, or use a laptop over HDMI. Tap **Tap to start** once to enable sound.
