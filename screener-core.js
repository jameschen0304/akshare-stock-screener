/**
 * 浏览器端 A 股选股（逻辑与 scripts/stock_screener_web/screener.py 一致）
 */
(function (global) {
  const PROFIT_FIELDS = {
    revenue: "TOTAL_OPERATE_INCOME",
    operate_cost: "TOTAL_OPERATE_COST",
    deduct_net_parent: "DEDUCT_PARENT_NETPROFIT",
  };
  const BALANCE_FIELDS = {
    current_assets: "TOTAL_CURRENT_ASSETS",
    current_liab: "TOTAL_CURRENT_LIAB",
  };
  const SEMI_SUFFIXES = ["-06-30", "-12-31"];

  const EM_UT =
    "bd1d9ddb04089700cf9c27f6f7426281";

  const EM_HEADERS = {
    Accept: "application/json, text/plain, */*",
    Referer: "https://quote.eastmoney.com/",
  };

  const CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get";
  const CLIST_PAGE_SIZE = 100;
  const CLIST_MAX_PAGES_BROWSER = 30;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function padCode(code) {
    return String(code).padStart(6, "0");
  }

  function toEmSymbol(code) {
    const c = padCode(code);
    return c.startsWith("5") || c.startsWith("6") || c.startsWith("9")
      ? `SH${c}`
      : `SZ${c}`;
  }

  function toSecucode(emSymbol) {
    const market = emSymbol.slice(0, 2);
    const code = emSymbol.slice(2);
    return `${code}.${market}`;
  }

  function normalizeDate(v) {
    if (!v) return "";
    const s = String(v);
    if (s.length >= 10) return s.slice(0, 10);
    return s;
  }

  function isSt(name) {
    return String(name).toUpperCase().includes("ST");
  }

  function isStar(code) {
    return padCode(code).startsWith("688");
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function pct(v) {
    if (v == null || !Number.isFinite(v)) return null;
    return `${(v * 100).toFixed(2)}%`;
  }

  async function emFetchRaw(url) {
    const errors = [];
    try {
      const r = await fetch(url, {
        method: "GET",
        credentials: "omit",
        headers: EM_HEADERS,
      });
      if (r.ok) return await r.text();
      errors.push(`直连 HTTP ${r.status}`);
    } catch (e) {
      errors.push(`直连: ${e.message || e}`);
    }

    const proxies = [
      (u) => "https://api.allorigins.win/get?url=" + encodeURIComponent(u),
      (u) => "https://corsproxy.io/?" + encodeURIComponent(u),
    ];
    for (const build of proxies) {
      try {
        const proxyUrl = build(url);
        const r = await fetch(proxyUrl, { method: "GET", credentials: "omit" });
        if (!r.ok) {
          errors.push(`代理 HTTP ${r.status}`);
          continue;
        }
        const text = await r.text();
        if (proxyUrl.includes("allorigins.win/get")) {
          const wrap = JSON.parse(text);
          if (wrap?.contents != null) return wrap.contents;
        }
        return text;
      } catch (e) {
        errors.push(`代理: ${e.message || e}`);
      }
    }
    throw new Error(
      "无法访问东方财富（CORS/网络）。请换 Chrome、关闭广告拦截，或本地运行 python scripts/stock_screener_web/app.py；也可在 config.js 设置 SCREENER_API_BASE。"
    );
  }

  async function emFetchJson(url, params) {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const text = await emFetchRaw(url + qs);
    return JSON.parse(text);
  }

  async function emFetchJsonRetry(url, params, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        return await emFetchJson(url, params);
      } catch (e) {
        lastErr = e;
        if (i < retries - 1) await sleep(600 * (i + 1));
      }
    }
    throw lastErr;
  }

  function mapUniverseRows(raw) {
    return raw
      .map((r) => ({
        code: padCode(r.f12),
        name: r.f14,
        market_cap: num(r.f20),
        em_symbol: toEmSymbol(r.f12),
      }))
      .filter(
        (s) =>
          s.market_cap &&
          s.market_cap > 0 &&
          !isSt(s.name) &&
          !isStar(s.code)
      );
  }

  /** needCount>0 时只拉取满足扫描数量所需的页，避免全市场分页在浏览器里失败 */
  async function loadUniverse(needCount = 0) {
    const baseParams = {
      pz: String(CLIST_PAGE_SIZE),
      po: "1",
      np: "1",
      ut: EM_UT,
      fltt: "2",
      invt: "2",
      fid: "f12",
      fs: "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048",
      fields: "f12,f14,f20",
    };
    const raw = [];
    let pn = 1;
    let totalPage = 1;
    const maxPages =
      needCount > 0
        ? Math.min(
            Math.ceil((needCount * 1.4) / CLIST_PAGE_SIZE) + 1,
            CLIST_MAX_PAGES_BROWSER
          )
        : CLIST_MAX_PAGES_BROWSER;

    while (pn <= totalPage && pn <= maxPages) {
      const data = await emFetchJsonRetry(CLIST_URL, {
        ...baseParams,
        pn: String(pn),
      });
      const diff = data?.data?.diff || [];
      const per = diff.length || CLIST_PAGE_SIZE;
      totalPage = Math.ceil((data?.data?.total || per) / per);
      raw.push(...diff);

      if (needCount > 0) {
        const filtered = mapUniverseRows(raw);
        if (filtered.length >= needCount) return filtered.slice(0, needCount);
      }

      pn += 1;
      if (pn <= totalPage && pn <= maxPages) await sleep(500);
    }

    const all = mapUniverseRows(raw);
    if (needCount > 0) return all.slice(0, needCount);
    return all;
  }

  async function fetchMarketCap(code) {
    const c = padCode(code);
    const market = c.startsWith("6") ? 1 : 0;
    const data = await emFetchJson(
      "https://push2.eastmoney.com/api/qt/stock/get",
      {
        fltt: "2",
        invt: "2",
        fields: "f116",
        secid: `${market}.${c}`,
      }
    );
    return num(data?.data?.f116);
  }

  async function fetchSheet(emSymbol, kind) {
    const secu = toSecucode(emSymbol);
    const isProfit = kind === "profit";
    const data = await emFetchJson(
      "https://datacenter.eastmoney.com/securities/api/data/get",
      {
        type: isProfit ? "RPT_F10_FINANCE_GINCOME" : "RPT_F10_FINANCE_GBALANCE",
        sty: isProfit ? "APP_F10_GINCOME" : "F10_FINANCE_GBALANCE",
        filter: `(SECUCODE="${secu}")`,
        p: "1",
        ps: "200",
        sr: "-1",
        st: "REPORT_DATE",
        source: "HSF10",
        client: "PC",
        v: String(Date.now()),
      }
    );
    return data?.result?.data || [];
  }

  function extractProfit(rows) {
    const map = new Map();
    for (const row of rows) {
      const rd = normalizeDate(row.REPORT_DATE);
      if (!rd) continue;
      if (!map.has(rd)) {
        map.set(rd, {
          report_date: rd,
          report_type: row.REPORT_DATE_NAME || row.REPORT_TYPE,
        });
      }
      const rec = map.get(rd);
      for (const [k, col] of Object.entries(PROFIT_FIELDS)) {
        if (row[col] != null) rec[k] = num(row[col]);
      }
    }
    return [...map.values()].sort((a, b) =>
      a.report_date < b.report_date ? 1 : -1
    );
  }

  function extractBalance(rows) {
    const map = new Map();
    for (const row of rows) {
      const rd = normalizeDate(row.REPORT_DATE);
      if (!rd) continue;
      if (!map.has(rd)) {
        map.set(rd, {
          report_date: rd,
          report_type: row.REPORT_DATE_NAME || row.REPORT_TYPE,
        });
      }
      const rec = map.get(rd);
      for (const [k, col] of Object.entries(BALANCE_FIELDS)) {
        if (row[col] != null) rec[k] = num(row[col]);
      }
    }
    return [...map.values()].sort((a, b) =>
      a.report_date < b.report_date ? 1 : -1
    );
  }

  function pickRow(rows, suffix, year) {
    const target = `${year}${suffix}`;
    return rows.find((r) => r.report_date === target) || null;
  }

  function calcTtmDeduct(profitRows) {
    if (!profitRows.length) return null;
    const sorted = [...profitRows].sort((a, b) =>
      a.report_date < b.report_date ? 1 : -1
    );
    const latest = sorted[0];
    const deduct = latest.deduct_net_parent;
    if (deduct == null) return null;
    const md = latest.report_date.slice(5);
    const year = Number(latest.report_date.slice(0, 4));
    if (md === "12-31") return deduct;
    const prevAnnual = pickRow(sorted, "-12-31", year - 1);
    const samePrev = pickRow(sorted, latest.report_date.slice(4), year - 1);
    if (!prevAnnual || !samePrev) return null;
    const ann = prevAnnual.deduct_net_parent;
    const prevSame = samePrev.deduct_net_parent;
    if (ann == null || prevSame == null) return null;
    const ttm = deduct + ann - prevSame;
    return ttm > 0 ? ttm : null;
  }

  function buildMetrics(profitRows, balanceRows, periods) {
    const balanceMap = new Map(balanceRows.map((b) => [b.report_date, b]));
    const merged = profitRows
      .filter((p) => balanceMap.has(p.report_date))
      .filter((p) => SEMI_SUFFIXES.some((s) => p.report_date.endsWith(s)))
      .sort((a, b) => (a.report_date < b.report_date ? 1 : -1))
      .slice(0, periods)
      .sort((a, b) => (a.report_date > b.report_date ? 1 : -1));

    return merged.map((p) => {
      const b = balanceMap.get(p.report_date);
      const revenue = p.revenue;
      const operate_cost = p.operate_cost;
      const deduct = p.deduct_net_parent;
      const ca = b.current_assets;
      const cl = b.current_liab;
      const gross_profit =
        revenue != null && operate_cost != null ? revenue - operate_cost : null;
      const gross_margin =
        gross_profit != null && revenue > 0 ? gross_profit / revenue : null;
      const net_margin = deduct != null && revenue > 0 ? deduct / revenue : null;
      const current_ratio = ca != null && cl > 0 ? ca / cl : null;
      return {
        report_date: p.report_date,
        report_type: p.report_type,
        revenue,
        operate_cost,
        deduct_net_parent: deduct,
        current_assets: ca,
        current_liab: cl,
        gross_profit,
        gross_margin,
        net_margin,
        current_ratio,
      };
    });
  }

  function annualRevenueIncreasing(metrics, years) {
    const annual = metrics
      .filter((m) => m.report_date.endsWith("-12-31"))
      .sort((a, b) => (a.report_date > b.report_date ? 1 : -1));
    if (annual.length < years) return false;
    const tail = annual.slice(-years);
    const revs = tail.map((m) => m.revenue);
    if (revs.some((r) => r == null)) return false;
    for (let i = 0; i < revs.length - 1; i++) {
      if (!(revs[i] < revs[i + 1])) return false;
    }
    return true;
  }

  function passesHardRules(metrics, cfg) {
    const reasons = [];
    if (!metrics.length) return { ok: false, reasons: ["无财报数据"] };
    const latest = metrics[metrics.length - 1];
    if (
      latest.current_ratio == null ||
      latest.current_ratio < cfg.min_current_ratio
    ) {
      reasons.push(`流动比率<${cfg.min_current_ratio}`);
    }
    if (!annualRevenueIncreasing(metrics, cfg.revenue_growth_years)) {
      reasons.push(`最近${cfg.revenue_growth_years}个年报收入未连增`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  async function analyzeStock(row, cfg) {
    const profitRaw = await fetchSheet(row.em_symbol, "profit");
    const balanceRaw = await fetchSheet(row.em_symbol, "balance");
    const profitRows = extractProfit(profitRaw);
    const balanceRows = extractBalance(balanceRaw);
    if (!profitRows.length || !balanceRows.length) return null;

    const ttm = calcTtmDeduct(profitRows);
    let cap = row.market_cap;
    if (!cap) cap = await fetchMarketCap(row.code);
    if (!cap || !ttm) return null;
    const pe = cap / ttm;
    if (pe < cfg.pe_min || pe > cfg.pe_max) return null;

    const metrics = buildMetrics(profitRows, balanceRows, cfg.periods);
    if (!metrics.length) return null;

    const hard = passesHardRules(metrics, cfg);
    if (cfg.apply_hard_rules && !hard.ok) return null;

    const latest = metrics[metrics.length - 1];
    return {
      code: row.code,
      name: row.name,
      market_cap: cap,
      pe_ttm: Math.round(pe * 100) / 100,
      latest_report_date: latest.report_date,
      latest_gross_margin: pct(latest.gross_margin),
      latest_net_margin: pct(latest.net_margin),
      latest_current_ratio:
        latest.current_ratio != null
          ? Math.round(latest.current_ratio * 1000) / 1000
          : null,
      hard_rules_pass: hard.ok,
      hard_rules_note: hard.reasons.length ? hard.reasons.join("; ") : "通过",
      periods: metrics,
    };
  }

  async function runScan(cfg, hooks) {
    const state = {
      status: "running",
      total: 0,
      done: 0,
      passed: 0,
      message: "加载股票池…",
      error: null,
      results: [],
      summary: [],
    };
    hooks?.onProgress?.(state);

    try {
      const scanLimit = cfg.limit > 0 ? cfg.limit : 0;
      let universe = await loadUniverse(scanLimit || 500);
      if (scanLimit > 0) universe = universe.slice(0, scanLimit);
      state.total = universe.length;
      state.message = `共 ${state.total} 只股票待分析`;
      hooks?.onProgress?.(state);

      const concurrency = Math.min(cfg.max_workers || 3, 4);
      let idx = 0;

      async function worker() {
        while (idx < universe.length) {
          if (hooks?.shouldStop?.()) return;
          const i = idx++;
          const row = universe[i];
          await sleep((cfg.request_delay || 0.2) * 1000);
          try {
            const item = await analyzeStock(row, cfg);
            if (item) {
              state.results.push(item);
              state.summary.push({
                code: item.code,
                name: item.name,
                pe_ttm: item.pe_ttm,
                market_cap: item.market_cap,
                latest_report_date: item.latest_report_date,
                latest_gross_margin: item.latest_gross_margin,
                latest_net_margin: item.latest_net_margin,
                latest_current_ratio: item.latest_current_ratio,
                hard_rules_pass: item.hard_rules_pass,
                hard_rules_note: item.hard_rules_note,
              });
              state.passed += 1;
              state.summary.sort((a, b) => (a.pe_ttm || 999) - (b.pe_ttm || 999));
              hooks?.onPartial?.(state);
            }
          } catch (_) {
            /* skip single stock errors */
          }
          state.done += 1;
          state.message = `已处理 ${state.done}/${state.total}，命中 ${state.passed}`;
          hooks?.onProgress?.(state);
        }
      }

      await Promise.all(
        Array.from({ length: concurrency }, () => worker())
      );

      state.status = "done";
      state.message = `完成：命中 ${state.passed} / ${state.total}`;
    } catch (e) {
      state.status = "error";
      state.error = e.message || String(e);
      state.message = "扫描失败";
    }
    hooks?.onProgress?.(state);
    return state;
  }

  function exportCsv(results) {
    const lines = [
      [
        "代码",
        "名称",
        "PE_TTM",
        "总市值",
        "报告期",
        "报告类型",
        "营业总收入",
        "营业总成本",
        "归母扣非净利润",
        "流动资产合计",
        "流动负债合计",
        "毛利润",
        "毛利率",
        "净利率",
        "流动比率",
        "硬性规则",
      ].join(","),
    ];
    for (const stock of results) {
      for (const p of stock.periods || []) {
        lines.push(
          [
            stock.code,
            `"${stock.name}"`,
            stock.pe_ttm,
            stock.market_cap,
            p.report_date,
            `"${p.report_type || ""}"`,
            p.revenue ?? "",
            p.operate_cost ?? "",
            p.deduct_net_parent ?? "",
            p.current_assets ?? "",
            p.current_liab ?? "",
            p.gross_profit ?? "",
            pct(p.gross_margin) ?? "",
            pct(p.net_margin) ?? "",
            p.current_ratio ?? "",
            `"${stock.hard_rules_note || ""}"`,
          ].join(",")
        );
      }
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `screener_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  global.ScreenerCore = { runScan, exportCsv };
})(window);
