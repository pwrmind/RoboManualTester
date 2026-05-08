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

function parseScenario(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  const steps = [];
  let currentAction = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const resultMatch = line.match(/^(Результат|Result|Then|Ожидаемый результат)\s*[:：-]\s*(.+)/i);
    if (resultMatch) {
      const expected = resultMatch[2].trim();
      if (currentAction) {
        currentAction.expected = expected;
        steps.push(currentAction);
        currentAction = null;
      } else {
        steps.push({ action: null, expected });
      }
    } else {
      if (currentAction) steps.push(currentAction);
      currentAction = { action: line, expected: null };
    }
  }
  if (currentAction) steps.push(currentAction);
  return steps;
}

async function sendMessageToTabSafely(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }
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
    statusDiv.innerHTML = '<div class="step error">Сценарий пуст</div>';
    runBtn.disabled = false;
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusDiv.innerHTML = '<div class="step error">Нет активной вкладки</div>';
    runBtn.disabled = false;
    return;
  }

  try {
    await initModel();
  } catch (e) {
    statusDiv.innerHTML = `<div class="step error">Не удалось загрузить модель: ${e.message}</div>`;
    runBtn.disabled = false;
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepDiv = document.createElement('div');
    stepDiv.className = 'step processing';
    stepDiv.textContent = `⏳ ${step.action || 'Проверка: ' + step.expected}`;
    statusDiv.appendChild(stepDiv);
    stepDiv.scrollIntoView({ behavior: 'smooth' });

    try {
      if (step.action) {
        const targetVec = await getEmbedding(step.action);
        const findRes = await sendMessageToTabSafely(tab.id, { type: 'FIND_ELEMENTS' });

        if (!findRes?.elements?.length) throw new Error('Интерактивных элементов не найдено');

        let bestIndex = -1, bestScore = -Infinity;
        for (const item of findRes.elements) {
          const vec = await getEmbedding(item.text);
          const score = cosineSimilarity(targetVec, vec);
          if (score > bestScore) {
            bestScore = score;
            bestIndex = item.id;
          }
        }

        if (bestScore < 0.5) {
          throw new Error(`Сходство ниже порога (${bestScore.toFixed(2)}). Элемент не найден`);
        }

        await sendMessageToTabSafely(tab.id, { type: 'EXECUTE_CLICK', index: bestIndex });
        await delay(800);
      }

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
          if (sim > maxSim) {
            maxSim = sim;
            bestFrag = frag;
          }
        }

        if (maxSim < 0.7) {
          throw new Error(`Ожидаемый результат не подтверждён (лучшее: "${bestFrag}", сходство ${maxSim.toFixed(2)})`);
        }
      }

      stepDiv.className = 'step success';
      stepDiv.textContent = `✅ ${step.action || ''} ${step.expected ? '→ ' + step.expected : ''}`;
    } catch (err) {
      stepDiv.className = 'step error';
      stepDiv.textContent = `❌ ${step.action || 'Проверка'}: ${err.message}`;
      break;
    }
  }

  runBtn.disabled = false;
}

document.getElementById('runBtn').addEventListener('click', () => {
  runScenario(document.getElementById('scenario').value);
});