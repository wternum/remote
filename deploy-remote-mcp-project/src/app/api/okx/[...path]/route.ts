export const dynamic = 'force-dynamic';

// Same-origin proxy for OKX public statistics that are not CORS-enabled.
// Strictly whitelisted: only read-only rubik taker volume / open interest.
const ALLOWED = new Set([
  'api/v5/rubik/stat/taker-volume-contract',
  'api/v5/rubik/stat/contracts/open-interest-history',
]);
const ALLOWED_PARAMS = new Set(['instId', 'period', 'unit', 'end', 'begin', 'limit']);
const CACHE = new Map<string, { at: number; status: number; body: string }>();
const INFLIGHT = new Map<string, Promise<{ status: number; body: string }>>();
const TTL = 15_000;

// 滑动窗口限流（仅限制未命中缓存的上游回源请求，防止构造变化参数刷爆出口配额）
const RATE_WINDOW_MS = 10_000;
const PER_CLIENT_LIMIT = 60;
const GLOBAL_LIMIT = 120;
const clientHits = new Map<string, number[]>();
let globalHits: number[] = [];

/**
 * 客户端标识只在部署于可信反向代理之后（PULSEDESK_TRUST_PROXY_HEADERS=1）才读取转发头。
 * 否则任何人都能伪造 x-forwarded-for 换一个桶绕过单客户端限额；此时返回 null，
 * 仅由全局限额保护上游配额（Route Handler 拿不到 socket 地址）。
 */
export function clientKeyOf(req: Request): string | null {
  if (process.env.PULSEDESK_TRUST_PROXY_HEADERS !== '1') return null;
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const real = req.headers.get('x-real-ip')?.trim();
  return fwd || real || null;
}

function allowUpstream(clientKey: string | null, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  globalHits = globalHits.filter(t => t > cutoff);
  if (globalHits.length >= GLOBAL_LIMIT) return false;
  if (clientKey == null) {
    globalHits.push(now);
    return true;
  }
  const list = (clientHits.get(clientKey) ?? []).filter(t => t > cutoff);
  if (list.length >= PER_CLIENT_LIMIT) {
    clientHits.set(clientKey, list);
    return false;
  }
  list.push(now);
  clientHits.set(clientKey, list);
  globalHits.push(now);
  if (clientHits.size > 500) {
    for (const [k, ts] of clientHits) {
      const fresh = ts.filter(t => t > cutoff);
      if (!fresh.length) clientHits.delete(k);
      else clientHits.set(k, fresh);
    }
  }
  return true;
}

function isCacheableOkxPayload(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; data?: unknown };
    return parsed?.code === '0' && Array.isArray(parsed.data);
  } catch {
    return false;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = (path ?? []).join('/');
  if (!ALLOWED.has(target)) return Response.json({ code: '404', msg: 'not allowed', data: [] }, { status: 404 });
  const incoming = new URL(req.url);
  const url = new URL(`https://www.okx.com/${target}`);
  for (const [k, v] of incoming.searchParams) {
    if (ALLOWED_PARAMS.has(k) && /^[A-Za-z0-9-]{1,40}$/.test(v)) url.searchParams.set(k, v);
  }
  const key = url.toString();
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && now - hit.at < TTL) {
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
  }

  let pending = INFLIGHT.get(key);
  if (!pending) {
    if (!allowUpstream(clientKeyOf(req), now)) {
      return Response.json(
        { code: '429', msg: 'proxy rate limit exceeded', data: [] },
        { status: 429, headers: { 'retry-after': '5' } },
      );
    }
    pending = (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 6000);
      try {
        const res = await fetch(key, { signal: ac.signal, cache: 'no-store' });
        const body = await res.text();
        if (isCacheableOkxPayload(res.status, body)) {
          CACHE.set(key, { at: Date.now(), status: res.status, body });
          if (CACHE.size > 300) {
            const oldest = CACHE.keys().next().value;
            if (oldest) CACHE.delete(oldest);
          }
        }
        return { status: res.status, body };
      } finally {
        clearTimeout(timer);
      }
    })();
    INFLIGHT.set(key, pending);
    // finally() 返回的派生 Promise 在上游失败时同样 reject；必须吞掉，
    // 否则主流程已回 502，这里仍会留下一个未处理的拒绝。
    pending
      .finally(() => {
        if (INFLIGHT.get(key) === pending) INFLIGHT.delete(key);
      })
      .catch(() => {});
  }

  try {
    const out = await pending;
    return new Response(out.body, { status: out.status, headers: { 'content-type': 'application/json' } });
  } catch {
    return Response.json({ code: '502', msg: 'upstream unavailable', data: [] }, { status: 502 });
  }
}
