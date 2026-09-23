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
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
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

  function stripEmoji(s) {
    return String(s ?? '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/[\uFE0E\uFE0F\u200D\u20E3]/g, '');
  }

  function isEditable(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    return el.isContentEditable === true;
  }

  function isCheckable(el) {
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      return t === 'checkbox' || t === 'radio';
    }
    const role = el.getAttribute('role');
    return role === 'checkbox' || role === 'radio' || role === 'switch';
  }

  function isChecked(el) {
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      return !!el.checked;
    }
    const aria = el.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    const role = el.getAttribute('role');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      return el.getAttribute('data-state') === 'checked';
    }
    return false;
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

  // Текст ближайшего контейнера — используется для чекбоксов/радио,
  // у которых нет собственного текста, а смысл в соседнем <span>/<a>/<label>.
  function getContainerText(el) {
    let node = el.parentElement;
    let hops = 0;
    while (node && hops < 4) {
      const txt = (node.innerText || node.textContent || '').trim();
      if (txt.length > 0 && txt.length < 500) return txt;
      node = node.parentElement;
      hops++;
    }
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

    const checkable = isCheckable(el);
    const containerText = checkable && !label ? getContainerText(el) : '';

    const pieces = [aria, label, placeholder, title, alt, rawText, containerText]
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
      containerText: normalize(containerText),
      signature,
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      visible: isVisible(el),
      covered: isCovered(el),
      editable: isEditable(el),
      checkable,
      checked: checkable ? isChecked(el) : null
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
    if (!el || el.nodeType !== 1) return;
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

  // ---------- mouse ----------

  function dispatchMouseSequence(el, { button = 0, contextmenu = false } = {}) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y
    };

    const buttonsDown = button === 2 ? 2 : (button === 1 ? 4 : 1);

    try {
      el.dispatchEvent(new PointerEvent('pointerover',  { ...common, button: -1, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...common, button: -1, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove',  { ...common, button: -1, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerdown',  { ...common, button, buttons: buttonsDown, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } catch {}

    el.dispatchEvent(new MouseEvent('mouseover',  { ...common, button: -1, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...common, button: -1, buttons: 0, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove',  { ...common, button: -1, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mousedown',  { ...common, button, buttons: buttonsDown }));

    if (contextmenu) {
      const ctx = new MouseEvent('contextmenu', { ...common, button: 2, buttons: 2 });
      el.dispatchEvent(ctx);

      try {
        el.dispatchEvent(new PointerEvent('pointerup', { ...common, button: 2, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      } catch {}
      el.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 2, buttons: 0 }));

      return { defaultPrevented: ctx.defaultPrevented };
    }

    try {
      el.dispatchEvent(new PointerEvent('pointerup', { ...common, button, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', { ...common, button, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click',   { ...common, button, buttons: 0, detail: 1 }));

    return { defaultPrevented: false };
  }

  // ---------- keyboard ----------

  const KNOWN_KEYS = {
    enter:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
    tab:       { key: 'Tab',        code: 'Tab',        keyCode: 9  },
    escape:    { key: 'Escape',     code: 'Escape',     keyCode: 27 },
    esc:       { key: 'Escape',     code: 'Escape',     keyCode: 27 },
    backspace: { key: 'Backspace',  code: 'Backspace',  keyCode: 8  },
    delete:    { key: 'Delete',     code: 'Delete',     keyCode: 46 },
    del:       { key: 'Delete',     code: 'Delete',     keyCode: 46 },
    space:     { key: ' ',          code: 'Space',      keyCode: 32 },
    arrowup:   { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
    arrowdown: { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
    arrowleft: { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
    arrowright:{ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    up:        { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
    down:      { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
    left:      { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
    right:     { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home:      { key: 'Home',       code: 'Home',       keyCode: 36 },
    end:       { key: 'End',        code: 'End',        keyCode: 35 },
    pageup:    { key: 'PageUp',     code: 'PageUp',     keyCode: 33 },
    pagedown:  { key: 'PageDown',   code: 'PageDown',   keyCode: 34 }
  };

  function buildKeyInfo(spec) {
    const raw = String(spec ?? '').trim();
    if (!raw) return null;
    const parts = raw.split('+').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;

    let ctrl = false, alt = false, shift = false, meta = false;
    const last = parts.pop();
    for (const p of parts) {
      const l = p.toLowerCase();
      if (l === 'ctrl' || l === 'control') ctrl = true;
      else if (l === 'alt') alt = true;
      else if (l === 'shift') shift = true;
      else if (l === 'meta' || l === 'cmd' || l === 'win' || l === 'super') meta = true;
      else return null;
    }

    const k = last.toLowerCase();
    if (KNOWN_KEYS[k]) return { ...KNOWN_KEYS[k], ctrl, alt, shift, meta, spec: raw };

    if (/^f\d{1,2}$/.test(k)) {
      const n = parseInt(k.slice(1), 10);
      return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n, ctrl, alt, shift, meta, spec: raw };
    }

    if (last.length === 1) {
      const upper = last.toUpperCase();
      const isLetter = /[a-z]/i.test(last);
      const isDigit = /[0-9]/.test(last);
      return {
        key: shift ? upper : last,
        code: isLetter ? `Key${upper}` : (isDigit ? `Digit${last}` : ''),
        keyCode: upper.charCodeAt(0),
        ctrl, alt, shift, meta, spec: raw
      };
    }

    return null;
  }

  function dispatchKeyOn(el, info) {
    const opts = {
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      which: info.keyCode,
      bubbles: true,
      cancelable: true,
      ctrlKey: info.ctrl,
      altKey: info.alt,
      shiftKey: info.shift,
      metaKey: info.meta,
      composed: true
    };

    const kd = new KeyboardEvent('keydown', opts);
    el.dispatchEvent(kd);

    if (!info.ctrl && !info.alt && !info.meta && info.key.length === 1) {
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
    }

    el.dispatchEvent(new KeyboardEvent('keyup', opts));

    return { defaultPrevented: kd.defaultPrevented };
  }

  // ---------- contenteditable insertion ----------

  function countProbe(text, value) {
    const hay = stripEmoji(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const valueClean = stripEmoji(value).replace(/\s+/g, ' ').trim();
    const probe = Array.from(valueClean).slice(0, 15).join('').toLowerCase();
    if (!probe) return { count: hay.length > 0 ? 1 : 1, probe: '' };
    let count = 0;
    let idx = 0;
    while ((idx = hay.indexOf(probe, idx)) !== -1) {
      count++;
      idx += probe.length;
    }
    return { count, probe };
  }

  function dispatchBeforeInput(el, value) {
    const evt = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: value
    });
    el.dispatchEvent(evt);
  }

  function dispatchPaste(el, value) {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    try { Object.defineProperty(evt, 'clipboardData', { value: dt }); } catch {}
    el.dispatchEvent(evt);
  }

  async function insertIntoContentEditable(el, value) {
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    dispatchBeforeInput(el, value);
    await sleep(120);

    let text = el.textContent || '';
    let { count } = countProbe(text, value);
    if (count === 1) return { ok: true, actual: text.trim() };

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
        `В элементе "${text.trim().slice(0, 120)}".`
      );
    }
    return { ok: true, actual: text.trim() };
  }

  // ---------- check / uncheck ----------

  async function performCheck(el, wantChecked) {
    if (!isCheckable(el)) {
      // Кастомный «чекбокс» без role — просто кликаем.
      if (wantChecked !== null) {
        el.click();
        await sleep(80);
        return { ok: true, actual: 'clicked' };
      }
    }

    const before = isChecked(el);
    if (before === wantChecked) {
      return { ok: true, actual: wantChecked, alreadyInState: true };
    }

    el.focus();
    try { el.click(); } catch {}
    await sleep(80);

    let after = isChecked(el);

    // Если клик не изменил состояние — попробуем нативно установить value.
    if (after !== wantChecked && el.tagName === 'INPUT') {
      if (el._valueTracker) { try { el._valueTracker.setValue(!wantChecked); } catch {} }
      el.checked = wantChecked;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(60);
      after = isChecked(el);
    }

    if (after !== wantChecked) {
      throw new Error(
        `Не удалось ${wantChecked ? 'установить' : 'снять'} чекбокс. ` +
        `Состояние осталось ${after ? 'включённым' : 'выключенным'}. ` +
        `Тег <${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''}>.`
      );
    }

    return { ok: true, actual: after };
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

  async function performPress(id, keySpec) {
    const info = buildKeyInfo(keySpec);
    if (!info) throw new Error(`Неизвестная клавиша: "${keySpec}"`);

    let target = (id != null) ? registry.get(id) : null;
    if (!target || !target.isConnected) target = document.activeElement || document.body;
    if (!target) throw new Error('Нет активного элемента');

    highlight(target);
    try { target.focus({ preventScroll: false }); } catch {}
    await sleep(30);

    const { defaultPrevented } = dispatchKeyOn(target, info);
    await sleep(80);

    const tag = target.tagName ? target.tagName.toLowerCase() : '?';
    return { ok: true, actual: info.spec, pressedOn: `<${tag}>`, defaultPrevented };
  }

  async function perform(id, action, payload) {
    if (action === 'press') {
      return performPress(id, payload);
    }

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

    if (action === 'check') {
      if (isCovered(el)) {
        // Для чекбоксов перекрытие — часто норма: сам input скрыт, показан красивый кружок.
        // В этом случае кликаем по связанному label, если он есть.
        const label = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
        if (label) {
          label.click();
          await sleep(100);
          const after = isChecked(el);
          if (after === true) return { ok: true, actual: true, viaLabel: true };
        }
      }
      return await performCheck(el, true);
    }

    if (action === 'uncheck') {
      return await performCheck(el, false);
    }

    if (action === 'rightClick') {
      if (isCovered(el)) {
        throw new Error('Элемент перекрыт другим — правый клик попадёт не туда');
      }
      const { defaultPrevented } = dispatchMouseSequence(el, { button: 2, contextmenu: true });
      await sleep(120);
      return { ok: true, actual: 'contextmenu', defaultPrevented };
    }

    if (action === 'input') {
      if (isCovered(el)) {
        throw new Error(
          `Элемент ${el.tagName.toLowerCase()} перекрыт другим — вероятно, скрытый «зеркальный» узел.`
        );
      }
      if (!isEditable(el)) {
        throw new Error(`Элемент <${el.tagName.toLowerCase()}> не является редактируемым`);
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
          `Фреймворк откатил значение. Ожидалось "${value}", в элементе "${actual}".`
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

  function performScroll(params) {
    const { direction, amount, targetId } = params || {};

    if (targetId != null) {
      const el = registry.get(targetId);
      if (!el) throw new Error('Элемент не найден в реестре');
      highlight(el);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return { ok: true, mode: 'element' };
    }

    const amt = Number.isFinite(amount) ? amount : Math.round(window.innerHeight * 0.8);
    if (direction === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (direction === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    } else if (direction === 'up') {
      window.scrollBy({ top: -amt, behavior: 'smooth' });
    } else if (direction === 'down') {
      window.scrollBy({ top: amt, behavior: 'smooth' });
    } else {
      throw new Error(`Неизвестное направление скролла: "${direction}"`);
    }
    return { ok: true, mode: 'window', amount: amt };
  }

  function checkElement(id, kind, expected) {
    const el = registry.get(id);
    if (!el || !el.isConnected) {
      return { ok: false, error: 'Элемент больше не в DOM' };
    }

    const valOf = () =>
      'value' in el ? String(el.value ?? '') : (el.textContent || '').trim();

    if (kind === 'visible' || kind === 'exists') {
      if (!isVisible(el)) return { ok: false, error: 'Элемент не виден' };
      return { ok: true };
    }

    if (kind === 'enabled') {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return { ok: false, error: 'Элемент disabled' };
      }
      return { ok: true };
    }

    if (kind === 'disabled') {
      if (!(el.disabled || el.getAttribute('aria-disabled') === 'true')) {
        return { ok: false, error: 'Элемент активен' };
      }
      return { ok: true };
    }

    if (kind === 'empty') {
      const actual = valOf();
      if (actual === '') return { ok: true, details: { actual } };
      return { ok: false, error: `Не пусто: "${actual.slice(0, 60)}"`, details: { actual } };
    }

    if (kind === 'valueContains' || kind === 'valueEquals') {
      const actual = valOf();
      const want = String(expected ?? '');
      if (kind === 'valueContains') {
        if (normalize(actual).includes(normalize(want))) return { ok: true, details: { actual } };
        return { ok: false, error: `"${actual.slice(0, 60)}" не содержит "${want}"`, details: { actual } };
      }
      if (actual === want) return { ok: true, details: { actual } };
      return { ok: false, error: `"${actual.slice(0, 60)}" ≠ "${want}"`, details: { actual } };
    }

    if (kind === 'checked' || kind === 'unchecked') {
      if (!isCheckable(el)) {
        return { ok: false, error: 'Элемент не является чекбоксом' };
      }
      const actual = isChecked(el);
      if (kind === 'checked' && !actual) return { ok: false, error: 'Чекбокс не отмечен' };
      if (kind === 'unchecked' && actual) return { ok: false, error: 'Чекбокс отмечен' };
      return { ok: true, details: { actual } };
    }

    return { ok: false, error: `Неизвестный вид проверки: ${kind}` };
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

      if (msg.method === 'SCROLL') {
        try {
          const result = performScroll(msg.params || {});
          return void sendResponse({ ok: true, result });
        } catch (e) {
          return void sendResponse({ ok: false, error: e.message });
        }
      }

      if (msg.method === 'CHECK_ELEMENT') {
        try {
          const result = checkElement(msg.params.id, msg.params.kind, msg.params.expected);
          return void sendResponse(result.ok
            ? { ok: true, details: result.details }
            : { ok: false, error: result.error, details: result.details });
        } catch (e) {
          return void sendResponse({ ok: false, error: e.message });
        }
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