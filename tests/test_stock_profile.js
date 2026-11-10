// Use the real profile renderer and save flow with an isolated editor fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map();
const calls = [];
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: "", disabled: false,
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; }, reportValidity: () => true,
    querySelector: () => null, querySelectorAll: () => [], close() { calls.push("close"); } });
  return elements.get(id);
};
const context = vm.createContext({
  state: { tab: "stock", requests: {}, tagEditorData: { code: "000001", revision: 3, tags: [] },
    tagDraft: ["染料", "纺织", "化工"] },
  $: element, clearTimeout, renderTagEditor() {}, window: {scrollX:0,scrollY:0,scrollTo(){}},
  request: async (url, key, options) => {
    if (url === "/api/tags") return {tags:[{name:"化工",count:5},{name:"染料",count:3},{name:"纺织",count:1}],revision:"new-order"};
    calls.push(JSON.parse(options.body)); return { tags: ["染料", "纺织", "化工"] };
  },
  loadStock: async () => calls.push("stock"), loadDate: async () => calls.push("date")
});
function load(from, to) { vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to)), context); }
load("function escapeHTML", "function debounce");
load("function stockTags", "function renderStockCard");
load("function renderStockProfile", "function renderStock(data)");
load("function updateTagEditorControls", "function syncTagBlacklistMembership");
load("function hideTagSuggestions", "function updateTagEditorControls");
load("function canEditBlacklist", "function blacklistError");
load("async function saveTagEditor", "function renderTable");
context.renderStockProfile({code:"000001", name:"测试股", initials:"CSG", registered_province:"广西壮族自治区",
  registered_address:"测试地址", tags:["染料", "纺织", "自定义<&标签"],blacklisted:true,note:"详情备注<&内容"});
assert.ok(element("stock-profile-note").innerHTML.includes("详情备注&lt;&amp;内容"));
assert.equal(element("stock-blacklist-label").hidden,false,"a blacklisted stock shows its header badge");
assert.equal(element("stock-province-label").textContent, "广西");
assert.equal(element("stock-initials-label").textContent, "CSG");
assert.equal((element("stock-industry-tags").innerHTML.match(/class="stock-tag"/g)||[]).length, 3);
assert.ok(element("stock-industry-tags").innerHTML.includes("自定义&lt;&amp;标签"));
assert.equal(element("edit-stock-profile-tags").disabled, false);
context.renderStockProfile({code:"000002", name:"待查询"}, true);
assert.equal(element("stock-blacklist-label").hidden,true,"loading another stock clears the previous badge");
assert.equal(element("stock-province-label").textContent, "…");
assert.equal(element("stock-initials-label").textContent, "…", "loading another stock clears the previous initials");
assert.ok(!element("stock-industry-tags").innerHTML.includes("染料"), "loading another stock clears old tags");
assert.equal(element("edit-stock-profile-tags").disabled, true);
assert.equal(element("stock-profile-note").hidden, true, "loading a different profile clears its old note");
context.renderStockProfile({code:"000003", name:"尚未收录", tags:[]});
assert.equal(element("stock-blacklist-label").hidden,true,"non-members never display the badge");
assert.equal(element("stock-province-label").textContent, "地区待补充");
assert.equal(element("stock-initials-label").textContent, "—");
assert.ok(element("stock-industry-tags").innerHTML.includes("暂无标签"));
assert.equal(element("edit-stock-profile-tags").disabled, true);
context.state.meta = { capabilities: { edit_tags: false } };
context.renderStockProfile({code:"000001", name:"测试股", tags:["银行"]});
assert.equal(element("edit-stock-profile-tags").hidden, true, "public profile has no editor");
assert.equal(element("edit-stock-profile-tags").disabled, true);
context.state.meta = { capabilities: { edit_tags: true } };
context.renderStockProfile({code:"000001", name:"测试股", tags:["银行"]});
assert.equal(element("edit-stock-profile-tags").hidden, false, "local editing is retained");
(async () => {
  await context.saveTagEditor();
  assert.equal(calls.at(-2), "stock", "saving from stock history must stay on that stock and finish before closing");
  assert.ok(!calls.includes("date"));
  assert.deepEqual(calls[0].tags, ["染料", "纺织", "化工"]);
  assert.deepEqual(Array.from(context.state.meta.tag_order),["化工","染料","纺织"],"single-stock edits immediately refresh the shared tag order");
  context.state.tab = "date";
  context.state.tagEditorData = {code:"000001",revision:4,tags:["化工"]};
  await context.saveTagEditor();
  assert.equal(calls.at(-2), "date", "the daily editor retains its original return behavior");
  assert.equal(context.state.tagEditorData, null);
  console.log("Stock province, complete editable tags, loading state, and save destination: passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
