# 麦当劳 MCP 操作手册（mcp-playbook）

不经过 UI、直接调用麦当劳 MCP 完成「选门店→菜单→核价→下单」的全部要点。所有结论均经实测验证。

## 0. 快速调用

用 skill 内置脚本（自动从应用 `.env` 读 Token）：

```bash
node <skill目录>/scripts/mcp.js <工具名> '<JSON参数>'
# 例：node scripts/mcp.js query-nearby-stores '{"beType":1,"searchType":2,"city":"北京市","keyword":"国贸"}'
```

协议：`POST https://mcp.mcd.cn/`（**根路径**），`Authorization: Bearer <TOKEN>`，JSON-RPC 2.0 `tools/call`；业务数据在 `result.structuredContent` 的信封 `{success,code,message,data}`。限流 600 次/分钟。

## 1. 工具清单

| 工具 | 用途 | 关键入参 |
| --- | --- | --- |
| `query-nearby-stores` | 搜门店 | `beType`(1 到店自取/5 得来速), `searchType`(2 按位置), `city`, `keyword` |
| `query-meals` | 菜单（按时段返回） | `storeCode, orderType(1 到店/2 外送), beType, beCode, reservationDate` |
| `query-meal-detail` | 商品详情（选配轮次+特调） | `storeCode, orderType, beType, code` |
| `available-coupons` / `auto-bind-coupons` | 可领券列表 / 一键领取 | — |
| `query-my-coupons` | 我的券包 | `page, pageSize` |
| `query-store-coupons` | 门店可用券 | `storeCode, orderType, beType` |
| `calculate-price` | 核价（返回 `takeWayList` 取餐方式） | `storeCode, orderType, items, needTableware, withOrder` |
| `create-order` | 下单 | `storeCode, items, takeWayCode, addressId, needTableware, remark, withOrder` |
| `list-nutrition-foods` | 营养数据（CSV 文本） | — |

`beType=5`（得来速）时门店返回 `beCode`，后续所有调用必须带 `beCode`。

## 2. items 组装（最容易出错的部分）

购物车每行 → `items[]` 一个元素：

```jsonc
{
  "productCode": "商品编码",
  "quantity": 1,
  "couponId": "券ID",        // 可选；只能绑到券适用商品，否则报 600012
  "couponCode": "券码",
  "roundList": [              // 套餐选配轮次（套餐必传）
    { "round": "1", "comboItemList": [ { "code": "子商品编码", "quantity": 1,
      "modification": { "values": [ { "code": "MOD码", "key": "selectedKey", "quantity": 1 },
                                    { "code": "MOD码", "key": "unselectedKey", "quantity": 0 } ] } } ] }
  ],
  "modification": { "values": [] }   // 单品特调（与 roundList 二选一）
}
```

特调铁律（实测）：

1. 选中项传 `selectedKey`，quantity ≥ 1；
2. **未选中项若带 `unselectedKey` 也必须传**，quantity = 0；
3. `minValues=1 && maxValues=1 && values.length===1` 为必选项，UI/流程须强制选择。

## 3. 券使用规则

- 券只能绑到适用商品：有 `products[].productCode` 按 code 精确匹配；无 products 按券名关键词匹配商品名。匹配不上就不要绑（只参与试算）。
- 智能选券方法：逐张调用 `calculate-price` 试算，取实付最低。
- 券来自三路：`available-coupons`（可领）→ `auto-bind-coupons`（一键领取）→ `query-my-coupons`（已领进卡包）；另可叠 `query-store-coupons`（门店券）。

## 4. 价格口径

- 所有金额单位为**分**。
- `calculate-price` 返回 `productOriginalPrice / productPrice / discount / tablewarePrice / price / productList / takeWayList`。
- **随单购商品**（`discountType` 含「随单购」）：不加购卡时按原价计费（实测 15.6 + 卡11.9 = 27.5 > 原价 26）。
- 取餐方式：从核价返回的 `takeWayList` 取 `code` 回传给下单的 `takeWayCode`。

## 5. 错误码

| code | 含义 | 处理 |
| --- | --- | --- |
| 600012 | 促销规则不支持该商品（券绑错） | 精确匹配后再绑 |
| 60006 | 商品已售罄或不可售（含时段不符） | 早餐 10:30 前只能点早餐商品 |
| 信封 success:false | 业务拒绝 | 读取 `message` 告知用户真实原因 |

## 6. 定位与门店距离

- MCP **不接受经纬度**，门店也不返回坐标；`distance`（米）相对 `keyword` 解析点。
- 链路：设备定位 → 逆向地理编码（Nominatim 小区级优先 / BigDataCloud 区县级兜底，国内 Nominatim 常不可达）→ 用 POI 名搜门店。
- 精度规律：POI 级关键词最准（建外SOHO→最近店 107m）；区县级约 226m；`city` 参数主导搜索（实测「济南市+无影山」正常返回金牛大厦等 5 家济南门店；「济南市+国贸」退化为城市级结果）；完全无法解析的关键词返回 0 家（提示换词）。
- 诚实性校验：返回门店均不在目标城市时，界面提示「关键词可能未被正确解析（已回退默认参考点）」；演示模式（无 Token，如 pages.dev 链接）只返回北京·国贸快照，界面会明确标注，不得向用户谎称实时结果。

## 7. 下单前的确认纪律

1. 下单产生**真实订单**，执行前必须向用户复述：门店、商品清单（含选配与特调）、用券、应付金额、取餐方式，得到明确确认。
2. 金额必须以 `calculate-price` 返回为准，禁止口算。
3. 演示模式（无 Token）下不得声称已真实下单。

## 8. 相关 skill 分工

- 只要「怎么点划算/推荐方案」→ `mcd-saver-strategist`（麦门省钱精算师）或 `mcd-order-agent`。
- 要操作点餐应用 UI 或真实走查下单流程 → 本 skill（麦麦小助手）。
