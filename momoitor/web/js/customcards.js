// Dynamically added custom cards: duplicate text cards and HTML cards. Each
// card is persisted as an entry in settings.custom_cards with a `type` field
// ('text' / 'html') and its own DOM element created at runtime (see cards.js
// registerCard / layout.js for the grid system). The shared card editor for
// both types (text fields + HTML source) also lives here.
//
// Loading order: this file runs after layout.js but before settings.js / boot.js,
// so it can reference the card registry and layout helpers at runtime.

/* Card ids created here always start with 'custom-'. */
function isCustomCard(id) {
    return typeof id === 'string' && id.indexOf('custom-') === 0;
}

const _CUSTOM_PREFIX = { text: 'custom-text-', html: 'custom-html-', data: 'custom-data-' };

function _customCardCfg(id) {
    const defaults = {
        type: 'text', text: '', html: '',
        font: '', bold: false, italic: false, size: 18, align: 'left', color: '',
    };
    const stored = ((window._appSettings || {}).custom_cards || {})[id] || {};
    return Object.assign({}, defaults, stored);
}

function _customCardType(cfg) {
    return cfg.type === 'html' ? 'html' : (cfg.type === 'data' ? 'data' : 'text');
}

/* Unique id for a new card of the given type, based on the highest existing
   counter among both registered cards and saved settings. */
function _nextCustomId(type) {
    const prefix = _CUSTOM_PREFIX[type] || 'custom-';
    let max = 0;
    layoutCards().forEach(c => {
        if (c.id.indexOf(prefix) === 0) {
            const n = parseInt(c.id.slice(prefix.length), 10);
            if (!isNaN(n) && n > max) max = n;
        }
    });
    Object.keys((window._appSettings || {}).custom_cards || {}).forEach(k => {
        if (k.indexOf(prefix) === 0) {
            const n = parseInt(k.slice(prefix.length), 10);
            if (!isNaN(n) && n > max) max = n;
        }
    });
    return prefix + (max + 1);
}

/* ---- DOM construction ---- */

/* Build the DOM element for a card, append it to the grid and register it.
   Idempotent: returns the existing card when already created. */
function _createCustomCardElement(id, cfg) {
    const existing = getCard(id);
    if (existing) return existing;
    const type = _customCardType(cfg || {});
    if (type === 'data') return _createDataCardElement(id, cfg || {});
    const el = document.createElement('div');
    el.className = 'term-box custom-card';
    el.id = id;
    el.style.display = 'none';

    const handle = document.createElement('div');
    handle.className = 'layout-drag-handle';
    handle.textContent = '⠿';
    el.appendChild(handle);

    const header = document.createElement('div');
    header.className = 'box-header';
    header.textContent = type === 'html' ? 'HTML' : 'Text';
    el.appendChild(header);

    const content = document.createElement('div');
    content.className = 'box-content';
    if (type === 'html') {
        const htmlEl = document.createElement('div');
        htmlEl.className = 'custom-html';
        content.appendChild(htmlEl);
    } else {
        const textEl = document.createElement('div');
        textEl.className = 'custom-text';
        content.appendChild(textEl);
    }
    el.appendChild(content);

    const grid = document.querySelector('.term-grid');
    if (grid) grid.appendChild(el);

    const card = registerCard(id, {
        el: el,
        def: { col: 2, row: 1, span: 1, hidden: false },
        resizable: true,
        meta: {
            name: type === 'html' ? 'HTML' : 'Text',
            color: 'var(--accent)',
            type: type,
        },
    });
    applyCustomCard(id);
    return card;
}

/* Rebuild any custom cards saved in settings (called at startup before the
   saved layout is applied, so their grid positions take effect). */
function initCustomCards(settings) {
    const cc = (settings && settings.custom_cards) || {};
    Object.keys(cc).forEach(id => {
        if (id === 'text-section') return;
        if (!isCustomCard(id)) return;
        if (getCard(id)) return;
        _createCustomCardElement(id, cc[id]);
    });
}

/* Create a brand new card of the given type, place it in the grid and open the
   editor for immediate customization. */
function createCustomCard(type) {
    const id = _nextCustomId(type);
    window._appSettings = window._appSettings || {};
    window._appSettings.custom_cards = window._appSettings.custom_cards || {};
    if (type === 'data') {
        window._appSettings.custom_cards[id] = { type: 'data', title: '', big: null, lines: [], spark: { enabled: false, color: '' }, spacing: {} };
    } else {
        window._appSettings.custom_cards[id] = { type: type, text: '', html: '' };
    }
    _createCustomCardElement(id, { type: type });
    _addCard(id);
    openCardEditor(id);
}

/* Fully remove a dynamic card: DOM, registry, layout position and saved config. */
async function deleteCustomCard(id) {
    const card = getCard(id);
    let col = null;
    if (card && card.el) {
        if (card.el.style.gridColumn) col = _layoutColFor(parseInt(card.el.style.gridColumn) || 2);
        if (card.el.parentNode) card.el.parentNode.removeChild(card.el);
    }
    unregisterCard(id);
    setCardPos(id, null);
    syncCardFetching(id); // 删卡后彻底停止该卡的数据获取（同类型全部实例删完才停）
    if (window._appSettings) {
        if (window._appSettings.custom_cards) delete window._appSettings.custom_cards[id];
        if (window._appSettings.layout) delete window._appSettings.layout[id];
    }
    if (col !== null) _repackColumn(col, null, null);
    _rebalanceOverflow();
    _updateCardsBtn();
    delete _cdPending[id];
    try { await pywebview.api.save_settings(window._appSettings); } catch (e) { console.warn('delete custom card:', e); }
}

/* Render a custom card's content (called on create / place / editor preview). */
function applyCustomCard(id) {
    const cfg = _customCardCfg(id);
    const card = getCard(id);
    if (!card || !card.el) return;
    const type = _customCardType(cfg);
    if (type === 'data') {
        applyCustomData(id, cfg);
    } else if (type === 'html') {
        const htmlEl = card.el.querySelector('.custom-html');
        if (htmlEl) htmlEl.innerHTML = cfg.html || '';
    } else if (type === 'text') {
        applyCustomText(id, cfg);
    }
}

// Custom text card

function _customTextCfg(id) {
    const defaults = { text: '', font: '', bold: false, italic: false, size: 18, align: 'left', color: '' };
    const stored = ((window._appSettings || {}).custom_cards || {})[id] || {};
    return Object.assign({}, defaults, stored);
}

function applyCustomText(id, cfgOverride) {
    const cfg = cfgOverride || _customTextCfg(id);
    const el = id === 'text-section'
        ? document.getElementById('custom-text-el')
        : (getCard(id) ? getCard(id).el.querySelector('.custom-text') : null);
    if (!el) return;
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

// Editor panel
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
    if (_cdPending[_ceEditId]) {
        delete _cdPending[_ceEditId];
        applyCustomCard(_ceEditId);
    }
    hideOverlay('card-edit-panel');
}

function readTextEditorForm() {
    const textEl = document.getElementById('ce-text');
    const fontEl = document.getElementById('ce-font');
    const boldEl = document.getElementById('ce-bold');
    const italicEl = document.getElementById('ce-italic');
    const sizeEl = document.getElementById('ce-size');
    return {
        type: _customTextCfg(_ceEditId).type || 'text',
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
    window._appSettings.custom_cards = window._appSettings.custom_cards || {};
    window._appSettings.custom_cards[_ceEditId] = cfg;
    applyCustomText(_ceEditId, cfg);
    closeTextEditor();
    try { await pywebview.api.save_settings(window._appSettings); } catch (e) { console.warn('save custom text:', e); }
}

function initTextCardEditor() {
    const closeBtn = document.getElementById('card-edit-close');
    if (closeBtn) closeBtn.addEventListener('click', closeTextEditor);
    const saveBtn = document.getElementById('card-edit-save');
    if (saveBtn) saveBtn.addEventListener('click', saveCardEditor);
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
/* ---- Card editor (shared panel in index.html) ---- */

/* Show only the fields relevant to the edited card type and set the panel title. */
function _setEditorType(type) {
    const textFields = document.getElementById('ce-text-fields');
    const htmlField = document.getElementById('ce-html-field');
    const dataField = document.getElementById('ce-data-fields');
    if (textFields) textFields.style.display = type === 'text' ? '' : 'none';
    if (htmlField) htmlField.style.display = type === 'html' ? '' : 'none';
    if (dataField) dataField.style.display = type === 'data' ? '' : 'none';
    const title = document.getElementById('card-edit-title');
    if (title) title.textContent = t(type === 'html' ? 'html-edit-title' : (type === 'data' ? 'data-edit-title' : 'text-edit-title'));
}

/* Entry point used by the layout mode click-to-edit binding (layout.js). */
function openCardEditor(id) {
    const cfg = _customCardCfg(id);
    const type = _customCardType(cfg);
    _setEditorType(type);
    if (type === 'data') {
        initDataEditor(id);
        return;
    }
    if (type === 'html') {
        _ceEditId = id;
        const panel = document.getElementById('card-edit-panel');
        if (!panel) return;
        const htmlEl = document.getElementById('ce-html');
        if (htmlEl) {
            htmlEl.value = cfg.html || '';
            htmlEl.focus();
        }
        panel.style.display = 'flex';
        return;
    }
    openTextEditor(id);
}

function _ceCurrentType() {
    return _customCardType(_customCardCfg(_ceEditId));
}

/* Save handler for the shared editor panel: dispatches by card type. */
async function saveCardEditor() {
    const id = _ceEditId;
    const type = _ceCurrentType();
    if (type === 'text') {
        await saveTextCard();
        return;
    }
    if (type === 'data') {
        await saveDataCard();
        return;
    }
    const cfg = _customCardCfg(id);
    cfg.html = (document.getElementById('ce-html') || { value: '' }).value;
    window._appSettings = window._appSettings || {};
    window._appSettings.custom_cards = window._appSettings.custom_cards || {};
    window._appSettings.custom_cards[id] = cfg;
    applyCustomCard(id);
    closeTextEditor();
    try { await pywebview.api.save_settings(window._appSettings); } catch (e) { console.warn('save custom card:', e); }
}

function initCustomCardEditor() {
    const htmlEl = document.getElementById('ce-html');
    if (htmlEl) {
        htmlEl.addEventListener('input', () => {
            if (isCustomCard(_ceEditId) && _ceCurrentType() === 'html') {
                const card = getCard(_ceEditId);
                const target = card && card.el.querySelector('.custom-html');
                if (target) target.innerHTML = htmlEl.value;
            }
        });
    }
    initDataCardEditor();
    _bindCustomCardNormalEdit();
}

/* 普通（非布局）模式下，点击已添加的自定义卡片（text/html/data）直接打开编辑器。
   布局模式下的编辑由 layout-mode.js 的布局控件处理，二者互斥（_layoutMode 为真时跳过）。 */
function _bindCustomCardNormalEdit() {
    document.addEventListener('click', (e) => {
        if (_layoutMode) return;
        const target = e.target.closest('.custom-card, #text-section');
        if (!target) return;
        // 避免触发卡片内部的可交互元素（如 HTML 卡片内的链接/按钮）
        if (e.target.closest('a, button, input, select, textarea, .layout-control-group')) return;
        const id = target.id;
        if (isCustomCard(id) || id === 'text-section') openCardEditor(id);
    });
}
