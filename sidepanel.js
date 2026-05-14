import { pipeline, env } from './lib/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
}

let extractor = null;

async function initModel() {
  if (!extractor) {
    console.log('Загрузка мультиязычной модели...');
    extractor = await pipeline(
      'feature-extraction',
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      { quantized: true }
    );
    console.log('Модель готова');
  }
}

async function getEmbedding(text) {
  await initModel();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Улучшенный парсинг действия
function parseActionLine(line) {
  // Удаляем нумерацию в начале строки (1., 1.1., 1.1.1. и т.п.)
  const cleanLine = line.replace(/^(\d+\.)+\s*/, '').trim();
  if (!cleanLine) return null;

  const patterns = [
    { regex: /^(?:кликни|нажми|клик|перейди|открой|click|tap|press|open|go to)\s+(.+)/i, type: 'click' },
    { regex: /^(?:введи|напиши|заполни|вставь|input|type|fill|enter)\s+(.+)/i, type: 'input' },
    { regex: /^(?:выбери|отметь|select|choose|pick)\s+(.+)/i, type: 'select' },
    { regex: /^(?:проверь|убедись|verify|check|see|assert)\s+(.+)/i, type: 'verify' }
  ];

  for (const { regex, type } of patterns) {
    const match = cleanLine.match(regex);
    if (match) {
      let rest = match[1].trim();
      let target = rest;
      let value = null;
      if (type === 'input' || type === 'select') {
        // Ищем значение в кавычках (одинарных, двойных или «»)
        const quotedMatch = rest.match(/[«""'](.*?)[»""']/);
        if (quotedMatch) {
          value = quotedMatch[1];
          target = (rest.substring(0, quotedMatch.index) + rest.substring(quotedMatch.index + quotedMatch[0].length)).trim();
        } else {
          // Разделители: "как", "значение", "текст", ":", etc.
          const valueRegex = /\s+(?:как|значение|текст|value|text|:)\s+(.+)/i;
          const valueMatch = rest.match(valueRegex);
          if (valueMatch) {
            value = valueMatch[1].trim();
            target = rest.substring(0, valueMatch.index).trim();
          } else {
            // Если ничего не найдено, последнее слово считаем значением
            const words = rest.split(/\s+/);
            if (words.length > 1) {
              value = words.pop();
              target = words.join(' ');
            }
          }
        }
        target = target.replace(/^[«""']|[»""']$/g, '');
      }
      return { action: cleanLine, type, target, value, expected: null };
    }
  }
  // По умолчанию — клик
  return { action: cleanLine, type: 'click', target: cleanLine, value: null, expected: null };
}

// Парсинг всего сценария
function parseScenario(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  const steps = [];
  let currentAction = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Поддержка русских и английских маркеров ожидаемого результата
    const resultMatch = line.match(/^(?:Результат|Result|Then|Ожидаемый результат|Expected result)\s*[:：-]\s*(.+)/i);
    if (resultMatch) {
      const expected = resultMatch[1].trim();
      if (currentAction) {
        currentAction.expected = expected;
        steps.push(currentAction);
        currentAction = null;
      } else {
        // Только проверка без действия
        steps.push({ action: 'Проверка: ' + expected, type: 'verify', target: null, value: null, expected });
      }
      continue;
    }
    // Если предыдущее действие не закрыто результатом, сохраняем его
    if (currentAction) {
      steps.push(currentAction);
      currentAction = null;
    }
    const parsed = parseActionLine(line);
    if (parsed) {
      currentAction = parsed;
    }
  }
  if (currentAction) steps.push(currentAction);
  return steps;
}

async function sendMessageToTabSafely(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    return response;
  } catch (err) {
    throw new Error(`Связь со страницей: ${err.message}`);
  }
}

async function runScenario(scenarioText) {
  const statusDiv = document.getElementById('status');
  const runBtn = document.getElementById('runBtn');
  runBtn.disabled = true;
  statusDiv.innerHTML = '';

  const steps = parseScenario(scenarioText);
  if (steps.length === 0) {
    statusDiv.innerHTML = '<div class="step-card error"><span class="step-icon">❌</span><div class="step-content">Сценарий пуст</div></div>';
    runBtn.disabled = false;
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusDiv.innerHTML = '<div class="step-card error"><span class="step-icon">❌</span><div class="step-content">Нет активной вкладки</div></div>';
    runBtn.disabled = false;
    return;
  }

  try {
    await initModel();
  } catch (e) {
    statusDiv.innerHTML = `<div class="step-card error"><span class="step-icon">❌</span><div class="step-content">Не удалось загрузить модель: ${e.message}</div></div>`;
    runBtn.disabled = false;
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const card = document.createElement('div');
    card.className = 'step-card processing';
    card.innerHTML = `<span class="step-icon">⏳</span><div class="step-content"><div class="step-action">${step.action || 'Проверка: ' + step.expected}</div>${step.expected ? `<div class="expected-result">Ожидается: ${step.expected}</div>` : ''}</div>`;
    statusDiv.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });

    try {
      // Шаг только с ожидаемым результатом (проверка без действия)
      if (!step.type || step.type === 'verify' || !step.target) {
        if (step.expected) {
          await delay(1200);
          const textRes = await sendMessageToTabSafely(tab.id, { type: 'GET_PAGE_TEXT' });
          const pageText = textRes?.text || '';
          if (!pageText) throw new Error('Не удалось получить текст страницы');
          const fragments = pageText.split('\n').filter(f => f.trim().length > 2);
          const expectedVec = await getEmbedding(step.expected);
          let maxSim = -1, bestFrag = '';
          for (const frag of fragments) {
            const fragVec = await getEmbedding(frag);
            const sim = cosineSimilarity(expectedVec, fragVec);
            if (sim > maxSim) { maxSim = sim; bestFrag = frag; }
          }
          if (maxSim < 0.7) throw new Error(`Ожидаемый результат не подтверждён (лучшее: "${bestFrag}", сходство ${maxSim.toFixed(2)})`);
          card.className = 'step-card success';
          card.innerHTML = `<span class="step-icon">✅</span><div class="step-content"><div class="step-action">Проверка</div><div class="expected-result">✅ ${step.expected}</div></div>`;
        }
        continue;
      }

      // Поиск элемента по цели
      const targetVec = await getEmbedding(step.target);
      const findRes = await sendMessageToTabSafely(tab.id, { type: 'FIND_ELEMENTS' });
      if (!findRes?.elements?.length) throw new Error('Интерактивных элементов не найдено');

      let bestIndex = -1, bestScore = -Infinity;
      for (const item of findRes.elements) {
        const vec = await getEmbedding(item.text);
        const score = cosineSimilarity(targetVec, vec);
        if (score > bestScore) { bestScore = score; bestIndex = item.id; }
      }

      if (bestScore < 0.45) throw new Error(`Сходство ниже порога (${bestScore.toFixed(2)}). Элемент не найден`);

      // Выполнение действия
      if (step.type === 'click') {
        await sendMessageToTabSafely(tab.id, { type: 'EXECUTE_CLICK', index: bestIndex });
      } else if (step.type === 'input') {
        const valueToSend = step.value || '';
        await sendMessageToTabSafely(tab.id, { type: 'EXECUTE_INPUT', index: bestIndex, value: valueToSend });
      } else if (step.type === 'select') {
        await sendMessageToTabSafely(tab.id, { type: 'EXECUTE_SELECT', index: bestIndex, value: step.value || '' });
      }
      await delay(800);

      // Проверка результата
      if (step.expected) {
        await delay(1200);
        const textRes = await sendMessageToTabSafely(tab.id, { type: 'GET_PAGE_TEXT' });
        const pageText = textRes?.text || '';
        if (!pageText) throw new Error('Не удалось получить текст страницы');

        const fragments = pageText.split('\n').filter(f => f.trim().length > 2);
        const expectedVec = await getEmbedding(step.expected);
        let maxSim = -1, bestFrag = '';
        for (const frag of fragments) {
          const fragVec = await getEmbedding(frag);
          const sim = cosineSimilarity(expectedVec, fragVec);
          if (sim > maxSim) { maxSim = sim; bestFrag = frag; }
        }
        if (maxSim < 0.7) throw new Error(`Результат не подтверждён (лучшее: "${bestFrag}", сходство ${maxSim.toFixed(2)})`);
        card.className = 'step-card success';
        card.innerHTML = `<span class="step-icon">✅</span><div class="step-content"><div class="step-action">${step.action}</div><div class="expected-result">✅ ${step.expected}</div></div>`;
      } else {
        card.className = 'step-card success';
        card.innerHTML = `<span class="step-icon">✅</span><div class="step-content"><div class="step-action">${step.action}</div></div>`;
      }
    } catch (err) {
      card.className = 'step-card error';
      card.innerHTML = `<span class="step-icon">❌</span><div class="step-content"><div class="step-action">${step.action || 'Проверка'}</div><div>${err.message}</div></div>`;
      break;
    }
  }

  runBtn.disabled = false;
}

document.getElementById('runBtn').addEventListener('click', () => {
  runScenario(document.getElementById('scenario').value);
});