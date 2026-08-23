// Layout Adjustment — grid geometry, card placement & packing, layout
// persistence, and the init / mode wiring.  Layout-mode overlays, the card
// list panel, drag & drop and the text-card editor live in separate files.

function applyLayout(layout) {
    setLayout(Object.assign({}, DEFAULT_GRID, layout && typeof layout === 'object' ? layout : {}));
    const rows = _gridRows();
    const cols = _gridCols();
    layoutCards().forEach(card => {
        if (!card.el) return;
        card.applyGrid();
    });
    applyClockPlacement(rows, cols);
    applyLyricView();
}

/* Shape the grid and place the clock element for the current clock side.
   left/right: clock stays a full-height grid column (first/last track).
   top/bottom: the element is moved out of the grid into a taskbar-like
   strip directly above/below it inside #terminal. */
function applyClockPlacement(rows, cols) {
    const side = _clockSide();
    const vertical = side === 'top' || side === 'bottom';
    const grid = document.querySelector('.term-grid');
    const clockEl = document.getElementById('clock-section');
    document.body.classList.toggle('clock-top', side === 'top');
    document.body.classList.toggle('clock-bottom', side === 'bottom');
    if (!grid || !clockEl) {
        applyClockFontScale();
        return;
    }
    grid.classList.toggle('clock-right', side === 'right');
    if (vertical) {
        if (clockEl.parentElement === grid) {
            if (side === 'top') grid.parentElement.insertBefore(clockEl, grid);
            else grid.parentElement.insertBefore(clockEl, grid.nextSibling);
        }
        clockEl.classList.add('clock-bar');
        clockEl.style.gridColumn = '';
        clockEl.style.gridRow = '';
        grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    } else {
        if (clockEl.parentElement !== grid) {
            if (side === 'right') grid.appendChild(clockEl);
            else grid.insertBefore(clockEl, grid.firstElementChild);
        }
        clockEl.classList.remove('clock-bar');
        clockEl.style.gridColumn = side === 'right' ? String(cols + 1) : '1';
        clockEl.style.gridRow = '1 / -1';
        grid.style.gridTemplateColumns = side === 'right'
            ? 'repeat(' + cols + ', minmax(0, 1fr)) var(--clock-col)'
            : 'var(--clock-col) repeat(' + cols + ', minmax(0, 1fr))';
        const cw = getClockWidth();
        if (cw !== null) grid.style.setProperty('--clock-col', cw + 'px');
        else grid.style.removeProperty('--clock-col');
    }
    grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    // 横条/侧栏切换后壁纸渲染方式可能变化（横条模式强制 cover），重新应用
    if (typeof applyAppBackgroundGradient === 'function') applyAppBackgroundGradient();
    applyClockFontScale();
}

function readLayout() {
    const layout = {};
    layoutCards().forEach(card => {
        const el = card.el;
        const pos = _normLayout(card.id);
        layout[card.id] = {
            col: el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col,
            row: el && el.style.gridRow ? parseInt(el.style.gridRow) || pos.row : pos.row,
            span: pos.span,
            hidden: pos.hidden,
            font_scale: pos.font_scale,
        };
    });
    layout['clock-section'] = { side: _clockSide(), font_scale: getClockFontScale(), width: getClockWidth() };
    layout.rows = _gridRows();
    layout.cols = _gridCols();
    return layout;
}

function _colCards(col) {
    return layoutCards()
        .map(card => card.el)
        .filter(el => el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col))
        .sort((a, b) => parseInt(a.style.gridRow) - parseInt(b.style.gridRow));
}

/* Place a previously-hidden card into the grid at the given column/row, then
   compact the column and rebalance overflow.  If `span` is omitted, the card's
   layout span is used. */
function _placeCard(id, col, row, span) {
    const pos = _normLayout(id);
    const s = span || pos.span;
    const el = getCard(id).el;
    setCardPos(id, { col: col, row: row, span: s, hidden: false });
    if (el) {
        getCard(id).applyGrid();
        if (_layoutMode) {
            bindCardDrag(el);
            _addCardLayoutControls(id);
        }
        if (id === 'weather-section') refreshWeatherCard();
        if (id === 'text-section') applyCustomText(id);
        if (isCustomCard(id)) applyCustomCard(id);
    }
    _repackColumn(col, id, row);
    _rebalanceOverflow();
    _updateCardsBtn();
}

/* First row in a column that is not covered by any visible card, i.e. the next
   row a card can be appended to without creating a gap-free overflow. Returns
   rows+1 when the whole column is occupied. */
function _firstFreeRow(col) {
    const rows = _gridRows();
    for (let row = 1; row <= rows; row++) {
        let covered = false;
        layoutCards().forEach(function(card) {
            if (covered) return;
            const el = card.el;
            if (!el || el.style.display === 'none') return;
            if (parseInt(el.style.gridColumn) !== _gridColFor(col)) return;
            const r = parseInt(el.style.gridRow);
            const s = getLayoutSpan(card.id);
            if (row >= r && row < r + s) covered = true;
        });
        if (!covered) return row;
    }
    return rows + 1;
}

/* Compact every card column from the top.  Used when the grid dimensions change
   so out-of-range cards are packed back into the new grid without overlaps. */
function _repackAll() {
    const cols = _gridCols();
    for (let c = 2; c <= cols + 1; c++) _repackColumn(c);
}

/* True when ANY card column exceeds the grid height. */
function _anyOverflow() {
    const cols = _gridCols();
    const rows = _gridRows();
    for (let c = 2; c <= cols + 1; c++) {
        if (_columnHeight(c) > rows + 1) return true;
    }
    return false;
}

/* Whether some column other than `exceptCol` can fit one more `span`-sized card. */
function _columnHasRoomFor(span, exceptCol) {
    return _findColumnWithRoom(span, exceptCol) !== null;
}

/* Pick a column other than `exceptCol` that can fit a card of `span` rows, or
   null if none can. */
function _findColumnWithRoom(span, exceptCol) {
    const cols = _gridCols();
    const rows = _gridRows();
    for (let c = 2; c <= cols + 1; c++) {
        if (c === exceptCol) continue;
        if (_columnHeight(c) + span <= rows + 1) return c;
    }
    return null;
}

/* Click a card in the list: add it to whichever column still has room.
   If the card supports both sizes (resizable) and no column fits the full
   span, fall back to the small (span 1) form automatically. */
function _addCard(id) {
    const span = _normLayout(id).span;
    const cols = _gridCols();
    const rows = _gridRows();
    let col = null;
    let bestFree = -1;
    for (let c = 2; c <= cols + 1; c++) {
        const free = rows + 1 - _columnHeight(c);
        if (free >= span && (col === null || free > bestFree)) { col = c; bestFree = free; }
    }
    if (col === null && getCard(id).resizable && span > 1) {
        bestFree = -1;
        for (let c = 2; c <= cols + 1; c++) {
            const free = rows + 1 - _columnHeight(c);
            if (free >= 1 && (col === null || free > bestFree)) { col = c; bestFree = free; }
        }
        if (col !== null) { _placeCard(id, col, _firstFreeRow(col), 1); return; }
    }
    if (col === null) { showToast('空间不足'); return; }
    _placeCard(id, col, _firstFreeRow(col));
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


/* Rebuild _layout from the current DOM (gridColumn/gridRow set by swaps,
   rebalances and repacks). Keeps _layout in sync so applyLayout() (e.g. the
   clock flip) does not revert prior drag/rebalance moves. */
function _syncLayoutFromDom() {
    layoutCards().forEach(card => {
        const id = card.id;
        const el = card.el;
        if (!el) return;
        const pos = _normLayout(id);
        setCardPos(id, {
            col: el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col,
            row: el.style.gridRow ? parseInt(el.style.gridRow) || pos.row : pos.row,
            span: pos.span,
            hidden: pos.hidden,
        });
    });
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

function _columnHeight(col) {
    let maxEnd = 0;
    layoutCards().forEach(function(card) {
        const el = card.el;
        if (el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col)) {
            const end = parseInt(el.style.gridRow) + getLayoutSpan(card.id);
            if (end > maxEnd) maxEnd = end;
        }
    });
    return maxEnd;
}

/* The bottom-most (largest row) visible card in a column, if any. */
function _bottomCardId(col) {
    let bottomId = null;
    let bottomRow = -1;
    layoutCards().forEach(function(card) {
        const el = card.el;
        if (el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col)) {
            const row = parseInt(el.style.gridRow);
            if (row > bottomRow) {
                bottomRow = row;
                bottomId = card.id;
            }
        }
    });
    return bottomId;
}

/* Snapshot every card's grid placement so an operation can be reverted
   cleanly (restored exactly) if it would overflow the grid. */
function _snapshotLayout() {
    const snap = [];
    layoutCards().forEach(function(card) {
        const id = card.id;
        const el = card.el;
        if (!el) return;
        snap.push({
            id: id,
            col: el.style.gridColumn || '',
            row: el.style.gridRow || '',
            display: el.style.display || '',
            span: el.dataset.span || '',
            layout: Object.assign({}, getLayout()[id] || {}),
        });
    });
    const clockEl = document.getElementById('clock-section');
    snap.push({
        id: 'clock-section',
        col: clockEl ? clockEl.style.gridColumn || '' : '',
        row: '',
        display: '',
        span: '',
        layout: Object.assign({}, getLayout()['clock-section'] || {}),
    });
    return snap;
}

function _restoreLayout(snap) {
    snap.forEach(function(s) {
        const el = document.getElementById(s.id);
        if (!el) return;
        if (s.id === 'clock-section') {
            if (s.layout && Object.keys(s.layout).length) setCardPos(s.id, s.layout);
            else setCardPos(s.id, null);
            applyClockPlacement(_gridRows(), _gridCols());
            return;
        }
        el.style.gridColumn = s.col;
        el.style.gridRow = s.row;
        el.style.display = s.display;
        el.dataset.span = s.span;
        if (s.layout && Object.keys(s.layout).length) setCardPos(s.id, s.layout);
        else setCardPos(s.id, null);
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
    if (toHeight + span > _gridRows() + 1) return false;
    el.style.gridColumn = String(_gridColFor(toCol));
    el.style.gridRow = '99 / span ' + span;  // sentinel; _repackColumn sorts last → bottom
    _repackColumn(toCol);
    // Keep _layout in sync so a later applyLayout (e.g. clock flip) doesn't
    // revert this cross-column move.
    const pos = _normLayout(bottomId);
    setCardPos(bottomId, { col: toCol, row: parseInt(el.style.gridRow) || pos.row, span, hidden: pos.hidden });
    return true;
}

function _rebalanceOverflow() {
    let guard = 0;
    while (guard++ < 10) {
        if (!_anyOverflow()) return true;
        const cols = _gridCols();
        let moved = false;
        for (let c = 2; c <= cols + 1; c++) {
            if (_columnHeight(c) > _gridRows() + 1) {
                // Move the overflowing column's bottom card into any column
                // that can still fit it; if none can, the layout can't be fixed.
                const target = _findColumnWithRoom(getLayoutSpan(_bottomCardId(c)), c);
                if (target === null || !_moveCardToBottom(c, target)) return false;
                moved = true;
                break;
            }
        }
        if (!moved) return false;
    }
    return !_anyOverflow();
}

function resetLayout() {
    setLayout({});
    applyLayout(defaultLayout());
}

/* Persist the current on-grid layout to settings. */
async function saveLayout() {
    const layout = readLayout();
    try {
        const s = await pywebview.api.get_settings();
        s.layout = layout;
        await pywebview.api.save_settings(s);
        window._appSettings = { ...(window._appSettings || {}), layout: layout };
    } catch (e) { console.warn('save layout:', e); }
}

/* Reset every card's font scale (and the clock column's) back to 100% and
   persist. Called from the "恢复字体大小" button in the layout settings. */
function resetCardFontScales() {
    allCards().forEach(card => setCardPos(card.id, { font_scale: 100 }));
    setCardPos('clock-section', { font_scale: 100 });
    applyLayout(getLayout());
    saveLayout();
}

function initLayoutControls() {
    const modeBtn = document.getElementById('btn-layout-mode');
    const resetBtn = document.getElementById('btn-layout-reset');
    const fontResetBtn = document.getElementById('btn-font-reset');
    const saveBtn = document.getElementById('layout-save');
    const cancelBtn = document.getElementById('layout-cancel');
    const cardsBtn = document.getElementById('layout-cards');
    const cardsClose = document.getElementById('card-list-close');
    const cardPanel = document.getElementById('card-list-panel');
    const rowsSel = document.getElementById('layout-rows-sel');
    const colsSel = document.getElementById('layout-cols-sel');
    if (rowsSel) {
        for (let r = GRID_ROWS_MIN; r <= GRID_ROWS_MAX; r++) {
            const o = document.createElement('option');
            o.value = String(r);
            o.textContent = String(r);
            rowsSel.appendChild(o);
        }
    }
    if (colsSel) {
        for (let c = GRID_COLS_MIN; c <= GRID_COLS_MAX; c++) {
            const o = document.createElement('option');
            o.value = String(c);
            o.textContent = String(c);
            colsSel.appendChild(o);
        }
    }
    const applyDims = () => {
        if (!rowsSel || !colsSel) return;
        getLayout().rows = parseInt(rowsSel.value, 10) || DEFAULT_GRID.rows;
        getLayout().cols = parseInt(colsSel.value, 10) || DEFAULT_GRID.cols;
        applyLayout(getLayout());
        _repackAll();
        _syncLayoutFromDom();
        _updateCardsBtn();
    };
    if (rowsSel) rowsSel.addEventListener('change', applyDims);
    if (colsSel) colsSel.addEventListener('change', applyDims);
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
        showAppConfirm(t('layout-reset-confirm'), async () => {
            resetLayout();
            await saveLayout();
        });
    });
    if (fontResetBtn) fontResetBtn.addEventListener('click', () => {
        resetCardFontScales();
    });
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        await saveLayout();
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
    if (cur.rows !== _layoutSaved.rows || cur.cols !== _layoutSaved.cols) return true;
    if (layoutCards().some(card => {
        const id = card.id;
        const a = cur[id], b = _layoutSaved[id];
        return !a || !b
            || a.col !== b.col || a.row !== b.row
            || a.span !== b.span || a.hidden !== b.hidden
            || a.font_scale !== b.font_scale;
    })) return true;
    const a = cur['clock-section'], b = _layoutSaved['clock-section'];
    return !a || !b || a.side !== b.side || a.font_scale !== b.font_scale || a.width !== b.width;
}
