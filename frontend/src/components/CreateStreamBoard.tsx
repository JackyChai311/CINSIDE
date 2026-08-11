import { useEffect, useMemo, useState } from "react";
import {
    Loader2,
    Sparkles,
    CheckCircle2,
    PenLine,
    Image as ImageIcon,
    ImageOff,
    Shapes,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    X,
    Maximize2,
    MousePointer2,
    Download,
} from "lucide-react";
import SlideEditor from "./SlideEditor";

export interface StreamSlide {
    slide: number;
    title: string;
    bullets: string[];
    /** 配图状态：none=无图计划，generating=生图中，placed=已放置，failed=失败 */
    image?: "none" | "generating" | "placed" | "failed";
    /** 最新关键帧真实渲染截图（data URL），编辑过程中持续刷新 */
    frame?: string;
    /** 最近放置的装饰元素名（色带/卡片等），用于短暂提示 */
    decor?: string;
}

export interface StreamActive {
    slide: number;
    element: "title" | "bullet";
}

/**
 * 流式生成 PPT 的看板：幻灯片画面直接漂浮（无卡片底色），
 * 编辑阶段逐帧刷新真实渲染画面；文字流写完后自动折叠成摘要行。
 * 全部完成后合并为居中大查看器：翻页 / 点击放大，复用过程帧，零重新渲染。
 */
export default function CreateStreamBoard({
    slides,
    active = null,
    done = false,
    fileName,
    filePath,
    onFrameUpdate,
    onReset,
    onDownload,
}: {
    slides: StreamSlide[];
    active?: StreamActive | null;
    done: boolean;
    /** 完成后显示的文件名 */
    fileName?: string;
    /** 生成文件路径（启用单页编辑需要） */
    filePath?: string;
    /** 单页编辑写回后更新该页画面 */
    onFrameUpdate?: (slide: number, imageData: string) => void;
    /** 完成后头部右侧的"新建一份"回调 */
    onReset?: () => void;
    /** 下载完成后的 PPT 文件 */
    onDownload?: () => void;
}) {
    const totalTexts = useMemo(
        () => slides.reduce((acc, s) => acc + (s.title ? 1 : 0) + s.bullets.length, 0),
        [slides]
    );
    const imageCount = useMemo(
        () => slides.filter((s) => s.image === "placed").length,
        [slides]
    );

    // ---- 完成态查看器 ----
    const [viewerPage, setViewerPage] = useState(1);
    const [lightbox, setLightbox] = useState(false);
    // 单页编辑模式
    const [editMode, setEditMode] = useState(false);
    // 每页的文字区是否展开：默认折叠（写好后收起来），编辑中的页强制展开
    const [expanded, setExpanded] = useState<Record<number, boolean>>({});
    // 进入完成态时重置到第 1 页
    useEffect(() => {
        if (done) setViewerPage(1);
    }, [done]);

    // 灯箱键盘导航
    useEffect(() => {
        if (!lightbox) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setLightbox(false);
            if (e.key === "ArrowLeft") setViewerPage((p) => Math.max(1, p - 1));
            if (e.key === "ArrowRight") setViewerPage((p) => Math.min(slides.length, p + 1));
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [lightbox, slides.length]);

    const current = slides[viewerPage - 1];

    // ================= 完成态：合并为居中查看器 =================
    if (done) {
        return (
            <div className="csb-wrap">
                <div className="csb-head csb-head-done">
                    <div className="csb-head-left">
                        <CheckCircle2 size={16} className="text-emerald-500" />
                        <span className="csb-head-title">
                            PPT 已生成{fileName ? ` · ${fileName}` : ""}
                        </span>
                    </div>
                    <div className="csb-head-meta">
                        <span className="csb-pill">
                            共 {slides.length} 页 · {totalTexts} 个文字
                            {imageCount > 0 && ` · ${imageCount} 张配图`}
                        </span>
                        {onDownload && (
                            <button
                                className="csb-reset csb-download"
                                onClick={onDownload}
                                title="下载 PPT 文件"
                            >
                                <Download size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
                                下载
                            </button>
                        )}
                        {filePath && onFrameUpdate && (
                            <button
                                className={`csb-reset ${editMode ? "csb-edit-on" : ""}`}
                                onClick={() => setEditMode((v) => !v)}
                                title="拖拽移动元素 / 双击改文字 / AI 改本页"
                            >
                                <MousePointer2 size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
                                {editMode ? "退出编辑" : "编辑本页"}
                            </button>
                        )}
                        {onReset && (
                            <button className="csb-reset" onClick={onReset}>
                                新建一份
                            </button>
                        )}
                    </div>
                </div>

                {/* 居中大查看器：直接复用生成过程的关键帧，无需重新渲染 */}
                {current && (
                    <div className="csb-viewer">
                        <button
                            className="csb-viewer-nav csb-viewer-prev"
                            disabled={viewerPage <= 1}
                            onClick={() => setViewerPage((p) => Math.max(1, p - 1))}
                            title="上一页"
                        >
                            <ChevronLeft size={20} />
                        </button>
                        <div
                            className={`csb-viewer-stage ${editMode ? "csb-stage-editing" : ""}`}
                            onClick={() => !editMode && current.frame && setLightbox(true)}
                            title={!editMode && current.frame ? "点击放大" : undefined}
                        >
                            {current.frame ? (
                                <>
                                    <img
                                        src={current.frame}
                                        alt={`第 ${viewerPage} 页`}
                                        className="csb-viewer-img"
                                    />
                                    {!editMode && (
                                        <span className="csb-viewer-zoom">
                                            <Maximize2 size={13} />
                                        </span>
                                    )}
                                    {editMode && filePath && onFrameUpdate && (
                                        <SlideEditor
                                            key={viewerPage}
                                            filePath={filePath}
                                            slide={viewerPage}
                                            onFrame={(img) => onFrameUpdate(viewerPage, img)}
                                            onClose={() => setEditMode(false)}
                                        />
                                    )}
                                </>
                            ) : (
                                <div className="csb-frame-skeleton">
                                    <Loader2 size={18} className="animate-spin text-slate-300" />
                                    <span>第 {viewerPage} 页渲染中…</span>
                                </div>
                            )}
                        </div>
                        <button
                            className="csb-viewer-nav csb-viewer-next"
                            disabled={viewerPage >= slides.length}
                            onClick={() => setViewerPage((p) => Math.min(slides.length, p + 1))}
                            title="下一页"
                        >
                            <ChevronRight size={20} />
                        </button>
                    </div>
                )}

                {/* 页码点 */}
                <div className="csb-viewer-dots">
                    {slides.map((s) => (
                        <button
                            key={s.slide}
                            className={`csb-dot ${s.slide === viewerPage ? "csb-dot-active" : ""}`}
                            onClick={() => setViewerPage(s.slide)}
                            title={s.title || `第 ${s.slide} 页`}
                        />
                    ))}
                </div>
                <div className="csb-viewer-caption">
                    {viewerPage} / {slides.length}
                    {current?.title ? ` · ${current.title}` : ""}
                </div>

                {/* 灯箱：全屏放大翻页 */}
                {lightbox && current?.frame && (
                    <div className="csb-lightbox" onClick={() => setLightbox(false)}>
                        <button className="csb-lightbox-close" title="关闭 (Esc)">
                            <X size={20} />
                        </button>
                        <button
                            className="csb-lightbox-nav csb-lightbox-prev"
                            disabled={viewerPage <= 1}
                            onClick={(e) => { e.stopPropagation(); setViewerPage((p) => Math.max(1, p - 1)); }}
                        >
                            <ChevronLeft size={26} />
                        </button>
                        <img
                            src={current.frame}
                            alt={`第 ${viewerPage} 页`}
                            className="csb-lightbox-img"
                            onClick={(e) => e.stopPropagation()}
                        />
                        <button
                            className="csb-lightbox-nav csb-lightbox-next"
                            disabled={viewerPage >= slides.length}
                            onClick={(e) => { e.stopPropagation(); setViewerPage((p) => Math.min(slides.length, p + 1)); }}
                        >
                            <ChevronRight size={26} />
                        </button>
                        <div className="csb-lightbox-caption">
                            {viewerPage} / {slides.length}
                        </div>
                    </div>
                )}

                <StreamStyles />
            </div>
        );
    }

    // ================= 编辑态：漂浮画面网格 =================
    return (
        <div className="csb-wrap">
            {/* 顶部状态条 */}
            <div className="csb-head">
                <div className="csb-head-left">
                    <Loader2 size={16} className="animate-spin text-violet-500" />
                    <span className="csb-head-title">
                        {active ? `AI 正在编辑第 ${active.slide} 页…` : "AI 正在规划大纲…"}
                    </span>
                </div>
                <div className="csb-head-meta">
                    {slides.length > 0 && (
                        <span className="csb-pill">
                            共 {slides.length} 页 · {totalTexts} 个文字
                            {imageCount > 0 && ` · ${imageCount} 张配图`}
                        </span>
                    )}
                </div>
            </div>

            {slides.length > 0 && (
                <div className="csb-grid">
                    {slides.map((s) => {
                        const isActive = !!(active && active.slide === s.slide);
                        const placingBullet =
                            isActive && active!.element === "bullet" ? s.bullets.length : -1;
                        // 文字流：编辑中的页强制展开；已出画面的页默认折叠（可点击展开）
                        const isOpen = isActive || expanded[s.slide] || !s.frame;
                        return (
                            <div
                                key={s.slide}
                                className={`csb-card ${isActive ? "csb-card-active" : ""}`}
                            >
                                {/* 真实渲染画面：漂浮（无卡片底色，只有画面投影） */}
                                <div className="csb-frame">
                                    {s.frame ? (
                                        <img
                                            src={s.frame}
                                            alt={`第 ${s.slide} 页渲染画面`}
                                            className="csb-frame-img"
                                        />
                                    ) : (
                                        <div className="csb-frame-skeleton">
                                            <Loader2 size={18} className="animate-spin text-slate-300" />
                                            <span>等待渲染…</span>
                                        </div>
                                    )}
                                    <span className="csb-frame-num">{s.slide}</span>
                                    {isActive && (
                                        <span className="csb-frame-live">
                                            <Sparkles size={10} />
                                            LIVE
                                        </span>
                                    )}
                                    {s.image === "generating" && (
                                        <span className="csb-frame-img-status csb-img-generating">
                                            <Loader2 size={10} className="animate-spin" />
                                            配图生成中
                                        </span>
                                    )}
                                    {s.image === "placed" && (
                                        <span className="csb-frame-img-status csb-img-placed">
                                            <ImageIcon size={10} />
                                            已配图
                                        </span>
                                    )}
                                    {s.image === "failed" && (
                                        <span className="csb-frame-img-status csb-img-failed">
                                            <ImageOff size={10} />
                                            配图失败
                                        </span>
                                    )}
                                </div>

                                {/* 状态行 */}
                                <div className="csb-card-top">
                                    <span className="csb-card-tag">
                                        {isActive ? (
                                            <>
                                                <Sparkles size={11} className="text-violet-500" />
                                                编辑中
                                            </>
                                        ) : s.frame ? (
                                            "已完成"
                                        ) : (
                                            "排队中"
                                        )}
                                    </span>
                                    {s.decor && isActive && (
                                        <span className="csb-decor-tag">
                                            <Shapes size={10} />
                                            {s.decor}
                                        </span>
                                    )}
                                </div>

                                {/* 文字流：可折叠（写好且出图后收起） */}
                                {isOpen ? (
                                    <div className="csb-card-texts">
                                        <div className="csb-card-title-row">
                                            {isActive && active!.element === "title" && (
                                                <span className="csb-caret" />
                                            )}
                                            <span className="csb-card-title">{s.title || ""}</span>
                                            {isActive && active!.element === "title" && (
                                                <span className="csb-caret" />
                                            )}
                                        </div>
                                        <div className="csb-card-body">
                                            {s.bullets.map((b, i) => {
                                                const isTyping = i === placingBullet;
                                                return (
                                                    <div
                                                        key={i}
                                                        className={`csb-bullet ${isTyping ? "csb-bullet-typing" : ""}`}
                                                    >
                                                        <span className="csb-bullet-dot" />
                                                        <span className="csb-bullet-text">{b}</span>
                                                        {isTyping && <span className="csb-caret" />}
                                                        {isActive && active!.element === "bullet" && i === s.bullets.length - 1 && (
                                                            <PenLine size={12} className="csb-bullet-pen" />
                                                        )}
                                                    </div>
                                                );
                                            })}
                                            {s.bullets.length === 0 && (
                                                <div className="csb-empty">等待放置文字…</div>
                                            )}
                                        </div>
                                        {/* 收起按钮（仅已完成的页显示） */}
                                        {!isActive && s.frame && (
                                            <button
                                                className="csb-collapse"
                                                onClick={() => setExpanded((p) => ({ ...p, [s.slide]: false }))}
                                            >
                                                <ChevronDown size={12} className="csb-collapse-icon csb-collapse-up" />
                                                收起文字
                                            </button>
                                        )}
                                    </div>
                                ) : (
                                    <button
                                        className="csb-summary"
                                        onClick={() => setExpanded((p) => ({ ...p, [s.slide]: true }))}
                                        title="展开文字"
                                    >
                                        <span className="csb-summary-title">{s.title || `第 ${s.slide} 页`}</span>
                                        <span className="csb-summary-meta">
                                            {s.bullets.length} 条要点
                                            {s.image === "placed" ? " · 已配图" : ""}
                                        </span>
                                        <ChevronDown size={12} className="csb-summary-icon" />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <StreamStyles />
        </div>
    );
}

function StreamStyles() {
    return (
        <style>{`
            .csb-wrap {
                width: 100%;
            }
            .csb-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 6px 4px 12px;
            }
            .csb-head-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
            .csb-head-title {
                font-size: 13px;
                font-weight: 600;
                color: #334155;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .csb-head-done .csb-head-title { color: #047857; }
            .csb-head-meta { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
            .csb-reset {
                font-size: 11px;
                font-weight: 600;
                color: #6d28d9;
                background: rgba(255, 255, 255, 0.9);
                border: 1px solid rgba(196, 181, 253, 0.8);
                padding: 4px 12px;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
            }
            .csb-reset:hover { background: #f5f3ff; border-color: #a78bfa; }
            .csb-download {
                color: #059669;
                border-color: rgba(110, 231, 183, 0.8);
            }
            .csb-download:hover { background: #ecfdf5; border-color: #34d399; }
            .csb-edit-on {
                color: #ffffff;
                background: #7c3aed;
                border-color: #7c3aed;
            }
            .csb-edit-on:hover { background: #6d28d9; border-color: #6d28d9; }
            .csb-stage-editing { cursor: default; }
            .csb-stage-editing:hover .csb-viewer-zoom { opacity: 0; }
            .csb-pill {
                font-size: 11px;
                font-weight: 600;
                color: #7c3aed;
                background: rgba(245, 243, 255, 0.85);
                padding: 3px 10px;
                border-radius: 999px;
            }
            /* ---- 编辑态网格：画面做大、漂浮无填充 ---- */
            .csb-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
                gap: 22px;
                padding: 4px;
            }
            .csb-card {
                display: flex;
                flex-direction: column;
                gap: 8px;
                min-width: 0;
            }
            /* ---- 真实渲染画面：漂浮（仅投影，无底色无卡片） ---- */
            .csb-frame {
                position: relative;
                width: 100%;
                aspect-ratio: 16 / 9;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 12px 32px -10px rgba(30, 41, 59, 0.28), 0 2px 8px -2px rgba(30, 41, 59, 0.12);
                transition: box-shadow 0.3s, transform 0.3s;
            }
            .csb-card-active .csb-frame {
                box-shadow: 0 0 0 2.5px rgba(129, 140, 248, 0.65), 0 18px 44px -12px rgba(99, 102, 241, 0.5);
                transform: translateY(-2px);
            }
            .csb-frame-img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
                animation: csb-frame-in 0.45s ease;
            }
            @keyframes csb-frame-in {
                from { opacity: 0.35; transform: scale(1.015); }
                to { opacity: 1; transform: scale(1); }
            }
            .csb-frame-skeleton {
                width: 100%;
                height: 100%;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 6px;
                font-size: 11px;
                color: #94a3b8;
                background: linear-gradient(100deg, rgba(241,245,249,0.7) 40%, rgba(248,250,252,0.9) 50%, rgba(241,245,249,0.7) 60%);
                background-size: 200% 100%;
                animation: csb-shimmer 1.6s linear infinite;
            }
            @keyframes csb-shimmer {
                to { background-position: -200% 0; }
            }
            .csb-frame-num {
                position: absolute;
                top: 8px;
                left: 8px;
                min-width: 22px;
                height: 22px;
                padding: 0 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                font-weight: 700;
                color: #ffffff;
                background: rgba(15, 23, 42, 0.55);
                border-radius: 7px;
                backdrop-filter: blur(2px);
            }
            .csb-frame-live {
                position: absolute;
                top: 8px;
                right: 8px;
                display: flex;
                align-items: center;
                gap: 3px;
                font-size: 9px;
                font-weight: 700;
                letter-spacing: 0.5px;
                color: #ffffff;
                background: rgba(124, 58, 237, 0.85);
                padding: 3px 8px;
                border-radius: 999px;
                animation: csb-live-pulse 1.2s ease-in-out infinite;
            }
            @keyframes csb-live-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.55; }
            }
            .csb-frame-img-status {
                position: absolute;
                bottom: 8px;
                right: 8px;
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 10px;
                font-weight: 600;
                padding: 3px 8px;
                border-radius: 999px;
                backdrop-filter: blur(2px);
            }
            .csb-img-generating { color: #7c3aed; background: rgba(245, 243, 255, 0.92); }
            .csb-img-placed { color: #059669; background: rgba(236, 253, 245, 0.92); }
            .csb-img-failed { color: #e11d48; background: rgba(255, 241, 242, 0.92); }
            /* ---- 状态行 / 文字流 ---- */
            .csb-card-top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 2px;
            }
            .csb-card-tag {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 10px;
                font-weight: 600;
                color: #94a3b8;
            }
            .csb-card-active .csb-card-tag { color: #7c3aed; }
            .csb-decor-tag {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 10px;
                font-weight: 600;
                color: #0369a1;
                background: rgba(240, 249, 255, 0.9);
                padding: 2px 8px;
                border-radius: 999px;
            }
            .csb-card-texts {
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 0 2px;
            }
            .csb-card-title-row {
                display: flex;
                align-items: center;
                gap: 6px;
                min-height: 20px;
            }
            .csb-card-title {
                font-size: 13px;
                font-weight: 700;
                color: #1e293b;
                line-height: 1.4;
            }
            .csb-card-body { display: flex; flex-direction: column; gap: 4px; }
            .csb-bullet {
                display: flex;
                align-items: flex-start;
                gap: 6px;
                font-size: 11px;
                color: #475569;
                line-height: 1.5;
                padding: 3px 6px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .csb-bullet-typing {
                background: rgba(238, 242, 255, 0.9);
                color: #3730a3;
            }
            .csb-bullet-dot {
                flex-shrink: 0;
                width: 5px;
                height: 5px;
                margin-top: 5px;
                border-radius: 50%;
                background: #c7d2fe;
            }
            .csb-bullet-typing .csb-bullet-dot { background: #6366f1; }
            .csb-bullet-text { flex: 1; min-width: 0; }
            .csb-bullet-pen { flex-shrink: 0; color: #8b5cf6; margin-top: 1px; }
            .csb-empty { font-size: 11px; color: #cbd5e1; font-style: italic; }
            /* 折叠摘要行 */
            .csb-summary {
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 6px 10px;
                border-radius: 9px;
                background: rgba(255, 255, 255, 0.55);
                border: 1px solid rgba(226, 232, 240, 0.7);
                cursor: pointer;
                transition: background 0.2s;
                text-align: left;
            }
            .csb-summary:hover { background: rgba(255, 255, 255, 0.85); }
            .csb-summary-title {
                flex: 1;
                min-width: 0;
                font-size: 12px;
                font-weight: 600;
                color: #334155;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .csb-summary-meta {
                flex-shrink: 0;
                font-size: 10px;
                color: #94a3b8;
            }
            .csb-summary-icon { flex-shrink: 0; color: #94a3b8; }
            .csb-collapse {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                align-self: flex-start;
                font-size: 10px;
                font-weight: 600;
                color: #94a3b8;
                padding: 3px 8px;
                border-radius: 999px;
                cursor: pointer;
                transition: color 0.2s, background 0.2s;
            }
            .csb-collapse:hover { color: #64748b; background: rgba(241, 245, 249, 0.9); }
            .csb-collapse-up { transform: rotate(180deg); }
            .csb-caret {
                display: inline-block;
                width: 2px;
                height: 14px;
                background: #8b5cf6;
                animation: csb-blink 0.9s steps(2, start) infinite;
                border-radius: 1px;
                flex-shrink: 0;
            }
            @keyframes csb-blink {
                to { visibility: hidden; }
            }
            /* ---- 完成态：居中大查看器 ---- */
            .csb-viewer {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 14px;
                padding: 8px 0 4px;
            }
            .csb-viewer-stage {
                position: relative;
                width: min(880px, 100%);
                aspect-ratio: 16 / 9;
                border-radius: 14px;
                overflow: hidden;
                box-shadow: 0 24px 64px -16px rgba(30, 41, 59, 0.35), 0 4px 16px -4px rgba(30, 41, 59, 0.15);
                cursor: zoom-in;
                animation: csb-viewer-in 0.5s ease;
            }
            @keyframes csb-viewer-in {
                from { opacity: 0; transform: scale(0.96) translateY(10px); }
                to { opacity: 1; transform: scale(1) translateY(0); }
            }
            .csb-viewer-img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }
            .csb-viewer-zoom {
                position: absolute;
                right: 10px;
                bottom: 10px;
                width: 30px;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #ffffff;
                background: rgba(15, 23, 42, 0.5);
                border-radius: 8px;
                opacity: 0;
                transition: opacity 0.2s;
                backdrop-filter: blur(2px);
            }
            .csb-viewer-stage:hover .csb-viewer-zoom { opacity: 1; }
            .csb-viewer-nav {
                flex-shrink: 0;
                width: 38px;
                height: 38px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                color: #475569;
                background: rgba(255, 255, 255, 0.75);
                border: 1px solid rgba(226, 232, 240, 0.8);
                box-shadow: 0 4px 12px -4px rgba(30, 41, 59, 0.15);
                cursor: pointer;
                transition: all 0.2s;
            }
            .csb-viewer-nav:hover:not(:disabled) {
                color: #7c3aed;
                background: #ffffff;
                transform: scale(1.06);
            }
            .csb-viewer-nav:disabled { opacity: 0.35; cursor: default; }
            .csb-viewer-dots {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 7px;
                padding-top: 14px;
            }
            .csb-dot {
                width: 7px;
                height: 7px;
                border-radius: 50%;
                background: #cbd5e1;
                cursor: pointer;
                transition: all 0.25s;
                padding: 0;
                border: none;
            }
            .csb-dot:hover { background: #94a3b8; }
            .csb-dot-active {
                width: 20px;
                border-radius: 999px;
                background: #7c3aed;
            }
            .csb-viewer-caption {
                text-align: center;
                font-size: 12px;
                color: #64748b;
                padding-top: 8px;
            }
            /* ---- 灯箱 ---- */
            .csb-lightbox {
                position: fixed;
                inset: 0;
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(15, 23, 42, 0.88);
                backdrop-filter: blur(6px);
                animation: csb-lb-in 0.25s ease;
            }
            @keyframes csb-lb-in { from { opacity: 0; } to { opacity: 1; } }
            .csb-lightbox-img {
                max-width: 88vw;
                max-height: 86vh;
                border-radius: 10px;
                box-shadow: 0 32px 90px -20px rgba(0, 0, 0, 0.6);
            }
            .csb-lightbox-close {
                position: absolute;
                top: 18px;
                right: 18px;
                width: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #e2e8f0;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 50%;
                cursor: pointer;
                transition: background 0.2s;
            }
            .csb-lightbox-close:hover { background: rgba(255, 255, 255, 0.22); }
            .csb-lightbox-nav {
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
                width: 46px;
                height: 46px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #e2e8f0;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 50%;
                cursor: pointer;
                transition: background 0.2s;
            }
            .csb-lightbox-nav:hover:not(:disabled) { background: rgba(255, 255, 255, 0.25); }
            .csb-lightbox-nav:disabled { opacity: 0.3; cursor: default; }
            .csb-lightbox-prev { left: 20px; }
            .csb-lightbox-next { right: 20px; }
            .csb-lightbox-caption {
                position: absolute;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 13px;
                font-weight: 600;
                color: #e2e8f0;
                background: rgba(255, 255, 255, 0.1);
                padding: 5px 14px;
                border-radius: 999px;
            }
        `}</style>
    );
}
