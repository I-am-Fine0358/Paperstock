const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/libs/pdf.mjs'), 'utf8');
const start = source.indexOf('class WorkerTransport {');
const end = source.indexOf('\nclass ', start + 1);
assert.ok(start >= 0 && end > start, 'the bundled WorkerTransport must remain inspectable');

function createTransport({ terminate, cancel } = {}) {
    const events = [];
    const context = vm.createContext({
        Promise,
        AbortException: Error,
        PDFObjects: class { clear() { events.push('objects cleared'); } },
        FontLoader: class { clear() { events.push('fonts cleared'); } },
        TextLayer: { cleanup() { events.push('text cleanup'); } },
    });
    const Transport = vm.runInContext(`${source.slice(start, end)}\nWorkerTransport`, context);
    // The test exercises the real destroy path; message subscription and DOM
    // resource implementations are irrelevant to network/worker ordering.
    Transport.prototype.setupMessageHandler = () => {};
    const transport = new Transport({
        sendWithPromise(name) {
            events.push(name);
            return terminate ? terminate() : Promise.resolve();
        },
        destroy() { events.push('handler destroyed'); },
    }, {}, {
        cancelAllRequests(reason) {
            assert.ok(reason instanceof Error);
            events.push('network cancelled');
            cancel?.(reason);
        },
    }, {}, { filterFactory: { destroy() { events.push('filter destroyed'); } } },
    { addListener() {} });
    return { transport, events };
}

test('network is cancelled even when the worker never acknowledges Terminate', async () => {
    const { transport, events } = createTransport({ terminate: () => new Promise(() => {}) });
    let finished = false;
    transport.destroy().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['network cancelled', 'Terminate']);
    assert.equal(finished, false, 'the unresolved worker acknowledgement is intentional');
});

test('aborting a pending network read lets worker termination complete', async () => {
    let rejectRead;
    const pendingRead = new Promise((resolve, reject) => { rejectRead = reject; });
    const readAborted = pendingRead.catch(() => {});
    const { transport, events } = createTransport({
        cancel: reason => rejectRead(reason),
        terminate: () => readAborted,
    });
    await transport.destroy();
    assert.ok(events.indexOf('network cancelled') < events.indexOf('Terminate'));
    assert.ok(events.includes('handler destroyed'));
    assert.equal(transport.messageHandler, null);
});

test('repeated destruction shares the same cleanup and cancels network once', async () => {
    const { transport, events } = createTransport();
    const first = transport.destroy();
    const second = transport.destroy();
    assert.equal(first, second);
    await first;
    assert.equal(events.filter(event => event === 'network cancelled').length, 1);
    assert.equal(events.filter(event => event === 'Terminate').length, 1);
    assert.equal(events.filter(event => event === 'handler destroyed').length, 1);
});

function createFetchReader(kind) {
    let rejectFetch;
    const fetchError = new Error('Fetch is aborted');
    fetchError.name = 'AbortError';
    const baseStart = source.indexOf('class BasePDFStreamReader {');
    const baseEnd = source.indexOf('\n;//', baseStart);
    const readerStart = source.indexOf('class PDFFetchStreamReader extends');
    const readerEnd = source.indexOf('\n;//', readerStart);
    const context = vm.createContext({
        Promise, Headers, AbortController,
        fetchUrl(url, headers, credentials, controller) {
            const pending = new Promise((resolve, reject) => { rejectFetch = reject; });
            controller.signal.addEventListener('abort', () => rejectFetch(fetchError), { once: true });
            return pending;
        },
    });
    const [FullReader, RangeReader] = vm.runInContext(
        `${source.slice(baseStart, baseEnd)}\n${source.slice(readerStart, readerEnd)}\n` +
        '[PDFFetchStreamReader, PDFFetchStreamRangeReader]', context,
    );
    const stream = { _source: { url: new URL('http://127.0.0.1/test.pdf') }, headers: {} };
    const reader = kind === 'full' ? new FullReader(stream) : new RangeReader(stream, 0, 65536);
    return { reader, fetchError, rejectFetch: error => rejectFetch(error) };
}

for (const kind of ['full', 'range']) {
    test(`${kind} reader cancellation before read handles abort while preserving it for callers`, async () => {
        const { reader, fetchError } = createFetchReader(kind);
        reader.cancel(new Error('Document was closed'));
        // A document can be closed before anyone starts reading headers/body.
        // The abort must not become an unhandled rejection during that gap.
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(reader.read(), error => error === fetchError);
    });

    test(`${kind} reader cancellation consumes body-reader cleanup rejection`, async () => {
        const { reader, fetchError } = createFetchReader(kind);
        let cancelled = 0;
        reader._reader = {
            cancel() {
                cancelled++;
                return Promise.reject(new Error('The response body is already errored'));
            },
        };
        reader.cancel(new Error('Document was closed'));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(cancelled, 1);
        await assert.rejects(reader.read(), error => error === fetchError);
    });

    test(`${kind} reader still rejects ordinary network errors`, async () => {
        const { reader, rejectFetch } = createFetchReader(kind);
        const read = reader.read();
        const networkError = new Error('Connection refused');
        rejectFetch(networkError);
        await assert.rejects(read, error => error === networkError);
    });
}
