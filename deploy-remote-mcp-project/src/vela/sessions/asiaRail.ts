// 亚盘高低点的右侧价格标签：交给四框架图层的右侧轨道统一排版（与前高 / 前低等标签互相避让，
// 同价位合并成「前低 · 今日亚盘低 85.45」，并带悬停说明）。水平线仍由时段图层自己画。
import type { AnnLevel } from '../annotTypes';
import type { RefPoint } from '@/quant/marketRead';
import { displayDayFloor, fmtMonthDay } from '@/lib/displayTime';
import { computeAsiaRangeLevels, DAY_MS, utcDayFloor, type BarLike } from './sessionMath';

/** 亚盘（UTC 日 00–08 = 北京同日 08–16）相对「今天」的叫法：今日 / 昨日 / 11-08 */
export function asiaDayWord(dayStartMs: number, refTs: number): string {
  const bjDay = displayDayFloor(dayStartMs);
  const today = displayDayFloor(refTs);
  if (bjDay === today) return '今日';
  if (bjDay === today - DAY_MS) return '昨日';
  return fmtMonthDay(dayStartMs);
}

/**
 * 起名字用的参考价：当天和前一天的亚盘最高 / 最低价（不管有没有被打掉），
 * 让「17:05 收盘跌穿 85.45」能说出「85.45 是今天亚盘最低价」。
 */
export function asiaRefs(bars: readonly BarLike[], now = Date.now()): RefPoint[] {
  if (bars.length < 2) return [];
  const refTs = bars[bars.length - 1].time;
  const out: RefPoint[] = [];
  for (const s of computeAsiaRangeLevels(bars, refTs - 2 * DAY_MS, refTs, now)) {
    const word = asiaDayWord(s.dayStartMs, refTs);
    const day = word === '今日' ? '今天' : word === '昨日' ? '昨天' : word;
    out.push({ name: `${day}亚盘最高价`, price: s.high }, { name: `${day}亚盘最低价`, price: s.low });
  }
  return out;
}

/**
 * 只给仍有效（到最新一根已收盘 K 线还没被碰过）的亚盘高低点出标签：当天的，以及延续到今天的前一天的。
 * refTs 是最新一根 K 线时间，用来判断「今日 / 昨日」与亚盘是否还在进行。
 */
export function asiaRailLevels(bars: readonly BarLike[], now = Date.now()): AnnLevel[] {
  if (bars.length < 2) return [];
  const refTs = bars[bars.length - 1].time;
  const summaries = computeAsiaRangeLevels(bars, refTs - 2 * DAY_MS, refTs, now);
  const out: AnnLevel[] = [];
  for (const s of summaries) {
    const word = asiaDayWord(s.dayStartMs, refTs);
    const dayText = word === '今日' ? '今天' : word === '昨日' ? '昨天' : word;
    // 当前这一天的亚盘（UTC 日 = 最新 K 线所在日）更重要；延续下来的前一天次之
    const current = s.dayStartMs === utcDayFloor(refTs);
    const running = current && refTs < s.asiaEndMs;
    for (const high of [true, false]) {
      if (!(high ? s.highLive : s.lowLive)) continue;
      const price = high ? s.high : s.low;
      out.push({
        id: `asia:${s.dayStartMs}:${high ? 'high' : 'low'}`,
        price,
        fromTs: high ? s.highBarMs : s.lowBarMs,
        toTs: null,
        tone: 'asia',
        name: `${word}亚盘${high ? '高' : '低'}`,
        style: 'dashed',
        rank: current ? 'read' : 'normal',
        priority: current ? 60 : 46,
        label: true,
        railOnly: true,
        detail: [
          `${dayText} 08:00–16:00 亚洲时段${running ? '到现在' : ''}的最${high ? '高' : '低'}价${current ? '' : `，还没被${high ? '突破' : '跌破'}`}。`,
          high
            ? `${current ? '欧美盘' : ''}冲过去又收回 → 假突破，偏空；收盘站上 → 突破。`
            : `${current ? '欧美盘' : ''}跌破又收回 → 假跌破，偏多；收盘跌破 → 破位。`,
          ...(running ? ['（亚盘还没结束，16:00 前还会变）'] : []),
        ],
      });
    }
  }
  return out;
}
