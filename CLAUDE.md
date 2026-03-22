# Chess Companion — Chrome Extension

## Overview
Chrome extension that integrates Stockfish WASM with chess.com for 2700 ELO-level play.

## Architecture
- **Manifest V3** Chrome extension
- **Stockfish WASM** (classical eval, no NNUE) runs in offscreen document via Web Worker
- **Content script** reads chess.com board DOM, executes/suggests moves
- **Background service worker** coordinates message passing

## Message Flow
Content Script → Background → Offscreen (Stockfish Worker) → Background → Content Script

## Key Files
- `content.js` — Board reading, move execution, ELO simulation, timing
- `offscreen.js` — Stockfish Web Worker management, UCI protocol
- `background.js` — Service worker, message routing
- `engine/` — Stockfish WASM files (from npm `stockfish@16`)

## Commands
- Load unpacked: chrome://extensions → Load unpacked → select this directory
- No build step needed

## Anti-Detection Design
- Variable think time (human-like distribution)
- 2700 ELO move selection (not always best move)
- Random click offsets within squares
- No DOM fingerprinting (minimal overlay, no prototype modification)
- Generic extension name
