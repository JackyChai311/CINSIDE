import { useState } from "react";
import {
    ArrowLeft,
    Users,
    Cpu,
    Sparkles,
    UserCircle,
    Bot,
} from "lucide-react";
import AIStudio from "./cowork/AIStudio";
import HumanStudio from "./cowork/HumanStudio";

type Mode = "entry" | "ai" | "human";

export default function CoworkStudio({ onBack }: { onBack: () => void }) {
    const [mode, setMode] = useState<Mode>("entry");

    if (mode === "ai") {
        return <AIStudio onBack={() => setMode("entry")} />;
    }
    if (mode === "human") {
        return <HumanStudio onBack={() => setMode("entry")} />;
    }

    return (
        <div className="cw-root">
            <div className="cw-bg" />
            <div className="cw-content">
                <button className="cw-back" onClick={onBack}>
                    <ArrowLeft size={16} />
                    返回
                </button>

                <div className="cw-header">
                    <div className="cw-logo">
                        <Users size={32} strokeWidth={1.6} />
                    </div>
                    <h1>Cowork Studio</h1>
                    <p>协作工作台 · 人工与 AI 协同完成任务</p>
                </div>

                <div className="cw-cards">
                    <button className="cw-card cw-card-ai" onClick={() => setMode("ai")}>
                        <div className="cw-card-icon">
                            <Cpu size={28} strokeWidth={1.5} />
                        </div>
                        <div className="cw-card-body">
                            <h2>
                                <Bot size={16} />
                                AI 协作
                            </h2>
                            <p>中央 AI 作为品控大脑，保存你的技能与风格，调用 Codex / Claude Code / Trae / 千问等客户端并行执行，自动品控与迭代。</p>
                            <div className="cw-card-tags">
                                <span><Sparkles size={10} /> 技能库</span>
                                <span>多 Agent 派发</span>
                                <span>自动品控</span>
                            </div>
                        </div>
                    </button>

                    <button className="cw-card cw-card-human" onClick={() => setMode("human")}>
                        <div className="cw-card-icon cw-card-icon-human">
                            <UserCircle size={28} strokeWidth={1.5} />
                        </div>
                        <div className="cw-card-body">
                            <h2>
                                <Users size={16} />
                                人工协作
                            </h2>
                            <p>创建协作任务板，分配、追踪、汇总人工工作项，适合团队分工与进度同步。</p>
                            <div className="cw-card-tags">
                                <span>任务看板</span>
                                <span>分工分配</span>
                                <span>进度追踪</span>
                            </div>
                        </div>
                    </button>
                </div>
            </div>

            <style>{`
                .cw-root {
                    position: relative;
                    height: 100%;
                    overflow: auto;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                    background: #f8fafc;
                }
                .cw-bg {
                    position: fixed;
                    inset: 0;
                    background:
                        radial-gradient(circle at 20% 20%, rgba(139, 92, 246, 0.08), transparent 50%),
                        radial-gradient(circle at 80% 60%, rgba(14, 165, 233, 0.07), transparent 50%),
                        linear-gradient(180deg, #fafbff 0%, #f1f5f9 100%);
                    z-index: 0;
                }
                .cw-content {
                    position: relative;
                    z-index: 1;
                    max-width: 880px;
                    margin: 0 auto;
                    padding: 40px 24px 60px;
                }
                .cw-back {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 13px;
                    color: #64748b;
                    background: rgba(255,255,255,0.7);
                    border: 1px solid #e2e8f0;
                    padding: 6px 14px;
                    border-radius: 999px;
                    cursor: pointer;
                    transition: all 0.18s;
                }
                .cw-back:hover { color: #475569; border-color: #cbd5e1; background: #fff; }
                .cw-header {
                    text-align: center;
                    margin: 48px 0 44px;
                }
                .cw-logo {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 64px;
                    height: 64px;
                    border-radius: 18px;
                    color: #7c3aed;
                    background: linear-gradient(135deg, #ede9fe, #e0f2fe);
                    box-shadow: 0 8px 24px -8px rgba(124, 58, 237, 0.35);
                    margin-bottom: 18px;
                }
                .cw-header h1 {
                    font-size: 32px;
                    font-weight: 700;
                    color: #0f172a;
                    letter-spacing: -0.5px;
                    margin: 0;
                }
                .cw-header p {
                    color: #64748b;
                    font-size: 14px;
                    margin-top: 8px;
                }
                .cw-cards {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 20px;
                }
                @media (max-width: 640px) {
                    .cw-cards { grid-template-columns: 1fr; }
                }
                .cw-card {
                    display: flex;
                    gap: 18px;
                    text-align: left;
                    padding: 28px;
                    background: rgba(255,255,255,0.85);
                    border: 1px solid #e2e8f0;
                    border-radius: 20px;
                    cursor: pointer;
                    transition: all 0.25s cubic-bezier(.4,0,.2,1);
                    backdrop-filter: blur(8px);
                }
                .cw-card:hover {
                    transform: translateY(-4px);
                    box-shadow: 0 20px 40px -16px rgba(15, 23, 42, 0.18);
                }
                .cw-card-ai:hover { border-color: #a78bfa; }
                .cw-card-human:hover { border-color: #5eead4; }
                .cw-card-icon {
                    flex-shrink: 0;
                    width: 52px;
                    height: 52px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 14px;
                    color: #7c3aed;
                    background: linear-gradient(135deg, #f5f3ff, #ede9fe);
                }
                .cw-card-icon-human {
                    color: #0d9488;
                    background: linear-gradient(135deg, #f0fdfa, #ccfbf1);
                }
                .cw-card-body h2 {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 17px;
                    font-weight: 650;
                    color: #0f172a;
                    margin: 0 0 8px;
                }
                .cw-card-body p {
                    font-size: 13px;
                    line-height: 1.65;
                    color: #64748b;
                    margin: 0 0 14px;
                }
                .cw-card-tags {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .cw-card-tags span {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 11px;
                    color: #475569;
                    background: #f1f5f9;
                    padding: 3px 9px;
                    border-radius: 999px;
                }
                .cw-card-ai .cw-card-tags span:first-child { background: #f5f3ff; color: #6d28d9; }
            `}</style>
        </div>
    );
}
