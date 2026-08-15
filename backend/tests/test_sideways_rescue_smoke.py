# -*- coding: utf-8 -*-
"""冒烟测试：_ocr_sideways_rescue 横躺自愈（OCR 出口转角重识别）。

不依赖 UMI/Vision 在线：monkeypatch ocr_image_bytes，
横躺原图返回乱码短文本、转正后返回正常长文本，验证自愈采纳旋转结果。
"""
import asyncio
import io
import sys

sys.path.insert(0, ".")

from backend.app.services import document_extract as de


def _make_jpeg(w: int, h: int) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 200, 200)).save(buf, format="JPEG", quality=90)
    return buf.getvalue()


async def main():
    # 场景图：1131x1600（DARIA 案同款竖版页型）
    sideways = _make_jpeg(1131, 1600)

    calls = {"n": 0}

    async def fake_ocr(content, engine=None, boxes_out=None):
        calls["n"] += 1
        # 原始（横躺）字节 → 乱码 85 字符；其余（旋转后）→ 正常 460 字符
        if content == sideways:
            return "louang\noo an\n90280\neoaa/o\n1280\nHO\n HOHOa SA\nVAV\n98998g", None
        if boxes_out is not None:
            boxes_out["boxes"] = [[1, 2, 3, 4]]
            boxes_out["ocr_size"] = (1600, 1131)
        return "POCCMMCKAEIEPAIM\nRUSSIANFEDERATION\n" + ("MINAEVA DARIA " * 30), None

    orig = de.ocr_image_bytes
    de.ocr_image_bytes = fake_ocr
    try:
        boxes: dict = {}
        out_bytes, text, fallback = await de._ocr_sideways_rescue(sideways, "umi", boxes)
        assert calls["n"] >= 2, f"FAIL: 未做转角重试（只调了 {calls['n']} 次）"
        assert len(text) >= 400, f"FAIL: 未采纳转正结果（len={len(text)}）"
        assert out_bytes != sideways, "FAIL: 未返回旋转后的图片字节"
        assert boxes.get("boxes") == [[1, 2, 3, 4]], f"FAIL: boxes_out 未同步 {boxes}"
        assert boxes.get("ocr_size") == (1600, 1131), "FAIL: ocr_size 未同步"
        print(f"OK 横躺自愈：{calls['n']} 次识别后采纳转正结果（{len(text)} 字符），boxes 已同步")

        # 反向保护：正常直立页（文本充足）不触发重试
        calls["n"] = 0

        async def fake_ok(content, engine=None, boxes_out=None):
            calls["n"] += 1
            return "NORMAL PAGE " * 40, None

        de.ocr_image_bytes = fake_ok
        upright = _make_jpeg(1200, 1600)
        out_bytes, text, _ = await de._ocr_sideways_rescue(upright, "umi", {})
        assert calls["n"] == 1, f"FAIL: 正常页不应重试（调了 {calls['n']} 次）"
        assert out_bytes == upright and len(text) > 100, "FAIL: 正常页结果被改动"
        print("OK 正常页不触发自愈（1 次识别原样返回）")

        # 条幅保护：MRZ 底条（宽高比 > 2.8）短文本也不重试
        calls["n"] = 0

        async def fake_short(content, engine=None, boxes_out=None):
            calls["n"] += 1
            return "P<RUSMINAEVA<<DARIA<<<", None

        de.ocr_image_bytes = fake_short
        strip = _make_jpeg(1510, 339)
        out_bytes, text, _ = await de._ocr_sideways_rescue(strip, "umi", {})
        assert calls["n"] == 1, f"FAIL: 条幅不应重试（调了 {calls['n']} 次）"
        print("OK MRZ 条幅不触发自愈（宽高比守卫生效）")
    finally:
        de.ocr_image_bytes = orig
    print("ALL PASS")


asyncio.run(main())
