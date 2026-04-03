mod db;
mod models;
mod pdf_utils;
mod commands;
mod menu;

use db::BookDatabase;
use std::fs;
use tauri::{Emitter, Manager};

pub fn run() {
    let user_data = dirs::data_dir()
        .expect("Could not find data directory")
        .join("Paperstock");

    let db_path = user_data.join("paperstock.db");
    let covers_dir = user_data.join("covers");
    let pdfs_dir = user_data.join("pdfs");

    // Ensure directories exist
    fs::create_dir_all(&covers_dir).expect("Failed to create covers directory");
    fs::create_dir_all(&pdfs_dir).expect("Failed to create pdfs directory");

    // Initialize database
    let database = BookDatabase::new(db_path.to_str().unwrap());

    // Migrate existing books to managed pdfs directory
    pdf_utils::migrate_existing_books(&database, pdfs_dir.to_str().unwrap());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(database)
        .invoke_handler(tauri::generate_handler![
            // Books
            commands::books::get_books,
            commands::books::get_books_by_tag,
            commands::books::search_books,
            commands::books::get_book,
            commands::books::remove_book,
            commands::books::update_book,
            // Tags
            commands::tags::get_tags,
            commands::tags::add_tag,
            commands::tags::update_tag,
            commands::tags::delete_tag,
            commands::tags::assign_tag,
            commands::tags::unassign_tag,
            // Comments
            commands::comments::add_comment,
            commands::comments::get_comments,
            commands::comments::get_page_comments,
            commands::comments::update_comment,
            commands::comments::delete_comment,
            // Bookmarks
            commands::bookmarks::add_bookmark,
            commands::bookmarks::get_bookmarks,
            commands::bookmarks::update_bookmark,
            commands::bookmarks::delete_bookmark,
            // Files
            commands::files::select_pdf_files,
            commands::files::select_cover_image,
            commands::files::import_pdf,
            commands::files::set_custom_cover,
            commands::files::show_in_finder,
            // PDF
            commands::pdf::read_pdf_file,
            commands::pdf::get_cover_data,
        ])
        .setup(|app| {
            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "add-pdf" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu-add-books", ());
                        }
                    }
                    "close-tab" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu-close-tab", ());
                        }
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Paperstock");
}
