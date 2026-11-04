import { initializeDatabase } from '@/db';

type RouteHandler = (request: Request) => Promise<Response>;
type ParamHandler = (request: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
let startup: Promise<void> | undefined;

// Static-preview transport: dispatch to the same active route handlers used
// by Next, rather than rewriting the application's fetch calls or business
// logic (or maintaining a second archived implementation).
export function startRuntime(): Promise<void> {
  if (!startup) {
    startup = (async () => {
      // The remote routes already tolerate database failures. Keep that
      // behavior when browser storage or WebAssembly is unavailable.
      await initializeDatabase().catch(error => {
        console.warn('Local persistence unavailable:', error);
      });
      const [data, backtest, signals, health, engine, okx] = await Promise.all([
        // Use the active routes, not the archived MCP snapshot.  Otherwise a
        // fix in src/app/api only affects Next while the static SPA silently
        // keeps executing the old implementation.
        import('@/app/api/data/route'),
        import('@/app/api/backtest/route'),
        import('@/app/api/signals/route'),
        import('@/app/api/health/route'),
        import('@/api/engine'),
        import('@/app/api/okx/[...path]/route'),
      ]);
      const routes: Record<string, Record<string, RouteHandler>> = {
        '/api/data': { GET: data.GET },
        '/api/backtest': { GET: backtest.GET },
        '/api/signals': { POST: signals.POST },
        '/api/health': { GET: health.GET },
        // 新增：入场确认引擎的扫描结果（不改远程任何既有 route）
        '/api/engine/scan': { GET: engine.GET },
      };
      // Catch-all rubik proxy (no CORS upstream). Vite dev has no Next server,
      // so the static build must dispatch it itself.
      const okxProxy = okx.GET as unknown as ParamHandler;
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== window.location.origin) return nativeFetch(input, init);
        if (url.pathname.startsWith('/api/okx/')) {
          // Next already serves this route (server-side fetch, no CORS). Only
          // when there is no backend — static/Vite preview — run it in-browser.
          // Intercepting unconditionally made the browser call OKX directly and
          // fail CORS.
          const native = await nativeFetch(input, init).catch(() => null);
          if (native && native.ok) return native;
          const path = url.pathname.slice('/api/okx/'.length).split('/').filter(Boolean).map(decodeURIComponent);
          try {
            return await okxProxy(request, { params: Promise.resolve({ path }) });
          } catch (error) {
            console.error('API /api/okx:', error);
            return Response.json({ code: '500', msg: 'proxy failed', data: [] }, { status: 500 });
          }
        }
        const route = routes[url.pathname];
        if (!route) return nativeFetch(input, init);
        const handler = route[request.method];
        if (!handler) {
          return Response.json({ error: 'Method not allowed' }, {
            status: 405,
            headers: { Allow: Object.keys(route).join(', ') },
          });
        }
        try {
          return await handler(request);
        } catch (error) {
          console.error(`API ${url.pathname}:`, error);
          return Response.json({ error: 'Internal server error' }, { status: 500 });
        }
      };
    })();
  }
  return startup;
}
