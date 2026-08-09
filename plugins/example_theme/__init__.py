"""示例主题插件的 register() 入口。

主题不再依赖 config.py 中的 TYPE/THEME 字段，而是统一在 register(ctx)
里通过 ctx.register_theme() 注册。这样主题插件与普通插件完全等价，
只是额外调用了 register_theme。
"""

THEME = {
    # 配色方案的值（写入设置 colorscheme），需唯一
    "value": "synthwave",
    # 显示名称
    "name": "Synthwave",
    # 深色主题为 True，浅色主题为 False
    "dark": True,
    # 配色字典：CSS 变量名（去掉 -- 前缀）-> 值
    "colors": {
        "nord0": "#1a1025",
        "nord1": "#241536",
        "nord2": "#33204f",
        "nord3": "#4a2d6e",
        "nord4": "#f8f8f2",
        "nord5": "#d7b8f5",
        "nord6": "#ffe3ff",
        "nord7": "#b3f0d0",
        "nord8": "#00ffff",
        "nord9": "#ff2d95",
        "nord10": "#36f9f6",
        "nord11": "#ffb86c",
        "nord12": "#ffeaa7",
        "nord13": "#5ef1ce",
        "nord14": "#bd93f9",
        "bg_rgb": "26, 16, 37",
        "metric_cpu": "#5ef1ce",
        "metric_gpu": "#00ffff",
        "metric_mem": "#bd93f9",
        "metric_fps": "#ffb86c",
    },
}


def register(ctx):
    ctx.register_theme(THEME)
