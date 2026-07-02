// MAIN-world bridge — reads chess.com's own board component state.
//
// Content scripts run in an isolated world and cannot see the page's JS
// objects. chess.com's <wc-chess-board> element exposes a `game` controller
// with authoritative FEN / turn / player-color info. Running here (world:
// MAIN) lets us read that object and hand the facts to the isolated content
// script over window.postMessage. Everything is best-effort and defensive:
// if chess.com changes its internals we simply return nulls and the content
// script falls back to reading the DOM.

(() => {
  'use strict';

  const TAG_REQ = 'cc-bridge-req';
  const TAG_RES = 'cc-bridge-res';

  function findBoard() {
    return document.querySelector('wc-chess-board, chess-board');
  }

  // Try a list of getter names on an object, returning the first that yields
  // a non-null value without throwing.
  function tryGetters(obj, names) {
    if (!obj) return null;
    for (const name of names) {
      try {
        const fn = obj[name];
        if (typeof fn === 'function') {
          const v = fn.call(obj);
          if (v !== undefined && v !== null && v !== '') return v;
        }
      } catch (_) { /* keep probing */ }
    }
    return null;
  }

  function readState() {
    const board = findBoard();
    if (!board) return { ok: false };

    // The controller may live under a few property names across versions.
    const game = board.game || board._game || board.controller || null;

    let fen = null;
    let playingAs = null;   // 1 = white, 2 = black (chess.com enum)
    let turn = null;        // 'w' | 'b'
    let flipped = null;

    if (game) {
      fen = tryGetters(game, ['getFEN', 'getFen']);
      const pa = tryGetters(game, ['getPlayingAs']);
      if (pa === 1 || pa === 'white' || pa === 'w') playingAs = 'w';
      else if (pa === 2 || pa === 'black' || pa === 'b') playingAs = 'b';

      const t = tryGetters(game, ['getTurn']);
      if (t === 1 || t === 'white' || t === 'w') turn = 'w';
      else if (t === 2 || t === 'black' || t === 'b') turn = 'b';

      // Board orientation, if the controller exposes it.
      try {
        const opts = typeof game.getOptions === 'function' ? game.getOptions() : null;
        if (opts && typeof opts.flipped === 'boolean') flipped = opts.flipped;
      } catch (_) { /* ignore */ }
    }

    // Derive turn from FEN if the getter didn't give it.
    if (!turn && typeof fen === 'string') {
      const parts = fen.split(' ');
      if (parts[1] === 'w' || parts[1] === 'b') turn = parts[1];
    }

    return { ok: true, fen: typeof fen === 'string' ? fen : null, playingAs, turn, flipped };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.tag !== TAG_REQ) return;

    let state;
    try {
      state = readState();
    } catch (_) {
      state = { ok: false };
    }
    window.postMessage({ tag: TAG_RES, id: data.id, ...state }, '*');
  });
})();
