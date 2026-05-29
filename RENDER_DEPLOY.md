# Render 云端后端部署

GitHub Pages 只负责前端；财报扫描需要 Render 上的 Python 后端。

## 一键部署（约 2 分钟）

1. 打开（或点击下方链接）  
   **https://render.com/deploy?repo=https://github.com/jameschen0304/akshare**
2. 用 GitHub 登录 Render，授权访问仓库 `jameschen0304/akshare`。
3. 确认服务名 **`akshare-stock-screener`**，计划选 **Free**。
4. 点击 **Apply** / **Deploy**，等待构建完成（首次约 5～15 分钟）。
5. 验证：浏览器访问  
   `https://akshare-stock-screener.onrender.com/api/health`  
   应返回 `{"status":"ok"}`。

## 与 GitHub Pages 联动

`docs/stock-screener/config.js` 已配置自动探测：

```text
https://akshare-stock-screener.onrender.com
```

部署成功后，打开 https://jameschen0304.github.io/akshare-stock-screener/ 并 **Ctrl+F5**，页面会显示「已连接云端后端」。

若 Render 服务名不同，请把 `config.js` 里 `REMOTE_API_CANDIDATES` 改成你的地址后推到 `akshare-stock-screener` 仓库。

## 仓库要求

- 部署源：**`jameschen0304/akshare`**（含根目录 `render.yaml`）
- 不是 `akshare-stock-screener`（仅静态页）

## 免费版说明

- 约 15 分钟无访问会休眠，首次请求可能需等待 30～60 秒。
- 扫描比本机慢，大批量建议仍用 `run_local.bat`。

## 直接访问 Render 版网页

部署完成后也可直接用：  
https://akshare-stock-screener.onrender.com
