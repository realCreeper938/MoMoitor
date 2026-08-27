/* Card data-fetch lifecycle —— 通用的“删卡停止获取数据”机制。
 *
 * 每类随卡片存在与否启停的数据获取在此注册一个控制器：该类卡片仍有任一可见
 * 实例时保持轮询；全部实例都不可见（被删除/隐藏，可重复添加的卡片须相关实例
 * 全部删除）时清掉轮询并可选通知后端断开数据源，从而彻底停止取数。
 *
 * 卡片增删/显隐变化的各入口（删除卡片、放置卡片、整版布局应用）调用
 * syncCardFetching 做收敛。依赖 core.js 的 _startInterval 与 appearance.js
 * 的 _sectionVisible；实际调用发生在页面就绪之后，故仅需保证在本文件之前
 * 加载上述两个文件即可。
 */

const _cardFetchers = [];

/* opts: {
 *   match:   卡片 id 或类型前缀（前缀匹配以 '*' 结尾，如 'custom-data-*'）
 *   fn / ms: 轮询函数与间隔（经 _startInterval 按函数名管理，不会堆叠）
 *   onActive 可选：由全部不可见转为有可见实例时触发（如重连后端数据源）
 *   onStop   可选：变为全部不可见时触发（如断开后端连接），彻底停止取数
 * } */
function registerCardFetcher(opts) {
    if (!opts || typeof opts.match !== 'string' || !opts.fn || !opts.ms) return;
    opts._started = null; // null 表示尚未收敛过，首次只记录状态、不触发钩子
    _cardFetchers.push(opts);
}

function _fetcherOwnsCard(fetcher, id) {
    const m = fetcher.match;
    if (m.slice(-1) === '*') return String(id).indexOf(m.slice(0, -1)) === 0;
    return m === id;
}

function _fetcherHasVisibleCard(fetcher) {
    return allCards().some(card => _fetcherOwnsCard(fetcher, card.id) && _sectionVisible(card.id));
}

/** 通用方法：删除/隐藏/恢复某张卡片后传入其 id 同步该类卡片的取数状态；
 *  省略参数则全量收敛（应用启动与整体布局应用后调用）。 */
function syncCardFetching(changedId) {
    for (const f of _cardFetchers) {
        if (changedId != null && !_fetcherOwnsCard(f, changedId)) continue;
        const active = _fetcherHasVisibleCard(f);
        if (f._started === active) continue;
        _startInterval(active, f.fn, f.ms);
        const prev = f._started;
        f._started = active;
        // 首次收敛时不补发 onStop（卡片本就不可见，无需断开），但 onActive
        // 必须照常触发，否则启动时可见的卡片没有机会启动其后端数据源。
        const hook = (typeof prev === 'boolean') ? (active ? f.onActive : f.onStop)
            : (active ? f.onActive : null);
        if (hook) {
            try { hook(); } catch (e) { console.warn('syncCardFetching:', e); }
        }
    }
}

/* 心率卡：BLE 连接由卡片可见性驱动。最后一个实例被删除时断开订阅、彻底停止
 * 取数；重新添加（或布局编辑取消恢复）时按已配置的设备地址自动重连。 */
registerCardFetcher({
    match: 'hr-section',
    fn: refreshHr,
    ms: 1000,
    onActive() {
        const hr = ((window._appSettings || {}).hr) || {};
        if (!hr.device_address) return;
        try { pywebview.api.connect_hr(hr.device_address).catch(() => {}); } catch (e) { console.warn(e); }
    },
    onStop() {
        try { pywebview.api.disconnect_hr().catch(() => {}); } catch (e) { console.warn(e); }
    },
});

/* 进程卡：纯前端拉取式，无后端常驻服务，删卡后停掉轮询即可。 */
registerCardFetcher({
    match: 'proc-section',
    fn: refreshTopProcess,
    ms: 2000,
});
