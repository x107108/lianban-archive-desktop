const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../web/app.js"), "utf8");
const calls = [];
let meta = {query_dates:["2026-11-20"], suspension_revision:1,live:{today:"2026-11-22"}};
const context = vm.createContext({
  state:{tab:"stock", meta:{...meta}},
  $:()=>({value:"2026-11-20"}), request:async()=>meta,
  renderMeta(){}, updateDateNavigation(){}, loadSiteLinks(){},
  loadStock:options=>calls.push(options),
  escapeHTML:String, numberValue:String, dateLabel:String,
  renderCompetitionRounds:()=>"", emptyHTML:()=>"empty",
});
function load(from,to) {vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),context);}
load("async function refreshMeta()", "function updateDateNavigation()");
load("function renderStockCycles(data)", "function containRelationWheel");
(async()=>{
  await context.refreshMeta();
  assert.equal(calls.length,0,"unchanged verification does not reload the stock");
  meta = {...meta,suspension_revision:2};
  await context.refreshMeta();
  assert.equal(calls.length,1,"completed suspension checks refresh the visible stock");
  assert.equal(calls[0].quiet,true,"automatic cycle updates keep existing content while loading");
  assert.equal(calls[0].remember,false,"background updates do not rewrite recent stocks");
  const cycle = {start:"2025-05-26",end:"2025-06-12",boards:8,dates:["2025-05-26","2025-06-12"],
    end_known:true,note:"停牌期间不计涨停天数，复牌后连续涨停计入同一周期。"};
  const html = context.renderStockCycles({cycles:[cycle],cycle_verification_pending:true});
  assert.ok(html.includes('role="status"') && html.includes("自动更新周期"));
  assert.equal((html.match(/data-cycle-start=/g)||[]).length,1,"checking retains the existing cycle card");
  const completed = context.renderStockCycles({cycles:[cycle]});
  assert.ok(!completed.includes('role="status"') && completed.includes("停牌期间不计涨停天数"));
  console.log("Suspension verification refresh checks passed");
})().catch(error=>{console.error(error);process.exitCode=1;});
