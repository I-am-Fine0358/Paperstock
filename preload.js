const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Books
    getBooks: () => ipcRenderer.invoke('get-books'),
    getBooksByTag: (tagId) => ipcRenderer.invoke('get-books-by-tag', tagId),
    searchBooks: (query) => ipcRenderer.invoke('search-books', query),
    getBook: (id) => ipcRenderer.invoke('get-book', id),
    removeBook: (id) => ipcRenderer.invoke('remove-book', id),
    updateBook: (id, updates) => ipcRenderer.invoke('update-book', id, updates),
    importPdf: (filePath) => ipcRenderer.invoke('import-pdf', filePath),

    // Tags
    getTags: () => ipcRenderer.invoke('get-tags'),
    addTag: (name, color) => ipcRenderer.invoke('add-tag', name, color),
    updateTag: (id, data) => ipcRenderer.invoke('update-tag', id, data),
    deleteTag: (id) => ipcRenderer.invoke('delete-tag', id),
    assignTag: (bookId, tagId) => ipcRenderer.invoke('assign-tag', bookId, tagId),
    unassignTag: (bookId, tagId) => ipcRenderer.invoke('unassign-tag', bookId, tagId),

    // File dialogs
    selectPdfFiles: () => ipcRenderer.invoke('select-pdf-files'),
    selectCoverImage: () => ipcRenderer.invoke('select-cover-image'),
    setCustomCover: (bookId, imagePath) => ipcRenderer.invoke('set-custom-cover', bookId, imagePath),

    // Covers & Finder
    getCoverData: (coverPath) => ipcRenderer.invoke('get-cover-data', coverPath),
    showInFinder: (filePath) => ipcRenderer.invoke('show-in-finder', filePath),

    // PDF viewing
    getPdfjsPaths: () => ipcRenderer.invoke('get-pdfjs-paths'),
    readPdfFile: (filePath) => ipcRenderer.invoke('read-pdf-file', filePath),

    // Comments
    addComment: (data) => ipcRenderer.invoke('add-comment', data),
    getComments: (bookId) => ipcRenderer.invoke('get-comments', bookId),
    getPageComments: (bookId, pageNum) => ipcRenderer.invoke('get-page-comments', bookId, pageNum),
    updateComment: (id, data) => ipcRenderer.invoke('update-comment', id, data),
    deleteComment: (id) => ipcRenderer.invoke('delete-comment', id),

    // Menu events
    onMenuAddBooks: (callback) => ipcRenderer.on('menu-add-books', callback),
    onMenuCloseTab: (callback) => ipcRenderer.on('menu-close-tab', callback),
});
