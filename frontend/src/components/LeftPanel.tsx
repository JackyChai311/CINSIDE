import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  GripVertical,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "../api/client";
import type { ApplicantRecord, BatchResult, BatchStatus, Overall } from "../types";
import { OVERALL_LABELS } from "../types";

const SKILL_DRAG_MIME = "application/x-cinside-skill-id";

interface Props {
  records: ApplicantRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
  onClear: () => Promise<void>;
  onDetach?: () => void;
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
  /** 功能2：从本地文件库选择文档（图片/PDF）提取并填入右侧网页 */
  onPickDocument?: (file: File) => void;
  /** 文档提取进行中 */
  docExtracting?: boolean;
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
}

type UploadKind = "excel" | "passport" | "document" | null;

export default function LeftPanel({
  records,
  selectedId,
  onSelect,
  onRefresh,
  onClear,
  onDetach,
  recordResults,
  batchResults,
  onRunRecord,
  runDisabled = true,
  runningRecordId = null,
  onPickDocument,
  docExtracting = false,
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
}: Props) {
  const [uploading, setUploading] = useState<UploadKind>(null);
  const [excelDrag, setExcelDrag] = useState(false);
  const [passportDrag, setPassportDrag] = useState(false);
  const [docDrag, setDocDrag] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputExcel = useRef<HTMLInputElement>(null);
  const fileInputPassport = useRef<HTMLInputElement>(null);
  const fileInputDoc = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const handleExcel = useCallback(
    async (file: File) => {
      setUploading("excel");
      try {
        const r = await api.uploadExcel(file);
        setToast(`已导入 ${r.count} 条记录`);
        await onRefresh();
      } catch (e: any) {
        setToast(`导入失败: ${e.message}`);
      } finally {
        setUploading(null);
      }
    },
    [onRefresh]
  );

  const handlePassport = useCallback(
    async (file: File) => {
      if (!selectedId) {
        setToast("请先在下方选择一条记录");
        return;
      }
      setUploading("passport");
      try {
        const r = await api.uploadPassport(selectedId, file);
        setToast(
          Object.keys(r.fields || {}).length > 0
            ? `护照识别成功：${Object.keys(r.fields).length} 个字段`
            : "护照识别未返回字段（可能未配置 Vision API）"
        );
        await onRefresh();
      } catch (e: any) {
        setToast(`护照上传失败: ${e.message}`);
      } finally {
        setUploading(null);
      }
    },
    [selectedId, onRefresh]
  );

  return (
    <div className="panel-solid flex h-full flex-col gap-3 p-3">
      {/* 数据源 */}
      <div className="grid grid-cols-1 gap-2">
        <SourceCard
          title="Excel / CSV"
          icon={<FileSpreadsheet className="h-4 w-4" />}
          desc="上传申请人结构化数据"
          dragging={excelDrag}
          uploading={uploading === "excel"}
          onPick={() => fileInputExcel.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setExcelDrag(true);
          }}
          onDragLeave={() => setExcelDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setExcelDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleExcel(f);
          }}
        />
        <SourceCard
          title="护照图片"
          icon={<ImageIcon className="h-4 w-4" />}
          desc={selectedId ? `为当前记录上传` : "先选择一条记录"}
          dragging={passportDrag}
          uploading={uploading === "passport"}
          disabled={!selectedId}
          onPick={() => fileInputPassport.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setPassportDrag(true);
          }}
          onDragLeave={() => setPassportDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setPassportDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handlePassport(f);
          }}
        />
        {onPickDocument && (
          <SourceCard
            title="文档提取"
            icon={<FileText className="h-4 w-4" />}
            desc="图片/PDF → OCR → 审核后填入右侧网页"
            dragging={docDrag}
            uploading={docExtracting}
            onPick={() => fileInputDoc.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDocDrag(true);
            }}
            onDragLeave={() => setDocDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDocDrag(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onPickDocument(f);
            }}
          />
        )}
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 text-[10px] text-slate-500">
          <Database className="h-3 w-3 shrink-0 text-slate-400" />
          <span>数据库网页请在左侧浏览器输入 URL</span>
        </div>
      </div>

      <input
        ref={fileInputExcel}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleExcel(f);
          e.target.value = "";
        }}
      />
      <input
        ref={fileInputPassport}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handlePassport(f);
          e.target.value = "";
        }}
      />
      <input
        ref={fileInputDoc}
        type="file"
        accept="image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && onPickDocument) onPickDocument(f);
          e.target.value = "";
        }}
      />

      {/* 记录列表 */}
      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200 bg-white">
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
                      <div className="relative mb-1 flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50/80 px-2 py-1.5 shadow-sm">
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
                          <div className="absolute left-0 right-0 top-full z-[9999] mt-1 rounded-lg border border-slate-200 bg-white p-1.5 shadow-xl">
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
                    />
                  </Fragment>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div className="animate-fade-in pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900/90 px-3 py-1.5 text-[11px] text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function SourceCard(props: {
  title: string;
  icon: React.ReactNode;
  desc: string;
  dragging: boolean;
  uploading: boolean;
  disabled?: boolean;
  onPick: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  return (
    <button
      onClick={props.onPick}
      disabled={props.disabled || props.uploading}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      className={[
        "group flex items-center gap-2.5 rounded-lg border-2 border-dashed p-2 text-left transition-all",
        props.disabled
          ? "cursor-not-allowed border-slate-100 bg-slate-50/50 opacity-60"
          : "cursor-pointer hover:border-brand-400 hover:bg-brand-50/40",
        props.dragging ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-white",
      ].join(" ")}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
        {props.uploading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          props.icon
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-slate-800">{props.title}</div>
        <div className="truncate text-[10px] text-slate-500">{props.desc}</div>
      </div>
      {!props.disabled && !props.uploading && (
        <Upload className="h-3.5 w-3.5 text-slate-400 transition-colors group-hover:text-brand-500" />
      )}
    </button>
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
}) {
  const [expanded, setExpanded] = useState(false);
  const [skillDragOver, setSkillDragOver] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) {
      itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected]);

  const passportNo = record.fields.passport_no || "";
  const studentId =
    record.fields.student_id ||
    record.fields.student_no ||
    record.fields.sid ||
    record.fields.id ||
    "";
  const name = record.fields.name || record.fields.fullname || passportNo || studentId || record.fields.email || "";
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
      onDrop={(e) => { handleSortDrop(e); handleDrop(e); }}
      onDragEnd={handleSortDragEnd}
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
                <span className="truncate text-sm font-medium text-slate-800">
                  {name}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {skillDragOver && (
                    <span className="flex items-center gap-0.5 rounded-full bg-indigo-500 px-1.5 py-0.5 text-[9px] font-medium text-white animate-pulse">
                      <Sparkles className="h-2.5 w-2.5" />
                      释放执行
                    </span>
                  )}
                  {loopInfo && !skillDragOver && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        onClearLoop?.();
                      }}
                      className="group flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 transition-colors hover:bg-rose-100 hover:text-rose-600"
                      title={`${loopInfo.loopName}（点击移除 LOOP 关联）`}
                    >
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      <span className="max-w-[60px] truncate">{loopInfo.loopName}</span>
                      <X className="h-2 w-2 opacity-0 transition-opacity group-hover:opacity-100" />
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
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {passportNo || record.fields.email || "—"}
              </div>
            </div>
          </div>
        </button>

        {/* 底部行：展开详情切换 + 单卡 LOOP 运行按钮 */}
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
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-slate-400">
              {studentId ? `学号 ${studentId}` : "无学号"}
            </span>
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
    running: { label: "执行中", cls: "bg-blue-100 text-blue-700 animate-glow-pulse" },
    success: { label: "✓", cls: "bg-emerald-500 text-white" },
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
