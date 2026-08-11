/**
 * Calendar Popup Controller
 * Shows a calendar popup (grid + huangli) when hovering over the date.
 * No clock, no 7-day weather forecast.
 */

let calendarYear = null;
let calendarMonth = null;
let calPopupOpen = false;
let calPopupShowTimer = null;
let calPopupHideTimer = null;

const HUANGLI_CACHE_MAX = 128;
let huangliCache = new Map();

function setHuangliCache(key, value) {
    if (huangliCache.has(key)) {
        huangliCache.delete(key);
    } else if (huangliCache.size >= HUANGLI_CACHE_MAX) {
        const firstKey = huangliCache.keys().next().value;
        huangliCache.delete(firstKey);
    }
    huangliCache.set(key, value);
}

/* Holiday / 调休 data (year -> { "MM-DD": {holiday, name, type, ...} }) */
let holidayCache = {};

async function getHolidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    try {
        if (!window.pywebview || !window.pywebview.api) return {};
        const data = await pywebview.api.get_holiday(year);
        holidayCache[year] = data && typeof data === 'object' ? data : {};
    } catch (e) {
        console.warn('getHolidays:', e);
        holidayCache[year] = {};
    }
    return holidayCache[year];
}

/* Mark each cell with holiday/调休 info once its year data is loaded */
async function markHolidays(cells) {
    const byYear = {};
    cells.forEach(c => {
        const y = Number(c.dataset.year);
        if (!byYear[y]) byYear[y] = [];
        byYear[y].push(c);
    });
    for (const yearStr of Object.keys(byYear)) {
        const map = await getHolidays(Number(yearStr));
        if (!map) continue;
        for (const cell of byYear[yearStr]) {
            const mmdd = `${pad2(Number(cell.dataset.month))}-${pad2(Number(cell.dataset.day))}`;
            const h = map[mmdd];
            if (!h) continue;
            const tag = cell.querySelector('.cal-day-tag');
            if (h.holiday === false) {
                // 调休补班（周末上班）
                cell.classList.add('holiday-workday');
                if (tag) tag.textContent = '补';
            } else if (h.holiday === true) {
                cell.classList.add('holiday-rest');
                if (tag) tag.textContent = '休';
            }
        }
    }
}

/* Refresh current weather */
async function refreshCalendarWeather() {
    try {
        if (!window.pywebview || !window.pywebview.api) return;
        const w = await pywebview.api.get_weather();
        const iconEl = document.getElementById('cal-weather-icon');
        const tempEl = document.getElementById('cal-weather-temp');
        const textEl = document.getElementById('cal-weather-text');

        if (w && !w.error) {
            if (iconEl) iconEl.textContent = wxIcon(w.icon);
            if (tempEl) tempEl.textContent = (w.temp != null ? Math.round(w.temp) : '--') + '°';
            if (textEl) textEl.textContent = w.text || '--';
        }
    } catch (e) {
        // Silently ignore
    }
}

/* Today's lunar date shown in the popup header */
function updateCalPopupLunar() {
    const el = document.getElementById('cal-popup-lunar');
    if (!el) return;
    const now = new Date();
    const lu = Lunar.solar2lunar(now.getFullYear(), now.getMonth() + 1, now.getDate());
    if (lu) {
        el.textContent = `${lu.ganZhi}${lu.animal}年 ${lu.fullCN}`;
    }
}

/* Get huangli for a specific date */
async function getHuangli(year, month, day) {
    const key = `${year}-${month}-${day}`;
    if (huangliCache.has(key)) return huangliCache.get(key);
    try {
        if (!window.pywebview || !window.pywebview.api) return null;
        const data = await pywebview.api.get_huangli(year, month, day);
        if (data && !data.error) {
            setHuangliCache(key, data);
            return data;
        }
    } catch (e) {
        console.warn('getHuangli:', e);
    }
    return null;
}

/* Show day detail popup (huangli only) */
async function showDayPopup(cell, year, month, day) {
    const container = document.getElementById('clock-cal-popup');
    if (!container) return;

    const existingPopup = document.querySelector('.cal-day-popup');
    if (existingPopup) existingPopup.remove();

    const huangli = await getHuangli(year, month, day);
    const holidayMap = await getHolidays(year);
    const holiday = holidayMap ? holidayMap[`${pad2(month)}-${pad2(day)}`] : null;

    const popup = document.createElement('div');
    popup.className = 'cal-day-popup';

    let html = '<div class="cal-popup-content">';

    if (holiday) {
        if (holiday.holiday === false) {
            html += `<div class="cal-popup-section cal-popup-holiday work"><span class="cal-popup-label">班</span><span class="cal-popup-value">调休 · 补班</span></div>`;
        } else if (holiday.holiday === true && holiday.name) {
            html += `<div class="cal-popup-section cal-popup-holiday"><span class="cal-popup-label">假</span><span class="cal-popup-value">${holiday.name}</span></div>`;
        }
    }

    if (huangli && !huangli.error) {
        html += `<div class="cal-popup-section cal-popup-huangli">`;
        html += `<div class="cal-popup-title">黄历</div>`;
        html += `<div class="cal-popup-date">${huangli.lunarYear}年 ${huangli.lunarMonth}月 ${huangli.lunarDay}</div>`;
        html += `<div class="cal-popup-bazi">${huangli.year8Char} ${huangli.month8Char} ${huangli.day8Char}</div>`;
        html += `<div class="cal-popup-things">`;
        html += `<div class="cal-popup-good"><span class="cal-popup-label">宜</span><span class="cal-popup-value">${huangli.goodThing}</span></div>`;
        html += `<div class="cal-popup-bad"><span class="cal-popup-label">忌</span><span class="cal-popup-value">${huangli.badThing}</span></div>`;
        html += `</div>`;
        html += `</div>`;
    }

    html += '</div>';
    popup.innerHTML = html;

    container.appendChild(popup);

    // Position relative to the popup container
    const cellRect = cell.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const popupWidth = 280;
    const popupMaxHeight = 350;

    const cellCenterX = cellRect.left + cellRect.width / 2 - containerRect.left;
    const cellTop = cellRect.top - containerRect.top;
    const cellBottom = cellRect.bottom - containerRect.top;

    let top = cellBottom + 8;
    let left = cellCenterX - popupWidth / 2;

    if (left + popupWidth > containerRect.width) {
        left = containerRect.width - popupWidth - 8;
    }
    if (left < 0) {
        left = 8;
    }

    const spaceBelow = containerRect.height - cellBottom;
    const spaceAbove = cellTop;

    if (spaceBelow < 200 && spaceAbove > spaceBelow) {
        top = cellTop - 8;
        popup.style.bottom = (containerRect.height - top) + 'px';
        popup.style.top = 'auto';
    } else {
        popup.style.top = top + 'px';
        popup.style.bottom = 'auto';
    }

    popup.style.left = left + 'px';
    popup.style.width = popupWidth + 'px';
    popup.style.maxHeight = popupMaxHeight + 'px';

    requestAnimationFrame(() => {
        popup.classList.add('active');
    });
}

/* Calendar Grid */
function renderCalendar(year, month) {
    calendarYear = year;
    calendarMonth = month;

    setText('cal-year', year + '年');
    setText('cal-month', month + '月');

    const grid = document.getElementById('calendar-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const firstDay = new Date(year, month - 1, 1);
    let startWeekday = firstDay.getDay(); // 0=Sun
    startWeekday = startWeekday === 0 ? 7 : startWeekday; // Convert to Mon=1

    const daysInMonth = new Date(year, month, 0).getDate();
    const daysInPrevMonth = new Date(year, month - 1, 0).getDate();

    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;

    // Previous month days
    for (let i = startWeekday - 1; i > 0; i--) {
        const day = daysInPrevMonth - i + 1;
        const prevMonth = month === 1 ? 12 : month - 1;
        const prevYear = month === 1 ? year - 1 : year;
        const lunar = Lunar.solar2lunar(prevYear, prevMonth, day);
        const cell = createDayCell(day, lunar, true, false, false, false, prevYear, prevMonth);
        grid.appendChild(cell);
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month - 1, d);
        const weekday = date.getDay();
        const isWeekend = weekday === 0 || weekday === 6;
        const isToday = isCurrentMonth && today.getDate() === d;

        const lunar = Lunar.solar2lunar(year, month, d);
        const festival = Lunar.getFestival(month, d);
        const lunarFestival = lunar ? Lunar.getLunarFestival(lunar.lMonth, lunar.lDay, lunar.isLeap) : null;
        const solarTerm = Lunar.getSolarTermForDate(year, month, d);
        const isHoliday = festival || lunarFestival;

        let lunarText = '';
        if (lunarFestival) {
            lunarText = lunarFestival;
        } else if (festival) {
            lunarText = festival;
        } else if (solarTerm) {
            lunarText = solarTerm;
        } else if (lunar) {
            lunarText = lunar.dayCN;
        }

        const cell = createDayCell(d, { ...lunar, displayText: lunarText }, false, isToday, isWeekend, isHoliday, year, month);
        grid.appendChild(cell);
    }

    // Next month days
    const totalCells = grid.children.length;
    const remaining = 42 - totalCells; // 6 rows * 7 days
    for (let d = 1; d <= remaining; d++) {
        const nextMonth = month === 12 ? 1 : month + 1;
        const nextYear = month === 12 ? year + 1 : year;
        const lunar = Lunar.solar2lunar(nextYear, nextMonth, d);
        const cell = createDayCell(d, lunar, true, false, false, false, nextYear, nextMonth);
        grid.appendChild(cell);
    }

    // Load holiday/调休 info for the visible cells (async, applied when ready)
    markHolidays(Array.from(grid.children));
}

function createDayCell(day, lunar, isOtherMonth, isToday, isWeekend, isHoliday, year, month) {
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    cell.dataset.year = year;
    cell.dataset.month = month;
    cell.dataset.day = day;

    if (isOtherMonth) cell.classList.add('other-month');
    if (isToday) cell.classList.add('today');
    if (isWeekend) cell.classList.add('weekend');
    if (isHoliday) cell.classList.add('holiday');

    const numEl = document.createElement('div');
    numEl.className = 'cal-day-num';
    numEl.textContent = day;
    cell.appendChild(numEl);

    const lunarEl = document.createElement('div');
    lunarEl.className = 'cal-day-lunar';
    lunarEl.textContent = lunar ? (lunar.displayText || lunar.dayCN) : '';
    cell.appendChild(lunarEl);

    const tagEl = document.createElement('span');
    tagEl.className = 'cal-day-tag';
    cell.appendChild(tagEl);

    // Click handler for huangli popup
    if (!isOtherMonth) {
        cell.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.cal-day-popup').forEach(p => p.remove());
            showDayPopup(cell, year, month, day);
        });
    }

    return cell;
}

/* Popup positioning */
function defaultCalAnchor() {
    return document.getElementById('h-clock-date');
}

function positionCalPopup(anchor) {
    const popup = document.getElementById('clock-cal-popup');
    if (!popup) return;
    const ref = anchor || defaultCalAnchor();
    if (!ref) return;

    const r = ref.getBoundingClientRect();
    const popupW = popup.offsetWidth || 340;
    const popupH = popup.offsetHeight || 420;
    const margin = 10;

    let left = r.left + r.width / 2 - popupW / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popupW - margin));

    let top = r.bottom + margin;
    if (top + popupH > window.innerHeight - margin) {
        top = Math.max(margin, r.top - popupH - margin);
    }

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
}

/* Show/Hide */
function openCalendarPopup(anchor) {
    const popup = document.getElementById('clock-cal-popup');
    if (!popup) return;
    // Check if calendar feature is enabled
    if (window._appSettings && window._appSettings.feature_toggles && window._appSettings.feature_toggles.calendar === false) return;
    if (!calendarYear) {
        const now = new Date();
        renderCalendar(now.getFullYear(), now.getMonth() + 1);
    }
    positionCalPopup(anchor);
    popup.classList.add('active');
    calPopupOpen = true;
    refreshCalendarWeather();
    updateCalPopupLunar();
}

function closeCalendarPopup() {
    const popup = document.getElementById('clock-cal-popup');
    if (popup) popup.classList.remove('active');
    calPopupOpen = false;
    document.querySelectorAll('.cal-day-popup').forEach(p => p.remove());
}

/* Hover scheduling — small delays so the popup doesn't flicker when the
 * mouse moves between the date and the popup itself. */
function scheduleCalPopupShow(anchor) {
    if (calPopupHideTimer) {
        clearTimeout(calPopupHideTimer);
        calPopupHideTimer = null;
    }
    if (calPopupShowTimer) return;
    calPopupShowTimer = setTimeout(() => {
        calPopupShowTimer = null;
        openCalendarPopup(anchor);
    }, 120);
}

function scheduleCalPopupHide() {
    if (calPopupShowTimer) {
        clearTimeout(calPopupShowTimer);
        calPopupShowTimer = null;
        return;
    }
    if (calPopupHideTimer) return;
    calPopupHideTimer = setTimeout(() => {
        calPopupHideTimer = null;
        closeCalendarPopup();
    }, 250);
}

function setupCalendarHover() {
    const popup = document.getElementById('clock-cal-popup');
    const anchor = document.getElementById('h-clock-date');
    if (anchor) {
        anchor.addEventListener('mouseenter', () => scheduleCalPopupShow(anchor));
        anchor.addEventListener('mouseleave', scheduleCalPopupHide);
    }
    if (popup) {
        popup.addEventListener('mouseenter', () => {
            if (calPopupHideTimer) {
                clearTimeout(calPopupHideTimer);
                calPopupHideTimer = null;
            }
        });
        popup.addEventListener('mouseleave', scheduleCalPopupHide);
    }
}

/* Navigation */
function setupCalendarNav() {
    const prevBtn = document.getElementById('cal-prev');
    const nextBtn = document.getElementById('cal-next');
    const todayBtn = document.getElementById('cal-today');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            calendarMonth--;
            if (calendarMonth < 1) {
                calendarMonth = 12;
                calendarYear--;
            }
            renderCalendar(calendarYear, calendarMonth);
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            calendarMonth++;
            if (calendarMonth > 12) {
                calendarMonth = 1;
                calendarYear++;
            }
            renderCalendar(calendarYear, calendarMonth);
        });
    }

    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            const now = new Date();
            renderCalendar(now.getFullYear(), now.getMonth() + 1);
        });
    }

    // Close day popup when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.cal-day') && !e.target.closest('.cal-day-popup')) {
            document.querySelectorAll('.cal-day-popup').forEach(p => p.remove());
        }
    });
}

/* Mouse wheel — scroll down = next month, scroll up = previous month.
 * A short cooldown prevents skipping multiple months on fast scrolls. */
function setupCalendarWheel() {
    const popup = document.getElementById('clock-cal-popup');
    if (!popup) return;
    let wheelCooldown = false;
    popup.addEventListener('wheel', (e) => {
        if (!calPopupOpen || wheelCooldown) return;
        // Don't navigate when scrolling inside a day detail popup (it has its own scroll)
        if (e.target.closest('.cal-day-popup')) return;
        e.preventDefault();
        if (e.deltaY > 0) {
            calendarMonth++;
            if (calendarMonth > 12) { calendarMonth = 1; calendarYear++; }
        } else if (e.deltaY < 0) {
            calendarMonth--;
            if (calendarMonth < 1) { calendarMonth = 12; calendarYear--; }
        } else {
            return;
        }
        // Close any open day detail popup when changing months
        document.querySelectorAll('.cal-day-popup').forEach(p => p.remove());
        renderCalendar(calendarYear, calendarMonth);
        wheelCooldown = true;
        setTimeout(() => { wheelCooldown = false; }, 180);
    }, { passive: false });
}

/* Initialize */
function initCalendar() {
    setupCalendarNav();
    setupCalendarHover();
    setupCalendarWheel();
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCalendar);
} else {
    initCalendar();
}
