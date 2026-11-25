const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../web/app.js"), "utf8");
const responses = new Map(), calls = [];
const store = {
  async match(path) { return responses.get(path)?.clone(); },
  async put(path, response) { responses.delete(path); responses.set(path, response.clone()); },
  async keys() { return [...responses.keys()]; },
  async delete(path) { return responses.delete(path); },
};
const data = {rows: [{code: "001229", tags: ["AI应用"], note: "完整备注", blacklisted: true}]};
const json = (value, tag = 'W/"first"') => new Response(JSON.stringify(value), {
  headers: {"Content-Type": "application/json", ...(tag ? {ETag: tag} : {})},
});
let next;
function reload(storage = {open: async () => store}) {
  const context = vm.createContext({state: {requests: {}}, AbortController, setTimeout, clearTimeout,
    caches: storage, fetch: async (path, options) => {calls.push({path, options}); return next(path, options);}});
  vm.runInContext(source.slice(source.indexOf("async function request("), source.indexOf("function showError(")), context);
  return context;
}
(async () => {
  const path = "/api/stock?code=001229";
  let page = reload();
  next = async () => json(data);
  assert.deepEqual(await page.request(path, "stock"), data);
  assert.equal(responses.get(path).headers.get("ETag"), 'W/"first"');
  page = reload(); // The stored body survives a new page state.
  next = async (_, options) => {
    assert.equal(options.headers["If-None-Match"], 'W/"first"');
    assert.equal(options.cache, "no-store", "explicit local storage works even when the browser's HTTP cache is disabled");
    return new Response(null, {status: 304});
  };
  assert.deepEqual(await page.request(path, "stock"), data, "304 reuses the complete local body after refresh");

  const changed = {rows: [{...data.rows[0], tags: ["新标签"], note: "新备注", blacklisted: false}]};
  next = async () => json(changed, 'W/"changed"');
  assert.deepEqual(await page.request(path, "stock"), changed);
  assert.equal(responses.get(path).headers.get("ETag"), 'W/"changed"');
  next = async () => json({rows: [], provisional: true}, "");
  assert.equal((await page.request(path, "stock")).provisional, true);
  assert.equal(responses.has(path), false, "uncacheable responses remove the previously stored body");

  next = async () => json(data);
  await page.request("/api/meta", "meta");
  assert.equal(calls.at(-1).options.headers["If-None-Match"], undefined);
  assert.equal(responses.has("/api/meta"), false, "metadata remains fresh");
  await page.request(path, "write", {method: "POST"});
  assert.equal(responses.has(path), false, "mutations never enter the query cache");
  for (let index = 0; index < 14; index++) await page.request(`/api/date?date=2026-10-${index + 1}`, "day");
  assert.equal(responses.size, 12, "local storage retains at most twelve queries");
  assert.equal(responses.has("/api/date?date=2026-10-1"), false);

  for (const route of ["/api/tags", "/api/blacklist", "/api/tag-stocks?tag=光伏", "/api/stock-note?code=001229",
    "/api/stock-tags?code=001229", "/api/seven-boards?exclude_st=1", "/api/intraday?date=2026-10-13",
    "/api/intraday/timeline?date=2026-10-13", "/api/intraday/comparison?date=2026-10-13", "/api/stock-shareholders?code=001229&date=2026-10-13"]) {
    page = reload();
    next = async () => json(data);
    await page.request(route, "other-page");
    page = reload();
    next = async (_, options) => {
      assert.equal(options.headers["If-None-Match"], 'W/"first"', `new page persists its validator: ${route}`);
      return new Response(null, {status: 304});
    };
    assert.deepEqual(await page.request(route, "other-page"), data);
  }
  next = async () => json({needs_refresh: true}, "");
  const liveRoute = "/api/intraday/stock?date=2026-11-24&code=001229";
  await page.request(liveRoute, "live");
  assert.equal(responses.has(liveRoute), false, "today's minute results receive no server validator and are not saved");
  await page.request("/api/stocks?q=测试", "search");
  assert.equal(responses.has("/api/stocks?q=测试"), false, "autocomplete does not displace cached pages");

  next = async () => json(data);
  page = reload({open: async () => {throw new Error("storage blocked");}});
  assert.deepEqual(await page.request(path, "stock"), data, "unavailable local storage falls back to a normal fetch");
  page = reload({open: async () => ({...store, put: async () => {throw new Error("quota full");}})});
  assert.deepEqual(await page.request(path, "stock"), data, "storage quotas do not fail a successful query");
  next = async () => new Response('{"error":"测试失败"}', {status: 503});
  await assert.rejects(page.request(path, "stock"), /测试失败/, "failed requests do not silently show stale data");
  next = async (_, options) => {
    options.signal.addEventListener("abort", () => {});
    const error = new Error("canceled"); error.name = "AbortError"; throw error;
  };
  assert.equal(await page.request(path, "stock"), null, "existing cancellation behavior is preserved");
  console.log("Persistent query cache: refresh reuse, 304 validation, fresh edits, bounded storage and error fallbacks passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
