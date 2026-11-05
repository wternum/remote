# 架构与构建策略

本文描述 PULSEDESK 当前的运行拓扑、构建链路与模块分层。所有内容以仓库现有代码为准（`package.json`、`vite.config.ts`、`src/app/route.ts`、`src/runtime/bootstrap.ts`、`src/db/index.ts` 等）。

## 1. 总体形态：Vite SPA + Next.js API 的双构建

项目同时使用两个构建器，职责严格分离：

| 构建器 | 产物 | 职责 |
| --- | --- | --- |
| Vite 7（`vite.config.ts`） | `dist/index.html`（单文件，约 3.5MB，gzip 约 1MB） | 构建全部前端：React 入口 `src/main.tsx` → `src/App.tsx`，经 `vite-plugin-singlefile` 把 JS/CSS 全部内联 |
| Next.js 16（App Router，Turbopack） | `.next/` 服务端构建 | 托管页面入口与 `/api/*` 路由（`src/app/`），不渲染任何页面组件 |

`package.json` 的脚本定义了完整链路：

```sh
npm run build   # node scripts/prepare-runtime.mjs && vite build && next build
```

三个阶段缺一不可：

1. **prepare-runtime**（`scripts/prepare-runtime.mjs`）：用 esbuild 把 `@electric-sql/pglite` 与 `drizzle-orm/pglite` 打成浏览器 ESM `public/runtime/pglite.js`（插件剔除 PGlite 浏览器图里未使用的 Node fs/path 模块），并把 `pglite.wasm`（约 8.7MB）、`initdb.wasm`、`pglite.data`（约 6MB）复制到 `public/runtime/`。浏览器端 PostgreSQL 的二进制资源因此本地化，不依赖 CDN 才能启动。
2. **vite build**：生成 `dist/index.html`。只改前端代码而不重跑这一步，页面必然是旧包——这是历史上出现过并已修复的缺陷（见 `src/audit/tasks.ts` 的 T1 任务卡）。
3. **next build**：构建 API 路由与根路由。

其余脚本：`dev` = Vite 开发服务器（默认 5173）；`dev:next` / `build:next` = 只跑 Next；`build:spa` = prepare-runtime + vite build；`preview` = `vite preview`（默认 4173）；`start` = `next start`（默认 3000）；`test:quant` = 三个量化单测串跑；`typecheck` = `tsc --noEmit`；`lint` = `eslint .`。

构建时有一条已知无害警告：Turbopack 的 NFT tracing 会提示 `src/app/route.ts` 中存在 `path.join(process.cwd(), ...)` 的文件读取（根路由需要按路径读构建产物），不影响产物。

## 2. 页面如何被服务：`src/app/route.ts`

Next 的根路由 `GET /` 不做 SSR，而是按顺序读文件返回 HTML：

1. `process.cwd()/dist/index.html`（Vite 产物）；
2. `public/index.html`（仓库内预置的一份构建产物，dist 缺失时回退）；
3. 两者都不存在 → HTTP 503 纯文本提示运行 `npm run build`。

路由声明 `dynamic = 'force-dynamic'`，响应带 `cache-control: no-cache, no-store, must-revalidate`，保证每次拿到最新构建。项目没有 `src/app/page.tsx`，这是刻意设计：页面完全由 SPA 承担，Next 只做 API 与静态托管。

## 3. 两种运行时拓扑

### 3.1 真实HTTP与浏览器内分发不是同一条路径

直接HTTP请求（例如curl调用Next的 `/api/backtest`）执行服务端路由，数据库走 `DATABASE_URL` 的PostgreSQL。

SPA加载后始终后台运行 `startRuntime()`。浏览器运行时初始化完成后，会拦截同源 `/api/data`、`/api/backtest`、`/api/signals`、`/api/health`、`/api/engine/scan`，调用同一套活动handler，数据库走会话PGlite。**即使页面由Next托管也会这样做**；它没有“发现Next就关闭本地分发”的分支。初始化前发出的请求仍可能走真实HTTP。两种数据库不同步，不能把浏览器内health结果当服务端数据库检查。

### 3.2 统计代理例外

`/api/okx/*` 始终尝试真实同源后端，由 `statsProxy.ts` 保留JSON成功或错误响应。取消请求原样中止；静态Vite的HTML回退返回明确503，网络失败返回502，不在浏览器里再调用无CORS的OKX上游。逐笔WS独立连接，官方统计不可用时如实显示覆盖不足。

## 4. 前端分层

```
src/main.tsx          React 入口（挂载 App，引入 index.css 与三份 vela 外壳样式）
src/App.tsx           哈希路由外壳：#/（工作区）· #legacy（原版页面）· #audit（审计看板）
                      + Shift+C 开合确认引擎面板 + 后台 startRuntime()
src/vela/             Vela 工作区集成层（当前主界面）
src/components/       原版页面组件（Header/VelaChart/CommandDeck/StatsDrawer/Toasts）
                      + confirm/ 确认引擎面板
src/quant/            量化内核（模型/扫描/订单流/统计/拟合/寻优/配置）
src/lib/              引擎覆盖层、OKX WS feed、类型、格式化、绘图菜单
src/server/okx.ts     服务端 OKX 行情层（REST + 缓存 + 合成降级）
src/api/engine.ts     确认引擎扫描 handler（被 app/api/engine/scan 复用）
src/app/api/          Next 路由（data/backtest/signals/health/engine/okx 代理）
src/db/               双运行时数据库（schema 从 remote 再导出）
src/audit/            缺陷修复任务卡看板（#audit）
```

依赖关系的关键点：

- `src/lib/engine.ts`、`src/db/schema.ts`、`src/index.css` 都从 `remote/setup-mcp-project-locally/` 再导出原始实现，再在 `src/` 侧叠加覆盖，**不修改远程源文件**（见第 7 节）。
- Vela 工作区构造前一次性注册语言包、指标选择器、市场控件、信号侧栏与标注图层（`VelaTerminal.tsx`）；标注图层必须先于 `new VelaWorkspace` 注册，因为渲染器在构造时按注册表实例化图层。
- `src/vela/okxProvider.ts` 维护 `barsHub` K 线镜像：provider 是图表唯一数据源，信号标注、订单流判读都读同一份镜像，保证“图上所见即标注所据”。

## 5. 数据流

| 数据 | 来源 | 通路 | 消费方 |
| --- | --- | --- | --- |
| 图表 K 线 | OKX REST + `wss://ws.okx.com/ws/v5/business` 的 `candle{bar}` 频道 | `OKXProvider` → `barsHub`（每 key 上限 12,000 根） | Vela 图表、信号标注 `runtime.ts` |
| 逐笔主动成交 | OKX `trades` WS + `history-trades` REST 回补 | `src/quant/flow.ts` tape 聚合（约 250ms 发布快照） | M/W证据、标注运行器、确认引擎（浏览器侧复用快照） |
| 逐根 taker/OI 统计 | OKX rubik（无 CORS） | Next `/api/okx` 代理或浏览器 `localStorage['pulsedesk.okx-proxy']` 基址 | `flow.ts` 的 `syncFlow` |
| 行情聚合 | OKX REST（服务端） | `src/server/okx.ts`（120s 缓存）→ `/api/data`、`/api/backtest`、`/api/engine/scan` | 原版页面 `#legacy`、回测、确认引擎面板 |
| 盘口 | 原版页面的OKXFeed与引擎扫描REST | `src/lib/okx-ws.ts` / `src/server/okx.ts` | 既有原版/确认引擎功能；M/W主线不声称实现OFI |
| 持久化 | PostgreSQL / PGlite | `/api/backtest` 写入回测与信号、`/api/signals` 写入实时信号 | 统计与复盘 |

## 6. 缓存清单

| 位置 | TTL / 上限 | 说明 |
| --- | --- | --- |
| `src/server/okx.ts` `getCandles` | 120s | key = symbol\|bar\|count；`/api/data` 另用最新 20 根尾部覆盖合并 |
| `/api/backtest` | 180s | key 含 symbol/bar/flow 与引擎配置（门槛/入场方式/替换过滤），`fresh=1` 绕过 |
| `src/api/engine.ts` | 45s | key = symbol\|bar\|exit plan，`fresh=1` 绕过；confirm/touch 各截断最近 320 条出网 |
| `/api/okx/[...path]` | 15s，至多 300 条 | FIFO 淘汰最旧条目 |
| `barsHub` | 每 key 12,000 根 | 图表 K 线镜像 |
| 浏览器 localStorage | 长期 | `pulsedesk-vela-workspace`（工作区布局）、`pulsedesk.confirm-engine.v1`（引擎配置）、`pulsedesk.signal-annotations.v2`（标注偏好）、`vela-indicator-library-favorites-v1`（指标收藏） |

## 7. 不可破坏的契约

1. **不修改 `remote/`、`reference/`、`remote-project/`**：三者包含导入时的原始代码/参考存档。一切改造走 `src/` 覆盖层（如 `src/lib/engine.ts` 的 `export *` + 覆写 `simulate`/`detectAt`）。
2. **只用已收盘 K 线**：`src/lib/candles.ts` 的 `closedCandles()` 在 HTTP 边界与 `simulate()` 内各执行一次；任何识别/回测不得使用未收盘 K 线或未来数据。
3. **数据来源必须显式命名**：真实逐笔（逐笔聚合覆盖该 K 线成交额 85%–110%，rubik 口径 95%–110%）、rubik 官方统计、K 线近似（界面标 `≈`）三者不得混用；缺失记为缺失，不推断为买卖平衡。`buy − sell` 是 taker 主动成交差，不是订单簿 OFI。
4. **UI 与服务端同口径**：确认引擎配置同时写 localStorage 与 cookie `pulsedesk.confirm-engine`，服务端 `/api/backtest` 用 `configFromCookie` 还原，且配置必须进入缓存键。
5. **构建三段式不可省**：改前端后必须跑完整 `npm run build`；根路由在产物缺失时返回 503 而不是空页面。

## 8. 降级策略

- OKX 不可达：`src/server/okx.ts` 降级为确定性合成行情（按 symbol|bar|自然日做种子的伪随机游走），响应 `live: false` 明示；浏览器直连失败时图表/判读显示无数据而不是伪造数值。
- PGlite 运行时缺失：`src/db/index.ts` 校验 wasm 魔数与 data 体积（>5MB 且非 HTML），本地不合格时回退 jsdelivr 上同版本（0.5.14）资源；都失败则持久化不可用，但图表不受影响。
- 数据库不可用：`/api/health` 仍返回 200 且带 `fallback: true`；回测/信号持久化失败只打 `console.warn`，不影响行情与回测结果返回。
- 静态模式无后端：`bootstrap.ts` 在浏览器内执行本地handler，统计代理例外（见第3节）。
