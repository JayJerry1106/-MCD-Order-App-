# 点餐应用运维手册（app-runbook）

麦当劳点餐助手 Web 应用的位置、启动、访问、部署与排障。应用本身零第三方依赖（Node ≥18）。

## 1. 应用位置

| 项 | 值 |
| --- | --- |
| 主项目目录 | `D:\下载\2026-10-21-09-25-55\mcd-order-app` |
| 发布副本（无 Token，演示模式） | `D:\下载\2026-10-21-09-25-55\mcd-order-app-publish` |
| Token 配置 | 主项目 `.env` 的 `MCD_MCP_TOKEN`（已被 .gitignore，严禁外泄/上传） |
| 默认端口 | 3210（`PORT` 环境变量可改） |

目录若被移动，用 Glob 搜索 `**/mcd-order-app/server.js` 定位。

## 2. 启动

```bash
cd <项目目录>
npm start            # 或 node server.js
```

启动日志会声明运行模式：

- **实时模式**：`.env` 配置了有效 Token → 菜单/券/核价/下单全部走真实麦当劳 MCP，**下单产生真实订单**
- **演示模式**：未配置 Token → 前端使用内置真实数据快照（`public/data/snapshot.json`，5 门店 / 190 项菜单 / 9 套餐详情 / 9 券 / 158 条营养），下单为模拟

切换模式的方法：增删 `.env` 中的 `MCD_MCP_TOKEN` 后重启服务。

## 3. 访问方式

| 场景 | 地址 | 说明 |
| --- | --- | --- |
| 本机 | http://localhost:3210 | 完整功能（实时模式需 Token） |
| 手机（同一 Wi-Fi） | http://<电脑局域网IP>:3210 | Windows 用 `ipconfig` 查 IPv4；首次访问需在防火墙弹窗点「允许」；**http 非安全上下文，浏览器禁用定位**，门店选择改用手动搜索 |
| **公网永久 HTTPS（推荐）** | **https://mcd-order-app.pages.dev** | Cloudflare Pages 部署，全球 CDN、自动 HTTPS、无休眠不轮换；静态托管 = 演示模式，**手机上定位功能完整可用** |

## 4. 公开部署（永久链接）

**已上线：https://mcd-order-app.pages.dev**（Cloudflare Pages 项目 `mcd-order-app`，2026-10-21 部署，账号 Prodjaymade@gmail.com）。

更新线上内容的流程（改完 `public/` 后）：

```bash
cd <项目目录>
npx wrangler pages deploy public --project-name=mcd-order-app --branch=main --commit-dirty=true
```

注意：Cloudflare Pages 对未知路径返回 200 + `index.html`（SPA 回退），不是 404；前端 `api.js` 的 `init()` 已显式校验 `res.ok` 与 content-type 来判定服务端不可用，`scripts/static-deploy-test.js` 的「SPA回退」场景覆盖此行为。

完整方案分析见项目根目录 **`DEPLOYMENT.md`**（方案对比/步骤/验证/鉴权/域名绑定）。要点：

1. **公网永久链接 = 演示模式**。技术前提已验证：把 `public/` 当纯静态站点托管时，前端探测 `/api/status` 失败即自动降级演示模式，全流程可用（`node scripts/static-deploy-test.js`，16/16，覆盖根域名/子路径/SPA 回退三种托管形态）。
2. **部署路径零代码修改**：应用已支持根域名与子路径两种托管（`config.js` 的 `BASE_PATH/appUrl()` + 相对资源路径），GitHub Pages 项目站点（`/<仓库>/`）同样兼容。
3. 即用型配置在项目 `deploy/`：`wrangler.toml`（Cloudflare Pages，推荐）、`github-pages.yml`（GitHub Pages，顺带满足大赛公开仓库要求）、`render.yaml`（Node 服务）、`netlify.toml`、`vercel.json`、`basic-auth.md`（实时模式公开时的鉴权）。
4. **安全红线不变**：含 Token 的 `.env` 严禁上传；公开暴露实时模式必须按 `deploy/basic-auth.md` 加鉴权（或 CF Access）。
5. 临时隧道（localhost.run）仅限试用：免费档域名定期轮换、会超时断开，**不要**当作长期方案（历史隧道 URL 已全部失效）。
6. WorkBuddy 客户端若有「发布为应用」能力（设置—数据管理—发布的应用）可优先使用。

## 5. 测试

```bash
npm test               # 定位专项 65/65 + 演示全流程冒烟 38/38 + 静态部署 16/16 + 响应式布局 22/22
npm run test:live      # 实时 MCP 链路 + 端到端定位 18/18（需 Token，不触发真实下单）
```

测试用 jsdom（开发依赖，位于 `C:\Users\86181\.workbuddy\binaries\node\workspace\node_modules`）；响应式测试（`scripts/responsive-test.js`）用 puppeteer-core 驱动本机 Edge/Chrome，无浏览器时自动跳过，不影响其他套件。全面审查报告见项目根 `SITE_AUDIT.md`。

## 6. 常见排障

| 现象 | 原因与处理 |
| --- | --- |
| 门店/菜单加载失败 | Token 失效 → 重新申请；或时段不符（早餐 10:30 前只能点早餐商品，报 60006） |
| 搜索济南返回北京门店（pages.dev 链接） | **不是 bug，是演示模式**：公网静态链接无 Token，只能返回内置的北京·国贸快照（界面已明确标注「演示模式仅内置…快照」）。要搜真实门店：本机 `npm start`（实时模式，city+关键词直达 MCP，实测济南搜索正常返回金牛大厦等 5 家） |
| 实时模式搜索提示「结果均不在某城市」 | 关键词未被 MCP 正确解析（回退默认参考点），换更精确关键词（路名/商场名） |
| 手机连不上局域网地址 | 防火墙未放行；或手机与电脑不在同一网段 |
| 手机定位按钮报「环境不安全」 | http 访问所致，改用 HTTPS 域名（永久地址 https://mcd-order-app.pages.dev） |
| 实时模式菜单 `data-code` 为空 | 已知行为：MCP meals 映射不含 code 字段，`api.js` 已做归一化补全；若改代码勿删这段逻辑 |
| 演示模式想重新抓数据 | 配置 Token 后 `npm run snapshot`（`reservationDate` 传今天 12:00 可拉午晚餐菜单） |

## 7. 语音指令（应用内）

打开菜单/购物车/我的订单/麦麦省、`搜索XX`、`来一份XX`、`把XX加入购物车`、`去结算`、`帮我领券`、`定位附近门店`、`打开第N个商品`、`清空购物车`。
