import { useState, useEffect, useRef } from "react";
import { Globe, Presentation, Users, ArrowRight, Loader2 } from "lucide-react";
import appIconPng from "../assets/app-icon.png";

interface TaskSelectorProps {
  onSelect: (task: "web" | "ppt" | "cowork") => void;
  checking?: boolean;
}

export default function TaskSelector({ onSelect, checking }: TaskSelectorProps) {
  const [exiting, setExiting] = useState<"web" | "ppt" | "cowork" | null>(null);
  const prevCheckingRef = useRef(false);

  // 当 PPT 检查结束但仍停留在选择页（OfficeCLI 未安装），恢复退场动画
  useEffect(() => {
    if (prevCheckingRef.current && !checking && exiting) {
      setExiting(null);
    }
    prevCheckingRef.current = !!checking;
  }, [checking, exiting]);

  const handleSelect = (task: "web" | "ppt" | "cowork") => {
    if (exiting || checking) return;
    setExiting(task);
    if (task === "ppt") {
      // PPT 需要异步检查 OfficeCLI，立即触发检查，卡片保持可见
      onSelect(task);
    } else {
      setTimeout(() => onSelect(task), 480);
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
          gap: 20px;
          max-width: 1100px;
          width: 100%;
        }

        /* 单个卡片 */
        .ts-card {
          flex: 1;
          position: relative;
          background: #ffffff;
          border: 2px solid #e2e8f0;
          border-radius: 20px;
          padding: 32px 26px;
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
        .ts-card-cowork::before {
          background: radial-gradient(circle at 50% 0%, rgba(20,184,166,0.06), transparent 70%);
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
        .ts-card-cowork:hover {
          border-color: #5eead4;
          box-shadow: 0 20px 40px -12px rgba(20,184,166,0.25);
          transform: translateY(-6px);
        }
        .ts-card:active { transform: translateY(-2px) scale(0.99); }

        /* 图标行：图标 + WEB，STUDIO 绝对定位浮在下方空白处 */
        .ts-icon-row {
          position: relative;
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 22px;
        }
        .ts-icon {
          width: 56px;
          height: 56px;
          border-radius: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.3s ease;
          flex-shrink: 0;
        }
        .ts-card:hover .ts-icon { transform: scale(1.08) rotate(-3deg); }
        .ts-icon-web { color: #000000; }
        .ts-icon-ppt { color: #000000; }
        .ts-icon-cowork { color: #000000; }

        .ts-icon-label {
          font-family: "SF Pro Display", "Segoe UI", "Helvetica Neue", "PingFang SC",
            "Microsoft YaHei", sans-serif;
        }
        .ts-label-top {
          font-size: 24px;
          font-weight: 300;
          letter-spacing: 3px;
          color: #64748b;
        }
        /* STUDIO 绝对定位，浮在 WEB 与标题之间的空白行，不撑开高度 */
        .ts-label-studio {
          position: absolute;
          left: 90px;
          top: 100%;
          margin-top: 2px;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 4px;
          color: #94a3b8;
          line-height: 1;
          white-space: nowrap;
        }

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
        .ts-enter-cowork { color: #0d9488; }

        .ts-footer {
          margin-top: 40px;
          font-size: 13px;
          color: #94a3b8;
          animation: tsFadeUp 0.6s ease 0.3s both;
        }

        /* 入场动画 */
        .ts-card:nth-child(1) { animation: tsCardIn 0.55s cubic-bezier(0.22,1,0.36,1) 0.2s both; }
        .ts-card:nth-child(2) { animation: tsCardIn 0.55s cubic-bezier(0.22,1,0.36,1) 0.32s both; }
        .ts-card:nth-child(3) { animation: tsCardIn 0.55s cubic-bezier(0.22,1,0.36,1) 0.44s both; }

        /* 退场动画：选中的卡片放大淡出，其他卡片缩小消失 */
        .ts-exit-active .ts-card-selected {
          animation: tsCardSelected 0.48s cubic-bezier(0.22,1,0.36,1) forwards;
        }
        .ts-exit-active .ts-card-other {
          animation: tsCardFade 0.4s ease forwards;
        }
        /* PPT 检查中：卡片保持可见，轻微高亮 */
        .ts-exit-active .ts-card-checking {
          animation: tsCardChecking 0.3s ease forwards;
        }
        @keyframes tsCardChecking {
          to {
            border-color: #a78bfa;
            box-shadow: 0 20px 40px -12px rgba(139,92,246,0.25);
            transform: translateY(-6px);
          }
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
            <div className="ts-icon-row">
              <div className="ts-icon ts-icon-web">
                <Globe size={28} strokeWidth={2} />
              </div>
              <div className="ts-icon-label">
                <span className="ts-label-top">WEB</span>
              </div>
              <span className="ts-label-studio">STUDIO</span>
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
            className={`ts-card ts-card-ppt ${exiting === "ppt" ? "ts-card-checking" : exiting ? "ts-card-other" : ""}`}
            onClick={() => handleSelect("ppt")}
            disabled={checking}
          >
            <div className="ts-icon-row">
              <div className="ts-icon ts-icon-ppt">
                {checking ? <Loader2 size={28} strokeWidth={2} className="animate-spin" /> : <Presentation size={28} strokeWidth={2} />}
              </div>
              <div className="ts-icon-label">
                <span className="ts-label-top">SLIDE</span>
              </div>
              <span className="ts-label-studio">STUDIO</span>
            </div>
            <h2 className="ts-card-title">幻灯片任务</h2>
            <p className="ts-card-desc">
              同模板多 PPT 的 Section 拆分合并、AI 统一修改内容、一键回填原位，支持指定本地文件。
            </p>
            <span className="ts-enter ts-enter-ppt">
              {checking ? "检查依赖中…" : "进入"} <ArrowRight size={16} />
            </span>
          </button>

          <button
            className={`ts-card ts-card-cowork ${exiting === "cowork" ? "ts-card-selected" : exiting ? "ts-card-other" : ""}`}
            onClick={() => handleSelect("cowork")}
          >
            <div className="ts-icon-row">
              <div className="ts-icon ts-icon-cowork">
                <Users size={28} strokeWidth={2} />
              </div>
              <div className="ts-icon-label">
                <span className="ts-label-top">COWORK</span>
              </div>
              <span className="ts-label-studio">STUDIO</span>
            </div>
            <h2 className="ts-card-title">协作任务</h2>
            <p className="ts-card-desc">
              多人协同工作流、团队任务分配与进度同步，支持共享工作区与实时协作编辑。
            </p>
            <span className="ts-enter ts-enter-cowork">
              进入 <ArrowRight size={16} />
            </span>
          </button>
        </div>

        <p className="ts-footer">选择后可在各任务界面返回切换</p>
      </div>
    </div>
  );
}
