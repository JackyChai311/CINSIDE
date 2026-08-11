import { useCallback, useEffect, useRef, useState } from "react";
import {
    Loader2,
    MousePointer2,
    Sparkles,
    Type,
    X,
} from "lucide-react";
import { api } from "../api/client";
import type { PPTSlideElement } from "../types";

/** 幻灯片物理尺寸（英寸，16:9） */
const SLIDE_W = 13.33;
const SLIDE_H = 7.5;

/** 解析英寸值：兼容 "1.2in" / 纯数字 / EMU 大数 */
function parseInch(v: string | undefined): number | null {
    if (!v) return null;
    const s = String(v).trim();
    const m = s.match(/^(-?[\d.]+)\s*in$/i);
    if (m) return parseFloat(m[1]);
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    // EMU（914400 = 1in）启发：绝对值很大时按 EMU 折算
    if (Math.abs(n) > 1000) return n / 914400;
    return n;
}

interface BoxEl {
    path: string;
    type: string;
    text?: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

function toBox(e: PPTSlideElement): BoxEl | null {
    const x = parseInch(e.x);
    const y = parseInch(e.y);
    const w = parseInch(e.width);
    const h = parseInch(e.height);
    if (x === null || y === null || !w || !h) return null;
    // 跳过接近全幅的背景装饰（>85% 面积），避免误拖背景
    if ((w * h) / (SLIDE_W * SLIDE_H) > 0.85) return null;
    return { path: e.path, type: e.type, text: e.text, x, y, w, h };
}

/**
 * 单页编辑器：在幻灯片截图上叠加可拖拽元素框。
 * - 拖拽移动元素（松手后写回并刷新画面）
 * - 双击文字元素改文字
 * - 底部指令栏：AI 只改本页
 */
export default function SlideEditor({
    filePath,
    slide,
    onFrame,
    onClose,
}: {
    filePath: string;
    slide: number;
    /** 编辑写回后刷新画面（image_data dataURL） */
    onFrame: (imageData: string) => void;
    onClose: () => void;
}) {
    const [boxes, setBoxes] = useState<BoxEl[]>([]);
    const [loading, setLoading] = useState(true);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 正在拖拽的框（本地实时位置，松手才提交）
    const [drag, setDrag] = useState<{ path: string; x: number; y: number } | null>(null);
    // 双击编辑文字
    const [editing, setEditing] = useState<{ path: string; text: string } | null>(null);
    // AI 改本页
    const [instruction, setInstruction] = useState("");
    const [refining, setRefining] = useState(false);

    const stageRef = useRef<HTMLDivElement>(null);
    const dragInfo = useRef<{ path: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

    // 加载本页元素
    const loadElements = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await api.pptSlideElements(filePath, slide);
            setBoxes(res.elements.map(toBox).filter((b): b is BoxEl => b !== null));
        } catch (e) {
            setError(e instanceof Error ? e.message : "读取元素失败");
        } finally {
            setLoading(false);
        }
    }, [filePath, slide]);

    useEffect(() => { loadElements(); }, [loadElements]);

    // ---- 拖拽 ----
    const onBoxPointerDown = (e: React.PointerEvent, b: BoxEl) => {
        if (editing) return;
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragInfo.current = { path: b.path, startX: e.clientX, startY: e.clientY, origX: b.x, origY: b.y };
        setDrag({ path: b.path, x: b.x, y: b.y });
    };
    const onBoxPointerMove = (e: React.PointerEvent) => {
        const d = dragInfo.current;
        const stage = stageRef.current;
        if (!d || !stage) return;
        const rect = stage.getBoundingClientRect();
        const dx = ((e.clientX - d.startX) / rect.width) * SLIDE_W;
        const dy = ((e.clientY - d.startY) / rect.height) * SLIDE_H;
        setDrag({
            path: d.path,
            x: Math.max(0, Math.min(SLIDE_W - 0.2, d.origX + dx)),
            y: Math.max(0, Math.min(SLIDE_H - 0.2, d.origY + dy)),
        });
    };
    const onBoxPointerUp = async (e: React.PointerEvent) => {
        const d = dragInfo.current;
        dragInfo.current = null;
        if (!d) { setDrag(null); return; }
        const final = drag;
        setDrag(null);
        if (!final) return;
        // 位移小于阈值视为误触
        const stage = stageRef.current;
        if (stage) {
            const rect = stage.getBoundingClientRect();
            const movedPx = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
            if (movedPx < 3 || rect.width === 0) return;
        }
        // 提交位置
        setApplying(true);
        setError(null);
        try {
            const res = await api.pptUpdateElements(filePath, slide, [
                { path: d.path, props: { x: `${final.x.toFixed(2)}in`, y: `${final.y.toFixed(2)}in` } },
            ]);
            setBoxes((prev) => prev.map((b) => (b.path === d.path ? { ...b, x: final.x, y: final.y } : b)));
            if (res.image_data) onFrame(res.image_data);
            if (res.errors?.length) setError(res.errors[0]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "移动失败");
            loadElements(); // 失败回退
        } finally {
            setApplying(false);
        }
    };

    // ---- 双击改文字 ----
    const saveText = async () => {
        if (!editing) return;
        const { path, text } = editing;
        setEditing(null);
        setApplying(true);
        setError(null);
        try {
            const res = await api.pptUpdateElements(filePath, slide, [
                { path, props: { text } },
            ]);
            setBoxes((prev) => prev.map((b) => (b.path === path ? { ...b, text } : b)));
            if (res.image_data) onFrame(res.image_data);
            if (res.errors?.length) setError(res.errors[0]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "修改文字失败");
            loadElements();
        } finally {
            setApplying(false);
        }
    };

    // ---- AI 改本页 ----
    const runRefine = async () => {
        const inst = instruction.trim();
        if (!inst || refining) return;
        setRefining(true);
        setError(null);
        try {
            const res = await api.pptRefineSlide(filePath, slide, inst);
            setInstruction("");
            if (res.image_data) onFrame(res.image_data);
            await loadElements();
        } catch (err) {
            setError(err instanceof Error ? err.message : "AI 修改失败");
        } finally {
            setRefining(false);
        }
    };

    const editBox = editing ? boxes.find((b) => b.path === editing.path) : null;

    return (
        <div className="se-root">
            {/* 元素覆盖层（贴在截图上） */}
            <div
                ref={stageRef}
                className="se-stage"
                onPointerMove={onBoxPointerMove}
            >
                {loading && (
                    <div className="se-hint">
                        <Loader2 size={14} className="animate-spin" />
                        读取元素…
                    </div>
                )}
                {!loading && boxes.map((b) => {
                    const isDragging = drag?.path === b.path;
                    const px = isDragging ? drag.x : b.x;
                    const py = isDragging ? drag.y : b.y;
                    return (
                        <div
                            key={b.path}
                            className={`se-box ${b.text ? "se-box-text" : ""} ${isDragging ? "se-box-dragging" : ""}`}
                            style={{
                                left: `${(px / SLIDE_W) * 100}%`,
                                top: `${(py / SLIDE_H) * 100}%`,
                                width: `${(b.w / SLIDE_W) * 100}%`,
                                height: `${(b.h / SLIDE_H) * 100}%`,
                            }}
                            title={b.text ? `${b.text.slice(0, 30)}（拖拽移动，双击改文字）` : "拖拽移动"}
                            onPointerDown={(e) => onBoxPointerDown(e, b)}
                            onPointerUp={onBoxPointerUp}
                            onDoubleClick={(e) => {
                                e.stopPropagation();
                                if (b.text) setEditing({ path: b.path, text: b.text });
                            }}
                        >
                            {b.text && <Type size={9} className="se-box-icon" />}
                        </div>
                    );
                })}

                {/* 双击文字编辑气泡 */}
                {editing && editBox && (
                    <div
                        className="se-text-pop"
                        style={{
                            left: `${Math.min(80, (editBox.x / SLIDE_W) * 100)}%`,
                            top: `${Math.min(70, (editBox.y / SLIDE_H) * 100)}%`,
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        <textarea
                            autoFocus
                            value={editing.text}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveText(); }
                                if (e.key === "Escape") setEditing(null);
                            }}
                            rows={3}
                        />
                        <div className="se-text-pop-actions">
                            <button onClick={() => setEditing(null)}>取消</button>
                            <button className="se-primary" onClick={saveText}>保存</button>
                        </div>
                    </div>
                )}

                {applying && (
                    <div className="se-applying">
                        <Loader2 size={13} className="animate-spin" />
                    </div>
                )}
            </div>

            {/* 底部编辑工具栏 */}
            <div className="se-toolbar">
                <span className="se-toolbar-label">
                    <MousePointer2 size={12} />
                    拖拽移动 · 双击改文字
                </span>
                <div className="se-refine">
                    <input
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") runRefine(); }}
                        placeholder={`让 AI 只改第 ${slide} 页，如「标题更简短」「要点换成三点」…`}
                        disabled={refining}
                    />
                    <button
                        className="se-primary se-refine-btn"
                        onClick={runRefine}
                        disabled={!instruction.trim() || refining}
                    >
                        {refining ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                        改本页
                    </button>
                </div>
                <button className="se-close" onClick={onClose} title="退出编辑">
                    <X size={14} />
                </button>
            </div>
            {error && <div className="se-error">{error}</div>}

            <style>{`
                .se-root {
                    position: absolute;
                    inset: 0;
                    z-index: 5;
                }
                .se-stage {
                    position: absolute;
                    inset: 0;
                }
                .se-hint {
                    position: absolute;
                    top: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 11px;
                    color: #fff;
                    background: rgba(15, 23, 42, 0.6);
                    padding: 4px 12px;
                    border-radius: 999px;
                }
                .se-box {
                    position: absolute;
                    border: 1.5px dashed rgba(124, 58, 237, 0.0);
                    border-radius: 4px;
                    cursor: grab;
                    transition: border-color 0.15s, background 0.15s;
                    touch-action: none;
                }
                .se-box:hover {
                    border-color: rgba(124, 58, 237, 0.75);
                    background: rgba(124, 58, 237, 0.08);
                }
                .se-box-dragging {
                    border-color: #7c3aed;
                    border-style: solid;
                    background: rgba(124, 58, 237, 0.14);
                    cursor: grabbing;
                    z-index: 20;
                }
                .se-box-icon {
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    color: #7c3aed;
                    opacity: 0;
                    transition: opacity 0.15s;
                }
                .se-box:hover .se-box-icon { opacity: 0.9; }
                .se-text-pop {
                    position: absolute;
                    z-index: 30;
                    width: 240px;
                    background: #fff;
                    border: 1px solid #e2e8f0;
                    border-radius: 10px;
                    box-shadow: 0 12px 32px -8px rgba(30, 41, 59, 0.35);
                    padding: 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                .se-text-pop textarea {
                    width: 100%;
                    border: 1px solid #e2e8f0;
                    border-radius: 6px;
                    font-size: 12px;
                    padding: 6px 8px;
                    resize: vertical;
                    outline: none;
                    color: #1e293b;
                }
                .se-text-pop textarea:focus { border-color: #a78bfa; }
                .se-text-pop-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 6px;
                }
                .se-text-pop-actions button {
                    font-size: 11px;
                    padding: 3px 10px;
                    border-radius: 6px;
                    cursor: pointer;
                    color: #64748b;
                    background: #f1f5f9;
                }
                .se-text-pop-actions button.se-primary,
                .se-primary {
                    color: #fff;
                    background: #7c3aed;
                }
                .se-text-pop-actions button.se-primary:hover { background: #6d28d9; }
                .se-applying {
                    position: absolute;
                    top: 10px;
                    right: 10px;
                    width: 26px;
                    height: 26px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #fff;
                    background: rgba(124, 58, 237, 0.85);
                    border-radius: 50%;
                    z-index: 25;
                }
                .se-toolbar {
                    position: absolute;
                    bottom: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: min(720px, calc(100% - 20px));
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 8px 10px;
                    background: rgba(255, 255, 255, 0.94);
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    box-shadow: 0 12px 32px -10px rgba(30, 41, 59, 0.35);
                    backdrop-filter: blur(6px);
                    z-index: 15;
                }
                .se-toolbar-label {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 11px;
                    font-weight: 600;
                    color: #7c3aed;
                    white-space: nowrap;
                }
                .se-refine {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    min-width: 0;
                }
                .se-refine input {
                    flex: 1;
                    min-width: 0;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    font-size: 12px;
                    padding: 6px 10px;
                    outline: none;
                    color: #1e293b;
                    background: #fff;
                }
                .se-refine input:focus { border-color: #a78bfa; }
                .se-refine-btn {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 12px;
                    font-weight: 600;
                    padding: 6px 12px;
                    border-radius: 8px;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background 0.2s;
                }
                .se-refine-btn:hover:not(:disabled) { background: #6d28d9; }
                .se-refine-btn:disabled { opacity: 0.4; cursor: default; }
                .se-close {
                    width: 28px;
                    height: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 8px;
                    color: #64748b;
                    background: #f1f5f9;
                    cursor: pointer;
                    transition: all 0.2s;
                    flex-shrink: 0;
                }
                .se-close:hover { color: #334155; background: #e2e8f0; }
                .se-error {
                    position: absolute;
                    bottom: 66px;
                    left: 50%;
                    transform: translateX(-50%);
                    max-width: calc(100% - 40px);
                    font-size: 11px;
                    color: #e11d48;
                    background: #fff1f2;
                    border: 1px solid #fecdd3;
                    border-radius: 8px;
                    padding: 6px 10px;
                    z-index: 16;
                }
            `}</style>
        </div>
    );
}
