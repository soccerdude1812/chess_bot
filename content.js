// Content script — chess.com board integration
// Reads board state, communicates with Stockfish, executes/suggests moves

(() => {
  'use strict';

  // ======================== STATE ========================
  let enabled = false;
  let mode = 'suggest';
  let analyzing = false;
  let myColor = null;       // 'w' | 'b'
  let colorSetting = 'auto'; // 'w' | 'b' | 'auto'
  let targetElo = 2700;
  let boardEl = null;
  let observer = null;
  let moveInProgress = false;
  let lastFEN = '';
  let analyzeTimer = null;
  let overlayEl = null;
  let arrowSvg = null;

  // ======================== BOARD READER ========================

  function findBoard() {
    boardEl = document.querySelector('wc-chess-board, chess-board');
    return !!boardEl;
  }

  function detectMyColor() {
    if (colorSetting === 'w' || colorSetting === 'b') {
      myColor = colorSetting;
      return myColor;
    }
    // Auto-detect: chess.com flips the board for black
    if (!boardEl) return null;
    const isFlipped = boardEl.classList.contains('flipped') ||
                      boardEl.getAttribute('flipped') !== null;
    myColor = isFlipped ? 'b' : 'w';
    return myColor;
  }

  function readPieces() {
    if (!boardEl) return [];
    const pieces = boardEl.querySelectorAll('.piece');
    const result = [];
    for (const el of pieces) {
      const classes = el.className.split(/\s+/);
      let type = null, file = 0, rank = 0;
      for (const cls of classes) {
        if (/^[wb][pnbrqk]$/.test(cls)) type = cls;
        const sqMatch = cls.match(/^square-(\d)(\d)$/);
        if (sqMatch) { file = parseInt(sqMatch[1]); rank = parseInt(sqMatch[2]); }
      }
      if (type && file && rank) result.push({ type, file, rank });
    }
    return result;
  }

  function pieceFENChar(type) {
    const map = {
      wp: 'P', wn: 'N', wb: 'B', wr: 'R', wq: 'Q', wk: 'K',
      bp: 'p', bn: 'n', bb: 'b', br: 'r', bq: 'q', bk: 'k'
    };
    return map[type] || '';
  }

  function buildFEN(pieces, activeColor) {
    const board = Array.from({ length: 8 }, () => Array(8).fill(''));
    for (const p of pieces) {
      board[7 - (p.rank - 1)][p.file - 1] = pieceFENChar(p.type);
    }

    let fen = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        if (board[r][f]) { if (empty) { fen += empty; empty = 0; } fen += board[r][f]; }
        else empty++;
      }
      if (empty) fen += empty;
      if (r < 7) fen += '/';
    }
    fen += ' ' + activeColor;

    let castling = '';
    const has = (t, f, r) => pieces.some(p => p.type === t && p.file === f && p.rank === r);
    if (has('wk', 5, 1)) { if (has('wr', 8, 1)) castling += 'K'; if (has('wr', 1, 1)) castling += 'Q'; }
    if (has('bk', 5, 8)) { if (has('br', 8, 8)) castling += 'k'; if (has('br', 1, 8)) castling += 'q'; }
    fen += ' ' + (castling || '-') + ' - 0 1';
    return fen;
  }

  function getActiveColor() {
    const moveList = document.querySelector('.move-list-wrapper, .play-controller-moves, .vertical-move-list');
    if (moveList) {
      const moveEls = moveList.querySelectorAll('.move-text-component, .white-move, .black-move, [data-ply]');
      if (moveEls.length > 0) return moveEls.length % 2 === 0 ? 'w' : 'b';
    }
    return 'w';
  }

  function getCurrentFEN() {
    const pieces = readPieces();
    if (pieces.length === 0) return null;
    return buildFEN(pieces, getActiveColor());
  }

  function isMyTurn() { return getActiveColor() === myColor; }

  // ======================== MOVE MAKER ========================

  function squareToCoords(sq) {
    return { file: sq.charCodeAt(0) - 97, rank: parseInt(sq[1]) - 1 };
  }

  function getSquareScreenPos(file, rank) {
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    const sqSize = rect.width / 8;
    const flipped = myColor === 'b';
    let x = rect.left + (flipped ? (7 - file) : file) * sqSize + sqSize / 2;
    let y = rect.top + (flipped ? rank : (7 - rank)) * sqSize + sqSize / 2;
    x += (Math.random() - 0.5) * sqSize * 0.3;
    y += (Math.random() - 0.5) * sqSize * 0.3;
    return { x, y };
  }

  // Get square center as percentage of board (for SVG arrow)
  function getSquarePct(file, rank) {
    const flipped = myColor === 'b';
    const x = ((flipped ? (7 - file) : file) + 0.5) * 12.5;
    const y = ((flipped ? rank : (7 - rank)) + 0.5) * 12.5;
    return { x, y };
  }

  function fireMouseEvent(type, x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerdown' ? 1 : 0
    }));
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function executeMove(uciMove) {
    const from = uciMove.substring(0, 2), to = uciMove.substring(2, 4);
    const promotion = uciMove.length > 4 ? uciMove[4] : null;
    const fromPos = getSquareScreenPos(squareToCoords(from).file, squareToCoords(from).rank);
    const toPos = getSquareScreenPos(squareToCoords(to).file, squareToCoords(to).rank);
    if (!fromPos || !toPos) return false;

    moveInProgress = true;
    fireMouseEvent('pointerdown', fromPos.x, fromPos.y);
    await delay(40 + Math.random() * 80);
    fireMouseEvent('pointerup', fromPos.x, fromPos.y);
    fireMouseEvent('click', fromPos.x, fromPos.y);
    await delay(80 + Math.random() * 150);
    fireMouseEvent('pointerdown', toPos.x, toPos.y);
    await delay(40 + Math.random() * 80);
    fireMouseEvent('pointerup', toPos.x, toPos.y);
    fireMouseEvent('click', toPos.x, toPos.y);

    if (promotion) {
      await delay(200 + Math.random() * 300);
      const promoMap = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
      const el = document.querySelector(`.promotion-piece[class*="${promoMap[promotion] || 'queen'}"]`);
      if (el) { const r = el.getBoundingClientRect(); fireMouseEvent('click', r.left + r.width/2, r.top + r.height/2); }
    }
    await delay(100);
    moveInProgress = false;
    return true;
  }

  // ======================== ELO SIMULATOR ========================

  function selectMoveByElo(moves, elo) {
    if (!moves || moves.length === 0) return null;
    if (moves.length === 1) return moves[0];

    const best = moves[0].score;

    // Scale weights and tolerance by ELO
    // Higher ELO = more likely to play best move, tighter centipawn tolerance
    const t = Math.max(0, Math.min(1, (elo - 1200) / 1600)); // 0 at 1200, 1 at 2800

    const bestWeight = 20 + t * 55;            // 20 at 1200, 75 at 2800
    const secondWeight = 30 - t * 10;          // 30 at 1200, 20 at 2800
    const thirdWeight = 28 - t * 18;           // 28 at 1200, 10 at 2800
    const fourthWeight = 22 - t * 18;          // 22 at 1200, 4 at 2800

    const cpTolerance2 = 300 - t * 260;        // 300cp at 1200, 40cp at 2800
    const cpTolerance3 = 500 - t * 425;        // 500cp at 1200, 75cp at 2800
    const cpTolerance4 = 700 - t * 580;        // 700cp at 1200, 120cp at 2800

    const baseWeights = [bestWeight, secondWeight, thirdWeight, fourthWeight];
    const tolerances = [Infinity, cpTolerance2, cpTolerance3, cpTolerance4];

    const candidates = [];
    for (let i = 0; i < Math.min(moves.length, 4); i++) {
      const diff = Math.abs(best - moves[i].score);
      if (diff <= tolerances[i]) {
        let w = baseWeights[i];
        // In winning positions, slightly less accurate (overconfidence)
        if (Math.abs(best) > 300 && i > 0) w *= 1.2;
        // In critical positions, more precise
        if (Math.abs(best) < 50 && i > 0) w *= 0.7;
        candidates.push({ ...moves[i], weight: w });
      }
    }
    if (candidates.length === 0) return moves[0];

    const total = candidates.reduce((s, c) => s + c.weight, 0);
    let rand = Math.random() * total;
    for (const c of candidates) { rand -= c.weight; if (rand <= 0) return c; }
    return candidates[0];
  }

  // ======================== HUMAN TIMING ========================

  function getThinkTimeMs() {
    const clockEl = document.querySelector('.clock-time-monospace.clock-bottom, .clock-component.clock-bottom');
    let timeLeftSec = 300;
    if (clockEl) {
      const text = clockEl.textContent.trim();
      const parts = text.split(':').map(Number);
      if (parts.length === 2) timeLeftSec = parts[0] * 60 + parts[1];
      else if (parts.length === 1) timeLeftSec = parseFloat(text) || 300;
    }

    let baseMs;
    if (timeLeftSec < 15) baseMs = 500 + Math.random() * 1500;
    else if (timeLeftSec < 30) baseMs = 1000 + Math.random() * 2500;
    else if (timeLeftSec < 60) baseMs = 1500 + Math.random() * 4000;
    else if (timeLeftSec < 180) baseMs = 2000 + Math.random() * 5000;
    else if (timeLeftSec < 600) baseMs = 3000 + Math.random() * 7000;
    else baseMs = 4000 + Math.random() * 12000;

    if (Math.random() < 0.12) baseMs *= 1.4 + Math.random() * 0.8;
    if (Math.random() < 0.08) baseMs *= 0.3 + Math.random() * 0.3;
    return Math.floor(baseMs);
  }

  // ======================== ARROW + OVERLAY UI ========================

  function uciToAlgebraic(uci) {
    if (!uci || uci.length < 4) return uci;
    const from = uci.substring(0, 2).toUpperCase();
    const to = uci.substring(2, 4).toUpperCase();
    const promo = uci.length > 4 ? '=' + uci[4].toUpperCase() : '';
    return from[0].toLowerCase() + from[1] + ' \u2192 ' + to[0].toLowerCase() + to[1] + promo;
  }

  function createOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'cc-overlay';
    overlayEl.innerHTML = '<div class="cc-status">Off</div><div class="cc-move" style="display:none"></div>';
    document.body.appendChild(overlayEl);
  }

  function updateOverlay(status, moveUCI) {
    if (!overlayEl) createOverlay();
    const statusEl = overlayEl.querySelector('.cc-status');
    const moveEl = overlayEl.querySelector('.cc-move');
    statusEl.textContent = status;
    statusEl.className = 'cc-status' + (enabled ? ' cc-active' : '');
    if (moveUCI) {
      moveEl.style.display = 'block';
      moveEl.textContent = uciToAlgebraic(moveUCI);
    } else {
      moveEl.style.display = 'none';
    }
  }

  function drawArrow(fromSq, toSq) {
    clearArrow();
    if (!boardEl) return;

    const fromCoords = squareToCoords(fromSq);
    const toCoords = squareToCoords(toSq);
    const from = getSquarePct(fromCoords.file, fromCoords.rank);
    const to = getSquarePct(toCoords.file, toCoords.rank);

    // Shorten arrow so the tip doesn't cover the center of the destination square
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const shorten = 2.5; // percentage units to pull back
    const tipX = to.x - (dx / len) * shorten;
    const tipY = to.y - (dy / len) * shorten;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('data-cc-arrow', 'true');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:90;';

    // Arrow marker definition
    svg.innerHTML = `
      <defs>
        <marker id="cc-arrowhead" markerWidth="4" markerHeight="3.5" refX="3.5" refY="1.75" orient="auto">
          <polygon points="0 0, 4 1.75, 0 3.5" fill="rgba(76,175,80,0.85)" />
        </marker>
      </defs>
      <line x1="${from.x}" y1="${from.y}" x2="${tipX}" y2="${tipY}"
        stroke="rgba(76,175,80,0.75)" stroke-width="2.2" stroke-linecap="round"
        marker-end="url(#cc-arrowhead)" />
      <circle cx="${from.x}" cy="${from.y}" r="2.8" fill="rgba(76,175,80,0.5)" />
    `;

    boardEl.style.position = boardEl.style.position || 'relative';
    boardEl.appendChild(svg);
    arrowSvg = svg;
  }

  function clearArrow() {
    if (arrowSvg) { arrowSvg.remove(); arrowSvg = null; }
    if (boardEl) boardEl.querySelectorAll('[data-cc-arrow]').forEach(el => el.remove());
  }

  // ======================== ANALYSIS PIPELINE ========================

  async function runAnalysis() {
    if (analyzing || moveInProgress || !enabled) return;
    if (!isMyTurn()) { updateOverlay('Waiting', null); return; }

    analyzing = true;
    updateOverlay('Thinking...', null);
    clearArrow();

    const fen = getCurrentFEN();
    if (!fen || fen === lastFEN) { analyzing = false; return; }
    lastFEN = fen;

    try {
      const response = await chrome.runtime.sendMessage({
        target: 'background', type: 'ANALYZE', fen, depth: 15, multiPV: 4
      });

      if (!response || response.error || !response.moves || response.moves.length === 0) {
        updateOverlay('Error', null);
        analyzing = false;
        return;
      }

      const selected = selectMoveByElo(response.moves, targetElo);
      if (!selected) { analyzing = false; return; }

      const moveStr = selected.move;

      if (mode === 'auto') {
        const thinkTime = getThinkTimeMs();
        updateOverlay('Playing...', moveStr);
        drawArrow(moveStr.substring(0, 2), moveStr.substring(2, 4));
        await delay(thinkTime);
        if (enabled && isMyTurn()) {
          clearArrow();
          await executeMove(moveStr);
          updateOverlay('Played', moveStr);
        }
      } else {
        // Suggest mode — draw arrow and show move
        updateOverlay('Suggested', moveStr);
        drawArrow(moveStr.substring(0, 2), moveStr.substring(2, 4));
      }
    } catch (e) {
      updateOverlay('Error', null);
    }
    analyzing = false;
  }

  // ======================== BOARD OBSERVER ========================

  function startObserving() {
    if (observer) observer.disconnect();
    if (!boardEl) return;

    observer = new MutationObserver(() => {
      if (moveInProgress) return;
      clearTimeout(analyzeTimer);
      analyzeTimer = setTimeout(() => {
        if (enabled && isMyTurn()) runAnalysis();
        else if (enabled) { updateOverlay('Waiting', null); clearArrow(); lastFEN = ''; }
      }, 600);
    });

    observer.observe(boardEl, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
    });
  }

  // ======================== INIT ========================

  function loadSettings(cb) {
    chrome.storage.local.get(['enabled', 'mode', 'myColor', 'targetElo'], (data) => {
      if (chrome.runtime.lastError) return;
      enabled = !!data.enabled;
      mode = data.mode || 'suggest';
      colorSetting = data.myColor || 'auto';
      targetElo = data.targetElo || 2700;
      detectMyColor();
      if (cb) cb();
    });
  }

  function tryInit() {
    if (!findBoard()) { setTimeout(tryInit, 1000); return; }

    createOverlay();
    loadSettings(() => {
      startObserving();
      updateOverlay(enabled ? 'Ready' : 'Off', null);
      if (enabled && isMyTurn()) runAnalysis();
    });
  }

  // Listen for settings changes from popup
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled) {
        if (!boardEl) tryInit();
        else { detectMyColor(); updateOverlay('Ready', null); if (isMyTurn()) runAnalysis(); }
      } else { updateOverlay('Off', null); clearArrow(); }
    }
    if (changes.mode) mode = changes.mode.newValue;
    if (changes.myColor) { colorSetting = changes.myColor.newValue; detectMyColor(); }
    if (changes.targetElo) targetElo = changes.targetElo.newValue;
  });

  // Re-detect board on SPA navigation
  const pageObserver = new MutationObserver(() => {
    if (!boardEl || !document.body.contains(boardEl)) {
      boardEl = null; observer?.disconnect(); clearTimeout(analyzeTimer);
      setTimeout(tryInit, 500);
    }
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  tryInit();
})();
