> 资料性质：历史研究/实施规格，不是当前接口清单或收益证明。当前独立成交/陷阱/CVD/SMC条目已并入M/W统一详情，实际规则与接线以 [项目总文档](../../../README.md) 和 `mwStory.ts` 为准。

# 双顶 / 双底关键位订单流标记：研究笔记与实施规格

**状态：研究完成，首版已按本文规格实施（关键位成交反应、局部真实覆盖、完整两腿比较）；未改交易回测或下单逻辑。**

> 本文定义的是图表上的事件观察标记，不是自动交易信号。它不会声称知道市场参与者身份、真实止损单、挂单“冰山”或未来胜率。下面注明了研究数据、可迁移范围和本应用的硬性数据边界。

---

## 1. 结论：建议做“关键位成交反应”，不做另一个“预测方向概率”

目标是在现有已确认的 M/W 双顶双底第二次测试附近，画一个贴近关键价位的订单流标记，客观回答：

1. 第二次测试刺过关键位多少（价格 / ATR）；最终有没有**收盘**回到位内？
2. 测试 K 和收盘确认 K 的 OKX 真实 taker 主动买入额、主动卖出额各是多少，占该 K 线总成交额的比值是多少？
3. 若第一腿、第二腿及中间每根 K 线都有真实逐笔覆盖，第二次推进的同向 taker 压力是否比第一腿弱？
4. 哪些读数是价格结构、哪些是真实成交、哪些数据没有覆盖？

首版不把这些条件加权成“上涨概率 73%”或“机构吸收”。顶端格式建议为 **「扫高收回 · 真实成交」**，在测试 K / 确认 K 子项列出归一化 delta；无真实成交时不产出真实订单流标记。用户显式开启近似后，另显示 **「≈ 扫高收回（仅价格）」**，没有任何主动买卖方向措辞。

这个设计可以利用项目已经有的价格形态识别、真实 OKX 成交和 `pd-annot-under/over` 画布图层；不会重写交易引擎，不会为了产生更多标记降低形态标准，也不把交易策略回测的概率套到标注上。

---

## 2. 概念先分清：市面常见“订单流指标”不是同一种数据

| 名称 | 数据／计算 | 适合回答 | 不能据此声称 |
| --- | --- | --- | --- |
| **Taker Delta / Trade-flow imbalance (TFI)** | 逐笔 `side` 的主动买 USDT − 主动卖 USDT；可归一化为 `(B−S)/(B+S)` | 某个 K 线或测试窗口内，主动吃单方向和强度 | 净持仓、买家／卖家身份、未来涨跌必然性、盘口挂单供需 |
| **CVD** | 在同一真实逐笔口径上，对每根 bar delta 连续累计 | 价格两次相似极值之间的真实主动成交累计变化 | “累计值绝对高所以必涨/必跌”。CVD 的绝对零点依赖起始时间 / reset；历史缺口会破坏比较 |
| **Footprint / Bid×Ask per price** | 每个 tick / 价位格上分别累计主动买卖成交量 | 攻击在关键位哪个具体价位成交、该价位的逐价差 | 没有逐笔成交价分布就不能由 OHLC 或整根 K 的 delta 还原 |
| **Volume Profile / POC / VAH / VAL** | 按价格分箱成交额或成交量 | 成交聚集在哪里、价位分布 | 不含买卖主动方向时，不是 Delta / OFI |
| **LOB volume imbalance / queue imbalance** | 某时刻 best bid/ask 或多档挂单数量差 | 当时显示在盘口里的队列不对称 | 挂单会撤/移；单快照不是成交，不能据此声称真的有人要买／卖或一定存在承接 |
| **OFI (Order-Flow Imbalance)** | 按 bid/ask 报价与队列大小的变化，累计限价单新增、撤单和市价成交造成的 best-queue 变化 | 一段时间内最佳报价端完整的供需事件失衡 | 只用成交 `B−S`、一个 books 快照或 K 线 delta 就称 OFI |
| **吸收 / exhaustion** | 常用 footprint 概念：大量某向主动成交但价格推进很小/失败；exhaustion 是推动成交逐渐枯竭 | 结合局部价格反应描述“推动没有获得相称结果” | trades tape 看不到对手方是否被动加单、身份或冰山订单，所以只能称“推进失败/疑似承接候选” |
| **Sweep / stop run** | 可由价格越过此前确认的极值并收盘收回来识别 sweep-reclaim | “价格扫位后收回” | 交易所公开成交中不含用户 stop 委托，不能断言“真实触发了止损”或“多头被套” |

零售平台的 Footprint “对角 3:1 imbalance”“吸收”界面标准也不是市场统一标准；通常是用户可调的价位分箱和比例，而非经过跨市场证明的常数。本项目应先显示有口径的数据，不复制彩色经验阈值并将其包装成概率。

---

## 3. 原始文献审查：结论及外推界限

### 3.1 技术形态需要可重复识别和统计检验

Lo, Mamaysky & Wang, **“Foundations of Technical Analysis: Computational Algorithms, Statistical Inference, and Empirical Implementation”**，NBER Working Paper 7613 / *Journal of Finance* (2000)。他们把形态识别形式化为非参数算法，并比较条件与无条件收益分布；摘要报告若干技术指标在其 **1962–1996 美国股票日线**样本中提供增量信息。

- 对项目的启发：定义清楚的摆动点、测试时点和收盘确认；标注应可重复、因果，不能靠肉眼随意画形态。
- 不能推论：该研究不是 OKX 永续、不是 5 分钟级别，也没有验证这份代码的二次测试参数有优势。
- 来源：[NBER w7613](https://www.nber.org/papers/w7613)，[论文 PDF](https://www.nber.org/system/files/working_papers/w7613/w7613.pdf)。

### 3.2 OFI 是盘口事件失衡，不是 trade delta

Cont, Kukanov & Stoikov, **“The Price Impact of Order Book Events”**，*Journal of Financial Econometrics* 12(1), 47–88 (2014)，[arXiv:1011.6402](https://arxiv.org/abs/1011.6402)。研究 NYSE 50 只股票的高频 quotes/trades，以最佳 bid/ask 报价和队列数量变化来汇总市场单、限价单、撤单的贡献。发现同区间短时中间价变化与 OFI 线性相关，斜率随订单簿深度变化；同区间价格解释中 OFI 比单纯 trade imbalance 更稳。

- 对项目的启发：事件型订单簿失衡与主动成交差需要分开命名；流动性深度会改变同一成交量的价格影响。
- 不能推论：论文主要是**同时区间的 price-impact 解释**，不是“在双顶关键位之后价格一定反转”。其股票结果也不是本项目永续交易的回测结果。

### 3.3 LOB volume imbalance 的预测对象与策略不同

Cartea, Donnelly & Jaimungal, **“Enhancing Trading Strategies with Order Book Signals”**，*Applied Mathematical Finance* 25(1), 1–35 (2018)，DOI [10.1080/1350486X.2018.1434009](https://doi.org/10.1080/1350486X.2018.1434009)。其 Nasdaq 高频限价簿数量不平衡指标用于预测下一笔 market-order 方向和 market-order 后的即时报价变化，并嵌入考虑 inventory penalty 的限价执行 / 做市模型；论文用 11 只股票的先前样本校准，再用之后样本评估策略。

- 对项目的启发：真正的盘口 snapshot imbalance 若要加入，应明确是**队列快照**，并同时看 spread/depth 与报价时间；不等同于成交差。
- 不能推论：这是 equity order-book 的高频交易执行研究，不是加密货币 5m double-top/bottom 的 reversal 概率。
- 来源：[作者版本 PDF](https://kclpure.kcl.ac.uk/ws/files/115267447/Enhancing_Trading_Strategies_CARTEA_Accepted_24_Jan_18_GREEN_AAM.pdf)。

### 3.4 Bitcoin 研究有流数据，但 horizon / venue 必须对上

Scaillet, Treccani & Trevisan, **“High-Frequency Jump Analysis of the Bitcoin Market”**，*Journal of Financial Econometrics* 18(2), 209–232 (2020)，DOI [10.1093/jjfinec/nby013](https://doi.org/10.1093/jjfinec/nby013)。利用 Mt. Gox 2011–2013 有交易者 ID 的逐笔样本，报告 jumps 会聚集，order-flow imbalance、aggressive trader proportion 和 bid/ask spread 与跳跃发生有关。对象是早期零售化交易所的 jump 和流动性，不是现代 OKX 关键位反转。

Koutmos & Wei, **“Nowcasting Bitcoin’s Crash Risk with Order Imbalance”**，*Review of Quantitative Finance and Accounting* 61, 125–154 (2023)，DOI [10.1007/s11156-023-01148-1](https://doi.org/10.1007/s11156-023-01148-1)，[PMC 全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC10040314/)。数据是 Bitstamp 2013–2023 日线，OI 用 buyer-initiated 与 seller-initiated volume 的归一化比值，目标是 crash-risk nowcast（logistic / GEV）。文中简单线性 return-vs-imbalance 拟合很弱（图示 R²≈0.013），且改变分类 cutoff 会改变 false positive / false negative。

- 对项目的启发：归一化 signed volume 是一个有解释力的**观测量**；不同 horizon、非线性与错误分类需明示。
- 不能推论：日级 crash 风险或 Mt. Gox jump 不等于 OKX 5m 的双顶概率。

### 3.5 Stop clustering 研究不能证明图上的 wick 就是“扫止损”

Osler, **“Stop-Loss Orders and Price Cascades in Currency Markets”**，NY Fed Staff Report 150 (2002)，后发表于 *Journal of International Money and Finance* 24(2), 219–241 (2005)，[NY Fed 报告](https://www.newyorkfed.org/research/staff_reports/sr150.html)。该研究使用外汇市场的实际价格触发委托资料，分析 stop 与 take-profit 聚类及触发后的级联。

- 对项目的启发：价格触发区、正反馈成交和快速延续值得研究；扫位后未收回和收回是不同路径。
- 不能推论：OKX 公共 trades 不告诉程序任何用户的 stop 位置或持仓身份。因此本项目只能写“扫位收回候选”，不能写“止损已触发/多空被套”。

### 3.6 CVD / Footprint 的数据口径有硬要求

Sierra Chart 官方 **Cumulative Delta Bars – Volume** 文档：[计算规则](https://www.sierrachart.com/index.php?page=doc%2FStudiesReference.php&ID=292)，[帮助说明](https://www.sierrachart.com/index.php?page=doc%2Fhelpdetails71.html)。CVD 是 Ask-traded volume − Bid-traded volume 的累计；精度取决于 feed 提供的历史 bid/ask 分类、tick 数据与 reset/session anchor，缺失历史 Bid/Ask 时 CVD 会停值或不完整。

- 项目从 OKX `side` 取 taker buy/sell，因此它是**真实逐笔主动成交差**，是自己的明确交易所口径；不能默认与按价是否在 bid/ask 的 Sierra CVD 数值完全一致。
- CVD 比较形态两次测试应比较同一连续 covered segment 中的 CVD swing 极值 / 分腿 signed ratio。滚动起点会改变绝对累积值；不同 reset 的 raw CVD 绝对值不可直接比较。
- Footprint 展示每个价格格中的 Bid×Ask 交易量，现有 bar-level 总 buy/sell 会丢失价位分布，不能事后凭 K 线重建。

### 3.7 最新预印本提示效果不稳定，不作为事实锚点

Schmalz 2026 SSRN working paper **“Order-Flow Imbalance and Short-Horizon BTC/USDT Returns: A Signal That Kept Needing More Scrutiny”**：[SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7227998)。在 Binance.US L2 测 1–10 秒 mid-return；样本从约 7 天扩到 9 天时 OOS OFI 结果变 null/负，后来检查数据流程、加 purge/embargo 扩到约 17 天后才变小幅正；作者指出一元 OFI 不稳定，AR(1) 常可匹配/超过它。

- 这是一篇**非同行评审预印本**，不能当作“OFI 已证实有用”的定论。
- 对当前标注任务的价值是研究方法警示：数据捕获和样本扩充能改变结果；单次 walk-forward 或少数信号不能当作成功证明。

---

## 3.8 常见订单流图表指标：哪些值得进入本项目

| 常见指标 / 概念 | 关键用途 | 对本项目的建议 |
| --- | --- | --- |
| **bar Delta / taker volume ratio** | 逐笔吃单方在单根 K 的净方向。量纲归一后可在第二次测试 K 与确认 K 上展示。 | **第一版首选**。用 `B−S` 与 `(B−S)/(B+S)`，显示成交额、ratio 和 ≥85% 覆盖；不单独翻译成涨跌概率。 |
| **测试腿 Delta 减速** | 比较一顶/底和二顶/底的推进方实际成交压力。 | **数据覆盖时次选**。从两段“反向摆动点→测试极值”的局部推进段分别算 normalized taker ratio；两段任一不连续或 coverage 不足就 unavailable。不能把中间颈线回撤算进第二条推进腿。 |
| **CVD divergence** | 价创新高 / 新低时，真实累计主动成交的局部 swing extreme 未跟进。 | 可作更严格的二级标注；必须同一连续真实数据、固定锚点 / reset、比较局部 CVD 极值。当前近端回补通常不足以跨越两个相距较远的测试，**不覆盖时不画**。 |
| **Footprint / Numbers Bars** | 每个价位格显示 bid × ask、delta、总量；可查看测试价附近的逐价成交、diagonal imbalance。 | 对“价位附近的订单流标记”很有价值，但当前聚合后的 `FlowBar`/`FlowTrade` 丢了价格，不能现成生成；作为后续单独数据工程，不在第一版冒充。Sierra 官方说明需准确 bid/ask tick 数据，数据服务历史覆盖不足会使 footprint 不完整。 |
| **LOB queue imbalance** | 一个时点 best bid/ask（或多档）展示挂单量的相对差，Cartea 等研究它与下一个 MO 符号/即刻报价修订的关系。 | 只能作为盘口快照。可能很快撤单或移动；不同于已成交买卖额，也不同于 OFI。若未来显示，须注明快照时刻和深度档数。 |
| **Top-of-book OFI** | 跟踪 bid/ask 的最优报价与队列变化，涵盖挂单、撤单、吃单。 | 当前没有该数据管线。需实现 `books` initial snapshot + seqId 校验的 incremental merge；之前不能用 `bookImbalance` 的单点值称 OFI。 |
| **Absorption / failed push** | 单向 taker 成交很多，但价位没有相应推进或收盘重新回到关键位内。 | 用 tape-only 只称**“成交推进失败 / 疑似承接候选”**，并同时给价格结果和 taker ratio。看不到被动队列，不能断言机构/冰山吸收。 |
| **Volume profile / POC / value area / VWAP** | 按价统计成交分布或成交均价，用于定位价值区 / 已成交密集区。 | 可作价格背景或独立图层，不是买卖方向证据；当前信号运行数据没有 per-price trade bins，需另建 profile 计算后再用。 |
| **Large prints / whale trade** | 逐笔名义额处于局部异常分位的成交。 | 阈值受合约面值、时段与流动性影响；必须按标的和时段做分位标准化、加样本数，不把“大单”推断成知情/机构账户。不是第一版依赖项。 |
| **VPIN / toxicity** | 量桶化成交后的买卖不平衡指标，常用于 adverse-selection/流动性风险研究。 | 更适合量化统计研究，不是单个 M/W 关键位的直接“买卖点”；目前数据窗口和校准不足，不建议先做成侧栏灯号。 |

特别注意：知名 footprint 平台显示的 diagonal ratio（常见 3:1 等）是平台/用户设定的价位比较方式，不是跨 BTC、ETH、SOL、tick size、交易所通用的实证阈值。测试标记应先显示归一化观察值；不能从教学平台的图示直接移植固定门槛。


---

## 4. 当前项目审计（基于当前源码，不以旧任务卡代替代码）

### 可用数据

- `src/vela/okxProvider.ts`：图表 OHLCV REST 历史 + business-WebSocket K 线；Provider 同时维护 `barsHub`，标注 runtime 读到的是图表同源 candles。
- `src/vela/signals/runtime.ts`：通过 `barsHub` 监听 K 线和 `signalStore`；订单流打开任一 flow 类型时走 `syncFlow`；本地每约 1.2 秒聚合计算。
- `src/quant/flow.ts`：public `trades` WebSocket + `history-trades` REST，按 `px × contract size × ctVal` 聚合名义成交额；逐笔 tradeId 去重；`hasRealFlow` 要求 buy+sell ≥ candle quote turnover 的 85%。默认回补近端 5m 8 根 / 其他周期约 4 根；历史跨度远于此时通常没有连续真实覆盖。
- `FlowBar` 保留每根 K 线的 buy/sell 总额和来源；最近的 `FlowTrade` 保存时间、side、notional，**目前不保存成交价 px**。
- `ctx.real[i]` 表示完整真实 taker 覆盖；无覆盖时 `ctx.delta` 退回 `approxDeltaAt`。标注的实际真实来源必须由 `ctx.real` / `FlowSnapshot` 单独判断，不能只看数值。

### 当前八类标注 / 一手代码位置

- 双顶双底：`src/vela/signals/patterns.ts`，价格/ATR 状态机，first/second/neck/close-confirm 索引；不依赖原交易 scanner 成本与 R:R 筛选。
- 诱多/诱空候选：`src/vela/signals/analyze.ts`，扫位深度 + 收盘收回 + 测试/确认两根真实 taker 的方向；若真实证据不全且用户开近似，只会写“扫高/扫低收回 · 仅价格”。并非已观察到 stop。
- CVD 背离：当前要求第一测试到第二测试的**每一根**都真实、且 K 线时间戳连续，否则不画；计算用实际 FlowBar 的 buy/sell。
- deltaImpulse：真实 taker 异动和可选 OHLC 量价代理标题分别命名；真与 proxy 使用独立去重状态。
- Breakout retest：事件主因是价格首次收盘确认守住；只有突破 K 和回踩确认 K 两根都真实覆盖且 flow 方向相容，detail 才称有两根成交佐证。它不因中间某根无流而假称整个过程都有 OFI。
- `SignalType.retest` 当前归类为 **结构**；flow 组是诱多、诱空、CVD、deltaImpulse。

### 当前能力明确不能回答的事情

1. 不观察公开数据以外的用户止损 / 仓位、成交人身份、持仓被套、清算或交易动机。
2. 不知道被动对手盘是否新挂、撤单、补单；所以 tape-only 只能判“成交推进失败/疑似承接”，不能确认冰山或被动吸收。
3. 没有 `books5` / `books` 更新 feed；不能算 bid-ask size imbalance，更不能算 Cont et al. 的事件 OFI。
4. FlowBar 不保留逐笔价格；不能画 key level 上方/下方 footprint cells、逐价吸收/堆叠 imbalance 或真实 volume-at-price。
5. 双顶首摆动在 `right=5` 根后才确认。若第二次测试在首摆动右确认之前已发生，单纯“后来确认的 pivot + 之后的测试”逻辑不能倒回去将之前事件重命名为测试；这一类要选择漏标还是明确标延迟识别，不能回看之后数据伪装实时先见。

---

## 5. 已实施首版：在双顶 / 双底关键位标记成交反应

### 5.1 事件锚点与可见内容

新增一个独立标注类型：**“关键位成交反应”**，只附属于价格识别器产生的 M/W 第二次测试，不给每一条任意 swing line 都贴订单流标签。

- 关键位线仍从第一次 swing `firstTs` 延伸到第二次测试的确认 K；二次测试 event 落在第二测试或实际确认 K 的 bar index，hover 详情同时给出两者时间和 price level。
- 第一行：`双顶/双底 · 关键位成交反应`，显示关键位价、刺穿幅度（ATR / ticks）、测试 K 与确认 K 是否收回。
- 第二行：真实/近似/无覆盖 badge；显示 test K 的 `B USDT / S USDT / signed delta / r` 和 confirmation K 同列数值；注明每根实际 coverage。
- 三态文案，而非概率：`反转侧主动成交占优`、`测试/确认分歧（交叉）`、`推进侧主动成交占优 / 暂无方向确认`。如果窗口有效但 delta 近中性，就显示原始近中性观察，不构造信号。
- 缺失真实成交：默认不生成这个 flow 层；价格侧 M/W 仍正常画。若用户允许 approx，只生成 `≈ 价格扫位收回` / `≈ K 线量价代理`，浅色、带来源；不生成 CVD，也不标 `真实主动买/卖`。
- 点击列表项：在图上定位第二次测试 + 关键位 + 颈线，不能把浮动盈亏当成标注证据。

### 5.2 计算口径（第一版只使用可以从现有 feed 证明的项）

**K 线真实 coverage**：继续复用 `hasRealFlow(bar, candle.v)` 的 85% 条件；必须区分 test candle 和 confirmation candle 的覆盖，不能拿整段“至少有一点真实数据”当全段真实。

每根 K 独立计算：

- `total = B + S`
- `delta = B − S`
- `deltaRatio = delta / total`，仅 `total>0 && hasRealFlow` 才有效，值在 [-1,+1]。
- `volRatio = candle.v / previous-20-complete-bars average`。需要把过去 20 根有效 candles 定义清楚；缺 bar 时必须有连续时间戳检查，不静默将前 20 个数组元素当连续 20 分钟/100 分钟。

方向归一化：

- Double top 的**测试推进方**是 taker buyers，**反转方**是 taker sellers；
- Double bottom 的测试推进方是 taker sellers，反转方是 taker buyers；
- 方向转换仅用于显示“相对这个 M/W 的推进侧 / 反转侧”，不把 OHLC close position 换算成真 taker flow。

扫位：

- top depth = `(testHigh − priorHigh)/ATR`; bottom depth = `(priorLow − testLow)/ATR`。
- 同时记录已确认 K close 是否回到 level 内侧。
- 扫位阈值、近似 tick 容差先引用 current scanner 的 ATR geometry；`0.05 ATR` 只可作实现初值，必须写入规则说明，并通过样本覆盖统计后再调。

**第一腿/第二腿同向推进强度**：

- 候选腿用局部反向摆动 → 极值推进段，不把颈线回撤 bar 混进第二推进腿；需要在 Pattern 输出两个 leg start/end index（因果确认，不从未来 pivot 读取）。
- 第一腿、第二腿各自 `Σ(B−S)/Σ(B+S)`，同时报告绝对流额、bars 和覆盖比例。
- 两段内每根必须真实完整且 timestamp 连续；任何 missing bar → `腿比较无覆盖`。非零 coverage 不足不能猜。
- top 比较 buy push：`r2<r1` 只描述第二腿主动买成交占比下降；bottom 比较 sell push：把 `−r` 作为 sell push 方向。即便成立，也只是证据，不叫“反转概率”。

**CVD**：若提供 swing-to-swing CVD，统一从第一推进腿起点 reset；只使用连续真实 covered bars，比较第一测试与第二测试的局部极值（top 取对应买方累积高点、bottom 取卖方累积低点），不能只比较裸 raw CVD 水平或跨 reset 的绝对值。当前 8 根近端 history 回补通常不足以覆盖第一/第二测试跨度，所以缺数据是预期，UI 应诚实显示而非补代理。

### 5.3 吸收、OFI 与 footprint 的分期

- V1 可显示“价格扫位后收回 + 真实 aggressor 差”。若突破侧 taker volume 很大但收盘失败，措辞为**“突破侧主动成交较强，但收盘未守住关键位（疑似对手方承接）”**。不写“已吸收/机构进场/止损被扫”。
- 真 Footprint：先扩展流缓存，保留**真实成交价 px**、side、合同→notional 和 tickSz；按 instrument tick 或明确固定 grouping 构建 buy/sell price cells。覆盖期限、重连去重和压缩策略另立子任务；bar-level FlowBar 无 px，不能现算。
- 真 OFI：若确需，单独新增 `books` 增量同步器（首个 snapshot、按 price 更新数量、size=0 删除、`prevSeqId/seqId` 连续检查、reconnect/resnapshot、market isolation），在 best bid/ask 队列变化上计算 event OFI。不要只对一次 `books5` ask/bid totals 做减法后称 OFI；snapshot imbalance 是另一种、易撤单的观测。
- OI/清算/止损触发没有可靠可用来源就不实现。以后的每个 marker 必须记录 observation/data source，不凭 pattern 倒推参与者身份。

---

## 6. 推荐的实施验收（另起代码任务后执行）

1. 顶部/底部真实 fixture 镜像：测试 K 与确认 K 的 taker sides 对称、label/level/确认时间相反对称。
2. 关键位 sweep-reclaim，test/confirm 各覆盖真实成交：marker 包含两个 ratio、coverage 和 source；0.849 / candle volume 不完整时不得标真实。
3. 没有 flow、REST 回补被限频、test flow 有而 confirm flow 缺、确认流方向冲突：价格 M/W 不消失，flow detail 分别显示“无覆盖/部分覆盖/方向分歧”，绝不当作中性零或实流确认。
4. 近端 8 根 coverage 而 M/W 两腿跨更久：CVD/腿比较 unavailable；不存在静默 OHLC 补洞。
5. 交易成本 / `minRR` 极低：视觉形态仍能标注；老交易 scanner / 回测结果保持不变。
6. 对第二测试之后追加任意未来 K/成交，之前事件 ID、时间、price-level ratio/detail完全不变；确保没有 later confirm、未来 CVD、未来回踩结果倒灌到先前 marker。
7. 相同 keylevel 连续 ticks、REST/WS overlapping tradeId、WS 重连、切币、5m↔15m 切换不重复累加或跨市场串流。
8. 浏览器验收同时抓标记文本、Canvas 事件数、真实来源 badge、每种开关后的画面；价格只触碰 key level 但没有真实成交时，不应出现 real-flow marker。
9. 若后续尝试从 marker 推出交易 edge，另有样本外验证：预先固定目标 horizon 与“先到目标/先 adverse excursion/超时” label，purge/embargo 重叠事件，至少按 BTC/ETH/SOL × 5m/15m 展示 n、覆盖率、Wilson CI、precision/recall 和扣费后 markout；绝不只挑筛选后赢的例子。
