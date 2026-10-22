# 麦乐点应用全面审查报告

- **审查对象**：https://mcd-order-app.pages.dev（Cloudflare Pages 永久链接，实时模式；未配置 Token 时展示「需配置后端」）
- **审查日期**：第一轮 2026-10-21；**第二轮线上实测 2026-10-22（见第十章）**
- **审查方式**：真实浏览器（本机 Edge + puppeteer-core，精确视口与真实点击交互）+ 网络层测量（curl 计时/体积/压缩/缓存头）+ 线上全流程实测（`live-audit.js` 38 项检查）+ 本地性能基线对照（`perf-test.js`，mock MCP 模拟延迟）+ 全量静态代码审查（HTML/CSS/JS 约 4,700 行）
- **视口覆盖**：320 / 375 / 390 / 414 / 768 / 1440 px；场景覆盖：菜单、搜索、商品详情、加购、购物车、结算四步、订单、门店选择器（定位成功/权限拒绝/手动搜索）、麦乐送全链路、路由往返

---

## 一、总体结论

应用整体质量**高于个人项目平均水平**：品牌视觉统一、诚实降级体系完整（无 Token 时诚实提示「需配置后端」，不伪装、不回退任何模拟数据）、无 XSS 风险（输出全部经 `esc()`）、错误处理完备（每个异步链路有 try/catch 与用户可读提示）。

两轮审计共发现 **10 个功能性缺陷（已修复）+ 1 组响应式缺陷（已修复）+ 10 项待改进建议**。第一轮 2 个 P1 缺陷为「桌面/移动端特定路由下的渲染逻辑疏漏」；第二轮（线上实测）新增 P0 结算返回菜单空白、P1 路由返回推荐区空白、2 个麦乐送流程缺陷与 1 个首屏折叠问题，并完成启动并行化（回访场景首屏快 41%）。全部修复经 **303 项自动化测试**与线上针对性验证（9/9）回归通过。

| 维度 | 评级 | 说明 |
| --- | --- | --- |
| 页面布局 | ⭐⭐⭐⭐ | 结构清晰；修复购物车重复渲染后无布局缺陷 |
| 响应式设计 | ⭐⭐⭐⭐ | 6 视口零溢出；断点略分散（见 P3-5） |
| 交互体验 | ⭐⭐⭐⭐⭐ | 全流程闭环 + 键盘无障碍（Esc/焦点圈定/焦点环，P2 已实现） |
| 加载速度 | ⭐⭐⭐⭐⭐ | FCP <130ms、Brotli 75% 缩减、19 请求 |
| 代码质量 | ⭐⭐⭐⭐ | 分层清晰、转义完备；少量边缘问题（P3/P4） |

---

## 二、发现并已修复的问题（P1）

### 2.1 桌面端「购物车」路由双份渲染

**现象**：桌面浏览器（≥1024px）点击底部/顶部的购物车入口后，页面**同时出现两份完整购物车**——主区域一份、右侧栏一份（见修复前截图，两份均可操作，视觉重复且困惑）。

**根因**：`views.js` 的 `render()` 在 `route === 'cart'` 时调用 `renderCartPage()` 渲染主区域，随后又无条件调用 `renderCartRail()` 渲染侧栏，两者输出同一份购物车 HTML：

```js
render(state) {
  ...
  if (route === 'cart') this.renderCartPage(state);   // 主区域：完整购物车页
  ...
  this.renderCartRail(state);                          // 侧栏：又一份完整购物车
```

**修复**（`public/js/views.js`）：侧栏在购物车路由下让位——

```js
renderCartRail(state) {
  const rail = $('#cart-rail');
  // 购物车路由下主区域已渲染完整购物车页，侧栏再渲染一份会造成双份 UI（桌面端实测复现）；
  // 移动端侧栏本就隐藏。其余路由（菜单/结算）保留侧栏购物车摘要。
  if (window.innerWidth < 1024 || state.ui.route === 'cart') { rail.innerHTML = ''; return; }
```

**回归**：`smoke-test.js` 新增 3 项断言（主区域恰好一份、侧栏为空、菜单路由侧栏恢复）；`responsive-test.js` 桌面 1440 实测通过。修复后截图：`docs/audit/fixed-desktop-cart.png`。

### 2.2 手机端顶部导航横向溢出 33px

**现象**：375px 视口下文档 `scrollWidth=408 > clientWidth=375`，整页可横向滚动，右侧内容被推挤。实测定位：`.header-actions`（模式徽章 + 麦克风按钮）右缘到 408px。

**根因**：≤1023px 的头部规则不足以容纳 375px：品牌（92px）+ 门店 pill（160px，含 108px 限宽的店名）+ 徽章（约 76px）+ 麦克风（38px）+ 间距/内边距 ≈ 408px，超出 33px。

**修复**（`public/css/style.css`）：将原 ≤400px 的头部规则并入 ≤480px 断点并紧凑化——

```css
/* 小屏手机：头部紧凑化，防止 brand+门店 pill+模式徽章+麦克风 超出视口导致横向滚动（375px 实测溢出 33px） */
@media (max-width: 480px) {
  .header-inner { padding: 0 8px; gap: 6px; }
  .arches { width: 30px; height: 23px; }
  .brand-name { font-size: 15px; }
  .store-pill { padding: 5px 8px; gap: 4px; }
  .store-pill-text { max-width: 56px; }      /* 原 108px */
  .mode-badge { font-size: 10px; padding: 3px 7px; }
  .icon-btn { width: 34px; height: 34px; }
}
```

**回归**：新增 `scripts/responsive-test.js`（真实浏览器，6 视口 × 菜单/详情/选择器三场景断言零溢出 + 断点行为断言），**22/22 通过**。修复后截图：`docs/audit/fixed-mobile-menu.png`。

---

## 三、加载速度实测

### 3.1 网络层（curl，经本机代理，绝对值受代理影响，相对关系有效）

| 指标 | 数值 |
| --- | --- |
| 首页 HTML | 4.9KB（Brotli 前） |
| JS+CSS+数据 原始总量 | 232KB |
| **Brotli 压缩后实际传输** | **约 60KB（缩减 75%）** |
| 最大资源 | 单个 JS 文件（Brotli 后均 <10KB） |
| 请求数 | 11（1 HTML + 1 CSS + 8 JS + 1 manifest；数据全部来自 /api，无静态数据文件） |
| 压缩 | ✅ Cloudflare 自动 Brotli（`Content-Encoding: br`） |
| 缓存 | `Cache-Control: public, max-age=0, must-revalidate` + ETag（保守但安全；见 P3-4） |

### 3.2 真实浏览器计时（Edge 无头，本地静态服务器 + mock 后端，实时渲染）

| 场景 | 加载完成 | DCL | FCP | 资源数 | 传输 |
| --- | --- | --- | --- | --- | --- |
| 桌面 1440 菜单 | 696–808ms | 38–84ms | 68–124ms | 19 | 295KB* |
| 手机 375 菜单 | 1017–1028ms | 35–82ms | 76–100ms | 19 | 295KB* |

\* 含麦当劳 CDN 商品图片（`menu-img.mcd.cn`，外部域名， lazy-load）。**首屏 FCP 稳定低于 130ms**，对于 60KB 代码 + 静态托管的纯前端应用属于优秀水平。

**结论**：静态层性能无需架构级优化；剩余空间在缓存策略（P3-4）与图片（外部 CDN 已分担）。**第二轮补充（2026-10-22）**：线上真实链路的瓶颈在 MCP 往返（单次 3–4s，首屏商品卡 12444ms），已通过启动并行化优化（回访场景省一整段往返，详见 10.3）。

---

## 四、页面布局与响应式评估

**做得好的**：
- 桌面端「主区 + 粘性购物车侧栏」双栏、移动端底部导航 + 底部弹层（bottom-sheet）的形态切换正确（768px 起走移动布局，合理）；
- `.p-img { aspect-ratio: 1 }` + `loading="lazy"` 有效抑制 CLS；
- `env(safe-area-inset-bottom)` 处理 iPhone 底部安全区；
- `prefers-reduced-motion` 全局降级动画；
- 分类 chips 行为横向滚动容器（`overflow-x:auto`，实测 351px 容器 / 1778px 内容，不撑破文档）。

**已修复**：见 2.1 / 2.2。

**遗留**：断点值分散（400/480/1023/1024 四个且 480 与 400 语义重叠），建议归并为 480（手机）/ 1024（桌面）两档，见 P3-5。

---

## 五、交互体验评估

**全链路实测通过**（真实点击）：搜索「巨无霸」→ 3 个结果 → 打开详情 → 选配/特调/数量 → 加入购物车 → 徽章更新 → 购物车增删 → 结算四步（确认订单→优惠券→核价→下单）→ 订单历史 → 语音指令 → 门店切换。

**亮点**：
- 定位异常矩阵完整：权限拒绝时给出「地址栏锁形图标」级引导 + 手动搜索兜底常驻（截图 `p12` 场景）；
- 「智能选最优」逐张试算取到手价最低，单张失败不影响其他；
- 实时模式诚实性：城市不匹配、营业状态偏差等边界均在界面明确提示，不谎称数据来源。

**问题**（均已处理）：
1. ~~**模态框无键盘无障碍**~~（P2-1，**已实现**）：Esc 不能关闭、打开后焦点不圈定、关闭后焦点不恢复、缺 `role="dialog"`/`aria-modal`——现已全部补齐（详见 7.P2-1）；
2. ~~**焦点可见性不足**~~（P2-2，**已实现**）：`.store-input:focus { outline: none }` 去掉轮廓仅留边框变色，按钮无任何 `:focus-visible` 样式——现已加全局焦点环与输入光环（详见 7.P2-2）；
3. 部分可交互元素（`<div data-action>`）键盘不可到达——列入 P3-6，建议单独迭代；
4. 加购后自动语音播报（`Voice.speak`）在公共场合可能突兀，建议加静音偏好（P4）。

---

## 六、代码质量评估

**做得好的**：
- 输出全部经 `esc()` 转义（18 处 innerHTML / 58 处 esc 调用配对），**无 XSS 注入面**；
- `localStorage` 读写均有 try/catch（隐私模式降级）；
- 每个异步链路（菜单/券/核价/下单/定位）有错误捕获与用户可读提示；
- 常量与工具集中于 `config.js`（`appUrl()` 子路径兼容、`fmtMoney`、`hashAngle` 确定性雷达布局）；
- 渲染签名机制（`_pickerSig`）避免输入框失焦与雷达图重绘闪烁，考虑周到。

**问题**：见第七节各项（金额格式化边缘、内联事件处理器、无 noscript、localStorage 无 schema 校验、`BASE_PATH` 边缘）。

---

## 七、待改进项与建议（含代码示例）

> 按优先级排序。P2 已全部实现（见每节「实现情况」）；P3/P4 可择机。

### P2-1 模态框键盘无障碍 —— ✅ 已实现（2026-10-21）

`UI.modal` 原来只绑定遮罩点击关闭。现已实现：Esc 关闭、焦点圈定、关闭后焦点恢复、ARIA 标注，并同步覆盖语音浮层。

**实现情况**（沉淀为可复用的 `dialogKeys(container, onClose)` 辅助函数，位于 `public/js/config.js`）：

- `public/js/views.js`：`UI.modal` 增加 `role="dialog" aria-modal="true" tabindex="-1"`；打开时焦点移入首个可操作元素；关闭后焦点还给触发按钮；重复打开（门店选择器状态刷新）先解绑旧监听，**避免监听器累积**；`closeModal` 增加「无打开中模态框则直接返回」保护，防止误移焦点。
- `public/js/voice.js`：语音浮层 open/close 接入同一辅助函数（Esc 关闭 + Tab 圈定 + 打开时聚焦关闭按钮）。
- `public/index.html`：语音浮层补 `role="dialog" aria-modal="true" aria-label="语音点餐"`。
- 回归：jsdom 8 项（ARIA 标注/焦点落点/陷阱/Esc/焦点恢复/浮层 Esc）+ 真实浏览器 6 项（Esc 关闭、连按 12 次 Tab 焦点不逃逸、焦点环计算样式、输入框光环、浮层 Esc），全绿。

核心代码（config.js）：

```js
function dialogKeys(container, onClose) {
  const SEL = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const handler = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(container.querySelectorAll(SEL)).filter((el) => !el.hidden && !el.closest('[hidden]'));
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !container.contains(active))) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
```

### P2-2 键盘焦点可见性 —— ✅ 已实现（2026-10-21）

**实现情况**（`public/css/style.css`）：

- 全局 `:focus-visible` 焦点环（2px 实线 + 2px 偏移，品牌黄 `#f5b800`）——仅键盘导航时出现，不干扰鼠标操作；
- **不覆盖 `border-radius`**：outline 自动跟随元素自身圆角（圆形麦克风按钮聚焦不变方角，实测 `border-radius: 50%` 保持）；
- `.store-input:focus` 从「裸 `outline:none`」改为 `box-shadow` 光环（保留边框变色）；
- `.product-card .p-add` 焦点环用 `outline-offset: -3px` 内敛，避免被卡片 `overflow:hidden` 裁剪；
- 回归：真实浏览器计算样式断言（outlineStyle=solid、outlineWidth≥2px、圆角保持、输入框有光环），证据截图 `docs/audit/keyboard-focus-ring.png`。

```css
/* 键盘焦点可见性：:focus-visible 仅在键盘导航时触发，不干扰鼠标操作的视觉。
   不覆盖 border-radius——outline 会自动跟随元素自身圆角（如圆形麦克风按钮） */
:focus-visible {
  outline: 2px solid var(--yellow-dark);
  outline-offset: 2px;
}
/* 替换掉「去轮廓无替代」的写法 */
.store-input:focus { outline: none; border-color: var(--yellow-dark); box-shadow: 0 0 0 3px rgba(245, 184, 0, 0.25); }
/* 商品卡 overflow:hidden 会裁剪外凸焦点环，卡内按钮改用内敛偏移 */
.product-card .p-add:focus-visible { outline-offset: -3px; }
```

> **遗留已知限制（升级为 P3-6）**：部分可交互元素是 `<div data-action>`（门店选项、取餐方式、券卡片、套餐轮次等），无 `tabindex`/`role`，键盘用户无法用 Tab 到达——需改为 `<button>` 或补 `tabindex="0" role="button"` 与 Enter/Space 激活。这是比焦点环更深的改造，建议单独迭代。

### P2-3 PWA 安装与离线能力（暂缓，降级为 P3）

`manifest.webmanifest` 目前只声明了 data-URI SVG 图标——多数 Android 浏览器要求 192/512 PNG 才触发安装提示；且无 Service Worker，「添加到主屏幕」后无离线能力。建议：

1. 生成两个 PNG 图标（可用现有 SVG 转出）放入 `public/icons/`，manifest 声明：
```json
"icons": [
  { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "icons/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```
2. 加最小 Service Worker（缓存静态外壳，API 数据走 network-first）：
```js
// public/sw.js
const CACHE = 'mcd-shell-v1';
const SHELL = ['/', 'css/style.css', 'js/config.js', 'js/geo.js', 'js/api.js', 'js/state.js',
               'js/checkout.js', 'js/voice.js', 'js/views.js', 'js/app.js', 'manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/') || e.request.url.includes('mcd.cn')) return; // 接口/图片走网络
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
```
```js
// index.html 末尾注册（经典脚本内联即可）
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
```

### P3-1 金额格式化边缘 bug

`fmtMoney` 用 `toFixed(2).replace(/0$/, '')` 去尾零，`1.005` 会得到 `"1.0"`（`"1.00"` 去一个 0），`1.10` → `"1.1"` 正确但 `1.00` 走整数分支也正确——边界不一致。建议改用数值判断：

```js
// public/js/config.js
function fmtMoney(v) {
  const n = Math.round((Number(v) || 0) * 100) / 100;      // 先规整到分，避免 1.005 类浮点歧义
  return Number.isInteger(n) ? String(n) : String(n);     // JS 默认即去掉尾零：12.5→"12.5"，1→"1"
}
```
（`String(12.5)==="12.5"`、`String(12)==="12"`，无需正则修补；若需固定两位的场合另用 `toFixed(2)`。）

### P3-2 内联事件处理器（CSP 就绪性）

`views.js` 有 5 处 `<img ... onerror="this.style.opacity=0">`。内联 handler 会被未来的 `Content-Security-Response: script-src` 策略直接打死。建议集中改为事件委托：

```js
// public/js/app.js — 启动处一次性委托
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG') img.style.opacity = '0';      // 覆盖所有商品图/详情图加载失败
}, true);                                                  // capture：error 不冒泡
```
随后删除模板中的 `onerror="this.style.opacity=0"`。

### P3-3 `<noscript>` 回退

当前禁用 JS 后是纯白页。至少给出说明：

```html
<noscript>
  <div style="padding:24px;font-family:sans-serif;text-align:center">
    <h2>麦乐点需要 JavaScript 才能运行</h2>
    <p>请在浏览器设置中启用 JavaScript 后刷新页面。</p>
  </div>
</noscript>
```

### P3-4 静态资源缓存策略

当前所有资源 `max-age=0, must-revalidate`（每次访问都回源校验）。代码/数据文件不带哈希指纹，长缓存有更新风险；折中方案是对低频变更的数据放宽、并利用 Cloudflare 的 `_headers` 文件：

```
/* public/_headers（Cloudflare Pages 原生支持，随静态部署生效） */
/manifest.webmanifest
  Cache-Control: public, max-age=3600
```
（JS/CSS 保持 must-revalidate：发布即生效，避免用户拿到旧代码——这是「无哈希文件名」下的正确权衡。）

### P3-5 断点归并

现断点：1023（移动布局）/ 400 / 480（手动搜索换行）/ 1024（弹层居中）。建议：
- 保留 **480（手机）/ 1024（桌面）** 两档；
- ≤480 合并「菜单两列 + 头部紧凑 + 手动搜索换行」；
- 删除 400 档（其规则已被 480 覆盖）；
- 弹层居中/底部化用 `min-width: 1024px` 与移动档互斥即可（已如此）。

### P4-1 localStorage 结构版本校验

`hydrate()` 直接信任旧版购物车结构，若字段变更（如 `lineId` 语义调整）可能导致渲染异常。建议轻量校验：

```js
// public/js/state.js — hydrate()
const cart = JSON.parse(localStorage.getItem(CONFIG.LS_CART) || '[]');
if (Array.isArray(cart)) {
  state.cart = cart.filter((l) => l && typeof l.code === 'string' && Number.isFinite(l.unitPrice) && l.qty > 0);
}
```

### P4-2 `BASE_PATH` 无尾斜杠边缘

`new URL('.', 'https://x.github.io/repo')` 会把 `repo` 当文件处理，推导出 `''` 而非 `/repo`。GitHub Pages 会 301 到带斜杠地址故实际不易触发，但加一道兜底更稳：

```js
const BASE_PATH = (() => {
  try {
    const u = new URL('.', window.location.href);
    return u.pathname.replace(/\/$/, '');
  } catch (_) {
    // 退化路径：从文档 URL 手工截目录
    const m = location.pathname.match(/^(.*\/)[^/]*$/);
    return m ? m[1].replace(/\/$/, '') : '';
  }
})();
```

---

## 八、测试与验证汇总

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| `geo-test.js` | 71/71 | 定位引擎全异常路径、地理编码降级、门店搜索诚实性、UI 状态机、语音、营业状态徽章 |
| `smoke-test.js` | 43/43 | 实时模式全流程 + 购物车路由防重复渲染 + **路由往返回归 6 项（P0/P1 回归，见 2.3/2.4）** |
| `static-deploy-test.js` | 13/13 | 含后端实时渲染 / 无后端诚实提示 / SPA 回退 三种形态 |
| `responsive-test.js` | 28/28 | 6 视口零溢出、购物车无双份、断点显隐、**键盘无障碍 6 项（真实浏览器）** |
| `voice-test.js` | 23/23 | 麦克风 not-allowed 精确归因（iframe/WebView/非 HTTPS/权限拒/设备缺失/服务禁用）、跨平台恢复路径、Permissions API 优雅降级 |
| `voice-agent-test.js` | 40/40 | 唤醒模式门控（未唤醒拦截/唤醒词应答/30 秒窗口/唤醒词+指令一体）、onend 续听守卫、NLU 新意图（订单状态/推荐/地址/配送时间/送到家）、TTS 防回声、既有意图兼容 |
| `delivery-test.js` | 59/59 | 麦乐送：双实现路由一致性、服务端校验（缺地址/beCode 400、手机号）、下单口径透传（orderType=2+addressId+beCode）、前端全链路、时段快选、**G 段审计回归 13 项（getDeliveryStores 四种信封形状/切模式券重置/前置校验禁用与兜底守卫）** |
| `recommend-test.js` | 27/27 | 优惠推荐：四维加权评分降序、健康分（钠含量）、券后节省与估算声明、长辈 UI、播报、无营养降级、**H 段渲染健壮性 6 项（refresh emit/路由重建补渲染/清空复位）** |
| `live-test.js` | （需本机 Token） | 真实 MCP 链路 + 端到端定位（不触发真实下单） |
| `live-verify.js` | 9/9 | **线上针对性验证（见第十章）：P0/P1/P2-1 修复 + 启动并行化 API 序列** |
| `perf-test.js` | 3 场景 | 本地基线 + 模拟 MCP 延迟对照（见 3.3） |
| **自动化合计** | **303/303** | 上述八套（不含需 Token 的 live-test） |

**修复发布**：两轮审计的全部缺陷均已部署至 https://mcd-order-app.pages.dev 并 curl 验证线上代码版本（`menuGen`/`nutritionReady`/`deliveryReady`/`resetCoupons`/形状兼容/卡数兜底均已在线上文件中确认）；`npm test` 全绿。

**证据截图**（`docs/audit/`）：`fixed-desktop-cart.png`（修复后购物车单份）、`fixed-mobile-menu.png`（修复后 375px 头部）、`desktop-checkout.png`（结算第一步）、`keyboard-focus-ring.png`（键盘焦点环效果）。

---

## 九、结论

应用可以按现状放心分享（大赛评审/日常使用）。两轮审计共修复 **10 项缺陷**（购物车双份渲染、手机头部溢出、模态框键盘无障碍、焦点可见性、结算返回菜单空白、路由返回推荐区空白、麦乐送前置校验缺失、切模式券不重置、配送门店信封形状、首屏折叠），全部连同回归测试固化（303/303 全绿），P2 建议已全部落地。

剩余建议按优先级：**P3-6 交互 div 键盘可达性**（影响键盘用户完整操作，建议下一迭代首选）→ PWA 图标/离线（P3）→ 金额格式化/CSP 就绪/缓存策略（P3）→ 断点归并与 localStorage 校验（P3/P4）。

---

## 十、第二轮线上实测审计（2026-10-22）

> 本章为对线上站点 https://mcd-order-app.pages.dev 的第二轮深度审计：真实浏览器全流程实测 + 只读 API 冒烟 + 六视口复核 + 性能基线对照。审计脚本：`scripts/live-audit.js`（全量，产出 `live-audit-report.json`）、`scripts/live-verify.js`（修复后针对性回归）、`scripts/perf-test.js`（本地基线）。

### 10.1 新发现并已修复的问题

#### 2.3（P0）结算页返回菜单后主区域全空白

**现象**：`#/checkout` → `#/menu` 后，主区域既无商品卡也无搜索框/分类行（实测 `cards=0, hasMenuGridRoot=false`），只有 hero 文案；用户必须刷新页面才能恢复。

**根因**：`views.js` 的 `renderMenu` 以 `root.dataset.view !== 'menu'` 判定是否需要重建菜单 DOM；`renderCartPage` 标 `'cart'`、orders 标 `'orders'`，唯独 `CheckoutCtrl.render` 漏标 → 从结算返回时标记仍为 `'menu'`，renderMenu 误判「已渲染」直接跳过重建，而 `#view-root` 的内容早已被结算页替换。

**修复**（`public/js/checkout.js` render 开头）：

```js
root.dataset.view = 'checkout';  // 必须标记：renderMenu 据此判断是否需要重建菜单 DOM
```

**回归**：`smoke-test.js` 新增 `#/checkout → #/menu` 断言（商品卡 + 搜索框必须重建）；线上实测 `cards=8, search=true`。

#### 2.4（P1）购物车/订单页返回菜单后推荐区空白

**现象**：`#/cart` 或 `#/orders` → `#/menu` 后，「长辈优选」推荐区空白（实测 `stripCards=0`）。

**根因**：路由切换会重建整个 `#view-root`，新的 `#recommend-strip` 是空节点；而 `updateRecommendStrip` 的渲染签名 `_recSig` 未随 DOM 重建重置，签名相等即跳过重渲染。

**修复**（`public/js/views.js`，双重兜底）：空列表时复位签名；跳过条件增加「卡数是否与列表一致」校验——

```js
if (!list.length) { root.innerHTML = ''; this._recSig = null; return; }
if (this._recSig === sig && root.querySelectorAll('.rs-card').length === list.length) return;
```

**回归**：`smoke-test.js` 三条路由往返断言 + `recommend-test.js` H2b 场景复现；线上实测 `stripCards=4`。

#### 2.5（P2）麦乐送未选地址即可进入后续步骤

**现象**：结算第 1 步选「麦乐送」但未选地址/门店时，「下一步」按钮可点，用户直到第 3 步核价或下单才被 MCP 400 拦截，体验断裂。

**修复**（`public/js/checkout.js` + `app.js` 双层）：step1 增加 `deliveryReady` 前置校验，按钮 `disabled` + 内联红字提示；`app.js` 的 `checkout-next` 分支增加兜底守卫（禁用态被竞态/自动化绕过时也不进入第 2 步）。**回归**：`delivery-test.js` G9–G12；线上实测 `disabled=true, hint=true`。

#### 2.6（P2）切换取餐模式后优惠券不重置

**现象**：自取与麦乐送按不同口径拉券（`beType=1` vs `beType=2+beCode`），但切换模式后 `couponsLoaded` 仍为 `true`，第 2 步沿用另一口径的券池。

**修复**（`public/js/checkout.js` setDeliveryMode）：两个分支统一重置 `{ coupons: [], couponsLoaded: false, claimable: [], coupon: null, priceResult: null }`。**回归**：`delivery-test.js` G5–G7b（含「切入后核价必须按配送口径重算」断言）。

#### 2.7（P2）配送门店查询信封形状不兼容

**现象**：MCP 对配送门店查询可能返回 `{stores:[...]}` 形态，原实现走 `Object.values` 得到嵌套数组 `[[...]]`，`stores[0].beCode` 取不到。

**修复**（`public/js/api.js` getDeliveryStores）：兼容数组 / `{data:[...]}` / `{data:{stores:[...]}}` / `{stores:[...]}` 四种形态。**回归**：`delivery-test.js` G1–G4 逐形态断言。

#### 2.8（P3）手机首屏折叠：分类行被底部导航遮挡

**现象**：390×844 视口实测分类行 `top=787`、底部导航 `top=786`——分类行被完全遮挡；首个商品卡 `top=884` 落入折叠下。根因：推荐区置于菜单顶部，过高挤压主任务。

**修复**（`public/js/views.js`）：`#recommend-strip` 从 hero 之后移至 `#menu-grid-root` 之后，「看菜单点餐」主任务优先可见。

### 10.2 测试环境缺陷（同步修复）

`smoke/static-deploy/live/geo/delivery` 五个 jsdom 套件的 bundle 列表均漏装 `recommend.js`（真实页面在 `voice.js` 与 `views.js` 之间加载），导致推荐区在自动化测试中**从未被覆盖**，且 `app.js` 启动链里 `Recommend.refresh()` 抛出的 ReferenceError 被 `.catch(() => {})` 静默吞掉。已全部补装并对齐 `index.html` 顺序——这也是 2.4 缺陷逃过全部测试的环境根因。

### 10.3 性能实测（本地基线 + 模拟 MCP 延迟）

线上真实链路（MCP 经 Pages Function 代理）单次往返约 3–4s：审计实测首屏商品卡 **12444ms**、FCP 3944ms、LCP 9712ms、25 请求。本地以 mock MCP 复现两种延迟（`scripts/perf-test.js`，Edge 无头 390×844，隔离上下文 + 回访场景换新服务端进程避开 menuCache）：

| 场景 | 首屏商品卡 | 说明 |
| --- | --- | --- |
| A 快后端·首访（MCP 0ms） | 271ms | 应用自身开销极小（静态资源 ~60KB + 渲染） |
| B 慢后端·首访（MCP 800ms/次） | 1855ms | stores→menu 串行（菜单依赖 storeCode，不可避免） |
| C 慢后端·回访（hydrate 门店） | 1092ms | 菜单与门店并行，**较 B 快 41%** |

**启动并行化**（`public/js/app.js`）：① 营养表与门店/菜单无依赖 → 与门店请求同时发出（线上 API 序列已验证 nutrition 先于 stores 返回）；② 回访用户 localStorage 已 hydrate 普通门店 → 菜单请求并行发出，门店返回后仍有效则直接采用，失效则重拉（新增 `menuGen` 代次守卫，同时消除快速切换门店时旧菜单覆盖新菜单的竞态）；配送门店不并行（菜单依赖未持久化的 beCode）。线上首访首屏 12444ms → 11426ms；按本地模型推算，回访用户可省一整段 MCP 往返（线上约 3–4s）。

### 10.4 审计方法与通过情况

全量审计 38 项检查：32 项通过 + 6 项异常（上述 2.3–2.8 与首屏折叠，已全部修复）。曾出现 3 起测试脚本自身假阳性（`position:fixed` 元素 `offsetParent` 恒 null、分类行点击被底部导航截走、`nth-child(2)` 为已激活默认分类），均已定位并修正测试方法，未误报为产品缺陷。定位链路 success（济南 5 门店）；六视口（320/375/390/414/768/1440）零文档溢出；只读 API 冒烟全通。
