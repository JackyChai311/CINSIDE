"""护照 OCR 服务：调用 Vision LLM 抽取结构化字段。

使用 OpenAI 兼容接口（base_url + api_key），可接：
  - 智谱 GLM-4V / GLM-4V-Plus    base=https://open.bigmodel.cn/api/paas/v4
  - 通义 Qwen-VL-Max              base=https://dashscope.aliyuncs.com/compatible-mode/v1
  - OpenAI GPT-4o                 base=https://api.openai.com/v1
  - 本地部署的 LLaVA / Qwen-VL 等

如果未配置 API key，自动回退到 mock 模式（生成假数据），保证演示可跑。
"""
from __future__ import annotations

import base64
import json
import re
from typing import Optional

from ..config import settings
from ..models import PassportData

# Vision LLM 抽取 prompt
_EXTRACT_PROMPT = """你是一个护照信息抽取助手。请仔细查看这张护照图片，抽取以下字段，并以 JSON 格式返回：
{
  "name": "姓名（拼音/英文，与护照一致，全大写）",
  "passport_no": "护照号码",
  "nationality": "国籍（中文或英文）",
  "birth_date": "出生日期，格式 YYYY-MM-DD",
  "gender": "性别（M/F 或 男/女）",
  "passport_issue": "护照签发日期，格式 YYYY-MM-DD",
  "passport_expiry": "护照有效期，格式 YYYY-MM-DD"
}

要求：
1. 严格按 JSON 输出，不要有任何额外文字
2. 看不清或无法识别的字段返回空字符串 ""
3. 日期统一转成 YYYY-MM-DD 格式
4. 姓名保留护照上的大小写形式（通常全大写）
5. 如果图片不是护照，所有字段返回空字符串
"""


def _b64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def _parse_llm_response(text: str) -> dict[str, str]:
    """从 LLM 文本响应中提取 JSON。"""
    if not text:
        return {}
    # 找 JSON 块
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
        return {k: str(v).strip() for k, v in data.items()}
    except Exception:
        return {}


async def extract_passport(image_path: str, record_id: str = "", image_name: str = "") -> PassportData:
    """对一张护照图片抽取字段。"""
    if not image_name:
        import os
        image_name = os.path.basename(image_path)

    # 无 API key → mock
    if not settings.vision_api_key:
        return _mock_extract(image_path, record_id, image_name)

    # 真实调用
    try:
        import httpx
    except ImportError as e:
        raise RuntimeError("缺少依赖 httpx，请执行: pip install httpx") from e

    b64_img = _b64(image_path)
    url = settings.vision_api_base.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings.vision_api_key}", "Content-Type": "application/json"}
    payload = {
        "model": settings.vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _EXTRACT_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}},
                ],
            }
        ],
        "temperature": 0.1,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            fields = _parse_llm_response(text)
            return PassportData(
                record_id=record_id,
                image_name=image_name,
                fields=fields,
                raw_response=text,
            )
    except Exception as e:
        return PassportData(
            record_id=record_id,
            image_name=image_name,
            fields={},
            raw_response=f"ERROR: {e}",
        )


# ========== Mock 模式 ==========
def _mock_extract(image_path: str, record_id: str, image_name: str) -> PassportData:
    """根据文件名 hash 生成假的护照数据，用于演示。"""
    h = abs(hash(image_name)) % 3
    samples = [
        {
            "name": "ZHANG SAN",
            "passport_no": "E12345678",
            "nationality": "CHINESE",
            "birth_date": "1995-03-15",
            "gender": "M",
            "passport_issue": "2020-06-10",
            "passport_expiry": "2030-06-09",
        },
        {
            "name": "LI SI",
            "passport_no": "G98765432",
            "nationality": "CHINESE",
            "birth_date": "1998-11-22",
            "gender": "F",
            "passport_issue": "2021-04-18",
            "passport_expiry": "2031-04-17",
        },
        {
            "name": "WANG WU",
            "passport_no": "PE2233445",
            "nationality": "CHINESE",
            "birth_date": "1992-07-08",
            "gender": "M",
            "passport_issue": "2019-09-30",
            "passport_expiry": "2029-09-29",
        },
    ]
    return PassportData(
        record_id=record_id,
        image_name=image_name,
        fields=samples[h % len(samples)],
        raw_response="[mock] 未配置 VISION_API_KEY，使用模拟数据",
    )
