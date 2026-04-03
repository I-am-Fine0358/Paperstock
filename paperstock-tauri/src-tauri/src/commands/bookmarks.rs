use tauri::State;

use crate::db::BookDatabase;
use crate::models::{Bookmark, BookmarkInput, BookmarkUpdate};

#[tauri::command]
pub fn add_bookmark(db: State<BookDatabase>, data: BookmarkInput) -> Bookmark {
    db.add_bookmark(&data)
}

#[tauri::command]
pub fn get_bookmarks(db: State<BookDatabase>, book_id: i64) -> Vec<Bookmark> {
    db.get_bookmarks(book_id)
}

#[tauri::command]
pub fn update_bookmark(db: State<BookDatabase>, id: i64, data: BookmarkUpdate) -> Option<Bookmark> {
    db.update_bookmark(id, &data)
}

#[tauri::command]
pub fn delete_bookmark(db: State<BookDatabase>, id: i64) {
    db.delete_bookmark(id);
}
