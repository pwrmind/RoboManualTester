// sidepanel.js – модуль, загружающий модель и управляющий тестовым прогоном
import { pipeline } from './lib/transformers.min.js';

const scenarioTextarea = document.getElementById('scenario');
const runBtn = document.getElementById('runBtn');
const stepsContainer = document.getElementById('steps');
const modelStatusEl = document.getElementById('model-status');

let extractor = null;
const modelName = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

// Инициализация модели при открытии панели
(async function initModel() {
  try {
    modelStatusEl.textContent = 'Загрузка модели… (первый раз может занять до минуты)';
    extractor = await pipeline('feature-extraction', modelName, {
      quantized: true,
    });
    modelStatusEl.textContent = 'Модель готова ✅';
    runBtn.disabled = false;
  } catch (err) {
    modelStatusEl.textContent = 'Ошибка загрузки модели: ' + err.message;
    console.error(err);
  }
})();

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

// Парсинг строки сценария
function parseStep(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const resultSplit = /Результат:|Тогда:|Ожидается:/i;
  const parts = trimmed.split(resultSplit);
  const action = parts[0].trim();
  const expected = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
  return { action, expected };
}

function classifyAction(actionText) {
  const lower = actionText.toLowerCase();
  if (/нажми|кликни|жми|клик|выбери|перейди/i.test(lower)) return 'click';
  if (/введи|напиши|заполни/i.test(lower)) return 'type';
  if (/проверь|убедись|посмотри/i.test(lower)) return 'verify';
  return 'click';
}

function parseTypeAction(actionText) {
  const match = actionText.match(/введи\s+(.+?)\s+(\S+)$/i);
  if (match) {
    return { fieldDescription: match[1].trim(), value: match[2].trim() };
  }
  const quoted = actionText.match(/['"]([^'"]+)['"]/g);
  if (quoted) {
    const value = quoted[0].replace(/['"]/g, '');
    const fieldDescription = actionText.replace(/введи\s*/i, '').replace(new RegExp(`['"]?${value}['"]?`), '').trim();
    return { fieldDescription, value };
  }
  return { fieldDescription: actionText.replace(/введи\s*/i, '').trim(), value: '' };
}

// Отправка команд в content script
async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Активная вкладка не найдена');
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      resolve(response);
    });
  });
}

// Поиск элемента через сбор кандидатов
async function findElement(description) {
  // Запрашиваем сбор кандидатов у content script
  const response = await sendToActiveTab({ type: 'COLLECT_CANDIDATES' });
  if (!response || !response.candidates) return null;
  
  const candidates = response.candidates;
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
  
  if (bestIdx >= 0 && bestScore > 0.5) {
    return { found: true, index: bestIdx, text: candidates[bestIdx].text, score: bestScore };
  }
  return { found: false };
}

// Проверка ожидаемого результата на странице
async function verifyExpected(expectedText) {
  if (!expectedText) return true;
  const response = await sendToActiveTab({ type: 'GET_VISIBLE_TEXTS' });
  if (!response || !response.pageTexts) return false;
  
  const expectedVec = await getEmbedding(expectedText);
  let maxSim = -1;
  for (const text of response.pageTexts) {
    if (text.length < 2) continue;
    const textVec = await getEmbedding(text);
    const sim = cosineSimilarity(expectedVec, textVec);
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim > 0.7;
}

// MAIN: запуск сценария
runBtn.addEventListener('click', async () => {
  if (!extractor) return;
  const text = scenarioTextarea.value.trim();
  if (!text) return;
  
  const lines = text.split('\n').filter(line => line.trim());
  stepsContainer.innerHTML = '';
  lines.forEach((line, i) => {
    const div = document.createElement('div');
    div.className = 'step-row';
    div.id = `step-${i}`;
    div.innerHTML = `<span class="step-status status-running">⏳</span><span class="step-text">${escapeHtml(line)}</span>`;
    stepsContainer.appendChild(div);
  });
  
  const steps = lines.map(parseStep).filter(Boolean);
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const statusEl = document.getElementById(`step-${i}`).querySelector('.step-status');
    
    try {
      let status = 'fail';
      const actionType = classifyAction(step.action);
      
      if (actionType === 'click') {
        const result = await findElement(step.action);
        if (!result || !result.found) {
          status = 'fail';
        } else {
          await sendToActiveTab({ type: 'PERFORM_ACTION', action: 'click', payload: { index: result.index } });
          await sleep(1500); // ожидание реакции страницы
          const verified = await verifyExpected(step.expected);
          status = verified ? 'success' : 'fail';
        }
      } else if (actionType === 'type') {
        const { fieldDescription, value } = parseTypeAction(step.action);
        const result = await findElement(fieldDescription || step.action);
        if (!result || !result.found) {
          status = 'fail';
        } else {
          await sendToActiveTab({ type: 'PERFORM_ACTION', action: 'type', payload: { index: result.index, value } });
          await sleep(500);
          const verified = await verifyExpected(step.expected);
          status = verified ? 'success' : 'fail';
        }
      } else if (actionType === 'verify') {
        const verified = await verifyExpected(step.action);
        status = verified ? 'success' : 'fail';
      }
      
      // Обновляем UI
      statusEl.classList.remove('status-running');
      if (status === 'success') {
        statusEl.textContent = '✅';
        statusEl.classList.add('status-success');
      } else {
        statusEl.textContent = '❌';
        statusEl.classList.add('status-fail');
      }
    } catch (e) {
      statusEl.classList.remove('status-running');
      statusEl.textContent = '❌';
      statusEl.classList.add('status-fail');
      console.error('Ошибка выполнения шага', i, e);
    }
  }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}