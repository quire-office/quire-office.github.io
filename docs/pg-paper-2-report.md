# playground 紙張設定面板實作報告

## 工作區與引擎資產

工作區為 `/home/jerry/projects/quire-www-pp2`，分支 `oc/pg-paper2`，基線為最新 main；Node 使用 nvm v22.23.2。開工第一步實跑 `grep -o "new_with_paper\|paper_json" public/playground/quire_web.js | sort -u`，輸出為 `new_with_paper` 與 `paper_json` 兩行，確認符號存在，未自造 API。工作區初始的 `public/playground/` 內沒有 `quire_web.js` 與 `quire_web_bg.wasm`（`.gitignore` 明文排除引擎二進位），因此先執行 `npm run fetch:wasm`，自 GitHub release `v0.1.0-beta.9` 下載兩個資產並通過 `playground.assets.json` 的 sha256 驗證，二進位未進入版本控制。全程未執行任何 git 寫入操作。

## 改動檔案清單

- `public/playground/playground.js`：新增紙張設定狀態、表單驗證、`new_with_paper` 重建引擎、`paper_json()` 狀態列、URL query 還原與寫入、窄屏預設收合；既有渲染取數入口 `page_display_list_json` 與重繪路徑未改。
- `public/playground/playground-paper.css`：新增紙張面板樣式，沿用站體既有 CSS 變數、直角與細線語彙，未引入任何 UI 框架。
- `src/components/PlaygroundPage.astro`：加入紙張面板 DOM、CSS 引用與 `t()` 字串取用；只加面板與引用，未動渲染管線。
- `src/i18n/en.json`、`src/i18n/zh-tw.json`：新增 `pg.js.paper.*` 共 37 鍵，雙語 key 集合完全對齊。
- `docs/pg-paper-2-report.md`：本報告。

## 七項驗收實際結果

驗收使用 headless Chrome 153 加 CDP 實測，透過 `astro preview` 載入 `/playground`，以 `DOM.setFileInputFiles` 上傳語料 `corpus/ooxmlexport/FDO77715.docx`（117.7 KB，非任何使用者真實檔案），讀取實際 DOM 狀態、`#page-info`、`#paper-status` 與 canvas 尺寸；另以 node 直接載入 `quire_web.js`／`quire_web_bg.wasm` 對 API 做探針。以下數字均為實跑輸出。

1. 上傳語料後選 A3：文件原始為 Letter 612.00 × 792.00 pt（215.9 × 279.4 mm）、29 頁；選 A3 後 `paper_json()` 狀態列顯示 841.89 × 1190.55 pt（297.0 × 420.0 mm）· overridden，頁數由 29 變 16，canvas 為 850 × 1202（依 `paper_json()` 的 841.89 × 1190.55 等比換算）。通過。
2. 自訂 210 × 297 mm 與選 A4 逐位相同：兩者狀態列皆為 595.28 × 841.89 pt（210.0 × 297.0 mm）· overridden，頁數皆 27，canvas 皆 850 × 1202，字串逐位相同。通過。
3. 還原文件原始：頁數 29、canvas 850 × 1100，與改動前基準完全相同；狀態列回到 612.00 × 792.00 pt（215.9 × 279.4 mm）· document original，`paper_override_applied` 為 false。通過。
4. 非法輸入：寬 10 mm 顯示行內純文字 `Out of range: 72–1584 pt.`；空值顯示 `Enter both width and height.`；`abc` 以 text 型別注入繞過 number 輸入清洗後顯示 `Width and height must be numeric.`。三次皆未重建引擎，頁數與 canvas 尺寸維持 27 與 850 × 1202，未出現 alert。通過。
5. `?paper=a3` 深連結：頁面載入後 `#paper-preset` 已還原為 `a3`，上傳同一語料後即為 A3，狀態列 841.89 × 1190.55 pt、頁數 16。另測 `?pw=210&ph=297&u=mm`，載入後為 custom 210 × 297 mm、頁數 27；套用後 URL 會同步為 `?pw=210&ph=297&u=mm`，加邊距時再帶 `mt/mb/ml/mr`。通過。
6. EN／ZH 切換：ZH 面板實測字串為「紙張設定／紙型／文件原始（不覆寫）／自訂／單位／寬度／高度／邊距（選填；留空沿用文件邊距）／套用」，狀態列為「目前生效紙張 … · 文件原始」；EN 對應字串齊全。`npm run check:i18n` 顯示 302 keys 對齊、零缺譯、零簡體字形、零中文軟換行。通過。
7. `npm run build`：exit 0，6 頁建置完成；`npm run check` 亦通過（6 pages、44 files、無外部執行期引用；i18n 302 keys 對齊）。通過。

API 探針補充：`new WasmEngine(bytes)` 對同一語料的 `paper_json()` 為 `page_w_pt` 595.2999877929688、`page_h_pt` 841.9000244140625、`paper_override_applied` false（此探針檔本身為 A4 尺寸）；`WasmEngine.new_with_paper(bytes, 841.89, 1190.55)` 回傳 `page_w_pt` 841.8900146484375、`page_h_pt` 1190.550048828125、`paper_override_applied` true；傳入四邊邊距 10/20/30/40 pt 時 `paper_json()` 如實回傳 10.0/20.0/30.0/40.0，證實 `undefined` 與數值邊距兩條路徑皆可用。

## npm run build 輸出尾段

```text
10:25:58 [@astrojs/sitemap] `sitemap-index.xml` created at `dist`
10:25:58 [build] 6 page(s) built in 1.40s
10:25:58 [build] Complete!
```

## 未收口項

- 紙張面板位於 `viewer-panel` 內，只有文件載入後才可見；深連結會在頁面載入時先還原下拉與輸入值，待文件載入後才實際套用。若產品要求在未載入文件前就常駐顯示面板，屬本卡範圍外的版面調整。
- 選「文件原始」但邊距欄仍有數值時，語意為「原紙張尺寸加自訂邊距」，此時 `paper_json()` 的 `paper_override_applied` 為 true、狀態列顯示已覆寫；若產品要求「文件原始」一律清空邊距，需另立需求確認。
- 邊距目前只檢查數值合法性與頁面可排版空間（左右總和須小於頁寬、上下總和須小於頁高），未逐邊比對文件原有頁首頁尾區域；引擎端未提供此回饋。
- 紙張覆寫只作用於首 section，這是 `new_with_paper` 的既有契約；多 section 分別設定不在本卡範圍。
- 窄屏收合只在頁面初始載入時依 `matchMedia('(max-width: 640px)')` 決定；載入後才把視窗縮窄不會自動收合，仍可手動收合。
- 自訂寬高或邊距在切換單位時不會自動換算既有數值，數值會被視為新單位解讀；目前要求使用者自行重填，若需自動換算可另立需求。
- CSS 引用採 body 內的 `<link rel="stylesheet" href="/playground/playground-paper.css">`；`Base.astro` 沒有 head slot 且不在本卡白名單，瀏覽器可正常載入，但若要嚴格把 link 放進 `<head>`，需 PM 授權改 `Base.astro`。
- 引擎資產由 `npm run fetch:wasm` 取得，未提交進 repo；PM 覆核後若在乾淨環境建置，仍需先跑一次 `npm run fetch:wasm`（`prebuild` 已會自動嘗試）。
