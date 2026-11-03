// Session totals use first seals, unique stocks and the current height/filter cohort.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
const context = vm.createContext({canManageTags: () => true, state: {grouping: 'industry', meta: {latest_date: '2026-10-30',
  tag_hierarchy: [{name: '食品', parent: '消费'}, {name: '白酒', parent: '消费'}]}}});
vm.runInContext(source.slice(source.indexOf('function escapeHTML'), source.indexOf('function debounce')), context);
vm.runInContext(source.slice(source.indexOf('function stockTags'), source.indexOf('function renderTagEditor')), context);
const stock = (code, first_time, boards = 1, tags = ['消费', '食品', '白酒']) => ({code, name: code,
  date: '2026-10-30', first_time, last_time: '14:59:59', boards, tags});
const rows = ['09:25:00', '09:30:00', '10:54:32', '11:30:00', '13:00:00', '13:05:11', '14:02:03', '15:00:00']
  .map((clock, index) => stock(String(index + 1).padStart(6, '0'), clock));
const before = JSON.stringify(rows);
const header = (html, height = 1) => html.split(`data-board-height="${height}"`)[1].split('</header>')[1].split('</header>')[0];
const html = context.renderIndustryColumns(rows);
assert.ok(header(html).includes('>上4下4</span>'), 'first seals, including auction and session endpoints, determine AM/PM rather than last seals');
assert.ok(header(html).includes('上午 4 只，下午 4 只；共 8 只'), 'hover retains explicit counts and the unique-stock total');
assert.equal((html.match(/class="stock-session-summary"/g) || []).length, 1, 'overlapping child tags do not multiply the main count');
assert.equal((html.match(/data-card-code=/g) || []).length, 8, 'identical child groups reuse eight cards');
assert.ok(!html.includes('class="board-badge'), 'stock cards no longer show a board badge');
for (const row of rows) assert.ok(html.includes(`datetime="${row.first_time}" title="首次涨停时间：${row.first_time}">${row.first_time}</time>`));
const mixed = [...rows, stock('000010', null), stock('000011', '13:01:02', 3)];
const full = context.renderIndustryColumns(mixed);
assert.ok(header(full, 1).includes('上4下4 · 未知1'));
assert.ok(header(full, 3).includes('上0下1'), 'another board height has a separate session count');
assert.ok(header(context.renderIndustryColumns(rows.slice(0, 4))).includes('上4下0'), 'filtered-out stocks cannot remain in session totals');
assert.ok(!context.renderStockCard(stock('000010', null)).includes('datetime='));
assert.ok(context.renderStockCard(stock('000010', null)).includes('title="首次涨停时间暂缺">—</time>'));
context.state.grouping = 'region';
assert.ok(!context.renderIndustryColumns(rows).includes('stock-session-summary'), 'region counts keep their existing meaning');
assert.equal(JSON.stringify(rows), before, 'display changes never rewrite the archive or tags');

// Missing source clocks are supplemented once without replacing a newer date or view.
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {value: '2026-10-30', innerHTML: '', textContent: '',
    setAttribute() {}, querySelectorAll: () => [], querySelector: () => null});
  return elements.get(id);
};
let requests = [], pending, fail = false;
const daily = {date: '2026-10-30', data_status: 'ok', rows: [stock('000001', null)], time_coverage: {cached: false, missing: 1}};
const loader = vm.createContext({URLSearchParams, Set, $: element,
  state: {tab: 'date', meta: {capabilities: {edit_tags: true}}, requests: {}},
  setView() {}, clearError() {}, loadingHTML() {}, setStats() {}, updateDateNavigation() {}, updateURL() {}, loadShareholderAlerts() {},
  getDateQuery: () => new URLSearchParams({date: element('trade-date').value}),
  renderDate() {}, updateIndustryNavigation() {}, window: {scrollX: 0, scrollY: 0, scrollTo() {}},
  showError(error) {throw error;}, request: async (url, channel, options) => {
    requests.push({url, channel, options});
    if (channel === 'date') return {...daily};
    if (fail) throw Error('source unavailable');
    if (pending) await pending;
    return {date: daily.date, cached: false};
  }});
vm.runInContext(source.slice(source.indexOf('async function loadDate'), source.indexOf('function renderDate')), loader);
(async () => {
  await loader.loadDate();
  assert.equal(requests.filter(r => r.channel === 'date-times').length, 1);
  assert.equal(requests.filter(r => r.channel === 'date').length, 2, 'successful supplementation re-reads the date once');
  await loader.loadDate();
  assert.equal(requests.filter(r => r.channel === 'date-times').length, 1, 'filter changes cannot repeatedly collect a missing date');
  loader.state.dateTimesRequested.clear(); requests = []; fail = true;
  await loader.loadDate();
  assert.equal(loader.state.dateData.time_coverage.missing, 1, 'a failed source leaves the original results available');
  await loader.loadDate();
  assert.equal(requests.filter(r => r.channel === 'date-times').length, 1, 'a failed source is not retried on every filter');
  loader.state.dateTimesRequested.clear(); requests = []; fail = false;
  loader.state.meta.capabilities.edit_tags = false;
  await loader.loadDate();
  assert.equal(requests.length, 1, 'read-only views never collect');
  loader.state.meta.capabilities.edit_tags = true; daily.data_status = 'provisional'; requests = [];
  await loader.loadDate();
  assert.equal(requests.length, 1, 'provisional snapshots are not enriched with closing-only clocks');
  daily.data_status = 'ok'; daily.time_coverage.cached = true; requests = [];
  await loader.loadDate();
  assert.equal(requests.length, 1, 'an existing partial cache is reused');
  daily.time_coverage.cached = false; requests = [];
  let release;
  pending = new Promise(resolve => { release = resolve; });
  const old = loader.loadDate();
  await Promise.resolve();
  element('trade-date').value = '2026-10-29';
  release(); await old;
  assert.equal(requests.filter(r => r.channel === 'date').length, 1, 'a completed old collection cannot reload a newly selected date');
  console.log('Daily first-seal clocks, AM/PM totals, hierarchy deduplication, missing data, per-height filters and collection lifecycle: passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
