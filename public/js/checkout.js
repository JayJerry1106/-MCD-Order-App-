/* 结算流程：确认订单 → 优惠券优先领取 → MCP 核价 → 创建订单（支持到店自取 / 麦乐送外卖） */
'use strict';

const CheckoutCtrl = {
  /** 进入结算页：空车拦截 + 预取取餐方式 */
  async enter() {
    const state = Store.state;
    if (!state.cart.length) {
      UI.toast('购物车是空的，先去点餐吧', 'error');
      go('menu');
      return;
    }
    if (!state.ui.checkout.priceResult) {
      Store.patchCheckout({ step: 1 });
      this.render(Store.state);
      try {
        const r = await Api.calculatePrice(state.store.storeCode, state.cart, null, state.ui.checkout.needTableware);
        Store.patchCheckout({ priceResult: r });
      } catch (e) {
        UI.toast(e.message, 'error');
      }
    }
    this.render(Store.state);
  },

  render(state) {
    const c = state.ui.checkout;
    const root = $('#view-root');
    // 必须标记视图类型：renderMenu 以 dataset.view !== 'menu' 判定是否需要重建菜单 DOM。
    // 此前漏标（停留在 'menu'），从结算页返回菜单时 renderMenu 误判「已渲染」直接跳过重建，
    // 导致整个菜单区域空白（实测：商品卡 0、搜索框/分类行全部消失）。
    root.dataset.view = 'checkout';
    if (!state.cart.length && !c.orderResult) {
      root.innerHTML = `<div class="empty-state"><div class="empty-emoji">🛒</div><p>购物车是空的</p>
        <button class="btn btn-yellow" data-action="goto" data-route="menu" style="margin-top:12px">去点餐</button></div>`;
      return;
    }
    const steps = `
      <div class="steps">
        <div class="step ${c.step >= 1 ? (c.step > 1 ? 'done' : 'active') : ''}" data-num="1">确认订单</div>
        <div class="step ${c.step >= 2 ? (c.step > 2 ? 'done' : 'active') : ''}" data-num="2">优惠券</div>
        <div class="step ${c.step >= 3 ? (c.step > 3 ? 'done' : 'active') : ''}" data-num="3">核价确认</div>
        <div class="step ${c.step >= 4 ? 'active' : ''}" data-num="4">完成</div>
      </div>`;
    let body = '';
    if (c.step === 1) body = this.step1(state);
    else if (c.step === 2) body = this.step2(state);
    else if (c.step === 3) body = this.step3(state);
    else body = this.step4(state);
    root.innerHTML = `<div class="checkout-wrap">${steps}${body}</div>`;
    if (c.step === 2 && !c.couponsLoaded) this.loadCoupons();
    // 麦乐送模式：进入第 1 步时按需加载地址（loadingAddresses 守卫防止 render 与加载互相触发）
    if (c.step === 1 && c.delivery.mode === 'delivery' && !c.delivery.addressesLoaded && !c.delivery.loadingAddresses) this.loadAddresses();
  },

  /* ---------- 第 1 步：确认订单 ---------- */
  step1(state) {
    const c = state.ui.checkout;
    const d = c.delivery;
    const takeWays = c.priceResult?.takeWayList?.length
      ? c.priceResult.takeWayList
      : [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }, { code: 'take-in-store', title: '外带', subtitle: '店内自提' }];
    // 麦乐送前置校验：必须已选配送地址且拿到可配送门店 beCode，否则不允许进入后续步骤
    // （此前无校验，用户会在第 3 步核价或下单时才被 MCP 400 拦截，体验断裂）
    const deliveryReady = d.mode !== 'delivery' || (!!d.addressId && !!d.beCode);
    return `
      <div class="checkout-card">
        <h3>📍 门店与取餐方式</h3>
        <p style="font-size:13px;color:var(--ink-2);line-height:1.7">
          <b>${esc(state.store?.storeName || '')}</b><br />${esc(state.store?.address || '')}
          ${state.store?.businessStartTime ? ` · 营业 ${state.store.businessStartTime}-${state.store.businessEndTime}` : ''}
        </p>
        <div class="takeway-row mode-row" style="margin-top:14px">
          <div class="takeway-opt mode-opt ${d.mode === 'takeout' ? 'selected' : ''}" data-action="pick-delivery-mode" data-mode="takeout">
            <div class="tw-title">🏪 到店自取</div>
            <div class="tw-sub">堂食 / 外带，到店取餐</div>
          </div>
          <div class="takeway-opt mode-opt ${d.mode === 'delivery' ? 'selected' : ''}" data-action="pick-delivery-mode" data-mode="delivery">
            <div class="tw-title">🛵 麦乐送</div>
            <div class="tw-sub">送餐到家，配送到门</div>
          </div>
        </div>
        ${d.mode === 'takeout' ? `
        <div class="takeway-row" style="margin-top:12px">
          ${takeWays.map((t) => `
            <div class="takeway-opt ${c.takeWay === t.code ? 'selected' : ''}" data-action="pick-takeway" data-code="${esc(t.code)}">
              <div class="tw-title">${esc(t.title)}</div>
              <div class="tw-sub">${esc(t.subtitle || '')}</div>
            </div>`).join('')}
        </div>` : this.deliveryPanel(state)}
        <label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:14px;cursor:pointer">
          <input type="checkbox" id="tableware-toggle" ${c.needTableware ? 'checked' : ''} />
          需要餐具（可能产生餐具费）
        </label>
      </div>

      <div class="checkout-card">
        <h3>🧾 订单清单（${Store.cartCount()} 件）</h3>
        ${state.cart.map((line) => `
          <div class="co-item">
            <img src="${esc(line.image)}" alt="" onerror="this.style.opacity=0" />
            <div>
              <div class="coi-name">${esc(line.name)}</div>
              ${line.note ? `<div class="coi-opt">${esc(line.note)}</div>` : ''}
              ${line.withOrderNote ? `<div class="coi-opt" style="color:#c2410c">未随单购卡 · 按原价结算</div>` : ''}
            </div>
            <div class="coi-price">×${line.qty}<br />¥${fmtMoney(line.unitPrice * line.qty)}</div>
          </div>`).join('')}
        <div class="price-line" style="margin-top:12px"><span>预估商品合计</span><span class="pl-value">¥${fmtMoney(Store.cartSubtotal())}</span></div>
      </div>

      <div class="checkout-card" style="display:flex;gap:10px">
        <button class="btn btn-ghost" data-action="goto" data-route="menu">再逛逛</button>
        <button class="btn btn-primary btn-lg" style="flex:1" data-action="checkout-next" ${deliveryReady ? '' : 'disabled'}>下一步 · 选优惠券</button>
      </div>
      ${deliveryReady ? '' : `<p style="font-size:12px;color:var(--red);text-align:center;margin-top:8px">请先选择配送地址与可配送门店，再继续</p>`}`;
  },

  /* ---------- 麦乐送面板：地址 / 时间 / 备注 / 配送门店 ---------- */
  deliveryPanel(state) {
    const d = state.ui.checkout.delivery;
    const addr = (d.addresses || []).find((a) => (a.addressId || a.id) === d.addressId);
    return `
      <div class="delivery-panel">
        <div class="dp-head">
          <span class="dp-title">📍 配送地址</span>
          <button class="btn btn-yellow btn-sm" data-action="open-address-form" type="button">+ 新增地址</button>
        </div>
        ${d.addressesLoaded ? (
          (d.addresses || []).length ? `
          <div class="addr-list">
            ${(d.addresses || []).map((a) => {
              const id = a.addressId || a.id || '';
              return `
              <div class="addr-opt ${id === d.addressId ? 'selected' : ''}" data-action="pick-address" data-id="${esc(id)}">
                <span class="ao-radio"></span>
                <div class="ao-body">
                  <div class="ao-name">${esc(a.contactName || a.name || '')}<span class="ao-phone">${esc(a.phone || a.contactPhone || '')}</span></div>
                  <div class="ao-detail">${esc(a.address || '')}${a.addressDetail ? ' ' + esc(a.addressDetail) : ''}</div>
                </div>
              </div>`;
            }).join('')}
          </div>`
          : `<p class="dp-empty">还没有配送地址，请先点「新增地址」添加一个送餐地址。</p>`
        ) : `<div class="skeleton" style="height:64px"></div>`}

        ${addr ? `
          <div class="dp-grid">
            <div class="dp-field">
              <label class="dp-label">🕐 配送时间</label>
              ${this.deliveryTimeSlots(state)}
              <input class="store-input" id="delivery-time" type="datetime-local" value="${esc(d.reservationDate.replace(' ', 'T'))}" data-action="set-delivery-time" />
              <p class="dp-hint">选「立即送出」或点选时段；也可在下方自定义精确时间。实际送达以门店运力为准</p>
            </div>
            <div class="dp-field">
              <label class="dp-label" for="delivery-remark">📝 备注（选填，50 字以内）</label>
              <input class="store-input" id="delivery-remark" type="text" maxlength="50" value="${esc(d.remark)}" placeholder="如：少辣、放前台、到了打电话" data-action="set-delivery-remark" />
            </div>
          </div>
          <div class="dp-store">
            ${d.storesLoaded
              ? (d.stores || []).length
                ? `🛵 配送门店：<b>${esc((d.stores[0].storeName || ''))}</b>${d.stores[0].distance != null ? ` · 约 ${formatDistance(d.stores[0].distance)}` : ''}${d.stores.length > 1 ? ` · 附近共 ${d.stores.length} 家可配送` : ''}`
                : `<span style="color:#c2410c">⚠️ 该地址附近暂无可配送门店，请更换地址或改用到店自取</span>`
              : `<span class="dp-loading">正在查询可配送门店…</span>`}
          </div>`
        : ''}
      </div>`;
  },

  /** 配送时间快选：立即送出 + 门店可预约时段（MCP reservationTimeOptions） */
  deliveryTimeSlots(state) {
    const d = state.ui.checkout.delivery;
    const opts = d.reservationOptions || [];
    const chips = [`<button type="button" class="dp-slot ${!d.reservationDate ? 'selected' : ''}" data-action="pick-delivery-slot" data-dt="">⚡ 立即送出</button>`];
    for (const opt of opts.slice(0, 3)) {
      const date = opt.date || '';
      const text = String(opt.reservationOptionText || '');
      const windows = [...text.matchAll(/([^，,(]+)\((\d{1,2}:\d{2})至(\d{1,2}:\d{2})\)/g)];
      for (const w of windows) {
        const label = `${opt.today ? '今天' : date.slice(5)} ${w[1].trim()} ${w[2]}`;
        const dt = `${date} ${w[2]}`;
        chips.push(`<button type="button" class="dp-slot ${d.reservationDate === dt ? 'selected' : ''}" data-action="pick-delivery-slot" data-dt="${esc(dt)}" title="${esc(dt)}">${esc(label)}</button>`);
      }
    }
    return `<div class="dp-slots">${chips.join('')}</div>`;
  },

  /* ---------- 第 2 步：优惠券优先领取 ---------- */
  step2(state) {
    const c = state.ui.checkout;
    const claimable = (c.claimable || []).length;
    const coupons = c.coupons || [];
    return `
      <div class="checkout-card">
        <h3>🎟️ 优惠券（优先领取）</h3>
        <div class="coupon-banner">
          <span class="cb-icon">🎁</span>
          <div class="cb-text">
            <div class="cb-title">麦麦省可领优惠券 ${claimable} 张</div>
            <div class="cb-sub">下单前自动为你领取全部可用券，不错过任何优惠</div>
          </div>
          <button class="btn btn-yellow btn-sm" data-action="claim-coupons" ${c.claiming ? 'disabled' : ''}>
            ${c.claiming ? '领取中…' : claimable ? '一键领取' : '已全部领取'}
          </button>
        </div>
        <div class="coupon-list">
          <div class="coupon-card ${!c.coupon ? 'selected' : ''}" data-action="pick-coupon" data-idx="-1">
            <div class="cc-left" style="background:linear-gradient(160deg,#9a9a9a,#7a7a7a)"><span class="cc-amount">—</span><span class="cc-desc">不使用优惠券</span></div>
            <div class="cc-body"><div class="cc-title">不使用优惠券</div><div class="cc-meta">按商品原价结算</div></div>
            <div class="cc-check"><span class="cc-radio"></span></div>
          </div>
          ${coupons.map((cp, i) => {
            const matched = Api.couponMatchedCodes(cp, state.cart);
            const usable = matched.size > 0 || !cp.products?.length;
            return `
            <div class="coupon-card ${c.coupon && c.coupon.idx === i ? 'selected' : ''} ${usable ? '' : 'disabled'}" data-action="pick-coupon" data-idx="${i}">
              <div class="cc-left">
                <span class="cc-amount">${cp.discountValue ? `<small>¥</small>${esc(cp.discountValue)}` : '券'}</span>
                <span class="cc-desc">${esc(cp.discountDesc || '麦当劳优惠券')}</span>
              </div>
              <div class="cc-body">
                <div class="cc-title">${esc(cp.title)}</div>
                <div class="cc-meta">${cp.validityText ? '有效期：' + esc(cp.validityText) + '<br />' : ''}${esc(cp.sourceText)}</div>
                <div class="cc-tags">
                  ${(cp.tags || []).map((t) => `<span class="chip chip-yellow">${esc(t)}</span>`).join('')}
                  ${usable ? `<span class="chip chip-green">适用于当前购物车</span>` : `<span class="chip">不适用当前商品</span>`}
                </div>
              </div>
              <div class="cc-check"><span class="cc-radio"></span></div>
            </div>`;
          }).join('') || `<div class="empty-state" style="padding:24px"><div class="empty-emoji">🎫</div><p>暂无可用的优惠券</p></div>`}
        </div>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn btn-ghost" data-action="checkout-back">上一步</button>
          <button class="btn btn-outline" data-action="smart-coupon" style="flex:1">🪄 智能选最优</button>
          <button class="btn btn-primary" style="flex:1" data-action="checkout-next">去核价</button>
        </div>
      </div>`;
  },

  /* ---------- 第 3 步：核价确认 ---------- */
  step3(state) {
    const c = state.ui.checkout;
    const r = c.priceResult;
    const d = c.delivery;
    const isDelivery = d.mode === 'delivery';
    if (!r) {
      return `<div class="checkout-card"><div class="skeleton" style="height:200px"></div></div>`;
    }
    const coupon = c.coupon;
    return `
      <div class="checkout-card">
        <h3>💰 价格确认${coupon ? ` · 已选「${esc(coupon.title)}」` : ''}${isDelivery ? ' · 🛵 麦乐送' : ''}</h3>
        ${isDelivery ? this.deliverySummary(state) : ''}
        <div class="price-detail">
          <div class="price-line"><span>商品原价</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.productOriginalPrice ?? r.originalPrice))}</span></div>
          <div class="price-line"><span>商品现价</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.productPrice))}</span></div>
          ${r.discount ? `<div class="price-line discount"><span>优惠券优惠</span><span class="pl-value">-¥${fmtMoney(fenToYuan(r.discount))}</span></div>` : ''}
          ${r.packingPrice ? `<div class="price-line"><span>打包费</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.packingPrice))}</span></div>` : ''}
          ${r.deliveryPrice ? `<div class="price-line"><span>配送费</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.deliveryPrice))}</span></div>` : ''}
          ${r.tablewarePrice ? `<div class="price-line"><span>餐具费</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.tablewarePrice))}</span></div>` : ''}
          <div class="price-line grand"><span>应付合计</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.price))}</span></div>
        </div>
        ${r.enjoyable && r.enjoyable.balance ? `<p class="price-note" style="margin-top:10px">💡 再购 ¥${fmtMoney(fenToYuan(r.enjoyable.balance))} 可享受更多优惠</p>` : ''}
        <p class="price-note" style="margin-top:10px">价格由麦当劳 MCP calculate-price 实时计算，与门店实际计费一致。</p>
      </div>

      <div class="checkout-card" style="display:flex;gap:10px">
        <button class="btn btn-ghost" data-action="checkout-back">上一步</button>
        <button class="btn btn-primary btn-lg" style="flex:1" data-action="confirm-order">确认下单</button>
      </div>`;
  },

  /** 配送信息摘要（地址 / 时间 / 备注 / 门店） */
  deliverySummary(state) {
    const d = state.ui.checkout.delivery;
    const addr = (d.addresses || []).find((a) => (a.addressId || a.id) === d.addressId) || {};
    const rows = [
      ['📍 配送地址', [addr.contactName || addr.name, addr.phone || addr.contactPhone, addr.address, addr.addressDetail].filter(Boolean).join(' · ')],
      ['🕐 配送时间', d.reservationDate ? esc(d.reservationDate.replace('T', ' ')) : '立即送出'],
      ['🛵 配送门店', esc(state.store?.storeName || '')],
    ];
    if (d.remark) rows.push(['📝 备注', esc(d.remark)]);
    return `
      <div class="dp-summary">
        ${rows.map(([k, v]) => `<div class="dp-sum-row"><span>${k}</span><b>${v}</b></div>`).join('')}
      </div>`;
  },

  /* ---------- 第 4 步：下单结果 ---------- */
  step4(state) {
    const c = state.ui.checkout;
    const o = c.orderResult || {};
    const d = c.delivery;
    const isDelivery = d.mode === 'delivery';
    const st = d.statusResult;
    return `
      <div class="checkout-card order-success">
        <div class="os-icon">🎉</div>
        <h2>下单成功</h2>
        ${o.pickupCode ? `<div class="os-code">${esc(o.pickupCode)}</div><p>取餐码</p>` : ''}
        <p>订单号：${esc(o.orderId || '-')}<br />
        ${esc(o.message || (isDelivery ? '骑士正在赶来，可在下方查看配送进度。' : '请通过麦当劳 App 扫码或打开支付链接完成支付。'))}</p>
        ${isDelivery ? `
        <div class="dp-summary" style="text-align:left;margin-top:12px">
          <div class="dp-sum-row"><span>📍 配送地址</span><b>${esc(((d.addresses || []).find((a) => (a.addressId || a.id) === d.addressId) || {}).address || '')}${((d.addresses || []).find((a) => (a.addressId || a.id) === d.addressId) || {}).addressDetail ? ' ' + esc(((d.addresses || []).find((a) => (a.addressId || a.id) === d.addressId) || {}).addressDetail) : ''}</b></div>
          <div class="dp-sum-row"><span>🕐 配送时间</span><b>${d.reservationDate ? esc(d.reservationDate.replace('T', ' ')) : '立即送出'}</b></div>
        </div>
        <button class="btn btn-outline btn-block" style="margin-top:12px" data-action="query-order-status" data-id="${esc(o.orderId || '')}" ${d.statusLoading ? 'disabled' : ''}>
          ${d.statusLoading ? '查询中…' : '🔍 查询配送状态'}
        </button>
        ${st ? `
        <div class="dp-status" id="order-status-box">
          <div class="dp-status-head">订单状态：<b>${esc(st.status || st.orderStatus || '已收到')}</b></div>
          ${st.deliveryStatus || st.riderName || st.estimateTime ? `
          <div class="dp-status-body">
            ${st.estimateTime ? `<div>预计送达：${esc(st.estimateTime)}</div>` : ''}
            ${st.riderName ? `<div>配送骑士：${esc(st.riderName)}${st.riderPhone ? ' · ' + esc(st.riderPhone) : ''}</div>` : ''}
            ${st.deliveryStatus ? `<div>配送进度：${esc(st.deliveryStatus)}</div>` : ''}
          </div>` : ''}
        </div>` : ''}
        ` : ''}
        <div class="os-actions">
          <button class="btn btn-ghost" data-action="goto" data-route="menu">返回点餐</button>
          <button class="btn btn-primary" data-action="goto" data-route="orders">查看订单</button>
        </div>
      </div>`;
  },

  /* ---------- 数据加载 ---------- */
  async loadCoupons() {
    const state = Store.state;
    const d = state.ui.checkout.delivery;
    const isDelivery = d.mode === 'delivery' && !!d.beCode;
    Store.patchCheckout({ couponsLoaded: true });
    try {
      const [available, mine, storeCoupons] = await Promise.all([
        Api.getAvailableCoupons(),
        Api.getMyCoupons(),
        Api.getStoreCoupons(state.store.storeCode, isDelivery ? 2 : 1, isDelivery ? d.beCode : ''),
      ]);
      const claimable = (available || []).filter((c) => {
        const s = c.claimStatus || c.couponStatus || '';
        return s === 'CAN_GET' || s === '可领取';
      });
      const norm = (c, source) => ({
        id: c.id || c.couponId || '',
        code: c.code || c.couponCode || '',
        title: c.title || c.couponName || '',
        discountValue: c.discountValue || '',
        discountDesc: c.discountDesc || '',
        validityText: c.validityText || c.datetimeText || c.tradeDateTime || '',
        tags: c.tags || [],
        products: c.products || [],
        source,
        sourceText: source === 'mine' ? '我的券包' : '门店可用券',
      });
      const list = [
        ...(mine || []).map((c) => norm(c, 'mine')),
        ...(storeCoupons || []).map((c) => norm(c, 'store')),
      ].filter((c) => c.id || c.title);
      Store.patchCheckout({ coupons: list, claimable });
      Store.setCouponPool(list); // 写入券池，推荐引擎据此估算「券后约省」
      Recommend.refresh();       // 券池变化 → 重算推荐（refresh 自带 emit）
    } catch (e) {
      UI.toast('优惠券加载失败：' + e.message, 'error');
    }
    this.render(Store.state);
  },

  /** 一键领取 */
  async claim() {
    const state = Store.state;
    Store.patchCheckout({ claiming: true });
    this.render(state);
    try {
      await Api.claimCoupons();
      const mine = await Api.getMyCoupons();
      const norm = (c, source) => ({
        id: c.id || c.couponId || '', code: c.code || c.couponCode || '',
        title: c.title || c.couponName || '', discountValue: c.discountValue || '',
        discountDesc: c.discountDesc || '', validityText: c.validityText || c.datetimeText || c.tradeDateTime || '',
        tags: c.tags || [], products: c.products || [], source, sourceText: '我的券包',
      });
      const list = [
        ...(mine || []).map((c) => norm(c, 'mine')),
        ...(Store.state.ui.checkout.coupons || []).filter((c) => c.source === 'store'),
      ];
      Store.patchCheckout({ coupons: list, claimable: [], claiming: false, coupon: null, priceResult: null });
      Store.setCouponPool(list);
      UI.toast(`领取成功，当前可用 ${list.length} 张券`, 'success');
    } catch (e) {
      Store.patchCheckout({ claiming: false });
      UI.toast('领券失败：' + e.message, 'error');
    }
    this.render(Store.state);
  },

  /** 智能选最优：逐张试算，取到手价最低 */
  async smartPick() {
    const state = Store.state;
    const d = state.ui.checkout.delivery;
    const opts = this.deliveryOpts();
    const candidates = (state.ui.checkout.coupons || []).filter((c) => Api.couponMatchedCodes(c, state.cart).size > 0).slice(0, 8);
    if (!candidates.length) {
      UI.toast('当前购物车没有适用券', 'error');
      return;
    }
    UI.toast(`正在试算 ${candidates.length} 张适用券…`);
    let best = null;
    for (const cp of candidates) {
      try {
        const r = await Api.calculatePrice(state.store.storeCode, state.cart, cp, state.ui.checkout.needTableware, opts);
        const price = r.price ?? Infinity;
        if (!best || price < best.price) best = { coupon: cp, price, result: r };
      } catch (_) { /* 单张券失败不影响其他券 */ }
    }
    if (!best) { UI.toast('试算失败，请手动选择', 'error'); return; }
    Store.patchCheckout({
      coupon: { ...best.coupon, idx: (state.ui.checkout.coupons || []).indexOf(best.coupon) },
      priceResult: best.result,
    });
    UI.toast(`已选最优：${best.coupon.title}，到手价 ¥${fmtMoney(fenToYuan(best.price))}`, 'success');
    this.render(Store.state);
  },

  /** 当前配送/自取出参（供核价与下单共用） */
  deliveryOpts() {
    const d = Store.state.ui.checkout.delivery;
    if (d.mode === 'delivery') {
      return { orderType: 2, beType: 2, beCode: d.beCode, addressId: d.addressId, reservationDate: d.reservationDate || undefined, remark: d.remark || undefined };
    }
    return {};
  },

  /** 核价并进入第 3 步 */
  async goPrice() {
    const state = Store.state;
    try {
      const coupon = state.ui.checkout.coupon && state.ui.checkout.coupon.idx >= 0
        ? (state.ui.checkout.coupons || [])[state.ui.checkout.coupon.idx] : null;
      const r = await Api.calculatePrice(state.store.storeCode, state.cart, coupon, state.ui.checkout.needTableware, this.deliveryOpts());
      Store.patchCheckout({ priceResult: r, step: 3 });
    } catch (e) {
      UI.toast('核价失败：' + e.message, 'error');
    }
    this.render(Store.state);
  },

  /** 确认下单 */
  async confirmOrder(btn) {
    const state = Store.state;
    const c = state.ui.checkout;
    const d = c.delivery;
    // 麦乐送前置校验：必须有地址且能找到可配送门店
    if (d.mode === 'delivery') {
      if (!d.addressId) { UI.toast('请先选择或新增配送地址', 'error'); return; }
      if (!d.beCode) { UI.toast('该地址附近暂无可配送门店，请更换地址', 'error'); return; }
    }
    UI.btnLoading(btn, '下单中');
    try {
      const coupon = c.coupon && c.coupon.idx >= 0 ? (c.coupons || [])[c.coupon.idx] : null;
      const r = await Api.createOrder(state.store.storeCode, state.cart, coupon, c.takeWay, c.needTableware, this.deliveryOpts());
      const isDelivery = d.mode === 'delivery';
      const order = {
        orderId: r.orderId || String(Date.now()),
        pickupCode: r.pickupCode || '',
        status: r.status || (isDelivery ? '待配送' : '待支付'),
        storeName: state.store?.storeName || '',
        takeWay: isDelivery ? '麦乐送' : ((c.priceResult?.takeWayList || []).find((t) => t.code === c.takeWay)?.title || c.takeWay),
        delivery: isDelivery ? {
          addressId: d.addressId,
          addressText: (d.addresses || []).find((a) => (a.addressId || a.id) === d.addressId),
          reservationDate: d.reservationDate,
          remark: d.remark,
        } : null,
        items: state.cart.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
        total: fenToYuan(c.priceResult?.price ?? Store.cartSubtotal() * 100),
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        message: r.message || '',
      };
      Store.addOrder(order);
      Store.clearCart();
      Store.patchCheckout({ step: 4, orderResult: r });
      UI.toast(isDelivery ? '下单成功，请留意配送进度' : '下单成功，请完成支付', 'success');
    } catch (e) {
      UI.toast('下单失败：' + e.message, 'error');
    }
    UI.btnRestore(btn);
    this.render(Store.state);
  },

  /* ---------- 麦乐送：地址 / 门店 / 状态 ---------- */

  /** 切换取餐模式（到店自取 / 麦乐送） */
  async setDeliveryMode(mode) {
    const d = Store.state.ui.checkout.delivery;
    if (mode === d.mode) return;
    // 券按门店口径拉取（自取=当前门店 beType=1；麦乐送=配送门店 beType=2+beCode），
    // 切换模式后旧券池/已加载标记必须重置，否则第 2 步会沿用另一口径的券（实测复现）
    const resetCoupons = { coupons: [], couponsLoaded: false, claimable: [], coupon: null, priceResult: null };
    if (mode === 'delivery') {
      Store.patchDelivery({ mode: 'delivery' });
      Store.patchCheckout(resetCoupons);
      this.render(Store.state);
      await this.loadAddresses();
    } else {
      // 回到自取：清空配送选择，恢复按当前门店核价
      Store.patchDelivery({ mode: 'takeout', addressId: '', beCode: '', stores: [], storesLoaded: false, reservationDate: '', reservationOptions: [], remark: '' });
      Store.patchCheckout(resetCoupons);
      this.render(Store.state);
    }
  },

  /** 加载我的配送地址 */
  async loadAddresses() {
    if (Store.state.ui.checkout.delivery.loadingAddresses) return; // 防重入
    Store.patchDelivery({ loadingAddresses: true, addressesLoaded: false });
    try {
      const list = await Api.getDeliveryAddresses();
      const cur = Store.state.ui.checkout.delivery;
      const patch = { addresses: list, addressesLoaded: true, loadingAddresses: false };
      // 已有选中地址失效时自动选第一个；pickingAddress 守卫避免与手动选择竞态
      if (list.length && !list.some((a) => (a.addressId || a.id) === cur.addressId) && !cur.pickingAddress) {
        Store.patchDelivery(patch);
        await this.pickAddress(list[0].addressId || list[0].id || '');
        return;
      }
      if (cur.addressId && !cur.beCode && !cur.pickingAddress && !cur.storesLoaded) {
        Store.patchDelivery(patch);
        await this.pickAddress(cur.addressId);
        return;
      }
      Store.patchDelivery(patch);
      this.render(Store.state);
    } catch (e) {
      Store.patchDelivery({ addressesLoaded: true, loadingAddresses: false, addresses: [] });
      UI.toast('配送地址加载失败：' + e.message, 'error');
      this.render(Store.state);
    }
  },

  /** 选择配送地址 → 查询可配送门店（拿 beCode）→ 切换当前门店为配送门店 */
  async pickAddress(addressId) {
    if (!addressId) return;
    if (Store.state.ui.checkout.delivery.pickingAddress) return; // 防重入
    Store.patchDelivery({ addressId, pickingAddress: true, stores: [], storesLoaded: false, beCode: '', reservationOptions: [] });
    Store.patchCheckout({ priceResult: null });
    this.render(Store.state);
    try {
      const stores = await Api.getDeliveryStores(addressId);
      if (!stores.length) {
        Store.patchDelivery({ stores: [], storesLoaded: true, beCode: '' });
        UI.toast('该地址附近暂无可配送门店', 'error');
        return;
      }
      const target = stores[0];
      const beCode = target.beCode || target.beCodeName || '';
      Store.patchDelivery({
        stores, storesLoaded: true, beCode,
        // 门店可预约时段（麦乐送预约单）：{ date, today, reservationOptionText }
        reservationOptions: Array.isArray(target.reservationTimeOptions) ? target.reservationTimeOptions : [],
      });
      // 切换当前门店为配送门店（菜单/购物车/核价全部按配送门店口径）
      if (target.storeCode && target.storeCode !== Store.state.store?.storeCode) {
        const deliveryStore = {
          storeCode: target.storeCode,
          storeName: target.storeName || '',
          address: target.address || '',
          businessStartTime: target.businessStartTime || '',
          businessEndTime: target.businessEndTime || '',
          businessStatus: target.businessStatus,
          distance: target.distance,
          _delivery: true,
        };
        Store.setStore(deliveryStore);
        try {
          const menu = await Api.getMenu(deliveryStore.storeCode, 2, beCode);
          Store.setMenu(menu);
        } catch (me) {
          UI.toast('配送门店菜单加载失败：' + me.message, 'error');
        }
      }
      // 配送口径预核价，让价格区反映真实外送价（含打包费）
      try {
        const r = await Api.calculatePrice(Store.state.store.storeCode, Store.state.cart, null, Store.state.ui.checkout.needTableware, this.deliveryOpts());
        Store.patchCheckout({ priceResult: r });
      } catch (_) { /* 预核价失败不阻塞流程，第 3 步会再核 */ }
    } catch (e) {
      Store.patchDelivery({ storesLoaded: true, stores: [], beCode: '' });
      UI.toast('配送门店查询失败：' + e.message, 'error');
    } finally {
      Store.patchDelivery({ pickingAddress: false });
      this.render(Store.state);
    }
  },

  /** 打开新增地址表单 */
  openAddressForm() {
    const geo = Store.state.geo;
    const city = (Store.state.storeRef && Store.state.storeRef.city) || (geo.place && geo.place.city) || '北京市';
    UI.modal(`
      <div class="detail-body">
        <div class="detail-name">📍 新增配送地址</div>
        <p class="detail-desc">地址将保存到你的麦当劳账号，用于麦乐送下单。</p>
        <div class="addr-form">
          <div class="dp-field"><label class="dp-label" for="af-contact">联系人 *</label>
            <input class="store-input" id="af-contact" type="text" placeholder="怎么称呼您" maxlength="20" /></div>
          <div class="dp-field"><label class="dp-label" for="af-phone">手机号 *</label>
            <input class="store-input" id="af-phone" type="tel" placeholder="11 位手机号" maxlength="11" inputmode="numeric" /></div>
          <div class="dp-field"><label class="dp-label" for="af-city">城市 *</label>
            <input class="store-input" id="af-city" type="text" value="${esc(city)}" maxlength="30" /></div>
          <div class="dp-field"><label class="dp-label" for="af-address">地址 *</label>
            <input class="store-input" id="af-address" type="text" placeholder="如：朝阳区建国路 88 号" maxlength="100" /></div>
          <div class="dp-field"><label class="dp-label" for="af-detail">门牌号 / 详细地址 *</label>
            <input class="store-input" id="af-detail" type="text" placeholder="如：SOHO 现代城 1 号楼 502" maxlength="100" /></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn btn-ghost" data-action="close-modal" type="button">取消</button>
          <button class="btn btn-primary" style="flex:1" data-action="save-address" type="button">保存地址</button>
        </div>
      </div>`);
  },

  /** 保存新增地址 → 刷新列表并自动选中 */
  async saveAddress() {
    const v = (id) => (document.getElementById(id) || {}).value || '';
    const addr = {
      contactName: v('af-contact').trim(),
      phone: v('af-phone').trim(),
      city: v('af-city').trim(),
      address: v('af-address').trim(),
      addressDetail: v('af-detail').trim(),
    };
    if (!addr.contactName || !addr.phone || !addr.city || !addr.address || !addr.addressDetail) {
      UI.toast('请填写完整的地址信息', 'error'); return;
    }
    if (!/^1\d{10}$/.test(addr.phone)) { UI.toast('手机号格式不正确（11 位、1 开头）', 'error'); return; }
    UI.closeModal();
    Store.patchDelivery({ savingAddress: true });
    UI.toast('正在保存地址…');
    try {
      const created = await Api.createDeliveryAddress(addr);
      const list = await Api.getDeliveryAddresses();
      const newId = (created && (created.addressId || created.id))
        || (list[list.length - 1] && (list[list.length - 1].addressId || list[list.length - 1].id)) || '';
      Store.patchDelivery({ addresses: list, addressesLoaded: true, savingAddress: false });
      UI.toast('地址已保存', 'success');
      await this.pickAddress(newId);
    } catch (e) {
      Store.patchDelivery({ savingAddress: false });
      UI.toast('地址保存失败：' + e.message, 'error');
      this.render(Store.state);
    }
  },

  /** 查询订单状态 / 配送进度 */
  async queryStatus(orderId) {
    if (!orderId) { UI.toast('缺少订单号', 'error'); return; }
    Store.patchDelivery({ statusLoading: true, statusOrderId: orderId });
    this.render(Store.state);
    try {
      const r = await Api.queryOrderStatus(orderId);
      Store.patchDelivery({ statusLoading: false, statusResult: { orderId, ...r } });
      UI.toast('订单状态已更新', 'success');
    } catch (e) {
      Store.patchDelivery({ statusLoading: false });
      UI.toast('状态查询失败：' + e.message, 'error');
    }
    this.render(Store.state);
  },

  /** 选择配送时段（空 = 立即送出） */
  setDeliverySlot(dt) {
    Store.patchDelivery({ reservationDate: dt || '' });
  },
};
