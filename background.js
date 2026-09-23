// background.js

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'TAB_CALL') {
    callTab(msg.tabId, msg.method, msg.params, { allowNavigated: !!msg.allowNavigated })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === 'TABS_CALL') {
    handleTabsCall(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === 'OPEN_PANEL') {
    chrome.sidePanel.open({ windowId: msg.windowId }).catch(() => {});
    return false;
  }
});

const CHANNEL_CLOSED_RE = /message channel closed|Receiving end does not exist|Could not establish connection|The message port closed/i;

// ---------- content script bridge ----------

async function callTab(tabId, method, params, { allowNavigated = false } = {}) {
  try {
    await ensureInjected(tabId);
    return await chrome.tabs.sendMessage(tabId, { method, params });
  } catch (e) {
    const msgText = String(e?.message || e);

    if (CHANNEL_CLOSED_RE.test(msgText)) {
      // Оборвался канал. Возможны две причины:
      // 1) страница ушла в навигацию — нормально для действий;
      // 2) content script умер по другой причине (перезагрузка расширения, крэш таба).
      if (allowNavigated) {
        return { ok: true, navigated: true, result: { actual: null, navigated: true } };
      }
      // Для чтения — попробуем один раз после переинъекции.
      await new Promise(r => setTimeout(r, 400));
      await ensureInjected(tabId);
      return await chrome.tabs.sendMessage(tabId, { method, params });
    }

    throw e;
  }
}

async function ensureInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { method: 'PING' });
    if (pong?.ok) return;
  } catch {}
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content_script.js']
  });
}

// ---------- tabs API ----------

async function handleTabsCall(msg) {
  const { method, params } = msg;
  switch (method) {
    case 'LIST':       return { ok: true, tabs: await listTabs(params?.currentTabId) };
    case 'SWITCH':     return { ok: true, tab: await switchTab(params?.currentTabId, params?.needle) };
    case 'OPEN':       return { ok: true, tab: await openTab(params?.currentTabId, params?.url) };
    case 'CLOSE':      return { ok: true, result: await closeTab(params?.currentTabId, params?.needle) };
    case 'RELOAD':     return await reloadTab(params?.currentTabId);
    case 'GO_BACK':    return await goBackTab(params?.currentTabId);
    case 'GO_FORWARD': return await goForwardTab(params?.currentTabId);
    case 'CYCLE':      return { ok: true, tab: await cycleTab(params?.currentTabId, params?.dir) };
    default: throw new Error(`Неизвестная команда TABS: ${method}`);
  }
}

async function getWindowIdFor(currentTabId) {
  if (currentTabId == null) return null;
  try {
    const cur = await chrome.tabs.get(currentTabId);
    return cur.windowId;
  } catch {
    return null;
  }
}

async function listTabs(currentTabId) {
  const windowId = await getWindowIdFor(currentTabId);
  const query = windowId != null ? { windowId } : { currentWindow: true };
  const tabs = await chrome.tabs.query(query);
  return tabs.map(t => ({
    id: t.id,
    title: t.title || '',
    url: t.url || '',
    active: !!t.active,
    pinned: !!t.pinned
  }));
}

async function findTab(currentTabId, needle) {
  const windowId = await getWindowIdFor(currentTabId);
  if (windowId == null) throw new Error('Нет рабочей вкладки');

  const tabs = await chrome.tabs.query({ windowId });
  const n = String(needle || '').toLowerCase().trim();
  if (!n) return null;

  let exact = tabs.find(t => (t.title || '').toLowerCase().trim() === n);
  if (exact) return exact;
  exact = tabs.find(t => (t.url || '').toLowerCase().trim() === n);
  if (exact) return exact;

  const subs = tabs.filter(t =>
    (t.title || '').toLowerCase().includes(n) ||
    (t.url || '').toLowerCase().includes(n)
  );
  if (!subs.length) return null;

  return subs.find(t => t.active) || subs[0];
}

async function focusWindow(windowId) {
  if (windowId == null) return;
  try { await chrome.windows.update(windowId, { focused: true }); } catch {}
}

async function switchTab(currentTabId, needle) {
  const found = await findTab(currentTabId, needle);
  if (!found) throw new Error(`Вкладка "${needle}" не найдена в текущем окне`);
  await chrome.tabs.update(found.id, { active: true });
  await focusWindow(found.windowId);
  return { id: found.id, title: found.title || '', url: found.url || '' };
}

async function openTab(currentTabId, url) {
  const windowId = await getWindowIdFor(currentTabId);
  const created = await chrome.tabs.create({
    url: url || 'about:blank',
    active: true,
    ...(windowId != null ? { windowId } : {})
  });
  await focusWindow(created.windowId);
  const finalTab = await waitForComplete(created.id, 8000).catch(() => created);
  return {
    id: finalTab.id,
    title: finalTab.title || '',
    url: finalTab.url || url || ''
  };
}

async function waitForComplete(tabId, timeoutMs) {
  const now = await chrome.tabs.get(tabId);
  if (now.status === 'complete') return now;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.get(tabId).then(resolve, reject);
    }, timeoutMs);

    function listener(updatedId, info, tab) {
      if (updatedId !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function closeTab(currentTabId, needle) {
  const windowId = await getWindowIdFor(currentTabId);
  if (windowId == null) throw new Error('Нет рабочей вкладки');

  const tabs = await chrome.tabs.query({ windowId });

  let targetId = currentTabId;
  if (needle) {
    const found = await findTab(currentTabId, needle);
    if (!found) throw new Error(`Вкладка "${needle}" не найдена`);
    targetId = found.id;
  }

  if (tabs.length <= 1) {
    throw new Error('Нельзя закрыть единственную вкладку в окне — окно закроется вместе с панелью');
  }

  const target = tabs.find(t => t.id === targetId);
  const idx = tabs.findIndex(t => t.id === targetId);

  await chrome.tabs.remove(targetId);

  const after = await chrome.tabs.query({ windowId });
  const newActive = after.find(t => t.active) || after[Math.max(0, idx - 1)] || after[0];

  return {
    closed: { id: targetId, title: target?.title || '', url: target?.url || '' },
    active: newActive
      ? { id: newActive.id, title: newActive.title || '', url: newActive.url || '' }
      : null
  };
}

async function reloadTab(currentTabId) {
  if (currentTabId == null) throw new Error('Нет рабочей вкладки');
  await chrome.tabs.reload(currentTabId);
  return { ok: true };
}

async function goBackTab(currentTabId) {
  if (currentTabId == null) throw new Error('Нет рабочей вкладки');
  try {
    await chrome.tabs.goBack(currentTabId);
  } catch (e) {
    throw new Error(`Не удалось вернуться назад: ${e.message}`);
  }
  return { ok: true };
}

async function goForwardTab(currentTabId) {
  if (currentTabId == null) throw new Error('Нет рабочей вкладки');
  try {
    await chrome.tabs.goForward(currentTabId);
  } catch (e) {
    throw new Error(`Не удалось перейти вперёд: ${e.message}`);
  }
  return { ok: true };
}

async function cycleTab(currentTabId, dir) {
  if (currentTabId == null) throw new Error('Нет рабочей вкладки');
  const windowId = await getWindowIdFor(currentTabId);
  const tabs = await chrome.tabs.query({ windowId });
  if (tabs.length < 2) throw new Error('В окне только одна вкладка');

  const idx = tabs.findIndex(t => t.id === currentTabId);
  const step = (dir < 0 ? -1 : 1);
  const nextIdx = (idx + step + tabs.length) % tabs.length;
  const target = tabs[nextIdx];

  await chrome.tabs.update(target.id, { active: true });
  await focusWindow(windowId);
  return { id: target.id, title: target.title || '', url: target.url || '' };
}