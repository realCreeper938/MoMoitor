/* ── 插件系统前端运行时 ────────────────────────────────────────────
 * 本文件必须在 boot.js 之前加载（index.html 中位于 settings.js 之后）。
 *
 * 它提供两套东西：
 * 1. window.PluginApi —— 供插件脚本调用的 API（注册卡片/设置项/事件等）
 * 2. initPlugins()    —— 启动时拉取后端收集的插件前端资源并注入页面
 *
 * 插件 frontend/main.js 的加载发生在 initPlugins() 中（boot 阶段），
 * 因此插件脚本可以安全地引用本文件定义的 PluginApi。
 */

/* eslint-disable no-restricted-globals */
(function () {
    'use strict';

    /* ── 内部状态 ───────────────────────────────────────────── */
    const cards = {};            // id -> { def, el, timer }
    const listeners = {};        // event -> [fn]
    const readyHooks = [];
    const pollHooks = [];
    const settingsOpenHooks = [];
    const settingsSaveHooks = [];
    const settingsSavedHooks = [];
    const settingsSections = []; // { tab, id, title, html, onLoad, onSave }
    let booted = false;

    function _safeCall(fn, args) {
        try { return fn.apply(null, args); }
        catch (e) { console.warn('[plugin] hook error:', e); }
    }

    function _dispatch(event, data) {
        (listeners[event] || []).forEach(fn => _safeCall(fn, [data]));
    }

    /* ── 卡片工具 ───────────────────────────────────────────── */
    function _titleText(title) {
        if (title && typeof title === 'object') {
            return title[getCurrentLang()] || title.en || title.zh || '';
        }
        return String(title == null ? '' : title);
    }

    function _tick(card) {
        const def = card.def;
        const content = card.el.querySelector('.box-content');
        if (!content) return;
        const render = (data) => {
            try {
                if (def.render) def.render(content, data);
                else if (data !== undefined) content.textContent = String(data);
            } catch (e) { console.warn('[plugin] card render error:', e); }
        };
        if (def.getData) {
            Promise.resolve()
                .then(() => def.getData())
                .then(render)
                .catch(e => console.warn('[plugin] card getData error:', e));
        } else {
            render(undefined);
        }
    }

    function _buildCard(def) {
        const grid = document.querySelector('.term-grid');
        if (!grid) return null;
        const title = _titleText(def.title);
        const el = document.createElement('div');
        el.className = 'term-box';
        el.id = def.id;
        el.innerHTML =
            '<div class="layout-drag-handle">⠿</div>' +
            '<div class="corner-label">' + (def.label || title || '') + '</div>' +
            '<div class="box-header">' + (title || def.id) + '</div>' +
            '<div class="box-content"></div>';
        grid.appendChild(el);
        return el;
    }

    function registerCard(def) {
        if (!def || !def.id) { console.warn('[plugin] registerCard requires { id }'); return; }
        if (cards[def.id]) { console.warn('[plugin] card already registered:', def.id); return; }

        const el = _buildCard(def);
        if (!el) return;

        // 接入现有布局系统
        if (LAYOUT_IDS.indexOf(def.id) === -1) LAYOUT_IDS.push(def.id);
        if (def.resizable !== false && RESIZABLE_IDS.indexOf(def.id) === -1) {
            RESIZABLE_IDS.push(def.id);
        }
        DEFAULT_LAYOUT[def.id] = Object.assign(
            { col: 2, row: 6, span: 1, hidden: false },
            def.layout || {}
        );
        CARD_META[def.id] = {
            name: _titleText(def.title) || def.id,
            color: def.color || 'var(--accent)',
            value: '—', pct: '', lines: [],
        };

        const card = { def, el, timer: null };
        cards[def.id] = card;
        // 先立即渲染一次，避免启动期间卡片空白
        _tick(card);
    }

    /* ── 公开 API ───────────────────────────────────────────── */
    const PluginApi = {
        /* 卡片 */
        registerCard,

        /* 生命周期与事件 */
        onReady(fn) { if (typeof fn === 'function') readyHooks.push(fn); },
        onPoll(fn) { if (typeof fn === 'function') pollHooks.push(fn); },
        on(event, fn) {
            if (!event || typeof fn !== 'function') return;
            (listeners[event] = listeners[event] || []).push(fn);
        },
        emit(event, data) { _dispatch(event, data); },

        /* 设置 */
        onSettingsOpen(fn) { if (typeof fn === 'function') settingsOpenHooks.push(fn); },
        onSettingsSave(fn) { if (typeof fn === 'function') settingsSaveHooks.push(fn); },
        onSettingsSaved(fn) { if (typeof fn === 'function') settingsSavedHooks.push(fn); },
        registerSettingsGroup(section) {
            if (!section || !section.id) return;
            settingsSections.push(section);
            const tab = document.getElementById('tab-' + section.tab);
            if (tab) {
                const group = document.createElement('div');
                group.className = 'setting-group';
                group.id = 'plugin-group-' + section.id;
                group.innerHTML =
                    '<div class="setting-group-title">' + _titleText(section.title || {}) + '</div>' +
                    (section.html || '');
                tab.appendChild(group);
            }
        },
        getSettings() { return window._appSettings || {}; },
        async saveSettings() {
            if (window.pywebview && window.pywebview.api && window.pywebview.api.save_settings) {
                return window.pywebview.api.save_settings(window._appSettings || {});
            }
        },

        /* 国际化 */
        addI18n(lang, dict) {
            if (!LANGS[lang]) LANGS[lang] = {};
            Object.assign(LANGS[lang], dict);
            if (lang === getCurrentLang()) applyLang(lang);
        },
        t: (key) => t(key),

        /* 样式与 DOM */
        addStyle(css) {
            if (!css) return;
            const style = document.createElement('style');
            style.setAttribute('data-plugin-style', '1');
            style.textContent = css;
            document.head.appendChild(style);
        },
        addHead(html) {
            if (!html) return;
            const frag = document.createElement('template');
            frag.innerHTML = html;
            while (frag.content.firstChild) document.head.appendChild(frag.content.firstChild);
        },
        addBody(html) {
            if (!html) return;
            const root = document.getElementById('plugin-body-root');
            if (!root) return;
            const frag = document.createElement('template');
            frag.innerHTML = html;
            while (frag.content.firstChild) root.appendChild(frag.content.firstChild);
        },

        /* 杂项工具 */
        el: (id) => document.getElementById(id),
        toast: (msg) => showToast(msg),
        openExternal(url) {
            if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
                window.pywebview.api.open_external(url).catch(() => window.open(url, '_blank'));
            } else {
                window.open(url, '_blank');
            }
        },

        /* ── 内部（boot.js / Python 调用）── */
        bootstrap() {
            if (booted) return;
            booted = true;
            Object.keys(cards).forEach(id => {
                const card = cards[id];
                if (card.def.interval && card.timer === null) {
                    card.timer = setInterval(() => _tick(card), card.def.interval);
                }
            });
            readyHooks.forEach(fn => _safeCall(fn, []));
        },
        dispatchPoll(data) { pollHooks.forEach(fn => _safeCall(fn, [data])); },
        _notifySettingsOpen() {
            settingsOpenHooks.forEach(fn => _safeCall(fn, []));
            settingsSections.forEach(s => _safeCall(s.onLoad, []));
        },
        _notifySettingsSave(s) {
            settingsSaveHooks.forEach(fn => _safeCall(fn, [s]));
            settingsSections.forEach(sec => _safeCall(sec.onSave, [s]));
        },
        _notifySettingsSaved(s) { settingsSavedHooks.forEach(fn => _safeCall(fn, [s])); },
        _receiveFromPython(payload) {
            if (!payload) return;
            _dispatch(payload.event, payload.data);
        },
    };

    window.PluginApi = PluginApi;

    /* ── 主题注入 ───────────────────────────────────────────── */
    function applyPluginThemes(themes) {
        if (!themes || !themes.length) return;
        let style = document.getElementById('plugin-theme-styles');
        if (!style) {
            style = document.createElement('style');
            style.id = 'plugin-theme-styles';
            document.head.appendChild(style);
        }
        const sel = document.getElementById('opt-colorscheme');
        let css = '';
        themes.forEach(th => {
            const colors = th.colors || {};
            const vars = Object.keys(colors).map(k => '--' + k + ': ' + colors[k] + ';').join('');
            const value = String(th.value || '').replace(/"/g, '\\"');
            if (value) css += '[data-colorscheme="' + value + '"]{' + vars + '}\n';
            const group = th.dark === false ? 'light' : 'dark';
            if (THEME_LIST[group] && !THEME_LIST[group].some(x => x.value === th.value)) {
                THEME_LIST[group].push({ value: th.value, name: th.name || th.value });
            }
            // 同步加入隐藏的配色下拉框，否则 colorschemeSel.value 无法选中该主题，
            // 保存设置时会把旧主题写回，插件主题永远不会被记住。
            if (sel && th.value && !sel.querySelector('option[value="' + CSS.escape(th.value) + '"]')) {
                const opt = document.createElement('option');
                opt.value = th.value;
                opt.textContent = th.name || th.value;
                const optgroup = Array.from(sel.querySelectorAll('optgroup'))
                    .find(og => og.getAttribute('label').toLowerCase() === group);
                (optgroup || sel).appendChild(opt);
            }
        });
        style.textContent += css;
    }

    /* ── 启动初始化 ─────────────────────────────────────────── */
    window.initPlugins = async function initPlugins() {
        if (!(window.pywebview && window.pywebview.api)) return;
        try {
            const bundle = await window.pywebview.api.get_plugin_frontend();
            const plugins = (bundle && bundle.plugins) || [];
            const frag = document.createElement('template');
            plugins.forEach(p => {
                if (p.head) { frag.innerHTML = p.head; while (frag.content.firstChild) document.head.appendChild(frag.content.firstChild); }
                if (p.styles) PluginApi.addStyle(p.styles);
            });
            const root = document.getElementById('plugin-body-root');
            plugins.forEach(p => {
                if (p.body && root) { frag.innerHTML = p.body; while (frag.content.firstChild) root.appendChild(frag.content.firstChild); }
            });
            plugins.forEach(p => {
                if (p.scripts) {
                    const s = document.createElement('script');
                    s.setAttribute('data-plugin-script', p.id || '');
                    s.textContent = p.scripts;
                    document.body.appendChild(s);
                }
            });
        } catch (e) { console.warn('[plugin] initPlugins:', e); }

        try {
            const themes = await window.pywebview.api.get_plugin_themes();
            applyPluginThemes(themes || []);
        } catch (e) { console.warn('[plugin] themes:', e); }

        try {
            window._pluginDataSources = await window.pywebview.api.get_plugin_data_sources() || [];
        } catch (e) { window._pluginDataSources = []; }
    };

    /* ── 设置页插件列表 ─────────────────────────────────────── */
    window.renderPluginList = async function renderPluginList() {
        const list = document.getElementById('plugin-list');
        if (!list) return;
        let plugins = [];
        try { plugins = await window.pywebview.api.get_plugins() || []; }
        catch (e) { console.warn('[plugin] get_plugins:', e); }

        if (!plugins.length) {
            list.innerHTML = '<div class="plugin-empty">' + t('plugins-empty') + '</div>';
            return;
        }
        list.innerHTML = plugins.map(p => {
            const typeLabel = t('plugin-type-' + p.type) || p.type;
            const rowClass = p.valid ? 'plugin-row' : 'plugin-row plugin-invalid';
            const err = p.valid ? '' : '<div class="plugin-error">' + escapeHtml(p.error || '') + '</div>';
            const homepage = (p.homepage && /^https?:\/\//i.test(p.homepage))
                ? '<a class="plugin-homepage" href="' + escapeHtml(p.homepage) + '" target="_blank" rel="noopener">' + escapeHtml(p.homepage.replace(/^https?:\/\//, '')) + '</a>'
                : '';
            return '<div class="' + rowClass + '">'
                + '<div class="plugin-toggle">'
                + '<label class="toggle"><input type="checkbox" class="plugin-switch" data-id="' + escapeHtml(p.id) + '"'
                + (p.enabled ? ' checked' : '') + (p.valid ? '' : ' disabled') + '><span class="toggle-slider"></span></label>'
                + '</div>'
                + '<div class="plugin-info">'
                + '<div class="plugin-name">' + escapeHtml(p.name) + ' <span class="plugin-ver">v' + escapeHtml(p.version) + '</span></div>'
                + '<div class="plugin-meta">'
                + '<span class="plugin-tag plugin-tag-' + p.type + '">' + escapeHtml(typeLabel) + '</span>'
                + (p.author ? '<span class="plugin-author">' + escapeHtml(p.author) + '</span>' : '')
                + '</div>'
                + (p.description ? '<div class="plugin-desc">' + escapeHtml(p.description) + '</div>' : '')
                + homepage + err
                + '</div></div>';
        }).join('');

        list.querySelectorAll('.plugin-switch').forEach(cb => {
            cb.addEventListener('change', async () => {
                try {
                    const res = await window.pywebview.api.set_plugin_enabled(cb.dataset.id, cb.checked);
                    if (res && res.restart_required) {
                        // 同步本地设置缓存，避免下次保存设置时把本次开关覆盖回去
                        window._appSettings = window._appSettings || {};
                        window._appSettings.plugins = window._appSettings.plugins || { enabled: [] };
                        const en = window._appSettings.plugins.enabled;
                        const idx = en.indexOf(cb.dataset.id);
                        if (cb.checked && idx < 0) en.push(cb.dataset.id);
                        if (!cb.checked && idx >= 0) en.splice(idx, 1);
                        showToast(t('plugin-restart-hint'));
                    }
                } catch (e) {
                    console.warn('[plugin] set_plugin_enabled:', e);
                    cb.checked = !cb.checked;
                }
            });
        });
    };
})();
