// content_script.js
(() => {
  if (window.__aiqaInjected) return;
  window.__aiqaInjected = true;

  const registry = new Map();
  let nextId = 1;

  const INTERACTIVE_SELECTOR = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]'
  ].join(',');

  const HIGHLIGHT_ATTR = 'data-aiqa-highlight';

  // ---------- helpers ----------

  function normalize(s) {
    return String(s ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/[«»"""'']/g, '')
      .trim();
  }

  function isEditable(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    return el.isContentEditable === true;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;

    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (parseFloat(style.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return true;
  }

  function isCovered(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return false;
    const top = document.elementFromPoint(cx, cy);
    if (!top) return false;
    if (top === el) return false;
    if (el.contains(top)) return false;
    if (top.contains(el)) return false;
    return true;
  }

  function getLabelText(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.innerText || lab.textContent || '';
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.innerText || wrap.textContent || '';
    return '';
  }

  function buildDescriptor(el) {
    const rawText = (el.innerText || el.textContent || '').trim();
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const placeholder =
      el.getAttribute('placeholder') ||
      el.getAttribute('data-placeholder') ||
      el.getAttribute('aria-placeholder') ||
      '';
    const alt = el.getAttribute('alt') || '';
    const label = getLabelText(el);

    const pieces = [aria, label, placeholder, title, alt, rawText]
      .map(normalize)
      .filter(Boolean);

    const signature = Array.from(new Set(pieces)).join(' | ');

    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || '',
      placeholder: normalize(placeholder),
      text: normalize(rawText),
      signature,
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      visible: isVisible(el),
      covered: isCovered(el),
      editable: isEditable(el)
    };
  }

  function register(el) {
    for (const [id, e] of registry) if (e === el) return id;
    const id = nextId++;
    registry.set(id, el);
    return id;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function clearHighlights() {
    document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach(e => {
      e.style.outline = '';
      e.style.outlineOffset = '';
      e.style.transition = '';
      e.removeAttribute(HIGHLIGHT_ATTR);
    });
  }

  function highlight(el, color = '#b388ff', { holdMs = 2000, fadeMs = 500 } = {}) {
    clearHighlights();

    el.style.transition = 'none';
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '2px';
    el.setAttribute(HIGHLIGHT_ATTR, '1');

    void el.offsetWidth;

    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}

    el.style.transition = `outline-color ${fadeMs}ms ease-out`;

    setTimeout(() => {
      if (!el.getAttribute(HIGHLIGHT_ATTR)) return;
      el.style.outlineColor = 'transparent';
      setTimeout(() => {
        if (!el.getAttribute(HIGHLIGHT_ATTR)) return;
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.transition = '';
        el.removeAttribute(HIGHLIGHT_ATTR);
      }, fadeMs + 60);
    }, holdMs);
  }

  // ---------- contenteditable insertion ----------

  // Возвращает true, если значение «похоже» уже находится в элементе ровно один раз.
  // Учитывает, что rich-редакторы разбивают текст на несколько спанов и рендерят эмодзи
  // как декораторы (их нет в textContent).
  function countProbe(text, value) {
    const a = String(text || '').replace(/\s+/g, ' ').trim();
    // Первые 15 code points значения — этого достаточно, чтобы отличить
    // «вставлено», «не вставлено» и «вставлено дважды».
    const probe = Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, 15).join('');
    if (!probe) return { count: 1, probe };
    // Используем нежадный split: считаем все вхождения probe в a.
    let count = 0;
    let idx = 0;
    while ((idx = a.indexOf(probe, idx)) !== -1) {
      count++;
      idx += probe.length;
    }
    return { count, probe };
  }

  // Пытаемся заменить текущее выделение синтетическим beforeinput.
  // Синтетическое событие не имеет default action, поэтому браузер сам ничего не вставит
  // — вставку выполняет обработчик редактора (Lexical / ProseMirror / Slate).
  function dispatchBeforeInput(el, value) {
    const evt = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: value
    });
    el.dispatchEvent(evt);
  }

  function dispatchPaste(el, value) {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    const evt = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true
    });
    // clipboardData конструктором не выставляется в свежих Chrome — определяем вручную.
    try { Object.defineProperty(evt, 'clipboardData', { value: dt }); } catch {}
    el.dispatchEvent(evt);
  }

  async function insertIntoContentEditable(el, value) {
    el.focus();

    // Выделяем текущее содержимое, чтобы вставка заменила его, а не дописала.
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    // Попытка 1: beforeinput — предпочтительный путь для Lexical и подобных.
    dispatchBeforeInput(el, value);
    await sleep(120);

    let text = el.textContent || '';
    let { count } = countProbe(text, value);
    if (count === 1) return { ok: true, actual: text.trim() };

    // Попытка 2: paste — на случай, если редактор слушает только вставку.
    // Сначала заново выделяем содержимое, чтобы не дописать к уже вставленному.
    if (count === 0) {
      const r2 = document.createRange();
      r2.selectNodeContents(el);
      const s2 = window.getSelection();
      s2?.removeAllRanges();
      s2?.addRange(r2);
      dispatchPaste(el, value);
      await sleep(160);

      text = el.textContent || '';
      count = countProbe(text, value).count;
      if (count === 1) return { ok: true, actual: text.trim() };
    }

    if (count === 0) {
      throw new Error(
        `contenteditable не принял текст. Ожидалось "${value.slice(0, 40)}…", ` +
        `в элементе "${text.trim().slice(0, 80)}".`
      );
    }
    if (count > 1) {
      throw new Error(
        `Редактор вставил текст ${count} раз вместо одного. ` +
        `В элементе "${text.trim().slice(0, 120)}". Это внутренняя проблема редактора, ` +
        `сообщите, пожалуйста, разработчику расширения.`
      );
    }
    return { ok: true, actual: text.trim() };
  }

  // ---------- operations ----------

  function describe() {
    registry.clear();
    nextId = 1;
    const out = [];
    const els = document.querySelectorAll(INTERACTIVE_SELECTOR);
    for (const el of els) {
      const d = buildDescriptor(el);
      if (!d.signature) continue;
      if (!d.visible) continue;
      const id = register(el);
      out.push({ id, ...d });
    }
    return out;
  }

  async function perform(id, action, payload) {
    const el = registry.get(id);
    if (!el || !el.isConnected) throw new Error('Элемент больше не в DOM');
    if (!isVisible(el)) throw new Error('Элемент невидим');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      throw new Error('Элемент disabled');
    }

    highlight(el);

    if (action === 'click') {
      el.click();
      return { ok: true, actual: null };
    }

    if (action === 'input') {
      if (isCovered(el)) {
        throw new Error(
          `Элемент ${el.tagName.toLowerCase()} перекрыт другим — вероятно, это скрытый «зеркальный» узел. ` +
          `Уточните формулировку цели, чтобы матч попал в видимый элемент.`
        );
      }
      if (!isEditable(el)) {
        throw new Error(
          `Элемент <${el.tagName.toLowerCase()}> не является редактируемым (не input/textarea/contenteditable)`
        );
      }

      const value = String(payload ?? '');

      if (el.isContentEditable) {
        return await insertIntoContentEditable(el, value);
      }

      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype :
                                    HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!descriptor?.set) throw new Error(`Не могу установить value у <${el.tagName.toLowerCase()}>`);

      if (el._valueTracker) { try { el._valueTracker.setValue(''); } catch {} }
      descriptor.set.call(el, value);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      await sleep(120);
      const actual = 'value' in el ? String(el.value ?? '') : '';
      if (actual !== value) {
        throw new Error(
          `Фреймворк откатил значение. Ожидалось "${value}", в элементе "${actual}". ` +
          `Элемент <${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''}>.`
        );
      }
      return { ok: true, actual };
    }

    if (action === 'select') {
      if (el.tagName !== 'SELECT') {
        el.click();
        return { ok: true, actual: null, note: 'custom select: открыт, опция не выбиралась' };
      }
      const wanted = normalize(payload);
      if (!wanted) throw new Error('Пустое значение для select');
      const opts = Array.from(el.options);
      const exact = opts.find(o => normalize(o.text) === wanted || normalize(o.value) === wanted);
      const partial = exact || opts.find(o => normalize(o.text).includes(wanted));
      if (!partial) throw new Error('Опция не найдена');
      if (el._valueTracker) { try { el._valueTracker.setValue(''); } catch {} }
      el.value = partial.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
      return { ok: true, actual: el.value };
    }

    throw new Error(`Неизвестное действие: ${action}`);
  }

  function snapshot() {
    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText || ''
    };
  }

  function waitForStable({ quietMs = 250, timeoutMs = 4000 } = {}) {
    return new Promise(resolve => {
      let quietTimer = setTimeout(done, quietMs);
      const hardTimer = setTimeout(done, timeoutMs);
      const obs = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      });
      obs.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
      let finished = false;
      function done() {
        if (finished) return;
        finished = true;
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        obs.disconnect();
        resolve();
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    try {
      if (msg.method === 'PING')     return void sendResponse({ ok: true });
      if (msg.method === 'DESCRIBE') return void sendResponse({ ok: true, elements: describe() });
      if (msg.method === 'SNAPSHOT') return void sendResponse({ ok: true, ...snapshot() });
      if (msg.method === 'HIGHLIGHT') {
        const el = registry.get(msg.params.id);
        if (!el) return void sendResponse({ ok: false, error: 'Нет такого id' });
        highlight(el, msg.params.color || '#b388ff', msg.params.options || {});
        return void sendResponse({ ok: true });
      }
      if (msg.method === 'PERFORM') {
        perform(msg.params.id, msg.params.action, msg.params.payload)
          .then(result => sendResponse({ ok: true, result }))
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      if (msg.method === 'WAIT_STABLE') {
        waitForStable(msg.params || {}).then(() => sendResponse({ ok: true }));
        return true;
      }
      sendResponse({ ok: false, error: `Неизвестный метод: ${msg.method}` });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  });
})();