/**

 * GitHub Pages：Service Worker 自动代理财报

 * 本地：运行 run_local.bat → http://127.0.0.1:8765 自动走后端

 */

window.SCREENER_MODE = "browser";

window.SCREENER_API_BASE = window.SCREENER_API_BASE || "";

window.SCREENER_PROXY_BASE = window.SCREENER_PROXY_BASE || "";

window.SCREENER_SW_VERSION = "14";



/** 可选：部署 Render 后在此填写，Pages 会自动探测并优先使用 */

const REMOTE_API_CANDIDATES = [

  "https://akshare-stock-screener.onrender.com",

];



(function initScreenerEnv() {

  const host = location.hostname;

  const port = location.port;

  if (

    (host === "127.0.0.1" || host === "localhost") &&

    port === "8765"

  ) {

    window.SCREENER_API_BASE = window.SCREENER_API_BASE || location.origin;

  }

})();



let __proxyMsgId = 0;

let __proxyQueue = Promise.resolve();



function __enqueueProxy(task) {

  const run = __proxyQueue.then(task, task);

  __proxyQueue = run.catch(() => {});

  return run;

}



function __proxyViaMessage(fullUrl) {

  return new Promise((resolve, reject) => {

    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;

    if (!sw) {

      reject(new Error("代理未就绪，请按 F5 刷新页面后再扫描"));

      return;

    }

    const id = ++__proxyMsgId;

    const ch = new MessageChannel();

    const timer = setTimeout(() => {

      reject(new Error("财报代理超时(25s)"));

    }, 25000);



    ch.port1.onmessage = (ev) => {

      clearTimeout(timer);

      const d = ev.data;

      if (!d || d.id !== id) return;

      if (d.ok) resolve(d.text);

      else reject(new Error(d.error || "代理失败"));

    };



    sw.postMessage({ type: "em-proxy", id, url: fullUrl }, [ch.port2]);

  });

}



window.screenerProxyFetch = function screenerProxyFetch(fullUrl) {

  return __enqueueProxy(() => __proxyViaMessage(fullUrl));

};



async function __registerServiceWorker() {

  if (!("serviceWorker" in navigator)) return null;

  const swUrl =

    new URL("sw.js", location.href).href +

    "?v=" +

    encodeURIComponent(window.SCREENER_SW_VERSION);

  if (window.__screenerSwRegister) {

    await window.__screenerSwRegister;

  } else {

    window.__screenerSwRegister = navigator.serviceWorker.register(swUrl, {

      scope: "./",

      updateViaCache: "none",

    });

    await window.__screenerSwRegister;

  }

  await navigator.serviceWorker.ready;

  return navigator.serviceWorker.controller;

}



window.waitScreenerProxy = async function waitScreenerProxy() {

  if (!("serviceWorker" in navigator)) {

    return { ok: false, reason: "浏览器不支持 Service Worker" };

  }

  if (window.SCREENER_API_BASE) {

    return { ok: true, mode: "api" };

  }



  try {

    await __registerServiceWorker();



    for (let i = 0; i < 60; i++) {

      if (navigator.serviceWorker.controller) {

        return { ok: true, mode: "sw" };

      }

      await new Promise((r) => setTimeout(r, 150));

    }

    return { ok: false, reason: "代理未激活，请刷新页面（Ctrl+F5）" };

  } catch (e) {

    return { ok: false, reason: e.message || String(e) };

  }

};



window.probeFinanceProxy = async function probeFinanceProxy() {

  if (window.SCREENER_API_BASE) return { ok: true, mode: "api" };



  const testUrl =

    "https://datacenter.eastmoney.com/securities/api/data/get" +

    "?type=RPT_F10_FINANCE_GINCOME&sty=APP_F10_GINCOME" +

    "&filter=(SECUCODE%3D%22600519.SH%22)&p=1&ps=2&sr=-1&st=REPORT_DATE" +

    "&source=HSF10&client=PC";



  const text = await window.screenerProxyFetch(testUrl);

  let data;

  try {

    data = JSON.parse(text);

  } catch (e) {

    throw new Error("代理返回非 JSON: " + (e.message || e));

  }

  if (data && data.success === false) {

    throw new Error(data.message || "数据中心拒绝请求");

  }

  if (!data?.result?.data?.length) {

    throw new Error("代理探测失败：无财报数据");

  }

  return { ok: true, mode: "sw" };

};



async function autoPickRemoteApi() {

  if (window.SCREENER_API_BASE) return false;

  const onPages =

    location.protocol === "https:" &&

    location.hostname.endsWith("github.io");

  if (!onPages) return false;



  for (const base of REMOTE_API_CANDIDATES) {

    if (!base) continue;

    try {

      const ctrl = new AbortController();

      const timer = setTimeout(() => ctrl.abort(), 45000);

      const r = await fetch(base.replace(/\/$/, "") + "/api/health", {

        signal: ctrl.signal,

        credentials: "omit",

      });

      clearTimeout(timer);

      if (r.ok) {

        window.SCREENER_API_BASE = base.replace(/\/$/, "");

        return true;

      }

    } catch (_) {

      /* try next */

    }

  }

  return false;

}



window.initScreenerRuntime = async function initScreenerRuntime() {

  await autoPickRemoteApi();

  if (window.SCREENER_API_BASE) {

    return { ok: true, mode: "api", base: window.SCREENER_API_BASE };

  }

  const st = await window.waitScreenerProxy();

  if (!st.ok) return st;

  try {

    await window.probeFinanceProxy();

    return { ok: true, mode: "sw" };

  } catch (e) {

    return {

      ok: false,

      reason:

        (e.message || String(e)) +

        "。请 Ctrl+F5 刷新，或运行 scripts/stock_screener_web/run_local.bat",

    };

  }

};



window.__screenerInit = window.initScreenerRuntime();


