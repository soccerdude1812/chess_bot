// Offscreen document — hosts Stockfish WASM in a Web Worker

let engine = null;
let engineReady = false;
let pendingResolve = null;
let analysisLines = {};

function initEngine() {
  console.log('[CC] Initializing Stockfish engine...');
  try {
    const workerUrl = chrome.runtime.getURL('engine/stockfish-nnue-16-single.js');
    engine = new Worker(workerUrl);
  } catch (e) {
    console.error('[CC] Failed to create Worker:', e);
    return;
  }

  engine.onmessage = (e) => {
    handleEngineLine(e.data);
  };

  engine.onerror = (e) => {
    console.error('[CC] Worker error:', e.message);
  };

  // Start UCI handshake
  engine.postMessage('uci');

  // Safety timeout — if engine doesn't respond in 15s, mark as ready anyway
  // (classical eval fallback)
  setTimeout(() => {
    if (!engineReady) {
      console.warn('[CC] Engine init timed out — marking ready with fallback');
      engineReady = true;
      try {
        chrome.runtime.sendMessage({ target: 'background', type: 'ENGINE_READY' });
      } catch (e) { /* ignore */ }
    }
  }, 15000);
}

function handleEngineLine(line) {
  if (typeof line !== 'string') return;

  if (line === 'uciok') {
    console.log('[CC] Engine UCI ready, configuring...');
    engine.postMessage('setoption name Hash value 32');
    engine.postMessage('setoption name MultiPV value 4');
    engine.postMessage('isready');
    return;
  }

  if (line === 'readyok') {
    console.log('[CC] Engine fully ready');
    engineReady = true;
    try {
      chrome.runtime.sendMessage({ target: 'background', type: 'ENGINE_READY' });
    } catch (e) { /* service worker may be inactive */ }
    return;
  }

  // Parse "info" lines with analysis data
  if (line.startsWith('info') && line.includes(' pv ')) {
    const pvMatch = line.match(/multipv (\d+)/);
    const depthMatch = line.match(/depth (\d+)/);
    const scoreCP = line.match(/score cp (-?\d+)/);
    const scoreMate = line.match(/score mate (-?\d+)/);
    const pvMoves = line.match(/ pv (.+)/);

    if (depthMatch) {
      const pvNum = pvMatch ? parseInt(pvMatch[1]) : 1;
      let score = 0;
      let mate = null;
      if (scoreCP) score = parseInt(scoreCP[1]);
      else if (scoreMate) {
        mate = parseInt(scoreMate[1]);
        // Prefer shorter mates: fold distance into the score magnitude so the
        // move selector ranks "mate in 1" above "mate in 5".
        score = mate > 0 ? 30000 - mate : -30000 - mate;
      }

      const moves = pvMoves ? pvMoves[1].trim().split(/\s+/) : [];
      if (moves.length > 0) {
        analysisLines[pvNum] = { score, mate, depth: parseInt(depthMatch[1]), move: moves[0], pv: moves };
      }
    }
    return;
  }

  // "bestmove" signals analysis complete
  if (line.startsWith('bestmove')) {
    const moves = [];
    const keys = Object.keys(analysisLines).map(Number).sort((a, b) => a - b);
    for (const k of keys) {
      moves.push(analysisLines[k]);
    }
    if (pendingResolve) {
      pendingResolve({ moves });
      pendingResolve = null;
    }
    analysisLines = {};
  }
}

function analyze(fen, depth, multiPV) {
  return new Promise((resolve, reject) => {
    analysisLines = {};
    pendingResolve = resolve;
    engine.postMessage('stop');
    engine.postMessage('setoption name MultiPV value ' + multiPV);
    engine.postMessage('position fen ' + fen);
    engine.postMessage('go depth ' + depth);

    // Analysis timeout — 30 seconds max
    setTimeout(() => {
      if (pendingResolve === resolve) {
        console.warn('[CC] Analysis timed out');
        const moves = [];
        const keys = Object.keys(analysisLines).map(Number).sort((a, b) => a - b);
        for (const k of keys) moves.push(analysisLines[k]);
        pendingResolve = null;
        resolve({ moves, timeout: true });
      }
    }, 30000);
  });
}

// Listen for analysis requests from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return;

  if (message.type === 'ANALYZE') {
    if (!engineReady) {
      sendResponse({ error: 'Engine not ready yet — still initializing' });
      return;
    }
    analyze(message.fen, message.depth, message.multiPV).then(sendResponse);
    return true; // async
  }
});

initEngine();
