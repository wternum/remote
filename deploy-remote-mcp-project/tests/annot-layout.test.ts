// 标注排版算法单元测试
// 运行：node scripts/run-ts-test.mjs tests/annot-layout.test.ts
import assert from 'node:assert/strict';
import {
  buildOccupancy,
  eventCandidates,
  intersects,
  inside,
  layoutRail,
  mergeLevels,
  pickCandidate,
  placeCard,
  wrapText,
  zoneCandidates,
  type Column,
  type Rect,
} from '../src/vela/annotLayout';

const H = 14;

// ── 1. 关键位合并：缩小时合并，放大后自动分开 ──
{
  const lv = (id: string, y: number, price: number, priority = 50) => ({ id, y, price, priority });
  const zoomedOut = mergeLevels([lv('a', 100, 93.78), lv('b', 103, 93.76, 90), lv('c', 108, 93.7), lv('d', 200, 92)], 6);
  assert.equal(zoomedOut.length, 2, '6px 内的关键位合并成一条');
  assert.equal(zoomedOut[0].lead.id, 'b', '合并组由优先级最高的代表');
  assert.equal(zoomedOut[0].y, 103, '线画在代表项的价位上');
  assert.deepEqual([zoomedOut[0].lo, zoomedOut[0].hi], [93.7, 93.78]);
  const zoomedIn = mergeLevels([lv('a', 100, 93.78), lv('b', 130, 93.76), lv('c', 170, 93.7)], 6);
  assert.equal(zoomedIn.length, 3, '放大后分开');
  console.log('PASS 关键位合并 · 缩小合并 / 放大分开');
}

// ── 2. 右侧轨道：不重叠、不出界、过密折叠成 +N ──
{
  const items = [0, 1, 2, 3, 4].map(i => ({ id: `l${i}`, y: 100 + i, h: H, priority: 50 + i }));
  const out = layoutRail(items, 0, 400, { gap: 2, window: 60, maxPerWindow: 4 });
  assert.equal(out.length, 4, '60px 内最多 4 个');
  assert.equal(out.reduce((s, o) => s + o.folded.length, 0), 1, '多出来的折叠成 +1');
  assert.ok(!out.some(o => o.id === 'l0'), '折叠的是优先级最低的');
  const ys = out.map(o => o.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= H + 2 - 1e-9, '轨道标签不重叠');

  const edge = layoutRail(
    [0, 1, 2].map(i => ({ id: `e${i}`, y: 398 + i, h: H, priority: 50 })),
    0,
    400,
  );
  for (const o of edge) assert.ok(o.y + H / 2 <= 400 + 1e-9 && o.y - H / 2 >= 0, '贴底时整体上推，不出界');

  // 稳定：同样输入同样结果；远处的标签变化不影响这里
  const a = layoutRail(items.slice(1), 0, 400);
  const b = layoutRail([...items.slice(1), { id: 'far', y: 380, h: H, priority: 10 }], 0, 400);
  for (const o of a) assert.equal(b.find(x => x.id === o.id)!.y, o.y, '远处标签不影响近处排版');
  console.log('PASS 右侧轨道 · 推开 / 贴边 / +N / 稳定');
}

// ── 3. 事件标签：不压 K 线、被挡时挪开、实在放不下就只留标记 ──
function candles(n: number, x0: number, step: number, f: (i: number) => [number, number]): Column[] {
  return Array.from({ length: n }, (_, i) => {
    const [top, bottom] = f(i);
    return { x: x0 + i * step, top, bottom };
  });
}
{
  const bounds: Rect = { x: 0, y: 0, w: 800, h: 400 };
  // 平缓 K 线，第 10 根是事件K；第 11、12 根是很高的长上影，正好挡在默认位置
  const cols = candles(40, 20, 8, i => (i === 11 || i === 12 ? [40, 260] : [200 - (i === 10 ? 20 : 0), 260]));
  const occ = buildOccupancy(cols, 3);
  const ev = cols[10];
  const markerEdge = ev.top - 3 - 10;
  const cands = eventCandidates({ x: ev.x, markerEdge, side: 'above', w: 64, h: H }, occ);
  const pick = pickCandidate(cands, occ, [], bounds)!;
  assert.ok(pick, '应能找到位置');
  assert.ok(!occ.hits(pick.rect), '标签不压 K 线');
  assert.ok(inside(pick.rect, bounds), '标签在绘图区内');
  assert.ok(pick.rect.y + pick.rect.h <= 40 || pick.rect.x + pick.rect.w < cols[11].x - 3 || pick.rect.y >= 260, '被长影线挡住时绕开');

  // 上下左右全被占满 → null（只留标记）
  const full = buildOccupancy(candles(100, 0, 8, () => [0, 400]), 3);
  assert.equal(pickCandidate(eventCandidates({ x: 400, markerEdge: 10, side: 'above', w: 64, h: H }, full), full, [], bounds), null);
  console.log('PASS 事件标签 · 绕开 K 线 / 放不下只留标记');
}

// ── 4. 区域标签：框内被 K 线穿过时放到框外 ──
{
  const bounds: Rect = { x: 0, y: 0, w: 800, h: 400 };
  const cols = candles(60, 10, 8, () => [150, 250]);
  const occ = buildOccupancy(cols, 3);
  const box: Rect = { x: 200, y: 180, w: 200, h: 40 };
  const pick = pickCandidate(zoneCandidates(box, 50, H, occ), occ, [], bounds)!;
  assert.ok(pick && !occ.hits(pick.rect), '区域标签不压 K 线');
  console.log('PASS 区域标签 · 框内被占时移到框外', pick.key);
}

// ── 5. 随机压力测试：任意两个标签不重叠、不压 K 线、不出界 ──
{
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const bounds: Rect = { x: 0, y: 0, w: 900, h: 420 };
  let placedTotal = 0;
  for (let t = 0; t < 300; t++) {
    let px = 210;
    const cols = candles(100, 4, 8, () => {
      px += (rnd() - 0.5) * 18;
      px = Math.max(40, Math.min(380, px));
      const top = px - rnd() * 30;
      return [top, top + 8 + rnd() * 40];
    });
    const occ = buildOccupancy(cols, 3);
    const taken: Rect[] = [{ x: 0, y: 0, w: 320, h: 44 }];
    // 轨道（最新 K 线右边留白）
    const lastX = cols[cols.length - 1].x;
    const rail = layoutRail(
      Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, y: 20 + rnd() * 380, h: H, priority: rnd() * 100 })),
      2,
      418,
    );
    const railRects = rail.map(r => ({ x: 900 - 4 - 60, y: r.y - H / 2, w: 60, h: H }));
    for (const r of railRects) {
      assert.ok(r.x > lastX + 4, '轨道在最新 K 线右侧的空白里');
      assert.ok(!occ.hits(r));
      taken.push(r);
    }
    const placed: Rect[] = [...railRects];
    for (let e = 0; e < 6; e++) {
      const c = cols[5 + Math.floor(rnd() * 95)];
      const side = rnd() > 0.5 ? 'above' : 'below';
      const edge = side === 'above' ? c.top - 13 : c.bottom + 13;
      const mr: Rect = { x: c.x - 5, y: Math.min(edge, side === 'above' ? c.top - 3 : c.bottom + 3), w: 10, h: 10 };
      taken.push(mr);
      const w = 40 + Math.floor(rnd() * 40);
      const pick = pickCandidate(eventCandidates({ x: c.x, markerEdge: edge, side, w, h: H }, occ), occ, taken, bounds);
      if (!pick) continue;
      assert.ok(!occ.hits(pick.rect), '不压 K 线');
      assert.ok(inside(pick.rect, bounds), '不出界');
      for (const p of placed) assert.ok(!intersects(pick.rect, p), '标签互不重叠');
      placed.push(pick.rect);
      taken.push(pick.rect);
      placedTotal++;
    }
    const ys = rail.map(r => r.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= H + 2 - 1e-9);
  }
  assert.ok(placedTotal > 1200, `大部分事件应能放下标签（${placedTotal}/1800）`);
  console.log(`PASS 随机压力测试 · 300 个场景 · ${placedTotal}/1800 个事件标签全部合法`);
}

// ── 6. 性能：50 个轨道标签 + 20 个事件，每帧排版 < 1ms ──
{
  const cols = candles(220, 2, 4, i => [150 + Math.sin(i / 7) * 60, 190 + Math.sin(i / 7) * 60]);
  const bounds: Rect = { x: 0, y: 0, w: 1100, h: 480 };
  const runs = 300;
  const t0 = performance.now();
  for (let k = 0; k < runs; k++) {
    const occ = buildOccupancy(cols, 1.5);
    const taken: Rect[] = [];
    const groups = mergeLevels(Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, y: (i * 37) % 470, price: i, priority: i })), 6);
    layoutRail(groups.map(g => ({ id: g.lead.id, y: g.y, h: H, priority: g.lead.priority })), 2, 478);
    for (let e = 0; e < 20; e++) {
      const c = cols[10 + e * 9];
      const p = pickCandidate(eventCandidates({ x: c.x, markerEdge: c.top - 13, side: 'above', w: 60, h: H }, occ), occ, taken, bounds);
      if (p) taken.push(p.rect);
    }
  }
  const per = (performance.now() - t0) / runs;
  assert.ok(per < 1, `每帧排版 ${per.toFixed(3)}ms 应 < 1ms`);
  console.log(`PASS 性能 · 每帧排版 ${per.toFixed(3)}ms`);
}

// ── 7. 悬停卡片 / 折行 ──
{
  const b: Rect = { x: 0, y: 0, w: 500, h: 300 };
  const r = placeCard({ x: 490, y: 290 }, 200, 80, b);
  assert.ok(inside(r, b) && r.x + r.w <= 490 && r.y + r.h <= 290, '靠右下角时翻到鼠标左上');
  const lines = wrapText('冲向前高时主动买入偏弱（+3%）：缺少突破动能', 60, s => s.length * 10);
  assert.ok(lines.length > 1 && lines.every(l => l.length * 10 <= 60));
  console.log('PASS 悬停卡片翻转 · 折行');
}

console.log('\n标注排版测试全部通过');
