import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  ImageOff,
  ChevronDown,
  Maximize2,
  X,
} from "lucide-react";
import { api } from "../api/client";
import type { PPTFileSlides } from "../types";

// 截图内存缓存：file_path#page -> dataURL，跨组件实例共享，翻回已看页立即显示
const screenshotCache = new Map<string, string>();
const cacheKey = (filePath: string, page: number) => `${filePath}#${page}`;

interface SlideSlot {
  fileId: string;
  page: number;
  imageData: string | null;
  loading: boolean;
  error: string | null;
}

interface SlidePreviewTrayProps {
  files: PPTFileSlides[];
  slotCount?: number;
  /** 每个槽位初始显示的文件 id（长度应 <= slotCount）；缺省时全部指向 files[0] */
  initialFileIds?: (string | null)[];
  /** 槽位文件变化回调：报告每个槽位当前显示的文件 id（用于父组件记住当前预览的是哪些文件） */
  onSlotsChange?: (fileIds: (string | null)[]) => void;
}

export default function SlidePreviewTray({ files, slotCount = 1, initialFileIds, onSlotsChange }: SlidePreviewTrayProps) {
  // 各槽位的初始状态：第 i 个槽位优先显示 initialFileIds[i]，否则显示第一个文件的前 N 页（N = 预览窗口数量）
  const makeInitialSlots = useCallback((): SlideSlot[] => {
    const firstFile = files[0];
    if (!firstFile) return [];
    const count = Math.min(Math.max(1, slotCount), 3);
    return Array.from({ length: count }, (_, offset) => {
      const targetId = initialFileIds?.[offset];
      const target = targetId ? files.find((f) => f.file_id === targetId) : undefined;
      const file = target ?? firstFile;
      return {
        fileId: file.file_id,
        page: 1,
        imageData: null,
        loading: false,
        error: null,
      };
    });
  }, [files, slotCount, initialFileIds]);

  const [slots, setSlots] = useState<SlideSlot[]>(makeInitialSlots);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // 放大查看：记录从哪个槽位进入灯箱
  const [lightbox, setLightbox] = useState<number | null>(null);

  // 文件列表变化时重置
  useEffect(() => {
    setSlots(makeInitialSlots());
  }, [makeInitialSlots]);

  // 槽位文件变化时向上报告（仅当 fileId 映射真正变化时触发，避免重复）
  const prevReportedRef = useRef<string>(``);
  useEffect(() => {
    const ids = slots.map((s) => s.fileId);
    const key = ids.join(`\u0001`);
    if (key !== prevReportedRef.current) {
      prevReportedRef.current = key;
      onSlotsChange?.(ids);
    }
  }, [slots, onSlotsChange]);

  // 关闭下拉菜单
  useEffect(() => {
    if (openDropdown === null) return;
    const onDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenDropdown(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openDropdown]);

  // 获取某个文件的幻灯片数量
  const getSlideCount = useCallback(
    (fileId: string) => {
      const f = files.find((x) => x.file_id === fileId);
      return f ? f.slides.length : 0;
    },
    [files]
  );

  const getFileName = useCallback(
    (fileId: string) => {
      const f = files.find((x) => x.file_id === fileId);
      return f ? f.file_name : "";
    },
    [files]
  );

  const getFilePath = useCallback(
    (fileId: string) => {
      const f = files.find((x) => x.file_id === fileId);
      return f ? f.file_path : "";
    },
    [files]
  );

  // 预加载相邻页（只写缓存，不碰 slots，避免干扰当前渲染）
  const prefetch = useCallback(
    async (filePath: string, page: number, count: number) => {
      const tasks: Promise<void>[] = [];
      for (const p of [page - 1, page + 1]) {
        if (p < 1 || p > count) continue;
        const key = cacheKey(filePath, p);
        if (screenshotCache.has(key)) continue;
        tasks.push(
          api.pptScreenshot(filePath, p).then((res) => {
            screenshotCache.set(key, res.image_data);
          }).catch(() => {})
        );
      }
      await Promise.all(tasks);
    },
    []
  );

  // 加载截图（带缓存）
  const loadScreenshot = useCallback(
    async (slotIdx: number, filePath: string, page: number, slideCount: number) => {
      // 命中缓存：直接展示，不请求后端
      const cached = screenshotCache.get(cacheKey(filePath, page));
      if (cached) {
        setSlots((prev) => {
          const next = [...prev];
          next[slotIdx] = { ...next[slotIdx], loading: false, error: null, imageData: cached };
          return next;
        });
        return;
      }
      setSlots((prev) => {
        const next = [...prev];
        next[slotIdx] = { ...next[slotIdx], loading: true, error: null, imageData: null };
        return next;
      });
      try {
        const res = await api.pptScreenshot(filePath, page);
        screenshotCache.set(cacheKey(filePath, page), res.image_data);
        setSlots((prev) => {
          const next = [...prev];
          next[slotIdx] = {
            ...next[slotIdx],
            loading: false,
            imageData: res.image_data,
            error: null,
          };
          return next;
        });
      } catch (e: unknown) {
        setSlots((prev) => {
          const next = [...prev];
          next[slotIdx] = {
            ...next[slotIdx],
            loading: false,
            error: e instanceof Error ? e.message : "截图失败",
          };
          return next;
        });
      }
      // 预加载上下相邻页
      void prefetch(filePath, page, slideCount);
    },
    [prefetch]
  );

  // 当槽位的 fileId 或 page 变化时自动加载
  useEffect(() => {
    slots.forEach((slot, idx) => {
      if (!slot.imageData && !slot.loading && !slot.error) {
        const path = getFilePath(slot.fileId);
        if (path) {
          const count = getSlideCount(slot.fileId);
          loadScreenshot(idx, path, slot.page, count);
        }
      }
    });
  }, [slots, getFilePath, getSlideCount, loadScreenshot]);

  // 翻页
  const goPage = useCallback(
    (slotIdx: number, delta: number) => {
      setSlots((prev) => {
        const next = [...prev];
        const slot = next[slotIdx];
        const count = getSlideCount(slot.fileId);
        const newPage = Math.max(1, Math.min(count, slot.page + delta));
        if (newPage === slot.page) return prev;
        const path = getFilePath(slot.fileId);
        const cached = path ? screenshotCache.get(cacheKey(path, newPage)) : null;
        // 目标页已在缓存：直接展示，无闪烁
        next[slotIdx] = {
          ...slot,
          page: newPage,
          imageData: cached ?? null,
          loading: cached ? false : true,
          error: null,
        };
        if (cached) {
          // 顺手预加载更远一页
          void prefetch(path, newPage, count);
        }
        return next;
      });
    },
    [getSlideCount, getFilePath, prefetch]
  );

  // 切换文件
  const switchFile = useCallback(
    (slotIdx: number, fileId: string) => {
      setSlots((prev) => {
        const next = [...prev];
        const path = getFilePath(fileId);
        const cached = path ? screenshotCache.get(cacheKey(path, 1)) : null;
        next[slotIdx] = {
          ...next[slotIdx],
          fileId,
          page: 1,
          imageData: cached ?? null,
          loading: cached ? false : true,
          error: null,
        };
        return next;
      });
      setOpenDropdown(null);
    },
    [getFilePath]
  );

  if (!files.length || !slots.length) return null;

  return (
    <div className="spt-root">
      <div className="spt-slots" ref={dropdownRef} style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(1, slotCount), 3)}, 1fr)` }}>
        {slots.map((slot, idx) => {
          const count = getSlideCount(slot.fileId);
          const fileName = getFileName(slot.fileId);
          return (
            <div key={idx} className="spt-slot">
              {/* 文件选择器 */}
              <div className="spt-slot-topbar">
                <button
                  className="spt-file-btn"
                  onClick={() => setOpenDropdown(openDropdown === idx ? null : idx)}
                  title={fileName}
                >
                  <span className="spt-file-name">{fileName}</span>
                  <ChevronDown
                    size={12}
                    className={`spt-chevron ${openDropdown === idx ? "rotate-180" : ""}`}
                  />
                </button>
                {openDropdown === idx && (
                  <div className="spt-dropdown">
                    {files.map((f) => (
                      <button
                        key={f.file_id}
                        className={`spt-dropdown-item ${f.file_id === slot.fileId ? "active" : ""}`}
                        onClick={() => switchFile(idx, f.file_id)}
                      >
                        <span className="spt-dd-name">{f.file_name}</span>
                        <span className="spt-dd-count">{f.slides.length} 页</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 幻灯片预览区 */}
              <div className="spt-canvas">
                {slot.loading && (
                  <div className="spt-placeholder">
                    <Loader2 size={24} className="animate-spin text-violet-400" />
                    <span className="spt-placeholder-text">渲染中…</span>
                  </div>
                )}
                {slot.error && !slot.loading && (
                  <div className="spt-placeholder">
                    <ImageOff size={24} className="text-rose-400" />
                    <span className="spt-placeholder-text">{slot.error}</span>
                    <button
                      className="spt-retry-btn"
                      onClick={() => {
                        const path = getFilePath(slot.fileId);
                        if (path) loadScreenshot(idx, path, slot.page, count);
                      }}
                    >
                      重试
                    </button>
                  </div>
                )}
                {!slot.loading && !slot.error && slot.imageData && (
                  <button
                    type="button"
                    className="spt-canvas-img-btn"
                    onClick={() => setLightbox(idx)}
                    title="点击放大查看"
                  >
                    <img
                      src={slot.imageData}
                      alt={`${fileName} 第 ${slot.page} 页`}
                      className="spt-slide-img"
                    />
                    <span className="spt-zoom-hint">
                      <Maximize2 size={14} />
                    </span>
                  </button>
                )}
                {!slot.loading && !slot.error && !slot.imageData && (
                  <div className="spt-placeholder">
                    <ImageOff size={24} className="text-slate-300" />
                  </div>
                )}
              </div>

              {/* 页码导航 */}
              <div className="spt-navbar">
                <button
                  className="spt-nav-btn"
                  onClick={() => goPage(idx, -1)}
                  disabled={slot.page <= 1}
                  title="上一页"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="spt-page-info">
                  <span className="spt-page-current">{slot.page}</span>
                  <span className="spt-page-sep">/</span>
                  <span className="spt-page-total">{count}</span>
                </span>
                <button
                  className="spt-nav-btn"
                  onClick={() => goPage(idx, 1)}
                  disabled={slot.page >= count}
                  title="下一页"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 点击放大的灯箱 */}
      {lightbox !== null && slots[lightbox] && (
        <Lightbox
          slot={slots[lightbox]}
          fileName={getFileName(slots[lightbox].fileId)}
          pageCount={getSlideCount(slots[lightbox].fileId)}
          onClose={() => setLightbox(null)}
          onPrev={() => goPage(lightbox, -1)}
          onNext={() => goPage(lightbox, 1)}
        />
      )}

      <style>{`
        .spt-root {
          width: min(1200px, 94vw);
          position: relative;
          left: 50%;
          transform: translateX(-50%);
        }
        .spt-slots {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 18px;
        }
        .spt-slot {
          display: flex;
          flex-direction: column;
          background: #ffffff;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 12px 40px -12px rgba(15, 23, 42, 0.18),
                      0 4px 12px -4px rgba(15, 23, 42, 0.08);
          transition: transform 0.25s ease, box-shadow 0.25s ease;
        }
        .spt-slot:hover {
          transform: translateY(-4px);
          box-shadow: 0 24px 56px -12px rgba(139, 92, 246, 0.28),
                      0 8px 20px -6px rgba(15, 23, 42, 0.1);
        }
        .spt-slot-topbar {
          position: relative;
          padding: 10px 12px;
          border-bottom: 1px solid #f1f5f9;
          background: #fafbfc;
        }
        .spt-file-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 5px 8px;
          border: none;
          background: transparent;
          border-radius: 8px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .spt-file-btn:hover {
          background: #f1f5f9;
        }
        .spt-file-name {
          flex: 1;
          text-align: left;
          font-size: 13px;
          font-weight: 600;
          color: #334155;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .spt-chevron {
          flex-shrink: 0;
          color: #94a3b8;
          transition: transform 0.2s;
        }
        .spt-dropdown {
          position: absolute;
          top: 100%;
          left: 12px;
          right: 12px;
          z-index: 30;
          margin-top: 6px;
          background: white;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          box-shadow: 0 16px 40px -8px rgba(0,0,0,0.18);
          padding: 6px;
          max-height: 240px;
          overflow-y: auto;
        }
        .spt-dropdown-item {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 8px 12px;
          border: none;
          background: transparent;
          border-radius: 8px;
          cursor: pointer;
          text-align: left;
          transition: background 0.12s;
        }
        .spt-dropdown-item:hover {
          background: #f8fafc;
        }
        .spt-dropdown-item.active {
          background: #f5f3ff;
        }
        .spt-dd-name {
          flex: 1;
          font-size: 13px;
          color: #334155;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .spt-dropdown-item.active .spt-dd-name {
          color: #7c3aed;
          font-weight: 600;
        }
        .spt-dd-count {
          flex-shrink: 0;
          font-size: 11px;
          color: #94a3b8;
        }
        .spt-canvas {
          position: relative;
          aspect-ratio: 16 / 9;
          background: #f8fafc;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .spt-canvas-img-btn {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          padding: 0;
          border: none;
          background: transparent;
          cursor: zoom-in;
        }
        .spt-zoom-hint {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.5);
          color: #fff;
          opacity: 0;
          transform: scale(0.9);
          transition: opacity 0.18s ease, transform 0.18s ease;
          pointer-events: none;
          backdrop-filter: blur(4px);
        }
        .spt-canvas-img-btn:hover .spt-zoom-hint {
          opacity: 1;
          transform: scale(1);
        }
        .spt-slide-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          display: block;
        }
        .spt-placeholder {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          color: #94a3b8;
        }
        .spt-placeholder-text {
          font-size: 13px;
          color: #94a3b8;
        }
        .spt-retry-btn {
          margin-top: 6px;
          padding: 5px 16px;
          font-size: 12px;
          font-weight: 500;
          color: #7c3aed;
          background: white;
          border: 1px solid #ddd6fe;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s;
        }
        .spt-retry-btn:hover {
          background: #f5f3ff;
          border-color: #a78bfa;
        }
        .spt-navbar {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 10px 12px;
          border-top: 1px solid #f1f5f9;
          background: #fafbfc;
        }
        .spt-nav-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: none;
          background: transparent;
          border-radius: 8px;
          color: #64748b;
          cursor: pointer;
          transition: all 0.15s;
        }
        .spt-nav-btn:hover:not(:disabled) {
          background: rgba(139,92,246,0.1);
          color: #7c3aed;
        }
        .spt-nav-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .spt-page-info {
          display: flex;
          align-items: baseline;
          gap: 3px;
          font-size: 14px;
          min-width: 48px;
          justify-content: center;
        }
        .spt-page-current {
          font-weight: 700;
          color: #1e293b;
        }
        .spt-page-sep {
          color: #cbd5e1;
        }
        .spt-page-total {
          color: #94a3b8;
        }
      `}</style>
    </div>
  );
}

// ---- 点击放大查看的灯箱 ----
function Lightbox({
  slot,
  fileName,
  pageCount,
  onClose,
  onPrev,
  onNext,
}: {
  slot: SlideSlot;
  fileName: string;
  pageCount: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      className="spt-lightbox"
      onMouseDown={onClose}
    >
      <div className="spt-lightbox-card" onMouseDown={(e) => e.stopPropagation()}>
        {/* 顶栏 */}
        <div className="spt-lightbox-top">
          <div className="spt-lightbox-title">
            <span className="spt-lightbox-name">{fileName}</span>
            <span className="spt-lightbox-page">
              {slot.page} / {pageCount} 页
            </span>
          </div>
          <button className="spt-lightbox-close" onClick={onClose} title="关闭 (Esc)">
            <X size={18} />
          </button>
        </div>

        {/* 主体：大图居中 */}
        <div className="spt-lightbox-body">
          {slot.loading && (
            <div className="spt-lightbox-loading">
              <Loader2 size={30} className="animate-spin text-violet-400" />
              <span>渲染中…</span>
            </div>
          )}
          {!slot.loading && slot.imageData && (
            <img
              src={slot.imageData}
              alt={`${fileName} 第 ${slot.page} 页`}
              className="spt-lightbox-img"
            />
          )}
          {!slot.loading && !slot.imageData && (
            <div className="spt-lightbox-loading">
              <ImageOff size={30} className="text-slate-400" />
              <span>无法显示该页</span>
            </div>
          )}
        </div>

        {/* 底部：翻页控制 */}
        <div className="spt-lightbox-bottom">
          <button
            className="spt-lightbox-nav"
            onClick={onPrev}
            disabled={slot.page <= 1}
            title="上一页 (←)"
          >
            <ChevronLeft size={20} />
          </button>
          <span className="spt-lightbox-hint">← → 翻页 · Esc 关闭</span>
          <button
            className="spt-lightbox-nav"
            onClick={onNext}
            disabled={slot.page >= pageCount}
            title="下一页 (→)"
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      <style>{`
        .spt-lightbox {
          position: fixed;
          inset: 0;
          z-index: 90;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(15, 23, 42, 0.72);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          animation: spt-lb-fade 0.18s ease-out both;
        }
        .spt-lightbox-card {
          display: flex;
          flex-direction: column;
          width: min(1100px, 94vw);
          max-height: 92vh;
          background: #ffffff;
          border-radius: 18px;
          overflow: hidden;
          box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.5);
          animation: spt-lb-pop 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .spt-lightbox-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid #f1f5f9;
          background: #fafbfc;
        }
        .spt-lightbox-title {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }
        .spt-lightbox-name {
          font-size: 14px;
          font-weight: 600;
          color: #1e293b;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .spt-lightbox-page {
          flex-shrink: 0;
          font-size: 12px;
          font-weight: 600;
          color: #7c3aed;
          background: #f5f3ff;
          padding: 2px 10px;
          border-radius: 999px;
          font-feature-settings: "tnum";
        }
        .spt-lightbox-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: #64748b;
          cursor: pointer;
          transition: all 0.15s;
        }
        .spt-lightbox-close:hover {
          background: rgba(244, 63, 94, 0.1);
          color: #e11d48;
        }
        .spt-lightbox-body {
          flex: 1;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0f172a;
          padding: 16px;
        }
        .spt-lightbox-img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          border-radius: 6px;
          box-shadow: 0 8px 30px -8px rgba(0, 0, 0, 0.6);
        }
        .spt-lightbox-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          color: #94a3b8;
          font-size: 13px;
        }
        .spt-lightbox-bottom {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          padding: 12px 16px;
          border-top: 1px solid #f1f5f9;
          background: #fafbfc;
        }
        .spt-lightbox-nav {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border: none;
          border-radius: 10px;
          background: #fff;
          color: #475569;
          box-shadow: 0 2px 8px -2px rgba(15, 23, 42, 0.15);
          cursor: pointer;
          transition: all 0.15s;
        }
        .spt-lightbox-nav:hover:not(:disabled) {
          background: #f5f3ff;
          color: #7c3aed;
          transform: translateY(-1px);
        }
        .spt-lightbox-nav:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .spt-lightbox-hint {
          font-size: 11px;
          color: #94a3b8;
        }
        @keyframes spt-lb-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes spt-lb-pop {
          from { opacity: 0; transform: translateY(12px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
