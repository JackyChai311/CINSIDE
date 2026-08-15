# -*- coding: utf-8 -*-
"""冒烟测试：_call_umi_ocr 的 in-flight 去重（并发同图只识别一次）。

不依赖 UMI-OCR / 核显加速在线：直接 monkeypatch _ocr_run 计数。
"""
import asyncio
import sys
import time

sys.path.insert(0, ".")

from backend.app.services import document_extract as de


async def main():
    calls = {"n": 0}

    async def fake_ocr_run(content, cache_key):
        calls["n"] += 1
        await asyncio.sleep(0.5)  # 模拟一次真实识别耗时
        # 真实 _ocr_run 内部负责写 LRU，mock 里补上（第二个用例依赖缓存命中）
        de._ocr_cache_put(cache_key, "HELLO", [[0, 0, 1, 1]], (100, 100), "gpu")
        return "HELLO", [[0, 0, 1, 1]], (100, 100), "gpu"

    orig = de._ocr_run
    de._ocr_run = fake_ocr_run
    orig_igpu = de.settings.igpu_acceleration
    try:
        de.settings.igpu_acceleration = True  # 保证 _ocr_run 的 GPU 分支被执行（被 mock）
        t0 = time.perf_counter()
        # 同一张图并发首发两次（模拟 preview 裁切 + 正式提取）
        r1, r2 = await asyncio.gather(
            de._call_umi_ocr(b"same-image-bytes", want_boxes=True),
            de._call_umi_ocr(b"same-image-bytes", want_boxes=True),
        )
        dt = time.perf_counter() - t0

        assert calls["n"] == 1, f"FAIL: 期望识别 1 次，实际 {calls['n']} 次"
        assert dt < 0.9, f"FAIL: 并发未共享（耗时 {dt:.2f}s ≈ 两次串行）"
        assert r1 == ("HELLO", [[0, 0, 1, 1]], (100, 100)), f"FAIL: want_boxes 形状异常 {r1}"
        assert r2 == r1, f"FAIL: 两个并发调用结果不一致"
        assert de._last_ocr_backend == "gpu", f"FAIL: backend 标记 {de._last_ocr_backend}"
        print(f"OK 并发去重：识别 {calls['n']} 次，耗时 {dt:.2f}s（两次串行应 >1s）")

        # 缓存命中：第三次（串行）应零识别
        de._ocr_run = fake_ocr_run
        t1 = time.perf_counter()
        r3 = await de._call_umi_ocr(b"same-image-bytes")
        assert calls["n"] == 1, "FAIL: 缓存未命中，重复识别"
        assert r3 == "HELLO"
        print(f"OK LRU 命中：总识别仍 {calls['n']} 次，复用 {time.perf_counter()-t1:.3f}s")

        # 不同图并发：应各识别一次（不能误去重）
        async def fake2(content, cache_key):
            calls["n"] += 1
            await asyncio.sleep(0.2)
            return "B", [], (1, 1), "umi"
        de._ocr_run = fake2
        a, b = await asyncio.gather(
            de._call_umi_ocr(b"img-A"),
            de._call_umi_ocr(b"img-B"),
        )
        assert calls["n"] == 3, f"FAIL: 不同图应各识别一次，实际总数 {calls['n']}"
        assert a == "B" and b == "B"
        print("OK 不同图不去重：各识别一次")

        # 异常传播：识别失败时两个并发等待者都拿到异常，且不留 in-flight 残留
        async def boom(content, cache_key):
            calls["n"] += 1
            await asyncio.sleep(0.1)
            raise RuntimeError("engine down")
        de._ocr_run = boom
        results = await asyncio.gather(
            de._call_umi_ocr(b"bad-img"),
            de._call_umi_ocr(b"bad-img"),
            return_exceptions=True,
        )
        assert all(isinstance(r, RuntimeError) and "engine down" in str(r) for r in results), results
        assert not de._ocr_inflight, f"FAIL: in-flight 残留 {list(de._ocr_inflight)}"
        print("OK 异常传播 + in-flight 清理")
        print("ALL PASS")
    finally:
        de._ocr_run = orig
        de.settings.igpu_acceleration = orig_igpu


if __name__ == "__main__":
    asyncio.run(main())
