"""端到端测试 configurable 工作流：含人工登录暂停步骤。"""
import asyncio
import json
import time
import requests

BASE = "http://localhost:8000/api"


def main():
    # 1. 上传 Excel（如果还没传）
    with open("d:\\CINSIDE\\左侧-数据\\20260716 Transferring students.xlsx", "rb") as f:
        r = requests.post(f"{BASE}/upload/excel", files={"file": ("students.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}, timeout=30)
    print("upload", r.status_code, r.json()["count"])

    # 2. 启动 configurable 验证（含 manual 登录步骤）
    config = {
        "record_id": "rec-001",
        "university_url": "http://localhost:8000/mock/index.html",
        "workflow": [
            {"action": "manual", "description": "人工登录：在弹出的浏览器窗口中完成登录"},
            {"action": "screenshot", "description": "截图用于字段映射"}
        ],
        "mappings": [
            {"right_selector": "#name", "right_label": "Full Name", "left_source": "excel", "left_field": "student", "verify_method": "vision"},
            {"right_selector": "#email", "right_label": "Email", "left_source": "excel", "left_field": "id", "verify_method": "ocr"},
            {"right_selector": "#passport_no", "right_label": "Passport Number", "left_source": "excel", "left_field": "stream", "verify_method": "vision"},
        ],
        "use_vision_verify": True,
    }
    r = requests.post(f"{BASE}/verify/configurable", json=config, timeout=30)
    print("start", r.status_code, r.text)
    task_id = r.json()["task_id"]

    # 3. 通过 WebSocket 监听进度
    manual_seen = False

    async def listen_ws():
        nonlocal manual_seen
        import websockets
        ws_url = f"ws://localhost:8000/ws/verify/{task_id}"
        async with websockets.connect(ws_url) as ws:
            async for msg in ws:
                data = json.loads(msg)
                print("ws", data.get("type"), data.get("data", {}).get("action", ""), data.get("data", {}).get("description", "")[:80])
                if data["type"] == "step" and data["data"].get("action") == "manual":
                    manual_seen = True
                    return data["data"]
                if data["type"] == "step" and data["data"].get("action") in ("final", "error"):
                    return data["data"]

    final = asyncio.run(listen_ws())
    print("manual_seen", manual_seen, "partial final", final)

    if manual_seen:
        print("模拟人工登录完成，调用 continue...")
        r = requests.post(f"{BASE}/verify/{task_id}/continue", timeout=10)
        print("continue", r.status_code, r.text)

        # 继续监听直到最终完成
        async def listen_ws2():
            import websockets
            ws_url = f"ws://localhost:8000/ws/verify/{task_id}"
            async with websockets.connect(ws_url) as ws:
                async for msg in ws:
                    data = json.loads(msg)
                    print("ws2", data.get("type"), data.get("data", {}).get("action", ""), data.get("data", {}).get("description", "")[:80])
                    if data["type"] == "step" and data["data"].get("action") in ("final", "error"):
                        return data["data"]

        final = asyncio.run(listen_ws2())
        print("final after continue", final)

    # 4. 拉取报告
    time.sleep(0.5)
    r = requests.get(f"{BASE}/verify/report/{task_id}", timeout=30)
    print("report", r.status_code)
    if r.status_code == 200:
        report = r.json()
        print(json.dumps(report, ensure_ascii=False, indent=2)[:3000])
    else:
        print(r.text[:500])

    # 5. 下载 Excel
    r = requests.get(f"{BASE}/verify/report/{task_id}/excel", timeout=30)
    print("excel", r.status_code, r.headers.get("content-disposition"))
    if r.status_code == 200:
        path = f"d:\\CINSIDE\\report_{task_id}.xlsx"
        with open(path, "wb") as f:
            f.write(r.content)
        print("saved", path)


if __name__ == "__main__":
    main()
