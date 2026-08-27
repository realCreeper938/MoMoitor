/* Boot */
let __bootStarted = false;

/* 后端（托盘等外部入口）修改设置后回调：把变更分组合并进前端缓存，
 * 避免前端随后整包保存时用旧值覆盖。 */
window.__syncExternalSettings = function(groups) {
    if (!groups || typeof groups !== 'object') return;
    window._appSettings = window._appSettings || {};
    Object.keys(groups).forEach(function(g) {
        const val = groups[g];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            window._appSettings[g] = Object.assign({}, window._appSettings[g], val);
        } else {
            window._appSettings[g] = val;
        }
    });
};

function initConsoleForwarding() {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    function forward(level, args) {
        try {
            const msg = Array.from(args).map(a => {
                if (typeof a === 'object') try { return JSON.stringify(a); } catch(e) { return String(a); }
                return String(a);
            }).join(' ');
            pywebview.api.js_log(level, msg);
        } catch (e) { /* ignore */ }
    }
    console.log = function() { forward('debug', arguments); origLog.apply(console, arguments); };
    console.warn = function() { forward('warning', arguments); origWarn.apply(console, arguments); };
    console.error = function() { forward('error', arguments); origError.apply(console, arguments); };
}

async function initDisplay(s, g, f, ck, ly) {
    applyLang(g.language || 'en');
    if (g.follow_system_theme) {
        setFollowSystemTheme(true);
        await _checkSystemTheme(true);
    } else {
        applyColorscheme(g.colorscheme || 'gruvbox');
    }
    applyFonts(f.ui, f.data, f.clock);
    applyCardGradient(g.card_gradient !== false);
    applyBgCharts(g.bg_charts !== false);
    if (g.debug_clock_gradient) forceClockTimeGradient(g.debug_clock_gradient);
    await applyAppBackgroundSetting(ck.bg_image, ck.bg_opacity, ck.bg_blur, ck.bg_gradient !== false, ck.bg_fit || 'fit', ck.bg_offset_x ?? 50, ck.bg_offset_y ?? 50);
    applyFontSize(g.font_size || 100);
    applyUiFontSize(g.font_size_ui || 100);
    applyLyricAutoTranslate(ly.auto_translate === true);

    // Move to target monitor + fullscreen, then show
    const dsp = s.display || {};
    const monTarget = dsp.monitor_id || dsp.monitor;
    if (monTarget) {
        await pywebview.api.move_to_monitor(monTarget);
    }
    if (g.fullscreen !== false) {
        pywebview.api.toggle_fullscreen();
    } else {
        // 非全屏时恢复原生标题栏（右上角最小化/最大化/关闭三键）
        pywebview.api.set_caption(true);
    }
}

function initClockBgHover() {
    // 时钟区域悬停：背景图片透明度 +10%（无图时透明度为 0，悬停不生效）
    const clockSectionEl = document.getElementById('clock-section');
    const clockBgLayerEl = document.getElementById('app-bg-image');
    if (clockSectionEl && clockBgLayerEl) {
        clockSectionEl.addEventListener('mouseenter', () => {
            if (!(appBgState.opacity > 0)) return;
            clockBgLayerEl.style.opacity = String(Math.min(1, appBgState.opacity + 0.1));
        });
        clockSectionEl.addEventListener('mouseleave', () => {
            if (!(appBgState.opacity > 0)) return;
            clockBgLayerEl.style.opacity = String(appBgState.opacity);
        });
    }
}

async function initHardware() {
    await loadHwNames();
    applyHwNames(true);
    loadHwDetail();
}

function cacheWeatherCreds(w) {
    oldWeatherLat = w.lat || '';
    oldWeatherLon = w.lon || '';
    oldWeatherKid = w.key_id || '';
    oldWeatherSub = w.project_id || '';
    oldWeatherKey = w.private_key || '';
}

function initSettingsAndPolling(g, s) {
    initSettings();
    initLayoutControls();
    initTextCardEditor();
    initCustomCardEditor();
    setupTopControl();
    // Disk partition hover: populate details on mouseenter
    const diskSection = document.getElementById('disk-section');
    if (diskSection) {
        diskSection.addEventListener('mouseenter', renderDiskPartitions);
    }
    startClock();
    startPolling(g.refresh_interval);

    // Version update check — delayed so the popup doesn't interrupt startup
    if (g.update_check_enabled !== false) {
        setTimeout(checkForUpdate, 3000);
    }

    // Apply feature toggles - hide UI elements for disabled features
    applyFeatureToggles(s.feature_toggles || {});
    initCustomCards(s);
    applyLayout(s.layout);
    applyCustomText('text-section');
    const ft = s.feature_toggles || {};

    // Start intervals only for enabled features
    const wxOn = (s.weather || {}).enabled !== false;
    _startAllWeatherIntervals(wxOn);
    _startInterval(ft.music !== false, refreshMusic, 3000);
    _startInterval(ft.fps !== false, refreshFps, 1000);
    _startInterval(true, refreshSysinfo, 60000);
    // 心率/进程卡的轮询不走固定定时器：由 cardfetch.js 按卡片可见性启停，
    // 上方 applyLayout 已完成启动时的首次收敛（删卡即彻底停止取数）。
    // Fit the process list to the actual box height once the initial layout is done.
    setTimeout(recalcProcLimit, 800);
}

function initMusicControls() {
    // Music transport controls — previous / play-pause / next buttons
    const bindMusicCtrl = (id, action) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', async (e) => {
            spawnCtrlRipple(el, e);
            try {
                await action();
                refreshMusic();
            } catch (e) { console.warn('music ctrl:', e); }
        });
    };
    bindMusicCtrl('h-music-prev', () => pywebview.api.music_prev());
    bindMusicCtrl('h-music-toggle', async () => {
    const s = window._appSettings || {};
    const autoLaunch = (s.music || {}).auto_launch_music_player !== false;
    const music = await pywebview.api.get_music();
    if (!music.available && autoLaunch) {
        const ok = await pywebview.api.launch_last_player();
        if (ok) {
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 1000));
                const m = await pywebview.api.get_music();
                if (m.available) {
                    await pywebview.api.music_play_pause();
                    return;
                }
            }
        }
    }
    await pywebview.api.music_play_pause();
});
    bindMusicCtrl('h-music-next', () => pywebview.api.music_next());
    bindMusicCtrl('h-music-switch', () => pywebview.api.music_switch_session());
}

function initSeekBar() {
    // Seek bar: preview time in tooltip while dragging, seek on release
    const seekEl = document.getElementById('h-music-seek');
    if (seekEl) {
        const seekTip = document.getElementById('h-music-seek-tip');
        const seekLeft = document.getElementById('h-music-time-left');
        seekEl.addEventListener('input', () => {
            _seeking = true;
            seekEl.classList.add('dragging');
            seekEl.style.setProperty('--seek-fill', (seekEl.value / 10) + '%');
            const dragPos = _musicDur > 0 ? seekEl.value / 1000 * _musicDur : 0;
            if (seekLeft) seekLeft.textContent = '-' + fmtMusicTime(_musicDur - dragPos);
            if (seekTip) {
                seekTip.textContent = fmtMusicTime(dragPos);
                seekTip.style.left = (seekEl.value / 10) + '%';
            }
        });
        seekEl.addEventListener('change', async () => {
            const pos = _musicDur > 0 ? seekEl.value / 1000 * _musicDur : 0;
            _seeking = false;
            seekEl.classList.remove('dragging');
            try { await pywebview.api.music_seek(pos); } catch (e) { console.warn('music seek:', e); }
            _musicBase = { pos, t: Date.now() };
            refreshMusic();
        });
    }
    bindLyricHover();
}

function initProcInteractions() {
    // Top process interactions
    const procListEl = document.getElementById('proc-list');
    if (procListEl) procListEl.addEventListener('click', (e) => {
        // Click the usage value to switch between CPU % and memory usage
        const valEl = e.target.closest('.proc-value');
        if (valEl) {
            procMode = procMode === 'cpu' ? 'mem' : 'cpu';
            refreshTopProcess();
            return;
        }
        const nameEl = e.target.closest('.proc-name');
        if (nameEl && nameEl.dataset.pid) {
            const pid = parseInt(nameEl.dataset.pid);
            if (!isNaN(pid)) showKillConfirm(pid, nameEl.dataset.name || nameEl.textContent);
        }
    });
    const killCancelBtn = document.getElementById('kill-btn-cancel');
    if (killCancelBtn) killCancelBtn.addEventListener('click', hideKillConfirm);
    const killOkBtn = document.getElementById('kill-btn-ok');
    if (killOkBtn) killOkBtn.addEventListener('click', confirmKill);
    const killOverlay = document.getElementById('kill-confirm-overlay');
    if (killOverlay) killOverlay.addEventListener('click', (e) => {
        if (e.target === killOverlay) hideKillConfirm();
    });
}

function initAppConfirmModal() {
    // 通用应用内确认弹窗
    const appConfirmCancelBtn = document.getElementById('app-confirm-cancel');
    if (appConfirmCancelBtn) appConfirmCancelBtn.addEventListener('click', hideAppConfirm);
    const appConfirmOkBtn = document.getElementById('app-confirm-ok');
    if (appConfirmOkBtn) appConfirmOkBtn.addEventListener('click', () => {
        const cb = _appConfirmCb;
        hideAppConfirm();
        if (cb) cb();
    });
    const appConfirmOverlay = document.getElementById('app-confirm-overlay');
    if (appConfirmOverlay) appConfirmOverlay.addEventListener('click', (e) => {
        if (e.target === appConfirmOverlay) hideAppConfirm();
    });
}

function initUpdateServerModals() {
    // Update available modal
    const updateLaterBtn = document.getElementById('update-later');
    if (updateLaterBtn) updateLaterBtn.addEventListener('click', hideUpdateModal);
    const updateOverlay = document.getElementById('update-overlay');
    if (updateOverlay) updateOverlay.addEventListener('click', (e) => {
        if (e.target === updateOverlay) hideUpdateModal();
    });
    const serverInfoOkBtn = document.getElementById('server-info-ok');
    if (serverInfoOkBtn) serverInfoOkBtn.addEventListener('click', hideServerInfoModal);
    const serverInfoOverlay = document.getElementById('server-info-overlay');
    if (serverInfoOverlay) serverInfoOverlay.addEventListener('click', (e) => {
        if (e.target === serverInfoOverlay) hideServerInfoModal();
    });
    const updateGotoEl = document.getElementById('update-goto');
    if (updateGotoEl) updateGotoEl.addEventListener('click', (e) => {
        e.preventDefault();
        const url = updateGotoEl.getAttribute('href');
        if (!url || url === '#' || url === '') return;
        if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
            window.pywebview.api.open_external(url).catch(function() { window.open(url, '_blank'); });
        } else {
            window.open(url, '_blank');
        }
    });
}

function initTaskMgrBtn() {
    // Task Manager: hover show button, click to launch Windows Task Manager
    const procSection = document.getElementById('proc-section');
    const taskmgrBtn = document.getElementById('proc-taskmgr-btn');
    let taskmgrBtnTimer = null;
    if (procSection && taskmgrBtn) {
        procSection.addEventListener('mouseenter', function() {
            if (taskmgrBtnTimer) clearTimeout(taskmgrBtnTimer);
            taskmgrBtn.classList.add('visible');
        });
        procSection.addEventListener('mouseleave', function() {
            taskmgrBtnTimer = setTimeout(function() {
                taskmgrBtn.classList.remove('visible');
            }, 300);
        });
        taskmgrBtn.addEventListener('mouseenter', function() {
            if (taskmgrBtnTimer) clearTimeout(taskmgrBtnTimer);
        });
        taskmgrBtn.addEventListener('mouseleave', function() {
            taskmgrBtn.classList.remove('visible');
        });
        taskmgrBtn.addEventListener('click', function() {
            pywebview.api.open_taskmgr();
        });
    }
}

function initMonitorPolling() {
    // Monitor presence polling（实时读 _appSettings，托盘切换显示器后立即生效）
    let monitorHidden = false;

    async function checkMonitor() {
        try {
            const d = (window._appSettings && window._appSettings.display) || {};
            const cachedMonitor = d.monitor_id || d.monitor || 0;
            const cachedHideMissing = d.hide_when_monitor_missing === true;
            async function showMonitor() {
                if (!monitorHidden) return;
                document.body.style.visibility = 'visible';
                monitorHidden = false;
                await pywebview.api.move_to_monitor(cachedMonitor);
            }
            if (!cachedHideMissing) {
                await showMonitor();
                return;
            }
            const res = await pywebview.api.check_monitor();
            if (res.available) {
                await showMonitor();
            } else {
                if (!monitorHidden) {
                    document.body.style.visibility = 'hidden';
                    monitorHidden = true;
                }
            }
        } catch (e) { console.warn('checkMonitor:', e); }
    }

    checkMonitor();
    setInterval(checkMonitor, 5000);
}

window.addEventListener('pywebviewready', async () => {
    // 幂等守卫：防止 pywebviewready 重复派发导致重复初始化（重复轮询/重复日志转发）
    if (__bootStarted) return;
    __bootStarted = true;
    // Redirect console to Python logger
    initConsoleForwarding();

    const s = await pywebview.api.get_settings();
    window._appSettings = s;

    const g = s.general || {};
    const f = s.fonts || {};
    const ck = s.clock || {};
    const w = s.weather || {};
    const ly = s.lyrics || {};
    await initDisplay(s, g, f, ck, ly);
    // 透明度须在 fullscreen / 标题栏等窗口样式操作之后再应用，
    // 否则会被这些操作重建窗口样式而清除（启动时表现为一闪而过后失效）。
    try { await pywebview.api.apply_window_opacity(); } catch (e) { console.warn('apply_window_opacity:', e); }
    initClockBgHover();
    await initHardware();
    cacheWeatherCreds(w);
    initSettingsAndPolling(g, s);
    initMusicControls();
    initSeekBar();
    initProcInteractions();
    initAppConfirmModal();
    initUpdateServerModals();
    initTaskMgrBtn();
    initMonitorPolling();

    // 全部初始化完成后，再显示界面并收起加载动画；
    // 首次启动或开启强制向导时，先展示欢迎向导，向导完成后再显示界面
    if ((s.general || {}).hint_dismissed && !(s.general || {}).force_welcome) {
        showBody();
    } else {
        showWelcomeWizard(s);
    }
});
