// Dynamically added custom cards: duplicate text cards and HTML cards. Each
// card is persisted as an entry in settings.custom_cards with a `type` field
// ('text' / 'html') and its own DOM element created at runtime (see cards.js
// registerCard / layout.js for the grid system).
//
// Loading order: this file runs after layout.js but before settings.js / boot.js,
// so it can reference the card registry and layout helpers at runtime.

/* Card ids created here always start with 'custom-'. */
function isCustomCard(id) {
    return typeof id === 'string' && id.indexOf('custom-') === 0;
}

const _CUSTOM_PREFIX = { text: 'custom-text-', html: 'custom-html-' };

function _customCardCfg(id) {
    const defaults = {
        type: 'text', text: '', html: '',
        font: '', bold: false, italic: false, size: 18, align: 'left', color: '',
    };
    const stored = ((window._appSettings || {}).custom_cards || {})[id] || {};
    return Object.assign({}, defaults, stored);
}

function _customCardType(cfg) {
    return cfg.type === 'html' ? 'html' : 'text';
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
    window._appSettings.custom_cards[id] = { type: type, text: '', html: '' };
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
    if (window._appSettings) {
        if (window._appSettings.custom_cards) delete window._appSettings.custom_cards[id];
        if (window._appSettings.layout) delete window._appSettings.layout[id];
    }
    if (col !== null) _repackColumn(col, null, null);
    _rebalanceOverflow();
    _updateCardsBtn();
    try { await pywebview.api.save_settings(window._appSettings); } catch (e) { console.warn('delete custom card:', e); }
}

/* Render a custom card's content (called on create / place / editor preview). */
function applyCustomCard(id) {
    const cfg = _customCardCfg(id);
    const card = getCard(id);
    if (!card || !card.el) return;
    const type = _customCardType(cfg);
    if (type === 'html') {
        const htmlEl = card.el.querySelector('.custom-html');
        if (htmlEl) htmlEl.innerHTML = cfg.html || '';
    } else if (type === 'text') {
        applyCustomText(id, cfg);
    }
}

/* ---- Card editor (shared panel in index.html) ---- */

/* Show only the fields relevant to the edited card type and set the panel title. */
function _setEditorType(type) {
    const textFields = document.getElementById('ce-text-fields');
    const htmlField = document.getElementById('ce-html-field');
    if (textFields) textFields.style.display = type === 'text' ? '' : 'none';
    if (htmlField) htmlField.style.display = type === 'html' ? '' : 'none';
    const title = document.getElementById('card-edit-title');
    if (title) title.textContent = t(type === 'html' ? 'html-edit-title' : 'text-edit-title');
}

/* Entry point used by the layout mode click-to-edit binding (layout.js). */
function openCardEditor(id) {
    const cfg = _customCardCfg(id);
    const type = _customCardType(cfg);
    _setEditorType(type);
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
}
