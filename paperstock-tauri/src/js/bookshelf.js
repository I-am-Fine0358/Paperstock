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
    try {
        // Tauri serves .mjs with wrong MIME type, so use fetch + blob URL workaround
        const resp = await fetch('./libs/pdf.mjs');
        const code = await resp.text();
        const blob = new Blob([code], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const module = await import(blobUrl);
        URL.revokeObjectURL(blobUrl);
        pdfjsLib = module;

        // Worker also needs blob URL workaround
        const wResp = await fetch('./libs/pdf.worker.mjs');
        const wCode = await wResp.text();
        const wBlob = new Blob([wCode], { type: 'application/javascript' });
        const wBlobUrl = URL.createObjectURL(wBlob);
        pdfjsLib.GlobalWorkerOptions.workerSrc = wBlobUrl;

        pdfjsReady = true;
    } catch (e) {
        console.error('Failed to initialize PDF.js:', e);
        pdfjsInitError = String(e.message || e);
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
    if (pdfStates[tabId]) {
        const state = pdfStates[tabId];
        // Cancel any pending debounced save and persist final state synchronously
        if (saveStateTimers[tabId]) { clearTimeout(saveStateTimers[tabId]); delete saveStateTimers[tabId]; }
        if (state.loaded && state.bookId) {
            try { await saveBookState(tabId); } catch (_e) { /* best-effort */ }
        }
        if (state.pdfDoc) state.pdfDoc.destroy();
        delete pdfStates[tabId];
    }
    tabs.splice(idx, 1);
    if (activeTabId === tabId) activateTab('bookshelf');
    renderTabBar();
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
        if (pagesContainer && pagesContainer.scrollHeight > 0) {
            updates.lastScrollY = viewerContainer.scrollTop / pagesContainer.scrollHeight;
        }
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
    for (const tabId of Object.keys(pdfStates)) {
        if (saveStateTimers[tabId]) {
            clearTimeout(saveStateTimers[tabId]);
            delete saveStateTimers[tabId];
        }
        await saveBookState(tabId);
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
    activeTabId = tabId;
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
        if (!pdfStates[tabId]) {
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

function showPdfTab(tabId) {
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

        // If fit calc was deferred (loaded while viewer was hidden), recompute
        // now that the container is laid out, then render.
        if (state.fitNeedsRecompute) {
            ensureFitScale(state).then(() => {
                if (activeTabId === tabId) renderPdfPages(tabId);
            });
        } else {
            renderPdfPages(tabId);
        }
    }
}

let resumeRecoveryTimer = null;
function scheduleResumeRecovery(_reason = 'resume') {
    clearTimeout(resumeRecoveryTimer);
    resumeRecoveryTimer = setTimeout(async () => {
        document.body.classList.add('resume-repaint');
        requestAnimationFrame(() => document.body.classList.remove('resume-repaint'));

        applyTheme();

        if (activeTabId === 'bookshelf') {
            try { await loadData(); } catch (e) { console.warn('Failed to refresh bookshelf after resume:', e); }
            renderBooks();
            renderTags();
            renderTabBar();
            return;
        }

        const state = pdfStates[activeTabId];
        if (!state) {
            activateTab(activeTabId);
            return;
        }

        if (state.loaded) {
            if (state.fitNeedsRecompute) {
                await ensureFitScale(state);
            }
            showPdfTab(activeTabId);
            renderPdfPages(activeTabId, true);
            return;
        }

        if (!state.loading) {
            const tab = tabs.find(t => t.id === activeTabId);
            const book = tab ? allBooks.find(b => b.id === tab.bookId) : null;
            if (book) loadPdfForTab(activeTabId, book);
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

async function ensureFitScale(state) {
    if (!state || !state.fitMode || !state.pdfDoc) return;
    const container = document.getElementById('viewer-container');
    if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) {
        state.fitNeedsRecompute = true;
        return;
    }
    try {
        const pageNum = Math.max(1, Math.min(state.currentPage || 1, state.totalPages || state.currentPage || 1));
        const page = await state.pdfDoc.getPage(pageNum);
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

async function loadPdfForTab(tabId, book) {
    // Guard against duplicate concurrent calls for the same tab (openPdfTab + activateTab lazy-load).
    if (pdfStates[tabId] && pdfStates[tabId].loading) return;

    const restoredZoom = book.lastZoom && book.lastZoom > 0 ? book.lastZoom : null;
    pdfStates[tabId] = {
        title: book.title,
        pdfDoc: null,
        currentPage: book.lastPage || 1,
        totalPages: 0,
        scale: restoredZoom || 1.0,
        fitMode: !restoredZoom, // if no saved zoom, use fit-to-width default
        fitType: restoredZoom ? 'none' : 'autoWidth',
        fitNeedsRecompute: !restoredZoom,
        thumbnailsOpen: false,
        loaded: false,
        loading: true,
        bookId: book.id,
        spreadMode: !!book.lastSpreadMode,
        spreadDirection: book.lastSpreadDirection === 0 ? 'ltr' : 'rtl',
        scrollDir: 'vertical',
        comments: [],
        bookmarks: [],
        pendingScrollY: book.lastScrollY || 0, // ratio 0-1, applied after first render
    };

    if (activeTabId === tabId) {
        document.getElementById('viewer-loading').style.display = 'flex';
        document.getElementById('viewer-title').textContent = book.title;
    }

    const loadingEl = document.getElementById('viewer-loading');
    const showStep = (msg) => { if (loadingEl) loadingEl.querySelector('p').textContent = msg; };

    if (!pdfjsReady) {
        showStep('PDF.js初期化中…');
        await initPdfJs();
        if (!pdfjsReady) {
            if (loadingEl) loadingEl.innerHTML = `<p style="color:#ff3b30">PDF.js初期化失敗</p><p style="color:#999;font-size:11px;max-width:500px;word-break:break-all;padding:0 20px">${pdfjsInitError}</p>`;
            return;
        }
    }

    try {
        showStep('PDF読み込み中…');
        const pdfUrl = await invoke('get_pdf_stream_url', { filePath: book.filePath });
        const doc = await pdfjsLib.getDocument({ url: pdfUrl }).promise;

        const state = pdfStates[tabId];
        if (!state) return;

        state.pdfDoc = doc;
        state.totalPages = doc.numPages;
        state.loaded = true;

        // Load comments & bookmarks
        state.comments = await invoke('get_comments', { bookId: book.id });
        state.bookmarks = await invoke('get_bookmarks', { bookId: book.id });

        // Compute fit-width only if container is visible right now; otherwise
        // showPdfTab will retry once the user switches back.
        await ensureFitScale(state);

        state.loading = false;
        if (activeTabId === tabId) showPdfTab(tabId);
    } catch (err) {
        console.error('Failed to load PDF:', err);
        if (pdfStates[tabId]) pdfStates[tabId].loading = false;
        if (pdfStates[tabId] && activeTabId === tabId) {
            const loading = document.getElementById('viewer-loading');
            loading.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <p style="color:#ff3b30">PDFの読み込みに失敗しました</p>
        <p style="color:#999;font-size:11px;max-width:400px;word-break:break-all">${String(err.message || err)}</p>
      `;
        }
    }
}

async function renderPdfPages(tabId, preserveScroll = false) {
    const state = pdfStates[tabId];
    if (!state || !state.pdfDoc || tabId !== activeTabId) return;

    // Safety net: never let an invalid scale through to PDF.js viewport math.
    if (!state.scale || state.scale <= 0 || !Number.isFinite(state.scale)) {
        state.scale = 1.0;
        state.fitNeedsRecompute = state.fitMode;
    }

    const pagesContainer = document.getElementById('viewer-pages');
    const viewerContainer = document.getElementById('viewer-container');

    // Save current scroll ratio if we want to preserve it
    let scrollRatioX = 0, scrollRatioY = 0;
    if (preserveScroll && pagesContainer.scrollWidth > 0 && pagesContainer.scrollHeight > 0) {
        scrollRatioX = viewerContainer.scrollLeft / pagesContainer.scrollWidth;
        scrollRatioY = viewerContainer.scrollTop / pagesContainer.scrollHeight;
    }

    hideCommentPopup();

    // Double-buffer: render new content offscreen first, then swap
    const buffer = document.createDocumentFragment();
    const tempHolder = document.createElement('div');
    tempHolder.style.position = 'absolute';
    tempHolder.style.visibility = 'hidden';
    tempHolder.style.pointerEvents = 'none';
    document.body.appendChild(tempHolder);

    if (state.spreadMode) {
        await renderSpreadView(tabId, tempHolder, state);
    } else {
        await renderSinglePage(tabId, tempHolder, state);
    }

    // Move rendered content to the buffer
    while (tempHolder.firstChild) {
        buffer.appendChild(tempHolder.firstChild);
    }
    document.body.removeChild(tempHolder);

    // Atomic swap: clear and insert in one go
    pagesContainer.innerHTML = '';
    pagesContainer.classList.toggle('spread', state.spreadMode);
    pagesContainer.classList.toggle('horizontal', state.scrollDir === 'horizontal');
    pagesContainer.appendChild(buffer);

    // UI controls
    document.getElementById('page-input').value = state.currentPage;
    document.getElementById('page-total').textContent = state.totalPages;
    document.getElementById('zoom-level').textContent = Math.round(state.scale * 100) + '%';
    updatePageNavigationState(state);

    if (preserveScroll && pagesContainer.scrollWidth > 0 && pagesContainer.scrollHeight > 0) {
        // Restore scroll position based on ratio
        viewerContainer.scrollLeft = scrollRatioX * pagesContainer.scrollWidth;
        viewerContainer.scrollTop = scrollRatioY * pagesContainer.scrollHeight;
    } else if (state.pendingScrollY && pagesContainer.scrollHeight > 0) {
        // Restore previously-saved scroll on first render after open
        viewerContainer.scrollTop = state.pendingScrollY * pagesContainer.scrollHeight;
        state.pendingScrollY = 0;
    } else {
        viewerContainer.scrollTop = 0;
        viewerContainer.scrollLeft = 0;
    }

    updateThumbnailHighlight(tabId);
    updateBookmarkButton();
    updateProgressBar(tabId);
}

async function renderSinglePage(tabId, container, state) {
    const wrapper = await createRenderedPage(state, state.currentPage, tabId);
    if (wrapper) container.appendChild(wrapper);
}

async function renderSpreadView(tabId, container, state) {
    // Page 1 alone (cover), then 2-3, 4-5, etc. Visual order follows binding direction.
    const startPage = getSpreadAnchorPage(state);
    if (startPage === 1) {
        const w = await createRenderedPage(state, 1, tabId);
        if (w) container.appendChild(w);
    } else {
        const pair = document.createElement('div');
        pair.className = 'spread-pair';
        const pageNums = [startPage];
        if (startPage + 1 <= state.totalPages) {
            pageNums.push(startPage + 1);
        }
        if (isRightBoundSpread(state)) {
            pageNums.reverse();
        }
        for (const pageNum of pageNums) {
            const wrapper = await createRenderedPage(state, pageNum, tabId);
            if (wrapper) pair.appendChild(wrapper);
        }
        container.appendChild(pair);
    }
}

async function createRenderedPage(state, pageNum, tabId) {
    try {
        const page = await state.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale });

        const wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.style.width = viewport.width + 'px';
        wrapper.style.height = viewport.height + 'px';
        wrapper.dataset.page = pageNum;

        const canvas = document.createElement('canvas');
        canvas.className = 'page-canvas';
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
        ctx.scale(dpr, dpr);
        wrapper.appendChild(canvas);

        await page.render({ canvasContext: ctx, viewport }).promise;

        if (nightMode) applyNightFilterToCanvas(canvas, ctx);

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

        return wrapper;
    } catch (err) {
        console.error('Render error page', pageNum, err);
        return null;
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

    await ensureFitScale(state);
    updateViewerZoomSlider(state);
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
    if (state.fitMode) {
        const tabId = activeTabId;
        state.fitNeedsRecompute = true;
        ensureFitScale(state).then(() => {
            if (activeTabId !== tabId || pdfStates[tabId] !== state) return;
            updateViewerZoomSlider(state);
            updateFitButtonState(state);
            renderPdfPages(tabId);
            saveBookState(tabId);
        });
    }
    else {
        renderPdfPages(activeTabId);
        saveBookState(activeTabId);
    }
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
        document.getElementById('thumbnail-list').innerHTML = '';
    }
}

async function generateThumbnails(tabId) {
    const state = pdfStates[tabId];
    if (!state || !state.pdfDoc) return;
    const list = document.getElementById('thumbnail-list');
    list.innerHTML = '';
    const max = Math.min(state.totalPages, 80);
    for (let i = 1; i <= max; i++) {
        const item = document.createElement('div');
        item.className = 'thumbnail-item' + (i === state.currentPage ? ' active' : '');
        item.dataset.page = i;
        const canvas = document.createElement('canvas');
        canvas.className = 'thumbnail-canvas';
        const label = document.createElement('span');
        label.className = 'thumbnail-label';
        label.textContent = i;
        item.appendChild(canvas);
        item.appendChild(label);
        list.appendChild(item);
        item.addEventListener('click', () => { state.currentPage = i; renderPdfPages(tabId); saveBookState(tabId); });
    }
    for (let i = 1; i <= max; i++) {
        const canvas = list.children[i - 1]?.querySelector('canvas');
        if (!canvas) continue;
        try {
            const page = await state.pdfDoc.getPage(i);
            const vp = page.getViewport({ scale: 0.2 });
            const dpr = 1;
            canvas.width = vp.width * dpr; canvas.height = vp.height * dpr;
            canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
            const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            if (nightMode) applyNightFilterToCanvas(canvas, ctx);
        } catch (e) { /* skip */ }
    }
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
    if (query) books = books.filter(b => normalizeForSearch(b.title).includes(query));

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

    let isClosingWindow = false;
    if (getCurrentWebviewWindow()?.onCloseRequested) {
        getCurrentWebviewWindow().onCloseRequested(async (event) => {
            if (isClosingWindow) return;
            event.preventDefault();
            isClosingWindow = true;

            const appWindow = getCurrentWebviewWindow();
            try {
                await flushOpenPdfState();
            } finally {
                try {
                    if (await appWindow.isFullscreen?.()) {
                        await appWindow.setFullscreen(false);
                    }
                } catch (_e) { /* best-effort before closing */ }

                try {
                    await invoke('quit_app');
                } catch (_e) {
                    if (appWindow.destroy) {
                        await appWindow.destroy();
                    } else {
                        await appWindow.close();
                    }
                }
            }
        });
    }

    window.addEventListener('pageshow', () => scheduleResumeRecovery('pageshow'));
    window.addEventListener('focus', () => scheduleResumeRecovery('focus'));
    window.addEventListener('paperstock-system-resumed', () => scheduleResumeRecovery('paperstock-system-resumed'));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scheduleResumeRecovery('visibilitychange');
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
                ensureFitScale(state).then(() => {
                    if (activeTabId !== tabId || pdfStates[tabId] !== state) return;
                    updateViewerZoomSlider(state);
                    updateFitButtonState(state);
                    renderPdfPages(tabId, true);
                });
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
