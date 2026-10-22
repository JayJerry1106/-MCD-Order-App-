/* 线上站点全量审计脚本 v2（真实浏览器）：
 * 目标：https://mcd-order-app.pages.dev/
 * 维度：
 *   A. 加载与监控：控制台错误 / pageerror / 失败请求 / FCP / LCP / 资源
 *   B. 推荐区：首屏渲染（实测）+ 分类交互后保持 + 首屏折叠量化（分类行/菜单是否在首屏内）
 *   C. 交互链路：详情 → 加购 → 购物车 → 结算 step1 → 麦乐送 → step2 优惠券
 *      （P2-1「麦乐送未选地址仍可下一步」、P2-2「切模式券不重置」线上验证）
 *   D. 语音浮层：打开 / 唤醒开关 / 建议 chips / 关闭
 *   E. 定位链路：CDP 定位授权 + 定位 → 收敛（success/error，不 hang）
 *   F. 响应式：320 / 375 / 390 / 414 / 768 / 1440 六视口零横向溢出
 *   G. 只读 API 冒烟（不产生任何真实订单/领券）
 *
 * 可靠性要点：
 *   - safeClick：先 scrollIntoView({block:'center'}) 再点击，避开底部固定导航遮挡
 *     （390px 视口实测：分类行位于 y≈805，正下方即底部导航，裸点击会被导航截走）
 *   - MCP 链路慢（首屏约 15s），所有等待放宽到 30-60s
 * 用法：node scripts/live-audit.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SITE = 'https://mcd-order-app.pages.dev/';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const OUT = path.join(__dirname, 'live-audit-report.json');

const results = [];
function report(phase, name, pass, extra = '') {
  results.push({ phase, name, pass: !!pass, extra });
  console.log(`${pass ? '✅' : '❌'} [${phase}] ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可靠点击：滚动到视口中央后再点，避免被底部固定导航截走 */
async function safeClick(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, selector);
  await sleep(150);
  await page.click(selector);
}

(async () => {
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  const puppeteer = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    defaultViewport: { width: 390, height: 844 },
    args: ['--disable-dev-shm-usage'],
  });
  const ctx = browser.defaultBrowserContext();

  /* ============ Phase A：加载与监控 ============ */
  console.log('\n===== Phase A 加载与监控 =====');
  const page = await ctx.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const badResponses = [];
  const reqLog = [];
  let transferBytes = 0;

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    if (m.type() === 'warning') consoleWarnings.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('response', async (r) => {
    const url = r.url();
    if (!url.startsWith('https://mcd-order-app.pages.dev')) return;
    reqLog.push({ url: url.replace(SITE, '/'), status: r.status() });
    if (r.status() >= 400) badResponses.push({ url: url.slice(0, 120), status: r.status() });
    try {
      const h = r.headers();
      const len = Number(h['content-length'] || 0);
      if (Number.isFinite(len) && len > 0) transferBytes += len;
    } catch (_) { /* ignore */ }
  });

  await page.evaluateOnNewDocument(() => {
    window.__paint = {};
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.name === 'first-contentful-paint') window.__paint.fcp = Math.round(e.startTime);
        }
      }).observe({ type: 'paint', buffered: true });
      new PerformanceObserver((l) => {
        const es = l.getEntries();
        if (es.length) window.__paint.lcp = Math.round(es[es.length - 1].startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) { /* ignore */ }
  });

  const t0 = Date.now();
  await page.goto(SITE + '?v=audit' + t0, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.product-card', { timeout: 60000 }).catch(() => {});
  await sleep(3000);
  const loadMs = Date.now() - t0;

  const paint = await page.evaluate(() => window.__paint || {});
  const menuCount = await page.$$eval('.product-card', (els) => els.length).catch(() => 0);
  const catCount = await page.$$eval('.cat-chip', (els) => els.length).catch(() => 0);
  const modeBadge = await page.$eval('#mode-badge', (el) => el.textContent.trim()).catch(() => '');
  const nav = await page.evaluate(() => ({
    resources: performance.getEntriesByType('resource').length,
    dcl: Math.round(performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart),
  }));

  report('A', '页面加载并渲染菜单（.product-card > 0）', menuCount > 0, `${menuCount} 个商品卡，总耗时 ${loadMs}ms`);
  report('A', '分类横滑渲染（.cat-chip > 0）', catCount > 0, `${catCount} 个分类`);
  report('A', '实时模式徽章', modeBadge.includes('实时'), modeBadge);
  report('A', '无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  report('A', '无 pageerror（未捕获异常）', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  report('A', '无失败请求（HTTP >= 400）', badResponses.length === 0, JSON.stringify(badResponses).slice(0, 200));
  report('A', 'FCP 采集', paint.fcp != null, `FCP ${paint.fcp}ms`);
  report('A', 'LCP 采集', paint.lcp != null, `LCP ${paint.lcp}ms`);
  report('A', '资源请求数（含 MCP 代理 API）', nav.resources > 0 && nav.resources < 40, `${nav.resources} 个资源，传输约 ${(transferBytes / 1024).toFixed(0)}KB，DCL ${nav.dcl}ms`);

  /* ============ Phase B：推荐区 + 首屏折叠量化 ============ */
  console.log('\n===== Phase B 推荐区与首屏折叠 =====');
  const rec1 = await page.evaluate(() => ({
    cards: document.querySelectorAll('#recommend-strip .rs-card').length,
    recLen: (Store.state.ui.recommend || []).length,
    nutritionKeys: Object.keys(Store.state.nutrition || {}).length,
  }));
  report('B', '首屏渲染后推荐区有内容', rec1.cards > 0, `推荐卡 ${rec1.cards} 张（state.recommend=${rec1.recLen}，营养表 ${rec1.nutritionKeys} 条）`);

  // 首屏折叠量化：分类行与首个商品卡相对首屏的位置
  const fold = await page.evaluate(() => {
    const cat = document.querySelector('#cat-row');
    const card = document.querySelector('.product-card');
    return {
      vh: window.innerHeight,
      catTop: cat ? Math.round(cat.getBoundingClientRect().top) : null,
      cardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      navTop: Math.round(document.querySelector('.bottom-nav').getBoundingClientRect().top),
    };
  });
  const catAboveFold = fold.catTop != null && fold.catTop < fold.vh;
  const cardAboveFold = fold.cardTop != null && fold.cardTop < fold.navTop;
  report('B', '分类行在首屏内（不被底部导航遮挡）', catAboveFold && fold.catTop < fold.navTop,
    `视口 ${fold.vh}px：分类行 top=${fold.catTop}，底部导航 top=${fold.navTop}，首个商品卡 top=${fold.cardTop}`);
  report('B', '首个商品卡在首屏内（菜单立即可见）', cardAboveFold, `商品卡 top=${fold.cardTop} vs 导航 top=${fold.navTop}`);

  await safeClick(page, '.cat-chip:nth-child(3)'); // 第 3 个分类（前两个通常是「全部」与默认分类，点了不换）
  await sleep(600);
  const rec2 = await page.evaluate(() => ({
    hash: location.hash,
    cards: document.querySelectorAll('#recommend-strip .rs-card').length,
    category: Store.state.ui.category,
  }));
  report('B', '分类切换后推荐区保持且不误导航', rec2.cards > 0 && (rec2.hash === '#/menu' || rec2.hash === '') && rec2.category !== '人气热卖',
    `hash=${rec2.hash || '(空)'}，卡 ${rec2.cards} 张，分类=${rec2.category}`);

  /* ============ Phase C：交互链路 ============ */
  console.log('\n===== Phase C 交互链路 =====');

  // C1 商品详情（MCP query-meal-detail 慢，放宽到 40s）
  await safeClick(page, '.product-card');
  let detailOk = false;
  try {
    await page.waitForSelector('.detail-name', { timeout: 40000 });
    detailOk = true;
  } catch (_) { /* ignore */ }
  const detailName = detailOk ? await page.$eval('.detail-name', (el) => el.textContent.trim()) : '';
  report('C', '商品详情弹层打开并加载', detailOk, detailName.slice(0, 30));

  // C2 加购
  const addBtn = await page.$('[data-action="detail-add"]').catch(() => null);
  if (addBtn) {
    await safeClick(page, '[data-action="detail-add"]');
    await sleep(1200);
  }
  const badge = await page.$eval('#cart-badge', (el) => (el.hidden ? '0' : el.textContent)).catch(() => 'n/a');
  report('C', '加购后角标更新', badge !== 'n/a' && Number(badge) >= 1, `角标 ${badge}`);

  // C3 购物车路由
  await page.evaluate(() => { location.hash = '#/cart'; });
  await sleep(900);
  const cartItems = await page.$$eval('.cart-item', (els) => els.length).catch(() => 0);
  report('C', '购物车路由渲染商品行', cartItems > 0, `${cartItems} 行`);

  // C4 结算 step1 + 麦乐送
  await page.evaluate(() => { location.hash = '#/checkout'; });
  await sleep(1500);
  const step1Active = await page.$$eval('.step', (els) => els[0] && els[0].className.includes('active')).catch(() => false);
  report('C', '进入结算第 1 步', step1Active);

  await safeClick(page, '[data-action="pick-delivery-mode"][data-mode="delivery"]');
  await sleep(3000);
  const dpVisible = await page.$eval('.delivery-panel', (el) => !!el.offsetParent).catch(() => false);
  const addrCount = await page.evaluate(() => (Store.state.ui.checkout.delivery.addresses || []).length);
  report('C', '麦乐送面板展开', dpVisible, `我的配送地址 ${addrCount} 个`);

  // P2-1：无地址/无 beCode 时「下一步」是否禁用
  const beCode = await page.evaluate(() => Store.state.ui.checkout.delivery.beCode);
  const nextDisabled = await page.$eval('[data-action="checkout-next"]', (el) => el.disabled).catch(() => null);
  report('C', 'P2-1：配送信息不完整时「下一步」应禁用', nextDisabled === true,
    nextDisabled === false ? `缺陷复现：按钮可点（beCode="${beCode}"，地址 ${addrCount} 个）` : `disabled=${nextDisabled}`);

  // 进入 step2（优惠券）——P2-1 允许前进则必然到达
  await safeClick(page, '[data-action="checkout-next"]');
  await sleep(6000); // step2 并发拉三组券数据
  const step2Active = await page.$$eval('.step', (els) => els[1] && els[1].className.includes('active')).catch(() => false);
  const couponCards = await page.$$eval('.coupon-card', (els) => els.length).catch(() => 0);
  report('C', '进入结算第 2 步（优惠券）', step2Active, `券卡 ${couponCards} 张`);
  const ckTakeout = await page.evaluate(() => {
    const c = Store.state.ui.checkout;
    return { couponsLoaded: c.couponsLoaded, coupons: (c.coupons || []).length, storeCoupons: (c.coupons || []).filter((x) => x.source === 'store').length, mode: c.delivery.mode, beCode: c.delivery.beCode };
  });

  // P2-2：切麦乐送 → 再进 step2，券是否重载（应重载而未重载=缺陷）
  await safeClick(page, '[data-action="checkout-back"]');
  await sleep(800);
  await safeClick(page, '[data-action="pick-delivery-mode"][data-mode="takeout"]');
  await sleep(1500);
  await safeClick(page, '[data-action="checkout-next"]');
  await sleep(2500);
  const ckDelivery = await page.evaluate(() => {
    const c = Store.state.ui.checkout;
    return { couponsLoaded: c.couponsLoaded, coupons: (c.coupons || []).length, storeCoupons: (c.coupons || []).filter((x) => x.source === 'store').length, mode: c.delivery.mode, beCode: c.delivery.beCode };
  });
  report('C', 'P2-2：切换取餐模式后券池应重置重载',
    ckDelivery.coupons === 0 && ckDelivery.couponsLoaded === false,
    `自取态: ${JSON.stringify(ckTakeout)} → 麦乐送态: ${JSON.stringify(ckDelivery)}`);

  /* ============ Phase D：语音浮层 ============ */
  console.log('\n===== Phase D 语音浮层 =====');
  await page.evaluate(() => { location.hash = '#/menu'; });
  await sleep(600);
  await safeClick(page, '#header-mic-btn');
  await sleep(900);
  // 注意：position:fixed 元素 offsetParent 恒为 null，须用 getClientRects 判定可见性
  const voiceOpen = await page.$eval('#voice-overlay', (el) => !el.hidden && el.getClientRects().length > 0).catch(() => false);
  const wakeToggle = await page.$('#voice-wake-toggle').catch(() => null);
  const voiceSuggest = await page.$$eval('#voice-suggest button', (els) => els.map((e) => e.textContent)).catch(() => []);
  report('D', '语音浮层打开', voiceOpen);
  report('D', '唤醒模式开关存在', !!wakeToggle);
  report('D', '建议指令 chips 渲染', voiceSuggest.length > 0, voiceSuggest.join(' / ').slice(0, 80));
  await safeClick(page, '#voice-close-btn');
  await sleep(500);
  const voiceClosed = await page.$eval('#voice-overlay', (el) => el.hidden).catch(() => false);
  report('D', '语音浮层关闭', voiceClosed);

  /* ============ Phase E：定位链路 ============ */
  console.log('\n===== Phase E 定位链路 =====');
  await ctx.overridePermissions(SITE, ['geolocation']);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setGeolocationOverride', { latitude: 36.6525, longitude: 117.0066, accuracy: 30 }); // 济南·趵突泉
  await safeClick(page, '#store-pill');
  await sleep(900);
  const pickerOpen = await page.$eval('.modal-box', (el) => !!el.offsetParent).catch(() => false);
  report('E', '门店选择器打开', pickerOpen);
  const locateBtn = await page.$('[data-action="locate-me"]').catch(() => null);
  if (locateBtn) {
    await safeClick(page, '[data-action="locate-me"]');
    let geoState = 'locating';
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      geoState = await page.evaluate(() => {
        try { return Store.state.geo.status; } catch (e) { return 'err:' + String(e); }
      });
      if (geoState === 'success' || geoState === 'error') break;
    }
    const geoDetail = await page.evaluate(() => {
      try {
        const g = Store.state.geo;
        return { status: g.status, place: g.place ? g.place.label : null, note: g.note || null, err: g.error ? g.error.reason : null, stores: Store.state.stores.length };
      } catch (e) { return { err: String(e) }; }
    });
    report('E', '定位流程收敛（success 或明确 error，不 hang）', geoState === 'success' || geoState === 'error', JSON.stringify(geoDetail).slice(0, 200));
    report('E', '定位后门店列表刷新', (geoDetail.stores || 0) > 0, `${geoDetail.stores} 家门店`);
  }

  /* ============ Phase F：六视口溢出 ============ */
  console.log('\n===== Phase F 六视口响应式 =====');
  const widths = [320, 375, 390, 414, 768, 1440];
  for (const w of widths) {
    const p2 = await ctx.newPage();
    await p2.setViewport({ width: w, height: 800 });
    await p2.goto(SITE + '?v=audit' + t0, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p2.waitForSelector('.product-card', { timeout: 60000 }).catch(() => {});
    await sleep(2000);
    const ov = await p2.evaluate(() => {
      const de = document.documentElement;
      const overflowX = de.scrollWidth - de.clientWidth;
      const inScroller = (el) => {
        for (let n = el.parentElement; n; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
        }
        return false;
      };
      const offenders = [];
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1) && !inScroller(el)) {
          offenders.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0] || '?'}(${Math.round(r.left)}~${Math.round(r.right)})`);
        }
      });
      return { overflowX, offenders: offenders.slice(0, 5) };
    });
    report('F', `${w}px 视口无横向溢出`, ov.overflowX <= 0, `溢出 ${ov.overflowX}px${ov.offenders.length ? '；元素：' + ov.offenders.join(',') : ''}`);
    await p2.close();
  }

  /* ============ Phase G：只读 API 冒烟 ============ */
  console.log('\n===== Phase G 只读 API 冒烟 =====');
  const api = await page.evaluate(async () => {
    const out = {};
    const call = async (name, p, body) => {
      try {
        const r = await fetch(p, {
          method: body ? 'POST' : 'GET',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const j = await r.json().catch(() => ({}));
        out[name] = { status: r.status, success: j.success, error: j.error || null, hasData: !!j.data };
      } catch (e) { out[name] = { err: String(e) }; }
    };
    await call('status', '/api/status');
    await call('stores', '/api/stores', { city: '济南市', keyword: '趵突泉', beType: 1 });
    await call('nutrition', '/api/nutrition');
    await call('orderStatus', '/api/order/status', { orderId: 'AUDIT-NO-SUCH-ORDER' });
    return out;
  });
  report('G', '/api/status 返回 live', api.status && api.status.success && api.status.hasData, JSON.stringify(api.status));
  report('G', '/api/stores 门店查询（济南趵突泉）', api.stores && api.stores.success, JSON.stringify(api.stores).slice(0, 120));
  report('G', '/api/nutrition 营养表', api.nutrition && api.nutrition.success, JSON.stringify(api.nutrition).slice(0, 120));
  report('G', '/api/order/status 写门禁已放开（非 403 即达 MCP）', api.orderStatus && api.orderStatus.status !== 403, JSON.stringify(api.orderStatus).slice(0, 140));

  /* ============ 汇总 ============ */
  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过，${failed.length} 项异常 =====`);
  fs.writeFileSync(OUT, JSON.stringify({ site: SITE, at: new Date().toISOString(), consoleErrors, consoleWarnings: consoleWarnings.slice(0, 10), pageErrors, badResponses, reqLog, results }, null, 2));
  console.log('报告已写入 ' + OUT);

  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('审计脚本异常：', e);
  process.exit(2);
});
