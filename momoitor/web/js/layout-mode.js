// Layout mode: entering/exiting, per-card control overlays (font steppers,
// delete button, resize handle) and the card size / font-scale actions.

let _layoutMode = false;
let _layoutSaved = null;
let _layoutControlsAdded = false;

function enterLayoutMode() {
    if (_layoutMode) return;
    _layoutMode = true;
    _layoutSaved = readLayout();
    const rowsSel = document.getElementById('layout-rows-sel');
    const colsSel = document.getElementById('layout-cols-sel');
    if (rowsSel) rowsSel.value = String(_gridRows());
    if (colsSel) colsSel.value = String(_gridCols());
    document.body.classList.add('layout-mode');
    _addLayoutControls();
    allCards().forEach(card => {
        const el = card.el;
        if (el) bindCardDrag(el);
    });
    const clockEl = document.getElementById('clock-section');
    if (clockEl) bindCardDrag(clockEl);
    const grid = document.querySelector('.term-grid');
    if (grid) {
        grid.addEventListener('dragover', onGridDragOver);
        grid.addEventListener('dragleave', onGridDragLeave);
        grid.addEventListener('drop', onGridDrop);
    }
}

function bindCardDrag(el) {
    if (el.dataset.dragBound) return;
    el.dataset.dragBound = '1';
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', onLayoutDragStart);
    el.addEventListener('dragover', onLayoutDragOver);
    el.addEventListener('dragleave', onLayoutDragLeave);
    el.addEventListener('dragend', onLayoutDragEnd);
    el.addEventListener('drop', onLayoutDrop);
}

function unbindCardDrag(el) {
    delete el.dataset.dragBound;
    el.removeAttribute('draggable');
    el.classList.remove('dragging', 'drag-over');
    el.removeEventListener('dragstart', onLayoutDragStart);
    el.removeEventListener('dragover', onLayoutDragOver);
    el.removeEventListener('dragleave', onLayoutDragLeave);
    el.removeEventListener('dragend', onLayoutDragEnd);
    el.removeEventListener('drop', onLayoutDrop);
}

function exitLayoutMode() {
    if (!_layoutMode) return;
    _layoutMode = false;
    document.body.classList.remove('layout-mode');
    _removeLayoutControls();
    allCards().forEach(card => {
        const el = card.el;
        if (el) unbindCardDrag(el);
    });
    const clockEl = document.getElementById('clock-section');
    if (clockEl) unbindCardDrag(clockEl);
    const grid = document.querySelector('.term-grid');
    if (grid) {
        grid.removeEventListener('dragover', onGridDragOver);
        grid.removeEventListener('dragleave', onGridDragLeave);
        grid.removeEventListener('drop', onGridDrop);
    }
    const slot = document.getElementById('layout-drop-slot');
    if (slot) slot.remove();
}

function _addLayoutControls() {
    if (_layoutControlsAdded) return;
    _layoutControlsAdded = true;
    layoutCards().forEach(card => {
        const el = card.el;
        const id = card.id;
        if (!el) return;
        _addCardLayoutControls(id);
    });
    const clockEl = document.getElementById('clock-section');
    if (clockEl) {
        const group = document.createElement('div');
        group.className = 'layout-control-group';
        const fontGroup = _createLayoutFontGroup('clock-section');
        group.appendChild(fontGroup);
        group._fontVal = fontGroup._fontVal;
        group._cardId = 'clock-section';
        clockEl.appendChild(group);
        if (!clockEl.querySelector('.layout-clock-resize')) {
            const handle = document.createElement('div');
            handle.className = 'layout-clock-resize';
            handle.setAttribute('draggable', 'false');
            handle.addEventListener('pointerdown', _clockResizeDown);
            clockEl.appendChild(handle);
        }
    }
    _updateCardsBtn();
}

/* Add the layout-mode control overlay (font stepper + delete) and the
   click-to-edit binding for one card. Idempotent: a card that already has its
   control group is left untouched, so a card added while layout mode is already
   active gets the same controls as ones that existed on entry. */
function _addCardLayoutControls(id) {
    const el = getCard(id).el;
    if (!el) return;
    if (el.querySelector('.layout-control-group')) return;
    const group = document.createElement('div');
    group.className = 'layout-control-group';
    const fontGroup = _createLayoutFontGroup(id);
    group.appendChild(fontGroup);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'layout-del-btn';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', function(e) { e.stopPropagation(); _deleteCard(id); });
    group.appendChild(delBtn);
    group._fontVal = fontGroup._fontVal;
    group._cardId = id;
    el.appendChild(group);
    if (getCard(id).resizable) {
        const handle = document.createElement('div');
        handle.className = 'layout-resize-handle';
        handle.setAttribute('data-card', id);
        handle.setAttribute('draggable', 'false');
        handle.addEventListener('pointerdown', function(e) { _resizeHandleDown(e, id); });
        el.appendChild(handle);
    }
    if ((id === 'text-section' || isCustomCard(id)) && !el.dataset.ceBound) {
        el.dataset.ceBound = '1';
        el.addEventListener('click', function(e) {
            if (!_layoutMode) return;
            if (e.target.closest('.layout-control-group') || e.target.closest('.layout-resize-handle')) return;
            openCardEditor(id);
        });
    }
}

/* Build the A- / value% / A+ font-size stepper for a card (or the clock). */
function _createLayoutFontGroup(id) {
    const fontGroup = document.createElement('div');
    fontGroup.className = 'layout-font-group';
    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'layout-font-btn';
    minusBtn.textContent = 'A-';
    minusBtn.addEventListener('click', function(e) { e.stopPropagation(); _adjustCardFontScale(id, -5); });
    const fontVal = document.createElement('span');
    fontVal.className = 'layout-font-val';
    fontVal.textContent = (id === 'clock-section' ? getClockFontScale() : getCardFontScale(id)) + '%';
    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'layout-font-btn';
    plusBtn.textContent = 'A+';
    plusBtn.addEventListener('click', function(e) { e.stopPropagation(); _adjustCardFontScale(id, 5); });
    fontGroup.appendChild(minusBtn);
    fontGroup.appendChild(fontVal);
    fontGroup.appendChild(plusBtn);
    fontGroup._fontVal = fontVal;
    return fontGroup;
}

function _removeLayoutControls() {
    _layoutControlsAdded = false;
    document.querySelectorAll('.layout-control-group').forEach(el => el.remove());
    document.querySelectorAll('.layout-resize-handle').forEach(el => el.remove());
    document.querySelectorAll('.layout-clock-resize').forEach(el => el.remove());
    document.body.classList.remove('resizing');
    const clockEl = document.getElementById('clock-section');
    if (clockEl) clockEl.classList.remove('resizing');
    window.removeEventListener('pointermove', _clockResizeMove);
    window.removeEventListener('pointerup', _clockResizeUp);
    window.removeEventListener('pointermove', _resizeHandleMove);
    window.removeEventListener('pointerup', _resizeHandleUp);
    _clockResizing = null;
    _resizingCard = null;
    _resizeDelta = 0;
    const cardsBtn = document.getElementById('layout-cards');
    if (cardsBtn) cardsBtn.classList.add('hidden');
    const panel = document.getElementById('card-list-panel');
    if (panel) panel.style.display = 'none';
}

function _toggleCardSize(id) {
    const pos = _normLayout(id);
    const el = getCard(id).el;
    const first = el ? el.getBoundingClientRect() : null;
    const curRow = el && el.style.gridRow ? (parseInt(el.style.gridRow) || pos.row) : pos.row;
    const curCol = el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col;
    if (pos.span === 1) {
        const colHeight = _columnHeight(curCol);
        const rows = _gridRows();
        if (colHeight + 1 > rows + 1 && !_columnHasRoomFor(1, curCol)) {
            showToast('空间不足');
            return;
        }
    }
    const snap = _snapshotLayout();
    pos.span = pos.span === 2 ? 1 : 2;
    setCardPos(id, { col: curCol, row: curRow, span: pos.span, hidden: pos.hidden });
    if (el) {
        el.style.transition = 'none';
        el.style.gridRow = curRow + ' / span ' + pos.span;
        el.dataset.span = String(pos.span);
        if (id === 'fps-section') _applyFpsSpan(el, pos.span);
    }
    _repackColumn(curCol, id, curRow);
    if (!_rebalanceOverflow()) {
        _restoreLayout(snap);
        showToast('空间不足');
        return;
    }
    if (id === 'music-section') applyLyricView();
    if (el && first) _flipCard(el, first);
}

/* FLIP morph: smoothly animate a card between its previous and new size/position
   after the layout change, instead of snapping. Other cards still glide via the
   existing grid-row transition. */
function _flipCard(el, first) {
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const scaleX = first.width / last.width;
    const scaleY = first.height / last.height;
    el.style.transition = 'none';
    el.style.transformOrigin = 'top left';
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scaleX + ',' + scaleY + ')';
    void el.offsetWidth;
    el.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
    el.style.transform = '';
    const done = () => {
        el.style.transition = '';
        el.style.transform = '';
        el.style.transformOrigin = '';
    };
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 450);
}

function _deleteCard(id) {
    if (isCustomCard(id)) {
        deleteCustomCard(id);
        return;
    }
    const pos = _normLayout(id);
    const el = getCard(id).el;
    const col = el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col;
    pos.hidden = true;
    setCardPos(id, { col: col, row: pos.row, span: pos.span, hidden: true });
    if (el) el.style.display = 'none';
    _repackColumn(col, null, null);
    _rebalanceOverflow();
    _updateCardsBtn();
}

/* Adjust a card's font scale by a step (e.g. +/-10) and live-apply it. The
   stepper buttons live in the layout-mode control group. The clock column is
   handled the same way even though it isn't a registered card. */
function _adjustCardFontScale(id, step) {
    const isClock = id === 'clock-section';
    let fs = (isClock ? getClockFontScale() : getCardFontScale(id)) + step;
    fs = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, fs));
    setCardPos(id, { font_scale: fs });
    if (isClock) applyClockFontScale(); else applyCardFontScale(id);
    const groups = document.querySelectorAll('.layout-control-group');
    for (const g of groups) {
        if (g._cardId === id && g._fontVal) g._fontVal.textContent = fs + '%';
    }
}

// Resize handle drag (toggle card size)
let _resizingCard = null;
let _resizeDelta = 0;

function _resizeHandleDown(e, id) {
    e.preventDefault();
    e.stopPropagation();
    if (!_resizingCard) {
        _resizingCard = id;
        _resizeDelta = 0;
        document.body.classList.add('resizing');
        const el = getCard(id).el;
        if (el) el.classList.add('resizing');
        window.addEventListener('pointermove', _resizeHandleMove);
        window.addEventListener('pointerup', _resizeHandleUp);
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
}

function _resizeHandleMove(e) {
    if (!_resizingCard) return;
    _resizeDelta += e.movementY || 0;
    const threshold = 25;
    const pos = _normLayout(_resizingCard);
    if (pos.span === 1 && _resizeDelta > threshold) {
        _toggleCardSize(_resizingCard);
        _resizeDelta = 0;
    } else if (pos.span === 2 && _resizeDelta < -threshold) {
        _toggleCardSize(_resizingCard);
        _resizeDelta = 0;
    }
}

function _resizeHandleUp() {
    const id = _resizingCard;
    if (!id) return;
    _resizingCard = null;
    _resizeDelta = 0;
    document.body.classList.remove('resizing');
    const el = getCard(id).el;
    if (el) el.classList.remove('resizing');
    window.removeEventListener('pointermove', _resizeHandleMove);
    window.removeEventListener('pointerup', _resizeHandleUp);
}

// Clock column width drag handle (horizontal resize in layout mode). Dragging
// right widens the clock column (left of the grid) or narrows it when the clock
// sits on the right, keeping the cards at a stable width.
let _clockResizing = null;
let _clockResizeDelta = 0;

function _clockResizeDown(e) {
    e.preventDefault();
    e.stopPropagation();
    if (_clockResizing || _clockVertical()) return;  // no width drag in bar mode
    const grid = document.querySelector('.term-grid');
    const right = _clockSide() === 'right';
    _clockResizing = { startW: _clockColumnPx(grid, right), right: right };
    _clockResizeDelta = 0;
    document.body.classList.add('resizing');
    const el = document.getElementById('clock-section');
    if (el) el.classList.add('resizing');
    window.addEventListener('pointermove', _clockResizeMove);
    window.addEventListener('pointerup', _clockResizeUp);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
}

function _clockResizeMove(e) {
    if (!_clockResizing) return;
    _clockResizeDelta += e.movementX || 0;
    const delta = _clockResizing.right ? -_clockResizeDelta : _clockResizeDelta;
    const w = Math.max(CLOCK_WIDTH_MIN, Math.min(CLOCK_WIDTH_MAX, _clockResizing.startW + delta));
    const grid = document.querySelector('.term-grid');
    if (grid) grid.style.setProperty('--clock-col', w + 'px');
    _clockResizing.w = w;
}

function _clockResizeUp() {
    if (!_clockResizing) return;
    const info = _clockResizing;
    _clockResizing = null;
    _clockResizeDelta = 0;
    document.body.classList.remove('resizing');
    const el = document.getElementById('clock-section');
    if (el) el.classList.remove('resizing');
    window.removeEventListener('pointermove', _clockResizeMove);
    window.removeEventListener('pointerup', _clockResizeUp);
    if (info.w) {
        setCardPos('clock-section', { width: info.w });
        applyLayout(getLayout());
    }
}
