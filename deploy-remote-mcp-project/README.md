# PULSEDESK Local Workspace

The Chinese-language Vela/OKX workspace preserves its original chart, indicator library, drawing tools and `#legacy` page. The old trading sidebar has been removed; the current sidebar is **信号标注**, which displays price-structure annotations and evidence-qualified OKX taker-trade observations. See [`src/vela/signals/README.md`](src/vela/signals/README.md) for the exact rules, provenance, limitations and primary research references. Visual annotations are not trade recommendations or calibrated win probabilities.

## Run Locally

Requires Node.js 20.19+ (or 22.12+) and npm.

```sh
npm ci
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
## Current signal annotations

The sidebar has eight selectable types: double top/bottom, support/resistance, price-breakout retest, tentative high/low sweeps, **real** taker CVD divergence, and real taker buy/sell imbalance. Its master switch and per-type switches control only annotations; no orders are placed. Without continuous actual trades, it does not invent CVD. Optional OHLC-derived observations are displayed as `≈` price proxies and must not be mistaken for actual order flow. The chart's original trade/backtest engine is separate from the annotation detector.

Verification: `node scripts/run-ts-test.mjs tests/signal-logic.test.ts`, `node scripts/run-ts-test.mjs tests/signal-annotations.test.ts` and `TEST_URL=http://127.0.0.1:3000/ node tests/signal-annotations.browser.mjs` after starting the production preview. Read `src/vela/signals/README.md` for the decision rules and referenced papers. `TASKS.md` preserves the **historical** trading-sidebar task record; it does not describe current sidebar behavior.
