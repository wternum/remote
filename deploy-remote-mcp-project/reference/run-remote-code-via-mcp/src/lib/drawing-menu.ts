/**
 * Restyles the native Vela drawing flyouts into the reference-site treatment
 * while keeping every native behaviour: tool arming, favorites, shortcuts and
 * the outside-dismiss listener all stay the library's own code.
 *
 * Structure per reference measurement (274px card, anchor-aligned top, 0 padding,
 * transparent shell + SVG outline path, 34px rows, 24px icon tiles):
 *   flyout
 *   ├── svg.pulse-menu-outline        (fill + edge path, curves around the anchor row)
 *   ├── label.pulse-menu-search       (40px, gradient hairline under it)
 *   ├── div.pulse-menu-scroll         (the only scroll container, items live here)
 *   └── div.pulse-menu-footer         ("17 个工具")
 */
interface Section {
  title: string;
  heading: HTMLElement;
  rows: HTMLButtonElement[];
}

const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="6.6"/><path d="m16.2 16.2 4.3 4.3"/></svg>';

const GAP = 0; // reference card sits flush on the toolbar edge
const CARD_MIN = 240;
const CARD_MAX = 640;

export function enhanceDrawingMenus(host: HTMLElement) {
  const live = new Set<HTMLElement>();
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Keep the card glued to the toolbar edge and to its anchor row. */
  function place(fly: HTMLElement) {
    const toolbar = host.querySelector<HTMLElement>('.vela-dtb:not([data-collapsed="1"])');
    const owner = toolbar?.querySelector<HTMLElement>(".vela-dtb-cell.vela-open");
    const parent = fly.offsetParent as HTMLElement | null;
    if (!toolbar || !owner || !parent) return;
    const rail = toolbar.getBoundingClientRect();
    const anchor = owner.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    const topbar = host.querySelector<HTMLElement>(".vela-widget-topbar");
    const floor = (topbar?.getBoundingClientRect().bottom ?? box.top) - box.top + 6;

    let top = anchor.top - box.top;
    const room = box.height - top - 40;
    if (room < CARD_MIN) top = Math.max(floor, box.height - CARD_MIN - 90);
    top = Math.max(floor, Math.min(top, box.height - 140));

    const height = Math.max(
      CARD_MIN,
      Math.min(CARD_MAX, box.height - top - 34),
    );
    fly.style.left = `${rail.right - box.left + GAP}px`;
    fly.style.top = `${Math.round(top)}px`;
    fly.style.maxHeight = `${Math.round(height)}px`;
    fly.style.setProperty("--pulse-menu-top", `${Math.round(top)}px`);
    fly.style.setProperty("--pulse-anchor-top", `${Math.round(anchor.top - box.top)}px`);
    fly.style.setProperty("--pulse-anchor-h", `${Math.round(anchor.height)}px`);
  }

  /**
   * The reference draws its card as an SVG path whose top-left corner bends
   * around the anchor row, so the card and toolbar read as one surface.
   */
  function drawOutline(fly: HTMLElement) {
    const width = Math.round(fly.getBoundingClientRect().width);
    const top = Number.parseFloat(fly.style.getPropertyValue("--pulse-menu-top")) || 0;
    const height = Math.round(fly.getBoundingClientRect().height);
    const cellTop = Number.parseFloat(fly.style.getPropertyValue("--pulse-anchor-top")) || 0;
    const cellHeight = Number.parseFloat(fly.style.getPropertyValue("--pulse-anchor-h")) || 0;
    // Notch is only drawn when the card actually starts beside the anchor row.
    const notch = Math.abs(cellTop - top) < cellHeight ? cellTop - top : 0;
    const notchBottom = notch + cellHeight;
    const r = 10;
    const notchDepth = notch > 0 ? 14 : 0;

    const path =
      notch > 0
        ? [
            `M ${width} ${notch}`,
            `H ${notchDepth + r}`,
            `Q ${notchDepth} ${notch} ${notchDepth} ${notch + r}`,
            `V ${notchBottom - r}`,
            `Q ${notchDepth} ${notchBottom} ${notchDepth - r} ${notchBottom}`,
            `H 0`,
            `V ${height - r}`,
            `Q 0 ${height} ${r} ${height}`,
            `H ${width - r}`,
            `Q ${width} ${height} ${width} ${height - r}`,
            `V ${notch + r}`,
            `Q ${width} ${notch} ${width} ${notch}`,
            `Z`,
          ].join(" ")
        : [
            `M ${width} 0`,
            `H ${r}`,
            `Q 0 0 0 ${r}`,
            `V ${height - r}`,
            `Q 0 ${height} ${r} ${height}`,
            `H ${width - r}`,
            `Q ${width} ${height} ${width} ${height - r}`,
            "Z",
          ].join(" ");

    let svg = fly.querySelector<SVGSVGElement>(":scope > .pulse-menu-outline");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "pulse-menu-outline");
      svg.setAttribute("aria-hidden", "true");
      const fill = document.createElementNS("http://www.w3.org/2000/svg", "path");
      fill.setAttribute("class", "pulse-menu-fill");
      const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
      edge.setAttribute("class", "pulse-menu-edge");
      svg.append(fill, edge);
      fly.prepend(svg);
    }
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    const [fill, edge] = svg.querySelectorAll("path");
    fill.setAttribute("d", path);
    edge.setAttribute("d", notch > 0 ? path.replace(" Z", "") : path);
  }

  function enhance(fly: HTMLElement) {
    if (fly.querySelector(":scope > .pulse-menu-search")) {
      place(fly);
      return;
    }
    const original = Array.from(fly.children);
    const rows = original.filter(
      (el): el is HTMLButtonElement =>
        el instanceof HTMLButtonElement && el.classList.contains("vela-dtb-item"),
    );
    // The magnet menu keeps its compact native look.
    if (rows.length < 4) return;

    fly.classList.add("pulse-menu");
    live.add(fly);
    // The chevron's cell that owns this card; used to close on tool pick.
    const ownerCell = host.querySelector<HTMLElement>(".vela-dtb-cell.vela-open");
    fly.style.removeProperty("width");
    fly.style.removeProperty("min-width");

    const search = document.createElement("label");
    search.className = "pulse-menu-search";
    const glyph = document.createElement("span");
    glyph.innerHTML = SEARCH_ICON;
    const input = document.createElement("input");
    input.placeholder = "搜索工具...";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "搜索绘图工具");
    search.append(glyph, input);

    const scroll = document.createElement("div");
    scroll.className = "pulse-menu-scroll";
    scroll.setAttribute("role", "group");
    scroll.setAttribute("aria-label", "绘图工具");

    const sections: Section[] = [];
    let section: Section | undefined;
    for (const child of original) {
      if (child instanceof HTMLButtonElement) {
        if (!section) {
          const heading = document.createElement("div");
          section = { title: "工具", heading, rows: [] };
          sections.push(section);
          scroll.append(heading);
        }
        section.rows.push(child);
        scroll.append(child);
        // Reference behaviour: picking a tool closes the card (capture-phase listener,
        // so it runs before the library's own arming logic and cannot be swallowed).
        child.addEventListener(
          "click",
          () => {
            const leaving = fly.classList.contains("pulse-menu-leaving");
            fly.classList.add("pulse-menu-leaving");
            window.setTimeout(
              () => {
                fly.classList.remove("pulse-menu-leaving");
                ownerCell?.querySelector<HTMLButtonElement>(".vela-dtb-arrow")?.click();
              },
              leaving ? 0 : 145,
            );
          },
          true,
        );
        const hint = child.querySelector<HTMLElement>(".vela-dtb-hint");
        if (hint) {
          // Native hint is a plain string; split it into real <kbd> caps.
          const keys = hint.textContent?.split(/[+\s]+/).filter(Boolean) ?? [];
          hint.replaceChildren(
            ...keys.map((key) => {
              const kbd = document.createElement("kbd");
              kbd.textContent = key;
              return kbd;
            }),
          );
        }
      } else if (child.textContent?.trim()) {
        const heading = document.createElement("div");
        section = { title: child.textContent.trim(), heading, rows: [] };
        sections.push(section);
        scroll.append(heading);
      }
    }

    for (const s of sections) {
      s.heading.className = "pulse-menu-section";
      const name = document.createElement("span");
      const rule = document.createElement("i");
      const count = document.createElement("span");
      count.className = "pulse-menu-count";
      name.textContent = s.title;
      count.textContent = String(s.rows.length);
      s.heading.append(name, rule, count);
    }

    const footer = document.createElement("div");
    footer.className = "pulse-menu-footer";
    footer.textContent = `${rows.length} 个工具`;

    const empty = document.createElement("p");
    empty.className = "pulse-menu-empty";
    empty.textContent = "没有匹配的工具";
    empty.hidden = true;
    scroll.append(empty);

    fly.replaceChildren(search, scroll, footer);
    drawOutline(fly);

    input.addEventListener("input", () => {
      const query = input.value.trim().toLocaleLowerCase();
      let matches = 0;
      for (const s of sections) {
        let visible = 0;
        for (const row of s.rows) {
          const show = (row.getAttribute("aria-label") ?? "")
            .toLocaleLowerCase()
            .includes(query);
          row.hidden = !show;
          if (show) visible++;
        }
        s.heading.hidden = visible === 0;
        s.heading.querySelector(".pulse-menu-count")!.textContent = String(visible);
        matches += visible;
      }
      empty.hidden = matches > 0;
      footer.textContent = query
        ? `${matches} / ${rows.length} 个工具`
        : `${rows.length} 个工具`;
      scroll.scrollTop = 0;
      place(fly);
    });

    // Rolling highlight that follows the pointer between rows (reference behaviour).
    scroll.addEventListener("pointermove", (event) => {
      const row = (event.target as Element | null)?.closest<HTMLElement>(".vela-dtb-item");
      const box = scroll.getBoundingClientRect();
      if (!row) {
        scroll.removeAttribute("data-pulse-hover");
        return;
      }
      const rect = row.getBoundingClientRect();
      const previous = Number.parseFloat(scroll.style.getPropertyValue("--pulse-hover-y"));
      const next = rect.top - box.top;
      // Only glide once the highlight is already visible; the first appearance pops in.
      if (Number.isFinite(previous) && previous > 0) scroll.dataset.pulseHover = "moving";
      else scroll.dataset.pulseHover = "1";
      scroll.style.setProperty("--pulse-hover-x", `${rect.left - box.left}px`);
      scroll.style.setProperty("--pulse-hover-y", `${next}px`);
      scroll.style.setProperty("--pulse-hover-w", `${rect.width}px`);
      scroll.style.setProperty("--pulse-hover-h", `${rect.height}px`);
    });
    scroll.addEventListener("pointerleave", () => {
      scroll.removeAttribute("data-pulse-hover");
    });

    place(fly);
  }

  const observer = new MutationObserver((records) => {
    let touched = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.classList.contains("vela-dtb-flyout")) {
          enhance(node);
          touched = true;
        }
        node.querySelectorAll<HTMLElement>(".vela-dtb-flyout").forEach((fly) => {
          enhance(fly);
          touched = true;
        });
      }
    }
    for (const fly of live) if (!fly.isConnected) live.delete(fly);
    if (touched) requestAnimationFrame(() => live.forEach(place));
  });
  observer.observe(host, { childList: true, subtree: true });

  /** Hover a group long enough and its chevron opens by itself. */
  function pointerOver(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest<HTMLElement>(".vela-dtb-cell");
    const onCard = !!target?.closest(".pulse-menu");
    // Only an intentional return to the toolbar or the card cancels a pending close;
    // stray pointerover events from the shell's own chrome must not keep it open.
    if (cell || onCard) clearTimeout(closeTimer);
    if (!cell || cell.contains(event.relatedTarget as Node | null)) return;
    clearTimeout(hoverTimer);
    const arrow = cell.querySelector<HTMLButtonElement>(".vela-dtb-arrow");
    if (!arrow || cell.classList.contains("vela-open")) return;
    hoverTimer = setTimeout(() => {
      if (cell.matches(":hover")) arrow.click();
    }, 170);
  }

  function pointerOut(event: PointerEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".vela-dtb, .pulse-menu")) return;
    closeTimer = setTimeout(() => {
      const open = host.querySelector<HTMLElement>(".vela-dtb-cell.vela-open");
      const fly = host.querySelector<HTMLElement>(".pulse-menu");
      // The card's SVG shell extends past its box, so :hover on the flyout is
      // unreliable — hit-test the pointer against the search/scroll/footer instead.
      const overCard =
        fly?.querySelectorAll<HTMLElement>(".pulse-menu-search, .pulse-menu-scroll, .pulse-menu-footer");
      const pointerOnCard = overCard
        ? Array.from(overCard).some((part) => part.matches(":hover"))
        : false;
      if (open && fly && !open.matches(":hover") && !pointerOnCard && !fly.contains(document.activeElement)) {
        // Play the reference's exit wipe before the library removes the card.
        fly.classList.add("pulse-menu-leaving");
        setTimeout(() => {
          open.querySelector<HTMLButtonElement>(".vela-dtb-arrow")?.click();
        }, 150);
      }
    }, 320);
  }

  function escape(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    const arrow = host.querySelector<HTMLButtonElement>(
      ".vela-dtb-cell.vela-open .vela-dtb-arrow",
    );
    if (!arrow) return;
    host.querySelector<HTMLElement>(".pulse-menu")?.classList.add("pulse-menu-leaving");
    setTimeout(() => arrow.click(), 140);
  }

  const placeAll = () => live.forEach((fly) => place(fly));
  host.addEventListener("pointerover", pointerOver);
  host.addEventListener("pointerout", pointerOut);
  document.addEventListener("keydown", escape);
  window.addEventListener("resize", placeAll);
  window.addEventListener("scroll", placeAll, true);

  return () => {
    clearTimeout(hoverTimer);
    clearTimeout(closeTimer);
    observer.disconnect();
    host.removeEventListener("pointerover", pointerOver);
    host.removeEventListener("pointerout", pointerOut);
    document.removeEventListener("keydown", escape);
    window.removeEventListener("resize", placeAll);
    window.removeEventListener("scroll", placeAll, true);
  };
}
