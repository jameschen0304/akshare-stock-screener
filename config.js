/**
 * GitHub Pages：默认连接 Render 云端后端
 * 本地：run_local.bat → http://127.0.0.1:8765
 */
window.SCREENER_MODE = "browser";
window.SCREENER_API_BASE = window.SCREENER_API_BASE || "";
window.SCREENER_PROXY_BASE = window.SCREENER_PROXY_BASE || "";
window.SCREENER_SW_VERSION = "16";

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
    return;
  }
  if (host.endsWith("github.io") && !window.SCREENER_API_BASE) {
    window.SCREENER_API_BASE = REMOTE_API_CANDIDATES[0] || "";
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
      reject(new Error("代理未就绪，请刷新页面"));
      return;
    }
    const id = ++__proxyMsgId;
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("财报代理超时(25s)")), 25000);
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
  if (window.SCREENER_API_BASE) return { ok: true, mode: "api" };
  if (!("serviceWorker" in navigator)) {
    return { ok: false, reason: "浏览器不支持 Service Worker" };
  }
  try {
    await __registerServiceWorker();
    for (let i = 0; i < 60; i++) {
      if (navigator.serviceWorker.controller) return { ok: true, mode: "sw" };
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, reason: "代理未激活，请 Ctrl+F5 刷新" };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
};

async function __pingApi(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(base + "/api/health", {
      signal: ctrl.signal,
      credentials: "omit",
    });
    return r.ok;
  } finally {
    clearTimeout(timer);
  }
}

window.initScreenerRuntime = async function initScreenerRuntime() {
  const base = (window.SCREENER_API_BASE || "").replace(/\/$/, "");
  if (base) {
    for (let i = 0; i < 3; i++) {
      try {
        if (await __pingApi(base)) {
          return { ok: true, mode: "api", base };
        }
      } catch (_) {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    return {
      ok: true,
      mode: "api",
      base,
      warn: "云端正在唤醒（免费版约 30～60 秒），请开始扫描并耐心等待",
    };
  }

  const st = await window.waitScreenerProxy();
  if (!st.ok) return st;
  return { ok: true, mode: "sw" };
};

window.__screenerInit = window.initScreenerRuntime();

function updateApiBanner() {
  const el = document.getElementById("apiBanner");
  if (!el) return;
  const base = (window.SCREENER_API_BASE || "").replace(/\/$/, "");
  if (base) {
    el.innerHTML =
      '当前使用 <strong>云端扫描</strong>（<a href="' +
      base +
      '" target="_blank" rel="noopener">Render</a>）。' +
      "首次约 1～3 分钟加载股票池；扫描上限建议 30～50。" +
      ' 若失败请用 <a href="' +
      base +
      '">云端直连页</a> 或本机 <code>run_local.bat</code>。';
  }
}

window.__screenerInit.then((st) => {
  updateApiBanner();
  if (st && st.warn) {
    const el = document.getElementById("apiBanner");
    if (el) el.textContent = st.warn;
  }
});
