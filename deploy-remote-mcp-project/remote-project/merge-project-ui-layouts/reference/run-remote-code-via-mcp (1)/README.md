# PULSEDESK · MCP 远程项目本地运行

本仓库通过用户提供的 MCP 服务拉取了远程项目 `setup-mcp-project-locally`，并在本地运行。

## 远程源码

- 位置：`remote/setup-mcp-project-locally/`
- 文件数：26
- 完整性：`remote/source-manifest.json` 记录每个文件的 SHA-256 与字节数；拉取后全部校验一致。
- 远程业务源码、样式、配置未被修改。

## 当前 Vite 预览层

当前环境要求入口为 `src/App.tsx`，因此新增了一个独立预览运行层：

- `src/App.tsx`：加载远程原页面。
- `src/runtime/bootstrap.ts`：将 `/api/*` 请求分发到远程原 route handler。
- `src/db/`：为静态预览提供 PGlite 浏览器 PostgreSQL 适配。
- `src/components`、`src/lib`、`src/server`：指向远程原目录的符号链接，用于解析原项目 `@/` 别名。
- `public/runtime/`：预打包的 PGlite 浏览器引擎与 WASM 资源。

预览数据库为会话级内存 PostgreSQL；原始 Next.js 服务仍使用自己的 `DATABASE_URL` 连接外部 PostgreSQL。

## 运行原始 Next.js 项目

```bash
cd remote/setup-mcp-project-locally
npm install
export DATABASE_URL='postgresql://user:password@host:5432/database'
npm run dev
```

生产构建：

```bash
npm run build
npm run start
```

当前 sandbox 中原始 Next.js 生产服务运行在 `http://127.0.0.1:3001`。未配置真实 PostgreSQL 时，`/api/health` 会返回 `{"ok":false}`，但行情与回测页面仍可按原代码降级运行。

## 运行当前静态预览

```bash
npm install
node scripts/build-pglite.mjs
npm run build
npm run preview
```

当前 sandbox 中预览服务运行在 `http://127.0.0.1:4173`。

## Vela 工作区终端（UI 重构）

默认入口已换成与 [vela.luxalgo.com/chart](https://vela.luxalgo.com/chart) 同款的外壳——直接使用 `@luxalgo/vela/workspace`（远程项目本来就依赖 `@luxalgo/vela`）：

- 顶栏：符号搜索（输入字母即搜）、周期（1/3/5/15/30/60/240/D/W）、价格样式、指标（70+ 内置）、撤销/重做、提醒、面板、截图
- 左侧：完整绘图工具栏（趋势线、斐波那契、形态、头寸工具…）
- 图表：状态行 OHLC、符号水印、右侧价格轴、十字光标；WebGL2 原生渲染
- 底栏：1D/7D/1M/3M/6M/YTD/1Y/5Y/全部 区间 + UTC 时钟
- 右上「交易」：PULSEDESK 的信号与确认引擎侧栏

数据源是自写的 `OKXProvider`（`src/vela/okxProvider.ts`）：OKX 永续 REST 渐进分页（先出图再变深，5m 约 6000 根）+ 公共 WebSocket 实时 K 线。Provider 同时维护一份 K 线镜像供侧栏使用——侧栏看到的就是图表看到的。

### 自研的顶栏控件（绕开库内命中缺陷）

`@luxalgo/vela` 0.9.3 的内置下拉（周期 / 样式）与 WebGL 画布存在**命中翻转**：弹层视觉在上，命中却落到画布，表现为"周期点不中、样式选不了"。三个互相叠加的原因：

1. 画布 `position: absolute` 覆盖绘图区，与弹层的合成层争抢命中；
2. 鼠标移入的瞬间命中目标在画布 ↔ 菜单之间翻转（pointerdown 在菜单、pointerup 落到画布）；
3. `ctx.setTimeframe` 在部分场景静默无效，必须走 `chart.setMarket()`。

对策（`src/vela/`）：
- `marketControls.tsx` — **自研周期 / 样式控件**：接管顶栏槽位，下拉面板渲染在 React 树（portal 到 body，`z-index` 2147483000），点击必然命中；周期切换走 `setMarket`，样式走 `setPriceStyle`
- `topbarLabels.ts` — 按钮显示当前值（"15m ▾"/"K线 ▾"），监听 `market:changed` 与 `priceStyle:change` 实时刷新
- `stackGuard.ts` — 兜底：任意 Vela 弹层打开时关闭画布的 `pointer-events`
- `hitFix.ts` — 手势跟踪：按下/抬起目标不一致时补发 `pointerup` + `click`
- `toolbarHover.ts` — 保留 Vela 原生绘图能力与收藏；悬浮工具分组约 190ms 展开，flyout 跟随当前图标的纵坐标，并提供搜索、分组和深色滚动条。工具图标尺寸调到与参考图相近的 21px。
- `IndicatorPickerDialog.tsx` — **指标库**：三栏布局（分类 / 可搜索目录 / 详情和添加），使用真实 OKX K 线生成预览；支持收藏、分类筛选、连续添加和再次点击移除。弹窗通过 Portal 挂到 body，因此使用自己的不透明深色背景，不依赖 Vela 容器变量。

「交易」侧栏（`src/vela/TradePanel.tsx`）直接在图表当前 K 线上跑确认引擎，任意币种/周期都成立：

- 实时结论：最新收盘 K 是否出现二次测试、概率环、是否过门槛、E/SL/TP
- 概率门槛滑杆、5 种出场方案、门槛扫描迷你图（点击柱子即切换门槛）
- 信号列表：点击任一笔 → 图上画出 **原生头寸工具**（入场/止损/目标，框头 R:R）+ 关键位射线 + 颈线 + 信号箭头，并对准视口；再点取消
- 「关键位」开关：把当前仍有效的历史顶/底画成淡色射线
- 「引擎详情」/ `Shift+C`：打开完整分析面板（校准、样本外、寻优）

原始 PULSEDESK 页面仍可通过 `/#legacy` 访问，远程源码零改动。

## 入场确认引擎

原引擎的问题：`confl`（订单流确认）只是结构强度的副本，`detectAt` 直接 `void _of` 丢弃订单流入参，默认 `entryMode: 'limit'` 等于「碰到关键位就挂单」。也就是**看见双顶就卖、看见双底就买**。

新增的确认层（全部在 `src/quant/`、`src/api/engine.ts`、`src/components/confirm/`，远程源码零改动）：

| 模块 | 作用 |
| --- | --- |
| `quant/model.ts` | 14 个因子的定义与权重，logistic 组合 → 成功概率；缺数据的因子贡献恒为 0 |
| `quant/scan.ts` | 复用远程 `scanDoubles` 的形态几何，计算因子证据；5 种出场方案一次算好 |
| `quant/stats.ts` | 概率校准、门槛扫描、因子归因、分币种、拒绝主因 |
| `quant/fit.ts` | MAP 逻辑回归（L2 向先验收缩）、walk-forward、AUC/Brier/Wilson 区间、单因子样本外诊断 |
| `quant/optimize.ts` | 入场 × 出场 × 门槛网格搜索，按样本外稳健性排序 |
| `lib/engine.ts` | 覆盖 `detectAt` / `simulate`：真正消费订单流入参，门槛不达标则 `skipped` |

因子分三组：
- **订单流**：二次测试缩量、主动成交差背离、关键位吸收、拒绝影线、确认K量能、盘口失衡、大单主动方向
- **结构**：关键位完整度、形态高度、时间跨度、趋势已转平、推进减速、波动环境
- **风险**：目标可达性（预测的是胜率，所以高 R:R 是负证据）

面板（快捷键 `C`）提供：概率门槛滑杆、5 种出场方案、配置寻优一键应用、A/B 对照、样本外 walk-forward、单因子诊断、逐单归因。

### 诚实的验证结论

在 BTC/ETH/SOL × 5m/15m 约 30–45 天样本上：

- 样本外 AUC ≈ 0.43–0.51，**这套因子尚未通过判别力检验**，面板会直接红字提示。
- 14 个因子里只有「推进减速」在训练段与测试段方向一致。
- 两处建模错误已修正：趋势因子原本奖励强逆势抄底（接飞刀）；R:R 原本正向加分，但预测胜率时目标越远越难兑现。
- 出场方案影响显著：原「颈线目标」超时占 38%；改「1R 减半 + 保本」或「固定 1.5R」后胜率与净 R 明显改善。
- 通过双重检验的组合：**等确认K + 固定 1.5R + 门槛 66%**（样本内 62%/n26/+0.20R，样本外 56%/n16/+0.07R）。

实时下单始终使用先验权重，拟合结果只用于检验，不回写交易规则。

## 验证

```bash
npm run build
npx tsc --noEmit
node scripts/verify-controls.mjs           # 周期/样式切换（8 轮真实点击）、工具栏悬浮、指标多选、侧栏
node scripts/verify-catalog.mjs            # flyout 锚点/搜索/绘图激活 + 指标库分类/搜索/添加/移除
node scripts/verify-terminal.mjs            # Vela 终端：外壳、交易侧栏、图上标注、符号切换
node scripts/smoke.mjs                      # 原页面（/#legacy）
node scripts/verify-engine.mjs              # 确认引擎分析面板
node scripts/smoke.mjs http://127.0.0.1:3001 --original
```

浏览器验证覆盖：页面渲染、图表 canvas、health/data/backtest API、信号写入、币种切换、周期切换、图层开关、回测面板、历史空状态。

OKX 公共行情接口可能返回 429；原项目自带重试与仿真降级逻辑，未做改动。

## MCP 拉取脚本

- `scripts/mcp-client.mjs`：MCP JSON-RPC 客户端。
- `scripts/pull-mcp.mjs`：枚举远程文件、分块读取、按 SHA-256 校验并写入本地。

重新拉取需要提供 `MCP_URL_BASE64`，并先通过 `scripts/mcp-client.mjs init` 建立会话。
