# 测试与只读诊断

测试用于确认代码规则、数据边界和界面交互，不证明信号预测力或交易收益。生产入口不引用测试行情。

## 1. TypeScript 套件

运行器 `scripts/run-ts-test.mjs` 用现有 esbuild 编译单个文件至忽略目录 `.verification/`，然后在Node中执行。

```sh
node scripts/run-ts-test.mjs tests/mw-story.test.ts
# 全部独立套件；任意失败即停止，不吞退出码
for t in tests/*.test.ts; do node scripts/run-ts-test.mjs "$t" || exit 1; done
# 现有package脚本仍只运行orderflow / annot-layout / audit-fixes
npm run test:quant
```

| 文件 | 验证范围 |
| --- | --- |
| `mw-story.test.ts` | 未到颈线不提前完成（旧代码先红后绿）、六段证据、突破/回踩镜像、触带/确认时点、实际目标触达、旧形态的新事件、重叠归并、真实覆盖、12根窗口、预览隔离、历史聚焦、v1→v2迁移 |
| `key-level-scenario.test.ts` | 使用统一story接口；单根/双根、弱量/一般量/放量、回踩收缩/深度、突破失败、外侧关键位失效、过期与去重 |
| `scenario-causality.test.ts` | 固定观察带；未来波动不回写旧事件；不能跨缺口确认；rubik覆盖不足/过量与报价币成交额单位 |
| `signal-logic.test.ts` | 原价格形态几何、成本/RR不阻止标注、原始证据因果性、局部成交与连续CVD区别、85%边界、中性/推进侧成交、两腿比较、缺口与首次普通回踩 |
| `signal-annotations.test.ts` | 合并后投影、方向/区带/标签/几何开关、真实与近似、可撤销形成中Δ、偏好保存、多个周期成交去重 |
| `realtime-stability.test.ts` | 盘中价格不改收盘结论；预览独立；闭合K与成交指纹；普通关键位成交附加；缺口范围可观测 |
| `realtime-transport.test.ts` | 统计代理不把取消转成CORS直连；JSON错误透传；HTML不是统计；WS先于历史连接；取消不进入5分钟上游失败冷却 |
| `smartmoney.test.ts` | FVG/区间/订单块/流动性的既有纯算法；无覆盖不伪造成交；SMC作为同一M/W的附加详情 |
| `flow-markers.test.ts` | 价格精度、代理白名单、真实努力/价格结果/爆量、画布密度 |
| `regression-fixes.test.ts` | 闭合K过滤、历史真实成交/回测回归 |
| `orderflow.test.ts` | 独立交易引擎的订单流判读、突破统计；与新版视觉M/W分开 |
| `annot-layout.test.ts` | 画布避让、轨道、事件标签和卡片位置 |
| `audit-fixes.test.ts` | 已有引擎配置/回测等修复的回归 |

`signal-fixtures.ts` 和 `mw-fixtures.ts` 是测试辅助数据，不是单独的测试入口。旧 `key-level-call.test.ts` 已迁入统一M/W套件，未保留已删除的竞争判读接口。

## 2. 浏览器回归

```sh
npx playwright install --with-deps chromium
npm run build
npm start  # 或已有平台受管生产服务；另一个终端运行测试
TEST_URL=http://127.0.0.1:3000/ node tests/signal-annotations.browser.mjs
```

套件顺序执行，不能并行抢公共OKX限频/渲染资源。

| 文件 | 范围 / 数据 |
| --- | --- |
| `signal-annotations.browser.mjs` | 确定性测试专用REST/WS，同时隔离同源统计代理；默认M/W、一形态一条、6段证据、时间线定位、7控制项、手绘保护、快速切换重连、预览与已确认结论隔离、收起侧栏仍更新、SMC不重复记录、刷新/切币/无成交周期/手机布局 |
| `symbols.browser.mjs` | BTC/ETH/SOL选择器、品牌图标、真实切换、焦点样式与浏览器错误；使用公共行情 |
| `library.browser.mjs` | 801脚本目录的分类/搜索/收藏/分页、原生指标添加、键盘/移动端与参考布局 |
| `drawing-toolbar.browser.mjs` | 原生工具/绘图/撤销/测量/擦除、菜单与缩放/响应式几何 |
| `runtime.browser.mjs` | 页面启动、浏览器本地API/PGlite、桌面/移动和脚本错误 |

原 `flowread.browser.mjs` 依赖已移除的交易侧栏，已清理，不再作为现行验收入口。

输出：`.verification/mw-browser-report.json`、`mw-desktop.png`、`mw-mobile.png`。截图使用模拟行情，只是UI证据，不是市场表现。

## 3. 真实市场只读诊断

```sh
# 合约 / 分钟周期 / 回看根数 / 可选真实成交
node scripts/run-ts-test.mjs scripts/inspect-signals.ts BTC-USDT-SWAP 5 600 flow
node scripts/run-ts-test.mjs scripts/inspect-signals.ts ALL ALL 600 flow
```

- `ALL ALL` 顺序检查BTC/ETH/SOL × 5m/15m；回看支持300/600/1200。
- 真实K线读取预算为回看+900根。必须有真实OKX响应，不用合成行情冒充实测。
- 输出每个M/W的阶段、关键位/颈线、最后活动、真实覆盖；记录缺口、画布密度、同ID重复、单次耗时与盘中价扰动不变量。
- 输入/完整输出保存在 `.verification/mw-live-{symbol}-{tf}-input.json` / `-analysis.json`，汇总 `mw-live-summary.json`。同一次输入才能做严格前后比较；不把两个实时样本的差异说成修复效果。
- 记录包含旧形态的新生命周期事件，不能把“记录数”误读为“新形态数量/准确率”。

## 4. 必需构建检查

```sh
npx next typegen
npm exec tsc -- --noEmit --pretty false
npm run build
```

平台环境另外运行受管 `build_and_start` 并检查 `/api/health`。`npm run build` 必须含prepare-runtime、Vite和Next三段；不能只构建Next后拿旧SPA做验收。
