const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/js/bookshelf.js'), 'utf8');
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function createApp({ streamUrl, getDocument, fixedTime, clock } = {}) {
    const elements = new Map();
    const calls = [];
    const documents = [];
    const workers = [];
    const makeElement = () => ({
        dataset: {}, style: {}, children: [], listeners: new Map(),
        classList: { toggle() {}, add() {}, remove() {} },
        replaceChildren() { this.children = []; },
        appendChild(child) { this.children.push(child); },
        querySelectorAll: () => [],
        addEventListener(event, callback) { this.listeners.set(event, callback); },
        click() { this.listeners.get('click')?.(); },
    });
    const context = vm.createContext({
        window: { devicePixelRatio: 3, __TAURI__: {
            core: { async invoke(command, args) {
                calls.push({ command, args });
                if (command === 'get_pdf_stream_url') return streamUrl ? streamUrl(args) : 'http://127.0.0.1/test.pdf';
                return [];
            } },
            event: { listen: async () => () => {} },
            webviewWindow: { getCurrentWebviewWindow: () => ({}) },
        } },
        document: { addEventListener() {}, querySelectorAll: () => [], visibilityState: 'visible', body: makeElement(),
            createElement: makeElement,
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeElement());
                return elements.get(id);
            },
        },
        localStorage: { getItem: () => null, setItem() {} },
        console: { warn() {}, error() {} },
        setTimeout: clock ? clock.setTimeout : setTimeout,
        clearTimeout: clock ? clock.clearTimeout : clearTimeout,
        requestAnimationFrame: callback => callback(),
        testClock: clock,
        Error,
        AbortController,
        Worker: class {
            constructor() { this.listeners = new Map(); this.terminated = false; workers.push(this); }
            addEventListener(event, callback) { this.listeners.set(event, callback); }
            removeEventListener(event) { this.listeners.delete(event); }
            terminate() { this.terminated = true; }
            emit(event) { this.listeners.get(event)?.(); }
        },
        makeDocument(options) {
            if (getDocument) return getDocument(options);
            const doc = { numPages: 24, destroyed: false };
            const task = { promise: Promise.resolve(doc), async destroy() { doc.destroyed = true; } };
            doc.destroy = () => task.destroy();
            documents.push({ doc, task, options });
            return task;
        },
    });
    vm.runInContext(source, context);
    if (fixedTime !== undefined) vm.runInContext(`Date.now = () => ${Number(fixedTime)};`, context);
    if (clock) vm.runInContext('Date.now = () => testClock.now();', context);
    vm.runInContext(`
        allBooks = [1, 2, 3, 4].map(id => ({ id, title: 'Book ' + id, filePath: '/test/' + id + '.pdf',
            lastPage: 7, lastZoom: 1.5, lastScrollY: 0.4, lastSpreadMode: 1, lastSpreadDirection: 0 }));
        tabs = allBooks.map(book => ({ id: 'pdf-' + book.id, type: 'pdf', bookId: book.id, title: book.title }));
        pdfjsReady = true;
        pdfjsLib = {
            getDocument: options => makeDocument(options),
            GlobalWorkerOptions: { workerSrc: 'blob:test-worker' },
            PDFWorker: { create: ({ port }) => ({ port, destroy() { this.destroyed = true; } }) },
        };
        showPdfTab = () => {};
        renderTabBar = () => {};
        renderBooks = async () => {};
        globalThis.api = {
            load: id => loadPdfForTab('pdf-' + id, allBooks.find(book => book.id === id)),
            close: id => closeTab('pdf-' + id),
            release: id => releasePdfDocument(pdfStates['pdf-' + id]),
            state: id => pdfStates['pdf-' + id],
            states: () => Object.values(pdfStates),
            canvas: (width, height, count = 1) => getPdfCanvasSize({ width, height }, PDF_VIEWER_FRAME_PIXELS / count),
            readText: readPageTextContent,
            cancelRendering: cancelPdfRendering,
            scheduleBackground: schedulePdfBackgroundRelease,
            scheduleResume: scheduleResumeRecovery,
        };
    `, context);
    return { api: context.api, documents, calls, context, elements, workers };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function createClock() {
    let now = 0, nextId = 1;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(callback, delay = 0) {
            const id = nextId++;
            timers.set(id, { callback, due: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        async advance(milliseconds) {
            const end = now + milliseconds;
            while (true) {
                const next = [...timers].filter(([, timer]) => timer.due <= end)
                    .sort((a, b) => a[1].due - b[1].due)[0];
                if (!next) break;
                timers.delete(next[0]);
                now = next[1].due;
                await next[1].callback();
            }
            now = end;
            await tick();
        },
    };
}

test('hidden focus/pageshow events and a later blur cannot cancel or postpone the 15-second release', async () => {
    const clock = createClock();
    const app = createApp({ clock });
    await app.api.load(1);
    app.context.document.visibilityState = 'hidden';
    app.api.scheduleBackground();
    await clock.advance(5000);
    for (const event of ['focus', 'pageshow', 'paperstock-system-resumed']) app.api.scheduleResume(event);
    app.api.scheduleBackground(60000);
    await clock.advance(9999);
    assert.equal(app.api.state(1).loaded, true);
    await clock.advance(1);
    assert.equal(app.api.state(1).loaded, false);
    assert.equal(app.documents[0].doc.destroyed, true);
});

test('becoming hidden shortens an existing 60-second blur release to 15 seconds', async () => {
    const clock = createClock();
    const app = createApp({ clock });
    await app.api.load(1);
    app.api.scheduleBackground(60000);
    await clock.advance(1000);
    app.context.document.visibilityState = 'hidden';
    app.api.scheduleBackground();
    await clock.advance(14999);
    assert.equal(app.api.state(1).loaded, true);
    await clock.advance(1);
    assert.equal(app.api.state(1).loaded, false);
});

test('a blur received while already hidden uses the 15-second limit even without an earlier timer', async () => {
    const clock = createClock();
    const app = createApp({ clock });
    await app.api.load(1);
    app.context.document.visibilityState = 'hidden';
    app.api.scheduleBackground(60000);
    await clock.advance(15000);
    assert.equal(app.api.state(1).loaded, false);
});

test('a confirmed visible focus cancels the pending hidden release', async () => {
    const clock = createClock();
    const app = createApp({ clock });
    await app.api.load(1);
    app.context.document.visibilityState = 'hidden';
    app.api.scheduleBackground();
    await clock.advance(5000);
    app.context.document.visibilityState = 'visible';
    app.api.scheduleResume('focus');
    await clock.advance(60000);
    assert.equal(app.api.state(1).loaded, true);
    assert.equal(app.documents[0].doc.destroyed, false);
});

test('a late stream URL cannot create a PDF worker after its tab is closed', async () => {
    const url = deferred();
    const app = createApp({ streamUrl: () => url.promise });
    const loading = app.api.load(1);
    await tick();
    await app.api.close(1);
    url.resolve('http://127.0.0.1/late.pdf');
    await loading;
    assert.equal(app.api.state(1), undefined);
    assert.equal(app.documents.length, 0);
});

test('closing an in-flight PDF load destroys its loading task', async () => {
    const pdf = deferred();
    let destroyed = 0;
    const app = createApp({ getDocument: () => ({
        promise: pdf.promise,
        async destroy() { destroyed++; pdf.reject(new Error('destroyed')); },
    }) });
    const loading = app.api.load(1);
    await tick();
    await app.api.close(1);
    await loading;
    assert.equal(destroyed, 1);
    assert.equal(app.api.state(1), undefined);
});

test('rehiding a reopened tab invalidates a load waiting for previous destruction', async () => {
    const destroyed = deferred();
    let loads = 0;
    const app = createApp({ getDocument: () => {
        loads++;
        return { promise: Promise.resolve({ numPages: 24 }), destroy: () => destroyed.promise };
    } });
    await app.api.load(1);
    const releasing = app.api.release(1);
    const reloading = app.api.load(1);
    assert.equal(app.api.state(1).loading, true);
    const rereleasing = app.api.release(1);
    destroyed.resolve();
    await Promise.all([releasing, reloading, rereleasing]);
    assert.equal(loads, 1);
    assert.equal(app.api.state(1).loading, false);
    assert.equal(app.api.state(1).pdfDoc, null);
});

test('eviction preserves page, zoom, spread, scroll and the open tab for lazy reload', async () => {
    const app = createApp();
    await app.api.load(1);
    const state = app.api.state(1);
    state.currentPage = 13;
    state.scale = 2.75;
    state.pendingScrollY = state.savedScrollY = 0.65;
    state.thumbnailsOpen = true;
    await app.api.release(1);
    assert.equal(app.documents[0].doc.destroyed, true);
    await app.api.load(1);
    assert.equal(app.api.state(1), state);
    assert.equal(state.currentPage, 13);
    assert.equal(state.scale, 2.75);
    assert.equal(state.spreadMode, true);
    assert.equal(state.spreadDirection, 'ltr');
    assert.equal(state.pendingScrollY, 0.65);
    assert.equal(state.thumbnailsOpen, true);
    assert.equal(app.documents[1].options.disableAutoFetch, true);
    assert.equal(app.documents[1].options.disableStream, true);
});

test('opening many documents evicts older workers and keeps no more than two loaded', async () => {
    const app = createApp();
    for (const id of [1, 2, 3, 4]) await app.api.load(id);
    await tick();
    assert.equal(app.api.states().filter(state => state.pdfDoc).length, 2);
    assert.equal(app.documents.filter(({ doc }) => !doc.destroyed).length, 2);
    assert.equal(app.api.state(1).currentPage, 7);
});

test('a replacement waits for an older worker to finish destruction', async () => {
    const firstDestroyed = deferred();
    let loads = 0;
    const app = createApp({ fixedTime: 1000, getDocument: () => {
        const index = ++loads;
        return { promise: Promise.resolve({ numPages: 24 }),
            destroy: () => index === 1 ? firstDestroyed.promise : Promise.resolve() };
    } });
    await app.api.load(1);
    await app.api.load(2);
    const third = app.api.load(3);
    await tick();
    assert.equal(loads, 2);
    firstDestroyed.resolve();
    await third;
    assert.equal(loads, 3);
    assert.equal(app.api.states().filter(state => state.pdfDoc).length, 2);
});

test('a closed tab remains in the worker budget until destruction completes', async () => {
    const destroyed = deferred();
    let loads = 0, alive = 0, peak = 0;
    const app = createApp({ getDocument: () => {
        const index = ++loads;
        alive++;
        peak = Math.max(peak, alive);
        return { promise: Promise.resolve({ numPages: 24 }), async destroy() {
            if (index === 1) await destroyed.promise;
            alive--;
        } };
    } });
    await app.api.load(1);
    const firstClose = app.api.close(1);
    assert.equal(app.api.state(1), undefined);
    const pending = [firstClose];
    // Repeatedly opening/closing while the first worker is still terminating
    // must not admit more workers, even though the closed tabs have no state.
    for (const id of [2, 3]) {
        pending.push(app.api.load(id));
        await tick();
        assert.equal(loads, 1);
        pending.push(app.api.close(id));
    }
    const lastLoad = app.api.load(4);
    await tick();
    assert.equal(alive, 1);
    assert.equal(loads, 1);
    destroyed.resolve();
    await Promise.all([...pending, lastLoad]);
    assert.equal(loads, 2);
    assert.equal(alive, 1);
    assert.equal(peak, 1);
    await app.api.close(4);
    assert.equal(alive, 0);
});

function prepareScrollRender(app, gate = null) {
    app.context.renderGate = gate;
    vm.runInContext(`
        activeTabId = 'pdf-1';
        document.body = { appendChild() {} };
        const originalElement = document.createElement;
        document.createElement = () => ({ ...originalElement(), remove() {} });
        for (const id of ['viewer-pages', 'viewer-container']) {
            const element = document.getElementById(id);
            element.scrollHeight = element.scrollWidth = 1000;
            element.scrollTop = element.scrollLeft = 0;
        }
        pdfStates['pdf-1'].pendingScrollY = 0.65;
        pdfStates['pdf-1'].pdfDoc.cleanup = async () => {};
        createRenderedPage = async () => { if (renderGate) await renderGate.promise; };
        hideCommentPopup = updateViewerZoomSlider = updateFitButtonState = updatePageNavigationState =
            updateThumbnailHighlight = updateBookmarkButton = updateProgressBar = () => {};
    `, app.context);
}

test('resume preserves the saved scroll when no earlier canvas exists for that tab', async () => {
    const app = createApp();
    await app.api.load(1);
    prepareScrollRender(app);
    await vm.runInContext("renderPdfPages('pdf-1', true)", app.context);
    assert.equal(app.elements.get('viewer-container').scrollTop, 650);
    assert.equal(app.api.state(1).pendingScrollY, 0);
});

test('a focus redraw superseding the first render still restores the saved scroll', async () => {
    const app = createApp();
    const rendered = deferred();
    await app.api.load(1);
    prepareScrollRender(app, rendered);
    const firstRender = vm.runInContext("renderPdfPages('pdf-1')", app.context);
    await tick();
    const focusRender = vm.runInContext("renderPdfPages('pdf-1', true)", app.context);
    rendered.resolve();
    await Promise.all([firstRender, focusRender]);
    assert.equal(app.elements.get('viewer-container').scrollTop, 650);
    assert.equal(app.api.state(1).pendingScrollY, 0);
});

test('an existing canvas scroll snapshot takes precedence over an older saved position', async () => {
    const app = createApp();
    await app.api.load(1);
    prepareScrollRender(app);
    app.elements.get('viewer-pages').dataset.tabId = 'pdf-1';
    app.elements.get('viewer-container').scrollTop = 250;
    await vm.runInContext("renderPdfPages('pdf-1', true)", app.context);
    assert.equal(app.elements.get('viewer-container').scrollTop, 250);
    assert.equal(app.api.state(1).pendingScrollY, 0);
});

test('Retina, high zoom, oversized pages and spreads share a bounded canvas budget', () => {
    const app = createApp();
    for (const [width, height, count] of [[600, 800, 1], [3000, 4000, 2], [20000, 30000, 1], [100000, 1, 2]]) {
        const size = app.api.canvas(width, height, count);
        assert.ok(size.width > 0 && size.height > 0);
        assert.ok(size.width <= 4096 && size.height <= 4096);
        assert.ok(size.width * size.height * count <= 8 * 1024 * 1024);
        assert.ok(size.width <= width * 2 && size.height <= height * 2);
    }
});

test('text extraction supports WKWebView streams without async iterators and releases the reader', async () => {
    const app = createApp();
    let cancelled = 0, released = 0;
    const chunks = [
        { value: { items: [{ str: '日本語' }], styles: { body: { fontFamily: 'sans-serif' } }, lang: 'ja' }, done: false },
        { value: { items: [{ str: 'テキスト' }], styles: {}, lang: null }, done: false },
        { done: true },
    ];
    const state = {};
    const page = { streamTextContent: () => ({ getReader: () => ({
        async read() { return chunks.shift(); },
        async cancel(reason) { assert.ok(reason instanceof Error, 'PDF.js requires an Error cancellation reason'); cancelled++; },
        releaseLock() { released++; },
    }) }) };
    const result = await app.api.readText(page, state, () => true);
    assert.equal(result.items.map(item => item.str).join(''), '日本語テキスト');
    assert.equal(result.lang, 'ja');
    assert.equal(result.styles.body.fontFamily, 'sans-serif');
    assert.equal(state.textReaders.size, 0);
    assert.equal(cancelled, 1);
    assert.equal(released, 1);
});

test('oversized text stops stream consumption early and releases its worker reader', async () => {
    const app = createApp();
    let reads = 0, cancelled = 0, released = 0;
    const page = { streamTextContent: () => ({ getReader: () => ({
        async read() { reads++; return { value: { items: [{ str: 'x'.repeat(120001) }], styles: {} }, done: false }; },
        async cancel(reason) { assert.ok(reason instanceof Error, 'PDF.js requires an Error cancellation reason'); cancelled++; },
        releaseLock() { released++; },
    }) }) };
    const result = await app.api.readText(page, {}, () => true);
    assert.equal(result, null);
    assert.equal(reads, 1);
    assert.equal(cancelled, 1);
    assert.equal(released, 1);
});

test('superseding a render cancels an in-flight text stream before its next chunk', async () => {
    const app = createApp();
    const chunk = deferred();
    let released = 0, current = true;
    const state = {};
    const page = { streamTextContent: () => ({ getReader: () => ({
        read: () => chunk.promise,
        async cancel(reason) {
            assert.ok(reason instanceof Error, 'PDF.js requires an Error cancellation reason');
            chunk.resolve({ done: true });
        },
        releaseLock() { released++; },
    }) }) };
    const reading = app.api.readText(page, state, () => current);
    current = false;
    app.api.cancelRendering(state);
    await reading;
    assert.equal(state.textReaders.size, 0);
    assert.equal(released, 1);
});

function loadingMessage(app) {
    return (app.elements.get('viewer-loading')?.children || []).map(child => child.textContent).join(' ');
}

function setActive(app, id = 1) {
    vm.runInContext(`activeTabId = 'pdf-${id}';`, app.context);
}

test('a load error is visible and retryable before an unresponsive destroy finishes', async () => {
    const clock = createClock();
    const app = createApp({ clock, getDocument: () => ({
        promise: Promise.reject(new Error('/private/sensitive/path.pdf failed')),
        destroy: () => new Promise(() => {}),
    }) });
    setActive(app);
    await app.api.load(1);
    assert.match(loadingMessage(app), /PDFを開けませんでした/);
    assert.match(loadingMessage(app), /再試行/);
    assert.doesNotMatch(loadingMessage(app), /sensitive|private/);
    assert.equal(app.api.state(1).loading, false);
    assert.equal(app.workers[0].terminated, false);
    await clock.advance(3000);
    assert.equal(app.workers[0].terminated, true);
    assert.equal(vm.runInContext('pdfPendingDestructions.size', app.context), 0);
});

test('destroy timeout terminates the owned worker before admitting a different tab', async () => {
    const clock = createClock();
    const destroy = deferred();
    let loads = 0;
    const app = createApp({ clock, getDocument: options => {
        const index = ++loads;
        if (index > 1) assert.equal(app.workers[0].terminated, true);
        assert.ok(options.worker.port);
        return { promise: Promise.resolve({ numPages: 24 }),
            destroy: () => index === 1 ? destroy.promise : Promise.resolve() };
    } });
    await app.api.load(1);
    const closed = app.api.close(1);
    const second = app.api.load(2);
    await tick();
    await clock.advance(2999);
    assert.equal(loads, 1);
    await clock.advance(1);
    await Promise.all([closed, second]);
    assert.equal(loads, 2);
    assert.equal(app.api.state(2).loaded, true);
    assert.equal(app.workers.filter(worker => !worker.terminated).length, 1);
    destroy.resolve();
    await tick();
    assert.equal(app.workers[1].terminated, false);
    await app.api.close(2);
});

test('increasing load progress extends the deadline while duplicate progress does not', async () => {
    const clock = createClock();
    let task;
    const app = createApp({ clock, getDocument: () => task = {
        promise: new Promise(() => {}), destroy: async () => {},
    } });
    setActive(app);
    const loaded = app.api.load(1);
    await tick();
    await clock.advance(59000);
    task.onProgress({ loaded: 1000 });
    await clock.advance(59000);
    assert.equal(app.api.state(1).loading, true);
    task.onProgress({ loaded: 1000 });
    await clock.advance(1000);
    await loaded;
    assert.equal(app.api.state(1).loading, false);
    assert.match(loadingMessage(app), /時間内に完了しませんでした/);
    await tick();
    assert.equal(app.workers[0].terminated, true);
});

test('a stalled URL IPC expires without creating a worker and leaves the tab retryable', async () => {
    const clock = createClock();
    const app = createApp({ clock, streamUrl: () => new Promise(() => {}) });
    setActive(app);
    const loaded = app.api.load(1);
    await tick();
    await clock.advance(60000);
    await loaded;
    assert.equal(app.api.state(1).loading, false);
    assert.match(loadingMessage(app), /再試行/);
    assert.equal(app.workers.length, 0);
});

test('late load and destruction completions cannot erase a successful retry of the same tab', async () => {
    const clock = createClock();
    const oldLoad = deferred(), oldDestroy = deferred();
    let loads = 0;
    const newDoc = { numPages: 24 };
    const app = createApp({ clock, getDocument: () => ++loads === 1
        ? { promise: oldLoad.promise, destroy: () => oldDestroy.promise }
        : { promise: Promise.resolve(newDoc), destroy: async () => {} } });
    setActive(app);
    const first = app.api.load(1);
    await tick();
    app.api.state(1).currentPage = 13;
    app.api.state(1).scale = 2;
    await clock.advance(60000);
    await first;
    const retry = app.api.load(1);
    await clock.advance(3000);
    await retry;
    assert.equal(app.api.state(1).pdfDoc, newDoc);
    assert.equal(app.api.state(1).currentPage, 13);
    assert.equal(app.api.state(1).scale, 2);
    oldLoad.resolve({ numPages: 2 });
    oldDestroy.resolve();
    await tick();
    assert.equal(app.api.state(1).pdfDoc, newDoc);
    assert.equal(app.api.state(1).loaded, true);
    assert.equal(app.workers[1].terminated, false);
    await app.api.close(1);
});

test('worker error and messageerror during startup fail the load and release the owned worker', async () => {
    for (const event of ['error', 'messageerror']) {
        const app = createApp({ getDocument: () => ({ promise: new Promise(() => {}), destroy: async () => {} }) });
        setActive(app);
        const loaded = app.api.load(1);
        await tick();
        app.workers[0].emit(event);
        await loaded;
        await tick();
        assert.equal(app.api.state(1).loading, false);
        assert.match(loadingMessage(app), /再試行/);
        assert.equal(app.workers[0].terminated, true);
    }
});

test('an external AbortError from the current load is a retryable failure, not a silent cancellation', async () => {
    const error = new Error('network cancelled');
    error.name = 'AbortError';
    const app = createApp({ getDocument: () => ({ promise: Promise.reject(error), destroy: async () => {} }) });
    setActive(app);
    await app.api.load(1);
    await tick();
    assert.equal(app.api.state(1).loading, false);
    assert.match(loadingMessage(app), /再試行/);
    assert.equal(app.workers[0].terminated, true);
});

test('a worker failure after loading changes the active tab to a retryable error', async () => {
    const app = createApp();
    setActive(app);
    await app.api.load(1);
    assert.equal(app.api.state(1).loaded, true);
    app.workers[0].emit('error');
    await tick();
    assert.equal(app.api.state(1).loaded, false);
    assert.match(loadingMessage(app), /再試行/);
    assert.equal(app.workers[0].terminated, true);
});

test('document cancellation releases a queued worker wait without aborting a newer document', async () => {
    const app = createApp();
    await app.api.load(1);
    const oldRuntime = app.api.state(1).pdfRuntime;
    app.context.oldRuntime = oldRuntime;
    const oldWork = vm.runInContext('enqueuePdfWork(() => waitForPdfSession(new Promise(() => {}), oldRuntime))', app.context);
    await tick();
    await app.api.release(1);
    await app.api.load(1);
    await oldWork;
    assert.notEqual(app.api.state(1).pdfRuntime, oldRuntime);
    assert.equal(app.api.state(1).pdfRuntime.controller.signal.aborted, false);
    assert.equal(app.workers[1].terminated, false);
    const result = await vm.runInContext('enqueuePdfWork(() => Promise.resolve(42))', app.context);
    assert.equal(result, 42);
    await app.api.close(1);
});
