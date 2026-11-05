# API 参考

全部接口位于 `src/app/api/`，均声明 `dynamic = 'force-dynamic'`。SPA初始化后（包括由Next托管时），除统计代理外，同一批 handler 由 `src/runtime/bootstrap.ts` 在浏览器内分发执行，请求/响应格式一致（见 `docs/ARCHITECTURE.md` 第 3 节）。

约定：`symbol` 为 OKX 永续合约 ID（如 `BTC-USDT-SWAP`）；`bar` 为 K 线周期（服务端行情层用 `5m`/`15m` 等 OKX 代号）；所有时间戳为毫秒。

## GET /api/health

健康检查。先 `await initializeDatabase()` 等服务端建表完成，再 `select 1`。

| 情况 | HTTP | 响应 |
| --- | --- | --- |
| 数据库可用 | 200 | `{"status":"ok","ok":true}` |
| 数据库不可用（降级） | 200 | `{"status":"ok","ok":true,"fallback":true}` |

注意：失败也返回200，必须检查 `fallback` 才能判断数据库是否降级。浏览器内fetch可能被本地PGlite分发拦截；检查服务端应使用真实HTTP请求。

## GET /api/data

行情聚合：K 线 + 实时盘面信息。数据层为 `src/server/okx.ts`（120s 缓存，尾部用最新 20 根覆盖合并）。

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `symbol` | `BTC-USDT-SWAP` | 合约 ID |
| `bar` | `5m` | K 线周期 |
| `tail=1` | — | 轻量轮询模式：只取最新 3 根 K 线 + 5 档盘口 |

普通模式响应：

```json
{
  "live": true,
  "symbol": "BTC-USDT-SWAP",
  "bar": "5m",
  "candles": [{ "ts": 0, "o": 0, "h": 0, "l": 0, "c": 0, "v": 0 }],
  "ticker": { "last": 0, "open24": 0, "high24": 0, "low24": 0, "chg24": 0,
              "fundingRate": 0, "nextFundingTime": 0, "markPx": 0, "ctVal": 0.01 },
  "book": { "bids": [{ "p": 0, "s": 0 }], "asks": [] },
  "serverTime": 0
}
```

- `candles[].v` 为报价币成交额（USDT 口径，由 `quoteVolumeFromRow` 折算），最多 600 根；
- `markPx` 为盘口中间价（买一/卖一均值）；`ctVal` 优先取 OKX 合约信息，缺失时用 `src/lib/types.ts` 的内置表（BTC 0.01 / ETH 0.1 / SOL 1）；
- OKX 不可达时 `live: false`，K 线/ticker/盘口全部来自确定性合成数据（`synthCandles` 等），调用方必须按 `live` 区分；
- `tail=1` 失败时返回 `{live:false, candles:[], book:null, serverTime}`，供浏览器 WS 不可达时轮询兜底。

## GET /api/backtest

双顶/双底回测。逐币种拉取 K 线（5m 取 8640 根 ≈ 30 天，15m 取 4320 根 ≈ 45 天），经 `closedCandles` 只保留已收盘 K 线后运行 `src/lib/engine.ts` 的 `simulate`，再 `summarize` 汇总，并尽力持久化（失败不影响返回）。

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `symbol` | `BTC-USDT-SWAP` | `ALL` = 全部三个币种（`SYMBOLS`） |
| `bar` | `5m` | `5m` / `15m` |
| `flow=on` | 关 | 订单流过滤：开启时概率门槛 +0.05（上限 0.9） |
| `fresh=1` | — | 绕过 180s 缓存 |
| `threshold` | cookie 值 | 概率门槛，`clampThreshold` 限制在 0.42–0.82 |
| `mode` | cookie 值 | `touch`（触价）/ `confirm`（确认K） |
| `replaceConf` | cookie 值 | `0` 时保留原结构质量过滤 `CONF_MIN = 60` |

UI 配置经 cookie `pulsedesk.confirm-engine`（`{t, m, r}`）传入，query 优先于 cookie。缓存键包含全部生效配置。

响应为 `BacktestResult`（`src/lib/types.ts`）：`live`、`scope`（single/all）、`symbol`、`bar`、`from`、`to`、`bars`、`generatedAt`、`params`（`feeBps`/`slipBps`/`maxHold`/`flowFilter`/`confMin`/`riskUsd`）、`overall`、`bySide`、`byPattern`、`bySymbol` 与逐笔记录；并回显本次实际生效的 `engine: {threshold, entryMode, replaceConfFilter}` 便于核对口径。

持久化：已平仓或 `skipped` 的记录以 300 条分块写入 `signals` 表（`origin='backtest'`，状态映射 `skipped` / `won` / `lost`，按唯一索引 `(symbol,bar,bar_ts,pattern,side)` 冲突更新），批次元数据写入 `backtest_runs`（冲突忽略）。

## POST /api/signals

写入/更新一条实时信号（`origin='live'`，按 `id` 主键冲突更新状态与出场字段，仅更新非空入场价）。

请求体（JSON）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id`, `symbol` | 是 | 缺失返回 400 `{"error":"missing fields"}` |
| `bar`（默认 `5m`）、`barTs`、`side`（long/short）、`pattern` | — | 形态与周期 |
| `entry`, `stop`, `tp` | — | 计划入场/止损/目标 |
| `confidence`, `confluence` | 默认 0 | 原结构质量分 / 确认概率（百分数） |
| `status` | 默认 `pending` | pending/active/won/lost/time 等 |
| `entryPrice`, `exitPrice`, `exitTs`, `rMultiple`, `pnlPct`, `holdingBars`, `exitReason` | 可空 | 实际成交与结果 |

响应：成功 200 `{"ok":true}`；异常 500 `{"ok":false}`（服务端打 `console.warn`）。

## GET /api/engine/scan

入场确认引擎扫描（handler 在 `src/api/engine.ts`，路由仅转发）。逐币种/逐周期运行 `runScan`，同时产出 `confirm`（确认K入场）与 `touch`（触价挂单）两组候选，五种出场方案的结果随候选一起算好，面板切换无需重请求。

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `symbol` | `BTC-USDT-SWAP` | `ALL` = 三个币种 |
| `bar` | `5m` | `ALL` = `5m` + `15m` 双周期 |
| `exit` | `neck` | 出场方案：`neck` / `r15` / `r10` / `be` / `partial`，非法值回退 `neck` |
| `fresh=1` | — | 绕过 45s 缓存 |

行为细节：

- 每组取 `SCAN_BARS`（5m 8640 / 15m 4320）根并 `closedCandles`；
- 实时盘口（10 档）失衡与确认K量比组成 `liveFlowOf`；降级（合成）行情不携带上一币种的盘口值；
- 服务端用 `syncFlow` 拉 rubik taker/OI（`maxPages: 4, oiPages: 2` 有界分页）；浏览器端复用标注运行器已维护的快照，不另起 tape；
- 响应含 `factors`（19 个因子的 key/label/short/hint/group/weight/liveOnly）、`model`（base/gain）、`config`（当前引擎配置）、`exitPlans`、`flow`，以及 `confirm`/`touch`（各截断最近 320 条；`parts` 出网省略，可由 evidence × weight × gain 还原；`trap`/`trapScore`/`flowSource`/`headline` 等来源字段保留）。

## GET /api/okx/{path...}

OKX rubik 统计的同源代理（rubik 接口无 CORS）。**严格白名单**：

- 路径仅允许 `api/v5/rubik/stat/taker-volume-contract` 与 `api/v5/rubik/stat/contracts/open-interest-history`，其余返回 404 `{"code":"404","msg":"not allowed","data":[]}`；
- 参数仅允许 `instId`、`period`、`unit`、`end`、`begin`、`limit`，且值须匹配 `^[A-Za-z0-9-]{1,40}$`；
- 上游超时 6s；成功响应缓存 15s（至多 300 条，FIFO 淘汰）；上游 HTTP 错误透传状态与原文；网络异常返回 502 `{"code":"502","msg":"upstream unavailable","data":[]}`。

浏览器统计请求只走真实同源后端；JSON错误透传、取消原样中止。静态Vite返回HTML时改为明确503，网络失败为502，不再回退浏览器直连无CORS的rubik；逐笔tape不依赖此代理。

## GET /（根路由）

见 `docs/ARCHITECTURE.md` 第 2 节：返回 Vite 构建的单文件 SPA（`dist/index.html`，回退 `public/index.html`），缺失时 503 文本提示。

## 服务端调用的 OKX 上游接口（`src/server/okx.ts`）

| 接口 | 用途 | 备注 |
| --- | --- | --- |
| `/api/v5/market/candles` | 最新 K 线（≤300） | 3s 超时 |
| `/api/v5/market/history-candles` | 历史分页 | 4 次重试，退避 300ms×(t+1)；每批 8 并发、批间 250ms 防限频 |
| `/api/v5/market/ticker` | 24h 行情 | `volCcy24h × last` ≈ USDT 成交额 |
| `/api/v5/public/funding-rate` | 资金费率 | — |
| `/api/v5/public/instruments` | 合约面值/最小价位 | instType=SWAP |
| `/api/v5/market/books` | 盘口（默认 10 档） | — |

浏览器图表侧（`src/vela/okxProvider.ts`）直连同一组 REST 接口（429 时重试，不把限频当空页），实时走 `wss://ws.okx.com/ws/v5/business` 的 `candle{bar}` 频道；逐笔走 `trades`/`history-trades`，盘口走 `wss://ws.okx.com/ws/v5/public` 的 `books5` 频道。
