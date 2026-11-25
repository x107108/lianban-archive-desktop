// Child cohorts and their stocks use first-limit-up time, with each cohort kept together.
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
assert.deepEqual(sections(html), ['合并甲 / 合并乙', '乳业', '白酒', '酒业'], 'each cohort uses its earliest first seal, regardless of size; missing times come last');
assert.deepEqual(cards(group(html, '白酒')), ['000003', '000002', '000001'], 'first limit time takes precedence over stock code');
assert.deepEqual(cards(group(html, '合并甲 / 合并乙')), ['000007', '000006', '000008'], 'pre-market times sort first and unknown times sort last');
assert.equal(context.renderHierarchyStockGroups([...rows].reverse(), '消费', true), html, 'input order cannot affect subgroup or stock order');
assert.equal(JSON.stringify(rows), before, 'sorting does not mutate source rows or labels');

const timeTies = [stock('000012', ['白酒'], '10:00:00'), stock('000011', ['白酒'], '10:00:00'),
  stock('000014', ['白酒'], ''), stock('000013', ['白酒'], null)];
assert.deepEqual(cards(context.renderHierarchyStockGroups(timeTies, '消费', false)), ['000011', '000012', '000013', '000014'], 'equal or missing times use stock code for stable ordering');

const interleaved = [stock('100001', ['乳业'], '09:30:00'), stock('100002', ['白酒'], '09:31:00'), stock('100003', ['乳业'], '09:32:00')];
const interleavedHTML = context.renderHierarchyStockGroups(interleaved, '消费', false);
assert.deepEqual(sections(interleavedHTML), ['乳业', '白酒']);
assert.deepEqual(cards(interleavedHTML), ['100001', '100003', '100002'], 'the third-sealed stock stays with the first stock in its subgroup instead of splitting the subgroup');
const groupTies = [stock('200001', ['白酒'], '09:30:00'), stock('200002', ['乳业'], '09:30:00'), stock('200003', ['酒业'], null)];
assert.deepEqual(sections(context.renderHierarchyStockGroups(groupTies, '消费', false)), ['乳业', '白酒', '酒业'], 'equal earliest times retain tag order; groups with no time follow known times');

const day = [...rows, stock('000020', ['乳业'], '11:00:00', 2), stock('000021', ['乳业'], '09:24:00', 2),
  stock('000022', ['乳业'], '10:30:00', 2), stock('000023', ['乳业'], '10:00:00', 2)];
const rendered = context.renderIndustryColumns(day, context.industryTagBoardCounts(day));
const firstRow = rendered.split('data-board-height="1"')[1];
assert.equal(sections(firstRow)[0], '合并甲 / 合并乙', 'another height cannot move a subgroup forward with an earlier first seal');
assert.deepEqual(cards(group(firstRow, '白酒')), ['000003', '000002', '000001']);
assert.match(firstRow, /class="matrix-sort-toggle"[^>]*aria-label="按细分排序"[^>]*title="按细分排序"[^>]*aria-pressed="false"/, 'parent headers start in grouped mode with an icon and tooltip');

const overlapping = [...day, stock('000099', ['白酒', '乳业'], '09:31:00')];
context.state.flatIndustryCells = new Set([JSON.stringify([1, '消费'])]);
const flat = context.renderIndustryColumns(overlapping, context.industryTagBoardCounts(overlapping));
const flatFirst = flat.split('data-board-height="1"')[1];
assert.equal(sections(flatFirst).length, 0, 'flat mode hides all subdivision headings');
assert.deepEqual(cards(flatFirst), ['000007', '000004', '000099', '000003', '000002', '000006', '000001', '000005', '000008'], 'flat mode orders the entire list by first seal, deduplicates overlapping memberships, and places unknown times last');
assert.match(flatFirst, /aria-label="默认排序" title="默认排序" aria-pressed="true"/);
assert.ok(sections(flat.split('data-board-height="2"')[1].split('data-board-height="1"')[0]).length > 0, 'another board-height cell retains its own grouped setting');
context.state.flatIndustryCells.clear();
assert.equal(context.renderIndustryColumns(day, context.industryTagBoardCounts(day)), rendered, 'switching back restores the original grouped rendering');
context.state.grouping = 'region';
assert.doesNotMatch(context.renderIndustryColumns(day), /matrix-sort-toggle/, 'layouts without subdivision headings do not show this toggle');
console.log('Child tag sorting: earliest subgroup seal, interleaved membership, merged alias deduplication, missing/equal times, board-height isolation and no source mutation passed.');
