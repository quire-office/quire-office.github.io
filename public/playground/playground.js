// Quire Playground 互動與 WASM 引擎掛載模組
// 實作：流式下載 WASM、File API 拖放/選取、分頁渲染、具體錯誤分類與提示。
// 依據規格：唯讀渲染（不含 IME / 編輯面），支援純 in-tab 離線處理。

import init, { WasmEngine } from "./quire_web.js";
import {
  formatBytes,
  validateDocxFile,
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
    fetching: "Fetching the WASM engine from this site (about 1.56 MB / 910 KB gzip)…",
    downloading: "Downloading WASM engine: {got} / {total} ({pct}%)",
    downloadingNoTotal: "Downloading WASM engine: {got}",
    loaded: "WASM core loaded ({size}, {ms} ms, cached). Drop or choose a .docx file.",
    reading: "Reading file “{name}” ({size})…",
    waitingEngine: "Waiting for the WASM engine to finish loading…",
    errMissingTitle: "Engine asset missing",
    errMissingDetail: "This build is missing the WASM engine asset (/playground/quire_web_bg.wasm returned 404). By policy the engine binary is not committed to the web repo — run “npm run fetch:wasm” in this repo's root, then rebuild.",
    pageOf: "Page {cur} / {total}",
    metaParas: "{n} paragraphs in the document · page width {w} pt · page height {h} pt",
    validateFileEmpty: "The selected file is 0 bytes — not a valid DOCX.",
    validateBadExt: "Format not supported: only .docx is accepted, this file is [{ext}]. Convert older .doc or other formats to .docx first.",
    validateNoExt: "no extension",
    validateTooShort: "The file is too short to be a valid Office Open XML (DOCX) container.",
    validateNotZip: "Not a DOCX: the standard ZIP (PK) container header is missing.",
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
const docMeta = document.getElementById("doc-meta");

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
  const validation = validateDocxFile(file.name, bytes);
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

  // 3) 透過 WasmEngine 開啟文件
  let engine;
  try {
    engine = new WasmEngine(bytes);
  } catch (err) {
    console.error("WasmEngine 解析錯誤：", err);
    showError(
      "解析失敗",
            I18N.get("errParse", { msg: err.message || String(err) }),
      file.name
    );
    return;
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
}

// 初始化啟動
setupUI();
wasmInitPromise = loadWasm();
