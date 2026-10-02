import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, XCircle, UserCircle, Layers } from "lucide-react";
import type { VerificationStep } from "../types";
import {
  BUBBLE_LINE_HEIGHT,
  BUBBLE_MAX_LINES,
  measureBubbleLines,
  truncateToLines,
} from "../lib/pretextLayout";

/**
 * 执行步骤气泡（轻量版）。
 *
 * 性能设计（相对旧实现的三处改动）：
 *  1. 去掉 rAF 逐帧驱动：旧实现用 requestAnimationFrame 每帧 setState 重渲染，
 *     本版全部交给 CSS transition，React 只在「新增/移除气泡」时渲染。
 *  2. 去掉 backdrop-blur 毛玻璃：背景模糊在动画期间代价很高，改为不透明底色。
 *  3. 气泡高度由 PRETEXT 预估并锁定（最多 4 行）：避免每条步骤文案长短不一时
 *     反复触发浏览器重排/回流。
 *
 * 视觉沿用原堆叠语义：最新在底、向上堆叠、越旧越淡，运行结束后依次消散。
 */

interface Bubble {
  id: number;
  step: VerificationStep;
  stackPos: number; // 0=最新(底部), 1=中间, 2=最旧
  enteredAt: number;
  exiting?: boolean;
  exitOrder: number;
}

interface Props {
  steps: VerificationStep[];
  running: boolean;
  onAllGone?: () => void;
  /** edge=屏幕右边缘（默认）；sphere=左栏球槽位：气泡从球的位置向上吐出堆叠 */
  variant?: "edge" | "sphere";
}

const MAX_STACK = 3;
const HOLD_DURATION = 1200; // 运行结束后停留时间
const EXIT_STAGGER = 180;   // 每个气泡退出错开时间
const EXIT_DURATION = 700;  // 单个气泡退出动画时长

export default function ExecutionBubbles({ steps, running, onAllGone, variant = "edge" }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const bubbleIdRef = useRef(0);
  const lastStepLenRef = useRef(0);
  const initializedRef = useRef(false);
  const wasRunningRef = useRef(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubblesRef = useRef<Bubble[]>([]);
  bubblesRef.current = bubbles;

  // 新 step 到来：滚动堆叠，新增气泡置底（stackPos=0）
  useEffect(() => {
    if (running) {
      if (!initializedRef.current) {
        lastStepLenRef.current = steps.length;
        initializedRef.current = true;
      }
      if (steps.length > lastStepLenRef.current) {
        const newSteps = steps.slice(lastStepLenRef.current);
        lastStepLenRef.current = steps.length;
        setBubbles((prev) => {
          const shifted = prev.map((b) => ({ ...b, stackPos: b.stackPos + 1 }));
          const added: Bubble[] = newSteps.map((s) => ({
            id: ++bubbleIdRef.current,
            step: s,
            stackPos: 0,
            enteredAt: Date.now(),
            exitOrder: 0,
          }));
          const merged = [...shifted, ...added];
          return merged.length > MAX_STACK
            ? merged.sort((a, b) => a.stackPos - b.stackPos).slice(0, MAX_STACK)
            : merged;
        });
      }
    } else {
      lastStepLenRef.current = steps.length;
      initializedRef.current = false;
    }
  }, [steps, running]);

  // 运行停止：标记退出；用 CSS 过渡播放，结束由定时器清理（不再用 rAF 循环）
  useEffect(() => {
    if (running) {
      wasRunningRef.current = true;
      return;
    }
    if (!wasRunningRef.current) return;
    wasRunningRef.current = false;

    const count = bubblesRef.current.length;
    if (count === 0) {
      // 没有气泡：直接延迟回调，让 UI 回到待命态
      const t = setTimeout(() => onAllGone?.(), HOLD_DURATION);
      return () => clearTimeout(t);
    }

    const now = Date.now();
    setBubbles((prev) => {
      const sorted = [...prev].sort((a, b) => b.stackPos - a.stackPos);
      return prev.map((b) => ({
        ...b,
        exiting: true,
        exitOrder: sorted.findIndex((s) => s.id === b.id),
        enteredAt: now,
      }));
    });

    // 全部退出动画播完后清空并回调
    const total = HOLD_DURATION + Math.max(0, count - 1) * EXIT_STAGGER + EXIT_DURATION + 120;
    exitTimerRef.current = setTimeout(() => {
      setBubbles([]);
      onAllGone?.();
    }, total);
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, [running, onAllGone]);

  // 卸载清理
  useEffect(() => () => { if (exitTimerRef.current) clearTimeout(exitTimerRef.current); }, []);

  if (bubbles.length === 0) return null;

  const isSphere = variant === "sphere";
  const bubbleGap = isSphere ? 34 : 48;

  return (
    <div
      className={isSphere
        ? "pointer-events-none absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2"
        : "fixed right-3 bottom-20 z-[9997] pointer-events-none"}
      style={{ width: isSphere ? 206 : 270, height: isSphere ? 110 : (bubbleGap * MAX_STACK + 80) }}
    >
      {bubbles.map((b) => {
        const s = b.step;
        const pos = b.stackPos;

        // 静态样式：进入/退出全部由 CSS transition 承担，无需逐帧计算
        let opacity = 1;
        let scale = 1;
        if (pos === 1) { opacity = isSphere ? 0.55 : 0.6; scale = isSphere ? 0.94 : 0.93; }
        else if (pos === 2) { opacity = isSphere ? 0.26 : 0.3; scale = isSphere ? 0.88 : 0.86; }
        else if (pos > 2) { opacity = 0.12; scale = 0.84; }

        if (b.exiting) { opacity = 0; scale = isSphere ? 0.86 : 0.9; }

        let icon: ReactNode;
        let bgClass = isSphere ? "bg-white/90" : "bg-white";
        let borderClass = isSphere ? "border-slate-200/70" : "border-slate-200";
        let textClass = "text-slate-700";

        if (s.isTaskStart) {
          icon = <Layers className={`${isSphere ? "h-3.5 w-3.5" : "h-4 w-4"} text-white`} />;
          bgClass = "bg-gradient-to-r from-indigo-600 to-violet-600";
          borderClass = "border-indigo-400";
          textClass = "text-white";
        } else if (s.isRecordStart) {
          icon = <UserCircle className={`${isSphere ? "h-3.5 w-3.5" : "h-4 w-4"} text-indigo-500`} />;
          bgClass = "bg-indigo-50";
          borderClass = "border-indigo-200";
          textClass = "text-indigo-800";
        } else if (s.success) {
          icon = <CheckCircle2 className={`${isSphere ? "h-3.5 w-3.5" : "h-4 w-4"} text-emerald-500`} />;
        } else {
          icon = <XCircle className={`${isSphere ? "h-3.5 w-3.5" : "h-4 w-4"} text-rose-500`} />;
        }

        // 正文：PRETEXT 预估行数 → 截断到最多 4 行，并通过 minHeight 锁高
        const rawText = s.description || "";
        const { text: shownText, lines } = truncateToLines(rawText, BUBBLE_MAX_LINES);
        // 有副文案时预留 1 行高度
        const hasDetail = !!(s.detail && !s.isTaskStart && !s.isRecordStart);
        const totalLines = Math.min(BUBBLE_MAX_LINES, lines + (hasDetail ? 1 : 0));
        const bodyMinHeight = totalLines * BUBBLE_LINE_HEIGHT;

        const posStyle = { bottom: Math.min(pos, MAX_STACK) * bubbleGap };

        return (
          <div
            key={b.id}
            className={[
              "absolute flex items-start rounded-xl border",
              isSphere
                ? "left-0 w-[200px] gap-1.5 px-2 py-1.5 shadow-md pointer-events-none"
                : "right-0 w-[260px] gap-2 px-3 py-2 shadow-lg pointer-events-auto",
              borderClass,
              bgClass,
            ].join(" ")}
            style={{
              ...posStyle,
              opacity,
              transform: `scale(${scale})`,
              transformOrigin: isSphere ? "left bottom" : "right bottom",
              transition: `opacity ${EXIT_DURATION}ms ease-out, transform ${EXIT_DURATION}ms ease-out`,
              willChange: opacity < 1 || b.exiting ? "opacity, transform" : "auto",
            }}
          >
            <span className="mt-0.5 shrink-0">{icon}</span>
            <div className="min-w-0 flex-1" style={{ minHeight: bodyMinHeight }}>
              <p
                className={`${isSphere ? "text-[10px]" : "text-[11px]"} font-medium ${textClass} break-words`}
                style={{ lineHeight: `${BUBBLE_LINE_HEIGHT}px`, maxHeight: BUBBLE_MAX_LINES * BUBBLE_LINE_HEIGHT, overflow: "hidden" }}
              >
                {shownText}
                {s.taskName && s.isTaskStart && (
                  <span className="ml-1 opacity-80">{s.taskIndex}/{s.taskTotal}</span>
                )}
                {s.recordName && s.isRecordStart && (
                  <span className="ml-1 opacity-80">{s.recordIndex}/{s.recordTotal}</span>
                )}
              </p>
              {hasDetail && (
                <p className={`mt-0.5 ${isSphere ? "text-[9px]" : "text-[10px]"} ${s.success ? "text-emerald-600" : "text-rose-500"} opacity-70 truncate`}>
                  {s.detail}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 供外部（如调试）复用：单条文案会占几行 */
export { measureBubbleLines };
