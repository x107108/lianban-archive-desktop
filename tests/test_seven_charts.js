// A near-zero opening must survive a first-minute surge in seven-board charts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const context = vm.createContext({
  escapeHTML: value => String(value || ""),
  numberValue: (value, digits) => Number(value).toFixed(digits),
});
vm.runInContext(source.slice(source.indexOf("function sevenChartHTML"), source.indexOf("function renderSevenRun")), context);
const day = {
  date: "2026-09-04", previous_close: 14.14, open_price: 14.22,
  points: [[1, 15.50], [2, 15.55], [3, 15.55]],
  interval: 1, minute_source: "通达信历史分时", opening_source: "日行情",
};
const limit = 15.55 / 14.14 - 1;
const pricePath = html => html.match(/class="seven-price" d="([^"]+)"/)[1];
const original = JSON.stringify(day.points);
const chart = context.sevenChartHTML(day, limit);
assert.match(pricePath(chart), /^M4\.00,37\.18 L4\.63,8\.13 L5\.27,7\.00/);
assert.match(chart, /09:30 开盘 14.22 元/);
assert.equal(JSON.stringify(day.points), original, "rendering preserves cached minute samples");
assert.match(pricePath(context.sevenChartHTML({...day, open_price: undefined}, limit)), /^M4\.63,/);
assert.match(pricePath(context.sevenChartHTML({...day, points: [[0, 14.30], ...day.points]}, limit)), /^M4\.00,35\.37/);
assert.match(pricePath(context.sevenChartHTML({...day, points: [[2, 15.55]]}, limit)), /^M4\.00,37\.18 M5\.27,7\.00/);
assert.match(pricePath(context.sevenChartHTML({...day, interval: 5, points: [[5, 15.55]]}, limit)), /^M4\.00,37\.18 L7\.17,7\.00/);
console.log("Seven-board openings, first-minute surges, existing 09:30 samples, gaps and five-minute precision passed.");
