// Scroll guidance uses only rendered, fully hidden higher-board cohorts in each column.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
let scrollY = 0, scrollLeft = 0;
const cell = (index, count, label) => ({dataset: {matrixColumn: String(index), stockCount: String(count), groupLabel: label},
  getBoundingClientRect: () => ({left: 120 + index * 256 - scrollLeft, right: 364 + index * 256 - scrollLeft, width: 244})});
const labels = ['消费', '颜色', '医药', '机器人'];
const cohort = (height, bottom, counts) => ({dataset: {boardHeight: String(height)},
  cells: counts.map((count, index) => cell(index, count, labels[index])),
  getBoundingClientRect: () => ({bottom: bottom - scrollY}),
  querySelectorAll() {return this.cells.filter(item => Number(item.dataset.stockCount) > 0);}});
let sections = [cohort(5, 800, [1, 0, 0, 0]), cohort(3, 1100, [1, 2, 0, 1]),
  cohort(2, 1700, [2, 0, 2, 0]), cohort(1, 3000, [9, 2, 7, 7])];
const buttons = labels.map((_, index) => ({dataset: {aboveColumn: String(index)}, hidden: true, style: {}, count: {textContent: ''},
  querySelector() {return this.count;}, setAttribute(name, value) {this[name] = value;}}));
const hints = {hidden: true, style: {}, querySelectorAll: () => buttons};
const board = {clientWidth: 600,
  getBoundingClientRect: () => ({top: 500 - scrollY, bottom: 3000 - scrollY, left: 120}),
  querySelectorAll: () => sections, querySelector: () => ({children: sections[0].cells})};
const area = {querySelector: selector => selector === '.matrix-above-hints' ? hints : board};
const context = vm.createContext({state: {tab: 'date'}, window: {innerHeight: 900},
  $: id => id === 'date-table-area' ? area : {querySelector: () => ({getBoundingClientRect: () => ({bottom: 200})})}});
vm.runInContext(source.slice(source.indexOf('function updateIndustryAboveHints'), source.indexOf('function stockTags')), context);
const update = () => context.updateIndustryAboveHints();
update(); assert.equal(hints.hidden, true, 'no cue before reaching the matrix');
scrollY = 650; update();
assert.equal(hints.hidden, false);
assert.equal(buttons[0].count.textContent, '最高5板 · 1只');
assert.equal(buttons[1].hidden, true, 'a still-visible 3-board cohort has no cue');
assert.equal(hints.style.top, '200px', 'guidance sits immediately below the pinned toolbar');
scrollY = 1000; update();
assert.equal(buttons[0].count.textContent, '最高5板 · 2只', 'multiple hidden heights in one column are combined');
assert.equal(buttons[1].count.textContent, '最高3板 · 2只', 'colors uses its own highest board, not the market leader');
assert.equal(buttons[1].dataset.aboveHeight, '3');
assert.ok(buttons[1]['aria-label'].includes('颜色：上方还有 2 只股票'));
assert.equal(buttons[2].hidden, true, 'visible lower stocks do not count as hidden higher stocks');
assert.equal(buttons[3].hidden, true, 'offscreen columns do not float over unrelated columns');
scrollLeft = 400; update();
assert.equal(buttons[0].hidden, true);
assert.equal(buttons[1].style.left, '-144px', 'partial columns remain aligned and clipped by the hint viewport');
assert.equal(buttons[3].hidden, false);
assert.equal(buttons[3].style.left, '368px');
scrollLeft = 0; scrollY = 1600; update();
assert.equal(buttons[0].count.textContent, '最高5板 · 4只');
assert.equal(buttons[2].count.textContent, '最高2板 · 2只');
context.state.tab = 'intraday'; update(); assert.equal(hints.hidden, true, 'other views cannot inherit a floating cue');
context.state.tab = 'date'; scrollY = 2900; update(); assert.equal(hints.hidden, true, 'guidance ends with the matrix');
sections = [sections[3]]; scrollY = 1000; update();
assert.equal(hints.hidden, true, 'a single-board filter cannot hint at stocks that are not rendered');
console.log('Industry scroll guidance: hidden higher cohorts, per-column totals, geometry, horizontal alignment, view and filter boundaries passed.');
