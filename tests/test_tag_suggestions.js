// Real autocomplete handlers: live fuzzy filtering, keyboard/IME, async races and drafts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname,"../web/app.js"),"utf8");
const elements = new Map(), listeners = new Map(), calls = [];
const rect = {left:232,bottom:410,width:470};
function $(id) {
  if (!elements.has(id)) {
    const el = {value:"",hidden:false,disabled:false,open:false,textContent:"",style:{},options:[],validation:"",
      setAttribute(name,value) {this[name]=value;},removeAttribute(name) {delete this[name];},
      setCustomValidity(value) {this.validation=value;}, reportValidity() {return !this.validation;},
      getBoundingClientRect:() => rect,focus() {this.focused=true;},
      showModal() {this.open=true;},close() {this.open=false;},
      addEventListener(type,listener) {listeners.set(`${id}:${type}`,listener);},
      contains(target) {return this.options.includes(target);},
      querySelectorAll() {return this.options;},querySelector(selector) {return this.options.find(option=>selector.includes(`"${option.index}"`));}
    };
    let markup="";
    Object.defineProperty(el,"innerHTML",{get:()=>markup,set(value) {
      markup=value;
      el.options=[...value.matchAll(/data-existing-tag-index="([0-9]+)"/g)].map(match=>({index:Number(match[1]),
        setAttribute(name,value) {this[name]=value;},scrollIntoView() {this.scrolled=true;}}));
    }});
    elements.set(id,el);
  }
  return elements.get(id);
}
let catalog={tags:[{name:"机器人",count:702},{name:"人工智能",count:525},{name:"AI应用",count:350},{name:"军工",count:314},{name:"人形机器人",count:203},{name:"<危险标签>",count:1}],revision:"v1"};
const stock={code:"600668",name:"样本股",tags:["已有"],source_tags:[],revision:1};
const context=vm.createContext({$,clearTimeout,state:{requests:{},meta:{},tagDraft:[]},URLSearchParams,
  window:{innerWidth:1004,innerHeight:747,addEventListener(type,fn) {listeners.set(`window:${type}`,fn);}},
  document:{addEventListener(type,fn) {listeners.set(`document:${type}`,fn);}},
  canEditTags:()=>true,canEditNotes:()=>false,canEditBlacklist:()=>true,
  async request(url,channel) {calls.push({url,channel}); if(context.override) return context.override(url); return url==="/api/tags" ? catalog : stock;}
});
function load(from,to) {vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),context);}
load("function escapeHTML","const RECENT_STOCKS_KEY");
load("function stockTags","function canEditTags");
load("function renderTagEditor","function renderTable");
context.loadEditorNotes = async () => {};
load('$("tag-new").addEventListener("input"','$("add-tag").addEventListener');
function type(value) {$("tag-new").value=value;listeners.get("tag-new:input")();}
function key(key,extra={}) {const event={key,preventDefault() {this.prevented=true;},stopPropagation() {this.stopped=true;},...extra};listeners.get("tag-new:keydown")(event);return event;}
const names=()=>Array.from(context.state.tagSuggestionRows || [],tag=>tag.name);
(async()=>{
  await context.openStockEditor("600668");
  assert.equal($("tag-new").disabled,false);
  assert.equal($("add-tag").disabled,true);
  type("   ");
  assert.equal($("add-tag").disabled,true);
  assert.equal($("tag-dialog").open,true);
  const requestsAfterOpen=calls.length;
  type("机");
  assert.equal($("add-tag").disabled,false);
  assert.deepEqual(names(),["机器人","人形机器人"],"matches keep catalog count order");
  assert.equal($("tag-new-suggestions").hidden,false);
  assert.equal($("tag-new")["aria-expanded"],"true");
  assert.match($("tag-new-suggestions").innerHTML,/702 只股票/);
  assert.equal($("tag-new-suggestions").style.top,"415px","popup anchors below the input");
  assert.equal($("tag-new-suggestions").style.width,"470px");
  type("人机");assert.deepEqual(names(),["人形机器人"],"Chinese fuzzy matching supports intervening characters");
  type("ai");assert.deepEqual(names(),["AI应用"],"Latin matching ignores case");
  assert.equal(calls.length,requestsAfterOpen,"typing searches the loaded catalog immediately without extra requests");
  const click=listeners.get("tag-new-suggestions:click");
  click({target:{closest:()=>({dataset:{existingTagIndex:"0"}})}});
  assert.deepEqual(Array.from(context.state.tagDraft),["已有","AI应用"]);
  assert.equal($("tag-new").value,"");
  assert.equal($("add-tag").disabled,true);
  assert.equal($("tag-new-suggestions").hidden,true);
  assert.deepEqual(stock.tags,["已有"],"selection changes the draft, not the loaded stock or server");
  assert.ok(calls.every(call=>call.url==="/api/tags" || call.url.startsWith("/api/stock-tags?")));
  type("ai");assert.deepEqual(names(),[],"already selected tags are excluded");
  type("机");key("ArrowDown");
  assert.equal($("tag-new")["aria-activedescendant"],"tag-existing-option-0");
  assert.equal($("tag-new-suggestions").options[0]["aria-selected"],"true");
  key("ArrowUp");key("Enter");
  assert.ok(context.state.tagDraft.includes("人形机器人"));
  type("机");assert.deepEqual(names(),["机器人"]);
  const draftCount=context.state.tagDraft.length;
  key("Enter",{isComposing:true});key("Enter",{keyCode:229});
  assert.equal(context.state.tagDraft.length,draftCount,"IME confirmation never adds an incomplete label");
  const escape=key("Escape");
  assert.equal(escape.stopped,true);assert.equal($("tag-dialog").open,true);
  assert.equal($("tag-new-suggestions").hidden,true);
  type("全新自定义");assert.match($("tag-new-suggestions").innerHTML,/可直接添加新标签/);
  key("Enter");assert.ok(context.state.tagDraft.includes("全新自定义"));
  assert.equal($("add-tag").disabled,true);
  type("<危险");assert.match($("tag-new-suggestions").innerHTML,/&lt;危险标签&gt;/);
  assert.ok(!$("tag-new-suggestions").innerHTML.includes("<危险标签>"));
  context.window.innerHeight=500;listeners.get("window:resize")();
  assert.equal($("tag-new-suggestions").style.maxHeight,"73px","popup fits the viewport below the input");
  listeners.get("document:pointerdown")({target:{closest:()=>null}});
  assert.equal($("tag-new-suggestions").hidden,true);
  type("");assert.equal($("tag-new-suggestions").hidden,true);
  assert.equal($("add-tag").disabled,true);

  let resolveOld;
  context.override=()=>new Promise(resolve=>{resolveOld=resolve;});
  const old=context.loadTagSuggestionCatalog();
  context.state.tagEditingCode="000002";
  context.override=null;catalog={tags:[{name:"新列表",count:2}],revision:"v2"};
  await context.loadTagSuggestionCatalog();
  resolveOld({tags:[{name:"过期列表",count:4}],revision:"old"});await old;
  assert.equal(context.state.tagSuggestionCatalog.revision,"v2","a slower older dialog request cannot overwrite current choices");
  context.override=async()=>{throw Error("offline");};
  await context.loadTagSuggestionCatalog();
  type("无匹配");assert.match($("tag-new-suggestions").innerHTML,/暂时无法读取/);
  key("Enter");assert.ok(context.state.tagDraft.includes("无匹配"),"catalog failure retains manual additions");
  context.override=()=>new Promise(resolve=>{resolveOld=resolve;});
  const closed=context.loadTagSuggestionCatalog();
  context.closeStockEditor();
  resolveOld({tags:[{name:"关闭后返回",count:1}],revision:"closed"});await closed;
  assert.equal($("tag-new-suggestions").hidden,true);
  assert.equal(context.state.tagSuggestionCatalog,null);
  context.override=null;
  catalog={tags:[{name:"机器人",count:700},{name:"电机",count:60},{name:"伺服系统",count:40},{name:"精密驱动",count:20},{name:"无关标签",count:10},{name:"<父级>",count:2},{name:"测试子级",count:1}],revision:"hierarchy",
    hierarchy:[{name:"机器人",parent:""},{name:"电机",parent:"机器人"},{name:"伺服系统",parent:"电机"},{name:"精密驱动",parent:"伺服系统"},{name:"测试子级",parent:"<父级>"}]};
  await context.openStockEditor("600668");
  type("电机");
  assert.deepEqual(names(),["电机","伺服系统","精密驱动"],"a parent match includes all descendants even when their own names do not match");
  assert.ok($("tag-new-suggestions").innerHTML.includes('机器人 / </span><span>电机</span>'));
  assert.ok($("tag-new-suggestions").innerHTML.includes('机器人 / 电机 / 伺服系统 / </span><span>精密驱动</span>'),"child candidates display their complete ancestor path");
  type("机器人");assert.deepEqual(names(),["机器人","电机","伺服系统","精密驱动"]);
  context.chooseExistingTag(1);
  assert.ok(context.state.tagDraft.includes("电机")&&!context.state.tagDraft.includes("机器人"),"choosing a child does not add the displayed path or parent");
  context.state.tagDraft.push("机器人");type("机器人");
  assert.deepEqual(names(),["伺服系统","精密驱动"],"a selected parent still expands its descendants while selected labels stay excluded");
  type("测试子级");
  assert.ok($("tag-new-suggestions").innerHTML.includes('&lt;父级&gt; / ')&&!$("tag-new-suggestions").innerHTML.includes('<父级>'));
  key("ArrowDown");key("Enter");assert.ok(context.state.tagDraft.includes("测试子级"),"keyboard selection uses the leaf tag name");
  context.state.tagDraft=["已有"];
  type("机器人/");assert.deepEqual(names(),["电机"],"slash lists direct children, excluding the parent and deeper descendants");
  type("机器人/电");assert.deepEqual(names(),["电机"],"slash filters the child name within the chosen parent");
  type("机器人/无关");assert.deepEqual(names(),[],"unrelated tags are excluded even if their own name matches");
  type("机器人/电机/");assert.deepEqual(names(),["伺服系统"],"nested slash paths search the next level");
  type("电机/");assert.deepEqual(names(),["伺服系统"],"an existing nested tag may be used as the starting parent");
  key("ArrowDown");key("Enter");assert.ok(context.state.tagDraft.includes("伺服系统"));
  type("机器人/");key("Enter");assert.match($("tag-new").validation,/斜杠前后/);
  assert.ok(!context.state.tagDraft.some(tag=>tag.endsWith("/")),"a trailing slash only searches and never creates an empty label");
  const beforePathAdd=calls.length;
  type("机器人/新电机");key("Enter");assert.ok(context.state.tagDraft.includes("机器人/新电机"));
  assert.ok($("tag-editor-list").innerHTML.includes('value="新电机"'),"only the leaf name is editable in a path draft");
  type("新电机");key("Enter");assert.match($("tag-new").validation,/已存在/);
  type("新父级/新子级/新末级");key("Enter");assert.ok(context.state.tagDraft.includes("新父级/新子级/新末级"));
  type("机器人//空级");key("Enter");assert.match($("tag-new").validation,/斜杠前后/);
  assert.equal(calls.length,beforePathAdd,"creating paths is draft-only until Save, so cancellation never writes hierarchy");
  context.closeStockEditor();
  console.log("Tag autocomplete: live fuzzy/case search, draft-only selection, global order, keyboard/IME, escaping, viewport, empty/error and stale dialog responses: passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
