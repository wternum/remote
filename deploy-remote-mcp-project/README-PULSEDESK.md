# PULSEDESK Local Workspace

The existing Chinese-language Vela/OKX trading workspace has been imported from the user-provided MCP endpoint. The original interface, indicator library, drawing tools, trading sidebar, and legacy page are preserved.

## Run Locally

Requires Node.js 20.19+ (or 22.12+) and npm.

```sh
npm install   # 仓库不含 package-lock.json，npm ci 不可用
node scripts/prepare-runtime.mjs
npm run dev -- --host 0.0.0.0 --port 5173
```

Open `http://localhost:5173/`. The original legacy interface is available at `http://localhost:5173/#legacy`.

No API keys or database credentials are required. The application uses the public OKX REST/WebSocket APIs and a session-local PostgreSQL database through PGlite. Live market data requires network access to OKX. Database runtime files are served locally from `public/runtime/`.

## Build And Verify

```sh
npx tsc --noEmit
npm run build
npm run preview -- --host 0.0.0.0 --port 4173
npx playwright install --with-deps chromium
node tests/runtime.browser.mjs
node tests/symbols.browser.mjs
node tests/library.browser.mjs
node tests/drawing-toolbar.browser.mjs
```

Set `TEST_URL=http://127.0.0.1:4173/` to run browser checks against the production preview.
Run the browser suites sequentially because they share a rate-limited public market feed.

## Imported Files

- Active application: `src/App.tsx`.
- Original byte-verified snapshot: `remote-project/merge-project-ui-layouts/`.
- Original nested project and references: `remote/` and `reference/`.
- Import task record: `TASKS.md`.
- Import report, read responses, and SHA-256 metadata: `.mcp-import/`.
- Browser screenshots and verification results: `.verification/`.

All 230 original source/reference/test files (8,124,819 bytes) match the remote file versions. Generated `node_modules`, `dist`, and Git history are excluded from source import. The original package manifest and Vite configuration are preserved in the snapshot; active build dependencies received security patch updates.

The original 34 browser regression checks pass. Additional desktop/mobile/database checks pass against both the development server and production preview. The local browser runtime and a deferred nested-root cleanup are the only compatibility adjustments beyond dependency security patches; see `TASKS.md`.

MCP connection helpers in `scripts/` read `MCP_URL_BASE64` from the environment or the ignored local connection file. The endpoint is not embedded in the web application.
## Order Flow Read (5m double top / bottom)

The trade sidebar now contains an **订单流判读** card driven by real OKX taker flow (recent trades bootstrap + live `trades` WebSocket, aggregated per bar and validated against candle quote volume):

- Double top → probability of decline; double bottom → probability of rise (evidence model with real delta, CVD extreme divergence, sweep-trap, confirm-bar delta, open-interest factors).
- 诱多 / 诱空 detection: sweep beyond the prior high/low that closes back inside while aggressive flow sits on the reversal side (or chasing volume is absorbed).
- Breakout → pullback follow-through: breakout bar volume/delta/extension, pullback volume and delta, retest hold/fail, chart-history rates for "chase the break" vs "wait for the retest", with a retest zone painted on the chart.

Tests: `node scripts/run-ts-test.mjs tests/orderflow.test.ts` and `node tests/flowread.browser.mjs`. See `TASKS.md` (任务卡 2) for rules, data sources, and limits.
