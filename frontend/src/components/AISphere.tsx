import { useEffect, useRef } from "react";

/**
 * AI 粒子球（黑白配色）：左侧面板的 AI 角色化身。
 * 动画核心参考 Hansonus 项目的 AIParticleSphere（球面粒子 + 弹簧物理），
 * 收敛为克制的双状态设计：
 *
 * - idle       平常态：Fibonacci 矩阵球缓慢旋转 + 轻微呼吸，偶发小幅液态形变
 * - processing LOOP 运行：球体略收缩、旋转加快、扰动增强、整体轻微提亮
 *
 * （alert/speaking 为克制变体：alert 缓慢脉动提醒，speaking 平滑小幅扩张）
 */
export type AISphereState = "idle" | "processing" | "alert" | "speaking";

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  baseX: number; baseY: number; baseZ: number;
  half: number;   // 方格半边长（逻辑单位）
  lig: number;    // 灰度亮度基数（黑白配色仅 lightness 变化）
}

const PARTICLE_COUNT = 280;

export default function AISphere({ state, size = 132 }: { state: AISphereState; size?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<AISphereState>(state);
  stateRef.current = state;
  // 暗色主题：球体用白色系；亮色主题：黑色系
  const darkRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d")!;

    // 跟随 html[data-theme] 切换黑白配色
    const root = document.documentElement;
    const syncTheme = () => { darkRef.current = root.getAttribute("data-theme") === "dark"; };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    // ---- 粒子初始化（Fibonacci 球面均匀分布，数字矩阵秩序感） ----
    // 逻辑半径（相对 100x100 视口）：预留边缘余量，膨胀/液态形变时不被容器裁切
    const R = 38;
    const particles: Particle[] = [];
    {
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const y01 = 1 - (i / (PARTICLE_COUNT - 1)) * 2; // 1 → -1
        const rad = Math.sqrt(Math.max(0, 1 - y01 * y01));
        const theta = golden * i;
        const r = R * (0.95 + Math.random() * 0.05); // 轻微径向抖动，避免过于机械
        const x = r * rad * Math.cos(theta);
        const y = r * y01;
        const z = r * rad * Math.sin(theta);
        particles.push({
          x, y, z, baseX: x, baseY: y, baseZ: z,
          vx: 0, vy: 0, vz: 0,
          half: 1.15 + Math.random() * 0.4, // 近似统一尺寸的方格单元（LED 点阵感）
          lig: Math.random(),
        });
      }
    }

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const s = Math.min(rect.width, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = s * dpr;
      canvas.height = s * dpr;
      canvas.style.width = `${s}px`;
      canvas.style.height = `${s}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    // ---- 动画状态 ----
    const rot = { y: 0, x: 0, time: 0 };
    let sphereScale = 1;
    let rotSpeed = 1;
    let stateTimer = 0;
    let prevState: AISphereState = stateRef.current;
    // 液态流动调度（idle 偶发，小幅果冻形变）
    const LIQUID_DUR = 2.5;
    let liquidActive = 0;
    let liquidAmp = 0;
    let liquidFreq = 1.5;
    let liquidTimer = 5 + Math.random() * 7;

    let raf = 0;
    const animate = () => {
      const rect = container.getBoundingClientRect();
      const s = Math.min(rect.width, rect.height);
      if (s < 8) { raf = requestAnimationFrame(animate); return; }
      const k = s / 100; // 逻辑坐标 → 实际像素
      const state = stateRef.current;
      if (state !== prevState) { prevState = state; stateTimer = 0; }
      stateTimer += 0.016;
      rot.time += 0.005;

      // 各状态的目标形态参数（克制：平常态 vs LOOP 运行态）
      let targetScale = 1 + Math.sin(rot.time * 0.8) * 0.012; // 平常态：缓慢呼吸
      let targetRotSpeed = 1, turbulence = 0.04, springK = 0.025;
      if (state === "processing") {
        // LOOP 运行：略收缩 + 稳定加速 + 扰动增强
        targetScale = 0.92; targetRotSpeed = 1.8; turbulence = 0.1; springK = 0.035;
      } else if (state === "speaking") {
        // 讲解中：平滑小幅扩张 + 旋转放缓
        targetScale = 1.08; targetRotSpeed = 0.7; turbulence = 0.03; springK = 0.03;
      } else if (state === "alert") {
        // 发现问题：缓慢脉动提醒
        targetScale = 1 + Math.sin(stateTimer * 2) * 0.03;
        targetRotSpeed = 1; turbulence = 0.05; springK = 0.028;
      }
      sphereScale += (targetScale - sphereScale) * 0.06;
      rotSpeed += (targetRotSpeed - rotSpeed) * 0.05;

      // 液态流动：idle 时随机触发的小幅果冻形变
      if (liquidActive > 0) {
        liquidActive -= 1 / 60;
        const remaining = Math.max(0, liquidActive);
        const elapsed = LIQUID_DUR - remaining;
        const fadeIn = Math.min(1, elapsed / 0.5);
        const fadeOut = Math.min(1, remaining / 0.8);
        liquidAmp = 2.5 * Math.min(fadeIn, fadeOut);
        if (liquidActive <= 0) { liquidAmp = 0; liquidTimer = 6 + Math.random() * 9; }
      } else {
        liquidTimer -= 1 / 60;
        if (liquidTimer <= 0 && state === "idle") {
          liquidActive = LIQUID_DUR;
          liquidFreq = 1.2 + Math.random() * 2.2;
        }
      }

      rot.y += 0.002 * rotSpeed;
      rot.x = Math.sin(rot.time * 0.35) * 0.06;

      ctx.clearRect(0, 0, s, s);
      const cx = s / 2, cy = s / 2;
      const dark = darkRef.current;
      // 黑白配色：亮色主题近黑粒子，暗色主题近白粒子（亮度区间收窄，观感平稳）
      const dotLig = (p: Particle) => dark ? 76 + p.lig * 10 : 18 + p.lig * 10;
      // LOOP 运行：整体轻微提亮
      const stateLigBoost = state === "processing" ? 6 : 0;

      // ---- 粒子物理：弹簧回归 + 微扰动 ----
      const projected: { x: number; y: number; z: number; half: number; alpha: number; lig: number }[] = [];
      for (const p of particles) {
        if (Math.random() < 0.015 + turbulence * 0.03) {
          p.vx += (Math.random() - 0.5) * (0.15 + turbulence * 0.5);
          p.vy += (Math.random() - 0.5) * (0.15 + turbulence * 0.5);
          p.vz += (Math.random() - 0.5) * (0.15 + turbulence * 0.5);
        }

        let targetX = p.baseX * sphereScale;
        let targetY = p.baseY * sphereScale;
        let targetZ = p.baseZ * sphereScale;
        if (liquidAmp > 0.01) {
          const tNow = performance.now() * 0.001;
          const phaseShift = (p.baseX + p.baseY * 1.3 + p.baseZ * 0.7) * 0.012;
          const wave1 = Math.sin(tNow * liquidFreq + phaseShift);
          const wave2 = Math.cos(tNow * liquidFreq * 0.6 + phaseShift * 1.4);
          targetX += wave1 * liquidAmp * 1.2;
          targetY += wave2 * liquidAmp;
          targetZ += (wave1 + wave2) * 0.5 * liquidAmp * 0.8;
        }

        p.vx += (targetX - p.x) * springK;
        p.vy += (targetY - p.y) * springK;
        p.vz += (targetZ - p.z) * springK;
        p.vx *= 0.88; p.vy *= 0.88; p.vz *= 0.88;
        p.x += p.vx; p.y += p.vy; p.z += p.vz;

        // 旋转 + 透视投影
        const cosY = Math.cos(rot.y), sinY = Math.sin(rot.y);
        const cosX = Math.cos(rot.x), sinX = Math.sin(rot.x);
        const rx = p.x * cosY - p.z * sinY;
        let rz = p.x * sinY + p.z * cosY;
        const ry = p.y * cosX - rz * sinX;
        rz = p.y * sinX + rz * cosX;
        const persp = 110 * k;
        const sc = persp / (persp + rz * k);
        const sx = cx + rx * k * sc;
        const sy = cy + ry * k * sc;
        const alpha = 0.2 + sc * 0.8;
        const fresnel = 1 - Math.min(Math.abs(rz) / (R * sphereScale), 1);
        const lig = Math.min(dotLig(p) + stateLigBoost + fresnel * 4, dark ? 92 : 34);
        projected.push({ x: sx, y: sy, z: rz, half: p.half * k * sc, alpha, lig });
      }
      projected.sort((a, b) => a.z - b.z);

      // ---- 粒子渲染：干脆的方格子（无辉光，边缘锐利） ----
      for (const p of projected) {
        ctx.fillStyle = `hsla(0,0%,${p.lig}%,${Math.min(p.alpha, 1)})`;
        ctx.fillRect(p.x - p.half, p.y - p.half, p.half * 2, p.half * 2);
      }

      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex items-center justify-center"
      style={{ width: size, height: size }}
      title="AI 助手"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
