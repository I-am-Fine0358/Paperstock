# Paperstock バグ修正履歴

このドキュメントは Paperstock (Tauri 版) で発生した不具合と修正内容の記録です。新しいバグを調査する時は、まずここで類似の症状・原因がないか探してください。

書式は新しいエントリを **上に追加** していく時系列降順。各エントリは以下の構造：

- **日付 / セッション**
- **症状**: ユーザーから見えた現象
- **根本原因**: なぜ起きたか
- **修正箇所**: ファイル:行（コミット時点） + 関数名
- **学び**: 次回類似バグを見つけた時の手がかり

---

## 2026-10-13: PDF読み込み中の表示から進まなくなる

**観測と切り分け**

修正版でも、サイドバーは操作できる一方で「PDF読み込み中…」が消えない報告があった。動作中の実アプリでも同じ表示を確認。PDFサーバーは応答し、WebContentは生存、ネイティブのメインスレッドは通常のイベント待ちで、HTTPエラーやDBのロック待ちは確認されなかった。

対象の約103 MB・308ページのPDFは、隔離したWKWebViewで単独ロード、32ページ描画、読み込み途中のタブ切り替え、非表示からの復帰に成功した。一方、描画が始まった直後に別のPDFタブ→本棚→元のPDFと切り替える操作で、故障注入やタブのcloseなしでも「PDF読み込み中…」のまま進まなくなる現象を再現した。ページ側の終了は完了するが、PDF.js WorkerのTerminate応答が戻らず、全タブ共通の破棄待ちが残っていた。closeを含む別の操作でも50秒以上の未完了を観測した。前回のメモリ対策でこの待ちを無制限に共有したことが、後続タブまで止まる原因だった。

**修正対象として確認した不具合**

- 文書破棄のPromiseを全タブの読み込み開始前に待ち、終了応答がない場合にすべてのタブが永久待機する。失敗表示も同じ破棄を待つため、エラーまで「読み込み中」に隠れていた。
- PDFのロード・IPC・workerへの要求に期限や中断経路がなく、`loading=true`が残ると再選択しても読み直せなかった。
- 同梱PDF.jsはworkerの終了応答後にHTTP要求を中断する。応答が失われると、workerだけを強制終了してもmain側の通信が残り得た。

**修正**

- 文書ごとに実WorkerとPDF.jsのwrapperを所有し、通常破棄が3秒で終わらなければその文書のWorkerを終了して待機を解除する。読書位置や倍率は維持する。
- 文書世代ごとのAbortControllerで、旧workerを待つ読み込み・描画・文字抽出・キャッシュ解放も中断する。古い処理が後から完了しても再読み込み済みの文書を変更させない。
- ロードは60秒無進捗で失敗を表示し、進捗があれば期限を延長する。失敗表示は破棄を待たず「再試行」を出し、workerの起動失敗や表示開始後の異常も回復対象にする。
- 同梱PDF.jsのHTTP要求中断を終了応答待ちより前に移動する。小さいローカル修正として `src/libs/PAPERSTOCK_PATCHES.md` に理由と保守手順を記録する。

**検証**

JavaScript回帰39件、構文確認、`cargo check`が成功。同じPDFを使った自然なタブ切替の試験で、旧版は停止し、修正版は32ページの本文に復帰、破棄待ち0・未処理エラー0となることを確認した。再現用の手順・結果は `tests/memory-reproduction/README.md` を参照。通常操作の試験と、終了応答を意図的に保留する故障注入試験は区別する。 最終DMGからコピーしたアプリを隔離DB・専用bundle IDで起動し、別タブ→本棚→元PDFへの復帰後も33ページ・159%で本文を表示し、Cmd+Qで終了できることを確認した。自動操作中はmacOSがウィンドウを遮蔽扱いにしたため、全画面化と解除で可視状態へ戻して描画を確認した。配布バイナリはビルド時の個人ホームパスを除去している。本人のPDF・本文・画像・生ログは公開物に含めない。

---

## 2026-10-13: 放置・スリープ後に画面全体が白くなり、Cmd+Qでも終了できない

**症状と実機ログ**

本棚・サイドバーを含む画面全体が白くなり、アプリ本体だけが残る。2026-10-12 22:11 の macOS ログで、Paperstock の WebContent が 7093 MB に達し、メモリ解放後も 6277 MB、非アクティブ時の終了閾値 4096 MB を超えて `ExceededMemoryLimit` で終了したことを確認した。親プロセスは翌日16:18まで残っていた。根拠ログは `tmp/paperstock-memory-termination-2026-10-13.log`。

**原因**

- PDF.js 文書・worker・訪問済みページの画像リソースがタブごとに残り、非表示時にも解放されなかった。拡大canvas、復帰時の重複描画、連続操作時の並列描画が使用量を押し上げた。
- 旧依存の Tauri 2.10.3 / tauri-runtime-wry 2.10.1 は WebContent 終了時の復旧処理を持たなかった。[Tauri 2.11.0 の公式変更履歴](https://v2.tauri.app/release/tauri/v2.11.0/)に macOS/iOS の終了ハンドラ追加が記載されている。
- JS 側の終了前保存に待ち時間の上限がなく、描画側が応答しなければ終了へ進めなかった。さらに実機の SIGSTOP 試験では、WebContent が Cmd+Q を処理できず、ネイティブメニューをクリックした場合だけ終了する現象も再現した。

**修正**

- `src/js/bookshelf.js`: 読み込み済み文書を最大2件とし、非アクティブタブは60秒、画面非表示時は15秒で解放。読書位置・倍率・見開き・タブ情報は維持し、必要時に文書を読み直す。閉じたタブの worker 破棄完了も別途追跡する。
- 同ファイル: 本文とサムネイルの描画を直列化し、古い処理をキャンセル。本文canvasは新しいフレーム全体で8 Mi画素、各辺4096pxまでに制限し、ページと文書のキャッシュを描画後に解放。PDFは引き続きHTTP Range経由で読む。
- 同ファイル: 実WKWebViewで見つかった `ReadableStream` の非同期イテレータ非対応を、readerによる文字抽出へ変更して解消。キャンセル時にはPDF.jsが要求する `Error` を渡す。退避直後の復帰描画でも保存したスクロール位置を優先する。
- 同ファイル: 非表示中のfocus/resumeが解放タイマーを取り消す、またはblurが15秒の期限を60秒へ延ばすイベント順の競合を再現テストで発見。非表示中の解放期限を維持するようにした。
- `src-tauri/Cargo.toml` / `Cargo.lock`: Tauri 2.11.5、tauri-runtime-wry 2.11.4、wry 0.55.1へ更新し、WebContent終了後の自動リロードを有効にした。macOSのスリープ通知として誤用していた `RunEvent::Resumed` は削除。
- `src-tauri/src/shutdown.rs` / `shutdown/macos.rs`、`menu.rs`、`commands/app.rs`: Cmd+QをWebKitへ渡す前にアプリ内のネイティブ処理で受け取り、保存完了または2.5秒の期限で終了する。赤い閉じるボタンと終了メニューも同じ経路へ統一。
- `src-tauri/src/data_paths.rs` / `lib.rs`: `PAPERSTOCK_DATA_DIR` 指定時はDBとファイル置き場を隔離し、WebKitも非永続ストアにする。テストが実際の蔵書・タブ状態を変更しないための診断用設定。
- `src-tauri/src/pdf_server.rs`: HTTP要求をTCPの1回の受信で読み終えたと見なす不具合も既存テストで再現。分割到着したRangeヘッダを取りこぼさないよう、最大8 KiB・総5秒の上限でヘッダ終端まで読む。PDF本文の分割配信は維持した。この不具合単独と実際の7 GB超過との因果関係は未確定。

**検証方法と範囲**

- `node --test paperstock-tauri/tests/*.test.cjs` の21件、JS構文確認、`cargo check`、Rustテスト10件が成功。キャンセル・破棄待ち・読書状態・終了処理・HTTP分割受信を検証。Rustの通信テストはlocalhost待受のためサンドボックス外で実施。
- `tests/memory-reproduction/run.py` は実WKWebViewと本番JS/PDF.jsを使う独立再現テスト。3文書の巡回、300%拡大、連続描画、全24サムネイル、20秒非表示、復帰後の本文・文字選択を検証し、描画プロセスの physical footprint を記録する。再実行方法は同ディレクトリのREADME参照。
- 描画プロセスの強制終了によるホスト存続と、隔離した実Tauriアプリの自動リロードを別々に検証。応答不能時のCmd+Qも、専用WebContentだけをSIGSTOPして確認した。
- 最終DMGの実Tauri試験では、SIGKILL後の新WebContent起動・reload・10ページ/133%/見開きのUI復元・本棚への切替を確認。自動操作中は `window occluded=1` となり描画が休止するため、クラッシュ復旧後のPDF本文の目視確認は未確定（独立WKWebView試験の本文復帰成功とは区別する）。Cmd+Q停止試験では親・子とも終了し、通常のClose Windowでも読書設定を保存して終了した。詳細は `tmp/native-recovery-test/verification-summary.json`。
- PC全体のスリープや4 GB超過を故意に起こす検証はしていない。実際のメモリ超過終了は上記システムログで確認し、再現テストには1.25 GBの安全停止上限を設けている。短時間試験のメモリ値は長期間のあらゆるPDFでの上限保証ではない。

**最終比較結果**

同一の10.6 MB・24ページの合成PDFを3文書として開き、各6ページ巡回した。数値は描画プロセスのphysical footprint（10進MB）。最終版は11項目すべて成功し、非表示後の文書・canvas解放、復帰ページと文字選択も確認した。公開用の集計・ソースSHA・検証範囲は[検証サマリー](tests/memory-reproduction/results/2026-10-13.json)を参照。

| 条件 | 修正前 | 修正後 |
| --- | ---: | ---: |
| 3文書巡回後 | 574.1 MB | 405.5 MB |
| 非表示18秒後 | 241.0 MB | 136.2 MB |
| 再表示後 | 324.8 MB | 214.1 MB |
| 全操作を通じた観測ピーク | 703.8 MB | 680.7 MB |
| 最大同時描画数 | 8 | 1 |
| 300%拡大時の単一canvas | 17,449,344画素 | 8,383,230画素 |

測定中に画面が隠れた回、外部入力でページが変化した疑いのある回、未修正のタイマー競合で失敗した回は比較から除外し、別の証跡として残した。初期の「ピーク半減」という暫定測定値は最終結果として採用しない。ピークの改善はこの試験では約3%であり、主な効果は保持文書数・描画並列数の制限と非表示時の確実な解放にある。

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
