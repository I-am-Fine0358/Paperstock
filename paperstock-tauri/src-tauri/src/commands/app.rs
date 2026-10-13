#[tauri::command]
pub fn request_app_quit(app: tauri::AppHandle) {
    crate::shutdown::request(&app);
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    crate::shutdown::finish(&app);
}
