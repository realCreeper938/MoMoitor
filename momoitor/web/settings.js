function initSettings() {
    const overlay = document.getElementById('settings-overlay');
    const saveBtn = document.getElementById('settings-save');
    const closeBtn = document.getElementById('settings-close');

    // Tab elements
    const tabBtns = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    // General
    const languageSel = document.getElementById('opt-language');
    const fontsizeRange = document.getElementById('opt-fontsize');
    const fontsizeVal = document.getElementById('fontsize-val');
    const fullscreenChk = document.getElementById('opt-fullscreen');
    const autostartChk = document.getElementById('opt-autostart');
    const hoverHighlightChk = document.getElementById('opt-hover-highlight');
    const hoverAnimChk = document.getElementById('opt-hover-anim');
    const lyricAnimChk = document.getElementById('opt-lyric-anim');
    const updateNotifyChk = document.getElementById('opt-update-notify');

    // Server mode
    const serverModeChk = document.getElementById('opt-server-mode');
    const serverHostInput = document.getElementById('opt-server-host');
    const serverPortInput = document.getElementById('opt-server-port');
    const serverAuthChk = document.getElementById('opt-server-auth');
    const serverUserInput = document.getElementById('opt-server-user');
    const serverPassInput = document.getElementById('opt-server-pass');
    const debugLogsChk = document.getElementById('opt-debug-logs');
    const debugChk = document.getElementById('opt-debug');
    const autoLaunchChk = document.getElementById('opt-auto-launch');

    // Data
    const intervalSel = document.getElementById('opt-interval');
    const datasourceSel = document.getElementById('opt-datasource');
    const gpuSel = document.getElementById('opt-gpu');
    const metingUrlInput = document.getElementById('opt-meting-url');
    const lyricsWhitelistInput = document.getElementById('opt-lyrics-whitelist');
    const lyricsTranslateChk = document.getElementById('opt-lyrics-translate');

    // Weather
    const wxLat = document.getElementById('opt-wx-lat');
    const wxLon = document.getElementById('opt-wx-lon');
    const wxKid = document.getElementById('opt-wx-kid');
    const wxSub = document.getElementById('opt-wx-sub');
    const wxKey = document.getElementById('opt-wx-key');

    // Monitor
    const monitorSel = document.getElementById('opt-monitor');
    const hideMissingChk = document.getElementById('opt-hide-missing');

    // Theme
    const colorschemeSel = document.getElementById('opt-colorscheme');

    // Clock (personalization > Time subtab)
    const clockFormatSel = document.getElementById('opt-clockformat');
    let clockFormatValue = '24';
    const clockShowSecondsChk = document.getElementById('opt-show-seconds');

    // Clock sidebar background (horizontal mode)
    const clockBgGroup = document.getElementById('clock-bg-group');
    const clockBgImgPicker = document.getElementById('clockbgimg-picker');
    let clockBgImgValue = '';
    const clockBgFitSel = document.getElementById('opt-clockbgfit');
    let clockBgFitValue = 'fit';
    const clockBgOpacityRange = document.getElementById('opt-clockbgopacity');
    const clockBgOpacityVal = document.getElementById('clockbgopacity-val');
    const clockBgBlurRange = document.getElementById('opt-clockbgblur');
    const clockBgBlurVal = document.getElementById('clockbgblur-val');
    const clockBgGradientChk = document.getElementById('opt-clockbggradient');
    const clockBgGradientRow = document.getElementById('clockbg-gradient-row');
    const clockBgGradientDesc = document.getElementById('clockbg-gradient-desc');
    const clockBgOffsetRow = document.getElementById('clockbg-offset-row');
    const clockBgOffsetDesc = document.getElementById('clockbg-offset-desc');
    const clockBgOffsetBtn = document.getElementById('opt-clockbg-offset');
    let clockBgOffsetX = 50;
    let clockBgOffsetY = 50;
    const applyClockBg = () => applyClockBackgroundSetting(
        clockBgImgValue, clockBgOpacityRange.value, clockBgBlurRange.value,
        clockBgGradientChk.checked, clockBgFitValue, clockBgOffsetX, clockBgOffsetY
    );

    // Font slots
    const subtabBtns = document.querySelectorAll('.subtab-btn');
    const subtabContents = document.querySelectorAll('.subtab-content');
    let fontUiValue = 'JetBrains Maple Mono';
    let fontDataValue = 'IoskeleyMono';
    let fontClockValue = 'Departure Mono';

    function updateClockBgGradientVisibility() {
        // Gradient only applies to "fit" mode
        const show = clockBgFitValue === 'fit';
        if (clockBgGradientRow) clockBgGradientRow.style.display = show ? '' : 'none';
        if (clockBgGradientDesc) clockBgGradientDesc.style.display = show ? '' : 'none';
    }

    function updateClockBgOffsetVisibility() {
        // Offset only applies to "cover" mode
        const show = clockBgFitValue === 'cover';
        if (clockBgOffsetRow) clockBgOffsetRow.style.display = show ? '' : 'none';
        if (clockBgOffsetDesc) clockBgOffsetDesc.style.display = show ? '' : 'none';
    }

    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    // Sub-tab switching (Appearance / Fonts inside Theme tab)
    subtabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            subtabBtns.forEach(b => b.classList.remove('active'));
            subtabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const target = document.getElementById('subtab-' + btn.dataset.subtab);
            if (target) target.classList.add('active');
        });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        const isTyping = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';

        if (e.key === 's' || e.key === 'S') {
            dismissFirstLaunchHint();   // 按 S 打开设置时关掉首次提示
            if (!isTyping) {
                if (overlay.style.display === 'none') {
                    openSettings();
                } else {
                    closeSettings();
                }
            }
        }
        if (e.key === 'Escape') {
            if (overlay.style.display !== 'none') {
                closeSettings();
            } else if (!isTyping) {
                const exitPopup = document.getElementById('exit-popup');
                if (exitPopup) exitPopup.style.display = 'flex';
                pywebview.api.close_app();
            }
        }
        if (e.key === 'F2') {
            e.preventDefault();
            pywebview.api.minimize_window();
        }
        if (e.key === 'r' || e.key === 'R') {
            if (overlay.style.display === 'none' && !isTyping) {
                e.preventDefault();
                if (pollTimer) clearTimeout(pollTimer);
                pollTimer = null;
                poll(pollGeneration);
            }
        }
        if (e.ctrlKey && e.key === 'F5') {
            e.preventDefault();
            refreshWeather();
            refreshWeatherDetail();
            refreshAirQuality();
            refreshAlerts();
            refreshWeatherCard();
            refreshMusic();
            poll();
        }
    });

    /* About tab — program/Python/pywebview/browser/HW backend versions */
    async function loadAboutInfo() {
        const list = document.getElementById('about-list');
        if (!list) return;
        let info = {};
        try {
            info = await pywebview.api.get_app_info();
        } catch (e) { console.warn('get_app_info:', e); }
        // Browser engine version from the user agent (WebView2 in desktop mode)
        const ua = navigator.userAgent || '';
        const chrome = ua.match(/Chrome\/([\d.]+)/);
        const edg = ua.match(/Edg\/([\d.]+)/);
        let browser;
        if (edg) browser = 'WebView2 (Edge ' + edg[1] + (chrome ? ' · Chromium ' + chrome[1] : '') + ')';
        else if (chrome) browser = 'Chromium ' + chrome[1];
        else browser = ua || '--';
        const backend = info.backend || {};
        const rows = [
            { key: 'about-program', value: info.program || '--' },
            { key: 'about-author', value: info.author || '--' },
            { key: 'about-project', value: info.homepage || '--', link: info.homepage || '' },
            { key: 'about-python', value: info.python || '--' },
            { key: 'about-pywebview', value: info.pywebview || '--' },
            { key: 'about-browser', value: browser },
            { key: 'about-backend', value: (backend.name || '--') + (backend.version ? ' ' + backend.version : '') },
        ];
        list.innerHTML = rows.map(r => {
            // 项目地址渲染为可点击链接（复用 i18n-link 委托打开系统浏览器）
            const valueHtml = (r.link && /^https?:\/\//i.test(r.link))
                ? '<a class="i18n-link about-row-link" href="' + escapeHtml(r.link) + '" target="_blank" rel="noopener">' + escapeHtml(r.link) + '</a>'
                : '<span class="about-row-value mono">' + escapeHtml(r.value) + '</span>';
            return '<div class="about-row">'
                + '<span class="about-row-label" data-i18n="' + r.key + '">' + t(r.key) + '</span>'
                + valueHtml
                + '</div>';
        }).join('');
    }

    async function openSettings() {
        const s = await pywebview.api.get_settings();

        const g = s.general || {};
        const d = s.display || {};
        const ck = s.clock || {};
        const f = s.fonts || {};
        const w = s.weather || {};
        const m = s.music || {};
        const ly = s.lyrics || {};
        const sv = s.server || {};

        // General
        languageSel.value = g.language || 'en';
        fontsizeRange.value = g.font_size || 100;
        fontsizeVal.textContent = (g.font_size || 100) + '%';
        fullscreenChk.checked = g.fullscreen !== false;
        hoverHighlightChk.checked = g.hover_highlight !== false;
        applyHoverHighlight(g.hover_highlight !== false);
        hoverAnimChk.checked = g.hover_animation !== false;
        applyHoverAnim(g.hover_animation !== false);
        lyricAnimChk.checked = ly.animation === true;
        applyLyricAnim(ly.animation === true);
        autostartChk.checked = await pywebview.api.get_autostart();
        updateNotifyChk.checked = g.update_check_enabled !== false;

        // Data
        intervalSel.value = String(g.refresh_interval || 1000);
        datasourceSel.value = g.data_source || 'lhm';
        metingUrlInput.value = m.meting_api_base || '';
        lyricsWhitelistInput.value = ly.process_whitelist || '';
        lyricsTranslateChk.checked = ly.auto_translate === true;
        applyLyricAutoTranslate(ly.auto_translate === true);

        // GPU list
        try {
            const gpus = await pywebview.api.get_gpu_list();
            gpuSel.innerHTML = '';
            gpus.forEach((name, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = name;
                gpuSel.appendChild(opt);
            });
            if (gpus.length === 0) {
                const opt = document.createElement('option');
                opt.value = '0';
                opt.textContent = 'Auto';
                gpuSel.appendChild(opt);
            }
            gpuSel.value = String(d.gpu_index || 0);
        } catch (e) { console.warn('get_gpu_list:', e); }

        // Weather
        wxLat.value = w.lat || '';
        wxLon.value = w.lon || '';
        wxKid.value = w.key_id || '';
        wxSub.value = w.project_id || '';
        wxKey.value = w.private_key || '';

        // Monitor
        try {
            const monitors = await pywebview.api.get_monitors();
            monitorSel.innerHTML = '';
            monitors.forEach((m, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = `${m.name || 'Monitor'} (${m.width}x${m.height})`;
                monitorSel.appendChild(opt);
            });
            monitorSel.value = d.monitor || 0;
        } catch (e) { console.warn('get_monitors:', e); }
        hideMissingChk.checked = d.hide_when_monitor_missing === true;

        // Theme
        colorschemeSel.value = g.colorscheme || 'gruvbox';
        renderThemeCards(g.colorscheme || 'gruvbox', (scheme) => {
            colorschemeSel.value = scheme;
            applyColorscheme(scheme);
        });
        // Fonts
        fontUiValue = f.ui || 'JetBrains Maple Mono';
        fontDataValue = f.data || 'IoskeleyMono';
        fontClockValue = f.clock || 'Departure Mono';
        renderFontCards('ui', fontUiValue, (v) => { fontUiValue = v; applyFonts(fontUiValue, fontDataValue, fontClockValue); });
        renderFontCards('data', fontDataValue, (v) => { fontDataValue = v; applyFonts(fontUiValue, fontDataValue, fontClockValue); });
        renderFontCards('clock', fontClockValue, (v) => { fontClockValue = v; applyFonts(fontUiValue, fontDataValue, fontClockValue); });
        try {
            const bgList = await pywebview.api.get_bg_list();
            clockBgImgValue = ck.bg_image || '';
            renderImagePicker(clockBgImgPicker, bgList, clockBgImgValue, (val) => {
                clockBgImgValue = val;
                lastResolvedClockBg = { image: '', path: '' };
                applyClockBg();
            });
        } catch (e) { console.warn('get_bg_list:', e); }

        // Clock sidebar background
        clockBgOpacityRange.value = String(ck.bg_opacity ?? 80);
        clockBgOpacityVal.textContent = (ck.bg_opacity ?? 80) + '%';
        clockBgBlurRange.value = String(ck.bg_blur || 0);
        clockBgBlurVal.textContent = (ck.bg_blur || 0) + 'px';
        clockBgGradientChk.checked = ck.bg_gradient !== false;
        clockBgFitValue = ck.bg_fit || 'fit';
        if (!clockBgFitSel.dataset.init) {
            initSegmented(clockBgFitSel, clockBgFitValue, (v) => {
                clockBgFitValue = v;
                updateClockBgGradientVisibility();
                updateClockBgOffsetVisibility();
                applyClockBg();
            });
            clockBgFitSel.dataset.init = '1';
        } else {
            clockBgFitSel.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === clockBgFitValue));
        }
        clockBgOffsetX = ck.bg_offset_x ?? 50;
        clockBgOffsetY = ck.bg_offset_y ?? 50;
        updateClockBgGradientVisibility();
        updateClockBgOffsetVisibility();

        // Clock format & show-seconds (Time subtab)
        clockFormatValue = ck.clock_24h !== false ? '24' : '12';
        if (!clockFormatSel.dataset.init) {
            initSegmented(clockFormatSel, clockFormatValue, (v) => {
                clockFormatValue = v;
                _clock24 = (v === '24');
            });
            clockFormatSel.dataset.init = '1';
        } else {
            clockFormatSel.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === clockFormatValue));
        }
        clockShowSecondsChk.checked = ck.clock_show_seconds !== false;
        _clockShowSeconds = clockShowSecondsChk.checked;
        clockShowSecondsChk.addEventListener('change', () => {
            _clockShowSeconds = clockShowSecondsChk.checked;
        });

        // Server mode
        serverModeChk.checked = sv.mode === true;
        serverHostInput.value = sv.host || '0.0.0.0';
        serverPortInput.value = sv.port || 20622;
        serverAuthChk.checked = sv.auth_enabled === true;
        serverUserInput.value = sv.auth_user || '';
        serverPassInput.value = sv.auth_pass || '';
        debugLogsChk.checked = g.debug_logs === true;
        if (debugChk) debugChk.checked = g.debug === true;

        // Behavior
        if (autoLaunchChk) autoLaunchChk.checked = m.auto_launch_music_player !== false;

        // Feature toggles
        const ft = s.feature_toggles || {};
        ['top_control','calendar','weather','top_process','sysinfo','traffic','background'].forEach(key => {
            const cb = document.getElementById('ft-' + key);
            if (cb) cb.checked = ft[key] !== false;
        });

        // About tab
        loadAboutInfo();

        // Show overlay
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        tabBtns[0].classList.add('active');
        tabContents[0].classList.add('active');
        overlay.style.display = 'flex';
    }

    function closeSettings() {
        hideOverlay('settings-overlay');
    }

    async function saveSettings() {
        // Merge with existing settings to preserve keys not in the form (padding, etc.)
        const existing = window._appSettings || {};
        const s = {
            ...existing,
            general: {
                ...(existing.general || {}),
                language: languageSel.value,
                font_size: parseInt(fontsizeRange.value),
                fullscreen: fullscreenChk.checked,
                hover_highlight: hoverHighlightChk.checked,
                hover_animation: hoverAnimChk.checked,
                update_check_enabled: updateNotifyChk.checked,
                refresh_interval: parseInt(intervalSel.value),
                data_source: datasourceSel.value,
                colorscheme: colorschemeSel.value,
                debug_logs: debugLogsChk.checked,
                debug: debugChk ? debugChk.checked : false,
            },
            display: {
                ...(existing.display || {}),
                monitor: parseInt(monitorSel.value) || 0,
                gpu_index: parseInt(gpuSel.value) || 0,
                hide_when_monitor_missing: hideMissingChk.checked,
            },
            clock: {
                ...(existing.clock || {}),
                clock_24h: clockFormatValue !== '12',
                clock_show_seconds: clockShowSecondsChk.checked,
                bg_image: clockBgImgValue,
                bg_opacity: parseInt(clockBgOpacityRange.value) || 0,
                bg_blur: parseInt(clockBgBlurRange.value) || 0,
                bg_gradient: clockBgGradientChk.checked,
                bg_fit: clockBgFitValue,
                bg_offset_x: clockBgOffsetX,
                bg_offset_y: clockBgOffsetY,
            },
            fonts: {
                ...(existing.fonts || {}),
                ui: fontUiValue,
                data: fontDataValue,
                clock: fontClockValue,
            },
            weather: {
                ...(existing.weather || {}),
                lat: wxLat.value.trim(),
                lon: wxLon.value.trim(),
                key_id: wxKid.value.trim(),
                project_id: wxSub.value.trim(),
                private_key: wxKey.value.trim(),
            },
            music: {
                ...(existing.music || {}),
                meting_api_base: metingUrlInput.value.trim(),
                auto_launch_music_player: autoLaunchChk ? autoLaunchChk.checked : true,
            },
            lyrics: {
                ...(existing.lyrics || {}),
                process_whitelist: lyricsWhitelistInput.value.trim(),
                auto_translate: lyricsTranslateChk.checked,
                animation: lyricAnimChk.checked,
            },
            server: {
                ...(existing.server || {}),
                mode: serverModeChk.checked,
                host: serverHostInput.value.trim() || '0.0.0.0',
                port: parseInt(serverPortInput.value) || 20622,
                auth_enabled: serverAuthChk.checked,
                auth_user: serverUserInput.value.trim(),
                auth_pass: serverPassInput.value,
            },
            custom_text: (window._appSettings && window._appSettings.custom_text) || {},
        };

        // Feature toggles
        s.feature_toggles = {};
        ['top_control','calendar','weather','top_process','sysinfo','traffic','background'].forEach(key => {
            const cb = document.getElementById('ft-' + key);
            s.feature_toggles[key] = cb ? cb.checked : true;
        });

        await pywebview.api.save_settings(s);
        await pywebview.api.set_autostart(autostartChk.checked);
        await pywebview.api.change_backend((s.general || {}).data_source);

        // Update global settings cache
        window._appSettings = { ...window._appSettings, ...s };

        applyHoverAnim((s.general || {}).hover_animation !== false);
        applyHoverHighlight((s.general || {}).hover_highlight !== false);

        if ((s.display || {}).hide_when_monitor_missing) {
            const res = await pywebview.api.check_monitor();
            document.body.style.visibility = res.available ? 'visible' : 'hidden';
        } else {
            document.body.style.visibility = 'visible';
        }

        startPolling((s.general || {}).refresh_interval);
        applyLang((s.general || {}).language || 'en');
        applyFontSize((s.general || {}).font_size);
        applyColorscheme((s.general || {}).colorscheme || 'gruvbox');
        applyHoverHighlight((s.general || {}).hover_highlight !== false);
        applyHoverAnim((s.general || {}).hover_animation !== false);
        applyLyricAutoTranslate((s.lyrics || {}).auto_translate === true);
        const fnt = s.fonts || {};
        applyFonts(fnt.ui, fnt.data, fnt.clock);
        const ckc = s.clock || {};
        await applyClockBackgroundSetting(ckc.bg_image, ckc.bg_opacity, ckc.bg_blur, ckc.bg_gradient !== false, ckc.bg_fit || 'fit', ckc.bg_offset_x ?? 50, ckc.bg_offset_y ?? 50);
        applyHwNames(true);
        applyFeatureToggles(s.feature_toggles || {});

        // Restart sidebar weather intervals to match the Show Weather toggle
        const wxSidebarOn = (s.feature_toggles || {}).weather !== false;
        _startInterval(wxSidebarOn, refreshWeather, 600000);
        _startInterval(wxSidebarOn, refreshWeatherDetail, 600000);
        _startInterval(wxSidebarOn, refreshAirQuality, 1800000);
        _startInterval(wxSidebarOn, refreshAlerts, 600000);

        const wx = s.weather || {};
        const wxChanged = wx.lat !== oldWeatherLat || wx.lon !== oldWeatherLon ||
            wx.key_id !== oldWeatherKid || wx.project_id !== oldWeatherSub ||
            wx.private_key !== oldWeatherKey;
        if (wxChanged) {
            oldWeatherLat = wx.lat;
            oldWeatherLon = wx.lon;
            oldWeatherKid = wx.key_id;
            oldWeatherSub = wx.project_id;
            oldWeatherKey = wx.private_key;
            refreshWeather();
            refreshWeatherDetail();
            refreshAirQuality();
            refreshAlerts();
            refreshWeatherCard();
        }

        // If server mode is on, tell the user it runs headless and how to disable it
        if ((s.server || {}).mode) {
            try {
                const info = await pywebview.api.get_server_info();
                showServerInfoModal(info);
            } catch (e) { console.warn('get_server_info:', e); }
        }

        closeSettings();
    }

    // Range inputs
    fontsizeRange.addEventListener('input', () => {
        fontsizeVal.textContent = fontsizeRange.value + '%';
        applyFontSize(parseInt(fontsizeRange.value));
    });
    // Clock sidebar background live preview
    clockBgOpacityRange.addEventListener('input', () => {
        clockBgOpacityVal.textContent = clockBgOpacityRange.value + '%';
        applyClockBg();
    });
    clockBgBlurRange.addEventListener('input', () => {
        clockBgBlurVal.textContent = clockBgBlurRange.value + 'px';
        applyClockBg();
    });
    clockBgGradientChk.addEventListener('change', () => {
        applyClockBg();
    });

    // Offset adjust modal
    clockBgOffsetBtn.addEventListener('click', () => {
        openClockBgOffsetModal(lastResolvedClockBg.path, clockBgOffsetX, clockBgOffsetY, (nx, ny) => {
            clockBgOffsetX = nx;
            clockBgOffsetY = ny;
            applyClockBackgroundSetting(clockBgImgValue, clockBgOpacityRange.value, clockBgBlurRange.value, clockBgGradientChk.checked, clockBgFitValue, nx, ny);
        });
    });

    saveBtn.addEventListener('click', saveSettings);
    closeBtn.addEventListener('click', closeSettings);
}

/* Top-hover Control Popup (brightness & volume) */
const TOP_HOVER_THRESHOLD = 6;
const WHEEL_STEP = 5;
let _topControlEnabled = true; // 顶部亮度/音量条是否开启（由功能开关控制）
let _topControlVisible = false;
let _topControlHideTimer = null;
const _brightnessSetTimer = {};
const _volumeSetTimer = {};

function showTopControlPopup() {
    const popup = document.getElementById('top-control-popup');
    if (!popup) return;
    const wasVisible = _topControlVisible;
    popup.classList.add('visible');
    _topControlVisible = true;
    if (_topControlHideTimer) { clearTimeout(_topControlHideTimer); _topControlHideTimer = null; }
    // Only refresh values once when the popup first appears — not on every mousemove
    if (!wasVisible) {
        refreshTopControlValues();
    }
}

function hideTopControlPopup() {
    if (_topControlHideTimer) clearTimeout(_topControlHideTimer);
    _topControlHideTimer = setTimeout(() => {
        const popup = document.getElementById('top-control-popup');
        if (popup) popup.classList.remove('visible');
        _topControlVisible = false;
    }, 400);
}

async function readTopControlValue(slider, valEl, apiMethod) {
    if (!slider || slider.dataset.active === '1') return;
    try {
        const r = await pywebview.api[apiMethod]('get');
        if (r && r.success) {
            slider.value = r.level;
            if (valEl) valEl.textContent = r.level + '%';
        } else if (valEl) {
            valEl.textContent = '--';
        }
    } catch (e) { /* pywebview not ready */ }
}

function bindTopSlider(slider, valEl, apiMethod, timerObj, delay) {
    if (!slider) return;
    slider.addEventListener('input', () => {
        slider.dataset.active = '1';
        if (valEl) valEl.textContent = slider.value + '%';
        if (timerObj.t) clearTimeout(timerObj.t);
        timerObj.t = setTimeout(() => {
            pywebview.api[apiMethod]('set', parseInt(slider.value, 10));
            delete slider.dataset.active;
        }, delay);
    });
}

function bindTopSliderWheel(slider) {
    if (!slider) return;
    const item = slider.closest('.top-control-item');
    if (!item) return;
    item.addEventListener('wheel', (e) => {
        e.preventDefault();
        const cur = parseInt(slider.value, 10) || 0;
        const next = Math.max(0, Math.min(100, cur + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)));
        slider.value = next;
        slider.dispatchEvent(new Event('input'));
    }, { passive: false });
}

async function refreshTopControlValues() {
    const bSlider = document.getElementById('brightness-slider');
    const bVal = document.getElementById('brightness-value');
    const vSlider = document.getElementById('volume-slider');
    const vVal = document.getElementById('volume-value');
    await readTopControlValue(bSlider, bVal, 'adjust_brightness');
    await readTopControlValue(vSlider, vVal, 'adjust_volume');
}

function setupTopControl() {
    const popup = document.getElementById('top-control-popup');
    if (!popup) return;
    const bSlider = document.getElementById('brightness-slider');
    const bVal = document.getElementById('brightness-value');
    const vSlider = document.getElementById('volume-slider');
    const vVal = document.getElementById('volume-value');

    // Trigger when mouse enters the top edge of the window — only on hidden→visible transition
    document.addEventListener('mousemove', (e) => {
        if (e.clientY <= TOP_HOVER_THRESHOLD && !_topControlVisible && _topControlEnabled) {
            showTopControlPopup();
        }
    });

    popup.addEventListener('mouseenter', () => {
        if (_topControlHideTimer) { clearTimeout(_topControlHideTimer); _topControlHideTimer = null; }
    });
    popup.addEventListener('mouseleave', hideTopControlPopup);

    // Brightness & volume sliders — debounced writes
    bindTopSlider(bSlider, bVal, 'adjust_brightness', _brightnessSetTimer, 150);
    bindTopSlider(vSlider, vVal, 'adjust_volume', _volumeSetTimer, 100);

    // Mouse wheel support — adjust whichever item the cursor is over
    bindTopSliderWheel(bSlider);
    bindTopSliderWheel(vSlider);
}

/* Show body ASAP if boot hangs */
let _bodyShown = false;
function showBody() {
    if (!_bodyShown) { document.body.style.visibility = 'visible'; _bodyShown = true; }
    const loader = document.getElementById('boot-loading');
    if (loader) {
        loader.classList.add('hide');
        setTimeout(() => { loader.style.display = 'none'; }, 350);
    }
}
setTimeout(showBody, 5000);
