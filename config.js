/**
 * GitHub Pages 默认浏览器直连东方财富。
 * 若仍报 Failed to fetch，可部署 scripts/stock_screener_web 到 Render 后填写后端地址，例如：
 * window.SCREENER_API_BASE = "https://your-app.onrender.com";
 */
window.SCREENER_MODE = "browser";
window.SCREENER_API_BASE = window.SCREENER_API_BASE || "";
