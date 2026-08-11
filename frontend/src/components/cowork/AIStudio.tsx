import { useCallback, useEffect, useRef, useState } from "react";
import {
    ArrowLeft,
    Plus,
    Trash2,
    Edit3,
    Save,
    X,
    Send,
    Loader2,
    CheckCircle2,
    XCircle,
    Clock,
    Cpu,
    BookOpen,
    User as UserIcon,
    Sparkles,
    RefreshCw,
    FileText,
    Shield,
    ChevronDown,
    ChevronRight,
} from "lucide-react";
import { api } from "../../api/client";
import type { CoworkSkill, CoworkClient, CoworkDispatchEvent, CoworkTask } from "../../types";

type TimelineItem = {
    id: string;
    kind: "status" | "client_start" | "client_done" | "qc";
    label: string;
    detail?: string;
    status?: "ok" | "fail" | "pending" | "running";
    round?: number;
    ts: number;
};

type SideTab = "skills" | "clients" | "profile";

export default function AIStudio({ onBack }: { onBack: () => void }) {
    const [sideTab, setSideTab] = useState<SideTab>("skills");
    const [skills, setSkills] = useState<CoworkSkill[]>([]);
    const [clients, setClients] = useState<CoworkClient[]>([]);
    const [profile, setProfile] = useState("");
    const [profileEditing, setProfileEditing] = useState(false);
    const [profileDraft, setProfileDraft] = useState("");

    // 技能编辑
    const [editingSkill, setEditingSkill] = useState<CoworkSkill | null>(null);
    const [skillDraft, setSkillDraft] = useState({ name: "", description: "", content: "", category: "general" });

    // 选中状态
    const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
    const [selectedClients, setSelectedClients] = useState<Set<string>>(new Set());

    // 任务
    const [instruction, setInstruction] = useState("");
    const [maxRounds, setMaxRounds] = useState(2);
    const [running, setRunning] = useState(false);
    const [timeline, setTimeline] = useState<TimelineItem[]>([]);
    const [finalResult, setFinalResult] = useState("");
    const [qcReview, setQcReview] = useState("");
    const [qcPassed, setQcPassed] = useState<boolean | null>(null);
    const [currentRound, setCurrentRound] = useState(0);
    const [error, setError] = useState("");
    const [resultExpanded, setResultExpanded] = useState(true);

    const logEndRef = useRef<HTMLDivElement>(null);

    const loadAll = useCallback(async () => {
        try {
            const [sk, cl, pf] = await Promise.all([
                api.coworkListSkills(),
                api.coworkDetectClients(),
                api.coworkGetProfile(),
            ]);
            setSkills(sk.skills);
            setClients(cl.clients);
            setProfile(pf.profile);
            // 默认选中可用的客户端
            setSelectedClients(new Set(cl.clients.filter((c) => c.available).map((c) => c.id)));
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载失败");
        }
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [timeline]);

    const addLog = (item: Omit<TimelineItem, "id" | "ts">) => {
        setTimeline((prev) => [...prev, { ...item, id: Math.random().toString(36).slice(2), ts: Date.now() }]);
    };

    // ---- 技能 CRUD ----
    const startNewSkill = () => {
        setEditingSkill(null);
        setSkillDraft({ name: "", description: "", content: "", category: "general" });
    };
    const startEditSkill = (s: CoworkSkill) => {
        setEditingSkill(s);
        setSkillDraft({ name: s.name, description: s.description, content: s.content, category: s.category });
    };
    const saveSkill = async () => {
        if (!skillDraft.name.trim()) return;
        try {
            const res = await api.coworkSaveSkill({
                id: editingSkill?.id || undefined,
                ...skillDraft,
            });
            setSkills((prev) => {
                const idx = prev.findIndex((s) => s.id === res.skill.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = res.skill; return next; }
                return [res.skill, ...prev];
            });
            setEditingSkill(res.skill);
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存失败");
        }
    };
    const removeSkill = async (id: string) => {
        if (!confirm("确定删除该技能？")) return;
        await api.coworkDeleteSkill(id);
        setSkills((prev) => prev.filter((s) => s.id !== id));
        setSelectedSkills((prev) => { const n = new Set(prev); n.delete(id); return n; });
        if (editingSkill?.id === id) setEditingSkill(null);
    };

    const toggleSkill = (id: string) => {
        setSelectedSkills((prev) => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });
    };
    const toggleClient = (id: string) => {
        setSelectedClients((prev) => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });
    };

    const saveProfile = async () => {
        const res = await api.coworkUpdateProfile(profileDraft, false);
        setProfile(res.profile);
        setProfileEditing(false);
    };

    // ---- 派发任务 ----
    const dispatch = async () => {
        if (!instruction.trim() || running) return;
        if (selectedClients.size === 0) { setError("请至少选择一个客户端"); return; }
        setRunning(true);
        setError("");
        setTimeline([]);
        setFinalResult("");
        setQcReview("");
        setQcPassed(null);
        setCurrentRound(0);

        addLog({ kind: "status", label: "中央 AI 已接收任务", detail: instruction.slice(0, 80), status: "running" });

        try {
            await api.coworkDispatch(
                {
                    instruction,
                    skill_ids: Array.from(selectedSkills),
                    client_ids: Array.from(selectedClients),
                    max_rounds: maxRounds,
                },
                (ev: CoworkDispatchEvent) => {
                    if (ev.type === "status") {
                        setCurrentRound(ev.round);
                        const icon = ev.stage === "qc" ? "品控中" : ev.stage === "retry" ? "迭代" : ev.stage === "done" ? "完成" : ev.message;
                        addLog({
                            kind: "status",
                            label: icon,
                            detail: ev.message,
                            round: ev.round,
                            status: ev.stage === "done" ? "ok" : ev.stage === "error" ? "fail" : "running",
                        });
                    } else if (ev.type === "client_start") {
                        addLog({ kind: "client_start", label: ev.client_name, detail: "开始执行…", status: "running" });
                    } else if (ev.type === "client_done") {
                        addLog({
                            kind: "client_done",
                            label: ev.client_id,
                            detail: ev.status === "done" ? `完成（${ev.elapsed.toFixed(1)}s）${ev.result_preview ? "— " + ev.result_preview.slice(0, 60) : ""}` : `失败：${ev.error || ""}`,
                            status: ev.status === "done" ? "ok" : "fail",
                        });
                    } else if (ev.type === "qc") {
                        setQcReview(ev.review);
                        setQcPassed(ev.passed);
                        addLog({
                            kind: "qc",
                            label: ev.passed ? "品控通过" : "品控未通过",
                            detail: ev.review.slice(0, 200) + (ev.feedback ? `\n修正意见：${ev.feedback.slice(0, 150)}` : ""),
                            status: ev.passed ? "ok" : "fail",
                            round: ev.round,
                        });
                    } else if (ev.type === "done") {
                        const task = ev.task as CoworkTask;
                        setFinalResult(task.final_result || "");
                        setRunning(false);
                    }
                }
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : "派发失败");
            setRunning(false);
        }
    };

    const clientName = (id: string) => clients.find((c) => c.id === id)?.name || id;

    return (
        <div className="ais-root">
            {/* 顶部栏 */}
            <div className="ais-topbar">
                <button className="ais-back" onClick={onBack}><ArrowLeft size={16} /></button>
                <div className="ais-title">
                    <Cpu size={18} />
                    <span>AI 协作 · 中央 AI</span>
                </div>
                <div className="ais-topbar-right">
                    <span className="ais-round-badge" style={{ opacity: currentRound ? 1 : 0 }}>
                        第 {currentRound} 轮
                    </span>
                    <button className="ais-refresh" onClick={loadAll} title="刷新客户端与技能">
                        <RefreshCw size={14} />
                    </button>
                </div>
            </div>

            <div className="ais-body">
                {/* 左侧边栏 */}
                <aside className="ais-sidebar">
                    <div className="ais-tabs">
                        <button className={sideTab === "skills" ? "on" : ""} onClick={() => setSideTab("skills")}>
                            <BookOpen size={14} /> 技能库
                        </button>
                        <button className={sideTab === "clients" ? "on" : ""} onClick={() => setSideTab("clients")}>
                            <Cpu size={14} /> 客户端
                        </button>
                        <button className={sideTab === "profile" ? "on" : ""} onClick={() => setSideTab("profile")}>
                            <UserIcon size={14} /> 风格画像
                        </button>
                    </div>

                    <div className="ais-side-content">
                        {sideTab === "skills" && (
                            <div className="ais-skills">
                                <button className="ais-new-btn" onClick={startNewSkill}>
                                    <Plus size={14} /> 新建技能
                                </button>
                                {editingSkill !== null || skillDraft.name ? (
                                    <div className="ais-skill-editor">
                                        <input
                                            value={skillDraft.name}
                                            onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
                                            placeholder="技能名称"
                                        />
                                        <input
                                            value={skillDraft.description}
                                            onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })}
                                            placeholder="一句话描述"
                                        />
                                        <textarea
                                            value={skillDraft.content}
                                            onChange={(e) => setSkillDraft({ ...skillDraft, content: e.target.value })}
                                            placeholder="技能内容：风格要求、工作流程、检查清单等，中央 AI 会把它注入任务指令"
                                            rows={8}
                                        />
                                        <div className="ais-editor-actions">
                                            <button onClick={() => { setEditingSkill(null); setSkillDraft({ name: "", description: "", content: "", category: "general" }); }}>
                                                <X size={13} /> 取消
                                            </button>
                                            <button className="ais-primary" onClick={saveSkill}>
                                                <Save size={13} /> 保存
                                            </button>
                                        </div>
                                    </div>
                                ) : null}
                                <div className="ais-skill-list">
                                    {skills.map((s) => (
                                        <div
                                            key={s.id}
                                            className={`ais-skill-item ${selectedSkills.has(s.id) ? "selected" : ""}`}
                                            onClick={() => toggleSkill(s.id)}
                                        >
                                            <div className="ais-skill-check">
                                                {selectedSkills.has(s.id) ? <CheckCircle2 size={15} /> : <div className="ais-circle" />}
                                            </div>
                                            <div className="ais-skill-info" onDoubleClick={(e) => { e.stopPropagation(); startEditSkill(s); }}>
                                                <div className="ais-skill-name">{s.name}</div>
                                                {s.description && <div className="ais-skill-desc">{s.description}</div>}
                                            </div>
                                            <button className="ais-icon-btn" onClick={(e) => { e.stopPropagation(); startEditSkill(s); }}>
                                                <Edit3 size={12} />
                                            </button>
                                            <button className="ais-icon-btn ais-del" onClick={(e) => { e.stopPropagation(); removeSkill(s.id); }}>
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    ))}
                                    {skills.length === 0 && (
                                        <div className="ais-empty-hint">
                                            还没有技能。<br />点击"新建技能"沉淀你的风格与要求。
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {sideTab === "clients" && (
                            <div className="ais-clients">
                                <p className="ais-side-hint">选择要派发任务的本机编码客户端。中央 AI 会并行向它们发送任务。</p>
                                {clients.map((c) => (
                                    <div
                                        key={c.id}
                                        className={`ais-client-item ${c.available ? "available" : "unavailable"} ${selectedClients.has(c.id) ? "selected" : ""}`}
                                        onClick={() => c.available && toggleClient(c.id)}
                                    >
                                        <div className="ais-client-status">
                                            {c.available ? <CheckCircle2 size={16} className="ais-ok" /> : <XCircle size={16} className="ais-no" />}
                                        </div>
                                        <div className="ais-client-info">
                                            <div className="ais-client-name">{c.name}</div>
                                            <div className="ais-client-path">{c.available ? (c.version || c.path) : `未检测到 · ${c.hint}`}</div>
                                        </div>
                                    </div>
                                ))}
                                <button className="ais-redetect" onClick={loadAll}>
                                    <RefreshCw size={13} /> 重新检测
                                </button>
                            </div>
                        )}

                        {sideTab === "profile" && (
                            <div className="ais-profile">
                                <p className="ais-side-hint">
                                    用户风格画像。中央 AI 在品控通过后会自动沉淀要点；你也可以手动编写对产出的通用要求（语气、格式、禁忌等）。
                                </p>
                                {profileEditing ? (
                                    <>
                                        <textarea
                                            value={profileDraft}
                                            onChange={(e) => setProfileDraft(e.target.value)}
                                            rows={14}
                                            placeholder="例如：代码必须有类型注解；中文文案不用敬语；报告用结论先行…"
                                        />
                                        <div className="ais-editor-actions">
                                            <button onClick={() => setProfileEditing(false)}>取消</button>
                                            <button className="ais-primary" onClick={saveProfile}>保存画像</button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="ais-profile-text">
                                            {profile || <span className="ais-empty-hint">尚未积累风格画像。</span>}
                                        </div>
                                        <button className="ais-new-btn" onClick={() => { setProfileDraft(profile); setProfileEditing(true); }}>
                                            <Edit3 size={13} /> 编辑画像
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </aside>

                {/* 主区域 */}
                <main className="ais-main">
                    {/* 任务输入 */}
                    <div className="ais-task-card">
                        <textarea
                            value={instruction}
                            onChange={(e) => setInstruction(e.target.value)}
                            placeholder="描述你要完成的任务，例如：「用 React 写一个待办清单组件，带本地存储，代码要有类型注解」。中央 AI 会组装技能与风格后派发给选中的客户端。"
                            rows={3}
                            disabled={running}
                        />
                        <div className="ais-task-bar">
                            <div className="ais-selected-chips">
                                {Array.from(selectedSkills).map((id) => {
                                    const s = skills.find((x) => x.id === id);
                                    return s ? <span key={id} className="ais-chip ais-chip-skill"><BookOpen size={10} />{s.name}</span> : null;
                                })}
                                {Array.from(selectedClients).map((id) => {
                                    const c = clients.find((x) => x.id === id);
                                    return c ? <span key={id} className="ais-chip ais-chip-client"><Cpu size={10} />{c.name}</span> : null;
                                })}
                            </div>
                            <div className="ais-task-actions">
                                <label className="ais-rounds">
                                    品控轮次
                                    <select value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))} disabled={running}>
                                        <option value={1}>1</option>
                                        <option value={2}>2</option>
                                        <option value={3}>3</option>
                                        <option value={5}>5</option>
                                    </select>
                                </label>
                                <button
                                    className="ais-dispatch"
                                    onClick={dispatch}
                                    disabled={running || !instruction.trim() || selectedClients.size === 0}
                                >
                                    {running ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                                    {running ? "执行中…" : "派发任务"}
                                </button>
                            </div>
                        </div>
                    </div>

                    {error && <div className="ais-error"><XCircle size={14} />{error}</div>}

                    {/* 时间线 + 结果 */}
                    <div className="ais-output">
                        {timeline.length === 0 && !running && (
                            <div className="ais-welcome">
                                <Sparkles size={32} className="ais-welcome-icon" />
                                <h3>中央 AI 已就绪</h3>
                                <p>在左侧勾选要应用的技能和执行客户端，输入任务后点击"派发任务"。<br />中央 AI 会并行派发、收集产出、自动品控，不合格则带反馈迭代。</p>
                            </div>
                        )}

                        {timeline.length > 0 && (
                            <div className="ais-timeline">
                                {timeline.map((item) => (
                                    <div key={item.id} className={`ais-tl-item ais-tl-${item.status || "pending"}`}>
                                        <div className="ais-tl-dot">
                                            {item.status === "ok" ? <CheckCircle2 size={14} /> :
                                             item.status === "fail" ? <XCircle size={14} /> :
                                             item.status === "running" ? <Loader2 size={14} className="animate-spin" /> :
                                             <Clock size={14} />}
                                        </div>
                                        <div className="ais-tl-body">
                                            <div className="ais-tl-label">
                                                {item.kind === "client_start" || item.kind === "client_done" ? clientName(item.label) : item.label}
                                                {item.round ? <span className="ais-tl-round">R{item.round}</span> : null}
                                            </div>
                                            {item.detail && <div className="ais-tl-detail">{item.detail}</div>}
                                        </div>
                                    </div>
                                ))}
                                <div ref={logEndRef} />
                            </div>
                        )}

                        {/* 品控评语 */}
                        {qcReview && (
                            <div className={`ais-qc ${qcPassed ? "pass" : "fail"}`}>
                                <div className="ais-qc-head">
                                    <Shield size={15} />
                                    <span>中央 AI 品控评语</span>
                                    {qcPassed !== null && (
                                        <span className={`ais-qc-badge ${qcPassed ? "pass" : "fail"}`}>
                                            {qcPassed ? "通过" : "需修改"}
                                        </span>
                                    )}
                                </div>
                                <div className="ais-qc-text">{qcReview}</div>
                            </div>
                        )}

                        {/* 最终结果 */}
                        {finalResult && (
                            <div className="ais-result">
                                <div className="ais-result-head" onClick={() => setResultExpanded(!resultExpanded)}>
                                    <FileText size={15} />
                                    <span>最终产出</span>
                                    {resultExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </div>
                                {resultExpanded && (
                                    <pre className="ais-result-body">{finalResult}</pre>
                                )}
                            </div>
                        )}
                    </div>
                </main>
            </div>

            <style>{`
                .ais-root {
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    background: #f8fafc;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                    color: #1e293b;
                }
                .ais-topbar {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px 20px;
                    background: #fff;
                    border-bottom: 1px solid #e2e8f0;
                }
                .ais-back {
                    width: 34px; height: 34px;
                    display: flex; align-items: center; justify-content: center;
                    border-radius: 10px;
                    color: #64748b;
                    background: #f1f5f9;
                    border: none;
                    cursor: pointer;
                }
                .ais-back:hover { background: #e2e8f0; color: #334155; }
                .ais-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 650; color: #0f172a; }
                .ais-topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
                .ais-round-badge {
                    font-size: 12px; font-weight: 600; color: #7c3aed;
                    background: #f5f3ff; padding: 4px 12px; border-radius: 999px;
                    transition: opacity 0.3s;
                }
                .ais-refresh {
                    width: 32px; height: 32px;
                    display: flex; align-items: center; justify-content: center;
                    border-radius: 9px; border: 1px solid #e2e8f0;
                    color: #64748b; background: #fff; cursor: pointer;
                }
                .ais-refresh:hover { border-color: #a78bfa; color: #7c3aed; }

                .ais-body { flex: 1; display: flex; overflow: hidden; }

                /* 侧边栏 */
                .ais-sidebar {
                    width: 300px;
                    flex-shrink: 0;
                    display: flex;
                    flex-direction: column;
                    background: #fff;
                    border-right: 1px solid #e2e8f0;
                }
                .ais-tabs {
                    display: flex;
                    border-bottom: 1px solid #f1f5f9;
                    padding: 0 8px;
                }
                .ais-tabs button {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 5px;
                    font-size: 12px;
                    font-weight: 500;
                    color: #64748b;
                    background: none;
                    border: none;
                    padding: 12px 4px;
                    cursor: pointer;
                    border-bottom: 2px solid transparent;
                    transition: all 0.15s;
                }
                .ais-tabs button:hover { color: #475569; }
                .ais-tabs button.on { color: #7c3aed; border-bottom-color: #7c3aed; }
                .ais-side-content { flex: 1; overflow-y: auto; padding: 14px; }
                .ais-side-hint { font-size: 11px; line-height: 1.6; color: #94a3b8; margin: 0 0 14px; }

                .ais-new-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 12px;
                    font-weight: 600;
                    color: #7c3aed;
                    background: #f5f3ff;
                    border: 1px solid #ddd6fe;
                    padding: 7px 13px;
                    border-radius: 9px;
                    cursor: pointer;
                    width: 100%;
                    justify-content: center;
                    margin-bottom: 12px;
                }
                .ais-new-btn:hover { background: #ede9fe; }

                .ais-skill-editor {
                    display: flex;
                    flex-direction: column;
                    gap: 7px;
                    padding: 12px;
                    background: #f8fafc;
                    border: 1px solid #e2e8f0;
                    border-radius: 11px;
                    margin-bottom: 12px;
                }
                .ais-skill-editor input, .ais-skill-editor textarea {
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    padding: 7px 10px;
                    font-size: 12px;
                    outline: none;
                    color: #1e293b;
                    background: #fff;
                    font-family: inherit;
                }
                .ais-skill-editor textarea { resize: vertical; }
                .ais-skill-editor input:focus, .ais-skill-editor textarea:focus { border-color: #a78bfa; }
                .ais-editor-actions { display: flex; justify-content: flex-end; gap: 6px; }
                .ais-editor-actions button {
                    display: inline-flex; align-items: center; gap: 4px;
                    font-size: 11px; padding: 5px 11px;
                    border-radius: 7px; border: 1px solid #e2e8f0;
                    background: #fff; color: #64748b; cursor: pointer;
                }
                .ais-editor-actions button.ais-primary { background: #7c3aed; color: #fff; border-color: #7c3aed; }
                .ais-editor-actions button.ais-primary:hover { background: #6d28d9; }

                .ais-skill-list { display: flex; flex-direction: column; gap: 6px; }
                .ais-skill-item {
                    display: flex;
                    align-items: flex-start;
                    gap: 8px;
                    padding: 10px;
                    border: 1px solid #f1f5f9;
                    border-radius: 10px;
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .ais-skill-item:hover { background: #f8fafc; }
                .ais-skill-item.selected { border-color: #a78bfa; background: #faf5ff; }
                .ais-circle { width: 15px; height: 15px; border: 1.5px solid #cbd5e1; border-radius: 50%; }
                .ais-skill-check { color: #7c3aed; flex-shrink: 0; margin-top: 1px; }
                .ais-skill-info { flex: 1; min-width: 0; }
                .ais-skill-name { font-size: 13px; font-weight: 500; color: #1e293b; }
                .ais-skill-desc { font-size: 11px; color: #94a3b8; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .ais-icon-btn {
                    width: 24px; height: 24px;
                    display: flex; align-items: center; justify-content: center;
                    border: none; background: none; color: #94a3b8;
                    border-radius: 6px; cursor: pointer; flex-shrink: 0;
                }
                .ais-icon-btn:hover { background: #f1f5f9; color: #475569; }
                .ais-icon-btn.ais-del:hover { color: #ef4444; background: #fef2f2; }
                .ais-empty-hint { text-align: center; font-size: 12px; color: #cbd5e1; line-height: 1.7; padding: 24px 8px; }

                /* 客户端 */
                .ais-clients { display: flex; flex-direction: column; gap: 8px; }
                .ais-client-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border: 1px solid #f1f5f9;
                    border-radius: 11px;
                    cursor: default;
                }
                .ais-client-item.available { cursor: pointer; }
                .ais-client-item.available:hover { background: #f8fafc; }
                .ais-client-item.selected { border-color: #a78bfa; background: #faf5ff; }
                .ais-ok { color: #10b981; }
                .ais-no { color: #cbd5e1; }
                .ais-client-name { font-size: 13px; font-weight: 600; color: #1e293b; }
                .ais-client-path { font-size: 11px; color: #94a3b8; margin-top: 2px; word-break: break-all; }
                .ais-redetect {
                    display: inline-flex; align-items: center; gap: 5px;
                    font-size: 12px; color: #64748b; background: #f1f5f9;
                    border: none; padding: 8px; border-radius: 9px; cursor: pointer;
                    margin-top: 8px; justify-content: center;
                }
                .ais-redetect:hover { background: #e2e8f0; }

                /* 画像 */
                .ais-profile { display: flex; flex-direction: column; gap: 10px; }
                .ais-profile textarea {
                    border: 1px solid #e2e8f0; border-radius: 10px;
                    padding: 10px; font-size: 12px; outline: none;
                    resize: vertical; font-family: inherit; color: #1e293b;
                }
                .ais-profile textarea:focus { border-color: #a78bfa; }
                .ais-profile-text {
                    font-size: 12px; line-height: 1.7; color: #475569;
                    background: #f8fafc; border: 1px solid #f1f5f9;
                    border-radius: 11px; padding: 12px;
                    white-space: pre-wrap; max-height: 400px; overflow-y: auto;
                }

                /* 主区域 */
                .ais-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 20px; gap: 14px; }
                .ais-task-card {
                    background: #fff;
                    border: 1px solid #e2e8f0;
                    border-radius: 16px;
                    padding: 14px;
                    box-shadow: 0 1px 3px rgba(15,23,42,0.04);
                }
                .ais-task-card textarea {
                    width: 100%;
                    border: none;
                    outline: none;
                    resize: vertical;
                    font-size: 14px;
                    line-height: 1.6;
                    color: #1e293b;
                    background: transparent;
                    font-family: inherit;
                }
                .ais-task-bar {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 10px;
                    margin-top: 10px;
                    padding-top: 10px;
                    border-top: 1px solid #f1f5f9;
                    flex-wrap: wrap;
                }
                .ais-selected-chips { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }
                .ais-chip {
                    display: inline-flex; align-items: center; gap: 4px;
                    font-size: 11px; padding: 3px 9px; border-radius: 999px;
                }
                .ais-chip-skill { color: #6d28d9; background: #f5f3ff; }
                .ais-chip-client { color: #0369a1; background: #f0f9ff; }
                .ais-task-actions { display: flex; align-items: center; gap: 10px; }
                .ais-rounds {
                    font-size: 12px; color: #64748b;
                    display: flex; align-items: center; gap: 5px;
                }
                .ais-rounds select {
                    border: 1px solid #e2e8f0; border-radius: 7px;
                    padding: 5px 8px; font-size: 12px; outline: none;
                    background: #fff; color: #1e293b;
                }
                .ais-dispatch {
                    display: inline-flex; align-items: center; gap: 6px;
                    font-size: 13px; font-weight: 600;
                    color: #fff; background: #7c3aed;
                    border: none; padding: 8px 20px; border-radius: 10px;
                    cursor: pointer; transition: background 0.18s;
                }
                .ais-dispatch:hover:not(:disabled) { background: #6d28d9; }
                .ais-dispatch:disabled { opacity: 0.45; cursor: default; }

                .ais-error {
                    display: flex; align-items: center; gap: 7px;
                    font-size: 12px; color: #e11d48;
                    background: #fff1f2; border: 1px solid #fecdd3;
                    padding: 9px 14px; border-radius: 11px;
                }

                .ais-output { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
                .ais-welcome {
                    margin: auto;
                    text-align: center;
                    color: #94a3b8;
                    padding: 40px 20px;
                }
                .ais-welcome-icon { color: #c4b5fd; margin-bottom: 12px; }
                .ais-welcome h3 { font-size: 17px; font-weight: 600; color: #64748b; margin: 0 0 8px; }
                .ais-welcome p { font-size: 13px; line-height: 1.7; margin: 0; }

                /* 时间线 */
                .ais-timeline { display: flex; flex-direction: column; gap: 0; }
                .ais-tl-item {
                    display: flex;
                    gap: 12px;
                    padding: 10px 4px;
                    position: relative;
                }
                .ais-tl-item:not(:last-child)::before {
                    content: "";
                    position: absolute;
                    left: 10px;
                    top: 30px;
                    bottom: -2px;
                    width: 1.5px;
                    background: #e2e8f0;
                }
                .ais-tl-dot {
                    width: 22px; height: 22px;
                    display: flex; align-items: center; justify-content: center;
                    border-radius: 50%;
                    flex-shrink: 0;
                    z-index: 1;
                }
                .ais-tl-ok .ais-tl-dot { color: #10b981; background: #ecfdf5; }
                .ais-tl-fail .ais-tl-dot { color: #ef4444; background: #fef2f2; }
                .ais-tl-running .ais-tl-dot { color: #7c3aed; background: #f5f3ff; }
                .ais-tl-pending .ais-tl-dot { color: #94a3b8; background: #f1f5f9; }
                .ais-tl-body { flex: 1; min-width: 0; padding-top: 1px; }
                .ais-tl-label {
                    font-size: 13px; font-weight: 600; color: #1e293b;
                    display: flex; align-items: center; gap: 7px;
                }
                .ais-tl-round {
                    font-size: 10px; font-weight: 600; color: #7c3aed;
                    background: #f5f3ff; padding: 1px 7px; border-radius: 999px;
                }
                .ais-tl-detail { font-size: 12px; color: #64748b; margin-top: 3px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

                /* 品控 */
                .ais-qc {
                    border-radius: 13px;
                    padding: 14px 16px;
                    border: 1px solid;
                }
                .ais-qc.pass { background: #ecfdf5; border-color: #a7f3d0; }
                .ais-qc.fail { background: #fffbeb; border-color: #fde68a; }
                .ais-qc-head {
                    display: flex; align-items: center; gap: 7px;
                    font-size: 13px; font-weight: 650; margin-bottom: 7px;
                }
                .ais-qc.pass .ais-qc-head { color: #047857; }
                .ais-qc.fail .ais-qc-head { color: #b45309; }
                .ais-qc-badge {
                    font-size: 11px; font-weight: 600;
                    padding: 2px 9px; border-radius: 999px;
                    margin-left: auto;
                }
                .ais-qc-badge.pass { color: #047857; background: #d1fae5; }
                .ais-qc-badge.fail { color: #b45309; background: #fef3c7; }
                .ais-qc-text { font-size: 12px; line-height: 1.7; color: #475569; white-space: pre-wrap; }

                /* 结果 */
                .ais-result {
                    background: #fff;
                    border: 1px solid #e2e8f0;
                    border-radius: 13px;
                    overflow: hidden;
                }
                .ais-result-head {
                    display: flex; align-items: center; gap: 7px;
                    padding: 11px 15px;
                    font-size: 13px; font-weight: 600; color: #334155;
                    cursor: pointer;
                    background: #f8fafc;
                    border-bottom: 1px solid #f1f5f9;
                }
                .ais-result-body {
                    margin: 0;
                    padding: 15px;
                    font-size: 12.5px;
                    line-height: 1.7;
                    color: #334155;
                    white-space: pre-wrap;
                    word-break: break-word;
                    font-family: "SF Mono", "Cascadia Code", "Consolas", monospace;
                    max-height: 500px;
                    overflow-y: auto;
                }
            `}</style>
        </div>
    );
}
