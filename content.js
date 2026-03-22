// Content script — chess.com board integration
// Reads board state, communicates with Stockfish, executes/suggests moves

(() => {
  'use strict';

  // ======================== STATE ========================
  let enabled = false;
  let mode = 'suggest'; // 'suggest' | 'auto'
  let analyzing = false;
  let myColor = null; // 'w' | 'b'
  let boardEl = null;
  let observer = null;
  let moveInProgress = false;
  let lastFEN = '';
  let analyzeTimer = null;
  let overlayEl = null;
  let gameStarted = false;

  // ======================== BOARD READER ========================

  function findBoard() {
    boardEl = document.querySelector('wc-chess-board, chess-board');
    return !!boardEl;
  }

  function detectMyColor() {
    if (!boardEl) return null;
    // chess.com flips the board for black — check the board's `flipped` attribute or class
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
      let type = null;
      let file = 0;
      let rank = 0;
      for (const cls of classes) {
        if (/^[wb][pnbrqk]$/.test(cls)) type = cls;
        const sqMatch = cls.match(/^square-(\d)(\d)$/);
        if (sqMatch) {
          file = parseInt(sqMatch[1]);
          rank = parseInt(sqMatch[2]);
        }
      }
      if (type && file && rank) {
        result.push({ type, file, rank });
      }
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
    // Build 8x8 board (rank 8 = index 0)
    const board = Array.from({ length: 8 }, () => Array(8).fill(''));
    for (const p of pieces) {
      const f = p.file - 1; // 0-indexed
      const r = p.rank - 1;
      board[7 - r][f] = pieceFENChar(p.type);
    }

    let fen = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        if (board[r][f]) {
          if (empty) { fen += empty; empty = 0; }
          fen += board[r][f];
        } else {
          empty++;
        }
      }
      if (empty) fen += empty;
      if (r < 7) fen += '/';
    }

    // Active color
    fen += ' ' + activeColor;

    // Castling — infer from king/rook positions
    let castling = '';
    const has = (type, f, r) => pieces.some(p => p.type === type && p.file === f && p.rank === r);
    if (has('wk', 5, 1)) {
      if (has('wr', 8, 1)) castling += 'K';
      if (has('wr', 1, 1)) castling += 'Q';
    }
    if (has('bk', 5, 8)) {
      if (has('br', 8, 8)) castling += 'k';
      if (has('br', 1, 8)) castling += 'q';
    }
    fen += ' ' + (castling || '-');

    // En passant — skip for simplicity (minor impact on analysis)
    fen += ' -';

    // Halfmove clock and fullmove number
    fen += ' 0 1';

    return fen;
  }

  function getActiveColor() {
    // Method 1: count moves in the move list
    const moveList = document.querySelector('.move-list-wrapper, .play-controller-moves, .vertical-move-list');
    if (moveList) {
      const moveEls = moveList.querySelectorAll('.move-text-component, .white-move, .black-move, [data-ply]');
      if (moveEls.length > 0) {
        // Each move element is one half-move; even count = white's turn
        return moveEls.length % 2 === 0 ? 'w' : 'b';
      }
    }

    // Method 2: check clock highlighting
    const clocks = document.querySelectorAll('.clock-component, .clock-time-monospace');
    for (const clock of clocks) {
      const parent = clock.closest('.clock-bottom, .clock-top, [class*="clock"]');
      if (parent && parent.classList.contains('clock-player-turn')) {
        // This clock is active
        const isBottom = parent.classList.contains('clock-bottom') ||
                         parent.closest('.board-layout-bottom') !== null;
        if (myColor === 'w') return isBottom ? 'w' : 'b';
        if (myColor === 'b') return isBottom ? 'b' : 'w';
      }
    }

    // Method 3: piece count heuristic (white moves first in starting position)
    return 'w';
  }

  function getCurrentFEN() {
    const pieces = readPieces();
    if (pieces.length === 0) return null;
    const active = getActiveColor();
    return buildFEN(pieces, active);
  }

  function isMyTurn() {
    const active = getActiveColor();
    return active === myColor;
  }

  // ======================== MOVE MAKER ========================

  function squareToCoords(sq) {
    // sq is UCI format like "e2" → file index 0-7, rank index 0-7
    const file = sq.charCodeAt(0) - 97; // 'a'=0
    const rank = parseInt(sq[1]) - 1;    // '1'=0
    return { file, rank };
  }

  function getSquareScreenPos(file, rank) {
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    const sqSize = rect.width / 8;
    const isFlipped = myColor === 'b';

    let x, y;
    if (!isFlipped) {
      x = rect.left + file * sqSize + sqSize / 2;
      y = rect.top + (7 - rank) * sqSize + sqSize / 2;
    } else {
      x = rect.left + (7 - file) * sqSize + sqSize / 2;
      y = rect.top + rank * sqSize + sqSize / 2;
    }

    // Random offset within square (±30% from center) for human-like clicks
    x += (Math.random() - 0.5) * sqSize * 0.3;
    y += (Math.random() - 0.5) * sqSize * 0.3;

    return { x, y };
  }

  function fireMouseEvent(type, x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const evt = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerdown' ? 1 : 0
    });
    el.dispatchEvent(evt);
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function executeMove(uciMove) {
    // uciMove like "e2e4" or "e7e8q" (promotion)
    const from = uciMove.substring(0, 2);
    const to = uciMove.substring(2, 4);
    const promotion = uciMove.length > 4 ? uciMove[4] : null;

    const fromCoords = squareToCoords(from);
    const toCoords = squareToCoords(to);
    const fromPos = getSquareScreenPos(fromCoords.file, fromCoords.rank);
    const toPos = getSquareScreenPos(toCoords.file, toCoords.rank);

    if (!fromPos || !toPos) return false;

    moveInProgress = true;

    // Click source square
    fireMouseEvent('pointerdown', fromPos.x, fromPos.y);
    await delay(40 + Math.random() * 80);
    fireMouseEvent('pointerup', fromPos.x, fromPos.y);
    fireMouseEvent('click', fromPos.x, fromPos.y);

    await delay(80 + Math.random() * 150);

    // Click destination square
    fireMouseEvent('pointerdown', toPos.x, toPos.y);
    await delay(40 + Math.random() * 80);
    fireMouseEvent('pointerup', toPos.x, toPos.y);
    fireMouseEvent('click', toPos.x, toPos.y);

    // Handle promotion
    if (promotion) {
      await delay(200 + Math.random() * 300);
      await handlePromotion(promotion);
    }

    await delay(100);
    moveInProgress = false;
    return true;
  }

  async function handlePromotion(piece) {
    // chess.com shows a promotion popup; find and click the right piece
    const promoMap = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    const pieceName = promoMap[piece] || 'queen';

    // Try to find promotion choice elements
    const promoEl = document.querySelector(
      `.promotion-piece[class*="${pieceName}"], ` +
      `.promotion-area [class*="${pieceName}"], ` +
      `[data-piece="${piece}"]`
    );
    if (promoEl) {
      const rect = promoEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      fireMouseEvent('pointerdown', cx, cy);
      await delay(50);
      fireMouseEvent('pointerup', cx, cy);
      fireMouseEvent('click', cx, cy);
    }
  }

  // ======================== ELO SIMULATOR (2700) ========================

  function selectMove2700(moves) {
    if (!moves || moves.length === 0) return null;
    if (moves.length === 1) return moves[0];

    const best = moves[0].score;

    // Build weighted candidates from top 4 moves
    const candidates = [];
    for (let i = 0; i < Math.min(moves.length, 4); i++) {
      const diff = Math.abs(best - moves[i].score);
      let weight;

      if (i === 0) {
        weight = 62;
      } else if (i === 1 && diff <= 40) {
        weight = 24;
      } else if (i === 2 && diff <= 75) {
        weight = 10;
      } else if (i === 3 && diff <= 120) {
        weight = 4;
      } else {
        weight = 0;
      }

      // In clearly winning/losing positions, be slightly less accurate (overconfidence)
      if (Math.abs(best) > 300 && i > 0 && diff <= 150) {
        weight = Math.floor(weight * 1.3);
      }

      // In critical positions (eval near 0), be more precise
      if (Math.abs(best) < 50 && i > 0) {
        weight = Math.floor(weight * 0.7);
      }

      if (weight > 0) {
        candidates.push({ ...moves[i], weight });
      }
    }

    if (candidates.length === 0) return moves[0];

    // Weighted random selection
    const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
    let rand = Math.random() * totalWeight;
    for (const c of candidates) {
      rand -= c.weight;
      if (rand <= 0) return c;
    }
    return candidates[0];
  }

  // ======================== HUMAN TIMING ========================

  function getThinkTimeMs() {
    // Detect time control from clock
    const clockEl = document.querySelector('.clock-time-monospace.clock-bottom, .clock-component.clock-bottom');
    let timeLeftSec = 300; // default 5 min

    if (clockEl) {
      const text = clockEl.textContent.trim();
      const parts = text.split(':').map(Number);
      if (parts.length === 2) {
        timeLeftSec = parts[0] * 60 + parts[1];
      } else if (parts.length === 1) {
        timeLeftSec = parseFloat(text) || 300;
      }
    }

    let baseMs;
    if (timeLeftSec < 15) {
      // Extreme time pressure
      baseMs = 500 + Math.random() * 1500;
    } else if (timeLeftSec < 30) {
      baseMs = 1000 + Math.random() * 2500;
    } else if (timeLeftSec < 60) {
      baseMs = 1500 + Math.random() * 4000;
    } else if (timeLeftSec < 180) {
      baseMs = 2000 + Math.random() * 5000;
    } else if (timeLeftSec < 600) {
      baseMs = 3000 + Math.random() * 7000;
    } else {
      baseMs = 4000 + Math.random() * 12000;
    }

    // 12% chance of a "long think"
    if (Math.random() < 0.12) {
      baseMs *= 1.4 + Math.random() * 0.8;
    }

    // 8% chance of a quick "intuitive" move
    if (Math.random() < 0.08) {
      baseMs *= 0.3 + Math.random() * 0.3;
    }

    return Math.floor(baseMs);
  }

  // ======================== OVERLAY UI ========================

  function createOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'cc-overlay';
    overlayEl.innerHTML = `
      <div class="cc-status">Off</div>
      <div class="cc-move" style="display:none"></div>
    `;
    document.body.appendChild(overlayEl);
  }

  function updateOverlay(status, move) {
    if (!overlayEl) createOverlay();
    const statusEl = overlayEl.querySelector('.cc-status');
    const moveEl = overlayEl.querySelector('.cc-move');

    statusEl.textContent = status;
    statusEl.className = 'cc-status' + (enabled ? ' cc-active' : '');

    if (move) {
      moveEl.style.display = 'block';
      moveEl.textContent = move;
    } else {
      moveEl.style.display = 'none';
    }
  }

  function showSuggestedMove(moveStr) {
    updateOverlay('Suggested', moveStr);

    // Highlight squares on the board
    clearHighlights();
    if (moveStr && moveStr.length >= 4) {
      const from = moveStr.substring(0, 2);
      const to = moveStr.substring(2, 4);
      highlightSquare(from, 'cc-highlight-from');
      highlightSquare(to, 'cc-highlight-to');
    }
  }

  function highlightSquare(sq, className) {
    if (!boardEl) return;
    const coords = squareToCoords(sq);
    const file = coords.file + 1;
    const rank = coords.rank + 1;

    const highlight = document.createElement('div');
    highlight.className = `cc-highlight ${className}`;
    highlight.dataset.ccHighlight = 'true';
    highlight.style.cssText = `
      position: absolute;
      width: 12.5%;
      height: 12.5%;
      pointer-events: none;
      z-index: 100;
    `;

    const isFlipped = myColor === 'b';
    if (!isFlipped) {
      highlight.style.left = ((file - 1) * 12.5) + '%';
      highlight.style.bottom = ((rank - 1) * 12.5) + '%';
    } else {
      highlight.style.left = ((8 - file) * 12.5) + '%';
      highlight.style.bottom = ((8 - rank) * 12.5) + '%';
    }

    boardEl.appendChild(highlight);
  }

  function clearHighlights() {
    if (!boardEl) return;
    boardEl.querySelectorAll('[data-cc-highlight]').forEach(el => el.remove());
  }

  // ======================== ANALYSIS PIPELINE ========================

  async function runAnalysis() {
    if (analyzing || moveInProgress || !enabled) return;
    if (!isMyTurn()) {
      updateOverlay('Waiting', null);
      return;
    }

    analyzing = true;
    updateOverlay('Thinking...', null);

    const fen = getCurrentFEN();
    if (!fen || fen === lastFEN) {
      analyzing = false;
      return;
    }
    lastFEN = fen;

    try {
      const response = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'ANALYZE',
        fen,
        depth: 15,
        multiPV: 4
      });

      if (!response || response.error || !response.moves || response.moves.length === 0) {
        updateOverlay('Error', null);
        analyzing = false;
        return;
      }

      // Select move based on 2700 ELO simulation
      const selected = selectMove2700(response.moves);
      if (!selected) {
        analyzing = false;
        return;
      }

      const moveStr = selected.move;

      if (mode === 'auto') {
        // Wait human-like think time (minus analysis time)
        const thinkTime = getThinkTimeMs();
        updateOverlay('Playing...', moveStr);
        await delay(thinkTime);

        // Double-check it's still our turn
        if (enabled && isMyTurn()) {
          await executeMove(moveStr);
          updateOverlay('Played', moveStr);
          clearHighlights();
        }
      } else {
        // Suggest mode — show the move
        showSuggestedMove(moveStr);
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

      // Debounce — wait for DOM to settle after a move
      clearTimeout(analyzeTimer);
      analyzeTimer = setTimeout(() => {
        if (enabled && isMyTurn()) {
          runAnalysis();
        } else if (enabled) {
          updateOverlay('Waiting', null);
          clearHighlights();
          lastFEN = '';
        }
      }, 600);
    });

    observer.observe(boardEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }

  // ======================== INIT ========================

  function tryInit() {
    if (!findBoard()) {
      // Board not found yet; retry
      setTimeout(tryInit, 1000);
      return;
    }

    detectMyColor();
    createOverlay();
    startObserving();

    // Load saved state
    chrome.storage.local.get(['enabled', 'mode'], (data) => {
      enabled = data.enabled || false;
      mode = data.mode || 'suggest';
      updateOverlay(enabled ? 'Ready' : 'Off', null);

      if (enabled && isMyTurn()) {
        runAnalysis();
      }
    });
  }

  // Listen for state changes from popup
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled) {
        if (!boardEl) tryInit();
        else {
          detectMyColor();
          updateOverlay('Ready', null);
          if (isMyTurn()) runAnalysis();
        }
      } else {
        updateOverlay('Off', null);
        clearHighlights();
      }
    }
    if (changes.mode) {
      mode = changes.mode.newValue;
    }
  });

  // Re-detect board on page navigation (chess.com is a SPA)
  const pageObserver = new MutationObserver(() => {
    if (!boardEl || !document.body.contains(boardEl)) {
      boardEl = null;
      observer?.disconnect();
      clearTimeout(analyzeTimer);
      setTimeout(tryInit, 500);
    }
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  // Start
  tryInit();
})();
