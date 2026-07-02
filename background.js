// Background service worker — coordinates content script ↔ offscreen (Stockfish)

let offscreenCreated = false;

async function ensureOffscreen() {
  if (offscreenCreated) return true;
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Running Stockfish chess engine in a Web Worker'
        });
      }
    }
    offscreenCreated = true;
    return true;
  } catch (e) {
    if (e.message && e.message.includes('already exists')) {
      offscreenCreated = true;
      return true;
    }
    console.error('[CC] Offscreen creation error:', e);
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.target) return;

  if (message.target === 'background') {
    if (message.type === 'ANALYZE') {
      ensureOffscreen().then((ok) => {
        if (!ok) {
          sendResponse({ error: 'Failed to create engine host' });
          return;
        }
        try {
          chrome.runtime.sendMessage(
            { target: 'offscreen', type: 'ANALYZE', fen: message.fen, depth: message.depth || 15, multiPV: message.multiPV || 4 },
            (response) => {
              if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
                return;
              }
              sendResponse(response || { error: 'No response from engine' });
            }
          );
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    if (message.type === 'ENGINE_READY') {
      console.log('[CC] Engine reported ready');
      offscreenCreated = true;
    }
  }
});

// Keyboard shortcut → toggle the extension on the active chess.com tab.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-enabled') return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'TOGGLE_ENABLED' }, () => {
          void chrome.runtime.lastError; // ignore if no content script on this tab
        });
      }
    });
  });
}

// Initialize default state on install and pre-warm the engine
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: false, mode: 'suggest' });
  // Pre-create offscreen document so engine is ready when needed
  ensureOffscreen();
});

// Also pre-warm on service worker startup
ensureOffscreen();
