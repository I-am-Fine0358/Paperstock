// Only the IPC and local data are replaced. Production UI and PDF.js are served verbatim.
// WKWebsiteDataStore.nonPersistent() keeps this data away from the user's app.
window.testBooks = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1, title: `検証用 PDF ${index + 1}`, filePath: `/fixture-${index + 1}.pdf`,
    coverPath: null, status: 'unread', isFavorite: false, tags: [],
    addedAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
    lastPage: 1, lastZoom: 1, lastSpreadMode: 0, lastSpreadDirection: 0,
}));
const testQuery = new URLSearchParams(location.search);
window.testLoadingMode = testQuery.get('scenario') === 'loading';
window.testReport = data => window.webkit.messageHandlers.test.postMessage(data);
window.testDocumentGates = new Map();
window.testGateNextDocument = (bookId, token) => testDocumentGates.set(`/fixture-${bookId}.pdf`, token);
if (testLoadingMode) {
    const page = Number(testQuery.get('startPage') || 1);
    const zoom = Number(testQuery.get('startZoom') || 1);
    const count = Number(testQuery.get('restoredTabs') || 3);
    for (const book of testBooks) Object.assign(book, { lastPage: page, lastZoom: zoom });
    const restoredTabs = testBooks.slice(0, count).map(book => ({
        id: `pdf-${book.id}`, type: 'pdf', bookId: book.id, title: book.title, groupId: null,
    }));
    // Runs before bookshelf.js and DOMContentLoaded, not after pdfjsReady.
    localStorage.setItem('ps-tab-state', JSON.stringify({
        tabs: restoredTabs, activeTabId: count > 1 ? 'pdf-2' : 'pdf-1',
        tabGroups: [], nextTabId: count + 1, nextGroupId: 1,
    }));
    testReport({ kind: 'loading-seed', restoredTabs: count, page, zoom });
}
const testClone = value => testLoadingMode ? JSON.parse(JSON.stringify(value)) : value;
window.testEvents = {};
window.__TAURI__ = {
    core: {
        async invoke(command, args = {}) {
            if (testLoadingMode) {
                // Tauri IPC serializes results and resolves asynchronously. Never
                // leak a source path or PDF contents into these phase records.
                testReport({ kind: 'test-ipc', command, phase: 'start', bookId: args.bookId || args.id || null });
                await new Promise(resolve => setTimeout(resolve, 10));
                testReport({ kind: 'test-ipc', command, phase: 'return', bookId: args.bookId || args.id || null });
            }
            if (command === 'get_books') return testClone(window.testBooks);
            if (command === 'get_book') return testClone(window.testBooks.find(book => book.id === args.id));
            if (command === 'get_pdf_stream_url') {
                const url = new URL('/fixture.pdf', location.origin);
                url.searchParams.set('book', args.filePath);
                const gate = testDocumentGates.get(args.filePath);
                if (gate) {
                    testDocumentGates.delete(args.filePath);
                    url.searchParams.set('testGate', gate);
                }
                return url.href;
            }
            if (command === 'update_book') {
                Object.assign(window.testBooks.find(book => book.id === args.id), args.updates);
                return null;
            }
            if (command === 'get_cover_data') return null;
            if (command === 'quit_app') return null;
            if (command.startsWith('get_') || command.startsWith('search_')) return [];
            throw Error('Unexpected test IPC: ' + command);
        },
        convertFileSrc: path => path,
    },
    event: {
        async listen(name, listener) { (window.testEvents[name] ||= []).push(listener); return () => {}; },
    },
    webviewWindow: {
        getCurrentWebviewWindow: () => ({
            onDragDropEvent: async () => () => {},
            onCloseRequested: async () => () => {},
        }),
    },
};
// Scenarios call production functions directly. Do not let unrelated typing or
// trackpad momentum on the user's desktop change a deterministic page assertion.
for (const type of ['keydown', 'keyup', 'wheel', 'pointerdown', 'mousedown', 'click', 'touchstart', 'touchmove']) {
    window.addEventListener(type, event => {
        if (testLoadingMode && !event.isTrusted) return; // allow the scenario's retry-button click
        testReport({ kind: 'blocked-external-input', eventType: type, deltaY: event.deltaY || 0 });
        event.preventDefault();
        event.stopImmediatePropagation();
    }, { capture: true, passive: false });
}
for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
        original(...values);
        testReport({ kind: 'console-' + level, message: values.map(value => String(value)).join(' ') });
    };
}
window.addEventListener('error', event => testReport({ kind: 'error', message: event.message, stack: event.error?.stack }));
window.addEventListener('unhandledrejection', event => testReport({ kind: 'error', message: String(event.reason), stack: event.reason?.stack }));
