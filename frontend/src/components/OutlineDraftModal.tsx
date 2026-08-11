import { useEffect, useState } from "react";
import {
  Loader2,
  X,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Sparkles,
  GripVertical,
  FileText,
  Check,
  RefreshCw,
} from "lucide-react";
import { api } from "../api/client";
import type { PPTOutlineSlide } from "../types";

// ─── 大纲编辑弹窗 ────────────────────────────────────────────────

export function OutlineDraftModal({
  initialText,
  onConfirm,
  onClose,
}: {
  initialText: string;
  onConfirm: (slides: PPTOutlineSlide[]) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [slides, setSlides] = useState<PPTOutlineSlide[]>([]);
  const [recommendedStyle, setRecommendedStyle] = useState("");
  const [regenerating, setRegenerating] = useState(false);

  const loadOutline = async (text: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.pptDraftOutline(text);
      setSlides(res.slides);
      setRecommendedStyle(res.style);
    } catch (e) {
      setError(e instanceof Error ? e.message : "大纲生成失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOutline(initialText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 编辑某页字段
  const updateSlide = (idx: number, patch: Partial<PPTOutlineSlide>) => {
    setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  // 编辑要点
  const updateBullet = (slideIdx: number, bulletIdx: number, val: string) => {
    setSlides((prev) =>
      prev.map((s, i) => {
        if (i !== slideIdx) return s;
        const bullets = [...s.bullets];
        bullets[bulletIdx] = val;
        return { ...s, bullets };
      })
    );
  };

  const addBullet = (slideIdx: number) => {
    setSlides((prev) =>
      prev.map((s, i) => (i === slideIdx ? { ...s, bullets: [...s.bullets, ""] } : s))
    );
  };

  const removeBullet = (slideIdx: number, bulletIdx: number) => {
    setSlides((prev) =>
      prev.map((s, i) => {
        if (i !== slideIdx) return s;
        const bullets = s.bullets.filter((_, j) => j !== bulletIdx);
        return { ...s, bullets };
      })
    );
  };

  // 增删页
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

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await loadOutline(initialText);
    } finally {
      setRegenerating(false);
    }
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

  const validSlideCount = slides.filter((s) => s.title.trim()).length;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[88vh] h-[640px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-100 text-brand-600">
              <FileText className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-800">确认大纲</h2>
              <p className="text-[11px] text-slate-400">
                AI 已生成草稿，你可以修改每页标题、摘要和要点，或增删页面
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
              <p className="text-sm">AI 正在构思大纲…</p>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm text-rose-500">{error}</p>
              <button
                onClick={() => loadOutline(initialText)}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                重试
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {sections.map((group) => (
                <div key={group.name}>
                  {/* section header */}
                  <div className="mb-2 flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                    <span className="text-xs font-bold tracking-wide text-brand-700 uppercase">
                      {group.name}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {group.indices.length} 页
                    </span>
                    <div className="h-px flex-1 bg-slate-100" />
                  </div>

                  {/* slides in this section */}
                  <div className="space-y-2.5">
                    {group.indices.map((slideIdx) => {
                      const slide = slides[slideIdx];
                      return (
                        <div
                          key={slideIdx}
                          className="group rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 transition-colors hover:border-slate-300 hover:bg-white"
                        >
                          <div className="flex items-start gap-2.5">
                            {/* 页码 + 拖拽手柄 */}
                            <div className="flex flex-col items-center gap-1 pt-0.5">
                              <GripVertical className="h-3.5 w-3.5 text-slate-300" />
                              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-100 text-[11px] font-bold text-brand-700">
                                {slideIdx + 1}
                              </span>
                            </div>

                            <div className="min-w-0 flex-1 space-y-2">
                              {/* section + title row */}
                              <div className="flex items-center gap-2">
                                <input
                                  value={slide.section}
                                  onChange={(e) =>
                                    updateSlide(slideIdx, { section: e.target.value })
                                  }
                                  placeholder="章节名"
                                  className="w-24 shrink-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:border-slate-200 focus:border-brand-400 focus:bg-white focus:outline-none"
                                />
                                <input
                                  value={slide.title}
                                  onChange={(e) =>
                                    updateSlide(slideIdx, { title: e.target.value })
                                  }
                                  placeholder="页面标题"
                                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-slate-800 hover:border-slate-200 focus:border-brand-400 focus:bg-white focus:outline-none"
                                />
                              </div>

                              {/* summary */}
                              <input
                                value={slide.summary}
                                onChange={(e) =>
                                  updateSlide(slideIdx, { summary: e.target.value })
                                }
                                placeholder="一句话说明这页要讲什么（内容方向）"
                                className="w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] text-slate-500 italic hover:border-slate-200 focus:border-brand-400 focus:bg-white focus:outline-none"
                              />

                              {/* bullets */}
                              <div className="space-y-1">
                                {slide.bullets.map((b, bi) => (
                                  <div key={bi} className="flex items-center gap-1.5">
                                    <span className="h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                                    <input
                                      value={b}
                                      onChange={(e) =>
                                        updateBullet(slideIdx, bi, e.target.value)
                                      }
                                      placeholder={`要点 ${bi + 1}`}
                                      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-slate-600 hover:border-slate-200 focus:border-brand-400 focus:bg-white focus:outline-none"
                                    />
                                    <button
                                      onClick={() => removeBullet(slideIdx, bi)}
                                      className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 hover:text-rose-500 group-hover:opacity-100"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
                                ))}
                                <button
                                  onClick={() => addBullet(slideIdx)}
                                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 hover:text-brand-600"
                                >
                                  <Plus className="h-3 w-3" />
                                  添加要点
                                </button>
                              </div>
                            </div>

                            {/* actions */}
                            <div className="flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                onClick={() => moveSlide(slideIdx, -1)}
                                disabled={slideIdx === 0}
                                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                              >
                                <ChevronUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => moveSlide(slideIdx, 1)}
                                disabled={slideIdx === slides.length - 1}
                                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                              >
                                <ChevronDown className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => removeSlide(slideIdx)}
                                className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* add page after */}
                          <button
                            onClick={() => addSlide(slideIdx)}
                            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-slate-200 py-1.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-brand-400 hover:text-brand-600"
                          >
                            <Plus className="h-3 w-3" />
                            在后面添加一页
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

        {/* footer */}
        {!loading && !error && (
          <div className="flex shrink-0 items-center justify-between border-t border-slate-100 px-6 py-3">
            <div className="flex items-center gap-3">
              <button
                onClick={handleRegenerate}
                disabled={regenerating}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
                重新生成
              </button>
              {recommendedStyle && (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-600">
                  <Sparkles className="h-2.5 w-2.5" />
                  推荐风格：{recommendedStyle}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">
                共 {validSlideCount} 页
              </span>
              <button
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const valid = slides.filter((s) => s.title.trim());
                  if (valid.length === 0) return;
                  onConfirm(valid);
                }}
                disabled={validSlideCount === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                确认大纲，开始生成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
