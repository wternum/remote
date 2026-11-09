# PULSEDESK · OKX 短线信号终端 —— 项目总文档

> 本文件是项目的**唯一总说明文档**，由对整个本地代码库的逐模块阅读整理而成，替代原先分散在 `docs/`、`README-PULSEDESK.md`、`src/vela/signals/README.md`、`src/vela/library/README.md`、`tests/README.md` 中的说明内容（迁移对照见 [第 12 章](#12-附录与证据索引)）。
>
> **证据标注约定**（全文通用）：
> - 【代码已确认】= 已在本地源码中逐行读到，附文件路径与符号名；
> - 【本次运行已验证】= 在本机实际执行过命令并观察到结果；
> - 【旧文档描述】= 仅见于旧文档、未在本次阅读中从代码复核；
> - 【合理推断】= 由代码结构推出但未直接读到断言；
> - 【尚未确认】= 存在疑点，需进一步核实。
>
> 本文不修改任何业务源码、配置、依赖或数据库；不含任何密钥、令牌或真实连接凭据（相关位置一律使用占位符）。

---

## 目录

1. [项目总览](#1-项目总览)
2. [技术栈与依赖](#2-技术栈与依赖)
3. [目录结构与模块关系](#3-目录结构与模块关系)
4. [启动过程与生命周期](#4-启动过程与生命周期)
5. [主要功能的端到端实现](#5-主要功能的端到端实现)
6. [核心模块源码级说明](#6-核心模块源码级说明)
7. [数据模型与数据流](#7-数据模型与数据流)
8. [接口与横切机制](#8-接口与横切机制)
9. [配置、运行、构建与部署](#9-配置运行构建与部署)
10. [测试、排障与已知限制](#10-测试排障与已知限制)
11. [可视化图示](#11-可视化图示)
12. [附录与证据索引](#12-附录与证据索引)

---

## 1. 项目总览

### 1.1 项目解决什么问题

PULSEDESK 是一个**中文加密货币短线观察工作台**。它把三件事放在同一张图表上：

1. **形态识别**：在 OKX USDT 本位永续合约（BTC / ETH / SOL）的 5m / 15m K 线上识别双顶（M）与双底（W）的"历史关键位第二次测试"结构；
2. **证据判读**：用 OKX 真实的 taker（吃单方）主动成交数据，回答"这次二次测试到底是拒绝还是突破""关键位/颈线破位后有没有回踩、回踩是否守住""是否出现扫位收回（诱多/诱空候选）"；
3. **概率化入场确认与自我检验**：把 19 个证据因子加权成一个入场成功概率，并提供校准、门槛扫描、配置寻优、Walk-Forward 样本外验证等工具，让使用者自己检验这个概率是否可信。

【代码已确认】项目**不下单、不连接任何交易账户、不保存 API Key**。全部数据来源是 OKX 公共行情接口（`src/server/okx.ts:5` `BASE = "https://www.okx.com"`、`src/vela/okxProvider.ts:10`、`src/quant/flow.ts:62-63`），全库检索无任何私有接口签名逻辑。

### 1.2 使用者与使用场景

| 使用者 | 场景 | 入口 |
| --- | --- | --- |
| 短线交易者（人工决策） | 打开图表看当前 M/W 结构、六段证据、突破回踩路径 | `/`（Vela 工作区 + 右侧「信号标注」侧栏） |
| 策略研究者 | 检验 19 因子概率模型的校准度、样本外表现、门槛选择 | `Shift + C`（入场确认引擎面板） |
| 需要历史统计的人 | 跑双顶/双底回测，看胜率、期望 R、分币种/分形态表现 | `/#legacy`（原版页面 + 回测统计抽屉） |
| 维护者 | 查看历史缺陷修复记录（10 张任务卡） | `/#audit`（审计看板） |

### 1.3 系统边界

**边界内**：
- 浏览器端 React 19 单页应用（Vite 打成单文件 HTML）；
- Next.js 16 App Router 提供的 6 个 HTTP 接口（行情聚合、回测、实时信号写入、健康检查、引擎扫描、OKX rubik 白名单代理）+ 根路由静态托管；
- 双运行时数据库：服务端 PostgreSQL（`pg` + Drizzle）/ 浏览器内 PGlite（WASM 版 PostgreSQL，会话级内存库）；
- 图表渲染由第三方 `@luxalgo/vela`（WebGL2）承担，本项目实现其 `DataProvider` 契约与若干插件（渲染图层、侧栏、顶栏控件）。

**边界外**（【代码已确认】不存在）：
- 下单 / 撤单 / 仓位管理 / 账户鉴权；
- 订单簿事件型 OFI（需要 `books` 增量 + `seqId` 连续校验的管线，项目未实现；`src/vela/signals/orderflow-keylevel-research.md` 第 3.2、4 节明确说明为何不把 taker delta 称为 OFI）；
- 逐价 Footprint（`FlowBar` 只保存每根 K 线的 buy/sell 总额，`FlowTrade` 不保存成交价 `px` 用于分箱——见 `src/quant/flow.ts:12-36`）；
- 止损单识别（公共成交流不含用户委托，故只称"诱多/诱空**候选**"）；
- 用户系统 / 权限体系（无任何认证中间件）。

### 1.4 当前已实现 / 尚未实现

**已实现（代码已确认）**：

| 能力 | 实现位置 |
| --- | --- |
| Vela 图表工作区（中文、深色、UTC） | `src/vela/VelaTerminal.tsx` |
| 自研 OKX DataProvider（REST 渐进历史 + WS 实时 + `barsHub` 镜像） | `src/vela/okxProvider.ts` |
| M/W 统一判读（一形态一记录、六段证据、事件时间线、7 个显示控制） | `src/vela/signals/{patterns,evidence,scenario,mwStory,analyze,store,runtime,recompute}.ts` |
| 标注画布渲染（两层 Canvas：`pd-annot-under` / `pd-annot-over`） | `src/vela/annotLayer.ts` + `src/vela/annotLayout.ts` |
| 19 因子入场确认模型 + 五种出场方案 | `src/quant/{model,scan,config}.ts` |
| 真实订单流数据层（逐笔 tape + rubik 官方统计 + 覆盖率校验） | `src/quant/flow.ts` |
| 订单流判读（二次测试 / 触顶触底 / 突破回踩 / 摆动关键位） | `src/quant/orderflow.ts` |
| 聪明钱结构观察（SMC 5 项 + 可选 taker 佐证） | `src/quant/smartmoney.ts` |
| 统计 / 拟合 / 寻优（校准、门槛扫描、IRLS 逻辑回归、Walk-Forward、网格搜索） | `src/quant/{stats,fit,optimize}.ts` |
| 6 个 HTTP API + 根路由 | `src/app/route.ts`、`src/app/api/**`、`src/api/engine.ts` |
| 浏览器内 API 分发 + PGlite | `src/runtime/{bootstrap,statsProxy}.ts`、`src/db/index.ts` |
| 指标库（801 指标 / 853 概念 / 17 分类快照） | `src/vela/library/{IndicatorBrowser.tsx,data.ts,catalog.json}` |
| 原版页面（`#legacy`）与审计看板（`#audit`） | `remote/setup-mcp-project-locally/src/app/page.tsx`、`src/audit/{tasks.ts,AuditBoard.tsx}` |
| Vela 外壳增强（命中修复、弹层遮罩、顶栏标签、绘图工具栏悬停/飞出菜单） | `src/vela/{hitFix,stackGuard,topbarLabels,toolbarHover,toolbarSlide}.ts`、`src/lib/drawing-menu.ts` |

**尚未实现 / 已停用**：

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 旧「交易侧栏」链路（`registerTradePanel` → `TradePanel` → `FlowRead`/`useFlow`/`useLiveFlow`/`useChartBars`/`vela/annotate`） | **文件仍在仓库中，但已是孤岛代码**：`registerTradePanel.tsx` 无任何入向引用，`src/App.tsx` 与 `VelaTerminal.tsx` 都不调用它 | 【代码已确认】引用图核查；旧文档 `docs/OPTIMIZATION.md` 第 4 节称"已移除"，与本地实际文件状态冲突（详见 [10.4](#104-文档与代码的冲突记录必读)） |
| `src/vela/signals/keyLevelCall.ts`（旧并列判读出口） | 活动代码无引用，仅 `tests/key-level-call.test.ts:6` 仍导入它 | 【代码已确认】 |
| `src/utils/cn.ts` | 无入向引用（`src/lib/format.ts:73` 另有同名 `cn` 实现被使用） | 【代码已确认】 |
| 事件型 OFI、逐价 Footprint、账户仓位、止损识别、自动下单 | 未实现 | 【代码已确认】+ `docs/OPTIMIZATION.md` 第 6 节 |
| 跨市场样本外校准 | 未做；所有阈值都是工程启发式参数 | 【代码已确认】`src/quant/model.ts` 权重为硬编码常量，`src/quant/config.ts:13-17` 注释说明默认门槛 0.58 的取舍理由 |

### 1.5 整体架构一句话

> Vite 把整个前端打成一个 `dist/index.html`；Next.js 只负责托管这个文件并提供 `/api/*`；SPA 启动后在浏览器内**再拦截一次**同源 `/api/*` 请求，用同一批 handler + PGlite 内存库执行，因此"纯静态托管"与"Next 托管"两种部署都能跑完整功能，唯一例外是必须走真实后端代理的 `/api/okx/*`。

【代码已确认】`src/runtime/bootstrap.ts:36-57`（`window.fetch` 包装）、`src/app/route.ts:6-36`（根路由读文件返回 HTML）。

---

## 2. 技术栈与依赖

### 2.1 语言与运行时

| 项 | 版本 | 来源 | 作用 |
| --- | --- | --- | --- |
| Node.js | 要求 20.19+ 或 22.12+ | 【旧文档描述】`README-PULSEDESK.md:7`；本机实测 v20.20.2【本次运行已验证】 | 构建与 Next 服务端运行时 |
| TypeScript | `5.9.3`（devDependencies，精确锁定） | `package.json:47` | 全项目类型系统；`tsconfig.json` `strict: true`、`moduleResolution: "bundler"`、`paths: {"@/*": ["./src/*"]}` |
| React | `19.2.6` / `react-dom 19.2.6`（精确锁定） | `package.json:29-30` | SPA UI；入口 `src/main.tsx` 用 `createRoot` + `StrictMode` |

### 2.2 构建链（双构建器）

| 工具 | 声明版本 | 作用 | 关键配置 |
| --- | --- | --- | --- |
| Vite | `^7.3.7` | 构建全部前端为**单文件** SPA | `vite.config.ts`：`react()` + `tailwindcss()` + `viteSingleFile()`；alias `@ → src` |
| `vite-plugin-singlefile` | `^2.3.0` | 把 JS/CSS 全部内联进 `dist/index.html` | 【本次运行已验证】产物 3.4MB 单文件 |
| `@vitejs/plugin-react` | `^5.1.1` | React Fast Refresh / JSX 转换 | — |
| Next.js | `16.2.6`（精确锁定，App Router + Turbopack） | 托管根路由 + 6 个 `/api/*` 路由；**不渲染任何页面组件**（无 `src/app/page.tsx`） | `next.config.ts` 为空配置 `{}` |
| esbuild | `^0.28.1` | 两处用途：① `scripts/prepare-runtime.mjs` 打包 PGlite 浏览器运行时；② `scripts/run-ts-test.mjs` 打包 TS 单测后在 Node 执行 | `target: es2022`（运行时）/ `node20`（测试） |
| Tailwind CSS | `4.1.17`（`tailwindcss` + `@tailwindcss/vite` + `@tailwindcss/postcss` 三处同版本） | 样式；Vite 侧走 `@tailwindcss/vite`，Next 侧走 `postcss.config.mjs` 的 `@tailwindcss/postcss` | 样式入口 `src/index.css`（`@import` 远程原版 `globals.css` 后叠加外壳样式）、`src/app/globals.css`（仅 `@import "tailwindcss"`） |
| drizzle-kit | `0.31.10`（dev） | 可选命令行建表 `npx drizzle-kit push` | `drizzle.config.json`：`schema: ./src/db/schema.ts`，连接串为本地默认占位 `postgresql://postgres:postgres@127.0.0.1:5432/app_db` |
| ESLint | `9.39.4` + `eslint-config-next 16.2.6` | `npm run lint` | `eslint.config.mjs` 用 flat config，`globalIgnores([".next/**","out/**","build/**","next-env.d.ts"])` |
| Playwright | `@playwright/test ^1.64.1`（**列在 dependencies**） | 6 个浏览器回归脚本 | 脚本用 `process.env.TEST_URL` 指定被测地址 |

### 2.3 关键第三方库

| 库 | 版本 | 在本项目中的具体作用 |
| --- | --- | --- |
| `@luxalgo/vela` | `^0.9.3` | 图表工作区（WebGL2 渲染）。项目使用其 `VelaWorkspace`、`DataProvider` 契约、`registerRendererLayer`（自研标注图层）、`registerSidePanel` / `registerWidgetAttachment`（信号侧栏与运行器）、`registerLocale`（zh-Hans）、`registerIcon`、`msg`。导入路径细分：`@luxalgo/vela/workspace`、`@luxalgo/vela/plugin`、`@luxalgo/vela/ui`、`@luxalgo/vela/locales/zh-Hans` |
| `@electric-sql/pglite` | `^0.5.14` | 浏览器内 PostgreSQL（WASM）。`src/db/index.ts:8` 硬编码 `PGLITE_VERSION = '0.5.14'` 用于 CDN 回退；实例为 `PGlite.create('memory://pulsedesk-original')` |
| `drizzle-orm` | `0.45.2`（精确锁定） | 双运行时 ORM：服务端 `drizzle-orm/node-postgres`、浏览器 `drizzle-orm/pglite`（两者都在 `src/db/index.ts` 内 `require`/动态 import） |
| `pg` | `8.20.0`（精确锁定） | 服务端 PostgreSQL 连接池（`new Pool({connectionString: process.env.DATABASE_URL})`） |
| `dotenv` | `17.3.1`（精确锁定） | 【尚未确认】`src/` 与 `scripts/` 中未检索到 `dotenv` 的 import；Next.js 自身会加载根目录 `.env`，该依赖可能是模板遗留 |
| `recharts` | `^3.10.1` | 原版页面 `#legacy` 的回测统计抽屉图表（`src/components/StatsDrawer.tsx`） |
| `lucide-react` | `^1.66.0` | 【尚未确认】未在 `src/` 检索到 import；项目自绘 SVG 图标（`src/components/ui/Icon.tsx`、`registerSignalPanel.tsx` 的 `svg16`），疑为模板遗留 |
| `clsx` / `tailwind-merge` | `^2.1.1` / `^3.4.0` | 【尚未确认】未在 `src/` 检索到 import；`src/lib/format.ts:73` 自带 `cn` 实现，疑为模板遗留 |

### 2.4 声明版本 / 锁定版本 / 实际运行版本

【本次运行已验证】仓库提交的 `package-lock.json` 与 `package.json` **不同步**，因此：

- `npm ci` 直接失败，报错包含 `Missing: next@16.2.6 from lock file`、`Missing: drizzle-kit@0.31.10`、`Invalid: lock file's drizzle-orm@0.45.4 does not satisfy drizzle-orm@0.45.2`、`Invalid: lock file's pg@8.23.1 does not satisfy pg@8.20.0` 等约 30 条；
- 本次改用 `npm install`（按 `package.json` 重新解析并同步锁文件），成功安装 **475 个包**；
- 实际运行版本以 `npm install` 后的 `node_modules` 为准：Next.js 启动横幅显示 `next-server (v16.2.6)`【本次运行已验证】，与声明一致。

> ⚠️ 这意味着 `README-PULSEDESK.md` / 旧 `README.md` 中"快速开始"的 `npm ci` 一步在当前仓库快照上**不可用**（见 [10.3 常见配置错误](#103-常见配置错误与运行问题)）。本文档已把安装步骤改为 `npm install`。

### 2.5 外部服务依赖

| 服务 | 端点 | 是否需要密钥 | 用途 |
| --- | --- | --- | --- |
| OKX 公共 REST | `https://www.okx.com/api/v5/market/{candles,history-candles,ticker,books,history-trades}`、`/api/v5/public/{funding-rate,instruments}`、`/api/v5/rubik/stat/*` | 否 | 全部行情、逐笔、官方 taker/OI 统计 |
| OKX 公共 WebSocket | `wss://ws.okx.com/ws/v5/business`（`candle{bar}` 频道）、`wss://ws.okx.com/ws/v5/public`（`trades`、`books5` 频道） | 否 | 实时 K 线、逐笔成交流、盘口 |
| PostgreSQL | `process.env.DATABASE_URL` | 是（连接串） | 服务端持久化；缺失时静默降级 |
| jsDelivr CDN | `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.14/dist/*` | 否 | 仅在本地 `public/runtime/` 二进制校验不合格时回退（`src/db/index.ts:9,15`） |
| Google Fonts | `fonts.googleapis.com`（Space Grotesk + IBM Plex Mono） | 否 | `index.html:9-11` 引入；不可达时回退系统字体 |
| LuxAlgo library API | `https://app.luxalgo.com/api/library/indicators/query` | 否 | **仅抓取快照时用**；运行时不请求，指标库读本地 `catalog.json`（`src/vela/library/data.ts:31-32` 导出 `CATALOG_SOURCE` / `CATALOG_FETCHED_AT`，快照抓取于 `2026-10-08T19:28:38Z`） |

---

## 3. 目录结构与模块关系

### 3.1 带说明的目录树

```text
.
├── index.html                    Vite SPA 的 HTML 模板（挂载点 #root，入口 /src/main.tsx）
├── package.json                  脚本与依赖声明（name 仍为模板名 "nextjs-postgresql-template"）
├── （无 package-lock.json）      锁文件已不在仓库中，npm ci 不可用，需 npm install（见 2.4）
├── vite.config.ts                react + tailwind + singlefile 三插件，alias @→src
├── next.config.ts                空配置 {}
├── tsconfig.json                 strict、bundler 解析、@/* 路径、next 插件
├── drizzle.config.json           drizzle-kit push 用；连接串为本地默认占位
├── postcss.config.mjs            @tailwindcss/postcss（Next 侧）
├── eslint.config.mjs             flat config + next core-web-vitals
├── next-env.d.ts                 Next 自动生成，勿手改
│
├── src/                          ★ 当前活动代码
│   ├── main.tsx                  React 入口：createRoot + StrictMode + 4 份 CSS
│   ├── App.tsx                   哈希路由外壳 + Shift+C + 后台 startRuntime()
│   ├── index.css                 @import 远程 globals.css 后叠加外壳/市场控件/确认引擎样式
│   ├── vite-env.d.ts             Vite 客户端类型 + ?url&inline 模块声明
│   │
│   ├── app/                      Next App Router（只有 route handler，没有 page.tsx）
│   │   ├── route.ts              GET / → 读 dist/index.html（public/index.html 已不在仓库，仅手工放置时回退），再缺 → 503
│   │   ├── layout.tsx            RootLayout（模板遗留：title 仍是 "Arena Next.js PostgreSQL Starter"）
│   │   ├── globals.css           仅 @import "tailwindcss"
│   │   └── api/
│   │       ├── health/route.ts       GET  健康检查（等建表后 select 1）
│   │       ├── data/route.ts         GET  行情聚合（K线+ticker+盘口+资金费率），tail=1 轻量轮询
│   │       ├── backtest/route.ts     GET  双顶/双底回测 + 落库（180s 缓存）
│   │       ├── signals/route.ts      POST 实时信号 upsert
│   │       ├── engine/scan/route.ts  GET  仅转发到 src/api/engine.ts
│   │       └── okx/[...path]/route.ts GET OKX rubik 白名单同源代理（15s 缓存 / 300 条上限）
│   │
│   ├── api/engine.ts             确认引擎扫描 handler（45s 缓存，被 Next 路由与浏览器分发共用）
│   ├── runtime/
│   │   ├── bootstrap.ts          startRuntime()：包装 window.fetch，在浏览器内分发 5 个 handler
│   │   └── statsProxy.ts         /api/okx 例外通道：保留取消、透传 JSON 错误、HTML 回退转 503
│   ├── db/
│   │   ├── schema.ts             一行再导出 remote/.../db/schema.ts（不改远程文件）
│   │   └── index.ts              双运行时：服务端 pg Pool + ensureServerSchema；浏览器 PGlite
│   │
│   ├── server/okx.ts             服务端 OKX 行情层：okxGet/重试/分页并发 + 120s 缓存 + 确定性合成降级
│   ├── lib/
│   │   ├── engine.ts             ★ 引擎覆盖层：export * 原始引擎后覆写 simulate / detectAt
│   │   ├── types.ts              全部核心类型 + SYMBOLS/BARS/barMs/ctValOf
│   │   ├── candles.ts            closedCandles()：只保留已收盘 K 线（防未来函数）
│   │   ├── okxVolume.ts          quoteVolumeFromRow()：OKX 行 → 报价币成交额（三级回退）
│   │   ├── okx-ws.ts             OKXFeed：原版页面用的三态降级 feed（live→poll→sim）
│   │   ├── format.ts             价格/量/R/%/时间格式化 + cn()
│   │   ├── drawing-menu.ts       Vela 绘图工具飞出菜单增强（enhanceDrawingMenus）
│   │   └── indicator-catalog.ts  内置指标目录构建（buildIndicatorCatalog / FEATURED_ORDER）
│   │
│   ├── quant/                    ★ 量化内核（纯函数为主，可单测）
│   │   ├── config.ts             引擎配置（门槛/入场方式/是否替换结构过滤）+ localStorage & cookie 双写
│   │   ├── context.ts            buildContext()：ATR/EMA20/50/量均/delta 序列 + 真实覆盖标记
│   │   ├── model.ts              FACTORS(19) / MODEL / scoreEvidence / GRADE_BANDS / expectancy
│   │   ├── scan.ts               runScan / collectEvidence / candidateFrom / simulateOutcome / 5 种出场
│   │   ├── flow.ts               真实订单流数据层：tape WS+REST 回补、rubik 统计、hasRealFlow 覆盖判定
│   │   ├── orderflow.ts          判读层：readSecondTest / readTouch / scanTouches / readBreakout /
│   │   │                         scanBreakouts / findSwingLevels / nearestLevel / latestBreakout
│   │   ├── smartmoney.ts         SMC 结构观察：dealingRange/findFvgs/latestStructure/liquidityPool/
│   │   │                         orderBlockCandidate/readSmartMoney
│   │   ├── stats.ts              summarize / calibration / thresholdSweep / attribution / equitySeries /
│   │   │                         topKillers / gradeDistribution
│   │   ├── fit.ts                fitLogistic(IRLS) / predict / auc / brier / logLoss / wilson /
│   │   │                         walkForward / fitSparse / factorDiagnostics / rescore
│   │   └── optimize.ts           optimize（入场×出场×门槛网格）/ edgeOverBaseline
│   │
│   ├── vela/                     ★ Vela 工作区集成层（当前主界面）
│   │   ├── VelaTerminal.tsx      一次性注册 5 项后 new VelaWorkspace；挂 window.__velaWs
│   │   ├── okxProvider.ts        OKXProvider（DataProvider 实现）+ barsHub K 线镜像 + toOkxBar/tfMs
│   │   ├── registerSignalPanel.tsx  注册侧栏（id pulsedesk-signals）+ 独立 widget 运行器
│   │   ├── registerIndicatorPicker.tsx / IndicatorPickerDialog.tsx / indicatorStore.ts  指标库入口
│   │   ├── marketControls.tsx    顶栏「周期」「图表样式」React portal 下拉
│   │   ├── topbarLabels.ts       顶栏按钮文本同步（data-pd-kind 定位）
│   │   ├── hitFix.ts             手势级命中修复（按下/抬起目标不一致时重放）
│   │   ├── stackGuard.ts         弹层打开时给画布加 vela-chrome-open（关闭 pointer-events）
│   │   ├── toolbarHover.ts / toolbarSlide.ts   绘图工具栏悬停打开与滑动
│   │   ├── annotTypes.ts         标注数据契约（AnnLevel/AnnEvent/AnnZone/AnnPath/AnnPayload/TONE_COLOR）
│   │   ├── annotLayout.ts        纯几何排版：mergeLevels/layoutRail/buildOccupancy/pickCandidate/
│   │   │                         eventCandidates/zoneCandidates/placeCard/wrapText
│   │   ├── annotLayer.ts         两个 renderer layer 的 Canvas 绘制（renderUnder/renderRail/
│   │   │                         renderEvents/renderZones/renderCard）
│   │   ├── drawing-toolbar.css / indicator-library.css / symbol-picker.css   外壳样式
│   │   ├── signals/              ★ M/W 标注模块（见 6.7）
│   │   │   ├── store.ts          7 个显示控制 + 偏好持久化/迁移 + SignalRuntimeState
│   │   │   ├── recompute.ts      signalRecomputeKey / flowRecomputeKey（重算判定）
│   │   │   ├── patterns.ts       scanAnnotationPatterns：纯价格几何的因果双测识别
│   │   │   ├── evidence.ts       takerObservation/legFlow/realCvdBetween/readMwEvidence
│   │   │   ├── scenario.ts       evaluateLine：关键位/颈线各一次单向因果生命周期
│   │   │   ├── mwStory.ts        ★ 唯一结论出口：groupMwPatterns/analyzeMwStory/buildMwStories/
│   │   │   │                     selectMwStories（六段证据 + 时间线 + 阶段/方向/目标）
│   │   │   ├── analyze.ts        analyzeSignals（校验/连续段/背景项）+ projectSignals（显示投影）
│   │   │   ├── runtime.ts        mountSignalRuntime：订阅 barsHub/flow/偏好，300ms 节流
│   │   │   ├── SignalPanel.tsx / MwStoryDetails.tsx   侧栏 UI 与六段详情
│   │   │   ├── signals.css       侧栏样式
│   │   │   ├── keyLevelCall.ts   ⚠ 孤岛：仅被 tests/key-level-call.test.ts 引用
│   │   │   ├── orderflow-keylevel-research.md / smart-money-research.md   研究笔记（口径依据）
│   │   └── library/              指标库
│   │       ├── IndicatorBrowser.tsx  弹窗主体（发现/全部/分类/概念/内置 五种视图）
│   │       ├── data.ts           catalog.json 的类型化导出 + 中文族名/cluster 映射 + 收藏键
│   │       └── catalog.json      840KB 单行快照：{source,fetchedAt,families[17],indicators[801],concepts[853]}
│   │
│   ├── components/               原版页面组件 + 确认引擎面板
│   │   ├── confirm/ConfirmEnginePanel.tsx（1221 行，14 个 Section）+ useEngine.ts（数据/统计编排）
│   │   ├── Header.tsx / VelaChart.tsx / CommandDeck.tsx / StatsDrawer.tsx / Toasts.tsx / ui/Icon.tsx
│   │   └── vela/plugins.ts       原版页面的早期 Vela 插件（pa-overlay 自定义层 + pa-cvd 副图指标）
│   │
│   ├── audit/
│   │   ├── tasks.ts              10 张缺陷修复任务卡（T1–T10，全部 status:'done'）+ AUDIT_META
│   │   └── AuditBoard.tsx        #audit 看板渲染（按 area 过滤、可展开）
│   │
│   ├── vela/TradePanel.tsx, FlowRead.tsx, useFlow.ts, useLiveFlow.ts,
│   ├── vela/useChartBars.ts, vela/annotate.ts, vela/registerTradePanel.tsx, utils/cn.ts
│   │                             ⚠ 旧交易侧栏孤岛链路（见 1.4 / 10.4）
│   └── App.tsx / main.tsx        （同上）
│
├── remote/                       ★ 原始远程项目源码（被 src 直接 import，契约：不修改）
│   ├── source-manifest.json      导入时逐文件 sha256 + 字节数校验清单
│   └── setup-mcp-project-locally/
│       ├── src/lib/engine.ts     原始几何引擎（914 行）：DEFAULT_PARAMS/PATTERN_META/scanDoubles/
│       │                         scanSide/computeLevels/detectAt/simulate/computeStats/summarize
│       ├── src/db/schema.ts      Drizzle 表定义（signals / backtest_runs）
│       ├── src/app/page.tsx      原版页面（835 行）→ #legacy 懒加载入口
│       ├── src/app/globals.css   被 src/index.css @import
│       └── src/{components,lib,server}/…   原版组件与工具（Header/VelaChart/CommandDeck 等的原始副本）
│
├── remote-project/               导入时的字节校验快照（177 文件，含自己的 TASKS.md/tests/reference）
│   └── merge-project-ui-layouts/ 只存档，不作为活动模块
├── reference/                    更早两版参考实现（90 文件）：run-remote-code-via-mcp 与 (1)
│
├── scripts/
│   ├── prepare-runtime.mjs       ★ 构建第一步：esbuild 打包 PGlite 运行时 + 复制 wasm/data
│   ├── run-ts-test.mjs           单测运行器：esbuild 打包到 .verification/ 后 import 执行
│   ├── （inspect-signals.ts）    ⚠ 已不在仓库：真实市场只读诊断脚本，需从上游取回
│   └── mcp_client.py / import_project.py / complete_import.py
│                                 导入工具（读环境变量 MCP_URL_BASE64；Web 应用不含该地址）
│
├── tests/                        13 个 TS 单测 + 6 个 Playwright 浏览器回归 + 2 个 fixture
├── public/
│   ├── index.html                仓库内预置的一份 SPA 构建产物（3.5MB，dist 缺失时的回退）
│   ├── pglite.js                 PGlite 浏览器运行时（590KB，esbuild 产物）
│   └── runtime/pglite.js         同上（db/index.ts 按 runtime/ 前缀取用）
│                                 ⚠ pglite.wasm / initdb.wasm / pglite.data 未提交到仓库，
│                                    由 prepare-runtime.mjs 构建时从 node_modules 复制
└── README.md                     ★ 本总文档（原 docs/ 与各模块 README 已按 12.3 清理）
```

### 3.2 模块职责与边界

| 层 | 目录 | 职责 | 明确不做的事 |
| --- | --- | --- | --- |
| 入口/路由 | `src/main.tsx`、`src/App.tsx` | 挂载、哈希路由、快捷键、后台启动运行时 | 不含任何业务计算 |
| 传输层 | `src/runtime/` | 浏览器内 API 分发、统计代理例外处理 | 不改写业务 fetch 调用，不维护第二套 handler |
| HTTP 接口 | `src/app/api/`、`src/api/engine.ts` | 参数解析、缓存、编排、持久化 | 不做形态识别/评分（委托 quant 与 lib/engine） |
| 服务端行情 | `src/server/okx.ts` | OKX REST 拉取、重试、并发分页、缓存、合成降级 | 不做订单流（rubik 在 `quant/flow.ts`） |
| 量化内核 | `src/quant/` | 上下文构建、因子证据、概率、判读、统计、拟合、寻优、订单流数据 | 不含 React、不含 DOM（`config.ts` 例外：读写 localStorage/cookie） |
| 引擎覆盖层 | `src/lib/engine.ts` | 用概率门槛替换原引擎的"是否入场"判定 | 不改形态几何（沿用 `scanDoubles`） |
| 图表集成 | `src/vela/` | Vela 工作区装配、DataProvider、外壳增强、标注图层与侧栏 | 不改 Vela 内部实现 |
| 标注业务 | `src/vela/signals/` | M/W 判读的唯一实现链 | 不产生交易信号、不输出校准胜率 |
| 原版 UI | `src/components/`、`remote/.../page.tsx` | `#legacy` 页面与确认引擎面板 | 面板不改远程组件代码，只读 DOM/`__velaWs` |
| 审计 | `src/audit/` | 历史修复记录（只读数据 + 看板） | 不是运行时监控 |
| 存档 | `remote/`、`remote-project/`、`reference/` | 原始/参考代码，字节校验完整性 | **禁止修改**（契约已迁入本文件 [3.3](#33-关键跨模块依赖代码已确认)；`src/audit/tasks.ts` 的 `AUDIT_META.principle` 亦声明） |

### 3.3 关键跨模块依赖（代码已确认）

```text
src/lib/engine.ts        ──export *──▶ remote/.../src/lib/engine.ts   （再导出后覆写 simulate/detectAt）
src/lib/engine.ts        ──import───▶ src/quant/{scan,model,config}   （candidateFrom / FACTORS / getConfig）
src/db/schema.ts         ──export *──▶ remote/.../src/db/schema.ts
src/index.css            ──@import───▶ remote/.../src/app/globals.css
src/App.tsx              ──lazy─────▶ remote/.../src/app/page.tsx      （#legacy）
src/quant/context.ts     ──import───▶ remote/.../src/lib/engine.ts     （atrSeries / approxDeltaAt）
src/quant/scan.ts        ──import───▶ remote/.../src/lib/engine.ts     （DEFAULT_PARAMS/scanDoubles/FEE_RATE…）
src/vela/signals/patterns.ts ─import─▶ remote/.../src/lib/engine.ts     （DEFAULT_PARAMS 的 pivot/tol 常量）
src/runtime/bootstrap.ts ──dynamic───▶ src/app/api/{data,backtest,signals,health}/route + src/api/engine
src/vela/signals/runtime.ts ─import──▶ src/vela/okxProvider.ts(barsHub) + src/quant/flow.ts + analyze.ts
src/vela/annotLayer.ts   ──import───▶ src/vela/annotLayout.ts + annotTypes.ts
src/api/engine.ts        ──import───▶ src/server/okx.ts + src/quant/{scan,model,config,flow} + src/lib/candles.ts
```

> 契约要点【代码已确认】：`remote/` 内的原始文件被 `src/` 以**再导出 + 覆写**的方式扩展，从不就地修改；`src/lib/engine.ts:7` 的 `export *` 之后紧跟同名 `simulate`/`detectAt` 定义实现覆写。

---

## 4. 启动过程与生命周期

本章按**实际入口**追踪，分为「构建期」「服务端启动」「浏览器启动」「运行期」「退出与释放」五段。

### 4.1 构建期（`npm run build`）

`package.json:6` 定义：`node scripts/prepare-runtime.mjs && vite build && next build`，三段缺一不可。

1. **prepare-runtime**（`scripts/prepare-runtime.mjs`，44 行，逐行已读）
   - `require.resolve('@electric-sql/pglite')` 定位包目录，`mkdir public/runtime`；
   - 并行复制 `pglite.wasm`、`initdb.wasm`、`pglite.data` 到 `public/runtime/`（注释说明：把 PostgreSQL 二进制资源本地化，避免依赖 CDN）；
   - 用 esbuild 把 `export { PGlite } from "@electric-sql/pglite"; export { drizzle } from "drizzle-orm/pglite";` 打包成 `public/runtime/pglite.js`（`bundle/format:esm/platform:browser/target:es2022/minify`）；
   - 内联插件 `browser-only-database`：把 `node:*`/`fs`/`path`/`url` 解析到 `unused-node-runtime` 命名空间并返回 `module.exports = {}`，剔除 PGlite 浏览器图中未使用的 Node fs 适配器；
   - 结束打印 `Local PostgreSQL runtime is ready.`。
   - 【本次运行已验证】`node_modules/@electric-sql/pglite/dist/` 确实包含 `initdb.wasm`、`pglite.data`、`pglite.wasm` 三个源文件；仓库本身只提交了 `public/pglite.js` 与 `public/runtime/pglite.js`（GitHub tree API 核查），wasm/data 属构建产物。
2. **vite build** → `dist/index.html`（单文件）+ `dist/pglite.js` + `dist/runtime/`（public 目录被复制）。【本次运行已验证】`dist/index.html` 3.4MB，结尾为 `<div id="root"></div></body></html>`。
3. **next build**（Turbopack）→ `.next/`。【本次运行已验证】输出路由表：
   ```
   ┌ ƒ /                     ├ ○ /_not-found      ├ ƒ /api/backtest
   ├ ƒ /api/data             ├ ƒ /api/engine/scan ├ ƒ /api/health
   ├ ƒ /api/okx/[...path]    └ ƒ /api/signals
   ```
   并伴随一条**已知无害警告**：NFT tracing 提示 `next.config.ts → src/app/route.ts` 链路存在 `path.join(process.cwd(), …)` 的动态文件读取（根路由本就要按路径读产物）。

### 4.2 服务端启动（next start）

1. Next 加载 `src/app/route.ts`（`export const dynamic = 'force-dynamic'`）与 5 个 API 路由；
2. **数据库是懒初始化的**：`src/db/index.ts:52-72` 的 `getDatabase()` 只在首次被访问时 `require('pg')` + `require('drizzle-orm/node-postgres')`，若 `process.env.DATABASE_URL` 存在则 `new Pool(...)` 并**立即**触发 `ensureServerSchema()`（执行 `migrations` 常量里的幂等 SQL）；
3. `ensureServerSchema()`（`src/db/index.ts:38-50`）用模块级 `serverSchema` 缓存 Promise，**失败时把缓存清空并重新抛出**，使下一次请求可以重试，而不是永久缓存 rejected Promise；
4. `db` 是一个 `Proxy`（`src/db/index.ts:74-83`）：任何属性访问都先 `getDatabase()`，拿不到连接就抛 `Local database is not available` —— 这是"无 `DATABASE_URL` 时静默降级"的实现方式：错误被各路由自己的 try/catch 吞掉。
5. 【本次运行已验证】未提供 `.env`（仓库中不存在该文件）时，`next start` 正常启动（`✓ Ready in 136ms`），`GET /api/health` 返回 `{"status":"ok","ok":true,"fallback":true}`。

### 4.3 浏览器启动（SPA 生命周期）

顺序严格如下（`src/main.tsx` → `src/App.tsx`）：

1. **CSS 装载**：`src/main.tsx:3-6` 依次 import `./index.css`（内含 `@import "../remote/setup-mcp-project-locally/src/app/globals.css"`）、`./vela/drawing-toolbar.css`、`./vela/indicator-library.css`、`./vela/symbol-picker.css`；
2. **挂载**：`createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>)`；
3. **模块级副作用**：`src/App.tsx:16-18` 在模块求值时就 `void startRuntime().catch(...)` —— 后台初始化，**不阻塞首屏、没有启动动画**，失败只 `console.warn('Preview runtime 初始化失败（本地持久化不可用，图表不受影响）')`；
4. **路由判定**：`useHash()`（`src/App.tsx:39-47`）监听 `hashchange`；`#legacy` → 懒加载 `remote/.../src/app/page.tsx`；`#audit` → 懒加载 `src/audit/AuditBoard.tsx`；否则渲染 Vela 工作区（`VelaTerminal` + `IndicatorPickerHost` + `MarketControlsHost`，确认引擎面板按需）；每个 `Suspense` 都有中文占位文案；
5. **快捷键**：`src/App.tsx:54-60` 全局 `keydown`，`Shift + C` 开合确认引擎；若事件目标在 `input,textarea,select,[contenteditable="true"]` 内则不拦截（避免影响 Vela 自身快捷键与输入框）；
6. **Vela 工作区装配**（`src/vela/VelaTerminal.tsx`）：
   - **构造前一次性注册（顺序有意义）**：`registerLocale(zhHans)` → `registerIndicatorPicker()` → `registerMarketControls()` → `registerSignalPanel()` → `registerAnnotLayers()`。注释说明：渲染器在构造时按注册表实例化图层，因此标注图层必须先于 `new VelaWorkspace`；
   - `useEffect` 内先装 `installVelaHitFix()`、`installStackGuard(host)`，再 `new VelaWorkspace(host, {...})`；
   - 构造参数：`symbol='okx:BTC-USDT-SWAP'`、`timeframe='5'`、`live:true`、`theme:'dark'`、`locale:'zh-Hans'`、`timezone:'Etc/UTC'`、`providers:{okx:()=>new OKXProvider()}`、`timeframes:[...OKX_TIMEFRAMES]`、`volume:true`、`drawingToolbar:true`、`upColor:'#2ebd85'`、`downColor:'#f6465d'`、`glow:0.25`、`persist:'pulsedesk-vela-workspace'`、`autofocus:true`、`topbar.left=['symbol','pd-timeframes','pd-style','indicators','actions','undo-redo']`、`topbar.right=['actions','alerts','panels','screenshot']`；
   - 实例挂到 `window.__velaWs`（注释：调试/测试入口，生产无副作用；确认引擎面板靠它读当前市场）；
   - 随后安装 `enhanceDrawingMenus(ws.root)`、`installQuantHover(ws.root)`、`installToolbarHover(ws.root)`、`syncTopbarLabels(ws.root, ws)`；
   - **符号兜底**：`setTimeout(1600ms)` 后若持久化的符号 base 不在 `['BTC','ETH','SOL']`（例如已下架），调用 `ws.chart.setMarket({symbol:'okx:BTC-USDT-SWAP'})`；
   - 构造失败只 `console.error('VelaWorkspace 初始化失败', e)`。
7. **浏览器运行时初始化**（`src/runtime/bootstrap.ts`，异步，与 6 并行）：
   - `await initializeDatabase().catch(...)` → 浏览器分支动态 `import(asset('pglite.js'))` 并并行 `loadWasm('pglite.wasm')`、`loadWasm('initdb.wasm')`、`fetchBinary('pglite.data', …)`；
   - 资源校验（`src/db/index.ts:10-27`）：wasm 校验魔数 `\0asm`（`0x00 0x61 0x73 0x6d`）；data 要求 `byteLength > 5_000_000` 且首字节不是 `0x3c`（`<`）——注释说明 SPA 回退会把缺失文件回成 `index.html`，必须校验内容而不是状态码；本地不合格则回退 jsDelivr 同版本（0.5.14），两处都失败才抛错；
   - `PGlite.create('memory://pulsedesk-original', {pgliteWasmModule, initdbWasmModule, fsBundle, relaxedDurability:true})` → `client.exec(migrations)` → `drizzle(client,{schema})`；
   - `Promise.all` 动态 import 5 个 handler（注释强调：用**活动**路由而不是存档快照，否则 `src/app/api` 的修复只对 Next 生效）；
   - 用 `routes` 表包装 `window.fetch`：跨源直接放行；`/api/okx/` 走 `fetchStatsProxy`；命中表内路径则本地执行 handler；方法不匹配返回 405 + `Allow` 头；handler 抛错返回 500。
8. **标注运行器启动**（`src/vela/registerSignalPanel.tsx` + `src/vela/signals/runtime.ts`）：
   - `registerSidePanel({id:'pulsedesk-signals', width:320, resizable:true, minWidth:300, maxWidth:440, order:5})`，`mount` 时 `createRoot(body).render(<SignalPanel …/>)`，`destroy` 用 `queueMicrotask(() => root.unmount())`；
   - **另有独立** `registerWidgetAttachment({id:'pulsedesk-signal-runtime'})`：注释与旧文档一致——运行器属于工作区而非面板，**收起侧栏不停止标注计算**；
   - attachment `mount` 里 `mountSignalRuntime(ctx, store)`，并在 300ms 后判断 `store.firstVisit && window.innerWidth >= 720` 时自动 `ctx.togglePanel(SIGNAL_PANEL_ID, true)` 一次，然后 `store.persist()`；
   - `mountSignalRuntime` 立刻 `attach()` + `schedule(true)`，并注册：`store.subscribe`（偏好/焦点变化）、`barsHub.subscribe`（仅当 key === 当前 marketKey）、`subscribeFlow`（仅当 instId/period 匹配）、`setInterval(1500ms)` 心跳（注释：兼顾延迟构造的图表与用户绘图障碍物更新）、Vela 图表事件 `load:start` / `load:end` / `market:changed`。

### 4.4 运行期（稳态循环）

`src/vela/signals/runtime.ts:145-197` 的 `run()` 是核心循环：

1. `attach()` 拿到 chart；无 chart 或无 symbol 直接返回；
2. 偏好总开关关闭 → `stopFlow()` + `paint()`（状态置 `paused`）后返回；
3. 从 `barsHub.get(symbol, timeframe)` 取 K 线镜像；为空且距上次输入 >20s → 提示"等待行情数据，请检查 OKX 网络连接。"；
4. 计算 `previous`（最新一根若已收盘则用它，否则用倒数第二根）；
5. 用 `signalRecomputeKey({marketKey,length,firstTs,lastTs,prevClose,prevVolume,closedOpen,closedHigh,closedLow,barMs,now,preview,forming})` 生成指纹；**键与上次不同或 `needsScan` 为真才重算**；
6. 重算：把 `OHLCV` 映射成 `Candle`，`analyzeSignals(candles, barMs, preferences, getFlow(symbol, period))`；异常时回落到空分析并置 `loadError='标注计算暂不可用；图表与手动画线不受影响。'` + `console.warn('[信号标注]', e)`；
7. `requestFlow()`：仅当 `flowRequested(preferences)`（总开关开 + 至少一个 `flow:true` 的类型被选中）且 `flowPeriodOf(timeframe)` 非空；30s 内不重复请求；首次按 `min(14, ceil(lookback/100)+1)` 页回填 rubik，已回填（`rubikComplete`）后只取 1 页；`bootstrapBars` 为 5m→12 根 / 其他→6 根，`bootstrapPages:300`；带 `AbortController.signal`；
8. `paint()`：`projectSignals(analysis, preferences, focusId)` → 附加用户绘图障碍物 → `write(payload)`（JSON 指纹去重后 `rendererPort.setNativeData` 同时写给 `ANNOT_UNDER` 与 `ANNOT_OVER`，并把 events/levels/zones/market/revision 计数写到 `ctx.host.dataset.*` 供诊断与测试）→ `store.updateRuntime({...})`；
9. **节流**：`THROTTLE_MS = 300`，前缘触发（空闲后首次输入立即跑），突发输入至多每 300ms 一次并尾缘补跑。注释记录了旧实现是固定 1200ms 防抖、端到端延时 1.2–2.7s。

### 4.5 退出与资源释放

| 触发 | 释放动作 | 位置 |
| --- | --- | --- |
| Vela 组件卸载 | `clearTimeout(symbolGuard)`、卸载 4 个外壳增强、`unfix()`、`unguard()`、`ws.destroy()`、`wsRef=null` | `src/vela/VelaTerminal.tsx:99-113` |
| 信号运行器卸载 | `alive=false`、清 timer 与 1500ms 心跳、退订偏好/barsHub/flow/chart 事件、`stopFlow()`（abort + `releaseTape`）、写空 payload、`store.updateRuntime(EMPTY_RUNTIME)` | `src/vela/signals/runtime.ts:224-232` |
| 侧栏面板销毁 | `queueMicrotask(() => root.unmount())` | `src/vela/registerSignalPanel.tsx:30` |
| 切换币种/周期 | `stopFlow()`：`flowEpoch++`、`flowController.abort()`、`releaseTape(旧合约)`（关 WS、清 ping/retry/rollover 定时器、从 `tapes` Map 删除） | `runtime.ts:77-85`、`src/quant/flow.ts:173-187` |
| 页面隐藏 | `pagehide` 且 `!event.persisted` 时 `client.close()` 关闭 PGlite（`{once:true}`） | `src/db/index.ts:159-161` |
| WebSocket 断开 | provider：2s 后重连；tape：2s 后重连并置 `needsRepair=true`（下次同步做修复性回补）；`Socket` 类另有 6s 无数据守卫与 25s ping | `okxProvider.ts:196-200`、`flow.ts:157-168`、`okx-ws.ts:53-58` |

> ⚠️ 内存库语义【代码已确认】：PGlite 实例是 `memory://pulsedesk-original`，**刷新或关页即清空**，与服务端 PostgreSQL 互不同步。

---

## 5. 主要功能的端到端实现

本章覆盖 7 条主要链路，不止一个请求。

### 5.1 链路 A：图表 K 线加载与实时更新

**触发**：用户打开 `/`、切换币种或周期。

| 步骤 | 文件 / 函数 | 逻辑 |
| --- | --- | --- |
| 1 | `src/vela/okxProvider.ts` `OKXProvider.getBarsProgressive()` | Vela 调用 provider；`toOkxBar(timeframe)` 把 Vela 周期（`'5'`/`'15'`/`'D'`/`'W'`…）映射为 OKX 代号（`5m`/`15m`/`1Dutc`/`1Wutc`/`1Mutc`/`{n}H`）；`depthFor()` 决定回看深度：≤5m→6000、≤15m→4000、≤60m→2500、更深→1500，并夹在 `[max(range.limit,100), 12000]` |
| 2 | 同上 | 首页 `GET /api/v5/market/candles?limit=300`（有 `range.to` 时带 `after`）；`parseRow()` 校验有限性与 `h ≥ max(o,c) && l ≤ min(o,c)`，成交量走 `quoteVolumeFromRow()` |
| 3 | 同上 `emit()` | `merge(keyOf(ticker,timeframe), out)` 写入 `barsHub` 镜像（按 ts 去重、排序、`slice(-12_000)`）并广播给订阅者；同时 `onBatch(out)` 让图表先出图 |
| 4 | 同上 while 循环 | 分页 `GET /api/v5/market/history-candles?after={oldest}&limit=100`，守卫 `guard++ < 160`；每 5 页 `emit()` 一次并 `sleep(120ms)`；`signal.aborted` 或 `range.from` 已到则中断 |
| 5 | `okxGet()` | 429 时退避 `400×(attempt+1)` 重试至多 4 次，**第 4 次仍 429 抛错**（注释：不能把限频当成成功的空页）；非 2xx 抛 `OKX HTTP {status}`；`code !== '0'` 抛 `OKX code {code}` |
| 6 | `OKXProvider.subscribe()` | 连 `wss://ws.okx.com/ws/v5/business`，订阅 `candle{bar}` 频道；`onopen` 后每 20s 发 `'ping'`；收到数据 `parseRow` → `onBar(b)`（交给 Vela）+ `merge()`（更新镜像）；`onclose` 后 2s 重连；返回的取消函数置 `stopped=true`、清定时器、关 WS |
| 7 | `getSymbolInfo()` | 返回 `mintick`（BTC 0.1 / ETH 0.01 / SOL 0.01）、`pricescale = round(1/tick)`、`timezone:'Etc/UTC'`。注释说明：缺 `mintick` 时 Vela 价格轴会退回缩放区间公式，导致新加载的 SOL 图只显示一位小数 |
| 8 | `resolveSymbolIcon()` | 三个币种的品牌图标是**内联 SVG data URL**（`BRAND_MARKS`：BTC `#F7931A`、ETH `#627EEA`、SOL `#9945FF`），不依赖 CDN |

**数据/状态变化**：`barsHub` 的 `store: Map<'ticker|tf', OHLCV[]>` 每 key 上限 12,000 根；每次 `merge` 触发 `listeners`（信号运行器据此重算）。

**异常与边界**：限频→退避重试后抛错（图表显示历史数据不再变深）；WS 断开→2s 重连；无数据→`load:end` 的 `m.bars` 为 0 时运行器置 `loadError='行情暂未加载成功，请检查网络或切换市场重试。'`（`runtime.ts:139`）。

### 5.2 链路 B：M/W 信号标注（当前主线，从 K 线到画布与侧栏）

**触发**：`barsHub` 变更 / flow 快照变更 / 偏好变更 / 1.5s 心跳。

```text
barsHub(OKXProvider) ─┐
flow 快照(quant/flow) ─┼─▶ runtime.ts run() ─▶ signalRecomputeKey 变了? ─▶ analyzeSignals()
偏好(store)          ─┘                                                     │
                                                                            ▼
   画布 ◀── annotLayer(pd-annot-under/over) ◀── setNativeData ◀── projectSignals()
   侧栏 ◀── SignalPanel/MwStoryDetails ◀── store.updateRuntime ◀──────────────┘
```

`analyzeSignals(candles, barMs, preferences, flow, now)`（`src/vela/signals/analyze.ts:30-243`）逐步：

1. **入参校验**：`barMs > 0` 且 `now` 有限，否则返回空分析；
2. **K 线清洗**：逐根要求 `[ts,o,h,l,c,v]` 全有限、`ts <= now`、`v >= 0`、`o>0`、`c>0`、`h ≥ max(o,c)`、`l ≤ min(o,c)`、`l>0`；按 ts 排序；用 `Map` 按 ts 去重；
3. **只留已收盘**：`closed = chronological.filter(c => c.ts + barMs <= now)`；
4. **连续段截断**：从最后一根向前，只要相邻间隔 === `barMs` 就继续，得到 `contiguousStart`；注释说明加密市场连续交易，历史缺口不能被当成普通的一根停顿（否则摆动年龄、突破、CVD 都会错）；`cs = closed.slice(contiguousStart).slice(-max(1200, lookback+900))`；
5. **不足 30 根直接返回**（并带 `gapTruncated` 标记）；
6. `buildContext(cs, flow)` 建上下文（ATR/delta/real/oi/vols/EMA20/EMA50/volMa/index/flowCoverage）；
7. `scanAnnotationPatterns(ctx)` 出**纯价格几何**的双测形态；
8. `buildMwStories({patterns, ctx, flow, barMs, livePrice: preview ? forming?.c : undefined})` → `groupMwPatterns` 归并 → 每组 `analyzeMwStory` 出一条 `SignalItem`（含六段 `sections`、`timeline`、`story`）；只保留 `ts >= cutoff` 或 `origin.confirmedAt > cutoff` 的记录；
9. **背景项 1：支撑/阻力**（`keyLevels`，默认关）：`findSwingLevels(ctx,{maxAge:288})` 取未破位、距现价 ≤ `max(3×ATR, 1.2%价)` 的摆动位，按距离排序并去掉同侧近乎同价（间距 < `max(0.6×ATR, 0.2%价)`）的重复，最多 6 条；每条若"最近一次触碰"那根具备完整真实逐笔覆盖（`takerObservation`），把**单根**成交观察追加到同一条记录的 `detail` 与 `event`（文案如「冲不上去」/「买方占优」，并明确写"这是单根 taker 成交观察，不是订单簿 OFI"）；
10. **背景项 2：成交力度**（`deltaImpulse`，默认关）：在回看窗口内逐根判定三类事件——`absorption`（真实覆盖 + 量比 ≥2 + |Δ比| ≥0.15 + 收盘位置与方向不匹配）、`impulse`（|Δ比| ≥0.25 且量比 ≥1.5，或真实覆盖下 |Δ比| ≥0.12 且量比 ≥2.5）、`climax`（真实覆盖 + 量比 ≥4 + |Δ比| <0.12，即爆量但买卖均衡）；同向 3 根内去重；按 `rank =（真实?10:0）+ score` 排序，**画布最多 4 个已收盘标签**（间隔 ≥6 根），未收盘预览永远画；未被选中的仍留在侧栏列表（`paint:false`）；
11. **背景项 3：其他突破回踩**（`retest`，默认关）：对 `cs[lv.breakIdx].ts >= cutoff` 的已破位摆动位（最多 24 条），逐根用 `readBreakout(ctx, lv, b, q)` 重判，遇到 `pullback.failed` 停止，首次 `pullback.held` 时产出一条记录 + 回踩区 `zone`；只有突破 K 与回踩确认 K **两根都有完整真实覆盖且方向相容**（`firstFlow*dir >= 0.08 && holdFlow*dir >= -0.12`）才把 `source` 标为 `real`，否则为 `price`；
12. **返回**：`items` 按 id 去重后按 ts 倒序；`covered` = 回看窗口内 `ctx.real` 命中数；`bars` = 实际纳入分析的已收盘根数；`gapTruncated` = `contiguousStart>0 && inScope.length < lookback`。

`projectSignals(analysis, preferences, focusId)`（`analyze.ts:246-304`）是**纯展示投影**：

- 资格过滤：`source ∈ {price, real}` 或用户开启 `allowApprox`；且 `confirmed` 或开启 `preview`；
- 计数：按类型累加；`story.active && zone` 计入 `keyLevelScenario`；`story.smc.hits >= 2` 计入 `smartMoney`；
- 可见列表：按 `selected[type]` 过滤，`story` 优先、ts 倒序，截断 160 条；
- 画布选择：`selectMwStories(visible)` 最多 3 条（方向去重、同侧近价去重）；若用户点选了历史记录（`focusId`），该条**替换一席**并挤掉价位相近者，`rank` 提升为 `focus`、`priority=100`；
- 让位规则：`keyLevels` 背景线若与某个被画出的 M/W 的关键位或颈线价差 ≤ `annotationTolerance`，则不重复绘制；
- 区带限额：`directions` 集合最多 2 个方向；
- 近似标记：`source ∈ {mixed, approx}` 时给 `event.text` / `zone.text` 前缀 `≈ `；`labels` 关闭时文字置空；
- 事件去重：同 `ts|text` 只保留 `priority` 最高的一条。

**六段详情**（`mwStory.ts` 的 `sections`，`MwStoryDetails.tsx` 渲染为可折叠 `<details>`，默认展开第 1/2/5 段）：① 当前结论 ② 关键区域力量 ③ 真实成交证据 ④ 诱多/诱空 ⑤ 突破 → 回踩/反抽 ⑥ 参考位与失效；另有事件时间线（最多列最近 12 项，点击 `onTime(barTs)` 定位图表）与可选 SMC 附加段。

### 5.3 链路 C：单条 M/W 记录是如何得出结论的（`analyzeMwStory`）

这是本项目最核心的业务判定，`src/vela/signals/mwStory.ts:81-280`：

1. **证据**：`readMwEvidence(ctx, p, barMs, flow)`（`evidence.ts:68-110`）把证据**锚定在二次测试/确认时点**，产出：
   - `test` / `confirmation`：两根的 `TakerObservation`（buy/sell/total/delta/ratio/src/coverage/volRatio），**无完整真实覆盖则为 `null`**（`takerObservation` 要求 `ctx.real[i]===1` 且 `buy+sell>0`；注释：绝不用 `ctx.delta` 里的 OHLC 近似冒充）；
   - `firstLeg` / `secondLeg`：`legFlow()` 要求**每根连续真实覆盖且时间戳连续**才 `complete`，否则 `ratio = null`；
   - `cvdRatio`：`realCvdBetween(first, second)`，区间不完整则 `null`；`cvdDivergence = cvdRatio*dir >= 0.04`；
   - `secondRatio`（第二腿/第一腿单位成交量）、`testVolume`/`confirmVolume`（相对前 20 根均量，不含当前根）、`wickRatio`（拒绝影线占比）、`sweepAtr`（扫位深度）、`closedInside`（确认收盘是否回到位内）、`absorbed`（量比 ≥2 + 真实 Δ 反向 ≥0.15 + 收盘位置未跟随）；
   - `stance`（五档文案：反转侧占优 / 推进侧未站稳 / 推进侧占优 / 方向分歧 / 接近中性；覆盖不全时写"仅测试K有真实覆盖"等）；
   - `strength`：**规则计数**（`positive` / `negative` / `missing` 三个字符串数组，`score = positive.length - negative.length`，`label` 为 较强(≥3)/一般(≥1)/不足/分歧）。注释明确：不是概率。
2. **两条线各跑一次生命周期**：`evaluateLine(ctx, barMs, p.level, top?1:-1, p.idx, 'level', flow)` 与 `evaluateLine(…, p.neck, rev, p.idx, 'neck', flow)`（`scenario.ts:23-89`）：
   - 单向遍历已收盘序列；`beyond(i)` = 收盘越位 > `BREAK_ATR(0.2) × ATR(i)`；`inside(i)` = 收盘回到位内超过同阈值；
   - 时间戳不连续（缺口）→ `pending` 清零，已有生命周期置 `expired`；
   - 首根越位记 `crossing` 事件并置 `pending`；**连续第二根**越位才 `make(pending, i)` → 状态 `broken` 并记 `accepted` 事件；
   - 观察带 `lo/hi` 在确认时**固定**：`tol = max(annotationTolerance(price, ATR(anchor)), 0.15×ATR(anchor))`；
   - 首次高低范围与带相交 → `reachedIdx` + `touch` 事件（**触带 ≠ 确认**）；
   - 之后收盘仍守在突破侧 → `retest` + `held` 事件（`retestConfirmedAt`）；继续远离到 `(hi-lo)/2 + 0.4×ATR` 以上 → `continued`；
   - 收盘回到位内 → `failed` + 事件；等待回踩超过 `RETEST_WINDOW(48)` 根，或触带后超过 `RECLAIM_WINDOW(12)` 根 → `expired`；
   - `flowComplete` / `flowAligned`（两根确认 K 合计真实 Δ × dir ≥ 0.04）只在 `acceptedAt >= 0` 时用 `legFlow(i, acceptedAt)` 计算。
3. **选主线**：`validReads.sort((x,y) => y.lastEventIdx - x.lastEventIdx || (x.kind==='neck' ? -1 : 1))[0]` —— 按**最近状态事件**选当前观察对象；注释说明晚发生的反向失效不能被旧颈线状态遮住。
4. **失效判定**：`invalidated` = 外侧关键位已被接受突破（`acceptedAt>=0`）且未失败，且状态属 `broken/touch/retest/continued`，或已 `expired` 但当前收盘仍在位外。
5. **阶段机**（`phase` / `label` / `bias` / `priority`）：
   | 条件 | phase | 文案 | bias | priority |
   | --- | --- | --- | --- | --- |
   | 无 line | `no-break` | 二次测试·待突破（力量分歧/买向候选/卖向候选/证据不足，按 `secondRatio`、`strength` 细分） | 依证据 | 1 |
   | `last - p.idx > 96` 且无 line | `expired` | 历史二次测试 | null | −1 |
   | `line.state==='pending'` | `break-pending` | 上破/下破待第二根 | null | 3 |
   | `expired` | `expired` | 观察窗结束 | null | −1 |
   | `failed`（neck） | `break-failed` | 上破失败·卖向候选 / 下破失败·买向候选 | 反向 | 12 根内 3，否则 −1 |
   | `failed`（level） | `sweep-level` | 用 `trap.label`（诱多候选/假突破（仅价格）等） | 反转向 | 同上 |
   | 量比 <1.2× 或（≥1.2× 但成交未同向） | `break-weak` | 缩量上破/下破·观望 或 突破证据不足 | null | 2 |
   | 支持（≥1.5×，或 ≥1.2× 且 `flowAligned`）且未触带 | `break-wait` | 放量破位/破位·等回踩（反抽） | 突破向 | 4 |
   | 触带且 `held` 且质量达标（回撤 ≤0.618 且回踩量 ≤0.9× 突破量） | `break-held` | 回踩守住·买向 / 反抽受阻·卖向 | 突破向 | 5 |
   | 触带但质量不足 | `break-retest` | 回踩中·待确认 | null | 3 |
   | 延伸位 `2×neck − level` 在颈线确认**之后的已收盘 K** 中真实触达且未先失效 | `target-reached` | 延伸位已到·不追 | null | 0 |
6. **活跃判定**：`active = priority >= 0 && last - activityIdx <= 96`；`activityIdx` 取形态确认与 line 最后事件、陷阱、延伸位触达的最大者 —— 因此**旧形态刚发生新颈线突破时仍可跟踪**（不按形态年龄过滤）。
7. **陷阱**（`trapAt`，`mwStory.ts:60-78`）：两种形态——`failed-break`（关键位破位后收回；需 `level.flowComplete` 且收回根真实 Δ × dir ≥ 0.04 才 `supported`）与 `test-sweep`（`sweepAtr ≥ 0.05 && closedInside`；需测试/确认两根真实 Δ 满足方向条件才 `supported`）；`supported` → 文案「诱多候选/诱空候选」，否则「假突破（仅价格）/扫高收回（仅价格）」；`active = last - idx <= 12`。
8. **产出画布元素**：`event`（`M/W + label`，diamond，priority 96）、两条 `levels`（关键位 solid/rank `read`/priority 98；颈线 dotted/priority 70；非活跃时 `toTs` 收在活动点，不延伸到未来）、`zone`（`expired` 阶段不产出；`break-failed` 时 `failed:true`）、`path`（一顶→颈线→二顶→确认收盘的折线）。

### 5.4 链路 D：入场确认引擎扫描（`Shift+C` 面板）

**触发**：用户按 `Shift+C` 打开面板 → `useEngine(open)` 的 `useEffect` 发起 `GET /api/engine/scan?symbol=ALL&bar=ALL`（默认三币种 × 双周期合并样本）。

| 步骤 | 位置 | 逻辑 |
| --- | --- | --- |
| 1 | `src/app/api/engine/scan/route.ts` | 仅 7 行：`export const dynamic='force-dynamic'` + 转发到 `@/api/engine` 的 `GET` |
| 2 | `src/api/engine.ts:60-69` | 解析 `symbol`(默认 BTC-USDT-SWAP)/`bar`(默认 5m)/`fresh`/`exit`(白名单 `neck,r15,r10,be,partial`，非法回退 `neck`)；缓存键 `${symbol}|${bar}|${plan}`，TTL 45s |
| 3 | `:71-72` | `symbol==='ALL'` → 三币种；`bar==='ALL'` → `['5m','15m']` |
| 4 | `:82-94` | 双层循环逐周期逐币种 `getCandles(s, tf, SCAN_BARS(tf))`（5m→8640 根 ≈30 天，15m→4320 根 ≈45 天），随后 `closedCandles(rawCandles, tf)` —— 注释：`getCandles` 也服务图表因此含形成中 K 线，确认引擎严格只用已收盘 |
| 5 | `:96-107` | **每个币种重置** `flow=undefined`、`bookImb=null`（注释：绝不把上一个币种/周期的盘口带进降级行情）；`live` 时 `fetchBookLive(s,10)` 算十档失衡 `bookImbalance`，再 `liveFlowOf(candles, bookImb, null)` 合成 `LiveFlow`（含最后一根相对前 20 根均量的 `volRatio`） |
| 6 | `:114-129` | 订单流快照：**Node 环境**调 `syncFlow(s, tf, {minTs, maxPages:4, oiPages:2})`（有界分页，注释：避免一次面板请求变成无界历史下载）；**浏览器环境**改为 `getFlow(s, tf)` 复用标注运行器已维护的快照，不另起第二条 tape |
| 7 | `src/quant/scan.ts:runScan` | `buildContext(cs, flow)` → 对 `confirm` 与 `touch` 两种 `entryMode` 各跑一次 `scanDoubles(cs, {...DEFAULT_PARAMS, entryMode, trendBlock:50})` → 每个信号 `candidateFrom(...)` |
| 8 | `candidateFrom` | `collectEvidence(ctx, sig, live?)`（仅当 `sig.idx >= ctx.n-1` 才传实时盘口）→ `scoreEvidence` → `pivotOf` / `readSecondTest` → `simulateWithPlan` 算当前方案结果，并把**五种出场方案全部算好**放进 `exits`（面板切换方案是纯本地计算，无需重请求） |
| 9 | `wire()`（`src/api/engine.ts:22-58`） | 出网裁剪：省略 `parts`（可由 `evidence × weight × gain` 还原）与完整 `read`；**保留** `trap`/`trapScore`/`flowSource`/`headline`（注释：否则 API 会把一个真实 taker 候选变成匿名分数） |
| 10 | `:135-171` | 两组各按 ts 排序、各截断最近 `CAP=320` 条；响应附 `factors`(19 项 key/label/short/hint/group/weight/liveOnly)、`model`、`config`、`exitPlans`、`flow`、`barMs`/`maxHold`（取最后一个周期） |
| 11 | `src/components/confirm/useEngine.ts` | 前端编排：`withPlan()` 切换出场方案；`activePool` 随 `cfg.entryMode` 变化（注释记录旧 bug：校准/归因/walk-forward 曾写死 `confirmPool`）；`stats` 一次性算出 `now`/`edge`/`optimize`/`ci`(Wilson)/`all`(基线)/`exitCompare`/`walkForward`/`calib`(8 桶)/`sweep`(0.42–0.82 共 21 点)/`attribution`/`killers`/`grades`/`bySymbol`/`equityGated`/`equityRaw`；`current` 取最近一个候选并按**该行自己的** `bar` 换算 `barMs`/`maxHold`（注释记录旧 bug：`bar=ALL` 时用响应级 15m 参数会把 5m 信号年龄低估 3 倍） |
| 12 | `ConfirmEnginePanel.tsx` | 14 个 Section（由 `title=` 属性核实）：跟随页面 / 重新扫描（绕过缓存）/ 配置寻优 / A/B 对照 / 样本外验证 Walk-Forward / 出场方案对照 / 概率校准 / 门槛扫描 / 累计净 R / 分币种表现 / 因子看板 / 被门槛挡掉的主因 / 逐单明细与归因 |
| 13 | `applyConfig` | `setConfig` 写 localStorage + cookie，并在 900ms 后查找 `header button[title='重新扫描最新行情与信号']` 派发 click —— 让 `#legacy` 页面自己的回测重跑，**不改远程组件代码** |

**`readActiveMarket()`**（`useEngine.ts:62-91`）：优先读 `window.__velaWs.chart.market`（校验 ticker 属三币种，`timeframe >= 15` 归为 `15m`），失败再退回旧版 header DOM 查询（按 Tailwind class 匹配按钮）。注释记录旧 bug：主界面没有旧 header，此前永远返回默认值。

### 5.5 链路 E：回测与落库（`GET /api/backtest`）

1. **参数**：`symbol`(默认 BTC-USDT-SWAP，`ALL`=三币种)、`bar`(5m/15m)、`flow=on`、`fresh=1`、`threshold`/`mode`/`replaceConf`；
2. **配置来源优先级**：query > cookie `pulsedesk.confirm-engine`（`configFromCookie` 解析 `{t,m,r}`，非法内容整体忽略）> `DEFAULT_CONFIG`；`threshold` 经 `clampThreshold` 夹到 0.42–0.82 且按 0.005 取整（`src/app/api/backtest/route.ts:56-68`）。注释记录旧 bug：此前服务端只能拿到 `DEFAULT_CONFIG`，用户调参对回测完全无效；
3. **缓存**：键 `${symbol}|${bar}|${flow}|${threshold}|${entryMode}|${replaceConfFilter}`，TTL 180s，`fresh=1` 绕过。注释：配置必须进缓存键，否则不同门槛共用同一份结果；
4. **取数**：`btBars(bar)` = 15m→4320 / 其他→8640；**逐币种串行** `getCandles`（注释：避免触发 OKX 历史 K 线限频导致缺口），每个币种立即 `closedCandles`（注释：让响应的 bars/from/to 描述的就是实际被交易的样本）；
5. **模拟**：`simulate(candles, symbol, bar, opts)`（覆盖层，`src/lib/engine.ts:73-148`）：
   - 再次 `closedCandles`（HTTP 边界与函数内各一次，双重保险）；
   - `paramsFor(mode)` 把 `trendBlock` 设为 50（关闭一刀切逆势屏蔽，改由连续 `trendExhaust` 证据 + 概率门槛决定）、`entryMode` 映射为 `limit`(touch)/`confirm`；
   - `scanDoubles` → 每形态 `candidateFrom(ctx, s, mode, maxHold)` → `annotate()` 把概率写进既有 `tags`/`note`（如「确认 72% · A级」「等确认K」）；
   - 过滤：`opts.flowFilter && !replaceConf && s.conf < CONF_MIN(60)` → 丢弃；无 `outcome` → 丢弃；
   - `proba < threshold`（`flow=on` 时门槛为 `min(0.9, threshold+0.05)`）或未成交 → 记 `status:'skipped'` 并附 `rejectReason`（`confirm` 未过门槛 / `unfilled` 未成交；无下一根 K 线的形态在此之前已被丢弃），保留"检出但未执行"的可观测性；
   - 通过者记 `status:'done'` + 实际入场/出场/R/持仓根数；`exitReason` 把 `be`(保本) 与 `gap`(跳空) 归入 `time` 以兼容原始 `summarize` 的 tp/sl/time 契约，真实原因另存 `exitWhy`；
6. **汇总**：`summarize(recs, {symbol,bar,from,to,bars,scope,opts,symbols})`（原始引擎）产出 `overall`/`bySide`/`byPattern`/`bySymbol`/`byHourDay`/`rDist`/`equity`；再回显 `engine:{threshold,entryMode,replaceConfFilter}` 便于核对口径；
7. **落库**（try/catch，失败只 `console.warn("persist failed:", e)`，不影响返回）：
   - `persist(recs, bar)`：只写 `exitTs != null || status==='skipped'` 的记录，**300 条分块**批量 `insert … on conflict (symbol,bar,bar_ts,pattern,side) do update set …`，状态映射 `skipped` / `won`(r>0) / `lost`，`origin='backtest'`；
   - 批次写 `backtest_runs`（`onConflictDoNothing`），id 为 `${symbol}_${bar}_${Date.now()}`；
8. **写缓存并返回** `BacktestResult`。

### 5.6 链路 F：实时信号写入（`POST /api/signals`）

`src/app/api/signals/route.ts:28-66`：`await initializeDatabase()` → 解析 JSON body → `id`/`symbol` 缺失返回 400 `{"error":"missing fields"}` → 单条 `insert … on conflict (id) do update set status, entry_price=coalesce(excluded.entry_price, signals.entry_price), exit_price, exit_ts, r_multiple, pnl_pct, holding_bars, exit_reason` → 200 `{"ok":true}`；异常 500 `{"ok":false}` + `console.warn("signal persist failed:", e)`。`origin` 硬编码 `'live'`，`bar` 默认 `'5m'`，`status` 默认 `'pending'`。

调用方是原版页面（`remote/.../src/app/page.tsx:104` 的 `fetch("/api/signals", …)`）。

### 5.7 链路 G：OKX rubik 统计代理与浏览器例外通道

1. **服务端**（`src/app/api/okx/[...path]/route.ts`，45 行，全文已读）：
   - 白名单路径仅 2 条：`api/v5/rubik/stat/taker-volume-contract`、`api/v5/rubik/stat/contracts/open-interest-history`；其余返回 404 `{"code":"404","msg":"not allowed","data":[]}`；
   - 白名单参数仅 6 个：`instId,period,unit,end,begin,limit`，且值必须匹配 `^[A-Za-z0-9-]{1,40}$`；
   - 缓存 15s、上限 300 条、FIFO 淘汰最旧；上游超时 6s（`AbortController`）；上游 HTTP 错误透传状态与原文；网络异常 502 `{"code":"502","msg":"upstream unavailable","data":[]}`；
   - 【本次运行已验证】白名单外路径返回 404 not allowed；白名单内 `taker-volume-contract?instId=BTC-USDT-SWAP&period=5m&limit=2` 返回 `{"code":"0","data":[["1793881500000","6020.83","3091.58"],…]}` 真实数据。
2. **浏览器例外**（`src/runtime/statsProxy.ts`，14 行，全文已读）：`bootstrap.ts` 把 `/api/okx/` 前缀的请求交给它而**不是**本地 handler；
   - 请求已 abort → 直接抛 `signal.reason`（或 `DOMException('Request aborted','AbortError')`）；
   - 响应 `content-type` 含 `application/json` → 原样返回（**JSON 错误也透传**）；
   - 否则（Vite SPA 回退把缺失路径回成 HTML）→ 503 `{"code":"503","msg":"OKX statistics require the server-side proxy; live trades remain available","data":[]}`；
   - catch 中：若是 abort 则**原样重抛**，否则 502 `{"code":"502","msg":"Statistics proxy unavailable; no browser upstream fallback","data":[]}`；
   - 设计意图（注释 + `docs/OPTIMIZATION.md` 第 3 节第 10 条）：rubik 无 CORS，绝不在浏览器里直连上游；快速切币时被中止的请求不能被误当成上游故障。
3. **浏览器基址选择**（`src/quant/flow.ts:116-128` `rubikBase()`）：Node 环境返回 `https://www.okx.com`；浏览器固定使用同源白名单代理 `${window.location.origin}/api/okx`（旧版 `localStorage['pulsedesk.okx-proxy']` 覆盖已移除）（注释：没有代理时浏览器只有约 8 根 tape 覆盖）。

---

## 6. 核心模块源码级说明

> 本章覆盖全部核心模块（14 组），不只挑两三个。每节给出职责、关键符号、算法/分支、上下游、可从代码确认的约束。无法从代码确认的设计动机一律不代作者编造。

### 6.1 原始几何引擎 `remote/setup-mcp-project-locally/src/lib/engine.ts`（914 行，存档，禁止修改）

**职责**：双顶/双底的**几何**识别与原始回测/统计。被 `src/lib/engine.ts`、`src/quant/scan.ts`、`src/quant/context.ts`、`src/vela/signals/patterns.ts` 直接 import。

**常量**（`:21-27`）：`FEE_RATE=0.0005`（OKX 永续 taker 0.05%/边）、`SLIP_RATE=0.0001`（0.01%/边）、`CONF_MIN=60`、`MAX_HOLD_5M=96`（8 小时）、`MAX_HOLD_15M=48`（12 小时）、`RISK_USD=100`、`MAX_COST_RATIO=0.3`。

**`DoubleParams` / `DEFAULT_PARAMS`**（`:29-72`）：`pivotLeft 8` / `pivotRight 5` / `lookback 288` / `minGap 8` / `minHeightAtr 2` / `priorMoveAtr 1.5` / `tolAtr 0.35` / `tolPct 0.0004` / `sweepAtr 0.5` / `closeBufAtr 0.05` / `stopAtr 0.75` / `targetFrac 1` / `minRR 1.2` / `maxRR 4` / `enableBreak false` / `breakWithin 24` / `entryMode 'limit'` / `limitOffsetAtr 0.1` / `trendBlock 1`。注释声明：默认方案是"BTC/ETH/SOL × 5m/15m 历史数据训练段选择，样本外单独检验"【旧文档描述，本次未复核其过程】。

**`PATTERN_META`**（`:74-104`）四种形态：`db_reject`（W双底·二次测试，short `W`）、`dt_reject`（M双顶·二次测试，short `M`）、`db_break`（W双底·颈线突破，short `W↑`）、`dt_break`（M双顶·颈线跌破）；每项含 `label`/`short`/`hint`/`family:'double'`。

**关键函数**：

| 符号 | 行 | 说明 |
| --- | --- | --- |
| `atrSeries(cs, p=14)` | 105 | ATR 序列 |
| `atrAt(cs,i,p=14)` | 123 | 单点 ATR |
| `approxDeltaAt(cs,i)` / `approxDeltaSeries(cs)` | 136 / 143 | **K 线近似** delta（无真实逐笔时的兜底；界面必须标 `≈`） |
| `scanSide(w,dw,atr,p,top)` | 182 | 单侧状态机（内部函数，约 370 行）：维护 `active: Lvl[]`（已确认的第一极值）与 `all`；含 `volAround`（三根均量）、`legRatio`（区间 Δ/量）、`avgVolBefore`（前 20 根均量）、`emaOf(20/50)`、`trendOk(i)`（`p.trendBlock >= 50` 时恒真，否则要求 `(EMA20-EMA50)/ATR >= -trendBlock`）、`costOk(entry,risk)`（往返成本/风险 ≤ `MAX_COST_RATIO`）、`rejectNow(c,level,a)`（收盘 ≥ level+`closeBufAtr`×ATR 且收盘位置 ≥0.5 且（阳线或下影 ≥35%）） |
| `scanDoubles(cs,p)` | 555 | 对 `sgn=1`(底) 与 `sgn=-1`(顶) 各跑一次 `scanSide`，顶部通过**镜像价格轴**（`{o:-o,h:-l,l:-h,c:-c}`）复用同一套规则；产出 `signals`（含 `idx`、`geo.pts/path/neck`、`fill:'limit'|'close'`、`conf=confl=strength`）与 `levels`（过滤掉 `expired` 与"已破但未被二次测试"的）；`cs.length < 30` 直接返回空 |
| `computeLevels(cs,p,keepPerSide=8)` | 621 | 图表用：每侧最多 8 条未破位 + 4 条已破且已测试 |
| `detectAt(cs,i,_of?,p)` | 641 | 原始实时入口：窗口 `i-(3×lookback+300) … i`，只返回 `idx === sub.length-1` 的信号。**注意 `_of` 被 `void` 丢弃** —— 原始实现不接订单流；覆盖层 `src/lib/engine.ts` 才真正接上 |
| `simulate(cs,symbol,bar,opts,p,confMin)` | 657 | 原始回测：`flowFilter && conf < confMin` → `skipped`；`limit` 单在信号 K 内以挂单价成交（无入场滑点），`confirm` 单下一根开盘市价进场（含滑点）；跳空越过止损 → `skipped` |
| `computeStats(recsIn)` | 752 | 单组统计 |
| `summarize(recs, meta)` | 826 | 组装 `BacktestResult`（含 `R_BUCKETS` 分布、`byHourDay` 热力、`equity` 曲线） |

**可从代码确认的约束**：`enableBreak:false` 意味着默认**不交易颈线突破单**（`db_break`/`dt_break` 只在开启后产生）；`pivotRight:5` 意味着第一个极值要等右侧 5 根收盘后才被确认（因果性）；`trendBlock` 在覆盖层被强制设为 50 即关闭。

### 6.2 引擎覆盖层 `src/lib/engine.ts`（190 行，全文已读）

**设计方式**：`export * from '../../remote/.../src/lib/engine'`（第 7 行）后，用同名 `simulate` / `detectAt` **覆写**（ESM 后声明者胜出）。形态几何完全不变，只替换"是否入场"的判定为概率门槛。

| 符号 | 说明 |
| --- | --- |
| `paramsFor(mode, base?)` | `{...(base ?? DEFAULT_PARAMS), entryMode: mode==='touch' ? 'limit' : 'confirm', trendBlock: 50}`。注释解释动机：把一刀切的趋势屏蔽关掉，改由连续的 `trendExhaust` 证据 + 概率门槛决定，避免把最需要接的二次测试直接屏蔽 |
| `flowFrom(of?)` | `OFInput` → `LiveFlow{bookImb,bigBias,volRatio}`（缺项为 `null`） |
| `annotate(sig, proba, mode)` | 用 `gradeMeta` 把概率转成等级，产出 `conf`（原结构质量）、`confl`（概率百分数，**语义被改写**：原来是结构质量的副本）、`tags`（前置「确认 NN% · X级」与「等确认K/触价挂单」）、`note` |
| `EngineBacktestOptions` | `BacktestOptions` + `threshold?`/`entryMode?`/`replaceConfFilter?`；注释：服务端拿不到浏览器 localStorage，必须由调用方显式传入 |
| `simulate(cs,symbol,bar,opts,p,confMin)` | 见 [5.5 第 5 步](#55-链路-e回测与落库get-apibacktest)。签名与原始引擎同名同参，因此远程 route / 统计面板无需改动即可享受门槛 |
| `detectAt(cs,i,of?,p)` | 实时入口：`i<30 || i>=cs.length` 返回空；窗口同上；`scanDoubles(sub, paramsFor(mode,p))` 后只取最后一根；`candidateFrom(ctx,s,mode,MAX_HOLD_5M,live)`；**未过门槛不产生信号，但把最差 3 个因子打到 `console.info('[确认引擎] … 主要拖累：…')`** 供人工复盘；产出时附 `fill: mode==='touch'?'limit':'close'` |

### 6.3 量化上下文 `src/quant/context.ts`（85 行，全文已读）

`Ctx` 字段：`cs`/`n`/`atr`/`delta`/`real: Uint8Array`/`oi`/`vols`/`ema20`/`ema50`/`volMa`/`index: Map<ts,i>`/`flowCoverage`。

`buildContext(cs, flow?)` 逐根：
- `flow?.bars.get(cs[i].ts)` 命中且 `hasRealFlow(fb, cs[i].v)` → `delta[i] = fb.buy - fb.sell`、`real[i]=1`、`covered++`；否则 `delta[i] = approxDeltaAt(cs,i)`（K 线近似）且 `real[i]=0`；
- 持仓量：`oiContracts > 0` 优先，其次 `oiUsd`（注释：判断新仓进出必须用张数，USD 名义值会随价格波动；保留 USD 只为兼容 `oiContracts` 引入前的旧快照/测试数据）；无数据填 `NaN`；
- `volMa[i]` = 前 20 根（**不含当前根**）均量，不足 20 根时用可用根数，`i===0` 时用自身成交量；
- `ema20`/`ema50` 用标准 `k = 2/(period+1)` 递推，首值取 `cs[0].c`；
- `flowCoverage = covered / n`。

### 6.4 19 因子证据模型 `src/quant/model.ts`（202 行，全文已读）

`FACTORS: FactorDef[]`（`:44-130`）19 项，每项含 `key/label/short/hint/group/weight/liveOnly?`；`hint` 里写明了 +1/−1 的含义，并通过 `/api/engine/scan` 出网给面板展示。

| # | key | label | 组 | weight | liveOnly |
| --- | --- | --- | --- | --- | --- |
| 1 | `touchFlow` | 触顶订单流 | 订单流 | 0.95 | |
| 2 | `volDiverge` | 二次测试缩量 | 订单流 | 0.55 | |
| 3 | `deltaDiverge` | 主动成交差背离 | 订单流 | 0.70 | |
| 4 | `absorption` | 关键位吸收 | 订单流 | 0.80 | |
| 5 | `wickReject` | 拒绝影线 | 订单流 | 0.50 | |
| 6 | `thrustVolume` | 确认K量能 | 订单流 | 0.45 | ✓ |
| 7 | `bookImbalance` | 盘口失衡 | 订单流 | 0.50 | ✓ |
| 8 | `tapeBias` | 大单主动方向 | 订单流 | 0.40 | ✓ |
| 9 | `levelIntegrity` | 关键位完整度 | 结构 | 0.40 | |
| 10 | `patternHeight` | 形态高度 | 结构 | 0.30 | |
| 11 | `patternSpan` | 形态时间跨度 | 结构 | 0.25 | |
| 12 | `trendExhaust` | 趋势已转平 | 结构 | 0.50 | |
| 13 | `legDecel` | 推进减速 | 结构 | 0.45 | |
| 14 | `volRegime` | 波动环境 | 结构 | 0.20 | |
| 15 | `rrQuality` | 目标可达性 | 风险 | 0.60 | |
| 16 | `cvdDiverge` | CVD 极值背离 | 订单流 | 0.60 | |
| 17 | `sweepTrap` | 扫损陷阱 | 订单流 | 0.65 | |
| 18 | `testDelta` | 确认K主动方向 | 订单流 | 0.40 | |
| 19 | `oiTrap` | 持仓被套 | 订单流 | 0.30 | |

**评分公式**（`scoreEvidence`，`:162-179`）：

```text
logit  = MODEL.base + Σ_i  MODEL.gain × wᵢ × clamp(eᵢ)        base = −0.15, gain = 0.42
         （eᵢ 为 null 或非有限值 → 跳过，贡献恒为 0，covered 不增加）
shrink = min(1, covered / 4.5)                                  covered = 有数据因子的权重和
logit ← base + (logit − base) × shrink                          证据越少越向 50% 收缩
proba  = sigmoid(logit) = 1 / (1 + e^(−logit))
返回 Score{proba, logit, evidence, parts[i]=gain×wᵢ×clamp(eᵢ), covered}
```

**等级**（`GRADE_BANDS`，`:183-188`）：A ≥0.66「强确认 · 默认执行档」`#2ebd85`；B ≥0.58「有效确认 · 标准执行」`#37c8dd`；C ≥0.50「边缘确认 · 降仓或等待」`#f0b90b`；D <0.50「确认不足 · 放弃」`#f6465d`。`gradeOf(proba)` 顺序匹配，`gradeMeta(grade)` 反查。

**期望值**（`expectancy(r,p) = p×max(r,0) − (1−p)×1`）：把胜率与赔率放到同一口径。

### 6.5 扫描与出场 `src/quant/scan.ts`（538 行，全文已读）

**`collectEvidence(ctx, sig, live?)`**（`:118-234`）：`dir = side==='long' ? 1 : −1`，所有方向性因子按 `dir` 归一，因此多空共用同一套权重（注释：不额外拟合）。逐因子实现要点：

| 因子 | 实现（行号） | 关键分支 |
| --- | --- | --- |
| `volDiverge` | 135-138 | 两腿单位根成交量 `v1/v2`，`((v1−v2)/((v1+v2)/2))×1.1`；两者皆 0 → 0 |
| `deltaDiverge` | 141 | 直接取 `readSecondTest().legDeltaDiff` |
| `absorption` | 144 | `(count − breach)/2` |
| `wickReject` | 147-156 | 最深测试 K 的影线占比 `(tail−0.3)×1.8`；**`isTouch` 时不加确认 K 收盘位置项** |
| `thrustVolume`/`bookImbalance`/`tapeBias` | 159-163 | 仅当传入 `live`；`isTouch` 或对应值为 null → 记 `null` |
| `levelIntegrity` | 166-176 | 统计 `pv.first…to` 内触及次数（`|extreme−level| ≤ 0.25 ATR`，上限 5）与是否收盘击穿（>0.15 ATR）；`0.4 − (min(touches,5)−2)×0.3 + (sweepReclaim?0.35:0) − (broken?0.6:0)` |
| `patternHeight` | 179-180 | `((neck−level)×dir / ATR − 2.2)/2.5` |
| `patternSpan` | 183-184 | `1 − clamp(|ln(span/110)|/ln4,0,1)×2`（对数尺度以约 110 根为最优） |
| `trendExhaust` | 187-188 | `stretch = ((EMA20−EMA50)/ATR)×(−dir)`；`1 − clamp(|stretch+0.3|/1.9,0,1)×2` |
| `legDecel` | 191-194 | 两腿斜率比 `(slope1/slope2 − 1)×0.8` |
| `volRegime` | 197-206 | 当前 ATR 在近 500 根的分位（样本 ≤20 时取 0.5）；`1 − clamp(|pct−0.6|/0.42,0,1)×1.7` |
| `rrQuality` | 209-212 | `clamp((2.1−rr)/1.1) − clamp((costDrag−0.18)/0.5,0,1)×0.8`；`costDrag = |entry|×2×(FEE+SLIP)/risk`（无 risk 时取 9） |
| `cvdDiverge` | 215 | `read.cvdDiv` |
| `sweepTrap` | 218-220 | `accepted` → −0.8；`occurred` → `(trap.score−0.35)/0.45`；否则 0 |
| `touchFlow` | 223 | `read.touch.evidence`（注释：本策略的核心判据） |
| `testDelta` | 226 | `!isTouch && read.confirm.known` → `deltaRatio×dir×3`，否则 `null` |
| `oiTrap` | 229 | `read.oi.pct == null ? null : pct/0.006` |

**易错点（代码已处理）**：`isTouch = sig.fill === 'limit'`（`:127`）—— 触价挂单在触及关键位当根成交、不存在确认 K，因此确认 K 类证据必须记 `null`，而不是拿信号 K 充当确认 K（注释：否则会系统性压低 touch 概率，使 A/B 对照失效）。这正是审计卡 T10 的内容。

**`simulateOutcome(ctx,sig,mode,maxHold)`**（`:237-316`）：`i<30 || i>n−2` → `null`；`touch` 模式在信号 K 内以 `sig.entry` 成交（`entryTs = sig.ts`）；`confirm` 模式若下一根开盘已越过止损 → `filled:false, why:'gap'`，否则以 `next.o×(1±SLIP_RATE)` 成交；从 `limit?i:i+1` 到 `min(i+maxHold, n−1)` 逐根**先判止损再判止盈**（保守口径；`limit && j===i` 那根不判止盈）；未触发则按 `cs[endJ].c` 超时平仓；`r = pnl/risk`（`pnl = gross − fee`，`fee = (entry+exitAdj)×FEE_RATE`），`costR` 含滑点成本。

**`simulateWithPlan(ctx,sig,mode,maxHold,plan)`**（`:436-538`）：`plan==='neck'` 直接委托 `simulateOutcome`；否则按 `risk = (entry−stop)×dir` 计算 `target`（`r10`=1R、`r15`=1.5R、其他=`sig.tp`）与 `trigger`（1R 触发点）；`be`/`partial` 在触及 1R 后 `armed=true` 并把止损移到 `entry×(1+dir×FEE×2)`（成本价 + 双边手续费），`partial` 同时 `tookHalf=true, lockedR=0.5`；最终 `r = tookHalf ? 0.5 + 0.5×restR : restR`。**注释特别说明**：`why='be'` 描述的是离场机制而不是最终 R 的符号——手续费/滑点可能让保本单略微为负，若因此改判为 `sl` 会污染 tp/sl/time/be 统计（对应审计卡 T7）。

**五种出场方案**（`EXIT_PLANS`，`:427-433`）：

| id | label | hint（原文） |
| --- | --- | --- |
| `neck` | 颈线目标 | 原方案：目标看颈线（受 maxRR 封顶），超时按收盘价平仓 |
| `r15` | 固定 1.5R | 目标 = 入场 ± 1.5 倍风险，放弃远端颈线，换取更高兑现率 |
| `r10` | 固定 1.0R | 目标 = 入场 ± 1 倍风险，胜率最高但赔付比最低，成本占比敏感 |
| `be` | 1R 保本 | 盈利达到 1R 后把止损移到成本价，剩余仓位继续看颈线，杜绝盈利单变亏损 |
| `partial` | 1R 减半 + 保本 | 1R 处平掉一半并锁定成本，剩余一半跑颈线目标 |

**`candidateFrom(...)`**（`:318-378`）：组装 `Candidate`，`id = ${mode}_${ts}_${pattern}_${side}`；`structure = round(sig.strength ?? sig.conf)`；`live = sig.idx >= ctx.n−2`；`tags` 前置诱多/诱空标签；`exits` 五种方案一次算好（当前方案复用 `outcome`，其余单独模拟）；数值经 `r6/r3/r1` 分档四舍五入。

**`runScan(cs,bar,live?,sym?,plan,flow?)`**（`:381-404`）：`buildContext(cs,flow)` → `pick('confirm')` 与 `pick('touch')` 各跑一次 `scanDoubles` + `candidateFrom`。注释强调与 `src/lib/engine.ts` 的 `paramsFor` 保持同一口径（`trendBlock:50`），否则回测与侧栏/面板会在同一形态上给出不同信号集合（对应审计卡 T3）。

**`liveFlowOf(cs,bookImb?,bigBias?)`**（`:406-417`）：`volRatio` = 最后一根 / 前 20 根（不含最后一根）均量；`n<2` 时三项全 `null`。

**`SCAN_BARS(bar)`** = 15m→4320，其他→8640。

### 6.6 引擎配置 `src/quant/config.ts`（130 行，全文已读）

- `EngineConfig{threshold, entryMode:'confirm'|'touch', replaceConfFilter}`；`DEFAULT_CONFIG = {0.58,'confirm',true}`；`LIMITS = {min:0.42, max:0.82, step:0.005}`；
- 注释解释默认 0.58 的理由：单币种单周期样本较小时仍能出信号、避免界面长期空转；面板的门槛扫描会显示更严档位（3 币种 × 双周期样本上 66–72% 才把期望值明显做正），由使用者按数据决定【代码注释中的经验陈述，本次未复算】；
- 存储：`localStorage['pulsedesk.confirm-engine.v1']` + cookie `pulsedesk.confirm-engine`（值 `encodeURIComponent(JSON.stringify({t,m,r:0|1}))`，`path=/; max-age=31536000; samesite=lax`）双写；隐私模式下两处 try/catch 静默忽略；
- `read()` 对存储值做严格校验（`threshold` 必须是 number、`entryMode` 只认 `'touch'` 否则 `'confirm'`、`replaceConfFilter` 用 `??` 兜默认）；
- `setConfig(patch)` → 更新模块级 `current` → `write()` → 通知 `listeners` → `window.dispatchEvent(new CustomEvent('pulsedesk:confirm-config',{detail}))`；
- `subscribeConfig(fn)` 返回退订函数；模块加载时（浏览器）`current = read()` 并监听 `storage` 事件实现**多标签页共享门槛**；
- `configFromCookie(header)` 仅供服务端路由使用，非法内容一律返回 `{}`；
- `clampThreshold(v)` = 夹到 `[0.42,0.82]` 并按 0.005 取整。

### 6.7 M/W 标注模块 `src/vela/signals/`（当前主线）

#### 6.7.1 `patterns.ts` — 纯价格几何（138 行，全文已读）

文件头注释：`Price structure only. This is NOT the original execution scanner or a probability model.`

- `AnnotationPattern{side, idx, first, second, neckIdx, firstLegStart, secondLegStart, level, neck, secondPrice}`，其中 `idx` 是**收盘首次确认第二测试的那根**；
- `annotationTolerance(price, atr) = min(max(tolAtr×atr, tolPct×|price|), 0.7×atr)`（`MAX_TOL_ATR=0.7` 为本模块新增上界）；
- `scanAnnotationPatterns(ctx)`：对 `bottom` 与 `top` 各跑一次，顶部通过镜像价格轴（`{o:-o,h:-l,l:-h,c:-c}`）复用同一规则；
  - 维护 `active: ActiveLevel[]`；淘汰条件：`i − lv.first > lookback(288)`、`c.l < lv.price − sweepAtr(0.5)×ATR`、或 `c.c < lv.price − tol`（收盘跌破）；
  - `rejection` 判据：`c.c >= lv.price + closeBufAtr(0.05)×ATR` 且收盘位置 ≥0.5 且（阳线或下影 ≥35%）；
  - `qualified` = `i − lv.first >= minGap(8)` 且 `lv.neck − lv.price >= minHeightAtr(2)×ATR`；
  - 合格且 `c.l <= lv.price + tol`：若 `rejection` 立即 `emit(i)`，否则记 `lv.pending = i`；`pending` 只能被**紧邻的下一根**已收盘 K 确认（`i === lv.pending+1 && rejection && c.c > test.c`），否则淘汰；
  - `emit` 后 `active.splice(k,1)` —— 注释：一个已确认的第一极值只产生一次二次测试；
  - 第一极值只在 `j = i − R(5)` 处判定，要求左侧 `L(8)` 根都不更低、右侧到 `i` 都不更低，且之前的趋势腿 `prior − low >= priorMoveAtr(1.5)×ATR`（`priorBars = max(3L, 24)`）；同价位已有活跃关键位则跳过；
  - 输出按 `idx` 再按 `first` 排序。
- 注释明确：**不使用**手续费、盈亏比、止损位、趋势过滤或未来 K 线成交量；ATR 容差是继承来的工程启发式，不是拟合出来的胜率。

#### 6.7.2 `evidence.ts` — 可验证证据（110 行，全文已读）

`takerObservation(ctx, flow, i)` 的硬门槛：`c` 存在、`flow.bars.get(c.ts)` 存在、`ctx.real[i]===1`、`buy+sell>0`，否则返回 `null`（注释：绝不用 `ctx.delta` 里的 OHLC 近似替换缺失的 taker 数据）。返回 `coverage = total / c.v`、`volRatio`。

`legFlow(ctx,flow,from,to,barMs)`：逐根检查时间戳连续性（`cs[i].ts − cs[i−1].ts !== barMs` → `continuous=false`）与真实覆盖；`complete = continuous && covered===bars && total>0`；只有 `complete` 才给 `ratio`，否则 `null`。

`realCvdBetween(ctx,flow,first,second,barMs)`：整段 `legFlow(first,second)` 必须 `complete`；以第一极值为参考点，返回 `legFlow(first+1, second).ratio`。

`readMwEvidence(...)`：见 [5.3 第 1 步](#53-链路-c单条-mw-记录是如何得出结论的analyzemwstory)。文案辅助 `observationText(name, o)` 在无观察值时输出「未完整覆盖，不判断主动方向」，有值时输出买卖额、买占/卖占百分比、Δ、来源（`OKX 官方统计` / `逐笔聚合`）与覆盖率。

#### 6.7.3 `scenario.ts` — 单一因果生命周期（89 行，全文已读）

工程常量：`BREAK_ATR=0.2`、`RETEST_WINDOW=48`、`RECLAIM_WINDOW=12`、`MW_VOLUME={breakout:1.5, weakBreak:1.2, contract:0.9, deepRetest:0.618}`；状态集 `LineState = pending|broken|touch|retest|continued|failed|expired`；事件集 `LineEvent.kind = crossing|accepted|touch|held|continued|failed|expired`，事件时间记为 `cs[i].ts + barMs`（即**收盘时刻**）。

`LineRead` 同时保存 `reachedIdx`（首次触带）与 `retestConfirmedAt`（首次收盘守住）—— 两者分开正是修复"触碰被误当确认"的关键（`docs/OPTIMIZATION.md` 第 3 节第 3 条）。文件头注释：本模块只产出共享的价格生命周期，**不生成任何 UI 或结论**。

#### 6.7.4 `mwStory.ts` — 唯一结论出口（298 行，全文已读）

`MwPhase` 十种：`no-break | sweep-level | break-pending | break-weak | break-wait | break-retest | break-held | break-failed | target-reached | expired`；`StorySection.id` 六段：`conclusion | strength | flow | trap | path | targets`。

- `groupMwPatterns(patterns, ctx)`：按 `idx` 排序后，若与某组最后一个成员**同侧 + 时间区间重叠**（`max(p.first,q.first) <= min(p.idx,q.idx)`）且（关键位距 ≤ 1 ATR 或颈线距在容差内）则并入；`samePattern` 去重；注释：合并的是同一关键位/颈线的重叠描述，不是相隔数日的独立事件；
- `analyzeMwStory(input)`：见 [5.3](#53-链路-c单条-mw-记录是如何得出结论的analyzemwstory)；`id = mw:{side}:{第一极值时间}`（归并组内最早的 `first`）；`testCount = |{锚点 first 时间} ∪ {各成员 second 时间}|`（不声称统计了全部盘中触碰）；
- **延伸位规则**（`:176-189`）：`extension = 2×neck − level`；只在 `neck.acceptedAt >= 0` 后、从 `acceptedAt+1` 开始向后找，上界取 `min(last, neck.failedAt−1, level.acceptedAt−1（若更晚）)`；注释：确认根内部的先后顺序无法由 OHLC 得知，只有**后续已收盘 K** 才算触达。命中且未失效且非 expired → `phase='target-reached'`，文案「延伸位已到·不追」，并在 `targets` 段声明"价格触达不是账户利润"；
- **盘中预览**（`:224-232`）：仅当调用方传入 `livePrice`（`preferences.preview` 开启时为形成中收盘价）才生成 `preview` 文案「盘中 X · 颈线/关键位 Y 已触及观察带/在位上下方，距离 Z ATR。待收盘，不改变已确认阶段。」—— 不改 `phase`/`bias`/`targets`/排序；
- **SMC 附加**（`:265-267`）：`windowFlow(ctx, max(0, second−6), idx)` 作为窗口，仅当 `w.known >= 0.95` 才把 `flowKnown` 传给 `readSmartMoney`；`smc = {hits, source, lines:命中项的 label+detail}`；
- `selectMwStories(items, max=3)`：只考虑 `story.active && distanceAtr <= 12`，按 `priority` → `lastActivityAt` → `distanceAtr` 排序，**方向去重**（`bias ?? 'wait'`）+ 同侧近价去重（价差 ≤ 两者 `referenceAtr` 的较大值），最多 3 条。注释：选择只影响展示，历史证据仍在侧栏，不会被静默删除。

#### 6.7.5 `store.ts` — 7 个显示控制与偏好（150 行，全文已读）

| id | 名称 | group | flow | 默认 | rule（原文摘要） |
| --- | --- | --- | --- | --- | --- |
| `doubleTop` | 双顶判读 | mw | ✓ | 开 | 只用已收盘 K 线；同区重叠结构归并；力量是证据计数不是胜率；无真实覆盖就明确缺失 |
| `doubleBottom` | 双底判读 | mw | ✓ | 开 | 双顶镜像；首根越位/两根确认/首次触带/收盘守住/失败分开记时 |
| `keyLevelScenario` | 突破回踩区 | mw | ✗ | 开 | 控制同一形态的观察区带，**不新增信号卡**；最多两块不同方向区带；不预测一定会回踩或到达时间 |
| `keyLevels` | 支撑 / 阻力 | context | ✓ | 关 | 最近 288 根未破摆动位，按距离去重最多 6 条；与主形态同价线不重复绘制 |
| `retest` | 其他突破回踩 | context | ✓ | 关 | 第一次实际回踩并收盘守住才标；仅突破 K 与确认 K 都有完整覆盖才附两根佐证 |
| `smartMoney` | 结构补充 | context | ✗ | 关 | 在同一 M/W 详情显示 SMC 命中事实；只控制附加详情 |
| `deltaImpulse` | 成交力度 | context | ✓ | 关 | 画布最多 4 个已收盘标签；`≈` 为 OHLC 代理，绝不用于双顶双底的成交证据或 CVD |

其他：`SignalPreferences{enabled,selected,labels,geometry,allowApprox,preview,lookback:300|600|1200}`，默认 `{true,…,labels:true,geometry:true,allowApprox:false,preview:false,lookback:600}`；`normalizePreferences` 把不可信存储值逐项校验（`lookback` 只认 300/1200，否则回落 600）；`createSignalStore(storage?)` 先读 v2 键 `pulsedesk.signal-annotations.v2`，为空再读 v1 键 `pulsedesk.signal-annotations.v1` 并置 `migrated`，迁移后立即 `persist()`（注释：保留共有开关，丢弃已合并的"仅证据"开关，**保留旧值供回退**）；`allOff()` 只关总开关、保留 individual 选择；`signalStoreFor(host)` 用 `WeakMap<HTMLElement, SignalStore>` 按宿主缓存；`flowRequested(p)` = 总开关开 且 任一 `flow:true` 类型被选中。

`SignalRuntimeState` 字段：`symbol/timeframe/status('loading'|'ready'|'paused'|'error')/message/bars/requested/gapTruncated/covered/flowSupported/flowConnected/flowSyncing/updatedAt/counts/visible/total`。

#### 6.7.6 `recompute.ts` — 重算判定（60 行，全文已读）

`signalRecomputeKey(i)`：拼接 `marketKey|length|firstTs|lastTs|prevClose|prevVolume|closedOpen|closedHigh|closedLow|floor(now/barMs)|forming`；**`forming` 只在 `preview` 为真时参与**。文件头注释给出了量化依据：默认分析只用已收盘 K 线，若把未收盘价放进键，每个实时 tick 都会触发全量重算（实测 1000 根单次约 18ms，按 300ms 节流上限即持续约 6% 单核占用），而输出在收盘前根本不会变化。

`flowRecomputeKey(snapshot, now, preview, lookback)`：`cutoff = now − (lookback+900)×barMs`；逐条 `ts:buy:sell:src` 排序拼接；**`!preview` 时跳过形成中那根**（`ts + barMs > now`）。注释：tape 在形成中 K 上的更新不得重跑历史 M/W 分析。

#### 6.7.7 `runtime.ts` / `analyze.ts` / `SignalPanel.tsx` / `MwStoryDetails.tsx`

见 [4.4](#44-运行期稳态循环)、[5.2](#52-链路-bmw-信号标注当前主线从-k-线到画布与侧栏)、[5.3](#53-链路-c单条-mw-记录是如何得出结论的analyzemwstory)。补充：

- `write()` 用 `JSON.stringify(payload)` 做指纹去重，注释说明包含悬停详情、区带端点与用户画线（只签短标签会导致状态已更新而画布说明仍是上一根的旧值）；
- `obstacles()` 从 `chart.drawings.all()` 取可见且有 anchors 的绘图，按类型归为 `hline`（`/^(hline|hray|horizontal)/`）或 `points`，供标签避让；
- `DOM dataset`（`signalMarkers`/`signalLevels`/`signalZones`/`signalMarket`/`signalRevision`）注释明确：仅供诊断与测试，画布仍拥有全部绘制权；
- `SignalPanel.tsx`（95 行）：`Toggle` 子组件 + 主面板（页签、7 个开关、状态条、记录列表、`MwStoryDetails` 展开、时间线定位回调）；
- `MwStoryDetails.tsx`（43 行，全文已读）：`data-mw-phase` 属性、关键价位两栏、证据条（`反转证据{label}` + `测试/确认成交 n/2`，`title` 提示"同一根兼作测试与确认时不代表两根独立样本"）、形态确认/最新事件时间、`preview`（`role="status"`）、六段 `<details>`（默认展开 1/2/5）、时间线（最近 12 项，`<button>` + `<time dateTime>`，点击 `onTime(barTs)`）、可选 SMC 段（`data-mw-smc`，末尾固定一条"只计结构条件，不推断机构身份、止损或胜率"）。

### 6.8 订单流数据层 `src/quant/flow.ts`（549 行，全文已读）

**数据结构**：`FlowBar{ts,buy,sell,oiContracts?,oiUsd?,src:'tape'|'rubik',trades?}`；`FlowTrade{ts,side,notional}`；`FlowSnapshot{instId,period,barMs,bars:Map,tapeBars?:Map,recent?:FlowTrade[](上限5000),repairedAt?,from,to,oiFrom,updatedAt,complete,rubikComplete?,rubikFailedAt?,tape:{connected,trades,bootstrapped}}`。

**周期支持**：`PERIOD_MS` = 5m/15m/30m/1H/2H/4H；`flowPeriodOf(timeframe)` 映射 Vela 周期代号 `{'5':'5m','15':'15m','30':'30m','60':'1H','120':'2H','240':'4H'}`，**不支持的周期返回 `null`（不做订单流）** —— 因此 1/3 分钟与 D/W 图上 `flowSupported=false`。

**覆盖判定 `hasRealFlow(bar, candleVol)`**（`:525-535`，本项目最硬的口径之一）：
```text
要求：bar 存在、buy/sell 有限且 ≥0、buy+sell>0、candleVol 有限且 >0
coverage = (buy + sell) / candleVol
真实 = coverage ≥ (src==='rubik' ? 0.95 : 0.85) 且 coverage ≤ 1.1
```
注释给出实测依据：官方 rubik 也可能在刚收盘后返回部分统计（实测 SOL 5m 为 92.17%）；逐笔回补允许少量网络缺口，但不接受超过整根 K 线总额的错单位/重复数据；无有效 K 线成交额时无法证明覆盖，不能把缺失当作完整。

**逐笔聚合 `aggregateFlowTrades(snap, trades, ctVal)`**（`:166-221`）：
- 去重集合挂在**快照**上（`WeakMap<FlowSnapshot, Set<tradeId>>`），注释：去重属于快照而不是共享 socket，每个周期都必须收到每一笔（包括释放/重连之后）；
- 有效性过滤：`px>0 && sz>0 && ctVal>0 && Number.isSafeInteger(tradeId) && ts>0 && 有限 && side ∈ {buy,sell}`；
- `notional = px × sz × ctVal`（张数 → USDT 名义额）；
- 最近两根（`recentStart = floor(now/barMs)×barMs − 2×barMs`）走独立 `tapeBars`，避免新收盘 rubik 统计尚不完整时封锁 WS 更新；更早的根若已是 `rubik` 则**跳过**（历史根以官方统计为准）；
- 写回 `snap.bars` 的条件：原本无值 / 原本是 tape / 或 tape 总额已超过现值；
- `recent` 环形上限 5000：超限时先丢弃 180s 前的，再截断到 5000；
- `seen` 集合水位裁剪：超过 `SEEN_TRIM_AT=250_000` 时删除 `maxId − SEEN_KEEP(150_000)` 之前的 id（注释：BTC 约 10–30 笔/秒，避免随会话时长无界增长）。

**实时 tape（`ensureTape`/`openTape`/`releaseTape`）**：每个合约一条 `wss://ws.okx.com/ws/v5/public` 连接，订阅 `trades` 频道，多周期快照共享；25s ping；`onmessage` 解析后对每个快照 `aggregateFlowTrades`，并用 `tape.rollover` 定时器把通知**合并到 250ms 一次**（注释：与标注运行时节流对齐，端到端延时从约 1.5s 降到约 0.25s）；`onclose` 置 `needsRepair=true` 并 2s 重连；`releaseTape` 关连接、清全部定时器、从 `tapes` Map 删除。

**REST 回补 `bootstrapTape`**：`GET /api/v5/market/history-trades?limit=100&type=1[&after=tradeId]`，从最新向前翻页直到覆盖 `minTs` 或达页数上限，每页间 `sleep(220ms)`，每 15 页 `notify` 一次以便界面渐进刷新；结束置 `tape.bootstrapped=true`。

**rubik 同步 `syncRubik`**：`taker-volume-contract`（`unit:'2'`）分页至多 `maxPages`，页间 `sleep(430ms)`；跳过全 0 行（边界外返回全 0 视为缺失）；**跳过仍在形成的那根**（`ts + barMs > now`，注释：最新行是部分总额，交给实时 tape，若存成权威 rubik 会封锁 tape 聚合、冻结不完整的 delta）；与已有 tape 值比较总额，tape 更完整则不覆盖（注释：刚收盘根的 rubik 有管线延迟）；随后 `open-interest-history` 分页至多 `oiPages`，取 `r[1]` 为 `oiContracts`、`r[3]` 为 `oiUsd`（注释：OKX 返回 `[ts, oi(contracts), oiCcy, oiUsd]`，判断持仓变化要用张数）。

**`syncFlow(instId, period, opts)`**（`:423-467`）：
- 幂等：`inflight: Map<key,{promise,signal}>`；**已 abort 的任务不复用**（注释：`releaseTape` 会关掉实时流，若继续等旧任务（最多 300 页回补）自行结束，重新开启标注后成交流会长时间不重连，侧栏一直停在"等待成交流"）；
- 顺序：**先建立实时连接**（`ensureTape`），再等分页历史统计（注释对应 `docs/OPTIMIZATION.md` 第 3 节第 11 条：WS 连接提前到历史回填之前）；
- 失败冷却：`rubikFailedAt` 距今 <5 分钟则跳过 rubik（注释：无代理的静态环境里 rubik 恒失败，避免每 30s 全量翻页空转）；rubik 失败**不阻塞** tape，只 `console.warn('[订单流] rubik 统计不可用，改用逐笔成交：', e)`；
- 修复性回补：`shouldRepairFlow(snap, needsRepair)`（WS 断开过，或最新聚合 K 落后当前时间 >2 个周期；两次回补间隔 ≥1 个周期）为真时只回补最近 2 根（页数封顶 24）；
- 首次回补：`bootstrapBars ?? 8` 根（5m ≈40 分钟），`bootstrapPages ?? 220`；
- `job.finally` 里只有当 `inflight.get(key)?.promise === job` 时才删除（防止旧任务删掉新任务）。

**`bigBiasOf(trades, now, windowMs=120_000)`**（`:503-521`）：窗口内 <30 笔返回 `bias:null`（缺数据不臆测）；按成交额 90 分位定义大单，**必须严格大于分位值**（注释：大量相同小额成交时 `>=` 会把全部样本算成大单，使 `tapeBias` 退化为全量 delta）；分位过滤后不足 3 笔则退回成交额最高的 10%；返回 `(buy−sell)/(buy+sell)`。

### 6.9 订单流判读 `src/quant/orderflow.ts`（983 行，全文已读）

| 函数 | 产出 | 关键实现 |
| --- | --- | --- |
| `windowFlow(ctx,from,to)` | `FlowWindow{from,to,bars,vol,delta,ratio,known,volRatio}` | `ratio = delta/vol`；`known = 真实覆盖根数/总根数`；`volRatio = 区间量 / 区间 volMa 之和`（无则 1） |
| `pivotOf(ctx,sig)` | `Pivot{prior,first,neck,second,level,neckPrice,secondPrice}` | 从 `sig.geo.pts` 按标签包含「起」「一」「颈线」「二」找点，用 `ctx.index` 换索引；缺失时回退 `i−140 / i−60 / max(first+1,i−12) / i` |
| `legsOf(pv)` | 两腿区间 `{l1a,l1b,l2a,l2b}` | 区间不足 2 根时扩展为极值前 24 根 |
| `readTouch(ctx,level,idx,testIdx?)` | `TouchRead`（真突破 vs 假突破） | 五条证据 `e1…e5` 加权：`e1` 冲向关键位的主动压力与放量推进（`pressure = clamp(approach.ratio×up×4)`，`thrust` 需量比 >1.2 且压力 >0）；`e2` 触及那根的吸收/缩量/主导（放量收位内且突破方未占优 → +0.8；缩量收位内 → +0.4；放量收位外且突破方占优 → −0.9；其余收位外 → −0.3）；`e3` 拒绝影线（`(wick−0.3)×2`，仅 `near`（depth > −0.5 ATR）时计）；`e4` 近 12 根 CVD 是否跟上价格；`e5` 触及后反向是否接管（无后续收盘则为 `null`）。权重 `0.3/0.25/0.12/0.13/0.2`，`e5` 缺失时分母同步减小；随后 **×`approach.known` 做覆盖率加权**（注释：近似数据时证据向中性收缩，满覆盖为 no-op）；`accepted` 时强制 `ev ≤ −0.6`；最终 `×1.6` 并 clamp。`fakeProb = logistic(ev×1.6)`；`verdict`：`accepted→breakout`，`fakeProb≥0.62→reject`，`≤0.4→breakout`，其余 `uncertain`；`kind`：`accepted / sweep(depth>0.05) / touch(depth>−0.35) / approach`。另产出中文 `reasons[]`、`headline`，以及未被接受时的反手 `plan{entry,stop,tp,rr}`（`entry = px + dir×0.1ATR`，`stop = 区间极值 − dir×0.75ATR`，目标距离夹在 `[1.2R, 4R]`） |
| `scanTouches(ctx,horizon=12)` | `{events, stats}` | 对每个摆动关键位，从 `idx+8` 到 `min(breakIdx, n−1−horizon)` 找触及（±0.2 ATR），逐次 `readTouch` 并判定 12 根内结果：先收盘越过 ±0.2 ATR → `break`；先回撤 ≥1 ATR → `reject`；都没发生 → `drift`。统计 `hiN/hiReject`（`fakeProb ≥ 0.6`）与 `loN/loReject`（`≤ 0.45`）；`q += horizon` 保证同一次触碰只计一次 |
| `readSecondTest(ctx,sig)` | `SecondTestRead` | `cvdDiv`：从第一腿起点累计到一极值 vs 累计到二极值，`norm = max(1e−9, totalVol×0.08)`，**× `flowCov = min(leg1.known, leg2.known)`**；`legDeltaDiff = clamp((leg2.ratio − leg1.ratio)×dir×6) × flowCov`；吸收/击穿计数（顶：`h ≥ level−0.1ATR && c ≤ level−0.25ATR && v ≥ avg×1.1` 记 absorb，`c > level+0.2ATR` 记 breach；底镜像）；扫损窗口 `[sweepFrom,sweepTo]`（`beyond > 0.05 ATR`）；诱多/诱空评分 `score`（基础 0.3 + 深度加成 ≤0.15；扫损期主动成交站在反转侧 +0.2×w，或追单放量被吸收 +0.2×w，其中 `w = known≥0.5 ? 1 : 0.5`；突破方占优且未收回 −0.3；CVD 背离 +0.15；两腿衰减 +0.1；OI 增加 >0.3% +0.1；吸收 K +0.1；已有收盘停在外侧 −0.25），`kind = !accepted && score ≥ 0.5 ? bullTrap/bearTrap : null`；`lean`（未校准净倾向，`accepted` 时 −0.25）；`flowSource = sourceOf(knownAll)`，分界 `≥0.95→taker`、`≤0.05→approx`、其间 `mixed`；`headline` 四档中文文案 |
| `findSwingLevels(ctx,{left=8,right=5,priorAtr=1.5,maxAge=576})` | `SwingLevel[]{idx,ts,price,side,breakIdx}` | 左 8/右 5 摆动确认；要求之前 24 根内有 ≥1.5 ATR 的趋势腿；同侧近价（`max(0.35ATR, 0.0004×price)`）去重；收盘越过 ±0.1 ATR 记 `breakIdx` 并移出 `active`；超过 `maxAge` 也移出 |
| `readBreakout(ctx,level,breakIdx,uptoIdx,stats?)` | `BreakoutRead` | 冲击段（突破 K → 极值）与回调段分别用 `windowFlow`；`climax = 突破量比 ≥2.5 或 离位 ≥1.2 ATR`；回踩只在冲击段之后计（当前根不是新极值根、且已离开关键位 ≥0.4 ATR、且 `l ≤ L+0.3ATR`）；`failed` = 收盘回到位另一侧 >0.2 ATR；`held` = 触带后未失败且收盘守回突破侧、收盘位置 ≥0.5（做空镜像）；`healthy = pbVolRatio ≤0.8 && pbDelta×dir > −0.15`，`heavy = pbVolRatio >0.8 && pbDelta×dir < −0.05`；`bucket = touched ? (healthy|held ? retest_hold : retest_heavy) : no_retest`；概率 `p` 从 0.5 起按突破 Δ/量能/climax/OI/回调质量/`held` 加减，`failed` 直接置 0.15；**本图历史**：`stats.buckets[bucket].n ≥ 8` 时按 `(p×8 + rate×n)/(8+n)` 融合（先验权重 8），`chase.n ≥ 8` 时给 `chaseRate`；`followProb` 夹在 `[0.08, 有样本?0.92:0.85]`；`verdict` 七档：`failed / follow / follow_weak / avoid / wait_pullback / strong_hold / chase_risk`；`zone` = 关键位 −0.1…+0.3 ATR（做空镜像） |
| `scanBreakouts(ctx,horizon=48)` | `{events, stats}` | 对每个已收盘突破的关键位，用全视野重判 `bucket`，并分别统计"等回踩后跟随"（从首次触及回踩区起，收盘未回到位另一侧前是否到达 `关键位 ± 1.5 ATR`）与"突破即追"（以突破 K 收盘为入场，是否先到 `entry ± 1.5 ATR`）；`end − b < 12` 时 `chaseWin = null`（视野不足不计入）；`no_retest` 桶只在视野完整（`end−b ≥ horizon`）时才计入统计 |
| `latestBreakout(ctx,maxAge=48)` | 最近一次尚未失败的突破 | — |
| `nearestLevel(ctx,price,maxAtr=0.6)` | 最近未被突破的关键位 | 排除形成不足 8 根的极值（注释：刚形成的极值不算二次测试） |

### 6.10 聪明钱结构 `src/quant/smartmoney.ts`（362 行）

文件头注释列出**只做**有明确价格定义、可用当前数据验证的五项：流动性池（等高等低）与扫位收回、BOS/CHoCH、FVG（三根不重叠）、订单块候选（推进前最后一根反向 K）、溢价/折价；**不做**：判断机构身份/持仓、把 FVG 当必回补承诺、用未校准权重输出胜率。

`readSmartMoney(ctx,p,flow?,flowKnown=false)` 组装 `SmcEvidence[]`（每项 `state ∈ hit|miss|na` + 中文 `detail`），`hits` 为命中计数；`headline` 明确写「结构命中 n/5，**不是胜率**」；`taker` 佐证仅在 `flow && flowKnown && flow.known ≥ 0.5` 时存在，其 `detail` 固定附带免责声明「这是 taker 成交方向，不是订单簿 OFI，也不证明具体止损或机构仓位」；`source = taker ? 'real' : 'price'`。其余函数：`dealingRange(ctx,from,to)`（区间高低/中位/分位/溢价折价）、`findFvgs(ctx,from,to,upto)`（三根不重叠、高度 ≥0.1 ATR、`touched`/`filled`/`fillIdx`）、`latestStructure(ctx,idx)`（收盘越位型 BOS/CHoCH）、`liquidityPool(ctx,p,lookback=160)`（触及次数、`swept`、`reclaimed`）、`orderBlockCandidate(ctx,p)`（位移 ≥0.5 ATR、`mitigated`）。

### 6.11 统计 / 拟合 / 寻优

**`stats.ts`（256 行，全文已读）**：
- `Summary` 含 `detected/traded/wins/losses/winRate/avgR/totalR/pf/maxDD/avgHold/tpRate/slRate/timeRate/beRate/payoff/volR/sharpeR`（`beRate` 注释：此前被错误并入 `timeRate`）；
- `summarize(cands, threshold=0)`：`tradable = outcome.filled && isFinite(outcome.r)`；按 `exitTs` 排序后累计，`pf = grossWin/grossLoss`（无亏损时 99，无盈利时 0），`payoff = avgWin/avgLoss`，`sharpeR = avgR/sd`，`maxDD` 用累计 R 的峰值回撤；
- `calibration(cands, buckets=8)`：按样本实际概率区间等分（区间过窄时强制 `hi = lo+0.02`），逐桶 `summarize`，`ideal = 桶中点`，过滤掉 `traded===0` 的桶；
- `thresholdSweep(cands, 0.42, 0.82, 21)`；
- `attribution(cands, threshold)`：逐因子算 `coverage`、盈利单/亏损单平均证据、`edge = avgWin − avgLoss`、门槛上下的 `used`/`killed`，按 `edge` 倒序；
- `equitySeries(cands, threshold)`：按 `exitTs` 排序的累计 R 序列（附 `proba`、`r`）；
- `topKillers(cands, threshold)`：被门槛挡掉的单子里平均证据最低的 6 个因子；
- `gradeDistribution(cands)`：A/B/C/D 计数与占比。

**`fit.ts`（402 行，全文已读）**：
- `fitLogistic(rows,y,{l2=6,prior,priorBase,maxIter=40})`：MAP 逻辑回归，牛顿法（IRLS）最大化 `Σ loglik − l2/2·||w − prior||²`；截距用 `l2×0.15` 的弱收缩；`solve()` 用带主元选取的高斯消元，主元 <1e−10 返回 `null` 并中断；步长逐维 clamp 到 `[−1,1]`；`maxDelta < 1e−6` 判收敛；**样本 <12 直接返回先验**（`converged:false`）；
- `priorWeights() = FACTORS.map(f => MODEL.gain × f.weight)`；
- `predict(row, fit)`：缺失/非有限值填 0；
- `auc(scores,y)`（两两比较，平局计 0.5，无正/负样本返回 0.5）、`brier`（空返回 0.25）、`logLoss`（空返回 `ln2`，概率夹到 `[1e−9, 1−1e−9]`）、`wilson(wins,n,z=1.96)`；
- `knownBefore(c, splitTs)`：`c.ts < splitTs && (outcome.exitTs ?? c.ts) < splitTs` —— 注释：只按信号时间切分会让"样本内开仓、样本外平仓"的交易把未来结果泄漏进拟合，因此必须 purge 重叠训练样本；
- `evaluateTop(rows,scores,take)`：按分数取前 N 笔评估（注释：不同模型概率尺度不同，用同一绝对门槛比较不公平，改为同等录取笔数比的才是排序能力）；并**用完整测试集的连续分数重算 AUC/Brier**（注释记录旧 bug：把 0/1 选择掩码当模型分数会让 AUC/Brier 描述一个二值向量）；
- `factorDiagnostics(train,test)`：逐因子单变量 AUC，`stable = 同向 && 两段都偏离 0.5 至少 0.03`，样本 <8 时取 0.5；
- `walkForward(cands, threshold, trainFrac=0.7)`：池 <40 返回 `null`；训练段 <20 或测试段 <10 返回 `null`；同时评估四种模型（`prior` 人工先验 / `fitted` 训练段拟合 / `raw` 不设门槛 / `sparse` 训练段自筛精简模型）+ 3 折滚动 `folds` + `coefficients`（先验 vs 拟合 vs delta）+ `diagnostics`/`stableCount`；
- `fitSparse(train, l2=8)`：只用训练段筛出的因子（单变量 AUC 偏离 0.5 ≥0.04、样本 ≥12），未入选权重强制 0，入选因子按训练段 AUC 方向定先验符号；
- `rescore(cands, fit)`：仅用于面板展示，**不参与实时判定**（注释明示）。

**`optimize.ts`（146 行，全文已读）**：`optimize(confirm, touch, oosFrac=0.3)` 取样本较多的一侧为主池（<30 直接返回空），按时间 70/30 切分；网格 = 入场方式 2 × 出场方案 5 × 门槛 `[0.5,0.55,0.58,0.62,0.66,0.7,0.74]`；每格要求样本外 ≥8 笔、样本内成交 ≥8 笔、样本外成交 ≥5 笔；`score = oos.avgR×√n + 0.35×is.avgR×√n_is`，方向矛盾时 `score −= |raw| + 0.5`；`verdict`：`validated`（样本外期望 >+0.05R 且样本内同向为正且样本外 ≥8 笔）/ `weak` / `rejected`；排序先按 verdict 分档再按 score（注释：否则样本外只有 5 笔的幸运组合会排在 16 笔的稳定组合前面）；只返回前 6 组。`edgeOverBaseline(gated, baseline)` 要求两侧都 ≥15 笔，`better = dEv > 0.02`。

### 6.12 服务端行情层 `src/server/okx.ts`（276 行，全文已读）

- `okxGet(path,params,timeoutMs=3000)`：`AbortController` 超时；非 2xx 抛 `HTTP {status}`；`code !== '0'` 抛 `OKX code {code}`；
- `okxGetRetry(path,params,tries=4)`：退避 `300×(t+1)`；
- `parseCandleRow(row,symbol)`：防御性解析官方格式 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,(confirm)]`，校验有限性与 `h ≥ max(o,c)−1e−9 && l ≤ min(o,c)+1e−9`，成交量走 `quoteVolumeFromRow`；
- `fetchCandlesLive(symbol,bar,count)`：先 `market/candles`（`limit ≤ 300`），空则抛错；不足时用 `history-candles` 分页，**每批 8 并发、批间 `sleep(250ms)`**（注释：避免限频造成 K 线缺口），只接受 `ts < oldest` 的行，最后按 ts 去重排序取尾部 `count` 根；
- `fetchTickerLive`：`chg24 = (last−open24)/open24×100`；`vol24Quote = volCcy24h × last`（注释：`volCcy24h` 是 24h 成交的币数量）；
- `fetchFundingLive` / `fetchInstrumentMeta(instType:'SWAP')` / `fetchBookLive(symbol, levels=10)`；
- **合成降级**：`hashStr`(FNV-1a) + `mulberry32` 伪随机，`SYNTH_BASE` 给三个币种各自的基准价/波动率/张数量（BTC 97400/0.0011/9200、ETH 3625/0.0016/26000、SOL 214/0.0022/42000）；`synthCandles(symbol,bar,count,endTs?)` 以 `${symbol}|${bar}|${自然日}` 为种子，含 `regime` 动量项（衰减 0.982 + 1.2% 概率的偶发行情）、4 步子路径生成 high/low、按"张"生成成交量再折算 USDT（注释：保持与真实数据同口径）；`synthTicker(candles)` 用最近 288 根；`synthBook(last, seedExtra)` 生成 10 档、步长 `last×0.00018`；
- `getCandles(symbol,bar,count,fresh=false)`：缓存键 `${symbol}|${bar}|${count}`，TTL 120s；实时成功但 `candles.length < min(count,200)` 也视为不足并抛错 → 降级合成，`live:false` 一并缓存。

### 6.13 数据库双运行时 `src/db/index.ts`（165 行，全文已读）

见 [4.2](#42-服务端启动next-start) 与 [4.3 第 7 步](#43-浏览器启动spa-生命周期)。补充要点：

- `asset(name)`：浏览器用 `new URL('runtime/'+name, document.baseURI).href`，服务端用 `/runtime/`+name；
- `fetchBinary(name, validate)`：依次尝试 `[本地, CDN]`，`res.ok` 且内容通过校验才接受，全部失败抛 `{name} 无法从本地或 CDN 加载`；
- `pool.end()` 只关闭 PGlite `client`（服务端连接池未在此关闭 —— 【代码已确认】`serverPool` 没有对应的 end 调用）；
- `migrations` 常量是一段幂等 SQL（`CREATE TABLE IF NOT EXISTS` ×2 + `CREATE UNIQUE INDEX IF NOT EXISTS signals_unique` + `CREATE INDEX IF NOT EXISTS signals_lookup` + `CREATE INDEX IF NOT EXISTS runs_symbol`），与 Drizzle schema 保持一致，服务端与浏览器共用；
- `initializeDatabase()`：服务端分支 `getDatabase()` 后 `ensureServerSchema().catch(console.warn)`；浏览器分支用模块级 `initialization` 缓存 Promise（**注意：浏览器分支失败时不清缓存**，与服务端分支的重试策略不同 —— 【代码已确认】的差异）。

### 6.14 前端外壳与其余 UI 模块

| 模块 | 职责与关键实现 |
| --- | --- |
| `src/vela/hitFix.ts`（122 行） | `installVelaHitFix()`：全局捕获 `pointerdown`/`pointerup`/`pointercancel`，按下与抬起目标不一致时用 `pointIn(el,x,y,pad=8)` 与 `sameChrome()` 判断是否应把事件重放/补发给 chrome 元素（`CHROME_SELECTOR` 列出的 Vela 弹层/按钮），解决 WebGL 画布吞掉弹层点击的问题 |
| `src/vela/stackGuard.ts`（42 行） | `installStackGuard(root)`：`OPEN_SELECTOR` 命中任一 Vela 弹层打开时给根加 `vela-chrome-open` 类，`src/index.css:24` 据此关闭 `.vela-cell canvas` 的 `pointer-events` |
| `src/vela/marketControls.tsx`（200 行） | `registerMarketControls()` 注册 `pd-timeframes` / `pd-style` 两个顶栏槽位；`MarketControlsHost()` 用 React portal 把下拉渲染到 `body`（绕开画布命中）；`TIMEFRAMES` 分组列表、`STYLES`（K 线/美国线/Heikin Ashi 等 `PriceStyle`）；`anchorOf(kind)` 按按钮矩形定位并 `clamp` 到视口 |
| `src/vela/topbarLabels.ts`（89 行） | `syncTopbarLabels(root, ws)`：把周期/样式按钮文本同步为当前值（如 `15m ▾`），用 `data-pd-kind` 定位（注释：文本会被改写，不能按文本查找）；`tfText`/`styleText`/`readStyle` 导出供测试 |
| `src/vela/toolbarHover.ts`（68 行）/ `toolbarSlide.ts`（65 行） | 绘图工具栏悬停打开（`ROW = '.vela-dtb-cell, .vela-dtb-btn, .vela-dtb-item'`）与滑出动画 |
| `src/lib/drawing-menu.ts`（274 行） | `enhanceDrawingMenus(host)`：为 Vela 原生绘图工具挂飞出菜单（SVG 图标、几何定位、键盘处理）；样式在 `src/vela/drawing-toolbar.css`（325 行，按参考站实测尺寸：52px 轨道、38px 行、32px 目标、20px 字形 —— 尺寸数值来自【旧文档描述】`docs/FRONTEND.md`，CSS 本次仅结构核查） |
| `src/vela/library/IndicatorBrowser.tsx`（1497 行） | 指标库弹窗主体：`Mode` 五种视图（发现/全部/分类/概念/内置）、`Sort`（recent/name）、`Layout`（grid/list）、`SECTION_ZH` 中文分区名、`Highlight`（搜索高亮）、`Thumb`（缩略图）、`SectionHead`、`Library`（主组件，约 1300 行）、默认导出 `IndicatorBrowser`。键盘与响应式行为见 [8.5](#85-指标库顶栏指标)（原模块 README 已删除，内容已迁入该节） |
| `src/vela/library/data.ts`（241 行） | `catalog.json` 的类型化导出（`LibFamily`/`LibIndicator`/`LibConcept`）、`CATALOG_SOURCE`/`CATALOG_FETCHED_AT`、`familyByKey`、`FAMILY_ZH`（17 个分类中文名）、`CLUSTER_ZH`、`clusterLabel`/`familyLabel`/`familyCounts`、`newestDate`/`newestFirst`、`dateLabel`、`firstSentence`、`libraryUrl(slug)`、`nativeFor(item, natives)`（把 Library 条目对应到图表原生指标）、`FAVORITES_KEY = 'vela-indicator-library-favorites-v1'` |
| `src/components/confirm/ConfirmEnginePanel.tsx`（1221 行） | 14 个 Section 的面板；内部组件 `useReveal`（滚动揭示）、`Section`、`Kpi`、`Delta`、`EvidenceBar`（证据条）、`Ring`（概率环）、`tooltip`（recharts 提示）；配色常量 `LONG/SHORT/CYAN/AMBER/MUT/LINE`；`SYMBOLS` 列表 |
| `src/components/{Header,VelaChart,CommandDeck,StatsDrawer,Toasts}.tsx` + `vela/plugins.ts` | 原版页面（`#legacy`）组件：`Header`（品牌/币种/周期/行情条）、`VelaChart`（`probeWebGL2()` 探测 + `forwardRef` 暴露 `VelaChartHandle`、`THEME` 常量）、`CommandDeck`（`ConfRing` 置信环、`Sparkline` CVD 迷你图、`STATUS_LABEL` 状态文案、实时信号流）、`StatsDrawer`（recharts 回测统计、`heatColor` 热力、`Card`/`SideRow`）、`Toasts`；`plugins.ts` 定义 `OVERLAY_ID='pa-overlay'`（自定义画布层：信号标注/FVG/聚焦结构/多空仓位工具）与 `CVD_ID='pa-cvd'`（原生副图指标：K 线估算 Delta 的累计 CVD） |
| `src/lib/okx-ws.ts`（318 行） | 原版页面的 `OKXFeed`：`FeedStatus = connecting|live|poll|sim`；内部 `Socket` 类（6s 无数据守卫、25s ping、退避重试、`dead` 标志）；K 线走 `WS_BUSINESS` 的 `candle{bar}`，成交流与盘口走 `WS_PUBLIC` 的 `trades` + `books5`；`refreshStatus()` 优先级：K 线 WS 有数据 → `live`（并停轮询）；否则有 `pollUrl` → `poll`（每 2s 轮询 `/api/data?tail=1`）；否则 `connecting`；另有 `sim` 相关字段（`simPrice`/`simMomentum`/`simCandle`/`SIM_VOL`）用于 WS 与轮询都不可达时的合成行情 |
| `src/audit/tasks.ts`（254 行）+ `AuditBoard.tsx`（155 行） | 10 张任务卡（见 [10.2](#102-历史缺陷与修复记录审计看板数据)）；`AUDIT_META` 四字段（title/scope/method/principle）；`statusWeight`；看板按 `area` 过滤（全部/构建/后端/策略/订单流/前端）、`SEVERITY_COLOR`（严重→红、高→琥珀、中→青）、`TaskCard` 可展开 |

---

## 7. 数据模型与数据流

### 7.1 数据库表（两份定义必须一致）

- **Drizzle schema**：`remote/setup-mcp-project-locally/src/db/schema.ts`（原始文件，64 行，全文已读），由 `src/db/schema.ts` 一行 `export *` 再导出；
- **建表 SQL**：`src/db/index.ts:91-133` 的 `migrations` 常量，全部 `IF NOT EXISTS`（幂等），服务端与浏览器 PGlite 共用同一份。

#### `signals`（信号主表）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 回测：`{symbol}_{bar}_{ts}_{pattern}_{side}`（`src/lib/engine.ts:99`）；实时：前端生成的信号 id |
| `symbol` | text | NOT NULL | 合约 ID |
| `bar` | text | NOT NULL DEFAULT `'5m'` | 周期 |
| `bar_ts` | bigint | NOT NULL | 信号 K 线时间（ms）；Drizzle 侧 `mode:'number'` |
| `side` | text | NOT NULL, `CHECK (side IN ('long','short'))` | 方向 |
| `pattern` | text | NOT NULL | `db_reject`/`dt_reject`/`db_break`/`dt_break` |
| `entry`/`stop`/`tp` | double precision | NOT NULL | 计划入场/止损/目标 |
| `confidence` | integer | NOT NULL DEFAULT 0 | 原结构质量分（`conf`） |
| `confluence` | integer | NOT NULL DEFAULT 0 | 确认概率百分数（覆盖层写入，语义已从"结构质量副本"改写） |
| `origin` | text | NOT NULL DEFAULT `'backtest'`, `CHECK IN ('backtest','live')` | 来源 |
| `status` | text | NOT NULL DEFAULT `'active'`, `CHECK IN ('skipped','pending','active','won','lost','time')` | 状态 |
| `entry_price`/`exit_price` | double precision | 可空 | 实际成交价 |
| `exit_ts` | bigint | 可空 | 出场时间 |
| `r_multiple`/`pnl_pct` | double precision | 可空 | R 倍数 / 涨跌幅 |
| `holding_bars` | integer | 可空 | 持仓根数 |
| `exit_reason` | text | 可空 | `tp`/`sl`/`time`；`be`(保本) 与 `gap`(跳空) 归入 `time`，真实原因保存在应用层 `exitWhy` |
| `created_at` | timestamptz | DEFAULT `now()` | |

索引：`UNIQUE signals_unique (symbol, bar, bar_ts, pattern, side)`（回测 upsert 的冲突目标）、`signals_lookup (symbol, bar_ts)`。

#### `backtest_runs`（回测批次）

`id`(PK, `{symbol}_{bar}_{Date.now()}`)、`symbol`、`bar`、`bar_count`(default 0)、`from_ts`、`to_ts`、`live_source`(bool, default false)、`flow_filter`(bool, default true)、`signals`(int)、`executed`(int)、`win_rate`(double)、`total_r`(double)、`at`(timestamptz default now())；索引 `runs_symbol (symbol, at)`。

> 迁移机制【代码已确认】：**没有迁移文件目录**，也没有 `drizzle/` 文件夹；建表完全靠运行时执行幂等 SQL，`npx drizzle-kit push` 只是等价的可选命令行方式（`drizzle.config.json` 指向 `./src/db/schema.ts`，连接串是本地默认占位）。

### 7.2 内存数据结构（核心）

| 结构 | 定义位置 | 生命周期与上限 |
| --- | --- | --- |
| `Candle{ts,o,h,l,c,v}` | `src/lib/types.ts:1-8` | 全项目统一 K 线类型；`v` 为**报价币成交额**（USDT 口径） |
| `OHLCV{time,open,high,low,close,volume}` | Vela 契约（`okxProvider.ts` 使用） | 与 `Candle` 在 `runtime.ts:172` 处映射 |
| `barsHub` 的 `store: Map<'ticker|tf', OHLCV[]>` | `src/vela/okxProvider.ts:100-127` | 每 key 上限 **12,000 根**，`merge` 时按 ts 去重排序后 `slice(-12_000)`；变更广播给 `listeners` |
| `FlowSnapshot.bars: Map<ts, FlowBar>` | `src/quant/flow.ts:38-60` | 模块级 `cache: Map<key, FlowSnapshot>`，**无上限、无 TTL**；`recent` 环形上限 5000 笔；`tapeBars` 只保留最近两根 |
| `Ctx`（ATR/delta/real/oi/vols/EMA/volMa/index） | `src/quant/context.ts:6-23` | 每次 `buildContext` 新建，随分析请求存活 |
| `Candidate`（含 `evidence[19]`、`exits` 五方案、`read` 完整判读） | `src/quant/scan.ts:42-83` | 引擎扫描产物；出网经 `wire()` 裁剪（省 `parts`/`read`） |
| `SignalItem` / `MwStory` | `src/vela/signals/store.ts:40-62`、`mwStory.ts:19-31` | 每次 `analyzeSignals` 全量重建；`projectSignals` 截断到 160 条可见 |
| `AnnPayload{levels,events,zones,paths?,position,obstacles,decimals,rev}` | `src/vela/annotTypes.ts:83-93` | 每帧写给两个 Canvas 图层；`rev` 单调递增；`runtime.ts` 用 JSON 指纹去重 |
| 服务端缓存 | `src/server/okx.ts:253`（120s）、`src/app/api/backtest/route.ts:12`（180s）、`src/api/engine.ts:13`（45s）、`src/app/api/okx/[...path]/route.ts:11`（15s / 300 条 FIFO） | 均为模块级 `Map`，进程重启即失 |

### 7.3 数据所有权（谁写、谁读）

| 数据 | 拥有者（写） | 读取者 |
| --- | --- | --- |
| K 线镜像 `barsHub` | `OKXProvider.getBarsProgressive` / `subscribe`（唯一写入方） | Vela 图表、`signals/runtime.ts`（→ `analyzeSignals`）、确认引擎面板间接 |
| 订单流快照 `flow.cache` | `syncFlow`（rubik + tape 两条来源都写 `bars`） | `buildContext`、`api/engine.ts`（浏览器分支 `getFlow`）、`signals/runtime.ts`、`vela/frameworkRuntime.ts` |
| 引擎配置 | `setConfig`（UI）→ localStorage + cookie | `getConfig`（浏览器各处）、`configFromCookie`（`/api/backtest`） |
| 标注偏好 | `SignalStore.patch/toggle/allOn/allOff/persist` → `localStorage['pulsedesk.signal-annotations.v2']` | `runtime.ts`、`analyze.ts`、`SignalPanel.tsx` |
| 工作区布局 | Vela 自身 `persist:'pulsedesk-vela-workspace'` | Vela |
| 指标收藏 | `IndicatorBrowser` → `localStorage['vela-indicator-library-favorites-v1']` | `IndicatorBrowser` |
| `signals` / `backtest_runs` 表 | `/api/backtest`（`origin='backtest'`）、`/api/signals`（`origin='live'`） | `/api/health` 只做 `select 1`；**没有任何读取表数据用于展示的接口**（【代码已确认】无 GET 列表接口） |

### 7.4 端到端数据流（含来源标记）

| 数据 | 来源 | 通路 | 消费方 | 来源标记 |
| --- | --- | --- | --- | --- |
| 图表 K 线 | OKX REST `market/candles` + `history-candles`；WS `business` 的 `candle{bar}` | `OKXProvider` → `barsHub`（12,000 根/key） | Vela 图表、标注运行器 | — |
| 逐笔主动成交 | WS `public` 的 `trades` + REST `history-trades` 回补 | `aggregateFlowTrades` → `FlowSnapshot.bars`（`src:'tape'`），250ms 合并通知 | M/W 证据、`ctx.delta/real`、`bigBiasOf` | `src:'tape'` |
| 逐根 taker / OI 官方统计 | OKX `rubik`（**无 CORS**） | Node 直连 或 浏览器经同源 `/api/okx` 代理 | `syncRubik` → `FlowSnapshot.bars`（`src:'rubik'`）、`ctx.oi` | `src:'rubik'` |
| 行情聚合 | OKX REST（服务端） | `src/server/okx.ts`（120s 缓存）→ `/api/data`、`/api/backtest`、`/api/engine/scan` | `#legacy` 页面、回测、确认引擎面板 | `live:true/false` |
| 盘口 | 引擎扫描 REST `market/books`（10 档）；原版页面 WS `books5`（5 档） | `fetchBookLive` → `bookImbalance` → `LiveFlow.bookImb`；`OKXFeed.onBook` | `bookImbalance` 因子、原版页面显示 | `null` 表示无数据 |
| K 线近似 delta | 由 OHLC 推算（`approxDeltaAt`） | `buildContext` 在无真实覆盖时填入 `ctx.delta` | 仅近似类观察（界面必须标 `≈`） | `ctx.real[i]=0` |
| 持久化 | PostgreSQL / PGlite | `/api/backtest`、`/api/signals` | 统计与复盘（无读接口） | `origin` 列 |

### 7.5 三种数据来源的口径边界（项目最硬的约定）

【代码已确认】`hasRealFlow` 是唯一判定入口，`takerObservation`/`legFlow`/`realCvdBetween` 都在其之上再加"连续性"要求：

| 口径 | 判定 | 允许用途 | 界面标记 |
| --- | --- | --- | --- |
| **真实逐笔**（tape 聚合） | 聚合额 / K 线报价币成交额 ∈ **[85%, 110%]** | 全部真实类证据：单根 taker 观察、两腿比较、连续 CVD、诱多/诱空佐证、SMC 第六项 | 无标记（`source:'real'`） |
| **rubik 官方统计** | 同上但下限 **[95%, 110%]** | 同上 | 「OKX 官方统计」 |
| **K 线近似** | 不满足上述覆盖 | 仅可选的辅助显示（`deltaImpulse` 的 `approx`），**绝不**用于 M/W 的成交证据或 CVD | 前缀 `≈`，`source:'approx'`；混合时 `mixed` |
| **缺失** | 无有效 K 线成交额或覆盖不足 | 记为缺失（`null`），不参与真实类因子，**不得解释为买卖平衡** | 「未完整覆盖，不判断主动方向」 |

另一条固定声明（出现在 `mwStory.ts` 第三段、`analyze.ts` 关键位成交详情、`smartmoney.ts` 的 taker 佐证中）：`buy − sell` 是 **taker 主动成交差**，不是订单簿 OFI；看不到止损委托，因此只称"诱多/诱空**候选**"。

**订单流概念区分表**（迁自 `src/vela/signals/orderflow-keylevel-research.md` 第 2 节，用于避免术语误用）：

| 名称 | 数据/计算 | 能回答 | 不能据此声称 | 本项目 |
| --- | --- | --- | --- | --- |
| Taker Delta / TFI | 逐笔 `side` 的主动买 USDT − 主动卖 USDT，可归一为 `(B−S)/(B+S)` | 某根或某窗口内主动吃单方向与强度 | 净持仓、参与者身份、未来涨跌必然性、盘口供需 | ✅ 已实现 |
| CVD | 同一真实逐笔口径上逐根 delta 连续累计 | 两次相似极值之间的真实主动成交累计变化 | "累计值绝对高所以必涨/必跌"；绝对零点依赖起始时间/reset | ✅ 已实现（要求整段连续覆盖） |
| Footprint / Bid×Ask per price | 每价位格分别累计主动买卖量 | 关键位哪个具体价位成交、逐价差 | 无逐笔成交价分布时不能由 OHLC 或整根 delta 还原 | ❌ 未实现（`FlowTrade` 不分箱） |
| Volume Profile / POC / VAH / VAL | 按价格分箱成交额 | 成交聚集在哪里 | 不含主动方向时不是 Delta/OFI | ❌ 未实现 |
| LOB volume / queue imbalance | 某时刻 best bid/ask 或多档挂单量差 | 当时盘口队列不对称 | 挂单会撤/移；单快照不是成交 | ⚠️ 部分：`bookImbalance`（十档快照）仅用于 `liveOnly` 因子；原版页面用 `books5` |
| OFI（Order-Flow Imbalance） | 按报价与队列变化累计限价单新增/撤单/市价成交造成的 best-queue 变化 | 一段时间内最佳报价端完整供需事件失衡 | 只用成交 `B−S`、一个 books 快照或 K 线 delta 就称 OFI | ❌ 未实现（需 `books` 初始快照 + `seqId` 增量校验管线） |
| 吸收 / exhaustion | footprint 概念：大量单向主动成交但价格推进很小 | 结合局部价格反应描述"推动没有获得相称结果" | tape 看不到对手方是否被动加单、身份或冰山单 | ⚠️ 只称「吸收**候选**」/「推进失败」 |
| Sweep / stop run | 价格越过此前确认极值并收盘收回 | "价格扫位后收回" | 公共成交不含用户 stop 委托，不能断言"止损已触发/多头被套" | ⚠️ 只称「诱多/诱空**候选**」 |

> 研究出处（迁自两份研究笔记，仅作口径依据，非收益证明）：Lo, Mamaysky & Wang (2000, NBER w7613) 技术形态需可重复识别与统计检验；Cont, Kukanov & Stoikov (2014) OFI 是盘口事件失衡而非 trade delta；Cartea, Donnelly & Jaimungal (2018) LOB 数量不平衡的预测对象是下一笔市价单方向；Scaillet, Treccani & Trevisan (2020) 与 Koutmos & Wei (2023) 说明 horizon/venue 必须对齐；Osler (2002/2005, NY Fed SR150) 止损集群证据不能证明图上 wick 就是扫止损；Sierra Chart CVD 文档说明 CVD 精度依赖历史 bid/ask 分类与 reset；Schmalz (2026 SSRN 预印本) 提示一元 OFI 效果不稳定、样本扩充会改变结论（非同行评审，不作事实锚点）。ICT/Wyckoff 术语（order block、FVG、liquidity、BOS/CHoCH、premium/discount、Spring/Upthrust）属社区教学体系，本项目只借用名称，判据全部写死在代码里并可单测。

---

## 8. 接口与横切机制

### 8.1 HTTP 接口总览

全部位于 `src/app/api/`（`/api/engine/scan` 的实现体在 `src/api/engine.ts`），**每个路由都声明 `export const dynamic = 'force-dynamic'`**【代码已确认】。SPA 初始化后（包括由 Next 托管时），除 `/api/okx/*` 外的 5 个接口由 `src/runtime/bootstrap.ts` 在浏览器内用同一批 handler 执行，请求/响应格式一致。

| 方法 | 路径 | 实现 | 缓存 | 数据库 |
| --- | --- | --- | --- | --- |
| GET | `/` | `src/app/route.ts` | `cache-control: no-cache, no-store, must-revalidate` | 无 |
| GET | `/api/health` | `src/app/api/health/route.ts` | 无 | `await initializeDatabase()` + `select 1` |
| GET | `/api/data` | `src/app/api/data/route.ts` | 底层 `getCandles` 120s | 无 |
| GET | `/api/backtest` | `src/app/api/backtest/route.ts` | 180s（键含全部生效配置） | 写 `signals` + `backtest_runs` |
| POST | `/api/signals` | `src/app/api/signals/route.ts` | 无 | upsert `signals` |
| GET | `/api/engine/scan` | `src/api/engine.ts`（路由转发） | 45s | 无（Node 侧调 `syncFlow` 拉 rubik） |
| GET | `/api/okx/{path...}` | `src/app/api/okx/[...path]/route.ts` | 15s / 300 条 FIFO | 无 |

### 8.2 逐接口参数、响应与错误

#### GET `/api/health`

先 `await initializeDatabase()`（注释：健康检查必须反映"表真的可用"，而不是只测一次 `select 1`），再 `db.execute(sql\`select 1\`)`。

| 情况 | HTTP | 响应 |
| --- | --- | --- |
| 数据库可用 | 200 | `{"status":"ok","ok":true}` |
| 数据库不可用（降级） | **200** | `{"status":"ok","ok":true,"fallback":true}` |

> ⚠️ 失败也返回 200，必须检查 `fallback` 字段。【本次运行已验证】未配置 `DATABASE_URL` 时返回 `{"status":"ok","ok":true,"fallback":true}`。

#### GET `/api/data`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `symbol` | `BTC-USDT-SWAP` | 合约 ID |
| `bar` | `5m` | OKX 周期代号 |
| `tail=1` | — | 轻量轮询：只取最新 3 根 K 线 + 5 档盘口 |

普通模式响应：`{live, symbol, bar, candles[{ts,o,h,l,c,v}], ticker{last,open24,high24,low24,chg24,fundingRate,nextFundingTime,markPx,ctVal}, book{bids[{p,s}],asks[]}, serverTime}`。

实现要点【代码已确认】：
- `getCandles(symbol,bar,600)` 取缓存 K 线（最多 600 根）；
- `live` 为真时并行拉 `fetchCandlesLive(...,20)`（失败回 `[]`）、`fetchTickerLive`（失败回 `null`）、`fetchBookLive(...,10)`、`fetchFundingLive`、`fetchInstrumentMeta`，各自 `.catch` 兜底；
- `mergeTail(base,tail)`：用最新 20 根按 ts 覆盖合并（注释：缓存最长 120s，必须补齐，避免与 WS 实时 K 线之间出现缺口），结果截断到 `max(base.length,1)`；
- `ticker` 缺失时用 `synthTicker(candles)`；`book` 无效（任一侧为空）时用 `synthBook(ticker.last)`；
- `ctVal` 优先取 OKX 合约信息，缺失时用 `src/lib/types.ts` 的内置表（BTC 0.01 / ETH 0.1 / SOL 1，`ctValOf` 未命中回退 1）；
- `markPx` = 盘口中间价（买一/卖一均值），仅在两侧都有档位时计算；
- `live:false` 分支：ticker 与 book 全部来自合成数据；
- `tail=1` 失败时返回 `{live:false, candles:[], book:null, serverTime}`，供浏览器 WS 不可达时轮询兜底。

#### GET `/api/backtest`

参数与响应见 [5.5](#55-链路-e回测与落库get-apibacktest)。响应类型 `BacktestResult`（`src/lib/types.ts:201-227`）：

```text
{ live, scope:'single'|'all', symbol, bar, from, to, bars, generatedAt,
  params:{feeBps, slipBps, maxHold, flowFilter, confMin, riskUsd},
  overall:OverallStat, bySide:{long,short}, byPattern:PatternStat[], bySymbol:[{symbol,stat}],
  byHourDay:HourDayStat[], rDist:[{label,from,n}], equity:[{ts,cumR}], signals:TradedSignal[],
  strategy?:{…},                       // 当前双顶/双底策略参数
  engine:{threshold, entryMode, replaceConfFilter}   // 本次实际生效配置（回显）
}
```

`OverallStat` 字段（`src/lib/types.ts:172-199`）：`signals/executed/skipped/wins/losses/winRate/avgR/totalR/pf/avgHold/maxDD/bestR/worstR/grossWinR/grossLossR/avgWinR/avgLossR/payoff/maxWinStreak/maxLossStreak/tpCount/slCount/timeCount/costR/netPct`。

#### POST `/api/signals`

请求体 `LiveSignalBody`（`src/app/api/signals/route.ts:6-26`）：必填 `id`、`symbol`；可选 `bar`(默认 5m)、`barTs`、`side`、`pattern`、`entry`、`stop`、`tp`、`confidence`(默认 0)、`confluence`(默认 0)、`status`(默认 `pending`)、`entryPrice`、`exitPrice`、`exitTs`、`rMultiple`、`pnlPct`、`holdingBars`、`exitReason`。

响应：200 `{"ok":true}` / 400 `{"error":"missing fields"}` / 500 `{"ok":false}`（并 `console.warn("signal persist failed:", e)`）。

> 【代码已确认】该路由**没有请求体字段级校验**（除 `id`/`symbol` 存在性）：`side`/`status` 等直接进 SQL 参数，非法值会触发数据库 `CHECK` 约束失败并走 500 分支。

#### GET `/api/engine/scan`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `symbol` | `BTC-USDT-SWAP` | `ALL` = 三币种 |
| `bar` | `5m` | `ALL` = `5m` + `15m` |
| `exit` | `neck` | `neck`/`r15`/`r10`/`be`/`partial`，非法值回退 `neck` |
| `fresh=1` | — | 绕过 45s 缓存 |

响应（`src/api/engine.ts:140-169`）：`{symbol,bar,symbols,timeframes,live,from,to,lastTs,bars,barMs,maxHold,generatedAt,factors[19],model{base,gain},config,exitPlan,exitPlans[5],flow,confirm[≤320],touch[≤320]}`。

#### GET `/api/okx/{path...}`

白名单与错误码见 [5.7](#57-链路-gokx-rubik-统计代理与浏览器例外通道)。

#### GET `/`

按顺序尝试 `{cwd}/dist/index.html` → `{cwd}/public/index.html`（后者已不在仓库，仅手工放置时生效），命中则 200 返回 HTML（`content-type: text/html; charset=utf-8` + 禁缓存头）；两者都缺失返回 **503 纯文本**：
```
PULSEDESK SPA bundle is missing. Run `npm run build` (prepare-runtime + vite build + next build), or `npm run build:spa` for the frontend only.
```
代码注释说明设计意图：两者都缺失说明 SPA 从未构建过，必须明确报错，而不是让前端一直等待"初始化"。

> 项目**刻意没有** `src/app/page.tsx`：页面完全由 SPA 承担，Next 只做 API 与静态托管。`src/app/layout.tsx` 因此实际上是死代码路径（Next 仍要求存在 RootLayout），其 `metadata.title` 仍是模板值 `"Arena Next.js PostgreSQL Starter"`【代码已确认】——不影响用户看到的标题（标题来自 `dist/index.html` 的 `<title>PULSEDESK · 5m 价格行为 × 订单流信号终端</title>`）。

### 8.3 浏览器内分发（第二种"接口"实现）

`src/runtime/bootstrap.ts:28-57` 的路由表：

| pathname | 方法 | handler 来源 |
| --- | --- | --- |
| `/api/data` | GET | `@/app/api/data/route` |
| `/api/backtest` | GET | `@/app/api/backtest/route` |
| `/api/signals` | POST | `@/app/api/signals/route` |
| `/api/health` | GET | `@/app/api/health/route` |
| `/api/engine/scan` | GET | `@/api/engine` |
| `/api/okx/*` | — | **例外**：`fetchStatsProxy`（必须走真实同源后端） |

行为细节：跨源请求直接放行原生 fetch；表内路径但方法不匹配 → 405 + `Allow` 头；handler 抛错 → `console.error('API {pathname}:', error)` + 500 `{"error":"Internal server error"}`。

> ⚠️ **两种数据库不同步**【代码已确认 + 本次运行已验证】：浏览器运行时初始化完成后，即使页面由 Next 托管，同源 `/api/*`（除 okx）也会被本地分发并用**会话级 PGlite**；只有直接对 Next 发 HTTP 请求（如 curl）才写 `DATABASE_URL` 指向的 PostgreSQL。因此不能把浏览器内的 `/api/health` 结果当作服务端数据库检查。初始化完成前发出的请求仍可能走真实 HTTP。

### 8.4 身份认证与权限控制

【代码已确认】**不存在**。全库无认证中间件、无 session/JWT、无角色判断；OKX 侧全部为公共接口，无需 API Key；`scripts/*.py` 通过环境变量 `MCP_URL_BASE64`（或忽略目录 `.mcp-import/endpoint.base64`）连接导入端点，**该地址不出现在 Web 应用代码中**（`scripts/mcp_client.py:19-24`：两者都缺失时抛 `Set MCP_URL_BASE64 to connect to the requested MCP server`）。

### 8.5 指标库（顶栏「指标」）

- **宿主**：`src/vela/IndicatorPickerDialog.tsx`（14 行）+ `registerIndicatorPicker.tsx` 接管顶栏 `indicators` 槽位；
- **数据**：`src/vela/library/catalog.json`（840KB 单行 JSON），形状【本次运行已验证】`{source, fetchedAt:'2026-10-08T19:28:38.705016+00:00', families[17], indicators[801], concepts[853]}`；`source` 为 `https://app.luxalgo.com/api/library/indicators/query?fields=card&sort=name&pageIndex=0&pageQuantity=1000`；**运行时不请求该接口**；
- **视图**：发现（最新 3 张 / 更多探索可换一批 / 17 个分类磁贴）、全部指标（最新或名称排序、网格或列表、显示更多分页）、分类 + cluster 筛选、概念浏览（853 个，点开看库内实现）、内置指标（来自当前图表 `availableNativeIndicators()`，点击即 `addNativeIndicator()`）；
- **添加策略**：Library 条目名称能对应到图表原生指标时同样走原生添加（`nativeFor(item, natives)`），否则显示为 Library 脚本并给出托管图表链接（`libraryUrl(slug)`）；
- **搜索**：同时命中内置 / Library / 概念并高亮（`Highlight` 组件）；
- **收藏**：`localStorage['vela-indicator-library-favorites-v1']`，跨开关保持；
- **键盘**：`↑/↓` 浏览、`Enter` 添加、`Shift+Enter` 添加并保持打开、`F` 收藏、`Esc` 关闭、`/` 聚焦搜索；
- **响应式**：≤980px 详情变滑入面板；≤720px 左侧导航变横向条；
- **样式**：`src/vela/indicator-library.css`（1024 行，按参考站实测尺寸：1080×680 弹窗、52px 头部、208/590/280 三栏、34px 底栏 —— 尺寸数值来自模块旧文档，CSS 本次仅结构核查）。

### 8.6 日志、监控与异常处理

| 机制 | 实现 |
| --- | --- |
| 日志 | 全部为 `console.*`，无日志框架、无落盘、无采集。关键前缀：`[确认引擎]`（`src/lib/engine.ts:179`）、`[订单流]`（`src/quant/flow.ts` 两处 `console.warn`）、`[信号标注]`（`signals/runtime.ts:180`）、`API {pathname}:`（`bootstrap.ts:54`）、`Preview runtime 初始化失败…`（`App.tsx:17`）、`Local persistence unavailable:`（`bootstrap.ts:16`）、`Server schema init failed:` / `Server database unavailable:`（`db/index.ts:65,140`）、`persist failed:` / `signal persist failed:`（两个 route） |
| 监控 | 无。**`#audit` 看板是历史修复记录，不是运行时监控**（`src/audit/AuditBoard.tsx` 只渲染静态 `AUDIT_TASKS`） |
| 异常处理风格 | "降级而不中断"：数据库失败 → 只放弃持久化；行情失败 → 合成数据 + `live:false`；rubik 失败 → 改用逐笔 + 5 分钟冷却；标注计算抛错 → 空分析 + 中文错误提示，图表与手动画线不受影响；PGlite 资源不合格 → CDN 回退；Vela 构造失败 → `console.error` 后页面空白（无兜底 UI） |
| 诊断出口 | `window.__velaWs`（工作区实例）、`ctx.host.dataset.signal*`（标注计数/市场/revision）、`scripts/inspect-signals.ts`（⚠ 该脚本不在当前仓库中，需从上游仓库取回后才能运行） |

### 8.7 缓存、并发、超时与重试一览

| 位置 | TTL / 上限 | 并发 | 超时 | 重试 |
| --- | --- | --- | --- | --- |
| `src/server/okx.ts` `getCandles` | 120s | — | `okxGet` 3s | `okxGetRetry` 4 次，退避 `300×(t+1)`；历史分页每批 8 并发、批间 250ms |
| `/api/backtest` | 180s | 币种**串行**（防限频） | 继承上游 | — |
| `src/api/engine.ts` | 45s | 周期×币种**串行** | 继承上游 | — |
| `/api/okx/[...path]` | 15s，≤300 条 FIFO | — | 上游 6s | 无（失败即 502） |
| `barsHub` | 每 key 12,000 根 | — | — | provider `okxGet` 429 退避 `400×(n+1)` 共 4 次 |
| `flow.ts` `okxGet` | — | tape 每合约 1 条 WS，多周期共享 | — | 429 退避 `900×(n+1)` 共 3 次，第 3 次仍 429 **抛错**（不当成空页） |
| `bootstrapTape` | — | 串行翻页 | — | 每页间 `sleep(220ms)`；每 15 页通知一次 |
| `syncRubik` | — | 串行翻页 | — | 每页间 `sleep(430ms)`；失败置 `rubikFailedAt` → 5 分钟冷却 |
| `syncFlow` | `inflight` 去重（已 abort 的不复用） | — | — | 修复性回补（最近 2 根，≤24 页），间隔 ≥1 个周期 |
| tape WS | `recent` ≤5000 笔；`seen` ≤250k（裁剪到 150k 水位） | 通知合并 250ms | — | `onclose` 2s 重连；25s ping |
| provider WS | — | — | — | `onclose` 2s 重连；20s ping |
| `OKXFeed`（原版页面） | — | 两条 WS（business + public） | `Socket` 6s 无数据守卫 | 退避重连；WS 失败转 2s 轮询 `/api/data?tail=1`，再失败转 `sim` |
| 标注运行器 | — | — | — | 300ms 前缘节流 + 尾缘补跑；1.5s 心跳；flow 请求 30s 内不重复 |
| `fit.ts` `fitLogistic` | — | — | — | 最多 40 次牛顿迭代，步长 clamp ±1，`maxDelta<1e−6` 收敛；样本 <12 直接返回先验 |

---

## 9. 配置、运行、构建与部署

### 9.1 环境要求

| 项 | 要求 | 依据 |
| --- | --- | --- |
| Node.js | 20.19+ 或 22.12+ | 【旧文档描述】`README-PULSEDESK.md:7`；本机实测 v20.20.2 可用【本次运行已验证】 |
| npm | 随 Node（本机 10.8.2） | 【本次运行已验证】 |
| 网络 | 实时行情需能访问 `www.okx.com` 与 `ws.okx.com`；rubik 统计需同源后端代理 | 【代码已确认】`src/server/okx.ts:5`、`src/quant/flow.ts:62-63`、`src/app/api/okx/[...path]/route.ts` |
| PostgreSQL | 可选。缺失即降级（浏览器 PGlite 或 `fallback:true`） | 【代码已确认】`src/db/index.ts:59-66` |
| 浏览器 | 需 WebGL2（原版页面 `probeWebGL2()` 探测）与 WebAssembly | 【代码已确认】`src/components/VelaChart.tsx:28` |
| 磁盘 | `node_modules` 约 475 包；PGlite 二进制约 16MB（构建时生成） | 【本次运行已验证】475 包 |

### 9.2 环境变量与配置项

| 变量 | 用途 | 读取位置 | 必需 | 默认/缺失行为 |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | 服务端 PostgreSQL 连接串，形如 `postgresql://<user>:<password>@<host>:<port>/<db>`（**占位符，勿把真实凭据写入仓库**） | `src/db/index.ts:59`（`process.env.DATABASE_URL`） | Next 模式持久化需要 | 缺失时 `getDatabase()` 返回 `undefined`，`db` 代理抛错 → `/api/health` 回 `fallback:true`、回测只放弃持久化 |
| `MCP_URL_BASE64` | 仅导入工具使用（Base64 编码的 MCP 端点） | `scripts/mcp_client.py:20`；也可放 `.mcp-import/endpoint.base64`（已 gitignore） | 否 | 缺失时脚本抛 `Set MCP_URL_BASE64 to connect to the requested MCP server`；**Web 应用不读该变量** |
| `TEST_URL` | 浏览器回归的被测地址 | `tests/*.browser.mjs` 各自第 5–8 行 | 否 | 默认值**各文件不同**：`signal-annotations.browser.mjs` → `http://127.0.0.1:3000/`；`runtime`/`symbols`/`flowread` → `http://127.0.0.1:5173/`；`library`/`drawing-toolbar` → `http://localhost:5173/` |

**仓库中不存在 `.env` 文件**【本次运行已验证】（`ls -la .env` 无结果）。旧文档提到"根目录 `.env` 提供 `DATABASE_URL`"，需要使用者自行创建；Next.js 会自动加载根目录 `.env`。

**非环境变量类配置项**：

| 配置 | 位置 | 说明 |
| --- | --- | --- |
| drizzle 连接串 | `drizzle.config.json:5` | 硬编码本地默认 `postgresql://postgres:postgres@127.0.0.1:5432/app_db`，**仅供 `drizzle-kit push` 使用**；运行时不读它（运行时读 `DATABASE_URL`） |
| PGlite CDN 版本 | `src/db/index.ts:8` | `PGLITE_VERSION = '0.5.14'`，必须与 `package.json` 的 `@electric-sql/pglite` 声明一致 |
| 端口 | `package.json` 脚本不含端口 | `next start` 默认 3000、`vite` 默认 5173、`vite preview` 默认 4173；需显式传 `--port` |
| localStorage 键 | 见 [9.5](#95-浏览器本地存储键清单) | 用户偏好全部落在浏览器 |
| Cookie | `pulsedesk.confirm-engine` | 引擎配置镜像，`max-age=31536000; samesite=lax; path=/` |

### 9.3 本地启动步骤

> 下列命令**均有项目文件依据**（`package.json` scripts、`scripts/*.mjs`、`tests/*`）。标注【本次运行已验证】的在本机实际执行并观察到结果；其余标注【未执行】，不得视为已验证可用。

**方式一：生产模式（Next 托管，端口 3000）**

```sh
npm install                 # ⚠ 不要用 npm ci：仓库锁文件与 package.json 不同步（见 2.4 / 10.3）
                            # 【本次运行已验证】added 475 packages

# 可选：先把表建到 DATABASE_URL 指向的 PostgreSQL（运行时也会自动幂等建表）
npx drizzle-kit push        # 【未执行】依据 drizzle.config.json

npm run build               # = node scripts/prepare-runtime.mjs && vite build && next build
                            # 【本次运行已验证】三段全部通过；产物 dist/index.html 3.4MB
                            # 构建期有一条已知无害的 Turbopack NFT tracing 警告（见 4.1）

npm start -- --port 3000    # = next start
                            # 【本次运行已验证】✓ Ready in 136ms；GET / 返回 200，
                            # <title>PULSEDESK · 5m 价格行为 × 订单流信号终端</title>
```

访问 `http://localhost:3000/`（Vela 工作区）、`/#legacy`（原版页面）、`/#audit`（审计看板）、`Shift+C`（确认引擎面板）。

**方式二：前端开发（Vite，端口 5173）**

```sh
node scripts/prepare-runtime.mjs                       # 【本次运行已验证】作为 build 第一段执行过
npm run dev -- --host 0.0.0.0 --port 5173              # 【未执行】
npm run preview -- --host 0.0.0.0 --port 4173          # 【未执行】需先构建
```

**其余脚本**（`package.json:4-15`）：

| 脚本 | 命令 | 说明 |
| --- | --- | --- |
| `dev` | `vite` | Vite 开发服务器（默认 5173） |
| `build` | `node scripts/prepare-runtime.mjs && vite build && next build` | 三段缺一不可 |
| `start` | `next start` | 默认 3000 |
| `preview` | `vite preview` | 默认 4173 |
| `dev:next` / `build:next` | `next dev` / `next build` | 只跑 Next |
| `build:spa` | `node scripts/prepare-runtime.mjs && vite build` | 只构建前端 |
| `lint` | `eslint .` | 【未执行】 |
| `typecheck` | `tsc --noEmit` | 【本次运行已验证】**当前失败**：1 个错误，见 10.1 |
| `test:quant` | 串跑 `orderflow` / `annot-layout` / `audit-fixes` 三个单测 | 【未执行】 |

**类型生成**：旧文档给出的 `npx next typegen`【未执行】用于生成 `.next/types/routes.d.ts`（`next-env.d.ts:3` 会 import 它）。

### 9.4 构建产物与部署形态

| 产物 | 生成者 | 是否入仓 | 说明 |
| --- | --- | --- | --- |
| `dist/index.html` | `vite build` | 否（`.gitignore` 含 `dist/`） | 单文件 SPA，JS/CSS 全内联 |
| `dist/pglite.js`、`dist/runtime/*` | `vite build`（复制 `public/`） | 否 | 浏览器 PGlite 运行时 |
| `public/runtime/pglite.js` | `prepare-runtime.mjs`（esbuild） | **是**（590KB） | 仓库已提交一份 |
| `public/runtime/{pglite.wasm,initdb.wasm,pglite.data}` | `prepare-runtime.mjs`（从 `node_modules/@electric-sql/pglite/dist/` 复制） | **否** | 【本次运行已验证】GitHub tree 只列出 `public/index.html`、`public/pglite.js`、`public/runtime/pglite.js`；三个二进制**未提交**，必须先跑 prepare-runtime，否则浏览器端会走 jsDelivr CDN 回退（`src/db/index.ts:15`） |
| `public/index.html` | 旧版手工预置的构建产物快照 | **否**（已从仓库删除） | 根路由回退路径仍在，仅手工放置时生效 |
| `.next/` | `next build` | 否 | 服务端构建 |
| `.verification/` | `run-ts-test.mjs`、浏览器套件 | 否（gitignore） | 测试产物、真实市场诊断输入/输出、截图 |

**两种部署形态**：

1. **Next 托管**（推荐）：`npm run build && npm start`。可用全部功能，包括 `/api/okx` rubik 代理与服务端 PostgreSQL 持久化。
2. **纯静态托管 `dist/index.html`**：图表、标注、确认引擎面板（浏览器内分发 handler + PGlite）可用；但 `/api/okx/*` 必然失败 → `statsProxy` 返回 503（HTML 回退）或 502（网络失败），rubik 官方统计不可用，**真实逐笔 tape 仍可用**（走 WS，不经代理），历史覆盖因此受限；持久化只到会话级内存库。【代码已确认】`src/runtime/statsProxy.ts`、`src/quant/flow.ts:116-128`；【旧文档描述】`docs/OPTIMIZATION.md` 第 6 节明确"纯静态 Vite 部署不能凭浏览器突破 rubik 的 CORS 限制"。

**CI/CD**：【代码已确认】**仓库内没有任何 CI 配置**（无 `.github/workflows`、无 `.gitlab-ci.yml`、无 Dockerfile）。旧文档提到的"平台环境另外运行受管 `build_and_start` 并检查 `/api/health`"属外部平台流程，仓库内无对应文件。

### 9.5 浏览器本地存储键清单

| 键 | 写入者 | 内容 |
| --- | --- | --- |
| `pulsedesk-vela-workspace` | Vela（`persist` 选项） | 工作区布局与当前市场 |
| `pulsedesk.confirm-engine.v1` | `src/quant/config.ts:93` | `{threshold, entryMode, replaceConfFilter}` |
| `pulsedesk.signal-annotations.v2` | `src/vela/signals/store.ts:106` | 7 个显示控制 + `enabled/labels/geometry/allowApprox/preview/lookback` + `version:2` |
| `pulsedesk.signal-annotations.v1` | 旧版本 | 只读，用于迁移共有字段；**保留旧值供回退**，不整体清空 |
| `vela-indicator-library-favorites-v1` | `src/vela/library/data.ts:186` | 指标收藏 |
| ~~`pulsedesk.okx-proxy`~~ | 已移除 | 代码不再读取该键；rubik 固定走同源 `/api/okx` |

### 9.6 外部服务依赖清单

见 [2.5](#25-外部服务依赖)。补充：全部 OKX 接口均为公共接口，**无需 API Key**；rubik 两个统计接口**不返回 CORS 头**，浏览器必须经同源代理。

---

## 10. 测试、排障与已知限制

### 10.1 测试组织

#### TypeScript 单测（13 个 `.test.ts` + 2 个 fixture）

运行器 `scripts/run-ts-test.mjs`（24 行，全文已读）：用 esbuild 把单个测试文件打包到忽略目录 `.verification/{name}.mjs`（`bundle/platform:node/format:esm/target:node20`，`alias: {'@': resolve('src')}`），再 `import(pathToFileURL(...))` 执行。断言用 `node:assert/strict`，**没有测试框架依赖**。

```sh
node scripts/run-ts-test.mjs tests/mw-story.test.ts          # 单个套件
for t in tests/*.test.ts; do node scripts/run-ts-test.mjs "$t" || exit 1; done   # 全部，任一失败即停
npm run test:quant                                           # 只跑 orderflow / annot-layout / audit-fixes
```
【未执行】以上命令本次未运行（任务要求不执行可能修改环境的脚本；`run-ts-test.mjs` 会创建 `.verification/` 目录）。

覆盖范围（迁自 `tests/README.md`，并与各文件的 import 逐一核对）：

| 文件 | 验证范围 | 实际导入的活动模块（已核对） |
| --- | --- | --- |
| `mw-story.test.ts` | 未到颈线不提前完成（旧代码先红后绿）、六段证据、突破/回踩镜像、触带与确认时点分离、实际目标触达、旧形态的新事件、重叠归并、真实覆盖、12 根窗口、预览隔离、历史聚焦、v1→v2 迁移 | `@/vela/signals/{mwStory,analyze,evidence}`、`@/quant/{context,flow}`、`./mw-fixtures`、`./signal-fixtures` |
| `key-level-scenario.test.ts` | 统一 story 接口；单根/双根、弱量/一般量/放量、回踩收缩/深度、突破失败、外侧关键位失效、过期与去重 | `@/vela/signals/{mwStory,scenario}`、`@/quant/context`、`./mw-fixtures` |
| `scenario-causality.test.ts` | 固定观察带；未来波动不回写旧事件；不能跨缺口确认；rubik 覆盖不足/过量与报价币成交额单位 | `@/vela/signals/{mwStory,scenario}`、`@/quant/{context,flow}`、`@/lib/okxVolume` |
| `signal-logic.test.ts` | 原价格形态几何、成本/RR 不阻止标注、原始证据因果性、局部成交与连续 CVD 区别、85% 边界、中性/推进侧成交、两腿比较、缺口与首次普通回踩 | `remote/.../src/lib/engine`、`@/lib/types`、`./signal-fixtures` |
| `signal-annotations.test.ts` | 合并后投影、方向/区带/标签/几何开关、真实与近似、可撤销形成中 Δ、偏好保存、多周期成交去重 | `@/vela/signals/{analyze,store}`、`@/quant/flow` |
| `realtime-stability.test.ts` | 盘中价格不改收盘结论；预览独立；闭合 K 与成交指纹；普通关键位成交附加；缺口范围可观测 | `@/vela/signals/{analyze,recompute,store}` |
| `realtime-transport.test.ts` | 统计代理不把取消转成 CORS 直连；JSON 错误透传；HTML 不是统计；WS 先于历史连接；取消不进入 5 分钟上游失败冷却 | `@/quant/flow`、`@/runtime/statsProxy` |
| `smartmoney.test.ts` | FVG/区间/订单块/流动性的纯算法；无覆盖不伪造成交；SMC 作为同一 M/W 的附加详情 | （见文件） |
| `flow-markers.test.ts` | 价格精度、代理白名单、真实"努力/价格结果/爆量"、画布密度 | `src/app/api/okx/[...path]/route`、`@/vela/okxProvider`、`@/vela/signals/{analyze,store}`、`@/quant/flow` |
| `regression-fixes.test.ts` | 闭合 K 过滤、历史真实成交/回测回归 | `remote/.../engine`、`src/lib/{candles,engine}`、`@/quant/{context,fit,flow,model}` |
| `orderflow.test.ts` | 独立交易引擎的订单流判读、突破统计（与新版视觉 M/W 分开） | `remote/.../engine`、`@/quant/{context,flow,orderflow,scan}` |
| `annot-layout.test.ts` | 画布避让、轨道、事件标签与卡片位置 | `src/vela/annotLayout` |
| `audit-fixes.test.ts` | 已有引擎配置/回测等修复的回归 | `@/lib/engine`、`@/quant/{flow,scan,stats}`、`@/server/okx` |
| `key-level-call.test.ts` | ⚠ 针对**孤岛模块** `src/vela/signals/keyLevelCall.ts`；`tests/README.md` 称其"已迁入统一 M/W 套件"，但文件与其被测模块都还在 | `src/vela/signals/{keyLevelCall,analyze,patterns,store}`、`@/quant/{context,flow}` |
| `signal-fixtures.ts` / `mw-fixtures.ts` | 测试辅助数据，不是测试入口 | — |

#### 浏览器回归（Playwright，6 个 `.browser.mjs`）

```sh
npx playwright install --with-deps chromium      # 【未执行】
npm run build && npm start                       # 或 vite dev / preview
TEST_URL=http://127.0.0.1:3000/ node tests/signal-annotations.browser.mjs
```

| 文件 | 范围 / 数据 | 默认 TEST_URL |
| --- | --- | --- |
| `signal-annotations.browser.mjs` | 确定性**测试专用** REST/WS，同时隔离同源统计代理；默认 M/W、一形态一条、六段证据、时间线定位、7 控制项、手绘保护、快速切换重连、预览与已确认结论隔离、收起侧栏仍更新、SMC 不重复记录、刷新/切币/无成交周期/手机布局 | `http://127.0.0.1:3000/` |
| `symbols.browser.mjs` | BTC/ETH/SOL 选择器、品牌图标、真实切换、焦点样式与浏览器错误（用公共行情） | `http://127.0.0.1:5173/` |
| `library.browser.mjs` | 801 脚本目录的分类/搜索/收藏/分页、原生指标添加、键盘与移动端、参考布局 | `http://localhost:5173/` |
| `drawing-toolbar.browser.mjs` | 原生工具/绘图/撤销/测量/擦除、菜单与缩放/响应式几何 | `http://localhost:5173/` |
| `runtime.browser.mjs` | 页面启动、浏览器本地 API/PGlite、桌面与移动、脚本错误 | `http://127.0.0.1:5173/` |
| `flowread.browser.mjs` | ⚠ 依赖**已停用**的交易侧栏（`tests/README.md` 称"已清理，不再作为现行验收入口"，但文件仍在） | `http://127.0.0.1:5173/` |

**必须串行运行**：它们共享同一条限频的公共行情 feed（`tests/README.md` 第 2 节）。输出：`.verification/mw-browser-report.json`、`mw-desktop.png`、`mw-mobile.png`；截图使用模拟行情，只是 UI 证据，不是市场表现。

#### 真实市场只读诊断

```sh
node scripts/run-ts-test.mjs scripts/inspect-signals.ts BTC-USDT-SWAP 5 600 flow
node scripts/run-ts-test.mjs scripts/inspect-signals.ts ALL ALL 600 flow
```
【未执行】（⚠ 该脚本不在当前仓库中，需从上游仓库取回后才能运行）。下列为该脚本在上游版本中的行为：：参数校验（只允许 BTC/ETH/SOL、5/15、300/600/1200）→ 真实 OKX K 线（预算 = 回看 + 900 根，429 退避 700×(n+1)，30 页上限，页间 220ms）→ 可选 `syncFlow` → `analyzeSignals` + `projectSignals`（默认偏好与全开偏好各一次）→ 连续段 `buildContext` + `scanAnnotationPatterns` 对照 → 5 次计时取中位数 → **扰动形成中价格两次并比较 M/W 签名**（`signature()` 只取 id/title/origin/evidence/phase/targets/timeline）→ 写 `.verification/mw-live-{symbol}-{tf}-input.json` / `-analysis.json` / `mw-live-summary.json`；若 `!stable || duplicateRecordIds` 则抛 `M/W invariant failed`。**明确不使用合成行情兜底**（无真实响应直接抛错）。

#### 必需构建检查

```sh
npx next typegen                                 # 【未执行】
npm exec tsc -- --noEmit --pretty false          # 【本次运行已验证】失败：1 个错误（见下）
npm run build                                    # 【本次运行已验证】成功
```

### 10.2 历史缺陷与修复记录（审计看板数据）

`src/audit/tasks.ts` 的 10 张卡（全部 `status:'done'`），`AUDIT_META.principle`：**不改动 `remote/` 原始项目文件，所有修复落在 `src` 覆盖层与新增模块；先修正确性，再做一致性，最后补回归测试**。文件头注释声明：旧交易侧栏及其 hooks 已由 M/W 统一判读取代并从活动代码删除，卡内路径是当时的修复位置，**不是当前模块清单**。

| ID | 标题 | 领域 | 严重度 |
| --- | --- | --- | --- |
| T1 | 生产构建不重建前端 SPA，页面永远是旧包 | 构建 | 严重 |
| T2 | 服务端 PostgreSQL 没有任何表，信号持久化必然失败 | 后端 | 严重 |
| T3 | 两条策略路径口径不一致：趋势屏蔽开关只在一条路上被关闭 | 策略 | 高 |
| T4 | 用户门槛/入场模式在服务端回测不生效，`replaceConfFilter` 是死配置 | 策略 | 高 |
| T5 | 三个"仅实时"订单流因子在主界面恒为无数据 | 订单流 | 高 |
| T6 | 订单流断线后缺口永不回补，delta 静默退回形态近似 | 订单流 | 中 |
| T7 | 保本出场被统计成"超时"，退出原因分布失真 | 策略 | 中 |
| T8 | 引擎面板统计与当前入场模式不一致，"跟随页面"在 Vela 下失效 | 前端 | 中 |
| T9 | 回归验证：把本次修复固化成自动化测试 | 构建 | 中 |
| T10 | 触价挂单被"不存在的确认K"评分，A/B 对照形同虚设 | 策略 | 高 |

这些缺陷对应的现行代码位置：T1 → `package.json:6` 三段式 build + `src/app/route.ts` 的 503 兜底；T2 → `src/db/index.ts:38-50` `ensureServerSchema`；T3 → `src/lib/engine.ts:34-38` 与 `src/quant/scan.ts:392-399` 同口径 `trendBlock:50`；T4 → `src/app/api/backtest/route.ts:56-71`（cookie 还原 + 配置进缓存键）；T5 → `src/vela/useLiveFlow.ts`（**注意：该文件现属孤岛链路**）与 `src/api/engine.ts:99-107`；T6 → `src/quant/flow.ts` 的 `needsRepair`/`shouldRepairFlow`；T7 → `src/quant/scan.ts:525-528` 注释与 `src/quant/stats.ts` 的 `beRate`；T8 → `src/components/confirm/useEngine.ts:62-91,182-185`；T9 → `tests/audit-fixes.test.ts` 等；T10 → `src/quant/scan.ts:125-127` 的 `isTouch` 分支。

#### 10.2.1 旧文档记录的一次性实测快照（2026-11-05，未复核）

以下数据来自旧 `docs/OPTIMIZATION.md` 第 5 节，是**当时的单次只读采样记录**（`.verification/mw-live-*` 已被 gitignore 且本地不存在，无法复核）。它不是代码事实、不是收益证明，也不能当作本次阅读的验证结论；保留它是为了不丢失历史信息。

采样条件【旧文档描述】：2026-11-05 10:16:12–10:16:59 UTC；命令 `node scripts/run-ts-test.mjs scripts/inspect-signals.ts ALL ALL 600 flow`；每组真实 OKX K 线 1,500 根、回看 600 根、历史连续、未用合成行情。

| 市场 | 实际分析根数 | 完整真实覆盖 | M/W 复合记录（含历史事件） | 当时仍在跟踪 | 默认画布事件/线/区带 |
| --- | --- | --- | --- | --- | --- |
| BTC 5m | 600 | 599 | 39 | 5 | 2 / 4 / 2 |
| BTC 15m | 600 | 600 | 27 | 8 | 2 / 4 / 2 |
| ETH 5m | 600 | 599 | 37 | 4 | 2 / 4 / 2 |
| ETH 15m | 600 | 600 | 34 | 7 | 3 / 6 / 2 |
| SOL 5m | 600 | 599 | 48 | 15 | 3 / 6 / 2 |
| SOL 15m | 600 | 598 | 29 | 7 | 3 / 6 / 2 |

同输入前后对照【旧文档描述：以删除前备份的旧代码重放同一份 K 线、成交快照、时钟与回看】：

| 市场 | 原 M/W 及派生证据记录 | 现 M/W 复合记录 | 原默认线条 | 现默认线条 |
| --- | --- | --- | --- | --- |
| BTC 5m | 76 | 39 | 52 | 4 |
| BTC 15m | 62 | 27 | 51 | 4 |
| ETH 5m | 58 | 37 | 42 | 4 |
| ETH 15m | 60 | 34 | 47 | 6 |
| SOL 5m | 82 | 48 | 61 | 6 |
| SOL 15m | 69 | 29 | 52 | 6 |

旧文档对该数据的限定【已迁移，仍须遵守】：六组均无重复记录 ID、扰动形成中价格不改已确认主线结论；"复合记录数"包含较早形态的新生命周期事件，**不能与回看根数相除当作准确率**；线条减少同时包含"默认关闭辅助背景、活跃筛选与归并"的影响，**不是识别准确率或 CPU 提升的证明**；单次分析中位数约 19.6–29.1ms（1,500 根，当时的机器），已收盘数据未变化时跳过历史分析才是实时端的主要节流收益；真实市场诊断只证明这次输入下的运行性与不变量，不证明预测力、胜率或收益。

### 10.3 常见配置错误与运行问题

| 症状 | 根因 | 处置 |
| --- | --- | --- |
| `npm ci` 报 `EUSAGE … can only install packages when your package.json and package-lock.json are in sync`，列出约 30 条 `Missing:` / `Invalid:` | 仓库提交的锁文件与 `package.json` 不同步（缺 `next@16.2.6`、`drizzle-kit@0.31.10`、`dotenv@17.3.1`、`@types/pg`、`eslint` 等；`drizzle-orm`/`pg`/`postcss`/`@types/node`/`@types/react` 版本不匹配） | 用 `npm install`（会同步锁文件）；【本次运行已验证】475 包安装成功 |
| `GET /` 返回 503 纯文本 `PULSEDESK SPA bundle is missing…` | `dist/index.html` 与 `public/index.html` 都不存在 | 跑 `npm run build`（或只前端 `npm run build:spa`） |
| 改了前端但页面还是旧的 | 只跑了 `next build`，没跑 `vite build`（T1） | 必须跑完整 `npm run build` |
| `/api/health` 返回 200 但持久化无效 | 未配置 `DATABASE_URL`，响应带 `fallback:true`；或检查的是浏览器内分发的 PGlite | 用真实 HTTP（curl）检查服务端；配置 `DATABASE_URL` |
| 浏览器控制台报 PGlite 资源加载失败 / 走了 CDN | `public/runtime/` 缺 `pglite.wasm`/`initdb.wasm`/`pglite.data`（仓库未提交，需构建生成），或托管环境裁掉了大体积二进制 | 跑 `node scripts/prepare-runtime.mjs`；`src/db/index.ts:14-27` 会自动回退 jsDelivr 同版本 |
| 快速切币时控制台出现 CORS 错误 | 历史缺陷：被中止的请求误走浏览器上游兜底 | 已修复：`src/runtime/statsProxy.ts` 保持中止、透传 JSON 错误、HTML 回退转 503（`docs/OPTIMIZATION.md` 第 3 节第 10 条 + `tests/realtime-transport.test.ts`） |
| 侧栏长期停在"等待成交流" | 历史缺陷：已 abort 的 in-flight 任务被当作"正在同步"复用 | 已修复：`src/quant/flow.ts:428-431`（`running && !running.signal?.aborted` 才复用） |
| 静态部署下 rubik 统计恒失败、每 30s 空转翻页 | 无同源代理 | `rubikFailedAt` 5 分钟冷却（`src/quant/flow.ts:437`）；真实逐笔 tape 不受影响 |
| 图表价格轴只显示一位小数（如 SOL 93.1） | `getSymbolInfo` 未提供 `mintick` 时 Vela 退回缩放区间公式 | 已修复：`src/vela/okxProvider.ts` 返回 `mintick`/`pricescale`/`minmove` |
| `tsc --noEmit` 失败 | `tests/key-level-call.test.ts:164` 构造的对象缺 `requested`/`gapTruncated`（`SignalAnalysis` 后来新增了这两个字段） | 【本次运行已验证】当前全项目仅此 1 个类型错误；`npm run build` 不受影响（Next 的类型检查未覆盖该测试文件）。修复需改测试文件或删除该孤岛测试 —— 属代码改动，本次未执行 |
| Vela 弹层点击被画布吞掉 | WebGL 画布与 chrome 元素命中冲突 | 已由 `hitFix.ts` + `stackGuard.ts` + portal 化 `marketControls.tsx` 处理 |

### 10.4 文档与代码的冲突记录（必读）

以下是本次逐行阅读发现的**旧文档陈述与本地代码状态不一致**之处。按"以代码解释当前实现，同时保留历史信息"的原则记录。

> 本节引用的 `docs/*`、`README-PULSEDESK.md`、`tests/README.md` 等旧文档均已在本次清理中删除；原文可按 [12.3 末尾的恢复方式](#123-旧文档信息迁移对照表) 取回。此处仅在记录"当时的陈述"，不是当前文件。

| # | 旧文档陈述 | 本地代码实际状态 | 判定 |
| --- | --- | --- | --- |
| 1 | `docs/OPTIMIZATION.md` 第 4 节：已移除 `registerTradePanel.tsx`、`TradePanel.tsx`、`FlowRead.tsx`、`useFlow.ts`、`useLiveFlow.ts`、`useChartBars.ts`、`annotate.ts`、`src/utils/cn.ts`、`keyLevelCall.ts` 及 `analyzeMwPhase`/`analyzeKeyLevelScenario`/`selectScenarios`/`rankScenarioReads` | 前 9 个文件**全部仍存在**于 `src/`；后 4 个函数名在 `src/` 中已检索不到（确已移除） | 文件未删，但**已是孤岛**：`registerTradePanel.tsx` 无任何入向引用，整条链路（`TradePanel`→`FlowRead`/`useFlow`/`useLiveFlow`/`useChartBars`/`vela/annotate`）只被该孤岛内部互相引用；`utils/cn.ts` 无入向引用；`keyLevelCall.ts` 仅被 `tests/key-level-call.test.ts` 引用 |
| 2 | `docs/OPTIMIZATION.md` 第 4 节 / `tests/README.md`：已清理 `tests/flowread.browser.mjs`、旧 `key-level-call.test.ts` 已迁入 M/W 套件 | 两个测试文件都**仍存在** | `flowread.browser.mjs` 测的是已停用侧栏；`key-level-call.test.ts` 仍导入孤岛模块，且是**当前唯一的类型错误来源** |
| 3 | `docs/OPTIMIZATION.md` 第 4 节：已删除 `src/index.css` 中仅给旧交易侧栏/判读卡使用的样式块 | `src/index.css` 现存 192 行，含 `.terminal-root`/`.vela-host`/`.vela-chrome-open`/`.mc-*`（市场控件）/`.ce-*`（确认引擎）等 | 与"保留市场控件、确认引擎和全局壳样式"的说法一致；未发现明显的旧侧栏专用块【合理推断：清理已执行】 |
| 4 | 根 `README.md`（旧）：`npm ci` | 锁文件不同步，`npm ci` 失败 | 已在 [9.3](#93-本地启动步骤) 改为 `npm install` |
| 5 | 根 `README.md`（旧）目录说明：`public/runtime/` 含 prepare-runtime 生成的 wasm/data/js（约 16MB） | 仓库只提交 `public/runtime/pglite.js`（590KB）；wasm/data 需构建生成 | 描述的是**构建后**状态，已在 [9.4](#94-构建产物与部署形态) 澄清 |
| 6 | `src/vela/signals/orderflow-keylevel-research.md` 第 4 节：`runtime.ts` "本地每约 1.2 秒聚合计算"；"当前八类标注"；"没有 `books5`/`books` 更新 feed" | 当前 `runtime.ts` 是 **300ms 前缘节流 + 1.5s 心跳**；当前是 **7 个显示控制**；`src/lib/okx-ws.ts` 与孤岛 `useLiveFlow.ts` 都用了 `books5`/`books` | 该研究笔记是**首版实施规格**，多处已被后续优化取代；其概念区分表与文献结论仍然有效，已迁入 [7.5](#75-三种数据来源的口径边界项目最硬的约定) |
| 7 | `README-PULSEDESK.md`：描述"trade sidebar 的订单流判读卡"、`node tests/flowread.browser.mjs`、导入时的 230 文件/8,124,819 字节校验与"34 项浏览器回归通过" | 交易侧栏已停用；导入校验数据无法在本次阅读中复核（`.mcp-import/`、`.verification/` 均已 gitignore 且不存在） | 该文件是**导入时点的快照说明**，其"Run Locally/Build And Verify"命令仍大体有效（除 `npm ci`）；导入统计属【旧文档描述，未验证】 |
| 8 | `docs/ARCHITECTURE.md` 第 6 节缓存清单：`src/api/engine.ts` 45s、`/api/okx` 15s/300 条等 | 与代码完全一致 | 无冲突（已逐项核对） |
| 9 | `docs/DATABASE.md`：`drizzle.config.json` 连接串为"本地默认" | 一致；但该文件**硬编码**了 `postgres:postgres@127.0.0.1:5432/app_db`，不是从环境变量读取 | 无冲突，但需注意它只服务于 `drizzle-kit push`，运行时读 `DATABASE_URL` |
| 10 | `docs/FRONTEND.md` 第 2 节：构造前注册顺序、`window.__velaWs`、1.6s 符号兜底 | 与 `src/vela/VelaTerminal.tsx` 完全一致 | 无冲突（已逐项核对） |

### 10.5 缺少测试覆盖的关键行为

【代码已确认，基于测试文件的 import 图与 `tests/README.md` 的覆盖描述】

| 关键行为 | 覆盖情况 |
| --- | --- |
| `src/server/okx.ts` 的合成降级（`synthCandles`/`synthTicker`/`synthBook`）与分页并发/退避 | 仅 `audit-fixes.test.ts` 导入 `@/server/okx`；合成数据的确定性未见到针对性断言【尚未确认】 |
| `src/db/index.ts` 双运行时（资源校验、CDN 回退、`ensureServerSchema` 失败重试） | 无 TS 单测导入 `@/db`；仅 `runtime.browser.mjs` 在浏览器里覆盖 PGlite 启动 |
| `src/app/api/*` 路由的参数解析与错误分支（除 okx 白名单被 `flow-markers.test.ts` 覆盖） | `data`/`backtest`/`signals`/`health` 无直接单测 |
| `ConfirmEnginePanel.tsx`（1221 行 UI）与 `IndicatorBrowser.tsx`（1497 行 UI） | 面板无浏览器套件；指标库有 `library.browser.mjs` |
| `src/vela/annotLayer.ts` 的实际 Canvas 绘制 | `annot-layout.test.ts` 只测 `annotLayout.ts` 的纯几何；像素级由 `signal-annotations.browser.mjs` 覆盖 |
| Vela 外壳增强（`hitFix`/`stackGuard`/`toolbarHover`/`toolbarSlide`/`topbarLabels`/`drawing-menu`） | 仅 `drawing-toolbar.browser.mjs` 部分覆盖 |
| 原版页面 `#legacy`（835 行）与 `OKXFeed` 三态降级 | 无针对性测试【代码已确认：无测试文件 import `@/lib/okx-ws`】 |
| 概率模型的**预测力** | 有意不测：`fit.ts`/`optimize.ts` 提供的是自我检验工具，阈值均为工程参数，未做跨市场样本外校准 |

### 10.6 已确认的限制与待验证风险

**已确认的限制**（代码或注释明示）：

1. 只做观察性标注与统计，不下单、不提供校准概率或盈利保证；
2. `buy − sell` 是 taker 主动成交差，不是订单簿 OFI；无止损委托信息，故只称"诱多/诱空候选"；
3. 真实逐笔覆盖门槛硬（85%/95%–110%），历史回补深度有限（BTC 5m 通常仅覆盖最近数根），因此**大多数历史关键位的成交佐证为空**——这是有意的缺数据处理；
4. `FlowBar` 只保存每根聚合总额，`FlowTrade` 不做价位分箱 → 无法还原逐价成交分布（Footprint）；
5. 第一个摆动极值要等右侧 5 根收盘才确认；若第二次测试发生在首摆动右确认之前，逻辑不会回溯重命名（研究笔记第 4 节第 5 条明示这是刻意选择）；
6. 双数据库不同步（服务端 PostgreSQL vs 浏览器会话级 PGlite），刷新即清空后者；
7. 无认证、无多用户隔离；无 CI；无迁移文件（靠幂等 SQL）；
8. 只支持三个 OKX USDT 永续（BTC/ETH/SOL）；订单流只支持 5m/15m/30m/1H/2H/4H（其他周期 `flowSupported=false`）；
9. 阈值全部是工程启发式，独立样本外验证交易效果是另外的任务。

**待验证风险**（本次未执行相应验证）：

| 风险 | 影响 | 建议验证方式 |
| --- | --- | --- |
| `tests/key-level-call.test.ts` 类型错误 | `npm run typecheck` 失败，可能阻断以 typecheck 为门禁的流水线 | `npx tsc --noEmit`（已复现）；修复需改测试或连同孤岛模块一起清理 |
| 孤岛链路（9 个文件 + 1 个测试）是否可安全删除 | 删除可减小体积、消除类型错误；但旧 `docs/OPTIMIZATION.md`（已删除）声称已删，需与作者确认是"应删未删"还是"故意保留" | 引用图核查已完成（本文 1.4 / 10.4）；删除前需确认无动态 import（已检索 `import(` 未发现） |
| 全部 TS 单测与浏览器套件的实际通过状态 | 本文只核对覆盖范围，未执行 | `for t in tests/*.test.ts; do node scripts/run-ts-test.mjs "$t" || exit 1; done`；浏览器套件需先装 chromium 并串行运行 |
| `dotenv`/`lucide-react`/`clsx`/`tailwind-merge` 是否为无用依赖 | 若确为模板遗留可精简 | 全库 import 检索（本次已检索 `src/`、`scripts/`、`tests/`，未发现引用）；需再确认 `remote/` 存档是否引用 |
| 服务端 `serverPool` 无关闭路径 | 进程退出时连接池未显式 `end()`（`pool.end()` 只关 PGlite client） | 代码审阅已确认；影响通常由进程退出兜底 |
| `npm run lint` 结果 | 未知 | `npm run lint`（本次未执行） |

---

## 11. 可视化图示

### 11.1 系统架构（运行时拓扑）

```mermaid
flowchart TB
    subgraph Browser["浏览器（Vite 单文件 SPA）"]
        MAIN["src/main.tsx<br/>createRoot + StrictMode"]
        APP["src/App.tsx<br/>哈希路由 + Shift+C"]
        BOOT["src/runtime/bootstrap.ts<br/>startRuntime(): 包装 window.fetch"]
        VELA["VelaTerminal<br/>@luxalgo/vela VelaWorkspace"]
        PROV["OKXProvider<br/>+ barsHub 镜像 (12k/key)"]
        SIG["signals/runtime.ts<br/>300ms 节流运行器"]
        ANNOT["annotLayer<br/>pd-annot-under / over"]
        PANEL["ConfirmEnginePanel<br/>useEngine"]
        PGLITE["PGlite<br/>memory://pulsedesk-original"]
        MAIN --> APP --> VELA
        APP -.模块级副作用.-> BOOT
        VELA --> PROV
        VELA --> SIG
        SIG --> ANNOT
        APP --> PANEL
        BOOT --> PGLITE
    end

    subgraph Next["Next.js 16（next start :3000）"]
        ROOT["src/app/route.ts<br/>GET / 读 dist/index.html"]
        API["src/app/api/*<br/>health·data·backtest·signals·okx"]
        ENG["src/api/engine.ts<br/>scan handler"]
        DB["src/db/index.ts<br/>pg Pool + ensureServerSchema"]
        SRV["src/server/okx.ts<br/>120s 缓存 + 合成降级"]
        ROOT --> API
        API --> ENG
        API --> DB
        API --> SRV
    end

    subgraph External["外部服务"]
        OKXR["OKX REST<br/>www.okx.com/api/v5"]
        OKXW["OKX WS<br/>ws.okx.com/ws/v5/{business,public}"]
        PG[("PostgreSQL<br/>DATABASE_URL")]
        CDN["jsDelivr CDN<br/>PGlite 0.5.14 回退"]
    end

    PROV -->|"candles / history-candles"| OKXR
    PROV -->|"candle{bar}"| OKXW
    SIG -->|"trades + history-trades"| OKXW
    SIG -->|"rubik（仅经同源代理）"| API
    BOOT -->|"同源 /api/*（除 okx）本地执行"| PGLITE
    BOOT -->|"/api/okx/* 例外：真实 HTTP"| API
    PANEL -->|"/api/engine/scan"| BOOT
    SRV --> OKXR
    ENG --> SRV
    DB --> PG
    PGLITE -.资源不合格时.-> CDN
    ROOT -.dist 缺失回退.-> PUB["public/index.html"]
```

### 11.2 模块依赖（活动代码）

```mermaid
flowchart LR
    subgraph Archive["remote/（存档，禁止修改）"]
        RENG["lib/engine.ts<br/>scanDoubles · DEFAULT_PARAMS<br/>simulate · summarize · atrSeries"]
        RSCHEMA["db/schema.ts"]
        RPAGE["app/page.tsx (#legacy)"]
        RCSS["app/globals.css"]
    end

    subgraph Lib["src/lib"]
        ENG["engine.ts 覆盖层"]
        TYPES["types.ts"]
        CANDLES["candles.ts"]
        VOL["okxVolume.ts"]
        WS["okx-ws.ts"]
    end

    subgraph Quant["src/quant"]
        CFG["config.ts"]
        CTX["context.ts"]
        MODEL["model.ts"]
        SCAN["scan.ts"]
        FLOW["flow.ts"]
        OF["orderflow.ts"]
        SMC["smartmoney.ts"]
        STATS["stats.ts"]
        FIT["fit.ts"]
        OPT["optimize.ts"]
    end

    subgraph Signals["src/vela/signals"]
        PAT["patterns.ts"]
        EV["evidence.ts"]
        SCN["scenario.ts"]
        MW["mwStory.ts"]
        AN["analyze.ts"]
        ST["store.ts"]
        RT["runtime.ts"]
        RC["recompute.ts"]
    end

    subgraph Vela["src/vela"]
        TERM["VelaTerminal.tsx"]
        PROVIDER["okxProvider.ts (barsHub)"]
        ALAYER["annotLayer.ts"]
        ALAYOUT["annotLayout.ts"]
        ATYPES["annotTypes.ts"]
        REGP["registerSignalPanel.tsx"]
    end

    subgraph Http["HTTP / 运行时"]
        ROUTES["src/app/api/*"]
        ENGINEAPI["src/api/engine.ts"]
        SRVOKX["src/server/okx.ts"]
        BOOT2["src/runtime/*"]
        DB["src/db/index.ts"]
    end

    RENG --> ENG & CTX & SCAN & PAT
    RSCHEMA --> DB
    RCSS -->|@import| ENG
    RPAGE -->|#legacy 懒加载| TERM

    ENG --> SCAN & MODEL & CFG & CANDLES
    SCAN --> CTX & MODEL & OF & FLOW
    OF --> CTX
    SMC --> OF & CTX
    CTX --> FLOW
    STATS --> MODEL & SCAN
    FIT --> MODEL & SCAN
    OPT --> SCAN & STATS & FIT

    PAT --> CTX
    EV --> CTX & FLOW
    SCN --> CTX & EV & PAT
    MW --> PAT & EV & SCN & SMC & OF
    AN --> MW & PAT & EV & OF & CTX & ST
    RT --> AN & RC & ST & PROVIDER & FLOW & ALAYER
    REGP --> RT & ST

    ALAYER --> ALAYOUT & ATYPES
    TERM --> PROVIDER & REGP & ALAYER

    ENGINEAPI --> SCAN & MODEL & CFG & FLOW & SRVOKX & CANDLES
    ROUTES --> ENG & SRVOKX & CFG & CANDLES & DB
    BOOT2 --> ROUTES & ENGINEAPI & DB
    PROVIDER --> VOL
    SRVOKX --> VOL & TYPES
```

### 11.3 核心业务时序：从 K 线到一条 M/W 判读

```mermaid
sequenceDiagram
    autonumber
    participant OKX as OKX REST/WS
    participant P as OKXProvider
    participant H as barsHub
    participant R as signals/runtime.ts
    participant K as recompute.ts
    participant A as analyze.ts
    participant PT as patterns.ts
    participant M as mwStory.ts
    participant S as scenario.ts / evidence.ts
    participant PR as projectSignals
    participant L as annotLayer (Canvas)
    participant UI as SignalPanel / MwStoryDetails

    OKX-->>P: candles / history-candles / candle{bar} WS
    P->>H: merge(key, bars)（去重排序，≤12000 根）
    H-->>R: subscribe 回调（key === marketKey）
    R->>K: signalRecomputeKey({已收盘 OHLCV, barMs, preview, forming})
    alt 指纹未变且无 needsScan
        K-->>R: 跳过重算（省 CPU）
    else 指纹变化 / flow 变化 / 偏好变化
        R->>A: analyzeSignals(candles, barMs, prefs, getFlow())
        A->>A: 清洗 → 只留已收盘 → 截断到最新连续段
        A->>PT: scanAnnotationPatterns(ctx)
        PT-->>A: AnnotationPattern[]（first/second/neckIdx/idx）
        A->>M: buildMwStories({patterns, ctx, flow, barMs, livePrice?})
        M->>M: groupMwPatterns（同侧+区间重叠+近价归并）
        loop 每个归并组
            M->>S: readMwEvidence（测试/确认 taker、两腿、CVD、力量计数）
            M->>S: evaluateLine(level) 与 evaluateLine(neck)
            S-->>M: LineRead（状态 + 事件 + 固定观察带）
            M->>M: 按 lastEventIdx 选主线 → 阶段/方向/优先级/目标/陷阱
            M-->>A: SignalItem（六段 sections + timeline + 画布元素）
        end
        A-->>R: SignalAnalysis{items, covered, bars, gapTruncated}
        R->>PR: projectSignals(analysis, prefs, focusId)
        PR-->>R: {payload, visible, counts}（≤3 形态 / ≤2 区带 / ≈ 标记）
        R->>L: rendererPort.setNativeData(ANNOT_UNDER/OVER, payload)
        R->>UI: store.updateRuntime({status, counts, visible, …})
    end
    UI->>R: 点击时间线 onTime(barTs) / 点选历史 focus(id)
    R->>PR: 重新投影（focus 提升 rank，替换一席）
```

### 11.4 核心业务时序：确认引擎扫描（Shift+C）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant AP as App.tsx
    participant CE as ConfirmEnginePanel
    participant UE as useEngine
    participant F as window.fetch（可能被 bootstrap 拦截）
    participant RT as src/api/engine.ts
    participant SV as src/server/okx.ts
    participant FL as src/quant/flow.ts
    participant SC as src/quant/scan.ts
    participant ST as stats/fit/optimize

    U->>AP: Shift + C
    AP->>CE: 懒加载并挂载面板
    CE->>UE: useEngine(open=true)（默认 symbol=ALL, bar=ALL, exitPlan=partial）
    UE->>F: GET /api/engine/scan?symbol=ALL&bar=ALL
    F->>RT: 浏览器内分发或真实 HTTP（同一 handler）
    alt 45s 缓存命中且非 fresh
        RT-->>UE: 缓存响应
    else 需要计算
        loop 每个 timeframe × symbol（串行）
            RT->>SV: getCandles(s, tf, SCAN_BARS)
            SV-->>RT: {live, candles}（120s 缓存 / 失败则合成）
            RT->>RT: closedCandles（严格只用已收盘）
            RT->>SV: fetchBookLive(s,10) → bookImbalance
            RT->>SC: liveFlowOf(candles, bookImb, null)
            alt Node 环境
                RT->>FL: syncFlow(s, tf, {maxPages:4, oiPages:2})
            else 浏览器环境
                RT->>FL: getFlow(s, tf)（复用标注运行器快照）
            end
            RT->>SC: runScan(candles, tf, flow, s, plan, snapshot)
            SC->>SC: buildContext → scanDoubles(trendBlock:50) ×2（confirm/touch）
            SC->>SC: collectEvidence(19 因子) → scoreEvidence → simulateWithPlan ×5
            SC-->>RT: {confirm[], touch[], ctx}
        end
        RT->>RT: 排序 + 各截断 320 条 + wire() 裁剪
        RT-->>UE: {factors, model, config, exitPlans, flow, confirm, touch}
    end
    UE->>ST: summarize/calibration/thresholdSweep/attribution/topKillers/<br/>gradeDistribution/equitySeries/walkForward/optimize/edgeOverBaseline
    ST-->>UE: stats（全部跟随 activePool = 当前入场模式的样本池）
    UE-->>CE: 渲染 14 个 Section
    U->>CE: 调门槛 / 切入场方式 / 应用寻优组合
    CE->>UE: applyConfig → setConfig
    UE->>UE: localStorage + cookie 双写；900ms 后触发 #legacy 页面的重新扫描按钮
```

### 11.5 数据关系图（持久化 + 内存）

```mermaid
erDiagram
    SIGNALS {
        text id PK "回测:{symbol}_{bar}_{ts}_{pattern}_{side} / 实时:前端 id"
        text symbol
        text bar "default 5m"
        bigint bar_ts
        text side "CHECK long|short"
        text pattern "db_reject|dt_reject|db_break|dt_break"
        double entry
        double stop
        double tp
        int confidence "原结构质量 conf"
        int confluence "确认概率百分数"
        text origin "backtest|live"
        text status "skipped|pending|active|won|lost|time"
        double entry_price
        double exit_price
        bigint exit_ts
        double r_multiple
        double pnl_pct
        int holding_bars
        text exit_reason "tp|sl|time（be/gap 归入 time）"
        timestamptz created_at
    }
    BACKTEST_RUNS {
        text id PK "{symbol}_{bar}_{Date.now()}"
        text symbol
        text bar
        int bar_count
        bigint from_ts
        bigint to_ts
        bool live_source
        bool flow_filter
        int signals
        int executed
        double win_rate
        double total_r
        timestamptz at
    }
    BACKTEST_RUNS ||--o{ SIGNALS : "同一次回测批次写入（无外键，靠 symbol/bar/时间关联）"
```

> 说明【代码已确认】：两表之间**没有数据库外键**；关联只在应用层（同一次 `GET /api/backtest` 请求既写 `signals` 分块又写一条 `backtest_runs`）。`signals_unique (symbol,bar,bar_ts,pattern,side)` 是回测 upsert 的冲突目标，`signals_lookup (symbol,bar_ts)` 为普通索引，`runs_symbol (symbol,at)` 为批次索引。

### 11.6 M/W 阶段状态机

```mermaid
stateDiagram-v2
    [*] --> no_break: scanAnnotationPatterns 确认二次测试
    no_break --> break_pending: 关键位/颈线首根收盘越位 > 0.2 ATR
    break_pending --> broken: 连续第二根收盘越位（accepted，观察带固定）
    break_pending --> no_break: 第二根未越位（生命周期不成立）
    broken --> break_weak: 确认量 < 1.2×，或 1.2–1.5× 且成交未同向
    broken --> break_wait: 量 ≥1.5×，或 ≥1.2× 且两根真实 Δ 同向 ≥0.04
    break_wait --> break_retest: 首次触及观察带（触带 ≠ 确认）
    break_retest --> break_held: 收盘守在突破侧 + 回撤 ≤61.8% + 回踩量 ≤0.9×
    break_retest --> break_wait: 未满足质量门槛（仅待确认）
    break_held --> target_reached: 颈线确认后，后续已收盘 K 触达 2×neck−level
    broken --> failed: 收盘回到位内 > 0.2 ATR
    break_wait --> failed: 同上
    break_retest --> failed: 同上
    failed --> sweep_level: 失败的是外侧关键位 → 诱多/诱空候选（12 根内活跃）
    failed --> break_failed: 失败的是颈线 → 反向候选
    broken --> expired: 等待回踩 48 根未到
    break_retest --> expired: 首次触带后超过 12 根观察窗
    no_break --> expired: last − idx > 96（历史二次测试）
    target_reached --> [*]
    expired --> [*]
```

---

## 12. 附录与证据索引

### 12.1 核心文件索引（按重要性）

| 文件 | 行数 | 一句话职责 |
| --- | --- | --- |
| `src/vela/signals/mwStory.ts` | 298 | **M/W 唯一结论出口**：归并、阶段机、六段证据、时间线、目标、画布元素 |
| `src/quant/scan.ts` | 538 | 确认引擎：19 因子证据收集、候选组装、五种出场方案模拟 |
| `src/quant/orderflow.ts` | 983 | 订单流判读：二次测试 / 触顶触底 / 突破回踩 / 摆动关键位 |
| `src/quant/flow.ts` | 549 | 真实订单流数据层：tape WS+REST、rubik 统计、覆盖率硬门槛 |
| `src/quant/model.ts` | 202 | 因子定义、logistic 评分、等级带、期望值 |
| `remote/setup-mcp-project-locally/src/lib/engine.ts` | 914 | 原始几何引擎（存档，禁止修改） |
| `src/lib/engine.ts` | 190 | 覆盖层：用概率门槛替换"是否入场" |
| `src/vela/signals/analyze.ts` | 304 | 分析编排 + 展示投影 |
| `src/vela/okxProvider.ts` | 288 | Vela DataProvider + `barsHub` 镜像 |
| `src/vela/annotLayer.ts` | 541 | 两层 Canvas 标注渲染 |
| `src/vela/signals/runtime.ts` | 232 | 标注运行器（节流、订阅、生命周期） |
| `src/api/engine.ts` | 172 | 引擎扫描 handler（Node/浏览器共用） |
| `src/server/okx.ts` | 276 | 服务端行情层 + 合成降级 |
| `src/db/index.ts` | 165 | 双运行时数据库 |
| `src/runtime/bootstrap.ts` | 61 | 浏览器内 API 分发 |
| `src/quant/fit.ts` | 402 | IRLS 逻辑回归、Walk-Forward、AUC/Brier/Wilson |
| `src/quant/stats.ts` | 256 | 汇总、校准、门槛扫描、归因 |
| `src/quant/optimize.ts` | 146 | 入场×出场×门槛网格 + 样本外双重检验 |
| `src/quant/smartmoney.ts` | 362 | SMC 五项结构观察 |
| `src/components/confirm/useEngine.ts` | 278 | 面板数据/统计编排 |
| `src/components/confirm/ConfirmEnginePanel.tsx` | 1221 | 面板 UI（14 个 Section） |
| `src/vela/library/IndicatorBrowser.tsx` | 1497 | 指标库 UI |
| `src/vela/VelaTerminal.tsx` | 118 | 工作区装配与注册顺序 |
| `src/App.tsx` | 96 | 哈希路由外壳 + Shift+C + 后台启动 |
| `src/app/api/backtest/route.ts` | 152 | 回测 + 落库 |
| `scripts/prepare-runtime.mjs` | 44 | 构建第一段 |
| `scripts/inspect-signals.ts` | — | 真实市场只读诊断（⚠ 该脚本不在当前仓库中，需从上游仓库取回后才能运行） |

### 12.2 阅读覆盖记录

**已完整阅读（逐行）**：

- 全部 6 份 `docs/*.md`（已按 12.3 删除）；旧 `README.md`、`README-PULSEDESK.md`（后者已删除）
- 全部根配置：`package.json`、`vite.config.ts`、`next.config.ts`、`tsconfig.json`、`drizzle.config.json`、`postcss.config.mjs`、`eslint.config.mjs`、`index.html`、`next-env.d.ts`、`.gitignore`
- `src/main.tsx`、`src/App.tsx`、`src/app/route.ts`、`src/app/layout.tsx`、`src/app/globals.css`、全部 6 个 API 路由
- `src/runtime/bootstrap.ts`、`src/runtime/statsProxy.ts`、`src/db/index.ts`、`src/db/schema.ts`、`remote/.../db/schema.ts`
- `src/lib/`：`engine.ts`、`types.ts`、`candles.ts`、`okxVolume.ts`、`format.ts`
- `src/server/okx.ts`、`src/api/engine.ts`
- `src/quant/`：`config.ts`、`context.ts`、`model.ts`、`scan.ts`、`flow.ts`、`orderflow.ts`、`stats.ts`、`fit.ts`、`optimize.ts`
- `src/vela/`：`VelaTerminal.tsx`、`okxProvider.ts`、`annotTypes.ts`、`registerSignalPanel.tsx`
- `src/vela/signals/`：`README.md`、`store.ts`、`recompute.ts`、`patterns.ts`、`evidence.ts`、`scenario.ts`、`runtime.ts`、`analyze.ts`、`mwStory.ts`、`MwStoryDetails.tsx`、`smart-money-research.md`
- `src/components/confirm/useEngine.ts`
- `scripts/`：`prepare-runtime.mjs`、`run-ts-test.mjs`（`inspect-signals.ts` 已不在仓库）
- `tests/README.md`；全部 13 个 `.test.ts` 的 import 图；6 个 `.browser.mjs` 的 `TEST_URL`
- `remote/setup-mcp-project-locally/src/lib/engine.ts` 的常量段、`scanDoubles`、`computeLevels`、`detectAt`、`simulate` 与 `scanSide` 头部

**已阅读相关部分（结构 + 关键片段）**：

- `src/quant/smartmoney.ts`（全部接口 + `readSmartMoney` 主体；`dealingRange`/`findFvgs`/`latestStructure`/`liquidityPool`/`orderBlockCandidate` 仅签名与用途）
- `src/vela/annotLayer.ts`（文件头契约、`Frame` 结构、`registerAnnotLayers` 与两层 render 流程；中段 `renderRail`/`renderEvents`/`renderZones`/`renderCard` 仅函数级）
- `src/vela/annotLayout.ts`、`marketControls.tsx`、`topbarLabels.ts`、`stackGuard.ts`、`toolbarHover.ts`、`toolbarSlide.ts`、`hitFix.ts`、`library/data.ts`、`IndicatorPickerDialog.tsx`、`signals/SignalPanel.tsx`、`lib/drawing-menu.ts`、`lib/indicator-catalog.ts`（导出符号级）
- `src/lib/okx-ws.ts`（类型、`Socket` 头部、`OKXFeed` 状态机与订阅；后半段轮询/合成实现仅结构）
- `src/components/`：`ConfirmEnginePanel.tsx`（Section 标题清单 + 内部组件清单）、`Header`/`VelaChart`/`CommandDeck`/`StatsDrawer`/`Toasts`/`vela/plugins.ts`（导出与常量级）
- `src/audit/tasks.ts`（接口 + 10 张卡的 id/title/area/severity + `AUDIT_META`；各卡的 evidence/rootCause/fix/verify 明细未逐条摘录）、`AuditBoard.tsx`（结构）
- `src/vela/signals/orderflow-keylevel-research.md`（第 1–4 节逐行；第 5–6 节仅目录）
- `remote/setup-mcp-project-locally/src/lib/engine.ts` 的 `scanSide` 主体（240–550）、`computeStats`、`summarize`（752–914）
- `remote/setup-mcp-project-locally/src/app/page.tsx`（import 清单、全部 useState、`fetch` 调用点、`detectAt` 调用点）
- `scripts/mcp_client.py`、`import_project.py`、`complete_import.py`（各文件头部 28 行）
- CSS：`src/index.css`（`@import` 与选择器清单）、四份 vela 专用 CSS（仅确认存在与行数）

**仅发现但未阅读**：

- `src/vela/library/catalog.json`（840KB 单行 JSON）—— 已用 Node 校验形状与计数（`families:17 / indicators:801 / concepts:853`、`source`、`fetchedAt`）与三条样本记录，未逐项阅读
- `public/index.html`（3.5MB 构建产物）、`public/pglite.js`、`public/runtime/pglite.js`（esbuild 产物）
- `package-lock.json`（333KB）—— 仅用于确认与 `package.json` 不同步
- `tests/*.test.ts` 的断言主体（只核对 import 与 `tests/README.md` 描述）
- `remote/setup-mcp-project-locally/src/components/*`（原版组件副本，与 `src/components/` 同名文件字节数一致）

**明确排除及原因**：

| 路径 | 文件数 | 排除原因 |
| --- | --- | --- |
| `node_modules/` | — | 第三方依赖；仅在需要确认 `@electric-sql/pglite/dist/` 是否含 wasm/data 时定向 `ls` |
| `.next/`、`dist/` | — | 构建产物 |
| `reference/`（`run-remote-code-via-mcp` 与 `run-remote-code-via-mcp (1)`） | 90 | 更早两版参考实现的**存档**；`docs/ARCHITECTURE.md` 第 7 节与旧 `README.md` 均声明只存档、不作为活动模块；无 `src/` 代码 import 它们 |
| `remote-project/merge-project-ui-layouts/` | 177 | 导入时的**字节校验快照**（含自己的 `TASKS.md`、`tests/`、`reference/`、`package-lock.json`）；删改会破坏校验完整性 |
| `remote/setup-mcp-project-locally/` 中除 `lib/engine.ts`、`db/schema.ts`、`app/page.tsx`、`app/globals.css` 外的文件 | 19 | 存档副本；只对被 `src/` 实际 import 的 4 个文件做了阅读 |

### 12.3 旧文档信息迁移对照表

> 下表列出的说明类旧文档已在本总文档校验完成后删除（备份与恢复方式见本节末尾）。表中所列"迁入章节"即当前唯一权威说明所在位置；这些旧路径**不再是**任何结论的必要依据。

| 旧文档 | 原有内容 | 迁入本文章节 | 迁移完整性 |
| --- | --- | --- | --- |
| `README.md`（旧根 README，103 行） | 能力一览表、快速开始、验证命令、文档索引、目录说明、口径声明 | 1.1/1.2/1.4、9.1–9.3、10.1、3.1、7.5、10.6 | 完整；`npm ci` 已按实际更正为 `npm install`（10.3） |
| `README-PULSEDESK.md`（57 行） | 英文运行说明、构建与验证命令、导入文件清单与校验统计、订单流判读卡说明 | 9.1、9.3、10.1、3.1、1.4、10.4(#7) | 完整；导入统计与"34 项浏览器回归通过"标为【旧文档描述，未验证】；已停用的交易侧栏部分记入 10.4 |
| `docs/ARCHITECTURE.md`（111 行） | 双构建策略、根路由、两种运行时拓扑、前端分层、数据流表、缓存清单、5 条不可破坏契约、降级策略 | 4.1、8.2(GET /)、8.3、3.2/3.3、7.4、8.7、10.6、9.4/6.13 | 完整；5 条契约分别落在 3.3（不改 remote）、6.2/5.5（只用已收盘 K）、7.5（数据来源显式命名）、6.6/8.2（UI 与服务端同口径）、4.1/10.3（三段式构建） |
| `docs/API.md`（134 行） | 6 个接口的参数/响应/缓存/错误 + 服务端调用的 OKX 上游接口表 | 8.1、8.2、2.5、5.7、6.12 | 完整（含 `tail=1`、`markPx`、`ctVal` 回退、`live:false` 语义、白名单正则、超时与缓存上限） |
| `docs/STRATEGY.md`（164 行） | 两层引擎结构、`scanDoubles` 参数表、19 因子表与评分公式、引擎配置、回测与实时判定、五种出场、订单流数据层、统计/拟合/寻优、持久化、与 M/W 的边界 | 6.1、6.2、6.4、6.5、6.6、5.5、6.8、6.9、6.10、6.11、7.1、1.4 | 完整（19 因子权重表、`DEFAULT_PARAMS` 全量、成本常量、公式、等级带、出场规则均已逐项迁移） |
| `docs/FRONTEND.md`（110 行） | 入口与路由、Vela 构造参数与注册顺序、已清理的旧交易侧栏、OKXProvider、标注运行器、外壳增强表、信号标注、指标库、确认引擎面板 14 板块、原版页面、审计看板、样式体系与配色令牌 | 5.1、4.3、1.4/10.4、6.14、5.2、8.5、5.4、6.14、9.2/3.1 | 完整；配色令牌见 6.14 与 `annotTypes.ts` 的 `TONE_COLOR`（原文数值：底 `#0a0d13`/面板 `#10151f`/边框 `#1d2534`/多 `#2ebd85`/空 `#f6465d`/强调 `#37c8dd`/警告 `#f0b90b`/次要文字 `#8c96ab`；字体 Space Grotesk + IBM Plex Mono） |
| `docs/DATABASE.md`（67 行） | 两张表列定义、索引、服务端运行时、浏览器运行时、写入路径表、环境变量 | 7.1、6.13、4.2/4.3、5.5/5.6、9.2 | 完整（含 wasm 魔数校验、>5MB 且非 HTML 的 data 校验、CDN 回退、`pagehide` 关闭、失败清缓存重试） |
| `docs/OPTIMIZATION.md`（94 行） | 本轮目标与边界、代码落地表、12 条修复/统一内容、已移除的活动代码、六市场真实数据只读复测结果、验证范围与限制 | 6.7、10.4(#1/#2/#3)、10.2/10.2.1、10.6、5.3/6.7.3 | 完整：第 5 节的六市场复测数字与同输入对照表已逐项迁入 [10.2.1](#1021-旧文档记录的一次性实测快照2026-11-05未复核)，并保留旧文档自己的限定（单次采样、不可复核、不证明预测力） |
| `src/vela/signals/README.md`（125 行） | 用户看到什么、7 个显示控制表、实现链路图、形态与归并规则、关键位与颈线两条线、生命周期与工程门槛表、力量与真实成交、诱多/诱空两种形态、实时与历史边界、画布密度、验证与入口 | 6.7.1–6.7.7、5.2、5.3、7.5、10.1 | 完整（含 `pending`/`broken`/`break-weak`/`break-wait`/`touch`/`retest`/`failed`/`expired` 的条件表、0.2 ATR 与 ≤0.9× 的口径修正说明） |
| `src/vela/signals/smart-money-research.md`（75 行） | SMC 五项判据表、与 M/W 的适配位置、与既有标注的关系、权威来源、数据边界、后续可做的验证 | 6.10、7.5（研究出处段）、10.6 | 完整（五项判据的阈值与"明确不声称"列已并入 6.10 与 7.5） |
| `src/vela/signals/orderflow-keylevel-research.md`（298 行） | 结论、订单流概念区分表、7 小节文献审查、常见指标取舍表、当前项目审计、首版实施规格、验收建议 | 7.5（概念区分表 + 研究出处）、10.4(#6)、10.6 | **部分**：概念区分表与文献结论已完整迁移；第 5–6 节"首版实施规格/验收建议"描述的是已被 M/W 统一判读取代的旧实现，本文以 10.4(#6) 记录其过时状态而不复制细节 |
| `src/vela/library/README.md`（27 行） | 结构、行为（发现/全部/分类/概念/内置/搜索/收藏/键盘/响应式）、验证 | 8.5、10.1 | 完整 |
| `tests/README.md`（80 行） | TS 套件运行方式与 13 文件覆盖表、浏览器回归运行方式与 5 文件范围表、真实市场诊断、必需构建检查 | 10.1（三张表全部迁移并补充实际 import 核对结果） | 完整 |
| `remote-project/merge-project-ui-layouts/TASKS.md`（24 行） | 导入期任务卡：指标库搜索框重做 + 币种收敛为 3 项 + 内嵌 SVG 图标 + 浏览器验收 | 6.14（`marketControls`/图标内联）、5.1（`resolveSymbolIcon`）、8.5 | 完整；该文件位于**字节校验快照**内，属存档不删 |

**未迁移的信息（如需保留请单独说明）**：

1. `README-PULSEDESK.md` 的导入统计（230 个文件 / 8,124,819 字节 / 34 项浏览器回归通过）—— `.mcp-import/` 已 gitignore 且不存在；
2. `orderflow-keylevel-research.md` 第 5–6 节的首版实施规格细节 —— 已被现行 M/W 实现取代；
3. `src/audit/tasks.ts` 中 10 张卡的 `evidence`/`rootCause`/`fix`/`verify` 明细文本 —— 该文件是**运行时代码**（`#audit` 看板数据源），不属于文档清理范围，明细仍可在页面查看。

**旧文档恢复方式（本次清理时建立）**：

1. 删除前已把 10 个文件原样备份到**项目目录之外**（含 SHA256 校验清单），并在删除前逐一 `sha256sum -c` 校验通过；备份路径为本次执行环境中的 `/tmp/pulsedesk-old-docs-backup-<时间戳>/`（临时目录可能被环境清理，持久恢复请用第 2 条）。
2. 这些文件同时存在于上游仓库 `https://github.com/wternum/remote` 的 `deploy-remote-mcp-project/` 目录；删除前已逐一验证 10 个文件的 raw 地址均返回 HTTP 200。恢复示例：

```sh
git clone https://github.com/wternum/remote.git /tmp/remote-repo
cp /tmp/remote-repo/deploy-remote-mcp-project/docs/ARCHITECTURE.md ./docs/   # 其他文件同理
```

3. 保留未删的研究笔记（`src/vela/signals/orderflow-keylevel-research.md`、`smart-money-research.md`）中指向旧模块说明的相对链接，已改指向本总文档。

### 12.4 未确认的问题及其影响

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | `dotenv`、`lucide-react`、`clsx`、`tailwind-merge` 在 `src/`、`scripts/`、`tests/` 中均未检索到 import | 可能是模板遗留依赖；不影响运行 | 若要精简需先确认 `remote/` 存档是否引用（存档不应改动，故建议保留） |
| 2 | `src/app/layout.tsx` 的 `metadata.title` 仍是模板值 `"Arena Next.js PostgreSQL Starter"` | 用户看不到（根路由直接返回 SPA HTML，不经 layout 渲染）；但 Next 的 `/_not-found` 会用它 | 可选修正，属代码改动 |
| 3 | `package.json` 的 `name` 仍是 `"nextjs-postgresql-template"` | 无功能影响 | 可选修正 |
| 4 | `tests/key-level-call.test.ts` 的 1 个类型错误 | `npm run typecheck` 失败 | 与孤岛模块一并处理（删除或修测试） |
| 5 | `src/db/index.ts` 浏览器分支的 `initialization` Promise 失败时不清缓存（服务端分支会清） | PGlite 首次初始化失败后，同一页面生命周期内不会重试（需刷新） | 【合理推断】影响有限，因失败通常源于资源缺失；如需改进属代码改动 |
| 6 | `serverPool` 无显式关闭路径（`pool.end()` 只关 PGlite client） | 进程退出时由 Node 兜底 | 无需处理，记录备查 |
| 7 | `docs/OPTIMIZATION.md` 声称已删除的 9 个文件仍在仓库 | 体积与理解成本；且其中 1 个测试是当前唯一类型错误来源 | 见第 5 章清理建议（需作者确认） |
| 8 | 全部 TS 单测与浏览器套件的实际通过状态未验证 | 本文只保证"覆盖范围"描述准确，不保证"测试通过" | 按 10.1 命令执行 |
| 9 | `remote/` 存档中 `src/components/*` 与 `src/components/*` 同名文件字节数一致（如 `CommandDeck.tsx` 均为 29539 字节） | 说明 `src/components/` 是存档的直接副本，未再修改 | 无需处理 |

### 12.5 敏感信息处理

本文档不含任何密钥、令牌、密码或真实连接凭据：

- `DATABASE_URL` 一律写作 `postgresql://<user>:<password>@<host>:<port>/<db>` 占位符；
- `drizzle.config.json` 中的 `postgres:postgres@127.0.0.1:5432/app_db` 是仓库内**已存在的本地开发默认值**（非真实凭据），在 9.2 中作为配置项说明而非推荐值；
- `MCP_URL_BASE64` 只说明其用途与读取位置，不含任何实际值；仓库内也不存在 `.mcp-import/endpoint.base64`（已 gitignore）。

---

**文档结束。** 本章之前的全部内容均由对本地代码库的直接阅读得出；凡标注【旧文档描述】【合理推断】【尚未确认】处，均未在代码中取得直接证据，请勿当作已验证事实使用。




