// ─────────────────────────────────────────────────────────────
//  系统标注的数据清单（store → 渲染图层）
//  三个来源（实时关键位 / 选中信号 / 订单流判读）汇总成一份清单，
//  由同一个图层统一合并、排版、避让后绘制。
// ─────────────────────────────────────────────────────────────

export type AnnTone = 'top' | 'bottom' | 'neck' | 'entry' | 'stop' | 'target' | 'zone' | 'warn' | 'long' | 'short';

/** 主次：focus = 当前选中信号；read = 当前订单流判读；normal = 有效关键位；faint = 历史/已破 */
export type AnnRank = 'focus' | 'read' | 'normal' | 'faint';

export interface AnnLevel {
  id: string;
  price: number;
  /** 线从哪根 K 线开始 */
  fromTs: number;
  /** 线画到哪根为止；null = 延伸到最右侧 */
  toTs: number | null;
  tone: AnnTone;
  /** 标签名（不含价格），例如「双顶」「入场」 */
  name: string;
  style: 'solid' | 'dashed' | 'dotted';
  rank: AnnRank;
  /** 越大越重要（空间不够时谁让谁） */
  priority: number;
  /** 是否允许在右侧轨道上显示文字 */
  label: boolean;
  /** 实色底标签（入场 / 止损 / 目标） */
  solid?: boolean;
  /** 悬停卡片内容 */
  detail?: string[];
}

export interface AnnEvent {
  id: string;
  /** 事件所在 K 线 */
  ts: number;
  side: 'above' | 'below';
  tone: AnnTone;
  /** 常驻短字（≤ 8 个字左右） */
  text: string;
  priority: number;
  marker: 'tri' | 'diamond';
  title?: string;
  detail?: string[];
}

export interface AnnZone {
  id: string;
  fromTs: number;
  toTs: number;
  lo: number;
  hi: number;
  tone: AnnTone;
  text: string;
  priority: number;
  failed?: boolean;
  title?: string;
  detail?: string[];
}

export interface AnnPosition {
  side: 'long' | 'short';
  entryTs: number;
  endTs: number;
  entry: number;
  stop: number;
  tp: number;
}

/** 用户自己画的线 / 图形：标签要避开 */
export interface AnnObstacle {
  kind: 'hline' | 'points';
  points: { time: number; price: number }[];
}

export interface AnnPath {
  id: string;
  points: { ts: number; price: number }[];
  tone: AnnTone;
}

export interface AnnPayload {
  levels: AnnLevel[];
  events: AnnEvent[];
  zones: AnnZone[];
  /** Optional shape geometry; original annotation producers remain compatible. */
  paths?: AnnPath[];
  position: AnnPosition | null;
  obstacles: AnnObstacle[];
  decimals: number;
  rev: number;
}

export const EMPTY_PAYLOAD: AnnPayload = { levels: [], events: [], zones: [], position: null, obstacles: [], decimals: 2, rev: 0 };

export const TONE_COLOR: Record<AnnTone, string> = {
  top: '#f6465d',
  short: '#f6465d',
  stop: '#f6465d',
  bottom: '#2ebd85',
  long: '#2ebd85',
  target: '#2ebd85',
  neck: '#37c8dd',
  zone: '#37c8dd',
  entry: '#f0b90b',
  warn: '#f0b90b',
};

export const decimalsFor = (price: number) => {
  const p = Math.abs(price);
  return p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : 5;
};
