# PULSEDESK · OKX 短线信号终端

PULSEDESK 是一个中文加密货币短线工作台：以 OKX 永续合约（BTC/ETH/SOL）5m/15m K 线为数据源，在 LuxAlgo Vela 图表工作区上提供双顶/双底形态识别、真实主动成交（taker）订单流证据、入场确认概率模型、回测与样本外分析。本文档集描述**当前代码实际实现**的内容；策略阈值均为工程参数，未做跨市场样本外校准，不构成交易建议。

## 当前实现一览

| 能力 | 入口 | 实现 |
| --- | --- | --- |
| Vela 图表工作区 | `/` | `@luxalgo/vela` 工作区 + 自研 OKX DataProvider（REST 历史 + WebSocket 实时），中文界面，深色主题 |
| 指标库 | 顶栏「指标」 | LuxAlgo library 快照 801 个指标 / 853 个概念 / 17 分类，搜索、收藏、分类/概念浏览、原生指标一键添加 |
| 信号标注侧栏 | 右侧「信号标注」 | 以双顶/双底为主线：一形态一记录、六段证据、突破回踩时间线；7个显示控制，真实/近似严格分开；细则见 `src/vela/signals/README.md` |
| 入场确认引擎 | `Shift + C` | 19 因子证据模型 → 概率/等级；校准、门槛扫描、配置寻优、Walk-Forward 样本外验证、逐单归因 |
| 回测与行情 API | `/api/*` | Next.js 路由：行情聚合、回测（落库）、实时信号写入、引擎扫描、OKX rubik 白名单代理 |
| 数据库 | 服务端 PostgreSQL / 浏览器 PGlite | 同一份幂等建表 SQL 双运行时；回测与实时信号写入 `signals`/`backtest_runs` 两表 |
| 原版页面 | `/#legacy` | 远程项目原始 PULSEDESK 页面（信号流 + 回测统计抽屉），文件保持原样 |
| 审计看板 | `/#audit` | 10 张已完成的构造/策略/订单流缺陷修复任务卡（只读记录） |

页面默认为 Vela 工作区（BTC-USDT-SWAP · 5m）。右侧默认展示「双顶双底」的正在跟踪记录，可展开六段证据与事件时间线；历史记录可定位并临时聚焦。旧的未挂载交易侧栏链路已清理，Shift+C确认引擎与 `#legacy` 保留。

## 快速开始

环境要求：Node.js 20.19+（或 22.12+）、npm；实时行情需要能访问 OKX 公共接口（无需 API Key）。

```sh
npm ci
```

### 方式一：生产模式（Next 托管，端口 3000）

```sh
# 可选：先把表建到 .env 的 DATABASE_URL 指向的 PostgreSQL（运行时也会自动幂等建表）
npx drizzle-kit push

npm run build   # prepare-runtime + vite build + next build，三段缺一不可
npm start       # http://localhost:3000/
```

`GET /` 由 `src/app/route.ts` 返回 Vite 构建的单文件 SPA（`dist/index.html`，缺失时回退 `public/index.html`，再缺失返回 503 提示）。只改前端不重跑 `vite build` 会拿到旧页面。

### 方式二：前端开发（Vite，端口 5173）

```sh
node scripts/prepare-runtime.mjs
npm run dev -- --host 0.0.0.0 --port 5173
```

SPA 的浏览器运行时初始化后会分发同一批本地 API handler 并使用 PGlite 内存库（即使由Next托管）；`/api/okx` 例外，必须经真实后端代理（见架构文档第 3 节）。生产预览可用 `npm run preview -- --host 0.0.0.0 --port 4173`（需先构建）。

环境变量：根目录 `.env` 提供 `DATABASE_URL`（服务端持久化用；缺失时自动降级，健康检查回 `fallback: true`）。

## 验证

```sh
npx next typegen
npm exec tsc -- --noEmit
npm run build
node scripts/run-ts-test.mjs tests/signal-logic.test.ts   # 任一单测
npm run test:quant                                        # 订单流/标注排版/审计回归三件套
```

浏览器回归（Playwright，需先 `npx playwright install --with-deps chromium` 并启动 dev 或 preview）：

```sh
TEST_URL=http://127.0.0.1:4173/ node tests/runtime.browser.mjs
```

全部测试（含每个文件的覆盖范围）见 `tests/README.md`。浏览器套件必须**串行**运行，它们共享同一条限频的公共行情 feed。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/ARCHITECTURE.md` | 双构建策略、运行时拓扑、数据流、缓存清单、不可破坏的契约、降级策略 |
| `docs/API.md` | 6 个接口的参数/响应/缓存/错误，以及服务端调用的 OKX 上游接口 |
| `docs/STRATEGY.md` | 原始形态引擎、19 因子确认模型、回测与实时判定、订单流数据层、统计/拟合/寻优 |
| `docs/FRONTEND.md` | 页面入口、Vela 集成与外壳增强、指标库、确认引擎面板、原版页面与审计看板 |
| `docs/DATABASE.md` | 表结构、服务端/浏览器双运行时、写入路径、环境变量 |
| `docs/OPTIMIZATION.md` | 当前M/W优化记录：代码清理、规则统一、实时修复、六市场同输入复测与边界 |
| `src/vela/signals/README.md` | M/W单一判读、七个控制项与数据/实时口径、数据来源、实时机制与研究出处（模块内文档） |
| `src/vela/signals/orderflow-keylevel-research.md`、`smart-money-research.md` | 关键位订单流与聪明钱结构的研究笔记/实施规格（口径依据） |
| `src/vela/library/README.md` | 指标库结构与行为 |
| `tests/README.md` | 全部单测与浏览器回归的运行方式和覆盖范围 |

## 目录说明

```text
src/            当前活动代码（App 外壳、vela 集成、quant 内核、components、app/api、db）
remote/         原始远程项目源码（被 src 直接引用，如 page.tsx/engine.ts/schema.ts；不修改）
remote-project/ 导入时的字节校验快照（只存档，不作为当前活动模块）
reference/      更早的两版参考实现（只存档）
scripts/        prepare-runtime、run-ts-test、inspect-signals（真实市场只读诊断）、MCP导入工具
tests/          TS 单测（esbuild 打包后 Node 运行）+ Playwright 浏览器回归
public/runtime/ prepare-runtime 生成的 PGlite 浏览器运行时（wasm/data/js，约 16MB）
docs/           本文档集
```

快照目录（`remote-project/`、`reference/` 及 `remote/` 内的原始文件）属于存档：删改会破坏字节校验完整性，因此文档维护只针对活动代码。导入工具脚本（`scripts/*.py`）通过环境变量 `MCP_URL_BASE64` 连接导入端点，Web 应用本身不包含该地址。

## 口径声明

- 信号标注只做观察性标注：不下单、不提供校准概率或盈利保证；`buy − sell` 是 taker 主动成交差，不是订单簿 OFI；看不到止损委托，故只称「诱多/诱空候选」。
- 真实逐笔要求逐笔聚合覆盖对应 K 线成交额 85%–110%（rubik 口径 95%–110%）；不达标即记为无数据，绝不用 K 线近似冒充真实成交；近似观察在界面标 `≈`。
- 确认引擎的概率来自 19 因子证据模型（`src/quant/model.ts`），面板提供校准与样本外工具供自行检验；「本图历史兑现率」是当前图表样本统计，不是跨币种结论。
