// 首次使用欢迎向导
let _wizardSteps = ['welcome'];
let _wizardIndex = 0;
let _wizardSettings = null;
let _wizardMonitors = [];
let _wizardHasMonitorStep = false;
let _wizardColorDark = 'gruvbox';
let _wizardColorLight = 'gruvbox-light';
let _wizardMonitor = '';

async function showWelcomeWizard(s) {
    _wizardSettings = s;
    const g = s.general || {};
    const dsp = s.display || {};
    _wizardColorDark = g.colorscheme_dark || 'gruvbox';
    _wizardColorLight = g.colorscheme_light || 'gruvbox-light';

    _wizardMonitors = await pywebview.api.get_monitors();
    const legacyIdx = typeof dsp.monitor === 'number' ? dsp.monitor : 0;
    _wizardMonitor = dsp.monitor_id || ((_wizardMonitors[legacyIdx] && (_wizardMonitors[legacyIdx].id || _wizardMonitors[legacyIdx].device)) || '');
    _wizardSteps = ['welcome'];
    _wizardHasMonitorStep = _wizardMonitors.length > 1;
    if (_wizardHasMonitorStep) _wizardSteps.push('monitor');
    _wizardSteps.push('size', 'theme', 'done');
    _wizardIndex = 0;

    if (_wizardHasMonitorStep) {
        _wizardRenderMonitorCards();
        document.getElementById('welcome-on-top').checked = dsp.on_top !== false;
        document.getElementById('welcome-hide-missing').checked = dsp.hide_when_monitor_missing === true;
    }
    _wizardRenderThemeCards();
    _wizardInitSizeControls(g);

    document.getElementById('welcome-next').addEventListener('click', _wizardNext);
    document.getElementById('welcome-back').addEventListener('click', _wizardBack);
    _wizardRenderStep();
    document.getElementById('welcome-overlay').style.display = 'flex';
}

function _wizardInitSizeControls(g) {
    const ui = document.getElementById('welcome-size-ui');
    const uiVal = document.getElementById('welcome-size-ui-val');
    const card = document.getElementById('welcome-size-card');
    const cardVal = document.getElementById('welcome-size-card-val');
    ui.value = g.font_size_ui || 100;
    uiVal.textContent = ui.value + '%';
    card.value = g.font_size || 100;
    cardVal.textContent = card.value + '%';
    ui.addEventListener('input', () => {
        uiVal.textContent = ui.value + '%';
        applyUiFontSize(parseInt(ui.value));
    });
    card.addEventListener('input', () => {
        cardVal.textContent = card.value + '%';
        applyFontSize(parseInt(card.value));
    });
}

function _wizardRenderStep() {
    const step = _wizardSteps[_wizardIndex];
    document.querySelectorAll('#welcome-overlay .welcome-step').forEach(el => {
        el.classList.toggle('active', el.dataset.step === step);
    });
    const next = document.getElementById('welcome-next');
    const back = document.getElementById('welcome-back');
    if (step === 'done') {
        back.style.display = 'none';
        next.style.display = '';
        next.textContent = t('wizard-start');
    } else {
        back.style.display = _wizardIndex === 0 ? 'none' : '';
        next.style.display = '';
        next.textContent = t('wizard-next');
    }
}

function _wizardNext() {
    if (_wizardSteps[_wizardIndex] === 'done') {
        _wizardFinish();
        return;
    }
    _wizardIndex++;
    _wizardRenderStep();
}

function _wizardBack() {
    if (_wizardIndex > 0) {
        _wizardIndex--;
        _wizardRenderStep();
    }
}

function _wizardRenderMonitorCards() {
    const container = document.getElementById('welcome-monitor-cards');
    container.innerHTML = '';
    _wizardMonitors.forEach((m) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'welcome-monitor-card' + ((m.id || m.device) === _wizardMonitor ? ' active' : '');
        card.innerHTML =
            `<span class="welcome-monitor-name">${escapeHtml(m.name || t('wizard-monitor-label'))} ${m.primary ? ' *' : ''}</span>` +
            `<span class="welcome-monitor-res">${escapeHtml(m.width)}x${escapeHtml(m.height)}</span>`;
        card.addEventListener('click', () => {
            _wizardMonitor = m.id || m.device || '';
            _wizardRenderMonitorCards();
        });
        container.appendChild(card);
    });
}

function _wizardRenderThemeCards() {
    const buildGrid = (gridId, list, selected) => {
        const grid = document.getElementById(gridId);
        grid.innerHTML = '';
        list.forEach(item => {
            const c = getThemeColors(item.value);
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'theme-card' + (item.value === selected ? ' active' : '');
            card.innerHTML =
                `<div class="theme-swatches">` +
                `<span class="swatch" style="background:${c.bg}"></span>` +
                `<span class="swatch" style="background:${c.surface}"></span>` +
                `<span class="swatch" style="background:${c.accent}"></span>` +
                `<span class="swatch" style="background:${c.text}"></span>` +
                `</div>` +
                `<span class="theme-name">${escapeHtml(item.name)}</span>`;
            card.addEventListener('click', () => {
                if (item.value === _wizardColorDark || item.value === _wizardColorLight) {
                    _wizardColorDark = item.value;
                    _wizardColorLight = item.value;
                } else if (list === THEME_LIST.dark) {
                    _wizardColorDark = item.value;
                } else {
                    _wizardColorLight = item.value;
                }
                applyColorscheme(item.value);
                _wizardRenderThemeCards();
            });
            grid.appendChild(card);
        });
    };
    buildGrid('welcome-theme-dark', THEME_LIST.dark, _wizardColorDark);
    buildGrid('welcome-theme-light', THEME_LIST.light, _wizardColorLight);
}

async function _wizardFinish() {
    const s = _wizardSettings;
    const g = s.general || {};
    const dsp = s.display || {};
    g.colorscheme = _wizardColorDark;
    g.colorscheme_dark = _wizardColorDark;
    g.colorscheme_light = _wizardColorLight;
    g.font_size = parseInt(document.getElementById('welcome-size-card').value) || 100;
    g.font_size_ui = parseInt(document.getElementById('welcome-size-ui').value) || 100;
    g.hint_dismissed = true;
    g.force_welcome = false;
    if (_wizardHasMonitorStep) {
        dsp.monitor_id = _wizardMonitor;
        dsp.monitor = _wizardMonitors.findIndex(m => (m.id || m.device) === _wizardMonitor);
        if (dsp.monitor < 0) dsp.monitor = 0;
        dsp.on_top = document.getElementById('welcome-on-top').checked;
        dsp.hide_when_monitor_missing = document.getElementById('welcome-hide-missing').checked;
    }
    await pywebview.api.save_settings(s);
    if (_wizardHasMonitorStep) {
        await pywebview.api.move_to_monitor(_wizardMonitor);
    }
    applyColorscheme(_wizardColorDark);
    document.getElementById('welcome-overlay').style.display = 'none';
    showBody();
}
