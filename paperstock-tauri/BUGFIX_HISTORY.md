# Paperstock バグ修正履歴

このドキュメントは Paperstock (Tauri 版) で発生した不具合と修正内容の記録です。新しいバグを調査する時は、まずここで類似の症状・原因がないか探してください。

書式は新しいエントリを **上に追加** していく時系列降順。各エントリは以下の構造：

- **日付 / セッション**
- **症状**: ユーザーから見えた現象
- **根本原因**: なぜ起きたか
- **修正箇所**: ファイル:行（コミット時点） + 関数名
- **学び**: 次回類似バグを見つけた時の手がかり

---

## 2026-05-31: 赤いバツボタンを押してもアプリが閉じない

**症状**
macOS のウィンドウ左上にある赤いバツボタンを押しても、Paperstock が閉じない／終了しない。

**根本原因**
`bookshelf.js` の `onCloseRequested` ハンドラが読書位置を保存するために `event.preventDefault()` で close 要求を止めていた。保存後に `WebviewWindow.close()` / `destroy()` へ戻す構造だったため、環境によってはウィンドウ close が完了せず、アプリプロセスも残る状態になっていた。

**修正箇所**

- `paperstock-tauri/src-tauri/src/commands/app.rs`: `quit_app(app)` コマンドを追加し、`app.exit(0)` で Tauri アプリ全体を終了。
- `paperstock-tauri/src-tauri/src/commands/mod.rs`: `app` コマンドモジュールを登録。
- `paperstock-tauri/src-tauri/src/lib.rs`: `quit_app` を `invoke_handler` に登録。
- `paperstock-tauri/src/js/bookshelf.js`: `onCloseRequested` でタブ状態・読書位置を `flushOpenPdfState()` した後、`invoke('quit_app')` を呼ぶよう変更。失敗時のみ従来の `destroy()` / `close()` にフォールバック。
- `AGENTS.md`: Paperstock アプリ本体に変更を入れた後は `npm run build:dmg` を実行し、生成DMGを `open` で開くことを標準手順として追記。

**検証**

- `node --check paperstock-tauri/src/js/bookshelf.js`
- `cargo check`
- `npm run build:dmg`
- 生成DMG `paperstock-tauri/src-tauri/target/release/bundle/dmg/Paperstock_2.0.0_aarch64.dmg` を `open` で起動確認できる状態にした。

**学び**

- Tauri の close 要求を `preventDefault()` する場合、保存完了後に同じ close 経路へ戻すと再入・環境差で詰まりやすい。アプリ終了が意図なら、保存後は Rust 側の明示的な終了コマンドに寄せる。
- macOS アプリでは「ウィンドウを閉じる」と「アプリを終了する」が別概念なので、ユーザー期待が終了なら `app.exit()` まで行う。
- 成功確認済みの配布物が必要な修正では、DMG生成と `open` までを確認手順に含める。

---

## 2026-05-06: PDFロード中にタブを切り替えるとビューアがスタック

**症状**
PDFを開いた直後に本棚タブへ切り替え、戻ってくると、ビューアが空（細い白い帯のみ）でフリーズする。

**根本原因 (3つ複合)**

1. **scale=0 の焼き付き**: `loadPdfForTab` 内の fit-width スケール計算が `viewer-container.clientWidth` を使うが、ロード中にユーザーが本棚へ切り替えると `viewer-view` が `display: none` になり `clientWidth = 0`。結果 `state.scale = 0` が state に保存され、復帰後の `renderPdfPages` で 0 サイズのキャンバスが描画される。
2. **`loadPdfForTab` の重複起動**: 前のセッションで入れた `activateTab` の lazy-load が、`openPdfTab` の明示的な `loadPdfForTab` 呼び出しと二重に発火していた。並行で getDocument が走り、状態が競合する。
3. **セーフティネット欠如**: `state.scale` が 0/負/NaN になっても `renderPdfPages` が素通しで PDF.js に渡していた。

**修正箇所** (`paperstock-tauri/src/js/bookshelf.js`)

- `ensureFitScale(state)` ヘルパ新設: `clientWidth <= 0` なら計算スキップ＆ `fitNeedsRecompute` フラグを立てる。
- `loadPdfForTab` の fit計算ブロックを `await ensureFitScale(state)` に置換。`pdfStates[tabId].loading` フラグで重複起動を防御。
- `showPdfTab`: `fitNeedsRecompute` が立っていたら `ensureFitScale` を await してから `renderPdfPages` を呼ぶ。
- `renderPdfPages` 冒頭: `state.scale <= 0 || !Number.isFinite(state.scale)` なら 1.0 にリセット + フラグ再立て。
- `openPdfTab`: 末尾の明示的な `loadPdfForTab(tabId, book)` を削除（activateTab に一本化）。

**学び**

- **DOM が `display: none` の時の寸法は 0**。レイアウト依存の計算（`clientWidth` / `getBoundingClientRect`）を非同期処理の中でやるなら、可視性チェックを必ず入れる。
- **非同期初期化中に副作用パスが分岐していないか確認**。`activateTab` と `openPdfTab` のように呼び出し経路が複数ある関数は、どこかで lazy 化したら他の経路の明示呼び出しも消す。
- 数値が来ることを前提にした計算は、入口で `Number.isFinite` チェックを足しておくと「変な見た目だけど落ちはしない」状態が回避できる。

---

## 2026-05-06: アプリを再起動するとサイドバーのタブが消える

**症状（仕様改善）**
意図的にタブを閉じていなくても、アプリ終了後に開き直すとサイドバーのPDFタブが空になっている。

**根本原因**
`tabs[]` と `tabGroups[]` は JSメモリ上の変数のみで永続化されていなかった。

**修正箇所** (`paperstock-tauri/src/js/bookshelf.js`)

- `persistTabState()` / `restoreTabState()` を追加。localStorage キー `ps-tab-state` に保存。
- `renderTabBar()` の末尾に `persistTabState()` を1行追加。すべてのタブ／グループ操作は最終的に renderTabBar を呼ぶので、これで全変更が拾える。
- 起動時 (`DOMContentLoaded`) に `loadData()` の後で `restoreTabState()` を呼ぶ。
- `activateTab` に lazy-load 処理を追加: `pdfStates[tabId]` が無い場合（=復元タブ）は `loadPdfForTab` を発火。
- 復元時に DB から消えた書籍を参照するタブは黙って捨てる（書籍を削除した場合）。
- `nextTabId` / `nextGroupId` は復元データの最大ID+1 で初期化して衝突を防止。

**学び**

- 「全変更で漏れなくフックしたい」場合、**個別の mutation 関数ではなく集約点（renderTabBar など）にフックを置く**と保守が楽。
- localStorage の保存内容は将来データ構造を変えた時に壊れる可能性があるので、`try/catch` + 各フィールドのバリデーションを必ず通す。

---

## 2026-05-06: ドラッグ＆ドロップ後にオーバーレイが消えない

**症状**
PDF をドラッグドロップでインポート後、「PDFをドロップして追加」のオーバーレイ（青い破線枠＋大きなアイコン）が画面上に残ったまま消えない。

**根本原因**
`onDragDropEvent` の Tauri コールバックが `'drop'` イベントを受けた時、`importFiles` を呼ぶだけでオーバーレイ消去処理が抜けていた。`'enter'` で表示／`'leave'` で非表示の処理はあったが、`'drop'` は別経路のため独立して消す必要がある。

**修正箇所** (`paperstock-tauri/src/js/bookshelf.js`, drag-drop event handler)

```js
if (event.payload.type === 'drop') {
    dragCounter = 0;
    dropOverlay.classList.remove('active');  // 追加
    // ...importFiles
}
```

加えて `'over'`（連続enter）と `'cancelled'`（OS側でキャンセル）も明示処理。

**学び**

- **Tauri 2.x の `onDragDropEvent` は HTML5 の DnD と独立して動く**（OS レベルで横取りされる）。HTML5 の dragenter/leave/drop ハンドラと同期しないので、Tauri のイベント側だけで状態管理を完結させる。
- イベント種別の網羅性をチェックする時は payload.type の取りうる値を全部リスト化する: `enter`, `over`, `leave`, `drop`, `cancelled`。

---

## 2026-05-02: 検索が「CEO」「問いのデザイン」を取りこぼす

**症状**
- 書籍タイトルに「ＣＥＯ」（全角）が入っていると、検索窓に「CEO」（半角）と打ってもヒットしない。
- 「問いのデザイン」を全文タイポなしで打ってもヒットしない（タイトル文字列に隠れた全角スペースやノーブレークスペースが混入していた）。
- ✖ボタンが無く、Delete連打でしかクリアできない。

**根本原因**
`bookshelf.js` の検索フィルタが `title.toLowerCase().includes(query)` の単純な部分一致だった。Unicode 正規化なし、空白除去なし。

**修正箇所** (`paperstock-tauri/src/js/bookshelf.js`)

- `normalizeForSearch(s)` ヘルパ追加: `s.normalize('NFKC').toLowerCase().replace(/\s+/g, '')`
  - NFKC で 全角→半角（ＣＥＯ → CEO、　→ 通常スペース）
  - lowercase で 大小文字無視
  - `\s+` 除去で全角スペース・ノーブレークスペース・改行も無視
- 検索フィルタを `normalizeForSearch(b.title).includes(normalizeForSearch(rawQuery))` に変更。
- HTML/CSS で ✖ボタン (`#search-clear`) を search-box 内に常時表示。`.has-value` クラスで濃淡を切替。
- Esc キー押下でクリア（既存の他用途 Esc と衝突しないよう `stopPropagation()`）。

**学び**

- **日本語の検索は最低限 NFKC 正規化と空白除去を入れる**。書籍メタデータは出所により全角/半角が混じるのが普通。
- 部分一致検索のバグ報告が来たら、まず該当タイトルを生バイト列で確認（DB Browser や `console.log(JSON.stringify(title))`）。目視では同じに見えても U+3000 / U+00A0 が紛れていることが多い。

---

## 2026-05-02: 読書中の本のタブを閉じると履歴が失われる

**症状**
読んでいた本のタブを閉じて、再度開くと最初のページから始まってしまう。栞ではなく自動で読み位置を覚えて欲しい。

**根本原因**
`update_book` IPC は `viewerNav`（前/次ボタン）でしか発火していなかった。以下のページ遷移は `state.currentPage` を変えるだけで DB に保存していなかった:
- ページ番号入力欄での直接ジャンプ
- サムネイル一覧クリック
- 栞からのジャンプ

さらに `closeTab` の `update_book` は fire-and-forget で、アプリ終了時の race で保存が落ちる可能性があった。

加えて、ユーザーは「ページ位置だけでなく、最後のスクロール位置・ズーム倍率・見開きモードまで復元して欲しい」と要望。

**修正箇所**

- **DB スキーマ拡張** (`src-tauri/src/db.rs`, `src-tauri/src/models.rs`): `last_scroll_y REAL`, `last_zoom REAL`, `last_spread_mode INTEGER` の3カラムを `books` に追加。idempotent な ALTER TABLE マイグレーションで既存DB互換。
- **`saveBookState(tabId)` ヘルパ** (`bookshelf.js`): `lastPage`, `lastZoom` (fit-mode なら 0), `lastSpreadMode`, `lastScrollY` (アクティブタブのみ、コンテナ高に対する比率) をまとめて update_book に渡す。
- 全ナビゲーションパスから `saveBookState` を呼ぶよう統一。スクロール・ズームは `scheduleSaveBookState(tabId, 500)` で 500ms debounce。
- `closeTab` を async 化して `await saveBookState` してから state を破棄。
- `window.beforeunload` で全タブ flush（best-effort）。
- 復元側: `loadPdfForTab` で `book.lastZoom > 0` なら fit を抜けてその scale を採用。`book.lastSpreadMode` から spread mode を起こす。`book.lastScrollY` を `state.pendingScrollY` にセットしておき、`renderPdfPages` の最初の描画後に scrollTop へ反映。

**学び**

- **状態を保存するパスは1つに集約**。「あちこちで保存」より「集約関数を1つ作って全パスから呼ぶ」方が漏れを防げる。
- 永続化対象が増えるとマイグレーションで列追加が頻発する。`ALTER TABLE ADD COLUMN` の idempotent ガード（`SELECT col FROM books LIMIT 1` の成否で判定）を使うのが楽。
- `serde(rename_all = "camelCase")` を **すべての** IPC 境界の struct に付ける。1個忘れると JS 側で値が undefined のまま静かに壊れる（過去コミット d29e3e8 の事例）。

---

## 補足: 既知の未修正・将来的に対処すべき点

- **closeTab が PDF ロード途中だと pdfDoc.destroy() を呼べない**: `state.pdfDoc` が null の段階で close すると、後から完了する `getDocument` の結果が destroy されずにメモリリーク。実害は小さいが、loadPdfForTab に AbortController 風のキャンセル機構を入れると綺麗。
- **`get_book_tags` (db.rs) と `get_tag` (commands/tags.rs) が dead code 警告**: 使われていない API。整理するなら削除。

---

## このファイルの更新ルール

- バグを直したら必ずここに追記する（**先頭=新しい順**）
- 「症状」はユーザーから見える形で書く（実装用語を使わない）
- 「根本原因」は1段階深く: 「Aが起きるとBになる、Bは…」と因果を辿る
- 「修正箇所」は file:function ベースで。行番号は変動するので付けない
- 「学び」は次回類似バグを見つけた時に役立つ一般化した知見を書く
