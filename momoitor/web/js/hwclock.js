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
    } else {
        setHeaderText(cpuLabel, 'CPU');
        setHeaderText(gpuLabel, 'GPU');
        setHeaderText(memLabel, 'Memory');
        if (diskLabel) setHeaderText(diskLabel, 'Disk');
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

/* 时段划分：0-5 凌晨 / 5-8 清晨(早上) / 8-11 上午 / 11-13 中午 /
   13-17 下午 / 17-19 傍晚 / 19-23 晚上 / 其余 午夜。 */
function _clockGradientKey(h) {
    if (h >= 0 && h < 5) return 'dawn';
    if (h >= 5 && h < 8) return 'morning-early';
    if (h >= 8 && h < 11) return 'morning';
    if (h >= 11 && h < 13) return 'noon';
    if (h >= 13 && h < 17) return 'afternoon';
    if (h >= 17 && h < 19) return 'dusk';
    if (h >= 19 && h < 23) return 'night';
    return 'midnight';
}

let _daypartForce = '';  // 调试：强制时段键，空串表示按当前时间自动

/** 调试：强制时段显示（空串恢复自动）。用于天气卡片的时段渐变预览。 */
function forceClockTimeGradient(key) {
    _daypartForce = key || '';
    _weatherDaypartHour = -1;  // 天气卡片时段色随强制值立即刷新
}

/* 天气卡片氛围渐变按时段着色：清晨(5-8点)与傍晚(17-19点)改用对应时段色，
   其余时段移除标记、保持天气状态色。复用时段划分与调试强制值，
   仅跨小时时更新 DOM。 */
let _weatherDaypartHour = -1;

function updateWeatherDaypart() {
    const h = new Date().getHours();
    if (h === _weatherDaypartHour) return;
    _weatherDaypartHour = h;
    const section = document.getElementById('weather-section');
    if (!section) return;
    const key = _daypartForce || _clockGradientKey(h);
    if (key === 'dusk' || key === 'morning-early') {
        section.setAttribute('data-daypart', key);
    } else {
        section.removeAttribute('data-daypart');
    }
}

function startClock() {
    // 从持久化设置读取 12/24 小时制与显秒（startClock 在设置加载完成后调用）
    _clock24 = (window._appSettings && window._appSettings.clock && window._appSettings.clock.clock_24h) !== false;
    _clockShowSeconds = (window._appSettings && window._appSettings.clock && window._appSettings.clock.clock_show_seconds) !== false;

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
        updateWeatherDaypart();
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
    setInterval(tick, 1000);
}
