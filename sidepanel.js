// sidepanel.js
'use strict';

// ---------- DOM ----------
const $scenario = document.getElementById('scenario');
const $run = document.getElementById('runBtn');
const $cancel = document.getElementById('cancelBtn');
const $status = document.getElementById('status');

let cancelled = false;

// ---------- parser ----------
// ВАЖНО: без \b — он не работает для кириллицы. Разделитель — только \s+.
const ACTIONS = [
  { type: 'click',  re: /^(?:нажми|нажать|кликни|кликнуть|клик|тыкни|ткни|перейди|перейти|открой|открыть|click|tap|press|open|go to|visit)\s+(.+)/i },
  { type: 'input',  re: /^(?:введи|ввести|напиши|написать|заполни|заполнить|вставь|вставить|input|type|fill|enter)\s+(.+)/i },
  { type: 'select', re: /^(?:выбери|выбрать|отметь|отметить|select|choose|pick)\s+(.+)/i },
  { type: 'verify', re: /^(?:проверь|проверить|убедись|убедиться|verify|check|assert|expect)\s+(.+)/i }
];

const EXPECT_RE       = /^(?:результат|ожидаемый результат|result|expected result|then)\s*[:：-]\s*(.+)/i;
const VALUE_MARKER_RE = /\s+(?:значение|сообщение|текст|value|text)\s*[:=]?\s+(.+)$/i;
const FIELD_PREFIX_RE = /^(?:в\s+поле|поле|field|into)\s+(.+)$/i;
const QUOTED_RE       = /["'«»""](.+?)["'«»""]/;

function stripQuotes(s) {
  return String(s ?? '').replace(/^[\s"'«»"""'']+|[\s"'«»"""'']+$/g, '').trim();
}

function splitTargetValue(rest) {
  let work = rest.trim();
  let value = null;

  const v = work.match(VALUE_MARKER_RE);
  if (v) {
    value = stripQuotes(v[1]);
    work  = work.slice(0, v.index).trim();
  }

  const f = work.match(FIELD_PREFIX_RE);
  if (f) {
    const body = f[1].trim();
    const q = body.match(QUOTED_RE);
    if (q) {
      const target = stripQuotes(q[1]);
      const after = body.slice(q.index + q[0].length).trim();
      if (value === null && after) value = stripQuotes(after);
      return { target, value };
    }
    if (value !== null) return { target: stripQuotes(body), value };
    const words = body.split(/\s+/);
    if (words.length >= 2) {
      const v2 = words.pop();
      return { target: words.join(' '), value: stripQuotes(v2) };
    }
    return { target: stripQuotes(body), value: null };
  }

  const q = work.match(QUOTED_RE);
  if (q && value === null) {
    value = stripQuotes(q[1]);
    work  = (work.slice(0, q.index) + work.slice(q.index + q[0].length)).trim();
    return { target: stripQuotes(work), value };
  }

  if (value === null) {
    const words = work.split(/\s+/);
    if (words.length >= 2) {
      const v2 = words.pop();
      value = stripQuotes(v2);
      work  = words.join(' ');
    }
  }
  return { target: stripQuotes(work), value };
}

function parseLine(line) {
  const clean = line.replace(/^\s*(?:\d+\.)+\s*/, '').trim();
  if (!clean) return null;
  for (const { type, re } of ACTIONS) {
    const m = clean.match(re);
    if (!m) continue;
    const rest = m[1].trim();
    if (type === 'input' || type === 'select') {
      const { target, value } = splitTargetValue(rest);
      return { action: clean, type, target, value };
    }
    return { action: clean, type, target: stripQuotes(rest), value: null };
  }
  return { action: clean, type: 'click', target: clean, value: null };
}

function parseScenario(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const steps = [];
  let pending = null;

  const flush = () => { if (pending) { steps.push(pending); pending = null; } };

  for (const line of lines) {
    const em = line.match(EXPECT_RE);
    if (em) {
      const expected = em[1].trim();
      if (pending) {
        pending.expected = expected;
        flush();
      } else {
        steps.push({ action: 'Проверка', type: 'verify', target: null, value: null, expected });
      }
      continue;
    }
    flush();
    const step = parseLine(line);
    if (step) pending = step;
  }
  flush();
  return steps;
}

// ---------- resolver ----------

function normalize(s) {
  return String(s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[«»"""'']/g, '')
    .trim();
}

function tokenScore(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = new Set([...A, ...B]).size;
  return inter / union;
}

function scoreCandidate(target, el) {
  const t = normalize(target);
  if (!t) return 0;
  const variants = [el.text, el.signature].filter(Boolean);
  let best = 0;
  for (const v of variants) {
    if (v === t) { best = Math.max(best, 1); continue; }
    if (v.includes(t)) { best = Math.max(best, 0.9); continue; }
    if (t.includes(v) && v.length >= 3) { best = Math.max(best, 0.75); continue; }
    best = Math.max(best, tokenScore(t, v) * 0.85);
  }
  if (el.covered) best *= 0.7;
  return best;
}

function resolveTarget(target, elements) {
  return elements
    .map(el => ({ el, score: scoreCandidate(target, el) }))
    .sort((a, b) => b.score - a.score);
}

// ---------- transport ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Нет активной вкладки');
  return tab;
}

function tabCall(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'TAB_CALL', tabId, method, params }, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('Пустой ответ от background'));
      if (!resp.ok) return reject(new Error(resp.error || 'Ошибка'));
      resolve(resp);
    });
  });
}

// ---------- UI ----------

function addCard(step) {
  const card = document.createElement('div');
  card.className = 'card running';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = step.action;

  const detail = document.createElement('div');
  detail.className = 'detail';
  if (step.expected) detail.textContent = `Ожидается: ${step.expected}`;

  card.append(title, detail);
  $status.appendChild(card);
  card.scrollIntoView({ block: 'nearest' });
  return { card, detail };
}

function setOk(card, detail, message) {
  card.className = 'card ok';
  if (message) detail.textContent = message;
}

function setErr(card, detail, message) {
  card.className = 'card err';
  detail.textContent = message;
}

function elLabel(el) {
  const t = el.tag || '?';
  const ty = el.type && el.type !== t ? `[type=${el.type}]` : '';
  return `<${t}${ty}>`;
}

// ---------- runner ----------

async function run() {
  cancelled = false;
  $run.disabled = true;
  $cancel.disabled = false;
  $status.innerHTML = '';

  const steps = parseScenario($scenario.value);
  if (!steps.length) {
    $status.innerHTML = '<div class="card err"><div class="title">Сценарий пуст</div></div>';
    resetButtons();
    return;
  }

  let tab;
  try { tab = await getActiveTab(); }
  catch (e) { $status.innerHTML = `<div class="card err"><div class="title">${e.message}</div></div>`; resetButtons(); return; }

  try {
    const snap = await tabCall(tab.id, 'SNAPSHOT');
    if (!snap.url || snap.url.startsWith('chrome://') || snap.url.startsWith('edge://')) {
      throw new Error('Нельзя работать на служебных страницах браузера');
    }
  } catch (e) {
    $status.innerHTML = `<div class="card err"><div class="title">${e.message}</div></div>`;
    resetButtons(); return;
  }

  for (const step of steps) {
    if (cancelled) break;
    const { card, detail } = addCard(step);

    try {
      if (step.type === 'verify' || !step.target) {
        if (!step.expected) { setOk(card, detail, 'Пропущено'); continue; }
        await verifyExpected(tab.id, step.expected);
        setOk(card, detail, `✅ ${step.expected}`);
        continue;
      }

      const desc = await tabCall(tab.id, 'DESCRIBE');
      const candidates = desc.elements || [];
      if (!candidates.length) throw new Error('На странице не найдено интерактивных элементов');

      const ranked = resolveTarget(step.target, candidates);
      const top = ranked[0];
      if (!top || top.score < 0.55) {
        const near = ranked.slice(0, 3)
          .map(r => `  • ${r.score.toFixed(2)} — ${elLabel(r.el)} ${r.el.signature.slice(0, 80)}`)
          .join('\n');
        throw new Error(`Цель не найдена (лучший score ${top ? top.score.toFixed(2) : '0'})\nКандидаты:\n${near}`);
      }
      if (ranked[1] && top.score - ranked[1].score < 0.05 && top.score < 0.9) {
        const near = ranked.slice(0, 2)
          .map(r => `  • ${r.score.toFixed(2)} — ${elLabel(r.el)} ${r.el.signature.slice(0, 80)}`)
          .join('\n');
        throw new Error(`Неоднозначная цель, уточните формулировку:\n${near}`);
      }

      // подсветить найденный элемент, чтобы пользователь видел, во что попал матч
      try { await tabCall(tab.id, 'HIGHLIGHT', { id: top.el.id, color: '#b388ff' }); } catch {}

      detail.textContent = `Цель: ${elLabel(top.el)} ${top.el.signature.slice(0, 100)} (${top.score.toFixed(2)})`;

      const res = await tabCall(tab.id, 'PERFORM', {
        id: top.el.id,
        action: step.type,
        payload: step.value
      });

      if (step.type === 'input') {
        detail.textContent = `Записано в ${elLabel(top.el)}: "${res.result?.actual ?? ''}"`;
      } else if (step.type === 'select' && res.result?.actual != null) {
        detail.textContent = `Выбрано в ${elLabel(top.el)}: "${res.result.actual}"`;
      } else {
        detail.textContent = `Клик в ${elLabel(top.el)}`;
      }

      await tabCall(tab.id, 'WAIT_STABLE', { quietMs: 250, timeoutMs: 4000 });

      if (step.expected) {
        await verifyExpected(tab.id, step.expected);
        setOk(card, detail, detail.textContent + `\n✅ ${step.expected}`);
      } else {
        setOk(card, detail, detail.textContent);
      }
    } catch (e) {
      setErr(card, detail, e.message);
      break;
    }
  }

  resetButtons();
}

async function verifyExpected(tabId, expected) {
  const snap = await tabCall(tabId, 'SNAPSHOT');
  const hay = normalize(snap.text);
  const needle = normalize(expected);
  if (!needle) return;
  if (hay.includes(needle)) return;

  const tokens = needle.split(' ').filter(t => t.length > 2);
  if (tokens.length) {
    const hits = tokens.filter(t => hay.includes(t)).length;
    if (hits / tokens.length >= 0.7) return;
  }
  throw new Error(`Ожидаемый текст не найден: "${expected}"`);
}

function resetButtons() {
  $run.disabled = false;
  $cancel.disabled = true;
}

// ---------- wire up ----------

$run.addEventListener('click', run);
$cancel.addEventListener('click', () => { cancelled = true; });