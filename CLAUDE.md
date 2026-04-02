# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Paperstock is a macOS Electron desktop app for managing and reading PDFs. It provides a bookshelf UI (Apple Books-style), tab-based PDF viewer with spread/scroll modes, comments, bookmarks, and tag-based organization. No UI frameworks — pure vanilla JS/CSS/HTML.

## Commands

- `npm start` — Launch the app
- `npm run dev` — Launch with dev flag
- `npm run build` — Build macOS DMG via electron-builder (output in `dist/`)
- `npm run build:zip` — Build ZIP distribution

There are no tests or linting configured.

## Architecture

**Process model (Electron):**
- `main.js` — Main process: window creation, IPC handlers (38 endpoints), native menus (Japanese localized), file/DB access
- `preload.js` — Context bridge exposing `window.api` with all IPC methods to the renderer
- `src/js/bookshelf.js` — Renderer process: all application logic, event handling, UI state
- `src/index.html` — Main UI template with two views: bookshelf and PDF viewer

**Data layer:**
- `lib/database.js` — `BookDatabase` class wrapping better-sqlite3 (WAL mode, foreign keys)
- Schema: `books`, `tags`, `book_tags` (junction), `comments` (positioned on pages), `bookmarks`
- DB stored at `~/Library/Application Support/Paperstock/paperstock.db`
- `lib/pdf-utils.js` — Cover extraction via macOS `qlmanage`, page count via PDF.js

**Data flow:** User Action → Event Handler → `window.api.*()` → IPC → Main Process → DB/FS → Response → UI Update

**State in renderer (`bookshelf.js`):**
- `allBooks`, `allTags` — fetched from DB
- `tabs[]` — open PDF tabs; `tabGroups[]` — named tab groupings
- `pdfStates{}` — per-tab viewer state (zoom, page, spread mode, comments, bookmarks)
- LocalStorage for persistent preferences (zoom levels per book, scroll direction, card size)

**UI structure:**
- Left sidebar: vertical tab bar (200px) with bookshelf tab + PDF tabs in collapsible groups
- Bookshelf view: sidebar with tag filters + main grid/stacks display
- PDF viewer: toolbar + thumbnail sidebar + canvas rendering (supports spread mode, RTL reading)

## Key Patterns

- All file I/O and DB access happens in the main process only; renderer is fully sandboxed with context isolation
- PDF rendering uses pdfjs-dist with a web worker
- Cover thumbnails are pre-extracted on import and stored as PNGs in `~/Library/Application Support/Paperstock/covers/`
- Menus and UI labels are in Japanese
- Commit messages use emoji prefixes (e.g., ✨ for features, 🐛 for fixes, 🔖 for releases)
