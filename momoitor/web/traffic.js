/**
 * Traffic Popup Controller
 * Shows daily traffic records in a calendar view when clicking net up/down.
 */

let trafficYear = null;
let trafficMonth = null;
let trafficPopupOpen = false;

/* Format bytes to human-readable string */
function formatTrafficBytes(bytes) {
    if (bytes == null || bytes < 0) return '--';
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes < 1024 * 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + ' TB';
}

/* Get color intensity for a given day's traffic (bytes) */
function getTrafficColor(total, maxTotal) {
    if (!total || total <= 0 || !maxTotal || maxTotal <= 0) return 'transparent';
    const ratio = Math.min(1, total / maxTotal);
    // 5 levels: none -> light -> medium -> strong -> deep blue
    if (ratio <= 0.1) return 'rgba(52, 119, 235, 0.08)';
    if (ratio <= 0.25) return 'rgba(52, 119, 235, 0.15)';
    if (ratio <= 0.5) return 'rgba(52, 119, 235, 0.28)';
    if (ratio <= 0.75) return 'rgba(52, 119, 235, 0.45)';
    return 'rgba(52, 119, 235, 0.65)';
}

/* Render traffic calendar grid */
async function renderTrafficCalendar(year, month) {
    trafficYear = year;
    trafficMonth = month;

    const titleEl = document.getElementById('traffic-cal-title');
    if (titleEl) titleEl.textContent = year + '年 ' + month + '月';

    const grid = document.getElementById('traffic-cal-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Fetch traffic data for this month
    let monthData = {};
    try {
        if (window.pywebview && window.pywebview.api) {
            const data = await pywebview.api.get_traffic_month(year, month);
            if (data && !data.error) {
                monthData = data;
            }
        }
    } catch (e) { console.warn('get_traffic_month:', e); }

    // Find max total for the month to normalize colors
    let maxTotal = 0;
    for (const dateKey of Object.keys(monthData)) {
        const d = monthData[dateKey];
        const total = (d.up || 0) + (d.down || 0);
        if (total > maxTotal) maxTotal = total;
    }

    const firstDay = new Date(year, month - 1, 1);
    let startWeekday = firstDay.getDay();
    startWeekday = startWeekday === 0 ? 7 : startWeekday;

    const daysInMonth = new Date(year, month, 0).getDate();
    const daysInPrevMonth = new Date(year, month - 1, 0).getDate();

    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;

    // Previous month filler
    for (let i = startWeekday - 1; i > 0; i--) {
        const cell = document.createElement('div');
        cell.className = 'traffic-cal-day other-month';
        cell.textContent = daysInPrevMonth - i + 1;
        grid.appendChild(cell);
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
        const cell = document.createElement('div');
        cell.className = 'traffic-cal-day';

        const isToday = isCurrentMonth && today.getDate() === d;
        if (isToday) cell.classList.add('today');

        const dateKey = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const dayData = monthData[dateKey];
        const total = dayData ? (dayData.up || 0) + (dayData.down || 0) : 0;

        // Background color based on traffic amount
        if (total > 0) {
            cell.style.background = getTrafficColor(total, maxTotal);
        }

        // Day number
        const numEl = document.createElement('div');
        numEl.className = 'traffic-cal-day-num' + (total > 0 ? ' has-traffic' : '');
        numEl.textContent = d;
        cell.appendChild(numEl);

        // Traffic value (if any)
        if (total > 0) {
            const valEl = document.createElement('div');
            valEl.className = 'traffic-cal-day-val';
            valEl.textContent = formatTrafficBytes(total);
            cell.appendChild(valEl);
        }

        grid.appendChild(cell);
    }

    // Next month filler
    const totalCells = grid.children.length;
    const remaining = 42 - totalCells;
    for (let d = 1; d <= remaining; d++) {
        const cell = document.createElement('div');
        cell.className = 'traffic-cal-day other-month';
        cell.textContent = d;
        grid.appendChild(cell);
    }
}

/* Refresh today's summary cards */
async function refreshTrafficSummary() {
    try {
        if (!window.pywebview || !window.pywebview.api) return;

        const today = await pywebview.api.get_traffic_today();
        if (today && !today.error) {
            const total = (today.up || 0) + (today.down || 0);
            document.getElementById('traffic-total').textContent = formatTrafficBytes(total);
            document.getElementById('traffic-down-today').textContent = formatTrafficBytes(today.down || 0);
            document.getElementById('traffic-up-today').textContent = formatTrafficBytes(today.up || 0);
        }

        const procs = await pywebview.api.get_traffic_top_processes(1);
        const procEl = document.getElementById('traffic-top-proc');
        if (procs && procs.length > 0 && !procs.error) {
            procEl.textContent = procs[0].name || '--';
            procEl.title = procs[0].name + ' (↑' + formatTrafficBytes(procs[0].up || 0) + ' ↓' + formatTrafficBytes(procs[0].down || 0) + ')';
        } else {
            procEl.textContent = '--';
            procEl.title = '';
        }
    } catch (e) { console.warn('refreshTrafficSummary:', e); }
}

/* Open traffic popup */
async function openTrafficPopup() {
    const popup = document.getElementById('traffic-popup');
    const overlay = document.getElementById('traffic-popup-overlay');
    if (!popup || !overlay) return;

    // Check if traffic feature is enabled
    if (window._appSettings && window._appSettings.feature_toggles && window._appSettings.feature_toggles.traffic === false) return;

    const now = new Date();
    trafficYear = now.getFullYear();
    trafficMonth = now.getMonth() + 1;

    popup.style.display = 'flex';
    overlay.style.display = 'flex';
    trafficPopupOpen = true;

    await renderTrafficCalendar(trafficYear, trafficMonth);
    await refreshTrafficSummary();
}

/* Close traffic popup */
function closeTrafficPopup() {
    const popup = document.getElementById('traffic-popup');
    const overlay = document.getElementById('traffic-popup-overlay');
    if (popup) popup.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    trafficPopupOpen = false;
}

/* Setup click handlers */
function initTraffic() {
    // Close button
    const closeBtn = document.getElementById('traffic-popup-close');
    if (closeBtn) closeBtn.addEventListener('click', closeTrafficPopup);

    // Overlay click to close
    const overlay = document.getElementById('traffic-popup-overlay');
    if (overlay) overlay.addEventListener('click', closeTrafficPopup);

    // Prevent clicks inside popup from bubbling to overlay (e.g. month nav buttons)
    const popup = document.getElementById('traffic-popup');
    if (popup) popup.addEventListener('click', (e) => e.stopPropagation());

    // Navigation
    const prevBtn = document.getElementById('traffic-cal-prev');
    const nextBtn = document.getElementById('traffic-cal-next');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            trafficMonth--;
            if (trafficMonth < 1) { trafficMonth = 12; trafficYear--; }
            renderTrafficCalendar(trafficYear, trafficMonth);
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            trafficMonth++;
            if (trafficMonth > 12) { trafficMonth = 1; trafficYear++; }
            renderTrafficCalendar(trafficYear, trafficMonth);
        });
    }

    // Click on net down/up values to open traffic popup
    const netDown = document.getElementById('net-down');
    const netUp = document.getElementById('net-up');
    if (netDown) netDown.style.cursor = 'pointer';
    if (netUp) netUp.style.cursor = 'pointer';

    document.addEventListener('click', (e) => {
        const target = e.target.closest('#net-down, #net-up');
        if (target) {
            openTrafficPopup();
        }
    });
}

// Auto-init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTraffic);
} else {
    initTraffic();
}