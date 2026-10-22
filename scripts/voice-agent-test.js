/* 语音智能体回归测试：唤醒模式门控 + 新意图（推荐/地址/订单状态/配送）+ TTS 回声抑制 + 既有意图兼容。
 * 覆盖：
 *   A 唤醒门控：continuous 生效 / 未唤醒拦截 / 唤醒词应答 / 30 秒窗口免唤醒 / 窗口过期回退 /
 *              唤醒词+指令一体 / 关闭唤醒复位
 *   B onend 续听：唤醒模式自动重启 / 关闭浮层不重启 / 麦克风损坏不无限重试 / 重试按钮恢复
 *   C NLU 新意图：查询订单（有/无记录）/ 优惠推荐 / 我的地址 / 配送时间 / 送到家（有车/空车）/
 *                 帮助文本 / 快捷指令
 *   D TTS 回声抑制：唤醒模式播报时暂停识别、播报结束恢复 / 普通模式不打断
 *   E 既有意图兼容：去结算 / 加入购物车 / 打开购物车
 * 用法：node scripts/voice-agent-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 伪造 SpeechRecognition：记录 start 次数，可手动注入识别结果 */
const SRInstances = [];
class FakeSR {
  constructor() {
    this.lang = ''; this.interimResults = false; this.continuous = false;
    this.onresult = null; this.onerror = null; this.onend = null;
    this.started = false; this.startCount = 0;
    SRInstances.push(this);
  }
  start() {
    if (this.started) throw new Error('InvalidStateError');
    this.started = true; this.startCount++;
  }
  stop() { this.started = false; }
  /** 模拟一次识别结果（final=true 走命令分派）。
   *  真实 SpeechRecognitionResult 既是备选列表又带 isFinal 属性，这里如实复刻。 */
  emit(text, final = true) {
    if (!this.onresult) return;
    const alts = [{ transcript: text }];
    alts.isFinal = final;
    this.onresult({ results: [alts] });
  }
  /** 模拟浏览器结束识别会话：先置为未运行，再触发 onend（与真实时序一致） */
  endSession() { this.stop(); if (this.onend) this.onend(); }
}
const lastSR = () => SRInstances[SRInstances.length - 1];

const calls = {
  openDetail: [], queryOrderStatus: [], getDeliveryAddresses: [], go: [],
  enter: 0, setDeliveryMode: [], addToCart: [], speak: [], toast: [],
};
const utterances = [];

(async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3210/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;

  /* ---- 浏览器 API mock ---- */
  window.SpeechRecognition = FakeSR; // 必须在 eval 前注入，Voice.supported 才为 true
  window.speechSynthesis = { cancel() {}, speak(u) { calls.speak.push(u.text); } };
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.onend = null; utterances.push(this); }
  };
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    get() { return { query: async () => ({ state: 'granted', onchange: null }) }; },
  });

  /* ---- 应用依赖 mock（各模块自身行为由对应套件覆盖，这里只验证 voice.js 编排逻辑） ---- */
  const storeState = {
    menu: {
      meals: {
        '1': { code: '1', name: '巨无霸', price: 25 },
        '2': { code: '2', name: '薯条', price: 11 },
      },
    },
    cart: [], orders: [], stores: [],
    ui: { detailCode: null, checkout: { delivery: { mode: 'takeout' } }, recommend: [] },
  };
  window.Store = {
    state: storeState,
    cartCount: () => storeState.cart.reduce((s, l) => s + l.qty, 0),
    cartSubtotal: () => storeState.cart.reduce((s, l) => s + l.unitPrice * l.qty, 0),
    clearCart() { storeState.cart = []; },
    addToCart(l) { calls.addToCart.push(l); },
    openDetail(code) { calls.openDetail.push(code); storeState.ui.detailCode = code; },
    closeDetail() { storeState.ui.detailCode = null; },
    resetCheckout() {}, patchCheckout() {}, patchDelivery() {}, setStorePicker() {},
  };
  window.Draft = {
    d: null,
    buildCartLine() { return { name: '巨无霸', qty: (this.d && this.d.qty) || 1, unitPrice: 25 }; },
  };
  window.UI = { toast: (m) => calls.toast.push(m) };
  window.Api = {
    async queryOrderStatus(id) {
      calls.queryOrderStatus.push(id);
      return { status: '配送中', deliveryStatus: '骑士已取餐', estimateTime: '约30分钟', riderName: '王骑士' };
    },
    async getDeliveryAddresses() {
      calls.getDeliveryAddresses.push(1);
      return { addresses: [{ addressId: 'A1', contactName: '张阿姨', phone: '138****1234', fullAddress: '幸福路 1 号 3 栋' }] };
    },
  };
  window.Recommend = {
    top1() { return { name: '麦香鱼套餐', price: 21, tags: ['低钠优选'], reason: '少盐更健康' }; },
    speakTop1() { return '为您推荐「麦香鱼套餐」，现价 21 元，低钠优选。少盐更健康。最终价格以结算核价为准。'; },
  };
  window.CheckoutCtrl = {
    async enter() { calls.enter++; },
    async setDeliveryMode(m) { calls.setDeliveryMode.push(m); },
    async claim() {},
  };
  window.go = (v) => calls.go.push(v);
  window.estimateUnitPrice = (m) => m.price || 0;

  const bundle = ['config.js', 'voice.js'].map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
    + '\n;window.__voice = { Voice };';
  window.eval(bundle);
  const Voice = window.__voice.Voice;

  Voice._envOverrides = { secure: true, iframe: false, webview: false };
  Voice.init();
  const status = () => document.querySelector('#voice-status').textContent;
  const replyText = () => document.querySelector('#voice-reply').textContent;
  const openOverlay = async () => { Voice.open(); await sleep(60); };
  // 识别结果 → _dispatch（350ms）→ 部分意图再经一层 350ms 定时器，默认等待需覆盖两级
  const say = async (text, wait = 450) => { lastSR().emit(text); await sleep(wait); };

  /* ===== A. 唤醒门控 ===== */
  await openOverlay();
  const sr = lastSR();
  check('A0 初始：识别已启动', sr.startCount === 1 && sr.started, 'start=' + sr.startCount);

  Voice.setWakeMode(true);
  check('A1 开启唤醒：continuous 生效', sr.continuous === true);
  check('A1 开启唤醒：状态提示唤醒词', /唤醒模式已开启/.test(status()) && /你好麦麦/.test(status()), status());
  await sleep(400);
  check('A1 开启唤醒：识别重启续听', sr.started && sr.startCount === 2, 'start=' + sr.startCount);

  await say('我想吃巨无霸');
  check('A2 未唤醒：指令被拦截', calls.openDetail.length === 0, JSON.stringify(calls.openDetail));
  check('A2 未唤醒：提示等待唤醒', /等待唤醒/.test(status()), status());

  await say('你好麦麦', 800); // 唤醒应答走两级定时器（识别 350ms + 应答 350ms）
  check('A3 唤醒词：语音应答「我在」', /我在/.test(replyText()), replyText());
  check('A3 唤醒词：对话窗口已开启', Voice._isAwake());

  calls.go.length = 0;
  await say('打开购物车');
  check('A4 窗口内：免唤醒词执行指令', calls.go.includes('cart'), JSON.stringify(calls.go));
  check('A4 窗口内：播报购物车摘要', /购物车/.test(replyText()), replyText());

  Voice._awakeUntil = 0; // 模拟 30 秒对话窗口过期
  calls.go.length = 0;
  await say('打开购物车');
  check('A5 窗口过期：回到等待唤醒', calls.go.length === 0 && /等待唤醒/.test(status()), status());

  calls.openDetail.length = 0;
  await say('你好麦麦我想吃巨无霸');
  check('A6 唤醒词+指令一体：直接执行', calls.openDetail.includes('1'), JSON.stringify(calls.openDetail));

  Voice.setWakeMode(false);
  check('A7 关闭唤醒：continuous 复位', sr.continuous === false);
  check('A7 关闭唤醒：状态提示已关闭', /唤醒模式已关闭/.test(status()), status());

  /* ===== B. onend 续听 ===== */
  Voice.setWakeMode(true);
  await sleep(400);
  const srB = lastSR();
  const startsBefore = srB.startCount;
  srB.endSession(); // 浏览器静音超时结束会话 → onend
  check('B1 唤醒模式 onend：识别会话已结束', srB.started === false);
  await sleep(600);
  check('B1 唤醒模式 onend：自动重启续听', srB.started && srB.startCount === startsBefore + 1, 'start=' + srB.startCount);

  Voice.close();
  await sleep(50);
  const startsAfterClose = srB.startCount;
  srB.endSession();
  await sleep(600);
  check('B2 关闭浮层：不再续听', srB.startCount === startsAfterClose, 'start=' + srB.startCount);

  await openOverlay(); // 唤醒模式仍开启：重开应恢复
  check('B3 重开浮层：恢复唤醒模式提示', /唤醒模式已开启/.test(status()), status());
  Voice.showMicIssue('audio-capture');
  const startsBroken = srB.startCount;
  srB.endSession();
  await sleep(600);
  check('B3 麦克风损坏：停止续听（不无限重试）', srB.startCount === startsBroken, 'start=' + srB.startCount);
  check('B3 麦克风损坏：诊断行可见', document.querySelector('#voice-mic-fix').hidden === false);

  Voice.setWakeMode(false);
  document.querySelector('#voice-retry-btn').click();
  await sleep(80);
  check('B4 重试按钮：环境恢复后重新识别', srB.started && srB.startCount === startsBroken + 1, 'start=' + srB.startCount);

  /* ===== C. NLU 新意图（非唤醒模式直接执行） ===== */
  storeState.orders = [{ orderId: 'ORD123', status: '待配送', delivery: { addressText: { contactName: '张阿姨' } } }];
  calls.queryOrderStatus.length = 0;
  await say('查询订单');
  check('C1 订单状态：调用 Api 查询', calls.queryOrderStatus.includes('ORD123'), JSON.stringify(calls.queryOrderStatus));
  check('C1 订单状态：播报骑士与预计时间', /ORD123/.test(replyText()) && /王骑士/.test(replyText()) && /30分钟/.test(replyText()), replyText());

  storeState.orders = [];
  await say('查询订单');
  check('C2 无订单记录：友好提示', /还没有下单/.test(replyText()), replyText());

  await say('有什么推荐');
  check('C3 推荐意图：播报 Top1 与估算声明', /麦香鱼套餐/.test(replyText()) && /最终价格以结算核价为准/.test(replyText()), replyText());

  calls.getDeliveryAddresses.length = 0;
  await say('我的地址');
  check('C4 地址意图：调用 Api 读取', calls.getDeliveryAddresses.length === 1, JSON.stringify(calls.getDeliveryAddresses));
  check('C4 地址意图：播报第一个地址', /张阿姨/.test(replyText()) && /幸福路/.test(replyText()), replyText());

  await say('什么时候送到');
  check('C5 配送时间：默认尽快送出', /尽快送出/.test(replyText()), replyText());

  storeState.cart = [{ name: '薯条', qty: 1, unitPrice: 11 }];
  calls.go.length = 0; calls.enter = 0; calls.setDeliveryMode.length = 0;
  await say('送到家');
  check('C6 送到家：进结算并切换麦乐送', calls.go.includes('checkout') && calls.enter === 1 && calls.setDeliveryMode.includes('delivery'), JSON.stringify(calls));
  check('C6 送到家：播报配送引导', /麦乐送/.test(replyText()), replyText());

  storeState.cart = [];
  calls.go.length = 0; calls.enter = 0;
  await say('送到家');
  check('C7 空车送到家：提示先点餐', /麦乐送/.test(replyText()) && calls.enter === 0, replyText());

  await say('帮助');
  check('C8 帮助文本包含新指令', ['有什么推荐', '送到家', '查询订单', '我的地址'].every((k) => replyText().includes(k)), replyText());

  const chips = Voice.suggestionChips();
  check('C9 快捷指令包含新意图', ['有什么推荐', '送到家', '查询订单', '我的地址'].every((k) => chips.includes(k)), chips);

  /* ===== D. TTS 回声抑制 ===== */
  Voice.setWakeMode(true);
  await sleep(400);
  const srD = lastSR();
  Voice.reply('播报测试');
  check('D1 唤醒模式播报：暂停识别防回声', srD.started === false);
  const u = utterances[utterances.length - 1];
  check('D1 唤醒模式播报：中文且语速放慢', u.lang === 'zh-CN' && u.rate < 1, 'rate=' + u.rate);
  if (u.onend) u.onend();
  await sleep(500);
  check('D1 唤醒模式播报：播报结束恢复识别', srD.started, 'started=' + srD.started);

  Voice.setWakeMode(false);
  Voice.startMic();
  const startedBefore = srD.started;
  Voice.reply('再播报一次');
  check('D2 普通模式播报：不打断识别', srD.started === startedBefore && srD.started === true);

  /* ===== E. 既有意图兼容 ===== */
  storeState.cart = [{ name: '薯条', qty: 1, unitPrice: 11 }];
  calls.go.length = 0; calls.enter = 0;
  await say('去结算');
  check('E1 既有意图：去结算进入结算页', calls.go.includes('checkout') && calls.enter === 1, JSON.stringify(calls));

  storeState.ui.detailCode = '1';
  window.Draft.d = { qty: 2 };
  calls.addToCart.length = 0;
  await say('加入购物车');
  check('E2 既有意图：加入购物车带数量', calls.addToCart.length === 1 && calls.addToCart[0].qty === 2, JSON.stringify(calls.addToCart));

  await say('打开购物车');
  check('E3 既有意图：打开购物车', calls.go.includes('cart'), JSON.stringify(calls.go));

  Voice.close();
  window.close();

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========== 语音智能体测试：${pass}/${results.length} 通过 ==========`);
  if (pass !== results.length) {
    console.log('失败项：' + results.filter((r) => !r.pass).map((r) => r.name).join(' | '));
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
