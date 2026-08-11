import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  Sparkles,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Check,
  RefreshCw,
  FileText,
  GripVertical,
  X,
  ChevronDown as ChevronDownIcon,
  Image as ImageIcon,
} from "lucide-react";
import { api } from "../api/client";
import type { PPTOutlineSlide } from "../types";

type Phase = "streaming" | "editing" | "error";

export function OutlineBoard({
  text,
  onConfirm,
  onRegenerate,
  onCancel,
}: {
  text: string;
  onConfirm: (slides: PPTOutlineSlide[], addBackground: boolean) => void;
  onRegenerate: () => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("streaming");
  const [rawTokens, setRawTokens] = useState("");
  const [error, setError] = useState("");
  const [slides, setSlides] = useState<PPTOutlineSlide[]>([]);
  const [addBackground, setAddBackground] = useState(false);
  const [recommendedStyle, setRecommendedStyle] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const streamEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase("streaming");
    setRawTokens("");
    setError("");

    api
      .pptDraftOutlineStream(text, (ev) => {
        if (cancelled) return;
        if (ev.type === "token") {
          setRawTokens((prev) => prev + ev.text);
        } else if (ev.type === "done") {
          setSlides(ev.slides);
          setRecommendedStyle(ev.style);
          setPhase("editing");
        } else if (ev.type === "error") {
          setError(ev.message);
          setPhase("error");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "大纲生成失败");
          setPhase("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [text]);

  // 流式输出时自动滚动到底部
  useEffect(() => {
    if (phase === "streaming" && showRaw) {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [rawTokens, phase, showRaw]);

  // ── 编辑操作 ──
  const updateSlide = (idx: number, patch: Partial<PPTOutlineSlide>) => {
    setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const updateBullet = (si: number, bi: number, val: string) => {
    setSlides((prev) =>
      prev.map((s, i) => {
        if (i !== si) return s;
        const bullets = [...s.bullets];
        bullets[bi] = val;
        return { ...s, bullets };
      })
    );
  };

  const addBullet = (si: number) => {
    setSlides((prev) =>
      prev.map((s, i) => (i === si ? { ...s, bullets: [...s.bullets, ""] } : s))
    );
  };

  const removeBullet = (si: number, bi: number) => {
    setSlides((prev) =>
      prev.map((s, i) =>
        i === si ? { ...s, bullets: s.bullets.filter((_, j) => j !== bi) } : s
      )
    );
  };

  const addSlide = (afterIdx: number) => {
    setSlides((prev) => {
      const next = [...prev];
      next.splice(afterIdx + 1, 0, {
        section: prev[afterIdx]?.section || "",
        title: "",
        summary: "",
        bullets: [""],
        image_prompt: "",
      });
      return next;
    });
  };

  const removeSlide = (idx: number) => {
    setSlides((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveSlide = (idx: number, dir: -1 | 1) => {
    setSlides((prev) => {
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  // 按 section 分组
  const sections: { name: string; indices: number[] }[] = [];
  slides.forEach((s, i) => {
    const name = s.section || "（封面）";
    let group = sections.find((g) => g.name === name);
    if (!group) {
      group = { name, indices: [] };
      sections.push(group);
    }
    group.indices.push(i);
  });

  const validCount = slides.filter((s) => s.title.trim()).length;

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white/90 shadow-sm overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-700/50 px-4 py-3 bg-gradient-to-r from-violet-50/50 to-purple-50/30 dark:from-slate-800/50 dark:to-slate-800/30">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center">
            {phase === "streaming" ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-800 dark:text-slate-100" />
            ) : (
              <FileText className="h-4 w-4 text-slate-800 dark:text-slate-100" />
            )}
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-700">
              {phase === "streaming" ? "AI 正在构思大纲…" : phase === "error" ? "生成失败" : "大纲草稿"}
            </div>
            {phase === "editing" && (
              <div className="text-[10px] text-slate-400">
                可直接修改每页内容，确认后开始生成 PPT
              </div>
            )}
          </div>
        </div>
        {phase === "editing" && recommendedStyle && (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-100/80 px-2 py-0.5 text-[10px] font-medium text-violet-600">
            <Sparkles className="h-2.5 w-2.5" />
            {recommendedStyle}
          </span>
        )}
      </div>

      {/* body */}
      <div className="max-h-[55vh] overflow-y-auto p-4">
        {phase === "streaming" && (
          <div>
            {/* 简洁的写入动画 */}
            <div className="flex items-center gap-2.5 mb-3">
              <div className="flex gap-1">
                <span className="h-2 w-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="h-2 w-2 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="h-2 w-2 rounded-full bg-fuchsia-400 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-xs text-slate-400">正在组织章节、拟定标题和要点…</span>
            </div>

            {/* 可折叠的原始输出 */}
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-600 transition-colors mb-2"
            >
              <ChevronDownIcon
                className={`h-3 w-3 transition-transform ${showRaw ? "" : "-rotate-90"}`}
              />
              查看 AI 写入过程
            </button>
            {showRaw && (
              <div className="rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed font-mono text-emerald-300/90 max-h-48 overflow-auto whitespace-pre-wrap break-all">
                {rawTokens}
                <span className="inline-block w-1.5 h-3.5 bg-emerald-400 ml-0.5 animate-pulse align-middle" />
                <div ref={streamEndRef} />
              </div>
            )}
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col items-center py-6 gap-3">
            <p className="text-sm text-rose-500">{error}</p>
            <button
              onClick={onRegenerate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </button>
          </div>
        )}

        {phase === "editing" && (
          <div className="space-y-4">
            {sections.map((group) => (
              <div key={group.name}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                  <span className="text-[11px] font-bold tracking-wide text-violet-700 uppercase">
                    {group.name}
                  </span>
                  <span className="text-[10px] text-slate-400">{group.indices.length} 页</span>
                  <div className="h-px flex-1 bg-slate-100" />
                </div>

                <div className="space-y-2">
                  {group.indices.map((si) => {
                    const slide = slides[si];
                    return (
                      <div
                        key={si}
                        className="group rounded-xl border border-slate-200 bg-slate-50/50 p-3 transition-colors hover:border-slate-300 hover:bg-white"
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex flex-col items-center gap-1 pt-0.5">
                            <GripVertical className="h-3 w-3 text-slate-300" />
                            <span className="flex h-5 w-5 items-center justify-center rounded bg-violet-100 text-[10px] font-bold text-violet-700">
                              {si + 1}
                            </span>
                          </div>

                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <input
                                value={slide.section}
                                onChange={(e) => updateSlide(si, { section: e.target.value })}
                                placeholder="章节"
                                className="w-20 shrink-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] font-medium text-slate-500 hover:border-slate-200 focus:border-violet-400 focus:bg-white focus:outline-none"
                              />
                              <input
                                value={slide.title}
                                onChange={(e) => updateSlide(si, { title: e.target.value })}
                                placeholder="页面标题"
                                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold text-slate-800 hover:border-slate-200 focus:border-violet-400 focus:bg-white focus:outline-none"
                              />
                            </div>

                            <input
                              value={slide.summary}
                              onChange={(e) => updateSlide(si, { summary: e.target.value })}
                              placeholder="一句话摘要：这页讲什么"
                              className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] italic text-slate-500 hover:border-slate-200 focus:border-violet-400 focus:bg-white focus:outline-none"
                            />

                            <div className="space-y-0.5">
                              {slide.bullets.map((b, bi) => (
                                <div key={bi} className="flex items-center gap-1">
                                  <span className="h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                                  <input
                                    value={b}
                                    onChange={(e) => updateBullet(si, bi, e.target.value)}
                                    placeholder={`要点 ${bi + 1}`}
                                    className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-slate-600 hover:border-slate-200 focus:border-violet-400 focus:bg-white focus:outline-none"
                                  />
                                  <button
                                    onClick={() => removeBullet(si, bi)}
                                    className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 hover:text-rose-500 group-hover:opacity-100"
                                  >
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                </div>
                              ))}
                              <button
                                onClick={() => addBullet(si)}
                                className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-slate-400 hover:text-violet-600"
                              >
                                <Plus className="h-2.5 w-2.5" />
                                添加要点
                              </button>
                            </div>
                          </div>

                          <div className="flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              onClick={() => moveSlide(si, -1)}
                              disabled={si === 0}
                              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                            >
                              <ChevronUp className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => moveSlide(si, 1)}
                              disabled={si === slides.length - 1}
                              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                            >
                              <ChevronDown className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => removeSlide(si)}
                              className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>

                        <button
                          onClick={() => addSlide(si)}
                          className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-slate-200 py-1 text-[10px] font-medium text-slate-400 transition-colors hover:border-violet-400 hover:text-violet-600"
                        >
                          <Plus className="h-2.5 w-2.5" />
                          添加一页
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* footer actions */}
      {phase === "editing" && (
        <div className="flex shrink-0 items-center justify-between border-t border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-800/30 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div
              onClick={() => setAddBackground(!addBackground)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors"
            >
              <span
                role="checkbox"
                aria-checked={addBackground}
                className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                  addBackground
                    ? "border-violet-500 bg-violet-500 text-white"
                    : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700"
                }`}
              >
                {addBackground && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
              <ImageIcon className="h-3 w-3 text-slate-400" />
              添加背景
            </div>
            <button
              onClick={onRegenerate}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <RefreshCw className="h-3 w-3" />
              重新生成
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              取消
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400">{validCount} 页</span>
            <button
              onClick={() => {
                const valid = slides.filter((s) => s.title.trim());
                if (valid.length > 0) onConfirm(valid, addBackground);
              }}
              disabled={validCount === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-purple-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-violet-500/20 hover:shadow-md hover:shadow-violet-500/25 disabled:opacity-50 transition-all"
            >
              <Check className="h-3.5 w-3.5" />
              确认大纲，开始生成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
