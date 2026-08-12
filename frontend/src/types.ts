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

/** LOOP 运行期逐对填入卡片的字段行：compare=审查比对（左提取值 vs 右网页值），fill=录入填入 */
export interface LivePair {
  label: string;
  leftValue: string;
  rightValue: string;
  status: "pending" | "match" | "mismatch" | "missing";
  kind: "compare" | "fill";
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

  // SenseNova U1 Fast 生图（PPT 配图）
  sensenova_api_key?: string;

  // 文档/护照 OCR 引擎：vision=识图AI（Vision LLM），umi=本地 UMI-OCR
  ocr_engine?: string;
  umi_ocr_host?: string;
  umi_ocr_port?: number;

  // Agent 后端
  agent_backend: string;

  // 防误关：开启后点关闭按钮会最小化到系统托盘，而非真正退出
  prevent_accidental_close?: boolean;

  // 整体UI缩放比例（0.6~1.6）
  ui_scale?: number;

  // 新手模式：开启时显示步骤仪表引导，关闭时直接用字段对比面板且三面板常开
  beginner_mode?: boolean;

  // 主题：light=浅色 / dark=深色
  theme?: string;
  // 主色调：indigo / sky / emerald / rose / violet / amber
  accent?: string;

  // BrowserPane 网页亮度（0.3~2.0，1.0=原始）
  browser_brightness?: number;
}

// ========== 依赖与工具状态 ==========

export interface PythonDepStatus {
  key: string;
  name: string;
  pip_name: string;
  installed: boolean;
}

export interface UmiOcrStatus {
  installed: boolean;
  path: string;
  location: "configured" | "tools" | "system" | "not_found";
  service_online: boolean;
}

export interface RemotionStatus {
  installed: boolean;
  path: string;
  version: string;
}

export interface OfficecliStatus {
  installed: boolean;
  path: string;
  version: string;
}

export interface DepsStatus {
  python_deps: PythonDepStatus[];
  python_all_installed: boolean;
  umi_ocr: UmiOcrStatus;
  remotion: RemotionStatus;
  officecli: OfficecliStatus;
  tools_dir: string;
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

/** 页面元素相对其所在日历面板左上角的投影坐标（px） */
export interface CalendarRoleRect {
  /** 相对面板左边缘的 x */
  dx: number;
  /** 相对面板上边缘的 y */
  dy: number;
}

/** 日历控件结构（引导式手动拾取：用户在网页日历上依次点选各按钮位置，AI 据此点击） */
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
  /** 日格子通用选择器（拾取一个种子格子后，用公共选择器收集面板内所有日格子） */
  dayCellSelector?: string;
  // ---- 投影（坐标）辅助：选择器失效时按面板当前位置对准点击 ----
  headerRect?: CalendarRoleRect;
  yearRect?: CalendarRoleRect;
  monthRect?: CalendarRoleRect;
  prevYearRect?: CalendarRoleRect;
  nextYearRect?: CalendarRoleRect;
  prevMonthRect?: CalendarRoleRect;
  nextMonthRect?: CalendarRoleRect;
  /** 日格子投影：面板内每个日格中心坐标 + 抽取时的文本（执行时按坐标对准点击） */
  dayCells?: { text: string; dx: number; dy: number }[];
}

/** 点击展开型控件定义：点击触发框后展开选项面板/日历面板 */
export interface WidgetDef {
  id: string;
  kind: "option" | "calendar";
  /** 控件所在的浏览器面板侧（默认 right，兼容旧数据） */
  side?: "left" | "right";
  /** 是否是直接显示型（不需要点击触发，选项直接在页面上可见，如男/女单选按钮组） */
  inline?: boolean;
  /** 触发框选择器（点击后展开面板的元素；inline 模式下这是选项组容器） */
  triggerSelector: string;
  /** 触发框标签（显示用） */
  triggerLabel?: string;
  /** 触发框坐标（点击时的绝对坐标，用于坐标兜底点击） */
  triggerRect?: { x: number; y: number; width: number; height: number };
  /** 展开面板容器选择器（inline 模式下不需要） */
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
  /** 网页侧来源：目标元素所在的浏览器面板侧（默认 right，兼容旧数据）；
   *  右侧放 Excel 作数据源时，学校系统网页在左侧，此值为 "left" */
  web_side?: "left" | "right";
  /** 点击展开型控件（存在时，录入/审查走控件脚本而非普通填值/读值） */
  widget?: WidgetDef | null;
}

/** 提取元素面板条目：自定义文本 / 文件提取送来的字段，可关联网页元素用于审查/录入 */
export interface CustomTextEntry {
  id: string;
  /** 框框名字（仅显示，方便理解功能，不参与数据对比/录入） */
  name: string;
  /** 实际内容值（参与审查对比/录入填入） */
  text: string;
  selector?: string;
  label?: string;
  side?: "left" | "right";
  tag?: string;
  type?: string;
  /** 是否已保存为映射步骤 */
  saved?: boolean;
  /** 来源：doc=文件提取送来的字段，manual=手动添加（旧数据无此字段按 manual 处理） */
  source?: "doc" | "manual";
  /** 创建时间戳：提取元素面板内按设置先后排序编号（FIFO） */
  createdAt?: number;
  /** 本条目的工作流：review=审查对比，entry=录入填入；未设置时跟随全局 currentLoopStepType */
  workflow?: "review" | "entry";
  /** 绑定的 Excel 列名：设置后保存步骤时转为 variableField，LOOP 运行时按当前卡片行的该列取值 */
  excelField?: string;
  /** 文件提取字段 key（source="doc" 时可用，如 passport_no）：LOOP 运行时按此 key 取 OCR 提取值，与 excelField 绑定列对比 */
  docField?: string;
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
  /** 文件提取点击阶段：pre=开头导航点击（下载前），mid=过程点击（提取后中间步骤），post=收尾点击（所有人提取完成后），undefined=默认(pre) */
  docExtractClickPhase?: "pre" | "mid" | "post";
  /** 面板动作标记：点击的是前端面板按钮（非网页元素），执行时直接调用对应前端逻辑而非网页点击 */
  panelAction?: "doc-web-extract";
  /** 文件处理按钮操作记录：extract=送字段到提取元素面板，export=导出文件，upload=绑定上传；仅作步骤记录/流程图展示，执行时 no-op */
  fileOp?: "extract" | "export" | "upload";
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
  /** 点击阶段：pre=前置点击（搜索/进入，步骤3），mid=过程点击（点击NEXT等中间步骤），post=收尾点击（保存/返回，步骤5） */
  clickPhase?: "pre" | "mid" | "post";
  /** 点击展开型控件（选项/日历）：录入时按左侧值自动选择/翻页点选 */
  widget?: WidgetDef | null;
  /** 弹窗内拾取的元素：执行时 JS/高亮路由到弹窗 BrowserView 而非主 view */
  inPopup?: boolean;
  /** 断点类型：always=强制断点（每次到此暂停等人操作），on-error=条件断点（AI检测到错误时暂停） */
  breakpoint?: "always" | "on-error";
}

/** 教学模式状态：人类教 AI 自动化流程的阶段 */
export type TeachingPhase = "idle" | "data-source" | "review" | "entry" | "done";

/** 应用模式：LOOP（教学批量循环）/ 审查（单次核验）/ 录入（批量填表） */
export type AppMode = "loop" | "review" | "entry";

/** 批量执行中每张卡片的执行状态（review=部分字段不一致，需复核） */
export type BatchStatus = "pending" | "running" | "success" | "review" | "failed" | "skipped";

// ========== LOOP 流程图编辑器（v0.4.5+） ==========

/** 流程图节点类型 */
export type FlowNodeKind =
  | "step"        // 普通步骤：一个 PickedMark（点击/输入/提取/等待）
  | "subloop"     // 子LOOP：内嵌另一个 WorkflowTemplate，执行时完整跑完子LOOP
  | "ifelse"      // IF/ELSE 二分支：根据 condition 选择其中一个分支执行
  | "case"        // CASE 多分支：根据 switchValue 匹配 caseValue 选择分支
  | "comment"     // 注释节点：纯文本注释，不参与执行
  | "loopback";   // 回环节点：显式标记回到 LOOP 起点（大 Loop 闭环点）

/** 一个分支（ifelse 有两个分支；case 有多个分支） */
export interface FlowBranch {
  /** 分支 ID */
  id: string;
  /** 分支标签：ifelse 的"是/否"，case 的 case 值文本 */
  label: string;
  /** 条件表达式（留空表示默认/else分支；未来AI可填JS表达式或规则） */
  condition?: string;
  /** 该分支内部的节点序列 */
  nodes: FlowNode[];
}

/** 流程图中的一个节点 */
export interface FlowNode {
  /** 节点唯一 ID（uuid） */
  id: string;
  /** 节点类型 */
  kind: FlowNodeKind;
  /** 节点显示标题（可手动编辑，默认自动生成） */
  label?: string;
  /** 节点备注/描述 */
  note?: string;
  /** 高亮颜色（无则用默认颜色） */
  color?: string;
  /** 折叠状态（分支节点有效）：true = 折叠不显示内部节点 */
  collapsed?: boolean;
  /** 断点类型：always=强制断点，on-error=条件断点（AI出错时暂停） */
  breakpoint?: "always" | "on-error";
  /** 跨泳道宽卡片：文件处理类步骤（文件提取/上传/面板操作）在流程图中居中横跨左右泳道 */
  wide?: boolean;

  // --- step 类型专用：引用原模板中的 PickedMark ---
  /** 引用阶段: data=数据源, review=审查, entry=录入 */
  markPhase?: "data-source" | "review" | "entry";
  /** 引用的 PickedMark id */
  markId?: string;
  /** 该步骤操作的浏览器侧：left=左网页，right=右网页；用于流程图泳道定位 */
  markSide?: "left" | "right";

  // --- subloop 类型专用：子模板 ---
  /** 子LOOP 模板 ID（引用其他已保存的 WorkflowTemplate） */
  subloopTemplateId?: string;
  /** 子LOOP 执行次数（>1 时重复跑 N 次；默认 1） */
  subloopRepeat?: number;

  // --- ifelse/case 类型专用 ---
  /** ifelse 的两个分支 [true分支, false分支]；case 的多个分支 */
  branches?: FlowBranch[];
  /** case 节点：用于匹配的字段名/表达式（如 fieldName 或 left_field==value） */
  switchField?: string;
}

/** 流程图定义（一个模板可以有一个主流程图；没有则自动从 marks 生成线性流程图） */
export interface FlowGraph {
  /** 流程图版本（用于未来迁移） */
  version: 1;
  /** 主节点序列 */
  nodes: FlowNode[];
  /** 流程图更新时间戳 */
  updatedAt: number;
}

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
  /** 模板介绍（最多40字） */
  description?: string;
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
  /** 字段映射（审查字段/控件/固定值等）：随模板保存，复用模板时比对不丢失 */
  mappings?: FieldMapping[];
  /** 提取元素面板条目（自定义文本 + 文件提取字段，含 Excel 列绑定）：随模板保存，分享/应用模板时完整恢复 */
  customTextEntries?: CustomTextEntry[];
  /** 流程图（可选）：如果存在，执行器可按流程图中的嵌套/分支逻辑运行；不存在则按 marks 线性执行 */
  flowGraph?: FlowGraph;
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
  /** MRZ交叉验证警告：该记录的护照文件中上方识别与MRZ不一致的提示 */
  mrz_warnings?: string[];
  /** 产生该报告的流程类型：entry=录入/提取流（卡片用箭头展示填入值），review=审查流（卡片用✓/✗展示比对） */
  flow?: "entry" | "review";
}

// ========== 文档提取（功能1/2） ==========

/** 文档提取方式 */
export type ExtractMethod =
  | "markitdown"    // PDF 文字层 / Office 文档
  | "vision_ocr"    // 图片 → Vision LLM 识图
  | "umi_ocr"       // 图片 → UMI-OCR 本地引擎
  | "pdf_ocr"       // 扫描 PDF → 渲染图片 → Vision LLM
  | "pdf_umi_ocr";  // 扫描 PDF → 渲染图片 → UMI-OCR

/** 引擎回退信息（UMI-OCR 失败时自动切换 AI Vision 等） */
export interface ExtractFallback {
  from: string;
  to: string;
  reason: string;
}

/** 文档提取结果 */
export interface DocumentExtractResult {
  filename: string;
  /** 提取方式 */
  method: ExtractMethod;
  /** 提取出的全文 */
  text: string;
  /** 结构化字段（请求了 fields 时返回） */
  fields: Record<string, string>;
  /** 预处理后的图片预览（base64，仅图片文件有值）— 自动旋转到正面 + 裁剪白边后 */
  processed_image?: string | null;
  /** MRZ交叉验证警告：上方文字识别与底部MRZ不一致的字段列表，已以MRZ为准修正 */
  mrz_warnings?: string[];
  /** 引擎回退信息（如 UMI-OCR 失败后自动切换 AI Vision） */
  fallback?: ExtractFallback | null;
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
  /** MRZ交叉验证警告：上方文字识别与底部MRZ不一致的字段列表，已以MRZ为准修正 */
  mrz_warnings?: string[];
  /** 引擎回退信息（如 UMI-OCR 失败后自动切换 AI Vision） */
  fallback?: ExtractFallback | null;
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
  issue_authority: "签发所",
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
  fail: "需检查",
  review: "有问题",
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

// ========== 幻灯片任务（PPT Section 拆并） ==========

export interface PPTTextNode {
  path: string;
  text: string;
}

export interface PPTSlideNode {
  index: number;
  path: string;
  title: string;
  texts: PPTTextNode[];
}

// ========== Cowork Studio（中央 AI 协作） ==========

export interface CoworkSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  created_at: number;
  updated_at: number;
}

export interface CoworkClient {
  id: string;
  name: string;
  available: boolean;
  path: string;
  version: string;
  hint: string;
}

export type CoworkDispatchEvent =
  | { type: "status"; stage: string; message: string; round: number }
  | { type: "client_start"; client_id: string; client_name: string }
  | {
      type: "client_done";
      client_id: string;
      status: "done" | "failed";
      elapsed: number;
      result_preview?: string;
      error?: string;
    }
  | { type: "qc"; review: string; passed: boolean; feedback: string; round: number }
  | { type: "done"; task: CoworkTask }
  | { type: "error"; message: string };

export interface CoworkAssignment {
  client_id: string;
  client_name: string;
  prompt_file: string;
  result_file: string;
  status: "pending" | "running" | "done" | "failed" | "timeout";
  result: string;
  error: string;
  started_at: number;
  finished_at: number;
  elapsed: number;
}

export interface CoworkTask {
  id: string;
  instruction: string;
  skill_ids: string[];
  client_ids: string[];
  max_rounds: number;
  status: string;
  assignments: CoworkAssignment[];
  qc_review: string;
  qc_passed: boolean;
  qc_feedback: string;
  round: number;
  final_result: string;
  created_at: number;
}

export interface PPTFileSlides {
  file_id: string;
  file_name: string;
  file_path: string;
  slides: PPTSlideNode[];
}

export interface PPTSectionPart {
  file_id: string;
  file_name: string;
  file_path: string;
  slide_start: number;
  slide_end: number;
  slides: PPTSlideNode[];
}

export interface PPTSection {
  name: string;
  parts: PPTSectionPart[];
}

export interface PPTTextPatch {
  file_id: string;
  file_name: string;
  file_path: string;
  slide: number;
  path: string;
  text: string;
  new_text: string;
}

export interface PPTProgressEvent {
  index: number;
  total: number;
  file: string;
  status: "parsing" | "outline" | "markitdown" | "done" | "error";
  slides?: number;
  texts?: number;
  chars?: number;
  message?: string;
}

// PPT 视觉风格（与后端 StyleProfile 对应）
export interface PPTStyleProfile {
  name: string;
  display_name: string;
  palette: [string, string][];           // [(accent, tint), ...]
  title_size: number;
  body_size: number;
  title_color: string;
  body_color: string;
  cover_layout: "center" | "split";
  content_layout: "card" | "minimal" | "sidebar";
  decor: string[];
  style_notes: string;
}

// 单页可编辑元素（slide-elements 端点返回）
export interface PPTSlideElement {
  path: string;
  type: string;                          // shape / picture / table ...
  x?: string; y?: string;                // 英寸字符串，如 "1.2in"
  width?: string; height?: string;
  text?: string;
  size?: string;
  color?: string;
  fill?: string;
  bold?: string;
  align?: string;
  valign?: string;
  geometry?: string;
  name?: string;
}

// 流式按文字新建 PPT 的推送事件（AI 逐步放置文字/装饰/图片元素）
/** AI 生成的 PPT 大纲单页（含章节、摘要、要点） */
export interface PPTOutlineSlide {
  section: string;
  title: string;
  summary: string;
  bullets: string[];
  image_prompt?: string;
}

export type PPTStreamEvent =
  | { type: "outline"; slides: PPTOutlineSlide[]; style?: { name: string; display_name: string } }
  | { type: "add_text"; slide: number; element: "title" | "bullet"; text: string }
  | { type: "add_decor"; slide: number; element: string }
  | { type: "add_image"; slide: number; status: "generating" | "placed" | "failed" }
  | { type: "screenshot"; slide: number; image_data: string }
  | { type: "done"; result: { file_path: string; file_name: string; total_slides: number } }
  | { type: "error"; message?: string };
