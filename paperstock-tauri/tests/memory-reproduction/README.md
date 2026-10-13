# メモリ・非表示復帰の再現テスト

macOS の実 WKWebView に、本番の `index.html`・`bookshelf.js`・PDF.js を読み込む検証です。Tauri IPC のみインメモリ実装へ置換し、`WKWebsiteDataStore.nonPersistent()` を使うため、Paperstock の DB と localStorage は変更しません。既定のメモリ試験では合成 PDF を生成します。`--fixture` で指定した PDF は読み取り専用で参照します。

リポジトリルートから次を実行します。Python 標準ライブラリと Xcode Command Line Tools の Swift が必要です。GUI ウィンドウが開き、20 秒間非表示になった後に戻ります。サンドボックス環境では localhost 配信と GUI 起動の許可が必要です。

```sh
python3 paperstock-tauri/tests/memory-reproduction/run.py --output tmp/memory-reproduction/current --assert-bounds
```

比較する JS を変更する場合は `--script /absolute/path/to/bookshelf.js` を付けます。`--fixture` で同一入力を指定できます。旧実装の再現時は `--assert-bounds` を外します。既定は 10.6 MB、24 ページの独立画像を含む PDF で、3 文書の各 6 ページを巡回します。`--image-size 768 --pages 24` は 42.5 MB の強い負荷になりますが、旧実装では途中で安全停止することがあります。

記録する操作と値:

- 3 文書のページ巡回、300% 拡大、復帰イベント、8 回の描画連打、サムネイル生成、本棚・既存タブへの切替
- 20 秒間の非表示と再表示、ページ位置・描画内容・文字選択の確認
- ネイティブ `proc_pid_rusage` による描画プロセスの physical footprint と resident bytes（RSS を圧縮領域等を含む footprint の代わりに扱わない）
- PDF.js の同時描画数、文書数、cleanup/destroy 回数、DOM canvas の画素数
- 専用 WKWebView の描画プロセスだけを最後に SIGKILL し、終了通知とホスト存続を確認

描画プロセスの footprint が 1.25 GB を超えたら終了します。macOS 全体をスリープさせたり、4 GB の WebKit メモリ終了上限を故意に超えたりしません。プロセス識別に使う非公開 getter はこのテスト専用で、本体には入りません。

`events.jsonl` に原記録、`summary.json` に集計、PNG に非表示前後の表示を保存します。終了後は WKWebView の snapshot API 自体が失敗することがあるため、終了通知だけを「白画面の画像確認」と解釈しないでください。このホストは意図的に自動リロードしません。Tauri 本体のクラッシュ復旧や Cmd+Q は、別途 `PAPERSTOCK_DATA_DIR` を指定した実アプリで確認する必要があります。

完走した同一条件の結果は、次で照合できます。

```sh
python3 paperstock-tauri/tests/memory-reproduction/compare.py tmp/memory-reproduction/before/summary.json tmp/memory-reproduction/after/summary.json tmp/memory-reproduction/comparison.json
```

単発の数値は WebKit の回収や圧縮タイミングでも変わるため、ピーク値だけで恒常的な削減率を断定しません。文書・canvas 解放、同時描画、読み位置などの assert と、操作ごとの footprint も合わせて確認します。

## 読み込み中に停止する場合の追加シナリオ

前述のメモリ試験は空の localStorage で起動し、PDF.js 初期化と各文書の読み込み完了を待ってから次の操作へ進みます。起動時のタブ復元や、読み込み途中の切替・非表示は検証していません。この経路は独立した `loading` モードで確認します。

```sh
python3 paperstock-tauri/tests/memory-reproduction/run.py --scenario loading --loading-case startup --restored-tabs 1 --start-page 6 --start-zoom 1.33 --output tmp/pdf-loading/startup
python3 paperstock-tauri/tests/memory-reproduction/run.py --scenario loading --loading-case all --start-page 6 --start-zoom 1.33 --output tmp/pdf-loading/transitions
```

任意の PDF は `--fixture` で指定できます。既定の 24 ページや合成 PDF の文字列を判定条件に使わず、指定ページの描画完了・読み込み表示の消失・canvas に白以外の画素があること・保存ズームの復元を確認します。内容が白紙のページは描画判定に適しません。本文の文字列や画像をログへ保存せず、ページ番号・画素数・処理段階だけを記録します。実ファイルを指定した場合、その SHA やローカルの原記録も公開物へ含めないでください。

Swift ホストを変更していない連続試験では、`--harness tmp/pdf-loading/startup/WebKitHarness` のように直前のバイナリを再利用すると再コンパイルを省けます。

- `startup`: アプリ JS 実行前に localStorage へ保存タブを設定し、最初の復元ロードを観測します。`--restored-tabs 1` は単一タブ、既定の `3` は 3 タブ中の 2 番目を復元します。
- `load-switch`: 3 タブ復元後、別タブの PDF.js が HTTP リクエストを送った所で応答を保留し、既存タブへ切り替えてから読み込み中だったタブへ戻ります。
- `load-hide`: 別タブの HTTP 読み込み中に専用ウィンドウを 20 秒非表示にし、復帰後に本文が描画されるか確認します。
- `all`: 上記を順に実行します。HTTP 応答の保留は最大 70 秒、通常の読み込み待ちは 60 秒です。`--load-timeout-ms` で後者を調整できます。
- `render-close`: 文書の読み込み成功後、本文の描画開始直後に既存タブへ切り替えて新タブを閉じ、既存本文へ戻れるか確認します。
- `render-evict-return`: 描画中の PDF から既存 PDF、本棚へ移動して文書上限による退避を発生させ、元の PDF タブへ戻ります。明示的にタブを閉じる操作も人工障害も使いません。
- `destroy-stall`: 実際の worker 破棄は完了させたうえで、`loadingTask.destroy()` の返却 Promise だけを未解決にする人工障害です。別タブが 10 秒以内に表示されるかを判定します。
- `terminate-stall`: PDF.js 内部の `Terminate` 応答を人工的に保留し、実際の Range リクエストも未応答にしてからタブを閉じます。ネイティブ Worker の終了、保留中 fetch の Abort、別タブの描画を確認します。
- `load-stall`: 実 PDF.js の読み込み結果をアプリへ返さず、60 秒の無進捗期限後にエラーと「再試行」が表示され、再試行で本文へ戻れるか確認します。この人工障害の判定は最大 75 秒待ちます。

人工障害は通常の `all` に含めません。失敗を注入した結果と、操作だけで発生した不具合は区別して記録してください。`--pdf-module` で比較対象の `pdf.mjs` も指定でき、アプリ JS とともに出力先へスナップショットを保存します。

`loading` モードは結果をコピーして返す非同期 IPC stub を使います。ただし UI と PDF は同じ HTTP origin であり、本物の `tauri://` UI、Rust の Range サーバ、CSP、Tauri IPC、プロセス再起動は再現しません。単独 WKWebView で成功しても実アプリの読み込み成功を保証しません。実アプリでは隔離した `PAPERSTOCK_DATA_DIR` と実際の IPC / ネットワークを使い、別途確認してください。`--assert-bounds` はメモリ試験専用で、`loading` モードには付けません。

## 2026-10-13 の読み込み停止・追加検証記録

公開用の[読み込み検証サマリー](results/2026-10-13-loading.json)には、実 PDF を読み取り専用で使った結果を集計しています。原本の名前・パス・SHA・本文・ページ画像は含めません。

103 MB / 308 ページの PDF で、描画中の PDF から別タブ、本棚へ移動して元の PDF に戻ると、旧版は「PDF読み込み中…」のまま停止しました。人工障害や明示的なタブ終了を使わない再現です。旧 PDF への終了要求に応答が戻らず、全タブ共通の終了待ちが次のロードを止めていました。修正版では Worker の終了期限を経て 3.606 秒で 32 ページを再表示しました。元のユーザーセッションの全事象が同一原因だったとまでは断定していません。

最終版では、本棚からの復帰、描画中タブ終了後の別 PDF、起動復元・読み込み途中の切替・非表示復帰、人工的な無進捗後の再試行を確認し、4 シナリオ 57 判定すべて成功、未処理エラーはゼロでした。無進捗試験では 60.210 秒後にエラーと再試行ボタンが出て、再試行後に本文を表示できました。既存の cMap フォント警告は残り、この実 PDF の文字選択は確認対象外です。

次は合成 PDF で同じ操作を実行する例です。停止の発生は PDF 内容とタイミングにも依存するため、合成 PDF だけで旧版の停止が必ず再現するわけではありません。指定ページが文書のページ数を超える場合は、アプリと同様に最終ページへ丸めて判定します。

```sh
python3 paperstock-tauri/tests/memory-reproduction/run.py --scenario loading --loading-case render-evict-return --start-page 6 --start-zoom 1.33 --output tmp/pdf-loading/bookshelf-return
```

## 2026-10-13 の初回メモリ検証記録

公開用の前後比較・ソースSHA・検証範囲は[検証サマリー](results/2026-10-13.json)を参照してください。合成PDFと隔離データだけを使用し、本人の蔵書には触れていません。ローカルの原ログ、ユーザー名、絶対パス、テストPIDは公開用サマリーに含めていません。

`tmp/memory-reproduction/comparison.json` は旧実装 `final-before` と、追加レビュー修正を含む最終版 `final-after` を比較します。最終版は 11 項目すべて成功し、console warning/error と外部入力混入もゼロでした。記録された最終 JS の SHA-256 は `143152c7e42ff175ae339e2312d6d82a1affbfe20a80f0bb16d231208f70158f` です。

同一 10,633,626 バイトの PDF を 3 文書で各 6 ページ巡回した時点の physical footprint は、旧 574.1 MB、最終版 405.5 MB。非表示 18 秒時は 241.0 MB と 136.2 MB、復帰後は 324.8 MB と 214.1 MB、全操作の観測ピークは 703.8 MB と 680.7 MB でした。復帰描画は 2 回から 1 回、同時描画最大数は 8 から 1、300% 表示の canvas は 17,449,344 画素から 8,383,230 画素になりました。

最終試験では本文・全 24 サムネイル・文字選択・復帰後 6 ページの表示・描画プロセス終了通知を確認しました。非表示 18 秒時は PDF 文書数と canvas 画素数がともにゼロ、復帰後は文書 1 個になりました。途中の失敗は `hidden-timer-race-*`、`unexpected-page-change-*`、`occlusion-timeout-*` に残し、成功値へ混ぜていません。

失敗試験を調べる過程で、非表示中の focus イベントが解放タイマーを解除し、後着の blur が 15 秒タイマーを 60 秒へ延長し得ることを発見しました。最終ソースではこの順序競合も修正され、fake clock の回帰テストと最後の実 WKWebView 試験が成功しました。WebKit は背景の JS タイマーを間引くため、実時間で厳密に 15 秒以内の解放を保証する試験ではありません。

強い入力（42,493,866 バイト、24 ページ巡回）では旧実装が 3 文書目の巡回中に 1,296.5 MB へ増え、安全停止しました。これは小さい入力の比較値とは別の試験です。4 GB の OS 終了上限や PC 全体のスリープは故意に再現していません。
