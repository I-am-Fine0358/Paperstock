use tauri::State;

use crate::db::BookDatabase;
use crate::models::{Comment, CommentInput, CommentUpdate};

#[tauri::command]
pub fn add_comment(db: State<BookDatabase>, data: CommentInput) -> Comment {
    db.add_comment(&data)
}

#[tauri::command]
pub fn get_comments(db: State<BookDatabase>, book_id: i64) -> Vec<Comment> {
    db.get_comments_for_book(book_id)
}

#[tauri::command]
pub fn get_page_comments(db: State<BookDatabase>, book_id: i64, page_num: i64) -> Vec<Comment> {
    db.get_comments_for_page(book_id, page_num)
}

#[tauri::command]
pub fn update_comment(db: State<BookDatabase>, id: i64, data: CommentUpdate) -> Option<Comment> {
    db.update_comment(id, &data)
}

#[tauri::command]
pub fn delete_comment(db: State<BookDatabase>, id: i64) {
    db.delete_comment(id);
}
