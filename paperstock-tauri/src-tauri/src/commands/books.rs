use tauri::State;

use crate::db::BookDatabase;
use crate::models::{Book, BookUpdate};

#[tauri::command]
pub fn get_books(db: State<BookDatabase>) -> Vec<Book> {
    db.get_all_books()
}

#[tauri::command]
pub fn get_books_by_tag(db: State<BookDatabase>, tag_id: i64) -> Vec<Book> {
    db.get_books_by_tag(tag_id)
}

#[tauri::command]
pub fn search_books(db: State<BookDatabase>, query: String) -> Vec<Book> {
    db.search_books(&query)
}

#[tauri::command]
pub fn get_book(db: State<BookDatabase>, id: i64) -> Option<Book> {
    db.get_book(id)
}

#[tauri::command]
pub fn remove_book(db: State<BookDatabase>, id: i64) {
    let book = db.get_book(id);
    if let Some(book) = book {
        // Delete cover image if it exists
        if let Some(ref cover_path) = book.cover_path {
            let _ = std::fs::remove_file(cover_path);
        }
        // Delete PDF only if it resides in our managed pdfs directory
        let pdfs_dir = dirs::data_dir()
            .unwrap()
            .join("Paperstock")
            .join("pdfs");
        if book.file_path.starts_with(pdfs_dir.to_str().unwrap_or("")) {
            let _ = std::fs::remove_file(&book.file_path);
        }
    }
    db.remove_book(id);
}

#[tauri::command]
pub fn update_book(db: State<BookDatabase>, id: i64, updates: BookUpdate) -> Option<Book> {
    db.update_book(id, &updates)
}
