/* 麦乐送（外卖配送）模块测试：jsdom 全链路 + 服务端路由校验。
 * 覆盖：
 *   A. 路由一致性：server.js 与 Pages Function 的配送路由成对存在
 *   B. 服务端校验：麦乐送下单缺 addressId/beCode → 400；手机号格式校验
 *   C. 前端全链路：切换到麦乐送 → 加载地址 → 选地址 → 查配送门店(beCode) →
 *      切换门店并按 orderType=2 重拉菜单 → 核价透传 → 下单透传 → 订单状态查询
 *   D. 到店自取口径：不传 addressId/beCode，takeWayCode 正常透传
 *   E. 输入校验：备注截断 50 字、地址表单校验
 * 用法：node scripts/delivery-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
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

/* ================= A. 路由一致性（静态解析） ================= */
function routeParity() {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const fnSrc = fs.readFileSync(path.join(ROOT, 'functions/api/[[path]].js'), 'utf8');
  const serverRoutes = [...serverSrc.matchAll(/'(GET|POST) (\/api\/[^']+)':/g)].map((m) => `${m[1]} ${m[2]}`);
  const fnRoutes = [...fnSrc.matchAll(/'(GET|POST) (\/api\/[^']+)':/g)].map((m) => `${m[1]} ${m[2]}`);
  const deliveryRoutes = ['GET /api/delivery/addresses', 'POST /api/delivery/addresses', 'POST /api/delivery/stores', 'POST /api/order/status'];
  check('A1 server.js 含全部配送路由', deliveryRoutes.every((r) => serverRoutes.includes(r)), serverRoutes.filter((r) => r.includes('delivery') || r.includes('order')).join(' | '));
  check('A2 Pages Function 含全部配送路由', deliveryRoutes.every((r) => fnRoutes.includes(r)), fnRoutes.filter((r) => r.includes('delivery') || r.includes('order')).join(' | '));
  const missing = serverRoutes.filter((r) => r !== 'GET /api/status' && !fnRoutes.includes(r));
  check('A3 双实现路由集合一致（server ⊆ function，status 由 Function 内联处理）', missing.length === 0, missing.join(',') || '一致');
  check('A4 下单路由透传 reservationDate', /reservationDate/.test(serverSrc) && /reservationDate/.test(fnSrc));
}

/* ================= B. 服务端校验（spawn 真实 server.js） ================= */
async function serverValidation() {
  const port = 3399;
  const proc = require('child_process').spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), MCD_MCP_TOKEN: 'x'.repeat(32), MCD_MCP_URL: 'http://127.0.0.1:3398/' },
    stdio: 'ignore',
  });
  // 假 MCP：记录调用，返回结构化内容
  const mcpCalls = [];
  const mcp = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      mcpCalls.push(body.params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { data: [] } } }));
    });
  });
  await new Promise((r) => mcp.listen(3398, r));
  await waitFor(async () => {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/status`); return r.ok; } catch (_) { return false; }
  });

  const post = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  try {
    // B1 麦乐送下单缺 addressId → 400
    let r = await post('/api/order', { storeCode: 'S1', orderType: 2, beType: 2, beCode: 'B1', items: [{ productCode: 'P1', quantity: 1 }] });
    check('B1 麦乐送缺 addressId 被服务端拦截', r.status === 400, `status=${r.status}`);
    // B2 麦乐送缺 beCode → 400
    r = await post('/api/order', { storeCode: 'S1', orderType: 2, beType: 2, addressId: 'A1', items: [{ productCode: 'P1', quantity: 1 }] });
    check('B2 麦乐送缺 beCode 被服务端拦截', r.status === 400, `status=${r.status}`);
    // B3 新增地址手机号格式错误 → 400
    r = await post('/api/delivery/addresses', { address: '朝阳区', addressDetail: '502', city: '北京市', contactName: '张三', phone: '123' });
    check('B3 手机号格式错误被拦截', r.status === 400, `status=${r.status}`);
    // B4 合法麦乐送下单 → 透传到 MCP
    mcpCalls.length = 0;
    r = await post('/api/order', {
      storeCode: 'S1', orderType: 2, beType: 2, beCode: 'B1', addressId: 'A1',
      items: [{ productCode: 'P1', quantity: 1 }], needTableware: true,
      remark: '少辣', reservationDate: '2026-10-22 18:30',
    });
    const call = mcpCalls.find((c) => c.name === 'create-order');
    check('B4 合法麦乐送下单成功', r.status === 200 && !!call, `status=${r.status}`);
    check('B5 下单透传 orderType=2/beType=2/beCode/addressId',
      call && call.arguments.orderType === 2 && call.arguments.beType === 2
      && call.arguments.beCode === 'B1' && call.arguments.addressId === 'A1',
      call ? JSON.stringify(call.arguments).slice(0, 160) : '');
    check('B6 麦乐送不传 takeWayCode', call && call.arguments.takeWayCode === undefined, call ? 'takeWayCode=' + call.arguments.takeWayCode : '');
    check('B7 配送时间/备注透传', call && call.arguments.reservationDate === '2026-10-22 18:30' && call.arguments.remark === '少辣', '');
    // B8 订单状态查询 → query-order {orderId}
    mcpCalls.length = 0;
    r = await post('/api/order/status', { orderId: 'O123' });
    const q = mcpCalls.find((c) => c.name === 'query-order');
    check('B8 订单状态查询透传 orderId', r.status === 200 && q && q.arguments.orderId === 'O123', '');
    // B9 配送门店查询 → delivery-query-stores {addressId, beType=2}
    mcpCalls.length = 0;
    r = await post('/api/delivery/stores', { addressId: 'A1' });
    const ds = mcpCalls.find((c) => c.name === 'delivery-query-stores');
    check('B9 配送门店查询透传 addressId/beType=2', r.status === 200 && ds && ds.arguments.addressId === 'A1' && ds.arguments.beType === 2, '');
    // B10 地址列表 → delivery-query-addresses 无参
    mcpCalls.length = 0;
    r = await post('/api/delivery/addresses', null);
    const qa = mcpCalls.find((c) => c.name === 'delivery-query-addresses');
    check('B10 地址列表路由可达', r.status === 200 && !!qa, '');
  } finally {
    proc.kill();
    mcp.close();
  }
}

/* ================= C/D/E. 前端全链路（jsdom） ================= */
(async () => {
  console.log('—— A. 路由一致性 ——');
  routeParity();

  console.log('—— B. 服务端校验（真实 server.js + 假 MCP） ——');
  await serverValidation();

  console.log('—— C. 前端全链路（jsdom） ——');
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

  // 与真实 MCP 结构一致：地址为 { data: { addresses: [...] } }，含 fullAddress；配送门店含 reservationTimeOptions
  const ADDRESSES = [
    { addressId: 'A1', contactName: '张三', phone: '138****8000', fullAddress: '北京市朝阳区建国路 88 号 SOHO 现代城 1 号楼 502' },
    { addressId: 'A2', contactName: '李四', phone: '139****9000', fullAddress: '北京市海淀区中关村大街 1 号 海龙大厦 3 层' },
  ];
  const DELIVERY_STORES = [
    { storeCode: 'D9001', storeName: '麦当劳(建国路餐厅)', address: '朝阳区建国路 88 号', businessStartTime: '07:00', businessEndTime: '23:00', businessStatus: true, distance: 1200, beCode: 'B9001', reservation: true, reservationTimeOptions: [
      { date: '2026-10-22', today: true, reservationOptionText: '下午茶(15:00至17:29)，夜市(17:30至23:59)' },
      { date: '2026-10-23', today: false, reservationOptionText: '早餐(07:30至10:59)，午餐(11:00至14:59)' },
    ] },
    { storeCode: 'D9002', storeName: '麦当劳(大悦城餐厅)', address: '朝阳区朝阳北路 101 号', businessStartTime: '07:00', businessEndTime: '22:30', businessStatus: true, distance: 2400, beCode: 'B9002' },
  ];

  const requests = [];
  const ok = (data) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  window.fetch = async (url, options) => {
    const p = new URL(String(url), 'http://localhost:3210').pathname;
    let body = {};
    if (options && options.body) { try { body = JSON.parse(options.body); } catch (_) { /* ignore */ } }
    requests.push({ path: p, method: (options && options.method) || 'GET', body });
    if (p === '/api/status') return ok({ success: true, data: { mode: 'live', mcp: true } });
    if (p === '/api/stores') return ok({ success: true, data: { data: fixtures.stores.map((s) => ({ ...s })) } });
    if (p === '/api/menu') return ok({ success: true, data: { data: fixtures.menus.regular } });
    if (p === '/api/meal') return ok({ success: true, data: { data: Object.values(fixtures.mealDetails)[0] } });
    if (p === '/api/nutrition') return ok({ success: true, data: { data: fixtures.nutrition } });
    if (p === '/api/coupons/available') return ok({ success: true, data: fixtures.coupons.available });
    if (p === '/api/coupons/mine') return ok({ success: true, data: { coupons: fixtures.coupons.mine } });
    if (p === '/api/coupons/store') return ok({ success: true, data: fixtures.coupons.store });
    if (p === '/api/price') return ok({ success: true, data: { data: {
      productOriginalPrice: 5000, productPrice: 4500, price: 9999, discount: 0,
      packingPrice: 200, deliveryPrice: 500, tablewarePrice: 0,
      takeWayList: [{ code: 'eat-in', title: '堂食' }, { code: 'take-in-store', title: '外带' }],
      enjoyable: null,
    } } });
    if (p === '/api/order') return ok({ success: true, data: { data: { orderId: 'ORD9001', pickupCode: '7788', status: '待配送' } } });
    if (p === '/api/order/status') return ok({ success: true, data: { data: { orderId: body.orderId, status: '配送中', deliveryStatus: '骑士已取餐', estimateTime: '预计 30 分钟送达', riderName: '王骑士' } } });
    if (p === '/api/delivery/addresses') {
      if (requests.filter((r) => r.path === '/api/delivery/addresses').length > 1 && body && body.contactName) {
        // create 之后的 list 请求：返回含新地址
        return ok({ success: true, data: { addresses: [...ADDRESSES, { addressId: 'A3', contactName: body.contactName, phone: body.phone, fullAddress: (body.city || '') + (body.address || '') + ' ' + (body.addressDetail || '') }] } });
      }
      return ok({ success: true, data: { addresses: ADDRESSES.map((a) => ({ ...a })) } });
    }
    if (p === '/api/delivery/stores') return ok({ success: true, data: { data: DELIVERY_STORES.map((s) => ({ ...s })) } });
    throw new Error('未预期的请求 ' + p);
  };

  const bundle = ['config.js', 'geo.js', 'api.js', 'state.js', 'checkout.js', 'voice.js', 'recommend.js', 'views.js', 'app.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
    + '\n;window.__app = { Store, Api, Draft, Voice, Views, UI, CheckoutCtrl, Geo };';
  window.eval(bundle);
  const App = () => window.__app;
  const S = () => App().Store;
  const CO = () => App().CheckoutCtrl;

  await waitFor(() => document.querySelectorAll('.product-card').length > 0);

  /* ---- C1 切换到麦乐送：自动加载地址 ---- */
  requests.length = 0;
  await CO().setDeliveryMode('delivery');
  await waitFor(() => S().state.ui.checkout.delivery.addressesLoaded && S().state.ui.checkout.delivery.beCode === 'B9001');
  check('C1 切换到麦乐送触发地址加载', requests.some((r) => r.path === '/api/delivery/addresses'), '');
  check('C2 地址已加载且默认选中第一个', S().state.ui.checkout.delivery.addresses.length === 2 && S().state.ui.checkout.delivery.addressId === 'A1', 'addressId=' + S().state.ui.checkout.delivery.addressId);
  check('C3 配送门店查询入参 addressId + beType=2', requests.some((r) => r.path === '/api/delivery/stores' && r.body.addressId === 'A1' && r.body.beType === 2), '');
  check('C4 选中配送门店写入 beCode', S().state.ui.checkout.delivery.beCode === 'B9001', 'beCode=' + S().state.ui.checkout.delivery.beCode);
  check('C5 当前门店切换为配送门店', S().state.store.storeCode === 'D9001' && S().state.store._delivery === true, S().state.store.storeCode);
  const menuReq = requests.find((r) => r.path === '/api/menu');
  check('C6 菜单按配送口径重拉（orderType=2 + beCode）', menuReq && menuReq.body.orderType === 2 && menuReq.body.beType === 2 && menuReq.body.beCode === 'B9001', menuReq ? JSON.stringify(menuReq.body) : '无 /api/menu 请求');

  /* ---- C7 手动改选另一个地址 ---- */
  requests.length = 0;
  await CO().pickAddress('A2');
  await waitFor(() => S().state.ui.checkout.delivery.addressId === 'A2' && S().state.ui.checkout.delivery.storesLoaded);
  check('C7 手动选址触发配送门店查询（addressId=A2）', requests.some((r) => r.path === '/api/delivery/stores' && r.body.addressId === 'A2' && r.body.beType === 2), '');
  check('C8 改选后 beCode 仍有效', S().state.ui.checkout.delivery.beCode === 'B9001', 'beCode=' + S().state.ui.checkout.delivery.beCode);

  /* ---- C9 加购并核价：配送参数透传 ---- */
  S().addToCart({ code: 'M1', name: '巨无霸', image: '', basePrice: 23, originalPrice: 23, qty: 1, unitPrice: 23, rounds: [], mods: [] });
  requests.length = 0;
  await CO().goPrice();
  const priceReq = requests.find((r) => r.path === '/api/price');
  check('C9 核价透传 orderType=2/beType=2/beCode', priceReq && priceReq.body.orderType === 2 && priceReq.body.beType === 2 && priceReq.body.beCode === 'B9001', priceReq ? JSON.stringify(priceReq.body).slice(0, 140) : '');

  /* ---- C10 下单：配送参数透传 + 无 takeWayCode ---- */
  requests.length = 0;
  S().patchDelivery({ remark: '少辣', reservationDate: '2026-10-22 18:30' });
  await CO().confirmOrder({ dataset: {}, set innerHTML(v) {}, set disabled(v) {} });
  const orderReq = requests.find((r) => r.path === '/api/order');
  check('C10 下单透传配送参数', orderReq && orderReq.body.orderType === 2 && orderReq.body.beType === 2 && orderReq.body.beCode === 'B9001' && orderReq.body.addressId === 'A2', orderReq ? JSON.stringify(orderReq.body).slice(0, 200) : '');
  check('C11 配送下单不传 takeWayCode', orderReq && orderReq.body.takeWayCode === undefined, '');
  check('C12 配送时间/备注透传', orderReq && orderReq.body.reservationDate === '2026-10-22 18:30' && orderReq.body.remark === '少辣', '');
  check('C13 下单后进入第 4 步', S().state.ui.checkout.step === 4, 'step=' + S().state.ui.checkout.step);
  const orderRec = S().state.orders[0];
  check('C14 本地订单记录含配送信息', !!orderRec && !!orderRec.delivery && orderRec.takeWay === '麦乐送', JSON.stringify(orderRec && orderRec.takeWay));

  /* ---- C15 订单状态查询 ---- */
  requests.length = 0;
  await CO().queryStatus('ORD9001');
  const stReq = requests.find((r) => r.path === '/api/order/status');
  check('C15 订单状态查询入参 orderId', stReq && stReq.body.orderId === 'ORD9001', '');
  check('C16 状态结果写入并含配送进度', S().state.ui.checkout.delivery.statusResult && S().state.ui.checkout.delivery.statusResult.deliveryStatus === '骑士已取餐', JSON.stringify(S().state.ui.checkout.delivery.statusResult || {}));

  /* ---- D. 回到到店自取口径 ---- */
  await CO().setDeliveryMode('takeout');
  await waitFor(() => S().state.ui.checkout.delivery.mode === 'takeout');
  check('D1 切回自取清空配送选择', S().state.ui.checkout.delivery.beCode === '' && S().state.ui.checkout.delivery.addressId === '', '');
  requests.length = 0;
  await CO().confirmOrder({ dataset: {}, set innerHTML(v) {}, set disabled(v) {} });
  const tReq = requests.find((r) => r.path === '/api/order');
  check('D2 自取下单不带配送参数', tReq && tReq.body.orderType === 1 && !tReq.body.beCode && !tReq.body.addressId, tReq ? JSON.stringify(tReq.body).slice(0, 160) : '');
  check('D3 自取下单透传 takeWayCode', tReq && !!tReq.body.takeWayCode, 'takeWayCode=' + (tReq && tReq.body.takeWayCode));

  /* ---- E. 输入校验 ---- */
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  CO().openAddressForm();
  document.getElementById('af-contact').value = '王五';
  document.getElementById('af-phone').value = '13700137000';
  document.getElementById('af-city').value = '北京市';
  document.getElementById('af-address').value = '丰台区南三环西路 1 号';
  document.getElementById('af-detail').value = ' Map 测试小区 2 单元 301';
  requests.length = 0;
  await CO().saveAddress();
  await waitFor(() => S().state.ui.checkout.delivery.addresses.some((a) => a.contactName === '王五'), 4000);
  check('E1 合法地址保存成功并自动选中', requests.some((r) => r.path === '/api/delivery/addresses' && r.method === 'POST' && r.body.contactName === '王五'), '');
  check('E2 新地址自动进入配送门店查询', S().state.ui.checkout.delivery.beCode === 'B9001', 'beCode=' + S().state.ui.checkout.delivery.beCode);

  // 手机号不合法：saveAddress 内部拦截（不发起请求）
  requests.length = 0;
  CO().openAddressForm();
  document.getElementById('af-contact').value = '赵六';
  document.getElementById('af-phone').value = '12345';
  document.getElementById('af-city').value = '北京市';
  document.getElementById('af-address').value = '西城区西单北大街 1 号';
  document.getElementById('af-detail').value = '测试大厦 801';
  await CO().saveAddress();
  check('E3 手机号不合法被前端拦截', !requests.some((r) => r.path === '/api/delivery/addresses' && r.method === 'POST'), 'requests=' + requests.length);

  /* ---- F. UI 渲染断言 ---- */
  // 前置：恢复购物车（此前下单已清空）与配送模式
  S().addToCart({ code: 'M1', name: '巨无霸', image: '', basePrice: 23, originalPrice: 23, qty: 1, unitPrice: 23, rounds: [], mods: [] });
  S().patchCheckout({ step: 1, orderResult: null });
  await CO().setDeliveryMode('delivery');
  await waitFor(() => S().state.ui.checkout.delivery.addressesLoaded && S().state.ui.checkout.delivery.beCode);
  S().setRoute('checkout');
  CO().render(S().state);
  const panel = document.querySelector('.delivery-panel');
  check('F1 结算页渲染配送面板', !!panel, '');
  check('F2 配送面板含地址列表', (document.querySelectorAll('.addr-opt').length || 0) >= 2, 'n=' + (document.querySelectorAll('.addr-opt').length || 0));
  check('F3 配送面板含配送时间输入', !!document.getElementById('delivery-time'), '');
  check('F4 配送面板含备注输入且限长 50', !!document.getElementById('delivery-remark') && document.getElementById('delivery-remark').getAttribute('maxlength') === '50', '');
  check('F5 模式卡片含「麦乐送」', /麦乐送/.test(document.querySelector('#view-root').textContent), '');
  const slotBtns = Array.from(document.querySelectorAll('.dp-slot'));
  check('F6 时段快选：立即送出 + 门店可约时段', slotBtns.length >= 3 && slotBtns.some((b) => /立即送出/.test(b.textContent)), 'n=' + slotBtns.length + ' → ' + slotBtns.map((b) => b.textContent.trim()).join(' | '));
  check('F7 时段快选含今天下午茶时段', slotBtns.some((b) => /今天\s*下午茶\s*15:00/.test(b.textContent)), '');
  // 点击时段 chip → reservationDate 写入 MCP 格式
  const teaSlot = slotBtns.find((b) => /下午茶/.test(b.textContent));
  teaSlot.click();
  check('F8 点击时段写入 reservationDate（yyyy-MM-dd HH:mm）', S().state.ui.checkout.delivery.reservationDate === '2026-10-22 15:00', S().state.ui.checkout.delivery.reservationDate);
  // 自定义时间输入：T 分隔转空格分隔
  const timeInput = document.getElementById('delivery-time');
  timeInput.value = '2026-10-23T11:30';
  timeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('F9 自定义时间格式转换为 MCP 格式', S().state.ui.checkout.delivery.reservationDate === '2026-10-23 11:30', S().state.ui.checkout.delivery.reservationDate);
  check('F10 地址展示兼容 fullAddress 字段', /SOHO 现代城/.test(document.querySelector('#view-root').textContent), '');

  /* ---- G. 本轮审计修复回归 ----
   * G1-G4  getDeliveryStores 形状兼容：MCP 信封有四种形态，此前对 {stores:[...]}
   *        走 Object.values 会得到嵌套数组，stores[0].beCode 取不到（线上复现）
   * G5-G8  切换取餐模式必须重置券态（自取 beType=1 / 麦乐送 beType=2+beCode 两套口径，
   *        线上复现：切模式后 couponsLoaded 仍为 true，第 2 步沿用另一口径的券）
   * G9-G12 麦乐送前置校验：未选地址/无 beCode 时第 1 步下一步禁用 + 内联提示，
   *        且 app.js 侧有兜底守卫（禁用态被绕过时也不得进入第 2 步）
   */
  const origFetch = window.fetch;
  const shapes = [
    ['裸数组', [DELIVERY_STORES[0]]],
    ['{data:[...]}', { data: [DELIVERY_STORES[0]] }],
    ['{stores:[...]}', { stores: [DELIVERY_STORES[0]] }],
    ['{data:{stores:[...]}}', { data: { stores: [DELIVERY_STORES[0]] } }],
  ];
  for (let i = 0; i < shapes.length; i++) {
    const [label, data] = shapes[i];
    window.fetch = async () => ok({ success: true, data });
    const list = await App().Api.getDeliveryStores('A1');
    check(`G${i + 1} getDeliveryStores 兼容「${label}」形态`,
      Array.isArray(list) && list.length === 1 && list[0].beCode === 'B9001',
      JSON.stringify(list).slice(0, 90));
  }
  window.fetch = origFetch;

  // 先按麦乐送口径加载券池，再填入已选券/可领券/核价结果，随后切换模式应全部重置
  S().patchCheckout({ step: 2, orderResult: null, coupon: null, claimable: [], priceResult: null });
  CO().render(S().state);
  await waitFor(() => S().state.ui.checkout.couponsLoaded && (S().state.ui.checkout.coupons || []).length > 0);
  check('G5 第 2 步券池加载完成（麦乐送口径）', (S().state.ui.checkout.coupons || []).length > 0,
    'n=' + (S().state.ui.checkout.coupons || []).length);
  S().patchCheckout({ coupon: { id: 'USED', title: '已选券' }, claimable: [{ id: 'CLAIM' }], priceResult: { price: 123 } });
  S().patchCheckout({ step: 1 }); // 回第 1 步，避免切换后 render 立即重载券干扰断言
  await CO().setDeliveryMode('takeout');
  const c1 = S().state.ui.checkout;
  check('G6 切回自取重置券态（coupons/couponsLoaded/claimable/coupon/priceResult）',
    c1.coupons.length === 0 && c1.couponsLoaded === false && c1.claimable.length === 0
    && c1.coupon === null && c1.priceResult === null,
    `coupons=${c1.coupons.length}, loaded=${c1.couponsLoaded}, claimable=${c1.claimable.length}, coupon=${c1.coupon}, price=${c1.priceResult}`);
  requests.length = 0;
  await CO().setDeliveryMode('delivery');
  await waitFor(() => S().state.ui.checkout.delivery.beCode === 'B9001');
  const c2 = S().state.ui.checkout;
  check('G7 切入麦乐送重置券态（coupons/couponsLoaded/claimable/coupon）',
    c2.coupons.length === 0 && c2.couponsLoaded === false && c2.claimable.length === 0
    && c2.coupon === null,
    `coupons=${c2.coupons.length}, loaded=${c2.couponsLoaded}, claimable=${JSON.stringify(c2.claimable)}, coupon=${JSON.stringify(c2.coupon)}`);
  // priceResult 会被 pickAddress 的「配送口径预核价」立即重算（设计行为，含打包费），
  // 关键前提：该重算必须走 orderType=2/beType=2/beCode，而非沿用自取口径
  const dPriceReq = requests.find((r) => r.path === '/api/price');
  check('G7b 切入后核价按配送口径重算（orderType=2/beType=2/beCode）',
    c2.priceResult === null || (!!dPriceReq && dPriceReq.body.orderType === 2 && dPriceReq.body.beType === 2 && dPriceReq.body.beCode === 'B9001'),
    dPriceReq ? JSON.stringify(dPriceReq.body).slice(0, 150) : 'priceResult=' + JSON.stringify(c2.priceResult));
  check('G8 切入麦乐送后地址/门店就绪', c2.delivery.addressId === 'A1' && c2.delivery.beCode === 'B9001',
    `addressId=${c2.delivery.addressId}, beCode=${c2.delivery.beCode}`);

  // 麦乐送前置校验：清掉地址与 beCode（保留 addressesLoaded 防止 render 触发重载）
  S().patchDelivery({ addressesLoaded: true, addressId: '', beCode: '' });
  S().patchCheckout({ step: 1 });
  CO().render(S().state);
  const nextBtn = Array.from(document.querySelectorAll('[data-action="checkout-next"]'))
    .find((b) => /下一步/.test(b.textContent));
  check('G9 麦乐送未选地址时下一步禁用', !!nextBtn && nextBtn.disabled === true,
    'disabled=' + (nextBtn && nextBtn.disabled));
  check('G10 禁用时展示内联红字提示', /请先选择配送地址与可配送门店/.test(document.querySelector('#view-root').textContent), '');
  // 兜底守卫：禁用态被绕过（如竞态/自动化）时派发冒泡点击，也不得进入第 2 步
  nextBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check('G11 兜底守卫：绕过禁用态点击不进入第 2 步', S().state.ui.checkout.step === 1,
    'step=' + S().state.ui.checkout.step);
  S().patchDelivery({ addressId: 'A1', beCode: 'B9001' });
  CO().render(S().state);
  const nextBtn2 = Array.from(document.querySelectorAll('[data-action="checkout-next"]'))
    .find((b) => /下一步/.test(b.textContent));
  check('G12 地址门店就绪后下一步恢复可用且提示消失',
    !!nextBtn2 && nextBtn2.disabled === false && !/请先选择配送地址/.test(document.querySelector('#view-root').textContent),
    'disabled=' + (nextBtn2 && nextBtn2.disabled));

  dom.window.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n========== 麦乐送配送模块测试：${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  ❌ ${f.name} ${f.extra}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
