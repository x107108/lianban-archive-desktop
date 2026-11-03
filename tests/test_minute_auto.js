const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const day = "2026-10-27", codes = Array.from({length: 8}, (_, i) => String(600001 + i));

function harness({beforePost, freshPrimary = true, editable = true} = {}) {
  let now = Date.parse("2026-10-27T05:21:00Z"), active = 0, peak = 0, renders = 0;
  class Clock extends Date { constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;} }
  const elements = new Map(), posts = [], gets = [], records = [], positions = [];
  const $ = id => {if (!elements.has(id)) elements.set(id, {hidden: false, textContent: "", disabled: false, checked: true, scrollTop: id === "minute-stock-list" ? 123 : 456, querySelector() {return null;}}); return elements.get(id);};
  const detail = code => ({date: day, stock: {code}, status: "partial", points: [{time: "09:30"}], fetched_at: "2026-10-27T13:21:00+08:00"});
  const context = vm.createContext({$, Date: Clock, document: {hidden: false, activeElement: null},
    state: {tab: "intraday", intradayDate: day, intradayGeneration: 1, minuteStockGeneration: 1, intradayCode: codes[0], minuteCompareCodes: [codes[1]], minutePointIndex: 7,
      minuteDetail: detail(codes[0]), minuteComparisons: new Map(), meta: {capabilities: {edit_tags: editable}, live: {enabled: true, polling: true, today: day}}},
    request: async (url, channel, options = {}) => {
      if (channel === "minute-live-overview") return {date: day, rows: codes.concat("600999").map(code => ({code})), total: 9};
      if (options.method === "POST") {
        const body = JSON.parse(options.body); posts.push(body); active++; peak = Math.max(peak, active);
        try {await beforePost?.(body, context); await new Promise(done => setImmediate(done)); return detail(body.code);} finally {active--;}
      }
      const code = new URL(url, "http://localhost").searchParams.get("code"); gets.push(code);
      return {...detail(code), needs_refresh: code !== codes[0] || !freshPrimary};
    },
    loadMinuteTimeline: async options => {assert.equal(options.quiet, true); context.state.minuteTimelineData = {date: day, pool: [...codes, codes[2]].map(code => ({code}))};},
    updateMinuteDateNavigation() {}, renderMinuteList() {$("minute-stock-list").scrollTop = 0;},
    recordMinuteData(data) {records.push(data.stock.code);}, renderMinuteStockData() {renders++;},
    showMinutePoint(index) {positions.push(index);}, showMinuteAuctionPoint() {}, refreshMinuteComparisonChart() {},
    updateMinuteTimelineControls() {context.updateMinuteTimelineLiveStatus();}
  });
  vm.runInContext(source.slice(source.indexOf("async function requestMinuteData"), source.indexOf("function recordMinuteData")), context);
  vm.runInContext(source.slice(source.indexOf("async function refreshVisibleMinuteData"), source.indexOf("function minuteDisplayPoint")), context);
  return {context, $, posts, gets, records, positions, advance(ms) {now += ms;}, peak: () => peak, renders: () => renders};
}

(async () => {
  const h = harness(), cycle = h.context.refreshVisibleMinuteData();
  await h.context.refreshVisibleMinuteData();
  await cycle;
  assert.deepEqual(h.gets.slice().sort(), codes, "the visible charts and entire timeline pool are checked once, with duplicate codes removed");
  assert.deepEqual(h.posts.map(body => body.code).sort(), codes.slice(1), "fresh primary cache is reused while unselected timeline stocks acquire new data");
  assert.ok(h.posts.every(body => body.date === day && !body.force));
  assert.equal(h.peak(), 3, "one shared queue bounds all collection to three workers");
  assert.equal(h.context.state.minuteTimelineLiveStatus.failed, 0, "normal partial intraday data is successful, not an error");
  assert.deepEqual(h.positions, [7], "chart observation time is preserved");
  assert.equal(h.$("minute-stock-list").scrollTop, 123);
  assert.match(h.$("minute-timeline-live-status").textContent, /每分钟自动获取.*13:21:00/);
  await h.context.refreshVisibleMinuteData();
  assert.equal(h.gets.length, 8, "a completed cycle is not started again within one minute");
  h.advance(60000);
  await h.context.refreshVisibleMinuteData();
  assert.equal(h.gets.length, 16, "the next minute automatically checks the pool again");
  h.advance(60000); h.context.document.hidden = true;
  await h.context.refreshVisibleMinuteData();
  h.context.document.hidden = false; h.context.state.intradayDate = "2026-10-26";
  await h.context.refreshVisibleMinuteData();
  h.context.state.intradayDate = day; h.context.state.minuteTimelineCollecting = true;
  await h.context.refreshVisibleMinuteData();
  assert.equal(h.gets.length, 16, "background tabs, historical dates and manual collection do not start automatic work");

  const readOnly = harness({editable: false});
  await readOnly.context.refreshVisibleMinuteData();
  assert.equal(readOnly.posts.length, 0, "read-only browsing never collects automatically");
  assert.deepEqual(readOnly.gets, codes.slice(0, 2), "read-only views do not sweep timeline stocks");
  const closed = harness();
  closed.context.state.meta.live.polling = false;
  closed.context.updateMinuteTimelineLiveStatus();
  assert.match(closed.$("minute-timeline-live-status").textContent, /非采集时段.*暂停/);
  await closed.context.refreshVisibleMinuteData();
  assert.deepEqual(closed.gets, codes.slice(0, 2), "outside the polling window, the timeline pool is not collected");

  const failed = harness({freshPrimary: false, beforePost: body => {if (body.code === codes[0]) throw Error("offline");}});
  const previousSeries = failed.context.state.minuteDetail;
  await failed.context.refreshVisibleMinuteData();
  assert.equal(failed.context.state.minuteDetail, previousSeries, "failed primary refresh retains the visible cached series");
  assert.equal(failed.context.state.minuteTimelineLiveStatus.failed, 1);
  assert.match(failed.$("minute-timeline-live-status").textContent, /下分钟重试/);

  const switched = harness({beforePost: (body, context) => {context.state.intradayDate = "2026-10-26"; context.state.intradayGeneration++;}});
  await switched.context.refreshVisibleMinuteData();
  assert.ok(switched.posts.length <= 3, "changing dates stops launching the queued old-day work");
  assert.equal(switched.records.length, 0, "late responses cannot replace current-day UI");
  const changedScope = harness({beforePost: (body, context) => {changedScope.$("minute-timeline-exclude-gem").checked = false;}});
  await changedScope.context.refreshVisibleMinuteData();
  assert.ok(changedScope.posts.length <= 3, "changing the board scope stops the prior queue");
  assert.equal(changedScope.records.length, 0, "responses for the previous scope do not replace the new view");
  console.log("Minute timeline auto collection: full current pool, one-minute cadence, cache reuse, bounded concurrency, failures, history/read-only/background guards, date/scope cancellation and retained chart/list positions: passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
