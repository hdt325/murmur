/**
 * Debug panel module.
 * Provides state inspection, WS message log, pipeline trace, and server log.
 * Operates on shared state (_wsLog, _pipelineTrace) passed in from the main app.
 */

export function createDebugPanel(deps) {
  const { getWsLog, getPipelineTrace, getAppState } = deps;

  let _dbgTab = "state";
  let _dbgStateInterval = null;
  let _dbgSse = null;
  const _serverLogEntries = [];

  function classifyOut(data) {
    if (typeof data !== "string") return "binary";
    const colon = data.indexOf(":");
    return colon > 0 && colon < 20 ? data.slice(0, colon) : data;
  }

  function dbgTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function stopDbgPolling() {
    if (_dbgStateInterval) { clearInterval(_dbgStateInterval); _dbgStateInterval = null; }
    if (_dbgSse) { _dbgSse.close(); _dbgSse = null; }
  }

  function renderDbgTab() {
    stopDbgPolling();
    const c = document.getElementById("dbgContent");
    if (!c) return;
    if (_dbgTab === "state") renderDbgState(c);
    else if (_dbgTab === "messages") renderDbgMessages(c);
    else if (_dbgTab === "pipeline") renderDbgPipeline(c);
    else if (_dbgTab === "server") renderDbgServer(c);
  }

  function renderDbgState(c) {
    function update() {
      const state = getAppState();
      c.innerHTML = `<div class="dbg-state-grid">
        <span class="dbg-state-label">WebSocket</span><span class="dbg-state-val ${state.wsState === "OPEN" ? "ok" : "err"}">${state.wsState}</span>
        <span class="dbg-state-label">Mic</span><span class="dbg-state-val">${state.micState}</span>
        <span class="dbg-state-label">Recording</span><span class="dbg-state-val ${state.recState === "recording" ? "warn" : ""}">${state.recState}</span>
        <span class="dbg-state-label">TTS</span><span class="dbg-state-val ${state.ttsState === "playing" ? "warn" : ""}">${state.ttsState}</span>
        <span class="dbg-state-label">Mode</span><span class="dbg-state-val">${state.mode}</span>
        <span class="dbg-state-label">Muted</span><span class="dbg-state-val">${state.muted}</span>
        <span class="dbg-state-label">WS Log</span><span class="dbg-state-val">${getWsLog().length} msgs</span>
        <span class="dbg-state-label">Pipeline</span><span class="dbg-state-val">${getPipelineTrace().length} events</span>
      </div>`;
    }
    update();
    _dbgStateInterval = setInterval(update, 500);
  }

  function renderDbgMessages(c) {
    function update() {
      const wsLog = getWsLog();
      const rows = wsLog.slice(-100).reverse().map(m => {
        const dir = m.dir === "out" ? "\u2192" : "\u2190";
        const detail = typeof m.data === "string"
          ? m.data.slice(0, 80)
          : (m.data?.type || "binary") + (m.data?.state ? ` (${m.data.state})` : "") + (m.data?.text ? ` "${m.data.text.slice(0, 40)}"` : "");
        return `<div class="dbg-row" onclick="this.nextElementSibling?.classList.toggle('dbg-expanded')||0">
          <span class="dbg-ts">${dbgTime(m.ts)}</span>
          <span class="dbg-dir ${m.dir}">${dir}</span>
          <span class="dbg-type">${m.type}</span>
          <span class="dbg-detail">${detail}</span>
        </div><div class="dbg-expanded" style="display:none">${JSON.stringify(m.data, null, 2)}</div>`;
      }).join("");
      c.innerHTML = rows || '<div style="color:#555;padding:20px;text-align:center">No messages yet</div>';
    }
    update();
    _dbgStateInterval = setInterval(update, 1000);
  }

  function renderDbgPipeline(c) {
    function update() {
      const trace = getPipelineTrace();
      if (!trace.length) {
        c.innerHTML = '<div style="color:#555;padding:20px;text-align:center">No pipeline trace yet</div>';
        return;
      }
      const t0 = trace[0].ts;
      c.innerHTML = trace.map(e => `<div class="dbg-pipeline-row">
        <span class="dbg-pipeline-delta">+${e.ts - t0}ms</span>
        <span class="dbg-pipeline-event">${e.event}</span>
        <span class="dbg-pipeline-detail">${e.detail || ""}</span>
      </div>`).join("");
    }
    update();
  }

  function renderDbgServer(c) {
    c.innerHTML = '<div style="color:#555;padding:8px">Connecting to server log stream...</div>';
    fetch("/debug/log").then(r => r.json()).then(entries => {
      _serverLogEntries.length = 0;
      _serverLogEntries.push(...entries);
      updateServerLog(c);
    }).catch(() => {});
    _dbgSse = new EventSource("/debug/log/stream");
    _dbgSse.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        if (entry.type === "connected") return;
        _serverLogEntries.push(entry);
        if (_serverLogEntries.length > 500) _serverLogEntries.shift();
        updateServerLog(c);
      } catch {}
    };
  }

  function updateServerLog(c) {
    const rows = _serverLogEntries.slice(-100).reverse().map(e => {
      const cat = e.cat || "?";
      const detail = e.detail ? JSON.stringify(e.detail) : "";
      return `<div class="dbg-row">
        <span class="dbg-ts">${dbgTime(e.ts)}</span>
        <span class="dbg-badge ${cat}">${cat}</span>
        <span class="dbg-type">${e.event}</span>
        <span class="dbg-detail">${detail.slice(0, 100)}</span>
      </div>`;
    }).join("");
    c.innerHTML = rows || '<div style="color:#555;padding:20px;text-align:center">No server log entries</div>';
  }

  function toggle() {
    const panel = document.getElementById("debugPanel");
    const isOpen = panel.classList.toggle("open");
    localStorage.setItem("murmur-debug", isOpen ? "1" : "0");
    if (isOpen) renderDbgTab();
    else stopDbgPolling();
  }

  function setTab(tab) {
    _dbgTab = tab;
    renderDbgTab();
  }

  return { toggle, setTab, renderDbgTab, classifyOut, dbgTime, stopDbgPolling };
}
