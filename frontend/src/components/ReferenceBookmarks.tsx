import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  FileText,
  Presentation,
  Image as ImageIcon,
  X,
  Tag,
  Sparkles,
  ListChecks,
  StickyNote,
  Trash2,
  UploadCloud,
  Eye,
  Plus,
  AtSign,
  Check,
  Palette,
  FolderOpen,
} from "lucide-react";
import type { PPTStyleProfile } from "../types";

// ─── 类型定义 ───────────────────────────────────────────────────

export type ReferenceTag = "reference" | "task" | "note";

export type ReferenceFileType = "ppt" | "pdf" | "image";

export interface ReferenceBookmark {
  id: string;
  file_name: string;
  file_path: string;
  file_type: ReferenceFileType;
  tag: ReferenceTag;
  description: string;
  created_at: number;
}

/** 拖拽落下、尚未打标签的文件 */
export interface PendingReferenceFile {
  file_name: string;
  file_path: string;
  file_type: ReferenceFileType;
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

export function fileIcon(type: ReferenceFileType) {
  if (type === "ppt") return Presentation;
  if (type === "pdf") return FileText;
  return ImageIcon;
}

export function fileTypeMeta(type: ReferenceFileType): { label: string; bg: string; fg: string } {
  if (type === "ppt") return { label: "PowerPoint", bg: "bg-orange-100", fg: "text-orange-600" };
  if (type === "pdf") return { label: "PDF", bg: "bg-rose-100", fg: "text-rose-600" };
  return { label: "图片", bg: "bg-emerald-100", fg: "text-emerald-600" };
}

export function detectFileType(fileName: string): ReferenceFileType {
  if (/\.pdf$/i.test(fileName)) return "pdf";
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName)) return "image";
  return "ppt";
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
            const typeMeta = fileTypeMeta(f.file_type);
            const draft = drafts[idx];
            const TagIcon = TAG_META[draft.tag].icon;
            return (
              <div
                key={f.file_path}
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${typeMeta.bg} ${typeMeta.fg}`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-slate-700">{f.file_name}</div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">
                      {typeMeta.label}
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
          支持 PPT / PPTX / PDF / 图片 · 添加后可标注是参考资料、任务要求还是备注
        </div>
      </div>
    </div>
  );
}

// ─── 组装给 AI 的参考上下文文本 ─────────────────────────────────

export function buildReferenceContext(bookmarks: ReferenceBookmark[]): string {
  if (bookmarks.length === 0) return "";
  const lines = bookmarks.map((b) => {
    const meta = TAG_META[b.tag];
    const typeLabel = b.file_type === "ppt" ? "PPT" : b.file_type === "pdf" ? "PDF" : "图片";
    return `- [${meta.label}]（${typeLabel}：${b.file_name}）${b.description}`;
  });
  return `【用户提供的参考文件与要求】\n${lines.join("\n")}\n（以上参考由用户拖入并标注，请在生成内容时遵循其中的要求与风格。）`;
}

// ─── 参考资料库弹窗：已保存的参考资料 + PPT 模板 ────────────────────

export function ReferenceLibraryModal({
  bookmarks,
  templates,
  activeTemplateName,
  onSelectTemplate,
  onRemove,
  onPreview,
  onInsertMention,
  onPickFiles,
  onClose,
}: {
  bookmarks: ReferenceBookmark[];
  templates: PPTStyleProfile[];
  activeTemplateName: string;
  onSelectTemplate: (name: string) => void;
  onRemove: (id: string) => void;
  onPreview?: (bookmark: ReferenceBookmark) => void;
  onInsertMention: (bookmark: ReferenceBookmark) => void;
  onPickFiles: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"refs" | "templates">("refs");

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[80vh] h-[520px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2 text-slate-800">
            <Bookmark className="h-4 w-4 text-brand-600" />
            <h2 className="text-sm font-semibold">参考资料库</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* tabs */}
        <div className="flex shrink-0 gap-1 border-b border-slate-100 px-4 pt-2">
          <button
            onClick={() => setTab("refs")}
            className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
              tab === "refs" ? "text-brand-700" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            参考资料
            <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] text-slate-500">
              {bookmarks.length}
            </span>
            {tab === "refs" && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-brand-600" />
            )}
          </button>
          <button
            onClick={() => setTab("templates")}
            className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
              tab === "templates" ? "text-brand-700" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Palette className="h-3.5 w-3.5" />
            PPT 模板
            <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] text-slate-500">
              {templates.length}
            </span>
            {tab === "templates" && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-brand-600" />
            )}
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "refs" ? (
            bookmarks.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                  <UploadCloud className="h-7 w-7" />
                </div>
                <p className="text-sm font-medium text-slate-600">还没有参考资料</p>
                <p className="mt-1 max-w-xs text-xs text-slate-400">
                  拖入 PPT/PDF 文件，或点击下方按钮添加。AI 生成时会参考其中的要求与风格。
                </p>
                <button
                  onClick={onPickFiles}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加参考文件
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {bookmarks.map((b) => {
                  const Icon = fileIcon(b.file_type);
                  const typeMeta = fileTypeMeta(b.file_type);
                  const meta = TAG_META[b.tag];
                  const TagIcon = meta.icon;
                  return (
                    <div
                      key={b.id}
                      className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 transition-colors hover:border-slate-300 hover:bg-white"
                    >
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${typeMeta.bg} ${typeMeta.fg}`}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-semibold text-slate-700">
                            {b.file_name}
                          </span>
                          <span
                            className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[10px] font-medium ${meta.chip}`}
                          >
                            <TagIcon className="h-2.5 w-2.5" />
                            {meta.label}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">
                          {b.description}
                        </p>
                        <div className="mt-2 flex items-center gap-1">
                          <button
                            onClick={() => onInsertMention(b)}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-brand-600 hover:bg-brand-50"
                            title="在输入框中 @ 引用此文件"
                          >
                            <AtSign className="h-3 w-3" />
                            引用
                          </button>
                          {onPreview && (
                            <button
                              onClick={() => onPreview(b)}
                              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                            >
                              <Eye className="h-3 w-3" />
                              预览
                            </button>
                          )}
                          <button
                            onClick={() => onRemove(b.id)}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-rose-400 hover:bg-rose-50 hover:text-rose-600"
                          >
                            <Trash2 className="h-3 w-3" />
                            移除
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <button
                  onClick={onPickFiles}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 py-2.5 text-xs font-medium text-slate-500 transition-colors hover:border-brand-400 hover:text-brand-600"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加更多参考文件
                </button>
              </div>
            )
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {/* AI 自动 */}
              <button
                onClick={() => onSelectTemplate("auto")}
                className={`flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-all ${
                  activeTemplateName === "auto"
                    ? "border-brand-400 bg-brand-50/50 ring-1 ring-brand-200"
                    : "border-slate-200 bg-slate-50/60 hover:border-slate-300 hover:bg-white"
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 text-white">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  {activeTemplateName === "auto" && (
                    <Check className="h-4 w-4 text-brand-600" />
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-700">AI 自动</div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                    根据主题自动挑选最合适的风格
                  </div>
                </div>
              </button>
              {templates.map((p) => {
                const active = activeTemplateName === p.name;
                return (
                  <button
                    key={p.name}
                    onClick={() => onSelectTemplate(p.name)}
                    className={`flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-all ${
                      active
                        ? "border-brand-400 bg-brand-50/50 ring-1 ring-brand-200"
                        : "border-slate-200 bg-slate-50/60 hover:border-slate-300 hover:bg-white"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="flex gap-0.5">
                        {p.palette.slice(0, 4).map(([accent], i) => (
                          <i
                            key={i}
                            className="h-3 w-3 rounded-full ring-1 ring-black/5"
                            style={{ background: accent }}
                          />
                        ))}
                      </span>
                      {active && <Check className="h-4 w-4 text-brand-600" />}
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-700">
                        {p.display_name}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-slate-400">
                        {p.style_notes}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
