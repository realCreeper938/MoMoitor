/* 自选数据卡片（自选数据）—— 运行时创建的动态卡片类型 'data'。

   此类卡片由用户在布局模式下添加，容量不限；卡片配置持久化在
   custom_cards[id] = {type:'data', title, big, lines}，其中：
     big   = {source, key}  大数字（单值）
     lines = [{source, key}, ...]  信息行，数量不限
   每个槽位独立选择"数据源 + 该源可用数据"，数据源为当前启用的后端。

   槽位 key 与后端 catalog.py 约定一致：
     - "std:{group}.{field}"  标准指标（运行时取该源最近一次快照）
     - "raw:{ident}"          原始传感器（运行时按 ident 反查）
   实时值统一由后端 get_custom_values(slots) 批量解析。

   Loading order: 本文件在 customcards.js 之后加载，彼时卡片注册表与
   applyCustomCard/registerCard 等全局函数已就绪；boot.js 的轮询通过
   refreshCustomDataCards() 挂钩刷新。
*/

/* ==================== 自选数据卡片（自选数据） ==================== */

/* 槽位 key 与后端 catalog.py 约定一致：
 *  - "std:{group}.{field}"  标准指标（运行时取该源最近一次快照）
 *  - "raw:{ident}"          原始传感器（运行时按 ident 反查）
 */

const _CD_KIND_FMT = {
    pct: { dec: 0 }, temp: { dec: 0 }, power: { dec: 1 },
    clock: { dec: 0 }, volt: { dec: 3 }, gb: { dec: 1 }, mb: { dec: 1 },
    rpm: { dec: 0 }, rate: { rate: true }, raw: { smart: true },
};

const _CD_KIND_UNIT = {
    pct: '%', temp: '°C', power: 'W', clock: 'MHz',
    volt: 'V', gb: 'GB', mb: 'MB', rpm: 'RPM',
};

let _cdCatalog = null;
let _cdCatalogTs = 0;
let _cdPending = {};   // 编辑中的未保存配置 {id: cfg}

function _dataCardDefaults() {
    return { type: 'data', title: '', big: null, lines: [], spark: { enabled: false, color: '' }, spacing: {} };
}

function _dataCardCfg(id) {
    const stored = ((window._appSettings || {}).custom_cards || {})[id] || {};
    const cfg = Object.assign(_dataCardDefaults(), stored);
    cfg.big = (cfg.big && typeof cfg.big === 'object' && cfg.big.key) ? cfg.big : null;
    cfg.lines = (Array.isArray(cfg.lines) ? cfg.lines : []).map(l => {
        if (typeof l === 'string') return { text: l };
        if (l && typeof l.text === 'string') return { text: l.text };
        // 旧格式 / {source,key} 单值行 迁移为模板变量
        if (l && l.source && l.key) return { text: '{' + l.source + '.' + l.key + '}' };
        return { text: '' };
    }).filter(l => l.text !== '');
    const spark = (cfg.spark && typeof cfg.spark === 'object') ? cfg.spark : {};
    cfg.spark = { enabled: spark.enabled === true, color: typeof spark.color === 'string' ? spark.color : '' };
    // 间距仅保留有效数值，留空表示用默认（与内置大卡片一致）
    const sp = (cfg.spacing && typeof cfg.spacing === 'object') ? cfg.spacing : {};
    cfg.spacing = {};
    [['left', sp.left], ['bottom', sp.bottom]].forEach(function(pair) {
        const v = parseFloat(pair[1]);
        if (isFinite(v) && v >= 0) cfg.spacing[pair[0]] = v;
    });
    return cfg;
}

/* Live-value formatting by kind. Returns {text, unit}. */
function _cdUnitFor(item) {
    const kind = item && item.kind;
    if (_CD_KIND_UNIT[kind]) return _CD_KIND_UNIT[kind];
    if (item && item.unit) return item.unit;
    return '';
}

function _cdSmartDec(v) {
    const a = Math.abs(v);
    if (a >= 100) return 0;
    if (a >= 10) return 1;
    return 2;
}

function _cdFmtValue(value, item) {
    const kind = (item && item.kind) || 'raw';
    if (value == null || isNaN(value) || value === '') {
        return { text: '--', unit: _cdUnitFor(item) };
    }
    if (kind === 'rate') {
        const n = formatNet(Number(value));
        return { text: n.val, unit: n.unit };
    }
    const spec = _CD_KIND_FMT[kind] || {};
    const dec = spec.smart ? _cdSmartDec(Number(value)) : (spec.dec != null ? spec.dec : 0);
    return { text: Number(value).toFixed(dec), unit: _cdUnitFor(item) };
}

/* ---- catalog ---- */

async function _ensureCatalog(force) {
    if (!force && _cdCatalog && performance.now() - _cdCatalogTs < 30000) {
        return _cdCatalog;
    }
    try {
        _cdCatalog = await pywebview.api.get_data_catalog();
    } catch (e) {
        if (!_cdCatalog) _cdCatalog = { sources: [] };
        console.warn('get_data_catalog:', e);
    }
    _cdCatalogTs = performance.now();
    return _cdCatalog;
}

function _cdSourceEntry(source) {
    const cat = _cdCatalog || {};
    return (cat.sources || []).find(x => x.source === source) || null;
}

function _cdItemByKey(source, key) {
    const s = _cdSourceEntry(source);
    if (!s) return null;
    for (const g of s.groups || []) {
        for (const it of g.items || []) {
            if (it.key === key) return it;
        }
    }
    return null;
}

function _cdItemLabel(item) {
    if (!item) return '';
    if (item.label_key && typeof t === 'function') return t(item.label_key);
    return item.label || item.key || '';
}

function _cdItemText(item) {
    const label = _cdItemLabel(item);
    const unit = _cdUnitFor(item);
    return unit ? label + ' (' + unit + ')' : label;
}

/* ---- card DOM ---- */

function _createDataCardElement(id, cfg) {
    const existing = getCard(id);
    if (existing) return existing;
    const el = document.createElement('div');
    el.className = 'term-box custom-card custom-data-card';
    el.id = id;
    el.style.display = 'none';

    const handle = document.createElement('div');
    handle.className = 'layout-drag-handle';
    handle.textContent = '⠿';
    el.appendChild(handle);

    /* 背景折线图（默认隐藏，用户可在编辑器中开启并指定颜色） */
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.className = 'sparkline-bg';
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('data-spark', 'cd-' + id);
    svg.style.display = 'none';
    const polyArea = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polyArea.className = 'spark-area';
    polyArea.setAttribute('points', '');
    svg.appendChild(polyArea);
    const polyLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyLine.className = 'spark-line';
    polyLine.setAttribute('points', '');
    svg.appendChild(polyLine);
    const cursorLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    cursorLine.className = 'spark-cursor';
    cursorLine.setAttribute('y1', '0');
    cursorLine.setAttribute('y2', '100');
    svg.appendChild(cursorLine);
    el.appendChild(svg);

    const header = document.createElement('div');
    header.className = 'box-header';
    header.id = id + '-header';
    el.appendChild(header);

    const content = document.createElement('div');
    content.className = 'box-content';
    const split = document.createElement('div');
    split.className = 'split-row';
    const dataCol = document.createElement('div');
    dataCol.className = 'data-col';
    const valueRow = document.createElement('div');
    valueRow.className = 'value-row';
    const big = document.createElement('span');
    big.className = 'metric-value big mono cd-big-val';
    big.textContent = '--';
    const unit = document.createElement('span');
    unit.className = 'pct cd-big-unit';
    valueRow.appendChild(big);
    valueRow.appendChild(unit);
    dataCol.appendChild(valueRow);
    const lines = document.createElement('div');
    lines.className = 'cd-lines';
    dataCol.appendChild(lines);
    split.appendChild(dataCol);
    content.appendChild(split);
    el.appendChild(content);

    const grid = document.querySelector('.term-grid');
    if (grid) grid.appendChild(el);

    const card = registerCard(id, {
        el: el,
        def: { col: 2, row: 1, span: 1, hidden: false },
        resizable: true,
        meta: { name: typeof t === 'function' ? t('card-name-data') : 'Data', color: 'var(--green)', type: 'data' },
    });
    applyCustomData(id, cfg);
    return card;
}

function applyCustomData(id, cfg) {
    const card = getCard(id);
    if (!card || !card.el) return;
    const c = cfg || _dataCardCfg(id);
    const header = card.el.querySelector('.box-header');
    if (header) header.textContent = c.title || (typeof t === 'function' ? t('card-name-data') : 'Data');

    const bigEl = card.el.querySelector('.cd-big-val');
    const unitEl = card.el.querySelector('.cd-big-unit');
    const bigItem = c.big ? _cdItemByKey(c.big.source, c.big.key) : null;
    if (bigEl) bigEl.textContent = '--';
    if (unitEl) unitEl.textContent = _cdUnitFor(bigItem);
    _cdApplyBigFont(card.el);

    _cdApplySpark(card.el, c);
    _cdApplySpacing(card.el, c);

    const linesEl = card.el.querySelector('.cd-lines');
    if (!linesEl) return;
    linesEl.innerHTML = '';
    (c.lines || []).forEach(line => {
        const l = document.createElement('div');
        l.className = 'info-line';
        const span = document.createElement('span');
        span.className = 'cd-line-text';
        span.innerHTML = _cdSanitizeLine(line.text || '');
        l.appendChild(span);
        linesEl.appendChild(l);
    });
}

/* 白名单清洗信息行模板：只保留 span/div 及其 unit/mono/dim 类，剥离其它所有
   标签与属性（含脚本/事件/危险元素），避免 XSS 与布局被破坏。用于把用户写的
   <span class="unit">MHz</span> 渲染成 CPU 那样的下标单位样式。 */
function _cdSanitizeLine(html) {
    const allowedTags = { SPAN: 1, DIV: 1 };
    const allowedClasses = { unit: 1, mono: 1, dim: 1 };
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html || '');
    const walk = (node) => {
        Array.from(node.childNodes).forEach((child) => {
            if (child.nodeType !== 1) return;   // 文本节点保留
            const tag = child.tagName;
            if (!allowedTags[tag]) {
                // 非白名单标签：降级为文本，保留文字、去掉标签与潜在脚本
                node.replaceChild(document.createTextNode(child.textContent || ''), child);
                return;
            }
            Array.from(child.attributes).forEach((attr) => {
                if (attr.name !== 'class') child.removeAttribute(attr.name);
            });
            const cls = String(child.className || '').split(/\s+/).filter((c) => allowedClasses[c]);
            child.className = cls.join(' ');
            walk(child);
        });
    };
    walk(tmp);
    return tmp.innerHTML;
}

/* 同步用户自定义的左侧/底部间距（未设置时清空内联样式，交由 CSS 默认）。
   间距 padding 在 .box-content 上，用内联覆盖 CSS 默认，优先级最高。 */
function _cdApplySpacing(el, c) {
    if (!el) return;
    const bc = el.querySelector('.box-content');
    if (!bc) return;
    const s = (c && c.spacing) || {};
    bc.style.paddingLeft = (typeof s.left === 'number' && isFinite(s.left)) ? (s.left + 'px') : '';
    bc.style.paddingBottom = (typeof s.bottom === 'number' && isFinite(s.bottom)) ? (s.bottom + 'px') : '';
}

/* 同步背景折线：显隐 + 颜色 + 折线 key 对应的数据组。 */
function _cdApplySpark(el, c) {
    if (!el) return;
    const svg = el.querySelector('.sparkline-bg');
    if (!svg) return;
    const on = !!(c.spark && c.spark.enabled && c.big && c.big.key);
    svg.style.display = on ? '' : 'none';
    const color = (c.spark && c.spark.color) || 'var(--green)';
    el.style.setProperty('--spark-color', color);
}

/* Big value font size. 与内置 CPU/GPU 大卡片完全一致：不做任何内联 font-size
   干预，交由 .metric-value.big 的 CSS（clamp(72px, 8vw, 120px)）决定。
   之前按 dataset.span 推断会误判（span 未定时把小卡片规则套到卡片上），
   导致字号与 CPU 不一致，故取消全部内联缩放。 */
function _cdApplyBigFont(sectionEl) {
    const b = sectionEl.querySelector('.cd-big-val');
    if (b) b.style.fontSize = '';
}

/* ---- live refresh（每轮 poll 触发） ---- */

/* 在模板文本中查找 {source.key} 变量，返回匹配列表。 */
function _cdParseTemplateVars(text) {
    const vars = [];
    String(text || '').replace(/\{([^{}]+)\}/g, (m, tok) => {
        const dot = tok.indexOf('.');
        if (dot > 0) {
            vars.push({ source: tok.slice(0, dot), key: tok.slice(dot + 1) });
        }
        return m;
    });
    return vars;
}

/* 用已解析的槽位值渲染模板文本：每个 {source.key} 替换为数值（不含单位，单位由用户写在模板里），
   并做白名单清洗，支持 <span class="unit">MHz</span> 等下标样式。 */
function _cdRenderTemplate(text, slotValue, slotToIdx) {
    const out = String(text || '').replace(/\{([^{}]+)\}/g, (m, tok) => {
        const dot = tok.indexOf('.');
        if (dot > 0) {
            const source = tok.slice(0, dot);
            const key = tok.slice(dot + 1);
            const idx = slotToIdx.get(source + '|' + key);
            if (idx !== undefined) {
                const item = _cdItemByKey(source, key);
                return _cdFmtValue(slotValue[idx], item).text;
            }
        }
        return m;
    });
    return _cdSanitizeLine(out);
}

async function refreshCustomDataCards() {
    const cards = layoutCards().filter(c => c.meta && c.meta.type === 'data');
    const visible = cards.filter(c => !_normLayout(c.id).hidden);
    if (!visible.length) return;
    await _ensureCatalog(false);

    const slotOrder = [];                 // [{source,key}] 唯一槽位，保序
    const slotToIdx = new Map();
    const slotIdx = (source, key) => {
        const id = source + '|' + key;
        if (slotToIdx.has(id)) return slotToIdx.get(id);
        const i = slotOrder.length;
        slotOrder.push({ source: source, key: key });
        slotToIdx.set(id, i);
        return i;
    };

    const bigJobs = [];                   // {el, source, key, valIdx}
    const lineJobs = [];                  // {lineEl, text}
    const sparks = [];
    for (const card of visible) {
        const el = card.el;
        const cfg = _cdPending[card.id] || _dataCardCfg(card.id);
        let bigIdx = null;
        if (cfg.big && cfg.big.key) {
            bigIdx = slotIdx(cfg.big.source, cfg.big.key);
            bigJobs.push({ el: el, source: cfg.big.source, key: cfg.big.key, valIdx: bigIdx });
        }
        const lineEls = el.querySelectorAll('.cd-lines .info-line');
        (cfg.lines || []).forEach((ln, idx) => {
            if (!lineEls[idx]) return;
            const text = (ln && ln.text) || '';
            if (text) {
                _cdParseTemplateVars(text).forEach(v => slotIdx(v.source, v.key));
                lineJobs.push({ lineEl: lineEls[idx], text: text });
            }
        });
        if (cfg.spark && cfg.spark.enabled && bigIdx != null) {
            const item = _cdItemByKey(cfg.big.source, cfg.big.key);
            const pct = item && item.kind === 'pct';
            sparks.push({ id: card.id, el: el, valIdx: bigIdx, item: item, dyn: !pct, max: pct ? 100 : 1e15 });
        }
    }
    if (!slotOrder.length) return;

    let vals;
    try {
        vals = await pywebview.api.get_custom_values(slotOrder);
    } catch (e) { console.warn('get_custom_values:', e); return; }
    if (!Array.isArray(vals) || vals.length !== slotOrder.length) return;
    const slotValue = vals;

    // 大数字位
    for (const j of bigJobs) {
        const b = j.el.querySelector('.cd-big-val');
        const u = j.el.querySelector('.cd-big-unit');
        const f = _cdFmtValue(slotValue[j.valIdx], _cdItemByKey(j.source, j.key));
        if (b) b.textContent = f.text;
        if (u) u.textContent = f.unit;
        _cdApplyBigFont(j.el);
    }
    // 信息行模板渲染
    for (const j of lineJobs) {
        const span = j.lineEl.querySelector('.cd-line-text');
        if (span) span.innerHTML = _cdRenderTemplate(j.text, slotValue, slotToIdx);
    }
    // 折线图：以 big 值为数据源
    for (const s of sparks) {
        const key = 'cd-' + s.id;
        if (!chartData[key]) chartData[key] = [];
        chartPush(key, Number(slotValue[s.valIdx]), s.max);
        updateChart(key, s.dyn, s.dyn ? undefined : s.max);
    }
}

/* ---- editor ---- */

function _cdPopulateSource(sel, selected) {
    if (!sel) return;
    const cat = _cdCatalog || {};
    sel.innerHTML = '';
    (cat.sources || []).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.source;
        opt.textContent = s.label || s.source;
        sel.appendChild(opt);
    });
    if (selected && (cat.sources || []).some(s => s.source === selected)) {
        sel.value = selected;
    } else if (sel.options.length) {
        sel.selectedIndex = 0;
    }
}

function _cdPopulateItems(itemSel, source, selected) {
    if (!itemSel) return;
    itemSel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = typeof t === 'function' ? t('data-edit-none') : '—';
    itemSel.appendChild(empty);
    const s = _cdSourceEntry(source);
    if (!s) { itemSel.selectedIndex = 0; return; }
    (s.groups || []).forEach(g => {
        if (!g.items || !g.items.length) return;
        const og = document.createElement('optgroup');
        og.label = (g.name === '__std__')
            ? (typeof t === 'function' ? t('data-group-std') : 'Standard')
            : g.name;
        g.items.forEach(it => {
            const opt = document.createElement('option');
            opt.value = it.key;
            opt.textContent = _cdItemText(it);
            og.appendChild(opt);
        });
        itemSel.appendChild(og);
    });
    if (selected && itemSel.querySelector('option[value="' + CSS.escape(selected) + '"]')) {
        itemSel.value = selected;
    } else {
        itemSel.selectedIndex = 0;
    }
}

function _cdReadRow(srcSel, itemSel) {
    const source = srcSel ? srcSel.value : '';
    const key = itemSel ? itemSel.value : '';
    if (source && key) return { source: source, key: key };
    return null;
}

/* 在输入框光标处插入字符串并保持焦点。 */
function _cdInsertAtCursor(input, str) {
    const s = input.selectionStart != null ? input.selectionStart : input.value.length;
    const e = input.selectionEnd != null ? input.selectionEnd : input.value.length;
    input.value = input.value.slice(0, s) + str + input.value.slice(e);
    const pos = s + str.length;
    input.focus();
    input.setSelectionRange(pos, pos);
}

/* 构建一条信息行编辑器行：模板文本输入框 + 数据源 + 数据项（用于插入变量）+ 插入/删除。 */
function _cdBuildLineRow(container, line) {
    const row = document.createElement('div');
    row.className = 'cd-line-row';

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'input-sm ce-line-text';
    text.value = (line && line.text) || '';
    text.placeholder = typeof t === 'function' ? t('data-edit-line-ph') : '{lhm.std:cpu.temp} 度';
    row.appendChild(text);

    const srcSel = document.createElement('select');
    srcSel.className = 'cd-src cd-ins-src';
    const itemSel = document.createElement('select');
    itemSel.className = 'cd-item cd-ins-item';
    row.appendChild(srcSel);
    row.appendChild(itemSel);

    const ins = document.createElement('button');
    ins.type = 'button';
    ins.className = 'text-btn cd-ins-btn';
    ins.textContent = typeof t === 'function' ? t('data-edit-insert') : '+';
    ins.title = typeof t === 'function' ? t('data-edit-insert-hint') : 'Insert variable';
    row.appendChild(ins);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'text-btn cd-slot-del';
    del.textContent = '×';
    del.title = typeof t === 'function' ? t('btn-close') : 'Remove';
    row.appendChild(del);

    const src = (_cdCatalog.sources && _cdCatalog.sources[0]) ? _cdCatalog.sources[0].source : '';
    _cdPopulateSource(srcSel, src);
    _cdPopulateItems(itemSel, srcSel.value, '');

    srcSel.addEventListener('change', () => {
        _cdPopulateItems(itemSel, srcSel.value, '');
    });
    itemSel.addEventListener('change', () => { /* 选择项即记录，不触发预览 */ });
    ins.addEventListener('click', () => {
        const s = _cdReadRow(srcSel, itemSel);
        if (s) _cdInsertAtCursor(text, '{' + s.source + '.' + s.key + '}');
        _cdDataEditorChanged();
    });
    del.addEventListener('click', () => {
        row.parentNode.removeChild(row);
        _cdDataEditorChanged();
    });
    text.addEventListener('input', _cdDataEditorChanged);
    container.appendChild(row);
    return row;
}

/* Re-read the entire editor form into a pending cfg and live-preview it. */
function _cdDataEditorChanged() {
    const id = _ceEditId;
    if (!id) return;
    const titleEl = document.getElementById('ce-data-title');
    const bigSrc = document.getElementById('ce-big-src');
    const bigItem = document.getElementById('ce-big-item');
    const linesEl = document.getElementById('ce-lines');
    const cfg = _dataCardDefaults();
    cfg.title = titleEl ? titleEl.value : '';
    cfg.big = _cdReadRow(bigSrc, bigItem);
    cfg.lines = [];
    if (linesEl) {
        linesEl.querySelectorAll('.cd-line-row .ce-line-text').forEach(inp => {
            if (inp.value) cfg.lines.push({ text: inp.value });
        });
    }
    const sparkEl = document.getElementById('ce-spark');
    const sparkColor = document.getElementById('ce-spark-color');
    cfg.spark = {
        enabled: sparkEl ? sparkEl.checked : false,
        color: sparkColor ? sparkColor.value : '',
    };
    cfg.spacing = {};
    const spL = document.getElementById('ce-space-left');
    const spB = document.getElementById('ce-space-bottom');
    [['left', spL], ['bottom', spB]].forEach(function(pair) {
        if (pair[1] && pair[1].value !== '' && isFinite(parseFloat(pair[1].value))) {
            cfg.spacing[pair[0]] = parseFloat(pair[1].value);
        }
    });
    _cdPending[id] = cfg;
    applyCustomData(id, cfg);
}

async function initDataEditor(id) {
    _ceEditId = id;
    const panel = document.getElementById('card-edit-panel');
    if (!panel) return;
    const cfg = _dataCardCfg(id);
    await _ensureCatalog(true);

    const titleEl = document.getElementById('ce-data-title');
    if (titleEl) titleEl.value = cfg.title || '';

    const bigSrc = document.getElementById('ce-big-src');
    const bigItem = document.getElementById('ce-big-item');
    if (bigSrc && bigItem) {
        _cdPopulateSource(bigSrc, cfg.big ? cfg.big.source : null);
        _cdPopulateItems(bigItem, bigSrc.value, cfg.big ? cfg.big.key : '');
    }

    const linesEl = document.getElementById('ce-lines');
    if (linesEl) {
        linesEl.innerHTML = '';
        (cfg.lines || []).forEach(ln => _cdBuildLineRow(linesEl, ln));
    }

    const sparkEl = document.getElementById('ce-spark');
    if (sparkEl) sparkEl.checked = !!(cfg.spark && cfg.spark.enabled);
    const sparkColor = document.getElementById('ce-spark-color');
    if (sparkColor) sparkColor.value = (cfg.spark && cfg.spark.color) || '#5e81ac';

    const spL = document.getElementById('ce-space-left');
    if (spL) spL.value = (cfg.spacing && cfg.spacing.left != null) ? cfg.spacing.left : '';
    const spB = document.getElementById('ce-space-bottom');
    if (spB) spB.value = (cfg.spacing && cfg.spacing.bottom != null) ? cfg.spacing.bottom : '';

    panel.style.display = 'flex';
}

function _cdAddLineRow() {
    const linesEl = document.getElementById('ce-lines');
    if (linesEl) _cdBuildLineRow(linesEl, { text: '' });
    _cdDataEditorChanged();
}

function initDataCardEditor() {
    const titleEl = document.getElementById('ce-data-title');
    if (titleEl) {
        titleEl.addEventListener('input', _cdDataEditorChanged);
    }
    const addBtn = document.getElementById('ce-add-line');
    if (addBtn) addBtn.addEventListener('click', _cdAddLineRow);
    const bigSrc = document.getElementById('ce-big-src');
    const bigItem = document.getElementById('ce-big-item');
    if (bigSrc) bigSrc.addEventListener('change', () => {
        _cdPopulateItems(document.getElementById('ce-big-item'), bigSrc.value, '');
        _cdDataEditorChanged();
    });
    if (bigItem) bigItem.addEventListener('change', _cdDataEditorChanged);
    const clearBtn = document.getElementById('ce-big-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
        const bs = document.getElementById('ce-big-src');
        const bi = document.getElementById('ce-big-item');
        if (bs) bs.value = '';
        if (bi) {
            bi.innerHTML = '';
            bi.appendChild(new Option(typeof t === 'function' ? t('data-edit-none') : '—', ''));
            bi.selectedIndex = 0;
        }
        _cdDataEditorChanged();
    });
    const sparkEl = document.getElementById('ce-spark');
    if (sparkEl) sparkEl.addEventListener('change', _cdDataEditorChanged);
    const sparkColor = document.getElementById('ce-spark-color');
    if (sparkColor) sparkColor.addEventListener('input', _cdDataEditorChanged);
    const spL = document.getElementById('ce-space-left');
    if (spL) spL.addEventListener('input', _cdDataEditorChanged);
    const spB = document.getElementById('ce-space-bottom');
    if (spB) spB.addEventListener('input', _cdDataEditorChanged);
}

async function saveDataCard() {
    const id = _ceEditId;
    const cfg = _cdPending[id] || _dataCardCfg(id);
    window._appSettings = window._appSettings || {};
    window._appSettings.custom_cards = window._appSettings.custom_cards || {};
    window._appSettings.custom_cards[id] = cfg;
    delete _cdPending[id];
    applyCustomCard(id);
    closeTextEditor();
    try { await pywebview.api.save_settings(window._appSettings); } catch (e) { console.warn('save custom data:', e); }
}
