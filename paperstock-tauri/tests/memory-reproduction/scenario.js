/* globals pdfStates, pdfjsReady, pdfjsLib, activeTabId, renderPdfPages, openPdfTab, activateTab */
(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, description, timeout = 30000) => {
        const start = Date.now();
        while (!fn()) {
            if (Date.now() - start > timeout) throw Error('Timeout: ' + description);
            await sleep(50);
        }
    };
    try {
        await until(() => pdfjsReady, 'PDF.js initialization');
        await sleep(500);
        const stats = window.testStats = {
            renderStarts: 0, renderFinishes: 0, renderCancellations: 0,
            renderActive: 0, renderPeak: 0, documentStarts: 0, documentDestroys: 0,
            documentCleanups: 0, loadingTaskDestroys: 0, pageCleanups: 0, renderErrors: [],
            maxAttachedCanvasPixels: 0, maxSingleCanvasPixels: 0,
        };
        const patchedPages = new WeakSet();
        const originalGetDocument = pdfjsLib.getDocument;
        pdfjsLib = {
            ...pdfjsLib,
            getDocument(options) {
                stats.documentStarts++;
                const task = originalGetDocument(options);
                const originalTaskDestroy = task.destroy.bind(task);
                task.destroy = (...args) => { stats.loadingTaskDestroys++; return originalTaskDestroy(...args); };
                task.promise.then(doc => {
                    for (const name of ['destroy', 'cleanup']) {
                        const original = doc[name].bind(doc);
                        doc[name] = (...args) => {
                            stats[name === 'destroy' ? 'documentDestroys' : 'documentCleanups']++;
                            return original(...args);
                        };
                    }
                    const originalGetPage = doc.getPage.bind(doc);
                    doc.getPage = async (...args) => {
                        const page = await originalGetPage(...args);
                        if (!patchedPages.has(page)) {
                            patchedPages.add(page);
                            const originalRender = page.render.bind(page);
                            const originalCleanup = page.cleanup.bind(page);
                            page.cleanup = (...values) => { stats.pageCleanups++; return originalCleanup(...values); };
                            page.render = (...values) => {
                                stats.renderStarts++;
                                stats.renderActive++;
                                stats.renderPeak = Math.max(stats.renderPeak, stats.renderActive);
                                const renderTask = originalRender(...values);
                                renderTask.promise.then(() => {
                                    stats.renderFinishes++;
                                    stats.renderActive--;
                                }, error => {
                                    stats.renderActive--;
                                    if (error.name === 'RenderingCancelledException') stats.renderCancellations++;
                                    else stats.renderErrors.push(String(error));
                                });
                                return renderTask;
                            };
                        }
                        return page;
                    };
                });
                return task;
            },
        };
        const measureCanvases = () => {
            const canvases = [...document.querySelectorAll('canvas')];
            const pixels = canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
            stats.maxAttachedCanvasPixels = Math.max(stats.maxAttachedCanvasPixels, pixels);
            for (const canvas of canvases) stats.maxSingleCanvasPixels = Math.max(stats.maxSingleCanvasPixels, canvas.width * canvas.height);
            return { canvasCount: canvases.length, canvasPixels: pixels };
        };
        const canvasTimer = setInterval(measureCanvases, 20);
        const snapshot = label => {
            testReport({
                kind: 'checkpoint', label, ...stats, ...measureCanvases(),
                activeTabId, dpr: devicePixelRatio, visibility: document.visibilityState,
                loadedDocuments: Object.values(pdfStates).filter(state => !!state.pdfDoc).length,
                stateCount: Object.keys(pdfStates).length,
                tabPages: Object.values(pdfStates).map(state => [state.bookId, state.currentPage, !!state.pdfDoc]),
                displayedPages: [...document.querySelectorAll('#viewer-pages .page-wrapper')].map(page => Number(page.dataset.page)),
                pageInputValue: Number(document.getElementById('page-input').value),
                renderedThumbnails: [...document.querySelectorAll('#thumbnail-list canvas')].filter(canvas => canvas.width > 0 && canvas.height > 0).length,
                textLayerChars: [...document.querySelectorAll('#viewer-pages .textLayer')].map(layer => layer.textContent.length),
            });
        };
        document.addEventListener('visibilitychange', () => snapshot('visibility-' + document.visibilityState));
        const settle = async () => {
            await sleep(150);
            await until(() => stats.renderActive === 0, 'render completion');
            await sleep(100);
        };
        const loaded = async () => {
            await until(() => document.visibilityState === 'visible', 'test window visible');
            await until(() => pdfStates[activeTabId]?.loaded && !pdfStates[activeTabId]?.loading, 'active PDF load');
            await settle();
        };
        const pagesPerBook = Math.min(24, Math.max(1, Number(new URLSearchParams(location.search).get('pages') || 6)));
        snapshot('baseline');
        for (let bookId = 1; bookId <= 3; bookId++) {
            openPdfTab(bookId);
            await loaded();
            for (let page = 1; page <= pagesPerBook; page++) {
                await until(() => document.visibilityState === 'visible', 'test window visible');
                pdfStates[activeTabId].currentPage = page;
                await renderPdfPages(activeTabId);
                if (page % 6 === 0) snapshot(`book-${bookId}-page-${page}`);
            }
            await settle();
            snapshot(`book-${bookId}-done`);
        }
        const active = pdfStates[activeTabId];
        active.scale = 3;
        active.fitMode = false;
        await renderPdfPages(activeTabId);
        await settle();
        snapshot('zoom-300-percent');
        const startsBeforeResume = stats.renderStarts;
        window.dispatchEvent(new CustomEvent('paperstock-system-resumed'));
        await sleep(500);
        await settle();
        testReport({ kind: 'resume-render-count', value: stats.renderStarts - startsBeforeResume });
        snapshot('resume');
        active.scale = 1;
        await renderPdfPages(activeTabId);
        // Burst work is bounded to eight pages; exposes concurrent detached buffers.
        const burst = [];
        for (let page = 8; page <= 15; page++) {
            active.currentPage = page;
            burst.push(renderPdfPages(activeTabId));
        }
        await Promise.all(burst);
        await settle();
        snapshot('burst-complete');
        active.thumbnailsOpen = true;
        document.getElementById('viewer-sidebar').classList.add('open');
        await generateThumbnails(activeTabId);
        await settle();
        snapshot('thumbnails');
        activateTab('bookshelf');
        await settle();
        snapshot('bookshelf');
        activateTab('pdf-1');
        await loaded();
        snapshot('reopen-first-tab');
        testReport({ kind: 'snapshot', label: 'before-hide' });
        testReport({ kind: 'hide' });
        setTimeout(() => snapshot('hidden-before-return'), 18000);
        await until(() => window.testWasHidden, 'native hide/show', 30000);
        await sleep(1000);
        await loaded();
        snapshot('after-hidden-20-seconds');
        const textLayer = document.querySelector('#viewer-pages .textLayer');
        if (textLayer) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(textLayer);
            selection.removeAllRanges();
            selection.addRange(range);
            testReport({ kind: 'text-selection', text: selection.toString() });
            selection.removeAllRanges();
        } else {
            testReport({ kind: 'text-selection', text: '', missingLayer: true });
        }
        testReport({ kind: 'snapshot', label: 'before-termination' });
        await sleep(500);
        clearInterval(canvasTimer);
        testReport({ kind: 'terminate-renderer' });
    } catch (error) {
        testReport({ kind: 'scenario-failed', message: String(error), stack: error.stack });
        testReport({ kind: 'finish' });
    }
})();
