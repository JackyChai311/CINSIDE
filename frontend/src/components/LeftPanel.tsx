import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  GripVertical,
  Layers,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Palette,
  UserCircle,
  X,
  XCircle,
} from "lucide-react";
import type { AnalysisSegment, ApplicantRecord, BatchResult, BatchStatus, Overall, VerificationStep } from "../types";
import { OVERALL_LABELS } from "../types";
import { api } from "../api/client";
import { BACKEND_ORIGIN } from "../lib/backendOrigin";
import { type AISphereState } from "./AISphere";
import ExecutionBubbles from "./ExecutionBubbles";
import PluginPanel from "./PluginPanel";

const SKILL_DRAG_MIME = "application/x-cinside-skill-id";

/** 空列常量：非选列中的卡片一律传同一引用，配合 RecordItem memo 引用比较不炸 */
const EMPTY_COLUMNS: { key: string; sample: string }[] = [];

/** 后端可能作为别名自动添加的标准字段 key 集合（用于过滤重复列） */
const STANDARD_ALIAS_KEYS = new Set([
  "name", "passport_no", "student_id", "nationality", "birth_date", "gender",
  "passport_issue", "passport_expiry", "email", "phone",
  "university_url", "university_name",
]);

interface Props {
  records: ApplicantRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
  onClear: () => Promise<void>;
  onDetach?: () => void;
  /** AI 球体状态（待命/处理中/发现问题/讲解中） */
  aiSphereState?: AISphereState;
  /** 后端自动识别的列映射（用于过滤列选择浮层中的别名列） */
  detectedColumnMap?: Record<string, string>;
  /** 每条记录的核验结论：record_id -> overall */
  recordResults?: Record<string, Overall>;
  /** 批量执行结果：record_id -> BatchResult */
  batchResults?: Record<string, BatchResult>;
  /** 功能3：点击卡片 ▶ 执行该记录的单卡 LOOP（自动导航到页面供人工审查） */
  onRunRecord?: (id: string) => void;
  /** 单卡运行是否禁用（无模板/批量运行中/单卡运行中） */
  runDisabled?: boolean;
  /** 正在单卡运行的记录 ID */
  runningRecordId?: string | null;
  /** 记录为空时的自定义提示（如：等待框选 LOOP 行范围生成卡片） */
  emptyHint?: string;
  /** SKILL 拖放到卡片：(skillId, recordId) => void */
  onDropSkill?: (skillId: string, recordId: string) => void;
  /** 已勾选的记录 ID 集合 */
  checkedIds?: Set<string>;
  /** 勾选状态变化回调 */
  onCheckChange?: (ids: Set<string>) => void;
  /** 勾选后执行当前 LOOP */
  onRunCheckedLoop?: () => void;
  /** 勾选后打开已保存 LOOP 列表选择适配 */
  onAdaptLoopToChecked?: () => void;
  /** 拖拽排序回调：传入新的记录数组 */
  onReorder?: (records: ApplicantRecord[]) => void;
  /** 卡片-LOOP 关联映射：record_id -> { loopName, setAt } */
  cardLoopMap?: Record<string, { loopId: string; loopName: string; setAt: number }>;
  /** 执行游标：控制"运行"按钮只跑前 N 张已设置 LOOP 的卡片；null=全部 */
  runCursor?: number | null;
  /** 游标变化回调 */
  onRunCursorChange?: (n: number | null) => void;
  /** 游标运行：跑前 N 张已设置 LOOP 的卡片 */
  onRunLoopsWithCursor?: () => void;
  /** 清除某张卡片的 LOOP 关联 */
  onClearCardLoop?: (recordId: string) => void;
  /** 清除所有卡片的 LOOP 关联 */
  onClearAllCardLoops?: () => void;
  /** 字段列映射：标准字段名 -> Excel 原始列 key（用于手动修正识别失败的列） */
  fieldColumnMap?: Record<string, string>;
  /** 字段列映射变化回调：(标准字段名, Excel列key | null) => void */
  onFieldColumnMapChange?: (field: string, columnKey: string | null) => void;
  /** 卡片自定义图片：record_id -> base64 dataURL（Ctrl+V 或拖拽设置） */
  cardImages?: Record<string, string>;
  /** 设置某张卡片的图片：(recordId, dataUrl) => void */
  onSetCardImage?: (recordId: string, dataUrl: string) => void;
  /** 清除某张卡片的图片：(recordId) => void */
  onClearCardImage?: (recordId: string) => void;
  /** LOOP 执行步骤流（驱动球体下方的进度气泡） */
  execSteps?: VerificationStep[];
  /** 是否正在执行 LOOP */
  execRunning?: boolean;
  /** 执行进度面板是否已打开（打开时隐藏气泡，卡片区域变为执行进度视图） */
  execPanelOpen?: boolean;
  /** 是否显示「执行进度」药丸按钮（气泡消散后、面板未开时） */
  execChipVisible?: boolean;
  /** 点击「执行进度」按钮 */
  onOpenExecPanel?: () => void;
  /** 关闭执行进度视图，返回卡片列表 */
  onCloseExecPanel?: () => void;
  /** 执行步骤列表底部锚点（新步骤时自动滚动到底） */
  logEndRef?: RefObject<HTMLDivElement>;
  /** 气泡全部消散回调（用于触发药丸按钮显现） */
  onExecBubblesGone?: () => void;
  /** 执行分析：文本框是否打开（打开时卡片区域变为分析报告视图） */
  analysisOpen?: boolean;
  /** 是否有可查看的执行分析（LOOP 运行中问题卡片完成 / 审查结束后为 true） */
  analysisAvailable?: boolean;
  /** 分析分段列表：运行中每张问题卡片一段实时追加，结束补总结段 */
  analysisSegments?: AnalysisSegment[];
  /** 任一分段生成中（AI 异步工作，球体同步为 processing 动画） */
  analysisLoading?: boolean;
  /** 切换分析文本框开关 */
  onToggleAnalysis?: (open: boolean) => void;
  /** 重新生成分析 */
  onRegenerateAnalysis?: () => void;
  /** 打开 PERSONAL 面板（换壁纸 / 调面板不透明度） */
  onOpenPersonal?: () => void;
}

export default function LeftPanel({
  records,
  selectedId,
  onSelect,
  onRefresh,
  onClear,
  onDetach,
  aiSphereState = "idle",
  detectedColumnMap = {},
  recordResults,
  batchResults,
  onRunRecord,
  runDisabled = true,
  runningRecordId = null,
  emptyHint,
  onDropSkill,
  checkedIds,
  onCheckChange,
  onRunCheckedLoop,
  onAdaptLoopToChecked,
  onReorder,
  cardLoopMap,
  runCursor,
  onRunCursorChange,
  onRunLoopsWithCursor,
  onClearCardLoop,
  onClearAllCardLoops,
  fieldColumnMap = {},
  onFieldColumnMapChange,
  cardImages = {},
  onSetCardImage,
  onClearCardImage,
  execSteps = [],
  execRunning = false,
  execPanelOpen = false,
  execChipVisible = false,
  onOpenExecPanel,
  onCloseExecPanel,
  logEndRef,
  onExecBubblesGone,
  analysisOpen = false,
  analysisAvailable = false,
  analysisSegments = [],
  analysisLoading = false,
  onToggleAnalysis,
  onRegenerateAnalysis,
  onOpenPersonal,
}: Props) {
  /** 范围勾选：上次点击的记录索引（群组起点） */
  const lastCheckIdxRef = useRef<number>(-1);
  /** 群组操作面板是否展开 */
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  /** 拖拽排序：正在拖拽的卡片 record_id */
  const [dragId, setDragId] = useState<string | null>(null);
  /** 拖拽排序：正在拖拽的批次 loopId（整批拖拽时使用） */
  const [dragLoopId, setDragLoopId] = useState<string | null>(null);
  /** 拖拽排序：拖拽悬停的目标索引 */
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  /** 字段列选择器：当前正在为哪个标准字段选列（null=未激活） */
  const [pickingField, setPickingField] = useState<null | "name" | "passport_no" | "student_id">(null);
  /** 列选择器锚定的卡片 record_id（在该卡片下方展示） */
  const [pickingAnchorId, setPickingAnchorId] = useState<string | null>(null);
  /** 选择器浮层的锚点位置（相对面板容器） */
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // 执行分析：新分段到达/分段内容更新时自动滚到底部跟随实时报告；
  // 仅当用户本就停在底部附近时才跟随（手动上翻阅读旧分段时不打扰）
  const analysisScrollRef = useRef<HTMLDivElement | null>(null);
  const analysisSig = analysisSegments.map((s) => `${s.key}:${s.loading ? 1 : s.text.length}`).join("|");
  useEffect(() => {
    const el = analysisScrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight;
  }, [analysisSig]);

  // 计算当前 Excel 可用的所有列（从第一张记录推断），用于列选择浮层
  // 过滤掉后端自动添加的标准别名列（如原始列是"大写"时，name 作为别名应被过滤）
  const detectedStandardKeys = useMemo(() => new Set(Object.values(detectedColumnMap)), [detectedColumnMap]);
  const availableColumns: { key: string; sample: string }[] = useMemo(() => {
    const sample = records[0];
    if (!sample) return [];
    return Object.entries(sample.fields)
      .filter(([k, v]) => {
        if (v === undefined || v === null) return false;
        // 过滤内部字段
        if (k.startsWith("_")) return false;
        // 过滤后端自动添加的标准别名列
        if (STANDARD_ALIAS_KEYS.has(k) && detectedStandardKeys.has(k)) {
          const hasOriginalCol = Object.entries(detectedColumnMap).some(([origCol, stdKey]) => stdKey === k && origCol !== k);
          if (hasOriginalCol) return false;
        }
        return true;
      })
      .map(([k, v]) => ({
        key: k,
        sample: String(v).slice(0, 30),
      }));
  }, [records, detectedStandardKeys, detectedColumnMap]);

  // 点击面板外部关闭列选择浮层
  useEffect(() => {
    if (!pickingField) return;
    const handler = (e: MouseEvent) => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) {
        setPickingField(null);
        setPickingAnchorId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickingField]);

  const handleRequestPickField = useCallback((recordId: string, field: "name" | "passport_no" | "student_id") => {
    setPickingField(field);
    setPickingAnchorId(recordId);
  }, []);

  const handlePickColumn = useCallback((columnKey: string) => {
    if (pickingField && onFieldColumnMapChange) {
      onFieldColumnMapChange(pickingField, columnKey);
    }
    setPickingField(null);
    setPickingAnchorId(null);
  }, [pickingField, onFieldColumnMapChange]);

  /** 从 record 中取标准字段值，优先已识别字段，其次手动映射列 */
  const getFieldValue = useCallback((record: ApplicantRecord, field: "name" | "passport_no" | "student_id") => {
    const direct = record.fields[field];
    if (direct && direct.trim()) return direct;
    const mapped = fieldColumnMap[field];
    if (mapped) {
      const v = record.fields[mapped];
      if (v && v.trim()) return v;
    }
    return "";
  }, [fieldColumnMap]);

  /** 群组选择逻辑：点击第一张卡=起点，点击第二张卡=终点（范围全选），点击已选范围外=新群组 */
  const handleToggleCheck = useCallback((idx: number, id: string) => {
    if (!onCheckChange) return;
    // 已保存到批次的卡片不可勾选
    if (cardLoopMap?.[id]) return;
    const cur = new Set(checkedIds || []);
    const curSize = cur.size;

    if (curSize === 0) {
      // 无选择：设为起点
      cur.clear();
      cur.add(id);
      lastCheckIdxRef.current = idx;
    } else if (curSize === 1) {
      // 已有1张（起点）：点击另一张=范围全选（跳过已保存批次的卡片）
      const anchorIdx = lastCheckIdxRef.current;
      if (idx === anchorIdx) {
        // 点同一张：取消
        cur.clear();
        lastCheckIdxRef.current = -1;
      } else {
        const from = Math.min(anchorIdx, idx);
        const to = Math.max(anchorIdx, idx);
        cur.clear();
        for (let i = from; i <= to; i++) {
          const rid = records[i]?.record_id;
          if (rid && !cardLoopMap?.[rid]) cur.add(rid);
        }
        // 若范围内没有可勾选卡片，则重置为点击的这张
        if (cur.size === 0) {
          cur.add(id);
          lastCheckIdxRef.current = idx;
        }
      }
    } else {
      // 已有范围：点新的=重置为新起点
      cur.clear();
      cur.add(id);
      lastCheckIdxRef.current = idx;
    }
    onCheckChange(cur);
    setShowGroupPanel(false);
  }, [checkedIds, onCheckChange, records, cardLoopMap]);

  /** 执行进度视图内的 Tab：执行步骤 / 体外循环（打开时重置为步骤） */
  const [execTab, setExecTab] = useState<"steps" | "plugin">("steps");
  useEffect(() => {
    if (execPanelOpen) setExecTab("steps");
  }, [execPanelOpen]);

  // 气泡可见期：运行开始即收起球并让气泡占据球位；气泡全部消散后球才落回（球与气泡不抢位置）
  const [bubblesVisible, setBubblesVisible] = useState(execRunning);
  useEffect(() => {
    if (execRunning) setBubblesVisible(true);
  }, [execRunning]);
  const sphereRetracted = execRunning || bubblesVisible;

  // AI 粒子球已移除：球位改为「HI USER → 环境检查 → 结果确认 → 时钟」的启动序列。
  // 环境检查为真实检测（后端服务 / OCR 引擎 / Python 依赖），非过场动画：
  // 检查完成后列出每项状态；未就绪项由用户逐项选择「下载/开启」或「忽略」，
  // 做出选择并确认后才进入时钟。
  const [bootPhase, setBootPhase] = useState<0 | 1 | 2 | 3>(0);
  type EnvCheckStatus = "pending" | "checking" | "ok" | "fail";
  /** 未就绪项的处置方式：install=下载/开启，ignore=忽略 */
  type EnvChoice = "install" | "ignore";
  interface EnvCheck {
    key: "backend" | "ocr" | "python";
    label: string;
    status: EnvCheckStatus;
    /** 失败时的补充说明 */
    detail?: string;
    /** 用户对未就绪项的选择（仅 status=fail 时有意义） */
    choice?: EnvChoice;
  }
  const makeInitialChecks = (): EnvCheck[] => [
    { key: "backend", label: "后端服务", status: "pending" },
    { key: "ocr", label: "OCR 引擎", status: "pending" },
    { key: "python", label: "Python 依赖", status: "pending" },
  ];
  const [envChecks, setEnvChecks] = useState<EnvCheck[]>(makeInitialChecks);
  /** 正在处理中的项：安装中 / 启动中 */
  const [envBusy, setEnvBusy] = useState<null | "ocr" | "python" | "backend">(null);
  /** 是否正在一次性执行所有勾选的 install */
  const [envApplying, setEnvApplying] = useState(false);

  const setCheck = useCallback((key: EnvCheck["key"], patch: Partial<EnvCheck>) => {
    setEnvChecks((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }, []);

  /** 真实跑一遍环境检查：后端健康 → 拉取依赖状态 → 判定 OCR / Python 依赖。返回是否全部就绪 */
  const runEnvCheck = useCallback(async (): Promise<boolean> => {
    setEnvChecks([
      { key: "backend", label: "后端服务", status: "checking" },
      { key: "ocr", label: "OCR 引擎", status: "pending" },
      { key: "python", label: "Python 依赖", status: "pending" },
    ]);

    // 1) 后端服务：健康检查（带超时）
    let backendOk = false;
    try {
      const res = await fetch(BACKEND_ORIGIN + "/api/health", { signal: AbortSignal.timeout(2500) });
      backendOk = res.ok;
    } catch {
      backendOk = false;
    }
    setCheck("backend", backendOk ? { status: "ok" } : { status: "fail", detail: "未启动或无法连接" });
    if (!backendOk) {
      // 后端没起来就无法查依赖，两项标为后端未就绪
      setCheck("ocr", { status: "fail", detail: "后端未就绪" });
      setCheck("python", { status: "fail", detail: "后端未就绪" });
      return false;
    }

    // 2) 依赖状态：一次性拿到 OCR 引擎 + Python 依赖
    setCheck("ocr", { status: "checking" });
    setCheck("python", { status: "checking" });
    try {
      const deps = await api.getDepsStatus();
      const ocrOk = !!deps.ocr_engine_all_installed;
      const pyOk = !!deps.python_all_installed;
      setCheck("ocr", ocrOk ? { status: "ok" } : { status: "fail", detail: "未安装加速引擎" });
      setCheck("python", pyOk ? { status: "ok" } : { status: "fail", detail: "缺少必要依赖" });
      return ocrOk && pyOk;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "检测失败";
      setCheck("ocr", { status: "fail", detail: msg });
      setCheck("python", { status: "fail", detail: msg });
      return false;
    }
  }, [setCheck]);

  // 启动序列：短暂展示 HI USER → 真实检查 → 结果确认页（等待用户选择）
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      setBootPhase(1);
      await runEnvCheck();
      if (cancelled) return;
      // 统一进入「结果确认页」：全部就绪时用户直接点「进入」即可；
      // 有未就绪项时逐项选择「下载/开启」或「忽略」。
      setBootPhase(2);
    }, 1100);
    return () => { cancelled = true; clearTimeout(t); };
  }, [runEnvCheck]);

  /** 切换某项的处置选择（未就绪项）：点同一项第二次取消选择 */
  const setEnvChoice = useCallback((key: EnvCheck["key"], choice: EnvChoice) => {
    setEnvChecks((cs) => cs.map((c) => (c.key === key ? { ...c, choice: c.choice === choice ? undefined : choice } : c)));
  }, []);

  /** 执行单项安装（Python 依赖 / OCR 引擎）；装完重跑该项检查 */
  const installOne = useCallback(async (which: "ocr" | "python") => {
    setEnvBusy(which);
    try {
      if (which === "python") await api.installPythonDeps();
      else await api.installOcrEngineDeps();
    } catch { /* 失败由重检结果反映 */ }
    finally { setEnvBusy(null); }
    // 重跑整轮（后端健康 + 依赖），刷新所有状态
    await runEnvCheck();
  }, [runEnvCheck]);

  /** 后端未就绪时的「启动/重试」：重新健康检查 */
  const startBackend = useCallback(async () => {
    setEnvBusy("backend");
    try { await runEnvCheck(); } finally { setEnvBusy(null); }
  }, [runEnvCheck]);

  /** 确认并继续：先把所有选了「下载/开启」的未就绪项依次执行，再进入时钟 */
  const confirmEnvAndEnter = useCallback(async () => {
    const toInstall = envChecks.filter((c) => c.status === "fail" && c.choice === "install");
    if (toInstall.length > 0) {
      setEnvApplying(true);
      for (const c of toInstall) {
        if (c.key === "python") { setEnvBusy("python"); try { await api.installPythonDeps(); } catch { /* ignore */ } finally { setEnvBusy(null); } }
        else if (c.key === "ocr") { setEnvBusy("ocr"); try { await api.installOcrEngineDeps(); } catch { /* ignore */ } finally { setEnvBusy(null); } }
        else if (c.key === "backend") { setEnvBusy("backend"); try { await runEnvCheck(); } catch { /* ignore */ } finally { setEnvBusy(null); } }
      }
      await runEnvCheck();
      setEnvApplying(false);
    }
    setBootPhase(3);
  }, [envChecks, runEnvCheck]);

  /** 结果确认页是否还有未就绪项没做选择（有则「确认」按钮不可用） */
  const pendingChoices = envChecks.filter((c) => c.status === "fail" && !c.choice);
  const envAllOk = envChecks.every((c) => c.status === "ok");

  // 数字时钟：确认进入后，固定区域改挂实时时钟（每秒刷新）
  const [clockNow, setClockNow] = useState(() => new Date());
  useEffect(() => {
    if (bootPhase !== 3) return;
    setClockNow(new Date());
    const t = setInterval(() => setClockNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [bootPhase]);

  return (
    <div
      className="relative flex h-full flex-col gap-3 p-3"
      style={{
        background: "var(--panel-bg-left)",
        borderRadius: "12px",
        boxShadow: "0 8px 32px -12px rgba(31,41,55,.18)",
      } as React.CSSProperties}
    >
      {/* AI 助手：黑白方格粒子球（无边框无文字，LOOP 运行/告警/讲解时形态变化）
          执行气泡锚定在左栏左下角（不挡人物卡片），消散后球体下方显现「执行进度」药丸 */}
      {/* 固定高度容器：HI USER → 检查 → 结果确认 → 时钟 四个阶段共用同一块位置。
          - 变更期（检查中 / 结果确认）：高度自适应，容纳列表与按钮
          - 稳定期（HI USER / 时钟）：固定 h-14(56px)
          执行气泡为 absolute 定位，锚点落在此框中心，不受阶段影响。 */}
      <div className={["relative flex shrink-0 items-center justify-center py-1", (bootPhase === 1 || bootPhase === 2) ? "" : "h-14"].join(" ")}>
        {bootPhase === 0 ? (
          <div className="flex select-none flex-col items-center leading-none animate-fade-in">
            <span className="text-2xl font-black text-brand-600">HI</span>
            <span className="text-2xl font-black text-slate-900">USER</span>
          </div>
        ) : (bootPhase === 1 || bootPhase === 2) ? (
          <div className="flex w-full select-none flex-col gap-1 text-[11px] leading-tight animate-fade-in">
            {/* 检查进行中：只显示进度 */}
            {bootPhase === 1 && (
              <>
                <div className="mb-0.5 text-[10px] font-medium text-slate-400">正在检查运行环境…</div>
                <ul className="flex flex-col gap-0.5">
                  {envChecks.map((c) => (
                    <li key={c.key} className="flex items-center gap-1">
                      {c.status === "ok" ? (
                        <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                      ) : c.status === "fail" ? (
                        <AlertTriangle className="h-3 w-3 shrink-0 text-rose-500" />
                      ) : (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-slate-400" />
                      )}
                      <span className={c.status === "fail" ? "text-rose-600" : c.status === "ok" ? "text-slate-700" : "text-slate-500"}>
                        {c.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* 结果确认页：列出每项状态，未就绪项逐项选择 下载/开启 或 忽略 */}
            {bootPhase === 2 && (
              <>
                <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-slate-400">
                  {envAllOk ? (
                    <><CheckCircle2 className="h-3 w-3 text-emerald-500" /> 环境检查通过</>
                  ) : (
                    <><AlertTriangle className="h-3 w-3 text-amber-500" /> 环境检查：{envChecks.filter((c) => c.status === "fail").length} 项未就绪</>
                  )}
                </div>
                <ul className="flex flex-col gap-1">
                  {envChecks.map((c) => {
                    const ok = c.status === "ok";
                    return (
                      <li key={c.key} className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1">
                          {ok ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                          ) : (
                            <AlertTriangle className="h-3 w-3 shrink-0 text-rose-500" />
                          )}
                          <span className={ok ? "text-slate-700" : "text-rose-600"}>{c.label}</span>
                          <span className="text-[10px] text-slate-400">
                            {ok ? "已就绪" : (c.detail || "未就绪")}
                          </span>
                        </div>
                        {/* 未就绪项：提供两个选择（下载/开启 或 忽略） */}
                        {!ok && (
                          <div className="ml-4 flex flex-wrap items-center gap-1">
                            <button
                              onClick={() => (c.key === "backend" ? startBackend() : installOne(c.key as "ocr" | "python"))}
                              disabled={envBusy !== null || envApplying}
                              className={[
                                "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-all disabled:opacity-50",
                                c.choice === "install"
                                  ? "bg-slate-900 text-white ring-1 ring-slate-900"
                                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
                              ].join(" ")}
                              title={c.key === "backend" ? "重新尝试连接后端服务" : "立即下载/安装"}
                            >
                              {envBusy === c.key ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Download className="h-2.5 w-2.5" />}
                              {c.key === "backend" ? "启动" : "下载"}
                            </button>
                            <button
                              onClick={() => setEnvChoice(c.key, "ignore")}
                              disabled={envBusy !== null || envApplying}
                              className={[
                                "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-all disabled:opacity-50",
                                c.choice === "ignore"
                                  ? "bg-slate-200 text-slate-700 ring-1 ring-slate-300"
                                  : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50",
                              ].join(" ")}
                              title="忽略此项，直接进入"
                            >
                              <X className="h-2.5 w-2.5" /> 忽略
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {/* 底部：确认进入（有未选则禁用）+ 重新检查 */}
                <div className="mt-1 flex items-center gap-1.5">
                  <button
                    onClick={confirmEnvAndEnter}
                    disabled={envApplying || envBusy !== null || pendingChoices.length > 0}
                    className="flex items-center gap-0.5 rounded-md bg-brand-600 px-2.5 py-1 text-[10px] font-semibold text-white transition-all hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                    title={pendingChoices.length > 0 ? "请先为每个未就绪项选择「下载」或「忽略」" : "确认并进入"}
                  >
                    {envApplying ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />}
                    {envApplying ? "处理中…" : "确认进入"}
                  </button>
                  <button
                    onClick={() => runEnvCheck()}
                    disabled={envApplying || envBusy !== null}
                    className="flex items-center gap-0.5 rounded-md bg-white px-2 py-1 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-slate-50 disabled:opacity-50"
                    title="重新检测所有项"
                  >
                    <RefreshCw className="h-2.5 w-2.5" /> 重新检查
                  </button>
                </div>
                {pendingChoices.length > 0 && (
                  <div className="text-[9px] text-amber-600">
                    还有 {pendingChoices.length} 项待选择：下载 / 忽略
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* 时钟：运行期间（含气泡未消散）收起，把这块位置让给步骤气泡；运行结束气泡散尽后复原 */
          <div className={[
            "flex select-none flex-col items-center leading-none",
            sphereRetracted ? "invisible" : "animate-fade-in",
          ].join(" ")}>
            <span className="font-mono text-xl font-semibold tabular-nums text-slate-800">
              {String(clockNow.getHours()).padStart(2, "0")}
              <span className="mx-0.5 text-brand-600">:</span>
              {String(clockNow.getMinutes()).padStart(2, "0")}
              <span className="mx-0.5 text-brand-600">:</span>
              {String(clockNow.getSeconds()).padStart(2, "0")}
            </span>
            <span className="mt-0.5 text-[10px] text-slate-400">
              {clockNow.getFullYear()}-{String(clockNow.getMonth() + 1).padStart(2, "0")}-{String(clockNow.getDate()).padStart(2, "0")}
            </span>
          </div>
        )}
        {/* LOOP 执行气泡：球收起后占据球位，向上堆叠渐淡（运行中不停弹出但不挡卡片） */}
        {!execPanelOpen && sphereRetracted && (
          <ExecutionBubbles
            variant="sphere"
            steps={execSteps}
            running={execRunning}
            onAllGone={() => {
              setBubblesVisible(false);
              onExecBubblesGone?.();
            }}
          />
        )}
        {execChipVisible && !execPanelOpen && !sphereRetracted && (
          <div className="absolute -bottom-2 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 animate-fade-in">
            <button
              onClick={onOpenExecPanel}
              className="flex items-center gap-1 text-[11px] font-semibold text-slate-900 transition-opacity hover:opacity-60"
              title="查看日志"
            >
              <Activity className="h-3 w-3 text-slate-900" />
              日志
            </button>
            {analysisAvailable && onToggleAnalysis && (
              <>
                <span className="h-3 w-px bg-slate-300" />
                <button
                  onClick={() => onToggleAnalysis(true)}
                  className="flex items-center gap-1 text-[11px] font-semibold text-slate-900 transition-opacity hover:opacity-60"
                  title="查看执行分析（AI 对本次审查结果的总结）"
                >
                  <Sparkles className="h-3 w-3 text-slate-900" />
                  分析
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* 执行进度视图：与执行分析同一位置（卡片区域原位切换），含 LOOP 执行步骤 / 体外循环 两个 Tab */}
      {execPanelOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Activity className="h-3 w-3 text-slate-900" />
              <span className="text-xs font-semibold text-slate-700">日志</span>
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                {execSteps.length} 步
              </span>
            </div>
            <button
              onClick={onCloseExecPanel}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              title="关闭，返回卡片列表"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {/* Tab 切换栏 */}
          <div className="flex shrink-0 border-b border-slate-100 bg-slate-50/40">
            <button
              onClick={() => setExecTab("steps")}
              className={[
                "flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-all",
                execTab === "steps"
                  ? "bg-white text-slate-800 shadow-[inset_0_-2px_0_0_#0f172a]"
                  : "text-slate-500 hover:bg-white/60 hover:text-slate-700",
              ].join(" ")}
            >
              <Activity className="h-3.5 w-3.5" />
              LOOP 执行步骤
            </button>
            <button
              onClick={() => setExecTab("plugin")}
              className={[
                "flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-all",
                execTab === "plugin"
                  ? "bg-white text-slate-800 shadow-[inset_0_-2px_0_0_#0f172a]"
                  : "text-slate-500 hover:bg-white/60 hover:text-slate-700",
              ].join(" ")}
            >
              <Bot className="h-3.5 w-3.5" />
              体外循环
            </button>
          </div>
          {/* Tab 内容 */}
          {execTab === "steps" ? (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {execSteps.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-[11px] text-slate-400">
                  <Activity className="mb-1 h-8 w-8 text-slate-300" />
                  执行时显示进度
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {execSteps.map((s) => {
                    if (s.isTaskStart) {
                      return (
                        <li key={`task-${s.step}`} className="-mx-2 my-2 first:mt-0">
                          <div className="flex items-center gap-2 rounded-lg border-2 border-indigo-300 bg-gradient-to-r from-indigo-600 to-violet-600 px-3 py-2 shadow-md">
                            <Layers className="h-4 w-4 shrink-0 text-white" />
                            <span className="text-[12px] font-bold text-white">{s.taskName || "任务"}</span>
                            <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white">{s.taskIndex}/{s.taskTotal}</span>
                            <span className="ml-auto text-[10px] text-indigo-200">{s.taskRecordCount}张卡片</span>
                          </div>
                        </li>
                      );
                    }
                    if (s.isRecordStart) {
                      return (
                        <li key={`record-${s.step}`} className="-mx-1 my-1.5">
                          <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/80 px-3 py-1.5 shadow-sm">
                            <UserCircle className="h-4 w-4 shrink-0 text-indigo-600" />
                            <span className="text-[11px] font-bold text-indigo-900">{s.recordName || "人物卡片"}</span>
                            <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">{s.recordIndex}/{s.recordTotal}</span>
                          </div>
                        </li>
                      );
                    }
                    const icon = s.success
                      ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      : <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />;
                    return (
                      <li key={s.step} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-slate-50/60">
                        {icon}
                        <span className="text-[11px] leading-5 text-slate-600">
                          {s.description}
                          {s.detail && <span className="ml-1 text-slate-400">— {s.detail}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div ref={logEndRef} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              <PluginPanel />
            </div>
          )}
        </div>
      ) : analysisOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-indigo-500" />
              <span className="text-xs font-semibold text-slate-700">执行分析</span>
              {analysisLoading && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
            </div>
            <div className="flex items-center gap-0.5">
              {onRegenerateAnalysis && (
                <button
                  onClick={onRegenerateAnalysis}
                  disabled={analysisLoading}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                  title="按当前审查结果重新生成总结"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              )}
              <button
                onClick={() => onToggleAnalysis?.(false)}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                title="关闭分析，返回卡片列表"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div ref={analysisScrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {analysisSegments.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-slate-400">
                {analysisLoading || execRunning ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin text-slate-300" />
                    LOOP 运行中，问题卡片完成后 AI 分析会实时追加到这里…
                  </>
                ) : (
                  "暂无分析内容"
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {analysisSegments.map((seg) => (
                  <div
                    key={seg.key}
                    className={[
                      "rounded-lg border px-2.5 py-2",
                      seg.kind === "summary"
                        ? "border-indigo-100 bg-indigo-50/40"
                        : seg.overall === "fail"
                        ? "border-rose-100 bg-rose-50/40"
                        : "border-amber-100 bg-amber-50/40",
                    ].join(" ")}
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      {seg.kind === "summary" ? (
                        <Sparkles className="h-3 w-3 shrink-0 text-indigo-500" />
                      ) : seg.overall === "fail" ? (
                        <XCircle className="h-3 w-3 shrink-0 text-rose-500" />
                      ) : (
                        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                      )}
                      <span className="truncate text-[11px] font-semibold text-slate-700">{seg.title}</span>
                      {seg.kind === "card" && seg.overall && (
                        <span className="shrink-0 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                          {OVERALL_LABELS[seg.overall]}
                        </span>
                      )}
                      {seg.loading && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-slate-400" />}
                    </div>
                    {seg.loading && !seg.text ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                        <Loader2 className="h-3 w-3 animate-spin text-slate-300" />
                        AI 正在分析…
                      </div>
                    ) : (
                      <>
                        {seg.kind === "summary" && seg.stats && (
                          <div className="mb-1.5 flex flex-wrap items-center gap-1">
                            <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              用时 {seg.stats.duration}
                            </span>
                            {seg.stats.pass > 0 && (
                              <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                {seg.stats.pass}/{seg.stats.total} 通过
                              </span>
                            )}
                            {seg.stats.review > 0 && (
                              <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                {seg.stats.review}/{seg.stats.total} 问题
                              </span>
                            )}
                            {seg.stats.fail > 0 && (
                              <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                                {seg.stats.fail}/{seg.stats.total} 需检查
                              </span>
                            )}
                          </div>
                        )}
                        <div className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">{seg.text}</div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-700">申请人记录</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
              {records.length}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            {analysisAvailable && onToggleAnalysis && (
              <button
                onClick={() => onToggleAnalysis(true)}
                className="rounded p-1 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600"
                title="查看执行分析（AI 对本次审查结果的总结）"
              >
                <Sparkles className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={onRefresh}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              title="刷新"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
            <button
              onClick={onClear}
              className="rounded p-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
              title="清空"
            >
              <Trash2 className="h-3 w-3" />
            </button>
            {onDetach && (
              <button
                onClick={onDetach}
                className="rounded p-1 text-slate-500 hover:bg-brand-50 hover:text-brand-600"
                title="脱离到独立窗口"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* 勾选提示栏：仅1张（起点）时显示提示 */}
        {checkedIds && checkedIds.size === 1 && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-amber-100 bg-amber-50/60 px-3 py-1.5 text-[10px] text-amber-700">
            <Check className="h-3 w-3" strokeWidth={3} />
            已选起点，再点击另一张卡片选择范围
            <button
              onClick={() => { onCheckChange?.(new Set()); lastCheckIdxRef.current = -1; }}
              className="ml-auto rounded p-0.5 text-amber-400 hover:bg-rose-100 hover:text-rose-500"
              title="取消"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* LOOP 控制栏：仅当有卡片关联了 LOOP 时显示 */}
        {cardLoopMap && onRunLoopsWithCursor && (() => {
          const loopCount = records.filter((r) => cardLoopMap[r.record_id]).length;
          if (loopCount === 0) return null;
          const cursorVal = runCursor ?? loopCount;
          // 统计 LOOP 分组数
          const loopIds = new Set<string>();
          records.forEach((r) => {
            const info = cardLoopMap[r.record_id];
            if (info) loopIds.add(info.loopId);
          });
          return (
            <div className="flex shrink-0 flex-col gap-1 border-b border-indigo-100 bg-indigo-50/40 px-3 py-1.5">
              <div className="flex items-center gap-1.5 text-[10px]">
                <Sparkles className="h-3 w-3 text-indigo-500" />
                <span className="font-semibold text-indigo-700">
                  {loopCount} 张已设 LOOP
                </span>
                {/* 分组数仅在多分组时展示：单分组是常态，显示「1 个分组」纯属占地方 */}
                {loopIds.size > 1 && (
                  <>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500">{loopIds.size} 个分组</span>
                  </>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                  <button
                    onClick={onRunLoopsWithCursor}
                    className="flex items-center gap-0.5 rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-indigo-700"
                    title={`运行前 ${cursorVal} 张已设 LOOP 的卡片`}
                  >
                    <Play className="h-2.5 w-2.5" />
                    运行 {cursorVal}/{loopCount}
                  </button>
                  {onClearAllCardLoops && (
                    <button
                      onClick={onClearAllCardLoops}
                      className="rounded p-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-500"
                      title="清除所有 LOOP 关联"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
              </div>
              {/* 游标滑块：1 ~ loopCount */}
              {onRunCursorChange && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-slate-400">1</span>
                  <input
                    type="range"
                    min={1}
                    max={loopCount}
                    value={cursorVal}
                    onChange={(e) => onRunCursorChange(Number(e.target.value))}
                    className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-slate-200 accent-indigo-600"
                    title={`拖动控制运行范围：前 ${cursorVal} 张`}
                  />
                  <span className="text-[9px] text-slate-400">{loopCount}</span>
                  {(runCursor ?? loopCount) < loopCount && (
                    <button
                      onClick={() => onRunCursorChange(null)}
                      className="ml-1 rounded px-1 text-[9px] text-indigo-500 hover:bg-indigo-100"
                      title="恢复全部"
                    >
                      全部
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        <div className="relative min-h-0 flex-1 overflow-auto p-1.5">
          {records.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs text-slate-400">
              <UserCircle className="h-7 w-7 text-slate-300" />
              {emptyHint ? (
                <p className="whitespace-pre-line">{emptyHint}</p>
              ) : (
                <p>上传 Excel/CSV 后<br />这里会列出所有记录</p>
              )}
            </div>
          ) : (
            <ul className="space-y-1">
              {records.map((r, idx) => {
                const isChecked = checkedIds?.has(r.record_id) ?? false;
                // 群组起点：已选范围内第一张卡的索引
                const firstCheckedIdx = checkedIds && checkedIds.size > 0
                  ? records.findIndex((rr) => checkedIds.has(rr.record_id))
                  : -1;
                const lastCheckedIdx = checkedIds && checkedIds.size > 0
                  ? records.reduce((acc, rr, i) => checkedIds.has(rr.record_id) ? i : acc, -1)
                  : -1;
                const showGroupHeader = checkedIds && checkedIds.size > 1 && idx === firstCheckedIdx;

                // 批次分隔线：检测是否是新批次的第一张卡，或是未保存区域的第一张卡（不在第一张卡上方显示）
                const curLoopInfo = cardLoopMap?.[r.record_id];
                const prevLoopInfo = idx > 0 ? cardLoopMap?.[records[idx - 1]?.record_id] : null;
                const isBatchStart = idx > 0 && !!curLoopInfo && (!prevLoopInfo || prevLoopInfo.loopId !== curLoopInfo.loopId);
                const isUnsavedStart = idx > 0 && !curLoopInfo && !!prevLoopInfo;
                const showBatchDivider = isBatchStart || isUnsavedStart;
                const isSaved = !!curLoopInfo;

                return (
                  <Fragment key={r.record_id}>
                    {/* 批次分隔线：区分已保存批次和未保存区域 */}
                    {showBatchDivider && (
                      <div className={[
                        "my-1.5 flex items-center gap-2",
                        isBatchStart ? "pt-1" : "pt-2",
                      ].join(" ")}>
                        <div className={[
                          "h-px flex-1",
                          isBatchStart ? "bg-emerald-200" : "bg-slate-300",
                        ].join(" ")} />
                        <span className={[
                          "shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                          isBatchStart
                            ? "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200"
                            : "bg-slate-50 text-slate-400 ring-1 ring-slate-200",
                        ].join(" ")}>
                          {isBatchStart ? curLoopInfo.loopName : "待配置"}
                        </span>
                        <div className={[
                          "h-px flex-1",
                          isBatchStart ? "bg-emerald-200" : "bg-slate-300",
                        ].join(" ")} />
                      </div>
                    )}
                    {/* 群组头部：一行内显示范围 + 操作面板 + 解散，保持整体极简风格 */}
                    {showGroupHeader && (
                      <div className="group-header-bar relative mb-1 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm ring-1 ring-indigo-100">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center justify-center rounded bg-indigo-500 p-0.5">
                            <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
                          </span>
                          <span className="text-[10px] font-medium text-slate-600">
                            群组 <span className="font-semibold text-slate-800">{firstCheckedIdx + 1}–{lastCheckedIdx + 1}</span>
                          </span>
                          <span className="rounded-full bg-slate-100 px-1.5 py-0 text-[9px] font-bold text-slate-600 ring-1 ring-slate-200">
                            {checkedIds!.size}
                          </span>
                        </div>
                        <button
                          onClick={() => setShowGroupPanel((v) => !v)}
                          className={[
                            "ml-auto flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                            showGroupPanel
                              ? "bg-slate-800 text-white shadow-sm"
                              : "bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-800",
                          ].join(" ")}
                          title="展开操作面板"
                        >
                          <ChevronDown className={["h-2.5 w-2.5 transition-transform", showGroupPanel ? "rotate-180" : ""].join(" ")} />
                          操作面板
                        </button>
                        <button
                          onClick={() => { onCheckChange?.(new Set()); lastCheckIdxRef.current = -1; setShowGroupPanel(false); }}
                          className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                          title="解散群组"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>

                        {/* 浮动操作面板 */}
                        {showGroupPanel && (
                          <div className="group-panel-dropdown absolute left-0 right-0 top-full z-[9999] mt-1 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                            {onRunCheckedLoop && (
                              <button
                                onClick={() => { setShowGroupPanel(false); onRunCheckedLoop(); }}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] font-medium text-slate-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
                              >
                                <Play className="h-3 w-3 text-indigo-500" />
                                自定义
                                <span className="ml-auto text-[9px] text-slate-400">配置新步骤</span>
                              </button>
                            )}
                            {onAdaptLoopToChecked && (
                              <button
                                onClick={() => { setShowGroupPanel(false); onAdaptLoopToChecked(); }}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] font-medium text-slate-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
                              >
                                <ListChecks className="h-3 w-3 text-indigo-500" />
                                适配已有循环
                                <span className="ml-auto text-[9px] text-slate-400">从已保存选择</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <RecordItem
                      record={r}
                      selected={r.record_id === selectedId}
                      onClick={() => onSelect(r.record_id)}
                      result={recordResults?.[r.record_id]}
                      batchResult={batchResults?.[r.record_id]}
                      onRun={onRunRecord ? () => onRunRecord(r.record_id) : undefined}
                      runDisabled={runDisabled}
                      running={runningRecordId === r.record_id}
                      onDropSkill={onDropSkill ? (skillId) => onDropSkill(skillId, r.record_id) : undefined}
                      checked={isChecked}
                      checkable={!!onCheckChange}
                      checkDisabled={!!cardLoopMap?.[r.record_id]}
                      isSaved={isSaved}
                      onCheck={(e) => { e.stopPropagation(); handleToggleCheck(idx, r.record_id); }}
                      draggable={!!onReorder}
                      isDragging={dragId === r.record_id || (!!dragLoopId && cardLoopMap?.[r.record_id]?.loopId === dragLoopId)}
                      isBatchDragging={!!dragLoopId && cardLoopMap?.[r.record_id]?.loopId === dragLoopId}
                      isDragOver={dragOverIdx === idx}
                      onDragStart={(e) => {
                        const info = cardLoopMap?.[r.record_id];
                        if (info) {
                          setDragLoopId(info.loopId);
                          setDragId(null);
                          e.dataTransfer.effectAllowed = "move";
                        } else {
                          setDragId(r.record_id);
                          setDragLoopId(null);
                          e.dataTransfer.effectAllowed = "move";
                        }
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        const targetInfo = cardLoopMap?.[r.record_id];
                        // 整批拖拽：不能拖到自身批次内部；单卡拖拽：不能拖到批次卡片上
                        if (dragLoopId) {
                          if (targetInfo?.loopId === dragLoopId) return; // 自身批次不响应
                          setDragOverIdx(idx);
                        } else if (dragId) {
                          if (targetInfo) return; // 单卡不能拖到批次上（不能拆分批）
                          // 也不能拖到批次之间（需确保前后都不是批次或同批次边界）
                          setDragOverIdx(idx);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!onReorder) { setDragId(null); setDragLoopId(null); setDragOverIdx(null); return; }

                        if (dragLoopId) {
                          // 整批拖拽：移动同 loopId 的所有卡片作为一个块
                          const batchIndices: number[] = [];
                          records.forEach((rec, i) => {
                            if (cardLoopMap?.[rec.record_id]?.loopId === dragLoopId) {
                              batchIndices.push(i);
                            }
                          });
                          if (batchIndices.length === 0) { setDragId(null); setDragLoopId(null); setDragOverIdx(null); return; }

                          // 计算目标插入位置（排除正在拖拽的批次自身后）
                          let insertIdx = idx;
                          const batchStart = batchIndices[0];
                          const batchEnd = batchIndices[batchIndices.length - 1];
                          // 如果目标在批次之后，需要调整（因为移除批次后索引会偏移）
                          if (insertIdx > batchEnd) {
                            insertIdx -= batchIndices.length;
                          }
                          // 如果目标在批次内部，不移动
                          if (insertIdx >= batchStart && insertIdx <= batchEnd) {
                            setDragId(null); setDragLoopId(null); setDragOverIdx(null); return;
                          }
                          // 不允许插入到其他批次内部：调整到最近的批次边界
                          const targetInfo = cardLoopMap?.[records[idx]?.record_id];
                          if (targetInfo && targetInfo.loopId !== dragLoopId) {
                            // 找到目标批次的起始位置
                            let targetBatchStart = idx;
                            while (targetBatchStart > 0 && cardLoopMap?.[records[targetBatchStart - 1]?.record_id]?.loopId === targetInfo.loopId) {
                              targetBatchStart--;
                            }
                            insertIdx = targetBatchStart;
                            // 重新计算移除批次后的偏移
                            if (insertIdx > batchEnd) {
                              insertIdx -= batchIndices.length;
                            }
                          }

                          // 构造新数组
                          const next = [...records];
                          const moved: ApplicantRecord[] = [];
                          // 从后往前移除，避免索引偏移
                          for (let i = batchIndices.length - 1; i >= 0; i--) {
                            moved.unshift(next.splice(batchIndices[i], 1)[0]);
                          }
                          // 插入到目标位置
                          next.splice(insertIdx, 0, ...moved);
                          onReorder(next);
                        } else if (dragId && dragId !== r.record_id) {
                          // 单卡拖拽：非批次卡片的移动
                          const fromIdx = records.findIndex((rr) => rr.record_id === dragId);
                          if (fromIdx < 0) { setDragId(null); setDragLoopId(null); setDragOverIdx(null); return; }
                          const fromInfo = cardLoopMap?.[records[fromIdx]?.record_id];
                          const targetInfo = cardLoopMap?.[r.record_id];
                          // 批次卡片不能单拖（已在dragStart中处理），非批次卡片不能拖入批次
                          if (fromInfo || targetInfo) {
                            setDragId(null); setDragLoopId(null); setDragOverIdx(null); return;
                          }
                          const next = [...records];
                          const [moved] = next.splice(fromIdx, 1);
                          let toIdx = idx;
                          if (fromIdx < idx) toIdx--;
                          next.splice(toIdx, 0, moved);
                          onReorder(next);
                        }
                        setDragId(null);
                        setDragLoopId(null);
                        setDragOverIdx(null);
                      }}
                      onDragEnd={() => { setDragId(null); setDragLoopId(null); setDragOverIdx(null); }}
                      loopInfo={cardLoopMap?.[r.record_id]}
                      onClearLoop={onClearCardLoop ? () => onClearCardLoop(r.record_id) : undefined}
                      cardImage={cardImages[r.record_id]}
                      onSetCardImage={onSetCardImage ? (dataUrl) => onSetCardImage(r.record_id, dataUrl) : undefined}
                      onClearCardImage={onClearCardImage ? () => onClearCardImage(r.record_id) : undefined}
                      getFieldValue={getFieldValue}
                      onRequestPickField={onFieldColumnMapChange ? (field) => handleRequestPickField(r.record_id, field) : undefined}
                      showPicker={pickingAnchorId === r.record_id && !!pickingField}
                      pickerField={pickingField}
                      availableColumns={pickingAnchorId === r.record_id && !!pickingField ? availableColumns : EMPTY_COLUMNS}
                      onPickColumn={handlePickColumn}
                      checkEpoch={checkedIds}
                      dragEpoch={`${dragId ?? ""}|${dragLoopId ?? ""}`}
                    />
                  </Fragment>
                );
              })}
            </ul>
          )}
        </div>

        {/* PERSONAL：换壁纸 / 控制面板不透明度 */}
        <button
          onClick={onOpenPersonal}
          className="mt-1.5 flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200/60 transition-colors hover:bg-slate-100 hover:text-slate-800"
          title="PERSONAL：换壁纸 / 控制面板不透明度"
        >
          <Palette className="h-3.5 w-3.5" />
          PERSONAL
        </button>
      </div>
      )}
    </div>
  );
}

function RecordItemInner({
  record,
  selected,
  onClick,
  result,
  batchResult,
  onRun,
  runDisabled = true,
  running = false,
  onDropSkill,
  checked = false,
  checkable = false,
  checkDisabled = false,
  isSaved = false,
  onCheck,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging = false,
  isDragOver = false,
  isBatchDragging = false,
  loopInfo,
  onClearLoop,
  cardImage,
  onSetCardImage,
  onClearCardImage,
  getFieldValue,
  onRequestPickField,
  showPicker = false,
  pickerField = null,
  availableColumns = [],
  onPickColumn,
}: {
  record: ApplicantRecord;
  selected: boolean;
  onClick: () => void;
  result?: Overall;
  batchResult?: BatchResult;
  /** 功能3：执行该记录的单卡 LOOP（自动导航到页面供人工审查） */
  onRun?: () => void;
  runDisabled?: boolean;
  running?: boolean;
  /** 接收 SKILL 拖放：(skillId) => void */
  onDropSkill?: (skillId: string) => void;
  /** 是否已勾选 */
  checked?: boolean;
  /** 是否可勾选 */
  checkable?: boolean;
  /** 是否禁止勾选（已保存到批次的卡片） */
  checkDisabled?: boolean;
  /** 是否已保存到批次（视觉区分） */
  isSaved?: boolean;
  /** 勾选回调 */
  onCheck?: (e: React.MouseEvent) => void;
  /** 拖拽排序：是否可拖拽 */
  draggable?: boolean;
  /** 拖拽排序：开始拖拽 */
  onDragStart?: (e: DragEvent) => void;
  /** 拖拽排序：拖拽经过 */
  onDragOver?: (e: DragEvent) => void;
  /** 拖拽排序：释放 */
  onDrop?: (e: DragEvent) => void;
  /** 拖拽排序：拖拽结束 */
  onDragEnd?: (e: DragEvent) => void;
  /** 拖拽排序：是否正被拖拽 */
  isDragging?: boolean;
  /** 拖拽排序：是否是拖拽悬停目标 */
  isDragOver?: boolean;
  /** 是否是整批拖拽中的一员（视觉高亮） */
  isBatchDragging?: boolean;
  /** 该卡片关联的 LOOP 信息（已设置 LOOP 的卡片显示标签） */
  loopInfo?: { loopId: string; loopName: string; setAt: number };
  /** 清除该卡片的 LOOP 关联 */
  onClearLoop?: () => void;
  /** 该卡片自定义图片（base64 dataURL），显示在卡片左侧渐隐 */
  cardImage?: string;
  /** 设置该卡片图片：(dataUrl) => void */
  onSetCardImage?: (dataUrl: string) => void;
  /** 清除该卡片图片：() => void */
  onClearCardImage?: () => void;
  /** 从 record 中取标准字段值（含手动映射） */
  getFieldValue?: (record: ApplicantRecord, field: "name" | "passport_no" | "student_id") => string;
  /** 请求为某字段打开列选择器：(field) => void */
  onRequestPickField?: (field: "name" | "passport_no" | "student_id") => void;
  /** 是否在该卡片下方显示列选择器 */
  showPicker?: boolean;
  /** 当前选列器针对哪个字段 */
  pickerField?: null | "name" | "passport_no" | "student_id";
  /** 所有可选列 */
  availableColumns?: { key: string; sample: string }[];
  /** 用户选完列后的回调 */
  onPickColumn?: (columnKey: string) => void;
  /** 渲染纪元（不渲染、仅参与 memo 比较）：勾选集引用——勾选变化时全量刷新内联闭包 */
  checkEpoch?: unknown;
  /** 渲染纪元：拖拽状态（dragId|dragLoopId）——拖拽开始/结束时全量刷新内联闭包 */
  dragEpoch?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [skillDragOver, setSkillDragOver] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) {
      itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected]);

  const passportNo = getFieldValue ? getFieldValue(record, "passport_no") : (record.fields.passport_no || "");
  // 学号：优先直接字段，其次手动映射列
  const studentId = getFieldValue
    ? getFieldValue(record, "student_id") || record.fields.student_no || record.fields.sid || record.fields.id || ""
    : (record.fields.student_id || record.fields.student_no || record.fields.sid || record.fields.id || "");
  // 上方主标题：严格只显示名字（优先直接字段，其次手动映射列）；学号在底部单独显示，这里不重复
  const displayName = getFieldValue ? getFieldValue(record, "name") : (record.fields.name || record.fields.fullname || "");
  // 副信息（横杠位置）：优先护照号
  const subInfo = passportNo || "";
  const hasPassport = record.has_passport;

  const PRIMARY_KEYS = new Set([
    "name", "fullname", "passport_no", "student_id", "student_no", "sid", "id",
    "email", "phone", "nationality", "birth_date",
    "university_url", "university_name",
  ]);
  const extraFields = Object.entries(record.fields).filter(
    ([k, v]) => !PRIMARY_KEYS.has(k) && v && v.trim()
  );

  const resultBg =
    result === "pass"
      ? "bg-emerald-50/70"
      : result === "fail"
      ? "bg-rose-50/70"
      : result === "review"
      ? "bg-amber-50/60"
      : "";

  const resultRing =
    result === "pass"
      ? "ring-1 ring-emerald-200"
      : result === "fail"
      ? "ring-1 ring-rose-200"
      : result === "review"
      ? "ring-1 ring-amber-200"
      : selected
      ? "ring-1 ring-brand-200"
      : "";

  const handleDragOver = (e: DragEvent) => {
    if (!onDropSkill) return;
    if (e.dataTransfer.types.includes(SKILL_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!skillDragOver) setSkillDragOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    if (!onDropSkill) return;
    const rect = itemRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      setSkillDragOver(false);
    }
  };

  const handleDrop = (e: DragEvent) => {
    if (!onDropSkill) return;
    const skillId = e.dataTransfer.getData(SKILL_DRAG_MIME);
    setSkillDragOver(false);
    if (skillId) {
      e.preventDefault();
      onDropSkill(skillId);
    }
  };

  const handleCardClick = () => {
    onClick();
  };

  // 卡片自定义图片：把图片文件读取为 base64 dataURL 并设置
  const setImageFromFile = (file: File) => {
    if (!file.type.startsWith("image/") || !onSetCardImage) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (dataUrl) onSetCardImage(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  // Ctrl+V 粘贴图片到卡片（设置卡片图片）
  const handlePasteImage = (e: React.ClipboardEvent) => {
    if (!onSetCardImage) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          e.stopPropagation();
          setImageFromFile(f);
          return;
        }
      }
    }
  };

  // 拖拽图片进卡片：设置卡片图片（区别于排序拖拽 / SKILL 拖放）
  const handleImageDrop = (e: DragEvent) => {
    if (!onSetCardImage) return false;
    const files = Array.from(e.dataTransfer.files || []);
    const img = files.find((f) => f.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      setImageFromFile(img);
      return true;
    }
    return false;
  };

  // 卡片排序拖拽：开始拖拽（设标记，与 SKILL 拖放区分）
  const handleSortDragStart = (e: DragEvent) => {
    if (!draggable) return;
    e.dataTransfer.setData("text/plain", record.record_id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart?.(e);
  };
  const handleSortDragOver = (e: DragEvent) => {
    if (!draggable) return;
    // 仅响应卡片排序拖拽（不响应 SKILL 拖放，SKILL 有自己的 MIME）
    if (e.dataTransfer.types.includes(SKILL_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOver?.(e);
  };
  const handleSortDrop = (e: DragEvent) => {
    if (!draggable) return;
    if (e.dataTransfer.types.includes(SKILL_DRAG_MIME)) return;
    e.preventDefault();
    onDrop?.(e);
  };
  const handleSortDragEnd = (e: DragEvent) => {
    if (!draggable) return;
    onDragEnd?.(e);
  };

  return (
    <li
      ref={itemRef}
      draggable={draggable}
      onDragStart={handleSortDragStart}
      onDragOver={(e) => { handleDragOver(e); handleSortDragOver(e); }}
      onDragLeave={handleDragLeave}
      onDrop={(e) => {
        if (handleImageDrop(e)) { setSkillDragOver(false); return; }
        handleSortDrop(e);
        handleDrop(e);
      }}
      onDragEnd={handleSortDragEnd}
      onPaste={handlePasteImage}
      // 百卡长列表：浏览器自动跳过屏幕外卡片的布局/绘制（DOM 保留、滚动即恢复，零交互差异）；
      // contain-intrinsic-size 给未渲染卡片一个占位高度，auto 前缀让渲染过的卡片记住真实高度
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
    >
      <div
        className={[
          "w-full rounded-lg transition-all border",
          isDragging || isBatchDragging
            ? "opacity-40 ring-2 ring-indigo-400 border-transparent"
            : isDragOver
            ? "ring-2 ring-indigo-400 bg-indigo-50/50 border-transparent"
            : skillDragOver
            ? "ring-2 ring-indigo-400 bg-indigo-50/70 shadow-md border-transparent"
            : running
            ? "ring-2 ring-indigo-400 bg-indigo-50/70 shadow-md animate-pulse border-transparent"
            : checked
            ? "ring-1 ring-indigo-300 bg-indigo-50/40 border-transparent"
            : result
            ? resultBg + " " + resultRing + " border-transparent"
            : selected
            ? "bg-brand-50 ring-1 ring-brand-200 border-transparent"
            : isSaved
            ? "bg-emerald-50/60 border-emerald-200/70 hover:bg-emerald-50"
            : onRun && !runDisabled
            ? "hover:bg-indigo-50/50 hover:ring-1 hover:ring-indigo-200 cursor-pointer border-transparent"
            : "hover:bg-slate-50 border-transparent",
        ].join(" ")}
      >
        {/* 主行：点击=选中+单卡导航到该人页面（TAB 行为） */}
        <button
          onClick={handleCardClick}
          className={[
            "w-full px-3 py-2 text-left",
            onRun && !runDisabled && !running ? "cursor-pointer" : "cursor-default",
          ].join(" ")}
          title={onRun && !runDisabled && !running ? "点击切换到该人页面（步骤2+3自动导航）" : undefined}
        >
          <div className="flex items-center gap-2.5">
            {/* 卡片自定义图片：左侧图片向右渐隐（Ctrl+V 粘贴或拖入图片设置；点击右上 × 移除） */}
            {cardImage ? (
              <div
                className="relative h-12 w-16 shrink-0 overflow-hidden rounded-l-lg"
                title="Ctrl+V 或拖入图片可更换卡片图片；点击右上角 × 移除"
              >
                <img
                  src={cardImage}
                  alt=""
                  draggable={false}
                  className="h-full w-full object-cover"
                  style={{
                    WebkitMaskImage: "linear-gradient(to right, black 0%, black 68%, transparent 100%)",
                    maskImage: "linear-gradient(to right, black 0%, black 68%, transparent 100%)",
                    WebkitMaskRepeat: "no-repeat",
                    maskRepeat: "no-repeat",
                  }}
                />
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClearCardImage?.(); }}
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900/60 text-white opacity-50 transition-opacity hover:bg-rose-600 hover:opacity-100"
                  title="移除卡片图片"
                >
                  <X className="h-2.5 w-2.5" />
                </span>
              </div>
            ) : null}
            {/* 拖拽手柄（长按拖拽调换位置；批次卡片整批拖拽） */}
            {draggable && (
              <span
                className={[
                  "flex h-4 w-3 shrink-0 items-center justify-center transition-colors active:cursor-grabbing",
                  loopInfo
                    ? "cursor-grab text-emerald-400 hover:text-emerald-600"
                    : "cursor-grab text-slate-300 hover:text-slate-500",
                ].join(" ")}
                title={loopInfo ? "整批拖拽（批次内卡片一起移动）" : "拖拽调换位置"}
              >
                <GripVertical className="h-3 w-3" />
              </span>
            )}
            {/* 勾选框 */}
            {checkable && (
              <button
                onClick={checkDisabled ? undefined : onCheck}
                className={[
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-all",
                  checkDisabled
                    ? "cursor-not-allowed border-slate-200 bg-slate-100 opacity-40"
                    : checked
                    ? "border-indigo-500 bg-indigo-500 text-white"
                    : "border-slate-300 bg-white hover:border-indigo-400",
                ].join(" ")}
                title={checkDisabled ? "已保存到批次，不可勾选" : checked ? "取消选择" : "点击选择（再点另一张卡选择范围）"}
              >
                {checked && !checkDisabled && <Check className="h-3 w-3" strokeWidth={3} />}
              </button>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                {displayName ? (
                  <span className="truncate text-sm font-medium text-slate-800">
                    {displayName}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestPickField?.("name");
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    title="点击选择姓名列"
                  >
                    <span className="italic">— 选择姓名列</span>
                  </button>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  {skillDragOver && (
                    <span className="flex items-center gap-0.5 rounded-full bg-indigo-500 px-1.5 py-0.5 text-[9px] font-medium text-white animate-pulse">
                      <Sparkles className="h-2.5 w-2.5" />
                      释放执行
                    </span>
                  )}
                  {result && !skillDragOver && (
                    <span
                      className={[
                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        result === "pass"
                          ? "bg-emerald-100 text-emerald-700"
                          : result === "fail"
                          ? "bg-rose-100 text-rose-700"
                          : "bg-amber-100 text-amber-700",
                      ].join(" ")}
                    >
                      {OVERALL_LABELS[result]}
                    </span>
                  )}
                  {batchResult && !skillDragOver && (
                    <BatchStatusBadge status={batchResult.status} />
                  )}
                  {hasPassport && !skillDragOver && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      护照
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-slate-500">
                {loopInfo ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onClearLoop?.();
                    }}
                    className="group inline-flex min-w-0 items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 transition-colors hover:bg-rose-100 hover:text-rose-600"
                    title={`${loopInfo.loopName}（点击移除 LOOP 关联）`}
                  >
                    <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
                    <span className="max-w-[120px] truncate">{loopInfo.loopName}</span>
                    <X className="h-2 w-2 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                  </span>
                ) : null}
                {subInfo ? (
                  <span className="truncate">{subInfo}</span>
                ) : record.fields.email ? (
                  <span className="truncate">{record.fields.email}</span>
                ) : loopInfo ? null : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestPickField?.("passport_no");
                    }}
                    className="truncate italic text-slate-400 hover:text-slate-600"
                    title="点击选择护照号列"
                  >
                    — 选择护照列
                  </button>
                )}
              </div>
            </div>
          </div>
        </button>

        {/* 列选择浮层：点击"— 选择XX列"时在此卡片下方展开 */}
        {showPicker && pickerField && (
          <div
            ref={undefined}
            className="border-t border-indigo-200 bg-indigo-50/60 px-2 py-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium text-indigo-700">
                选择作为{pickerField === "name" ? "姓名" : pickerField === "passport_no" ? "护照号" : "学号"}的列：
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-indigo-200 bg-white shadow-sm">
              {availableColumns.map((col) => (
                <button
                  key={col.key}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPickColumn?.(col.key);
                  }}
                  className="flex w-full items-center gap-2 border-b border-slate-100 px-2 py-1 text-left text-[11px] last:border-b-0 hover:bg-indigo-50"
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{col.key}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-slate-400" title={col.sample}>
                    {col.sample || <span className="italic text-slate-300">空</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 底部行：展开详情切换 + 学号 + 单卡 LOOP 运行按钮 */}
        <div className="flex w-full items-center justify-between border-t border-slate-200/50 px-3 py-1">
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="flex items-center gap-1 rounded text-[10px] text-slate-500 hover:text-slate-700"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {expanded ? "收起" : "详情"}
          </button>
          <div className="flex shrink-0 items-center gap-2">
            {studentId ? (
              <span className="font-mono text-[10px] text-slate-400">
                学号 {studentId}
              </span>
            ) : onRequestPickField ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestPickField("student_id");
                }}
                className="italic text-[10px] text-slate-400 hover:text-slate-600"
                title="点击选择学号列"
              >
                — 选择学号列
              </button>
            ) : (
              <span className="font-mono text-[10px] text-slate-400">无学号</span>
            )}
            {onRun && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRun();
                }}
                disabled={runDisabled || running}
                className="flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-600 transition-colors hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-40"
                title="查看：自动执行搜索+前置点击，定位到该人员的卡片页面"
              >
                {running ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Play className="h-2.5 w-2.5" />
                )}
                {running ? "查看中" : "查看"}
              </button>
            )}
          </div>
        </div>

        {/* 展开后显示学号、护照号等详细信息 */}
        {expanded && (
          <div className="space-y-1 px-3 pb-2 pt-1 text-[11px]">
            <DetailRow label="学号" value={studentId} mono />
            <DetailRow label="护照号" value={passportNo} mono />
            <DetailRow label="邮箱" value={record.fields.email} />
            <DetailRow label="电话" value={record.fields.phone} />
            <DetailRow label="国籍" value={record.fields.nationality} />
            <DetailRow label="出生日期" value={formatDateOnly(record.fields.birth_date)} />
            {extraFields.length > 0 && (
              <CollapsibleSection
                title="附加信息（来自其他 Sheet）"
                count={extraFields.length}
                defaultOpen={false}
              >
                {extraFields.map(([k, v]) => (
                  <DetailRow key={k} label={k} value={v} />
                ))}
              </CollapsibleSection>
            )}
            {record.passport_fields &&
              Object.keys(record.passport_fields).length > 0 && (
                <CollapsibleSection
                  title="护照 OCR"
                  count={Object.keys(record.passport_fields).length}
                  defaultOpen={false}
                >
                  {Object.entries(record.passport_fields).slice(0, 6).map(([k, v]) => (
                    <DetailRow key={k} label={k} value={v} />
                  ))}
                </CollapsibleSection>
              )}
          </div>
        )}
      </div>
    </li>
  );
}

/** 百卡长列表性能核心：memo 自定义比较——数据/视觉 prop 全比引用或值；
 *  函数 prop（onClick/onCheck/onDragOver 等内联闭包）每轮必变、一律不比，
 *  其捕获的可变外层值（checkedIds/dragId/dragLoopId）以 checkEpoch/dragEpoch 纪元参与比较：
 *  勾选或拖拽状态变化时全卡重渲染一次刷新闭包（稀有操作无感），
 *  LOOP 热路径（字段更新/选中切换/结果回写）只有受影响的 1~2 张卡重渲染。 */
const RecordItem = memo(RecordItemInner, (prev, next) => (
  prev.record === next.record
  && prev.selected === next.selected
  && prev.result === next.result
  && prev.batchResult === next.batchResult
  && prev.runDisabled === next.runDisabled
  && prev.running === next.running
  && prev.checked === next.checked
  && prev.checkable === next.checkable
  && prev.checkDisabled === next.checkDisabled
  && prev.isSaved === next.isSaved
  && prev.draggable === next.draggable
  && prev.isDragging === next.isDragging
  && prev.isDragOver === next.isDragOver
  && prev.isBatchDragging === next.isBatchDragging
  && prev.loopInfo === next.loopInfo
  && prev.cardImage === next.cardImage
  && prev.getFieldValue === next.getFieldValue
  && prev.showPicker === next.showPicker
  && prev.pickerField === next.pickerField
  && prev.availableColumns === next.availableColumns
  && prev.checkEpoch === next.checkEpoch
  && prev.dragEpoch === next.dragEpoch
));

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  const display = value && value.trim() ? value : "—";
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span
        className={[
          "min-w-0 truncate text-right text-slate-700",
          mono ? "font-mono" : "",
        ].join(" ")}
        title={display}
      >
        {display}
      </span>
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-1 border-t border-slate-200/40 pt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-1 py-0.5 text-left hover:bg-slate-100/40 rounded"
      >
        <span className="flex items-center gap-0.5 text-[10px] font-medium text-slate-500">
          {open ? (
            <ChevronDown className="h-2.5 w-2.5" />
          ) : (
            <ChevronRight className="h-2.5 w-2.5" />
          )}
          {title}
        </span>
        {typeof count === "number" && count > 0 && (
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-500">
            {count}
          </span>
        )}
      </button>
      {open && <div className="mt-0.5 space-y-1">{children}</div>}
    </div>
  );
}

function formatDateOnly(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const cut = s.split(/[\sT]/)[0];
  return cut || s;
}

function BatchStatusBadge({ status }: { status: BatchStatus }) {
  const config: Record<BatchStatus, { label: string; cls: string }> = {
    pending: { label: "待执行", cls: "bg-slate-100 text-slate-500" },
    // 执行中=无色系（中性灰），不靠颜色抢状态语义
    running: { label: "执行中", cls: "bg-slate-200 text-slate-600" },
    success: { label: "✓", cls: "bg-emerald-500 text-white" },
    review: { label: "!", cls: "bg-amber-500 text-white" },
    failed: { label: "✗", cls: "bg-rose-500 text-white" },
    skipped: { label: "跳过", cls: "bg-slate-100 text-slate-400" },
  };
  const c = config[status];
  return (
    <span
      className={[
        "inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold",
        c.cls,
      ].join(" ")}
      title={`批量执行：${c.label}`}
    >
      {status === "running" ? <Loader2 className="h-2 w-2 animate-spin" /> : c.label}
    </span>
  );
}
