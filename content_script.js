// content_script.js – сбор элементов, подсветка, выполнение действий
(function () {
  if (window.__aiTesterInjected) return;
  window.__aiTesterInjected = true;

  let cachedElements = [];

  function collectInteractiveElements() {
    const selectors = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"]';
    return Array.from(document.querySelectorAll(selectors)).filter(el => {
      if (el.offsetParent === null && !(el.tagName === 'INPUT' && el.type === 'hidden')) return false;
      const text = getElementText(el);
      return text && text.trim().length > 0;
    });
  }

  function getElementText(el) {
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || el.innerText?.trim() || el.value || '';
  }

  let lastHighlighted = null;
  function highlightElement(el) {
    if (lastHighlighted) lastHighlighted.style.outline = '';
    if (el) {
      el.style.outline = '3px solid #ff4d4d';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      lastHighlighted = el;
    }
  }

  function getVisibleTexts() {
    const candidates = new Set();
    document.querySelectorAll('body *').forEach(el => {
      if (el.offsetParent !== null || el.tagName === 'BODY') {
        const text = (el.innerText || '').trim();
        if (text) {
          text.split('\n').forEach(line => {
            const t = line.trim();
            if (t.length > 1) candidates.add(t);
          });
        }
        const aria = el.getAttribute('aria-label');
        if (aria) candidates.add(aria.trim());
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) candidates.add(placeholder.trim());
      }
    });
    return Array.from(candidates);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'COLLECT_CANDIDATES') {
      cachedElements = collectInteractiveElements();
      const candidates = cachedElements.map((el, idx) => ({
        index: idx,
        text: getElementText(el),
      })).filter(c => c.text);
      sendResponse({ candidates });
    } else if (message.type === 'GET_VISIBLE_TEXTS') {
      sendResponse({ pageTexts: getVisibleTexts() });
    } else if (message.type === 'PERFORM_ACTION') {
      (async () => {
        const { action, payload } = message;
        if (action === 'click') {
          const el = cachedElements[payload.index];
          if (el) {
            highlightElement(el);
            el.click();
            await new Promise(r => setTimeout(r, 1000));
          }
        } else if (action === 'type') {
          const el = cachedElements[payload.index];
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            highlightElement(el);
            el.focus();
            el.value = '';
            el.value = payload.value || '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
          }
        }
        sendResponse({ done: true });
      })();
      return true; // асинхронный ответ
    }
  });
})();