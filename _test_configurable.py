import asyncio
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))
from dotenv import load_dotenv
load_dotenv("backend/.env")

async def main():
    from app.services.task_manager import (
        upsert_records,
        run_configurable_verification,
        get_report,
        store,
    )
    from app.models import ApplicantRecord, WorkflowConfig, WorkflowStep, FieldMapping

    upsert_records([
        ApplicantRecord(
            record_id="rec-test",
            source="excel",
            fields={
                "name": "ZHANG SAN",
                "email": "zhang.san@example.com",
                "passport_no": "E12345678",
            },
        )
    ])

    config = WorkflowConfig(
        record_id="rec-test",
        university_url="http://localhost:8000/mock/index.html",
        workflow=[WorkflowStep(action="screenshot", description="截图")],
        mappings=[
            FieldMapping(right_selector="#name", right_label="Full Name", left_source="excel", left_field="name", verify_method="vision"),
            FieldMapping(right_selector="#email", right_label="Email", left_source="excel", left_field="email", verify_method="vision"),
        ],
    )

    task_id = await run_configurable_verification(config)
    print("task_id:", task_id)

    # 等待任务完成
    for i in range(30):
        await asyncio.sleep(2)
        report = get_report(task_id)
        if report and report.finished_at:
            print("report done:", report.overall)
            for e in report.entries:
                print(e.left_field, e.match, e.reasoning[:50])
            return
        t = store.tasks.get(task_id)
        print(f"wait {i*2}s, steps={len(t.steps) if t else '?'}")
    print("timeout")

asyncio.run(main())
