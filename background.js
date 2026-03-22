// Background service worker — coordinates content script ↔ offscreen (Stockfish)

let offscreenCreated = false;

async function ensureOffscreen() {
  if (offscreenCreated) return;
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Running Stockfish chess engine in a Web Worker'
      });
    }
    offscreenCreated = true;
  } catch (e) {
    // Document may already exist
    offscreenCreated = true;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    if (message.type === 'ANALYZE') {
      const tabId = sender.tab?.id;
      ensureOffscreen().then(() => {
        chrome.runtime.sendMessage(
          { target: 'offscreen', type: 'ANALYZE', fen: message.fen, depth: message.depth || 15, multiPV: message.multiPV || 4 },
          (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ error: chrome.runtime.lastError.message });
              return;
            }
            sendResponse(response);
          }
        );
      });
      return true;
    }

    if (message.type === 'ENGINE_READY') {
      offscreenCreated = true;
    }
  }
});

// Initialize default state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: false, mode: 'suggest' });
});
