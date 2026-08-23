// Drag & drop: HTML5 DnD handlers for moving cards on the grid, plus the
// drop-slot geometry for dropping onto empty grid space.

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
    allCards().forEach(card => {
        if (card.el) card.el.classList.remove('drag-over');
    });
    const clockEl = document.getElementById('clock-section');
    if (clockEl) clockEl.classList.remove('drag-over');
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
        const rows = _gridRows();
        if (colHeight + span > rows + 1 && !_columnHasRoomFor(span, toCol)) {
            if (getCard(fromId).resizable && span > 1) {
                const small = 1;
                if (colHeight + small > rows + 1) {
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
        if (_anyOverflow()) {
            _restoreLayout(snap);
            showToast('空间不足');
        }
        _syncLayoutFromDom();
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
    // If the swap would overflow any column, revert it instead of shuffling
    // cards across columns (which displaces the other column's cards).
    if (_anyOverflow()) {
        fromEl.style.gridColumn = fromCol;
        fromEl.style.gridRow = fromOrigRow;
        toEl.style.gridColumn = toCol;
        toEl.style.gridRow = toOrigRow;
        _repackColumn(_layoutColFor(parseInt(fromCol)), null, null);
        _repackColumn(_layoutColFor(parseInt(toCol)), null, null);
        showToast('空间不足');
    }
    _syncLayoutFromDom();
}

// Dropping onto empty grid space (not over another card)

let _dropSlotEl = null;

/* Current rendered clock-column width in px. CSS --clock-col scales with
   --font-scale (weather sidebar), so the drop-slot geometry must match. */
function _clockColumnPx(grid, right) {
    if (!grid) return CLOCK_WIDTH;
    const tc = getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean);
    const token = right ? tc[tc.length - 1] : tc[0];
    const px = parseFloat(token);
    return px > 0 ? px : CLOCK_WIDTH;
}

/* Resolve a pointer position to a {col,row} slot inside the card columns, so
   cards can be dropped anywhere in the grid, not just onto another card. */
function _gridSlotFromEvent(e) {
    const grid = document.querySelector('.term-grid');
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const pad = 8, gap = 8;
    const cols = _gridCols();
    const rows = _gridRows();
    const innerW = rect.width - pad * 2;
    const innerH = rect.height - pad * 2;
    // Clock column width may be scaled up with --font-scale (weather sidebar);
    // in top/bottom bar mode there is no clock column at all.
    const right = _clockSide() === 'right';
    const clockW = _clockVertical() ? 0 : _clockColumnPx(grid, right);
    const cardAreaW = innerW - clockW - gap;
    const colW = (cardAreaW - gap * (cols - 1)) / cols;
    if (colW <= 0) return null;
    // The card columns sit on the opposite side of the clock. When the clock is
    // on the right (or rendered as a top/bottom bar), cards start at the grid's
    // left edge.
    const cardLeft = (right || _clockVertical()) ? rect.left + pad : rect.left + pad + clockW + gap;
    let col = null;
    for (let i = 0; i < cols; i++) {
        const l = cardLeft + i * (colW + gap);
        if (e.clientX >= l && e.clientX < l + colW) { col = 2 + i; break; }
    }
    if (!col) return null;
    // `rows` equal rows with `rows - 1` gaps inside the padded area.
    const rowH = (innerH - gap * (rows - 1)) / rows;
    const relY = e.clientY - (rect.top + pad);
    let row = Math.floor(relY / (rowH + gap)) + 1;
    if (row < 1) row = 1;
    if (row > rows) row = rows;
    return { col: col, row: row, rect: rect, cardLeft: cardLeft, colW: colW, rowH: rowH, pad: pad, gap: gap };
}

function _ensureGridChild(prev, className, id) {
    if (prev && prev.isConnected) return prev;
    const el = document.createElement('div');
    el.className = className;
    el.id = id;
    const grid = document.querySelector('.term-grid');
    if (grid) grid.appendChild(el);
    return el;
}

function _ensureDropSlot() {
    _dropSlotEl = _ensureGridChild(_dropSlotEl, 'drop-slot hide', 'layout-drop-slot');
    return _dropSlotEl;
}

function _showDropSlot(slot, span) {
    const el = _ensureDropSlot();
    if (!slot) { el.classList.add('hide'); return; }
    const top = slot.pad + (slot.row - 1) * (slot.rowH + slot.gap);
    const index = slot.col - 2;
    const left = slot.cardLeft + index * (slot.colW + slot.gap);
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
    const rows = _gridRows();
    const targetH = (fromCol === slot.col ? _columnHeight(slot.col) - span : _columnHeight(slot.col));
    if (targetH + span > rows + 1) {
        if (getCard(fromId).resizable && span > 1) {
            if (targetH + 1 > rows + 1) { showToast('空间不足'); return; }
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
    if (_anyOverflow()) {
        _restoreLayout(snap);
        showToast('空间不足');
    }
    _syncLayoutFromDom();
}

/* Dropping the clock (either on the empty grid or onto another card): move it
   to the grid edge nearest to the pointer — left/right keeps the full-height
   column, top/bottom switches to the taskbar-like strip. */
function _handleClockDrop(e) {
    const grid = document.querySelector('.term-grid');
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const dists = [
        ['left', e.clientX - rect.left],
        ['right', rect.right - e.clientX],
        ['top', e.clientY - rect.top],
        ['bottom', rect.bottom - e.clientY],
    ];
    let side = 'left';
    let best = Infinity;
    for (const [name, d] of dists) {
        if (d < best) { best = d; side = name; }
    }
    _syncLayoutFromDom();
    setCardPos('clock-section', { side: side });
    applyLayout(getLayout());
}
