import { initializeDatabase } from '@/db';

type RouteHandler = (request: Request) => Promise<Response>;
let startup: Promise<void> | undefined;

// Static-preview transport: dispatch to the original route handlers, rather
// than rewriting the application's fetch calls or business logic.
export function startRuntime(): Promise<void> {
  if (!startup) {
    startup = (async () => {
      // The remote routes already tolerate database failures. Keep that
      // behavior when browser storage or WebAssembly is unavailable.
      await initializeDatabase().catch(error => {
        console.warn('Local persistence unavailable:', error);
      });
      const [data, backtest, signals, health, engine] = await Promise.all([
        import('../../remote/setup-mcp-project-locally/src/app/api/data/route'),
        import('../../remote/setup-mcp-project-locally/src/app/api/backtest/route'),
        import('../../remote/setup-mcp-project-locally/src/app/api/signals/route'),
        import('../../remote/setup-mcp-project-locally/src/app/api/health/route'),
        import('@/api/engine'),
      ]);
      const routes: Record<string, Record<string, RouteHandler>> = {
        '/api/data': { GET: data.GET },
        '/api/backtest': { GET: backtest.GET },
        '/api/signals': { POST: signals.POST },
        '/api/health': { GET: health.GET },
        // 新增：入场确认引擎的扫描结果（不改远程任何既有 route）
        '/api/engine/scan': { GET: engine.GET },
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== window.location.origin) return nativeFetch(input, init);
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
