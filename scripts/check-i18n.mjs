#!/usr/bin/env node
// i18n 閘門：守住「雙語不會各自漂移」這件事。
//
// 主站的本地化採一份結構元件＋雙字典（見 src/i18n/ui.ts 的決定）。這個設計
// 只在字典 key 齊全時成立：缺一個 key，該語言的版面就會回退英文，混語言的
// 頁面看起來像壞了但 build 照樣綠燈。因此這裡把三件事當硬閘門：
//   1) en 與 zh-tw 的 key 集合完全相同（缺譯/多譯都算紅燈）
//   2) 元件裡出現的每個 t(lang, 'key') 都在字典存在（打錯字＝紅燈）
//   3) 繁中字典不含簡體字形（opencc 比對；白名單見腳本內）
// 另外偵測「中文散文被軟換行切開」——Markdown/HTML 會把段內硬換行讀成詞中
// 間的半形空格，是使用者點名過的跑版問題。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const I18N = join(ROOT, 'src/i18n');
const problems = [];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.worktrees') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const en = JSON.parse(readFileSync(join(I18N, 'en.json'), 'utf8'));
const zh = JSON.parse(readFileSync(join(I18N, 'zh-tw.json'), 'utf8'));

// ---- 1) key 集合對齊 ----
const enKeys = Object.keys(en);
const zhKeys = Object.keys(zh);
const onlyEn = enKeys.filter((k) => !(k in zh));
const onlyZh = zhKeys.filter((k) => !(k in en));
if (onlyEn.length) problems.push(`繁中缺 key（會回退英文）: ${onlyEn.join(', ')}`);
if (onlyZh.length) problems.push(`繁中有英文沒有的 key（打錯或殘留）: ${onlyZh.join(', ')}`);

// ---- 2) 元件引用的 key 必須存在 ----
const srcFiles = [...walk(join(ROOT, 'src'))].filter((f) => ['.astro', '.ts', '.js'].includes(extname(f)));
const used = new Set();
for (const f of srcFiles) {
  const txt = readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/t\(\s*(?:lang|props\.lang)\s*,\s*['"]([^'"]+)['"]/g)) used.add(m[1]);
}
for (const k of used) {
  if (!(k in en)) problems.push(`元件引用不存在的 key: ${k}`);
}

// ---- 3) 靜態腳本 I18N.get('x') 需對應 pg.js.x（或 pg.x）----
const jsFiles = [...walk(join(ROOT, 'public'))].filter((f) => extname(f) === '.js');
for (const f of jsFiles) {
  const txt = readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/I18N\.get\(\s*['"]([^'"]+)['"]/g)) {
    const k = m[1];
    if (!(k.startsWith('pg.') ? k : `pg.js.${k}`) in en && !(`pg.js.${k}` in en) && !(k in en)) {
      problems.push(`${f.replace(ROOT + '/', '')}: I18N.get("${k}") 無對應字典 key（pg.js.${k}）`);
    }
  }
}

// ---- 4) 繁中簡體字形掃描（opencc 逐字元比對）----
// opencc 的純 JS port 列為 devDependency：它才是「這個字是簡體寫法」的權威判斷，
// 手刻字表會漏也會誤殺，因此不做。白名單是專案既有慣例（兩地通用或繁體常用字），
// 逐字元比對对它會誤報，放行理由寫在下一行。
// 里：里程碑／公里；群：標準繁體字形（opencc 想轉成異體 羣）。
const { Converter } = await import('opencc-js');
const toTraditional = Converter({ from: 'cn', to: 'tw' });
const WHITE = new Set('稽核台了干吃于才回藉游岩晒峰里群'.split(''));
function simplifiedHits(text) {
  const hits = new Map();
  for (const ch of new Set(text)) {
    if (ch < '\u3400' || ch > '\u9fff' || WHITE.has(ch)) continue;
    const conv = toTraditional(ch);
    if (conv !== ch) hits.set(ch, conv);
  }
  return [...hits].map(([a, b]) => `${a}→${b}`).join(' ');
}
for (const [k, v] of Object.entries(zh)) {
  const h = simplifiedHits(String(v));
  if (h) problems.push(`繁中字典 ${k} 含簡體字形: ${h}`);
}
for (const f of jsFiles) {
  const h = simplifiedHits(readFileSync(f, 'utf8'));
  if (h) problems.push(`${f.replace(ROOT + '/', '')} 含簡體字形: ${h}`);
}

// ---- 5) 中文散文軟換行（段內硬換行會被讀成詞中間半形空格）----
// 中文段落一律寫成一整行，因此：非空、非結構行（清單/表格/標題/引用/標籤）的
// 相鄰兩行，若前一行以中文或中文標點收尾且後一行以中文起頭，視為軟換行跑版。
// HTML 註解與 frontmatter 不是可見內容，先剝除再比，否則註解的縮排換行會誤報。
function visibleLines(txt, isAstro) {
  let body = txt;
  if (isAstro) {
    body = body.replace(/^---[\s\S]*?^---$/m, '');                 // frontmatter
    body = body.replace(/<style[\s\S]*?<\/style>/g, ' ');          // style 區塊非可見文字
    body = body.replace(/<script[\s\S]*?<\/script>/g, ' ');        // script 區塊同理
    body = body.replace(/<!--[\s\S]*?-->/g, ' ');                  // HTML 註解
  }
  body = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');  // 程式碼註解
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('import ') && !l.includes('<') && !l.includes('>'));
}
for (const f of srcFiles) {
  const isAstro = f.endsWith('.astro');
  const lines = visibleLines(readFileSync(f, 'utf8'), isAstro);
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (/^[#|>*\-{}()\[\]]/.test(a) || /^[#|>*\-{}()\[\]]/.test(b)) continue;
    if (/[，。；：、）】”]$/.test(a) && /^[“「\u3400-\u9fff]/.test(b)) {
      problems.push(`${f.replace(ROOT + '/', '')} 中文段內軟換行（會跑版成半形空格）: …${a.slice(-18)} ▏${b.slice(0, 18)}…`);
    }
  }
}
// 字典值本身不該含換行（換行進了 HTML 文字節點就是同款跑版）
for (const [k, v] of Object.entries(zh)) {
  if (String(v).includes('\n')) problems.push(`繁中字典 ${k} 含換行（會跑版）`);
}
for (const [k, v] of Object.entries(en)) {
  if (String(v).includes('\n')) problems.push(`英文字典 ${k} 含換行`);
}

if (problems.length) {
  console.error(`✗ i18n 閘門 FAILED（${problems.length} 項）:`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(
  `✓ i18n 閘門 passed — ${enKeys.length} keys（en/zh-tw 對齊）、` +
    `${used.size} 個元件 key、${jsFiles.length} 支靜態腳本字串、簡體掃描與軟換行零命中`,
);
