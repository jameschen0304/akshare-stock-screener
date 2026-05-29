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

  const DC_HEADERS = {
    Accept: "application/json, text/plain, */*",
    Referer: "https://emweb.securities.eastmoney.com/",
    Origin: "https://emweb.securities.eastmoney.com",
  };

  function isHtmlBody(text) {
    const t = String(text || "").trim().toLowerCase();
    return (
      t.startsWith("<!doctype") ||
      t.startsWith("<html") ||
      (t.startsWith("<") && t.includes("</html>"))
    );
  }

  function parseEmJson(text, label) {
    if (isHtmlBody(text)) {
      throw new Error(
        (label || "接口") + "返回了网页而非数据（代理未生效），请 Ctrl+F5 刷新或本地运行 app.py"
      );
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(
        (label || "接口") + " JSON 解析失败: " + (e.message || e)
      );
    }
    if (data && data.success === false) {
      throw new Error((label || "接口") + ": " + (data.message || "请求失败"));
    }
    return data;
  }

  const CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get";
  const CLIST_PAGE_SIZE = 100;
  const CLIST_MAX_PAGES_BROWSER = 55;

  let _universeRaw = [];
  let _universeFiltered = [];
  let _universeNextPage = 1;
  let _universeTotalPages = 1;
  let _universeExhausted = false;

  function resetUniverseCache() {
    _universeRaw = [];
    _universeFiltered = [];
    _universeNextPage = 1;
    _universeTotalPages = 1;
    _universeExhausted = false;
  }

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

  /** 行情列表 f20 多为「万元」，单股 f116 为「元」 */
  function normalizeMarketCap(cap) {
    const n = num(cap);
    if (n == null || n <= 0) return null;
    if (n < 1e10) return n * 10000;
    return n;
  }

  function pct(v) {
    if (v == null || !Number.isFinite(v)) return null;
    return `${(v * 100).toFixed(2)}%`;
  }

  function financeProxyBase() {
    return String(window.SCREENER_PROXY_BASE || "").replace(/\/$/, "");
  }

  async function ensureFinanceProxyReady() {
    if (window.SCREENER_API_BASE || financeProxyBase()) return;
    if (typeof window.waitScreenerProxy === "function") {
      const st = await window.waitScreenerProxy();
      if (!st.ok) {
        throw new Error(st.reason || "财报代理未就绪");
      }
    }
  }

  async function proxyFetchText(fullUrl, label) {
    const errors = [];
    if (typeof window.screenerProxyFetch === "function") {
      try {
        return await window.screenerProxyFetch(fullUrl);
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    const custom = financeProxyBase();
    if (custom) {
      try {
        const r = await fetch(
          custom + "?url=" + encodeURIComponent(fullUrl),
          { credentials: "omit" }
        );
        const text = await r.text();
        if (r.ok && !isHtmlBody(text)) return text;
        errors.push(`CF代理 HTTP ${r.status}`);
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    try {
      const proxy = new URL("em-proxy", location.href);
      proxy.searchParams.set("url", fullUrl);
      const r2 = await fetch(proxy.href, { credentials: "omit" });
      const text2 = await r2.text();
      if (r2.ok && !isHtmlBody(text2)) return text2;
      errors.push(r2.ok ? "em-proxy 返回 HTML" : `em-proxy HTTP ${r2.status}`);
    } catch (e) {
      errors.push(e.message || String(e));
    }
    throw new Error(
      (label || "财报") + "代理失败: " + (errors.join("; ") || "未知")
    );
  }

  /** 行情 push2：浏览器可直连，不走代理 */
  async function emFetchPush2Json(url, params, label) {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const r = await fetch(url + qs, {
      method: "GET",
      credentials: "omit",
      headers: EM_HEADERS,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${label || "行情"} HTTP ${r.status}`);
    return parseEmJson(text, label);
  }

  async function emFetchPush2JsonRetry(url, params, retries, label) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        return await emFetchPush2Json(url, params, label);
      } catch (e) {
        lastErr = e;
        if (i < retries - 1) await sleep(600 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** 财报：经 Service Worker 消息代理（GitHub Pages） */
  async function emFetchFinance(url, params, label) {
    await ensureFinanceProxyReady();
    const full = url + "?" + new URLSearchParams(params).toString();

    if (!window.SCREENER_API_BASE && !financeProxyBase()) {
      const text = await proxyFetchText(full, label);
      return parseEmJson(text, label);
    }

    const errors = [];
    try {
      const text = await proxyFetchText(full, label);
      return parseEmJson(text, label);
    } catch (e) {
      errors.push(e.message || String(e));
    }

    try {
      const r = await fetch(full, {
        method: "GET",
        credentials: "omit",
        headers: DC_HEADERS,
      });
      const text = await r.text();
      if (r.ok && !isHtmlBody(text)) return parseEmJson(text, label);
    } catch (_) {
      /* CORS */
    }

    throw new Error(
      (label || "财报") + "不可用: " + errors.join("; ") +
        "。请 F5 刷新后重试，或运行 scripts/stock_screener_web/run_local.bat"
    );
  }

  function normalizeDiff(diff) {
    if (!diff) return [];
    if (Array.isArray(diff)) return diff;
    return Object.values(diff);
  }

  function pickDeductFromRow(row) {
    for (const col of [
      "DEDUCT_PARENT_NETPROFIT",
      "DEDUCT_NETPROFIT",
      "PARENT_NETPROFIT",
      "NETPROFIT",
    ]) {
      const v = num(row[col]);
      if (v != null) return v;
    }
    return null;
  }


  function mapUniverseRows(raw) {
    return raw
      .map((r) => ({
        code: padCode(r.f12),
        name: r.f14,
        market_cap: normalizeMarketCap(r.f20),
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

  const CLIST_BASE_PARAMS = {
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

  /** 增量拉取股票池（连续扫描时从上次页码接着拉，不重复请求前几页） */
  async function growUniverse(minFilteredCount) {
    while (
      !_universeExhausted &&
      _universeFiltered.length < minFilteredCount &&
      _universeNextPage <= _universeTotalPages &&
      _universeNextPage <= CLIST_MAX_PAGES_BROWSER
    ) {
      const pn = _universeNextPage;
      const data = await emFetchPush2JsonRetry(
        CLIST_URL,
        { ...CLIST_BASE_PARAMS, pn: String(pn) },
        3,
        "股票池"
      );
      const diff = normalizeDiff(data?.data?.diff);
      const per = diff.length || CLIST_PAGE_SIZE;
      _universeTotalPages = Math.ceil((data?.data?.total || per) / per);
      _universeRaw.push(...diff);
      _universeFiltered = mapUniverseRows(_universeRaw);
      _universeNextPage = pn + 1;

      if (!diff.length || pn >= _universeTotalPages) {
        _universeExhausted = true;
      }
      if (
        _universeNextPage <= _universeTotalPages &&
        _universeFiltered.length < minFilteredCount &&
        !_universeExhausted
      ) {
        await sleep(500);
      }
    }
    return _universeFiltered;
  }

  function universeHasMore(skip, batchLen, batchSize) {
    const end = skip + batchLen;
    if (end < _universeFiltered.length) return true;
    if (!_universeExhausted && _universeNextPage <= _universeTotalPages) {
      return true;
    }
    return false;
  }

  async function loadUniverseBatch(needCount, skipCount) {
    const want = skipCount + (needCount > 0 ? needCount : 500);
    await growUniverse(want);
    return _universeFiltered.slice(skipCount, skipCount + needCount);
  }

  async function fetchMarketCap(code) {
    const c = padCode(code);
    const market = c.startsWith("6") ? 1 : 0;
    const data = await emFetchPush2Json(
      "https://push2.eastmoney.com/api/qt/stock/get",
      {
        fltt: "2",
        invt: "2",
        fields: "f116",
        secid: `${market}.${c}`,
      },
      "总市值"
    );
    return normalizeMarketCap(data?.data?.f116);
  }

  const COMPANY_TYPES = ["4", "3", "1"];
  const _companyTypeCache = new Map();

  async function fetchCompanyType(emSymbol) {
    if (_companyTypeCache.has(emSymbol)) {
      return _companyTypeCache.get(emSymbol);
    }
    const indexUrl =
      "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index" +
      "?type=web&code=" +
      encodeURIComponent(emSymbol.toLowerCase());
    const html = await proxyFetchText(indexUrl, "公司类型");
    const m = html.match(/id=["']hidctype["'][^>]*value=["'](\d+)["']/i);
    const ct = m ? m[1] : null;
    if (ct) _companyTypeCache.set(emSymbol, ct);
    return ct;
  }

  async function fetchSheetDatacenter(emSymbol, kind) {
    const secu = toSecucode(emSymbol);
    const isProfit = kind === "profit";
    const data = await emFetchFinance(
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
      },
      "财报数据中心"
    );
    const rows = data?.result?.data;
    if (!rows || !rows.length) {
      throw new Error("数据中心返回空财报");
    }
    return rows;
  }

  async function fetchSheetEmweb(emSymbol, kind, companyType) {
    const isProfit = kind === "profit";
    const dateUrl = isProfit
      ? "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/lrbDateAjaxNew"
      : "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/zcfzbDateAjaxNew";
    const dataUrl = isProfit
      ? "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/lrbAjaxNew"
      : "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/zcfzbAjaxNew";

    const dateJson = await emFetchFinance(
      dateUrl,
      { companyType, reportDateType: "0", code: emSymbol },
      "财报日期"
    );
    const dates = (dateJson.data || [])
      .map((d) => normalizeDate(d.REPORT_DATE))
      .filter(Boolean);
    let all = [];
    for (let i = 0; i < dates.length; i += 5) {
      const datesChunk = dates.slice(i, i + 5).join(",");
      const part = await emFetchFinance(
        dataUrl,
        {
          companyType,
          reportDateType: "0",
          reportType: "1",
          dates: datesChunk,
          code: emSymbol,
        },
        "财报明细"
      );
      if (part?.data) all = all.concat(part.data);
      await sleep(300);
    }
    return all;
  }

  async function fetchSheet(emSymbol, kind) {
    try {
      const rows = await fetchSheetDatacenter(emSymbol, kind);
      if (rows.length) return rows;
    } catch (dcErr) {
      const companyType = await fetchCompanyType(emSymbol).catch(() => null);
      const types = companyType
        ? [companyType, ...COMPANY_TYPES.filter((t) => t !== companyType)]
        : COMPANY_TYPES;
      let lastErr = dcErr;
      for (const ct of types) {
        try {
          const emwebRows = await fetchSheetEmweb(emSymbol, kind, ct);
          if (emwebRows.length) return emwebRows;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    }
    return [];
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
        if (k === "deduct_net_parent") continue;
        if (row[col] != null) rec[k] = num(row[col]);
      }
      const deduct = pickDeductFromRow(row);
      if (deduct != null) rec.deduct_net_parent = deduct;
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

  function annualRevenueIncreasing(profitRows, years) {
    const annual = profitRows
      .filter((p) => p.report_date.endsWith("-12-31") && p.revenue != null)
      .sort((a, b) => (a.report_date > b.report_date ? 1 : -1));
    if (annual.length < years) return false;
    const tail = annual.slice(-years);
    const revs = tail.map((p) => p.revenue);
    for (let i = 0; i < revs.length - 1; i++) {
      if (!(revs[i] < revs[i + 1])) return false;
    }
    return true;
  }

  function passesHardRules(metrics, profitRows, cfg) {
    const reasons = [];
    if (!metrics.length) return { ok: false, reasons: ["无财报数据"] };
    const latest = metrics[metrics.length - 1];
    if (
      latest.current_ratio == null ||
      latest.current_ratio < cfg.min_current_ratio
    ) {
      reasons.push(`流动比率<${cfg.min_current_ratio}`);
    }
    if (!annualRevenueIncreasing(profitRows, cfg.revenue_growth_years)) {
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
    let cap = normalizeMarketCap(row.market_cap);
    if (!cap) cap = await fetchMarketCap(row.code);
    if (!cap || !ttm) return null;
    const pe = cap / ttm;
    if (pe < cfg.pe_min || pe > cfg.pe_max) return null;

    const metrics = buildMetrics(profitRows, balanceRows, cfg.periods);
    if (!metrics.length) return null;

    const hard = passesHardRules(metrics, profitRows, cfg);
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
      const skip = Math.max(0, cfg.skip || 0);
      if (skip === 0) resetUniverseCache();
      const batchNo = Math.floor(skip / (scanLimit || 1)) + 1;
      const batchSize = scanLimit > 0 ? scanLimit : 500;
      let universe = await loadUniverseBatch(batchSize, skip);
      state.total = universe.length;
      state.skip = skip;
      state.batch = batchNo;
      state.poolSize = _universeFiltered.length;
      state.hasMore = universeHasMore(skip, universe.length, batchSize);
      const batchHint =
        skip > 0 ? `（第 ${batchNo} 批，从第 ${skip + 1} 只起）` : "";
      state.message = `本批 ${state.total} 只股票待分析${batchHint}`;
      hooks?.onProgress?.(state);

      if (!universe.length) {
        state.status = "done";
        state.hasMore = false;
        state.message = skip > 0 ? "已无更多股票可扫描" : "股票池为空";
        hooks?.onProgress?.(state);
        return state;
      }

      const concurrency = window.SCREENER_API_BASE
        ? Math.min(cfg.max_workers || 2, 4)
        : 1;
      let idx = 0;
      let fetchErrors = 0;
      let lastFetchError = "";

      async function worker() {
        while (idx < universe.length) {
          if (hooks?.shouldStop?.()) return;
          const i = idx++;
          const row = universe[i];
          await sleep((cfg.request_delay || 0.35) * 1000);
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
          } catch (e) {
            fetchErrors += 1;
            if (!lastFetchError) lastFetchError = e.message || String(e);
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
      let doneMsg = `本批完成：命中 ${state.passed} / ${state.total}${
        state.hasMore ? "，可继续下一批" : ""
      }`;
      if (state.passed === 0 && fetchErrors > state.total * 0.5) {
        doneMsg += `（${fetchErrors} 只拉取财报失败：${lastFetchError}）`;
      } else if (state.passed === 0 && fetchErrors === 0) {
        doneMsg += "（无股票满足 PE/硬性规则，可放宽条件或取消硬性规则）";
      }
      state.message = doneMsg;
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

  global.ScreenerCore = { runScan, exportCsv, resetUniverseCache };
})(window);
