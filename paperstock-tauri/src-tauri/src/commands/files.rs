use std::path::{Path, PathBuf};

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::db::BookDatabase;
use crate::models::{Book, BookUpdate};

/// Return the managed pdfs directory: ~/Library/Application Support/Paperstock/pdfs
fn pdfs_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap()
        .join("Paperstock")
        .join("pdfs")
}

/// Return the managed covers directory: ~/Library/Application Support/Paperstock/covers
fn covers_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap()
        .join("Paperstock")
        .join("covers")
}

#[tauri::command]
pub async fn select_pdf_files(app: tauri::AppHandle) -> Vec<String> {
    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .pick_files(move |paths| {
            let result = paths
                .unwrap_or_default()
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect::<Vec<_>>();
            let _ = tx.send(result);
        });

    rx.recv().unwrap_or_default()
}

#[tauri::command]
pub async fn select_cover_image(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .pick_file(move |path| {
            let result = path
                .and_then(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string());
            let _ = tx.send(result);
        });

    rx.recv().unwrap_or(None)
}

#[tauri::command]
pub async fn import_pdf(
    db: State<'_, BookDatabase>,
    app: tauri::AppHandle,
    file_path: String,
) -> Result<Option<Book>, String> {
    let pdfs_dir = pdfs_dir();
    let covers_dir = covers_dir();

    // Ensure directories exist
    std::fs::create_dir_all(&pdfs_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&covers_dir).map_err(|e| e.to_string())?;

    let source = Path::new(&file_path);
    let basename = source
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?;

    let mut dest_path = pdfs_dir.join(basename);

    // Check if a book with the same dest_path already exists in DB
    let dest_str = dest_path.to_string_lossy().to_string();
    let existing = db.get_all_books().into_iter().find(|b| b.file_path == dest_str);
    if let Some(book) = existing {
        return Ok(Some(book));
    }

    // If a file already exists at dest_path on disk, ask user
    if dest_path.exists() {
        let (tx, rx) = std::sync::mpsc::channel();

        app.dialog()
            .message(format!(
                "「{}」は既に存在します。別名で保存しますか？",
                basename.to_string_lossy()
            ))
            .title("ファイルの重複")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("別名で保存".to_string(), "スキップ".to_string()))
            .show(move |confirmed| {
                let _ = tx.send(confirmed);
            });

        let confirmed = rx.recv().unwrap_or(false);
        if !confirmed {
            return Ok(None);
        }

        // Generate a unique filename with _1, _2, ... suffix
        let stem = source
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = source
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let mut counter = 1u32;
        loop {
            let new_name = format!("{}_{}.{}", stem, counter, ext);
            dest_path = pdfs_dir.join(&new_name);
            if !dest_path.exists() {
                break;
            }
            counter += 1;
        }
    }

    // Copy the PDF to the managed directory
    std::fs::copy(&file_path, &dest_path).map_err(|e| e.to_string())?;

    let dest_str = dest_path.to_string_lossy().to_string();
    let title = dest_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Get page count
    let page_count = crate::pdf_utils::get_page_count(&dest_str);

    // Add book to database
    let book = db.add_book(&title, &dest_str, None, page_count);

    // Extract cover image
    let cover_path = crate::pdf_utils::extract_cover(&dest_str, covers_dir.to_str().unwrap_or(""), book.id);

    // Update book with cover_path if extraction succeeded
    let book = if let Some(ref cp) = cover_path {
        let updates = BookUpdate {
            cover_path: Some(cp.clone()),
            ..Default::default()
        };
        db.update_book(book.id, &updates).unwrap_or(book)
    } else {
        book
    };

    Ok(Some(book))
}

#[tauri::command]
pub fn set_custom_cover(
    db: State<BookDatabase>,
    book_id: i64,
    image_path: String,
) -> Option<Book> {
    let covers_dir = covers_dir();
    let _ = std::fs::create_dir_all(&covers_dir);

    let source = Path::new(&image_path);
    let ext = source
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let dest_name = format!("cover_{}.{}", book_id, ext);
    let dest_path = covers_dir.join(&dest_name);

    if std::fs::copy(&image_path, &dest_path).is_err() {
        return None;
    }

    let cover_str = dest_path.to_string_lossy().to_string();
    let updates = BookUpdate {
        cover_path: Some(cover_str),
        ..Default::default()
    };
    db.update_book(book_id, &updates)
}

#[tauri::command]
pub fn show_in_finder(file_path: String) {
    let _ = std::process::Command::new("open")
        .arg("-R")
        .arg(&file_path)
        .spawn();
}
