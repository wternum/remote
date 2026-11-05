# 策略与量化内核

本文描述当前实际运行的策略链路：形态识别、入场确认模型、订单流数据层、回测与样本外分析。实现分布在 `remote/setup-mcp-project-locally/src/lib/engine.ts`（原始引擎，未改动）、`src/lib/engine.ts`（覆盖层）与 `src/quant/*`。

重要边界：信号标注（`src/vela/signals/`）是独立的观察性标注，不产生交易信号，口径见 `src/vela/signals/README.md`；本文的概率来自确认引擎的证据模型，其阈值是工程参数，未做跨市场样本外校准（校准/寻优工具见第 7 节，结论以面板实测为准）。

## 1. 两层引擎结构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 原始几何引擎 | `remote/setup-mcp-project-locally/src/lib/engine.ts` | 双顶/双底几何扫描 `scanDoubles`、关键位 `computeLevels`、ATR/均线、原始 `simulate`/`summarize`。按项目契约不修改 |
| 覆盖层 | `src/lib/engine.ts` | `export *` 原始引擎后覆写 `simulate`（回测）与 `detectAt`（实时）：形态几何不变，只替换「是否入场」的判定为概率门槛 |
| 确认引擎 | `src/quant/scan.ts` | `runScan` 同时产出确认/触价两组候选，`collectEvidence` 算因子，`candidateFrom` 组装候选与结果模拟 |

覆盖层的关键口径：调原引擎时把 `trendBlock` 设为 50（关闭一刀切逆势屏蔽），改由连续的 `trendExhaust` 证据 + 概率门槛决定；`entryMode` 由确认引擎配置映射（`confirm` → 等拒绝K收盘，`touch` → `limit` 关键位挂单）。`runScan` 与 `simulate` 用同一组参数，保证回测、侧栏与引擎面板在同一形态上给出同一信号集合。

## 2. 原始形态扫描（scanDoubles）

四种形态（`PATTERN_META`）：

| ID | 标签 | 含义 |
| --- | --- | --- |
| `db_reject` | W双底·二次测试 | 历史底部被第二次测试，收盘拒绝后做多 |
| `dt_reject` | M双顶·二次测试 | 历史顶部被第二次测试，收盘拒绝后做空 |
| `db_break` | W双底·颈线突破 | 二次测试后收盘站上颈线做多 |
| `dt_break` | M双顶·颈线跌破 | 二次测试后收盘跌破颈线做空 |

默认参数 `DEFAULT_PARAMS`：

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `pivotLeft` / `pivotRight` | 8 / 5 | 摆动点左右确认根数（右侧 5 根收盘后才知晓） |
| `lookback` | 288 | 历史顶/底最长有效回看根数 |
| `minGap` | 8 | 两次测试最少间隔根数 |
| `minHeightAtr` | 2 | 颈线距关键位 ≥ 2 ATR |
| `priorMoveAtr` | 1.5 | 第一个顶/底之前的趋势腿幅度 |
| `tolAtr` / `tolPct` | 0.35 / 0.0004 | 等高/等低容差（ATR 与价格比例取小） |
| `sweepAtr` | 0.5 | 允许刺破关键位的深度 |
| `closeBufAtr` | 0.05 | 拒绝收盘需离开关键位的距离 |
| `stopAtr` | 0.75 | 止损缓冲 |
| `targetFrac` | 1 | 目标 = 到颈线距离 × 1 |
| `minRR` / `maxRR` | 1.2 / 4 | 最低盈亏比 / 目标封顶（R） |
| `enableBreak` / `breakWithin` | false / 24 | 默认不交易颈线突破单；二次测试后 24 根内有效 |
| `entryMode` / `limitOffsetAtr` | `limit` / 0.1 | 原始默认触价挂单（覆盖层会按配置改写） |
| `trendBlock` | 1 | 逆势强度屏蔽（覆盖层设为 50 关闭） |

成本与持仓常量：`FEE_RATE = 0.0005`（taker 0.05%/边）、`SLIP_RATE = 0.0001`（滑点 0.01%/边）、`CONF_MIN = 60`（结构质量门槛）、`MAX_HOLD_5M = 96`（8 小时超时）、`MAX_HOLD_15M = 48`（12 小时）、`RISK_USD = 100`（每笔固定风险折算）、`MAX_COST_RATIO = 0.3`（预估往返成本/风险上限）。

## 3. 入场确认模型（src/quant/model.ts）

每个候选先算 19 个因子、每个输出 `[-1, 1]` 的证据强度，再加权过 logistic 得到「入场成功概率」。缺失数据记 `null`、贡献恒为 0，不做臆测加成。因子按方向 `dir`（多 +1 / 空 −1）归一，多空共用同一套权重。

| key | 名称 | 组 | 权重 | 仅实时 |
| --- | --- | --- | --- | --- |
| `touchFlow` | 触顶订单流 | 订单流 | 0.95 | |
| `volDiverge` | 二次测试缩量 | 订单流 | 0.55 | |
| `deltaDiverge` | 主动成交差背离 | 订单流 | 0.70 | |
| `absorption` | 关键位吸收 | 订单流 | 0.80 | |
| `wickReject` | 拒绝影线 | 订单流 | 0.50 | |
| `thrustVolume` | 确认K量能 | 订单流 | 0.45 | ✓ |
| `bookImbalance` | 盘口失衡 | 订单流 | 0.50 | ✓ |
| `tapeBias` | 大单主动方向 | 订单流 | 0.40 | ✓ |
| `levelIntegrity` | 关键位完整度 | 结构 | 0.40 | |
| `patternHeight` | 形态高度 | 结构 | 0.30 | |
| `patternSpan` | 形态时间跨度 | 结构 | 0.25 | |
| `trendExhaust` | 趋势已转平 | 结构 | 0.50 | |
| `legDecel` | 推进减速 | 结构 | 0.45 | |
| `volRegime` | 波动环境 | 结构 | 0.20 | |
| `rrQuality` | 目标可达性 | 风险 | 0.60 | |
| `cvdDiverge` | CVD 极值背离 | 订单流 | 0.60 | |
| `sweepTrap` | 扫损陷阱 | 订单流 | 0.65 | |
| `testDelta` | 确认K主动方向 | 订单流 | 0.40 | |
| `oiTrap` | 持仓被套 | 订单流 | 0.30 | |

每个因子的证据定义（含 +1/−1 的含义）写在 `FACTORS[].hint`，并通过 `/api/engine/scan` 出网给面板展示。

评分公式（`scoreEvidence`）：

```
logit = MODEL.base + Σ gain · wᵢ · clamp(eᵢ)        base = −0.15, gain = 0.42
shrink = min(1, covered / 4.5)                       covered = 有数据因子的权重和
logit ← base + (logit − base) · shrink               证据越少越向 50% 收缩
proba = sigmoid(logit)
```

等级（`GRADE_BANDS`）：A ≥ 0.66「强确认」、B ≥ 0.58「有效确认」、C ≥ 0.50「边缘确认」、D < 0.50「确认不足」。期望值 `expectancy(r, p) = p·max(r,0) − (1−p)` 把胜率与赔率放同一口径。

易错点（代码已处理）：触价挂单在触及关键位当根成交、不存在确认K，`collectEvidence` 把确认K类证据记为 `null`，而不是拿信号K本身充当确认K（会系统性压低 touch 概率）。

## 4. 引擎配置（src/quant/config.ts）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `threshold` | 0.58 | 概率门槛，范围 0.42–0.82（步进 0.005） |
| `entryMode` | `confirm` | `confirm` 等拒绝K收盘 / `touch` 触价成交（A/B 对照用） |
| `replaceConfFilter` | `true` | true 时概率门槛取代原 `CONF_MIN` 结构过滤；false 时两者叠加 |

存储：`localStorage['pulsedesk.confirm-engine.v1']` + cookie `pulsedesk.confirm-engine`（`{t,m,r}` 编码、1 年、samesite=lax）双写；服务端 `/api/backtest` 用 `configFromCookie` 还原（非法内容忽略）。默认 0.58 的理由写在代码注释：单币种单周期样本较小时仍能出信号；更严的档位由面板「配置寻优」按数据决定。

## 5. 回测与实时判定（src/lib/engine.ts 覆盖层）

`simulate(cs, symbol, bar, opts)`：

1. `closedCandles` 只保留已收盘 K 线；`buildContext` 建上下文；`scanDoubles` 出形态；
2. 每个形态经 `candidateFrom` 算概率与模拟结果（`simulateOutcome`：同根内先判止损，保守口径）；
3. 门槛 = 配置值（`flowFilter` 开启时 `min(0.9, 门槛 + 0.05)`）；概率不足或未成交 → 记录 `status: 'skipped'` 并带 `rejectReason`（`confirm` 未过门槛 / `unfilled` 未成交 / `noNextBar`），保留「检出但未执行」的可观测性；
4. 通过者写 `status: 'done'` 与实际入场/出场/R/持仓根数；`exitReason` 中保本（be）与跳空（gap）归入 `time` 以兼容原统计，真实原因保存在 `exitWhy`；
5. 概率与等级被写进既有 `tags`/`note`（如「确认 72% · A级」），UI 与推送自动带依据。

`detectAt(cs, i, of)`（实时）：只看第 `i` 根收盘的信号窗口（`3 × lookback + 300`），把实时盘口/大单（`OFInput`）真正接入评分；未过门槛不产生信号，但把最差 3 个因子打到 console 供人工复盘。

五种出场方案（`EXIT_PLANS`，`simulateWithPlan` 对非 `neck` 方案单独模拟）：

| id | 名称 | 规则 |
| --- | --- | --- |
| `neck` | 颈线目标 | 原方案：目标看颈线（受 maxRR 封顶），超时按收盘价平仓 |
| `r15` | 固定 1.5R | 目标 = 入场 ± 1.5 倍风险 |
| `r10` | 固定 1.0R | 目标 = 入场 ± 1 倍风险 |
| `be` | 1R 保本 | 盈利达 1R 后止损移至成本价，剩余看颈线 |
| `partial` | 1R 减半 + 保本 | 1R 平一半并锁定成本，剩余一半跑颈线 |

## 6. 订单流数据层（src/quant/flow.ts + context.ts）

数据定义：OKX `trades`/`history-trades` 的 `side` 是 **taker（吃单方）方向**；合约 `sz` 为张数，按合约面值 × 成交价换算 USDT 名义额，逐笔去重后按 K 线汇总为主动买/卖额。

覆盖判定（`hasRealFlow`，本项目最硬的口径之一）：

- 逐笔聚合口径：聚合总额占该 K 线报价币成交额 **85%–110%** 才算「真实逐笔」；
- rubik 官方统计口径：**95%–110%**；
- 不达标 = 该根无真实数据（缺失），不参与真实类因子，也绝不解释为买卖平衡。

上下文 `buildContext(cs, flow)` 计算 ATR(14)、EMA20/50、成交量均线与逐根 delta：有真实覆盖的根用真实主动差，其余根用 K 线近似 `v × (2×收盘位置 − 1)`（`approxDeltaSeries`），并逐根记录来源与覆盖率，供 `flowSource`（`taker` / `approx` / `mixed`，按已知比例 95%/5% 分界）标注。

同步策略 `syncFlow`：浏览器 tape 首次回补（`signals/runtime.ts` 传 `bootstrapPages: 300`、5m 回补 12 根/其他 6 根；首次按回看预算回填，后续按运行器节流刷新最新页），rubik 分页有默认预算（`maxPages 16`、`oiPages 12`，引擎服务端调用时收紧为 4/2），避免一次面板请求变成无界历史下载。支持的订单流周期：5m/15m/30m/1H/2H/4H（`PERIOD_MS`）。`bigBiasOf` 取最近 120 秒大单主动方向。rubik 基址：Node 直连或浏览器读 `localStorage['pulsedesk.okx-proxy']`（经本站 `/api/okx` 代理时由服务端转发）。

订单流判读（`src/quant/orderflow.ts`）：

| 函数 | 产出 |
| --- | --- |
| `readSecondTest` | 二次测试判读：两腿主动差对比、CVD 极值背离、扫损深度与扫损期主动方向、关键位吸收、确认K主动方向、第二腿持仓变化 → 诱多/诱空（`bullTrap`/`bearTrap`）、`trapScore`、一句话 `headline` 与理由 |
| `readTouch` / `scanTouches` | 触价判读：approach/touch/sweep/accepted × reject/breakout/uncertain，及全图触及事件统计 |
| `readBreakout` | 突破→回调跟随结论：`chase_risk`（不追）/ `wait_pullback`（等回踩）/ `follow`（可跟随）/ `follow_weak` / `avoid` / `failed`（假突破）/ `strong_hold`；概率 = 先验 + 本图历史同类回踩兑现率（明确是本图样本统计，非跨币种校准） |
| `scanBreakouts` | 对全部收盘突破的摆动关键位统计「突破即追」与「等回踩」的 +1.5 ATR 兑现率 |
| `findSwingLevels` / `nearestLevel` / `latestBreakout` | 左 8/右 5 摆动关键位、最近关键位（含 ATR 距离）、最近一次突破 |

聪明钱结构（`src/quant/smartmoney.ts`）：只统计五项可复核的价格事实——扫流动性收回、同向 BOS/CHoCH、未完全回补缺口（≥0.1 ATR）、未回踩订单块候选（位移 ≥0.5 ATR）、确认收盘的溢价/折价位置；`SMC n/5` 是命中计数不是胜率；仅当 `second-6 → idx` 窗口逐笔覆盖 ≥95% 时附加真实 taker 方向佐证。详见 `src/vela/signals/smart-money-research.md`。

## 7. 统计、拟合与寻优（面板背后的分析层）

| 模块 | 函数 | 用途 |
| --- | --- | --- |
| `stats.ts` | `summarize` / `calibration`（8 桶）/ `thresholdSweep`（0.42–0.82 共 21 点）/ `attribution` / `equitySeries` / `topKillers` / `gradeDistribution` | 胜率、总 R、期望；预测概率分桶对实际胜率；逐因子贡献；被门槛挡掉的主因 |
| `fit.ts` | `fitLogistic`（IRLS）/ `predict` / `auc` / `brier` / `logLoss` / `wilson`（95% 区间）/ `walkForward`（前 70% 训练、后 30% 样本外）/ `fitSparse`（L2=8 稀疏）/ `factorDiagnostics` | 在样本上重估权重并做样本外检验、单因子样本外诊断 |
| `optimize.ts` | `optimize` / `edgeOverBaseline` | 入场 × 出场 × 门槛网格搜索，按样本外（后 30%）表现排序；「通过双重检验」= 样本外期望 > +0.05R 且样本内同向且样本外 ≥ 8 笔 |

面板（Shift+C）直接消费这些函数，展示口径与代码一致：网格搜索存在选择偏差，排名第一仍需继续向前验证；样本内最优门槛（期望最高且 ≥15 笔）不等于稳健结论。

## 8. 与回测相关的持久化

回测经 `/api/backtest` 把逐笔结果与批次写入 PostgreSQL（见 `docs/DATABASE.md`）；实时信号经 `/api/signals` 以 `origin='live'` 写入。浏览器静态模式下同一批 handler 写浏览器内 PGlite（会话级，关页即失）。

## 当前M/W标注与本章的边界

本章描述Shift+C与原版页面的交易模型，不是新版M/W标注判定。图上M/W只走 `signals/mwStory.ts`，没有19因子概率；删除的旧TradePanel不是确认引擎本身。详见 [标注模块说明](../src/vela/signals/README.md)。
