// Child cohorts use visible stock counts, then first-limit-up time within each cohort.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
const childNames = ['乳业', '酒业', '白酒', '合并甲', '合并乙'];
const context = vm.createContext({canManageTags: () => true, state: {grouping: 'industry', meta: {
  latest_date: '2026-10-30', tag_order: ['消费', ...childNames],
  tag_hierarchy: [{name: '消费', parent: ''}, ...childNames.map(name => ({name, parent: '消费'}))]
}}});
vm.runInContext(source.slice(source.indexOf('function escapeHTML'), source.indexOf('function debounce')), context);
vm.runInContext(source.slice(source.indexOf('function stockTags'), source.indexOf('function renderTagEditor')), context);
const stock = (code, tags, first_time, boards = 1) => ({code, name: code, tags, first_time, boards, date: '2026-10-30'});
const rows = [stock('000001', ['白酒'], '13:27:36'), stock('000002', ['白酒'], '09:54:09'),
  stock('000003', ['白酒'], '09:44:13'), stock('000004', ['乳业'], '09:30:00'),
  stock('000005', ['酒业'], null), stock('000006', ['合并甲', '合并乙'], '10:00:00'),
  stock('000007', ['合并甲', '合并乙'], '09:25:00'), stock('000008', ['合并甲', '合并乙'], null)];
const before = JSON.stringify(rows);
const html = context.renderHierarchyStockGroups(rows, '消费', true);
const sections = html => [...html.matchAll(/data-child-tag="([^"]+)"/g)].map(match => match[1]);
const cards = html => [...html.matchAll(/data-card-code="([^"]+)"/g)].map(match => match[1]);
const group = (html, name) => html.split(`data-child-tag="${name}"`)[1].split('<section class="matrix-tag-subgroup"')[0];
assert.deepEqual(sections(html), ['白酒', '合并甲 / 合并乙', '乳业', '酒业'], 'visible counts descend; merged aliases count each stock once; ties retain global label order');
assert.deepEqual(cards(group(html, '白酒')), ['000003', '000002', '000001'], 'first limit time takes precedence over stock code');
assert.deepEqual(cards(group(html, '合并甲 / 合并乙')), ['000007', '000006', '000008'], 'pre-market times sort first and unknown times sort last');
assert.equal(context.renderHierarchyStockGroups([...rows].reverse(), '消费', true), html, 'input order cannot affect subgroup or stock order');
assert.equal(JSON.stringify(rows), before, 'sorting does not mutate source rows or labels');

const timeTies = [stock('000012', ['白酒'], '10:00:00'), stock('000011', ['白酒'], '10:00:00'),
  stock('000014', ['白酒'], ''), stock('000013', ['白酒'], null)];
assert.deepEqual(cards(context.renderHierarchyStockGroups(timeTies, '消费', false)), ['000011', '000012', '000013', '000014'], 'equal or missing times use stock code for stable ordering');

const day = [...rows, stock('000020', ['乳业'], '11:00:00', 2), stock('000021', ['乳业'], '09:30:00', 2),
  stock('000022', ['乳业'], '10:30:00', 2), stock('000023', ['乳业'], '10:00:00', 2)];
const rendered = context.renderIndustryColumns(day, context.industryTagBoardCounts(day));
const firstRow = rendered.split('data-board-height="1"')[1];
assert.equal(sections(firstRow)[0], '白酒', 'another height cannot inflate a visible child subgroup count');
assert.deepEqual(cards(group(firstRow, '白酒')), ['000003', '000002', '000001']);
console.log('Child tag sorting: visible counts, merged alias deduplication, first-limit time, missing/equal times, board-height isolation and no source mutation passed.');
