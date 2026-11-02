import { getNativeIndicator, type NativeIndicatorInfo } from "@luxalgo/vela";

export type IndicatorFamily =
  | "trend"
  | "momentum"
  | "volatility"
  | "volume"
  | "structure";
export type PreviewKind =
  | "average"
  | "bands"
  | "momentum"
  | "volume"
  | "profile"
  | "structure";

export interface CatalogItem extends NativeIndicatorInfo {
  english: string;
  family: IndicatorFamily;
  preview: PreviewKind;
  description: string;
  overlay: boolean;
  featured: boolean;
}

export const FAMILIES: {
  id: IndicatorFamily;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    id: "trend",
    label: "趋势",
    icon: "trend",
    description: "观察价格方向、趋势强度与潜在转折，辅助识别市场所处阶段。",
  },
  {
    id: "momentum",
    label: "动量",
    icon: "momentum",
    description: "观察价格变化的速度与力度，辅助比较动量背离、超买与超卖区域。",
  },
  {
    id: "volatility",
    label: "波动率",
    icon: "volatility",
    description:
      "观察价格波动范围及其收缩、扩张过程。波动率本身不代表涨跌方向。",
  },
  {
    id: "volume",
    label: "成交量与订单流",
    icon: "volume",
    description:
      "结合价格与成交量观察参与程度。需要额外数据源的指标会标注可用状态。",
  },
  {
    id: "structure",
    label: "结构与关键位",
    icon: "structure",
    description: "观察摆动高低点、支撑阻力与价格形态，辅助理解当前市场结构。",
  },
];

const META: Record<string, Partial<CatalogItem>> = {
  "pulse.double": {
    family: "structure",
    preview: "structure",
    featured: true,
    description:
      "围绕双顶 M、双底 W 寻找入场机会。仅在已收盘 K 线完成二次测试拒绝或颈线突破，并通过方向及风险收益筛选后标记信号。规则评分不是预测胜率。",
  },
  "bollinger-bands": {
    family: "volatility",
    preview: "bands",
    featured: true,
    description:
      "布林带以移动平均线为中轨，以标准差构建上下轨。观察带宽收缩、价格突破与回归中轨的过程，结合趋势和成交量解读，不把触轨直接当作买卖信号。",
  },
  supertrend: {
    family: "trend",
    preview: "average",
    featured: true,
    description:
      "超级趋势指标以平均真实波幅 ATR 及倍数构建跟随价格的趋势线。方向切换用于辅助识别趋势变化，震荡环境中应谨慎使用。",
  },
  sma: {
    family: "trend",
    preview: "average",
    featured: true,
    description:
      "简单移动平均线对指定周期内的收盘价取等权平均。可叠加不同长度，比较价格与均线的关系；添加后可在图表中设置周期和颜色。",
  },
  ema: {
    family: "trend",
    preview: "average",
    featured: true,
    description:
      "指数移动平均线给予近期价格更高权重，比同周期简单均线更敏感。支持在图表中添加多组不同参数并分别设置。",
  },
  rsi: {
    family: "momentum",
    preview: "momentum",
    featured: true,
    description:
      "相对强弱指数比较一段时间内上涨与下跌的力度，以 0 至 100 的范围观察动量。超买、超卖和背离应结合市场趋势判断。",
  },
  macd: {
    family: "momentum",
    preview: "momentum",
    featured: true,
    description:
      "MACD 比较两条指数均线的差值及其信号线，并通过柱状图展示动量变化。可辅助观察趋势方向、动量交叉及背离。",
  },
  volume: {
    family: "volume",
    preview: "volume",
    featured: true,
    description:
      "以每根 K 线对应的成交量绘制柱状图。当前 OKX 永续数据已换算为报价币 USDT 成交额，便于比较放量、缩量与价格变化。",
  },
  vpvr: {
    family: "volume",
    preview: "profile",
    featured: true,
    description:
      "可视范围成交量分布按价格区间展示当前窗口内的成交活动，帮助识别成交密集区。具体计算与可用数据以图表中的指标为准。",
  },
  vwap: {
    family: "volume",
    preview: "average",
    featured: true,
    description:
      "成交量加权平均价按成交量衡量平均交易价格，可用作观察价格相对成交成本的位置。请在图表指标设置中选择锚定或会话参数。",
  },
  "average-true-range": {
    family: "volatility",
    preview: "momentum",
    description:
      "平均真实波幅 ATR 衡量价格波动程度，包含相邻 K 线之间的跳空影响。用于比较波动环境，不直接提供多空方向。",
  },
  zigzag: {
    family: "structure",
    preview: "structure",
    description:
      "ZigZag 连接满足阈值的高低摆动点，帮助辨识价格波段。末端摆动点可能随新行情变化，不宜将未确认的拐点视为固定信号。",
  },
  "pivot-points": {
    family: "structure",
    preview: "structure",
    description:
      "根据历史周期的高、低、收盘等价格推算枢轴及支撑阻力层级。可在指标设置中调整周期与显示方式。",
  },
};

function familyFor(type: string): IndicatorFamily {
  if (
    /volume|money-flow|vwap|vpvr|chaikin|accumulation|force-index|klinger|pvo|intraday-intensity/.test(
      type,
    )
  )
    return "volume";
  if (
    /bollinger|percent-b|bandwidth|keltner|true-range|volatility|deviation|ulcer|mass-index|choppiness/.test(
      type,
    )
  )
    return "volatility";
  if (/pivot|zigzag|fractal|52-week|pulse\./.test(type)) return "structure";
  if (
    /rsi|stochastic|macd|momentum|oscillator|cci|roc|williams-percent|fisher|trix|ultimate|detrended|awesome|aroon|directional|vortex|coppock|kst|tsi|ppo|bull|bear/.test(
      type,
    )
  )
    return "momentum";
  return "trend";
}

export function buildIndicatorCatalog(
  list: NativeIndicatorInfo[],
): CatalogItem[] {
  return list.map((n) => {
    const descriptor = getNativeIndicator(n.type);
    const meta = META[n.type] ?? {};
    const family = meta.family ?? familyFor(n.type);
    return {
      ...n,
      english: descriptor?.title ?? n.title,
      family,
      preview:
        meta.preview ??
        (family === "momentum"
          ? "momentum"
          : family === "volatility"
            ? "bands"
            : family === "volume"
              ? "volume"
              : family === "structure"
                ? "structure"
                : "average"),
      overlay: descriptor?.overlay ?? true,
      featured: meta.featured ?? false,
      description:
        meta.description ??
        `${n.title} 是图表内置的${FAMILIES.find((f) => f.id === family)!.label}指标。${FAMILIES.find((f) => f.id === family)!.description}添加后可通过图表中的设置按钮调整参数。`,
    };
  });
}

export const FEATURED_ORDER = [
  "bollinger-bands",
  "supertrend",
  "pulse.double",
  "ema",
  "rsi",
  "vpvr",
  "macd",
  "volume",
  "sma",
  "vwap",
];
