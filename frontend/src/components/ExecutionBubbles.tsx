import { useEffect, useState, useRef, type ReactNode } from "react";
import { CheckCircle2, XCircle, UserCircle, Layers } from "lucide-react";
import type { VerificationStep } from "../types";

interface Bubble {
  id: number;
  step: VerificationStep;
  stackPos: number; // 0=最新(底部), 1=中间, 2=最旧
  enteredAt: number;
  exiting?: boolean;
  exitStartedAt?: number;
  exitOrder: number;
}

interface Props {
  steps: VerificationStep[];
  running: boolean;
  onAllGone?: () => void;
  /** edge=屏幕右边缘（默认）；sphere=融入 AI 球体：气泡从球体下方吐出，旧的向下堆叠渐淡，消散时收回球体 */
  variant?: "edge" | "sphere";
}

const MAX_STACK = 3;
const HOLD_DURATION = 1200; // 运行结束后停留时间
const EXIT_STAGGER = 200;   // 每个气泡退出错开时间
const EXIT_DURATION = 800;  // 单个气泡退出动画时长

export default function ExecutionBubbles({ steps, running, onAllGone, variant = "edge" }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [tick, setTick] = useState(0);
  const bubbleIdRef = useRef(0);
  const lastStepLenRef = useRef(0);
  const initializedRef = useRef(false);
  const wasRunningRef = useRef(false);
  const exitStartedRef = useRef(false);
  const rafRef = useRef<number>(0);
  // 用 ref 镜像 bubbles，避免 setBubbles 回调时序问题导致 count 取到 0
  const bubblesRef = useRef<Bubble[]>([]);
  bubblesRef.current = bubbles;

  // 新step到来时创建气泡
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
          const newBubbles: Bubble[] = newSteps.map((s, i) => ({
            id: ++bubbleIdRef.current,
            step: s,
            stackPos: 0,
            enteredAt: Date.now() + i * 30,
            exitOrder: 0,
          }));
          return [...shifted, ...newBubbles];
        });
      }
    } else {
      lastStepLenRef.current = steps.length;
      initializedRef.current = false;
    }
  }, [steps, running]);

  // 运行停止时：标记所有气泡退出 + 启动rAF
  useEffect(() => {
    if (running) {
      wasRunningRef.current = true;
      exitStartedRef.current = false;
      return;
    }
    if (!wasRunningRef.current) return;
    wasRunningRef.current = false;

    // 用 ref 获取最新的 bubbles 数量，避免 setBubbles 回调时序问题
    const currentBubbles = bubblesRef.current;
    const count = currentBubbles.length;
    const now = Date.now();

    // 标记所有气泡进入退出状态
    setBubbles((prev) => {
      if (prev.length === 0) return prev;
      // 最旧的先退出（stackPos越大越旧）
      const sorted = [...prev].sort((a, b) => b.stackPos - a.stackPos);
      return prev.map((b) => {
        const order = sorted.findIndex((s) => s.id === b.id);
        return { ...b, exiting: true, exitStartedAt: now, exitOrder: order };
      });
    });

    // 即使没有气泡也要标记退出开始，触发 onAllGone
    exitStartedRef.current = true;

    // 若运行结束时没有气泡，直接延迟触发 onAllGone（否则 bubbles.length 一直为 0，effect 不会重跑）
    if (count === 0) {
      const t = setTimeout(() => {
        exitStartedRef.current = false;
        onAllGone?.();
      }, HOLD_DURATION);
      return;
    }

    // rAF 驱动退出动画：停留 → 逐个上移淡出 → 完全消失
    const totalExitTime = HOLD_DURATION + Math.max(0, count - 1) * EXIT_STAGGER + EXIT_DURATION + 500;
    const startTime = now;
    const animate = () => {
      setTick((t) => t + 1);
      if (Date.now() - startTime < totalExitTime) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
  }, [running]);

  // 清理rAF
  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  // 移除已完全消失的气泡
  useEffect(() => {
    if (bubbles.length === 0 || !exitStartedRef.current) return;
    const now = Date.now();
    setBubbles((prev) => prev.filter((b) => {
      if (!b.exiting || b.exitStartedAt == null) return true;
      const delay = HOLD_DURATION + b.exitOrder * EXIT_STAGGER;
      return now - b.exitStartedAt < delay + EXIT_DURATION + 100;
    }));
  }, [tick]);

  // 所有气泡消失 → 回调（侧边按钮显现）
  useEffect(() => {
    if (bubbles.length === 0 && exitStartedRef.current) {
      exitStartedRef.current = false;
      onAllGone?.();
    }
  }, [bubbles.length, onAllGone]);

  if (bubbles.length === 0) return null;

  const now = Date.now();
  const isSphere = variant === "sphere";
  const bubbleGap = isSphere ? 46 : 48;

  return (
    <div
      className={isSphere
        ? "pointer-events-none absolute left-1/2 top-full z-30 -translate-x-1/2"
        : "fixed right-3 bottom-20 z-[9997] pointer-events-none"}
      style={{ width: isSphere ? 210 : 270, height: bubbleGap * MAX_STACK + 80 }}
    >
      {bubbles.map((b) => {
        const s = b.step;
        const pos = b.stackPos;
        const age = now - b.enteredAt;
        const enterP = Math.min(1, age / 300);

        let translateX = 0;
        let translateY = 0;
        let opacity = 1;
        let scale = 1;

        if (b.exiting && b.exitStartedAt != null) {
          const elapsed = now - b.exitStartedAt;
          const delay = HOLD_DURATION + b.exitOrder * EXIT_STAGGER;
          const exitElapsed = Math.max(0, elapsed - delay);
          const exitP = Math.min(1, exitElapsed / EXIT_DURATION);
          const eased = 1 - Math.pow(1 - exitP, 3);

          if (elapsed < delay) {
            // 停留期间保持原位
            opacity = pos === 0 ? 1 : pos === 1 ? 0.6 : 0.3;
            scale = pos === 0 ? 1 : pos === 1 ? 0.93 : 0.86;
          } else if (isSphere) {
            // 球体变体：消散时向上收回球体
            translateY = -30 * eased;
            opacity = Math.max(0, (pos === 0 ? 1 : pos === 1 ? 0.55 : 0.26) * (1 - eased));
            scale = (pos === 0 ? 1 : pos === 1 ? 0.94 : 0.88) * (1 - 0.25 * eased);
          } else {
            translateX = 80 * eased;
            translateY = -40 * eased;
            opacity = Math.max(0, (pos === 0 ? 1 : pos === 1 ? 0.6 : 0.3) * (1 - eased));
            scale = (pos === 0 ? 1 : pos === 1 ? 0.93 : 0.86) * (1 - 0.2 * eased);
          }
        } else if (pos === 0) {
          if (isSphere) {
            // 新气泡从球体内吐出：从上方(-22px)浮现下落到位
            translateY = (1 - enterP) * -22;
            opacity = enterP;
            scale = 0.72 + enterP * 0.28;
          } else {
            translateX = (1 - enterP) * 60;
            opacity = enterP;
            scale = 0.9 + enterP * 0.1;
          }
        } else if (pos === 1) {
          opacity = isSphere ? 0.55 : 0.6;
          scale = isSphere ? 0.94 : 0.93;
        } else if (pos === 2) {
          opacity = isSphere ? 0.26 : 0.3;
          scale = isSphere ? 0.88 : 0.86;
        } else {
          const extraP = Math.min(1, (pos - 2) * 0.5);
          if (isSphere) {
            translateY = 18 * extraP;
            opacity = Math.max(0, 0.26 - extraP * 0.26);
            scale = 0.88 - extraP * 0.08;
          } else {
            translateY = -20 * extraP;
            translateX = 60 * extraP;
            opacity = Math.max(0, 0.3 - extraP * 0.3);
            scale = 0.86 - extraP * 0.1;
          }
        }

        let icon: ReactNode;
        let bgClass = isSphere ? "bg-white/85" : "bg-white";
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

        // 球体变体：水平居中、top 锚定向下堆叠；边缘变体：right/bottom 锚定向上堆叠
        const posStyle = isSphere
          ? { top: Math.min(pos, MAX_STACK) * bubbleGap + translateY }
          : { bottom: Math.min(pos, MAX_STACK) * bubbleGap + translateY };

        return (
          <div
            key={b.id}
            className={[
              "absolute flex items-start rounded-xl border shadow-lg backdrop-blur-sm",
              isSphere
                ? "left-1/2 w-[204px] gap-1.5 px-2 py-1.5 pointer-events-none"
                : "right-0 w-[260px] gap-2 px-3 py-2 pointer-events-auto",
              borderClass,
              bgClass,
            ].join(" ")}
            style={{
              ...posStyle,
              opacity,
              transform: isSphere
                ? `translateX(-50%) scale(${scale})`
                : `translateX(${translateX}px) scale(${scale})`,
              transformOrigin: isSphere ? "center top" : "right bottom",
              transition: b.exiting ? "none" : "all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            <span className="mt-0.5 shrink-0">{icon}</span>
            <div className="min-w-0 flex-1">
              <p className={`${isSphere ? "text-[10px]" : "text-[11px]"} leading-tight font-medium ${textClass} break-words`}>
                {s.description}
                {s.taskName && s.isTaskStart && (
                  <span className="ml-1 text-[10px] opacity-80">{s.taskIndex}/{s.taskTotal}</span>
                )}
                {s.recordName && s.isRecordStart && (
                  <span className="ml-1 text-[10px] opacity-80">{s.recordIndex}/{s.recordTotal}</span>
                )}
              </p>
              {s.detail && !s.isTaskStart && !s.isRecordStart && (
                <p className={`mt-0.5 text-[10px] leading-tight ${s.success ? "text-emerald-600" : "text-rose-500"} opacity-70 truncate`}>
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
