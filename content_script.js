// Вспомогательные функции
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getPageVisibleText() {
  return document.body.innerText || '';
}

// Расширенный список селекторов для интерактивных элементов
const INTERACTIVE_SELECTORS = [
  'button',
  'a',
  'input[type="button"]',
  'input[type="submit"]',
  '[role="button"]',
  'input[type="text"]',
  'input:not([type])', // input без типа считается текстовым
  'textarea',
  'select',
  '[contenteditable="true"]'
];

/**
 * Возвращает отфильтрованный список элементов (только с непустым текстом) 
 * в том же порядке, что и в FIND_ELEMENTS.
 */
function getFilteredElements() {
  const elements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
  return Array.from(elements).map((el, index) => ({
    id: index,
    el,
    text: (el.innerText || el.value || el.placeholder || el.ariaLabel || '').trim(),
    tag: el.tagName.toLowerCase(),
    type: el.type || ''
  })).filter(item => item.text.length > 0);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FIND_ELEMENTS') {
    const filtered = getFilteredElements();
    const data = filtered.map(({id, text, tag, type}) => ({ id, text, tag, type }));
    sendResponse({ elements: data });
  }
  else if (request.type === 'EXECUTE_CLICK') {
    const filtered = getFilteredElements();
    const item = filtered.find(el => el.id === request.index);
    if (item) {
      const el = item.el;
      // Сбрасываем предыдущие подсветки
      document.querySelectorAll('[data-ai-highlight]').forEach(e => {
        e.style.outline = '';
        e.removeAttribute('data-ai-highlight');
      });
      el.style.outline = '3px solid #b388ff';
      el.setAttribute('data-ai-highlight', 'true');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Элемент не найден' });
    }
  }
  else if (request.type === 'EXECUTE_INPUT') {
    const filtered = getFilteredElements();
    const item = filtered.find(el => el.id === request.index);
    if (!item) return sendResponse({ success: false, error: 'Элемент не найден' });
    const el = item.el;
    // Сбрасываем подсветки
    document.querySelectorAll('[data-ai-highlight]').forEach(e => {
      e.style.outline = '';
      e.removeAttribute('data-ai-highlight');
    });
    el.style.outline = '3px solid #b388ff';
    el.setAttribute('data-ai-highlight', 'true');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // Очищаем поле и вводим новое значение через нативный сеттер
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(el, '');
      nativeSetter.call(el, request.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.getAttribute('contenteditable') === 'true') {
      el.textContent = request.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    sendResponse({ success: true });
  }
  else if (request.type === 'EXECUTE_SELECT') {
    const filtered = getFilteredElements();
    const item = filtered.find(el => el.id === request.index);
    if (!item) return sendResponse({ success: false, error: 'Элемент не найден' });
    const el = item.el;
    if (el.tagName === 'SELECT') {
      const options = Array.from(el.options);
      let bestOption = null;
      // Ищем опцию, содержащую нужное значение (без учёта регистра)
      for (const opt of options) {
        if (opt.text.toLowerCase().includes(request.value.toLowerCase())) {
          bestOption = opt;
          break;
        }
      }
      if (bestOption) {
        el.value = bestOption.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Подходящая опция не найдена' });
      }
    } else {
      // Для кастомных селектов просто делаем клик
      el.click();
      sendResponse({ success: true, note: 'Для кастомного селекта выполнен клик, выбор опции не гарантирован' });
    }
  }
  else if (request.type === 'GET_PAGE_TEXT') {
    sendResponse({ text: getPageVisibleText() });
  }
});