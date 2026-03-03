const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const BookDatabase = require('./lib/database');
const { extractCover, getPdfPageCount } = require('./lib/pdf-utils');

// ── Paths ────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'paperstock.db');
const coversDir = path.join(userDataPath, 'covers');

let db;
let mainWindow;

// ── Window ───────────────────────────────────────────
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 900,
        minHeight: 600,
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 16 },
        backgroundColor: '#f5f5f7',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// ── App Menu ─────────────────────────────────────────
function buildMenu() {
    const template = [
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'ファイル',
            submenu: [
                {
                    label: 'PDFを追加…',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => mainWindow?.webContents.send('menu-add-books'),
                },
                { type: 'separator' },
                {
                    label: 'タブを閉じる',
                    accelerator: 'CmdOrCtrl+W',
                    click: () => mainWindow?.webContents.send('menu-close-tab'),
                },
            ],
        },
        {
            label: '編集',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: '表示',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: 'ウィンドウ',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                { role: 'front' },
            ],
        },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC Handlers ─────────────────────────────────────

// Books
ipcMain.handle('get-books', () => db.getAllBooks());
ipcMain.handle('get-books-by-tag', (_, tagId) => db.getBooksByTag(tagId));
ipcMain.handle('search-books', (_, query) => db.searchBooks(query));
ipcMain.handle('get-book', (_, id) => db.getBook(id));
ipcMain.handle('remove-book', (_, id) => {
    const book = db.getBook(id);
    if (book && book.cover_path && fs.existsSync(book.cover_path)) {
        fs.unlinkSync(book.cover_path);
    }
    db.removeBook(id);
});
ipcMain.handle('update-book', (_, id, updates) => db.updateBook(id, updates));

// Tags
ipcMain.handle('get-tags', () => db.getAllTags());
ipcMain.handle('add-tag', (_, name, color) => db.addTag(name, color));
ipcMain.handle('update-tag', (_, id, data) => db.updateTag(id, data));
ipcMain.handle('delete-tag', (_, id) => db.deleteTag(id));
ipcMain.handle('assign-tag', (_, bookId, tagId) => db.assignTag(bookId, tagId));
ipcMain.handle('unassign-tag', (_, bookId, tagId) => db.unassignTag(bookId, tagId));

// File dialogs
ipcMain.handle('select-pdf-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    return result.filePaths;
});

ipcMain.handle('select-cover-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    return result.filePaths[0] || null;
});

// Import a PDF
ipcMain.handle('import-pdf', async (_, filePath) => {
    try {
        const existing = db.getAllBooks().find(b => b.file_path === filePath);
        if (existing) return existing;
    } catch (e) { /* continue */ }

    const title = path.basename(filePath, '.pdf');
    const pageCount = await getPdfPageCount(filePath);
    const book = db.addBook({ title, filePath, coverPath: null, pageCount });

    const coverPath = await extractCover(filePath, coversDir, book.id);
    if (coverPath) {
        db.updateBook(book.id, { coverPath });
        book.cover_path = coverPath;
    }

    return book;
});

// Set custom cover
ipcMain.handle('set-custom-cover', async (_, bookId, imagePath) => {
    const destPath = path.join(coversDir, `cover_${bookId}${path.extname(imagePath)}`);
    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
    fs.copyFileSync(imagePath, destPath);
    return db.updateBook(bookId, { coverPath: destPath });
});

// Get cover image as data URL
ipcMain.handle('get-cover-data', (_, coverPath) => {
    if (!coverPath || !fs.existsSync(coverPath)) return null;
    const ext = path.extname(coverPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const data = fs.readFileSync(coverPath);
    return `data:${mime};base64,${data.toString('base64')}`;
});

// Show in Finder
ipcMain.handle('show-in-finder', (_, filePath) => {
    shell.showItemInFolder(filePath);
});

// PDF.js paths for renderer
ipcMain.handle('get-pdfjs-paths', () => {
    const basePath = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build');
    return {
        pdf: 'file://' + path.join(basePath, 'pdf.mjs'),
        worker: 'file://' + path.join(basePath, 'pdf.worker.mjs'),
    };
});

// Read PDF file as binary data for renderer
ipcMain.handle('read-pdf-file', (_, filePath) => {
    const data = fs.readFileSync(filePath);
    return data;
});

// Comments
ipcMain.handle('add-comment', (_, data) => db.addComment(data));
ipcMain.handle('get-comments', (_, bookId) => db.getCommentsForBook(bookId));
ipcMain.handle('get-page-comments', (_, bookId, pageNum) => db.getCommentsForPage(bookId, pageNum));
ipcMain.handle('update-comment', (_, id, data) => db.updateComment(id, data));
ipcMain.handle('delete-comment', (_, id) => db.deleteComment(id));

// ── App Lifecycle ────────────────────────────────────
app.whenReady().then(() => {
    db = new BookDatabase(dbPath);
    buildMenu();
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        db?.close();
        app.quit();
    }
});

app.on('before-quit', () => {
    db?.close();
});
