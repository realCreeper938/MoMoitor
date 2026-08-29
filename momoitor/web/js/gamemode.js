/* 自动游戏模式：GPU 占用持续超过阈值时降低刷新频率并关闭非交互动画。
   由 core.js 的 poll() 每次取数后调用 gameModeFeed(load) 驱动；
   设置开关为 general.game_mode（默认开启），关闭后立即退出并停止检测。 */

const GM_LOAD_THRESHOLD = 60;   // 进入阈值：GPU 占用率 %
const GM_ENTER_MS = 6000;       // 持续超阈值 6 秒进入
const GM_EXIT_MS = 15000;       // 持续低于阈值 15 秒退出（防加载画面来回切换）
const GM_INTERVAL = 1500;       // 游戏模式下的数据轮询间隔
const GM_FPS_INTERVAL = 1500;   // 游戏模式下 FPS 卡轮询间隔（平时 1000ms）

let _gmHighSince = null;  // 占用率首次超过阈值的时间戳
let _gmLowSince = null;   // 占用率首次低于阈值的时间戳
let _gmActive = false;

function gameModeEnabled() {
    const g = (window._appSettings || {}).general || {};
    return g.game_mode !== false;
}

/** 当前是否处于游戏模式（core.js / music.js / settings.js 轮询判定用）。 */
function isGameModeActive() {
    return _gmActive;
}

/** 每次主数据轮询后喂入 GPU 占用率（null 视为无数据，按低负载处理）。 */
function gameModeFeed(load) {
    if (!gameModeEnabled()) {
        _gmHighSince = _gmLowSince = null;
        if (_gmActive) applyGameMode(false);
        return;
    }
    const now = Date.now();
    const high = Number.isFinite(load) && load > GM_LOAD_THRESHOLD;
    if (high) {
        if (_gmHighSince === null) _gmHighSince = now;
        _gmLowSince = null;
        if (!_gmActive && now - _gmHighSince >= GM_ENTER_MS) applyGameMode(true);
    } else {
        if (_gmLowSince === null) _gmLowSince = now;
        _gmHighSince = null;
        if (_gmActive && now - _gmLowSince >= GM_EXIT_MS) applyGameMode(false);
    }
}

/** 进入/退出游戏模式：切换 body class、临时覆盖特效开关与 FPS 轮询间隔。 */
function applyGameMode(on) {
    if (_gmActive === on) return;
    _gmActive = on;
    document.body.classList.toggle('game-mode', on);
    const g = (window._appSettings || {}).general || {};
    // 特效临时强制关闭，退出后按用户设置恢复
    applyCardGradient(on ? false : g.card_gradient !== false);
    applyBgCharts(on ? false : g.bg_charts !== false);
    // FPS 卡轮询同步降频/恢复（卡片已删除时 refreshFps 自身会跳过）
    const fpsOn = ((window._appSettings || {}).feature_toggles || {}).fps !== false;
    _startInterval(fpsOn, refreshFps, on ? GM_FPS_INTERVAL : 1000);
    showToast(t(on ? 'toast-game-mode-on' : 'toast-game-mode-off'));
}

/** 立即退出游戏模式并清空检测计时（设置中关闭开关时调用）。 */
function forceExitGameMode() {
    _gmHighSince = _gmLowSince = null;
    if (_gmActive) applyGameMode(false);
}
