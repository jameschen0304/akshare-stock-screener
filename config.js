/**
 * GitHub Pages 上财报接口需 CORS 代理或本地后端：
 *
 * 方案 A（推荐）：本地运行
 *   python scripts/stock_screener_web/app.py  → http://127.0.0.1:8765
 *
 * 方案 B：部署 Cloudflare Worker 代理后填写（见 cloudflare-worker/README.md）
 *   window.SCREENER_PROXY_BASE = "https://your-proxy.workers.dev";
 *
 * 方案 C：部署完整后端到 Render 后填写
 *   window.SCREENER_API_BASE = "https://your-app.onrender.com";
 */
window.SCREENER_MODE = "browser";
window.SCREENER_API_BASE = window.SCREENER_API_BASE || "";
window.SCREENER_PROXY_BASE = window.SCREENER_PROXY_BASE || "";
