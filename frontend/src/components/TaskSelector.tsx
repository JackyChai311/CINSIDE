import { useState } from "react";
import { Globe, Presentation, ArrowRight, Loader2 } from "lucide-react";
import appIconPng from "../assets/app-icon.png";

interface TaskSelectorProps {
  onSelect: (task: "web" | "ppt") => void;
  checking?: boolean;
}

export default function TaskSelector({ onSelect, checking }: TaskSelectorProps) {
  const [exiting, setExiting] = useState<"web" | "ppt" | null>(null);

  const handleSelect = (task: "web" | "ppt") => {
    if (exiting || checking) return;
    setExiting(task);
    // 幻灯片任务需要先异步检查 OfficeCLI，因此不延迟；网页任务保持原有的退场动画
    if (task === "web") {
      setTimeout(() => onSelect(task), 480);
    } else {
      setExiting(null);
      onSelect(task);
    }
  };

  return (
    <div className="task-selector-root">
      <style>{`
        .task-selector-root {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 32px;
          background: linear-gradient(135deg, #f8fafc 0%, #ffffff 50%, #f5f3ff 100%);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
            'Microsoft YaHei', sans-serif;
          overflow: hidden;
        }

        /* Logo 区域 */
        .ts-logo {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 40px;
          animation: tsFadeDown 0.6s ease both;
        }
        .ts-logo img { height: 40px; width: 40px; }
        .ts-logo-text {
          font-size: 32px;
          font-weight: 900;
          color: #0f172a;
          letter-spacing: -0.5px;
        }
        .ts-logo-cursor {
          display: inline-block;
          width: 3px;
          height: 32px;
          background: #8a2be2;
          margin-left: 4px;
          vertical-align: middle;
          animation: tsBlink 1s step-end infinite;
        }

        .ts-title {
          font-size: 26px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 8px 0;
          animation: tsFadeUp 0.6s ease 0.1s both;
        }
        .ts-subtitle {
          font-size: 15px;
          color: #64748b;
          margin: 0 0 48px 0;
          animation: tsFadeUp 0.6s ease 0.15s both;
        }

        /* 卡片容器 */
        .ts-cards {
          display: flex;
          gap: 28px;
          max-width: 760px;
          width: 100%;
        }

        /* 单个卡片 */
        .ts-card {
          flex: 1;
          position: relative;
          background: #ffffff;
          border: 2px solid #e2e8f0;
          border-radius: 20px;
          padding: 36px 32px;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.25s ease, box-shadow 0.25s ease,
            transform 0.25s ease;
          outline: none;
          overflow: hidden;
        }
        .ts-card::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 18px;
          opacity: 0;
          transition: opacity 0.3s ease;
          pointer-events: none;
        }
        .ts-card-web::before {
          background: radial-gradient(circle at 50% 0%, rgba(99,102,241,0.06), transparent 70%);
        }
        .ts-card-ppt::before {
          background: radial-gradient(circle at 50% 0%, rgba(139,92,246,0.06), transparent 70%);
        }
        .ts-card:hover::before { opacity: 1; }

        .ts-card-web:hover {
          border-color: #818cf8;
          box-shadow: 0 20px 40px -12px rgba(99,102,241,0.25);
          transform: translateY(-6px);
        }
        .ts-card-ppt:hover {
          border-color: #a78bfa;
          box-shadow: 0 20px 40px -12px rgba(139,92,246,0.25);
          transform: translateY(-6px);
        }
        .ts-card:active { transform: translateY(-2px) scale(0.99); }

        /* 图标盒子 */
        .ts-icon {
          width: 56px;
          height: 56px;
          border-radius: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 22px;
          transition: transform 0.3s ease;
        }
        .ts-card:hover .ts-icon { transform: scale(1.08) rotate(-3deg); }
        .ts-icon-web { background: #eef2ff; color: #4f46e5; }
        .ts-icon-ppt { background: #f5f3ff; color: #7c3aed; }

        .ts-card-title {
          font-size: 22px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 10px 0;
        }
        .ts-card-desc {
          font-size: 14px;
          color: #475569;
          line-height: 1.7;
          margin: 0 0 24px 0;
        }
        .ts-enter {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 14px;
          font-weight: 600;
          transition: gap 0.2s ease;
        }
        .ts-card:hover .ts-enter { gap: 10px; }
        .ts-enter-web { color: #4f46e5; }
        .ts-enter-ppt { color: #7c3aed; }

        .ts-footer {
          margin-top: 40px;
          font-size: 13px;
          color: #94a3b8;
          animation: tsFadeUp 0.6s ease 0.3s both;
        }

        /* 入场动画 */
        .ts-card:nth-child(1) { animation: tsCardIn 0.55s cubic-bezier(0.22,1,0.36,1) 0.2s both; }
        .ts-card:nth-child(2) { animation: tsCardIn 0.55s cubic-bezier(0.22,1,0.36,1) 0.32s both; }

        /* 退场动画：选中的卡片放大淡出，另一张缩小消失 */
        .ts-exit-active .ts-card-selected {
          animation: tsCardSelected 0.48s cubic-bezier(0.22,1,0.36,1) forwards;
        }
        .ts-exit-active .ts-card-other {
          animation: tsCardFade 0.4s ease forwards;
        }
        .ts-exit-active .ts-logo,
        .ts-exit-active .ts-title,
        .ts-exit-active .ts-subtitle,
        .ts-exit-active .ts-footer {
          animation: tsFadeOut 0.3s ease forwards;
        }

        @keyframes tsFadeDown {
          from { opacity: 0; transform: translateY(-16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes tsFadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes tsCardIn {
          from { opacity: 0; transform: translateY(28px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes tsCardSelected {
          0%   { transform: translateY(0) scale(1); box-shadow: 0 20px 40px -12px rgba(0,0,0,0.15); }
          40%  { transform: translateY(-8px) scale(1.04); }
          100% { transform: scale(1.12); opacity: 0; }
        }
        @keyframes tsCardFade {
          to { opacity: 0; transform: scale(0.94) translateY(12px); }
        }
        @keyframes tsFadeOut {
          to { opacity: 0; transform: translateY(-8px); }
        }
        @keyframes tsBlink {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0; }
        }
      `}</style>

      <div className={exiting ? "ts-exit-active" : ""} style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
        {/* Logo */}
        <div className="ts-logo">
          <img src={appIconPng} alt="CINSIDE" />
          <span className="ts-logo-text">CINSIDE</span>
          <span className="ts-logo-cursor" />
        </div>

        <h1 className="ts-title">选择任务类型</h1>
        <p className="ts-subtitle">选择你要进行的操作</p>

        {/* 卡片 */}
        <div className="ts-cards">
          <button
            className={`ts-card ts-card-web ${exiting === "web" ? "ts-card-selected" : exiting ? "ts-card-other" : ""}`}
            onClick={() => handleSelect("web")}
          >
            <div className="ts-icon ts-icon-web">
              <Globe size={28} strokeWidth={2} />
            </div>
            <h2 className="ts-card-title">网页任务</h2>
            <p className="ts-card-desc">
              浏览器自动化核验、LOOP 循环录入、字段对比、文档提取与 OCR 识别等网页操作流程。
            </p>
            <span className="ts-enter ts-enter-web">
              进入 <ArrowRight size={16} />
            </span>
          </button>

          <button
            className={`ts-card ts-card-ppt ${exiting === "ppt" ? "ts-card-selected" : exiting ? "ts-card-other" : ""}`}
            onClick={() => handleSelect("ppt")}
            disabled={checking}
          >
            <div className="ts-icon ts-icon-ppt">
              {checking ? <Loader2 size={28} strokeWidth={2} className="animate-spin" /> : <Presentation size={28} strokeWidth={2} />}
            </div>
            <h2 className="ts-card-title">幻灯片任务</h2>
            <p className="ts-card-desc">
              同模板多 PPT 的 Section 拆分合并、AI 统一修改内容、一键回填原位，支持指定本地文件。
            </p>
            <span className="ts-enter ts-enter-ppt">
              {checking ? "检查依赖中…" : "进入"} <ArrowRight size={16} />
            </span>
          </button>
        </div>

        <p className="ts-footer">选择后可在各任务界面返回切换</p>
      </div>
    </div>
  );
}
