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
let _hoverHighlightEnabled = true; // settings-driven: dim other boxes when hovering one

function initTermBoxFocusDim() {
    const grid = document.querySelector('.term-grid');
    if (!grid) return;
    const boxes = grid.querySelectorAll('.term-box');
    if (boxes.length < 2) return;
    const setDim = (focused) => {
        boxes.forEach(b => b.classList.toggle('dimmed', _hoverHighlightEnabled && !!focused && b !== focused));
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

/* Enable/disable hover highlight on the monitoring boxes */
function applyHoverHighlight(enabled) {
    _hoverHighlightEnabled = !!enabled;
    if (!_hoverHighlightEnabled) {
        document.querySelectorAll('.term-box.dimmed').forEach(b => b.classList.remove('dimmed'));
    }
}

/* Enable/disable the card hover border-ring animation */
let _hoverAnimEnabled = true; // settings-driven: animated border ring on hover
function applyHoverAnim(enabled) {
    _hoverAnimEnabled = !!enabled;
    document.body.classList.toggle('no-hover-anim', !_hoverAnimEnabled);
}

/* Enable/disable lyric horizontal scroll animation (歌词过长时的滚动动画).
   Only gates the single-line horizontal scroll; line switching is always instant. */
let _lyricAnimEnabled = false; // settings-driven: horizontal scroll only

function applyLyricAnim(enabled) {
    _lyricAnimEnabled = !!enabled;
    if (!_lyricAnimEnabled) {
        document.querySelectorAll('.h-lyric-current, .h-lyric-next').forEach(el => el.scrollLeft = 0);
    }
}

/* Enable/disable auto-detection of translations in lyric lines.
   A line like "Original text (翻译)" is split into two normal lyric lines:
   translation first, original second. */
let _lyricAutoTranslate = false;

/* 根据 _lyricAutoTranslate 从原始行生成实际显示的歌词行。
   开启时把 "原文 (翻译)" 拆成两行（翻译在前、原文在后，同一时间戳）。 */
function _applyLyricTransform() {
    if (!_lyricAutoTranslate) {
        _lyricLines = _lyricRawLines;
        return;
    }
    _lyricLines = [];
    for (const l of _lyricRawLines) {
        const split = _splitLyricTranslation(l.text);
        if (split) {
            _lyricLines.push({ time: l.time, text: split.translation, trans: true });
            _lyricLines.push({ time: l.time, text: split.original });
        } else {
            _lyricLines.push(l);
        }
    }
}

function applyLyricAutoTranslate(enabled) {
    _lyricAutoTranslate = !!enabled;
    _applyLyricTransform();
    _lyricCurIdx = -1;
    if (_lyricActive) renderLyrics();
}

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
                    } else if (section.id === 'fps-section') {
                        // fps: show the FPS value at this instant (dynamic max → no %)
                        label = timeStr + ' ' + Math.round(val) + ' FPS';
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
let _lastFpsScale = 1; // font-size multiplier for the FPS big value (fewer for more digits)
// More digits -> smaller font, so high FPS / high refresh values fit the box.
// The big card keeps the full size — only the small card shrinks long numbers.
function fpsShrinkScale(str) {
    const digits = String(str || '').replace(/\D/g, '').length;
    if (digits <= 2) return 1;     // 0-99
    if (digits === 3) return 0.7;  // 100-999
    if (digits === 4) return 0.55; // 1000-9999
    return 0.45;                   // 10000+
}

/* Re-apply the FPS big-value font size for the current card size:
   span 2 (big) always uses the full size; span 1 uses a smaller base size
   with the digit-based shrink on top. */
function _applyFpsFontSize() {
    const fpsEl = document.getElementById('fps-val');
    if (!fpsEl) return;
    const section = document.getElementById('fps-section');
    const big = section && section.dataset.span === '2';
    const scale = big ? 1 : (_lastFpsScale || 1);
    const base = big ? 'clamp(72px, 8vw, 120px)' : 'clamp(48px, 5.5vw, 80px)';
    fpsEl.style.fontSize = `calc(${scale} * ${base} * var(--font-scale))`;
}

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
            const fpsSection = document.getElementById('fps-section');
            const big = fpsSection && fpsSection.dataset.span === '2';
            const scale = big ? 1 : fpsShrinkScale(fpsStr);
            if (_lastFpsScale !== scale) {
                _lastFpsScale = scale;
                _applyFpsFontSize();
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
    const procSection = document.getElementById('proc-section');
    if (procSection && procSection.style.display === 'none') return; // 卡片被删除时不再获取进程信息
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

/* ── 服务端模式提示框 ── */
function showServerInfoModal(info) {
    const overlay = document.getElementById('server-info-overlay');
    if (!overlay) return;
    const urlsEl = document.getElementById('server-info-urls');
    if (urlsEl) {
        urlsEl.innerHTML = '';
        const urls = (info && Array.isArray(info.urls)) ? info.urls : [];
        for (const u of urls) {
            const div = document.createElement('div');
            div.textContent = u;
            urlsEl.appendChild(div);
        }
    }
    const pathEl = document.getElementById('server-info-path');
    if (pathEl) pathEl.textContent = (info && info.settings_file) || '--';
    overlay.style.display = 'flex';
}

function hideServerInfoModal() {
    const overlay = document.getElementById('server-info-overlay');
    if (overlay) overlay.style.display = 'none';
}

/* ── 版本更新检测 ── */
function showUpdateModal(info) {
    const overlay = document.getElementById('update-overlay');
    if (!overlay) return;
    const verEl = document.getElementById('update-version');
    if (verEl) verEl.textContent = (info.current_version || '--') + '  →  ' + (info.latest_version || '--');
    const dateEl = document.getElementById('update-date');
    if (dateEl) {
        const pub = formatUpdateDate(info.published_at);
        dateEl.textContent = pub ? ((t && t('update-published')) || 'Published') + ' ' + pub : '';
        dateEl.style.display = pub ? '' : 'none';
    }
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
/* Lyrics */
let _lyricLines = [];      // 当前曲目的歌词行 [{time, text}, ...]（可能已展开翻译）
let _lyricRawLines = [];   // 未展开的原始歌词行（翻译模式开启时由它生成 _lyricLines）
let _lyricKey = '';        // 当前已加载歌词的曲目标识 "title|artist"
let _lyricBase = { pos: 0, t: 0 };  // 轮询间隙内插值估算当前时间的基准
let _lyricTimer = null;    // 歌词平滑推进定时器
let _lyricActive = false;  // 是否处于歌词显示模式
let _lyricHover = false;   // 鼠标是否悬停在歌词上（悬停时显示播放控件）
let _lyricCurIdx = -1;     // 当前渲染句子的下标，用于切换句子时重置水平滚动

/* Large-card progress bar */
let _musicBase = { pos: 0, t: 0 };    // 轮询间隙内插值估算当前进度的基准
let _musicDur = 0;                    // 当前曲目总时长（秒）
let _musicPlaying = true;             // 是否正在播放（暂停时不推进进度）
let _progressTimer = null;            // 进度条平滑推进定时器
let _seeking = false;                 // 用户正在拖动进度条（拖动时暂停自动刷新）

/* 格式化为 m:ss */
function fmtMusicTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
}

/* Show/hide the seek bar + remaining time. Shown only when playback progress
   (duration) is actually available. */
function _setMusicProgressVisible(show) {
    const section = document.getElementById('music-section');
    if (section) section.classList.toggle('progress-active', !!show);
}

/* Update the seek bar + remaining time + hover tooltip from interpolated
   position. */
function updateMusicProgress() {
    const seek = document.getElementById('h-music-seek');
    const tip = document.getElementById('h-music-seek-tip');
    const left = document.getElementById('h-music-time-left');
    if (!seek) return;
    if (_seeking) return;
    const pos = _musicPlaying ? _musicBase.pos + (Date.now() - _musicBase.t) / 1000 : _musicBase.pos;
    seek.value = _musicDur > 0 ? Math.min(1000, Math.round(pos / _musicDur * 1000)) : 0;
    seek.style.setProperty('--seek-fill', (seek.value / 10) + '%');
    if (left) left.textContent = '-' + fmtMusicTime(_musicDur - pos);
    if (tip) {
        tip.textContent = fmtMusicTime(pos);
        tip.style.left = (seek.value / 10) + '%';
    }
}

/* 根据播放进度找到当前行 cur、下一行 next 与行下标 curIdx。
   翻译模式下，同一时间戳的「翻译 + 原文」成对处理：翻译是当前行、原文是下一行。 */
function _findLyricAt(pos) {
    let cur = null, next = null, curIdx = -1;
    for (let i = 0; i < _lyricLines.length; i++) {
        if (_lyricLines[i].time <= pos) { cur = _lyricLines[i]; curIdx = i; }
        else { next = _lyricLines[i]; break; }
    }
    if (_lyricAutoTranslate && cur && curIdx > 0 && _lyricLines[curIdx - 1].trans === true && _lyricLines[curIdx - 1].time === cur.time) {
        return { cur: _lyricLines[curIdx - 1], next: cur, curIdx: curIdx - 1 };
    }
    return { cur, next, curIdx };
}
/* 更新三段歌词文本（上一句 / 当前句 / 下一句） */
function _setLyricTexts(prevEl, curEl, nextEl, prev, cur, next) {
    if (prevEl) prevEl.textContent = (prev && prev.text) ? prev.text : '';
    curEl.textContent = (cur && cur.text) ? cur.text : '♪';
    nextEl.textContent = (next && next.text) ? next.text : '';
}

/* 把形如 "原文 (翻译)" 的歌词行拆成 {original, translation}；不匹配返回 null */
function _splitLyricTranslation(text) {
    if (!text) return null;
    const m = text.match(/^(.*?)\s*[（(]([^（）()]*)[)）]\s*$/);
    if (m && m[1].trim() && m[2].trim()) {
        return { original: m[1].trim(), translation: m[2].trim() };
    }
    return null;
}

/* Render the prev + current + next lyric lines based on interpolated position.
   仅刷新文本（歌词刚抓取完成等场景需要立即补一次）；滚动由 rAF 循环负责。 */
function renderLyrics() {
    if (!_lyricActive) return;
    const prevEl = document.getElementById('h-lyric-prev');
    const curEl = document.getElementById('h-lyric-current');
    const nextEl = document.getElementById('h-lyric-next');
    if (!curEl || !nextEl) return;
    const pos = _lyricBase.pos + (Date.now() - _lyricBase.t) / 1000;
    const { cur, next, curIdx } = _findLyricAt(pos);
    const prev = curIdx > 0 ? _lyricLines[curIdx - 1] : null;
    _setLyricTexts(prevEl, curEl, nextEl, prev, cur, next);
}

/* 单行长歌词水平滚动：超出容器的部分按「当前句时长」（到下一句的时间）均匀
   滚完整行，由播放进度驱动 scrollLeft，滚动速度随句长自适应。 */
function _scrollCurrentLine(curEl, cur, next, pos) {
    if (!cur || !cur.text) { curEl.scrollLeft = 0; return; }
    const over = curEl.scrollWidth - curEl.clientWidth;
    if (over <= 0) { curEl.scrollLeft = 0; return; }
    const dur = (next ? next.time : pos + 4) - cur.time;  // 本句时长（秒）
    const span = Math.max(dur, 2.5);                       // 至少 2.5s 滚完
    const p = Math.min(Math.max((pos - cur.time) / span, 0), 1);
    curEl.scrollLeft = p * over;
}

/* 歌词动画循环（每帧 rAF）：
   - 文本：切句瞬间立即刷新（_lyricCurIdx 变化即更新），不再依赖 500ms 定时器，
     因此歌词切换及时。
   - 滚动：切句时立即把当前行 scrollLeft 归零（从行首开始），随后每帧由
     _scrollCurrentLine 向右平滑推进，实现单行长歌词的水平滚动。
   - 切句动画：不做向上/向下滚动过渡，直接替换文本（简单、省性能）。 */
let _lyricRaf = null;      // requestAnimationFrame 句柄

function _lyricAnimLoop() {
    _lyricRaf = requestAnimationFrame(_lyricAnimLoop);
    if (!_lyricActive) return;
    const prevEl = document.getElementById('h-lyric-prev');
    const curEl = document.getElementById('h-lyric-current');
    const nextEl = document.getElementById('h-lyric-next');
    if (!curEl || !nextEl) return;
    const pos = _lyricBase.pos + (Date.now() - _lyricBase.t) / 1000;
    const { cur, next, curIdx } = _findLyricAt(pos);
    if (curIdx !== _lyricCurIdx) {
        _lyricCurIdx = curIdx;
        const prev = curIdx > 0 ? _lyricLines[curIdx - 1] : null;
        _setLyricTexts(prevEl, curEl, nextEl, prev, cur, next);
        curEl.scrollLeft = 0;
    }
    if (!_lyricAnimEnabled) { if (curEl.scrollLeft) curEl.scrollLeft = 0; return; }
    _scrollCurrentLine(curEl, cur, next, pos);
}

/* Apply current view: controls shown either when not in lyric mode, or when
   the mouse is hovering over the card (so users can control playback).
   When hovering, lyrics are hidden; otherwise lyrics are shown. */
function applyLyricView() {
    const controls = document.getElementById('h-music-controls');
    const lyrics = document.getElementById('h-music-lyrics');
    if (!controls || !lyrics) return;
    if (_lyricActive && !_lyricHover) {
        controls.style.display = 'none';
        lyrics.style.display = 'flex';
    } else {
        controls.style.display = '';
        lyrics.style.display = 'none';
    }
}

/* Enter lyrics mode: show lyric lines, start the lyric timer + smooth scroll
   loop. Controls are hidden until the mouse hovers over the lyrics. */
function showLyrics(m) {
    _lyricActive = true;
    _lyricBase = { pos: m.position || 0, t: Date.now() };
    _lyricCurIdx = -1;   // 强制重置，保证重新进入时水平滚动从 0 开始
    applyLyricView();
    if (!_lyricTimer) {
        _lyricTimer = setInterval(renderLyrics, 500);
    }
    if (!_lyricRaf) {
        _lyricRaf = requestAnimationFrame(_lyricAnimLoop);
    }
    renderLyrics();
}

/* Exit lyrics mode: restore controls, stop the lyric timer and scroll loop. */
function hideLyrics() {
    _lyricActive = false;
    _lyricHover = false;
    _lyricCurIdx = -1;
    applyLyricView();
    if (_lyricTimer) { clearInterval(_lyricTimer); _lyricTimer = null; }
    if (_lyricRaf) { cancelAnimationFrame(_lyricRaf); _lyricRaf = null; }
    const curEl = document.getElementById('h-lyric-current');
    if (curEl) {
        curEl.scrollLeft = 0;
        curEl.style.transition = '';
        curEl.style.opacity = '';
        curEl.style.transform = '';
    }
}

/* Toggle whether the mouse is over the lyrics — revealing/hiding controls. */
function setLyricHover(on) {
    _lyricHover = on;
    applyLyricView();
}

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
            _musicPlaying = !!m.playing;
            setText('h-music-title', m.title || '--');
            setText('h-music-artist', m.artist || '--');
            const procEl = document.getElementById('h-music-process');
            if (procEl) procEl.textContent = m.process_name || '';
            // Feed the progress bar: interpolate from position between polls.
            if (m.duration > 0) {
                _musicBase = { pos: m.position || 0, t: Date.now() };
                _musicDur = m.duration;
                if (!_progressTimer) _progressTimer = setInterval(updateMusicProgress, 500);
                updateMusicProgress();
            }
            _setMusicProgressVisible(m.duration > 0);
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
                section.style.display = _sectionVisible('music-section') ? 'flex' : 'none';
                section.classList.toggle('paused', !m.playing);
                section.classList.remove('not-playing');
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
            if (section) {
                section.classList.add('paused');
                section.classList.add('not-playing');
            }
            if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
            _musicDur = 0;
            _musicPlaying = false;
            _musicBase = { pos: 0, t: Date.now() };
            _setMusicProgressVisible(false);
            updateMusicProgress();
        }
        if (toggleBtn) {
            // Pause (⏸) while playing, Play (⏵) while paused
            toggleBtn.textContent = m.playing ? '⏸' : '⏵';
        }
        handleLyrics(m);
    } catch (e) { console.warn('refreshMusic:', e && e.message ? e.message : String(e), e); }
}

/* Decide whether to show lyrics (playing + position available + configured
   + process in whitelist). Fetches lyrics once per track, then shows
   current/next lines over the controls. */
function handleLyrics(m) {
    const s = window._appSettings || {};
    const metingBase = s.meting_api_base || '';
    const inWhitelist = processInLyricsWhitelist(s.lyrics_process_whitelist, m && m.process_name);
    const lyricMode = !!(m && m.playing && m.position >= 0 && m.duration > 0 && metingBase && inWhitelist);
    if (!lyricMode) {
        if (_lyricActive) hideLyrics();
        return;
    }
    const key = (m.title || '') + '|' + (m.artist || '');
    if (_lyricKey === key) {
        // Same track already loaded — keep advancing
        if (_lyricActive) {
            _lyricBase = { pos: m.position || 0, t: Date.now() };
            renderLyrics();
        } else {
            showLyrics(m);
        }
        return;
    }
    // New track — show placeholder immediately, then fetch once
    _lyricKey = key;
    _lyricRawLines = [];
    _lyricLines = [];
    showLyrics(m);
    pywebview.api.get_lyrics(m.title, m.artist).then((res) => {
        _lyricRawLines = (res && res.lines) || [];
        _applyLyricTransform();
        if (_lyricActive) renderLyrics();
    }).catch(() => {
        _lyricRawLines = [];
        _lyricLines = [];
        if (_lyricActive) renderLyrics();
    });
}

/* 判断进程名是否在歌词白名单内。白名单逗号分隔，大小写不敏感、支持子串匹配
   （如 "potplayer" 能匹配 "potplayer64"）。留空表示不限制任何进程。 */
function processInLyricsWhitelist(whitelist, processName) {
    const pn = (processName || '').toLowerCase();
    const list = String(whitelist || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return true;       // 未配置白名单 → 不限制
    if (!pn) return false;
    return list.some(w => pn.includes(w) || w.includes(pn));
}

/* Wire hover on the whole music area: hovering anywhere over it reveals
   playback controls (when in lyric mode). Binding on the persistent container
   avoids a flicker loop that would occur if the hidden lyrics element
   disappeared from under the cursor. */
function bindLyricHover() {
    const section = document.getElementById('music-section');
    if (!section) return;
    section.addEventListener('mouseenter', () => setLyricHover(true));
    section.addEventListener('mouseleave', () => setLyricHover(false));
}

/* Spawn a ripple from the pointer position on a music control button */
function spawnCtrlRipple(btn, event) {
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const cx = (event && event.clientX != null) ? event.clientX : rect.left + rect.width / 2;
    const cy = (event && event.clientY != null) ? event.clientY : rect.top + rect.height / 2;
    const ripple = document.createElement('span');
    ripple.className = 'ctrl-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (cx - rect.left - size / 2) + 'px';
    ripple.style.top = (cy - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
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

/* HW Detail cache */
let hwDetailCache = null;

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
    setText('mem-hw-name', mem.name || mem.part_number || '');
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

function wxCategory(iconCode) {
    const c = String(iconCode);
    if (c === '100' || c === '150') return 'sun';
    if (c === '900' || c === '901') return 'storm';
    if (c.startsWith('4')) return 'snow';
    if (c.startsWith('3')) return 'rain';
    if (c.startsWith('5')) return 'fog';
    if (c === '104' || c === '153') return 'overcast';
    return 'cloud';
}

function wxGradFactor(temp, category, detail) {
    if (category === 'rain' || category === 'storm') {
        let peak = 0;
        if (detail && detail.minutely && Array.isArray(detail.minutely.minutely)) {
            for (const m of detail.minutely.minutely) {
                const p = parseFloat(m.precip);
                if (p > peak) peak = p;
            }
        }
        return Math.max(0.15, Math.min(1, peak / 3));
    }
    const t = parseFloat(temp);
    if (isNaN(t)) return 0.5;
    return Math.max(0.15, Math.min(1, (t + 10) / 45));
}

function wxAlertTimeStr(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
}

function wxAlertPublishHTML(a) {
    const latest = wxAlertTimeStr(a.publishTime);
    if (!latest) return '';
    let out = `发布于 ${latest}`;
    const isUpdate = (a.messageTypeCode || '') === 'update';
    const orig = wxAlertTimeStr(a.initialPublishTime);
    if (isUpdate && orig && orig !== latest) out += ` - 初始发布于 ${orig}`;
    return out;
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

function formatUpdateDate(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const opts = { year: 'numeric', month: 'long', day: 'numeric' };
    const lang = (typeof getCurrentLang === 'function') ? getCurrentLang() : 'en';
    const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
    return d.toLocaleDateString(locale, opts);
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
async function refreshAlerts() {
    try {
        const alerts = await pywebview.api.get_alerts();
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
            const pubLine = wxAlertPublishHTML(a);
            div.innerHTML = `<span class="alert-type">${a.eventType || ''}</span><span class="alert-headline">${escapeHtml(a.headline || '')}</span>${a.description ? '<br><span class="alert-desc">' + escapeHtml(a.description) + '</span>' : ''}${pubLine ? '<br><span class="alert-time">' + pubLine + '</span>' : ''}`;
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

/* Weather card — dedicated grid card with big/small variants. The small card
   hides the precipitation forecast and alerts sections via CSS. */

/* Floating alert tooltip — lives on <body> so it is never clipped by the card */
let _wxTipEl = null;

function hideWxTip() {
    if (_wxTipEl) { _wxTipEl.remove(); _wxTipEl = null; }
}

function showWxTip(chip, a) {
    hideWxTip();
    const tip = document.createElement('div');
    tip.className = 'wx-tip';
    tip.style.setProperty('--tip-color', a.colorCode ? `rgb(${a.colorR},${a.colorG},${a.colorB})` : 'var(--red)');
    const pubLine = wxAlertPublishHTML(a);
    let html = `<div class="wx-tip-head"><span class="nf-icon">&#xF05D6;</span><span class="wx-tip-type">${escapeHtml(a.eventType || 'Warning')}</span></div>`;
    if (a.headline) html += `<div class="wx-tip-headline">${escapeHtml(a.headline)}</div>`;
    if (a.description) html += `<div class="wx-tip-desc">${escapeHtml(a.description)}</div>`;
    if (pubLine) html += `<div class="wx-tip-foot"><span class="nf-icon">&#xF0150;</span><span>${pubLine}</span></div>`;
    tip.innerHTML = html;
    document.body.appendChild(tip);
    _wxTipEl = tip;

    const rect = chip.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - tw - 8));
    let top = rect.top - th - 8;
    if (top < 8) top = rect.bottom + 8;
    if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
}

async function refreshWeatherCard() {
    try {
        const section = document.getElementById('weather-section');
        if (!section) return;
        const [w, d, aq, alerts] = await Promise.all([
            pywebview.api.get_weather(),
            pywebview.api.get_weather_detail(),
            pywebview.api.get_airquality(),
            pywebview.api.get_alerts(),
        ]);

        // Main block: icon + temperature + condition + city
        const cardIcon = document.getElementById('wx-card-icon');
        const cardTemp = document.getElementById('wx-card-temp');
        const cardText = document.getElementById('wx-card-text');
        const cardCity = document.getElementById('wx-card-city');
        const cardUpdated = document.getElementById('wx-card-updated');
        if (w && !w.error) {
            if (section) {
                const cat = wxCategory(w.icon);
                section.dataset.wx = cat;
                section.style.setProperty('--wx-bg-opacity', String(wxGradFactor(w.temp, cat, d)));
            }
            if (cardIcon) cardIcon.textContent = wxIcon(w.icon);
            if (cardTemp) cardTemp.textContent = fmt(w.temp, 0);
            if (cardText) cardText.textContent = w.text || '--';
            if (cardCity) cardCity.textContent = w.city || '--';
            if (cardUpdated) cardUpdated.textContent = formatWxUpdateTime(w.updateTime);
        } else {
            if (section) {
                section.dataset.wx = '';
                section.style.setProperty('--wx-bg-opacity', '0.5');
            }
            if (cardIcon) cardIcon.textContent = wxIcon('999');
            if (cardTemp) cardTemp.textContent = '--';
            if (cardText) cardText.textContent = '--';
            if (cardCity) cardCity.textContent = '--';
            if (cardUpdated) cardUpdated.textContent = '--';
        }

        // Details: feels-like / humidity / wind / AQI
        if (d && d.now) {
            setText('wx-card-feels', fmt(d.now.feelsLike, 0));
            setText('wx-card-humidity', fmt(d.now.humidity, 0));
            setText('wx-card-wind', (d.now.windDir || '') + (d.now.windScale ? ' ' + d.now.windScale : ''));
        }
        const aqiEl = document.getElementById('wx-card-aqi-val');
        const aqiRow = document.getElementById('wx-card-aqi-row');
        if (aqiRow && aqiEl) {
            if (!aq || aq.error || !aq.indexes || aq.indexes.length === 0) {
                aqiRow.style.display = 'none';
            } else {
                const idx = aq.indexes[0];
                aqiEl.textContent = (idx.aqiDisplay || '--') + ' ' + (idx.category || '');
                const cat = (idx.category || '').toLowerCase();
                aqiEl.style.color = cat.includes('优') ? 'var(--green)' :
                                    cat.includes('良') ? 'var(--yellow)' :
                                    cat.includes('轻度') ? 'var(--orange)' :
                                    cat.includes('中度') ? 'var(--orange)' :
                                    cat.includes('重度') ? 'var(--red)' :
                                    cat.includes('严重') ? 'var(--red)' : '';
                aqiRow.style.display = '';
            }
        }

        // Precipitation forecast (big card only; hidden on small via CSS)
        const precipRow = document.getElementById('wx-card-precip-row');
        const precipText = document.getElementById('wx-card-precip-text');
        const precipChart = document.getElementById('wx-card-precip-chart');
        let hasPrecip = false;
        if (precipRow && precipText && precipChart) {
            if (d && d.minutely && d.minutely.minutely && d.minutely.minutely.length > 0) {
                const items = d.minutely.minutely;
                hasPrecip = items.some(m => m.precip > 0);
                if (hasPrecip) {
                    precipText.textContent = d.minutely.summary || '--';
                    precipChart.innerHTML = '';
                    const N = items.length;
                    const cw = precipChart.clientWidth || 320;
                    const maxBars = Math.max(8, Math.min(96, Math.floor(cw / 5)));
                    const bucket = Math.max(1, Math.ceil(N / maxBars));
                    const vals = [];
                    for (let i = 0; i < N; i += bucket) {
                        let mx = 0;
                        for (let j = i; j < Math.min(i + bucket, N); j++) mx = Math.max(mx, items[j].precip);
                        vals.push(mx);
                    }
                    const maxV = Math.max(...vals, 1);
                    for (const v of vals) {
                        const bar = document.createElement('span');
                        bar.className = 'wx-precip-bar';
                        bar.style.height = (v > 0 ? Math.max(18, Math.round((v / maxV) * 100)) : 0) + '%';
                        precipChart.appendChild(bar);
                    }
                }
            }
            precipRow.style.display = hasPrecip ? '' : 'none';
            if (section) section.classList.toggle('has-precip', hasPrecip);

            // Big card: description keeps only the pure condition. Small card:
            // merge the precipitation summary into the condition line.
            if (cardText && w && !w.error && w.text) {
                if (section && section.dataset.span === '1' && hasPrecip && precipText.textContent) {
                    cardText.textContent = w.text + ' · ' + precipText.textContent;
                } else {
                    cardText.textContent = w.text;
                }
            }
        }

        // Alerts (big card only; hidden on small via CSS)
        const alertsRow = document.getElementById('wx-card-alerts-row');
        const alertsList = document.getElementById('wx-card-alerts-list');
        if (alertsRow && alertsList) {
            const hasAlerts = !!(alerts && alerts.length > 0);
            if (!hasAlerts) {
                alertsRow.style.display = 'none';
            } else {
                hideWxTip();
                alertsList.innerHTML = '';
                const maxShow = 30;
                for (const a of alerts.slice(0, maxShow)) {
                    const chip = document.createElement('div');
                    chip.className = 'wx-alert-chip';
                    chip.style.setProperty('--alert-color', a.colorCode ? `rgb(${a.colorR},${a.colorG},${a.colorB})` : 'var(--red)');
                    chip.innerHTML = '<span class="nf-icon">&#xF05D6;</span><span class="wx-alert-chip-name"></span>';
                    chip.querySelector('.wx-alert-chip-name').textContent = a.eventType || a.headline || 'Warning';
                    chip.addEventListener('mouseenter', () => showWxTip(chip, a));
                    chip.addEventListener('mouseleave', hideWxTip);
                    alertsList.appendChild(chip);
                }
                if (alerts.length > maxShow) {
                    const more = document.createElement('div');
                    more.className = 'wx-alert-more';
                    more.textContent = `还有 ${alerts.length - maxShow} 个预警...`;
                    alertsList.appendChild(more);
                }
                const updateAlertsFade = () => {
                    const canScroll = alertsList.scrollHeight > alertsList.clientHeight + 1;
                    const atBottom = alertsList.scrollHeight - alertsList.scrollTop - alertsList.clientHeight < 8;
                    alertsRow.classList.toggle('wx-alerts-fade', canScroll && !atBottom);
                };
                if (alertsList._wxMaskUpdate) alertsList.removeEventListener('scroll', alertsList._wxMaskUpdate);
                alertsList._wxMaskUpdate = updateAlertsFade;
                alertsList.addEventListener('scroll', alertsList._wxMaskUpdate);
                updateAlertsFade();
                alertsRow.style.display = '';
            }
            if (section) section.classList.toggle('has-alerts', hasAlerts);
        }

        if (section) {
            section.classList.toggle('wx-info', section.classList.contains('has-precip') || section.classList.contains('has-alerts'));
        }
    } catch (e) { console.warn('refreshWeatherCard:', e); }
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

let _featureToggles = {};

/** Whether a layout-controlled section may be shown, honoring BOTH the feature
 * toggle and the layout's per-card hidden flag. Sections removed in the layout
 * must stay hidden even when their feature toggle is later re-applied. */
function _sectionVisible(id) {
    if (_normLayout(id).hidden) return false;
    const key = { 'fps-section': 'fps', 'music-section': 'music', 'proc-section': 'top_process' }[id];
    return key ? _featureToggles[key] !== false : true;
}

function applyFeatureToggles(toggles) {
    _featureToggles = toggles || {};
    const ft = _featureToggles;
    // Hide sections for disabled features or deleted-in-layout cards
    const fpsSection = document.getElementById('fps-section');
    if (fpsSection) fpsSection.style.display = _sectionVisible('fps-section') ? '' : 'none';
    const musicSection = document.getElementById('music-section');
    if (musicSection) musicSection.style.display = _sectionVisible('music-section') ? '' : 'none';
    const calPopup = document.getElementById('clock-cal-popup');
    if (calPopup) calPopup.style.display = ft.calendar !== false ? '' : 'none';
    const procSection = document.getElementById('proc-section');
    if (procSection) procSection.style.display = _sectionVisible('proc-section') ? '' : 'none';
    document.querySelectorAll('.net-host-row').forEach(el => {
        el.style.display = ft.sysinfo !== false ? '' : 'none';
    });
    const clockBg = document.getElementById('clock-bg-image');
    if (clockBg) clockBg.style.display = ft.clock_bg !== false ? '' : 'none';
    const weatherEl = document.getElementById('h-weather-compact');
    if (weatherEl) weatherEl.style.display = (ft.weather !== false) ? '' : 'none';
    // Top brightness/volume controls
    _topControlEnabled = ft.top_control !== false;
    const topControlPopup = document.getElementById('top-control-popup');
    if (topControlPopup) topControlPopup.style.display = _topControlEnabled ? '' : 'none';
    if (!_topControlEnabled) {
        // ensure it isn't left visible when the feature is turned off
        if (topControlPopup) topControlPopup.classList.remove('visible');
        _topControlVisible = false;
        if (_topControlHideTimer) { clearTimeout(_topControlHideTimer); _topControlHideTimer = null; }
    }
}

/* ===== Layout Adjustment ===== */
const LAYOUT_IDS = ['cpu-section', 'gpu-section', 'mem-section', 'net-section', 'fps-section', 'disk-section', 'proc-section', 'music-section', 'weather-section', 'text-section'];
const RESIZABLE_IDS = ['cpu-section', 'gpu-section', 'mem-section', 'net-section', 'fps-section', 'music-section', 'weather-section', 'text-section'];
/* Everything draggable during layout mode — cards plus the full-height clock. */
const DRAG_IDS = LAYOUT_IDS.concat(['clock-section']);

const DEFAULT_LAYOUT = {
    'clock-section':  { side: 'left' },
    'cpu-section':    { col: 2, row: 2, span: 2, hidden: false },
    'gpu-section':    { col: 3, row: 2, span: 2, hidden: false },
    'mem-section':    { col: 2, row: 4, span: 1, hidden: false },
    'disk-section':   { col: 3, row: 1, span: 1, hidden: false },
    'net-section':    { col: 2, row: 1, span: 1, hidden: false },
    'fps-section':    { col: 3, row: 4, span: 1, hidden: false },
    'proc-section':   { col: 3, row: 5, span: 1, hidden: false },
    'music-section':  { col: 2, row: 5, span: 1, hidden: false },
    'weather-section': { col: 2, row: 1, span: 1, hidden: true },
    'text-section':   { col: 3, row: 1, span: 1, hidden: true },
};

let _layout = {};

function _normLayout(id) {
    const saved = _layout[id] || {};
    const def = DEFAULT_LAYOUT[id];
    return {
        col: saved.col || def.col,
        row: saved.row || def.row,
        span: saved.span != null ? saved.span : def.span,
        hidden: saved.hidden === true,
    };
}

function getLayoutSpan(id) {
    return _normLayout(id).span;
}

/* Which side the clock column sits on (cards use abstract cols 2/3; the clock
   is always full-height). 'right' flips the grid so the clock is at col 3. */
function _clockSide() {
    const c = _layout['clock-section'];
    return c && c.side === 'right' ? 'right' : 'left';
}

/* Abstract layout col (1=clock, 2=left cards, 3=right cards) → actual grid col. */
function _gridColFor(col) {
    if (_clockSide() === 'right') {
        if (col === 2) return 1;
        if (col === 3) return 2;
    }
    return col;
}

/* Actual grid col → abstract layout col. */
function _layoutColFor(col) {
    if (_clockSide() === 'right') {
        if (col === 1) return 2;
        if (col === 2) return 3;
    }
    return col;
}

function applyLayout(layout) {
    _layout = layout && typeof layout === 'object' ? layout : {};
    LAYOUT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const pos = _normLayout(id);
        el.style.gridColumn = String(_gridColFor(pos.col));
        el.style.gridRow = pos.row + ' / span ' + pos.span;
        el.style.display = _sectionVisible(id) ? '' : 'none';
        el.dataset.span = String(pos.span);
        if (id === 'fps-section') {
            const pct = el.querySelector('.pct');
            if (pct) pct.style.display = pos.span === 2 ? 'none' : '';
            _applyFpsFontSize();
        }
    });
    const grid = document.querySelector('.term-grid');
    if (grid) grid.classList.toggle('clock-right', _clockSide() === 'right');
    const clockEl = document.getElementById('clock-section');
    if (clockEl) clockEl.style.gridColumn = _clockSide() === 'right' ? '3' : '1';
    if (_layoutMode) _positionClockHint();
    applyLyricView();
}

function readLayout() {
    const layout = {};
    LAYOUT_IDS.forEach(id => {
        const el = document.getElementById(id);
        const pos = _normLayout(id);
        layout[id] = {
            col: el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col,
            row: el && el.style.gridRow ? parseInt(el.style.gridRow) || pos.row : pos.row,
            span: pos.span,
            hidden: pos.hidden,
        };
    });
    layout['clock-section'] = { side: _clockSide() };
    return layout;
}

function _colCards(col) {
    return LAYOUT_IDS
        .map(id => document.getElementById(id))
        .filter(el => el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col))
        .sort((a, b) => parseInt(a.style.gridRow) - parseInt(b.style.gridRow));
}

let _layoutMode = false;
let _layoutSaved = null;
let _layoutControlsAdded = false;

function enterLayoutMode() {
    if (_layoutMode) return;
    _layoutMode = true;
    _layoutSaved = readLayout();
    document.body.classList.add('layout-mode');
    _addLayoutControls();
    DRAG_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('draggable', 'true');
        el.addEventListener('dragstart', onLayoutDragStart);
        el.addEventListener('dragover', onLayoutDragOver);
        el.addEventListener('dragleave', onLayoutDragLeave);
        el.addEventListener('dragend', onLayoutDragEnd);
        el.addEventListener('drop', onLayoutDrop);
    });
    const grid = document.querySelector('.term-grid');
    if (grid) {
        grid.addEventListener('dragover', onGridDragOver);
        grid.addEventListener('dragleave', onGridDragLeave);
        grid.addEventListener('drop', onGridDrop);
    }
    _positionClockHint();
}

function exitLayoutMode() {
    if (!_layoutMode) return;
    _layoutMode = false;
    _hideClockHint();
    document.body.classList.remove('layout-mode');
    _removeLayoutControls();
    DRAG_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.removeAttribute('draggable');
        el.classList.remove('dragging', 'drag-over');
        el.removeEventListener('dragstart', onLayoutDragStart);
        el.removeEventListener('dragover', onLayoutDragOver);
        el.removeEventListener('dragleave', onLayoutDragLeave);
        el.removeEventListener('dragend', onLayoutDragEnd);
        el.removeEventListener('drop', onLayoutDrop);
    });
    const grid = document.querySelector('.term-grid');
    if (grid) {
        grid.removeEventListener('dragover', onGridDragOver);
        grid.removeEventListener('dragleave', onGridDragLeave);
        grid.removeEventListener('drop', onGridDrop);
    }
    const slot = document.getElementById('layout-drop-slot');
    if (slot) slot.remove();
}

function _addLayoutControls() {
    if (_layoutControlsAdded) return;
    _layoutControlsAdded = true;
    LAYOUT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const group = document.createElement('div');
        group.className = 'layout-control-group';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'layout-del-btn';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', function(e) { e.stopPropagation(); _deleteCard(id); });
        group.appendChild(delBtn);
        el.appendChild(group);
        if (RESIZABLE_IDS.includes(id)) {
            const handle = document.createElement('div');
            handle.className = 'layout-resize-handle';
            handle.setAttribute('data-card', id);
            handle.setAttribute('draggable', 'false');
            handle.addEventListener('pointerdown', function(e) { _resizeHandleDown(e, id); });
            el.appendChild(handle);
        }
        if (id === 'text-section' && !el.dataset.ceBound) {
            el.dataset.ceBound = '1';
            el.addEventListener('click', function(e) {
                if (!_layoutMode) return;
                if (e.target.closest('.layout-control-group') || e.target.closest('.layout-resize-handle')) return;
                openTextEditor(id);
            });
        }
    });
    _updateCardsBtn();
}

function _removeLayoutControls() {
    _layoutControlsAdded = false;
    document.querySelectorAll('.layout-control-group').forEach(el => el.remove());
    document.querySelectorAll('.layout-resize-handle').forEach(el => el.remove());
    document.body.classList.remove('resizing');
    const cardsBtn = document.getElementById('layout-cards');
    if (cardsBtn) cardsBtn.classList.add('hidden');
    const panel = document.getElementById('card-list-panel');
    if (panel) panel.style.display = 'none';
}

function _toggleCardSize(id) {
    const pos = _normLayout(id);
    const el = document.getElementById(id);
    const first = el ? el.getBoundingClientRect() : null;
    const curRow = el && el.style.gridRow ? (parseInt(el.style.gridRow) || pos.row) : pos.row;
    const curCol = el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col;
    if (pos.span === 1) {
        const colHeight = _columnHeight(curCol);
        const otherCol = curCol === 2 ? 3 : 2;
        const otherHeight = _columnHeight(otherCol);
        const selfHeight = 1;
        const newColHeight = colHeight - selfHeight + 2;
        if (newColHeight > 6 && otherHeight + 1 > 6) {
            showToast('空间不足');
            return;
        }
    }
    const snap = _snapshotLayout();
    pos.span = pos.span === 2 ? 1 : 2;
    _layout[id] = { col: curCol, row: curRow, span: pos.span, hidden: pos.hidden };
    if (el) {
        el.style.transition = 'none';
        el.style.gridRow = curRow + ' / span ' + pos.span;
        el.dataset.span = String(pos.span);
        if (id === 'fps-section') {
            const pct = el.querySelector('.pct');
            if (pct) pct.style.display = pos.span === 2 ? 'none' : '';
            _applyFpsFontSize();
        }
    }
    _repackColumn(curCol, id, curRow);
    if (!_rebalanceOverflow()) {
        _restoreLayout(snap);
        showToast('空间不足');
        return;
    }
    if (id === 'music-section') applyLyricView();
    if (el && first) _flipCard(el, first);
}

/* FLIP morph: smoothly animate a card between its previous and new size/position
   after the layout change, instead of snapping. Other cards still glide via the
   existing grid-row transition. */
function _flipCard(el, first) {
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const scaleX = first.width / last.width;
    const scaleY = first.height / last.height;
    el.style.transition = 'none';
    el.style.transformOrigin = 'top left';
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scaleX + ',' + scaleY + ')';
    void el.offsetWidth;
    el.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
    el.style.transform = '';
    const done = () => {
        el.style.transition = '';
        el.style.transform = '';
        el.style.transformOrigin = '';
    };
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 450);
}

function _deleteCard(id) {
    const pos = _normLayout(id);
    const el = document.getElementById(id);
    const col = el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col;
    pos.hidden = true;
    _layout[id] = { col: col, row: pos.row, span: pos.span, hidden: true };
    if (el) el.style.display = 'none';
    _repackColumn(col, null, null);
    _rebalanceOverflow();
    _updateCardsBtn();
}

/* ---- Resize handle drag (toggle card size) ---- */
let _resizingCard = null;
let _resizeDelta = 0;

function _resizeHandleDown(e, id) {
    e.preventDefault();
    e.stopPropagation();
    if (!_resizingCard) {
        _resizingCard = id;
        _resizeDelta = 0;
        document.body.classList.add('resizing');
        const el = document.getElementById(id);
        if (el) el.classList.add('resizing');
        window.addEventListener('pointermove', _resizeHandleMove);
        window.addEventListener('pointerup', _resizeHandleUp);
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
}

function _resizeHandleMove(e) {
    if (!_resizingCard) return;
    _resizeDelta += e.movementY || 0;
    const threshold = 25;
    const pos = _normLayout(_resizingCard);
    if (pos.span === 1 && _resizeDelta > threshold) {
        _toggleCardSize(_resizingCard);
        _resizeDelta = 0;
    } else if (pos.span === 2 && _resizeDelta < -threshold) {
        _toggleCardSize(_resizingCard);
        _resizeDelta = 0;
    }
}

function _resizeHandleUp() {
    const id = _resizingCard;
    if (!id) return;
    _resizingCard = null;
    _resizeDelta = 0;
    document.body.classList.remove('resizing');
    const el = document.getElementById(id);
    if (el) el.classList.remove('resizing');
    window.removeEventListener('pointermove', _resizeHandleMove);
    window.removeEventListener('pointerup', _resizeHandleUp);
}

/* Card metadata used by the card list: display name, accent color, and a
   small mock of the card's content so the user can preview its style. */
const CARD_META = {
    'cpu-section': {
        name: 'CPU', color: 'var(--cyan)',
        value: '88', pct: '%',
        lines: [['4200', 'MHz', '65', '°C'], ['120', 'W', '1.3', 'V']],
    },
    'gpu-section': {
        name: 'GPU', color: 'var(--accent)',
        value: '76', pct: '%',
        lines: [['68', '°C', '180', 'W'], ['11.2', '/12 GB', '64', '°C']],
    },
    'mem-section': {
        name: 'Memory', color: 'var(--magenta)',
        value: '54', pct: '%',
        lines: [['3600', 'MHz', '1.1', 'V'], ['8.6', '/16 GB', '45', '°C']],
    },
    'net-section': {
        name: 'Network', color: 'var(--green)', type: 'duo',
        duo: [['↓', '12.3', 'MB/s'], ['↑', '4.5', 'MB/s']],
    },
    'fps-section': {
        name: 'FPS', color: 'var(--yellow)',
        value: '144', pct: 'FPS',
        lines: [['6.9', 'ms', '1% 118', ''], ['AVG 141', '', '99% 137', '']],
    },
    'disk-section': {
        name: 'Disk', color: 'var(--blue)', type: 'duo',
        duo: [['R', '120', 'MB/s'], ['W', '45', 'MB/s']],
    },
    'proc-section': { name: 'Process', color: 'var(--text-dim)', type: 'proc' },
    'music-section': { name: 'Music', color: 'var(--accent)', type: 'music' },
    'weather-section': { name: 'Weather', color: 'var(--orange)', type: 'weather' },
    'text-section': { name: 'Text', color: 'var(--accent)', type: 'text' },
};

function _cardPreviewHTML(id) {
    const m = CARD_META[id];
    if (!m) return '';
    if (m.type === 'proc') {
        return '<div class="clp-proc">'
            + '<div class="clp-proc-bar"><i style="width:72%"></i></div>'
            + '<div class="clp-proc-bar"><i style="width:46%"></i></div>'
            + '<div class="clp-proc-bar"><i style="width:28%"></i></div>'
            + '</div>';
    }
    if (m.type === 'music') {
        return '<div class="clp-music"><span class="clp-cover"></span>'
            + '<div class="clp-music-meta"><div class="clp-title">Title</div>'
            + '<div class="clp-artist">Artist</div></div></div>';
    }
    if (m.type === 'weather') {
        return '<div class="clp-weather"><span class="clp-weather-icon">&#xF0590;</span>'
            + '<div class="clp-weather-main"><div class="clp-title">23&deg;C</div>'
            + '<div class="clp-artist">Sunny</div></div></div>';
    }
    if (m.type === 'duo') {
        return m.duo.map(r =>
            '<div class="clp-duo"><span class="clp-arrow">' + r[0] + '</span>'
            + '<span class="clp-value">' + r[1] + '</span>'
            + '<span class="clp-unit">' + r[2] + '</span></div>').join('');
    }
    if (m.type === 'text') {
        const cfg = _customTextCfg('text-section');
        const inner = escapeHtml(cfg.text || '');
        return '<div class="clp-text" style="text-align:' + (cfg.align || 'left') + '">'
            + (inner ? '<span class="clp-text-lines">' + inner + '</span>'
                : '<span class="clp-text-empty">Aa</span>')
            + '</div>';
    }
    return '<div class="clp-value-row"><span class="clp-value">' + m.value
        + '</span><span class="clp-pct">' + m.pct + '</span></div>'
        + m.lines.map(l =>
            '<div class="clp-info"><span class="mono">' + l[0] + '</span>'
            + (l[1] ? '<span class="clp-unit">' + l[1] + '</span>' : '')
            + (l[2] ? '<span class="clp-sep"> · </span><span class="mono">' + l[2] + '</span>' : '')
            + (l[3] ? '<span class="clp-unit">' + l[3] + '</span>' : '')
            + '</div>').join('');
}

function _renderCardList() {
    const body = document.getElementById('card-list-body');
    if (!body) return;
    body.textContent = '';
    const hidden = LAYOUT_IDS.filter(id => _normLayout(id).hidden);
    hidden.forEach(id => {
        const meta = CARD_META[id] || { name: id, color: 'var(--text)' };
        const item = document.createElement('div');
        item.className = 'card-list-item';
        item.dataset.card = id;
        item.setAttribute('draggable', 'true');
        const sizes = _cardSizesHTML(id);
        item.innerHTML = '<div class="card-list-preview" style="--card-accent:' + meta.color + '">'
            + _cardPreviewHTML(id) + '</div>'
            + '<div class="card-list-name">' + meta.name + sizes + '</div>';
        item.addEventListener('click', () => _addCard(id));
        item.addEventListener('dragstart', onLayoutDragStart);
        item.addEventListener('dragend', onLayoutDragEnd);
        body.appendChild(item);
    });
    if (!hidden.length) {
        const panel = document.getElementById('card-list-panel');
        if (panel) panel.style.display = 'none';
    }
}

/* Cards that support both sizes (RESIZABLE_IDS) list their options next to the
   name, e.g. "CPU 1x1 · 1x2".  Non-resizable cards have a single fixed size. */
function _cardSizesHTML(id) {
    if (!RESIZABLE_IDS.includes(id)) return '';
    const sizes = [1, 2].map(s => '1x' + s);
    return '<span class="card-list-sizes">' + sizes.join(' · ') + '</span>';
}

function _updateCardsBtn() {
    const cardsBtn = document.getElementById('layout-cards');
    if (!cardsBtn) return;
    const hasHidden = LAYOUT_IDS.some(id => _normLayout(id).hidden);
    cardsBtn.classList.toggle('hidden', !hasHidden);
    const panel = document.getElementById('card-list-panel');
    if (panel && panel.style.display === 'flex') _renderCardList();
}

/* Place a previously-hidden card into the grid at the given column/row, then
   compact the column and rebalance overflow.  If `span` is omitted, the card's
   layout span is used. */
function _placeCard(id, col, row, span) {
    const pos = _normLayout(id);
    const s = span || pos.span;
    pos.col = col;
    pos.row = row;
    pos.span = s;
    pos.hidden = false;
    _layout[id] = { col: col, row: row, span: s, hidden: false };
    const el = document.getElementById(id);
    if (el) {
        el.style.display = _sectionVisible(id) ? '' : 'none';
        el.style.gridColumn = String(_gridColFor(col));
        el.style.gridRow = row + ' / span ' + s;
        el.dataset.span = String(s);
        if (id === 'fps-section') {
            const pct = el.querySelector('.pct');
            if (pct) pct.style.display = pos.span === 2 ? 'none' : '';
            _applyFpsFontSize();
        }
        if (id === 'weather-section') refreshWeatherCard();
        if (id === 'text-section') applyCustomText(id);
    }
    _repackColumn(col, id, row);
    _rebalanceOverflow();
    _updateCardsBtn();
}

/* Click a card in the list: add it to whichever column still has room.
   If the card supports both sizes (RESIZABLE_IDS) and the remaining space only
   fits the small card, fall back to the small (span 1) form automatically. */
function _addCard(id) {
    const span = _normLayout(id).span;
    const h2 = _columnHeight(2);
    const h3 = _columnHeight(3);
    const free2 = 6 - h2;
    const free3 = 6 - h3;
    let col = null;
    if (free2 >= span) col = 2;
    if (free3 >= span && (col === null || free3 > free2)) col = 3;
    if (col === null && RESIZABLE_IDS.includes(id) && span > 1) {
        const small = 1;
        if (free2 >= small) col = 2;
        if (free3 >= small && (col === null || free3 > free2)) col = 3;
        if (col !== null) { _placeCard(id, col, _columnHeight(col) + 1, small); return; }
    }
    if (col === null) { showToast('空间不足'); return; }
    _placeCard(id, col, _columnHeight(col) + 1);
}

/* ===== Custom text card ===== */
const TEXT_CARD_IDS = ['text-section'];

function _customTextCfg(id) {
    const defaults = { text: '', font: '', bold: false, italic: false, size: 18, align: 'left' };
    const stored = ((window._appSettings || {}).custom_text || {})[id] || {};
    return Object.assign({}, defaults, stored);
}

function applyCustomText(id, cfgOverride) {
    const el = document.getElementById('custom-text-el');
    if (!el) return;
    const cfg = cfgOverride || _customTextCfg(id);
    const empty = !cfg.text;
    el.textContent = empty ? t('text-edit-hint') : cfg.text;
    el.classList.toggle('empty', empty);
    el.style.fontFamily = cfg.font ? '"' + cfg.font + '"' : '';
    el.style.fontWeight = cfg.bold ? '700' : '400';
    el.style.fontStyle = cfg.italic ? 'italic' : 'normal';
    el.style.fontSize = (cfg.size || 18) + 'px';
    el.style.textAlign = cfg.align || 'left';
}

/* ---- Editor panel ---- */
let _ceEditId = 'text-section';
let _ceAlign = 'left';

function openTextEditor(id) {
    _ceEditId = id;
    const cfg = _customTextCfg(id);
    _ceAlign = cfg.align || 'left';
    const panel = document.getElementById('card-edit-panel');
    if (!panel) return;
    const textEl = document.getElementById('ce-text');
    const fontEl = document.getElementById('ce-font');
    const boldEl = document.getElementById('ce-bold');
    const italicEl = document.getElementById('ce-italic');
    const sizeEl = document.getElementById('ce-size');
    if (textEl) textEl.value = cfg.text;
    if (fontEl) fontEl.value = cfg.font;
    if (boldEl) boldEl.checked = !!cfg.bold;
    if (italicEl) italicEl.checked = !!cfg.italic;
    if (sizeEl) sizeEl.value = cfg.size;
    const btns = document.querySelectorAll('#ce-align button');
    btns.forEach(b => b.classList.toggle('active', b.dataset.align === _ceAlign));
    panel.style.display = 'flex';
    if (textEl) textEl.focus();
}

function closeTextEditor() {
    const panel = document.getElementById('card-edit-panel');
    if (panel) panel.style.display = 'none';
}

function readTextEditorForm() {
    const textEl = document.getElementById('ce-text');
    const fontEl = document.getElementById('ce-font');
    const boldEl = document.getElementById('ce-bold');
    const italicEl = document.getElementById('ce-italic');
    const sizeEl = document.getElementById('ce-size');
    return {
        text: textEl ? textEl.value : '',
        font: fontEl ? fontEl.value.trim() : '',
        bold: boldEl ? boldEl.checked : false,
        italic: italicEl ? italicEl.checked : false,
        size: parseInt(sizeEl ? sizeEl.value : '18', 10) || 18,
        align: _ceAlign,
    };
}

function previewTextCard() {
    applyCustomText(_ceEditId, readTextEditorForm());
}

async function saveTextCard() {
    const cfg = readTextEditorForm();
    window._appSettings = window._appSettings || {};
    window._appSettings.custom_text = window._appSettings.custom_text || {};
    window._appSettings.custom_text[_ceEditId] = cfg;
    applyCustomText(_ceEditId, cfg);
    closeTextEditor();
    try { await pywebview.api.save_settings(window._appSettings); } catch (e) { console.warn('save custom text:', e); }
}

function initTextCardEditor() {
    const closeBtn = document.getElementById('card-edit-close');
    if (closeBtn) closeBtn.addEventListener('click', closeTextEditor);
    const saveBtn = document.getElementById('card-edit-save');
    if (saveBtn) saveBtn.addEventListener('click', saveTextCard);
    const cancelBtn = document.getElementById('card-edit-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeTextEditor);
    const alignBox = document.getElementById('ce-align');
    if (alignBox) alignBox.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-align]');
        if (!b) return;
        _ceAlign = b.dataset.align;
        alignBox.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        previewTextCard();
    });
    ['ce-text', 'ce-font', 'ce-bold', 'ce-italic', 'ce-size'].forEach(function(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', previewTextCard);
        el.addEventListener('change', previewTextCard);
    });
    const panel = document.getElementById('card-edit-panel');
    if (panel) panel.addEventListener('click', (e) => { e.stopPropagation(); });
}

let _toastEl = null;

function showToast(msg, duration) {
    const ms = duration || 5000;
    if (!_toastEl) {
        _toastEl = document.createElement('div');
        _toastEl.className = 'first-launch-hint';
        _toastEl.style.display = 'none';
        document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.style.display = 'flex';
    requestAnimationFrame(function() {
        _toastEl.classList.remove('hint-hide');
        _toastEl.classList.add('hint-show');
    });
    clearTimeout(_toastEl._hideTimer);
    _toastEl._hideTimer = setTimeout(function() {
        _toastEl.classList.remove('hint-show');
        _toastEl.classList.add('hint-hide');
        setTimeout(function() { _toastEl.style.display = 'none'; }, 250);
    }, ms);
}

let _dragId = null;
let _dragFromList = false;

function onLayoutDragStart(e) {
    _dragId = e.currentTarget.dataset.card || e.currentTarget.id;
    _dragFromList = !!e.currentTarget.dataset.card;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _dragId);
}

function onLayoutDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (e.currentTarget.id !== _dragId) e.currentTarget.classList.add('drag-over');
}

function onLayoutDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

function onLayoutDragEnd(e) {
    e.currentTarget.classList.remove('dragging', 'drag-over');
    DRAG_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('drag-over');
    });
    _dragId = null;
    _dragFromList = false;
}

function onLayoutDrop(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('drag-over');
    const fromId = _dragId;
    const toId = target.id;
    if (!fromId || fromId === toId) return;
    if (fromId === 'clock-section' || toId === 'clock-section') { _handleClockDrop(e); return; }
    if (_dragFromList) {
        // Adding a removed card from the card list: insert at the drop slot.
        const toCol = _layoutColFor(parseInt(target.style.gridColumn));
        const toRow = parseInt(target.style.gridRow);
        let span = getLayoutSpan(fromId);
        const colHeight = _columnHeight(toCol);
        const otherHeight = _columnHeight(toCol === 2 ? 3 : 2);
        if (colHeight + span > 6 && otherHeight + span > 6) {
            if (RESIZABLE_IDS.includes(fromId) && span > 1) {
                const small = 1;
                if (colHeight + small > 6 && otherHeight + small > 6) {
                    showToast('空间不足');
                    return;
                }
                span = small;
            } else {
                showToast('空间不足');
                return;
            }
        }
        const snap = _snapshotLayout();
        _placeCard(fromId, toCol, toRow, span);
        if (_columnHeight(2) > 6 || _columnHeight(3) > 6) {
            _restoreLayout(snap);
            showToast('空间不足');
        }
        return;
    }
    const fromEl = document.getElementById(fromId);
    const toEl = target;
    const fromCol = fromEl.style.gridColumn;
    const fromRow = parseInt(fromEl.style.gridRow);
    const toRow = parseInt(toEl.style.gridRow);
    const toCol = toEl.style.gridColumn;
    const fromOrigRow = fromEl.style.gridRow;
    const toOrigRow = toEl.style.gridRow;
    fromEl.style.gridColumn = toCol;
    fromEl.style.gridRow = toRow + ' / span ' + getLayoutSpan(fromId);
    toEl.style.gridColumn = fromCol;
    toEl.style.gridRow = fromRow + ' / span ' + getLayoutSpan(toId);
    _repackColumn(_layoutColFor(parseInt(fromEl.style.gridColumn)), fromId, toRow);
    _repackColumn(_layoutColFor(parseInt(toEl.style.gridColumn)), null, null);
    // If the swap would overflow either column, revert it instead of shuffling
    // cards across columns (which displaces the other column's cards).
    if (_columnHeight(2) > 6 || _columnHeight(3) > 6) {
        fromEl.style.gridColumn = fromCol;
        fromEl.style.gridRow = fromOrigRow;
        toEl.style.gridColumn = toCol;
        toEl.style.gridRow = toOrigRow;
        _repackColumn(_layoutColFor(parseInt(fromCol)), null, null);
        _repackColumn(_layoutColFor(parseInt(toCol)), null, null);
        showToast('空间不足');
    }
}

/* ---- Dropping onto empty grid space (not over another card) ---- */

let _dropSlotEl = null;

/* Resolve a pointer position to a {col,row} slot inside the two card columns,
   so cards can be dropped anywhere in the grid, not just onto another card. */
function _gridSlotFromEvent(e) {
    const grid = document.querySelector('.term-grid');
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const pad = 8, gap = 8, clockW = 150;
    const innerW = rect.width - pad * 2;
    const innerH = rect.height - pad * 2;
    const colW = (innerW - clockW - gap * 2) / 2;
    if (colW <= 0) return null;
    // The two card columns sit on the opposite side of the clock. When the
    // clock is on the right, the card area starts at the grid's left edge.
    const right = _clockSide() === 'right';
    const cardLeft = right ? rect.left + pad : rect.left + pad + clockW + gap;
    const cardRight = right ? rect.right - pad - clockW - gap : rect.right - pad;
    const c2Left = cardLeft;
    const c2Right = c2Left + colW;
    let col = null;
    if (e.clientX >= c2Left && e.clientX < c2Right) col = 2;
    else if (e.clientX >= c2Right + gap && e.clientX <= cardRight) col = 3;
    if (!col) return null;
    // 5 equal rows with 4 gaps inside the padded area.
    const rowH = (innerH - gap * 4) / 5;
    const relY = e.clientY - (rect.top + pad);
    let row = Math.floor(relY / (rowH + gap)) + 1;
    if (row < 1) row = 1;
    if (row > 5) row = 5;
    return { col: col, row: row, rect: rect, c2Left: c2Left, colW: colW, rowH: rowH, pad: pad, gap: gap };
}

function _ensureDropSlot() {
    if (!_dropSlotEl || !_dropSlotEl.isConnected) {
        _dropSlotEl = document.createElement('div');
        _dropSlotEl.className = 'drop-slot hide';
        _dropSlotEl.id = 'layout-drop-slot';
        const grid = document.querySelector('.term-grid');
        if (grid) grid.appendChild(_dropSlotEl);
    }
    return _dropSlotEl;
}

function _showDropSlot(slot, span) {
    const el = _ensureDropSlot();
    if (!slot) { el.classList.add('hide'); return; }
    const top = slot.pad + (slot.row - 1) * (slot.rowH + slot.gap);
    const left = _clockSide() === 'right'
        ? (slot.col === 2 ? slot.pad : slot.pad + slot.colW + slot.gap)
        : (slot.col === 2 ? slot.pad + 150 + slot.gap : slot.pad + 150 + slot.gap + slot.colW + slot.gap);
    const height = slot.rowH * span + slot.gap * (span - 1);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = slot.colW + 'px';
    el.style.height = height + 'px';
    el.classList.remove('hide');
}

function _hideDropSlot() {
    if (_dropSlotEl) _dropSlotEl.classList.add('hide');
}

let _clockHintEl = null;

function _ensureClockHint() {
    if (!_clockHintEl || !_clockHintEl.isConnected) {
        _clockHintEl = document.createElement('div');
        _clockHintEl.className = 'clock-drag-hint';
        _clockHintEl.id = 'clock-drag-hint';
        const grid = document.querySelector('.term-grid');
        if (grid) grid.appendChild(_clockHintEl);
    }
    return _clockHintEl;
}

/* Layout-mode bubble above the clock's date line: "拖曳时钟可调整位置".
   Kept inside the window (grid starts at the window top, so a bubble floating
   above the whole clock would overflow). Anchors to the date and clamps. */
function _positionClockHint() {
    const el = _ensureClockHint();
    const grid = document.querySelector('.term-grid');
    const clockEl = document.getElementById('clock-section');
    const dateEl = document.getElementById('h-clock-date');
    if (!grid || !clockEl || !dateEl) return;
    el.textContent = t('layout-hint-clock');
    el.classList.add('show');
    const gRect = grid.getBoundingClientRect();
    const cRect = clockEl.getBoundingClientRect();
    const dRect = dateEl.getBoundingClientRect();
    const left = Math.max(gRect.width / 2, Math.min(gRect.width - el.offsetWidth / 2, cRect.left - gRect.left + cRect.width / 2));
    const desiredBottom = dRect.top - gRect.top - 5;
    const visualTop = Math.max(4, desiredBottom - el.offsetHeight);
    el.style.left = left + 'px';
    el.style.top = (visualTop + el.offsetHeight) + 'px';
}

function _hideClockHint() {
    if (_clockHintEl) _clockHintEl.classList.remove('show');
}

function onGridDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!_dragId) return;
    if (_dragId === 'clock-section') { _hideDropSlot(); return; }
    const slot = _gridSlotFromEvent(e);
    _showDropSlot(slot, getLayoutSpan(_dragId));
}

function onGridDragLeave(e) {
    // dragleave also fires when entering/leaving child cards; only hide when the
    // pointer actually leaves the grid element entirely.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
    _hideDropSlot();
}

function onGridDrop(e) {
    e.preventDefault();
    _hideDropSlot();
    const fromId = _dragId;
    if (!fromId) return;
    if (fromId === 'clock-section') { _handleClockDrop(e); return; }
    const slot = _gridSlotFromEvent(e);
    if (!slot) return;
    const fromEl = document.getElementById(fromId);
    // Only a card actually visible on the grid occupies space in a column; cards
    // dragged from the list are hidden and must be counted as a fresh addition.
    const fromCol = fromEl && fromEl.style.display !== 'none' && fromEl.style.gridColumn ? _layoutColFor(parseInt(fromEl.style.gridColumn)) : null;
    // Try to place at the slot with the card's preferred span; fall back to a
    // smaller span for resizable cards when the space won't fit, else abort.
    let span = getLayoutSpan(fromId);
    // Column height the target column will reach after the move: moving a card
    // within the same column never grows it (removing it frees its span first),
    // and the source column can only shrink, so only the target column matters.
    const targetH = (fromCol === slot.col ? _columnHeight(slot.col) - span : _columnHeight(slot.col));
    if (targetH + span > 6) {
        if (RESIZABLE_IDS.includes(fromId) && span > 1) {
            if (targetH + 1 > 6) { showToast('空间不足'); return; }
            span = 1;
        } else {
            showToast('空间不足');
            return;
        }
    }
    // Insert the card at the slot; shift lower cards down to make room.
    const snap = _snapshotLayout();
    _placeCard(fromId, slot.col, slot.row, span);
    if (fromCol && fromCol !== slot.col) _repackColumn(fromCol, null, null);
    if (_columnHeight(2) > 6 || _columnHeight(3) > 6) {
        _restoreLayout(snap);
        showToast('空间不足');
    }
}

/* Dropping the clock (either on the empty grid or onto another card): move the
   whole clock column to whichever half of the grid the pointer is over. */
function _handleClockDrop(e) {
    const grid = document.querySelector('.term-grid');
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
    _layout['clock-section'] = { side: side };
    applyLayout(_layout);
}

function _repackColumn(col, fixedId, fixedRow) {
    const els = _colCards(col);
    if (fixedId) {
        const fixedEl = document.getElementById(fixedId);
        if (fixedEl && fixedEl.style.display !== 'none' && parseInt(fixedEl.style.gridColumn) === _gridColFor(col)) {
            fixedEl.style.gridRow = fixedRow + ' / span ' + getLayoutSpan(fixedId);
        }
    }
    const fixedSpan = fixedId ? getLayoutSpan(fixedId) : 0;
    const fixedEnd = fixedId ? fixedRow + fixedSpan : -1;
    let nextRow = 1;
    els.forEach(function(el) {
        if (el.id === fixedId) return;
        if (fixedId && nextRow >= fixedRow && nextRow < fixedEnd) {
            nextRow = fixedEnd;
        }
        el.style.gridRow = nextRow + ' / span ' + getLayoutSpan(el.id);
        nextRow = parseInt(el.style.gridRow) + getLayoutSpan(el.id);
    });
}

function _packColumn(col) {
    const els = _colCards(col);
    let nextRow = 1;
    els.forEach(function(el) {
        el.style.gridRow = nextRow + ' / span ' + getLayoutSpan(el.id);
        nextRow = parseInt(el.style.gridRow) + getLayoutSpan(el.id);
    });
}

function _columnHeight(col) {
    let maxEnd = 0;
    LAYOUT_IDS.forEach(function(id) {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col)) {
            const end = parseInt(el.style.gridRow) + getLayoutSpan(id);
            if (end > maxEnd) maxEnd = end;
        }
    });
    return maxEnd;
}

/* The bottom-most (largest row) visible card in a column, if any. */
function _bottomCardId(col) {
    let bottomId = null;
    let bottomRow = -1;
    LAYOUT_IDS.forEach(function(id) {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col)) {
            const row = parseInt(el.style.gridRow);
            if (row > bottomRow) {
                bottomRow = row;
                bottomId = id;
            }
        }
    });
    return bottomId;
}

/* Snapshot every card's grid placement so an operation can be reverted
   cleanly (restored exactly) if it would overflow the grid. */
function _snapshotLayout() {
    const snap = [];
    LAYOUT_IDS.forEach(function(id) {
        const el = document.getElementById(id);
        if (!el) return;
        snap.push({
            id: id,
            col: el.style.gridColumn || '',
            row: el.style.gridRow || '',
            display: el.style.display || '',
            span: el.dataset.span || '',
            layout: Object.assign({}, _layout[id] || {}),
        });
    });
    const clockEl = document.getElementById('clock-section');
    snap.push({
        id: 'clock-section',
        col: clockEl ? clockEl.style.gridColumn || '' : '',
        row: '',
        display: '',
        span: '',
        layout: Object.assign({}, _layout['clock-section'] || {}),
    });
    return snap;
}

function _restoreLayout(snap) {
    snap.forEach(function(s) {
        const el = document.getElementById(s.id);
        if (!el) return;
        if (s.id === 'clock-section') {
            el.style.gridColumn = s.col;
            if (s.layout && Object.keys(s.layout).length) _layout[s.id] = s.layout;
            else delete _layout[s.id];
            const grid = document.querySelector('.term-grid');
            if (grid) grid.classList.toggle('clock-right', _clockSide() === 'right');
            return;
        }
        el.style.gridColumn = s.col;
        el.style.gridRow = s.row;
        el.style.display = s.display;
        el.dataset.span = s.span;
        if (s.layout && Object.keys(s.layout).length) _layout[s.id] = s.layout;
        else delete _layout[s.id];
    });
}

/* Move a card to another column, landing it at the BOTTOM of that column
   (i.e. after its current cards) rather than the top, so the existing order
   is preserved and nothing unexpected jumps to the top. */
function _moveCardToBottom(fromCol, toCol) {
    const bottomId = _bottomCardId(fromCol);
    if (!bottomId) return false;
    const el = document.getElementById(bottomId);
    const span = getLayoutSpan(bottomId);
    const toHeight = _columnHeight(toCol);
    // Only move if the target column can actually fit it; otherwise leave it
    // in place so the caller can decide (usually: revert + "空间不足").
    if (toHeight + span > 6) return false;
    el.style.gridColumn = String(_gridColFor(toCol));
    el.style.gridRow = '99 / span ' + span;  // sentinel; _packColumn sorts last → bottom
    _packColumn(toCol);
    return true;
}

function _rebalanceOverflow() {
    let guard = 0;
    while (guard++ < 10) {
        const h2 = _columnHeight(2);
        const h3 = _columnHeight(3);
        if (h2 <= 6 && h3 <= 6) return true;
        // Move the overflowing column's bottom card to the other column's
        // bottom — but only when it can fit there.
        if (h2 > 6) {
            if (!_moveCardToBottom(2, 3)) return false;
        } else if (h3 > 6) {
            if (!_moveCardToBottom(3, 2)) return false;
        }
    }
    return _columnHeight(2) <= 6 && _columnHeight(3) <= 6;
}

function resetLayout() {
    _layout = {};
    applyLayout(DEFAULT_LAYOUT);
}

function initLayoutControls() {
    const modeBtn = document.getElementById('btn-layout-mode');
    const resetBtn = document.getElementById('btn-layout-reset');
    const saveBtn = document.getElementById('layout-save');
    const cancelBtn = document.getElementById('layout-cancel');
    const cardsBtn = document.getElementById('layout-cards');
    const cardsClose = document.getElementById('card-list-close');
    const cardPanel = document.getElementById('card-list-panel');
    if (modeBtn) modeBtn.addEventListener('click', () => {
        const overlay = document.getElementById('settings-overlay');
        if (overlay) overlay.style.display = 'none';
        enterLayoutMode();
    });
    if (cardsBtn) cardsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!cardPanel) return;
        if (cardPanel.style.display === 'flex') {
            cardPanel.style.display = 'none';
        } else {
            _renderCardList();
            cardPanel.style.display = 'flex';
        }
    });
    if (cardsClose) cardsClose.addEventListener('click', () => {
        if (cardPanel) cardPanel.style.display = 'none';
    });
    document.addEventListener('click', (e) => {
        if (!cardPanel || cardPanel.style.display !== 'flex') return;
        if (!cardPanel.contains(e.target) && e.target !== cardsBtn) {
            cardPanel.style.display = 'none';
        }
    });
    if (resetBtn) resetBtn.addEventListener('click', async () => {
        resetLayout();
        try {
            const s = await pywebview.api.get_settings();
            s.layout = DEFAULT_LAYOUT;
            await pywebview.api.save_settings(s);
            window._appSettings = { ...(window._appSettings || {}), layout: DEFAULT_LAYOUT };
        } catch (e) { console.warn('reset layout:', e); }
    });
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const layout = readLayout();
        try {
            const s = await pywebview.api.get_settings();
            s.layout = layout;
            await pywebview.api.save_settings(s);
            window._appSettings = { ...(window._appSettings || {}), layout: layout };
        } catch (e) { console.warn('save layout:', e); }
        exitLayoutMode();
    });
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
        if (cardPanel) cardPanel.style.display = 'none';
        if (_layoutChanged()) {
            showAppConfirm(t('confirm-layout-unsaved'), () => {
                applyLayout(_layoutSaved);
                exitLayoutMode();
            });
            return;
        }
        applyLayout(_layoutSaved);
        exitLayoutMode();
    });
}

/* Whether the current on-grid layout differs from what was saved when layout
   mode was entered (used to warn before discarding unsaved changes). */
function _layoutChanged() {
    if (!_layoutSaved) return false;
    const cur = readLayout();
    if (LAYOUT_IDS.some(id => {
        const a = cur[id], b = _layoutSaved[id];
        return !a || !b
            || a.col !== b.col || a.row !== b.row
            || a.span !== b.span || a.hidden !== b.hidden;
    })) return true;
    const a = cur['clock-section'], b = _layoutSaved['clock-section'];
    return !a || !b || a.side !== b.side;
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
    const hoverHighlightChk = document.getElementById('opt-hover-highlight');
    const hoverAnimChk = document.getElementById('opt-hover-anim');
    const lyricAnimChk = document.getElementById('opt-lyric-anim');
    const updateNotifyChk = document.getElementById('opt-update-notify');

    // Server mode
    const serverModeChk = document.getElementById('opt-server-mode');
    const serverHostInput = document.getElementById('opt-server-host');
    const serverPortInput = document.getElementById('opt-server-port');
    const serverAuthChk = document.getElementById('opt-server-auth');
    const serverUserInput = document.getElementById('opt-server-user');
    const serverPassInput = document.getElementById('opt-server-pass');
    const debugLogsChk = document.getElementById('opt-debug-logs');
    const debugChk = document.getElementById('opt-debug');
    const autoLaunchChk = document.getElementById('opt-auto-launch');

    // Data
    const intervalSel = document.getElementById('opt-interval');
    const datasourceSel = document.getElementById('opt-datasource');
    const gpuSel = document.getElementById('opt-gpu');
    const metingUrlInput = document.getElementById('opt-meting-url');
    const lyricsWhitelistInput = document.getElementById('opt-lyrics-whitelist');
    const lyricsTranslateChk = document.getElementById('opt-lyrics-translate');

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
            refreshWeatherCard();
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
        const rows = [
            { key: 'about-program', value: info.program || '--' },
            { key: 'about-author', value: info.author || '--' },
            { key: 'about-project', value: info.homepage || '--', link: info.homepage || '' },
            { key: 'about-python', value: info.python || '--' },
            { key: 'about-pywebview', value: info.pywebview || '--' },
            { key: 'about-browser', value: browser },
            { key: 'about-backend', value: (backend.name || '--') + (backend.version ? ' ' + backend.version : '') },
        ];
        list.innerHTML = rows.map(r => {
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
        hoverHighlightChk.checked = s.hover_highlight !== false;
        applyHoverHighlight(s.hover_highlight !== false);
        hoverAnimChk.checked = s.hover_animation !== false;
        applyHoverAnim(s.hover_animation !== false);
        lyricAnimChk.checked = s.lyric_animation === true;
        applyLyricAnim(s.lyric_animation === true);
        autostartChk.checked = await pywebview.api.get_autostart();
        updateNotifyChk.checked = s.update_check_enabled !== false;

        // Data
        intervalSel.value = String(s.refresh_interval || 1000);
        datasourceSel.value = s.data_source || 'lhm';
        metingUrlInput.value = s.meting_api_base || '';
        lyricsWhitelistInput.value = s.lyrics_process_whitelist || '';
        lyricsTranslateChk.checked = s.lyrics_auto_translate === true;
        applyLyricAutoTranslate(s.lyrics_auto_translate === true);

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
        debugLogsChk.checked = s.debug_logs === true;
        if (debugChk) debugChk.checked = s.debug === true;

        // Behavior
        if (autoLaunchChk) autoLaunchChk.checked = s.auto_launch_music_player !== false;

        // Feature toggles
        const ft = s.feature_toggles || {};
        ['top_control','calendar','weather','top_process','sysinfo','traffic','background'].forEach(key => {
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
            hover_highlight: hoverHighlightChk.checked,
            hover_animation: hoverAnimChk.checked,
            lyric_animation: lyricAnimChk.checked,
            update_check_enabled: updateNotifyChk.checked,
            refresh_interval: parseInt(intervalSel.value),
            data_source: datasourceSel.value,
            gpu_index: parseInt(gpuSel.value) || 0,
            meting_api_base: metingUrlInput.value.trim(),
            lyrics_process_whitelist: lyricsWhitelistInput.value.trim(),
            lyrics_auto_translate: lyricsTranslateChk.checked,
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
            debug_logs: debugLogsChk.checked,
            debug: debugChk ? debugChk.checked : false,
            auto_launch_music_player: autoLaunchChk ? autoLaunchChk.checked : true,
            custom_text: (window._appSettings && window._appSettings.custom_text) || {},
        };

        // Feature toggles
        s.feature_toggles = {};
        ['top_control','calendar','weather','top_process','sysinfo','traffic','background'].forEach(key => {
            const cb = document.getElementById('ft-' + key);
            s.feature_toggles[key] = cb ? cb.checked : true;
        });

        await pywebview.api.save_settings(s);
        await pywebview.api.set_autostart(autostartChk.checked);
        await pywebview.api.change_backend(s.data_source);

        // Update global settings cache
        window._appSettings = { ...window._appSettings, ...s };

        applyHoverAnim(s.hover_animation !== false);
        applyHoverHighlight(s.hover_highlight !== false);

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
        applyHoverHighlight(s.hover_highlight !== false);
        applyHoverAnim(s.hover_animation !== false);
        applyLyricAutoTranslate(s.lyrics_auto_translate === true);
        applyFonts(s.font_ui, s.font_data, s.font_clock);
        await applyClockBackgroundSetting(s.clock_bg_image, s.clock_bg_opacity, s.clock_bg_blur, s.clock_bg_gradient !== false, s.clock_bg_fit || 'fit', s.clock_bg_offset_x ?? 50, s.clock_bg_offset_y ?? 50);
        applyHwNames(true);
        applyFeatureToggles(s.feature_toggles || {});

        // Restart sidebar weather intervals to match the Show Weather toggle
        const wxSidebarOn = (s.feature_toggles || {}).weather !== false;
        _startInterval(wxSidebarOn, refreshWeather, 600000);
        _startInterval(wxSidebarOn, refreshWeatherDetail, 600000);
        _startInterval(wxSidebarOn, refreshAirQuality, 1800000);
        _startInterval(wxSidebarOn, refreshAlerts, 600000);

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
            refreshAirQuality();
            refreshAlerts();
            refreshWeatherCard();
        }

        // If server mode is on, tell the user it runs headless and how to disable it
        if (s.server_mode) {
            try {
                const info = await pywebview.api.get_server_info();
                showServerInfoModal(info);
            } catch (e) { console.warn('get_server_info:', e); }
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
let _topControlEnabled = true; // 顶部亮度/音量条是否开启（由功能开关控制）
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
        if (e.clientY <= TOP_HOVER_THRESHOLD && !_topControlVisible && _topControlEnabled) {
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
    const loader = document.getElementById('boot-loading');
    if (loader) {
        loader.classList.add('hide');
        setTimeout(() => { loader.style.display = 'none'; }, 350);
    }
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
    console.log('Boot settings:', JSON.stringify({ lang: s.language, scheme: s.colorscheme }));

    applyLang(s.language || 'en');
    applyColorscheme(s.colorscheme || 'gruvbox');
    applyFonts(s.font_ui, s.font_data, s.font_clock);
    await applyClockBackgroundSetting(s.clock_bg_image, s.clock_bg_opacity, s.clock_bg_blur, s.clock_bg_gradient !== false, s.clock_bg_fit || 'fit', s.clock_bg_offset_x ?? 50, s.clock_bg_offset_y ?? 50);
    applyFontSize(s.font_size || 100);
    applyLyricAutoTranslate(s.lyrics_auto_translate === true);

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
    initLayoutControls();
    initTextCardEditor();
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
    // Apply saved layout
    applyLayout(s.layout);
    applyCustomText('text-section');
    const ft = s.feature_toggles || {};

    // Start intervals only for enabled features
    const weatherOn = ft.weather !== false;
    _startInterval(weatherOn, refreshWeather, 600000);
    _startInterval(weatherOn, refreshWeatherDetail, 600000);
    _startInterval(weatherOn, refreshAirQuality, 1800000);
    _startInterval(weatherOn, refreshAlerts, 600000);
    _startInterval(true, refreshWeatherCard, 600000);
    _startInterval(ft.music !== false, refreshMusic, 3000);
    _startInterval(ft.fps !== false, refreshFps, 1000);
    _startInterval(ft.sysinfo !== false, refreshSysinfo, 60000);
    _startInterval(ft.top_process !== false, refreshTopProcess, 2000);
    // Fit the process list to the actual box height once the initial layout is done.
    setTimeout(recalcProcLimit, 800);

    // Music transport controls — previous / play-pause / next buttons
    const bindMusicCtrl = (id, action) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', async (e) => {
            spawnCtrlRipple(el, e);
            try {
                await action();
                refreshMusic();
            } catch (e) { console.warn('music ctrl:', e); }
        });
    };
    bindMusicCtrl('h-music-prev', () => pywebview.api.music_prev());
    bindMusicCtrl('h-music-toggle', async () => {
    const s = window._appSettings || {};
    const autoLaunch = s.auto_launch_music_player !== false;
    const music = await pywebview.api.get_music();
    if (!music.available && autoLaunch) {
        const ok = await pywebview.api.launch_last_player();
        if (ok) {
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 1000));
                const m = await pywebview.api.get_music();
                if (m.available) {
                    await pywebview.api.music_play_pause();
                    return;
                }
            }
        }
    }
    await pywebview.api.music_play_pause();
});
    bindMusicCtrl('h-music-next', () => pywebview.api.music_next());

    // Seek bar: preview time in tooltip while dragging, seek on release
    const seekEl = document.getElementById('h-music-seek');
    if (seekEl) {
        const seekTip = document.getElementById('h-music-seek-tip');
        const seekLeft = document.getElementById('h-music-time-left');
        seekEl.addEventListener('input', () => {
            _seeking = true;
            seekEl.classList.add('dragging');
            seekEl.style.setProperty('--seek-fill', (seekEl.value / 10) + '%');
            const dragPos = _musicDur > 0 ? seekEl.value / 1000 * _musicDur : 0;
            if (seekLeft) seekLeft.textContent = '-' + fmtMusicTime(_musicDur - dragPos);
            if (seekTip) {
                seekTip.textContent = fmtMusicTime(dragPos);
                seekTip.style.left = (seekEl.value / 10) + '%';
            }
        });
        seekEl.addEventListener('change', async () => {
            const pos = _musicDur > 0 ? seekEl.value / 1000 * _musicDur : 0;
            _seeking = false;
            seekEl.classList.remove('dragging');
            try { await pywebview.api.music_seek(pos); } catch (e) { console.warn('music seek:', e); }
            _musicBase = { pos, t: Date.now() };
            refreshMusic();
        });
    }
    bindLyricHover();

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
    const serverInfoOkBtn = document.getElementById('server-info-ok');
    if (serverInfoOkBtn) serverInfoOkBtn.addEventListener('click', hideServerInfoModal);
    const serverInfoOverlay = document.getElementById('server-info-overlay');
    if (serverInfoOverlay) serverInfoOverlay.addEventListener('click', (e) => {
        if (e.target === serverInfoOverlay) hideServerInfoModal();
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

    // 全部初始化完成后，再显示界面并收起加载动画
    showBody();

});
