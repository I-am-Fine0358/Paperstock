use std::path::Path;

use base64::Engine;
use tauri::ipc::Response;

#[tauri::command]
pub fn read_pdf_file(file_path: String) -> Result<Response, String> {
    let data = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    Ok(Response::new(data))
}

#[tauri::command]
pub fn get_cover_data(cover_path: String) -> Option<String> {
    let data = std::fs::read(&cover_path).ok()?;

    let ext = Path::new(&cover_path)
        .extension()?
        .to_string_lossy()
        .to_lowercase();

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Some(format!("data:{};base64,{}", mime, b64))
}
