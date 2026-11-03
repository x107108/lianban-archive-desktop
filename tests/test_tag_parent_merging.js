// Identical daily cohorts merge across parent and standalone columns without losing child paths.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
const context = vm.createContext({canManageTags: () => context.state.meta.capabilities?.manage_tags !== false,
  state: {grouping: 'industry', meta: {latest_date: '2026-10-30',
    tag_order: ['有色金属', '跨境', '芯片', '黄金', '参股长鑫', '其他子标签'],
    tag_hierarchy: [{name: '有色金属', parent: ''}, {name: '黄金', parent: '有色金属'},
      {name: '芯片', parent: ''}, {name: '参股长鑫', parent: '芯片'}, {name: '其他子标签', parent: '芯片'}]}}});
vm.runInContext(source.slice(source.indexOf('function escapeHTML'), source.indexOf('function debounce')), context);
vm.runInContext(source.slice(source.indexOf('function stockTags'), source.indexOf('function renderTagEditor')), context);
const stock = (code, boards, tags) => ({code, boards, tags, name: code, date: '2026-10-30', note: '保留备注'});
const headers = html => [...html.matchAll(/data-group-label="([^"]+)"/g)].map(match => match[1]);
const cards = (html, code) => (html.match(new RegExp(`data-card-code="${code}"`, 'g')) || []).length;
const singleton = stock('000417', 1, ['跨境', '黄金', '参股长鑫']);
const rows = [singleton], counts = context.industryTagBoardCounts(rows);
const before = JSON.stringify({rows, counts, meta: context.state.meta});
const html = context.renderIndustryColumns(rows, counts);
assert.deepEqual(headers(html), ['有色金属 / 跨境 / 芯片'], 'parent labels participate in the same exact-cohort merge as standalone labels');
assert.equal(cards(html, '000417'), 1, 'the shared first-board stock has one card across all three roots');
for (const tag of ['有色金属', '跨境', '芯片', '黄金', '参股长鑫']) {
  assert.ok(html.includes(`data-add-sector-tag="${tag}"`), `merged ${tag} retains its own add-stocks action`);
}
assert.ok(html.includes('有色金属 / </small>') && html.includes('芯片 / </small>'), 'child headings retain their different parent paths');
for (const tag of singleton.tags) assert.ok(html.includes(`<span class="stock-tag">${tag}</span>`));
assert.ok(html.includes('保留备注') && html.includes('上0下0 · 未知1'));
assert.equal(JSON.stringify({rows, counts, meta: context.state.meta}), before, 'the merge changes presentation only');

// A standalone label may rank ahead of both parents; no child branch may disappear.
context.state.meta.tag_order = ['跨境', '芯片', '有色金属'];
const standaloneFirst = context.renderIndustryColumns(rows, counts);
assert.deepEqual(headers(standaloneFirst), ['跨境 / 芯片 / 有色金属']);
assert.equal(cards(standaloneFirst, '000417'), 1);
for (const tag of ['黄金', '参股长鑫']) assert.ok(standaloneFirst.includes(`data-add-sector-tag="${tag}"`));

const pair = [...rows, stock('000418', 1, ['跨境', '黄金', '其他子标签'])];
const pairHTML = context.renderIndustryColumns(pair);
assert.deepEqual(headers(pairHTML), ['跨境 / 芯片 / 有色金属'], 'equal multi-stock parent cohorts also merge');
assert.ok(pairHTML.includes('data-add-sector-tag="其他子标签"'), 'each distinct child branch is retained');
const changed = [...rows, stock('000418', 1, ['黄金'])];
assert.deepEqual(headers(context.renderIndustryColumns(changed)), ['有色金属', '跨境 / 芯片'], 'a different stock set splits the affected parent column');

const leader = stock('000419', 3, ['黄金']);
const daily = context.industryTagBoardCounts([...rows, leader]);
assert.deepEqual(headers(context.renderIndustryColumns(rows, daily)), ['有色金属', '跨境 / 芯片'], 'first-board filtering cannot hide a different daily leader and falsely merge its parent');
context.state.meta.capabilities = {manage_tags: false, edit_tags: false};
assert.ok(!context.renderIndustryColumns(rows, counts).includes('data-add-sector-tag'), 'read-only mode remains read-only');
console.log('Parent-column merging: exact daily cohorts, all child paths/actions, standalone-first order, split-on-change, hidden leaders and read-only display passed.');
