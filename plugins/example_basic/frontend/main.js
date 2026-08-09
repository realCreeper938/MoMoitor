/* 示例插件前端脚本
 * 通过全局对象 PluginApi 与 MoMoitor 交互。
 * 本文件在启动时被注入并立即执行。
 */
(function () {
    'use strict';

    // 国际化：补充自己的翻译（也可以覆盖现有 key）
    PluginApi.addI18n('en', {
        'example-title': 'Example',
        'example-lang': 'lang',
    });
    PluginApi.addI18n('zh', {
        'example-title': '示例',
        'example-lang': '语言',
    });

    // 注册一张卡片
    PluginApi.registerCard({
        id: 'example-card',
        title: { en: 'Example Card', zh: '示例卡片' },
        label: 'EX',
        color: 'var(--orange)',
        interval: 2000,
        getData: async () => {
            const hello = await pywebview.api.example_hello('MoMoitor');
            return { hello: hello, lang: getCurrentLang() };
        },
        render(el, data) {
            if (!data) return;
            el.innerHTML =
                '<div class="split-row">' +
                '  <div class="data-col">' +
                '    <div class="value-row">' +
                '      <span class="metric-value big mono">' + data.hello + '</span>' +
                '    </div>' +
                '    <div class="info-line">' + t('example-lang') + ': ' + data.lang + '</div>' +
                '  </div>' +
                '</div>';
        },
    });

    // 生命周期钩子
    PluginApi.onReady(() => console.log('[example_basic] frontend ready'));

    // 每个轮询周期拿到一次快照（已被 Python 端 on_snapshot 钩子修改）
    PluginApi.onPoll(data => {
        const out = document.getElementById('example-hook-out');
        if (out && data.example) {
            out.textContent = 'snapshot time: ' + data.example.time.toFixed(1);
        }
    });

    // 订阅 Python 端发来的事件
    PluginApi.on('example_hello', payload => {
        console.log('[example_basic] event from python:', payload);
    });

    // 在「常规」设置页添加一组配置项
    PluginApi.registerSettingsGroup({
        tab: 'general',
        id: 'example',
        title: { en: 'Example Plugin', zh: '示例插件' },
        html:
            '<div class="setting-item">' +
            '  <span>' + t('example-lang') + '</span>' +
            '  <span class="mono" id="example-hook-out">--</span>' +
            '</div>' +
            '<div class="setting-desc">Snapshot hook output (updates every poll).</div>',
        onLoad() {
            const out = document.getElementById('example-hook-out');
            if (out) out.textContent = 'settings opened';
        },
        onSave() {
            console.log('[example_basic] settings section save');
        },
    });
})();
