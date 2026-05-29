/**
 * 模式说明：
 * - GitHub Pages：自动注册 Service Worker 代理财报（无需配置）
 * - 本地 python app.py（8765 端口）：自动走后端 API
 * - 可选：window.SCREENER_PROXY_BASE = Cloudflare Worker 地址
 */
window.SCREENER_MODE = "browser";
window.SCREENER_API_BASE = window.SCREENER_API_BASE || "";
window.SCREENER_PROXY_BASE = window.SCREENER_PROXY_BASE || "";

(function initScreenerEnv() {
  const host = location.hostname;
  const port = location.port;
  if (
    (host === "127.0.0.1" || host === "localhost") &&
    (port === "8765" || port === "")
  ) {
    window.SCREENER_API_BASE = window.SCREENER_API_BASE || location.origin;
  }
})();

window.__screenerSwReady = (async function registerScreenerSw() {
  if (!("serviceWorker" in navigator)) return false;
  if (window.SCREENER_API_BASE) return false;
  if (location.protocol !== "https:" && location.protocol !== "http:") {
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.register(
      new URL("sw.js", location.href).href,
      { scope: "./" }
    );
    if (reg.installing) {
      await new Promise((resolve) => {
        reg.installing.addEventListener("statechange", function () {
          if (this.state === "activated") resolve();
        });
      });
    }
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => setTimeout(r, 300));
    }
    return true;
  } catch (e) {
    console.warn("Service Worker 注册失败", e);
    return false;
  }
})();
