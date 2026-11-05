import assert from 'node:assert/strict';
import { buildContext } from '@/quant/context';
import { analyzeMwStory, buildMwStories, selectMwStories } from '@/vela/signals/mwStory';
import { evaluateLine } from '@/vela/signals/scenario';
import { readMwEvidence } from '@/vela/signals/evidence';
import { analyzeSignals, projectSignals } from '@/vela/signals/analyze';
import { createSignalStore, DEFAULT_PREFERENCES, LEGACY_SIGNAL_STORAGE_KEY, SIGNAL_STORAGE_KEY, SIGNAL_TYPES, normalizePreferences } from '@/vela/signals/store';
import { annotationCandles, annotationFlow } from './signal-fixtures';
import { MS, W, M, bar, flat, broken, retested, mirror, flowOf } from './mw-fixtures';
import type { Candle } from '@/lib/types';
import type { FlowSnapshot } from '@/quant/flow';
let passed = 0;
const pass = (name: string) => { passed++; console.log(`PASS ${name}`); };
const run = (cs: Candle[], p = W, flow?: FlowSnapshot | null, livePrice?: number) => analyzeMwStory({ pattern: p, ctx: buildContext(cs, flow), flow, barMs: MS, livePrice });

// This test failed on the old implementation: 1.5 ATR of travel is NOT reaching the neckline/extension.
{
  const r = run(flat());
  assert.ok(!r.title.includes('已兑现') && r.story!.phase !== 'target-reached');
  assert.equal(r.story!.targets.firstTouchAt, null);
  assert.equal(r.story!.targets.extensionTouchAt, null);
  assert.ok(r.story!.evidence.confirmVolume !== null);
  assert.equal(r.story!.sections.length, 6);
  pass('未到颈线不能标已兑现；六段明细包括确认K量比');
}
{
  const cs = broken(); const r = run(cs);
  assert.equal(r.story!.phase, 'break-wait'); assert.equal(r.story!.bias, 'long');
  assert.equal(r.story!.lineKind, 'neck'); assert.match(r.title, /等回踩/);
  assert.ok(r.story!.sections[4].lines.some(x => x.includes('不能预测到达时间')));
  const m = run(mirror(cs), M);
  assert.equal(m.story!.phase, 'break-wait'); assert.equal(m.story!.bias, 'short'); assert.match(m.title, /等反抽/);
  assert.equal(m.story!.breakVolume, r.story!.breakVolume);
  pass('颈线上破等回踩、下破等反抽，完全镜像，不假装预测会到达');
}
{
  const r = run(retested());
  assert.equal(r.story!.phase, 'break-held'); assert.match(r.title, /回踩守住/);
  assert.equal(r.story!.path!.reachedIdx, 72); assert.equal(r.story!.path!.retestConfirmedAt, 72);
  assert.equal(r.story!.retestVolume, 1200 / 2500);
  assert.ok(r.story!.retestDepth! < .618);
  const heavy = run(retested(78, 2500));
  assert.equal(heavy.story!.phase, 'break-retest', 'uncontracted 1x retest is not confirmed');
  assert.equal(heavy.story!.bias, null);
  const weak = run(broken(78, 70, 600));
  assert.equal(weak.story!.phase, 'break-weak'); assert.equal(weak.story!.bias, null);
  pass('回踩收缩/深度/收盘位置共同确认；放量回踩、缩量破位只观察');
}
{
  const cs = broken(74);
  cs[72] = bar(72, 109.2, 109.3, 108, 108.05, 1000);
  cs[73] = bar(73, 108.05, 109.3, 108, 109.1, 1000);
  const first = run(cs.slice(0, 73));
  assert.equal(first.story!.path!.state, 'touch'); assert.equal(first.story!.path!.retestConfirmedAt, -1);
  assert.notEqual(first.story!.phase, 'break-held');
  const later = run(cs);
  assert.equal(later.story!.path!.reachedIdx, 72); assert.equal(later.story!.path!.retestConfirmedAt, 73);
  const held = later.story!.timeline.find(e => e.label.includes('收盘守在突破侧'))!;
  assert.equal(held.at, cs[73].ts + MS, 'confirmation cannot be backdated to first touch');
  pass('首次触带和真正收盘守住有各自时间，不事后回填确认');
}
{
  const cs = broken(76); cs[72] = bar(72, 109.2, 109.3, 106.4, 106.5, 1800);
  for (let i = 73; i < cs.length; i++) cs[i] = bar(i, 106.5, 106.8, 106.2, 106.5);
  const r = run(cs);
  assert.equal(r.story!.phase, 'break-failed'); assert.equal(r.story!.bias, 'short');
  assert.ok(r.zone!.failed); assert.ok(r.zone!.toTs <= cs[72].ts + MS);
  assert.equal(r.event!.ts, cs[72].ts);
  pass('收回颈线即更新为突破失败，事件和区带停在真实失败时点');
}
{
  const cs = flat(76); cs[70] = bar(70, 102, 102.1, 98.7, 99, 2500);
  cs[71] = bar(71, 99, 99.2, 98.2, 98.5, 2500);
  for (let i = 72; i < cs.length; i++) cs[i] = bar(i, 98.5, 98.9, 98.1, 98.6);
  const r = run(cs);
  assert.equal(r.story!.lineKind, 'level'); assert.equal(r.story!.invalidated, true);
  assert.equal(r.story!.bias, 'short'); assert.match(r.title, /等反抽/);
  assert.equal(r.story!.targets.suspended, true);
  pass('双底支撑失守跟踪向下反抽，原目标暂停，不给相反的两套结论');
}
{
  const cs = broken(80); cs[74] = bar(74, 109.3, 116.2, 109, 115.8);
  for (let i = 75; i < cs.length; i++) cs[i] = bar(i, 115.8, 116.1, 115.4, 115.8);
  const r = run(cs);
  assert.equal(r.story!.targets.extension, 116); assert.equal(r.story!.phase, 'target-reached');
  assert.equal(r.story!.targets.extensionTouchAt, cs[74].ts + MS);
  assert.equal(run(cs.slice(0, 74)).story!.targets.extensionTouchAt, null);
  assert.ok(r.detail.some(x => x.includes('价格触达不是账户利润')));
  pass('延伸位真实触达才标完成，未用未来数据，也不声称账户盈利');
}
{
  const cs = broken(190, 181); const r = run(cs);
  assert.equal(r.story!.phase, 'break-wait'); assert.equal(r.story!.active, true);
  assert.equal(selectMwStories([r]).length, 1, 'old formation with a fresh neckline event must remain painted');
  pass('形态虽旧，新颈线事件仍可见，按最后活动时间而非形态年龄过滤');
}
{
  const cs = flat(80); const p2 = { ...W, first: 42, second: 64, idx: 64, level: 101.5, secondPrice: 101.4 };
  const stories = buildMwStories({ patterns: [W, W, p2], ctx: buildContext(cs), barMs: MS });
  assert.equal(stories.length, 1); assert.equal(stories[0].story!.patternCount, 2);
  assert.equal(stories[0].story!.testCount, 3);
  const separated = { ...W, first: 65, second: 77, idx: 77, neckIdx: 71 };
  assert.equal(buildMwStories({ patterns: [W, separated], ctx: buildContext(cs), barMs: MS }).length, 2, 'non-overlapping episodes must not be merged');
  pass('共颈线的重叠结构归并；不同历史周期不误合并；重复识别不重复计数');
}
{
  const cs = flat(65); const full = flowOf(cs); const no = run(cs).story!;
  assert.equal(no.evidence.test, null); assert.equal(no.evidence.cvdRatio, null);
  assert.equal(no.trap?.source, 'price'); assert.ok(!no.trap?.label.includes('诱空'));
  const yes = run(cs, W, full).story!;
  assert.equal(yes.trap?.source, 'real'); assert.match(yes.trap!.label, /诱空候选/);
  const gapped = flowOf(cs); gapped.bars.delete(cs[48].ts);
  assert.equal(readMwEvidence(buildContext(cs, gapped), W, MS, gapped).cvdRatio, null);
  for (const scale of [.849, .851]) {
    const flow = flowOf(cs); const b = flow.bars.get(cs[60].ts)!; b.buy *= scale; b.sell *= scale;
    assert.equal(!!run(cs, W, flow).story!.evidence.test, scale >= .85);
  }
  assert.equal(run(flat(73), W, flowOf(flat(73))).story!.trap?.active, true);
  assert.equal(run(flat(74), W, flowOf(flat(74))).story!.trap?.active, false);
  pass('扫位与真成交分级；85%边界、CVD连续性、12根陷阱观察窗不造证据');
}
{
  const cs = retested(); const base = run(cs), live = run(cs, W, null, 80);
  assert.equal(live.story!.phase, base.story!.phase); assert.equal(live.story!.bias, base.story!.bias);
  assert.deepEqual(live.story!.targets, base.story!.targets);
  assert.equal(live.title, base.title); assert.equal(live.event!.ts, base.event!.ts);
  assert.ok(live.story!.preview?.includes('不改变已确认阶段'));
  assert.equal(base.story!.preview, null);
  const prefix = run(cs.slice(0, 73));
  assert.deepEqual(base.story!.origin, prefix.story!.origin); assert.deepEqual(base.story!.evidence, prefix.story!.evidence);
  const before = evaluateLine(buildContext(cs.slice(0, 73)), MS, 108, 1, 60, 'neck')!;
  const after = evaluateLine(buildContext(cs), MS, 108, 1, 60, 'neck')!;
  assert.deepEqual(after.events.filter(v => v.idx <= 72), before.events);
  assert.deepEqual([after.lo, after.hi], [before.lo, before.hi]);
  pass('盘中预览分离；新收盘可更新阶段，但原始证据、旧事件与区带宽度不回写');
}
{
  const cs = annotationCandles(), now = cs.at(-1)!.ts + MS;
  const prefs = normalizePreferences(DEFAULT_PREFERENCES);
  const a = analyzeSignals(cs, MS, prefs, annotationFlow(cs), now);
  assert.equal(a.items.filter(i => i.story).length, 1);
  assert.ok(a.items.every(i => !['keyLevelFlow', 'bullTrap', 'bearTrap', 'cvdDivergence', 'keyLevelScenario', 'smartMoney'].includes(i.type)));
  const view = projectSignals(a, prefs); assert.equal(view.visible.length, 1);
  assert.equal(view.payload.events.length, 1); assert.ok(view.payload.zones.length <= 2);
  const noTop = projectSignals(a, { ...prefs, selected: { ...prefs.selected, doubleTop: false } });
  assert.equal(noTop.payload.events.length, 0); assert.equal(noTop.payload.zones.length, 0);
  const noZone = projectSignals(a, { ...prefs, selected: { ...prefs.selected, keyLevelScenario: false } });
  assert.equal(noZone.payload.zones.length, 0); assert.equal(noZone.visible.length, 1);
  pass('端到端一形态一记录，移除四类重复条目，开关不产生孤儿区带');
}
{
  assert.equal(SIGNAL_TYPES.length, 7);
  const saved = new Map<string, string>([[LEGACY_SIGNAL_STORAGE_KEY, JSON.stringify({ ...DEFAULT_PREFERENCES, lookback: 1200, preview: true, labels: false, selected: { doubleTop: false, doubleBottom: true, bullTrap: true, keyLevels: true, deltaImpulse: false } })]]);
  const store = createSignalStore({ getItem: k => saved.get(k) ?? null, setItem: (k, v) => { saved.set(k, v); } });
  const p = store.getSnapshot().preferences;
  assert.equal(p.lookback, 1200); assert.equal(p.labels, false); assert.equal(p.preview, true);
  assert.equal(p.selected.doubleTop, false); assert.equal(p.selected.keyLevels, true);
  assert.ok(saved.has(SIGNAL_STORAGE_KEY)); assert.ok(saved.has(LEGACY_SIGNAL_STORAGE_KEY));
  assert.equal(Object.keys(p.selected).length, 7);
  pass('v1偏好迁移保留共有设置与旧备份，不把用户配置整体重置');
}
{
  const cs = flat(200), old = run(cs), now = cs.at(-1)!.ts + MS;
  assert.equal(old.story!.active, false);
  const analysis = { items: [old], bars: cs.length, covered: 0, requested: 600, gapTruncated: false, historyShort: false, lastPrice: cs.at(-1)!.c };
  const normal = projectSignals(analysis, DEFAULT_PREFERENCES);
  assert.equal(normal.payload.events.length, 0);
  const focused = projectSignals(analysis, DEFAULT_PREFERENCES, old.id);
  assert.equal(focused.payload.events.length, 1);
  assert.ok(focused.payload.levels.every(l => l.toTs !== null && l.toTs <= now));
  assert.equal(old.story!.active, false, 'focus must not resurrect an expired signal');
  const store = createSignalStore(); store.focus(old.id);
  assert.equal(store.getSnapshot().focusId, old.id); store.focus(null);
  assert.equal(store.getSnapshot().focusId, null);
  pass('历史点选可显示几何；不复活状态，不延伸未来，不修改分析数据');
}
console.log(`M/W story: ${passed} groups passed`);
