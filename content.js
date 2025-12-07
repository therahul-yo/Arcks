/**
 * Arcks - Content Script
 * Hover detection, Shadow DOM popup injection, content sanitization
 */

(function() {
  'use strict';
  
  // State
  let currentHoveredLink = null;
  let hoverTimeout = null;
  let popup = null;
  let shadowRoot = null;
  let settings = { hoverDelay: 800, enabled: true };
  let isPopupHovered = false;
  
  // Load settings
  chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
    if (response) {
      settings = response;
    }
  });
  
  // Create Shadow DOM container
  function createPopupContainer() {
    if (popup) return;
    
    popup = document.createElement('div');
    popup.id = 'arcks-popup-container';
    shadowRoot = popup.attachShadow({ mode: 'closed' });
    
    // Inject styles into shadow DOM
    const style = document.createElement('style');
    style.textContent = `
      .arcks-popup {
        position: fixed;
        z-index: 2147483647;
        width: 320px;
        background: rgba(0, 0, 0, 0.98);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #ffffff;
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        pointer-events: auto;
      }
      
      .arcks-popup.visible {
        opacity: 1;
        transform: translateY(0);
      }
      
      .arcks-title {
        font-size: 15px;
        font-weight: 600;
        color: #ffffff;
        margin: 0 0 10px 0;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      
      .arcks-summary {
        font-size: 13px;
        color: rgba(255, 255, 255, 0.7);
        margin: 0 0 14px 0;
        line-height: 1.6;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      
      .arcks-link {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        text-decoration: none;
        color: rgba(255, 255, 255, 0.5);
        font-size: 12px;
        transition: background 0.15s ease;
      }
      
      .arcks-link:hover {
        background: rgba(255, 255, 255, 0.1);
      }
      
      .arcks-favicon {
        width: 14px;
        height: 14px;
        border-radius: 3px;
        flex-shrink: 0;
      }
      
      .arcks-url {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }
      
      /* Loading skeleton */
      .arcks-skeleton {
        animation: arcks-pulse 1.5s ease-in-out infinite;
      }
      
      .arcks-skeleton-title {
        height: 18px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        margin-bottom: 12px;
        width: 80%;
      }
      
      .arcks-skeleton-line {
        height: 12px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 4px;
        margin-bottom: 8px;
      }
      
      .arcks-skeleton-line:nth-child(2) { width: 100%; }
      .arcks-skeleton-line:nth-child(3) { width: 90%; }
      .arcks-skeleton-line:nth-child(4) { width: 60%; }
      
      @keyframes arcks-pulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.8; }
      }
      
      .arcks-error {
        color: rgba(255, 100, 100, 0.8);
        font-size: 13px;
        text-align: center;
      }
    `;
    shadowRoot.appendChild(style);
    
    document.body.appendChild(popup);
  }
  
  /**
   * Sanitize HTML content - strip dangerous tags
   */
  function sanitizeContent(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Remove dangerous elements
    const dangerousTags = ['script', 'style', 'svg', 'img', 'iframe', 'object', 'embed', 'noscript'];
    dangerousTags.forEach(tag => {
      doc.querySelectorAll(tag).forEach(el => el.remove());
    });
    
    // Get text content, limit to 5000 chars
    let text = doc.body.innerText || doc.body.textContent || '';
    text = text.replace(/\s+/g, ' ').trim();
    
    // Limit to 5000 characters for API efficiency
    if (text.length > 5000) {
      text = text.substring(0, 5000) + '...';
    }
    
    return text;
  }
  
  /**
   * Position popup near the link
   */
  function positionPopup(popupEl, linkRect) {
    const padding = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Get popup dimensions
    const popupRect = popupEl.getBoundingClientRect();
    
    // Calculate position - prefer below and to the right
    let left = linkRect.left;
    let top = linkRect.bottom + padding;
    
    // Adjust if goes off right edge
    if (left + popupRect.width > viewportWidth - padding) {
      left = viewportWidth - popupRect.width - padding;
    }
    
    // Adjust if goes off bottom, show above instead
    if (top + popupRect.height > viewportHeight - padding) {
      top = linkRect.top - popupRect.height - padding;
    }
    
    // Ensure doesn't go off left edge
    if (left < padding) {
      left = padding;
    }
    
    // Ensure doesn't go off top
    if (top < padding) {
      top = padding;
    }
    
    popupEl.style.left = `${left}px`;
    popupEl.style.top = `${top}px`;
  }
  
  /**
   * Show loading skeleton
   */
  function showLoading(url, linkRect) {
    createPopupContainer();
    
    const hostname = new URL(url).hostname;
    const popupEl = document.createElement('div');
    popupEl.className = 'arcks-popup';
    popupEl.innerHTML = `
      <div class="arcks-skeleton">
        <div class="arcks-skeleton-title"></div>
        <div class="arcks-skeleton-line"></div>
        <div class="arcks-skeleton-line"></div>
        <div class="arcks-skeleton-line"></div>
      </div>
      <a class="arcks-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">
        <img class="arcks-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32" alt="">
        <span class="arcks-url">${escapeHtml(hostname)}</span>
      </a>
    `;
    
    // Clear previous content
    const existingPopup = shadowRoot.querySelector('.arcks-popup');
    if (existingPopup) {
      existingPopup.remove();
    }
    
    shadowRoot.appendChild(popupEl);
    
    // Position and animate in
    positionPopup(popupEl, linkRect);
    requestAnimationFrame(() => {
      popupEl.classList.add('visible');
    });
    
    // Add hover listeners to popup
    popupEl.addEventListener('mouseenter', () => {
      isPopupHovered = true;
    });
    
    popupEl.addEventListener('mouseleave', () => {
      isPopupHovered = false;
      hidePopup();
    });
    
    return popupEl;
  }
  
  /**
   * Show summary content
   */
  function showSummary(popupEl, data, url) {
    if (!popupEl || !shadowRoot.contains(popupEl)) return;
    
    const hostname = new URL(url).hostname;
    const title = data.title || hostname;
    const summary = data.summary || data.description || 'No summary available.';
    
    popupEl.innerHTML = `
      <h3 class="arcks-title">${escapeHtml(title)}</h3>
      <p class="arcks-summary">${escapeHtml(summary)}</p>
      <a class="arcks-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">
        <img class="arcks-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32" alt="">
        <span class="arcks-url">${escapeHtml(hostname)}</span>
      </a>
    `;
    
    // Re-add hover listeners
    popupEl.addEventListener('mouseenter', () => {
      isPopupHovered = true;
    });
    
    popupEl.addEventListener('mouseleave', () => {
      isPopupHovered = false;
      hidePopup();
    });
  }
  
  /**
   * Show error state
   */
  function showError(popupEl, message) {
    if (!popupEl || !shadowRoot.contains(popupEl)) return;
    
    const skeleton = popupEl.querySelector('.arcks-skeleton');
    if (skeleton) {
      skeleton.innerHTML = `<div class="arcks-error">${escapeHtml(message)}</div>`;
    }
  }
  
  /**
   * Hide popup
   */
  function hidePopup() {
    if (isPopupHovered) return;
    
    const popupEl = shadowRoot?.querySelector('.arcks-popup');
    if (popupEl) {
      popupEl.classList.remove('visible');
      setTimeout(() => {
        if (!popupEl.classList.contains('visible')) {
          popupEl.remove();
        }
      }, 200);
    }
  }
  
  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * Check if URL is valid for preview
   */
  function isValidUrl(href) {
    if (!href) return false;
    try {
      const url = new URL(href);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }
  
  /**
   * Check if link is a Google search result (external link)
   */
  function isSearchResultLink(link) {
    const href = link.href;
    if (!href) return false;
    
    try {
      const url = new URL(href);
      const hostname = url.hostname.toLowerCase();
      
      // Skip Google's own domains
      if (hostname.includes('google.')) return false;
      
      // Check if link is inside search results area
      const searchResultSelectors = ['#search', '#rso', '.g', '[data-hveid]', '.yuRUbf', '.tF2Cxc'];
      return searchResultSelectors.some(selector => link.closest(selector) !== null);
      
    } catch {
      return false;
    }
  }
  
  /**
   * Handle link hover
   */
  async function handleLinkHover(link) {
    if (!settings.enabled) return;
    
    const url = link.href;
    if (!isValidUrl(url)) return;
    if (!isSearchResultLink(link)) return;
    if (url === currentHoveredLink?.href) return;
    
    currentHoveredLink = link;
    
    const linkRect = link.getBoundingClientRect();
    const popupEl = showLoading(url, linkRect);
    
    try {
      const response = await fetch(url, { 
        mode: 'cors',
        credentials: 'omit'
      }).catch(() => null);
      
      let content = '';
      if (response && response.ok) {
        const html = await response.text();
        content = sanitizeContent(html);
      }
      
      chrome.runtime.sendMessage({
        action: 'getSummary',
        url: url,
        content: content
      }, (data) => {
        if (data && data.error) {
          showError(popupEl, data.error);
        } else if (data) {
          showSummary(popupEl, data, url);
        }
      });
      
    } catch (error) {
      console.error('Arcks: Error:', error);
      showError(popupEl, 'Failed to load preview');
    }
  }
  
  // Debounced hover handler
  function onMouseEnter(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    
    clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(() => {
      handleLinkHover(link);
    }, settings.hoverDelay);
  }
  
  function onMouseLeave(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    
    clearTimeout(hoverTimeout);
    currentHoveredLink = null;
    
    setTimeout(() => {
      if (!isPopupHovered) {
        hidePopup();
      }
    }, 100);
  }
  
  // Initialize
  document.addEventListener('mouseover', onMouseEnter, { passive: true });
  document.addEventListener('mouseout', onMouseLeave, { passive: true });
  
  createPopupContainer();
  
})();
