# 功能更新设计文档（FEATURE_DESIGN.md）

> 面向一次较大功能迭代的**设计说明**：外卖配送、长辈优惠套餐推荐、语音智能体三大模块。
> 每模块明确：业务逻辑 → 数据流程 → 交互细节。所有数据均来自真实麦当劳 MCP，不引入任何模拟数据。
> 依据：`MCP_INTEGRATION.md` + 已确认的 MCP 工具入参（`delivery-query-addresses` / `delivery-create-address` / `delivery-query-stores` / `create-order` / `query-meals` / `calculate-price` / `list-nutrition-foods` / 券类工具）。

---

## 0. 目标与约束

| 目标 | 约束 |
| --- | --- |
| 支持**送餐到家（麦乐送）**：配送地址选择、配送时间设置、配送状态查询 | 严格遵循 MCP 外送参数规则：`orderType=2`、`beType=2`、`beCode`（来自 `delivery-query-stores`）、`addressId`；到店仍为 `orderType=1` + `takeWayCode` |
| 面向**中老年用户**的优惠套餐推荐：结合健康需求与消费习惯，自动匹配折扣套餐并突出优惠 | 仅用真实数据：`list-nutrition-foods`（营养）+ 券池（`query-my-coupons`/`query-store-coupons`）+ 本地订单历史；推荐为客户端计算，不伪造折扣 |
| **语音智能体**：语音唤醒、自然语言交互、语音播报 | 基于既有 Web Speech API（识别 + TTS）；唤醒词在浮层内本地检测，不依赖云端 ASR |
| 放开只读，允许公网真实下单 | 用户显式要求；需知悉公网可下单=任何人可下真实订单的风险 |

**设计原则**：① 到店与外送是两条并行下单链路，共用购物车/券池；② 所有"优惠""配送费"以 MCP 返回为准，前端只做展示与排序，不臆造；③ 长辈友好=大字号、高对比、强引导、可语音播报。

---

## 1. 总体架构与新增接口

```
                 ┌───────────────────────────────────────────┐
   前端 SPA ──►  │  /api/*  （server.js 本地 或 Pages Function） │  ──►  麦当劳 MCP
                 └───────────────────────────────────────────┘
```

新增/扩展的后端路由（`server.js` 与 `functions/api/[[path]].js` **成对新增，保持一致**）：

| 路由 | 方法 | 转发 MCP 工具 | 用途 |
| --- | --- | --- | --- |
| `/api/delivery/addresses` | GET | `delivery-query-addresses` | 查询我的配送地址 |
| `/api/delivery/addresses` | POST | `delivery-create-address` | 新增配送地址 |
| `/api/delivery/stores` | POST | `delivery-query-stores` | 按地址查可配送门店（拿 `beCode`） |
| `/api/order/status` | POST | `query-order`（待实现时确认最终工具名） | 配送/订单状态查询 |
| `/api/order` | POST | `create-order`（**扩展**：透传 `orderType/beType/beCode/addressId/reservationDate/remark`） | 下单（到店/外送统一入口） |
| `/api/menu` `/api/price` | POST | `query-meals`/`calculate-price`（**扩展**：透传 `orderType/beCode`） | 外送场景按 `orderType=2`+`beCode` 取菜单/核价 |

> 现状：`/api/order`、`/api/menu`、`/api/price` 目前固定 `orderType=1, beType=1`。外送需让这些字段可配置。

---

## 2. 模块一：外卖配送（麦乐送 · 送餐到家）

### 2.1 业务逻辑
- 用户在结算第 1 步选择取餐方式：**堂食 / 外带 / 麦乐送（送餐到家）**。
- 选择"麦乐送"后进入外送链路：
  1. **配送地址**：默认拉取 `delivery-query-addresses`；无地址或想用新地址 → `delivery-create-address`（city/contactName/gender/phone/address/addressDetail，phone 校验 11 位 1 开头）。
  2. **可配送门店**：选定地址后调 `delivery-query-stores(addressId, beType=2)`，得到该地址可配送的门店列表（含 `beCode`）。若当前门店不在可配送列表，提示切换为某个可配送门店，并记录其 `beCode`。
  3. **配送时间**：`立即送达`（不传 `reservationDate`）或 `预约送达`（`datetime-local` → 格式化为 `yyyy-MM-dd HH:mm` 的 `reservationDate`）。
  4. **备注**：`remark`（≤50 字，如"无接触配送"）。
  5. **下单**：`create-order` 用 `orderType=2, beType=2, beCode, addressId, items, reservationDate?, remark, needTableware`；**不传** `takeWayCode`。
  6. **配送状态**：下单成功后凭 `orderId` 调 `/api/order/status` 轮询展示（接单/制作中/配送中/已送达等，以 MCP 返回状态为准）。
- 券与核价：外送链路 `query-store-coupons`/`calculate-price` 改用 `orderType=2`+`beCode`（券匹配/核价规则与到店一致，见 MCP_INTEGRATION 3.3）。

### 2.2 数据流程（时序）
```
选「麦乐送」→ GET /api/delivery/addresses
   ├─ 有地址 → 用户选择 addressId ─┐
   └─ 无/新增 → POST /api/delivery/addresses → 返回 addressId ─┘
        ↓
POST /api/delivery/stores {addressId, beType:2} → 可配送门店(含 beCode)
        ↓ 选择/确认门店（记录 beCode）
POST /api/menu {storeCode, orderType:2, beType:2, beCode}        （外送菜单）
        ↓ 加购
POST /api/price {..., orderType:2, beCode}                        （外送核价，含配送费字段若有）
        ↓ 确认
POST /api/order {orderType:2, beType:2, beCode, addressId, items, reservationDate?, remark}
        ↓ 返回 orderId
POST /api/order/status {orderId}   （轮询/手动刷新，展示配送状态）
```

### 2.3 交互细节
- 结算第 1 步"取餐方式"行新增第三张卡 `🚚 麦乐送 · 送餐到家`；选中即展开外送子表单（`#delivery-form`）。
- 地址区：已存地址列表（单选卡，含联系人/电话/地址）+「＋ 新增地址」按钮 → 弹出地址表单（6 字段，手机号实时校验 `^1\d{10}$`）。
- 门店区：若当前门店不可配送该地址，黄色提示条「当前门店不支持配送到该地址」，并列出可配送门店供一键切换。
- 时间区：两个单选「立即送达 / 预约」+ `datetime-local`（仅预约时可用；默认值为当前时间 +1 小时，`min=now`）。
- 下单成功后第 4 步对"麦乐送"额外展示**配送状态卡**（订单号 + 状态 +「刷新状态」按钮 + 配送地址摘要）。
- 长辈友好：外送相关按钮/文字 ≥16px，关键操作（选地址、确认时间）有清晰高亮与语音播报确认。

---

## 3. 模块二：优惠套餐推荐（长辈友好）

### 3.1 业务逻辑
- **输入**（全部真实数据）：菜单 `meals`（含价格/原价/`discountType`）、营养表 `state.nutrition`（`list-nutrition-foods` 解析）、可用券（`query-my-coupons`+`query-store-coupons`）、本地订单历史 `state.orders`。
- **评分（客户端，透明可解释）**：对每个套餐/组合按维度打分并给出理由标签：
  1. **健康适配**（权重最高，面向长辈）：优先低钠（sodium 低）、适量能量、含蛋白质；对高钠/高脂商品降权。理由如「低钠 · 更适合长辈」。
  2. **优惠力度**：有可用券且适用于该商品 / 原价-现价差额 / `discountType` 含「随单购」时按原价估算差额。理由如「用券约省 ¥X」。
  3. **消费习惯**：命中历史常购品类/价位带加权（不追踪敏感信息，仅用本地 orders 的 name/price）。
  4. **性价比**：套餐 vs 单品加总的估算节省。
- **输出**：Top N「长辈优选」推荐列表，每项带 `推荐理由标签` + `优惠徽章`，点击可看详情/一键加购。
- **诚实性**：优惠金额一律标注"估算"，最终以 `calculate-price` 为准；推荐不伪造不存在折扣。

### 3.2 数据流程
```
菜单加载后 → Recommend.refresh()
  输入 = menu.meals + state.nutrition + 券池(loadCoupons 时写入) + state.orders
  计算 = 每商品 score = w1*健康 + w2*优惠 + w3*习惯 + w4*性价比  →  排序取 TopN
  输出 → state.ui.recommend = [{code, name, price, tags[], reason, saveHint}]
菜单视图顶部渲染「🌟 长辈优选 · 为您推荐」横滑卡（突出优惠徽章）
```

### 3.3 交互细节
- 推荐区置于菜单页顶部（`#recommend-strip`），横向卡片：商品图、名称、`¥现价`（划线`¥原价`）、优惠徽章（如「券后约省¥6」「随单购更省」）、健康标签（如「低钠优选」）、「看看/加购」按钮。
- 长辈友好：推荐卡更大、文字更大；对语音可说"有什么推荐"触发播报 Top1 及理由。
- 无营养数据/无券时优雅降级（只按性价比+习惯推荐，不报错）。

---

## 4. 模块三：语音智能体（唤醒 / 自然语言 / 播报）

### 4.1 业务逻辑
- 复用既有 `Voice`（Web Speech `SpeechRecognition` + `speechSynthesis`）与第 2 阶段已修的麦克风精确诊断。
- **语音唤醒**：浮层内提供"唤醒模式"开关；开启后持续识别，检测到唤醒词（如「你好麦麦」「麦麦」）→ 播报「我在，您想吃什么？」并进入指令聆听。浏览器无法系统级后台唤醒，故限定在浮层内（诚实说明）。
- **自然语言交互（NLU）**：在既有意图（点餐/加购/查询）基础上扩展：
  - 配送意图：「送到家/外卖/配送」→ 引导至麦乐送地址选择；「我的地址」→ 播报/列出地址。
  - 推荐意图：「有什么推荐/适合老人的」→ 播报 Top1 推荐及理由。
  - 时间/备注意图：「预约/晚点送」→ 进入预约时间设置。
  - 既有：报菜名 → 打开详情/加购；「结算/下单」→ 进结算；「查询订单/配送到哪了」→ 播报订单状态。
- **语音播报（TTS）**：关键节点播报——唤醒应答、加购确认、推荐结果、下单结果、配送状态；语速放慢、中文 `zh-CN`。

### 4.2 数据流程
```
Voice.open() → prepareMic()（沿用精确环境诊断）
  ├─ 唤醒模式开 → continuous 识别 → 命中唤醒词 → TTS 应答 → 进入指令态
  └─ 直接说指令 → onresult → NLU.parse(text)
        ├─ 命中商品 → openDetail/addToCart + TTS 确认
        ├─ 配送/地址 → 置 checkout.delivery + 路由引导 + TTS
        ├─ 推荐 → Recommend.top1() → TTS 播报
        └─ 订单/配送状态 → Api.getOrderStatus → TTS 播报
浮层内展示识别文本 + 快捷指令 chips（长辈友好，可点可听）
```

### 4.3 交互细节
- 浮层顶部新增「唤醒词：你好麦麦」提示与唤醒开关（`#voice-wake-toggle`）。
- 识别中间结果实时上屏；命中唤醒词时声波动效高亮 + 播报。
- 快捷指令 chips 面向长辈放大：「我要点餐」「送到家」「有什么推荐」「查询订单」。
- 所有语音引导遵循"说一步、做一步、播报一步"，避免长文本。

---

## 5. 只读放开与部署 ✅ 已完成（2026-10-22）

- 用户要求放开只读以支持公网真实下单（含外送）。
- 操作：`wrangler pages secret put MCD_PUBLIC_READONLY` 值改为 `0`（或删除该 secret）→ 重新 `wrangler pages deploy` 使其生效。
- 风险提示（已向用户说明）：公网可写=任何拿到链接的人都可用该账号真实下单/领券。若后续要收紧，改回 `1` 或加 Cloudflare Access。
- 生效验证：`/api/order` 不再返回 403 只读提示。
- **本次执行**：`deploy-local.sh` 已写入 `MCD_PUBLIC_READONLY=0` 并两次部署；线上实测 `POST /api/order/status` 直达 MCP 返回「订单号不存在」（非 403），写门禁已放开。

---

## 6. 实现顺序、测试与验收 ✅ 全部完成

**实现顺序（分模块、每步可回归）**
1. 设计文档（本文）✅
2. 外卖配送：后端路由 → Api → state → 结算 UI → 外送下单/状态 ✅
3. 优惠推荐：Recommend 模块 → 菜单推荐区 ✅
4. 语音智能体：唤醒 + NLU 扩展 + 播报 ✅
5. 每模块补 jsdom 回归测试；`npm test` 保持全绿 ✅ **280/280（八套件：71+38+13+28+23+40+46+21）**
6. 放开只读 + 重新部署 + 线上验证 ✅

**验收标准**
- 到店与外送两条链路均可完成「选店/选品 → 券 → 核价 → 下单」；外送含地址、时间、状态。✅
- 长辈推荐区展示真实优惠/健康标签，金额标注"估算"。✅
- 语音可唤醒、可点餐、可引导外送、可播报结果。✅
- `npm test` 全绿；线上 `mcd-order-app.pages.dev` 与本地 `localhost:3210` 行为一致。✅

**公网实测（2026-10-22）**：`/api/status` → live；门店查询返回北京建外SOHO 等真实门店；配送地址 2 个；济南黄屯小区地址 → 3 家配送门店（含 beCode 与时段选项）；`orderType=2` 菜单 94 个餐品；配送核价返回配送费 ¥6。

---

## 7. 需要向用户确认/知悉的点
1. **公网可下单风险**：放开只读后链接外泄=可被他人真实下单。是否接受（或改用 Cloudflare Access 密码保护写操作）？（用户已确认放开，风险已知晓）
2. **配送地址真实性**：`delivery-create-address` 会写入真实账号地址；演示用可新建一个测试地址。
3. **预约时间格式**：`reservationDate=yyyy-MM-dd HH:mm`，前端用 `datetime-local` 转换。
4. 订单状态查询的最终 MCP 工具名以实现时确认为准（`query-order` 系列）。已确认为 `query-order`。
5. **系统级唤醒不可达**：浏览器无法在浮层外监听唤醒词，「唤醒模式」仅在语音浮层打开期间生效（UI 已如实标注）。
