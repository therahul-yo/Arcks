/**
 * Arcks - Cloudflare Worker Proxy
 * Supports both Google Gemini and OpenRouter AI providers
 * Features: origin verification, KV caching, rate limiting, SSRF protection
 */

// Extension IDs allowed to call this worker
const ALLOWED_ORIGINS = [
  "chrome-extension://nchcfijbpgnhjelnnoacmjmobcpeflid"
];

// KV cache TTL
const CACHE_TTL_SECONDS = 1800; // 30 minutes
// v3: introduced strict validateSummary + field-length caps. Bumping the
// version invalidates every pre-hardening entry on the first redeploy so
// stale JSON-blob bullets stop being served from KV.
const CACHE_VERSION = "v3";

// Allowed icon names for bullet points (Lucide icon set)
const ALLOWED_ICONS = [
  "message-circle", "users", "calendar", "tag", "file-text",
  "bookmark", "code", "dollar-sign", "globe", "info",
  "check-circle", "alert-circle", "book", "star", "lightbulb",
  "trending-up", "shield", "zap", "map-pin", "clock"
];

// In-memory rate limiter
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 30;
const rateLimitMap = new Map();

// In-memory concurrent-request deduper. Per-isolate only — best effort, but
// catches the common case of N hover events on the same link arriving while
// the first request is still in flight.
const inFlight = new Map();

// Retry tuning for transient provider errors (5xx, abort, network).
const PROVIDER_RETRY_MAX = 2;
const PROVIDER_RETRY_BASE_MS = 250;

// Default fallback order if the primary provider keeps failing.
const PROVIDER_FALLBACK_ORDER = ["openrouter", "gemini", "nvidia"];

// Available AI providers
const PROVIDERS = {
  gemini: "gemini",
  openrouter: "openrouter",
  nvidia: "nvidia"
};

const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";
const DEFAULT_NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
const MAX_SUMMARY_TOKENS = 512;

// Network timeouts
const PROVIDER_TIMEOUT_MS = 15000;  // AI provider HTTP calls
const PAGE_FETCH_TIMEOUT_MS = 8000; // target page GET

// Field-level caps on the persisted summary
const MAX_TITLE_LEN    = 180;
const MAX_HEADLINE_LEN = 240;
const MAX_SUMMARY_LEN  = 600;
const MAX_BULLET_LEN   = 250;
const MAX_BULLETS      = 4;
const MIN_BULLETS      = 1;

export default {
  async fetch(request, env, ctx) {
    const requestId = newRequestId();
    const origin = request.headers.get("Origin");
    const { pathname } = new URL(request.url);

    // /health — uptime probe, intentionally unauth'd so monitoring works.
    if (pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return jsonResponse({ status: "ok", commit: env.GIT_SHA || "dev" }, {
        status: 200,
        cors: origin && ALLOWED_ORIGINS.includes(origin) ? origin : null,
        requestId,
        cache: "no-store"
      });
    }

    if (request.method === "OPTIONS") {
      return handleCORS(request);
    }

    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return errorResponse(403, "Forbidden: Invalid origin", "forbidden_origin", { requestId });
    }

    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed", "method_not_allowed", { origin, requestId });
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRateLimit(clientIp)) {
      return errorResponse(429, "Rate limit exceeded. Try again later.", "rate_limited", { origin, requestId });
    }

    try {
      const body = await request.text();

      if (body.length > 2048) {
        return errorResponse(413, "Request body too large", "body_too_large", { origin, requestId });
      }

      let data;
      try { data = JSON.parse(body); }
      catch { return errorResponse(400, "Invalid JSON body", "bad_json", { origin, requestId }); }

      const { url, provider: requestedProvider, model: requestedModel, pageHint } = data || {};

      if (!url) {
        return errorResponse(400, "Missing URL", "missing_url", { origin, requestId });
      }

      const validatedUrl = validateAndSanitizeUrl(url);
      if (!validatedUrl) {
        return errorResponse(400, "Invalid or forbidden URL", "invalid_url", { origin, requestId });
      }

      // Choose provider: request override > env default > fallback to gemini
      let provider = PROVIDERS.gemini;
      if (requestedProvider && PROVIDERS[requestedProvider]) {
        provider = requestedProvider;
      } else if (env.DEFAULT_PROVIDER && PROVIDERS[env.DEFAULT_PROVIDER]) {
        provider = env.DEFAULT_PROVIDER;
      }

      const model = resolveModel(provider, requestedModel);
      const summary = await getSummary(env, validatedUrl, provider, pageHint, model);

      return jsonResponse(summary, {
        status: 200,
        cors: origin,
        requestId,
        cache: summary.cached ? "public, max-age=600" : "public, max-age=60"
      });
    } catch (error) {
      console.error("handler.error", { requestId, name: error && error.name, msg: clamp(String(error && error.message || ""), 200) });
      return errorResponse(500, error.message || "Internal error", "internal_error", { origin, requestId });
    }
  }
};

// ---- Response Builders ----

function newRequestId() {
  try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2, 12); }
}

function jsonResponse(payload, { status = 200, cors = null, requestId = null, cache = null } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId || ""
  };
  if (cache) headers["Cache-Control"] = cache;
  if (cors) Object.assign(headers, corsHeaders(cors));
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(status, message, code, { origin = null, requestId = null } = {}) {
  return jsonResponse(
    { error: message, code, requestId },
    {
      status,
      cors: origin && ALLOWED_ORIGINS.includes(origin) ? origin : null,
      requestId,
      cache: "no-store"
    }
  );
}

// ---- Shared Network Helpers ----

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Schema Validation ----

function validateSummary(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.title !== "string" || !obj.title.trim()) return false;
  if (typeof obj.headline !== "string" || !obj.headline.trim()) return false;
  if (typeof obj.summary !== "string") return false;
  if (!Array.isArray(obj.bullets)) return false;
  if (obj.bullets.length < MIN_BULLETS || obj.bullets.length > MAX_BULLETS) return false;
  for (const b of obj.bullets) {
    if (typeof b !== "string" || !b.trim() || b.length > MAX_BULLET_LEN) return false;
  }
  if (obj.title.length > MAX_TITLE_LEN) return false;
  if (obj.headline.length > MAX_HEADLINE_LEN) return false;
  if (obj.summary.length > MAX_SUMMARY_LEN) return false;
  return true;
}

// ---- Rate Limiting ----

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// ---- Main Summary Function ----

async function getSummary(env, url, provider, pageHint = "", model = DEFAULT_OPENROUTER_MODEL) {
  const cacheKey = `summary:${CACHE_VERSION}:${provider}:${model}:${url}`;
  const t0 = Date.now();

  // Concurrent-request dedup: if an identical request is already in flight,
  // join it instead of doing the work twice.
  const existing = inFlight.get(cacheKey);
  if (existing) {
    const result = await existing;
    return stampMeta(result, { cached: true, latencyMs: Date.now() - t0 });
  }

  const work = (async () => {
    const kv = env.ARCKS_KV;

    // 1. KV cache lookup
    if (kv) {
      try {
        const cached = await kv.get(cacheKey, { type: "json" });
        if (cached && validateSummary(cached)) {
          return { result: cached, cached: true };
        }
      } catch { /* non-fatal */ }
    }

    // 2. Fetch + sanitize target page (with low-signal fallback to pageHint)
    let pageContent = await fetchPageContent(url);
    if (isBlockedOrLowSignalContent(pageContent) && pageHint) {
      pageContent = `Search result context:\n${String(pageHint).slice(0, 1200)}`;
    }

    // 3. Call provider with retry + fallback chain
    const result = await callProviderWithFallback(env, provider, url, pageContent, model);

    // 4. KV write (non-fatal)
    if (kv) {
      try {
        await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
      } catch { /* non-fatal */ }
    }

    return { result, cached: false };
  })();

  inFlight.set(cacheKey, work.then(w => w.result));
  try {
    const { result, cached } = await work;
    return stampMeta(result, { cached, latencyMs: Date.now() - t0 });
  } finally {
    inFlight.delete(cacheKey);
  }
}

function stampMeta(summary, { cached, latencyMs }) {
  // Always return a fresh object so the in-memory cached one isn't mutated.
  return { ...summary, cached: Boolean(cached), latencyMs: Math.max(0, latencyMs | 0) };
}

// ---- Provider Dispatch + Retry + Fallback ----

function callProvider(env, provider, url, pageContent, model) {
  if (provider === PROVIDERS.openrouter) return getSummaryFromOpenRouter(env, url, pageContent, model);
  if (provider === PROVIDERS.nvidia)     return getSummaryFromNvidia(env, url, pageContent, model);
  return getSummaryFromGemini(env, url, pageContent);
}

async function callProviderWithRetry(env, provider, url, pageContent, model) {
  let lastErr;
  for (let attempt = 0; attempt <= PROVIDER_RETRY_MAX; attempt++) {
    try {
      return await callProvider(env, provider, url, pageContent, model);
    } catch (err) {
      lastErr = err;
      if (!isTransientProviderError(err) || attempt === PROVIDER_RETRY_MAX) throw err;
      const delay = PROVIDER_RETRY_BASE_MS * Math.pow(4, attempt); // 250, 1000
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function callProviderWithFallback(env, primary, url, pageContent, model) {
  const chain = buildProviderChain(env, primary);
  let lastErr;
  for (const provider of chain) {
    const m = provider === primary ? model : defaultModelFor(provider);
    try {
      return await callProviderWithRetry(env, provider, url, pageContent, m);
    } catch (err) {
      lastErr = err;
      console.error("provider.exhausted", { provider, status: err && err.status });
      // Only try the next provider if this one looks transient or auth-broken;
      // a content/parse error from one provider would likely repeat on another.
      if (!isTransientProviderError(err) && !isUnconfiguredKeyError(err)) {
        throw err;
      }
    }
  }
  throw lastErr || new Error("All providers exhausted");
}

function buildProviderChain(env, primary) {
  const chain = [primary];
  for (const p of PROVIDER_FALLBACK_ORDER) {
    if (p !== primary && hasProviderKey(env, p)) chain.push(p);
  }
  return chain;
}

function hasProviderKey(env, provider) {
  if (provider === PROVIDERS.gemini)     return Boolean(env.GEMINI_API_KEY);
  if (provider === PROVIDERS.openrouter) return Boolean(env.OPENROUTER_API_KEY);
  if (provider === PROVIDERS.nvidia)     return Boolean(env.NIM_API_KEY || env.NVIDIA_API_KEY);
  return false;
}

function defaultModelFor(provider) {
  if (provider === PROVIDERS.openrouter) return DEFAULT_OPENROUTER_MODEL;
  if (provider === PROVIDERS.nvidia)     return DEFAULT_NVIDIA_MODEL;
  return DEFAULT_OPENROUTER_MODEL;
}

function isTransientProviderError(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.name === "TypeError") return true;
  // Provider functions throw "AI provider error (5xx)" / "OpenRouter error (5xx)..." etc.
  const msg = String(err.message || "");
  return /\((5\d\d)\)/.test(msg) || /\(429\)/.test(msg);
}

function isUnconfiguredKeyError(err) {
  return err && /not configured/.test(String(err.message || ""));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Gemini Provider ----

async function getSummaryFromGemini(env, url, pageContent) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = buildSummarizationPrompt(url, pageContent);

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: MAX_SUMMARY_TOKENS,
          responseMimeType: "application/json"
        }
      })
    },
    PROVIDER_TIMEOUT_MS
  );

  if (!response.ok) {
    // Read + discard body so connection releases; do not log it (may echo keys).
    await response.text().catch(() => "");
    console.error("gemini.error", { status: response.status });
    throw new Error(`AI provider error (${response.status})`);
  }

  const responseData = await response.json();
  const parts = responseData.candidates?.[0]?.content?.parts || [];

  let text = "";
  for (const part of parts) {
    if (part.text) {
      text = part.text;
      break;
    }
  }

  return parseSummaryResponse(text, url);
}

// ---- OpenRouter Provider ----

async function getSummaryFromOpenRouter(env, url, pageContent, model = DEFAULT_OPENROUTER_MODEL) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const prompt = buildSummarizationPrompt(url, pageContent);

  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://arcks.workers.dev",
      "X-Title": "Arcks"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You create compact browser hover previews. Always respond with JSON in this exact shape: {\"title\":\"Page Title\",\"headline\":\"Short page preview headline.\",\"summary\":\"One sentence fallback summary.\",\"bullets\":[\"Label: useful insight\",\"Label: useful insight\",\"Label: useful insight\"]}"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: MAX_SUMMARY_TOKENS,
      response_format: { type: "json_object" }
    })
  }, PROVIDER_TIMEOUT_MS);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("openrouter.error", { status: response.status });
    throw new Error(`OpenRouter error (${response.status}): ${summarizeProviderError(errorText)}`);
  }

  const responseData = await response.json();
  const text = responseData.choices?.[0]?.message?.content || "";

  return parseSummaryResponse(text, url);
}

// ---- NVIDIA NIM Provider ----

async function getSummaryFromNvidia(env, url, pageContent, model = DEFAULT_NVIDIA_MODEL) {
  const apiKey = env.NIM_API_KEY || env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NIM_API_KEY not configured");
  }

  const prompt = buildSummarizationPrompt(url, pageContent);

  const response = await fetchWithTimeout("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You create compact browser hover previews. Always respond with JSON in this exact shape: {\"title\":\"Page Title\",\"headline\":\"Short page preview headline.\",\"summary\":\"One sentence fallback summary.\",\"bullets\":[\"Label: useful insight\",\"Label: useful insight\",\"Label: useful insight\"]}"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: MAX_SUMMARY_TOKENS,
      response_format: { type: "json_object" }
    })
  }, PROVIDER_TIMEOUT_MS);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("nvidia.error", { status: response.status });
    throw new Error(`NVIDIA NIM error (${response.status}): ${summarizeProviderError(errorText)}`);
  }

  const responseData = await response.json();
  const text = responseData.choices?.[0]?.message?.content || "";

  return parseSummaryResponse(text, url);
}

// ---- Shared Helpers ----

function buildSummarizationPrompt(url, pageContent) {
  return `Create a compact browser hover preview for this webpage.

Write like a high-signal Arc-style preview:
- one short headline that explains what the page is about
- 3 to 4 bullet insights
- each bullet must be under 90 characters
- make the first 1 to 4 words of each bullet a label followed by a colon
- do not invent facts that are not present in the page content

URL: ${url}

Page Content:
${pageContent || "(No content available)"}

Respond with a JSON object in this exact format:
{"title": "Page Title", "headline": "Short page preview headline.", "summary": "One sentence fallback summary.", "bullets": ["Label: useful insight", "Label: useful insight", "Label: useful insight"]}`;
}

function resolveModel(provider, requestedModel) {
  const defaultModel = provider === PROVIDERS.nvidia ? DEFAULT_NVIDIA_MODEL : DEFAULT_OPENROUTER_MODEL;
  if (provider !== PROVIDERS.openrouter && provider !== PROVIDERS.nvidia) return defaultModel;
  if (typeof requestedModel !== "string") return defaultModel;

  const model = requestedModel.trim();
  return /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model) ? model : defaultModel;
}

function isBlockedOrLowSignalContent(text) {
  const normalized = String(text || "").toLowerCase();
  if (normalized.length < 160) return true;
  return /verification pending|verification page|verify you are human|login to continue|enable javascript|blocked by|access denied|unusual traffic/.test(normalized);
}

function summarizeProviderError(errorText) {
  try {
    const parsed = JSON.parse(errorText);
    return parsed.error?.message || parsed.message || errorText.slice(0, 180);
  } catch {
    return String(errorText || "Unknown provider error").slice(0, 180);
  }
}

function parseSummaryResponse(text, url) {
  const hostname = safeHostname(url);
  if (!text) return fallbackSummary(hostname);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* noop */ }
    }
  }

  const candidate = buildCandidateSummary(parsed, text, hostname);

  if (validateSummary(candidate)) {
    return candidate;
  }

  console.error("schema.invalid", { url: hostname });
  return fallbackSummary(hostname, text);
}

function buildCandidateSummary(parsed, text, hostname) {
  const title    = clamp(strOrNull(parsed?.title) || hostname, MAX_TITLE_LEN);
  const headline = clamp(strOrNull(parsed?.headline) || strOrNull(parsed?.summary) || title, MAX_HEADLINE_LEN);
  const summary  = clamp(
    strOrNull(parsed?.summary) ||
    String(text || "").replace(/\{[\s\S]*\}|```json|```/g, "").trim().slice(0, MAX_SUMMARY_LEN) ||
    "Unable to generate summary.",
    MAX_SUMMARY_LEN
  );

  let bullets;
  if (Array.isArray(parsed?.bullets)) {
    bullets = parsed.bullets
      .map(b => clamp(String(b == null ? "" : b).trim(), MAX_BULLET_LEN))
      .filter(Boolean)
      .slice(0, MAX_BULLETS);
  } else {
    bullets = summary
      .split(/(?<=[.!?])\s+/)
      .map(s => clamp(s.trim(), MAX_BULLET_LEN))
      .filter(Boolean)
      .slice(0, MAX_BULLETS);
  }

  if (bullets.length === 0) bullets = [clamp(summary, MAX_BULLET_LEN) || "Unable to generate summary."];

  return { title, headline, summary, bullets };
}

function fallbackSummary(hostname, text) {
  const trimmed = clamp(String(text || "").replace(/\{[\s\S]*\}|```json|```/g, "").trim(), MAX_SUMMARY_LEN);
  const summary = trimmed || "Unable to generate summary.";
  return {
    title: clamp(hostname || "Preview", MAX_TITLE_LEN),
    headline: clamp(hostname || "Preview", MAX_HEADLINE_LEN),
    summary,
    bullets: [clamp(summary, MAX_BULLET_LEN)]
  };
}

function strOrNull(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function clamp(s, max) {
  const str = String(s == null ? "" : s);
  return str.length > max ? str.slice(0, max) : str;
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

// ---- Page Content Fetching ----

async function fetchPageContent(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ArcksBot/1.0)"
      },
      redirect: "follow"
    }, PAGE_FETCH_TIMEOUT_MS);

    if (!response.ok) {
      return "";
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return "";
    }

    const html = await response.text();
    return sanitizeHtmlToText(html);
  } catch {
    return "";
  }
}

function sanitizeHtmlToText(html) {
  try {
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ");

    // Decode common entities
    text = text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Clean whitespace
    text = text.replace(/\s+/g, " ").trim();

    if (text.length > 12000) {
      text = text.substring(0, 12000);
    }

    return text;
  } catch {
    return "";
  }
}

// ---- URL Validation (SSRF Protection) ----

function validateAndSanitizeUrl(urlStr) {
  try {
    if (typeof urlStr !== "string" || urlStr.length === 0 || urlStr.length > 2048) {
      return null;
    }

    const url = new URL(urlStr);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    // Hostname per WHATWG URL: IPv6 hosts come back bracketed. Strip them.
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }

    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
      return null;
    }

    // IPv4 — block private / loopback / link-local / multicast / reserved.
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Regex.test(hostname)) {
      const parts = hostname.split(".").map(Number);
      if (parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
      if (parts[0] === 10 ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] < 32) ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 127) ||
          (parts[0] === 169 && parts[1] === 254) ||
          (parts[0] === 0) ||
          (parts[0] >= 224)) {
        return null;
      }
    }

    // IPv6 — block loopback, link-local (fe80::/10), unique local (fc00::/7),
    // unspecified, IPv4-mapped, and IPv4-compat.
    if (hostname.includes(":")) {
      if (hostname === "::1" || hostname === "::") return null;
      if (hostname.startsWith("fe80:") || hostname.startsWith("fe80::")) return null;
      // fc00::/7 — first byte begins with fc or fd
      const prefix2 = hostname.slice(0, 2);
      if (prefix2 === "fc" || prefix2 === "fd") return null;
      if (hostname.startsWith("::ffff:")) return null; // IPv4-mapped
      if (hostname.startsWith("::") && /^::[\d.]+$/.test(hostname)) return null; // IPv4-compat
    }

    // Hardcoded fallbacks (belt and suspenders).
    if (hostname === "127.0.0.1" || hostname === "0.0.0.0" ||
        hostname.startsWith("172.17.") || hostname.startsWith("172.18.")) {
      return null;
    }

    return urlStr;
  } catch {
    return null;
  }
}

// ---- CORS ----

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function handleCORS(request) {
  const origin = request.headers.get("Origin");

  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response("Forbidden", { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin)
  });
}
