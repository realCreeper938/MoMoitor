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
    if (pos) _layout[id] = pos;
    else delete _layout[id];
}

const DEFAULT_GRID = { rows: 5, cols: 2 };
const GRID_ROWS_MIN = 2;
const GRID_ROWS_MAX = 10;
const GRID_COLS_MIN = 1;
const GRID_COLS_MAX = 4;
const CLOCK_WIDTH = 150;

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

/* Which side the clock column sits on (cards use abstract cols 2/3; the clock
   is always full-height). 'right' flips the grid so the clock is at col 3. */
function _clockSide() {
    const c = _layout['clock-section'];
    return c && c.side === 'right' ? 'right' : 'left';
}

/* Abstract layout col (1=clock, 2..cols+1=cards) -> actual grid col. */
function _gridColFor(col) {
    if (col === 1) return _clockSide() === 'right' ? _gridCols() + 1 : 1;
    if (_clockSide() === 'right') return col - 1;
    return col;
}

function _layoutColFor(col) {
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
    return {
        col: Math.max(2, Math.min(col, cols + 1)),
        row: Math.max(1, Math.min(row, rows)),
        span: Math.max(1, Math.min(span, rows)),
        hidden: saved.hidden !== undefined ? saved.hidden === true : def.hidden === true,
    };
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

function resizableCards() {
    return allCards().filter(c => c.resizable);
}

/* Default layout: clock on the left, every card at its default position. */
function defaultLayout() {
    const layout = { 'clock-section': { side: 'left' } };
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
