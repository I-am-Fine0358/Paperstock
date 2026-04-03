use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem};

pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // App menu (Paperstock)
    let app_menu = SubmenuBuilder::new(app, "Paperstock")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // ファイル menu
    let add_pdf = MenuItemBuilder::with_id("add-pdf", "PDFを追加…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close-tab", "タブを閉じる")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "ファイル")
        .item(&add_pdf)
        .separator()
        .item(&close_tab)
        .build()?;

    // 編集 menu
    let edit_menu = SubmenuBuilder::new(app, "編集")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // 表示 menu
    let view_menu = SubmenuBuilder::new(app, "表示")
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    // ウィンドウ menu
    let window_menu = SubmenuBuilder::new(app, "ウィンドウ")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;

    Ok(menu)
}
