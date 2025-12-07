# Arcks - AI Link Previews for Google Search 🚀

**Peek before you click.** Arcks is a browser extension that uses Google Gemini AI to provide instant, intelligent summaries of search results when you hover over them.

![Arcks Preview](landing/preview.png)

## ✨ Features

- **⚡ Instant Previews**: Hover over any Google Search result linkage to see a summary in milliseconds.
- **🤖 AI-Powered**: Uses Google Gemini 2.5 Flash to generate concise, accurate summaries of web content.
- **🔒 Privacy-First**: No browsing history is stored. Summaries are generated ephemerally.
- **🌑 Pitch Black UI**: A stunning, futuristic dark mode interface designed for modern browsing.
- **🎯 Focused**: Lightweight and optimized specifically for Google Search.

## 🛠️ Tech Stack

- **Frontend**: Standard Web Technologies (HTML, CSS, JavaScript)
- **Extension API**: Manifest V3
- **Backend Proxy**: Cloudflare Workers
- **AI Model**: Google Gemini 2.5 Flash

## � Setup & Installation

### 1. Backend Setup (Cloudflare Worker)

The backend handles the API requests to Gemini securely.

1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Deploy the worker**:
    ```bash
    npx wrangler deploy worker.js
    ```
    *Note the URL of your deployed worker (e.g., `https://arcks.yourname.workers.dev`).*

3.  **Set your Google Gemini API Key**:
    Get your key from [Google AI Studio](https://makersuite.google.com/app/apikey).
    ```bash
    npx wrangler secret put GEMINI_API_KEY
    ```

### 2. Extension Setup

1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Toggle **Developer mode** in the top right.
3.  Click **Load unpacked**.
4.  Select the `arcks` folder from this repository.
5.  **Copy the generated Extension ID** from the card (e.g., `fnjfkaalieomllbcjkbahknaamhecojg`).

### 3. Configuration

Now connect the pieces:

1.  **Update Worker Security**:
    Open `worker.js` and replace the placeholder with your **Extension ID**:
    ```javascript
    const ALLOWED_ORIGINS = [
      'chrome-extension://YOUR_EXTENSION_ID_HERE' // <--- Paste ID here
    ];
    ```
    *Redeploy the worker: `npx wrangler deploy worker.js`*

2.  **Configure Extension**:
    Open `background.js` and set your **Worker URL**:
    ```javascript
    const DEFAULT_SETTINGS = {
      // ...
      workerUrl: 'https://arcks.yourname.workers.dev', // <--- Paste Worker URL here
      // ...
    };
    ```
    *(Alternatively, you can set this in the extension's Options page after installation).*

3.  **Reload the extension** in `chrome://extensions/`.

## 📄 License

MIT License © 2025 Rahul
