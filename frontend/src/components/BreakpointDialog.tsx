import { useEffect, useRef, useState } from "react";
import { CirclePause, Play, AlertTriangle, Hand, Volume2, VolumeX } from "lucide-react";

export interface BreakpointInfo {
  /** 当前处理的记录名 */
  recordName: string;
  /** 当前记录序号（从1开始） */
  recordIndex: number;
  /** 总记录数 */
  recordTotal: number;
  /** 断点所在步骤名 */
  stepLabel: string;
  /** 断点类型 */
  type: "always" | "on-error";
  /** 条件断点时的错误/警告详情 */
  error?: string;
  /** 断点触发时间戳 */
  triggeredAt: number;
}

interface Props {
  info: BreakpointInfo | null;
  onContinue: () => void;
}

/**
 * 用 Web Audio API 播放断点提示音（三连升调，清脆醒目）。
 * 不依赖外部音频文件，避免打包路径问题。
 */
function playBreakpointSound() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // 三连音：C5 → E5 → G5（do-mi-sol），每个 180ms，间隔 60ms
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.24;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    });

    // 1.5 秒后自动关闭 AudioContext 释放资源
    setTimeout(() => ctx.close().catch(() => {}), 2000);
  } catch {
    // 音频播放失败不影响断点功能
  }
}

export default function BreakpointDialog({ info, onContinue }: Props) {
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const soundPlayedRef = useRef(false);
  const rafRef = useRef<number>(0);

  // 断点触发时播放提示音 & 启动计时器
  useEffect(() => {
    if (info) {
      if (!muted && !soundPlayedRef.current) {
        playBreakpointSound();
        soundPlayedRef.current = true;
      }
      const tick = () => {
        setElapsed(Math.floor((Date.now() - info.triggeredAt) / 1000));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    } else {
      soundPlayedRef.current = false;
      setElapsed(0);
    }
  }, [info, muted]);

  // 空格键继续
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onContinue();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info, onContinue]);

  if (!info) return null;

  const isError = info.type === "on-error";
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" />

      {/* 对话框 */}
      <div className="relative w-[480px] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        {/* 顶部色条 */}
        <div className={`h-1.5 w-full ${isError ? "bg-gradient-to-r from-rose-500 to-amber-500" : "bg-gradient-to-r from-indigo-500 to-violet-500"}`} />

        <div className="p-5">
          {/* 标题行 */}
          <div className="flex items-start gap-3">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
              isError ? "bg-rose-100 text-rose-600" : "bg-indigo-100 text-indigo-600"
            }`}>
              {isError ? <AlertTriangle className="h-6 w-6" /> : <Hand className="h-6 w-6" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-800">
                  {isError ? "条件断点 — 需要人工干预" : "强制断点 — 等待继续"}
                </h2>
                <button
                  onClick={() => setMuted((m) => !m)}
                  className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title={muted ? "开启提示音" : "静音"}
                >
                  {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-400">
                LOOP 已暂停 · 已等待 {mins > 0 ? `${mins}分` : ""}{secs}秒
              </p>
            </div>
          </div>

          {/* 上下文信息 */}
          <div className="mt-4 space-y-2 rounded-lg border border-slate-100 bg-slate-50/80 p-3">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-500">当前记录</span>
              <span className="font-medium text-slate-700">
                {info.recordName}
                <span className="ml-1.5 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">
                  {info.recordIndex}/{info.recordTotal}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-500">断点位置</span>
              <span className="max-w-[280px] truncate font-medium text-slate-700" title={info.stepLabel}>
                {info.stepLabel}
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-500">断点类型</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                isError ? "bg-rose-100 text-rose-700" : "bg-indigo-100 text-indigo-700"
              }`}>
                {isError ? "条件断点（错误）" : "强制断点"}
              </span>
            </div>
          </div>

          {/* 错误详情 */}
          {isError && info.error && (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-600">AI 检测到问题</div>
                  <p className="mt-1 break-words text-[11px] leading-relaxed text-rose-800">{info.error}</p>
                </div>
              </div>
            </div>
          )}

          {/* 操作提示 */}
          <p className="mt-3 text-center text-[10px] text-slate-400">
            请在浏览器中检查并处理问题，完成后点击继续
          </p>

          {/* 继续按钮 */}
          <button
            onClick={onContinue}
            autoFocus
            className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:scale-[1.02] active:scale-[0.98] ${
              isError
                ? "bg-gradient-to-r from-rose-500 to-amber-500 shadow-rose-200 hover:shadow-rose-300"
                : "bg-gradient-to-r from-indigo-500 to-violet-500 shadow-indigo-200 hover:shadow-indigo-300"
            }`}
          >
            <Play className="h-4 w-4" />
            继续执行
            <span className="ml-1 rounded bg-white/20 px-1.5 py-0.5 text-[10px]">Space</span>
          </button>
        </div>
      </div>
    </div>
  );
}
