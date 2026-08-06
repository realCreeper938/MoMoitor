/* MoMoitor Nord Theme Frontend */

/* 全局错误捕获 → 写入后端日志（momonitor.log），便于定位前端运行时错误 */
window.addEventListener('error', (e) => {
    try {
        const loc = `${e.filename || ''}:${e.lineno || '?'}:${e.colno || '?'}`;
        const msg = `${e.message} @ ${loc}`;
        if (window.pywebview && window.pywebview.api) {
            pywebview.api.js_log('error', msg);
        } else {
            console.error(msg);
        }
    } catch (_) { /* 日志本身失败绝不影响应用 */ }
});
window.addEventListener('unhandledrejection', (e) => {
    try {
        const reason = e.reason && e.reason.stack ? e.reason.stack.split('\n')[0] : String(e.reason);
        if (window.pywebview && window.pywebview.api) {
            pywebview.api.js_log('error', 'Unhandled promise rejection: ' + reason);
        } else {
            console.error('Unhandled promise rejection:', reason);
        }
    } catch (_) { /* 日志本身失败绝不影响应用 */ }
});

let pollTimer = null;
let pollGeneration = 0;
let clockTimer = null;
let _clock24 = true; // 时钟 24 小时制；实际值在 startClock 时从设置读取
let _clockShowSeconds = true; // 时钟是否显示秒；实际值在 startClock 时从设置读取
let hwNamesCache = null;

/* Weather settings cache */
let oldWeatherLat = '';
let oldWeatherLon = '';
let oldWeatherKid = '';
let oldWeatherSub = '';
let oldWeatherKey = '';
let cachedAlerts = [];


/* Auto throttle on high CPU */
let userInterval = 1000;
let throttled = false;

/* Monitor settings */
let cachedMonitor = 0;
let cachedHideMissing = false;

/* DOM element cache */
const _uiEls = {};
function getUiEl(id) {
    let el = _uiEls[id];
    if (!el || !document.body.contains(el)) {
        el = document.getElementById(id);
        _uiEls[id] = el;
    }
    return el;
}

/* Temperature warning */
const TEMP_THRESHOLDS = { cpu: 90, gpu: 87, mem: 78, vram: 95 };
let tempWarnings = [];
let tempWarnIdx = 0;
let tempWarnTimer = null;


/* Sparkline chart — 90s resource usage rendered as SVG polyline (CPU/GPU/MEM/FPS/Net) */
const CHART_WINDOW_MS = 90000;
const chartData = { cpu: [], gpu: [], mem: [], fps: [], net_up: [], net_down: [], disk_read: [], disk_write: [] };

function chartPush(key, val, maxVal) {
    const arr = chartData[key];
    if (!arr) return;
    const m = maxVal || 100;
    const now = Date.now();
    arr.push({
        t: now,
        v: val == null || isNaN(val) ? 0 : Math.max(0, Math.min(m, val))
    });
    while (arr.length && arr[0].t < now - CHART_WINDOW_MS) {
        arr.shift();
    }
}

function chartMax(data, dynamicMax) {
    if (!dynamicMax) return 100;
    let max = 1;
    for (let i = 0; i < data.length; i++) {
        if (data[i].v > max) max = data[i].v;
    }
    return max * 1.1; // headroom
}

function hideChartCursor(section) {
    section.querySelectorAll('.spark-cursor').forEach(el => el.style.opacity = '0');
}

/* Focus dim — hovering a monitor box dims all the other boxes to 50% */
function initTermBoxFocusDim() {
    const grid = document.querySelector('.term-grid');
    if (!grid) return;
    const boxes = grid.querySelectorAll('.term-box');
    if (boxes.length < 2) return;
    const setDim = (focused) => {
        boxes.forEach(b => b.classList.toggle('dimmed', !!focused && b !== focused));
    };
    // mouseover/mouseout instead of enter/leave so crossing a grid gap keeps the dim state
    grid.addEventListener('mouseover', (e) => {
        setDim(e.target.closest('.term-box') || null);
    });
    grid.addEventListener('mouseout', (e) => {
        if (!e.relatedTarget || !grid.contains(e.relatedTarget)) setDim(null);
    });
}
initTermBoxFocusDim();

function updateChart(key, dynamicMax) {
    const svg = document.querySelector('.sparkline-bg[data-spark="' + key + '"]');
    if (!svg) return;
    const line = svg.querySelector('.spark-line');
    const area = svg.querySelector('.spark-area');
    if (!line || !area) return;
    const data = chartData[key];
    if (!data || data.length < 2) {
        line.setAttribute('points', '');
        area.setAttribute('points', '');
        return;
    }
    // SVG viewBox 0..100 on both axes: x=time, y=value (flipped, 0=top).
    const max = chartMax(data, dynamicMax);
    const n = data.length;
    const parts = new Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 100;
        const y = 100 - (data[i].v / max) * 100;
        parts[i] = x.toFixed(2) + ',' + y.toFixed(2);
    }
    const linePts = parts.join(' ');
    line.setAttribute('points', linePts);
    // Area = line + close to bottom-right (100,100) and bottom-left (0,100)
    area.setAttribute('points', '0,100 ' + linePts + ' 100,100');

    // Ensure time label exists for this section
    const section = svg.closest('.term-box');
    if (section) {
        let timeLabel = section.querySelector('.spark-time-label');
        if (!timeLabel) {
            timeLabel = document.createElement('div');
            timeLabel.className = 'spark-time-label';
            section.appendChild(timeLabel);
            // Add mousemove handler to the section
            section.addEventListener('mousemove', function(e) {
                const rect = svg.getBoundingClientRect();
                if (rect.width === 0) return;
                const relX = (e.clientX - rect.left) / rect.width;
                const idx = Math.round(relX * (data.length - 1));
                if (idx < 0 || idx >= data.length) {
                    hideChartCursor(section);
                    return;
                }
                const val = data[idx].v;
                if (section.id === 'disk-section') {
                    // disk: no top-left info, cursor only
                    timeLabel.style.opacity = '0';
                } else {
                    const t = data[idx].t;
                    const d = new Date(t);
                    const h = pad2(d.getHours());
                    const m = pad2(d.getMinutes());
                    const s = pad2(d.getSeconds());
                    const timeStr = h + ':' + m + ':' + s;
                    let label = timeStr;
                    if (section.id === 'net-section') {
                        // net has two overlayed series — show both rates at this instant
                        const upd = chartData['net_up'];
                        const downd = chartData['net_down'];
                        const u = formatNet(upd && upd[idx] ? upd[idx].v : 0);
                        const dn = formatNet(downd && downd[idx] ? downd[idx].v : 0);
                        label = timeStr + ' ↑ ' + u.val + ' ' + u.unit + ' ↓ ' + dn.val + ' ' + dn.unit;
                    } else {
                        label = timeStr + ' ' + (dynamicMax ? '' : Math.round(val) + '%');
                    }
                    timeLabel.textContent = label;
                    timeLabel.style.opacity = '1';
                }
                // Cursor: a single vertical line across all chart layers
                const x = relX * 100;
                section.querySelectorAll('.spark-cursor').forEach(el => {
                    el.setAttribute('x1', x.toFixed(2));
                    el.setAttribute('x2', x.toFixed(2));
                    el.style.opacity = '0.5';
                });
            });
            section.addEventListener('mouseleave', function() {
                timeLabel.style.opacity = '0';
                hideChartCursor(section);
            });
        }
    }
}

function updateTempWarnings(d) {
    const warnings = [];
    if (d.cpu.temp != null && d.cpu.temp >= TEMP_THRESHOLDS.cpu) {
        warnings.push('CPU ' + fmt(d.cpu.temp, 0) + '°C');
    }
    if (d.gpu.temp != null && d.gpu.temp >= TEMP_THRESHOLDS.gpu) {
        warnings.push('GPU ' + fmt(d.gpu.temp, 0) + '°C');
    }
    if (d.mem.temp != null && d.mem.temp >= TEMP_THRESHOLDS.mem) {
        warnings.push('MEM ' + fmt(d.mem.temp, 0) + '°C');
    }
    if (d.gpu.vram_temp != null && d.gpu.vram_temp >= TEMP_THRESHOLDS.vram) {
        warnings.push('VRAM ' + fmt(d.gpu.vram_temp, 0) + '°C');
    }

    const el = document.getElementById('temp-warning');
    const textEl = document.getElementById('temp-warning-text');
    if (!el || !textEl) return;

    if (warnings.length === 0) {
        el.style.display = 'none';
        if (tempWarnTimer) { clearInterval(tempWarnTimer); tempWarnTimer = null; }
        tempWarnings = [];
        tempWarnIdx = 0;
        return;
    }

    const changed = warnings.join('|') !== tempWarnings.join('|');
    tempWarnings = warnings;

    if (changed) {
        tempWarnIdx = 0;
        textEl.textContent = ' ' + warnings[0] + ' HIGH TEMP!';
        el.style.display = 'block';

        if (warnings.length > 1 && !tempWarnTimer) {
            tempWarnTimer = setInterval(() => {
                tempWarnIdx = (tempWarnIdx + 1) % tempWarnings.length;
                textEl.textContent = ' ' + tempWarnings[tempWarnIdx] + ' HIGH TEMP!';
            }, 2000);
        } else if (warnings.length <= 1 && tempWarnTimer) {
            clearInterval(tempWarnTimer);
            tempWarnTimer = null;
        }
    }
}

function updateDataError(d) {
    const el = document.getElementById('data-error');
    const textEl = document.getElementById('data-error-text');
    if (!el || !textEl) return;

    if (d.error) {
        textEl.textContent = '󰀦 ' + d.error;
        el.style.display = 'block';
    } else {
        el.style.display = 'none';
    }
}



function fmt(v, d = 0) {
    if (v == null || isNaN(v)) return '--';
    return Number(v).toFixed(d);
}

function setText(id, val) {
    const el = getUiEl(id);
    if (el && el.textContent !== val) el.textContent = val;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function tempColorClass(temp, threshold) {
    if (temp == null || isNaN(temp)) return '';
    if (temp >= threshold) return 'temp-high';
    if (temp >= threshold - 10) return 'temp-warn';
    return 'temp-normal';
}

function fpsColorClass(fps) {
    if (fps == null || isNaN(fps) || fps <= 0) return '';
    if (fps >= 55) return 'fps-good';
    if (fps >= 30) return 'fps-ok';
    return 'fps-bad';
}

function loadAlpha(load) {
    if (load == null || isNaN(load)) return null;
    const clamped = Math.min(100, Math.max(0, load));
    return 0.3 + (clamped / 100) * 0.7;
}

/* CPU/GPU/MEM usage values are always rendered at full opacity — no load-based
 * transparency fade. */
function applyLoadColor(id) {
    const el = getUiEl(id);
    if (!el) return;
    el.className = 'metric-value big mono';
    if (el.style.opacity !== '') el.style.opacity = '';
}

function formatNet(b) {
    if (b == null) return { val: '--', unit: 'KB/s' };
    if (b >= 1048576) return { val: (b / 1048576).toFixed(1), unit: 'MB/s' };
    return { val: Math.round(b / 1024), unit: 'KB/s' };
}

function updateUI(d) {
    // CPU
    const cpuLoad = fmt(d.cpu.load, 0);
    setText('cpu-load', cpuLoad);
    applyLoadColor('cpu-load', d.cpu.load);
    setText('cpu-temp', fmt(d.cpu.temp, 0));
    setText('cpu-power', fmt(d.cpu.power, 1));
    setText('cpu-clock', fmt(d.cpu.clock, 0));
    setText('cpu-voltage', fmt(d.cpu.voltage, 2));
    chartPush('cpu', d.cpu.load);
    updateChart('cpu');

    // CPU temp color
    const cpuTempEl = getUiEl('cpu-temp');
    if (cpuTempEl) cpuTempEl.className = 'mono ' + tempColorClass(d.cpu.temp, TEMP_THRESHOLDS.cpu);

    // Auto throttle
    if (Number.isFinite(d.cpu.load) && d.cpu.load >= 95 && !throttled) {
        throttled = true;
    } else if (Number.isFinite(d.cpu.load) && d.cpu.load < 95 && throttled) {
        throttled = false;
    }

    // GPU
    const gpuLoad = fmt(d.gpu.load, 0);
    setText('gpu-load', gpuLoad);
    applyLoadColor('gpu-load', d.gpu.load);
    setText('gpu-temp', fmt(d.gpu.temp, 0));
    setText('gpu-power', fmt(d.gpu.power, 1));
    setText('gpu-vram-temp', fmt(d.gpu.vram_temp, 0));
    setText('gpu-vram-used', fmt(d.gpu.vram_used_gb, 1));
    setText('gpu-vram-total', fmt(d.gpu.vram_total_gb, 1));
    chartPush('gpu', d.gpu.load);
    updateChart('gpu');

    // GPU temp color
    const gpuTempEl = getUiEl('gpu-temp');
    if (gpuTempEl) gpuTempEl.className = 'mono ' + tempColorClass(d.gpu.temp, TEMP_THRESHOLDS.gpu);

    // Memory
    if (_memCleanPending) {
        // Poll right after a click-clean — count down to the new value
        _memCleanPending = false;
        const cur = getUiEl('mem-pct');
        animateMemPct(parseInt(cur ? cur.textContent : '0', 10) || 0, d.mem.percent);
    } else {
        setText('mem-pct', fmt(d.mem.percent, 0));
        applyLoadColor('mem-pct', d.mem.percent);
    }
    setText('mem-used', fmt(d.mem.used_gb, 1));
    setText('mem-total', fmt(d.mem.total_gb, 1));
    setText('mem-temp', fmt(d.mem.temp, 0));
    setText('mem-clock', fmt(d.mem.clock, 0));
    setText('mem-volt', fmt(d.mem.volt, 2));
    chartPush('mem', d.mem.percent);
    updateChart('mem');

    // Memory temp color
    const memTempEl = getUiEl('mem-temp');
    if (memTempEl) memTempEl.className = 'mono ' + tempColorClass(d.mem.temp, TEMP_THRESHOLDS.mem);

    // Disk
    if (d.disks && d.disks.length > 0) {
        let totalUsed = 0;
        let totalSize = 0;
        for (const dk of d.disks) {
            totalUsed += dk.used_gb || 0;
            totalSize += dk.total_gb || 0;
        }
        const usedFmt = totalUsed >= 1024 ? (totalUsed / 1024).toFixed(1) : Math.round(totalUsed);
        const totalFmt = totalSize >= 1024 ? (totalSize / 1024).toFixed(1) : Math.round(totalSize);
        setText('disk-used', usedFmt);
        setText('disk-total', totalFmt);
    }
    setText('disk-temp', fmt(d.disk_status.temp, 0));
    const dr = formatNet(d.disk_status.read);
    const dw = formatNet(d.disk_status.write);
    setText('disk-read', dr.val);
    setText('disk-read-unit', dr.unit);
    setText('disk-write', dw.val);
    setText('disk-write-unit', dw.unit);
    // Disk read/write sparklines (dynamic max — speeds vary widely)
    chartPush('disk_read', d.disk_status.read || 0, 100 * 1024 * 1024);
    chartPush('disk_write', d.disk_status.write || 0, 100 * 1024 * 1024);
    updateChart('disk_read', true);
    updateChart('disk_write', true);
    // Cache partition data for hover display
    _diskPartitions = d.disks || [];

    // Network
    const up = formatNet(d.net.up);
    const down = formatNet(d.net.down);
    setText('net-up', up.val);
    setText('net-up-unit', up.unit);
    setText('net-down', down.val);
    setText('net-down-unit', down.unit);
    // Network sparklines (dynamic max — speeds vary widely)
    chartPush('net_down', d.net.down || 0, 100 * 1024 * 1024);
    chartPush('net_up', d.net.up || 0, 100 * 1024 * 1024);
    updateChart('net_down', true);
    updateChart('net_up', true);
    const netLabel = getUiEl('net-section')?.querySelector('.box-header');
    if (netLabel) {
        netLabel.textContent = d.net.name ? 'NETWORK · ' + d.net.name : 'Network';
    }

    updateLivePopups(d);
    updateTempWarnings(d);
    updateDataError(d);
}

/* HW live popups (horizontal mode) — live sensor values near the brand logo */
function updateLivePopups(d) {
    setText('cpu-live-load', fmt(d.cpu.load, 0));
    setText('cpu-live-clock', fmt(d.cpu.clock, 0));
    setText('cpu-live-temp', fmt(d.cpu.temp, 0));
    setText('cpu-live-power', fmt(d.cpu.power, 1));
    setText('cpu-live-voltage', fmt(d.cpu.voltage, 2));
    setText('gpu-live-load', fmt(d.gpu.load, 0));
    setText('gpu-live-temp', fmt(d.gpu.temp, 0));
    setText('gpu-live-power', fmt(d.gpu.power, 1));
    setText('gpu-live-vram-used', fmt(d.gpu.vram_used_gb, 1));
    setText('gpu-live-vram-total', fmt(d.gpu.vram_total_gb, 1));
    setText('gpu-live-vram-temp', fmt(d.gpu.vram_temp, 0));
    setText('mem-live-pct', fmt(d.mem.percent, 0));
    setText('mem-live-clock', fmt(d.mem.clock, 0));
    setText('mem-live-volt', fmt(d.mem.volt, 2));
    setText('mem-live-used', fmt(d.mem.used_gb, 1));
    setText('mem-live-total', fmt(d.mem.total_gb, 1));
    setText('mem-live-temp', fmt(d.mem.temp, 0));
    applyLoadColor('cpu-live-load', d.cpu.load);
    applyLoadColor('gpu-live-load', d.gpu.load);
    applyLoadColor('mem-live-pct', d.mem.percent);
}

/* Disk partition data cache for hover display */
let _diskPartitions = [];

function renderDiskPartitions() {
    const container = document.getElementById('disk-partitions');
    if (!container) return;
    const parts = _diskPartitions;
    if (!parts || parts.length === 0) {
        container.innerHTML = '';
        return;
    }
    let html = '';
    for (const p of parts) {
        const pct = p.percent || 0;
        const totalGb = p.total_gb || 0;
        const usedGb = p.used_gb || 0;
        const freeGb = Math.max(0, totalGb - usedGb);
        const useTb = totalGb >= 1024;
        const used = useTb ? (usedGb / 1024).toFixed(1) : Math.round(usedGb);
        const free = useTb ? (freeGb / 1024).toFixed(1) : Math.round(freeGb);
        const unit = useTb ? 'TB' : 'GB';
        const level = pct >= 90 ? 'fill-danger' : (pct >= 70 ? 'fill-warn' : 'fill-ok');
        html += '<div class="disk-part-item">'
            + '<div class="disk-part-top">'
            + '<span class="disk-part-letter">' + p.letter + '</span>'
            + '<span class="disk-part-info">' + Math.round(pct) + '% · free ' + free + unit + '</span>'
            + '</div>'
            + '<div class="disk-part-bar"><div class="disk-part-fill ' + level + '" style="width:' + pct + '%"></div></div>'
            + '</div>';
    }
    container.innerHTML = html;
}

/* FPS */
let _lastFpsColorCls = '__init__';
async function refreshFps() {
    try {
        const f = await pywebview.api.get_fps();

        const fpsEl = document.getElementById('fps-val');
        if (fpsEl) {
            const hasFps = f && Number.isFinite(Number(f.fps)) && Number(f.fps) > 0;
            const fpsStr = hasFps ? fmt(f.fps, 0) : '--';
            if (fpsEl.textContent !== fpsStr) {
                fpsEl.textContent = fpsStr;
            }
            const colorCls = hasFps ? fpsColorClass(f.fps) : '';
            if (_lastFpsColorCls !== colorCls) {
                _lastFpsColorCls = colorCls;
                fpsEl.className = 'metric-value big mono ' + colorCls;
            }
        }

        setText('fps-ft', f ? fmt(f.frametime, 1) : '--');
        setText('fps-low1', f ? fmt(f.low1pct, 0) : '--');
        setText('fps-avg', f ? fmt(f.avg_fps, 0) : '--');
        setText('fps-p99', f ? fmt(f.p99_fps, 0) : '--');

        // FPS sparkline (dynamic max — FPS varies by game)
        const fpsVal = f && Number(f.fps) > 0 ? Number(f.fps) : 0;
        chartPush('fps', fpsVal, 360);
        updateChart('fps', true);

        // FPS header with process name
        const fpsHeader = document.querySelector('#fps-section .box-header');
        if (fpsHeader) fpsHeader.textContent = f && f.process ? 'FPS · ' + f.process : 'FPS';

        // Bottom-right process name (no icon)
        const procEl = document.getElementById('fps-process');
        const procName = document.getElementById('fps-process-name');
        if (procEl && procName) {
            if (f && f.process) {
                procEl.style.display = '';
                procName.textContent = f.process;
            } else {
                procEl.style.display = 'none';
            }
        }
    } catch (e) { console.warn('refreshFps:', e); }
}

/* Top process (CPU/memory) */
let procMode = 'cpu'; // 'cpu' or 'mem'
let procLimit = 5; // how many processes to show — recomputed from font scale + box height

/** Recompute how many process rows fit in the bottom-right list for the current
 *  font scale and available box height, so no empty space is left at the bottom.
 *  Larger fonts → fewer rows; smaller fonts → more rows. */
function recalcProcLimit() {
    const listEl = document.getElementById('proc-list');
    if (!listEl) return;
    const avail = listEl.clientHeight; // available vertical space (box height stays fixed)
    if (avail <= 0) return; // not laid out yet
    const gap = 1; // .proc-list flex gap (px)
    // Prefer measuring a real rendered row; fall back to an estimate from the
    // proc-name font (12px * scale, line-height 1.3).
    let rowH = 12 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1) * 1.3;
    const first = listEl.querySelector('.proc-item');
    if (first) rowH = first.offsetHeight;
    const n = Math.max(1, Math.floor((avail + gap) / (rowH + gap)));
    if (n !== procLimit) {
        procLimit = n;
        refreshTopProcess();
    }
}

async function refreshTopProcess() {
    try {
        const list = await pywebview.api.get_top_processes(procMode, procLimit);
        const listEl = document.getElementById('proc-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        if (!list || list.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'proc-item';
            empty.innerHTML = '<span class="proc-name">--</span><span class="proc-value">--</span>';
            listEl.appendChild(empty);
            return;
        }
        for (const p of list) {
            const item = document.createElement('div');
            item.className = 'proc-item';
            const name = document.createElement('span');
            name.className = 'proc-name';
            name.textContent = p.name || 'unknown';
            name.title = `${p.name || 'unknown'} (PID ${p.pid})`;
            name.dataset.pid = String(p.pid);
            name.dataset.name = p.name || 'unknown';
            const val = document.createElement('span');
            val.className = 'proc-value';
            val.title = procMode === 'mem' ? t('proc-value-mem-hint') : t('proc-value-cpu-hint');
            if (procMode === 'mem') {
                const mb = p.mem_mb != null ? Number(p.mem_mb) : 0;
                if (mb >= 1024) {
                    val.textContent = (mb / 1024).toFixed(1) + 'G';
                } else {
                    val.textContent = mb.toFixed(0) + 'M';
                }
            } else {
                val.textContent = fmt(p.cpu, 1) + '%';
            }
            item.appendChild(name);
            item.appendChild(val);
            listEl.appendChild(item);
        }
    } catch (e) { console.warn('refreshTopProcess:', e); }
}


let pendingKillPid = null;
let pendingKillName = '';

function showKillConfirm(pid, name) {
    pendingKillPid = pid;
    pendingKillName = name;
    const bodyEl = document.getElementById('kill-confirm-body');
    if (bodyEl) {
        bodyEl.textContent = `确定要终止进程 "${name}" (PID ${pid}) 吗？`;
    }
    const overlay = document.getElementById('kill-confirm-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function hideKillConfirm() {
    pendingKillPid = null;
    pendingKillName = '';
    const overlay = document.getElementById('kill-confirm-overlay');
    if (overlay) overlay.style.display = 'none';
}

/* ── 通用应用内确认弹窗（替代 window.confirm）────────────── */
let _appConfirmCb = null;

function showAppConfirm(message, onOk) {
    const body = document.getElementById('app-confirm-body');
    if (body) body.textContent = message;
    _appConfirmCb = onOk;
    const overlay = document.getElementById('app-confirm-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function hideAppConfirm() {
    _appConfirmCb = null;
    const overlay = document.getElementById('app-confirm-overlay');
    if (overlay) overlay.style.display = 'none';
}

/* ── 版本更新检测 ── */
function showUpdateModal(info) {
    const overlay = document.getElementById('update-overlay');
    if (!overlay) return;
    const verEl = document.getElementById('update-version');
    if (verEl) verEl.textContent = (info.current_version || '--') + '  →  ' + (info.latest_version || '--');
    const body = document.getElementById('update-changelog');
    if (body) body.textContent = (info.body || '').trim() || (t && t('update-no-notes')) || 'No release notes.';
    const gotoEl = document.getElementById('update-goto');
    if (gotoEl && info.release_url) gotoEl.href = info.release_url;
    overlay.style.display = 'flex';
}

function hideUpdateModal() {
    const overlay = document.getElementById('update-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function checkForUpdate() {
    try {
        const info = await pywebview.api.check_for_updates();
        if (info && info.has_update) showUpdateModal(info);
    } catch (e) { console.warn('check_for_updates:', e); }
}

async function confirmKill() {
    if (pendingKillPid == null) return;
    const pid = pendingKillPid;
    const name = pendingKillName;
    hideKillConfirm();
    try {
        const r = await pywebview.api.kill_process(pid);
        if (r && r.success) {
            console.warn('进程已终止:', r.message || `已终止 ${name}`);
        } else {
            console.warn('终止失败:', (r && r.message) || '未知错误');
        }
        setTimeout(refreshTopProcess, 500);
    } catch (e) {
        console.warn('confirmKill:', e);
    }
}

async function poll(generation = pollGeneration) {
    try {
        const data = await pywebview.api.get_data();
        if (generation !== pollGeneration) return;
        updateUI(data);
        hideBackendError();
    } catch (e) {
        console.error(e);
        showBackendError();
    } finally {
        if (generation === pollGeneration) {
            pollTimer = setTimeout(() => poll(generation), throttled ? 2000 : userInterval);
        }
    }
}

function showBackendError() {
    const el = document.getElementById('backend-error');
    if (el) el.style.display = 'flex';
}

function hideBackendError() {
    const el = document.getElementById('backend-error');
    if (el) el.style.display = 'none';
}

function startPolling(ms) {
    userInterval = ms;
    pollGeneration += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    poll(pollGeneration);
}

/** Start a feature's refresh interval only when enabled. Tracks intervals
 *  by function name so re-calling (e.g. after settings change) clears the
 *  previous interval instead of stacking duplicates. */
const _intervalMap = new Map();
function _startInterval(enabled, fn, ms) {
    const key = fn.name || String(fn);
    if (_intervalMap.has(key)) {
        clearInterval(_intervalMap.get(key));
        _intervalMap.delete(key);
    }
    if (enabled) {
        fn();
        _intervalMap.set(key, setInterval(fn, ms));
    }
}

/* Music */
let _lastCover = '';

/** Batch-update all cover images with the same source. */
function _updateCovers(cover) {
    const ids = ['h-music-cover'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.src = cover || ''; el.style.display = cover ? '' : 'none'; }
    });
}

async function refreshMusic() {
    try {
        const m = await pywebview.api.get_music();
        const section = document.getElementById('music-section');
        const toggleBtn = document.getElementById('h-music-toggle');

        if (m.available && (m.playing || m.title)) {
            setText('h-music-title', m.title || '--');
            setText('h-music-artist', m.artist || '--');
            const procEl = document.getElementById('h-music-process');
            if (procEl) procEl.textContent = m.process_name || '';
            // Only update cover src when cover data actually changes (i.e. song switched)
            if (m.cover) {
                if (_lastCover !== m.cover) {
                    _lastCover = m.cover;
                    _updateCovers(m.cover);
                }
            } else {
                _lastCover = '';
                _updateCovers('');
            }
            if (section) {
                section.style.display = 'flex';
                section.classList.toggle('paused', !m.playing);
            }
        } else {
            // No music playing: keep the section visible (visibility is controlled
            // by the feature toggle) but show a "not playing" placeholder.
            _lastCover = '';
            _updateCovers('');
            setText('h-music-title', t('music-not-playing'));
            setText('h-music-artist', '');
            const procEl = document.getElementById('h-music-process');
            if (procEl) procEl.textContent = '';
            if (section) section.classList.add('paused');
        }
        if (toggleBtn) {
            // Pause (⏸) while playing, Play (⏵) while paused
            toggleBtn.textContent = m.playing ? '⏸' : '⏵';
        }
    } catch (e) { console.warn('refreshMusic:', e && e.message ? e.message : String(e), e); }
}

/* ── Click MEM % to clean memory (sweep animation + count-down) ── */
let _memCleanPending = false;
let _lastCleanAt = 0;
let _memCleanRestoreTimer = null;
let _memInfoOrig = null;  // pristine info-line HTML, captured once at init

/** Count the big MEM % from its current display value to the cleaned value. */
function animateMemPct(fromVal, toVal) {
    const el = document.getElementById('mem-pct');
    if (!el) return;
    const start = performance.now();
    const dur = 650;
    const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);  // ease-out cubic
        el.textContent = Math.round(fromVal + (toVal - fromVal) * eased);
        if (t < 1) {
            requestAnimationFrame(step);
        } else {
            applyLoadColor('mem-pct', toVal);
        }
    };
    requestAnimationFrame(step);
}

/** Format a byte count as MB or GB for the cleaned-amount line. */
function fmtFreed(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    return Math.round(bytes / (1024 * 1024)) + ' MB';
}

/** Restart the info-line swap animation on an element. */
function animInfoSwap(el) {
    el.classList.remove('info-swap');
    void el.offsetWidth;
    el.classList.add('info-swap');
}

/** Swap the MEM info lines to "已清理 / <amount>" for 5s, then restore them. */
function showMemCleaned(freedBytes, deep) {
    const lines = document.querySelectorAll('#mem-section .box-content .info-line');
    if (lines.length < 2) return;
    if (_memCleanRestoreTimer) { clearTimeout(_memCleanRestoreTimer); _memCleanRestoreTimer = null; }
    const label = deep ? t('mem-cleaned-deep') : t('mem-cleaned');
    lines[0].innerHTML = `<span class="mono mem-clean-status">${label}</span>`;
    lines[1].innerHTML = `<span class="mono mem-clean-status">${fmtFreed(freedBytes)}</span>`;
    animInfoSwap(lines[0]);
    animInfoSwap(lines[1]);
    _memCleanRestoreTimer = setTimeout(() => {
        if (_memInfoOrig) {
            lines[0].innerHTML = _memInfoOrig[0];
            lines[1].innerHTML = _memInfoOrig[1];
            animInfoSwap(lines[0]);
            animInfoSwap(lines[1]);
        }
        _memCleanRestoreTimer = null;
    }, 5000);
}

function initMemCleanClick() {
    const el = document.getElementById('mem-pct');
    if (!el) return;
    el.title = t('mem-clean-hint');
    // Snapshot the original info lines once (re-clicking mid-display must
    // restore the real sensor lines, not the current "已清理" text)
    const lines = document.querySelectorAll('#mem-section .box-content .info-line');
    if (lines.length >= 2) _memInfoOrig = [lines[0].innerHTML, lines[1].innerHTML];
    el.addEventListener('click', async () => {
        const section = document.getElementById('mem-section');
        if (!section) return;
        // Re-click within 3s → deeper cleanup
        const deep = (Date.now() - _lastCleanAt) < 3000;
        // Restart the sweep/pulse/glow animation on every click
        section.classList.remove('cleaning');
        void section.offsetWidth;
        section.classList.add('cleaning');
        setTimeout(() => section.classList.remove('cleaning'), 950);
        try {
            const r = await pywebview.api.clean_memory(deep);
            if (r && r.ok) {
                _lastCleanAt = Date.now();
                _memCleanPending = true;
                showMemCleaned(r.freed_bytes || 0, deep);
            }
        } catch (e) { console.warn('clean_memory:', e); }
    });
}
initMemCleanClick();

/* Hardware names — brand detection retained for header text only; logos removed. */

/* Light themes — everything not in this set is dark */
const LIGHT_THEMES = new Set([
    'gruvbox-light', 'github-light', 'atom-one-light', 'rose-pine-dawn',
    'papercolor-light', 'selenized-light', 'everforest-light',
    'catppuccin-latte', 'brackets-light-pro', 'nord-light',
]);

function isLightTheme() {
    return LIGHT_THEMES.has(document.documentElement.getAttribute('data-colorscheme') || 'gruvbox');
}

function detectMemBrand(name, manufacturer) {
    const s = ((name || '') + ' ' + (manufacturer || '')).toLowerCase();
    if (!s.trim()) return null;
    if (s.includes('crucial') || s.includes('ct16g4') || s.includes('ct32g4')) return 'crucial';
    if (s.includes('samsung') || s.includes('m471') || s.includes('m378')) return 'samsung';
    if (s.includes('kingston') || s.includes('kvr') || s.includes('knv')) return 'kingston';
    if (s.includes('micron') || s.includes('mta') || s.includes('mt4')) return 'micron';
    if (s.includes('sk hynix') || s.includes('hmt') || s.includes('hmab')) return 'sk_hynix';
    return null;
}

function detectDiskBrand(name) {
    if (!name) return null;
    const s = name.toLowerCase();
    if (s.includes('samsung') || s.includes('pm9') || s.includes('pm17') || s.includes('870') || s.includes('980') || s.includes('990')) return 'samsung';
    if (s.includes('crucial') || s.includes('ct1000') || s.includes('ct500') || s.includes('ct2000') || s.includes('mx500') || s.includes('bx500')) return 'crucial';
    if (s.includes('kingston') || s.includes('kc3000') || s.includes('sa400') || s.includes('sa1000')) return 'kingston';
    if (s.includes('wd ') || s.includes('western digital') || s.includes('wds') || s.includes('sn7') || s.includes('sn5') || s.includes('blue') || s.includes('black')) return 'western_digital';
    if (s.includes('seagate') || s.includes('st1000') || s.includes('st2000') || s.includes('st500') || s.includes('barracuda') || s.includes('firecuda')) return 'seagate';
    if (s.includes('kioxia') || s.includes('exceria') || s.includes('rc20')) return 'kioxia';
    if (s.includes('toshiba')) return 'toshiba';
    if (s.includes('sandisk') || s.includes('sdss') || s.includes('extreme pro')) return 'sandisk';
    if (s.includes('micron') || s.includes('1300s') || s.includes('2400s')) return 'micron';
    if (s.includes('sk hynix') || s.includes('bc711') || s.includes('bc501') || s.includes('pc711')) return 'sk_hynix';
    if (s.includes('ymtc') || s.includes('pc005') || s.includes('ec600')) return 'ymtc';
    return null;
}

function detectNetBrand(name) {
    if (!name) return null;
    const s = name.toLowerCase();
    if (s.includes('intel')) return 'intel';
    if (s.includes('qualcomm') || s.includes('atheros') || s.includes('qca')) return 'qualcomm';
    if (s.includes('mediatek') || s.includes('mt79')) return 'mediatek';
    if (s.includes('nvidia') || s.includes('nforce')) return 'nvidia';
    if (s.includes('amd') || s.includes('radeon')) return 'amd';
    // Realtek and others not in icons
    return null;
}

/* HW Detail cache */
let hwDetailCache = null;
let hwDetailLoaded = false;

async function loadHwNames() {
    try { hwNamesCache = await pywebview.api.get_hw_names(); } catch (e) { console.warn('loadHwNames:', e); }
}

function detectCpuBrand(name) {
    if (!name) return null;
    const s = name.toLowerCase();
    if (s.includes('zhaoxin') || s.includes('兆芯') || s.includes('kaixian') || s.includes('khaixun')) return 'zhaoxin';
    if (s.includes('qualcomm') || s.includes('snapdragon')) return 'qualcomm';
    if (s.includes('amd') || s.includes('ryzen') || s.includes('epyc') || s.includes('threadripper')) return 'amd';
    if (s.includes('intel') || s.includes('core') || s.includes('xeon') || s.includes('celeron') || s.includes('pentium')) return 'intel';
    return null;
}

function detectGpuBrand(name) {
    if (!name) return null;
    const s = name.toLowerCase();
    if (s.includes('nvidia') || s.includes('geforce') || s.includes('rtx') || s.includes('gtx') || s.includes('quadro')) return 'nvidia';
    if (s.includes('amd') || s.includes('radeon') || s.includes('rx ')) return 'amd';
    if (s.includes('intel') || s.includes('arc') || s.includes('iris') || s.includes('uhd')) return 'intel';
    if (s.includes('qualcomm') || s.includes('adreno') || s.includes('snapdragon')) return 'qualcomm';
    return null;
}

function setMetricBrandClass(sectionId, brand) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    section.classList.remove('brand-amd', 'brand-intel', 'brand-nvidia');
    if (['amd', 'intel', 'nvidia'].includes(brand)) {
        section.classList.add('brand-' + brand);
    }
}

function setHeaderText(el, text) {
    if (!el) return;
    let textNode = el._headerTextNode;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !textNode.parentNode) {
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                textNode = node;
                break;
            }
        }
        if (!textNode) {
            textNode = document.createTextNode(text + '\n');
            el.insertBefore(textNode, el.firstChild);
        }
        el._headerTextNode = textNode;
    }
    textNode.textContent = text + '\n';
}

function applyHwNames(show) {
    const cpuLabel = document.getElementById('cpu-header');
    const gpuLabel = document.getElementById('gpu-header');
    const memLabel = document.getElementById('mem-header');
    const diskLabel = document.querySelector('#disk-section .box-header');
    const netLabel = document.querySelector('#net-section .box-header');

    if (hwNamesCache) {
        const cpuBrand = detectCpuBrand(hwNamesCache.cpu);
        const gpuBrand = detectGpuBrand(hwNamesCache.gpu);
        setMetricBrandClass('cpu-section', cpuBrand);
        setMetricBrandClass('gpu-section', gpuBrand);
    } else {
        setMetricBrandClass('cpu-section', null);
        setMetricBrandClass('gpu-section', null);
    }

    if (show && hwNamesCache) {
        setHeaderText(cpuLabel, hwNamesCache.cpu || 'CPU');
        setHeaderText(gpuLabel, hwNamesCache.gpu || 'GPU');
        setHeaderText(memLabel, hwNamesCache.mem || 'Memory');
        if (diskLabel) setHeaderText(diskLabel, hwNamesCache.disk || 'Disk');
        if (netLabel) setHeaderText(netLabel, hwNamesCache.net || 'Network');
    } else {
        setHeaderText(cpuLabel, 'CPU');
        setHeaderText(gpuLabel, 'GPU');
        setHeaderText(memLabel, 'Memory');
        if (diskLabel) setHeaderText(diskLabel, 'Disk');
        if (netLabel) setHeaderText(netLabel, 'Network');
    }
}

/* HW Detail Popups */
async function loadHwDetail() {
    try {
        hwDetailCache = await pywebview.api.get_hw_detail();
        hwDetailLoaded = true;
        applyHwDetail();
    } catch (e) { console.warn('loadHwDetail:', e); }
}

function applyHwDetail() {
    if (!hwDetailCache) return;

    // CPU detail
    const cpu = hwDetailCache.cpu || {};
    setDetailModel('cpu-detail-model', cpu.name || 'CPU');
    setText('cpu-hw-name', cpu.name || '');
    const cpuSpecs = [];
    if (cpu.cores) cpuSpecs.push(['Cores', cpu.cores + (cpu.threads ? ` / ${cpu.threads}T` : '')]);
    else if (cpu.threads) cpuSpecs.push(['Threads', cpu.threads]);
    if (cpu.socket) cpuSpecs.push(['Socket', cpu.socket]);
    if (cpu.base_clock) cpuSpecs.push(['Base', cpu.base_clock]);
    if (cpu.boost_clock) cpuSpecs.push(['Boost', cpu.boost_clock]);
    if (cpu.cache_l2) cpuSpecs.push(['L2', cpu.cache_l2]);
    if (cpu.cache_l3) cpuSpecs.push(['L3', cpu.cache_l3]);
    setDetailSpecs('cpu-detail-specs', cpuSpecs);

    // GPU detail
    const gpu = hwDetailCache.gpu || {};
    setDetailModel('gpu-detail-model', gpu.name || 'GPU');
    setText('gpu-hw-name', gpu.name || '');
    const gpuSpecs = [];
    if (gpu.vram_type) gpuSpecs.push(['VRAM Type', gpu.vram_type]);
    if (gpu.driver) gpuSpecs.push(['Driver', gpu.driver]);
    setDetailSpecs('gpu-detail-specs', gpuSpecs);

    // Memory detail
    const mem = hwDetailCache.mem || {};
    setDetailModel('mem-detail-model', mem.name || mem.part_number || 'Memory');
    const memSpecs = [];
    if (mem.type) memSpecs.push(['Type', mem.type]);
    if (mem.speed) memSpecs.push(['Speed', mem.speed]);
    if (mem.total_gb) memSpecs.push(['Capacity', mem.total_gb + ' GB']);
    if (mem.slot_count) memSpecs.push(['Slots', mem.slot_count]);
    if (mem.manufacturer) memSpecs.push(['Vendor', mem.manufacturer]);
    if (mem.part_number && mem.part_number !== mem.name) memSpecs.push(['Part', mem.part_number]);
    if (mem.form_factor) memSpecs.push(['Form', mem.form_factor]);
    setDetailSpecs('mem-detail-specs', memSpecs);
}

function setDetailModel(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || '--';
}

function setDetailSpecs(id, specs) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!specs || specs.length === 0) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = specs.map(([label, value]) =>
        `<span class="spec-label">${label}</span><span class="spec-value">${value}</span>`
    ).join('');
}

/* Clock */
/** 将小时数映射为中文时段词（仅 12 小时制显示）。 */
function clockPeriodLabel(h) {
    if (h >= 0 && h < 5) return t('period-dawn');          // 凌晨
    if (h >= 5 && h < 8) return t('period-morning-early');  // 早上
    if (h >= 8 && h < 11) return t('period-morning');       // 上午
    if (h >= 11 && h < 13) return t('period-noon');         // 中午
    if (h >= 13 && h < 17) return t('period-afternoon');    // 下午
    if (h >= 17 && h < 19) return t('period-dusk');         // 傍晚
    if (h >= 19 && h < 23) return t('period-night');        // 晚上
    return t('period-midnight');                             // 午夜
}

function startClock() {
    // 从持久化设置读取 12/24 小时制与显秒（startClock 在设置加载完成后调用）
    _clock24 = (window._appSettings && window._appSettings.clock_24h) !== false;
    _clockShowSeconds = (window._appSettings && window._appSettings.clock_show_seconds) !== false;

    function tick() {
        const now = new Date();
        const h24 = now.getHours();
        const m = now.getMinutes().toString().padStart(2, '0');
        const sec = now.getSeconds().toString().padStart(2, '0');
        setText('h-clock-date', `${now.getMonth() + 1}/${now.getDate()}`);
        // 12/24 小时制：12 小时制显示 1-12，并在上方显示时段词
        const hourStr = _clock24
            ? h24.toString().padStart(2, '0')
            : (h24 % 12 || 12).toString().padStart(2, '0');
        setText('h-clock-h', hourStr);
        setText('h-clock-m', m);
        setText('h-clock-s', sec);
        const periodEl = document.getElementById('h-clock-period');
        if (periodEl) periodEl.textContent = _clock24 ? '' : clockPeriodLabel(h24);
        const secEl = document.getElementById('h-clock-s');
        if (secEl) secEl.style.display = _clockShowSeconds ? '' : 'none';
        const block = document.getElementById('h-clock-block');
        if (block) block.classList.toggle('is-24h', _clock24);

        // Lunar date (computed once per day)
        const hLunarEl = document.getElementById('h-clock-lunar');
        if (hLunarEl) {
            const y = now.getFullYear(), mo = now.getMonth() + 1, dd = now.getDate();
            if (hLunarEl.dataset.date !== `${y}-${mo}-${dd}`) {
                const lu = Lunar.solar2lunar(y, mo, dd);
                if (lu) {
                    hLunarEl.textContent = `${lu.fullCN}`;
                    hLunarEl.dataset.date = `${y}-${mo}-${dd}`;
                }
            }
        }
    }
    tick();
    clockTimer = setInterval(tick, 1000);
}

/* Weather icons — Material Design (nf-md) */
const WX_ICONS = {
    '100': '\u{F0599}', '101': '\u{F0595}', '102': '\u{F0595}', '103': '\u{F0595}',
    '104': '\u{F0590}', '150': '\u{F0594}', '151': '\u{F0F31}', '153': '\u{F0590}',
    '300': '\u{F0597}', '301': '\u{F0596}', '302': '\u{F067E}', '303': '\u{F067E}',
    '304': '\u{F0592}', '305': '\u{F0597}', '306': '\u{F0597}',
    '307': '\u{F0596}', '308': '\u{F0596}', '309': '\u{F0597}',
    '310': '\u{F0596}', '311': '\u{F0596}', '312': '\u{F0596}',
    '313': '\u{F067F}', '314': '\u{F0597}', '315': '\u{F067E}',
    '316': '\u{F067E}', '317': '\u{F067E}', '318': '\u{F0592}',
    '350': '\u{F0597}', '399': '\u{F0597}',
    '400': '\u{F0598}', '401': '\u{F0598}', '402': '\u{F0F36}', '403': '\u{F0F36}',
    '404': '\u{F067F}', '405': '\u{F067F}', '406': '\u{F067F}', '407': '\u{F0598}',
    '408': '\u{F0598}', '409': '\u{F0598}', '410': '\u{F0F36}', '456': '\u{F0598}',
    '457': '\u{F0598}', '499': '\u{F0598}', '500': '\u{F0591}', '501': '\u{F0591}',
    '502': '\u{F0F30}', '503': '\u{F0F30}', '504': '\u{F0F30}', '507': '\u{F0F30}', '508': '\u{F0F30}',
    '509': '\u{F0F30}', '510': '\u{F0591}', '511': '\u{F0591}', '512': '\u{F0F30}', '513': '\u{F0F30}',
    '514': '\u{F0F30}', '515': '\u{F0591}', '900': '\u{F18D6}', '901': '\u{F0717}',
    '999': '\u{F0590}',
};

function wxIcon(iconCode) {
    return WX_ICONS[iconCode] || '\u{F0590}';
}

async function refreshWeather() {
    try {
        const w = await pywebview.api.get_weather();
        if (w.error) {
            setText('h-clock-weather-temp', '--℃');
        } else {
            setText('h-clock-weather-temp', fmt(w.temp, 0) + '℃');
            // Update icons
            const icon = wxIcon(w.icon);
            const popupIconEl = document.getElementById('wx-popup-icon');
            if (popupIconEl) popupIconEl.textContent = icon;
            const hIconEl = document.getElementById('h-wx-icon');
            if (hIconEl) hIconEl.textContent = icon;
            // Update popup
            setText('wx-popup-temp', fmt(w.temp, 0));
            setText('wx-popup-text', w.text || '--');
            setText('wx-popup-city', w.city || '--');
            setText('wx-popup-updated', formatWxUpdateTime(w.updateTime));
        }
    } catch (e) { console.warn('refreshWeather:', e); }
}

function formatWxUpdateTime(t) {
    if (!t) return '--:--';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '--:--';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
}

async function refreshWeatherDetail() {
    try {
        const d = await pywebview.api.get_weather_detail();
        if (d.error) return;
        if (d.now) {
            setText('wx-feels', fmt(d.now.feelsLike, 0));
            setText('wx-humidity', fmt(d.now.humidity, 0));
            setText('wx-wind-dir', d.now.windDir || '--');
            setText('wx-wind-scale', d.now.windScale || '--');
        }
        if (d.minutely && d.minutely.minutely && d.minutely.minutely.length > 0) {
            const precipRow = document.getElementById('wx-precip-row');
            const precipText = document.getElementById('wx-precip-text');
            const precipChart = document.getElementById('wx-precip-chart');
            if (precipRow && precipText && precipChart) {
                const summary = d.minutely.summary || '';
                const items = d.minutely.minutely;
                const hasPrecip = items.some(m => m.precip > 0);
                if (hasPrecip) {
                    precipText.textContent = summary || '--';
                    const bars = items.map(m => {
                        const p = m.precip;
                        if (p <= 0) return '▁';
                        if (p < 0.5) return '▃';
                        if (p < 1) return '▅';
                        if (p < 2) return '▇';
                        return '█';
                    });
                    precipChart.textContent = bars.join('');
                    precipRow.style.display = '';
                } else {
                    precipRow.style.display = 'none';
                }
            }
        }
    } catch (e) { console.warn('refreshWeatherDetail:', e); }
}

async function refreshAirQuality() {
    try {
        const d = await pywebview.api.get_airquality();
        const el = document.getElementById('wx-aqi-val');
        const row = document.getElementById('wx-aqi-row');
        if (!el || !row) return;

        if (d.error || !d.indexes || d.indexes.length === 0) {
            row.style.display = 'none';
            return;
        }

        const idx = d.indexes[0];
        el.textContent = (idx.aqiDisplay || '--') + ' ' + (idx.category || '');
        const cat = (idx.category || '').toLowerCase();
        const aqiColor = cat.includes('优') ? 'var(--green)' :
                         cat.includes('良') ? 'var(--yellow)' :
                         cat.includes('轻度') ? 'var(--orange)' :
                         cat.includes('中度') ? 'var(--orange)' :
                         cat.includes('重度') ? 'var(--red)' :
                         cat.includes('严重') ? 'var(--red)' : '';
        el.style.color = aqiColor;
        row.style.display = '';
    } catch (e) { console.warn('refreshAirQuality:', e); }
}

/* Weather alerts */
function alertSeverityColor(alerts) {
    const validColors = (alerts || [])
        .map((a) => ({
            r: Number(a.colorR) || 0,
            g: Number(a.colorG) || 0,
            b: Number(a.colorB) || 0,
        }))
        .filter((c) => c.r || c.g || c.b);
    if (validColors.length) {
        return `rgb(${validColors[0].r}, ${validColors[0].g}, ${validColors[0].b})`;
    }

    const severityText = (alerts || []).map((a) => String(a.severity || '').toLowerCase()).join(' ');
    if (severityText.includes('extreme') || severityText.includes('severe') || severityText.includes('red') || severityText.includes('红')) return 'var(--red)';
    if (severityText.includes('orange') || severityText.includes('橙')) return 'var(--orange)';
    if (severityText.includes('yellow') || severityText.includes('黄')) return 'var(--yellow)';
    if (severityText.includes('blue') || severityText.includes('蓝')) return 'var(--blue)';
    return 'var(--yellow)';
}

async function refreshAlerts() {
    try {
        const alerts = await pywebview.api.get_alerts();
        cachedAlerts = alerts || [];
        const row = document.getElementById('wx-alerts-row');
        const list = document.getElementById('wx-alerts-list');
        if (!row || !list) return;

        if (!alerts || alerts.length === 0) {
            row.style.display = 'none';
            return;
        }

        list.innerHTML = '';
        const maxShow = 3;
        const shown = alerts.slice(0, maxShow);
        for (const a of shown) {
            const div = document.createElement('div');
            div.className = 'wx-alert-item';
            const pub = a.publishTime ? new Date(a.publishTime) : null;
            const timeStr = pub ? pub.toLocaleString('zh', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
            div.innerHTML = `<span class="alert-type">${a.eventType || ''}</span>${a.headline || ''}${timeStr ? '<br><span class="alert-time">发布于 ' + timeStr + '</span>' : ''}`;
            div.style.borderLeftColor = a.colorCode ? `rgb(${a.colorR},${a.colorG},${a.colorB})` : '';
            list.appendChild(div);
        }
        if (alerts.length > maxShow) {
            const more = document.createElement('div');
            more.className = 'wx-alert-more';
            more.textContent = `还有 ${alerts.length - maxShow} 个预警...`;
            list.appendChild(more);
        }
        row.style.display = '';
    } catch (e) { console.warn('refreshAlerts:', e); }
}

/* System info */
async function refreshSysinfo() {
    try {
        const info = await pywebview.api.get_sysinfo();
        setText('sysinfo-host', info.hostname || '--');
        setText('sysinfo-ip', info.ip || '--');
        setText('sysinfo-uptime', info.uptime || '--');
    } catch (e) { console.warn('refreshSysinfo:', e); }
}

/* Port scanning popup */
let _portsData = null; // cached port list
let _portsSearchTimer = null;

async function openPortsPopup() {
    const overlay = document.getElementById('ports-popup-overlay');
    const body = document.getElementById('ports-popup-body');
    const searchInput = document.getElementById('ports-search-input');
    if (!overlay || !body) return;

    overlay.style.display = 'flex';
    body.innerHTML = '<div class="ports-loading">' + t('ports-scanning') + '</div>';
    if (searchInput) { searchInput.value = ''; searchInput.style.display = 'block'; }

    try {
        const ports = await pywebview.api.get_listening_ports();
        _portsData = ports;
        renderPortsList(ports);
    } catch (e) {
        console.warn('openPortsPopup:', e);
        body.innerHTML = '<div class="ports-empty">' + t('ports-empty') + '</div>';
    }
}

function renderPortsList(ports) {
    const body = document.getElementById('ports-popup-body');
    if (!body) return;
    if (!ports || ports.length === 0) {
        body.innerHTML = '<div class="ports-empty">' + t('ports-empty') + '</div>';
        return;
    }
    // Build header row
    let html = '<div class="ports-header-row">'
        + '<span class="ports-hdr ports-hdr-proto">' + t('ports-proto') + '</span>'
        + '<span class="ports-hdr ports-hdr-pid">PID</span>'
        + '<span class="ports-hdr ports-hdr-name">' + t('ports-name') + '</span>'
        + '<span class="ports-hdr ports-hdr-addr">' + t('ports-addr') + '</span>'
        + '<span class="ports-hdr ports-hdr-port">' + t('ports-port') + '</span>'
        + '<span class="ports-hdr ports-hdr-action"></span>'
        + '</div>';
    ports.forEach(function(item) {
        const addrStr = item.address + ':' + item.port;
        html += '<div class="ports-item">'
            + '<span class="ports-item-proto">' + escapeHtml(item.protocol) + '</span>'
            + '<span class="ports-item-pid">' + item.pid + '</span>'
            + '<span class="ports-item-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>'
            + '<span class="ports-item-addr">' + escapeHtml(addrStr) + '</span>'
            + '<span class="ports-item-port">' + item.port + '</span>'
            + '<span class="ports-item-actions">'
            + '<button class="ports-item-btn ports-item-kill" data-pid="' + item.pid + '">' + t('ports-kill') + '</button>'
            + '</span>'
            + '</div>';
    });
    body.innerHTML = html;

    // Attach kill button handlers
    body.querySelectorAll('.ports-item-kill').forEach(function(btn) {
        btn.addEventListener('click', async function(e) {
            const pid = parseInt(e.target.getAttribute('data-pid'));
            await killPortProcess(pid, e.target);
        });
    });
}

async function killPortProcess(pid, btnEl) {
    if (!btnEl) return;
    btnEl.disabled = true;
    btnEl.textContent = '...';
    try {
        const result = await pywebview.api.kill_process(pid);
        if (result && result.success) {
            btnEl.textContent = '✓';
            btnEl.classList.add('ports-kill-done');
        } else {
            btnEl.textContent = '✗';
            btnEl.title = (result && result.message) ? result.message : t('ports-kill-fail');
        }
    } catch (e) {
        btnEl.textContent = '✗';
        console.warn('kill_process:', e);
    }
    // Re-scan after a short delay
    setTimeout(async function() {
        try {
            const ports = await pywebview.api.get_listening_ports();
            _portsData = ports;
            renderPortsList(ports);
        } catch (e) { /* ignore */ }
    }, 1500);
}

// Search filter for ports
function filterPortsList(query) {
    if (!_portsData) return;
    const q = query.trim().toLowerCase();
    if (!q) {
        renderPortsList(_portsData);
        return;
    }
    const filtered = _portsData.filter(function(item) {
        return String(item.port).indexOf(q) !== -1
            || item.name.toLowerCase().indexOf(q) !== -1
            || item.protocol.toLowerCase().indexOf(q) !== -1
            || String(item.pid).indexOf(q) !== -1;
    });
    renderPortsList(filtered);
}

// Debounced search input handler
(function() {
    const searchInput = document.getElementById('ports-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            if (_portsSearchTimer) clearTimeout(_portsSearchTimer);
            _portsSearchTimer = setTimeout(function() {
                filterPortsList(searchInput.value);
            }, 150);
        });
    }
})();

function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// Close port popup
document.getElementById('ports-popup-close')?.addEventListener('click', function() {
    document.getElementById('ports-popup-overlay').style.display = 'none';
});
document.getElementById('ports-popup-overlay')?.addEventListener('click', function(e) {
    if (e.target === this) this.style.display = 'none';
});

// Click IP to show listening ports
document.addEventListener('click', function(e) {
    var ipEl = e.target.closest('#sysinfo-ip');
    if (ipEl) {
        openPortsPopup();
    }
});

/* i18n 内嵌链接：桌面模式调后端开系统浏览器，server 模式直接新开标签页 */
document.addEventListener('click', function(e) {
    var link = e.target.closest('a.i18n-link');
    if (!link) return;
    e.preventDefault();
    var url = link.getAttribute('href');
    if (window.pywebview && window.pywebview.api && window.pywebview.api.openExternal) {
        window.pywebview.api.openExternal(url)
            .catch(function() { window.open(url, '_blank'); });
    } else {
        window.open(url, '_blank');
    }
});

/* Settings */
function applyColorscheme(scheme) {
    document.documentElement.setAttribute('data-colorscheme', scheme);
}

/* ── Clock sidebar background (horizontal mode) ── */
let lastResolvedClockBg = { image: '', path: '' };
let clockBgState = { url: '', topColor: '', gradient: true, opacity: 0, blur: 0 };
let _clockBgResizeTimer = null;

function darkenColor(hex, factor) {
    if (!hex || !hex.startsWith('#') || hex.length < 7) return hex || '#000000';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const f = Math.max(0, Math.min(1, factor));
    return `rgb(${Math.round(r * (1 - f))}, ${Math.round(g * (1 - f))}, ${Math.round(b * (1 - f))})`;
}

function applyClockBackgroundGradient() {
    const layer = document.getElementById('clock-bg-image');
    if (!layer || !clockBgState.url) return;

    const safeUrl = `url("${String(clockBgState.url).replace(/["\\]/g, '\\$&')}")`;
    const fit = clockBgState.fit || 'fit';

    // Cover / stretch modes fill the whole container — no gradient needed
    if (fit === 'cover') {
        const ox = clockBgState.offsetX ?? 50;
        const oy = clockBgState.offsetY ?? 50;
        layer.style.background = `${safeUrl} ${ox}% ${oy}% / cover no-repeat`;
        return;
    }
    if (fit === 'stretch') {
        layer.style.background = `${safeUrl} center / 100% 100% no-repeat`;
        return;
    }

    // Fit mode: width=100%, auto height; add seamless gradient above when short
    if (!clockBgState.gradient || !clockBgState.topColor) {
        layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
        return;
    }

    // Load image to calculate rendered height vs container height
    const img = new Image();
    img.onload = () => {
        const cw = layer.clientWidth;
        const ch = layer.clientHeight;
        if (!cw || !ch || !img.naturalWidth) {
            layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
            return;
        }
        const renderedH = cw * (img.naturalHeight / img.naturalWidth);
        if (renderedH >= ch) {
            // Image fills or overflows the container — no gradient needed
            layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
        } else {
            // Image is short — add seamless gradient above it
            const pct = ((ch - renderedH) / ch) * 100;
            const dark = darkenColor(clockBgState.topColor, 0.5);
            const c = clockBgState.topColor;
            layer.style.background =
                `${safeUrl} bottom center / 100% auto no-repeat,` +
                `linear-gradient(to bottom, ${dark} 0%, ${c} ${pct}%, ${c} 100%)`;
        }
    };
    img.onerror = () => {
        layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
    };
    img.src = clockBgState.url;
}

async function applyClockBackgroundSetting(image, opacity, blur, gradient, fit, offsetX, offsetY) {
    const layer = document.getElementById('clock-bg-image');
    if (!layer) return;

    const safeOpacity = Math.max(0, Math.min(100, Number(opacity) || 0)) / 100;
    const safeBlur = Math.max(0, Math.min(50, Number(blur) || 0));
    const hasImage = Boolean(image && safeOpacity > 0);

    if (!hasImage) {
        layer.style.background = '';
        layer.style.opacity = '0';
        layer.style.filter = 'none';
        clockBgState = { url: '', topColor: '', gradient: true, opacity: 0, blur: 0, fit: 'fit', offsetX: 50, offsetY: 50 };
        return;
    }

    // Resolve image path (with caching)
    let resolved = image || '';
    if (lastResolvedClockBg.image === image && lastResolvedClockBg.path) {
        resolved = lastResolvedClockBg.path;
    } else {
        try {
            resolved = await pywebview.api.resolve_background_image(image || '');
            lastResolvedClockBg = { image: image || '', path: resolved };
        } catch (e) {
            console.warn('resolve_background_image (clock):', e);
        }
    }

    if (!resolved) {
        layer.style.background = '';
        layer.style.opacity = '0';
        return;
    }

    layer.style.opacity = String(safeOpacity);
    layer.style.filter = safeBlur > 0 ? `blur(${safeBlur}px)` : 'none';

    const safeFit = fit || 'fit';
    // Fetch top-edge color for gradient (only in fit mode with gradient enabled)
    let topColor = '';
    if (safeFit === 'fit' && gradient) {
        try {
            topColor = await pywebview.api.get_clock_bg_top_color(image || '');
        } catch (e) {
            console.warn('get_clock_bg_top_color:', e);
        }
    }

    clockBgState = {
        url: resolved, topColor, gradient: !!gradient,
        opacity: safeOpacity, blur: safeBlur, fit: safeFit,
        offsetX: offsetX ?? 50, offsetY: offsetY ?? 50,
    };
    applyClockBackgroundGradient();
}

window.addEventListener('resize', () => {
    if (!clockBgState.url) return;
    if (_clockBgResizeTimer) clearTimeout(_clockBgResizeTimer);
    _clockBgResizeTimer = setTimeout(applyClockBackgroundGradient, 200);
});

window.addEventListener('resize', () => {
    // process list is fixed to the top 5 — nothing to recompute on resize
});

/* ── Theme picker cards ── */
const THEME_LIST = {
    dark: [
        { value: 'gruvbox', name: 'Gruvbox' },
        { value: 'nord', name: 'Nord' },
        { value: 'ayu', name: 'Ayu Dark' },
        { value: 'tokyo-night', name: 'Tokyo Night' },
        { value: 'tokyo-night-storm', name: 'Tokyo Night Storm' },
        { value: 'catppuccin', name: 'Catppuccin Mocha' },
        { value: 'rose-pine-moon', name: 'Rosé Pine Moon' },
        { value: 'alucard', name: 'Alucard' },
        { value: 'monokai-pro', name: 'Monokai Pro' },
        { value: 'everforest-dark', name: 'Everforest Dark' },
        { value: 'dracula', name: 'Dracula' },
        { value: 'one-dark', name: 'One Dark' },
    ],
    light: [
        { value: 'gruvbox-light', name: 'Gruvbox (Light)' },
        { value: 'catppuccin-latte', name: 'Catppuccin Latte' },
        { value: 'rose-pine-dawn', name: 'Rosé Pine Dawn' },
        { value: 'papercolor-light', name: 'PaperColor Light' },
        { value: 'github-light', name: 'GitHub Light' },
        { value: 'atom-one-light', name: 'Atom One Light' },
        { value: 'selenized-light', name: 'Selenized Light' },
        { value: 'everforest-light', name: 'Everforest Light' },
        { value: 'brackets-light-pro', name: 'Brackets Light Pro' },
        { value: 'nord-light', name: 'Nord Light' },
    ],
};

function getThemeColors(scheme) {
    const tester = document.createElement('div');
    tester.setAttribute('data-colorscheme', scheme);
    tester.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(tester);
    const cs = getComputedStyle(tester);
    // Read raw palette tokens — derived vars like --bg resolve var() at :root scope
    const colors = {
        bg: cs.getPropertyValue('--nord0').trim(),
        surface: cs.getPropertyValue('--nord1').trim(),
        accent: cs.getPropertyValue('--nord8').trim(),
        text: cs.getPropertyValue('--nord4').trim(),
    };
    document.body.removeChild(tester);
    return colors;
}

function renderThemeCards(selectedScheme, onSelect) {
    const darkGrid = document.getElementById('theme-grid-dark');
    const lightGrid = document.getElementById('theme-grid-light');
    if (!darkGrid || !lightGrid) return;
    darkGrid.innerHTML = '';
    lightGrid.innerHTML = '';

    const makeCard = (theme) => {
        const c = getThemeColors(theme.value);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'theme-card' + (theme.value === selectedScheme ? ' active' : '');
        card.dataset.scheme = theme.value;
        card.innerHTML =
            `<div class="theme-swatches">` +
            `<span class="swatch" style="background:${c.bg}"></span>` +
            `<span class="swatch" style="background:${c.surface}"></span>` +
            `<span class="swatch" style="background:${c.accent}"></span>` +
            `<span class="swatch" style="background:${c.text}"></span>` +
            `</div>` +
            `<span class="theme-name">${theme.name}</span>`;
        card.addEventListener('click', () => {
            document.querySelectorAll('.theme-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');
            onSelect(theme.value);
        });
        return card;
    };

    THEME_LIST.dark.forEach(t => darkGrid.appendChild(makeCard(t)));
    THEME_LIST.light.forEach(t => lightGrid.appendChild(makeCard(t)));
}

/* ── Font picker ── */
// Each entry: { value: <css family name>, name: <display name>, preview: <text shown in the card> }
const AVAILABLE_FONTS = [
    { value: 'JetBrains Maple Mono', name: 'JetBrains Maple Mono', preview: 'Aa 0123' },
    { value: 'Departure Mono', name: 'Departure Mono', preview: 'Aa 0123' },
    { value: 'IoskeleyMono', name: 'IoskeleyMono', preview: 'Aa 0123' },
];

// Preload the bundled typefaces so the font-picker preview reflects each real
// font immediately. Without this, font-display:swap renders the inherited
// fallback (the modal's JetBrains) until the woff2 downloads — so e.g.
// Departure Mono appeared as JetBrains Mono until it loaded.
AVAILABLE_FONTS.forEach(f => {
    try { document.fonts.load(`20px "${f.value}"`); } catch (e) { /* ignore */ }
});

function applyFonts(fontUi, fontData, fontClock) {
    const root = document.documentElement;
    // Build a CSS font-family value. Returns null when val is empty so we
    // don't override the :root CSS defaults (which include the full fallback chain).
    const build = (val, fallbacks) => {
        const v = (val || '').trim();
        if (!v) return null;
        const quoted = /\s/.test(v) ? `"${v}"` : v;
        return `${quoted}, ${fallbacks}`;
    };
    const ui = build(fontUi, '"Symbols Nerd Font Mono", "Consolas", "Monaco", monospace');
    const data = build(fontData, '"JetBrains Maple Mono", monospace');
    const clock = build(fontClock, '"IoskeleyMono", monospace');
    if (ui) root.style.setProperty('--font-ui', ui);
    else root.style.removeProperty('--font-ui');
    if (data) root.style.setProperty('--font-data', data);
    else root.style.removeProperty('--font-data');
    if (clock) root.style.setProperty('--font-clock', clock);
    else root.style.removeProperty('--font-clock');
}

function renderFontCards(slot, selectedFont, onSelect) {
    const grid = document.getElementById('font-grid-' + slot);
    if (!grid) return;
    grid.innerHTML = '';

    AVAILABLE_FONTS.forEach(font => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'font-card' + (font.value === selectedFont ? ' active' : '');
        card.dataset.font = font.value;
        // Inline font-family so the preview reflects this font alone (not the inherited slot var).
        // Use SINGLE quotes for the family name: it's embedded in a double-quoted style attribute,
        // so double quotes here would truncate the attribute and break the font-family.
        const quoted = /\s/.test(font.value) ? `'${font.value}'` : font.value;
        card.innerHTML =
            `<span class="font-preview" style="font-family:${quoted}, monospace">${font.preview}</span>` +
            `<span class="font-name">${font.name}</span>`;
        card.addEventListener('click', () => {
            grid.querySelectorAll('.font-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');
            onSelect(font.value);
        });
        grid.appendChild(card);
    });
}

/* ── Image picker (thumbnail grid) ── */
function renderImagePicker(container, bgList, selected, onChange) {
    if (!container) return;
    container.innerHTML = '';

    const specials = [
        { value: '', icon: '\uf05e', labelKey: 'label-none' },
    ];

    const makeSpecial = (item) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'img-pick-card' + (item.value === selected ? ' active' : '');
        card.dataset.value = item.value;
        card.innerHTML =
            `<div class="img-pick-thumb img-pick-special"><span class="nf-icon">${item.icon}</span></div>` +
            `<span class="img-pick-name">${t(item.labelKey)}</span>`;
        card.addEventListener('click', () => {
            container.querySelectorAll('.img-pick-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');
            onChange(item.value);
        });
        return card;
    };

    const makeImage = (path) => {
        const name = path.replace(/^bg\//, '').replace(/^wp\//, '');
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'img-pick-card' + (path === selected ? ' active' : '');
        card.dataset.value = path;
        // 用户导入的壁纸(wp/)显示删除角标；内置壁纸(bg/)不可删
        const del = path.startsWith('wp/')
            ? `<span class="img-pick-del" title="${t('btn-del-bg')}"><span class="nf-icon"></span></span>` : '';
        card.innerHTML =
            del +
            `<div class="img-pick-thumb" style="background-image:url('${path.replace(/["\\]/g, '\\$&')}')"></div>` +
            `<span class="img-pick-name">${name}</span>`;
        card.title = name;
        card.addEventListener('click', () => {
            container.querySelectorAll('.img-pick-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');
            onChange(path);
        });
        if (path.startsWith('wp/')) {
            card.querySelector('.img-pick-del').addEventListener('click', (e) => {
                e.stopPropagation();   // 不触发展开选中
                e.preventDefault();
                showAppConfirm(t('confirm-del-bg') + '\n' + name, async () => {
                    try {
                        const ok = await pywebview.api.delete_wallpaper(path);
                        if (!ok) return;
                        const newList = await pywebview.api.get_bg_list();
                        const nextSel = path === selected ? '' : selected;
                        renderImagePicker(container, newList, nextSel, onChange);
                        if (nextSel === '' ) onChange('');   // 删的是当前选中 → 回到"无"
                    } catch (err) { console.warn('delete wallpaper:', err); }
                });
            });
        }
        return card;
    };

    // 导入壁纸：隐藏 <input type=file> → FileReader 读出 base64 → 后端保存 → 刷新并选中
    const makeImport = () => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'img-pick-card img-pick-special';
        card.innerHTML =
            `<div class="img-pick-thumb img-pick-special"><span class="nf-icon">\uf067</span></div>` +
            `<span class="img-pick-name">${t('btn-import-bg')}</span>`;
        card.title = t('btn-import-bg');
        card.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        const newPath = await pywebview.api.save_wallpaper(file.name, reader.result);
                        if (newPath) {
                            const newList = await pywebview.api.get_bg_list();
                            renderImagePicker(container, newList, newPath, onChange);
                            onChange(newPath);   // 导入后直接应用
                        }
                    } catch (e) { console.warn('import wallpaper:', e); }
                };
                reader.readAsDataURL(file);
            });
            document.body.appendChild(input);
            input.click();
            setTimeout(() => input.remove(), 2000);
        });
        return card;
    };

    specials.forEach(s => container.appendChild(makeSpecial(s)));
    container.appendChild(makeImport());
    bgList.forEach(p => container.appendChild(makeImage(p)));
}

/* ── Segmented control helper ── */
function initSegmented(container, value, onChange) {
    if (!container) return;
    const buttons = container.querySelectorAll('button');
    const setActive = (val) => {
        buttons.forEach(b => b.classList.toggle('active', b.dataset.value === val));
    };
    setActive(value);
    buttons.forEach(b => {
        b.addEventListener('click', () => {
            setActive(b.dataset.value);
            if (onChange) onChange(b.dataset.value);
        });
    });
    return { set: setActive };
}

/* ── Clock background offset modal ── */
let clockBgOffsetState = { x: 50, y: 50, url: '', onChange: null };

function openClockBgOffsetModal(url, offsetX, offsetY, onChange) {
    const overlay = document.getElementById('clockbg-offset-overlay');
    const resetBtn = document.getElementById('offset-reset');
    const doneBtn = document.getElementById('offset-done');
    if (!overlay) return;

    // Clone the preview to drop any previous drag listeners, then keep a live
    // reference so the onMove/onDown closures operate on the in-DOM element.
    let preview = document.getElementById('offset-preview');
    if (!preview) return;
    const newPreview = preview.cloneNode(true);
    preview.parentNode.replaceChild(newPreview, preview);
    preview = newPreview;

    clockBgOffsetState = { x: offsetX, y: offsetY, url: url || '', onChange };
    const safeUrl = String(url || '').replace(/["\\]/g, '\\$&');
    preview.style.backgroundImage = url ? `url("${safeUrl}")` : 'none';
    preview.style.backgroundSize = 'contain';
    preview.style.backgroundPosition = 'center';
    preview.style.backgroundRepeat = 'no-repeat';

    // Reset the highlight overlay from a previous session.
    let highlight = preview.querySelector('.offset-highlight');
    if (highlight) highlight.remove();
    highlight = document.createElement('div');
    highlight.className = 'offset-highlight';
    preview.appendChild(highlight);

    // Match the preview's aspect ratio to the real clock-section layer so the
    // cover-crop region shown here is the one actually behind the clock.
    const layer = document.getElementById('clock-bg-image');
    let layerW = 0, layerH = 0;
    if (layer) { layerW = layer.clientWidth; layerH = layer.clientHeight; }
    if (layerW > 0 && layerH > 0) {
        const ph = 300;
        const pw = Math.max(120, Math.min(320, ph * (layerW / layerH)));
        preview.style.width = pw + 'px';
        preview.style.height = ph + 'px';
    }

    overlay.style.display = 'flex';

    // Image natural size — needed to compute which region of the full picture is
    // actually visible behind the clock (the highlighted box).
    let natural = { w: 0, h: 0 };
    if (url) {
        const dimImg = new Image();
        dimImg.onload = () => { natural = { w: dimImg.naturalWidth, h: dimImg.naturalHeight }; layoutHighlight(); };
        dimImg.src = url;
    }

    // Position the highlight box = the exact cover-crop region that will render.
    function layoutHighlight() {
        const cw = preview.clientWidth, ch = preview.clientHeight;
        if (!cw || !ch || !natural.w || !natural.h) { highlight.style.display = 'none'; return; }
        const nw = natural.w, nh = natural.h;
        // Full image scaled to "contain" (everything visible), centered.
        const cs = Math.min(cw / nw, ch / nh);
        const dispW = nw * cs, dispH = nh * cs;
        const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2;
        // Visible (cover) region as a fraction of the image.
        const coverScale = Math.max(cw / nw, ch / nh);
        const fx = Math.min(1, cw / (nw * coverScale));
        const fy = Math.min(1, ch / (nh * coverScale));
        const hw = fx * dispW, hh = fy * dispH;
        const x = offX + (clockBgOffsetState.x / 100) * (dispW - hw);
        const y = offY + (clockBgOffsetState.y / 100) * (dispH - hh);
        highlight.style.left = x + 'px';
        highlight.style.top = y + 'px';
        highlight.style.width = hw + 'px';
        highlight.style.height = hh + 'px';
        // Drag travel in preview pixels for a full 100% offset (per axis).
        highlight._travelW = dispW - hw;
        highlight._travelH = dispH - hh;
        highlight.style.display = 'block';
    }
    layoutHighlight();

    // Drag-to-adjust: moving the highlight box moves the visible region.
    let dragging = false;
    let startMouseX = 0, startMouseY = 0;
    let startX = 0, startY = 0;

    const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startMouseX;
        const dy = e.clientY - startMouseY;
        const tw = (highlight._travelW > 0) ? highlight._travelW : preview.clientWidth;
        const th = (highlight._travelH > 0) ? highlight._travelH : preview.clientHeight;
        // Dragging the region right increases the offset (region follows the mouse).
        let nx = startX + (tw > 0 ? (dx / tw) * 100 : 0);
        let ny = startY + (th > 0 ? (dy / th) * 100 : 0);
        nx = Math.max(0, Math.min(100, nx));
        ny = Math.max(0, Math.min(100, ny));
        clockBgOffsetState.x = nx;
        clockBgOffsetState.y = ny;
        layoutHighlight();
        if (clockBgOffsetState.onChange) clockBgOffsetState.onChange(nx, ny);
    };

    const onUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    const onDown = (e) => {
        dragging = true;
        startMouseX = e.clientX;
        startMouseY = e.clientY;
        startX = clockBgOffsetState.x;
        startY = clockBgOffsetState.y;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    };

    preview.addEventListener('mousedown', onDown);

    const newReset = resetBtn.cloneNode(true);
    resetBtn.parentNode.replaceChild(newReset, resetBtn);
    newReset.addEventListener('click', () => {
        clockBgOffsetState.x = 50;
        clockBgOffsetState.y = 50;
        layoutHighlight();
        if (clockBgOffsetState.onChange) clockBgOffsetState.onChange(50, 50);
    });

    const newDone = doneBtn.cloneNode(true);
    doneBtn.parentNode.replaceChild(newDone, doneBtn);
    newDone.addEventListener('click', () => {
        overlay.style.display = 'none';
    });
}

function applyFontSize(pct) {
    // Scale only font sizes (via --font-scale), leaving the layout's px
    // dimensions untouched. Previously this used body zoom, which resized
    // the whole layout along with the text.
    document.documentElement.style.setProperty('--font-scale', pct / 100);
    // Fit the process list to the new font size (defer one frame so heights settle).
    setTimeout(recalcProcLimit, 0);
}

function applyPadding(px) {
    document.getElementById('terminal').style.padding = px + 'px';
}

let _weatherConfigured = false;   // 天气 API 是否已配置（由启动时的设置决定）

function applyFeatureToggles(toggles) {
    const ft = toggles || {};
    // Hide UI elements for disabled features
    const fpsSection = document.getElementById('fps-section');
    if (fpsSection) fpsSection.style.display = ft.fps !== false ? '' : 'none';
    const musicSection = document.getElementById('music-section');
    if (musicSection) musicSection.style.display = ft.music !== false ? '' : 'none';
    const calPopup = document.getElementById('clock-cal-popup');
    if (calPopup) calPopup.style.display = ft.calendar !== false ? '' : 'none';
    const procSection = document.getElementById('proc-section');
    if (procSection) procSection.style.display = ft.top_process !== false ? '' : 'none';
    document.querySelectorAll('.net-host-row').forEach(el => {
        el.style.display = ft.sysinfo !== false ? '' : 'none';
    });
    const clockBg = document.getElementById('clock-bg-image');
    if (clockBg) clockBg.style.display = ft.clock_bg !== false ? '' : 'none';
    const weatherEl = document.getElementById('h-weather-compact');
    if (weatherEl) weatherEl.style.display =
        (ft.weather !== false && _weatherConfigured) ? '' : 'none';
}

function initSettings() {
    const overlay = document.getElementById('settings-overlay');
    const saveBtn = document.getElementById('settings-save');
    const closeBtn = document.getElementById('settings-close');

    // Tab elements
    const tabBtns = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    // General
    const languageSel = document.getElementById('opt-language');
    const fontsizeRange = document.getElementById('opt-fontsize');
    const fontsizeVal = document.getElementById('fontsize-val');
    const fullscreenChk = document.getElementById('opt-fullscreen');
    const autostartChk = document.getElementById('opt-autostart');
    const updateNotifyChk = document.getElementById('opt-update-notify');

    // Server mode
    const serverModeChk = document.getElementById('opt-server-mode');
    const serverHostInput = document.getElementById('opt-server-host');
    const serverPortInput = document.getElementById('opt-server-port');
    const serverAuthChk = document.getElementById('opt-server-auth');
    const serverUserInput = document.getElementById('opt-server-user');
    const serverPassInput = document.getElementById('opt-server-pass');

    // Data
    const intervalSel = document.getElementById('opt-interval');
    const datasourceSel = document.getElementById('opt-datasource');
    const gpuSel = document.getElementById('opt-gpu');

    // Weather
    const wxLat = document.getElementById('opt-wx-lat');
    const wxLon = document.getElementById('opt-wx-lon');
    const wxKid = document.getElementById('opt-wx-kid');
    const wxSub = document.getElementById('opt-wx-sub');
    const wxKey = document.getElementById('opt-wx-key');

    // Monitor
    const monitorSel = document.getElementById('opt-monitor');
    const hideMissingChk = document.getElementById('opt-hide-missing');

    // Theme
    const colorschemeSel = document.getElementById('opt-colorscheme');

    // Clock (personalization > Time subtab)
    const clockFormatSel = document.getElementById('opt-clockformat');
    let clockFormatValue = '24';
    const clockShowSecondsChk = document.getElementById('opt-show-seconds');

    // Clock sidebar background (horizontal mode)
    const clockBgGroup = document.getElementById('clock-bg-group');
    const clockBgImgPicker = document.getElementById('clockbgimg-picker');
    let clockBgImgValue = '';
    const clockBgFitSel = document.getElementById('opt-clockbgfit');
    let clockBgFitValue = 'fit';
    const clockBgOpacityRange = document.getElementById('opt-clockbgopacity');
    const clockBgOpacityVal = document.getElementById('clockbgopacity-val');
    const clockBgBlurRange = document.getElementById('opt-clockbgblur');
    const clockBgBlurVal = document.getElementById('clockbgblur-val');
    const clockBgGradientChk = document.getElementById('opt-clockbggradient');
    const clockBgGradientRow = document.getElementById('clockbg-gradient-row');
    const clockBgGradientDesc = document.getElementById('clockbg-gradient-desc');
    const clockBgOffsetRow = document.getElementById('clockbg-offset-row');
    const clockBgOffsetDesc = document.getElementById('clockbg-offset-desc');
    const clockBgOffsetBtn = document.getElementById('opt-clockbg-offset');
    let clockBgOffsetX = 50;
    let clockBgOffsetY = 50;

    // Font slots
    const subtabBtns = document.querySelectorAll('.subtab-btn');
    const subtabContents = document.querySelectorAll('.subtab-content');
    let fontUiValue = 'JetBrains Maple Mono';
    let fontDataValue = 'IoskeleyMono';
    let fontClockValue = 'Departure Mono';

    function updateClockBgGradientVisibility() {
        // Gradient only applies to "fit" mode
        const show = clockBgFitValue === 'fit';
        if (clockBgGradientRow) clockBgGradientRow.style.display = show ? '' : 'none';
        if (clockBgGradientDesc) clockBgGradientDesc.style.display = show ? '' : 'none';
    }

    function updateClockBgOffsetVisibility() {
        // Offset only applies to "cover" mode
        const show = clockBgFitValue === 'cover';
        if (clockBgOffsetRow) clockBgOffsetRow.style.display = show ? '' : 'none';
        if (clockBgOffsetDesc) clockBgOffsetDesc.style.display = show ? '' : 'none';
    }

    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    // Sub-tab switching (Appearance / Fonts inside Theme tab)
    subtabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            subtabBtns.forEach(b => b.classList.remove('active'));
            subtabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const target = document.getElementById('subtab-' + btn.dataset.subtab);
            if (target) target.classList.add('active');
        });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        const isTyping = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';

        if (e.key === 's' || e.key === 'S') {
            dismissFirstLaunchHint();   // 按 S 打开设置时关掉首次提示
            if (!isTyping) {
                if (overlay.style.display === 'none') {
                    openSettings();
                } else {
                    closeSettings();
                }
            }
        }
        if (e.key === 'Escape') {
            if (overlay.style.display !== 'none') {
                closeSettings();
            } else if (!isTyping) {
                const exitPopup = document.getElementById('exit-popup');
                if (exitPopup) exitPopup.style.display = 'flex';
                pywebview.api.close_app();
            }
        }
        if (e.key === 'F2') {
            e.preventDefault();
            pywebview.api.minimize_window();
        }
        if (e.key === 'r' || e.key === 'R') {
            if (overlay.style.display === 'none' && !isTyping) {
                e.preventDefault();
                if (pollTimer) clearTimeout(pollTimer);
                pollTimer = null;
                poll(pollGeneration);
            }
        }
        if (e.ctrlKey && e.key === 'F5') {
            e.preventDefault();
            refreshWeather();
            refreshWeatherDetail();
            refreshAirQuality();
            refreshAlerts();
            refreshMusic();
            poll();
        }
    });

    /* About tab — program/Python/pywebview/browser/HW backend versions */
    async function loadAboutInfo() {
        const list = document.getElementById('about-list');
        if (!list) return;
        let info = {};
        try {
            info = await pywebview.api.get_app_info();
        } catch (e) { console.warn('get_app_info:', e); }
        // Browser engine version from the user agent (WebView2 in desktop mode)
        const ua = navigator.userAgent || '';
        const chrome = ua.match(/Chrome\/([\d.]+)/);
        const edg = ua.match(/Edg\/([\d.]+)/);
        let browser;
        if (edg) browser = 'WebView2 (Edge ' + edg[1] + (chrome ? ' · Chromium ' + chrome[1] : '') + ')';
        else if (chrome) browser = 'Chromium ' + chrome[1];
        else browser = ua || '--';
        const backend = info.backend || {};
        const repo = info.github_repo || '';
        // 贡献者：配置了 GitHub repo 时用 contrib.rocks 头像网格，否则显示 '--'
        const contributorsRow = repo
            ? '<div class="about-row about-row-contrib">'
              + '<span class="about-row-label" data-i18n="about-contributors">' + t('about-contributors') + '</span>'
              + '<img class="contrib-rocks" src="https://contrib.rocks/image?repo=' + encodeURIComponent(repo) + '" alt="Contributors" loading="lazy">'
              + '</div>'
            : null;
        const rows = [
            { key: 'about-program', value: info.program || '--' },
            { key: 'about-author', value: info.author || '--' },
            ...(contributorsRow
                ? [{ html: contributorsRow }]
                : [{ key: 'about-contributors', value: '--' }]),
            { key: 'about-project', value: info.homepage || '--', link: info.homepage || '' },
            { key: 'about-python', value: info.python || '--' },
            { key: 'about-pywebview', value: info.pywebview || '--' },
            { key: 'about-browser', value: browser },
            { key: 'about-backend', value: (backend.name || '--') + (backend.version ? ' ' + backend.version : '') },
        ];
        list.innerHTML = rows.map(r => {
            if (r.html) return r.html;   // 预渲染的贡献者头像行
            // 项目地址渲染为可点击链接（复用 i18n-link 委托打开系统浏览器）
            const valueHtml = (r.link && /^https?:\/\//i.test(r.link))
                ? '<a class="i18n-link about-row-link" href="' + escapeHtml(r.link) + '" target="_blank" rel="noopener">' + escapeHtml(r.link) + '</a>'
                : '<span class="about-row-value mono">' + escapeHtml(r.value) + '</span>';
            return '<div class="about-row">'
                + '<span class="about-row-label" data-i18n="' + r.key + '">' + t(r.key) + '</span>'
                + valueHtml
                + '</div>';
        }).join('');
    }

    async function openSettings() {
        const s = await pywebview.api.get_settings();

        // General
        languageSel.value = s.language || 'en';
        fontsizeRange.value = s.font_size || 100;
        fontsizeVal.textContent = (s.font_size || 100) + '%';
        fullscreenChk.checked = s.fullscreen !== false;
        autostartChk.checked = await pywebview.api.get_autostart();
        updateNotifyChk.checked = s.update_check_enabled !== false;

        // Data
        intervalSel.value = String(s.refresh_interval || 1000);
        datasourceSel.value = s.data_source || 'lhm';

        // GPU list
        try {
            const gpus = await pywebview.api.get_gpu_list();
            gpuSel.innerHTML = '';
            gpus.forEach((name, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = name;
                gpuSel.appendChild(opt);
            });
            if (gpus.length === 0) {
                const opt = document.createElement('option');
                opt.value = '0';
                opt.textContent = 'Auto';
                gpuSel.appendChild(opt);
            }
            gpuSel.value = String(s.gpu_index || 0);
        } catch (e) { console.warn('get_gpu_list:', e); }

        // Weather
        wxLat.value = s.weather_lat || '';
        wxLon.value = s.weather_lon || '';
        wxKid.value = s.weather_key_id || '';
        wxSub.value = s.weather_project_id || '';
        wxKey.value = s.weather_private_key || '';

        // Monitor
        try {
            const monitors = await pywebview.api.get_monitors();
            monitorSel.innerHTML = '';
            monitors.forEach((m, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = `${m.name || 'Monitor'} (${m.width}x${m.height})`;
                monitorSel.appendChild(opt);
            });
            monitorSel.value = s.monitor || 0;
        } catch (e) { console.warn('get_monitors:', e); }
        hideMissingChk.checked = s.hide_when_monitor_missing === true;

        // Theme
        colorschemeSel.value = s.colorscheme || 'gruvbox';
        renderThemeCards(s.colorscheme || 'gruvbox', (scheme) => {
            colorschemeSel.value = scheme;
            applyColorscheme(scheme);
        });
        // Fonts
        fontUiValue = s.font_ui || 'JetBrains Maple Mono';
        fontDataValue = s.font_data || 'IoskeleyMono';
        fontClockValue = s.font_clock || 'Departure Mono';
        renderFontCards('ui', fontUiValue, (v) => { fontUiValue = v; applyFonts(fontUiValue, fontDataValue, fontClockValue); });
        renderFontCards('data', fontDataValue, (v) => { fontDataValue = v; applyFonts(fontUiValue, fontDataValue, fontClockValue); });
        renderFontCards('clock', fontClockValue, (v) => { fontClockValue = v; applyFonts(fontUiValue, fontDataValue, fontClockValue); });
        try {
            const bgList = await pywebview.api.get_bg_list();
            clockBgImgValue = s.clock_bg_image || '';
            renderImagePicker(clockBgImgPicker, bgList, clockBgImgValue, (val) => {
                clockBgImgValue = val;
                lastResolvedClockBg = { image: '', path: '' };
                applyClockBackgroundSetting(val, clockBgOpacityRange.value, clockBgBlurRange.value, clockBgGradientChk.checked, clockBgFitValue, clockBgOffsetX, clockBgOffsetY);
            });
        } catch (e) { console.warn('get_bg_list:', e); }

        // Clock sidebar background
        clockBgOpacityRange.value = String(s.clock_bg_opacity ?? 80);
        clockBgOpacityVal.textContent = (s.clock_bg_opacity ?? 80) + '%';
        clockBgBlurRange.value = String(s.clock_bg_blur || 0);
        clockBgBlurVal.textContent = (s.clock_bg_blur || 0) + 'px';
        clockBgGradientChk.checked = s.clock_bg_gradient !== false;
        clockBgFitValue = s.clock_bg_fit || 'fit';
        if (!clockBgFitSel.dataset.init) {
            initSegmented(clockBgFitSel, clockBgFitValue, (v) => {
                clockBgFitValue = v;
                updateClockBgGradientVisibility();
                updateClockBgOffsetVisibility();
                applyClockBackgroundSetting(clockBgImgValue, clockBgOpacityRange.value, clockBgBlurRange.value, clockBgGradientChk.checked, clockBgFitValue, clockBgOffsetX, clockBgOffsetY);
            });
            clockBgFitSel.dataset.init = '1';
        } else {
            clockBgFitSel.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === clockBgFitValue));
        }
        clockBgOffsetX = s.clock_bg_offset_x ?? 50;
        clockBgOffsetY = s.clock_bg_offset_y ?? 50;
        updateClockBgGradientVisibility();
        updateClockBgOffsetVisibility();

        // Clock format & show-seconds (Time subtab)
        clockFormatValue = s.clock_24h !== false ? '24' : '12';
        if (!clockFormatSel.dataset.init) {
            initSegmented(clockFormatSel, clockFormatValue, (v) => {
                clockFormatValue = v;
                _clock24 = (v === '24');
            });
            clockFormatSel.dataset.init = '1';
        } else {
            clockFormatSel.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === clockFormatValue));
        }
        clockShowSecondsChk.checked = s.clock_show_seconds !== false;
        _clockShowSeconds = clockShowSecondsChk.checked;
        clockShowSecondsChk.addEventListener('change', () => {
            _clockShowSeconds = clockShowSecondsChk.checked;
        });

        // Server mode
        serverModeChk.checked = s.server_mode === true;
        serverHostInput.value = s.server_host || '0.0.0.0';
        serverPortInput.value = s.server_port || 20622;
        serverAuthChk.checked = s.server_auth_enabled === true;
        serverUserInput.value = s.server_auth_user || '';
        serverPassInput.value = s.server_auth_pass || '';

        // Feature toggles
        const ft = s.feature_toggles || {};
        ['weather','music','fps','calendar','top_process','sysinfo','traffic','background'].forEach(key => {
            const cb = document.getElementById('ft-' + key);
            if (cb) cb.checked = ft[key] !== false;
        });

        // About tab
        loadAboutInfo();

        // Show overlay
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        tabBtns[0].classList.add('active');
        tabContents[0].classList.add('active');
        overlay.style.display = 'flex';
    }

    function closeSettings() {
        overlay.style.display = 'none';
    }

    async function saveSettings() {
        // Merge with existing settings to preserve keys not in the form (padding, etc.)
        const existing = window._appSettings || {};
        const s = {
            ...existing,
            language: languageSel.value,
            font_size: parseInt(fontsizeRange.value),
            fullscreen: fullscreenChk.checked,
            update_check_enabled: updateNotifyChk.checked,
            refresh_interval: parseInt(intervalSel.value),
            data_source: datasourceSel.value,
            gpu_index: parseInt(gpuSel.value) || 0,
            weather_lat: wxLat.value.trim(),
            weather_lon: wxLon.value.trim(),
            weather_key_id: wxKid.value.trim(),
            weather_project_id: wxSub.value.trim(),
            weather_private_key: wxKey.value.trim(),
            monitor: parseInt(monitorSel.value) || 0,
            hide_when_monitor_missing: hideMissingChk.checked,
            colorscheme: colorschemeSel.value,
            clock_bg_image: clockBgImgValue,
            clock_bg_opacity: parseInt(clockBgOpacityRange.value) || 0,
            clock_bg_blur: parseInt(clockBgBlurRange.value) || 0,
            clock_bg_gradient: clockBgGradientChk.checked,
            clock_bg_fit: clockBgFitValue,
            clock_bg_offset_x: clockBgOffsetX,
            clock_bg_offset_y: clockBgOffsetY,
            clock_24h: clockFormatValue !== '12',
            clock_show_seconds: clockShowSecondsChk.checked,
            font_ui: fontUiValue,
            font_data: fontDataValue,
            font_clock: fontClockValue,
            server_mode: serverModeChk.checked,
            server_host: serverHostInput.value.trim() || '0.0.0.0',
            server_port: parseInt(serverPortInput.value) || 20622,
            server_auth_enabled: serverAuthChk.checked,
            server_auth_user: serverUserInput.value.trim(),
            server_auth_pass: serverPassInput.value,
        };

        // Feature toggles
        s.feature_toggles = {};
        ['weather','music','fps','calendar','top_process','sysinfo','traffic','background'].forEach(key => {
            const cb = document.getElementById('ft-' + key);
            s.feature_toggles[key] = cb ? cb.checked : true;
        });

        await pywebview.api.save_settings(s);
        await pywebview.api.set_autostart(autostartChk.checked);
        await pywebview.api.change_backend(s.data_source);

        // Update global settings cache
        window._appSettings = { ...window._appSettings, ...s };

        cachedMonitor = s.monitor;
        cachedHideMissing = s.hide_when_monitor_missing;

        if (s.hide_when_monitor_missing) {
            const res = await pywebview.api.check_monitor();
            document.body.style.visibility = res.available ? 'visible' : 'hidden';
        } else {
            document.body.style.visibility = 'visible';
        }

        startPolling(s.refresh_interval);
        applyLang(s.language || 'en');
        applyFontSize(s.font_size);
        applyColorscheme(s.colorscheme || 'gruvbox');
        applyFonts(s.font_ui, s.font_data, s.font_clock);
        await applyClockBackgroundSetting(s.clock_bg_image, s.clock_bg_opacity, s.clock_bg_blur, s.clock_bg_gradient !== false, s.clock_bg_fit || 'fit', s.clock_bg_offset_x ?? 50, s.clock_bg_offset_y ?? 50);
        applyHwNames(true);
        _weatherConfigured = !!(s.weather_key_id && s.weather_project_id && s.weather_private_key);
        applyFeatureToggles(s.feature_toggles || {});

        const wxChanged = s.weather_lat !== oldWeatherLat || s.weather_lon !== oldWeatherLon ||
            s.weather_key_id !== oldWeatherKid || s.weather_project_id !== oldWeatherSub ||
            s.weather_private_key !== oldWeatherKey;
        if (wxChanged) {
            oldWeatherLat = s.weather_lat;
            oldWeatherLon = s.weather_lon;
            oldWeatherKid = s.weather_key_id;
            oldWeatherSub = s.weather_project_id;
            oldWeatherKey = s.weather_private_key;
            refreshWeather();
            refreshWeatherDetail();
        }

        closeSettings();
    }

    // Range inputs
    fontsizeRange.addEventListener('input', () => {
        fontsizeVal.textContent = fontsizeRange.value + '%';
        applyFontSize(parseInt(fontsizeRange.value));
    });
    // Clock sidebar background live preview
    clockBgOpacityRange.addEventListener('input', () => {
        clockBgOpacityVal.textContent = clockBgOpacityRange.value + '%';
        applyClockBackgroundSetting(clockBgImgValue, clockBgOpacityRange.value, clockBgBlurRange.value, clockBgGradientChk.checked, clockBgFitValue, clockBgOffsetX, clockBgOffsetY);
    });
    clockBgBlurRange.addEventListener('input', () => {
        clockBgBlurVal.textContent = clockBgBlurRange.value + 'px';
        applyClockBackgroundSetting(clockBgImgValue, clockBgOpacityRange.value, clockBgBlurRange.value, clockBgGradientChk.checked, clockBgFitValue, clockBgOffsetX, clockBgOffsetY);
    });
    clockBgGradientChk.addEventListener('change', () => {
        applyClockBackgroundSetting(clockBgImgValue, clockBgOpacityRange.value, clockBgBlurRange.value, clockBgGradientChk.checked, clockBgFitValue, clockBgOffsetX, clockBgOffsetY);
    });

    // Offset adjust modal
    clockBgOffsetBtn.addEventListener('click', () => {
        openClockBgOffsetModal(lastResolvedClockBg.path, clockBgOffsetX, clockBgOffsetY, (nx, ny) => {
            clockBgOffsetX = nx;
            clockBgOffsetY = ny;
            applyClockBackgroundSetting(clockBgImgValue, clockBgOpacityRange.value, clockBgBlurRange.value, clockBgGradientChk.checked, clockBgFitValue, nx, ny);
        });
    });

    saveBtn.addEventListener('click', saveSettings);
    closeBtn.addEventListener('click', closeSettings);
}

/* Top-hover Control Popup (brightness & volume) */
const TOP_HOVER_THRESHOLD = 6;
let _topControlVisible = false;
let _topControlHideTimer = null;
let _brightnessSetTimer = null;
let _volumeSetTimer = null;

function showTopControlPopup() {
    const popup = document.getElementById('top-control-popup');
    if (!popup) return;
    const wasVisible = _topControlVisible;
    popup.classList.add('visible');
    _topControlVisible = true;
    if (_topControlHideTimer) { clearTimeout(_topControlHideTimer); _topControlHideTimer = null; }
    // Only refresh values once when the popup first appears — not on every mousemove
    if (!wasVisible) {
        refreshTopControlValues();
    }
}

function hideTopControlPopup() {
    if (_topControlHideTimer) clearTimeout(_topControlHideTimer);
    _topControlHideTimer = setTimeout(() => {
        const popup = document.getElementById('top-control-popup');
        if (popup) popup.classList.remove('visible');
        _topControlVisible = false;
    }, 400);
}

async function refreshTopControlValues() {
    const bSlider = document.getElementById('brightness-slider');
    const bVal = document.getElementById('brightness-value');
    const vSlider = document.getElementById('volume-slider');
    const vVal = document.getElementById('volume-value');
    try {
        if (bSlider && bSlider.dataset.active !== '1') {
            const r = await pywebview.api.adjust_brightness('get');
            if (r && r.success) {
                bSlider.value = r.level;
                if (bVal) bVal.textContent = r.level + '%';
            } else if (bVal) {
                bVal.textContent = '--';
            }
        }
    } catch (e) { /* pywebview not ready */ }
    try {
        if (vSlider && vSlider.dataset.active !== '1') {
            const r = await pywebview.api.adjust_volume('get');
            if (r && r.success) {
                vSlider.value = r.level;
                if (vVal) vVal.textContent = r.level + '%';
            } else if (vVal) {
                vVal.textContent = '--';
            }
        }
    } catch (e) { /* pywebview not ready */ }
}

function setupTopControl() {
    const popup = document.getElementById('top-control-popup');
    if (!popup) return;
    const bSlider = document.getElementById('brightness-slider');
    const bVal = document.getElementById('brightness-value');
    const vSlider = document.getElementById('volume-slider');
    const vVal = document.getElementById('volume-value');

    // Trigger when mouse enters the top edge of the window — only on hidden→visible transition
    document.addEventListener('mousemove', (e) => {
        if (e.clientY <= TOP_HOVER_THRESHOLD && !_topControlVisible) {
            showTopControlPopup();
        }
    });

    popup.addEventListener('mouseenter', () => {
        if (_topControlHideTimer) { clearTimeout(_topControlHideTimer); _topControlHideTimer = null; }
    });
    popup.addEventListener('mouseleave', hideTopControlPopup);

    // Brightness slider — debounce writes so dragging doesn't spam DDC/CI calls
    if (bSlider) {
        bSlider.addEventListener('input', () => {
            bSlider.dataset.active = '1';
            if (bVal) bVal.textContent = bSlider.value + '%';
            if (_brightnessSetTimer) clearTimeout(_brightnessSetTimer);
            _brightnessSetTimer = setTimeout(() => {
                pywebview.api.adjust_brightness('set', parseInt(bSlider.value, 10));
                delete bSlider.dataset.active;
            }, 150);
        });
    }

    // Volume slider — same debounce pattern
    if (vSlider) {
        vSlider.addEventListener('input', () => {
            vSlider.dataset.active = '1';
            if (vVal) vVal.textContent = vSlider.value + '%';
            if (_volumeSetTimer) clearTimeout(_volumeSetTimer);
            _volumeSetTimer = setTimeout(() => {
                pywebview.api.adjust_volume('set', parseInt(vSlider.value, 10));
                delete vSlider.dataset.active;
            }, 100);
        });
    }

    // Mouse wheel support — adjust whichever item the cursor is over
    const WHEEL_STEP = 5;
    const bItem = bSlider ? bSlider.closest('.top-control-item') : null;
    const vItem = vSlider ? vSlider.closest('.top-control-item') : null;

    if (bItem) {
        bItem.addEventListener('wheel', (e) => {
            e.preventDefault();
            const cur = parseInt(bSlider.value, 10) || 0;
            const next = Math.max(0, Math.min(100, cur + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)));
            bSlider.value = next;
            bSlider.dispatchEvent(new Event('input'));
        }, { passive: false });
    }
    if (vItem) {
        vItem.addEventListener('wheel', (e) => {
            e.preventDefault();
            const cur = parseInt(vSlider.value, 10) || 0;
            const next = Math.max(0, Math.min(100, cur + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)));
            vSlider.value = next;
            vSlider.dispatchEvent(new Event('input'));
        }, { passive: false });
    }
}

/* Show body ASAP if boot hangs */
let _bodyShown = false;
function showBody() {
    if (!_bodyShown) { document.body.style.visibility = 'visible'; _bodyShown = true; }
}
setTimeout(showBody, 5000);

/* ── 首次启动右上角提示 ─────────────────────────────────────── */
let _hintTimer = null;
let _hintDismissed = false;

function persistHintDismissed() {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.dismiss_first_launch_hint) {
        window.pywebview.api.dismiss_first_launch_hint().catch(() => {});
    }
}

function dismissFirstLaunchHint() {
    if (_hintDismissed) return;
    _hintDismissed = true;
    if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
    const el = document.getElementById('first-launch-hint');
    if (el) {
        el.classList.remove('hint-show');
        el.classList.add('hint-hide');
        setTimeout(() => { el.style.display = 'none'; }, 250);
    }
    // 持久化标记，后续启动不再显示
    persistHintDismissed();
}

function maybeShowFirstLaunchHint(s) {
    if (!s || s.hint_dismissed) return;
    const el = document.getElementById('first-launch-hint');
    if (!el) return;
    el.style.display = 'flex';
    requestAnimationFrame(() => el.classList.add('hint-show'));
    _hintTimer = setTimeout(dismissFirstLaunchHint, 15000);
    el.addEventListener('click', dismissFirstLaunchHint);
    const closeBtn = document.getElementById('first-launch-hint-close');
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismissFirstLaunchHint(); });
    // 只要显示出了提示，就立即持久化标记；无论用户按 S / 点关闭 / 自动超时，后续启动都不再显示
    persistHintDismissed();
}

/* Boot */
let __bootStarted = false;
window.addEventListener('pywebviewready', async () => {
    // 幂等守卫：防止 pywebviewready 重复派发导致重复初始化（重复轮询/重复日志转发）
    if (__bootStarted) return;
    __bootStarted = true;
    // Redirect console to Python logger
    (function() {
        const origLog = console.log;
        const origWarn = console.warn;
        const origError = console.error;
        function forward(level, args) {
            try {
                const msg = Array.from(args).map(a => {
                    if (typeof a === 'object') try { return JSON.stringify(a); } catch(e) { return String(a); }
                    return String(a);
                }).join(' ');
                pywebview.api.js_log(level, msg);
            } catch (e) { /* ignore */ }
        }
        console.log = function() { forward('debug', arguments); origLog.apply(console, arguments); };
        console.warn = function() { forward('warning', arguments); origWarn.apply(console, arguments); };
        console.error = function() { forward('error', arguments); origError.apply(console, arguments); };
    })();

    const s = await pywebview.api.get_settings();
    window._appSettings = s;
    _weatherConfigured = !!(s.weather_key_id && s.weather_project_id && s.weather_private_key);
    console.log('Boot settings:', JSON.stringify({ lang: s.language, scheme: s.colorscheme }));

    applyLang(s.language || 'en');
    applyColorscheme(s.colorscheme || 'gruvbox');
    applyFonts(s.font_ui, s.font_data, s.font_clock);
    await applyClockBackgroundSetting(s.clock_bg_image, s.clock_bg_opacity, s.clock_bg_blur, s.clock_bg_gradient !== false, s.clock_bg_fit || 'fit', s.clock_bg_offset_x ?? 50, s.clock_bg_offset_y ?? 50);
    applyFontSize(s.font_size || 100);

    // Move to target monitor + fullscreen, then show
    if (s.monitor) {
        await pywebview.api.move_to_monitor(s.monitor);
    }
    if (s.fullscreen !== false) {
        pywebview.api.toggle_fullscreen();
    } else {
        // 非全屏时恢复原生标题栏（右上角最小化/最大化/关闭三键）
        pywebview.api.set_caption(true);
    }
    showBody();
    maybeShowFirstLaunchHint(s);

    // 时钟区域悬停：背景图片透明度 +10%（无图时透明度为 0，悬停不生效）
    const clockSectionEl = document.getElementById('clock-section');
    const clockBgLayerEl = document.getElementById('clock-bg-image');
    if (clockSectionEl && clockBgLayerEl) {
        clockSectionEl.addEventListener('mouseenter', () => {
            if (!(clockBgState.opacity > 0)) return;
            clockBgLayerEl.style.opacity = String(Math.min(1, clockBgState.opacity + 0.1));
        });
        clockSectionEl.addEventListener('mouseleave', () => {
            if (!(clockBgState.opacity > 0)) return;
            clockBgLayerEl.style.opacity = String(clockBgState.opacity);
        });
    }

    await loadHwNames();
    applyHwNames(true);
    loadHwDetail();

    oldWeatherLat = s.weather_lat || '';
    oldWeatherLon = s.weather_lon || '';
    oldWeatherKid = s.weather_key_id || '';
    oldWeatherSub = s.weather_project_id || '';
    oldWeatherKey = s.weather_private_key || '';

    initSettings();
    setupTopControl();
    // Disk partition hover: populate details on mouseenter
    const diskSection = document.getElementById('disk-section');
    if (diskSection) {
        diskSection.addEventListener('mouseenter', renderDiskPartitions);
    }
    startClock();
    startPolling(s.refresh_interval);

    // Version update check — delayed so the popup doesn't interrupt startup
    if (s.update_check_enabled !== false) {
        setTimeout(checkForUpdate, 3000);
    }

    // Apply feature toggles - hide UI elements for disabled features
    applyFeatureToggles(s.feature_toggles || {});
    const ft = s.feature_toggles || {};

    // Start intervals only for enabled features (weather also needs credentials configured)
    const weatherOn = ft.weather !== false && _weatherConfigured;
    _startInterval(weatherOn, refreshWeather, 600000);
    _startInterval(weatherOn, refreshWeatherDetail, 600000);
    _startInterval(weatherOn, refreshAirQuality, 1800000);
    _startInterval(weatherOn, refreshAlerts, 600000);
    _startInterval(ft.music !== false, refreshMusic, 3000);
    _startInterval(ft.fps !== false, refreshFps, 1000);
    _startInterval(ft.sysinfo !== false, refreshSysinfo, 60000);
    _startInterval(ft.top_process !== false, refreshTopProcess, 2000);
    // Fit the process list to the actual box height once the initial layout is done.
    setTimeout(recalcProcLimit, 800);

    // Music transport controls — previous / play-pause / next buttons
    const bindMusicCtrl = (id, action) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', async () => {
            try {
                await action();
                refreshMusic();
            } catch (e) { console.warn('music ctrl:', e); }
        });
    };
    bindMusicCtrl('h-music-prev', () => pywebview.api.music_prev());
    bindMusicCtrl('h-music-toggle', () => pywebview.api.music_play_pause());
    bindMusicCtrl('h-music-next', () => pywebview.api.music_next());

    // Top process interactions
    const procListEl = document.getElementById('proc-list');
    if (procListEl) procListEl.addEventListener('click', (e) => {
        // Click the usage value to switch between CPU % and memory usage
        const valEl = e.target.closest('.proc-value');
        if (valEl) {
            procMode = procMode === 'cpu' ? 'mem' : 'cpu';
            refreshTopProcess();
            return;
        }
        const nameEl = e.target.closest('.proc-name');
        if (nameEl && nameEl.dataset.pid) {
            const pid = parseInt(nameEl.dataset.pid);
            if (!isNaN(pid)) showKillConfirm(pid, nameEl.dataset.name || nameEl.textContent);
        }
    });
    const killCancelBtn = document.getElementById('kill-btn-cancel');
    if (killCancelBtn) killCancelBtn.addEventListener('click', hideKillConfirm);
    const killOkBtn = document.getElementById('kill-btn-ok');
    if (killOkBtn) killOkBtn.addEventListener('click', confirmKill);
    const killOverlay = document.getElementById('kill-confirm-overlay');
    if (killOverlay) killOverlay.addEventListener('click', (e) => {
        if (e.target === killOverlay) hideKillConfirm();
    });
    // 通用应用内确认弹窗
    const appConfirmCancelBtn = document.getElementById('app-confirm-cancel');
    if (appConfirmCancelBtn) appConfirmCancelBtn.addEventListener('click', hideAppConfirm);
    const appConfirmOkBtn = document.getElementById('app-confirm-ok');
    if (appConfirmOkBtn) appConfirmOkBtn.addEventListener('click', () => {
        const cb = _appConfirmCb;
        hideAppConfirm();
        if (cb) cb();
    });
    const appConfirmOverlay = document.getElementById('app-confirm-overlay');
    if (appConfirmOverlay) appConfirmOverlay.addEventListener('click', (e) => {
        if (e.target === appConfirmOverlay) hideAppConfirm();
    });

    // Update available modal
    const updateLaterBtn = document.getElementById('update-later');
    if (updateLaterBtn) updateLaterBtn.addEventListener('click', hideUpdateModal);
    const updateOverlay = document.getElementById('update-overlay');
    if (updateOverlay) updateOverlay.addEventListener('click', (e) => {
        if (e.target === updateOverlay) hideUpdateModal();
    });
    const updateGotoEl = document.getElementById('update-goto');
    if (updateGotoEl) updateGotoEl.addEventListener('click', (e) => {
        e.preventDefault();
        const url = updateGotoEl.getAttribute('href');
        if (!url || url === '#' || url === '') return;
        if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
            window.pywebview.api.open_external(url).catch(function() { window.open(url, '_blank'); });
        } else {
            window.open(url, '_blank');
        }
    });

    // Task Manager: hover show button, click to launch Windows Task Manager
    const procSection = document.getElementById('proc-section');
    const taskmgrBtn = document.getElementById('proc-taskmgr-btn');
    let taskmgrBtnTimer = null;
    if (procSection && taskmgrBtn) {
        procSection.addEventListener('mouseenter', function() {
            if (taskmgrBtnTimer) clearTimeout(taskmgrBtnTimer);
            taskmgrBtn.classList.add('visible');
        });
        procSection.addEventListener('mouseleave', function() {
            taskmgrBtnTimer = setTimeout(function() {
                taskmgrBtn.classList.remove('visible');
            }, 300);
        });
        taskmgrBtn.addEventListener('mouseenter', function() {
            if (taskmgrBtnTimer) clearTimeout(taskmgrBtnTimer);
        });
        taskmgrBtn.addEventListener('mouseleave', function() {
            taskmgrBtn.classList.remove('visible');
        });
        taskmgrBtn.addEventListener('click', function() {
            pywebview.api.open_taskmgr();
        });
    }

    // Monitor presence polling
    let monitorHidden = false;
    let cachedMonitor = s.monitor || 0;
    let cachedHideMissing = s.hide_when_monitor_missing === true;

    async function checkMonitor() {
        try {
            if (!cachedHideMissing) {
                if (monitorHidden) {
                    document.body.style.visibility = 'visible';
                    monitorHidden = false;
                    await pywebview.api.move_to_monitor(cachedMonitor);
                }
                return;
            }
            const res = await pywebview.api.check_monitor();
            if (res.available) {
                if (monitorHidden) {
                    document.body.style.visibility = 'visible';
                    monitorHidden = false;
                    await pywebview.api.move_to_monitor(cachedMonitor);
                }
            } else {
                if (!monitorHidden) {
                    document.body.style.visibility = 'hidden';
                    monitorHidden = true;
                }
            }
        } catch (e) { console.warn('checkMonitor:', e); }
    }

    checkMonitor();
    setInterval(checkMonitor, 5000);

});
