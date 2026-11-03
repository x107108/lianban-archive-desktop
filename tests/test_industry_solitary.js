// A solitary stock's complete tag union must match only itself over the full day.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../web/app.js"), "utf8");
const context = vm.createContext({state: {grouping: "industry", meta: {latest_date: "2026-10-26", tag_order: ["主线", "第二主线", "唯高甲", "唯高乙"]}}});
vm.runInContext(source.slice(source.indexOf("function escapeHTML"), source.indexOf("function debounce")), context);
vm.runInContext(source.slice(source.indexOf("function stockTags"), source.indexOf("function renderTagEditor")), context);
const stock = (code, boards, tags) => ({code, boards, tags, name: `样本${code}`, date: "2026-10-26", registered_province: "北京"});
const rows = [stock("000001", 5, ["主线", "领涨私有"]), stock("000002", 1, ["主线", "唯一甲", "唯一乙"]),
  stock("000003", 1, ["主线", "第二主线"]), stock("000004", 1, ["第二主线", "独有丙"]),
  stock("000005", 1, []), stock("000006", 6, ["唯高甲", "唯高乙"])];
const headers = html => [...html.matchAll(/data-group-label="([^"]+)"/g)].map(match => match[1]);
const occurrences = (html, code) => (html.match(new RegExp(`data-card-code="${code}"`, "g")) || []).length;
const cell = (html, height, label) => html.split(`data-board-height="${height}"`)[1]
  .split(`data-group-label="${label}"`)[1].split('<section class="matrix-cell')[0];
const before = JSON.stringify(rows), counts = context.industryTagBoardCounts(rows), countsBefore = JSON.stringify(counts);
const full = context.renderIndustryColumns(rows, counts);
const columns = headers(full).slice(0, headers(full).length / 3);
assert.deepEqual(headers(full), [6, 5, 1].flatMap(() => columns), "all heights use the same classification columns");
assert.equal(columns.at(-1), "独苗", "first-board solitary remains rightmost");
assert.ok(columns.some(label => label.split(" / ").includes("唯一甲") && label.split(" / ").includes("唯一乙"))
  && columns.includes("独有丙"), "private labels of non-solitary stocks remain normal sector columns");
assert.equal(occurrences(cell(full, 1, "独苗"), "000005"), 1, "untagged stocks retain their existing solitary fallback");
for (const code of ["000002", "000004"]) assert.equal(occurrences(cell(full, 1, "独苗"), code), 0,
  "a stock with any shared label must not also appear in solitary because of its private labels");
assert.equal(occurrences(cell(full, 6, "独苗"), "000006"), 0, "independent consecutive-board stocks never enter solitary");
assert.equal(occurrences(cell(full, 6, "唯高甲"), "000006"), 1, "an independent leader keeps its own concept column");
assert.equal(columns[0], "唯高甲", "the independent highest leader uses normal height-first ordering");
assert.equal(occurrences(full, "000001"), 1, "existing cross-height prioritization still suppresses a leader's unused private tags");
for (const label of ["唯高乙", "未分类"]) {
  assert.ok(!headers(full).includes(label), "an independent leader retains the existing single-concept fallback instead of unused duplicate columns");
}
assert.ok(full.includes('<span class="stock-tag">唯一甲</span>') && full.includes('<span class="stock-tag">唯一乙</span>'),
  "original custom and source labels remain on stock cards");
assert.ok(full.includes('<strong>6</strong> 只股票'), "extra presentations never inflate the underlying stock total");

const first = context.renderIndustryColumns(rows.filter(row => row.boards === 1), counts);
assert.deepEqual(headers(first), columns.filter(label => label !== "唯高甲"));
const five = context.renderIndustryColumns(rows.filter(row => row.boards === 5), counts);
assert.deepEqual(headers(five), ["主线"], "a shared daily tag remains a regular sector when the board filter shows only one of its stocks");
assert.equal(occurrences(first, "000001"), 0);
assert.equal(occurrences(first, "000006"), 0);
assert.equal(JSON.stringify(rows), before);
assert.equal(JSON.stringify(counts), countsBefore);

const sameMembers = [stock("000010", 1, ["共同", "私有甲"]), stock("000011", 1, ["共同", "私有乙"])];
assert.deepEqual(headers(context.renderIndustryColumns(sameMembers)).sort(), ["共同", "私有甲", "私有乙"].sort(),
  "even one shared tag keeps each stock in normal groups despite its other private tags");
const sameHeightPeers = [stock("000020", 5, ["私有先", "同高共享"]), stock("000021", 5, ["同高共享"])];
assert.ok(!headers(context.renderIndustryColumns(sameHeightPeers)).includes("独苗"),
  "classification checks all original labels before higher-board display rules reduce them to one fallback");
const privateOnly = context.renderIndustryColumns([stock("600980", 1, ["3D打印", "稀土永磁"])]);
assert.deepEqual(headers(privateOnly), ["独苗"], "a one-stock cohort now uses solitary instead of a merged private-label column");
assert.equal(occurrences(privateOnly, "600980"), 1);
for (const boards of [2, 3, 5]) {
  const consecutive = context.renderIndustryColumns([stock("600261", boards, ["照明"])]);
  assert.deepEqual(headers(consecutive), ["照明"], `${boards}-board singleton keeps its own concept even without any leaders or followers`);
  assert.equal(occurrences(consecutive, "600261"), 1);
}
const untagged = context.renderIndustryColumns([stock("000030", 2, []), stock("000031", 3, [])]);
assert.ok(!headers(untagged).includes("独苗"), "untagged consecutive-board stocks also cannot enter solitary");
for (const code of ["000030", "000031"]) {
  assert.equal(occurrences(untagged, code), 1);
  assert.ok(headers(untagged).includes(`暂无标签 · 样本${code}`), "untagged leaders have separate stock-named columns");
}
assert.ok(!untagged.includes('data-add-sector-tag='), "stock-named fallback columns are not real concepts");
assert.deepEqual(headers(context.renderIndustryColumns([stock("000012", 1, [])])), ["独苗"], "the old unclassified category is renamed");
const newlyShared = [stock("600980", 1, ["3D打印", "稀土永磁"]), stock("600981", 1, ["3D打印"])];
const regrouped = headers(context.renderIndustryColumns(newlyShared));
assert.ok(regrouped.includes("3D打印") && regrouped.includes("稀土永磁") && !regrouped.includes("独苗"),
  "one newly shared tag moves the entire stock out of solitary, including its still-private other label");
context.state.grouping = "region";
assert.deepEqual(headers(context.renderIndustryColumns(rows)), [6, 5, 1].map(() => "北京"), "region categories do not inherit solitary-tag rules");
console.log("Solitary industry category: complete-stock tag union, any-shared-tag exclusion, pre-display classification, full-day filters, final placement and regrouping: passed.");
