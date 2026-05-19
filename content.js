/**
 * Arcks - Content Script
 * Arc-browser-style hover previews: solid dark card with headline + icon bullets.
 */

(function() {
  'use strict';

  // ===== CONSTANTS =====
  const CACHE_DURATION = 10 * 60 * 1000;       // 10 min — match worker KV TTL ceiling
  const POPUP_Z_INDEX = 2147483647;            // max int32; sits above everything reasonable
  const POPUP_FADE_MS = 220;                   // matches CSS transition duration
  const CALLBACK_TIMEOUT_MS = 12000;           // upper bound for background→worker round trip
  const HIDE_DELAY_MS = 220;                   // grace period after mouseleave

  // ===== STATE =====
  let currentHoveredLink = null;
  let hoverTimeout = null;
  let hideTimeout = null;
  let popup = null;
  let shadowRoot = null;
  let settings = { hoverDelay: 250, enabled: true, workerUrl: '' };
  let isPopupHovered = false;
  let currentRequestId = 0;
  let currentHoveredUrl = '';

  // Client-side cache: URL -> { title, summary, bullets, timestamp }
  const urlCache = new Map();

  chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
    if (response) settings = { ...settings, ...response };
  });

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in settings) settings[key] = change.newValue;
    }
  });

  // ===== ICONS (Lucide, 24x24 viewBox, 1.75 stroke) =====
  // Static SVG path geometry — not user-controlled.
  const ICON_PATHS = {
    'message-circle': 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
    'users': 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
    'calendar': 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M16 2v4 M8 2v4 M3 10h18',
    'tag': 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z M7 7h.01',
    'file-text': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
    'bookmark': 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
    'code': 'M16 18l6-6-6-6 M8 6l-6 6 6 6',
    'dollar-sign': 'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    'globe': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    'info': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 16v-4 M12 8h.01',
    'check-circle': 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01 9 11.01',
    'alert-circle': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 8v4 M12 16h.01',
    'book': 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    'star': 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    'lightbulb': 'M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12.7c.8.7 1.4 1.4 1.6 2.3h4.8c.2-.9.8-1.6 1.6-2.3A7 7 0 0 0 12 2z',
    'trending-up': 'M23 6L13.5 15.5 8.5 10.5 1 18 M17 6h6v6',
    'shield': 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    'zap': 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
    'map-pin': 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
    'clock': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 6v6l4 2'
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function buildIconSvg(name, className) {
    const d = ICON_PATHS[name] || ICON_PATHS['info'];
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);

    // Split chained subpaths so each can be rendered as its own <path>.
    // Splitting on capital letters that start a new subpath isn't enough
    // because Lucide-style data uses spaces. Render whole `d` in one path —
    // SVG handles multiple M commands within a single d.
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  function buildShareIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7 M16 6L12 2 8 6 M12 2v13');
    svg.appendChild(p);
    return svg;
  }

  // ===== STYLES =====
  const POPUP_STYLES = `
    .arcks-popup {
      position: fixed;
      z-index: ${POPUP_Z_INDEX};
      width: 360px;
      max-width: min(88vw, 360px);
      min-height: 164px;
      max-height: 340px;
      background:
        linear-gradient(180deg, rgba(0, 0, 0, 0.98), rgba(0, 0, 0, 0.9)),
        rgba(0, 0, 0, 0.94);
      backdrop-filter: blur(34px) saturate(165%);
      -webkit-backdrop-filter: blur(34px) saturate(165%);
      border: 1px solid rgba(255, 255, 255, 0.055);
      border-radius: 12px;
      box-shadow:
        0 28px 90px rgba(0, 0, 0, 0.74),
        0 0 0 1px rgba(255,255,255,0.03),
        inset 0 1px 0 rgba(255,255,255,0.05);
      padding: 16px 16px 48px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #ffffff;
      opacity: 0;
      filter: blur(5px);
      transform: translate3d(0, 8px, 0) scale(0.975);
      transition:
        opacity 0.22s cubic-bezier(0.2, 0, 0, 1),
        filter 0.22s cubic-bezier(0.2, 0, 0, 1),
        transform 0.28s cubic-bezier(0.2, 0, 0, 1);
      will-change: opacity, filter, transform;
      pointer-events: auto;
      transform-origin: top center;
      overflow: hidden;
    }

    .arcks-popup.visible {
      opacity: 1;
      filter: blur(0);
      transform: translate3d(0, 0, 0) scale(1);
    }

    .arcks-popup.hiding {
      opacity: 0 !important;
      filter: blur(4px) !important;
      transform: translate3d(0, 5px, 0) scale(0.985) !important;
      transition: opacity 0.18s cubic-bezier(0.2, 0, 0, 1),
                  filter 0.18s cubic-bezier(0.2, 0, 0, 1),
                  transform 0.2s cubic-bezier(0.2, 0, 0, 1);
    }

    .arcks-eyebrow {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 8px;
      min-width: 0;
    }

    .arcks-favicon { width:15px; height:15px; border-radius:3px; flex-shrink:0; }

    .arcks-host {
      font-size:11px; font-weight:650; color:rgba(255,255,255,0.68);
      letter-spacing:0; text-transform:none;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }

    .arcks-headline {
      font-size:16px;
      font-weight:760;
      color:rgba(255,255,255,0.93);
      margin:0 0 11px 0;
      line-height:1.32;
      letter-spacing:0;
      display:-webkit-box;
      -webkit-line-clamp:3;
      -webkit-box-orient:vertical;
      overflow:hidden;
    }

    .arcks-insights {
      display: grid;
      gap: 9px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .arcks-insight {
      display: grid;
      grid-template-columns: 16px 1fr;
      gap: 8px;
      align-items: start;
      font-size: 13.5px;
      line-height: 1.4;
      font-weight: 650;
      color: rgba(255,255,255,0.82);
      letter-spacing: 0;
    }

    .arcks-insight span {
      display: block;
      overflow-wrap: anywhere;
      word-break: normal;
    }

    .arcks-insight strong {
      color: rgba(255,255,255,0.92);
      font-weight: 780;
    }

    .arcks-insight-icon {
      width: 15px;
      height: 15px;
      color: rgba(255,255,255,0.34);
      margin-top: 1px;
    }

    .arcks-actions {
      position:absolute;
      right:10px;
      bottom:10px;
      display:flex;
      gap:7px;
      align-items:center;
    }

    .arcks-share,
    .arcks-open {
      display:flex;
      align-items:center;
      justify-content:center;
      width:30px;
      height:30px;
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

    .arcks-share:focus-visible,
    .arcks-open:focus-visible {
      outline: 2px solid rgba(122, 184, 255, 0.95);
      outline-offset: 2px;
      background: rgba(255,255,255,0.2);
      color: #fff;
    }

    .arcks-share:focus:not(:focus-visible),
    .arcks-open:focus:not(:focus-visible) {
      outline: none;
    }

    .arcks-share svg,
    .arcks-open svg {
      width:15px;
      height:15px;
    }

    /* Skeleton */
    .arcks-skeleton { animation: arcks-pulse 1.8s ease-in-out infinite; }
    .arcks-skeleton-header { height:9px; width:44%; background:rgba(255,255,255,0.07); border-radius:4px; margin-bottom:11px; }
    .arcks-skeleton-title { height:16px; background:rgba(255,255,255,0.1); border-radius:5px; margin-bottom:12px; width:86%; }
    .arcks-skeleton-line { height:11px; background:rgba(255,255,255,0.055); border-radius:4px; margin-bottom:8px; }
    .arcks-skeleton-line:nth-child(2) { width:100%; }
    .arcks-skeleton-line:nth-child(3) { width:90%; }
    .arcks-skeleton-line:nth-child(4) { width:65%; }

    .arcks-skeleton-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }

    .arcks-error { color:rgba(255,140,140,0.9); font-size:12px; text-align:left; line-height:1.35; font-weight:650; }

    @media (max-width: 560px) {
      .arcks-popup {
        width: calc(100vw - 24px);
        min-height: 164px;
        padding: 16px 16px 48px;
      }

      .arcks-headline { font-size: 15px; }
      .arcks-insight { font-size: 13px; gap: 7px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .arcks-popup,
      .arcks-popup.hiding {
        transition: opacity 0.001s linear !important;
        filter: none !important;
        transform: none !important;
      }
      .arcks-popup.hiding { opacity: 0 !important; }
      .arcks-share:hover,
      .arcks-open:hover { transform: none; }
      .arcks-skeleton { animation: none !important; }
    }

    /* ─── Light theme: keyed off OS preference ─── */
    @media (prefers-color-scheme: light) {
      .arcks-popup {
        background:
          linear-gradient(180deg, rgba(255,255,255,0.985), rgba(252,251,248,0.95)),
          rgba(255,255,255,0.98);
        border: 1px solid rgba(17,17,17,0.08);
        color: #161616;
        box-shadow:
          0 28px 90px rgba(17,17,17,0.16),
          0 0 0 1px rgba(17,17,17,0.04),
          inset 0 1px 0 rgba(255,255,255,0.9);
      }
      .arcks-host       { color: rgba(17,17,17,0.62); }
      .arcks-headline   { color: rgba(17,17,17,0.92); }
      .arcks-insight    { color: rgba(17,17,17,0.78); }
      .arcks-insight strong { color: rgba(17,17,17,0.94); }
      .arcks-insight-icon  { color: rgba(17,17,17,0.42); }

      .arcks-share,
      .arcks-open {
        background: rgba(17,17,17,0.06);
        border: 1px solid rgba(17,17,17,0.1);
        color: rgba(17,17,17,0.7);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.5);
      }
      .arcks-share:hover,
      .arcks-open:hover {
        background: rgba(17,17,17,0.1);
        color: rgba(17,17,17,0.95);
      }
      .arcks-share:focus-visible,
      .arcks-open:focus-visible {
        outline: 2px solid rgba(40, 110, 220, 0.85);
        background: rgba(17,17,17,0.1);
        color: rgba(17,17,17,0.96);
      }

      .arcks-skeleton-header { background: rgba(17,17,17,0.06); }
      .arcks-skeleton-title  { background: rgba(17,17,17,0.09); }
      .arcks-skeleton-line   { background: rgba(17,17,17,0.05); }

      .arcks-error { color: #b3261e; }
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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePopup(true);
    });
  }

  // ===== POSITIONING =====
  function positionPopup(popupEl, linkRect) {
    const PADDING = 12;
    const VIEWPORT_W = window.innerWidth;
    const VIEWPORT_H = window.innerHeight;

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

    let left = linkRect.left;
    let top = linkRect.bottom + 6;

    left = Math.max(PADDING, Math.min(left, VIEWPORT_W - popupW - PADDING));

    if (top + popupH > VIEWPORT_H - PADDING) {
      top = Math.max(PADDING, linkRect.top - popupH - 6);
    }

    popupEl.style.left = `${left}px`;
    popupEl.style.top = `${top}px`;
  }

  // ===== DOM BUILDERS =====
  function attachHoverHandlers(popupEl) {
    popupEl.addEventListener('mouseenter', () => { isPopupHovered = true; clearHideTimeout(); });
    popupEl.addEventListener('mouseleave', () => { isPopupHovered = false; scheduleHide(); });
  }

  function buildSkeletonRow() {
    const row = document.createElement('div');
    row.className = 'arcks-skeleton-row';

    const dot = document.createElement('div');
    dot.className = 'arcks-skeleton-dot';
    row.appendChild(dot);

    const lines = document.createElement('div');
    lines.className = 'arcks-skeleton-lines';

    const l1 = document.createElement('div');
    l1.className = 'arcks-skeleton-line short';
    const l2 = document.createElement('div');
    l2.className = 'arcks-skeleton-line long';

    lines.appendChild(l1);
    lines.appendChild(l2);
    row.appendChild(lines);
    return row;
  }

  function buildSkeleton(popupEl) {
    while (popupEl.firstChild) popupEl.removeChild(popupEl.firstChild);

    const headline = document.createElement('div');
    headline.className = 'arcks-skeleton-headline';
    popupEl.appendChild(headline);

    for (let i = 0; i < 3; i++) {
      popupEl.appendChild(buildSkeletonRow());
    }
  }

  function buildPreview(popupEl, data, url) {
    while (popupEl.firstChild) popupEl.removeChild(popupEl.firstChild);

    const headlineText = data.headline || getHostname(url);
    const bullets = Array.isArray(data.bullets) ? data.bullets : [];

    const headline = document.createElement('p');
    headline.className = 'arcks-headline';
    headline.textContent = headlineText;
    popupEl.appendChild(headline);

    const ul = document.createElement('ul');
    ul.className = 'arcks-bullets has-share';

    bullets.forEach(b => {
      const li = document.createElement('li');
      li.className = 'arcks-bullet';

      li.appendChild(buildIconSvg(b.icon, 'arcks-bullet-icon'));

      const text = document.createElement('span');
      text.className = 'arcks-bullet-text';

      if (b.label) {
        const label = document.createElement('span');
        label.className = 'arcks-bullet-label';
        label.textContent = `${b.label}:`;
        text.appendChild(label);
        text.appendChild(document.createTextNode(' '));
      }

      text.appendChild(document.createTextNode(b.value || ''));
      li.appendChild(text);
      ul.appendChild(li);
    });

    popupEl.appendChild(ul);

    const share = document.createElement('a');
    share.className = 'arcks-share';
    share.href = url;
    share.target = '_blank';
    share.rel = 'noopener nofollow';
    share.setAttribute('aria-label', 'Open link');
    share.appendChild(buildShareIcon());
    popupEl.appendChild(share);
  }

  function buildError(popupEl, message) {
    while (popupEl.firstChild) popupEl.removeChild(popupEl.firstChild);
    const p = document.createElement('p');
    p.className = 'arcks-error';
    p.textContent = message;
    popupEl.appendChild(p);
  }

  // ===== RENDER =====
  function showLoading(linkRect, url) {
    createPopupContainer();
    if (!shadowRoot) return null; // container failed to attach (extremely rare)
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

    requestAnimationFrame(() => {
      positionPopup(popupEl, linkRect);
      popupEl.classList.add('visible');
    });

    attachHoverHandlers(popupEl);
    return popupEl;
  }

  function showPreview(popupEl, data, url) {
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
            ${insightIcon(bullet)}
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
    buildError(popupEl, friendlyError(message));
  }

  // ===== HIDE =====
  function hidePopup(force = false) {
    if (!force && isPopupHovered) return;

    const el = shadowRoot?.querySelector('.arcks-popup:not(.hiding)');
    if (!el) return;

    el.classList.add('hiding');
    el.classList.remove('visible');

    setTimeout(() => {
      if (el.classList.contains('hiding')) el.remove();
    }, POPUP_FADE_MS);
  }

  function scheduleHide() {
    clearHideTimeout();
    hideTimeout = setTimeout(() => hidePopup(), HIDE_DELAY_MS);
  }

  function clearHideTimeout() {
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
  }

  // ===== CACHE =====
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
  function callBackground(url, pageHint = '') {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Request timed out')), CALLBACK_TIMEOUT_MS);

      chrome.runtime.sendMessage({ action: 'getSummary', url, pageHint }, (data) => {
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

  // ===== HOVER HANDLER =====
  async function handleLinkHover(link) {
    if (!settings.enabled) return;

    const url = getOutboundUrl(link);
    if (!isValidUrl(url)) return;
    if (!isSearchResultLink(link, url)) return;
    if (url === currentHoveredUrl) return;

    currentHoveredLink = link;
    currentHoveredUrl = url;
    const requestId = ++currentRequestId;
    const linkRect = link.getBoundingClientRect();
    const pageHint = getLinkContext(link);
    const popupEl = showLoading(linkRect, url);
    if (!popupEl) return; // shadow DOM unavailable

    const cached = getCached(url);
    if (cached) {
      showPreview(popupEl, cached, url);
      return;
    }

    try {
      const data = await callBackground(url, pageHint);
      if (currentRequestId !== requestId) return; // stale
      if (data && (data.title || data.summary || data.description)) {
        setCache(url, {
          title: data.title,
          headline: data.headline,
          summary: data.summary,
          bullets: data.bullets
        });
        showPreview(popupEl, data, url);
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

    if (currentHoveredLink === link) {
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
    if (e.relatedTarget && link.contains(e.relatedTarget)) return;

    clearTimeout(hoverTimeout);
    currentHoveredLink = null;
    currentHoveredUrl = '';
    scheduleHide();
  }

  // ===== UTILITIES =====
  function isValidUrl(href) {
    if (!href) return false;
    try { return /^https?:/.test(new URL(href).protocol); }
    catch { return false; }
  }

  function isSearchResultLink(link, url) {
    if (!link.href || !url) return false;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (isGooglePage()) {
        if (hostname.includes('google.')) return false;
        const selectors = [
          '#search',
          '#rso',
          '#bres',
          '[role="main"]',
          '.g',
          '[data-hveid]',
          '[data-ved]',
          '[jscontroller]',
          '.yuRUbf',
          '.tF2Cxc'
        ];
        return selectors.some(sel => link.closest(sel) !== null);
      }

      if (hostname === location.hostname.toLowerCase() && link.hash && link.pathname === location.pathname) {
        return false;
      }

      if (!link.textContent.trim() && !link.querySelector('img, svg')) {
        return false;
      }

      return true;
    } catch { return false; }
  }

  function isGooglePage() {
    return location.hostname.toLowerCase().includes('google.') && location.pathname.startsWith('/search');
  }

  function getOutboundUrl(link) {
    if (!link?.href) return '';

    try {
      const parsed = new URL(link.href);
      const hostname = parsed.hostname.toLowerCase();
      const currentHost = location.hostname.toLowerCase();

      if (hostname.includes('google.') && currentHost.includes('google.')) {
        const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
        return isValidUrl(target) ? target : '';
      }

      return parsed.href;
    } catch {
      return '';
    }
  }

  function getLinkContext(link) {
    const container = link.closest('.g, [data-hveid], [data-ved], article, section, li, div') || link;
    const text = (container.innerText || link.innerText || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 1200);
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
      return data.bullets.slice(0, 3).map(String).filter(Boolean);
    }

    const text = data.summary || data.description || '';
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);

    if (sentences.length) {
      return sentences.slice(0, 3);
    }

    return ['Preview is ready. Open the page for the full context.'];
  }

  function formatInsight(text) {
    const raw = String(text || '');
    const match = raw.match(/^([^:]{3,42}:)/);
    if (match) {
      return '<strong>' + escapeHtml(match[1]) + '</strong>' + escapeHtml(raw.slice(match[1].length));
    }
    return escapeHtml(raw);
  }
  function stripHtml(text) {
    const div = document.createElement('div');
    div.innerHTML = String(text || '');
    return div.textContent || '';
  }

  function friendlyError(message) {
    const text = String(message || '');
    if (/requires more credits|can only afford|credits/i.test(text)) {
      return 'Model needs more provider credits. Pick a cheaper model or add credits in settings.';
    }
    if (/api key|not configured|unauthorized|401/i.test(text)) {
      return 'AI provider key is missing or invalid. Check the worker secret.';
    }
    if (/rate limit|429/i.test(text)) {
      return 'Preview limit reached. Try again in a minute.';
    }
    return text.replace(/^API error:\s*\d+\s*-\s*/i, '') || 'Failed to load preview.';
  }

  function insightIcon(text) {
    const raw = String(text || '').toLowerCase();
    const name =
      /price|cost|free|paid|revenue|funding|money|budget/.test(raw) ? 'dollar' :
      /date|release|launch|time|schedule|calendar|today|month|year/.test(raw) ? 'calendar' :
      /user|people|community|customer|team|developer|student/.test(raw) ? 'users' :
      /integrat|connect|api|plugin|app|workflow|channel|whatsapp|telegram/.test(raw) ? 'nodes' :
      /performance|speed|rank|benchmark|fast|scale|capable/.test(raw) ? 'gauge' :
      /security|privacy|safe|local|device|protect/.test(raw) ? 'shield' :
      /github|code|open source|developer|repo|model|technical/.test(raw) ? 'code' :
      /feature|function|capability|support|manage|send|clear|check/.test(raw) ? 'spark' :
      /experience|review|moment|describe|design|interface/.test(raw) ? 'star' :
      'info';

    const paths = {
      info: '<path d="M12 8h.01M11 12h1v4h1" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9"/>',
      dollar: '<path d="M12 2v20M17 6.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" stroke-linecap="round" stroke-linejoin="round"/>',
      calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16" stroke-linecap="round" stroke-linejoin="round"/>',
      users: '<path d="M16 11a4 4 0 1 0-8 0M5 21a7 7 0 0 1 14 0M17 8a3 3 0 0 1 3 3M21 21a5 5 0 0 0-3-4.5" stroke-linecap="round" stroke-linejoin="round"/>',
      nodes: '<circle cx="6" cy="7" r="3"/><circle cx="18" cy="7" r="3"/><circle cx="12" cy="18" r="3"/><path d="M8.5 9.5 10.5 15M15.5 9.5 13.5 15" stroke-linecap="round" stroke-linejoin="round"/>',
      gauge: '<path d="M4 14a8 8 0 1 1 16 0M12 14l4-5M8 18h8" stroke-linecap="round" stroke-linejoin="round"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke-linecap="round" stroke-linejoin="round"/>',
      code: '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" stroke-linecap="round" stroke-linejoin="round"/>',
      spark: '<path d="M13 2 4 14h7l-1 8 10-12h-7l1-8z" stroke-linecap="round" stroke-linejoin="round"/>',
      star: '<path d="m12 3 2.7 5.47 6.03.88-4.36 4.25 1.03 6-5.4-2.84-5.4 2.84 1.03-6-4.36-4.25 6.03-.88z" stroke-linecap="round" stroke-linejoin="round"/>'
    };

    return `<svg class="arcks-insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${paths[name]}</svg>`;
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

  // Hide popup on scroll / resize — link rect goes stale and a floating card
  // detached from its link is confusing UX.
  let scrollHideRaf = 0;
  function onViewportChange() {
    if (scrollHideRaf) return;
    scrollHideRaf = requestAnimationFrame(() => {
      scrollHideRaf = 0;
      clearTimeout(hoverTimeout);
      currentHoveredLink = null;
      currentHoveredUrl = '';
      hidePopup(true);
    });
  }
  window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
  window.addEventListener('resize', onViewportChange, { passive: true });

  createPopupContainer();
})();
