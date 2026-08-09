"""示例数据源插件的 register() 入口。

数据源不再依赖 config.py 中的 TYPE/DATA_SOURCE 字段，而是统一在
register(ctx) 里通过 ctx.register_data_source() 注册，并直接传入
Monitor 类（见 monitor.py）。注册后即可在 设置-数据 中选择。
"""

from .monitor import Monitor

DATA_SOURCE = {
    # 数据源的值（写入设置 data_source），需唯一
    "value": "demo",
    # 下拉框中显示的名称
    "label": "Demo (random)",
    # 描述（可选）
    "description": "Randomized hardware data with smooth jitter.",
}


def register(ctx):
    ctx.register_data_source(DATA_SOURCE, Monitor)
