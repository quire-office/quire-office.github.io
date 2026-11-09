// Quire Playground 互動與 WASM 引擎掛載模組
// 實作：流式下載 WASM、File API 拖放/選取、分頁渲染、具體錯誤分類與提示。
// 依據規格：唯讀渲染（不含 IME / 編輯面），支援純 in-tab 離線處理。

import init, { WasmEngine, WasmOdtView } from "./quire_web.js";
import {
  formatBytes,
  validateDocumentFile,
  renderDisplayListToCanvas,
} from "./renderer.js";

/**
 * 文案取自頁面 #pg-i18n 的 data-strings（來源＝src/i18n 字典，build 期烘焙）。
 * 本腳本是 public/ 下的靜態資產、不經 i18n 建置，因此字串一律向外要，
 * 缺鍵時退回英文常量，確保任何情況下都有可讀提示而非空白。
 */
const I18N = (() => {
  const EN = {
    loading: "Loading · WASM streaming compile",
    ready: "Engine ready · {ver} · runs in your browser",
    readyNoVer: "Engine ready · runs in your browser",
    error: "Processing error · render not completed",
    fetching: "Fetching the WASM engine from this site (about 1.80 MB / 1012 KB gzip)…",
    downloading: "Downloading WASM engine: {got} / {total} ({pct}%)",
    downloadingNoTotal: "Downloading WASM engine: {got}",
    loaded: "WASM core loaded ({size}, {ms} ms, cached). Drop or choose a .docx or .odt file.",
    reading: "Reading file “{name}” ({size})…",
    waitingEngine: "Waiting for the WASM engine to finish loading…",
    errMissingTitle: "Engine asset missing",
    errMissingDetail: "This build is missing the WASM engine asset (/playground/quire_web_bg.wasm returned 404). By policy the engine binary is not committed to the web repo — run “npm run fetch:wasm” in this repo's root, then rebuild.",
    pageOf: "Page {cur} / {total}",
    metaParas: "{n} paragraphs in the document · page width {w} pt · page height {h} pt",
    validateFileEmpty: "The selected file is 0 bytes — not a valid DOCX or ODT.",
    validateBadExt: "Format not supported: only .docx and .odt are accepted, this file is [{ext}]. Convert older .doc or other formats to .docx first.",
    paperOdtNote: "Open Document Text (.odt) renders read-only: paper override is not available for ODT yet.",
    "paper.errOdtOverride": "Paper override is not available for .odt files — the ODT pipeline is read-only rendering. Re-load a .docx to change paper size.",
    validateNoExt: "no extension",
    validateTooShort: "The file is too short to be a valid DOCX or ODT container.",
    validateNotZip: "Not a DOCX/ODT: the standard ZIP (PK) container header is missing.",
  };
  let got = {};
  try {
    got = JSON.parse((document.getElementById("pg-i18n") || {}).dataset.strings || "{}") || {};
  } catch (_) { got = {}; }
  return {
    get(key, vars) {
      let out = got[key] ?? EN[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
      return out;
    },
  };
})();

// DOM 元素引用
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const statusChip = document.getElementById("wasm-status-chip");
const statusDesc = document.getElementById("status-desc");
const progressBar = document.getElementById("progress-bar");
const progressWrap = document.getElementById("progress-wrap");
const errorPanel = document.getElementById("error-panel");
const errorTypeEl = document.getElementById("error-type");
const errorDetailEl = document.getElementById("error-detail");
const viewerPanel = document.getElementById("viewer-panel");
const canvas = document.getElementById("render-canvas");
const prevBtn = document.getElementById("prev-page-btn");
const nextBtn = document.getElementById("next-page-btn");
const pageInfo = document.getElementById("page-info");
const paperOdtNote = document.getElementById("paper-odt-note");
const docMeta = document.getElementById("doc-meta");
const paperPanel = document.getElementById("paper-panel");
const paperPreset = document.getElementById("paper-preset");
const paperCustomRow = document.getElementById("paper-custom-row");
const paperWidth = document.getElementById("paper-width");
const paperHeight = document.getElementById("paper-height");
const paperUnit = document.getElementById("paper-unit");
const paperMarginTop = document.getElementById("paper-margin-top");
const paperMarginBottom = document.getElementById("paper-margin-bottom");
const paperMarginLeft = document.getElementById("paper-margin-left");
const paperMarginRight = document.getElementById("paper-margin-right");
const paperApply = document.getElementById("paper-apply");
const paperError = document.getElementById("paper-error");
const paperStatus = document.getElementById("paper-status");
const paperOriginalLine = document.getElementById("paper-original-line");

// 紙張設定：僅在檢視期覆寫，不寫回原檔。
// 數值單位一律以 pt 送引擎；文件原始尺寸只從 paper_json() 讀取，不在站端自算。
const PAPER_PRESETS = {
  a4: { w: 595.28, h: 841.89 },
  a3: { w: 841.89, h: 1190.55 },
  a5: { w: 419.53, h: 595.28 },
  letter: { w: 612, h: 792 },
  legal: { w: 612, h: 1008 },
  b5: { w: 498.9, h: 708.66 },
};
const PAPER_MIN_PT = 72;
const PAPER_MAX_PT = 1584;
const UNIT_TO_PT = { mm: 72 / 25.4, cm: 720 / 25.4, in: 72, pt: 1 };
const PT_TO_MM = 25.4 / 72;
let docBytes = null;
let docKind = "docx";
let originalPaper = null;

// 執行狀態
let wasmReady = false;
let wasmInitPromise = null;
let currentEngine = null;
let currentPage = 0;
let currentFileName = "";
let reflowScheduled = false;

/**
 * 顯示具體錯誤訊息面板
 * @param {string} type 錯誤分類名稱
 * @param {string} detail 具體錯誤描述
 * @param {string} [fileName=""] 涉及檔案名稱
 */
function showError(type, detail, fileName = "") {
  if (viewerPanel) viewerPanel.hidden = true;
  if (errorPanel) {
    errorPanel.hidden = false;
    if (errorTypeEl) errorTypeEl.textContent = type;
    if (errorDetailEl) {
      errorDetailEl.textContent = fileName
              ? I18N.get("errFilePrefix", { name: fileName }) + detail
        : detail;
    }
  }
  if (statusChip) {
    statusChip.textContent = I18N.get("error");
    statusChip.className = "chip chip-error";
  }
  if (fileInput) fileInput.value = "";
}

/**
 * 清除錯誤狀態
 */
function clearError() {
  if (errorPanel) errorPanel.hidden = true;
}

/**
 * 流式載入 WASM 首包（可見下載進度，邊下載邊編譯）
 */
async function loadWasm() {
  const wasmUrl = new URL("./quire_web_bg.wasm", import.meta.url);
  const t0 = performance.now();

  try {
    if (statusChip) statusChip.textContent = I18N.get("loading");
    if (statusDesc) statusDesc.textContent = I18N.get("fetching");
    if (progressWrap) progressWrap.hidden = false;

    const res = await fetch(wasmUrl);
    if (!res.ok) {
      if (res.status === 404) {
        // 缺資產（佔位模式構建）：給出具體補救指示，而非當成一般網路錯誤
        showError(
          "引擎資產缺失",
          "此站點建置缺少 WASM 引擎資產（/playground/quire_web_bg.wasm 404）。\n" +
            "引擎二進位依規定不進網頁 repo，請在本 repo 根目錄執行「npm run fetch:wasm」\n" +
            "（自 GitHub release 下載，失敗時自動降級本機建置），完成後重新 npm run build。"
        );
        return;
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const total = Number(res.headers.get("Content-Length")) || 0;
    let received = 0;
    const [streamA, streamB] = res.body.tee();

    // 透過 streamA 追蹤下載進度
    const trackProgress = (async () => {
      const reader = streamA.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          if (progressBar) progressBar.style.width = `${pct}%`;
          if (statusDesc) {
                      statusDesc.textContent = I18N.get("downloading", { got: formatBytes(received), total: formatBytes(total), pct });
          }
        } else {
          if (statusDesc) {
                        statusDesc.textContent = I18N.get("downloadingNoTotal", { got: formatBytes(received) });
          }
        }
      }
    })();

    // 將 streamB 提供給 wasm-bindgen glue 進行 instantiateStreaming
    const wasmResponse = new Response(streamB, { headers: res.headers });
    await init({ module_or_path: wasmResponse });
    await trackProgress;

    const elapsedMs = Math.round(performance.now() - t0);
    wasmReady = true;

    if (progressWrap) progressWrap.hidden = true;
    if (statusChip) {
      // 版本由烘焙在 chip 上的 data-engine-version 帶出（來源＝playground.assets.json，
      // build 期烘焙；非執行期猜測）。缺屬性＝舊版烘焙，退回不顯示版本而非顯示錯的。
      const ver = statusChip.dataset.engineVersion;
      statusChip.textContent = ver
                ? I18N.get("ready", { ver })
                : I18N.get("readyNoVer");
      statusChip.className = "chip chip-ready";
    }
    if (statusDesc) {
            statusDesc.textContent = I18N.get("loaded", { size: formatBytes(received), ms: elapsedMs });
    }
  } catch (err) {
    console.error("WASM 載入失敗：", err);
    wasmReady = false;
    if (progressWrap) progressWrap.hidden = true;
    showError(
      "WASM 載入失敗",
              I18N.get("errWasmLoad", { msg: err.message || String(err) })
    );
  }
}

/**
 * 安排空檔進行軟分頁尾段背景重排（Phase0-6）
 */
function scheduleIdleReflow() {
  if (reflowScheduled || !currentEngine || currentEngine.is_settled()) return;
  reflowScheduled = true;
  const idle =
    window.requestIdleCallback ||
    ((fn) => setTimeout(() => fn({ timeRemaining: () => 4 }), 4));

  idle(() => {
    reflowScheduled = false;
    if (!currentEngine) return;
    try {
      currentEngine.reflow_step_json();
    } catch (e) {
      console.warn("背景重排例外：", e);
      return;
    }
    renderCurrentPage();
  });
}

/**
 * 渲染當前頁面至 Canvas
 */
function renderCurrentPage() {
  if (!currentEngine || !canvas) return;

  const totalPages = currentEngine.page_count();
  if (totalPages === 0) {
        showError(I18N.get("errPaginateTitle"), I18N.get("errZeroPages"), currentFileName);
    return;
  }

  // 確保當前頁數在合理範圍
  if (currentPage < 0) currentPage = 0;
  if (currentPage >= totalPages) currentPage = totalPages - 1;

  let dl;
  try {
    const jsonStr = currentEngine.page_display_list_json(currentPage);
    if (!jsonStr) throw new Error("引擎回傳空的顯示列表 JSON");
    dl = JSON.parse(jsonStr);
  } catch (err) {
    showError(
      "渲染失敗",
            I18N.get("errPageList", { page: currentPage + 1, msg: err.message || String(err) }),
      currentFileName
    );
    return;
  }

  try {
    renderDisplayListToCanvas(dl, canvas, 850);
  } catch (err) {
    showError(
      "Canvas 繪製錯誤",
            I18N.get("errCanvas", { msg: err.message || String(err) }),
      currentFileName
    );
    return;
  }

  // 更新分頁資訊與按鈕
  if (pageInfo) {
        pageInfo.textContent = I18N.get("pageOf", { cur: currentPage + 1, total: totalPages });
  }
  if (docMeta) {
        docMeta.textContent = I18N.get("metaParas", { n: currentEngine.paragraph_count(), w: dl.width_pt || 595, h: dl.height_pt || 842 });
  }
  if (prevBtn) prevBtn.disabled = currentPage <= 0;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages - 1;

  // 若尚未 settled，安排空檔續排
  if (!currentEngine.is_settled()) {
    scheduleIdleReflow();
  }
}

/**
 * 顯示紙張設定面板的行內錯誤（純文字，不彈窗）
 * @param {string} key i18n key（不帶 pg.js. 前綴）
 * @param {object} [vars]
 */
function showPaperError(key, vars) {
  if (!paperError) return;
  paperError.textContent = I18N.get(key, vars);
  paperError.hidden = false;
}

/**
 * 清除紙張設定面板的行內錯誤
 */
function clearPaperError() {
  if (!paperError) return;
  paperError.textContent = "";
  paperError.hidden = true;
}

/**
 * 數值單位換算為 pt
 * @param {number} value
 * @param {string} unit
 * @returns {number}
 */
function toPt(value, unit) {
  return value * (UNIT_TO_PT[unit] ?? 1);
}

/**
 * 固定小數位輸出（僅供顯示；幾何數值本身一律取自 paper_json()）
 * @param {number} value
 * @param {number} [digits=2]
 * @returns {string}
 */
function fmt(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "0";
}

/**
 * 讀取並驗證紙張設定表單。
 * 回傳 { settings } 或 { error, vars }；error 為 i18n key（不帶 pg.js. 前綴）。
 * @returns {{settings?: object, error?: string, vars?: object}}
 */
function readPaperForm() {
  const mode = paperPreset ? paperPreset.value : "doc";
  const unit = paperUnit ? paperUnit.value : "mm";
  const settings = {
    mode,
    unit,
    widthPt: null,
    heightPt: null,
    margins: { top: undefined, bottom: undefined, left: undefined, right: undefined },
  };

  if (mode === "custom") {
    const wRaw = paperWidth ? paperWidth.value.trim() : "";
    const hRaw = paperHeight ? paperHeight.value.trim() : "";
    if (!wRaw || !hRaw) return { error: "paper.errEmpty" };
    const w = Number(wRaw);
    const h = Number(hRaw);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return { error: "paper.errNaN" };
    if (w <= 0 || h <= 0) {
      return { error: "paper.errRange", vars: { min: PAPER_MIN_PT, max: PAPER_MAX_PT } };
    }
    settings.widthPt = toPt(w, unit);
    settings.heightPt = toPt(h, unit);
    if (
      settings.widthPt < PAPER_MIN_PT ||
      settings.widthPt > PAPER_MAX_PT ||
      settings.heightPt < PAPER_MIN_PT ||
      settings.heightPt > PAPER_MAX_PT
    ) {
      return { error: "paper.errRange", vars: { min: PAPER_MIN_PT, max: PAPER_MAX_PT } };
    }
  } else if (mode !== "doc") {
    const preset = PAPER_PRESETS[mode];
    if (!preset) return { error: "paper.errNaN" };
    settings.widthPt = preset.w;
    settings.heightPt = preset.h;
  }

  const marginEls = {
    top: paperMarginTop,
    bottom: paperMarginBottom,
    left: paperMarginLeft,
    right: paperMarginRight,
  };
  for (const [side, el] of Object.entries(marginEls)) {
    const raw = el ? el.value.trim() : "";
    if (raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) return { error: "paper.errMarginNaN" };
    if (v < 0) return { error: "paper.errMarginNegative" };
    settings.margins[side] = toPt(v, unit);
  }

  const effectiveWidthPt = mode === "doc" ? originalPaper?.page_w_pt : settings.widthPt;
  const effectiveHeightPt = mode === "doc" ? originalPaper?.page_h_pt : settings.heightPt;
  if (mode === "doc" && (!Number.isFinite(effectiveWidthPt) || !Number.isFinite(effectiveHeightPt))) {
    return { error: "paper.errNoDoc" };
  }
  const sumX = (settings.margins.left ?? 0) + (settings.margins.right ?? 0);
  const sumY = (settings.margins.top ?? 0) + (settings.margins.bottom ?? 0);
  if (sumX >= effectiveWidthPt || sumY >= effectiveHeightPt) {
    return { error: "paper.errMarginTooLarge" };
  }

  settings.effectiveWidthPt = effectiveWidthPt;
  settings.effectiveHeightPt = effectiveHeightPt;
  settings.override =
    mode !== "doc" || Object.values(settings.margins).some((v) => v !== undefined);
  return { settings };
}

/**
 * 依紙張設定重建引擎；無覆寫時走既有 new WasmEngine(bytes) 路徑。
 * ODT（WasmOdtView）無構造期覆寫契約，指定覆寫時丟錯交由行內提示呈現。
 * @param {object} settings readPaperForm() 回傳的 settings
 * @returns {WasmEngine|WasmOdtView}
 */
function buildEngineWithPaper(settings) {
  if (!docBytes) throw new Error("no document bytes");
  if (docKind === "odt") {
    // ODT 線目前只有唯讀渲染（WasmOdtView 不暴露構造期紙張覆寫），
    // 引擎端未實作即不假裝支援——由呼叫端顯示行內提示。
    throw new Error("odt-override-unsupported");
  }
  if (!settings.override) return new WasmEngine(docBytes);
  return WasmEngine.new_with_paper(
    docBytes,
    settings.effectiveWidthPt,
    settings.effectiveHeightPt,
    settings.margins.top,
    settings.margins.bottom,
    settings.margins.left,
    settings.margins.right
  );
}

/**
 * 以目前引擎的 paper_json() 更新狀態列；文件原始尺寸同樣只從 paper_json() 取。
 */
function updatePaperStatus() {
  if (paperStatus) {
    let pj = null;
    if (currentEngine) {
      try {
        pj = JSON.parse(currentEngine.paper_json());
      } catch (_) {
        pj = null;
      }
    }
    if (pj) {
      const w = Number(pj.page_w_pt);
      const h = Number(pj.page_h_pt);
      const vars = {
        w: fmt(w),
        h: fmt(h),
        wmm: fmt(w * PT_TO_MM, 1),
        hmm: fmt(h * PT_TO_MM, 1),
      };
      paperStatus.textContent = I18N.get(
        pj.paper_override_applied ? "paper.statusOverridden" : "paper.statusOriginal",
        vars
      );
    } else {
      paperStatus.textContent = "";
    }
  }

  if (paperOriginalLine) {
    const showOriginal = paperPreset && paperPreset.value === "doc" && originalPaper;
    if (showOriginal) {
      const w = Number(originalPaper.page_w_pt);
      const h = Number(originalPaper.page_h_pt);
      paperOriginalLine.textContent = I18N.get("paper.originalLine", {
        w: fmt(w),
        h: fmt(h),
        wmm: fmt(w * PT_TO_MM, 1),
        hmm: fmt(h * PT_TO_MM, 1),
      });
      paperOriginalLine.hidden = false;
    } else {
      paperOriginalLine.hidden = true;
    }
  }
}

/**
 * 依文件種類啟停紙張覆寫控件：ODT 線只有唯讀渲染（引擎端無構造期覆寫契約），
 * 故 ODT 載入時停用控件並顯示說明，不讓使用者以為覆寫生效。
 * @param {boolean} overrideSupported
 */
function setPaperPanelEnabled(overrideSupported) {
  const controls = [paperPreset, paperUnit, paperWidth, paperHeight,
    paperMarginTop, paperMarginBottom, paperMarginLeft, paperMarginRight, paperApply];
  controls.forEach((el) => {
    if (el) el.disabled = !overrideSupported;
  });
  if (paperOdtNote) paperOdtNote.hidden = overrideSupported;
}

/**
 * 依紙型切換自訂欄位顯示，並同步狀態列。
 */
function syncPaperFormVisibility() {
  if (paperCustomRow && paperPreset) {
    paperCustomRow.hidden = paperPreset.value !== "custom";
  }
  updatePaperStatus();
}

/**
 * 把目前生效的紙張設定寫進 URL query；文件原始且無覆寫時清空相關參數。
 */
function updatePaperUrl() {
  if (typeof history === "undefined" || !window.location) return;
  const url = new URL(window.location.href);
  const params = url.searchParams;
  ["paper", "pw", "ph", "u", "mt", "mb", "ml", "mr"].forEach((k) => params.delete(k));

  let pj = null;
  if (currentEngine) {
    try {
      pj = JSON.parse(currentEngine.paper_json());
    } catch (_) {
      pj = null;
    }
  }
  if (pj && pj.paper_override_applied) {
    const mode = paperPreset ? paperPreset.value : "doc";
    if (mode === "custom") {
      if (paperWidth) params.set("pw", paperWidth.value.trim());
      if (paperHeight) params.set("ph", paperHeight.value.trim());
    } else {
      params.set("paper", mode);
    }
    params.set("u", paperUnit ? paperUnit.value : "mm");
    const margins = {
      mt: paperMarginTop,
      mb: paperMarginBottom,
      ml: paperMarginLeft,
      mr: paperMarginRight,
    };
    for (const [key, el] of Object.entries(margins)) {
      const v = el ? el.value.trim() : "";
      if (v !== "") params.set(key, v);
    }
  }
  history.replaceState(null, "", url);
}

/**
 * 載入時還原 URL query 的紙張設定；檔案載入後即以此設定建引擎。
 */
function applyDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const unit = params.get("u");
  if (paperUnit && unit && ["mm", "cm", "in", "pt"].includes(unit)) {
    paperUnit.value = unit;
  }

  const pw = params.get("pw");
  const ph = params.get("ph");
  const paper = params.get("paper");
  if (paperPreset) {
    if (pw !== null && ph !== null) {
      paperPreset.value = "custom";
      if (paperWidth) paperWidth.value = pw;
      if (paperHeight) paperHeight.value = ph;
    } else if (paper === "custom") {
      paperPreset.value = "custom";
    } else if (paper && (paper === "doc" || PAPER_PRESETS[paper])) {
      paperPreset.value = paper;
    }
  }

  const margins = {
    mt: paperMarginTop,
    mb: paperMarginBottom,
    ml: paperMarginLeft,
    mr: paperMarginRight,
  };
  for (const [key, el] of Object.entries(margins)) {
    const v = params.get(key);
    if (v !== null && el) el.value = v;
  }
  syncPaperFormVisibility();
}

/**
 * 套用紙張設定：重建引擎、沿用既有重繪路徑，並在頁數變少時把 currentPage 歸零。
 */
async function applyPaperSettings() {
  clearPaperError();
  if (!docBytes) {
    showPaperError("paper.errNoDoc");
    return;
  }
  if (docKind === "odt") {
    showPaperError("paper.errOdtOverride");
    return;
  }
  const parsed = readPaperForm();
  if (parsed.error) {
    showPaperError(parsed.error, parsed.vars);
    return;
  }
  const settings = parsed.settings;
  if (paperApply) paperApply.disabled = true;
  if (statusChip) {
    statusChip.textContent = I18N.get("paper.applying");
    statusChip.className = "chip";
  }
  // 先讓瀏覽器繪出 loading 態，再做同步的重建與重排
  await new Promise((resolve) => setTimeout(resolve, 0));

  let engine;
  try {
    engine = buildEngineWithPaper(settings);
  } catch (err) {
    if (paperApply) paperApply.disabled = false;
    if (statusChip) {
      statusChip.textContent = I18N.get("renderDone");
      statusChip.className = "chip chip-success";
    }
    if (String(err && err.message).includes("odt-override-unsupported")) {
      showPaperError("paper.errOdtOverride");
    } else {
      showPaperError("paper.errApply", { msg: err.message || String(err) });
    }
    return;
  }

  currentEngine = engine;
  const totalPages = currentEngine.page_count();
  if (currentPage >= totalPages || currentPage < 0) currentPage = 0;

  if (statusChip) {
    statusChip.textContent = I18N.get("renderDone");
    statusChip.className = "chip chip-success";
  }
  if (statusDesc) {
    statusDesc.textContent = I18N.get("renderDoneDesc", {
      name: currentFileName,
      size: formatBytes(docBytes.length),
      pages: totalPages,
    });
  }
  updatePaperStatus();
  updatePaperUrl();
  renderCurrentPage();
  if (paperApply) paperApply.disabled = false;
}

/**
 * 處理使用者拖入或選取的 DOCX 檔案
 * @param {File} file
 */
async function handleFile(file) {
  if (!file) return;

  clearError();
    if (statusDesc) statusDesc.textContent = I18N.get("reading", { name: file.name, size: formatBytes(file.size) });

  let bytes;
  try {
    const arrayBuffer = await file.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
  } catch (err) {
        showError(I18N.get("errReadTitle"), I18N.get("errReadDetail", { msg: err.message || String(err) }), file.name);
    return;
  }

  // 1) 格式校驗（副檔名、大小、ZIP/PK 容器）
  const validation = validateDocumentFile(file.name, bytes);
  if (!validation.valid) {
        // 校驗失敗的顯示文案依 reason 從字串表取（reason 是穩定契約，字串可譯）；
    // 查不到 reason 時退回 renderer 給的語言中立描述，不顯示空白。
    const REASON_KEYS = {
      FILE_EMPTY: "validateFileEmpty",
      INVALID_EXTENSION: "validateBadExt",
      TOO_SHORT: "validateTooShort",
      NOT_ZIP_CONTAINER: "validateNotZip",
    };
    const key = REASON_KEYS[validation.reason];
    const detail = key
      ? I18N.get(key, { ext: validation.ext || I18N.get("validateNoExt") })
      : validation.error;
    showError(I18N.get("errFormatTitle"), detail, file.name);
    return;
  }

  // 2) 確認 WASM 引擎已就緒
  if (!wasmReady) {
      if (statusDesc) statusDesc.textContent = I18N.get("waitingEngine");
    try {
      await wasmInitPromise;
    } catch {
          showError(I18N.get("errNotReadyTitle"), I18N.get("errNotReadyDetail"), file.name);
      return;
    }
  }

  // 3) 依容器種類開啟文件：.docx 走 WasmEngine（可覆寫紙張），
  //    .odt 走 WasmOdtView（唯讀渲染；引擎端無紙張覆寫契約，故不套覆寫）。
  docBytes = bytes;
  docKind = validation.kind || "docx";
  clearPaperError();
  setPaperPanelEnabled(docKind === "docx");
  let engine;
  try {
    engine = docKind === "odt" ? new WasmOdtView(bytes) : new WasmEngine(bytes);
    originalPaper = JSON.parse(engine.paper_json());
  } catch (err) {
    console.error("WasmEngine 解析錯誤：", err);
    showError(
      "解析失敗",
            I18N.get("errParse", { msg: err.message || String(err) }),
      file.name
    );
    return;
  }

  // 3b) 若面板／深連結指定了紙張覆寫，改用 new_with_paper 重建；設定不合法時保留原檔並行內提示。
  const paperParsed = readPaperForm();
  if (paperParsed.error) {
    showPaperError(paperParsed.error, paperParsed.vars);
  } else if (paperParsed.settings.override) {
    try {
      engine = buildEngineWithPaper(paperParsed.settings);
    } catch (err) {
      if (String(err && err.message).includes("odt-override-unsupported")) {
        showPaperError("paper.errOdtOverride");
      } else {
        showPaperError("paper.errApply", { msg: err.message || String(err) });
      }
    }
  }

  // 4) 檢驗分頁結果
  let pageCount = 0;
  try {
    pageCount = engine.page_count();
  } catch (err) {
        showError(I18N.get("errPageInfoTitle"), I18N.get("errPageInfoDetail", { msg: err.message || String(err) }), file.name);
    return;
  }

  if (pageCount < 1) {
    showError(
      "分頁異常",
            I18N.get("errNoPages", { count: pageCount }),
      file.name
    );
    return;
  }

  // 5) 成功就緒：顯示預覽
  currentEngine = engine;
  currentPage = 0;
  currentFileName = file.name;

  if (viewerPanel) viewerPanel.hidden = false;
  if (statusChip) {
        statusChip.textContent = I18N.get("renderDone");
    statusChip.className = "chip chip-success";
  }
  if (statusDesc) {
        statusDesc.textContent = I18N.get("renderDoneDesc", { name: file.name, size: formatBytes(file.size), pages: pageCount });
  }

  updatePaperStatus();
  updatePaperUrl();
  renderCurrentPage();

  // 平滑滾動至檢視區
  viewerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// 註冊 UI 事件
function setupUI() {
  // 點擊 dropzone：dropzone 是 <label for="file-input">，滑鼠／觸控的點擊由
  // label 的原生啟用行為直接開啟選擇器（手機瀏覽器唯一可靠路徑；JS .click()
  // 對隱藏 input 在部分移動端會被攔截）。這裡只補兩個缺口：
  // 1) isTrusted=false 的合成事件不會觸發 label 啟用行為 → 手動補 click；
  // 2) 內部 <button>（翻頁鍵等）冒泡上來的點擊不得開選擇器。
  if (dropzone && fileInput) {
    dropzone.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (!e.isTrusted) fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        handleFile(files[0]);
      }
    });

    // 拖曳處理
    dropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("drag-over");
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("drag-over");
    });

    dropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("drag-over");
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("drag-over");

      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        handleFile(dt.files[0]);
      }
    });
  }

  // 分頁控制按鈕
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (currentEngine && currentPage > 0) {
        currentPage--;
        renderCurrentPage();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (currentEngine && currentPage + 1 < currentEngine.page_count()) {
        currentPage++;
        renderCurrentPage();
      }
    });
  }

  // 鍵盤左右鍵翻頁快捷鍵支援
  window.addEventListener("keydown", (e) => {
    if (!currentEngine || (viewerPanel && viewerPanel.hidden)) return;
    if (e.key === "ArrowLeft" && currentPage > 0) {
      currentPage--;
      renderCurrentPage();
    } else if (e.key === "ArrowRight" && currentPage + 1 < currentEngine.page_count()) {
      currentPage++;
      renderCurrentPage();
    }
  });

  // 紙張設定面板：只有「套用」才重建引擎，避免每鍵一次全量重排
  if (paperPreset) {
    paperPreset.addEventListener("change", syncPaperFormVisibility);
  }
  if (paperApply) {
    paperApply.addEventListener("click", applyPaperSettings);
  }
  // 窄屏預設收合，展開後仍在文件流程內，不遮蓋畫布
  if (paperPanel && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches) {
    paperPanel.open = false;
  }
}

// 初始化啟動
setupUI();
applyDeepLink();
wasmInitPromise = loadWasm();
