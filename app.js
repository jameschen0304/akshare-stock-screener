let scanState = null;
let stopScan = false;
let continuousScan = false;
let scanSkip = 0;
let lastDetails = [];
let apiJobId = null;
let apiPollTimer = null;

const apiBase = () =>
  (window.SCREENER_API_BASE || "").replace(/\/$/, "");

const fmtNum = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const x = Number(n);
  if (Math.abs(x) >= 1e8) return (x / 1e8).toFixed(2) + "亿";
  if (Math.abs(x) >= 1e4) return (x / 1e4).toFixed(2) + "万";
  return x.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
};

const fmtPct = (v) => {
  if (v == null) return "—";
  if (typeof v === "string" && v.includes("%")) return v;
  return (Number(v) * 100).toFixed(2) + "%";
};

const el = (id) => document.getElementById(id);

function readForm() {
  const f = el("scanForm");
  const fd = new FormData(f);
  return {
    pe_min: Number(fd.get("pe_min")),
    pe_max: Number(fd.get("pe_max")),
    periods: Number(fd.get("periods")),
    limit: Number(fd.get("limit")),
    max_workers: Number(fd.get("max_workers")),
    min_current_ratio: Number(fd.get("min_current_ratio")),
    revenue_growth_years: Number(fd.get("revenue_growth_years")),
    apply_hard_rules: f.querySelector('[name="apply_hard_rules"]').checked,
    continuous_scan: f.querySelector('[name="continuous_scan"]')?.checked,
    request_delay: 0.35,
  };
}

function mergeScanResults(prev, batch) {
  const results = [...(prev.results || [])];
  const summary = [...(prev.summary || [])];
  const codes = new Set(results.map((r) => r.code));
  for (const item of batch.results || []) {
    if (codes.has(item.code)) continue;
    codes.add(item.code);
    results.push(item);
  }
  const sumCodes = new Set(summary.map((r) => r.code));
  for (const row of batch.summary || []) {
    if (sumCodes.has(row.code)) continue;
    sumCodes.add(row.code);
    summary.push(row);
  }
  summary.sort((a, b) => (a.pe_ttm || 999) - (b.pe_ttm || 999));
  return {
    results,
    summary,
    passed: results.length,
    scanned: (prev.scanned || 0) + (batch.total || 0),
  };
}

function setScanningUi(active) {
  el("btnStart").disabled = active;
  el("btnStop").hidden = !active;
  if (active) {
    el("btnStart").textContent = continuousScan ? "连续扫描中…" : "扫描中…";
  } else {
    el("btnStart").textContent = "开始扫描";
  }
}

function updateProgress(state, extra) {
  const pct = state.total ? Math.round((100 * state.done) / state.total) : 0;
  el("progressFill").style.width = pct + "%";
  const cum = extra?.scannedTotal != null ? ` · 累计已扫 ${extra.scannedTotal}` : "";
  const hits = extra?.totalPassed != null ? extra.totalPassed : state.passed;
  el("progressText").textContent = `${state.message} (${state.done}/${state.total}，命中 ${hits}${cum})`;
}

function clearTables() {
  el("summaryTable").querySelector("tbody").innerHTML = "";
  el("detailTable").querySelector("tbody").innerHTML = "";
  el("detailPanel").hidden = true;
  el("resultCount").textContent = "0";
  lastDetails = [];
}

function renderSummary(rows) {
  const tbody = el("summaryTable").querySelector("tbody");
  tbody.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td class="num">${r.code}</td>
      <td>${r.name}</td>
      <td class="num">${r.pe_ttm}</td>
      <td class="num">${fmtNum(r.market_cap)}</td>
      <td>${r.latest_report_date || "—"}</td>
      <td>${r.latest_gross_margin || "—"}</td>
      <td>${r.latest_net_margin || "—"}</td>
      <td class="num">${r.latest_current_ratio ?? "—"}</td>
      <td title="${r.hard_rules_note || ""}">${r.hard_rules_pass ? "通过" : "—"}</td>
      <td><button type="button" class="link-btn" data-code="${r.code}">明细</button></td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll(".link-btn").forEach((btn) => {
    btn.addEventListener("click", () => showDetail(btn.dataset.code));
  });
}

function showDetail(code) {
  const stock = lastDetails.find((s) => s.code === code);
  if (!stock) return;
  el("detailPanel").hidden = false;
  el("detailTitle").textContent = `${stock.name} (${stock.code}) · PE ${stock.pe_ttm}`;

  const tbody = el("detailTable").querySelector("tbody");
  tbody.innerHTML = (stock.periods || [])
    .map(
      (p) => `
    <tr>
      <td>${p.report_date}</td>
      <td>${p.report_type || "—"}</td>
      <td class="num">${fmtNum(p.revenue)}</td>
      <td class="num">${fmtNum(p.operate_cost)}</td>
      <td class="num">${fmtNum(p.deduct_net_parent)}</td>
      <td class="num">${fmtNum(p.gross_profit)}</td>
      <td>${fmtPct(p.gross_margin)}</td>
      <td>${fmtPct(p.net_margin)}</td>
      <td class="num">${fmtNum(p.current_assets)}</td>
      <td class="num">${fmtNum(p.current_liab)}</td>
      <td class="num">${p.current_ratio != null ? Number(p.current_ratio).toFixed(3) : "—"}</td>
    </tr>`
    )
    .join("");
  el("detailPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function startScanApi(cfg) {
  const base = apiBase();
  el("progressText").textContent = "正在连接后端…";
  const res = await fetch(`${base}/api/scan/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || res.statusText || "启动失败");
  }
  const data = await res.json();
  apiJobId = data.job_id;
  if (apiPollTimer) clearInterval(apiPollTimer);
  apiPollTimer = setInterval(() => pollApiScan(), 1200);
  await pollApiScan();
}

async function pollApiScan() {
  if (!apiJobId) return;
  const base = apiBase();
  const res = await fetch(`${base}/api/scan/${apiJobId}/status`);
  const st = await res.json();
  const pct = st.total ? Math.round((100 * st.done) / st.total) : 0;
  el("progressFill").style.width = pct + "%";
  el("progressText").textContent = `${st.message} (${st.done}/${st.total}，命中 ${st.passed})`;

  if (st.status === "running" && st.passed > 0) {
    await loadApiResults();
  }
  if (st.status === "done" || st.status === "error") {
    clearInterval(apiPollTimer);
    apiPollTimer = null;
    if (st.status === "error") {
      el("progressText").textContent = "错误: " + (st.error || "未知");
      return;
    }
    await loadApiResults();
    if (lastDetails.length) el("btnExport").disabled = false;
  }
}

async function loadApiResults() {
  const base = apiBase();
  const res = await fetch(`${base}/api/scan/${apiJobId}/results`);
  const data = await res.json();
  lastDetails = data.details || [];
  scanState = { results: lastDetails, summary: data.summary || [], passed: data.count || 0 };
  renderSummary(data.summary || []);
  el("resultCount").textContent = String(data.count || 0);
}

function stopScanNow() {
  stopScan = true;
  continuousScan = false;
  el("progressText").textContent = "正在停止…";
}

async function runBrowserScanLoop() {
  const cfg = readForm();
  if (cfg.continuous_scan && cfg.limit <= 0) {
    el("progressText").textContent = "连续扫描需将「扫描股票上限」设为大于 0（如 80）";
    return;
  }

  continuousScan = !!cfg.continuous_scan;
  scanSkip = 0;
  if (window.ScreenerCore?.resetUniverseCache) ScreenerCore.resetUniverseCache();
  let accumulated = { results: [], summary: [], passed: 0, scanned: 0 };

  do {
    if (stopScan) break;
    const batchCfg = { ...cfg, skip: scanSkip };
    const batchState = await ScreenerCore.runScan(batchCfg, {
      shouldStop: () => stopScan,
      onProgress: (state) => {
        updateProgress(state, {
          scannedTotal: accumulated.scanned + state.done,
          totalPassed: accumulated.passed + state.passed,
        });
        if (state.status === "error") {
          el("progressText").textContent = "错误: " + (state.error || "未知");
        }
      },
      onPartial: (state) => {
        const merged = mergeScanResults(accumulated, state);
        lastDetails = merged.results;
        renderSummary(merged.summary);
        el("resultCount").textContent = String(merged.passed);
      },
    });

    if (batchState.status === "error") break;

    if (batchState.total === 0) {
      if (!batchState.hasMore) break;
      el("progressText").textContent =
        "无法加载下一批股票（接口限流或股票池已用尽），已连续扫描 " +
        accumulated.scanned +
        " 只";
      break;
    }

    accumulated = mergeScanResults(accumulated, batchState);
    accumulated.scanned += batchState.total || 0;
    scanState = {
      results: accumulated.results,
      summary: accumulated.summary,
      passed: accumulated.passed,
    };
    lastDetails = accumulated.results;
    renderSummary(accumulated.summary);
    el("resultCount").textContent = String(accumulated.passed);
    if (accumulated.passed > 0) el("btnExport").disabled = false;

    if (!continuousScan || stopScan || !batchState.hasMore) break;

    scanSkip += cfg.limit;
    el("progressText").textContent = `第 ${Math.floor(scanSkip / cfg.limit) + 1} 批准备中…（已扫 ${accumulated.scanned} 只）`;
    await new Promise((r) => setTimeout(r, 1500));
  } while (true);

  if (!stopScan && continuousScan) {
    el("progressText").textContent = `全部批次完成：累计扫描 ${accumulated.scanned} 只，命中 ${accumulated.passed} 只`;
  } else if (stopScan) {
    el("progressText").textContent = `已停止：累计扫描 ${accumulated.scanned} 只，命中 ${accumulated.passed} 只`;
  }
}

async function prepareBrowserScan() {
  if (apiBase()) return;
  el("progressText").textContent = "正在启用浏览器代理（Service Worker）…";
  try {
    await window.__screenerSwReady;
  } catch (_) {
    /* ignore */
  }
  if (
    navigator.serviceWorker &&
    !navigator.serviceWorker.controller &&
    !sessionStorage.getItem("screener-sw-reload")
  ) {
    sessionStorage.setItem("screener-sw-reload", "1");
    location.reload();
    return;
  }
}

async function startScan() {
  if (apiBase()) {
    stopScan = false;
    el("btnStart").disabled = true;
    el("btnExport").disabled = true;
    el("progressPanel").hidden = false;
    el("progressFill").style.width = "0%";
    el("progressText").textContent = "正在启动（后端模式）…";
    clearTables();
    try {
      await startScanApi(readForm());
    } catch (e) {
      el("progressText").textContent = "扫描失败: " + e.message;
    } finally {
      el("btnStart").disabled = false;
    }
    return;
  }

  if (!window.ScreenerCore) {
    el("progressPanel").hidden = false;
    el("progressText").textContent = "核心脚本未加载";
    return;
  }

  stopScan = false;
  setScanningUi(true);
  el("btnExport").disabled = true;
  el("progressPanel").hidden = false;
  el("progressFill").style.width = "0%";
  el("progressText").textContent = "正在启动…";
  clearTables();

  try {
    await prepareBrowserScan();
    await runBrowserScanLoop();
  } catch (e) {
    el("progressText").textContent = "扫描失败: " + e.message;
  } finally {
    continuousScan = false;
    setScanningUi(false);
  }
}

function exportCsv() {
  if (apiBase() && apiJobId) {
    window.location.href = `${apiBase()}/api/scan/${apiJobId}/export`;
    return;
  }
  if (!scanState?.results?.length) return;
  ScreenerCore.exportCsv(scanState.results);
}

el("btnStart").addEventListener("click", startScan);
el("btnStop").addEventListener("click", stopScanNow);
el("btnExport").addEventListener("click", exportCsv);
