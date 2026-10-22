/* 语音交互：Web Speech API 中文识别 + 语音合成 + 命令解析 */
'use strict';

const Voice = {
  supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  recognition: null,
  active: false,

  /* ---------- 唤醒模式状态 ---------- */
  wakeMode: false,        // 唤醒模式开关（浮层内持续聆听，只听唤醒词）
  AWAKE_MS: 30000,        // 唤醒后对话窗口：30 秒内免唤醒词连续对话
  _awakeUntil: 0,         // 对话窗口截止时间戳
  _wantMic: false,        // 是否期望麦克风运行（浮层打开且未主动停止）
  _micBroken: false,      // 麦克风环境不可用（诊断后置位，恢复路径清除）
  _restartTimer: null,    // 重启识别防抖定时器

  init() {
    if (!this.supported) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SR();
    this.recognition.lang = 'zh-CN';
    this.recognition.interimResults = true;
    this.recognition.continuous = false;
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      const text = last[0].transcript;
      $('#voice-transcript').textContent = text;
      if (last.isFinal) {
        this.setStatus('thinking');
        setTimeout(() => this._dispatch(text), 350);
      }
    };
    this.recognition.onerror = (e) => this.onRecognError(e);
    this.recognition.onend = () => this._onEnd();

    // 麦克风问题恢复路径：重试按钮（复用环境预检，环境修复后可恢复）
    $('#voice-retry-btn')?.addEventListener('click', () => this.prepareMic());
  },

  /* ---------- 麦克风环境诊断（跨平台：桌面/移动/App 内置浏览器/iframe） ---------- */

  /** 检测运行环境；测试可通过 _envOverrides 注入，避免依赖 jsdom 的 isSecureContext 等实现差异 */
  _detectEnv() {
    const o = this._envOverrides || {};
    const ua = navigator.userAgent || '';
    return {
      secure: o.secure !== undefined ? o.secure : !!window.isSecureContext,
      iframe: o.iframe !== undefined ? o.iframe : (() => { try { return window.self !== window.top; } catch (_) { return true; } })(),
      webview: o.webview !== undefined ? o.webview : /MicroMessenger|QQ\/|Weibo|FB_IAB|Line\//i.test(ua),
    };
  },

  /**
   * 精确归因：Web Speech 的 not-allowed 泛指「UA 禁止语音识别」，
   * 权限被拒只是其中一种原因。iframe 权限策略、App 内置 WebView、
   * 非安全上下文都会报同样的错——混成一句「去设置里允许」会让用户白忙。
   */
  _micIssueText(env, err) {
    if (!env.secure) return { text: '麦克风需要安全环境：请用 HTTPS 或 localhost 打开本页', retry: true, external: false };
    if (env.webview) return { text: '当前 App 内置浏览器不提供麦克风：请复制地址到系统浏览器（Safari/Chrome）打开后使用', retry: false, external: false };
    if (env.iframe) return { text: '页面被嵌入预览，浏览器策略禁止了麦克风：点「在新标签页打开」即可正常使用', retry: true, external: true };
    if (err === 'service-not-allowed') return { text: '语音服务被系统禁用（常见于缺少语音服务的安卓设备），可直接点击下方快捷指令点餐', retry: true, external: false };
    if (err === 'audio-capture') return { text: '未检测到麦克风设备，请检查设备连接后点「重试」', retry: true, external: false };
    return { text: '麦克风权限被拒绝：请点地址栏左侧锁形图标 → 权限 → 允许麦克风，然后点「重试」', retry: true, external: false };
  },

  /** 展示诊断结果 + 恢复动作（重试 / 在新标签页打开） */
  showMicIssue(err) {
    const env = this._detectEnv();
    const issue = this._micIssueText(env, err);
    this._micBroken = true; // 唤醒模式据此停止自动重启，避免无限重试
    this.setStatus(issue.text);
    const fix = $('#voice-mic-fix');
    if (fix) {
      fix.hidden = false;
      const ext = $('#voice-open-external');
      if (ext) {
        ext.hidden = !issue.external;
        if (issue.external) ext.href = location.href;
      }
    }
    this.stopMic();
  },

  hideMicIssue() {
    this._micBroken = false;
    const f = $('#voice-mic-fix');
    if (f) f.hidden = true;
  },

  /**
   * 打开浮层后的麦克风准备：先做环境与权限预检。
   * Permissions API 不支持（Safari/Firefox）时静默跳过直接尝试——绝不把「无法查询」当成「已拒绝」。
   */
  async prepareMic() {
    this.hideMicIssue();
    if (!this.supported) { this.setStatus('当前浏览器不支持语音识别，请点击下方建议或手动输入'); return; }
    const env = this._detectEnv();
    if (!env.secure || env.webview || env.iframe) { this.showMicIssue('precheck'); return; }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'microphone' });
        if (st && st.state === 'denied') { this.showMicIssue('not-allowed'); return; }
      }
    } catch (_) { /* 不支持 microphone 查询 → 直接尝试，不误报 */ }
    this.startMic();
  },

  /** 识别错误精确分派：环境类错误走诊断，普通错误给轻提示 */
  onRecognError(e) {
    if (e.error === 'aborted') { this.stopMic(); return; }
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
      this.showMicIssue(e.error); return;
    }
    const map = { 'no-speech': '没有听到声音，请再试一次', network: '网络异常，语音识别不可用' };
    this.setStatus(map[e.error] || '识别出错：' + e.error);
    // 唤醒模式下可恢复错误（没声音/网络抖动）自动续听，不打断对话
    if (this.wakeMode && this._wantMic && !this._micBroken && this._overlayOpen()) this._restartMic(600);
    else this.stopMic();
  },

  /* ---------- 浮层控制 ---------- */
  open() {
    const ov = $('#voice-overlay');
    ov.hidden = false;
    $('#voice-transcript').textContent = '';
    $('#voice-reply').textContent = '';
    $('#voice-suggest').innerHTML = this.suggestionChips();
    this._wantMic = true;
    if (this.recognition) this.recognition.continuous = this.wakeMode; // 恢复唤醒模式的持续识别
    this.setStatus(this.wakeMode
      ? '唤醒模式已开启：说「你好麦麦」开始点餐'
      : (this.supported ? '正在聆听…试试说「我想吃巨无霸」' : '当前浏览器不支持语音识别'));
    // 键盘无障碍：Esc 关闭 + Tab 焦点圈定（与模态框一致）
    if (this._unbindKeys) { this._unbindKeys(); this._unbindKeys = null; }
    this._unbindKeys = dialogKeys(ov, () => this.close());
    $('#voice-close-btn').focus?.();
    this.prepareMic(); // 环境与权限预检后启动，失败时给出精确归因与恢复路径
  },
  close() {
    if (this._unbindKeys) { this._unbindKeys(); this._unbindKeys = null; }
    this._wantMic = false;
    this._awakeUntil = 0;
    this.stopMic();
    $('#voice-overlay').hidden = true;
  },
  setStatus(t) { $('#voice-status').textContent = t; },
  reply(t) {
    $('#voice-reply').textContent = t;
    this.speak(t);
  },
  startMic() {
    if (!this.supported) { this.setStatus('当前浏览器不支持语音识别，请点击下方建议或手动输入'); return; }
    this._wantMic = true;
    try {
      this.recognition.start();
      this.active = true;
      $('#voice-orb').classList.remove('thinking');
      $('#header-mic-btn')?.classList.add('recording');
    } catch (_) { /* 重复 start 忽略 */ }
  },
  stopMic() {
    this._wantMic = false;
    clearTimeout(this._restartTimer);
    this.active = false;
    $('#voice-orb')?.classList.add('thinking');
    $('#header-mic-btn')?.classList.remove('recording');
    try { this.recognition && this.recognition.stop(); } catch (_) { /* ignore */ }
  },

  /* ---------- 唤醒模式 ---------- */

  _overlayOpen() { const ov = $('#voice-overlay'); return !!ov && !ov.hidden; },
  _isAwake() { return Date.now() < this._awakeUntil; },

  /** 唤醒词检测：「你好麦麦」或「麦麦」 */
  _hitWake(text) { return /你好麦麦|麦麦/.test(String(text || '')); },

  /**
   * 识别结束后的续听：唤醒模式下持续聆听。
   * 真实浏览器 continuous 会在静音/超时后触发 onend，这里兜底重启；
   * _wantMic 区分「用户主动停止」与「浏览器自行结束」，_micBroken 防止环境问题时无限重试。
   */
  _onEnd() {
    this.active = false;
    $('#voice-orb')?.classList.add('thinking');
    $('#header-mic-btn')?.classList.remove('recording');
    if (this.wakeMode && this._wantMic && !this._micBroken && this._overlayOpen()) this._restartMic(400);
  },

  /** 防抖重启识别（continuous 属性需重启才生效；重复 start 由 try/catch 吸收） */
  _restartMic(delay = 300) {
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      if (!this._wantMic || !this._overlayOpen() || this._micBroken || !this.supported) return;
      try {
        this.recognition.start();
        this.active = true;
        $('#voice-orb').classList.remove('thinking');
        $('#header-mic-btn')?.classList.add('recording');
      } catch (_) { /* 已在运行：InvalidStateError 忽略 */ }
    }, delay);
  },

  /** 唤醒模式开关（浮层内复选框） */
  setWakeMode(on) {
    this.wakeMode = !!on;
    if (this.recognition) this.recognition.continuous = this.wakeMode;
    if (on) {
      this._awakeUntil = 0;
      this._wantMic = true;
      if (this.supported && this._overlayOpen() && !this._micBroken) {
        try { this.recognition && this.recognition.stop(); } catch (_) { /* ignore */ }
        this._restartMic(300); // 重启使 continuous 生效
        this.setStatus('唤醒模式已开启：说「你好麦麦」开始点餐');
      }
    } else {
      this._awakeUntil = 0;
      if (this._overlayOpen()) this.setStatus('唤醒模式已关闭');
    }
  },

  /**
   * 唤醒门控：未唤醒时只认唤醒词；命中唤醒词进入 30 秒对话窗口，窗口内免唤醒词连续对话。
   * 诚实说明：浏览器无法做到系统级唤醒，唤醒仅限本浮层打开期间。
   */
  async _dispatch(raw) {
    const text = String(raw || '').trim();
    if (!text) { this.setStatus('没有听清，请再说一次'); return; }
    const woken = this._hitWake(text);
    if (this.wakeMode && !this._isAwake() && !woken) {
      $('#voice-transcript').textContent = text;
      this.setStatus('等待唤醒…说「你好麦麦」开始');
      return;
    }
    let cmd = text;
    if (woken) {
      const parts = text.split(/(?:你好麦麦|麦麦)/); // 取最后一个唤醒词之后的内容
      cmd = parts[parts.length - 1].replace(/^[，。！？!?,.~\s]+/, '').trim();
      this._awakeUntil = Date.now() + this.AWAKE_MS;
      if (!cmd) {
        this.setStatus('thinking');
        setTimeout(() => this.reply('我在，您想吃什么？'), 350);
        return;
      }
    }
    await this.handleCommand(cmd);
    // 唤醒模式下维持对话窗口：浮层不关就保持聆听
    if (this.wakeMode && this._overlayOpen()) this._awakeUntil = Date.now() + this.AWAKE_MS;
  },

  speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.95; // 语速略放慢，方便长辈听清
      // 播报期间暂停识别，避免把语音播报听成新指令（回声自激）
      const pause = this.wakeMode && this._wantMic && this._overlayOpen();
      if (pause) { try { this.recognition && this.recognition.stop(); } catch (_) { /* ignore */ } }
      u.onend = () => { if (pause && this._wantMic && this._overlayOpen() && !this._micBroken) this._restartMic(300); };
      speechSynthesis.speak(u);
    } catch (_) { /* ignore */ }
  },

  suggestionChips() {
    const chips = ['我想吃巨无霸', '有什么推荐', '送到家', '查询订单', '我的地址', '打开购物车', '去结算'];
    return chips.map((c) => `<button data-action="voice-cmd" data-cmd="${esc(c)}">${esc(c)}</button>`).join('');
  },

  /* ---------- 命令解析与执行 ---------- */
  async handleCommand(raw) {
    const text = String(raw || '').trim().replace(/[，。！？!?,.~～\s]+$/g, '');
    if (!text) { this.setStatus('没有听清，请再说一次'); this.startMic(); return; }
    $('#voice-transcript').textContent = text;
    this.setStatus('思考中…');
    const state = Store.state;
    const menu = state.menu;
    let reply = '';

    // 1) 退出/关闭
    if (/^(关闭|退出|取消|回去)/.test(text)) { this.close(); return; }

    // 2) 帮助
    if (/帮助|怎么用|你能做什么/.test(text)) {
      reply = '你可以说：我想吃巨无霸、有什么推荐、送到家、查询订单、我的地址、打开购物车、去结算、帮我领券、有什么优惠、清空购物车。';
      this.reply(reply); return;
    }

    // 3) 清空购物车
    if (/清空|清理|删掉.*购物车/.test(text) && /购物车/.test(text)) {
      Store.clearCart();
      reply = '购物车已清空';
      this.reply(reply); UI.toast(reply); return;
    }

    // 4) 加入购物车（优先于通用购物车导航，避免「加入购物车」被误判为查看购物车）
    if (/加入购物车|加到购物车|就要这个|加一份|加一个|加杯/.test(text)) {
      if (state.ui.detailCode && Draft.d) {
        const m = text.match(/(\d+)\s*(份|个|杯|块|件)/);
        if (m) Draft.d.qty = Math.max(1, parseInt(m[1], 10) || 1);
        const line = Draft.buildCartLine();
        Store.addToCart(line);
        Store.closeDetail();
        reply = `已加入购物车：${line.name}${line.qty > 1 ? ' ×' + line.qty : ''}`;
        this.reply(reply); UI.toast(reply, 'success');
        return;
      }
      reply = '请先说想吃什么，我打开商品详情后，再说「加入购物车」';
      this.reply(reply);
      return;
    }

    // 5) 打开购物车
    if (/购物车/.test(text) && !/清空|清理/.test(text)) {
      go('cart');
      reply = `购物车共有 ${Store.cartCount()} 件商品，预估 ${fmtMoney(Store.cartSubtotal())} 元`;
      this.reply(reply); return;
    }

    // 6) 订单 / 配送状态查询（外卖场景：说「查询订单」）
    if (/查询订单|订单状态|订单到哪|到哪了|配送状态|配送进度/.test(text)) {
      const o = (state.orders || [])[0];
      if (!o) { reply = '你还没有下单记录，先点点想吃的吧'; this.reply(reply); return; }
      this.setStatus('正在查询订单状态…');
      try {
        const r = await Api.queryOrderStatus(o.orderId);
        const st = this._orderStatusText(r);
        reply = `订单 ${o.orderId}：${st}`;
      } catch (e) {
        reply = '订单状态查询失败：' + e.message;
      }
      this.reply(reply);
      return;
    }

    // 7) 优惠套餐推荐（长辈优选：结合健康与优惠）
    if (/推荐|适合.*(老人|长辈|老年)|健康|养生/.test(text)) {
      const t = (window.Recommend ? Recommend.top1() : null);
      if (!t) { reply = '菜单还没加载好，稍等一下再问吧'; this.reply(reply); return; }
      reply = Recommend.speakTop1();
      this.reply(reply);
      return;
    }

    // 8) 配送地址查询（说「我的地址」）
    if (/地址/.test(text)) {
      this.setStatus('正在读取地址…');
      try {
        const r = await Api.getDeliveryAddresses();
        const list = (r && (r.addresses || r.list)) || [];
        if (!list.length) { reply = '你还没有保存地址，结算时选择麦乐送即可新增'; this.reply(reply); return; }
        const a = list[0];
        reply = `你有 ${list.length} 个地址，第一个是：${a.contactName || ''}，${a.fullAddress || a.address || ''}。说「送到家」可用麦乐送配送`;
      } catch (e) {
        reply = '地址读取失败：' + e.message;
      }
      this.reply(reply);
      return;
    }

    // 9) 配送时间 / 预约（说「什么时候送到」）
    if (/配送时间|预约|几点.*送|什么时候送|定时|立即送出/.test(text)) {
      const d = state.ui.checkout && state.ui.checkout.delivery;
      if (d && d.reservationDate) {
        reply = `当前预约配送时间是 ${String(d.reservationDate).replace('T', ' ')}，如需修改可在结算页麦乐送面板重新选择`;
      } else {
        reply = '默认尽快送出。如需定时配送，结算时在麦乐送面板选择时段即可';
      }
      this.reply(reply);
      return;
    }

    // 10) 外卖配送引导（说「送到家」→ 结算页切麦乐送）
    if (/外卖|送到家|配送|送货|送过来|送餐/.test(text)) {
      if (!state.cart.length) { reply = '想吃什么先告诉我，选好后结算时选麦乐送就能送到家'; this.reply(reply); return; }
      Store.resetCheckout();
      go('checkout');
      CheckoutCtrl.enter().then(() => CheckoutCtrl.setDeliveryMode('delivery'));
      reply = '已进入结算并切换到麦乐送，请选择配送地址';
      this.reply(reply);
      return;
    }

    // 11) 结算
    if (/去结算|结算|结账|买单|确认下单|我要下单/.test(text)) {
      if (!state.cart.length) { reply = '购物车还是空的，先点点什么吧'; this.reply(reply); return; }
      Store.resetCheckout();
      go('checkout');
      CheckoutCtrl.enter();
      reply = '进入结算页面，正在为你准备优惠券';
      this.reply(reply); return;
    }

    // 12) 领券 / 优惠
    if (/领券|优惠|折扣|便宜/.test(text)) {
      if (!state.cart.length) { reply = '先加点商品，结算时才能用券哦'; this.reply(reply); return; }
      Store.resetCheckout();
      go('checkout');
      CheckoutCtrl.enter().then(() => {
        Store.patchCheckout({ step: 2 });
        CheckoutCtrl.claim();
      });
      reply = '正在进入结算页并自动领取优惠券';
      this.reply(reply); return;
    }

    // 13) 切换门店 / 实时定位
    if (/定位|当前位置|附近/.test(text) && /门店|麦当劳|餐厅|定位|位置/.test(text)) {
      Store.setStorePicker(true);
      this.reply('正在获取您的当前位置，请允许定位权限');
      if (window.AppActions && window.AppActions.locateStores) window.AppActions.locateStores();
      return;
    }
    if (/门店|换一家/.test(text)) {
      Store.setStorePicker(true);
      reply = '已打开门店选择，附近有 ' + Store.state.stores.length + ' 家麦当劳';
      this.reply(reply); return;
    }

    // 14) 搜索 / 点名商品（「来一份薯条」「我想吃巨无霸」等）
    const kw = text
      .replace(/^(我想吃|我想要|想吃|我要|来一份|来一个|来份|来杯|我要一份|我要一个|搜索|查找|点一份|点一个|点)/, '')
      .replace(/(谢谢|麻烦了|好吗|吧|呢)/g, '')
      .trim();
    if (kw && menu) {
      const hit = this.findProduct(kw);
      if (hit) {
        Store.openDetail(hit.code);
        reply = `找到「${hit.name}」，¥${fmtMoney(estimateUnitPrice(hit))}，请看详情并选择配料`;
        this.reply(reply);
        return;
      }
      reply = `菜单里没有找到「${kw}」，试试巨无霸、薯条、麦旋风`;
      this.reply(reply);
      return;
    }

    reply = this.wakeMode ? '我没听懂，唤醒后可以说「我想吃巨无霸」或「帮助」' : '我没听懂，可以说「我想吃巨无霸」或「帮助」';
    this.reply(reply);
    this.startMic();
  },

  /** 把订单状态查询结果整理成一句口语播报 */
  _orderStatusText(r) {
    const d = (r && (r.data || r)) || {};
    const parts = [d.status || d.orderStatus || '已收到'];
    if (d.deliveryStatus) parts.push(d.deliveryStatus);
    if (d.estimateTime) parts.push('预计送达 ' + d.estimateTime);
    if (d.riderName) parts.push('配送骑士 ' + d.riderName);
    return parts.join('，');
  },

  /** 在菜单中模糊查找商品 */
  findProduct(kw) {
    const menu = Store.state.menu;
    if (!menu) return null;
    const meals = Object.values(menu.meals);
    const norm = (s) => String(s || '').replace(/[\s（）()·、-]/g, '');
    const k = norm(kw);
    return meals.find((m) => norm(m.name).includes(k))
      || meals.find((m) => k.includes(norm(m.name)))
      || meals.find((m) => norm(m.name).includes(k.replace(/套餐|组合|三件套|四件套|随心配/g, '')));
  },
};
