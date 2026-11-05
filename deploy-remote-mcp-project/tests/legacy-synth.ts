// 测试专用：修复前的仿真行情生成器，逐字保留。
//
// 它的趋势项没有按波动率缩放，价格会指数漂移（600 根价格比可达 1e8），
// 不能再作为生产降级数据；但 audit-fixes 测的是"两条扫描路径结果一致"等逻辑，
// 需要的正是这种强趋势、高形态密度的输入，且部分断言绑定了它的确定性输出。
// 生产降级路径使用 src/server/okx.ts 中修复后的 synthCandles。
import { barMs, type Candle } from '@/lib/types';

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYNTH_BASE: Record<string, { price: number; vol: number; volUnit: number }> = {
  "BTC-USDT-SWAP": { price: 97400, vol: 0.0011, volUnit: 9200 },
  "ETH-USDT-SWAP": { price: 3625, vol: 0.0016, volUnit: 26000 },
  "SOL-USDT-SWAP": { price: 214, vol: 0.0022, volUnit: 42000 },
};

export function legacyTrendCandles(symbol: string, bar: string, count: number, endTs?: number): Candle[] {
  const cfg = SYNTH_BASE[symbol] ?? { price: 100, vol: 0.002, volUnit: 1000 };
  const bm = barMs(bar);
  const dayKey = Math.floor((endTs ?? Date.now()) / 86400000);
  const rng = mulberry32(hashStr(`${symbol}|${bar}|${dayKey}`));
  const lastStart = Math.floor((endTs ?? Date.now()) / bm) * bm - bm;
  const start = lastStart - (count - 1) * bm;

  const out: Candle[] = [];
  let price = cfg.price * (0.97 + rng() * 0.06);
  let regime = 0;
  for (let i = 0; i < count; i++) {
    regime = regime * 0.982 + (rng() - 0.5) * 0.09;
    if (rng() < 0.012) regime += (rng() - 0.5) * 0.9; // 偶发行情
    const vScale = 1 + 1.6 * Math.abs(regime) + (rng() < 0.06 ? rng() * 2.4 : 0);
    const ret = regime * 0.16 + (rng() + rng() - 1) * cfg.vol * vScale;
    const o = price * (rng() < 0.02 ? 1 + (rng() - 0.5) * cfg.vol * 6 : 1);
    // 4 步子路径
    let p = o;
    let hi = o;
    let lo = o;
    let pc = o;
    for (let s = 0; s < 4; s++) {
      pc = p * (1 + ret / 4 + (rng() - 0.5) * cfg.vol * 0.55 * vScale);
      p = pc;
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    const c = p;
    hi = Math.max(hi, o, c) * (1 + rng() * cfg.vol * 0.5 * vScale);
    lo = Math.min(lo, o, c) * (1 - rng() * cfg.vol * 0.5 * vScale);
    const bodyPct = Math.abs(c - o) / o;
    // 仿真成交量按"张"生成，再折算为 USDT 成交额，保持与真实数据同口径
    const v = cfg.volUnit * (0.45 + rng() * 0.8) * (1 + bodyPct / cfg.vol / 2.2) * c;
    out.push({ ts: start + i * bm, o, h: hi, l: lo, c, v });
    price = c;
  }
  return out;
}

