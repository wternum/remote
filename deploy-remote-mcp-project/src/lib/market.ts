import { SYMBOLS } from './types';

/**
 * 接口参数白名单。
 *
 * 旧实现把 `?symbol=` 直接透传给 OKX；OKX 对不存在的合约返回错误后，代码静默
 * 降级到合成行情，而 /api/backtest 又不检查 live 就落库——实测一个
 * `FAKE-USDT-SWAP` 请求即可向 signals 表永久写入 3 条假交易并被计入回测统计。
 * 现在所有读接口在边界上统一拒绝未知标的 / 周期。
 */
export const SYMBOL_IDS: readonly string[] = SYMBOLS.map((s) => s.id);

/** 图表接口额外支持 1m；回测/引擎只支持本项目校验过的 5m / 15m */
export const DATA_BARS = ['1m', '5m', '15m'] as const;
export const SCAN_BARS_ALLOWED = ['5m', '15m'] as const;

export interface ParseOptions {
  /** 允许合并样本（symbol=ALL / bar=ALL） */
  allowAll?: boolean;
  fallback?: string;
}

/** 返回 null 表示参数非法（调用方回 400），而不是悄悄用默认值 */
export function parseSymbol(raw: string | null | undefined, opts: ParseOptions = {}): string | null {
  const value = (raw ?? '').trim().replace(/^okx:/i, '');
  if (!value) return opts.fallback ?? SYMBOL_IDS[0] ?? 'BTC-USDT-SWAP';
  if (opts.allowAll && value === 'ALL') return 'ALL';
  return SYMBOL_IDS.includes(value) ? value : null;
}

export function parseBar(
  raw: string | null | undefined,
  allowed: readonly string[],
  opts: ParseOptions = {},
): string | null {
  const value = (raw ?? '').trim();
  if (!value) return opts.fallback ?? allowed[0] ?? '5m';
  if (opts.allowAll && value === 'ALL') return 'ALL';
  return allowed.includes(value) ? value : null;
}

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
