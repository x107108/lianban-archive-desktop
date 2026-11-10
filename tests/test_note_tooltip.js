// Full note histories are fetched on hover, escaped, bounded and protected from stale replies.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const tooltip = {innerHTML:"",hidden:true,style:{},scrollTop:0,getBoundingClientRect:()=>({width:560,height:300})};
const pending=[];
const context=vm.createContext({$:()=>tooltip,state:{requests:{}},URLSearchParams,setTimeout,clearTimeout,
  window:{innerWidth:1236,innerHeight:1044},
  request:(route,channel)=>new Promise((resolve,reject)=>pending.push({route,channel,resolve,reject}))});
vm.runInContext(source.slice(source.indexOf("function escapeHTML"),source.indexOf("function textValue")),context);
vm.runInContext(source.slice(source.indexOf("function hideStockNoteTooltip"),source.indexOf("function openStockEditor")),context);
function anchor(code,filled=true){
  const attributes={};
  return {attributes,dataset:{editStockNote:code},isConnected:true,classList:{contains:()=>filled},
    getBoundingClientRect:()=>({left:1140,top:980,bottom:1005}),
    setAttribute:(name,value)=>attributes[name]=value,removeAttribute:name=>delete attributes[name]};
}
const a=anchor("601811"),b=anchor("600001"),empty=anchor("000678",false);
const rows=[{occurred_at:"2026-10-25T22:00:01+08:00",content:"最新 <script>纯文本</script>\n完整第二行"},
  {occurred_at:"2026-10-20T09:30:00+08:00",content:"较早的备注也显示"},
  {occurred_at:"2026-10-19T09:00:00+08:00",note_date:"",content:""}];
(async()=>{
  const first=context.showStockNoteTooltip(a);
  assert.equal(tooltip.hidden,false);
  assert.ok(tooltip.innerHTML.includes("正在读取全部备注"));
  await context.showStockNoteTooltip(a);
  assert.equal(pending.length,1,"pointer and focus on the same anchor share the pending read");
  assert.equal(pending[0].route,"/api/stock-note?code=601811");
  assert.equal(pending[0].channel,"stock-note-tooltip");
  pending[0].resolve({entries:rows});await first;
  assert.equal((tooltip.innerHTML.match(/role="listitem"/g)||[]).length,3);
  assert.ok(tooltip.innerHTML.includes("2026-10-20")&&tooltip.innerHTML.includes("较早的备注也显示"));
  assert.ok(!tooltip.innerHTML.includes("22:00:01")&&!tooltip.innerHTML.includes("09:30:00"),"the tooltip displays dates without hours, minutes or seconds");
  assert.ok(!tooltip.innerHTML.includes("未设置")&&!tooltip.innerHTML.includes("stock-note-tooltip-heading"),"the tooltip has no column headers or absent-date placeholder");
  assert.equal((tooltip.innerHTML.match(/<time /g)||[]).length,2,"only notes with a date render a date label");
  assert.ok(tooltip.innerHTML.includes("&lt;script&gt;纯文本&lt;/script&gt;\n完整第二行")&&!tooltip.innerHTML.includes("<script>"));
  assert.ok(tooltip.innerHTML.includes("（空备注）"));
  assert.ok(parseFloat(tooltip.style.left)+560<=1236-12,"right-edge tooltip stays inside the viewport");
  assert.ok(parseFloat(tooltip.style.top)+300<980,"bottom-edge tooltip opens above its anchor");
  assert.ok(parseFloat(tooltip.style.maxHeight)<=360);
  assert.equal(a.attributes["aria-describedby"],"stock-note-tooltip");
  context.hideStockNoteTooltip();
  assert.equal(a.attributes["aria-describedby"],undefined);
  const old=context.showStockNoteTooltip(a),latest=context.showStockNoteTooltip(b);
  pending[2].resolve({entries:[{occurred_at:"2026-10-25T21:00:00+08:00",content:"股票乙的全部备注"}]});await latest;
  pending[1].resolve({entries:rows});await old;
  assert.ok(tooltip.innerHTML.includes("股票乙的全部备注")&&!tooltip.innerHTML.includes("较早的备注"),"late replies cannot replace the current stock");
  const closed=context.showStockNoteTooltip(a);context.hideStockNoteTooltip();pending[3].resolve({entries:rows});await closed;
  assert.equal(tooltip.hidden,true,"a reply cannot reopen a dismissed tooltip");
  const failure=context.showStockNoteTooltip(a);pending[4].reject(new Error("private backend details"));await failure;
  assert.ok(tooltip.innerHTML.includes("暂时无法读取")&&!tooltip.innerHTML.includes("private backend"));
  context.hideStockNoteTooltip();
  const older=context.showStockNoteTooltip(empty);
  assert.equal(tooltip.hidden,true,"empty summaries do not flash a loading popup");
  pending[5].resolve({entries:[rows[1],rows[2]]});await older;
  assert.equal(tooltip.hidden,false,"history is still available after the latest note content was cleared");
  assert.ok(tooltip.innerHTML.includes(rows[1].content));
  context.hideStockNoteTooltip();
  const none=context.showStockNoteTooltip(empty);pending[6].resolve({entries:[]});await none;
  assert.equal(tooltip.hidden,true,"stocks without note history have no tooltip");
  await context.showStockNoteTooltip(anchor("bad"));assert.equal(pending.length,7);
  console.log("Full-history note tooltip: dates/content, empty entries, escaping, viewport bounds, refresh races, dismissal, failures and cleared summaries: passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
