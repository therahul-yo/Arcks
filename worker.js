/**
 * Arcks - Cloudflare Worker Proxy
 * Supports both Google Gemini and OpenRouter AI providers
 * Features: origin verification, KV caching, rate limiting, SSRF protection
 */

// Extension IDs allowed to call this worker
const ALLOWED_ORIGINS = [
  "chrome-extension://fnjfkaalieomllbcjkbahknaamhecojg"
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
  openrouter: "openrouter"
};

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
      const { url, provider: requestedProvider } = data;

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

      const summary = await getSummary(env, validatedUrl, provider);

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

async function getSummary(env, url, provider) {
  const kv = env.ARCKS_KV;
  const cacheKey = `summary:${CACHE_VERSION}:${provider}:${url}`;

  // Check KV cache
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached && cached.headline && Array.isArray(cached.bullets)) {
        return cached;
      }
    } catch {
      // Cache read failure is non-fatal
    }
  }

  // Fetch page content (server-side)
  const pageContent = await fetchPageContent(url);

  // Generate summary using configured provider
  let result;
  if (provider === PROVIDERS.openrouter) {
    result = await getSummaryFromOpenRouter(env, url, pageContent);
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
          maxOutputTokens: 1024,
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

async function getSummaryFromOpenRouter(env, url, pageContent) {
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
      model: "google/gemini-2.5-flash-preview-05-20",
      messages: [
        {
          role: "system",
          content: `You generate Arc-browser-style preview cards for web pages. Always respond with a JSON object: {"headline": "one-line tagline", "bullets": [{"icon": "icon-name", "label": "Short Label", "value": "Concise value."}]}. Use 3-5 bullets. The "icon" field MUST be one of: ${ALLOWED_ICONS.join(", ")}.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 1024,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`OpenRouter API error: ${response.status} - ${errorText}`);
    throw new Error(`AI provider error (${response.status})`);
  }

  const responseData = await response.json();
  const text = responseData.choices?.[0]?.message?.content || "";

  return parseSummaryResponse(text, url);
}

// ---- Shared Helpers ----

function buildSummarizationPrompt(url, pageContent) {
  return `You are generating an Arc-browser-style preview card for the page below. The card has:
- A short one-line "headline" (a tagline summarizing the page topic, ~6-10 words, ends with a period).
- 3-5 "bullets". Each bullet has:
  - "icon": one of [${ALLOWED_ICONS.join(", ")}], chosen to fit the bullet's topic.
  - "label": a 1-3 word bold label naming the bullet topic.
  - "value": a single concise sentence (max ~12 words) giving the key fact.

Pick the most informative, distinct bullets — each should cover a different aspect of the page (don't repeat). Avoid generic filler. Match icons sensibly (calendar for dates, users for people, dollar-sign for money, code for technical, tag for offers/discounts, message-circle for discussions, etc.).

URL: ${url}

Page Content:
${pageContent || "(No content available)"}

Respond ONLY with a JSON object in this exact format:
{"headline": "One-line tagline.", "bullets": [{"icon": "calendar", "label": "Date", "value": "Confirmed for June 8th, 2026."}]}`;
}

function parseSummaryResponse(text, url) {
  const fallback = () => ({
    headline: new URL(url).hostname,
    bullets: [{ icon: "info", label: "Preview", value: "Unable to generate preview." }]
  });

  if (!text) return fallback();

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

  if (!parsed) return fallback();

  // Back-compat: model may have returned old {title, summary} shape
  if (!parsed.bullets && parsed.summary) {
    return {
      headline: parsed.title || new URL(url).hostname,
      bullets: [{ icon: "info", label: "Summary", value: String(parsed.summary).substring(0, 200) }]
    };
  }

  const headline = typeof parsed.headline === "string" && parsed.headline.trim()
    ? parsed.headline.trim().substring(0, 140)
    : new URL(url).hostname;

  const rawBullets = Array.isArray(parsed.bullets) ? parsed.bullets : [];
  const bullets = rawBullets
    .filter(b => b && typeof b === "object" && (b.label || b.value))
    .slice(0, 5)
    .map(b => ({
      icon: ALLOWED_ICONS.includes(b.icon) ? b.icon : "info",
      label: String(b.label || "").trim().substring(0, 40),
      value: String(b.value || "").trim().substring(0, 200)
    }))
    .filter(b => b.label || b.value);

  if (bullets.length === 0) {
    return { headline, bullets: [{ icon: "info", label: "Preview", value: "No additional details available." }] };
  }

  return { headline, bullets };
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
