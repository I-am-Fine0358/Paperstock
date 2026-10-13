# AGENTS.md

このリポジトリで作業する Codex 向けの指示です。回答は日本語で行ってください。

## プロジェクト概要

Paperstock は macOS 向けの PDF 管理・閲覧アプリです。本棚 UI、タブ式 PDF ビューア、見開き表示、コメント、ブックマーク、タグ管理を持ちます。

現在の実装は `paperstock-tauri/` 以下の Tauri 2.x アプリのみです。旧 Electron 実装は削除済みです。`MIGRATION_PLAN.md` は移行履歴として残っています。

## 作業ディレクトリとコマンド

Tauri アプリの操作は `paperstock-tauri/` で実行します。

```bash
npm run dev
npm run build
npm run build:dmg
```

Rust 側の軽い検証は次で行います。

```bash
cd paperstock-tauri/src-tauri
cargo check
```

フロントエンド JS の構文確認は次で行います。

```bash
node --check paperstock-tauri/src/js/bookshelf.js
```

テストスイート、linter、formatter は未設定です。Vite/webpack もなく、`paperstock-tauri/src/` の静的ファイルを Tauri が直接読みます。

## アーキテクチャ

Rust バックエンド:
- `paperstock-tauri/src-tauri/src/lib.rs`: Tauri 起動、DB 初期化、コマンド登録、メニュー登録、asset protocol scope 設定
- `db.rs`: `rusqlite::Connection` を `Mutex` で保持。WAL と foreign keys を有効化
- `commands/`: `books.rs`, `tags.rs`, `comments.rs`, `bookmarks.rs`, `files.rs`, `pdf.rs`
- `models.rs`: JS との境界に出る struct は `#[serde(rename_all = "camelCase")]` を使う
- `pdf_utils.rs`: PDF 表紙抽出、既存 PDF の managed `pdfs/` への移行
- `menu.rs`: macOS ネイティブメニュー

フロントエンド:
- `paperstock-tauri/src/index.html`: 本棚と PDF ビューアを含む単一画面
- `paperstock-tauri/src/js/bookshelf.js`: 主要な UI 状態、イベント、PDF 表示ロジック
- `paperstock-tauri/src/css/index.css`: メイン UI スタイル
- `window.__TAURI__` の global API を使う。`invoke` と `listen` が中心

永続化:
- SQLite DB: `~/Library/Application Support/Paperstock/paperstock.db`
- PDF: `~/Library/Application Support/Paperstock/pdfs/`
- カバー: `~/Library/Application Support/Paperstock/covers/`
- UI 設定と開いているタブ: `localStorage` の `ps-*` キー

## 重要な注意点

- PDF は Rust 側のローカル HTTP サーバ（`pdf_server.rs`）から `127.0.0.1` の Range 対応 URL として PDF.js に渡します。
- PDF 全体を JS 側へ `readFile()` や `read_pdf_file` で転送する経路を再導入しないでください。大きい PDF で `paperstock_helper` / WebKit helper のメモリ使用量が急増します。
- サムネイル canvas を大量に保持しないでください。現在は最大 80 ページ、DPR 1 に制限しています。
- PDF ページ canvas の DPR は最大 2 に制限しています。無制限にすると Retina 環境でメモリ消費が大きくなります。
- `tauri.conf.json` の CSP は `asset:` と `https://asset.localhost` を許可する必要があります。PDF.js worker のために `worker-src 'self' blob:` も必要です。
- DB/IPC 境界のフィールド名は camelCase 前提です。Rust 側の snake_case をそのまま JS に漏らさないでください。
- UI ラベルとメニュー項目は日本語で統一してください。
- 旧 Electron 前提の `main.js`, `preload.js`, ルート `src/`, ルート `package.json` を復活させないでください。

## 実装方針

- 既存の vanilla JS/CSS/Rust 構成に合わせて、不要なフレームワークを追加しないでください。
- 共有状態を変更する場合は、DB、`allBooks` キャッシュ、`pdfStates`、`localStorage` の関係を確認してください。
- 読書位置、ズーム、見開き、開いているタブは終了時にも保存される必要があります。
- 大きな変更後は最低限 `cargo check` と `node --check paperstock-tauri/src/js/bookshelf.js` を実行してください。
- DMG 作成は `hdiutil` がディスクイメージデバイスを使うため、サンドボックス内では `hdiutil: create failed - 装置が構成されていません` になることがあります。その場合は通常権限で `npm run build` を再実行してください。
- Paperstock アプリ本体に変更を入れた後は、ユーザーから別指示がない限り `paperstock-tauri/` で `npm run build:dmg` を実行し、生成された `paperstock-tauri/src-tauri/target/release/bundle/dmg/Paperstock_2.0.0_aarch64.dmg` を `open` で開いて動作確認できる状態にしてください。
