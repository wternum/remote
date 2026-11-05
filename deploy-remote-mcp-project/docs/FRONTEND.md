# 前端实现

前端是一个 React 19 单页应用（`src/main.tsx` → `src/App.tsx`），经 Vite 打成单文件。主界面是 LuxAlgo Vela 图表工作区（`@luxalgo/vela`，WebGL2 渲染），数据源为 OKX 永续；另保留原版 PULSEDESK 页面与审计看板两个哈希入口。

## 1. 入口与路由（src/App.tsx）

| 入口 | 内容 |
| --- | --- |
| `/`（无哈希） | Vela 工作区（默认）：图表 + 指标库 + 周期/样式控件 + 信号标注侧栏 |
| `/#legacy` | 原版 PULSEDESK 页面（`remote/setup-mcp-project-locally/src/app/page.tsx`，懒加载） |
| `/#audit` | 缺陷修复任务卡看板（`src/audit/AuditBoard.tsx`，懒加载） |
| `Shift + C` | 开合「入场确认引擎」面板（输入框内不拦截，Vela 自身快捷键不受影响） |

`startRuntime()`（`src/runtime/bootstrap.ts`）在模块加载时后台初始化浏览器内 API 分发与 PGlite，失败只打警告，不阻塞首屏、也没有启动动画。各懒加载块有中文占位文案（如「正在加载原始 PULSEDESK 页面…」）。

## 2. Vela 工作区（src/vela/VelaTerminal.tsx）

构造参数（`new VelaWorkspace`）：

| 项 | 值 |
| --- | --- |
| 默认市场/周期 | `okx:BTC-USDT-SWAP` / `5`（5 分钟；已保存的工作区状态优先） |
| 主题/语言/时区 | dark / zh-Hans（`registerLocale`）/ Etc/UTC |
| 数据 provider | `okx: () => new OKXProvider()` |
| 周期表 | `1, 3, 5, 15, 30, 60, 240, D, W`（`OKX_TIMEFRAMES`） |
| 涨/跌色 | `#2ebd85` / `#f6465d`，`glow: 0.25`，成交量开，原生绘图工具栏开 |
| 持久化 | `persist: 'pulsedesk-vela-workspace'`（localStorage） |
| 顶栏左 | `symbol`、`pd-timeframes`（自研周期控件）、`pd-style`（自研样式控件）、`indicators`（自研指标库）、`actions`、`undo-redo` |
| 顶栏右 | `actions`、`alerts`、`panels`、`screenshot` |

构造前一次性注册（顺序有意义）：`registerLocale(zhHans)`、`registerIndicatorPicker()`、`registerMarketControls()`、`registerSignalPanel()`、`registerAnnotLayers()`（渲染器构造时按注册表实例化图层，必须在前）。工作区实例挂在 `window.__velaWs` 供调试/测试与确认引擎面板读取当前市场。另有符号兜底：持久化的已下架符号会在 1.6s 后回退 BTC。

### 已清理的旧交易侧栏

旧 `registerTradePanel` 链路在当前入口没有调用方，现已删除其7个组件/hooks及专用样式。未删除 `#legacy` 或Shift+C确认引擎；它们不是这条废弃链路。历史文件名仅在审计看板/快照中作为历史记录存在。

## 3. 数据接入层

### OKXProvider（src/vela/okxProvider.ts）

实现 Vela 的 `DataProvider` 契约，浏览器直连 OKX（公共接口允许跨域）：

- 符号：仅 `BTC-USDT-SWAP`、`ETH-USDT-SWAP`、`SOL-USDT-SWAP` 三个永续；品牌图标内联为 SVG data URL（BTC `#F7931A` / ETH `#627EEA` / SOL `#9945FF`），不依赖 CDN；
- 历史：REST `/api/v5/market/candles` 首屏后用 `history-candles` 分页回填，429 时退避重试（不把限频当成功空页），单次上限 12,000 根；
- 实时：`wss://ws.okx.com/ws/v5/business` 订阅 `candle{bar}` 频道（代码注释说明已弃用旧 8443 端点）；
- `barsHub` 镜像：每 `ticker|timeframe` 保留最近 12,000 根并广播变更——信号标注、订单流判读、确认候选都读它，保证与图表所见一致；
- 周期映射：Vela 分钟数/`D`/`W` → OKX `5m`/`1H`/`1Dutc` 等（`toOkxBar`/`tfMs`）。

### 标注运行器

`signals/runtime.ts` 直接订阅 `barsHub`、真实成交与市场事件，不依赖旧交易侧栏hooks。`recompute.ts` 根据已收盘OHLC/成交指纹决定是否重算；实时价与形成中成交只在预览开启时触发对应预览。侧栏收起后运行器继续工作。

### 外壳增强（针对 Vela 原生弹层与 WebGL 画布的命中冲突）

| 模块 | 作用 |
| --- | --- |
| `hitFix.ts` | 手势级命中修复：按下/抬起目标不一致时重放或补发给 chrome 元素 |
| `stackGuard.ts` | 任一 Vela 弹层打开时关闭画布 `pointer-events`（CSS 类 `vela-chrome-open`） |
| `marketControls.tsx` | 顶栏「周期」「图表样式」下拉改由 React portal 渲染到 body，绕开画布命中 |
| `topbarLabels.ts` | 把周期/样式按钮文本同步为当前值（如 `15m ▾`）；用 `data-pd-kind` 定位（文本会被改写） |
| `toolbarHover.ts` / `toolbarSlide.ts` / `lib/drawing-menu.ts` | 绘图工具栏悬停打开、飞出菜单几何与键盘处理；参考站实测尺寸（52px 轨道、38px 行、32px 目标、20px 字形） |

## 4. 信号标注（src/vela/signals/）

Vela 原生侧栏（id `pulsedesk-signals`，宽 320px、可调 300–440px，`registerSignalPanel.tsx` 注册），另有独立 widget attachment 挂载运行器——**收起侧栏不停止标注计算**；首次访问且视口 ≥720px 时 300ms 后自动打开一次。

当前为 **7个显示控制、一形态一条判读**。完整规则见 [标注模块说明](../src/vela/signals/README.md)，取证与清理清单见 [优化记录](OPTIMIZATION.md)。

- 默认先看「双顶双底 / 正在跟踪」，可切「含历史」；辅助背景独立页签、默认关闭。
- 每条详情六段：结论、关键区域力量、真实成交、陷阱、突破回踩路径、参考位/失效；有原始确认时间及后续事件时间线。
- `mwStory.ts` 是唯一结论出口；`scenario.ts` 只返回价格生命周期，`evidence.ts` 只返回可验证证据。
- 当前形态最多3个（方向去重），观察区带最多2块；历史点选可替换一席聚焦，不复活过期状态。普通同价背景线让位于主形态。
- 点事件定位图表；六段详情可滚动，Canvas只显示有边界的摘要，不塞超高文字卡。
- `pulsedesk.signal-annotations.v2` 自动迁移v1共有开关/显示设置并保留旧值，已合并的四类证据不再作为独立记录。临时焦点不持久化。
- 盘中预览仅是提示，不改主标题/阶段/方向/目标；新收盘可以产生新的阶段事件。真实历史成交回补可补证据，不回填价格确认时点。
- 历史缺口截断到最新连续段并提示；真实成交覆盖不足不会被写成中性或假数据。

## 5. 指标库（src/vela/library/）

顶栏「指标」打开（`IndicatorPickerDialog.tsx` 宿主 + `registerIndicatorPicker` 接管槽位）：

- 数据：`catalog.json` 来自 LuxAlgo library 接口快照（801 个指标、853 个概念、17 个分类，抓取于 2026-10-08，`data.ts` 导出并附中文族名映射）；
- 视图：发现（最新/探索/分类磁贴）、全部指标（最新/名称排序、网格/列表、分页）、分类 + cluster 筛选、概念浏览、内置指标；
- 添加：能对应到图表原生指标的走 `availableNativeIndicators()` / `addNativeIndicator()` 原生添加，其余 Library 脚本给出托管图表链接；
- 搜索同时命中内置/Library/概念并高亮；收藏存 `localStorage['vela-indicator-library-favorites-v1']`；键盘 `↑/↓`、`Enter`、`Shift+Enter`、`F`、`Esc`、`/`；
- 响应式：≤980px 详情滑入，≤720px 左侧导航变横向条。细则见 `src/vela/library/README.md`。

## 6. 入场确认引擎面板（Shift+C）

`src/components/confirm/ConfirmEnginePanel.tsx` + `useEngine.ts`，数据来自 `/api/engine/scan`（跟随当前图表市场，`readActiveMarket()` 读 `__velaWs.chart.market`）。板块（与代码中的 Section 一一对应）：

当前候选与概率环/证据条 → 配置寻优（入场 × 出场 × 门槛网格、样本外双重检验、一键应用）→ A/B 对照（见形态就进场 vs 确认后进场）→ 样本外验证 Walk-Forward（含单因子样本外诊断、AUC/Brier 等）→ 出场方案对照 → 概率校准（分桶柱/线/理想对角）→ 门槛扫描 → 累计净 R（门槛前 vs 后）→ 分币种表现 → 因子看板 → 被门槛挡掉的主因 → 逐单明细与归因。门槛/入场方式的修改经 `setConfig` 同步 localStorage + cookie（见 `docs/STRATEGY.md` 第 4 节）。

## 7. 原版页面（#legacy）

`remote/setup-mcp-project-locally/src/app/page.tsx`（835 行，远程原文件）组装：`Header`（品牌/币种/周期/行情条）+ `VelaChart` + `CommandDeck`（实时信号流、置信环、CVD sparkline、核心策略卡）+ `StatsDrawer`（recharts 回测统计抽屉）+ `Toasts`。

- 图表为早期 Vela 插件接入（`src/components/VelaChart.tsx` + `components/vela/plugins.ts`）：`pa-overlay` 自定义画布层（信号标注/FVG/聚焦结构/多空仓位工具）与 `pa-cvd` 原生副图指标（K 线估算 Delta 的累计 CVD）；
- 实时 feed 用 `src/lib/okx-ws.ts` 的 `OKXFeed`：状态 `connecting → live`（WS），WS 不可达时转 `poll`（轮询 `/api/data?tail=1`），再不可达为 `sim`；
- 数据请求：`/api/data`（行情）、`/api/backtest`（回测，含 ALL 范围）、`/api/signals`（POST 实时信号落库）。

## 8. 审计看板（#audit）

`src/audit/AuditBoard.tsx` 渲染 `src/audit/tasks.ts` 的结构化数据：10 张缺陷任务卡（构建/后端/策略/订单流/前端五类，当前全部 `done`），每张含现象、文件级证据、根因、修复方案、验证方式与涉及文件；顶部 `AUDIT_META` 声明原则「不改动 remote/ 原始文件，修复落在 src 覆盖层」。它是历史修复记录的只读看板，不是运行时监控。

## 9. 样式体系

- Tailwind CSS v4：Vite 侧 `@tailwindcss/vite`，样式入口 `src/index.css`（`@import` 远程原版 `globals.css` 后叠加工作区外壳样式）；Next 侧 `src/app/globals.css` 仅 `@import "tailwindcss"`；
- Vela 外壳专用样式：`src/vela/drawing-toolbar.css`、`indicator-library.css`、`symbol-picker.css`、`signals/signals.css`，均按参考站实测尺寸手写作用域样式；
- 配色令牌（深色）：底 `#0a0d13` / 面板 `#10151f` / 边框 `#1d2534`，多 `#2ebd85`、空 `#f6465d`、强调 `#37c8dd`、警告 `#f0b90b`、次要文字 `#8c96ab`；字体 Space Grotesk + IBM Plex Mono（`index.html` 引入）。
