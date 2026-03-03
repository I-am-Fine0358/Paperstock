# 📚 Paperstock

macOSで動作するPDF管理・閲覧アプリ。本棚のようにPDFを整理し、快適に閲覧できます。

## ✨ 機能

- **本棚UI** — Apple Books風のカバー表示、タグで整理、ドラッグ＆ドロップで追加
- **スタック表示** — macOSスタック風にタグごとグループ化して表示
- **タブ式ビューア** — 複数のPDFを縦タブで切替、タブグループ機能付き
- **見開き表示** — 2ページを本のように並べて表示
- **スクロール方向** — 縦/横めくりを切替可能
- **ページコメント** — PDF上の任意の位置にコメントを配置・保存
- **キーボード操作** — 矢印キーでページ送り、⌘+W でタブ閉じ
- **カバー自動抽出** — PDFの1ページ目を自動でカバー画像に使用

## 🖥️ 必要要件

- macOS 12+
- Node.js 18+

## 📦 インストール

```bash
git clone https://github.com/YOUR_USERNAME/Paperstock.git
cd Paperstock
npm install
```

## 🚀 起動

```bash
npm start
```

## 📦 アプリビルド（.dmg）

```bash
npm run build
```

`dist/` フォルダにインストーラ（`.dmg`）が生成されます。

## 🛠 技術スタック

| 技術 | 用途 |
|------|------|
| [Electron](https://www.electronjs.org/) | デスクトップアプリフレームワーク |
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDFレンダリング |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | ブックメタデータ・コメント保存 |
| Vanilla JS + CSS | UI（フレームワーク不使用） |

## 📁 ファイル構成

```
Paperstock/
├── main.js            # Electronメインプロセス
├── preload.js         # コンテキストブリッジ
├── lib/
│   ├── database.js    # SQLite DB操作
│   └── pdf-utils.js   # PDF表紙抽出・ページ数取得
├── src/
│   ├── index.html     # メインUI
│   ├── css/
│   │   └── index.css  # スタイル
│   └── js/
│       └── bookshelf.js # アプリロジック
├── package.json
├── LICENSE
└── README.md
```

## 📄 ライセンス

[MIT](LICENSE)
