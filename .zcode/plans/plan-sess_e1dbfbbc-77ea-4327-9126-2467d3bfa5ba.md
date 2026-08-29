## 游戏模式实现方案

### 行为规格
- **进入**：GPU 占用率（快照中的 `gpu.load`）> 60% 持续 6 秒 → 自动进入游戏模式
- **退出**：GPU 占用率 ≤ 60% 持续 15 秒（防加载画面/菜单短暂低负载导致来回切换）；GPU 数据为 null 时按低负载处理
- **进入后**：
  - 主数据轮询间隔强制为 `max(用户设置间隔, 1500ms)`（用户已设 2s/5s 时不反向提速），FPS 卡轮询同步降至 1500ms
  - 加 `body.game-mode` class：CSS 装饰动画全部关闭（温度告警脉冲、心率跳动、弹窗渐入、设置页滑动、加载 spinner 等）；**transition 不关**（悬停/开关/滑块反馈属交互动画）；点击涟漪、清内存动画用保留规则恢复原时长
  - 冻结频谱可视化（`__spectrum` 推送入口直接丢弃 bands，rAF 自然衰减停止）与歌词平滑滚动（复用现有"关闭平滑→500ms 步进跳变"分支，功能保留）
  - 临时强制关闭"卡片渐变"（`no-card-grad`）与"背景走势图"（`no-bg-charts`），复用现有 class 与 CSS，退出后按用户设置恢复
  - 进入/退出时 toast 提示
- **设置项**：`general.game_mode`（布尔，默认 True）。关闭后立即退出游戏模式并停止检测
- 检测在前端 `poll()` 循环内做（数据本就每秒到达前端，与现有 CPU≥95% 自动节流先例一致），后端零改动

### 文件改动
1. **`momoitor/config.py`**：`general` 组新增 `"game_mode": True`（约 204 行 bg_charts 之后）。`_normalize_settings()` 会自动回填新键，无需升 SCHEMA_VERSION
2. **新建 `momoitor/web/js/gamemode.js`**（约 90 行，加载顺序放在 core.js 之后）：状态与时间戳跟踪（`_highSince`/`_lowSince`）、`gameModeFeed(load)` 检测入口、`isGameModeActive()`、`applyGameMode(on)`（切 body class、调 `applyCardGradient`/`applyBgCharts`、`_startInterval` 调 FPS 轮询、toast）、`forceExitGameMode()`。core.js 已 949 行（超 800 上限），故独立成文件
3. **`momoitor/web/js/core.js`**（2 处小改动）：
   - `poll()` 内 `updateUI(data)` 后调用 `window.gameModeFeed(data.gpu ? data.gpu.load : null)`
   - `poll()` finally 的重调度间隔改为：游戏模式 `max(userInterval, 1500)`，否则维持 `throttled ? 2000 : userInterval`
4. **`momoitor/web/js/music.js`**（2 处小改动）：
   - `window.__spectrum` 入口：游戏模式时清空 `_spec.target` 并 return（rAF 自然停止，退出后下一次推送自动恢复）
   - `_scrollCurrentLine`：游戏模式时走现有步进跳变分支（不逐帧缓动）
5. **`momoitor/web/js/settings.js`**：新增 `gameModeChk` 引用；`openSettings()` 填充勾选态，且 `applyCardGradient`/`applyBgCharts` 调用加"游戏模式激活时保持关闭"（openSettings 与 saveSettings 两处共 4 行）；`saveSettings()` 写入 `game_mode`；保存后发现勾掉时调 `forceExitGameMode()`
6. **`momoitor/web/index.html`**：刷新间隔设置项（约 810 行）后新增开关行（`setting-label` + `setting-sub` 描述 + toggle，`id="opt-game-mode"`）；script 区引入 `js/gamemode.js`（core.js 之后）
7. **`momoitor/web/js/i18n.js`**：en/zh 各加 4 键：`label-game-mode`（Auto Game Mode / 自动游戏模式）、`desc-game-mode`、`toast-game-mode-on`、`toast-game-mode-off`
8. **`momoitor/web/css/base.css`**（现 86 行，容量充足；responsive.css 已 770 行接近上限）：`body.game-mode` 全局动画禁用规则（仿 `prefers-reduced-motion` 块，只关 animation 不关 transition）+ 5 条交互动画保留规则（涟漪 0.5s、memSweep 0.7s、memGlow 0.9s、memPulse 0.65s、infoSwapIn 0.3s，时长照抄原值）；index.html 中 base.css 的 `?v=37` bump 为 `?v=38`（JS 文件无版本参数，无需处理）
9. **`tests/test_config.py`**：新增断言 `general.game_mode` 默认值为 True 且加载时能自动回填

### 验证
- `python scripts/build.py check`、`python -m pytest -q`
- 改动的 JS 逐个 `node --check`
- 自审：边界（gpu.load 为 null/0、设置运行中开关、设置面板打开时进游戏、FPS 卡已删除、server 模式 shim）与资源（无新增定时器泄漏——复用 `_startInterval` 的按名替换机制）

### 不做的事
- 不动后端（频谱服务后端采集继续，仅前端不渲染，开销可忽略）
- 不动心率/进程卡轮询（随卡片可见性启停，游戏时通常不存在）
- 不改 `refresh_interval` 设置本身（游戏模式是临时覆盖，退出即恢复）