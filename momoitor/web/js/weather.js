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

/** 天气总开关：weather.enabled 关闭时不获取天气信息。 */
function weatherEnabled() {
    return !window._appSettings || (window._appSettings.weather || {}).enabled !== false;
}

/* 天气停用时把侧栏天气与天气卡片重置为占位显示。 */
function resetWeatherDisplays() {
    setText('h-clock-weather-temp', '--℃');
    const hIcon = document.getElementById('h-wx-icon');
    if (hIcon) hIcon.textContent = '#';
    const popupIcon = document.getElementById('wx-popup-icon');
    if (popupIcon) popupIcon.textContent = '';
    setText('wx-popup-temp', '--');
    setText('wx-popup-text', '--');
    setText('wx-popup-city', '--');
    setText('wx-popup-updated', '--:--');
    setText('wx-feels', '--');
    setText('wx-humidity', '--');
    setText('wx-wind-dir', '--');
    setText('wx-wind-scale', '--');
    const aqiRow = document.getElementById('wx-aqi-row');
    if (aqiRow) aqiRow.style.display = 'none';
    const precipRow = document.getElementById('wx-precip-row');
    if (precipRow) precipRow.style.display = 'none';
    const alertsRow = document.getElementById('wx-alerts-row');
    if (alertsRow) alertsRow.style.display = 'none';
    const section = document.getElementById('weather-section');
    if (section) {
        section.dataset.wx = '';
        section.style.setProperty('--wx-bg-opacity', '0.5');
    }
    setText('wx-card-temp', '--');
    setText('wx-card-text', '--');
    setText('wx-card-city', '--');
    setText('wx-card-updated', '--');
    setText('wx-card-feels', '--');
    setText('wx-card-humidity', '--');
    setText('wx-card-wind', '--');
    const cardAqiRow = document.getElementById('wx-card-aqi-row');
    if (cardAqiRow) cardAqiRow.style.display = 'none';
    const cardPrecipRow = document.getElementById('wx-card-precip-row');
    if (cardPrecipRow) cardPrecipRow.style.display = 'none';
    setText('wx-card-precip-text', '--');
    const cardAlerts = document.getElementById('wx-card-alerts');
    if (cardAlerts) cardAlerts.innerHTML = '';
    const cardPrecipChart = document.getElementById('wx-card-precip-chart');
    if (cardPrecipChart) cardPrecipChart.innerHTML = '';
    hideWxTip();
}

function appendMoreAlerts(container, count, maxShow) {
    const more = document.createElement('div');
    more.className = 'wx-alert-more';
    more.textContent = `还有 ${count - maxShow} 个预警...`;
    container.appendChild(more);
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

/* 天气大卡片最多同时显示的预警图标数量 */
const WX_MAX_ALERTS = 6;

/* 按预警类型返回对应的 nf-md 图标。码位已对照内置 Symbols Nerd Font 校验，
 * 图标颜色由调用方按预警颜色（colorR/G/B）着色，例如雷电黄色预警显示为黄色闪电图标。 */
function wxAlertIcon(a) {
    const t = `${(a.eventType || '')} ${(a.headline || '')}`;
    if (/雷电/.test(t)) return '\u{F0593}';            // md-weather_lightning
    if (/雷暴|雷雨|强对流/.test(t)) return '\u{F067E}'; // md-weather_lightning_rainy
    if (/台风/.test(t)) return '\u{F0898}';             // md-weather_hurricane
    if (/冰雹/.test(t)) return '\u{F0592}';             // md-weather_hail
    if (/暴雨|大雨|降雨|降水|雨/.test(t)) return '\u{F0596}'; // md-weather_pouring
    if (/沙尘|沙暴/.test(t)) return '\u{F059E}';        // md-weather_windy_variant
    if (/大风|风/.test(t)) return '\u{F059D}';          // md-weather_windy
    if (/暴雪|雪/.test(t)) return '\u{F0F36}';          // md-weather_snowy_heavy
    if (/寒潮|低温|寒冷/.test(t)) return '\u{F0717}';   // md-snowflake
    if (/霜冻/.test(t)) return '\u{F12CB}';             // md-snowflake_melt
    if (/道路结冰|结冰/.test(t)) return '\u{F0462}';    // md-road_variant
    if (/高温|热浪/.test(t)) return '\u{F18D6}';        // md-sun_thermometer
    if (/干旱/.test(t)) return '\u{F058D}';             // md-water_off
    if (/雾/.test(t)) return '\u{F0591}';               // md-weather_fog
    if (/霾/.test(t)) return '\u{F0F30}';               // md-weather_hazy
    if (/海浪|风暴潮|海洋/.test(t)) return '\u{F078D}'; // md-waves
    return '\u{F05D6}';                                 // md-alert_circle_outline
}

async function refreshWeather() {
    if (!weatherEnabled()) { resetWeatherDisplays(); return; }
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
    if (!weatherEnabled()) { resetWeatherDisplays(); return; }
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

function aqiColorClass(category) {
    const cat = (category || '').toLowerCase();
    if (cat.includes('优')) return 'var(--green)';
    if (cat.includes('良')) return 'var(--yellow)';
    if (cat.includes('轻度') || cat.includes('中度')) return 'var(--orange)';
    if (cat.includes('重度') || cat.includes('严重')) return 'var(--red)';
    return '';
}

async function refreshAirQuality() {
    if (!weatherEnabled()) { resetWeatherDisplays(); return; }
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
        el.style.color = aqiColorClass(idx.category || '');
        row.style.display = '';
    } catch (e) { console.warn('refreshAirQuality:', e); }
}

/* Weather alerts */
async function refreshAlerts() {
    if (!weatherEnabled()) { resetWeatherDisplays(); return; }
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
        if (alerts.length > maxShow) appendMoreAlerts(list, alerts.length, maxShow);
        row.style.display = '';
    } catch (e) { console.warn('refreshAlerts:', e); }
}

/* Weather card — dedicated grid card with big/small variants. Alerts render as
   type-specific icons beside the condition text; precipitation shows as an
   inline title + summary row with a background trend chart. */

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

/* Catmull-Rom 转三次贝塞尔，把降水数据点连成平滑曲线 */
function wxSmoothPath(pts) {
    if (pts.length === 0) return '';
    if (pts.length < 3) return 'M' + pts.map(p => p.join(',')).join(' L');
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        const c1x = p1[0] + (p2[0] - p0[0]) / 6;
        const c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6;
        const c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
    }
    return d;
}

/* 背景降水趋势图：不抽样、逐分钟数据点全部绘制，平滑曲线 + 渐变面积填充 */
function renderWxPrecipChart(chartEl, items, section) {
    chartEl.innerHTML = '';
    const svgNS = 'http://www.w3.org/2000/svg';
    const W = Math.max(section.clientWidth || 320, 40);
    const H = Math.max(section.clientHeight || 200, 40);
    const n = items.length;
    const maxV = Math.max(1, ...items.map(m => parseFloat(m.precip) || 0));
    const padY = 2;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const x = n > 1 ? (i / (n - 1)) * W : W / 2;
        const v = parseFloat(items[i].precip) || 0;
        const y = H - padY - (v / maxV) * (H - padY * 2);
        pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    }
    const lineD = wxSmoothPath(pts);
    const areaD = `${lineD} L${W},${H} L0,${H} Z`;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const defs = document.createElementNS(svgNS, 'defs');
    const grad = document.createElementNS(svgNS, 'linearGradient');
    grad.setAttribute('id', 'wx-precip-grad');
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '1');
    const stopHi = document.createElementNS(svgNS, 'stop');
    stopHi.setAttribute('offset', '0');
    stopHi.setAttribute('class', 'wx-precip-stop-hi');
    const stopLo = document.createElementNS(svgNS, 'stop');
    stopLo.setAttribute('offset', '1');
    stopLo.setAttribute('class', 'wx-precip-stop-lo');
    grad.appendChild(stopHi);
    grad.appendChild(stopLo);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const area = document.createElementNS(svgNS, 'path');
    area.setAttribute('class', 'wx-precip-area');
    area.setAttribute('d', areaD);
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('class', 'wx-precip-line');
    line.setAttribute('d', lineD);
    svg.appendChild(area);
    svg.appendChild(line);
    chartEl.appendChild(svg);
}

async function refreshWeatherCard() {
    if (!weatherEnabled()) { resetWeatherDisplays(); return; }
    try {
        const section = document.getElementById('weather-section');
        if (!section) return;
        const [w, d, aq, alerts] = await Promise.all([
            pywebview.api.get_weather(),
            pywebview.api.get_weather_detail(),
            pywebview.api.get_airquality(),
            pywebview.api.get_alerts(),
        ]);

        // Main block: temperature + condition + city
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
            if (cardTemp) cardTemp.textContent = fmt(w.temp, 0);
            if (cardText) cardText.textContent = w.text || '--';
            if (cardCity) cardCity.textContent = w.city || '--';
            if (cardUpdated) cardUpdated.textContent = formatWxUpdateTime(w.updateTime);
        } else {
            if (section) {
                section.dataset.wx = '';
                section.style.setProperty('--wx-bg-opacity', '0.5');
            }
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
                aqiEl.style.color = aqiColorClass(idx.category || '');
                aqiRow.style.display = '';
            }
        }

        // Precipitation forecast (line chart as background)
        const precipRow = document.getElementById('wx-card-precip-row');
        const precipText = document.getElementById('wx-card-precip-text');
        const precipChart = document.getElementById('wx-card-precip-chart');
        let hasPrecip = false;
        if (precipRow && precipText && precipChart && section) {
            if (d && d.minutely && d.minutely.minutely && d.minutely.minutely.length > 0) {
                const items = d.minutely.minutely;
                hasPrecip = items.some(m => m.precip > 0);
                if (hasPrecip) {
                    precipText.textContent = d.minutely.summary || '--';
                    renderWxPrecipChart(precipChart, items, section);
                }
            }
            precipRow.style.display = hasPrecip ? '' : 'none';

            // Description keeps only the pure condition; the summary now lives
            // beside the "降水预报" title in the bottom row.
            if (cardText && w && !w.error && w.text) {
                cardText.textContent = w.text;
            }
        }

        // Alerts: compact type-specific icons next to the condition text
        const alertsBox = document.getElementById('wx-card-alerts');
        if (alertsBox) {
            const hasAlerts = Array.isArray(alerts) && alerts.length > 0;
            hideWxTip();
            alertsBox.innerHTML = '';
            alertsBox.style.display = hasAlerts ? '' : 'none';
            if (hasAlerts) {
                for (const a of alerts.slice(0, WX_MAX_ALERTS)) {
                    const icon = document.createElement('span');
                    icon.className = 'nf-icon wx-alert-icon';
                    icon.textContent = wxAlertIcon(a);
                    icon.style.color = a.colorCode ? `rgb(${a.colorR},${a.colorG},${a.colorB})` : 'var(--red)';
                    icon.addEventListener('mouseenter', () => showWxTip(icon, a));
                    icon.addEventListener('mouseleave', hideWxTip);
                    alertsBox.appendChild(icon);
                }
            }
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
