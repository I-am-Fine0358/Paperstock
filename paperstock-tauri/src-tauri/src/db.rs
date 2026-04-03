use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::models::*;

pub struct BookDatabase {
    pub conn: Mutex<Connection>,
}

impl BookDatabase {
    pub fn new(db_path: &str) -> Self {
        let conn = Connection::open(db_path).expect("Failed to open database");

        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .expect("Failed to set WAL mode");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("Failed to enable foreign keys");

        // Create tables
        conn.execute_batch(
            "
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
            ",
        )
        .expect("Failed to create tables");

        // Migration: add status column if missing
        let has_status: bool = conn
            .prepare("SELECT status FROM books LIMIT 1")
            .is_ok();
        if !has_status {
            conn.execute_batch("ALTER TABLE books ADD COLUMN status TEXT DEFAULT 'unread'")
                .expect("Failed to add status column");
        }

        // Migration: add favorite column if missing
        let has_favorite: bool = conn
            .prepare("SELECT favorite FROM books LIMIT 1")
            .is_ok();
        if !has_favorite {
            conn.execute_batch("ALTER TABLE books ADD COLUMN favorite INTEGER DEFAULT 0")
                .expect("Failed to add favorite column");
        }

        // Migration: add last_opened_at column if missing
        let has_last_opened: bool = conn
            .prepare("SELECT last_opened_at FROM books LIMIT 1")
            .is_ok();
        if !has_last_opened {
            conn.execute_batch("ALTER TABLE books ADD COLUMN last_opened_at DATETIME")
                .expect("Failed to add last_opened_at column");
        }

        // Migration: add last_page column if missing
        let has_last_page: bool = conn
            .prepare("SELECT last_page FROM books LIMIT 1")
            .is_ok();
        if !has_last_page {
            conn.execute_batch("ALTER TABLE books ADD COLUMN last_page INTEGER DEFAULT 1")
                .expect("Failed to add last_page column");
        }

        Self {
            conn: Mutex::new(conn),
        }
    }

    // ── Books ──────────────────────────────────────────

    pub fn add_book(
        &self,
        title: &str,
        file_path: &str,
        cover_path: Option<&str>,
        page_count: i64,
    ) -> Book {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (title, file_path, cover_path, page_count) VALUES (?1, ?2, ?3, ?4)",
            params![title, file_path, cover_path, page_count],
        )
        .expect("Failed to insert book");
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_book(id).expect("Failed to retrieve inserted book")
    }

    pub fn get_book(&self, id: i64) -> Option<Book> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, file_path, cover_path, page_count, status, favorite, last_opened_at, last_page, created_at, updated_at FROM books WHERE id = ?1",
            )
            .ok()?;
        let mut book = stmt
            .query_row(params![id], |row| {
                Ok(Book {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    file_path: row.get(2)?,
                    cover_path: row.get(3)?,
                    page_count: row.get(4)?,
                    status: row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "unread".to_string()),
                    favorite: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    last_opened_at: row.get(7)?,
                    last_page: row.get::<_, Option<i64>>(8)?.unwrap_or(1),
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    tags: Vec::new(),
                })
            })
            .ok()?;
        let tags = Self::get_book_tags_with_conn(&conn, book.id);
        book.tags = tags;
        Some(book)
    }

    pub fn get_all_books(&self) -> Vec<Book> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, file_path, cover_path, page_count, status, favorite, last_opened_at, last_page, created_at, updated_at FROM books ORDER BY updated_at DESC",
            )
            .expect("Failed to prepare get_all_books");
        let books = stmt
            .query_map([], |row| {
                Ok(Book {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    file_path: row.get(2)?,
                    cover_path: row.get(3)?,
                    page_count: row.get(4)?,
                    status: row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "unread".to_string()),
                    favorite: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    last_opened_at: row.get(7)?,
                    last_page: row.get::<_, Option<i64>>(8)?.unwrap_or(1),
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    tags: Vec::new(),
                })
            })
            .expect("Failed to query books")
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        let mut result = Vec::with_capacity(books.len());
        for mut book in books {
            book.tags = Self::get_book_tags_with_conn(&conn, book.id);
            result.push(book);
        }
        result
    }

    pub fn get_books_by_tag(&self, tag_id: i64) -> Vec<Book> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT b.id, b.title, b.file_path, b.cover_path, b.page_count, b.status, b.favorite, b.last_opened_at, b.last_page, b.created_at, b.updated_at FROM books b JOIN book_tags bt ON b.id = bt.book_id WHERE bt.tag_id = ?1 ORDER BY b.updated_at DESC",
            )
            .expect("Failed to prepare get_books_by_tag");
        let books = stmt
            .query_map(params![tag_id], |row| {
                Ok(Book {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    file_path: row.get(2)?,
                    cover_path: row.get(3)?,
                    page_count: row.get(4)?,
                    status: row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "unread".to_string()),
                    favorite: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    last_opened_at: row.get(7)?,
                    last_page: row.get::<_, Option<i64>>(8)?.unwrap_or(1),
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    tags: Vec::new(),
                })
            })
            .expect("Failed to query books by tag")
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        let mut result = Vec::with_capacity(books.len());
        for mut book in books {
            book.tags = Self::get_book_tags_with_conn(&conn, book.id);
            result.push(book);
        }
        result
    }

    pub fn search_books(&self, query: &str) -> Vec<Book> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", query);
        let mut stmt = conn
            .prepare(
                "SELECT id, title, file_path, cover_path, page_count, status, favorite, last_opened_at, last_page, created_at, updated_at FROM books WHERE title LIKE ?1 ORDER BY updated_at DESC",
            )
            .expect("Failed to prepare search_books");
        let books = stmt
            .query_map(params![pattern], |row| {
                Ok(Book {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    file_path: row.get(2)?,
                    cover_path: row.get(3)?,
                    page_count: row.get(4)?,
                    status: row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "unread".to_string()),
                    favorite: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    last_opened_at: row.get(7)?,
                    last_page: row.get::<_, Option<i64>>(8)?.unwrap_or(1),
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    tags: Vec::new(),
                })
            })
            .expect("Failed to search books")
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        let mut result = Vec::with_capacity(books.len());
        for mut book in books {
            book.tags = Self::get_book_tags_with_conn(&conn, book.id);
            result.push(book);
        }
        result
    }

    pub fn update_book(&self, id: i64, updates: &BookUpdate) -> Option<Book> {
        let conn = self.conn.lock().unwrap();
        let mut fields: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref title) = updates.title {
            fields.push("title = ?".to_string());
            values.push(Box::new(title.clone()));
        }
        if let Some(ref cover_path) = updates.cover_path {
            fields.push("cover_path = ?".to_string());
            values.push(Box::new(cover_path.clone()));
        }
        if let Some(ref status) = updates.status {
            fields.push("status = ?".to_string());
            values.push(Box::new(status.clone()));
        }
        if let Some(ref file_path) = updates.file_path {
            fields.push("file_path = ?".to_string());
            values.push(Box::new(file_path.clone()));
        }
        if let Some(favorite) = updates.favorite {
            fields.push("favorite = ?".to_string());
            values.push(Box::new(favorite));
        }
        if let Some(ref last_opened_at) = updates.last_opened_at {
            fields.push("last_opened_at = ?".to_string());
            values.push(Box::new(last_opened_at.clone()));
        }
        if let Some(last_page) = updates.last_page {
            fields.push("last_page = ?".to_string());
            values.push(Box::new(last_page));
        }

        fields.push("updated_at = CURRENT_TIMESTAMP".to_string());
        values.push(Box::new(id));

        let sql = format!(
            "UPDATE books SET {} WHERE id = ?",
            fields.join(", ")
        );
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .expect("Failed to update book");
        drop(conn);
        self.get_book(id)
    }

    pub fn remove_book(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM books WHERE id = ?1", params![id])
            .expect("Failed to remove book");
    }

    // ── Tags ───────────────────────────────────────────

    pub fn add_tag(&self, name: &str, color: &str) -> Tag {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tags (name, color) VALUES (?1, ?2)",
            params![name, color],
        )
        .expect("Failed to insert tag");
        let id = conn.last_insert_rowid();
        conn.query_row("SELECT id, name, color FROM tags WHERE id = ?1", params![id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .expect("Failed to retrieve inserted tag")
    }

    pub fn get_tag(&self, id: i64) -> Option<Tag> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id, name, color FROM tags WHERE id = ?1", params![id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .ok()
    }

    pub fn get_all_tags(&self) -> Vec<Tag> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, color FROM tags ORDER BY name")
            .expect("Failed to prepare get_all_tags");
        stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .expect("Failed to query tags")
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn update_tag(&self, id: i64, update: &TagUpdate) -> Option<Tag> {
        let conn = self.conn.lock().unwrap();
        let mut fields: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref name) = update.name {
            fields.push("name = ?".to_string());
            values.push(Box::new(name.clone()));
        }
        if let Some(ref color) = update.color {
            fields.push("color = ?".to_string());
            values.push(Box::new(color.clone()));
        }
        if fields.is_empty() {
            drop(conn);
            return self.get_tag(id);
        }

        values.push(Box::new(id));
        let sql = format!("UPDATE tags SET {} WHERE id = ?", fields.join(", "));
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .expect("Failed to update tag");
        drop(conn);
        self.get_tag(id)
    }

    pub fn delete_tag(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
            .expect("Failed to delete tag");
    }

    // ── Book <-> Tag ───────────────────────────────────

    pub fn assign_tag(&self, book_id: i64, tag_id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?1, ?2)",
            params![book_id, tag_id],
        )
        .expect("Failed to assign tag");
    }

    pub fn unassign_tag(&self, book_id: i64, tag_id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM book_tags WHERE book_id = ?1 AND tag_id = ?2",
            params![book_id, tag_id],
        )
        .expect("Failed to unassign tag");
    }

    pub fn get_book_tags(&self, book_id: i64) -> Vec<Tag> {
        let conn = self.conn.lock().unwrap();
        Self::get_book_tags_with_conn(&conn, book_id)
    }

    fn get_book_tags_with_conn(conn: &Connection, book_id: i64) -> Vec<Tag> {
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.name, t.color FROM tags t JOIN book_tags bt ON t.id = bt.tag_id WHERE bt.book_id = ?1 ORDER BY t.name",
            )
            .expect("Failed to prepare get_book_tags");
        stmt.query_map(params![book_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .expect("Failed to query book tags")
        .filter_map(|r| r.ok())
        .collect()
    }

    // ── Comments ───────────────────────────────────────

    pub fn add_comment(&self, input: &CommentInput) -> Comment {
        let conn = self.conn.lock().unwrap();
        let content = input.content.clone().unwrap_or_default();
        let color = input.color.clone().unwrap_or_else(|| "#ffcc00".to_string());
        conn.execute(
            "INSERT INTO comments (book_id, page_num, x, y, content, color) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![input.book_id, input.page_num, input.x, input.y, content, color],
        )
        .expect("Failed to insert comment");
        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, book_id, page_num, x, y, content, color, created_at, updated_at FROM comments WHERE id = ?1",
            params![id],
            |row| {
                Ok(Comment {
                    id: row.get(0)?,
                    book_id: row.get(1)?,
                    page_num: row.get(2)?,
                    x: row.get(3)?,
                    y: row.get(4)?,
                    content: row.get(5)?,
                    color: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .expect("Failed to retrieve inserted comment")
    }

    pub fn get_comments_for_book(&self, book_id: i64) -> Vec<Comment> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, book_id, page_num, x, y, content, color, created_at, updated_at FROM comments WHERE book_id = ?1 ORDER BY page_num, id",
            )
            .expect("Failed to prepare get_comments_for_book");
        stmt.query_map(params![book_id], |row| {
            Ok(Comment {
                id: row.get(0)?,
                book_id: row.get(1)?,
                page_num: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                content: row.get(5)?,
                color: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .expect("Failed to query comments")
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn get_comments_for_page(&self, book_id: i64, page_num: i64) -> Vec<Comment> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, book_id, page_num, x, y, content, color, created_at, updated_at FROM comments WHERE book_id = ?1 AND page_num = ?2 ORDER BY id",
            )
            .expect("Failed to prepare get_comments_for_page");
        stmt.query_map(params![book_id, page_num], |row| {
            Ok(Comment {
                id: row.get(0)?,
                book_id: row.get(1)?,
                page_num: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                content: row.get(5)?,
                color: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .expect("Failed to query comments for page")
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn update_comment(&self, id: i64, update: &CommentUpdate) -> Option<Comment> {
        let conn = self.conn.lock().unwrap();
        let mut fields: Vec<String> = vec!["updated_at = CURRENT_TIMESTAMP".to_string()];
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref content) = update.content {
            fields.push("content = ?".to_string());
            values.push(Box::new(content.clone()));
        }
        if let Some(ref color) = update.color {
            fields.push("color = ?".to_string());
            values.push(Box::new(color.clone()));
        }

        values.push(Box::new(id));
        let sql = format!("UPDATE comments SET {} WHERE id = ?", fields.join(", "));
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .expect("Failed to update comment");

        conn.query_row(
            "SELECT id, book_id, page_num, x, y, content, color, created_at, updated_at FROM comments WHERE id = ?1",
            params![id],
            |row| {
                Ok(Comment {
                    id: row.get(0)?,
                    book_id: row.get(1)?,
                    page_num: row.get(2)?,
                    x: row.get(3)?,
                    y: row.get(4)?,
                    content: row.get(5)?,
                    color: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .ok()
    }

    pub fn delete_comment(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM comments WHERE id = ?1", params![id])
            .expect("Failed to delete comment");
    }

    // ── Bookmarks ──────────────────────────────────────

    pub fn add_bookmark(&self, input: &BookmarkInput) -> Bookmark {
        let conn = self.conn.lock().unwrap();
        let label = input.label.clone().unwrap_or_default();
        conn.execute(
            "INSERT INTO bookmarks (book_id, page_num, label) VALUES (?1, ?2, ?3)",
            params![input.book_id, input.page_num, label],
        )
        .expect("Failed to insert bookmark");
        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, book_id, page_num, label, created_at FROM bookmarks WHERE id = ?1",
            params![id],
            |row| {
                Ok(Bookmark {
                    id: row.get(0)?,
                    book_id: row.get(1)?,
                    page_num: row.get(2)?,
                    label: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .expect("Failed to retrieve inserted bookmark")
    }

    pub fn get_bookmarks(&self, book_id: i64) -> Vec<Bookmark> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, book_id, page_num, label, created_at FROM bookmarks WHERE book_id = ?1 ORDER BY page_num",
            )
            .expect("Failed to prepare get_bookmarks");
        stmt.query_map(params![book_id], |row| {
            Ok(Bookmark {
                id: row.get(0)?,
                book_id: row.get(1)?,
                page_num: row.get(2)?,
                label: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .expect("Failed to query bookmarks")
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn update_bookmark(&self, id: i64, update: &BookmarkUpdate) -> Option<Bookmark> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE bookmarks SET label = ?1 WHERE id = ?2",
            params![update.label, id],
        )
        .expect("Failed to update bookmark");
        conn.query_row(
            "SELECT id, book_id, page_num, label, created_at FROM bookmarks WHERE id = ?1",
            params![id],
            |row| {
                Ok(Bookmark {
                    id: row.get(0)?,
                    book_id: row.get(1)?,
                    page_num: row.get(2)?,
                    label: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .ok()
    }

    pub fn delete_bookmark(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])
            .expect("Failed to delete bookmark");
    }
}
