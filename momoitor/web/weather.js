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

function aqiColorClass(category) {
    const cat = (category || '').toLowerCase();
    if (cat.includes('优')) return 'var(--green)';
    if (cat.includes('良')) return 'var(--yellow)';
    if (cat.includes('轻度') || cat.includes('中度')) return 'var(--orange)';
    if (cat.includes('重度') || cat.includes('严重')) return 'var(--red)';
    return '';
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
        el.style.color = aqiColorClass(idx.category || '');
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
                aqiEl.style.color = aqiColorClass(idx.category || '');
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
