# Toolbar Verification

The drawing toolbar uses Vela's native controls and drawing actions. Its visual shell is scoped in `src/vela/drawing-toolbar.css`; menu geometry and keyboard handling are in `src/lib/drawing-menu.ts`.

The reference was measured in a browser at `https://vela.luxalgo.com/chart`: a 52px rail, 38px rows, 32px active targets, 20px glyphs, and a menu attached at the rail's right border. The SVG outline returns to the rail at both ends. The rest of the chart and the indicator library are not restyled.

## Run

1. Install browser dependencies with `npx playwright install --with-deps chromium`.
2. Start the application with `npm run dev -- --host 0.0.0.0 --port 5173`.
3. Run `node tests/drawing-toolbar.browser.mjs`.

To test the production build, run `npm run build`, start `npm run preview -- --host 0.0.0.0 --port 4173`, then run `TEST_URL=http://localhost:4173/ node tests/drawing-toolbar.browser.mjs`.

The toolbar checks cover geometry, native favorites, search, keyboard selection, hover and click dismissal, every tool group, scrolling, collapse, real drawing placement and undo, measurement and eraser modes, reduced motion, and 125 percent display scaling.

## Indicator library

`tests/library.browser.mjs` covers the reference three-column geometry, Chinese labels and navigation padding, thumbnails, hover preview, favorites, sorting/layout/pagination across 801 scripts, family and cluster browsing, highlighted search, native indicator insertion, concepts, keyboard shortcuts, the slide-over detail, the mobile header, and browser errors.