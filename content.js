// Content script — chess.com board integration
// Reads board state, communicates with Stockfish, executes/suggests moves.
//
// State is read with a layered strategy: the MAIN-world bridge (bridge.js)
// reports chess.com's authoritative FEN/turn/color when available; if it
// can't, everything falls back to reading the board DOM directly. That way
// the bot keeps working even when chess.com changes its internals.

(() => {
  'use strict';

  // ======================== STATE ========================
  let enabled = false;
  let mode = 'suggest';
  let analyzing = false;
  let myColor = null;        // 'w' | 'b'
  let colorSetting = 'auto'; // 'w' | 'b' | 'auto'
  let targetElo = 2700;
  let showEvalBar = true;
  let hintStyle = 'arrow';   // 'arrow' | 'subtle'
  let boardEl = null;
  let observer = null;
  let moveInProgress = false;
  let lastFEN = '';
  let analyzeTimer = null;
  let overlayEl = null;
  let arrowSvg = null;
  let evalBarEl = null;
  let bridgeState = null;    // latest snapshot from bridge.js (may be null)

  // ======================== BRIDGE (MAIN world) ========================

  const BRIDGE_REQ = 'cc-bridge-req';
  const BRIDGE_RES = 'cc-bridge-res';
  let bridgeReqId = 0;
  const bridgePending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.tag !== BRIDGE_RES) return;
    const resolve = bridgePending.get(data.id);
    if (resolve) { bridgePending.delete(data.id); resolve(data); }
  });

  // Ask the bridge for ground-truth state. Resolves to null if no reply
  // within the timeout (bridge missing or chess.com internals unreadable).
  function requestBridgeState(timeoutMs = 180) {
    return new Promise((resolve) => {
      const id = ++bridgeReqId;
      let done = false;
      const finish = (val) => { if (!done) { done = true; bridgePending.delete(id); resolve(val); } };
      bridgePending.set(id, (data) => finish(data && data.ok ? data : null));
      window.postMessage({ tag: BRIDGE_REQ, id }, '*');
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  async function refreshBridgeState() {
    bridgeState = await requestBridgeState();
    return bridgeState;
  }

  // ======================== BOARD READER ========================

  function findBoard() {
    boardEl = document.querySelector('wc-chess-board, chess-board');
    return !!boardEl;
  }

  // Is the board rendered from black's perspective? Independent of which
  // color we play — a white player can flip the board and vice versa.
  function isBoardFlipped() {
    if (bridgeState && typeof bridgeState.flipped === 'boolean') return bridgeState.flipped;
    if (!boardEl) return false;
    return boardEl.classList.contains('flipped') ||
           boardEl.getAttribute('flipped') !== null;
  }

  function detectMyColor() {
    if (colorSetting === 'w' || colorSetting === 'b') {
      myColor = colorSetting;
      return myColor;
    }
    // Auto-detect: prefer chess.com's own "playing as", then board flip.
    if (bridgeState && (bridgeState.playingAs === 'w' || bridgeState.playingAs === 'b')) {
      myColor = bridgeState.playingAs;
      return myColor;
    }
    myColor = isBoardFlipped() ? 'b' : 'w';
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

  // Placement-only signature (piece layout) — used to detect that a move
  // actually landed, ignoring clocks/counters.
  function placementSignature(pieces) {
    return pieces
      .map(p => `${p.type}${p.file}${p.rank}`)
      .sort()
      .join('|');
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
    // Ground truth from chess.com if the bridge could read it.
    if (bridgeState && (bridgeState.turn === 'w' || bridgeState.turn === 'b')) {
      return bridgeState.turn;
    }
    // Fallback: chess.com's move-list ply nodes carry .white-move/.black-move
    // classes directly. The wrapping container's class name varies, so query
    // the ply nodes directly.
    const moveEls = document.querySelectorAll('.white-move, .black-move');
    if (moveEls.length > 0) return moveEls.length % 2 === 0 ? 'w' : 'b';
    return 'w';
  }

  function getCurrentFEN() {
    // Prefer chess.com's exact FEN (has correct castling / en-passant / turn).
    if (bridgeState && typeof bridgeState.fen === 'string' && bridgeState.fen.length > 10) {
      return bridgeState.fen;
    }
    const pieces = readPieces();
    if (pieces.length === 0) return null;
    return buildFEN(pieces, getActiveColor());
  }

  function isMyTurn() { return getActiveColor() === myColor; }

  // Detect game-over so we stop trying to move on a finished board.
  function isGameOver() {
    return !!document.querySelector(
      '.game-over-modal-content, .modal-game-over, [class*="game-over"] .header-title-component'
    );
  }

  // ======================== MOVE MAKER ========================

  function squareToCoords(sq) {
    return { file: sq.charCodeAt(0) - 97, rank: parseInt(sq[1]) - 1 };
  }

  function getSquareScreenPos(file, rank, jitter = true) {
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    const sqSize = rect.width / 8;
    const flipped = isBoardFlipped();
    let x = rect.left + (flipped ? (7 - file) : file) * sqSize + sqSize / 2;
    let y = rect.top + (flipped ? rank : (7 - rank)) * sqSize + sqSize / 2;
    if (jitter) {
      x += (Math.random() - 0.5) * sqSize * 0.22;
      y += (Math.random() - 0.5) * sqSize * 0.22;
    }
    return { x, y };
  }

  // Square center as a percentage of board size (for the SVG arrow overlay).
  function getSquarePct(file, rank) {
    const flipped = isBoardFlipped();
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
    // Some handlers listen for the classic mouse events too.
    const mouseType = { pointerdown: 'mousedown', pointerup: 'mouseup' }[type];
    if (mouseType) {
      el.dispatchEvent(new MouseEvent(mouseType, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0,
        buttons: mouseType === 'mousedown' ? 1 : 0
      }));
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Click a single square (down + up + click) — chess.com's click-to-move.
  async function clickSquare(file, rank, jitter) {
    const pos = getSquareScreenPos(file, rank, jitter);
    if (!pos) return;
    fireMouseEvent('pointerdown', pos.x, pos.y);
    await delay(40 + Math.random() * 70);
    fireMouseEvent('pointerup', pos.x, pos.y);
    fireMouseEvent('click', pos.x, pos.y);
  }

  async function handlePromotion(promotion) {
    await delay(180 + Math.random() * 280);
    const promoMap = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    const name = promoMap[promotion] || 'queen';
    const el = document.querySelector(`.promotion-piece[class*="${name}"], .promotion-piece.${name}`);
    if (el) {
      const r = el.getBoundingClientRect();
      fireMouseEvent('click', r.left + r.width / 2, r.top + r.height / 2);
    }
  }

  // Execute a UCI move and verify it landed; retry once if the board didn't
  // change. Returns true on confirmed success.
  async function executeMove(uciMove) {
    const from = uciMove.substring(0, 2), to = uciMove.substring(2, 4);
    const promotion = uciMove.length > 4 ? uciMove[4] : null;
    const fromC = squareToCoords(from), toC = squareToCoords(to);
    if (!getSquareScreenPos(fromC.file, fromC.rank) || !getSquareScreenPos(toC.file, toC.rank)) return false;

    const before = placementSignature(readPieces());
    moveInProgress = true;

    const attempt = async (jitter) => {
      await clickSquare(fromC.file, fromC.rank, jitter);
      await delay(90 + Math.random() * 140);
      await clickSquare(toC.file, toC.rank, jitter);
      if (promotion) await handlePromotion(promotion);
      await delay(280);
      return placementSignature(readPieces()) !== before;
    };

    let ok = await attempt(true);
    if (!ok) {
      // Retry once with no jitter (dead-center clicks) — most robust.
      await delay(160);
      ok = await attempt(false);
    }

    await delay(80);
    moveInProgress = false;
    return ok;
  }

  // ======================== ELO SIMULATOR ========================

  function selectMoveByElo(moves, elo) {
    if (!moves || moves.length === 0) return null;
    if (moves.length === 1) return moves[0];

    const best = moves[0].score;

    // Higher ELO = more likely to play the best move, tighter cp tolerance.
    const t = Math.max(0, Math.min(1, (elo - 1200) / 1600)); // 0 at 1200, 1 at 2800

    const bestWeight = 20 + t * 55;
    const secondWeight = 30 - t * 10;
    const thirdWeight = 28 - t * 18;
    const fourthWeight = 22 - t * 18;

    const cpTolerance2 = 300 - t * 260;
    const cpTolerance3 = 500 - t * 425;
    const cpTolerance4 = 700 - t * 580;

    const baseWeights = [bestWeight, secondWeight, thirdWeight, fourthWeight];
    const tolerances = [Infinity, cpTolerance2, cpTolerance3, cpTolerance4];

    const candidates = [];
    for (let i = 0; i < Math.min(moves.length, 4); i++) {
      const diff = Math.abs(best - moves[i].score);
      if (diff <= tolerances[i]) {
        let w = baseWeights[i];
        if (Math.abs(best) > 300 && i > 0) w *= 1.2;   // overconfident when winning
        if (Math.abs(best) < 50 && i > 0) w *= 0.7;    // precise in critical spots
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

    if (Math.random() < 0.12) baseMs *= 1.4 + Math.random() * 0.8;   // occasional long think
    if (Math.random() < 0.08) baseMs *= 0.3 + Math.random() * 0.3;   // occasional snap move
    return Math.floor(baseMs);
  }

  // ======================== EVAL + ARROW + OVERLAY UI ========================

  function uciToAlgebraic(uci) {
    if (!uci || uci.length < 4) return uci;
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const promo = uci.length > 4 ? '=' + uci[4].toUpperCase() : '';
    return from + ' → ' + to + promo;
  }

  // Convert a side-to-move centipawn score into a white-relative eval string
  // and a 0..1 "white winning" fraction for the eval bar.
  function evalFromScore(scoreStcp, activeColor, mate) {
    const whiteCp = activeColor === 'w' ? scoreStcp : -scoreStcp;
    let text, frac;
    if (mate != null || Math.abs(scoreStcp) >= 29000) {
      // Mate — `mate`'s sign is from the side-to-move perspective.
      const stmMating = mate != null ? mate > 0 : scoreStcp > 0;
      const whiteMating = (activeColor === 'w') === stmMating;
      const dist = mate != null ? Math.abs(mate) : '';
      text = (whiteMating ? '+' : '-') + 'M' + dist;
      frac = whiteMating ? 1 : 0;
    } else {
      const pawns = whiteCp / 100;
      text = (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
      frac = 1 / (1 + Math.pow(10, -whiteCp / 400)); // logistic win-prob-ish
    }
    return { text, frac };
  }

  function createEvalBar() {
    if (evalBarEl) return;
    evalBarEl = document.createElement('div');
    evalBarEl.id = 'cc-evalbar';
    evalBarEl.innerHTML =
      '<div class="cc-eval-fill"></div><div class="cc-eval-num">0.0</div>';
    document.body.appendChild(evalBarEl);
  }

  function positionEvalBar() {
    if (!evalBarEl || !boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    evalBarEl.style.top = rect.top + 'px';
    evalBarEl.style.height = rect.height + 'px';
    evalBarEl.style.left = (rect.left - 18) + 'px';
  }

  function updateEvalBar(evalInfo) {
    if (!showEvalBar) { if (evalBarEl) evalBarEl.style.display = 'none'; return; }
    if (!evalBarEl) createEvalBar();
    evalBarEl.style.display = 'block';
    positionEvalBar();
    const fill = evalBarEl.querySelector('.cc-eval-fill');
    const num = evalBarEl.querySelector('.cc-eval-num');
    if (evalInfo) {
      // Bar fills from the bottom for white's advantage.
      fill.style.height = Math.round(evalInfo.frac * 100) + '%';
      num.textContent = evalInfo.text;
      num.style.color = evalInfo.frac >= 0.5 ? '#111' : '#eee';
      // Numbers sit at whichever end is "winning".
      num.style.top = evalInfo.frac >= 0.5 ? 'auto' : '4px';
      num.style.bottom = evalInfo.frac >= 0.5 ? '4px' : 'auto';
    }
  }

  function createOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'cc-overlay';
    overlayEl.innerHTML =
      '<div class="cc-status">Off</div>' +
      '<div class="cc-move" style="display:none"></div>' +
      '<div class="cc-meta" style="display:none"></div>';
    document.body.appendChild(overlayEl);
    makeDraggable(overlayEl);
  }

  // Let the user drag the overlay out of the way.
  function makeDraggable(el) {
    let sx, sy, ox, oy, dragging = false;
    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', (e) => {
      dragging = true; el.style.cursor = 'grabbing';
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top = (oy + e.clientY - sy) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    const end = () => { dragging = false; el.style.cursor = 'grab'; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function updateOverlay(status, moveUCI, meta) {
    if (!overlayEl) createOverlay();
    const statusEl = overlayEl.querySelector('.cc-status');
    const moveEl = overlayEl.querySelector('.cc-move');
    const metaEl = overlayEl.querySelector('.cc-meta');
    statusEl.textContent = status;
    statusEl.className = 'cc-status' + (enabled ? ' cc-active' : '');
    if (moveUCI) {
      moveEl.style.display = 'block';
      moveEl.textContent = uciToAlgebraic(moveUCI);
    } else {
      moveEl.style.display = 'none';
    }
    if (meta) {
      metaEl.style.display = 'block';
      metaEl.textContent = meta;
    } else {
      metaEl.style.display = 'none';
    }
  }

  // Hints (arrow / subtle squares) render into a body-level fixed overlay
  // aligned to the board rect — NOT inside the board element. chess.com's
  // <wc-chess-board> reconciles its own children and removes any foreign node
  // appended into it, which would wipe an in-board overlay on every render.

  function ensureHintOverlay() {
    if (arrowSvg) return arrowSvg;
    const wrap = document.createElement('div');
    wrap.id = 'cc-hint-overlay';
    wrap.style.cssText = 'position:fixed;pointer-events:none;z-index:9997;';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'width:100%;height:100%;display:block;';
    wrap.appendChild(svg);
    document.body.appendChild(wrap);
    arrowSvg = wrap;
    arrowSvg._svg = svg;
    return arrowSvg;
  }

  function positionHintOverlay() {
    if (!arrowSvg || !boardEl) return;
    const r = boardEl.getBoundingClientRect();
    arrowSvg.style.left = r.left + 'px';
    arrowSvg.style.top = r.top + 'px';
    arrowSvg.style.width = r.width + 'px';
    arrowSvg.style.height = r.height + 'px';
  }

  function drawArrow(fromSq, toSq) {
    if (!boardEl) return;
    const fromCoords = squareToCoords(fromSq);
    const toCoords = squareToCoords(toSq);
    const from = getSquarePct(fromCoords.file, fromCoords.rank);
    const to = getSquarePct(toCoords.file, toCoords.rank);

    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const shorten = 2.5;
    const tipX = to.x - (dx / len) * shorten;
    const tipY = to.y - (dy / len) * shorten;

    ensureHintOverlay();
    positionHintOverlay();
    arrowSvg._svg.innerHTML = `
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
  }

  // Subtle mode: lightly tint the from and destination squares — visible but
  // unobtrusive, echoing chess.com's own last-move highlight.
  function drawSubtleSquares(fromSq, toSq) {
    if (!boardEl) return;
    const flipped = isBoardFlipped();
    const cell = (sq) => {
      const c = squareToCoords(sq);
      return {
        x: (flipped ? (7 - c.file) : c.file) * 12.5,
        y: (flipped ? c.rank : (7 - c.rank)) * 12.5
      };
    };
    const a = cell(fromSq), b = cell(toSq);

    ensureHintOverlay();
    positionHintOverlay();
    arrowSvg._svg.innerHTML = `
      <rect x="${a.x}" y="${a.y}" width="12.5" height="12.5"
        fill="rgba(255,214,84,0.32)" stroke="rgba(255,214,84,0.60)" stroke-width="0.6" />
      <rect x="${b.x}" y="${b.y}" width="12.5" height="12.5"
        fill="rgba(120,200,120,0.36)" stroke="rgba(120,200,120,0.66)" stroke-width="0.6" />
    `;
  }

  // Draw the current hint using the user's chosen style.
  function showHint(fromSq, toSq) {
    if (hintStyle === 'subtle') drawSubtleSquares(fromSq, toSq);
    else drawArrow(fromSq, toSq);
  }

  function clearArrow() {
    if (arrowSvg && arrowSvg._svg) arrowSvg._svg.innerHTML = '';
    // Clean up any legacy in-board overlays from older versions.
    if (boardEl) boardEl.querySelectorAll('[data-cc-arrow]').forEach(el => el.remove());
  }

  // ======================== ANALYSIS PIPELINE ========================

  async function runAnalysis() {
    if (analyzing || moveInProgress || !enabled) return;

    // Refresh ground-truth state before deciding whose turn it is.
    await refreshBridgeState();
    detectMyColor();

    if (isGameOver()) { updateOverlay('Game over', null); clearArrow(); return; }
    if (!isMyTurn()) { updateOverlay('Waiting', null); return; }

    const fen = getCurrentFEN();
    if (!fen) return;

    // Skip only positions we've already fully analysed this turn.
    if (fen === lastFEN) return;

    analyzing = true;
    updateOverlay('Thinking...', null);
    clearArrow();

    try {
      const response = await chrome.runtime.sendMessage({
        target: 'background', type: 'ANALYZE', fen, depth: 15, multiPV: 4
      });

      if (!response || response.error || !response.moves || response.moves.length === 0) {
        // Do NOT cache lastFEN — allow a retry once the engine is ready.
        updateOverlay('Engine warming up…', null);
        analyzing = false;
        setTimeout(() => { if (enabled) runAnalysis(); }, 1200);
        return;
      }

      // Position fully analysed — safe to cache now.
      lastFEN = fen;

      const top = response.moves[0];
      const evalInfo = evalFromScore(top.score, getActiveColor(), top.mate);
      updateEvalBar(evalInfo);

      const selected = selectMoveByElo(response.moves, targetElo);
      if (!selected) { analyzing = false; return; }

      const moveStr = selected.move;
      const meta = `eval ${evalInfo.text}  ·  depth ${top.depth || '–'}`;

      if (mode === 'auto') {
        const thinkTime = getThinkTimeMs();
        updateOverlay('Playing…', moveStr, meta);
        showHint(moveStr.substring(0, 2), moveStr.substring(2, 4));
        await delay(thinkTime);
        // Re-check it's still our turn after the human-like pause.
        await refreshBridgeState();
        if (enabled && isMyTurn() && !isGameOver()) {
          clearArrow();
          const ok = await executeMove(moveStr);
          updateOverlay(ok ? 'Played' : 'Move failed — retrying', moveStr, meta);
          if (!ok) { lastFEN = ''; setTimeout(() => { if (enabled) runAnalysis(); }, 700); }
        }
      } else {
        updateOverlay('Suggested', moveStr, meta);
        showHint(moveStr.substring(0, 2), moveStr.substring(2, 4));
      }
    } catch (e) {
      updateOverlay('Error', null);
      lastFEN = '';
    }
    analyzing = false;
  }

  // ======================== BOARD OBSERVER ========================

  function scheduleAnalysis(reasonDebounce = 500) {
    clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(async () => {
      if (!enabled) return;
      await refreshBridgeState();
      detectMyColor();
      if (isMyTurn()) runAnalysis();
      else { updateOverlay('Waiting', null); clearArrow(); }
    }, reasonDebounce);
  }

  function startObserving() {
    if (observer) observer.disconnect();
    if (!boardEl) return;

    observer = new MutationObserver(() => {
      if (moveInProgress) return;
      scheduleAnalysis(500);
    });

    observer.observe(boardEl, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
    });

    // Keep overlays glued to the board on resize/scroll.
    const reposition = () => { positionEvalBar(); positionHintOverlay(); };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  }

  // ======================== INIT ========================

  function loadSettings(cb) {
    chrome.storage.local.get(
      ['enabled', 'mode', 'myColor', 'targetElo', 'showEvalBar', 'hintStyle'],
      (data) => {
        if (chrome.runtime.lastError) return;
        enabled = !!data.enabled;
        mode = data.mode || 'suggest';
        colorSetting = data.myColor || 'auto';
        targetElo = data.targetElo || 2700;
        showEvalBar = data.showEvalBar !== false;
        hintStyle = data.hintStyle || 'arrow';
        detectMyColor();
        if (cb) cb();
      }
    );
  }

  async function tryInit() {
    if (!findBoard()) { setTimeout(tryInit, 1000); return; }

    createOverlay();
    await refreshBridgeState();
    loadSettings(() => {
      if (showEvalBar) { createEvalBar(); positionEvalBar(); }
      startObserving();
      detectMyColor();
      updateOverlay(enabled ? 'Ready' : 'Off', null);
      if (enabled && isMyTurn()) runAnalysis();
    });
  }

  // Listen for settings changes from the popup.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled) {
        lastFEN = '';
        if (!boardEl) tryInit();
        else scheduleAnalysis(100);
      } else { updateOverlay('Off', null); clearArrow(); }
    }
    if (changes.mode) { mode = changes.mode.newValue; lastFEN = ''; if (enabled) scheduleAnalysis(100); }
    if (changes.myColor) { colorSetting = changes.myColor.newValue; detectMyColor(); lastFEN = ''; if (enabled) scheduleAnalysis(100); }
    if (changes.targetElo) targetElo = changes.targetElo.newValue;
    if (changes.showEvalBar) {
      showEvalBar = changes.showEvalBar.newValue;
      if (!showEvalBar && evalBarEl) evalBarEl.style.display = 'none';
      else { createEvalBar(); positionEvalBar(); }
    }
    if (changes.hintStyle) { hintStyle = changes.hintStyle.newValue; lastFEN = ''; if (enabled) scheduleAnalysis(100); }
  });

  // Toggle via keyboard command from the background service worker.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.target === 'content' && msg.type === 'TOGGLE_ENABLED') {
      chrome.storage.local.set({ enabled: !enabled });
    }
  });

  // Re-detect the board on SPA navigation (new game, rematch, etc.).
  const pageObserver = new MutationObserver(() => {
    if (!boardEl || !document.body.contains(boardEl)) {
      boardEl = null; observer?.disconnect(); clearTimeout(analyzeTimer);
      lastFEN = '';
      setTimeout(tryInit, 500);
    }
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  tryInit();
})();
