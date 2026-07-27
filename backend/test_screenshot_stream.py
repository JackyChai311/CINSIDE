"""端到端测试截图流：上传 Excel → 启动核验 → WS 接收 step + screenshot 事件。"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
from websockets import connect

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BASE = "http://localhost:8000"
WS_BASE = "ws://localhost:8000"
SAMPLE_CSV = Path(__file__).resolve().parent.parent / "samples" / "sample_applicants.csv"
MOCK_URL = "http://localhost:8000/mock/"


async def main():
    async with httpx.AsyncClient(base_url=BASE, timeout=30, trust_env=False) as client:
        # 1) 健康检查
        r = await client.get("/api/health")
        print(f"[health] {r.json()}")

        # 2) 上传 Excel（如果还没有记录）
        r = await client.get("/api/records")
        records = r.json().get("records", [])
        if not records and SAMPLE_CSV.exists():
            print(f"[upload] 上传 {SAMPLE_CSV.name}")
            with open(SAMPLE_CSV, "rb") as f:
                r = await client.post(
                    "/api/upload/excel",
                    files={"file": (SAMPLE_CSV.name, f, "text/csv")},
                )
            records = r.json().get("records", [])
            print(f"[upload] 得到 {len(records)} 条记录")
        if not records:
            print("没有记录可测，退出")
            return

        rec = records[0]
        print(f"[record] 使用 {rec['record_id']}: {rec.get('fields', {}).get('name', '?')}")

        # 3) 启动核验
        r = await client.post(
            "/api/verify",
            json={"record_id": rec["record_id"], "university_url": MOCK_URL},
        )
        task_id = r.json()["task_id"]
        print(f"[verify] task_id = {task_id}")

        # 4) 连 WS 接收事件
        step_count = 0
        shot_count = 0
        shot_bytes = 0
        async with connect(f"{WS_BASE}/ws/verify/{task_id}") as ws:
            print("[ws] 已连接，等待事件…")
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=180)
                except asyncio.TimeoutError:
                    print("[ws] 180s 超时")
                    break
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "step":
                    step_count += 1
                    d = msg["data"]
                    flag = "OK" if d.get("success") else "ERR"
                    print(f"  [step {step_count:>2}] [{flag}] {d.get('action'):<10} {d.get('description','')[:60]}")
                elif t == "screenshot":
                    shot_count += 1
                    d = msg["data"]
                    shot_len = len(d.get("screenshot", ""))
                    shot_bytes += shot_len
                    hint = d.get("action_hint") or ""
                    url = d.get("url") or ""
                    boxes_n = len(d.get("boxes") or [])
                    vw = d.get("viewport_width")
                    vh = d.get("viewport_height")
                    print(f"  [shot {shot_count:>2}] step={d.get('step')} bytes={shot_len} url={url[:50]} hint={hint[:40]} boxes={boxes_n} viewport={vw}x{vh}")
                    if boxes_n > 0:
                        for b in (d.get("boxes") or [])[:5]:
                            print(f"           box: sel={b.get('selector')} label={b.get('label')} match={b.get('match_status')} bbox=({b.get('x')},{b.get('y')},{b.get('width')},{b.get('height')})")
                elif t == "done":
                    d = msg["data"]
                    print(f"\n[done] overall={d.get('overall')} comparisons={len(d.get('comparisons',[]))}")
                    break
                elif t == "ping":
                    continue
                elif t == "error":
                    print(f"[error] {msg.get('data')}")
                    break

        print(f"\n=== 统计 ===")
        print(f"  step 事件: {step_count}")
        print(f"  screenshot 事件: {shot_count}（总 {shot_bytes/1024:.1f} KB base64）")
        if shot_count > 0:
            print(f"  ✅ 截图流工作正常！前端可以显示 AI 视野")
        else:
            print(f"  ❌ 没收到截图事件")


if __name__ == "__main__":
    asyncio.run(main())
