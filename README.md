# www

Quire main site — static Astro (SSG) build, deployed to GitHub Pages with a custom
domain (`quireoffice.dev`, CNAME in `public/`).

## Commands

    npm install
    npm run dev        # astro dev server
    npm run build      # static build → dist/ (must be zero errors)
    npm run preview    # serve dist/ locally for walkthrough
    npm run check:local

`check:local` is the self-containment gate: it fails the build if anything in `dist/`
references a CDN (fonts, JS), links the still-private engine repository, or drops below
the expected page count. Fonts and brand assets are committed under `public/` — the site
renders fully offline.

## Playground WASM 資產管線

`/playground/` 是唯一需要引擎二進位的頁面。依規定 **引擎 wasm 產物一律不進網頁 repo**
（二進位會隨引擎更版造成倉庫膨脹），build 前由 `scripts/fetch-wasm.mjs` 依
`playground.assets.json`（進 git 的版本＋sha256 清單）取得：

1. **GitHub release（正式路徑）**：自
   `github.com/quire-office/quire/releases/download/v<版本>/` 下載
   `quire_web_bg.wasm` 與 `quire_web.js`；sha256 驗證相符才落地，不符即中止並明確報錯。
2. **本機降級（開發救急）**：release 404／斷網時，改複製本機引擎倉
   `/home/jerry/projects/quire/shells/web/pkg/` 的建置產物，並印出醒目警告
   「使用本機建置，非 release」；sha256 同樣必須與清單相符。
3. **佔位模式**：兩條路徑皆失敗時，產生 `public/playground/MISSING-ASSETS.md`
   說明補救方式，構建照常通過；/playground/ 頁面會偵測資產 404 並顯示具體指示。

常用命令：

    npm run fetch:wasm    # 手動取得／更新 wasm 資產
    npm run build         # prebuild 會自動執行 fetch（缺資產不炸構建）

發行：引擎倉掛出對應 tag 的 GitHub release（附上兩個 wasm 產物檔）後，
更新 `playground.assets.json` 的版本與 sha256 即可；在 release 正式掛上資產前，
開發機一律走本機降級路徑，不受影響。發 release 的動作由 CI／PM 執行，不在本管線腳本內。

## Structure

    src/layouts/Base.astro   # head/meta/OG, header, footer
    src/pages/index.astro    # hero + evidence stats + format road (DOCX → XLSX → PPTX)
    src/pages/roadmap.astro  # external-facing roadmap
    src/pages/playground.astro  # WASM playground skeleton (real render: separate task)
    src/styles/              # ink/paper/vermilion design tokens, self-hosted @font-face
    public/brand/            # logo/lockups/banner/social preview (from quire brand/)
    public/fonts/            # latin woff2 subsets, SIL OFL 1.1

## Design rules (from brand/README.md)

- Ink `#111111` / paper `#FAF8F4` / vermilion `#C43120` (accent only) / charcoal `#181A1E`.
- Dark mode follows `prefers-color-scheme`; text accents use the lightened vermilion
  variant `#E4574A` there (contrast), the logo fold keeps exact `#C43120`.
- Headings in Source Serif 4 (self-hosted), mono labels in IBM Plex Mono (self-hosted).
- No emoji, no AI-style illustration — geometry and typography only.
- Copy discipline: the engine repository is private until launch — never link
  `github.com/quire-office/quire`; positioning is "Private preview — opens when the
  foundations hold" (no ship-today claims).

## Publishing

GitHub Pages workflow is wired by the maintainer after the first merge
(`quire-office.github.io/www` → `quireoffice.dev` via CNAME). `astro.config.mjs`
`site` must match the live origin for canonical/OG/sitemap URLs.
