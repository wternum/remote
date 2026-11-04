export const dynamic = 'force-dynamic';

// Same-origin proxy for OKX public statistics that are not CORS-enabled.
// Strictly whitelisted: only read-only rubik taker volume / open interest.
const ALLOWED = new Set([
  'api/v5/rubik/stat/taker-volume-contract',
  'api/v5/rubik/stat/contracts/open-interest-history',
]);
const ALLOWED_PARAMS = new Set(['instId', 'period', 'unit', 'end', 'begin', 'limit']);
const CACHE = new Map<string, { at: number; status: number; body: string }>();
const TTL = 15_000;

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
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) {
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(key, { signal: ac.signal, cache: 'no-store' });
    const body = await res.text();
    if (res.ok) {
      CACHE.set(key, { at: Date.now(), status: res.status, body });
      if (CACHE.size > 300) {
        const oldest = CACHE.keys().next().value;
        if (oldest) CACHE.delete(oldest);
      }
    }
    return new Response(body, { status: res.status, headers: { 'content-type': 'application/json' } });
  } catch {
    return Response.json({ code: '502', msg: 'upstream unavailable', data: [] }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
