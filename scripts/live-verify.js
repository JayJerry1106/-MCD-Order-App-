/* 线上针对性验证：P0（结算返回菜单主区域重建）+ P1（路由返回推荐区重渲染）+ 启动并行化。
 * 只跑关键路径，避免全量审计耗时。用法：node scripts/live-verify.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const SITE = 'https://mcd-order-app.pages.dev/';
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可靠点击：先滚动到视口中央，避开底部固定导航遮挡（实测 chip 中心 y=805 vs 导航 top=786） */
async function safeClick(page, sel) {
  const handle = await page.$(sel);
  if (!handle) return false;
  await handle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await handle.click();
  return true;
}

(async () => {
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  let puppeteer = null;
  try { puppeteer = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'); } catch (_) { /* ignore */ }
  if (!edgePath || !puppeteer) { console.log('⚠️ 无浏览器，跳过'); return; }

  const browser = await puppeteer.launch({ executablePath: edgePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const apiLog = [];
  page.on('response', async (r) => {
    if (/\/api\//.test(r.url())) {
      const t = await r.text().catch(() => '');
      apiLog.push({ url: r.url().replace(SITE, ''), status: r.status(), len: t.length });
    }
  });

  const t0 = Date.now();
  await page.goto(SITE, { waitUntil: 'load', timeout: 90000 });
  let firstCards = null;
  for (let i = 0; i < 200; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('.product-card .p-name').length);
    if (n > 0) { firstCards = Date.now() - t0; break; }
    await sleep(100);
  }
  check('线上：首屏商品卡渲染（启动并行化）', firstCards !== null, `${firstCards}ms（优化前实测 12444ms）`);

  // 加购一件商品 → 进入结算 → 返回菜单
  const opened = await safeClick(page, '.product-card');
  check('线上：打开商品详情', opened);
  await sleep(2500);
  const added = await safeClick(page, '[data-action="detail-add"]');
  check('线上：加入购物车', added);
  await sleep(800);
  await page.evaluate(() => { location.hash = '#/checkout'; });
  await sleep(6000);
  const onCheckout = await page.evaluate(() => document.body.textContent.includes('确认订单'));
  check('线上：进入结算第 1 步', onCheckout);

  // P0：结算 → 菜单
  await page.evaluate(() => { location.hash = '#/menu'; });
  await sleep(2500);
  const afterBack = await page.evaluate(() => ({
    cards: document.querySelectorAll('#menu-grid-root .product-card').length,
    search: !!document.querySelector('#menu-search'),
    strip: document.querySelectorAll('#recommend-strip .rs-card').length,
  }));
  check('线上 P0 回归：结算返回菜单后主区域完整重建', afterBack.cards > 0 && afterBack.search,
    `cards=${afterBack.cards}, search=${afterBack.search}`);
  check('线上 P1 回归：结算返回菜单后推荐区重新渲染', afterBack.strip > 0, `stripCards=${afterBack.strip}`);

  // P1：购物车 → 菜单
  await page.evaluate(() => { location.hash = '#/cart'; });
  await sleep(1500);
  await page.evaluate(() => { location.hash = '#/menu'; });
  await sleep(2000);
  const afterCart = await page.evaluate(() => ({
    cards: document.querySelectorAll('#menu-grid-root .product-card').length,
    strip: document.querySelectorAll('#recommend-strip .rs-card').length,
  }));
  check('线上 P1 回归：购物车返回菜单后推荐区重新渲染', afterCart.strip > 0 && afterCart.cards > 0,
    `cards=${afterCart.cards}, stripCards=${afterCart.strip}`);

  // P2-1：麦乐送未选地址时下一步禁用（线上复现过可点）
  await page.evaluate(() => { location.hash = '#/checkout'; });
  await sleep(4000);
  const modeRes = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('[data-action="pick-delivery-mode"]'))
      .find((b) => b.dataset.mode === 'delivery');
    if (btn) btn.click();
    return !!btn;
  });
  check('线上：切到麦乐送模式', modeRes);
  await sleep(4000);
  const nextState = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-action="checkout-next"]')).find((x) => /下一步/.test(x.textContent));
    return { disabled: b ? b.disabled : null, hint: /请先选择配送地址/.test(document.body.textContent) };
  });
  check('线上 P2-1 回归：未选地址时下一步禁用 + 内联提示', nextState.disabled === true && nextState.hint,
    `disabled=${nextState.disabled}, hint=${nextState.hint}`);

  console.log('\n—— API 调用序列（验证并行化）——');
  apiLog.forEach((a) => console.log(`  ${a.status} ${a.url} ${(a.len / 1024).toFixed(1)}KB`));

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========== 线上针对性验证：${pass}/${results.length} 通过 ==========`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('验证异常：', e); process.exit(1); });
