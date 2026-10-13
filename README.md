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
cd paperstock-tauri
npm install
```

## 🚀 起動

```bash
npm run dev
```

## 📦 アプリビルド（.dmg）

```bash
npm run build
```

`src-tauri/target/release/bundle/` 以下にアプリまたはインストーラが生成されます。

## 🛠 技術スタック

| 技術 | 用途 |
|------|------|
| [Tauri](https://tauri.app/) | デスクトップアプリフレームワーク |
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDFレンダリング |
| [rusqlite](https://github.com/rusqlite/rusqlite) | ブックメタデータ・コメント保存 |
| Vanilla JS + CSS | UI（フレームワーク不使用） |

## 📁 ファイル構成

```
Paperstock/
├── paperstock-tauri/
│   ├── src/           # HTML/CSS/JS frontend
│   ├── src-tauri/     # Rust backend / Tauri config
│   └── package.json
├── LICENSE
└── README.md
```

## 📄 ライセンス

[MIT](LICENSE)
