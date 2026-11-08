# 短线加密交易策略研究 · 文献综述与构建手册

> 本文档为纯研究文档，不修改任何业务代码。基于 2026-11 对公开学术文献（期刊论文、
> BIS/CEPR 工作论文、arXiv）与可复核业界回测的系统检索整理而成。
> 所有结论均标注出处；相互矛盾的证据一并保留。**本文不构成投资建议，历史统计不代表未来收益。**

---

## 目录

1. [研究范围与证据分级](#1-研究范围与证据分级)
2. [六类有文献支撑的短线优势](#2-六类有文献支撑的短线优势)
3. [策略构建通用管线（八步）](#3-策略构建通用管线八步)
4. [短线实操手册](#4-短线实操手册)
5. [与 PULSEDESK 的映射](#5-与-pulsedesk-的映射)
6. [参考文献](#6-参考文献)
7. [风险与诚实边界](#7-风险与诚实边界)

---

## 1. 研究范围与证据分级

**短线定义**：持仓从数分钟到数小时（日内），信号周期 1m–15m，最长按 1h/4h 定方向。
不含跨日趋势跟踪与长期配置。

证据分级约定：

| 级别 | 含义 |
| --- | --- |
| A | 同行评审期刊 / BIS·CEPR 工作论文，多交易所或长样本 |
| B | arXiv / SSRN 预印本，方法清晰但未必过评审 |
| C | 业界可复核回测 / 数据测量（非收益承诺） |
| D | 业界惯例（SMC/ICT 等），缺乏严格学术检验 |

---

## 2. 六类有文献支撑的短线优势

### 2.1 日内动量与反转（证据 A）

**核心文献**
- Wen, Bouri, Xu & Zhao (2022), *Intraday return predictability in the cryptocurrency
  markets: Momentum, reversal, or both*, North American Journal of Economics and Finance 62.
  用 BTC 2013-03~2020-05 高频数据、33 个半小时收益对：**12 对呈动量、21 对呈反转**；
  模式受跳跃、FOMC 公告与流动性水平调节；ETH/LTC/XRP 同样存在；择时策略经济价值
  高于买入持有基准。
- Zaremba, Bilgin, Long, Mercik & Szczygielski (2021), *Up or down? Short-term reversal,
  momentum, and liquidity effects in cryptocurrency markets*, International Review of
  Financial Analysis 78. 横截面上：**小流动性币短期反转，最大最活跃的币呈日度动量**——
  流动性是动量/反转的分界变量。
- Kość, Sakowski & Ślepaczuk (2019), Physica A 523：100 个币上短期反转（contrarian）
  效应强于动量。
- *Dynamic time series momentum of cryptocurrencies* (2021), NAJEF 59：20 个币、
  分钟到月的多频率上动量段显著更长更多；动量段内存在波动骤增并触发同向价格脉冲的
  「关键价位」。

**构建逻辑**
1. 边缘来源：晚知情交易者追入（动量）+ 对非基本面信息过度反应（反转，加密特有）。
2. 信号：用当日已实现的前段收益预测后段收益（如首个半小时 → 尾盘半小时）；
   或局部极值：触局部低点做均值回归、破局部高点做趋势跟随（Padyšák & Vojtko 2022）。
3. 关键过滤器：**流动性分层**（BTC/ETH 用动量口径，小币用反转口径）、跳跃检测、
   宏观事件日历。
4. 失败模式：把反转规律用在趋势日；把动量规律用在低流动性震荡日；忽略费用。

### 2.2 订单流 / 微观结构（证据 A/B）

**核心文献**
- *Order flow analysis of cryptocurrency markets* (2019), Digital Finance 1（BitMEX
  XBTUSD 永续逐笔+报价）：**成交流不平衡（trade flow imbalance）比总订单流不平衡
  更能解释同期价格变化**；在足够长的聚合区间上价格变化与 OFI 呈强线性关系。
- Xu, Gould & Howison (2019), *Multi-Level Order-Flow Imbalance in a Limit Order Book*,
  arXiv:1907.06230（BTC 订单簿）：多档 OFI 优于仅最优档；价格冲击与 OFI 近似线性。
- Kolm, Turiel & Westray (2023), *Deep order flow imbalance: Extracting alpha at multiple
  horizons from the limit order book*, Mathematical Finance 33(4):1044-1081：
  深度模型直接从 LOB 事件提取多期限 alpha，OFI 是强基线特征。
- Wang (2025), *Exploring Microstructural Dynamics in Cryptocurrency Limit Order Books:
  Better Inputs Matter More Than Stacking Another Hidden Layer*, arXiv:2506.05764
  （Bybit BTC/USDT 100ms~秒级 LOB）：**特征工程/预处理带来的增益大于堆网络层数**；
  逻辑回归、XGBoost 等可解释基线常与 DeepLOB 等深模型打平。
- Gould & Bonart (2015), *Queue Imbalance as a One-Tick-Ahead Price Predictor*：
  最优档队列不平衡预测下一 tick 方向。

**构建逻辑**
1. 边缘来源：买卖压力不对称先于价格移动；被动挂单撤单/吃单方向包含短期信息。
2. 特征：taker 买卖量差（delta）、CVD、多档深度不平衡、队列不平衡、
   成交强度（trades/s）、大单占比。
3. 信号：不平衡超过阈值 → 顺着压力方向做数秒~数分钟；或作为**确认层**过滤
   价格形态信号（本项目用法）。
4. 关键结论：加密上**成交流（taker tape）即可获得大部分信息**，不必先建全量 L2 管线；
   聚合到 5m 级别可降噪（Digital Finance 2019 的线性关系在足够聚合区间成立）。
5. 失败模式：把 taker delta 误称为订单簿 OFI（两者不同，前者不含撤挂单信息）；
   在数据缺口上伪造成交；用 100ms 级信号却按秒级执行。

### 2.3 技术规则与区间突破（证据 A，但有矛盾证据）

**核心文献**
- Corbet, Eraslan, Lucey & Sensoy (2019), *The profitability of technical trading rules in
  the Bitcoin market*（1 分钟级 BTC）：移动平均（VMA）与交易区间突破（TRB）规则
  有预测力，1% 过滤带优于 0%。
- Gerritsen, Bouri, Ramezanifar & Roubaud (2020), Finance Research Letters：TRB
  规则可稳定跑赢买入持有。
- Grobys, Ahmed, Sapkota (2020), Finance Research Letters：11 个最活跃币上
  MA(1,20) 规则年化超额约 8.76%（2016-2018 样本）。
- **矛盾证据**：*Do technical trading rules outperform the simple buy-and-hold strategy
  in the cryptocurrency market?* (2024, Journal of Digital Assets 类刊物)：99 个币、
  更新样本上单指标/双指标组合与买入持有**无统计差异**。
- ORB 加密实测（C，Altrady 2026，Binance BTC/USDT 5m，2025-10~2026-09）：
  纽约开盘 30 分钟区间在 **98% 的交易日会被突破，但首次突破方向 52% 向上（≈抛硬币），
  只有约 48% 的突破再走一个区间高度**；UTC 日开区间更窄更脏（50% 的日子双边都破）。
- ORB 移植回测（C，Stoic Research 2026）：14:00 UTC 后首根 1h K 线为「合成开盘区间」，
  5m 收盘突破 + 高于前 3 根量能过滤，BTC/ETH/SOL 组合 Sharpe≈0.92（未过度调参）。

**构建逻辑**
1. 边缘来源：趋势日捕获（盈亏比取胜而非胜率）；止损/追单在区间边缘聚集。
2. 信号：区间（开盘区间/亚盘区间/前日高低）+ **收盘确认突破**（非触碰）+
   量能过滤（≥1.5×均量或高于前 3 根）+ 可选回踩确认。
3. 数据说话：裸突破≈无边缘（方向近 50/50），**过滤器才是策略本体**——
   这与本项目「两根收盘确认 + 放量/订单流同向 + 回踩守住」的设计一致。
4. 失败模式：触碰即入场（假突破吃掉利润）；在低波动日交易；不设时间止损。

### 2.4 时段季节性（证据 A，与本项目交易时段标注直接相关）

**核心文献**
- *The crypto world trades at tea time: intraday evidence from centralized exchanges
  across the globe* (2024, Springer, DOI 10.1007/s11156-024-01304-1)：38 家交易所、
  1940 个交易对、2018-2021 小时级数据。**交易活动、波动率、非流动性在 16:00–17:00 UTC
  共同见顶**；收益在 01:00–05:00 UTC 最低、15:00–16:00 UTC（欧美股市同开）最高；
  模式跨大洲/时区高度一致 → 由全球信息流驱动而非本地交易者行为。
- Padyšák & Vojtko (2022), *Seasonality, Trend-following, and Mean reversion in Bitcoin*,
  SSRN 4081000（Gemini 小时级 2015-10~2022-02）：**21:00–23:00 UTC 平均收益显著为正**
  （全球主要股市均已收盘）；「21:00 买入 23:00 卖出」的 2 小时策略年化约 33%、
  波动 20.9%、最大回撤 -22.5%，风险调整收益约为持有 BTC 的两倍；
  局部极小值处均值回归、局部极大值处趋势跟随。
- Baur, Cahill, Godfrey & Liu (2019), Finance Research Letters 31:78-92：7 家交易所
  1500 万+观测；收益的时段异常存在但**不持久**；交易活动的时段/周末差异持久。
- *Scheduled FOMC statements and intraday macro event risk in cryptocurrency markets*
  (2026, Finance Research Letters)：FOMC 声明后首小时（14:00-15:00 ET）BTC 平均
  绝对小时收益从 0.66% 跳到 1.25%（+0.59pp，p<0.001），ETH +0.65pp；
  美元成交量放大 2.54×/2.81×；安慰剂检验排除时段季节性解释。
- 后续研究（B）：BTC 日内波动分布近十年**向美国交易时段迁移**（机构化/ETF 效应）。

**构建逻辑**
1. 边缘来源：全球信息流与机构作息在 24/7 市场上「投下影子」；
   流动性提供者作息造成时段性的深度/点差差异。
2. 用法 A（择时窗口）：只在高流动时段做突破/趋势（约 13:00–17:00 UTC），
   只在低流动时段做区间回归（约 00:00–07:00 UTC）。
3. 用法 B（事件规避/事件交易）：FOMC/CPI 发布前后波动近乎翻倍——要么降杠杆回避，
   要么专做事件后动量，但必须按事件波动调仓位。
4. 用法 C（结构性锚点）：00:00 UTC 日开 + 08:00/16:00 资金费率结算 +
   亚盘高低点（AH/AL）作为全天流动性参照。
5. 失败模式：把不持久的「收益时段异常」当稳定 alpha（Baur 2019 警告）；
   更稳的是「波动/流动性时段异常」——用它选策略与仓位，而非直接赌方向。

### 2.5 永续合约结构：资金费率、基差与清算级联（证据 A/B）

**核心文献**
- Schmeling, Schrimpf & Todorov, *Crypto Carry*, BIS Working Paper 1087 (2023, 修订
  2025; CEPR DP20719)：BTC/ETH 期现 carry 峰值可超 **40% 年化**且时变剧烈；
  来源 = 追涨散户的杠杆多头需求 + 空头侧套利资本受监管/保证金/融资约束；
  高 carry 对未来空头侧清算有预测力。
- Binance 18 币研究（引于 SEC 评论信/系统综述）：BTC USDT 本位 carry 交易
  样本内年化 Sharpe≈8.76（币本位≈4.93）——**样本内、危机前**，不可外推。
- Ackerer, Damoulas 等 (2024/2025)：永续无套利定价 = 现货在随机时刻的风险中性期望；
  He et al. (2022)、Kim & Park (2025, arXiv:2506.08573) 给出资金费率设计与复制组合。
- Garcia Seuma (2026), *Where does the criticality live? …seven crypto-perpetual
  liquidation cascades*, arXiv:2607.27070：七次 BTC 大清算级联（含 2025-10-10 约
  $19B 事件）；**没有任何单一变量在所有事件前都有预警**；唯一跨事件稳健的是
  taker 订单流方差压缩（总体级前兆，非逐事件警报）；内生累积型与突发新闻型
  级联结构不同。
- Neubert, Rams & Gruhn (2026), SSRN 6639558 系统综述：永续把风险「搬进」资金费率
  窗口、杠杆选择与清算级联，而非消除风险。

**构建逻辑**
1. 边缘来源：杠杆多头需求支付的「保险费」（funding）；强平引擎的价格不敏感市价单。
2. 策略 A（delta 中性收 funding）：现货多 + 永续空，赚资金费率；风险 = 基差走扩、
   交易所/托管风险、funding 转负。属市场中性，非方向短线，但**funding 极值本身
   是短线情绪指标**（极端正 funding = 多头拥挤，扫荡概率升高）。
3. 策略 B（清算级联反向/顺向）：监测 OI 骤降 + 成交爆量 + 长影线的强平指纹；
   级联末端的流动性真空常给出极端价回归机会。文献明确警告**不可依赖单一前兆变量**。
4. 策略 C（结算窗口效应）：00:00/08:00/16:00 UTC funding 结算前后的仓位调整流。
5. 失败模式：把 carry 当无风险；在级联中接飞刀不设硬止损；忽略 funding 预测
   本身在 stress 期失真（模型与实测背离）。

### 2.6 做市与跨市场引导（证据 A；散户可行性低）

**核心文献**
- Avellaneda & Stoikov (2008), *High-frequency trading in a limit order book*,
  Quantitative Finance 8(3)：最优做市 = 围绕保留价 r = s − q·γ·σ²·(T−t) 报价，
  总价差 = γσ²(T−t) + (2/γ)ln(1+γ/κ)；库存偏斜使仓位均值回归。
- Guéant, Lehalle & Fernandez-Tapia (2013)：库存边界下的闭式解。
- Bitwise 价格发现研究（引于 SEC 文件，2021）：2019-2021 年 CME 期货对现货的
  引导时间已从 ~15s 压缩到 ~3s；现代测量（B，2026）为 0.05–0.15s。
- 苏黎世 2026 研究（C 转引）：Binance→Coinbase 延迟套利扣费后**仅约 0.3% 的交易
  时间窗口可行**；其余时间亏损。

**构建逻辑与边界**
1. 做市赚价差 − 逆向选择 − 库存风险；需要 maker 费率、低延迟、队列位置管理。
2. 对手动/半自动短线者的可用启示：**用 maker 限价在回踩位挂单**（把执行成本从
   taker 0.05% 降到 maker 0.02%），本质是把做市思想用在入场执行上。
3. 跨所延迟套利对散户已基本不可行——文献级结论，不要在这上面花时间。

---

## 3. 策略构建通用管线（八步）

方法论主线：López de Prado, *Advances in Financial Machine Learning* (Wiley 2018)；
Bailey, Borwein, López de Prado & Zhu, *The Probability of Backtest Overfitting* (2015)；
Bailey & López de Prado, *The Deflated Sharpe Ratio*。
加密完整实现参考：*Algorithmic Crypto Trading Using Information-Driven Bars,
Triple-Barrier Labeling and Deep Learning*（B）。

```
① 假设 → ② 数据 → ③ 特征/信号 → ④ 标签 → ⑤ 过滤/regime
                                        ↓
⑧ 验证/上线 ← ⑦ 执行 ← ⑥ 风险/仓位 ←──────┘
```

**① 优势假设（先回答"钱从哪来"）**
四类可辩护来源：风险溢价（carry）、行为偏差（过度反应/追涨）、结构性资金流
（funding 结算、ETF 申赎、清算引擎）、流动性提供报酬（做市/回踩挂单）。
没有来源的形态规律 = 数据挖掘候选，必须降级对待。

**② 数据层**
K 线（OHLCV）→ 逐笔成交（taker tape）→ L2 订单簿 → 衍生品数据（funding/OI/清算）。
信息驱动 bar（成交量 bar/dollar bar）优于固定时间 bar（AFML 第 2 章）；
本项目按 OKX 5m 聚合 taker tape 并用官方 rubik 统计校验覆盖率，属正确做法。

**③ 特征/信号**
规则式（区间突破、AH/AL 扫荡）与统计式（OFI、delta、CVD 背离、波动状态）。
Wang (2025) 的教训：**先把输入做对，再谈模型复杂度**。

**④ 标签与训练（若用 ML）**
- 三重障碍法：按「先触止盈 / 先触止损 / 到期」标注，障碍宽度按局部波动 σ 缩放
  ——标签即真实交易结局，不是固定期限收益符号。
- 元标签（meta-labeling）：主模型定方向（高召回），二级模型判「这次信号对不对」
  （提精度），输出概率 → 仓位。本项目 19 因子入场确认概率正是元标签架构。

**⑤ 过滤与 regime**
趋势/震荡（ADX 或自研 trendBlock）、波动分位、时段窗口、事件日历。
文献共识：**过滤器贡献往往大于原始信号**（ORB 实测：裸突破方向≈50/50）。

**⑥ 风险与仓位**
- 每笔固定分数风险（如账户 0.5–1%）；仓位 = 风险额 / 止损距离。
- 止损放在「假设失效处」（扫荡极值外 / 区间对侧），非任意百分比。
- 分数 Kelly（≤0.5×）防参数误差；日亏上限（如 2–3%）与最大并发仓位；
  R 倍数记账（本项目 signals 表已有 r_multiple）。

**⑦ 执行**
- 费用数学：OKX 永续普通档约 maker 0.02% / taker 0.05%（以官网为准）。
  taker 往返 ≈0.10% + 滑点 → **每笔毛利优势必须 >0.10–0.15% 才值得做**。
  5m 级别 BTC 日内波幅常在 0.3–1%，费用占可捕获波动的 10–30%，不可忽略。
- 收盘确认入场（等 K 线收盘）牺牲一点价格换假突破过滤；回踩位用 post-only
  限价把成本降到 maker 档；数据/执行延迟必须匹配信号周期。

**⑧ 验证与上线**
- Walk-forward 样本外（本项目已有）； purged K-fold + embargo 防标签重叠泄漏；
- 记录全部试验次数，用 Deflated Sharpe / PBO 惩罚多重检验；
- 成本敏感性：费用×2 后仍为正才可信；先 paper trading 再小仓实盘。
- 「完美回测是警告不是证据」（AFML）。

---

## 4. 短线实操手册

### 4.1 一天的结构（UTC，与图表时段标注一致）

| 窗口 | 市场状态（文献支撑） | 适用打法 |
| --- | --- | --- |
| 00:00–07:00 亚盘 | 活动/波动最低（tea time 2024）；00:00 日开+funding | 区间回归；标记 AH/AL；不追突破 |
| 07:00–10:00 伦敦开 | 波动开始扩张；扫亚盘高低发窗口（D 级惯例+2.1 反转证据） | AH/AL 扫荡收回反转 |
| 13:00–17:00 欧美重叠 | 活动/波动/非流动性全天峰值 16–17 UTC（A） | 突破回踩顺势；事件驱动 |
| 14:00 ET FOMC / 12:30 UTC CPI | 绝对收益≈翻倍、量 2.5×（A） | 事件前减仓/停手；事件后按事件波动调仓 |
| 21:00–23:00 | 历史平均收益显著为正（B，持久性存疑） | 可作统计倾斜，不可作唯一依据 |
| 23:00–24:00 | 活动回落 | 收紧仓位，准备次日日开 |

### 4.2 五个可执行 setup 模板

**A. 亚盘高低扫荡反转（反转+订单流确认）**
前提：亚盘区间已成形（≥2 根 K）；欧/美盘价格刺破 AH（或 AL）。
触发：刺破后**收盘收回区间内** + taker delta 与反转方向一致（扫高时主动卖占优）。
入场：确认 K 收盘或回抽扫荡位挂 maker 限价。止损：扫荡极值外 + 0.1–0.2 ATR。
目标：区间中点 → 对侧边缘，要求 RR≥1.5。时间止损：8–12 根 5m。
依据：2.1 反转文献 + 2.2 成交流文献；本项目 M/W 诱多/诱空判读即此模板。

**B. 突破回踩顺势（动量+结构确认）**
前提：高流动时段；关键位/颈线被两根收盘越过（≥0.2 ATR）。
触发：突破量 ≥1.5×均量或 ≥1.2×且订单流同向；回踩缩量（≤0.9×）收盘守住。
入场：回踩确认 K 收盘。止损：回踩低点/关键位下方。目标：≥2R 或测量目标。
依据：2.3（TRB 有效+过滤带 1% 更优）；本项目 keyLevelScenario 即此模板。

**C. 合成开盘区间突破（ORB）**
区间：14:00 UTC 后首根 1h（或纽约开盘 30m）。只做**收盘突破 + 高于前 3 根量**，
止损区间对侧，先到一个区间高度减半、其余移动止损。
依据：2.3 ORB 实测——裸突破 98% 发生但仅 ~48% 延续，过滤器即策略。

**D. 亚盘区间回归（均值回归）**
仅 00:00–07:00 UTC 且无趋势（ADX<25 或等价口径）：触布林下轨+RSI<30 做多，
目标中轨；5–10 根不回归即离场。趋势日禁用。
依据：2.1（低流动时段反转）+ 2.4（亚盘低波动）。

**E. 事件窗口协议（不是方向策略，是生存协议）**
FOMC/CPI 前 30m：不新开仓、已有仓位减半或收紧止损；
发布后首根 5m 不追；若做事件后动量，仓位按「事件波动≈2×正常」减半。
依据：2.4 FOMC 研究（+0.59pp、2.54×量）。

### 4.3 每日 checklist

1. 标记今日 00:00 UTC 日开、AH/AL、前日高低。
2. 查事件日历（FOMC/CPI/非农）与 funding 水平（极端值=拥挤警告）。
3. 按时段选模板：亚盘 D，伦开 A，重叠 B/C，事件时段执行 E。
4. 每笔先写：入场理由 / 失效位 / 目标 / R 倍数 / 仓位，再下单。
5. 日亏达上限（如 2%）停手；收盘后按 R 倍数复盘，周度看校准而非单笔盈亏。

---

## 5. 与 PULSEDESK 的映射

| 文献结论 | 项目现状 | 差距/候选增强（未实施，需另行确认） |
| --- | --- | --- |
| 成交流不平衡有效（Digital Finance 2019） | `src/quant/flow.ts` taker tape + rubik 校验 | 已对齐；明确不称 OFI 是正确的 |
| 元标签架构（AFML） | `src/quant/model.ts` 19 因子概率 + 门槛 | 可加 purged CV / Deflated Sharpe |
| 过滤器>裸信号（ORB 实测） | 两根收盘+放量+回踩三重过滤 | 已对齐 |
| 时段选择策略（tea time 2024） | 交易时段标注层已上线 | 可把时段作为引擎的 regime 特征 |
| funding/OI 情绪（BIS carry） | 未接入 | 候选：OKX 公共 funding/OI 接口 |
| 清算级联无单一前兆（arXiv 2607.27070） | 未接入 | 若做，须多变量+仓位约束 |
| 事件风险（FOMC 研究） | 未接入日历 | 候选：事件日历提示层 |
| 成本敏感性（AFML） | 回测含 RR 统计 | 候选：费用×2 压力测试开关 |

---

## 6. 参考文献

1. Wen, Z., Bouri, E., Xu, Y., Zhao, Y. (2022). Intraday return predictability in the
   cryptocurrency markets: Momentum, reversal, or both. *NAJEF* 62:101733.
2. Zaremba, A., et al. (2021). Up or down? Short-term reversal, momentum, and liquidity
   effects in cryptocurrency markets. *IRFA* 78:101908.
3. Kość, K., Sakowski, P., Ślepaczuk, R. (2019). Momentum and contrarian effects on the
   cryptocurrency market. *Physica A* 523:691-701.
4. Dynamic time series momentum of cryptocurrencies (2021). *NAJEF* 59.
5. Order flow analysis of cryptocurrency markets (2019). *Digital Finance* 1.
6. Xu, K., Gould, M.D., Howison, S.D. (2019). Multi-Level Order-Flow Imbalance in a Limit
   Order Book. arXiv:1907.06230.
7. Kolm, P.N., Turiel, J., Westray, N. (2023). Deep order flow imbalance. *Mathematical
   Finance* 33(4):1044-1081.
8. Wang, H. (2025). Exploring Microstructural Dynamics in Cryptocurrency Limit Order
   Books. arXiv:2506.05764.
9. Gould, M.D., Bonart, J. (2015). Queue Imbalance as a One-Tick-Ahead Price Predictor.
   arXiv:1512.03492.
10. Corbet, S., et al. (2019). The profitability of technical trading rules in the Bitcoin
    market.（1 分钟级 VMA/TRB）
11. Gerritsen, D.F., et al. (2020). The profitability of technical trading rules in the
    Bitcoin market. *Finance Research Letters*.
12. Grobys, K., et al. (2020). Profitability of simple technical trading rules. *FRL*.
13. Do technical trading rules outperform buy-and-hold in the cryptocurrency market?
    (2024).（矛盾证据，99 币样本）
14. The crypto world trades at tea time (2024). Springer. DOI 10.1007/s11156-024-01304-1.
15. Padyšák, M., Vojtko, R. (2022). Seasonality, Trend-following, and Mean reversion in
    Bitcoin. SSRN 4081000.
16. Baur, D.G., Cahill, D., Godfrey, K., Liu, Z. (2019). Bitcoin time-of-day, day-of-week
    and month-of-year effects. *FRL* 31:78-92.
17. Scheduled FOMC statements and intraday macro event risk in cryptocurrency markets
    (2026). *FRL*.
18. Schmeling, M., Schrimpf, A., Todorov, K. (2023/2025). Crypto Carry. BIS WP 1087;
    CEPR DP20719.
19. Ackerer, D., et al. (2024/2025). Perpetual Futures Pricing.
20. Kim, J., Park, H. (2025). Designing funding rates for perpetual futures.
    arXiv:2506.08573.
21. Garcia Seuma, R.M. (2026). Where does the criticality live? Seven crypto-perpetual
    liquidation cascades. arXiv:2607.27070.
22. Neubert, M., Rams, W., Gruhn, P. (2026). Cryptocurrency Perpetual Futures and Swaps:
    A Systematic Literature Review. SSRN 6639558.
23. Avellaneda, M., Stoikov, S. (2008). High-frequency trading in a limit order book.
    *Quantitative Finance* 8(3).
24. Guéant, O., Lehalle, C.-A., Fernandez-Tapia, J. (2013). Dealing with the inventory
    risk. *Mathematics and Financial Economics* 7.
25. López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
26. Bailey, D., Borwein, J., López de Prado, M., Zhu, Q. (2015). The Probability of
    Backtest Overfitting. *Journal of Computational Finance*.
27. Bitwise (2021). Price Discovery in the Modern Bitcoin Market.（SEC 文件引用）
28. Altrady (2026). ORB Trading Strategy in Crypto.（BTC 30m ORB 一年实测，C 级）
29. Stoic Research (2026). Crypto ORB portfolio backtest.（C 级）

---

## 7. 风险与诚实边界

1. **矛盾证据必须保留**：技术规则在早期样本盈利、在 2024 更新样本不显著——
   任何单一研究都不是收益承诺。
2. **时段收益异常不持久**（Baur 2019）；更可靠的是波动/流动性时段结构，
   用于选策略与仓位，而非直接赌方向。
3. **清算级联无可靠单变量预警**（arXiv 2607.27070 的否定性结论本身就是贡献）。
4. **费用与滑点是一阶变量**：taker 往返 ~0.10%+，高频换手会吞噬一切微弱优势。
5. **回测过拟合是默认结局**：不记录试验次数、不做样本外与成本压力的回测一律不可信。
6. 本项目不下单、不连接账户；以上全部为研究与观察工具口径。
