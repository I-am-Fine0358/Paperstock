// Only the IPC and local data are replaced. Production UI and PDF.js are served verbatim.
// WKWebsiteDataStore.nonPersistent() keeps this data away from the user's app.
window.testBooks = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1, title: `検証用 PDF ${index + 1}`, filePath: `/fixture-${index + 1}.pdf`,
    coverPath: null, status: 'unread', isFavorite: false, tags: [],
    addedAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
    lastPage: 1, lastZoom: 1, lastSpreadMode: 0, lastSpreadDirection: 0,
}));
window.testEvents = {};
window.__TAURI__ = {
    core: {
        async invoke(command, args = {}) {
            if (command === 'get_books') return window.testBooks;
            if (command === 'get_book') return window.testBooks.find(book => book.id === args.id);
            if (command === 'get_pdf_stream_url') return location.origin + '/fixture.pdf?book=' + args.filePath;
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
window.testReport = data => window.webkit.messageHandlers.test.postMessage(data);
// Scenarios call production functions directly. Do not let unrelated typing or
// trackpad momentum on the user's desktop change a deterministic page assertion.
for (const type of ['keydown', 'keyup', 'wheel', 'pointerdown', 'mousedown', 'click', 'touchstart', 'touchmove']) {
    window.addEventListener(type, event => {
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
