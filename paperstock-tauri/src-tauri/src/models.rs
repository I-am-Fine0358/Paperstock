use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: i64,
    pub title: String,
    pub file_path: String,
    pub cover_path: Option<String>,
    pub page_count: i64,
    pub status: String,
    pub favorite: i64,
    pub last_opened_at: Option<String>,
    pub last_page: i64,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<Tag>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Comment {
    pub id: i64,
    pub book_id: i64,
    pub page_num: i64,
    pub x: f64,
    pub y: f64,
    pub content: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub id: i64,
    pub book_id: i64,
    pub page_num: i64,
    pub label: String,
    pub created_at: String,
}

// Input/Update structs for commands

#[derive(Debug, Deserialize)]
pub struct BookUpdate {
    pub title: Option<String>,
    pub cover_path: Option<String>,
    pub status: Option<String>,
    pub file_path: Option<String>,
    pub favorite: Option<i64>,
    pub last_opened_at: Option<String>,
    pub last_page: Option<i64>,
}

impl Default for BookUpdate {
    fn default() -> Self {
        Self {
            title: None,
            cover_path: None,
            status: None,
            file_path: None,
            favorite: None,
            last_opened_at: None,
            last_page: None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CommentInput {
    pub book_id: i64,
    pub page_num: i64,
    pub x: f64,
    pub y: f64,
    pub content: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CommentUpdate {
    pub content: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BookmarkInput {
    pub book_id: i64,
    pub page_num: i64,
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BookmarkUpdate {
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct TagUpdate {
    pub name: Option<String>,
    pub color: Option<String>,
}
