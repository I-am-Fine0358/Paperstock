/* ══════════════════════════════════════════════════════
   Paperstock — Main App Logic v3
   Tab-based bookshelf + enhanced PDF viewer
   ══════════════════════════════════════════════════════ */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;

const TAG_COLORS = [
    '#007aff', '#5856d6', '#af52de', '#ff2d55', '#ff3b30',
    '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7',
    '#5ac8fa', '#64d2ff', '#a2845e', '#8e8e93',
];

// ── State ────────────────────────────────────────────
let allBooks = [];
let allTags = [];
let currentFilter = 'all';
let currentTagId = null;
let contextBookId = null;
let viewMode = 'grid'; // 'grid' | 'list'
let currentSort = localStorage.getItem('ps-sort') || 'updated_at';
let sortAscending = localStorage.getItem('ps-sort-asc') === 'true';
let bookshelfCardSize = parseInt(localStorage.getItem('ps-card-size')) || 150;
let manualBookStacks = [];
let nextManualStackId = 1;
let draggedBookId = null;
let activeBookFolderRef = null;
let suppressBookClickUntil = 0;
let pointerBookDrag = null;
const BOOK_FOLDER_PREVIEW_LIMIT = 9;
const BOOK_STACKS_STORAGE_KEY = 'ps-book-stacks';
const BOOK_STACK_DRAG_THRESHOLD = 8;
const PDF_CONTENT_SEARCH_MIN_CHARS = 2;
const MAX_TEXT_LAYER_ITEMS = 8000;
const MAX_TEXT_LAYER_CHARS = 120000;
let pdfContentSearchCache = new Map();
let renderBooksRequestId = 0;

// Tab system
let tabs = [];
let tabGroups = [];
let activeTabId = 'bookshelf';
let nextTabId = 1;
let nextGroupId = 1;

// PDF viewer state per tab
let pdfStates = {};
let pdfjsLib = null;
let pdfjsReady = false;
let pdfjsInitPromise = null;

// Keep at most the current document and one recent tab warm. Canvas limits apply
// to the whole spread, including the old frame retained during an atomic swap.
const PDF_MAX_LOADED_DOCUMENTS = 2;
const PDF_INACTIVE_EVICT_MS = 60000;
const PDF_HIDDEN_RELEASE_MS = 15000;
const PDF_VIEWER_FRAME_PIXELS = 8 * 1024 * 1024;
const PDF_CANVAS_MAX_DIMENSION = 4096;
const PDF_LOAD_IDLE_TIMEOUT_MS = 60000;
const PDF_WORKER_RELEASE_TIMEOUT_MS = 3000;
let pdfWorkTail = Promise.resolve();
let pdfBackgroundTimer = null;
let pdfBackgroundDeadline = 0;
let pdfLastUsedOrder = 0;
const pdfPendingDestructions = new Set();

function pdfCancelledError() {
    const error = new Error('PDF operation cancelled');
    error.name = 'AbortError';
    return error;
}

// Race every cross-worker wait with the document's lifetime. Terminating a
// Worker does not settle its outstanding JavaScript promises on its own.
function waitForPdfPromise(promise, { signal, timeoutMs = 0, watch = null } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false, timer = null;
        let deadline = Date.now() + timeoutMs;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (watch?.checkDeadline === checkDeadline) {
                watch.checkDeadline = null;
                watch.touchProgress = null;
            }
            callback(value);
        };
        const onAbort = () => finish(reject, signal.reason || pdfCancelledError());
        const checkDeadline = () => {
            if (settled || !timeoutMs) return;
            if (Date.now() >= deadline) {
                const error = new Error('PDF operation timed out');
                error.name = 'TimeoutError';
                finish(reject, error);
            } else {
                clearTimeout(timer);
                timer = setTimeout(checkDeadline, deadline - Date.now());
            }
        };
        // Install handlers even for an already-aborted request, so late worker
        // rejections cannot become unhandled or modify a newer attempt.
        Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs) timer = setTimeout(checkDeadline, timeoutMs);
        if (watch) {
            watch.checkDeadline = checkDeadline;
            watch.touchProgress = () => {
                if (settled) return;
                deadline = Date.now() + timeoutMs;
                checkDeadline();
            };
        }
    });
}

function waitForPdfSession(promise, runtime) {
    return waitForPdfPromise(promise, { signal: runtime?.controller.signal });
}

function createPdfRuntime(attempt, onWorkerFailure) {
    // Own the actual Worker as well as PDF.js's public wrapper. The wrapper's
    // destroy() alone cannot terminate a worker that is still initializing.
    const port = new Worker(pdfjsLib.GlobalWorkerOptions.workerSrc, { type: 'module' });
    const runtime = { port, worker: null, controller: attempt.controller, stopped: false };
    const onFailure = () => {
        const error = new Error('PDF worker failed');
        attempt.controller.abort(error);
        onWorkerFailure?.(error);
    };
    runtime.onFailure = onFailure;
    port.addEventListener('error', onFailure);
    port.addEventListener('messageerror', onFailure);
    try {
        runtime.worker = pdfjsLib.PDFWorker.create({ port });
        return runtime;
    } catch (error) {
        stopPdfRuntime(runtime);
        throw error;
    }
}

function stopPdfRuntime(runtime) {
    if (!runtime || runtime.stopped) return;
    runtime.stopped = true;
    runtime.port.removeEventListener('error', runtime.onFailure);
    runtime.port.removeEventListener('messageerror', runtime.onFailure);
    // Native terminate is synchronous and requires no reply from the worker.
    runtime.port.terminate();
    try { runtime.worker?.destroy(); } catch (error) { console.warn('PDF worker wrapper cleanup failed:', error); }
}

function enqueuePdfWork(work) {
    const pending = pdfWorkTail.then(work);
    pdfWorkTail = pending.catch(error => console.warn('PDF task failed:', error));
    return pdfWorkTail;
}

function releaseCanvasTree(root) {
    if (!root) return;
    root.querySelectorAll('canvas').forEach(canvas => {
        canvas.width = 0;
        canvas.height = 0;
    });
    root.replaceChildren();
}

function cancelPdfRendering(state) {
    state.renderGeneration = (state.renderGeneration || 0) + 1;
    if (state.renderTasks?.size) state.renderCancelledAt = Date.now();
    for (const task of state.renderTasks || []) task.cancel();
    for (const layer of state.textLayers || []) layer.cancel();
    for (const reader of state.textReaders || []) {
        reader.cancel(new Error('PDF text rendering cancelled')).catch(() => {});
    }
}

function cancelThumbnailRendering(state, clear = false) {
    state.thumbnailGeneration = (state.thumbnailGeneration || 0) + 1;
    if (state.thumbnailTask) state.renderCancelledAt = Date.now();
    state.thumbnailTask?.cancel();
    if (clear) {
        const list = document.getElementById('thumbnail-list');
        if (list?.dataset.tabId === state.tabId) {
            releaseCanvasTree(list);
            delete list.dataset.tabId;
        }
    }
}

function rememberPdfScroll(state) {
    const pages = document.getElementById('viewer-pages');
    const viewer = document.getElementById('viewer-container');
    if (state.tabId === activeTabId && pages?.dataset.tabId === state.tabId && pages.scrollHeight > 0) {
        state.pendingScrollY = viewer.scrollTop / pages.scrollHeight;
        state.savedScrollY = state.pendingScrollY;
    }
}

function releasePdfDocument(state) {
    state.loadAttempt?.controller.abort(pdfCancelledError());
    if (state.releasePromise) {
        // A tab can be reopened while destruction is pending, then hidden again.
        // Invalidate that waiting load as well instead of letting it revive in the background.
        state.loadGeneration = (state.loadGeneration || 0) + 1;
        state.loading = false;
        cancelPdfRendering(state);
        cancelThumbnailRendering(state, true);
        return state.releasePromise;
    }
    rememberPdfScroll(state);
    if (state.loaded) saveBookState(state.tabId).catch(error => console.warn('Failed to save PDF position:', error));
    clearTimeout(state.evictionTimer);
    state.loadGeneration = (state.loadGeneration || 0) + 1;
    cancelPdfRendering(state);
    cancelThumbnailRendering(state, true);
    const loadingTask = state.loadingTask;
    const doc = state.pdfDoc;
    const runtime = state.pdfRuntime;
    state.pdfDoc = null;
    state.loadingTask = null;
    state.pdfRuntime = null;
    state.loaded = false;
    state.loading = false;
    const pages = document.getElementById('viewer-pages');
    if (pages?.dataset.tabId === state.tabId) {
        releaseCanvasTree(pages);
        delete pages.dataset.tabId;
    }
    // destroy() also aborts network requests and terminates this document's worker.
    const releasePromise = Promise.resolve().then(() => waitForPdfPromise(
        loadingTask ? loadingTask.destroy() : doc?.destroy(),
        { timeoutMs: PDF_WORKER_RELEASE_TIMEOUT_MS },
    ))
        .catch(error => console.warn('PDF release failed:', error))
        .finally(() => {
            // A broken Terminate handshake must not block every other tab. Only
            // release the budget after the owned native worker is terminated.
            stopPdfRuntime(runtime);
            pdfPendingDestructions.delete(releasePromise);
            if (state.releasePromise === releasePromise) state.releasePromise = null;
        });
    state.releasePromise = releasePromise;
    // Keep tracking destruction even when closeTab immediately removes its state.
    pdfPendingDestructions.add(releasePromise);
    return releasePromise;
}

function enforcePdfDocumentLimit(activeId) {
    const inactive = Object.values(pdfStates)
        .filter(state => state.tabId !== activeId && (state.pdfDoc || state.loading))
        .sort((a, b) => (b.lastUsedOrder || 0) - (a.lastUsedOrder || 0));
    // Reserve a slot for the document about to load as well.
    for (const state of inactive.slice(PDF_MAX_LOADED_DOCUMENTS - 1)) releasePdfDocument(state);
    // A replacement must also wait for workers already being destroyed, otherwise
    // quick tab switching can temporarily create an unbounded number of workers.
    return Promise.all(pdfPendingDestructions);
}

function schedulePdfBackgroundRelease(delay = PDF_HIDDEN_RELEASE_MS) {
    // macOS can send visibility, blur, pageshow and focus in different orders.
    // Hidden documents must keep the earliest release deadline, never extend it.
    if (document.visibilityState === 'hidden') delay = Math.min(delay, PDF_HIDDEN_RELEASE_MS);
    const deadline = Date.now() + delay;
    if (pdfBackgroundTimer !== null && pdfBackgroundDeadline <= deadline) return;
    clearTimeout(pdfBackgroundTimer);
    pdfBackgroundDeadline = deadline;
    pdfBackgroundTimer = setTimeout(() => {
        pdfBackgroundTimer = null;
        pdfBackgroundDeadline = 0;
        persistTabState();
        for (const state of Object.values(pdfStates)) releasePdfDocument(state);
    }, delay);
}

// Comment state
let commentMode = false;
let editingCommentId = null;
let editingCommentTabId = null;

// Theme (night mode)
let nightMode = localStorage.getItem('ps-night-mode') === '1';

// ── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    applyTheme();
    await loadData();
    restoreTabState();
    // Apply saved bookshelf card size
    const grid = document.getElementById('book-grid');
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${bookshelfCardSize}px, 1fr))`;
    document.getElementById('bookshelf-zoom').value = bookshelfCardSize;
    await renderBooks();
    renderTags();
    renderTabBar();
    setupEventListeners();
    setupProgressBar();
    initPdfJs();
    if (activeTabId !== 'bookshelf') activateTab(activeTabId);
});

function applyTheme() {
    document.body.classList.toggle('night-mode', nightMode);
}

function toggleTheme() {
    nightMode = !nightMode;
    localStorage.setItem('ps-night-mode', nightMode ? '1' : '0');
    applyTheme();
    // Re-render the active PDF so the canvas filter reflects the new mode
    if (activeTabId !== 'bookshelf' && pdfStates[activeTabId]?.loaded) {
        renderPdfPages(activeTabId, true);
    }
}

// Invert near-grayscale pixels (text, paper) while leaving colored pixels alone.
// Makes paper black, dark text light, and preserves color photos/diagrams.
function applyNightFilterToCanvas(canvas, ctx) {
    const w = canvas.width, h = canvas.height;
    if (w === 0 || h === 0) return;
    let imgData;
    try { imgData = ctx.getImageData(0, 0, w, h); } catch (_e) { return; }
    const d = imgData.data;
    const COLOR_THRESHOLD = 50; // max-min RGB delta below this counts as "near-grayscale"
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (max - min < COLOR_THRESHOLD) {
            d[i] = 255 - r;
            d[i + 1] = 255 - g;
            d[i + 2] = 255 - b;
        }
    }
    ctx.putImageData(imgData, 0, 0);
}

async function loadData() {
    allBooks = await invoke('get_books');
    allTags = await invoke('get_tags');
    loadManualBookStacks();
    sanitizeManualBookStacks();
}

function loadManualBookStacks() {
    let raw;
    try { raw = localStorage.getItem(BOOK_STACKS_STORAGE_KEY); } catch (_e) { return; }
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_e) { return; }
    const stacks = Array.isArray(parsed?.stacks) ? parsed.stacks : Array.isArray(parsed) ? parsed : [];
    manualBookStacks = stacks
        .filter(stack => stack && Array.isArray(stack.bookIds))
        .map(stack => ({
            id: String(stack.id || `stack-${nextManualStackId++}`),
            name: String(stack.name || 'スタック'),
            color: stack.color || '#8e8e93',
            bookIds: [...new Set(stack.bookIds.map(id => parseInt(id)).filter(Number.isFinite))],
            createdAt: stack.createdAt || new Date().toISOString(),
        }));
    const maxIdNum = manualBookStacks.reduce((max, stack) => {
        const n = parseInt(String(stack.id).replace(/^manual-/, '').replace(/^stack-/, ''));
        return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    nextManualStackId = Math.max(nextManualStackId, maxIdNum + 1);
}

function persistManualBookStacks() {
    try {
        localStorage.setItem(BOOK_STACKS_STORAGE_KEY, JSON.stringify({
            stacks: manualBookStacks.map(stack => ({
                id: stack.id,
                name: stack.name,
                color: stack.color,
                bookIds: stack.bookIds,
                createdAt: stack.createdAt,
            })),
        }));
    } catch (_e) { /* localStorage may be full; ignore */ }
}

function sanitizeManualBookStacks() {
    const validBookIds = new Set(allBooks.map(book => book.id));
    const seenBookIds = new Set();
    let changed = false;
    manualBookStacks = manualBookStacks
        .map(stack => {
            const bookIds = [];
            for (const bookId of stack.bookIds) {
                if (!validBookIds.has(bookId) || seenBookIds.has(bookId)) {
                    changed = true;
                    continue;
                }
                seenBookIds.add(bookId);
                bookIds.push(bookId);
            }
            if (bookIds.length !== stack.bookIds.length) changed = true;
            return { ...stack, bookIds };
        })
        .filter(stack => {
            if (stack.bookIds.length < 2) {
                changed = true;
                return false;
            }
            return true;
        });
    if (changed) persistManualBookStacks();
}

// ── Tab state persistence ──────────────────────────────
// Tabs and groups are saved to localStorage on every change so the sidebar
// survives app restart. PDFs are NOT auto-loaded on startup — the saved tab
// is just a stub; loadPdfForTab runs lazily the first time the user clicks it.
function persistTabState() {
    try {
        const data = {
            tabs: tabs.map(t => ({ id: t.id, type: t.type, bookId: t.bookId, title: t.title, groupId: t.groupId })),
            tabGroups: tabGroups.map(g => ({ id: g.id, name: g.name, color: g.color, collapsed: !!g.collapsed })),
            activeTabId,
            nextTabId,
            nextGroupId,
        };
        localStorage.setItem('ps-tab-state', JSON.stringify(data));
    } catch (_e) { /* localStorage may be full; ignore */ }
}

function restoreTabState() {
    let raw;
    try { raw = localStorage.getItem('ps-tab-state'); } catch (_e) { return; }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (_e) { return; }

    tabGroups = Array.isArray(data.tabGroups) ? data.tabGroups : [];
    const validGroupIds = new Set(tabGroups.map(g => g.id));

    const validBookIds = new Set(allBooks.map(b => b.id));
    tabs = (Array.isArray(data.tabs) ? data.tabs : [])
        .filter(t => t && t.type === 'pdf' && validBookIds.has(t.bookId))
        .map(t => {
            const book = allBooks.find(b => b.id === t.bookId);
            return {
                id: t.id,
                type: 'pdf',
                bookId: t.bookId,
                title: book ? book.title : t.title, // sync with possibly-renamed book
                groupId: validGroupIds.has(t.groupId) ? t.groupId : null,
            };
        });

    // Make sure nextTabId/nextGroupId are past any restored ids to avoid collisions
    const maxTabNum = tabs.reduce((m, t) => {
        const n = parseInt(String(t.id).replace(/^pdf-/, ''));
        return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    const maxGroupId = tabGroups.reduce((m, g) => g.id > m ? g.id : m, 0);
    nextTabId = Math.max(data.nextTabId || 1, maxTabNum + 1);
    nextGroupId = Math.max(data.nextGroupId || 1, maxGroupId + 1);

    if (data.activeTabId && (data.activeTabId === 'bookshelf' || tabs.some(t => t.id === data.activeTabId))) {
        activeTabId = data.activeTabId;
    }
}

async function initPdfJs() {
    if (pdfjsReady) return;
    if (pdfjsInitPromise) return pdfjsInitPromise;
    const controller = new AbortController();
    pdfjsInitPromise = waitForPdfPromise(initializePdfJs(controller.signal), {
        signal: controller.signal, timeoutMs: PDF_LOAD_IDLE_TIMEOUT_MS,
    }).catch(error => {
        console.error('Failed to initialize PDF.js:', error);
        pdfjsInitError = String(error.message || error);
    }).finally(() => {
        controller.abort();
        pdfjsInitPromise = null;
    });
    return pdfjsInitPromise;
}

async function initializePdfJs(signal) {
    let blobUrl;
    try {
        // Tauri serves .mjs with wrong MIME type, so use fetch + blob URL workaround
        const resp = await fetch('./libs/pdf.mjs', { signal });
        if (!resp.ok) throw new Error('PDF.js module could not be loaded');
        const code = await resp.text();
        const blob = new Blob([code], { type: 'application/javascript' });
        blobUrl = URL.createObjectURL(blob);
        const module = await import(blobUrl);
        if (signal.aborted) return;

        // Worker also needs blob URL workaround
        const wResp = await fetch('./libs/pdf.worker.mjs', { signal });
        if (!wResp.ok) throw new Error('PDF.js worker module could not be loaded');
        const wCode = await wResp.text();
        if (signal.aborted) return;
        const wBlob = new Blob([wCode], { type: 'application/javascript' });
        const wBlobUrl = URL.createObjectURL(wBlob);
        module.GlobalWorkerOptions.workerSrc = wBlobUrl;
        pdfjsLib = module;

        pdfjsReady = true;
    } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
}
let pdfjsInitError = '';

// ══════════════════════════════════════════════════════
//  TAB MANAGEMENT
// ══════════════════════════════════════════════════════

function openPdfTab(bookId) {
    const existing = tabs.find(t => t.type === 'pdf' && t.bookId === bookId);
    if (existing) { activateTab(existing.id); return; }

    const book = allBooks.find(b => b.id === bookId);
    if (!book) return;

    // Auto-set status to reading + track last opened
    const updates = { lastOpenedAt: new Date().toISOString() };
    if (book.status === 'unread') updates.status = 'reading';
    invoke('update_book', { id: bookId, updates });
    book.lastOpenedAt = updates.lastOpenedAt;
    if (updates.status) book.status = updates.status;
    renderBooks();

    const tabId = 'pdf-' + nextTabId++;
    tabs.push({ id: tabId, type: 'pdf', bookId, title: book.title, groupId: null });
    activateTab(tabId); // lazy-loads via loadPdfForTab when pdfStates entry is missing
    renderTabBar();
}

async function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    const state = pdfStates[tabId];
    if (saveStateTimers[tabId]) { clearTimeout(saveStateTimers[tabId]); delete saveStateTimers[tabId]; }
    const released = state ? releasePdfDocument(state) : Promise.resolve();
    if (state) state.closed = true;
    delete pdfStates[tabId];
    tabs.splice(idx, 1);
    if (activeTabId === tabId) activateTab('bookshelf');
    renderTabBar();
    await released;
}

// ── Reading Progress Bar ───────────────────────────────
let progressBarSide = localStorage.getItem('ps-progress-side') || 'right';

function getProgressForState(state) {
    // For spread mode, treat each spread as one "step" with a representative current.
    // We always anchor on currentPage so spread/single share the same logic.
    const total = state.totalPages;
    const cur = state.currentPage;
    const ratio = total > 1 ? (cur - 1) / (total - 1) : (total === 1 ? 1 : 0);
    return { ratio, cur, total };
}

function showProgressBar(visible) {
    const el = document.getElementById('reading-progress');
    if (!el) return;
    el.style.display = visible ? 'flex' : 'none';
    if (visible) el.dataset.side = progressBarSide;
}

function updateProgressBar(tabId) {
    const bar = document.getElementById('reading-progress');
    if (!bar) return;
    const state = pdfStates[tabId];
    if (!state || !state.loaded || tabId !== activeTabId) {
        showProgressBar(false);
        return;
    }
    showProgressBar(true);
    bar.dataset.side = progressBarSide;

    const { ratio, cur, total } = getProgressForState(state);
    const pct = Math.max(0, Math.min(1, ratio)) * 100;
    document.getElementById('rp-fill').style.height = pct + '%';
    document.getElementById('rp-thumb').style.top = pct + '%';

    // Tooltip default position aligned with current
    const tooltip = document.getElementById('rp-tooltip');
    tooltip.textContent = `P. ${cur} / ${total}`;
    tooltip.style.top = pct + '%';
    tooltip.style.transform = 'translateY(-50%)';

    // Render bookmark + comment markers
    const markersEl = document.getElementById('rp-markers');
    markersEl.innerHTML = '';
    if (total > 1) {
        const placed = new Set();
        for (const bm of (state.bookmarks || [])) {
            const r = (bm.pageNum - 1) / (total - 1);
            const m = document.createElement('div');
            m.className = 'rp-marker bookmark';
            m.style.top = Math.max(0, Math.min(1, r)) * 100 + '%';
            m.title = `栞: P.${bm.pageNum}`;
            markersEl.appendChild(m);
            placed.add(bm.pageNum);
        }
        // Comments: dedup pages so we don't stack many at same spot
        const commentPages = new Set();
        for (const c of (state.comments || [])) {
            if (placed.has(c.pageNum)) continue;
            commentPages.add(c.pageNum);
        }
        for (const p of commentPages) {
            const r = (p - 1) / (total - 1);
            const m = document.createElement('div');
            m.className = 'rp-marker comment';
            m.style.top = Math.max(0, Math.min(1, r)) * 100 + '%';
            m.title = `コメント: P.${p}`;
            markersEl.appendChild(m);
        }
    }
}

function pageFromPointer(clientY, trackEl, total) {
    const rect = trackEl.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    if (total <= 1) return 1;
    return Math.max(1, Math.min(total, Math.round(1 + r * (total - 1))));
}

function setupProgressBar() {
    const bar = document.getElementById('reading-progress');
    const track = document.getElementById('rp-track');
    const tooltip = document.getElementById('rp-tooltip');
    if (!bar || !track) return;

    let dragging = false;
    let lastHoverPage = null;

    const updateHoverTooltip = (clientY) => {
        const state = pdfStates[activeTabId];
        if (!state || !state.loaded) return;
        const page = pageFromPointer(clientY, track, state.totalPages);
        const trackRect = track.getBoundingClientRect();
        const localY = clientY - trackRect.top;
        const pct = (localY / trackRect.height) * 100;
        tooltip.textContent = `P. ${page} / ${state.totalPages}`;
        tooltip.style.top = Math.max(0, Math.min(100, pct)) + '%';
        tooltip.style.transform = 'translateY(-50%)';
        lastHoverPage = page;
    };

    bar.addEventListener('mousemove', (e) => updateHoverTooltip(e.clientY));

    bar.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const state = pdfStates[activeTabId];
        if (!state || !state.loaded) return;
        e.preventDefault();
        dragging = true;
        bar.classList.add('dragging');
        updateHoverTooltip(e.clientY);

        const onMove = (ev) => {
            if (!dragging) return;
            updateHoverTooltip(ev.clientY);
        };
        const onUp = (ev) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (!dragging) return;
            dragging = false;
            bar.classList.remove('dragging');
            const s = pdfStates[activeTabId];
            if (!s || !s.loaded) return;
            const page = pageFromPointer(ev.clientY, track, s.totalPages);
            if (page !== s.currentPage) {
                s.currentPage = page;
                renderPdfPages(activeTabId);
                saveBookState(activeTabId);
            } else {
                updateProgressBar(activeTabId);
            }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    // Right-click toggles left/right placement
    bar.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        progressBarSide = progressBarSide === 'right' ? 'left' : 'right';
        localStorage.setItem('ps-progress-side', progressBarSide);
        bar.dataset.side = progressBarSide;
    });
}

// ── Reading-state persistence ──────────────────────────
// Saves currentPage, scroll position (as ratio), zoom and spread mode for the
// book in the given tab. Called on every navigation, zoom, scroll, spread toggle,
// and tab close. Fire-and-forget by default; await in closeTab/beforeunload.
const saveStateTimers = {};

function saveBookState(tabId) {
    const state = pdfStates[tabId];
    if (!state || !state.loaded || !state.bookId) return Promise.resolve();

    const updates = {
        lastPage: state.currentPage,
        lastZoom: state.fitMode ? 0 : state.scale,
        lastSpreadMode: state.spreadMode ? 1 : 0,
        lastSpreadDirection: getSpreadDirection(state) === 'rtl' ? 1 : 0,
    };

    // Scroll position only meaningful for active tab (where DOM reflects state)
    if (activeTabId === tabId) {
        const viewerContainer = document.getElementById('viewer-container');
        const pagesContainer = document.getElementById('viewer-pages');
        if (pagesContainer?.dataset.tabId === tabId && pagesContainer.scrollHeight > 0) {
            updates.lastScrollY = viewerContainer.scrollTop / pagesContainer.scrollHeight;
            state.savedScrollY = updates.lastScrollY;
        }
    }

    if (updates.lastScrollY === undefined && Number.isFinite(state.savedScrollY)) {
        updates.lastScrollY = state.savedScrollY;
    }

    // Update local cache so a subsequent re-open uses fresh values without an IPC round-trip
    const book = allBooks.find(b => b.id === state.bookId);
    if (book) {
        book.lastPage = updates.lastPage;
        book.lastZoom = updates.lastZoom;
        book.lastSpreadMode = updates.lastSpreadMode;
        book.lastSpreadDirection = updates.lastSpreadDirection;
        if (updates.lastScrollY !== undefined) book.lastScrollY = updates.lastScrollY;
    }

    return invoke('update_book', { id: state.bookId, updates });
}

async function flushOpenPdfState() {
    persistTabState();
    const saves = [];
    for (const tabId of Object.keys(pdfStates)) {
        if (saveStateTimers[tabId]) {
            clearTimeout(saveStateTimers[tabId]);
            delete saveStateTimers[tabId];
        }
        // Start every save even if another tab's IPC fails or stops responding.
        saves.push(Promise.resolve().then(() => saveBookState(tabId)));
    }
    const results = await Promise.allSettled(saves);
    for (const result of results) {
        if (result.status === 'rejected') console.warn('Failed to save reading state:', result.reason);
    }
}

let appQuitInProgress = false;
async function prepareAppQuit() {
    if (appQuitInProgress) return;
    appQuitInProgress = true;
    try {
        await flushOpenPdfState();
    } finally {
        // The native quit coordinator also has a deadline, so a dead renderer
        // or stalled IPC can never prevent the user from closing the app.
        await invoke('quit_app');
    }
}

function scheduleSaveBookState(tabId, ms = 500) {
    clearTimeout(saveStateTimers[tabId]);
    saveStateTimers[tabId] = setTimeout(() => {
        delete saveStateTimers[tabId];
        saveBookState(tabId);
    }, ms);
}

function activateTab(tabId) {
    const previous = pdfStates[activeTabId];
    if (previous && activeTabId !== tabId) {
        rememberPdfScroll(previous);
        saveBookState(activeTabId).catch(error => console.warn('Failed to save PDF position:', error));
        cancelPdfRendering(previous);
        cancelThumbnailRendering(previous, true);
        if (previous.loading) releasePdfDocument(previous);
        clearTimeout(previous.evictionTimer);
        previous.evictionTimer = setTimeout(() => {
            if (activeTabId !== previous.tabId) releasePdfDocument(previous);
        }, PDF_INACTIVE_EVICT_MS);
        releaseCanvasTree(document.getElementById('viewer-pages'));
        delete document.getElementById('viewer-pages').dataset.tabId;
    }
    activeTabId = tabId;
    const current = pdfStates[tabId];
    if (current) {
        clearTimeout(current.evictionTimer);
        current.lastUsedOrder = ++pdfLastUsedOrder;
    }
    enforcePdfDocumentLimit(tabId);
    document.querySelectorAll('.tab-item').forEach(el => {
        el.classList.toggle('active', el.dataset.tabId === tabId);
    });

    const bookshelfView = document.getElementById('bookshelf-view');
    const viewerView = document.getElementById('viewer-view');

    if (tabId === 'bookshelf') {
        bookshelfView.classList.add('active');
        viewerView.classList.remove('active');
        hideCommentPopup();
        showProgressBar(false);
    } else {
        bookshelfView.classList.remove('active');
        viewerView.classList.add('active');
        // Lazy-load: restored tabs (from previous session) have no pdfStates entry yet
        if (!pdfStates[tabId]?.loaded && !pdfStates[tabId]?.loading) {
            const tab = tabs.find(t => t.id === tabId);
            const book = tab ? allBooks.find(b => b.id === tab.bookId) : null;
            if (!book) {
                // Underlying book deleted while app was closed → drop the dead tab
                closeTab(tabId);
                return;
            }
            loadPdfForTab(tabId, book);
        }
        showPdfTab(tabId);
    }
    persistTabState();
}

function showPdfTab(tabId, preserveScroll = false) {
    const state = pdfStates[tabId];
    if (!state) return;

    document.getElementById('viewer-title').textContent = state.title || '';
    document.getElementById('viewer-loading').style.display = state.loaded ? 'none' : 'flex';
    if (!state.loaded) showProgressBar(false);

    // Update toolbar toggle states
    document.getElementById('btn-spread').classList.toggle('active', state.spreadMode || false);
    document.getElementById('btn-comment-mode').classList.toggle('active', commentMode);
    updateSpreadDirectionButtonState(state);
    updatePageNavigationState(state);

    const scrollBtn = document.getElementById('btn-scroll-dir');
    if (state.scrollDir === 'horizontal') {
        scrollBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
        scrollBtn.title = '横スクロール (クリックで縦に)';
    } else {
        scrollBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
        scrollBtn.title = '縦スクロール (クリックで横に)';
    }

    const container = document.getElementById('viewer-container');
    container.classList.toggle('comment-mode', commentMode);
    container.classList.toggle('horizontal', state.scrollDir === 'horizontal');

    if (state.loaded) {
        document.getElementById('page-total').textContent = state.totalPages;
        document.getElementById('page-input').value = state.currentPage;
        document.getElementById('page-input').max = state.totalPages;
        updateViewerZoomSlider(state);
        updateFitButtonState(state);
        updatePageNavigationState(state);

        const sidebar = document.getElementById('viewer-sidebar');
        sidebar.classList.toggle('open', state.thumbnailsOpen || false);

        // The render queue owns fit calculation and performs one render per request.
        renderPdfPages(tabId, preserveScroll);
    }
}

let resumeRecoveryTimer = null;
let resumeNeedsRender = false;
function scheduleResumeRecovery(reason = 'resume') {
    resumeNeedsRender ||= reason === 'paperstock-system-resumed';
    // A focus/pageshow event can arrive while the WebView is still hidden.
    // Only confirmed visibility is allowed to cancel its memory-release timer.
    if (document.visibilityState === 'hidden') return;
    clearTimeout(pdfBackgroundTimer);
    pdfBackgroundTimer = null;
    pdfBackgroundDeadline = 0;
    clearTimeout(resumeRecoveryTimer);
    resumeRecoveryTimer = setTimeout(async () => {
        if (document.visibilityState === 'hidden') return;
        document.body.classList.add('resume-repaint');
        requestAnimationFrame(() => document.body.classList.remove('resume-repaint'));
        applyTheme();
        if (activeTabId === 'bookshelf') {
            renderBooks();
            return;
        }
        const tabId = activeTabId;
        const state = pdfStates[tabId];
        state?.loadAttempt?.checkDeadline?.();
        const forceRender = resumeNeedsRender;
        resumeNeedsRender = false;
        if (!state?.loaded) {
            activateTab(tabId);
        } else if (forceRender || state.needsRender ||
                   document.getElementById('viewer-pages').dataset.tabId !== tabId) {
            showPdfTab(tabId, true);
        } else if (state.thumbnailsOpen) {
            generateThumbnails(tabId);
        }
    }, 150);
}

// Tab bar rendering (same as before)
function renderTabBar() {
    const container = document.getElementById('tab-groups-container');
    container.innerHTML = '';
    document.getElementById('tab-bookshelf').classList.toggle('active', activeTabId === 'bookshelf');

    for (const group of tabGroups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'tab-group' + (group.collapsed ? ' collapsed' : '');
        const header = document.createElement('div');
        header.className = 'tab-group-header' + (group.collapsed ? ' collapsed' : '');
        header.innerHTML = `
      <span class="group-dot" style="background:${group.color}"></span>
      <span>${escapeHtml(group.name)}</span>
      <span class="tab-group-actions">
        <button class="group-action-btn" data-group-action="edit" data-group-id="${group.id}" title="編集">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="group-action-btn" data-group-action="delete" data-group-id="${group.id}" title="削除">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </span>
      <svg class="group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    `;
        header.addEventListener('click', (e) => {
            if (e.target.closest('[data-group-action]')) return;
            group.collapsed = !group.collapsed; renderTabBar();
        });
        header.querySelectorAll('[data-group-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const gid = parseInt(btn.dataset.groupId);
                if (btn.dataset.groupAction === 'edit') openGroupModal(tabGroups.find(g => g.id === gid));
                else if (btn.dataset.groupAction === 'delete') {
                    tabs.forEach(t => { if (t.groupId === gid) t.groupId = null; });
                    tabGroups = tabGroups.filter(g => g.id !== gid); renderTabBar();
                }
            });
        });
        groupEl.appendChild(header);
        const tabsContainer = document.createElement('div');
        tabsContainer.className = 'tab-group-tabs';
        tabs.filter(t => t.groupId === group.id).forEach(tab => tabsContainer.appendChild(createTabElement(tab)));
        groupEl.appendChild(tabsContainer);
        container.appendChild(groupEl);
    }

    const ungrouped = tabs.filter(t => !t.groupId);
    if (ungrouped.length > 0) {
        const div = document.createElement('div');
        div.className = 'ungrouped-tabs';
        ungrouped.forEach(tab => div.appendChild(createTabElement(tab)));
        container.appendChild(div);
    }
    persistTabState();
}

function createTabElement(tab) {
    const el = document.createElement('button');
    el.className = 'tab-item' + (activeTabId === tab.id ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.title = tab.title;
    el.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
    <span class="tab-label">${escapeHtml(tab.title)}</span>
    <span class="tab-close" title="閉じる">×</span>
  `;
    el.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) { e.stopPropagation(); closeTab(tab.id); return; }
        activateTab(tab.id);
    });
    el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); showTabContextMenu(e.clientX, e.clientY, tab.id);
    });
    return el;
}

// ══════════════════════════════════════════════════════
//  PDF VIEWER — enhanced
// ══════════════════════════════════════════════════════

// Compute fit scale only when the viewer is actually laid out.
// If the container is hidden (clientWidth = 0 — e.g. user switched to bookshelf
// while the PDF was loading), set state.fitNeedsRecompute = true so the next
// showPdfTab can retry once the container becomes visible.
function getFitType(state) {
    if (!state || !state.fitMode) return 'none';
    return state.fitType || 'autoWidth';
}

function updateFitButtonState(state) {
    const fitBtn = document.getElementById('btn-fit');
    if (!fitBtn) return;

    const fitType = getFitType(state);
    fitBtn.classList.toggle('active', fitType !== 'none');

    if (fitType === 'height') {
        fitBtn.title = '縦に合わせ中 (もう1回で横に合わせる)';
    } else if (fitType === 'width') {
        fitBtn.title = '横に合わせ中 (もう1回で解除)';
    } else if (fitType === 'autoWidth') {
        fitBtn.title = '横幅に自動調整中 (クリックで縦に合わせる)';
    } else {
        fitBtn.title = '縦に合わせる';
    }
}

function getSpreadDirection(state) {
    return state?.spreadDirection === 'ltr' ? 'ltr' : 'rtl';
}

function isRightBoundSpread(state) {
    return getSpreadDirection(state) === 'rtl';
}

function getSpreadAnchorPage(state) {
    const total = Math.max(1, state?.totalPages || 1);
    let page = Math.max(1, Math.min(state?.currentPage || 1, total));
    if (page === 1) return 1;
    if (page % 2 === 1) page -= 1;
    return Math.max(2, page);
}

function getNavigationAnchorPage(state) {
    if (!state) return 1;
    if (state.spreadMode) return getSpreadAnchorPage(state);
    return Math.max(1, Math.min(state.currentPage || 1, state.totalPages || state.currentPage || 1));
}

function getNavigationTargetPage(state, delta) {
    if (!state || !state.totalPages) return 1;
    if (state.spreadMode) {
        const current = getSpreadAnchorPage(state);
        const next = delta > 0
            ? (current === 1 ? 2 : current + 2)
            : (current <= 2 ? 1 : current - 2);
        return Math.max(1, Math.min(next, state.totalPages));
    }
    return Math.max(1, Math.min((state.currentPage || 1) + delta, state.totalPages));
}

function getVisualNavigationDelta(state, side) {
    const visualDelta = side === 'left' ? -1 : 1;
    return state?.spreadMode && isRightBoundSpread(state) ? -visualDelta : visualDelta;
}

function updatePageNavigationState(state) {
    const leftBtn = document.getElementById('btn-prev');
    const rightBtn = document.getElementById('btn-next');
    if (!leftBtn || !rightBtn || !state) return;

    const current = getNavigationAnchorPage(state);
    const leftDelta = getVisualNavigationDelta(state, 'left');
    const rightDelta = getVisualNavigationDelta(state, 'right');
    const leftIsNext = leftDelta > 0;
    const rightIsNext = rightDelta > 0;

    leftBtn.disabled = getNavigationTargetPage(state, leftDelta) === current;
    rightBtn.disabled = getNavigationTargetPage(state, rightDelta) === current;
    leftBtn.title = leftIsNext ? '次のページ' : '前のページ';
    rightBtn.title = rightIsNext ? '次のページ' : '前のページ';
    leftBtn.setAttribute('aria-label', leftBtn.title);
    rightBtn.setAttribute('aria-label', rightBtn.title);
}

function updateSpreadDirectionButtonState(state) {
    const btn = document.getElementById('btn-spread-direction');
    if (!btn || !state) return;

    const rtl = isRightBoundSpread(state);
    btn.classList.toggle('active', rtl);
    btn.title = rtl ? '右綴じ表示中 (クリックで左綴じ)' : '左綴じ表示中 (クリックで右綴じ)';
    btn.setAttribute('aria-label', rtl ? '右綴じ表示' : '左綴じ表示');
    btn.innerHTML = getSpreadDirectionIcon(rtl);
}

function getSpreadDirectionIcon(rtl) {
    const spineX = rtl ? 20 : 4;
    const arrowLine = rtl ? 'M16 12H8' : 'M8 12h8';
    const arrowHead = rtl ? 'M11 9l-3 3 3 3' : 'M13 9l3 3-3 3';
    return `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="5" width="7" height="14" rx="1.2" />
            <rect x="13" y="5" width="7" height="14" rx="1.2" />
            <path d="M${spineX} 5v14" stroke-width="3" />
            <path d="${arrowLine}" />
            <path d="${arrowHead}" />
        </svg>
    `;
}

async function ensureFitScale(state, isCurrent = () => true) {
    if (!state || !state.fitMode || !state.pdfDoc) return;
    const container = document.getElementById('viewer-container');
    if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) {
        state.fitNeedsRecompute = true;
        return;
    }
    try {
        const pageNum = Math.max(1, Math.min(state.currentPage || 1, state.totalPages || state.currentPage || 1));
        const page = await waitForPdfSession(state.pdfDoc.getPage(pageNum), state.pdfRuntime);
        if (!isCurrent()) return;
        const viewport = page.getViewport({ scale: 1.0 });
        const fitType = getFitType(state);
        let targetSize = 0;
        let sourceSize = 0;

        if (fitType === 'height') {
            targetSize = container.clientHeight - 8;
            sourceSize = viewport.height;
        } else {
            // autoWidth preserves the app's historical default open behavior.
            targetSize = container.clientWidth - (fitType === 'autoWidth' ? 60 : 8);
            if (state.spreadMode && state.currentPage !== 1 && fitType === 'width') {
                targetSize = (targetSize - 4) / 2;
            }
            sourceSize = viewport.width;
        }

        if (targetSize > 0 && sourceSize > 0) {
            state.scale = targetSize / sourceSize;
            state.fitNeedsRecompute = false;
        } else {
            state.fitNeedsRecompute = true;
        }
    } catch (_e) {
        state.fitNeedsRecompute = true;
    }
}

function showPdfLoadFailure(tabId, state, error) {
    state.loadError = error.name === 'TimeoutError'
        ? 'PDFの読み込みが時間内に完了しませんでした。再試行してください。'
        : 'PDFを開けませんでした。再試行してください。';
    if (activeTabId !== tabId || pdfStates[tabId] !== state) return;
    const loading = document.getElementById('viewer-loading');
    loading.style.display = 'flex';
    loading.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.textContent = state.loadError;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-primary';
    retry.textContent = '再試行';
    retry.addEventListener('click', () => {
        if (pdfStates[tabId] !== state || state.closed) return;
        const book = allBooks.find(item => item.id === state.bookId);
        if (book) loadPdfForTab(tabId, book);
    });
    loading.appendChild(paragraph);
    loading.appendChild(retry);
}

async function loadPdfForTab(tabId, book) {
    if (!tabs.some(tab => tab.id === tabId)) return;
    let state = pdfStates[tabId];
    if (state?.loading || state?.loaded) return;
    if (!state) {
        const restoredZoom = book.lastZoom && book.lastZoom > 0 ? book.lastZoom : null;
        state = pdfStates[tabId] = {
            tabId,
            title: book.title,
            pdfDoc: null,
            loadingTask: null,
            currentPage: book.lastPage || 1,
            totalPages: 0,
            scale: restoredZoom || 1.0,
            fitMode: !restoredZoom,
            fitType: restoredZoom ? 'none' : 'autoWidth',
            fitNeedsRecompute: !restoredZoom,
            thumbnailsOpen: false,
            loaded: false,
            loading: false,
            bookId: book.id,
            spreadMode: !!book.lastSpreadMode,
            spreadDirection: book.lastSpreadDirection === 0 ? 'ltr' : 'rtl',
            scrollDir: 'vertical',
            comments: [],
            bookmarks: [],
            pendingScrollY: book.lastScrollY || 0,
            savedScrollY: book.lastScrollY || 0,
            renderTasks: new Set(),
            textLayers: new Set(),
        };
    }
    state.loading = true;
    state.loadError = null;
    state.lastUsedOrder = ++pdfLastUsedOrder;
    const generation = state.loadGeneration = (state.loadGeneration || 0) + 1;
    const attempt = { controller: new AbortController(), phase: 'prepare', checkDeadline: null };
    state.loadAttempt = attempt;
    const isCurrent = () => pdfStates[tabId] === state && !state.closed && state.loadGeneration === generation;
    const wait = (promise, phase) => {
        attempt.phase = phase;
        return waitForPdfPromise(promise, {
            signal: attempt.controller.signal, timeoutMs: PDF_LOAD_IDLE_TIMEOUT_MS, watch: attempt,
        });
    };
    const showStep = (message) => {
        if (!isCurrent() || activeTabId !== tabId) return;
        const loading = document.getElementById('viewer-loading');
        loading.style.display = 'flex';
        loading.replaceChildren();
        const paragraph = document.createElement('p');
        paragraph.textContent = message;
        loading.appendChild(paragraph);
    };
    try {
        showStep('PDFを準備しています…');
        await wait(state.releasePromise, 'release');
        if (!isCurrent()) return;
        await wait(enforcePdfDocumentLimit(tabId), 'release');
        if (!isCurrent()) return;
        showStep('PDF.js初期化中…');
        await wait(initPdfJs(), 'initialize');
        if (!isCurrent()) return;
        if (!pdfjsReady) throw new Error(pdfjsInitError || 'PDF.js initialization failed');
        showStep('PDF読み込み中…');
        const pdfUrl = await wait(invoke('get_pdf_stream_url', { filePath: book.filePath }), 'url');
        if (!isCurrent()) return;
        const runtime = createPdfRuntime(attempt, error => {
            // A worker may fail after loading has finished, when there is no
            // pending load promise left to reach the catch block below.
            if (!isCurrent() || !state.loaded) return;
            console.error('PDF worker failed after loading:', error);
            showPdfLoadFailure(tabId, state, error);
            releasePdfDocument(state);
        });
        state.pdfRuntime = runtime;
        const loadingTask = pdfjsLib.getDocument({
            url: pdfUrl,
            worker: runtime.worker,
            disableAutoFetch: true,
            disableStream: true,
            canvasMaxAreaInBytes: 16 * 1024 * 1024,
        });
        state.loadingTask = loadingTask;
        let loadedBytes = 0;
        loadingTask.onProgress = progress => {
            if (!isCurrent() || !(progress.loaded > loadedBytes)) return;
            loadedBytes = progress.loaded;
            attempt.touchProgress?.();
        };
        const doc = await wait(loadingTask.promise, 'document');
        if (!isCurrent()) return;
        state.pdfDoc = doc;
        state.totalPages = doc.numPages;
        state.currentPage = Math.max(1, Math.min(state.currentPage, doc.numPages));
        const [comments, bookmarks] = await wait(Promise.all([
            invoke('get_comments', { bookId: book.id }),
            invoke('get_bookmarks', { bookId: book.id }),
        ]), 'metadata');
        if (!isCurrent()) return;
        state.comments = comments;
        state.bookmarks = bookmarks;
        state.fitNeedsRecompute = state.fitMode;
        state.loaded = true;
        state.loading = false;
        if (activeTabId === tabId) showPdfTab(tabId);
    } catch (error) {
        if (!isCurrent()) return;
        console.error(`Failed to load PDF (${attempt.phase}):`, error);
        // Show a useful failure immediately. Cleanup has its own independent
        // deadline; an unresponsive worker must never hide this retry action.
        showPdfLoadFailure(tabId, state, error);
        releasePdfDocument(state);
    }
}

function getPdfCanvasSize(viewport, maxPixels, maxDpr = 2) {
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
        throw new Error('PDFページのサイズが無効です');
    }
    const outputScale = Math.min(window.devicePixelRatio || 1, maxDpr,
        Math.sqrt(maxPixels / (viewport.width * viewport.height)),
        PDF_CANVAS_MAX_DIMENSION / viewport.width, PDF_CANVAS_MAX_DIMENSION / viewport.height);
    return {
        width: Math.max(1, Math.floor(viewport.width * outputScale)),
        height: Math.max(1, Math.floor(viewport.height * outputScale)),
    };
}

async function cleanupPdfDocument(state, doc, runtime) {
    if (state.pdfDoc !== doc) return;
    // PDF.js defers operator-stream cancellation for 100 ms after RenderTask.cancel.
    // Its render promise has already rejected at that point; wait for the stream
    // before clearing shared image objects or starting the next queued render.
    const remaining = 120 - (Date.now() - (state.renderCancelledAt || 0));
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    if (state.pdfDoc !== doc) return;
    try { await waitForPdfSession(doc.cleanup(true), runtime); } catch (error) {
        if (state.pdfDoc === doc) console.warn('PDF cache cleanup failed:', error);
    }
}

function renderPdfPages(tabId, preserveScroll = false) {
    const state = pdfStates[tabId];
    if (!state?.pdfDoc || !state.loaded || tabId !== activeTabId || document.visibilityState === 'hidden') return Promise.resolve();
    cancelPdfRendering(state);
    cancelThumbnailRendering(state);
    state.needsRender = true;
    const generation = state.renderGeneration;
    const doc = state.pdfDoc;
    const runtime = state.pdfRuntime;
    const isCurrent = () => pdfStates[tabId] === state && state.pdfDoc === doc &&
        state.renderGeneration === generation && activeTabId === tabId && document.visibilityState !== 'hidden';
    return enqueuePdfWork(async () => {
        if (!isCurrent()) return;
        const pagesContainer = document.getElementById('viewer-pages');
        const viewerContainer = document.getElementById('viewer-container');
        let scrollRatioX = 0, scrollRatioY = 0;
        const hasScrollSnapshot = preserveScroll && pagesContainer.dataset.tabId === tabId && pagesContainer.scrollHeight > 0;
        if (hasScrollSnapshot) {
            scrollRatioX = viewerContainer.scrollLeft / (pagesContainer.scrollWidth || 1);
            scrollRatioY = viewerContainer.scrollTop / pagesContainer.scrollHeight;
        }
        const tempHolder = document.createElement('div');
        tempHolder.className = 'pdf-render-buffer';
        tempHolder.style.position = 'absolute';
        tempHolder.style.visibility = 'hidden';
        tempHolder.style.pointerEvents = 'none';
        document.body.appendChild(tempHolder);
        try {
            if (state.fitNeedsRecompute) await ensureFitScale(state, isCurrent);
            if (!isCurrent()) return;
            if (!Number.isFinite(state.scale) || state.scale <= 0) state.scale = 1;
            const frame = { ...state, scale: state.scale, nightMode };
            const startPage = frame.spreadMode ? getSpreadAnchorPage(frame) : frame.currentPage;
            const pageNums = [startPage];
            if (frame.spreadMode && startPage !== 1 && startPage < frame.totalPages) pageNums.push(startPage + 1);
            if (frame.spreadMode && isRightBoundSpread(frame)) pageNums.reverse();
            let holder = tempHolder;
            if (pageNums.length > 1) {
                holder = document.createElement('div');
                holder.className = 'spread-pair';
                tempHolder.appendChild(holder);
            }
            for (const pageNum of pageNums) {
                if (!isCurrent()) return;
                await createRenderedPage(state, frame, pageNum, tabId, holder,
                    Math.floor(PDF_VIEWER_FRAME_PIXELS / pageNums.length), isCurrent);
            }
            if (!isCurrent()) return;
            hideCommentPopup();
            releaseCanvasTree(pagesContainer);
            pagesContainer.classList.toggle('spread', frame.spreadMode);
            pagesContainer.classList.toggle('horizontal', frame.scrollDir === 'horizontal');
            pagesContainer.dataset.tabId = tabId;
            while (tempHolder.firstChild) pagesContainer.appendChild(tempHolder.firstChild);
            state.needsRender = false;
            document.getElementById('page-input').value = frame.currentPage;
            document.getElementById('page-total').textContent = frame.totalPages;
            updateViewerZoomSlider(state);
            updateFitButtonState(state);
            updatePageNavigationState(state);
            if (hasScrollSnapshot && pagesContainer.scrollHeight > 0) {
                viewerContainer.scrollLeft = scrollRatioX * pagesContainer.scrollWidth;
                viewerContainer.scrollTop = scrollRatioY * pagesContainer.scrollHeight;
            } else if (state.pendingScrollY && pagesContainer.scrollHeight > 0) {
                viewerContainer.scrollTop = state.pendingScrollY * pagesContainer.scrollHeight;
            } else {
                viewerContainer.scrollTop = 0;
                viewerContainer.scrollLeft = 0;
            }
            state.pendingScrollY = 0;
            updateThumbnailHighlight(tabId);
            updateBookmarkButton();
            updateProgressBar(tabId);
        } catch (error) {
            if (isCurrent() && error.name !== 'RenderingCancelledException' && error.name !== 'AbortException') {
                console.error('PDF render failed:', error);
            }
        } finally {
            releaseCanvasTree(tempHolder);
            tempHolder.remove();
            await cleanupPdfDocument(state, doc, runtime);
        }
        if (isCurrent() && state.thumbnailsOpen) generateThumbnails(tabId);
    });
}

async function createRenderedPage(state, frame, pageNum, tabId, holder, maxPixels, isCurrent) {
    const page = await waitForPdfSession(frame.pdfDoc.getPage(pageNum), frame.pdfRuntime);
    let renderTask;
    try {
        if (!isCurrent()) return;
        const viewport = page.getViewport({ scale: frame.scale });
        const wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.style.width = viewport.width + 'px';
        wrapper.style.height = viewport.height + 'px';
        wrapper.style.setProperty('--total-scale-factor', frame.scale);
        wrapper.style.setProperty('--scale-round-x', '1px');
        wrapper.style.setProperty('--scale-round-y', '1px');
        wrapper.dataset.page = pageNum;
        holder.appendChild(wrapper);
        const canvas = document.createElement('canvas');
        canvas.className = 'page-canvas';
        const size = getPdfCanvasSize(viewport, maxPixels);
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
        wrapper.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        renderTask = page.render({
            canvasContext: ctx, viewport,
            transform: [size.width / viewport.width, 0, 0, size.height / viewport.height, 0, 0],
        });
        state.renderTasks.add(renderTask);
        await waitForPdfSession(renderTask.promise, frame.pdfRuntime);
        state.renderTasks.delete(renderTask);
        if (!isCurrent()) return;
        if (frame.nightMode) applyNightFilterToCanvas(canvas, ctx);
        await renderPageTextLayer(page, viewport, wrapper, state, isCurrent, frame.pdfRuntime);
        if (!isCurrent()) return;
        // Add comment markers for this page
        const pageComments = (state.comments || []).filter(c => c.pageNum === pageNum);
        for (const comment of pageComments) {
            const marker = document.createElement('div');
            marker.className = 'comment-marker' + (comment.content ? ' has-content' : '');
            marker.style.left = (comment.x * 100) + '%';
            marker.style.top = (comment.y * 100) + '%';
            marker.style.background = comment.color || '#ffcc00';
            marker.dataset.commentId = comment.id;
            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                openCommentPopup(comment, e.clientX, e.clientY, tabId);
            });
            wrapper.appendChild(marker);
        }

        // Click to add comment in comment mode
        wrapper.addEventListener('click', (e) => {
            if (!commentMode) return;
            if (e.target.closest('.comment-marker')) return;
            const rect = wrapper.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            addNewComment(tabId, pageNum, x, y, e.clientX, e.clientY);
        });

    } finally {
        if (renderTask) state.renderTasks.delete(renderTask);
        // Release operator lists and decoded page images, not just the DOM canvas.
        page.cleanup();
    }
}

async function readPageTextContent(page, state, isCurrent, runtime = state.pdfRuntime) {
    // Some WKWebView versions have ReadableStream.getReader(), but no async
    // iterator. PDF.js's getTextContent() uses for-await and leaks an unconsumed
    // text stream on those versions. Consume it explicitly, with early bounds.
    if (!page.streamTextContent) return waitForPdfSession(page.getTextContent({ includeMarkedContent: true }), runtime);
    const reader = page.streamTextContent({ includeMarkedContent: true }).getReader();
    (state.textReaders ||= new Set()).add(reader);
    const textContent = { items: [], styles: Object.create(null), lang: null };
    let characters = 0;
    try {
        while (isCurrent()) {
            const { value, done } = await waitForPdfSession(reader.read(), runtime);
            if (done) return textContent;
            if (!isCurrent()) return null;
            textContent.lang ??= value.lang;
            Object.assign(textContent.styles, value.styles);
            for (const item of value.items) {
                if (typeof item.str === 'string') characters += item.str.length;
                textContent.items.push(item);
            }
            if (textContent.items.length > MAX_TEXT_LAYER_ITEMS || characters > MAX_TEXT_LAYER_CHARS) return null;
        }
        return null;
    } finally {
        state.textReaders.delete(reader);
        // PDF.js's message stream requires an Error reason to mark its controller
        // closed before late worker chunks arrive (a reasonless cancel asserts).
        try {
            await waitForPdfSession(reader.cancel(new Error('PDF text reader released')), runtime);
        } catch (_error) { /* worker may already be destroyed */ }
        try { reader.releaseLock(); } catch (_error) { /* interrupted read may still be closing */ }
    }
}

async function renderPageTextLayer(page, viewport, wrapper, state, isCurrent, runtime) {
    if (!pdfjsLib?.TextLayer || !page?.getTextContent || !isCurrent()) return;
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(textLayerDiv);
    let textLayer;
    try {
        const textContent = await readPageTextContent(page, state, isCurrent, runtime);
        if (!textContent || !isCurrent()) {
            textLayerDiv.remove();
            return;
        }
        const textItems = (textContent.items || []).filter(item => typeof item.str === 'string');
        const charCount = textItems.reduce((sum, item) => sum + item.str.length, 0);
        if (!isCurrent() || !wrapper.isConnected || textItems.length === 0 ||
            textItems.length > MAX_TEXT_LAYER_ITEMS || charCount > MAX_TEXT_LAYER_CHARS) {
            textLayerDiv.remove();
            return;
        }
        textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
        state.textLayers.add(textLayer);
        await waitForPdfSession(textLayer.render(), runtime);
        if (!isCurrent() || !textLayerDiv.textContent.trim()) textLayerDiv.remove();
    } catch (error) {
        textLayerDiv.remove();
        if (isCurrent() && error.name !== 'AbortException') console.warn('Text layer render failed:', error);
    } finally {
        if (textLayer) state.textLayers.delete(textLayer);
    }
}

// ── Comment functions ────────────────────────────────
async function addNewComment(tabId, pageNum, x, y, screenX, screenY) {
    const state = pdfStates[tabId];
    if (!state) return;

    const comment = await invoke('add_comment', {
        data: { bookId: state.bookId, pageNum, x, y, content: '', color: '#ffcc00' }
    });

    state.comments.push(comment);
    renderPdfPages(tabId);

    // Open popup for editing
    setTimeout(() => openCommentPopup(comment, screenX, screenY, tabId), 100);
}

function openCommentPopup(comment, x, y, tabId) {
    editingCommentId = comment.id;
    editingCommentTabId = tabId;
    const popup = document.getElementById('comment-popup');
    popup.querySelector('.comment-popup-page').textContent = `ページ ${comment.pageNum}`;
    document.getElementById('comment-text').value = comment.content || '';
    popup.style.display = 'block';
    popup.style.left = Math.min(x + 10, window.innerWidth - 280) + 'px';
    popup.style.top = Math.min(y - 30, window.innerHeight - 200) + 'px';
    document.getElementById('comment-text').focus();
}

function hideCommentPopup() {
    document.getElementById('comment-popup').style.display = 'none';
    editingCommentId = null;
    editingCommentTabId = null;
}

async function saveComment() {
    if (!editingCommentId) return;
    const content = document.getElementById('comment-text').value;
    await invoke('update_comment', { id: editingCommentId, data: { content } });

    const state = pdfStates[editingCommentTabId];
    if (state) {
        const c = state.comments.find(c => c.id === editingCommentId);
        if (c) c.content = content;
        renderPdfPages(editingCommentTabId);
    }
    hideCommentPopup();
}

async function deleteComment() {
    if (!editingCommentId) return;
    await invoke('delete_comment', { id: editingCommentId });

    const state = pdfStates[editingCommentTabId];
    if (state) {
        state.comments = state.comments.filter(c => c.id !== editingCommentId);
        renderPdfPages(editingCommentTabId);
    }
    hideCommentPopup();
}

// ── Viewer controls ──────────────────────────────────
function viewerNav(delta) {
    const state = pdfStates[activeTabId];
    if (!state) return;

    state.currentPage = getNavigationTargetPage(state, delta);
    renderPdfPages(activeTabId, true);
    saveBookState(activeTabId);
}

function viewerNavBySide(side) {
    const state = pdfStates[activeTabId];
    if (!state) return;
    viewerNav(getVisualNavigationDelta(state, side));
}

function viewerSetZoom(newScale) {
    const state = pdfStates[activeTabId];
    if (!state) return;
    state.scale = Math.max(0.3, Math.min(newScale, 5.0));
    state.fitMode = false;
    state.fitType = 'none';
    state.fitNeedsRecompute = false;
    updateViewerZoomSlider(state);
    updateFitButtonState(state);
    renderPdfPages(activeTabId);
    scheduleSaveBookState(activeTabId);
}

function viewerZoomIn() { const s = pdfStates[activeTabId]; if (s) viewerSetZoom(s.scale * 1.2); }
function viewerZoomOut() { const s = pdfStates[activeTabId]; if (s) viewerSetZoom(s.scale * 0.8); }

function updateViewerZoomSlider(state) {
    const pct = Math.round(state.scale * 100);
    document.getElementById('zoom-level').textContent = pct + '%';
    document.getElementById('viewer-zoom-slider').value = pct;
}

async function viewerFitCycle() {
    const state = pdfStates[activeTabId];
    if (!state || !state.pdfDoc) return;

    const fitType = getFitType(state);
    if (fitType === 'none' || fitType === 'autoWidth') {
        state.fitType = 'height';
        state.fitMode = true;
        state.fitNeedsRecompute = true;
    } else if (fitType === 'height') {
        state.fitType = 'width';
        state.fitMode = true;
        state.fitNeedsRecompute = true;
    } else {
        state.fitType = 'none';
        state.fitMode = false;
        state.fitNeedsRecompute = false;
        updateFitButtonState(state);
        scheduleSaveBookState(activeTabId);
        return; // Don't re-render, just release fit mode
    }

    updateFitButtonState(state);
    renderPdfPages(activeTabId);
    scheduleSaveBookState(activeTabId);
}

function toggleSpreadMode() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    state.spreadMode = !state.spreadMode;
    document.getElementById('btn-spread').classList.toggle('active', state.spreadMode);
    updateSpreadDirectionButtonState(state);
    updatePageNavigationState(state);
    if (state.fitMode) state.fitNeedsRecompute = true;
    renderPdfPages(activeTabId);
    saveBookState(activeTabId);
}

function toggleSpreadDirection() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    state.spreadDirection = isRightBoundSpread(state) ? 'ltr' : 'rtl';
    updateSpreadDirectionButtonState(state);
    updatePageNavigationState(state);
    if (state.spreadMode) {
        renderPdfPages(activeTabId, true);
    }
    saveBookState(activeTabId);
}

function toggleScrollDirection() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    state.scrollDir = state.scrollDir === 'vertical' ? 'horizontal' : 'vertical';
    showPdfTab(activeTabId);
}

function toggleCommentMode() {
    commentMode = !commentMode;
    document.getElementById('btn-comment-mode').classList.toggle('active', commentMode);
    document.getElementById('viewer-container').classList.toggle('comment-mode', commentMode);
}

function viewerToggleThumbnails() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    state.thumbnailsOpen = !state.thumbnailsOpen;
    document.getElementById('viewer-sidebar').classList.toggle('open', state.thumbnailsOpen);
    if (state.thumbnailsOpen) {
        generateThumbnails(activeTabId);
    } else {
        cancelThumbnailRendering(state, true);
    }
}

function generateThumbnails(tabId) {
    const state = pdfStates[tabId];
    if (!state?.pdfDoc || !state.thumbnailsOpen || activeTabId !== tabId) return Promise.resolve();
    cancelThumbnailRendering(state);
    const generation = state.thumbnailGeneration;
    const doc = state.pdfDoc;
    const runtime = state.pdfRuntime;
    const theme = nightMode;
    const isCurrent = () => pdfStates[tabId] === state && state.pdfDoc === doc &&
        state.thumbnailGeneration === generation && state.thumbnailsOpen && activeTabId === tabId &&
        document.visibilityState !== 'hidden';
    return enqueuePdfWork(async () => {
        if (!isCurrent()) return;
        const list = document.getElementById('thumbnail-list');
        const max = Math.min(state.totalPages, 80);
        if (list.dataset.tabId !== tabId || list.dataset.theme !== String(theme)) {
            releaseCanvasTree(list);
            list.dataset.tabId = tabId;
            list.dataset.theme = String(theme);
            for (let i = 1; i <= max; i++) {
                const item = document.createElement('div');
                item.className = 'thumbnail-item' + (i === state.currentPage ? ' active' : '');
                item.dataset.page = i;
                const canvas = document.createElement('canvas');
                canvas.className = 'thumbnail-canvas';
                canvas.width = canvas.height = 0;
                const label = document.createElement('span');
                label.className = 'thumbnail-label';
                label.textContent = i;
                item.appendChild(canvas);
                item.appendChild(label);
                list.appendChild(item);
                item.addEventListener('click', () => {
                    if (activeTabId !== tabId || pdfStates[tabId] !== state) return;
                    state.currentPage = i;
                    renderPdfPages(tabId);
                    saveBookState(tabId);
                });
            }
        }
        for (let i = 1; i <= max && isCurrent(); i++) {
            const canvas = list.children[i - 1]?.querySelector('canvas');
            if (!canvas || canvas.dataset.rendered === 'true') continue;
            let page, task;
            try {
                page = await waitForPdfSession(doc.getPage(i), runtime);
                if (!isCurrent()) return;
                const original = page.getViewport({ scale: 1 });
                const scale = Math.min(0.2, 120 / original.width, 180 / original.height);
                const viewport = page.getViewport({ scale });
                const size = getPdfCanvasSize(viewport, 120 * 180, 1);
                canvas.width = size.width;
                canvas.height = size.height;
                canvas.style.width = viewport.width + 'px';
                canvas.style.height = viewport.height + 'px';
                const ctx = canvas.getContext('2d');
                task = page.render({ canvasContext: ctx, viewport,
                    transform: [size.width / viewport.width, 0, 0, size.height / viewport.height, 0, 0] });
                state.thumbnailTask = task;
                await waitForPdfSession(task.promise, runtime);
                if (!isCurrent()) return;
                if (theme) applyNightFilterToCanvas(canvas, ctx);
                canvas.dataset.rendered = 'true';
            } catch (error) {
                if (isCurrent() && error.name !== 'RenderingCancelledException') console.warn('Thumbnail failed:', error);
            } finally {
                if (state.thumbnailTask === task) state.thumbnailTask = null;
                if (canvas.dataset.rendered !== 'true') canvas.width = canvas.height = 0;
                page?.cleanup();
                // Shared image objects can be much larger than these tiny thumbnails.
                await cleanupPdfDocument(state, doc, runtime);
            }
        }
    });
}

function updateThumbnailHighlight(tabId) {
    const state = pdfStates[tabId];
    if (!state) return;
    document.querySelectorAll('.thumbnail-item').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.page) === state.currentPage);
    });
    const active = document.querySelector('.thumbnail-item.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ══════════════════════════════════════════════════════
//  BOOKSHELF
// ══════════════════════════════════════════════════════

async function renderBooks() {
    const requestId = ++renderBooksRequestId;
    const grid = document.getElementById('book-grid');
    const emptyState = document.getElementById('empty-state');
    const countEl = document.getElementById('book-count');

    let books = [...allBooks];

    // Filter
    if (currentFilter === 'tag' && currentTagId) {
        books = books.filter(b => b.tags.some(t => t.id === currentTagId));
    } else if (currentFilter === 'favorites') {
        books = books.filter(b => b.favorite);
    } else if (currentFilter === 'recent-opened') {
        books = books.filter(b => b.lastOpenedAt);
        books.sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
    } else if (currentFilter === 'status-unread') {
        books = books.filter(b => b.status === 'unread');
    } else if (currentFilter === 'status-reading') {
        books = books.filter(b => b.status === 'reading');
    } else if (currentFilter === 'status-completed') {
        books = books.filter(b => b.status === 'completed');
    }

    // Search (NFKC normalize + lowercase + strip whitespace)
    const rawQuery = document.getElementById('search-input').value;
    const query = normalizeForSearch(rawQuery);
    if (query) {
        const pdfContentPaths = await getPdfContentSearchPathSet(rawQuery);
        if (requestId !== renderBooksRequestId) return;
        books = books.filter(b =>
            normalizeForSearch(b.title).includes(query) ||
            pdfContentPaths.has(normalizePathForSearch(b.filePath))
        );
    }

    // Sort (skip for recent-opened which has its own sort)
    if (currentFilter !== 'recent-opened') {
        books = sortBooks(books, currentSort);
    }

    const folderModel = shouldUseBookFolderGrid(query) ? buildBookFolderModel(books) : null;
    countEl.textContent = books.length > 0
        ? `${books.length}冊${folderModel?.folderCount ? ` / ${folderModel.folderCount}フォルダ` : ''}`
        : '';

    if (books.length === 0) {
        grid.style.display = 'none';
        emptyState.style.display = 'flex';
        return;
    }

    emptyState.style.display = 'none';

    if (viewMode === 'list') {
        grid.style.display = 'block';
        await renderListView(grid, books);
    } else {
        grid.style.display = 'grid';
        await renderGridView(grid, books, folderModel);
    }
}

function shouldUseBookFolderGrid(query) {
    return viewMode === 'grid' && currentFilter === 'all' && !query;
}

async function getPdfContentSearchPathSet(rawQuery) {
    const trimmed = String(rawQuery || '').trim();
    const normalized = normalizeForSearch(trimmed);
    if (normalized.length < PDF_CONTENT_SEARCH_MIN_CHARS) return new Set();

    const cacheKey = trimmed.normalize('NFKC').toLowerCase();
    const cached = pdfContentSearchCache.get(cacheKey);
    if (cached) return cached;

    try {
        const paths = await invoke('search_pdf_content_paths', { query: trimmed });
        const result = new Set((paths || []).map(normalizePathForSearch));
        pdfContentSearchCache.set(cacheKey, result);
        return result;
    } catch (err) {
        console.warn('PDF content search failed:', err);
        return new Set();
    }
}

function normalizePathForSearch(path) {
    return String(path || '').normalize('NFC').toLowerCase();
}

function buildBookFolderModel(books) {
    sanitizeManualBookStacks();
    const manualFolders = getManualBookFolders(books);
    const manualFolderByBookId = new Map();
    for (const folder of manualFolders) {
        for (const book of folder.books) manualFolderByBookId.set(book.id, folder);
    }

    if (manualFolders.length === 0) return null;

    const items = [];
    const renderedFolderIds = new Set();

    for (const book of books) {
        const manualFolder = manualFolderByBookId.get(book.id);
        if (manualFolder) {
            if (!renderedFolderIds.has(manualFolder.id)) {
                renderedFolderIds.add(manualFolder.id);
                items.push({ type: 'folder', folder: manualFolder });
            }
            continue;
        }

        items.push({ type: 'book', book });
    }

    return { items, folderCount: renderedFolderIds.size };
}

function getManualBookFolders(visibleBooks = allBooks) {
    const visibleById = new Map(visibleBooks.map(book => [book.id, book]));
    return manualBookStacks
        .map(stack => {
            const books = stack.bookIds.map(bookId => visibleById.get(bookId)).filter(Boolean);
            if (books.length < 2) return null;
            return {
                id: stack.id,
                type: 'manual',
                name: stack.name,
                color: stack.color,
                stack,
                books,
            };
        })
        .filter(Boolean);
}

function sortBooks(books, sortBy) {
    const dir = sortAscending ? 1 : -1;
    return books.sort((a, b) => {
        let cmp = 0;
        switch (sortBy) {
            case 'title':
                cmp = a.title.localeCompare(b.title, 'ja');
                break;
            case 'created_at':
                cmp = (a.createdAt || '').localeCompare(b.createdAt || '');
                break;
            case 'page_count':
                cmp = (a.pageCount || 0) - (b.pageCount || 0);
                break;
            case 'status': {
                const order = { reading: 0, unread: 1, completed: 2 };
                cmp = (order[a.status] ?? 1) - (order[b.status] ?? 1);
                break;
            }
            case 'updated_at':
            default:
                cmp = (a.updatedAt || '').localeCompare(b.updatedAt || '');
                break;
        }
        return cmp * dir;
    });
}

function renderGridView(grid, books, folderModel = null) {
    const fragment = document.createDocumentFragment();
    const items = folderModel?.items || books.map(book => ({ type: 'book', book }));

    for (const item of items) {
        if (item.type === 'folder') fragment.appendChild(createBookFolderCard(item.folder));
        else fragment.appendChild(createBookCard(item.book));
    }
    grid.innerHTML = '';
    grid.appendChild(fragment);
}

function sortIndicator(col) {
    if (currentSort !== col) return '';
    return sortAscending ? ' ▲' : ' ▼';
}

function toggleListSort(col) {
    if (currentSort === col) {
        sortAscending = !sortAscending;
    } else {
        currentSort = col;
        sortAscending = col === 'title'; // title defaults ascending, others descending
    }
    localStorage.setItem('ps-sort', currentSort);
    localStorage.setItem('ps-sort-asc', sortAscending);
    document.getElementById('sort-select').value = currentSort;
    renderBooks();
}

function renderListView(grid, books) {
    grid.innerHTML = '';
    const table = document.createElement('div');
    table.className = 'book-list';

    // Sortable header
    const header = document.createElement('div');
    header.className = 'book-list-header';
    header.innerHTML = `
        <span class="list-col-fav"></span>
        <span class="list-col-title list-sortable" data-sort="title">タイトル${sortIndicator('title')}</span>
        <span class="list-col-status list-sortable" data-sort="status">ステータス${sortIndicator('status')}</span>
        <span class="list-col-pages list-sortable" data-sort="page_count">ページ${sortIndicator('page_count')}</span>
        <span class="list-col-date list-sortable" data-sort="updated_at">更新日${sortIndicator('updated_at')}</span>
    `;
    header.querySelectorAll('.list-sortable').forEach(el => {
        el.addEventListener('click', () => toggleListSort(el.dataset.sort));
    });
    table.appendChild(header);

    for (const book of books) {
        const row = document.createElement('div');
        row.className = 'book-list-row';
        row.dataset.id = book.id;

        const statusLabel = book.status === 'reading' ? '読書中' : book.status === 'completed' ? '読了' : '未読';
        const statusClass = book.status || 'unread';
        const dateStr = book.updatedAt ? new Date(book.updatedAt).toLocaleDateString('ja-JP') : '';
        const favClass = book.favorite ? 'fav-active' : '';

        row.innerHTML = `
            <span class="list-col-fav">
                <button class="fav-btn ${favClass}" data-id="${book.id}" title="お気に入り">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="${book.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                </button>
            </span>
            <span class="list-col-title">${escapeHtml(book.title)}</span>
            <span class="list-col-status"><span class="status-pill ${statusClass}">${statusLabel}</span></span>
            <span class="list-col-pages">${book.pageCount || '-'}</span>
            <span class="list-col-date">${dateStr}</span>
        `;

        row.addEventListener('click', (e) => {
            if (e.target.closest('.fav-btn')) return;
            openPdfTab(book.id);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault(); showContextMenu(e.clientX, e.clientY, book.id);
        });

        const favBtn = row.querySelector('.fav-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(book.id);
        });

        table.appendChild(row);
    }
    grid.appendChild(table);
}

async function toggleFavorite(bookId) {
    const book = allBooks.find(b => b.id === bookId);
    if (!book) return;
    const newVal = book.favorite ? 0 : 1;
    await invoke('update_book', { id: bookId, updates: { favorite: newVal } });
    book.favorite = newVal;
    await renderBooks();
    if (activeBookFolderRef) {
        const folder = getBookFolderByRef(activeBookFolderRef);
        if (folder) openBookFolder(folder);
        else closeBookFolder();
    }
}

function createBookFolderCard(folder) {
    const card = document.createElement('div');
    card.className = 'book-folder-card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.dataset.folderId = folder.id;
    card.dataset.folderType = folder.type;
    card.dataset.folderRefId = folder.type === 'tag' ? String(folder.tag.id) : folder.id;

    const preview = document.createElement('div');
    preview.className = 'book-folder-preview';
    preview.style.setProperty('--folder-accent', getBookFolderColor(folder));

    const coverGrid = document.createElement('div');
    coverGrid.className = 'book-folder-cover-grid';
    for (const book of folder.books.slice(0, BOOK_FOLDER_PREVIEW_LIMIT)) {
        coverGrid.appendChild(createFolderPreviewTile(book));
    }
    preview.appendChild(coverGrid);

    const info = document.createElement('div');
    info.className = 'book-info book-folder-info';
    info.innerHTML = `
      <div class="book-title">${escapeHtml(getBookFolderName(folder))}</div>
      <div class="book-folder-meta">${folder.books.length}冊</div>
    `;

    card.appendChild(preview);
    card.appendChild(info);

    const open = () => openBookFolder(folder);
    card.addEventListener('click', open);
    if (folder.type === 'manual') {
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openStackRenameModal(folder.id);
        });
    }
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
        }
    });
    attachFolderDragHandlers(card, folder);

    loadFolderPreviewCovers(card);
    return card;
}

function getBookFolderName(folder) {
    return folder.name || folder.tag?.name || 'スタック';
}

function getBookFolderColor(folder) {
    return folder.color || folder.tag?.color || '#8e8e93';
}

function createFolderPreviewTile(book) {
    const tile = document.createElement('div');
    tile.className = 'book-folder-cover-tile';
    if (book.coverPath) {
        const img = document.createElement('img');
        img.dataset.coverPath = book.coverPath;
        img.alt = '';
        img.loading = 'lazy';
        img.draggable = false;
        tile.appendChild(img);
    } else {
        tile.classList.add('placeholder');
        tile.textContent = getBookInitial(book.title);
    }
    return tile;
}

function getBookInitial(title) {
    const normalized = String(title || '').trim();
    return normalized ? normalized[0].toUpperCase() : '本';
}

function loadFolderPreviewCovers(root) {
    root.querySelectorAll('img[data-cover-path]').forEach(img => {
        img.draggable = false;
        invoke('get_cover_data', { coverPath: img.dataset.coverPath }).then(dataUrl => {
            if (dataUrl) img.src = dataUrl;
        });
    });
}

function getBookFolderByRef(ref) {
    if (!ref) return null;
    if (ref.type === 'manual') {
        const stack = manualBookStacks.find(s => s.id === ref.id);
        if (!stack) return null;
        const booksById = new Map(allBooks.map(book => [book.id, book]));
        const books = stack.bookIds.map(bookId => booksById.get(bookId)).filter(Boolean);
        if (books.length < 2) return null;
        return {
            id: stack.id,
            type: 'manual',
            name: stack.name,
            color: stack.color,
            stack,
            books: sortBooks([...books], currentSort),
        };
    }

    if (ref.type === 'tag') {
        const normalizedTagId = parseInt(String(ref.id).replace(/^tag-/, ''));
        const tag = allTags.find(t => t.id === normalizedTagId);
        if (!tag) return null;
        const books = allBooks.filter(book => {
            const mainTag = book.tags && book.tags.length > 0 ? book.tags[0] : null;
            return mainTag && mainTag.id === normalizedTagId;
        });
        if (books.length === 0) return null;
        return {
            id: `tag-${tag.id}`,
            type: 'tag',
            name: tag.name,
            color: tag.color,
            tag,
            books: sortBooks([...books], currentSort),
        };
    }
    return null;
}

function openBookFolder(folder) {
    activeBookFolderRef = {
        type: folder.type,
        id: folder.type === 'tag' ? folder.tag.id : folder.id,
    };
    let overlay = document.getElementById('book-folder-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'book-folder-overlay';
        overlay.className = 'book-folder-overlay';
        document.body.appendChild(overlay);
    }

    const renameButtonHtml = folder.type === 'manual' ? `
          <button class="book-folder-action book-folder-rename" type="button" title="名前を変更" aria-label="名前を変更">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </button>
    ` : '';

    overlay.innerHTML = `
      <div class="book-folder-panel" role="dialog" aria-modal="true" aria-labelledby="book-folder-title">
        <div class="book-folder-header">
          <div class="book-folder-heading">
            <span class="book-folder-dot" style="background:${getBookFolderColor(folder)}"></span>
            <div>
              <h3 id="book-folder-title">${escapeHtml(getBookFolderName(folder))}</h3>
              <span>${folder.books.length}冊</span>
            </div>
          </div>
          <div class="book-folder-actions">
            ${renameButtonHtml}
            <button class="book-folder-action book-folder-close" type="button" title="閉じる" aria-label="閉じる">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div class="book-folder-books"></div>
      </div>
    `;

    const booksGrid = overlay.querySelector('.book-folder-books');
    const folderCardSize = Math.max(110, Math.min(bookshelfCardSize, 180));
    booksGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${folderCardSize}px, 1fr))`;
    for (const book of folder.books) {
        const bookCard = createBookCard(book);
        if (folder.type === 'manual') {
            bookCard.dataset.stackId = folder.id;
            bookCard.dataset.stackOverlay = 'true';
        }
        bookCard.addEventListener('click', closeBookFolder);
        booksGrid.appendChild(bookCard);
    }

    overlay.querySelector('.book-folder-rename')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openStackRenameModal(folder.id);
    });
    overlay.querySelector('.book-folder-close').addEventListener('click', closeBookFolder);
    overlay.onclick = (e) => {
        if (e.target === overlay) closeBookFolder();
    };

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('active'));
}

function closeBookFolder() {
    const overlay = document.getElementById('book-folder-overlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.style.display = 'none';
    activeBookFolderRef = null;
}

function attachBookDragHandlers(card, book) {
    card.draggable = false;
    card.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.fav-btn-card')) return;
        startPointerBookDrag(e, card, book);
        const onMove = (moveEvent) => {
            if (!pointerBookDrag || pointerBookDrag.bookId !== book.id) return;
            const dx = moveEvent.clientX - pointerBookDrag.startX;
            const dy = moveEvent.clientY - pointerBookDrag.startY;
            if (!pointerBookDrag.dragging && Math.hypot(dx, dy) >= BOOK_STACK_DRAG_THRESHOLD) {
                beginPointerBookDrag(moveEvent);
            }
            updatePointerBookDrag(moveEvent);
            if (pointerBookDrag?.dragging) moveEvent.preventDefault();
        };
        const onUp = (upEvent) => {
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerup', onUp, true);
            document.removeEventListener('pointercancel', onCancel, true);
            finishPointerBookDrag(upEvent);
        };
        const onCancel = () => {
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerup', onUp, true);
            document.removeEventListener('pointercancel', onCancel, true);
            pointerBookDrag = null;
            cleanupPointerBookDrag();
        };
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onCancel, true);
    });
    card.addEventListener('dragstart', (e) => {
        if (!card.draggable) {
            e.preventDefault();
            return;
        }
        draggedBookId = book.id;
        card.classList.add('dragging');
        document.getElementById('drop-overlay')?.classList.remove('active');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-paperstock-book-id', String(book.id));
        e.dataTransfer.setData('text/plain', String(book.id));
    });
    card.addEventListener('dragend', () => {
        draggedBookId = null;
        suppressBookClickUntil = Date.now() + 250;
        document.querySelectorAll('.drop-target, .dragging').forEach(el => {
            el.classList.remove('drop-target', 'dragging');
        });
    });
    card.addEventListener('dragover', (e) => {
        if (!draggedBookId || draggedBookId === book.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => {
        card.classList.remove('drop-target');
    });
    card.addEventListener('drop', async (e) => {
        if (!draggedBookId || draggedBookId === book.id) return;
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('drop-target');
        await stackBookOntoBook(draggedBookId, book.id);
    });
}

function attachFolderDragHandlers(card, folder) {
    card.addEventListener('dragover', (e) => {
        if (!draggedBookId || folder.books.some(book => book.id === draggedBookId)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => {
        card.classList.remove('drop-target');
    });
    card.addEventListener('drop', async (e) => {
        if (!draggedBookId || folder.books.some(book => book.id === draggedBookId)) return;
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('drop-target');
        await stackBookIntoFolder(draggedBookId, folder);
    });
}

async function stackBookOntoBook(sourceBookId, targetBookId) {
    const sourceId = parseInt(sourceBookId);
    const targetId = parseInt(targetBookId);
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || sourceId === targetId) return;

    const targetStack = getManualStackContainingBook(targetId);
    if (targetStack) {
        moveBookToManualStack(sourceId, targetStack);
    } else {
        const sourceStack = getManualStackContainingBook(sourceId);
        if (sourceStack && sourceStack.bookIds.includes(targetId)) return;
        const targetBook = allBooks.find(book => book.id === targetId);
        createManualBookStack([targetId, sourceId], getSuggestedStackName(targetBook), getSuggestedStackColor(targetBook));
    }
    await refreshAfterManualStackChange();
}

async function stackBookIntoFolder(sourceBookId, folder) {
    const sourceId = parseInt(sourceBookId);
    if (!Number.isFinite(sourceId) || folder.books.some(book => book.id === sourceId)) return;

    if (folder.type === 'manual') {
        const stack = manualBookStacks.find(s => s.id === folder.id);
        if (stack) moveBookToManualStack(sourceId, stack);
    } else {
        createManualBookStack(
            [...folder.books.map(book => book.id), sourceId],
            getBookFolderName(folder),
            getBookFolderColor(folder)
        );
    }
    await refreshAfterManualStackChange();
}

function getManualStackContainingBook(bookId) {
    return manualBookStacks.find(stack => stack.bookIds.includes(parseInt(bookId))) || null;
}

function createManualBookStack(bookIds, name = 'スタック', color = '#8e8e93') {
    const uniqueBookIds = [...new Set(bookIds.map(id => parseInt(id)).filter(Number.isFinite))];
    if (uniqueBookIds.length < 2) return null;
    for (const bookId of uniqueBookIds) removeBookFromManualStacks(bookId, false);
    const stack = {
        id: `manual-${nextManualStackId++}`,
        name,
        color,
        bookIds: uniqueBookIds,
        createdAt: new Date().toISOString(),
    };
    manualBookStacks.push(stack);
    cleanupManualBookStacks();
    return stack;
}

function moveBookToManualStack(bookId, targetStack) {
    const normalizedBookId = parseInt(bookId);
    if (!Number.isFinite(normalizedBookId)) return;
    removeBookFromManualStacks(normalizedBookId, false);
    if (!targetStack.bookIds.includes(normalizedBookId)) targetStack.bookIds.push(normalizedBookId);
    cleanupManualBookStacks();
}

function removeBookFromManualStacks(bookId, shouldCleanup = true) {
    const normalizedBookId = parseInt(bookId);
    for (const stack of manualBookStacks) {
        stack.bookIds = stack.bookIds.filter(id => id !== normalizedBookId);
    }
    if (shouldCleanup) cleanupManualBookStacks();
}

function cleanupManualBookStacks() {
    manualBookStacks = manualBookStacks.filter(stack => stack.bookIds.length >= 2);
    persistManualBookStacks();
}

async function refreshAfterManualStackChange() {
    sanitizeManualBookStacks();
    persistManualBookStacks();
    await renderBooks();
    if (activeBookFolderRef) {
        const folder = getBookFolderByRef(activeBookFolderRef);
        if (folder) openBookFolder(folder);
        else closeBookFolder();
    }
}

function getSuggestedStackName() {
    return 'スタック';
}

function getSuggestedStackColor() {
    return '#8e8e93';
}

function isExternalFileDrag(e) {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes('Files');
}

function getPdfPathsFromDragPayload(payload) {
    const paths = Array.isArray(payload?.paths) ? payload.paths : [];
    return paths.filter(p => String(p).toLowerCase().endsWith('.pdf'));
}

function getDraggedBookIdFromEvent(e) {
    if (draggedBookId) return draggedBookId;
    let raw = '';
    try {
        raw = e.dataTransfer?.getData('application/x-paperstock-book-id')
            || e.dataTransfer?.getData('text/plain')
            || '';
    } catch (_e) { return null; }
    const parsed = parseInt(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

function getInternalBookDropTarget(e) {
    const hitElement = (Number.isFinite(e.clientX) && Number.isFinite(e.clientY))
        ? document.elementFromPoint(e.clientX, e.clientY)
        : e.target;
    const closest = hitElement?.closest?.('.book-card, .book-folder-card');
    if (!closest) return null;

    if (closest.classList.contains('book-folder-card')) {
        return {
            kind: 'folder',
            element: closest,
            folderType: closest.dataset.folderType,
            folderId: closest.dataset.folderRefId || closest.dataset.folderId,
        };
    }

    if (closest.classList.contains('book-card')) {
        const bookId = parseInt(closest.dataset.id);
        const sourceBookId = getDraggedBookIdFromEvent(e);
        if (!Number.isFinite(bookId) || bookId === sourceBookId) return null;
        return { kind: 'book', element: closest, bookId };
    }

    return null;
}

function getInternalBookDropTargetAt(clientX, clientY) {
    const hitElement = document.elementFromPoint(clientX, clientY);
    return getInternalBookDropTarget({
        target: hitElement,
        clientX,
        clientY,
        dataTransfer: { getData: () => String(draggedBookId || '') },
    });
}

function updateInternalDropTarget(e) {
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (!draggedBookId) return;
    const target = getInternalBookDropTarget(e);
    if (target?.element) target.element.classList.add('drop-target');
}

async function handleInternalBookDrop(e) {
    const sourceBookId = getDraggedBookIdFromEvent(e);
    if (!sourceBookId) return false;

    const target = getInternalBookDropTarget(e);
    e.preventDefault();
    e.stopPropagation();

    document.getElementById('drop-overlay')?.classList.remove('active');
    document.querySelectorAll('.drop-target, .dragging').forEach(el => {
        el.classList.remove('drop-target', 'dragging');
    });
    suppressBookClickUntil = Date.now() + 350;

    if (!target) return true;

    if (target.kind === 'book') {
        await stackBookOntoBook(sourceBookId, target.bookId);
    } else if (target.kind === 'folder') {
        const folder = getBookFolderByRef({ type: target.folderType, id: target.folderId });
        if (folder) await stackBookIntoFolder(sourceBookId, folder);
    }

    return true;
}

function startPointerBookDrag(e, card, book) {
    pointerBookDrag = {
        bookId: book.id,
        sourceEl: card,
        sourceStackId: card.dataset.stackId || null,
        sourceInStackOverlay: card.dataset.stackOverlay === 'true',
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        ghost: null,
    };
}

function beginPointerBookDrag(e) {
    if (!pointerBookDrag || pointerBookDrag.dragging) return;
    pointerBookDrag.dragging = true;
    draggedBookId = pointerBookDrag.bookId;
    suppressBookClickUntil = Date.now() + 500;
    document.getElementById('drop-overlay')?.classList.remove('active');
    pointerBookDrag.sourceEl.classList.add('dragging');

    const ghost = pointerBookDrag.sourceEl.cloneNode(true);
    ghost.className = 'book-drag-ghost';
    ghost.style.width = `${pointerBookDrag.sourceEl.offsetWidth}px`;
    ghost.style.height = `${pointerBookDrag.sourceEl.offsetHeight}px`;
    document.body.appendChild(ghost);
    pointerBookDrag.ghost = ghost;
    updatePointerBookDrag(e);
}

function updatePointerBookDrag(e) {
    if (!pointerBookDrag?.dragging) return;
    if (pointerBookDrag.ghost) {
        pointerBookDrag.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
    }
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    const target = getInternalBookDropTargetAt(e.clientX, e.clientY);
    if (target?.element) target.element.classList.add('drop-target');
}

async function finishPointerBookDrag(e) {
    if (!pointerBookDrag) return;
    const state = pointerBookDrag;
    pointerBookDrag = null;

    if (!state.dragging) return;

    const sourceBookId = state.bookId;
    const target = getInternalBookDropTargetAt(e.clientX, e.clientY);
    const shouldRemoveFromStack = isOutsideSourceStackPanelDrop(state, e.clientX, e.clientY);
    cleanupPointerBookDrag();
    suppressBookClickUntil = Date.now() + 500;

    if (shouldRemoveFromStack) {
        removeBookFromManualStacks(sourceBookId);
        await refreshAfterManualStackChange();
        return;
    }

    if (!target) return;
    if (target.kind === 'book') {
        await stackBookOntoBook(sourceBookId, target.bookId);
    } else if (target.kind === 'folder') {
        const folder = getBookFolderByRef({ type: target.folderType, id: target.folderId });
        if (folder) await stackBookIntoFolder(sourceBookId, folder);
    }
}

function isOutsideSourceStackPanelDrop(state, clientX, clientY) {
    if (!state?.sourceStackId || !state.sourceInStackOverlay) return false;
    const overlay = document.getElementById('book-folder-overlay');
    const panel = overlay?.querySelector('.book-folder-panel');
    if (!overlay || !panel || overlay.style.display === 'none') return false;
    const rect = panel.getBoundingClientRect();
    return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

function cleanupPointerBookDrag() {
    draggedBookId = null;
    document.getElementById('drop-overlay')?.classList.remove('active');
    document.querySelectorAll('.drop-target, .dragging').forEach(el => {
        el.classList.remove('drop-target', 'dragging');
    });
    if (pointerBookDrag?.ghost) pointerBookDrag.ghost.remove();
    document.querySelectorAll('.book-drag-ghost').forEach(el => el.remove());
}

function createBookCard(book) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.dataset.id = book.id;

    let coverHtml;
    if (book.coverPath) {
        coverHtml = `<img class="book-cover" data-cover-path="${escapeHtml(book.coverPath)}" alt="${escapeHtml(book.title)}" loading="lazy" draggable="false">`;
    } else {
        coverHtml = placeholderHtml(book.title);
    }

    const tagsHtml = book.tags.map(t =>
        `<span class="book-tag-badge" style="background:${t.color}">${escapeHtml(t.name)}</span>`
    ).join('');

    let statusHtml = '';
    if (book.status === 'reading') statusHtml = '<div class="status-badge reading">読書中</div>';
    else if (book.status === 'completed') statusHtml = '<div class="status-badge completed">読了</div>';

    const favHtml = `<button class="fav-btn-card ${book.favorite ? 'fav-active' : ''}" data-id="${book.id}" title="お気に入り">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${book.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
    </button>`;

    card.innerHTML = `
    <div class="book-cover-wrapper">${coverHtml}${statusHtml}${favHtml}</div>
    <div class="book-info">
      <div class="book-title">${escapeHtml(book.title)}</div>
      ${tagsHtml ? `<div class="book-tags">${tagsHtml}</div>` : ''}
    </div>
  `;

    card.querySelector('.fav-btn-card').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(book.id);
    });
    card.addEventListener('click', (e) => {
        if (Date.now() < suppressBookClickUntil) return;
        if (e.target.closest('.fav-btn-card')) return;
        openPdfTab(book.id);
    });
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault(); showContextMenu(e.clientX, e.clientY, book.id);
    });
    attachBookDragHandlers(card, book);

    // Lazy load cover image
    const coverImg = card.querySelector('img[data-cover-path]');
    if (coverImg) {
        coverImg.draggable = false;
        invoke('get_cover_data', { coverPath: book.coverPath }).then(dataUrl => {
            if (dataUrl) coverImg.src = dataUrl;
        });
    }

    return card;
}

function placeholderHtml(title) {
    return `<div class="book-cover-placeholder">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>
    <span>${escapeHtml(title)}</span>
  </div>`;
}

// ── Tags ─────────────────────────────────────────────
function renderTags() {
    const list = document.getElementById('tag-list');
    list.innerHTML = '';
    for (const tag of allTags) {
        const btn = document.createElement('button');
        btn.className = 'tag-item' + (currentFilter === 'tag' && currentTagId === tag.id ? ' active' : '');
        btn.innerHTML = `
      <span class="tag-dot" style="background:${tag.color}"></span>
      <span>${escapeHtml(tag.name)}</span>
      <span class="tag-item-actions">
        <button class="tag-action-btn" data-tag-action="edit" data-tag-id="${tag.id}" title="編集">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="tag-action-btn" data-tag-action="delete" data-tag-id="${tag.id}" title="削除">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </span>
    `;
        btn.addEventListener('click', (e) => {
            if (e.target.closest('[data-tag-action]')) return;
            setFilter('tag', tag.id, tag.name);
        });
        list.appendChild(btn);
    }
    list.querySelectorAll('[data-tag-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const tagId = parseInt(btn.dataset.tagId);
            if (btn.dataset.tagAction === 'edit') openTagModal(allTags.find(t => t.id === tagId));
            else if (btn.dataset.tagAction === 'delete') {
                await invoke('delete_tag', { id: tagId });
                await loadData(); renderTags();
                if (currentTagId === tagId) setFilter('all'); else renderBooks();
            }
        });
    });
}

function setFilter(type, tagId = null, tagName = '') {
    currentFilter = type;
    currentTagId = tagId;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.tag-item').forEach(n => n.classList.remove('active'));
    const titleEl = document.getElementById('view-title');
    const filterTitles = {
        'all': 'すべての本',
        'recent': '最近追加',
        'recent-opened': '最近読んだ本',
        'favorites': 'お気に入り',
        'status-unread': '未読',
        'status-reading': '読書中',
        'status-completed': '読了',
    };
    if (filterTitles[type]) {
        const navEl = document.getElementById(`nav-${type}`);
        if (navEl) navEl.classList.add('active');
        titleEl.textContent = filterTitles[type];
    } else if (type === 'tag') {
        titleEl.textContent = tagName;
        document.querySelectorAll('.tag-item').forEach(btn => {
            const dot = btn.querySelector('.tag-dot');
            if (dot && btn.textContent.includes(tagName)) btn.classList.add('active');
        });
    }
    renderBooks();
}

// ══════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════

function setupEventListeners() {
    document.getElementById('tab-bookshelf').addEventListener('click', () => activateTab('bookshelf'));
    document.getElementById('btn-add-books').addEventListener('click', addBooks);
    document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);
    listen('menu-add-books', () => { addBooks(); });
    listen('menu-close-tab', () => { if (activeTabId !== 'bookshelf') closeTab(activeTabId); });
    listen('system-resumed', () => scheduleResumeRecovery('system-resumed'));

    let searchTimeout;
    const searchInput = document.getElementById('search-input');
    const searchBox = searchInput.closest('.search-box');
    const searchClear = document.getElementById('search-clear');
    const updateSearchClearState = () => {
        searchBox.classList.toggle('has-value', searchInput.value.length > 0);
    };
    searchInput.addEventListener('input', () => {
        updateSearchClearState();
        clearTimeout(searchTimeout); searchTimeout = setTimeout(renderBooks, 200);
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && searchInput.value) {
            e.preventDefault();
            e.stopPropagation();
            searchInput.value = '';
            updateSearchClearState();
            renderBooks();
        }
    });
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        updateSearchClearState();
        renderBooks();
        searchInput.focus();
    });
    updateSearchClearState();

    document.getElementById('nav-all').addEventListener('click', () => setFilter('all'));
    document.getElementById('nav-recent').addEventListener('click', () => setFilter('recent'));
    document.getElementById('nav-recent-opened').addEventListener('click', () => setFilter('recent-opened'));
    document.getElementById('nav-favorites').addEventListener('click', () => setFilter('favorites'));
    document.getElementById('nav-status-unread').addEventListener('click', () => setFilter('status-unread'));
    document.getElementById('nav-status-reading').addEventListener('click', () => setFilter('status-reading'));
    document.getElementById('nav-status-completed').addEventListener('click', () => setFilter('status-completed'));
    document.getElementById('btn-add-tag').addEventListener('click', () => openTagModal());

    // Sort
    const sortSelect = document.getElementById('sort-select');
    sortSelect.value = currentSort;
    sortSelect.addEventListener('change', () => {
        currentSort = sortSelect.value;
        localStorage.setItem('ps-sort', currentSort);
        renderBooks();
    });

    // View mode toggle
    const viewBtns = ['btn-view-grid', 'btn-view-list'];
    function setViewMode(mode) {
        viewMode = mode;
        viewBtns.forEach(id => document.getElementById(id).classList.remove('active'));
        document.getElementById(`btn-view-${mode}`).classList.add('active');
        renderBooks();
    }
    document.getElementById('btn-view-grid').addEventListener('click', () => setViewMode('grid'));
    document.getElementById('btn-view-list').addEventListener('click', () => setViewMode('list'));

    // Drag and drop
    const main = document.getElementById('main-content');
    const dropOverlay = document.getElementById('drop-overlay');
    let dragCounter = 0;
    main.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (draggedBookId || !isExternalFileDrag(e)) {
            dropOverlay.classList.remove('active');
            return;
        }
        dragCounter++;
        dropOverlay.classList.add('active');
    });
    main.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (draggedBookId || !isExternalFileDrag(e)) {
            dropOverlay.classList.remove('active');
            return;
        }
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
    });
    main.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (draggedBookId || !isExternalFileDrag(e)) dropOverlay.classList.remove('active');
    });
    main.addEventListener('drop', (e) => {
        if (draggedBookId || getDraggedBookIdFromEvent(e)) {
            handleInternalBookDrop(e);
            return;
        }
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.classList.remove('active');
    });
    document.addEventListener('dragover', (e) => {
        if (!draggedBookId) return;
        e.preventDefault();
        updateInternalDropTarget(e);
        dropOverlay.classList.remove('active');
    }, true);
    document.addEventListener('drop', (e) => {
        if (!draggedBookId && !getDraggedBookIdFromEvent(e)) return;
        handleInternalBookDrop(e);
    }, true);
    // Tauri drag-and-drop API
    getCurrentWebviewWindow().onDragDropEvent(async (event) => {
        if (draggedBookId) {
            dragCounter = 0;
            dropOverlay.classList.remove('active');
            return;
        }
        const pdfPaths = getPdfPathsFromDragPayload(event.payload);
        if (event.payload.type === 'drop') {
            dragCounter = 0;
            dropOverlay.classList.remove('active');
            if (pdfPaths.length > 0) await importFiles(pdfPaths);
        } else if (event.payload.type === 'enter' || event.payload.type === 'over') {
            if (pdfPaths.length > 0) dropOverlay.classList.add('active');
            else dropOverlay.classList.remove('active');
        } else if (event.payload.type === 'leave' || event.payload.type === 'cancelled') {
            dragCounter = 0;
            dropOverlay.classList.remove('active');
        }
    });

    document.addEventListener('click', (e) => {
        hideContextMenu(); hideTabContextMenu();
        if (!e.target.closest('#comment-popup') && !e.target.closest('.comment-marker')) hideCommentPopup();
        if (!e.target.closest('#bookmark-dropdown') && !e.target.closest('.bookmark-btn-wrap')) hideBookmarkDropdown();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { hideContextMenu(); hideTabContextMenu(); hideCommentPopup(); closeAllModals(); }
    });

    document.querySelectorAll('#context-menu button').forEach(btn => {
        btn.addEventListener('click', () => handleContextAction(btn.dataset.action));
    });

    // Tag modal
    document.getElementById('tag-modal-close').addEventListener('click', closeAllModals);
    document.getElementById('tag-modal-cancel').addEventListener('click', closeAllModals);
    document.getElementById('tag-modal-save').addEventListener('click', saveTag);
    document.getElementById('tag-assign-close').addEventListener('click', closeAllModals);
    document.getElementById('tag-assign-done').addEventListener('click', async () => { closeAllModals(); await loadData(); renderBooks(); });
    document.getElementById('rename-modal-close').addEventListener('click', closeAllModals);
    document.getElementById('rename-cancel').addEventListener('click', closeAllModals);
    document.getElementById('rename-save').addEventListener('click', saveRename);
    document.getElementById('rename-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveRename(); });

    // Groups
    document.getElementById('btn-new-group').addEventListener('click', () => openGroupModal());
    document.getElementById('group-modal-close').addEventListener('click', closeAllModals);
    document.getElementById('group-modal-cancel').addEventListener('click', closeAllModals);
    document.getElementById('group-modal-save').addEventListener('click', saveGroup);
    document.getElementById('move-group-close').addEventListener('click', closeAllModals);

    document.querySelectorAll('#tab-context-menu button').forEach(btn => {
        btn.addEventListener('click', () => handleTabContextAction(btn.dataset.action));
    });

    // ── Bookshelf zoom slider ──
    const bsZoomSlider = document.getElementById('bookshelf-zoom');
    bsZoomSlider.addEventListener('input', () => {
        bookshelfCardSize = parseInt(bsZoomSlider.value);
        localStorage.setItem('ps-card-size', bookshelfCardSize);
        const grid = document.getElementById('book-grid');
        grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${bookshelfCardSize}px, 1fr))`;
        // Also update stack grids
        document.querySelectorAll('.stack-cards').forEach(sc => {
            sc.style.gridTemplateColumns = `repeat(auto-fill, minmax(${bookshelfCardSize}px, 1fr))`;
        });
    });

    // ── PDF viewer controls ──
    document.getElementById('btn-prev').addEventListener('click', () => viewerNavBySide('left'));
    document.getElementById('btn-next').addEventListener('click', () => viewerNavBySide('right'));
    document.getElementById('btn-zoom-in').addEventListener('click', viewerZoomIn);
    document.getElementById('btn-zoom-out').addEventListener('click', viewerZoomOut);
    document.getElementById('btn-fit').addEventListener('click', viewerFitCycle);
    document.getElementById('btn-spread').addEventListener('click', toggleSpreadMode);
    document.getElementById('btn-spread-direction').addEventListener('click', toggleSpreadDirection);
    document.getElementById('btn-scroll-dir').addEventListener('click', toggleScrollDirection);
    document.getElementById('btn-comment-mode').addEventListener('click', toggleCommentMode);
    document.getElementById('btn-thumbnails').addEventListener('click', viewerToggleThumbnails);

    // Viewer zoom slider
    const vzSlider = document.getElementById('viewer-zoom-slider');
    vzSlider.addEventListener('input', () => {
        const state = pdfStates[activeTabId];
        if (!state) return;
        state.scale = parseInt(vzSlider.value) / 100;
        state.fitMode = false;
        state.fitType = 'none';
        state.fitNeedsRecompute = false;
        updateFitButtonState(state);
        document.getElementById('zoom-level').textContent = vzSlider.value + '%';
        renderPdfPages(activeTabId);
        scheduleSaveBookState(activeTabId);
    });

    // Persist scroll position (debounced)
    document.getElementById('viewer-container').addEventListener('scroll', () => {
        if (activeTabId === 'bookshelf') return;
        const state = pdfStates[activeTabId];
        if (!state || !state.loaded) return;
        scheduleSaveBookState(activeTabId, 400);
    }, { passive: true });

    // Best-effort persist on app close: flush every open tab's state
    window.addEventListener('beforeunload', () => {
        persistTabState();
        for (const tabId of Object.keys(pdfStates)) {
            if (saveStateTimers[tabId]) clearTimeout(saveStateTimers[tabId]);
            saveBookState(tabId);
        }
    });

    // Rust owns both Cmd+Q and the window close button. Do not intercept
    // CloseRequested in JavaScript: it cannot acknowledge a dead WebView.
    listen('app-quit-requested', () => {
        prepareAppQuit().catch(error => console.warn('Failed to finish app quit:', error));
    });

    window.addEventListener('pageshow', () => scheduleResumeRecovery('pageshow'));
    window.addEventListener('focus', () => scheduleResumeRecovery('focus'));
    window.addEventListener('blur', () => schedulePdfBackgroundRelease(PDF_INACTIVE_EVICT_MS));
    window.addEventListener('paperstock-system-resumed', () => scheduleResumeRecovery('paperstock-system-resumed'));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scheduleResumeRecovery('visibilitychange');
        else {
            for (const state of Object.values(pdfStates)) {
                cancelPdfRendering(state);
                cancelThumbnailRendering(state);
            }
            schedulePdfBackgroundRelease();
        }
    });

    // Comment popup
    document.getElementById('comment-save').addEventListener('click', saveComment);
    document.getElementById('comment-cancel').addEventListener('click', hideCommentPopup);
    document.getElementById('comment-delete').addEventListener('click', deleteComment);

    // Bookmarks
    document.getElementById('btn-bookmark').addEventListener('click', toggleBookmark);
    document.getElementById('btn-bookmark-list').addEventListener('click', showBookmarkDropdown);

    const pageInput = document.getElementById('page-input');
    pageInput.addEventListener('change', () => {
        const state = pdfStates[activeTabId];
        if (!state) return;
        const num = parseInt(pageInput.value);
        if (num >= 1 && num <= state.totalPages) {
            state.currentPage = num;
            renderPdfPages(activeTabId);
            saveBookState(activeTabId);
        } else pageInput.value = state.currentPage;
    });
    pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pageInput.blur(); });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (activeTabId === 'bookshelf') return;

        const state = pdfStates[activeTabId];
        if (!state) return;

        if (state.scrollDir === 'horizontal') {
            switch (e.key) {
                case 'ArrowLeft': e.preventDefault(); viewerNavBySide('left'); break;
                case 'ArrowRight': e.preventDefault(); viewerNavBySide('right'); break;
                case 'ArrowUp': e.preventDefault(); viewerZoomIn(); break;
                case 'ArrowDown': e.preventDefault(); viewerZoomOut(); break;
            }
        } else {
            switch (e.key) {
                case 'ArrowLeft': e.preventDefault(); viewerNavBySide('left'); break;
                case 'ArrowRight': e.preventDefault(); viewerNavBySide('right'); break;
                case 'ArrowUp': e.preventDefault(); viewerNav(-1); break;
                case 'ArrowDown': e.preventDefault(); viewerNav(1); break;
            }
        }

        if (e.key === ' ') { e.preventDefault(); viewerNav(e.shiftKey ? -1 : 1); }
        if ((e.metaKey || e.ctrlKey) && e.key === '=') { e.preventDefault(); viewerZoomIn(); }
        if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); viewerZoomOut(); }
        if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); viewerFitCycle(); }
    });

    // Resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const state = pdfStates[activeTabId];
            if (state && state.fitMode && state.loaded) {
                const tabId = activeTabId;
                state.fitNeedsRecompute = true;
                renderPdfPages(tabId, true);
            }
        }, 200);
    });
}

// ── Add / Import Books ───────────────────────────────
async function addBooks() {
    const files = await invoke('select_pdf_files');
    if (files && files.length > 0) await importFiles(files);
}

async function importFiles(filePaths) {
    const overlay = document.createElement('div');
    overlay.className = 'import-overlay';
    overlay.innerHTML = `<div class="import-progress"><div class="loading-spinner-sm"></div><p id="import-status">インポート中… (0/${filePaths.length})</p></div>`;
    document.body.appendChild(overlay);
    for (let i = 0; i < filePaths.length; i++) {
        document.getElementById('import-status').textContent = `インポート中… (${i + 1}/${filePaths.length})`;
        try { await invoke('import_pdf', { filePath: filePaths[i] }); } catch (e) { console.error('Import failed:', filePaths[i], e); }
    }
    overlay.remove();
    pdfContentSearchCache.clear();
    await loadData(); renderBooks();
}

// ── Context Menu (books) ─────────────────────────────
function showContextMenu(x, y, bookId) {
    contextBookId = bookId;
    const menu = document.getElementById('context-menu');
    menu.style.display = 'block';
    menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
    // Highlight current status
    const book = allBooks.find(b => b.id === bookId);
    const status = book ? (book.status || 'unread') : 'unread';
    menu.querySelectorAll('.context-submenu button').forEach(btn => {
        const act = btn.dataset.action;
        btn.classList.toggle('active-status', act === 'status-' + status);
    });
}
function hideContextMenu() { document.getElementById('context-menu').style.display = 'none'; }

// ── Bookmarks ────────────────────────────────────────
async function toggleBookmark() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    const existing = state.bookmarks.find(b => b.pageNum === state.currentPage);
    if (existing) {
        await invoke('delete_bookmark', { id: existing.id });
        state.bookmarks = state.bookmarks.filter(b => b.id !== existing.id);
    } else {
        const bm = await invoke('add_bookmark', { data: { bookId: state.bookId, pageNum: state.currentPage, label: '栞' } });
        state.bookmarks.push(bm);
    }
    updateBookmarkButton();
    updateProgressBar(activeTabId);
}

function updateBookmarkButton() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    const btn = document.getElementById('btn-bookmark');
    const isBookmarked = state.bookmarks.some(b => b.pageNum === state.currentPage);
    btn.classList.toggle('active', isBookmarked);
    if (isBookmarked) {
        btn.querySelector('svg').setAttribute('fill', 'currentColor');
    } else {
        btn.querySelector('svg').setAttribute('fill', 'none');
    }
}

function showBookmarkDropdown() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    const dropdown = document.getElementById('bookmark-dropdown');
    const list = document.getElementById('bookmark-list');
    const empty = document.getElementById('bookmark-empty');
    list.innerHTML = '';

    if (state.bookmarks.length === 0) {
        empty.style.display = 'block';
    } else {
        empty.style.display = 'none';
        for (const bm of state.bookmarks) {
            const item = document.createElement('div');
            item.className = 'bookmark-item';

            // Render basic UI
            item.innerHTML = `
                <span class="bookmark-page">P.${bm.pageNum}</span>
                <span class="bookmark-label">${escapeHtml(bm.label || '栞')}</span>
                <button class="bookmark-delete" title="削除">×</button>
            `;

            // Navigation
            item.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-delete') || e.target.tagName === 'INPUT') return;
                state.currentPage = bm.pageNum;
                renderPdfPages(activeTabId);
                saveBookState(activeTabId);
                hideBookmarkDropdown();
            });

            // Delete
            item.querySelector('.bookmark-delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                await invoke('delete_bookmark', { id: bm.id });
                state.bookmarks = state.bookmarks.filter(b => b.id !== bm.id);
                showBookmarkDropdown();
                updateBookmarkButton();
            });

            // Inline Edit
            const labelEl = item.querySelector('.bookmark-label');
            labelEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const currentLabel = bm.label || '栞';
                labelEl.innerHTML = `<input type="text" class="bookmark-inline-input" value="${escapeHtml(currentLabel)}" />`;
                const input = labelEl.querySelector('input');

                const saveLabel = async () => {
                    const newLabel = input.value.trim() || '栞';
                    const updated = await invoke('update_bookmark', { id: bm.id, data: { label: newLabel } });
                    bm.label = updated.label;
                    showBookmarkDropdown();
                };

                input.addEventListener('blur', saveLabel);
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') {
                        input.blur();
                    } else if (ke.key === 'Escape') {
                        // Cancel
                        showBookmarkDropdown();
                    }
                });

                input.focus();
                input.select();
            });

            list.appendChild(item);
        }
    }

    const btn = document.getElementById('btn-bookmark-list');
    const rect = btn.getBoundingClientRect();
    dropdown.style.display = 'block';
    dropdown.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
    dropdown.style.top = (rect.bottom + 4) + 'px';
}

function hideBookmarkDropdown() {
    document.getElementById('bookmark-dropdown').style.display = 'none';
}

async function handleContextAction(action) {
    hideContextMenu();
    if (!contextBookId) return;
    switch (action) {
        case 'open': openPdfTab(contextBookId); break;
        case 'rename': openRenameModal(contextBookId); break;
        case 'status-unread':
        case 'status-reading':
        case 'status-completed': {
            const newStatus = action.replace('status-', '');
            await invoke('update_book', { id: contextBookId, updates: { status: newStatus } });
            await loadData(); renderBooks();
            break;
        }
        case 'set-cover': {
            const imagePath = await invoke('select_cover_image');
            if (imagePath) { await invoke('set_custom_cover', { bookId: contextBookId, imagePath }); await loadData(); renderBooks(); }
            break;
        }
        case 'manage-tags': openTagAssignModal(contextBookId); break;
        case 'show-in-finder': {
            const book = allBooks.find(b => b.id === contextBookId);
            if (book) invoke('show_in_finder', { filePath: book.filePath });
            break;
        }
        case 'delete': {
            await invoke('remove_book', { id: contextBookId });
            const tab = tabs.find(t => t.bookId === contextBookId);
            if (tab) closeTab(tab.id);
            await loadData(); renderBooks();
            break;
        }
    }
}

// ── Tab Context Menu ─────────────────────────────────
let contextTabId = null;
function showTabContextMenu(x, y, tabId) {
    contextTabId = tabId;
    const menu = document.getElementById('tab-context-menu');
    menu.style.display = 'block';
    menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
}
function hideTabContextMenu() { document.getElementById('tab-context-menu').style.display = 'none'; }

function handleTabContextAction(action) {
    hideTabContextMenu();
    if (!contextTabId) return;
    switch (action) {
        case 'close-tab': closeTab(contextTabId); break;
        case 'close-other-tabs': tabs.filter(t => t.id !== contextTabId).map(t => t.id).forEach(id => closeTab(id)); break;
        case 'move-to-group': openMoveToGroupModal(contextTabId); break;
        case 'remove-from-group': {
            const tab = tabs.find(t => t.id === contextTabId);
            if (tab) { tab.groupId = null; renderTabBar(); }
            break;
        }
    }
}

// ══════════════════════════════════════════════════════
//  MODALS
// ══════════════════════════════════════════════════════

let editingTagId = null;
let selectedTagColor = TAG_COLORS[0];

function openTagModal(tag = null) {
    editingTagId = tag ? tag.id : null;
    selectedTagColor = tag ? tag.color : TAG_COLORS[0];
    document.getElementById('tag-modal-title').textContent = tag ? 'タグを編集' : 'タグを追加';
    document.getElementById('tag-name-input').value = tag ? tag.name : '';
    renderColorPalette('color-palette', selectedTagColor, (c) => selectedTagColor = c);
    document.getElementById('tag-modal').style.display = 'flex';
    document.getElementById('tag-name-input').focus();
}

async function saveTag() {
    const name = document.getElementById('tag-name-input').value.trim();
    if (!name) return;
    if (editingTagId) await invoke('update_tag', { id: editingTagId, data: { name, color: selectedTagColor } });
    else await invoke('add_tag', { name, color: selectedTagColor });
    closeAllModals(); await loadData(); renderTags(); renderBooks();
}

function openTagAssignModal(bookId) {
    const book = allBooks.find(b => b.id === bookId);
    if (!book) return;
    const list = document.getElementById('tag-assign-list');
    list.innerHTML = '';
    for (const tag of allTags) {
        const isAssigned = book.tags.some(t => t.id === tag.id);
        const item = document.createElement('div');
        item.className = 'tag-assign-item';
        item.innerHTML = `
      <div class="tag-assign-checkbox ${isAssigned ? 'checked' : ''}"></div>
      <span class="tag-dot" style="background:${tag.color}"></span>
      <span class="tag-assign-name">${escapeHtml(tag.name)}</span>
    `;
        item.addEventListener('click', async () => {
            const checkbox = item.querySelector('.tag-assign-checkbox');
            const checked = checkbox.classList.toggle('checked');
            if (checked) await invoke('assign_tag', { bookId, tagId: tag.id });
            else await invoke('unassign_tag', { bookId, tagId: tag.id });
        });
        list.appendChild(item);
    }
    document.getElementById('tag-assign-modal').style.display = 'flex';
}

let renamingBookId = null;
let renamingStackId = null;
function openRenameModal(bookId) {
    renamingBookId = bookId;
    renamingStackId = null;
    const book = allBooks.find(b => b.id === bookId);
    if (!book) return;
    const input = document.getElementById('rename-input');
    document.getElementById('rename-modal-title').textContent = '名前を変更';
    input.placeholder = '新しいタイトル…';
    input.value = book.title;
    document.getElementById('rename-modal').style.display = 'flex';
    input.focus(); input.select();
}

function openStackRenameModal(stackId) {
    const stack = manualBookStacks.find(s => s.id === stackId);
    if (!stack) return;
    renamingBookId = null;
    renamingStackId = stack.id;
    const input = document.getElementById('rename-input');
    document.getElementById('rename-modal-title').textContent = 'スタック名を変更';
    input.placeholder = 'スタック名…';
    input.value = stack.name || 'スタック';
    document.getElementById('rename-modal').style.display = 'flex';
    input.focus(); input.select();
}

async function saveRename() {
    const name = document.getElementById('rename-input').value.trim();
    if (!name) return;

    if (renamingStackId) {
        const stackId = renamingStackId;
        const activeRef = activeBookFolderRef ? { ...activeBookFolderRef } : null;
        const stack = manualBookStacks.find(s => s.id === stackId);
        if (!stack) return;
        stack.name = name;
        persistManualBookStacks();
        renamingStackId = null;
        document.getElementById('rename-modal').style.display = 'none';
        await renderBooks();
        if (activeRef?.type === 'manual' && activeRef.id === stackId) {
            const folder = getBookFolderByRef(activeRef);
            if (folder) openBookFolder(folder);
        }
        return;
    }

    if (!renamingBookId) return;
    const bookId = renamingBookId;
    await invoke('update_book', { id: bookId, updates: { title: name } });
    closeAllModals();
    await loadData();
    await renderBooks();
    const tab = tabs.find(t => t.bookId === bookId);
    renamingBookId = null;
    if (tab) { tab.title = name; renderTabBar(); }
}

let editingGroupId = null;
let selectedGroupColor = TAG_COLORS[0];

function openGroupModal(group = null) {
    editingGroupId = group ? group.id : null;
    selectedGroupColor = group ? group.color : TAG_COLORS[0];
    document.getElementById('group-modal-title').textContent = group ? 'グループを編集' : '新しいグループ';
    document.getElementById('group-name-input').value = group ? group.name : '';
    renderColorPalette('group-color-palette', selectedGroupColor, (c) => selectedGroupColor = c);
    document.getElementById('group-modal').style.display = 'flex';
    document.getElementById('group-name-input').focus();
}

function saveGroup() {
    const name = document.getElementById('group-name-input').value.trim();
    if (!name) return;
    if (editingGroupId) {
        const group = tabGroups.find(g => g.id === editingGroupId);
        if (group) { group.name = name; group.color = selectedGroupColor; }
    } else {
        tabGroups.push({ id: nextGroupId++, name, color: selectedGroupColor, collapsed: false });
    }
    closeAllModals(); renderTabBar();
}

function openMoveToGroupModal(tabId) {
    const body = document.getElementById('move-group-list');
    body.innerHTML = '';
    for (const group of tabGroups) {
        const item = document.createElement('div');
        item.className = 'move-group-item';
        item.innerHTML = `<span class="tag-dot" style="background:${group.color}"></span> ${escapeHtml(group.name)}`;
        item.addEventListener('click', () => {
            const tab = tabs.find(t => t.id === tabId);
            if (tab) { tab.groupId = group.id; renderTabBar(); }
            closeAllModals();
        });
        body.appendChild(item);
    }
    if (tabGroups.length === 0) {
        body.innerHTML = '<p style="color: var(--text-tertiary); font-size: 13px; padding: 8px;">まずグループを作成してください</p>';
    }
    document.getElementById('move-group-modal').style.display = 'flex';
}

function renderColorPalette(elementId, selectedColor, onSelect) {
    const palette = document.getElementById(elementId);
    palette.innerHTML = TAG_COLORS.map(c =>
        `<div class="color-swatch ${c === selectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}"></div>`
    ).join('');
    palette.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            palette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
            onSelect(swatch.dataset.color);
        });
    });
}

function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    renamingBookId = null;
    renamingStackId = null;
    closeBookFolder();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Normalize a string for fuzzy title matching: NFKC fold (full-width → half-width),
// lowercase, strip all whitespace (including no-break spaces, ideographic spaces).
function normalizeForSearch(s) {
    if (!s) return '';
    return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}
