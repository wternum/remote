# 指标库（Indicator Library）

参考 `https://vela.luxalgo.com/chart` 的 Indicators 面板重构，仅替换指标库，不影响图表、左侧工具栏和交易面板。

## 结构

- `IndicatorBrowser.tsx` — 弹窗内容（头部搜索、三栏工作区、底栏快捷键）
- `indicator-library.css` — 按参考站实测尺寸实现的样式（1080×680 弹窗、52px 头部、208/590/280 三栏、34px 底栏）
- `catalog.json` / `data.ts` — 来自参考站的 801 个指标、853 个概念与 17 个分类（含中文分类名）；快照来源与抓取时间记录在 `catalog.json` 的 `source` / `fetchedAt` 字段（`https://app.luxalgo.com/api/library/indicators/query?fields=card&sort=name&pageIndex=0&pageQuantity=1000`，2026-10-08），来源与抓取时间只保留在 `catalog.json` 内（`data.ts` 不再重复导出），运行时不实时请求该接口
- `../IndicatorPickerDialog.tsx` — 顶栏「指标」按钮宿主

## 行为

- **发现**：最新发布（3 张）、更多探索（可换一批）、17 个分类磁贴
- **全部指标**：最新 / 名称排序、网格 / 列表、显示更多分页
- **分类浏览**：对应分类的指标 + 参考站的 cluster 筛选标签
- **概念**：853 个概念，点开可查看库内实现
- **内置**：基础指标与订单流来自当前图表的 `availableNativeIndicators()`，点击即调用原生 `addNativeIndicator()`
- **Library 指标**：名称能对应到图表内置指标时同样可原生添加（例如 Bollinger Bands、MACD、RSI），否则显示为 Library 脚本并提供托管图表链接
- **搜索**：同时命中内置指标、Library 指标与概念，结果高亮
- **收藏**：写入 `localStorage`（`vela-indicator-library-favorites-v1`），跨开关保持
- **键盘**：`↑/↓` 浏览、`Enter` 添加、`Shift+Enter` 添加并保持打开、`F` 收藏、`Esc` 关闭、`/` 聚焦搜索
- **响应式**：≤980px 详情变为滑入面板；≤720px 左侧导航变为横向条

## 验证

`node tests/library.browser.mjs`（默认开发地址；生产包用 `TEST_URL=http://127.0.0.1:4173/`）。规则见 `tests/README.md`。
