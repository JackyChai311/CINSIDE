# -*- coding: utf-8 -*-
"""前后端契约漂移回归测试。

## 为什么需要这组测试

93 个端点**没有任何 response_model**，请求/响应的形状只靠
`frontend/src/types.ts` 与 `backend/app/models.py` **两边手抄**维护，
因此已经发生了真实的漂移（见下）。这组测试把「前端实际会用到的值域」
固化下来，与后端 Pydantic 模型的 Literal 对齐，防止再次悄悄分叉。

## 已验证存在的漂移

| 值域 | 前端 types.ts | 后端 models.py（修复前） |
|---|---|---|
| `FieldMatch` | `match/mismatch/missing/partial/unknown/error` | `FieldComparison.match` 缺 `error` |
| `EvidenceSource` | `passport/excel/web/manual/none` | `FieldComparison.evidence_source` 缺 `web` |
| `left_source` | 前端会把 `evidence_source`（可为 `web`）写进该字段 | `FieldMapping.left_source` 缺 `web` → **422** |

第三条是**真实的潜在故障**：`frontend/src/App.tsx` 的
`left_source: c.evidence_source || "excel"`（两处）会把 `"web"` 送上来，
而 Pydantic 会直接拒绝整个请求体。

后端 `models.py` 内部也不一致：`VerificationReportEntry.match` 含 `error`，
而 `FieldComparison.match` 不含。

## 长期方案

真正可靠的做法是用 `openapi-typescript` 从后端 schema 生成前端类型，
取代手抄。但那需要先给端点补 `response_model`，是更大的改动；
在那之前，本文件作为「最低限度的一致性护栏」。
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models import FieldComparison, FieldMapping, InputBox, VerificationReportEntry, WorkflowStep

# ---------------------------------------------------------------------------
# 以下常量是 frontend/src/types.ts 里对应联合类型的**完整字面量集合**。
# 修改前端类型时请同步这里 —— 或者更好：推动改用生成式类型后删除本文件。
# ---------------------------------------------------------------------------
FRONTEND_FIELD_MATCH = {"match", "mismatch", "missing", "partial", "unknown", "error"}
FRONTEND_EVIDENCE_SOURCE = {"passport", "excel", "web", "manual", "none"}
FRONTEND_LEFT_SOURCE = {"excel", "database", "passport", "manual"}
FRONTEND_BOX_MATCH_STATUS = {"match", "mismatch", "missing", "partial", "unknown", "pending"}
FRONTEND_OVERALL = {"pass", "fail", "review"}
FRONTEND_WORKFLOW_ACTION = {"click", "type", "select", "wait", "screenshot", "extract", "manual"}
FRONTEND_VERIFY_METHOD = {"smart", "exact"}


def _literal_values(model_field) -> set[str]:
    """取 Pydantic 字段 Literal 的允许值集合。"""
    import typing

    anno = model_field.annotation
    if hasattr(anno, "__args__"):
        return {a for a in anno.__args__ if isinstance(a, str)}
    return set()


def _allowed(model, field: str) -> set[str]:
    return _literal_values(model.model_fields[field])


# ============ 值域对齐：前端用到的每个值，后端都必须接受 ============


def test_field_comparison_match_accepts_all_frontend_values():
    allowed = _allowed(FieldComparison, "match")
    missing = FRONTEND_FIELD_MATCH - allowed
    assert not missing, f"FieldComparison.match 不接受前端会用到的值: {sorted(missing)} (后端允许 {sorted(allowed)})"


def test_field_comparison_evidence_source_accepts_all_frontend_values():
    allowed = _allowed(FieldComparison, "evidence_source")
    missing = FRONTEND_EVIDENCE_SOURCE - allowed
    assert not missing, (
        f"FieldComparison.evidence_source 不接受前端会用到的值: {sorted(missing)} (后端允许 {sorted(allowed)})"
    )


def test_field_mapping_left_source_accepts_all_frontend_values():
    allowed = _allowed(FieldMapping, "left_source")
    missing = FRONTEND_LEFT_SOURCE - allowed
    assert not missing, f"FieldMapping.left_source 不接受前端会用到的值: {sorted(missing)} (后端允许 {sorted(allowed)})"


def test_box_match_status_accepts_all_frontend_values():
    allowed = _allowed(InputBox, "match_status")
    missing = FRONTEND_BOX_MATCH_STATUS - allowed
    assert not missing, f"InputBox.match_status 不接受前端会用到的值: {sorted(missing)}"


def test_verify_method_accepts_all_frontend_values():
    allowed = _allowed(FieldMapping, "verify_method")
    missing = FRONTEND_VERIFY_METHOD - allowed
    assert not missing, f"FieldMapping.verify_method 不接受前端会用到的值: {sorted(missing)}"


def test_workflow_step_action_accepts_all_frontend_values():
    allowed = _allowed(WorkflowStep, "action")
    missing = FRONTEND_WORKFLOW_ACTION - allowed
    assert not missing, f"WorkflowStep.action 不接受前端会用到的值: {sorted(missing)}"


def test_backend_match_literals_are_internally_consistent():
    """同一语义的 match 在 models.py 里出现了两次，值域必须一致。"""
    a = _allowed(FieldComparison, "match")
    b = _allowed(VerificationReportEntry, "match")
    assert a == b, f"FieldComparison.match={sorted(a)} 与 VerificationReportEntry.match={sorted(b)} 不一致"


# ============ 具体的潜在 422：前端会把 evidence_source 当 left_source 送上来 ============


@pytest.mark.parametrize("left_source", ["excel", "database", "passport", "manual", "web"])
def test_field_mapping_accepts_left_source_values_frontend_actually_sends(left_source):
    """frontend/src/App.tsx 的 `left_source: c.evidence_source || "excel"` 会送来 `web`。

    这曾导致 Pydantic 直接拒绝整个请求体（422）。此用例就是该回归的护栏。
    """
    m = FieldMapping(right_selector="#name", left_field="name", left_source=left_source)
    assert m.left_source == left_source


def test_evidence_source_web_round_trips():
    """前端 types.ts 的 EvidenceSource 含 "web"，后端必须能构造与回读。"""
    fc = FieldComparison(field="name", evidence_source="web")
    assert fc.evidence_source == "web"
    assert fc.model_dump()["evidence_source"] == "web"


def test_match_error_round_trips():
    """前端 types.ts 的 FieldMatch 含 "error"，后端必须能构造与回读。"""
    fc = FieldComparison(field="passport_no", match="error")
    assert fc.match == "error"


# ============ 反向护栏：确实非法的值仍应被拒 ============


def test_truly_invalid_left_source_is_still_rejected():
    """放宽值域不等于不校验 —— 完全没出现过的值仍必须被拒。"""
    with pytest.raises(ValidationError):
        FieldMapping(right_selector="#x", left_field="name", left_source="totally-made-up")


def test_truly_invalid_match_is_still_rejected():
    with pytest.raises(ValidationError):
        FieldComparison(field="x", match="totally-made-up")
