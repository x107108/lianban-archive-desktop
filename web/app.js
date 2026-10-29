"use strict";

const $ = (id) => document.getElementById(id);
const state = { meta: null, tab: "date", grouping: "industry", boards: "", excludeST: false, excludeGEM: false, relationExcludeST: false, relationExcludeGEM: false, relationExcludeLatest: false, dateData: null, stockData: null, selectedStock: null, suggestions: [], suggestionIndex: -1, retry: null, requests: {}, relationPeers: [], relationPeerCode: "", relationQuery: "", relationSort: "commonCount", relationSortDirection: "desc" };
const markets = { sh: "沪市主板", sz: "深市主板", gem: "创业板", star: "科创板", bj: "北交所", SH: "沪市主板", SZ: "深市主板", GEM: "创业板", STAR: "科创板", BJ: "北交所" };
const icons = { search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>', calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M8 3v4m8-4v4m-8 7 2 2 4-4"/></svg>', arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>' };

function escapeHTML(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function textValue(value) { return value === undefined || value === null || value === "" ? "—" : String(value); }
function numberValue(value, digits = 0) { if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return "—"; return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
const RECENT_STOCKS_KEY = "limit-up-archive.recent-stocks.v1";
const RELATION_HEIGHT_KEY = "limit-up-archive.relation-height.v1";
function normalizeRelationHeight(value) {
  const height = Number(value);
  return String(value ?? "").trim() && Number.isFinite(height) ? Math.min(1600, Math.max(600, Math.round(height))) : 880;
}
function readRelationHeight() {
  try { return normalizeRelationHeight(localStorage.getItem(RELATION_HEIGHT_KEY)); }
  catch { return 880; }
}
function applyRelationHeight(value, remember = true) {
  const height = normalizeRelationHeight(value);
  $("relation-height").value = String(height);
  $("stock-relations").style.setProperty("--relation-height", `${height}px`);
  if (remember) { try { localStorage.setItem(RELATION_HEIGHT_KEY, String(height)); } catch {} }
}
function normalizeRecentStocks(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(stock => {
    if (!stock || typeof stock.code !== "string" || !/^\d{6}$/.test(stock.code) || typeof stock.name !== "string" || !stock.name.trim() || stock.name.length > 80 || seen.has(stock.code)) return false;
    seen.add(stock.code);
    return true;
  }).slice(0, 10).map(stock => ({code: String(stock.code), name: stock.name.trim()}));
}
function readRecentStocks() {
  try { return normalizeRecentStocks(JSON.parse(localStorage.getItem(RECENT_STOCKS_KEY) || "[]")); }
  catch { return []; }
}
function renderRecentStocks() {
  $("recent-stock-list").innerHTML = (state.recentStocks || []).map(stock => `<button type="button" class="recent-stock" data-recent-code="${escapeHTML(stock.code)}" data-recent-name="${escapeHTML(stock.name)}" title="${escapeHTML(stock.name)} ${escapeHTML(stock.code)} · 查看历史">${escapeHTML(stock.name)}</button>`).join("") || '<span class="recent-stocks-empty">暂无记录</span>';
}
function rememberStock(stock) {
  state.recentStocks = normalizeRecentStocks([stock, ...readRecentStocks(), ...(state.recentStocks || [])]);
  try { localStorage.setItem(RECENT_STOCKS_KEY, JSON.stringify(state.recentStocks)); } catch {}
  renderRecentStocks();
}
function marketValue(value) { return markets[value] || textValue(value); }
function dateLabel(value) { return value ? String(value).replaceAll("-", ".") : "—"; }
function latestLimitUp(row) { return state.latestLimitUps?.has(String(row.code)) || false; }
function prioritizeLatest(rows, historicalOnly = false) {
  return [...rows].sort((a, b) => Number(latestLimitUp(b) && (!historicalOnly || b.date !== state.meta?.latest_date)) - Number(latestLimitUp(a) && (!historicalOnly || a.date !== state.meta?.latest_date)));
}
function latestLimitBadge(row) {
  if (!latestLimitUp(row)) return "";
  const day = state.meta.latest_date;
  return `<span class="latest-limit-badge" title="最新交易日 ${escapeHTML(dateLabel(day))} 涨停 · ${numberValue(state.latestLimitUps.get(String(row.code)))} 板">${escapeHTML(dateLabel(day).slice(5))} 涨停</span>`;
}
function latestPriorityNote() {
  return state.meta?.latest_date ? `<span class="latest-priority-note"><i aria-hidden="true"></i>${escapeHTML(dateLabel(state.meta.latest_date))} 涨停股票高亮置顶</span>` : "";
}
function debounce(fn, delay = 250) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
function emptyHTML(title, description, icon = "search") { return `<div class="empty-state">${icons[icon]}<h4>${escapeHTML(title)}</h4><p>${escapeHTML(description)}</p></div>`; }
function loadingHTML() { return '<div class="loading-state" aria-label="正在加载"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>'; }

async function request(path, channel, options = {}) {
  state.requests[channel]?.abort();
  const controller = new AbortController();
  state.requests[channel] = controller;
  const timeout = setTimeout(() => controller.abort("timeout"), 30000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal, headers: { Accept: "application/json", ...options.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || data?.message || `服务器返回 ${response.status}`);
    if (!data) throw new Error("服务器未返回有效的数据。");
    return data;
  } catch (error) {
    if (controller.signal.reason === "timeout") throw new Error("查询时间超过 30 秒，请稍后重新加载。");
    if (error.name === "AbortError") return null;
    throw error;
  } finally { clearTimeout(timeout); }
}

function showError(error, retry) { $("error-message").textContent = error.message || "无法连接本地服务，请确认服务正在运行。"; $("error-banner").hidden = false; state.retry = retry; }
function clearError() { $("error-banner").hidden = true; state.retry = null; }
function setStats(id, values = {}) { $(id).querySelectorAll("[data-stat]").forEach((element) => { element.textContent = numberValue(values[element.dataset.stat]); }); }
function updateQueryStickyOffset() {
  const query = $("stock-sticky");
  const offset = query.getBoundingClientRect().height + (parseFloat(getComputedStyle(query).top) || 0);
  document.documentElement.style.setProperty("--query-sticky-bottom", `${Math.ceil(offset)}px`);
}
function updateURL({replace = false} = {}) {
  const params = new URLSearchParams();
  const queryDate = state.tab === "intraday" ? state.intradayDate : $("trade-date").value;
  if (queryDate) params.set("date", queryDate);
  if (state.tab === "intraday") {
    params.set("view", "intraday");
    if (state.intradayCode) params.set("minute_code", state.intradayCode);
    if (state.minuteCompareCodes?.length) params.set("minute_compare", state.minuteCompareCodes.join(","));
    if ($("minute-timeline-exclude-gem").checked === false) params.set("timeline_gem", "1");
  }
  if (state.tab === "stock" && state.selectedStock) {
    params.set("code", state.selectedStock.code);
  } else if (state.boards) params.set("boards", state.boards);
  if (state.tab === "blacklist") params.set("view", "blacklist");
  if (state.tab === "tags") { params.set("view", "tags"); if (state.tagManagerName) params.set("tag", state.tagManagerName); }
  if (["region", "pinyin", "code"].includes(state.grouping)) params.set("layout", state.grouping);
  if (state.excludeST) params.set("exclude_st", "1");
  if (state.excludeGEM) params.set("exclude_gem", "1");
  if (state.relationExcludeST) params.set("relation_exclude_st", "1");
  if (state.relationExcludeGEM) params.set("relation_exclude_gem", "1");
  if (state.relationExcludeLatest) params.set("relation_exclude_latest", "1");
  const url = `${location.pathname}${params.size ? `?${params}` : ""}`;
  if (url === `${location.pathname}${location.search}`) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

function setView(view, update = true) {
  if (state.tab !== view) {
    ["date", "stock", "blacklist", "intraday", "tags"].filter(channel => channel !== view).forEach(channel => state.requests[channel]?.abort());
    if (view !== "tags") { state.requests["tag-members"]?.abort(); state.requests["tag-manager-search"]?.abort(); }
    if (view !== "intraday") {
      state.requests["intraday-stock"]?.abort();
      if (typeof stopMinuteTimelineCollection === "function") stopMinuteTimelineCollection(false);
      Object.keys(state.requests).filter(channel => channel.startsWith("minute-compare-")).forEach(channel => state.requests[channel]?.abort());
    }
  }
  state.tab = view;
  document.documentElement.classList.toggle("stock-mode", view === "stock");
  $("stock-summary").hidden = view !== "stock";
  if (view !== "stock") { state.requests.comparison?.abort(); state.requests.relations?.abort(); }
  const blacklist = view === "blacklist";
  const tags = view === "tags";
  const minutes = view === "intraday";
  $("stock-sticky").hidden = blacklist || minutes || tags;
  $("date-view").hidden = view !== "date";
  $("stock-view").hidden = view !== "stock";
  $("blacklist-view").hidden = !blacklist;
  $("tag-management-view").hidden = !tags;
  $("intraday-view").hidden = !minutes;
  $("search-workspace").hidden = blacklist || minutes || tags;
  $("archive-range").hidden = blacklist || minutes || tags;
  $("page-title").textContent = tags ? "标签管理" : minutes ? "主板分时" : blacklist ? "黑名单" : "连板档案";
  $("page-description").textContent = tags ? "查看全部标签，管理所属股票，统一改名与合并。" : minutes ? "查看沪深主板分时、成交量与竞价，对比不同股票的走势。" : blacklist ? "管理你的黑名单股票，名单中的每一只都持续有效。" : "从交易日看市场高度，从个股看连板轨迹。";
  $("breadcrumb-page").textContent = tags ? "标签管理" : minutes ? "主板分时" : blacklist ? "黑名单" : "历史连板";
  ["nav-search", "nav-blacklist", "nav-intraday", "nav-tags"].forEach(id => {
    const active = id === "nav-tags" ? tags : id === "nav-intraday" ? minutes : id === "nav-blacklist" ? blacklist : !minutes && !blacklist && !tags;
    $(id).classList.toggle("active", active);
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  });
  if (blacklist || minutes || tags) {
    state.requests.search?.abort();
    state.requests["stock-resolve"]?.abort();
    hideSuggestions();
  } else {
    state.requests["blacklist-search"]?.abort();
    hideBlacklistSuggestions();
  }
  $("stock-query-button").disabled = false;
  clearError();
  if (update) updateURL();
}

function canEditBlacklist() { return state.meta?.capabilities?.edit_blacklist === true; }
function blacklistError(message = "") {
  $("blacklist-error").textContent = message;
  $("blacklist-error").hidden = !message;
}
function updateBlacklistControls() {
  const editable = canEditBlacklist();
  $("blacklist-add-panel").hidden = !editable;
  $("blacklist-readonly").hidden = editable;
  $("blacklist-add-form").querySelectorAll("input, button").forEach(element => { element.disabled = !editable || Boolean(state.blacklistSaving || state.blacklistLoading); });
  $("blacklist-refresh").disabled = Boolean(state.blacklistSaving || state.blacklistLoading);
  $("blacklist-table-area").querySelectorAll("[data-blacklist-remove]").forEach(button => { button.disabled = !editable || Boolean(state.blacklistSaving || state.blacklistLoading); });
}
function renderBlacklist(data) {
  state.blacklistData = data;
  $("blacklist-count").textContent = numberValue(data.total);
  const editable = canEditBlacklist();
  $("blacklist-table-area").innerHTML = data.rows.length ? `<table class="blacklist-table"><caption class="sr-only">黑名单股票管理列表</caption><thead><tr><th scope="col">股票</th><th scope="col">注册省份</th><th scope="col">行业标签</th><th scope="col">加入时间</th>${editable ? '<th scope="col">操作</th>' : ""}</tr></thead><tbody>${data.rows.map(stock => `<tr><td><button type="button" class="stock-name-button" data-blacklist-code="${escapeHTML(stock.code)}" data-blacklist-name="${escapeHTML(stock.name)}" title="查看${escapeHTML(stock.name)}的历史">${escapeHTML(stock.name)}</button><div class="row-stock-code">${escapeHTML(stock.code)}</div></td><td class="blacklist-province">${escapeHTML(regionLabel(stock))}</td><td><div class="blacklist-tags">${stockTags(stock).map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</div></td><td class="blacklist-created">${escapeHTML(dateLabel(stock.created_at.slice(0, 10)))} <span>${escapeHTML(stock.created_at.slice(11, 16))}</span></td>${editable ? `<td><button type="button" class="blacklist-remove" data-blacklist-remove="${escapeHTML(stock.code)}" aria-label="将${escapeHTML(stock.name)}移出黑名单">移除</button></td>` : ""}</tr>`).join("")}</tbody></table>` : emptyHTML("黑名单还是空的", editable ? "在上方搜索并添加股票，建立你的黑名单。" : "目前没有黑名单股票。");
  updateBlacklistControls();
}
async function loadBlacklist() {
  setView("blacklist");
  if (state.blacklistSaving) return;
  blacklistError();
  const generation = (state.blacklistGeneration || 0) + 1;
  state.blacklistGeneration = generation;
  state.blacklistLoading = true;
  updateBlacklistControls();
  $("blacklist-table-area").setAttribute("aria-busy", "true");
  if (!state.blacklistData) $("blacklist-table-area").innerHTML = loadingHTML();
  try {
    const data = await request("/api/blacklist", "blacklist");
    if (data && state.tab === "blacklist" && state.blacklistGeneration === generation) renderBlacklist(data);
  } catch (error) {
    if (state.tab === "blacklist" && state.blacklistGeneration === generation) {
      blacklistError(error.message);
      if (!state.blacklistData) $("blacklist-table-area").innerHTML = emptyHTML("暂时无法读取黑名单", "请点击「刷新列表」重试。");
    }
  } finally {
    // Only the newest list request may unlock the controls.
    if (state.blacklistGeneration === generation) {
      state.blacklistLoading = false;
      $("blacklist-table-area").setAttribute("aria-busy", "false");
      updateBlacklistControls();
    }
  }
}
function hideBlacklistSuggestions() {
  $("blacklist-suggestions").hidden = true;
  $("blacklist-search").setAttribute("aria-expanded", "false");
  $("blacklist-search").removeAttribute("aria-activedescendant");
  state.blacklistSuggestionIndex = -1;
}
function showBlacklistSuggestions(rows) {
  state.blacklistSuggestions = rows.slice(0, 15);
  state.blacklistSuggestionIndex = -1;
  const codes = new Set((state.blacklistData?.rows || []).map(stock => stock.code));
  $("blacklist-suggestions").innerHTML = state.blacklistSuggestions.map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" id="blacklist-suggestion-${index}" data-blacklist-suggestion="${index}"><span class="suggestion-code">${escapeHTML(stock.code)}</span><span>${escapeHTML(stock.name)}</span><span class="suggestion-market">${codes.has(stock.code) ? "已在黑名单" : escapeHTML(marketValue(stock.market))}</span></button></li>`).join("") || '<li role="presentation" class="suggestion-message">未找到已收录的股票，请尝试名称、代码或首字母。</li>';
  $("blacklist-suggestions").hidden = false;
  $("blacklist-search").setAttribute("aria-expanded", "true");
}
function selectBlacklistStock(stock) {
  state.blacklistSelected = stock;
  state.requests["blacklist-search"]?.abort();
  $("blacklist-search").value = `${stock.name} ${stock.code}`;
  hideBlacklistSuggestions();
  blacklistError();
}
async function searchBlacklistStocks() {
  const query = $("blacklist-search").value.trim();
  if (!query || state.blacklistSelected || state.tab !== "blacklist" || state.blacklistSaving) return;
  try {
    const data = await request(`/api/stocks?${new URLSearchParams({q: query})}`, "blacklist-search");
    if (data && state.tab === "blacklist" && !state.blacklistSelected && $("blacklist-search").value.trim() === query) showBlacklistSuggestions(data.rows || []);
  } catch (error) { if (state.tab === "blacklist" && $("blacklist-search").value.trim() === query) blacklistError(error.message); }
}
async function changeBlacklist(action, code = null) {
  if (state.blacklistSaving || state.blacklistLoading || !canEditBlacklist()) return;
  state.blacklistSaving = true;
  blacklistError();
  $("blacklist-feedback").textContent = "";
  updateBlacklistControls();
  try {
    if (action === "add") {
      let stock = state.blacklistSelected;
      if (!stock) {
        const query = $("blacklist-search").value.trim();
        if (!query) throw new Error("请先搜索要添加的股票。");
        const data = await request(`/api/stocks?${new URLSearchParams({q: query})}`, "blacklist-search");
        if (!data || state.tab !== "blacklist") return;
        const rows = data.rows || [];
        const exact = rows.filter(row => row.code === query || row.name === query || row.initials === query.toUpperCase());
        stock = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
        if (!stock) { showBlacklistSuggestions(rows); throw new Error(rows.length ? "请选择一只股票后再加入黑名单。" : "未找到已收录的股票。"); }
      }
      code = stock.code;
    }
    hideBlacklistSuggestions();
    const data = await request("/api/blacklist", "blacklist-save", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code, action})});
    if (!data) return;
    renderBlacklist(data);
    $("blacklist-feedback").textContent = action === "add" ? (data.changed ? "已加入黑名单。" : "这只股票已在黑名单中。") : "已移出黑名单。";
    if (action === "add") { state.blacklistSelected = null; $("blacklist-search").value = ""; }
  } catch (error) { blacklistError(error.message); }
  finally { state.blacklistSaving = false; updateBlacklistControls(); }
}

function canManageTags() { return state.meta?.capabilities?.manage_tags ?? canEditTags(); }
function tagManagerError(message = "") {
  $("tag-manager-error").textContent = message;
  $("tag-manager-error").hidden = !message;
}
function updateTagManagerControls() {
  const editable = canManageTags(), busy = Boolean(state.tagManagerSaving || state.tagManagerLoading);
  $("tag-manager-refresh").disabled = busy;
  $("tag-manager-rename-form").hidden = !editable;
  $("tag-manager-add-form").hidden = !editable;
  $("tag-manager-readonly").hidden = editable;
  $("tag-manager-delete").hidden = !editable;
  $("tag-manager-delete").disabled = !editable || busy || !state.tagManagerMembers || Boolean(state.tagManagerMembersLoading);
  $("tag-manager-create").hidden = !editable;
  $("tag-manager-create").disabled = busy || !state.tagManagerData;
  $("tag-manager-parent-form").hidden = !editable;
  $("tag-manager-child").hidden = !editable;
  $("tag-manager-child").disabled = busy || !state.tagManagerMembers;
  for (const id of ["tag-manager-rename-form", "tag-manager-add-form", "tag-manager-parent-form", "tag-node-form"]) $(id).querySelectorAll("input, button, select").forEach(el => { el.disabled = !editable || busy || Boolean(state.tagManagerMembersLoading); });
  $("tag-manager-list").querySelectorAll("button").forEach(el => { el.disabled = busy; });
  $("tag-manager-members").querySelectorAll("[data-remove-stock-tag]").forEach(el => { el.disabled = !editable || busy || Boolean(state.tagManagerMembersLoading); });
  for (const id of ["tag-merge-confirm", "tag-merge-cancel", "tag-merge-close"]) $(id).disabled = Boolean(state.tagManagerSaving);
  for (const id of ["tag-delete-cancel", "tag-delete-close"]) $(id).disabled = Boolean(state.tagManagerSaving);
  $("tag-delete-confirm").disabled = !editable || Boolean(state.tagManagerSaving) || !state.tagManagerPendingDelete;
  $("tag-node-close").disabled = Boolean(state.tagManagerSaving);
}
function renderTagManagerCatalog() {
  const data = state.tagManagerData;
  if (!data) return;
  const query = $("tag-manager-filter").value.trim().toLocaleLowerCase();
  const tags = data.tags.filter(tag => tag.name.toLocaleLowerCase().includes(query));
  $("tag-manager-count").textContent = numberValue(data.total);
  $("tag-manager-summary").textContent = `${numberValue(data.total)} 个现有标签 · ${numberValue(data.stocks)} 只股票 · 全部已收录股票，跨日期去重统计${query ? ` · 当前匹配 ${numberValue(tags.length)} 个标签` : ""}`;
  const button = tag => `<button type="button" class="tag-manager-item ${tag.name === state.tagManagerName ? "selected" : ""}" data-manage-tag="${escapeHTML(tag.name)}" aria-pressed="${tag.name === state.tagManagerName}" title="${escapeHTML(tag.name)} · ${numberValue(tag.count)} 只股票"><span>${escapeHTML(tag.name)}</span><strong>${numberValue(tag.count)}<small>只</small></strong></button>`;
  if ((data.hierarchy || []).some(node => node.parent)) {
    const relevant = new Set(tags.flatMap(tag => [tag.name, ...tagAncestors(tag.name)]));
    const branch = (parent = "", depth = 0) => data.tags.filter(tag => (tagHierarchy().parents.get(tag.name.toLocaleLowerCase()) || "") === parent && relevant.has(tag.name)).map(tag => {
      const children = branch(tag.name, depth + 1);
      return `<div class="tag-manager-tree-node" style="--tag-depth:${Math.min(depth,6)}">${button(tag)}${children ? `<div class="tag-manager-tree-children">${children}</div>` : ""}</div>`;
    }).join("");
    $("tag-manager-list").innerHTML = branch() || emptyHTML("没有匹配的标签", "请尝试其他标签名称。");
    $("tag-manager-list").classList.toggle("tag-manager-tree", true);
  } else {
    $("tag-manager-list").innerHTML = tags.map(button).join("") || emptyHTML(query ? "没有匹配的标签" : "还没有标签", query ? "请尝试其他标签名称。" : "股票标签补充后，会在这里显示。");
    $("tag-manager-list").classList.toggle("tag-manager-tree", false);
  }
  $("tag-manager-parent").value = tagHierarchy().parents.get((state.tagManagerName || "").toLocaleLowerCase()) || "";
  hideManagerParentSuggestions();
  updateTagManagerControls();
}
function hideManagerParentSuggestions() {
  $("tag-manager-parent-suggestions").hidden = true;
  $("tag-manager-parent").setAttribute("aria-expanded", "false");
  $("tag-manager-parent").setAttribute("aria-activedescendant", "");
  state.tagParentSuggestionIndex = -1;
}
function renderManagerParentSuggestions() {
  const input = $("tag-manager-parent"), query = input.value.trim();
  const choices = state.tagManagerData.tags.filter(tag => tag.name !== state.tagManagerName && !tagAncestors(tag.name).includes(state.tagManagerName)
    && (!query || matchesExistingTag(tag.name, query) || tagAncestors(tag.name).some(parent => matchesExistingTag(parent, query))));
  state.tagParentSuggestionRows = query ? choices : [{name:"", count:0}, ...choices];
  state.tagParentSuggestionIndex = -1;
  $("tag-manager-parent-suggestions").innerHTML = state.tagParentSuggestionRows.map((tag, index) => {
    const ancestors = tag.name ? tagAncestors(tag.name).reverse() : [];
    return `<li role="presentation"><button type="button" role="option" id="tag-parent-option-${index}" aria-selected="false" data-parent-tag-index="${index}"><span>${ancestors.length ? `<span class="tag-suggestion-path">${escapeHTML(ancestors.join(" / "))} / </span>` : ""}${escapeHTML(tag.name || "无父级（独立标签）")}</span>${tag.name ? `<small>${numberValue(tag.count)} 只</small>` : ""}</button></li>`;
  }).join("") || '<li class="suggestion-message">没有匹配的标签，请尝试其他关键词。</li>';
  $("tag-manager-parent-suggestions").hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-activedescendant", "");
}
function chooseManagerParentTag(index) {
  $("tag-manager-parent").value = state.tagParentSuggestionRows[index].name;
  $("tag-manager-parent").focus();
  hideManagerParentSuggestions();
}
async function selectManagerTag(name, replace = false) {
  const generation = state.tagManagerMemberGeneration = (state.tagManagerMemberGeneration || 0) + 1;
  state.requests["tag-members"]?.abort();
  state.tagManagerMembersLoading = false;
  state.tagManagerName = name;
  state.tagManagerMembers = null;
  state.tagManagerStock = null;
  $("tag-manager-stock-search").value = "";
  hideManagerSuggestions();
  $("tag-manager-detail").hidden = !name;
  $("tag-manager-layout").classList.toggle("has-selection", Boolean(name));
  renderTagManagerCatalog();
  updateURL({replace});
  if (!name) return;
  $("tag-manager-name").textContent = name;
  $("tag-manager-rename").value = name;
  $("tag-manager-member-count").textContent = "—";
  $("tag-manager-members").innerHTML = loadingHTML();
  $("tag-manager-members").setAttribute("aria-busy", "true");
  state.tagManagerMembersLoading = true;
  updateTagManagerControls();
  try {
    const data = await request(`/api/tag-stocks?${new URLSearchParams({tag:name})}`, "tag-members");
    if (!data || state.tab !== "tags" || state.tagManagerName !== name || state.tagManagerMemberGeneration !== generation) return;
    state.tagManagerMembers = data;
    $("tag-manager-member-count").textContent = `${numberValue(data.count)} 只`;
    $("tag-manager-members").innerHTML = data.rows.length ? `<ul>${data.rows.map(stock => `<li><div><button type="button" class="stock-name-button" data-tag-stock-code="${escapeHTML(stock.code)}" data-tag-stock-name="${escapeHTML(stock.name)}">${escapeHTML(stock.name)}</button><small>${escapeHTML(stock.code)} · ${escapeHTML(stock.initials)}</small></div><div class="tag-manager-stock-actions"><span>${escapeHTML(regionLabel(stock))}</span>${canManageTags() && stock.direct !== false ? `<button type="button" class="tag-manager-remove" data-remove-stock-tag="${escapeHTML(stock.code)}" aria-label="移除${escapeHTML(stock.name)}的${escapeHTML(data.name)}标签">移除标签</button>` : ""}</div></li>`).join("")}</ul>` : emptyHTML("暂无所属股票", "搜索并加入股票。");
  } catch (error) {
    if (state.tab === "tags" && state.tagManagerMemberGeneration === generation) { tagManagerError(error.message); $("tag-manager-members").innerHTML = emptyHTML("股票列表读取失败", "请点击刷新列表重试。"); }
  } finally {
    if (state.tagManagerMemberGeneration === generation) { state.tagManagerMembersLoading = false; $("tag-manager-members").setAttribute("aria-busy", "false"); updateTagManagerControls(); }
  }
}
async function loadTagManager() {
  setView("tags");
  tagManagerError();
  const generation = state.tagManagerGeneration = (state.tagManagerGeneration || 0) + 1;
  state.tagManagerLoading = true;
  $("tag-manager-list").setAttribute("aria-busy", "true");
  if (!state.tagManagerData) $("tag-manager-list").innerHTML = loadingHTML();
  updateTagManagerControls();
  try {
    const data = await request("/api/tags", "tags");
    if (!data || state.tab !== "tags" || generation !== state.tagManagerGeneration) return;
    state.tagManagerData = data;
    applyTagOrder(data);
    const selected = data.tags.some(tag => tag.name === state.tagManagerName) ? state.tagManagerName : "";
    await selectManagerTag(selected, true);
  } catch (error) { if (state.tab === "tags" && generation === state.tagManagerGeneration) tagManagerError(error.message); }
  finally {
    if (generation === state.tagManagerGeneration) { state.tagManagerLoading = false; $("tag-manager-list").setAttribute("aria-busy", "false"); updateTagManagerControls(); }
  }
}
function hideManagerSuggestions() {
  $("tag-manager-suggestions").hidden = true;
  $("tag-manager-stock-search").setAttribute("aria-expanded", "false");
}
function showManagerSuggestions(rows) {
  state.tagManagerSearchResults = rows.slice(0, 15);
  const members = new Set((state.tagManagerMembers?.rows || []).map(row => row.code));
  $("tag-manager-suggestions").innerHTML = state.tagManagerSearchResults.map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" data-tag-suggestion="${index}"><span class="suggestion-code">${escapeHTML(stock.code)}</span><span>${escapeHTML(stock.name)}</span><span class="suggestion-market">${members.has(stock.code) ? (state.tagManagerMembers.rows.find(row => row.code === stock.code)?.direct === false ? "可加入标签" : "已在标签中") : escapeHTML(marketValue(stock.market))}</span></button></li>`).join("") || '<li class="suggestion-message">未找到已收录的股票。</li>';
  $("tag-manager-suggestions").hidden = false;
  $("tag-manager-stock-search").setAttribute("aria-expanded", "true");
}
async function searchManagerStocks() {
  const query = $("tag-manager-stock-search").value.trim(), name = state.tagManagerName;
  if (!query || state.tagManagerStock || state.tagManagerSaving || state.tab !== "tags") return;
  try {
    const data = await request(`/api/stocks?${new URLSearchParams({q:query})}`, "tag-manager-search");
    if (data && state.tab === "tags" && state.tagManagerName === name && !state.tagManagerStock && $("tag-manager-stock-search").value.trim() === query) showManagerSuggestions(data.rows || []);
  } catch (error) { if (state.tab === "tags" && state.tagManagerName === name && $("tag-manager-stock-search").value.trim() === query) tagManagerError(error.message); }
}
async function refreshAfterTagWrite() {
  state.dateData = null; state.stockData = null;
  if (state.tab === "tags") await loadTagManager();
  else if (state.tab === "stock") await loadStock({remember:false});
  else if (state.tab === "intraday") await loadIntraday();
  else if (state.tab === "blacklist") await loadBlacklist();
  else await loadDate();
}
async function removeManagerStock(code) {
  if (!canManageTags() || state.tagManagerSaving || state.tagManagerLoading || !state.tagManagerMembers) return;
  const stock = state.tagManagerMembers.rows.find(row => row.code === code);
  if (!stock || stock.direct === false) return;
  const name = state.tagManagerName, revision = state.tagManagerMembers.revision;
  const scroll = $("tag-manager-members").scrollTop;
  state.tagManagerSaving = true;
  tagManagerError(); updateTagManagerControls();
  try {
    const data = await request("/api/tag-stocks", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tag:name,code,revision,action:"remove"})});
    if (!data) return;
    $("tag-manager-feedback").textContent = data.changed ? `已移除${stock.name}的“${name}”标签，其他标签已保留。` : `${stock.name}已没有“${name}”标签。`;
    await refreshAfterTagWrite();
    if (state.tab === "tags" && state.tagManagerName === name) $("tag-manager-members").scrollTop = scroll;
  } catch (error) { tagManagerError(error.message); }
  finally { state.tagManagerSaving = false; updateTagManagerControls(); }
}
async function addManagerStock(event) {
  event?.preventDefault();
  if (!canManageTags() || state.tagManagerSaving || !state.tagManagerName || !state.tagManagerMembers) return;
  state.tagManagerSaving = true;
  tagManagerError(); updateTagManagerControls();
  const name = state.tagManagerName;
  try {
    let stock = state.tagManagerStock;
    if (!stock) {
      const query = $("tag-manager-stock-search").value.trim();
      if (!query) throw new Error("请先搜索要加入的股票。");
      const data = await request(`/api/stocks?${new URLSearchParams({q:query})}`, "tag-manager-search");
      if (!data || state.tab !== "tags" || state.tagManagerName !== name) return;
      const exact = (data.rows || []).filter(row => row.code === query || row.name === query || row.initials === query.toUpperCase());
      stock = exact.length === 1 ? exact[0] : data.rows?.length === 1 ? data.rows[0] : null;
      if (!stock) { showManagerSuggestions(data.rows || []); throw new Error("请选择一只股票后再加入标签。"); }
    }
    const data = await request("/api/tag-stocks", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tag:name, code:stock.code, revision:state.tagManagerMembers.revision})});
    if (!data) return;
    $("tag-manager-feedback").textContent = data.changed ? `已将${stock.name}加入“${name}”。` : `${stock.name}已在“${name}”中。`;
    await refreshAfterTagWrite();
  } catch (error) { tagManagerError(error.message); }
  finally { state.tagManagerSaving = false; updateTagManagerControls(); }
}
function cancelManagerMerge() {
  if (state.tagManagerSaving) return;
  state.tagManagerPendingMerge = null;
  $("tag-merge-dialog").close();
}
async function renameManagerTag(merge = false) {
  if (!canManageTags() || state.tagManagerSaving || !state.tagManagerName || !state.tagManagerMembers) return;
  const pending = merge ? state.tagManagerPendingMerge : null;
  if (merge && !pending) return;
  const payload = pending ? {source:pending.source, target:pending.target, revision:pending.revision, merge:true} : {source:state.tagManagerName, target:$("tag-manager-rename").value.trim(), revision:state.tagManagerMembers.revision, merge:false};
  if (!payload.target) { tagManagerError("请输入新的标签名称。"); return; }
  state.tagManagerSaving = true;
  tagManagerError(); $("tag-merge-error").hidden = true; updateTagManagerControls();
  try {
    const data = await request("/api/tag-rename", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    if (!data) return;
    if (data.needs_merge) {
      if (state.tab !== "tags") return;
      state.tagManagerPendingMerge = data;
      $("tag-merge-message").textContent = `已经存在“${data.target}”标签（${numberValue(data.target_count)} 只股票）。是否将“${data.source}”（${numberValue(data.source_count)} 只股票）合并到“${data.target}”？合并后共 ${numberValue(data.combined_count)} 只股票，同一只股票只计一次。`;
      if (!$("tag-merge-dialog").open) $("tag-merge-dialog").showModal();
      return;
    }
    if ($("tag-merge-dialog").open) $("tag-merge-dialog").close();
    state.tagManagerPendingMerge = null;
    state.tagManagerName = data.name;
    if (!data.name.toLocaleLowerCase().includes($("tag-manager-filter").value.trim().toLocaleLowerCase())) $("tag-manager-filter").value = "";
    $("tag-manager-feedback").textContent = merge ? `已合并到“${data.name}”，所有股票已同步，重复标签已去重。` : data.changed ? `已改名为“${data.name}”，所有股票已同步。` : "标签名称没有变化。";
    await refreshAfterTagWrite();
  } catch (error) {
    if (merge && $("tag-merge-dialog").open) { $("tag-merge-error").textContent = error.message; $("tag-merge-error").hidden = false; }
    else tagManagerError(error.message);
  } finally { state.tagManagerSaving = false; updateTagManagerControls(); }
}
function cancelManagerDelete() {
  if (state.tagManagerSaving) return;
  state.tagManagerPendingDelete = null;
  $("tag-delete-dialog").close();
}
async function deleteManagerTag(confirm = false) {
  if (!canManageTags() || state.tagManagerSaving || state.tagManagerLoading || !state.tagManagerMembers) return;
  const pending = confirm ? state.tagManagerPendingDelete : null;
  if (confirm && !pending) return;
  const payload = {tag:pending?.name || state.tagManagerName, revision:pending?.revision || state.tagManagerMembers.revision, confirm};
  state.tagManagerSaving = true;
  tagManagerError(); $("tag-delete-error").hidden = true; updateTagManagerControls();
  try {
    const data = await request("/api/tag-delete", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    if (!data) return;
    if (data.needs_confirmation) {
      if (state.tab !== "tags") return;
      state.tagManagerPendingDelete = data;
      $("tag-delete-message").textContent = `确认删除“${data.name}”标签吗？这会从 ${numberValue(data.count)} 只股票下移除该标签，其他标签和备注会保留。默认数据更新时也不会重新补回该标签。${data.children ? ` ${data.children} 个直属子级会保留，并移到上一级。` : ""}`;
      if (!$("tag-delete-dialog").open) $("tag-delete-dialog").showModal();
      return;
    }
    if (!data.deleted) throw new Error("未能确认删除结果，请刷新列表核实。");
    $("tag-delete-dialog").close();
    state.tagManagerPendingDelete = null;
    state.tagManagerName = "";
    $("tag-manager-feedback").textContent = `已删除“${data.name}”标签，已从 ${numberValue(data.count)} 只股票下移除。`;
    await refreshAfterTagWrite();
  } catch (error) {
    if (confirm && $("tag-delete-dialog").open) { $("tag-delete-error").textContent = error.message; $("tag-delete-error").hidden = false; }
    else tagManagerError(error.message);
  } finally { state.tagManagerSaving = false; updateTagManagerControls(); }
}
function openTagNodeDialog(parent = "") {
  if (!canManageTags() || state.tagManagerSaving || !state.tagManagerData) return;
  $("tag-node-name").value = "";
  $("tag-node-parent").innerHTML = '<option value="">无父级（新建独立父级）</option>' + state.tagManagerData.tags.map(tag => `<option value="${escapeHTML(tag.name)}">${escapeHTML(tag.name)}</option>`).join("");
  $("tag-node-parent").value = parent;
  $("tag-node-title").textContent = parent ? `在「${parent}」下新建子级` : "新建父级标签";
  $("tag-node-error").hidden = true;
  if (!$("tag-node-dialog").open) $("tag-node-dialog").showModal();
  updateTagManagerControls();
  $("tag-node-name").focus();
}

async function saveManagerTagNode(event, action = "create") {
  event.preventDefault();
  if (!canManageTags() || state.tagManagerSaving || !state.tagManagerData) return;
  const creating = action === "create";
  const name = creating ? $("tag-node-name").value.trim() : state.tagManagerName;
  let parent = $(creating ? "tag-node-parent" : "tag-manager-parent").value.trim();
  if (!name) return;
  if (!creating && parent) {
    const selected = state.tagManagerData.tags.find(tag => tag.name.toLocaleLowerCase() === parent.toLocaleLowerCase());
    if (!selected) { tagManagerError("请选择已有的父级标签，或清空输入以设为独立标签。"); $("tag-manager-parent").focus(); renderManagerParentSuggestions(); return; }
    parent = selected.name;
  }
  hideManagerParentSuggestions();
  state.tagManagerSaving = true;
  tagManagerError(); $("tag-node-error").hidden = true; updateTagManagerControls();
  try {
    const data = await request("/api/tag-node", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name, parent, action, revision:state.tagManagerData.revision})});
    if (!data) throw new Error("未能确认标签关系已保存，请刷新后重试。");
    applyTagOrder(data.catalog);
    if (creating) $("tag-node-dialog").close();
    state.tagManagerName = creating ? parent || data.name : data.name;
    $("tag-manager-filter").value = "";
    $("tag-manager-feedback").textContent = creating ? `已创建“${data.name}”${parent ? `，父级为“${parent}”` : ""}。` : `已保存“${data.name}”的父级关系，股票原有标签归属保持不变。`;
    await refreshAfterTagWrite();
  } catch (error) {
    if (creating) { $("tag-node-error").textContent = error.message; $("tag-node-error").hidden = false; }
    else tagManagerError(error.message);
  } finally { state.tagManagerSaving = false; updateTagManagerControls(); }
}

function openManagerTagBatch() {
  if (state.tab !== "tags" || !canManageTags() || state.tagManagerSaving || state.tagManagerLoading || state.tagManagerMembersLoading || !state.tagManagerName || !state.tagManagerMembers) return;
  hideManagerSuggestions();
  state.requests["tag-manager-search"]?.abort();
  return openTagBatch(state.tagManagerName);
}

function bindTagManager() {
  $("tag-manager-create").addEventListener("click", () => openTagNodeDialog());
  $("tag-manager-child").addEventListener("click", () => openTagNodeDialog(state.tagManagerName));
  $("tag-node-form").addEventListener("submit", event => saveManagerTagNode(event));
  $("tag-manager-parent-form").addEventListener("submit", event => saveManagerTagNode(event, "parent"));
  $("tag-manager-parent").addEventListener("focus", renderManagerParentSuggestions);
  $("tag-manager-parent").addEventListener("input", renderManagerParentSuggestions);
  $("tag-manager-parent").addEventListener("blur", hideManagerParentSuggestions);
  $("tag-manager-parent").addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); hideManagerParentSuggestions(); return; }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    if (event.key === "Enter") {
      if (!$("tag-manager-parent-suggestions").hidden && state.tagParentSuggestionRows.length) {
        event.preventDefault(); chooseManagerParentTag(Math.max(0, state.tagParentSuggestionIndex));
      }
      return;
    }
    event.preventDefault();
    if ($("tag-manager-parent-suggestions").hidden) renderManagerParentSuggestions();
    const count = state.tagParentSuggestionRows.length;
    if (!count) return;
    state.tagParentSuggestionIndex = state.tagParentSuggestionIndex < 0 ? (event.key === "ArrowDown" ? 0 : count - 1)
      : (state.tagParentSuggestionIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    $("tag-manager-parent-suggestions").querySelectorAll("[data-parent-tag-index]").forEach((button, index) => button.setAttribute("aria-selected", String(index === state.tagParentSuggestionIndex)));
    $("tag-manager-parent").setAttribute("aria-activedescendant", `tag-parent-option-${state.tagParentSuggestionIndex}`);
    $("tag-manager-parent-suggestions").querySelector(`[data-parent-tag-index="${state.tagParentSuggestionIndex}"]`)?.scrollIntoView({block:"nearest"});
  });
  $("tag-manager-parent-suggestions").addEventListener("mousedown", event => event.preventDefault());
  $("tag-manager-parent-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-parent-tag-index]"); if (button) chooseManagerParentTag(Number(button.dataset.parentTagIndex)); });
  $("tag-node-close").addEventListener("click", () => { if (!state.tagManagerSaving) $("tag-node-dialog").close(); });
  $("tag-node-dialog").addEventListener("cancel", event => { if (state.tagManagerSaving) event.preventDefault(); });
  $("tag-manager-refresh").addEventListener("click", loadTagManager);
  $("tag-manager-delete").addEventListener("click", () => deleteManagerTag());
  $("tag-manager-filter").addEventListener("input", renderTagManagerCatalog);
  $("tag-manager-close").addEventListener("click", () => { if (!state.tagManagerSaving) selectManagerTag(""); });
  $("tag-manager-list").addEventListener("click", event => {
    const button = event.target.closest("[data-manage-tag]");
    if (button && !state.tagManagerSaving && !state.tagManagerLoading) {
      tagManagerError();
      const name = button.dataset.manageTag;
      selectManagerTag(name).then(() => { if (state.tab === "tags" && state.tagManagerName === name) $("tag-manager-detail").scrollIntoView({block:"nearest"}); });
    }
  });
  $("tag-manager-rename-form").addEventListener("submit", event => { event.preventDefault(); renameManagerTag(); });
  $("tag-manager-add-form").addEventListener("submit", addManagerStock);
  $("tag-manager-batch-add").addEventListener("click", openManagerTagBatch);
  const search = debounce(searchManagerStocks);
  $("tag-manager-stock-search").addEventListener("input", () => { state.tagManagerStock = null; hideManagerSuggestions(); if ($("tag-manager-stock-search").value.trim()) search(); });
  $("tag-manager-stock-search").addEventListener("keydown", event => { if (event.key === "Escape") hideManagerSuggestions(); });
  $("tag-manager-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-tag-suggestion]"); if (!button) return; const stock = state.tagManagerSearchResults[Number(button.dataset.tagSuggestion)]; state.tagManagerStock = stock; $("tag-manager-stock-search").value = `${stock.name} ${stock.code}`; state.requests["tag-manager-search"]?.abort(); hideManagerSuggestions(); });
  $("tag-manager-members").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove-stock-tag]");
    if (remove) { removeManagerStock(remove.dataset.removeStockTag); return; }
    const button = event.target.closest("[data-tag-stock-code]");
    if (button) chooseStock({code:button.dataset.tagStockCode, name:button.dataset.tagStockName});
  });
  $("tag-merge-confirm").addEventListener("click", () => renameManagerTag(true));
  $("tag-merge-cancel").addEventListener("click", cancelManagerMerge);
  $("tag-merge-close").addEventListener("click", cancelManagerMerge);
  $("tag-merge-dialog").addEventListener("cancel", event => { if (state.tagManagerSaving) event.preventDefault(); else state.tagManagerPendingMerge = null; });
  $("tag-delete-confirm").addEventListener("click", () => deleteManagerTag(true));
  $("tag-delete-cancel").addEventListener("click", cancelManagerDelete);
  $("tag-delete-close").addEventListener("click", cancelManagerDelete);
  $("tag-delete-dialog").addEventListener("cancel", event => { if (state.tagManagerSaving) event.preventDefault(); else state.tagManagerPendingDelete = null; });
}

function tagBatchError(message = "") {
  $("tag-batch-error").textContent = message;
  $("tag-batch-error").hidden = !message;
}

function tagBatchTokens(value) {
  const tokens = [...new Set(value.trim().split(/[\s,，;；、]+/u).filter(Boolean))];
  if (tokens.length > 200) throw new Error("每批最多输入 200 个名称或代码。");
  if (tokens.some(token => token.length > 100)) throw new Error("请用空格、逗号或换行分隔股票名称或代码。");
  return tokens;
}

function tagBatchStocks() {
  return [...new Map((state.tagBatchResults || []).filter(item => item.stock).map(item => [item.stock.code, item.stock])).values()];
}

function updateTagBatchControls() {
  const busy = Boolean(state.tagBatchSaving), results = state.tagBatchResults || [];
  const ready = Boolean(state.tagBatchRevision) && !state.tagBatchResolving && results.length && results.every(item => item.stock);
  const count = tagBatchStocks().length;
  $("tag-batch-submit").disabled = busy || !canManageTags() || !ready || state.tagBatchSubmitted;
  $("tag-batch-submit").textContent = count ? `添加 ${count} 只股票` : "添加股票";
  $("tag-batch-input").disabled = busy;
  $("tag-batch-preview").querySelectorAll("select").forEach(select => { select.disabled = busy; });
  ["tag-batch-close", "tag-batch-cancel"].forEach(id => { $(id).disabled = busy; });
  $("tag-batch-retry").disabled = busy || state.tagBatchCatalogLoading;
}

function renderTagBatchPreview() {
  const results = state.tagBatchResults || [], stocks = tagBatchStocks();
  $("tag-batch-preview").innerHTML = results.map((item, index) => `<li><span class="tag-batch-query">${escapeHTML(item.query)}</span><div>${item.stock ? `<strong>${escapeHTML(item.stock.name)}</strong><small>${escapeHTML(item.stock.code)}</small>`
    : item.pending ? '<span class="muted">正在匹配…</span>'
    : item.candidates?.length ? `<select data-tag-batch-choice="${index}" aria-label="为${escapeHTML(item.query)}选择股票"><option value="">请选择对应股票</option>${item.candidates.map(stock => `<option value="${escapeHTML(stock.code)}">${escapeHTML(stock.name)} · ${escapeHTML(stock.code)}</option>`).join("")}</select>`
    : `<span class="tag-batch-missing">${escapeHTML(item.error || "未找到已收录股票，请修改名称或代码。")}</span>`}</div></li>`).join("");
  $("tag-batch-summary").textContent = results.length ? `已识别 ${stocks.length} 只股票${results.some(item => !item.stock) ? "，请处理未匹配或待选择的项目。" : "，重复股票已自动去重。"}` : "可一次输入多只股票，输入后自动匹配。";
  updateTagBatchControls();
}

function cancelTagBatchSearch() {
  clearTimeout(state.tagBatchTimer);
  state.tagBatchGeneration = (state.tagBatchGeneration || 0) + 1;
  Object.entries(state.requests).forEach(([key, controller]) => { if (key.startsWith("tag-batch-search-")) controller.abort(); });
}

async function loadTagBatchCatalog() {
  if (state.tagBatchSaving) return;
  const session = state.tagBatchSession, name = state.tagBatchName;
  state.tagBatchCatalogLoading = true;
  state.tagBatchRevision = null;
  tagBatchError(); updateTagBatchControls();
  try {
    const catalog = await request("/api/tags", "tag-batch-catalog");
    if (!catalog || session !== state.tagBatchSession || !$("tag-batch-dialog").open) return;
    const tag = catalog.tags.find(tag => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!tag) throw new Error("这个标签已不存在，请关闭后刷新页面。");
    state.tagBatchName = tag.name;
    state.tagBatchRevision = catalog.revision;
    applyTagOrder(catalog);
  } catch (error) {
    if (session === state.tagBatchSession && $("tag-batch-dialog").open) tagBatchError(error.message);
  } finally {
    if (session === state.tagBatchSession) { state.tagBatchCatalogLoading = false; updateTagBatchControls(); }
  }
}

async function openTagBatch(name) {
  if (!canManageTags() || state.tagBatchSaving) return;
  cancelTagBatchSearch();
  state.tagBatchSession = (state.tagBatchSession || 0) + 1;
  state.tagBatchName = name;
  state.tagBatchRevision = null;
  state.tagBatchResults = [];
  state.tagBatchSubmitted = false;
  state.tagBatchResolving = false;
  $("tag-batch-input").value = "";
  $("tag-batch-title").textContent = `添加股票到「${name}」`;
  $("tag-batch-feedback").textContent = "";
  tagBatchError(); renderTagBatchPreview();
  if (!$("tag-batch-dialog").open) $("tag-batch-dialog").showModal();
  $("tag-batch-input").focus();
  await loadTagBatchCatalog();
}

function closeTagBatch() {
  if (state.tagBatchSaving) return;
  cancelTagBatchSearch();
  state.tagBatchSession = (state.tagBatchSession || 0) + 1;
  state.requests["tag-batch-catalog"]?.abort();
  $("tag-batch-dialog").close();
}

async function resolveTagBatchInput() {
  if (state.tagBatchSaving || !$("tag-batch-dialog").open) return;
  cancelTagBatchSearch();
  const generation = state.tagBatchGeneration;
  let tokens;
  try { tokens = tagBatchTokens($("tag-batch-input").value); }
  catch (error) { state.tagBatchResults = []; state.tagBatchResolving = false; tagBatchError(error.message); renderTagBatchPreview(); return; }
  state.tagBatchResults = tokens.map(query => ({query, pending: true}));
  state.tagBatchResolving = true;
  renderTagBatchPreview();
  let cursor = 0;
  const current = () => generation === state.tagBatchGeneration && $("tag-batch-dialog").open;
  const worker = async () => {
    while (current() && cursor < tokens.length) {
      const index = cursor++, query = tokens[index];
      try {
        const data = await request(`/api/stocks?${new URLSearchParams({q: query})}`, `tag-batch-search-${index}`);
        if (!current()) return;
        if (!data) throw new Error("读取失败，请修改输入后重试。");
        const rows = data.rows || [], exact = rows.filter(row => row.code === query || row.name === query || row.initials === query.toUpperCase());
        state.tagBatchResults[index] = {query, candidates: rows, stock: exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null};
      } catch (error) {
        if (!current()) return;
        state.tagBatchResults[index] = {query, error: error.message};
      }
      renderTagBatchPreview();
    }
  };
  await Promise.all(Array.from({length: Math.min(4, tokens.length)}, worker));
  if (current()) { state.tagBatchResolving = false; renderTagBatchPreview(); }
}

function changeTagBatchInput() {
  if (state.tagBatchSaving) return;
  cancelTagBatchSearch();
  state.tagBatchResults = [];
  state.tagBatchSubmitted = false;
  state.tagBatchResolving = Boolean($("tag-batch-input").value.trim());
  $("tag-batch-feedback").textContent = "";
  tagBatchError(); renderTagBatchPreview();
  state.tagBatchTimer = setTimeout(resolveTagBatchInput, 250);
}

async function saveTagBatch(event) {
  event.preventDefault();
  const results = state.tagBatchResults || [];
  if (!$("tag-batch-dialog").open || !canManageTags() || state.tagBatchSaving || state.tagBatchResolving || state.tagBatchSubmitted || !state.tagBatchRevision
    || !results.length || results.some(item => !item.stock)) return;
  state.tagBatchSaving = true;
  tagBatchError(); updateTagBatchControls();
  try {
    const data = await request("/api/tag-stocks", "tag-batch-save", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({tag: state.tagBatchName, codes: tagBatchStocks().map(stock => stock.code), revision: state.tagBatchRevision})});
    if (!data) throw new Error("未能确认保存结果，请刷新标签信息后重试。");
    state.tagBatchSubmitted = true;
    state.tagBatchRevision = data.catalog.revision;
    applyTagOrder(data.catalog);
    $("tag-batch-feedback").textContent = `已添加 ${data.added} 只股票${data.existing ? `，${data.existing} 只已在标签中` : ""}。`;
    await refreshAfterTagWrite();
  } catch (error) { tagBatchError(error.message); }
  finally { state.tagBatchSaving = false; updateTagBatchControls(); }
}

function bindTagBatch() {
  $("date-table-area").addEventListener("click", event => {
    const button = event.target.closest("[data-add-sector-tag]");
    if (button) openTagBatch(button.dataset.addSectorTag);
  });
  ["tag-batch-close", "tag-batch-cancel"].forEach(id => $(id).addEventListener("click", closeTagBatch));
  $("tag-batch-dialog").addEventListener("cancel", event => { event.preventDefault(); closeTagBatch(); });
  $("tag-batch-input").addEventListener("input", changeTagBatchInput);
  $("tag-batch-form").addEventListener("submit", saveTagBatch);
  $("tag-batch-retry").addEventListener("click", loadTagBatchCatalog);
  $("tag-batch-preview").addEventListener("change", event => {
    const select = event.target.closest("[data-tag-batch-choice]");
    if (!select || state.tagBatchSaving) return;
    const item = state.tagBatchResults?.[Number(select.dataset.tagBatchChoice)];
    if (!item) return;
    item.stock = item.candidates.find(stock => stock.code === select.value) || null;
    renderTagBatchPreview();
  });
}

function renderMeta(meta, initial = false) {
  state.shareholderAlertTypes = new Map((meta.shareholder_alerts?.rows || []).map(row => [row.code, row.types]));
  syncShareholderAlertIcons();
  document.documentElement.classList.toggle("read-only", !canEditTags());
  $("nav-blacklist").disabled = false;
  $("nav-tags").disabled = false;
  updateBlacklistControls();
  state.latestLimitUps = new Map((meta.latest_limit_ups || []).map(row => [String(row.code), Number(row.boards)]));
  const coverage = meta.coverage || {};
  const dates = [...new Set(meta.dates || [])].sort();
  meta.dates = dates;
  meta.query_dates = [...new Set([...dates, ...(meta.live?.dates || [])])].sort();
  $("range-label").textContent = `${dateLabel(meta.available_start || meta.range_start)} — ${dateLabel(meta.available_end || meta.range_end)}`;
  $("range-detail").textContent = `${numberValue(coverage.days)} 个有数据交易日 · 本地历史库`;
  const status = String(coverage.status || "").toLowerCase();
  const waitingForLatest = meta.auto_update_status === "waiting" && meta.missing_dates?.length === 1 && meta.missing_dates[0] === meta.auto_update_expected;
  const syncing = ["syncing", "loading", "collecting"].includes(status);
  const source = typeof meta.source === "object" ? (meta.source.name || JSON.stringify(meta.source)) : (meta.source || "公开数据");
  const partial = syncing || (!waitingForLatest && ["partial", "incomplete", "limited", "gaps"].includes(status));
  const unavailable = ["empty", "unavailable", "error"].includes(status) || !dates.length;
  $("coverage-banner").classList.toggle("partial", partial);
  $("coverage-banner").classList.toggle("unavailable", unavailable);
  $("coverage-title").textContent = unavailable ? "历史数据尚未收录" : syncing ? `免费公开数据 · ${source} · 正在归档` : waitingForLatest ? "历史数据持续更新" : partial ? `${source} · 部分覆盖，请留意数据缺口` : status === "complete" ? "历史数据已补齐" : `免费公开数据 · ${source}`;
  $("coverage-note").textContent = status === "complete" || waitingForLatest
    ? `${dateLabel(meta.available_start)} 至 ${dateLabel(meta.available_end)} · ${numberValue(coverage.days)} 个交易日${waitingForLatest ? "" : ` · 缺失日期 ${numberValue((meta.missing_dates || []).length)}`} · 来源：${source}`
    : coverage.note || "按来源公开股票池收录，数据完整性以实际收录情况为准。";
  $("coverage-count").textContent = `${numberValue(coverage.records)} 条记录 / ${numberValue(coverage.stocks)} 只股票`;
  const autoStatus = meta.auto_update_status;
  const checked = meta.auto_update_checked_at ? `${dateLabel(meta.auto_update_checked_at.slice(0, 10))} ${meta.auto_update_checked_at.slice(11, 16)}` : "";
  const pending = meta.auto_update_pending || [];
  const onlyHistoricalGaps = pending.length > 0 && meta.latest_date === meta.auto_update_expected && pending.every(day => day < meta.latest_date);
  const updateSchedule = `交易日 ${meta.auto_update_time || "15:30"} 更新`;
  $("auto-update-note").textContent = autoStatus === "updating"
    ? `自动更新已开启 · ${updateSchedule} · 正在检查并补充数据…`
    : onlyHistoricalGaps
      ? `自动更新已开启 · ${updateSchedule} · 最新收录 ${dateLabel(meta.latest_date)} · ${numberValue(pending.length)} 个历史日期待重试`
    : autoStatus === "error"
      ? `自动更新暂未完成 · ${updateSchedule} · 每 5 分钟自动重试${checked ? ` · 最近检查 ${checked}` : ""}`
      : autoStatus === "waiting"
        ? `自动更新已开启 · ${updateSchedule} · 等待 ${pending.map(dateLabel).join("、")} 来源数据 · 每 5 分钟重试${checked ? ` · 最近检查 ${checked}` : ""}`
        : autoStatus === "current"
          ? `自动更新已开启 · ${updateSchedule} · 最近检查 ${checked}`
          : "自动更新尚未启动，请重新启动本地服务。";
  $("auto-update-note").title = meta.auto_update_error || "按上海时间每个交易日 15:30 起检查当天数据；未发布时每 5 分钟重试，历史缺口继续补充。";
  if (meta.live?.enabled) {
    const live = meta.live;
    const stamp = live.fetched_at ? `${dateLabel(live.fetched_at.slice(0, 10))} ${live.fetched_at.slice(11, 19)}` : "";
    const progress = live.status === "error" ? "获取失败，保留上次数据并自动重试"
      : live.status === "waiting" ? "等待来源数据，每分钟重试"
      : live.polling ? "盘中暂定" : "交易时段自动检查";
    $("auto-update-note").textContent = `盘中每分钟更新 · ${progress}${stamp ? ` · 最近获取 ${stamp}` : ""} · 15:30 起确认收盘档案`;
    $("auto-update-note").title = `${live.note}${live.error ? `\n${live.error}` : ""}\n${$("auto-update-note").title}`;
  }
  $("footer-source").textContent = "公开数据";
  $("method-source").textContent = source;
  $("method-note").textContent = `${meta.method_note || "连板高度以数据源提供的收盘涨停记录为准。缺失记录不用于推断股票是否断板。"}${meta.scope_note ? `\n\n${meta.scope_note}` : ""}`;
  $("method-coverage").textContent = `${coverage.note || "以实际收录为准。"}\n已收录 ${numberValue(coverage.days)} 个交易日，${numberValue(coverage.stocks)} 只股票，${numberValue(coverage.records)} 条记录。`;
  $("method-updated").textContent = textValue(meta.updated_at);
  $("trade-date").min = meta.available_start || meta.range_start || "";
  $("trade-date").max = meta.query_dates.at(-1) || meta.available_end || meta.range_end || "";
  $("latest-date").disabled = !meta.query_dates.length;

  clearTimeout(state.metaPoll);
  const industryStatus = meta.industry_status || "empty";
  const cached = Boolean(meta.industry_fetched_at);
  $("industry-note").textContent = cached
    ? `行业：申万一级（当前分类） · ${dateLabel(meta.industry_fetched_at.slice(0, 10))} 获取${industryStatus === "updating" ? " · 正在检查更新" : industryStatus === "error" ? " · 更新失败，使用缓存" : ""}`
    : industryStatus === "error" ? "行业暂未获取成功，稍后自动重试。" : "正在自动获取申万行业分类…";
  if (meta.default_tag_mode === "concept_intersection") {
    $("industry-note").textContent = `默认标签：同花顺与财联社共有概念${meta.concept_fetched_at ? ` · ${dateLabel(meta.concept_fetched_at.slice(0, 10))} 获取` : ""}${meta.concept_status === "updating" ? " · 正在补充" : meta.concept_status === "partial" || meta.concept_status === "error" ? " · 部分待重试，保留已验证缓存" : ""}`;
  }
  $("method-note").textContent += meta.default_tag_mode === "concept_intersection"
    ? "\n\n默认标签取同花顺与财联社当前概念的交集，统一等价名称，排除昨日涨停、百日新高、省份等信息；未匹配不猜测补充。共有概念与自定义标签合并去重展示，自动更新保留自定义标签，手动移除的默认概念不会被加回。多个标签可跨列展示，股票总数去重。概念与注册省份均为当前资料，不代表历史当日归属。"
    : "\n\n标签默认取自申万一级分类，可按股票编辑，手动标签跨日期使用。多个标签可跨列展示，股票总数去重。标签与注册省份均为当前资料。";
  const registrationStatus = meta.registration_status || "empty";
  $("registration-note").textContent = meta.registration_fetched_at
    ? `注册省份：公司当前资料 · ${dateLabel(meta.registration_fetched_at.slice(0, 10))} 获取${registrationStatus === "updating" ? " · 正在检查更新" : registrationStatus === "error" ? " · 更新失败，使用缓存" : ""}`
    : registrationStatus === "error" ? "注册省份暂未获取成功，稍后自动重试。" : "正在自动获取公司注册省份…";
  $("method-note").textContent += "\n\n注册省份来自东方财富公司当前资料的省份字段，仅获取和保存省份。";
  $("method-note").textContent += "\n\n个股历史、同期竞争和同日涨停统一按全部已收录数据的起止日期统计，上方查询日期仅用于当日涨停查询。同期竞争比较前日同板数、下一交易日的晋级情况，沪深主板合并、ST 单独比较。从首板进二板到更高板数都逐轮展示，每个晋级批次计 1 轮胜负，同一轮涉及的对手另行列出；对手名单中的数字为与该股票交手的轮次。赢过和输给的名单均为涨停池比较结果；未入池不代表已确认未涨停，胜负标记为待行情核实。缺失交易日及最新收录日之后的结果不计入胜负。同日涨停统计全市场已收录股票，不限板数，每只股票每天计 1 次，不含本票，并列出具体日期。";
  $("method-note").textContent += "\n\n交易日概览的最高连板包含停牌保留高度。停复牌资料来自东方财富，只有确认全天停牌、且停牌前一交易日有连板记录的股票才保留原高度；不会把停牌日记为涨停，也不会增加涨停家数或同日涨停次数。复牌当日起不再按停牌保留。";
  state.metaPoll = setTimeout(refreshMeta, autoStatus === "updating" || industryStatus === "updating" || registrationStatus === "updating" || meta.suspension_updating ? 3000 : 60000);
}

async function refreshMeta() {
  try {
    const previousIndustry = state.meta?.industry_fetched_at;
    const previousConcepts = state.meta?.concept_fetched_at;
    const previousTagAliases = state.meta?.tag_alias_revision;
    const previousTagCatalog = state.meta?.tag_catalog_revision;
    const previousRegistration = state.meta?.registration_fetched_at;
    const previousStart = state.meta?.available_start;
    const previousEnd = state.meta?.available_end;
    const previousRecords = state.meta?.coverage?.records;
    const previousRevision = state.meta?.archive_updated_at;
    const previousLatest = state.meta?.query_dates?.at(-1) || state.meta?.latest_date;
    const previousLive = state.meta?.live?.fetched_at;
    const previousLiveDate = state.meta?.live?.date;
    const previousSuspension = state.meta?.suspension_revision;
    const followingLatest = !$("trade-date").value || $("trade-date").value === previousLatest;
    const meta = await request("/api/meta", "meta");
    if (meta) {
      state.meta = meta; renderMeta(meta); updateDateNavigation();
      loadSiteLinks();
      const archiveChanged = meta.archive_updated_at !== previousRevision || meta.available_start !== previousStart || meta.available_end !== previousEnd || meta.coverage?.records !== previousRecords;
      const profilesChanged = meta.industry_fetched_at !== previousIndustry || meta.registration_fetched_at !== previousRegistration || meta.concept_fetched_at !== previousConcepts || meta.tag_alias_revision !== previousTagAliases || meta.tag_catalog_revision !== previousTagCatalog;
      const latestQuery = meta.query_dates.at(-1);
      const queryDateChanged = followingLatest && latestQuery && latestQuery !== previousLatest;
      if (queryDateChanged) $("trade-date").value = latestQuery;
      updateDateNavigation();
      const liveChanged = meta.live?.fetched_at !== previousLive &&
        (meta.live?.dates?.includes($("trade-date").value) || previousLiveDate === $("trade-date").value);
      if (state.tab === "date" && (archiveChanged || profilesChanged || liveChanged || queryDateChanged || meta.suspension_revision !== previousSuspension)) loadDate({quiet: true});
      else if (state.tab === "date" && state.dateData) renderDateStatus(state.dateData);
      if (state.tab === "stock" && (archiveChanged || profilesChanged)) loadStock({remember: false});
      if (state.tab === "intraday" && profilesChanged) loadIntraday();
      else if (state.tab === "intraday" && meta.live?.enabled) refreshVisibleMinuteData();
      if (state.tab === "blacklist" && profilesChanged) loadBlacklist();
    }
  } catch {
    $("auto-update-note").textContent = "更新状态暂时无法读取，将在 1 分钟后重试。";
    clearTimeout(state.metaPoll);
    state.metaPoll = setTimeout(refreshMeta, 60000);
  }
}

function updateDateNavigation() {
  const date = $("trade-date").value;
  const dates = state.meta?.query_dates || state.meta?.dates || [];
  $("prev-date").disabled = !dates.some((item) => item < date);
  $("next-date").disabled = !dates.some((item) => item > date);
}
function getDateQuery() { return new URLSearchParams({ date: $("trade-date").value, boards: state.boards, exclude_st: state.excludeST ? "1" : "0", exclude_gem: state.excludeGEM ? "1" : "0" }); }

function renderBoardOptions(counts = [], availableTotal = null) {
  const distribution = new Map();
  counts.forEach((group) => { const boards = Number(group.boards); if (Number.isInteger(boards) && boards > 0) distribution.set(boards, Number(group.count) || 0); });
  if (state.boards && !distribution.has(Number(state.boards))) distribution.set(Number(state.boards), 0);
  const options = [{ value: "", label: "全部", count: availableTotal }, ...[...distribution].sort((a, b) => a[0] - b[0]).map(([boards, count]) => ({ value: String(boards), label: boards === 1 ? "首板" : `${boards} 板`, count }))];
  $("board-options").innerHTML = options.map((option) => `<button type="button" class="board-chip" data-boards="${option.value}" aria-pressed="${String(option.value === state.boards)}" aria-label="${option.label}${option.count === null ? "，数量待查询" : `，${numberValue(option.count)} 只股票`}">${option.label} <span class="board-chip-count">${numberValue(option.count)}</span></button>`).join("");
  $("board-options").setAttribute("aria-busy", "false");
}

async function loadDate({quiet = false} = {}) {
  if (!quiet) setView("date", false);
  if (!$("trade-date").value) {
    state.requests.date?.abort(); state.dateData = null; clearError(); setStats("date-stats");
    const available = Boolean(state.meta?.dates?.length);
    $("date-table-area").innerHTML = emptyHTML(available ? "请选择查询日期" : "还没有可查询的交易日", available ? "选择实验数据区间内的日期，查看对应的来源池记录。" : "等待历史数据收录完成后，即可按日期查看涨停记录。", "calendar");
    $("date-table-area").setAttribute("aria-busy", "false"); renderBoardOptions();
    $("date-result-count").textContent = "0"; $("prev-date").disabled = true; $("next-date").disabled = true;
    $("date-subtitle").textContent = "选择交易日，查看涨停股票明细。";
    $("date-coverage-note").textContent = "仅供参考"; updateURL(); return;
  }
  if (!quiet) {
    clearError();
    $("date-table-area").innerHTML = loadingHTML();
    $("date-table-area").setAttribute("aria-busy", "true");
    $("board-options").setAttribute("aria-busy", "true");
    $("board-options").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    setStats("date-stats");
    updateDateNavigation();
    updateURL();
  }
  const query = String(getDateQuery());
  try {
    const data = await request(`/api/date?${query}`, "date");
    if (!data || state.tab !== "date" || query !== String(getDateQuery())) return;
    const scroll = quiet ? $("date-table-area").querySelector(".industry-board")?.scrollLeft : null;
    const position = quiet ? {left: window.scrollX, top: window.scrollY, behavior: "instant"} : null;
    state.dateData = data;
    renderDate(data);
    if (scroll != null) { const board = $("date-table-area").querySelector(".industry-board"); if (board) board.scrollLeft = scroll; updateIndustryNavigation(); }
    if (position) window.scrollTo(position);
  } catch (error) {
    if (quiet) { $("auto-update-note").textContent += " · 页面刷新未完成，保留上次结果"; return; }
    showError(error, loadDate);
    $("date-table-area").innerHTML = emptyHTML("未能加载这个交易日", "请检查本地服务或点击上方「重新加载」。", "calendar");
    renderBoardOptions();
    $("date-table-area").setAttribute("aria-busy", "false");
  }
}

function renderDate(data) {
  const rows = data.rows || [];
  const stats = data.stats || { total: rows.length, consecutive: rows.filter((row) => row.boards >= 2).length, max_boards: Math.max(0, ...rows.map((row) => Number(row.boards) || 0)), first_boards: rows.filter((row) => row.boards === 1).length };
  setStats("date-stats", stats);
  const suspended = data.suspended_rows || [];
  $("date-height-note").textContent = suspended.length ? `含停牌保留高度 · 当日最高 ${numberValue(data.trading_max_boards)} 板`
    : data.suspension_status === "error" ? "当日池最高 · 停牌资料待核实"
    : ["unknown", "updating"].includes(data.suspension_status) ? "当日池最高 · 停牌资料核查中" : "当前筛选最高高度";
  $("date-result-count").textContent = numberValue(rows.length);
  renderDateStatus(data);
  $("date-coverage-note").classList.toggle("warning", !rows.length || ["partial", "incomplete"].includes(state.meta?.coverage?.status));
  
  $("date-table-area").setAttribute("aria-busy", "false");
  const noSelectedBoards = ["ok", "provisional"].includes(data.data_status) && Number(data.available_total) > 0 && state.boards;
  const highlightOptions = {highlightLatest: !data.provisional};
  $("date-table-area").innerHTML = rows.length ? renderIndustryColumns(rows, data.tag_board_counts, highlightOptions) : noSelectedBoards
    ? emptyHTML(`没有 ${state.boards} 板股票`, `当前日期与其他筛选条件下，该板数为 0。点击「全部」查看 ${numberValue(data.available_total)} 只股票。`)
    : emptyHTML("没有符合条件的涨停记录", data.coverage_note || "这个日期可能不是交易日、尚未收录，或没有满足当前筛选条件的股票。", "calendar");
  if (suspended.length) $("date-table-area").innerHTML = renderSuspendedLeaders(suspended, highlightOptions) + $("date-table-area").innerHTML;
  if (["unknown", "updating"].includes(data.suspension_status)) {
    clearTimeout(state.metaPoll); state.metaPoll = setTimeout(refreshMeta, 3000);
  }
  document.querySelectorAll("[data-grouping]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.grouping === state.grouping)));
  renderBoardOptions(data.board_counts || [], data.available_total ?? rows.length);
  updateIndustryNavigation();
}

function renderDateStatus(data) {
  const date = data.date || $("trade-date").value;
  const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("zh-CN", {weekday: "long"});
  const live = state.meta?.live?.date === date ? state.meta.live : data.live;
  const stamp = data.fetched_at ? data.fetched_at.slice(11, 19) : "";
  const problem = live?.status === "error" ? " · 获取失败，保留上次数据并重试"
    : live?.status === "waiting" ? " · 来源待更新，保留上次数据并重试"
    : live?.stale ? " · 上次快照，等待更新" : "";
  const freshness = data.provisional ? `盘中暂定${stamp ? ` · 获取于 ${stamp}` : ""} · 每分钟刷新${problem}`
    : data.live ? "盘中来源待更新 · 每分钟自动重试" : "";
  $("date-subtitle").textContent = `${dateLabel(date)} · ${weekday}${freshness ? ` · ${freshness}` : ""}`;
  $("date-coverage-note").textContent = freshness ? `${freshness} · 收盘后确认` : "仅供参考";
  $("date-coverage-note").title = data.provisional ? data.coverage_note : "";
}

function updateIndustryNavigation() {
  const board = $("date-table-area").querySelector(".industry-board");
  if (!board) return;
  $("date-table-area").querySelectorAll("[data-industry-scroll]").forEach(button => {
    button.disabled = Number(button.dataset.industryScroll) < 0
      ? board.scrollLeft <= 1 : board.scrollLeft + board.clientWidth >= board.scrollWidth - 1;
  });
}

function stockTags(row) {
  const tags = allStockTags(row);
  const parents = new Set(tags.flatMap(tag => tagAncestors(tag).map(name => name.toLocaleLowerCase())));
  return tags.filter(tag => !parents.has(tag.toLocaleLowerCase()));
}

function allStockTags(row) {
  return sortedTags(Array.isArray(row.tags) ? row.tags : row.industry ? [row.industry] : []);
}

function tagHierarchy() {
  const nodes = state.meta?.tag_hierarchy || (state.emptyTagHierarchy ||= []);
  if (state.tagHierarchySource !== nodes || !state.tagHierarchyCache) {
    const parents = new Map(nodes.filter(node => node.parent).map(node => [node.name.toLocaleLowerCase(), node.parent]));
    state.tagHierarchySource = nodes;
    state.tagHierarchyCache = {parents, parentKeys: new Set([...parents.values()].map(name => name.toLocaleLowerCase()))};
  }
  return state.tagHierarchyCache;
}

function tagAncestors(name) {
  const result = [], seen = new Set([name.toLocaleLowerCase()]), parents = tagHierarchy().parents;
  while (parents.has(name.toLocaleLowerCase())) {
    name = parents.get(name.toLocaleLowerCase());
    if (seen.has(name.toLocaleLowerCase())) break;
    seen.add(name.toLocaleLowerCase()); result.push(name);
  }
  return result;
}

function tagRoot(name) { return tagAncestors(name).at(-1) || name; }

function renderHierarchyStockGroups(rows, root, highlightLatest) {
  if (!tagHierarchy().parentKeys.has(root.toLocaleLowerCase())) return `<ul class="industry-stock-list">${rows.map(row => renderStockCard(row, {highlightLatest})).join("")}</ul>`;
  const groups = new Map();
  rows.forEach(row => {
    const tags = allStockTags(row).filter(tag => tagRoot(tag) === root);
    const leaves = tags.filter(tag => !tags.some(other => tagAncestors(other).some(parent => parent.toLocaleLowerCase() === tag.toLocaleLowerCase())));
    leaves.forEach(tag => { if (!groups.has(tag)) groups.set(tag, []); groups.get(tag).push(row); });
  });
  const sections = [], cohorts = new Map();
  for (const [tag, stocks] of [...groups].sort((a,b) => compareTags(a[0],b[0]))) {
    // Subgroups share a parent column and board height, so merge only exact
    // stock-code sets here, including higher boards as well as first boards.
    const key = JSON.stringify(stocks.map(row => String(row.code)).sort());
    const existing = cohorts.get(key);
    if (existing) existing.labels.push(tag);
    else {
      const section = {labels: [tag], stocks};
      sections.push(section); cohorts.set(key, section);
    }
  }
  return sections.map(({labels, stocks}) => {
    const name = labels.join(" / ");
    const heading = labels[0] === root ? "" : `<header>${labels.map(tag => {
      const ancestors = tagAncestors(tag).reverse().slice(1);
      return `${ancestors.length ? `<small>${escapeHTML(ancestors.join(" / "))} / </small>` : ""}${industryColumnHeading([tag], canManageTags())}`;
    }).join('<span class="matrix-label-divider" aria-hidden="true"> / </span>')}<small>${stocks.length} 只</small></header>`;
    return `<section class="matrix-tag-subgroup" data-child-tag="${escapeHTML(name)}">${heading}<ul class="industry-stock-list">${stocks.map(row => renderStockCard(row, {highlightLatest})).join("")}</ul></section>`;
  }).join("");
}

function tagRanks() {
  const order = state.meta?.tag_order;
  if (!Array.isArray(order)) return null;
  if (state.tagOrderCache !== order) {
    state.tagOrderCache = order;
    state.tagRankCache = new Map(order.map((tag, index) => [tag.toLocaleLowerCase(), index]));
  }
  return state.tagRankCache;
}

function compareTags(a, b) {
  const ranks = tagRanks();
  if (!ranks) return 0;
  const left = a.toLocaleLowerCase(), right = b.toLocaleLowerCase();
  return (ranks.get(left) ?? Infinity) - (ranks.get(right) ?? Infinity) || (left < right ? -1 : left > right ? 1 : 0);
}

function sortedTags(tags) { return [...tags].sort(compareTags); }

function applyTagOrder(catalog) {
  state.meta ||= {};
  state.meta.tag_order = catalog.tags.map(tag => tag.name);
  state.meta.tag_hierarchy = catalog.hierarchy || [];
  state.meta.tag_catalog_revision = catalog.revision;
}

async function refreshTagOrder() {
  try {
    const catalog = await request("/api/tags", "tag-order");
    if (catalog) applyTagOrder(catalog);
  } catch { /* Keep the last verified ordering until the next metadata refresh. */ }
}

function canEditTags() {
  return state.meta?.capabilities?.edit_tags !== false;
}

function canEditNotes() {
  return state.meta?.capabilities?.edit_notes !== false;
}

function renderStockNote(row) {
  const content = typeof row.note === "string" ? row.note : "";
  if (!canEditNotes() && !content) return "";
  return `<button type="button" class="stock-note-button ${content ? "has-note" : ""}" data-edit-stock-note="${escapeHTML(row.code)}" aria-label="${canEditNotes() ? "编辑" : "查看"}${escapeHTML(row.name)}备注"><span class="stock-note-preview">${escapeHTML(content || "点击添加备注")}</span></button>`;
}

function renderStockHeaderNote(stock, loading = false) {
  hideStockNoteTooltip();
  const container = $("stock-profile-note");
  container.innerHTML = loading || stock.name === "尚未收录" ? "" : renderStockNote(stock);
  container.hidden = !container.innerHTML;
  if (container.hidden) container.removeAttribute("data-note-code");
  else container.setAttribute("data-note-code", stock.code);
}

function regionLabel(row) {
  const province = row.registered_province;
  if (!province) return "地区待补充";
  return province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区/g, "").replace(/[省市]$/, "");
}

function nameInitials(row) {
  return typeof row.initials === "string" ? row.initials.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

function codeDigits(row) {
  const code = String(row.code ?? "");
  return /^[0-9]{6}$/.test(code) ? code : "";
}

function orderMatchingGroups(groups, unknown, sequenceOf, maxLength) {
  const matches = new Map();
  for (const [sequence, stocks] of groups) {
    if (sequence === unknown) continue;
    // Scan every position, keeping each stock once per token, across all matching groups.
    const tokens = new Set();
    for (let length = Math.min(maxLength, sequence.length); length >= 1; length--) {
      for (let start = 0; start <= sequence.length - length; start++) {
        tokens.add(sequence.slice(start, start + length));
      }
    }
    for (const token of tokens) {
      if (!matches.has(token)) matches.set(token, new Map());
      stocks.forEach(stock => matches.get(token).set(String(stock.code), stock));
    }
  }
  const ordered = [...matches].filter(([token, stocks]) => token.length === 1 || stocks.size > 1)
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], "en"))
    .map(([token, stocks]) => [token, [...stocks.values()].sort((a, b) =>
      sequenceOf(a).indexOf(token) - sequenceOf(b).indexOf(token)
      || sequenceOf(a).localeCompare(sequenceOf(b), "en") || String(a.code).localeCompare(String(b.code)))]);
  if (groups.has(unknown)) ordered.push([unknown, [...groups.get(unknown)].sort((a, b) => String(a.code).localeCompare(String(b.code)))]);
  return ordered;
}

function orderPinyinGroups(groups, unknown) {
  return orderMatchingGroups(groups, unknown, nameInitials, 4);
}

function orderCodeGroups(groups, unknown) {
  return orderMatchingGroups(groups, unknown, codeDigits, 6);
}

function shareholderHasAlert(code) {
  return (state.shareholderAlertTypes?.get(String(code)) || []).some(type => !shareholderTypeBlocked(type));
}

function syncShareholderAlertIcons() {
  for (const button of document.querySelectorAll("[data-shareholder-code]")) {
    const active = shareholderHasAlert(button.dataset.shareholderCode);
    button.classList.toggle("has-shareholder-alert", active);
    if (active) button.setAttribute("aria-description", "今日有未屏蔽的共同股东同涨停");
    else button.removeAttribute("aria-description");
  }
}

function renderShareholderIcon(stock) {
  const active = shareholderHasAlert(stock.code);
  return `<button type="button" class="shareholder-icon${active ? " has-shareholder-alert" : ""}" data-shareholder-code="${escapeHTML(stock.code)}" aria-label="查看${escapeHTML(stock.name || stock.code)}的共同股东"${active ? ' aria-description="今日有未屏蔽的共同股东同涨停"' : ""} aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-4-5"/></svg></button>`;
}

function renderStockCard(row, {highlightLatest = true} = {}) {
  const boards = Number(row.boards) || 0;
  const location = regionLabel(row);
  const tags = stockTags(row);
  const highlighted = highlightLatest && row.date !== state.meta?.latest_date && latestLimitUp(row);
  const blacklisted = row.blacklisted === true;
  const initials = nameInitials(row);
  return `<li class="industry-stock ${highlighted ? "latest-limit-up" : ""}${blacklisted ? " blacklisted-stock" : ""}" data-card-code="${escapeHTML(row.code)}"><div class="industry-stock-top"><button type="button" class="stock-name-button" data-stock-code="${escapeHTML(row.code)}" data-stock-name="${escapeHTML(row.name)}">${escapeHTML(textValue(row.name))}</button>${renderShareholderIcon(row)}${blacklisted ? '<span class="stock-blacklist-badge">黑名单</span>' : ""}<span class="board-badge ${boards >= 5 ? "high" : boards <= 1 ? "first" : ""}">${boards ? `${boards} 板` : "—"}</span></div>${highlighted ? latestLimitBadge(row) : ""}<div class="industry-stock-meta"><span class="row-stock-code">${escapeHTML(row.code)}</span><span class="stock-initials" title="股票名称首字母：${escapeHTML(initials || "暂未获取")}">${escapeHTML(initials || "—")}</span><span class="stock-location">${escapeHTML(location)}</span></div>${row.suspended ? renderSuspensionNote(row) : ""}<div class="stock-tags">${tags.map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}${canEditTags() ? `<button type="button" class="edit-stock-tags" data-edit-stock-tags="${escapeHTML(row.code)}" aria-label="编辑${escapeHTML(row.name)}标签">编辑</button>` : ""}</div><div class="stock-note-row" data-note-code="${escapeHTML(row.code)}">${renderStockNote(row)}</div></li>`;
}

function renderSuspensionNote(row) {
  return `<div class="suspension-card-note" role="group" aria-label="停牌信息"><div class="suspension-status"><i aria-hidden="true"></i>停牌中</div><dl class="suspension-dates"><div><dt>末次涨停</dt><dd><time datetime="${escapeHTML(row.board_date)}">${escapeHTML(dateLabel(row.board_date))}</time></dd></div><div><dt>预计复牌</dt><dd>${row.resume_date ? `<time datetime="${escapeHTML(row.resume_date)}">${escapeHTML(dateLabel(row.resume_date))}</time>` : "待公告"}</dd></div></dl></div>`;
}

function renderSuspendedLeaders(rows, options = {}) {
  return `<section class="suspended-leaders" aria-label="停牌保留高度"><header><h4>停牌保留高度</h4><p>保留停牌前连板高度，未计入当日涨停家数</p></header><ul class="industry-stock-list">${rows.map(row => renderStockCard(row, options)).join("")}</ul></section>`;
}

function industryTagBoardCounts(rows) {
  const counts = Object.create(null);
  rows.forEach(row => [...new Set(allStockTags(row).flatMap(tag => [tag, tagRoot(tag)]))].forEach(tag => {
    const heights = counts[tag] ||= Object.create(null);
    heights[row.boards] = (heights[row.boards] || 0) + 1;
  }));
  return counts;
}

function industryGroupRank(stocks, boardCounts) {
  const counts = Object.entries(boardCounts || {}).filter(([height, count]) => Number(height) > 0 && Number(count) > 0);
  return counts.length ? {
    height: Math.max(...counts.map(([height]) => Number(height))),
    total: counts.reduce((total, [, count]) => total + Number(count), 0),
  } : {
    height: Math.max(...stocks.map(row => Number(row.boards) || 0)),
    total: stocks.length,
  };
}

function industryColumnHeading(labels, addable) {
  return labels.map(label => `<span class="matrix-label-item"><span>${escapeHTML(label)}</span>${addable ? `<button type="button" class="matrix-add-stock" data-add-sector-tag="${escapeHTML(label)}" aria-label="向${escapeHTML(label)}添加股票" title="添加股票"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` : ""}</span>`).join('<span class="matrix-label-divider" aria-hidden="true"> / </span>');
}

function mergeIdenticalFirstBoardGroups(ordered, tagBoards, separateLabel = null, protectedLabels = new Set()) {
  const columns = [], cohorts = new Map();
  for (const [name, stocks] of ordered) {
    const unique = [...new Map(stocks.map(row => [String(row.code), row])).values()];
    const counts = Object.create(null);
    unique.forEach(row => { counts[Number(row.boards)] = (counts[Number(row.boards)] || 0) + 1; });
    const daily = Object.entries(tagBoards[name] || counts).filter(([, count]) => Number(count) > 0);
    // A board filter or a suppressed leader must not make different daily cohorts look identical.
    const complete = daily.length === Object.keys(counts).length
      && daily.every(([height, count]) => counts[Number(height)] === Number(count));
    const key = name !== separateLabel && !protectedLabels.has(name.toLocaleLowerCase()) && counts[1] && complete ? JSON.stringify(unique.map(row => [String(row.code), Number(row.boards)])
      .sort((a, b) => a[0].localeCompare(b[0]))) : null;
    const existing = key === null ? null : cohorts.get(key);
    if (existing) existing.labels.push(name);
    else {
      const column = {labels: [name], stocks: unique};
      columns.push(column);
      if (key !== null) cohorts.set(key, column);
    }
  }
  return columns;
}

function renderIndustryColumns(rows, dailyTagBoards = null, {highlightLatest = true} = {}) {
  const regional = state.grouping === "region";
  const phonetic = state.grouping === "pinyin";
  const numeric = state.grouping === "code";
  const matchingMode = phonetic || numeric;
  const groupType = numeric ? "代码分组" : phonetic ? "拼音分组" : regional ? "地区" : "行业";
  const unknown = matchingMode ? "#" : regional ? "地区待补充" : "独苗";
  const groups = new Map();
  const tagBoards = dailyTagBoards || industryTagBoardCounts(rows);
  const solitaryTags = new Set(Object.entries(tagBoards).filter(([, counts]) =>
    Object.values(counts).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0) === 1).map(([tag]) => tag));
  rows.forEach(row => {
    let labels = numeric ? [codeDigits(row) || unknown] : phonetic ? [nameInitials(row) || unknown] : regional ? [regionLabel(row)] : [...new Set(allStockTags(row).map(tagRoot))];
    const solitary = !regional && !matchingMode && labels.every(label => solitaryTags.has(label) && !tagHierarchy().parentKeys.has(label.toLocaleLowerCase()));
    if (solitary) labels = [unknown];
    else if (!regional && !matchingMode && Number(row.boards) > 1) {
      const related = labels.filter(label => Object.entries(tagBoards[label] || {})
        .some(([height, count]) => Number(height) !== Number(row.boards) && Number(count) > 0));
      const parents = labels.filter(label => tagHierarchy().parentKeys.has(label.toLocaleLowerCase()));
      labels = [...new Set([...parents, ...(related.length ? related : labels.slice(0, 1))])];
    }
    (labels.length ? labels : [unknown]).forEach(label => {
      if (!groups.has(label)) groups.set(label, []);
      if (!groups.get(label).some(stock => stock.code === row.code)) groups.get(label).push(row);
    });
  });
  // Keep the day's leader and follower counts when a single board height is selected.
  const groupRanks = matchingMode ? null : new Map([...groups].map(([name, stocks]) =>
    [name, industryGroupRank(stocks, regional || name === unknown ? null : tagBoards[name])]));
  const ordered = matchingMode ? (numeric ? orderCodeGroups(groups, unknown) : orderPinyinGroups(groups, unknown)) : [...groups].sort((a, b) => {
    if (a[0] === unknown) return 1;
    if (b[0] === unknown) return -1;
    const left = groupRanks.get(a[0]), right = groupRanks.get(b[0]);
    return right.height - left.height || right.total - left.total
      || (!regional ? compareTags(a[0], b[0]) : 0) || a[0].localeCompare(b[0], "zh-CN");
  });
  const columns = !regional && !matchingMode ? mergeIdenticalFirstBoardGroups(ordered, tagBoards, unknown, tagHierarchy().parentKeys)
    : ordered.map(([name, stocks]) => ({labels: [name], stocks}));
  const seen = new Set();
  const repeated = columns.some(column => column.stocks.some(row => {
    if (seen.has(row.code)) return true;
    seen.add(row.code); return false;
  }));
  const heights = [...new Set(rows.map(row => Number(row.boards)))].sort((a, b) => b - a);
  const sections = heights.map(height => {
    const label = height === 1 ? "首板" : `${height} 板`;
    const total = rows.filter(row => Number(row.boards) === height).length;
    const cells = columns.map(({labels, stocks}) => {
      const name = labels.join(" / "), merged = labels.length > 1;
      const selected = stocks.filter(row => Number(row.boards) === height);
      const orderedStocks = matchingMode ? selected : selected.sort((a, b) => String(a.code).localeCompare(String(b.code)));
      const matching = matchingMode || !highlightLatest ? orderedStocks : prioritizeLatest(orderedStocks, true);
      const addable = !regional && !matchingMode && name !== unknown && (state.meta?.capabilities?.manage_tags ?? canEditTags());
      return `<section class="matrix-cell ${matching.length ? "" : "matrix-cell-empty"}${merged ? " matrix-cell-merged" : ""}" data-group-label="${escapeHTML(name)}" aria-label="${escapeHTML(name)}，${label}，${matching.length} 只股票"><header class="matrix-cell-header"><h5${merged ? ` title="股票名单相同，合并展示：${escapeHTML(name)}"` : ""}>${industryColumnHeading(labels, addable)}</h5><span>${matching.length}<small>只</small></span></header>${matching.length ? (!regional && !matchingMode ? renderHierarchyStockGroups(matching, labels[0], highlightLatest) : `<ul class="industry-stock-list">${matching.map(row => renderStockCard(row, {highlightLatest})).join("")}</ul>`) : '<div class="matrix-empty" aria-label="本组没有这个板数的股票">—</div>'}</section>`;
    }).join("");
    return `<section class="board-height-section" data-board-height="${height}" aria-label="${label}，${total} 只股票"><header class="board-height-heading"><h4>${label}</h4><span>${total} 只股票</span></header><div class="board-matrix-row">${cells}</div></section>`;
  }).join("");
  const matchingHint = numeric ? "6 → 5 → 4 → 3 → 2 → 1 位连续数字匹配，同一股票可跨组展示" : "4 → 3 → 2 → 1 个连续字母匹配，同一股票可跨组展示";
  const mergeHint = columns.length < ordered.length ? `<span class="multi-tag-note"> · 相同首板合并为 ${columns.length} 列</span>` : "";
  return `<div class="industry-board-summary"><span><strong>${ordered.length}</strong> 个${groupType} · <strong>${rows.length}</strong> 只股票${matchingMode ? `<span class="multi-tag-note"> · ${matchingHint}</span>` : repeated ? '<span class="multi-tag-note"> · 多标签跨列显示</span>' : ""}${mergeHint}${highlightLatest && rows[0]?.date !== state.meta?.latest_date ? latestPriorityNote() : ""}</span><div class="industry-board-controls"><span class="industry-scroll-hint">左右查看${groupType}</span><button type="button" class="icon-button" data-industry-scroll="-1" aria-label="查看左侧分组">←</button><button type="button" class="icon-button" data-industry-scroll="1" aria-label="查看右侧分组">→</button></div></div><div class="industry-board" role="region" aria-label="按${groupType}分列、按连板高度分行的股票" tabindex="0"><div class="board-comparison" style="--matrix-columns:${columns.length}">${sections}</div></div>`;
}

function renderTagEditor() {
  $("tag-editor-list").innerHTML = state.tagDraft.length ? state.tagDraft.map((tag, index) => ({tag,index,name:tag.split("/").at(-1).trim()})).sort((a,b) => compareTags(a.name,b.name)).map(({tag,index,name}, position) => `<div class="tag-edit-chip"><span class="tag-edit-path" data-tag-path="${index}" hidden></span><input class="tag-name-input" type="text" value="${escapeHTML(name)}" maxlength="30" required data-tag-index="${index}" aria-label="标签 ${position + 1}"><button type="button" data-remove-tag="${index}" aria-label="移除标签 ${escapeHTML(tag)}">×</button></div>`).join("") : '<p class="tag-empty-hint">暂无标签，保存后将归入“独苗”。</p>';
  updateTagEditorPaths();
  $("tag-editor-error").hidden = true;
  renderTagSuggestions();
}

function updateTagEditorPaths() {
  $("tag-editor-list").querySelectorAll("[data-tag-path]").forEach(path => {
    const parts = state.tagDraft[Number(path.dataset.tagPath)].split("/").map(part => part.trim());
    const parents = [...tagAncestors(parts[0]).reverse(), ...parts.slice(0, -1)];
    path.textContent = parents.length ? `${parents.join(" / ")} /` : "";
    path.hidden = !parents.length;
  });
  const defaults = defaultEditorTags(state.tagEditorData);
  $("tag-source-label").textContent = defaults.length ? `默认标签：${defaults.map(tag => [...tagAncestors(tag).reverse(), tag].join(" / ")).join("、")}` : "暂无默认标签，可以自行添加标签。";
}

function defaultEditorTags(data) {
  return sortedTags(Array.isArray(data?.source_tags) ? data.source_tags : data?.source_tag ? [data.source_tag] : []);
}

function hideTagSuggestions() {
  state.tagSuggestionsActive = false;
  state.tagSuggestionRows = [];
  state.tagSuggestionIndex = -1;
  $("tag-new-suggestions").hidden = true;
  $("tag-new").setAttribute("aria-expanded", "false");
  $("tag-new").removeAttribute("aria-activedescendant");
}

function matchesExistingTag(name, query) {
  const value = name.toLocaleLowerCase().replace(/\s+/g, "");
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (!needle) return false;
  let offset = 0;
  for (const letter of needle) {
    const index = value.indexOf(letter, offset);
    if (index < 0) return false;
    offset = index + letter.length;
  }
  return true;
}

function positionTagSuggestions() {
  const list = $("tag-new-suggestions");
  if (list.hidden) return;
  const rect = $("tag-new").getBoundingClientRect();
  const width = Math.min(rect.width, window.innerWidth - 24), top = rect.bottom + 5;
  list.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  list.style.top = `${top}px`;
  list.style.width = `${width}px`;
  list.style.maxHeight = `${Math.max(32, Math.min(200, window.innerHeight - top - 12))}px`;
}

function renderTagSuggestions() {
  const input = $("tag-new"), list = $("tag-new-suggestions"), query = (input.value || "").trim();
  if (!state.tagSuggestionsActive || !$("tag-dialog").open || !state.tagEditorData || !query || state.tagSaving || state.tagBlacklistSaving) { hideTagSuggestions(); return; }
  const draft = new Set((state.tagDraft || []).map(tag => tag.split("/").at(-1).trim().toLocaleLowerCase()));
  const parts = query.split("/").map(part => part.trim()), parents = parts.slice(0, -1), child = parts.at(-1);
  state.tagSuggestionRows = (state.tagSuggestionCatalog?.tags || []).filter(tag => {
    const ancestors = tagAncestors(tag.name);
    const matches = parents.length
      ? parents.every(Boolean) && ancestors.length >= parents.length && parents.every((parent,index) => parent.toLocaleLowerCase() === ancestors[parents.length - index - 1].toLocaleLowerCase()) && (!child || matchesExistingTag(tag.name, child))
      : matchesExistingTag(tag.name, query) || ancestors.some(parent => matchesExistingTag(parent, query));
    return matches && !draft.has(tag.name.toLocaleLowerCase());
  });
  state.tagSuggestionIndex = -1;
  const message = state.tagSuggestionLoading ? "正在读取已有标签…" : state.tagSuggestionError ? "已有标签暂时无法读取，仍可手动添加新标签。" : parents.length ? (child ? "没有匹配的子标签，可直接添加；新层级将在保存标签后生效。" : "没有可添加的子标签，请在斜杠后输入新子标签名称。") : "没有匹配的已有标签，可直接添加新标签。";
  list.innerHTML = state.tagSuggestionRows.map((tag,index) => {
    const parents = tagAncestors(tag.name).reverse();
    return `<li role="presentation"><button type="button" id="tag-existing-option-${index}" role="option" aria-selected="false" data-existing-tag-index="${index}"><span>${parents.length ? `<span class="tag-suggestion-path">${escapeHTML(parents.join(" / "))} / </span>` : ""}<span>${escapeHTML(tag.name)}</span></span><small>${numberValue(tag.count)} 只股票</small></button></li>`;
  }).join("") || `<li class="tag-suggestion-message" role="presentation">${message}</li>`;
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.removeAttribute("aria-activedescendant");
  positionTagSuggestions();
}

async function loadTagSuggestionCatalog() {
  const generation = state.tagSuggestionGeneration = (state.tagSuggestionGeneration || 0) + 1;
  const code = state.tagEditingCode;
  state.tagSuggestionCatalog = null;
  state.tagSuggestionLoading = true;
  state.tagSuggestionError = false;
  try {
    const data = await request("/api/tags", "tag-editor-catalog");
    if (!data || generation !== state.tagSuggestionGeneration || !$("tag-dialog").open || state.tagEditingCode !== code) return;
    if (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag.name !== "string")) throw new Error("标签列表格式无效");
    state.tagSuggestionCatalog = data;
    applyTagOrder(data);
    updateTagEditorPaths();
  } catch {
    if (generation === state.tagSuggestionGeneration) state.tagSuggestionError = true;
  } finally {
    if (generation === state.tagSuggestionGeneration) { state.tagSuggestionLoading = false; renderTagSuggestions(); }
  }
}

function chooseExistingTag(index) {
  if (!state.tagEditorData || state.tagSaving || state.tagBlacklistSaving) return;
  const tag = state.tagSuggestionRows?.[index];
  if (!tag) return;
  $("tag-new").value = tag.name;
  addTagDraft();
}

function onTagSuggestionInput() {
  $("tag-new").setCustomValidity("");
  state.tagSuggestionsActive = true;
  renderTagSuggestions();
}

function onTagSuggestionKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape" && !$("tag-new-suggestions").hidden) { event.preventDefault(); event.stopPropagation(); hideTagSuggestions(); return; }
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    if ($("tag-new-suggestions").hidden) { state.tagSuggestionsActive = true; renderTagSuggestions(); }
    const rows = state.tagSuggestionRows || [];
    if (!rows.length) return;
    const previous = state.tagSuggestionIndex ?? -1;
    state.tagSuggestionIndex = previous < 0 ? event.key === "ArrowDown" ? 0 : rows.length - 1 : (previous + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    $("tag-new-suggestions").querySelectorAll("[data-existing-tag-index]").forEach((button,index) => button.setAttribute("aria-selected", String(index === state.tagSuggestionIndex)));
    $("tag-new").setAttribute("aria-activedescendant", `tag-existing-option-${state.tagSuggestionIndex}`);
    $("tag-new-suggestions").querySelector(`[data-existing-tag-index="${state.tagSuggestionIndex}"]`)?.scrollIntoView({block:"nearest"});
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (!$("tag-new-suggestions").hidden && state.tagSuggestionIndex >= 0) chooseExistingTag(state.tagSuggestionIndex);
    else addTagDraft();
  }
}

function updateTagEditorControls() {
  const busy = Boolean(state.tagSaving || state.tagBlacklistSaving);
  $("save-tags").textContent = state.tagSaving ? "正在保存…" : "保存标签";
  $("tag-dialog").setAttribute("aria-busy", String(busy));
  $("save-tags").disabled = !state.tagEditorData || busy;
  $("close-tags").disabled = busy;
  $("cancel-tags").disabled = busy;
  $("tag-blacklist-control").hidden = !canEditBlacklist();
  $("tag-blacklist").disabled = !canEditBlacklist() || !state.tagEditorData || busy;
  $("tag-new").disabled = !state.tagEditorData || busy;
  $("add-tag").disabled = !state.tagEditorData || busy;
  if (busy || !state.tagEditorData) hideTagSuggestions();
}

function syncTagBlacklistMembership(code, blacklisted, data) {
  state.blacklistData = data;
  for (const row of [...(state.dateData?.rows || []), ...(state.dateData?.suspended_rows || [])]) {
    if (row.code === code) row.blacklisted = blacklisted;
  }
  for (const stock of [state.stockData?.stock, state.selectedStock]) {
    if (stock?.code === code) stock.blacklisted = blacklisted;
  }
  if (state.tab === "date" && state.dateData) {
    const scrollLeft = $("date-table-area").querySelector(".industry-board")?.scrollLeft || 0;
    renderDate(state.dateData);
    const board = $("date-table-area").querySelector(".industry-board");
    if (board) { board.scrollLeft = scrollLeft; updateIndustryNavigation(); }
  } else if (state.tab === "stock" && state.selectedStock?.code === code) {
    $("stock-blacklist-label").hidden = !blacklisted;
  }
}

async function changeTagBlacklist() {
  const editor = state.tagEditorData;
  if (!editor || !canEditBlacklist() || state.tagSaving || state.tagBlacklistSaving) return;
  const previous = editor.blacklisted === true;
  const blacklisted = $("tag-blacklist").checked;
  if (blacklisted === previous) return;
  state.tagBlacklistSaving = true;
  $("tag-blacklist-error").hidden = true;
  $("tag-blacklist-status").textContent = "正在保存…";
  updateTagEditorControls();
  try {
    const data = await request("/api/blacklist", "tag-blacklist-save", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code: editor.code, action: blacklisted ? "add" : "remove"})});
    if (!data) throw new Error("未能确认黑名单状态，请重新打开弹窗核实后重试。");
    editor.blacklisted = blacklisted;
    syncTagBlacklistMembership(editor.code, blacklisted, data);
    $("tag-blacklist-status").textContent = blacklisted ? "已加入黑名单" : "已移出黑名单";
  } catch (error) {
    $("tag-blacklist").checked = previous;
    $("tag-blacklist-status").textContent = "";
    $("tag-blacklist-error").textContent = error.message;
    $("tag-blacklist-error").hidden = false;
  } finally {
    state.tagBlacklistSaving = false;
    updateTagEditorControls();
  }
}

async function openTagEditor(code) {
  if (!canEditTags() || state.tagSaving || state.tagBlacklistSaving) return;
  state.tagEditingCode = code;
  state.tagEditorData = null;
  state.tagDraft = [];
  state.tagUseSource = false;
  $("tag-stock-label").textContent = code;
  $("tag-editor-list").innerHTML = '<p class="tag-empty-hint">正在读取标签…</p>';
  $("tag-editor-error").hidden = true;
  $("tag-blacklist").checked = false;
  $("tag-blacklist-status").textContent = "";
  $("tag-blacklist-error").hidden = true;
  $("tag-new").value = "";
  hideTagSuggestions();
  updateTagEditorControls();
  if (!$("tag-dialog").open) $("tag-dialog").showModal();
  loadTagSuggestionCatalog();
  try {
    const data = await request(`/api/stock-tags?${new URLSearchParams({ code })}`, "tags");
    if (!data || !$("tag-dialog").open || state.tagEditingCode !== code) return;
    state.tagEditorData = data;
    state.tagDraft = [...data.tags];
    $("tag-blacklist").checked = data.blacklisted === true;
    $("tag-stock-label").textContent = `${data.name} · ${data.code}`;
    renderTagEditor();
    updateTagEditorControls();
  } catch (error) {
    if ($("tag-dialog").open && state.tagEditingCode === code) { $("tag-editor-error").textContent = error.message; $("tag-editor-error").hidden = false; }
  }
}

function addTagDraft() {
  if (!state.tagEditorData || state.tagSaving || state.tagBlacklistSaving) return false;
  const input = $("tag-new"), entered = input.value.trim();
  const parts = entered.split("/").map(part => part.trim());
  const value = parts.map(part => state.tagSuggestionCatalog?.tags.find(tag => tag.name.toLocaleLowerCase() === part.toLocaleLowerCase())?.name || part).join("/");
  input.setCustomValidity("");
  if (!value) return false;
  const limit = Math.max(20, state.tagEditorData?.tags?.length || 0, defaultEditorTags(state.tagEditorData).length + (state.tagEditorData?.merge_defaults ? 20 : 0));
  if (parts.some(part => !part || part.length > 30)) input.setCustomValidity("斜杠前后需填写标签名称，每级 1 至 30 个字符。");
  else if (state.tagDraft.length >= limit) input.setCustomValidity(`每只股票最多保留 ${limit} 个标签。`);
  else if (state.tagDraft.some(tag => tag.split("/").at(-1).trim().toLocaleLowerCase() === parts.at(-1).toLocaleLowerCase())) input.setCustomValidity("这个标签已存在。");
  if (!input.reportValidity()) return false;
  state.tagDraft.push(value);
  state.tagUseSource = false;
  input.value = "";
  renderTagEditor();
  input.focus();
  return true;
}

function closeTagEditor() {
  if (state.tagSaving || state.tagBlacklistSaving) return;
  state.requests.tags?.abort();
  state.requests["tag-editor-catalog"]?.abort();
  hideTagSuggestions();
  $("tag-dialog").close();
}

async function saveTagEditor(event) {
  event.preventDefault();
  if (!state.tagEditorData || state.tagSaving || state.tagBlacklistSaving) return;
  if ($("tag-new").value.trim() && !addTagDraft()) return;
  if (!$("tag-editor-form").reportValidity()) return;
  const position = {left: window.scrollX, top: window.scrollY, behavior: "instant"};
  const scrollLeft = $("date-table-area").querySelector(".industry-board")?.scrollLeft;
  state.tagSaving = true;
  $("tag-editor-form").querySelectorAll("button, input").forEach(element => { element.disabled = true; });
  updateTagEditorControls();
  try {
    const data = await request("/api/stock-tags", "tags-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: state.tagEditorData.code, tags: state.tagDraft, revision: state.tagEditorData.revision, use_source: state.tagUseSource, tag_alias_revision: state.tagEditorData.tag_alias_revision }) });
    if (!data) return;
    await refreshTagOrder();
    if (state.tab === "stock") await loadStock({remember:false, quiet:true}); else await loadDate({quiet:true});
    $("tag-dialog").close();
    const board = $("date-table-area").querySelector(".industry-board");
    if (board && scrollLeft != null) { board.scrollLeft = scrollLeft; updateIndustryNavigation(); }
    window.scrollTo(position);
  } catch (error) { $("tag-editor-error").textContent = error.message; $("tag-editor-error").hidden = false; }
  finally {
    state.tagSaving = false;
    $("tag-editor-form").querySelectorAll("button, input").forEach(element => { element.disabled = false; });
    updateTagEditorControls();
  }
}

function noteLocalDate(value) {
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stockNoteFields(id = null) {
  if (id === null) return {content: $("stock-note-content"), time: $("stock-note-time"), dateButton: $("add-stock-note-date"), dateTag: $("stock-note-date-tag"), removeDate: $("remove-stock-note-date")};
  const row = $("stock-note-history").querySelector(`[data-note-id="${id}"]`);
  return row ? {content: row.querySelector("[data-note-content]"), time: row.querySelector("[data-note-time]"), dateButton: row.querySelector("[data-note-add-date]"), dateTag: row.querySelector("[data-note-date-tag]"), removeDate: row.querySelector("[data-note-remove-date]")} : null;
}

function expandStockNoteDate(id = null) {
  if (!canEditNotes() || !state.noteEditorData || (state.noteSaving && !state.noteAutoSaving) || state.noteClosing) return;
  const fields = stockNoteFields(id);
  if (!fields) return;
  if (!fields.time.value) fields.time.value = noteLocalDate();
  updateStockNoteControls();
  fields.time.focus();
  if (id !== null) scheduleStockNoteAutosave();
}

function removeStockNoteDate(id = null) {
  if (!canEditNotes() || !state.noteEditorData || (state.noteSaving && !state.noteAutoSaving) || state.noteClosing) return;
  const fields = stockNoteFields(id);
  if (!fields) return;
  fields.time.value = "";
  updateStockNoteControls();
  fields.content.focus();
  if (id !== null) scheduleStockNoteAutosave();
}

function captureStockNoteDrafts() {
  const drafts = new Map();
  $("stock-note-history").querySelectorAll("[data-note-id]").forEach(row => {
    const id = Number(row.dataset.noteId), entry = state.noteEditorData?.entries?.find(item => item.id === id);
    const content = row.querySelector("[data-note-content]").value, time = row.querySelector("[data-note-time]").value;
    if (entry && (content !== entry.content || time !== (entry.note_date ?? noteLocalDate(entry.occurred_at)))) drafts.set(id, {content, time});
  });
  state.noteDrafts = drafts;
}

function resizeStockNoteContents() {
  if (!$("stock-note-dialog").open) return;
  const fields = [$("stock-note-content"), ...$("stock-note-history").querySelectorAll("[data-note-content]")];
  fields.forEach(input => {
    input.style.height = "36px";
    input.style.height = `${Math.max(36, (input.scrollHeight || 0) + 2)}px`;
  });
}

function renderStockNoteHistory() {
  const entries = state.noteEditorData?.entries || [];
  $("stock-note-history").innerHTML = entries.length ? entries.map((entry, index) => {
    const draft = state.noteDrafts?.get(entry.id) || {content: entry.content, time: entry.note_date ?? noteLocalDate(entry.occurred_at)};
    return `<div class="stock-note-node" data-note-id="${entry.id}"><div class="stock-note-node-body"><div class="stock-note-input"><button type="button" class="icon-button stock-note-date-button" data-note-add-date="${entry.id}" aria-label="为第 ${index + 1} 条备注设置日期" title="设置日期" aria-controls="stock-note-date-tag-${entry.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 11h16m-8 3v4m-2-2h4"/></svg></button><span class="stock-note-date-tag" id="stock-note-date-tag-${entry.id}" data-note-date-tag hidden><input id="stock-note-date-${entry.id}" type="date" data-note-time value="${escapeHTML(draft.time)}" aria-label="第 ${index + 1} 条备注日期（可选）"><button type="button" class="stock-note-date-remove" data-note-remove-date="${entry.id}" aria-label="移除第 ${index + 1} 条备注日期" title="移除日期"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></span><textarea data-note-content maxlength="5000" rows="1" aria-label="第 ${index + 1} 条备注内容" placeholder="空备注">${escapeHTML(draft.content)}</textarea></div><div class="stock-note-node-actions"><button type="button" class="button secondary small stock-note-delete" data-delete-note="${entry.id}" aria-label="删除第 ${index + 1} 条备注">删除</button></div></div></div>`;
  }).join("") : "";
  entries.forEach(entry => { stockNoteFields(entry.id).content.value = state.noteDrafts?.get(entry.id)?.content ?? entry.content; });
}

function updateStockNoteControls() {
  const busy = Boolean(state.noteSaving), lockInputs = Boolean((busy && !state.noteAutoSaving) || state.noteClosing), ready = Boolean(state.noteEditorData), editable = canEditNotes();
  captureStockNoteDrafts();
  $("stock-note-form").hidden = !editable;
  $("stock-note-content").disabled = lockInputs || !ready;
  $("stock-note-content").readOnly = !editable;
  $("stock-note-time").disabled = lockInputs || !ready;
  $("stock-note-time").readOnly = !editable;
  for (const id of [null, ...(state.noteEditorData?.entries || []).map(entry => entry.id)]) {
    const fields = stockNoteFields(id);
    const dated = Boolean(fields.time.value);
    fields.dateTag.hidden = !dated;
    fields.dateButton.hidden = !editable || dated;
    fields.dateButton.disabled = lockInputs || !ready;
    fields.dateButton.setAttribute("aria-expanded", String(dated));
    fields.removeDate.hidden = !editable;
    fields.removeDate.disabled = lockInputs || !ready;
  }
  $("save-stock-note").disabled = busy || state.noteClosing || !ready || !editable || !$("stock-note-content").value.trim();
  $("save-stock-note").hidden = !editable;
  $("stock-note-history").querySelectorAll("[data-note-id]").forEach(row => {
    row.querySelectorAll("input,textarea").forEach(input => { input.disabled = lockInputs || !ready; input.readOnly = !editable; });
    const remove = row.querySelector("[data-delete-note]");
    remove.hidden = !editable;
    remove.disabled = busy || state.noteClosing || !ready || !editable;
  });
  $("undo-stock-note").hidden = !editable || !state.noteUndoId;
  $("undo-stock-note").disabled = busy || state.noteClosing || !ready;
  ["close-stock-note", "cancel-stock-note"].forEach(id => { $(id).disabled = Boolean(state.noteClosing); });
  $("retry-stock-note").disabled = busy || state.noteClosing;
  $("cancel-stock-note").textContent = editable ? (state.noteClosing ? "保存中…" : "保存") : "关闭";
  $("stock-note-count").textContent = `${$("stock-note-content").value.length} / 5000`;
  resizeStockNoteContents();
}

function hideShareholderTooltip() {
  clearTimeout(state.shareholderTimer);
  if ($("shareholder-info-dialog").open) $("shareholder-info-dialog").close();
  state.shareholderGeneration = (state.shareholderGeneration || 0) + 1;
  state.requests?.shareholders?.abort();
  state.shareholderAnchor?.removeAttribute("aria-controls");
  state.shareholderAnchor?.setAttribute("aria-expanded", "false");
  state.shareholderAnchor = null;
  state.shareholderPinned = false;
  state.shareholderData = null;
  $("shareholder-tooltip").hidden = true;
}

function scheduleShareholderHide() {
  clearTimeout(state.shareholderTimer);
  if (!state.shareholderPinned) state.shareholderTimer = setTimeout(hideShareholderTooltip, 200);
}

function shareholderTypeBlocked(type) {
  if (!state.shareholderBlockedTypes) {
    let entries = [];
    try {
      const saved = JSON.parse(localStorage.getItem("limit-up-archive.shareholder-blocked-types.v1") || "[]");
      if (Array.isArray(saved)) entries = saved.filter(item => Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "boolean");
    } catch {}
    state.shareholderBlockedTypes = new Map(entries);
  }
  return state.shareholderBlockedTypes.get(type) ?? ["基金", "其他", "QFII"].includes(type);
}

function filteredShareholderRows(data) {
  return data.rows.map(peer => {
    const holders = peer.holders.filter(holder => !shareholderTypeBlocked(holder.type));
    return {...peer, holders, shared_count: holders.length};
  }).filter(peer => peer.shared_count > 0)
    .sort((a, b) => Number(b.today_together) - Number(a.today_together) || b.shared_count - a.shared_count || a.code.localeCompare(b.code));
}

function renderShareholderTooltip(data, limit = 50) {
  const scopes = {total: "十大股东", float: "十大流通"};
  const profiles = data.profiles.filter(p => p.report_date);
  const rows = filteredShareholderRows(data);
  const types = [...new Set(data.rows.flatMap(peer => peer.holders.map(holder => holder.type)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const today = data.today_status === "unavailable" ? "今天的涨停数据尚未取得，暂不标记同涨停"
    : `${escapeHTML(data.today)} · ${data.today_status === "provisional" ? "盘中暂定" : "收盘确认"}${data.today_stale ? " · 涨停快照延迟" : ""}${data.today_fetched_at ? ` · ${escapeHTML(data.today_fetched_at.slice(11, 16))} 获取` : ""}`;
  const message = !profiles.length ? (data.status === "error" ? "股东资料暂未获取成功，稍后自动重试" : data.profiles.length === 2 ? "来源暂无可用股东资料" : "股东资料正在获取，请稍后再查看")
    : !data.rows.length ? "在已取得资料的股票中，暂未发现共同股东" : !rows.length ? "当前分类下的共同股东已全部屏蔽，可取消勾选后查看关联股票" : "";
  return `<div class="shareholder-heading"><div class="shareholder-title"><strong>共同股东</strong><button type="button" class="shareholder-info-button" data-shareholder-info aria-label="共同股东说明" aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg></button></div><span class="shareholder-meta">${today}</span></div>
    <div class="shareholder-filter"><div class="shareholder-filter-heading"><span>屏蔽分类</span><span>${rows.length} 只关联股票</span></div><div class="shareholder-filter-options" role="group" aria-label="屏蔽股东分类">${types.map(type => `<label><input type="checkbox" data-shareholder-block-type="${escapeHTML(type)}"${shareholderTypeBlocked(type) ? " checked" : ""}><span>${escapeHTML(type)}</span></label>`).join("") || '<span class="shareholder-filter-empty">暂无可筛选分类</span>'}</div></div>
    ${rows.slice(0, limit).map(peer => `<div class="shareholder-peer${peer.today_together ? " together" : ""}"><div class="shareholder-peer-title"><button type="button" class="stock-name-button" data-shareholder-peer="${escapeHTML(peer.code)}" data-peer-name="${escapeHTML(peer.name)}">${escapeHTML(peer.name)}</button><span class="row-stock-code">${escapeHTML(peer.code)}</span>${peer.today_together ? '<span class="shareholder-together">今日同涨停</span>' : ""}<span class="shareholder-count">${peer.shared_count} 位共同股东</span></div><ul>${peer.holders.map(holder => `<li><span>${escapeHTML(holder.name)}</span><small>${escapeHTML(holder.type)} · ${holder.reports.map(r => `${scopes[r.scope]} ${escapeHTML(r.date)}`).join(" / ")}</small></li>`).join("")}</ul></div>`).join("")}
    ${rows.length > limit ? `<button type="button" class="shareholder-more" data-shareholder-more>继续显示 · 已展示 ${limit} / ${rows.length} 只</button>` : ""}
    ${message ? `<p class="shareholder-message">${message}</p>` : ""}`;
}

function openShareholderInfo() {
  const data = state.shareholderData;
  if (!data) return;
  clearTimeout(state.shareholderTimer);
  state.shareholderPinned = true;
  const profiles = data.profiles.filter(p => p.report_date);
  $("shareholder-info-content").innerHTML = `<p>${escapeHTML(data.source)} · 已取得 ${data.coverage} / ${data.requested} 只股票${data.status === "updating" ? " · 正在更新" : data.status === "error" ? " · 更新失败，保留已有缓存" : ""}</p>${profiles.length ? `<p>本股资料获取于 ${escapeHTML(profiles.map(p => p.fetched_at).sort()[0].slice(0, 16).replace("T", " "))}</p>` : ""}<p>${escapeHTML(data.scope_note)}</p>`;
  $("shareholder-info-dialog").showModal();
}

function positionShareholderTooltip(button) {
  const tooltip = $("shareholder-tooltip"), anchor = button.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 20, above = anchor.top - 20;
  tooltip.style.maxHeight = `${Math.min(460, Math.max(80, above, below))}px`;
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
  const top = below >= bounds.height ? anchor.bottom + 6 : anchor.top - bounds.height - 6;
  tooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
}

async function showShareholderTooltip(button, pin = false) {
  clearTimeout(state.shareholderTimer);
  const code = button.dataset.shareholderCode;
  if (!/^[0-9]{6}$/.test(code || "") || (state.shareholderPinned && !pin)) return;
  if (state.shareholderAnchor === button) {
    if (pin) state.shareholderPinned = true;
    return;
  }
  hideShareholderTooltip();
  const generation = state.shareholderGeneration, tooltip = $("shareholder-tooltip");
  state.shareholderAnchor = button;
  state.shareholderPinned = pin;
  button.setAttribute("aria-controls", "shareholder-tooltip");
  button.setAttribute("aria-expanded", "true");
  tooltip.innerHTML = '<p class="shareholder-message">正在读取股东关联…</p>';
  tooltip.scrollTop = 0;
  tooltip.hidden = false;
  positionShareholderTooltip(button);
  try {
    const data = await request(`/api/stock-shareholders?${new URLSearchParams({code})}`, "shareholders");
    if (!data || generation !== state.shareholderGeneration || state.shareholderAnchor !== button || !button.isConnected) return;
    state.shareholderData = data;
    state.shareholderLimit = 50;
    tooltip.innerHTML = renderShareholderTooltip(data);
    positionShareholderTooltip(button);
  } catch {
    if (generation !== state.shareholderGeneration || state.shareholderAnchor !== button || !button.isConnected) return;
    tooltip.innerHTML = '<p class="shareholder-message">股东关联暂时无法读取，请移开后重新查看。</p>';
    positionShareholderTooltip(button);
  }
}

function toggleShareholderTooltip(button) {
  if (state.shareholderAnchor === button && state.shareholderPinned) {
    hideShareholderTooltip();
    return;
  }
  return showShareholderTooltip(button, true);
}

function hideStockNoteTooltip() {
  clearTimeout(state.noteTooltipTimer);
  state.noteTooltipGeneration = (state.noteTooltipGeneration || 0) + 1;
  state.requests?.["stock-note-tooltip"]?.abort();
  state.noteTooltipAnchor?.removeAttribute("aria-describedby");
  state.noteTooltipAnchor = null;
  $("stock-note-tooltip").hidden = true;
}

function scheduleStockNoteTooltipHide() {
  clearTimeout(state.noteTooltipTimer);
  state.noteTooltipTimer = setTimeout(hideStockNoteTooltip, 150);
}

function renderStockNoteTooltip(entries) {
  return '<div role="list">' + entries.map(entry => {
    const day = entry.note_date ?? String(entry.occurred_at || "").slice(0, 10);
    return `<div class="stock-note-tooltip-entry" role="listitem">${day ? `<time datetime="${escapeHTML(day)}">${escapeHTML(day)}</time>` : ""}<div class="stock-note-tooltip-content">${escapeHTML(entry.content || "（空备注）")}</div></div>`;
  }).join("") + '</div>';
}

function positionStockNoteTooltip(button) {
  const tooltip = $("stock-note-tooltip");
  const anchor = button.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 20, above = anchor.top - 20;
  tooltip.style.maxHeight = `${Math.min(360, Math.max(80, above, below))}px`;
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
  const top = below >= bounds.height ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
  tooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
}

async function showStockNoteTooltip(button) {
  clearTimeout(state.noteTooltipTimer);
  const code = button.dataset?.editStockNote;
  if (!/^[0-9]{6}$/.test(code || "") || state.noteTooltipAnchor === button) return;
  hideStockNoteTooltip();
  const generation = state.noteTooltipGeneration;
  const tooltip = $("stock-note-tooltip");
  state.noteTooltipAnchor = button;
  button.setAttribute("aria-describedby", "stock-note-tooltip");
  tooltip.innerHTML = '<p class="stock-note-tooltip-message">正在读取全部备注…</p>';
  tooltip.scrollTop = 0;
  tooltip.hidden = !button.classList.contains("has-note");
  if (!tooltip.hidden) positionStockNoteTooltip(button);
  try {
    const data = await request(`/api/stock-note?${new URLSearchParams({code})}`, "stock-note-tooltip");
    if (!data || state.noteTooltipGeneration !== generation || state.noteTooltipAnchor !== button || button.isConnected === false) return;
    if (!data.entries?.length) { hideStockNoteTooltip(); return; }
    tooltip.innerHTML = renderStockNoteTooltip(data.entries);
    tooltip.hidden = false;
    positionStockNoteTooltip(button);
  } catch {
    if (state.noteTooltipGeneration !== generation || state.noteTooltipAnchor !== button || button.isConnected === false) return;
    tooltip.innerHTML = '<p class="stock-note-tooltip-message">历史备注暂时无法读取，请点击备注后重试。</p>';
    tooltip.hidden = false;
    positionStockNoteTooltip(button);
  }
}

async function openStockNoteEditor(code) {
  if (state.noteSaving || state.noteClosing || (state.noteEditorData && $("stock-note-dialog").open)) return;
  clearTimeout(state.noteAutosaveTimer);
  hideStockNoteTooltip();
  const generation = (state.noteGeneration || 0) + 1;
  state.noteGeneration = generation;
  state.noteEditingCode = code;
  state.noteEditorData = null;
  state.noteDrafts = new Map();
  state.noteUndoId = null;
  state.noteComposing = false;
  $("stock-note-title").textContent = canEditNotes() ? "编辑股票备注" : "查看股票备注";
  $("stock-note-label").textContent = code;
  $("stock-note-content").value = "";
  $("stock-note-time").value = "";
  $("stock-note-history").innerHTML = "";
  $("stock-note-feedback").textContent = "正在读取备注…";
  $("stock-note-error").hidden = true;
  $("retry-stock-note").hidden = true;
  updateStockNoteControls();
  if (!$("stock-note-dialog").open) $("stock-note-dialog").showModal();
  try {
    const data = await request(`/api/stock-note?${new URLSearchParams({code})}`, "stock-note");
    if (!data || state.noteGeneration !== generation || !$("stock-note-dialog").open) return;
    state.noteEditorData = data;
    $("stock-note-label").textContent = `${data.name} · ${data.code}`;
    renderStockNoteHistory();
    $("stock-note-feedback").textContent = canEditNotes() ? "" : "当前为只读模式。";
    updateStockNoteControls();
    if (canEditNotes()) $("stock-note-content").focus();
  } catch (error) {
    if (state.noteGeneration !== generation || !$("stock-note-dialog").open) return;
    $("stock-note-feedback").textContent = "";
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    $("retry-stock-note").hidden = false;
  }
}

function closeStockNoteEditor() {
  if (state.noteSaving) return;
  clearTimeout(state.noteAutosaveTimer);
  state.noteGeneration = (state.noteGeneration || 0) + 1;
  state.requests["stock-note"]?.abort();
  state.noteEditorData = null;
  state.noteDrafts = new Map();
  state.noteUndoId = null;
  $("stock-note-dialog").close();
}

function applyStockNoteEditorUpdate(data, entryId, keepInputs = false) {
  const scrollTop = $("stock-note-history").scrollTop;
  for (const row of [...(state.dateData?.rows || []), ...(state.dateData?.suspended_rows || []), ...(state.intradayData?.rows || []), state.minuteDetail?.stock, state.stockData?.stock, state.selectedStock]) {
    if (row?.code === data.code) row.note = data.content;
  }
  document.querySelectorAll(`[data-note-code="${data.code}"]`).forEach(element => {
    element.innerHTML = renderStockNote({code: data.code, name: data.name, note: data.content});
  });
  state.noteEditorData = data;
  if (keepInputs) captureStockNoteDrafts();
  else { state.noteDrafts.delete(entryId); renderStockNoteHistory(); }
  $("stock-note-history").scrollTop = entryId === null ? 0 : scrollTop;
}

function scheduleStockNoteAutosave(event) {
  clearTimeout(state.noteAutosaveTimer);
  updateStockNoteControls();
  if (!canEditNotes() || !state.noteEditorData || !$("stock-note-dialog").open || state.noteClosing || state.noteComposing || event?.isComposing || !state.noteDrafts.size) return;
  $("stock-note-feedback").textContent = "有修改待保存…";
  state.noteAutosaveTimer = setTimeout(flushStockNoteDrafts, 500);
}

function flushStockNoteDrafts() {
  clearTimeout(state.noteAutosaveTimer);
  if (state.noteFlushPromise) return state.noteFlushPromise;
  const generation = state.noteGeneration;
  const run = async () => {
    if (state.noteSaving && !(await state.noteWritePromise)) return false;
    if (!canEditNotes() || !state.noteEditorData || !$("stock-note-dialog").open || state.noteComposing || generation !== state.noteGeneration) return false;
    captureStockNoteDrafts();
    while (state.noteDrafts.size) {
      const id = state.noteDrafts.keys().next().value;
      if (!(await saveStockNoteEditor({preventDefault() {}}, id, true))) return false;
      if (generation !== state.noteGeneration || !$("stock-note-dialog").open || state.noteComposing) return false;
      captureStockNoteDrafts();
    }
    return true;
  };
  const promise = run();
  state.noteFlushPromise = promise;
  promise.finally(() => { if (state.noteFlushPromise === promise) state.noteFlushPromise = null; });
  return promise;
}

async function finishStockNoteEditor() {
  if (state.noteClosing) return;
  if (!canEditNotes() || !state.noteEditorData) { closeStockNoteEditor(); return; }
  captureStockNoteDrafts();
  for (const id of [...state.noteDrafts.keys(), ...($("stock-note-content").value.trim() ? [null] : [])]) {
    const fields = stockNoteFields(id);
    if (!fields.time.reportValidity() || !fields.content.reportValidity()) return;
  }
  state.noteClosing = true;
  updateStockNoteControls();
  try {
    if (!(await flushStockNoteDrafts())) return;
    if ($("stock-note-content").value.trim() && !(await saveStockNoteEditor({preventDefault() {}}, null))) return;
    closeStockNoteEditor();
  } finally {
    state.noteClosing = false;
    if ($("stock-note-dialog").open) updateStockNoteControls();
  }
}

function saveStockNoteEditor(event, entryId = null, autosave = false) {
  if (state.noteSaving) { event.preventDefault(); return Promise.resolve(false); }
  clearTimeout(state.noteAutosaveTimer);
  return state.noteWritePromise = persistStockNoteEditor(event, entryId, autosave);
}

async function persistStockNoteEditor(event, entryId, autosave) {
  event.preventDefault();
  if (!canEditNotes() || !state.noteEditorData || !$("stock-note-dialog").open) return false;
  const fields = stockNoteFields(entryId);
  if (!fields || !fields.time.reportValidity() || !fields.content.reportValidity()) return false;
  if (entryId === null && !fields.content.value.trim()) return false;
  captureStockNoteDrafts();
  if (entryId !== null && !state.noteDrafts.has(entryId)) return true;
  const content = fields.content.value, note_date = fields.time.value;
  state.noteSaving = true;
  state.noteAutoSaving = autosave;
  $("stock-note-error").hidden = true;
  $("stock-note-feedback").textContent = "正在保存…";
  updateStockNoteControls();
  try {
    const data = await request("/api/stock-note", "stock-note-save", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code: state.noteEditorData.code, content, revision: state.noteEditorData.revision,
        entry_id: entryId, note_date, new_entry: entryId === null})});
    if (!data) throw new Error("备注未确认保存，请重试。");
    applyStockNoteEditorUpdate(data, entryId, entryId !== null);
    if (entryId === null) {
      $("stock-note-content").value = "";
      $("stock-note-time").value = "";
    }
    $("stock-note-feedback").textContent = entryId === null ? "已添加备注，可继续输入。" : "该条备注已保存。";
    return true;
  } catch (error) {
    $("stock-note-feedback").textContent = "未能保存，输入内容已保留。可点击底部保存重试。";
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    return false;
  } finally {
    state.noteSaving = false;
    state.noteAutoSaving = false;
    updateStockNoteControls();
    if (!autosave && !state.noteClosing && $("stock-note-error").hidden) stockNoteFields(entryId)?.content.focus();
    if (!autosave && $("stock-note-error").hidden && state.noteDrafts.size) scheduleStockNoteAutosave();
  }
}

function changeStockNoteEntryEditor(event, entryId, action) {
  if (state.noteSaving || state.noteClosing) { event.preventDefault(); return Promise.resolve(false); }
  clearTimeout(state.noteAutosaveTimer);
  return state.noteWritePromise = persistStockNoteEntryChange(event, entryId, action);
}

async function persistStockNoteEntryChange(event, entryId, action) {
  event.preventDefault();
  if (!canEditNotes() || !state.noteEditorData || state.noteSaving) return;
  captureStockNoteDrafts();
  state.noteSaving = true;
  $("stock-note-error").hidden = true;
  updateStockNoteControls();
  try {
    const data = await request("/api/stock-note", "stock-note-save", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({code:state.noteEditorData.code,revision:state.noteEditorData.revision,entry_id:entryId,action})});
    if (!data) throw new Error("备注操作未确认完成，请重试。");
    applyStockNoteEditorUpdate(data, entryId);
    state.noteUndoId = action === "delete" ? entryId : null;
    $("stock-note-feedback").textContent = action === "delete" ? "已删除该条备注，可撤销删除。" : "已恢复该条备注。";
    return true;
  } catch (error) {
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    return false;
  } finally {
    state.noteSaving = false;
    updateStockNoteControls();
    if ($("stock-note-error").hidden && state.noteDrafts.size) scheduleStockNoteAutosave();
  }
}

function stockNoteKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229 || !event.target.matches("textarea")) return;
  const row = event.target.closest("[data-note-id]");
  return saveStockNoteEditor(event, row ? Number(row.dataset.noteId) : null);
}

function renderTable(rows, mode) {
  const dateMode = mode === "date";
  const heads = dateMode ? ["股票", "连板", "行业"] : ["交易日期", "当日高度"];
  const rowHTML = rows.map((row) => {
    const boards = Number(row.boards) || 0;
    const badge = `<span class="board-badge ${boards >= 5 ? "high" : boards <= 1 ? "first" : ""}">${boards ? `${boards} 板` : "—"}</span>`;
    return dateMode
      ? `<tr><td><button class="stock-name-button" data-stock-code="${escapeHTML(row.code)}" data-stock-name="${escapeHTML(row.name)}">${escapeHTML(textValue(row.name))}</button><div class="row-stock-code">${escapeHTML(textValue(row.code))}</div></td><td>${badge}</td><td><span class="industry-text">${escapeHTML(textValue(row.industry))}</span></td></tr>`
      : `<tr><td><button class="stock-name-button" data-history-date="${escapeHTML(row.date)}">${escapeHTML(dateLabel(row.date))}</button></td><td>${badge}</td></tr>`;
  }).join("");
  return `<table class="${dateMode ? "date-table" : "stock-table"}"><caption class="sr-only">${dateMode ? "当日涨停股票明细" : "个股逐日涨停记录"}</caption><thead><tr>${heads.map((head) => `<th scope="col">${head}</th>`).join("")}</tr></thead><tbody>${rowHTML}</tbody></table>`;
}

function hideSuggestions() { $("stock-suggestions").hidden = true; $("stock-search").setAttribute("aria-expanded", "false"); $("stock-search").removeAttribute("aria-activedescendant"); state.suggestionIndex = -1; }
function showSuggestions(rows, query) {
  state.suggestions = rows;
  state.suggestionsQuery = query;
  state.suggestionIndex = -1;
  $("stock-suggestions").innerHTML = rows.length ? rows.slice(0, 15).map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" id="suggestion-${index}" data-suggestion="${index}"><span class="suggestion-code">${escapeHTML(stock.code)}</span><span>${escapeHTML(stock.name)}</span></button>${renderShareholderIcon(stock)}<span class="suggestion-market">${escapeHTML(marketValue(stock.market))}</span></li>`).join("") : '<li role="presentation" class="suggestion-message">未找到已收录的股票，请尝试名称、代码或首字母。</li>';
  $("stock-suggestions").hidden = false;
  $("stock-search").setAttribute("aria-expanded", "true");
}
async function searchStocks() {
  const query = $("stock-search").value.trim();
  if (state.selectedStock) return;
  if (!query) { hideSuggestions(); return; }
  try {
    const data = await request(`/api/stocks?${new URLSearchParams({ q: query })}`, "search");
    if (!data || state.selectedStock || $("stock-search").value.trim() !== query) return;
    showSuggestions(data.rows || [], query);
  } catch (error) {
    $("stock-suggestions").innerHTML = '<li role="presentation" class="suggestion-message">暂时无法检索股票，仍可输入完整代码查询。</li>';
    $("stock-suggestions").hidden = false;
    $("stock-search").setAttribute("aria-expanded", "true");
  }
}
function chooseStock(stock, query = true) {
  state.selectedStock = { code: String(stock.code), name: stock.name || "", market: stock.market || "" };
  state.requests.search?.abort();
  state.requests["stock-resolve"]?.abort();
  $("stock-search").value = stock.name ? `${stock.name} ${stock.code}` : stock.code;
  hideSuggestions();
  setView("stock");
  if (query) loadStock();
}
async function loadStock({remember = true, quiet = false} = {}) {
  let stock = state.selectedStock;
  if (!stock) {
    const raw = $("stock-search").value.trim();
    if (/^\d{6}$/.test(raw)) stock = { code: raw, name: "" };
    else if (raw) {
      try {
        let rows = state.suggestionsQuery === raw ? state.suggestions : null;
        if (!rows) {
          const data = await request(`/api/stocks?${new URLSearchParams({ q: raw })}`, "stock-resolve");
          if (!data || $("stock-search").value.trim() !== raw) return;
          rows = data.rows || [];
        }
        const initials = raw.replace(/\s+/g, "").toUpperCase();
        const exact = rows.filter(item => item.name === raw || item.initials === initials);
        stock = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
        if (!stock) showSuggestions(rows, raw);
      } catch (error) { showError(error, loadStock); return; }
    }
  }
  if (!stock) { $("stock-search").setCustomValidity("请输入股票名称、代码或首字母；多个结果时请选择对应股票。"); $("stock-search").reportValidity(); return; }
  $("stock-search").setCustomValidity("");
  state.selectedStock = stock;
  const generation = (state.stockGeneration || 0) + 1;
  state.stockGeneration = generation;
  hideSuggestions();
  clearError();
  setView("stock", false);
  $("stock-results").hidden = false;
  $("stock-code-label").textContent = stock.code;
  if (!quiet) {
    $("stock-name-label").textContent = stock.name || "查询中";
    renderStockProfile(stock, true);
  }
  state.requests.relations?.abort();
  state.relationsRequest = (state.relationsRequest || 0) + 1;
  state.relationsLoading = false;
  state.requests.comparison?.abort();
  state.comparisonCache = new Map();
  state.comparisonLoading = "";
  if (!quiet) {
    $("stock-cycles").innerHTML = '<div class="empty-inline">正在整理连板周期…</div>';
    $("stock-chart").innerHTML = '<div class="empty-inline">正在读取高度轨迹…</div>';
  }
  state.relationships = null;
  state.relationPeers = [];
  if (state.stockData?.stock?.code !== stock.code) {
    state.relationPeerCode = "";
    state.relationQuery = "";
  }
  $("stock-relations").setAttribute("aria-busy", "true");
  if (!quiet) {
    $("relations-range").textContent = "正在整理同期竞争和同日涨停记录…";
    $("competition-results").innerHTML = loadingHTML();
    setStats("stock-stats");
  }
  
  $("stock-query-button").disabled = true;
  updateURL();
  try {
    const params = new URLSearchParams({ code: stock.code });
    const data = await request(`/api/stock?${params}`, "stock");
    if (!data || state.stockGeneration !== generation || state.tab !== "stock") return;
    state.stockData = data;
    renderStock(data);
    if (remember && data.rows?.length && data.stock?.name !== "尚未收录") rememberStock(data.stock);
  } catch (error) {
    if (state.stockGeneration !== generation || state.tab !== "stock") return;
    showError(error, loadStock);
    if (quiet) return;
    $("stock-cycles").innerHTML = "";
    $("stock-chart").innerHTML = '<div class="empty-inline">查询失败，暂无轨迹数据</div>';
    $("relations-range").textContent = "关联记录暂时无法读取";
    $("competition-results").innerHTML = emptyHTML("未能加载竞争记录", "请重新加载个股历史。");
    $("stock-name-label").textContent = stock.name || stock.code;
  } finally { if (state.stockGeneration === generation) { $("stock-relations").setAttribute("aria-busy", String(!!state.relationsLoading)); $("stock-query-button").disabled = false; } }
}

function renderStockProfile(stock, loading = false) {
  renderStockHeaderNote(stock, loading);
  $("stock-shareholder-icon").innerHTML = renderShareholderIcon(stock);
  $("stock-initials-label").textContent = loading ? "…" : nameInitials(stock) || "—";
  $("stock-blacklist-label").hidden = loading || stock.blacklisted !== true;
  $("stock-province-label").textContent = loading ? "…" : regionLabel(stock);
  const tags = stockTags(stock);
  $("stock-industry-tags").innerHTML = loading ? '<span class="stock-tag-empty">正在读取标签…</span>'
    : tags.map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>';
  $("edit-stock-profile-tags").hidden = !canEditTags();
  $("edit-stock-profile-tags").disabled = !canEditTags() || loading || stock.name === "尚未收录";
  $("edit-stock-profile-tags").setAttribute("aria-label", `编辑${stock.name || stock.code}行业标签`);
}

function renderStock(data) {
  const rows = data.rows || [];
  const stock = data.stock || state.selectedStock;
  state.selectedStock = stock;
  $("stock-code-label").textContent = textValue(stock.code);
  $("stock-name-label").textContent = textValue(stock.name);
  renderStockProfile(stock);
  $("stock-search").value = `${stock.name || ""} ${stock.code}`.trim();
  setStats("stock-stats", data.stats || {});
  if (state.relationExcludeLatest) loadRelationHistory();
  else renderRelationships(data.relationships);
  
  $("stock-chart").innerHTML = rows.length ? renderChart(rows) : '<div class="empty-inline">暂无已收录的涨停轨迹</div>';
  $("cycle-competition-scope").textContent = data.relationships?.competition?.scope_note || "";
  $("stock-cycles").innerHTML = renderStockCycles(data);
  updateURL();
}

function relationStockButton(row) {
  return `<button type="button" class="stock-name-button relation-stock-name" data-relation-code="${escapeHTML(row.code)}" data-relation-name="${escapeHTML(row.name)}" title="查看${escapeHTML(row.name)}的股票详情">${escapeHTML(row.name)}</button>`;
}

function relationDateButton(day, label = dateLabel(day)) {
  return `<button type="button" class="relation-date" data-relation-date="${escapeHTML(day)}">${escapeHTML(label)}</button>`;
}

function renderRelationships(data) {
  state.relationships = data || null;
  state.relationPeers = mergeRelationPeers(data, state.selectedStock?.code);
  $("relations-range").textContent = data ? `${state.relationExcludeLatest ? "历史数据" : "全部数据"} · ${data.range_end < data.range_start ? "暂无可用历史交易日" : `${dateLabel(data.range_start)} — ${dateLabel(data.range_end)}`} · 本票 ${numberValue(data.target_limit_days)} 个涨停日${state.relationExcludeLatest ? ` · 已剔除 ${dateLabel(state.meta?.latest_date)}` : ""}` : "暂无关联记录";
  renderCompetition();
  loadPeerComparison();
}

async function loadRelationHistory() {
  const code = state.selectedStock?.code;
  if (!code || state.tab !== "stock") return;
  const generation = (state.relationsRequest || 0) + 1;
  state.relationsRequest = generation;
  state.requests.relations?.abort();
  state.requests.comparison?.abort();
  state.comparisonCache = new Map();
  state.comparisonLoading = "";
  state.relationsLoading = false;
  clearError();
  if (!state.relationExcludeLatest) {
    renderRelationships(state.stockData?.relationships);
    $("stock-relations").setAttribute("aria-busy", "false");
    return;
  }
  state.relationships = null;
  state.relationPeers = [];
  state.relationsLoading = true;
  $("stock-relations").setAttribute("aria-busy", "true");
  $("relations-range").textContent = "正在剔除最新交易日并重新统计历史关联…";
  $("competition-results").innerHTML = loadingHTML();
  try {
    const data = await request(`/api/stock?${new URLSearchParams({code, exclude_latest: "1"})}`, "relations");
    if (!data || state.relationsRequest !== generation || state.selectedStock?.code !== code || state.tab !== "stock" || !state.relationExcludeLatest) return;
    renderRelationships(data.relationships);
  } catch (error) {
    if (state.relationsRequest !== generation || state.selectedStock?.code !== code || state.tab !== "stock") return;
    $("relations-range").textContent = "历史关联暂时无法读取";
    $("competition-results").innerHTML = emptyHTML("未能加载历史关联", "请重新加载后查看。");
    showError(error, loadRelationHistory);
  } finally {
    if (state.relationsRequest === generation && state.selectedStock?.code === code && state.tab === "stock") {
      state.relationsLoading = false;
      $("stock-relations").setAttribute("aria-busy", "false");
    }
  }
}

function verificationBadge(label = "待行情核实") {
  return `<span class="verification-label" title="按涨停池比较：目前只确认一方晋级、另一方未入池；未入池不等于未涨停，仍需用完整行情核实。">${escapeHTML(label)}</span>`;
}

function renderRoundPeer(peer) {
  const tags = stockTags(peer);
  const location = regionLabel(peer);
  const tagTitle = "当前股票标签";
  return `<button type="button" class="round-peer ${latestLimitUp(peer) ? "latest-limit-up" : ""} ${peer.is_target ? "round-target" : ""}" data-promotion="${escapeHTML(peer.promotion_status || "")}" data-relation-code="${escapeHTML(peer.code)}" data-relation-name="${escapeHTML(peer.name)}"><span class="round-peer-heading"><strong>${escapeHTML(peer.name)}</strong><small>${escapeHTML(peer.code)}</small>${peer.is_target ? '<span class="round-target-label">本票</span>' : ""}</span><span class="round-peer-profile"><span class="round-peer-location">${escapeHTML(location)}</span>${tags.length ? tags.map(tag => `<span class="round-peer-industry" title="${escapeHTML(tagTitle)}">${escapeHTML(tag)}</span>`).join("") : `<span class="round-peer-industry empty">${peer.tags_customized ? "暂无标签" : "行业待补充"}</span>`}</span></button>`;
}

function renderCompetitionRounds(data) {
  const rounds = data.rounds || [];
  if (!rounds.length) return "";
  const segments = [];
  rounds.forEach(round => {
    const segment = segments.at(-1);
    const followingDate = round.next_date || round.next_trading_date;
    if (round.outcome === "no_peers" && segment?.first.outcome === "no_peers"
        && Number(round.boards) + 1 === Number(segment.first.boards)
        && followingDate === segment.first.date) {
      segment.first = round;
      segment.count += 1;
    } else segments.push({ first: round, last: round, count: 1 });
  });
  const labels = { win: "胜出 1 轮", loss: "落后 1 轮", together: "共同晋级", cutoff: "待后续结果", missing: "数据待补", no_peers: "无同级对手", unresolved: "未形成单方胜负" };
  const items = segments.map(({ first: round, last, count }) => {
    const next = last.next_date || last.next_trading_date;
    const dateRange = `${dateLabel(round.date)} → ${next ? dateLabel(next) : "下一交易日"}`;
    let description = "";
    if (round.outcome === "win") description = `本票晋级 ${round.boards + 1} 板，本批次胜出记 1 轮，涉及 ${round.wins.length} 只对手。`;
    else if (round.outcome === "loss") description = `本票次日未入池，同梯队有 ${round.losses.length} 只对手晋级 ${round.boards + 1} 板，本批次落后记 1 轮。`;
    else if (round.outcome === "cutoff") description = `${round.boards} 进 ${round.boards + 1} 的结果${next ? `需查看 ${dateLabel(next)}` : "尚未收录"}，超出当前数据收录范围，暂不计胜负。`;
    else if (round.outcome === "missing") description = `${dateLabel(next)} 的涨停池数据未确认，暂不计胜负。`;
    else if (round.outcome === "together") description = `本票与 ${round.together_count} 只同梯队股票共同晋级 ${round.boards + 1} 板，未形成单方胜负。`;
    else if (round.outcome !== "no_peers") description = "没有形成可归入单方晋级的胜负记录；共同未入池或板数异常不计胜负。";
    const heading = `<header class="competition-round-heading"><strong>${round.boards} 进 ${last.boards + 1}</strong><div class="competition-round-context"><span class="competition-round-date" title="${escapeHTML(dateRange)}">${escapeHTML(dateRange)}</span>${description ? `<span class="competition-round-description">${escapeHTML(description)}${round.wins.length || round.losses.length ? verificationBadge() : ""}</span>` : ""}</div><span class="competition-round-status status-${escapeHTML(round.outcome)}">${escapeHTML(labels[round.outcome] || "待确认")}</span></header>`;
    if (round.outcome === "no_peers") return `<article class="competition-round competition-round-compact" data-round-date="${escapeHTML(round.date)}" data-round-height="${round.boards}" data-round-count="${count}">${heading}</article>`;
    const cohort = round.cohort || [...round.wins, ...round.losses];
    const order = members => prioritizeLatest([...members].sort((a,b) => Number(!!b.is_target) - Number(!!a.is_target) || String(a.code).localeCompare(String(b.code))));
    const advanced = order(cohort.filter(peer => peer.promotion_status === "advanced"));
    const others = order(cohort.filter(peer => peer.promotion_status !== "advanced"));
    const group = (members, label, kind) => members.length ? `<section class="round-cohort-group" data-cohort-group="${kind}" aria-label="${escapeHTML(label)}"><h5>${escapeHTML(label)} <span>${numberValue(members.length)} 只</span></h5><div class="round-cohort-grid">${members.map(renderRoundPeer).join("")}</div></section>` : "";
    const groups = advanced.length
      ? group(advanced, `晋级 ${round.boards + 1} 板`, "advanced") + group(others, "同梯队其他股票", "others")
      : `<div class="round-cohort-grid">${others.map(renderRoundPeer).join("")}</div>`;
    const advancement = round.status === "compared" ? `已晋级 ${numberValue(advanced.length)} 只` : "晋级结果待确认";
    const opponentLists = cohort.length ? `<div class="round-opponents"><span>同梯队 ${numberValue(cohort.length)} 只 · ${advancement}</span>${groups}</div>` : "";
    return `<article class="competition-round" data-round-date="${escapeHTML(round.date)}" data-round-height="${round.boards}">${heading}<div class="competition-round-body">${opponentLists}<div class="competition-round-actions">${relationDateButton(round.date, "查看起始日涨停明细")}${round.next_date ? relationDateButton(round.next_date, "查看次日涨停明细") : ""}</div></div></article>`;
  }).join("");
  return `<section class="competition-rounds" aria-label="逐轮竞争"><div class="competition-rounds-heading"><h4>逐轮竞争</h4><span>共 ${numberValue(rounds.length)} 轮${segments.length < rounds.length ? ` · 合并展示 ${numberValue(segments.length)} 条` : ""} · 区域内滚动查看</span></div><div class="relation-scroll competition-rounds-scroll" role="region" aria-label="全部逐轮竞争记录" tabindex="0">${items}</div></section>`;
}

function renderStockCycles(data) {
  const cycles = data.cycles || [];
  const rounds = data.relationships?.competition?.rounds || [];
  return cycles.length ? cycles.map(cycle => {
    const uncertain = cycle.clipped || cycle.start_known === false;
    const status = uncertain ? "周期边界待确认" : cycle.ongoing ? `截至 ${dateLabel(data.as_of_date || data.range_end)} 仍在连板` : cycle.end_known === true ? "已结束" : "后续状态待确认";
    const count = Math.min(24, (cycle.dates || []).length || Number(cycle.boards) || 1);
    const dates = new Set(cycle.dates || []);
    const cycleRounds = rounds.filter(round => dates.size ? dates.has(round.date) : round.date >= cycle.start && round.date <= cycle.end);
    return `<article class="cycle-card cycle-with-rounds" data-cycle-start="${escapeHTML(cycle.start)}"><div class="cycle-summary"><div class="cycle-head"><strong>${numberValue(cycle.boards)}<small>板</small></strong><span class="cycle-status ${cycle.ongoing ? "ongoing" : ""}" title="${escapeHTML(status)}">${escapeHTML(status)}</span></div><div class="cycle-date">${escapeHTML(dateLabel(cycle.start))}<span>→</span>${escapeHTML(dateLabel(cycle.end))}</div><p class="cycle-height-label">周期内已收录的最高高度</p><div class="cycle-steps" aria-hidden="true">${Array.from({ length: count }, (_, index) => `<span class="cycle-step" style="height:${Math.min(28, 7 + index * (20 / count))}px"></span>`).join("")}</div>${cycle.note ? `<p class="cycle-note">${escapeHTML(cycle.note)}</p>` : ""}</div>${renderCompetitionRounds({rounds: cycleRounds}) || '<p class="cycle-rounds-empty">该周期暂无已收录的竞争记录。</p>'}</article>`;
  }).join("") : emptyHTML("暂无连板周期", "已收录数据中没有这只股票的涨停周期。");
}

function containRelationWheel(event) {
  const comparison = event.target.closest?.(".peer-comparison-records");
  if (event.ctrlKey && comparison && (event.deltaY || event.deltaX)) {
    const distance = Math.abs(event.deltaY || 0) >= Math.abs(event.deltaX || 0) ? event.deltaY : event.deltaX;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? comparison.clientWidth : 1;
    comparison.scrollLeft = Math.max(0, Math.min(comparison.scrollWidth - comparison.clientWidth, comparison.scrollLeft + distance * unit));
    event.preventDefault();
    return;
  }
  if (event.ctrlKey || !event.deltaY) return;
  const scroller = event.target.closest?.(".relation-scroll");
  if (!scroller) return;
  const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (event.deltaY < 0 && scroller.scrollTop <= 0 || event.deltaY > 0 && scroller.scrollTop >= bottom - 1) event.preventDefault();
}

function mergeRelationPeers(data, targetCode = "") {
  const peers = new Map();
  const get = row => {
    const code = String(row.code || "");
    if (!/^\d{6}$/.test(code) || code === targetCode) return null;
    if (!peers.has(code)) peers.set(code, {code, name: row.name || code, market: row.market || "", wins: [], losses: [], commonDates: []});
    const peer = peers.get(code);
    for (const key of ["name", "initials", "industry", "tags", "tags_customized", "registered_province"]) {
      if (row[key] !== undefined) peer[key] = row[key];
    }
    return peer;
  };
  for (const key of ["wins", "losses"]) (data?.competition?.[key] || []).forEach(row => {
    const peer = get(row);
    if (peer) peer[key] = [...new Map([...peer[key], ...(row.rounds || [])].map(round => [`${round.date}|${round.next_date}|${round.boards}`, {...round}])).values()];
  });
  (data?.cooccurrences?.rows || []).forEach(row => {
    const peer = get(row);
    if (!peer) return;
    peer.name = row.name || peer.name;
    peer.commonDates = [...new Map([...peer.commonDates, ...(row.dates || [])].map(day => [day.date, {...day}])).values()];
  });
  const rows = [...peers.values()].map(peer => ({...peer, winCount: peer.wins.length, lossCount: peer.losses.length,
    commonCount: peer.commonDates.length,
    lastDate: [...peer.commonDates.map(day => day.date), ...peer.wins.map(round => round.next_date || round.date), ...peer.losses.map(round => round.next_date || round.date)].sort().at(-1) || ""}));
  return prioritizeLatest(rows.sort((a,b) => b.commonCount - a.commonCount || b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)));
}

function peerComparisonEntries(peer) {
  const entries = new Map();
  const get = date => {
    if (!entries.has(date)) entries.set(date, {date, common: null, wins: [], losses: []});
    return entries.get(date);
  };
  peer.commonDates.forEach(day => { get(day.date).common = day; });
  for (const key of ["wins", "losses"]) peer[key].forEach(round => get(round.date)[key].push(round));
  return [...entries.values()].sort((a,b) => String(b.date).localeCompare(String(a.date)));
}

function comparisonRunHTML(stock, observations, days, commonDates, kind) {
  const name = stock.name || "本票";
  const byDate = new Map(observations.map(row => [row.date, row]));
  const max = Math.max(0, ...observations.map(row => Number(row.boards) || 0));
  const nodes = days.map((day, index) => {
    const row = byDate.get(day);
    if (!row) return '<span class="comparison-node-empty" aria-hidden="true"></span>';
    const previous = byDate.get(days[index - 1]);
    const connected = previous && row.boards === previous.boards + 1;
    return `<button type="button" class="comparison-node ${commonDates.has(day) ? "shared-day" : ""} ${connected ? "connected" : ""}" data-relation-date="${escapeHTML(day)}" title="${escapeHTML(name)} · ${escapeHTML(dateLabel(day))} · ${row.boards} 板" aria-label="${escapeHTML(name)} ${escapeHTML(dateLabel(day))}，${row.boards} 板，查看当日全部股票"><time datetime="${escapeHTML(day)}">${escapeHTML(dateLabel(day).slice(5))}</time><strong>${numberValue(row.boards)}<small>板</small></strong></button>`;
  }).join("");
  const leaderLabel = kind === "leader" ? `<span class="comparison-leader-label" title="当前两票之外，在对比日期内有涨停记录的股票；按相交的连续涨停周期最高板选取，并列时依次按周期内较近的涨停日期、股票代码选取。仅使用已收录数据。">同期最高板</span>` : "";
  const range = kind === "leader" ? `<span class="comparison-leader-range" title="相交的已收录连续涨停周期">${escapeHTML(dateLabel(stock.start))} — ${escapeHTML(dateLabel(stock.end))}</span>` : "";
  return `<div class="comparison-run comparison-run-${kind}"><div class="comparison-run-name">${leaderLabel}${relationStockButton(stock)}<span>${numberValue(observations.length)} 个涨停日 · 最高 ${max} 板</span>${range}</div>${nodes}</div>`;
}

function comparisonSegmentsHTML(peer, detail) {
  if (!detail) return '<div class="loading-state">正在整理双方完整连板周期…</div>';
  if (detail.error) return `<div class="comparison-load-error"><p>${escapeHTML(detail.error)}</p><button type="button" class="button secondary small" data-retry-comparison>重新加载</button></div>`;
  const entries = peerComparisonEntries(peer);
  const targetName = state.selectedStock?.name || "本票";
  const maxDays = Math.max(0, ...detail.segments.map(segment => new Set([...segment.target_dates, ...segment.peer_dates, ...(segment.leader?.dates || [])].map(row => row.date)).size));
  const records = detail.segments.map(segment => {
    const leader = segment.leader;
    const days = [...new Set([...segment.target_dates, ...segment.peer_dates, ...(leader?.dates || [])].map(row => row.date))].sort();
    const commonDates = new Set(segment.common_dates);
    const outcomes = entries.filter(entry => entry.date >= segment.start && entry.date <= segment.end).flatMap(entry =>
      ["wins", "losses"].flatMap(key => entry[key].map(round => `<div class="peer-outcome ${key}"><span class="peer-outcome-date">${relationDateButton(round.date)} → ${round.next_date ? relationDateButton(round.next_date) : "待收录"}</span><p>${key === "wins" ? `本票晋级 ${round.boards + 1} 板，对方未入池。` : `对方晋级 ${round.boards + 1} 板，本票未入池。`}${verificationBadge()}</p></div>`))).join("");
    return `<article class="peer-comparison-record" data-comparison-start="${escapeHTML(segment.start)}" data-comparison-end="${escapeHTML(segment.end)}"><header><span class="comparison-period">${relationDateButton(segment.start)}${segment.start !== segment.end ? `<span>—</span>${relationDateButton(segment.end)}` : ""}</span><span class="peer-record-kind">同涨 ${numberValue(commonDates.size)} 天</span></header><div class="comparison-timeline-section" role="group" aria-label="${escapeHTML(dateLabel(segment.start))} 起涨停节点对比"><div class="comparison-timeline" style="--comparison-days:${days.length}">${comparisonRunHTML(state.selectedStock || {name: targetName}, segment.target_dates, days, commonDates, "target")}${comparisonRunHTML(peer, segment.peer_dates, days, commonDates, "peer")}${leader ? comparisonRunHTML(leader, leader.dates, days, new Set(), "leader") : ""}</div></div>${segment.leader === null ? '<p class="comparison-leader-empty">该周期暂无其他已收录的涨停股票。</p>' : ""}${outcomes}</article>`;
  }).join("");
  return records ? `<div class="peer-comparison-content" style="--comparison-max-days:${maxDays}">${records}</div>` : '<p class="relation-picker-empty">暂无已收录的共同涨停周期。</p>';
}

async function loadPeerComparison({retry = false} = {}) {
  const code = state.selectedStock?.code, peerCode = state.relationPeerCode;
  if (!code || !peerCode || state.tab !== "stock") return;
  const cache = state.comparisonCache || (state.comparisonCache = new Map());
  const key = `${code}|${peerCode}`;
  if (!retry && (cache.has(peerCode) || state.comparisonLoading === key)) return;
  if (retry) cache.delete(peerCode);
  state.comparisonLoading = key;
  if (retry) $("relation-peer-detail").innerHTML = peerComparisonHTML(state.relationPeers.find(peer => peer.code === peerCode));
  const generation = (state.comparisonRequest || 0) + 1;
  state.comparisonRequest = generation;
  try {
    const data = await request(`/api/comparison?${new URLSearchParams({code, peer: peerCode,
      exclude_st: state.relationExcludeST ? "1" : "0", exclude_gem: state.relationExcludeGEM ? "1" : "0",
      exclude_latest: state.relationExcludeLatest ? "1" : "0"})}`, "comparison");
    if (!data || state.comparisonCache !== cache || state.comparisonRequest !== generation) return;
    cache.set(peerCode, data);
  } catch (error) {
    if (state.comparisonCache === cache && state.comparisonRequest === generation) cache.set(peerCode, {error: error.message});
  } finally {
    if (state.comparisonRequest === generation && state.comparisonCache === cache) state.comparisonLoading = "";
    if (state.tab === "stock" && state.selectedStock?.code === code && state.relationPeerCode === peerCode && state.comparisonCache === cache && state.comparisonRequest === generation) {
      $("relation-peer-detail").innerHTML = peerComparisonHTML(state.relationPeers.find(peer => peer.code === peerCode));
    }
  }
}

const relationSortLabels = {winCount: "赢", lossCount: "输", commonCount: "同涨"};

function setRelationSort(key) {
  if (!Object.hasOwn(relationSortLabels, key)) return false;
  state.relationSortDirection = state.relationSort === key && state.relationSortDirection === "desc" ? "asc" : "desc";
  state.relationSort = key;
  return true;
}

function relationSortButtonsHTML() {
  return Object.entries(relationSortLabels).map(([key, label]) => {
    const active = (state.relationSort || "commonCount") === key;
    const ascending = active && state.relationSortDirection === "asc";
    const description = active ? `当前${ascending ? "升序" : "降序"}，点击${ascending ? "降序" : "升序"}` : "点击降序";
    return `<button type="button" data-relation-sort="${key}" aria-pressed="${active}" aria-label="按${label}排序，${description}" title="按${label}的次数排序，${description}">${label}<span aria-hidden="true">${active ? ascending ? "↑" : "↓" : "↕"}</span></button>`;
  }).join("");
}

function relationSortNote() {
  return `最新日涨停优先 · ${relationSortLabels[state.relationSort] || "同涨"}次数${state.relationSortDirection === "asc" ? "升序" : "降序"}`;
}

function filteredRelationPeers() {
  const query = (state.relationQuery || "").trim().toLocaleLowerCase();
  const key = Object.hasOwn(relationSortLabels, state.relationSort) ? state.relationSort : "commonCount";
  const direction = state.relationSortDirection === "asc" ? 1 : -1;
  const rows = (state.relationPeers || []).filter(peer =>
    (!state.relationExcludeST || !/^\*?ST/i.test(String(peer.name || "").replace(/\s+/g, "")))
    && (!state.relationExcludeGEM || !/^(300|301)/.test(String(peer.code)))
    && (!query || `${peer.name} ${peer.code}`.toLocaleLowerCase().includes(query)));
  return prioritizeLatest(rows.sort((a, b) => direction * (a[key] - b[key]) || b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)));
}

function setRelationFilters() {
  const excludeLatest = $("relation-exclude-latest").checked === true;
  const latestChanged = excludeLatest !== !!state.relationExcludeLatest;
  state.relationExcludeST = $("relation-exclude-st").checked;
  state.relationExcludeGEM = $("relation-exclude-gem").checked;
  state.relationExcludeLatest = excludeLatest;
  state.requests.comparison?.abort();
  state.comparisonCache = new Map();
  state.comparisonLoading = "";
  if (latestChanged && state.stockData?.stock?.code === state.selectedStock?.code) loadRelationHistory();
  else if (state.relationships) renderPeerSelection({resetScroll: true});
  updateURL();
}

function relationPeerRowsHTML(rows) {
  return rows.map(peer => {
    const selected = peer.code === state.relationPeerCode;
    return `<button type="button" class="relation-peer-choice ${latestLimitUp(peer) ? "latest-limit-up" : ""} ${selected ? "selected" : ""}" data-select-peer="${escapeHTML(peer.code)}" aria-pressed="${selected}" tabindex="${selected ? "0" : "-1"}"><span class="peer-choice-heading"><strong>${escapeHTML(peer.name)}</strong><small>${escapeHTML(peer.code)}</small>${latestLimitBadge(peer)}</span><span class="peer-choice-metrics"><span class="${peer.winCount ? "has-wins" : ""}">赢 ${numberValue(peer.winCount)}</span><span class="${peer.lossCount ? "has-losses" : ""}">输 ${numberValue(peer.lossCount)}</span><span>同涨 ${numberValue(peer.commonCount)}</span></span></button>`;
  }).join("") || '<p class="relation-picker-empty">没有匹配的股票</p>';
}

function peerComparisonHTML(peer) {
  if (!peer) return emptyHTML("暂无对比记录", state.relationQuery ? "换个股票名称或代码试试。" : state.relationExcludeST || state.relationExcludeGEM ? "当前筛选下没有关联股票，可取消勾选后查看。" : "已收录数据中暂无与其他股票的关联记录。");
  const targetName = state.selectedStock?.name || "本票";
  const entries = peerComparisonEntries(peer);
  const detail = state.comparisonCache?.get(peer.code);
  const records = comparisonSegmentsHTML(peer, detail);
  return `<header class="peer-detail-heading"><div><h4>${relationStockButton(peer)}<small>${escapeHTML(peer.code)}</small><small class="peer-stock-initials" title="股票名称首字母">${escapeHTML(nameInitials(peer) || "—")}</small><small class="peer-stock-location">${escapeHTML(regionLabel(peer))}</small>${latestLimitBadge(peer)}</h4><div class="peer-detail-profile"><p>与 ${escapeHTML(targetName)} 的历史对比</p><div class="stock-tags" aria-label="${escapeHTML(peer.name)}行业标签">${stockTags(peer).map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</div></div></div></header><div class="peer-comparison-totals"><div class="wins"><span>本票胜出</span><strong>${numberValue(peer.winCount)}<small>轮</small></strong></div><div class="losses"><span>本票落后</span><strong>${numberValue(peer.lossCount)}<small>轮</small></strong></div><div><span>同日涨停</span><strong>${numberValue(peer.commonCount)}<small>次</small></strong></div></div><div class="peer-records-heading">对比记录 · ${detail?.segments ? `${numberValue(detail.segments.length)} 组周期` : `${numberValue(entries.length)} 个关联日`}<span class="peer-scroll-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7" r=".8" fill="currentColor" stroke="none"/></svg>Ctrl＋滚轮横向浏览</span></div><div class="relation-scroll peer-comparison-records" role="region" aria-label="与${escapeHTML(peer.name)}的对比记录" tabindex="0">${records}</div>`;
}

function renderComparisonWorkspace() {
  const rows = filteredRelationPeers();
  if (!rows.some(peer => peer.code === state.relationPeerCode)) state.relationPeerCode = rows[0]?.code || "";
  const selected = rows.find(peer => peer.code === state.relationPeerCode);
  return `<section class="relation-workspace" aria-label="股票关联对比"><aside class="relation-peer-sidebar" aria-label="关联股票"><header><h4>关联股票</h4><span id="relation-peer-count">${numberValue(rows.length)} 只</span></header><label class="relation-peer-filter"><span class="sr-only">筛选关联股票</span><input id="relation-peer-search" type="search" placeholder="股票名称 / 代码" autocomplete="off" value="${escapeHTML(state.relationQuery || "")}"></label><div id="relation-peer-sort" class="relation-peer-sort" role="group" aria-label="关联股票排序">${relationSortButtonsHTML()}</div><p id="relation-sort-note" class="relation-picker-note">${relationSortNote()}</p><div id="relation-peer-list" class="relation-scroll relation-peer-list" role="region" aria-label="去重后的关联股票列表" tabindex="0">${relationPeerRowsHTML(rows)}</div></aside><div id="relation-peer-detail" class="relation-peer-main" aria-live="polite">${peerComparisonHTML(selected)}</div></section>`;
}

function renderPeerSelection({resetScroll = false} = {}) {
  const rows = filteredRelationPeers();
  if (!rows.some(peer => peer.code === state.relationPeerCode)) state.relationPeerCode = rows[0]?.code || "";
  const list = $("relation-peer-list");
  const scrollTop = list.scrollTop;
  const hadFocus = list.contains(document.activeElement);
  list.innerHTML = relationPeerRowsHTML(rows);
  list.scrollTop = resetScroll ? 0 : scrollTop;
  $("relation-peer-count").textContent = `${numberValue(rows.length)} 只`;
  $("relation-peer-detail").innerHTML = peerComparisonHTML(rows.find(peer => peer.code === state.relationPeerCode));
  if (hadFocus) list.querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  loadPeerComparison();
}

function renderCompetition() {
  const data = state.relationships?.competition;
  $("relations-summary-note").hidden = !data;
  $("relations-summary-note").innerHTML = data ? ` · 汇总胜出、落后与同日涨停记录，关联股票去重展示。${latestPriorityNote()}` : "";
  if (!data) { $("competition-results").innerHTML = emptyHTML("暂无历史关联", "请选择股票查看。"); return; }
  $("competition-results").innerHTML = renderComparisonWorkspace();
}

function renderChart(rows) {
  const ordered = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const width = Math.max(680, ordered.length * 30 + 70), height = 184, left = 32, top = 24, bottom = 134;
  const max = Math.max(1, ...ordered.map((row) => Number(row.boards) || 0));
  const chartWidth = width - left - 20, barSlot = chartWidth / ordered.length, barWidth = Math.min(24, barSlot * .57);
  const ticks = [...new Set([0, Math.ceil(max / 2), max])];
  const grid = ticks.map((tick) => { const y = bottom - tick / max * (bottom - top); return `<line class="grid-line" x1="${left}" y1="${y}" x2="${width - 10}" y2="${y}"/><text x="${left - 9}" y="${y + 3}" text-anchor="end">${tick}</text>`; }).join("");
  const bars = ordered.map((row, index) => {
    const board = Number(row.boards) || 0, x = left + barSlot * index + (barSlot - barWidth) / 2, barHeight = Math.max(2, board / max * (bottom - top));
    const label = index % Math.ceil(ordered.length / 8) === 0 || index === ordered.length - 1;
    const center = x + barWidth / 2;
    const tooltipX = Math.max(left, Math.min(width - 182, center - 84));
    return `<a href="?date=${escapeHTML(row.date)}" data-relation-date="${escapeHTML(row.date)}" aria-label="${escapeHTML(dateLabel(row.date))}，${board} 板，查看当日全部股票"><title>${escapeHTML(row.date)}：${board} 板</title><rect x="${x.toFixed(2)}" y="${(bottom - barHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2" fill="${board === max ? "#d94236" : "#efcdbb"}"/>${ordered.length <= 24 ? `<text class="bar-label" x="${center.toFixed(2)}" y="${(bottom - barHeight - 5).toFixed(2)}" text-anchor="middle">${board}</text>` : ""}${label ? `<text x="${center.toFixed(2)}" y="155" text-anchor="middle">${escapeHTML(String(row.date).slice(0, 7).replace("-", "."))}</text><text x="${center.toFixed(2)}" y="170" text-anchor="middle">${escapeHTML(String(row.date).slice(8))}日</text>` : ""}<g class="chart-hover-label" transform="translate(${tooltipX.toFixed(2)} 0)" aria-hidden="true"><rect width="168" height="25" rx="4"/><text x="84" y="17" text-anchor="middle">${escapeHTML(dateLabel(row.date))} · ${board} 板</text></g></a>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="group" aria-label="${ordered.length} 个涨停交易日的连板高度，最高 ${max} 板">${grid}${bars}</svg>`;
}

function returnToDate() {
  state.selectedStock = null;
  state.boards = "";
  state.suggestions = [];
  state.suggestionsQuery = "";
  $("stock-search").value = "";
  $("stock-search").setCustomValidity("");
  hideSuggestions();
  loadDate();
}

function runQuery() {
  if (!$("stock-search").value.trim()) return returnToDate();
  loadStock();
}

function changeQueryDate() {
  updateDateNavigation();
  returnToDate();
}

function minuteRows(searchId = "minute-search") {
  const query = ($(searchId).value || "").trim().toUpperCase();
  const extra = searchId === "minute-compare-search" && state.minuteTimelineData?.date === state.intradayDate && state.minuteTimelineData.scope?.exclude_gem === false
    ? (state.minuteTimelineData.pool || []).filter(row => /^(300|301)\d{3}$/.test(row.code)) : [];
  const rows = [...(state.intradayData?.rows || []), ...extra].filter(row => !query || `${row.code} ${row.name} ${row.initials || ""}`.toUpperCase().includes(query))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  // Same stable priorities as the daily search cards: board height, latest
  // limit-up within that height, then code. Filtering preserves this order.
  return prioritizeLatest(rows, true).sort((a, b) => Number(b.boards) - Number(a.boards));
}

function minuteDates() {
  return [...new Set(state.intradayData?.dates || [])].sort();
}

function updateMinuteDateNavigation() {
  const dates = minuteDates(), day = state.intradayDate || "", input = $("minute-date");
  input.value = day;
  input.min = dates[0] || "";
  input.max = dates.at(-1) || "";
  input.disabled = !dates.length;
  $("minute-prev-date").disabled = !dates.some(value => value < day);
  $("minute-next-date").disabled = !dates.some(value => value > day);
  $("minute-latest-date").disabled = !dates.length;
}

function changeMinuteDate(day = $("minute-date").value) {
  const input = $("minute-date");
  input.value = day;
  if (!day || input.checkValidity?.() === false) { input.reportValidity?.(); return; }
  if (!minuteDates().includes(day)) {
    input.setCustomValidity("请选择交易日，周末和休市日没有分时数据");
    input.reportValidity?.();
    input.setCustomValidity("");
    input.value = state.intradayDate || "";
    return;
  }
  if (day === state.intradayDate) return;
  state.intradayDate = day;
  updateMinuteDateNavigation();
  updateURL();
  return loadIntraday();
}

function navigateMinuteDate(direction) {
  const dates = minuteDates(), day = state.intradayDate || "";
  const target = direction === "latest" ? dates.at(-1) : direction === "previous" ? [...dates].reverse().find(value => value < day) : dates.find(value => value > day);
  if (target) return changeMinuteDate(target);
}

function renderMinuteProfile(stock, loading = false) {
  $("minute-stock-initials").textContent = loading ? "" : nameInitials(stock) || "—";
  $("minute-stock-region").textContent = loading ? "" : regionLabel(stock);
  $("minute-stock-blacklist").hidden = loading || stock.blacklisted !== true;
  $("minute-stock-tags").innerHTML = loading ? "" : stockTags(stock).map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>';
  const note = $("minute-stock-note");
  note.innerHTML = loading ? "" : renderStockNote(stock);
  if (loading) note.removeAttribute("data-note-code");
  else note.setAttribute("data-note-code", stock.code);
}

function renderMinuteList() {
  const rows = minuteRows();
  const limit = state.minuteListLimit || 150;
  const visible = rows.slice(0, limit), selected = rows.find(row => row.code === state.intradayCode);
  if (selected && !visible.includes(selected)) visible.push(selected);
  $("minute-stock-count").textContent = `${rows.length} / ${state.intradayData?.total || 0}`;
  $("minute-stock-list").innerHTML = visible.map(row => `<button type="button" class="minute-stock-row${row.code === state.intradayCode ? " selected" : ""}" data-minute-code="${escapeHTML(row.code)}" aria-pressed="${row.code === state.intradayCode}"><span class="minute-stock-row-name">${escapeHTML(row.name)}<small>${escapeHTML(row.code)}</small></span><span class="minute-stock-row-info"><b>${row.boards ? `${numberValue(row.boards)} 板` : "主板"}</b><small data-minute-status="${escapeHTML(row.code)}" class="${row.status === "ok" ? "" : "minute-incomplete"}">${row.status === "ok" ? "已采集" : row.status === "partial" ? "部分数据" : "按需采集"}</small></span></button>`).join("") + (rows.length > visible.length ? `<button type="button" class="minute-more" data-minute-more>显示更多（剩余 ${rows.length - visible.length} 只）</button>` : "") || emptyHTML("没有匹配的股票", "试试其他名称、代码或首字母。");
}

function updateMinuteSelection() {
  $("minute-stock-list").querySelectorAll("[data-minute-code]").forEach(button => {
    const selected = button.dataset.minuteCode === state.intradayCode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function minuteCompareStyle(index) {
  const colors = ["#487da9", "#7e62a3", "#379286", "#b87935", "#b55a89", "#667f3c", "#6364b2", "#8b6e60"];
  return {color: colors[index % colors.length], dash: ["", "6 3", "2 3", "8 3 2 3"][Math.floor(index / colors.length) % 4]};
}

function renderMinuteCompareList() {
  const rows = minuteRows("minute-compare-search"), limit = state.minuteCompareLimit || 150;
  const visible = rows.slice(0, limit);
  visible.push(...rows.filter(row => (state.minuteCompareCodes || []).includes(row.code) && !visible.includes(row)));
  $("minute-compare-list").innerHTML = visible.map(row => `<label class="minute-stock-row minute-compare-row" data-compare-row="${escapeHTML(row.code)}"><input type="checkbox" data-minute-compare="${escapeHTML(row.code)}" aria-label="对比 ${escapeHTML(row.name)} ${escapeHTML(row.code)}"><span class="minute-stock-row-name">${escapeHTML(row.name)}<small>${escapeHTML(row.code)} · ${row.boards ? `${numberValue(row.boards)} 板` : "主板"}</small></span><small class="minute-compare-status"></small></label>`).join("") + (rows.length > visible.length ? `<button type="button" class="minute-more" data-minute-compare-more>显示更多（剩余 ${rows.length - visible.length} 只）</button>` : "") || emptyHTML("没有匹配的股票", "试试其他名称、代码或首字母。");
  updateMinuteCompareSelection();
}

function updateMinuteCompareSelection() {
  const codes = state.minuteCompareCodes || [];
  $("minute-compare-count").textContent = String(codes.length);
  $("minute-compare-clear").disabled = !codes.length;
  $("minute-compare-list").querySelectorAll("[data-compare-row]").forEach(row => {
    const code = row.dataset.compareRow, primary = code === state.intradayCode, index = codes.indexOf(code);
    const entry = state.minuteComparisons?.get(code), input = row.querySelector("input");
    input.checked = index >= 0;
    input.disabled = primary;
    row.classList.toggle("selected", index >= 0);
    row.classList.toggle("is-primary", primary);
    row.style.setProperty("--compare-color", index >= 0 ? minuteCompareStyle(index).color : "#8b8795");
    row.querySelector(".minute-compare-status").textContent = primary ? "主图" : index < 0 ? "" : entry?.loading ? "读取中" : entry?.error ? "读取失败" : entry?.data?.points.length ? (entry.data.status === "partial" ? "部分数据" : "已叠加") : "无数据";
  });
}

function renderMinuteCompareLegend(slot = null, clock = null) {
  const codes = state.minuteCompareCodes || [], data = state.minuteDetail;
  $("minute-compare-legend").hidden = !codes.length;
  const item = (detail, label, color, dash, status = "") => {
    const point = minutePointAt(detail, slot, clock);
    const pct = point && detail.previous_close > 0 ? (point.price / detail.previous_close - 1) * 100 : null;
    const value = pct === null ? status || "该分钟缺失" : `${pct >= 0 ? "+" : ""}${numberValue(pct, 2)}% · ${numberValue(minuteDisplayPoint(detail, point).volume / 100)} 手`;
    return `<span class="minute-compare-chip"><svg viewBox="0 0 20 8" aria-hidden="true"><path d="M0 4H20" stroke="${color}"${dash ? ` stroke-dasharray="${dash}"` : ""}/></svg><span>${escapeHTML(label)}</span><span>${escapeHTML(value)}</span></span>`;
  };
  $("minute-compare-legend").innerHTML = !codes.length ? "" :
    (data ? item(data, `${data.stock.name}（主图）`, "#ce6251", "") : "") + codes.map((code, index) => {
      const entry = state.minuteComparisons?.get(code), row = state.intradayData?.rows.find(r => r.code === code) || state.minuteTimelineData?.pool?.find(r => r.code === code) || entry?.data?.stock, style = minuteCompareStyle(index);
      return item(entry?.data, row?.name || code, style.color, style.dash, entry?.loading ? "读取中…" : entry?.error ? "读取失败，请重选" : entry?.data?.points.length ? "" : "暂无分时");
    }).join("");
  updateMinuteVolumeReadings(slot, clock);
}

function minutePointAt(detail, slot = null, clock = null) {
  return slot === "auction" ? detail?.auction?.points?.at(-1) : slot === null ? detail?.points.at(-1) : detail?.points.find(p => clock ? p.time === clock : p.slot === slot);
}

function updateMinuteVolumeReadings(slot = null, clock = null) {
  $("minute-chart").querySelectorAll("[data-minute-volume-row]").forEach(row => {
    const code = row.dataset.minuteVolumeRow;
    const detail = state.minuteDetail?.stock.code === code ? state.minuteDetail : state.minuteComparisons?.get(code)?.data;
    const point = minutePointAt(detail, slot, clock), stamp = slot === "auction" ? "09:25" : clock || point?.time || "";
    row.querySelector("[data-volume-reading]").textContent = `${stamp ? `${stamp} · ` : ""}${point ? `${numberValue(minuteDisplayPoint(detail, point).volume / 100)} 手` : "该分钟缺失"}`;
    const cursor = row.querySelector(".minute-volume-cursor");
    cursor.toggleAttribute("hidden", slot === null);
    if (slot !== null) {
      const xx = slot === "auction" ? 140 : state.minuteChartScale.x(slot);
      cursor.setAttribute("x1", xx);
      cursor.setAttribute("x2", xx);
    }
  });
}

function refreshMinuteComparisonChart() {
  updateMinuteCompareSelection();
  if (!state.minuteLoading && state.minuteDetail?.points.length) {
    const refocus = document.activeElement?.matches?.(".minute-svg"), hoverMode = state.minuteHoverMode;
    $("minute-chart").innerHTML = minuteChartHTML(state.minuteDetail);
    if (refocus) $("minute-chart").querySelector(".minute-svg")?.focus({preventScroll: true});
    if (hoverMode === "auction") showMinuteAuctionPoint(); else showMinutePoint(state.minutePointIndex || 0);
  } else renderMinuteCompareLegend();
}

async function loadMinuteComparison(code) {
  const day = state.intradayDate, generation = state.intradayGeneration;
  const entry = {loading: true};
  state.minuteComparisons ??= new Map();
  state.minuteComparisons.set(code, entry);
  const current = () => state.tab === "intraday" && day === state.intradayDate && generation === state.intradayGeneration &&
    state.minuteComparisons.get(code) === entry && state.minuteCompareCodes.includes(code);
  updateMinuteCompareSelection();
  renderMinuteCompareLegend();
  try {
    const data = await requestMinuteData(day, code, `minute-compare-${code}`, current);
    if (!current()) return;
    if (!data) throw new Error("分时读取已中断");
    entry.data = data;
    recordMinuteData(data);
  } catch (error) {
    if (!current()) return;
    entry.error = error.message;
  } finally {
    if (current()) {
      entry.loading = false;
      refreshMinuteComparisonChart();
    }
  }
}

async function selectMinuteComparison(code, selected) {
  const available = state.intradayData?.rows.some(row => row.code === code) || state.minuteTimelineData?.date === state.intradayDate && state.minuteTimelineData?.pool?.some(row => row.code === code);
  if (code === state.intradayCode || selected && !available) return;
  const codes = state.minuteCompareCodes ||= [];
  if (selected && !codes.includes(code)) codes.push(code);
  else if (!selected) {
    state.minuteCompareCodes = codes.filter(value => value !== code);
    state.requests[`minute-compare-${code}`]?.abort();
    state.minuteComparisons?.delete(code);
  } else return;
  updateURL();
  refreshMinuteComparisonChart();
  if (selected) await loadMinuteComparison(code);
}

function clearMinuteComparisons() {
  (state.minuteCompareCodes || []).forEach(code => state.requests[`minute-compare-${code}`]?.abort());
  state.minuteCompareCodes = [];
  state.minuteComparisons = new Map();
  updateURL();
  refreshMinuteComparisonChart();
}

async function requestMinuteData(day, code, channel, current = () => true) {
  let data = await request(`/api/intraday/stock?date=${encodeURIComponent(day)}&code=${encodeURIComponent(code)}`, channel);
  if (!current()) return null;
  if ((data?.needs_collection || data?.needs_refresh) && state.meta?.capabilities?.edit_tags === true) {
    data = await request("/api/intraday/collect", channel, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({date: day, code})});
  }
  return data;
}

function recordMinuteData(data) {
  if (data.date !== state.intradayDate || !state.intradayData) return;
  const rows = state.intradayData.rows, row = rows.find(r => r.code === data.stock.code);
  const changed = row && (row.status !== data.status || row.point_count !== data.points.length);
  if (row) { row.status = data.status; row.point_count = data.points.length; }
  state.intradayData.ready = rows.filter(r => r.status === "ok").length;
  state.intradayData.partial = rows.filter(r => r.status === "partial").length;
  $("minute-coverage").textContent = `主板 ${state.intradayData.total} 只 · 已缓存 ${state.intradayData.ready} 只完整分时${state.intradayData.partial ? ` · ${state.intradayData.partial} 只部分数据` : ""} · 未缓存按需采集`;
  $("minute-stock-list").querySelectorAll(`[data-minute-status="${data.stock.code}"]`).forEach(label => { label.textContent = data.status === "ok" ? "已采集" : data.status === "partial" ? "部分数据" : "读取失败，可重选"; });
  if (changed && !state.minuteTimelineCollecting && !state.minuteLiveRefreshing && state.minuteTimelineData?.date === data.date && state.minuteTimelineData.pool?.some(stock => stock.code === data.stock.code)) loadMinuteTimeline({quiet: true});
}

async function refreshVisibleMinuteData() {
  if (state.tab !== "intraday" || document.hidden || state.minuteLiveRefreshing || state.minuteLoading || state.minuteTimelineCollecting ||
      !state.intradayDate || !state.meta?.live?.enabled ||
      state.intradayDate !== state.meta.live.today) return;
  const refreshKey = `${state.intradayDate}|${$("minute-timeline-exclude-gem").checked !== false}`;
  if (state.minuteLiveRefreshKey === refreshKey && Date.now() - (state.minuteLiveRefreshedAt || 0) < 60000) return;
  const day = state.intradayDate, generation = state.intradayGeneration, primary = state.intradayCode;
  const stockGeneration = state.minuteStockGeneration;
  const current = () => state.tab === "intraday" && !document.hidden && day === state.intradayDate && generation === state.intradayGeneration;
  const timelineEnabled = minuteTimelineLiveEnabled(), excludeGem = $("minute-timeline-exclude-gem").checked !== false;
  const scopeCurrent = () => current() && (!timelineEnabled || excludeGem === ($("minute-timeline-exclude-gem").checked !== false));
  const status = timelineEnabled ? {date: day, key: refreshKey, running: true, done: 0, total: 0, failed: 0} : null;
  if (status) { state.minuteTimelineLiveStatus = status; $("minute-timeline-progress").hidden = true; }
  state.minuteLiveRefreshing = true;
  state.minuteLiveRefreshKey = refreshKey;
  state.minuteLiveRefreshedAt = Date.now();
  updateMinuteTimelineControls();
  try {
    const overview = await request(`/api/intraday?date=${encodeURIComponent(day)}`, "minute-live-overview");
    if (!overview || !current()) return;
    state.intradayData = overview;
    state.minuteComparisons ||= new Map();
    updateMinuteDateNavigation();
    const leftScroll = $("minute-stock-list").scrollTop, rightScroll = $("minute-compare-list").scrollTop;
    renderMinuteList(); renderMinuteCompareList();
    $("minute-stock-list").scrollTop = leftScroll; $("minute-compare-list").scrollTop = rightScroll;
    if (timelineEnabled) await loadMinuteTimeline({quiet: true});
    if (!scopeCurrent()) return;
    const pool = timelineEnabled && state.minuteTimelineData?.date === day ? state.minuteTimelineData.pool || [] : [];
    const poolCodes = new Set(pool.map(stock => stock.code));
    // Share three workers between visible charts and the current timeline pool.
    const codes = [...new Set([primary, ...(state.minuteCompareCodes || []), ...poolCodes])].filter(Boolean);
    if (status) { status.total = codes.length; updateMinuteTimelineLiveStatus(); }
    const collect = async () => {
      while (codes.length && scopeCurrent()) {
        const code = codes.shift();
        const selected = () => scopeCurrent() && (code === state.intradayCode || state.minuteCompareCodes?.includes(code) || poolCodes.has(code) && minuteTimelineLiveEnabled());
        try {
          const data = await requestMinuteData(day, code, `minute-live-${code}`, selected);
          if (!data || !selected()) continue;
          if (!data.points.length) { if (status) status.failed++; continue; }
          if (status && data.refresh_error) status.failed++;
          const existing = code === primary ? state.minuteDetail : state.minuteComparisons.get(code)?.data;
          if (existing?.fetched_at && data.fetched_at < existing.fetched_at) continue;
          recordMinuteData(data);
          if (code === primary && state.intradayCode === primary && stockGeneration === state.minuteStockGeneration) {
            const refocus = document.activeElement?.matches?.(".minute-svg");
            state.minuteDetail = data;
            renderMinuteStockData(data);
            if (refocus) $("minute-chart").querySelector(".minute-svg")?.focus({preventScroll: true});
            if (state.minuteHoverMode === "auction") showMinuteAuctionPoint(); else showMinutePoint(state.minutePointIndex || 0);
          } else if (state.minuteCompareCodes?.includes(code)) {
            state.minuteComparisons.set(code, {loading: false, data});
          }
        } catch {
          if (selected()) {
            if (status) status.failed++;
            if (code === primary) $("minute-data-note").textContent += " · 自动刷新未完成，保留已缓存数据";
          }
        } finally {
          if (status && scopeCurrent()) { status.done++; updateMinuteTimelineLiveStatus(); }
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(3, codes.length)}, collect));
    if (scopeCurrent()) {
      refreshMinuteComparisonChart();
      await loadMinuteTimeline({quiet: true});
    }
  } catch {
    if (current()) $("minute-data-note").textContent += " · 自动刷新未完成，1 分钟后重试";
    if (status && current()) status.failed++;
  } finally {
    state.minuteLiveRefreshing = false;
    if (status) { status.running = false; status.checkedAt = new Date().toISOString(); }
    updateMinuteTimelineControls();
  }
}

function minuteTimelineLiveEnabled() {
  return state.tab === "intraday" && state.meta?.capabilities?.edit_tags === true &&
    state.meta?.live?.polling === true && state.intradayDate === state.meta.live.today;
}

function updateMinuteTimelineLiveStatus() {
  const label = $("minute-timeline-live-status");
  label.hidden = !(state.tab === "intraday" && state.meta?.capabilities?.edit_tags === true && state.meta?.live?.enabled && state.intradayDate === state.meta.live.today);
  if (label.hidden) return;
  if (!state.meta.live.polling) { label.textContent = "盘中每分钟自动获取 · 当前非采集时段，已暂停"; return; }
  const key = `${state.intradayDate}|${$("minute-timeline-exclude-gem").checked !== false}`;
  const status = state.minuteTimelineLiveStatus?.key === key ? state.minuteTimelineLiveStatus : null;
  const stamp = status?.checkedAt ? new Date(status.checkedAt).toLocaleTimeString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false}) : "";
  label.textContent = `盘中每分钟自动获取${status?.running ? ` · 正在更新 ${status.done} / ${status.total} 只` : stamp ? ` · 最近检查 ${stamp}${status.failed ? " · 部分未更新，下分钟重试" : ""}` : ""}`;
}

function minuteDisplayPoint(data, point) {
  const match = data.auction?.points?.find(p => p.time === "09:25");
  if (point.time === "09:30" && match && point.volume >= match.volume && point.amount + 0.1 >= match.amount) {
    return {...point, volume: Math.max(0, point.volume - match.volume), amount: Math.max(0, point.amount - match.amount)};
  }
  return point;
}

async function loadIntraday({day = state.intradayDate || "", code = state.intradayCode || ""} = {}) {
  stopMinuteTimelineCollection(false);
  closeMinuteTimelineStockPickers();
  state.minuteTimelineData = null;
  $("minute-timeline-list").innerHTML = loadingHTML();
  $("minute-timeline-coverage").textContent = "正在读取当日股票节点…";
  updateMinuteTimelineControls();
  const generation = state.intradayGeneration = (state.intradayGeneration || 0) + 1;
  state.minuteStockGeneration = (state.minuteStockGeneration || 0) + 1;
  state.minuteDetail = null;
  state.minuteLoading = false;
  Object.keys(state.requests).filter(channel => channel.startsWith("minute-compare-")).forEach(channel => state.requests[channel]?.abort());
  state.minuteComparisons = new Map();
  $("minute-compare-list").innerHTML = loadingHTML();
  $("minute-compare-list").setAttribute("aria-busy", "true");
  $("minute-compare-clear").disabled = true;
  $("minute-compare-legend").hidden = true;
  state.intradayDate = day;
  state.intradayCode = code;
  updateMinuteDateNavigation();
  state.requests["intraday-stock"]?.abort();
  setView("intraday");
  $("minute-stock-list").setAttribute("aria-busy", "true");
  $("minute-stock-list").innerHTML = loadingHTML();
  $("minute-chart").innerHTML = loadingHTML();
  $("minute-chart").setAttribute("aria-busy", "true");
  $("minute-chart").setAttribute("data-loading-label", "正在读取分时…");
  $("minute-show-average").disabled = false;
  $("minute-stock-history").disabled = false;
  $("minute-stock-title").textContent = "正在读取分时";
  $("minute-stock-code").textContent = "";
  renderMinuteProfile({}, true);
  $("minute-stock-boards").hidden = true;
  $("minute-quote").hidden = true;
  $("minute-stock-history").hidden = true;
  $("minute-hover").textContent = "正在读取本地分钟数据…";
  $("minute-data-note").textContent = "";
  try {
    const data = await request(`/api/intraday${day ? `?date=${encodeURIComponent(day)}` : ""}`, "intraday");
    if (!data || state.tab !== "intraday" || generation !== state.intradayGeneration) return;
    state.intradayData = data;
    state.intradayDate = data.date || "";
    updateMinuteDateNavigation();
    $("minute-coverage").textContent = `主板 ${data.total} 只 · 已缓存 ${data.ready} 只完整分时${data.partial ? ` · ${data.partial} 只部分数据` : ""} · 未缓存按需采集`;
    $("minute-scope").textContent = `${data.scope_note} 已采集的数据可离线查看。`;
    await loadMinuteTimeline();
    if (state.tab !== "intraday" || generation !== state.intradayGeneration) return;
    const timelineCodes = new Set((state.minuteTimelineData?.pool || []).map(row => row.code));
    const visible = minuteRows();
    state.intradayCode = visible.some(row => row.code === code) || timelineCodes.has(code) ? code : visible[0]?.code || "";
    state.minuteCompareCodes = [...new Set(state.minuteCompareCodes || [])].filter(value => value !== state.intradayCode && (data.rows.some(row => row.code === value) || timelineCodes.has(value)));
    renderMinuteList();
    renderMinuteCompareList();
    updateURL({replace: true});
    if (state.intradayCode) await Promise.all([loadMinuteStock(state.intradayCode, false), ...state.minuteCompareCodes.map(value => loadMinuteComparison(value))]);
    else {
      state.minuteDetail = null;
      $("minute-stock-title").textContent = "暂无可查看的数据";
      $("minute-stock-detail").textContent = "";
      $("minute-hover").textContent = "";
      $("minute-chart").innerHTML = emptyHTML("暂无可选交易日", "项目交易日历就绪后，切换日期即可按需读取分时。", "calendar");
    }
  } catch (error) {
    if (state.tab === "intraday" && generation === state.intradayGeneration) {
      showError(error, () => loadIntraday({day, code}));
      $("minute-coverage").textContent = "本地分时数据暂未读取成功";
      $("minute-stock-list").innerHTML = emptyHTML("读取失败", "请点击重新加载。");
      $("minute-stock-title").textContent = "读取失败";
      $("minute-chart").innerHTML = emptyHTML("分时查询未完成", error.message);
      $("minute-compare-list").innerHTML = emptyHTML("读取失败", "请点击刷新数据。");
    }
  } finally {
    if (generation === state.intradayGeneration) {
      $("minute-stock-list").setAttribute("aria-busy", "false");
      $("minute-compare-list").setAttribute("aria-busy", "false");
      $("minute-chart").setAttribute("aria-busy", String(state.minuteLoading));
      if (minuteTimelineLiveEnabled()) refreshVisibleMinuteData();
    }
  }
}


function renderMinuteStockData(data) {
  const day = data.date;
  $("minute-stock-title").textContent = data.stock.name;
  $("minute-stock-code").textContent = data.stock.code;
  $("minute-stock-boards").hidden = !data.stock.boards;
  $("minute-stock-boards").textContent = `${data.stock.boards || "—"} 板`;
  renderMinuteProfile(data.stock);
  $("minute-stock-history").hidden = false;
  $("minute-stock-detail").textContent = `${dateLabel(day)} · 不复权${data.provisional ? " · 盘中暂定" : ""}${data.stock.first_time ? ` · 首封 ${data.stock.first_time.slice(-8)}` : ""}`;
  $("minute-data-note").textContent = `${data.source || "本地分时档案"} · ${data.note}${data.reference_basis?.includes("未校正除权") ? " · 涨幅按前交易日分时收盘参考，除权日可能有差异" : ""}${data.fetched_at ? ` · 采集于 ${data.fetched_at.slice(0, 19).replace("T", " ")}（北京时间）` : ""}${data.provisional ? " · 每分钟刷新，收盘前数据可能变化" : ""}${data.refresh_error ? " · 本次采集未完成，保留上次分时并自动重试" : ""}`;
  if (!data.points.length) {
    $("minute-quote").hidden = true;
    $("minute-hover").textContent = "";
    $("minute-chart").innerHTML = emptyHTML("该日暂无可用分时", data.note, "calendar");
    return;
  }
  const last = data.points.at(-1);
  const pct = (last.price / data.previous_close - 1) * 100;
  $("minute-quote").hidden = false;
  $("minute-quote").innerHTML = `<strong class="${pct >= 0 ? "minute-up" : "minute-down"}">${numberValue(last.price, 2)}</strong><span class="${pct >= 0 ? "minute-up" : "minute-down"}">${pct >= 0 ? "+" : ""}${numberValue(pct, 2)}%</span><small title="${escapeHTML(data.reference_basis || "当日收盘价和涨幅推算")}">昨收参考 ${numberValue(data.previous_close, 2)}</small><small>成交 ${numberValue(data.points.reduce((sum, p) => sum + p.amount, 0) / 100000000, 2)} 亿元</small>`;
  $("minute-hover").textContent = "移动到图表查看分钟数据，也可聚焦图表后使用左右方向键。";
  $("minute-chart").innerHTML = minuteChartHTML(data);
}

async function loadMinuteStock(code, update = true) {
  const day = state.intradayDate;
  if (update && !state.minuteLoading && state.intradayCode === code && state.minuteDetail?.stock.code === code && state.minuteDetail.date === day) return;
  const generation = state.minuteStockGeneration = (state.minuteStockGeneration || 0) + 1;
  const current = () => generation === state.minuteStockGeneration && state.tab === "intraday" && day === state.intradayDate && code === state.intradayCode;
  state.intradayCode = code;
  state.minuteLoading = true;
  // A selected peer becomes the primary without drawing the same stock twice.
  state.minuteCompareCodes = (state.minuteCompareCodes || []).filter(value => value !== code);
  state.requests[`minute-compare-${code}`]?.abort();
  state.minuteComparisons?.delete(code);
  updateMinuteSelection();
  updateMinuteCompareSelection();
  if (update) updateURL();
  clearError();
  const row = state.intradayData?.rows.find(item => item.code === code);
  // Keep the rendered stock and panel height until its replacement is ready.
  // Selection only changes classes; the list retains its nodes and scroll.
  if (!state.minuteDetail) {
    $("minute-stock-title").textContent = row?.name || code;
    $("minute-stock-code").textContent = code;
    $("minute-stock-boards").hidden = !row?.boards;
    $("minute-stock-boards").textContent = `${row?.boards || "—"} 板`;
    renderMinuteProfile(row || {code, name: code}, !row);
    $("minute-stock-detail").textContent = `${dateLabel(day)} · 不复权`;
  }
  $("minute-stock-history").disabled = true;
  $("minute-show-average").disabled = true;
  $("minute-chart").setAttribute("data-loading-label", `正在切换至 ${row?.name || code}…`);
  $("minute-chart").setAttribute("aria-busy", "true");
  try {
    const data = await requestMinuteData(day, code, "intraday-stock", current);
    if (!data || !current()) return;
    state.minuteDetail = data;
    state.minutePointIndex = 0;
    state.minuteHoverMode = "regular";
    recordMinuteData(data);
    renderMinuteCompareLegend();
    renderMinuteStockData(data);
  } catch (error) {
    if (current()) {
      showError(error, () => loadMinuteStock(code, false));
      if (!state.minuteDetail) {
        $("minute-chart").innerHTML = emptyHTML("读取分时失败", error.message);
        $("minute-hover").textContent = "";
      }
    }
  } finally {
    if (generation === state.minuteStockGeneration) {
      state.minuteLoading = false;
      $("minute-chart").setAttribute("aria-busy", "false");
      $("minute-stock-history").disabled = false;
      $("minute-show-average").disabled = false;
      renderMinuteCompareLegend();
    }
  }
}

function minuteChartHTML(data) {
  const prev = data.previous_close, showAverage = $("minute-show-average").checked;
  const peers = (state.minuteCompareCodes || []).map((code, index) => ({code, index, data: state.minuteComparisons?.get(code)?.data}))
    .filter(peer => peer.data?.points.length && peer.data.previous_close > 0);
  const series = [{data, color: "#ce6251"}, ...peers.map(peer => ({data: peer.data, color: minuteCompareStyle(peer.index).color}))];
  const prices = series.flatMap(item => [...item.data.points, ...(item.data.auction?.points || [])].flatMap(p => [Math.abs(p.price / item.data.previous_close - 1) * prev, showAverage && item.data === data && p.average ? Math.abs(p.average - prev) : 0]));
  const extent = Math.max(prev * 0.01, ...prices) * 1.08, low = Math.max(0.001, prev - extent), high = prev + extent;
  const x = slot => 170 + slot / 240 * 750;
  const y = price => 28 + (high - price) / (high - low) * 270;
  state.minuteChartScale = {x, y, slotAt: px => (px - 170) / 750 * 240};
  const path = (key, points = data.points, previousClose = prev) => {
    let previous = null;
    return points.map(p => {
      if (!Number.isFinite(p[key])) { previous = null; return ""; }
      const move = previous === null || p.slot - previous > 1;
      previous = p.slot;
      return `${move ? "M" : "L"}${x(p.slot).toFixed(2)},${y(p[key] / previousClose * prev).toFixed(2)}`;
    }).join(" ");
  };
  let axes = "";
  for (let i = 0; i <= 4; i++) {
    const price = high - (high - low) * i / 4, yy = y(price);
    axes += `<line x1="70" y1="${yy}" x2="920" y2="${yy}" class="minute-grid"/><text x="59" y="${yy + 4}" text-anchor="end">${price.toFixed(2)}</text><text x="932" y="${yy + 4}">${((price / prev - 1) * 100).toFixed(2)}%</text>`;
  }
  const sharedScale = state.minuteVolumeScale !== "individual";
  const maxima = series.map(item => [...item.data.points.map(p => minuteDisplayPoint(item.data, p).volume), ...(item.data.auction?.points || []).map(p => p.volume)].reduce((max, volume) => Math.max(max, volume), 1));
  const commonMax = maxima.reduce((max, volume) => Math.max(max, volume), 1);
  const volume = series.map((item, index) => {
    const maxVolume = sharedScale ? commonMax : maxima[index], stock = item.data.stock;
    const bars = item.data.points.map(raw => {
      const p = minuteDisplayPoint(item.data, raw), height = p.volume / maxVolume * 86;
      return `<rect x="${(x(p.slot) - 1.4).toFixed(2)}" y="${(94 - height).toFixed(2)}" width="2.8" height="${height.toFixed(2)}" class="minute-volume-bar${index ? " minute-compare-volume" : ""}" data-volume-code="${escapeHTML(stock.code)}" style="fill:${item.color}"/>`;
    }).join("");
    const match = (item.data.auction?.points || []).map(p => {
      const height = p.volume / maxVolume * 86;
      return `<rect x="136.5" y="${(94 - height).toFixed(2)}" width="7" height="${height.toFixed(2)}" class="minute-auction-volume" style="fill:${item.color}"/>`;
    }).join("");
    const last = minuteDisplayPoint(item.data, item.data.points.at(-1));
    return `<div class="minute-volume-row" data-minute-volume-row="${escapeHTML(stock.code)}" data-volume-max="${maxVolume}" style="--volume-color:${item.color}">
      <div class="minute-volume-heading"><span class="minute-volume-stock" title="${escapeHTML(stock.name)} ${escapeHTML(stock.code)}"><i style="background:${item.color}"></i>${escapeHTML(stock.name)}${index ? "" : "（主图）"}<small>${escapeHTML(stock.code)}</small></span><span data-volume-reading>${escapeHTML(last.time)} · ${numberValue(last.volume / 100)} 手</span></div>
      <div class="minute-volume-limit">刻度上限 ${numberValue(maxVolume / 100)} 手</div>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" class="minute-volume-svg" role="img" aria-label="${escapeHTML(stock.name)} ${escapeHTML(stock.code)} 的分钟成交量，${sharedScale ? "统一" : "各自"}刻度">
        <rect x="70" y="0" width="85" height="94" class="minute-auction-bg"/><line x1="70" x2="920" y1="94" y2="94" class="minute-grid"/><line x1="545" x2="545" y1="0" y2="94" class="minute-grid"/>${bars}${match}<line class="minute-volume-cursor" x1="170" x2="170" y1="0" y2="94" hidden/>
      </svg></div>`;
  }).join("");
  const auction = series.map(item => (item.data.auction?.points || []).map(p => {
    const yy = y(p.price / item.data.previous_close * prev);
    return `<circle cx="140" cy="${yy.toFixed(2)}" r="3.5" class="minute-auction-point" data-auction-code="${escapeHTML(item.data.stock.code)}" style="fill:${item.color}"/>`;
  }).join("")).join("");
  const comparisons = peers.map(peer => {
    const style = minuteCompareStyle(peer.index);
    return `<path d="${path("price", peer.data.points, peer.data.previous_close)}" class="minute-compare-line" data-compare-code="${escapeHTML(peer.code)}" stroke="${style.color}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`;
  }).join("");
  return `<svg viewBox="0 0 1000 335" class="minute-svg" tabindex="0" role="img" aria-label="${escapeHTML(data.stock.name)} ${escapeHTML(data.date)} 分时价格、${showAverage ? "均价和" : ""}成交量。${peers.length ? `与 ${escapeHTML(peers.map(peer => peer.data.stock.name).join("、"))} 按昨收涨幅及分行成交量对比。` : ""}左侧竞价区域仅显示已取得的 09:25 撮合点。使用左右方向键逐分钟查看。">
    <rect x="70" y="28" width="85" height="270" class="minute-auction-bg"/><text x="112" y="47" text-anchor="middle">竞价</text><text x="16" y="16">${peers.length ? "主图价格 / 元" : "价格 / 元"}</text><text x="932" y="16">涨幅</text>${axes}
    <line x1="70" y1="${y(prev)}" x2="920" y2="${y(prev)}" class="minute-reference"/><line x1="545" y1="28" x2="545" y2="298" class="minute-grid"/>
    ${comparisons}${showAverage ? `<path d="${path("average")}" class="minute-average-line"/>` : ""}<path d="${path("price")}" class="minute-price-line"/>
    ${auction}${!data.auction?.points?.length ? '<text x="112" y="180" text-anchor="middle">暂无竞价</text>' : ""}
    <text x="70" y="324" text-anchor="middle">09:15</text><text x="130" y="324" text-anchor="middle">09:25</text><text x="180" y="324" text-anchor="middle">09:30</text><text x="357.5" y="324" text-anchor="middle">10:30</text><text x="545" y="324" text-anchor="middle">11:30 / 13:00</text><text x="732.5" y="324" text-anchor="middle">14:00</text><text x="920" y="324" text-anchor="middle">15:00</text>
    <g id="minute-crosshair" hidden><line id="minute-cursor-line" x1="170" x2="170" y1="28" y2="298"/><circle id="minute-cursor-dot" cx="170" cy="28" r="4"/></g>
  </svg><div class="minute-volume-toolbar"><span>成交量 / 手</span>${series.length > 1 ? `<div class="minute-volume-modes" role="group" aria-label="成交量刻度"><button type="button" data-minute-volume-scale="shared" aria-pressed="${sharedScale}" title="相同柱高代表相同手数">统一刻度</button><button type="button" data-minute-volume-scale="individual" aria-pressed="${!sharedScale}" title="各行独立缩放，便于查看各股量能变化；柱高不直接比较手数">各自刻度</button></div>` : ""}</div>${volume}<div class="minute-volume-times" aria-hidden="true"><span style="left:17%">09:30</span><span style="left:54.5%">11:30 / 13:00</span><span style="left:92%">15:00</span></div>`;
}

function showMinuteAuctionPoint() {
  const data = state.minuteDetail, point = data?.auction?.points?.at(-1);
  if (state.minuteLoading || !data?.points.length || !$("minute-crosshair")) return;
  state.minuteHoverMode = "auction";
  $("minute-crosshair").removeAttribute("hidden");
  $("minute-cursor-line").setAttribute("x1", 140);
  $("minute-cursor-line").setAttribute("x2", 140);
  if (!point) {
    $("minute-cursor-dot").setAttribute("hidden", "");
    $("minute-hover").textContent = "主图该日竞价记录未取得；下方显示对比股已取得的竞价读数。";
    renderMinuteCompareLegend("auction");
    return;
  }
  $("minute-cursor-dot").removeAttribute("hidden");
  $("minute-cursor-dot").setAttribute("cx", 140);
  $("minute-cursor-dot").setAttribute("cy", state.minuteChartScale.y(point.price));
  $("minute-hover").textContent = `09:25 开盘竞价撮合　价格 ${numberValue(point.price, 2)}　涨幅 ${numberValue((point.price / data.previous_close - 1) * 100, 2)}%　撮合量 ${numberValue(point.volume / 100)} 手　金额 ${numberValue(point.amount / 10000, 2)} 万元`;
  renderMinuteCompareLegend("auction");
}

function showMinutePoint(index) {
  const data = state.minuteDetail;
  if (state.minuteLoading || !data?.points.length || !$("minute-crosshair")) return;
  index = Math.max(0, Math.min(data.points.length - 1, index));
  state.minutePointIndex = index;
  state.minuteHoverMode = "regular";
  $("minute-cursor-dot").removeAttribute("hidden");
  const point = minuteDisplayPoint(data, data.points[index]), {x, y} = state.minuteChartScale;
  $("minute-crosshair").removeAttribute("hidden");
  $("minute-cursor-line").setAttribute("x1", x(point.slot));
  $("minute-cursor-line").setAttribute("x2", x(point.slot));
  $("minute-cursor-dot").setAttribute("cx", x(point.slot));
  $("minute-cursor-dot").setAttribute("cy", y(point.price));
  const average = $("minute-show-average").checked ? `　均价 ${numberValue(point.average, 3)}` : "";
  $("minute-hover").textContent = `${point.time}　价格 ${numberValue(point.price, 2)}${average}　涨幅 ${numberValue((point.price / data.previous_close - 1) * 100, 2)}%　成交量 ${numberValue(point.volume / 100)} 手　成交额 ${numberValue(point.amount / 10000, 2)} 万元`;
  renderMinuteCompareLegend(point.slot, point.time);
}

function toggleMinuteAverage() {
  if (!state.minuteDetail?.points.length) return;
  $("minute-chart").innerHTML = minuteChartHTML(state.minuteDetail);
  if (state.minuteHoverMode === "auction") showMinuteAuctionPoint(); else showMinutePoint(state.minutePointIndex || 0);
}

function minuteTimelineViewSnapshot(list) {
  const view = list.ownerDocument?.defaultView, nodes = [...list.querySelectorAll("[data-interaction-id]")];
  const anchor = view && nodes.find(node => { const box = node.getBoundingClientRect(); return box.bottom > 0 && box.top < view.innerHeight; });
  return {view, scrollY: view?.scrollY, scrollLeft: list.querySelector(".minute-day-scroll")?.scrollLeft || 0, anchorId: anchor?.dataset.interactionId, top: anchor?.getBoundingClientRect().top,
    focusId: list.ownerDocument?.activeElement?.closest(".minute-day-node")?.dataset.dayNode,
    open: new Set(nodes.filter(node => (node.matches?.(".minute-interaction-evidence") ? node : node.querySelector(".minute-interaction-evidence"))?.open).map(node => node.dataset.interactionId))};
}

function restoreMinuteTimelineView(list, snapshot) {
  const nodes = [...list.querySelectorAll("[data-interaction-id]")];
  nodes.forEach(node => { const details = node.matches?.(".minute-interaction-evidence") ? node : node.querySelector(".minute-interaction-evidence"); if (details) details.open = snapshot.open.has(node.dataset.interactionId); });
  const anchor = nodes.find(node => node.dataset.interactionId === snapshot.anchorId);
  const scroller = list.querySelector(".minute-day-scroll");
  if (scroller) scroller.scrollLeft = snapshot.scrollLeft || 0;
  if (snapshot.focusId) [...list.querySelectorAll(".minute-day-node")].find(node => node.dataset.dayNode === snapshot.focusId)?.focus({preventScroll: true});
  if (snapshot.view) snapshot.view.scrollTo({top: anchor ? snapshot.view.scrollY + anchor.getBoundingClientRect().top - snapshot.top : snapshot.scrollY, behavior: "instant"});
}

function renderMinuteTimeline({preserve = false} = {}) {
  const data = state.minuteTimelineData, list = $("minute-timeline-list");
  if (!data || data.date !== state.intradayDate) return;
  const snapshot = preserve ? minuteTimelineViewSnapshot(list) : null;
  const model = minuteTimelineDayModel(data, {group: $("minute-timeline-group").value || "all", kind: $("minute-timeline-kind").value || "all",
    exclude: state.minuteTimelineExcludeCodes || [], sort: state.minuteTimelineSort || "boards"});
  state.minuteTimelineDayModel = model;
  if (state.minuteTimelineSelectedDate !== data.date || !model.nodes.has(state.minuteTimelineSelectedNode)) state.minuteTimelineSelectedNode = null;
  if (state.minuteTimelineSelectedDate !== data.date || !model.rows.some(row => row.stock.code === state.minuteTimelineLocateCode)) state.minuteTimelineLocateCode = null;
  if (!state.minuteTimelineSelectedNode && state.minuteTimelineLocateCode) {
    const row = model.rows.find(row => row.stock.code === state.minuteTimelineLocateCode);
    state.minuteTimelineSelectedNode = (row.events.find(event => event.kind === "seal") || row.events[0])?.id || null;
  }
  state.minuteTimelineSelectedDate = data.date;
  const excludedCodes = new Set((data.pool || data.events || []).filter(stock => (state.minuteTimelineExcludeCodes || []).includes(stock.code)).map(stock => stock.code));
  const coverage = data.coverage || {total: 0, analyzed: 0, missing: 0, partial: 0};
  $("minute-timeline-coverage").textContent = `${dateLabel(data.date)} · ${data.provisional ? "盘中暂定涨停池" : "当日收盘涨停池"} ${coverage.total} 只 · 已分析分时 ${coverage.analyzed} 只${coverage.partial ? `（${coverage.partial} 只不完整）` : ""} · 展示 ${model.rows.length} 只股票 · ${model.nodes.size} 个自身节点${excludedCodes.size ? ` · 已排除 ${excludedCodes.size} 只` : ""}${coverage.missing ? ` · ${coverage.missing} 只待补齐` : ""}`;
  const scope = data.scope || {start_time: "09:30", exclude_st: true, exclude_gem: true};
  $("minute-timeline-scope").textContent = `09:25 起 · ST 固定屏蔽 · ${scope.exclude_gem ? "已屏蔽创业板" : "已纳入创业板"}`;
  const pitch = state.minuteTimelinePitch || 120;
  const ticks = Array.from({length: 242}, (_, slot) => {
    const label = slot === 121 ? "11:30 / 13:00" : minuteTimelineDayClock(slot);
    const seconds = pitch >= 360 ? [10, 20, 30, 40, 50] : [15, 30, 45];
    return `<span class="minute-day-tick${slot === 241 ? " is-last" : ""}" style="left:${slot * pitch}px"><time>${label}</time></span>${slot > 0 && slot < 241 ? seconds.map(second => `<span class="minute-day-second" aria-hidden="true" style="left:${(slot + second / 60) * pitch}px">${second}″</span>`).join("") : ""}`;
  }).join("");
  const evidence = [...model.nodes.values()].sort(minuteTimelineEventOrder).map(event => `<button type="button" class="minute-interaction-evidence-row" data-day-node="${escapeHTML(event.id)}"><time>${escapeHTML(event.time)}</time><strong>${escapeHTML(event.name)}</strong><span>${escapeHTML(event.label)}</span><small>${event.precision === "source" ? "来源时间" : "分钟观察"}${minuteTimelineMetric(event) ? ` · ${escapeHTML(minuteTimelineMetric(event))}` : ""}</small></button>`).join("");
  state.minuteTimelineGuideObserver?.disconnect();
  list.innerHTML = model.rows.length ? `<div class="minute-day-toolbar"><div class="minute-day-legend"><span class="day-seal">封板 / 回封</span><span class="day-break">开板</span><span class="day-volume">放量</span></div><div class="minute-day-navigation"><button type="button" data-day-pan="-1" aria-label="时间轴向前查看">←</button><span id="minute-day-visible-time">09:25 起</span><button type="button" data-day-pan="1" aria-label="时间轴向后查看">→</button><label>定位时间<input id="minute-day-jump-time" type="time" min="09:25" max="15:00" step="1" value="09:25:00" aria-label="时间轴定位时间"></label><button type="button" data-day-jump>跳转</button></div><div class="minute-day-zoom" role="group" aria-label="时间轴刻度">${[[60, "紧凑"], [120, "分钟"], [360, "秒序"]].map(([value, label]) => `<button type="button" data-day-zoom="${value}" aria-pressed="${pitch === value}" title="每分钟 ${value} 像素">${label}</button>`).join("")}</div></div><div id="minute-day-selection" class="minute-day-selection" aria-live="polite"></div><div class="minute-day-chart" data-pitch="${pitch}" style="--day-track-width:${241 * pitch}px"><div class="minute-day-header-wrap"><div class="minute-day-pan-row"><span>横向滑动 →</span><div class="minute-day-pan" tabindex="0" role="region" aria-label="时间轴横向滚动条"><div></div></div></div><div class="minute-day-axis"><div class="minute-day-axis-title"><label for="minute-day-sort">股票排序 <small>左侧冻结</small></label><select id="minute-day-sort" aria-label="股票行排序"><option value="boards"${state.minuteTimelineSort !== "first_time" ? " selected" : ""}>连板高度</option><option value="first_time"${state.minuteTimelineSort === "first_time" ? " selected" : ""}>首次涨停时间</option></select></div><div class="minute-day-ruler-scroll"><div class="minute-day-axis-track"><div class="minute-day-axis-guides" aria-hidden="true"></div><span class="minute-day-axis-active-guide" hidden aria-hidden="true"></span><span class="minute-day-axis-selected-column" hidden aria-hidden="true"></span>${ticks}<time class="minute-day-axis-cursor" hidden></time></div></div></div></div><div class="minute-day-scroll" tabindex="0" role="region" aria-label="股票自身节点时间轴，左右移动查看分钟和秒序"><div class="minute-day-board"><div class="minute-day-guides" aria-hidden="true"></div><span class="minute-day-active-guide" hidden aria-hidden="true"></span><span class="minute-day-selected-column" hidden aria-hidden="true"></span>${model.rows.map(row => minuteTimelineLaneHTML(row, pitch)).join("")}</div></div></div><details class="minute-interaction-evidence minute-day-evidence" data-interaction-id="day-evidence"><summary>查看全天 ${model.nodes.size} 条分时记录</summary>${evidence}</details>` : emptyHTML(coverage.total ? "当前筛选下暂无股票节点" : "该日暂无已确认的涨停池", coverage.missing ? "可补齐当日分时，识别各股自己的封板、开板和放量节点。" : "可调整股票范围、节点类型或包含／排除股票。");
  toggleMinuteTimelineTags();
  renderMinuteTimelineStockPickers();
  updateMinuteTimelineControls();
  renderMinuteTimelineSelection();
  list.querySelectorAll(".minute-day-scroll, .minute-day-pan").forEach(scroller => scroller.addEventListener("scroll", () => syncMinuteTimelineScroll(scroller), {passive: true}));
  if (snapshot) restoreMinuteTimelineView(list, snapshot);
  syncMinuteTimelineScroll(list.querySelector(".minute-day-scroll"));
  updateMinuteTimelineGuides();
  const board = list.querySelector(".minute-day-board");
  if (board && typeof ResizeObserver === "function") {
    state.minuteTimelineGuideObserver = new ResizeObserver(updateMinuteTimelineGuides);
    state.minuteTimelineGuideObserver.observe(board);
    board.querySelectorAll(".minute-day-lane").forEach(row => state.minuteTimelineGuideObserver.observe(row));
  }
}

function updateMinuteTimelineGuides() {
  const list = $("minute-timeline-list"), board = list.querySelector(".minute-day-board");
  if (!board) return;
  const guides = board.querySelector(".minute-day-guides"), axis = list.querySelector(".minute-day-axis-guides");
  if (!guides || !axis) return;
  const top = board.getBoundingClientRect().top, positions = new Map();
  board.querySelectorAll(".minute-day-node").forEach(button => {
    const x = Number.parseFloat(button.style.getPropertyValue("--node-x"));
    const height = Math.max(0, button.getBoundingClientRect().top - top);
    if (Number.isFinite(x)) positions.set(x, Math.max(positions.get(x) || 0, height));
  });
  // Equal timestamps share a guide; each node still meets it at its own height.
  guides.innerHTML = [...positions].map(([x, height]) => `<span class="minute-day-guide" style="--guide-x:${x}px;height:${height}px"></span>`).join("");
  axis.innerHTML = [...positions.keys()].map(x => `<span class="minute-day-axis-guide" style="left:${x}px"></span>`).join("");
  highlightMinuteTimelineGuide();
}

function highlightMinuteTimelineGuide(id) {
  const list = $("minute-timeline-list"), board = list.querySelector(".minute-day-board");
  if (!board) return;
  id ||= list.querySelector(".minute-day-node:hover")?.dataset.dayNode ||
    list.ownerDocument?.activeElement?.closest(".minute-day-node")?.dataset.dayNode || state.minuteTimelineSelectedNode;
  const guide = board.querySelector(".minute-day-active-guide"), axis = list.querySelector(".minute-day-axis-active-guide");
  if (!guide || !axis) return;
  const button = [...board.querySelectorAll(".minute-day-node")].find(node => node.dataset.dayNode === id);
  guide.hidden = axis.hidden = !button;
  if (!button) return;
  const x = button.style.getPropertyValue("--node-x");
  guide.style.setProperty("--guide-x", x);
  guide.style.height = `${Math.max(0, button.getBoundingClientRect().top - board.getBoundingClientRect().top)}px`;
  axis.style.left = x;
}

function minuteTimelineRegularEvent(event) {
  if (!/^\d{2}:[0-5]\d(?::[0-5]\d)?$/.test(event?.time || "")) return false;
  const parts = event.time.split(":").map(Number), seconds = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
  return seconds >= 34200 && seconds <= 41400 || seconds >= 46800 && seconds <= 54000;
}

function minuteTimelineDayModel(data, {group = "all", kind = "all", exclude = [], sort = "boards"} = {}) {
  const excluded = new Set(exclude), seals = ["seal", "relock", "last_seal"];
  const raw = data.events || (data.interactions || []).flatMap(row => row.events || []);
  const profiles = new Map((data.pool || raw).filter(stock => Number.isInteger(stock.boards) && stock.boards >= 1).map(stock => [stock.code, stock]));
  const stocks = new Map([...profiles].filter(([code, stock]) => !excluded.has(code) &&
    (group === "all" || (group === "first" ? stock.boards === 1 : stock.boards >= 2))).map(([code, stock]) => [code, {stock, firstSeal: minuteTimelineFirstSeal(stock, raw), events: []}]));
  // Pool clocks are usable even when the minute cache omitted the opening seal.
  const firstSeals = [...stocks.values()].filter(row => row.firstSeal && !row.firstSeal.observed).map(({stock, firstSeal}) => {
    const original = raw.find(event => event.code === stock.code && event.kind === "seal" &&
      minuteTimelineClock(event) === minuteTimelineClock(firstSeal) && event.precision === "source");
    return {...original, code: stock.code, name: stock.name, boards: stock.boards, kind: "seal", label: "首次封板", time: firstSeal.time, precision: "source",
      detail: original?.detail || `${stock.clock_source || "当日涨停池"}提供的首次封板时间`};
  });
  const nodes = new Map(), seen = new Set();
  [...firstSeals, ...raw].forEach(event => {
    const openingSeal = event.kind === "seal" && event.precision === "source" && /^09:25(?::[0-5]\d)?$/.test(event.time || "");
    if (!stocks.has(event.code) || ![...seals, "break", "volume"].includes(event.kind) || !(openingSeal || minuteTimelineRegularEvent(event)) ||
        kind !== "all" && !(kind === "seal" ? seals.includes(event.kind) : kind === event.kind)) return;
    const id = `${event.code}-${event.kind}-${event.time}`;
    const key = `${event.code}-${event.kind}-${minuteTimelineClock(event)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const {related, links, ...own} = event;
    const node = {...own, id, boards: stocks.get(event.code).stock.boards};
    nodes.set(id, node); stocks.get(event.code).events.push(node);
  });
  const rows = [...stocks.values()].map(row => ({...row, events: row.events.sort(minuteTimelineEventOrder)}))
    .filter(row => kind === "all" || row.events.length)
    .sort((a, b) => (sort === "first_time" ? Number(!a.firstSeal) - Number(!b.firstSeal) ||
      (a.firstSeal ? minuteTimelineClock(a.firstSeal) : "").localeCompare(b.firstSeal ? minuteTimelineClock(b.firstSeal) : "") : 0) ||
      b.stock.boards - a.stock.boards || a.stock.code.localeCompare(b.stock.code));
  return {nodes, rows};
}

function minuteTimelineFirstSeal(stock, events) {
  const valid = time => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time) &&
    (time.startsWith("09:25") || minuteTimelineRegularEvent({time}));
  if (valid(stock.first_time)) return {time: stock.first_time, observed: false};
  const event = events.filter(event => event.code === stock.code && event.kind === "seal" && valid(event.time))
    .sort(minuteTimelineEventOrder)[0];
  return event ? {time: event.time, observed: event.precision !== "source"} : null;
}

function changeMinuteTimelineSort(value) {
  const list = $("minute-timeline-list"), snapshot = minuteTimelineViewSnapshot(list);
  state.minuteTimelineSort = value === "first_time" ? "first_time" : "boards";
  renderMinuteTimeline();
  restoreMinuteTimelineView(list, {...snapshot, anchorId: null, focusId: null});
  syncMinuteTimelineScroll(list.querySelector(".minute-day-scroll"));
  const chart = list.querySelector(".minute-day-chart");
  if (snapshot.view && chart && chart.getBoundingClientRect().top < 0) {
    snapshot.view.scrollTo({top: snapshot.view.scrollY + chart.getBoundingClientRect().top, behavior: "instant"});
  }
  $("minute-day-sort")?.focus({preventScroll: true});
}

function minuteTimelineDayPosition(clock) {
  const parts = clock.split(":").map(Number), minute = parts[0] * 60 + parts[1] + (parts[2] || 0) / 60;
  // The auction is a single point; normal minute spacing starts at 09:30.
  return minute < 570 ? 0 : Math.max(0, Math.min(100, (minute >= 780 ? minute - 780 + 121 : minute - 570 + 1) / 241 * 100));
}

function minuteTimelineDayClock(slot) {
  if (slot < 1) return "09:25";
  const minute = Math.floor(slot) + (slot < 121 ? 569 : 659);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minuteTimelineLaneLayout(row, pitch) {
  const tracks = [];
  const events = row.events.map(event => {
    const x = Math.round(minuteTimelineDayPosition(event.time) / 100 * 241 * pitch * 1e6) / 1e6;
    const left = Math.min(x, 241 * pitch - 120);
    let track = tracks.findIndex(end => left >= end);
    if (track < 0) track = tracks.length;
    tracks[track] = left + 126;
    return {event, x, left, track};
  });
  return {events, height: Math.max(84, tracks.length * 56 + 16)};
}

function minuteTimelineLaneHTML(row, pitch) {
  const stock = row.stock, layout = minuteTimelineLaneLayout(row, pitch);
  const nodes = layout.events.map(({event, x, left, track}) => {
    const type = ["seal", "relock", "last_seal"].includes(event.kind) ? "seal" : event.kind;
    const label = `${event.name} ${event.time} ${event.label}${event.precision !== "source" ? "，分钟观察" : ""}`;
    return `<button type="button" class="minute-day-node day-${type}" data-day-node="${escapeHTML(event.id)}" data-day-code="${escapeHTML(event.code)}" style="--node-x:${x}px;--node-left:${left}px;--node-track:${track};--node-offset:${x - left}px" aria-pressed="false" aria-label="${escapeHTML(label)}" title="${escapeHTML(event.detail || label)}${minuteTimelineMetric(event) ? ` · ${escapeHTML(minuteTimelineMetric(event))}` : ""}"><time>${escapeHTML(event.time)}</time><span>${escapeHTML(event.label)}</span>${event.precision !== "source" ? '<small>分钟观察</small>' : ""}</button>`;
  }).join("");
  return `<article class="minute-day-lane" data-interaction-id="stock-${escapeHTML(stock.code)}" data-day-stock="${escapeHTML(stock.code)}" style="--lane-height:${layout.height}px"><div class="minute-day-stock"><button type="button" data-timeline-code="${escapeHTML(stock.code)}" data-timeline-time="${escapeHTML(row.events[0]?.time || "09:30")}"><strong>${escapeHTML(stock.name)}</strong><span class="minute-day-board-count">${numberValue(stock.boards)} 板</span></button><small>${escapeHTML(stock.code)} · ${row.events.length} 个节点</small>${state.minuteTimelineSort === "first_time" ? `<small class="minute-day-first-seal">${row.firstSeal ? `${row.firstSeal.observed ? "涨停价出现" : "首次涨停"} <time>${escapeHTML(row.firstSeal.time)}</time>${row.firstSeal.observed ? "（分钟观察）" : ""}` : "首次涨停时间缺失"}</small>` : ""}${minuteTimelineTagsHTML(stock)}</div><div class="minute-day-lane-track">${nodes || '<span class="minute-day-no-events">尚无可显示节点</span>'}</div></article>`;
}

function renderMinuteTimelineSelection() {
  const model = state.minuteTimelineDayModel, panel = $("minute-day-selection"), list = $("minute-timeline-list");
  if (!panel || !model) return;
  const selected = model.nodes.get(state.minuteTimelineSelectedNode);
  const chart = list.querySelector(".minute-day-chart");
  if (chart) {
    chart.dataset.selected = String(!!selected);
    const x = selected ? Math.round(minuteTimelineDayPosition(selected.time) / 100 * 241 * (state.minuteTimelinePitch || 120) * 1e6) / 1e6 : 0;
    chart.style.setProperty("--day-selected-x", `${x}px`);
    chart.querySelectorAll(".minute-day-selected-column, .minute-day-axis-selected-column").forEach(marker => {marker.hidden = !selected;});
    const cursor = chart.querySelector(".minute-day-axis-cursor");
    if (cursor) { cursor.hidden = !selected; cursor.textContent = selected?.time || ""; }
  }
  list.querySelectorAll(".minute-day-node").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.dayNode === selected?.id)));
  const stock = model.rows.find(row => row.stock.code === (selected?.code || state.minuteTimelineLocateCode))?.stock;
  list.querySelectorAll(".minute-day-lane").forEach(lane => lane.classList.toggle("is-selected", lane.dataset.dayStock === stock?.code));
  panel.innerHTML = selected ? `<div class="minute-day-selected-heading"><div><time>${escapeHTML(selected.time)}</time><strong>${escapeHTML(selected.name)}</strong><span>${escapeHTML(selected.label)}</span><small>${selected.precision === "source" ? "来源时间" : "分钟观察"}${minuteTimelineMetric(selected) ? ` · ${escapeHTML(minuteTimelineMetric(selected))}` : ""}</small></div><div><button type="button" data-timeline-code="${escapeHTML(selected.code)}" data-timeline-time="${escapeHTML(selected.time)}">查看该股分时 ↗</button><button type="button" data-day-clear>清除选择</button></div></div>` : stock ? `<div class="minute-day-selected-heading"><div><strong>${escapeHTML(stock.name)}</strong><small>尚无可显示节点</small></div><button type="button" data-day-clear>清除选择</button></div>` : '<p class="minute-day-hint">每行只显示本股票的节点；左右滑动查看全天，名称列固定。已有秒数按实际位置排列，分钟观察保留原精度。</p>';
  renderMinuteTimelineStockPicker("locate");
  highlightMinuteTimelineGuide();
}

function selectMinuteTimelineDayNode(id) {
  if (!state.minuteTimelineDayModel?.nodes.has(id)) return;
  state.minuteTimelineSelectedNode = id;
  state.minuteTimelineLocateCode = state.minuteTimelineDayModel.nodes.get(id).code;
  renderMinuteTimelineSelection();
}

function syncMinuteTimelineScroll(source) {
  if (!source) return;
  const list = $("minute-timeline-list"), left = source.scrollLeft;
  list.querySelectorAll(".minute-day-scroll, .minute-day-pan, .minute-day-ruler-scroll").forEach(scroller => {if (Math.abs(scroller.scrollLeft - left) > 1) scroller.scrollLeft = left;});
  const pitch = state.minuteTimelinePitch || 120, labelWidth = list.querySelector(".minute-day-stock")?.offsetWidth || 170;
  const body = list.querySelector(".minute-day-scroll");
  $("minute-day-visible-time").textContent = `${minuteTimelineDayClock(left / pitch)} — ${minuteTimelineDayClock(Math.min(241, (left + Math.max(0, (body?.clientWidth || 0) - labelWidth - 32)) / pitch))}`;
}

function panMinuteTimelineDay(direction) {
  const scroller = $("minute-timeline-list").querySelector(".minute-day-scroll");
  if (!scroller) return;
  const labelWidth = scroller.querySelector(".minute-day-stock")?.offsetWidth || 170;
  scroller.scrollLeft += direction * Math.max(120, scroller.clientWidth - labelWidth - 32);
  syncMinuteTimelineScroll(scroller);
}

function jumpMinuteTimelineDay() {
  const input = $("minute-day-jump-time"), clock = input.value;
  if (!minuteTimelineRegularEvent({time: clock}) && !/^09:25(?::[0-5]\d)?$/.test(clock)) { input.setCustomValidity("请输入 09:25、09:30—11:30 或 13:00—15:00 内的时间"); input.reportValidity(); return; }
  input.setCustomValidity("");
  const scroller = $("minute-timeline-list").querySelector(".minute-day-scroll");
  if (scroller) { scroller.scrollLeft = minuteTimelineDayPosition(clock) / 100 * 241 * (state.minuteTimelinePitch || 120); syncMinuteTimelineScroll(scroller); }
}

function zoomMinuteTimelineDay(value) {
  if (![60, 120, 360].includes(value)) return;
  const scroller = $("minute-timeline-list").querySelector(".minute-day-scroll"), previous = state.minuteTimelinePitch || 120;
  const leftSlot = (scroller?.scrollLeft || 0) / previous;
  state.minuteTimelinePitch = value;
  renderMinuteTimeline({preserve: true});
  const next = $("minute-timeline-list").querySelector(".minute-day-scroll");
  if (next) {next.scrollLeft = leftSlot * value; syncMinuteTimelineScroll(next);}
}

function minuteTimelinePickerStocks() {
  const data = state.minuteTimelineData, labels = state.minuteTimelineStockLabels ||= {};
  const source = data?.date === state.intradayDate ? data.pool || data.events || [] : [];
  const current = new Map(source.map(stock => [stock.code, stock]));
  current.forEach(stock => { labels[stock.code] = {code: stock.code, name: stock.name, boards: stock.boards, initials: stock.initials || ""}; });
  const codes = new Set([...current.keys(), ...(state.minuteTimelineExcludeCodes || [])]);
  return [...codes].map(code => ({...(labels[code] || {code, name: code, boards: 0}), inPool: current.has(code)}))
    .sort((a, b) => Number(b.inPool) - Number(a.inPool) || (b.boards || 0) - (a.boards || 0) || a.code.localeCompare(b.code));
}

function renderMinuteTimelineStockPickers() {
  const stocks = minuteTimelinePickerStocks();
  ["locate", "exclude"].forEach(kind => renderMinuteTimelineStockPicker(kind, stocks));
}

function renderMinuteTimelineStockPicker(kind, stocks = minuteTimelinePickerStocks()) {
  const locate = kind === "locate", label = locate ? "定位" : "排除";
  if (locate) {
    const visible = new Set((state.minuteTimelineDayModel?.rows || []).map(row => row.stock.code));
    stocks = stocks.filter(stock => visible.has(stock.code));
  }
  const codes = new Set(locate ? state.minuteTimelineLocateCode ? [state.minuteTimelineLocateCode] : [] : state.minuteTimelineExcludeCodes || []);
  const selected = stocks.filter(stock => codes.has(stock.code));
  const names = selected.map(stock => stock.name).join("、");
  $("minute-timeline-" + kind + "-summary").textContent = codes.size ? locate ? names : `${selected.slice(0, 2).map(stock => stock.name).join("、")}${codes.size > 2 ? "等" : ""}（${codes.size} 只）` : locate ? "选择股票定位（单选）" : "不排除股票（可多选）";
  $("minute-timeline-" + kind + "-toggle").title = codes.size ? names : locate ? "选择一只股票，跳转并选中其时间轴节点" : "选择要排除的股票，可多选";
  $("minute-timeline-" + kind + "-count").textContent = `已选 ${codes.size} 只`;
  $("minute-timeline-" + kind + "-clear").disabled = !codes.size;
  const query = $(locate ? "minute-timeline-search" : "minute-timeline-exclude").value.trim().toUpperCase();
  const matches = stocks.filter(stock => !query || `${stock.code} ${stock.name} ${stock.initials}`.toUpperCase().includes(query));
  const list = $("minute-timeline-" + kind + "-options"), key = JSON.stringify(matches);
  const keys = state.minuteTimelinePickerKeys ||= {};
  if (keys[kind] !== key) {
    list.innerHTML = matches.map(stock => `<label class="minute-stock-option"><input type="${locate ? "radio" : "checkbox"}"${locate ? ' name="minute-timeline-locate-stock"' : ""} data-timeline-stock="${escapeHTML(stock.code)}" data-timeline-stock-mode="${kind}" aria-label="${label} ${escapeHTML(stock.name)} ${escapeHTML(stock.code)}"${codes.has(stock.code) ? " checked" : ""}><span><span>${escapeHTML(stock.name)}</span><small>${escapeHTML(stock.code)} · ${stock.inPool ? stock.boards ? `${numberValue(stock.boards)} 板` : "当日涨停池" : "当日池外"}</small></span></label>`).join("") || `<p class="minute-stock-picker-empty">${query ? "没有匹配的股票" : "当日暂无可选股票"}</p>`;
    list.scrollTop = 0;
    keys[kind] = key;
  }
  list.querySelectorAll("[data-timeline-stock]").forEach(input => { input.checked = codes.has(input.dataset.timelineStock); });
}

function changeMinuteTimelineStockSelection(kind, code, selected) {
  if (!["locate", "exclude"].includes(kind) || !/^\d{6}$/.test(code)) return;
  if (kind === "locate") {
    const row = state.minuteTimelineDayModel?.rows.find(row => row.stock.code === code);
    if (!row) return;
    const node = row.events.find(event => event.kind === "seal") || row.events[0];
    state.minuteTimelineLocateCode = code;
    state.minuteTimelineSelectedNode = node?.id || null;
    closeMinuteTimelineStockPickers();
    renderMinuteTimelineSelection();
    const list = $("minute-timeline-list"), scroller = list.querySelector(".minute-day-scroll");
    const lane = [...list.querySelectorAll(".minute-day-lane")].find(lane => lane.dataset.dayStock === code);
    const target = node ? [...(lane?.querySelectorAll(".minute-day-node") || [])].find(button => button.dataset.dayNode === node.id) : lane?.querySelector("button");
    if (node && scroller) {
      const width = scroller.clientWidth - (lane?.querySelector(".minute-day-stock")?.offsetWidth || 170) - 32;
      scroller.scrollLeft = Math.max(0, minuteTimelineDayPosition(node.time) / 100 * 241 * (state.minuteTimelinePitch || 120) - width / 3);
      syncMinuteTimelineScroll(scroller);
    }
    target?.focus({preventScroll: true});
    (target || lane)?.scrollIntoView({block: "center", inline: "nearest", behavior: "instant"});
    return;
  }
  const codes = new Set(state.minuteTimelineExcludeCodes || []);
  if (selected) codes.add(code); else codes.delete(code);
  state.minuteTimelineExcludeCodes = [...codes];
  renderMinuteTimeline();
}

function clearMinuteTimelineStockSelection(kind) {
  if (kind === "locate") {
    state.minuteTimelineLocateCode = null; state.minuteTimelineSelectedNode = null;
    renderMinuteTimelineSelection();
  } else {
    state.minuteTimelineExcludeCodes = [];
    renderMinuteTimeline();
  }
}

function closeMinuteTimelineStockPickers() {
  ["locate", "exclude"].forEach(kind => {
    $("minute-timeline-" + kind + "-popup").hidden = true;
    $("minute-timeline-" + kind + "-toggle").setAttribute("aria-expanded", "false");
  });
  state.minuteTimelinePickerOpen = null;
}

function toggleMinuteTimelineStockPicker(kind) {
  const open = $("minute-timeline-" + kind + "-popup").hidden;
  closeMinuteTimelineStockPickers();
  if (!open) return;
  $(kind === "locate" ? "minute-timeline-search" : "minute-timeline-exclude").value = "";
  renderMinuteTimelineStockPicker(kind);
  $("minute-timeline-" + kind + "-popup").hidden = false;
  $("minute-timeline-" + kind + "-toggle").setAttribute("aria-expanded", "true");
  state.minuteTimelinePickerOpen = kind;
  $(kind === "locate" ? "minute-timeline-search" : "minute-timeline-exclude").focus();
}

function minuteTimelineMetric(event) {
  return event.kind === "volume" ? `${numberValue(event.volume / 100)} 手 · ${numberValue(event.ratio, 1)} 倍` : event.price ? `${numberValue(event.price, 2)} 元` : "";
}

function minuteTimelineClock(event) {
  return event.time.length === 5 ? `${event.time}:00` : event.time;
}

function minuteTimelineEventOrder(a, b) {
  return minuteTimelineClock(a).localeCompare(minuteTimelineClock(b)) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id);
}

function toggleMinuteTimelineTags() {
  $("minute-timeline-list").setAttribute("data-show-tags", String($("minute-timeline-show-tags").checked === true));
}

function minuteTimelineTagsHTML(stock) {
  const profile = state.minuteTimelineData?.pool?.find(row => row.code === stock.code) || stock;
  return `<span class="stock-tags minute-timeline-tags" aria-label="${escapeHTML(stock.name)}标签">${stockTags(profile).map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</span>`;
}

function updateMinuteTimelineControls() {
  const busy = !!state.minuteTimelineCollecting, editable = state.meta?.capabilities?.edit_tags === true;
  const data = state.minuteTimelineData?.date === state.intradayDate ? state.minuteTimelineData : null;
  const coverage = data?.coverage, pending = data?.jobs?.length || 0;
  const inContent = editable && !!data && coverage?.total > 0 && coverage.analyzed === 0 && (busy || pending > 0);
  const collect = $("minute-timeline-collect"), stop = $("minute-timeline-stop");
  const target = $(inContent ? "minute-timeline-collection-actions" : "minute-timeline-actions");
  if (collect.parentElement !== target || stop.parentElement !== target) target.append(collect, stop);
  $("minute-timeline-data-gap").hidden = !inContent;
  $("minute-timeline-data-gap-message").textContent = busy || state.minuteLiveRefreshing ? "正在获取当日分时…" : "当日尚无分时数据，点击下方按钮采集。";
  collect.hidden = !editable;
  collect.disabled = busy || state.minuteLiveRefreshing || !pending;
  stop.hidden = !busy;
  $("minute-timeline-refresh").disabled = busy;
  $("minute-timeline-multiple").disabled = busy;
  $("minute-timeline-exclude-gem").disabled = busy || state.minuteTimelineData?.date !== state.intradayDate;
  ["locate", "exclude"].forEach(kind => { $("minute-timeline-" + kind + "-toggle").disabled = state.minuteTimelineData?.date !== state.intradayDate; });
  if (!busy) collect.textContent = `补齐当日分时${pending ? `（${pending} 只）` : ""}`;
  updateMinuteTimelineLiveStatus();
}

async function loadMinuteTimeline({quiet = false, refreshTimes = false} = {}) {
  const day = state.intradayDate;
  const generation = state.minuteTimelineGeneration = (state.minuteTimelineGeneration || 0) + 1;
  const current = () => generation === state.minuteTimelineGeneration && state.intradayDate === day && state.tab === "intraday";
  if (!day) return;
  $("minute-timeline-list").setAttribute("aria-busy", "true");
  if (!quiet || state.minuteTimelineData?.date !== day) {
    $("minute-timeline-list").innerHTML = loadingHTML();
    $("minute-timeline-coverage").textContent = "正在读取当日股票节点…";
  }
  try {
    const url = `/api/intraday/timeline?date=${encodeURIComponent(day)}&window=2&multiple=${encodeURIComponent($("minute-timeline-multiple").value || "3")}&exclude_gem=${$("minute-timeline-exclude-gem").checked === false ? "0" : "1"}`;
    const data = await request(url, "minute-timeline");
    if (!data || !current()) return;
    const sameDay = state.minuteTimelineData?.date === day;
    state.minuteTimelineData = data;
    renderMinuteTimeline({preserve: quiet && sameDay});
    const attempted = state.minuteTimelineTimesRequested ||= new Set();
    if (!data.provisional && state.meta?.capabilities?.edit_tags === true && data.time_coverage?.missing && (refreshTimes || !data.time_coverage.cached && !attempted.has(day))) {
      attempted.add(day);
      try {
        await request("/api/intraday/timeline/times", "minute-timeline-times", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({date: day, force: refreshTimes})});
        if (!current()) return;
        const enriched = await request(url, "minute-timeline");
        if (!enriched || !current()) return;
        state.minuteTimelineData = enriched;
        renderMinuteTimeline({preserve: true});
      } catch (error) {
        if (current() && refreshTimes) {
          $("minute-timeline-progress").hidden = false;
          $("minute-timeline-progress").textContent = `秒级封板时间暂未补齐：${error.message}；分钟记录按原精度展示。`;
        }
      }
    }
  } catch (error) {
    if (!current()) return;
    $("minute-timeline-coverage").textContent = `节点读取失败：${error.message}`;
    if (!quiet || state.minuteTimelineData?.date !== day) $("minute-timeline-list").innerHTML = emptyHTML("时间轴暂未读取成功", "请点击刷新节点重试。");
  } finally {
    if (current()) $("minute-timeline-list").setAttribute("aria-busy", "false");
  }
}

async function changeMinuteTimelineGemFilter() {
  updateURL();
  await loadMinuteTimeline();
  if (state.tab === "intraday" && state.minuteTimelineData?.date === state.intradayDate) renderMinuteCompareList();
}

function stopMinuteTimelineCollection(refresh = true) {
  const busy = state.minuteTimelineCollecting;
  state.minuteTimelineCollectGeneration = (state.minuteTimelineCollectGeneration || 0) + 1;
  state.minuteTimelineCollecting = false;
  state.minuteTimelineGeneration = (state.minuteTimelineGeneration || 0) + 1;
  state.requests["minute-timeline"]?.abort();
  state.requests["minute-timeline-times"]?.abort();
  Object.keys(state.requests).filter(channel => channel.startsWith("timeline-collect-")).forEach(channel => state.requests[channel]?.abort());
  updateMinuteTimelineControls();
  $("minute-timeline-progress").hidden = !busy || !refresh;
  if (busy && refresh) {
    $("minute-timeline-progress").textContent = "已停止启动新请求，已取得的数据保留在当天缓存。";
    if (state.tab === "intraday") loadMinuteTimeline({quiet: true});
  }
}

async function collectMinuteTimeline() {
  if (state.minuteTimelineCollecting || state.minuteLiveRefreshing || state.meta?.capabilities?.edit_tags !== true) return;
  const day = state.intradayDate, jobs = [...(state.minuteTimelineData?.date === day ? state.minuteTimelineData.jobs || [] : [])];
  if (!jobs.length) return;
  const generation = state.minuteTimelineCollectGeneration = (state.minuteTimelineCollectGeneration || 0) + 1;
  const current = () => generation === state.minuteTimelineCollectGeneration && state.intradayDate === day && state.tab === "intraday";
  state.minuteTimelineCollecting = true;
  $("minute-timeline-progress").hidden = false;
  let next = 0, done = 0, failed = 0;
  const progress = () => { $("minute-timeline-progress").textContent = `正在补齐 ${dateLabel(day)}：${done} / ${jobs.length} 只${failed ? ` · ${failed} 只未取得完整分时` : ""}`; };
  updateMinuteTimelineControls(); progress();
  await Promise.all(Array.from({length: Math.min(3, jobs.length)}, async (_, worker) => {
    while (current() && next < jobs.length) {
      const job = jobs[next++];
      try {
        const data = await request("/api/intraday/collect", `timeline-collect-${worker}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({date: day, code: job.code, force: job.force})});
        if (!current()) return;
        if (!data?.points?.length || data.status !== "ok") failed++;
        if (data?.stock) recordMinuteData(data);
      } catch { if (!current()) return; failed++; }
      done++; progress();
    }
  }));
  if (!current()) return;
  state.minuteTimelineCollecting = false;
  updateMinuteTimelineControls();
  $("minute-timeline-progress").textContent = `当日分时处理完成：${done} 只${failed ? ` · ${failed} 只未取得完整分时` : ""}，股票节点已更新。`;
  await loadMinuteTimeline({quiet: true});
}

async function openMinuteTimelineNode(code, clock, peer = "") {
  const day = state.intradayDate, dateGeneration = state.intradayGeneration;
  const generation = state.minuteTimelineNavigation = (state.minuteTimelineNavigation || 0) + 1;
  const current = () => generation === state.minuteTimelineNavigation && day === state.intradayDate && dateGeneration === state.intradayGeneration && state.tab === "intraday" && state.intradayCode === code;
  if (peer && peer !== code) clearMinuteComparisons();
  await loadMinuteStock(code);
  if (!current() || state.minuteDetail?.stock.code !== code || state.minuteDetail?.date !== day) return;
  if (peer && peer !== code) await selectMinuteComparison(peer, true);
  if (!current() || !state.minuteDetail?.points.length) return;
  $("minute-chart").querySelector(".minute-svg")?.focus({preventScroll: true});
  if (clock.slice(0, 5) === "09:25" && state.minuteDetail.auction?.points?.length) showMinuteAuctionPoint();
  else {
    const target = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) + Number(clock.slice(6, 8) || 0) / 60;
    let nearest = 0;
    state.minuteDetail.points.forEach((point, index) => { const minute = value => Number(value.time.slice(0, 2)) * 60 + Number(value.time.slice(3, 5)); if (Math.abs(minute(point) - target) < Math.abs(minute(state.minuteDetail.points[nearest]) - target)) nearest = index; });
    showMinutePoint(nearest);
  }
  $("minute-chart").scrollIntoView?.({block: "center", behavior: "smooth"});
}

function openMethod() { if (!$("method-dialog").open) $("method-dialog").showModal(); }

function validSiteLink(value) {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function renderSiteLinks(links) {
  document.querySelectorAll("[data-site-link]").forEach(link => {
    const url = validSiteLink(links[link.dataset.siteLink]);
    if (url) { link.href = url; link.removeAttribute("aria-disabled"); }
    else { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); }
  });
}

async function loadSiteLinks() {
  const generation = (state.siteLinksRequest || 0) + 1;
  state.siteLinksRequest = generation;
  try {
    const data = await request("/api/site-links", "site-links");
    if (state.siteLinksRequest === generation && data?.links && typeof data.links === "object" && !Array.isArray(data.links)) renderSiteLinks(data.links);
  } catch { /* Keep the current links while their configuration is unavailable. */ }
}

async function openAnnouncement() {
  const dialog = $("announcement-dialog");
  if (!dialog.open) dialog.showModal();
  const generation = (state.announcementRequest || 0) + 1;
  state.announcementRequest = generation;
  $("announcement-title").textContent = "公告";
  $("announcement-content").textContent = "正在读取公告…";
  $("announcement-content").classList.remove("empty");
  $("announcement-updated").hidden = true;
  $("retry-announcement").hidden = true;
  try {
    const data = await request("/api/announcement", "announcement");
    if (!data || state.announcementRequest !== generation || !dialog.open) return;
    const notice = data.announcement || {};
    const enabled = notice.enabled === true && typeof notice.content === "string" && notice.content.trim();
    $("announcement-title").textContent = enabled && typeof notice.title === "string" && notice.title.trim() ? notice.title : "公告";
    $("announcement-content").textContent = enabled ? notice.content : "暂无公告";
    $("announcement-content").classList.toggle("empty", !enabled);
    $("announcement-updated").hidden = !enabled || !notice.updated_at;
    $("announcement-updated").textContent = enabled && notice.updated_at ? `更新于 ${String(notice.updated_at).replace("T", " ").slice(0, 16)}` : "";
  } catch {
    if (state.announcementRequest !== generation || !dialog.open) return;
    $("announcement-content").textContent = "公告暂时无法读取，请稍后重试。";
    $("retry-announcement").hidden = false;
  }
}

$("announcement-button").addEventListener("click", openAnnouncement);
$("retry-announcement").addEventListener("click", openAnnouncement);
["close-announcement", "confirm-announcement"].forEach(id => $(id).addEventListener("click", () => $("announcement-dialog").close()));
$("announcement-dialog").addEventListener("close", () => { state.requests.announcement?.abort(); });
$("announcement-dialog").addEventListener("click", event => {
  if (event.target !== $("announcement-dialog")) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
$("method-nav").addEventListener("click", openMethod);
["close-method", "confirm-method"].forEach((id) => $(id).addEventListener("click", () => $("method-dialog").close()));
$("method-dialog").addEventListener("click", (event) => { if (event.target === $("method-dialog")) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$("retry-button").addEventListener("click", () => state.retry?.());
$("trade-date").addEventListener("change", changeQueryDate);
$("latest-date").addEventListener("click", () => { $("trade-date").value = state.meta?.query_dates?.at(-1) || state.meta?.latest_date || ""; changeQueryDate(); });
["prev-date", "next-date"].forEach((id) => $(id).addEventListener("click", () => { const dates = state.meta?.query_dates || state.meta?.dates || [], current = $("trade-date").value; const target = id === "prev-date" ? [...dates].reverse().find((date) => date < current) : dates.find((date) => date > current); if (target) { $("trade-date").value = target; changeQueryDate(); } }));
$("nav-search").addEventListener("click", () => {
  if (!["date", "stock"].includes(state.tab)) { if (state.selectedStock) loadStock({remember: false}); else loadDate(); }
  $("search-workspace").scrollIntoView({ block: "center" }); $("stock-search").focus();
});
$("nav-blacklist").addEventListener("click", () => { loadBlacklist(); $("main").scrollIntoView({block: "start"}); });
$("nav-tags").addEventListener("click", () => { loadTagManager(); $("main").scrollIntoView({block: "start"}); });
bindTagManager();
bindTagBatch();
$("nav-intraday").addEventListener("click", () => { loadIntraday(); $("main").scrollIntoView({block: "start"}); });
$("minute-date").addEventListener("change", () => changeMinuteDate());
$("minute-prev-date").addEventListener("click", () => navigateMinuteDate("previous"));
$("minute-next-date").addEventListener("click", () => navigateMinuteDate("next"));
$("minute-latest-date").addEventListener("click", () => navigateMinuteDate("latest"));
$("minute-refresh").addEventListener("click", () => loadIntraday());
$("minute-timeline-refresh").addEventListener("click", () => loadMinuteTimeline({refreshTimes: true}));
$("minute-timeline-exclude-gem").addEventListener("change", changeMinuteTimelineGemFilter);
$("minute-timeline-show-tags").addEventListener("change", toggleMinuteTimelineTags);
$("minute-timeline-collect").addEventListener("click", collectMinuteTimeline);
$("minute-timeline-stop").addEventListener("click", () => stopMinuteTimelineCollection());
$("minute-timeline-multiple").addEventListener("change", () => loadMinuteTimeline());
["minute-timeline-group", "minute-timeline-kind"].forEach(id => $(id).addEventListener("change", () => renderMinuteTimeline()));
["locate", "exclude"].forEach(kind => {
  $("minute-timeline-" + kind + "-toggle").addEventListener("click", () => toggleMinuteTimelineStockPicker(kind));
  $(kind === "locate" ? "minute-timeline-search" : "minute-timeline-exclude").addEventListener("input", () => renderMinuteTimelineStockPicker(kind));
  $("minute-timeline-" + kind + "-clear").addEventListener("click", () => clearMinuteTimelineStockSelection(kind));
  $("minute-timeline-" + kind + "-options").addEventListener("change", event => {
    const input = event.target.closest("[data-timeline-stock]");
    if (input) changeMinuteTimelineStockSelection(kind, input.dataset.timelineStock, input.checked);
  });
  if (kind === "locate") $("minute-timeline-locate-options").addEventListener("click", event => {
    const input = event.target.closest("[data-timeline-stock]");
    if (input?.dataset.timelineStock === state.minuteTimelineLocateCode) changeMinuteTimelineStockSelection(kind, input.dataset.timelineStock, true);
  });
});
document.addEventListener("click", event => { if (state.minuteTimelinePickerOpen && !event.target.closest("[data-timeline-stock-picker]")) closeMinuteTimelineStockPickers(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && state.minuteTimelinePickerOpen) {
    const kind = state.minuteTimelinePickerOpen;
    closeMinuteTimelineStockPickers();
    $("minute-timeline-" + kind + "-toggle").focus();
    event.preventDefault();
  }
});
$("minute-timeline-list").addEventListener("change", event => {
  if (event.target.id === "minute-day-sort") changeMinuteTimelineSort(event.target.value);
});
$("minute-timeline-list").addEventListener("click", event => {
  const node = event.target.closest("[data-day-node]");
  if (node) { selectMinuteTimelineDayNode(node.dataset.dayNode); return; }
  const zoom = event.target.closest("[data-day-zoom]");
  if (zoom) { zoomMinuteTimelineDay(Number(zoom.dataset.dayZoom)); return; }
  const pan = event.target.closest("[data-day-pan]");
  if (pan) { panMinuteTimelineDay(Number(pan.dataset.dayPan)); return; }
  if (event.target.closest("[data-day-jump]")) { jumpMinuteTimelineDay(); return; }
  if (event.target.closest("[data-day-clear]")) {
    const previous = state.minuteTimelineSelectedNode;
    state.minuteTimelineSelectedNode = null; state.minuteTimelineLocateCode = null; renderMinuteTimelineSelection();
    [...$("minute-timeline-list").querySelectorAll(".minute-day-node")].find(button => button.dataset.dayNode === previous)?.focus({preventScroll: true});
    return;
  }
  const button = event.target.closest("[data-timeline-code]");
  if (button) openMinuteTimelineNode(button.dataset.timelineCode, button.dataset.timelineTime, button.dataset.timelinePeer || "");
});
["pointerover", "focusin"].forEach(type => $("minute-timeline-list").addEventListener(type, event => {
  const button = event.target.closest(".minute-day-node");
  if (button) highlightMinuteTimelineGuide(button.dataset.dayNode);
}));
["pointerout", "focusout"].forEach(type => $("minute-timeline-list").addEventListener(type, event => {
  if (event.target.closest(".minute-day-node") && !event.relatedTarget?.closest?.(".minute-day-node")) highlightMinuteTimelineGuide();
}));
$("minute-timeline-list").addEventListener("keydown", event => {
  const button = event.target.closest(".minute-day-node"), model = state.minuteTimelineDayModel;
  if (!button || !model || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const rows = model.rows.filter(row => row.events.length);
  const selected = model.nodes.get(button.dataset.dayNode), rowIndex = rows.findIndex(row => row.stock.code === selected?.code);
  if (rowIndex < 0) return;
  event.preventDefault();
  let row = rows[rowIndex], target;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    row = rows[Math.max(0, Math.min(rows.length - 1, rowIndex + (event.key === "ArrowUp" ? -1 : 1)))];
    target = row.events.reduce((best, node) => Math.abs(minuteTimelineDayPosition(node.time) - minuteTimelineDayPosition(selected.time)) < Math.abs(minuteTimelineDayPosition(best.time) - minuteTimelineDayPosition(selected.time)) ? node : best);
  } else {
    const index = row.events.findIndex(node => node.id === selected.id);
    target = row.events[event.key === "Home" ? 0 : event.key === "End" ? row.events.length - 1 : Math.max(0, Math.min(row.events.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)))];
  }
  selectMinuteTimelineDayNode(target.id);
  const next = [...$("minute-timeline-list").querySelectorAll(".minute-day-node")].find(node => node.dataset.dayNode === target.id);
  next?.focus({preventScroll: true});
  next?.scrollIntoView({block: "nearest", inline: "nearest"});
});
$("minute-show-average").checked = false;
$("minute-show-average").addEventListener("change", toggleMinuteAverage);
$("minute-compare-search").addEventListener("input", () => { state.minuteCompareLimit = 150; renderMinuteCompareList(); });
$("minute-compare-list").addEventListener("click", event => { if (event.target.closest("[data-minute-compare-more]")) { const top = $("minute-compare-list").scrollTop; state.minuteCompareLimit = (state.minuteCompareLimit || 150) + 150; renderMinuteCompareList(); $("minute-compare-list").scrollTop = top; } });
$("minute-compare-list").addEventListener("change", event => {
  const input = event.target.closest("[data-minute-compare]");
  if (input) selectMinuteComparison(input.dataset.minuteCompare, input.checked);
});
$("minute-compare-clear").addEventListener("click", clearMinuteComparisons);
$("minute-search").addEventListener("input", () => {
  state.minuteListLimit = 150;
  renderMinuteList();
});
$("minute-stock-list").addEventListener("click", event => {
  if (event.target.closest("[data-minute-more]")) { const top = $("minute-stock-list").scrollTop; state.minuteListLimit = (state.minuteListLimit || 150) + 150; renderMinuteList(); $("minute-stock-list").scrollTop = top; return; }
  const button = event.target.closest("[data-minute-code]");
  if (button) loadMinuteStock(button.dataset.minuteCode);
});
$("minute-stock-list").addEventListener("keydown", event => {
  if (!event.target.closest("[data-minute-code]") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = minuteRows();
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.findIndex(row => row.code === state.intradayCode);
  const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  if (index >= (state.minuteListLimit || 150)) { state.minuteListLimit = index + 1; renderMinuteList(); }
  loadMinuteStock(rows[index].code);
  $("minute-stock-list").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  $("minute-stock-list").querySelector('[aria-pressed="true"]')?.scrollIntoView({block: "nearest"});
});
$("minute-stock-history").addEventListener("click", () => {
  const stock = state.minuteDetail?.stock;
  if (stock) chooseStock({code: stock.code, name: stock.name});
});
$("minute-chart").addEventListener("pointermove", event => {
  const svg = event.target.closest(".minute-svg,.minute-volume-svg"), points = state.minuteDetail?.points;
  if (!svg || !points?.length) return;
  const rect = svg.getBoundingClientRect(), px = (event.clientX - rect.left) / rect.width * 1000;
  if (px < 155) { showMinuteAuctionPoint(); return; }
  const slot = state.minuteChartScale.slotAt(px);
  let nearest = 0;
  points.forEach((point, index) => { if (Math.abs(point.slot - slot) < Math.abs(points[nearest].slot - slot)) nearest = index; });
  showMinutePoint(nearest);
});
$("minute-chart").addEventListener("click", event => {
  const button = event.target.closest("[data-minute-volume-scale]");
  if (!button || state.minuteLoading) return;
  state.minuteVolumeScale = button.dataset.minuteVolumeScale;
  refreshMinuteComparisonChart();
  $("minute-chart").querySelector(`[data-minute-volume-scale="${state.minuteVolumeScale}"]`)?.focus({preventScroll: true});
});
$("minute-chart").addEventListener("focusin", event => { if (event.target.matches(".minute-svg")) showMinutePoint(state.minutePointIndex || 0); });
$("minute-chart").addEventListener("keydown", event => {
  if (!event.target.matches(".minute-svg") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !state.minuteDetail?.points.length) return;
  event.preventDefault();
  if ((event.key === "Home" && state.minuteDetail.auction?.points.length) || (event.key === "ArrowLeft" && !state.minutePointIndex)) { showMinuteAuctionPoint(); return; }
  if (state.minuteHoverMode === "auction" && event.key === "ArrowRight") { showMinutePoint(0); return; }
  const index = event.key === "Home" ? 0 : event.key === "End" ? state.minuteDetail.points.length - 1 : (state.minutePointIndex || 0) + (event.key === "ArrowRight" ? 1 : -1);
  showMinutePoint(index);
});
$("blacklist-refresh").addEventListener("click", loadBlacklist);
$("blacklist-add-form").addEventListener("submit", event => { event.preventDefault(); changeBlacklist("add"); });
$("blacklist-search").addEventListener("input", () => {
  state.blacklistSelected = null;
  state.blacklistSuggestions = [];
  state.requests["blacklist-search"]?.abort();
  hideBlacklistSuggestions();
  blacklistError();
  $("blacklist-feedback").textContent = "";
});
$("blacklist-search").addEventListener("input", debounce(searchBlacklistStocks));
$("blacklist-search").addEventListener("keydown", event => {
  if (event.key === "Escape") { hideBlacklistSuggestions(); return; }
  const rows = state.blacklistSuggestions || [];
  if ($("blacklist-suggestions").hidden || !rows.length) return;
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    state.blacklistSuggestionIndex = ((state.blacklistSuggestionIndex ?? -1) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    $("blacklist-suggestions").querySelectorAll("[role=option]").forEach((button, index) => { const active = index === state.blacklistSuggestionIndex; button.classList.toggle("focused", active); button.setAttribute("aria-selected", String(active)); });
    $("blacklist-search").setAttribute("aria-activedescendant", `blacklist-suggestion-${state.blacklistSuggestionIndex}`);
    $("blacklist-suggestions").querySelector('[aria-selected="true"]')?.scrollIntoView({block: "nearest"});
  } else if (event.key === "Enter" && state.blacklistSuggestionIndex >= 0) { event.preventDefault(); selectBlacklistStock(rows[state.blacklistSuggestionIndex]); }
});
$("blacklist-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-blacklist-suggestion]"); if (button) selectBlacklistStock(state.blacklistSuggestions[Number(button.dataset.blacklistSuggestion)]); });
$("blacklist-table-area").addEventListener("click", event => {
  const remove = event.target.closest("[data-blacklist-remove]");
  if (remove) { changeBlacklist("remove", remove.dataset.blacklistRemove); return; }
  const stock = event.target.closest("[data-blacklist-code]");
  if (stock) chooseStock({code: stock.dataset.blacklistCode, name: stock.dataset.blacklistName});
});
document.addEventListener("click", event => { if (!event.target.closest("#blacklist-add-form")) hideBlacklistSuggestions(); });
$("back-to-date").addEventListener("click", returnToDate);
$("edit-stock-profile-tags").addEventListener("click", () => {
  if (state.selectedStock) openTagEditor(state.selectedStock.code);
});
$("board-options").addEventListener("click", (event) => { const button = event.target.closest("[data-boards]"); if (button && button.dataset.boards !== state.boards) { state.boards = button.dataset.boards; loadDate(); } });
$("date-table-area").addEventListener("click", (event) => { const button = event.target.closest("[data-stock-code]"); if (button) chooseStock({ code: button.dataset.stockCode, name: button.dataset.stockName }); });
$("date-table-area").addEventListener("click", (event) => {
  const button = event.target.closest("[data-industry-scroll]");
  const board = $("date-table-area").querySelector(".industry-board");
  if (button && board) board.scrollBy({ left: Number(button.dataset.industryScroll) * (board.clientWidth - 25), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
});
document.querySelectorAll("[data-grouping]").forEach(button => button.addEventListener("click", () => {
  if (state.grouping === button.dataset.grouping) return;
  state.grouping = button.dataset.grouping;
  if (state.dateData) renderDate(state.dateData);
  updateURL();
}));
$("exclude-st").addEventListener("change", event => {
  state.excludeST = event.target.checked;
  state.dateData = null;
  loadDate();
});
$("exclude-gem").addEventListener("change", event => {
  state.excludeGEM = event.target.checked;
  state.dateData = null;
  loadDate();
});
$("date-table-area").addEventListener("click", event => {
  const button = event.target.closest("[data-edit-stock-tags]");
  if (button) openTagEditor(button.dataset.editStockTags);
});
["close-tags", "cancel-tags"].forEach(id => $(id).addEventListener("click", closeTagEditor));
$("tag-dialog").addEventListener("cancel", event => { if (state.tagSaving || state.tagBlacklistSaving) event.preventDefault(); });
$("tag-blacklist").addEventListener("change", changeTagBlacklist);
$("tag-editor-list").addEventListener("input", event => {
  if (!event.target.matches("[data-tag-index]")) return;
  const index = Number(event.target.dataset.tagIndex), parents = state.tagDraft[index].split("/").slice(0, -1);
  state.tagDraft[index] = [...parents, event.target.value].join("/");
  state.tagUseSource = false;
  updateTagEditorPaths();
});
$("tag-editor-list").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-tag]");
  if (button) { state.tagDraft.splice(Number(button.dataset.removeTag), 1); state.tagUseSource = false; renderTagEditor(); }
});
$("tag-new").addEventListener("input", onTagSuggestionInput);
$("tag-new").addEventListener("focus", () => { state.tagSuggestionsActive = true; renderTagSuggestions(); });
$("tag-new").addEventListener("keydown", onTagSuggestionKeydown);
$("tag-new").addEventListener("blur", event => { if (!$("tag-new-suggestions").contains(event.relatedTarget)) hideTagSuggestions(); });
$("tag-new-suggestions").addEventListener("mousedown", event => event.preventDefault());
$("tag-new-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-existing-tag-index]"); if (button) chooseExistingTag(Number(button.dataset.existingTagIndex)); });
$("tag-dialog").addEventListener("close", () => { state.requests["tag-editor-catalog"]?.abort(); hideTagSuggestions(); });
$("tag-dialog").addEventListener("scroll", positionTagSuggestions, true);
window.addEventListener("resize", positionTagSuggestions);
document.addEventListener("pointerdown", event => { if (!event.target.closest(".tag-new-picker")) hideTagSuggestions(); });
$("add-tag").addEventListener("click", () => { if (state.tagEditorData) addTagDraft(); });
$("restore-source-tags").addEventListener("click", () => {
  if (!state.tagEditorData) return;
  state.tagDraft = defaultEditorTags(state.tagEditorData);
  state.tagUseSource = true;
  $("tag-new").value = "";
  renderTagEditor();
});
$("tag-editor-form").addEventListener("submit", saveTagEditor);
["close-stock-note", "cancel-stock-note"].forEach(id => $(id).addEventListener("click", finishStockNoteEditor));
$("retry-stock-note").addEventListener("click", () => openStockNoteEditor(state.noteEditingCode));
$("stock-note-content").addEventListener("input", updateStockNoteControls);
$("stock-note-time").addEventListener("input", updateStockNoteControls);
$("add-stock-note-date").addEventListener("click", () => expandStockNoteDate());
$("remove-stock-note-date").addEventListener("click", () => removeStockNoteDate());
$("stock-note-dialog").addEventListener("keydown", stockNoteKeydown);
$("stock-note-history").addEventListener("input", scheduleStockNoteAutosave);
$("stock-note-history").addEventListener("change", scheduleStockNoteAutosave);
$("stock-note-dialog").addEventListener("compositionstart", () => { state.noteComposing = true; clearTimeout(state.noteAutosaveTimer); });
$("stock-note-dialog").addEventListener("compositionend", event => {
  state.noteComposing = false;
  if (event.target.closest("[data-note-id]")) scheduleStockNoteAutosave();
});
$("stock-note-history").addEventListener("click", event => {
  const date = event.target.closest("[data-note-add-date]");
  if (date) expandStockNoteDate(Number(date.dataset.noteAddDate));
  const removeDate = event.target.closest("[data-note-remove-date]");
  if (removeDate) removeStockNoteDate(Number(removeDate.dataset.noteRemoveDate));
  const remove = event.target.closest("[data-delete-note]");
  if (remove) changeStockNoteEntryEditor(event, Number(remove.dataset.deleteNote), "delete");
});
$("undo-stock-note").addEventListener("click", event => { if (state.noteUndoId) changeStockNoteEntryEditor(event, state.noteUndoId, "restore"); });
for (const container of [$("date-table-area"), $("stock-profile-note"), $("minute-stock-note")]) {
  container.addEventListener("click", event => {
    const button = event.target.closest("[data-edit-stock-note]");
    if (button) openStockNoteEditor(button.dataset.editStockNote);
  });
  for (const name of ["pointerover", "focusin"]) container.addEventListener(name, event => {
    const button = event.target.closest(".stock-note-button");
    if (button && !button.contains(event.relatedTarget)) showStockNoteTooltip(button);
  });
  for (const name of ["pointerout", "focusout"]) container.addEventListener(name, event => {
    const button = event.target.closest(".stock-note-button");
    if (button && !button.contains(event.relatedTarget)) scheduleStockNoteTooltipHide();
  });
  new MutationObserver(() => {
    if (state.noteTooltipAnchor && !state.noteTooltipAnchor.isConnected) hideStockNoteTooltip();
  }).observe(container, {childList: true, subtree: true});
}
for (const name of ["pointerenter", "focusin"]) $("stock-note-tooltip").addEventListener(name, () => clearTimeout(state.noteTooltipTimer));
for (const name of ["pointerleave", "focusout"]) $("stock-note-tooltip").addEventListener(name, scheduleStockNoteTooltipHide);
document.addEventListener("scroll", event => { if (!$("stock-note-tooltip").contains(event.target)) hideStockNoteTooltip(); }, true);
document.addEventListener("keydown", event => { if (event.key === "Escape") hideStockNoteTooltip(); });
window.addEventListener("resize", hideStockNoteTooltip);
window.addEventListener("resize", resizeStockNoteContents);
for (const name of ["pointerover", "focusin"]) document.addEventListener(name, event => {
  const button = event.target.closest("[data-shareholder-code]");
  if (button && !button.contains(event.relatedTarget)) showShareholderTooltip(button);
});
for (const name of ["pointerout", "focusout"]) document.addEventListener(name, event => {
  const button = event.target.closest("[data-shareholder-code]");
  if (button && !button.contains(event.relatedTarget)) scheduleShareholderHide();
});
document.addEventListener("click", event => {
  const icon = event.target.closest("[data-shareholder-code]");
  if (icon) { event.preventDefault(); toggleShareholderTooltip(icon); return; }
  if (event.target.closest("[data-shareholder-info]")) { openShareholderInfo(); return; }
  if (event.target.closest("#shareholder-info-dialog")) return;
  if (event.target.closest("[data-shareholder-more]") && state.shareholderData) {
    state.shareholderLimit += 50;
    const tooltip = $("shareholder-tooltip"), top = tooltip.scrollTop;
    tooltip.innerHTML = renderShareholderTooltip(state.shareholderData, state.shareholderLimit);
    tooltip.scrollTop = top;
    tooltip.focus({preventScroll: true});
    clearTimeout(state.shareholderTimer);
    return;
  }
  const peer = event.target.closest("[data-shareholder-peer]");
  if (peer) {
    hideShareholderTooltip();
    chooseStock({code: peer.dataset.shareholderPeer, name: peer.dataset.peerName});
  } else if (!event.target.closest("#shareholder-tooltip")) hideShareholderTooltip();
});
for (const name of ["pointerenter", "focusin"]) $("shareholder-tooltip").addEventListener(name, () => clearTimeout(state.shareholderTimer));
for (const name of ["pointerleave", "focusout"]) $("shareholder-tooltip").addEventListener(name, scheduleShareholderHide);
$("shareholder-tooltip").addEventListener("change", event => {
  const input = event.target.closest("[data-shareholder-block-type]");
  if (!input || !state.shareholderData) return;
  const tooltip = $("shareholder-tooltip"), type = input.dataset.shareholderBlockType;
  state.shareholderBlockedTypes.set(type, input.checked);
  syncShareholderAlertIcons();
  try { localStorage.setItem("limit-up-archive.shareholder-blocked-types.v1", JSON.stringify([...state.shareholderBlockedTypes])); } catch {}
  state.shareholderLimit = 50;
  tooltip.innerHTML = renderShareholderTooltip(state.shareholderData);
  tooltip.scrollTop = 0;
  [...tooltip.querySelectorAll("[data-shareholder-block-type]")].find(item => item.dataset.shareholderBlockType === type)?.focus({preventScroll: true});
  clearTimeout(state.shareholderTimer);
  tooltip.style.maxHeight = `${Math.min(460, window.innerHeight - tooltip.getBoundingClientRect().top - 12)}px`;
});
document.addEventListener("scroll", event => { if (!$("shareholder-tooltip").contains(event.target) && !$("shareholder-info-dialog").contains(event.target)) hideShareholderTooltip(); }, true);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && $("shareholder-info-dialog").open) {
    event.preventDefault();
    $("shareholder-info-dialog").close();
    return;
  }
  const icon = event.target.closest("[data-shareholder-code]");
  if (icon && event.key === "ArrowDown") {
    event.preventDefault();
    showShareholderTooltip(icon).then(() => {
      if (state.shareholderAnchor === icon) $("shareholder-tooltip").focus({preventScroll: true});
    });
  }
  if (event.key === "Escape" && state.shareholderAnchor) {
    const anchor = state.shareholderAnchor;
    hideShareholderTooltip();
    // Restoring focus must not trigger a new popup.
    anchor.focus({preventScroll: true});
    hideShareholderTooltip();
  }
});
window.addEventListener("resize", hideShareholderTooltip);
$("close-shareholder-info").addEventListener("click", () => $("shareholder-info-dialog").close());
$("shareholder-info-dialog").addEventListener("click", event => {
  const dialog = $("shareholder-info-dialog");
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
new MutationObserver(() => {
  if (state.shareholderAnchor && (!state.shareholderAnchor.isConnected || state.shareholderAnchor.getClientRects().length === 0)) hideShareholderTooltip();
}).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"]});
$("stock-note-form").addEventListener("submit", saveStockNoteEditor);
$("stock-note-dialog").addEventListener("cancel", event => { event.preventDefault(); finishStockNoteEditor(); });
$("stock-note-dialog").addEventListener("click", event => {
  if (event.target !== $("stock-note-dialog")) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) finishStockNoteEditor();
});
$("date-table-area").addEventListener("scroll", updateIndustryNavigation, true);
window.addEventListener("resize", debounce(updateIndustryNavigation, 100));
document.addEventListener("wheel", containRelationWheel, {passive: false});
$("relation-height").addEventListener("input", event => {
  const height = Number(event.target.value);
  if (height >= 600 && height <= 1600) applyRelationHeight(height);
});
$("relation-height").addEventListener("change", event => applyRelationHeight(event.target.value));
$("reset-relation-height").addEventListener("click", () => applyRelationHeight(880));
$("relation-exclude-st").addEventListener("change", setRelationFilters);
$("relation-exclude-gem").addEventListener("change", setRelationFilters);
$("relation-exclude-latest").addEventListener("change", setRelationFilters);
$("stock-query-form").addEventListener("submit", (event) => { event.preventDefault(); runQuery(); });
$("stock-search").addEventListener("input", () => {
  $("stock-search").setCustomValidity("");
  state.selectedStock = null;
  state.suggestions = [];
  state.suggestionsQuery = "";
  state.requests.search?.abort();
  state.requests["stock-resolve"]?.abort();
  state.requests.stock?.abort();
  state.stockGeneration = (state.stockGeneration || 0) + 1;
  $("stock-query-button").disabled = false;
  if (!$("stock-search").value.trim()) returnToDate();
});
$("stock-search").addEventListener("input", debounce(searchStocks));
$("stock-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { hideSuggestions(); return; }
  if (["ArrowDown", "ArrowUp"].includes(event.key) && !$("stock-suggestions").hidden && state.suggestions.length) {
    event.preventDefault(); const count = Math.min(15, state.suggestions.length); state.suggestionIndex = (state.suggestionIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    $("stock-suggestions").querySelectorAll("[role=option]").forEach((button, index) => { button.classList.toggle("focused", index === state.suggestionIndex); button.setAttribute("aria-selected", String(index === state.suggestionIndex)); });
    $("stock-search").setAttribute("aria-activedescendant", `suggestion-${state.suggestionIndex}`); $("stock-suggestions").querySelector(`#suggestion-${state.suggestionIndex}`)?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && state.suggestionIndex >= 0 && !$("stock-suggestions").hidden) { event.preventDefault(); chooseStock(state.suggestions[state.suggestionIndex]); }
});
$("stock-suggestions").addEventListener("click", (event) => { const button = event.target.closest("[data-suggestion]"); if (button) chooseStock(state.suggestions[Number(button.dataset.suggestion)]); });
$("recent-stock-list").addEventListener("click", event => {
  const button = event.target.closest("[data-recent-code]");
  if (button) chooseStock({code: button.dataset.recentCode, name: button.dataset.recentName});
});
window.addEventListener("storage", event => {
  if (event.key === RECENT_STOCKS_KEY || event.key === null) {
    state.recentStocks = readRecentStocks();
    renderRecentStocks();
  }
});
document.addEventListener("click", (event) => { if (!event.target.closest(".stock-picker, #shareholder-tooltip, #shareholder-info-dialog")) hideSuggestions(); });
$("stock-relations").addEventListener("input", event => {
  if (event.target.id !== "relation-peer-search") return;
  state.relationQuery = event.target.value;
  renderPeerSelection();
});
$("stock-relations").addEventListener("keydown", event => {
  const button = event.target.closest("[data-select-peer]");
  if (!button || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = filteredRelationPeers();
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.findIndex(peer => peer.code === state.relationPeerCode);
  const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  state.relationPeerCode = rows[index].code;
  renderPeerSelection();
  $("relation-peer-list").querySelector('[aria-pressed="true"]')?.scrollIntoView({block: "nearest"});
});
function handleRelationClick(event) {
  if (!state.relationships) return;
  if (event.target.closest("[data-retry-comparison]")) { loadPeerComparison({retry: true}); return; }
  const sort = event.target.closest("[data-relation-sort]");
  if (sort && setRelationSort(sort.dataset.relationSort)) {
    $("relation-peer-sort").innerHTML = relationSortButtonsHTML();
    $("relation-sort-note").textContent = relationSortNote();
    renderPeerSelection({resetScroll: true});
    $("relation-peer-sort").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
    return;
  }
  const peer = event.target.closest("[data-select-peer]");
  if (peer) { state.relationPeerCode = peer.dataset.selectPeer; renderPeerSelection(); return; }
  const stock = event.target.closest("[data-relation-code]");
  if (stock) {
    chooseStock({ code: stock.dataset.relationCode, name: stock.dataset.relationName });
    $("search-workspace").scrollIntoView({ block: "start" });
    return;
  }
  const day = event.target.closest("[data-relation-date]");
  if (day) { event.preventDefault(); $("trade-date").value = day.dataset.relationDate; returnToDate(); $("search-workspace").scrollIntoView({ block: "start" }); }
}
$("stock-relations").addEventListener("click", handleRelationClick);
$("stock-cycles").addEventListener("click", handleRelationClick);
$("stock-chart").addEventListener("click", handleRelationClick);

async function restoreFromURL({remember = false} = {}) {
  state.requests.search?.abort();
  state.requests["stock-resolve"]?.abort();
  state.stockGeneration = (state.stockGeneration || 0) + 1;
  state.suggestions = [];
  state.suggestionsQuery = "";
  hideSuggestions();
  $("stock-search").setCustomValidity("");
  const params = new URLSearchParams(location.search);
  state.grouping = ["region", "pinyin", "code"].includes(params.get("layout")) ? params.get("layout") : "industry";
  state.excludeST = params.get("exclude_st") === "1";
  $("exclude-st").checked = state.excludeST;
  state.excludeGEM = params.get("exclude_gem") === "1";
  $("exclude-gem").checked = state.excludeGEM;
  state.relationExcludeST = params.get("relation_exclude_st") === "1";
  $("relation-exclude-st").checked = state.relationExcludeST;
  state.relationExcludeGEM = params.get("relation_exclude_gem") === "1";
  $("relation-exclude-gem").checked = state.relationExcludeGEM;
  state.relationExcludeLatest = params.get("relation_exclude_latest") === "1";
  $("relation-exclude-latest").checked = state.relationExcludeLatest;
  $("trade-date").value = params.get("date") || state.meta.query_dates?.at(-1) || state.meta.latest_date || state.meta.dates.at(-1) || "";
  const boards = Number(params.get("boards"));
  state.boards = Number.isSafeInteger(boards) && boards > 0 ? String(boards) : "";
  const view = params.get("view") === "tags" ? "tags" : params.get("view") === "intraday" ? "intraday" : params.get("view") === "blacklist" ? "blacklist" : params.get("code") ? "stock" : "date";
  if (view === "tags") state.tagManagerName = params.get("tag") || "";
  if (view === "intraday") {
    $("minute-timeline-exclude-gem").checked = params.get("timeline_gem") !== "1";
    state.intradayDate = params.get("date") || "";
    state.intradayCode = params.get("minute_code") || "";
    state.minuteCompareCodes = [...new Set((params.get("minute_compare") || "").split(",").filter(code => /^\d{6}$/.test(code)))];
    $("minute-search").value = "";
    $("minute-compare-search").value = "";
  }
  state.selectedStock = view === "stock" ? {code: params.get("code"), name: ""} : null;
  $("stock-search").value = state.selectedStock?.code || "";
  renderBoardOptions();
  updateDateNavigation();
  setView(view, false);
  // Initial loads and history traversal may normalize a URL, but never add a visit.
  updateURL({replace: true});
  if (view === "intraday") await loadIntraday();
  else if (view === "tags") await loadTagManager();
  else if (view === "blacklist") await loadBlacklist();
  else if (view === "stock") await loadStock({remember});
  else await loadDate();
}

async function initialize() {
  applyRelationHeight(readRelationHeight(), false);
  state.recentStocks = readRecentStocks();
  renderRecentStocks();
  try {
    clearError();
    const meta = await request("/api/meta", "meta");
    if (!meta) return;
    state.meta = meta;
    renderMeta(meta, true);
    await restoreFromURL({remember: true});
  } catch (error) { showError(error, initialize); $("coverage-title").textContent = "本地服务未连接"; $("coverage-note").textContent = "请先启动服务，再重新加载页面。"; $("coverage-banner").classList.add("unavailable"); $("date-table-area").innerHTML = emptyHTML("等待连接历史数据库", "服务连接成功后，将展示真实的历史涨停记录。", "calendar"); $("date-table-area").setAttribute("aria-busy", "false"); renderBoardOptions(); }
}

function updateBackToTop() {
  $("back-to-top").hidden = window.scrollY < window.innerHeight;
}

$("back-to-top").addEventListener("click", () => {
  window.scrollTo({top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
});
window.addEventListener("scroll", updateBackToTop, {passive: true});
window.addEventListener("resize", updateBackToTop);
window.addEventListener("pageshow", updateBackToTop);
updateBackToTop();

window.addEventListener("popstate", () => { if (state.meta) return restoreFromURL(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.meta) refreshMeta(); });
new ResizeObserver(updateQueryStickyOffset).observe($("stock-sticky"));
loadSiteLinks();
initialize();
// Expose font readiness for local preview checks without changing page content.
document.fonts.ready.then(() => {
  const loaded = [...document.fonts].filter(face => face.family.replaceAll('"', "") === "Noto Sans SC" && face.status === "loaded");
  document.documentElement.dataset.uiFont = loaded.length ? "Noto Sans SC" : "fallback";
  document.documentElement.dataset.uiFontWeights = loaded.map(face => face.weight).join(",");
});
