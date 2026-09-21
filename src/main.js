const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let baseLogs = [], sortStack = [], openPanels = new Set();
let logChart = null, isInteracting = false, lastFetchTime = 0;
let isArchiveMode = false, isAdvancedMode = false;

// UI Cache Framework Variables
let elContainer, elSearch, elCmd, elWrapper, elToggle, elRefresh, elStatusText, elStatusDot;
let elLogName, elLimit;

const parseDate = (ts) => {
    if (!ts || ts === "0") return "N/A";
    const date = ts.length > 13 ? new Date(parseInt(ts) / 1000) : new Date(parseInt(ts));
    if (isNaN(date.getTime())) return ts;
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};

function getSeverity(priority) {
    const p = parseInt(priority);
    // Strict, non-overlapping bounds matching the system standards
    if (p === 1) return { color: "#ef4444", label: "CRITICAL", bg: "rgba(239, 68, 68, 0.12)" };
    if (p === 2) return { color: "#f97316", label: "ERROR", bg: "rgba(249, 115, 22, 0.12)" };
    if (p === 3) return { color: "#38bdf8", label: "WARNING", bg: "rgba(56, 189, 248, 0.12)" };
    if (p === 0 || p === 4) return { color: "#10b981", label: "AUDIT/INFO", bg: "rgba(16, 185, 129, 0.12)" };
    return { color: "#38bdf8", label: "INFO", bg: "rgba(56, 189, 248, 0.12)" };
}

async function exportLogs() {
    if (!baseLogs.length) return;
    try {
        await invoke("save_logs_to_file", { jsonData: JSON.stringify(baseLogs, null, 2) });
    } catch (err) { console.error(err); }
}

function importLogs(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            if (!Array.isArray(importedData)) return;
            isArchiveMode = true;
            baseLogs = importedData;
            if (elStatusText) elStatusText.innerText = "ARCHIVE VIEW";
            if (elStatusDot) elStatusDot.className = "archive-dot";
            renderLogs();
            updatePulseChart(baseLogs);
        } catch { alert("Failed to parse file."); }
    };
    reader.readAsText(file);
}

function updatePulseChart(logs) {
    const buckets = {};
    [...logs].reverse().forEach(l => {
        const ts = parseInt(l.last_seen);
        const d = new Date(l.last_seen.length > 13 ? ts / 1000 : ts);
        const key = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        buckets[key] = (buckets[key] || 0) + l.count;
    });
    
    const labels = Object.keys(buckets), data = Object.values(buckets);

    if (logChart) {
        logChart.data.labels = labels;
        logChart.data.datasets[0].data = data;
        logChart.update();
    } else {
        const canvas = document.getElementById('pulseChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        
        const gradient = ctx.createLinearGradient(0, 0, 0, 140);
        gradient.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
        gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

        logChart = new Chart(ctx, {
            type: 'line',
            data: { 
                labels, 
                datasets: [{ 
                    data, 
                    borderColor: '#38bdf8', 
                    borderWidth: 2.5, 
                    backgroundColor: gradient, 
                    fill: true, 
                    tension: 0.35, 
                    pointBackgroundColor: '#38bdf8'
                }] 
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { 
                    x: { ticks: { color: '#475569', font: { size: 9 } } }, 
                    y: { ticks: { color: '#475569', font: { size: 9 } } } 
                } 
            }
        });
    }
}

// Generates dynamic fallback flags depending on what UI options are available
function syncCommandPlaceholder() {
    const logName = elLogName ? elLogName.value : "System";
    const limit = elLimit ? elLimit.value : "150";
    const checkedLevels = [];
    document.querySelectorAll('.severity-check:checked').forEach(cb => { checkedLevels.push(cb.value); });
    
    let builtPayload = "";
    if (checkedLevels.length > 0) {
        let levelsStr = checkedLevels.join(",");
        builtPayload = `LogName=${logName} Level=${levelsStr}`;
    } else {
        builtPayload = `LogName=${logName}`;
    }
    
    if (!elCmd) return builtPayload;
    if (!elCmd.getAttribute('data-dirty')) elCmd.value = builtPayload;
    return elCmd.value;
}

async function fetchLogs(manual = false) {
    const now = Date.now();
    if (isArchiveMode && !manual) return;
    if (!manual && (isInteracting || (now - lastFetchTime < 3000))) return;
    
    if (manual && elStatusText) elStatusText.innerText = "REFRESHING...";
    lastFetchTime = now;
    let executionFlags = syncCommandPlaceholder();

    try {
        baseLogs = await invoke("fetch_deduplicated_logs", { flags: executionFlags });
        renderLogs();
        updatePulseChart(baseLogs);
        if (elStatusText) elStatusText.innerText = isArchiveMode ? "ARCHIVE VIEW" : "LIVE STREAM ACTIVE";
    } catch (e) { console.error(e); }
}

function updateSortUI() {
    document.querySelectorAll('.btn-sort').forEach(btn => {
        const key = btn.getAttribute('data-sort');
        const sortObj = sortStack.find(s => s.key === key);
        btn.classList.toggle('active-filter', !!sortObj);
    });
}

function renderLogs() {
    if (!elContainer) return;
    let displayData = [...baseLogs];

    const searchVal = elSearch ? elSearch.value.toLowerCase().trim() : "";
    if (searchVal) {
        displayData = displayData.filter(log => 
            log.sender.toLowerCase().includes(searchVal) || 
            log.message.toLowerCase().includes(searchVal) ||
            (log.sys_id && log.sys_id.toLowerCase().includes(searchVal)) ||
            log.count.toString().includes(searchVal)
        );
    }

    if (sortStack.length > 0) {
        displayData.sort((a, b) => {
            for (const sort of sortStack) {
                let aVal = a[sort.key], bVal = b[sort.key];
                
                if (sort.key === 'sys_id') {
                    // Safe numeric extraction fallback to sort numeric IDs cleanly
                    const numA = parseInt(String(aVal || '0').replace(/\D/g, '')) || 0;
                    const numB = parseInt(String(bVal || '0').replace(/\D/g, '')) || 0;
                    if (numA !== numB) return sort.direction === 'asc' ? numA - numB : numB - numA;
                } else if (['count', 'priority', 'last_seen'].includes(sort.key)) {
                    aVal = parseFloat(aVal) || 0; bVal = parseFloat(bVal) || 0;
                    if (sort.key === 'priority') [aVal, bVal] = [bVal, aVal];
                } else {
                    aVal = String(aVal || '').toLowerCase(); bVal = String(bVal || '').toLowerCase();
                }
                if (aVal !== bVal) return sort.direction === 'asc' ? (aVal < bVal ? -1 : 1) : (aVal > bVal ? -1 : 1);
            }
            return 0;
        });
    }

    elContainer.innerHTML = "";
    displayData.forEach(log => {
        const systemId = log.sys_id || "0";
        const logKey = `${log.sender}-${log.message}-${systemId}`, isOpen = openPanels.has(logKey), sev = getSeverity(log.priority);
        const card = document.createElement('div');
        card.className = "log-item";

        // Rearranged Layout Matrix: [ Sender | Timeframe | ID/PID Column | Hits | Severity ]
        card.innerHTML = `
            <div class="summary-grid">
                <div class="col-sender">${log.sender}</div>
                <div class="col-timeframe">${parseDate(log.last_seen)}</div>
                <div class="col-sysid">${systemId}</div>
                <div class="col-hits">${log.count} hits</div>
                <div class="col-severity">
                    <span class="severity-pill" style="color:${sev.color}; background:${sev.bg}">${sev.label}</span>
                </div>
            </div>
            ${isOpen ? `
                <div class="details-pane">
                    <div class="msg-block">${log.message}</div>
                    <div class="instance-grid">
                        <div class="instance-box"><strong>First Known Occurrence</strong>${parseDate(log.first_seen)}</div>
                        <div class="instance-box"><strong>Most Recent Occurrence</strong>${parseDate(log.last_seen)}</div>
                    </div>
                    <button class="find-btn">🔍 Search for a solution</button>
                    <div class="history-section">
                        <div class="history-title">Error History</div>
                        <div class="history-scroll">
                            ${log.history.map(t => `<div class="history-row">${parseDate(t)}</div>`).reverse().join("")}
                        </div>
                    </div>
                </div>` : ''}
        `;

        card.onclick = (e) => {
            if (e.target.closest('.find-btn') || e.target.closest('.history-scroll')) return;
            openPanels.has(logKey) ? openPanels.delete(logKey) : openPanels.add(logKey);
            renderLogs();
        };

        if (isOpen) {
            card.querySelector('.find-btn').onclick = (e) => {
                e.stopPropagation();
                invoke("open_link", { url: `https://www.google.com/search?q=${encodeURIComponent(log.sender + ' ' + systemId + ' ' + log.message.substring(0, 60))}` });
            };
        }
        elContainer.appendChild(card);
    });
}

window.addEventListener("DOMContentLoaded", () => {
    elContainer = document.getElementById("log-container");
    elSearch = document.getElementById("log-search");
    elWrapper = document.getElementById("advanced-wrapper");
    elToggle = document.getElementById("toggle-advanced");
    elRefresh = document.getElementById("manual-refresh");
    elStatusText = document.getElementById("status-text");
    elStatusDot = document.querySelector(".pulse-dot") || document.querySelector(".archive-dot");
    
    elCmd = document.getElementById("advanced-command");
    elLogName = document.getElementById("config-logname");
    elLimit = document.getElementById("config-limit");

    if (elSearch) elSearch.oninput = renderLogs;

    if (elToggle) {
        elToggle.onclick = () => {
            isAdvancedMode = !isAdvancedMode;
            elToggle.style.color = isAdvancedMode ? "var(--accent-green)" : "var(--text-dim)";
            if (elWrapper) elWrapper.style.display = isAdvancedMode ? "block" : "none";
            if (isAdvancedMode && elCmd) elCmd.focus();
        };
    }

    if (elCmd) elCmd.onkeydown = (e) => { if (e.key === "Enter") fetchLogs(true); };
    if (elRefresh) elRefresh.onclick = () => fetchLogs(true);
    
    const exportBtn = document.getElementById("export-logs");
    if (exportBtn) exportBtn.onclick = exportLogs;
    
    const importBtn = document.getElementById("import-logs"), importInput = document.getElementById("import-input");
    if (importBtn && importInput) { importBtn.onclick = () => importInput.click(); importInput.onchange = importLogs; }

    if (elLogName) elLogName.onchange = () => { fetchLogs(true); };
    if (elLimit) elLimit.oninput = () => { fetchLogs(true); };
    document.querySelectorAll('.severity-check').forEach(cb => {
        cb.onchange = () => { fetchLogs(true); };
    });

    document.querySelectorAll('.btn-sort').forEach(btn => {
        btn.onclick = () => {
            const key = btn.getAttribute('data-sort');
            const idx = sortStack.findIndex(s => s.key === key);
            if (idx === -1) sortStack.unshift({ key, direction: 'desc' });
            else if (sortStack[idx].direction === 'desc') sortStack[idx].direction = 'asc';
            else sortStack.splice(idx, 1);
            updateSortUI(); 
            renderLogs();
        };
    });

    syncCommandPlaceholder();
    invoke("start_live_watch");
    listen("new-log-event", () => fetchLogs(false));
    fetchLogs(false);
});