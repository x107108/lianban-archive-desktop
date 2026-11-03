// Daily sector leaders take precedence over global tag popularity and first-board counts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../web/app.js"), "utf8");
const context = vm.createContext({state: {grouping: "industry", meta: {
  latest_date: "2026-10-22", tag_order: ["首板大", "低位大", "领涨乙", "领涨甲", "领涨独立", "二板", "首板小"],
}}});
vm.runInContext(source.slice(source.indexOf("function escapeHTML"), source.indexOf("function debounce")), context);
vm.runInContext(source.slice(source.indexOf("function stockTags"), source.indexOf("function renderTagEditor")), context);
let code = 0;
const stock = (boards, tags) => ({code: String(++code).padStart(6, "0"), name: `样本${code}`, boards, tags,
  date: "2026-10-22", registered_province: "北京"});
const leaderA = stock(5, ["领涨甲"]), leaderB = stock(5, ["领涨乙"]);
const shared = stock(1, ["领涨甲", "领涨乙", "领涨甲"]), followerA = stock(2, ["领涨甲"]);
const rows = [leaderA, leaderB, shared, followerA, stock(5, ["领涨独立"]), stock(3, ["低位大"]),
  ...Array.from({length: 6}, () => stock(1, ["低位大"])), stock(2, ["二板"]),
  ...Array.from({length: 8}, () => stock(1, ["首板大"])),
  ...Array.from({length: 4}, () => stock(1, ["首板小"]))];
const before = JSON.stringify(rows);
const counts = context.industryTagBoardCounts(rows), countsBefore = JSON.stringify(counts);
const headers = html => [...html.matchAll(/data-group-label="([^"]+)"/g)].map(match => match[1]);
const cell = (html, height, tag) => html.split(`data-board-height="${height}"`)[1]
  .split(`data-group-label="${tag}"`)[1].split('<section class="matrix-cell')[0];
const occurrences = (html, row) => (html.match(new RegExp(`data-card-code="${row.code}"`, "g")) || []).length;
const expected = ["领涨甲", "领涨乙", "领涨独立", "低位大", "二板", "首板大", "首板小"];
const full = context.renderIndustryColumns(rows, counts);
assert.deepEqual(headers(full), [5, 3, 2, 1].flatMap(() => expected),
  "all height rows share leader-height-first, daily-count-second columns, with first-board-only sectors last");
assert.equal(occurrences(cell(full, 5, "领涨甲"), leaderA), 1);
assert.equal(occurrences(cell(full, 5, "领涨乙"), leaderB), 1);
assert.equal(occurrences(cell(full, 2, "领涨甲"), followerA), 1, "lower board followers align under their sector leader");
for (const tag of ["领涨甲", "领涨乙"]) assert.equal(occurrences(cell(full, 1, tag), shared), 1,
  "a shared first-board follower appears once below each matching leader");
assert.deepEqual(headers(context.renderIndustryColumns(rows)), headers(full), "full-day inference and supplied counts agree");
const first = context.renderIndustryColumns(rows.filter(row => row.boards === 1), counts);
assert.deepEqual(headers(first), ["领涨甲", "领涨乙", "低位大", "首板大", "首板小"],
  "selecting first boards retains hidden leaders and full-day counts rather than ranking visible first-board counts");
assert.equal(occurrences(first, leaderA), 0, "ranking context cannot reintroduce a hidden height's stock");
const five = context.renderIndustryColumns(rows.filter(row => row.boards === 5), counts);
assert.deepEqual(headers(five), ["领涨甲", "领涨乙", "领涨独立"], "same-height leaders use full-day follower counts and independent leaders retain their own concept columns");
const comparison = html => html.split('<div class="board-comparison"')[1];
assert.equal(comparison(context.renderIndustryColumns([...rows].reverse(), counts)), comparison(full),
  "input order cannot change sector positions or card ordering");
assert.equal(JSON.stringify(rows), before, "sector ordering never changes source or custom tag arrays");
assert.equal(JSON.stringify(counts), countsBefore, "full-day context is read-only");
context.state.meta.tag_order = ["领涨乙", "领涨甲"];
const tie = [stock(5, ["领涨甲"]), stock(1, ["领涨甲"]), stock(5, ["领涨乙"]), stock(1, ["领涨乙"])];
assert.deepEqual(headers(context.renderIndustryColumns(tie)).slice(0, 2), ["领涨乙", "领涨甲"],
  "global tag order is only a stable fallback for equal daily heights and counts");
context.state.grouping = "region";
const regions = [{...leaderA, registered_province: "上海"}, {...shared, registered_province: "北京"}];
assert.deepEqual(headers(context.renderIndustryColumns(regions, counts)).slice(0, 2), ["上海", "北京"],
  "region mode uses its own stocks rather than concept-tag context");
console.log("Daily industry leader hierarchy, follower counts and alignment, first-board-only priority, board filters and stable ties: passed.");
