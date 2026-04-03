/* ══════════════════════════════════════════════════════
   Paperstock — PDF Viewer Logic (using PDF.js)
   ══════════════════════════════════════════════════════ */

let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let scale = 1.0;
let sidebarOpen = false;
let bookId = null;
let renderingInProgress = false;
let fitMode = false;
let pdfjsLib = null;

// ── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    bookId = parseInt(params.get('bookId'));

    if (!bookId) {
        showError('書籍IDが指定されていません');
        return;
    }

    setupEventListeners();
    await loadPdf();
});

async function loadPdf() {
    try {
        const book = await window.api.getBook(bookId);
        if (!book) {
            showError('書籍が見つかりません');
            return;
        }

        document.getElementById('viewer-title').textContent = book.title;
        document.title = `${book.title} — Paperstock`;

        // Load PDF.js
        await initPdfJs();

        const fileUrl = await window.api.getFileUrl(book.file_path);

        const loadingTask = pdfjsLib.getDocument({ url: fileUrl });
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        document.getElementById('page-total').textContent = totalPages;
        document.getElementById('page-input').max = totalPages;

        // Calculate fit-width scale
        await calculateFitScale();

        // Render first page
        await renderPage(currentPage);

        // Generate thumbnails (deferred)
        setTimeout(() => generateThumbnails(), 100);

        // Hide loading
        document.getElementById('viewer-loading').classList.add('hidden');
    } catch (err) {
        console.error('Failed to load PDF:', err);
        showError('PDFの読み込みに失敗しました: ' + err.message);
    }
}

function initPdfJs() {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '../node_modules/pdfjs-dist/legacy/build/pdf.js';
        script.onload = () => {
            pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
            if (!pdfjsLib) {
                // Fallback: check global
                for (const key of Object.keys(window)) {
                    if (key.includes('pdfjs') || key.includes('pdfjsLib')) {
                        pdfjsLib = window[key];
                        break;
                    }
                }
            }
            if (pdfjsLib) {
                pdfjsLib.GlobalWorkerOptions.workerSrc =
                    '../node_modules/pdfjs-dist/legacy/build/pdf.worker.js';
                resolve();
            } else {
                reject(new Error('PDF.js did not load correctly'));
            }
        };
        script.onerror = () => reject(new Error('Failed to load PDF.js script'));
        document.head.appendChild(script);
    });
}

// ── Render Page ──────────────────────────────────────
async function renderPage(pageNum) {
    if (renderingInProgress || !pdfDoc) return;
    renderingInProgress = true;

    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale });

        const container = document.getElementById('viewer-pages');
        container.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.style.width = viewport.width + 'px';
        wrapper.style.height = viewport.height + 'px';

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
        container.appendChild(wrapper);

        await page.render({
            canvasContext: ctx,
            viewport: viewport,
        }).promise;

        currentPage = pageNum;
        updatePageIndicator();
        updateThumbnailHighlight();

        document.getElementById('viewer-container').scrollTop = 0;
    } catch (err) {
        console.error('Render error:', err);
    }

    renderingInProgress = false;
}

async function calculateFitScale() {
    if (!pdfDoc) return;
    const page = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale: 1.0 });
    const container = document.getElementById('viewer-container');
    const containerWidth = container.clientWidth - 60;
    scale = containerWidth / viewport.width;
    fitMode = true;
    updateZoomDisplay();
}

// ── Thumbnails ───────────────────────────────────────
async function generateThumbnails() {
    const list = document.getElementById('thumbnail-list');
    list.innerHTML = '';

    // Limit concurrent rendering
    for (let i = 1; i <= Math.min(totalPages, 200); i++) {
        const item = document.createElement('div');
        item.className = 'thumbnail-item' + (i === currentPage ? ' active' : '');
        item.dataset.page = i;

        const canvas = document.createElement('canvas');
        canvas.className = 'thumbnail-canvas';

        const label = document.createElement('span');
        label.className = 'thumbnail-label';
        label.textContent = i;

        item.appendChild(canvas);
        item.appendChild(label);
        list.appendChild(item);

        item.addEventListener('click', () => goToPage(i));
    }

    // Render thumbnails in batches
    for (let i = 1; i <= Math.min(totalPages, 200); i++) {
        const canvas = list.children[i - 1]?.querySelector('canvas');
        if (canvas) await renderThumbnail(i, canvas);
    }
}

async function renderThumbnail(pageNum, canvas) {
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 0.25 });

        const dpr = window.devicePixelRatio || 1;
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
        // Silently fail for thumbnails
    }
}

function updateThumbnailHighlight() {
    document.querySelectorAll('.thumbnail-item').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.page) === currentPage);
    });

    const active = document.querySelector('.thumbnail-item.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Navigation ───────────────────────────────────────
function goToPage(num) {
    if (num < 1 || num > totalPages || num === currentPage) return;
    renderPage(num);
}

function prevPage() { if (currentPage > 1) goToPage(currentPage - 1); }
function nextPage() { if (currentPage < totalPages) goToPage(currentPage + 1); }

function updatePageIndicator() {
    document.getElementById('page-input').value = currentPage;
    document.getElementById('btn-prev').disabled = currentPage <= 1;
    document.getElementById('btn-next').disabled = currentPage >= totalPages;
}

// ── Zoom ─────────────────────────────────────────────
function zoomIn() {
    scale = Math.min(scale * 1.2, 5.0);
    fitMode = false;
    updateZoomDisplay();
    renderPage(currentPage);
}

function zoomOut() {
    scale = Math.max(scale * 0.8, 0.3);
    fitMode = false;
    updateZoomDisplay();
    renderPage(currentPage);
}

function fitWidth() {
    calculateFitScale().then(() => renderPage(currentPage));
}

function updateZoomDisplay() {
    document.getElementById('zoom-level').textContent = Math.round(scale * 100) + '%';
}

// ── Sidebar ──────────────────────────────────────────
function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    document.getElementById('viewer-sidebar').classList.toggle('open', sidebarOpen);
    document.getElementById('viewer-container').classList.toggle('sidebar-open', sidebarOpen);
}

// ── Event Listeners ──────────────────────────────────
function setupEventListeners() {
    document.getElementById('btn-back').addEventListener('click', () => window.close());
    document.getElementById('btn-prev').addEventListener('click', prevPage);
    document.getElementById('btn-next').addEventListener('click', nextPage);
    document.getElementById('btn-zoom-in').addEventListener('click', zoomIn);
    document.getElementById('btn-zoom-out').addEventListener('click', zoomOut);
    document.getElementById('btn-fit').addEventListener('click', fitWidth);
    document.getElementById('btn-sidebar').addEventListener('click', toggleSidebar);

    const pageInput = document.getElementById('page-input');
    pageInput.addEventListener('change', () => {
        const num = parseInt(pageInput.value);
        if (num >= 1 && num <= totalPages) goToPage(num);
        else pageInput.value = currentPage;
    });
    pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') pageInput.blur();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;

        switch (e.key) {
            case 'ArrowLeft':
            case 'ArrowUp':
                e.preventDefault(); prevPage(); break;
            case 'ArrowRight':
            case 'ArrowDown':
                e.preventDefault(); nextPage(); break;
            case ' ':
                e.preventDefault();
                if (e.shiftKey) prevPage(); else nextPage();
                break;
            case '+': case '=':
                if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomIn(); } break;
            case '-':
                if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomOut(); } break;
            case '0':
                if (e.metaKey || e.ctrlKey) { e.preventDefault(); fitWidth(); } break;
            case 'Escape':
                window.close(); break;
        }
    });

    // Resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (fitMode) calculateFitScale().then(() => renderPage(currentPage));
        }, 200);
    });
}

// ── Helpers ──────────────────────────────────────────
function showError(msg) {
    const loading = document.getElementById('viewer-loading');
    loading.innerHTML = `
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" stroke-width="1.5">
      <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
    <p style="color:#ff3b30">${msg}</p>
  `;
}
