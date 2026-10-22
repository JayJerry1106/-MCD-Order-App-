# 🍔 麦当劳点餐助手（MCD Order App）

一个由 **麦当劳 MCP（mcd-mcp）** 驱动的点餐助手 Web 应用：浏览门店菜单 → 查看商品详情 → 自定义配料/选配轮次 → 加入购物车 → **优惠券优先领取、智能试算选最优** → MCP 实时核价 → 一键下单。界面贴合麦当劳品牌风格（红 #DA291C / 黄 #FFC72C），桌面端与移动端响应式适配，并支持**中文语音交互**输入。

> 本作品参加麦当劳 MCP 开发大赛 · 任务「🍔 用餐 | 把饭点安排明白」

---

## ✨ 功能特性

### 1. 实时定位与门店选择
- **设备定位**：调用浏览器 Geolocation API 获取当前位置，逆向地理编码解析城市与位置关键词（Nominatim / BigDataCloud 多提供商并行竞速，自动降级）
- **距离计算与排序**：按定位关键词经 MCP 搜索附近门店，MCP 返回的 `distance`（米）即用户到店距离，列表按距离由近到远排序，每项显示距离徽章
- **距离雷达图**：SVG 示意图，用户居中、门店按实际距离等比分布在同心圆上（方向为示意，已明确标注）
- **异常处理**：权限申请 / 拒绝（含浏览器设置引导）/ 不可用 / 超时（自动降级网络定位重试）/ 非安全上下文，均有明确提示；任何失败都可回退到**手动城市+关键词搜索**
- **精度诚实标注**：仅解析到区县级、参考点偏差大、最近门店过远时，界面会明确提示距离可能的误差

### 2. 菜单浏览
- 菜单按**早餐 / 午晚餐时段自动切换**（早餐 10:30 前），分类导航 + 商品卡片
- 实时搜索商品名称，输入防抖、局部刷新（不丢失焦点）
- 麦麦省会员入口、今日订单入口

### 3. 商品详情与配料定制
- 商品大图、价格、营养信息（158 项食物营养数据，来自 `list-nutrition-foods`）
- **套餐选配轮次（rounds）**：单选轮次 UI，切换即联动价格估算
- **特调（modification）**：加料/去料 chips 多选，支持数量微调，实时估算差价
- 必选项校验（`minValues=1 && maxValues=1 && values.length===1`）
- 定制草稿支持数量增减，一键加入购物车

### 4. 购物车
- 侧栏（桌面端常驻）/ 底部弹层（移动端）双形态
- 增删改数量、删除行、清空；徽标实时同步
- `localStorage` 持久化，刷新不丢单
- 本地估价与 MCP 核价结果结构一致（单位：分）

### 5. 结算：优惠券优先领取 + 下单（核心流程）
四步结算向导：

| 步骤 | 说明 |
| --- | --- |
| ① 确认订单 | 商品清单、取餐方式（堂食/外带，来自 MCP `takeWayList`）、餐具选择 |
| ② 优惠券优先领取 | 进入结算**第一步即自动**拉取「麦麦省可领券 + 我的券包 + 门店可用券」三路券池，提供**一键领取**（`auto-bind-coupons`） |
| ③ 智能选券 | 逐张券调用 MCP 试算，**自动选择实付最低的一张**；也可手动指定 |
| ④ 核价下单 | MCP `calculate-price` 实时核价，明细逐行展示，确认后 `create-order` 下单，返回取餐码/订单号 |

- 券只能绑定到适用商品（否则 MCP 报 `600012 促销规则不支持该商品`），前端做精确 code 匹配
- 下单为真实 MCP `create-order` 下单，返回取餐码/订单号（需配置 Token；公开站点建议开启只读模式避免被冒用下单）

### 6. 语音交互
- 基于 Web Speech API 的中文语音识别（`zh-CN`）
- 语音指令：`打开菜单/购物车/我的订单/麦麦省`、`搜索XX`、`来一份XX`、`把XX加入购物车`、`去结算`、`定位附近门店`、`打开第N个商品`
- TTS 语音播报操作反馈，识别过程有波形动画与状态提示
- 不支持 Speech API 的浏览器自动隐藏入口

### 7. 响应式与品牌风格
- ≥1024px：顶栏 + 左侧菜单 + 右侧常驻购物车侧栏
- <1024px：底部 Tab 导航、弹层转 bottom sheet、大点击区域
- 麦当劳品牌色贯穿全局，卡片圆角、价格红标、金色拱门意象

---

## 🏗️ 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器（前端 SPA）                     │
│  public/js/                                                 │
│   config.js    常量 / 工具（金额换算、时段判断、转义）          │
│   geo.js       定位引擎：设备定位/权限/逆向地理编码/距离        │
│   api.js       数据层：统一请求 /api/*（服务端代理真实麦当劳 MCP，无演示模式） │
│   state.js     发布订阅 Store + localStorage 持久化           │
│   views.js     菜单/详情/购物车/门店（定位+雷达）/订单视图      │
│   checkout.js  四步结算（券池→领取→智能选券→核价→下单）       │
│   voice.js     语音识别 / TTS / 指令解析                     │
│   app.js       hash 路由 + 全局事件委托 + 启动引导             │
│  public/css/style.css   品牌风格 + 响应式                     │
└───────────────┬───────────────────────────┬─────────────────┘
                │ fetch /api/*              │ 设备定位 + 逆向地理编码
┌───────────────▼───────────────────┐   ┌───▼─────────────────────┐
│   server.js（零依赖 Node ≥18）     │   │ Nominatim / BigDataCloud │
│  · 静态资源托管 public/            │   │ （多提供商并行 + 降级）   │
│  · /api/* → 麦当劳 MCP            │   └─────────────────────────┘
│  · 菜单 60s 缓存（限流 600/min）   │
└───────────────┬───────────────────┘
                │ JSON-RPC tools/call (Bearer Token)
              ┌─▼────────────────┐
              │   麦当劳 MCP 服务 │
              └──────────────────┘
```

### 实时模式设计（全程真实数据，无演示模式）

应用**只运行在实时模式**：前端 `Api.init()` 启动时会探测 `/api/status`，只有后端返回 `mode: live`（即服务端已配置有效的 `MCD_MCP_TOKEN`）才进入正常流程；否则展示「需配置后端」提示页，**绝不回退到任何模拟数据或快照**。菜单、门店、券、核价、下单全部来自真实麦当劳 MCP。

| 状态 | 触发条件 | 行为 |
| --- | --- | --- |
| **实时模式** | `.env` 配置了 `MCD_MCP_TOKEN`（本地）或 Pages Function 配置了同名 Secret（线上） | 真实麦当劳 MCP：真实门店 / 真实菜单 / 真实领券 / 真实核价 / 真实下单 |
| **需配置后端** | 未配置 Token（或服务端不可达 / 超时） | 展示诚实提示页，引导配置后端，不展示任何占位内容 |

> 估价逻辑（`calculate-price`）与本地估算结构保持一致，含 `productOriginalPrice / productPrice / discount / tablewarePrice / takeWayList` 等字段，单位：分。

---

## 🚀 快速开始

```bash
# 1. 安装依赖（无第三方依赖，仅需 Node ≥18）
git clone <your-repo-url>
cd mcd-order-app

# 2.（可选）配置麦当劳 MCP Token，进入实时模式
cp .env.example .env
# 编辑 .env，将 MCD_MCP_TOKEN=在此粘贴... 替换为你的 Token

# 3. 启动
npm start
# 🍔 麦当劳点餐助手已启动: http://localhost:3210
```

- 未配置 Token：启动后展示「需配置后端」提示页（应用不含任何模拟数据，必须配置 Token 才能拉取真实门店/菜单）
- 配置 Token：**实时模式**，菜单/券/核价/下单全部走真实 MCP
- 自定义端口：`PORT=8080 npm start`

### 手机访问

手机与电脑连接同一 Wi-Fi 后，浏览器打开 `http://<电脑局域网IP>:3210`（Windows 用 `ipconfig` 查看 IPv4 地址；首次访问需在防火墙弹窗中允许）。注意：`http://<局域网IP>` 属非安全上下文，浏览器会禁用定位，此时门店选择请用「手动搜索」。

**手机上要体验完整定位功能，请直接访问永久 HTTPS 地址 [https://mcd-order-app.pages.dev](https://mcd-order-app.pages.dev)**（安全上下文，定位可用；手机浏览器打开后可用「添加到主屏幕」获得类 App 体验，项目自带 manifest）。

### 在线部署

项目可发布为任意单端口 HTTP 服务或纯静态站点 + Pages Function（前端在 `/api/status` 不可达时展示「需配置后端」提示，故 `public/` 可直接静态托管，但需配合后端才能拉取真实数据）。**完整方案分析、对比与步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)**，即用型配置在 `deploy/` 目录：

| 文件 | 用途 |
| --- | --- |
| `deploy/wrangler.toml` | Cloudflare Pages（推荐）：`npx wrangler pages deploy public --project-name=mcd-order-app` |
| `deploy/github-pages.yml` | GitHub Pages 工作流（顺带满足大赛公开仓库要求） |
| `deploy/render.yaml` | Render Node 服务（公网真实点餐才需要，注意休眠） |
| `deploy/netlify.toml` / `deploy/vercel.json` | Netlify / Vercel 静态部署 |
| `deploy/basic-auth.md` | 公开暴露实时模式时的三种鉴权方案 |

**🌐 线上永久地址：[https://mcd-order-app.pages.dev](https://mcd-order-app.pages.dev)**（Cloudflare Pages，全球 CDN + 自动 HTTPS，无休眠、不会轮换域名）。`public/` 静态站点需配合 Pages Function + `MCD_MCP_TOKEN` 密钥才能拉取真实门店/菜单；未配置 Token 时展示「需配置后端」提示。

应用已兼容**根域名与子路径**两种托管（GitHub Pages 的 `/<仓库>/` 子路径同样可用，`scripts/static-deploy-test.js` 13/13 验证，覆盖含后端实时渲染 / 无后端诚实提示 / SPA 回退三种形态）。

> **安全提醒**：`.env` 含真实 MCP Token，公开部署前务必移除——否则任何访问者都可使用该账号下单。当前公网站点按用户要求**已放开只读**（`MCD_PUBLIC_READONLY=0`，可真实下单/外送）；若改回只读，在 Pages Function 环境变量中设置 `MCD_PUBLIC_READONLY=1` 即可阻断 `POST /api/order` 与 `/api/coupons/claim`（详见 [DEPLOYMENT.md](DEPLOYMENT.md)）。

### 真实数据来源（实时模式）

- **门店**：基于设备定位或手动输入的「城市 + 位置关键词」，经麦当劳 MCP `query-nearby-stores` 实时搜索附近真实门店，返回门店名称、距离（米）、营业状态（是否在营业时间内）、营业起止时间
- **菜单**：按早餐 / 午晚餐时段自动拉取对应真实菜单
- **套餐详情**：每个套餐的真实选配轮次（rounds）与特调（modification）
- **券 / 核价 / 下单**：均来自真实 MCP（`auto-bind-coupons` / `calculate-price` / `create-order`）

> 想搜索任意城市的真实门店（如济南）：在本机或线上配置 MCP Token 后以实时模式运行，`city + 位置关键词` 直达 MCP；若返回门店均不在目标城市，界面会提示关键词未被正确解析并建议更换关键词。

---

## 🧪 测试

八套自动化测试（jsdom 模拟 + 真实浏览器布局实测，均不触达真实下单）：

```bash
npm test              # 定位 71 + 冒烟 43 + 静态部署 13 + 响应式 28 + 语音诊断 23 + 语音智能体 40 + 麦乐送 59 + 优惠推荐 27 = 303/303
node scripts/live-test.js   # 实时 MCP 链路 + 端到端定位（需本机配置 Token 启动服务端）
node scripts/live-audit.js  # 线上全量审计（38 项检查，产出 live-audit-report.json）
node scripts/live-verify.js # 线上针对性验证（P0/P1/P2 修复回归，9 项）
node scripts/perf-test.js   # 本地性能基线 + 模拟 MCP 延迟对照（3 场景）
```

- **定位专项测试**（`scripts/geo-test.js`）：Haversine/距离格式化、定位成功与缓存复用、权限预检拒绝、回调拒绝、不可用/超时降级重试、逆向地理编码多提供商降级与简体化、门店搜索诚实性（城市不匹配提示）、UI 状态机（定位按钮/成功芯片/异常横幅/手动兜底/雷达图/距离徽章/营业状态徽章/顶栏联动）、语音「定位附近门店」、实时模式不展示任何演示降级说明
- **实时模式冒烟测试**（`scripts/smoke-test.js`）：菜单→详情→定制→购物车→结算（领券/核价/下单）全流程 43/43（含购物车路由防双份渲染、**路由往返回归 6 项回归**：结算/购物车/订单页返回菜单后主区域与推荐区必须重建），全程真实数据驱动
- **静态部署验证**（`scripts/static-deploy-test.js`）：`public/` 纯静态托管 + 子路径 + SPA 回退三种场景，含后端时实时渲染门店与菜单、无后端时展示「需配置后端」且绝不回退演示数据 13/13
- **响应式布局测试**（`scripts/responsive-test.js`）：puppeteer-core 驱动本机 Edge，在 320/375/390/414/768/1440 六种视口验证零横向溢出、购物车无双份、底部导航/侧栏断点行为 28/28（无浏览器自动跳过）
- **语音麦克风诊断测试**（`scripts/voice-test.js`）：`not-allowed` 的精确归因（iframe/WebView/非 HTTPS/权限拒/设备缺失/服务禁用）、跨平台恢复路径、Permissions API 优雅降级 23/23
- **语音智能体测试**（`scripts/voice-agent-test.js`）：唤醒模式门控（未唤醒拦截/唤醒词应答/30 秒对话窗口/唤醒词+指令一体）、onend 自动续听与关闭/损坏时的守卫、NLU 新意图（查询订单/优惠推荐/我的地址/配送时间/送到家）、TTS 播报期间暂停识别防回声、既有意图兼容 40/40
- **麦乐送配送测试**（`scripts/delivery-test.js`）：双实现路由一致性、服务端参数校验（缺地址/beCode 400、手机号格式）、下单口径透传（`orderType=2`+`addressId`+`beCode`、不传 `takeWayCode`）、前端全链路（切模式→选址→切店→菜单→核价→下单→状态查询）、时段快选、**审计回归 13 项**（配送门店四种信封形状兼容/切模式券态重置/麦乐送前置校验禁用与兜底守卫）59/59
- **优惠套餐推荐测试**（`scripts/recommend-test.js`）：启动即推荐（健康/优惠/习惯/实惠四维加权降序）、健康分区分（麦香鱼 vs 麦辣鸡腿汉堡钠含量）、券后节省与「估算」声明、长辈 UI（≤4 卡/徽章/可点击）、语音播报、无营养数据降级、**渲染健壮性 6 项**（refresh 触发 emit/路由重建后自行补渲染/清空复位签名）27/27
- **实时链路测试**（`scripts/live-test.js`）：真实 MCP 的菜单/详情/核价一致性，以及「设备定位 → 逆向地理编码 → MCP 门店搜索 → 距离排序」端到端验证（不触发真实下单；需本机配置 Token 启动服务端）

测试覆盖：启动与模式探测 → 菜单渲染 → 套餐详情轮次 → 定制加入购物车 → roundList 数据组装 → 取餐方式 → 券池合并/领取/智能选券 → MCP 核价明细 → **本地估价与 MCP 核价一致性** → 结算向导各步骤流转。

---

## 📁 目录结构

```
mcd-order-app/
├── server.js               # 零依赖服务端（静态托管 + MCP 代理 + 缓存）
├── functions/api/[[path]].js  # Cloudflare Pages Function：/api/* 代理麦当劳 MCP
├── package.json
├── .env.example            # Token 配置模板
├── .gitignore              # 忽略 .env、node_modules
├── public/
│   ├── index.html          # 应用外壳
│   ├── css/style.css       # 品牌风格 + 响应式
│   ├── js/                 # config/geo/api/state/views/checkout/voice/app
│   └── manifest.webmanifest
├── scripts/
│   ├── fixtures.json        # 测试用真实数据样例（仅测试加载，不随站点发布）
│   ├── geo-test.js          # 实时定位专项测试 71/71
│   ├── smoke-test.js        # 实时模式全流程测试 43/43
│   ├── static-deploy-test.js# 静态部署验证 13/13
│   ├── responsive-test.js   # 响应式布局测试 28/28
│   ├── voice-test.js        # 语音麦克风诊断测试 23/23
│   ├── voice-agent-test.js  # 语音智能体（唤醒/NLU/播报）测试 40/40
│   ├── delivery-test.js     # 麦乐送配送模块测试 59/59
│   ├── recommend-test.js    # 优惠套餐推荐测试 27/27
│   ├── live-test.js         # 实时链路 + 端到端定位测试（需本机 Token）
│   ├── live-audit.js        # 线上全量审计（38 项，产出 live-audit-report.json）
│   ├── live-verify.js       # 线上针对性验证（修复回归 9 项）
│   └── perf-test.js         # 性能基线 + 模拟 MCP 延迟对照（3 场景）
├── README.md               # 本文件
├── CONTEST_DECLARATION.md  # 大赛声明
├── MCP_INTEGRATION.md      # MCP 集成说明
└── workbuddy.md            # 开发过程记录（WorkBuddy 对话）
```

---

## 🔒 安全说明

- `.env`（含 Token）已被 `.gitignore` 忽略，**切勿提交**
- 所有数据均来自真实麦当劳 MCP，应用本身不存储任何门店/用户隐私数据
- 所有 MCP 调用经服务端代理，Token 不暴露给前端
- 定位功能遵循浏览器权限模型：仅在使用者主动点击后发起定位申请，位置缓存于本地 localStorage（5 分钟），不经过服务端上传

---

## 📄 大赛交付物

| 文件 | 说明 |
| --- | --- |
| `README.md` | 项目说明（本文件） |
| `CONTEST_DECLARATION.md` | 大赛参赛声明 |
| `MCP_INTEGRATION.md` | MCP 工具清单、调用时序、字段映射、错误码处理 |
| `workbuddy.md` | 使用 WorkBuddy 的开发对话记录 |
| 源代码 | `server.js` + `public/` + `scripts/` |

---

## 📝 License

MIT
