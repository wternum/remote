# 数据库

项目用同一份表结构在两种运行时落地：Next 服务端连真实 PostgreSQL，SPA本地分发用 PGlite（PostgreSQL 的 WASM 版）在内存中运行。Schema 定义在 `remote/setup-mcp-project-locally/src/db/schema.ts`（原始文件），由 `src/db/schema.ts` 一行再导出；运行时实现在 `src/db/index.ts`。

## 1. 表结构

两张表，建表 SQL（`migrations` 常量）与 Drizzle schema 保持一致，均为幂等 `CREATE TABLE IF NOT EXISTS`。

### signals（信号主表）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | 回测：`{symbol}_{bar}_{ts}_{pattern}_{side}`；实时：前端生成的信号 id |
| `symbol` | text | 合约 ID，如 `BTC-USDT-SWAP` |
| `bar` | text，默认 `5m` | 周期 |
| `bar_ts` | bigint | 信号 K 线时间（ms） |
| `side` | text（long/short） | 方向 |
| `pattern` | text | 形态 ID（db_reject/dt_reject/db_break/dt_break 等） |
| `entry` / `stop` / `tp` | double | 计划入场/止损/目标 |
| `confidence` | int，默认 0 | 原结构质量分（conf） |
| `confluence` | int，默认 0 | 确认概率百分数（覆盖层写入） |
| `origin` | text（backtest/live），默认 backtest | 来源 |
| `status` | text，默认 active | skipped/pending/active/won/lost/time |
| `entry_price` / `exit_price` | double，可空 | 实际成交价 |
| `exit_ts` | bigint，可空 | 出场时间 |
| `r_multiple` / `pnl_pct` | double，可空 | R 倍数 / 涨跌幅 |
| `holding_bars` | int，可空 | 持仓根数 |
| `exit_reason` | text，可空 | tp/sl/time（be/gap 归入 time，真实原因在应用层 `exitWhy`） |
| `created_at` | timestamptz，默认 now() | |

索引：唯一索引 `signals_unique (symbol, bar, bar_ts, pattern, side)`（回测 upsert 的冲突目标）；普通索引 `signals_lookup (symbol, bar_ts)`。

### backtest_runs（回测批次）

`id`（`{symbol}_{bar}_{时间戳}`）、`symbol`、`bar`、`bar_count`、`from_ts`、`to_ts`、`live_source`（是否真实行情）、`flow_filter`、`signals`、`executed`、`win_rate`、`total_r`、`at`（默认 now()）；索引 `runs_symbol (symbol, at)`。

## 2. 服务端运行时（Next）

- 连接：`process.env.DATABASE_URL`（见 `.env`），用 `pg` Pool + `drizzle-orm/node-postgres` 懒加载（`getDatabase()` 首次访问时建立）；
- 建表：连接建立即启动 `ensureServerSchema()` 执行同一份幂等 SQL；Promise 缓存，**失败时清空缓存允许下次请求重试**（不永久缓存 rejected Promise）；
- `/api/health`、`/api/backtest`、`/api/signals` 都会 `await initializeDatabase()` 等待就绪后再写/查；
- 无 `DATABASE_URL` 时静默降级：`db` 代理抛错，各路由按自身容错处理（health 回 `fallback: true`，回测只放弃持久化）；
- 命令行建表（可选，与运行时等价）：`npx drizzle-kit push`（读 `drizzle.config.json`，其中连接串为本地默认 `postgresql://postgres:postgres@127.0.0.1:5432/app_db`）。

## 3. 浏览器运行时（静态模式）

- `initializeDatabase()` 在浏览器端动态加载 `public/runtime/pglite.js`（由 `scripts/prepare-runtime.mjs` 用 esbuild 打包 `@electric-sql/pglite` + `drizzle-orm/pglite`，构建时生成），同时并行拉取 `pglite.wasm`、`initdb.wasm`、`pglite.data`；
- 资源校验后才使用：wasm 校验魔数 `\0asm`，data 要求 >5MB 且首字节非 `<`（防止 SPA 回退把 index.html 当资源）；本地不合格则回退 jsdelivr 同版本（0.5.14）CDN，两处都失败才报错；
- 实例为 `PGlite.create('memory://pulsedesk-original')`：**会话级内存库，刷新/关页即清空**，与服务端库互不同步；启动后执行同一份建表 SQL，`pagehide` 时关闭；
- 浏览器运行时完成初始化后的本地API分发写PGlite（即使由Next托管）；直接请求Next API则写PostgreSQL。初始化前请求可能走真实HTTP。两种落点不自动同步，见 `docs/ARCHITECTURE.md` 第3节。

## 4. 写入路径

| 路径 | 触发 | 方式 |
| --- | --- | --- |
| 回测落库 | `GET /api/backtest` 计算后 | 只写已平仓或 skipped 的记录，300 条分块批量 insert；按唯一索引冲突更新全部结果字段；批次写 `backtest_runs`（冲突忽略）；整体失败仅 `console.warn` |
| 实时信号 | `POST /api/signals` | 按 `id` 主键 upsert：更新 status 与出场字段，`entry_price` 仅在新值非空时覆盖（`coalesce`） |
| 健康探测 | `GET /api/health` | 等待建表完成后 `select 1` |

## 5. 环境变量

| 变量 | 用途 | 必需 |
| --- | --- | --- |
| `DATABASE_URL` | 服务端 PostgreSQL 连接串（`src/db/index.ts`、`drizzle.config.json` 之外由 `.env` 提供） | Next 模式持久化需要；缺失即降级 |
| `MCP_URL_BASE64` | 仅 `scripts/mcp_client.py` 等导入工具使用，Web 应用不读 | 否（且不写进前端代码） |

OKX 全部为公共行情接口，无需 API Key；实时行情需要能访问 `www.okx.com` 与 `ws.okx.com`。
