import { useEffect, useMemo, useRef, useState } from "react";

/**
 * DotWorldMap —— Minecraft 风格点阵世界地图背景板
 *
 * 用 64×28 的网格点阵绘制世界地图（'.'=海洋空洞，'#'=陆地方块）。
 * 两种渲染路径：
 *  1. 默认（居中大图）：CSS 逐点 radial-gradient 拼接，适合居中展示，无需图片资源。
 *  2. pattern 平铺（壁纸铺满整窗）：用离屏 canvas 画一张无缝 tile 位图导出为
 *     background-image 平铺，GPU 直接纹理采样，避免数百层渐变逐帧合成导致的卡顿。
 *  支持自定义配色（默认 slate 灰蓝系，适配浅色主题背景板）。
 */

export interface DotWorldMapProps {
  /** 点阵颜色（陆地），默认当前主题 slate-300/400 系 */
  color?: string;
  /** 网格列数（必须与 MAP 行长度一致，默认 64） */
  columns?: number;
  /** 点直径（px），默认 4；配合 gap 形成方块点阵（fillViewport 模式下自动忽略） */
  dotSize?: number;
  /** 点间距（px），默认 2（fillViewport 模式下自动忽略） */
  gap?: number;
  /** 壁纸平铺模式：用 canvas 生成无缝 tile 位图，backgroundRepeat 平铺铺满（性能最优） */
  pattern?: boolean;
  /** 壁纸模式：根据视口自动放大点径，使地图铺满整个屏幕（默认 false） */
  fillViewport?: boolean;
  /** 附加 className（定位/层级由调用方控制） */
  className?: string;
  /** 透明度 0~1，默认 1（由调用方容器控制整体透明度更灵活） */
  opacity?: number;
  style?: React.CSSProperties;
}

/**
 * 64×28 点阵世界地图。
 * 每行一个字符串，'.' 为海洋（不绘制），'#' 为陆地（绘制方块点）。
 * 覆盖约 80°N ~ 55°S：北极群岛/格陵兰、北美、南美、欧亚、非洲、澳洲、新几内亚、新西兰。
 */
const MAP: string[] = [
  "..........#######..#########......#.............................",
  "........#####################......##.........#####.............",
  "..#############...###########.....##############################",
  ".######.######...###########.##...##############################",
  "..####...#####....#####.###...#..###############################",
  "..........####...######..#....##.###############################",
  "...........############.#.....#################################.",
  "...........#############......#################################.",
  "...........#############......#################################.",
  "............############.........##############################.",
  ".............#########........###########################.......",
  "..............######.##.......###########################.......",
  "...............####...........########################..........",
  "................####..........#################...###...........",
  ".................###...........#########.....#....####..........",
  "....................#####.......#######...........#######.......",
  "...................########......######...........#########.....",
  "...................########......######............##########...",
  "....................#######.......#####...#.........######.###..",
  "....................#######.......#####...#..........#######....",
  ".....................#####.........###....#..........#######....",
  ".....................####..........##................#######....",
  "......................###............................######...#.",
  "......................##.............................#####....#.",
  "......................##................................#....##.",
  "......................##.....................................#..",
  "......................#.........................................",
  "......................#.........................................",
];

// 以列-行为键缓存陆地坐标，避免每次渲染重新扫描
let cachedKey = "";
let cachedDots: string[] = [];

/** 展开 MAP 为 "row col" 坐标列表（模块级缓存） */
function landDots(): string[] {
  const key = MAP.join("|");
  if (key !== cachedKey) {
    const dots: string[] = [];
    MAP.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] === "#") dots.push(`${r} ${c}`);
      }
    });
    cachedKey = key;
    cachedDots = dots;
  }
  return cachedDots;
}

/** 无缝 tile 位图缓存：颜色/步长不变则复用，避免反复 toDataURL */
let tileCacheKey = "";
let tileCacheUrl = "";
let tileCacheEl: HTMLCanvasElement | null = null;

/**
 * 用离屏 canvas 生成一张无缝 tile 位图（dataURL）。
 * 跨 tile 边界的点会在对侧重复绘制，保证 backgroundRepeat 平铺后地图连续无接缝。
 */
function renderTile(color: string, effDot: number, effGap: number, columns: number): string {
  const rows = MAP.length;
  const step = effDot + effGap;
  const tileW = columns * step;
  const tileH = rows * step;
  const key = `${color}|${effDot}|${effGap}|${columns}`;
  if (key === tileCacheKey && tileCacheEl && tileCacheUrl) return tileCacheUrl;

  // 复用已有的离屏 canvas，避免频繁创建
  let canvas = tileCacheEl;
  if (!canvas) {
    canvas = document.createElement("canvas");
    tileCacheEl = canvas;
  }
  // canvas 尺寸变化时需重新分配；dpr 缩放保证锐利（导出时除以 dpr 还原 CSS 尺寸）
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const needResize = canvas.width !== Math.round(tileW * dpr) || canvas.height !== Math.round(tileH * dpr);
  canvas.width = Math.round(tileW * dpr);
  canvas.height = Math.round(tileH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  if (needResize) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, tileW, tileH);
  ctx.fillStyle = color;
  const r = effDot / 2 - 0.5;
  const d = effDot;
  landDots().forEach((pos) => {
    const [r0, c0] = pos.split(" ").map(Number);
    const x = c0 * step;
    const y = r0 * step;
    // 在当前 tile 及跨边界的 8 邻域各画一次，保证平铺无缝
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const px = x + dx * tileW;
        const py = y + dy * tileH;
        if (px + d < 0 || px > tileW || py + d < 0 || py > tileH) continue;
        // 直接用 fillRect 画方点：点径仅数像素，无需圆角，兼容性最好
        ctx.fillRect(px, py, d, d);
      }
    }
  });

  const url = canvas.toDataURL("image/png");
  tileCacheKey = key;
  tileCacheUrl = url;
  return url;
}

export default function DotWorldMap({
  color = "currentColor",
  columns = 64,
  dotSize = 4,
  gap = 2,
  pattern = false,
  fillViewport = false,
  className = "",
  opacity = 1,
  style,
}: DotWorldMapProps) {
  // 壁纸模式：监听视口尺寸，自动计算铺满屏幕所需的点径
  const [vpSize, setVpSize] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    if (!fillViewport) return;
    const update = () => setVpSize({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [fillViewport]);

  const rows = MAP.length;
  let effDot = dotSize;
  let effGap = gap;
  if (fillViewport) {
    const step0 = dotSize + gap;
    const unit = Math.max(
      (vpSize.w / (columns * step0)) * step0,
      (vpSize.h / (rows * step0)) * step0,
    );
    effDot = Math.max(dotSize, Math.round(unit * 10) / 10);
    effGap = (effDot / dotSize) * gap;
  }
  const step = effDot + effGap;
  const dots = landDots();

  // 整幅地图的像素尺寸
  const mapW = columns * step - effGap;
  const mapH = rows * step - effGap;

  // pattern 平铺：生成无缝 tile 位图，GPU 纹理采样平铺，性能远优于数百层渐变逐帧合成
  const tileUrl = useMemo(() => {
    if (!pattern) return "";
    try {
      return renderTile(color, effDot, effGap, columns);
    } catch {
      return "";
    }
  }, [pattern, color, effDot, effGap, columns]);

  if (pattern) {
    const tileW = columns * step;
    const tileH = rows * step;
    return (
      <div
        aria-hidden="true"
        className={className}
        style={{
          width: "100%",
          height: "100%",
          opacity,
          backgroundImage: tileUrl ? `url(${tileUrl})` : undefined,
          backgroundRepeat: "repeat",
          backgroundSize: `${tileW}px ${tileH}px`,
          ...style,
        }}
      />
    );
  }

  // 逐点 radial-gradient：每个陆地格一个实心方块（圆角极小的方点）
  const gradients = dots
    .map((pos) => {
      const [r, c] = pos.split(" ").map(Number);
      const x = c * step;
      const y = r * step;
      // 以 dotSize x dotSize 的方形渐变点呈现（radial 圆点在 Minecraft 风下更接近方点，
      // 这里用极小圆角半径，视觉上即为方块点阵）
      return `radial-gradient(${effDot}px ${effDot}px at ${x + effDot / 2}px ${y + effDot / 2}px, ${color} ${effDot / 2 - 0.5}px, transparent ${effDot / 2}px)`;
    })
    .join(", ");

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        width: mapW,
        height: mapH,
        opacity,
        backgroundImage: gradients,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${mapW}px ${mapH}px`,
        ...style,
      }}
    />
  );
}