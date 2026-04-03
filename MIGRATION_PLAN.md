# Paperstock: Electron → Tauri 移行計画

## 概要

Paperstockを Electron (Node.js) から Tauri 2.x (Rust + WebView) へ移行する。
フロントエンド（HTML/CSS/JS）はほぼそのまま流用し、バックエンド（main process）をRustで書き直す。

### 期待される効果
| 項目 | Electron (現在) | Tauri (移行後) |
|------|----------------|---------------|
| DMGサイズ | ~150MB | ~10-15MB |
| メモリ使用量 | ~200MB+ | ~30-50MB |
| 起動速度 | 2-3秒 | <1秒 |

### 技術スタック
- **Tauri 2.x** (Rust バックエンド)
- **rusqlite** (SQLite, better-sqlite3の代替)
- **pdf** crate or `lopdf` (PDFページ数取得)
- **image** crate (カバー画像処理)
- **pdfjs-dist** (WebView側、PDF描画は現行のまま)
- **tauri-plugin-dialog** (ファイル選択ダイアログ)
- **tauri-plugin-shell** (Finder表示、qlmanage呼び出し)

---

## プロジェクト構成（移行後）

```
paperstock-tauri/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   │   └── icon.icns
│   └── src/
│       ├── main.rs              ← エントリポイント + app setup
│       ├── lib.rs               ← Tauri app builder
│       ├── db.rs                ← BookDatabase (rusqlite)
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── books.rs         ← 本 CRUD コマンド
│       │   ├── tags.rs          ← タグ CRUD コマンド
│       │   ├── comments.rs      ← コメント CRUD コマンド
│       │   ├── bookmarks.rs     ← 栞 CRUD コマンド
│       │   ├── files.rs         ← ファイルダイアログ、PDF インポート
│       │   └── pdf.rs           ← PDF読み込み、カバー抽出
│       ├── models.rs            ← Book, Tag, Comment, Bookmark 構造体
│       └── pdf_utils.rs         ← カバー抽出 (qlmanage)、ページ数取得
├── src/                         ← フロントエンド (現行をほぼ流用)
│   ├── index.html
│   ├── css/
│   │   ├── index.css
│   │   └── viewer.css
│   └── js/
│       └── bookshelf.js         ← window.api → invoke() に書き換え
├── package.json                 ← pdfjs-dist のみ
└── README.md
```

---

## Agent 並列実行設計

### 依存関係グラフ

```
         ┌──────────────┐
         │  Agent 0     │
         │  Scaffolding │   ← 最初に実行（他の全agentの前提）
         └──────┬───────┘
                │
     ┌──────────┼──────────┬───────────┐
     ▼          ▼          ▼           ▼
┌─────────┐┌─────────┐┌─────────┐┌──────────┐
│ Agent 1  ││ Agent 2  ││ Agent 3  ││ Agent 4   │
│ DB層     ││ Commands ││ PDF Utils││ Frontend  │
│ (Rust)   ││ (Rust)   ││ (Rust)   ││ (JS書換)  │
└────┬─────┘└────┬─────┘└────┬─────┘└─────┬────┘
     │           │           │            │
     └───────────┴───────────┴────────────┘
                      │
               ┌──────▼───────┐
               │   Agent 5    │
               │  統合 & 結合  │  ← 全agent完了後に実行
               └──────┬───────┘
                      │
               ┌──────▼───────┐
               │   Agent 6    │
               │  メニュー &   │
               │  ビルド設定   │
               └──────────────┘
```

### 並列実行順序

| Phase | Agents | 並列可 | 説明 |
|-------|--------|--------|------|
| **Phase 0** | Agent 0 | - | Tauri プロジェクト初期化 |
| **Phase 1** | Agent 1, 2, 3, 4 | **全並列** | コア実装 |
| **Phase 2** | Agent 5 | - | 統合テスト・結合 |
| **Phase 3** | Agent 6 | - | 仕上げ |

---

## Agent 0: プロジェクトスキャフォールド

**目的**: Tauri 2.x プロジェクトの骨格を作成し、他agentが並列で作業できる環境を整える

**成果物**:
- `src-tauri/Cargo.toml` — 全依存クレートを宣言
- `src-tauri/tauri.conf.json` — ウィンドウ設定、アプリID、バンドル設定
- `src-tauri/capabilities/default.json` — パーミッション設定
- `src-tauri/src/main.rs` — 最小限のエントリポイント（空のcommandリスト）
- `src-tauri/src/lib.rs` — app builder の骨格
- `src-tauri/src/models.rs` — 空の構造体定義ファイル
- `src-tauri/src/db.rs` — 空のモジュール宣言
- `src-tauri/src/commands/mod.rs` — 空のモジュール宣言
- `src-tauri/src/pdf_utils.rs` — 空のモジュール宣言
- `src/` ディレクトリに現行フロントエンドをコピー
- `package.json` — pdfjs-dist のみの依存
- `src-tauri/icons/` — 現行アイコンをコピー

**Cargo.toml 依存クレート**:
```toml
[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
tauri-plugin-fs = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.32", features = ["bundled"] }
base64 = "0.22"
chrono = "0.4"
dirs = "6"
```

**tauri.conf.json の主要設定**:
```json
{
  "productName": "Paperstock",
  "identifier": "com.paperstock.app",
  "app": {
    "windows": [{
      "title": "Paperstock",
      "width": 1280,
      "height": 850,
      "minWidth": 900,
      "minHeight": 600,
      "titleBarStyle": "Overlay",
      "hiddenTitle": true
    }]
  }
}
```

**注意事項**:
- macOS のタイトルバースタイル: Electron `hiddenInset` → Tauri `Overlay`
- `trafficLightPosition` は Tauri 2.x の `"trafficLightPosition": { "x": 16, "y": 16 }` で設定可

---

## Agent 1: データベース層 (Rust)

**目的**: `lib/database.js` を `src-tauri/src/db.rs` + `src-tauri/src/models.rs` に移植

### models.rs — データ構造体

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: i64,
    pub title: String,
    pub file_path: String,
    pub cover_path: Option<String>,
    pub page_count: i64,
    pub status: String,           // "unread" | "reading" | "completed"
    pub favorite: i64,            // 0 or 1
    pub last_opened_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<Tag>,           // JOINで取得して付与
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

// コマンド引数用の構造体
#[derive(Debug, Deserialize)]
pub struct BookUpdate {
    pub title: Option<String>,
    pub cover_path: Option<String>,
    pub status: Option<String>,
    pub file_path: Option<String>,
    pub favorite: Option<i64>,
    pub last_opened_at: Option<String>,
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
```

### db.rs — BookDatabase 実装

移植する全メソッド（現行 `database.js` との1:1対応）:

| JS メソッド | Rust メソッド | 備考 |
|------------|-------------|------|
| `constructor` + `_init()` | `BookDatabase::new(db_path)` | テーブル作成 + マイグレーション |
| `addBook()` | `add_book()` | INSERT + 返り値 |
| `getBook(id)` | `get_book(id)` | SELECT + tags付与 |
| `getAllBooks()` | `get_all_books()` | ORDER BY updated_at DESC |
| `getBooksByTag(tagId)` | `get_books_by_tag(tag_id)` | JOIN book_tags |
| `searchBooks(query)` | `search_books(query)` | LIKE %query% |
| `updateBook(id, updates)` | `update_book(id, updates)` | 動的フィールド更新 |
| `removeBook(id)` | `remove_book(id)` | DELETE CASCADE |
| `addTag()` | `add_tag()` | |
| `getTag()` | `get_tag()` | |
| `getAllTags()` | `get_all_tags()` | ORDER BY name |
| `updateTag()` | `update_tag()` | |
| `deleteTag()` | `delete_tag()` | |
| `assignTag()` | `assign_tag()` | INSERT OR IGNORE |
| `unassignTag()` | `unassign_tag()` | |
| `_getBookTags()` | `get_book_tags()` | 内部ヘルパー |
| `addComment()` | `add_comment()` | |
| `getCommentsForBook()` | `get_comments_for_book()` | |
| `getCommentsForPage()` | `get_comments_for_page()` | |
| `updateComment()` | `update_comment()` | |
| `deleteComment()` | `delete_comment()` | |
| `addBookmark()` | `add_bookmark()` | |
| `getBookmarks()` | `get_bookmarks()` | |
| `updateBookmark()` | `update_bookmark()` | |
| `deleteBookmark()` | `delete_bookmark()` | |

**重要**: SQLスキーマは完全に同一にすること。既存DBとの互換性を維持する。

**DBパス**: `dirs::data_dir()` → `~/Library/Application Support/com.paperstock.app/paperstock.db`
  - 注意: Tauri はデフォルトで `identifier` ベースのパスを使う。既存DBとの互換性のため `~/Library/Application Support/Paperstock/paperstock.db` を直接指定するか、初回起動時にマイグレーションする。

**スレッド安全**: `Mutex<Connection>` で `rusqlite::Connection` をラップし、Tauri の `State<>` で管理。

```rust
use std::sync::Mutex;
use rusqlite::Connection;
use tauri::State;

pub struct BookDatabase {
    conn: Mutex<Connection>,
}
```

---

## Agent 2: Tauri Commands (Rust)

**目的**: `main.js` の全IPCハンドラを Tauri command として実装

**前提**: Agent 1 の `db.rs` と `models.rs` の型定義を使用。ただしAgent 1と同時に作業するため、import パスだけ合わせて後で統合する。

### commands/books.rs
現行の `main.js` 対応:
```
get-books        → get_books(db: State<BookDatabase>) -> Vec<Book>
get-books-by-tag → get_books_by_tag(db, tag_id: i64) -> Vec<Book>
search-books     → search_books(db, query: String) -> Vec<Book>
get-book         → get_book(db, id: i64) -> Option<Book>
remove-book      → remove_book(db, id: i64)  ← ファイル削除ロジックも含む
update-book      → update_book(db, id: i64, updates: BookUpdate) -> Option<Book>
```

`remove_book` の特殊ロジック（現行 `main.js:114-124`）:
- `book.cover_path` が存在すればファイル削除
- `book.file_path` が `pdfsDir` 内なら PDF ファイルも削除
- その後 DB から DELETE

### commands/tags.rs
```
get-tags      → get_tags(db) -> Vec<Tag>
add-tag       → add_tag(db, name: String, color: String) -> Tag
update-tag    → update_tag(db, id: i64, data: TagUpdate) -> Tag
delete-tag    → delete_tag(db, id: i64)
assign-tag    → assign_tag(db, book_id: i64, tag_id: i64)
unassign-tag  → unassign_tag(db, book_id: i64, tag_id: i64)
```

### commands/comments.rs
```
add-comment      → add_comment(db, data: CommentInput) -> Comment
get-comments     → get_comments(db, book_id: i64) -> Vec<Comment>
get-page-comments → get_page_comments(db, book_id: i64, page_num: i64) -> Vec<Comment>
update-comment   → update_comment(db, id: i64, data: CommentUpdate) -> Comment
delete-comment   → delete_comment(db, id: i64)
```

### commands/bookmarks.rs
```
add-bookmark    → add_bookmark(db, data: BookmarkInput) -> Bookmark
get-bookmarks   → get_bookmarks(db, book_id: i64) -> Vec<Bookmark>
update-bookmark → update_bookmark(db, id: i64, data: BookmarkUpdate) -> Bookmark
delete-bookmark → delete_bookmark(db, id: i64)
```

### commands/files.rs — ファイルダイアログ & インポート

```
select-pdf-files  → select_pdf_files(window) -> Vec<String>
select-cover-image → select_cover_image(window) -> Option<String>
import-pdf        → import_pdf(db, window, file_path: String) -> Option<Book>
set-custom-cover  → set_custom_cover(db, book_id: i64, image_path: String) -> Book
show-in-finder    → show_in_finder(file_path: String)
```

`import_pdf` は最も複雑なコマンド。現行ロジック（`main.js:153-200`）を忠実に再実装:
1. `pdfsDir` への同名ファイル存在チェック
2. DB内の重複チェック
3. 重複時ダイアログ（`tauri-plugin-dialog`）
4. ファイルコピー
5. ページ数取得（`pdf_utils::get_page_count`）
6. DB INSERT
7. カバー抽出（`pdf_utils::extract_cover`）
8. DB UPDATE (cover_path)

`select_pdf_files` と `select_cover_image` は `tauri-plugin-dialog` の `FileDialogBuilder` を使用:
```rust
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn select_pdf_files(window: tauri::Window) -> Vec<String> {
    // dialog().file().add_filter("PDF", &["pdf"]).pick_files()
}
```

### commands/pdf.rs — PDF読み込み
```
get-pdfjs-paths → 削除（Tauri では不要、フロントでCDN or ローカルimportに変更）
read-pdf-file   → read_pdf_file(file_path: String) -> Vec<u8>
get-cover-data  → get_cover_data(cover_path: String) -> Option<String>  // base64 data URL
```

### commands/mod.rs — 全コマンドのre-export
```rust
pub mod books;
pub mod tags;
pub mod comments;
pub mod bookmarks;
pub mod files;
pub mod pdf;
```

### lib.rs — コマンド登録
```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(db::BookDatabase::new(db_path))
        .invoke_handler(tauri::generate_handler![
            // 全コマンドをここに列挙
            commands::books::get_books,
            commands::books::get_books_by_tag,
            // ... 全28コマンド
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## Agent 3: PDF ユーティリティ (Rust)

**目的**: `lib/pdf-utils.js` を `src-tauri/src/pdf_utils.rs` に移植

### extract_cover — カバー抽出

現行実装（macOS `qlmanage`）をそのまま移植:
```rust
use std::process::Command;
use std::path::{Path, PathBuf};
use std::fs;

pub fn extract_cover(pdf_path: &str, output_dir: &str, book_id: i64) -> Option<String> {
    let output_path = Path::new(output_dir).join(format!("cover_{}.png", book_id));

    // qlmanage -t -s 600 -o <tmp_dir> <pdf_path>
    let tmp_dir = Path::new(output_dir).join(format!(".tmp_{}", book_id));
    fs::create_dir_all(&tmp_dir).ok()?;

    let result = Command::new("qlmanage")
        .args(["-t", "-s", "600", "-o"])
        .arg(&tmp_dir)
        .arg(pdf_path)
        .output();

    // 生成された .png を最終パスにコピー
    // tmp ディレクトリを削除
    // ...
}
```

### get_page_count — ページ数取得

**選択肢**:
- **Option A** (推奨): `lopdf` クレートで PDF を解析
  ```rust
  use lopdf::Document;
  pub fn get_page_count(pdf_path: &str) -> i64 {
      Document::load(pdf_path)
          .map(|doc| doc.get_pages().len() as i64)
          .unwrap_or(0)
  }
  ```
  - Cargo.toml に `lopdf = "0.34"` を追加

- **Option B**: 現行と同じく正規表現フォールバック

### migrate_existing_books — 既存本の移行

現行の `migrateExistingBooks()` (`main.js:254-279`) のロジック:
- 全書籍をスキャン
- `file_path` が `pdfsDir` 外のものをコピー
- DB の `file_path` を更新

このロジックは Agent 2 の `lib.rs` セットアップ内で呼ぶか、`pdf_utils.rs` にヘルパーとして実装。

---

## Agent 4: フロントエンド書き換え (JavaScript)

**目的**: `window.api.*` を Tauri の `invoke()` に書き換え。HTML/CSSはほぼ変更なし。

### 書き換えルール

**基本変換パターン**:
```javascript
// Before (Electron)
const books = await window.api.getBooks();

// After (Tauri)
const { invoke } = window.__TAURI__.core;
const books = await invoke('get_books');
```

**注意**: Tauri のコマンド名はスネークケース。引数はオブジェクトで渡す:
```javascript
// Before
await window.api.updateBook(id, updates);

// After
await invoke('update_book', { id, updates });
```

### bookshelf.js 全書き換え箇所

ファイル先頭に追加:
```javascript
const { invoke } = window.__TAURI__.core;
```

**全 `window.api.*` 呼び出しの置換表** (各呼び出し箇所と変換):

| 現行コード | 変換後 |
|-----------|--------|
| `window.api.getBooks()` | `invoke('get_books')` |
| `window.api.getBooksByTag(tagId)` | `invoke('get_books_by_tag', { tagId })` |
| `window.api.searchBooks(query)` | `invoke('search_books', { query })` |
| `window.api.getBook(id)` | `invoke('get_book', { id })` |
| `window.api.removeBook(id)` | `invoke('remove_book', { id })` |
| `window.api.updateBook(id, updates)` | `invoke('update_book', { id, updates })` |
| `window.api.importPdf(filePath)` | `invoke('import_pdf', { filePath })` |
| `window.api.getTags()` | `invoke('get_tags')` |
| `window.api.addTag(name, color)` | `invoke('add_tag', { name, color })` |
| `window.api.updateTag(id, data)` | `invoke('update_tag', { id, data })` |
| `window.api.deleteTag(id)` | `invoke('delete_tag', { id })` |
| `window.api.assignTag(bookId, tagId)` | `invoke('assign_tag', { bookId, tagId })` |
| `window.api.unassignTag(bookId, tagId)` | `invoke('unassign_tag', { bookId, tagId })` |
| `window.api.selectPdfFiles()` | `invoke('select_pdf_files')` |
| `window.api.selectCoverImage()` | `invoke('select_cover_image')` |
| `window.api.setCustomCover(bookId, imagePath)` | `invoke('set_custom_cover', { bookId, imagePath })` |
| `window.api.getCoverData(coverPath)` | `invoke('get_cover_data', { coverPath })` |
| `window.api.showInFinder(filePath)` | `invoke('show_in_finder', { filePath })` |
| `window.api.getPdfjsPaths()` | **削除** (下記参照) |
| `window.api.readPdfFile(filePath)` | `invoke('read_pdf_file', { filePath })` |
| `window.api.addComment(data)` | `invoke('add_comment', { data })` |
| `window.api.getComments(bookId)` | `invoke('get_comments', { bookId })` |
| `window.api.getPageComments(bookId, pageNum)` | `invoke('get_page_comments', { bookId, pageNum })` |
| `window.api.updateComment(id, data)` | `invoke('update_comment', { id, data })` |
| `window.api.deleteComment(id)` | `invoke('delete_comment', { id })` |
| `window.api.addBookmark(data)` | `invoke('add_bookmark', { data })` |
| `window.api.getBookmarks(bookId)` | `invoke('get_bookmarks', { bookId })` |
| `window.api.updateBookmark(id, data)` | `invoke('update_bookmark', { id, data })` |
| `window.api.deleteBookmark(id)` | `invoke('delete_bookmark', { id })` |

### PDF.js 読み込み方式の変更

現行: `window.api.getPdfjsPaths()` で node_modules 内のパスを取得 → `<script>` タグで読み込み

移行後: npm で `pdfjs-dist` をインストールし、フロントエンドのビルドパイプラインで読み込む。
- `package.json` に `pdfjs-dist` を依存として追加
- `initPdfJs()` を書き換え:
```javascript
async function initPdfJs() {
    // Tauriではnpmパッケージをdist/にコピーするか、
    // index.htmlから直接<script>で読み込む
    pdfjsLib = window.pdfjsLib; // グローバルに読み込み済みのものを使う
    pdfjsLib.GlobalWorkerOptions.workerSrc = './libs/pdf.worker.mjs';
    pdfjsReady = true;
}
```
- `node_modules/pdfjs-dist/legacy/build/` から `pdf.mjs`, `pdf.worker.mjs` を `src/libs/` にコピーするビルドステップを追加

### メニューイベントの変更

現行: `window.api.onMenuAddBooks(callback)` → `ipcRenderer.on()`

移行後: Tauri のイベントシステムを使用:
```javascript
const { listen } = window.__TAURI__.event;

listen('menu-add-books', () => { addBooks(); });
listen('menu-close-tab', () => { /* ... */ });
```

### readPdfFile のレスポンス形式

現行: `ipcRenderer.invoke('read-pdf-file')` → Node.js `Buffer`
移行後: Rust から `Vec<u8>` → Tauri が自動的に `number[]` (JSON配列) に変換

`loadPdfForTab()` 内の PDF データ受け取り部分を調整:
```javascript
const data = await invoke('read_pdf_file', { filePath: book.file_path });
const uint8 = new Uint8Array(data);
const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;
```

### index.html の変更

最小限の変更のみ:
1. `<script src="js/bookshelf.js">` の前に Tauri API の読み込みを追加（不要な場合あり、`withGlobalTauri` 設定で自動注入）
2. pdfjs-dist の `<script>` タグを追加（ローカルコピーを参照）
3. Google Fonts の `<link>` はそのまま維持

### preload.js

**削除**。Tauri には preload の概念がない。全ての IPC は `invoke()` で直接行う。

### CSS の変更

ほぼ変更なし。1点のみ:
- `--tab-bar-width` のタイトルバー領域: Electron `hiddenInset` と Tauri `Overlay` で信号機の位置が微妙に異なる可能性あり。テスト時に調整。

---

## Agent 5: 統合 & 結合

**目的**: Agent 1-4 の成果物を統合し、コンパイル・動作確認

### タスク

1. **Rust コンパイル確認**
   - `cargo build` が通ることを確認
   - Agent 1 (db.rs) と Agent 2 (commands/) の型の整合性を修正
   - Agent 3 (pdf_utils.rs) の関数シグネチャが Agent 2 の呼び出しと一致することを確認

2. **lib.rs の完成**
   - 全コマンドの `generate_handler![]` 登録
   - DB初期化、ディレクトリ作成（covers, pdfs）
   - `migrateExistingBooks` の呼び出し

3. **フロントエンド統合**
   - Agent 4 の bookshelf.js が Rust コマンドと正しく通信することを確認
   - 引数のキー名（camelCase vs snake_case）の整合性チェック
     - **重要**: Tauri の `#[tauri::command]` は `rename_all = "camelCase"` をデフォルトで適用するため、Rust側の引数名 `tag_id` はフロント側から `tagId` で渡せる。ただし構造体のフィールドは `#[serde(rename_all = "camelCase")]` を明示的に付ける必要がある。

4. **データ互換性**
   - 既存の `paperstock.db` をそのまま読めることを確認
   - `covers/` と `pdfs/` ディレクトリのパスが一致することを確認

5. **動作テスト**
   - `cargo tauri dev` で起動
   - 本の追加、表示、PDF閲覧、コメント、ブックマーク、タグ操作を一通り確認

---

## Agent 6: メニュー & ビルド設定

**目的**: macOS ネイティブメニューの実装、DMGビルド設定

### メニュー実装

現行メニュー（`main.js:37-105`）を Tauri 2.x の `Menu` API で再現:

```rust
use tauri::menu::{Menu, Submenu, MenuItem, PredefinedMenuItem};

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let file_menu = Submenu::with_items(app, "ファイル", true, &[
        &MenuItem::with_id(app, "add-pdf", "PDFを追加…", true, Some("CmdOrCtrl+O"))?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "close-tab", "タブを閉じる", true, Some("CmdOrCtrl+W"))?,
    ])?;
    // 編集、表示、ウィンドウ メニューも同様
    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}
```

メニューイベントハンドリング:
```rust
app.on_menu_event(|app, event| {
    match event.id().as_ref() {
        "add-pdf" => { app.emit("menu-add-books", ()).ok(); }
        "close-tab" => { app.emit("menu-close-tab", ()).ok(); }
        _ => {}
    }
});
```

### ビルド設定

`tauri.conf.json` の `bundle` セクション:
```json
{
  "bundle": {
    "active": true,
    "targets": ["dmg"],
    "icon": ["icons/icon.icns"],
    "macOS": {
      "minimumSystemVersion": "10.15"
    }
  }
}
```

ビルドコマンド:
```bash
cargo tauri build
```

出力: `src-tauri/target/release/bundle/dmg/Paperstock_x.y.z_aarch64.dmg`

### package.json scripts 更新
```json
{
  "scripts": {
    "dev": "cargo tauri dev",
    "build": "cargo tauri build",
    "build:dmg": "cargo tauri build --bundles dmg"
  }
}
```

---

## 注意事項 & 落とし穴

### 1. camelCase ↔ snake_case
Tauri command の引数は `#[tauri::command(rename_all = "camelCase")]` がデフォルト。
構造体には `#[serde(rename_all = "camelCase")]` を明示的に追加すること。

### 2. DB パスの互換性
Electron 版: `~/Library/Application Support/Paperstock/`
Tauri 版: デフォルトでは `~/Library/Application Support/com.paperstock.app/`

→ 既存ユーザーのデータを引き継ぐため、明示的に旧パスを参照するか、初回起動時にコピーする。

### 3. PDF バイナリデータの受け渡し
`read_pdf_file` は大きなバイナリを返す。Tauri の invoke は JSON シリアライズするため、大きな PDF (100MB+) ではパフォーマンスに注意。
→ 代替案: `tauri-plugin-fs` でフロントから直接ファイルを読む、またはカスタムプロトコル (`asset://`) を使用。

### 4. qlmanage の依存
カバー抽出は macOS 専用の `qlmanage` に依存。Tauri でも `std::process::Command` で同様に呼べるが、クロスプラットフォーム展開時は別手段が必要。

### 5. pdfjs-dist の配置
Tauri はフロントエンドのアセットを `src/` から配信する。`pdfjs-dist` のファイルを `src/libs/` に配置し、`index.html` から参照する。
ビルド時に自動コピーするスクリプトを用意するとよい。

### 6. 不要になるファイル
- `main.js` — 削除 (Rust に移行)
- `preload.js` — 削除 (Tauri には不要)
- `lib/database.js` — 削除 (db.rs に移行)
- `lib/pdf-utils.js` — 削除 (pdf_utils.rs に移行)
- `electron-builder` 関連の設定 — 削除

---

## 作業見積り

| Agent | 作業量 | 複雑度 |
|-------|--------|--------|
| Agent 0 (Scaffold) | 小 | 低 |
| Agent 1 (DB) | 中 | 中 — rusqlite の動的UPDATE構築が最も複雑 |
| Agent 2 (Commands) | 大 | 中 — import_pdf が最複雑、他はシンプルな委譲 |
| Agent 3 (PDF Utils) | 小 | 低 — qlmanage呼び出し + lopdf |
| Agent 4 (Frontend) | 中 | 低 — 機械的な置換が大半、PDF.js周りのみ注意 |
| Agent 5 (Integration) | 中 | 高 — 全体の整合性確認 |
| Agent 6 (Menu/Build) | 小 | 中 — Tauri 2.x Menu API の習熟 |
