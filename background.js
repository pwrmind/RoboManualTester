// background.js – управляет моделью и координацией шагов

// Загружаем библиотеку (IIFE, появляется globalThis.transformers)
importScripts('lib/transformers.min.js');

let extractor = null;               // pipeline для feature extraction
const modelName = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

// Загрузка модели при старте (кешируется в IndexedDB браузера)
async function initModel() {
  console.log('[Background] Загрузка модели...');
  extractor = await transformers.pipeline('feature-extraction', modelName, {
    quantized: true,
  });
  console.log('[Background] Модель готова.');
}

initModel().catch(err => console.error('Ошибка загрузки модели:', err));

// Вспомогательные функции
function cosineSimilarity(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function getEmbedding(text) {
  const result = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

// Парсинг строки сценария на действие и ожидаемый результат
function parseStep(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Разделяем по ключевым словам
  const resultSplit = /Результат:|Тогда:|Ожидается:/i;
  const parts = trimmed.split(resultSplit);
  const action = parts[0].trim();
  const expected = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';

  return { action, expected };
}

// Определяем тип действия (клик, ввод, проверка)
function classifyAction(actionText) {
  const lower = actionText.toLowerCase();
  if (/нажми|кликни|жми|клик|выбери|перейди/i.test(lower)) return 'click';
  if (/введи|напиши|заполни/i.test(lower)) return 'type';
  if (/проверь|убедись|посмотри/i.test(lower)) return 'verify';
  return 'click'; // по умолчанию – клик
}

// Извлечение данных для ввода текста
function parseTypeAction(actionText) {
  // Ищем конструкцию "Введи текст <значение> в <поле>" или просто "Введи <поле> <значение>"
  const match = actionText.match(/введи\s+(.+?)\s+(\S+)$/i);
  if (match) {
    return { fieldDescription: match[1].trim(), value: match[2].trim() };
  }
  // Если не получилось, пробуем найти значение в кавычках
  const quoted = actionText.match(/['"]([^'"]+)['"]/g);
  if (quoted) {
    const value = quoted[0].replace(/['"]/g, '');
    const fieldDescription = actionText.replace(/введи\s*/i, '').replace(new RegExp(`['"]?${value}['"]?`), '').trim();
    return { fieldDescription, value };
  }
  return { fieldDescription: actionText.replace(/введи\s*/i, '').trim(), value: '' };
}

// Запрос к content script на поиск элемента по семантическому описанию
async function findElement(tabId, description) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'FIND_ELEMENT', description }, (response) => {
      resolve(response || null);
    });
  });
}

// Запрос к content script на выполнение действия (и сбор пост-состояния)
async function performAction(tabId, actionType, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'PERFORM_ACTION', actionType, payload }, (response) => {
      resolve(response || null);
    });
  });
}

// Основной поток выполнения сценария
async function runScenario(scenarioText, tabId) {
  const lines = scenarioText.split('\n').filter(line => line.trim());
  const steps = lines.map(parseStep).filter(Boolean);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const actionType = classifyAction(step.action);
    let status = 'pending';

    // Отправляем обновление в sidepanel (шаг начат)
    chrome.runtime.sendMessage({ type: 'STEP_STATUS', index: i, status: 'running' });

    try {
      if (actionType === 'click') {
        // Ищем кнопку/ссылку по описанию
        const result = await findElement(tabId, step.action);
        if (!result || !result.found) {
          status = 'fail';
        } else {
          // Выполняем клик
          const actionResult = await performAction(tabId, 'click', {
            index: result.index,
            text: result.text,
            selectorInfo: result.selectorInfo,
          });
          // Проверяем ожидаемый результат
          if (step.expected) {
            const verified = await verifyExpected(tabId, step.expected, actionResult?.pageTexts);
            status = verified ? 'success' : 'fail';
          } else {
            status = 'success';
          }
        }
      } else if (actionType === 'type') {
        const { fieldDescription, value } = parseTypeAction(step.action);
        // Ищем поле ввода
        const result = await findElement(tabId, fieldDescription || step.action);
        if (!result || !result.found) {
          status = 'fail';
        } else {
          await performAction(tabId, 'type', {
            index: result.index,
            text: result.text,
            value: value,
          });
          if (step.expected) {
            const actionResult = await performAction(tabId, 'read_state'); // прочитать состояние после ввода
            const verified = await verifyExpected(tabId, step.expected, actionResult?.pageTexts);
            status = verified ? 'success' : 'fail';
          } else {
            status = 'success';
          }
        }
      } else if (actionType === 'verify') {
        // Только проверка: ищем текст на странице
        const verified = await verifyExpected(tabId, step.action);
        status = verified ? 'success' : 'fail';
      }
    } catch (e) {
      console.error('Ошибка шага:', e);
      status = 'fail';
    }

    chrome.runtime.sendMessage({ type: 'STEP_STATUS', index: i, status });
  }
}

// Проверка ожидаемого результата на странице
async function verifyExpected(tabId, expectedText, pageTexts) {
  if (!expectedText) return true;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'VERIFY_RESULT', expectedText, precollectedTexts: pageTexts },
      async (response) => {
        if (response && response.pageTexts) {
          // Вычисляем сходство на стороне background
          try {
            const expectedVec = await getEmbedding(expectedText);
            let maxSim = -1;
            for (const text of response.pageTexts) {
              if (text.length < 2) continue;
              const textVec = await getEmbedding(text);
              const sim = cosineSimilarity(expectedVec, textVec);
              if (sim > maxSim) maxSim = sim;
            }
            resolve(maxSim > 0.7);
          } catch {
            resolve(false);
          }
        } else {
          resolve(false);
        }
      }
    );
  });
}

// Слушаем сообщения от sidepanel и content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_SCENARIO') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        runScenario(message.text, tabs[0].id);
      }
    });
  } else if (message.type === 'FIND_ELEMENT') {
    // Контент-скрипт запрашивает у нас эмбеддинги
    // Он присылает candidates: [{index, text}], описание description
    handleFindElement(message, sender, sendResponse);
    return true; // асинхронный ответ
  }
});

// Обработка запроса от content script на сравнение кандидатов
async function handleFindElement(request, sender, sendResponse) {
  const { description, candidates } = request;
  try {
    const descVec = await getEmbedding(description);
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (!cand.text) continue;
      const candVec = await getEmbedding(cand.text);
      const sim = cosineSimilarity(descVec, candVec);
      if (sim > bestScore) {
        bestScore = sim;
        bestIdx = cand.index;
      }
    }
    sendResponse({ index: bestIdx, score: bestScore, threshold: 0.5 });
  } catch (e) {
    sendResponse({ index: -1, score: 0 });
  }
}