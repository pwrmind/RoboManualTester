// sidepanel.js – интерфейс боковой панели
const scenarioTextarea = document.getElementById('scenario');
const runBtn = document.getElementById('runBtn');
const stepsContainer = document.getElementById('steps');

runBtn.addEventListener('click', () => {
  const text = scenarioTextarea.value.trim();
  if (!text) return;
  
  // Очищаем и показываем плейсхолдеры шагов
  const lines = text.split('\n').filter(line => line.trim());
  stepsContainer.innerHTML = '';
  lines.forEach((line, i) => {
    const div = document.createElement('div');
    div.className = 'step-row';
    div.id = `step-${i}`;
    div.innerHTML = `<span class="step-status status-running">⏳</span><span class="step-text">${escapeHtml(line)}</span>`;
    stepsContainer.appendChild(div);
  });

  // Отправляем сценарий в background
  chrome.runtime.sendMessage({ type: 'RUN_SCENARIO', text });
});

// Обновление статуса шага (приходит из background)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STEP_STATUS') {
    const { index, status } = message;
    const stepEl = document.getElementById(`step-${index}`);
    if (!stepEl) return;
    const statusSpan = stepEl.querySelector('.step-status');
    statusSpan.classList.remove('status-running', 'status-success', 'status-fail');
    if (status === 'running') {
      statusSpan.textContent = '⏳';
      statusSpan.classList.add('status-running');
    } else if (status === 'success') {
      statusSpan.textContent = '✅';
      statusSpan.classList.add('status-success');
    } else if (status === 'fail') {
      statusSpan.textContent = '❌';
      statusSpan.classList.add('status-fail');
    }
  }
});

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}