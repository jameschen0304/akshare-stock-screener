/**
 * GitHub Pages：Service Worker 自动代理财报
 * 本地：运行 run_local.bat → http://127.0.0.1:8765 自动走后端
 */
window.SCREENER_MODE = "browser";
window.SCREENER_API_BASE = window.SCREENER_API_BASE || "";
window.SCREENER_PROXY_BASE = window.SCREENER_PROXY_BASE || "";

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

window.screenerProxyFetch = function screenerProxyFetch(fullUrl) {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) {
      reject(new Error("代理未就绪，请按 F5 刷新页面后再扫描"));
      return;
    }
    const id = ++__proxyMsgId;
    const ch = new MessageChannel();
    const timer = setTimeout(() => {
      reject(new Error("财报代理超时(30s)"));
    }, 30000);

    ch.port1.onmessage = (ev) => {
      clearTimeout(timer);
      const d = ev.data;
      if (!d || d.id !== id) return;
      if (d.ok) resolve(d.text);
      else reject(new Error(d.error || "代理失败"));
    };

    sw.postMessage({ type: "em-proxy", id, url: fullUrl }, [ch.port2]);
  });
};

window.waitScreenerProxy = async function waitScreenerProxy() {
  if (!("serviceWorker" in navigator)) {
    return { ok: false, reason: "浏览器不支持 Service Worker" };
  }
  if (window.SCREENER_API_BASE) {
    return { ok: true, mode: "api" };
  }

  try {
    const swUrl = new URL("sw.js", location.href).href;
    await navigator.serviceWorker.register(swUrl, { scope: "./" });
    await navigator.serviceWorker.ready;

    for (let i = 0; i < 40; i++) {
      if (navigator.serviceWorker.controller) {
        return { ok: true, mode: "sw" };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, reason: "代理未激活，请刷新页面" };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
};

window.__screenerSwReady = window.waitScreenerProxy();
