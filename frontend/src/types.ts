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
  /** 人物记录ID（用于点击跳转到对应卡片） */
  recordId?: string;
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

// ========== 点击展开型控件（选项控件 / 日历控件） ==========

/** 选项控件的单个可选项 */
export interface WidgetOption {
  /** 选项显示文字 */
  text: string;
  /** 选项元素选择器（面板内定位用） */
  selector: string;
  /** 用户标注的别名：左侧值与选项文字不一致时用于匹配 */
  alias?: string;
}

/** 日历控件的可标注角色 */
export type CalendarRole =
  | "panel"      // 日历面板容器
  | "header"     // 年月整体显示（如 "2024年1月"）
  | "year"       // 单独的年显示
  | "month"      // 单独的月显示
  | "prevYear"   // 上一年
  | "nextYear"   // 下一年
  | "prevMonth"  // 上一月
  | "nextMonth"  // 下一月
  | "dayCell";   // 日格子（当前月）

/** 日历控件结构（自动识别 + 用户修正） */
export interface CalendarControls {
  /** 日历面板容器选择器 */
  panelSelector?: string;
  /** 年月整体显示元素（如 "2024年1月"） */
  headerSelector?: string;
  /** 单独的年显示元素（与 monthSelector 配合，替代 headerSelector） */
  yearSelector?: string;
  /** 单独的月显示元素 */
  monthSelector?: string;
  prevYearSelector?: string;
  nextYearSelector?: string;
  prevMonthSelector?: string;
  nextMonthSelector?: string;
  /** 日格子通用选择器（定位日历面板内所有日期格） */
  dayCellSelector?: string;
}

/** 点击展开型控件定义：点击触发框后展开选项面板/日历面板 */
export interface WidgetDef {
  id: string;
  kind: "option" | "calendar";
  /** 触发框选择器（点击后展开面板的元素） */
  triggerSelector: string;
  /** 触发框标签（显示用） */
  triggerLabel?: string;
  /** 展开面板容器选择器 */
  panelSelector?: string;
  /** 选项控件：可选项列表 */
  options?: WidgetOption[];
  /** 日历控件：结构角色 */
  calendar?: CalendarControls;
  createdAt: number;
}

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
  /** 点击展开型控件（存在时，录入/审查走控件脚本而非普通填值/读值） */
  widget?: WidgetDef | null;
}

/** 已拾取的元素标记（用于在 UI 上显示顺序编号 1, 2, 3...） */
export interface PickedMark {
  id: string;
  /** 顺序编号，从 1 开始 */
  order: number;
  /** 拾取的位置：左侧数据源 / 右侧学校系统 */
  side: "left" | "right";
  /** 来源：网页元素 / Excel 单元格 / 头像 */
  source: "web" | "excel" | "avatar" | "passport";
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
  /** 文件提取来源：web=网页点击提取，local=本地文件按文件名匹配，web-download=多步点击触发下载 */
  docSource?: "web" | "local" | "web-download";
  /** 本地文件提取时：用于匹配文件名的字段名（如 student_id） */
  docFileField?: string;
  /** 本地文件提取时：用户上传的文件列表（仅配置阶段使用，执行时按字段值匹配） */
  docLocalFiles?: Array<{ name: string; data?: string }>;
  /** 本地文件提取（目录模式）：根目录绝对路径 */
  docLocalRootPath?: string;
  /** 本地文件提取（目录模式）：路径模板（如 {student_id}/护照，执行时替换占位符+尝试多扩展名） */
  docLocalPattern?: string;
  /** 本地文件提取（目录模式）：样本文件的相对路径（配置参考，如 123456/护照.jpg） */
  docLocalSamplePath?: string;
  /** 文件提取序列中的导航点击步骤标记（配置阶段记录的多步点击） */
  docExtractClick?: boolean;
  /** 文件上传步骤标记：把文件槽位中的文件填入网页 file input（DataTransfer 方案） */
  docUpload?: boolean;
  /** 上传来源：绑定的文件提取步骤 mark id（执行时从该槽位取文件）；空=取最近一次提取的文件 */
  uploadSourceMarkId?: string;
  /** 上传前压缩到目标大小（KB），0/undefined=不压缩 */
  uploadCompressKb?: number;
  /** 上传前格式转换：original | jpg | png | pdf */
  uploadFormat?: string;
  /** 上传框 accept 属性（配置时记录，显示用） */
  uploadAccept?: string;
  /** 点击阶段：pre=前置点击（搜索/进入，步骤3），post=收尾点击（保存/返回，步骤5） */
  clickPhase?: "pre" | "post";
  /** 点击展开型控件（选项/日历）：录入时按左侧值自动选择/翻页点选 */
  widget?: WidgetDef | null;
  /** 弹窗内拾取的元素：执行时 JS/高亮路由到弹窗 BrowserView 而非主 view */
  inPopup?: boolean;
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
  /** 图标（emoji 字符，默认 🔍） */
  icon?: string;
  /** 自定义图标图片（base64 dataURL）：存在时优先显示该图片，左侧渐隐融入卡片背景 */
  iconImage?: string;
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
  student_id?: string | null;
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
  method: "markitdown" | "vision_ocr" | "pdf_ocr";
  /** 提取出的全文 */
  text: string;
  /** 结构化字段（请求了 fields 时返回） */
  fields: Record<string, string>;
  /** 预处理后的图片预览（base64，仅图片文件有值）— 自动旋转到正面 + 裁剪白边后 */
  processed_image?: string | null;
}

/** 文档预览结果（仅预览图/文本预览，不跑 OCR） */
export interface DocumentPreviewResult {
  filename: string;
  method: "image" | "pdf_render" | "markitdown_text" | "unknown";
  /** JPEG 预览图（base64） */
  processed_image?: string | null;
  /** 文本类文件的前 2000 字符预览 */
  text_preview?: string | null;
}

/** 文件格式转换 + 压缩结果（文件处理面板「导出」） */
export interface DocumentConvertResult {
  /** 转换后文件内容（base64，无 data: 前缀） */
  data_b64: string;
  mime: string;
  ext: string;
  /** 输出字节数 */
  size: number;
  width: number;
  height: number;
  /** 是否压到目标大小以内 */
  reached: boolean;
  note: string;
  pages: number;
  warnings: string[];
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
  /** 原始文件 URL（图片/PDF 的下载地址，用于在文件处理面板预览） */
  file_url?: string;
  /** 预处理后的图片预览（base64）— 自动旋转到正面 + 裁剪白边后 */
  processed_image?: string | null;
}

// ============ 外挂插件（体外循环） ============

/** 外部 Chrome 标签页（提取源或操作页） */
export interface PluginTabInfo {
  id: string;
  title: string;
  url: string;
}

/** 插件运行状态（GET /api/plugin/status） */
export interface PluginStatus {
  running: boolean;
  cdp_url: string;
  sources: PluginTabInfo[];
  target: PluginTabInfo | null;
  interval: number;
  records_count: number;
  last_error: string | null;
  llm_configured: boolean;
  current_action: string;
}

/** 一条外挂循环记录 */
export interface PluginRecord {
  id: string;
  time: string;
  source: { title: string; url: string };
  fields: Record<string, string>;
  filled: Record<string, string>;
  missing: string[];
  status: "success" | "partial" | "failed";
  log: string[];
  error: string | null;
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
