// Parent sectors must not bypass consecutive-board cross-height deduplication.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
const context = vm.createContext({canManageTags: () => true, state: {grouping: 'industry', meta: {
  latest_date: '2026-09-18', tag_order: ['房地产', '广东国资', '珠海国资', '物业'],
  tag_hierarchy: [{name: '房地产', parent: ''}, {name: '物业', parent: '房地产'},
    {name: '广东国资', parent: ''}, {name: '珠海国资', parent: '广东国资'}]
}}});
vm.runInContext(source.slice(source.indexOf('function escapeHTML'), source.indexOf('function debounce')), context);
vm.runInContext(source.slice(source.indexOf('function stockTags'), source.indexOf('function renderTagEditor')), context);
const stock = (code, boards, tags) => ({code, name: code, boards, tags, date: '2026-09-18'});
const target = {...stock('002285', 3, ['珠海国资', '房地产']), name: '世联行', note: '保留备注', blacklisted: true};
const columns = (rows, daily) => JSON.parse(JSON.stringify(context.buildIndustryColumns(rows, daily).columns));
const targetColumns = (rows, daily) => columns(rows, daily).filter(column => column.stocks.some(row => row.code === target.code)).map(column => column.labels);
const cards = html => (html.match(/data-card-code="002285"/g) || []).length;
const unchanged = JSON.stringify(target);

assert.deepEqual(targetColumns([target]), [['房地产']], 'a leader with only private parent sectors keeps one ordinary fallback');
const html = context.renderIndustryColumns([target]);
assert.equal(cards(html), 1);
assert.doesNotMatch(html, /data-group-label="独苗"/);
for (const tag of target.tags) assert.ok(html.includes(`<span class="stock-tag">${tag}</span>`));
assert.ok(html.includes('保留备注') && html.includes('blacklisted-stock'), 'deduplication preserves the card information');
assert.equal(JSON.stringify(target), unchanged, 'presentation cannot rewrite tags, hierarchy or personal records');

const propertyFollower = stock('000001', 1, ['物业']);
const related = [target, propertyFollower];
const daily = context.industryTagBoardCounts(related);
assert.deepEqual(targetColumns(related), [['房地产']], 'an unrelated parent cannot create an extra card beside a real cross-height sector');
assert.deepEqual(targetColumns([target], daily), [['房地产']], 'board filtering retains full-day cross-height evidence');

const bothRelated = [...related, stock('000002', 2, ['珠海国资'])];
assert.deepEqual(targetColumns(bothRelated), [['房地产'], ['广东国资']], 'both sectors remain when each has genuine cross-height peers');
assert.deepEqual(targetColumns([target], context.industryTagBoardCounts(bothRelated)), [['房地产'], ['广东国资']]);
const sameHeight = [target, stock('000003', 3, ['珠海国资'])];
assert.deepEqual(targetColumns(sameHeight), [['房地产']], 'same-height peers do not trigger another parent-sector presentation');

const first = {...target, boards: 1};
assert.deepEqual(targetColumns([first]), [['房地产', '广东国资']], 'identical first-board parent cohorts keep their existing merge rule');
assert.equal(cards(context.renderIndustryColumns([first])), 1);
context.state.grouping = 'region';
assert.equal(cards(context.renderIndustryColumns([target])), 1, 'other classification layouts retain their own rules');
console.log('Parent-sector leader deduplication: private fallback, cross-height links, filtered leaders, same-height peers, first-board merge and preserved stock data passed.');
