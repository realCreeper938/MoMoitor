"""示例插件：基础功能插件

本插件演示了插件系统的大部分能力：
- 前端 head/body/样式/脚本注入
- 注册新的卡片
- 注册自定义 API 方法
- 快照钩子（on_snapshot）
- 生命周期钩子（on_startup / on_shutdown）
- 设置保存钩子（on_settings_saved）
- 注册设置页分组
- 国际化（addI18n）
"""

# 插件名称（必需）
NAME = "Example Basic Plugin"

# 插件版本（必需）
VERSION = "1.0.0"

# 作者（必需）
AUTHOR = "MoMoitor"

# 插件描述（可选，会显示在 设置-插件 页面）
DESCRIPTION = "A demo plugin that shows off the plugin API: cards, API methods, snapshot hooks, settings groups and i18n."

# 项目主页（可选）
HOMEPAGE = "https://github.com/realCreeper938/MoMoitor"
