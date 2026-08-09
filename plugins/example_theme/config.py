"""示例插件：主题

本插件演示如何通过 register(ctx) 中的 ctx.register_theme() 提供一套
全新的配色方案。colors 中的 key 对应 style.css 中的 CSS 变量
（nord0 ~ nord14、bg_rgb、--metric-cpu/gpu/mem/fps 等），MoMoitor 会在
启动时把它们注入为 [data-colorscheme="value"] 选择器，并自动出现在
设置-主题 的候选列表中。
"""

# 插件名称（必需）
NAME = "Synthwave Theme"

# 插件版本（必需）
VERSION = "1.0.0"

# 作者（必需）
AUTHOR = "MoMoitor"

# 插件描述（可选，会显示在 设置-插件 页面）
DESCRIPTION = "A neon synthwave color scheme. Turn it on in Settings > Theme > Appearance."
