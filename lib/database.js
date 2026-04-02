const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class BookDatabase {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        cover_path TEXT,
        page_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'unread',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#6366f1'
      );

      CREATE TABLE IF NOT EXISTS book_tags (
        book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
        tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (book_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        page_num INTEGER NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        color TEXT DEFAULT '#ffcc00',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        page_num INTEGER NOT NULL,
        label TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration: add status column if missing
    try {
      this.db.prepare(`SELECT status FROM books LIMIT 1`).get();
    } catch (e) {
      this.db.exec(`ALTER TABLE books ADD COLUMN status TEXT DEFAULT 'unread'`);
    }

    // Migration: add favorite column if missing
    try {
      this.db.prepare(`SELECT favorite FROM books LIMIT 1`).get();
    } catch (e) {
      this.db.exec(`ALTER TABLE books ADD COLUMN favorite INTEGER DEFAULT 0`);
    }

    // Migration: add last_opened_at column if missing
    try {
      this.db.prepare(`SELECT last_opened_at FROM books LIMIT 1`).get();
    } catch (e) {
      this.db.exec(`ALTER TABLE books ADD COLUMN last_opened_at DATETIME`);
    }

    // Migration: add notion_page_id column if missing
    try {
      this.db.prepare(`SELECT notion_page_id FROM books LIMIT 1`).get();
    } catch (e) {
      this.db.exec(`ALTER TABLE books ADD COLUMN notion_page_id TEXT`);
    }
  }

  // ── Books ──────────────────────────────────────────

  addBook({ title, filePath, coverPath, pageCount }) {
    const stmt = this.db.prepare(`
      INSERT INTO books (title, file_path, cover_path, page_count)
      VALUES (?, ?, ?, ?)
    `);
    const info = stmt.run(title, filePath, coverPath || null, pageCount || 0);
    return this.getBook(info.lastInsertRowid);
  }

  getBook(id) {
    const book = this.db.prepare(`SELECT * FROM books WHERE id = ?`).get(id);
    if (book) book.tags = this._getBookTags(book.id);
    return book;
  }

  getAllBooks() {
    const books = this.db.prepare(`SELECT * FROM books ORDER BY updated_at DESC`).all();
    for (const book of books) {
      book.tags = this._getBookTags(book.id);
    }
    return books;
  }

  getBooksByTag(tagId) {
    const books = this.db.prepare(`
      SELECT b.* FROM books b
      JOIN book_tags bt ON b.id = bt.book_id
      WHERE bt.tag_id = ?
      ORDER BY b.updated_at DESC
    `).all(tagId);
    for (const book of books) {
      book.tags = this._getBookTags(book.id);
    }
    return books;
  }

  searchBooks(query) {
    const books = this.db.prepare(`
      SELECT * FROM books WHERE title LIKE ? ORDER BY updated_at DESC
    `).all(`%${query}%`);
    for (const book of books) {
      book.tags = this._getBookTags(book.id);
    }
    return books;
  }

  updateBook(id, updates) {
    const fields = [];
    const values = [];
    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.coverPath !== undefined) { fields.push('cover_path = ?'); values.push(updates.coverPath); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.filePath !== undefined) { fields.push('file_path = ?'); values.push(updates.filePath); }
    if (updates.favorite !== undefined) { fields.push('favorite = ?'); values.push(updates.favorite); }
    if (updates.lastOpenedAt !== undefined) { fields.push('last_opened_at = ?'); values.push(updates.lastOpenedAt); }
    if (updates.notionPageId !== undefined) { fields.push('notion_page_id = ?'); values.push(updates.notionPageId); }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    this.db.prepare(`UPDATE books SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getBook(id);
  }

  removeBook(id) {
    this.db.prepare(`DELETE FROM books WHERE id = ?`).run(id);
  }

  // ── Tags ───────────────────────────────────────────

  addTag(name, color = '#6366f1') {
    const info = this.db.prepare(`INSERT INTO tags (name, color) VALUES (?, ?)`).run(name, color);
    return this.getTag(info.lastInsertRowid);
  }

  getTag(id) {
    return this.db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id);
  }

  getAllTags() {
    return this.db.prepare(`SELECT * FROM tags ORDER BY name`).all();
  }

  updateTag(id, { name, color }) {
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (color !== undefined) { fields.push('color = ?'); values.push(color); }
    if (fields.length === 0) return this.getTag(id);
    values.push(id);
    this.db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getTag(id);
  }

  deleteTag(id) {
    this.db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  }

  // ── Book ↔ Tag ─────────────────────────────────────

  assignTag(bookId, tagId) {
    this.db.prepare(`INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)`).run(bookId, tagId);
  }

  unassignTag(bookId, tagId) {
    this.db.prepare(`DELETE FROM book_tags WHERE book_id = ? AND tag_id = ?`).run(bookId, tagId);
  }

  _getBookTags(bookId) {
    return this.db.prepare(`
      SELECT t.* FROM tags t
      JOIN book_tags bt ON t.id = bt.tag_id
      WHERE bt.book_id = ?
      ORDER BY t.name
    `).all(bookId);
  }

  // ── Comments ───────────────────────────────────────

  addComment({ bookId, pageNum, x, y, content, color }) {
    const info = this.db.prepare(`
      INSERT INTO comments (book_id, page_num, x, y, content, color)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(bookId, pageNum, x, y, content || '', color || '#ffcc00');
    return this.db.prepare(`SELECT * FROM comments WHERE id = ?`).get(info.lastInsertRowid);
  }

  getCommentsForBook(bookId) {
    return this.db.prepare(`SELECT * FROM comments WHERE book_id = ? ORDER BY page_num, id`).all(bookId);
  }

  getCommentsForPage(bookId, pageNum) {
    return this.db.prepare(`SELECT * FROM comments WHERE book_id = ? AND page_num = ? ORDER BY id`).all(bookId, pageNum);
  }

  updateComment(id, { content, color }) {
    const fields = ['updated_at = CURRENT_TIMESTAMP'];
    const values = [];
    if (content !== undefined) { fields.push('content = ?'); values.push(content); }
    if (color !== undefined) { fields.push('color = ?'); values.push(color); }
    values.push(id);
    this.db.prepare(`UPDATE comments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id);
  }

  deleteComment(id) {
    this.db.prepare(`DELETE FROM comments WHERE id = ?`).run(id);
  }

  // ── Bookmarks ───────────────────────────────────────

  addBookmark({ bookId, pageNum, label }) {
    const info = this.db.prepare(`
      INSERT INTO bookmarks (book_id, page_num, label) VALUES (?, ?, ?)
    `).run(bookId, pageNum, label || '');
    return this.db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(info.lastInsertRowid);
  }

  getBookmarks(bookId) {
    return this.db.prepare(`SELECT * FROM bookmarks WHERE book_id = ? ORDER BY page_num`).all(bookId);
  }

  deleteBookmark(id) {
    this.db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id);
  }

  updateBookmark(id, { label }) {
    const info = this.db.prepare(`UPDATE bookmarks SET label = ? WHERE id = ?`).run(label, id);
    return this.db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id);
  }

  close() {
    this.db.close();
  }
}

module.exports = BookDatabase;
