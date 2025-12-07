/**
 * Arcks - Background Service Worker
 * Handles API proxy requests to Cloudflare Worker
 */

// Default settings - Worker URL is pre-configured for production
const DEFAULT_SETTINGS = {
  hoverDelay: 800,
  workerUrl: '', // Set your Cloudflare Worker URL here
  enabled: true
};

// Load settings from storage
async function getSettings() {
  const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return result;
}

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSummary') {
    handleGetSummary(request.url, request.content)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'getSettings') {
    getSettings().then(sendResponse);
    return true;
  }
});

/**
 * Fetch AI summary from Cloudflare Worker proxy
 */
async function handleGetSummary(url, content) {
  const settings = await getSettings();
  
  if (!settings.workerUrl) {
    return { error: 'Worker URL not configured. Set it in extension options.' };
  }
  
  if (!settings.enabled) {
    return { error: 'Extension is disabled' };
  }
  
  try {
    const response = await fetch(settings.workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url,
        content: content
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Arcks: Error fetching summary:', error);
    return { error: error.message };
  }
}
