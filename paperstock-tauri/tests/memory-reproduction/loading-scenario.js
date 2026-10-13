/* globals pdfStates, pdfjsLib, activeTabId, tabs, initializePdfJs, activateTab, openPdfTab, closeTab */
// Separate from the synthetic memory benchmark: no page-count or text-content
// assumptions, and startup is observed before production DOMContentLoaded runs.
(async () => {
    const query = new URLSearchParams(location.search);
    const selectedCase = query.get('loadingCase') || 'all';
    const expectedPage = Number(query.get('startPage') || 1);
    const expectedZoom = Number(query.get('startZoom') || 1);
    const restoredCount = Number(query.get('restoredTabs') || 3);
    const timeout = Number(query.get('loadTimeoutMs') || 60000);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const docIds = new WeakMap();
    const patchedPages = new WeakSet();
    const completedPages = new Set();
    const stats = { documentStarts: 0, documentReady: 0, documentRejected: 0,
        destroyStarts: 0, destroyFinishes: 0, destroyUnderlyingFinishes: 0, renderStarts: 0, renderFinishes: 0,
        renderActive: 0, renderPeak: 0, renderErrors: 0, nativeWorkerTerminates: 0,
        pendingFetchAborts: 0, terminateAcksWithheld: 0, terminateSends: 0,
        terminateResolves: 0, terminateRejects: 0, pageDestroyStarts: 0, pageDestroyFinishes: 0 };
    let nextDocId = 0;
    let nextFault = null;
    let nextRenderStart = null;
    let nextFetchGate = null;
    let nextFetchId = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const inputUrl = input instanceof Request ? input.url : String(input);
        const url = new URL(inputUrl, location.href);
        if (url.pathname !== '/fixture.pdf') return nativeFetch(input, init);
        const id = ++nextFetchId;
        const signal = init?.signal || (input instanceof Request ? input.signal : null);
        let responseReceived = false;
        let gate = url.searchParams.get('testGate');
        if (nextFetchGate) {
            gate = nextFetchGate;
            nextFetchGate = null;
            url.searchParams.set('testGate', gate);
            input = input instanceof Request ? new Request(url.href, input) : url.href;
        }
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        testReport({ kind: 'loading-fetch', phase: 'start', requestId: id, hasSignal: !!signal,
            gated: !!gate, range: headers.get('Range') });
        signal?.addEventListener('abort', () => {
            if (!responseReceived && gate === 'terminate-stall-range') stats.pendingFetchAborts++;
            testReport({ kind: 'loading-fetch', phase: 'abort', requestId: id, responseReceived, gated: !!gate });
        }, { once: true });
        try {
            const response = await nativeFetch(input, init);
            responseReceived = true;
            testReport({ kind: 'loading-fetch', phase: 'response', requestId: id, status: response.status });
            return response;
        } catch (error) {
            testReport({ kind: 'loading-fetch', phase: 'rejected', requestId: id, errorName: error.name });
            throw error;
        }
    };
    const terminateWorker = Worker.prototype.terminate;
    Worker.prototype.terminate = function (...args) {
        stats.nativeWorkerTerminates++;
        testReport({ kind: 'loading-phase', phase: 'native-worker-terminate' });
        return terminateWorker.apply(this, args);
    };
    const until = async (condition, description, limit = timeout) => {
        const start = Date.now();
        while (!await condition()) {
            if (Date.now() - start > limit) throw Error(`Timeout: ${description}`);
            await sleep(50);
        }
    };
    const patchPdfJs = () => {
        const getDocument = pdfjsLib.getDocument;
        pdfjsLib = { ...pdfjsLib, getDocument(options) {
            const id = ++nextDocId;
            const fault = nextFault;
            nextFault = null;
            stats.documentStarts++;
            testReport({ kind: 'loading-phase', phase: 'getDocument', documentId: id });
            const task = getDocument(options);
            const originalPromise = task.promise;
            if (fault === 'load-stall') {
                // Artificial transport fault: the real PDF.js document still
                // exists, but the application's load promise never settles.
                Object.defineProperty(task, 'promise', { value: new Promise(() => {}) });
                testReport({ kind: 'loading-fault', fault, documentId: id });
            }
            const destroy = task.destroy.bind(task);
            task.destroy = (...args) => {
                stats.destroyStarts++;
                testReport({ kind: 'loading-phase', phase: 'destroy-start', documentId: id });
                let result = Promise.resolve(destroy(...args)).then(value => {
                    stats.destroyUnderlyingFinishes++;
                    if (fault === 'destroy-stall') {
                        // Release the real worker, then withhold only the return
                        // promise. This never leaves a rogue test worker running.
                        testReport({ kind: 'loading-fault', fault, phase: 'underlying-destroy-complete', documentId: id });
                        return new Promise(() => {});
                    }
                    return value;
                });
                return result.finally(() => {
                    stats.destroyFinishes++;
                    testReport({ kind: 'loading-phase', phase: 'destroy-finish', documentId: id });
                });
            };
            originalPromise.then(doc => {
                stats.documentReady++;
                docIds.set(doc, id);
                const handler = task._transport.messageHandler;
                const send = handler.sendWithPromise.bind(handler);
                handler.sendWithPromise = (name, ...args) => {
                    if (name !== 'Terminate') return send(name, ...args);
                    stats.terminateSends++;
                    testReport({ kind: 'loading-phase', phase: 'Terminate-send', documentId: id });
                    if (fault === 'terminate-stall') {
                            // Artificial lost ACK below the app-facing promise.
                            stats.terminateAcksWithheld++;
                            testReport({ kind: 'loading-fault', fault, phase: 'Terminate-ACK-withheld', documentId: id });
                            return new Promise(() => {});
                    }
                    const result = send(name, ...args);
                    result.then(() => {
                        stats.terminateResolves++;
                        testReport({ kind: 'loading-phase', phase: 'Terminate-resolve', documentId: id });
                    }, error => {
                        stats.terminateRejects++;
                        testReport({ kind: 'loading-phase', phase: 'Terminate-reject', documentId: id, errorName: error.name });
                    });
                    return result;
                };
                if (fault === 'terminate-stall') {
                    nextFetchGate = 'terminate-stall-range';
                    testReport({ kind: 'loading-fault', fault, phase: 'range-gate-armed', documentId: id });
                }
                testReport({ kind: 'loading-phase', phase: 'document-ready', documentId: id, numPages: doc.numPages });
                const getPage = doc.getPage.bind(doc);
                doc.getPage = async (...args) => {
                    const page = await getPage(...args);
                    if (!patchedPages.has(page)) {
                        patchedPages.add(page);
                        const destroyPage = page._destroy.bind(page);
                        page._destroy = (...values) => {
                            stats.pageDestroyStarts++;
                            testReport({ kind: 'loading-phase', phase: 'page-destroy-start', documentId: id, page: page.pageNumber });
                            const result = destroyPage(...values);
                            result.then(() => {
                                stats.pageDestroyFinishes++;
                                testReport({ kind: 'loading-phase', phase: 'page-destroy-finish', documentId: id, page: page.pageNumber });
                            }, error => testReport({ kind: 'loading-phase', phase: 'page-destroy-reject', documentId: id,
                                page: page.pageNumber, errorName: error.name }));
                            return result;
                        };
                        const render = page.render.bind(page);
                        page.render = (...values) => {
                            stats.renderStarts++;
                            stats.renderActive++;
                            stats.renderPeak = Math.max(stats.renderPeak, stats.renderActive);
                            testReport({ kind: 'loading-phase', phase: 'render-start', documentId: id, page: page.pageNumber });
                            const rendering = render(...values);
                            if (nextRenderStart) {
                                const notify = nextRenderStart;
                                nextRenderStart = null;
                                notify({ documentId: id, page: page.pageNumber, tabId: activeTabId });
                            }
                            rendering.promise.then(() => {
                                stats.renderActive--;
                                stats.renderFinishes++;
                                completedPages.add(`${id}:${page.pageNumber}`);
                                testReport({ kind: 'loading-phase', phase: 'render-finish', documentId: id, page: page.pageNumber });
                            }, error => {
                                stats.renderActive--;
                                if (error.name !== 'RenderingCancelledException') stats.renderErrors++;
                                testReport({ kind: 'loading-phase', phase: 'render-rejected', documentId: id,
                                    page: page.pageNumber, errorName: error.name });
                            });
                            return rendering;
                        };
                    }
                    return page;
                };
            }, error => {
                stats.documentRejected++;
                testReport({ kind: 'loading-phase', phase: 'document-rejected', documentId: id, errorName: error.name });
            });
            return task;
        } };
    };
    // Installing this wrapper now catches the first initialization and restored
    // tab load. Waiting for pdfjsReady here would hide the startup race again.
    const initialize = initializePdfJs;
    initializePdfJs = async (...args) => {
        testReport({ kind: 'loading-phase', phase: 'pdfjs-init-start' });
        await initialize(...args);
        if (pdfjsLib) patchPdfJs();
        testReport({ kind: 'loading-phase', phase: 'pdfjs-init-finish' });
    };
    const snapshot = label => {
        const overlay = document.getElementById('viewer-loading');
        const state = pdfStates[activeTabId];
        const point = {
            kind: 'loading-checkpoint', label, ...stats, activeTabId,
            visibility: document.visibilityState, restoredTabs: tabs.length,
            loadingVisible: !!overlay && getComputedStyle(overlay).display !== 'none',
            loadingMessage: overlay?.textContent.trim().slice(0, 120) || '',
            pendingDestructions: typeof pdfPendingDestructions === 'undefined' ? null : pdfPendingDestructions.size,
            states: Object.entries(pdfStates).map(([id, value]) => ({
                id, loaded: !!value.loaded, loading: !!value.loading, hasDocument: !!value.pdfDoc,
                hasLoadingTask: !!value.loadingTask, releasing: !!value.releasePromise,
                hasOwnedRuntime: !!value.pdfRuntime, runtimeStopped: value.pdfRuntime?.stopped ?? null,
                page: value.currentPage, zoom: value.scale, generation: value.loadGeneration,
            })),
            pageInput: Number(document.getElementById('page-input')?.value),
            displayedPages: [...document.querySelectorAll('#viewer-pages .page-wrapper')].map(page => Number(page.dataset.page)),
            textLayerChars: [...document.querySelectorAll('#viewer-pages .textLayer')].reduce((sum, layer) => sum + layer.textContent.length, 0),
            activeDocumentId: state?.pdfDoc ? docIds.get(state.pdfDoc) : null,
        };
        testReport(point);
        return point;
    };
    const assert = (name, passed) => {
        testReport({ kind: 'loading-assertion', name, passed: !!passed });
        if (!passed) throw Error(`Assertion failed: ${name}`);
    };
    const pixels = canvas => {
        // Report a count only, never the reader's page image or extracted text.
        const probe = document.createElement('canvas');
        probe.width = probe.height = 32;
        const context = probe.getContext('2d', { willReadFrequently: true });
        context.drawImage(canvas, 0, 0, 32, 32);
        const data = context.getImageData(0, 0, 32, 32).data;
        let nonwhite = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] && Math.min(data[i], data[i + 1], data[i + 2]) < 245) nonwhite++;
        }
        probe.width = probe.height = 0;
        return nonwhite;
    };
    const bodyReady = async (tabId, label, limit = timeout) => {
        const actualPage = () => Math.max(1, Math.min(expectedPage, pdfStates[tabId]?.totalPages || expectedPage));
        await until(() => {
            const state = pdfStates[tabId];
            const overlay = document.getElementById('viewer-loading');
            const targetPage = actualPage();
            return document.visibilityState === 'visible' && activeTabId === tabId &&
                state?.loaded && !state.loading && state.pdfDoc && stats.renderActive === 0 &&
                completedPages.has(`${docIds.get(state.pdfDoc)}:${targetPage}`) &&
                getComputedStyle(overlay).display === 'none' &&
                document.querySelector(`#viewer-pages .page-wrapper[data-page="${targetPage}"] canvas`);
        }, `${label}: loaded state, overlay hidden, completed page ${expectedPage}`, limit);
        await sleep(200);
        const state = pdfStates[tabId];
        const targetPage = actualPage();
        const canvas = document.querySelector(`#viewer-pages .page-wrapper[data-page="${targetPage}"] canvas`);
        const nonwhiteSamples = pixels(canvas);
        testReport({ kind: 'loading-canvas', label, page: targetPage, requestedPage: expectedPage, width: canvas.width,
            height: canvas.height, nonwhiteSamples, sampleCount: 1024 });
        const point = snapshot(label);
        assert(`${label}: reading position`, state.currentPage === targetPage && point.pageInput === targetPage);
        assert(`${label}: restored zoom`, Math.abs(state.scale - expectedZoom) < 0.000001);
        assert(`${label}: page body painted`, nonwhiteSamples > 0);
    };
    const gateStatus = async token => (await fetch(`/test-gate?token=${encodeURIComponent(token)}`, { cache: 'no-store' })).json();
    const openGate = async token => {
        const result = await gateStatus(token);
        assert(`${token}: released before safety timeout`, !result.timedOut);
        await fetch(`/test-gate?token=${encodeURIComponent(token)}`, { method: 'POST' });
    };
    const pendingLoad = async (tabId, token) => {
        await until(async () => pdfStates[tabId]?.loadingTask && (await gateStatus(token)).requests > 0,
            `${token}: PDF.js network request pending`);
        snapshot(token + '-pending');
        assert(`${token}: loading interrupted before ready`, pdfStates[tabId].loading && !pdfStates[tabId].loaded);
    };
    const heartbeat = setInterval(() => snapshot('progress'), 5000);
    document.addEventListener('visibilitychange', () => snapshot('visibility-' + document.visibilityState));
    try {
        const initial = restoredCount > 1 ? 'pdf-2' : 'pdf-1';
        await bodyReady(initial, 'startup-restored');
        assert('startup: restored tab count', tabs.length === restoredCount);
        assert('startup: lazy load only active tab', stats.documentStarts === 1);
        if (selectedCase === 'all' || selectedCase === 'load-switch') {
            testGateNextDocument(1, 'switch-load');
            activateTab('pdf-1');
            await pendingLoad('pdf-1', 'switch-load');
            activateTab(initial);
            await sleep(300);
            snapshot('switch-before-gate-release');
            await openGate('switch-load');
            await bodyReady(initial, 'switch-back-existing');
            activateTab('pdf-1');
            await bodyReady('pdf-1', 'reopen-cancelled-load');
            assert('switch: cancelled worker destruction completed', stats.destroyFinishes > 0);
        }
        if (selectedCase === 'all' || selectedCase === 'load-hide') {
            testGateNextDocument(3, 'hidden-load');
            activateTab('pdf-3');
            await pendingLoad('pdf-3', 'hidden-load');
            window.testWasHidden = false;
            testReport({ kind: 'hide' });
            await until(() => document.visibilityState === 'hidden', 'native hide', 10000);
            setTimeout(() => snapshot('hidden-load-after-18-seconds'), 18000);
            await until(() => window.testWasHidden, 'native restore', 35000);
            await openGate('hidden-load');
            await bodyReady('pdf-3', 'restore-cancelled-load');
        }
        if (selectedCase === 'render-close' || selectedCase === 'render-evict-return') {
            const started = new Promise(resolve => { nextRenderStart = resolve; });
            openPdfTab(4);
            const rendered = await Promise.race([
                started,
                sleep(timeout).then(() => { throw Error('Timeout: render transition start'); }),
            ]);
            snapshot(selectedCase + '-in-progress');
            assert(`${selectedCase}: cancelled after load and during paint`,
                pdfStates[rendered.tabId]?.loaded && stats.renderActive > 0);
            const start = performance.now();
            activateTab(initial);
            if (selectedCase === 'render-close') {
                closeTab(rendered.tabId);
                await bodyReady(initial, 'after-render-close');
                // A bounded fallback may leave PDF.js's promise unresolved after
                // terminating its worker; verify app progress, not that promise.
                activateTab('pdf-3');
                await bodyReady('pdf-3', 'new-tab-after-render-close', 10000);
                assert('render-close: closed state removed', !pdfStates[rendered.tabId]);
            } else {
                // The bookshelf also enforces the document budget. With two
                // loaded PDFs it evicts the older one; no explicit close needed.
                activateTab('bookshelf');
                snapshot('bookshelf-evicted-rendering-tab');
                activateTab(rendered.tabId);
                await bodyReady(rendered.tabId, 'return-after-bookshelf-eviction', 10000);
                assert('render-evict-return: original tab remains open', tabs.some(tab => tab.id === rendered.tabId));
            }
            testReport({ kind: 'loading-transition-recovery', scenario: selectedCase, elapsedMs: performance.now() - start });
            assert(`${selectedCase}: release no longer blocks new loads`, pdfPendingDestructions.size === 0);
        }
        if (selectedCase === 'destroy-stall') {
            nextFault = 'destroy-stall';
            testGateNextDocument(1, 'destroy-stall-load');
            activateTab('pdf-1');
            await pendingLoad('pdf-1', 'destroy-stall-load');
            const start = performance.now();
            activateTab('pdf-3');
            await openGate('destroy-stall-load');
            await bodyReady('pdf-3', 'after-destroy-stall', 10000);
            const elapsedMs = performance.now() - start;
            testReport({ kind: 'loading-fault-recovery', fault: 'destroy-stall', elapsedMs });
            assert('destroy-stall: fallback waits for deadline then recovers', elapsedMs >= 2500 && elapsedMs < 10000);
            assert('destroy-stall: real worker destruction completed', stats.destroyUnderlyingFinishes > 0);
            assert('destroy-stall: native worker terminated', stats.nativeWorkerTerminates > 0);
        }
        if (selectedCase === 'load-stall') {
            nextFault = 'load-stall';
            activateTab('pdf-1');
            await until(() => pdfStates['pdf-1']?.loadingTask, 'load-stall task starts');
            snapshot('load-stall-pending');
            const start = performance.now();
            await until(() => {
                const overlay = document.getElementById('viewer-loading');
                return getComputedStyle(overlay).display !== 'none' && overlay.querySelector('button') &&
                    !pdfStates['pdf-1']?.loading;
            }, 'load-stall error with retry', 75000);
            const elapsedMs = performance.now() - start;
            testReport({ kind: 'loading-fault-recovery', fault: 'load-stall', elapsedMs });
            snapshot('load-stall-error-visible');
            document.querySelector('#viewer-loading button').click();
            await bodyReady('pdf-1', 'after-load-stall-retry', 15000);
            assert('load-stall: error arrived after idle timeout', elapsedMs >= 55000 && elapsedMs < 75000);
        }
        if (selectedCase === 'terminate-stall') {
            nextFault = 'terminate-stall';
            activateTab('pdf-1');
            await until(async () => (await gateStatus('terminate-stall-range')).requests > 0,
                'terminate-stall: pending real Range fetch');
            snapshot('terminate-stall-range-pending');
            assert('terminate-stall: PDF loaded before range request', !!pdfStates['pdf-1']?.loaded);
            const start = performance.now();
            closeTab('pdf-1');
            activateTab('pdf-3');
            // Leave the Range response withheld: recovery must cancel this fetch,
            // not wait for our server to finish sending the fixture.
            await bodyReady('pdf-3', 'after-terminate-stall', 10000);
            const elapsedMs = performance.now() - start;
            testReport({ kind: 'loading-fault-recovery', fault: 'terminate-stall', elapsedMs });
            assert('terminate-stall: ACK withheld', stats.terminateAcksWithheld === 1);
            assert('terminate-stall: native worker terminated', stats.nativeWorkerTerminates > 0);
            assert('terminate-stall: pending HTTP fetch aborted', stats.pendingFetchAborts > 0);
            assert('terminate-stall: recovery within 10 seconds', elapsedMs >= 2500 && elapsedMs < 10000);
            await openGate('terminate-stall-range');
        }
        assert('loading: no unexpected render errors', stats.renderErrors === 0);
        snapshot('loading-complete');
        testReport({ kind: 'loading-complete', selectedCase });
    } catch (error) {
        snapshot('loading-failure');
        testReport({ kind: 'scenario-failed', message: String(error), stack: error.stack });
    } finally {
        clearInterval(heartbeat);
        testReport({ kind: 'finish' });
    }
})();
