/**
 * Arcks - Content Script
 * Arc-style hover previews with caching, AbortController, and polished UI
 */

(function() {
  'use strict';

  // ===== STATE =====
  let currentHoveredLink = null;
  let hoverTimeout = null;
  let hideTimeout = null;
  let popup = null;
  let shadowRoot = null;
  let settings = { hoverDelay: 350, enabled: true, workerUrl: '' };
  let isPopupHovered = false;
  let currentRequestId = 0;

  // Client-side cache: URL -> { title, summary, bullets, timestamp }
  const CACHE_DURATION = 10 * 60 * 1000;
  const urlCache = new Map();

  // Load settings
  chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
    if (response) settings = { ...settings, ...response };
  });

  // ===== STYLES =====
  const POPUP_STYLES = `
    .arcks-popup {
      position: fixed;
      z-index: 2147483647;
      width: 512px;
      max-width: 92vw;
      min-height: 328px;
      background:
        linear-gradient(180deg, rgba(0, 0, 0, 0.98), rgba(0, 0, 0, 0.9)),
        rgba(0, 0, 0, 0.94);
      backdrop-filter: blur(34px) saturate(165%);
      -webkit-backdrop-filter: blur(34px) saturate(165%);
      border: 1px solid rgba(255, 255, 255, 0.055);
      border-radius: 16px;
      box-shadow:
        0 28px 90px rgba(0, 0, 0, 0.74),
        0 0 0 1px rgba(255,255,255,0.03),
        inset 0 1px 0 rgba(255,255,255,0.05);
      padding: 26px 24px 76px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #ffffff;
      opacity: 0;
      transform: translateY(8px) scale(0.985) perspective(1px);
      transition:
        opacity 0.16s cubic-bezier(0.22, 1, 0.36, 1),
        transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto;
      transform-origin: top center;
      overflow: hidden;
    }

    .arcks-popup.visible {
      opacity: 1;
      transform: translateY(0) scale(1) perspective(1px);
    }

    .arcks-popup.hiding {
      opacity: 0 !important;
      transform: translateY(5px) scale(0.985) perspective(1px) !important;
      transition: opacity 0.13s cubic-bezier(0.22, 1, 0.36, 1),
                  transform 0.13s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .arcks-eyebrow {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      min-width: 0;
    }

    .arcks-favicon { width:18px; height:18px; border-radius:4px; flex-shrink:0; }

    .arcks-host {
      font-size:13px; font-weight:650; color:rgba(255,255,255,0.76);
      letter-spacing:0; text-transform:none;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }

    .arcks-headline {
      font-size:22px;
      font-weight:760;
      color:rgba(255,255,255,0.93);
      margin:0 0 16px 0;
      line-height:1.32;
      letter-spacing:0;
      display:-webkit-box;
      -webkit-line-clamp:2;
      -webkit-box-orient:vertical;
      overflow:hidden;
    }

    .arcks-insights {
      display: grid;
      gap: 14px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .arcks-insight {
      display: grid;
      grid-template-columns: 26px 1fr;
      gap: 14px;
      align-items: start;
      font-size: 20px;
      line-height: 1.5;
      font-weight: 650;
      color: rgba(255,255,255,0.82);
      letter-spacing: 0;
    }

    .arcks-insight span {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .arcks-insight strong {
      color: rgba(255,255,255,0.92);
      font-weight: 780;
    }

    .arcks-insight-icon {
      width: 24px;
      height: 24px;
      color: rgba(255,255,255,0.31);
      margin-top: 4px;
    }

    .arcks-actions {
      position:absolute;
      right:14px;
      bottom:14px;
      display:flex;
      gap:10px;
      align-items:center;
    }

    .arcks-share,
    .arcks-open {
      display:flex;
      align-items:center;
      justify-content:center;
      width:54px;
      height:54px;
      border-radius:999px;
      background:rgba(255,255,255,0.13);
      border:1px solid rgba(255,255,255,0.13);
      color:rgba(255,255,255,0.82);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
      cursor:pointer;
      transition: background 0.15s ease, transform 0.15s ease, color 0.15s ease;
    }

    .arcks-share:hover,
    .arcks-open:hover {
      background: rgba(255,255,255,0.18);
      color: rgba(255,255,255,0.96);
      transform: translateY(-1px);
    }

    .arcks-share svg,
    .arcks-open svg {
      width:25px;
      height:25px;
    }

    /* Skeleton */
    .arcks-skeleton { animation: arcks-pulse 1.8s ease-in-out infinite; }
    .arcks-skeleton-header { height:16px; width:44%; background:rgba(255,255,255,0.07); border-radius:4px; margin-bottom:18px; }
    .arcks-skeleton-title { height:28px; background:rgba(255,255,255,0.1); border-radius:6px; margin-bottom:20px; width:86%; }
    .arcks-skeleton-line { height:22px; background:rgba(255,255,255,0.055); border-radius:5px; margin-bottom:14px; }
    .arcks-skeleton-line:nth-child(2) { width:100%; }
    .arcks-skeleton-line:nth-child(3) { width:90%; }
    .arcks-skeleton-line:nth-child(4) { width:65%; }

    @keyframes arcks-pulse { 0%,100% { opacity:0.35; } 50% { opacity:0.75; } }

    .arcks-error { color:rgba(255,140,140,0.9); font-size:16px; text-align:left; line-height:1.5; font-weight:650; }

    @media (max-width: 560px) {
      .arcks-popup {
        width: calc(100vw - 24px);
        min-height: 292px;
        padding: 22px 20px 72px;
      }

      .arcks-headline { font-size: 19px; }
      .arcks-insight { font-size: 17px; gap: 11px; }
    }
  `;

  // ===== POPUP CREATION =====
  function createPopupContainer() {
    if (popup) return;

    popup = document.createElement('div');
    popup.id = 'arcks-popup-container';
    shadowRoot = popup.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = POPUP_STYLES;
    shadowRoot.appendChild(style);

    document.body.appendChild(popup);

    // Global keyboard: Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePopup(true);
    });
  }

  // ===== POSITIONING =====
  function positionPopup(popupEl, linkRect) {
    const PADDING = 12;
    const VIEWPORT_W = window.innerWidth;
    const VIEWPORT_H = window.innerHeight;

    // Get popup dimensions (need to temporarily make it visible for layout)
    const wasVisible = popupEl.classList.contains('visible');
    if (!wasVisible) {
      popupEl.style.visibility = 'hidden';
      popupEl.classList.add('visible');
    }
    const popupW = popupEl.offsetWidth || 512;
    const popupH = popupEl.offsetHeight || 200;
    if (!wasVisible) {
      popupEl.classList.remove('visible');
      popupEl.style.visibility = '';
    }

    // Position below the link, horizontally centered
    let left = linkRect.left + linkRect.width / 2 - popupW / 2;
    let top = linkRect.bottom + PADDING;

    // Clamp to viewport
    left = Math.max(PADDING, Math.min(left, VIEWPORT_W - popupW - PADDING));

    // If below exceeds viewport, show above
    if (top + popupH > VIEWPORT_H - PADDING) {
      top = Math.max(PADDING, linkRect.top - popupH - PADDING);
    }

    popupEl.style.left = `${left}px`;
    popupEl.style.top = `${top}px`;
  }

  // ===== LOADING / CONTENT / ERROR =====
  function showLoading(url, linkRect) {
    createPopupContainer();
    clearHideTimeout();

    const hostname = getHostname(url);
    const popupEl = document.createElement('div');
    popupEl.className = 'arcks-popup';
    popupEl.innerHTML = `
      <div class="arcks-skeleton">
        <div class="arcks-skeleton-header"></div>
        <div class="arcks-skeleton-title"></div>
        <div class="arcks-skeleton-line"></div>
        <div class="arcks-skeleton-line"></div>
        <div class="arcks-skeleton-line"></div>
      </div>
      <div class="arcks-actions">
        <a class="arcks-open" href="${escapeHtml(url)}" target="_blank" rel="noopener nofollow" aria-label="Open ${escapeHtml(hostname)}" title="Open">
          ${openIcon()}
        </a>
      </div>
    `;

    shadowRoot.querySelector('.arcks-popup')?.remove();
    shadowRoot.appendChild(popupEl);

    // Position and reveal
    requestAnimationFrame(() => {
      positionPopup(popupEl, linkRect);
      popupEl.classList.add('visible');
    });

    // Hover persistence on popup
    popupEl.addEventListener('mouseenter', () => { isPopupHovered = true; clearHideTimeout(); });
    popupEl.addEventListener('mouseleave', () => { isPopupHovered = false; scheduleHide(); });

    return popupEl;
  }

  function showSummary(popupEl, data, url) {
    if (!popupEl || !shadowRoot?.contains(popupEl)) return;

    const hostname = getHostname(url);
    const title = data.title || data.headline || hostname;
    const headline = data.headline || data.summary || data.description || title;
    const bullets = normalizeBullets(data);

    popupEl.innerHTML = `
      <div class="arcks-eyebrow">
        <img class="arcks-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32" alt="">
        <span class="arcks-host">${escapeHtml(hostname)}</span>
      </div>
      <h3 class="arcks-headline">${formatInsight(headline)}</h3>
      <ul class="arcks-insights">
        ${bullets.map((bullet, index) => `
          <li class="arcks-insight">
            ${insightIcon(index)}
            <span>${formatInsight(bullet)}</span>
          </li>
        `).join('')}
      </ul>
      <div class="arcks-actions">
        <button class="arcks-share" type="button" aria-label="Share preview" title="Share">
          ${shareIcon()}
        </button>
        <a class="arcks-open" href="${escapeHtml(url)}" target="_blank" rel="noopener nofollow" aria-label="Open ${escapeHtml(title)}" title="Open">
          ${openIcon()}
        </a>
      </div>
    `;

    const shareButton = popupEl.querySelector('.arcks-share');
    shareButton?.addEventListener('click', async () => {
      const shareText = `${stripHtml(title)}\n${stripHtml(headline)}\n${url}`;
      try {
        if (navigator.share) {
          await navigator.share({ title: stripHtml(title), text: stripHtml(headline), url });
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(shareText);
          shareButton.title = 'Copied';
        }
      } catch {
        // User canceled native share or clipboard was unavailable.
      }
    });
  }

  function showError(popupEl, message) {
    if (!popupEl || !shadowRoot?.contains(popupEl)) return;
    const skeleton = popupEl.querySelector('.arcks-skeleton');
    if (skeleton) {
      skeleton.innerHTML = `<div class="arcks-error">${escapeHtml(message)}</div>`;
    }
  }

  // ===== HIDE POPUP (graceful) =====
  function hidePopup(force = false) {
    if (!force && isPopupHovered) return;

    const el = shadowRoot?.querySelector('.arcks-popup:not(.hiding)');
    if (!el) return;

    el.classList.add('hiding');
    el.classList.remove('visible');

    setTimeout(() => {
      if (el.classList.contains('hiding')) {
        el.remove();
      }
    }, 200);
  }

  function scheduleHide() {
    // Grace period before hiding to allow mouse to move to popup
    clearHideTimeout();
    hideTimeout = setTimeout(() => hidePopup(), 150);
  }

  function clearHideTimeout() {
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
  }

  // ===== CLIENT-SIDE CACHE =====
  function getCached(url) {
    const entry = urlCache.get(url);
    if (entry && (Date.now() - entry.timestamp) < CACHE_DURATION) {
      return { title: entry.title, headline: entry.headline, summary: entry.summary, bullets: entry.bullets };
    }
    if (entry) urlCache.delete(url);
    return null;
  }

  function setCache(url, data) {
    urlCache.set(url, { ...data, timestamp: Date.now() });
  }

  // ===== BACKGROUND CALL =====
  function callBackground(url) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Request timed out')), 15000);

      chrome.runtime.sendMessage({ action: 'getSummary', url }, (data) => {
        clearTimeout(to);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (data?.error) { reject(new Error(data.error)); return; }
        resolve(data);
      });
    });
  }

  // ===== LINK HOVER HANDLER =====
  async function handleLinkHover(link) {
    if (!settings.enabled) return;

    const url = link.href;
    if (!isValidUrl(url)) return;
    if (!isSearchResultLink(link)) return;
    if (url === currentHoveredLink?.href) return;

    currentHoveredLink = link;
    const requestId = ++currentRequestId;
    const linkRect = link.getBoundingClientRect();
    const popupEl = showLoading(url, linkRect);

    // Check client-side cache
    const cached = getCached(url);
    if (cached) {
      showSummary(popupEl, cached, url);
      return;
    }

    try {
      const data = await callBackground(url);
      if (currentRequestId !== requestId) return; // stale
      if (data && (data.title || data.summary || data.description)) {
        setCache(url, {
          title: data.title,
          headline: data.headline,
          summary: data.summary,
          bullets: data.bullets
        });
        showSummary(popupEl, data, url);
      } else {
        showError(popupEl, 'Unable to generate preview');
      }
    } catch (error) {
      if (currentRequestId !== requestId) return;
      showError(popupEl, error.message || 'Failed to load preview');
    }
  }

  // ===== EVENT HANDLERS =====
  function onMouseEnter(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;

    clearTimeout(hoverTimeout);
    clearHideTimeout();

    // If already showing for this link, don't restart
    if (currentHoveredLink?.href === link.href) {
      isPopupHovered = false;
      return;
    }

    hoverTimeout = setTimeout(() => {
      handleLinkHover(link);
    }, settings.hoverDelay);
  }

  function onMouseLeave(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;

    clearTimeout(hoverTimeout);
    currentHoveredLink = null;
    scheduleHide();
  }

  // ===== UTILITIES =====
  function isValidUrl(href) {
    if (!href) return false;
    try { return /^https?:/.test(new URL(href).protocol); }
    catch { return false; }
  }

  function isSearchResultLink(link) {
    if (!link.href) return false;
    try {
      const hostname = new URL(link.href).hostname.toLowerCase();
      if (hostname.includes('google.')) return false;
      const selectors = ['#search', '#rso', '.g', '[data-hveid]', '.yuRUbf', '.tF2Cxc'];
      return selectors.some(sel => link.closest(sel) !== null);
    } catch { return false; }
  }

  function getHostname(urlStr) {
    try { return new URL(urlStr).hostname; } catch { return urlStr; }
  }

  function truncateUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const path = u.pathname + u.search;
      const max = 80;
      return (u.origin + path).length > max ? (u.origin + '/...') : (u.origin + path);
    } catch { return urlStr; }
  }

  function normalizeBullets(data) {
    if (Array.isArray(data.bullets) && data.bullets.length) {
      return data.bullets.slice(0, 4).map(String).filter(Boolean);
    }

    const text = data.summary || data.description || '';
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);

    if (sentences.length) {
      return sentences.slice(0, 4);
    }

    return ['Preview is ready. Open the page for the full context.'];
  }

  function formatInsight(text) {
    const cleanText = escapeHtml(String(text || ''));
    return cleanText.replace(/^([^:]{3,42}:)/, '<strong>$1</strong>');
  }

  function stripHtml(text) {
    const div = document.createElement('div');
    div.innerHTML = String(text || '');
    return div.textContent || '';
  }

  function insightIcon(index) {
    const icons = [
      '<svg class="arcks-insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 8h10M7 12h7M8 19l-4 3v-17a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '<svg class="arcks-insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M16 11a4 4 0 1 0-8 0M5 21a7 7 0 0 1 14 0M17 8a3 3 0 0 1 3 3M21 21a5 5 0 0 0-3-4.58M7 8a3 3 0 0 0-3 3M3 21a5 5 0 0 1 3-4.58" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '<svg class="arcks-insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h.01M12 14h.01M16 14h.01" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '<svg class="arcks-insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12l-8 8-9-9V4h7zM7.5 7.5h.01" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    ];
    return icons[index % icons.length];
  }

  function shareIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4M8 8l4-4 4 4M6 14v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function openIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 17 17 7M9 7h8v8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== INITIALIZE =====
  document.addEventListener('mouseover', onMouseEnter, { passive: true });
  document.addEventListener('mouseout', onMouseLeave, { passive: true });
  createPopupContainer();
})();
