import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { IndicatorHandle, WidgetContext } from "@luxalgo/vela";
import { Dialog } from "@luxalgo/vela/ui";
import {
  buildIndicatorCatalog,
  FEATURED_ORDER,
  FAMILIES,
  type CatalogItem,
} from "../lib/indicator-catalog";
import { store } from "../lib/store";
import IndicatorPreview from "./IndicatorPreview";
import Icon from "./ui/Icon";

type Category =
  | "discover"
  | "all"
  | "favorites"
  | "added"
  | "trend"
  | "momentum"
  | "volatility"
  | "volume"
  | "structure";
const FAVORITES_KEY = "pulsedesk.indicator-favorites.v1";

function readFavorites(): Set<string> {
  try {
    const list: unknown = JSON.parse(
      localStorage.getItem(FAVORITES_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(list)
        ? list.filter((n): n is string => typeof n === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function Library({
  ctx,
  onClose,
}: {
  ctx: WidgetContext;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [error, setError] = useState("");
  const [category, setCategory] = useState<Category>("discover");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("bollinger-bands");
  const [favorites, setFavorites] = useState(readFavorites);
  const [added, setAdded] = useState<Map<string, IndicatorHandle[]>>(new Map());
  const [keepOpen, setKeepOpen] = useState(true);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [bars, setBars] = useState(() => store.previewBars());

  useEffect(() => {
    if (bars.length >= 8) return;
    return store.subscribe(() => {
      const loaded = store.previewBars();
      if (loaded.length >= 8) setBars(loaded);
    });
  }, [bars.length]);

  const refreshAdded = useCallback(() => {
    const map = new Map<string, IndicatorHandle[]>();
    for (const handle of ctx.chart.indicators()) {
      if (!handle.nativeType) continue;
      map.set(handle.nativeType, [
        ...(map.get(handle.nativeType) ?? []),
        handle,
      ]);
    }
    setAdded(map);
  }, [ctx]);

  useEffect(() => {
    let active = true;
    ctx.chart
      .availableNativeIndicators()
      .then((list) => {
        if (active) setCatalog(buildIndicatorCatalog(list));
      })
      .catch(() => {
        if (active) setError("指标目录加载失败，请关闭后重试。");
      });
    refreshAdded();
    const offs = [
      "indicator:added",
      "indicator:removed",
      "indicator:visibility",
    ].map((name) => ctx.chart.on(name, refreshAdded));
    search.current?.focus();
    return () => {
      active = false;
      offs.forEach((off) => off());
      clearTimeout(noticeTimer.current);
    };
  }, [ctx, refreshAdded]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      } catch {
        /* Storage can be unavailable in private windows. */
      }
      return next;
    });
  }, []);

  const ordered = useMemo(
    () =>
      [...catalog].sort((a, b) => {
        const ai = FEATURED_ORDER.indexOf(a.type);
        const bi = FEATURED_ORDER.indexOf(b.type);
        if (ai >= 0 || bi >= 0)
          return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
        return a.title.localeCompare(b.title, "zh-CN");
      }),
    [catalog],
  );

  const filtered = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return ordered.filter((n) => {
      const categoryMatches =
        category === "discover" ||
        category === "all" ||
        (category === "favorites"
          ? favorites.has(n.type)
          : category === "added"
            ? added.has(n.type)
            : n.family === category);
      return (
        categoryMatches &&
        (!text ||
          `${n.title} ${n.english} ${n.type} ${n.description}`
            .toLocaleLowerCase()
            .includes(text))
      );
    });
  }, [query, ordered, category, favorites, added]);

  const selected = filtered.find((n) => n.type === selectedId) ?? filtered[0];
  useEffect(() => {
    if (filtered.length && !filtered.some((n) => n.type === selectedId))
      setSelectedId(filtered[0].type);
  }, [filtered, selectedId]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        FAMILIES.map((f) => [
          f.id,
          catalog.filter((n) => n.family === f.id).length,
        ]),
      ),
    [catalog],
  );
  const totalAdded = [...added.values()].reduce(
    (n, handles) => n + handles.length,
    0,
  );
  const selectedCount = selected ? (added.get(selected.type)?.length ?? 0) : 0;
  const canAdd =
    selected &&
    selected.supported &&
    (!selectedCount || selected.multiInstance);

  function notify(text: string) {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2600);
  }

  function add(item: CatalogItem, preserve = keepOpen) {
    if (!item.supported || pending) return;
    if (added.has(item.type) && !item.multiInstance) {
      notify(`${item.title} 已在图表中`);
      return;
    }
    setPending(item.type);
    try {
      ctx.addNativeIndicator(item.type);
      refreshAdded();
      notify(`已添加 ${item.title}`);
      if (!preserve) onClose();
    } catch {
      notify("添加失败，请检查当前指标的数据源要求。");
    } finally {
      setPending(null);
    }
  }

  function chooseCategory(next: Category) {
    setCategory(next);
    results.current?.scrollTo({ top: 0 });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const typing = event.target instanceof HTMLInputElement;
    const button =
      event.target instanceof Element ? event.target.closest("button") : null;
    if (
      event.key === "Enter" &&
      button &&
      !button.classList.contains("ib-card-select")
    )
      return;
    if (
      event.key === "Enter" &&
      selected &&
      event.target instanceof HTMLInputElement &&
      event.target.type === "checkbox"
    )
      return;
    if (event.key === "Enter" && selected) {
      event.preventDefault();
      event.stopPropagation();
      add(selected, event.shiftKey || keepOpen);
    } else if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      filtered.length
    ) {
      event.preventDefault();
      event.stopPropagation();
      const index = filtered.findIndex((n) => n.type === selectedId);
      const next =
        (index + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) %
        filtered.length;
      setSelectedId(filtered[next].type);
      results.current
        ?.querySelector<HTMLElement>(
          `[data-indicator-type="${filtered[next].type}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
    } else if (!typing && event.key.toLowerCase() === "f" && selected) {
      event.preventDefault();
      event.stopPropagation();
      toggleFavorite(selected.type);
    }
  }

  const card = (item: CatalogItem) => {
    const isAdded = added.has(item.type);
    return (
      <article
        key={item.type}
        className={`ib-card${selectedId === item.type ? " ib-card-selected" : ""}`}
        data-indicator-type={item.type}
      >
        <button
          className="ib-card-select"
          onClick={() => setSelectedId(item.type)}
          onFocus={() => setSelectedId(item.type)}
          onDoubleClick={() => add(item, true)}
          aria-pressed={selectedId === item.type}
          aria-label={`查看 ${item.title}`}
        >
          <IndicatorPreview bars={bars} kind={item.preview} />
          <div className="ib-card-copy">
            <span className="ib-card-kicker">
              {isAdded ? (
                <>
                  <Icon name="check" size={11} /> 已添加
                  {(added.get(item.type)?.length ?? 0) > 1
                    ? ` ${added.get(item.type)!.length} 组`
                    : ""}
                </>
              ) : item.type === "pulse.double" ? (
                "PULSEDESK 策略"
              ) : (
                "内置指标"
              )}
            </span>
            <h3>{item.title}</h3>
            <p>
              {FAMILIES.find((f) => f.id === item.family)?.label} <span>·</span>{" "}
              {item.overlay ? "主图叠加" : "独立窗格"}
            </p>
          </div>
        </button>
        <button
          className={`ib-card-favorite${favorites.has(item.type) ? " is-favorite" : ""}`}
          onClick={() => toggleFavorite(item.type)}
          aria-label={`${favorites.has(item.type) ? "取消收藏" : "收藏"} ${item.title}`}
          aria-pressed={favorites.has(item.type)}
        >
          <Icon name="star" size={16} filled={favorites.has(item.type)} />
        </button>
        {(!isAdded || item.multiInstance) && (
          <button
            className="ib-card-add"
            onClick={() => add(item, true)}
            disabled={!item.supported}
            aria-label={`添加 ${item.title}`}
            title={item.supported ? "添加并继续选择" : "当前数据源不支持"}
          >
            <Icon name="plus" size={15} />
          </button>
        )}
      </article>
    );
  };

  const sectionTitle = query.trim()
    ? `搜索结果 (${filtered.length})`
    : category === "discover"
      ? "精选指标"
      : category === "favorites"
        ? "我的收藏"
        : category === "added"
          ? "已添加到图表"
          : category === "all"
            ? "全部指标"
            : FAMILIES.find((f) => f.id === category)?.label;
  const featured = filtered.filter((n) => n.featured).slice(0, 3);
  const showDiscovery = category === "discover" && !query.trim();

  return (
    <div
      className="ib-library"
      data-testid="indicator-library"
      onKeyDown={onKeyDown}
    >
      <header className="ib-header">
        <h2>指标库</h2>
        <label className="ib-search">
          <Icon name="search" size={19} />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索指标、概念或别名..."
            aria-label="搜索指标"
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
              aria-label="清空搜索"
            >
              <Icon name="close" size={15} />
            </button>
          )}
        </label>
        <button className="ib-close" onClick={onClose} aria-label="关闭指标库">
          <Icon name="close" size={20} />
        </button>
      </header>

      <div className="ib-layout">
        <aside className="ib-navigation" aria-label="指标分类">
          <span className="ib-nav-label">我的指标</span>
          <button
            className={category === "favorites" ? "is-active" : ""}
            onClick={() => chooseCategory("favorites")}
          >
            <Icon name="star" />
            我的收藏<span>{favorites.size || ""}</span>
          </button>
          <button
            className={category === "added" ? "is-active" : ""}
            onClick={() => chooseCategory("added")}
          >
            <Icon name="check" />
            已添加<span>{totalAdded}</span>
          </button>
          <span className="ib-nav-label">指标库</span>
          <button
            className={category === "discover" ? "is-active" : ""}
            onClick={() => chooseCategory("discover")}
          >
            <Icon name="compass" />
            发现
          </button>
          <button
            className={category === "all" ? "is-active" : ""}
            onClick={() => chooseCategory("all")}
          >
            <Icon name="grid" />
            全部指标<span>{catalog.length}</span>
          </button>
          <span className="ib-nav-label">分类浏览</span>
          {FAMILIES.map((f) => (
            <button
              key={f.id}
              className={category === f.id ? "is-active" : ""}
              onClick={() => chooseCategory(f.id)}
            >
              <Icon name={f.icon} />
              {f.label}
              <span>{counts[f.id] ?? 0}</span>
            </button>
          ))}
          <div className="ib-source-note">
            <Icon name="info" size={14} />
            <span>当前显示已安装的真实指标。无需连接远程脚本库。</span>
          </div>
        </aside>

        <main className="ib-results" ref={results} aria-label="可选指标">
          <div className="ib-section-heading">
            <h3>{sectionTitle}</h3>
            <button onClick={() => chooseCategory("all")}>
              {showDiscovery ? "查看全部" : `${filtered.length} 项`}{" "}
              {showDiscovery && <Icon name="arrow" size={14} />}
            </button>
          </div>
          {error ? (
            <div className="ib-empty">
              <Icon name="info" size={32} />
              <h3>暂时无法加载</h3>
              <p>{error}</p>
            </div>
          ) : !catalog.length ? (
            <div className="ib-loading">
              <span />
              正在加载指标目录...
            </div>
          ) : !filtered.length ? (
            <div className="ib-empty">
              <Icon
                name={category === "favorites" ? "star" : "search"}
                size={34}
              />
              <h3>
                {category === "favorites"
                  ? "收藏你的常用指标"
                  : "没有找到匹配的指标"}
              </h3>
              <p>
                {category === "favorites"
                  ? "点击指标上的星标，下次即可快速找到。"
                  : "试试 RSI、均线、布林带，或切换左侧分类。"}
              </p>
              {query && <button onClick={() => setQuery("")}>清空搜索</button>}
            </div>
          ) : (
            <>
              <div className="ib-grid">
                {(showDiscovery ? featured : filtered).map(card)}
              </div>
              {showDiscovery && (
                <>
                  <div className="ib-section-heading ib-more-heading">
                    <h3>更多值得探索</h3>
                    <span>选择指标以查看详情</span>
                  </div>
                  <div className="ib-grid">
                    {filtered
                      .filter((n) => !featured.some((f) => f.type === n.type))
                      .slice(0, 27)
                      .map(card)}
                  </div>
                </>
              )}
            </>
          )}
        </main>

        <aside className="ib-details" aria-label="指标详情">
          {selected ? (
            <>
              <div className="ib-detail-scroll">
                <IndicatorPreview bars={bars} kind={selected.preview} large />
                <span className="ib-detail-family">
                  {FAMILIES.find((f) => f.id === selected.family)?.label}{" "}
                  <span>·</span> {selected.overlay ? "主图叠加" : "独立窗格"}
                </span>
                <h3>{selected.title}</h3>
                <p className="ib-detail-english">{selected.english}</p>
                <p className="ib-description">{selected.description}</p>
                <div className="ib-parameters">
                  <span>来源</span>
                  <b>
                    {selected.type === "pulse.double"
                      ? "PULSEDESK"
                      : "Vela 内置"}
                  </b>
                  <span>实例</span>
                  <b>{selected.multiInstance ? "可叠加多组参数" : "单实例"}</b>
                  <span>当前图表</span>
                  <b>
                    {selectedCount ? `已添加 ${selectedCount} 组` : "尚未添加"}
                  </b>
                </div>
                <p className="ib-preview-note">
                  预览基于当前行情的简化示意，完整计算与参数以添加后的图表为准。
                </p>
                {!selected.supported && (
                  <p className="ib-unavailable">
                    当前数据源不支持此指标所需的数据。
                  </p>
                )}
              </div>
              <div className="ib-detail-actions">
                <button
                  className="ib-primary"
                  onClick={() => add(selected)}
                  disabled={!canAdd || pending === selected.type}
                >
                  {selectedCount && !selected.multiInstance ? (
                    <>
                      <Icon name="check" size={16} /> 已添加到图表
                    </>
                  ) : (
                    <>
                      {selectedCount ? "再添加一组" : "添加到图表"}
                      <kbd>↵</kbd>
                    </>
                  )}
                </button>
                <div className="ib-secondary-actions">
                  <button
                    onClick={() => toggleFavorite(selected.type)}
                    className={
                      favorites.has(selected.type) ? "is-favorite" : ""
                    }
                  >
                    <Icon
                      name="star"
                      size={15}
                      filled={favorites.has(selected.type)}
                    />
                    {favorites.has(selected.type) ? "已收藏" : "收藏"}
                  </button>
                  {selectedCount > 0 ? (
                    <button
                      onClick={() => {
                        added.get(selected.type)?.at(-1)?.remove();
                        refreshAdded();
                        notify(`已移除 ${selected.title}`);
                      }}
                    >
                      移除一组
                    </button>
                  ) : (
                    <span>
                      <Icon name="layers" size={14} />{" "}
                      {selected.overlay ? "主图指标" : "副图指标"}
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="ib-empty">
              <Icon name="chart" size={32} />
              <p>选择一个指标查看详情</p>
            </div>
          )}
        </aside>
      </div>

      <footer className="ib-footer">
        <div className="ib-shortcuts">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 浏览
          </span>
          <span>
            <kbd>↵</kbd> 添加
          </span>
          <span>
            <kbd>Shift</kbd>
            <kbd>↵</kbd> 添加并保留
          </span>
          <span>
            <kbd>F</kbd> 收藏
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
        <span className="ib-notice" role="status">
          {notice}
        </span>
        <label className="ib-keep-open">
          <input
            type="checkbox"
            checked={keepOpen}
            onChange={(e) => setKeepOpen(e.target.checked)}
          />
          添加后保持打开
        </label>
        <span className="ib-total">
          {catalog.length} 个指标 <i>·</i> 已添加 {totalAdded} 组
        </span>
      </footer>
    </div>
  );
}

export default function IndicatorBrowser({
  ctx,
  onClose,
}: {
  ctx: WidgetContext;
  onClose: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useLayoutEffect(() => {
    let opened = false;
    let disposed = false;
    const surface = new Dialog({
      host: ctx.host,
      title: "指标库",
      className: "pulse-indicator-dialog",
      align: "center",
      flush: true,
      dimBackdrop: true,
      closeOnEscape: true,
      closeOnInteractOutside: true,
      onOpenChange(open) {
        if (open) opened = true;
        else if (opened && !disposed) onClose();
      },
    });
    surface.positioner.classList.add("pulse-library-positioner");
    surface.backdrop.classList.add("pulse-library-backdrop");
    surface.body.classList.add("pulse-library-body");
    surface.titleEl.parentElement?.classList.add("pulse-library-native-header");
    surface.show();
    setDialog(surface);
    return () => {
      disposed = true;
      surface.destroy();
    };
  }, [ctx, onClose]);
  return dialog
    ? createPortal(
        <Library ctx={ctx} onClose={() => dialog.hide()} />,
        dialog.body,
      )
    : null;
}
