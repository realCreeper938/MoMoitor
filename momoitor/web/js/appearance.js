/* Settings */
let _themeTransitionTimer = null;

function applyColorscheme(scheme) {
    scheme = normalizeColorscheme(scheme);
    document.documentElement.classList.add('theme-transition');
    document.documentElement.setAttribute('data-colorscheme', scheme);
    clearTimeout(_themeTransitionTimer);
    _themeTransitionTimer = setTimeout(
        () => document.documentElement.classList.remove('theme-transition'), 400);
}

// Follow system light/dark mode
let _followSystemTheme = false;
let _sysThemeMode = 'dark';
let _sysThemeTimer = null;

function _applyFollowScheme(grp) {
    const g = grp || (window._appSettings && window._appSettings.general) || {};
    applyColorscheme(_sysThemeMode === 'light'
        ? (g.colorscheme_light || 'gruvbox-light')
        : (g.colorscheme_dark || 'gruvbox'));
}

async function _checkSystemTheme(force) {
    try {
        const mode = await pywebview.api.get_system_theme_mode();
        if (mode !== _sysThemeMode || force) {
            _sysThemeMode = mode;
            if (_followSystemTheme) _applyFollowScheme();
        }
    } catch (e) {
        console.warn('system theme:', e);
    }
}

function setFollowSystemTheme(enabled) {
    _followSystemTheme = !!enabled;
    if (_followSystemTheme) {
        if (!_sysThemeTimer) _sysThemeTimer = setInterval(() => _checkSystemTheme(false), 5000);
    } else if (_sysThemeTimer) {
        clearInterval(_sysThemeTimer);
        _sysThemeTimer = null;
    }
}

// Interface background (fixed full-viewport layer behind all content)
let lastResolvedAppBg = { image: '', path: '' };
let appBgState = { url: '', topColor: '', gradient: true, opacity: 0, blur: 0 };
let _appBgResizeTimer = null;

function applyAppBackgroundGradient() {
    const layer = document.getElementById('app-bg-image');
    if (!layer || !appBgState.url) return;

    const safeUrl = `url("${String(appBgState.url).replace(/["\\]/g, '\\$&')}")`;
    // 时钟处于上/下横条模式时强制 cover：壁纸铺满整个窗口，让横条区域也有完整图案
    const fit = _clockVertical() ? 'cover' : (appBgState.fit || 'fit');

    // Cover / stretch modes fill the whole container — no gradient needed
    if (fit === 'cover') {
        const ox = appBgState.offsetX ?? 50;
        const oy = appBgState.offsetY ?? 50;
        layer.style.background = `${safeUrl} ${ox}% ${oy}% / cover no-repeat`;
        return;
    }
    if (fit === 'stretch') {
        layer.style.background = `${safeUrl} center / 100% 100% no-repeat`;
        return;
    }

    // Fit mode: width=100%, auto height; add seamless gradient above when short
    if (!appBgState.gradient || !appBgState.topColor) {
        layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
        return;
    }

    // Load image to calculate rendered height vs container height
    const img = new Image();
    img.onload = () => {
        const cw = layer.clientWidth;
        const ch = layer.clientHeight;
        if (!cw || !ch || !img.naturalWidth) {
            layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
            return;
        }
        const renderedH = cw * (img.naturalHeight / img.naturalWidth);
        if (renderedH >= ch) {
            // Image fills or overflows the container — no gradient needed
            layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
        } else {
            // Image is short — fill the gap above with the image's top color so
            // it blends seamlessly (no darkened band at the top).
            const pct = ((ch - renderedH) / ch) * 100;
            const c = appBgState.topColor;
            layer.style.background =
                `${safeUrl} bottom center / 100% auto no-repeat,` +
                `linear-gradient(to bottom, ${c} 0%, ${c} ${pct}%, ${c} 100%)`;
        }
    };
    img.onerror = () => {
        layer.style.background = `${safeUrl} bottom center / 100% auto no-repeat`;
    };
    img.src = appBgState.url;
}

async function applyAppBackgroundSetting(image, opacity, blur, gradient, fit, offsetX, offsetY) {
    const layer = document.getElementById('app-bg-image');
    if (!layer) return;

    const safeOpacity = Math.max(0, Math.min(100, Number(opacity) || 0)) / 100;
    const safeBlur = Math.max(0, Math.min(50, Number(blur) || 0));
    const hasImage = Boolean(image && safeOpacity > 0);

    if (!hasImage) {
        layer.style.background = '';
        layer.style.opacity = '0';
        layer.style.filter = 'none';
        layer.style.inset = '0';
        document.body.classList.remove('has-app-bg');
        appBgState = { url: '', topColor: '', gradient: true, opacity: 0, blur: 0, fit: 'fit', offsetX: 50, offsetY: 50 };
        return;
    }

    // Resolve image path (with caching)
    let resolved = image || '';
    if (lastResolvedAppBg.image === image && lastResolvedAppBg.path) {
        resolved = lastResolvedAppBg.path;
    } else {
        try {
            resolved = await pywebview.api.resolve_background_image(image || '');
            lastResolvedAppBg = { image: image || '', path: resolved };
        } catch (e) {
            console.warn('resolve_background_image:', e);
        }
    }

    if (!resolved) {
        layer.style.background = '';
        layer.style.opacity = '0';
        layer.style.inset = '0';
        document.body.classList.remove('has-app-bg');
        return;
    }

    document.body.classList.add('has-app-bg');
    layer.style.opacity = String(safeOpacity);
    layer.style.filter = safeBlur > 0 ? `blur(${safeBlur}px)` : 'none';
    // 模糊会柔化图层边缘产生透明边，向外扩一圈抵消（上限 40px）
    layer.style.inset = safeBlur > 0 ? `-${Math.min(safeBlur, 40)}px` : '0';

    const safeFit = fit || 'fit';
    // Fetch top-edge color for gradient (only in fit mode with gradient enabled)
    let topColor = '';
    if (safeFit === 'fit' && gradient) {
        try {
            topColor = await pywebview.api.get_clock_bg_top_color(image || '');
        } catch (e) {
            console.warn('get_clock_bg_top_color:', e);
        }
    }

    appBgState = {
        url: resolved, topColor, gradient: !!gradient,
        opacity: safeOpacity, blur: safeBlur, fit: safeFit,
        offsetX: offsetX ?? 50, offsetY: offsetY ?? 50,
    };
    applyAppBackgroundGradient();
}

window.addEventListener('resize', () => {
    if (!appBgState.url) return;
    if (_appBgResizeTimer) clearTimeout(_appBgResizeTimer);
    _appBgResizeTimer = setTimeout(applyAppBackgroundGradient, 200);
});

// Theme picker cards
const THEME_LIST = {
    dark: [
        { value: 'ayu-dark', name: 'Ayu Dark' },
        { value: 'ayu-mirage', name: 'Ayu Mirage' },
        { value: 'catppuccin', name: 'Catppuccin Mocha' },
        { value: 'catppuccin-macchiato', name: 'Catppuccin Macchiato' },
        { value: 'catppuccin-frappe', name: 'Catppuccin Frappe' },
        { value: 'flexoki-dark', name: 'Flexoki Dark' },
        { value: 'gruvbox', name: 'Gruvbox Dark' },
    ],
    light: [
        { value: 'ayu-light', name: 'Ayu Light' },
        { value: 'catppuccin-latte', name: 'Catppuccin Latte' },
        { value: 'flexoki-light', name: 'Flexoki Light' },
        { value: 'gruvbox-light', name: 'Gruvbox Light' },
    ],
};

const SUPPORTED_THEMES = new Set([
    ...THEME_LIST.dark.map(theme => theme.value),
    ...THEME_LIST.light.map(theme => theme.value),
]);

function normalizeColorscheme(scheme) {
    return SUPPORTED_THEMES.has(scheme) ? scheme : 'gruvbox';
}

function getThemeColors(scheme) {
    const tester = document.createElement('div');
    tester.setAttribute('data-colorscheme', scheme);
    tester.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(tester);
    const cs = getComputedStyle(tester);
    // Read raw palette tokens — derived vars like --bg resolve var() at :root scope
    const colors = {
        bg: cs.getPropertyValue('--nord0').trim(),
        surface: cs.getPropertyValue('--nord1').trim(),
        accent: cs.getPropertyValue('--nord8').trim(),
        text: cs.getPropertyValue('--nord4').trim(),
    };
    document.body.removeChild(tester);
    return colors;
}

function renderThemeCards(darkSel, lightSel, onSelectDark, onSelectLight) {
    const darkGrid = document.getElementById('theme-grid-dark');
    const lightGrid = document.getElementById('theme-grid-light');
    if (!darkGrid || !lightGrid) return;
    darkGrid.innerHTML = '';
    lightGrid.innerHTML = '';

    const makeCard = (theme, activeSel, onSelect) => {
        const c = getThemeColors(theme.value);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'theme-card' + (theme.value === activeSel ? ' active' : '');
        card.dataset.scheme = theme.value;
        card.innerHTML =
            `<div class="theme-swatches">` +
            `<span class="swatch" style="background:${c.bg}"></span>` +
            `<span class="swatch" style="background:${c.surface}"></span>` +
            `<span class="swatch" style="background:${c.accent}"></span>` +
            `<span class="swatch" style="background:${c.text}"></span>` +
            `</div>` +
            `<span class="theme-name">${theme.name}</span>`;
        card.addEventListener('click', () => onSelect(theme.value));
        return card;
    };

    THEME_LIST.dark.forEach(t => darkGrid.appendChild(makeCard(t, darkSel, onSelectDark)));
    THEME_LIST.light.forEach(t => lightGrid.appendChild(makeCard(t, lightSel, onSelectLight)));
}

// Font picker
// Each entry: { value: <css family name>, name: <display name>, preview: <text shown in the card> }
const AVAILABLE_FONTS = [
    { value: 'JetBrains Maple Mono', name: 'JetBrains Maple Mono', preview: 'Aa 0123' },
    { value: 'Departure Mono', name: 'Departure Mono', preview: 'Aa 0123' },
    { value: 'IoskeleyMono', name: 'IoskeleyMono', preview: 'Aa 0123' },
];

// Preload the bundled typefaces so the font-picker preview reflects each real
// font immediately. Without this, font-display:swap renders the inherited
// fallback (the modal's JetBrains) until the woff2 downloads — so e.g.
// Departure Mono appeared as JetBrains Mono until it loaded.
AVAILABLE_FONTS.forEach(f => {
    try { document.fonts.load(`20px "${f.value}"`); } catch (e) { /* ignore */ }
});

function applyFonts(fontUi, fontData, fontClock) {
    const root = document.documentElement;
    // Build a CSS font-family value. Returns null when val is empty so we
    // don't override the :root CSS defaults (which include the full fallback chain).
    const build = (val, fallbacks) => {
        const v = (val || '').trim();
        if (!v) return null;
        const quoted = /\s/.test(v) ? `"${v}"` : v;
        return `${quoted}, ${fallbacks}`;
    };
    const ui = build(fontUi, '"Symbols Nerd Font Mono", "Consolas", "Monaco", monospace');
    const data = build(fontData, '"JetBrains Maple Mono", monospace');
    const clock = build(fontClock, '"IoskeleyMono", monospace');
    if (ui) root.style.setProperty('--font-ui', ui);
    else root.style.removeProperty('--font-ui');
    if (data) root.style.setProperty('--font-data', data);
    else root.style.removeProperty('--font-data');
    if (clock) root.style.setProperty('--font-clock', clock);
    else root.style.removeProperty('--font-clock');
}

function renderFontCards(slot, selectedFont, onSelect) {
    const grid = document.getElementById('font-grid-' + slot);
    if (!grid) return;
    grid.innerHTML = '';

    AVAILABLE_FONTS.forEach(font => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'font-card' + (font.value === selectedFont ? ' active' : '');
        card.dataset.font = font.value;
        // Inline font-family so the preview reflects this font alone (not the inherited slot var).
        // Use SINGLE quotes for the family name: it's embedded in a double-quoted style attribute,
        // so double quotes here would truncate the attribute and break the font-family.
        const quoted = /\s/.test(font.value) ? `'${font.value}'` : font.value;
        card.innerHTML =
            `<span class="font-preview" style="font-family:${quoted}, monospace">${font.preview}</span>` +
            `<span class="font-name">${font.name}</span>`;
        card.addEventListener('click', () => {
            grid.querySelectorAll('.font-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');
            onSelect(font.value);
        });
        grid.appendChild(card);
    });
}

// Image picker (thumbnail grid)
function renderImagePicker(container, bgList, selected, onChange) {
    if (!container) return;
    container.innerHTML = '';

    const specials = [
        { value: '', icon: '\uf05e', labelKey: 'label-none' },
    ];

    const makeSpecial = (item) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'img-pick-card' + (item.value === selected ? ' active' : '');
        card.dataset.value = item.value;
        card.innerHTML =
            `<div class="img-pick-thumb img-pick-special"><span class="nf-icon">${item.icon}</span></div>` +
            `<span class="img-pick-name">${t(item.labelKey)}</span>`;
        card.addEventListener('click', () => {
            container.querySelectorAll('.img-pick-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');
            onChange(item.value);
        });
        return card;
    };

    const makeImage = (path) => {
        const name = path.replace(/^bg\//, '').replace(/^wp\//, '');
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'img-pick-card' + (path === selected ? ' active' : '');
        card.dataset.value = path;
        // 用户导入的壁纸(wp/)显示删除角标；内置壁纸(bg/)不可删
        const del = path.startsWith('wp/')
            ? `<span class="img-pick-del" title="${t('btn-del-bg')}"><span class="nf-icon"></span></span>` : '';
        card.innerHTML =
            del +
            `<div class="img-pick-thumb" style="background-image:url('${path.replace(/["\\]/g, '\\$&')}')"></div>` +
            `<span class="img-pick-name">${name}</span>`;
        card.title = name;
        card.addEventListener('click', () => {
            container.querySelectorAll('.img-pick-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');
            onChange(path);
        });
        if (path.startsWith('wp/')) {
            card.querySelector('.img-pick-del').addEventListener('click', (e) => {
                e.stopPropagation();   // 不触发展开选中
                e.preventDefault();
                showAppConfirm(t('confirm-del-bg') + '\n' + name, async () => {
                    try {
                        const ok = await pywebview.api.delete_wallpaper(path);
                        if (!ok) return;
                        const newList = await pywebview.api.get_bg_list();
                        const nextSel = path === selected ? '' : selected;
                        renderImagePicker(container, newList, nextSel, onChange);
                        if (nextSel === '' ) onChange('');   // 删的是当前选中 → 回到"无"
                    } catch (err) { console.warn('delete wallpaper:', err); }
                });
            });
        }
        return card;
    };

    // 导入壁纸：隐藏 <input type=file> → FileReader 读出 base64 → 后端保存 → 刷新并选中
    const makeImport = () => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'img-pick-card img-pick-special';
        card.innerHTML =
            `<div class="img-pick-thumb img-pick-special"><span class="nf-icon">\uf067</span></div>` +
            `<span class="img-pick-name">${t('btn-import-bg')}</span>`;
        card.title = t('btn-import-bg');
        card.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        const newPath = await pywebview.api.save_wallpaper(file.name, reader.result);
                        if (newPath) {
                            const newList = await pywebview.api.get_bg_list();
                            renderImagePicker(container, newList, newPath, onChange);
                            onChange(newPath);   // 导入后直接应用
                        }
                    } catch (e) { console.warn('import wallpaper:', e); }
                };
                reader.readAsDataURL(file);
            });
            document.body.appendChild(input);
            input.click();
            setTimeout(() => input.remove(), 2000);
        });
        return card;
    };

    specials.forEach(s => container.appendChild(makeSpecial(s)));
    container.appendChild(makeImport());
    bgList.forEach(p => container.appendChild(makeImage(p)));
}

// Segmented control helper
function initSegmented(container, value, onChange) {
    if (!container) return;
    const buttons = container.querySelectorAll('button');
    const setActive = (val) => {
        buttons.forEach(b => b.classList.toggle('active', b.dataset.value === val));
    };
    setActive(value);
    buttons.forEach(b => {
        b.addEventListener('click', () => {
            setActive(b.dataset.value);
            if (onChange) onChange(b.dataset.value);
        });
    });
    return { set: setActive };
}

// Clock background offset modal
let clockBgOffsetState = { x: 50, y: 50, url: '', onChange: null };

function openClockBgOffsetModal(url, offsetX, offsetY, onChange) {
    const overlay = document.getElementById('clockbg-offset-overlay');
    const resetBtn = document.getElementById('offset-reset');
    const doneBtn = document.getElementById('offset-done');
    if (!overlay) return;

    // Clone the preview to drop any previous drag listeners, then keep a live
    // reference so the onMove/onDown closures operate on the in-DOM element.
    let preview = document.getElementById('offset-preview');
    if (!preview) return;
    const newPreview = preview.cloneNode(true);
    preview.parentNode.replaceChild(newPreview, preview);
    preview = newPreview;

    clockBgOffsetState = { x: offsetX, y: offsetY, url: url || '', onChange };
    const safeUrl = String(url || '').replace(/["\\]/g, '\\$&');
    preview.style.backgroundImage = url ? `url("${safeUrl}")` : 'none';
    preview.style.backgroundSize = 'contain';
    preview.style.backgroundPosition = 'center';
    preview.style.backgroundRepeat = 'no-repeat';

    // Reset the highlight overlay from a previous session.
    let highlight = preview.querySelector('.offset-highlight');
    if (highlight) highlight.remove();
    highlight = document.createElement('div');
    highlight.className = 'offset-highlight';
    preview.appendChild(highlight);

    // Match the preview's aspect ratio to the real clock-section layer so the
    // cover-crop region shown here is the one actually behind the clock.
    const layer = document.getElementById('app-bg-image');
    let layerW = 0, layerH = 0;
    if (layer) { layerW = layer.clientWidth; layerH = layer.clientHeight; }
    if (layerW > 0 && layerH > 0) {
        const ph = 300;
        const pw = Math.max(120, Math.min(320, ph * (layerW / layerH)));
        preview.style.width = pw + 'px';
        preview.style.height = ph + 'px';
    }

    overlay.style.display = 'flex';

    // Image natural size — needed to compute which region of the full picture is
    // actually visible behind the clock (the highlighted box).
    let natural = { w: 0, h: 0 };
    if (url) {
        const dimImg = new Image();
        dimImg.onload = () => { natural = { w: dimImg.naturalWidth, h: dimImg.naturalHeight }; layoutHighlight(); };
        dimImg.src = url;
    }

    // Position the highlight box = the exact cover-crop region that will render.
    function layoutHighlight() {
        const cw = preview.clientWidth, ch = preview.clientHeight;
        if (!cw || !ch || !natural.w || !natural.h) { highlight.style.display = 'none'; return; }
        const nw = natural.w, nh = natural.h;
        // Full image scaled to "contain" (everything visible), centered.
        const cs = Math.min(cw / nw, ch / nh);
        const dispW = nw * cs, dispH = nh * cs;
        const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2;
        // Visible (cover) region as a fraction of the image.
        const coverScale = Math.max(cw / nw, ch / nh);
        const fx = Math.min(1, cw / (nw * coverScale));
        const fy = Math.min(1, ch / (nh * coverScale));
        const hw = fx * dispW, hh = fy * dispH;
        const x = offX + (clockBgOffsetState.x / 100) * (dispW - hw);
        const y = offY + (clockBgOffsetState.y / 100) * (dispH - hh);
        highlight.style.left = x + 'px';
        highlight.style.top = y + 'px';
        highlight.style.width = hw + 'px';
        highlight.style.height = hh + 'px';
        // Drag travel in preview pixels for a full 100% offset (per axis).
        highlight._travelW = dispW - hw;
        highlight._travelH = dispH - hh;
        highlight.style.display = 'block';
    }
    layoutHighlight();

    // Drag-to-adjust: moving the highlight box moves the visible region.
    let dragging = false;
    let startMouseX = 0, startMouseY = 0;
    let startX = 0, startY = 0;

    const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startMouseX;
        const dy = e.clientY - startMouseY;
        const tw = (highlight._travelW > 0) ? highlight._travelW : preview.clientWidth;
        const th = (highlight._travelH > 0) ? highlight._travelH : preview.clientHeight;
        // Dragging the region right increases the offset (region follows the mouse).
        let nx = startX + (tw > 0 ? (dx / tw) * 100 : 0);
        let ny = startY + (th > 0 ? (dy / th) * 100 : 0);
        nx = Math.max(0, Math.min(100, nx));
        ny = Math.max(0, Math.min(100, ny));
        clockBgOffsetState.x = nx;
        clockBgOffsetState.y = ny;
        layoutHighlight();
        if (clockBgOffsetState.onChange) clockBgOffsetState.onChange(nx, ny);
    };

    const onUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    const onDown = (e) => {
        dragging = true;
        startMouseX = e.clientX;
        startMouseY = e.clientY;
        startX = clockBgOffsetState.x;
        startY = clockBgOffsetState.y;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    };

    preview.addEventListener('mousedown', onDown);

    const newReset = resetBtn.cloneNode(true);
    resetBtn.parentNode.replaceChild(newReset, resetBtn);
    newReset.addEventListener('click', () => {
        clockBgOffsetState.x = 50;
        clockBgOffsetState.y = 50;
        layoutHighlight();
        if (clockBgOffsetState.onChange) clockBgOffsetState.onChange(50, 50);
    });

    const newDone = doneBtn.cloneNode(true);
    doneBtn.parentNode.replaceChild(newDone, doneBtn);
    newDone.addEventListener('click', () => {
        overlay.style.display = 'none';
    });
}

function applyFontSize(pct) {
    // Scale only font sizes (via --font-scale), leaving the layout's px
    // dimensions untouched. Previously this used body zoom, which resized
    // the whole layout along with the text.
    document.documentElement.style.setProperty('--font-scale', pct / 100);
    // Re-apply each card's per-card font scale (relative to the global scale).
    allCards().forEach(card => applyCardFontScale(card.id));
    applyClockFontScale();
    // Fit the process list to the new font size (defer one frame so heights settle).
    setTimeout(recalcProcLimit, 0);
}

function applyUiFontSize(pct) {
    // UI font scale (settings panel, popups/modals) is independent from the
    // card font scale, driven by its own --ui-scale variable.
    document.documentElement.style.setProperty('--ui-scale', pct / 100);
}

let _featureToggles = {};

/** Whether a layout-controlled section may be shown, honoring BOTH the feature
 * toggle and the layout's per-card hidden flag. Sections removed in the layout
 * must stay hidden even when their feature toggle is later re-applied. */
function _sectionVisible(id) {
    const card = getCard(id);
    if (!card || card.hidden()) return false;
    return card.feature ? _featureToggles[card.feature] !== false : true;
}

function applyFeatureToggles(toggles) {
    _featureToggles = toggles || {};
    const ft = _featureToggles;
    // Hide sections for disabled features or deleted-in-layout cards
    const fpsSection = document.getElementById('fps-section');
    if (fpsSection) fpsSection.style.display = _sectionVisible('fps-section') ? '' : 'none';
    const musicSection = document.getElementById('music-section');
    if (musicSection) musicSection.style.display = _sectionVisible('music-section') ? '' : 'none';
    const procSection = document.getElementById('proc-section');
    if (procSection) procSection.style.display = _sectionVisible('proc-section') ? '' : 'none';
    const clockBg = document.getElementById('app-bg-image');
    if (clockBg) clockBg.style.display = ft.clock_bg !== false ? '' : 'none';
    // 界面背景开关关闭时，卡片恢复不透明表面
    document.body.classList.toggle('has-app-bg', ft.clock_bg !== false && Boolean(appBgState.url));
    const weatherEl = document.getElementById('h-weather-compact');
    if (weatherEl) weatherEl.style.display = (ft.weather !== false) ? '' : 'none';
    // Top brightness/volume controls
    _topControlEnabled = ft.top_control !== false;
    const topControlPopup = document.getElementById('top-control-popup');
    if (topControlPopup) topControlPopup.style.display = _topControlEnabled ? '' : 'none';
    if (!_topControlEnabled) {
        // ensure it isn't left visible when the feature is turned off
        if (topControlPopup) topControlPopup.classList.remove('visible');
        _topControlVisible = false;
        _cursorOverTopControl = false;
        if (_topControlHideTimer) { clearTimeout(_topControlHideTimer); _topControlHideTimer = null; }
    }
}
