// Offscreen document — hosts Stockfish WASM in a Web Worker

let engine = null;
let engineReady = false;
let pendingResolve = null;
let analysisLines = {};
let currentDepth = 0;

function initEngine() {
  const workerUrl = chrome.runtime.getURL('engine/stockfish-nnue-16-single.js');
  engine = new Worker(workerUrl);

  engine.onmessage = (e) => {
    handleEngineLine(e.data);
  };

  engine.onerror = (e) => {
    console.error('[Stockfish] Worker error:', e.message);
  };

  engine.postMessage('uci');
}

function handleEngineLine(line) {
  if (typeof line !== 'string') return;

  if (line === 'uciok') {
    engine.postMessage('setoption name Use NNUE value false');
    engine.postMessage('setoption name Hash value 32');
    engine.postMessage('setoption name MultiPV value 4');
    engine.postMessage('isready');
    return;
  }

  if (line === 'readyok') {
    engineReady = true;
    chrome.runtime.sendMessage({ target: 'background', type: 'ENGINE_READY' });
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
      const depth = parseInt(depthMatch[1]);
      const pvNum = pvMatch ? parseInt(pvMatch[1]) : 1;
      let score = 0;
      if (scoreCP) score = parseInt(scoreCP[1]);
      else if (scoreMate) score = parseInt(scoreMate[1]) > 0 ? 30000 : -30000;

      const moves = pvMoves ? pvMoves[1].trim().split(/\s+/) : [];

      if (moves.length > 0) {
        analysisLines[pvNum] = { score, depth, move: moves[0], pv: moves };
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
  return new Promise((resolve) => {
    analysisLines = {};
    pendingResolve = resolve;
    engine.postMessage('stop');
    engine.postMessage('setoption name MultiPV value ' + multiPV);
    engine.postMessage('position fen ' + fen);
    engine.postMessage('go depth ' + depth);
  });
}

// Listen for analysis requests from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'ANALYZE') {
    if (!engineReady) {
      sendResponse({ error: 'Engine not ready' });
      return;
    }
    analyze(message.fen, message.depth, message.multiPV).then(sendResponse);
    return true; // async
  }
});

initEngine();
