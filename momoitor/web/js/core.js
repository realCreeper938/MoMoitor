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

/* Hide a modal overlay / panel by element id (no-op if missing). */
function hideOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

/* Temperature warning */
const TEMP_THRESHOLDS = { cpu: 90, gpu: 87, mem: 78, vram: 95 };
let tempWarnings = [];
let tempWarnIdx = 0;
let tempWarnTimer = null;


/* Sparkline chart — 90s resource usage rendered as SVG polyline (CPU/GPU/MEM/FPS/Net) */
const CHART_WINDOW_MS = 90000;
const chartData = { cpu: [], gpu: [], mem: [], fps: [], fps_low1: [], net_up: [], net_down: [], disk_read: [], disk_write: [] };

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
function applyHoverAnim(enabled) {
    document.body.classList.toggle('no-hover-anim', !enabled);
}

/* Toggle smooth eased scroll for over-long lyrics (歌词过长时的平滑滚动).
   Overlong lyrics are always auto-scrolled horizontally; this setting only
   controls whether the scroll uses a smooth ease (on) or instant follow (off). */
let _lyricAnimEnabled = false;

function applyLyricAnim(enabled) {
    _lyricAnimEnabled = !!enabled;
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

function updateChart(key, dynamicMax, fixedMax) {
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
    const max = fixedMax || chartMax(data, dynamicMax);
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
                        // fps: show FPS and 1% low at this instant (dynamic max → no %)
                        const lowd = chartData['fps_low1'];
                        const low = lowd && lowd[idx] ? Math.round(lowd[idx].v) : 0;
                        label = timeStr + ' ' + Math.round(val) + ' FPS · 1% ' + low;
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
    el.style.opacity = '';
}

function formatNet(b) {
    if (b == null) return { val: '--', unit: 'KB/s' };
    if (b >= 1048576) return { val: (b / 1048576).toFixed(1), unit: 'MB/s' };
    return { val: Math.round(b / 1024), unit: 'KB/s' };
}

function updateCPU(d) {
    const cpuLoad = fmt(d.cpu.load, 0);
    setText('cpu-load', cpuLoad);
    applyLoadColor('cpu-load');
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
}

function updateGPU(d) {
    const gpuLoad = fmt(d.gpu.load, 0);
    setText('gpu-load', gpuLoad);
    applyLoadColor('gpu-load');
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
}

function updateMem(d) {
    if (_memCleanPending) {
        // Poll right after a click-clean — count down to the new value
        _memCleanPending = false;
        const cur = getUiEl('mem-pct');
        animateMemPct(parseInt(cur ? cur.textContent : '0', 10) || 0, d.mem.percent);
    } else {
        setText('mem-pct', fmt(d.mem.percent, 0));
        applyLoadColor('mem-pct');
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
}

function updateDisk(d) {
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
}

function updateNet(d) {
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
}

function updateUI(d) {
    updateCPU(d);
    updateGPU(d);
    updateMem(d);
    updateDisk(d);
    updateNet(d);
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
    applyLoadColor('cpu-live-load');
    applyLoadColor('gpu-live-load');
    applyLoadColor('mem-live-pct');
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

/* Hide the % for the small FPS card and re-fit the value font size. */
function _applyFpsSpan(el, span) {
    const pct = el.querySelector('.pct');
    if (pct) pct.style.display = span === 2 ? 'none' : '';
    _applyFpsFontSize();
}

async function refreshFps() {
    if (!_sectionVisible('fps-section')) return;
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

        // FPS sparkline (dynamic max — FPS varies by game).
        // 1% low shares the same Y scale so dips are comparable with the FPS line.
        const fpsVal = f && Number(f.fps) > 0 ? Number(f.fps) : 0;
        const lowVal = f && Number(f.low1pct) > 0 ? Number(f.low1pct) : 0;
        chartPush('fps', fpsVal, 360);
        chartPush('fps_low1', lowVal, 360);
        const fpsMax = chartMax(chartData['fps'], true);
        updateChart('fps', true, fpsMax);
        updateChart('fps_low1', true, fpsMax);

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
    if (!_sectionVisible('proc-section')) return; // 卡片被删除/隐藏时不再获取进程信息
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
    hideOverlay('kill-confirm-overlay');
}

// 通用应用内确认弹窗（替代 window.confirm）
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
    hideOverlay('app-confirm-overlay');
}

// 服务端模式提示框
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
    hideOverlay('server-info-overlay');
}

// 版本更新检测
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
    hideOverlay('update-overlay');
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
            console.info('进程已终止:', r.message || `已终止 ${name}`);
        } else {
            console.warn('终止失败:', (r && r.message) || '未知错误');
        }
        setTimeout(refreshTopProcess, 500);
    } catch (e) {
        console.warn('confirmKill:', e);
    }
}

/* Track which data sources are currently unavailable, so a toast fires
   only when a source flips from available to unavailable (not every poll). */
let _unavailableSources = new Set();

function updateUnavailableSources(unavailable) {
    if (!Array.isArray(unavailable)) return;
    const next = new Set(unavailable);
    for (const name of next) {
        if (!_unavailableSources.has(name)) {
            const label = _DATASOURCE_LABELS && _DATASOURCE_LABELS[name] ? _DATASOURCE_LABELS[name] : name;
            showToast(t('toast-source-unavailable').replace('{source}', label), 6000);
        }
    }
    _unavailableSources = next;
}

async function poll(generation = pollGeneration) {
    try {
        const skipNet = !_sectionVisible('net-section');
        const data = await pywebview.api.get_data(skipNet);
        if (generation !== pollGeneration) return;
        updateUI(data);
        updateUnavailableSources(data.unavailable_sources);
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

function _startWeatherIntervals(enabled) {
    _startInterval(enabled, refreshWeather, 600000);
    _startInterval(enabled, refreshWeatherDetail, 600000);
    _startInterval(enabled, refreshAirQuality, 1800000);
    _startInterval(enabled, refreshAlerts, 600000);
}
