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
  let settings = { hoverDelay: 800, enabled: true, workerUrl: '' };
  let isPopupHovered = false;
  let abortController = null;
  let currentRequestId = 0;

  // Client-side cache: URL -> { title, summary, timestamp }
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
      width: 360px;
      max-width: 92vw;
      background: rgba(10, 10, 12, 0.94);
      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 16px;
      box-shadow:
        0 24px 80px rgba(0, 0, 0, 0.65),
        0 0 0 1px rgba(255,255,255,0.03),
        inset 0 1px 0 rgba(255,255,255,0.04);
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #ffffff;
      opacity: 0;
      transform: translateY(6px) scale(0.96) perspective(1px);
      transition:
        opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1),
        transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto;
      transform-origin: top center;
    }

    .arcks-popup.visible {
      opacity: 1;
      transform: translateY(0) scale(1) perspective(1px);
    }

    .arcks-popup.hiding {
      opacity: 0 !important;
      transform: translateY(4px) scale(0.97) perspective(1px) !important;
      transition: opacity 0.18s cubic-bezier(0.22, 1, 0.36, 1),
                  transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .arcks-header { display:flex; align-items:center; gap:8px; margin-bottom:12px; }

    .arcks-favicon { width:16px; height:16px; border-radius:4px; flex-shrink:0; }

    .arcks-host {
      font-size:11px; font-weight:500; color:rgba(255,255,255,0.45);
      letter-spacing:0.3px; text-transform:uppercase;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }

    .arcks-title {
      font-size:15px; font-weight:600; color:rgba(255,255,255,0.95);
      margin:0 0 10px 0; line-height:1.45;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    }

    .arcks-summary {
      font-size:13px; color:rgba(255,255,255,0.65);
      margin:0 0 16px 0; line-height:1.6;
      display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden;
    }

    .arcks-cta {
      display:flex; align-items:center; gap:8px; padding:10px 14px;
      background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06);
      border-radius:10px; text-decoration:none; color:rgba(255,255,255,0.45);
      font-size:12px; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }

    .arcks-cta:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.7);
    }

    .arcks-cta .arcks-favicon { width:14px; height:14px; }

    .arcks-url { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }

    .arcks-arrow { width:14px; height:14px; opacity:0.5; flex-shrink:0; transition: opacity 0.15s ease, transform 0.15s ease; }

    .arcks-cta:hover .arcks-arrow { opacity:0.8; transform: translateX(1px); }

    /* Skeleton */
    .arcks-skeleton { animation: arcks-pulse 1.8s ease-in-out infinite; }
    .arcks-skeleton-header { height:11px; width:55%; background:rgba(255,255,255,0.07); border-radius:3px; margin-bottom:14px; }
    .arcks-skeleton-title { height:17px; background:rgba(255,255,255,0.1); border-radius:5px; margin-bottom:11px; width:100%; }
    .arcks-skeleton-line { height:12px; background:rgba(255,255,255,0.055); border-radius:4px; margin-bottom:8px; }
    .arcks-skeleton-line:nth-child(2) { width:100%; }
    .arcks-skeleton-line:nth-child(3) { width:90%; }
    .arcks-skeleton-line:nth-child(4) { width:65%; }

    @keyframes arcks-pulse { 0%,100% { opacity:0.35; } 50% { opacity:0.75; } }

    .arcks-error { color:rgba(255,120,120,0.85); font-size:13px; text-align:center; line-height:1.5; }
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
    const popupW = popupEl.offsetWidth || 360;
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
      <a class="arcks-cta" href="${escapeHtml(url)}" target="_blank" rel="noopener nofollow">
        <img class="arcks-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32" alt="">
        <span class="arcks-url">${escapeHtml(hostname)}</span>
        <svg class="arcks-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M4 12l8-8M6 2h8v8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </a>
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
    const title = data.title || hostname;
    const summary = data.summary || data.description || 'No summary available.';

    popupEl.innerHTML = `
      <div class="arcks-header">
        <img class="arcks-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32" alt="">
        <span class="arcks-host">${escapeHtml(hostname)}</span>
      </div>
      <h3 class="arcks-title">${escapeHtml(title)}</h3>
      <p class="arcks-summary">${escapeHtml(summary)}</p>
      <a class="arcks-cta" href="${escapeHtml(url)}" target="_blank" rel="noopener nofollow">
        <img class="arcks-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32" alt="">
        <span class="arcks-url">${escapeHtml(truncateUrl(url))}</span>
        <svg class="arcks-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M4 12l8-8M6 2h8v8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </a>
    `;

    popupEl.addEventListener('mouseenter', () => { isPopupHovered = true; clearHideTimeout(); });
    popupEl.addEventListener('mouseleave', () => { isPopupHovered = false; scheduleHide(); });
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
      return { title: entry.title, summary: entry.summary };
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

    // Cancel previous request
    if (abortController) abortController.abort();
    abortController = new AbortController();

    try {
      const data = await callBackground(url);
      if (currentRequestId !== requestId) return; // stale
      if (data && (data.title || data.summary || data.description)) {
        setCache(url, { title: data.title, summary: data.summary });
        showSummary(popupEl, data, url);
      } else {
        showError(popupEl, 'Unable to generate preview');
      }
    } catch (error) {
      if (currentRequestId !== requestId) return;
      showError(popupEl, error.message || 'Failed to load preview');
    }

    abortController = null;
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
