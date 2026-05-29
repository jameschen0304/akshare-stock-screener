let scanState = null;
let stopScan = false;
let lastDetails = [];

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
    request_delay: 0.25,
  };
}

function updateProgress(state) {
  const pct = state.total ? Math.round((100 * state.done) / state.total) : 0;
  el("progressFill").style.width = pct + "%";
  el("progressText").textContent = `${state.message} (${state.done}/${state.total}，命中 ${state.passed})`;
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

async function startScan() {
  if (!window.ScreenerCore) {
    el("progressPanel").hidden = false;
    el("progressText").textContent = "核心脚本未加载";
    return;
  }

  stopScan = false;
  el("btnStart").disabled = true;
  el("btnExport").disabled = true;
  el("progressPanel").hidden = false;
  el("progressFill").style.width = "0%";
  el("progressText").textContent = "正在启动（浏览器直连东方财富）…";
  clearTables();

  const cfg = readForm();

  try {
    scanState = await ScreenerCore.runScan(cfg, {
      shouldStop: () => stopScan,
      onProgress: (state) => {
        updateProgress(state);
        if (state.status === "error") {
          el("progressText").textContent = "错误: " + (state.error || "未知");
        }
      },
      onPartial: (state) => {
        lastDetails = state.results;
        renderSummary(state.summary);
        el("resultCount").textContent = String(state.passed);
      },
    });

    lastDetails = scanState.results || [];
    renderSummary(scanState.summary || []);
    el("resultCount").textContent = String(scanState.passed || 0);
    if (scanState.passed > 0) el("btnExport").disabled = false;
  } catch (e) {
    el("progressText").textContent = "扫描失败: " + e.message;
  } finally {
    el("btnStart").disabled = false;
  }
}

function exportCsv() {
  if (!scanState?.results?.length) return;
  ScreenerCore.exportCsv(scanState.results);
}

el("btnStart").addEventListener("click", startScan);
el("btnExport").addEventListener("click", exportCsv);
