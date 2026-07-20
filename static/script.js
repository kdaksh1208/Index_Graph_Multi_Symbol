"use strict";

/* ══════════════════════════════════════════════════════════════
   NSE OI Tracker — script.js
   Two phases:
   1. PICKER  — loads symbols, lets user choose, POSTs start-analysis
   2. DASHBOARD — polls per-symbol data, renders charts/table/alerts
   ══════════════════════════════════════════════════════════════ */

/* ── CONFIG ──────────────────────────────────────────────────── */
// was: const DATA_POLL_MS = 5_000; ... const CYCLE_INTERVAL = 120_000;
const DATA_POLL_MS            =   5_000;
const STATUS_POLL_MS          =   1_000;
let   CYCLE_INTERVAL          = 15 * 60 * 1000; // NEW: user-configurable, default 0h 15m
const ALERT_DURATION_MS       =  75_000;
const CYCLE_TOAST_DURATION_MS =   3_000;

/* ── COLOUR PALETTE (unchanged) ─────────────────────────────── */
const CLR = {
  put: "#f0883e", putNeg: "#c0572a",
  call: "#58a6ff", callNeg: "#2a6abf",
  gridLine: "#21262d", axisLabel: "#8b949e",
  tooltip: "#1c2128", tooltipBorder: "#30363d",
};

/* ════════════════════════════════════════════════════════════════
   PHASE 1 — SYMBOL PICKER
   ════════════════════════════════════════════════════════════════ */

let _allSymbols  = { indices: [], stocks: [] };
let _selectedSet = new Set();
let _activeTab   = "indices";
let _searchQuery = "";

/* NEW (additive): optional per-symbol price levels entered at the picker
   stage. Now an object per symbol: { entry, target, sl }. */
let _priceLevels = {};

/* Poll /api/available-symbols until fetched=true */
async function _loadSymbols() {
  while (true) {
    try {
      const r = await fetch("/api/available-symbols");
      const d = await r.json();
      if (d.fetched) {
        _allSymbols = { indices: d.indices || [], stocks: d.stocks || [] };
        _showPickerContent();
        return;
      }
    } catch (_) { /* retry */ }
    await new Promise(r => setTimeout(r, 1500));
  }
}

function _showPickerContent() {
  document.getElementById("pickerLoading").classList.add("hidden");
  document.getElementById("pickerContent").classList.remove("hidden");
  _updateBadges();
  _renderGrid();
}

function _updateBadges() {
  const q = _searchQuery.toLowerCase();
  const fi = _allSymbols.indices.filter(s => !q || s.toLowerCase().includes(q));
  const fs = _allSymbols.stocks.filter(s  => !q || s.toLowerCase().includes(q));
  document.getElementById("idxCount").textContent = fi.length;
  document.getElementById("stkCount").textContent = fs.length;
  document.getElementById("allCount").textContent = fi.length + fs.length;
}

function _visibleSymbols() {
  const q = _searchQuery.toLowerCase();
  let pool = [];
  if (_activeTab === "indices" || _activeTab === "all") {
    pool = pool.concat(_allSymbols.indices);
  }
  if (_activeTab === "stocks" || _activeTab === "all") {
    pool = pool.concat(_allSymbols.stocks);
  }
  return q ? pool.filter(s => s.toLowerCase().includes(q)) : pool;
}

function _renderGrid() {
  const grid     = document.getElementById("symbolGrid");
  const noResult = document.getElementById("noResults");
  const visible  = _visibleSymbols();

  if (visible.length === 0) {
    grid.innerHTML = "";
    noResult.classList.remove("hidden");
    document.getElementById("noResultsTerm").textContent = _searchQuery;
    return;
  }
  noResult.classList.add("hidden");

  grid.innerHTML = visible.map(sym => {
    const sel = _selectedSet.has(sym);
    const isIdx = _allSymbols.indices.includes(sym);
    return `<button class="sym-chip ${sel ? "selected" : ""}" data-sym="${sym}"
      title="${isIdx ? "Index" : "Stock"}">
      <span class="sym-chip-badge ${isIdx ? "idx-badge" : "stk-badge"}">${isIdx ? "IDX" : "STK"}</span>
      ${sym}
      ${sel ? '<span class="sym-chip-check">✓</span>' : ""}
    </button>`;
  }).join("");

  grid.querySelectorAll(".sym-chip").forEach(btn => {
    btn.addEventListener("click", () => _toggleSymbol(btn.dataset.sym));
  });
}

function _toggleSymbol(sym) {
  if (_selectedSet.has(sym)) {
    _selectedSet.delete(sym);
  } else {
    _selectedSet.add(sym);
  }
  _renderGrid();
  _renderChips();
  _updateSelectionCount();
}

function _renderChips() {
  const wrap  = document.getElementById("selectedChipsWrap");
  const chips = document.getElementById("selectedChips");
  if (_selectedSet.size === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  chips.innerHTML = [..._selectedSet].map(sym => {
    const lv = _priceLevels[sym] || {};
    return `<span class="sel-chip">${sym}
      <span class="sel-chip-levels">
        <input type="number" step="any" class="sel-chip-level-input pl-entry" data-sym="${sym}" data-key="entry" placeholder="Entry" title="Entry level for ${sym}" value="${lv.entry ?? ""}">
        <input type="number" step="any" class="sel-chip-level-input pl-target" data-sym="${sym}" data-key="target" placeholder="Target" title="Target level for ${sym}" value="${lv.target ?? ""}">
        <input type="number" step="any" class="sel-chip-level-input pl-sl" data-sym="${sym}" data-key="sl" placeholder="SL" title="Stop Loss level for ${sym}" value="${lv.sl ?? ""}">
      </span>
      <button class="sel-chip-x" data-sym="${sym}" title="Remove">×</button>
    </span>`;
  }).join("");
  chips.querySelectorAll(".sel-chip-x").forEach(btn => {
    btn.addEventListener("click", () => _toggleSymbol(btn.dataset.sym));
  });
  // NEW (additive): capture the three optional per-symbol levels
  chips.querySelectorAll(".sel-chip-level-input").forEach(inp => {
    inp.addEventListener("input", () => {
      const sym = inp.dataset.sym, key = inp.dataset.key;
      if (!_priceLevels[sym]) _priceLevels[sym] = {};
      if (inp.value === "") { delete _priceLevels[sym][key]; }
      else { _priceLevels[sym][key] = inp.value; }
    });
  });
}

function _updateSelectionCount() {
  const n   = _selectedSet.size;
  const el  = document.getElementById("selectionCount");
  const btn = document.getElementById("startBtn");
  el.textContent  = `${n} symbol${n !== 1 ? "s" : ""} selected`;
  btn.disabled    = n === 0;
}

function _initPicker() {
  // Tab switching
  document.querySelectorAll(".picker-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".picker-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      _activeTab = tab.dataset.tab;
      _renderGrid();
    });
  });

  // Search
  const searchEl = document.getElementById("pickerSearch");
  searchEl.addEventListener("input", () => {
    _searchQuery = searchEl.value.trim();
    document.getElementById("pickerClearSearch").style.display = _searchQuery ? "" : "none";
    _updateBadges();
    _renderGrid();
  });
  document.getElementById("pickerClearSearch").addEventListener("click", () => {
    searchEl.value = "";
    _searchQuery   = "";
    document.getElementById("pickerClearSearch").style.display = "none";
    _updateBadges();
    _renderGrid();
  });
  document.getElementById("pickerClearSearch").style.display = "none";

  // Clear all chips
  document.getElementById("clearAllBtn").addEventListener("click", () => {
    _selectedSet.clear();
    _renderGrid();
    _renderChips();
    _updateSelectionCount();
  });

  // Start button
  document.getElementById("startBtn").addEventListener("click", _startAnalysis);

  // Load symbols
  _loadSymbols();
}

async function _startAnalysis() {
  const symbols = [..._selectedSet];
  if (!symbols.length) return;

  const btn = document.getElementById("startBtn");
  btn.disabled    = true;
  btn.textContent = "Starting…";

  // NEW (additive): Time Interval for Analysis (Hours/Minutes), default 0h 15m.
  const hEl = document.getElementById("intervalHours");
  const mEl = document.getElementById("intervalMinutes");
  let hours   = parseInt(hEl?.value, 10);
  let minutes = parseInt(mEl?.value, 10);
  if (isNaN(hours)   || hours   < 0) hours   = 0;
  if (isNaN(minutes) || minutes < 0) minutes = 15;
  if (hours === 0 && minutes === 0) minutes = 15; // never allow a 0 interval
  const intervalSeconds = hours * 3600 + minutes * 60;
  CYCLE_INTERVAL = intervalSeconds * 1000;

  try {
    const r = await fetch("/api/start-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        symbols,
        price_levels: _priceLevels,        // unchanged
        interval_seconds: intervalSeconds, // NEW, additive
      }),
    });
    const d = await r.json();
    if (d.started) {
      _switchToDashboard(symbols);
    } else {
      alert("Error: " + (d.error || "Unknown error"));
      btn.disabled    = false;
      btn.textContent = "▶ Start Analysis";
    }
  } catch (e) {
    alert("Network error: " + e.message);
    btn.disabled    = false;
    btn.textContent = "▶ Start Analysis";
  }
}

/* ════════════════════════════════════════════════════════════════
   TRANSITION — picker → dashboard
   ════════════════════════════════════════════════════════════════ */

function _switchToDashboard(symbols) {
  document.getElementById("pickerView").classList.add("hidden");
  document.getElementById("dashboardView").classList.remove("hidden");
  _initDashboard(symbols);
}


/* ════════════════════════════════════════════════════════════════
   PHASE 2 — DASHBOARD
   ════════════════════════════════════════════════════════════════ */

/* Per-symbol runtime state */
const symState = {};

/* Active symbol displayed in charts */
let activeSymbol = "";

/* EChart instances */
let supportChart;
let resistanceChart;

/* Cached API responses for instant symbol switching */
const _cachedApiResponse = {};

/* Overlay step tracking */
let _advancedPhases = new Set();
let stepIdx = 0;
const STEPS = ["step1","step2","step3","step4","step5"];

function _initDashboard(symbols) {
  // Initialise per-symbol state
  symbols.forEach(sym => {
    symState[sym] = {
      lastHistoryLen: 0, firstDataLoaded: false,
      lastNewDataTime: null, isDataFetchInProgress: false,
      alertCycleCount: 0, alertHistory: new Set(),
    };
  });

  // Populate dropdown
  const sel = document.getElementById("symbolSelector");
  sel.innerHTML = symbols.map((s, i) =>
    `<option value="${s}" ${i === 0 ? "selected" : ""}>${s}</option>`
  ).join("");
  activeSymbol = symbols[0];
  document.getElementById("priceLabelText").textContent = activeSymbol;

  // NEW (additive): seed price levels captured at the picker stage,
  // then reflect the active symbol's levels in the header inputs.
  _initPriceLevelsFromPicker(symbols);
  _reflectPriceLevelInputs(activeSymbol);

  initCharts();
  _resetCheckboxes();
  _applyToastPosition(activeSymbol);

  // Kick off polling for every symbol
  symbols.forEach(sym => {
    pollData(sym);
    setInterval(() => { if (!symState[sym].isDataFetchInProgress) pollData(sym); }, DATA_POLL_MS);
  });

  pollStatus();
  setInterval(pollStatus, STATUS_POLL_MS);

  setInterval(() => {
    const phase    = document.getElementById("statusMsg")?.textContent ?? "";
    const fetching = /downloading|clicking|opening|connecting/i.test(phase);
    _updateCountdownDisplay(fetching);
  }, 1000);

  showToast("info", "🚀 Analysis started",
    `Monitoring: ${symbols.join(", ")} — fetching first data…`, 6000);
}

/* ── Symbol dropdown switch ─────────────────────────────────── */
function onSymbolChange(sym) {
  activeSymbol = sym;
  const label = document.getElementById("priceLabelText");
  if (label) label.textContent = sym;

  // NEW (additive): show this symbol's own levels in the header controls
  _reflectPriceLevelInputs(sym);

  if (symState[sym]?.firstDataLoaded && _cachedApiResponse[sym]) {
    const { support, resistance, current, status: st } = _cachedApiResponse[sym];
    updateHeader(current);
    updateCharts(support, resistance, sym);
    updateTable(support, resistance);
    updateStatusUI(st, sym);
  } else {
    document.getElementById("niftyPrice").textContent       = "—";
    document.getElementById("headerSupport").textContent    = "—";
    document.getElementById("headerResistance").textContent = "—";
    document.getElementById("tableBody").innerHTML =
      `<tr><td colspan="12" class="table-empty">Waiting for first ${sym} data…</td></tr>`;
  }
}

/* ── Overlay ─────────────────────────────────────────────────── */
function advanceStepForPhase(key) {
  if (_advancedPhases.has(key)) return;
  _advancedPhases.add(key);
  if (stepIdx > 0) _markStepDone(STEPS[stepIdx - 1]);
  if (stepIdx < STEPS.length) { _markStepActive(STEPS[stepIdx]); stepIdx++; }
}
function _markStepActive(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add("active"); el.classList.remove("done"); }
}
function _markStepDone(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove("active"); el.classList.add("done"); }
}
function hideOverlay() {
  STEPS.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove("active"); el.classList.add("done"); }
  });
  setTimeout(() => {
    const ov = document.getElementById("loadingOverlay");
    if (ov) ov.classList.add("hidden");
  }, 600);
}

/* ── ECharts ─────────────────────────────────────────────────── */
function initCharts() {
  const supEl = document.getElementById("supportChart");
  const resEl = document.getElementById("resistanceChart");
  if (supEl) supportChart    = echarts.init(supEl, null, { renderer: "svg" });
  if (resEl) resistanceChart = echarts.init(resEl, null, { renderer: "svg" });
  window.addEventListener("resize", () => {
    supportChart?.resize();
    resistanceChart?.resize();
  });
}

function buildChartOption(title, labels, putDeltas, callDeltas, cmpValues, sym) {
  const putValues  = putDeltas.map(p => p?.value ?? 0);
  const callValues = callDeltas.map(p => p?.value ?? 0);
  const putColors  = putValues.map(v  => v  >= 0 ? CLR.put  : CLR.putNeg);
  const callColors = callValues.map(v => v >= 0 ? CLR.call : CLR.callNeg);

  let cmpMin = Math.min(...cmpValues), cmpMax = Math.max(...cmpValues);
  const pad = (cmpMax - cmpMin || 1) * 0.1;
  cmpMin -= pad; cmpMax += pad;

  return {
    backgroundColor: "transparent",
    animation: true, animationDuration: 600,
    grid: { top: 20, right: 24, bottom: 56, left: 70, containLabel: false },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: CLR.tooltip, borderColor: CLR.tooltipBorder, borderWidth: 1,
      textStyle: { color: "#e6edf3", fontSize: 12 },
      formatter(params) {
        const ts     = params[0]?.axisValue ?? "—";
        const pl     = params.find(p => p.data?.strike !== undefined)?.data || {};
        const putP   = params.find(p => p.seriesName === "Put OI Δ");
        const callP  = params.find(p => p.seriesName === "Call OI Δ");
        const pc     = (putP?.value  ?? 0) >= 0 ? CLR.put  : CLR.putNeg;
        const cc     = (callP?.value ?? 0) >= 0 ? CLR.call : CLR.callNeg;
        const isSupp = title === "Support";
        return `<div style="font-size:11px;line-height:1.7">
          <b style="font-size:12px">⏱ ${ts}</b><br>
          <span style="opacity:.8">CMP:</span> <b>${fmtNum(pl.cmp)}</b><br>
          <span style="opacity:.8">${isSupp ? "Support" : "Resistance"} Strike:</span> <b>${pl.strike ?? "—"}</b><br>
          <span style="color:${pc}">■</span> ${isSupp?"SUP":"RES"} PUT Δ &nbsp;<b>${fmtDelta(putP?.value)}</b><br>
          <span style="color:${cc}">■</span> ${isSupp?"SUP":"RES"} CALL Δ &nbsp;<b>${fmtDelta(callP?.value)}</b>
        </div>`;
      },
    },
    xAxis: {
      type: "category", data: labels,
      axisLabel: { color: CLR.axisLabel, fontSize: 11, rotate: labels.length > 8 ? 30 : 0 },
      axisLine: { lineStyle: { color: "#30363d" } },
      axisTick: { lineStyle: { color: "#30363d" } },
    },
    yAxis: [
      { type: "value",
        axisLabel: { color: CLR.axisLabel, fontSize: 11, formatter: v => fmtNum(v) },
        splitLine: { lineStyle: { color: CLR.gridLine, type: "dashed" } },
        axisLine: { show: false } },
      { type: "value", position: "right", min: cmpMin, max: cmpMax,
        axisLabel: { color: "#3b82f6", fontSize: 11, formatter: v => fmtNum(v) },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: "#3b82f6" } } },
    ],
    series: [
      { name: "Put OI Δ", type: "bar", barGap: "0%", barCategoryGap: "40%", yAxisIndex: 0,
        data: putDeltas.map((p, i) => ({
          value: p.value, strike: p.strike, cmp: p.cmp,
          itemStyle: { color: putColors[i], borderRadius: p.value >= 0 ? [3,3,0,0] : [0,0,3,3] },
          label: { show: true, position: p.value >= 0 ? "top" : "bottom",
                   formatter: "P", fontSize: 10, color: putColors[i], fontWeight: 700 },
        })) },
      { name: "Call OI Δ", type: "bar", yAxisIndex: 0,
        data: callDeltas.map((p, i) => ({
          value: p.value, strike: p.strike, cmp: p.cmp,
          itemStyle: { color: callColors[i], borderRadius: p.value >= 0 ? [3,3,0,0] : [0,0,3,3] },
          label: { show: true, position: p.value >= 0 ? "top" : "bottom",
                   formatter: "C", fontSize: 10, color: callColors[i], fontWeight: 700 },
        })) },
      { name: `${sym} CMP`, type: "line", yAxisIndex: 1, data: cmpValues,
        lineStyle: { color: "#3b82f6", width: 2.5 }, smooth: true, showSymbol: false },
      { name: "CMP Point", type: "scatter", yAxisIndex: 1, data: cmpValues,
        symbolSize: 6, itemStyle: { color: "#3b82f6", borderColor: "#fff", borderWidth: 1.5 },
        label: { show: false } },
    ],
  };
}

function updateCharts(supportData, resistanceData, sym) {
  const MAX = 12;
  const sd  = supportData.slice(1).slice(-MAX);
  const rd  = resistanceData.slice(1).slice(-MAX);

  const supEmpty = document.getElementById("supportEmpty");
  const supChart = document.getElementById("supportChart");
  if (sd.length > 0) {
    supEmpty?.classList.add("hidden");
    if (supChart) supChart.style.display = "block";
    const labels = sd.map(d => d.timestamp);
    const putD   = sd.map(d => ({ value: d.put_delta  ?? 0, strike: d.strike, cmp: d.cmp }));
    const callD  = sd.map(d => ({ value: d.call_delta ?? 0, strike: d.strike, cmp: d.cmp }));
    const cmpD   = sd.map(d => d.cmp ?? 0);
    supportChart?.setOption(buildChartOption("Support", labels, putD, callD, cmpD, sym), true);
    supportChart?.resize();
  } else {
    supEmpty?.classList.remove("hidden");
    if (supChart) supChart.style.display = "none";
  }

  const resEmpty = document.getElementById("resistanceEmpty");
  const resChart = document.getElementById("resistanceChart");
  if (rd.length > 0) {
    resEmpty?.classList.add("hidden");
    if (resChart) resChart.style.display = "block";
    const labels = rd.map(d => d.timestamp);
    const putD   = rd.map(d => ({ value: d.put_delta  ?? 0, strike: d.strike, cmp: d.cmp }));
    const callD  = rd.map(d => ({ value: d.call_delta ?? 0, strike: d.strike, cmp: d.cmp }));
    const cmpD   = rd.map(d => d.cmp ?? 0);
    resistanceChart?.setOption(buildChartOption("Resistance", labels, putD, callD, cmpD, sym), true);
    resistanceChart?.resize();
  } else {
    resEmpty?.classList.remove("hidden");
    if (resChart) resChart.style.display = "none";
  }

  if (supportData.length > 0) {
    const last = supportData.at(-1);
    document.getElementById("supportStrike").textContent  = last.strike  ?? "—";
    document.getElementById("supportPutOI").textContent   = fmtNum(last.put_oi);
    document.getElementById("supportCallOI").textContent  = fmtNum(last.call_oi);
  }
  if (resistanceData.length > 0) {
    const last = resistanceData.at(-1);
    document.getElementById("resistanceStrike").textContent  = last.strike  ?? "—";
    document.getElementById("resistancePutOI").textContent   = fmtNum(last.put_oi);
    document.getElementById("resistanceCallOI").textContent  = fmtNum(last.call_oi);
  }
}

function updateTable(supSeries, resSeries) {
  const body = document.getElementById("tableBody");
  if (!body) return;
  const len = Math.max(supSeries.length, resSeries.length);
  if (len === 0) {
    body.innerHTML = '<tr><td colspan="12" class="table-empty">Waiting for 2nd snapshot…</td></tr>';
    return;
  }
  let html = "";
  for (let i = len - 1; i >= 0; i--) {
    const s = supSeries[i] || {}, r = resSeries[i] || {};
    const sp = s.put_delta ?? 0, sc = s.call_delta ?? 0;
    const rp = r.put_delta ?? 0, rc = r.call_delta ?? 0;
    const cmp = s.cmp ?? r.cmp ?? "—";
    html += `<tr>
      <td>${s.timestamp ?? r.timestamp ?? "—"}</td>
      <td>${cmp === "—" ? "—" : Number(cmp).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
      <td class="strike-val">${s.strike ?? "—"}</td>
      <td>${fmtNum(s.put_oi)}</td><td>${fmtNum(s.call_oi)}</td>
      <td class="${sp >= 0 ? "pos" : "neg"}">${fmtDelta(sp)}</td>
      <td class="${sc >= 0 ? "pos" : "neg"}">${fmtDelta(sc)}</td>
      <td class="strike-val">${r.strike ?? "—"}</td>
      <td>${fmtNum(r.put_oi)}</td><td>${fmtNum(r.call_oi)}</td>
      <td class="${rp >= 0 ? "pos" : "neg"}">${fmtDelta(rp)}</td>
      <td class="${rc >= 0 ? "pos" : "neg"}">${fmtDelta(rc)}</td>
    </tr>`;
  }
  body.innerHTML = html;
}

function updateHeader(current) {
  if (!current) return;
  const price = current.cmp;
  document.getElementById("niftyPrice").textContent       = price ? price.toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "—";
  document.getElementById("headerSupport").textContent    = current.support_strike    ?? "—";
  document.getElementById("headerResistance").textContent = current.resistance_strike ?? "—";
}

function updateStatusUI(st, sym) {
  if (sym && sym !== activeSymbol) return;
  const dot     = document.getElementById("statusDot");
  const spinner = document.getElementById("statusSpinner");
  const msgEl   = document.getElementById("statusMsg");
  const lastEl  = document.getElementById("lastUpdate");
  const cycleEl = document.getElementById("cycleNum");
  if (msgEl)   msgEl.textContent   = st.phase ?? "—";
  if (cycleEl) cycleEl.textContent = st.cycle ?? 0;
  if (st.fetching) {
    dot?.classList.remove("active","error"); dot?.classList.add("fetching");
    if (spinner) { spinner.classList.remove("done"); spinner.style.display = ""; spinner.textContent = "⟳"; }
  } else if (st.error) {
    dot?.classList.remove("active","fetching"); dot?.classList.add("error");
    if (spinner) spinner.style.display = "none";
  } else {
    dot?.classList.remove("fetching","error"); dot?.classList.add("active");
    if (spinner) { spinner.classList.add("done"); spinner.textContent = "✓"; }
  }
  if (st.last_update && lastEl) {
    lastEl.textContent = `Updated ${new Date(st.last_update).toLocaleTimeString("en-IN")}`;
  }
}

function _updateCountdownDisplay(isFetching) {
  const el = document.getElementById("countdown");
  if (!el) return;
  const ss = symState[activeSymbol];
  if (!ss || !ss.firstDataLoaded) { el.textContent = "Loading first data…"; return; }
  if (isFetching)                 { el.textContent = "Fetching new data…"; return; }
  if (ss.lastNewDataTime === null) { el.textContent = "—"; return; }
  const remaining = Math.max(0, CYCLE_INTERVAL - (Date.now() - ss.lastNewDataTime));
  const total = Math.ceil(remaining / 1000);
  el.textContent = total > 0
    ? `Next fetch in ${Math.floor(total/60)}:${String(total%60).padStart(2,"0")}`
    : "Fetching new data…";
}

function _resetCheckboxes() {
  for (let i = 1; i <= 4; i++) {
    const c = document.getElementById(`check${i}`);
    if (c) c.checked = false;
  }
}
function _markCheckbox(n) {
  const c = document.getElementById(`check${n}`);
  if (c) c.checked = true;
}
function _updateCheckboxesFromPhase(phase) {
  const p = (phase || "").toLowerCase();
  _resetCheckboxes();
  if (p.includes("connecting")||p.includes("opening"))          _markCheckbox(1);
  if (p.includes("downloading")||p.includes("clicking"))       { _markCheckbox(1); _markCheckbox(2); }
  if (p.includes("processing")||p.includes("parsing"))         { _markCheckbox(1); _markCheckbox(2); _markCheckbox(3); }
  if (p.includes("identifying"))                                { _markCheckbox(1); _markCheckbox(2); _markCheckbox(3); _markCheckbox(4); }
  if (p.includes("updated")||p.includes("baseline"))           { _markCheckbox(1); _markCheckbox(2); _markCheckbox(3); _markCheckbox(4); }
}

/* ── Data polling ────────────────────────────────────────────── */
async function pollData(sym) {
  const ss = symState[sym];
  if (!ss || ss.isDataFetchInProgress) return;
  ss.isDataFetchInProgress = true;
  try {
    const r = await fetch(`/api/data/${sym}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const { support, resistance, current, history_len, status: st } = data;
    _cachedApiResponse[sym] = data;

    if (!current) {
      if (sym === activeSymbol) { updateStatusUI(st, sym); _updateCountdownDisplay(st.fetching); }
      return;
    }

    const isNew = history_len > ss.lastHistoryLen;

    // NEW (additive): evaluate Price Level / Pro-Level / Breakout alerts.
    // Independent of, and does not alter, the existing directional alert
    // evaluation below. isNew tells the evaluator whether this poll
    // represents a genuinely new "closing" data point (a new cycle),
    // vs. just a routine 5s status refresh.
    evaluatePriceLevelAlerts(sym, support, resistance, current, isNew);
    if (isNew) {
      ss.lastNewDataTime = Date.now();
      ss.lastHistoryLen  = history_len;
      if (history_len > 1) {
        ss.alertCycleCount++;
        evaluateAlertConditions(sym, support, resistance);
        if (sym === activeSymbol) {
          const s = support.at(-1), rv = resistance.at(-1);
          const anyDelta = (s?.put_delta??0)!==0||(s?.call_delta??0)!==0||(rv?.put_delta??0)!==0||(rv?.call_delta??0)!==0;
          if (anyDelta) {
            showToast("success",
              `📊 ${sym} Cycle ${st.cycle??""} — New Data`,
              `Support Δ &nbsp;Put: ${fmtDelta(s?.put_delta)} &nbsp; Call: ${fmtDelta(s?.call_delta)}<br>`+
              `Resistance Δ Put: ${fmtDelta(rv?.put_delta)} &nbsp; Call: ${fmtDelta(rv?.call_delta)}`,
              CYCLE_TOAST_DURATION_MS);
          }
        }
      }
      if (sym === activeSymbol) { updateCharts(support, resistance, sym); updateTable(support, resistance); }
    }

    if (!ss.firstDataLoaded) {
      ss.firstDataLoaded = true;
      if (sym === activeSymbol) {
        updateCharts(support, resistance, sym);
        updateTable(support, resistance);
        hideOverlay();
        showToast("success", `✅ ${sym} live data loaded`,
          `CMP ${current.cmp?.toLocaleString("en-IN",{minimumFractionDigits:2})} | `+
          `Support ${current.support_strike} | Resistance ${current.resistance_strike}`, 6000);
      } else {
        showToast("info", `✅ ${sym} data ready`,
          `CMP ${current.cmp?.toLocaleString("en-IN",{minimumFractionDigits:2})} | `+
          `Support ${current.support_strike} | Resistance ${current.resistance_strike}`, 4000);
      }
      if (sym === Object.keys(symState)[0]) hideOverlay();
    }

    if (sym === activeSymbol) {
      updateHeader(current);
      updateStatusUI(st, sym);
      _updateCountdownDisplay(st.fetching);
    }
  } catch (err) {
    console.error(`[pollData:${sym}]`, err);
  } finally {
    ss.isDataFetchInProgress = false;
  }
}

async function pollStatus() {
  try {
    const r = await fetch("/api/status");
    if (!r.ok) return;
    const all = await r.json();
    const st  = all[activeSymbol];
    if (st) {
      updateStatusUI(st, activeSymbol);
      _updateCheckboxesFromPhase(st.phase);
      _updateCountdownDisplay(st.fetching);
      if (!symState[activeSymbol]?.firstDataLoaded) {
        const p = (st.phase||"").toLowerCase();
        if (p.includes("opening")||p.includes("connecting"))  advanceStepForPhase("connect");
        if (p.includes("clicking")||p.includes("downloading")) advanceStepForPhase("download");
        if (p.includes("processing")||p.includes("parsing"))  advanceStepForPhase("process");
        if (p.includes("identifying"))                         advanceStepForPhase("identify");
        if (p.includes("updated")||p.includes("baseline"))    advanceStepForPhase("done");
      }
    }
  } catch (_) {}
}

/* ── Toast positioning ───────────────────────────────────────── */
function _applyToastPosition(sym) {
  const c = document.getElementById("toastContainer");
  if (!c) return;
  const n = symState[sym]?.alertCycleCount ?? 0;
  c.classList.toggle("toast-left",  n >= 3);
  c.classList.toggle("toast-right", n <  3);
}

/* ── Toasts ──────────────────────────────────────────────────── */
const TOAST_ICONS = { info:"ℹ️", success:"✅", warning:"⚠️", error:"❌" };

function showToast(type="info", title="", body="", duration=5000) {
  _applyToastPosition(activeSymbol || "");
  const c = document.getElementById("toastContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type]??""}</span>
    <div class="toast-body"><strong>${title}</strong><span>${body}</span></div>`;
  c.appendChild(el);
  setTimeout(() => _removeEl(el), duration);
}

function _removeEl(el) {
  if (!el || el._removing) return;
  el._removing = true;
  el.classList.add("fade-out");
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

function _formatDetail(label, value) {
  return `<div class="toast-detail-row"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`;
}

function _showPopupAlert(sym, title, bodyHtml, duration=ALERT_DURATION_MS) {
  _applyToastPosition(sym);
  const c = document.getElementById("toastContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = "toast popup toast-strong";
  el.innerHTML = `<div class="toast-icon">🟡</div>
    <div class="toast-body"><strong>${title}</strong><div class="toast-details">${bodyHtml}</div></div>
    <button class="toast-close" aria-label="Dismiss">×</button>`;
  el.querySelector(".toast-close")?.addEventListener("click", () => _removeEl(el), { once: true });
  c.appendChild(el);
  setTimeout(() => _removeEl(el), duration);
}

/* ── Added: forward a triggered alert to the backend (Telegram + log) ──
   Does NOT evaluate or alter the alert condition — it only sends the
   same information already shown in the popup, after the popup has
   already fired. ────────────────────────────────────────────────── */
function _notifyBackendAlert(sym, title, sc, rc, pattern, spd, scd, rpd, rcd, thMet, metrics) {
  const lines = [
    title,
    `Symbol: ${sym}`,
    `Pattern: ${pattern}`,
    `Timestamp: ${sc.timestamp ?? "—"}`,
    `CMP: ${fmtNum(sc.cmp)}`,
    `Support Strike: ${sc.strike ?? "—"}`,
    `Sup PUT Δ: ${fmtDelta(spd)}`,
    `Sup CALL Δ: ${fmtDelta(scd)}`,
    `Resistance Strike: ${rc.strike ?? "—"}`,
    `Res PUT Δ: ${fmtDelta(rpd)}`,
    `Res CALL Δ: ${fmtDelta(rcd)}`,
  ];
  if (metrics.length) lines.push(`Triggered: ${metrics.join(" & ")}`);
  lines.push(`Directional ✓${thMet ? " | Threshold ✓" : ""}`);

  fetch("/api/alert-notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: lines.join("\n") }),
  }).catch(err => console.error("[alert-notify]", err));
}

/* ── Alert evaluation (unchanged logic) ─────────────────────── */
function _getPattern(pd, cd) {
  if (pd > 0 && cd < 0) return "PUT↑ CALL↓";
  if (pd < 0 && cd > 0) return "PUT↓ CALL↑";
  return null;
}

function _threshold(delta, curChg, prevChg, T=25) {
  const denom = Math.abs(prevChg) > 0 ? Math.abs(prevChg) : Math.abs(curChg);
  if (denom > 0) { const pct = (Math.abs(delta)/denom)*100; return { pct, met: pct>=T }; }
  if (delta !== 0) return { pct: Infinity, met: T<=0 };
  return { pct: null, met: false };
}

function evaluateAlertConditions(sym, support, resistance) {
  if (!Array.isArray(support)||support.length<2||!Array.isArray(resistance)||resistance.length<2) return;
  const sc=support.at(-1), sp=support.at(-2), rc=resistance.at(-1), rp=resistance.at(-2);
  if (!sc||!sp||!rc||!rp) return;

  const spd=+(sc.put_delta??0), scd=+(sc.call_delta??0);
  const rpd=+(rc.put_delta??0), rcd=+(rc.call_delta??0);

  const key = `${sym}|COMBINED|${sc.timestamp}|${rc.timestamp}`;
  if (symState[sym].alertHistory.has(key)) return;

  const sP = _getPattern(spd, scd), rP = _getPattern(rpd, rcd);
  if (!sP || !rP || sP !== rP) { console.log(`[ALERT:${sym}] no match s=${sP} r=${rP}`); return; }

  symState[sym].alertHistory.add(key);

  const T = 25;
  const tSPD = _threshold(spd, +(sc.put_chg_oi??0),  +(sp.put_chg_oi??0),  T);
  const tSCD = _threshold(scd, +(sc.call_chg_oi??0), +(sp.call_chg_oi??0), T);
  const tRPD = _threshold(rpd, +(rc.put_chg_oi??0),  +(rp.put_chg_oi??0),  T);
  const tRCD = _threshold(rcd, +(rc.call_chg_oi??0), +(rp.call_chg_oi??0), T);
  const thMet = tSPD.met||tSCD.met||tRPD.met||tRCD.met;

  const metrics = [];
  if (tSPD.met&&tSPD.pct!=null) metrics.push(`Sup Put Δ (${isFinite(tSPD.pct)?tSPD.pct.toFixed(2):"∞"}%)`);
  if (tSCD.met&&tSCD.pct!=null) metrics.push(`Sup Call Δ (${isFinite(tSCD.pct)?tSCD.pct.toFixed(2):"∞"}%)`);
  if (tRPD.met&&tRPD.pct!=null) metrics.push(`Res Put Δ (${isFinite(tRPD.pct)?tRPD.pct.toFixed(2):"∞"}%)`);
  if (tRCD.met&&tRCD.pct!=null) metrics.push(`Res Call Δ (${isFinite(tRCD.pct)?tRCD.pct.toFixed(2):"∞"}%)`);

  const body =
    _formatDetail("Symbol",            sym)                   +
    _formatDetail("Pattern",           sP)                    +
    _formatDetail("Timestamp",         sc.timestamp ?? "—")   +
    _formatDetail("CMP",               fmtNum(sc.cmp))        +
    _formatDetail("Support Strike",    sc.strike ?? "—")      +
    _formatDetail("Sup PUT Δ",         fmtDelta(spd))         +
    _formatDetail("Sup CALL Δ",        fmtDelta(scd))         +
    _formatDetail("Resistance Strike", rc.strike ?? "—")      +
    _formatDetail("Res PUT Δ",         fmtDelta(rpd))         +
    _formatDetail("Res CALL Δ",        fmtDelta(rcd))         +
    (metrics.length ? _formatDetail("Triggered", metrics.join(" &amp; ")) : "") +
    `<div class="toast-detail-extra">Directional ✓${thMet ? " &nbsp;|&nbsp; Threshold ✓" : ""}</div>`;

  const title = thMet
    ? `🚨 ${sym} ALERT — ${sP} — Directional + Threshold`
    : `🚨 ${sym} ALERT — ${sP} — Directional Fulfilled`;

  _showPopupAlert(sym, title, body);

  _notifyBackendAlert(sym, title, sc, rc, sP, spd, scd, rpd, rcd, thMet, metrics);

  console.log(`[ALERT:${sym}] ${sP} threshold=${thMet}`);
}

/* ── Formatting ──────────────────────────────────────────────── */
function fmtNum(n) {
  if (n==null||n===""||isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN");
}
function fmtDelta(n) {
  if (n==null||isNaN(n)) return "—";
  const s = Number(n).toLocaleString("en-IN");
  return n > 0 ? `+${s}` : s;
}

/* ══════════════════════════════════════════════════════════════
   NEW (additive): THREE INDEPENDENT PRICE LEVELS (Entry / Target / SL)
   - The crossing-detection algorithm and the 5-close rolling breakout
     algorithm are UNCHANGED from the single-level implementation —
     they are only now applied independently per level key.
   - Only ONE breakout tracking session is ever active per symbol: the
     most recently crossed level. Crossing a different configured level
     discards the in-progress tracker and starts a fresh one.
   ══════════════════════════════════════════════════════════════ */

const LEVEL_KEYS   = ["entry", "target", "sl"];
const LEVEL_LABELS = { entry: "Entry", target: "Target", sl: "SL" };

/* symbol -> { entry, target, sl } active numeric levels */
const priceLevelsMulti = {};

/* symbol -> { entry:{side}, target:{side}, sl:{side} } */
const _priceLevelStateMulti = {};

/* symbol -> { entry:bool, target:bool, sl:bool } — freshly-set flags,
   same purpose as the old single-level dirty flag, per key now. */
const _priceLevelDirtyMulti = {};

/* NEW: ±0.1% band tolerance for the combined Pro-Level alert (unchanged
   from before), applied independently per level key. */
const PRO_LEVEL_BAND_PCT = 0.001;

/* symbol -> { entry:{inBand}, target:{inBand}, sl:{inBand} } */
const _proBandStateMulti = {};

/* symbol -> the single active rolling 5-close breakout tracker, tagged
   with which level key (entry/target/sl) currently owns it. */
const _breakoutTracker = {};

function _initPriceLevelsFromPicker(symbols) {
  symbols.forEach(sym => {
    const raw = _priceLevels[sym] || {};
    priceLevelsMulti[sym]      = {};
    _priceLevelStateMulti[sym] = {};
    _priceLevelDirtyMulti[sym] = {};
    _proBandStateMulti[sym]    = {};
    LEVEL_KEYS.forEach(key => {
      _priceLevelStateMulti[sym][key] = { side: null };
      _proBandStateMulti[sym][key]    = { inBand: false };
      const v = raw[key];
      if (v !== undefined && v !== "" && !isNaN(parseFloat(v))) {
        priceLevelsMulti[sym][key] = parseFloat(v);
        _priceLevelDirtyMulti[sym][key] = true;
      }
    });
  });
}

/* Reflect a symbol's three levels into the dashboard header inputs. */
function _reflectPriceLevelInputs(sym) {
  const lv = priceLevelsMulti[sym] || {};
  const e = document.getElementById("priceLevelEntryInput");
  const t = document.getElementById("priceLevelTargetInput");
  const s = document.getElementById("priceLevelSLInput");
  if (e) e.value = lv.entry  ?? "";
  if (t) t.value = lv.target ?? "";
  if (s) s.value = lv.sl     ?? "";
}

/* Dedicated TOP-of-screen alert renderer (unchanged). */
function _showTopAlert(sym, title, bodyHtml, cssClass, duration = ALERT_DURATION_MS) {
  const c = document.getElementById("topAlertContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `top-alert ${cssClass}`;
  el.innerHTML = `<div class="top-alert-body"><strong>${title}</strong>
      <div class="top-alert-details">${bodyHtml}</div></div>
    <button class="top-alert-close" aria-label="Dismiss">×</button>`;
  el.querySelector(".top-alert-close")?.addEventListener("click", () => _removeEl(el), { once: true });
  c.appendChild(el);
  setTimeout(() => _removeEl(el), duration);
}

/* Reads the existing directional pattern condition (read-only reuse of
   the unmodified _getPattern helper). */
function _currentDirectionalPattern(support, resistance) {
  if (!Array.isArray(support) || support.length < 2 || !Array.isArray(resistance) || resistance.length < 2) return null;
  const sc = support.at(-1), rc = resistance.at(-1);
  if (!sc || !rc) return null;
  const spd = +(sc.put_delta ?? 0), scd = +(sc.call_delta ?? 0);
  const rpd = +(rc.put_delta ?? 0), rcd = +(rc.call_delta ?? 0);
  const sP = _getPattern(spd, scd), rP = _getPattern(rpd, rcd);
  return (sP && rP && sP === rP) ? sP : null;
}

/* After a level-crossing alert fires, ask whether to change that
   specific level (Entry/Target/SL). Editing it invalidates its
   breakout tracker if that level currently owns it. */
function _promptPriceLevelUpdate(sym, key) {
  const label = LEVEL_LABELS[key] || "Level";
  const changeIt = confirm(`Do you want to change the ${label} level for ${sym}? (OK = Yes, Cancel = No)`);
  if (!changeIt) return;
  const current = priceLevelsMulti[sym]?.[key] ?? "";
  const val = prompt(`Enter new ${label} level for ${sym}:`, current);
  if (val === null || val.trim() === "" || isNaN(parseFloat(val))) return;
  const newLevel = parseFloat(val);

  if (!priceLevelsMulti[sym]) priceLevelsMulti[sym] = {};
  priceLevelsMulti[sym][key] = newLevel;
  if (!_priceLevelStateMulti[sym]) _priceLevelStateMulti[sym] = {};
  _priceLevelStateMulti[sym][key] = { side: null };
  if (!_priceLevelDirtyMulti[sym]) _priceLevelDirtyMulti[sym] = {};
  _priceLevelDirtyMulti[sym][key] = true;
  if (_breakoutTracker[sym] && _breakoutTracker[sym].key === key) delete _breakoutTracker[sym];

  if (sym === activeSymbol) _reflectPriceLevelInputs(sym);

  fetch(`/api/price-level/${sym}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ levels: priceLevelsMulti[sym] }),
  }).catch(err => console.error("[price-level-update]", err));
}

/* ══════════════════════════════════════════════════════════════
   Core evaluator — runs the UNCHANGED single-level algorithm
   (crossing detection → level alert → 5-close breakout tracking)
   independently for entry/target/sl. Whichever level is crossed
   MOST RECENTLY becomes the sole active breakout tracker; crossing
   a different level discards the previous tracker and its stored
   closes, exactly as specified.
   ══════════════════════════════════════════════════════════════ */
function evaluatePriceLevelAlerts(sym, support, resistance, current, isNewClose) {
  const levels = priceLevelsMulti[sym];
  if (!levels) return;
  if (!current || current.cmp === undefined || current.cmp === null) return;
  const cmp = +current.cmp;

  if (!_priceLevelStateMulti[sym]) _priceLevelStateMulti[sym] = {};
  if (!_priceLevelDirtyMulti[sym]) _priceLevelDirtyMulti[sym] = {};
  if (!_proBandStateMulti[sym])    _proBandStateMulti[sym]    = {};

  let newlyCrossedKey = null;

  LEVEL_KEYS.forEach(key => {
    const level = levels[key];
    if (level === undefined || level === null || isNaN(level)) return;

    // Same two-state crossing logic as the original single-level system.
    const newSide = cmp >= level ? "above" : "below";
    if (!_priceLevelStateMulti[sym][key]) _priceLevelStateMulti[sym][key] = { side: null };
    const prevSide = _priceLevelStateMulti[sym][key].side;

    const justSet = _priceLevelDirtyMulti[sym][key] === true;
    const matched = justSet ? false : (prevSide !== null && newSide !== prevSide);
    if (justSet) _priceLevelDirtyMulti[sym][key] = false;
    _priceLevelStateMulti[sym][key].side = newSide;

    /* ── Level alert — unchanged crossing behaviour, per level ───────── */
    if (matched) {
      const label = LEVEL_LABELS[key];
      const detail = _formatDetail("CMP", fmtNum(cmp)) + _formatDetail(`${label} Level`, fmtNum(level));
      const title  = `🔔 ${label} Level Matched for ${sym}`;
      _showTopAlert(sym, title, detail, "top-alert-price");
      fetch("/api/alert-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message:
          `${title}\nSymbol: ${sym}\nLevel Type: ${label}\nCMP: ${fmtNum(cmp)}\n${label} Level: ${fmtNum(level)}` }),
      }).catch(err => console.error("[alert-notify]", err));

      newlyCrossedKey = key; // most recent crossing wins (see below)
      setTimeout(() => _promptPriceLevelUpdate(sym, key), 300);
    }

    /* ── Pro-Level (±0.1% band + directional), independently per level ── */
    const lowerBand = level * (1 - PRO_LEVEL_BAND_PCT);
    const upperBand = level * (1 + PRO_LEVEL_BAND_PCT);
    const inBand    = cmp >= lowerBand && cmp <= upperBand;
    if (!_proBandStateMulti[sym][key]) _proBandStateMulti[sym][key] = { inBand: false };
    const wasInBand = _proBandStateMulti[sym][key].inBand;

    if (inBand && !wasInBand) {
      const pattern = _currentDirectionalPattern(support, resistance);
      if (pattern) {
        _proBandStateMulti[sym][key].inBand = true;
        const label = LEVEL_LABELS[key];
        const detail = _formatDetail("CMP", fmtNum(cmp)) + _formatDetail(`${label} Level`, fmtNum(level)) +
                       _formatDetail("Band", `${fmtNum(lowerBand)} – ${fmtNum(upperBand)}`);
        const title  = `🚨 ${label} Level + Directional Pattern Matched for ${sym}`;
        _showTopAlert(sym, title, detail + _formatDetail("Pattern", pattern), "top-alert-pro");
        fetch("/api/alert-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message:
            `${title}\nSymbol: ${sym}\nLevel Type: ${label}\nCMP: ${fmtNum(cmp)}\n${label} Level: ${fmtNum(level)}\n` +
            `Band: ${fmtNum(lowerBand)} - ${fmtNum(upperBand)}\nPattern: ${pattern}` }),
        }).catch(err => console.error("[alert-notify]", err));
      }
    } else if (!inBand && wasInBand) {
      _proBandStateMulti[sym][key].inBand = false;
    }
  });

  /* ── Active tracking rule: newest crossed level always wins. Discard
     any in-progress tracker (and its stored closes) the instant a
     different level is crossed, and start fresh for the new one. ──── */
  if (newlyCrossedKey) {
    _breakoutTracker[sym] = {
      key: newlyCrossedKey,
      level: levels[newlyCrossedKey],
      crossingCmp: cmp,
      window: [],
      complete: false,
    };
  }

  /* ── Rolling 5-close breakout — UNCHANGED algorithm, applied only to
     whichever level currently owns the single active tracker. ──────── */
  _advanceBreakoutTracker(sym, cmp, isNewClose);
}

/* UNCHANGED breakout algorithm; only the alert copy now names which
   level (Entry/Target/SL) is being tracked. */
function _advanceBreakoutTracker(sym, cmp, isNewClose) {
  if (!isNewClose) return;
  const tr = _breakoutTracker[sym];
  if (!tr) return;

  if (!tr.complete) {
    tr.window.push(cmp);
    if (tr.window.length >= 5) tr.complete = true;
    return;
  }

  const windowMax = Math.max(...tr.window);
  if (cmp > windowMax) {
    const label = LEVEL_LABELS[tr.key] || "Level";
    const title = `📈 ${label} Breakout Alert for ${sym}`;
    const detail =
      _formatDetail(`${label} Level`,     fmtNum(tr.level)) +
      _formatDetail("First Crossing CMP", fmtNum(tr.crossingCmp)) +
      _formatDetail("Stored Closes",      tr.window.map(v => fmtNum(v)).join(", ")) +
      _formatDetail("Previous Max",       fmtNum(windowMax)) +
      _formatDetail("Current CMP",        fmtNum(cmp));
    _showTopAlert(sym, title,
      detail + `<div class="toast-detail-extra">Current closing price exceeded the previous 5-close maximum.</div>`,
      "top-alert-breakout");
    fetch("/api/alert-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message:
        `${title}\nSymbol: ${sym}\nLevel Type: ${label}\n${label} Level: ${fmtNum(tr.level)}\nFirst Crossing CMP: ${fmtNum(tr.crossingCmp)}\n` +
        `Stored Closes: ${tr.window.join(", ")}\nPrevious Max: ${fmtNum(windowMax)}\nCurrent CMP: ${fmtNum(cmp)}\n` +
        `Current closing price exceeded the previous 5-close maximum.` }),
    }).catch(err => console.error("[alert-notify]", err));
  }

  tr.window.shift();
  tr.window.push(cmp);
}

/* "Set" button in the dashboard header — reads all three fields at once. */
document.addEventListener("DOMContentLoaded", () => {
  const btn  = document.getElementById("setPriceLevelBtn");
  const eInp = document.getElementById("priceLevelEntryInput");
  const tInp = document.getElementById("priceLevelTargetInput");
  const sInp = document.getElementById("priceLevelSLInput");
  if (!btn || !eInp || !tInp || !sInp) return;
  btn.addEventListener("click", () => {
    if (!activeSymbol) return;
    const parsed = {};
    [["entry", eInp], ["target", tInp], ["sl", sInp]].forEach(([key, inp]) => {
      if (inp.value !== "" && !isNaN(parseFloat(inp.value))) parsed[key] = parseFloat(inp.value);
    });

    if (!priceLevelsMulti[activeSymbol])      priceLevelsMulti[activeSymbol]      = {};
    if (!_priceLevelStateMulti[activeSymbol]) _priceLevelStateMulti[activeSymbol] = {};
    if (!_priceLevelDirtyMulti[activeSymbol]) _priceLevelDirtyMulti[activeSymbol] = {};

    LEVEL_KEYS.forEach(key => {
      if (parsed[key] !== undefined) {
        priceLevelsMulti[activeSymbol][key] = parsed[key];
        _priceLevelStateMulti[activeSymbol][key] = { side: null };
        _priceLevelDirtyMulti[activeSymbol][key] = true;
        if (_breakoutTracker[activeSymbol] && _breakoutTracker[activeSymbol].key === key) {
          delete _breakoutTracker[activeSymbol];
        }
      } else {
        delete priceLevelsMulti[activeSymbol][key];
      }
    });

    const summary = LEVEL_KEYS
      .filter(k => priceLevelsMulti[activeSymbol][k] !== undefined)
      .map(k => `${LEVEL_LABELS[k]} ${fmtNum(priceLevelsMulti[activeSymbol][k])}`)
      .join(", ") || "cleared";
    showToast("success", `🔔 Price Levels Set`, `${activeSymbol}: ${summary}`);

    fetch(`/api/price-level/${activeSymbol}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ levels: priceLevelsMulti[activeSymbol] }),
    }).catch(err => console.error("[price-level-set]", err));
  });
});

/* ── Boot ────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  (async () => {
    try {
      const r = await fetch("/api/analysis-state");
      const d = await r.json();
      if (d.started && d.symbols?.length > 0) {
        // NEW (additive): restore the user-selected interval on refresh
        if (d.interval_seconds) CYCLE_INTERVAL = d.interval_seconds * 1000;

        // Restore price levels from backend on page refresh
        try {
          const plResp = await fetch("/api/price-levels");
          const plData = await plResp.json();
          if (plData && typeof plData === "object") {
            for (const [sym, levels] of Object.entries(plData)) {
              priceLevelsMulti[sym]      = {};
              _priceLevelStateMulti[sym] = {};
              _proBandStateMulti[sym]    = {};
              LEVEL_KEYS.forEach(key => {
                _priceLevelStateMulti[sym][key] = { side: null };
                _proBandStateMulti[sym][key]    = { inBand: false };
                if (levels && levels[key] !== undefined && levels[key] !== null) {
                  priceLevelsMulti[sym][key] = parseFloat(levels[key]);
                }
              });
            }
          }
        } catch (_) {}
        _switchToDashboard(d.symbols);
      } else {
        // NEW (additive): show the startup screen instead of jumping
        // straight into the picker, so the user can resume a saved
        // analysis. Clicking "NEW ANALYSIS" there calls _initPicker(),
        // which is completely unchanged.
        _showStartupScreen();
      }
    } catch (_) {
      _showStartupScreen();
    }
  })();
});

/* ══════════════════════════════════════════════════════════════
   NEW (additive): SAVE & RESUME ANALYSIS
   - Does not modify _initPicker, _initDashboard, pollData, pollStatus,
     evaluateAlertConditions, evaluatePriceLevelAlerts, or any chart/
     table rendering function. Resume works by pre-seeding the same
     state those functions already read, so they behave exactly as
     they would for a live session that simply hasn't had a new
     cycle yet.
   ══════════════════════════════════════════════════════════════ */

/* Fetch and render the startup screen: saved analyses + NEW ANALYSIS. */
async function _showStartupScreen() {
  const startupView = document.getElementById("startupView");
  const list = document.getElementById("savedAnalysesList");
  const newBtn = document.getElementById("newAnalysisBtn");
  if (!startupView || !list || !newBtn) { _initPicker(); return; }

  startupView.classList.remove("hidden");

  let saved = [];
  try {
    const r = await fetch("/api/saved-analyses");
    const d = await r.json();
    saved = d.analyses || [];
  } catch (_) { /* ignore, treat as no saved analyses */ }

  list.innerHTML = saved.length
    ? saved.map(name =>
        `<button class="saved-analysis-card" data-name="${name}">💾 ${name}</button>`
      ).join("")
    : `<p class="no-saved-hint">No saved analyses yet.</p>`;

  list.querySelectorAll(".saved-analysis-card").forEach(btn => {
    btn.addEventListener("click", () => _resumeAnalysis(btn.dataset.name));
  });

  newBtn.addEventListener("click", () => {
    startupView.classList.add("hidden");
    document.getElementById("pickerView").classList.remove("hidden");
    _initPicker(); // unchanged existing flow
  }, { once: true });
}

/* Ask the backend to restore a saved session, then rebuild the dashboard
   from it without performing an immediate fresh plot. */
async function _resumeAnalysis(name) {
  try {
    const r = await fetch("/api/resume-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const d = await r.json();
    if (!d.started) {
      alert("Error resuming analysis: " + (d.error || "Unknown error"));
      return;
    }
    document.getElementById("startupView").classList.add("hidden");
    document.getElementById("dashboardView").classList.remove("hidden");
    await _initDashboardResumed(d.symbols, d.client_state || {});
  } catch (e) {
    alert("Network error: " + e.message);
  }
}

/* Rebuilds the dashboard from a resumed session:
   Step 1: render the saved graphs/table/header AS-IS (no new-data toast,
           no alert evaluation — this is just restoring what was saved).
   Step 2-4: start the exact same polling loops as a live session. Since
           lastHistoryLen is pre-seeded to the saved history length, the
           very next genuinely new fetch (after the saved interval
           elapses server-side) is detected by the UNCHANGED pollData()
           exactly like any new cycle — so plotting/alerts continue as
           an extension of the restored history, never as a fresh start. */
async function _initDashboardResumed(symbols, clientState) {
  symbols.forEach(sym => {
    symState[sym] = {
      lastHistoryLen: 0, firstDataLoaded: false,
      lastNewDataTime: null, isDataFetchInProgress: false,
      alertCycleCount: 0,
      alertHistory: new Set((clientState.alertHistory && clientState.alertHistory[sym]) || []),
    };
  });

  const sel = document.getElementById("symbolSelector");
  const preferredActive = clientState.activeSymbol && symbols.includes(clientState.activeSymbol)
    ? clientState.activeSymbol : symbols[0];
  sel.innerHTML = symbols.map((s, i) =>
    `<option value="${s}" ${s === preferredActive ? "selected" : ""}>${s}</option>`
  ).join("");
  activeSymbol = preferredActive;
  document.getElementById("priceLabelText").textContent = activeSymbol;

  // Restore the additive Price-Level / Pro-Level / Breakout feature state
  // exactly as it was when saved (does not touch the systems themselves).
  if (clientState.priceLevelsMulti) {
    Object.entries(clientState.priceLevelsMulti).forEach(([sym, lv]) => { priceLevelsMulti[sym] = lv || {}; });
  }
  if (clientState.priceLevelSideMulti) {
    Object.entries(clientState.priceLevelSideMulti).forEach(([sym, sides]) => {
      _priceLevelStateMulti[sym] = {};
      LEVEL_KEYS.forEach(key => { _priceLevelStateMulti[sym][key] = { side: (sides && sides[key]) ?? null }; });
    });
  }
  if (clientState.proBandStateMulti) {
    Object.entries(clientState.proBandStateMulti).forEach(([sym, bands]) => {
      _proBandStateMulti[sym] = {};
      LEVEL_KEYS.forEach(key => { _proBandStateMulti[sym][key] = { inBand: !!(bands && bands[key]) }; });
    });
  }
  if (clientState.breakoutTrackers) {
    Object.entries(clientState.breakoutTrackers).forEach(([sym, tr]) => {
      if (tr) _breakoutTracker[sym] = tr;
    });
  }
  if (clientState.cycleIntervalMs) CYCLE_INTERVAL = clientState.cycleIntervalMs;

  _reflectPriceLevelInputs(activeSymbol);

  initCharts();
  _resetCheckboxes();
  _applyToastPosition(activeSymbol);

  // Step 1: restore saved graphs/table/header for every symbol, marking
  // each as "already loaded" so the next poll doesn't treat this as new.
  for (const sym of symbols) {
    try {
      const r = await fetch(`/api/data/${sym}`);
      const data = await r.json();
      _cachedApiResponse[sym] = data;
      const ss = symState[sym];
      ss.lastHistoryLen  = data.history_len || 0;
      ss.firstDataLoaded = true;
      ss.lastNewDataTime = Date.now();
      if (sym === activeSymbol) {
        updateHeader(data.current);
        updateCharts(data.support || [], data.resistance || [], sym);
        updateTable(data.support || [], data.resistance || []);
        updateStatusUI(data.status || {}, sym);
      }
    } catch (e) {
      console.error(`[resume:${sym}]`, e);
    }
  }
  hideOverlay();

  // Step 2-4: resume normal polling. pollData/pollStatus are completely
  // unchanged; because lastHistoryLen is pre-seeded above, everything
  // downstream behaves exactly as it would mid-session.
  symbols.forEach(sym => {
    setInterval(() => { if (!symState[sym].isDataFetchInProgress) pollData(sym); }, DATA_POLL_MS);
  });

  pollStatus();
  setInterval(pollStatus, STATUS_POLL_MS);

  setInterval(() => {
    const phase    = document.getElementById("statusMsg")?.textContent ?? "";
    const fetching = /downloading|clicking|opening|connecting/i.test(phase);
    _updateCountdownDisplay(fetching);
  }, 1000);

  showToast("info", "📂 Analysis resumed",
    `Monitoring: ${symbols.join(", ")} — continuing from saved state…`, 6000);
}

/* "Save" button — a standalone listener, independent of the boot sequence. */
document.addEventListener("DOMContentLoaded", () => {
  const saveBtn = document.getElementById("saveAnalysisBtn");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", async () => {
    if (!Object.keys(symState).length) {
      alert("Nothing to save yet — start an analysis first.");
      return;
    }
    const name = prompt("Save analysis as:", "");
    if (!name || !name.trim()) return;

    // Gather the additive-feature client-side state so a resume can
    // restore it exactly. Does not read/alter any core alert logic.
    const alertHistory = {};
    const breakoutTrackers = {};
    const priceLevelSideMulti = {};
    const proBandStateMulti = {};
    Object.keys(symState).forEach(sym => {
      alertHistory[sym] = [...(symState[sym].alertHistory || [])];
    });
    Object.keys(_breakoutTracker).forEach(sym => { breakoutTrackers[sym] = _breakoutTracker[sym]; });
    Object.keys(_priceLevelStateMulti).forEach(sym => {
      priceLevelSideMulti[sym] = {};
      LEVEL_KEYS.forEach(key => { priceLevelSideMulti[sym][key] = _priceLevelStateMulti[sym]?.[key]?.side ?? null; });
    });
    Object.keys(_proBandStateMulti).forEach(sym => {
      proBandStateMulti[sym] = {};
      LEVEL_KEYS.forEach(key => { proBandStateMulti[sym][key] = !!_proBandStateMulti[sym]?.[key]?.inBand; });
    });

    const client_state = {
      activeSymbol,
      priceLevelsMulti: JSON.parse(JSON.stringify(priceLevelsMulti)),
      priceLevelSideMulti,
      proBandStateMulti,
      breakoutTrackers,
      alertHistory,
      cycleIntervalMs: CYCLE_INTERVAL,
    };

    try {
      const r = await fetch("/api/save-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), client_state }),
      });
      const d = await r.json();
      if (d.ok) {
        showToast("success", "💾 Analysis Saved", `Saved as "${d.name}"`, 4000);
      } else {
        alert("Error saving: " + (d.error || "Unknown error"));
      }
    } catch (e) {
      alert("Network error: " + e.message);
    }
  });
});