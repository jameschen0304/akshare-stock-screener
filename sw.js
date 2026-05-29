/**
 * 同域代理东方财富财报接口，绕过浏览器 CORS（适用于 GitHub Pages）
 * 页面请求 ./em-proxy?url=ENCODED ，由本 SW 转发到 eastmoney.com
 */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const reqUrl = new URL(event.request.url);
  if (!reqUrl.pathname.endsWith("/em-proxy")) return;

  const target = reqUrl.searchParams.get("url");
  if (!target) {
    event.respondWith(textResponse('{"error":"missing url"}', 400));
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (_) {
    event.respondWith(textResponse('{"error":"invalid url"}', 400));
    return;
  }

  if (
    targetUrl.protocol !== "https:" ||
    !targetUrl.hostname.endsWith("eastmoney.com")
  ) {
    event.respondWith(textResponse('{"error":"host not allowed"}', 403));
    return;
  }

  const referer = targetUrl.hostname.includes("emweb.securities")
    ? "https://emweb.securities.eastmoney.com/"
    : "https://quote.eastmoney.com/";

  event.respondWith(
    fetch(target, {
      method: "GET",
      headers: {
        Referer: referer,
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    })
      .then(async (upstream) => {
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: {
            "Content-Type":
              upstream.headers.get("Content-Type") ||
              "application/json; charset=utf-8",
          },
        });
      })
      .catch((err) =>
        textResponse(
          JSON.stringify({ error: String(err.message || err) }),
          502
        )
      )
  );
});

function textResponse(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
