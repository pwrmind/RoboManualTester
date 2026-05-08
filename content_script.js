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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FIND_ELEMENTS') {
    const elements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
    const data = Array.from(elements).map((el, index) => ({
      id: index,
      text: (el.innerText || el.value || el.placeholder || el.ariaLabel || '').trim(),
      tag: el.tagName.toLowerCase(),
      type: el.type || ''
    })).filter(item => item.text.length > 0);
    sendResponse({ elements: data });
  }
  else if (request.type === 'EXECUTE_CLICK') {
    const elements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
    const el = elements[request.index];
    if (el) {
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
    const elements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
    const el = elements[request.index];
    if (el) {
      document.querySelectorAll('[data-ai-highlight]').forEach(e => {
        e.style.outline = '';
        e.removeAttribute('data-ai-highlight');
      });
      el.style.outline = '3px solid #b388ff';
      el.setAttribute('data-ai-highlight', 'true');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      // Очищаем и вводим значение
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = '';
        // Имитация набора текста для реактивных фреймворков
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(el, request.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.getAttribute('contenteditable') === 'true') {
        el.textContent = request.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Элемент не найден' });
    }
  }
  else if (request.type === 'EXECUTE_SELECT') {
    const elements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
    const el = elements[request.index];
    if (!el) return sendResponse({ success: false, error: 'Элемент не найден' });
    if (el.tagName === 'SELECT') {
      // Ищем опцию, текст которой семантически ближе к request.value
      const options = Array.from(el.options);
      let bestOption = null, bestScore = -Infinity;
      // Здесь можно было бы использовать эмбеддинги, но для простоты воспользуемся includes
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
      // Кастомный селект – кликнем по элементу, а затем по опции
      el.click();
      sendResponse({ success: true, note: 'Для кастомного селекта выполнен клик, выбор опции не гарантирован' });
    }
  }
  else if (request.type === 'GET_PAGE_TEXT') {
    sendResponse({ text: getPageVisibleText() });
  }
});