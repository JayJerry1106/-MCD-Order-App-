/* 全局状态：购物车 / 订单 / 菜单 / UI（发布订阅 + localStorage 持久化） */
'use strict';

function createStore() {
  const state = {
    mode: 'offline',           // 'live' | 'offline'（由 Api.init 写入）
    ready: false,
    store: null,               // 当前门店
    stores: [],                // 门店列表（真实后端返回）
    storeRef: null,            // 门店列表的参考点说明（定位地址 / 搜索关键词）
    menu: null,                // { categories, meals }
    nutrition: {},             // 营养表
    cart: [],                  // 购物车行
    orders: [],                // 本地订单历史
    geo: {                     // 实时定位状态
      status: 'idle',          // idle | locating | success | error
      position: null,
      place: null,
      error: null,             // { code, reason, hint }
      note: null,              // 定位/搜索的诚实提示（如关键词未解析、定位偏差）
    },
    ui: {
      route: 'menu',
      search: '',
      category: '全部',
      detailCode: null,        // 详情弹层商品
      storePickerOpen: false,
      recommend: [],           // 长辈优选推荐（Recommend.refresh 计算，真实数据）
      couponPool: [],          // 可用券池（我的券+门店券，供推荐引擎估算节省）
      checkout: {
        step: 1, takeWay: 'eat-in', needTableware: false, coupon: null, priceResult: null, orderResult: null, claiming: false,
        // 麦乐送（外卖配送）子状态
        delivery: {
          mode: 'takeout',        // 'takeout' 到店自取/堂食 | 'delivery' 麦乐送
          addresses: [],          // 我的配送地址列表
          addressesLoaded: false,
          loadingAddresses: false, // 地址加载守卫（防止 render 与加载互相触发）
          pickingAddress: false,   // 地址选择守卫（防止并发/重入）
          addressId: '',          // 当前选中的地址 id
          stores: [],             // 该地址可配送门店（含 beCode）
          storesLoaded: false,
          beCode: '',             // 选中配送门店的 beCode（下单必传）
          reservationDate: '',    // 配送时间 'yyyy-MM-dd HH:mm'，空 = 立即送出
          reservationOptions: [], // 门店可预约时段（MCP reservationTimeOptions）
          remark: '',             // 备注（≤50 字）
          savingAddress: false,   // 新增地址中
          statusOrderId: '',      // 待查询订单号
          statusResult: null,     // 订单状态查询结果
          statusLoading: false,
        },
      },
    },
  };
  const listeners = new Set();
  let lineSeq = 1;

  const persist = () => {
    try {
      localStorage.setItem(CONFIG.LS_CART, JSON.stringify(state.cart));
      localStorage.setItem(CONFIG.LS_ORDERS, JSON.stringify(state.orders.slice(0, 30)));
      if (state.store) localStorage.setItem(CONFIG.LS_STORE, JSON.stringify(state.store));
    } catch (_) { /* 隐私模式等场景忽略 */ }
  };

  const store = {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { persist(); listeners.forEach((fn) => fn(state)); },

    /** 初始化：读取本地数据 */
    hydrate() {
      try {
        state.cart = JSON.parse(localStorage.getItem(CONFIG.LS_CART) || '[]');
        state.orders = JSON.parse(localStorage.getItem(CONFIG.LS_ORDERS) || '[]');
        const s = JSON.parse(localStorage.getItem(CONFIG.LS_STORE) || 'null');
        if (s) state.store = s;
      } catch (_) { /* ignore */ }
    },

    setStore(s) { state.store = s; this.emit(); },
    setStores(list, ref) {
      state.stores = list;
      if (ref !== undefined) state.storeRef = ref;
      this.emit();
    },
    /** 定位状态局部更新（触发 emit，UI 即时反映定位进度） */
    patchGeo(patch) { Object.assign(state.geo, patch); this.emit(); },
    setMenu(menu) {
      state.menu = menu;
      const names = menu.categories.map((c) => c.name);
      if (!names.includes(state.ui.category)) state.ui.category = names[0] || '全部';
      this.emit();
    },
    setNutrition(n) { state.nutrition = n; this.emit(); },
    setMode(m) { state.mode = m; this.emit(); },
    /** 券池（供推荐引擎估算节省；结算页加载券后写入） */
    setCouponPool(list) { state.ui.couponPool = list || []; this.emit(); },
    setRoute(r) { state.ui.route = r; this.emit(); },
    setSearch(kw) { state.ui.search = kw; this.emit(); },
    setCategory(c) { state.ui.category = c; this.emit(); },
    openDetail(code) { state.ui.detailCode = code; this.emit(); },
    closeDetail() { state.ui.detailCode = null; this.emit(); },
    setStorePicker(open) { state.ui.storePickerOpen = open; this.emit(); },
    patchCheckout(patch) { Object.assign(state.ui.checkout, patch); this.emit(); },
    patchDelivery(patch) { Object.assign(state.ui.checkout.delivery, patch); this.emit(); },
    resetCheckout() {
      const d = state.ui.checkout.delivery;
      state.ui.checkout = {
        step: 1, takeWay: 'eat-in', needTableware: false, coupon: null, priceResult: null, orderResult: null, claiming: false,
        delivery: { ...d, mode: 'takeout', addressId: '', stores: [], storesLoaded: false, beCode: '', reservationDate: '', reservationOptions: [], remark: '', statusOrderId: '', statusResult: null, statusLoading: false, loadingAddresses: false, pickingAddress: false },
      };
      this.emit();
    },

    /** 购物车操作 */
    addToCart(item) {
      // 相同商品 + 相同定制 → 合并数量
      const key = (l) => [l.code, JSON.stringify(l.rounds || []), JSON.stringify(l.mods || [])].join('|');
      const exist = state.cart.find((l) => key(l) === key(item));
      if (exist) {
        exist.qty += item.qty;
      } else {
        state.cart.push({ ...item, lineId: 'L' + lineSeq++ });
      }
      this.emit();
    },
    setQty(lineId, qty) {
      const line = state.cart.find((l) => l.lineId === lineId);
      if (!line) return;
      if (qty <= 0) {
        state.cart = state.cart.filter((l) => l.lineId !== lineId);
      } else {
        line.qty = Math.min(qty, 99);
      }
      this.emit();
    },
    removeLine(lineId) {
      state.cart = state.cart.filter((l) => l.lineId !== lineId);
      this.emit();
    },
    clearCart() { state.cart = []; this.emit(); },

    /** 汇总（本地估算，展示用；最终价以核价接口为准） */
    cartCount() { return state.cart.reduce((s, l) => s + l.qty, 0); },
    cartSubtotal() { return state.cart.reduce((s, l) => s + l.unitPrice * l.qty, 0); },
    cartOriginal() { return state.cart.reduce((s, l) => s + (l.originalPrice || l.unitPrice) * l.qty, 0); },

    addOrder(order) { state.orders.unshift(order); this.emit(); },
  };
  return store;
}

const Store = createStore();
