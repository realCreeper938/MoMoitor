// Card list panel: previews for every registered card type, the add-new
// entry points and the re-add flow for hidden cards (layout mode).

function _cardPreviewHTML(id) {
    const m = getCard(id).meta;
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
        const cfg = _customTextCfg(id);
        const inner = escapeHtml(cfg.text || '');
        return '<div class="clp-text" style="text-align:' + (cfg.align || 'left') + '">'
            + (inner ? '<span class="clp-text-lines">' + inner + '</span>'
                : '<span class="clp-text-empty">Aa</span>')
            + '</div>';
    }
    if (m.type === 'html') {
        const cfg = _customCardCfg(id);
        const inner = escapeHtml(String(cfg.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 60);
        return '<div class="clp-text">'
            + (inner ? '<span class="clp-text-lines">' + inner + '</span>'
                : '<span class="clp-html-glyph">&lt;/&gt;</span>')
            + '</div>';
    }
    if (m.type === 'data') {
        const cfg = _dataCardCfg(id);
        let html = '<div class="clp-value-row"><span class="clp-value">--</span>'
            + '<span class="clp-pct">' + escapeHtml(_cdUnitFor(cfg.big ? _cdItemByKey(cfg.big.source, cfg.big.key) : null)) + '</span></div>';
        for (const ln of (cfg.lines || []).slice(0, 2)) {
            const item = _cdItemByKey(ln.source, ln.key);
            html += '<div class="clp-info"><span class="mono">--</span>'
                + '<span class="clp-unit">' + escapeHtml(_cdUnitFor(item)) + '</span></div>';
        }
        return html;
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

/* Preview shown for a not-yet-created custom card type (add-new section). */
function _customTypePreviewHTML(type) {
    if (type === 'html') {
        return '<div class="clp-text"><span class="clp-html-glyph">&lt;/&gt;</span></div>';
    }
    if (type === 'data') {
        return '<div class="clp-value-row"><span class="clp-value">42</span>'
            + '<span class="clp-pct">%</span></div>'
            + '<div class="clp-info"><span class="mono">65</span>'
            + '<span class="clp-unit">°C</span></div>';
    }
    return '<div class="clp-text"><span class="clp-text-empty">Aa</span></div>';
}

function _renderCardList() {
    const body = document.getElementById('card-list-body');
    if (!body) return;
    body.textContent = '';

    // Text / html / data card types are listed like every other card in the grid;
    // clicking one creates a brand new card of that type (addable repeatedly).
    [['text', 'card-add-text'], ['html', 'card-add-html'], ['data', 'card-add-data']].forEach(function(pair) {
        const type = pair[0];
        const item = document.createElement('div');
        item.className = 'card-list-item card-add-item';
        item.dataset.cardType = type;
        item.setAttribute('draggable', 'false');
        item.innerHTML = '<div class="card-list-preview" style="--card-accent:var(--accent)">'
            + _customTypePreviewHTML(type) + '</div>'
            + '<div class="card-list-name">' + t(pair[1])
            + '<span class="card-list-sizes">1x1 · 1x2</span></div>';
        item.addEventListener('click', () => createCustomCard(type));
        body.appendChild(item);
    });

    const hidden = layoutCards().filter(card => _normLayout(card.id).hidden);
    hidden.forEach(card => {
        const id = card.id;
        const meta = card.meta || { name: id, color: 'var(--text)' };
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
}

/* Cards that support both sizes (resizable) list their options next to the
   name, e.g. "CPU 1x1 · 1x2".  Non-resizable cards have a single fixed size. */
function _cardSizesHTML(id) {
    const card = getCard(id);
    if (!card || !card.resizable) return '';
    const sizes = [1, 2].map(s => '1x' + s);
    return '<span class="card-list-sizes">' + sizes.join(' · ') + '</span>';
}

function _updateCardsBtn() {
    const cardsBtn = document.getElementById('layout-cards');
    if (!cardsBtn) return;
    // The button is always available in layout mode: it also hosts the
    // "add new card" entry point for text / html / clock cards.
    cardsBtn.classList.remove('hidden');
    const panel = document.getElementById('card-list-panel');
    if (panel && panel.style.display === 'flex') _renderCardList();
}
