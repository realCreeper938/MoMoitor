// 首次使用欢迎向导
let _wizardSteps = ['welcome'];
let _wizardIndex = 0;
let _wizardSettings = null;
let _wizardMonitors = [];
let _wizardHasMonitorStep = false;
let _wizardMaterialSource = 'blue';
let _wizardMaterialMode = 'dark';
let _wizardMonitor = 0;

async function showWelcomeWizard(s) {
    _wizardSettings = s;
    const g = s.general || {};
    const dsp = s.display || {};
    _wizardMaterialSource = g.material_source || 'blue';
    _wizardMaterialMode = g.material_mode || (g.follow_system_theme ? 'system' : 'dark');
    _wizardMonitor = typeof dsp.monitor === 'number' ? dsp.monitor : 0;

    _wizardMonitors = await pywebview.api.get_monitors();
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
    document.getElementById('welcome-material-source').value = _wizardMaterialSource;
    document.getElementById('welcome-material-mode').value = _wizardMaterialMode;
    document.getElementById('welcome-material-source').onchange = (e) => {
        _wizardMaterialSource = e.target.value;
        applyMaterialTheme(_wizardMaterialSource, _wizardMaterialMode);
    };
    document.getElementById('welcome-material-mode').onchange = (e) => {
        _wizardMaterialMode = e.target.value;
        applyMaterialTheme(_wizardMaterialSource, _wizardMaterialMode);
    };
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
    _wizardMonitors.forEach((m, i) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'welcome-monitor-card' + (i === _wizardMonitor ? ' active' : '');
        card.innerHTML =
            `<span class="welcome-monitor-name">${escapeHtml(t('wizard-monitor-label'))} ${i + 1}</span>` +
            `<span class="welcome-monitor-res">${escapeHtml(m.width)}x${escapeHtml(m.height)}</span>`;
        card.addEventListener('click', () => {
            _wizardMonitor = i;
            _wizardRenderMonitorCards();
        });
        container.appendChild(card);
    });
}

async function _wizardFinish() {
    const s = _wizardSettings;
    const g = s.general || {};
    const dsp = s.display || {};
    g.colorscheme = 'material-you';
    g.material_source = _wizardMaterialSource;
    g.material_mode = _wizardMaterialMode;
    g.follow_system_theme = _wizardMaterialMode === 'system';
    g.font_size = parseInt(document.getElementById('welcome-size-card').value) || 100;
    g.font_size_ui = parseInt(document.getElementById('welcome-size-ui').value) || 100;
    g.hint_dismissed = true;
    g.force_welcome = false;
    if (_wizardHasMonitorStep) {
        dsp.monitor = _wizardMonitor;
        dsp.on_top = document.getElementById('welcome-on-top').checked;
        dsp.hide_when_monitor_missing = document.getElementById('welcome-hide-missing').checked;
    }
    await pywebview.api.save_settings(s);
    if (_wizardHasMonitorStep) {
        await pywebview.api.move_to_monitor(_wizardMonitor);
    }
    await applyMaterialTheme(_wizardMaterialSource, _wizardMaterialMode);
    document.getElementById('welcome-overlay').style.display = 'none';
    showBody();
}
