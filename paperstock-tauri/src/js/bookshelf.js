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
let viewMode = 'grid'; // 'grid' | 'list' | 'stacks'
let currentSort = localStorage.getItem('ps-sort') || 'updated_at';
let sortAscending = localStorage.getItem('ps-sort-asc') === 'true';
let stacksExpanded = {}; // tagId -> boolean
let bookshelfCardSize = parseInt(localStorage.getItem('ps-card-size')) || 150;

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

// ── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    // Apply saved bookshelf card size
    const grid = document.getElementById('book-grid');
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${bookshelfCardSize}px, 1fr))`;
    document.getElementById('bookshelf-zoom').value = bookshelfCardSize;
    renderBooks();
    renderTags();
    renderTabBar();
    setupEventListeners();
    initPdfJs();
});

async function loadData() {
    allBooks = await invoke('get_books');
    allTags = await invoke('get_tags');
}

async function initPdfJs() {
    try {
        const module = await import('./libs/pdf.mjs');
        pdfjsLib = module;
        pdfjsLib.GlobalWorkerOptions.workerSrc = './libs/pdf.worker.mjs';
        pdfjsReady = true;
    } catch (e) {
        console.error('Failed to initialize PDF.js:', e);
    }
}

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
    book.last_opened_at = updates.lastOpenedAt;
    if (updates.status) book.status = updates.status;
    renderBooks();

    const tabId = 'pdf-' + nextTabId++;
    tabs.push({ id: tabId, type: 'pdf', bookId, title: book.title, groupId: null });
    activateTab(tabId);
    renderTabBar();
    loadPdfForTab(tabId, book);
}

function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    if (pdfStates[tabId]) {
        // Save last page before closing
        const state = pdfStates[tabId];
        if (state.loaded && state.bookId) {
            invoke('update_book', { id: state.bookId, updates: { lastPage: state.currentPage } });
            const book = allBooks.find(b => b.id === state.bookId);
            if (book) book.last_page = state.currentPage;
        }
        if (state.pdfDoc) state.pdfDoc.destroy();
        delete pdfStates[tabId];
    }
    tabs.splice(idx, 1);
    if (activeTabId === tabId) activateTab('bookshelf');
    renderTabBar();
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
    } else {
        bookshelfView.classList.remove('active');
        viewerView.classList.add('active');
        showPdfTab(tabId);
    }
}

function showPdfTab(tabId) {
    const state = pdfStates[tabId];
    if (!state) return;

    document.getElementById('viewer-title').textContent = state.title || '';
    document.getElementById('viewer-loading').style.display = state.loaded ? 'none' : 'flex';

    // Update toolbar toggle states
    document.getElementById('btn-spread').classList.toggle('active', state.spreadMode || false);
    document.getElementById('btn-comment-mode').classList.toggle('active', commentMode);

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
        document.getElementById('btn-prev').disabled = state.currentPage <= 1;
        document.getElementById('btn-next').disabled = state.currentPage >= state.totalPages;

        const sidebar = document.getElementById('viewer-sidebar');
        sidebar.classList.toggle('open', state.thumbnailsOpen || false);

        renderPdfPages(tabId);
    }
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

async function loadPdfForTab(tabId, book) {
    pdfStates[tabId] = {
        title: book.title,
        pdfDoc: null,
        currentPage: book.last_page || 1,
        totalPages: 0,
        scale: 1.0,
        fitMode: true,
        thumbnailsOpen: false,
        loaded: false,
        bookId: book.id,
        spreadMode: false,
        scrollDir: 'vertical', // 'vertical' | 'horizontal'
        comments: [],
        bookmarks: [],
    };

    if (activeTabId === tabId) {
        document.getElementById('viewer-loading').style.display = 'flex';
        document.getElementById('viewer-title').textContent = book.title;
    }

    if (!pdfjsReady) { await initPdfJs(); if (!pdfjsReady) return; }

    try {
        const pdfData = await invoke('read_pdf_file', { filePath: book.file_path });
        const data = new Uint8Array(pdfData);
        const doc = await pdfjsLib.getDocument({ data }).promise;

        const state = pdfStates[tabId];
        if (!state) return;

        state.pdfDoc = doc;
        state.totalPages = doc.numPages;
        state.loaded = true;

        // Load comments & bookmarks
        state.comments = await invoke('get_comments', { bookId: book.id });
        state.bookmarks = await invoke('get_bookmarks', { bookId: book.id });

        // Calculate fit-width scale
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });
        const container = document.getElementById('viewer-container');
        const containerWidth = container.clientWidth - 60;
        state.scale = containerWidth / viewport.width;

        if (activeTabId === tabId) showPdfTab(tabId);
    } catch (err) {
        console.error('Failed to load PDF:', err);
        if (pdfStates[tabId] && activeTabId === tabId) {
            const loading = document.getElementById('viewer-loading');
            loading.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <p style="color:#ff3b30">PDFの読み込みに失敗しました</p>
      `;
        }
    }
}

async function renderPdfPages(tabId, preserveScroll = false) {
    const state = pdfStates[tabId];
    if (!state || !state.pdfDoc || tabId !== activeTabId) return;

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
    document.getElementById('btn-prev').disabled = state.currentPage <= 1;
    document.getElementById('btn-next').disabled = state.currentPage >= state.totalPages;

    if (preserveScroll && pagesContainer.scrollWidth > 0 && pagesContainer.scrollHeight > 0) {
        // Restore scroll position based on ratio
        viewerContainer.scrollLeft = scrollRatioX * pagesContainer.scrollWidth;
        viewerContainer.scrollTop = scrollRatioY * pagesContainer.scrollHeight;
    } else {
        viewerContainer.scrollTop = 0;
        viewerContainer.scrollLeft = 0;
    }

    updateThumbnailHighlight(tabId);
    updateBookmarkButton();
}

async function renderSinglePage(tabId, container, state) {
    const wrapper = await createRenderedPage(state, state.currentPage, tabId);
    if (wrapper) container.appendChild(wrapper);
}

async function renderSpreadView(tabId, container, state) {
    // Page 1 alone (cover), then 2-3, 4-5, etc.
    let startPage = state.currentPage;
    // Align to spread: cover=1, then even-odd pairs
    if (startPage === 1) {
        const w = await createRenderedPage(state, 1, tabId);
        if (w) container.appendChild(w);
    } else {
        // Ensure even start for left page
        if (startPage % 2 === 1) startPage--;
        if (startPage < 2) startPage = 2;

        const pair = document.createElement('div');
        pair.className = 'spread-pair';
        const left = await createRenderedPage(state, startPage, tabId);
        if (left) pair.appendChild(left);
        if (startPage + 1 <= state.totalPages) {
            const right = await createRenderedPage(state, startPage + 1, tabId);
            if (right) pair.appendChild(right);
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
        const dpr = window.devicePixelRatio || 1;
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
        ctx.scale(dpr, dpr);
        wrapper.appendChild(canvas);

        await page.render({ canvasContext: ctx, viewport }).promise;

        // Add comment markers for this page
        const pageComments = (state.comments || []).filter(c => c.page_num === pageNum);
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
    popup.querySelector('.comment-popup-page').textContent = `ページ ${comment.page_num}`;
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

    if (state.spreadMode) {
        // In spread: page 1 alone, then pairs
        let cur = state.currentPage;
        if (delta > 0) {
            cur = cur === 1 ? 2 : cur + 2;
        } else {
            cur = cur <= 2 ? 1 : cur - 2;
        }
        state.currentPage = Math.max(1, Math.min(cur, state.totalPages));
    } else {
        state.currentPage = Math.max(1, Math.min(state.currentPage + delta, state.totalPages));
    }
    renderPdfPages(activeTabId, true);
    // Persist last page
    if (state.bookId) invoke('update_book', { id: state.bookId, updates: { lastPage: state.currentPage } });
}

function viewerSetZoom(newScale) {
    const state = pdfStates[activeTabId];
    if (!state) return;
    state.scale = Math.max(0.3, Math.min(newScale, 5.0));
    state.fitMode = false;
    updateViewerZoomSlider(state);
    renderPdfPages(activeTabId);
}

function viewerZoomIn() { const s = pdfStates[activeTabId]; if (s) viewerSetZoom(s.scale * 1.2); }
function viewerZoomOut() { const s = pdfStates[activeTabId]; if (s) viewerSetZoom(s.scale * 0.8); }

function updateViewerZoomSlider(state) {
    const pct = Math.round(state.scale * 100);
    document.getElementById('zoom-level').textContent = pct + '%';
    document.getElementById('viewer-zoom-slider').value = pct;
}

// fitState cycles: 'none' -> 'height' -> 'width' -> 'none'
let fitState = 'none';

async function viewerFitCycle() {
    const state = pdfStates[activeTabId];
    if (!state || !state.pdfDoc) return;
    const page = await state.pdfDoc.getPage(state.currentPage);
    const vp = page.getViewport({ scale: 1.0 });
    const container = document.getElementById('viewer-container');
    const padding = 8; // 4px each side
    const availW = container.clientWidth - padding;
    const availH = container.clientHeight - padding;
    const fitBtn = document.getElementById('btn-fit');

    if (fitState === 'none') {
        // Fit height
        let h = availH;
        if (state.spreadMode && state.currentPage === 1) h = availH;
        state.scale = h / vp.height;
        fitState = 'height';
        state.fitMode = true;
        fitBtn.title = '縦に合わせ中 (もう1回で横に合わせる)';
        fitBtn.classList.add('active');
    } else if (fitState === 'height') {
        // Fit width
        let w = availW;
        if (state.spreadMode && state.currentPage !== 1) w = (availW - 4) / 2;
        state.scale = w / vp.width;
        fitState = 'width';
        state.fitMode = true;
        fitBtn.title = '横に合わせ中 (もう1回で解除)';
    } else {
        // Back to manual
        fitState = 'none';
        state.fitMode = false;
        fitBtn.title = '縦に合わせる';
        fitBtn.classList.remove('active');
        return; // Don't re-render, just release fit mode
    }
    updateViewerZoomSlider(state);
    renderPdfPages(activeTabId);
}

function toggleSpreadMode() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    state.spreadMode = !state.spreadMode;
    document.getElementById('btn-spread').classList.toggle('active', state.spreadMode);
    if (state.fitMode) {
        // Re-apply the current fit mode with spread considered
        const prevFit = fitState;
        fitState = 'none'; // reset so cycle re-enters
        if (prevFit === 'height' || prevFit === 'width') {
            fitState = prevFit === 'height' ? 'none' : 'height';
            viewerFitCycle();
        } else { renderPdfPages(activeTabId); }
    }
    else renderPdfPages(activeTabId);
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
    if (state.thumbnailsOpen) generateThumbnails(activeTabId);
}

async function generateThumbnails(tabId) {
    const state = pdfStates[tabId];
    if (!state || !state.pdfDoc) return;
    const list = document.getElementById('thumbnail-list');
    list.innerHTML = '';
    const max = Math.min(state.totalPages, 200);
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
        item.addEventListener('click', () => { state.currentPage = i; renderPdfPages(tabId); });
    }
    for (let i = 1; i <= max; i++) {
        const canvas = list.children[i - 1]?.querySelector('canvas');
        if (!canvas) continue;
        try {
            const page = await state.pdfDoc.getPage(i);
            const vp = page.getViewport({ scale: 0.2 });
            const dpr = window.devicePixelRatio || 1;
            canvas.width = vp.width * dpr; canvas.height = vp.height * dpr;
            canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
            const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
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
        books = books.filter(b => b.last_opened_at);
        books.sort((a, b) => (b.last_opened_at || '').localeCompare(a.last_opened_at || ''));
    } else if (currentFilter === 'status-unread') {
        books = books.filter(b => b.status === 'unread');
    } else if (currentFilter === 'status-reading') {
        books = books.filter(b => b.status === 'reading');
    } else if (currentFilter === 'status-completed') {
        books = books.filter(b => b.status === 'completed');
    }

    // Search
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    if (query) books = books.filter(b => b.title.toLowerCase().includes(query));

    // Sort (skip for recent-opened which has its own sort)
    if (currentFilter !== 'recent-opened') {
        books = sortBooks(books, currentSort);
    }

    countEl.textContent = books.length > 0 ? `${books.length}冊` : '';

    if (books.length === 0) {
        grid.style.display = 'none';
        emptyState.style.display = 'flex';
        return;
    }

    emptyState.style.display = 'none';

    if (viewMode === 'stacks' && allTags.length > 0) {
        grid.style.display = 'grid';
        await renderStacksView(grid, books);
    } else if (viewMode === 'list') {
        grid.style.display = 'block';
        await renderListView(grid, books);
    } else {
        grid.style.display = 'grid';
        await renderGridView(grid, books);
    }
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
                cmp = (a.created_at || '').localeCompare(b.created_at || '');
                break;
            case 'page_count':
                cmp = (a.page_count || 0) - (b.page_count || 0);
                break;
            case 'status': {
                const order = { reading: 0, unread: 1, completed: 2 };
                cmp = (order[a.status] ?? 1) - (order[b.status] ?? 1);
                break;
            }
            case 'updated_at':
            default:
                cmp = (a.updated_at || '').localeCompare(b.updated_at || '');
                break;
        }
        return cmp * dir;
    });
}

async function renderGridView(grid, books) {
    const fragment = document.createDocumentFragment();

    for (const book of books) {
        fragment.appendChild(await createBookCard(book));
    }
    grid.innerHTML = '';
    grid.appendChild(fragment);
}

async function renderStacksView(grid, books) {
    grid.innerHTML = '';

    // Group books by tags
    const taggedGroups = {};
    const untagged = [];

    for (const book of books) {
        if (book.tags.length === 0) { untagged.push(book); continue; }
        const mainTag = book.tags[0];
        if (!taggedGroups[mainTag.id]) taggedGroups[mainTag.id] = { tag: mainTag, books: [] };
        taggedGroups[mainTag.id].books.push(book);
    }

    // Render each tag group as a stack
    for (const group of Object.values(taggedGroups)) {
        const stackEl = document.createElement('div');
        stackEl.className = 'stack-group';
        const isExpanded = stacksExpanded[group.tag.id] !== false; // Default expanded

        const header = document.createElement('div');
        header.className = 'stack-header' + (isExpanded ? '' : ' collapsed');
        header.innerHTML = `
      <svg class="stack-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      <span class="stack-dot" style="background:${group.tag.color}"></span>
      <span class="stack-name">${escapeHtml(group.tag.name)}</span>
      <span class="stack-count">${group.books.length}冊</span>
    `;
        header.addEventListener('click', () => {
            stacksExpanded[group.tag.id] = !isExpanded;
            renderBooks();
        });
        stackEl.appendChild(header);

        if (isExpanded) {
            const cards = document.createElement('div');
            cards.className = 'stack-cards';
            cards.style.display = 'grid';
            cards.style.gridTemplateColumns = `repeat(auto-fill, minmax(${bookshelfCardSize}px, 1fr))`;
            cards.style.gap = '20px';
            for (const book of group.books) {
                cards.appendChild(await createBookCard(book));
            }
            stackEl.appendChild(cards);
        } else {
            // Collapsed: show fanned preview
            const preview = document.createElement('div');
            preview.className = 'stack-collapsed-preview';
            const previewBooks = group.books.slice(0, 3);
            for (const book of previewBooks) {
                const cover = document.createElement('div');
                cover.className = 'stacked-cover';
                if (book.cover_path) {
                    const dataUrl = await invoke('get_cover_data', { coverPath: book.cover_path });
                    if (dataUrl) cover.innerHTML = `<img src="${dataUrl}" alt="">`;
                }
                preview.appendChild(cover);
            }
            const info = document.createElement('div');
            info.className = 'stack-collapsed-info';
            info.innerHTML = `<div class="stack-name">${escapeHtml(group.tag.name)}</div><div class="stack-count">${group.books.length}冊</div>`;
            preview.appendChild(info);
            preview.addEventListener('click', () => {
                stacksExpanded[group.tag.id] = true;
                renderBooks();
            });
            stackEl.appendChild(preview);
        }

        grid.appendChild(stackEl);
    }

    // Untagged books
    if (untagged.length > 0) {
        const stackEl = document.createElement('div');
        stackEl.className = 'stack-group';
        const isExpanded = stacksExpanded['untagged'] !== false;
        const header = document.createElement('div');
        header.className = 'stack-header' + (isExpanded ? '' : ' collapsed');
        header.innerHTML = `
      <svg class="stack-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      <span class="stack-dot" style="background:#8e8e93"></span>
      <span class="stack-name">タグなし</span>
      <span class="stack-count">${untagged.length}冊</span>
    `;
        header.addEventListener('click', () => {
            stacksExpanded['untagged'] = !isExpanded;
            renderBooks();
        });
        stackEl.appendChild(header);

        if (isExpanded) {
            const cards = document.createElement('div');
            cards.className = 'stack-cards';
            cards.style.display = 'grid';
            cards.style.gridTemplateColumns = `repeat(auto-fill, minmax(${bookshelfCardSize}px, 1fr))`;
            cards.style.gap = '20px';
            for (const book of untagged) cards.appendChild(await createBookCard(book));
            stackEl.appendChild(cards);
        }

        grid.appendChild(stackEl);
    }
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

async function renderListView(grid, books) {
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
        const dateStr = book.updated_at ? new Date(book.updated_at).toLocaleDateString('ja-JP') : '';
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
            <span class="list-col-pages">${book.page_count || '-'}</span>
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
    renderBooks();
}

async function createBookCard(book) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.dataset.id = book.id;

    let coverHtml;
    if (book.cover_path) {
        const dataUrl = await invoke('get_cover_data', { coverPath: book.cover_path });
        coverHtml = dataUrl
            ? `<img class="book-cover" src="${dataUrl}" alt="${escapeHtml(book.title)}" loading="lazy">`
            : placeholderHtml(book.title);
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
        if (e.target.closest('.fav-btn-card')) return;
        openPdfTab(book.id);
    });
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault(); showContextMenu(e.clientX, e.clientY, book.id);
    });
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
    listen('menu-add-books', () => { addBooks(); });
    listen('menu-close-tab', () => { if (activeTabId !== 'bookshelf') closeTab(activeTabId); });

    let searchTimeout;
    document.getElementById('search-input').addEventListener('input', () => {
        clearTimeout(searchTimeout); searchTimeout = setTimeout(renderBooks, 200);
    });

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
    const viewBtns = ['btn-view-grid', 'btn-view-list', 'btn-view-stacks'];
    function setViewMode(mode) {
        viewMode = mode;
        viewBtns.forEach(id => document.getElementById(id).classList.remove('active'));
        document.getElementById(`btn-view-${mode}`).classList.add('active');
        renderBooks();
    }
    document.getElementById('btn-view-grid').addEventListener('click', () => setViewMode('grid'));
    document.getElementById('btn-view-list').addEventListener('click', () => setViewMode('list'));
    document.getElementById('btn-view-stacks').addEventListener('click', () => setViewMode('stacks'));

    // Drag and drop
    const main = document.getElementById('main-content');
    const dropOverlay = document.getElementById('drop-overlay');
    let dragCounter = 0;
    main.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropOverlay.classList.add('active'); });
    main.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); } });
    main.addEventListener('dragover', (e) => e.preventDefault());
    main.addEventListener('drop', (e) => {
        e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('active');
    });
    // Tauri drag-and-drop API
    getCurrentWebviewWindow().onDragDropEvent(async (event) => {
        if (event.payload.type === 'drop') {
            const pdfPaths = event.payload.paths.filter(p => p.toLowerCase().endsWith('.pdf'));
            if (pdfPaths.length > 0) await importFiles(pdfPaths);
        } else if (event.payload.type === 'enter') {
            dropOverlay.classList.add('active');
        } else if (event.payload.type === 'leave') {
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
    document.getElementById('btn-prev').addEventListener('click', () => viewerNav(-1));
    document.getElementById('btn-next').addEventListener('click', () => viewerNav(1));
    document.getElementById('btn-zoom-in').addEventListener('click', viewerZoomIn);
    document.getElementById('btn-zoom-out').addEventListener('click', viewerZoomOut);
    document.getElementById('btn-fit').addEventListener('click', viewerFitCycle);
    document.getElementById('btn-spread').addEventListener('click', toggleSpreadMode);
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
        fitState = 'none';
        document.getElementById('btn-fit').classList.remove('active');
        document.getElementById('btn-fit').title = '縦に合わせる';
        document.getElementById('zoom-level').textContent = vzSlider.value + '%';
        renderPdfPages(activeTabId);
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
        if (num >= 1 && num <= state.totalPages) { state.currentPage = num; renderPdfPages(activeTabId); }
        else pageInput.value = state.currentPage;
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
                case 'ArrowLeft': e.preventDefault(); viewerNav(-1); break;
                case 'ArrowRight': e.preventDefault(); viewerNav(1); break;
                case 'ArrowUp': e.preventDefault(); viewerZoomIn(); break;
                case 'ArrowDown': e.preventDefault(); viewerZoomOut(); break;
            }
        } else {
            switch (e.key) {
                case 'ArrowLeft': e.preventDefault(); viewerNav(-1); break;
                case 'ArrowRight': e.preventDefault(); viewerNav(1); break;
                case 'ArrowUp': e.preventDefault(); viewerNav(-1); break;
                case 'ArrowDown': e.preventDefault(); viewerNav(1); break;
            }
        }

        if (e.key === ' ') { e.preventDefault(); viewerNav(e.shiftKey ? -1 : 1); }
        if ((e.metaKey || e.ctrlKey) && e.key === '=') { e.preventDefault(); viewerZoomIn(); }
        if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); viewerZoomOut(); }
        if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); fitState = 'none'; viewerFitCycle(); }
    });

    // Resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const state = pdfStates[activeTabId];
            if (state && state.fitMode && state.loaded) {
                const prev = fitState;
                fitState = prev === 'height' ? 'none' : 'height';
                viewerFitCycle();
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
    const existing = state.bookmarks.find(b => b.page_num === state.currentPage);
    if (existing) {
        await invoke('delete_bookmark', { id: existing.id });
        state.bookmarks = state.bookmarks.filter(b => b.id !== existing.id);
    } else {
        const bm = await invoke('add_bookmark', { data: { bookId: state.bookId, pageNum: state.currentPage, label: '栞' } });
        state.bookmarks.push(bm);
    }
    updateBookmarkButton();
}

function updateBookmarkButton() {
    const state = pdfStates[activeTabId];
    if (!state) return;
    const btn = document.getElementById('btn-bookmark');
    const isBookmarked = state.bookmarks.some(b => b.page_num === state.currentPage);
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
                <span class="bookmark-page">P.${bm.page_num}</span>
                <span class="bookmark-label">${escapeHtml(bm.label || '栞')}</span>
                <button class="bookmark-delete" title="削除">×</button>
            `;

            // Navigation
            item.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-delete') || e.target.tagName === 'INPUT') return;
                state.currentPage = bm.page_num;
                renderPdfPages(activeTabId);
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
            if (book) invoke('show_in_finder', { filePath: book.file_path });
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
function openRenameModal(bookId) {
    renamingBookId = bookId;
    const book = allBooks.find(b => b.id === bookId);
    if (!book) return;
    document.getElementById('rename-input').value = book.title;
    document.getElementById('rename-modal').style.display = 'flex';
    const input = document.getElementById('rename-input');
    input.focus(); input.select();
}

async function saveRename() {
    const title = document.getElementById('rename-input').value.trim();
    if (!title || !renamingBookId) return;
    await invoke('update_book', { id: renamingBookId, updates: { title } });
    closeAllModals(); await loadData(); renderBooks();
    const tab = tabs.find(t => t.bookId === renamingBookId);
    if (tab) { tab.title = title; renderTabBar(); }
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

function closeAllModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none'); }

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
