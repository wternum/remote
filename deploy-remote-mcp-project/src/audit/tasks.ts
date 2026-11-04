// ─────────────────────────────────────────────────────────────
//  构造 / 策略 / 订单流缺陷修复任务卡
//  每一条都来自对源码的逐行核验或接口复现，不含推测性结论。
//  status 由修复进度驱动：pending → doing → done（verify 记录真实验证手段）。
// ─────────────────────────────────────────────────────────────

export type AuditStatus = 'pending' | 'doing' | 'done';
export type AuditArea = '构建' | '后端' | '策略' | '订单流' | '前端';

export interface AuditTask {
  id: string;
  title: string;
  area: AuditArea;
  severity: '严重' | '高' | '中';
  status: AuditStatus;
  /** 用户可观察到的现象 */
  symptom: string;
  /** 核验证据：文件 + 行为 */
  evidence: string[];
  /** 根因 */
  rootCause: string[];
  /** 修复方案 */
  fix: string[];
  /** 验证方式与结果 */
  verify: string[];
  files: string[];
}

export const AUDIT_TASKS: AuditTask[] = [
  {
    id: 'T1',
    title: '生产构建不重建前端 SPA，页面永远是旧包',
    area: '构建',
    severity: '严重',
    status: 'done',
    symptom:
      'npm run build 只执行 next build，而 / 返回的是 dist/index.html（Vite 产物）。改完任何 src 前端代码后重新 build，浏览器拿到的仍是上一次 vite build 的旧页面；README 的 dev/preview 脚本在 package.json 里根本不存在。',
    evidence: [
      'src/app/route.ts：优先读 process.cwd()/dist/index.html，其次 public/index.html。',
      'package.json scripts：dev=next dev、build=next build，无 preview；README.md 第 12/23/24 行却写 npm run dev -- --port 5173、npm run preview -- --port 4173。',
      'public/index.html 为 3.5MB 历史构建产物，dist 缺失时会静默回退到它。',
    ],
    rootCause: [
      '构建链路断裂：前端真正的构建器是 Vite（vite-plugin-singlefile），但 npm 生命周期里没有它。',
      '脚手架脚本与 README 两套口径，dev 起的是 Next 而不是 Vite。',
    ],
    fix: [
      'build = prepare-runtime + vite build + next build，保证 SPA 与 API 同源同时更新。',
      '补齐 dev（Vite）、dev:next、build:next、preview、test:quant 脚本，与 README 对齐。',
      'route.ts 在产物缺失时返回明确的构建提示，而不是伪装成“初始化中”。',
    ],
    verify: ['npm run build 依次出现 vite 与 next 两段构建日志', '改动前端后 dist/index.html 的 hash 变化', '/ 返回的 HTML 与最新构建一致'],
    files: ['package.json', 'src/app/route.ts'],
  },
  {
    id: 'T2',
    title: '服务端 PostgreSQL 没有任何表，信号持久化必然失败',
    area: '后端',
    severity: '严重',
    status: 'done',
    symptom:
      'POST /api/signals 直接 500；/api/backtest 每次都在控制台打 persist failed。回测与实时信号从未真正落库，health 却因 catch 而显示 ok，故障被掩盖。',
    evidence: [
      'psql app_db -c "\\dt" → Did not find any relations（0 张表）。',
      'src/db/index.ts: initializeDatabase() 在 typeof window === "undefined" 时直接 Promise.resolve()，服务端从不执行建表 SQL。',
      'migrations 常量只在浏览器 PGlite 分支 client.exec(migrations) 中执行。',
    ],
    rootCause: ['建表逻辑只写了浏览器端，服务端依赖外部手工 drizzle-kit push，启动流程里没有这一步。'],
    fix: [
      '服务端首次拿到连接时执行同一份幂等 migrations（CREATE TABLE IF NOT EXISTS），并缓存 Promise。',
      'health 在返回前等待 schema 就绪，让健康检查真正反映可用性；失败时显式报 fallback。',
    ],
    verify: ['启动后 \\dt 出现 signals / backtest_runs', 'POST /api/signals 返回 {"ok":true} 且可查询到行', '重复启动不报错（幂等）'],
    files: ['src/db/index.ts', 'src/app/api/health/route.ts'],
  },
  {
    id: 'T3',
    title: '两条策略路径口径不一致：趋势屏蔽开关只在一条路上被关闭',
    area: '策略',
    severity: '高',
    status: 'done',
    symptom:
      '同一个二次测试形态，/api/backtest 能出信号，而侧栏与 /api/engine/scan 没有；面板里的样本与回测对不上，门槛扫描、寻优结论建立在与实盘不同的信号集合上。',
    evidence: [
      'src/lib/engine.ts:33-37 paramsFor() 明确把 trendBlock 设为 50（关闭一刀切屏蔽，改由 trendExhaust 因子评分）。',
      'src/quant/scan.ts:386 runScan 的 pick() 只覆写 entryMode，没有覆写 trendBlock，仍用 DEFAULT_PARAMS.trendBlock = 1。',
      'remote/.../lib/engine.ts:223 trendOk() 在 trendBlock>=50 时才视为关闭。',
    ],
    rootCause: ['确认引擎的“取消硬屏蔽”改动只覆盖了 simulate/detectAt 覆盖层，runScan 这条新路径漏改。'],
    fix: ['runScan 统一使用与覆盖层相同的参数：trendBlock = 50，趋势是否可接由 trendExhaust 证据与概率门槛决定。'],
    verify: ['单测：构造一段强趋势中的二次测试，两条路径产出同一组信号索引', '面板与回测在相同标的上信号数一致'],
    files: ['src/quant/scan.ts'],
  },
  {
    id: 'T4',
    title: '用户门槛/入场模式在服务端回测不生效，replaceConfFilter 是死配置',
    area: '策略',
    severity: '高',
    status: 'done',
    symptom:
      '在引擎面板把门槛从 58% 调到 74%、或切成触价挂单，旧版页面的回测统计完全不变；replaceConfFilter 无论是在 UI 还是 localStorage 中切换，都没有任何行为差异。',
    evidence: [
      'src/quant/config.ts:70 只在 typeof window !== "undefined" 时从 localStorage 读取，Node 里 getConfig() 永远返回 DEFAULT_CONFIG。',
      'src/app/api/backtest/route.ts 在服务端调用 simulate()，因此 threshold/entryMode 永远是 0.58 + confirm。',
      'grep 全仓库 replaceConfFilter：仅 config.ts 内的定义与读取，引擎从未消费。',
    ],
    rootCause: [
      '配置只存在于浏览器 localStorage，服务端请求没有携带配置的通道。',
      'replaceConfFilter 写了类型与默认值，但 simulate 里没有对应分支。',
    ],
    fix: [
      'setConfig 同步写一份非敏感 cookie（threshold/entryMode/replaceConfFilter），backtest 路由解析并透传为显式参数。',
      'BacktestOptions 扩展 threshold/entryMode/replaceConfFilter 覆盖项，simulate 优先使用显式参数，其次才退回本地配置。',
      'replaceConfFilter=false 时恢复原 CONF_MIN 结构质量过滤，=true 时由概率门槛接管。',
    ],
    verify: ['单测：同一批 K 线在不同 threshold 下成交笔数不同', '带 cookie 请求 /api/backtest 的 overall.executed 随门槛变化', 'replaceConfFilter=false 时 conf<60 的形态被过滤'],
    files: ['src/quant/config.ts', 'src/lib/engine.ts', 'src/app/api/backtest/route.ts'],
  },
  {
    id: 'T5',
    title: '三个“仅实时”订单流因子在主界面恒为无数据',
    area: '订单流',
    severity: '高',
    status: 'done',
    symptom:
      '盘口失衡(bookImbalance)、大单主动方向(tapeBias)、确认K量能(thrustVolume) 在实时行情下依然全部记为 null，永远不贡献概率；面板的因子覆盖率与“实时订单流确认”名不副实。',
    evidence: [
      'src/vela/TradePanel.tsx:84 runScan(closed, engineBar, undefined, ...) —— live 参数写死 undefined。',
      'src/quant/scan.ts:153-157 只有传入 live 才会 set 这三个因子，否则保持 null。',
      'flow.ts 已聚合逐笔成交，却没有保留大单方向；盘口数据在侧栏完全没有获取。',
    ],
    rootCause: ['任务卡 2 只接上了 K 线级主动成交额，实时盘口/大单/量能这条 LiveFlow 通道没有数据源，调用方便留空。'],
    fix: [
      'flow.ts 增加滚动大单统计：最近 120s 逐笔按成交额 90 分位识别大单（严格大于分位值，避免大量相同小额时退化为全量 delta），输出 bigBias(-1..1) 与样本量。',
      '新增 useLiveFlow：浏览器直连 OKX books 公共接口定时取十档，计算盘口失衡，并与 flow 的大单偏向、确认K量比合成 LiveFlow。',
      'TradePanel 把 LiveFlow 传入 runScan，让三个因子在最新信号上真正参与评分。',
    ],
    verify: ['单测：构造大单买压>卖压时 bigBias>0', '最新候选的 evidence 中这三个因子不再是 null', '无网络时回落为 null，不影响其它因子'],
    files: ['src/quant/flow.ts', 'src/vela/useLiveFlow.ts', 'src/vela/TradePanel.tsx'],
  },
  {
    id: 'T6',
    title: '订单流断线后缺口永不回补，delta 静默退回形态近似',
    area: '订单流',
    severity: '中',
    status: 'done',
    symptom:
      '网络抖动、电脑休眠或 WS 被 OKX 断开后，期间的 K 线没有真实主动成交，hasRealFlow 覆盖不足 → 这些根永久使用 K 线近似，UI 仍显示“实时已连接”，用户无法察觉证据已降级。',
    evidence: [
      'src/quant/flow.ts:336-342 只有 !snap.tape.bootstrapped 时才执行 bootstrapTape；一旦为 true，后续 syncFlow 不再回补。',
      'openTape 的 onclose 仅重连，不标记缺口，也不触发回补。',
    ],
    rootCause: ['回补是一次性动作，没有“断线/滞后 → 需要修复性回补”的状态。'],
    fix: [
      'WS 关闭时给共享 tape 打 needsRepair 标记，并记录中断时刻。',
      'syncFlow 增量阶段检测标记或快照滞后（最新聚合 K 线落后当前时间超过 2 个周期），执行限量回补（最近 2 根、页数封顶），完成后清除标记。',
    ],
    verify: ['单测/调试：人为中断后再次 syncFlow 会发起回补并清除标记', '断线窗口内的 K 线覆盖率恢复，flowSource 不再停留 approx'],
    files: ['src/quant/flow.ts'],
  },
  {
    id: 'T7',
    title: '保本出场被统计成“超时”，退出原因分布失真',
    area: '策略',
    severity: '中',
    status: 'done',
    symptom:
      '选择「1R 保本」或「1R 减半 + 保本」后，被保本止损打掉的单子全部计入超时(time)，tp/sl/time 三段比例与平均持仓解读被污染；类型上 exitReason 也不允许 be，运行值与类型定义不一致。',
    evidence: [
      'src/quant/scan.ts:477/513 会产生 why="be"。',
      'src/quant/stats.ts:97-99 只识别 tp/sl，其余一律 time++。',
      'src/lib/types.ts:144 exitReason 类型只有 "tp" | "sl" | "time"。',
    ],
    rootCause: ['新增出场方案时补了模拟，没有同步补统计口径与类型。'],
    fix: [
      'Summary 增加 beRate，统计按 Outcome.why 把保本单独分桶，timeRate 只统计真正超时。',
      '保持 remote 原始 TradedSignal.exitReason 的 tp/sl/time 契约（直接加 "be" 会让 remote summarize 类型不兼容），覆盖层在记录上附加 exitWhy 保留真实退出原因。',
    ],
    verify: ['单测：构造一笔保本单，timeRate 不再增加，beRate=100%', 'tsc 类型检查通过'],
    files: ['src/quant/stats.ts', 'src/lib/types.ts'],
  },
  {
    id: 'T8',
    title: '引擎面板统计与当前入场模式不一致，“跟随页面”在 Vela 下失效',
    area: '前端',
    severity: '中',
    status: 'done',
    symptom:
      '切到「触价挂单」后，KPI 变了，但校准曲线、门槛扫描、因子归因、walk-forward、分币种、净值曲线仍全部基于 confirm 样本；点「跟随页面」在 Vela 主界面永远得到 BTC/5m。',
    evidence: [
      'src/components/confirm/useEngine.ts:166-203 stats 中 calib/sweep/attribution/killers/grades/bySymbol/equity*/walkForward 全部写死 confirmPool。',
      'readActiveMarket() 只查询旧版 header 的 Tailwind class，Vela 外壳没有该 DOM → 返回默认 BTC-USDT-SWAP/5m。',
    ],
    rootCause: ['面板统计口径没有跟随 entryMode；市场读取只适配了旧版页面，未适配 Vela 工作区。'],
    fix: [
      '引入 activePool（按 cfg.entryMode 选择），所有诊断统计统一改用 activePool，optimize 仍保留双池对照。',
      'readActiveMarket 优先读取 window.__velaWs.chart.market（Vela 周期代号 → 5m/15m），无工作区时再回退旧版 DOM。',
    ],
    verify: ['activePool 统一接管 calib/sweep/attribution/killers/grades/bySymbol/equity/walkForward（代码路径审查）', 'readActiveMarket 优先读取 __velaWs.chart.market，tsc 类型检查通过'],
    files: ['src/components/confirm/useEngine.ts'],
  },
  {
    id: 'T9',
    title: '回归验证：把本次修复固化成自动化测试',
    area: '构建',
    severity: '中',
    status: 'done',
    symptom: '上述问题此前没有任何测试覆盖，因此能在多个版本里存活；修复后也可能被后续改动重新引入。',
    evidence: ['tests/ 只有 orderflow 与 annot-layout 两个 TS 单测，配置、统计口径、策略参数一致性均无覆盖。'],
    rootCause: ['缺少针对“配置是否生效”“两条路径是否一致”“统计是否准确”的断言。'],
    fix: [
      '新增 tests/audit-fixes.test.ts：趋势屏蔽口径一致、门槛覆盖生效、replaceConfFilter 生效、保本单分桶、大单偏向计算、缺失因子不加分。',
      'npm run test:quant 串起全部 TS 单测，随后跑 typegen / tsc / build。',
    ],
    verify: [
      'npm run test:quant：orderflow / annot-layout / audit-fixes 三组全部通过（8 组新增断言）',
      'npx next typegen、tsc --noEmit、npm run build（prepare-runtime + vite + next）全部通过',
    ],
    files: ['tests/audit-fixes.test.ts', 'package.json'],
  },
  {
    id: 'T10',
    title: '触价挂单被“不存在的确认K”评分，A/B 对照形同虚设',
    area: '策略',
    severity: '高',
    status: 'done',
    symptom:
      '实测同一批 8640 根 5m K 线：touch（触价即成交）池 55 个候选的概率全部落在 0.087–0.265，没有任何一笔能通过最低的 42% 门槛；confirm 池候选概率约 0.52。也就是说“原逻辑”分支在确认引擎里永远不会执行，面板里的 A/B 对照与 touch 寻优组合全是空样本。',
    evidence: [
      '探针输出：touch records=55，rejectReason 全部为 confirm（概率不足），proba 排序抽样 [0.087,0.123,0.152,0.172,0.189,0.218,0.265]。',
      'src/quant/model.ts 设计原则：缺数据时该因子贡献为 0，不做臆测加成。',
      'src/quant/scan.ts collectEvidence：wickReject = 拒绝影线 + 确认K收盘位置；testDelta/thrustVolume 也取自 read.confirm（即信号K本身）。',
    ],
    rootCause: [
      '触价单在触及关键位的那一根就成交，之后并不存在拒绝/确认K；但证据计算仍把该根当作“确认K”评分，等于用一个尚未发生的确认来惩罚触价入场，方向系统性偏负。',
    ],
    fix: [
      'collectEvidence 按 sig.fill 区分入场方式：touch 时 wickReject 只保留拒绝影线项，thrustVolume 与 testDelta 记为 null（没有确认K就不臆测）。',
      'confirm 路径保持原公式不变，避免影响既有概率口径。',
    ],
    verify: ['单测：同一数据上 touch 池重新出现可通过 42% 门槛的候选，confirm 池候选数不变', 'confirm 模式概率公式未改动'],
    files: ['src/quant/scan.ts'],
  },
];

export const AUDIT_META = {
  title: '构造 / 策略 / 订单流缺陷修复任务卡',
  scope: 'PULSEDESK（Vite SPA + Next API + 双顶双底确认引擎）',
  method: '逐行阅读 src 与 remote 原始引擎，配合接口复现与 SQL 检查；每项均给出文件级证据。',
  principle: '不改动 remote/ 原始项目文件，所有修复落在 src 覆盖层与新增模块；先修正确性，再做一致性，最后补回归测试。',
};

export const statusWeight = (s: AuditStatus) => (s === 'done' ? 1 : s === 'doing' ? 0.5 : 0);
