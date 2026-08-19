import { useCallback, useEffect, useState } from "react";
import {
    ArrowLeft,
    Plus,
    Trash2,
    User,
    CheckCircle2,
    Circle,
    Clock,
    FileSearch,
    Paperclip,
    ChevronDown,
    ChevronRight,
    Loader2,
    AlertCircle,
} from "lucide-react";
import { api } from "../../api/client";
import type { HumanCoworkTask } from "../../types";

const COLUMNS: { id: HumanCoworkTask["status"]; label: string; color: string; icon: typeof Circle }[] = [
    { id: "todo", label: "待办", color: "#64748b", icon: Circle },
    { id: "doing", label: "进行中", color: "#f59e0b", icon: Clock },
    { id: "done", label: "已完成", color: "#10b981", icon: CheckCircle2 },
];

export default function HumanStudio({ onBack }: { onBack: () => void }) {
    const [tasks, setTasks] = useState<HumanCoworkTask[]>([]);
    const [title, setTitle] = useState("");
    const [assignee, setAssignee] = useState("");
    const [error, setError] = useState("");

    // 文件提取要求（发起者指定本机文件，要求负责人提取）
    const [reqOpen, setReqOpen] = useState(false);
    const [filePath, setFilePath] = useState("");
    const [extractNote, setExtractNote] = useState("");

    const [extractingId, setExtractingId] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.coworkHumanListTasks();
            setTasks(res.tasks);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载失败");
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const addTask = async () => {
        if (!title.trim()) return;
        try {
            const res = await api.coworkHumanSaveTask({
                title: title.trim(),
                assignee: assignee.trim() || "未分配",
                status: "todo",
                note: "",
                file_path: filePath.trim(),
                extract_note: extractNote.trim(),
            });
            setTasks((prev) => [res.task, ...prev]);
            setTitle("");
            setAssignee("");
            setFilePath("");
            setExtractNote("");
            setReqOpen(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : "添加失败");
        }
    };

    const moveTask = async (t: HumanCoworkTask, dir: 1 | -1) => {
        const order: HumanCoworkTask["status"][] = ["todo", "doing", "done"];
        const idx = order.indexOf(t.status);
        const next = order[Math.max(0, Math.min(2, idx + dir))];
        if (next === t.status) return;
        const updated = { ...t, status: next };
        setTasks((prev) => prev.map((x) => (x.id === t.id ? updated : x)));
        try {
            await api.coworkHumanSaveTask(updated);
        } catch {
            load();
        }
    };

    const removeTask = async (id: string) => {
        setTasks((prev) => prev.filter((t) => t.id !== id));
        try {
            await api.coworkHumanDeleteTask(id);
        } catch { /* 忽略 */ }
    };

    // 执行提取：读取任务指定的本机文件 → 提取 → 结果回填
    const runExtract = async (id: string) => {
        if (extractingId) return;
        setExtractingId(id);
        setExpandedId(id);
        setError("");
        try {
            const res = await api.coworkHumanExtract(id);
            setTasks((prev) => prev.map((t) => (t.id === id ? res.task : t)));
        } catch (e) {
            setError(e instanceof Error ? e.message : "提取失败");
        } finally {
            setExtractingId(null);
        }
    };

    const fieldEntries = (t: HumanCoworkTask): [string, unknown][] =>
        t.extract_fields && typeof t.extract_fields === "object"
            ? Object.entries(t.extract_fields)
            : [];

    return (
        <div className="hs-root">
            <div className="hs-topbar">
                <button className="hs-back" onClick={onBack}>
                    <ArrowLeft size={16} />
                </button>
                <h1>人工协作</h1>
                <span className="hs-count">{tasks.length} 项任务</span>
            </div>

            <div className="hs-addbar">
                <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTask()}
                    placeholder="输入新的工作项…"
                />
                <input
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTask()}
                    placeholder="负责人（可选）"
                    className="hs-assignee"
                />
                <button
                    className={`hs-req-toggle ${reqOpen || filePath ? "on" : ""}`}
                    onClick={() => setReqOpen(!reqOpen)}
                    title="指定本地文件，要求负责人提取内容"
                >
                    <Paperclip size={14} />
                    文件提取
                </button>
                <button className="hs-add-btn" onClick={addTask}>
                    <Plus size={15} />
                    添加
                </button>
            </div>

            {reqOpen && (
                <div className="hs-req-panel">
                    <div className="hs-req-row">
                        <span className="hs-req-label">本地文件</span>
                        <input
                            value={filePath}
                            onChange={(e) => setFilePath(e.target.value)}
                            placeholder="我指定的本机文件绝对路径，如 D:\材料\护照.pdf（图片/PDF/Office/文本）"
                        />
                    </div>
                    <div className="hs-req-row">
                        <span className="hs-req-label">提取要求</span>
                        <input
                            value={extractNote}
                            onChange={(e) => setExtractNote(e.target.value)}
                            placeholder="要提取的内容，如：姓名、护照号、有效期（按逗号分隔作为字段）"
                        />
                    </div>
                    <p className="hs-req-hint">
                        指定后任务卡会出现「提取」按钮：负责人点击即由系统读取该文件并按提取要求回填结果，来源写入任务卡片。
                    </p>
                </div>
            )}

            {error && (
                <div className="hs-error">
                    <AlertCircle size={14} />
                    {error}
                </div>
            )}

            <div className="hs-board">
                {COLUMNS.map((col) => {
                    const Icon = col.icon;
                    const items = tasks.filter((t) => t.status === col.id);
                    return (
                        <div key={col.id} className="hs-col">
                            <div className="hs-col-head">
                                <Icon size={15} color={col.color} />
                                <span>{col.label}</span>
                                <span className="hs-col-count">{items.length}</span>
                            </div>
                            <div className="hs-col-body">
                                {items.map((t) => {
                                    const expanded = expandedId === t.id;
                                    return (
                                        <div key={t.id} className={`hs-card ${t.file_path ? "has-file" : ""}`}>
                                            <div className="hs-card-title">{t.title}</div>
                                            <div className="hs-card-meta">
                                                <span className="hs-assignee-tag">
                                                    <User size={11} />
                                                    {t.assignee}
                                                </span>
                                                {t.file_path && (
                                                    <span className="hs-file-tag" title={t.file_path}>
                                                        <Paperclip size={10} />
                                                        {t.file_path.split(/[\\/]/).pop()}
                                                    </span>
                                                )}
                                                {t.extracted_at > 0 && (
                                                    <span className="hs-extracted-tag">
                                                        <CheckCircle2 size={10} />
                                                        已提取
                                                    </span>
                                                )}
                                            </div>

                                            {t.file_path && (
                                                <div className="hs-card-filepath">{t.file_path}</div>
                                            )}
                                            {t.extract_note && (
                                                <div className="hs-card-note">要求：{t.extract_note}</div>
                                            )}

                                            {(t.file_path || t.extract_text || fieldEntries(t).length > 0) && (
                                                <div className="hs-card-actions">
                                                    {t.file_path && (
                                                        <button
                                                            className="hs-extract"
                                                            onClick={() => runExtract(t.id)}
                                                            disabled={extractingId !== null}
                                                        >
                                                            {extractingId === t.id ? (
                                                                <Loader2 size={11} className="hs-spin" />
                                                            ) : (
                                                                <FileSearch size={11} />
                                                            )}
                                                            {t.extracted_at > 0 ? "重新提取" : "提取"}
                                                        </button>
                                                    )}
                                                    {(t.extract_text || fieldEntries(t).length > 0) && (
                                                        <button className="hs-toggle" onClick={() => setExpandedId(expanded ? null : t.id)}>
                                                            结果 {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                                        </button>
                                                    )}
                                                </div>
                                            )}

                                            {expanded && (t.extract_text || fieldEntries(t).length > 0) && (
                                                <div className="hs-extract-result">
                                                    {fieldEntries(t).length > 0 && (
                                                        <div className="hs-fields">
                                                            {fieldEntries(t).map(([k, v]) => (
                                                                <div key={k} className="hs-field-row">
                                                                    <span className="hs-field-key">{k}</span>
                                                                    <span className="hs-field-val">{String(v ?? "")}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {t.extract_text && (
                                                        <pre className="hs-extract-text">{t.extract_text}</pre>
                                                    )}
                                                    {t.extract_method && (
                                                        <div className="hs-extract-method">方式：{t.extract_method}</div>
                                                    )}
                                                </div>
                                            )}

                                            <div className="hs-card-actions hs-bottom">
                                                {t.status !== "todo" && (
                                                    <button onClick={() => moveTask(t, -1)}>← 上一步</button>
                                                )}
                                                {t.status !== "done" && (
                                                    <button className="hs-forward" onClick={() => moveTask(t, 1)}>
                                                        下一步 →
                                                    </button>
                                                )}
                                                <button className="hs-del" onClick={() => removeTask(t.id)}>
                                                    <Trash2 size={13} />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                                {items.length === 0 && <div className="hs-empty">暂无任务</div>}
                            </div>
                        </div>
                    );
                })}
            </div>

            <style>{`
                .hs-root {
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    background: #f8fafc;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                }
                .hs-topbar {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 16px 24px;
                    background: #fff;
                    border-bottom: 1px solid #e2e8f0;
                }
                .hs-back {
                    width: 34px; height: 34px;
                    display: flex; align-items: center; justify-content: center;
                    border-radius: 10px;
                    color: #64748b;
                    background: #f1f5f9;
                    cursor: pointer;
                    border: none;
                }
                .hs-back:hover { background: #e2e8f0; color: #334155; }
                .hs-topbar h1 { font-size: 18px; font-weight: 650; color: #0f172a; margin: 0; }
                .hs-count { font-size: 12px; color: #94a3b8; }
                .hs-addbar {
                    display: flex;
                    gap: 10px;
                    padding: 16px 24px;
                    background: #fff;
                    border-bottom: 1px solid #f1f5f9;
                    align-items: center;
                }
                .hs-addbar input {
                    border: 1px solid #e2e8f0;
                    border-radius: 10px;
                    padding: 9px 14px;
                    font-size: 13px;
                    outline: none;
                    color: #1e293b;
                    background: #f8fafc;
                }
                .hs-addbar input:focus { border-color: #14b8a6; background: #fff; }
                .hs-addbar input:first-child { flex: 1; }
                .hs-assignee { width: 140px; }
                .hs-add-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 13px;
                    font-weight: 600;
                    color: #fff;
                    background: #0d9488;
                    border: none;
                    padding: 9px 18px;
                    border-radius: 10px;
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .hs-add-btn:hover { background: #0f766e; }
                .hs-req-toggle {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 12px;
                    font-weight: 600;
                    color: #64748b;
                    background: #f1f5f9;
                    border: 1px solid #e2e8f0;
                    padding: 8px 14px;
                    border-radius: 10px;
                    cursor: pointer;
                    flex-shrink: 0;
                    transition: all 0.15s;
                }
                .hs-req-toggle:hover { color: #0d9488; border-color: #99f6e4; }
                .hs-req-toggle.on { color: #0d9488; background: #f0fdfa; border-color: #5eead4; }
                .hs-req-panel {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    padding: 14px 24px;
                    background: #f0fdfa;
                    border-bottom: 1px solid #ccfbf1;
                }
                .hs-req-row { display: flex; align-items: center; gap: 10px; }
                .hs-req-label {
                    font-size: 12px;
                    font-weight: 600;
                    color: #0f766e;
                    width: 60px;
                    flex-shrink: 0;
                }
                .hs-req-row input {
                    flex: 1;
                    border: 1px solid #99f6e4;
                    border-radius: 9px;
                    padding: 8px 12px;
                    font-size: 12.5px;
                    outline: none;
                    color: #1e293b;
                    background: #fff;
                }
                .hs-req-row input:focus { border-color: #14b8a6; }
                .hs-req-row input::placeholder { color: #94a3b8; }
                .hs-req-hint { font-size: 11px; color: #94a3b8; margin: 0; line-height: 1.6; }
                .hs-error {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    margin: 12px 24px 0;
                    font-size: 12px;
                    color: #e11d48;
                    background: #fff1f2;
                    border: 1px solid #fecdd3;
                    padding: 9px 14px;
                    border-radius: 11px;
                }
                .hs-board {
                    flex: 1;
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 16px;
                    padding: 20px 24px;
                    overflow: auto;
                }
                .hs-col {
                    display: flex;
                    flex-direction: column;
                    background: #fff;
                    border: 1px solid #e2e8f0;
                    border-radius: 16px;
                    overflow: hidden;
                }
                .hs-col-head {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    padding: 13px 16px;
                    font-size: 13px;
                    font-weight: 600;
                    color: #334155;
                    border-bottom: 1px solid #f1f5f9;
                }
                .hs-col-count {
                    margin-left: auto;
                    font-size: 11px;
                    color: #94a3b8;
                    background: #f1f5f9;
                    padding: 1px 8px;
                    border-radius: 999px;
                }
                .hs-col-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 120px; }
                .hs-card {
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 12px;
                    transition: box-shadow 0.18s;
                }
                .hs-card:hover { box-shadow: 0 6px 16px -8px rgba(15,23,42,0.15); }
                .hs-card.has-file { border-color: #99f6e4; background: #fdfffe; }
                .hs-card-title { font-size: 13px; font-weight: 500; color: #1e293b; margin-bottom: 8px; line-height: 1.5; }
                .hs-card-meta { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
                .hs-assignee-tag {
                    display: inline-flex;
                    align-items: center;
                    gap: 3px;
                    font-size: 11px;
                    color: #475569;
                    background: #f1f5f9;
                    padding: 2px 8px;
                    border-radius: 999px;
                }
                .hs-file-tag {
                    display: inline-flex;
                    align-items: center;
                    gap: 3px;
                    font-size: 11px;
                    color: #0f766e;
                    background: #f0fdfa;
                    border: 1px solid #ccfbf1;
                    padding: 2px 8px;
                    border-radius: 999px;
                    max-width: 160px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .hs-extracted-tag {
                    display: inline-flex;
                    align-items: center;
                    gap: 3px;
                    font-size: 11px;
                    color: #047857;
                    background: #ecfdf5;
                    padding: 2px 8px;
                    border-radius: 999px;
                }
                .hs-card-filepath {
                    font-size: 11px;
                    color: #0f766e;
                    background: #f0fdfa;
                    border-radius: 8px;
                    padding: 6px 9px;
                    margin-bottom: 6px;
                    word-break: break-all;
                    line-height: 1.5;
                    font-family: "SF Mono", "Cascadia Code", "Consolas", monospace;
                }
                .hs-card-note { font-size: 11px; color: #64748b; margin-bottom: 6px; line-height: 1.6; }
                .hs-card-actions { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
                .hs-card-actions.hs-bottom { margin-bottom: 0; margin-top: 4px; }
                .hs-card-actions button {
                    font-size: 11px;
                    color: #64748b;
                    background: none;
                    border: 1px solid #e2e8f0;
                    padding: 3px 9px;
                    border-radius: 7px;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                }
                .hs-card-actions button:hover { border-color: #cbd5e1; color: #334155; }
                .hs-card-actions .hs-forward { color: #0d9488; border-color: #99f6e4; }
                .hs-card-actions .hs-forward:hover { background: #f0fdfa; }
                .hs-card-actions .hs-del { margin-left: auto; color: #ef4444; border-color: #fecaca; padding: 3px 7px; }
                .hs-card-actions .hs-del:hover { background: #fef2f2; }
                .hs-extract { color: #0d9488; border-color: #5eead4; font-weight: 600; }
                .hs-extract:hover:not(:disabled) { background: #f0fdfa; }
                .hs-extract:disabled { opacity: 0.5; cursor: default; }
                .hs-spin { animation: hs-rotate 0.9s linear infinite; }
                @keyframes hs-rotate { to { transform: rotate(360deg); } }
                .hs-toggle { color: #475569; }
                .hs-extract-result {
                    margin-top: 6px;
                    border-top: 1px dashed #e2e8f0;
                    padding-top: 8px;
                }
                .hs-fields { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
                .hs-field-row {
                    display: flex;
                    gap: 8px;
                    font-size: 11.5px;
                    background: #f8fafc;
                    border-radius: 7px;
                    padding: 5px 9px;
                }
                .hs-field-key { color: #0f766e; font-weight: 600; flex-shrink: 0; }
                .hs-field-val { color: #334155; word-break: break-all; }
                .hs-extract-text {
                    margin: 0 0 6px;
                    font-size: 11px;
                    line-height: 1.6;
                    color: #475569;
                    white-space: pre-wrap;
                    word-break: break-word;
                    max-height: 180px;
                    overflow-y: auto;
                    background: #f8fafc;
                    border-radius: 8px;
                    padding: 8px 10px;
                }
                .hs-extract-method { font-size: 10px; color: #94a3b8; }
                .hs-empty { text-align: center; font-size: 12px; color: #cbd5e1; padding: 24px 0; }
            `}</style>
        </div>
    );
}
