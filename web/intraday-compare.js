"use strict";

// Compare dated, cached minute observations without filling missing samples.
const IntradayCompare = (() => {
  const colors = ["#dc574c", "#367cc4", "#8b64b8", "#269589", "#bf8532", "#c25b91"];
  const scoreBands = [100, 80, 60, 40, 20];
  const clock = slot => {
    const value = slot <= 120 ? 570 + slot : 780 + slot - 121;
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  };
  function decodeRows(payload) {
    return payload.rows.map(stock => {
      const points = Array(242).fill(null);
      for (const [time, price, volume] of stock.points) {
        const [hour, minute] = time.split(":").map(Number), total = hour * 60 + minute;
        const slot = total >= 780 ? total - 780 + 121 : total - 570;
        points[slot] = {slot, time, price, volume, pct: (price / stock.previous_close - 1) * 100};
      }
      return {...stock, pointCount: stock.points.length, points};
    });
  }
  function validWindow(start, end) {
    return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 241 && end > start;
  }
  function targetStocks(query, universe = []) {
    query = query.trim().toUpperCase();
    return universe.filter(stock => !stock.is_st && (!query || `${stock.code} ${stock.name} ${stock.initials || ""}`.toUpperCase().includes(query)));
  }
  function continuationMinutes(points, edge, step, direction, minChange) {
    let previous = points[edge].pct, elapsed = 0, pauses = 0;
    for (let slot = edge + step; points[slot]; slot += step) {
      const price = points[slot].pct;
      const change = (price - previous) * direction;
      if (change >= minChange) {
        elapsed = Math.abs(slot - edge);
        pauses = 0;
      } else if (change <= -minChange || ++pauses === 2) break;
      previous = price;
    }
    return elapsed;
  }
  function windowStats(stock, start, end) {
    const points = stock?.points?.slice(start, end + 1);
    if (!points || points.length !== end - start + 1 || points.some(point => !point)) return null;
    const changes = points.slice(1).map((point, index) => point.pct - points[index].pct);
    // Find the time span of the middle 80% of movement inside the selection.
    const movement = changes.reduce((sum, change) => sum + Math.abs(change), 0);
    let accumulated = 0, firstMove = 0, lastMove = 0;
    for (const [index, change] of changes.entries()) {
      if (accumulated >= movement * .9) break;
      accumulated += Math.abs(change);
      if (accumulated <= movement * .1) firstMove = index + 1;
      else lastMove = index + 1;
    }
    let moveMinutes = lastMove - firstMove;
    if (moveMinutes) {
      // Only extend a move whose main portion reaches the selection edge.
      const minChange = Math.min(.25, movement / changes.length / 4);
      if (!firstMove) moveMinutes += continuationMinutes(stock.points, start, -1, -Math.sign(changes[0]), minChange);
      if (lastMove === changes.length) moveMinutes += continuationMinutes(stock.points, end, 1, Math.sign(changes.at(-1)), minChange);
    }
    const before = stock.points.slice(Math.max(0, start - 5), start).filter(Boolean);
    const volume = points.reduce((sum, point) => sum + point.volume, 0);
    const baseline = before.length ? before.reduce((sum, point) => sum + point.volume, 0) / before.length : null;
    const onset = changes.findIndex(change => Math.abs(change) >= .25);
    return {points, changes, moveMinutes, from: points[0].pct, to: points.at(-1).pct, delta: points.at(-1).pct - points[0].pct, volume, volumeRatio: baseline ? volume / points.length / baseline : null, onset: onset < 0 ? start : start + onset + 1};
  }
  function findMatches(options, universe = []) {
    const source = universe.find(stock => stock.code === options.source);
    const reference = validWindow(options.start, options.end) ? windowStats(source, options.start, options.end) : null;
    const candidates = universe.filter(stock => stock.code !== options.source && stock.boards !== null && !(options.excludeST && stock.is_st) && !(options.excludeGEM && stock.is_gem) && (options.range === "non_limit_up" ? stock.boards === 0 : stock.boards >= 1));
    if (!reference) return {rows: [], total: candidates.length, analyzed: 0, missing: candidates.length, reference};
    const referenceValues = reference.points.map(point => point.pct), referenceMean = referenceValues.reduce((sum, value) => sum + value, 0) / referenceValues.length;
    const centeredReference = referenceValues.map(value => value - referenceMean), referenceSpan = Math.max(...referenceValues) - Math.min(...referenceValues);
    const referenceShapeNorm = Math.hypot(...centeredReference);
    // Each candidate window has the same number of minutes, so the ratio of
    // these norms is also the ratio of the RMS changes per trading minute.
    const referenceSpeed = Math.hypot(...reference.changes);
    const direction = options.mode === "inverse" ? -1 : 1;
    const duration = options.end - options.start;
    const starts = [options.start];
    if (options.mode === "lag") {
      // Visit equally good windows closest to the target time first.
      for (let distance = 1; distance <= Math.max(options.start, 241 - options.end); distance++) {
        if (options.start >= distance) starts.push(options.start - distance);
        if (options.end + distance <= 241) starts.push(options.start + distance);
      }
    }
    const rows = [];
    let missing = 0;
    for (const stock of candidates) {
      let best = null;
      const points = stock.points;
      if (!points) {
        missing++;
        continue;
      }
      for (const start of starts) {
        const end = start + duration;
        if (!points[start] || !points[end]) continue;
        // Compare prices relative to the window's opening value. The centered
        // reference makes a second pass to subtract the candidate's mean unnecessary.
        const opening = points[start].pct;
        let sum = 0, squares = 0, dot = 0, low = 0, high = 0, speedSquares = 0, previous = 0;
        let slot = start + 1;
        for (; slot <= end && points[slot]; slot++) {
          const value = points[slot].pct - opening;
          sum += value;
          squares += value * value;
          dot += value * centeredReference[slot - start];
          low = Math.min(low, value);
          high = Math.max(high, value);
          const change = value - previous;
          speedSquares += change * change;
          previous = value;
        }
        if (slot <= end) continue;
        const span = high - low;
        const denominator = referenceShapeNorm * Math.sqrt(Math.max(0, squares - sum * sum / (duration + 1)));
        const shape = referenceSpan && span && denominator ? Math.max(-1, Math.min(1, dot / denominator)) : 0;
        const alignedShape = shape * direction;
        let upperScore = 0;
        if (alignedShape > 0) {
          const speed = Math.sqrt(speedSquares);
          const spanRatio = Math.min(referenceSpan, span) / Math.max(referenceSpan, span);
          const speedRatio = Math.min(referenceSpeed, speed) / Math.max(referenceSpeed, speed);
          upperScore = alignedShape * Math.min(spanRatio, speedRatio);
        }
        // Duration can only reduce the score. Compute detailed stats only for contenders.
        if (best && upperScore <= best.quality) continue;
        const stats = windowStats(stock, start, end);
        const lengthRatio = reference.moveMinutes && stats.moveMinutes
          ? Math.min(reference.moveMinutes, stats.moveMinutes) / Math.max(reference.moveMinutes, stats.moveMinutes) : 0;
        const quality = upperScore * lengthRatio;
        if (best && quality <= best.quality) continue;
        const relation = !referenceSpan ? "目标区间横盘" : !span ? "区间横盘" : alignedShape <= 0 ? "方向不同" : quality >= .75 ? "走势相近" : "相似度较低";
        best = {stock, start, end, offset: start - options.start, stats, shape, quality, relation, matchScore: Math.round(quality * 1000) / 10, lag: stats.onset - reference.onset};
      }
      if (best) rows.push(best);
      else missing++;
    }
    rows.sort((a, b) => b.quality - a.quality || a.stock.code.localeCompare(b.stock.code));
    return {rows, total: candidates.length, analyzed: candidates.length - missing, missing, reference};
  }
  const signed = value => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  const timing = lag => !lag ? "同一分钟内观察到启动" : `${lag > 0 ? "晚" : "早"}约 ${Math.abs(lag)} 个交易分钟`;
  const volumeText = ratio => ratio === null ? "此前量不足" : ratio < 1.3 ? `未明显增量 · ${ratio.toFixed(1)} 倍` : `成交增加 · ${ratio.toFixed(1)} 倍`;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));

  function mount(root, {getContext = () => ({dates: [], date: ""}), onDateChange = () => {}, loadData, collectData, canCollect = () => true, onOpenPair = () => {}, renderProfile = () => "", targetHistory} = {}) {
    const config = {date: "", source: "", start: 0, end: 30, mode: "sync", range: "limit_up", excludeST: true, excludeGEM: true, scoreBand: null};
    let stocks = [], result = findMatches(config), hover = 30, dragStart = null, dragOrigin = null;
    let loadedDate = "", pendingDate = "", pending = null, generation = 0, loading = false, message = "", poolKnown = null;
    let collection = null, pageRows = [], page = 0;
    const attempted = new Set();
    let calendar = [];
    let recentTargets = targetHistory?.read() || [];
    root.innerHTML = `
      <div class="compare-query-sticky">
      <section class="panel unified-query compare-demo-setup" aria-label="分时筛选条件">
        <div class="query-panel-heading"><h2>走势筛选</h2><p>选择交易日和目标股票，框选分时查找走势</p></div>
        <div class="query-fields query-fields-action">
          <div class="query-date"><label for="demo-date" class="query-label">交易日期</label><div class="date-controls"><button type="button" class="icon-button" id="demo-prev-date" data-demo-date-nav="previous" aria-label="上一个交易日" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><div class="date-input-wrap"><input id="demo-date" type="date" aria-label="走势对比交易日期" required disabled></div><button type="button" class="icon-button" id="demo-next-date" data-demo-date-nav="next" aria-label="下一个交易日" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button><button type="button" id="demo-latest-date" data-demo-date-nav="latest" class="button secondary query-control-button query-latest-date" disabled>最新交易日</button></div></div>
          <div class="stock-picker compare-demo-target"><span id="demo-target-label" class="query-label">目标股票</span><button type="button" id="demo-source-toggle" class="stock-search-wrap query-stock-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="demo-source-popup" aria-labelledby="demo-target-label demo-source-summary"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><span id="demo-source-summary"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button><div id="demo-source-popup" class="minute-stock-picker-popup" role="dialog" aria-label="选择目标股票" hidden><input type="search" id="demo-source-search" placeholder="名称 / 代码 / 首字母" aria-label="筛选目标股票" autocomplete="off"><div id="demo-source-options" class="minute-stock-picker-options" role="radiogroup" aria-label="目标股票选项"></div></div></div>
          <button type="button" id="demo-refresh" class="button secondary query-control-button query-action">刷新数据</button>
        </div>
        <div id="demo-recent-targets" class="query-context query-footer recent-stocks compare-recent-targets" role="group" aria-labelledby="demo-recent-target-label" hidden>
          <span id="demo-recent-target-label" class="recent-stocks-label">历史目标股票</span>
          <div id="demo-recent-target-list" class="recent-stock-list"></div>
        </div>
      </section>
      </div>
      <p id="demo-data-status" class="compare-data-status" role="status" hidden></p>
      <section class="panel compare-demo-reference" aria-labelledby="demo-reference-title">
        <div class="compare-demo-section-head"><div><span class="compare-demo-step">01</span><h3 id="demo-reference-title">框选参考区间</h3><span id="demo-reference-name"></span></div></div>
        <p id="demo-window-change" class="compare-demo-window" role="status" title="走势长度按主要波动计算，计入框选边缘连续的同向走势"></p>
        <p class="compare-demo-hint">拖动框选任意区间，下方实时匹配；可跨午休，休市时间自动跳过。图表获得焦点后用 ← / → 平移，Shift＋方向键调整结束时间。</p>
        <div id="demo-source-chart" class="compare-demo-chart"></div><div id="demo-source-volume" class="compare-demo-volume"></div>
      </section>
      <section class="panel compare-demo-comparison" aria-labelledby="demo-comparison-title">
        <div class="compare-demo-section-head">
          <div><span class="compare-demo-step">02</span><h3 id="demo-comparison-title">匹配分时</h3><span id="demo-result-count" role="status"></span></div>
          <div class="compare-result-filters">
            <label><input type="checkbox" id="demo-exclude-st" checked>屏蔽ST</label>
            <label><input type="checkbox" id="demo-exclude-gem" checked>屏蔽创业板</label>
          </div>
        </div>
        <div class="compare-match-fields">
          <fieldset class="compare-match-options">
            <legend class="compare-demo-label">查找方式</legend>
            <div class="compare-match-pills">
              <label><input class="sr-only" type="radio" name="demo-mode" value="sync" checked><span>同步上涨 / 下跌</span></label>
              <label><input class="sr-only" type="radio" name="demo-mode" value="lag"><span title="在全天分时中查找最相近的一段">先后响应</span></label>
              <label><input class="sr-only" type="radio" name="demo-mode" value="inverse"><span>反向变化</span></label>
            </div>
          </fieldset>
          <fieldset class="compare-match-options">
            <legend class="compare-demo-label">候选范围</legend>
            <div class="compare-match-pills">
              <label><input class="sr-only" type="radio" name="demo-range" value="limit_up" checked><span>涨停</span></label>
              <label><input class="sr-only" type="radio" name="demo-range" value="non_limit_up"><span>非涨停</span></label>
            </div>
          </fieldset>
        </div>
        <fieldset id="demo-score-bands" class="compare-match-options compare-score-bands" hidden>
          <legend class="compare-demo-label">匹配度</legend>
          <div class="compare-match-pills">
            ${scoreBands.map(max => `<label id="demo-score-band-label-${max}" hidden><input class="sr-only" id="demo-score-band-${max}" type="radio" name="demo-score-band" value="${max}"><span>${(max - 19.9).toFixed(1)}%–${max}% <small id="demo-score-count-${max}">0 只</small></span></label>`).join("")}
          </div>
        </fieldset>
        <p id="demo-collection-progress" class="compare-demo-hint compare-collection-progress" role="status" hidden></p>
        <div id="demo-comparison-charts"></div><div id="demo-result-pages" class="compare-demo-section-head" hidden></div>
      </section>`;
    const field = id => root.querySelector(`#${id}`);
    const source = () => stocks.find(stock => stock.code === config.source);
    function renderTargetPicker() {
      field("demo-source-summary").textContent = source() ? `${source().name} ${source().code}` : "选择目标股票";
      field("demo-source-options").innerHTML = targetStocks(field("demo-source-search").value, stocks).slice(0, 80).map(stock => `<label class="minute-stock-option"><input type="radio" name="demo-target-stock" data-demo-source="${stock.code}" aria-label="目标 ${escape(stock.name)} ${stock.code}"${stock.code === config.source ? " checked" : ""}><span><span>${escape(stock.name)}</span><small>${stock.code} · ${stock.initials} · ${stock.pointCount ? "已缓存" : "暂无分时"}</small></span></label>`).join("") || '<p class="minute-stock-picker-empty">没有匹配的股票</p>';
    }
    function renderRecentTargets() {
      field("demo-recent-targets").hidden = !recentTargets.length;
      const list = field("demo-recent-target-list");
      const html = recentTargets.map(({code, name}) => {
        const stock = stocks.find(item => item.code === code && !item.is_st);
        const label = escape(stock?.name || name);
        return `<button type="button" class="recent-stock" data-demo-recent-target="${code}" aria-pressed="${code === config.source}" aria-label="${label} ${code}" title="${label} ${code}${stock ? "" : " · 当前日期不可选"}"${stock ? "" : ' disabled=""'}>${label}</button>`;
      }).join("");
      if (list.innerHTML !== html) list.innerHTML = html;
    }
    function closeTargetPicker() {
      field("demo-source-popup").hidden = true;
      field("demo-source-toggle").setAttribute("aria-expanded", "false");
    }
    function changeDate(day) {
      const input = field("demo-date");
      input.value = day;
      if (!day || input.checkValidity() === false) { input.reportValidity(); input.value = config.date; return; }
      if (!calendar.includes(day)) {
        input.setCustomValidity("请选择交易日，周末和休市日没有分时数据"); input.reportValidity(); input.setCustomValidity(""); input.value = config.date; return;
      }
      if (day === config.date) return;
      config.date = day; onDateChange(day); return loadDay();
    }
    function loadDay(force = false) {
      const day = config.date;
      if (!force && pendingDate === day && pending) return pending;
      if (!force && loadedDate === day) { render(); startCollection(); return Promise.resolve(); }
      const current = ++generation;
      collection = null; page = 0;
      config.scoreBand = null;
      if (force) attempted.clear();
      pendingDate = day; loadedDate = ""; loading = true; message = "正在读取当日分时…"; stocks = []; poolKnown = null; result = findMatches(config); render();
      pending = (async () => {
        try {
          const payload = await loadData(day);
          if (current !== generation) return;
          if (!payload || payload.date !== day) throw new Error("未取得所选日期的数据，请刷新重试。");
          stocks = decodeRows(payload).sort((a, b) => Number(b.pointCount > 0) - Number(a.pointCount > 0) || (b.boards || 0) - (a.boards || 0) || a.code.localeCompare(b.code));
          poolKnown = payload.pool_known; loadedDate = day;
          const targets = targetStocks("", stocks);
          const target = targets.find(stock => stock.code === config.source) || targets[0];
          config.source = target?.code || "";
          if (target && targetHistory) recentTargets = targetHistory.remember(target, recentTargets);
          result = findMatches(config, stocks); message = "";
        } catch (error) {
          if (current !== generation) return;
          loadedDate = ""; message = error.message || "读取失败，请刷新重试。";
        } finally {
          if (current === generation) { loading = false; pending = null; pendingDate = ""; render(); startCollection(); }
        }
      })();
      return pending;
    }
    function syncContext() {
      const context = getContext();
      calendar = context.dates;
      config.date = context.date || config.date || calendar.at(-1) || "";
      if (!config.source) config.source = context.code || "";
      if (context.active === false || !calendar.includes(config.date)) { render(); return Promise.resolve(); }
      return loadDay();
    }
    const collectionScope = () => `${config.source}:${config.range}:${config.excludeST}:${config.excludeGEM}`;
    const collecting = () => collection !== null && collection.done < collection.total;
    function renderCollectionProgress() {
      const status = field("demo-collection-progress");
      const running = collecting();
      const text = collection ? `${running ? "正在获取当日分时" : "当日分时获取完成"}：${collection.done} / ${collection.total} 只${collection.failed ? ` · ${collection.failed} 只来源暂不可用或数据不完整` : ""}` : "";
      status.hidden = !text;
      status.setAttribute("data-running", String(running));
      status.setAttribute("data-empty", String(running && !pageRows.length));
      if (status.textContent !== text) status.textContent = text;
    }
    function startCollection() {
      if (!collectData || !canCollect() || loading || !loadedDate || getContext().active === false) return;
      const day = config.date, loadGeneration = generation;
      const key = collectionScope();
      // Finish the active batch before switching scopes so its outstanding
      // candidates cannot be mistaken for a completed search.
      if (collecting() || collection?.key === key) return;
      const jobs = stocks.filter(stock => stock.status !== "ok" && !attempted.has(`${day}:${stock.code}`) &&
        (stock.code === config.source || (stock.boards !== null && !(config.excludeST && stock.is_st) && !(config.excludeGEM && stock.is_gem) && (config.range === "non_limit_up" ? stock.boards === 0 : stock.boards >= 1))))
        .sort((a, b) => Number(b.code === config.source) - Number(a.code === config.source));
      const task = {key, done: 0, total: jobs.length, failed: 0};
      collection = jobs.length ? task : null;
      renderResults();
      if (!jobs.length) return;
      (async () => {
        while (task.done < jobs.length && getContext().active !== false) {
          const batch = jobs.slice(task.done, task.done + 3);
          batch.forEach(stock => attempted.add(`${day}:${stock.code}`));
          const replies = await Promise.allSettled(batch.map((stock, worker) => collectData(day, stock.code, `${loadGeneration}-${worker}`)));
          if (collection !== task || day !== config.date) return;
          for (let i = 0; i < replies.length; i++) {
            const reply = replies[i];
            if (reply.status === "fulfilled" && reply.value?.date === day && reply.value.rows?.[0]?.code === batch[i].code) {
              const [row] = decodeRows(reply.value), index = stocks.findIndex(stock => stock.code === row.code);
              stocks[index] = row;
              if (row.status !== "ok") task.failed++;
            } else task.failed++;
          }
          if (key !== collectionScope()) {
            collection = null;
            result = findMatches(config, stocks);
            startCollection();
            render(dragStart !== null);
            return;
          }
          task.done += batch.length;
          if (task.done === batch.length || task.done % 12 === 0 || task.done === jobs.length || batch.some(stock => stock.code === config.source)) {
            result = findMatches(config, stocks); render(dragStart !== null);
          } else renderCollectionProgress();
        }
        if (task.done < task.total) {
          collection = null;
          result = findMatches(config, stocks);
          render(dragStart !== null);
        }
      })();
    }
    function chart(stock, {reference = false, selectionStart = config.start, selectionEnd = config.end} = {}) {
      const left = 0, right = 241;
      const x = slot => 62 + (slot - left) / (right - left) * 858;
      const height = reference ? 246 : 210, top = 18, bottom = height - 38;
      const points = stock.points.slice(left, right + 1).filter(Boolean);
      const value = point => point.pct;
      const low = (stock.limit_down_price / stock.previous_close - 1) * 100;
      const high = (stock.limit_up_price / stock.previous_close - 1) * 100;
      const y = v => bottom - (v - low) / (high - low) * (bottom - top);
      let axes = "";
      for (const value of [low, low / 2, 0, high / 2, high]) {
        const yy = y(value);
        axes += `<line x1="62" x2="920" y1="${yy}" y2="${yy}" class="compare-demo-grid${value === 0 ? " compare-price-zero" : ""}"/><text x="51" y="${yy + 4}" text-anchor="end">${value === 0 ? "0.00" : signed(value)}%</text>`;
      }
      const ticks = [0, 30, 60, 90, 120, 151, 181, 211, 241];
      axes += ticks.map(slot => `<text x="${x(slot)}" y="${height - 10}" text-anchor="middle">${slot === 120 ? "11:30 / 13:00" : clock(slot)}</text>`).join("");
      const color = colors[stocks.indexOf(stock) % colors.length];
      const paths = `<path d="${points.map((point, index) => `${index && point.slot === points[index - 1].slot + 1 ? "L" : "M"}${x(point.slot).toFixed(2)},${y(value(point)).toFixed(2)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
      const selection = `<rect data-demo-selection x="${x(selectionStart)}" y="${top}" width="${x(selectionEnd) - x(selectionStart)}" height="${bottom - top}" fill="#367cc4" opacity=".09"/><line data-demo-selection-start x1="${x(selectionStart)}" x2="${x(selectionStart)}" y1="${top}" y2="${bottom}" class="compare-demo-selection-edge"/><line data-demo-selection-end x1="${x(selectionEnd)}" x2="${x(selectionEnd)}" y1="${top}" y2="${bottom}" class="compare-demo-selection-edge"/>`;
      return `<svg class="compare-demo-svg" viewBox="0 0 980 ${height}" role="img" aria-label="${escape(stock.name)} ${clock(left)}至${clock(right)} 分钟涨跌幅折线，纵轴跌停 ${signed(low)}% 至涨停 ${signed(high)}%" ${reference ? 'data-demo-brush tabindex="0"' : ""} data-demo-left="${left}" data-demo-right="${right}">${axes}${selection}${paths}<g data-demo-cursor hidden><line y1="${top}" y2="${bottom}" class="compare-demo-cursor"/><rect y="${height - 26}" width="62" height="21" rx="3"/><text y="${height - 10}" text-anchor="middle"></text></g></svg>`;
    }
    function volumeChart(stock, {reference = false, selectionStart = config.start, selectionEnd = config.end, stats = null} = {}) {
      const x = slot => 62 + slot / 241 * 858, maxVolume = Math.max(1, ...stock.points.filter(Boolean).map(point => point.volume));
      const color = colors[stocks.indexOf(stock) % colors.length];
      const bars = stock.points.filter(Boolean).map(point => {
        const height = point.volume / maxVolume * 86;
        return `<rect x="${(x(point.slot) - 1.4).toFixed(2)}" y="${(94 - height).toFixed(2)}" width="2.8" height="${height.toFixed(2)}" class="minute-volume-bar" style="fill:${color}"/>`;
      }).join("");
      return `<div class="minute-volume-toolbar"><span>成交量 / 手</span>${stats ? `<span>${volumeText(stats.volumeRatio)} · 匹配区间 ${stats.volume.toLocaleString("zh-CN")} 手</span>` : ""}</div>
        <div class="minute-volume-row" data-demo-volume-row="${stock.code}" data-volume-max="${maxVolume}" style="--volume-color:${color}">
          <div class="minute-volume-heading"><span class="minute-volume-stock" title="${escape(stock.name)} ${stock.code}"><i style="background:${color}"></i>${escape(stock.name)}${reference ? "（主图）" : ""}<small>${stock.code}</small></span><span data-volume-reading data-demo-volume-reading="${stock.code}"></span></div>
          <div class="minute-volume-limit">刻度上限 ${maxVolume.toLocaleString("zh-CN")} 手</div>
          <svg viewBox="0 0 980 100" preserveAspectRatio="none" class="minute-volume-svg" role="img" aria-label="${escape(stock.name)} 09:30至15:00 分钟成交量，单位手，各自刻度" data-demo-left="0" data-demo-right="241">
            <line x1="62" x2="920" y1="94" y2="94" class="minute-grid"/><line x1="491" x2="491" y1="0" y2="94" class="minute-grid"/>
            <rect data-demo-selection x="${x(selectionStart)}" y="0" width="${x(selectionEnd) - x(selectionStart)}" height="94" fill="#367cc4" opacity=".09"/><line data-demo-selection-start x1="${x(selectionStart)}" x2="${x(selectionStart)}" y1="0" y2="94" class="compare-demo-selection-edge"/><line data-demo-selection-end x1="${x(selectionEnd)}" x2="${x(selectionEnd)}" y1="0" y2="94" class="compare-demo-selection-edge"/>
            ${bars}<line data-demo-volume-cursor class="minute-volume-cursor" y1="0" y2="94" hidden/>
          </svg>
        </div><div class="minute-volume-times" aria-hidden="true"><span style="left:${62 / 980 * 100}%">09:30</span><span style="left:${491 / 980 * 100}%">11:30 / 13:00</span><span style="left:${920 / 980 * 100}%">15:00</span></div>`;
    }
    function render(preserveBrush = false) {
      const dateInput = field("demo-date"); dateInput.value = config.date; dateInput.min = calendar[0] || ""; dateInput.max = calendar.at(-1) || ""; dateInput.disabled = !calendar.length;
      field("demo-prev-date").disabled = !calendar.some(day => day < config.date); field("demo-next-date").disabled = !calendar.some(day => day > config.date); field("demo-latest-date").disabled = !calendar.length;
      field("demo-refresh").disabled = loading; field("demo-source-toggle").disabled = loading || !stocks.length;
      field("demo-data-status").hidden = !message; field("demo-data-status").textContent = message;
      field("demo-exclude-st").checked = config.excludeST; field("demo-exclude-gem").checked = config.excludeGEM;
      renderTargetPicker();
      renderRecentTargets();
      const currentStock = source(), hasPoints = Boolean(currentStock?.pointCount);
      const stats = windowStats(currentStock, config.start, config.end);
      field("demo-reference-name").textContent = `${config.date ? `${config.date.replaceAll("-", ".")} · ` : ""}${currentStock ? `${currentStock.name} · ${currentStock.code}` : ""}`;
      field("demo-window-change").textContent = stats ? `已选 ${clock(config.start)}—${clock(config.end)} · ${config.end - config.start} 个交易分钟 · 走势长度 ${stats.moveMinutes} 分钟 · ${signed(stats.from)}% → ${signed(stats.to)}% · ${signed(stats.delta)} 个百分点` : loading ? "正在读取…" : hasPoints ? "所选区间存在缺失分钟，请重新框选。" : "该股票当日分时暂缺，可更换股票或日期。";
      if (!preserveBrush) {
        field("demo-source-chart").innerHTML = hasPoints ? chart(currentStock, {reference: true}) : '<p class="compare-demo-empty">暂无当日分时数据</p>';
        field("demo-source-volume").innerHTML = hasPoints ? volumeChart(currentStock, {reference: true}) : "";
      }
      else {
        const x = slot => 62 + slot / 241 * 858;
        for (const container of [field("demo-source-chart"), field("demo-source-volume")]) {
          const svg = container.querySelector("svg");
          svg.querySelector("[data-demo-selection]").setAttribute("x", x(config.start)); svg.querySelector("[data-demo-selection]").setAttribute("width", x(config.end) - x(config.start));
          for (const [edge, slot] of [["start", config.start], ["end", config.end]]) { const line = svg.querySelector(`[data-demo-selection-${edge}]`); line.setAttribute("x1", x(slot)); line.setAttribute("x2", x(slot)); }
        }
      }
      renderResults();
    }
    function renderResults() {
      const rowsByBand = new Map(scoreBands.map(max => [max, []]));
      for (const row of result.rows) {
        if (row.matchScore > 0) rowsByBand.get(Math.ceil(row.matchScore / 20) * 20).push(row);
      }
      const selectedBand = rowsByBand.get(config.scoreBand)?.length ? config.scoreBand : scoreBands.find(max => rowsByBand.get(max).length);
      field("demo-score-bands").hidden = selectedBand === undefined;
      for (const [max, rows] of rowsByBand) {
        field(`demo-score-band-label-${max}`).hidden = !rows.length;
        field(`demo-score-band-${max}`).checked = max === selectedBand;
        field(`demo-score-count-${max}`).textContent = `${rows.length} 只`;
      }
      const visibleRows = rowsByBand.get(selectedBand) || [];
      page = Math.max(0, Math.min(page, Math.ceil(visibleRows.length / 20) - 1));
      pageRows = visibleRows.slice(page * 20, (page + 1) * 20);
      const count = field("demo-result-count");
      count.textContent = `${visibleRows.length} 只匹配`;
      count.hidden = !visibleRows.length && (loading || collecting());
      renderCollectionProgress();
      field("demo-result-pages").hidden = visibleRows.length <= 20;
      field("demo-result-pages").innerHTML = `<span>第 ${page * 20 + 1}—${Math.min((page + 1) * 20, visibleRows.length)} 只 / 共 ${visibleRows.length} 只</span><div><button class="button secondary" id="demo-prev-results"${page ? "" : " disabled"}>上一页</button><button class="button secondary" id="demo-next-results"${(page + 1) * 20 < visibleRows.length ? "" : " disabled"}>下一页</button></div>`;
      field("demo-comparison-charts").innerHTML = pageRows.map((row, index) => `<article class="compare-demo-match" data-demo-match-code="${row.stock.code}" data-demo-match-score="${row.matchScore}" data-window-start="${row.start}" data-window-end="${row.end}" aria-label="第${page * 20 + index + 1}名 ${escape(row.stock.name)} 匹配度${row.matchScore.toFixed(1)}分">
        <header class="compare-demo-match-head"><div><span class="compare-demo-rank">${String(page * 20 + index + 1).padStart(2, "0")}</span><h4><a class="compare-demo-stock-link" href="?${escape(new URLSearchParams({date: config.date, code: row.stock.code}))}">${escape(row.stock.name)}</a></h4><span>${row.stock.code} · 当日${row.stock.boards >= 2 ? `连板 ${row.stock.boards} 板` : row.stock.boards === 1 ? "首板" : "非涨停"}</span></div><div class="compare-demo-match-actions"><strong class="compare-demo-score">匹配度 ${row.matchScore.toFixed(1)}<small> / 100</small></strong><button type="button" class="button secondary small" data-open-minute-pair="${row.stock.code}" aria-label="与${escape(row.stock.name)}做分时对比">分时对比</button></div></header>
        <div class="compare-demo-stock-profile">${renderProfile(row.stock)}</div>
        <div class="compare-demo-match-summary"><span class="compare-demo-match-window">${clock(row.start)}—${clock(row.end)}</span><span title="走势长度按主要波动计算，计入框选边缘连续的同向走势">走势长度 ${row.stats.moveMinutes} 分钟</span><span class="${row.stats.delta >= 0 ? "demo-up" : "demo-down"}">${signed(row.stats.delta)} 个百分点</span><span>${signed(row.stats.from)}% → ${signed(row.stats.to)}%</span><span>${row.relation}${row.quality > 0 ? ` · ${timing(row.lag)}` : ""}${config.mode === "lag" && row.offset ? ` · 窗口偏移 ${row.offset > 0 ? "+" : ""}${row.offset} 个交易分钟` : ""}</span></div>
        <p class="compare-demo-reading" data-demo-reading="${row.stock.code}"></p>
        ${chart(row.stock, {selectionStart: row.start, selectionEnd: row.end})}
        <div class="compare-demo-volume">${volumeChart(row.stock, {selectionStart: row.start, selectionEnd: row.end, stats: row.stats})}</div>
      </article>`).join("") || (collecting() ? "" : `<p class="compare-demo-empty">${loading ? "正在读取当日数据…"
        : !result.reference ? "目标股票在所选区间缺少分钟数据，暂不能比较。"
        : poolKnown === false ? "当日涨停池未收录，暂不能区分涨停与非涨停。"
        : !result.total ? "当前筛选下没有候选股票，可切换范围或调整屏蔽项。"
        : result.analyzed ? "暂无匹配结果。"
        : "当前候选在所选区间缺少完整分钟数据，暂不能比较。"}</p>`);
      updateHover(hover);
    }
    function updateHover(slot) {
      hover = slot;
      root.querySelectorAll("[data-demo-cursor]").forEach(cursor => {
        const svg = cursor.ownerSVGElement, left = Number(svg.dataset.demoLeft), right = Number(svg.dataset.demoRight), xx = 62 + (slot - left) / (right - left) * 858;
        cursor.hidden = false; cursor.removeAttribute("hidden");
        cursor.setAttribute("visibility", slot < left || slot > right ? "hidden" : "visible");
        const line = cursor.querySelector("line"); line.setAttribute("x1", xx); line.setAttribute("x2", xx);
        cursor.querySelector("rect").setAttribute("x", xx - 31); cursor.querySelector("text").setAttribute("x", xx); cursor.querySelector("text").textContent = clock(slot);
      });
      root.querySelectorAll("[data-demo-volume-cursor]").forEach(cursor => {
        const xx = 62 + slot / 241 * 858;
        cursor.removeAttribute("hidden"); cursor.setAttribute("x1", xx); cursor.setAttribute("x2", xx);
      });
      const mainPoint = source()?.points[slot], mainReading = field("demo-source-volume").querySelector("[data-demo-volume-reading]");
      if (mainReading) mainReading.textContent = `${clock(slot)} · ${mainPoint ? `${mainPoint.volume.toLocaleString("zh-CN")} 手` : "该分钟缺失"}`;
      pageRows.forEach(row => {
        const point = row.stock.points[slot];
        root.querySelector(`[data-demo-reading="${row.stock.code}"]`).textContent = `${clock(slot)}　${point ? `涨幅 ${signed(point.pct)}% · 价格 ${point.price.toFixed(2)}` : "该分钟缺失"}`;
        root.querySelector(`[data-demo-volume-reading="${row.stock.code}"]`).textContent = `${clock(slot)} · ${point ? `${point.volume.toLocaleString("zh-CN")} 手` : "该分钟缺失"}`;
      });
    }
    function selectWindow(start, end, preserveBrush = false) {
      if (!validWindow(start, end)) return;
      config.start = start; config.end = end; config.scoreBand = null; hover = end; page = 0; result = findMatches(config, stocks); render(preserveBrush);
    }
    function selectTarget(code) {
      const stock = stocks.find(item => item.code === code && !item.is_st);
      if (!stock || code === config.source) return;
      config.source = code;
      config.scoreBand = null;
      page = 0;
      if (targetHistory) recentTargets = targetHistory.remember(stock, recentTargets);
      result = findMatches(config, stocks);
      closeTargetPicker();
      render();
      startCollection();
    }
    root.addEventListener("input", event => { if (event.target.id === "demo-source-search") renderTargetPicker(); });
    root.addEventListener("change", event => {
      const target = event.target;
      if (target.name === "demo-score-band" && target.checked) {
        config.scoreBand = Number(target.value);
        page = 0;
        renderResults();
        return;
      }
      if (target.id === "demo-date") { changeDate(target.value); return; }
      if (target.dataset.demoSource) {
        selectTarget(target.dataset.demoSource);
        field("demo-source-toggle").focus({preventScroll: true});
        return;
      }
      const key = {"demo-mode": "mode", "demo-range": "range"}[target.name] ||
        {"demo-exclude-st": "excludeST", "demo-exclude-gem": "excludeGEM"}[target.id];
      if (!key || (target.type === "radio" && !target.checked)) return;
      config[key] = target.type === "checkbox" ? target.checked : target.value;
      config.scoreBand = null;
      page = 0;
      result = findMatches(config, stocks);
      render();
      startCollection();
    });
    root.addEventListener("click", event => {
      if (event.target.dataset.demoSource === config.source && config.source) {
        closeTargetPicker(); field("demo-source-toggle").focus({preventScroll: true}); return;
      }
      const button = event.target.closest("button"); if (!button) return;
      if (button.id === "demo-source-toggle") {
        const opening = field("demo-source-popup").hidden;
        field("demo-source-popup").hidden = !opening; button.setAttribute("aria-expanded", String(opening));
        if (opening) { field("demo-source-search").value = ""; renderTargetPicker(); field("demo-source-search").focus(); }
      }
      else if (button.dataset.demoRecentTarget) {
        const code = button.dataset.demoRecentTarget;
        selectTarget(code);
        field("demo-recent-target-list").querySelector(`[data-demo-recent-target="${code}"]`)?.focus({preventScroll: true});
      }
      else if (button.dataset.demoDateNav) {
        const target = button.dataset.demoDateNav === "latest" ? calendar.at(-1) : button.dataset.demoDateNav === "previous" ? [...calendar].reverse().find(day => day < config.date) : calendar.find(day => day > config.date);
        if (target) changeDate(target);
      }
      else if (button.dataset.openMinutePair) onOpenPair(config.date, config.source, button.dataset.openMinutePair);
      else if (button.id === "demo-refresh") loadDay(true);
      else if (button.id === "demo-prev-results" || button.id === "demo-next-results") {
        page += button.id === "demo-next-results" ? 1 : -1; render(); field("demo-comparison-title").scrollIntoView({block: "start"});
      }
    });
    function pointerSlot(event, svg) {
      const xx = (event.clientX - svg.getBoundingClientRect().left) / svg.getBoundingClientRect().width * 980;
      return Math.round(Math.max(0, Math.min(1, (xx - 62) / 858)) * (Number(svg.dataset.demoRight) - Number(svg.dataset.demoLeft)) + Number(svg.dataset.demoLeft));
    }
    field("demo-source-chart").addEventListener("pointerdown", event => {
      const svg = event.target.closest("[data-demo-brush]"); if (!svg || event.button !== 0) return;
      dragStart = pointerSlot(event, svg); dragOrigin = [config.start, config.end]; svg.setPointerCapture(event.pointerId); event.preventDefault();
    });
    root.addEventListener("pointermove", event => {
      const svg = event.target.closest(".compare-demo-svg,.minute-volume-svg"); if (!svg) return;
      const slot = pointerSlot(event, svg); updateHover(slot);
      if (dragStart !== null && svg.matches("[data-demo-brush]")) {
        const left = Math.min(dragStart, slot), right = Math.max(dragStart, slot);
        if (right > left && (left !== config.start || right !== config.end)) selectWindow(left, right, true);
      }
    });
    field("demo-source-chart").addEventListener("pointerup", event => {
      const svg = event.target.closest("[data-demo-brush]"); if (!svg || dragStart === null) return;
      const end = pointerSlot(event, svg), start = dragStart, origin = dragOrigin; dragStart = null; dragOrigin = null;
      if (end !== start) selectWindow(Math.min(start, end), Math.max(start, end));
      else selectWindow(...origin);
    });
    field("demo-source-chart").addEventListener("pointercancel", () => { dragStart = null; if (dragOrigin) selectWindow(...dragOrigin); dragOrigin = null; });
    root.addEventListener("keydown", event => {
      if (!field("demo-source-popup").hidden) {
        if (event.key === "Escape") { event.preventDefault(); closeTargetPicker(); field("demo-source-toggle").focus(); return; }
        if (event.target.id === "demo-source-search" && ["ArrowDown", "Enter"].includes(event.key)) {
          event.preventDefault(); const first = field("demo-source-options").querySelector("input");
          if (event.key === "Enter") first?.click(); else first?.focus(); return;
        }
      }
      if (!event.target.matches("[data-demo-brush]") || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); const step = event.key === "ArrowLeft" ? -1 : 1;
      selectWindow(config.start + (event.shiftKey ? 0 : step), config.end + step); field("demo-source-chart").querySelector("svg").focus({preventScroll: true});
    });
    root.ownerDocument?.addEventListener("pointerdown", event => { if (!event.target.closest(".compare-demo-target")) closeTargetPicker(); });
    syncContext();
    return {
      syncContext,
      updateStockProfile(code, changes) {
        const stock = stocks.find(row => row.code === code);
        if (!stock) return;
        Object.assign(stock, changes);
        const profile = field("demo-comparison-charts").querySelector(`[data-demo-match-code="${code}"] .compare-demo-stock-profile`);
        if (profile) profile.innerHTML = renderProfile(stock);
      },
    };
  }
  return {decodeRows, clock, validWindow, windowStats, findMatches, targetStocks, mount};
})();

var intradayComparisonUI;
if (typeof module !== "undefined" && module.exports) module.exports = IntradayCompare;
else intradayComparisonUI = IntradayCompare.mount(document.getElementById("intraday-comparison-demo"), {
  getContext: () => ({active: state.tab === "intraday" && state.intradayPane === "compare", code: state.intradayCode || new URLSearchParams(location.search).get("minute_code") || "", date: state.intradayDate || document.getElementById("trade-date").value || new URLSearchParams(location.search).get("date") || "", dates: [...new Set(state.meta?.query_dates || state.meta?.dates || [])].sort()}),
  loadData: day => request(`/api/intraday/comparison?date=${encodeURIComponent(day)}`, "intraday-comparison"),
  canCollect: () => state.meta?.capabilities?.edit_tags === true,
  renderProfile: stock => `<div class="compare-demo-stock-info">
      <span class="stock-location" title="公司当前注册省份">${escapeHTML(regionLabel(stock))}</span>
      ${stock.blacklisted ? '<span class="stock-blacklist-badge">黑名单</span>' : ""}
      <div class="stock-tags" aria-label="行业标签">${stockTags(stock).map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</div>
    </div>
    <div class="stock-note-row" data-note-code="${escapeHTML(stock.code)}" aria-label="股票备注">${renderStockNote(stock)}</div>`,
  collectData: (day, code, worker) => request("/api/intraday/comparison/collect", `comparison-collect-${worker}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({date: day, code})}),
  targetHistory: {
    read: () => readRecentStocks(RECENT_TREND_TARGETS_KEY),
    remember: (stock, previous) => rememberRecentStock(RECENT_TREND_TARGETS_KEY, stock, previous),
  },
  onOpenPair: openMinuteMatchPair,
  onDateChange: day => { state.intradayDate = day; updateURL(); }
});
