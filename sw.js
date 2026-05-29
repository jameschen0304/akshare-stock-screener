/**
 * 东方财富财报代理（Service Worker）
 * 1) fetch 拦截 /em-proxy
 * 2) postMessage 代理（更可靠）
 */
const SW_VERSION = "v14";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "em-proxy") return;
  const port = event.ports && event.ports[0];
  if (!port) return;

  const task = (async () => {
    try {
      const text = await proxyEastMoney(data.url);
      port.postMessage({ id: data.id, ok: true, text });
    } catch (err) {
      port.postMessage({
        id: data.id,
        ok: false,
        error: String(err.message || err),
      });
    }
  })();

  if (typeof event.waitUntil === "function") {
    try {
      event.waitUntil(task);
    } catch (_) {
      /* 部分浏览器 message 事件不支持 waitUntil */
    }
  }
});

self.addEventListener("fetch", (event) => {
  const reqUrl = new URL(event.request.url);
  if (!reqUrl.pathname.includes("/em-proxy")) return;

  const target = reqUrl.searchParams.get("url");
  if (!target) {
    event.respondWith(jsonResponse({ error: "missing url" }, 400));
    return;
  }

  event.respondWith(
    proxyEastMoney(target)
      .then(
        (body) =>
          new Response(body, {
            headers: { "Content-Type": "application/json" },
          })
      )
      .catch((err) =>
        jsonResponse({ error: String(err.message || err) }, 502)
      )
  );
});

async function proxyEastMoney(target) {
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (_) {
    throw new Error("invalid url");
  }

  if (
    targetUrl.protocol !== "https:" ||
    !targetUrl.hostname.endsWith("eastmoney.com")
  ) {
    throw new Error("host not allowed");
  }

  const referer = targetUrl.hostname.includes("emweb.securities")
    ? "https://emweb.securities.eastmoney.com/"
    : "https://quote.eastmoney.com/";

  const upstream = await fetch(target, {
    method: "GET",
    headers: {
      Referer: referer,
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  const body = await upstream.text();
  if (!upstream.ok) {
    throw new Error("upstream HTTP " + upstream.status);
  }
  const t = body.trim().toLowerCase();
  if (t.startsWith("<!doctype") || t.startsWith("<html")) {
    throw new Error("upstream returned HTML");
  }
  return body;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
