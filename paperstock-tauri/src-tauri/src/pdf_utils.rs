use std::process::Command;
use std::path::{Path, PathBuf};
use std::fs;

/// Extract cover image from PDF using macOS qlmanage
pub fn extract_cover(pdf_path: &str, output_dir: &str, book_id: i64) -> Option<String> {
    let output_path = Path::new(output_dir).join(format!("cover_{}.png", book_id));
    fs::create_dir_all(output_dir).ok()?;

    let tmp_dir = Path::new(output_dir).join(format!(".tmp_{}", book_id));
    fs::create_dir_all(&tmp_dir).ok()?;

    let result = Command::new("qlmanage")
        .args(["-t", "-s", "600", "-o"])
        .arg(&tmp_dir)
        .arg(pdf_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();

    match result {
        Ok(output) if output.status.success() => {
            if let Ok(entries) = fs::read_dir(&tmp_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |ext| ext == "png") {
                        fs::copy(&path, &output_path).ok()?;
                        cleanup_dir(&tmp_dir);
                        return Some(output_path.to_string_lossy().to_string());
                    }
                }
            }
            cleanup_dir(&tmp_dir);
            None
        }
        _ => {
            cleanup_dir(&tmp_dir);
            None
        }
    }
}

fn cleanup_dir(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
    let _ = fs::remove_dir(dir);
}

/// Get PDF page count using lopdf
pub fn get_page_count(pdf_path: &str) -> i64 {
    match lopdf::Document::load(pdf_path) {
        Ok(doc) => doc.get_pages().len() as i64,
        Err(_) => fallback_page_count(pdf_path),
    }
}

fn fallback_page_count(pdf_path: &str) -> i64 {
    match fs::read(pdf_path) {
        Ok(data) => {
            let content = String::from_utf8_lossy(&data);
            // Match /Type /Page but not /Type /Pages (same as JS regex /\/Type\s*\/Page[^s]/g)
            let mut count = 0i64;
            let bytes = content.as_bytes();
            let needle = b"/Type";
            for i in 0..bytes.len().saturating_sub(15) {
                if bytes[i..].starts_with(needle) {
                    let rest = &content[i + 5..std::cmp::min(i + 20, content.len())];
                    let trimmed = rest.trim_start();
                    if trimmed.starts_with("/Page") && !trimmed.starts_with("/Pages") {
                        count += 1;
                    }
                }
            }
            count
        }
        Err(_) => 0,
    }
}

/// Migrate existing books whose file_path is outside pdfs_dir
pub fn migrate_existing_books(db: &crate::db::BookDatabase, pdfs_dir: &str) {
    let books = db.get_all_books();
    for book in books {
        if !book.file_path.starts_with(pdfs_dir) {
            if Path::new(&book.file_path).exists() {
                let basename = Path::new(&book.file_path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let mut dest_path = PathBuf::from(pdfs_dir).join(&basename);

                if dest_path.exists() {
                    let stem = Path::new(&basename).file_stem()
                        .unwrap_or_default().to_string_lossy().to_string();
                    let ext = Path::new(&basename).extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                        .unwrap_or_default();
                    let mut suffix = 1;
                    while dest_path.exists() {
                        dest_path = PathBuf::from(pdfs_dir)
                            .join(format!("{}_{}{}", stem, suffix, ext));
                        suffix += 1;
                    }
                }

                match fs::copy(&book.file_path, &dest_path) {
                    Ok(_) => {
                        use crate::models::BookUpdate;
                        db.update_book(book.id, &BookUpdate {
                            file_path: Some(dest_path.to_string_lossy().to_string()),
                            ..Default::default()
                        });
                    }
                    Err(e) => {
                        eprintln!("Failed to migrate PDF for book {}: {}", book.id, e);
                    }
                }
            }
        }
    }
}
