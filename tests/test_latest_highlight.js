// Exercise the actual rendering functions with synthetic fixtures, without a browser or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map();
const context = vm.createContext({
  state: { meta: { latest_date: "2026-07-30" }, latestLimitUps: new Map([["000009", 3]]),
    grouping: "industry", relationLimits: { wins: 8, losses: 8, rounds: 8, common: 8 } },
  $: id => { if (!elements.has(id)) elements.set(id, { value: "" }); return elements.get(id); },
  stockTags: row => row.tags ?? (row.industry ? [row.industry] : []),
  icons: {search:""},
  relationStockButton: () => "", relationDateButton: () => ""
});
function load(from, to) { vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to)), context); }
load("function escapeHTML", "function debounce");
load("function emptyHTML", "function loadingHTML");
load("function stockTags", "function renderTagEditor");
load("function verificationBadge", "function renderChart");
assert.equal(context.normalizeRelationHeight(null),880);
assert.equal(context.normalizeRelationHeight("1040"),1040);
assert.equal(context.normalizeRelationHeight("500"),600);
assert.equal(context.normalizeRelationHeight("1900"),1600);
assert.equal(context.normalizeRelationHeight("invalid"),880);
assert.equal(context.readRelationHeight(),880,"unavailable browser storage keeps the default height");

const rows = Array.from({ length: 9 }, (_, i) => ({ code: `00000${i + 1}`, name: `样本${i + 1}`,
  count: 9 - i, date: "2026-07-23", boards: 2, last_date: "2026-07-23", rounds: [], dates: Array.from({length:9-i},(_,j)=>({date:`2026-07-${String(j+1).padStart(2,"0")}`,target_boards:2,peer_boards:2})) }));
Object.assign(rows[8], { registered_location: "天津", registered_province: "天津市", registered_address: "天津测试地址",
  initials: "YB9", industry: "传媒", tags: ["传媒", "自定义<&标签"], tags_customized: true });
const ranked = context.prioritizeLatest(rows);
assert.equal(ranked[0].code, "000009");
assert.equal(rows[0].code, "000001", "sorting must not mutate historical arrays");
assert.deepEqual(Array.from(ranked.slice(1), row => row.code), rows.slice(0, 8).map(row => row.code));
const currentRows = rows.map(row => ({ ...row, date: "2026-07-30" }));
assert.equal(context.prioritizeLatest(currentRows, true)[0].code, "000001", "latest-day view keeps normal ordering");

const competition = { wins: rows, losses: [], win_round_count: 17, loss_round_count: 0, pending_rounds: 0,
  scope_note: "synthetic", rounds: Array.from({length:17}, (_,i)=>({ date: `2026-06-${String(i+1).padStart(2,"0")}`, next_date: "2026-07-24", boards: 2,
    outcome: "win", wins: [rows[0], rows[8]], losses: [] })) };
context.state.relationships = { competition, cooccurrences: { rows, scope_note: "synthetic" } };
context.state.relationPeers = context.mergeRelationPeers(context.state.relationships);
assert.equal(context.state.relationPeers[0].initials, "YB9");
assert.equal(context.state.relationPeers[0].registered_province, "天津市");
assert.ok(!Object.hasOwn(context.state.relationPeers[0], "registered_address"));
assert.deepEqual(context.state.relationPeers[0].tags, ["传媒", "自定义<&标签"], "merging wins and common dates preserves current profile tags");
const peersBefore = JSON.stringify(context.state.relationships);
context.renderCompetition();
const competitionHTML = elements.get("competition-results").innerHTML;
assert.ok(competitionHTML.includes('aria-label="股票关联对比"'));
assert.ok(competitionHTML.includes('aria-label="去重后的关联股票列表"'));
assert.equal((competitionHTML.match(/data-select-peer=/g)||[]).length,9,"one row per stock across all relationship types");
assert.ok(competitionHTML.indexOf('data-select-peer="000009"') < competitionHTML.indexOf('data-select-peer="000001"'));
assert.ok(!competitionHTML.includes("competition-grid") && !competitionHTML.includes("data-relation-more"));
assert.equal((competitionHTML.match(/data-round-date=/g)||[]).length,0,"rounds moved out of stock comparison to their cycles");
assert.ok(!competitionHTML.includes("<details") && !competitionHTML.includes("<summary"));
const cycleData = {cycles:[
  {start:"2026-06-10",end:"2026-06-17",dates:Array.from({length:8},(_,i)=>`2026-06-${i+10}`),boards:8,end_known:true},
  {start:"2026-06-01",end:"2026-06-09",dates:Array.from({length:9},(_,i)=>`2026-06-0${i+1}`),boards:9,start_known:false}
],relationships:{competition}};
const cycleDataBefore = JSON.stringify(cycleData);
const cycleHTML = context.renderStockCycles(cycleData);
assert.equal((cycleHTML.match(/data-cycle-start=/g)||[]).length,2);
assert.equal((cycleHTML.match(/data-round-date=/g)||[]).length,17,"all original rounds appear exactly once within their cycle");
const cycleArticles=cycleHTML.split('data-cycle-start=');
assert.equal((cycleArticles[1].match(/data-round-date=/g)||[]).length,8);
assert.equal((cycleArticles[2].match(/data-round-date=/g)||[]).length,9);
assert.ok(cycleHTML.includes("周期边界待确认") && cycleHTML.includes("已结束"));
assert.ok(cycleHTML.includes('aria-label="全部逐轮竞争记录" tabindex="0"'));
assert.equal(JSON.stringify(cycleData),cycleDataBefore,"cycle grouping is presentation-only");
assert.ok(context.renderStockCycles({cycles:[]}).includes("暂无连板周期"));
const rangeOnlyCycle=context.renderStockCycles({cycles:[{start:"2026-06-01",end:"2026-06-03",boards:3}],relationships:{competition}});
assert.equal((rangeOnlyCycle.match(/data-round-date=/g)||[]).length,3,"cycle range fallback cannot include other periods");
const wheelCheck=(top,height,client,delta,ctrl=false)=>{
  let prevented=false;
  context.containRelationWheel({ctrlKey:ctrl,deltaY:delta,target:{closest:selector=>selector === ".relation-scroll" ? {scrollTop:top,scrollHeight:height,clientHeight:client} : null},preventDefault:()=>{prevented=true;}});
  return prevented;
};
assert.equal(wheelCheck(0,1000,300,-120),true,"upward wheel at top cannot reach page");
assert.equal(wheelCheck(700,1000,300,120),true,"downward wheel at bottom cannot reach page");
assert.equal(wheelCheck(0,200,300,120),true,"short lists also contain scrolling");
assert.equal(wheelCheck(300,1000,300,120),false,"normal wheel still scrolls internal list");
assert.equal(wheelCheck(0,1000,300,120),false);
assert.equal(wheelCheck(0,1000,300,-120,true),false,"browser zoom is not intercepted");
let outsidePrevented=false;
context.containRelationWheel({deltaY:120,target:{closest:()=>null},preventDefault:()=>{outsidePrevented=true;}});
assert.equal(outsidePrevented,false,"outside page scrolling stays available");
const horizontal = {scrollLeft:0,scrollWidth:1200,clientWidth:400};
function wheelAcross(deltaY,deltaMode=0,deltaX=0) {
  let prevented=false;
  context.containRelationWheel({ctrlKey:true,deltaY,deltaX,deltaMode,
    target:{closest:selector=>selector === ".peer-comparison-records" ? horizontal : null},
    preventDefault(){prevented=true;}});
  return prevented;
}
assert.equal(wheelAcross(120),true);
assert.equal(horizontal.scrollLeft,120,"Ctrl plus wheel moves the shared comparison canvas");
wheelAcross(2,1);assert.equal(horizontal.scrollLeft,152,"line-mode wheels use a readable distance");
wheelAcross(1,2);assert.equal(horizontal.scrollLeft,552,"page-mode wheels use the comparison viewport width");
wheelAcross(900);assert.equal(horizontal.scrollLeft,800,"horizontal scrolling stops at the right boundary");
wheelAcross(-2000);assert.equal(horizontal.scrollLeft,0,"horizontal scrolling stops at the left boundary");
wheelAcross(0,0,80);assert.equal(horizontal.scrollLeft,80,"horizontal wheel deltas remain supported");
assert.ok(competitionHTML.includes("07.30 涨停"));
assert.equal(context.state.relationPeerCode,"000009","latest-day pinned first stock is selected initially");
assert.equal(JSON.stringify(context.state.relationships),peersBefore,"merging does not alter source records");
const samePeer={code:"000009",name:"同一股票",rounds:[{date:"2026-07-01",next_date:"2026-07-02",boards:2}]};
const combined=context.mergeRelationPeers({competition:{wins:[samePeer,samePeer],losses:[{...samePeer,rounds:[{date:"2026-07-03",next_date:"2026-07-06",boards:3}]}]},cooccurrences:{rows:[{...samePeer,dates:[{date:"2026-07-01",target_boards:2,peer_boards:2},{date:"2026-07-03",target_boards:3,peer_boards:3}]},rows[0],{...rows[7],dates:[]}]}});
assert.equal(combined.filter(row=>row.code==="000009").length,1);
assert.equal(combined[0].code,"000009");
assert.deepEqual([combined[0].winCount,combined[0].lossCount,combined[0].commonCount],[1,1,2]);
const entries=context.peerComparisonEntries(combined[0]);
assert.equal(entries.length,2,"common dates and competition events on that date share a single record");
assert.deepEqual(Array.from(entries,row=>row.date),["2026-07-03","2026-07-01"]);
assert.equal(entries[0].losses.length,1);
assert.equal(entries[1].wins.length,1);
const comparison=context.peerComparisonHTML(combined[0]);
assert.ok(comparison.includes("正在整理双方完整连板周期"));
context.state.comparisonCache=new Map([[combined[0].code,{segments:combined[0].commonDates.map(day=>({start:day.date,end:day.date,common_dates:[day.date],target_dates:[{date:day.date,boards:day.target_boards}],peer_dates:[{date:day.date,boards:day.peer_boards}]}))}]]);
const loadedComparison=context.peerComparisonHTML(combined[0]);
assert.equal((loadedComparison.match(/data-comparison-start=/g)||[]).length,2);
assert.ok(loadedComparison.includes("本票晋级 3 板") && loadedComparison.includes("对方晋级 4 板"));
assert.ok(loadedComparison.includes("待行情核实"));
context.state.relationPeers=combined;
context.state.relationQuery="000009";
assert.equal(context.filteredRelationPeers().length,1);
context.state.relationQuery="no-match";
assert.equal(context.filteredRelationPeers().length,0);
context.state.relationQuery="";
const sortFixtures = [
  {code:"000009",name:"置顶甲",winCount:2,lossCount:1,commonCount:4,lastDate:"2026-07-06"},
  {code:"000008",name:"置顶乙",winCount:5,lossCount:3,commonCount:2,lastDate:"2026-07-06"},
  {code:"000001",name:"样本甲",winCount:3,lossCount:4,commonCount:6,lastDate:"2026-07-01"},
  {code:"000002",name:"样本乙",winCount:1,lossCount:5,commonCount:3,lastDate:"2026-07-01"},
  {code:"000004",name:"样本丁",winCount:3,lossCount:4,commonCount:6,lastDate:"2026-07-02"},
  {code:"000003",name:"样本丙",winCount:3,lossCount:4,commonCount:6,lastDate:"2026-07-02"}
];
const fixturesBeforeSort = JSON.stringify(sortFixtures);
context.state.relationPeers = sortFixtures;
context.state.latestLimitUps.set("000008",2);
const expectedSorts = {
  winCount:{desc:["000008","000009","000003","000004","000001","000002"],asc:["000009","000008","000002","000003","000004","000001"]},
  lossCount:{desc:["000008","000009","000002","000003","000004","000001"],asc:["000009","000008","000003","000004","000001","000002"]},
  commonCount:{desc:["000009","000008","000003","000004","000001","000002"],asc:["000008","000009","000002","000003","000004","000001"]}
};
for (const [key, directions] of Object.entries(expectedSorts)) {
  context.state.relationSort = "";
  assert.equal(context.setRelationSort(key),true);
  assert.equal(context.state.relationSortDirection,"desc","new metric starts descending");
  assert.deepEqual(Array.from(context.filteredRelationPeers(),row=>row.code),directions.desc,`${key} descending, pinned first, date/code ties stable`);
  assert.equal(context.setRelationSort(key),true);
  assert.equal(context.state.relationSortDirection,"asc","clicking again reverses direction");
  assert.deepEqual(Array.from(context.filteredRelationPeers(),row=>row.code),directions.asc,`${key} ascending within both priority groups`);
  const controls = context.relationSortButtonsHTML();
  assert.equal((controls.match(/aria-pressed="true"/g)||[]).length,1);
  assert.ok(controls.includes(`data-relation-sort="${key}" aria-pressed="true"`));
  assert.ok(controls.includes("当前升序") && controls.includes("↑"));
  assert.ok(context.relationSortNote().includes("升序"));
}
context.state.relationQuery = "样本";
assert.equal(context.filteredRelationPeers().length,4,"filter applies alongside current sorting");
assert.equal(JSON.stringify(sortFixtures),fixturesBeforeSort,"sorting leaves merged peer data unchanged");
const validSortBefore = context.state.relationSort;
assert.equal(context.setRelationSort("__proto__"),false);
assert.equal(context.state.relationSort,validSortBefore,"invalid sort keys cannot change current ordering");
context.state.relationQuery = "";
const filterFixtures = [
  {code:"600001",name:"普通主板",initials:"PTZB",winCount:1,lossCount:0,commonCount:2,lastDate:"2026-07-01"},
  {code:"600002",name:"* ST 样本",winCount:1,lossCount:0,commonCount:2,lastDate:"2026-07-01"},
  {code:"300001",name:"创业板甲",initials:"CYBJ",winCount:1,lossCount:0,commonCount:2,lastDate:"2026-07-01"},
  {code:"301001",name:"创业板乙",initials:"cyby",winCount:1,lossCount:0,commonCount:2,lastDate:"2026-07-01"},
  {code:"688001",name:"科创样本",winCount:1,lossCount:0,commonCount:2,lastDate:"2026-07-01"},
  {code:"000003",name:"st退样本",winCount:1,lossCount:0,commonCount:2,lastDate:"2026-07-01"}
];
filterFixtures.forEach(peer => Object.assign(peer,{commonDates:[],wins:[],losses:[]}));
const filterBefore = JSON.stringify(filterFixtures);
context.state.relationPeers = filterFixtures;
for (const [st,gem,expected] of [[false,false,6],[true,false,4],[false,true,4],[true,true,2]]) {
  Object.assign(context.state,{relationExcludeST:st,relationExcludeGEM:gem});
  assert.equal(context.filteredRelationPeers().length,expected,"relationship ST and GEM filters work independently and together");
}
assert.ok(context.filteredRelationPeers().some(peer=>peer.code==="688001"),"GEM filtering keeps STAR stocks");
context.state.relationQuery="创业板";
assert.equal(context.filteredRelationPeers().length,0,"name filtering cannot reintroduce excluded stocks");
context.state.relationQuery="cyb";
assert.equal(context.filteredRelationPeers().length,0,"initials filtering cannot reintroduce excluded stocks either");
Object.assign(context.state,{relationExcludeST:false,relationExcludeGEM:false});
for (const [query, codes] of [["ptzb",["600001"]], [" PTZ ",["600001"]], ["普通",["600001"]],
  ["600001",["600001"]], ["CyB",["300001","301001"]], ["undefined",[]]]) {
  context.state.relationQuery=query;
  assert.deepEqual(Array.from(context.filteredRelationPeers(),peer=>peer.code),codes,
    "peer searches support case-insensitive full/partial initials, trimmed input, existing names/codes and missing initials");
}
Object.assign(context.state,{relationExcludeST:true,relationExcludeGEM:true});
context.state.relationQuery="";
context.state.relationPeerCode="600002";
context.renderComparisonWorkspace();
assert.equal(context.state.relationPeerCode,"600001","an excluded selection moves to the first visible peer");
context.state.relationPeers=filterFixtures.filter(peer=>peer.code==="600002");
const noVisiblePeers=context.renderComparisonWorkspace();
assert.equal(context.state.relationPeerCode,"");
assert.ok(noVisiblePeers.includes("当前筛选下没有关联股票"),"all-hidden cases offer a clear empty state");
assert.equal(JSON.stringify(filterFixtures),filterBefore,"filters never change source facts or counts");
Object.assign(context.state,{relationExcludeST:false,relationExcludeGEM:false});
context.state.latestLimitUps.delete("000008");
context.state.relationPeers = combined;
context.state.relationSort = "commonCount";
context.state.relationSortDirection = "desc";
const peerHTML = context.renderRoundPeer(rows[8]);
assert.ok(peerHTML.includes("天津") && peerHTML.includes("传媒"));
assert.ok(!peerHTML.includes("天津测试地址"), "detailed addresses are never rendered");
assert.ok(peerHTML.includes("自定义&lt;&amp;标签"), "custom profile labels must be safely escaped");
assert.ok(peerHTML.includes("当前股票标签"), "the tooltip covers merged default and custom labels");
assert.ok(context.renderRoundPeer(rows[0]).includes("地区待补充"));
assert.ok(context.renderRoundPeer(rows[0]).includes("行业待补充"));
const cohortMembers = [
  {code:"600001",name:"本票",is_target:true,promotion_status:"not_in_pool"},
  {code:"000002",name:"晋级甲",promotion_status:"advanced",next_boards:3},
  {code:"000003",name:"晋级乙",promotion_status:"advanced",next_boards:3},
  {code:"000004",name:"其他同批",promotion_status:"other_height",next_boards:1}
];
const cohortBefore=JSON.stringify(cohortMembers);
const groupedRound=context.renderCompetitionRounds({rounds:[{date:"2026-07-23",next_date:"2026-07-24",boards:2,
  status:"compared",outcome:"loss",wins:[],losses:cohortMembers.slice(1,3),cohort:cohortMembers}]});
assert.ok(groupedRound.indexOf('data-cohort-group="advanced"')<groupedRound.indexOf('data-cohort-group="others"'),"promoted stocks occupy their own first group");
assert.equal((groupedRound.match(/data-relation-code=/g)||[]).length,4,"layout groups must retain every cohort member exactly once");
assert.ok(groupedRound.includes("晋级 3 板") && groupedRound.includes("同梯队其他股票"));
const roundHeader = groupedRound.match(/<header class="competition-round-heading">[\s\S]*?<\/header>/)[0];
assert.ok(roundHeader.indexOf('competition-round-date') < roundHeader.indexOf('本票次日未入池'), "the result explanation follows the date inside the heading");
assert.ok(roundHeader.includes('待行情核实'), "moving the explanation keeps its evidence qualification");
assert.equal((groupedRound.match(/本票次日未入池/g)||[]).length, 1, "the body no longer repeats the explanation");
assert.ok(!groupedRound.includes('class="round-promotion"') && !groupedRound.includes("round-advanced"),"promotion is shown by grouping instead of card colors or badges");
for(const status of ["not_in_pool","other_height","pending"]){
  const normalCard=context.renderRoundPeer({...cohortMembers[3],promotion_status:status});
  assert.ok(!normalCard.includes("次日未入池") && !normalCard.includes("待后续结果") && !normalCard.includes("round-promotion"),"non-promoted cards retain ordinary content");
}
const pendingRound=context.renderCompetitionRounds({rounds:[{date:"2026-07-23",boards:2,status:"cutoff",outcome:"cutoff",wins:[],losses:[],cohort:[{...cohortMembers[0],promotion_status:"pending"}]}]});
assert.ok(!pendingRound.includes("data-cohort-group"),"unknown promotion results must not create an empty promoted group");
assert.equal(JSON.stringify(cohortMembers),cohortBefore,"layout changes cannot alter promotion evidence");
context.state.latestLimitUps.set("000008",2);
const priorityMembers = [cohortMembers[0],cohortMembers[1],cohortMembers[3],
  {code:"000009",name:"最新晋级",promotion_status:"advanced"},
  {code:"000008",name:"最新其他",promotion_status:"not_in_pool"}];
const priorityBefore=JSON.stringify(priorityMembers);
const priorityRound=context.renderCompetitionRounds({rounds:[{date:"2026-07-23",next_date:"2026-07-24",boards:2,
  status:"compared",outcome:"unresolved",wins:[],losses:[],cohort:priorityMembers}]});
const advancedGroup=priorityRound.split('data-cohort-group="advanced"')[1].split('</section>')[0];
const otherGroup=priorityRound.split('data-cohort-group="others"')[1].split('</section>')[0];
assert.ok(advancedGroup.indexOf('data-relation-code="000009"') < advancedGroup.indexOf('data-relation-code="000002"'));
assert.ok(otherGroup.indexOf('data-relation-code="000008"') < otherGroup.indexOf('data-relation-code="600001"'),"latest limit-ups precede the unhighlighted target within every cohort group");
const pendingPriority=context.renderCompetitionRounds({rounds:[{date:"2026-07-23",boards:2,status:"cutoff",outcome:"cutoff",
  wins:[],losses:[],cohort:priorityMembers.map(peer=>({...peer,promotion_status:"pending"}))}]});
assert.ok(pendingPriority.indexOf('data-relation-code="000008"') < pendingPriority.indexOf('data-relation-code="600001"'),"ungrouped pending rounds also pin latest-day limit-ups");
assert.equal(JSON.stringify(priorityMembers),priorityBefore,"pinning does not change cohort members or historical outcomes");
context.state.latestLimitUps.delete("000008");
assert.ok(context.verificationBadge().includes("未入池不等于未涨停"));
const mixedRounds = context.renderCompetitionRounds({rounds: [
  {date:"2026-07-29", next_date:"2026-07-30", boards:10, peer_count:0, outcome:"no_peers", wins:[], losses:[]},
  competition.rounds[0]
]});
const noPeerRound = mixedRounds.match(/<article class="competition-round competition-round-compact"[\s\S]*?<\/article>/)[0];
assert.ok(noPeerRound.includes("10 进 11") && noPeerRound.includes("2026.07.29 → 2026.07.30") && noPeerRound.includes("无同级对手"));
assert.ok(!noPeerRound.includes("competition-round-body") && !noPeerRound.includes("competition-round-actions"));
assert.equal((mixedRounds.match(/class="competition-round-body"/g)||[]).length, 1, "rounds with opponents keep their evidence");
const solo = (date, next, boards) => ({date, next_date:next, boards, outcome:"no_peers", wins:[], losses:[], peer_count:0});
const consecutiveSolo = [
  solo("2026-10-12", "2026-10-13", 10), solo("2026-10-09", "2026-10-12", 9),
  solo("2026-10-08", "2026-10-09", 8), solo("2026-09-30", "2026-10-08", 7),
  solo("2026-09-29", "2026-09-30", 6), solo("2026-09-28", "2026-09-29", 5),
  competition.rounds[0]
];
const soloBefore = JSON.stringify(consecutiveSolo);
const mergedSolo = context.renderCompetitionRounds({rounds:consecutiveSolo});
assert.equal((mergedSolo.match(/data-round-date=/g)||[]).length, 2);
assert.ok(mergedSolo.includes("5 进 11") && mergedSolo.includes("2026.09.28 → 2026.10.13"));
assert.ok(mergedSolo.includes('data-round-count="6"'));
assert.ok(mergedSolo.includes("共 7 轮 · 合并展示 2 条"));
assert.equal(JSON.stringify(consecutiveSolo), soloBefore, "merging display ranges cannot change original rounds");
const disconnectedSolo = context.renderCompetitionRounds({rounds:[
  solo("2026-10-12", "2026-10-13", 10), solo("2026-09-28", "2026-09-29", 9),
  competition.rounds[0], solo("2026-09-25", "2026-09-28", 8)
]});
assert.equal((disconnectedSolo.match(/competition-round-compact/g)||[]).length, 3,
  "separate cycles, date gaps and intervening opponents cannot be merged");

const dailyHTML = context.renderIndustryColumns(rows);
assert.ok(dailyHTML.indexOf('data-card-code="000009"') < dailyHTML.indexOf('data-card-code="000001"'));
assert.ok(dailyHTML.includes('class="industry-stock latest-limit-up"'));
assert.ok(!context.renderStockCard(currentRows[8]).includes("latest-limit-up"));
const retainedHTML = context.renderSuspendedLeaders([{ ...rows[0], boards: 10, suspended: true,
  board_date: "2026-07-23", resume_date: "2026-07-31" }]);
assert.ok(retainedHTML.includes('aria-label="停牌保留高度"'));
assert.ok(retainedHTML.includes("未计入当日涨停家数"));
assert.ok(retainedHTML.includes('aria-label="停牌信息"'));
assert.ok(retainedHTML.includes('末次涨停</dt><dd><time datetime="2026-07-23">2026.07.23</time>'));
assert.ok(retainedHTML.includes('预计复牌</dt><dd><time datetime="2026-07-31">2026.07.31</time>'));
console.log("Latest-day priority, unique peers, win/loss/common sorting in both directions, merged evidence and scrollable records: passed.");
