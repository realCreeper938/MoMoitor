/* ===== Layout Adjustment ===== */
const LAYOUT_IDS = ['cpu-section', 'gpu-section', 'mem-section', 'net-section', 'fps-section', 'disk-section', 'proc-section', 'music-section', 'weather-section', 'text-section'];
const RESIZABLE_IDS = ['cpu-section', 'gpu-section', 'mem-section', 'net-section', 'fps-section', 'music-section', 'weather-section', 'text-section'];
/* Everything draggable during layout mode — cards plus the full-height clock. */
const DRAG_IDS = LAYOUT_IDS.concat(['clock-section']);

const DEFAULT_LAYOUT = {
    'clock-section':  { side: 'left' },
    'cpu-section':    { col: 2, row: 2, span: 2, hidden: false },
    'gpu-section':    { col: 3, row: 2, span: 2, hidden: false },
    'mem-section':    { col: 2, row: 4, span: 1, hidden: false },
    'disk-section':   { col: 3, row: 1, span: 1, hidden: false },
    'net-section':    { col: 2, row: 1, span: 1, hidden: false },
    'fps-section':    { col: 3, row: 4, span: 1, hidden: false },
    'proc-section':   { col: 3, row: 5, span: 1, hidden: false },
    'music-section':  { col: 2, row: 5, span: 1, hidden: false },
    'weather-section': { col: 2, row: 1, span: 1, hidden: true },
    'text-section':   { col: 3, row: 1, span: 1, hidden: true },
};

let _layout = {};

function _normLayout(id) {
    const saved = _layout[id] || {};
    const def = DEFAULT_LAYOUT[id];
    return {
        col: saved.col || def.col,
        row: saved.row || def.row,
        span: saved.span != null ? saved.span : def.span,
        hidden: saved.hidden === true,
    };
}

function getLayoutSpan(id) {
    return _normLayout(id).span;
}

/* Which side the clock column sits on (cards use abstract cols 2/3; the clock
   is always full-height). 'right' flips the grid so the clock is at col 3. */
function _clockSide() {
    const c = _layout['clock-section'];
    return c && c.side === 'right' ? 'right' : 'left';
}

/* Abstract layout col (1=clock, 2=left cards, 3=right cards) → actual grid col. */
function _gridColFor(col) {
    if (_clockSide() === 'right') {
        if (col === 2) return 1;
        if (col === 3) return 2;
    }
    return col;
}

/* Actual grid col → abstract layout col. */
function _layoutColFor(col) {
    if (_clockSide() === 'right') {
        if (col === 1) return 2;
        if (col === 2) return 3;
    }
    return col;
}

function applyLayout(layout) {
    _layout = Object.assign({}, layout && typeof layout === 'object' ? layout : {});
    LAYOUT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const pos = _normLayout(id);
        el.style.gridColumn = String(_gridColFor(pos.col));
        el.style.gridRow = pos.row + ' / span ' + pos.span;
        el.style.display = _sectionVisible(id) ? '' : 'none';
        el.dataset.span = String(pos.span);
        if (id === 'fps-section') _applyFpsSpan(el, pos.span);
    });
    const grid = document.querySelector('.term-grid');
    if (grid) grid.classList.toggle('clock-right', _clockSide() === 'right');
    const clockEl = document.getElementById('clock-section');
    if (clockEl) clockEl.style.gridColumn = _clockSide() === 'right' ? '3' : '1';
    if (_layoutMode) _positionClockHint();
    applyLyricView();
}

function readLayout() {
    const layout = {};
    LAYOUT_IDS.forEach(id => {
        const el = document.getElementById(id);
        const pos = _normLayout(id);
        layout[id] = {
            col: el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col,
            row: el && el.style.gridRow ? parseInt(el.style.gridRow) || pos.row : pos.row,
            span: pos.span,
            hidden: pos.hidden,
        };
    });
    layout['clock-section'] = { side: _clockSide() };
    return layout;
}

function _colCards(col) {
    return LAYOUT_IDS
        .map(id => document.getElementById(id))
        .filter(el => el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col))
        .sort((a, b) => parseInt(a.style.gridRow) - parseInt(b.style.gridRow));
}

let _layoutMode = false;
let _layoutSaved = null;
let _layoutControlsAdded = false;

function enterLayoutMode() {
    if (_layoutMode) return;
    _layoutMode = true;
    _layoutSaved = readLayout();
    document.body.classList.add('layout-mode');
    _addLayoutControls();
    DRAG_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('draggable', 'true');
        el.addEventListener('dragstart', onLayoutDragStart);
        el.addEventListener('dragover', onLayoutDragOver);
        el.addEventListener('dragleave', onLayoutDragLeave);
        el.addEventListener('dragend', onLayoutDragEnd);
        el.addEventListener('drop', onLayoutDrop);
    });
    const grid = document.querySelector('.term-grid');
    if (grid) {
        grid.addEventListener('dragover', onGridDragOver);
        grid.addEventListener('dragleave', onGridDragLeave);
        grid.addEventListener('drop', onGridDrop);
    }
    _positionClockHint();
}

function exitLayoutMode() {
    if (!_layoutMode) return;
    _layoutMode = false;
    _hideClockHint();
    document.body.classList.remove('layout-mode');
    _removeLayoutControls();
    DRAG_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.removeAttribute('draggable');
        el.classList.remove('dragging', 'drag-over');
        el.removeEventListener('dragstart', onLayoutDragStart);
        el.removeEventListener('dragover', onLayoutDragOver);
        el.removeEventListener('dragleave', onLayoutDragLeave);
        el.removeEventListener('dragend', onLayoutDragEnd);
        el.removeEventListener('drop', onLayoutDrop);
    });
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
    LAYOUT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const group = document.createElement('div');
        group.className = 'layout-control-group';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'layout-del-btn';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', function(e) { e.stopPropagation(); _deleteCard(id); });
        group.appendChild(delBtn);
        el.appendChild(group);
        if (RESIZABLE_IDS.includes(id)) {
            const handle = document.createElement('div');
            handle.className = 'layout-resize-handle';
            handle.setAttribute('data-card', id);
            handle.setAttribute('draggable', 'false');
            handle.addEventListener('pointerdown', function(e) { _resizeHandleDown(e, id); });
            el.appendChild(handle);
        }
        if (id === 'text-section' && !el.dataset.ceBound) {
            el.dataset.ceBound = '1';
            el.addEventListener('click', function(e) {
                if (!_layoutMode) return;
                if (e.target.closest('.layout-control-group') || e.target.closest('.layout-resize-handle')) return;
                openTextEditor(id);
            });
        }
    });
    _updateCardsBtn();
}

function _removeLayoutControls() {
    _layoutControlsAdded = false;
    document.querySelectorAll('.layout-control-group').forEach(el => el.remove());
    document.querySelectorAll('.layout-resize-handle').forEach(el => el.remove());
    document.body.classList.remove('resizing');
    const cardsBtn = document.getElementById('layout-cards');
    if (cardsBtn) cardsBtn.classList.add('hidden');
    const panel = document.getElementById('card-list-panel');
    if (panel) panel.style.display = 'none';
}

function _toggleCardSize(id) {
    const pos = _normLayout(id);
    const el = document.getElementById(id);
    const first = el ? el.getBoundingClientRect() : null;
    const curRow = el && el.style.gridRow ? (parseInt(el.style.gridRow) || pos.row) : pos.row;
    const curCol = el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col;
    if (pos.span === 1) {
        const colHeight = _columnHeight(curCol);
        const otherCol = curCol === 2 ? 3 : 2;
        const otherHeight = _columnHeight(otherCol);
        const selfHeight = 1;
        const newColHeight = colHeight - selfHeight + 2;
        if (newColHeight > 6 && otherHeight + 1 > 6) {
            showToast('空间不足');
            return;
        }
    }
    const snap = _snapshotLayout();
    pos.span = pos.span === 2 ? 1 : 2;
    _layout[id] = { col: curCol, row: curRow, span: pos.span, hidden: pos.hidden };
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
    const pos = _normLayout(id);
    const el = document.getElementById(id);
    const col = el && el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col;
    pos.hidden = true;
    _layout[id] = { col: col, row: pos.row, span: pos.span, hidden: true };
    if (el) el.style.display = 'none';
    _repackColumn(col, null, null);
    _rebalanceOverflow();
    _updateCardsBtn();
}

/* ---- Resize handle drag (toggle card size) ---- */
let _resizingCard = null;
let _resizeDelta = 0;

function _resizeHandleDown(e, id) {
    e.preventDefault();
    e.stopPropagation();
    if (!_resizingCard) {
        _resizingCard = id;
        _resizeDelta = 0;
        document.body.classList.add('resizing');
        const el = document.getElementById(id);
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
    const el = document.getElementById(id);
    if (el) el.classList.remove('resizing');
    window.removeEventListener('pointermove', _resizeHandleMove);
    window.removeEventListener('pointerup', _resizeHandleUp);
}

/* Card metadata used by the card list: display name, accent color, and a
   small mock of the card's content so the user can preview its style. */
const CARD_META = {
    'cpu-section': {
        name: 'CPU', color: 'var(--cyan)',
        value: '88', pct: '%',
        lines: [['4200', 'MHz', '65', '°C'], ['120', 'W', '1.3', 'V']],
    },
    'gpu-section': {
        name: 'GPU', color: 'var(--accent)',
        value: '76', pct: '%',
        lines: [['68', '°C', '180', 'W'], ['11.2', '/12 GB', '64', '°C']],
    },
    'mem-section': {
        name: 'Memory', color: 'var(--magenta)',
        value: '54', pct: '%',
        lines: [['3600', 'MHz', '1.1', 'V'], ['8.6', '/16 GB', '45', '°C']],
    },
    'net-section': {
        name: 'Network', color: 'var(--green)', type: 'duo',
        duo: [['↓', '12.3', 'MB/s'], ['↑', '4.5', 'MB/s']],
    },
    'fps-section': {
        name: 'FPS', color: 'var(--yellow)',
        value: '144', pct: 'FPS',
        lines: [['6.9', 'ms', '1% 118', ''], ['AVG 141', '', '99% 137', '']],
    },
    'disk-section': {
        name: 'Disk', color: 'var(--blue)', type: 'duo',
        duo: [['R', '120', 'MB/s'], ['W', '45', 'MB/s']],
    },
    'proc-section': { name: 'Process', color: 'var(--text-dim)', type: 'proc' },
    'music-section': { name: 'Music', color: 'var(--accent)', type: 'music' },
    'weather-section': { name: 'Weather', color: 'var(--orange)', type: 'weather' },
    'text-section': { name: 'Text', color: 'var(--accent)', type: 'text' },
};

function _cardPreviewHTML(id) {
    const m = CARD_META[id];
    if (!m) return '';
    if (m.type === 'proc') {
        return '<div class="clp-proc">'
            + '<div class="clp-proc-bar"><i style="width:72%"></i></div>'
            + '<div class="clp-proc-bar"><i style="width:46%"></i></div>'
            + '<div class="clp-proc-bar"><i style="width:28%"></i></div>'
            + '</div>';
    }
    if (m.type === 'music') {
        return '<div class="clp-music"><span class="clp-cover"></span>'
            + '<div class="clp-music-meta"><div class="clp-title">Title</div>'
            + '<div class="clp-artist">Artist</div></div></div>';
    }
    if (m.type === 'weather') {
        return '<div class="clp-weather"><span class="clp-weather-icon">&#xF0590;</span>'
            + '<div class="clp-weather-main"><div class="clp-title">23&deg;C</div>'
            + '<div class="clp-artist">Sunny</div></div></div>';
    }
    if (m.type === 'duo') {
        return m.duo.map(r =>
            '<div class="clp-duo"><span class="clp-arrow">' + r[0] + '</span>'
            + '<span class="clp-value">' + r[1] + '</span>'
            + '<span class="clp-unit">' + r[2] + '</span></div>').join('');
    }
    if (m.type === 'text') {
        const cfg = _customTextCfg('text-section');
        const inner = escapeHtml(cfg.text || '');
        return '<div class="clp-text" style="text-align:' + (cfg.align || 'left') + '">'
            + (inner ? '<span class="clp-text-lines">' + inner + '</span>'
                : '<span class="clp-text-empty">Aa</span>')
            + '</div>';
    }
    return '<div class="clp-value-row"><span class="clp-value">' + m.value
        + '</span><span class="clp-pct">' + m.pct + '</span></div>'
        + m.lines.map(l =>
            '<div class="clp-info"><span class="mono">' + l[0] + '</span>'
            + (l[1] ? '<span class="clp-unit">' + l[1] + '</span>' : '')
            + (l[2] ? '<span class="clp-sep"> · </span><span class="mono">' + l[2] + '</span>' : '')
            + (l[3] ? '<span class="clp-unit">' + l[3] + '</span>' : '')
            + '</div>').join('');
}

function _renderCardList() {
    const body = document.getElementById('card-list-body');
    if (!body) return;
    body.textContent = '';
    const hidden = LAYOUT_IDS.filter(id => _normLayout(id).hidden);
    hidden.forEach(id => {
        const meta = CARD_META[id] || { name: id, color: 'var(--text)' };
        const item = document.createElement('div');
        item.className = 'card-list-item';
        item.dataset.card = id;
        item.setAttribute('draggable', 'true');
        const sizes = _cardSizesHTML(id);
        item.innerHTML = '<div class="card-list-preview" style="--card-accent:' + meta.color + '">'
            + _cardPreviewHTML(id) + '</div>'
            + '<div class="card-list-name">' + meta.name + sizes + '</div>';
        item.addEventListener('click', () => _addCard(id));
        item.addEventListener('dragstart', onLayoutDragStart);
        item.addEventListener('dragend', onLayoutDragEnd);
        body.appendChild(item);
    });
    if (!hidden.length) {
        const panel = document.getElementById('card-list-panel');
        if (panel) panel.style.display = 'none';
    }
}

/* Cards that support both sizes (RESIZABLE_IDS) list their options next to the
   name, e.g. "CPU 1x1 · 1x2".  Non-resizable cards have a single fixed size. */
function _cardSizesHTML(id) {
    if (!RESIZABLE_IDS.includes(id)) return '';
    const sizes = [1, 2].map(s => '1x' + s);
    return '<span class="card-list-sizes">' + sizes.join(' · ') + '</span>';
}

function _updateCardsBtn() {
    const cardsBtn = document.getElementById('layout-cards');
    if (!cardsBtn) return;
    const hasHidden = LAYOUT_IDS.some(id => _normLayout(id).hidden);
    cardsBtn.classList.toggle('hidden', !hasHidden);
    const panel = document.getElementById('card-list-panel');
    if (panel && panel.style.display === 'flex') _renderCardList();
}

/* Place a previously-hidden card into the grid at the given column/row, then
   compact the column and rebalance overflow.  If `span` is omitted, the card's
   layout span is used. */
function _placeCard(id, col, row, span) {
    const pos = _normLayout(id);
    const s = span || pos.span;
    pos.col = col;
    pos.row = row;
    pos.span = s;
    pos.hidden = false;
    _layout[id] = { col: col, row: row, span: s, hidden: false };
    const el = document.getElementById(id);
    if (el) {
        el.style.display = _sectionVisible(id) ? '' : 'none';
        el.style.gridColumn = String(_gridColFor(col));
        el.style.gridRow = row + ' / span ' + s;
        el.dataset.span = String(s);
        if (id === 'fps-section') _applyFpsSpan(el, s);
        if (id === 'weather-section') refreshWeatherCard();
        if (id === 'text-section') applyCustomText(id);
    }
    _repackColumn(col, id, row);
    _rebalanceOverflow();
    _updateCardsBtn();
}

/* Click a card in the list: add it to whichever column still has room.
   If the card supports both sizes (RESIZABLE_IDS) and the remaining space only
   fits the small card, fall back to the small (span 1) form automatically. */
function _addCard(id) {
    const span = _normLayout(id).span;
    const h2 = _columnHeight(2);
    const h3 = _columnHeight(3);
    const free2 = 6 - h2;
    const free3 = 6 - h3;
    let col = null;
    if (free2 >= span) col = 2;
    if (free3 >= span && (col === null || free3 > free2)) col = 3;
    if (col === null && RESIZABLE_IDS.includes(id) && span > 1) {
        const small = 1;
        if (free2 >= small) col = 2;
        if (free3 >= small && (col === null || free3 > free2)) col = 3;
        if (col !== null) { _placeCard(id, col, _columnHeight(col) + 1, small); return; }
    }
    if (col === null) { showToast('空间不足'); return; }
    _placeCard(id, col, _columnHeight(col) + 1);
}

/* ===== Custom text card ===== */

function _customTextCfg(id) {
    const defaults = { text: '', font: '', bold: false, italic: false, size: 18, align: 'left', color: '' };
    const stored = ((window._appSettings || {}).custom_text || {})[id] || {};
    return Object.assign({}, defaults, stored);
}

function applyCustomText(id, cfgOverride) {
    const el = document.getElementById('custom-text-el');
    if (!el) return;
    const cfg = cfgOverride || _customTextCfg(id);
    const empty = !cfg.text;
    el.textContent = empty ? t('text-edit-hint') : cfg.text;
    el.classList.toggle('empty', empty);
    el.style.fontFamily = cfg.font ? '"' + cfg.font + '"' : '';
    el.style.fontWeight = cfg.bold ? '700' : '400';
    el.style.fontStyle = cfg.italic ? 'italic' : 'normal';
    el.style.fontSize = (cfg.size || 18) + 'px';
    el.style.textAlign = cfg.align || 'left';
    el.style.color = (!empty && cfg.color) ? cfg.color : '';
}

/* ---- Editor panel ---- */
let _ceEditId = 'text-section';
let _ceAlign = 'left';
let _ceColor = '';

function openTextEditor(id) {
    _ceEditId = id;
    const cfg = _customTextCfg(id);
    _ceAlign = cfg.align || 'left';
    _ceColor = cfg.color || '';
    const panel = document.getElementById('card-edit-panel');
    if (!panel) return;
    const textEl = document.getElementById('ce-text');
    const fontEl = document.getElementById('ce-font');
    const boldEl = document.getElementById('ce-bold');
    const italicEl = document.getElementById('ce-italic');
    const sizeEl = document.getElementById('ce-size');
    const colorEl = document.getElementById('ce-color');
    if (textEl) textEl.value = cfg.text;
    if (fontEl) fontEl.value = cfg.font;
    if (boldEl) boldEl.checked = !!cfg.bold;
    if (italicEl) italicEl.checked = !!cfg.italic;
    if (sizeEl) sizeEl.value = cfg.size;
    if (colorEl) colorEl.value = cfg.color || '#e8e8e8';
    const btns = document.querySelectorAll('#ce-align button');
    btns.forEach(b => b.classList.toggle('active', b.dataset.align === _ceAlign));
    panel.style.display = 'flex';
    if (textEl) textEl.focus();
}

function closeTextEditor() {
    hideOverlay('card-edit-panel');
}

function readTextEditorForm() {
    const textEl = document.getElementById('ce-text');
    const fontEl = document.getElementById('ce-font');
    const boldEl = document.getElementById('ce-bold');
    const italicEl = document.getElementById('ce-italic');
    const sizeEl = document.getElementById('ce-size');
    return {
        text: textEl ? textEl.value : '',
        font: fontEl ? fontEl.value.trim() : '',
        bold: boldEl ? boldEl.checked : false,
        italic: italicEl ? italicEl.checked : false,
        size: parseInt(sizeEl ? sizeEl.value : '18', 10) || 18,
        align: _ceAlign,
        color: _ceColor,
    };
}

function previewTextCard() {
    applyCustomText(_ceEditId, readTextEditorForm());
}

async function saveTextCard() {
    const cfg = readTextEditorForm();
    window._appSettings = window._appSettings || {};
    window._appSettings.custom_text = window._appSettings.custom_text || {};
    window._appSettings.custom_text[_ceEditId] = cfg;
    applyCustomText(_ceEditId, cfg);
    closeTextEditor();
    try { await pywebview.api.save_settings(window._appSettings); } catch (e) { console.warn('save custom text:', e); }
}

function initTextCardEditor() {
    const closeBtn = document.getElementById('card-edit-close');
    if (closeBtn) closeBtn.addEventListener('click', closeTextEditor);
    const saveBtn = document.getElementById('card-edit-save');
    if (saveBtn) saveBtn.addEventListener('click', saveTextCard);
    const cancelBtn = document.getElementById('card-edit-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeTextEditor);
    const alignBox = document.getElementById('ce-align');
    if (alignBox) alignBox.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-align]');
        if (!b) return;
        _ceAlign = b.dataset.align;
        alignBox.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        previewTextCard();
    });
    ['ce-text', 'ce-font', 'ce-bold', 'ce-italic', 'ce-size'].forEach(function(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', previewTextCard);
        el.addEventListener('change', previewTextCard);
    });
    const colorEl = document.getElementById('ce-color');
    if (colorEl) {
        colorEl.addEventListener('input', () => {
            _ceColor = colorEl.value;
            previewTextCard();
        });
    }
    const colorResetBtn = document.getElementById('ce-color-reset');
    if (colorResetBtn) {
        colorResetBtn.addEventListener('click', () => {
            _ceColor = '';
            if (colorEl) colorEl.value = '#e8e8e8';
            previewTextCard();
        });
    }
    const panel = document.getElementById('card-edit-panel');
    if (panel) panel.addEventListener('click', (e) => { e.stopPropagation(); });
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
    DRAG_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('drag-over');
    });
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
        const otherHeight = _columnHeight(toCol === 2 ? 3 : 2);
        if (colHeight + span > 6 && otherHeight + span > 6) {
            if (RESIZABLE_IDS.includes(fromId) && span > 1) {
                const small = 1;
                if (colHeight + small > 6 && otherHeight + small > 6) {
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
        if (_columnHeight(2) > 6 || _columnHeight(3) > 6) {
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
    // If the swap would overflow either column, revert it instead of shuffling
    // cards across columns (which displaces the other column's cards).
    if (_columnHeight(2) > 6 || _columnHeight(3) > 6) {
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

/* ---- Dropping onto empty grid space (not over another card) ---- */

let _dropSlotEl = null;

/* Resolve a pointer position to a {col,row} slot inside the two card columns,
   so cards can be dropped anywhere in the grid, not just onto another card. */
function _gridSlotFromEvent(e) {
    const grid = document.querySelector('.term-grid');
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const pad = 8, gap = 8, clockW = 150;
    const innerW = rect.width - pad * 2;
    const innerH = rect.height - pad * 2;
    const colW = (innerW - clockW - gap * 2) / 2;
    if (colW <= 0) return null;
    // The two card columns sit on the opposite side of the clock. When the
    // clock is on the right, the card area starts at the grid's left edge.
    const right = _clockSide() === 'right';
    const cardLeft = right ? rect.left + pad : rect.left + pad + clockW + gap;
    const cardRight = right ? rect.right - pad - clockW - gap : rect.right - pad;
    const c2Left = cardLeft;
    const c2Right = c2Left + colW;
    let col = null;
    if (e.clientX >= c2Left && e.clientX < c2Right) col = 2;
    else if (e.clientX >= c2Right + gap && e.clientX <= cardRight) col = 3;
    if (!col) return null;
    // 5 equal rows with 4 gaps inside the padded area.
    const rowH = (innerH - gap * 4) / 5;
    const relY = e.clientY - (rect.top + pad);
    let row = Math.floor(relY / (rowH + gap)) + 1;
    if (row < 1) row = 1;
    if (row > 5) row = 5;
    return { col: col, row: row, rect: rect, c2Left: c2Left, colW: colW, rowH: rowH, pad: pad, gap: gap };
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
    const left = _clockSide() === 'right'
        ? (slot.col === 2 ? slot.pad : slot.pad + slot.colW + slot.gap)
        : (slot.col === 2 ? slot.pad + 150 + slot.gap : slot.pad + 150 + slot.gap + slot.colW + slot.gap);
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

let _clockHintEl = null;

function _ensureClockHint() {
    _clockHintEl = _ensureGridChild(_clockHintEl, 'clock-drag-hint', 'clock-drag-hint');
    return _clockHintEl;
}

/* Layout-mode bubble above the clock's date line: "拖曳时钟可调整位置".
   Kept inside the window (grid starts at the window top, so a bubble floating
   above the whole clock would overflow). Anchors to the date and clamps. */
function _positionClockHint() {
    const el = _ensureClockHint();
    const grid = document.querySelector('.term-grid');
    const clockEl = document.getElementById('clock-section');
    const dateEl = document.getElementById('h-clock-date');
    if (!grid || !clockEl || !dateEl) return;
    el.textContent = t('layout-hint-clock');
    el.classList.add('show');
    const gRect = grid.getBoundingClientRect();
    const cRect = clockEl.getBoundingClientRect();
    const dRect = dateEl.getBoundingClientRect();
    const left = Math.max(gRect.width / 2, Math.min(gRect.width - el.offsetWidth / 2, cRect.left - gRect.left + cRect.width / 2));
    const desiredBottom = dRect.top - gRect.top - 5;
    const visualTop = Math.max(4, desiredBottom - el.offsetHeight);
    el.style.left = left + 'px';
    el.style.top = (visualTop + el.offsetHeight) + 'px';
}

function _hideClockHint() {
    if (_clockHintEl) _clockHintEl.classList.remove('show');
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
    const targetH = (fromCol === slot.col ? _columnHeight(slot.col) - span : _columnHeight(slot.col));
    if (targetH + span > 6) {
        if (RESIZABLE_IDS.includes(fromId) && span > 1) {
            if (targetH + 1 > 6) { showToast('空间不足'); return; }
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
    if (_columnHeight(2) > 6 || _columnHeight(3) > 6) {
        _restoreLayout(snap);
        showToast('空间不足');
    }
    _syncLayoutFromDom();
}

/* Dropping the clock (either on the empty grid or onto another card): move the
   whole clock column to whichever half of the grid the pointer is over. */
function _handleClockDrop(e) {
    const grid = document.querySelector('.term-grid');
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
    _syncLayoutFromDom();
    _layout['clock-section'] = { side: side };
    applyLayout(_layout);
}

/* Rebuild _layout from the current DOM (gridColumn/gridRow set by swaps,
   rebalances and repacks). Keeps _layout in sync so applyLayout() (e.g. the
   clock flip) does not revert prior drag/rebalance moves. */
function _syncLayoutFromDom() {
    LAYOUT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const pos = _normLayout(id);
        _layout[id] = {
            col: el.style.gridColumn ? _layoutColFor(parseInt(el.style.gridColumn) || pos.col) : pos.col,
            row: el.style.gridRow ? parseInt(el.style.gridRow) || pos.row : pos.row,
            span: pos.span,
            hidden: pos.hidden,
        };
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

function _packColumn(col) {
    const els = _colCards(col);
    let nextRow = 1;
    els.forEach(function(el) {
        el.style.gridRow = nextRow + ' / span ' + getLayoutSpan(el.id);
        nextRow = parseInt(el.style.gridRow) + getLayoutSpan(el.id);
    });
}

function _columnHeight(col) {
    let maxEnd = 0;
    LAYOUT_IDS.forEach(function(id) {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col)) {
            const end = parseInt(el.style.gridRow) + getLayoutSpan(id);
            if (end > maxEnd) maxEnd = end;
        }
    });
    return maxEnd;
}

/* The bottom-most (largest row) visible card in a column, if any. */
function _bottomCardId(col) {
    let bottomId = null;
    let bottomRow = -1;
    LAYOUT_IDS.forEach(function(id) {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none' && parseInt(el.style.gridColumn) === _gridColFor(col)) {
            const row = parseInt(el.style.gridRow);
            if (row > bottomRow) {
                bottomRow = row;
                bottomId = id;
            }
        }
    });
    return bottomId;
}

/* Snapshot every card's grid placement so an operation can be reverted
   cleanly (restored exactly) if it would overflow the grid. */
function _snapshotLayout() {
    const snap = [];
    LAYOUT_IDS.forEach(function(id) {
        const el = document.getElementById(id);
        if (!el) return;
        snap.push({
            id: id,
            col: el.style.gridColumn || '',
            row: el.style.gridRow || '',
            display: el.style.display || '',
            span: el.dataset.span || '',
            layout: Object.assign({}, _layout[id] || {}),
        });
    });
    const clockEl = document.getElementById('clock-section');
    snap.push({
        id: 'clock-section',
        col: clockEl ? clockEl.style.gridColumn || '' : '',
        row: '',
        display: '',
        span: '',
        layout: Object.assign({}, _layout['clock-section'] || {}),
    });
    return snap;
}

function _restoreLayout(snap) {
    snap.forEach(function(s) {
        const el = document.getElementById(s.id);
        if (!el) return;
        if (s.id === 'clock-section') {
            el.style.gridColumn = s.col;
            if (s.layout && Object.keys(s.layout).length) _layout[s.id] = s.layout;
            else delete _layout[s.id];
            const grid = document.querySelector('.term-grid');
            if (grid) grid.classList.toggle('clock-right', _clockSide() === 'right');
            return;
        }
        el.style.gridColumn = s.col;
        el.style.gridRow = s.row;
        el.style.display = s.display;
        el.dataset.span = s.span;
        if (s.layout && Object.keys(s.layout).length) _layout[s.id] = s.layout;
        else delete _layout[s.id];
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
    if (toHeight + span > 6) return false;
    el.style.gridColumn = String(_gridColFor(toCol));
    el.style.gridRow = '99 / span ' + span;  // sentinel; _packColumn sorts last → bottom
    _packColumn(toCol);
    // Keep _layout in sync so a later applyLayout (e.g. clock flip) doesn't
    // revert this cross-column move.
    const pos = _normLayout(bottomId);
    _layout[bottomId] = { col: toCol, row: parseInt(el.style.gridRow) || pos.row, span, hidden: pos.hidden };
    return true;
}

function _rebalanceOverflow() {
    let guard = 0;
    while (guard++ < 10) {
        const h2 = _columnHeight(2);
        const h3 = _columnHeight(3);
        if (h2 <= 6 && h3 <= 6) return true;
        // Move the overflowing column's bottom card to the other column's
        // bottom — but only when it can fit there.
        if (h2 > 6) {
            if (!_moveCardToBottom(2, 3)) return false;
        } else if (h3 > 6) {
            if (!_moveCardToBottom(3, 2)) return false;
        }
    }
    return _columnHeight(2) <= 6 && _columnHeight(3) <= 6;
}

function resetLayout() {
    _layout = {};
    applyLayout(DEFAULT_LAYOUT);
}

function initLayoutControls() {
    const modeBtn = document.getElementById('btn-layout-mode');
    const resetBtn = document.getElementById('btn-layout-reset');
    const saveBtn = document.getElementById('layout-save');
    const cancelBtn = document.getElementById('layout-cancel');
    const cardsBtn = document.getElementById('layout-cards');
    const cardsClose = document.getElementById('card-list-close');
    const cardPanel = document.getElementById('card-list-panel');
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
        resetLayout();
        try {
            const s = await pywebview.api.get_settings();
            s.layout = DEFAULT_LAYOUT;
            await pywebview.api.save_settings(s);
            window._appSettings = { ...(window._appSettings || {}), layout: DEFAULT_LAYOUT };
        } catch (e) { console.warn('reset layout:', e); }
    });
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const layout = readLayout();
        try {
            const s = await pywebview.api.get_settings();
            s.layout = layout;
            await pywebview.api.save_settings(s);
            window._appSettings = { ...(window._appSettings || {}), layout: layout };
        } catch (e) { console.warn('save layout:', e); }
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
    if (LAYOUT_IDS.some(id => {
        const a = cur[id], b = _layoutSaved[id];
        return !a || !b
            || a.col !== b.col || a.row !== b.row
            || a.span !== b.span || a.hidden !== b.hidden;
    })) return true;
    const a = cur['clock-section'], b = _layoutSaved['clock-section'];
    return !a || !b || a.side !== b.side;
}
