# Arcks - AI Link Previews for Google Search 🚀

**Peek before you click.** Arcks is a browser extension that instantly generates AI-powered preview cards for Google Search results when you hover over them.

![Arcks Preview](landing/sample-openclaw.png)

## ✨ Features

- **⚡ Instant Previews**: Hover over any Google Search result to see a preview card in ~500ms.
- **🤖 AI-Powered**: Generates a headline + icon bullet-point card using Google Gemini or OpenRouter.
- **☁️ Server-Side Fetching**: Page content is fetched by the Cloudflare Worker — no CORS issues, no client-side scraping.
- **💾 Two-Layer Caching**: KV cache on the worker (30 min) and in-memory cache in the extension (10 min) minimize API calls.
- **🔒 Privacy-First**: No browsing history is stored. Summaries are generated ephemerally.
- **🌑 Dark Card UI**: Solid dark card with a headline and structured bullet points.
- **🎯 Focused**: Lightweight and optimized specifically for Google Search.

## 🛠️ Tech Stack

- **Frontend**: Manifest V3 Chrome Extension (HTML, CSS, JavaScript)
- **Backend Proxy**: Cloudflare Workers with KV caching and rate limiting
- **AI Providers**: Google Gemini 2.5 Flash or any OpenRouter model

## 🔧 Setup & Installation

### 1. Backend Setup (Cloudflare Worker)

1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Deploy the worker**:
    ```bash
    npx wrangler deploy worker.js
    ```
    *Note the URL of your deployed worker (e.g., `https://arcks.yourname.workers.dev`).*

3.  **Set your AI provider API key** — pick one or both:

    **Gemini** (get key from [Google AI Studio](https://makersuite.google.com/app/apikey)):
    ```bash
    npx wrangler secret put GEMINI_API_KEY
    ```

    **OpenRouter** (get key from [openrouter.ai](https://openrouter.ai/keys)):
    ```bash
    npx wrangler secret put OPENROUTER_API_KEY
    ```

4.  **Create a KV namespace** for caching:
    ```bash
    npx wrangler kv namespace create ARCKS_KV
    ```
    Add the binding to `wrangler.toml`, then redeploy.

### 2. Extension Setup

1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Toggle **Developer mode** in the top right.
3.  Click **Load unpacked** and select the `arcks` folder.
4.  Open the extension's **Options** page — the Extension ID is shown in the **Diagnostics** section with a one-click **Copy** button.

### 3. Configuration

1.  **Update Worker Security** — open `worker.js` and replace the placeholder with your Extension ID:
    ```javascript
    const ALLOWED_ORIGINS = [
      'chrome-extension://YOUR_EXTENSION_ID_HERE'
    ];
    ```
    Redeploy: `npx wrangler deploy`

2.  **Configure the Extension** — open the Options page and:
    - Paste your **Worker URL**.
    - Click **Test connection** — you should see `OK · <ms>` inline. The button hits `GET /health` first (no auth, no rate limit) and falls back to a sample POST if `/health` isn't available yet.
    - Save.

3.  **Reload the extension** in `chrome://extensions/` so the content script picks up the new settings.

## 🔬 Staging Environment

`wrangler.toml` ships with a `[env.staging]` block so you can preview worker changes against a separate KV namespace and secrets without affecting production.

```bash
# one-time: create a staging KV namespace and paste the printed id into
# the [env.staging.kv_namespaces] block in wrangler.toml (REPLACE_ME).
npx wrangler kv namespace create ARCKS_KV --env staging

# secrets are per-environment
npx wrangler secret put OPENROUTER_API_KEY --env staging
npx wrangler secret put GEMINI_API_KEY    --env staging   # optional
npx wrangler secret put NIM_API_KEY       --env staging   # optional

# deploy
npx wrangler deploy --env staging   # → arcks-staging.<you>.workers.dev
npx wrangler deploy                 # → arcks.<you>.workers.dev (prod)
```

To monitor uptime, hit the unauthenticated health endpoint:

```bash
curl https://arcks.<you>.workers.dev/health
# {"status":"ok","commit":"dev"}
```

Set `GIT_SHA` as a worker env var in your CI to stamp the deployed commit into the `/health` response.

## 📡 Worker API

`POST /` accepts `{ url, provider?, model?, pageHint? }` and returns:

```json
{
  "title": "...",
  "headline": "...",
  "summary": "...",
  "bullets": ["...", "...", "..."],
  "cached": false,
  "latencyMs": 348
}
```

Errors come back as `{ error, code, requestId }` with a matching `X-Request-Id` response header for log correlation. Successful responses also carry `Cache-Control: public, max-age=600` (cache hits) or `max-age=60` (fresh) so a downstream CDN can tier on top of KV.

## 📄 License

MIT License © 2025 Rahul
