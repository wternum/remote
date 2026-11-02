// ─────────────────────────────────────────────────────────────
//  双顶 / 双底「入场确认」模型
//  · 不再“看见形态就下单”：每个候选必须先通过订单流 + 结构 + 风险三组证据验证
//  · 每个因子给出 [-1, 1] 的证据强度，加权求和后过 logistic 得到成功概率
//  · 缺数据（如回测没有实时盘口）时该因子贡献为 0，不做臆测加成
// ─────────────────────────────────────────────────────────────

export type FactorKey =
  | 'volDiverge'
  | 'deltaDiverge'
  | 'absorption'
  | 'wickReject'
  | 'levelIntegrity'
  | 'patternHeight'
  | 'patternSpan'
  | 'trendExhaust'
  | 'legDecel'
  | 'volRegime'
  | 'rrQuality'
  | 'tapeBias'
  | 'bookImbalance'
  | 'thrustVolume';

export type FactorGroup = '订单流' | '结构' | '风险';

export interface FactorDef {
  key: FactorKey;
  label: string;
  short: string;
  /** 证据为 +1 / -1 分别代表什么 */
  hint: string;
  group: FactorGroup;
  /** logistic 权重（对数几率点） */
  weight: number;
  /** 仅实时可得（回测中记为无数据） */
  liveOnly?: boolean;
}

export const FACTORS: FactorDef[] = [
  {
    key: 'volDiverge',
    label: '二次测试缩量',
    short: 'VOL DIV',
    group: '订单流',
    weight: 0.55,
    hint: '第二腿（推向二顶/二底）的单位成交量明显小于第一腿 → 推动动能衰竭，反转概率上升；放量创新高/新低则更可能是突破而非双顶。',
  },
  {
    key: 'deltaDiverge',
    label: '主动成交差背离',
    short: 'CVD DIV',
    group: '订单流',
    weight: 0.7,
    hint: '用逐根主动买卖差（delta/成交量）衡量：价格再创新高但差值走弱（顶）或价格再创新低但抛压走弱（底）= 经典订单流背离。',
  },
  {
    key: 'absorption',
    label: '关键位吸收',
    short: 'ABSORB',
    group: '订单流',
    weight: 0.8,
    hint: '测试窗口内出现“放量刺破关键位但收盘收回”的K线（被动限价吃掉主动市价）越多，支撑/阻力越可信；收盘停在关键位外侧则视为击穿。',
  },
  {
    key: 'wickReject',
    label: '拒绝影线',
    short: 'REJECT',
    group: '订单流',
    weight: 0.5,
    hint: '最深测试K线的影线占比 + 确认K线收盘位置：长下影/长上影且收盘收回形态内侧，说明该价位有真实对抗。',
  },
  {
    key: 'thrustVolume',
    label: '确认K量能',
    short: 'THRUST',
    group: '订单流',
    weight: 0.45,
    liveOnly: true,
    hint: '确认K线相对近 20 根均量的放大倍数。<1 的弱确认经常被再次刺破；≥1.5 的拒绝更可靠。仅实时行情可用。',
  },
  {
    key: 'bookImbalance',
    label: '盘口失衡',
    short: 'BOOK',
    group: '订单流',
    weight: 0.5,
    liveOnly: true,
    hint: '十档买卖挂单量失衡度：做多要求买盘更厚，做空要求卖盘更厚。仅实时行情可用（回测无历史盘口）。',
  },
  {
    key: 'tapeBias',
    label: '大单主动方向',
    short: 'TAPE',
    group: '订单流',
    weight: 0.4,
    liveOnly: true,
    hint: '成交流中大单的名义金额偏向。与交易方向一致代表聪明钱在推；反向通常意味着还在寻找流动性。仅实时可用。',
  },
  {
    key: 'levelIntegrity',
    label: '关键位完整度',
    short: 'LEVEL',
    group: '结构',
    weight: 0.4,
    hint: '同一价位被测试次数越多、期间是否出现过“收盘击穿”，决定这条线还剩多少防守价值；刺破后快速收回（扫损回收）额外加分。',
  },
  {
    key: 'patternHeight',
    label: '形态高度',
    short: 'HEIGHT',
    group: '结构',
    weight: 0.3,
    hint: '关键位到颈线的距离（ATR 倍数）。太矮则空间不足以覆盖成本与滑点，过高则需要更久持仓。',
  },
  {
    key: 'patternSpan',
    label: '形态时间跨度',
    short: 'SPAN',
    group: '结构',
    weight: 0.25,
    hint: '两次测试之间的根数。过短是噪音抖动，过长则关键位已经钝化；对数尺度上以约 110 根为最优。',
  },
  {
    key: 'trendExhaust',
    label: '趋势已转平',
    short: 'FLATTEN',
    group: '结构',
    weight: 0.5,
    hint: 'EMA20-EMA50 / ATR 度量逆势压力。二次测试要成立，逆着交易方向的趋势必须已经衰竭：均线差接近走平或轻微转向时最优；仍在强逆势推进时是接飞刀，得分最低。',
  },
  {
    key: 'legDecel',
    label: '推进减速',
    short: 'DECEL',
    group: '结构',
    weight: 0.45,
    hint: '第二腿每根K线的推进幅度相对第一腿的衰减比例。第二腿明显更慢 = 边际买家/卖家减少，反转结构成立。',
  },
  {
    key: 'volRegime',
    label: '波动环境',
    short: 'REGIME',
    group: '结构',
    weight: 0.2,
    hint: '当前 ATR 在近 500 根中的分位。波动过低没有跟随，过高则止损被随机扫出；中高分位最有利于形态兑现。',
  },
  {
    key: 'rrQuality',
    label: '目标可达性',
    short: 'REACH',
    group: '风险',
    weight: 0.6,
    hint: '模型预测的是「胜率」而不是「赔率」：目标越远（R:R 越高）越难在超时前兑现，因此高 R:R 对胜率是负证据。同时扣除往返成本占风险过高的形态。赔率的价值在期望值一栏单独体现。',
  },
];

export const FACTOR_INDEX: Record<FactorKey, number> = FACTORS.reduce(
  (acc, f, i) => ({ ...acc, [f.key]: i }),
  {} as Record<FactorKey, number>,
);

/** logistic 参数：把证据总和映射到 5%~95% 的概率带 */
export const MODEL = {
  base: -0.15,
  gain: 0.42,
} as const;

export const clamp = (v: number, lo = -1, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export interface Score {
  /** 入场成功概率 0..1 */
  proba: number;
  logit: number;
  /** 与 FACTORS 对齐；null = 该场景无数据 */
  evidence: (number | null)[];
  /** 每个因子对数几率贡献（点） */
  parts: number[];
  /** 覆盖的证据权重之和 */
  covered: number;
}

/** 证据 → 概率。缺失因子（null）贡献恒为 0，因此概率不会因缺数据被高估。 */
export function scoreEvidence(evidence: (number | null)[]): Score {
  let logit = MODEL.base;
  const parts: number[] = new Array(FACTORS.length).fill(0);
  let covered = 0;
  for (let i = 0; i < FACTORS.length; i++) {
    const e = evidence[i];
    if (e == null || !Number.isFinite(e)) continue;
    const w = FACTORS[i].weight;
    const part = MODEL.gain * w * clamp(e);
    parts[i] = part;
    logit += part;
    covered += w;
  }
  // 证据极少时向 50% 收缩，避免“什么都不知道却很自信”
  const shrink = Math.min(1, covered / 4.5);
  logit = MODEL.base + (logit - MODEL.base) * shrink;
  return { proba: sigmoid(logit), logit, evidence, parts, covered };
}

export type Grade = 'A' | 'B' | 'C' | 'D';

export const GRADE_BANDS: { grade: Grade; min: number; label: string; color: string }[] = [
  { grade: 'A', min: 0.66, label: '强确认 · 默认执行档', color: '#2ebd85' },
  { grade: 'B', min: 0.58, label: '有效确认 · 标准执行', color: '#37c8dd' },
  { grade: 'C', min: 0.5, label: '边缘确认 · 降仓或等待', color: '#f0b90b' },
  { grade: 'D', min: 0, label: '确认不足 · 放弃', color: '#f6465d' },
];

export function gradeOf(proba: number): Grade {
  for (const b of GRADE_BANDS) if (proba >= b.min) return b.grade;
  return 'D';
}

export function gradeMeta(grade: Grade) {
  return GRADE_BANDS.find(b => b.grade === grade) ?? GRADE_BANDS[GRADE_BANDS.length - 1];
}

/** 概率 × 赔率的期望值（R），用于把“胜率”与“盈亏比”放到同一张桌子上 */
export function expectancy(r: number, p: number) {
  return p * Math.max(r, 0) - (1 - p) * 1;
}
