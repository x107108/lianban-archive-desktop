// Exercise real route loaders against a browser-like back/forward stack.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map(), listeners = new Map(), entries = ["/"], visits = [], requests = [];
const location = {pathname: "/", search: ""};
let index = 0, replacements = 0, renderedDate = null, pendingStock = null;
const stocks = {"600668": "尖峰集团", "000530": "冰山冷热", "600802": "福建水泥"};
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: "", hidden: false, checked: false, textContent: "", innerHTML: "",
    classList: {toggle() {}}, setAttribute(name, value) {this[name] = value;},
    addEventListener(type, listener) { listeners.set(`${id}:${type}`, listener); },
    focus() {this.focused = true;}, scrollIntoView(options) {this.scrollOptions = options;},
    removeAttribute(name) {delete this[name];}, setCustomValidity() {}, querySelectorAll() {return [];}
  });
  return elements.get(id);
}
function readLocation(url) {
  const parsed = new URL(url, "http://localhost");
  location.pathname = parsed.pathname;
  location.search = parsed.search;
}
const context = vm.createContext({
  URLSearchParams, location, $: element,
  state: {tab: "date", requests: {}, meta: {latest_date: "2026-10-16", dates: ["2026-10-15", "2026-10-16"]}},
  history: {
    pushState(_a, _b, url) {entries.splice(++index); entries.push(url); readLocation(url);},
    replaceState(_a, _b, url) {entries[index] = url; replacements++; readLocation(url);}
  },
  document: {documentElement: {classList: {toggle() {}}}},
  window: {addEventListener(type, listener) {listeners.set(type, listener);}},
  hideSuggestions() {}, hideBlacklistSuggestions() {}, clearError() {}, setStats() {}, loadShareholderAlerts() {},
  renderBoardOptions() {}, updateDateNavigation() {}, renderStockProfile() {},
  async loadIntraday() {context.state.intradayRestored = [...context.state.minuteCompareCodes];},
  async loadTagManager() {context.setView("tags"); context.state.restoredTag = context.state.tagManagerName;},
  renderRelationships() {}, loadRelationHistory() {}, renderChart: () => "chart", renderStockCycles: () => "cycles",
  renderDate(data) {renderedDate = data; element("date-table-area").setAttribute("aria-busy", "false");},
  renderBlacklist(data) {context.state.blacklistData = data;}, updateBlacklistControls() {}, blacklistError() {},
  loadingHTML: () => "loading", emptyHTML: () => "empty", textValue: value => String(value),
  rememberStock(stock) {visits.push(stock.code);}, showError(error) {throw error;},
  request: async (url, channel) => {
    requests.push({url, channel});
    if (channel === "stock") {
      const code = new URL(url, "http://localhost").searchParams.get("code");
      if (pendingStock?.code === code) return pendingStock.promise;
      return {stock: {code, name: stocks[code]}, rows: [{date: "2026-10-16"}], stats: {}};
    }
    if (channel === "date") return {query: url, rows: []};
    if (channel === "blacklist") return {rows: [], total: 0};
    throw Error(`Unexpected request: ${url}`);
  }
});
function load(from, to) {vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to)), context);}
load("function updateURL", "function canEditBlacklist");
load("async function loadBlacklist", "function hideBlacklistSuggestions");
load("function getDateQuery", "function renderBoardOptions");
load("async function loadDate", "function renderDate");
load("function chooseStock", "function renderStockProfile");
load("function renderStock(data)", "function relationStockButton");
load("function returnToDate", "function runQuery");
load("async function restoreFromURL", "async function initialize");
vm.runInContext(source.split(/\r?\n/).find(line => line.startsWith('window.addEventListener("popstate"')), context);
load('$("nav-search").addEventListener', '$("nav-blacklist").addEventListener');
async function traverse(offset) {
  assert.ok(index + offset >= 0 && index + offset < entries.length);
  index += offset;
  readLocation(entries[index]);
  await listeners.get("popstate")();
}
async function openStock(code) {
  context.chooseStock({code, name: stocks[code]}, false);
  await context.loadStock();
}
(async () => {
  await context.restoreFromURL();
  assert.equal(entries.length, 1, "initial URL normalization replaces the current visit");
  assert.equal(replacements, 1);
  assert.equal(location.search, "?date=2026-10-16");
  Object.assign(context.state, {grouping: "pinyin", boards: "2", excludeST: true, excludeGEM: true, relationExcludeST:true, relationExcludeGEM:true, relationExcludeLatest:true});
  await context.loadDate();
  const dailyURL = entries[index], dailyIndex = index;
  await openStock("600668");
  const firstStockIndex = index;
  await openStock("000530");
  assert.equal(index, firstStockIndex + 1, "one entry per stock, despite loading and rendering URL updates");
  const length = entries.length, recentVisits = [...visits];
  await context.loadStock({remember: false});
  assert.equal(entries.length, length, "background refreshes do not add visits");
  await traverse(-1);
  assert.equal(element("stock-name-label").textContent, "尖峰集团");
  assert.equal(element("stock-search").value, "尖峰集团 600668");
  assert.equal(element("relation-exclude-st").checked, true);
  assert.equal(element("relation-exclude-gem").checked, true);
  assert.equal(element("relation-exclude-latest").checked, true);
  assert.ok(location.search.includes("relation_exclude_latest=1"));
  assert.ok(location.search.includes("relation_exclude_st=1") && location.search.includes("relation_exclude_gem=1"),"back and forward restore independent relationship filters");
  assert.equal(element("stock-view").hidden, false);
  assert.equal(element("date-view").hidden, true);
  assert.deepEqual(visits, recentVisits, "history traversal does not reorder recent stocks");
  await traverse(1);
  assert.equal(element("stock-name-label").textContent, "冰山冷热");
  assert.equal(entries.length, length, "back and forward never add visits");
  await traverse(-1);
  await traverse(-1);
  assert.equal(index, dailyIndex);
  assert.equal(entries[index], dailyURL);
  assert.equal(context.state.tab, "date");
  assert.equal(context.state.selectedStock, null);
  assert.equal(element("stock-search").value, "");
  assert.equal(context.state.boards, "2");
  assert.equal(context.state.grouping, "pinyin");
  assert.equal(element("exclude-st").checked, true);
  assert.equal(element("exclude-gem").checked, true);
  assert.ok(renderedDate.query.includes("boards=2") && renderedDate.query.includes("exclude_gem=1"));
  await traverse(1);
  await context.loadBlacklist();
  assert.equal(context.state.tab, "blacklist");
  assert.equal(element("blacklist-view").hidden, false);
  await traverse(-1);
  assert.equal(element("stock-name-label").textContent, "尖峰集团");
  await traverse(1);
  assert.equal(context.state.tab, "blacklist");
  assert.equal(element("search-workspace").hidden, true);
  await traverse(-1);
  element("trade-date").value = "2026-10-15";
  context.returnToDate();
  assert.equal(context.state.boards, "");
  await traverse(-1);
  assert.equal(context.state.tab, "stock");
  assert.equal(element("trade-date").value, "2026-10-16");
  await traverse(1);
  assert.equal(context.state.tab, "date");
  assert.equal(element("trade-date").value, "2026-10-15");
  assert.equal(context.state.excludeGEM, true);

  // A slower stock response must not undo a newer back action or erase forward history.
  pendingStock = {code: "600802"};
  pendingStock.promise = new Promise(resolve => {pendingStock.resolve = resolve;});
  context.chooseStock({code: "600802", name: stocks["600802"]}, false);
  const slowLoad = context.loadStock();
  await traverse(-1);
  const restoredURL = entries[index], count = entries.length;
  pendingStock.resolve({stock: {code: "600802", name: stocks["600802"]}, rows: [{date: "2026-10-16"}]});
  await slowLoad;
  assert.equal(context.state.tab, "date");
  assert.equal(location.pathname + location.search, restoredURL);
  assert.equal(entries.length, count);
  await openStock("000530");
  assert.ok(!entries.slice(index + 1).length, "a new visit after back replaces only the forward branch");
  assert.ok(!entries.some(url => url.includes("code=600802")));
  context.state.grouping = "code";
  context.returnToDate();
  await context.loadDate();
  assert.ok(location.search.includes("layout=code"));
  await openStock("600668");
  await traverse(-1);
  assert.equal(context.state.tab, "date");
  assert.equal(context.state.grouping, "code", "back restores the code grouping");
  await traverse(1);
  assert.equal(context.state.grouping, "code", "forward retains code grouping on stock detail");
  assert.equal(context.state.selectedStock.code, "600668");
  context.state.intradayDate = "2026-10-21";
  context.state.intradayCode = "603278";
  context.state.minuteCompareCodes = ["300296", "002929"];
  context.setView("intraday");
  const comparedURL = entries[index];
  context.state.minuteCompareCodes = ["300296"];
  context.updateURL();
  const comparedCount = entries.length;
  await traverse(-1);
  assert.equal(entries[index], comparedURL);
  assert.equal(context.state.tab, "intraday");
  assert.equal(context.state.intradayCode, "603278");
  assert.deepEqual(Array.from(context.state.intradayRestored), ["300296", "002929"]);
  await traverse(1);
  assert.deepEqual(Array.from(context.state.intradayRestored), ["300296"]);
  assert.equal(entries.length, comparedCount, "comparison history traversal does not add visits");
  readLocation("/?date=2026-10-21&view=intraday&minute_code=603278&minute_compare=300296,300296,bad,002929");
  await context.restoreFromURL();
  assert.deepEqual(Array.from(context.state.intradayRestored), ["300296", "002929"], "restore sanitizes peer codes and removes duplicates");
  context.state.tagManagerName = "机器人";
  context.setView("tags");
  const tagURL = entries[index];
  assert.ok(tagURL.includes("view=tags") && tagURL.includes("tag="));
  context.setView("date");
  await traverse(-1);
  assert.equal(context.state.tab,"tags");
  assert.equal(context.state.restoredTag,"机器人");
  assert.equal(element("tag-management-view").hidden,false);
  assert.equal(element("search-workspace").hidden,true);
  await traverse(1);
  assert.equal(context.state.tab,"date");
  assert.equal(element("tag-management-view").hidden,true);
  // Exercise the actual sidebar click handler, not only direct route loaders.
  context.state.selectedStock = null;
  context.state.tagManagerName = "机器人";
  context.state.boards = "2";
  const selectedDate = element("trade-date").value;
  await context.loadTagManager();
  const managerURL = entries[index];
  const managerIndex = index;
  listeners.get("nav-search:click")();
  await Promise.resolve();
  assert.equal(context.state.tab,"date","search leaves tag management and opens the daily search workspace");
  assert.equal(element("search-workspace").hidden,false);
  assert.equal(element("tag-management-view").hidden,true);
  assert.equal(element("nav-search")["aria-current"],"page");
  assert.equal(element("stock-search").focused,true);
  assert.equal(element("search-workspace").scrollOptions.block,"center");
  assert.equal(element("trade-date").value,selectedDate);
  assert.equal(context.state.boards,"2");
  assert.ok(!location.search.includes("view=tags") && !location.search.includes("tag="));
  assert.equal(index,managerIndex+1,"leaving management creates exactly one search visit");
  await traverse(-1);
  assert.equal(entries[index],managerURL);
  assert.equal(context.state.tab,"tags");
  await traverse(1);
  assert.equal(context.state.tab,"date");
  await openStock("600668");
  const priorVisits = [...visits];
  await context.loadTagManager();
  listeners.get("nav-search:click")();
  await Promise.resolve();
  assert.equal(context.state.tab,"stock","search restores the previously selected stock when entered from its detail");
  assert.equal(context.state.selectedStock.code,"600668");
  assert.deepEqual(visits,priorVisits,"returning through the sidebar does not add a recent-stock visit");
  console.log("Stock/date/blacklist/tags back-forward, filter and code-layout restoration, URL deduplication, and stale responses: passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
