import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { IndicatorHandle, NativeIndicatorInfo, WidgetContext } from "@luxalgo/vela";
import { Dialog } from "@luxalgo/vela/ui";
import {
  buildIndicatorCatalog,
  type CatalogItem,
} from "../../lib/indicator-catalog";
import Icon from "../../components/ui/Icon";
import {
  CONCEPTS,
  FAMILIES,
  FAMILY_ICON,
  FAMILY_ZH,
  clusterLabel,
  INDICATORS,
  dateLabel,
  familyCounts,
  familyLabel,
  firstSentence,
  libraryUrl,
  nativeFor,
  newestDate,
  newestFirst,
  explorePicks,
  readFavorites,
  saveFavorites,
  type LibConcept,
  type LibIndicator,
} from "./data";

type Mode =
  | "discover"
  | "scripts"
  | "favorites"
  | "concepts"
  | "basic"
  | "orderflow"
  | "family"
  | "myscripts"
  | "bring";
type Sort = "recent" | "name";
type Layout = "grid" | "list";
type NativeItem = CatalogItem & { group: "basic" | "orderflow"; section: string };

const SECTION_ZH: Record<string, string> = {
  trend: "趋势",
  momentum: "动量",
  volatility: "波动率",
  volume: "成交量与资金流",
  structure: "结构",
};
const idOfNative = (item: { type: string }) => `n:${item.type}`;
const idOfScript = (item: { slug: string }) => `s:${item.slug}`;
const idOfConcept = (item: { slug: string }) => `c:${item.slug}`;

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = String(text ?? "").split(new RegExp(`(${escaped})`, "ig"));
  return parts.map((part, index) =>
    part.toLocaleLowerCase() === needle.toLocaleLowerCase() ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      part
    ),
  );
}

function Thumb({
  src,
  alt,
  big = false,
  eager = false,
}: {
  src: string;
  alt: string;
  big?: boolean;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`libref-thumb${big ? " is-big" : ""}`}>
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="libref-thumb-fallback" aria-hidden="true">
          <Icon name="chart" size={big ? 34 : 22} />
        </span>
      )}
    </span>
  );
}

function SectionHead({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="libref-section-head">
      <h2>{title}</h2>
      {action && (
        <button className="libref-text-button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function Library({
  ctx,
  onClose,
}: {
  ctx: WidgetContext;
  onClose: () => void;
}) {
  const chart = ctx.chart;
  const [natives, setNatives] = useState<NativeItem[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("discover");
  const [family, setFamily] = useState<string | null>(null);
  const [cluster, setCluster] = useState<string | null>(null);
  const [conceptSlug, setConceptSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [layout, setLayout] = useState<Layout>("grid");
  const [limit, setLimit] = useState(24);
  const [conceptLimit, setConceptLimit] = useState(80);
  const [seed, setSeed] = useState(7);
  const [favorites, setFavorites] = useState(readFavorites);
  const [added, setAdded] = useState<Map<string, IndicatorHandle[]>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [keepOpen, setKeepOpen] = useState(true);
  const [toast, setToast] = useState("");
  const [bringCode, setBringCode] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerAt = useRef("");
  const visibleIds = useRef<string[]>([]);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3600);
  }, []);

  const refreshAdded = useCallback(() => {
    const map = new Map<string, IndicatorHandle[]>();
    for (const handle of chart.indicators()) {
      if (!handle.nativeType) continue;
      map.set(handle.nativeType, [
        ...(map.get(handle.nativeType) ?? []),
        handle,
      ]);
    }
    setAdded(map);
  }, [chart]);

  useEffect(() => {
    let active = true;
    chart
      .availableNativeIndicators()
      .then((list: NativeIndicatorInfo[]) => {
        if (!active) return;
        setNatives(
          buildIndicatorCatalog(list).map((item) => ({
            ...item,
            group: item.family === "volume" ? "orderflow" : "basic",
            section: SECTION_ZH[item.family] ?? "基础指标",
          })),
        );
      })
      .catch(() => {
        if (active) setError("无法加载图表的指标目录，请关闭后重试。");
      });
    refreshAdded();
    const offs = [
      "indicator:added",
      "indicator:removed",
      "indicator:visibility",
    ].map((name) => chart.on(name, refreshAdded));
    searchRef.current?.focus();
    return () => {
      active = false;
      offs.forEach((off) => off());
      clearTimeout(toastTimer.current);
    };
  }, [chart, refreshAdded]);

  const clusterBySlug = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const concept of CONCEPTS) {
      if (!concept.cluster) continue;
      for (const slug of concept.indicators) {
        if (!map.has(slug)) map.set(slug, new Set());
        map.get(slug)!.add(concept.cluster);
      }
    }
    return map;
  }, []);

  const library = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return INDICATORS.filter((item) => {
      if (family && !item.families.includes(family)) return false;
      if (cluster && !clusterBySlug.get(item.slug)?.has(cluster)) return false;
      if (!text) return true;
      return `${item.name} ${item.description} ${item.tags.join(" ")} ${familyLabel(item.family)}`
        .toLocaleLowerCase()
        .includes(text);
    }).sort(
      sort === "name"
        ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name),
    );
  }, [query, family, cluster, clusterBySlug, sort]);

  const builtins = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return natives
      .filter((item) => {
        if (mode === "basic" && item.group !== "basic") return false;
        if (mode === "orderflow" && item.group !== "orderflow") return false;
        if (!text) return true;
        return `${item.title} ${item.english} ${item.type} ${item.description} ${item.section}`
          .toLocaleLowerCase()
          .includes(text);
      })
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }, [natives, query, mode]);

  const concepts = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return CONCEPTS.filter((concept) => {
      if (family && concept.family !== family) return false;
      if (!text) return true;
      return `${concept.name} ${concept.slug} ${concept.aliases.join(" ")} ${concept.cluster ?? ""} ${concept.blurb}`
        .toLocaleLowerCase()
        .includes(text);
    }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [query, family]);

  const latest = newestFirst.slice(0, 3);
  const picks = useMemo(() => explorePicks(seed, 6), [seed]);
  const favoriteScripts = useMemo(
    () => library.filter((item) => favorites.has(idOfScript(item))),
    [library, favorites],
  );
  const favoriteNatives = useMemo(
    () => natives.filter((item) => favorites.has(idOfNative(item))),
    [natives, favorites],
  );

  const isSearching = !!query.trim();
  const clusters = useMemo(
    () =>
      family
        ? [
            ...new Set(
              CONCEPTS.filter((concept) => concept.family === family && concept.cluster).map(
                (concept) => concept.cluster as string,
              ),
            ),
          ].sort()
        : [],
    [family],
  );

  const shownScripts = useMemo(() => {
    if (isSearching) return library.slice(0, limit);
    if (mode === "scripts" || mode === "family") return library.slice(0, limit);
    return [];
  }, [library, limit, mode, isSearching]);

  const shownConcepts = useMemo(() => {
    if (isSearching) return concepts.slice(0, 12);
    if (mode === "concepts") return concepts.slice(0, conceptLimit);
    return [];
  }, [concepts, conceptLimit, mode, isSearching]);

  const visible: string[] = useMemo(() => {
    if (isSearching)
      return [
        ...builtins.map(idOfNative),
        ...shownScripts.map(idOfScript),
        ...shownConcepts.map(idOfConcept),
      ];
    if (mode === "discover") return [...latest, ...picks].map(idOfScript);
    if (mode === "scripts" || mode === "family") return shownScripts.map(idOfScript);
    if (mode === "basic" || mode === "orderflow") return builtins.map(idOfNative);
    if (mode === "favorites")
      return [
        ...favoriteNatives.map(idOfNative),
        ...favoriteScripts.map(idOfScript),
      ];
    if (mode === "concepts") return shownConcepts.map(idOfConcept);
    return [];
  }, [
    isSearching,
    builtins,
    shownScripts,
    shownConcepts,
    latest,
    picks,
    mode,
    favoriteNatives,
    favoriteScripts,
  ]);
  visibleIds.current = visible;
  const visibleKey = visible.join("|");

  useEffect(() => {
    if (!visible.length) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) =>
      current && visible.includes(current) ? current : visible[0],
    );
    // visibleKey intentionally captures every result-set change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    if (selectedId.startsWith("s:"))
      return {
        kind: "script" as const,
        item: INDICATORS.find((item) => item.slug === selectedId.slice(2)) ?? null,
      };
    if (selectedId.startsWith("n:"))
      return {
        kind: "native" as const,
        item: natives.find((item) => item.type === selectedId.slice(2)) ?? null,
      };
    if (selectedId.startsWith("c:"))
      return {
        kind: "concept" as const,
        item: CONCEPTS.find((item) => item.slug === selectedId.slice(2)) ?? null,
      };
    return null;
  }, [selectedId, natives]);

  const selectedNative = useMemo(() => {
    if (selected?.kind === "native") return selected.item as NativeItem;
    if (selected?.kind === "script" && selected.item)
      return nativeFor(selected.item as LibIndicator, natives) as NativeItem | undefined;
    return undefined;
  }, [selected, natives]);
  const selectedCount = selectedNative
    ? (added.get(selectedNative.type)?.length ?? 0)
    : 0;
  const canAdd =
    !!selectedNative &&
    selectedNative.supported &&
    (!selectedCount || !!selectedNative.multiInstance);

  const totalAdded = [...added.values()].reduce(
    (total, handles) => total + handles.length,
    0,
  );
  const newest = dateLabel(newestDate);

  const setModeAndReset = useCallback(
    (next: Mode, options: { family?: string | null; keepQuery?: boolean } = {}) => {
      setMode(next);
      setFamily(options.family ?? null);
      setCluster(null);
      setConceptSlug(null);
      setLimit(24);
      setConceptLimit(80);
      setDetailOpen(false);
      if (!options.keepQuery) {
        setQuery("");
        if (searchRef.current) searchRef.current.value = "";
      }
      requestAnimationFrame(() => {
        if (resultsRef.current) resultsRef.current.scrollTop = 0;
      });
    },
    [],
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      setFavorites((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveFavorites(next);
        return next;
      });
    },
    [],
  );

  const addNative = useCallback(
    (native: NativeItem, preserve = keepOpen) => {
      if (!native.supported) {
        notify(`${native.title} 当前品种不可用。`);
        return;
      }
      if (added.has(native.type) && !native.multiInstance) {
        notify(`${native.title} 已在图表中。`);
        return;
      }
      try {
        ctx.addNativeIndicator(native.type);
        refreshAdded();
        notify(`已将 ${native.title} 添加到图表。`);
        if (!preserve) onClose();
      } catch {
        notify("该指标无法添加到当前图表。");
      }
    },
    [added, ctx, keepOpen, notify, onClose, refreshAdded],
  );

  const requestAdd = useCallback(
    (id: string, preserve = keepOpen) => {
      if (id.startsWith("n:")) {
        const native = natives.find((item) => item.type === id.slice(2));
        if (native) addNative(native, preserve);
        return;
      }
      if (id.startsWith("s:")) {
        const script = INDICATORS.find((item) => item.slug === id.slice(2));
        if (!script) return;
        const native = nativeFor(script, natives) as NativeItem | undefined;
        if (native) {
          addNative(native, preserve);
          return;
        }
        setDetailOpen(true);
        notify(
          `${script.name} 是 LuxAlgo 指标库脚本，请从原生目录添加到托管图表。`,
        );
      }
    },
    [addNative, keepOpen, natives, notify],
  );

  const choose = useCallback((id: string, open = true) => {
    setSelectedId(id);
    if (open) setDetailOpen(true);
  }, []);

  const move = useCallback((delta: number) => {
    const ids = visibleIds.current;
    if (!ids.length) return;
    const index = ids.indexOf(selectedRef.current ?? "");
    const next = ids[Math.max(0, Math.min(ids.length - 1, (index < 0 ? -1 : index) + delta))];
    if (!next) return;
    setSelectedId(next);
    document
      .querySelector(`#libref-results [data-id="${CSS.escape(next)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = !!target?.matches("input, select, textarea");
      if (event.key === "Escape") {
        if (target?.matches("textarea")) return;
        event.preventDefault();
        if (query) {
          setQuery("");
          if (searchRef.current) searchRef.current.value = "";
          searchRef.current?.focus();
        } else onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter") {
        const picked = inField
          ? null
          : (target?.closest<HTMLElement>("[data-pick]")?.dataset.pick ?? null);
        if (!inField && !picked && target?.closest("button")) return;
        const id = picked ?? selectedRef.current;
        if (!id || id.startsWith("c:")) return;
        event.preventDefault();
        requestAdd(id, event.shiftKey);
        return;
      }
      if (inField) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key.toLowerCase() === "f" && selectedRef.current && !selectedRef.current.startsWith("c:")) {
        event.preventDefault();
        toggleFavorite(selectedRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, onClose, query, requestAdd, toggleFavorite]);

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    const at = `${event.clientX},${event.clientY}`;
    if (at === pointerAt.current) return;
    pointerAt.current = at;
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!node || !visibleIds.current.includes(node.dataset.id ?? "")) return;
    setSelectedId(node.dataset.id ?? null);
  }

  function selectFamily(key: string) {
    setMode("family");
    setFamily(key);
    setCluster(null);
    setQuery("");
    if (searchRef.current) searchRef.current.value = "";
    setDetailOpen(false);
    requestAnimationFrame(() =>
      resultsRef.current?.scrollTo({ top: 0 }),
    );
  }

  function card(item: LibIndicator, label?: string, eager = false) {
    const id = idOfScript(item);
    const native = nativeFor(item, natives);
    return (
      <article
        key={item.slug}
        className={`libref-card${selectedId === id ? " is-selected" : ""}`}
        data-id={id}
      >
        <button
          className="libref-card-main"
          data-pick={id}
          aria-label={`${native ? "添加" : "查看"} ${item.name}`}
          onClick={() => {
            setSelectedId(id);
            requestAdd(id);
          }}
        >
          <span className="libref-card-image">
            <Thumb src={item.imageUrl} alt={item.name} eager={eager} />
          </span>
          <span className="libref-card-copy">
            {label && <span className="libref-card-label">{label}</span>}
            <strong><Highlight text={item.name} query={query} /></strong>
            <span>
              {familyLabel(item.family)}
              {item.date ? ` · ${dateLabel(item.date)}` : ""}
            </span>
          </span>
        </button>
        <button
          className="libref-info"
          aria-label={`查看 ${item.name} 详情`}
          title="详情"
          onClick={(event) => {
            event.stopPropagation();
            setSelectedId(id);
            setDetailOpen(true);
          }}
        >
          <Icon name="info" size={14} />
        </button>
        <button
          className="libref-star"
          aria-label={`${favorites.has(id) ? "取消收藏" : "收藏"} ${item.name}`}
          aria-pressed={favorites.has(id)}
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(id);
          }}
        >
          <Icon name="star" size={14} filled={favorites.has(id)} />
        </button>
      </article>
    );
  }

  function scriptRow(item: LibIndicator) {
    const id = idOfScript(item);
    return (
      <div
        key={item.slug}
        className={`libref-row${selectedId === id ? " is-selected" : ""}`}
        data-id={id}
      >
        <span className="libref-row-thumb">
          <Thumb src={item.imageUrl} alt={item.name} />
        </span>
        <button
          className="libref-row-main"
          data-pick={id}
          onClick={() => {
            setSelectedId(id);
            requestAdd(id);
          }}
        >
          <strong><Highlight text={item.name} query={query} /></strong>
          <span><Highlight text={firstSentence(item.description)} query={query} /></span>
        </button>
        <span className="libref-row-meta">
          {familyLabel(item.family)}
          {item.date ? ` · ${dateLabel(item.date)}` : ""}
        </span>
        <button
          className="libref-star"
          aria-label={`${favorites.has(id) ? "取消收藏" : "收藏"} ${item.name}`}
          aria-pressed={favorites.has(id)}
          onClick={() => toggleFavorite(id)}
        >
          <Icon name="star" size={14} filled={favorites.has(id)} />
        </button>
      </div>
    );
  }

  function builtinRow(item: NativeItem) {
    const id = idOfNative(item);
    const onChart = !!added.get(item.type)?.length;
    return (
      <div
        key={item.type}
        className={`libref-row is-builtin${selectedId === id ? " is-selected" : ""}`}
        data-id={id}
        data-unsupported={!item.supported || undefined}
      >
        <button
          className="libref-row-main"
          data-pick={id}
          onClick={() => {
            setSelectedId(id);
            addNative(item);
          }}
        >
          <strong><Highlight text={item.title} query={query} /></strong>
          <span><Highlight text={item.english && item.english !== item.title ? item.english : item.type} query={query} /></span>
        </button>
        {item.beta && <span className="libref-tag is-beta">测试版</span>}
        <span className="libref-tag">{onChart || item.overlay ? "主图" : "副图"}</span>
        <button
          className="libref-info"
          aria-label={`查看 ${item.title} 详情`}
          title="详情"
          onClick={() => {
            setSelectedId(id);
            setDetailOpen(true);
          }}
        >
          <Icon name="info" size={14} />
        </button>
        <button
          className="libref-star"
          aria-label={`${favorites.has(id) ? "取消收藏" : "收藏"} ${item.title}`}
          aria-pressed={favorites.has(id)}
          onClick={() => toggleFavorite(id)}
        >
          <Icon name="star" size={14} filled={favorites.has(id)} />
        </button>
      </div>
    );
  }

  function conceptRow(concept: LibConcept) {
    const id = idOfConcept(concept);
    return (
      <button
        key={concept.slug}
        className={`libref-concept${selectedId === id ? " is-selected" : ""}`}
        data-id={id}
        onClick={() => {
          setSelectedId(id);
          setConceptSlug(concept.slug);
          setDetailOpen(true);
        }}
      >
        <span className="libref-concept-copy">
          <strong><Highlight text={concept.name} query={query} /></strong>
          <span>{concept.aliases.length ? concept.aliases.slice(0, 3).join(" · ") : clusterLabel(concept.cluster) || familyLabel(concept.family)}</span>
        </span>
        <span className="libref-row-meta">
          {concept.count} 个指标
        </span>
        <Icon name="arrow" size={14} />
      </button>
    );
  }

  function renderDetail() {
    if (selected?.kind === "concept" && selected.item) {
      const concept = selected.item as LibConcept;
      const related = concept.indicators
        .map((slug) => INDICATORS.find((item) => item.slug === slug))
        .filter((item): item is LibIndicator => !!item);
      return (
        <>
          <div className="libref-detail-body">
            <button className="libref-back" onClick={() => setDetailOpen(false)}>
              <Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />
              返回
            </button>
            <p className="libref-eyebrow">
              {familyLabel(concept.family)}
              {concept.cluster ? ` · ${clusterLabel(concept.cluster)}` : ""}
            </p>
            <h3>{concept.name}</h3>
            {concept.blurb && <p className="libref-lead">{concept.blurb}</p>}
            {concept.aliases.length > 0 && (
              <p className="libref-aliases">又称 {concept.aliases.join("、")}</p>
            )}
            {related.length > 0 && (
              <section className="libref-detail-section">
                <h4>库内实现</h4>
                <div className="libref-related">
                  {related.slice(0, 6).map((item) => (
                    <button key={item.slug} data-select={item.slug} onClick={() => choose(idOfScript(item))}>
                      <Thumb src={item.imageUrl} alt={item.name} />
                      <span>{item.name}</span>
                      <Icon name="arrow" size={13} />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
          {related.length > 1 && (
            <div className="libref-detail-actions">
              <button
                className="libref-primary"
                onClick={() => {
                  setModeAndReset("scripts");
                  setFamily(concept.family);
                }}
              >
                浏览 {related.length} 个指标
              </button>
            </div>
          )}
        </>
      );
    }

    if (!selected?.item) {
      return (
        <div className="libref-detail-body">
          <p className="libref-detail-empty">
            将指针移到指标上即可查看说明。
          </p>
        </div>
      );
    }

    if (selected.kind === "native") {
      const item = selected.item as NativeItem;
      const id = idOfNative(item);
      return (
        <>
          <div className="libref-detail-body">
            <button className="libref-back" onClick={() => setDetailOpen(false)}>
              <Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />
              返回
            </button>
            <p className="libref-eyebrow">
              内置 · {item.section}
            </p>
            <h3>{item.title}</h3>
            {item.english && item.english !== item.title && (
              <p className="libref-english">{item.english}</p>
            )}
            <p className="libref-lead">{item.description}</p>
            <dl className="libref-facts">
              <div>
                <dt>位置</dt>
                <dd>{item.overlay ? "主图叠加" : "独立副图"}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>Vela 内置</dd>
              </div>
              <div>
                <dt>实例</dt>
                <dd>
                  {added.get(item.type)?.length
                    ? `图表中 ${added.get(item.type)!.length} 个`
                    : "尚未添加"}
                </dd>
              </div>
            </dl>
            {!item.supported && (
              <p className="libref-notice">
                当前品种不可用，请切换到支持的标的后再添加。
              </p>
            )}
          </div>
          <div className="libref-detail-actions">
            <button
              className="libref-primary"
              disabled={!canAdd}
              onClick={() => requestAdd(id)}
            >
              {selectedCount && !item.multiInstance
                ? "再添加一个"
                : added.has(item.type)
                  ? "再添加一组"
                  : "添加到图表"}
              {canAdd && <kbd>↵</kbd>}
            </button>
            <div className="libref-secondary">
              <button
                aria-pressed={favorites.has(id)}
                onClick={() => toggleFavorite(id)}
              >
                <Icon name="star" size={13} filled={favorites.has(id)} />
                {favorites.has(id) ? "已收藏" : "收藏"}
              </button>
              <button disabled title="在当前工作区不可用，请在托管图表中咨询 Quant">
                咨询 Quant
              </button>
            </div>
          </div>
        </>
      );
    }

    const item = selected.item as LibIndicator;
    const id = idOfScript(item);
    const native = nativeFor(item, natives);
    const onChart = native ? !!added.get(native.type)?.length : false;
    return (
      <>
        <div className="libref-detail-body">
          <button className="libref-back" onClick={() => setDetailOpen(false)}>
            <Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />
            返回
          </button>
          <Thumb src={item.imageUrl} alt={item.name} big />
          <p className="libref-eyebrow">
            {familyLabel(item.family)}
            {item.date ? ` · ${dateLabel(item.date)}` : ""}
          </p>
          <h3>{item.name}</h3>
          <p className="libref-description">{item.description}</p>
          {item.tags.length > 0 && (
            <div className="libref-tags">
              {item.tags.slice(0, 5).map((tag) => (
                <span className="libref-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          )}
          {native && (
            <p className="libref-bridge">
              <Icon name="check" size={12} />
              将添加图表内置的「{native.title}」。
            </p>
          )}
          {!native && (
            <p className="libref-notice">
              这是 LuxAlgo 指标库脚本，运行在托管 Library 引擎中；请前往 LuxAlgo 将其添加到图表。
            </p>
          )}
          <a
            className="libref-library-link"
            href={libraryUrl(item.slug)}
            target="_blank"
            rel="noreferrer"
          >
            在 LuxAlgo 指标库中查看
            <Icon name="arrow" size={12} />
          </a>
        </div>
        <div className="libref-detail-actions">
          {native ? (
            <button
              className="libref-primary"
              disabled={!native.supported || (onChart && !native.multiInstance)}
              onClick={() => requestAdd(id)}
            >
              {onChart && !native.multiInstance ? "已在图表" : "添加到图表"}
              {(!onChart || native.multiInstance) && <kbd>↵</kbd>}
            </button>
          ) : (
            <a className="libref-primary" href={libraryUrl(item.slug)} target="_blank" rel="noreferrer">
              在 LuxAlgo 指标库中查看
              <Icon name="arrow" size={13} />
            </a>
          )}
          <div className="libref-secondary">
            <button
              aria-pressed={favorites.has(id)}
              onClick={() => toggleFavorite(id)}
            >
              <Icon name="star" size={13} filled={favorites.has(id)} />
              {favorites.has(id) ? "已收藏" : "收藏"}
            </button>
            <button disabled title="在当前工作区不可用，请在托管图表中咨询 Quant">
              咨询 Quant
            </button>
          </div>
        </div>
      </>
    );
  }

  const title =
    mode === "scripts"
      ? "全部指标"
      : mode === "family"
        ? familyLabel(family)
        : mode === "basic"
          ? "基础指标"
          : mode === "orderflow"
            ? "订单流"
            : mode === "concepts"
              ? "概念"
              : mode === "favorites"
                ? "我的收藏"
                : mode === "myscripts"
                  ? "我的脚本"
                  : "发现";

  const renderResults = () => {
    if (mode === "bring" && !isSearching) {
      return (
        <div className="libref-bring">
          <h2>导入脚本</h2>
          <p>
            在 TradingView 中打开 Pine 编辑器，全选并复制你的脚本，然后粘贴到这里。
          </p>
          <label htmlFor="libref-bring-code">Pine Script®</label>
          <textarea
            id="libref-bring-code"
            spellCheck={false}
            value={bringCode}
            onChange={(event) => setBringCode(event.target.value)}
            placeholder={'//@version=6\nindicator("My script", overlay = true)'}
          />
          <button className="libref-primary" disabled title="Pine 执行环境位于 vela.luxalgo.com">
            添加到图表
          </button>
          <p className="libref-bring-note">
            Pine 脚本运行在托管 LuxAlgo 引擎中。当前工作区通过原生控件添加图表内置与
            Library 关联的指标。
          </p>
          <a
            className="libref-library-link"
            href="https://vela.luxalgo.com/chart"
            target="_blank"
            rel="noreferrer"
          >
            打开托管图表 <Icon name="arrow" size={12} />
          </a>
        </div>
      );
    }

    if (mode === "myscripts" && !isSearching) {
      return (
        <div className="libref-empty">
          <Icon name="layers" size={28} />
          <h3>暂无个人脚本</h3>
          <p>
            个人 Pine 脚本保存在托管 LuxAlgo 图表中。原生图表可运行的指标都可在
            「基础指标」中找到。
          </p>
          <button className="libref-text-button" onClick={() => setModeAndReset("basic")}>
            浏览内置指标
          </button>
        </div>
      );
    }

    if (isSearching) {
      const total = builtins.length + library.length + concepts.length;
      if (!total)
        return (
          <div className="libref-empty">
            <Icon name="search" size={28} />
            <h3>没有与“{query.trim()}”匹配的结果</h3>
            <p>试试指标名称、概念或别名。</p>
          </div>
        );
      return (
        <>
          {builtins.length > 0 && (
            <>
              <h3 className="libref-group-label">
                内置 <span>{builtins.length}</span>
              </h3>
              {builtins.map(builtinRow)}
            </>
          )}
          {library.length > 0 && (
            <>
              <h3 className="libref-group-label">
                指标库 <span>{library.length}</span>
              </h3>
              {layout === "grid" ? (
                <div className="libref-grid">{shownScripts.map((item) => card(item))}</div>
              ) : (
                shownScripts.map(scriptRow)
              )}
              {library.length > shownScripts.length && (
                <button className="libref-more" onClick={() => setLimit((value) => value + 48)}>
                  显示更多 · 已显示 {shownScripts.length} / {library.length}
                </button>
              )}
            </>
          )}
          {concepts.length > 0 && (
            <>
              <h3 className="libref-group-label">
                概念 <span>{concepts.length}</span>
              </h3>
              {shownConcepts.map(conceptRow)}
            </>
          )}
        </>
      );
    }

    if (mode === "discover") {
      return (
        <>
          <SectionHead
            title="最新发布"
            action="查看全部"
            onAction={() => setModeAndReset("scripts")}
          />
          <div className="libref-grid is-three">
            {latest.map((item, index) => card(item, "新", index < 3))}
          </div>
          <SectionHead
            title="更多探索"
            action="换一批"
            onAction={() => setSeed((value) => value + 1)}
          />
          <div className="libref-grid is-three">{picks.map((item, index) => card(item, undefined, index < 6))}</div>
          <SectionHead title="分类" />
          <div className="libref-families">
            {FAMILIES.map((entry) => (
              <button
                key={entry.key}
                className="libref-family-tile"
                onClick={() => selectFamily(entry.key)}
              >
                <Icon name={FAMILY_ICON[entry.key] ?? "layers"} size={16} />
                <span>
                  <strong>{FAMILY_ZH[entry.key] ?? entry.pillLabel}</strong>
                  <small>{familyCounts.get(entry.key) ?? 0} 个指标</small>
                </span>
              </button>
            ))}
          </div>
        </>
      );
    }

    if (mode === "favorites") {
      if (!favoriteNatives.length && !favoriteScripts.length)
        return (
          <div className="libref-empty">
            <Icon name="star" size={28} />
            <h3>还没有收藏</h3>
            <p>点亮指标上的星标，下次就能在这里快速找到。</p>
          </div>
        );
      return (
        <>
          {favoriteNatives.length > 0 && (
            <>
              <h3 className="libref-group-label">
                内置 <span>{favoriteNatives.length}</span>
              </h3>
              {favoriteNatives.map(builtinRow)}
            </>
          )}
          {favoriteScripts.length > 0 && (
            <>
              <h3 className="libref-group-label">
                指标库 <span>{favoriteScripts.length}</span>
              </h3>
              {layout === "grid" ? (
                <div className="libref-grid">{favoriteScripts.map((item) => card(item))}</div>
              ) : (
                favoriteScripts.map(scriptRow)
              )}
            </>
          )}
        </>
      );
    }

    if (mode === "concepts" || (mode === "family" && concepts.length && !library.length)) {
      return (
        <>
          {shownConcepts.map(conceptRow)}
          {concepts.length > shownConcepts.length && (
            <button
              className="libref-more"
              onClick={() => setConceptLimit((value) => value + 120)}
            >
              显示更多 · 已显示 {shownConcepts.length} / {concepts.length}
            </button>
          )}
        </>
      );
    }

    if (mode === "basic" || mode === "orderflow") {
      const sections = [...new Set(builtins.map((item) => item.section))];
      return (
        <>
          {sections.map((section) => (
            <section className="libref-builtin-section" key={section} aria-label={section}>
              <h3>{section}</h3>
              {builtins.filter((item) => item.section === section).map(builtinRow)}
            </section>
          ))}
          {!builtins.length && (
            <div className="libref-empty">
              <p>当前视图没有匹配的内置指标。</p>
            </div>
          )}
        </>
      );
    }

    return (
      <>
        {layout === "grid" ? (
          <div className="libref-grid">{shownScripts.map((item) => card(item))}</div>
        ) : (
          shownScripts.map(scriptRow)
        )}
        {library.length > shownScripts.length && (
          <button className="libref-more" onClick={() => setLimit((value) => value + 48)}>
            显示更多 · 已显示 {shownScripts.length} / {library.length}
          </button>
        )}
        {!shownScripts.length && (
          <div className="libref-empty">
            <Icon name="search" size={28} />
            <h3>当前视图暂无指标</h3>
            <p>试试其他分类，或清空搜索。</p>
          </div>
        )}
      </>
    );
  };

  const showControls = ["scripts", "family", "favorites", "concepts"].includes(mode) && !isSearching;

  return (
    <div className="libref" data-detail-open={detailOpen} data-testid="indicator-library">
      <header className="libref-head">
        <h1>指标库</h1>
        <label className="libref-search">
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(24);
              setDetailOpen(false);
            }}
            placeholder="搜索指标、概念或别名…"
            aria-label="搜索指标"
          />
          {!query && <kbd>/</kbd>}
          {query && (
            <button
              className="libref-clear"
              aria-label="清除搜索"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <button className="libref-close" onClick={onClose} aria-label="关闭指标库" aria-keyshortcuts="Escape">
          <span className="libref-close-hint">Esc</span>
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="libref-workspace">
        <aside className="libref-sidebar" aria-label="指标分类">
          <span className="libref-nav-label">我的</span>
          <button
            className="libref-nav-item"
            data-mode="favorites"
            aria-pressed={mode === "favorites" && !isSearching}
            onClick={() => setModeAndReset("favorites")}
          >
            <Icon name="star" size={15} />
            <span>我的收藏</span>
            <small>{favorites.size || ""}</small>
          </button>
          <button
            className="libref-nav-item"
            data-mode="myscripts"
            aria-pressed={mode === "myscripts" && !isSearching}
            onClick={() => setModeAndReset("myscripts")}
          >
            <Icon name="user" size={15} />
            <span>我的脚本</span>
          </button>
          <button
            className="libref-nav-item"
            data-mode="bring"
            aria-pressed={mode === "bring" && !isSearching}
            onClick={() => setModeAndReset("bring")}
          >
            <Icon name="download" size={15} />
            <span>导入脚本</span>
          </button>

          <span className="libref-nav-label">内置</span>
          <button
            className="libref-nav-item"
            data-mode="basic"
            aria-pressed={mode === "basic" && !isSearching}
            onClick={() => setModeAndReset("basic")}
          >
            <Icon name="trend" size={15} />
            <span>基础指标</span>
            <small>{natives.filter((item) => item.group === "basic").length || ""}</small>
          </button>
          <button
            className="libref-nav-item"
            data-mode="orderflow"
            aria-pressed={mode === "orderflow" && !isSearching}
            onClick={() => setModeAndReset("orderflow")}
          >
            <Icon name="volume" size={15} />
            <span>订单流</span>
            <small>{natives.filter((item) => item.group === "orderflow").length || ""}</small>
          </button>

          <span className="libref-nav-label">指标库</span>
          <button
            className="libref-nav-item"
            data-mode="discover"
            aria-pressed={mode === "discover" && !isSearching}
            onClick={() => setModeAndReset("discover")}
          >
            <Icon name="compass" size={15} />
            <span>发现</span>
          </button>
          <button
            className="libref-nav-item"
            data-mode="scripts"
            aria-pressed={mode === "scripts" && !isSearching}
            onClick={() => setModeAndReset("scripts")}
          >
            <Icon name="grid" size={15} />
            <span>全部指标</span>
            <small>{INDICATORS.length}</small>
          </button>
          <button
            className="libref-nav-item"
            data-mode="concepts"
            aria-pressed={mode === "concepts" && !isSearching}
            onClick={() => setModeAndReset("concepts")}
          >
            <Icon name="layers" size={15} />
            <span>概念</span>
            <small>{CONCEPTS.length}</small>
          </button>

          <span className="libref-nav-label">分类浏览</span>
          {FAMILIES.map((entry) => (
            <button
              key={entry.key}
              className="libref-nav-item"
              data-mode="family"
              data-family={entry.key}
              aria-pressed={mode === "family" && family === entry.key && !isSearching}
              onClick={() => selectFamily(entry.key)}
            >
              <Icon name={FAMILY_ICON[entry.key] ?? "layers"} size={15} />
              <span>{FAMILY_ZH[entry.key] ?? entry.pillLabel}</span>
              <small>{familyCounts.get(entry.key) ?? 0}</small>
            </button>
          ))}
        </aside>

        <main className="libref-catalog">
          {showControls && (
            <div className="libref-catalog-top">
              <div className="libref-top-row">
                <h2>
                  {title}
                  <span>{mode === "concepts" ? CONCEPTS.length : mode === "basic" || mode === "orderflow" ? builtins.length : library.length}</span>
                </h2>
                <div className="libref-controls">
                  <div className="libref-segmented" role="group" aria-label="排序">
                    <button
                      aria-pressed={sort === "recent"}
                      aria-label="最新优先"
                      onClick={() => setSort("recent")}
                    >
                      最新
                    </button>
                    <button
                      aria-pressed={sort === "name"}
                      aria-label="按名称排序"
                      onClick={() => setSort("name")}
                    >
                      名称 A–Z
                    </button>
                  </div>
                  {mode !== "concepts" && (
                    <div className="libref-segmented" role="group" aria-label="布局">
                      <button
                        aria-pressed={layout === "grid"}
                        aria-label="网格"
                        onClick={() => setLayout("grid")}
                      >
                        <Icon name="grid" size={13} />
                      </button>
                      <button
                        aria-pressed={layout === "list"}
                        aria-label="列表"
                        onClick={() => setLayout("list")}
                      >
                        <Icon name="list" size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {mode === "family" && clusters.length > 0 && (
                <div className="libref-chips">
                  <button aria-pressed={!cluster} onClick={() => setCluster(null)}>
                    全部
                  </button>
                  {clusters.map((entry) => (
                    <button
                      key={entry}
                      aria-pressed={cluster === entry}
                      onClick={() => setCluster(entry)}
                    >
                      {clusterLabel(entry)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div
            id="libref-results"
            ref={resultsRef}
            className="libref-results"
            onPointerMove={onPointerMove}
          >
            {error ? (
              <div className="libref-empty">
                <h3>无法加载指标</h3>
                <p>{error}</p>
              </div>
            ) : !natives.length && (mode === "basic" || mode === "orderflow") ? (
              <div className="libref-empty">
                <span className="libref-spinner" />
                <p>正在加载图表的指标目录…</p>
              </div>
            ) : (
              renderResults()
            )}
          </div>
        </main>

        <aside className={`libref-detail${detailOpen ? " is-open" : ""}`} aria-label="指标详情">
          {renderDetail()}
        </aside>
      </div>

      <footer className="libref-foot">
        <div className="libref-shortcuts">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 浏览
          </span>
          <span>
            <kbd>↵</kbd> 添加
          </span>
          <label className="libref-keep-open">
            <input
              type="checkbox"
              checked={keepOpen}
              onChange={(event) => setKeepOpen(event.target.checked)}
            />
            <kbd>⇧</kbd> 添加并保持打开
          </label>
          <span>
            <kbd>F</kbd> 收藏
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
        <span className="libref-status">
          {INDICATORS.length} 个指标 · 最新 {newest}
          {totalAdded > 0 ? ` · 图表中 ${totalAdded} 个` : ""}
        </span>
      </footer>

      <div className={`libref-toast${toast ? " is-shown" : ""}`} role="status">
        {toast}
      </div>
      {conceptSlug && (
        <span hidden data-concept={conceptSlug} />
      )}
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
      className: "pulse-indicator-dialog libref-dialog",
      align: "center",
      flush: true,
      dimBackdrop: true,
      closeOnEscape: false,
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
