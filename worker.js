/**
 * Arcks - Cloudflare Worker Proxy
 * Secure proxy to Gemini API with origin verification
 * 
 * Deploy with: wrangler deploy
 * Set secret: wrangler secret put GEMINI_API_KEY
 */

// Extension ID - update this after loading your extension
const ALLOWED_ORIGINS = [
  'chrome-extension://YOUR_EXTENSION_ID_HERE'
];

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }
    
    // Origin check
    const origin = request.headers.get('Origin');
    
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Forbidden: Invalid origin', { 
        status: 403,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { 
        status: 405,
        headers: corsHeaders(origin)
      });
    }
    
    try {
      const body = await request.text();
      
      if (body.length > 10000) {
        return new Response('Payload too large', { 
          status: 413,
          headers: corsHeaders(origin)
        });
      }
      
      const data = JSON.parse(body);
      const { url, content } = data;
      
      if (!url) {
        return new Response('Missing URL', { 
          status: 400,
          headers: corsHeaders(origin)
        });
      }
      
      const summary = await getSummary(env.GEMINI_API_KEY, url, content);
      
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': 'application/json'
        }
      });
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': 'application/json'
        }
      });
    }
  }
};

/**
 * Get summary from Gemini
 */
async function getSummary(apiKey, url, content) {
  const prompt = `Summarize this webpage in 2-3 sentences. Be concise and informative.

URL: ${url}

Page Content:
${content || '(No content - summarize based on URL)'}

Respond in JSON format:
{"title": "Page Title", "summary": "2-3 sentence summary of the page content."}`;


  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 300
        }
      })
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error: ${response.status}`);
  }
  
  const result = await response.json();
  
  // Gemini 2.5 Flash may return multiple parts (thoughts + response)
  const parts = result.candidates?.[0]?.content?.parts || [];
  let text = '';
  
  // Get the last text part (usually the actual response, not thoughts)
  for (const part of parts) {
    if (part.text) {
      text = part.text;
    }
  }
  
  if (!text) {
    return {
      title: new URL(url).hostname,
      summary: 'Unable to generate summary.'
    };
  }
  
  // Parse JSON from response
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.title && parsed.summary) {
        return parsed;
      }
    }
  } catch {}
  
  // Fallback - use the text directly as summary
  return {
    title: new URL(url).hostname,
    summary: text.replace(/```json|```/g, '').trim().substring(0, 250) || 'Unable to generate summary.'
  };
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function handleCORS(request) {
  const origin = request.headers.get('Origin');
  
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }
  
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin)
  });
}
