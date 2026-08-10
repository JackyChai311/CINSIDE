import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  FileText,
  Presentation,
  X,
  Tag,
  Sparkles,
  ListChecks,
  StickyNote,
  Trash2,
  ChevronRight,
  UploadCloud,
} from "lucide-react";

// ─── 类型定义 ───────────────────────────────────────────────────

export type ReferenceTag = "reference" | "task" | "note";

export interface ReferenceBookmark {
  id: string;
  file_name: string;
  file_path: string;
  file_type: "ppt" | "pdf";
  tag: ReferenceTag;
  description: string;
  created_at: number;
}

/** 拖拽落下、尚未打标签的文件 */
export interface PendingReferenceFile {
  file_name: string;
  file_path: string;
  file_type: "ppt" | "pdf";
  size: number;
}

// ─── 标签配置 ───────────────────────────────────────────────────

export const TAG_META: Record<
  ReferenceTag,
  { label: string; icon: typeof Tag; dot: string; chip: string; accent: string }
> = {
  reference: {
    label: "参考资料",
    icon: Sparkles,
    dot: "bg-sky-500",
    chip: "bg-sky-50 text-sky-700 border-sky-200",
    accent: "text-sky-600",
  },
  task: {
    label: "任务要求",
    icon: ListChecks,
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    accent: "text-amber-600",
  },
  note: {
    label: "备注说明",
    icon: StickyNote,
    dot: "bg-slate-400",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    accent: "text-slate-500",
  },
};

function fileIcon(type: "ppt" | "pdf") {
  return type === "ppt" ? Presentation : FileText;
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

// ─── 打标签弹窗 ─────────────────────────────────────────────────

interface DraftItem {
  tag: ReferenceTag;
  description: string;
}

export function ReferenceLabelModal({
  files,
  onConfirm,
  onCancel,
}: {
  files: PendingReferenceFile[];
  onConfirm: (bookmarks: ReferenceBookmark[]) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftItem[]>(() =>
    files.map(() => ({ tag: "reference" as ReferenceTag, description: "" }))
  );
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    textareaRefs.current[0]?.focus();
  }, []);

  const canConfirm = drafts.every((d) => d.description.trim().length > 0);

  const updateDraft = (idx: number, patch: Partial<DraftItem>) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const handleConfirm = () => {
    if (!canConfirm) return;
    const now = Date.now();
    const bookmarks: ReferenceBookmark[] = files.map((f, i) => ({
      id: `ref_${now}_${i}_${Math.random().toString(36).slice(2, 7)}`,
      file_name: f.file_name,
      file_path: f.file_path,
      file_type: f.file_type,
      tag: drafts[i].tag,
      description: drafts[i].description.trim(),
      created_at: now + i,
    }));
    onConfirm(bookmarks);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onMouseDown={onCancel}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2 text-slate-800">
            <Bookmark className="h-4 w-4 text-brand-600" />
            <h2 className="text-sm font-semibold">给参考文件打标签</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
              {files.length} 个文件
            </span>
          </div>
          <button
            onClick={onCancel}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="shrink-0 px-5 pt-3 text-[11px] leading-relaxed text-slate-400">
          告诉 AI 这些文件是什么：是<Tag className="inline h-3 w-3 text-sky-500" />参考资料、<ListChecks className="inline h-3 w-3 text-amber-500" />任务要求，还是<StickyNote className="inline h-3 w-3 text-slate-400" />备注说明。写好后它们会挂在屏幕左侧，AI 随时可以回来参考。
        </p>

        {/* body */}
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {files.map((f, idx) => {
            const Icon = fileIcon(f.file_type);
            const draft = drafts[idx];
            const TagIcon = TAG_META[draft.tag].icon;
            return (
              <div
                key={f.file_path}
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      f.file_type === "ppt"
                        ? "bg-orange-100 text-orange-600"
                        : "bg-rose-100 text-rose-600"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-slate-700">{f.file_name}</div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">
                      {f.file_type === "ppt" ? "PowerPoint" : "PDF"}
                      {f.size ? ` · ${formatSize(f.size)}` : ""}
                    </div>
                  </div>
                </div>

                {/* 标签选择 */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {(Object.keys(TAG_META) as ReferenceTag[]).map((t) => {
                    const meta = TAG_META[t];
                    const TIcon = meta.icon;
                    const active = draft.tag === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => updateDraft(idx, { tag: t })}
                        className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-all ${
                          active
                            ? meta.chip + " ring-1 ring-current/20"
                            : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        <TIcon className="h-3 w-3" />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>

                {/* 描述输入 */}
                <textarea
                  ref={(el) => { textareaRefs.current[idx] = el; }}
                  value={draft.description}
                  onChange={(e) => updateDraft(idx, { description: e.target.value })}
                  rows={2}
                  placeholder={
                    draft.tag === "reference"
                      ? "例如：这是去年的获奖课件，风格和排版可以参考…"
                      : draft.tag === "task"
                        ? "例如：按这份教案的教学环节重新组织章节…"
                        : "例如：配色用校徽蓝，字体保持宋体…"
                  }
                  className="w-full resize-none rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 placeholder:text-slate-300 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleConfirm();
                    }
                  }}
                />
                <div className="mt-1 flex items-center gap-1 text-[10px]" style={{ color: "var(--brand-600)" }}>
                  <TagIcon className="h-2.5 w-2.5" />
                  <span>{draft.description.trim() ? "已记录" : "需要填写说明"}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Bookmark className="h-3 w-3" />
            添加到参考栏
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 拖拽遮罩 ───────────────────────────────────────────────────

export function ReferenceDropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-10">
      <div className="absolute inset-0 bg-brand-600/5 backdrop-blur-[2px]" />
      <div className="relative flex w-full max-w-2xl flex-col items-center justify-center rounded-3xl border-2 border-dashed border-brand-400/70 bg-white/70 py-16 text-center shadow-xl">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-100 text-brand-600">
          <UploadCloud className="h-8 w-8" />
        </div>
        <div className="text-base font-semibold text-slate-800">松开以添加为参考文件</div>
        <div className="mt-1 text-xs text-slate-500">
          支持 PPT / PPTX / PDF · 添加后可标注是参考资料、任务要求还是备注
        </div>
      </div>
    </div>
  );
}

// ─── 左侧书签栏 ─────────────────────────────────────────────────

export function ReferenceRail({
  bookmarks,
  onRemove,
  onPickFiles,
}: {
  bookmarks: ReferenceBookmark[];
  onRemove: (id: string) => void;
  onPickFiles: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // 点击外部收起展开的卡片
  useEffect(() => {
    if (!expandedId) return;
    const onDown = (e: MouseEvent) => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        setExpandedId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedId(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [expandedId]);

  const expanded = useMemo(
    () => bookmarks.find((b) => b.id === expandedId) || null,
    [bookmarks, expandedId]
  );

  if (bookmarks.length === 0) return null;

  return (
    <div
      ref={railRef}
      className="pointer-events-none fixed bottom-0 left-0 top-0 z-30 flex items-start"
      style={{ paddingTop: 76 }}
    >
      {/* 竖条 */}
      <div className="pointer-events-auto flex h-full flex-col items-center gap-1.5 border-r border-white/40 bg-white/55 py-3 backdrop-blur-md"
        style={{ width: 44 }}
      >
        <div
          className="mb-1 flex h-7 w-7 items-center justify-center rounded-lg text-brand-600"
          title="参考资料栏"
        >
          <Bookmark className="h-4 w-4" />
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-1.5 flex flex-col items-center gap-1.5 w-full ref-rail-scroll">
          {bookmarks.map((b) => {
            const Icon = fileIcon(b.file_type);
            const meta = TAG_META[b.tag];
            const isExpanded = b.id === expandedId;
            return (
              <button
                key={b.id}
                onClick={() => setExpandedId(isExpanded ? null : b.id)}
                title={`${meta.label} · ${b.file_name}`}
                className={`group relative flex h-8 w-8 items-center justify-center rounded-lg transition-all ${
                  isExpanded
                    ? "bg-white text-brand-700 shadow-sm ring-1 ring-brand-200"
                    : "text-slate-500 hover:bg-white/80 hover:text-slate-700"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span
                  className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-white ${meta.dot}`}
                />
              </button>
            );
          })}
        </div>

        <button
          onClick={onPickFiles}
          title="添加参考文件"
          className="pointer-events-auto mb-1 flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-white hover:text-brand-600 transition-colors"
        >
          <ChevronRight className="h-4 w-4 rotate-90" />
        </button>
      </div>

      {/* 展开卡片 */}
      {expanded && (
        <div
          className="pointer-events-auto absolute left-11 top-20 w-72 animate-ref-card-in rounded-2xl border border-slate-200 bg-white/95 p-3.5 shadow-xl backdrop-blur-md"
          style={{ maxHeight: "calc(100vh - 120px)" }}
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  expanded.file_type === "ppt"
                    ? "bg-orange-100 text-orange-600"
                    : "bg-rose-100 text-rose-600"
                }`}
              >
                {(() => {
                  const Icon = fileIcon(expanded.file_type);
                  return <Icon className="h-4 w-4" />;
                })()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-slate-800">{expanded.file_name}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-400">
                  {expanded.file_type === "ppt" ? "PowerPoint" : "PDF"}
                </div>
              </div>
            </div>
            <button
              onClick={() => setExpandedId(null)}
              className="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mb-2 flex items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                TAG_META[expanded.tag].chip
              }`}
            >
              {(() => {
                const TIcon = TAG_META[expanded.tag].icon;
                return <TIcon className="h-2.5 w-2.5" />;
              })()}
              {TAG_META[expanded.tag].label}
            </span>
            <span className="text-[10px] text-slate-300">{formatTime(expanded.created_at)}</span>
          </div>

          <p className="mb-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-600">
            {expanded.description}
          </p>

          <div className="flex items-center justify-between border-t border-slate-100 pt-2">
            <span
              className="truncate text-[10px] text-slate-300"
              title={expanded.file_path}
            >
              📁 {expanded.file_path}
            </span>
            <button
              onClick={() => {
                onRemove(expanded.id);
                setExpandedId(null);
              }}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-rose-400 hover:bg-rose-50 hover:text-rose-600"
              title="移除这个参考"
            >
              <Trash2 className="h-3 w-3" />
              移除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 组装给 AI 的参考上下文文本 ─────────────────────────────────

export function buildReferenceContext(bookmarks: ReferenceBookmark[]): string {
  if (bookmarks.length === 0) return "";
  const lines = bookmarks.map((b) => {
    const meta = TAG_META[b.tag];
    const typeLabel = b.file_type === "ppt" ? "PPT" : "PDF";
    return `- [${meta.label}]（${typeLabel}：${b.file_name}）${b.description}`;
  });
  return `【用户提供的参考文件与要求】\n${lines.join("\n")}\n（以上参考由用户拖入并标注，请在生成内容时遵循其中的要求与风格。）`;
}
