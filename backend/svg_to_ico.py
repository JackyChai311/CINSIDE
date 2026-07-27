"""把 SVG 渲染成多尺寸 ICO 文件。"""
from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image
from svglib.svglib import svg2rlg
from reportlab.graphics import renderPM


def _render_svg_png(svg_path: str, size: int, base: Image.Image) -> bytes:
    img = base.resize((size, size), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def create_ico(svg_path: str, output_path: str, sizes: list[int] | None = None) -> None:
    sizes = sizes or [16, 32, 48, 64, 128, 256]

    # reportlab 渲染时忽略 w/h，先按高分辨率渲染一次，再用 PIL 缩放
    drawing = svg2rlg(svg_path)
    hi_res = max(sizes) * 2
    png = renderPM.drawToString(drawing, fmt="PNG", w=hi_res, h=hi_res)
    base = Image.open(io.BytesIO(png))
    if base.mode != "RGBA":
        base = base.convert("RGBA")

    images: list[bytes] = []
    for size in sizes:
        images.append(_render_svg_png(svg_path, size, base))

    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    directory = b""
    data_offset = 6 + 16 * count
    data = b""

    for idx, (size, png_bytes) in enumerate(zip(sizes, images)):
        width = size if size < 256 else 0
        height = width
        directory += struct.pack(
            "<BBBBHHII",
            width,
            height,
            0,  # colors
            0,  # reserved
            1,  # color planes
            32,  # bits per pixel
            len(png_bytes),
            data_offset,
        )
        data += png_bytes
        data_offset += len(png_bytes)

    Path(output_path).write_bytes(header + directory + data)


if __name__ == "__main__":
    import sys

    svg = sys.argv[1] if len(sys.argv) > 1 else "d:/CINSIDE/assets/app-icon.svg"
    ico = sys.argv[2] if len(sys.argv) > 2 else "d:/CINSIDE/assets/app-icon.ico"
    create_ico(svg, ico)
    print(f"Created {ico}")
