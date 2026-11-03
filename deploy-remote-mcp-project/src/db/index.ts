import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema';

const isBrowser = typeof window !== 'undefined';
const asset = (name: string) => (typeof document !== 'undefined' ? new URL(`runtime/${name}`, document.baseURI).href : `/runtime/${name}`);
// 大体积二进制（wasm 8.7MB / data 6MB）在部分托管环境会被裁掉；本地缺失时回退到同版本 CDN
const PGLITE_VERSION = '0.5.14';
const cdn = (name: string) => `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${PGLITE_VERSION}/dist/${name}`;
const isWasm = (bytes: ArrayBuffer) => {
  const m = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return m[0] === 0x00 && m[1] === 0x61 && m[2] === 0x73 && m[3] === 0x6d;
};
async function fetchBinary(name: string, validate: (b: ArrayBuffer) => boolean): Promise<ArrayBuffer> {
  for (const url of [asset(name), cdn(name)]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      // SPA fallback 会把缺失文件回成 index.html，必须校验内容而不是状态码
      if (validate(bytes)) return bytes;
    } catch {
      /* try next */
    }
  }
  throw new Error(`${name} 无法从本地或 CDN 加载`);
}
const loadWasm = (name: string) => fetchBinary(name, isWasm).then(bytes => WebAssembly.compile(bytes));

let database: any;
let client: PGlite | undefined;
let initialization: Promise<void> | undefined;

function getDatabase() {
  if (!database && !isBrowser) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require('pg');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { drizzle } = require('drizzle-orm/node-postgres');
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl) {
        const p = new Pool({ connectionString: databaseUrl });
        database = drizzle(p, { schema });
      }
    } catch {
      // ignore
    }
  }
  return database;
}

export const db = new Proxy({} as PgliteDatabase<typeof schema>, {
  get(_target, property) {
    const targetDb = getDatabase();
    if (!targetDb) {
      throw new Error('Local database is not available');
    }
    const value = Reflect.get(targetDb, property);
    return typeof value === 'function' ? value.bind(targetDb) : value;
  },
});

export const pool = {
  end: () => {
    if (client) client.close();
  },
};

const migrations = `
  CREATE TABLE IF NOT EXISTS signals (
    id text PRIMARY KEY,
    symbol text NOT NULL,
    bar text NOT NULL DEFAULT '5m',
    bar_ts bigint NOT NULL,
    side text NOT NULL CHECK (side IN ('long', 'short')),
    pattern text NOT NULL,
    entry double precision NOT NULL,
    stop double precision NOT NULL,
    tp double precision NOT NULL,
    confidence integer NOT NULL DEFAULT 0,
    confluence integer NOT NULL DEFAULT 0,
    origin text NOT NULL DEFAULT 'backtest' CHECK (origin IN ('backtest', 'live')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('skipped', 'pending', 'active', 'won', 'lost', 'time')),
    entry_price double precision,
    exit_price double precision,
    exit_ts bigint,
    r_multiple double precision,
    pnl_pct double precision,
    holding_bars integer,
    exit_reason text,
    created_at timestamptz DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS signals_unique ON signals (symbol, bar, bar_ts, pattern, side);
  CREATE INDEX IF NOT EXISTS signals_lookup ON signals (symbol, bar_ts);
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id text PRIMARY KEY,
    symbol text NOT NULL,
    bar text NOT NULL,
    bar_count integer NOT NULL DEFAULT 0,
    from_ts bigint NOT NULL,
    to_ts bigint NOT NULL,
    live_source boolean NOT NULL DEFAULT false,
    flow_filter boolean NOT NULL DEFAULT true,
    signals integer NOT NULL DEFAULT 0,
    executed integer NOT NULL DEFAULT 0,
    win_rate double precision,
    total_r double precision,
    at timestamptz DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS runs_symbol ON backtest_runs (symbol, at);
`;

export function initializeDatabase(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }
  if (!initialization) {
    initialization = (async () => {
      const [runtime, pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
        import(/* @vite-ignore */ asset('pglite.js')) as Promise<typeof import('@electric-sql/pglite') & typeof import('drizzle-orm/pglite')>,
        loadWasm('pglite.wasm'),
        loadWasm('initdb.wasm'),
        // HTML fallback 以 '<' 开头；真正的 FS bundle 是 Emscripten 打包数据，且远大于 index.html
        fetchBinary('pglite.data', b => b.byteLength > 5_000_000 && new Uint8Array(b, 0, 1)[0] !== 0x3c).then(bytes => new Blob([bytes])),
      ]);
      const { PGlite, drizzle } = runtime;
      const options = { pgliteWasmModule, initdbWasmModule, fsBundle, relaxedDurability: true };
      // The static preview uses a session-local PostgreSQL instance. The
      // original Next.js server still uses its own DATABASE_URL connection.
      client = await PGlite.create('memory://pulsedesk-original', options);
      await client.exec(migrations);
      database = drizzle(client, { schema });
      window.addEventListener('pagehide', event => {
        if (!event.persisted) void client?.close();
      }, { once: true });
    })();
  }
  return initialization;
}
