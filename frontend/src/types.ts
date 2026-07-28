// 与后端 models 对齐的 TS 类型

export type FieldMatch = "match" | "mismatch" | "missing" | "partial" | "unknown" | "error";
export type Overall = "pass" | "fail" | "review";

export interface ApplicantRecord {
  record_id: string;
  source: "excel" | "database" | "manual";
  fields: Record<string, string>;
  university_url?: string | null;
  university_name?: string | null;
  avatar?: string | null;  // base64 字符串（无 data: 前缀）
  has_passport?: boolean;
  passport_fields?: Record<string, string>;
}

export interface VerificationStep {
  step: number;
  action: string;
  description: string;
  success: boolean;
  detail?: string | null;
  timestamp: string;
  /** 是否是人物卡片分隔标记（每个record开始时的步骤） */
  isRecordStart?: boolean;
  /** 人物卡片名称 */
  recordName?: string;
  /** 当前是第几张卡片（1-based） */
  recordIndex?: number;
  /** 总卡片数 */
  recordTotal?: number;
  /** 是否是任务分隔标记（每个队列任务开始时的步骤，比recordStart更高层级） */
  isTaskStart?: boolean;
  /** 任务名称 */
  taskName?: string;
  /** 当前是第几个任务（1-based） */
  taskIndex?: number;
  /** 总任务数 */
  taskTotal?: number;
  /** 该任务的卡片总数 */
  taskRecordCount?: number;
}

export type BoxMatchStatus =
  | "match"
  | "mismatch"
  | "missing"
  | "partial"
  | "unknown"
  | "pending";

export interface InputBox {
  selector: string;
  label?: string | null;
  value?: string | null;
  field?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  match_status: BoxMatchStatus;
}

export interface ScreenshotEvent {
  step: number;
  screenshot: string;          // base64（无 data:image/... 前缀）
  url?: string | null;
  title?: string | null;
  action_hint?: string | null;
  boxes?: InputBox[];            // 叠加高亮框
  viewport_width?: number | null;
  viewport_height?: number | null;
  timestamp: string;
}

export type EvidenceSource = "passport" | "excel" | "web" | "manual" | "none";

export interface FieldComparison {
  field: string;
  excel_value: string;
  passport_value: string;
  website_value: string;
  match: FieldMatch;
  note?: string | null;
  // 证据来源扩展
  website_label?: string | null;     // 右侧页面原始 label，如 "Full Name"
  selector_hint?: string | null;     // 右侧页面 selector，如 "#full-name"
  evidence_source?: EvidenceSource;  // 左侧证据来源：passport > excel > none
}

export interface VerificationResult {
  task_id: string;
  record_id: string;
  university_url: string;
  steps: VerificationStep[];
  comparisons: FieldComparison[];
  overall: Overall;
  started_at: string;
  finished_at?: string | null;
  error?: string | null;
}

export interface AppConfig {
  agent_backend: string;
  vision_configured: boolean;
  browser_use_configured: boolean;
  // 完整设置（新增）
  settings: AppSettings;
}

export interface AppSettings {
  // Vision API（用于护照 OCR / 视觉比对）
  vision_api_base: string;
  vision_api_key: string;
  vision_model: string;
  vision_supports_images?: boolean | null;

  // Browser Use LLM（用于控制浏览器）
  browser_use_llm_base: string;
  browser_use_llm_key: string;
  browser_use_llm_model: string;

  // Agent 后端
  agent_backend: string;

  // 防误关：开启后点关闭按钮会最小化到系统托盘，而非真正退出
  prevent_accidental_close?: boolean;
}

// ========== 可配置工作流（新） ==========

export type WorkflowAction = "click" | "type" | "select" | "wait" | "screenshot" | "extract" | "manual";
export type VerifyMethod = "smart" | "exact";
export type LeftSource = "excel" | "database" | "passport" | "manual";

export interface WorkflowStep {
  action: WorkflowAction;
  selector?: string | null;
  value?: string | null;
  value_from?: string | null;
  wait_seconds?: number | null;
  description?: string | null;
  use_vision?: boolean;
}

export interface FieldMapping {
  mapping_id?: string | null;
  right_selector: string;
  right_label?: string | null;
  right_input_type?: string | null;
  left_source: LeftSource;
  left_field: string;
  left_record_key?: string | null;
  verify_method?: VerifyMethod;
  note?: string | null;
}

/** 已拾取的元素标记（用于在 UI 上显示顺序编号 1, 2, 3...） */
export interface PickedMark {
  id: string;
  /** 顺序编号，从 1 开始 */
  order: number;
  /** 拾取的位置：左侧数据源 / 右侧学校系统 */
  side: "left" | "right";
  /** 来源：网页元素 / Excel 单元格 / 头像 */
  source: "web" | "excel" | "avatar";
  /** CSS selector（网页）或字段名（Excel） */
  selector: string;
  /** 显示标签 */
  label: string;
  /** 原始值 */
  value?: string;
  /** Excel 定位用：字段名 + 记录 ID */
  excelField?: string;
  excelRecordId?: string;
  /** 所属操作流程：数据源操作 / 审查流操作 / 录入流操作 */
  workflow: "data-source" | "review" | "entry";
  /** 创建时间戳 */
  createdAt: number;
  /** 关联的申请人记录 ID */
  recordId?: string;
  /** 元素的 rect（网页元素才有） */
  rect?: { x: number; y: number; width: number; height: number };
  /** 元素的 tag/name（网页元素才有） */
  tag?: string;
  type?: string;
  /** 动作类型：拾取（默认）/ 输入（把值填入目标框）/ 点击（真正触发元素点击） */
  action?: "pick" | "input" | "click";
  /** 输入动作的目标 selector（仅 action=input 时有效） */
  inputTarget?: string;
  /** 输入动作的目标标签（仅 action=input 时有效） */
  inputTargetLabel?: string;
  /** 变量标记：input 动作的 value 如果等于当前卡片的某个字段值，则记录字段名，批量执行时自动替换 */
  variableField?: string;
  /** 输入值来源：左网页元素的 selector（source=web 时使用，运行时从左网页读取值） */
  sourceSelector?: string;
  /** 文件提取步骤标记：点击网页上的图片/PDF 链接后，下载并 OCR 提取文字 */
  docExtract?: boolean;
  /** 文件提取目标的 URL（图片/PDF 链接） */
  docUrl?: string;
}

/** 教学模式状态：人类教 AI 自动化流程的阶段 */
export type TeachingPhase = "idle" | "data-source" | "review" | "entry" | "done";

/** 应用模式：LOOP（教学批量循环）/ 审查（单次核验）/ 录入（批量填表） */
export type AppMode = "loop" | "review" | "entry";

/** 批量执行中每张卡片的执行状态 */
export type BatchStatus = "pending" | "running" | "success" | "failed" | "skipped";

/** 批量执行结果记录 */
export interface BatchResult {
  recordId: string;
  status: BatchStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** 该卡片执行过程中失败的步骤编号 */
  failedOrder?: number;
}

/** 流程模板：从教学记录保存而来，用于批量执行 */
export interface WorkflowTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 图标（emoji 字符） */
  icon?: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt?: number;
  /** 来源记录 ID（教 AI 时用的那张卡片） */
  sourceRecordId?: string;
  /** 应用模式：审查流 / 录入流 */
  mode: AppMode;
  /** 数据源处理阶段的节点 */
  dataSourceMarks: PickedMark[];
  /** 审查流操作阶段的节点 */
  reviewMarks: PickedMark[];
  /** 录入流操作阶段的节点 */
  entryMarks: PickedMark[];
  /** 是否包含搜索步骤（自动检测，审查流用） */
  hasSearchSteps: boolean;
  /** 是否包含提交步骤（自动检测，录入流用：点保存/提交按钮） */
  hasSubmitStep: boolean;
}

/** 任务队列项：一次完整配置的批量执行快照 */
export interface QueuedTask {
  /** 队列项 ID */
  id: string;
  /** 用户可编辑的任务名称 */
  name: string;
  /** 添加时间戳 */
  createdAt: number;
  /** 应用模式 */
  mode: AppMode;
  /** 该任务的卡片数据（拍快照时从cardRecords复制） */
  cardRecords: ApplicantRecord[];
  /** 该任务的操作步骤配置 */
  workflowTemplate: WorkflowTemplate;
  /** 左侧网页 URL */
  leftUrl: string;
  /** 右侧网页 URL */
  rightUrl: string;
  /** 执行状态 */
  status: "pending" | "running" | "success" | "failed" | "stopped";
  /** 执行失败原因 */
  error?: string;
  /** 执行完成时的成功/失败统计 */
  successCount?: number;
  failCount?: number;
}

export interface WorkflowConfig {
  record_id?: string;
  university_url: string;
  workflow: WorkflowStep[];
  mappings: FieldMapping[];
  use_vision_verify?: boolean;
  // 无 Excel/护照记录时，直接传入左侧期望值（如左右网页比对）
  expected_fields?: Record<string, string>;
}

export interface VerificationReportEntry {
  mapping_id?: string | null;
  right_selector: string;
  right_label?: string | null;
  left_source: string;
  left_field: string;
  right_value: string;
  left_value: string;
  match: FieldMatch;
  reasoning?: string | null;
  screenshot?: string | null;
  timestamp: string;
}

export interface VerificationReport {
  task_id: string;
  record_id: string;
  record_name?: string | null;
  university_url: string;
  entries: VerificationReportEntry[];
  overall: Overall;
  summary?: string | null;
  started_at: string;
  finished_at?: string | null;
  error?: string | null;
}

// ========== 文档提取（功能1/2） ==========

/** 文档提取结果：MarkItDown（PDF/Office）或 Vision OCR（图片） */
export interface DocumentExtractResult {
  filename: string;
  /** 提取方式 */
  method: "markitdown" | "vision_ocr";
  /** 提取出的全文 */
  text: string;
  /** 结构化字段（请求了 fields 时返回） */
  fields: Record<string, string>;
}

/** 文档对比条目：左侧记录值 vs 文档提取值 */
export interface DocCompareEntry {
  field: string;
  label: string;
  left_value: string;
  right_value: string;
  match: FieldMatch;
}

/** 文档提取 + 对比状态（App 层） */
export interface DocExtractState {
  filename: string;
  method: string;
  text: string;
  fields: Record<string, string>;
  entries: DocCompareEntry[];
  /** 数据来源描述：网页 URL / 本地文件 */
  source: string;
}

// 字段中文名映射，UI 用
export const FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  passport_no: "护照号",
  nationality: "国籍",
  birth_date: "出生日期",
  gender: "性别",
  passport_issue: "护照签发日",
  passport_expiry: "护照有效期",
  email: "邮箱",
  phone: "电话",
};

export const MATCH_LABELS: Record<FieldMatch, string> = {
  match: "一致",
  mismatch: "不一致",
  missing: "缺失",
  partial: "近似",
  unknown: "未知",
  error: "错误",
};

export const MATCH_STYLES: Record<FieldMatch, string> = {
  match: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  mismatch: "bg-rose-50 text-rose-700 ring-rose-200",
  missing: "bg-amber-50 text-amber-700 ring-amber-200",
  partial: "bg-sky-50 text-sky-700 ring-sky-200",
  unknown: "bg-slate-50 text-slate-600 ring-slate-200",
  error: "bg-red-50 text-red-700 ring-red-200",
};

export const OVERALL_LABELS: Record<Overall, string> = {
  pass: "通过",
  fail: "存在问题",
  review: "需人工复核",
};

export const OVERALL_STYLES: Record<Overall, string> = {
  pass: "bg-emerald-500",
  fail: "bg-rose-500",
  review: "bg-amber-500",
};

// 证据来源显示
export const EVIDENCE_LABELS: Record<EvidenceSource, string> = {
  passport: "护照 OCR",
  excel: "Excel",
  web: "左网页",
  manual: "手动",
  none: "无证据",
};

export const EVIDENCE_STYLES: Record<EvidenceSource, string> = {
  passport: "bg-violet-50 text-violet-700 ring-violet-200",
  excel: "bg-blue-50 text-blue-700 ring-blue-200",
  web: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  manual: "bg-slate-50 text-slate-600 ring-slate-200",
  none: "bg-rose-50 text-rose-600 ring-rose-200",
};

// 验证方式显示（兼容旧数据中的 vision / ocr / contains）
export const VERIFY_METHOD_LABELS: Record<string, string> = {
  smart: "智能匹配",
  exact: "精确匹配",
  vision: "智能匹配",
  ocr: "智能匹配",
  contains: "精确匹配",
};
