import { fetchStatsProxy } from './statsProxy';

type RouteHandler = (request: Request) => Promise<Response>;
type RouteTable = Record<string, Record<string, RouteHandler>>;

let startup: Promise<void> | undefined;
let routes: Promise<RouteTable> | undefined;

const RUNTIME_FLAG = '__pulsedeskRuntimeInstalled';

/**
 * 只有这些路径需要浏览器内分发；其余同源请求（页面、/runtime/*.wasm、vite 资源、
 * 第三方代理之外的路径）必须直接走原生 fetch。否则一次路由模块加载失败就会把
 * 静态资源也变成 503。
 */
const ROUTE_PATHS = new Set([
  '/api/data',
  '/api/backtest',
  '/api/signals',
  '/api/health',
  '/api/engine/scan',
]);

function loadRoutes(): Promise<RouteTable> {
  routes ??= Promise.all([
    // Use the active routes, not the archived MCP snapshot.  Otherwise a
    // fix in src/app/api only affects Next while the static SPA silently
    // keeps executing the old implementation.
    import('@/app/api/data/route'),
    import('@/app/api/backtest/route'),
    import('@/app/api/signals/route'),
    import('@/app/api/health/route'),
    import('@/api/engine'),
  ])
    .then(([data, backtest, signals, health, engine]): RouteTable => ({
      '/api/data': { GET: data.GET },
      '/api/backtest': { GET: backtest.GET },
      '/api/signals': { POST: signals.POST },
      '/api/health': { GET: health.GET },
      // 新增：入场确认引擎的扫描结果（不改远程任何既有 route）
      '/api/engine/scan': { GET: engine.GET },
    }))
    .catch((error) => {
      // 失败不要永久缓存 rejected Promise，下一次请求还能重试
      routes = undefined;
      throw error;
    });
  return routes;
}

/**
 * 同步安装 fetch 拦截器。
 *
 * 旧实现要等 `initializeDatabase()` 把 PGlite（pglite.wasm 9.1MB + pglite.data
 * 6.2MB）下载并编译完成后才替换 window.fetch，于是首屏到就绪之间的 `/api/*`
 * 会落到 Next 服务端（服务端 PostgreSQL + 服务端 cookie 配置），之后又切到
 * 浏览器内运行时（内存 PGlite + localStorage 配置）——同一接口数据来源不确定。
 *
 * 现在：拦截器在 runtime 启动时立刻生效；路由模块与数据库都改为「首次真正用到
 * 时才加载」，纯看图场景不再下载 15.6MB WASM。
 */
/** 不消费 body 地解析 fetch 目标；无法解析时交还原生 fetch 自己报错。 */
export function requestUrl(input: RequestInfo | URL, base = window.location.href): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : String(input), base);
  } catch {
    return null;
  }
}

function installFetchInterceptor() {
  const w = window as unknown as Record<string, unknown>;
  if (w[RUNTIME_FLAG]) return;
  w[RUNTIME_FLAG] = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    // 先只解析 URL：对放行的请求构造 Request 会读掉 Request 对象的 body，
    // 之后 nativeFetch(input, init) 必然失败（"Request object that has already been used"）。
    const url = requestUrl(input);
    if (!url || url.origin !== window.location.origin) return nativeFetch(input, init);
    const stats = url.pathname.startsWith('/api/okx/');
    if (!stats && !ROUTE_PATHS.has(url.pathname)) return nativeFetch(input, init);
    const request = new Request(input, init);
    if (stats) return fetchStatsProxy(request, nativeFetch);

    let table: RouteTable;
    try {
      table = await loadRoutes();
    } catch (error) {
      console.error('API runtime unavailable:', error);
      return Response.json({ error: 'API runtime unavailable' }, { status: 503 });
    }
    const route = table[url.pathname];
    if (!route) return nativeFetch(request);
    const handler = route[request.method];
    if (!handler) {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: Object.keys(route).join(', ') } },
      );
    }
    try {
      return await handler(request);
    } catch (error) {
      console.error(`API ${url.pathname}:`, error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}

export function startRuntime(): Promise<void> {
  if (!startup) {
    // 数据库不再在启动时预热：需要落库的 route 自己 awaited initializeDatabase()。
    installFetchInterceptor();
    startup = Promise.resolve();
  }
  return startup;
}
