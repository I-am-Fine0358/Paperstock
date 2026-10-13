# Paperstock の PDF.js ローカル修正

対象: 同梱 PDF.js 5.5.207 の `pdf.mjs`。`pdf.worker.mjs` と公開 API のバージョンは変更していません。

## 2026-10-13: Worker の終了応答より先に HTTP 読み取りを中断する

`WorkerTransport.destroy()` 内の `#networkStream.cancelAllRequests()` を、`Terminate` の送信と終了応答待ちより前へ移しました。

元の実装では、Worker の `Terminate` 応答と各ページの終了がすべて完了した後に、メインスレッド上の HTTP fetch を中断していました。Worker が応答しないとその中断に到達しません。アプリが所有する native Worker を終了しても、別のメインスレッドで動作する fetch の AbortController は中断されません。

この修正は、文書の終了開始時点でネットワーク要求を先に中断します。PDF 本文の読み込み方式、Range 配信、Worker の終了応答待ちや通常のリソース解放は維持します。通信中断は既存の PDF.js のキャンセル処理を使い、新たな全ファイル読み込みは行いません。

これは Paperstock 独自の修正です。公式の [PR #21175](https://github.com/mozilla/pdf.js/pull/21175) は、読み込み時の handshake と終了の競合を扱う別の変更であり、この修正の根拠や同一不具合としては扱いません。PDF.js を更新するときは、上流の終了処理を確認し、この変更の要否を再評価してください。

検証: `node --test paperstock-tauri/tests/pdf-library-lifecycle.test.cjs`。同梱ファイルの `WorkerTransport` クラスを実行し、終了応答が来ない場合にも通信中断が先行すること、通信待ちの中断後に終了できること、重複した終了要求で中断が重複しないことを確認します。アプリ側の Worker 終了期限・再試行・読書状態は別の lifecycle テストで検証します。

## 2026-10-13: 通信キャンセル時の未処理 Promise 拒否を防ぐ

実 WKWebView で描画中の文書を閉じると、修正前後の両方で `AbortError: Fetch is aborted` が未処理の Promise 拒否として観測されました。

`PDFFetchStreamReader.cancel()` と `PDFFetchStreamRangeReader.cancel()` で、読み取り開始前でも拒否され得る headers/read capability の Promise に rejection handler を登録し、body reader の `cancel()` が返す Promise の拒否も終了処理として処理します。元の Promise は置換せず、後から `read()` する呼び出し元には同じエラーを返します。通常の通信エラー処理は変更せず、これらの handler は明示的な `cancel()` 呼び出しの中だけで登録します。

同じテストファイルで full/range の両方について、読み取り前の中断、body reader の中断失敗、通常の通信エラーの伝播を検証します。追加した回帰テストは修正前に4件が未処理の拒否で失敗し、修正後は9件すべて成功します。
