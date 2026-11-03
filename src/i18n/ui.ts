// 站台多語系核心：語言清單、路徑換算、chrome 字串取用。
//
// 設計決定（PM 2026-11-03）：
// - 英文留根路徑（現況 URL 零變動，國際訪客與既有連結／SEO 不受影響），
//   繁中走 /zh-tw/。不做依瀏覽器語言自動跳轉——跳轉讓同一 URL 有兩種內容，
//   對文件站與主站的一致性較差，也讓使用者貼的連結不可預期。
// - 字串表與結構分離：版面只寫一份，文案由本表的 key 取用，避免雙份
//   markup 各自漂移（英文改了、中文留舊宣稱是這類站最常出的事實錯誤）。
// - 缺譯一律回退英文並讓 build 期可偵測（見 t() 的開發期警告），
//   不得靜默顯示空白。

export const LANGS = ['en', 'zh-tw'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'en';

/** 顯示名（語言切換器用，一律用該語言自己的寫法，不翻譯成使用者介面語言）。 */
export const LANG_LABELS: Record<Lang, string> = {
  en: 'English',
  'zh-tw': '繁體中文',
};

/** HTML lang 屬性值。 */
export const HTML_LANG: Record<Lang, string> = {
  en: 'en',
  'zh-tw': 'zh-Hant',
};

/**
 * 站內路徑換算：把未在地化的基準路徑（'/'、'/roadmap'、'/playground'）
 * 換成指定語言的實際路徑。英文＝基準路徑本身。
 */
export function localizedPath(path: string, lang: Lang): string {
  const base = path === '' ? '/' : path.startsWith('/') ? path : `/${path}`;
  if (lang === DEFAULT_LANG) return base;
  const prefix = `/${lang}`;
  // Astro 本站是 trailingSlash: 'never'，因此一律不加尾斜線（GH Pages 端
  // 由 /zh-tw 301 到目錄頁，兩種主機都走得通；加尾斜線會在 preview 端 404）。
  if (base === '/') return prefix;
  return base === prefix ? prefix : `${prefix}${base}`;
}

/**
 * 從實際 URL 路徑反推基準路徑與語言（供語言切換器保持同頁跳轉）。
 */
export function parseLocalizedPath(urlPath: string): { lang: Lang; base: string } {
  const clean = urlPath.replace(/\/+$/, '') || '/';
  for (const lang of LANGS) {
    if (lang === DEFAULT_LANG) continue;
    const prefix = `/${lang}`;
    if (clean === prefix) return { lang, base: '/' };
    if (clean.startsWith(`${prefix}/`)) return { lang, base: clean.slice(prefix.length) || '/' };
  }
  return { lang: DEFAULT_LANG, base: clean || '/' };
}

/**
 * hreflang 替代連結（alternates）清單（含 x-default＝英文）。
 * Astro.site 提供絕對位址基底。
 */
export function localeAlternates(site: URL, base: string) {
  return LANGS.map((lang) => ({
    hreflang: lang === DEFAULT_LANG ? 'x-default' : 'zh-Hant-TW',
    href: new URL(localizedPath(base, lang), site).href,
  }));
}

import en from './en.json';
import zhTw from './zh-tw.json';

const DICTS: Record<Lang, Record<string, string>> = { en, 'zh-tw': zhTw };

/**
 * 依前綴取整組字串（key 去掉前綴）。給 public/ 下的靜態腳本用：
 * 那些檔案不經 i18n 建置，字串由頁面以 data-* 一次性帶入，
 * 如此字串的單一來源仍是這裡的字典，靜態檔只保留一份英文退回值。
 */
export function stringsFor(lang: Lang, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(DICTS[DEFAULT_LANG])) {
    if (!k.startsWith(prefix)) continue;
    const short = k.slice(prefix.length);
    out[short] = DICTS[lang]?.[k] ?? v;
  }
  return out;
}

/**
 * 取字串：查無此 key 時回退英文（避免整頁開天窗），並在缺譯時留可撿查的痕跡。
 * 站內所有可見文案都要走 t()，markup 不寫死文案。
 */
export function t(lang: Lang, key: string): string {
  const hit = DICTS[lang]?.[key];
  if (hit !== undefined) return hit;
  const fallback = DICTS[DEFAULT_LANG][key];
  if (fallback === undefined) {
    // 建站期自檢用：key 打錯時 build log 會留名，不靜默輸出空白
    console.warn(`[i18n] 查無 key：${key}`);
    return key;
  }
  console.warn(`[i18n] ${lang} 缺譯，回退英文：${key}`);
  return fallback;
}
