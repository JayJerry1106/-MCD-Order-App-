/* 复现诊断：长辈优选推荐区渲染缺陷（本地 mock 后端 + 真实浏览器，快速迭代） */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures.json'), 'utf8'));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiResponse(pathname, body) {
  const ok = (data) => ({ status: 200, json: { success: true, data } });
  if (pathname === '/api/status') return ok({ mode: 'live', mcp: true });
  if (pathname === '/api/stores') return ok({ data: fixtures.stores.map((s) => ({ ...s })) });
  if (pathname === '/api/menu') return ok({ data: fixtures.menus.regular });
  if (pathname === '/api/meal') {
    const d = (body && body.code && fixtures.mealDetails[body.code]) || Object.values(fixtures.mealDetails)[0];
    return ok({ data: d });
  }
  if (pathname === '/api/nutrition') return ok({ data: fixtures.nutrition });
  if (pathname === '/api/coupons/available') return ok(fixtures.coupons.available);
  if (pathname === '/api/coupons/mine') return ok({ coupons: fixtures.coupons.mine });
  if (pathname === '/api/coupons/store') return ok(fixtures.coupons.store);
  if (pathname === '/api/coupons/claim') return ok({ message: 'ok' });
  if (pathname === '/api/price') return ok({ data: { productOriginalPrice: 0, productPrice: 0, price: 9999, discount: 0, productList: [], takeWayList: [{ code: 'eat-in', title: '堂食' }], enjoyed: null, enjoyable: null } });
  if (pathname === '/api/order') return ok({ data: { orderId: 'MCP1', pickupCode: '4321', status: '待支付' } });
  return { status: 404, json: { success: false, error: '接口不存在' } };
}

(async () => {
  const puppeteer = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { /* ignore */ }
        const r = apiResponse(p, body);
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r.json));
      });
      return;
    }
    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? '/index.html' : p));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('NF'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });

  const dump = (page, label) => page.evaluate(() => {
    const strip = document.querySelector('#recommend-strip');
    return {
      label: location.hash || '#/menu',
      stripExists: !!strip,
      cards: document.querySelectorAll('#recommend-strip .rs-card').length,
      stripHtmlLen: strip ? strip.innerHTML.trim().length : -1,
      recommendLen: (Store.state.ui.recommend || []).length,
      viewRootView: document.querySelector('#view-root').dataset.view,
      recSig: Views._recSig === undefined ? 'undefined' : String(Views._recSig).slice(0, 60),
      category: Store.state.ui.category,
    };
  }).then((d) => console.log(`[${label}]`, JSON.stringify(d)));

  // 可靠点击：先滚动到视口中央（避开底部固定导航遮挡），再点击
  const safeClick = async (page, selector) => {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, selector);
    await sleep(150);
    await page.click(selector);
  };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)));
    await page.goto(base + '/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.product-card').length > 0, { timeout: 15000 });
    await sleep(800);

    console.log('--- 场景 1：首屏（营养 emit 后）---');
    await dump(page, '首屏');

    console.log('--- 场景 2：点击第 2 个分类 chip ---');
    await safeClick(page, '.cat-chip:nth-child(2)');
    await sleep(500);
    await dump(page, '分类点击后');

    console.log('--- 场景 3：点回第 1 个分类 ---');
    await safeClick(page, '.cat-chip:nth-child(1)');
    await sleep(500);
    await dump(page, '点回后');

    console.log('--- 场景 4：搜索框输入（触发 setSearch）---');
    await page.type('#menu-search', '麦');
    await sleep(900);
    await dump(page, '搜索后');

    console.log('--- 场景 5：清空搜索 ---');
    await page.$eval('#menu-search', (el) => { el.value = ''; el.dispatchEvent(new Event('search', { bubbles: true })); });
    await sleep(600);
    await dump(page, '清空搜索后');

    console.log('--- 场景 6：模拟营养接口失败（刷新前拦截 /api/nutrition 返回 500）---');
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 390, height: 844 });
    await page2.setRequestInterception(true);
    page2.on('request', (r) => {
      if (r.url().includes('/api/nutrition')) { r.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'mock fail' }) }); }
      else r.continue();
    });
    await page2.goto(base + '/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await page2.waitForFunction(() => document.querySelectorAll('.product-card').length > 0, { timeout: 15000 });
    await sleep(1500);
    await dump(page2, '营养失败·首屏');
    await safeClick(page2, '.cat-chip:nth-child(2)');
    await sleep(500);
    await dump(page2, '营养失败·分类点击后');
    await page2.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('复现脚本异常：', e); process.exit(2); });
