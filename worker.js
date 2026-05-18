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
const CACHE_VERSION = "v2";

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

// Available AI providers
const PROVIDERS = {
  gemini: "gemini",
  openrouter: "openrouter",
  nvidia: "nvidia"
};

const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";
const DEFAULT_NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
const MAX_SUMMARY_TOKENS = 512;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return handleCORS(request);
    }

    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Forbidden: Invalid origin", {
        status: 403,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders(origin)
      });
    }

    // Rate limiting
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRateLimit(clientIp)) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        status: 429,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json"
        }
      });
    }

    try {
      const body = await request.text();

      if (body.length > 2048) {
        return new Response("Request body too large", {
          status: 413,
          headers: corsHeaders(origin)
        });
      }

      const data = JSON.parse(body);
      const { url, provider: requestedProvider, model: requestedModel, pageHint } = data;

      if (!url) {
        return new Response("Missing URL", {
          status: 400,
          headers: corsHeaders(origin)
        });
      }

      const validatedUrl = validateAndSanitizeUrl(url);
      if (!validatedUrl) {
        return new Response("Invalid or forbidden URL", {
          status: 400,
          headers: corsHeaders(origin)
        });
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

      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json"
        }
      });
    }
  }
};

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
  const kv = env.ARCKS_KV;
  const cacheKey = `summary:${CACHE_VERSION}:${provider}:${model}:${url}`;

  // Check KV cache
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached && cached.title && cached.summary && cached.headline && Array.isArray(cached.bullets)) {
        return cached;
      }
    } catch {
      // Cache read failure is non-fatal
    }
  }

  // Fetch page content (server-side)
  let pageContent = await fetchPageContent(url);
  if (isBlockedOrLowSignalContent(pageContent) && pageHint) {
    pageContent = `Search result context:\n${String(pageHint).slice(0, 1200)}`;
  }

  // Generate summary using configured provider
  let result;
  if (provider === PROVIDERS.openrouter) {
    result = await getSummaryFromOpenRouter(env, url, pageContent, model);
  } else if (provider === PROVIDERS.nvidia) {
    result = await getSummaryFromNvidia(env, url, pageContent, model);
  } else {
    result = await getSummaryFromGemini(env, url, pageContent);
  }

  // Cache the result
  if (kv) {
    try {
      await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      // Cache write failure is non-fatal
    }
  }

  return result;
}

// ---- Gemini Provider ----

async function getSummaryFromGemini(env, url, pageContent) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = buildSummarizationPrompt(url, pageContent);

  const response = await fetch(
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
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Gemini API error: ${response.status} - ${errorText}`);
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

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`OpenRouter API error: ${response.status} - ${errorText}`);
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

  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
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
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`NVIDIA NIM API error: ${response.status} - ${errorText}`);
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
  if (!text) {
    const hostname = new URL(url).hostname;
    return {
      title: hostname,
      headline: hostname,
      summary: "Unable to generate summary.",
      bullets: ["Unable to generate summary."]
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        // Parse failed
      }
    }
  }

  const title = parsed?.title || new URL(url).hostname;
  const headline = parsed?.headline || parsed?.summary || title;
  const summary = parsed?.summary || text.replace(/\{[\s\S]*\}|```json|```/g, "").trim().substring(0, 250) || "Unable to generate summary.";
  const bullets = Array.isArray(parsed?.bullets)
    ? parsed.bullets.map(String).filter(Boolean).slice(0, 4)
    : summary.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 4);

  return { title, headline, summary, bullets };
}

// ---- Page Content Fetching ----

async function fetchPageContent(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ArcksBot/1.0)"
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

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
    const url = new URL(urlStr);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return null;
    }

    // Block IP addresses in private ranges
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipRegex.test(hostname)) {
      const parts = hostname.split(".").map(Number);
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

    if (hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0" ||
        hostname.startsWith("172.17.") || hostname.startsWith("172.18.")) {
      return null;
    }

    if (urlStr.length > 2048) return null;

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
