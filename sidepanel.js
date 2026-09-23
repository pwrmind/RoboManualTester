// sidepanel.js
'use strict';

// ---------- DOM ----------
const $scenario = document.getElementById('scenario');
const $run = document.getElementById('runBtn');
const $cancel = document.getElementById('cancelBtn');
const $status = document.getElementById('status');

let cancelled = false;
let currentTabId = null;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ---------- parser helpers ----------

function stripQuotes(s) {
  return String(s ?? '').replace(/^[\s"'«»"""'']+|[\s"'«»"""'']+$/g, '').trim();
}

function extractQuotedFrom(s) {
  const m = String(s ?? '').match(/["'«»""]([^"'«»""]+)["'«»""]/);
  return m ? m[1] : null;
}

function extractQuoted(s) {
  const out = [];
  const re = /["'«»""]([^"'«»""]+)["'«»""]/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

function stripPrepositions(s) {
  const PREP = /^(?:по|на|в|к|для|от|из|у|с|about|on|to|in|at|the)\s+/i;
  const NOUN = /^(?:кнопк[аеуи]?|ссылк[аеуи]?|поле|пункт[аеуи]?|элемент[аеуи]?|button|link|field|item)\s+/i;
  let out = String(s ?? '').trim();
  let prev;
  do {
    prev = out;
    out = out.replace(PREP, '').replace(NOUN, '').trim();
  } while (out !== prev && out.length);
  return out;
}

function extractTarget(rest) {
  const q = extractQuotedFrom(rest);
  if (q) return stripQuotes(q);
  return stripQuotes(stripPrepositions(rest));
}

function splitTargetValue(rest) {
  let work = rest.trim();
  let value = null;

  const VALUE_MARKER_RE = /\s+(?:значение|сообщение|текст|value|text)\s*[:=]?\s+(.+)$/i;
  const FIELD_PREFIX_RE = /^(?:в\s+поле|поле|field|into)\s+(.+)$/i;

  const vm = work.match(VALUE_MARKER_RE);
  if (vm) {
    value = stripQuotes(vm[1]);
    work  = work.slice(0, vm.index).trim();
  }

  const fp = work.match(FIELD_PREFIX_RE);
  if (fp) work = fp[1].trim();

  const quoted = extractQuoted(work);
  if (quoted.length >= 2) {
    return { target: stripQuotes(quoted[0]), value: stripQuotes(quoted[1]) };
  }
  if (quoted.length === 1) {
    const q = quoted[0];
    const idx = work.indexOf(q);
    const before = stripPrepositions(work.slice(0, Math.max(0, idx - 1)));
    const after  = work.slice(idx + q.length + 1).trim();

    if (value === null && before) {
      return { target: stripQuotes(before), value: stripQuotes(q) };
    }
    if (value === null && after) {
      return { target: stripQuotes(q), value: stripQuotes(after) };
    }
    return { target: stripQuotes(q), value };
  }

  const target = stripQuotes(stripPrepositions(work));
  if (value === null) {
    const words = target.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const last = words.pop();
      return { target: stripQuotes(words.join(' ')), value: stripQuotes(last) };
    }
  }
  return { target, value };
}

const KNOWN_KEY_NAMES = new Set([
  'enter', 'tab', 'escape', 'esc', 'backspace', 'delete', 'del', 'space',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown'
]);

function looksLikeKey(spec) {
  const raw = String(spec ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (/^f\d{1,2}$/.test(raw)) return true;

  const parts = raw.split('+').map(x => x.trim());
  if (!parts.length) return false;

  const MODS = ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'win', 'super'];
  for (let i = 0; i < parts.length - 1; i++) {
    if (!MODS.includes(parts[i])) return false;
  }

  const last = parts[parts.length - 1];
  if (last.length === 1) return true;
  if (KNOWN_KEY_NAMES.has(last)) return true;
  return false;
}

// ---------- scroll parser ----------

function parseScrollTail(tail, action) {
  const t = String(tail ?? '').trim().toLowerCase();

  let m = t.match(/^(?:до|к)\s+["'«»""](.+?)["'«»""]\s*$/);
  if (m) return { action, type: 'scroll', scrollTo: stripQuotes(m[1]) };
  m = t.match(/^(?:до|к)\s+(.+)$/);
  if (m) return { action, type: 'scroll', scrollTo: stripQuotes(m[1]) };

  m = t.match(/^(вниз|вверх|down|up)\s+(?:на\s+)?(\d+)/i);
  if (m) {
    const dir = /вниз|down/i.test(m[1]) ? 'down' : 'up';
    return { action, type: 'scroll', direction: dir, amount: parseInt(m[2], 10) };
  }

  m = t.match(/^на\s+(\d+)/);
  if (m) return { action, type: 'scroll', direction: 'down', amount: parseInt(m[1], 10) };

  if (/(?:самый\s+|самое\s+)?низ|bottom|до\s+конца|до\s+низа|конец\s+страницы/.test(t)) {
    return { action, type: 'scroll', direction: 'bottom' };
  }
  if (/(?:самый\s+|самое\s+)?верх|top|до\s+начала|до\s+верха|начало\s+страницы/.test(t)) {
    return { action, type: 'scroll', direction: 'top' };
  }

  if (/\bвниз\b|down|ниже/.test(t)) return { action, type: 'scroll', direction: 'down' };
  if (/\bвверх\b|\bнаверх\b|\bвыше\b|\bup\b/.test(t)) return { action, type: 'scroll', direction: 'up' };

  return { action, type: 'scroll', direction: 'down' };
}

// ---------- verify parser ----------

function parseVerify(rest, action) {
  const body = String(rest ?? '').trim();

  let m = body.match(/^(?:url|адрес(?:\s+страницы)?)\s*(?:содержит|contains|:|=)\s*["'«»""]?(.+?)["'«»""]?\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'urlContains', expected: stripQuotes(m[1]) };
  m = body.match(/^(?:url|адрес(?:\s+страницы)?)\s*(?:равен|равно|==|equals?)\s*["'«»""]?(.+?)["'«»""]?\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'urlEquals', expected: stripQuotes(m[1]) };

  m = body.match(/^(?:заголовок|title)\s*(?:содержит|contains|:|=)\s*["'«»""]?(.+?)["'«»""]?\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'titleContains', expected: stripQuotes(m[1]) };

  m = body.match(/^(.+?)\s+не\s+существует\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'notExists', target: extractTarget(m[1]) };

  m = body.match(/^(.+?)\s+существует\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'exists', target: extractTarget(m[1]) };

  m = body.match(/^(.+?)\s+(видим[оа]?|виден|видна|отображается|показан[оа]?|visible)\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'visible', target: extractTarget(m[1]) };

  m = body.match(/^(.+?)\s+(скрыт[оа]?|не\s+видим[оа]?|не\s+видно|hidden)\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'hidden', target: extractTarget(m[1]) };

  m = body.match(/^(.+?)\s+(неактив[ноаы]+|выключен[оа]?|disabled|заблокирован[оа]?)\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'disabled', target: extractTarget(m[1]) };

  m = body.match(/^(.+?)\s+(актив[ноаы]+|включен[оа]?|enabled|доступн[оа]?)\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'enabled', target: extractTarget(m[1]) };

  m = body.match(/^(.+?)\s+(пуст[оаы]?|пустой|empty)\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'empty', target: extractTarget(m[1]) };

  m = body.match(/^(.+?)\s+(?:содержит|contains)\s+["'«»""](.+?)["'«»""]\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'valueContains', target: extractTarget(m[1]), expected: m[2] };

  m = body.match(/^(.+?)\s+(?:равно|равен|равна|=|==|equals?)\s+["'«»""](.+?)["'«»""]\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'valueEquals', target: extractTarget(m[1]), expected: m[2] };

  m = body.match(/^(?:на\s+странице|в\s+тексте|текст)\s+(?:есть|содержит(?:ся)?|присутствует|contains|has)\s+["'«»""]?(.+?)["'«»""]?\s*$/i);
  if (m) return { action, type: 'verify', verifyKind: 'textOnPage', expected: stripQuotes(m[1]) };

  return { action, type: 'verify', verifyKind: 'textOnPage', expected: stripQuotes(body) };
}

// ---------- line parser ----------

const WAIT_RE   = /^(?:подожди|подождать|жди|обожди|ожидай|ожидание|ждать|пауза|сделай\s+паузу|wait|sleep|pause)\s+(\d+(?:[.,]\d+)?)\s*(?:секунд[аыу]?|сек|s|second[s]?)?\s*$/i;
const PRESS_RE  = /^(?:нажми(?:\s+клавишу)?|нажать(?:\s+клавишу)?|жми|press|hit)\s+(.+)$/i;
const SCROLL_RE = /^(?:прокрути|проскролль|скролл(?:ь)?|промотай|scroll)\s*(.*)$/i;
const VERIFY_TRIGGER_RE = /^(?:проверь|проверить|убедись|убедиться|verify|check|assert|expect)(?:\s*,?\s*что)?\s+(.+)$/i;

const TAB_LIST_RE    = /^(?:список\s+вкладок|покажи\s+вкладки|list\s+tabs|show\s+tabs)$/i;
const TAB_SWITCH_RE  = /^(?:переключись(?:\s+на)?|активируй|switch\s+to|activate|go\s+to)\s+(?:вкладку|таб|tab)\s+(.+)$/i;
const TAB_OPEN_RE    = /^(?:открой|открыть|создай|создать|open|create)\s+(?:новую\s+|new\s+)?вкладку(?:\s+с\s+url|\s+по\s+адресу|\s+url|\s+with\s+url)?\s*(.*)$/i;
const TAB_CLOSE_RE   = /^(?:закрой|закрыть|close)\s+(?:текущую\s+|current\s+)?вкладку\s*(.*)$/i;
const TAB_RELOAD_RE  = /^(?:обнови|обновить|перезагрузи|перезагрузить|reload|refresh)\s+(?:страницу|вкладку|page|tab)?\s*$/i;
const TAB_BACK_RE    = /^(?:вернись\s+назад|назад|go\s+back|back)$/i;
const TAB_FORWARD_RE = /^(?:вернись\s+вперёд|перейди\s+вперёд|вперёд|go\s+forward|forward)$/i;
const TAB_NEXT_RE    = /^(?:следующая\s+вкладка|переключись\s+на\s+следующую\s+вкладку|next\s+tab|switch\s+to\s+next\s+tab)$/i;
const TAB_PREV_RE    = /^(?:предыдущая\s+вкладка|переключись\s+на\s+предыдущую\s+вкладку|previous\s+tab|prev\s+tab|switch\s+to\s+previous\s+tab)$/i;

const RIGHT_CLICK_RE = /^(?:правый\s+клик|клик\s+правой(?:\s+кнопкой)?|клик\s+пкм|пкм|контекстное\s+меню|открой\s+контекстное\s+меню|right\s+click|context\s+menu|rclick)\s+(.+)$/i;

const ACTIONS = [
  { type: 'click',  re: /^(?:кликни|кликнуть|клик|тыкни|ткни|перейди|перейти|открой|открыть|click|tap|open|go to|visit)\s+(.+)/i },
  { type: 'input',  re: /^(?:введи|ввести|напиши|написать|заполни|заполнить|вставь|вставить|input|type|fill|enter)\s+(.+)/i },
  { type: 'select', re: /^(?:выбери|выбрать|отметь|отметить|select|choose|pick)\s+(.+)/i }
];

const EXPECT_RE = /^(?:результат|ожидаемый результат|result|expected result|then)\s*[:：-]\s*(.+)/i;

function parseLine(line) {
  const clean = line.replace(/^\s*(?:\d+\.)+\s*/, '').trim();
  if (!clean) return null;

  const wm = clean.match(WAIT_RE);
  if (wm) {
    const sec = parseFloat(wm[1].replace(',', '.'));
    return { action: clean, type: 'wait', target: null, value: sec, expected: null };
  }

  const vm = clean.match(VERIFY_TRIGGER_RE);
  if (vm) return parseVerify(vm[1], clean);

  const pm = clean.match(PRESS_RE);
  if (pm) {
    const maybeKey = pm[1].trim();
    if (looksLikeKey(maybeKey)) {
      return { action: clean, type: 'press', key: maybeKey, target: null, value: null };
    }
  }

  const sm = clean.match(SCROLL_RE);
  if (sm) return parseScrollTail(sm[1], clean);

  {
    const m = clean.match(TAB_LIST_RE);
    if (m) return { action: clean, type: 'tabList', target: null, value: null };
  }
  {
    const m = clean.match(TAB_SWITCH_RE);
    if (m) return { action: clean, type: 'tabSwitch', needle: extractTarget(m[1]), value: null };
  }
  {
    const m = clean.match(TAB_OPEN_RE);
    if (m) {
      const tail = (m[1] || '').trim();
      const url = tail ? stripQuotes(extractQuotedFrom(tail) || tail) : '';
      return { action: clean, type: 'tabOpen', url, value: null };
    }
  }
  {
    const m = clean.match(TAB_CLOSE_RE);
    if (m) {
      const tail = (m[1] || '').trim();
      const needle = tail ? extractTarget(tail) : null;
      return { action: clean, type: 'tabClose', needle, value: null };
    }
  }
  {
    const m = clean.match(TAB_RELOAD_RE);
    if (m) return { action: clean, type: 'tabReload', target: null, value: null };
  }
  {
    const m = clean.match(TAB_BACK_RE);
    if (m) return { action: clean, type: 'tabBack', target: null, value: null };
  }
  {
    const m = clean.match(TAB_FORWARD_RE);
    if (m) return { action: clean, type: 'tabForward', target: null, value: null };
  }
  {
    const m = clean.match(TAB_NEXT_RE);
    if (m) return { action: clean, type: 'tabNext', target: null, value: null };
  }
  {
    const m = clean.match(TAB_PREV_RE);
    if (m) return { action: clean, type: 'tabPrev', target: null, value: null };
  }

  const rm = clean.match(RIGHT_CLICK_RE);
  if (rm) {
    return { action: clean, type: 'rightClick', target: extractTarget(rm[1]), value: null };
  }

  const CLICK_EXTRA = { type: 'click', re: /^(?:нажми|нажать)\s+(.+)/i };
  for (const { type, re } of [CLICK_EXTRA, ...ACTIONS]) {
    const m = clean.match(re);
    if (!m) continue;
    const rest = m[1].trim();
    if (type === 'input' || type === 'select') {
      const { target, value } = splitTargetValue(rest);
      return { action: clean, type, target, value };
    }
    return { action: clean, type, target: extractTarget(rest), value: null };
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
        steps.push({ action: 'Проверка', type: 'verify', verifyKind: 'textOnPage', target: null, value: null, expected });
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
    if (v.startsWith(t)) { best = Math.max(best, 0.95); continue; }
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

function tabCall(tabId, method, params, opts = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'TAB_CALL', tabId, method, params, allowNavigated: !!opts.allowNavigated },
      resp => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error('Пустой ответ от background'));
        if (!resp.ok) return reject(new Error(resp.error || 'Ошибка'));
        resolve(resp);
      }
    );
  });
}

function tabsCall(method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'TABS_CALL', method, params }, resp => {
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
  if (message !== undefined) detail.textContent = message;
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

function humanUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url || '';
  }
}

// ---------- stability helper ----------

// Ждём стабилизации новой страницы после навигации. Пытаемся несколько раз,
// потому что content script мог ещё не загрузиться на новой вкладке.
async function waitForStableAfterNavigation(tabId, { attempts = 6, delayMs = 400 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await delay(delayMs);
    try {
      await tabCall(tabId, 'WAIT_STABLE', { quietMs: 300, timeoutMs: 4000 });
      return;
    } catch {
      // content script ещё не готов — попробуем ещё раз
    }
  }
}

// ---------- runner ----------

async function performWait(seconds, card, detail) {
  const total = Math.max(0, Number(seconds) || 0);
  const start = Date.now();
  while (true) {
    if (cancelled) throw new Error('Отменено пользователем');
    const elapsed = (Date.now() - start) / 1000;
    const remaining = Math.max(0, total - elapsed);
    detail.textContent = `Осталось ${remaining.toFixed(1)} сек`;
    if (remaining <= 0) break;
    await delay(100);
  }
  detail.textContent = `Пауза ${total} сек завершена`;
}

async function runVerify(tabId, step) {
  const kind = step.verifyKind || 'textOnPage';

  if (kind === 'urlContains' || kind === 'urlEquals' || kind === 'titleContains' || kind === 'textOnPage') {
    const snap = await tabCall(tabId, 'SNAPSHOT');
    const want = String(step.expected ?? '');

    if (kind === 'urlContains') {
      if (!normalize(snap.url).includes(normalize(want))) {
        throw new Error(`URL не содержит "${want}". Текущий: ${snap.url}`);
      }
      return;
    }
    if (kind === 'urlEquals') {
      if (String(snap.url) !== want) {
        throw new Error(`URL не равен "${want}". Текущий: ${snap.url}`);
      }
      return;
    }
    if (kind === 'titleContains') {
      if (!normalize(snap.title).includes(normalize(want))) {
        throw new Error(`Заголовок не содержит "${want}". Текущий: ${snap.title}`);
      }
      return;
    }
    const hay = normalize(snap.text);
    const needle = normalize(want);
    if (!needle) return;
    if (hay.includes(needle)) return;
    const tokens = needle.split(' ').filter(t => t.length > 2);
    if (tokens.length) {
      const hits = tokens.filter(t => hay.includes(t)).length;
      if (hits / tokens.length >= 0.7) return;
    }
    throw new Error(`Текст не найден: "${want}"`);
  }

  if (!step.target) throw new Error('Не указана цель для проверки');

  const desc = await tabCall(tabId, 'DESCRIBE');
  const ranked = resolveTarget(step.target, desc.elements || []);
  const top = ranked[0];
  const found = top && top.score >= 0.55;

  if (kind === 'notExists') {
    if (found) throw new Error(`Элемент "${step.target}" существует: ${elLabel(top.el)} ${top.el.signature.slice(0, 80)}`);
    return;
  }
  if (kind === 'hidden') {
    if (found) throw new Error(`Элемент "${step.target}" виден, ожидалось скрытие: ${elLabel(top.el)} ${top.el.signature.slice(0, 80)}`);
    return;
  }
  if (kind === 'visible' || kind === 'exists') {
    if (!found) throw new Error(`Элемент "${step.target}" не найден или скрыт`);
    return;
  }

  if (!found) {
    throw new Error(`Элемент "${step.target}" не найден (score ${top ? top.score.toFixed(2) : '0'})`);
  }

  const check = await tabCall(tabId, 'CHECK_ELEMENT', {
    id: top.el.id, kind, expected: step.expected
  });
  if (!check.ok) {
    throw new Error(check.error || `Проверка «${kind}» не прошла`);
  }
}

async function resolveAndHighlight(tabId, target) {
  const desc = await tabCall(tabId, 'DESCRIBE');
  const candidates = desc.elements || [];
  if (!candidates.length) throw new Error('На странице не найдено интерактивных элементов');

  const ranked = resolveTarget(target, candidates);
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

  try { await tabCall(tabId, 'HIGHLIGHT', { id: top.el.id, color: '#b388ff' }); } catch {}
  return top;
}

async function handleTabStep(step, card, detail) {
  switch (step.type) {
    case 'tabList': {
      const res = await tabsCall('LIST', { currentTabId });
      const tabs = res.tabs || [];
      const lines = tabs.map(t => {
        const mark = t.active ? '▶' : '·';
        const title = t.title || humanUrl(t.url) || '(без названия)';
        const host = humanUrl(t.url);
        return `  ${mark} ${title}${host ? ` — ${host}` : ''}`;
      }).join('\n');
      setOk(card, detail, `Открыто вкладок: ${tabs.length}\n${lines}`);
      return currentTabId;
    }

    case 'tabSwitch': {
      if (!step.needle) throw new Error('Не указано, на какую вкладку переключиться');
      const res = await tabsCall('SWITCH', { currentTabId, needle: step.needle });
      const t = res.tab;
      setOk(card, detail, `Переключено на "${t.title || humanUrl(t.url)}" (id ${t.id})`);
      return t.id;
    }

    case 'tabOpen': {
      const res = await tabsCall('OPEN', { currentTabId, url: step.url });
      const t = res.tab;
      setOk(card, detail, `Открыта вкладка "${t.title || humanUrl(t.url)}" (id ${t.id})`);
      return t.id;
    }

    case 'tabClose': {
      const res = await tabsCall('CLOSE', { currentTabId, needle: step.needle });
      const closed = res.result.closed;
      const active = res.result.active;
      const msg = `Закрыта вкладка "${closed.title || humanUrl(closed.url)}"` +
        (active ? `\nАктивна: "${active.title || humanUrl(active.url)}" (id ${active.id})` : '');
      setOk(card, detail, msg);
      if (closed.id === currentTabId && active) return active.id;
      return currentTabId;
    }

    case 'tabReload': {
      await tabsCall('RELOAD', { currentTabId });
      await waitForStableAfterNavigation(currentTabId, { attempts: 8, delayMs: 500 });
      setOk(card, detail, 'Страница перезагружена');
      return currentTabId;
    }

    case 'tabBack': {
      await tabsCall('GO_BACK', { currentTabId });
      await waitForStableAfterNavigation(currentTabId, { attempts: 6, delayMs: 400 });
      setOk(card, detail, 'Вернулись назад');
      return currentTabId;
    }

    case 'tabForward': {
      await tabsCall('GO_FORWARD', { currentTabId });
      await waitForStableAfterNavigation(currentTabId, { attempts: 6, delayMs: 400 });
      setOk(card, detail, 'Перешли вперёд');
      return currentTabId;
    }

    case 'tabNext':
    case 'tabPrev': {
      const dir = step.type === 'tabNext' ? 1 : -1;
      const res = await tabsCall('CYCLE', { currentTabId, dir });
      const t = res.tab;
      setOk(card, detail, `Переключено на "${t.title || humanUrl(t.url)}" (id ${t.id})`);
      return t.id;
    }
  }
  return currentTabId;
}

const TAB_STEP_TYPES = new Set([
  'tabList', 'tabSwitch', 'tabOpen', 'tabClose',
  'tabReload', 'tabBack', 'tabForward', 'tabNext', 'tabPrev'
]);

async function run() {
  cancelled = false;
  currentTabId = null;
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

  currentTabId = tab.id;

  try {
    const snap = await tabCall(currentTabId, 'SNAPSHOT');
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
      if (TAB_STEP_TYPES.has(step.type)) {
        currentTabId = await handleTabStep(step, card, detail);
        continue;
      }

      if (step.type === 'wait') {
        await performWait(step.value, card, detail);
        setOk(card, detail, detail.textContent);
        continue;
      }

      if (step.type === 'press') {
        const res = await tabCall(currentTabId, 'PERFORM', {
          id: null, action: 'press', payload: step.key
        }, { allowNavigated: true });
        const info = res.result || {};
        if (info.navigated) {
          detail.textContent = `Нажато ${step.key} → страница уходит в навигацию`;
          await waitForStableAfterNavigation(currentTabId, { attempts: 8, delayMs: 500 });
        } else {
          detail.textContent = `Нажато ${info.actual || step.key}` +
            (info.pressedOn ? ` в ${info.pressedOn}` : '') +
            (info.defaultPrevented ? ' (обработано страницей)' : '');
          await tabCall(currentTabId, 'WAIT_STABLE', { quietMs: 250, timeoutMs: 4000 }).catch(() => {});
        }
        if (step.expected) {
          await runVerify(currentTabId, { type: 'verify', verifyKind: 'textOnPage', expected: step.expected });
          detail.textContent += `\n✅ ${step.expected}`;
        }
        setOk(card, detail, detail.textContent);
        continue;
      }

      if (step.type === 'scroll') {
        let params;
        let human;
        if (step.scrollTo) {
          const desc = await tabCall(currentTabId, 'DESCRIBE');
          const ranked = resolveTarget(step.scrollTo, desc.elements || []);
          const top = ranked[0];
          if (!top || top.score < 0.55) {
            throw new Error(`Элемент для прокрутки не найден: "${step.scrollTo}" (score ${top ? top.score.toFixed(2) : '0'})`);
          }
          params = { targetId: top.el.id };
          human = `до ${elLabel(top.el)} ${top.el.signature.slice(0, 80)} (${top.score.toFixed(2)})`;
        } else {
          params = { direction: step.direction, amount: step.amount };
          const dir = { up: 'вверх', down: 'вниз', top: 'в начало', bottom: 'в конец' }[step.direction] || step.direction;
          human = `${dir}${step.amount ? ` на ${step.amount}px` : ''}`;
        }
        await tabCall(currentTabId, 'SCROLL', params, { allowNavigated: true });
        await delay(500);
        setOk(card, detail, `Прокручено ${human}`);
        continue;
      }

      if (step.type === 'verify') {
        await runVerify(currentTabId, step);
        const label = step.expected ? `✅ ${step.expected}` : '✅ Проверка пройдена';
        setOk(card, detail, label);
        continue;
      }

      const top = await resolveAndHighlight(currentTabId, step.target);
      detail.textContent = `Цель: ${elLabel(top.el)} ${top.el.signature.slice(0, 100)} (${top.score.toFixed(2)})`;

      const actionMap = { rightClick: 'rightClick' };
      const action = actionMap[step.type] || step.type;

      const res = await tabCall(currentTabId, 'PERFORM', {
        id: top.el.id, action, payload: step.value
      }, { allowNavigated: true });

      if (res.navigated || res.result?.navigated) {
        detail.textContent = `Выполнено в ${elLabel(top.el)} → страница уходит в навигацию`;
        await waitForStableAfterNavigation(currentTabId, { attempts: 8, delayMs: 500 });
      } else {
        if (step.type === 'input') {
          detail.textContent = `Записано в ${elLabel(top.el)}: "${String(res.result?.actual ?? '').slice(0, 100)}"`;
        } else if (step.type === 'select' && res.result?.actual != null) {
          detail.textContent = `Выбрано в ${elLabel(top.el)}: "${res.result.actual}"`;
        } else if (step.type === 'rightClick') {
          const handled = res.result?.defaultPrevented ? 'контекстное меню перехвачено страницей' : 'отправлено';
          detail.textContent = `Правый клик в ${elLabel(top.el)} (${handled})`;
        } else {
          detail.textContent = `Клик в ${elLabel(top.el)}`;
        }
        await tabCall(currentTabId, 'WAIT_STABLE', { quietMs: 250, timeoutMs: 4000 }).catch(() => {});
      }

      if (step.expected) {
        await runVerify(currentTabId, { type: 'verify', verifyKind: 'textOnPage', expected: step.expected });
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

function resetButtons() {
  $run.disabled = false;
  $cancel.disabled = true;
}

// ---------- wire up ----------

$run.addEventListener('click', run);
$cancel.addEventListener('click', () => { cancelled = true; });