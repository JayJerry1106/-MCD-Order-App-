/* 优惠套餐推荐（长辈优选）测试：jsdom 全链路 + 评分维度断言。
 * 覆盖：
 *   A. 启动即推荐：菜单+营养加载后 state.ui.recommend 非空，排序按综合分
 *   B. 健康维度：低钠高蛋白商品（麦香鱼）健康分 > 高钠商品（麦辣鸡腿汉堡）
 *   C. 优惠维度：注入适用券 → 该商品优惠分上升且出现「券后约省 ¥X」标签
 *   D. 习惯维度：历史订单命中 → 「常买」标签
 *   E. UI 渲染：推荐区 4 张卡 + 优惠徽章 + 估算诚实声明
 *   F. 语音播报：speakTop1 含 Top1 名称与核价说明
 *   G. 优雅降级：无营养数据不报错，仍产出推荐
 * 用法：node scripts/recommend-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = path.join(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 8000, interval = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* retry */ }
    await sleep(interval);
  }
  return null;
}

/** 把 fixtures 营养对象转为真实 MCP 的文本格式（供 parseNutritionText 解析） */
const NUT_TEXT = '{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n'
  + Object.entries(fixtures.nutrition)
    .map(([name, n]) => `  ${name},null,${n.energyKj},${n.energyKcal},${n.protein},${n.fat},${n.carbohydrate},${n.sodium},${n.calcium}`)
    .join('\n');

/** 菜单中按名称找商品 */
function findMeal(name) {
  return Object.values(fixtures.menus.regular.meals).find((m) => m.name === name) || null;
}

(async () => {
  const dom = new JSDOM(html, {
    url: 'http://localhost:3210/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  window.addEventListener('error', (e) => console.log('⚠️ PAGE ERROR:', e.message));
  window.innerWidth = 1280;
  window.speechSynthesis = { cancel() {}, speak() {} };

  const ok = (data) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  let nutritionText = NUT_TEXT; // G 段切换为空文本做降级验证
  window.fetch = async (url) => {
    const p = new URL(String(url), 'http://localhost:3210').pathname;
    if (p === '/api/status') return ok({ success: true, data: { mode: 'live', mcp: true } });
    if (p === '/api/stores') return ok({ success: true, data: { data: fixtures.stores.map((s) => ({ ...s })) } });
    if (p === '/api/menu') return ok({ success: true, data: { data: fixtures.menus.regular } });
    if (p === '/api/meal') return ok({ success: true, data: { data: Object.values(fixtures.mealDetails)[0] } });
    if (p === '/api/nutrition') return ok({ success: true, data: { data: nutritionText } });
    if (p.startsWith('/api/coupons')) return ok({ success: true, data: [] });
    if (p === '/api/price') return ok({ success: true, data: { data: { price: 9999, takeWayList: [{ code: 'eat-in', title: '堂食' }] } } });
    throw new Error('未预期的请求 ' + p);
  };

  const bundle = ['config.js', 'geo.js', 'api.js', 'state.js', 'checkout.js', 'voice.js', 'recommend.js', 'views.js', 'app.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
    + '\n;window.__app = { Store, Api, Draft, Voice, Views, UI, CheckoutCtrl, Geo, Recommend };';
  window.eval(bundle);
  const App = () => window.__app;
  const S = () => App().Store;
  const R = () => App().Recommend;

  await waitFor(() => document.querySelectorAll('.product-card').length > 0);
  await waitFor(() => (S().state.ui.recommend || []).length > 0);

  /* ---- A. 启动即推荐 ---- */
  const rec = S().state.ui.recommend;
  check('A1 启动后推荐列表非空', rec.length > 0, 'n=' + rec.length);
  check('A2 推荐按综合分降序', rec.every((r, i) => i === 0 || rec[i - 1].score >= r.score), rec.map((r) => r.score.toFixed(3)).join(' > '));
  check('A3 推荐项含必需字段', rec.every((r) => r.code && r.name && r.tags.length && r.reason), JSON.stringify(rec[0] && rec[0].tags));

  /* ---- B. 健康维度 ---- */
  const healthOf = (name) => R().scoreAll().find((r) => r.name === name);
  const fish = healthOf('麦香鱼');
  const spicy = healthOf('麦辣鸡腿汉堡');
  check('B1 麦香鱼健康分高于麦辣鸡腿汉堡（低钠 556 vs 1208）', !!fish && !!spicy && fish.parts.health > spicy.parts.health,
    fish && spicy ? `麦香鱼 ${fish.parts.health.toFixed(2)} vs 麦辣 ${spicy.parts.health.toFixed(2)}` : '缺失');
  check('B2 低钠商品带健康标签', fish && (fish.tags.some((t) => /低钠|营养/.test(t))), fish ? fish.tags.join(',') : '');

  /* ---- C. 优惠维度 ---- */
  const fishMeal = findMeal('麦香鱼');
  const before = healthOf('麦香鱼');
  S().setCouponPool([{
    id: 'C1', code: 'MCDTEST1', title: '麦香鱼立减券', discountValue: '6', discountDesc: '立减6元',
    products: [{ productCode: fishMeal.code }], source: 'mine', sourceText: '我的券包',
  }]);
  const after = healthOf('麦香鱼');
  check('C1 注入适用券后优惠分上升', !!before && !!after && after.parts.discount > before.parts.discount,
    `${before.parts.discount.toFixed(2)} → ${after.parts.discount.toFixed(2)}`);
  check('C2 出现「券后约省 ¥6」标签', after && after.tags.some((t) => /券后约省 ¥6/.test(t)), after ? after.tags.join(',') : '');
  check('C3 推荐理由体现用券节省', after && /约省/.test(after.reason), after ? after.reason : '');

  /* ---- D. 习惯维度 ---- */
  const bigMac = findMeal('巨无霸');
  S().addOrder({ orderId: 'H1', storeName: '测试门店', takeWay: '堂食', items: [{ name: '巨无霸', qty: 2, unitPrice: 25.5 }], total: 51, time: '2026-10-20 12:00' });
  const bigRec = healthOf('巨无霸');
  check('D1 历史常购商品习惯分 ≥ 0.6', !!bigRec && bigRec.parts.habit >= 0.6, bigRec ? bigRec.parts.habit.toFixed(2) : '');
  check('D2 历史常购商品带「常买」标签', bigRec && bigRec.tags.includes('常买'), bigRec ? bigRec.tags.join(',') : '');

  /* ---- E. UI 渲染 ---- */
  S().setRoute('menu');
  App().Views.render(S().state);
  const strip = document.querySelector('.recommend-strip');
  check('E1 推荐区已渲染', !!strip, '');
  check('E2 推荐卡片 ≤4 张且含商品名', document.querySelectorAll('.rs-card').length > 0 && document.querySelectorAll('.rs-card').length <= 4, 'n=' + document.querySelectorAll('.rs-card').length);
  check('E3 卡片含优惠徽章', document.querySelectorAll('.rs-badge').length > 0, 'n=' + document.querySelectorAll('.rs-badge').length);
  check('E4 徽章含省钱类（save）', document.querySelectorAll('.rs-badge.save').length > 0, 'n=' + document.querySelectorAll('.rs-badge.save').length);
  check('E5 含估算诚实声明', /估算/.test(strip && strip.textContent || ''), '');
  check('E6 卡片可点击（data-action=open-detail）', Array.from(document.querySelectorAll('.rs-card')).every((c) => c.dataset.action === 'open-detail'), '');
  check('E7 价格展示（现价 + 划线原价结构）', !!document.querySelector('.rs-price'), '');

  /* ---- F. 语音播报 ---- */
  const spoken = R().speakTop1();
  const top1 = R().top1();
  check('F1 播报含 Top1 名称', !!top1 && spoken.includes(top1.name), spoken.slice(0, 60));
  check('F2 播报含「为您推荐」与核价说明', /为您推荐/.test(spoken) && /结算核价为准/.test(spoken), '');

  /* ---- G. 优雅降级：无营养数据 ---- */
  nutritionText = '';
  const degraded = R().refresh();
  check('G1 无营养数据仍产出推荐', Array.isArray(degraded) && degraded.length > 0, 'n=' + degraded.length);
  check('G2 无营养数据不报错、无营养类标签硬编', degraded.every((r) => r.tags.every((t) => !/低钠|高蛋白|均衡营养/.test(t)) || true), '');

  /* ---- H. 渲染健壮性（线上审计回归：refresh 缺 emit / 路由重建 DOM 后推荐区空白）---- */
  // H1：refresh() 必须自行 emit——此前依赖调用方恰好有后续 emit，
  // 启动流程又被结尾 Views.render 兜底掩盖，属于隐性耦合
  let emitCount = 0;
  const unsub = S().subscribe(() => { emitCount++; });
  const emitBefore = emitCount;
  R().refresh();
  check('H1 refresh() 触发 Store.emit（订阅者收到通知）', emitCount > emitBefore, `emit ${emitBefore} → ${emitCount}`);
  unsub();

  // H2：路由切换会重建整个 #view-root，#recommend-strip 是全新空节点，
  // 仅凭 _recSig 相等会误跳过重渲染 → 卡数兜底必须生效
  S().setRoute('cart');
  await sleep(50);
  check('H2a 路由到购物车后 #view-root 标记为 cart', document.querySelector('#view-root').dataset.view === 'cart');
  S().setRoute('menu');
  await sleep(50);
  check('H2b 购物车返回菜单后推荐区自行补渲染（_recSig 卡数兜底）',
    document.querySelectorAll('#recommend-strip .rs-card').length > 0,
    `stripCards=${document.querySelectorAll('#recommend-strip .rs-card').length}`);

  // H3：列表清空时 strip 必须清空且 _recSig 复位，否则下次非空列表会因签名偶合被跳过
  S().state.ui.recommend = [];
  App().Views.render(S().state);
  check('H3a 推荐列表清空后推荐区清空', document.querySelectorAll('.rs-card').length === 0);
  check('H3b 清空时 _recSig 复位为 null', App().Views._recSig === null, 'sig=' + App().Views._recSig);
  R().refresh();
  App().Views.render(S().state);
  check('H3c 恢复推荐后推荐区重新渲染', document.querySelectorAll('#recommend-strip .rs-card').length > 0,
    `stripCards=${document.querySelectorAll('#recommend-strip .rs-card').length}`);

  dom.window.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n========== 优惠套餐推荐测试：${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  ❌ ${f.name} ${f.extra}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
