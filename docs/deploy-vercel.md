# Deploying Reflect on Vercel

Vercel hosts the Next.js app (UI + `/api/rate`, `/api/critique`, `/api/speech`).
The Python similarity service (FashionCLIP + PyTorch) is too large for Vercel
functions, so it runs on the **demo laptop** and is exposed to Vercel through a
**tunnel**, protected by a shared secret.

```
browser ──HTTPS──▶ Vercel (Next.js) ──HTTPS + Bearer token──▶ tunnel ──▶ laptop :8000 (similarity)
                         │
                         ├──▶ Gemini (critic)
                         └──▶ ElevenLabs (voice)
```

The Ollama critic is laptop-only too; on Vercel use `CRITIC_PROVIDER=gemini`.

## 1. Vercel environment variables (Project → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `SIMILARITY_SERVICE_URL` | The tunnel's public HTTPS URL (step 3), no trailing slash |
| `SIMILARITY_SERVICE_TOKEN` | A random secret: `openssl rand -hex 32` (same value on the laptop) |
| `CRITIC_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | Your Gemini key (sensitive) |
| `ELEVENLABS_API_KEY` | Your ElevenLabs key (sensitive; Text to Speech access, Voices read) |
| `ELEVENLABS_VOICE_ID` | The Baroness voice ID |

Environment variable changes only apply to **new deployments**: redeploy after
editing them (Deployments → ⋯ → Redeploy).

## 2. Start the similarity service on the laptop (with the token)

```bash
source services/similarity/.venv/bin/activate
python services/similarity/prepare_references.py         # once, and after reference changes
SIMILARITY_SERVICE_TOKEN=<same secret> python services/similarity/app.py
```

With the token set, `/rate` rejects requests without `Authorization: Bearer <token>`
(`GET /health` stays open and only reports readiness).

## 3. Open a tunnel to port 8000

**Cloudflare quick tunnel** (no account needed):

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

It prints `https://<random>.trycloudflare.com`. The URL **changes every time** the
tunnel restarts, so update `SIMILARITY_SERVICE_URL` in Vercel and redeploy each time.

**Stable alternative:** a free ngrok account includes one static domain, so the URL
never changes:

```bash
ngrok http --url=<your-static-domain>.ngrok-free.app 8000
```

Check it end to end:

```bash
curl -s https://<tunnel-host>/health
```

## 4. Before the demo

- Open the deployed URL on the demo laptop (HTTPS, so camera access works), click
  **Enable & test audio**, and confirm critic + voice are green.
- Keep the laptop awake and the service + tunnel running for the whole demo.
- Latency: every rating does a round trip Vercel → tunnel → laptop. If the venue
  network is unreliable, fall back to running everything locally (`npm run dev` +
  `SIMILARITY_SERVICE_URL=http://127.0.0.1:8000`), which needs no tunnel or token.
