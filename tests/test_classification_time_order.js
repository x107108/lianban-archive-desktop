// Every displayed stock cohort uses first limit-up time, including flat tags and matching layouts.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
const context = vm.createContext({canManageTags: () => true, state: {grouping: 'industry', meta: {
  latest_date: '2026-11-01', tag_order: ['总类', '颜色', '医药'], tag_hierarchy: []
}, latestLimitUps: new Map([['001001', 2], ['001004', 1]])}});
vm.runInContext(source.slice(source.indexOf('function escapeHTML'), source.indexOf('function debounce')), context);
vm.runInContext(source.slice(source.indexOf('function stockTags'), source.indexOf('function renderTagEditor')), context);
const times = ['13:00:00', '09:32:07', '09:30:00', null, '09:32:07', '09:25:00'];
const initials = ['HX', 'XH', 'HH', 'HQ', 'YH', 'QH'];
const rows = times.map((first_time, i) => ({code: `00100${i + 1}`, name: `样本${i + 1}`,
  date: '2026-10-30', boards: 1, first_time, initials: initials[i], registered_province: '上海市',
  tags: ['颜色', '医药'], blacklisted: i === 1}));
const expected = ['001006', '001003', '001002', '001005', '001001', '001004'];
const before = JSON.stringify(rows);
const cards = html => [...html.matchAll(/data-card-code="([^"]+)"/g)].map(match => match[1]);
function verify(html, name) {
  let full = false;
  for (const cell of html.split('<section class="matrix-cell ').slice(1)) {
    const codes = cards(cell);
    if (!codes.length) continue;
    assert.deepEqual(codes, expected.filter(code => codes.includes(code)), `${name}: each classification sorts by time, then code, with missing time last`);
    if (codes.length === expected.length) full = true;
  }
  assert.equal(full, true, `${name}: at least one shared cohort includes every fixture`);
}
for (const height of [1, 2]) {
  const sameBoard = rows.map(row => ({...row, boards: height}));
  for (const mode of ['industry', 'region', 'pinyin', 'code']) {
    context.state.grouping = mode;
    for (const highlightLatest of [true, false]) {
      const html = context.renderIndustryColumns(sameBoard, null, {highlightLatest});
      verify(html, `${mode}/${height}/${highlightLatest}`);
      assert.equal(context.renderIndustryColumns([...sameBoard].reverse(), null, {highlightLatest}), html, 'arrival order does not affect the rendered order');
      if (highlightLatest) {
        assert.ok(html.includes('latest-limit-up'), 'today highlighting remains available without displacing earlier times');
        assert.ok(!html.includes('涨停股票高亮置顶'), 'the date view no longer claims highlighted stocks are pinned');
      }
    }
  }
}
context.state.grouping = 'industry';
context.state.meta.tag_hierarchy = [{name: '颜色', parent: '总类'}, {name: '医药', parent: '总类'}];
const hierarchy = context.renderIndustryColumns(rows);
assert.ok(hierarchy.includes('data-child-tag="颜色 / 医药"'), 'identical child cohorts stay merged');
verify(hierarchy, 'hierarchical child cohort');
assert.deepEqual(cards(context.renderHierarchyStockGroups(rows, ['颜色', '医药'], true)), expected, 'flat tag renderer also honors time when called directly');
assert.equal(JSON.stringify(rows), before, 'tags, notes, blacklist and source ordering remain untouched');
console.log('All classification stock orders: flat/merged/hierarchical tags, region, pinyin, code, both board heights, highlights, equal/unknown times and no source mutation passed.');
