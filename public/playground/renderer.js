// Quire Playground 渲染核心模組
// 負責解析 WasmEngine 顯示列表（Display List）並繪製至 Canvas2D，
// 包含 DOCX 容器檢驗、ARGB 顏色換算與分頁繪製邏輯。

/**
 * 預設顯示寬度（px）
 */
export const DEFAULT_DISPLAY_WIDTH_PX = 850;

/**
 * 將 0xAARRGGBB 無號 32 位元色值換算為 Canvas2D 的 rgba() 字串
 * @param {number} [argb=0xff000000]
 * @returns {string}
 */
export function argbToCss(argb = 0xff000000) {
  const u = argb >>> 0;
  const a = ((u >>> 24) & 0xff) / 255;
  const r = (u >>> 16) & 0xff;
  const g = (u >>> 8) & 0xff;
  const b = u & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

/**
 * 格式化檔案位元組大小
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 正規化檔名供副檔名比對：去掉首尾所有 Unicode 空白（含全形空格 U+3000、
 * NBSP U+00A0）與不可見控制字元（零寬 U+200B–200D、U+2060、BOM U+FEFF，
 * 以及雙向格式字元 U+200E–200F／U+202A–202E／U+2066–2069）。
 * 只動首尾、不動檔名中間，避免把使用者看得見的檔名改錯。
 * @param {string} fileName
 * @returns {string} 小寫化的正規檔名
 */
export function normalizeFileName(fileName) {
  const raw = String(fileName || "");
  const strip =
    " \\t\\n\\r\\f\\v\\u00a0\\u1680\\u2000-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u205f\\u2060-\\u2069\\u3000\\ufeff";
  return raw.replace(new RegExp(`^[${strip}]+|[${strip}]+$`, "g"), "").toLowerCase();
}

/**
 * 掃 ZIP 中央目錄的明文 entry 名稱辨識容器種類（副檔名不可信時的退回路徑）。
 * ODT 一定有 `mimetype` 條目且內容為 ODF MIME；DOCX 一定有 `word/document.xml`。
 * 兩者皆明文存於 entry 名稱，故 bytes 直接掃即可，不必解 ZIP。
 * @param {Uint8Array} bytes
 * @returns {"docx"|"odt"|null}
 */
export function sniffContainerKind(bytes) {
  if (!bytes || bytes.byteLength < 4) return null;
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null; // 非 ZIP 不猜
  const needle = (s) => {
    const n = new TextEncoder().encode(s);
    outer: for (let i = 0; i + n.length <= bytes.length; i++) {
      for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
      return true;
    }
    return false;
  };
  if (needle("word/document.xml")) return "docx";
  if (needle("application/vnd.oasis.opendocument.text")) return "odt";
  return null;
}

/**
 * 檢驗是否符合唯讀渲染支援的容器格式（DOCX／ODT，兩者皆 ZIP 容器），
 * 並回傳格式種類供呼叫端分派引擎（WasmEngine／WasmOdtView）。
 * @param {string} fileName
 * @param {Uint8Array} bytes
 * @returns {{ valid: boolean, kind?: "docx"|"odt", error?: string, reason?: string, ext?: string }}
 */
export function validateDocumentFile(fileName, bytes) {
  if (!bytes || bytes.byteLength === 0) {
    return {
      valid: false,
      reason: "FILE_EMPTY",
      // error 僅供除錯與語言中立退回；顯示給使用者的文案由呼叫端依 reason
      // 從 i18n 字串表取，本檔不承擔翻譯。
      error: "selected file is 0 bytes, not a valid DOCX/ODT",
    };
  }

  // 檔名副檔名檢查：.docx 走 OOXML 引擎、.odt 走 ODF 唯讀引擎。
  // 先正規化——行動裝置的檔案 App 與 CJK 檔名常把雙向／零寬／BOM 字元
  // 留在副檔名之後（例：“無題 1.odt\u200E”），此時 endsWith(".odt") 會失敗並
  // 回報「this file is [.odt]」這種自相矛盾的訊息（用戶 11-09 實測踩到）。
  const lowerName = normalizeFileName(fileName);
  let kind = lowerName.endsWith(".docx") ? "docx" : lowerName.endsWith(".odt") ? "odt" : null;
  // 副檔名判不出來時不硬擋：ZIP 的 entry 名稱在中央目錄是明文存的，直接掃
  // 特徵路徑就能認出真實容器（word/document.xml＝DOCX，
  // application/vnd.oasis.opendocument.text＝ODT）。改檔名／副檔名帶雜訊字元都仍可渲染。
  const sniffed = kind ? null : sniffContainerKind(bytes);
  if (!kind && sniffed) kind = sniffed;
  if (!kind) {
    const ext = lowerName.includes(".") ? lowerName.slice(lowerName.lastIndexOf(".")) : "";
    return {
      valid: false,
      reason: "INVALID_EXTENSION",
      ext,
      error: `unsupported format: only .docx and .odt are supported, got [${ext}]`,
    };
  }

  // ZIP PK 容器標頭檢查：DOCX 為 OPC / ZIP 容器，前 4 位元組通常為 0x50 0x4B 0x03 0x04（PK\x03\x04）或 0x50 0x4B
  if (bytes.byteLength < 4) {
    return {
      valid: false,
      reason: "TOO_SHORT",
      error: "file too short to be an Office Open XML (DOCX) container",
    };
  }

  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    return {
      valid: false,
      reason: "NOT_ZIP_CONTAINER",
      error: "not a DOCX/ODT: missing the standard ZIP (PK) container header",
    };
  }

  return { valid: true, kind };
}

/**
 * 解碼單一 Image 項目的 base64 像素為可繪元素。
 * 失敗回傳 null（呼叫端跳過該項，絕不拋錯擋掉整頁渲染）；3 秒逾時同樣回 null——
 * 解碼卡死屬解譯器／瀏覽器極端例外，寧可缺圖不可白頁。
 * @param {{mime?: string, data_b64?: string}} img
 * @returns {Promise<HTMLImageElement|null>}
 */
function decodeImageItem(img) {
  return new Promise((resolve) => {
    const b64 = img && img.data_b64;
    if (!b64) {
      resolve(null);
      return;
    }
    const mime = img.mime || "image/png";
    const el = new Image();
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(null), 3000);
    el.onload = () => finish(el);
    el.onerror = () => finish(null);
    el.src = `data:${mime};base64,${b64}`;
  });
}

// 渲染代次記號：分頁快速連點時，舊一輪的異步解碼完成後不得再繪到新內容上。
let renderToken = 0;

/**
 * 繪製單頁顯示列表至 HTML5 Canvas
 *
 * 鐵律：顯示列表契約（core/render-trait DrawItem）有四類項目——Rect／Rule／Text／
 * Image，四者都必須有分支；Image 項的像素以 base64 自帶於顯示列表（跨 wasm 邊界
 * 零 IO），過去本檔漏了 Image 分支導致所有內嵌圖片在 playground 靜默消失
 * （引擎與 SVG 端都正常，只有站端不見）。
 *
 * Image 解碼是異步的：先平行解碼本頁所有圖，再走單一同步繪製迴圈——
 * 如此 z 序仍嚴格按顯示列表序（圖在填充之後、文字之前），無須在文字之上補畫。
 *
 * @param {object} dl 顯示列表 JSON 物件
 * @param {HTMLCanvasElement} canvas
 * @param {number} [displayWidthPx=DEFAULT_DISPLAY_WIDTH_PX]
 * @returns {Promise<{ scale: number, width: number, height: number }|null>}
 *          null＝本次繪製已被更新的渲染取代（呼叫端可忽略）
 */
export async function renderDisplayListToCanvas(dl, canvas, displayWidthPx = DEFAULT_DISPLAY_WIDTH_PX) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("無法取得 Canvas 2D 繪圖上下文");

  const widthPt = dl.width_pt || 595;
  const heightPt = dl.height_pt || 842;
  const scale = displayWidthPx / widthPt;

  // 本輪代次：在任何 await 之前先搶代次號——更快發起的渲染輪會把計數推高，
  // 舊輪解碼完成時發現自己不是最新輪即作廢，不會把舊頁畫到新頁上。
  const myToken = ++renderToken;

  const items = Array.isArray(dl.items) ? dl.items : [];

  // 先平行解碼全部圖片（異步段）；任何一張失敗只影響該張的顯示。
  const decoded = await Promise.all(
    items.map((item) => (item && item.Image ? decodeImageItem(item.Image) : Promise.resolve(null))),
  );

  // 解碼期間已被更快的一輪渲染取代：作廢本輪，連清畫布都不做（新輪自會重繪）。
  if (renderToken !== myToken) return null;
  canvas.__quireRenderToken = myToken;

  canvas.width = Math.round(widthPt * scale);
  canvas.height = Math.round(heightPt * scale);

  // 填白色紙張背景
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    // 0) 內嵌圖片（K4c-image）：data_b64 已是引擎處理後像素（含 duotone），照繪。
    if (item.Image) {
      const el = decoded[i];
      if (el) {
        const im = item.Image;
        ctx.drawImage(el, (im.x || 0) * scale, (im.y || 0) * scale, (im.w || 0) * scale, (im.h || 0) * scale);
      }
      continue;
    }
    // 1) 矩形色塊（背景、底色等）
    if (item.Rect) {
      const r = item.Rect;
      ctx.fillStyle = argbToCss(r.fill_argb ?? 0xff000000);
      ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      continue;
    }

    // 2) 線條（邊框、分隔線）
    if (item.Rule) {
      const ln = item.Rule;
      ctx.save();
      ctx.strokeStyle = argbToCss(ln.color_argb ?? 0xff000000);
      ctx.lineWidth = Math.max(0.5, (ln.width_pt || 0.5) * scale);
      if (ln.dash) {
        const segs = String(ln.dash)
          .trim()
          .split(/[\s,]+/)
          .map((v) => Number(v) * scale)
          .filter((v) => Number.isFinite(v) && v > 0);
        ctx.setLineDash(segs);
      } else {
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.moveTo(ln.x1 * scale, ln.y1 * scale);
      ctx.lineTo(ln.x2 * scale, ln.y2 * scale);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    // 3) 文字項目
    if (item.Text) {
      const t = item.Text;
      const flags = t.flags || 0;
      const italic = flags & 2 ? "italic " : "";
      const bold = flags & 1 ? "bold " : "";
      const px = t.size_pt * scale;

      ctx.font = `${italic}${bold}${px}px "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif`;
      const colorCss = argbToCss(t.color_argb ?? 0xff000000);
      ctx.fillStyle = colorCss;

      const x = t.x * scale;
      const baselineY = (t.y + t.size_pt) * scale;
      ctx.fillText(t.text, x, baselineY);

      // Canvas2D 無原生底線與刪除線：由 flags 計算手動劃線
      // FLAG_UNDERLINE = 4, FLAG_STRIKE = 8
      if (flags & (4 | 8)) {
        const w = ctx.measureText(t.text).width;
        ctx.save();
        ctx.strokeStyle = colorCss;
        ctx.lineWidth = Math.max(1, px * 0.07);
        ctx.setLineDash([]);
        if (flags & 4) {
          const uy = baselineY + px * 0.12;
          ctx.beginPath();
          ctx.moveTo(x, uy);
          ctx.lineTo(x + w, uy);
          ctx.stroke();
        }
        if (flags & 8) {
          const sy = baselineY - px * 0.3;
          ctx.beginPath();
          ctx.moveTo(x, sy);
          ctx.lineTo(x + w, sy);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  return { scale, width: canvas.width, height: canvas.height };
}
