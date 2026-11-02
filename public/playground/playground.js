// Quire Playground 互動與 WASM 引擎掛載模組
// 實作：流式下載 WASM、File API 拖放/選取、分頁渲染、具體錯誤分類與提示。
// 依據規格：唯讀渲染（不含 IME / 編輯面），支援純 in-tab 離線處理。

import init, { WasmEngine } from "./quire_web.js";
import {
  formatBytes,
  validateDocxFile,
  renderDisplayListToCanvas,
} from "./renderer.js";

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
        ? `檔案 [${fileName}]：${detail}`
        : detail;
    }
  }
  if (statusChip) {
    statusChip.textContent = "處理異常 · 未完成渲染";
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
    if (statusChip) statusChip.textContent = "WASM 載入中 · 流式編譯";
    if (statusDesc) statusDesc.textContent = "正在自本站取得 WASM 引擎（約 1.57 MB / Gzip 實測 910 KB）…";
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
            statusDesc.textContent = `WASM 引擎下載中：${formatBytes(received)} / ${formatBytes(total)} (${pct}%)`;
          }
        } else {
          if (statusDesc) {
            statusDesc.textContent = `WASM 引擎下載中：${formatBytes(received)}`;
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
      statusChip.textContent = "引擎就緒 · 純瀏覽器執行";
      statusChip.className = "chip chip-ready";
    }
    if (statusDesc) {
      statusDesc.textContent = `WASM 核心已載入（${formatBytes(received)}，耗時 ${elapsedMs}ms，已快取）。請拖放或選取 .docx 檔案。`;
    }
  } catch (err) {
    console.error("WASM 載入失敗：", err);
    wasmReady = false;
    if (progressWrap) progressWrap.hidden = true;
    showError(
      "WASM 載入失敗",
      `無法成功載入或編譯 WASM 模組（${err.message || String(err)}）。請檢查網路或重新整理。`
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
    showError("分頁異常", "文件有效頁數為 0，無法進行渲染。", currentFileName);
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
      `無法解析第 ${currentPage + 1} 頁的顯示列表（${err.message || String(err)}）`,
      currentFileName
    );
    return;
  }

  try {
    renderDisplayListToCanvas(dl, canvas, 850);
  } catch (err) {
    showError(
      "Canvas 繪製錯誤",
      `Canvas2D 繪製過程發生錯誤（${err.message || String(err)}）`,
      currentFileName
    );
    return;
  }

  // 更新分頁資訊與按鈕
  if (pageInfo) {
    pageInfo.textContent = `第 ${currentPage + 1} / ${totalPages} 頁`;
  }
  if (docMeta) {
    docMeta.textContent = `全篇共 ${currentEngine.paragraph_count()} 個段落 · 頁寬 ${dl.width_pt || 595} pt · 頁高 ${dl.height_pt || 842} pt`;
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
  if (statusDesc) statusDesc.textContent = `正在讀取檔案「${file.name}」(${formatBytes(file.size)})…`;

  let bytes;
  try {
    const arrayBuffer = await file.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
  } catch (err) {
    showError("檔案讀取失敗", `瀏覽器讀取檔案位元組失敗：${err.message || String(err)}`, file.name);
    return;
  }

  // 1) 格式校驗（副檔名、大小、ZIP/PK 容器）
  const validation = validateDocxFile(file.name, bytes);
  if (!validation.valid) {
    showError("格式不支援", validation.error, file.name);
    return;
  }

  // 2) 確認 WASM 引擎已就緒
  if (!wasmReady) {
    if (statusDesc) statusDesc.textContent = "等待 WASM 引擎載入完成…";
    try {
      await wasmInitPromise;
    } catch {
      showError("WASM 未就緒", "WASM 模組尚未就緒，無法開啟文件。", file.name);
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
      `DOCX 內容解析錯誤（${err.message || String(err)}）。文件可能損毀或包含非標準 XML 結構。`,
      file.name
    );
    return;
  }

  // 4) 檢驗分頁結果
  let pageCount = 0;
  try {
    pageCount = engine.page_count();
  } catch (err) {
    showError("分頁讀取失敗", `取得分頁資訊時發生錯誤：${err.message || String(err)}`, file.name);
    return;
  }

  if (pageCount < 1) {
    showError(
      "分頁異常",
      `引擎完成排版但未產生任何頁面（page_count = ${pageCount}）。文件可能缺少內文段落或版面章節（sectPr）資訊。`,
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
    statusChip.textContent = "渲染完成 · 唯讀預覽";
    statusChip.className = "chip chip-success";
  }
  if (statusDesc) {
    statusDesc.textContent = `已成功載入「${file.name}」（${formatBytes(file.size)}），全篇共 ${pageCount} 頁。可在下方翻頁預覽。`;
  }

  renderCurrentPage();

  // 平滑滾動至檢視區
  viewerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// 註冊 UI 事件
function setupUI() {
  // 點擊 dropzone：dropzone 是 <label for="file-input">，滑鼠／觸控的點擊由
  // label 的原生啟用行為直接開啟選擇器（手機瀏覽器唯一可靠路徑；JS .click()
  // 對隱藏 input 在部分移動端会被攔截）。這裡只補兩個缺口：
  // 1) isTrusted=false 的合成事件不會觸發 label 啟用行為 → 手動補 click；
  // 2) 內部 <button>（翻頁鍵等）冒泡上来的點擊不得開選擇器。
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
