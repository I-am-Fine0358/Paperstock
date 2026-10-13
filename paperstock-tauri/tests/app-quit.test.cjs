const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/js/bookshelf.js'), 'utf8');

function createApp(onInvoke = async () => undefined) {
    const stored = new Map();
    const calls = [];
    const warnings = [];
    const context = vm.createContext({
        window: { __TAURI__: {
            core: { invoke(command, args) {
                calls.push({ command, args });
                return onInvoke(command, args);
            } },
            event: { listen: async () => () => {} },
            webviewWindow: { getCurrentWebviewWindow: () => ({}) },
        } },
        document: { addEventListener() {} },
        localStorage: {
            getItem: key => stored.get(key) ?? null,
            setItem: (key, value) => stored.set(key, value),
        },
        console: { warn: (...args) => warnings.push(args), error() {}, log() {} },
        setTimeout, clearTimeout,
    });
    vm.runInContext(source, context);
    vm.runInContext(`
        allBooks = [{ id: 1, title: 'one' }, { id: 2, title: 'two' }];
        tabs = allBooks.map(book => ({ id: 'pdf-' + book.id, type: 'pdf', bookId: book.id, title: book.title }));
        for (const book of allBooks) {
            pdfStates['pdf-' + book.id] = {
                tabId: 'pdf-' + book.id, bookId: book.id, loaded: true,
                currentPage: book.id * 3, scale: 1.5, fitMode: false,
                spreadMode: true, spreadDirection: 'rtl',
            };
        }
        globalThis.testApi = { flushOpenPdfState, prepareAppQuit };
    `, context);
    return { api: context.testApi, calls, stored, warnings };
}

test('closing saves all tabs and their settings before notifying native completion', async () => {
    const app = createApp();
    await app.api.prepareAppQuit();
    assert.deepEqual(app.calls.map(call => call.command), ['update_book', 'update_book', 'quit_app']);
    assert.equal(app.calls[0].args.updates.lastPage, 3);
    assert.equal(app.calls[1].args.updates.lastPage, 6);
    assert.equal(app.calls[0].args.updates.lastZoom, 1.5);
    assert.equal(app.calls[0].args.updates.lastSpreadMode, 1);
    assert.equal(app.calls[0].args.updates.lastSpreadDirection, 1);
    assert.equal(JSON.parse(app.stored.get('ps-tab-state')).tabs.length, 2);
});

test('one failed save does not skip other tabs or prevent native completion', async () => {
    const app = createApp(async (command, args) => {
        if (command === 'update_book' && args.id === 1) throw new Error('database unavailable');
    });
    await app.api.prepareAppQuit();
    assert.equal(app.calls.filter(call => call.command === 'update_book').length, 2);
    assert.equal(app.calls.at(-1).command, 'quit_app');
    assert.equal(app.warnings.length, 1);
});

test('a stalled save does not stop another tab from saving; repeated quit is idempotent', async () => {
    let release;
    const app = createApp((command, args) => {
        if (command === 'update_book' && args.id === 1) return new Promise(resolve => { release = resolve; });
        return Promise.resolve();
    });
    const first = app.api.prepareAppQuit();
    await app.api.prepareAppQuit();
    await Promise.resolve();
    assert.equal(app.calls.filter(call => call.command === 'update_book').length, 2);
    assert.equal(app.calls.some(call => call.command === 'quit_app'), false);
    // In the real app, Rust's deadline exits independently if this never resolves.
    release();
    await first;
    assert.equal(app.calls.filter(call => call.command === 'quit_app').length, 1);
});
