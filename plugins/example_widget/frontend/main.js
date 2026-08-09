/* 示例插件：纯前端小部件
 * 没有 Python 端代码，仅通过 PluginApi.registerCard 注册一张卡片。
 */
(function () {
    'use strict';

    const bootTime = Date.now();

    PluginApi.registerCard({
        id: 'uptime-card',
        title: { en: 'Uptime', zh: '运行时间' },
        label: 'UP',
        color: 'var(--green)',
        interval: 1000,
        layout: { col: 3, row: 6, span: 1 },
        render(el) {
            const totalSec = Math.floor((Date.now() - bootTime) / 1000);
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            el.innerHTML =
                '<div class="split-row">' +
                '  <div class="data-col">' +
                '    <div class="value-row">' +
                '      <span class="metric-value big mono">' + h + 'h ' + m + 'm</span>' +
                '    </div>' +
                '    <div class="info-line">' + s + 's since launch</div>' +
                '  </div>' +
                '</div>';
        },
    });
})();
