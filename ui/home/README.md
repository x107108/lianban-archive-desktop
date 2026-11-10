# Whole-site BoardUI

The site uses BoardUI `button` and `stat-cards` components from this package. The build renders them to static HTML for the existing application's DOM hooks, requests, keyboard interactions and data. The Python service serves the generated assets directly.

Run `npm ci` followed by `npm run build` in this directory after changing components or styles. Commit the resulting `web/ui-theme.js` and `web/boardui-home.css` with their sources. Tailwind preflight and BoardUI's global page resets are deliberately excluded to preserve the existing application and dialogs. The existing local Chinese font is reused.

`home.css` contains the shared shell and search-page styles. `site.css` extends the same semantic tokens to stock history, competitors, intraday charts and timeline, tag management, the blacklist, dialogs, notes and shareholder popovers. Visual changes are scoped to `body.boardui-preview`. Desktop outer padding remains 24px and phone padding 16px. Below 1000px the intraday list sits above the chart; the stock header scrolls naturally on phones so it does not obscure the history.

The entry HTML enables the shared visual layer on every page. The generated `ui-theme.js` inserts the BoardUI cards and buttons before `app.js` attaches event handlers. The former browser preference is ignored.

The installed stat card source accepts React nodes for values and captions so existing `data-stat` and `date-height-note` hooks remain intact. Optional empty delta chips are omitted: no comparison percentages are invented.

Run `node tests/test_ui_theme.js` to verify that BoardUI starts independently of browser preferences and preserves the application hooks. The deployment tests cover serving and packaging both generated assets. Visual QA screenshots live in the ignored `research/browser-qa/` directory.
