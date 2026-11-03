const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map();
function $(id) {
  if (!elements.has(id)) elements.set(id, {value: "", textContent: "", hidden: false, innerHTML: "", setAttribute(k, v) {this[k] = v;}, append(...nodes) {nodes.forEach(node => {node.parentElement = this;});}, querySelectorAll() {return [];}, querySelector() {return null;}, focus() {this.focused = true;}});
  return elements.get(id);
}
const row = {id: "a", time: "09:40:05", code: "000001", name: "甲<测试>", boards: 2, kind: "seal", label: "首次封板", precision: "source", detail: "来源时间"};
const peer = {...row, id: "b", code: "600001", name: "乙测试", boards: 1, time: "09:41", kind: "volume", label: "放量", volume: 120000, ratio: 4, precision: "minute"};
const isolated = {...row, id: "c", code: "600002", name: "孤立涨停"};
const interaction = {id: "interaction-a", start: "09:40", end: "09:41", stock_count: 2, events: [row, peer], kinds: ["volume"], links: [{anchor_id: "a", event_id: "b", delta: 1}]};
const data = {date: "2026-10-23", events: [row, peer, isolated], interactions: [interaction, {id: "bad-single", events: [isolated], links: [{anchor_id: "c", event_id: "c", delta: 0}]}], jobs: [], coverage: {total: 3, analyzed: 2, partial: 0, missing: 1}};
let responder, records = [], positions = [], navigation = [];
const context = vm.createContext({$, URLSearchParams,
  state: {tab: "intraday", intradayDate: data.date, intradayGeneration: 1, meta: {capabilities: {edit_tags: true}}, requests: {}, minuteTimelineData: data},
  request: (...args) => responder(...args), loadingHTML: () => "loading", emptyHTML: title => title,
  recordMinuteData: value => records.push(value), showMinutePoint: index => positions.push(index), showMinuteAuctionPoint: () => positions.push("auction"),
  loadMinuteStock: async code => {context.state.intradayCode = code; context.state.minuteDetail = {date: context.state.intradayDate, stock: {code}, points: [{time: "09:40"}, {time: "09:41"}]}; navigation.push(code);},
  clearMinuteComparisons: () => {context.state.minuteCompareCodes = [];},
  selectMinuteComparison: async code => {navigation.push(code); (context.state.minuteCompareCodes ||= []).push(code);},
  updateURL() {}, renderMinuteCompareList() {}
});
vm.runInContext(source.slice(source.indexOf("function escapeHTML"), source.indexOf("const RECENT_STOCKS_KEY")), context);
vm.runInContext(source.slice(source.indexOf("function dateLabel"), source.indexOf("function latestLimitUp")), context);
vm.runInContext(source.slice(source.indexOf("function stockTags"), source.indexOf("function applyTagOrder")), context);
vm.runInContext(source.slice(source.indexOf("function minuteTimelineLiveEnabled"), source.indexOf("function minuteDisplayPoint")), context);
vm.runInContext(source.slice(source.indexOf("function minuteTimelineViewSnapshot"), source.indexOf("function openMethod")), context);
$("minute-chart").querySelector = () => ({focus() {}});
$("minute-chart").scrollIntoView = () => {};

(async () => {
  const viewport = {scrollY: 600, innerHeight: 900, scrollTo({top}) {this.scrollY = top;}};
  const node = (id, top, open = false) => ({dataset: {interactionId: id}, details: {open}, getBoundingClientRect() {return {top, bottom: top + 200};}, querySelector() {return this.details;}});
  let displayed = [node("earlier", -250), node("visible", 80, true)];
  const mockList = {ownerDocument: {defaultView: viewport}, querySelectorAll() {return displayed;}, querySelector() {return null;}};
  const beforeRefresh = context.minuteTimelineViewSnapshot(mockList);
  displayed = [node("new", -300), node("visible", 140)];
  context.restoreMinuteTimelineView(mockList, beforeRefresh);
  assert.equal(displayed[1].details.open, true, "quiet refresh restores expanded raw records in the matching time group");
  assert.equal(viewport.scrollY, 660, "a newly inserted earlier group does not move the currently visible time node");
  const horizontal = {scrollLeft: 420};
  mockList.querySelector = () => horizontal;
  displayed.push({...node("day-evidence", 1200), matches() {return true;}, open: true});
  const daySnapshot = context.minuteTimelineViewSnapshot(mockList);
  displayed[2].open = false; horizontal.scrollLeft = 0;
  context.restoreMinuteTimelineView(mockList, daySnapshot);
  assert.equal(displayed[2].open, true, "the single full-day evidence section stays expanded during automatic refresh");
  assert.equal(horizontal.scrollLeft, 420, "automatic refresh retains the horizontal position of a zoomed timeline");
  const collectButton = $("minute-timeline-collect"), stopButton = $("minute-timeline-stop");
  const incompleteDay = {...data, interactions: [], jobs: [{code: row.code}], coverage: {total: 1, analyzed: 0, missing: 1, partial: 0}};
  context.state.minuteTimelineData = incompleteDay;
  context.renderMinuteTimeline();
  assert.equal($("minute-timeline-data-gap").hidden, false, "an uncached day offers collection inside the timeline content");
  assert.equal(collectButton.parentElement, $("minute-timeline-collection-actions"));
  assert.equal(collectButton.disabled, false);
  context.state.minuteTimelineCollecting = true;
  context.updateMinuteTimelineControls();
  assert.equal(stopButton.parentElement, $("minute-timeline-collection-actions"), "collection started from a fully uncached day stays in its empty state");
  context.state.minuteTimelineCollecting = false;
  context.state.minuteTimelineData = {...incompleteDay, provisional: true, interactions: [interaction], coverage: {total: 1, analyzed: 1, missing: 0, partial: 1}};
  context.renderMinuteTimeline();
  assert.equal(collectButton.parentElement, $("minute-timeline-actions"), "even an entirely partial intraday pool already has data and keeps collection in the top-right header");
  assert.equal($("minute-timeline-data-gap").hidden, true);
  context.state.minuteTimelineCollecting = true;
  context.updateMinuteTimelineControls();
  assert.equal(collectButton.disabled, true);
  assert.equal(stopButton.parentElement, $("minute-timeline-actions"), "partial-data collection and stopping both stay in the header");
  assert.equal(stopButton.hidden, false);
  context.state.minuteTimelineCollecting = false;
  context.state.minuteTimelineData = {...incompleteDay, coverage: {total: 2, analyzed: 1, missing: 1, partial: 0}};
  context.renderMinuteTimeline();
  assert.equal($("minute-timeline-data-gap").hidden, true, "one missing stock and no matching interactions do not produce the all-data-missing fallback");
  assert.equal(collectButton.parentElement, $("minute-timeline-actions"));
  context.state.minuteTimelineData = {...data, coverage: {total: 1, analyzed: 1, missing: 0, partial: 0}};
  context.renderMinuteTimeline();
  assert.equal($("minute-timeline-data-gap").hidden, true);
  assert.equal(collectButton.parentElement, $("minute-timeline-actions"), "completion returns the same button to the header");
  assert.equal($("minute-timeline-collect"), collectButton, "the original bound button is reused rather than cloned");
  context.state.minuteTimelineData = incompleteDay;
  context.state.meta.capabilities.edit_tags = false;
  context.updateMinuteTimelineControls();
  assert.equal($("minute-timeline-data-gap").hidden, true, "read-only viewers get no collection call to action");
  assert.equal(collectButton.hidden, true);
  context.state.meta.capabilities.edit_tags = true;
  context.state.intradayDate = "2026-10-22";
  context.updateMinuteTimelineControls();
  assert.equal($("minute-timeline-data-gap").hidden, true, "a previous date cannot offer collection for the newly selected day");
  assert.equal(collectButton.disabled, true);
  context.state.intradayDate = data.date;
  context.state.minuteTimelineData = data;
  context.renderMinuteTimeline();
  const realList = $("minute-timeline-list"), originalQuery = realList.querySelector, originalQueries = realList.querySelectorAll;
  const label = {offsetWidth: 170};
  const bodyScroll = {scrollLeft: 240, clientWidth: 1000, querySelector() {return label;}, addEventListener() {}};
  const panScroll = {scrollLeft: 0, addEventListener() {}}, rulerScroll = {scrollLeft: 0, addEventListener() {}};
  realList.querySelector = selector => selector === ".minute-day-stock" ? label : selector === ".minute-day-scroll" ? bodyScroll : null;
  realList.querySelectorAll = selector => selector.includes(".minute-day-scroll") ? [bodyScroll, panScroll, rulerScroll] : [];
  context.syncMinuteTimelineScroll(bodyScroll);
  assert.deepEqual([bodyScroll.scrollLeft, panScroll.scrollLeft, rulerScroll.scrollLeft], [240, 240, 240], "body, top scrollbar and frozen-column ruler share the same horizontal position");
  assert.equal($("minute-day-visible-time").textContent, "09:31 — 09:37");
  context.zoomMinuteTimelineDay(360);
  assert.deepEqual([bodyScroll.scrollLeft, panScroll.scrollLeft, rulerScroll.scrollLeft], [720, 720, 720], "changing scale retains the same leftmost time across all three surfaces");
  context.state.minuteTimelinePitch = 120;
  const jump = $("minute-day-jump-time"); jump.value = "09:31:15";
  jump.setCustomValidity = value => {jump.validation = value;}; jump.reportValidity = () => {};
  context.jumpMinuteTimelineDay();
  assert.ok(Math.abs(bodyScroll.scrollLeft - 270) < 1e-6, "second-level time jumps include only one auction point before regular trading");
  jump.value = "12:05"; context.jumpMinuteTimelineDay();
  assert.ok(Math.abs(bodyScroll.scrollLeft - 270) < 1e-6, "a lunch-break time cannot silently jump to a fabricated trading minute");
  assert.ok(jump.validation);
  jump.value = "09:29:59"; context.jumpMinuteTimelineDay();
  assert.ok(Math.abs(bodyScroll.scrollLeft - 270) < 1e-6, "the removed pre-open pause cannot be selected as a trading time");
  assert.ok(jump.validation);
  jump.value = "09:25:00"; context.jumpMinuteTimelineDay();
  assert.equal(bodyScroll.scrollLeft, 0, "the true auction timestamp can be reached at the start of the axis");
  assert.equal(jump.validation, "");
  realList.querySelector = originalQuery; realList.querySelectorAll = originalQueries;
  assert.equal(context.state.minuteTimelineDayModel.rows.length, 3, "isolated stock nodes remain visible without any cross-stock relationships");
  assert.equal(context.state.minuteTimelineDayModel.nodes.size, 3);
  context.state.minuteTimelinePitch = 360;
  context.selectMinuteTimelineDayNode("000001-seal-09:40:05");
  responder = async () => data;
  await context.loadMinuteTimeline({quiet: true});
  assert.equal(context.state.minuteTimelinePitch, 360, "automatic refresh retains the chosen precise time scale");
  assert.equal(context.state.minuteTimelineSelectedNode, "000001-seal-09:40:05");
  context.state.minuteTimelinePitch = 120;
  assert.equal($("minute-timeline-list")["data-show-tags"], "false");
  context.state.meta.tag_order = ["优先标签", "普通标签", "<自定义>"];
  context.state.minuteTimelineData = {...data, pool: [{...row, tags: ["<自定义>", "普通标签", "优先标签"]}, {...peer, tags: ["对比股标签"]}]};
  context.renderMinuteTimeline();
  const taggedHTML = $("minute-timeline-list").innerHTML;
  assert.match(taggedHTML, /优先标签<\/span><span class="stock-tag">普通标签<\/span><span class="stock-tag">&lt;自定义&gt;/);
  assert.equal((taggedHTML.match(/class="stock-tags minute-timeline-tags"/g) || []).length, 2);
  $("minute-timeline-show-tags").checked = true; context.toggleMinuteTimelineTags();
  assert.equal($("minute-timeline-list")["data-show-tags"], "true");
  $("minute-timeline-show-tags").checked = false; context.toggleMinuteTimelineTags();
  assert.equal($("minute-timeline-list").innerHTML, taggedHTML, "tag visibility does not replace or re-filter stock rows");
  context.state.minuteTimelineData = data; context.renderMinuteTimeline();
  const ownHTML = $("minute-timeline-list").innerHTML;
  assert.match(ownHTML, /孤立涨停/, "a first seal is not removed just because other stocks have no nearby event");
  assert.match(ownHTML, /--day-track-width:28920px/, "the default axis includes one auction point before normal 120-pixel minute spacing");
  assert.equal((ownHTML.match(/class="minute-day-tick/g) || []).length, 242, "one auction point plus all regular trading minutes have explicit ticks");
  const openingTicks = [...ownHTML.matchAll(/class="minute-day-tick[^"]*" style="left:(\d+)px"><time>([^<]+)<\/time>/g)].slice(0,3);
  assert.deepEqual(openingTicks.map(tick => [tick[1], tick[2]]), [["0", "09:25"], ["120", "09:30"], ["240", "09:31"]], "09:25 is immediately followed by 09:30, then normal minute spacing");
  assert.doesNotMatch(ownHTML, /<time>09:2[6-9]<\/time>/);
  const secondTickPositions = [...ownHTML.matchAll(/class="minute-day-second" aria-hidden="true" style="left:([\d.]+)px"/g)].map(tick => Number(tick[1]));
  assert.equal(Math.min(...secondTickPositions), 150, "second marks start at 09:30:15 and never subdivide the frozen auction point");
  assert.match(ownHTML, /15″/);
  assert.doesNotMatch(ownHTML, /minute-day-peer|关联 \d+ 只|minute-interaction-range/);
  assert.match($("minute-timeline-coverage").textContent, /展示 3 只股票.*3 个自身节点/);
  assert.match($("minute-timeline-scope").textContent, /ST 固定屏蔽/);
  const rowHTML = context.minuteTimelineLaneHTML(context.state.minuteTimelineDayModel.rows.find(lane => lane.stock.code === row.code), 120);
  assert.match(rowHTML, /甲&lt;测试&gt;/);
  assert.doesNotMatch(rowHTML, /乙测试|孤立涨停/, "a stock's lane contains only that stock's own labels and event cards");
  assert.doesNotMatch(context.minuteTimelineLaneHTML(context.state.minuteTimelineDayModel.rows.find(lane => lane.stock.code === peer.code), 120), /09:41:00/, "minute observations do not acquire invented seconds");
  context.selectMinuteTimelineDayNode("000001-seal-09:40:05");
  assert.match($("minute-day-selection").innerHTML, /09:40:05.*甲&lt;测试&gt;/);
  assert.doesNotMatch($("minute-day-selection").innerHTML, /乙测试|data-timeline-peer|对比|关联/, "selecting an event does not display another stock's interactions");
  const selectedMarkers = [{hidden: true}, {hidden: true}], selectedCursor = {hidden: true}, selectedStyles = {};
  const selectedChart = {dataset: {}, style: {setProperty(key, value) {selectedStyles[key] = value;}},
    querySelector() {return selectedCursor;}, querySelectorAll() {return selectedMarkers;}};
  realList.querySelector = selector => selector === ".minute-day-chart" ? selectedChart : null;
  context.renderMinuteTimelineSelection();
  assert.ok(selectedMarkers.every(marker => !marker.hidden), "a selected node marks the same time in both the frozen ruler and all stock rows");
  assert.equal(selectedStyles["--day-selected-x"], "1330px", "the persistent column follows the exact second on the compressed opening axis");
  assert.equal(selectedCursor.textContent, "09:40:05");
  context.highlightMinuteTimelineGuide("600001-volume-09:41");
  assert.equal(selectedStyles["--day-selected-x"], "1330px", "hovering another event does not move the selected time column");
  context.state.minuteTimelinePitch = 360; context.renderMinuteTimelineSelection();
  assert.equal(selectedStyles["--day-selected-x"], "3990px", "zooming retains the selected clock at the new scale");
  context.state.minuteTimelineSelectedNode = null; context.renderMinuteTimelineSelection();
  assert.ok(selectedMarkers.every(marker => marker.hidden), "clearing the selection removes the column from both surfaces");
  assert.equal(selectedCursor.hidden, true);
  context.state.minuteTimelineSelectedNode = "filtered-out"; context.renderMinuteTimelineSelection();
  assert.ok(selectedMarkers.every(marker => marker.hidden), "a filtered-out node leaves no stale column");
  context.state.minuteTimelineSelectedNode = null; context.state.minuteTimelinePitch = 120;
  realList.querySelector = originalQuery;
  const standalone = {...data, interactions: [], events: [{...row, related: [{...peer}]}, peer, isolated, {...row, id: "duplicate-alias"}]};
  const before = JSON.stringify(standalone);
  const model = context.minuteTimelineDayModel(standalone);
  assert.equal(model.nodes.size, 3, "repeated node aliases are consolidated by stock, type and actual clock");
  assert.equal(model.nodes.get("000001-seal-09:40:05").related, undefined, "cross-stock associations do not enter the displayed node model");
  assert.equal(JSON.stringify(standalone), before);
  assert.deepEqual(Array.from(context.minuteTimelineDayModel(standalone, {exclude: [peer.code]}).rows, lane => lane.stock.code), [row.code, isolated.code], "excluding a stock retains all other rows");
  assert.equal(context.minuteTimelineDayModel(standalone, {group: "first"}).rows.length, 1);
  assert.equal(context.minuteTimelineDayModel(standalone, {group: "multi"}).rows.length, 2);
  assert.deepEqual(Array.from(context.minuteTimelineDayModel(standalone, {kind: "volume"}).nodes.values(), node => node.code), [peer.code]);
  const newTypes = {...data, events: [
    ...["before", "at", "after", "unknown"].map((phase, index) => ({...peer, id: phase, time: `09:${40 + index}`, volume_phase: phase, label: `放量-${phase}`})),
    {...row, id: "rise", kind: "rapid_up", time: "09:44", label: "快速涨幅", start_time: "09:41", change_pp: 3.2, duration_minutes: 3},
    {...row, id: "fall", kind: "rapid_down", time: "09:48", label: "快速跌幅", start_time: "09:45", change_pp: -3.1, duration_minutes: 3}
  ]};
  assert.equal(context.minuteTimelineDayModel(newTypes).nodes.size, 6, "all new own-stock node types stay on the same time axis");
  assert.equal(context.minuteTimelineDayModel(newTypes, {kind: "volume"}).nodes.size, 4, "all-volume includes unknown phase without guessing");
  for (const phase of ["before", "at", "after"]) {
    const filtered = context.minuteTimelineDayModel(newTypes, {kind: `volume_${phase}`});
    assert.deepEqual(Array.from(filtered.nodes.values(), event => event.volume_phase), [phase]);
    assert.match(context.minuteTimelineLaneHTML(filtered.rows[0], 120), new RegExp(`day-volume-${phase}`));
  }
  for (const kind of ["rapid_up", "rapid_down"]) {
    const filtered = context.minuteTimelineDayModel(newTypes, {kind});
    const event = [...filtered.nodes.values()][0];
    assert.equal(filtered.nodes.size, 1);
    assert.match(context.minuteTimelineLaneHTML(filtered.rows[0], 120), new RegExp(`day-${kind}`));
    assert.match(context.minuteTimelineMetric(event), /[+-]3\.[12]0 个百分点.*09:4[15] → 09:4[48].*3 分钟/);
  }
  const emptyStock = {...row, code: "600099", name: "缺失分时"};
  const partialModel = context.minuteTimelineDayModel({...data, pool: [row, emptyStock], events: [row]});
  assert.equal(partialModel.rows.length, 2, "a pool stock with no observed nodes is retained as an explicitly empty row");
  assert.match(context.minuteTimelineLaneHTML(partialModel.rows[1], 120), /尚无可显示节点/);
  const secondsEvents = [
    {...row, id: "s6", time: "09:30:06", kind: "last_seal"},
    {...row, id: "s3", time: "09:30:03"},
    {...row, id: "s1", time: "09:31:01", kind: "relock"}
  ];
  const secondsModel = context.minuteTimelineDayModel({...data, pool: [row], events: secondsEvents});
  const layout = context.minuteTimelineLaneLayout(secondsModel.rows[0], 120);
  assert.deepEqual(Array.from(layout.events, item => item.event.time), ["09:30:03", "09:30:06", "09:31:01"]);
  assert.ok(Math.abs(layout.events[0].x - 126) < 1e-6);
  assert.ok(Math.abs(layout.events[1].x - layout.events[0].x - 6) < 1e-6, "three real seconds correspond to six pixels at minute scale");
  assert.ok(layout.events[0].track !== layout.events[1].track, "overlapping same-stock labels use separate vertical tracks");
  const finer = context.minuteTimelineLaneLayout(secondsModel.rows[0], 360);
  assert.ok(Math.abs(finer.events[1].x - finer.events[0].x - 18) < 1e-6, "the finer scale makes nearby seconds distinguishable");
  for (const time of ["09:25:00", "12:15", "15:00:01", "09:30:60"]) assert.equal(context.minuteTimelineRegularEvent({...row, time}), false);
  assert.equal(context.minuteTimelineDayPosition("09:25"), 0);
  assert.equal(context.minuteTimelineDayPosition("09:25:59"), 0, "the post-auction point is not expanded into a minute of second-level movement");
  assert.equal(context.minuteTimelineDayPosition("09:30"), 1 / 241 * 100);
  assert.equal(context.minuteTimelineDayPosition("11:30"), 121 / 241 * 100);
  assert.equal(context.minuteTimelineDayPosition("13:00"), 121 / 241 * 100);
  assert.equal(context.minuteTimelineDayPosition("15:00"), 100);
  assert.equal(context.minuteTimelineDayClock(0), "09:25");
  assert.equal(context.minuteTimelineDayClock(1), "09:30");
  assert.equal(context.minuteTimelineDayClock(2), "09:31");
  assert.equal(context.minuteTimelineDayClock(121), "13:00");
  assert.equal(context.minuteTimelineDayClock(241), "15:00");
  const morning = {...row, id: "morning", time: "09:31:20"}, earlier = {...peer, id: "earlier", time: "09:31:05"};
  context.state.minuteTimelineData = {...data, events: [morning, earlier]}; context.renderMinuteTimeline();
  assert.deepEqual(Array.from(context.state.minuteTimelineDayModel.rows, lane => lane.stock.code), [row.code, peer.code], "a higher-board stock stays ahead even when its own first event occurs later");
  const highest = {...row, code: "600088", boards: 5, time: "14:55:01"};
  const missingHigh = {...row, code: "600089", boards: 4};
  const invalidBoards = [0, -1, null, undefined, 1.5].map((boards, i) => ({...row, code: String(601100 + i), boards}));
  const boardOrder = context.minuteTimelineDayModel({...data, pool: [peer, row, highest, missingHigh, ...invalidBoards], events: [peer, row, highest, ...invalidBoards]});
  assert.deepEqual(Array.from(boardOrder.rows, lane => lane.stock.boards), [5, 4, 2, 1], "board height is the primary order, including a high-board stock whose minute nodes are missing");
  assert.ok(Array.from(boardOrder.nodes.values()).every(node => node.boards >= 1), "non-limit-up, missing and invalid board counts never enter the displayed timeline nodes");
  assert.equal(context.minuteTimelineDayModel({...data, pool: invalidBoards, events: invalidBoards}, {}).rows.length, 0, "a normal stock cannot bypass the first/multiple-board-only scope");
  const timedPool = [
    {...row, code: "600010", boards: 5, first_time: "14:55:01"},
    {...row, code: "600011", boards: 1, first_time: "09:31:05"},
    {...row, code: "600012", boards: 2, first_time: null},
    {...row, code: "600013", boards: 4, first_time: null},
    {...row, code: "600014", boards: 1, first_time: "09:25:00"},
    {...row, code: "600015", boards: 3, first_time: "00:00:00"}
  ];
  const timedEvents = [
    {...row, code: "600010", time: "09:30:01"},
    {...row, code: "600012", time: "09:33", precision: "minute"},
    ...["600010", "600011", "600012", "600013", "600014", "600015"].map(code => ({...peer, code, time: "09:30"})),
    {...row, code: "600013", kind: "last_seal", time: "09:30:02"}
  ];
  const timeData = {...data, pool: timedPool, events: timedEvents};
  const byFirst = context.minuteTimelineDayModel(timeData, {sort: "first_time"});
  assert.deepEqual(Array.from(byFirst.rows, lane => lane.stock.code), ["600014", "600011", "600012", "600010", "600013", "600015"], "source first seals sort earliest first across all board heights; genuinely missing clocks go last");
  assert.equal(byFirst.rows[2].firstSeal.observed, true, "fallback minute seal observations retain their precision label");
  assert.equal(byFirst.rows[3].firstSeal.time, "14:55:01", "the selected day's first_time takes precedence over inconsistent minute observations");
  assert.equal(byFirst.rows[4].firstSeal, null, "a final seal or volume spike must not stand in for a missing first seal");
  assert.equal(byFirst.rows[5].firstSeal, null, "a zero-clock sentinel is missing rather than the earliest stock of the day");
  assert.equal(byFirst.nodes.get("600014-seal-09:25:00").precision, "source", "a confirmed auction first seal is also a visible node at its original time");
  const volumeOnlyByFirst = context.minuteTimelineDayModel(timeData, {sort: "first_time", kind: "volume"});
  assert.deepEqual(Array.from(volumeOnlyByFirst.rows, lane => lane.stock.code), Array.from(byFirst.rows, lane => lane.stock.code), "node-type filtering does not change the underlying first-seal clock");
  const tied = context.minuteTimelineDayModel({...data, pool: timedPool.slice(0,2).map(stock => ({...stock, first_time: "09:31:05"})), events: []}, {sort: "first_time"});
  assert.deepEqual(Array.from(tied.rows, lane => lane.stock.boards), [5, 1], "identical first-seal clocks keep a stable board-height tie break");
  const openingPool = [
    {...row, code: "600020", first_time: "09:25:00"},
    {...row, code: "600021", first_time: "09:30:00"},
    {...row, code: "600022", first_time: null},
    {...row, code: "600023", first_time: "00:00:00"},
    {...row, code: "600024", first_time: "09:26:00"}
  ];
  const openingRaw = [
    {...row, code: "600020", time: "09:25:00", price: 11, detail: "竞价首封来源"},
    {...row, code: "600021", time: "09:30", precision: "minute", label: "涨停价出现"},
    {...row, code: "600022", time: "09:30", precision: "minute", label: "涨停价出现"},
    {...row, code: "600023", time: "09:25", precision: "minute"},
    {...peer, code: "600023", time: "09:25", precision: "source"},
    {...row, code: "600024", time: "09:26:00"}
  ];
  const openingData = {...data, pool: openingPool, events: openingRaw};
  const openingBefore = JSON.stringify(openingData), openingModel = context.minuteTimelineDayModel(openingData);
  assert.equal(openingModel.nodes.size, 3, "source opening seals and genuine 09:30 observations remain; unsupported pre-market events do not");
  assert.equal(openingModel.nodes.get("600020-seal-09:25:00").price, 11, "deduplication retains existing source metrics");
  assert.equal(openingModel.nodes.get("600020-seal-09:25:00").detail, "竞价首封来源");
  assert.equal(openingModel.nodes.get("600021-seal-09:30:00").precision, "source", "09:30 and 09:30:00 share one source-precision node");
  assert.equal(openingModel.nodes.get("600022-seal-09:30").precision, "minute", "an opening minute observation does not invent seconds");
  const sourceOnly = context.minuteTimelineDayModel({...openingData, events: []});
  assert.equal(sourceOnly.nodes.size, 2, "confirmed first seals show even without a minute cache; missing and invalid clocks do not");
  assert.equal(sourceOnly.nodes.get("600020-seal-09:25:00").volume, undefined, "a source timestamp does not fabricate auction volume");
  const auctionRow = sourceOnly.rows.find(lane => lane.stock.code === "600020"), openRow = sourceOnly.rows.find(lane => lane.stock.code === "600021");
  assert.equal(context.minuteTimelineLaneLayout(auctionRow, 120).events[0].x, 0);
  assert.equal(context.minuteTimelineLaneLayout(openRow, 120).events[0].x, 120, "09:30 follows the single auction point without five minutes of empty space");
  assert.match(context.minuteTimelineLaneHTML(auctionRow, 120), /data-day-node="600020-seal-09:25:00"/);
  assert.equal(context.minuteTimelineDayModel(openingData, {kind: "volume"}).nodes.size, 0, "seal supplementation obeys the selected node type");
  assert.ok(!Array.from(context.minuteTimelineDayModel(openingData, {exclude: ["600020"]}).nodes.values()).some(node => node.code === "600020"), "opening seals cannot bypass stock exclusions");
  assert.equal(JSON.stringify(openingData), openingBefore, "display supplementation never rewrites the cached pool or raw events");
  const many = Array.from({length: 125}, (_, i) => ({...row, id: `many-${i}`, code: String(601000 + i)}));
  context.state.minuteTimelineData = {...data, events: many}; context.renderMinuteTimeline();
  assert.equal(($("minute-timeline-list").innerHTML.match(/data-day-stock=/g) || []).length, 125);
  const sealPeer = {...row, id: "seal-peer", code: "600004", name: "丙测试", boards: 1, time: "09:40:20"};
  const triangleData = {...data, pool: [row, peer, sealPeer], events: [row, peer, {...peer, code: sealPeer.code, time: "09:35"}, sealPeer], interactions: []};
  context.state.minuteTimelineData = triangleData; context.state.minuteTimelineLocateCode = null; context.state.minuteTimelineExcludeCodes = [];
  context.renderMinuteTimeline();
  $("minute-timeline-search").value = "600001";
  const timelineBeforeOptionSearch = $("minute-timeline-list").innerHTML;
  context.renderMinuteTimelineStockPicker("locate");
  assert.match($("minute-timeline-locate-options").innerHTML, /乙测试/);
  assert.ok(!$("minute-timeline-locate-options").innerHTML.includes("甲&lt;测试&gt;"));
  assert.equal($("minute-timeline-list").innerHTML, timelineBeforeOptionSearch, "searching the locator never filters the chart");
  context.closeMinuteTimelineStockPickers();
  context.toggleMinuteTimelineStockPicker("locate");
  assert.equal($("minute-timeline-locate-popup").hidden, false);
  assert.equal($("minute-timeline-locate-toggle")["aria-expanded"], "true");
  assert.match($("minute-timeline-locate-options").innerHTML, /type="radio" name="minute-timeline-locate-stock"/);
  assert.doesNotMatch($("minute-timeline-locate-options").innerHTML, /type="checkbox"/);
  const locatorMoves = [], locatorFocus = [];
  const locatorLanes = context.state.minuteTimelineDayModel.rows.map(row => {
    const buttons = row.events.map(event => ({dataset: {dayNode: event.id}, setAttribute() {}, focus(options) {locatorFocus.push([event.id, options.preventScroll]);}, scrollIntoView(options) {locatorMoves.push([event.id, options.block]);}}));
    return {dataset: {dayStock: row.stock.code}, buttons, classList: {toggle() {}}, querySelectorAll() {return buttons;}, querySelector(selector) {return selector === ".minute-day-stock" ? label : buttons[0];}};
  });
  realList.querySelector = selector => selector === ".minute-day-scroll" ? bodyScroll : originalQuery(selector);
  realList.querySelectorAll = selector => selector === ".minute-day-lane" ? locatorLanes : selector === ".minute-day-node" ? locatorLanes.flatMap(lane => lane.buttons) : selector.includes(".minute-day-scroll") ? [bodyScroll,panScroll,rulerScroll] : [];
  context.changeMinuteTimelineStockSelection("locate", "600004", true);
  assert.equal(context.state.minuteTimelineLocateCode, "600004");
  assert.equal(context.state.minuteTimelineSelectedNode, "600004-seal-09:40:20");
  assert.ok(Math.abs(bodyScroll.scrollLeft - 1094) < 1e-6, "locating a stock brings its first seal into the visible time range");
  assert.deepEqual(locatorMoves.at(-1), ["600004-seal-09:40:20", "center"], "the target node is vertically centered");
  assert.deepEqual(locatorFocus.at(-1), ["600004-seal-09:40:20", true]);
  assert.equal($("minute-timeline-locate-popup").hidden, true, "single selection closes the popup");
  context.changeMinuteTimelineStockSelection("locate", "600001", true);
  assert.equal(context.state.minuteTimelineLocateCode, "600001", "a new stock replaces the previous locator selection");
  assert.equal(context.state.minuteTimelineSelectedNode, "600001-volume-09:41", "without a first seal, the earliest visible node is selected");
  const moveCount = locatorMoves.length;
  context.changeMinuteTimelineStockSelection("locate", "600001", true);
  assert.equal(locatorMoves.length, moveCount + 1, "choosing the same radio option can locate it again");
  assert.equal($("minute-timeline-list").innerHTML, timelineBeforeOptionSearch, "locating never redraws or removes the other stock rows");
  assert.equal(context.state.minuteTimelineDayModel.rows.length, 3);
  assert.equal($("minute-timeline-locate-summary").textContent, "乙测试");
  realList.querySelector = originalQuery; realList.querySelectorAll = originalQueries;
  context.selectMinuteTimelineDayNode("600004-seal-09:40:20");
  assert.equal($("minute-timeline-locate-summary").textContent, "丙测试", "manual node selection updates the single-stock locator");
  context.toggleMinuteTimelineStockPicker("exclude");
  assert.equal($("minute-timeline-locate-popup").hidden, true);
  assert.equal($("minute-timeline-exclude-popup").hidden, false);
  context.changeMinuteTimelineStockSelection("exclude", "600004", true);
  context.changeMinuteTimelineStockSelection("exclude", "600001", true);
  assert.deepEqual(Array.from(context.state.minuteTimelineExcludeCodes), ["600004", "600001"], "exclusions continue to support multiple stocks");
  assert.equal(context.state.minuteTimelineDayModel.rows.length, 1);
  assert.equal(context.state.minuteTimelineLocateCode, null, "excluding the located stock clears the locator");
  assert.ok(!$("minute-timeline-locate-options").innerHTML.includes("丙测试"), "hidden rows are not offered as locator targets");
  context.clearMinuteTimelineStockSelection("exclude");
  assert.equal(context.state.minuteTimelineDayModel.rows.length, 3);
  context.changeMinuteTimelineStockSelection("locate", "600004", true);
  context.state.intradayDate = "2026-10-22";
  context.state.minuteTimelineData = {...data, date: "2026-10-22", pool: [row], interactions: []};
  context.renderMinuteTimeline();
  assert.ok(!$("minute-timeline-locate-options").innerHTML.includes("丙测试"));
  assert.equal(context.state.minuteTimelineLocateCode, null, "a date change clears the old locator selection");
  context.state.minuteTimelineData = {...data, date: "2026-10-22", pool: [emptyStock], events: []};
  context.renderMinuteTimeline();
  context.changeMinuteTimelineStockSelection("locate", emptyStock.code, true);
  assert.equal(context.state.minuteTimelineLocateCode, emptyStock.code, "uncached stock rows can still be located");
  assert.equal(context.state.minuteTimelineSelectedNode, null, "locating an empty row never fabricates a node");
  assert.match($("minute-day-selection").innerHTML, /缺失分时.*尚无可显示节点/);
  context.clearMinuteTimelineStockSelection("locate");
  assert.equal(context.state.minuteTimelineLocateCode, null);
  assert.equal(context.state.minuteTimelineSelectedNode, null);
  assert.equal($("minute-timeline-locate-summary").textContent, "选择股票定位（单选）");
  context.state.intradayDate = data.date;
  context.closeMinuteTimelineStockPickers();
  context.state.minuteTimelineData = data;
  context.state.minuteCompareCodes = ["600002", "600003"];
  await context.openMinuteTimelineNode("000001", "09:40:05", "600001");
  assert.deepEqual(navigation, ["000001", "600001"]);
  assert.deepEqual(Array.from(context.state.minuteCompareCodes), ["600001"], "timeline comparison replaces existing peers");
  assert.deepEqual(positions, [0]);
  await context.openMinuteTimelineNode("000001", "09:40:51");
  assert.deepEqual(positions, [0, 1], "source seconds locate the closest available minute rather than always rounding down");
  assert.deepEqual(Array.from(context.state.minuteCompareCodes), ["600001"], "opening a single evidence record does not reset manually selected peers");
  await context.openMinuteTimelineNode("000001", "09:41", "600002");
  assert.deepEqual(Array.from(context.state.minuteCompareCodes), ["600002"], "repeated clicks on the same primary switch the pair rather than accumulate peers");

  const gem = {...peer, id: "gem", code: "300001", name: "创业测试"};
  $("minute-timeline-exclude-gem").checked = false;
  responder = async url => {
    assert.match(url, /exclude_gem=0/);
    return {...data, pool: [row, gem], scope: {start_time: "09:30", exclude_st: true, exclude_gem: false}};
  };
  await context.changeMinuteTimelineGemFilter();
  assert.match($("minute-timeline-scope").textContent, /ST 固定屏蔽.*已纳入创业板/);
  assert.match($("minute-timeline-locate-options").innerHTML, /创业测试/);
  $("minute-timeline-exclude-gem").checked = true;
  responder = async url => {
    assert.match(url, /exclude_gem=1/);
    return {...data, pool: [row], scope: {start_time: "09:30", exclude_st: true, exclude_gem: true}};
  };
  await context.changeMinuteTimelineGemFilter();
  assert.ok(!$("minute-timeline-locate-options").innerHTML.includes("创业测试"));
  context.state.minuteTimelineData = data;

  const incompleteTimes = {...data, time_coverage: {missing: 1, cached: false}};
  const enrichedTimes = {...data, time_coverage: {missing: 0, cached: true}};
  let clockPosts = [], clockReads = 0;
  responder = async (url, channel, options = {}) => {
    if (options.method === "POST") {
      clockPosts.push(JSON.parse(options.body));
      assert.equal(url, "/api/intraday/timeline/times");
      assert.equal(options.headers["Content-Type"], "application/json");
      return {date: data.date, count: 1};
    }
    return ++clockReads === 1 ? incompleteTimes : enrichedTimes;
  };
  await context.loadMinuteTimeline();
  assert.equal(context.state.minuteTimelineData, enrichedTimes);
  assert.deepEqual(clockPosts, [{date: data.date, force: false}], "only the selected date requests a supplementary source clock cache");
  responder = async (url, channel, options = {}) => {assert.notEqual(options.method, "POST"); return incompleteTimes;};
  await context.loadMinuteTimeline();
  context.state.meta.capabilities.edit_tags = false;
  context.state.minuteTimelineTimesRequested = new Set();
  await context.loadMinuteTimeline();
  context.state.meta.capabilities.edit_tags = true;
  context.state.minuteTimelineTimesRequested = new Set();
  let finishOldClocks;
  responder = (url, channel, options = {}) => options.method === "POST" ? new Promise(done => finishOldClocks = done) : Promise.resolve(incompleteTimes);
  const oldClocks = context.loadMinuteTimeline();
  while (!finishOldClocks) await new Promise(done => setImmediate(done));
  context.state.intradayDate = "2026-10-22";
  finishOldClocks({date: data.date, count: 1});
  await oldClocks;
  assert.equal(context.state.minuteTimelineData, incompleteTimes, "late supplemental clocks do not replace a newer date");
  context.state.intradayDate = data.date;
  context.state.minuteTimelineData = data;

  let finishOld;
  responder = () => new Promise(done => finishOld = done);
  const oldRead = context.loadMinuteTimeline();
  context.state.intradayDate = "2026-10-22";
  context.stopMinuteTimelineCollection(false);
  finishOld({...data, date: "2026-10-23"});
  await oldRead;
  assert.equal(context.state.minuteTimelineData, data, "stale date response cannot replace current timeline data");
  context.state.intradayDate = data.date;
  data.jobs = Array.from({length: 7}, (_, i) => ({code: String(600010 + i), force: i === 0}));
  let active = 0, peak = 0, posts = [];
  responder = async (url, channel, options = {}) => {
    if (url.startsWith("/api/intraday/timeline")) return {...data, jobs: []};
    const body = JSON.parse(options.body); posts.push(body); active++; peak = Math.max(peak, active);
    await new Promise(done => setTimeout(done, 1)); active--;
    return {date: body.date, stock: {code: body.code}, status: "ok", points: [{}]};
  };
  await context.collectMinuteTimeline();
  assert.equal(posts.length, 7);
  assert.equal(peak, 3, "collection concurrency stays bounded to three selected-day requests");
  assert.ok(posts.every(body => body.date === data.date));
  assert.equal(records.length, 7);
  assert.match($("minute-timeline-progress").textContent, /处理完成/);
  context.state.meta.capabilities.edit_tags = false;
  context.state.minuteTimelineData = data;
  await context.collectMinuteTimeline();
  assert.equal(posts.length, 7, "read-only viewing cannot trigger batch collection");
  context.state.meta.capabilities.edit_tags = true;
  context.state.minuteLiveRefreshing = true;
  await context.collectMinuteTimeline();
  assert.equal(posts.length, 7, "manual collection cannot overlap an automatic pool update");
  context.state.minuteLiveRefreshing = false;
  records = []; posts = [];
  const pending = [];
  responder = (url, channel, options) => {posts.push(JSON.parse(options.body)); return new Promise(done => pending.push(done));};
  const stopped = context.collectMinuteTimeline();
  context.stopMinuteTimelineCollection(false);
  pending.forEach(done => done({stock: {code: "600010"}, status: "ok", points: [{}]}));
  await stopped;
  assert.equal(posts.length, 3, "stopping does not launch queued stock requests");
  assert.equal(records.length, 0, "stopped responses do not update current-day UI");
  console.log("Own-stock timeline: isolated nodes, no counterpart panel, per-stock filters, minute/second positions, nonoverlapping cards, full minute ruler, view retention, ST/GEM scope, cache races and bounded acquisition: passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
