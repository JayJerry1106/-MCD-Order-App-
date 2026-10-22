/* 诊断：分类 chip 点击后路由为何跳到 #/cart */
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
  if (pathname === '/api/meal') return ok({ data: fixtures.mealDetails[body.code] || Object.values(fixtures.mealDetails)[0] });
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

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluateOnNewDocument(() => {
      window.__diag = [];
      document.addEventListener('click', (e) => {
        const t = e.target;
        const chain = [];
        let n = t;
        while (n && chain.length < 4) {
          chain.push(`${n.tagName.toLowerCase()}${n.className ? '.' + String(n.className).split(' ')[0] : ''}[${n.getAttribute && n.getAttribute('data-action') || ''}]`);
          n = n.parentElement;
        }
        window.__diag.push({ ev: 'click', chain: chain.join(' < '), x: e.clientX, y: e.clientY, hash: location.hash });
      }, true);
      window.addEventListener('hashchange', () => {
        window.__diag.push({ ev: 'hashchange', to: location.hash, stack: new Error().stack.split('\n').slice(1, 4).join(' | ') });
      });
    });
    await page.goto(base + '/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.product-card').length > 0, { timeout: 15000 });
    await sleep(800);

    // 打印第二个 chip 的盒模型与视口信息
    const geo = await page.evaluate(() => {
      const chip = document.querySelectorAll('.cat-chip')[1];
      const r = chip.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const at = document.elementFromPoint(cx, cy);
      return {
        rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        center: { x: Math.round(cx), y: Math.round(cy) },
        elementAtCenter: at ? `${at.tagName.toLowerCase()}.${String(at.className).split(' ')[0]} data-action=${at.getAttribute('data-action')} href=${at.getAttribute('href') || ''}` : 'null',
        scrollY: window.scrollY,
        docH: document.documentElement.scrollHeight,
      };
    });
    console.log('chip 盒模型:', JSON.stringify(geo, null, 1));

    await page.click('.cat-chip:nth-child(2)');
    await sleep(600);
    const diag = await page.evaluate(() => window.__diag);
    const state = await page.evaluate(() => ({
      hash: location.hash,
      route: Store.state.ui.route,
      category: Store.state.ui.category,
      recLen: (Store.state.ui.recommend || []).length,
    }));
    console.log('诊断事件:', JSON.stringify(diag, null, 1));
    console.log('点击后状态:', JSON.stringify(state));
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('异常：', e); process.exit(2); });
