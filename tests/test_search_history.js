// Exercise the actual MRU storage and typed-query resolution flows without a browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map(), storage = new Map(), requests = [];
const element = id => {
  if (!elements.has(id)) elements.set(id, {value:"", hidden:false,
    setAttribute(){}, setCustomValidity(value){this.validity=value;}, reportValidity(){this.reported=true;}});
  return elements.get(id);
};
let suggestions = [], fail = false, denyStorage = false;
const stock = {code:"600802", name:"福建水泥", initials:"FJSN"};
const context = vm.createContext({
  URLSearchParams, state:{requests:{},suggestions:[],recentStocks:[],tab:"date"}, $:element,
  localStorage:{getItem:key=>{if(denyStorage)throw Error("disabled");return storage.get(key)||null;},
                setItem:(key,value)=>{if(denyStorage)throw Error("disabled");storage.set(key,value);}},
  hideSuggestions(){}, clearError(){}, setStats(){}, updateURL(){}, renderStockProfile(){}, loadShareholderAlerts(){},
  setView(view){context.state.tab=view;}, loadingHTML:()=>"loading", emptyHTML:()=>"empty",
  showError(error){context.error=error.message;},
  renderStock(data){context.state.selectedStock=data.stock;},
  request:async(url,channel)=>{
    requests.push({url,channel});
    if(url.startsWith("/api/stocks?"))return {rows:suggestions};
    if(fail)throw Error("offline");
    return {stock:context.state.selectedStock,rows:[{date:"2026-10-16"}]};
  }
});
function load(from,to){vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),context);}
load("function escapeHTML","function numberValue");
load("const RECENT_STOCKS_KEY","function marketValue");
load("async function loadStock","function renderStockProfile");
for(let i=0;i<12;i++)context.rememberStock({code:String(600000+i),name:`测试${i}`});
assert.equal(context.state.recentStocks.length,10);
assert.equal(context.state.recentStocks[0].code,"600011");
assert.equal(context.state.recentStocks.at(-1).code,"600002");
context.rememberStock({code:"600005",name:"更新名称"});
assert.equal(context.state.recentStocks[0].name,"更新名称");
assert.equal(context.state.recentStocks.filter(x=>x.code==="600005").length,1);
assert.equal(context.readRecentStocks()[0].code,"600005","history survives a page reload");
assert.equal(context.normalizeRecentStocks([null,{code:"bad",name:"坏数据"},{code:"600802",name:""}]).length,0);
storage.set("limit-up-archive.recent-stocks.v1","not json");
assert.equal(context.readRecentStocks().length,0);
context.rememberStock({code:"600802",name:"<&测试>"});
assert.ok(element("recent-stock-list").innerHTML.includes("&lt;&amp;测试&gt;"));
denyStorage=true;
context.rememberStock({code:"600803",name:"会话记录"});
assert.equal(context.state.recentStocks[0].code,"600803","blocked storage still allows this session");
denyStorage=false;
storage.clear();context.state.recentStocks=[];
(async()=>{
  element("stock-search").value="fjsn";suggestions=[stock];
  await context.loadStock();
  assert.ok(requests.some(x=>x.channel==="stock-resolve"));
  assert.ok(requests.some(x=>x.url==="/api/stock?code=600802"));
  assert.equal(context.state.recentStocks[0].name,"福建水泥");
  context.state.selectedStock={code:"600999",name:"失败查询"};fail=true;
  await context.loadStock();
  assert.equal(context.state.recentStocks[0].code,"600802","failed requests do not enter history");
  fail=false;
  context.state.selectedStock={code:"600999",name:"后台刷新"};
  await context.loadStock({remember:false});
  assert.equal(context.state.recentStocks[0].code,"600802","background refresh never reorders history");
  console.log("Pinyin submit, recent 10 unique stocks, persistence, invalid storage, and successful-visit recording: passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
