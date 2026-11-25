const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../web/app.js"), "utf8");
const elements = new Map(), requests = [];
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    value: "", innerHTML: "", textContent: "", open: false, scrollTop: 300, attributes: {}, listeners: {},
    reportValidity() { return true; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    showModal() { this.open = true; },
    close() { this.open = false; this.listeners.close?.(); },
  });
  return elements.get(id);
};
const context = vm.createContext({
  URLSearchParams, $: element, icons: {search: "", calendar: ""},
  state: {tab: "stock", selectedStock: {code: "002642", name: "荣联科技"}, boards: "3", excludeST: true,
    relationExcludeST: true, meta: {latest_date: "2026-11-23", query_dates: ["2026-07-27", "2026-07-28", "2026-07-29"],
      tag_hierarchy: [{name: "光伏", parent: "新能源"}]}, requests: {}},
  renderCompetitionRounds: () => "",
  request: (url, channel) => new Promise((resolve, reject) => requests.push({url, channel, resolve, reject})),
});
const load = (from, to) => vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to)), context);
load("function escapeHTML", "function debounce");
load("function emptyHTML", "async function request");
load("function stockTags", "function renderTagEditor");
load("function renderStockCycles", "function containRelationWheel");
load("function handleRelationClick", "async function restoreFromURL");
const target = {code: "002642", name: "荣联科技"};
const cycles = [{start: "2026-07-28", end: "2026-07-29", boards: 2, start_known: true},
  {start: "2026-07-27", end: "2026-07-27", boards: 3, start_known: false}];
const cycleHTML = context.renderStockCycles({cycles});
assert.equal((cycleHTML.match(/>当天梯队数据<\/button>/g) || []).length, 2, "every cycle has its own button");
assert.ok(cycleHTML.includes('data-cycle-day="2026-07-28" data-cycle-start-known="1"'));
assert.ok(cycleHTML.includes('data-cycle-day="2026-07-27" data-cycle-start-known="0"'));
const row = (code, boards, first_time, extra = {}) => ({code, name: `样本${code}`, boards, first_time,
  date: "2026-07-28", initials: "yb", registered_province: "江苏省", tags: ["新能源", "光伏"], ...extra});
const rows = [row("000003", 1, "09:40:00"), row("000002", 3, "09:35:00"),
  row("000001", 3, "09:25:00", {blacklisted: true, has_convertible_bond: true, name: "测试<&股", note: "完整备注首行\n" + "详细内容".repeat(80)}),
  row("000004", 3, null)];
const before = JSON.stringify(rows);
context.state.latestLimitUps = new Map([["000001", 2], ["000003", 1]]);
const result = element("cycle-day-results"), date = element("cycle-day-date");
(async () => {
  const pending = context.openCycleDayDialog("2026-07-28");
  assert.equal(element("cycle-day-dialog").open, true);
  assert.equal(date.value, "2026-07-28", "defaults to the first-board day, not the parent query day or cycle end");
  assert.ok(element("cycle-day-context").textContent.includes("默认首板日：2026.07.28"));
  assert.equal(result.attributes["aria-busy"], "true");
  assert.ok(result.innerHTML.includes("正在加载"));
  assert.equal(requests[0].url, "/api/date?date=2026-07-28", "the full ladder does not inherit ST, height or relationship filters");
  assert.equal(requests[0].channel, "cycle-day");
  requests[0].resolve({rows, data_status: "ok", suspended_rows: [row("999999", 8, "09:25:00")]});
  await pending;
  assert.equal(result.attributes["aria-busy"], "false");
  assert.deepEqual([...result.innerHTML.matchAll(/data-card-code="(\d+)"/g)].map(match => match[1]),
    ["000001", "000002", "000004", "000003"], "height descending, then first seal ascending; unknown times last");
  assert.ok(result.innerHTML.indexOf('aria-label="3板股票"') < result.innerHTML.indexOf('aria-label="首板股票"'));
  assert.ok(!result.innerHTML.includes("999999"), "suspended leaders are not today's limit-up stocks");
  const cards = [...result.innerHTML.matchAll(/<li class="industry-stock [\s\S]*?<\/li>/g)].map(match => match[0]);
  assert.ok(cards[0].includes("latest-limit-up blacklisted-stock") && cards[3].includes("latest-limit-up"), "today's limit-ups are distinguished, including blacklisted stocks");
  assert.ok(cards[0].includes('title="最新交易日 2026.11.23 涨停 · 2 板"') && cards[0].includes(">11.23 涨停</span>"), "the badge identifies today's date and board count rather than the historical day's height");
  assert.ok(!cards[1].includes("latest-limit-up") && !cards[1].includes("latest-limit-badge"), "ordinary historical stocks do not receive today's marker");
  assert.ok(result.innerHTML.includes('href="?date=2026-07-28&amp;code=000001" target="_blank" rel="noopener noreferrer"'));
  assert.ok(!result.innerHTML.includes("data-stock-code=") && !result.innerHTML.includes("data-edit-stock-"), "modal links bypass in-page navigation and cards are read-only");
  for (const text of ["测试&lt;&amp;股", "新能源 / 光伏", "黑名单", "stock-bond-badge", "江苏", ">YB</span>", rows[2].note]) {
    assert.ok(result.innerHTML.includes(text), `complete card metadata: ${text.slice(0, 25)}`);
  }
  assert.equal(JSON.stringify(rows), before, "sorting does not mutate stored records");
  assert.equal(context.state.tab, "stock");
  assert.deepEqual({...context.state.selectedStock}, target);
  assert.equal(context.state.boards, "3");
  assert.equal(context.state.relationExcludeST, true, "opening the day does not change parent state");

  const old = context.loadCycleDay();
  date.value = "2026-07-29";
  const current = context.loadCycleDay();
  requests[2].resolve({rows: [], data_status: "ok"}); await current;
  const currentHTML = result.innerHTML;
  requests[1].resolve({rows}); await old;
  assert.equal(result.innerHTML, currentHTML, "a previous date cannot replace the current date");
  assert.ok(currentHTML.includes("当日暂无涨停记录"));
  assert.equal(element("cycle-day-next").disabled, true);
  const missing = context.loadCycleDay();
  requests[3].resolve({rows: [], data_status: "missing", coverage_note: "资料缺失"}); await missing;
  assert.ok(result.innerHTML.includes("当日数据尚未收录") && result.innerHTML.includes("资料缺失"));
  const failed = context.loadCycleDay();
  requests[4].reject(new Error("读取<&失败")); await failed;
  assert.ok(result.innerHTML.includes("data-cycle-day-retry") && result.innerHTML.includes("读取&lt;&amp;失败"));
  result.listeners.click({target: {closest: () => ({})}});
  requests[5].resolve({rows, provisional: true}); await new Promise(resolve => setImmediate(resolve));
  assert.ok(element("cycle-day-status").textContent.includes("盘中暂定涨停 4 只"));
  element("cycle-day-prev").listeners.click();
  assert.equal(date.value, "2026-07-28");
  requests[6].resolve({rows}); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.scrollTop, 0, "date changes begin at the top of the ladder");
  let aborted = 0;
  context.state.requests["cycle-day"] = {abort() { aborted++; }};
  const closing = context.loadCycleDay();
  element("close-cycle-day").listeners.click();
  requests[7].resolve({rows: []}); await closing;
  assert.equal(aborted, 1, "closing cancels pending work");
  assert.ok(!result.innerHTML.includes("当日暂无涨停记录"), "closed modal ignores a late response");

  context.state.relationships = null;
  context.handleRelationClick({target: {closest: selector => selector === "[data-cycle-day]"
    ? {dataset: {cycleDay: "2026-07-27", cycleStartKnown: "0"}} : null}});
  assert.equal(date.value, "2026-07-27", "cycle button works independently of relationship loading");
  assert.ok(element("cycle-day-context").textContent.includes("首板日期未完整收录"));
  assert.equal(element("cycle-day-prev").disabled, true);
  requests[8].resolve({rows: []}); await new Promise(resolve => setImmediate(resolve));
  console.log("Historical cycle day modal: full ladder, ordering, complete cards, new-tab links, date navigation and loading states passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
