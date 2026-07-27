"""共享数据模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# === 字段定义 ===
# 我们关心的核心字段（申请表常见字段）
VERIFY_FIELDS = [
    "name",           # 姓名（拼音/英文，与护照一致）
    "passport_no",    # 护照号
    "nationality",    # 国籍
    "birth_date",     # 出生日期 YYYY-MM-DD
    "gender",         # 性别
    "passport_issue", # 护照签发日期
    "passport_expiry",# 护照有效期
    "email",          # 邮箱
    "phone",          # 电话
]


class ApplicantRecord(BaseModel):
    """一条申请人记录（来自 Excel / 数据库）。"""
    record_id: str
    source: Literal["excel", "database", "manual"] = "excel"
    fields: dict[str, str] = Field(default_factory=dict)
    # 该记录关联的大学申请页 URL（可选；为空时使用 mock 站点）
    university_url: Optional[str] = None
    university_name: Optional[str] = None
    # 头像（base64 字符串，无 data: 前缀），从数据源网页提取
    avatar: Optional[str] = None


class PassportData(BaseModel):
    """护照 OCR 抽取结果。"""
    record_id: str
    image_name: str
    fields: dict[str, str] = Field(default_factory=dict)
    raw_response: Optional[str] = None


class WebsiteField(BaseModel):
    """从大学网站抓取到的单字段。"""
    name: str
    value: str
    selector_hint: Optional[str] = None  # 调试用：定位用的 selector/元素描述


class WebsiteInput(BaseModel):
    """右侧页面的一个输入框（带页面原始 label 和 selector）。

    用于"按页面框对比"视图：每个框标注它对应的标准字段、当前值、证据来源。
    """
    label: str                              # 页面上的原始 label，如 "Full Name"
    value: str                              # 当前填入的值
    selector_hint: Optional[str] = None     # CSS selector 或定位描述，如 "#full-name"
    input_type: Optional[str] = None        # text / email / date / select / ...
    matched_field: Optional[str] = None     # 映射到的标准字段 key（name/email/...），无法映射则 None
    # bbox（相对于浏览器视口，用于截图叠加高亮框）
    bbox_x: Optional[float] = None
    bbox_y: Optional[float] = None
    bbox_width: Optional[float] = None
    bbox_height: Optional[float] = None


class InputBox(BaseModel):
    """截图上叠加的高亮框（含比对状态着色）。"""
    selector: str                                            # CSS selector，如 "#name"
    label: Optional[str] = None                              # 页面 label，如 "Full Name"
    value: Optional[str] = None                              # 当前值
    field: Optional[str] = None                              # 对应的标准字段 key
    x: float
    y: float
    width: float
    height: float
    match_status: Literal["match", "mismatch", "missing", "partial", "unknown", "pending"] = "pending"


class VerificationStep(BaseModel):
    """Agent 执行的一步。"""
    step: int
    action: str   # navigate / snapshot / click / type / extract / login / ...
    description: str
    success: bool = True
    detail: Optional[str] = None
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class ScreenshotEvent(BaseModel):
    """Agent 执行过程中的浏览器截图帧，独立于 VerificationStep 推送。"""
    step: int                          # browser-use 内部 step 序号
    screenshot: str                    # base64 编码的 JPEG/PNG（去掉 data:image/... 前缀）
    url: Optional[str] = None          # 当前页面 URL
    title: Optional[str] = None        # 当前页面标题
    action_hint: Optional[str] = None  # AI 即将/正在执行的动作描述
    # 叠加高亮框（用于按页面框可视化对比）
    boxes: list[InputBox] = []
    viewport_width: Optional[int] = None   # 视口宽度（前端按比例缩放 box 坐标）
    viewport_height: Optional[int] = None  # 视口高度
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class FieldComparison(BaseModel):
    """单字段比对结果。"""
    field: str
    excel_value: str = ""
    passport_value: str = ""
    website_value: str = ""
    match: Literal["match", "mismatch", "missing", "partial", "unknown"] = "unknown"
    note: Optional[str] = None
    # === 证据来源扩展（按页面框对比） ===
    website_label: Optional[str] = None     # 右侧页面上该框的原始 label，如 "Full Name"
    selector_hint: Optional[str] = None     # 右侧页面元素的 selector，如 "#full-name"
    evidence_source: Literal["passport", "excel", "manual", "none"] = "none"
    # evidence_source 表示"用来对比该框的左侧证据来自哪个数据源"。
    # 优先级：passport（权威证件）> excel > manual。none 表示左侧没有该字段证据。


class VerificationResult(BaseModel):
    """一次完整核验结果。"""
    task_id: str
    record_id: str
    university_url: str
    steps: list[VerificationStep] = Field(default_factory=list)
    comparisons: list[FieldComparison] = Field(default_factory=list)
    overall: Literal["pass", "fail", "review"] = "review"
    started_at: str
    finished_at: Optional[str] = None
    error: Optional[str] = None


# ========== 可配置工作流（用户主导） ==========

class WorkflowStep(BaseModel):
    """用户配置的一个页面操作步骤。"""
    action: Literal["click", "type", "select", "wait", "screenshot", "extract", "manual"]
    selector: Optional[str] = None          # CSS selector / xpath / 文字定位
    value: Optional[str] = None             # 固定值（type/select 用）
    value_from: Optional[str] = None        # 从左侧数据取值，格式 "excel.student_id" / "db.passport_no"
    wait_seconds: Optional[float] = None    # wait 动作专用
    description: Optional[str] = None       # 人类可读说明
    use_vision: bool = False                # 此步骤是否要求截图（用于人眼确认）


class FieldMapping(BaseModel):
    """右侧输入框 ←→ 左侧数据源的绑定关系。"""
    mapping_id: Optional[str] = None
    # 右侧（学校网站）
    right_selector: str                     # CSS selector，如 "#passport"
    right_label: Optional[str] = None       # 页面 label，如 "Passport Number"
    right_input_type: Optional[str] = None  # text / image / date ...
    # 左侧（Excel / 数据库 / 护照 OCR）
    left_source: Literal["excel", "database", "passport", "manual"]
    left_field: str                         # 字段名，如 "passport_no"
    left_record_key: Optional[str] = None   # 数据库中定位同一学生的 key
    # 验证方式
    verify_method: Literal["smart", "exact", "contains", "vision", "ocr"] = "smart"
    # 人类备注
    note: Optional[str] = None


class VerificationReportEntry(BaseModel):
    """单个字段的验证结果（由 Vision API 或规则判定）。"""
    mapping_id: Optional[str] = None
    right_selector: str
    right_label: Optional[str] = None
    left_source: str
    left_field: str
    right_value: str                        # 右侧输入框提取到的值 / 图片 base64
    left_value: str                         # 左侧数据源的值
    match: Literal["match", "mismatch", "missing", "partial", "error", "unknown"] = "unknown"
    reasoning: Optional[str] = None         # Vision API 的判断理由
    screenshot: Optional[str] = None        # 验证时的截图（可选）
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class VerificationReport(BaseModel):
    """一次完整验证的报告，可导出为 Excel / 卡片。"""
    task_id: str
    record_id: str
    record_name: Optional[str] = None
    university_url: str
    entries: list[VerificationReportEntry] = Field(default_factory=list)
    overall: Literal["pass", "fail", "review"] = "review"
    summary: Optional[str] = None
    started_at: str
    finished_at: Optional[str] = None
    error: Optional[str] = None


class WorkflowConfig(BaseModel):
    """一次验证任务的完整配置（工作流 + 字段映射）。"""
    record_id: Optional[str] = None
    university_url: str
    workflow: list[WorkflowStep] = Field(default_factory=list)
    mappings: list[FieldMapping] = Field(default_factory=list)
    # 是否用 Vision API 做最终判断（默认开启）
    use_vision_verify: bool = True
    # 无 Excel/护照记录时，直接传入左侧期望值（如左右网页比对）
    expected_fields: Optional[dict[str, str]] = None
