// 标注排版算法单元测试
// 运行：node scripts/run-ts-test.mjs tests/annot-layout.test.ts
import assert from 'node:assert/strict';
import {
  attachedZoneCandidates,
  buildOccupancy,
  eventCandidates,
  rectGap,
  ZONE_LABEL_MAX_GAP,
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

// ── 8. 贴附式区域标签：细 FVG 区域被最新 K 线穿过时，标签不得漂到远处价位 ──
{
  const bounds: Rect = { x: 0, y: 0, w: 900, h: 560 };
  // 复现截图场景：一段 K 线从上到下穿过细 FVG 区域的右端，且价格跨度很大。
  const cols = candles(80, 20, 9, i => [80 + (i % 7) * 40, 260 + (i % 5) * 50]);
  const occ = buildOccupancy(cols, 3);
  const last = cols[cols.length - 1];
  const box: Rect = { x: 300, y: 300, w: last.x + 18 - 300, h: 5 }; // 细区域，延伸到最新 K 线右侧 2 根
  const w = 44;

  // 候选本身：每一个都必须贴着区域（间隙 ≤ 4px），不存在越过整段 K 线的远端候选。
  for (const c of attachedZoneCandidates(box, w, H)) {
    assert.ok(rectGap(c.rect, box) <= ZONE_LABEL_MAX_GAP + 1e-9, `候选 ${c.key} 离开区域 ${rectGap(c.rect, box).toFixed(1)}px`);
  }

  const pick = pickCandidate(attachedZoneCandidates(box, w, H), occ, [], bounds);
  assert.ok(pick, '最新 K 线右侧有空白时应能贴边放下');
  assert.equal(pick!.key, 'right-mid', '优先放在区域右端外侧、价位居中');
  assert.ok(!occ.hits(pick!.rect), '标签不压 K 线');
  assert.ok(rectGap(pick!.rect, box) <= ZONE_LABEL_MAX_GAP, '标签与区域贴附');
  const cy = box.y + box.h / 2;
  assert.ok(Math.abs(pick!.rect.y + H / 2 - cy) <= H / 2 + 0.5, '标签垂直中心对齐区域价位');

  // 右侧空白被价格轨道标签占用、区域内外都被 K 线覆盖 → 不画文字（null），而不是漂移。
  const fullOcc = buildOccupancy(candles(120, 0, 8, () => [0, 560]), 3);
  const blocked = pickCandidate(attachedZoneCandidates(box, w, H), fullOcc, [], bounds);
  assert.equal(blocked, null, '没有贴边空位时宁可不画文字');

  // 对照：旧的通用候选在同一场景下会给出远离区域的位置，证明这是漂移根因。
  const legacy = pickCandidate(zoneCandidates(box, w, H, occ), occ, [], bounds);
  if (legacy && legacy.key.endsWith('candles')) {
    assert.ok(rectGap(legacy.rect, box) > ZONE_LABEL_MAX_GAP, '旧候选的越过 K 线位置确实远离区域');
  }
  console.log(`PASS 贴附式区域标签 · 细 FVG 被 K 线穿过时贴边或隐藏文字（旧候选：${legacy?.key ?? 'null'}）`);
}

// ── 9. 贴附式区域标签随机压力：任何放下的标签都贴着所属区域、不压 K 线、不出界 ──
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const bounds: Rect = { x: 0, y: 0, w: 900, h: 480 };
  let placed = 0;
  for (let t = 0; t < 400; t++) {
    let px = 240;
    const cols = candles(90, 10, 9, () => {
      px += (rnd() - 0.5) * 30;
      px = Math.max(40, Math.min(420, px));
      return [px - rnd() * 40, px + 10 + rnd() * 40];
    });
    const occ = buildOccupancy(cols, 3);
    const taken: Rect[] = [{ x: 0, y: 0, w: 320, h: 44 }];
    for (let z = 0; z < 3; z++) {
      const x0 = cols[Math.floor(rnd() * 70)].x;
      const y = 40 + rnd() * 380;
      const box: Rect = { x: x0, y, w: cols[cols.length - 1].x + 18 - x0, h: 2 + rnd() * 30 };
      const pick = pickCandidate(attachedZoneCandidates(box, 44, H), occ, taken, bounds);
      if (!pick) continue;
      assert.ok(rectGap(pick.rect, box) <= ZONE_LABEL_MAX_GAP + 1e-9, '放下的标签必须贴附所属区域');
      assert.ok(!occ.hits(pick.rect), '不压 K 线');
      assert.ok(inside(pick.rect, bounds), '不出界');
      for (const r of taken) assert.ok(!intersects(pick.rect, r, 2), '不与其他标签重叠');
      taken.push(pick.rect);
      placed++;
    }
  }
  assert.ok(placed > 600, `大多数区域应能贴边放下标签（${placed}/1200）`);
  console.log(`PASS 贴附式区域标签随机压力 · 400 个场景 · ${placed}/1200 个标签全部贴附`);
}

console.log('\n标注排版测试全部通过');
