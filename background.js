// background.js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'TAB_CALL') {
    callTab(msg.tabId, msg.method, msg.params)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'OPEN_PANEL') {
    chrome.sidePanel.open({ windowId: msg.windowId }).catch(() => {});
    return false;
  }
});

async function callTab(tabId, method, params) {
  await ensureInjected(tabId);
  return chrome.tabs.sendMessage(tabId, { method, params });
}

async function ensureInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { method: 'PING' });
    if (pong?.ok) return;
  } catch {
    // not injected yet
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content_script.js']
  });
}