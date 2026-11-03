// Live UI polling must preserve navigation, pending work, series and user state.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map(), requests = [], renders = [], records = [];
function $(id) {
  if (!elements.has(id)) elements.set(id, {value: "", textContent: "", scrollTop: 125, scrollLeft: 88,
    querySelector() {return null;}, querySelectorAll() {return [];}, setAttribute() {}});
  return elements.get(id);
}
const day = "2026-10-27", previous = "2026-10-26";
let clock = 100000, active = 0, maxActive = 0, responder;
const detail = code => ({date: day, stock: {code}, points: [{time: "09:30", price: 11}], fetched_at: `${day}T10:00:00+08:00`});
const context = vm.createContext({$, Date: {now: () => clock}, URLSearchParams,
  document: {activeElement: null}, state: {tab: "intraday", intradayDate: day, intradayCode: "600001", intradayGeneration: 1, minuteStockGeneration: 1,
    minuteDetail: detail("600001"), minuteCompareCodes: ["600002", "600003", "600004", "600005"], minuteComparisons: new Map(), minutePointIndex: 35,
    meta: {live: {enabled: true, today: day}, capabilities: {edit_tags: true}}},
  request: async (...args) => {requests.push(args); return responder(...args);},
  renderMinuteList() {$("minute-stock-list").scrollTop = 0;},
  updateMinuteDateNavigation() {}, updateMinuteTimelineControls() {}, recordMinuteData: data => records.push(data.stock.code),
  renderMinuteStockData: data => renders.push(data.stock.code), showMinutePoint: index => renders.push(index), showMinuteAuctionPoint() {},
  refreshMinuteComparisonChart() {}, loadMinuteTimeline: async () => renders.push("timeline")
});
function load(from, to) {vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to)), context);}
load("async function requestMinuteData", "function recordMinuteData");
load("async function refreshVisibleMinuteData", "function minuteDisplayPoint");
function normalResponder(url, channel, options) {
  if (channel === "minute-live-overview") return {date: day, rows: [], dates: [previous, day]};
  if (url === "/api/intraday/collect") return detail(JSON.parse(options.body).code);
  const code = new URL(url, "http://localhost").searchParams.get("code");
  active++; maxActive = Math.max(maxActive, active);
  return new Promise(done => setImmediate(() => {active--; done({...detail(code), needs_refresh: true});}));
}
(async () => {
  responder = normalResponder;
  await context.refreshVisibleMinuteData();
  assert.equal(records.length, 5, "all selected series update");
  assert.equal(maxActive, 3, "collection concurrency is bounded");
  assert.equal(requests.filter(([url]) => url === "/api/intraday/collect").length, 5);
  assert.equal($("minute-stock-list").scrollTop, 125);
  assert.equal(context.state.minutePointIndex, 35, "hovered time survives automatic refresh");
  assert.ok(renders.includes(35));
  const count = requests.length;
  clock += 59999;
  await context.refreshVisibleMinuteData();
  assert.equal(requests.length, count, "frequent status polls do not restart collection within a minute");
  clock++;
  context.state.intradayDate = previous;
  await context.refreshVisibleMinuteData();
  assert.equal(requests.length, count, "historical dates stay offline during live ticks");
  context.state.intradayDate = day;
  context.state.meta.capabilities.edit_tags = false;
  await context.refreshVisibleMinuteData();
  assert.equal(requests.filter(([url]) => url === "/api/intraday/collect").length, 5, "read-only sessions never collect");

  clock += 60000;
  let finish;
  responder = (url, channel) => channel === "minute-live-overview" ? new Promise(done => finish = done) : normalResponder(url, channel);
  const pending = context.refreshVisibleMinuteData();
  await context.refreshVisibleMinuteData();
  context.state.intradayDate = previous; context.state.intradayGeneration++;
  finish({date: day, rows: [], dates: [day]});
  await pending;
  assert.equal(context.state.intradayDate, previous, "late results cannot reopen the old date");
  assert.equal(context.state.minuteLiveRefreshing, false);

  // Metadata advances the daily query, while stock history remains based on closes.
  const base = {latest_date: previous, dates: [previous], available_start: previous, available_end: previous, coverage: {records: 1}, archive_updated_at: "close"};
  let nextMeta, dateLoads = [], stockLoads = 0;
  Object.assign(context, {renderMeta(meta) {meta.query_dates = [...new Set([...meta.dates, ...(meta.live?.dates || [])])].sort();},
    loadSiteLinks() {}, updateDateNavigation() {}, renderDateStatus() {}, loadDate: options => dateLoads.push(options), loadStock: () => stockLoads++,
    loadIntraday() {}, loadBlacklist() {}, clearTimeout() {}, setTimeout() {}});
  load("async function refreshMeta", "function updateDateNavigation");
  context.state.tab = "date"; context.state.meta = {...base, query_dates: [previous]}; $("trade-date").value = previous;
  nextMeta = {...base, live: {enabled: true, today: day, date: day, dates: [day], fetched_at: "10:00"}};
  responder = () => nextMeta;
  await context.refreshMeta();
  assert.equal($("trade-date").value, day);
  assert.equal(dateLoads.length, 1); assert.equal(dateLoads[0].quiet, true);
  $("trade-date").value = "2026-10-23";
  nextMeta = {...nextMeta, live: {...nextMeta.live, fetched_at: "10:01"}};
  await context.refreshMeta();
  assert.equal($("trade-date").value, "2026-10-23");
  assert.equal(dateLoads.length, 1, "a live tick does not rerender a historical query");
  context.state.tab = "stock";
  nextMeta = {...nextMeta, live: {...nextMeta.live, fetched_at: "10:02"}};
  await context.refreshMeta();
  assert.equal(stockLoads, 0, "provisional updates cannot alter historical competition");
  context.Date = Date;
  context.dateLabel = value => value;
  load("function renderDateStatus", "function updateIndustryNavigation");
  const provisional = {date: day, provisional: true, fetched_at: `${day}T10:02:00+08:00`};
  context.state.meta.live.status = "error";
  context.renderDateStatus(provisional);
  assert.match($("date-subtitle").textContent, /获取于 10:02:00.*每分钟刷新.*获取失败/);
  context.state.meta.live.status = "waiting";
  context.renderDateStatus(provisional);
  assert.match($("date-subtitle").textContent, /来源待更新，保留上次数据/);
  context.renderDateStatus({date: previous, provisional: false});
  assert.ok(!$("date-subtitle").textContent.includes("盘中"), "confirmed dates keep their confirmed label");
  console.log("Minute refresh: 60-second cadence, bounded selected-stock collection, cache retention, scroll/hover preservation, read-only and stale-date guards, latest-date navigation and historical isolation: passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
