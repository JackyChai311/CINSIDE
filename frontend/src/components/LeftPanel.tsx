import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "../api/client";
import type { ApplicantRecord, BatchResult, BatchStatus, Overall } from "../types";
import { OVERALL_LABELS } from "../types";

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
}: Props) {
  const [uploading, setUploading] = useState<UploadKind>(null);
  const [excelDrag, setExcelDrag] = useState(false);
  const [passportDrag, setPassportDrag] = useState(false);
  const [docDrag, setDocDrag] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputExcel = useRef<HTMLInputElement>(null);
  const fileInputPassport = useRef<HTMLInputElement>(null);
  const fileInputDoc = useRef<HTMLInputElement>(null);

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

        <div className="min-h-0 flex-1 overflow-auto p-1.5">
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
              {records.map((r) => (
                <RecordItem
                  key={r.record_id}
                  record={r}
                  selected={r.record_id === selectedId}
                  onClick={() => onSelect(r.record_id)}
                  result={recordResults?.[r.record_id]}
                  batchResult={batchResults?.[r.record_id]}
                  onRun={onRunRecord ? () => onRunRecord(r.record_id) : undefined}
                  runDisabled={runDisabled}
                  running={runningRecordId === r.record_id}
                />
              ))}
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
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
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
}) {
  const [expanded, setExpanded] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);

  // LOOP 批量执行时当前卡片会被程序选中，自动滚动进视野让用户看清执行位置
  useEffect(() => {
    if (selected) {
      itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected]);

  const name = record.fields.name || record.fields.fullname || record.record_id;
  const passportNo = record.fields.passport_no || "";
  const studentId =
    record.fields.student_id ||
    record.fields.student_no ||
    record.fields.sid ||
    record.fields.id ||
    "";
  const hasPassport = record.has_passport;
  const avatar = record.avatar;

  // 主字段集合：这些已经单独展示，附加信息区域跳过它们
  const PRIMARY_KEYS = new Set([
    "name", "fullname", "passport_no", "student_id", "student_no", "sid", "id",
    "email", "phone", "nationality", "birth_date",
    "university_url", "university_name",
  ]);
  // 计算其他 sheet 合并进来的附加字段（包括带 sheet 前缀的）
  const extraFields = Object.entries(record.fields).filter(
    ([k, v]) => !PRIMARY_KEYS.has(k) && v && v.trim()
  );

  // 根据核验结果决定背景色
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

  return (
    <li ref={itemRef}>
      <div
        className={[
          "w-full rounded-lg transition-all",
          resultBg,
          result
            ? resultRing
            : selected
            ? "bg-brand-50 ring-1 ring-brand-200"
            : "hover:bg-slate-50",
        ].join(" ")}
      >
        {/* 主行：点击选中记录 */}
        <button
          onClick={onClick}
          className="w-full px-3 py-2 text-left"
        >
          <div className="flex items-center gap-2.5">
            {/* 头像 */}
            {avatar ? (
              <img
                src={`data:image/png;base64,${avatar}`}
                alt={name}
                className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-medium text-slate-400 ring-1 ring-slate-200">
                {name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-slate-800">
                  {name}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {result && (
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
                  {batchResult && (
                    <BatchStatusBadge status={batchResult.status} />
                  )}
                  {hasPassport && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      护照
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-slate-400">
                    {record.record_id}
                  </span>
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
            onClick={() => setExpanded((v) => !v)}
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
                title="单卡 LOOP：自动执行该记录的步骤，导航到页面供人工审查（跳过比对/提交）"
              >
                {running ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Play className="h-2.5 w-2.5" />
                )}
                {running ? "执行中" : "LOOP"}
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
            {/* 其他 sheet 合并进来的附加字段（可折叠） */}
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

/** 可折叠的小节：点击标题切换展开/收起 */
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

/** 把可能含时间的日期字符串截成只保留 YYYY-MM-DD 部分 */
function formatDateOnly(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // 匹配 YYYY-MM-DD 或 YYYY/MM/DD（开头）
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // 其它情况：取第一个空格 / T 之前的部分
  const cut = s.split(/[\sT]/)[0];
  return cut || s;
}

// ============ 批量执行状态徽章 ============
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


