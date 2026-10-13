mod commands;
mod data_paths;
mod db;
mod menu;
mod models;
mod pdf_server;
mod pdf_utils;
mod shutdown;

use db::BookDatabase;
use std::fs;
use tauri::{Emitter, Manager, WindowEvent};

pub fn run() {
    let user_data = data_paths::user_data_dir();

    let db_path = user_data.join("paperstock.db");
    let covers_dir = user_data.join("covers");
    let pdfs_dir = user_data.join("pdfs");

    // Ensure directories exist
    fs::create_dir_all(&covers_dir).expect("Failed to create covers directory");
    fs::create_dir_all(&pdfs_dir).expect("Failed to create pdfs directory");

    // Initialize database
    let database = BookDatabase::new(db_path.to_str().unwrap());
    let pdf_server = pdf_server::PdfServer::start().expect("Failed to start PDF server");

    // Migrate existing books to managed pdfs directory
    pdf_utils::migrate_existing_books(&database, pdfs_dir.to_str().unwrap());

    let mut context = tauri::generate_context!();
    if std::env::var_os("PAPERSTOCK_DATA_DIR").is_some() {
        // Test runs must not restore or overwrite the real library's tab state.
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(database)
        .manage(pdf_server)
        .manage(shutdown::ShutdownState::default())
        .invoke_handler(tauri::generate_handler![
            // App
            commands::app::request_app_quit,
            commands::app::quit_app,
            // Books
            commands::books::get_books,
            commands::books::get_books_by_tag,
            commands::books::search_books,
            commands::books::get_book,
            commands::books::remove_book,
            commands::books::update_book,
            commands::books::search_pdf_content_paths,
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
            commands::pdf::get_pdf_stream_url,
            commands::pdf::get_cover_data,
        ])
        .setup(|app| {
            // Allow asset protocol to serve PDFs and covers
            let user_data = data_paths::user_data_dir();
            let scopes = app.state::<tauri::scope::Scopes>();
            let _ = scopes.allow_directory(&user_data.join("pdfs"), true);
            let _ = scopes.allow_directory(&user_data.join("covers"), true);

            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;
            shutdown::install_native_quit_shortcut(app.handle())?;

            app.on_menu_event(|app, event| match event.id().as_ref() {
                "quit-app" => shutdown::request(app),
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
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) && window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                }
                shutdown::request(window.app_handle());
            }
        })
        .build(context)
        .expect("error while building Paperstock")
        // RunEvent::Resumed is not a macOS wake notification. Window focus and
        // visibility are handled by the UI; WebKit termination is recovered by
        // tauri-runtime-wry's native reload handler (Tauri >= 2.11).
        // Do not prevent ExitRequested: OS logout/shutdown must remain native.
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown::remove_native_quit_shortcut();
            }
        });
}
