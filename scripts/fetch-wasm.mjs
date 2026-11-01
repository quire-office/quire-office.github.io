// Playground WASM 資產取得管線
// 目的：網頁 repo 嚴禁直接提交引擎二進位；改由本腳本在 build 前取得 wasm 產物。
//
// 取得順序（降級鏈）：
//   1) GitHub release 下載（URL 模板見 playground.assets.json），sha256 必須與清單相符；
//      相符才寫入 public/playground/，且成功時順手清掉舊的 MISSING-ASSETS.md。
//   2) release 下載失敗（404／斷網／未發 release）→ 降級：自本機引擎倉
//      shells/web/pkg/ 複製，並列印醒目警告「使用本機建置，非 release」；
//      sha256 仍需與清單相符，不符視同清單過期，直接失敗（明確訊息）。
//   3) 兩者皆失敗 → 佔位模式：產生 public/playground/MISSING-ASSETS.md（說明跑
//      npm run fetch:wasm），本腳本以 0 退出；Astro 靜態構建不因缺資產失敗，
//      playground 頁面 JS 會偵測 wasm 404 並顯示具體補救指示。
//
// 用法：node scripts/fetch-wasm.mjs（npm run fetch:wasm；亦由 prebuild 自動呼叫）

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_PATH = join(ROOT, 'playground.assets.json');

// ---------------------------------------------------------------------------
// 進度與輸出（PM/CI 看得到每一步，不用猜）
// ---------------------------------------------------------------------------

const note = (msg) => console.log(`[fetch-wasm] ${msg}`);
const warn = (msg) => console.warn(`[fetch-wasm] ⚠️  ${msg}`);
const die = (msg) => {
  console.error(`\n[fetch-wasm] ✋ 失敗：${msg}`);
  console.error('[fetch-wasm] 修正後重跑：npm run fetch:wasm');
  process.exit(1);
};

// 佔位說明：MANIFEST 內容缺檔時，交由頁面與此文件向人類解釋如何補救
function writeMissingGuide(reason) {
  const lines = [
    '# Playground 資產缺檔（佔位說明，非引擎錯誤）',
    '',
    '本站構建時未取得 playground 所需的 WASM 引擎產物',
    '（`quire_web_bg.wasm`、`quire_web.js`）。引擎二進位依規定不進網頁 repo，',
    '需 build 前先行取得。',
    '',
    `自動取得失敗原因：${reason}`,
    '',
    '## 補救方式',
    '',
    '在本 repo 根目錄執行：',
    '',
    '```sh',
    'npm run fetch:wasm',
    '```',
    '',
    '腳本會依 `playground.assets.json` 的記載，先嘗試從 GitHub release 下載，',
    '失敗時自動降級複製本機引擎倉 `shells/web/pkg/` 下的建置產物，',
    '並以 sha256 驗證完整性。取得後重新 `npm run build && npm run preview` 即可。',
    '',
    '在補上資產之前，/playground/ 頁面會顯示「引擎資產缺失」的具體指示，',
    '其餘站頁不受影響。',
    '',
  ];
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'MISSING-ASSETS.md'), lines.join('\n'));
  note('已產生 public/playground/MISSING-ASSETS.md（佔位說明）');
}

function printWarningBox(lines) {
  console.warn('[fetch-wasm]', '='.repeat(64));
  for (const line of lines) console.warn(`[fetch-wasm] ${line}`);
  console.warn('[fetch-wasm]', '='.repeat(64));
}

// ---------------------------------------------------------------------------
// 清單讀取
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const targetDir = join(ROOT, manifest.target_dir ?? 'public/playground/');
if (!manifest.assets?.length) die(`${MANIFEST_PATH} 內 assets 為空，無法取得任何資產`);

function sha256File(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function verifyCopy(srcPath, entry, sourceLabel) {
  const actual = sha256File(srcPath);
  if (actual !== entry.sha256) {
    die(
      `sha256 驗證不相符（${sourceLabel}）。檔案：${entry.file}\n` +
        `  期望：${entry.sha256}\n  實得：${actual}\n` +
        `  若引擎已更新，請以新產物重算 sha256 並更新 playground.assets.json，勿直接跳過驗證。`
    );
  }
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, entry.file);
  rmSync(dest, { force: true });
  copyFileSync(srcPath, dest);
  note(`✔ ${entry.file}（sha256 相符，來源：${sourceLabel}）→ ${resolve(dest)}（${statSync(dest).size} bytes）`);
}

// ---------------------------------------------------------------------------
// 路徑 1：GitHub release 下載
// ---------------------------------------------------------------------------

function releaseUrlFor(entry) {
  return (manifest.release_url_template ?? '').replace('{version}', manifest.version).replace('{file}', entry.file);
}

async function tryFetchRelease(entry) {
  const url = releaseUrlFor(entry);
  if (!url) throw new Error('清單缺 release_url_template');
  note(`嘗試自 release 下載：${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = join(targetDir, `.${entry.file}.download`);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(tmp, buf);
  // 下載完再驗證：不相符即死，絕不讓壞資產混進 public/
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== entry.sha256) {
    rmSync(tmp, { force: true });
    die(
      `release 下載的 ${entry.file} sha256 驗證不相符。\n` +
        `  期望：${entry.sha256}\n  實得：${actual}\n` +
        `  可能是 release 被換檔或清單過期；請確認後更新 playground.assets.json。`
    );
  }
  const dest = join(targetDir, entry.file);
  rmSync(dest, { force: true });
  copyFileSync(tmp, dest);
  rmSync(tmp, { force: true });
  note(`✔ ${entry.file}（sha256 相符，來源：GitHub release v${manifest.version}）`);
}

async function main() {
  note(`版本：v${manifest.version}`);
  const hasLocalFallback = existsSync(manifest.local_fallback_dir ?? '');

  for (const entry of manifest.assets) {
    // --- 降級鏈路徑 1：GitHub release ---------------------------------------
    try {
      await tryFetchRelease(entry);
      continue;
    } catch (err) {
      warn(`release 下載失敗（${entry.file}）：${err.message}`);
    }

    // --- 降級鏈路徑 2：本機 quire/shells/web/pkg ----------------------------
    const localPath = join(manifest.local_fallback_dir ?? '', entry.file);
    if (hasLocalFallback && existsSync(localPath)) {
      printWarningBox([
        '⚠️  使用本機建置，非 release。',
        `⚠️  資產 ${entry.file} 取自本機引擎倉：${manifest.local_fallback_dir}`,
        `⚠️  此路徑僅供開發機降級救急；正式站頁一律需由 GitHub release 下載（v${manifest.version}）。`,
      ]);
      // 本機產物同樣必須過 sha256 關卡：清單不符即死，避免引用到過期引擎。
      verifyCopy(localPath, entry, '本機 shells/web/pkg');
      continue;
    }

    // --- 降級鏈路徑 3：佔位模式 --------------------------------------------
    note(`本機降級路徑亦不可用（${entry.file}），進入佔位模式。`);
    writeMissingGuide(
      `release（v${manifest.version}）下載失敗，且本機 ${localPath} 不存在`
    );
    printWarningBox([
      '⚠️  PLAYGROUND 資產缺失（佔位模式，構建照常通過）。',
      `⚠️  release 與本機降級路徑皆失敗，未寫入 ${entry.file}。`,
      '⚠️  已產生 public/playground/MISSING-ASSETS.md；頁面會顯示缺資產指示。',
      `⚠️  補救：確認 release v${manifest.version} 已掛上引擎資產，或本機存在 ${manifest.local_fallback_dir}，`,
      '⚠️  再執行 npm run fetch:wasm。',
    ]);
    return; // 行為設計：佔位模式不算失敗，以 0 退出讓 prebuild 告一段落
  }

  // 全數取得成功：清掉歷史殘留的佔位說明
  const missing = join(targetDir, 'MISSING-ASSETS.md');
  if (existsSync(missing)) {
    rmSync(missing, { force: true });
    note('✔ 已清掉舊的 MISSING-ASSETS.md（資產已補齊）');
  }
  note('全部資產就緒。');
}

main().catch(die);
