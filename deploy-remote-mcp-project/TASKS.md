# MCP Project Import

Source: user-provided MCP endpoint, connected using Streamable HTTP.
Remote project: `merge-project-ui-layouts`.
Visible task card: `0bc8c5a3-9bbb-4f1d-9e09-b5932e5d7435`.

| ID | Outcome | Status |
| --- | --- | --- |
| inspect | Read project instructions and complete source manifest | Complete |
| import | Read all project files locally and verify original hashes | Complete: 230/230 |
| configure | Restore the existing application and install dependencies | Complete |
| verify | Start the application, build, and run browser checks | Complete |

## Preservation

- Original files are preserved in `remote-project/merge-project-ui-layouts/`.
- Read responses and import metadata are stored in `.mcp-import/`.
- The original project's `TASKS.md` is preserved without treating its historical test results as current verification.
- Generated dependencies, build output, and Git history are not source files and are not imported.

## Import Verification

- 230 original files, 8,124,819 bytes, all matching the remote SHA-256 version.
- 218 files reconstructed using the MCP `read_files` tool.
- 12 files exceeded the reader's single-line limit and were recovered using a read-only, compressed export and command-output reads. All recovered bytes match their reader-provided hashes.
- Dependencies installed from the original manifest; vulnerable Vite/esbuild versions patched using npm. The original package manifest and Vite configuration remain archived unchanged.

## Environment Verification

- `node scripts/prepare-runtime.mjs`: generated the local browser database bundle and copied all PostgreSQL WebAssembly resources.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed with Vite 7.3.7.
- `npm audit`: zero known vulnerabilities after patching.

## Final Runtime Verification

- Development server: `http://localhost:5173/`, HTTP 200, left running.
- Production preview: `http://localhost:4173/`, HTTP 200, left running.
- `tests/symbols.browser.mjs`: 4 checks passed.
- `tests/library.browser.mjs`: 15 checks passed.
- `tests/drawing-toolbar.browser.mjs`: 15 checks passed.
- `tests/runtime.browser.mjs`: desktop, mobile, local PostgreSQL API, and browser error checks passed against both servers.
- Original source snapshot rechecked: 230 of 230 SHA-256 versions match.
- Browser checks were run sequentially to avoid shared public-feed rate limits and memory pressure.

## Local Compatibility Fixes

- Generated `public/runtime/` with the installed PGlite version; omitted unused Node-only filesystem imports from the browser bundle.
- Deferred the trading panel's nested React root cleanup in `src/vela/registerTradePanel.tsx` to avoid a development StrictMode commit race.
- Preserved the untouched original file versions in `remote-project/merge-project-ui-layouts/`.
- Kept the MCP connection address and session metadata in ignored `.mcp-import/` files, not in shipped frontend code.
---

# 任务卡 2：5m 双顶/双底 · 订单流确认 · 诱多/诱空 · 突破回调跟随

远端任务卡：`5b9f1695-474e-4b86-9bd7-8787e92ade15`

| ID | 任务 | 状态 |
| --- | --- | --- |
| audit | 梳理现有双顶/双底检测与订单流证据代码，定位判断薄弱点 | 完成 |
| research | 调研订单流确认双顶双底、诱多诱空、突破回调跟随的方法并形成规则 | 完成 |
| orderflow | 实现 5m 订单流证据层：二次测试的 Delta/CVD 背离、吸收、衰竭、扫损判定 | 完成 |
| trap | 实现诱多/诱空与突破-回调跟随判定及涨跌概率评分 | 完成 |
| ui | 交易侧栏与图表标注展示概率、陷阱与回调跟随结论 | 完成 |
| verify | 单元测试、类型检查、构建与浏览器验收 | 完成 |

## 审计结论（改造前的薄弱点）

- 交易侧栏的扫描没有接入任何实时订单流：`runScan(..., live = undefined)`，盘口/大单因子恒为空。
- 全部“主动买卖差”来自 K 线形态近似 `v × (2·收盘位置 − 1)`，与拒绝影线因子高度重复，不是真实成交方向。
- 没有显式的诱多/诱空判定，也没有“突破后回调能否跟随”的判读。

## 实现

- `src/quant/flow.ts`：真实订单流数据层。浏览器内用 OKX `/market/history-trades` 回补（5m 默认最近 8 根完整 K 线）+ `trades` WebSocket 实时聚合，按 K 线汇总主动买入/卖出成交额（USDT）；聚合额 ≥ 85% K 线成交量才算完整覆盖（实测完整 K 线聚合额与 `volCcyQuote` 完全一致）。`rubik/stat/taker-volume-contract` 与持仓量接口无 CORS，仅在 Node 或配置 `localStorage['pulsedesk.okx-proxy']` 代理时使用。
- `src/quant/context.ts`：扫描上下文，真实 delta 优先、近似兜底，记录每根来源与覆盖率。
- `src/quant/orderflow.ts`：
  - `readSecondTest`：两腿主动差对比、CVD 极值背离、二次测试量能、扫损深度与扫损期间主动方向、关键位吸收、确认K主动方向、第二腿持仓变化 → 诱多/诱空评分与理由。
  - `readBreakout`：突破K量能/主动差/离位、回调深度/量比/主动差、回踩关键位是否守住或失败 → `不追 / 等回踩 / 可跟随 / 守住但兑现率低 / 暂不跟随 / 假突破`，概率 = 先验 + 本图历史同类回踩兑现率。
  - `scanBreakouts`：对本图全部收盘突破的摆动关键位统计「突破即追」与「等回踩」的 +1.5 ATR 兑现率。
- `src/quant/model.ts`：新增因子 `cvdDiverge`、`sweepTrap`、`testDelta`、`oiTrap`（追加在末尾，原校准/寻优/面板逻辑按 FACTORS 泛化，无需改动）。
- `src/vela/FlowRead.tsx` + `src/vela/useFlow.ts`：交易侧栏「订单流判读」卡，按场景展示：双顶 → 下跌概率；双底 → 上涨概率；诱多/诱空与理由；突破 → 回调跟随结论、回踩区、本图历史兑现率；接近关键位 → 实时主动差提示。图上自动标注诱多/诱空箭头与回踩区。
- 默认周期改为 5m（已保存的工作区状态优先）。

## 验证

- `node scripts/run-ts-test.mjs tests/orderflow.test.ts`：6 组合成场景通过（双顶扫高收回+主动卖出→诱多、镜像双底→诱空、真突破缩量回踩守住→可跟随、放量跌回→假突破、放量离位→不追、历史突破统计）。
- `npx tsc --noEmit`、`npm run build` 通过。
- `tests/flowread.browser.mjs`（生产预览）：侧栏打开、OKX 逐笔成交回补并显示覆盖根数、判读视图渲染、图上标注、零浏览器错误。
- 回归：`tests/runtime.browser.mjs`、`tests/symbols.browser.mjs` 通过。

## 已知边界

- 真实主动成交只覆盖页面打开后 + 回补的最近约 8 根（5m）；更早 K 线仍用形态近似，卡片与信号列表均标注来源（`真实订单流` / 近似）。
- 持仓量（OI）因子需要 rubik 代理，浏览器直连时记为无数据，不参与评分。
- 概率中的“本图历史”为当前图表加载 K 线上的样本统计，不是跨币种校准结果；完整校准仍在「引擎详情」。

---

# 任务卡：信号标注侧栏列表内边距

> 范围：仅调整「最近标记」列表项与「标注类型」悬停行的内边距，保留简约配色、列表结构和全部信号功能。

| ID | 任务 | 状态 |
| --- | --- | --- |
| P1 | 最近标记与类型行增加左右 12px 内边距，优化上下留白，并对齐表头、数量和说明 | ✅ 完成（最近标记 12px 四周；类型行上下 6px、左右 12px） |
| P2 | 浏览器检查悬停、选中、桌面和移动端间距及开关功能 | ✅ 完成（实际内容边界测量通过，表头列对齐，无横向溢出） |
| P3 | 完整类型生成、TypeScript、生产构建和启动检查 | ✅ 完成（标注单测、next typegen、tsc、npm run build、build_and_start 均通过） |

验证记录：
- `tests/signal-annotations.browser.mjs` 已增加实际内容边界距离断言：类型行左右至少 12px、上下至少 6px；最近标记项悬停及选中时四周至少 12px；桌面与 390px 手机视口均通过。
- 表头、识别数与类型名称保持对齐，主题色、灰色悬停样式和全部功能保留。
- 截图：`.verification/signals-type-row-spacing.png`、`.verification/signals-recent-row-spacing.png`、`.verification/signals-recent-row-spacing-mobile.png`。
- 本轮仅更改样式和测试，不涉及信号识别、订单流、数据持久化或策略计算。

---

# 任务卡：短线标注的因果性与订单流证据重构

> 本卡只改「信号标注」的识别与展示口径，不修改历史交易回测/下单逻辑，不宣称任何胜率或已验证的预测力。打勾表示已完成并经测试，不代表实盘收益验证。

## 可复核的研究与数据定义

- [Lo, Mamaysky & Wang, *Foundations of Technical Analysis*, NBER w7613 / Journal of Finance (2000)](https://www.nber.org/papers/w7613)：价格形态识别应有可重复的算法定义和独立统计检验。研究对象是**历史美股日线**，不能外推为 OKX 永续 5m 的胜率；本项目只借鉴「明确结构及确认时点」。
- [Cont, Kukanov & Stoikov, *The Price Impact of Order Book Events*, Journal of Financial Econometrics (2014)](https://arxiv.org/abs/1011.6402)：最佳买卖价上的订单流失衡包括挂单新增、撤单和市价成交；单靠逐笔成交买卖差**不是**论文定义的 OFI。项目只有 OKX trades 时只能称「taker 主动成交差」，不能称 OFI，也不能据此认定真实止损触发。
- [Cartea, Donnelly & Jaimungal, *Enhancing trading strategies with order book signals*, Applied Mathematical Finance (2018)](https://kclpure.kcl.ac.uk/portal/en/publications/enhancing-trading-strategies-with-order-book-signals/)：论文研究纳斯达克**限价订单簿量失衡**及极短时预测，非当前 K 线代理与 5m BTC 胜率证明。未采集订单簿快照序列前不实现「真 OFI」。
- [Osler, *Stop-Loss Orders and Price Cascades in Currency Markets*, Federal Reserve Bank of New York SR150 / 2005](https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr150.pdf)：FX 中有止损集群及级联证据；本应用看不到 OKX 用户的止损订单，图上「诱多/诱空」只能称**扫高/低收回 + 同时段真实成交的候选提示**，不能声称观察到了实际止损或被套仓位。
- [OKX 官方 API v5](https://app.okx.com/docs-v5/en/)：`trades/history-trades.side` 为 **taker** 买/卖方向；SWAP 的 `sz` 单位是张，要按合约面值×成交价换算 USDT；`candles.confirm=0` 是未完成 K 线，`volCcyQuote` 为报价币成交额。继续使用项目现有 `hasRealFlow` 与 `buildContext` 作为覆盖性检查；不以 OHLC 收盘位置冒充真实主动成交。
- [Bailey et al., *The Probability of Backtest Overfitting* (2014)](https://carmamaths.org/jon/backtest2.pdf)：研究提醒在样本内寻找最佳参数可能过拟合。下面的 ATR 容差和成交差阈值是**明确标注的工程启发式**，非文献推导的胜率或已回测最优阈值。

## 当前代码中已确认的错位

1. `signals/analyze.ts` 的双顶/双底直接调用交易用 `scanDoubles`，但原扫描器 `makeReject` 会按手续费/风险和 minRR 拒绝候选；**看得见的二次测试结构**不该因不可交易而从图上消失。
2. `readSecondTest` 的 CVD、扫损评分混合长历史 K 线形态估算与最近几根真实 taker 数据；`sourceFor(ctx, 第一腿, 当前)` 因历史仅回补近期约 8 根而几乎永远不能标真实，打开近似后又可能把估算值当成「主动成交/诱多」的依据。
3. 原扫描器 `volAround(t)` 在全历史上读取 `t+1` 的量，形成于 t 的形态评分标签有未来数据风险；图表标注不应依赖该交易评分。
4. `deltaImpulse` 在允许近似时仍写「主动买入/卖出异动」，但 OHLC 收盘位置不含逐笔 taker 方向；`retest` 标在订单流组却只需要价格回踩、没有真实成交确认。

## 实施任务

| ID | 任务 | 状态 |
| --- | --- | --- |
| A1 | 独立的、仅用已收盘价格/ATR/已确认摆动点的 M/W 二次测试标注识别器；不调用手续费/RR/趋势门槛；保留旧交易扫描器用于回测 | ✅ 完成（patterns.ts；低可交易性样本、双向镜像、前缀因果测试） |
| A2 | 局部真实成交证据：诱多/诱空须扫位收回且测试/确认 K 真实覆盖，taker 方向支持反转或追单被吸收；无真实成交时可选 ≈「价格扫位收回」，不伪称看到止损 | ✅ 完成（局部单根真实成交即可出现候选；价格代理另标 ≈） |
| A3 | CVD 背离只用**连续真实成交覆盖**的两次测试间 K 线；断档不得拼接近似值。主动成交异动只从真实 taker 计算；可选近似单独命名为 K 线量价代理 | ✅ 完成（CVD 全段覆盖、K 线连续性、以真实成交额为分母；真实与代理分别去重） |
| A4 | 突破回踩为价格结构确认；仅在突破 K 和确认 K 都具备真实 taker 数据时附加实际成交证据，不把 K 线代理说成订单簿 OFI | ✅ 完成（price-first；仅两根真实时附加来源说明） |
| A5 | 结构与订单流两组在侧栏准确分组、规则解释、近似徽标；更新用户可见的来源说明 | ✅ 完成（store.ts、SignalPanel.tsx、signals/README.md） |
| A6 | 确定性单测覆盖禁用未来、低 RR 形态、覆盖断档、局部真成交、无真实成交时的诚实命名、回踩按发生时点冻结、开关；改浏览器测试中的旧口径断言 | ✅ 完成（新增 signal-logic.test.ts：8 组场景；原标注单测与浏览器八类开关回归均通过） |
| A7 | 重建 Vite/Next、运行 typegen/tsc/生产构建/preview 健康与浏览器回归；记录结果和剩余边界 | ✅ 完成（详见下方验证记录） |

## 验证记录与仍需留意的边界

- `npm run test:quant`（订单流/标注排版/旧交易扫描回归）、`tests/signal-annotations.test.ts`、新增 `tests/signal-logic.test.ts`：全部通过；旧交易用 `scanDoubles` 与回测模型未改动。新测试涵盖价格形态的双向镜像、**被旧交易成本门槛挡住的形态仍能标注**、事件后续行情不能改写已确认信息、连续真实 CVD/缺失数据、多源去重、价格回踩首次确认和独立的两根真实成交佐证。
- `next typegen`、`tsc --noEmit`、Vite + Next 生产构建、`build_and_start` 健康检查：全部通过。`/api/health` 返回 `{"status":"ok","ok":true}`。
- `TEST_URL=http://127.0.0.1:3000/ node tests/signal-annotations.browser.mjs`：通过。浏览器使用**测试专用**确定性 OKX REST/WS 响应，检查 canvas 真实像素、八类开关、分类修订、图层关闭不删除手动画线、未收盘预览、最近列表定位、刷新记忆、切市场、移动端及零脚本错误；不是实盘收益测试。
- 额外真实 OKX 页面冒烟：BTC-USDT-SWAP 5m 加载后分组为「价格结构 / 逐笔订单流」，DOM 状态有 19 个事件标记、43 条图层水平线（包含几何线，不等同于 43 个信号），侧栏无横向溢出或脚本错误。仅为该时刻的运行性检查，**不代表预测有效**。截图 `.verification/signal-live-after-research.png`。
- 原始研究分别基于美股日线、纳斯达克订单簿和外汇止损市场，不能外推为本应用 OKX 永续合约 5m 的盈利证明。ATR 容差、交易差和量比等阈值仍为工程启发式，未进行独立样本外校准；本轮**不展示胜率/概率**。
- OKX 历史逐笔成交只回补有限近端历史。CVD 需要第一到第二次测试**全部连续真实成交覆盖**，因此很可能长期显示 0；这是故意的缺数据处理，而不是自动用 OHLC 填补。诱多/诱空现只标观察候选，不证明看到具体止损单或订单簿新增/撤单事件。要实现论文定义的 OFI，需要新增可信盘口事件流和跨市场样本外测试，此次没有凭空制造。



---

# 任务卡：M/W 关键位的真实订单流观察标记（研究完成，实施待后续）

> 本轮只做文献查阅、代码审计和规格设计；**未修改任何策略/标注代码，没有引入新指标或阈值**。文献笔记及完整实施口径：[`src/vela/signals/orderflow-keylevel-research.md`](src/vela/signals/orderflow-keylevel-research.md)。

| ID | 任务 | 状态 |
| --- | --- | --- |
| R1 | 查阅并区分 OFI、盘口队列失衡、taker Delta/CVD、Footprint、吸收、扫位/止损集群的原始文献与数据定义 | ✅ 完成 |
| R2 | 审计当前双顶/双底二次测试锚点、OKX `side/sz/ctVal`、逐笔覆盖判定、缓存字段和 Canvas 图层的真实能力 | ✅ 完成 |
| R3 | 定义关键位成交反应标记、来源/coverage、缺数据行为、保守措辞与自动化验收边界 | ✅ 完成 |
| K1 | 双顶/双底第二次测试处增加独立“关键位成交反应”类型；显示测试 K / 确认 K 的真实 taker B/S、USDT 名义额、归一化 delta、coverage 和扫位 ATR | ✅ 完成（analyze.ts 新增 keyLevelFlow；测试/确认 K 原始 B/S、Δ、覆盖率、扫位与收盘结果） |
| K2 | 第一推进腿和第二推进腿分别记录起止；完整连续真实覆盖后才显示推进减速/CVD，不混入近似或颈线回撤 | ✅ 完成（patterns.ts 记录两腿起点；legFlow 仅完整连续覆盖时输出推进占比） |
| K3 | 实际扫位收回 + 局部真实 taker 才能显示“成交佐证候选”；无真实成交时隐藏，用户启用近似后只显示 `≈ 价格扫位回收` | ✅ 完成（真实扫位候选与 ≈ 价格扫位分开；新标记无真实覆盖不生成） |
| K4 | 侧栏按“价格结构 / 逐笔订单流”分组，增加每事件 flow 开关、来源/coverage 详情，展示 test 与 confirm 原始观测，不显示未经校准的方向概率 | ✅ 完成（store.ts 独立 flow 开关；侧栏来源/coverage 与原始观测详情） |
| K5 | 确定性测试：无流、部分覆盖、84.9/85% 边界、反向/中性 delta、连续两腿与断档、真实事件不被邻近近似去重、因果性、交易费用无关 | ✅ 完成（signal-logic.test.ts 新增覆盖边界、部分覆盖、反向/中性、两腿减速、未来不变与独立开关） |
| K6 | 生产构建、真实图层浏览器回归；若未来把标注升级为“预测信号”，另做预先定标签、purge/embargo、独立样本外效果检验 | ✅ 完成（生产构建、build_and_start、确定性浏览器回归与真实 OKX 页面冒烟通过；未宣称预测力） |

## 已得出的项目适配结论

1. 第一版应叫 **关键位成交反应 / key-level taker-flow context**，不能叫 OFI。OKX trades 的 `side` 是 taker buy/sell；`OFI` 还要盘口队列新增、撤单、成交及 `seqId/prevSeqId` 连续性，本项目标注 runtime 没订阅 order book updates。
2. 逐笔主动差只能标成交方向。价格扫过已知高/低再收回可确认是“价格扫位回收”；没有订单委托/用户身份数据，不能说真实止损被触发、持仓被套或机构吸收。
3. 真实数据优先使用 `(B−S)/(B+S)` 并逐根显示覆盖。默认 `hasRealFlow` 是逐笔总额达到 K 线成交额 85%；不完整时不存在的值是“无覆盖”，不是中性 0。
4. 第二次测试本身可来自已确认的价格形态；订单流只作为独立观察，不以无流量删掉价格形态。第一、第二次推进对比只比同方向推进段的 normalized ratio；不将两次测试之间的 retracement volume 混进第二腿。
5. 当前逐笔摘要已丢失 per-trade price（`FlowBar` 仅 buy/sell K 线总额，`FlowTrade.recent` 仅 ts/side/notional）；因此本项目目前没有足够数据做逐价 footprint、stacked imbalance、具体价位 passive absorption。未来需单列数据工程。
6. 可参考的 OOS/预测论文频率多数是秒级股票订单簿、早期 Mt.Gox tick 或 Bitstamp 日级 crash risk；只作概念，不移植阈值/胜率到当前 OKX 5m。包括：
   - Cont, Kukanov & Stoikov (2014), [OFI and price impact](https://arxiv.org/abs/1011.6402)；OFI 包含订单簿事件，不是 trade imbalance。
   - Cartea, Donnelly & Jaimungal (2018), [LOB volume imbalance](https://doi.org/10.1080/1350486X.2018.1434009)；纳斯达克做市/短时 next-MO 任务。
   - Scaillet, Treccani & Trevisan (2020), [Bitcoin high-frequency jumps](https://doi.org/10.1093/jjfinec/nby013)；Mt.Gox 2011–2013 jump 任务。
   - Koutmos & Wei (2023), [Bitcoin crash-risk nowcast](https://doi.org/10.1007/s11156-023-01148-1)；Bitstamp 日频，不是局部 5m reversal。
   - Lo, Mamaysky & Wang (2000), [系统化技术形态](https://www.nber.org/papers/w7613)；支持可复现的形态定义，不证明当前策略收益。
   - Sierra Chart [CVD 数据/Reset 说明](https://www.sierrachart.com/index.php?page=doc%2FStudiesReference.php&ID=292)，OKX [官方 v5 市场数据定义](https://app.okx.com/docs-v5/en/)，Bailey et al. [PBO / CSCV](https://carmamaths.org/jon/backtest2.pdf)。


## 验证记录（K1–K6）

- `node scripts/run-ts-test.mjs tests/signal-logic.test.ts`：新增关键位成交反应场景通过，包括 84.9%/85.1% 覆盖边界、仅局部真实成交、推进侧未能站稳、中性成交、完整两腿推进减弱、覆盖不足、未来数据不回写和独立开关。
- `node scripts/run-ts-test.mjs tests/signal-annotations.test.ts`、`npm run test:quant`、聚焦 ESLint：通过；原交易扫描、回测、诱多/诱空、CVD 与标注排版未被新类型破坏。
- `npx next typegen`、`npm exec tsc -- --noEmit --pretty false`、`npm run build`、`build_and_start`：通过，`/api/health` 返回 `{"status":"ok","ok":true}`。
- `TEST_URL=http://127.0.0.1:3000/ node tests/signal-annotations.browser.mjs`：通过；测试专用 OKX REST/WS 样本中逐笔订单流组为 5 类，BTC 样本「关键位成交反应」计数为 1，Canvas 有真实标记，开关、切市场、刷新记忆、移动端和零脚本错误均通过。截图 `.verification/signals-fixture-desktop.png`、`.verification/signals-mobile.png`。
- 真实 OKX 页面冒烟：BTC-USDT-SWAP 5m 侧栏显示 9 类且包含新类型，无横向溢出或脚本错误；检查时刻新类型计数为 0（没有同时满足已确认二次测试与真实覆盖的事件），DOM 有其他结构/成交标记。该检查只证明运行可用，不证明预测有效。截图 `.verification/keyflow-live-okx.png`。
- 本轮没有实现订单簿 OFI、逐价 Footprint、OI/清算或真实止损识别，也没有做样本外预测力验证；所有阈值仍是工程观察参数。

## 本轮变更范围

- 新增研究文档和本任务卡；没有修改 `src/`、`public/`、依赖、标注开关、标记规则或构建逻辑。
- 实施前置条件：确认使用上表的“观察标记”措辞与严格真实覆盖行为；到时从 K1 开始逐项实现、每项测试通过后再将任务卡标 ✅。

---

# 任务卡：诊断“为什么没有双底 / 支撑位没有订单流标注”（2026-11-03，只读取证）

> 本轮只做只读复现与源码审计，**没有修改代码**。证据脚本输出在 `.verification/live-*.json`（本目录被 `.gitignore` 忽略）。

| ID | 任务 | 状态 |
| --- | --- | --- |
| D1 | 用真实 OKX BTC/SOL 5m K 线复现：当前可检测到 M/W 的位置、最近 40/60 根窗口是否看不到老 W | ✅ 完成 |
| D2 | 用真实 OKX `history-trades` 分页测量逐笔覆盖；定位 85% 覆盖只命中最近约 2 根的原因 | ✅ 完成 |
| D3 | 对照源码说明支撑位只画线不画成交原因、双底未标注原因、渲染是否过滤远端事件 | ✅ 完成 |
| D4 | 给出优化方案：不改策略回测，只改标注可见性、数据回补和支撑位成交提示 | ⬜ 待你确认后实施 |

## 复现结论（2026-11-03 UTC，OKX 实时 5m）

1. **双底确实存在，但不在当前可见窗口里。** 用 300 根 BTC 5m 已收盘 K 线复现，`scanAnnotationPatterns` 检测到 5 个形态：3 个 M 双顶、2 个 W 双底。两个 W 的确认时间分别是 `2026-11-02 21:00 UTC`（关键位 76666.8）和 `2026-11-02 23:05 UTC`（关键位 76688.8）。按最近 40/60 根窗口复现时 `patterns=[]`；也就是图上最近 40–60 根没有新的 W，旧 W 的标记事件虽然在侧栏列表里，但画布渲染层只按当前 `bars` 索引绘制，已滚出当前视图的 `ts` 不会画出来。
2. **BTC 截图里的支撑 77082.1 确实只被“第二次测试”了一次。** 该支撑形成于 `2026-11-03 14:00 UTC`，之后只有 `14:30 UTC` 一根 K 的 low=77080 触及容差内（约 0.011 ATR），随后价格反弹且没有收盘跌破。当前 `patterns.ts` 要求同一关键位有第二次测试并收盘拒绝，所以它只显示为 `支撑/阻力` 线，不显示 `W 双底`。这不是漏检，是定义不满足。
3. **支撑位没有订单流标注，是因为 `keyLevelFlow` 只挂在 M/W 第二次测试上。** 代码位置：`analyze.ts` 中 `keyLevelFlow` 在 `for (const pattern of patterns)` 内生成；`keyLevels` 只有 `levels` 线，没有 `event`。因此单纯支撑位即使有真实成交，也不会出现 `Δ` 标记。
4. **关键位成交反应在 BTC 最近窗口计数为 0，主要原因是真实覆盖窗口太短。** 实测 OKX `history-trades`：前 60 页只有约 2 分钟数据；400 页才到 `15:00 UTC`，最近两根已收盘 K 线覆盖率约 98.7%/100%。而应用运行时 `runtime.ts` 调 `syncFlow` 时 `bootstrapBars: 8`、`bootstrapPages: 220`，5m 只回补最近约 8 根；BTC 成交密度高，220 页约 3–4 分钟，正常只能覆盖最近 1–2 根完整 K 线。于是多数 M/W 的测试/确认 K 没有真实成交覆盖，`keyLevelFlow=0`，CVD 也因整段不连续而为 0。
5. **SOL 图中出现了 1 个 keyLevelFlow**，因为 SOL 成交密度低，同样 220 页能覆盖更多根，最近的 M 双顶（93.65）的测试/确认 K 恰好落在真实覆盖窗口内；所以“有时有、有时没有”不是随机 UI bug，是覆盖窗口短造成的数据稀疏。

## 已确认的实现问题 / bug

| 编号 | 问题 | 严重性 | 证据 |
| --- | --- | --- | --- |
| B1 | 标注画布只渲染当前 `bars` 索引内的事件；历史 W/M 事件滚出可视范围后图上就看不见，侧栏仍显示，造成“没标注”的观感 | 中 | `annotLayer.ts` `setup()` 用 `indexOf(bars)`，`barAt` 找不到就不画；真实复现最近 40/60 根无 pattern |
| B2 | `keyLevelFlow` 只绑定 M/W，普通支撑/阻力没有成交反应标记 | 中 | `analyze.ts` 的 `keyLevels` item 没有 `event`，只有 `levels`；源码路径明确 |
| B3 | 订单流回补窗口太短且与 BTC 成交密度不匹配；5m 只 8 根/220 页，BTC 约只覆盖 1–2 根完整 K，导致绝大多数关键位 flow 为 0 | 高 | 实测 60 页≈2 分钟、400 页才到前一小时；`runtime.ts` 传 `bootstrapBars: 8, bootstrapPages: 220` |
| B4 | `keyLevelFlow` 即使某根有成交，两腿比较仍常显示“覆盖不足”，因为第一腿通常在回补窗口外 | 中 | 实测 BTC 最近 600 根 covered 只有 1；`legFlow` 要求整段连续覆盖才输出 ratio |
| B5 | 形态检测参数较严格：`minGap=8`、`minHeightAtr=2`、`sweepAtr=0.5`、`closeBufAtr=0.05`、ATR 容差上限 0.7 ATR；单次轻触支撑且没有收盘拒绝就不会形成 W | 中 | `patterns.ts` 常量来自 `DEFAULT_PARAMS`；77082.1 只轻触 0.011 ATR 后反弹，未达二次测试拒绝 |
| B6 | `findSwingLevels` 的 `maxAge: 288` 与标注 `lookback=600` 混用不同窗口；关键位列表只保留最近 288 根未突破位，事件本身仍受 `lookback` 截断 | 低 | `analyze.ts` 中 levels 用 `maxAge:288` + `idx<=288`，patterns 用 `lookback` |
| B7 | 标注事件没有“已滚出视图仍可点击定位”的持久视觉提示；侧栏有列表，图上没有任何残留标记 | 中 | `annotLayer.ts` 只渲染 `bars` 内事件；`SignalPanel.locate` 会 `setVisibleRange` 回跳 |

## 建议优化（不改交易策略/回测）

1. **支撑/阻力也显示最近一次真实成交反应**：给 `keyLevels` 增加可选 `event`，显示最近一次触及/收盘在该位附近的 K 的 `Δ` 与覆盖率；无真实覆盖时只画线，不画 Δ。
2. **把订单流回补从“固定 8 根”改为“时间窗 + 页数双上限”**：例如 5m 回补最近 45–60 分钟，页数上限按品种自适应（BTC 更高），并把已覆盖根数显示在侧栏。这样最近 M/W 的测试/确认 K 更可能落在覆盖内。
3. **历史事件可视化**：事件滚出当前视图时，在时间轴/左边缘保留一个小点或计数徽标；点击仍可 `setVisibleRange` 回跳。避免“侧栏有、图上没有”的错觉。
4. **两腿比较降级**：第一腿没有真实覆盖时，不显示“覆盖不足”一整行，而显示“第二腿覆盖 x/y 根，第一腿超出回补窗口”，避免把有用的局部信息完全隐藏。
5. **单次轻触支撑可单独提示**：新增低门槛的“关键位测试”观察（非双底），显示触及深度、确认收盘和可选真实 Δ；不把它算成 W 双底，不输出概率。
6. **阈值调参必须单独立项**：`minGap/minHeightAtr/sweepAtr/tol/lookback` 当前是交易 scanner 默认参数，直接用于视觉标注。若要放宽，只改标注层参数，并用历史样本统计新旧检出数量、覆盖率和误报率，不能凭一张截图调。
7. **真实覆盖口径保持 85%，但要区分“未回补”和“回补了但不完整”**：侧栏应显示覆盖根数/时间范围，而不是只显示 `covered / bars`。
