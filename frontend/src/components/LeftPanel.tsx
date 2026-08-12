import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileSpreadsheet,
  GripVertical,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { ApplicantRecord, BatchResult, BatchStatus, Overall, VerificationStep } from "../types";
import { OVERALL_LABELS } from "../types";
import AISphere, { type AISphereState } from "./AISphere";
import ExecutionBubbles from "./ExecutionBubbles";

const SKILL_DRAG_MIME = "application/x-cinside-skill-id";

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
  /** 执行进度面板是否已打开（打开时隐藏气泡） */
  execPanelOpen?: boolean;
  /** 是否显示「执行进度」药丸按钮（气泡消散后、面板未开时） */
  execChipVisible?: boolean;
  /** 点击「执行进度」药丸按钮 */
  onOpenExecPanel?: () => void;
  /** 气泡全部消散回调（用于触发药丸按钮显现） */
  onExecBubblesGone?: () => void;
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
  onExecBubblesGone,
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

  return (
    <div className="panel-solid flex h-full flex-col gap-3 p-3">
      {/* AI 助手：黑白方格粒子球（无边框无文字，LOOP 运行/告警/讲解时形态变化）
          执行气泡融入球体：运行时步骤从球体下方吐出，消散后原地显现「执行进度」药丸 */}
      <div className="relative flex shrink-0 items-center justify-center py-1">
        <AISphere state={aiSphereState} size={132} />
        {!execPanelOpen && (
          <ExecutionBubbles
            variant="sphere"
            steps={execSteps}
            running={execRunning}
            onAllGone={onExecBubblesGone}
          />
        )}
        {execChipVisible && !execPanelOpen && (
          <button
            onClick={onOpenExecPanel}
            className="absolute -bottom-1 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-200 bg-white/90 px-2.5 py-1 text-[10px] font-medium text-slate-600 shadow-sm backdrop-blur-sm transition-all duration-300 animate-fade-in hover:bg-white hover:text-slate-800 hover:shadow"
            title="查看执行进度"
          >
            <Activity className="h-3 w-3 text-brand-600" />
            执行进度
          </button>
        )}
      </div>

      {/* 记录列表（无外框，直接融入面板） */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-700">申请人记录</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
              {records.length}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
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
                <span className="text-slate-400">·</span>
                <span className="text-slate-500">{loopIds.size} 个分组</span>
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
              <FileSpreadsheet className="h-7 w-7 text-slate-300" />
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
                    {/* 群组头部：展开按钮 + 范围信息 */}
                    {showGroupHeader && (
                      <div className="group-header-bar relative mb-1 flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50/80 px-2 py-1.5 shadow-sm">
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-indigo-700">
                          <Check className="h-3 w-3" strokeWidth={3} />
                          群组 {firstCheckedIdx + 1}–{lastCheckedIdx + 1}（{checkedIds!.size} 张）
                        </span>
                        <button
                          onClick={() => setShowGroupPanel((v) => !v)}
                          className={[
                            "ml-auto flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                            showGroupPanel
                              ? "bg-indigo-600 text-white"
                              : "bg-white text-indigo-600 ring-1 ring-indigo-200 hover:bg-indigo-100",
                          ].join(" ")}
                          title="展开操作面板"
                        >
                          <ChevronDown className={["h-2.5 w-2.5 transition-transform", showGroupPanel ? "rotate-180" : ""].join(" ")} />
                          操作面板
                        </button>
                        <button
                          onClick={() => { onCheckChange?.(new Set()); lastCheckIdxRef.current = -1; setShowGroupPanel(false); }}
                          className="rounded p-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-500"
                          title="解散群组"
                        >
                          <X className="h-3 w-3" />
                        </button>

                        {/* 浮动操作面板：自定义 / 适配已有循环 */}
                        {showGroupPanel && (
                          <div className="group-panel-dropdown absolute left-0 right-0 top-full z-[9999] mt-1 rounded-lg border border-slate-200 bg-white p-1.5 shadow-xl">
                            <div className="mb-1 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">选择执行方式</div>
                            {onRunCheckedLoop && (
                              <button
                                onClick={() => { setShowGroupPanel(false); onRunCheckedLoop(); }}
                                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-slate-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
                              >
                                <Play className="h-3 w-3 text-indigo-500" />
                                自定义
                                <span className="ml-auto text-[9px] text-slate-400">配置新步骤</span>
                              </button>
                            )}
                            {onAdaptLoopToChecked && (
                              <button
                                onClick={() => { setShowGroupPanel(false); onAdaptLoopToChecked(); }}
                                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-slate-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
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
                      availableColumns={availableColumns}
                      onPickColumn={handlePickColumn}
                    />
                  </Fragment>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function RecordItem({
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
