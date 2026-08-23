// Card registry — the single source of truth for which cards exist and how each
// card behaves. layout.js drives grid positioning/geometry from here.
//
// The clock column is NOT a registered card: it has no col/row/span/hidden and is
// handled as a special case in the layout state (clock-section.side).

let _layout = {};

function getLayout() {
    return _layout;
}

function setLayout(layout) {
    _layout = layout;
}

function setCardPos(id, pos) {
    if (pos) _layout[id] = Object.assign({}, _layout[id] || {}, pos);
    else delete _layout[id];
}

const DEFAULT_GRID = { rows: 5, cols: 2 };
const GRID_ROWS_MIN = 2;
const GRID_ROWS_MAX = 10;
const GRID_COLS_MIN = 1;
const GRID_COLS_MAX = 4;
const CLOCK_WIDTH = 150;
const CLOCK_WIDTH_MIN = 110;
const CLOCK_WIDTH_MAX = 400;

const _cardRegistry = [];

/* Effective grid dimensions read from the current layout (fall back to the
   defaults when the saved layout omits them or stores an out-of-range value). */
function _gridRows() {
    const r = parseInt(_layout.rows, 10);
    return r >= GRID_ROWS_MIN && r <= GRID_ROWS_MAX ? r : DEFAULT_GRID.rows;
}

function _gridCols() {
    const c = parseInt(_layout.cols, 10);
    return c >= GRID_COLS_MIN && c <= GRID_COLS_MAX ? c : DEFAULT_GRID.cols;
}

/* Which side the clock sits on: a full-height column on 'left'/'right', or a
   taskbar-like full-width strip at 'top'/'bottom'. Cards use abstract cols
   2..cols+1; the clock is never part of the card area. */
function _clockSide() {
    const s = _layout['clock-section'] && _layout['clock-section'].side;
    return s === 'right' || s === 'top' || s === 'bottom' ? s : 'left';
}

/* True when the clock renders as a horizontal bar above/below the grid. */
function _clockVertical() {
    const s = _clockSide();
    return s === 'top' || s === 'bottom';
}

/* Abstract layout col (1=clock, 2..cols+1=cards) -> actual grid col. In
   top/bottom bar mode there is no clock track, so card cols shift down by 1. */
function _gridColFor(col) {
    if (_clockVertical()) return Math.max(1, col - 1);
    if (col === 1) return _clockSide() === 'right' ? _gridCols() + 1 : 1;
    if (_clockSide() === 'right') return col - 1;
    return col;
}

function _layoutColFor(col) {
    if (_clockVertical()) return col + 1;
    if (_clockSide() === 'right') return col + 1;
    return col;
}

/* Effective position of a card: saved values clamped to the current grid,
   falling back to the card's defaults when the saved layout omits them. */
function _normLayout(id) {
    const saved = _layout[id] || {};
    const def = getCard(id).def;
    const cols = _gridCols();
    const rows = _gridRows();
    const col = saved.col || def.col;
    const row = saved.row || def.row;
    const span = saved.span != null ? saved.span : def.span;
    let fs = parseFloat(saved.font_scale);
    if (!(fs >= FONT_SCALE_MIN && fs <= FONT_SCALE_MAX)) fs = 100;
    return {
        col: Math.max(2, Math.min(col, cols + 1)),
        row: Math.max(1, Math.min(row, rows)),
        span: Math.max(1, Math.min(span, rows)),
        hidden: saved.hidden !== undefined ? saved.hidden === true : def.hidden === true,
        font_scale: fs,
    };
}

const FONT_SCALE_MIN = 50;
const FONT_SCALE_MAX = 200;

function getCardFontScale(id) {
    return _normLayout(id).font_scale;
}

/* Clock column font scale (the clock is not a registered card; its scale lives
   in the clock-section layout entry next to `side`). */
function getClockFontScale() {
    const c = _layout['clock-section'] || {};
    let fs = parseFloat(c.font_scale);
    if (!(fs >= FONT_SCALE_MIN && fs <= FONT_SCALE_MAX)) fs = 100;
    return fs;
}

/* User-set clock column width in px, or null when the default CSS --clock-col
   formula (which scales with --font-scale) should be used. */
function getClockWidth() {
    const c = _layout['clock-section'] || {};
    let w = parseFloat(c.width);
    if (!(w >= CLOCK_WIDTH_MIN && w <= CLOCK_WIDTH_MAX)) w = null;
    return w;
}

/* Apply this card's font scale as an override of --font-scale on its element,
   relative to the global scale (which lives on <html>). */
function applyCardFontScale(id) {
    const card = getCard(id);
    if (!card || !card.el) return;
    const global = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale'));
    const scale = ((isFinite(global) ? global : 1) * getCardFontScale(id)) / 100;
    card.el.style.setProperty('--font-scale', String(scale));
}

/* Apply the clock column's font scale the same way (its fonts all use
   --font-scale via layout.css, so overriding the variable scales the clock). */
function applyClockFontScale() {
    const el = document.getElementById('clock-section');
    if (!el) return;
    const global = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale'));
    const scale = ((isFinite(global) ? global : 1) * getClockFontScale()) / 100;
    el.style.setProperty('--font-scale', String(scale));
}

function getLayoutSpan(id) {
    return _normLayout(id).span;
}

/* Register a card. Built-in cards are registered at load time from their HTML
   elements. */
function registerCard(id, opts) {
    const existing = getCard(id);
    if (existing) return existing;
    const el = opts.el || document.getElementById(id);
    const card = {
        id: id,
        el: el,
        def: opts.def || {},
        resizable: !!opts.resizable,
        feature: opts.feature || null,
        meta: opts.meta || {},
        col() { return _normLayout(id).col; },
        row() { return _normLayout(id).row; },
        span() { return _normLayout(id).span; },
        hidden() { return _normLayout(id).hidden; },
        setPos(col, row, span, hidden) {
            setCardPos(id, { col, row, span, hidden: !!hidden });
        },
        applyGrid() {
            const pos = _normLayout(id);
            el.style.gridColumn = String(_gridColFor(pos.col));
            el.style.gridRow = pos.row + ' / span ' + pos.span;
            el.style.display = _sectionVisible(id) ? '' : 'none';
            el.dataset.span = pos.span;
            if (id === 'fps-section') _applyFpsSpan(el, pos.span);
            applyCardFontScale(id);
        },
    };
    _cardRegistry.push(card);
    return card;
}

function getCard(id) {
    for (let i = 0; i < _cardRegistry.length; i++) {
        if (_cardRegistry[i].id === id) return _cardRegistry[i];
    }
    return null;
}

/* Remove a dynamically-created card from the registry. Safe to call when the
   card was never registered. */
function unregisterCard(id) {
    const idx = _cardRegistry.findIndex(c => c.id === id);
    if (idx >= 0) _cardRegistry.splice(idx, 1);
}

function allCards() {
    return _cardRegistry.slice();
}

/* Draggable/placeable cards (everything except the clock column). */
function layoutCards() {
    return allCards();
}

/* Default layout: clock on the left, every card at its default position. */
function defaultLayout() {
    const layout = { 'clock-section': { side: 'left', font_scale: 100 } };
    for (const card of allCards()) {
        layout[card.id] = Object.assign({}, card.def);
    }
    layout.rows = DEFAULT_GRID.rows;
    layout.cols = DEFAULT_GRID.cols;
    return layout;
}

/* ---- Built-in cards ---- */
registerCard('cpu-section', {
    def: { col: 2, row: 1, span: 2, hidden: false },
    resizable: true,
    meta: { name: 'CPU', color: 'var(--cyan)', value: '88', pct: '%', lines: [['4200', 'MHz', '65', '°C'], ['120', 'W', '1.3', 'V']] },
});
registerCard('gpu-section', {
    def: { col: 3, row: 1, span: 2, hidden: false },
    resizable: true,
    meta: { name: 'GPU', color: 'var(--accent)', value: '76', pct: '%', lines: [['68', '°C', '180', 'W'], ['11.2', '/12 GB', '64', '°C']] },
});
registerCard('mem-section', {
    def: { col: 2, row: 4, span: 1, hidden: false },
    resizable: true,
    meta: { name: 'Memory', color: 'var(--magenta)', value: '54', pct: '%', lines: [['3600', 'MHz', '1.1', 'V'], ['8.6', '/16 GB', '45', '°C']] },
});
registerCard('net-section', {
    def: { col: 2, row: 3, span: 1, hidden: false },
    resizable: true,
    meta: { name: 'Network', color: 'var(--green)', type: 'duo', duo: [['↓', '12.3', 'MB/s'], ['↑', '4.5', 'MB/s']] },
});
registerCard('fps-section', {
    def: { col: 3, row: 4, span: 2, hidden: false },
    resizable: true,
    feature: 'fps',
    meta: { name: 'FPS', color: 'var(--yellow)', value: '144', pct: 'FPS', lines: [['6.9', 'ms', '1% 118', ''], ['AVG 141', '', '99% 137', '']] },
});
registerCard('disk-section', {
    def: { col: 3, row: 3, span: 1, hidden: false },
    resizable: false,
    meta: { name: 'Disk', color: 'var(--blue)', type: 'duo', duo: [['R', '120', 'MB/s'], ['W', '45', 'MB/s']] },
});
registerCard('proc-section', {
    def: { col: 3, row: 5, span: 1, hidden: true },
    resizable: false,
    meta: { name: 'Process', color: 'var(--text-dim)', type: 'proc' },
});
registerCard('music-section', {
    def: { col: 2, row: 5, span: 1, hidden: false },
    resizable: true,
    feature: 'music',
    meta: { name: 'Music', color: 'var(--accent)', type: 'music' },
});
registerCard('hr-section', {
    def: { col: 2, row: 6, span: 1, hidden: true },
    resizable: false,
    meta: { name: 'Heart Rate', color: '#ff5c8a', value: '72', pct: 'BPM', lines: [] },
});
registerCard('weather-section', {
    def: { col: 2, row: 1, span: 1, hidden: true },
    resizable: true,
    meta: { name: 'Weather', color: 'var(--orange)', type: 'weather' },
});
registerCard('text-section', {
    def: { col: 3, row: 1, span: 1, hidden: true },
    resizable: true,
    meta: { name: 'Text', color: 'var(--accent)', type: 'text' },
});
