// BoardUI always mounts and preserves the application hooks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root,"web/index.html"),"utf8");
const script = fs.readFileSync(path.join(root,"web/ui-theme.js"),"utf8");
const parts = JSON.parse(script.match(/const uiParts = (.+);\r?\n/)[1]);
const ids = markup => [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids(html).length, new Set(ids(html)).size, "Page IDs must be unique");
assert.ok(html.includes('<body class="boardui-preview">'), "BoardUI styles must be active from the initial HTML");
assert.doesNotMatch(html, /ui-theme-control|data-ui-mode|lianban\.ui-mode/);
assert.ok(html.indexOf('/ui-theme.js?') < html.indexOf('/app.js?'), "UI must initialize before application bindings");
assert.deepEqual([...parts.stats.matchAll(/data-stat="([^"]+)"/g)].map(m=>m[1]), ["total","max_boards","consecutive","first_boards"]);
assert.deepEqual([...parts.stockStats.matchAll(/data-stat="([^"]+)"/g)].map(m=>m[1]), ["limit_days","max_boards","cycles"]);
assert.ok(parts.buttons.find(item=>item.id==="stock-query-button").html.includes('type="submit"'));

const replacements = new Map();
const inserted = [];
const nodes = new Map(ids(html).map(id => [id, {
  set outerHTML(markup) { replacements.set(id, markup); },
  insertAdjacentHTML(position, markup) { inserted.push({id, position, markup}); },
}]));
Object.assign(nodes.get("stock-editor-body"), {nextElementSibling: {children: []}, addEventListener() {}});
vm.runInNewContext(script, {
  document: {
    documentElement: {dataset: {ui: "classic"}},
    getElementById(id) {
      assert.ok(nodes.has(id), `Missing application hook: ${id}`);
      return nodes.get(id);
    },
  },
  get localStorage() { throw new Error("BoardUI must not access the former browser preference"); },
});

assert.equal(replacements.get("date-stats"), parts.stats);
assert.equal(replacements.get("stock-stats"), parts.stockStats);
assert.equal(replacements.size, parts.buttons.length + parts.stockEditorHeadings.length + 2);
for (const [id, markup] of replacements) assert.ok(ids(markup).includes(id));
assert.deepEqual(inserted, [
  {id: "stock-query-form", position: "beforebegin", markup: parts.queryHeading},
  {id: "stock-editor-body", position: "afterend", markup: parts.stockEditorFade},
]);
console.log("Always-on BoardUI and application hooks passed.");
