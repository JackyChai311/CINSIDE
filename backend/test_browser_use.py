"""直接跑 BrowserUseAgent 对 mock-university 页面核验，验证 browser-use 0.13.6 新 API。"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# 让脚本能 import app 包
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 切到 browser_use 后端（仅本次测试，不动 .env）
import os
os.environ["AGENT_BACKEND"] = "browser_use"

from app.agents import BrowserUseAgent
from app.config import settings

print("=" * 60)
print(f"agent_backend = {settings.agent_backend}")
print(f"llm_base      = {settings.browser_use_llm_base}")
print(f"llm_model     = {settings.browser_use_llm_model}")
print(f"executable    = {settings.browser_use_executable}")
print(f"headless      = {settings.browser_use_headless}")
print(f"vision        = {settings.browser_use_vision}")
print(f"max_steps     = {settings.browser_use_max_steps}")
print("=" * 60)

# 期望字段（与 samples/sample_applicants.csv 第一行一致：ZHANG SAN）
expected = {
    "name": "ZHANG SAN",
    "passport_no": "E12345678",
    "nationality": "CHINESE",
    "birth_date": "1995-03-15",
    "gender": "M",
    "email": "zhang.san@example.com",
    "phone": "+86-13800138000",
}

# mock 大学页面挂在前端 http://localhost:5173/mock 或后端 http://localhost:8000/mock
# 这里用后端地址（更稳）
URL = "http://localhost:8000/mock/"


async def main():
    agent = BrowserUseAgent()
    print(f"\n>>> 开始核验 {URL}\n")
    async for step in agent.verify(
        record_id="test-001",
        university_url=URL,
        expected_fields=expected,
    ):
        flag = "OK " if step.success else "ERR"
        line = f"[{flag}] step {step.step:>2} {step.action:<10} {step.description}"
        if step.detail:
            line += f"\n        detail: {step.detail}"
        print(line)

    print("\n>>> 抽取到的字段：")
    for f in agent.extracted_fields:
        print(f"   {f.name:<15} = {f.value!r}")


if __name__ == "__main__":
    asyncio.run(main())
