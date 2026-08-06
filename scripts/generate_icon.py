"""
Generate MoMoitor application icon.

Design:
- 1024x1024 base, with multiple sizes packed into .ico
- Transparent background
- Rounded-rect program window with drop shadow
- Border gradient: blue → flesh/peach
- Horizontal monitoring bars inside the window
"""

from PIL import Image, ImageDraw, ImageFilter
import os

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets")
OUTPUT_ICO = os.path.join(OUTPUT_DIR, "app.ico")
OUTPUT_PNG = os.path.join(OUTPUT_DIR, "app.png")
BASE_SIZE = 1024


def create_icon_image(size: int) -> Image.Image:
    """Create a single icon frame at the given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── Layout calculations ──────────────────────────────────────────
    margin = size * 0.07
    shadow_offset = size * 0.03
    corner_radius = size * 0.10
    window_left = margin
    window_top = margin
    window_right = size - margin
    window_bottom = size - margin

    # ── Drop shadow ──────────────────────────────────────────────────
    shadow_left = window_left + shadow_offset
    shadow_top = window_top + shadow_offset
    shadow_right = window_right + shadow_offset
    shadow_bottom = window_bottom + shadow_offset

    shadow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    shadow_draw.rounded_rectangle(
        [shadow_left, shadow_top, shadow_right, shadow_bottom],
        radius=corner_radius,
        fill=(0, 0, 0, 100),
    )
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=size * 0.045))
    img = Image.alpha_composite(img, shadow_layer)
    draw = ImageDraw.Draw(img)

    # ── Window body (dark fill) ──────────────────────────────────────
    window_rect = [window_left, window_top, window_right, window_bottom]
    draw.rounded_rectangle(
        window_rect,
        radius=corner_radius,
        fill=(28, 28, 38, 248),
    )

    # ── Gradient border ──────────────────────────────────────────────
    # Blue (#4A90D9) → Flesh/peach (#FFB088)
    border_w = size * 0.032

    # Create a mask for the border area
    border_mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(border_mask)
    # Outer rect: border outer edge
    mask_draw.rounded_rectangle(
        [
            window_left - border_w,
            window_top - border_w,
            window_right + border_w,
            window_bottom + border_w,
        ],
        radius=corner_radius + border_w,
        fill=255,
    )
    # Inner rect: punch out the window interior
    mask_draw.rounded_rectangle(window_rect, radius=corner_radius, fill=0)

    # Create gradient layer using the mask
    gradient_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for x in range(int(window_left - border_w), int(window_right + border_w) + 1):
        t = (x - (window_left - border_w)) / (window_right - window_left + 2 * border_w)
        t = max(0, min(1, t))
        r = int(74 + (255 - 74) * t)
        g = int(144 + (176 - 144) * t)
        b = int(217 + (136 - 217) * t)
        for y in range(int(window_top - border_w), int(window_bottom + border_w) + 1):
            if 0 <= x < size and 0 <= y < size:
                if border_mask.getpixel((x, y)) > 128:
                    gradient_layer.putpixel((x, y), (r, g, b, 255))

    img = Image.alpha_composite(img, gradient_layer)
    draw = ImageDraw.Draw(img)

    # ── Title bar ────────────────────────────────────────────────────
    title_bar_h = size * 0.12
    title_top = window_top + border_w
    title_left = window_left + border_w
    title_right = window_right - border_w

    # Slightly lighter top area
    draw.rectangle(
        [title_left, title_top, title_right, title_top + title_bar_h],
        fill=(42, 42, 56, 200),
    )

    # Window control dots (traffic-light style)
    dot_cy = title_top + title_bar_h / 2
    dot_r = size * 0.016
    dot_start_x = title_left + size * 0.04
    dot_gap = size * 0.05
    dot_colors = [
        (255, 95, 87, 240),   # close (red)
        (255, 189, 46, 240),  # minimize (yellow)
        (39, 201, 63, 240),   # maximize (green)
    ]
    for i, col in enumerate(dot_colors):
        cx = dot_start_x + i * dot_gap
        draw.ellipse(
            [cx - dot_r, dot_cy - dot_r, cx + dot_r, dot_cy + dot_r],
            fill=col,
        )

    # Title bar text placeholder
    text_x = dot_start_x + 3 * dot_gap + size * 0.02
    text_w = size * 0.18
    text_h = size * 0.014
    draw.rounded_rectangle(
        [text_x, dot_cy - text_h / 2, text_x + text_w, dot_cy + text_h / 2],
        radius=text_h // 2,
        fill=(170, 170, 185, 180),
    )

    # ── Inner content area ───────────────────────────────────────────
    content_margin = size * 0.05
    content_top = title_top + title_bar_h + size * 0.03
    content_left = title_left + content_margin
    content_right = title_right - content_margin
    content_bottom = window_bottom - border_w - size * 0.03
    available_h = content_bottom - content_top

    # 5 monitoring rows
    num_rows = 5
    row_gap = size * 0.025
    row_h = (available_h - row_gap * (num_rows - 1)) / num_rows

    # Color palette for row indicators — blue → flesh gradient spread
    row_accent_colors = [
        (74, 144, 217),     # blue
        (120, 165, 200),    # blue-gray
        (180, 165, 170),   # transitional
        (220, 170, 150),   # warm
        (255, 176, 136),   # flesh/peach
    ]

    # Progress bar fill ratios (varying lengths for visual interest)
    fill_ratios = [0.78, 0.42, 0.91, 0.35, 0.65]

    for i in range(num_rows):
        row_top = content_top + i * (row_h + row_gap)
        row_bottom = row_top + row_h

        # Row panel background
        draw.rounded_rectangle(
            [content_left, row_top, content_right, row_bottom],
            radius=size * 0.018,
            fill=(40, 40, 52, 170),
        )

        # Small icon square on the left
        icon_s = row_h * 0.48
        icon_x = content_left + size * 0.035
        icon_y = row_top + (row_h - icon_s) / 2
        draw.rounded_rectangle(
            [icon_x, icon_y, icon_x + icon_s, icon_y + icon_s],
            radius=icon_s * 0.25,
            fill=row_accent_colors[i] + (210,),
        )

        # Inner icon detail — small shape inside the icon square
        inner_m = icon_s * 0.25
        draw.rounded_rectangle(
            [
                icon_x + inner_m,
                icon_y + inner_m,
                icon_x + icon_s - inner_m,
                icon_y + icon_s - inner_m,
            ],
            radius=icon_s * 0.12,
            fill=(255, 255, 255, 140),
        )

        # Progress bar track
        bar_left = content_left + size * 0.12
        bar_right = content_right - size * 0.04
        bar_h = row_h * 0.2
        bar_cy = row_top + row_h / 2
        bar_y = bar_cy - bar_h / 2

        # Track background
        draw.rounded_rectangle(
            [bar_left, bar_y, bar_right, bar_y + bar_h],
            radius=bar_h // 2,
            fill=(55, 55, 70, 160),
        )

        # Filled portion
        fill_right = bar_left + (bar_right - bar_left) * fill_ratios[i]
        draw.rounded_rectangle(
            [bar_left, bar_y, fill_right, bar_y + bar_h],
            radius=bar_h // 2,
            fill=row_accent_colors[i] + (230,),
        )

        # Value label on the right
        val_w = size * 0.045
        val_h = row_h * 0.22
        val_x = bar_right + size * 0.012
        val_y = bar_cy - val_h / 2
        draw.rounded_rectangle(
            [val_x, val_y, val_x + val_w, val_y + val_h],
            radius=val_h // 2,
            fill=row_accent_colors[i] + (190,),
        )

    return img


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Generate base 1024x1024
    base_img = create_icon_image(BASE_SIZE)

    # Save high-res PNG
    base_img.save(OUTPUT_PNG, format="PNG")
    print(f"Saved PNG: {OUTPUT_PNG}")

    # Generate ICO with multiple sizes
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_frames = []
    for s in ico_sizes:
        frame = create_icon_image(s)
        ico_frames.append(frame)

    # Save ICO
    base_img.save(
        OUTPUT_ICO,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_frames,
    )
    print(f"Saved ICO: {OUTPUT_ICO} with sizes {ico_sizes}")


if __name__ == "__main__":
    main()
