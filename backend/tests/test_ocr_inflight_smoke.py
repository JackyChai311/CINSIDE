# -*- coding: utf-8 -*-
"""冒烟测试：_call_umi_ocr 的 in-flight 去重（并发同图只识别一次）。

不依赖 UMI-OCR / 核显加速在线：直接 monkeypatch _ocr_run 计数。

本文件由原来的独立脚本（asyncio.run(main())）改写为真正的 pytest 用例：
- 断言语义与原脚本逐条对应，未放宽/未加强；
- 手工 save/restore（orig = ... / try / finally）改为 monkeypatch.setattr；
- 原脚本的单一 calls 计数器被拆到各用例（每条用例从 0 开始），因此
  「不同图不去重」用例里总数从 3 变成 2——那正是「再各识别一次」的同一语义。
"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict

import pytest

from app.services import document_extract as de

IMAGE = b"same-image-bytes"
SHORT_IMAGE = b"bad-img"


@pytest.fixture
def ocr_isolated(monkeypatch):
    """隔离模块级 LRU / in-flight 表，并打开核显分支（_ocr_run 被 mock）。

    原脚本靠「单次执行、顺序累积状态」工作；拆成多个用例后必须逐例清空
    _ocr_cache / _ocr_inflight，否则用例顺序会影响结果。monkeypatch 结束时
    会把真正的 _ocr_cache / _ocr_inflight 对象原样还原。
    """
    monkeypatch.setattr(de, "_ocr_cache", OrderedDict())
    monkeypatch.setattr(de, "_ocr_inflight", {})
    monkeypatch.setattr(de.settings, "igpu_acceleration", True)
    return de


def test_concurrent_same_image_recognized_once(ocr_isolated, monkeypatch):
    """同一张图并发首发两次 → 只识别一次，且两个调用结果一致。"""
    calls = {"n": 0}

    async def fake_ocr_run(content, cache_key):
        calls["n"] += 1
        await asyncio.sleep(0.5)  # 模拟一次真实识别耗时
        # 真实 _ocr_run 内部负责写 LRU，mock 里补上（缓存用例依赖命中）
        de._ocr_cache_put(cache_key, "HELLO", [[0, 0, 1, 1]], (100, 100), "gpu")
        return "HELLO", [[0, 0, 1, 1]], (100, 100), "gpu"

    monkeypatch.setattr(de, "_ocr_run", fake_ocr_run)

    async def scenario():
        t0 = time.perf_counter()
        # 同一张图并发首发两次（模拟 preview 裁切 + 正式提取）
        r1, r2 = await asyncio.gather(
            de._call_umi_ocr(IMAGE, want_boxes=True),
            de._call_umi_ocr(IMAGE, want_boxes=True),
        )
        return r1, r2, time.perf_counter() - t0

    r1, r2, dt = asyncio.run(scenario())

    assert calls["n"] == 1, f"FAIL: 期望识别 1 次，实际 {calls['n']} 次"
    # 并发共享的语义由 calls["n"]==1 完全证明（一次识别、两个调用都拿到同一结果）。
    # 早期版本这里还断言耗时 dt < 0.9s，但「识别次数」才是本质——耗时受机器负载/
    # CI runner 抢占影响很大（共享 runner 上偶发飙到十几秒），把确定性断言退化成
    # 时间赌注，导致 CI 间歇性失败。故删去该时间阈值断言，dt 仅作信息打印保留。
    assert r1 == ("HELLO", [[0, 0, 1, 1]], (100, 100)), f"FAIL: want_boxes 形状异常 {r1}"
    assert r2 == r1, "FAIL: 两个并发调用结果一致"
    assert de._last_ocr_backend == "gpu", f"FAIL: backend 标记 {de._last_ocr_backend}"
    print(f"OK concurrent dedup: recognized {calls['n']} time(s) in {dt:.2f}s")


def test_serial_repeat_hits_lru_cache(ocr_isolated, monkeypatch):
    """串行重跑同一张图 → 命中 LRU，零额外识别。"""
    calls = {"n": 0}

    async def fake_ocr_run(content, cache_key):
        calls["n"] += 1
        await asyncio.sleep(0.5)
        de._ocr_cache_put(cache_key, "HELLO", [[0, 0, 1, 1]], (100, 100), "gpu")
        return "HELLO", [[0, 0, 1, 1]], (100, 100), "gpu"

    monkeypatch.setattr(de, "_ocr_run", fake_ocr_run)

    async def scenario():
        await de._call_umi_ocr(IMAGE)  # 首次识别：写 LRU
        t1 = time.perf_counter()
        r3 = await de._call_umi_ocr(IMAGE)  # 串行重跑：应命中缓存
        return r3, time.perf_counter() - t1

    r3, dt = asyncio.run(scenario())

    assert calls["n"] == 1, "FAIL: 缓存未命中，重复识别"
    assert r3 == "HELLO"
    print(f"OK LRU hit: total recognition still {calls['n']} time(s), reuse {dt:.3f}s")


def test_distinct_images_are_not_deduplicated(ocr_isolated, monkeypatch):
    """不同图并发 → 各识别一次（不能误去重）。

    原脚本此处断言总数 == 3，因为前面两个用例已累积识别 1 次；拆分后本用例
    从 0 起算，所以断言 2 —— 语义仍是「两张不同的图各识别一次」。
    """
    calls = {"n": 0}

    async def fake2(content, cache_key):
        calls["n"] += 1
        await asyncio.sleep(0.2)
        return "B", [], (1, 1), "umi"

    monkeypatch.setattr(de, "_ocr_run", fake2)

    async def scenario():
        return await asyncio.gather(
            de._call_umi_ocr(b"img-A"),
            de._call_umi_ocr(b"img-B"),
        )

    a, b = asyncio.run(scenario())

    assert calls["n"] == 2, f"FAIL: 不同图应各识别一次，实际总数 {calls['n']}"
    assert a == "B" and b == "B"
    print("OK distinct images: each recognized once (no false dedup)")


def test_recognition_failure_propagates_and_clears_inflight(ocr_isolated, monkeypatch):
    """识别异常 → 两个并发等待者都拿到异常，且不留 in-flight 残留。"""
    calls = {"n": 0}

    async def boom(content, cache_key):
        calls["n"] += 1
        await asyncio.sleep(0.1)
        raise RuntimeError("engine down")

    monkeypatch.setattr(de, "_ocr_run", boom)

    async def scenario():
        return await asyncio.gather(
            de._call_umi_ocr(SHORT_IMAGE),
            de._call_umi_ocr(SHORT_IMAGE),
            return_exceptions=True,
        )

    results = asyncio.run(scenario())

    assert all(isinstance(r, RuntimeError) and "engine down" in str(r) for r in results), results
    assert not de._ocr_inflight, f"FAIL: in-flight 残留 {list(de._ocr_inflight)}"
    print(f"OK exception propagation + in-flight cleanup (ocr_run calls={calls['n']})")
