# MCP Project Import

Source: user-provided MCP endpoint, connected using Streamable HTTP.
Remote project: `merge-project-ui-layouts`.
Visible task card: `0bc8c5a3-9bbb-4f1d-9e09-b5932e5d7435`.

| ID | Outcome | Status |
| --- | --- | --- |
| inspect | Read project instructions and complete source manifest | Complete |
| import | Read all project files locally and verify original hashes | Complete: 230/230 |
| configure | Restore the existing application and install dependencies | Complete |
| verify | Start the application, build, and run browser checks | Complete |

## Preservation

- Original files are preserved in `remote-project/merge-project-ui-layouts/`.
- Read responses and import metadata are stored in `.mcp-import/`.
- The original project's `TASKS.md` is preserved without treating its historical test results as current verification.
- Generated dependencies, build output, and Git history are not source files and are not imported.

## Import Verification

- 230 original files, 8,124,819 bytes, all matching the remote SHA-256 version.
- 218 files reconstructed using the MCP `read_files` tool.
- 12 files exceeded the reader's single-line limit and were recovered using a read-only, compressed export and command-output reads. All recovered bytes match their reader-provided hashes.
- Dependencies installed from the original manifest; vulnerable Vite/esbuild versions patched using npm. The original package manifest and Vite configuration remain archived unchanged.

## Environment Verification

- `node scripts/prepare-runtime.mjs`: generated the local browser database bundle and copied all PostgreSQL WebAssembly resources.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed with Vite 7.3.7.
- `npm audit`: zero known vulnerabilities after patching.

## Final Runtime Verification

- Development server: `http://localhost:5173/`, HTTP 200, left running.
- Production preview: `http://localhost:4173/`, HTTP 200, left running.
- `tests/symbols.browser.mjs`: 4 checks passed.
- `tests/library.browser.mjs`: 15 checks passed.
- `tests/drawing-toolbar.browser.mjs`: 15 checks passed.
- `tests/runtime.browser.mjs`: desktop, mobile, local PostgreSQL API, and browser error checks passed against both servers.
- Original source snapshot rechecked: 230 of 230 SHA-256 versions match.
- Browser checks were run sequentially to avoid shared public-feed rate limits and memory pressure.

## Local Compatibility Fixes

- Generated `public/runtime/` with the installed PGlite version; omitted unused Node-only filesystem imports from the browser bundle.
- Deferred the trading panel's nested React root cleanup in `src/vela/registerTradePanel.tsx` to avoid a development StrictMode commit race.
- Preserved the untouched original file versions in `remote-project/merge-project-ui-layouts/`.
- Kept the MCP connection address and session metadata in ignored `.mcp-import/` files, not in shipped frontend code.
---

# 任务卡 2：5m 双顶/双底 · 订单流确认 · 诱多/诱空 · 突破回调跟随

远端任务卡：`5b9f1695-474e-4b86-9bd7-8787e92ade15`

| ID | 任务 | 状态 |
| --- | --- | --- |
| audit | 梳理现有双顶/双底检测与订单流证据代码，定位判断薄弱点 | 完成 |
| research | 调研订单流确认双顶双底、诱多诱空、突破回调跟随的方法并形成规则 | 完成 |
| orderflow | 实现 5m 订单流证据层：二次测试的 Delta/CVD 背离、吸收、衰竭、扫损判定 | 完成 |
| trap | 实现诱多/诱空与突破-回调跟随判定及涨跌概率评分 | 完成 |
| ui | 交易侧栏与图表标注展示概率、陷阱与回调跟随结论 | 完成 |
| verify | 单元测试、类型检查、构建与浏览器验收 | 完成 |

## 审计结论（改造前的薄弱点）

- 交易侧栏的扫描没有接入任何实时订单流：`runScan(..., live = undefined)`，盘口/大单因子恒为空。
- 全部“主动买卖差”来自 K 线形态近似 `v × (2·收盘位置 − 1)`，与拒绝影线因子高度重复，不是真实成交方向。
- 没有显式的诱多/诱空判定，也没有“突破后回调能否跟随”的判读。

## 实现

- `src/quant/flow.ts`：真实订单流数据层。浏览器内用 OKX `/market/history-trades` 回补（5m 默认最近 8 根完整 K 线）+ `trades` WebSocket 实时聚合，按 K 线汇总主动买入/卖出成交额（USDT）；聚合额 ≥ 85% K 线成交量才算完整覆盖（实测完整 K 线聚合额与 `volCcyQuote` 完全一致）。`rubik/stat/taker-volume-contract` 与持仓量接口无 CORS，仅在 Node 或配置 `localStorage['pulsedesk.okx-proxy']` 代理时使用。
- `src/quant/context.ts`：扫描上下文，真实 delta 优先、近似兜底，记录每根来源与覆盖率。
- `src/quant/orderflow.ts`：
  - `readSecondTest`：两腿主动差对比、CVD 极值背离、二次测试量能、扫损深度与扫损期间主动方向、关键位吸收、确认K主动方向、第二腿持仓变化 → 诱多/诱空评分与理由。
  - `readBreakout`：突破K量能/主动差/离位、回调深度/量比/主动差、回踩关键位是否守住或失败 → `不追 / 等回踩 / 可跟随 / 守住但兑现率低 / 暂不跟随 / 假突破`，概率 = 先验 + 本图历史同类回踩兑现率。
  - `scanBreakouts`：对本图全部收盘突破的摆动关键位统计「突破即追」与「等回踩」的 +1.5 ATR 兑现率。
- `src/quant/model.ts`：新增因子 `cvdDiverge`、`sweepTrap`、`testDelta`、`oiTrap`（追加在末尾，原校准/寻优/面板逻辑按 FACTORS 泛化，无需改动）。
- `src/vela/FlowRead.tsx` + `src/vela/useFlow.ts`：交易侧栏「订单流判读」卡，按场景展示：双顶 → 下跌概率；双底 → 上涨概率；诱多/诱空与理由；突破 → 回调跟随结论、回踩区、本图历史兑现率；接近关键位 → 实时主动差提示。图上自动标注诱多/诱空箭头与回踩区。
- 默认周期改为 5m（已保存的工作区状态优先）。

## 验证

- `node scripts/run-ts-test.mjs tests/orderflow.test.ts`：6 组合成场景通过（双顶扫高收回+主动卖出→诱多、镜像双底→诱空、真突破缩量回踩守住→可跟随、放量跌回→假突破、放量离位→不追、历史突破统计）。
- `npx tsc --noEmit`、`npm run build` 通过。
- `tests/flowread.browser.mjs`（生产预览）：侧栏打开、OKX 逐笔成交回补并显示覆盖根数、判读视图渲染、图上标注、零浏览器错误。
- 回归：`tests/runtime.browser.mjs`、`tests/symbols.browser.mjs` 通过。

## 已知边界

- 真实主动成交只覆盖页面打开后 + 回补的最近约 8 根（5m）；更早 K 线仍用形态近似，卡片与信号列表均标注来源（`真实订单流` / 近似）。
- 持仓量（OI）因子需要 rubik 代理，浏览器直连时记为无数据，不参与评分。
- 概率中的“本图历史”为当前图表加载 K 线上的样本统计，不是跨币种校准结果；完整校准仍在「引擎详情」。
