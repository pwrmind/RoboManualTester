function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FIND_ELEMENTS') {
    const elements = document.querySelectorAll(
      'button, a, input[type="button"], [role="button"], input[type="submit"]'
    );
    const data = Array.from(elements).map((el, index) => ({
      id: index,
      text: (el.innerText || el.value || el.placeholder || el.ariaLabel || '').trim()
    })).filter(item => item.text.length > 0);
    sendResponse({ elements: data });
  }
  else if (request.type === 'EXECUTE_CLICK') {
    const elements = document.querySelectorAll(
      'button, a, input[type="button"], [role="button"], input[type="submit"]'
    );
    const el = elements[request.index];
    if (el) {
      document.querySelectorAll('[data-ai-highlight]').forEach(e => {
        e.style.outline = '';
        e.removeAttribute('data-ai-highlight');
      });
      el.style.outline = '3px solid red';
      el.setAttribute('data-ai-highlight', 'true');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Элемент не найден' });
    }
  }
  else if (request.type === 'GET_PAGE_TEXT') {
    sendResponse({ text: getPageVisibleText() });
  }
});