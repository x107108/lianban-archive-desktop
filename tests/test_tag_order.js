// Tag labels share the archive order; industry columns prioritize the day's leaders.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname,"../web/app.js"),"utf8");
const elements = new Map();
function $(id) {
  if (!elements.has(id)) elements.set(id,{innerHTML:"",textContent:"",hidden:false,
    setAttribute() {},removeAttribute() {},querySelectorAll:() => []});
  return elements.get(id);
}
const context = vm.createContext({$,hideStockNoteTooltip(){},state:{grouping:"industry",meta:{tag_order:["大标签","小标签","自定义"],latest_date:"2026-10-21"}}});
function load(from,to) { vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),context); }
load("function escapeHTML","function debounce");
load("function stockTags","function renderTagEditor");
load("function renderTagEditor","function updateTagEditorControls");
load("function renderStockProfile","function renderStock(data)");
load("function renderRoundPeer","function renderCompetitionRounds");
load("function renderMinuteProfile","function renderMinuteList");
load("function canEditBlacklist","function blacklistError");
load("function updateBlacklistControls","async function loadBlacklist");
const stock = {code:"000001",name:"样本甲",date:"2026-10-21",initials:"YBJ",tags:["自定义","小标签","大标签"],boards:4,created_at:"2026-10-21T12:00:00"};
const before = JSON.stringify(stock);
const ordered = html => {
  assert.ok(html.indexOf('>大标签<') < html.indexOf('>小标签<'),"larger global membership comes first");
  assert.ok(html.indexOf('>小标签<') < html.indexOf('>自定义<'));
};
assert.deepEqual(Array.from(context.stockTags(stock)),["大标签","小标签","自定义"]);
ordered(context.renderStockCard(stock));
context.renderStockProfile(stock);
ordered($("stock-industry-tags").innerHTML);
context.renderMinuteProfile(stock);
ordered($("minute-stock-tags").innerHTML);
ordered(context.renderRoundPeer(stock));
context.renderBlacklist({rows:[stock],total:1});
ordered($("blacklist-table-area").innerHTML);
const cohorts = [{...stock,boards:1},{...stock,code:"000002",name:"样本乙",boards:8,tags:["小标签"]}];
const columns = context.renderIndustryColumns(cohorts);
const labels = [...columns.matchAll(/data-group-label="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(labels.slice(0,3),["小标签","大标签 / 自定义","小标签"],"one shared tag keeps the stock out of solitary; private tags continue normal merged presentation");
context.state.tagDraft = [...stock.tags];
context.renderTagEditor();
assert.deepEqual([...$("tag-editor-list").innerHTML.matchAll(/data-tag-index="([0-9]+)"/g)].map(match => match[1]),["2","1","0"],"sorted editor fields retain their original edit/delete indices");
assert.deepEqual(Array.from(context.state.tagDraft),stock.tags,"rendering does not reorder the draft payload");
assert.equal(JSON.stringify(stock),before,"global presentation order does not rewrite custom or source records");
context.applyTagOrder({tags:[{name:"自定义",count:100},{name:"小标签",count:20},{name:"大标签",count:10}],revision:"new"});
assert.deepEqual(Array.from(context.stockTags(stock)),["自定义","小标签","大标签"],"updated catalog invalidates the shared rank cache");
assert.deepEqual(Array.from(context.stockTags({tags:["未入库乙","小标签","未入库甲"]})),["小标签","未入库乙","未入库甲"],"new tags have a deterministic fallback after verified ranks");
context.state.grouping = "region";
assert.ok(context.renderIndustryColumns(cohorts).includes('data-group-label="地区待补充"'),"regional grouping keeps its own meaning");
console.log("Global tag labels, daily leader column priority, stable drafts and cache refresh: passed.");
