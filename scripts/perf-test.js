/* 性能测量：本地基线 + 模拟 MCP 延迟对照，量化启动链路（stores→menu→nutrition）开销与并行化收益。
 * 场景（每个场景独立浏览器上下文隔离 localStorage；回访场景换新服务端进程避开 menuCache）：
 *   A 快后端·首访（MCP 0ms）：应用自身开销基线
 *   B 慢后端·首访（MCP 800ms/次）：模拟线上延迟下的串行链路代价
 *   C 慢后端·回访：localStorage 已 hydrate 门店 → 菜单与门店并行（优化后路径）
 * 用法：node scripts/perf-test.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures.json'), 'utf8'));

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 MCP：按工具名返回 fixtures 形态数据，latency 模拟真实 MCP 往返 */
function startMockMcp(port, latency) {
  const mcp = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const name = body.params && body.params.name;
      await sleep(latency);
      let data = {};
      if (name === 'query-nearby-stores') data = { data: fixtures.stores.map((s) => ({ ...s })) };
      else if (name === 'query-meals') data = { data: fixtures.menus.regular };
      else if (name === 'query-meal-detail') data = { data: Object.values(fixtures.mealDetails)[0] };
      else if (name === 'list-nutrition-foods') data = { data: fixtures.nutrition };
      else if (name === 'available-coupons') data = fixtures.coupons.available;
      else if (name === 'query-my-coupons') data = { coupons: fixtures.coupons.mine };
      else if (name === 'query-store-coupons') data = fixtures.coupons.store;
      else if (name === 'calculate-price') data = { data: { price: 9999, takeWayList: [{ code: 'eat-in', title: '堂食' }, { code: 'take-in-store', title: '外带' }] } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: data } }));
    });
  });
  return new Promise((resolve) => mcp.listen(port, () => resolve(mcp)));
}

async function startApp(mcpPort) {
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '3396', MCD_MCP_TOKEN: 'x'.repeat(32), MCD_MCP_URL: `http://127.0.0.1:${mcpPort}/` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:3396/api/status'); if (r.ok) return app; } catch (_) { /* retry */ }
    await sleep(200);
  }
  throw new Error('服务端启动超时');
}

/** 在给定上下文加载一次并计时，返回指标 */
async function measure(ctx, label) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const reqs = [];
  page.on('response', (r) => reqs.push({ url: r.url(), status: r.status() }));
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:3396/', { waitUntil: 'load', timeout: 60000 });
  const loadMs = Date.now() - t0;
  // 等真实商品卡渲染完成（骨架屏也用 .product-card 类，须以 .p-name 区分）
  let firstCardsMs = null;
  for (let i = 0; i < 300; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('.product-card .p-name').length);
    if (n > 0) { firstCardsMs = Date.now() - t0; break; }
    await sleep(100);
  }
  await sleep(400); // 等 LCP 条目落库
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const paint = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
    return { dcl: Math.round(nav.domContentLoadedEventEnd || 0), fcp: paint ? Math.round(paint.startTime) : null };
  });
  const transfer = await page.evaluate(() => performance.getEntriesByType('resource')
    .reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0));
  await page.close();
  const row = { label, loadMs, firstCardsMs, ...metrics, transfer, requests: reqs.length };
  console.log(`${label}\n  load=${loadMs}ms  首屏商品卡=${firstCardsMs}ms  DCL=${metrics.dcl}ms  FCP=${metrics.fcp}ms  资源=${reqs.length} 传输=${(transfer / 1024).toFixed(0)}KB`);
  return row;
}

(async () => {
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  let puppeteer = null;
  try { puppeteer = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'); } catch (_) { /* ignore */ }
  if (!edgePath || !puppeteer) {
    console.log('⚠️ 未找到 Edge/Chrome 或 puppeteer-core，跳过性能实测');
    return;
  }

  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const rows = [];

  // A / B：各自全新上下文（空 localStorage）+ 全新服务端（空 menuCache）
  for (const [label, mcpLatency] of [
    ['A 快后端·首访（MCP 0ms，应用自身开销基线）', 0],
    ['B 慢后端·首访（MCP 800ms/次，模拟线上延迟）', 800],
  ]) {
    const mcp = await startMockMcp(3397, mcpLatency);
    const app = await startApp(3397);
    const ctx = await browser.createBrowserContext();
    rows.push(await measure(ctx, label));
    await ctx.close();
    app.kill();
    mcp.close();
    await sleep(300);
  }

  // C：回访场景——先在同上下文首访写入门店，再换新服务端进程（避开 menuCache）后测量二次访问
  {
    const mcp = await startMockMcp(3397, 800);
    const app1 = await startApp(3397);
    const ctx = await browser.createBrowserContext();
    await measure(ctx, 'C0 慢后端·首访（写入 hydrate 门店，不计入对比）');
    app1.kill(); // 新进程 → menuCache 清空，二次访问必须重新拉菜单
    const app2 = await startApp(3397);
    rows.push(await measure(ctx, 'C 慢后端·回访（hydrate 门店并行拉菜单）'));
    await ctx.close();
    app2.kill();
    mcp.close();
    await sleep(300);
  }

  await browser.close();
  console.log('\n—— 汇总 ——');
  for (const r of rows) console.log(`  ${r.label}: load=${r.loadMs}ms firstCards=${r.firstCardsMs}ms FCP=${r.fcp}ms DCL=${r.dcl}ms`);
})().catch((e) => { console.error('性能测量异常：', e); process.exit(1); });
