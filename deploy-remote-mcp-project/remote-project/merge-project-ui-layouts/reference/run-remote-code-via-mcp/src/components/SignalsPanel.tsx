import { useMemo, useState } from "react";
import { useStore, store, type TargetMode } from "../lib/store";
import { PATTERN_META, MIN_HISTORY_SAMPLES } from "../lib/engine";
import { fmtDateTime, fmtNotional, fmtPrice, fmtR } from "../lib/format";
import { symbolOf, type LiveSignal, type TradedSignal, type PatternId } from "../lib/types";

type Row = (LiveSignal | TradedSignal) & { liveRow?: boolean };

const TARGETS: { id: TargetMode; label: string }[] = [
  { id: "neck", label: "颈线目标" },
  { id: "r15", label: "固定 1.5R" },
  { id: "r10", label: "固定 1.0R" },
];

const STATUS: Record<string, { text: string; cls: string }> = {
  pending: { text: "待下根开盘", cls: "st-amber" },
  active: { text: "跟踪中", cls: "st-cyan" },
  won: { text: "止盈", cls: "st-green" },
  lost: { text: "止损", cls: "st-red" },
  time: { text: "超时", cls: "st-gray" },
  skipped: { text: "门槛外", cls: "st-gray" },
  done: { text: "已结算", cls: "st-gray" },
};

const gradeOf = (conf: number) =>
  conf >= 78 ? "A" : conf >= 68 ? "B" : conf >= 58 ? "C" : "D";

function gradColor(conf: number) {
  return conf >= 72 ? "#0ecb81" : conf >= 58 ? "#8fd94b" : conf >= 46 ? "#f0b90b" : "#f6465d";
}



function SignalCard({ row, base }: { row: Row; base: string }) {
  const meta = PATTERN_META[row.pattern as PatternId];
  const long = row.side === "long";
  const st = STATUS[(row as LiveSignal).status] ?? STATUS.done;
  const conf = Math.max(0, Math.min(100, row.conf));
  const rr = Math.abs((row.tp - row.entry) / (row.entry - row.stop || 1));
  return (
    <article className={"tr-card " + (long ? "tr-card-long" : "tr-card-short")}>
      <div className="tr-card-top">
        <span className={"tr-side " + (long ? "tr-side-long" : "tr-side-short")}>
          {long ? "多" : "空"}
        </span>
        <span className="tr-card-name">{meta?.short} {meta?.label ?? row.pattern}</span>
        <span className="tr-card-time">{fmtDateTime(row.ts)}</span>
        <span className="tr-grade" style={{ color: gradColor(conf) }}>
          {conf}% <b>{gradeOf(conf)}</b>
        </span>
      </div>

      <div className="tr-conf">
        <div className="tr-conf-fill" style={{ width: conf + "%", background: gradColor(conf) }} />
      </div>

      <div className="tr-card-px mono">
        <span><i>E</i>{fmtPrice((row as LiveSignal).entryPrice ?? row.entry, base)}</span>
        <span className="tr-sell"><i>SL</i>{fmtPrice(row.stop, base)}</span>
        <span className="tr-buy"><i>TP</i>{fmtPrice(row.tp, base)}</span>
        <span className="tr-rr">1:{rr.toFixed(1)}</span>
        {row.r != null ? (
          <b className={row.r >= 0 ? "tr-up" : "tr-down"}>{fmtR(row.r)}</b>
        ) : (
          <b className="tr-pending">{st.text}</b>
        )}
      </div>

      {row.tags && row.tags.length > 0 && (
        <div className="tr-tags">
          {row.tags.slice(0, 4).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      )}
    </article>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="tr-blank">等待成交数据…（历史段为 K 线估算）</div>;
  const w = 300;
  const h = 46;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - 3 - ((p - min) / span) * (h - 6);
      return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="tr-spark" preserveAspectRatio="none">
      <path d={path + ` L${w},${h} L0,${h} Z`} fill={up ? "rgba(14,203,129,0.13)" : "rgba(246,70,93,0.13)"} />
      <path d={path} fill="none" stroke={up ? "#0ecb81" : "#f6465d"} strokeWidth="1.6" />
    </svg>
  );
}

export default function SignalsPanel() {
  const st = useStore();
  const [tab, setTab] = useState<"signals" | "flow" | "info">("signals");
  const [source, setSource] = useState<"live" | "history">("live");
  const [onlyPassed, setOnlyPassed] = useState(false);
  const [showLevels, setShowLevels] = useState(true);
  const base = symbolOf(st.symbol).base;

  const rows: Row[] = useMemo(() => {
    const src: Row[] =
      source === "live"
        ? st.liveSignals.map((s) => ({ ...s, liveRow: true }))
        : (st.backtest?.signals ?? []).slice(0, 80);
    return onlyPassed ? src.filter((r) => r.conf >= st.threshold && r.status !== "skipped") : src;
  }, [source, onlyPassed, st.threshold, st.liveSignals, st.backtest]);

  // 门槛后统计（仅通过门槛且已结算）
  const passed = useMemo(() => {
    const all: TradedSignal[] = (st.backtest?.signals ?? []).filter((r) => r.status === "done");
    return all.filter((r) => r.conf >= st.threshold);
  }, [st.backtest, st.threshold]);

  const stats = useMemo(() => {
    const wins = passed.filter((r) => (r.r ?? 0) > 0);
    const totalR = passed.reduce((a, r) => a + (r.r ?? 0), 0);
    let cum = 0;
    let peak = 0;
    let dd = 0;
    for (const r of [...passed].sort((a, b) => (a.exitTs ?? a.ts) - (b.exitTs ?? b.ts))) {
      cum += r.r ?? 0;
      peak = Math.max(peak, cum);
      dd = Math.max(dd, peak - cum);
    }
    return {
      n: passed.length,
      wins: wins.length,
      winRate: passed.length ? (wins.length / passed.length) * 100 : 0,
      avgR: passed.length ? totalR / passed.length : 0,
      totalR,
      dd,
    };
  }, [passed]);

  // 置信度分布（信号分箱）
  const bins = useMemo(() => {
    const all = source === "history" ? (st.backtest?.signals ?? []) : st.liveSignals;
    const out: { label: string; n: number; on: boolean }[] = [];
    for (let v = 30; v < 95; v += 5) {
      out.push({
        label: String(v),
        n: all.filter((r) => r.conf >= v && r.conf < v + 5).length,
        on: v <= st.threshold && st.threshold < v + 5,
      });
    }
    return out;
  }, [st.backtest, st.liveSignals, st.threshold, source]);

  const tape = st.tape;
  const cvd = tape?.cvd ?? [];
  const cvdNow = cvd.length ? cvd[cvd.length - 1].v : 0;
  const total = (tape?.bucket.buy ?? 0) + (tape?.bucket.sell ?? 0);
  const buyPct = total > 0 ? ((tape?.bucket.buy ?? 0) / total) * 100 : 50;
  const imb = tape?.bookImb ?? null;
  const bidPct = imb == null ? 50 : ((1 + imb) / 2) * 100;
  const o = st.backtest?.overall;

  return (
    <div className="tr-root">
      <header className="tr-head">
        <h2>交易</h2>
      </header>

      <div className="tr-scroll">
        <section className="tr-symbol">
          <div>
            <div className="tr-sym-name">{base}</div>
            <div className="tr-sym-sub">USDT 永续 · {st.tf}m · OKX</div>
          </div>
          <div className="tr-sym-price mono">
            {st.lastPrice != null ? fmtPrice(st.lastPrice, base) : "—"}
          </div>
        </section>

        <section className="tr-status">
          <div className="tr-status-row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8fd94b" strokeWidth="2">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span>
              {st.signals.length > 0
                ? `已识别 ${st.signals.length} 个双顶/双底形态`
                : "最新收盘 K 线上没有二次测试形态"}
            </span>
          </div>
          <p>
            引擎只在价格第二次回到历史顶/底关键位，且订单流与结构证据达标时发出信号；触及关键位本身不构成入场。
          </p>
        </section>

        <section className="tr-threshold">
          <div className="tr-th-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4dc3ff" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            概率门槛
            <b className="mono" style={{ color: gradColor(st.threshold) }}>{st.threshold}%</b>
          </div>
          <input
            type="range"
            min={35}
            max={88}
            value={st.threshold}
            onChange={(e) => store.setThreshold(Number(e.target.value))}
            className="tr-slider"
            style={{
              background: `linear-gradient(90deg,#f6465d 0%,#f0b90b 42%,#8fd94b 70%,#0ecb81 100%)`,
            }}
          />
        </section>

        <section className="tr-chips">
          <span className="tr-chip-label">预设目标</span>
          {TARGETS.map((t) => (
            <button
              key={t.id}
              className={"tr-chip" + (st.targetMode === t.id ? " tr-chip-on" : "")}
              onClick={() => store.setTargetMode(t.id)}
            >
              {t.label}
            </button>
          ))}
        </section>

        <section className="tr-chips">
          <button
            className={"tr-chip" + (showLevels ? " tr-chip-on" : "")}
            onClick={() => {
              setShowLevels(!showLevels);
              store.setShowSignals(!showLevels);
            }}
          >
            关键位
          </button>
          <button
            className={"tr-chip" + (onlyPassed ? " tr-chip-on" : "")}
            onClick={() => setOnlyPassed(!onlyPassed)}
          >
            仅看通过门槛
          </button>
          <button className="tr-chip tr-chip-ghost" onClick={() => store.runBacktest()}>
            引擎详情
          </button>
        </section>

        <section className="tr-stats">
          <div>
            <span className="tr-k">门槛后胜率</span>
            <b className="mono" style={{ color: stats.winRate >= 50 ? "#0ecb81" : "#f0b90b" }}>
              {stats.n ? stats.winRate.toFixed(1) + "%" : "—"}
            </b>
            <em>{stats.wins}/{stats.n} 笔</em>
          </div>
          <div>
            <span className="tr-k">期望 R/笔</span>
            <b className={"mono " + (stats.avgR >= 0 ? "tr-up" : "tr-down")}>{fmtR(stats.avgR)}</b>
            <em>门槛 {st.threshold}%</em>
          </div>
          <div>
            <span className="tr-k">净收益 R</span>
            <b className={"mono " + (stats.totalR >= 0 ? "tr-up" : "tr-down")}>{fmtR(stats.totalR)}</b>
            <em>回撤 {stats.dd.toFixed(1)}R</em>
          </div>
        </section>

        <section className="tr-hist">
          {bins.map((b) => (
            <div key={b.label} className={"tr-hist-col" + (b.on ? " tr-hist-on" : "")}>
              <div className="tr-hist-bar" style={{ height: Math.min(100, (b.n / Math.max(1, ...bins.map((x) => x.n))) * 100) + "%" }} />
              <em>{b.label}</em>
            </div>
          ))}
        </section>

        <nav className="tr-tabs">
          <button className={tab === "signals" ? "on" : ""} onClick={() => setTab("signals")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
            信号 {rows.length}
          </button>
          <button className={tab === "flow" ? "on" : ""} onClick={() => setTab("flow")}>
            订单流
          </button>
          <button className={tab === "info" ? "on" : ""} onClick={() => setTab("info")}>
            说明
          </button>
        </nav>

        {tab === "signals" && (
          <>
            <div className="tr-src">
              {(
                [
                  ["live", "实时"],
                  ["history", "回测历史"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={source === k ? "on" : ""} onClick={() => setSource(k)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="tr-cards">
              {rows.length === 0 ? (
                <div className="tr-blank">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3a4354" strokeWidth="1.5">
                    <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {onlyPassed ? "当前门槛下没有通过的信号" : "等待双顶/双底收盘确认…"}
                  <span>
                    {onlyPassed
                      ? "降低概率门槛可查看更多候选信号"
                      : "需收盘拒绝或突破颈线，并通过方向与盈亏比验证。不自动下单。"}
                  </span>
                </div>
              ) : (
                rows.map((r) => <SignalCard key={r.id} row={r} base={base} />)
              )}
            </div>
          </>
        )}

        {tab === "flow" && (
          <div className="tr-cards">
            <div className="tr-box">
              <div className="tr-box-top">
                <span>CVD 主动量（历史段为K线估算）</span>
                <b className={"mono " + (cvdNow >= 0 ? "tr-up" : "tr-down")}>
                  {cvdNow >= 0 ? "+" : ""}
                  {Math.abs(cvdNow) >= 1000 ? (cvdNow / 1000).toFixed(1) + "K" : cvdNow.toFixed(0)}
                </b>
              </div>
              <Sparkline points={cvd.map((p) => p.v)} />
            </div>
            <div className="tr-box">
              <div className="tr-box-top">
                <span>当前 K 线主动成交</span>
                <em className="tr-badge">{tape?.connected ? "实时逐笔" : "无逐笔"}</em>
              </div>
              <div className="tr-bar">
                <div className="tr-bar-up" style={{ width: buyPct + "%" }} />
                <div className="tr-bar-dn" style={{ left: buyPct + "%" }} />
              </div>
              <div className="tr-bar-lbl mono">
                <span className="tr-up">买 {buyPct.toFixed(0)}%</span>
                <span className="tr-down">卖 {(100 - buyPct).toFixed(0)}%</span>
              </div>
            </div>
            <div className="tr-box">
              <div className="tr-box-top">
                <span>盘口深度失衡（5档）</span>
                <b className="mono">{imb == null ? "—" : (imb > 0 ? "+" : "") + (imb * 100).toFixed(0)}</b>
              </div>
              <div className="tr-gauge">
                <div
                  className={"tr-gauge-fill " + (imb == null ? "" : imb >= 0 ? "tr-up-bg" : "tr-down-bg")}
                  style={
                    imb == null
                      ? { left: "45%", width: "10%" }
                      : {
                          left: (imb >= 0 ? 50 - imb * 50 : 50 - Math.abs(imb) * 50) + "%",
                          width: Math.max(5, Math.abs(50 - (imb >= 0 ? 50 - imb * 50 : 50 - Math.abs(imb) * 50))) + "%",
                        }
                  }
                />
              </div>
              <div className="tr-bar-lbl mono">
                <span className="tr-up">买盘 {bidPct.toFixed(0)}%</span>
                <span className="tr-down">卖盘 {(100 - bidPct).toFixed(0)}%</span>
              </div>
            </div>
            <div className="tr-box">
              <div className="tr-box-top">
                <span>大单监控（&gt;8× 中位数）</span>
              </div>
              {(tape?.big ?? []).length === 0 ? (
                <div className="tr-blank tr-blank-s">暂无大单触发</div>
              ) : (
                (tape?.big ?? []).slice(0, 5).map((b, i) => (
                  <div key={b.ts + "-" + i} className="tr-big mono">
                    <span className={"tr-side " + (b.side === "buy" ? "tr-side-long" : "tr-side-short")}>
                      {b.side === "buy" ? "买入" : "卖出"}
                    </span>
                    <b>{fmtNotional(b.notional)}</b>
                    <em>{fmtPrice(b.px, base)}</em>
                  </div>
                ))
              )}
            </div>
            <p className="tr-note">
              订单流只用于<b>验证入场方向</b>：逐笔覆盖不足 80% 时自动回退到 K 线量价估算，并在信号上明确标注。
            </p>
          </div>
        )}

        {tab === "info" && (
          <div className="tr-cards">
            <div className="tr-box">
              <div className="tr-box-top">
                <span>回测核心指标</span>
                <button className="tr-mini" onClick={() => store.runBacktest()}>
                  {st.backtestRunning ? "计算中…" : "重新回测"}
                </button>
              </div>
              {!o ? (
                <div className="tr-blank tr-blank-s">{st.backtestRunning ? "回放已收盘 K 线中…" : "等待数据…"}</div>
              ) : (
                <div className="tr-statgrid">
                  <div>
                    <span className="tr-k">执行</span>
                    <b className="mono tr-xl">{o.executed}</b>
                    <em>跳过 {o.skipped}</em>
                  </div>
                  <div>
                    <span className="tr-k">胜率</span>
                    <b className={"mono tr-xl " + (o.winRate >= 50 ? "tr-up" : "tr-amber")}>
                      {o.winRate.toFixed(1)}%
                    </b>
                    <em>{o.wins}胜 / {o.losses}负</em>
                  </div>
                  <div>
                    <span className="tr-k">平均R</span>
                    <b className={"mono tr-xl " + (o.avgR >= 0 ? "tr-up" : "tr-down")}>{fmtR(o.avgR)}</b>
                    <em>PF {o.pf >= 99 ? "∞" : o.pf.toFixed(2)}</em>
                  </div>
                  <div>
                    <span className="tr-k">累计</span>
                    <b className={"mono tr-xl " + (o.totalR >= 0 ? "tr-up" : "tr-down")}>{fmtR(o.totalR)}</b>
                    <em>回撤 -{o.maxDD.toFixed(1)}R</em>
                  </div>
                </div>
              )}
            </div>

            {st.backtest && (
              <div className="tr-box">
                <div className="tr-box-top">
                  <span>各形态（{st.backtest.bars.toLocaleString()} 根已收盘K线）</span>
                </div>
                {st.backtest.byPattern.length === 0 ? (
                  <div className="tr-blank tr-blank-s">该窗口内没有通过确认的信号</div>
                ) : (
                  st.backtest.byPattern.map((p) => (
                    <div key={p.id} className="tr-pat">
                      <span>{p.label}</span>
                      <em className="mono">n={p.n}</em>
                      <b className={"mono " + (p.winRate >= 50 ? "tr-up" : "tr-amber")}>{p.winRate.toFixed(0)}%</b>
                      <b className={"mono " + (p.totalR >= 0 ? "tr-up" : "tr-down")}>{fmtR(p.totalR)}</b>
                    </div>
                  ))
                )}
              </div>
            )}

            <div className="tr-box">
              <div className="tr-box-top">
                <span>历史样本参考</span>
              </div>
              <p className="tr-note tr-note-in">
                {stats.n >= MIN_HISTORY_SAMPLES
                  ? `当前门槛下历史胜率 ${stats.winRate.toFixed(1)}%（${stats.wins}/${stats.n}），仅供对照，非预测胜率。`
                  : `当前门槛下样本 ${stats.n}/${MIN_HISTORY_SAMPLES}，不足以给出稳定胜率。`}
              </p>
              <p className="tr-note tr-note-in">
                回测只使用<b>已收盘</b> K 线，信号在下一根开盘模拟入场（含手续费与滑点）；历史段方向为 K 线估算，不含历史逐笔。
                样本少时胜率不稳定，结果<b>不代表未来表现</b>。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
