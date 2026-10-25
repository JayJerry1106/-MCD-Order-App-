---
name: 麦麦小助手
description: 麦当劳点餐助手应用的运维与使用入口，以及麦当劳 MCP 的真实点餐操作手册。当用户要求打开/启动/部署麦当劳点餐助手（麦乐点）Web 应用、在手机上使用点餐应用、生成公网分享链接，或需要直接调用麦当劳 MCP 完成选门店、查菜单、领麦麦省券、核价、下单、查营养时使用。触发词：麦麦小助手、麦当劳点餐助手、打开点餐应用、麦乐点、麦当劳 MCP、mcd-mcp、麦麦省、定位附近门店、语音点餐。注意：只要「怎么点最划算/推荐方案」不需要真实下单时，应改用 mcd-saver-strategist 或 mcd-order-agent。
agent_created: true
---

# 麦麦小助手

麦当劳点餐助手（McDonald's Order App）的封装：一个已建成的麦当劳品牌风格点餐 Web 应用（响应式 + 语音交互 + 实时定位门店 + 优惠券优先领取 + MCP 核价下单），外加直接调用麦当劳 MCP 的完整操作知识。

## 能力总览

1. **运行与访问应用**：启动本地服务、手机/公网访问、模式切换、部署与排障。
2. **直接操作 MCP**：不经过 UI，用内置脚本调用麦当劳 MCP 完成真实点餐全流程。
3. **应用功能咨询**：语音指令、定位逻辑、优惠券流程、测试与文档位置。

## 工作流程

### 任务 A：用户想用点餐应用（UI）

1. 读 `references/app-runbook.md`，按其中第 2/3 节启动并给出访问地址。
2. 应用目录默认在 `D:\下载\2026-10-21-09-25-55\mcd-order-app`；若不存在，用 Glob 搜 `**/mcd-order-app/server.js` 定位。
3. 未配置 Token 时应用自动进入演示模式（功能完整、下单模拟），可直接体验；不得虚构实时数据。
4. 涉及公网部署时，遵守 runbook 第 4 节安全红线：**含 Token 的 `.env` 严禁上传**，公开部署用剔除 `.env` 的副本（演示模式）。

### 任务 B：用户想直接点餐/查信息（不走 UI）

1. 读 `references/mcp-playbook.md`，用 `<skill目录>/scripts/mcp.js <工具名> '<JSON>'` 调用（脚本自动从应用 `.env` 读取 Token）。
2. 典型链路：`query-nearby-stores` → `query-meals` → `query-meal-detail` → （需要时 `available-coupons`/`auto-bind-coupons`）→ `calculate-price` → 用户确认 → `create-order`。
3. 严格遵守 playbook 第 2 节 items 组装规则与第 7 节下单确认纪律：下单前复述门店/清单/用券/金额/取餐方式并获明确确认；金额一律以 `calculate-price` 为准。

### 任务 C：排障

按 runbook 第 6 节对照处理；应用源码结构（`server.js` 零依赖服务端 + `public/js/` 前端模块）见应用目录 `README.md`。

## 内置资源

| 资源 | 用途 |
| --- | --- |
| `scripts/mcp.js` | 麦当劳 MCP 命令行调用器（零依赖，自动读取 Token，业务拒绝时非零退出） |
| `references/app-runbook.md` | 应用位置/启动/访问/部署/测试/排障 |
| `references/mcp-playbook.md` | MCP 工具清单、items 组装、券规则、错误码、定位距离、下单纪律 |

## 边界

- 本 skill 负责「应用 + 真实 MCP 操作」；纯推荐/省钱演算交给 `mcd-saver-strategist`，结构化点餐方案交给 `mcd-order-agent`。
- 实时模式下单会产生真实订单；无 Token 时只能演示，需明确告知用户。
