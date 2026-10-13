use tauri::State;

use crate::db::BookDatabase;
use crate::models::{Book, BookUpdate};

const MAX_SPOTLIGHT_QUERY_CHARS: usize = 128;
const MAX_SPOTLIGHT_RESULTS: usize = 1000;

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
        let pdfs_dir = crate::data_paths::user_data_dir().join("pdfs");
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

#[tauri::command]
pub fn search_pdf_content_paths(query: String) -> Vec<String> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }

    let pdfs_dir = crate::data_paths::user_data_dir().join("pdfs");
    if !pdfs_dir.exists() {
        return Vec::new();
    }

    let escaped = escape_spotlight_query_text(query);
    if escaped.is_empty() {
        return Vec::new();
    }
    let md_query = format!("kMDItemTextContent == \"*{}*\"cd", escaped);

    let Ok(output) = std::process::Command::new("/usr/bin/mdfind")
        .arg("-onlyin")
        .arg(&pdfs_dir)
        .arg(md_query)
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.to_lowercase().ends_with(".pdf"))
        .take(MAX_SPOTLIGHT_RESULTS)
        .map(|line| {
            std::fs::canonicalize(line)
                .unwrap_or_else(|_| std::path::PathBuf::from(line))
                .to_string_lossy()
                .to_string()
        })
        .collect()
}

fn escape_spotlight_query_text(query: &str) -> String {
    query
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_SPOTLIGHT_QUERY_CHARS)
        .flat_map(|c| match c {
            '\\' | '"' | '*' | '?' => vec!['\\', c],
            _ => vec![c],
        })
        .collect()
}
