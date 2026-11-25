const assert = require("node:assert/strict");
const demo = require("../web/intraday-compare.js");
function wave(t) {
 const knots=[[0,0],[7,.12],[12,.15],[13,0],[14,.8],[15,1.9],[16,3.4],[18,3.5],[24,3],[35,2.8],[60,5],[100,6.8],[120,6.1],[160,5.6],[200,7],[241,6.4]];
 if(t<=0)return 0;
 const right=knots.findIndex(p=>p[0]>=t);if(right<0)return knots.at(-1)[1];
 const [a,b]=[knots[Math.max(0,right-1)],knots[right]];return a[0]===b[0]?a[1]:a[1]+(b[1]-a[1])*(t-a[0])/(b[0]-a[0]);
}
const stocks=[
 {code:"603366",name:"日出东方",initials:"RCDF",base:2.2,amplitude:1.24,shift:0,yesterday:1},
 {code:"002088",name:"鲁阳节能",initials:"LYJN",base:-8.6,amplitude:.94,shift:0,yesterday:4},
 {code:"600838",name:"上海九百",initials:"SHJB",base:1,amplitude:.83,shift:1,yesterday:3},
 {code:"000158",name:"常山北明",initials:"CSBM",base:-.5,amplitude:.76,shift:2,yesterday:0},
 {code:"600892",name:"大晟文化",initials:"DSWH",base:3.5,amplitude:-.9,shift:0,yesterday:0},
 {code:"600719",name:"大连热电",initials:"DLRD",base:-.8,amplitude:-.65,shift:0,yesterday:2},
 {code:"600776",name:"东方通信",initials:"DFTX",missing:true,yesterday:1},
 {code:"002045",name:"国光电器",initials:"GGDQ",missing:true,yesterday:0}
].map((stock,index)=>({...stock,boards:stock.yesterday,pointCount:stock.missing?0:242,is_st:false,is_gem:false,points:stock.missing?null:Array.from({length:242},(_,slot)=>{
 const pct=Math.max(-9.98,Math.min(9.98,stock.base+stock.amplitude*wave(slot-stock.shift)+Math.sin(slot*.71+index)*.018));
 return {slot,pct,price:10*(1+pct/100),volume:Math.round(320+index*130+70*(1+Math.sin(slot*.9+index))+Math.max(0,wave(slot-stock.shift)-wave(slot-stock.shift-1))*(index===1?100:1600))};
})}));
const match=(options,universe=stocks)=>demo.findMatches(options,universe);
const options = {source: "603366", start: 13, end: 16, mode: "sync", range: "limit_up"};
const sync = match(options);
assert.equal(sync.total, 4);
assert.equal(sync.analyzed, 3);
assert.equal(sync.missing, 1);
const underwater = sync.rows.find(row => row.stock.code === "002088");
assert.ok(underwater.stats.from < 0 && underwater.stats.to < 0 && underwater.stats.delta > 3, "same-direction rebounds match even when the peer stays below yesterday's close");
assert.equal(underwater.start, options.start);
assert.equal(underwater.end, options.end);
assert.ok(sync.rows.every(row => row.offset === 0), "synchronous search never moves candidate windows");
assert.ok(sync.rows.every((row, index, rows) => !index || rows[index - 1].matchScore >= row.matchScore), "displayed match scores follow the automatic ranking");
assert.ok(sync.rows.every(row => row.matchScore === Math.round(row.quality * 1000) / 10));
assert.ok(!sync.rows.some(row => row.stock.code === "600892"), "stocks outside the selected pool do not enter results");
const lag = match({...options, mode: "lag"});
assert.equal(lag.rows.find(row => row.stock.code === "600838").offset, 1);
const nonLimitUp = match({...options, mode: "lag", range: "non_limit_up"});
assert.equal(nonLimitUp.total, 3);
assert.equal(nonLimitUp.analyzed, 2);
assert.equal(nonLimitUp.missing, 1, "missing windows are not counted as nonmatches");
assert.equal(nonLimitUp.rows.find(row => row.stock.code === "000158").offset, 2);
assert.equal(nonLimitUp.rows.find(row => row.stock.code === "000158").lag, 2);
const responseStock = (code, starts) => {
  const points = Array(242).fill(null);
  for (const start of starts) [0, 1, 4, 5].forEach((pct, index) => {
    points[start + index] = {pct, slot: start + index, volume: 100};
  });
  return {code, boards: 1, points};
};
const targetStart = 148;
const allDayStocks = [
  responseStock("600001", [targetStart]),
  responseStock("600002", [0]),
  responseStock("600003", [238]),
  responseStock("600004", [20, 190]),
  responseStock("600005", [60]),
];
allDayStocks.at(-1).points[61] = null;
const allDayOptions = {...options, source: "600001", start: targetStart, end: targetStart + 3};
const fullDayMatch = match({...allDayOptions, mode: "lag"}, allDayStocks);
assert.equal(fullDayMatch.analyzed, 3);
assert.equal(fullDayMatch.missing, 1, "full-day scanning rejects gaps but does not require data at the reference time");
assert.deepEqual(fullDayMatch.rows.map(row => [row.start, row.end, row.lag, row.matchScore]), [
  [0, 3, -148, 100],
  [238, 241, 90, 100],
  [190, 193, 42, 100],
], "search both session edges without a distance penalty and prefer the nearer window when scores tie");
assert.equal(match(allDayOptions, allDayStocks).analyzed, 0);
assert.equal(match({...allDayOptions, mode: "inverse"}, allDayStocks).analyzed, 0);
const inverse = match({...options, mode: "inverse"});
assert.deepEqual(inverse.rows.filter(row => row.quality > 0).map(row => row.stock.code), ["600719"]);
assert.deepEqual(match({...options, mode: "inverse", range: "non_limit_up"}).rows.filter(row => row.quality > 0).map(row => row.stock.code), ["600892"]);
assert.ok(inverse.rows.filter(row=>row.quality>0).every(row => row.stats.delta < 0 && row.offset === 0));
assert.ok(lag.rows.every(row => row.stock.boards >= 1));
assert.ok(nonLimitUp.rows.every(row => row.stock.boards === 0));
assert.ok(underwater.stats.volumeRatio < 1.3, "volume is separate evidence, not a required synchronous spike");
const flatUniverse = stocks.map(stock => stock.code === "002088" ? {...stock, points: stock.points.map(point => ({...point, pct: -5}))} : stock);
assert.equal(match(options, flatUniverse).rows.find(row => row.stock.code === "002088").matchScore, 0, "flat windows remain visible with zero similarity instead of masquerading as missing data");
const missingPointUniverse = stocks.map(stock => stock.code === "002088" ? {...stock, points: stock.points.map(point => point.slot === 14 ? null : point)} : stock);
assert.equal(match(options, missingPointUniverse).missing, sync.missing + 1);
assert.equal(demo.validWindow(119, 122), true, "lunch is compressed on the continuous intraday axis");
assert.equal(demo.validWindow(null, 10), false);
assert.equal(demo.validWindow(13, 14), true, "one trading minute is selectable");
assert.equal(demo.validWindow(0, 31), true, "there is no thirty-minute cap");
assert.equal(demo.validWindow(0, 241), true, "the full day is selectable");
assert.equal(demo.validWindow(10, 10), false, "a selection needs two distinct endpoints");
assert.equal(demo.validWindow(-1, 10), false);
assert.equal(demo.validWindow(0, 242), false);
for (const query of ["日出", "603366", "RCDF", " rcdf ", "rc"]) assert.deepEqual(demo.targetStocks(query, stocks).map(stock => stock.code), ["603366"]);
assert.equal(demo.targetStocks("not-a-stock", stocks).length, 0);
assert.equal(demo.targetStocks("", stocks).length, 8);
const targetUniverse=[...stocks,
 {code:"600099",name:"ST测试",initials:"STCS",is_st:true},
 {code:"000013",name:"*ST石化A",initials:"STSHA",is_st:true},
 {code:"000016",name:"*ST康佳A",initials:"STKJA",is_st:true},
 {code:"600098",name:"汕头股份",initials:"STGF",is_st:false}];
assert.equal(demo.targetStocks("",targetUniverse).length,9,"the initial target list excludes both ST and *ST stocks");
for(const query of ["ST测试","600099","stcs","000013","stsha","康佳","stkja"])
 assert.deepEqual(demo.targetStocks(query,targetUniverse),[],"excluded stocks cannot reappear through name, code or initials search");
assert.deepEqual(demo.targetStocks("stgf",targetUniverse).map(stock=>stock.code),["600098"],"ordinary stock initials containing ST remain searchable");
assert.equal(demo.clock(0), "09:30");
assert.equal(demo.clock(121), "13:00");
assert.equal(demo.clock(241), "15:00");
const lunchReference = {...stocks[0], points: stocks[0].points.map(point => ({...point,
  pct: ({119: 0, 120: 1, 121: 3, 122: 4})[point.slot] || 0,
  volume: point.slot < 121 ? 100 : 200
}))};
const lunchPeer = {...stocks[1], points: stocks[1].points.map(point => ({...point, pct: -6 + (lunchReference.points[point.slot - 2]?.pct || 0)}))};
const lunchWindow = demo.windowStats(lunchReference, 119, 122);
assert.deepEqual(lunchWindow.points.map(point => demo.clock(point.slot)), ["11:29", "11:30", "13:00", "13:01"]);
assert.deepEqual(lunchWindow.changes, [1, 2, 1], "do not insert flat lunch points into the shape");
assert.equal(demo.windowStats(lunchReference, 121, 124).volumeRatio, 2, "afternoon volume uses the preceding morning trading minutes");
const lunchMatches = match({...options, start: 119, end: 122, mode: "lag"}, [lunchReference, lunchPeer]);
assert.equal(lunchMatches.rows.length, 1);
assert.equal(lunchMatches.rows[0].offset, 2, "lead/lag windows can also cross lunch");
assert.equal(lunchMatches.rows[0].lag, 2, "lead/lag counts trading minutes, not the lunch break");
const poolIdentity=[stocks[0],{...stocks[1],code:"600081",boards:2,yesterday:1},{...stocks[1],code:"600082",boards:1,yesterday:4},{...stocks[1],code:"600083",boards:0,yesterday:4}];
assert.deepEqual(match(options,poolIdentity).rows.map(row=>row.stock.code),["600081","600082"],"limit-up scope includes both first-board and consecutive-board stocks");
assert.deepEqual(match({...options,range:"non_limit_up"},poolIdentity).rows.map(row=>row.stock.code),["600083"],"non-limit-up scope excludes first-board stocks and uses the selected day rather than yesterday");
const uneven=[{code:"600001",name:"参考",boards:2,points:[0,2,2.1,4,4.1,6].map((pct,slot)=>({slot,pct,price:10+pct/10,volume:100}))},{code:"600002",name:"错峰但整体上涨",boards:2,points:[0,.1,2,.2+2,4.1,4.3].map((pct,slot)=>({slot,pct,price:10+pct/10,volume:100}))}];
const whole=m=>demo.findMatches({source:"600001",start:0,end:5,mode:m,range:"limit_up"},uneven);
const unevenScore = whole("sync").rows[0].matchScore;
assert.ok(unevenScore > 30 && unevenScore < 45, "a weaker, shorter rise retains a reduced match score");
const durationStocks = [
  [0, 0, 2, 4, 6, 8, 8],
  [0, 0, 0, 0, 4, 8, 8],
  [2, 2, 4, 6, 8, 10, 10],
  [10, 10, 8, 6, 4, 2, 2],
  [0, 0, 0, 0, 2, 4, 4],
].map((values, index) => ({
  code: String(600001 + index), boards: 1, points: values.map((pct, slot) => ({pct, slot, volume: 100})),
}));
const durationMatch = match({...options, source: "600001", start: 0, end: 6}, durationStocks);
const [sameDuration, shortSameSpan, shortSameSlope] = durationMatch.rows;
assert.equal(durationMatch.reference.moveMinutes, 4, "flat minutes around the move do not extend it");
assert.equal(sameDuration.matchScore, 100);
assert.equal(shortSameSpan.stats.delta, durationMatch.reference.delta);
assert.equal(shortSameSpan.stats.moveMinutes, 2);
assert.ok(shortSameSpan.matchScore < 35, "a short jump loses points even with a similar shape and the same price change");
assert.equal(shortSameSlope.stats.moveMinutes, 2);
assert.ok(shortSameSlope.matchScore < 25, "a move at the same slope loses points when it ends sooner");
assert.equal(match({...options, source: "600001", start: 0, end: 6, mode: "inverse"}, durationStocks).rows[0].matchScore, 100);
assert.equal(demo.windowStats(durationStocks[0], 0, 1).moveMinutes, 0);
assert.equal(demo.windowStats(durationStocks[0], 1, 2).moveMinutes, 4, "the same move continues after the selection");
const sustained = [5.16, 6.21, 6.82, 7.43, 7.78, 7.69, 9.09, 9.97, 9.97, 9.97, 10.5].map((pct, slot) => ({pct, slot, volume: 100}));
const continued = {...durationStocks[0], points: sustained};
assert.equal(demo.windowStats(continued, 0, 3).moveMinutes, 7, "count a continuing rise across a small pullback, then stop at two flat minutes");
assert.equal(demo.windowStats(continued, 0, 3).delta, sustained[3].pct - sustained[0].pct, "the comparison window and price change remain fixed");
const gap = {...continued, points: sustained.map((point, slot) => slot === 4 ? null : point)};
assert.equal(demo.windowStats(gap, 0, 3).moveMinutes, 3, "do not extend over missing minutes");
const stopped = {...continued, points: sustained.map((point, slot) => slot === 4 ? {...point, pct: 7} : point)};
assert.equal(demo.windowStats(stopped, 0, 3).moveMinutes, 3, "a material reversal ends the move");
assert.equal(lunchWindow.moveMinutes, 3, "the movement length is measured on the continuous trading axis");
const reversals=uneven.map((stock,index)=>({...stock,points:[2,0,2,4,2].map((value,slot)=>({slot,pct:value-index*2,price:10+(value-index*2)/10,volume:100}))}));
assert.equal(demo.findMatches({source:"600001",start:0,end:4,mode:"sync",range:"limit_up"},reversals).rows[0].matchScore,100,"a non-flat reversal remains comparable when its endpoints have the same price");
const openingSurge = demo.decodeRows({rows: [
  {code: "000533", boards: 0, previous_close: 10.80, points: [["09:44", 10.28, 0], ["09:45", 10.68, 0], ["09:46", 10.74, 0]]},
  {code: "600156", boards: 1, previous_close: 7.35, points: [["09:44", 7.03, 0], ["09:45", 7.07, 0], ["09:46", 7.07, 0]]},
]});
const surgeMatch = match({...options, source: "000533", start: 14, end: 16}, openingSurge).rows[0];
assert.ok(surgeMatch.shape > .99 && surgeMatch.quality < .15, "Huasheng's 0.54-point move must score low against Shunna's 4.26-point surge even with a nearly identical shape");
const differentPace = uneven.map((stock, index) => ({...stock,
  points: (index ? [0, 0, 0, 0, 4] : [0, 1, 2, 3, 4]).map(pct => ({pct, volume: 100})),
}));
assert.ok(match({...options, source: "600001", start: 0, end: 4}, differentPace).rows[0].quality < .5,
  "the same range receives a lower score when a single jump replaces a steady climb");
console.log("Intraday comparison: underwater rebounds, strict time alignment, lag offsets, inverse moves, volume evidence, missing coverage and session boundaries passed.");

const excluded=[stocks[0],{...stocks[1],code:"600099",is_st:true},{...stocks[1],code:"300099",is_gem:true},{...stocks[1],code:"600098",boards:null,yesterday:null}];
assert.equal(match({...options,excludeST:true,excludeGEM:true},excluded).total,0);
assert.equal(match({...options,excludeST:false,excludeGEM:false},excluded).rows.length,2);
const compact=day=>({date:day,identity_known:true,pool_known:true,previous_date:"2026-11-10",rows:stocks.map(stock=>({...stock,status:stock.missing?"missing":"ok",previous_close:10,limit_down_price:9,limit_up_price:11,points:stock.points?.map(p=>[demo.clock(p.slot),p.price,p.volume])||[]}))});
const decoded=demo.decodeRows(compact("2026-11-11"));
assert.equal(decoded[0].points[120].time,"11:30");assert.equal(decoded[0].points[121].time,"13:00");
const gapPayload=compact("2026-11-11");gapPayload.rows[0].points=gapPayload.rows[0].points.filter(p=>p[0]!=="09:44");
assert.equal(demo.decodeRows(gapPayload)[0].points[14],null,"missing real samples are never interpolated");
assert.equal(demo.windowStats(demo.decodeRows(gapPayload)[0],13,16),null);
assert.equal(match({...options,source:"does-not-exist"}).reference,null);
async function checkUI(){
// Exercise a held pointer, not just the final mouse-up: matching must update live
// while the source SVG stays attached so pointer capture continues to work.
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) {
    let html = "";
    const item = {id, dataset: {}, value: "", textContent: "", hidden: true, writes: 0, listeners: new Map(),
      setAttribute(name, value) {this[name] = value;}, removeAttribute(name) {delete this[name];},
      addEventListener(type, callback) {this.listeners.set(type, callback);}, focus() {}, scrollIntoView() {},
      checkValidity() {return true;}, reportValidity() {this.reported = true;}, setCustomValidity(value) {this.validityMessage = value;},
      closest() {return this;}, querySelector(selector) {return selector === "svg" && id === "demo-source-chart" ? svg : selector === "svg" && id === "demo-source-volume" ? volumeSvg : node(id + selector);}, querySelectorAll() {return []}
    };
    Object.defineProperty(item, "innerHTML", {get() {return html;}, set(value) {html = value; item.writes++;}});
    nodes.set(id, item);
  }
  return nodes.get(id);
}
const svg = {dataset: {demoLeft: "0", demoRight: "241"}, getBoundingClientRect() {return {left: 0, width: 980};},
  closest() {return this;}, matches() {return true;}, querySelector(selector) {return node("brush" + selector);},
  setPointerCapture(id) {this.captured = id;}, focus() {}};
const volumeSvg = {...svg, matches() {return false;}, querySelector(selector) {return node("volume-brush" + selector);}};
const previousStorage = globalThis.localStorage;
let storageAccesses = 0;
globalThis.localStorage = {getItem() {storageAccesses++; return "[]";}, setItem() {storageAccesses++;}};
const root = node("root");
root.querySelector = selector => node(selector.replace(/^#/, ""));
let hostDate = "2026-11-11";
const dates = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"], changedDates = [];
let loader = async day=>compact(day);
const openedPairs = [];
const controller = demo.mount(root, {onOpenPair: (...args) => openedPairs.push(args), getContext: () => ({date: hostDate, dates,code:"603366"}), loadData:day=>loader(day), onDateChange(day) {hostDate = day; changedDates.push(day);}});
await controller.syncContext();
const pointer = slot => ({target: svg, clientX: 62 + slot / 241 * 858, button: 0, pointerId: 1, preventDefault() {}});
const changeFilter = (container, name, value) => container.listeners.get("change")({target: {dataset: {}, type: "radio", checked: true, name, value}});
node("demo-source-chart").listeners.get("pointerdown")(pointer(13));node("demo-source-chart").listeners.get("pointerup")(pointer(16));
assert.doesNotMatch(root.innerHTML, /demo-sort|demo-full|demo-search|demo-start|demo-end|demo-preset|demo-error|2—30|compare-demo-results|demo-results-table|demo-top-three|demo-clear|demo-selected|data-demo-layout|demo-save|demo-saved|compare-demo-method|Demo|演示数据|模拟样本|demo-basis-note|compare-demo-view-controls/);
assert.match(root.innerHTML, /目标股票/);
assert.doesNotMatch(root.innerHTML, /<select/);
assert.doesNotMatch(root.innerHTML, /id="demo-coverage"/);
assert.doesNotMatch(root.innerHTML, /demo-match-cutoff/);
assert.doesNotMatch(root.innerHTML, /name="demo-score-band" value="all"/);
assert.match(root.innerHTML, />先后响应<\/span>/);
assert.doesNotMatch(root.innerHTML, /±3 交易分钟/);
assert.match(root.innerHTML, /name="demo-range" value="limit_up" checked/);
assert.match(root.innerHTML, /name="demo-mode" value="sync" checked/);
assert.match(root.innerHTML, /屏蔽ST/);assert.match(root.innerHTML,/屏蔽创业板/);
assert.equal(node("demo-exclude-st").checked,true);assert.equal(node("demo-exclude-gem").checked,true);
const matchCharts = node("demo-comparison-charts");
const cards = () => [...matchCharts.innerHTML.matchAll(/<article[^>]+data-demo-match-code="([^"]+)" data-demo-match-score="([^"]+)" data-window-start="(\d+)" data-window-end="(\d+)"[^>]*>([\s\S]*?)<\/article>/g)].map(match => ({code: match[1], score: Number(match[2]), start: Number(match[3]), end: Number(match[4]), html: match[5]}));
assert.deepEqual(cards().map(card => card.code), ["002088"], "the highest populated band renders by default");
assert.equal(node("demo-score-band-80").checked, true);
assert.match(node("demo-window-change").textContent, /走势长度 3 分钟/);
assert.match(cards()[0].html, /走势长度 3 分钟/);
assert.match(cards()[0].html, /data-open-minute-pair="002088"[^>]*>分时对比<\/button>/);
const pairButton = {dataset: {openMinutePair: "002088"}, closest() {return this;}};
root.listeners.get("click")({target: pairButton});
assert.deepEqual(openedPairs, [["2026-11-11", "603366", "002088"]]);
assert.equal(node("demo-score-band-label-100").hidden, true);
assert.equal(node("demo-score-band-label-40").hidden, false);
assert.match(cards()[0].html, new RegExp(`href="\\?date=2026-11-11&amp;code=${cards()[0].code}"`));
assert.ok(cards().every(card=>card.score>0));
assert.ok(cards().every(card => card.start === 13 && card.end === 16));
assert.ok(cards().every(card => [...card.html.matchAll(/data-demo-left="0" data-demo-right="241"/g)].length === 2), "price and volume show the full day independently of the selected matching window");
assert.doesNotMatch(matchCharts.innerHTML, /data-demo-select=|data-demo-remove=/);
assert.ok(cards().every(card => (card.html.match(/ L/g) || []).length === 241), "matched price charts retain all 242 daily samples");
assert.ok(cards().every(card => card.html.includes(">15:00</text>") && card.html.includes(">15:00</span>")));
const highlights = card => [...card.html.matchAll(/<rect data-demo-selection x="([^"]+)"[^>]+width="([^"]+)"/g)].map(match => ({x: Number(match[1]), width: Number(match[2])}));
const axisX = slot => 62 + slot / 241 * 858;
assert.ok(cards().every(card => highlights(card).length === 2 && highlights(card).every(box => Math.abs(box.x - axisX(13)) < 1e-8 && Math.abs(box.width - (axisX(16) - axisX(13))) < 1e-8)), "both full-day charts frame the searched interval");
assert.equal(node("demo-date").value, "2026-11-11");
assert.equal(node("demo-date").min, "2026-11-11");
assert.equal(node("demo-date").max, "2026-11-17");
assert.equal(node("demo-prev-date").disabled, true);
assert.equal(node("demo-next-date").disabled, false);
const sourceChart = node("demo-source-chart"), sourceVolume = node("demo-source-volume");
assert.match(sourceVolume.innerHTML, /minute-volume-row/);
assert.match(sourceVolume.innerHTML, /日出东方（主图）/);
assert.match(sourceVolume.innerHTML, /刻度上限/);
assert.equal((sourceVolume.innerHTML.match(/class="minute-volume-bar"/g) || []).length, 242, "the reference chart includes every minute of volume");
assert.ok(cards().every(card => card.html.includes('class="minute-volume-heading"') && card.html.includes('class="minute-volume-limit"') && card.html.includes('class="minute-volume-times"')));
assert.ok(cards().every(card => (card.html.match(/class="minute-volume-bar"/g) || []).length === 242), "matched volume cards use the main-board module structure with all daily bars");
assert.ok(cards().every(card => card.html.includes(`--volume-color:${card.html.match(/stroke="(#[a-f0-9]+)"/)[1]}`)), "price lines and volume cards keep the same stock color");
assert.match(sourceChart.innerHTML, /data-demo-left="0" data-demo-right="241"/);
assert.match(sourceChart.innerHTML, />15:00<\/text>/);
assert.match(sourceChart.innerHTML, />-10.00%<\/text>/);
assert.match(sourceChart.innerHTML, />\+10.00%<\/text>/);
assert.match(sourceChart.innerHTML, /compare-price-zero/);
assert.ok(cards().every(card => card.html.includes('>-10.00%</text>') && card.html.includes('>+10.00%</text>')), "underwater and positive peers both retain the full limit-down to limit-up range");

sourceChart.listeners.get("pointerdown")(pointer(5));
const brushWrites = sourceChart.writes, volumeWrites = sourceVolume.writes;
root.listeners.get("pointermove")(pointer(8));
assert.match(node("demo-window-change").textContent, /09:35—09:38/);
assert.equal(node("demo-result-count").textContent, "1 只匹配");
assert.equal(cards().length, 1);
assert.ok(cards().every(card=>card.score>0));
assert.equal(sourceChart.writes, brushWrites, "live results must not replace the SVG under the held pointer");
assert.equal(sourceVolume.writes, volumeWrites, "the reference volume card is retained during brushing");
assert.ok(Math.abs(Number(node("volume-brush[data-demo-selection]").width) - (axisX(8) - axisX(5))) < 1e-8, "source volume highlights update during the held drag even for low-similarity candidates");
root.listeners.get("pointermove")(pointer(16));
assert.match(node("demo-window-change").textContent, /09:35—09:46/);
assert.match(matchCharts.innerHTML, /鲁阳节能/);
assert.ok(cards().every(card => card.start === 5 && card.end === 16), "matching cards update before releasing the pointer");
assert.ok(cards().every(card => highlights(card).every(box => Math.abs(box.x - axisX(5)) < 1e-8 && Math.abs(box.width - (axisX(16) - axisX(5))) < 1e-8)), "highlights track the held drag while the full-day axes remain fixed");
assert.equal(sourceChart.writes, brushWrites);
sourceChart.listeners.get("pointerup")(pointer(16));
assert.match(sourceChart.innerHTML, /data-demo-left="0" data-demo-right="241"/);
sourceChart.listeners.get("pointerdown")(pointer(16));
root.listeners.get("pointermove")(pointer(13));
assert.match(node("demo-window-change").textContent, /09:43—09:46/);
sourceChart.listeners.get("pointercancel")();
assert.match(node("demo-window-change").textContent, /09:35—09:46/, "cancel restores the selection from before the drag");
sourceChart.listeners.get("pointerdown")(pointer(13));
sourceChart.listeners.get("pointerup")(pointer(16));
changeFilter(root, "demo-mode", "lag");
const shiftedCard = cards().find(card => card.code === "600838");
assert.equal(shiftedCard.start, 14);
assert.equal(shiftedCard.end, 17);
assert.match(shiftedCard.html, /09:44—09:47/);
assert.match(shiftedCard.html, /窗口偏移 \+1 个交易分钟/);
assert.equal((shiftedCard.html.match(/data-demo-left="0" data-demo-right="241"/g) || []).length, 2, "lag results also display full-day charts");
assert.ok(highlights(shiftedCard).every(box => Math.abs(box.x - axisX(14)) < 1e-8 && Math.abs(box.width - (axisX(17) - axisX(14))) < 1e-8), "lag highlights mark the candidate's actual matching time");
assert.ok(cards().every((card, index, all) => !index || all[index - 1].score >= card.score));
changeFilter(root, "demo-range", "non_limit_up");
assert.deepEqual(cards().map(card => card.code), ["000158"], "switching scope selects its highest populated band");
root.listeners.get("keydown")({target: svg, key: "ArrowRight", shiftKey: false, preventDefault() {}});
assert.match(node("demo-window-change").textContent, /09:44—09:47/);
root.listeners.get("pointermove")({...pointer(241), target: volumeSvg});
assert.match(node("demo-source-volume[data-demo-volume-reading]").textContent, /15:00 · [\d,]+ 手/, "hovering the volume chart updates the source reading outside the selected window");
sourceChart.listeners.get("pointerdown")(pointer(119));
const lunchBrushWrites = sourceChart.writes;
root.listeners.get("pointermove")(pointer(122));
assert.match(node("demo-window-change").textContent, /11:29—13:01/);
assert.match(node("demo-window-change").textContent, /3 个交易分钟/);
assert.equal(sourceChart.writes, lunchBrushWrites, "cross-lunch live updates retain pointer capture");
sourceChart.listeners.get("pointerup")(pointer(122));
assert.match(node("demo-window-change").textContent, /11:29—13:01/);
assert.match(sourceChart.innerHTML, /data-demo-left="0" data-demo-right="241"/);
sourceChart.listeners.get("pointerdown")(pointer(0));
root.listeners.get("pointermove")(pointer(241));
assert.match(node("demo-window-change").textContent, /09:30—15:00/);
assert.match(node("demo-window-change").textContent, /241 个交易分钟/);
sourceChart.listeners.get("pointerup")(pointer(241));
sourceChart.listeners.get("pointerdown")(pointer(13));
root.listeners.get("pointermove")(pointer(14));
assert.match(node("demo-window-change").textContent, /09:43—09:44/);
sourceChart.listeners.get("pointerup")(pointer(14));
node("demo-source-search").value = " shjb ";
root.listeners.get("input")({target: node("demo-source-search")});
assert.match(node("demo-source-options").innerHTML, /上海九百/);
assert.doesNotMatch(node("demo-source-options").innerHTML, /日出东方/);
const radio = node("source-radio"); radio.dataset.demoSource = "600838";
root.listeners.get("change")({target: radio});
assert.equal(node("demo-source-summary").textContent, "上海九百 600838");
assert.equal(node("demo-source-popup").hidden, true);
node("demo-source-popup").hidden = false;
root.listeners.get("click")({target: radio});
assert.equal(node("demo-source-popup").hidden, true, "choosing the already selected stock also closes its picker");
assert.match(sourceVolume.innerHTML, /上海九百（主图）/);
const nextDate = node("demo-next-date"); nextDate.dataset.demoDateNav = "next";
root.listeners.get("click")({target: nextDate});await controller.syncContext();
assert.equal(node("demo-date").value, "2026-11-12");
assert.equal(hostDate, "2026-11-12");
const latestDate = node("demo-latest-date"); latestDate.dataset.demoDateNav = "latest";
root.listeners.get("click")({target: latestDate});await controller.syncContext();
assert.equal(node("demo-date").value, "2026-11-17");
assert.equal(node("demo-next-date").disabled, true);
node("demo-date").value = "2026-11-14";
root.listeners.get("change")({target: node("demo-date")});
assert.equal(node("demo-date").value, "2026-11-17", "non-trading days do not change the selected date");
assert.equal(changedDates.length, 2);
hostDate = "2026-11-13"; await controller.syncContext();
assert.equal(node("demo-date").value, "2026-11-13", "tab and history context synchronize the calendar");
assert.equal(storageAccesses, 0, "removed save/restore UI neither reads nor deletes existing saved research");
globalThis.localStorage = previousStorage;
loader=async day=>{const payload=compact(day);for(const [code,name,is_st,is_gem] of [["600099","ST测试",true,false],["300099","创业测试",false,true]]) payload.rows.push({...payload.rows[1],code,name,is_st,is_gem});return payload;};
root.listeners.get("click")({target:node("demo-refresh")});await controller.syncContext();
changeFilter(root, "demo-range", "limit_up");
const count=()=>cards().length;const filtered=count();
const st=node("demo-exclude-st");st.type="checkbox";st.checked=false;root.listeners.get("change")({target:st});assert.equal(count(),filtered+1);
assert.doesNotMatch(node("demo-source-options").innerHTML,/data-demo-source="600099"/,"the target picker always excludes ST even when the independent candidate filter allows it");
const gem=node("demo-exclude-gem");gem.type="checkbox";gem.checked=false;root.listeners.get("change")({target:gem});assert.equal(count(),filtered+2);
st.checked=true;root.listeners.get("change")({target:st});assert.equal(count(),filtered+1);
// Real limit prices can differ from the nominal percentage after cent rounding.
loader=async day=>{
 const payload=compact(day);
 for(const [code,previous,lower,upper] of [["603366",9.82,8.84,10.80],["002088",10.05,9.05,11.06],["300099",10.03,8.02,12.04]]){
  const row=code==="300099"?{...payload.rows[1],code,name:"创业测试",is_gem:true}:payload.rows.find(row=>row.code===code);
  Object.assign(row,{previous_close:previous,limit_down_price:lower,limit_up_price:upper,
   points:Array.from({length:242},(_,slot)=>[demo.clock(slot),slot===0?lower:slot===241?upper:previous+(upper-previous)*slot/241,100])});
  if(code==="300099")payload.rows.push(row);
 }
 return payload;
};
root.listeners.get("click")({target:node("demo-refresh")});await controller.syncContext();
radio.dataset.demoSource="603366";root.listeners.get("change")({target:radio});
const axisPricePath=html=>[...html.match(/<path d="([^"]+)"/)[1].matchAll(/[ML]([\d.]+),(-?[\d.]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}));
const sourceLimitPath=axisPricePath(sourceChart.innerHTML);
assert.equal(sourceLimitPath[0].y,208,"the source limit-down price reaches the plot bottom");
assert.equal(sourceLimitPath.at(-1).y,18,"the actual +9.98% limit-up price reaches the plot top without nominal-10% whitespace");
assert.match(sourceChart.innerHTML, />\+9.98%<\/text>/);assert.match(sourceChart.innerHTML, />-9.98%<\/text>/);
assert.match(sourceChart.innerHTML, />0.00%<\/text>/);
const axisCards = [];
for (const max of [100, 80, 60, 40, 20]) {
 if (node(`demo-score-band-label-${max}`).hidden) continue;
 changeFilter(root, "demo-score-band", String(max));
 axisCards.push(...cards());
}
const mainPeer=axisCards.find(card=>card.code==="002088"),gemPeer=axisCards.find(card=>card.code==="300099");
for(const card of [mainPeer,gemPeer]){
 const path=axisPricePath(card.html);
 assert.equal(path[0].y,172);assert.equal(path.at(-1).y,18,"each matched stock reaches its own price limits");
}
assert.match(mainPeer.html, />\+10.05%<\/text>/);assert.match(mainPeer.html, />-9.95%<\/text>/);
assert.match(gemPeer.html, />\+20.04%<\/text>/);assert.match(gemPeer.html, />-20.04%<\/text>/);
assert.match(sourceVolume.innerHTML, /刻度上限 100 手/,"price bounds never replace the separate volume scale");
loader=async day=>{const payload=compact(day);payload.rows.forEach(row=>row.points.forEach(point=>point[1]=10));return payload;};
root.listeners.get("click")({target:node("demo-refresh")});await controller.syncContext();
assert.equal(cards().length,0,"flat zero-score stocks are hidden rather than presented as matches");
assert.equal(node("demo-score-bands").hidden, true, "no band controls are shown if all bands are empty");
assert.match(matchCharts.innerHTML,/暂无匹配结果/);
const waiting=new Map();loader=day=>new Promise(resolve=>waiting.set(day,resolve));
hostDate="2026-11-12";const oldDay=controller.syncContext();hostDate="2026-11-13";const newDay=controller.syncContext();
waiting.get("2026-11-13")(compact("2026-11-13"));await newDay;
waiting.get("2026-11-12")(compact("2026-11-12"));await oldDay;
assert.match(node("demo-reference-name").textContent,/2026.11.13/,"a slower old-date response cannot replace the current date");
loader=async()=>{throw new Error("行情暂不可用");};hostDate="2026-11-16";await controller.syncContext();
assert.match(node("demo-data-status").textContent,/行情暂不可用/);assert.doesNotMatch(sourceChart.innerHTML,/<svg/);
loader=async day=>compact(day);root.listeners.get("click")({target:node("demo-refresh")});await controller.syncContext();
assert.equal(node("demo-data-status").hidden,true);assert.match(sourceChart.innerHTML,/<svg/);
// Exercise every band boundary against the one-decimal score shown on cards.
const bandScores = [100, 80.1, 80, 60.1, 60, 40.1, 40, 20.1, 20, 0.1, 0];
loader = async day => {
 const payload = compact(day);
 const [target, sample] = payload.rows;
 const makePoints = (row, score) => row.points.map(([time, , volume], slot) => [time, slot === 14 ? 10 * (1 + score / 10000) : 10, volume]);
 payload.rows = [{...target, points: makePoints(target, 100)}, ...bandScores.map((score, i) => ({
  ...sample, code: String(600100 + i), points: makePoints(sample, score),
 }))];
 return payload;
};
changeFilter(root, "demo-mode", "sync");
root.listeners.get("click")({target:node("demo-refresh")});await controller.syncContext();
sourceChart.listeners.get("pointerdown")(pointer(13));sourceChart.listeners.get("pointerup")(pointer(15));
assert.deepEqual(cards().map(card => card.score), [100, 80.1]);
assert.equal(node("demo-score-band-100").checked, true);
const chartWritesBeforeFilter = sourceChart.writes;
for (const [index, max] of [100, 80, 60, 40, 20].entries()) {
 assert.equal(node(`demo-score-count-${max}`).textContent, "2 只");
 changeFilter(root, "demo-score-band", String(max));
 assert.equal(node(`demo-score-band-${max}`).checked, true);
 assert.deepEqual(cards().map(card => card.score), bandScores.slice(2 * index, 2 * index + 2));
}
assert.equal(sourceChart.writes, chartWritesBeforeFilter, "switching a band redraws results only");
loader=async day=>{const payload=compact(day);payload.rows=[payload.rows[0],...Array.from({length:25},(_,i)=>({...payload.rows[0],code:String(600100+i),name:`匹配${i}`}))];return payload;};
root.listeners.get("click")({target:node("demo-refresh")});await controller.syncContext();
assert.equal(node("demo-result-count").textContent,"25 只匹配");assert.equal(cards().length,20);
root.listeners.get("click")({target:node("demo-next-results")});assert.equal(cards().length,5);assert.match(matchCharts.innerHTML,/第21名/);
root.listeners.get("click")({target:node("demo-prev-results")});assert.equal(cards().length,20);

// Selecting non-limit-up fills all eligible missing candidates, three at a time.
nodes.clear();
const fillRoot=node("fill-root");fillRoot.querySelector=selector=>node(selector.replace(/^#/,""));
const sourceRow=compact("2026-11-11").rows[0];
const missingRows=["000001","000002","000003","000004","600099","300099"].map(code=>({...sourceRow,code,name:code,boards:0,points:[],status:"missing",is_st:code==="600099",is_gem:code.startsWith("30")}));
const fills=[],releases=new Map();let fillDate="2026-11-11",activeFills=0,maxFills=0;
const fillController=demo.mount(fillRoot,{
 getContext:()=>({date:fillDate,dates,code:sourceRow.code}),
 loadData:async day=>({date:day,pool_known:true,rows:[sourceRow,...missingRows]}),
 collectData:(day,code)=>{fills.push({day,code});activeFills++;maxFills=Math.max(maxFills,activeFills);return new Promise((resolve,reject)=>releases.set(`${day}:${code}`,{resolve:value=>{activeFills--;resolve(value);},reject:error=>{activeFills--;reject(error);}}));}
});
changeFilter(fillRoot, "demo-range", "non_limit_up");
await fillController.syncContext();
assert.deepEqual(fills.map(row=>row.code),["000001","000002","000003"]);assert.equal(maxFills,3);
const progressStatus = node("demo-collection-progress");
assert.match(progressStatus.textContent, /正在获取当日分时：0 \/ 4 只/);
assert.equal(progressStatus["data-empty"], "true");
assert.equal(node("demo-result-count").hidden, true, "the empty count is suppressed during collection");
assert.equal(node("demo-comparison-charts").innerHTML, "", "the centered progress is the only empty-area message while collecting");
const filled=(day,code)=>({date:day,rows:[{...missingRows.find(row=>row.code===code),status:"ok",points:sourceRow.points}]});
node("demo-source-chart").listeners.get("pointerdown")(pointer(13));
fillRoot.listeners.get("pointermove")(pointer(15));const heldWrites=node("demo-source-chart").writes;
releases.get("2026-11-11:000001").resolve(filled("2026-11-11","000001"));
releases.get("2026-11-11:000002").resolve(filled("2026-11-11","000002"));
releases.get("2026-11-11:000003").reject(new Error("source unavailable"));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(node("demo-source-chart").writes,heldWrites,"newly collected results cannot detach the source under a held pointer");
assert.equal(fills.at(-1).code,"000004");assert.equal(maxFills,3);
assert.equal(progressStatus["data-running"], "true");
assert.equal(progressStatus["data-empty"], "false");
assert.match(node("demo-comparison-charts").innerHTML, /data-demo-match-code="000001"/, "matches already found stay visible");
assert.equal(node("demo-score-count-100").textContent, "2 只");
changeFilter(fillRoot, "demo-mode", "inverse");
assert.equal(progressStatus["data-empty"], "true");
assert.equal(node("demo-comparison-charts").innerHTML, "", "switching to an empty match mode mid-collection cannot show the final empty message");
releases.get("2026-11-11:000004").resolve(filled("2026-11-11","000004"));await new Promise(resolve=>setImmediate(resolve));
assert.equal(progressStatus["data-running"], "false");
assert.equal(node("demo-result-count").hidden, false);
assert.match(node("demo-comparison-charts").innerHTML, /暂无匹配结果/, "the final empty message appears after the last batch is scored");
assert.equal(node("demo-score-bands").hidden, true);
changeFilter(fillRoot, "demo-mode", "sync");
assert.equal(node("demo-score-count-100").textContent, "3 只");
node("demo-source-chart").listeners.get("pointerup")(pointer(15));
assert.equal(node("demo-result-count").textContent,"3 只匹配");
assert.match(node("demo-collection-progress").textContent,/获取完成：4 \/ 4 只 · 1 只来源暂不可用/);
changeFilter(fillRoot, "demo-mode", "inverse");
assert.equal(fills.length,4,"changing matching mode never repeats completed or failed collection attempts");
node("demo-refresh").closest=()=>node("demo-refresh");fillRoot.listeners.get("click")({target:node("demo-refresh")});await fillController.syncContext();
assert.equal(fills.length,7,"an explicit refresh permits retrying unavailable data");
fillDate="2026-11-12";await fillController.syncContext();
for(const code of ["000001","000002","000003"])releases.get(`2026-11-11:${code}`).resolve(filled("2026-11-11",code));
await new Promise(resolve=>setImmediate(resolve));
assert.match(node("demo-reference-name").textContent,/2026\.11\.12/);
assert.equal(node("demo-result-count").textContent,"0 只匹配","late replies from the previous date do not populate the new selection");
for(const code of ["000001","000002","000003"])releases.get(`2026-11-12:${code}`).reject(new Error("offline"));
await new Promise(resolve=>setImmediate(resolve));releases.get("2026-11-12:000004").reject(new Error("offline"));await new Promise(resolve=>setImmediate(resolve));
assert.equal(node("demo-result-count").textContent,"0 只匹配");
nodes.clear();
const fallbackRoot=node("target-fallback");fallbackRoot.querySelector=selector=>node(selector.replace(/^#/,""));
const fallbackPayload=compact("2026-11-11");fallbackPayload.rows.unshift({...fallbackPayload.rows[0],code:"000013",name:"*ST石化A",is_st:true});
const fallbackController=demo.mount(fallbackRoot,{getContext:()=>({date:"2026-11-11",dates,code:"000013"}),loadData:async()=>fallbackPayload});
await fallbackController.syncContext();
assert.doesNotMatch(node("demo-source-summary").textContent,/ST/);
assert.doesNotMatch(node("demo-source-options").innerHTML,/data-demo-source="000013"/);
assert.match(node("demo-source-chart").innerHTML,/<svg/,"an old ST target is replaced by an eligible stock on load");
nodes.clear();
const {readFileSync} = require("node:fs");
const vm = require("node:vm");
const storage = new Map([["limit-up-archive.recent-stocks.v1", JSON.stringify([{code: "600099", name: "检索记录"}])]]);
const app = readFileSync(require.resolve("../web/app.js"), "utf8");
const storageContext = vm.createContext({localStorage: {
  getItem: key => storage.get(key),
  setItem: (key, value) => storage.set(key, value),
}});
vm.runInContext(app.slice(app.indexOf("const RECENT_STOCKS_KEY"), app.indexOf("function marketValue")), storageContext);
const historyKey = vm.runInContext("RECENT_TREND_TARGETS_KEY", storageContext);
const targetHistory = {
  read: () => storageContext.readRecentStocks(historyKey),
  remember: (stock, previous) => storageContext.rememberRecentStock(historyKey, stock, previous),
};
const historyDate = "2026-11-11";
const historyPayload = compact(historyDate);
const targets = Array.from({length: 12}, (_, i) => ({...historyPayload.rows[0], code: String(600100 + i), name: "目标" + i}));
historyPayload.rows = targets;
const historyRoot = node("history-root");
historyRoot.querySelector = selector => node(selector.replace(/^#/, ""));
const historyOptions = {targetHistory, getContext: () => ({date: historyDate, dates, code: targets[0].code}), loadData: async () => historyPayload};
await demo.mount(historyRoot, historyOptions).syncContext();
const historyList = node("demo-recent-target-list");
const recentCodes = () => [...historyList.innerHTML.matchAll(/data-demo-recent-target="(\d{6})"/g)].map(match => match[1]);
assert.equal(node("demo-recent-targets").hidden, false);
assert.deepEqual(recentCodes(), ["600100"]);
for (const target of targets.slice(1))
  historyRoot.listeners.get("change")({target: {dataset: {demoSource: target.code}}});
assert.deepEqual(recentCodes(), targets.slice(2).map(target => target.code).reverse(), "show the ten most recently used targets");
const olderTarget = {dataset: {demoRecentTarget: "600105"}, closest() {return this;}};
historyRoot.listeners.get("click")({target: olderTarget});
assert.equal(node("demo-date").value, historyDate);
assert.equal(node("demo-source-summary").textContent, "目标5 600105");
assert.equal(recentCodes()[0], "600105");
assert.equal(recentCodes().length, 10);
assert.match(historyList.innerHTML, /data-demo-recent-target="600105" aria-pressed="true"/);
assert.equal(storageContext.readRecentStocks()[0].code, "600099", "trend history has its own storage key");
await demo.mount(historyRoot, {...historyOptions, getContext: () => ({date: historyDate, dates, code: "600105"})}).syncContext();
assert.equal(recentCodes()[0], "600105", "reopening the page restores the target history");
assert.equal(recentCodes().length, 10);
console.log("Intraday brush: ranked full-day charts, score bands and counts, pagination, bounded candidate collection, ST/GEM exclusions, cached reuse, explicit retries, live held-pointer updates, stale-date isolation, independent limits and volume, unrestricted brush and target search passed.");

}
checkUI().catch(error=>{console.error(error);process.exitCode=1;});
