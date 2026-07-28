"""上传与数据源路由。"""
from __future__ import annotations

import os
import uuid
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from ..config import settings
from ..models import ApplicantRecord, PassportData
from ..services.excel_parser import parse_bytes
from ..services.passport_ocr import extract_passport
from ..services.task_manager import clear_right_records, list_records, list_right_records, upsert_passport, upsert_records, upsert_right_records

router = APIRouter(prefix="/api", tags=["upload"])


@router.post("/upload/excel")
async def upload_excel(file: UploadFile = File(...)):
    """上传 Excel/CSV，解析成 records（左侧数据源）。"""
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")
    try:
        records = await parse_bytes(content, file.filename or "upload.xlsx")
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    except Exception as e:
        raise HTTPException(400, f"解析失败: {e}")

    upsert_records(records)
    return {
        "count": len(records),
        "records": [r.model_dump() for r in records],
    }


@router.post("/upload/excel-right")
async def upload_excel_right(file: UploadFile = File(...)):
    """上传右侧参考 Excel/CSV，解析成 right_records（不覆盖左侧数据源）。"""
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")
    try:
        records = await parse_bytes(content, file.filename or "upload.xlsx")
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    except Exception as e:
        raise HTTPException(400, f"解析失败: {e}")

    upsert_right_records(records)
    return {
        "count": len(records),
        "records": [r.model_dump() for r in records],
    }


@router.post("/upload/passport/{record_id}")
async def upload_passport(record_id: str, file: UploadFile = File(...)):
    """为指定 record 上传一张护照图片，触发 Vision LLM 抽取。"""
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")

    os.makedirs(settings.upload_dir, exist_ok=True)
    ext = os.path.splitext(file.filename or ".jpg")[1] or ".jpg"
    save_name = f"{record_id}_{uuid.uuid4().hex[:8]}{ext}"
    save_path = os.path.join(settings.upload_dir, save_name)
    with open(save_path, "wb") as f:
        f.write(content)

    p: PassportData = await extract_passport(save_path, record_id, file.filename or save_name)
    upsert_passport(record_id, p)
    return p.model_dump()


@router.get("/records")
def get_records():
    """列出当前所有记录（含已上传护照数据）。"""
    from ..services.task_manager import get_passport
    out = []
    for r in list_records():
        d = r.model_dump()
        p = get_passport(r.record_id)
        d["has_passport"] = p is not None
        d["passport_fields"] = p.fields if p else {}
        out.append(d)
    return {"records": out}


@router.get("/records-right")
def get_right_records():
    """列出右侧参考Excel的所有记录。"""
    return {"records": [r.model_dump() for r in list_right_records()]}


@router.delete("/records-right")
def clear_right_records_endpoint():
    """清空右侧参考Excel数据。"""
    clear_right_records()
    return {"ok": True}


@router.delete("/records")
def clear_records():
    """清空所有数据（演示用）。"""
    from ..services.task_manager import store
    store.records.clear()
    store.passports.clear()
    return {"ok": True}


class AvatarUpdate(BaseModel):
    """更新头像请求体。"""
    avatar: str  # base64 字符串（无 data: 前缀）或图片 URL


@router.patch("/records/{record_id}/avatar")
def update_avatar(record_id: str, body: AvatarUpdate):
    """更新指定记录的头像。

    avatar 可以是：
    - base64 字符串（无 data:image/... 前缀）
    - http(s) URL（后端会下载转 base64）
    """
    from ..services.task_manager import store
    rec = store.records.get(record_id)
    if not rec:
        raise HTTPException(404, f"record {record_id} not found")

    avatar_data = body.avatar.strip()
    if not avatar_data:
        raise HTTPException(400, "avatar is empty")

    # 如果是 URL，下载转 base64
    if avatar_data.startswith(("http://", "https://")):
        import base64
        import httpx
        try:
            resp = httpx.get(avatar_data, timeout=15.0, follow_redirects=True)
            resp.raise_for_status()
            avatar_data = base64.b64encode(resp.content).decode("utf-8")
        except Exception as e:
            raise HTTPException(400, f"下载头像失败: {e}")

    # 如果带 data:image/... 前缀，去掉
    if avatar_data.startswith("data:"):
        avatar_data = avatar_data.split(",", 1)[-1]

    rec.avatar = avatar_data
    return {"ok": True, "record_id": record_id, "avatar": avatar_data[:80] + "..."}
