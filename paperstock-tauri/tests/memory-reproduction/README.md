# メモリ・非表示復帰の再現テスト

macOS の実 WKWebView に、本番の `index.html`・`bookshelf.js`・PDF.js を読み込む検証です。Tauri IPC のみインメモリ実装へ置換し、`WKWebsiteDataStore.nonPersistent()` を使うため、Paperstock の DB と localStorage は変更しません。合成 PDF のみ読みます。

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

## 2026-10-13 の検証記録

公開用の前後比較・ソースSHA・検証範囲は[検証サマリー](results/2026-10-13.json)を参照してください。合成PDFと隔離データだけを使用し、本人の蔵書には触れていません。ローカルの原ログ、ユーザー名、絶対パス、テストPIDは公開用サマリーに含めていません。

`tmp/memory-reproduction/comparison.json` は旧実装 `final-before` と、追加レビュー修正を含む最終版 `final-after` を比較します。最終版は 11 項目すべて成功し、console warning/error と外部入力混入もゼロでした。記録された最終 JS の SHA-256 は `143152c7e42ff175ae339e2312d6d82a1affbfe20a80f0bb16d231208f70158f` です。

同一 10,633,626 バイトの PDF を 3 文書で各 6 ページ巡回した時点の physical footprint は、旧 574.1 MB、最終版 405.5 MB。非表示 18 秒時は 241.0 MB と 136.2 MB、復帰後は 324.8 MB と 214.1 MB、全操作の観測ピークは 703.8 MB と 680.7 MB でした。復帰描画は 2 回から 1 回、同時描画最大数は 8 から 1、300% 表示の canvas は 17,449,344 画素から 8,383,230 画素になりました。

最終試験では本文・全 24 サムネイル・文字選択・復帰後 6 ページの表示・描画プロセス終了通知を確認しました。非表示 18 秒時は PDF 文書数と canvas 画素数がともにゼロ、復帰後は文書 1 個になりました。途中の失敗は `hidden-timer-race-*`、`unexpected-page-change-*`、`occlusion-timeout-*` に残し、成功値へ混ぜていません。

失敗試験を調べる過程で、非表示中の focus イベントが解放タイマーを解除し、後着の blur が 15 秒タイマーを 60 秒へ延長し得ることを発見しました。最終ソースではこの順序競合も修正され、fake clock の回帰テストと最後の実 WKWebView 試験が成功しました。WebKit は背景の JS タイマーを間引くため、実時間で厳密に 15 秒以内の解放を保証する試験ではありません。

強い入力（42,493,866 バイト、24 ページ巡回）では旧実装が 3 文書目の巡回中に 1,296.5 MB へ増え、安全停止しました。これは小さい入力の比較値とは別の試験です。4 GB の OS 終了上限や PC 全体のスリープは故意に再現していません。
