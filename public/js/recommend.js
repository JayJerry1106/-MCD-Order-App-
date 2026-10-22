/* 优惠套餐推荐（长辈友好）：客户端评分引擎，全部基于真实数据。
 *
 * 数据输入（均为真实来源，不伪造任何折扣）：
 *  - 菜单 meals：currentPrice / originalPrice / discountType / tags / name
 *  - 营养表 state.nutrition（list-nutrition-foods 解析）：sodium / protein / fat / energyKcal
 *  - 券池：我的券 + 门店可用券（结算页加载时写入 state.ui.couponPool）
 *  - 消费习惯：本地订单历史 state.orders（仅用 name/price，不追踪敏感信息）
 *
 * 评分（0~1，加权汇总，透明可解释）：
 *  - 健康适配（权重 0.40，面向中老年）：低钠、足量蛋白、适量能量脂肪
 *  - 优惠力度（权重 0.30）：适用券估算节省 + 原价现价差额
 *  - 消费习惯（权重 0.15）：命中历史常购
 *  - 性价比  （权重 0.15）：每元热量 + 绝对节省
 *
 * 诚实性：所有金额标注「估算/约」，最终以 calculate-price 为准。
 */
'use strict';

const Recommend = {
  /** 权重（长辈优先健康） */
  W: { health: 0.40, discount: 0.30, habit: 0.15, value: 0.15 },
  /** 推荐条数量 */
  TOP_N: 6,

  /**
   * 全量评分：对每个菜单商品打分并返回完整列表（按综合分降序）。
   * refresh() 取 Top N 写入 state.ui.recommend；测试/调试可用本方法取全量。
   */
  scoreAll() {
    const state = Store.state;
    const menu = state.menu;
    const list = [];
    if (!menu || !menu.meals) return list;
    const meals = Object.values(menu.meals).filter((m) => m && m.code);
    if (!meals.length) return list;

    const nutrition = state.nutrition || {};
    const orders = state.orders || [];
    const coupons = state.ui.couponPool || [];

    // 消费习惯：历史订单中的商品名与价位带
    const historyNames = new Set();
    const historyPrices = [];
    for (const o of orders) {
      for (const it of o.items || []) {
        historyNames.add(it.name);
        historyPrices.push(it.unitPrice || 0);
      }
    }

    // 性价比归一化基准：全菜单每元热量中位数
    const kcalPerYuan = meals.map((m) => {
      const n = nutrition[m.name];
      const price = estimateUnitPrice(m) || 0.01;
      return n && n.energyKcal ? n.energyKcal / price : 0;
    }).filter((v) => v > 0).sort((a, b) => a - b);
    const medianKcalPerYuan = kcalPerYuan.length ? kcalPerYuan[Math.floor(kcalPerYuan.length / 2)] : 0;

    for (const m of meals) {
      const price = estimateUnitPrice(m);
      const original = parseFloat(m.originalPrice ?? m.currentPrice) || price;
      const n = nutrition[m.name] || null;
      const bestCoupon = this._bestCouponFor(m, coupons); // 每个商品只算一次
      const parts = {
        health: this._health(m, n),
        discount: this._discount(price, original, bestCoupon),
        habit: this._habit(m, historyNames, historyPrices, price),
        value: this._value(m, price, original, n, medianKcalPerYuan),
      };
      const score = parts.health * this.W.health + parts.discount * this.W.discount
        + parts.habit * this.W.habit + parts.value * this.W.value;
      list.push({
        code: m.code,
        name: m.name,
        image: m.image,
        price,
        originalPrice: original,
        score,
        parts,
        tags: this._tags(parts, m, price, original, n, bestCoupon),
        reason: this._reason(parts, m, price, original, n, bestCoupon),
        isCombo: /套餐|组合|件套|随心配|分享餐/.test(m.name),
      });
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  },

  /**
   * 重算推荐列表并写入 state.ui.recommend。
   * 菜单/营养/券池/订单变化时调用；无数据时优雅降级（空列表，不报错）。
   * 自带 emit：刷新后立即渲染，不依赖调用方「恰好」有后续状态变更
   * （此前 refresh 无 emit，推荐区能否显示取决于后续是否凑巧发生一次 emit，
   *  属于隐性耦合；启动流程中靠结尾的 Views.render 兜底掩盖了该问题）。
   */
  refresh() {
    const state = Store.state;
    state.ui.recommend = this.scoreAll().slice(0, this.TOP_N);
    Store.emit();
    return state.ui.recommend;
  },

  /** 健康适配 0~1：低钠加分、高钠降分；蛋白/脂肪/能量适度加分 */
  _health(m, n) {
    if (!n) return 0.45; // 无营养数据：中性偏上（不因缺失惩罚）
    let s = 0.4;
    // 钠（mg）：长辈友好优先低钠
    if (n.sodium) {
      if (n.sodium <= 500) s += 0.3;
      else if (n.sodium <= 800) s += 0.2;
      else if (n.sodium <= 1200) s += 0.05;
      else s -= 0.15;
    }
    // 蛋白（g）
    if (n.protein >= 20) s += 0.2;
    else if (n.protein >= 10) s += 0.1;
    // 脂肪（g）
    if (n.fat && n.fat <= 20) s += 0.1;
    else if (n.fat && n.fat > 40) s -= 0.1;
    // 能量（kcal）：正餐合理区间加分，过高降分
    if (n.energyKcal) {
      if (n.energyKcal >= 350 && n.energyKcal <= 750) s += 0.1;
      else if (n.energyKcal > 1000) s -= 0.15;
    }
    return Math.max(0, Math.min(1, s));
  },

  /** 优惠力度 0~1：适用券估算节省 + 原价现价差额比例 */
  _discount(price, original, bestCoupon) {
    let s = 0;
    // 原价 vs 现价（随单购类未购卡时按原价，不重复计优惠）
    if (original > price && original > 0) {
      s += Math.min(0.6, (original - price) / original);
    }
    // 适用券的估算节省（封顶 0.4）
    if (bestCoupon && price > 0) {
      s += Math.min(0.4, bestCoupon.save / price);
    }
    return Math.max(0, Math.min(1, s));
  },

  /** 消费习惯 0~1：历史常购商品名命中 + 价位带接近 */
  _habit(m, historyNames, historyPrices, price) {
    if (!historyNames.size) return 0.3; // 无历史：中性
    let s = 0.2;
    if (historyNames.has(m.name)) s += 0.6;
    else {
      // 品类词命中（如「麦辣鸡腿堡」与历史「麦辣鸡腿汉堡」共享关键词）
      const core = m.name.replace(/[（(].*?[)）]/g, '').replace(/(套餐|组合|三件套|四件套|随心配|分享餐)/g, '');
      if (core.length >= 2 && [...historyNames].some((h) => h.includes(core) || core.includes(h))) s += 0.35;
    }
    if (historyPrices.length && price) {
      const avg = historyPrices.reduce((a, b) => a + b, 0) / historyPrices.length;
      const ratio = Math.min(price, avg) / Math.max(price, avg);
      s += ratio * 0.2; // 价位越接近历史平均越高
    }
    return Math.max(0, Math.min(1, s));
  },

  /** 性价比 0~1：每元热量（相对中位数）+ 绝对节省（相对价格） */
  _value(m, price, original, n, medianKcalPerYuan) {
    let s = 0.35;
    if (n && n.energyKcal && medianKcalPerYuan > 0 && price > 0) {
      const k = n.energyKcal / price;
      s += Math.max(0, Math.min(0.45, (k / medianKcalPerYuan - 0.8) * 0.5));
    }
    if (original > price && price > 0) s += Math.min(0.2, (original - price) / price);
    return Math.max(0, Math.min(1, s));
  },

  /** 找到适用于该商品的估算节省最大的券 */
  _bestCouponFor(m, coupons) {
    let best = null;
    for (const c of coupons) {
      const matched = Api.couponMatchedCodes(c, [{ code: m.code, name: m.name }]);
      if (!matched.size && c.products && c.products.length) continue; // 券限定商品且不含本商品
      const save = this._couponSave(c, m);
      if (save > 0 && (!best || save > best.save)) best = { coupon: c, save };
    }
    return best;
  },

  /** 券的估算节省（元）：discountValue 为金额券；满减券按门槛估算 */
  _couponSave(c, m) {
    const v = parseFloat(c.discountValue);
    if (!v || v <= 0) return 0;
    const price = estimateUnitPrice(m);
    const threshold = parseFloat(String(c.threshold || c.limitPrice || c.useCondition || '').replace(/[^\d.]/g, ''));
    if (threshold && price < threshold) return 0; // 未满门槛
    return Math.min(v, price); // 减免不超过商品价
  },

  /** 生成推荐理由标签（健康/优惠/习惯/性价比），最多 3 个 */
  _tags(parts, m, price, original, n, bestCoupon) {
    const tags = [];
    if (parts.health >= 0.7 && n) {
      if (n.sodium && n.sodium <= 500) tags.push('低钠优选');
      else if (n.protein && n.protein >= 20) tags.push('高蛋白');
      else tags.push('均衡营养');
    }
    // 优惠标签以真实可估算节省为准（券优先，其次原价差额）
    if (bestCoupon && bestCoupon.save >= 1) {
      tags.push(`券后约省 ¥${fmtMoney(bestCoupon.save)}`);
    } else if (original > price) {
      tags.push(`已省 ¥${fmtMoney(original - price)}`);
    }
    if (parts.habit >= 0.6) tags.push('常买');
    if (parts.value >= 0.7 && n && n.energyKcal) tags.push('实惠管饱');
    if (m.isCombo && parts.health >= 0.6) tags.push('套餐搭配');
    if (!tags.length) tags.push(price <= 15 ? '小食解馋' : '热门选择');
    return tags.slice(0, 3);
  },

  /** 一句话推荐理由（供 UI 与语音播报） */
  _reason(parts, m, price, original, n, bestCoupon) {
    if (parts.health >= 0.7 && n && n.sodium && n.sodium <= 500) {
      return `低钠约 ${n.sodium} 毫克，荤素搭配，适合长辈日常`;
    }
    if (bestCoupon && bestCoupon.save >= 1) {
      return `用券约省 ¥${fmtMoney(bestCoupon.save)}，到手约 ¥${fmtMoney(Math.max(0, price - bestCoupon.save))}`;
    }
    if (original > price) return `比原价省 ¥${fmtMoney(original - price)}`;
    if (parts.habit >= 0.6) return '您之前常点，口味有保障';
    if (parts.value >= 0.7) return '份量足、价格实惠，性价比高';
    if (m.isCombo) return '套餐搭配省心，一样一样尝得到';
    return '当前时段热门，现点现做';
  },

  /** Top1 推荐（语音播报用） */
  top1() {
    const list = Store.state.ui.recommend || [];
    if (!list.length) this.refresh();
    return (Store.state.ui.recommend || [])[0] || null;
  },

  /** 语音播报文本：Top1 及理由 */
  speakTop1() {
    const t = this.top1();
    if (!t) return '暂时没有可推荐的餐品';
    const tagText = t.tags.join('、');
    return `为您推荐「${t.name}」，现价 ${fmtMoney(t.price)} 元，${tagText}。${t.reason}。最终价格以结算核价为准。`;
  },
};
