// content_script.js – сбор элементов, подсветка, выполнение действий

(function () {
  // Предотвращаем множественные запуски
  if (window.__aiTesterInjected) return;
  window.__aiTesterInjected = true;

  // Хранилище отобранных элементов (интерактивные)
  let cachedElements = [];

  // Сбор всех интерактивных элементов (кнопки, ссылки, поля ввода)
  function collectInteractiveElements() {
    const selectors = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"]';
    return Array.from(document.querySelectorAll(selectors)).filter(el => {
      // Фильтруем скрытые
      if (el.offsetParent === null && !(el.tagName === 'INPUT' && el.type === 'hidden')) return false;
      const text = getElementText(el);
      return text && text.trim().length > 0;
    });
  }

  // Извлечение текстового описания элемента (приоритет: aria-label, placeholder, title, innerText)
  function getElementText(el) {
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || el.innerText?.trim() || el.value || '';
  }

  // Подсветка элемента (рамка)
  let lastHighlighted = null;
  function highlightElement(el) {
    if (lastHighlighted) {
      lastHighlighted.style.outline = '';
    }
    if (el) {
      el.style.outline = '3px solid #ff4d4d';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      lastHighlighted = el;
    }
  }

  // Обработка сообщений от background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FIND_ELEMENT') {
      handleFindElement(message.description).then(sendResponse);
      return true; // асинхронный ответ
    } else if (message.type === 'PERFORM_ACTION') {
      handlePerformAction(message).then(sendResponse);
      return true;
    } else if (message.type === 'VERIFY_RESULT') {
      handleVerifyResult(message).then(sendResponse);
      return true;
    }
  });

  // Поиск элемента по описанию (возвращает кандидатов background'у для вычисления эмбеддингов)
  async function handleFindElement(description) {
    cachedElements = collectInteractiveElements();
    const candidates = cachedElements.map((el, idx) => ({
      index: idx,
      text: getElementText(el),
    })).filter(c => c.text);

    // Отправляем кандидатов в background для расчёта сходства
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'FIND_ELEMENT', description, candidates },
        (response) => {
          if (response && response.index != null && response.score > (response.threshold || 0.5)) {
            const bestEl = cachedElements[response.index];
            highlightElement(bestEl);
            resolve({
              found: true,
              index: response.index,
              text: getElementText(bestEl),
              selectorInfo: { tag: bestEl.tagName, id: bestEl.id, class: bestEl.className },
            });
          } else {
            resolve({ found: false });
          }
        }
      );
    });
  }

  // Выполнение действия (клик, ввод, сбор текста)
  async function handlePerformAction(request) {
    const { actionType, payload } = request;
    
    if (actionType === 'click') {
      const el = cachedElements[payload.index];
      if (el) {
        highlightElement(el);
        el.click();
        // Ждём возможную реакцию страницы
        await sleep(1000);
      }
      // Собираем тексты для последующей проверки
      const pageTexts = getVisibleTexts();
      return { pageTexts };
    } else if (actionType === 'type') {
      const el = cachedElements[payload.index];
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        highlightElement(el);
        el.focus();
        el.value = '';
        el.value = payload.value || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);
      }
      const pageTexts = getVisibleTexts();
      return { pageTexts };
    } else if (actionType === 'read_state') {
      // Просто возвращаем текущее состояние страницы
      const pageTexts = getVisibleTexts();
      return { pageTexts };
    }
    return { pageTexts: [] };
  }

  // Проверка ожидаемого результата: собираем тексты страницы
  async function handleVerifyResult(request) {
    let pageTexts = request.precollectedTexts;
    if (!pageTexts || pageTexts.length === 0) {
      pageTexts = getVisibleTexts();
    }
    return { pageTexts };
  }

  // Извлечение всех видимых текстовых фрагментов (innerText, плейсхолдеры, aria-метки)
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

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();