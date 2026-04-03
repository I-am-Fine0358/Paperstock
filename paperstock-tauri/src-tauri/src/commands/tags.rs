use tauri::State;

use crate::db::BookDatabase;
use crate::models::{Tag, TagUpdate};

#[tauri::command]
pub fn get_tags(db: State<BookDatabase>) -> Vec<Tag> {
    db.get_all_tags()
}

#[tauri::command]
pub fn get_tag(db: State<BookDatabase>, id: i64) -> Option<Tag> {
    db.get_tag(id)
}

#[tauri::command]
pub fn add_tag(db: State<BookDatabase>, name: String, color: String) -> Tag {
    db.add_tag(&name, &color)
}

#[tauri::command]
pub fn update_tag(db: State<BookDatabase>, id: i64, data: TagUpdate) -> Option<Tag> {
    db.update_tag(id, &data)
}

#[tauri::command]
pub fn delete_tag(db: State<BookDatabase>, id: i64) {
    db.delete_tag(id);
}

#[tauri::command]
pub fn assign_tag(db: State<BookDatabase>, book_id: i64, tag_id: i64) {
    db.assign_tag(book_id, tag_id);
}

#[tauri::command]
pub fn unassign_tag(db: State<BookDatabase>, book_id: i64, tag_id: i64) {
    db.unassign_tag(book_id, tag_id);
}
