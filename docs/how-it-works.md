# 实现笔记

## 页面结构

- 站点是 Next.js + Arco Design，CSS Modules 的 class 带哈希：`account-overview_<name>__<hash>`，所以一律用 `[class*="<name>"]` 匹配。
- 关键节点：

```
account-overview_pageDesc
  ├ account-overview_title          用量和费用
  └ account-overview_paramsBox      顶部容器（账户金额卡在这里）
        └ account-overview_accountAmountCard
* account-overview_usageDetailSection
  ├ account-overview_sectionTitle   使用详情
  ├ account-overview_sourceTabs     Step Plan / API
  ├ account-overview_paramsBox.planOverview
  │     └ account-overview_planUsageCard   Credit 账户卡（含 cardReset 灰字行）
  ├ account-overview_timeselect     原生日期控件 + 重置/查看汇总
  └ .arco-table                     原生用量表
```

## 两个技术决定

### 1) 顶部并排放「Credit 账户」和「账户金额」—— 克隆，不搬 React 节点

第一版把 Credit 卡 `insertBefore` 到顶部容器，切到 API 标签时 React 卸载父节点会抛
`NotFoundError: Failed to execute 'removeChild'`，整页白屏。

现在：把原生 Credit 卡 `cloneNode(true)` 放进顶部容器的 `#sfx-credit-clone`，原生卡 `display:none`。
React 的 DOM 一个都不动。克隆体内也有 `planUsageCard`，选原生卡时必须用 `.closest('#sfx-credit-clone')` 排除。

### 2) 使用详情整表由脚本渲染

原表的列、分页、汇总都不受控，所以 Step Plan 分支下把原生表与日期控件隐藏，改为脚本自己的表：

- 数据只来自 `QueryStepPlanUsages`，按区间缓存到 `st.rec[kind]`，切换命中缓存不重复请求。
- 渲染签名 `range|mode|行数|数据版本|custom.start|custom.end`，签名不变不重绘（避免用户正在输入日期时输入框被重建）。
- 区间改动统一走 `reload()`：忙时 300ms 重试，避免「先改开始日、再改结束日」的第二次请求被吞。

## 接口（页面自己在用的那套）

```
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/<方法>
  Content-Type: application/json
  Connect-Protocol-Version: 1
  Oasis-Platform: web
  Oasis-appID: 10300
  Oasis-Webid: <localStorage.web_id，可能是带引号的 JSON 字符串>
  credentials: include
```

| 方法 | 用途 |
| --- | --- |
| `GetStepPlanStatus` | 套餐名、激活时间、到期时间 |
| `QueryStepPlanRateLimit` | Credit 桶（总量/剩余/到期/下次重置时间） |
| `QueryStepPlanUsages` | 用量明细：`{startTime, toTime, page, pageSize, granularHour:1}`，时间戳是**毫秒字符串**，`pageSize` 实测可到 200 |

记录字段：`from_time / to_time / model_id / calls / credit_consumed / in_amount / out_amount / cache_amount`。

## 踩过的坑

1. **Arco 的 RangePicker 是受控组件**：`input.value = x` + `dispatchEvent('input')`（连绕过 React value tracker 的 native setter 写法）都无效，值会被 React 弹回。要用脚本改区间只能真点日历：`focus()+click()+mousedown` 打开面板 → 按 `2026年9月` 表头定位 `.arco-panel-date` → 点 `.arco-picker-cell-in-view` 里文本等于日号的格子。现在改成自己渲染日期框，不再依赖它。
2. **翻月箭头**：每个 `.arco-picker-header` 有 4 个 `.arco-picker-header-icon`，内层两个带 `-hidden`；左面板可见的是 [上一年, 上一月]、右面板可见的是 [下一月, 下一年]，取错就跳到上一年。
3. **`from_time` 是毫秒**：按秒解析会算出「6-05 11:00」这种假时段。
4. **表格列一挤就换行**：`table-layout:auto` 下加列要同时给新列固定宽度并把表宽抬到「容器宽 + 新列宽」。
5. **React 会重画表头/表体**：注入都要带标记 + MutationObserver 防抖补回；标记过的东西不要重复加。

## 参考设计的复原

原截图的视觉是按站点自身元素做标尺量出来的：图里表格行高 63px、表头 64px，而同一页 100% 缩放下是 41px；标题字高 25px vs 15–16px —— 比值一致 ≈1.54。也就是说那张截图是 ~155% 缩放下截的，按图像像素直接抄字号会大 55%。现在所有尺寸都按 k=1.54 折算回站点自身尺度，再用 `container-type:inline-size` + `@container (max-width:760px)` 做窄窗堆叠。
