// 回归：标注文案大白话改写（2026-11-10 用户确认的示例）、换行标点、亚盘右侧标签（今日 / 昨日、只给仍有效的价位）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Candle } from '@/lib/types';
import { fmtWhen } from '@/lib/displayTime';
import { railLabelTexts, wrapText } from '@/vela/annotLayout';
import { asiaDayWord, asiaRailLevels } from '@/vela/sessions/asiaRail';
import type { BarLike } from '@/vela/sessions/sessionMath';
import { buildFrameworks } from '@/quant/frameworks';
import { DEFAULT_FRAMEWORK_MARK_PREFS, projectFrameworkMarks } from '@/quant/frameworkMarks';

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const H = 3_600_000, DAY = 86_400_000, MS = 300_000;

// 1. 换行：句号 / 逗号 / 右括号不出现在行首，左括号不留在行尾
{
  const measure = (s: string) => [...s].length * 10;
  const text = '价格回到这里常有反应：空头缺口偏压力；被完全填满就失效。';
  for (let w = 60; w <= 300; w += 10) {
    const lines = wrapText(text, w, measure);
    assert.equal(lines.join(''), text, 'wrapping must not drop characters');
    for (const l of lines.slice(1)) assert.ok(!/^[。，、；：！？）」』】》%,.;:!?)]/.test(l), `line starts with punctuation at width ${w}: ${JSON.stringify(lines)}`);
    for (const l of lines.slice(0, -1)) assert.ok(!/[（「『【《(]$/.test(l), `line ends with an opening bracket at width ${w}: ${JSON.stringify(lines)}`);
  }
  // 截图里的真实情况：最后一个「。」以前会单独占一行
  const lines = wrapText('价格回到这里常有反应：空头缺口偏压力；被完全填满就失效。', 280, measure);
  assert.ok(lines.every(l => l !== '。'));
  // 价格、时间不从中间断开
  const nums = wrapText('16:55 的下跌缺口 74406.4–74585.8、18:00 的前高 74525.0，下一站成交最多 74675.0。', 150, measure);
  for (const l of nums) assert.ok(!/^[0-9.–:]/.test(l) || /^(74406\.4–74585\.8|74525\.0|74675\.0|16:55|18:00)/.test(l), JSON.stringify(nums));
  assert.ok(nums.every(l => !/\d$/.test(l) || /(74406\.4–74585\.8|74525\.0|74675\.0|16:55|18:00)$/.test(l.trimEnd())), JSON.stringify(nums));
  pass('1 · 换行不再把「。」甩到行首（标点悬挂），左括号随后面的字一起换行，价格和时间不拆开');
}

// 2. 相对时间：今天只写时刻，昨天写「昨天」，更早写日期（都是北京时间）
{
  const ref = Date.UTC(2026, 10, 10, 6, 30); // 北京 11-10 14:30
  assert.equal(fmtWhen(Date.UTC(2026, 10, 10, 5, 50), ref), '13:50');
  assert.equal(fmtWhen(Date.UTC(2026, 10, 9, 14, 10), ref), '昨天 22:10');
  assert.equal(fmtWhen(Date.UTC(2026, 10, 7, 1, 30), ref), '11-07 09:30');
  assert.equal(fmtWhen(Date.UTC(2026, 10, 9, 16, 5), ref), '00:05', '北京 00:05 已是今天');
  pass('2 · 悬停时间：今天「13:50」、昨天「昨天 22:10」、更早「11-07 09:30」');
}

// 3. 亚盘右侧标签：今日 / 昨日；只给到现在仍没被碰过的价位
{
  const D = Date.UTC(2026, 10, 10); // 今天的 UTC 日（北京 11-10 08:00 起是今天的亚盘）
  const mk = (t: number, lo: number, hi: number): BarLike => ({ time: t, open: (lo + hi) / 2, high: hi, low: lo, close: (lo + hi) / 2, confirm: 1 });
  const bars: BarLike[] = [];
  // 昨天亚盘 99–102；昨天其余时间与今天都在 100.2–101.8 之间
  for (let t = D - DAY; t < D - DAY + 8 * H; t += MS) bars.push(mk(t, t === D - DAY + H ? 99 : 100.4, t === D - DAY + 2 * H ? 102 : 101.6));
  for (let t = D - DAY + 8 * H; t < D; t += MS) bars.push(mk(t, 100.3, 101.7));
  // 今天亚盘 100.5–101.5，之后（北京 16:00 后）在 100.7–101.3
  for (let t = D; t < D + 8 * H; t += MS) bars.push(mk(t, t === D + 3 * H ? 100.5 : 100.8, t === D + 5 * H ? 101.5 : 101.2));
  for (let t = D + 8 * H; t <= D + 10 * H; t += MS) bars.push(mk(t, 100.7, 101.3));
  const now = D + 10 * H + 2 * MS;

  const levels = asiaRailLevels(bars, now);
  const byName = new Map(levels.map(l => [l.name, l]));
  assert.deepEqual([...byName.keys()].sort(), ['今日亚盘低', '今日亚盘高', '昨日亚盘低', '昨日亚盘高'].sort(), JSON.stringify([...byName.keys()]));
  assert.equal(byName.get('昨日亚盘低')!.price, 99);
  assert.equal(byName.get('今日亚盘高')!.price, 101.5);
  assert.ok(levels.every(l => l.railOnly && l.tone === 'asia'), '亚盘线由时段图层画，这里只出右侧标签');
  assert.equal(byName.get('今日亚盘高')!.detail![0], '今天 08:00–16:00 亚洲时段的最高价。');
  assert.equal(byName.get('今日亚盘高')!.detail![1], '欧美盘冲过去又收回 → 假突破，偏空；收盘站上 → 突破。');
  assert.equal(byName.get('昨日亚盘低')!.detail![0], '昨天 08:00–16:00 亚洲时段的最低价，还没被跌破。');
  assert.ok(byName.get('今日亚盘高')!.priority > byName.get('昨日亚盘高')!.priority, '今天的亚盘更重要');

  // 今天跌破了昨天的亚盘低 → 昨日亚盘低的标签消失（旧线不再在右边留孤零零的标签）
  const touched = bars.map(b => (b.time === D + 9 * H ? { ...b, low: 98.8 } : b));
  const after = asiaRailLevels(touched, now).map(l => l.name);
  assert.ok(!after.includes('昨日亚盘低'), after.join(','));
  assert.ok(after.includes('昨日亚盘高'));

  // 亚盘进行中：写「到现在」并提示还会变
  const running = bars.filter(b => b.time <= D + 5 * H);
  const live = asiaRailLevels(running, D + 5 * H + 2 * MS).find(l => l.name === '今日亚盘高')!;
  assert.ok(live.detail![0].includes('到现在') && live.detail!.at(-1)!.includes('16:00 前还会变'), JSON.stringify(live.detail));

  // 北京凌晨（UTC 前一日 18:00）：最近一次亚盘是北京「昨日」
  assert.equal(asiaDayWord(D, D + 18 * H), '昨日');
  assert.equal(asiaDayWord(D, D + 10 * H), '今日');
  pass('3 · 亚盘标签写明今日 / 昨日，只给到现在仍没被碰过的价位；进行中会提示还会变');
}

// 4. 四框架悬停：最多 4 行、没有 ATR / 摆动 / 流动性 / 机构等术语、今天的时间不带日期
{
  const T0 = Date.UTC(2026, 10, 10, 0, 0);
  const bar = (i: number, p: number): Candle => ({ ts: T0 + i * MS, o: p, h: p + 0.25, l: p - 0.25, c: p + 0.05, v: 1000 + (i % 7) * 120, confirm: 1, volumeSource: 'quote' });
  const cs = Array.from({ length: 200 }, (_, i) => bar(i, 100 + Math.sin(i / 6) * 2.2 + Math.sin(i / 2.3) * 0.6 + i * 0.004));
  const report = buildFrameworks(cs, MS, 'SOL-USDT-SWAP', '5m', null, cs.at(-1)!.ts + MS + 1)!;
  const m = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  const items = [...m.payload.levels, ...m.payload.events, ...m.payload.zones];
  assert.ok(items.length >= 4, `marks ${items.length}`);
  for (const it of items) {
    const d = it.detail ?? [];
    assert.ok(d.length >= 1 && d.length <= 4, `${it.id} has ${d.length} lines`);
    const text = d.join('');
    assert.ok(!/ATR|摆动|流动性|机构|止损单位置/.test(text), `${it.id}: ${text}`);
    assert.ok(!/11-10 \d{2}:\d{2}/.test(text), `${it.id} 今天的时间不该带日期: ${text}`);
  }
  const names = m.payload.levels.map(l => l.name);
  assert.ok(names.every(n => !/POC|VAH|VAL|EQH|EQL/.test(n)), names.join(','));
  assert.ok(m.hud!.rows.every(r => ['上涨', '下跌', '震荡', '—'].includes(r.word)), JSON.stringify(m.hud!.rows));
  // 「不是下单建议」这类共用说明只在四框架面板底部说一次，不再每段盘面都写
  assert.ok(m.hud!.detail.every(l => !l.includes('不是下单建议')), JSON.stringify(m.hud!.detail));
  assert.ok(readFileSync('src/components/FrameworksPanel.tsx', 'utf8').includes('不是下单建议'));
  pass('4 · 每条悬停最多 4 行、无术语、今天只写时刻；右上角汇总写「30m 震荡」');
}

// 5. 右侧标签：同价位两个含义并排写，不再一个盖住另一个；待确认带「还差 N 根」；放不下时逐级缩短
{
  const merged = railLabelTexts([{ name: '前低' }, { name: '今日亚盘低' }], 0, '85.45', '85.45');
  assert.equal(merged.pairName, '前低 · 今日亚盘低');
  assert.equal(merged.tries[0], '前低 · 今日亚盘低 85.45');
  assert.ok(merged.tries.includes('前低 85.45 +1'), JSON.stringify(merged.tries));
  assert.equal(merged.tries.at(-1), '85.45 +1');
  const three = railLabelTexts([{ name: '前低' }, { name: '今日亚盘低' }, { name: '密集区下沿' }], 0, '85.45', '85.45');
  assert.equal(three.tries[0], '前低 · 今日亚盘低 85.45 +1');
  const pending = railLabelTexts([{ name: '前高?', note: '（还差 2 根）' }], 0, '86.58', '86.58');
  assert.deepEqual(pending.tries, ['前高? 86.58（还差 2 根）', '前高? 86.58', '86.58']);
  pass('5 · 同价位标签合并成「前低 · 今日亚盘低 85.45」；待确认写「（还差 2 根）」；空间不够逐级缩短');
}

console.log(`plain-wording: ${passed} 项通过`);
