import catalog from './catalog.json';

export interface LibFamily {
  key: string;
  name: string;
  pillLabel: string;
  tagline: string;
}
export interface LibIndicator {
  slug: string;
  name: string;
  imageUrl: string;
  description: string;
  date: string;
  family: string | null;
  families: string[];
  tags: string[];
  author: string;
}
export interface LibConcept {
  slug: string;
  name: string;
  family: string | null;
  cluster: string | null;
  aliases: string[];
  blurb: string;
  count: number;
  indicators: string[];
}

export const CATALOG_SOURCE = catalog.source;
export const CATALOG_FETCHED_AT = catalog.fetchedAt;
export const FAMILIES = catalog.families as LibFamily[];
export const INDICATORS = catalog.indicators as LibIndicator[];
export const CONCEPTS = catalog.concepts as LibConcept[];

export const familyByKey = new Map(FAMILIES.map((family) => [family.key, family]));
/** Chinese labels for the Library's 17 families. */
export const FAMILY_ZH: Record<string, string> = {
  trend: '趋势',
  momentum: '动量',
  volatility: '波动率',
  'volume-orderflow': '成交量与资金流',
  'market-structure': '结构',
  'smc-ict': '聪明钱 / ICT',
  wyckoff: '威科夫',
  'elliott-harmonics': '艾略特与谐波',
  patterns: '形态',
  levels: '关键位',
  statistics: '统计',
  'machine-learning': '机器学习',
  'time-seasonality': '时间与时段',
  'sentiment-breadth': '情绪与广度',
  'risk-exits': '风险与离场',
  'meta-composition': '元指标',
  validation: '验证',
};

export const CLUSTER_ZH: Record<string, string> = {
  'Moving-average lineage': '均线族',
  'Channels, lines & geometry': '通道、线与几何',
  'Digital filters & smoothers': '数字滤波与平滑',
  'Ichimoku system': '一目均衡表',
  'MA applications': '均线应用',
  'Trend events': '趋势事件',
  'Trend strength & direction': '趋势强度与方向',
  'Trend-following systems': '趋势跟随系统',
  'Band & channel systems': '布林带与通道系统',
  'Volatility estimators': '波动率估计',
  'Squeeze & compression': '挤压与收敛',
  'Range & expansion': '区间与扩张',
  'Cumulative flow lines': '累积资金流',
  'BB-inside-KC + momentum': '布林带内含肯特纳 + 动量',
};

export const clusterLabel = (name: string | null | undefined) =>
  (name && CLUSTER_ZH[name]) || name || '';

export const familyLabel = (key: string | null | undefined) =>
  (key && FAMILY_ZH[key]) || '其他';

export const familyCounts = (() => {
  const counts = new Map<string, number>();
  for (const item of INDICATORS)
    for (const key of item.families) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
})();

export const newestDate = INDICATORS.map((item) => item.date)
  .filter(Boolean)
  .sort()
  .at(-1);

export const newestFirst = [...INDICATORS].sort(
  (a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.name.localeCompare(b.name),
);

export function dateLabel(date: string | null | undefined, locale = 'zh-CN') {
  if (!date) return '';
  return new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function firstSentence(text: string) {
  return String(text ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
}

export function libraryUrl(slug: string) {
  return `https://www.luxalgo.com/library/indicator/${encodeURIComponent(slug)}/`;
}

const normalize = (value: string) =>
  value.toLocaleLowerCase().replace(/®|™/g, '').replace(/[^a-z0-9%]+/g, '');

/** Explicit bridges for names that differ between the Library and the chart's built-ins. */
const NATIVE_ALIASES: Record<string, string> = {
  'bollingerbands': 'bollinger-bands',
  'bollingerband': 'bollinger-bands',
  'supertrend': 'supertrend',
  'macd': 'macd',
  'rsi': 'rsi',
  'relative strength index': 'rsi',
  'stochastic': 'stochastic',
  'ema': 'ema',
  'exponentialmovingaverage': 'ema',
  'sma': 'sma',
  'simplemovingaverage': 'sma',
  'vwap': 'vwap',
  'volumeweightedaverageprice': 'vwap',
  'volume': 'volume',
  'onbalancevolume': 'obv',
  'negativevolumeindex': 'nvi',
  'positivevolumeindex': 'pvi',
  'pricevolumetrend': 'pvt',
  'volumeprofilemaps': 'vpvr',
  'volumeprofile': 'vpvr',
  'visible range volume profile': 'vpvr',
  'averagetruerange': 'average-true-range',
  'atr': 'average-true-range',
  'parabolicsar': 'parabolic-sar',
  'standardpivotpoints': 'pivot-points',
  'pivotpoints': 'pivot-points',
  'zigzag': 'zigzag',
  'williamspercentr': 'williams-percent-r',
  'chaikinmoneyflow': 'chaikin-money-flow',
  'chaikinoscillator': 'chaikin-oscillator',
  'chaikinviolatility': 'chaikin-volatility',
  'moneyflowindex': 'money-flow-index',
  'aroon': 'aroon',
  'ultimateoscillator': 'ultimate-oscillator',
  'fishertransform': 'fisher-transform',
};

export interface NativeLike {
  type: string;
  title: string;
  english?: string;
  supported: boolean;
  multiInstance?: boolean;
  overlay?: boolean;
}

/** A Library card only adds directly when the installed chart has the equivalent built-in. */
export function nativeFor(item: LibIndicator, natives: NativeLike[]): NativeLike | undefined {
  const direct = ['slug', 'name'].map((key) =>
    natives.find((native) => normalize(native.type) === normalize(String((item as unknown as Record<string, unknown>)[key] ?? ''))),
  );
  const found = direct.find(Boolean);
  if (found) return found;
  const alias = NATIVE_ALIASES[normalize(item.name)] ?? NATIVE_ALIASES[normalize(item.slug)];
  if (alias) {
    const exact = natives.find((native) => native.type === alias);
    if (exact) return exact;
  }
  return natives.find(
    (native) =>
      normalize(native.title) === normalize(item.name) ||
      (!!native.english && normalize(native.english) === normalize(item.name)),
  );
}

export const FAVORITES_KEY = 'vela-indicator-library-favorites-v1';

export function readFavorites(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveFavorites(ids: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...ids]));
  } catch {
    /* Storage can be unavailable in private windows. */
  }
}

/** Deterministic shuffle so Discover is stable until the user asks for another set. */
export function explorePicks(seed: number, count = 6): LibIndicator[] {
  const pool = INDICATORS.filter((item) => item.imageUrl && !newestFirst.slice(0, 3).includes(item));
  const picked: LibIndicator[] = [];
  const seenFamilies = new Set<string>();
  let state = seed * 1103515245 + 12345;
  while (picked.length < count && pool.length) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const index = state % pool.length;
    const [item] = pool.splice(index, 1);
    const family = item.family ?? 'other';
    if (seenFamilies.has(family) && picked.length < 3) continue;
    seenFamilies.add(family);
    picked.push(item);
  }
  return picked;
}

export const FAMILY_ICON: Record<string, string> = {
  trend: 'trend',
  momentum: 'momentum',
  volatility: 'volatility',
  'volume-orderflow': 'volume',
  'market-structure': 'structure',
  'smc-ict': 'structure',
  wyckoff: 'layers',
  'elliott-harmonics': 'trend',
  patterns: 'chart',
  levels: 'structure',
  statistics: 'grid',
  'machine-learning': 'momentum',
  'time-seasonality': 'chart',
  'sentiment-breadth': 'volume',
  'risk-exits': 'layers',
  'meta-composition': 'grid',
  validation: 'list',
};
