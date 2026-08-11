import { useState } from "react";
import { ArrowLeft, Plus, Trash2, User, CheckCircle2, Circle, Clock } from "lucide-react";

interface HumanTask {
    id: string;
    title: string;
    assignee: string;
    status: "todo" | "doing" | "done";
    note: string;
}

const COLUMNS: { id: HumanTask["status"]; label: string; color: string; icon: typeof Circle }[] = [
    { id: "todo", label: "待办", color: "#64748b", icon: Circle },
    { id: "doing", label: "进行中", color: "#f59e0b", icon: Clock },
    { id: "done", label: "已完成", color: "#10b981", icon: CheckCircle2 },
];

export default function HumanStudio({ onBack }: { onBack: () => void }) {
    const [tasks, setTasks] = useState<HumanTask[]>([
        { id: "1", title: "示例：整理需求文档", assignee: "张三", status: "doing", note: "周五前完成" },
    ]);
    const [title, setTitle] = useState("");
    const [assignee, setAssignee] = useState("");

    const addTask = () => {
        if (!title.trim()) return;
        setTasks((prev) => [
            ...prev,
            { id: Date.now().toString(), title: title.trim(), assignee: assignee.trim() || "未分配", status: "todo", note: "" },
        ]);
        setTitle("");
        setAssignee("");
    };

    const moveTask = (id: string, dir: 1 | -1) => {
        setTasks((prev) =>
            prev.map((t) => {
                if (t.id !== id) return t;
                const order: HumanTask["status"][] = ["todo", "doing", "done"];
                const idx = order.indexOf(t.status);
                const next = Math.max(0, Math.min(2, idx + dir));
                return { ...t, status: order[next] };
            })
        );
    };

    const removeTask = (id: string) => setTasks((prev) => prev.filter((t) => t.id !== id));

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
                <button className="hs-add-btn" onClick={addTask}>
                    <Plus size={15} />
                    添加
                </button>
            </div>

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
                                {items.map((t) => (
                                    <div key={t.id} className="hs-card">
                                        <div className="hs-card-title">{t.title}</div>
                                        <div className="hs-card-meta">
                                            <span className="hs-assignee-tag">
                                                <User size={11} />
                                                {t.assignee}
                                            </span>
                                        </div>
                                        <div className="hs-card-actions">
                                            {t.status !== "todo" && (
                                                <button onClick={() => moveTask(t.id, -1)}>← 上一步</button>
                                            )}
                                            {t.status !== "done" && (
                                                <button className="hs-forward" onClick={() => moveTask(t.id, 1)}>
                                                    下一步 →
                                                </button>
                                            )}
                                            <button className="hs-del" onClick={() => removeTask(t.id)}>
                                                <Trash2 size={13} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
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
                .hs-assignee { width: 160px; }
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
                }
                .hs-add-btn:hover { background: #0f766e; }
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
                .hs-card-title { font-size: 13px; font-weight: 500; color: #1e293b; margin-bottom: 8px; line-height: 1.5; }
                .hs-card-meta { display: flex; gap: 6px; margin-bottom: 8px; }
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
                .hs-card-actions { display: flex; align-items: center; gap: 4px; }
                .hs-card-actions button {
                    font-size: 11px;
                    color: #64748b;
                    background: none;
                    border: 1px solid #e2e8f0;
                    padding: 3px 9px;
                    border-radius: 7px;
                    cursor: pointer;
                }
                .hs-card-actions button:hover { border-color: #cbd5e1; color: #334155; }
                .hs-card-actions .hs-forward { color: #0d9488; border-color: #99f6e4; }
                .hs-card-actions .hs-forward:hover { background: #f0fdfa; }
                .hs-card-actions .hs-del { margin-left: auto; color: #ef4444; border-color: #fecaca; padding: 3px 7px; }
                .hs-card-actions .hs-del:hover { background: #fef2f2; }
                .hs-empty { text-align: center; font-size: 12px; color: #cbd5e1; padding: 24px 0; }
            `}</style>
        </div>
    );
}
