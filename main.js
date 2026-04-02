const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const BookDatabase = require('./lib/database');
const { extractCover, getPdfPageCount } = require('./lib/pdf-utils');
const Settings = require('./lib/settings');
const NotionSync = require('./lib/notion-sync');

// ── Paths ────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'paperstock.db');
const coversDir = path.join(userDataPath, 'covers');
const pdfsDir = path.join(userDataPath, 'pdfs');
const settingsPath = path.join(userDataPath, 'settings.json');

let db;
let settings;
let notionSync;
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
                {
                    label: '設定…',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => mainWindow?.webContents.send('menu-open-settings'),
                },
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
    // Delete copied PDF if it's inside our managed pdfs directory
    if (book && book.file_path && book.file_path.startsWith(pdfsDir) && fs.existsSync(book.file_path)) {
        fs.unlinkSync(book.file_path);
    }
    db.removeBook(id);
});
ipcMain.handle('update-book', async (_, id, updates) => {
    const book = db.updateBook(id, updates);
    // Auto-sync to Notion on status/favorite change
    if (notionSync && (updates.status !== undefined || updates.favorite !== undefined || updates.lastOpenedAt !== undefined)) {
        notionSync.syncBook(book).catch(() => {});
    }
    return book;
});

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

// Import a PDF — copy to app data directory
ipcMain.handle('import-pdf', async (_, filePath) => {
    const basename = path.basename(filePath);
    let destPath = path.join(pdfsDir, basename);

    // Check if the same destination path already exists in DB
    try {
        const existing = db.getAllBooks().find(b => b.file_path === destPath);
        if (existing) return existing;
    } catch (e) { /* continue */ }

    // Check if file with same name already exists on disk
    if (fs.existsSync(destPath)) {
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['別名で保存', 'スキップ'],
            defaultId: 0,
            cancelId: 1,
            title: 'ファイル名の重複',
            message: `「${basename}」は既に存在します`,
            detail: '別名で保存しますか？',
        });
        if (response === 1) return null; // skip

        // Generate unique filename with suffix
        const ext = path.extname(basename);
        const name = path.basename(basename, ext);
        let suffix = 1;
        while (fs.existsSync(destPath)) {
            destPath = path.join(pdfsDir, `${name}_${suffix}${ext}`);
            suffix++;
        }
    }

    // Copy PDF to app data directory
    fs.copyFileSync(filePath, destPath);

    const title = path.basename(destPath, '.pdf');
    const pageCount = await getPdfPageCount(destPath);
    const book = db.addBook({ title, filePath: destPath, coverPath: null, pageCount });

    const coverPath = await extractCover(destPath, coversDir, book.id);
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

// Bookmarks
ipcMain.handle('add-bookmark', (_, data) => db.addBookmark(data));
ipcMain.handle('get-bookmarks', (_, bookId) => db.getBookmarks(bookId));
ipcMain.handle('update-bookmark', (_, id, data) => db.updateBookmark(id, data));
ipcMain.handle('delete-bookmark', (_, id) => db.deleteBookmark(id));

// Settings
ipcMain.handle('get-settings', () => settings.getAll());
ipcMain.handle('update-settings', (_, updates) => {
    settings.update(updates);
    notionSync.resetClient(); // reset in case token changed
    return settings.getAll();
});

// Notion sync
ipcMain.handle('notion-test-connection', async () => {
    return await notionSync.testConnection();
});
ipcMain.handle('notion-sync-all', async () => {
    return await notionSync.syncAllBooks();
});
ipcMain.handle('notion-sync-book', async (_, bookId) => {
    const book = db.getBook(bookId);
    if (book) await notionSync.syncBook(book);
});

// ── Migration for existing books ─────────────────────
async function migrateExistingBooks() {
    const books = db.getAllBooks();
    for (const book of books) {
        if (book.file_path && !book.file_path.startsWith(pdfsDir)) {
            if (fs.existsSync(book.file_path)) {
                const basename = path.basename(book.file_path);
                let destPath = path.join(pdfsDir, basename);
                if (fs.existsSync(destPath)) {
                    const ext = path.extname(basename);
                    const name = path.basename(basename, ext);
                    let suffix = 1;
                    while (fs.existsSync(destPath)) {
                        destPath = path.join(pdfsDir, `${name}_${suffix}${ext}`);
                        suffix++;
                    }
                }
                try {
                    fs.copyFileSync(book.file_path, destPath);
                    db.updateBook(book.id, { filePath: destPath });
                } catch (e) {
                    console.warn(`Failed to migrate PDF for book ${book.id}:`, e.message);
                }
            }
        }
    }
}

// ── App Lifecycle ────────────────────────────────────
app.whenReady().then(() => {
    db = new BookDatabase(dbPath);
    settings = new Settings(settingsPath);
    notionSync = new NotionSync(settings, db);
    if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir, { recursive: true });
    buildMenu();
    createMainWindow();
    migrateExistingBooks();

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
