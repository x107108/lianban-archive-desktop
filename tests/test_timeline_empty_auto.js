// An entirely uncached timeline starts the existing collection queue without blocking page loading.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
const day = '2026-10-30';
function harness({analyzed = 0, editable = true, fail = false, hold = false, total = 5} = {}) {
  const elements = new Map(), posts = [], renders = [], pending = [], records = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {value: '3', checked: true, textContent: '', hidden: true, setAttribute() {}});
    return elements.get(id);
  };
  let active = 0, peak = 0, complete = false;
  const context = vm.createContext({$, URLSearchParams, loadingHTML: () => '', emptyHTML: () => '', dateLabel: value => value,
    state: {tab: 'intraday', intradayDate: day, requests: {}, meta: {capabilities: {edit_tags: editable}}},
    renderMinuteTimeline: options => renders.push({options, data: context.state.minuteTimelineData}),
    updateMinuteTimelineControls() {}, recordMinuteData: data => records.push(data),
    request: async (url, channel, options = {}) => {
      if (options.method !== 'POST') return {date: context.state.intradayDate, coverage: {total, analyzed: complete ? total : analyzed},
        scope: {exclude_gem: $('minute-timeline-exclude-gem').checked}, time_coverage: {missing: 0},
        jobs: complete || !total ? [] : Array.from({length: total}, (_, index) => ({code: String(600001 + index), force: false}))};
      assert.equal(url, '/api/intraday/collect');
      const body = JSON.parse(options.body); posts.push(body); active++; peak = Math.max(peak, active);
      try {
        if (hold) await new Promise(done => pending.push(done));
        else await new Promise(done => setImmediate(done));
        if (fail) throw Error('upstream unavailable');
        if (posts.length === total && active === 1) complete = true;
        return {date: body.date, stock: {code: body.code}, points: [{}], status: 'ok'};
      } finally {active--;}
    }
  });
  vm.runInContext(source.slice(source.indexOf('async function loadMinuteTimeline'), source.indexOf('async function openMinuteTimelineNode')), context);
  return {context, $, posts, renders, pending, records, peak: () => peak};
}
async function settled(h) {
  for (let turn = 0; turn < 30 && h.context.state.minuteTimelineCollecting; turn++) await new Promise(done => setImmediate(done));
  assert.equal(h.context.state.minuteTimelineCollecting, false);
}
(async () => {
  const h = harness();
  await h.context.loadMinuteTimeline();
  assert.ok(h.posts.length > 0, 'loading an empty timeline automatically starts collection');
  await settled(h);
  assert.equal(h.posts.length, 5);
  assert.equal(h.peak(), 3, 'automatic work reuses the bounded existing queue');
  assert.ok(h.posts.every(body => body.date === day && body.force === false));
  assert.equal(h.context.state.minuteTimelineData.coverage.analyzed, 5, 'completed collection rereads and renders cached nodes');
  assert.equal(h.renders.at(-1).options.preserve, true);
  await h.context.loadMinuteTimeline({quiet: true});
  assert.equal(h.posts.length, 5, 'cached data never causes another automatic collection');

  for (const options of [{analyzed: 1}, {editable: false}, {total: 0}]) {
    const skip = harness(options); await skip.context.loadMinuteTimeline();
    assert.equal(skip.posts.length, 0, 'partial data, read-only views and an empty pool do not auto-collect');
  }
  const failed = harness({fail: true});
  await failed.context.loadMinuteTimeline(); await settled(failed);
  await failed.context.loadMinuteTimeline({quiet: true});
  assert.equal(failed.posts.length, 5, 'failed empty results cannot create an endless collection loop');
  await failed.context.loadMinuteTimeline({refreshTimes: true}); await settled(failed);
  assert.equal(failed.posts.length, 10, 'explicit refresh permits a retry after failure');
  failed.$('minute-timeline-exclude-gem').checked = false;
  await failed.context.loadMinuteTimeline(); await settled(failed);
  assert.equal(failed.posts.length, 15, 'a newly selected stock scope has its own initial attempt');

  const delayed = harness({hold: true});
  await delayed.context.loadMinuteTimeline();
  assert.equal(delayed.posts.length, 3, 'page loading finishes while acquisition is still pending');
  delayed.context.stopMinuteTimelineCollection(false);
  delayed.pending.forEach(done => done()); await new Promise(done => setImmediate(done));
  await delayed.context.loadMinuteTimeline({quiet: true});
  assert.equal(delayed.posts.length, 3, 'stopping does not immediately restart automatic collection');
  assert.equal(delayed.records.length, 0, 'stopped responses cannot overwrite current UI');
  const live = harness(); live.context.state.minuteLiveRefreshing = true;
  await live.context.loadMinuteTimeline(); assert.equal(live.posts.length, 0, 'automatic queues do not overlap');
  live.context.state.minuteLiveRefreshing = false;
  await live.context.loadMinuteTimeline(); await settled(live);
  assert.equal(live.posts.length, 5, 'skipped busy loads do not consume the initial attempt');
  console.log('Empty timeline acquisition: automatic start, nonblocking load, cache reuse, bounded queue, failure/retry/stop, scope changes and permission guards passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
