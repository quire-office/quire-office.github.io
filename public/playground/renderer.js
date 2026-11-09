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

  // 檔名副檔名檢查：.docx 走 OOXML 引擎、.odt 走 ODF 唯讀引擎
  const lowerName = (fileName || "").toLowerCase();
  const kind = lowerName.endsWith(".docx") ? "docx" : lowerName.endsWith(".odt") ? "odt" : null;
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
 * 繪製單頁顯示列表至 HTML5 Canvas
 * @param {object} dl 顯示列表 JSON 物件
 * @param {HTMLCanvasElement} canvas
 * @param {number} [displayWidthPx=DEFAULT_DISPLAY_WIDTH_PX]
 * @returns {{ scale: number, width: number, height: number }}
 */
export function renderDisplayListToCanvas(dl, canvas, displayWidthPx = DEFAULT_DISPLAY_WIDTH_PX) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("無法取得 Canvas 2D 繪圖上下文");

  const widthPt = dl.width_pt || 595;
  const heightPt = dl.height_pt || 842;
  const scale = displayWidthPx / widthPt;

  canvas.width = Math.round(widthPt * scale);
  canvas.height = Math.round(heightPt * scale);

  // 填白色紙張背景
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const items = Array.isArray(dl.items) ? dl.items : [];

  for (const item of items) {
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
