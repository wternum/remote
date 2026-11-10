// ─────────────────────────────────────────────────────────────
//  系统标注的数据清单（store → 渲染图层）
//  三个来源（实时关键位 / 选中信号 / 订单流判读）汇总成一份清单，
//  由同一个图层统一合并、排版、避让后绘制。
// ─────────────────────────────────────────────────────────────

export type AnnTone = 'top' | 'bottom' | 'neck' | 'entry' | 'stop' | 'target' | 'zone' | 'warn' | 'long' | 'short' | 'asia';

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
  /** 悬停卡片内容；以「（」开头的行按灰色小字显示 */
  detail?: string[];
  /** 右侧标签里价格后面的补充短字，例如「（还差 2 根）」；放不下时先省略它 */
  note?: string;
  /** 只在右侧轨道显示标签与悬停，不画水平线（线由别的图层负责，如亚盘高低点） */
  railOnly?: boolean;
  /** 价位带（压力带 / 支撑带）：右侧标签写成「lo–hi」，price 是离现价最近的那条边 */
  range?: [number, number];
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
  /** 事后确认型标注（如分形）：确认那根 K 线的开盘时间，图上画一条虚线小尾巴指到确认位置 */
  confirmTs?: number;
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
  asia: '#a78bfa',
};

export const decimalsFor = (price: number) => {
  const p = Math.abs(price);
  return p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : 5;
};
