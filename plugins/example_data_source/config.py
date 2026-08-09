"""示例插件：数据源

本插件演示如何通过 register(ctx) 中的 ctx.register_data_source() 提供
一个自定义的硬件后端，替代内置的 lhm / hwinfo。启用后，它会在
设置-数据 的数据源下拉框中出现，选择并重启即可生效。
"""

# 插件名称（必需）
NAME = "Demo Data Source"

# 插件版本（必需）
VERSION = "1.0.0"

# 作者（必需）
AUTHOR = "MoMoitor"

# 插件描述（可选，会显示在 设置-插件 页面）
DESCRIPTION = "A randomized demo data source for testing the plugin interface."
