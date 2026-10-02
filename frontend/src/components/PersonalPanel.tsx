import { useEffect, useRef, useState } from "react";
import { X, Palette, ImagePlus, Trash2, Check, ImageOff } from "lucide-react";

/** 壁纸颜色预设：勾选「使用默认壁纸」后可选的点阵地图颜色（关闭由该勾选框承担，此处不再单列） */
const WALLPAPER_COLORS: { label: string; color: string }[] = [
  { label: "浅灰", color: "#94a3b8" },
  { label: "靛蓝", color: "#818cf8" },
  { label: "青蓝", color: "#38bdf8" },
  { label: "翠绿", color: "#34d399" },
  { label: "琥珀", color: "#fbbf24" },
  { label: "玫粉", color: "#f472b6" },
];

/** 自定义壁纸压缩上限：最长边像素与 JPEG 质量，兼顾清晰度与 localStorage 体积 */
const CUSTOM_WALLPAPER_MAX_SIDE = 1920;
const CUSTOM_WALLPAPER_QUALITY = 0.85;

/** 读取并压缩本地图片为 JPEG DataURL，返回最长边受限后的 base64 */
function readImageAsWallpaper(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onerror = () => reject(new Error("图片无法解析"));
      img.onload = () => {
        const scale = Math.min(1, CUSTOM_WALLPAPER_MAX_SIDE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("画布初始化失败"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", CUSTOM_WALLPAPER_QUALITY));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

/** 面板的三个可调区域（与 App.tsx 的 PanelZone 保持一致） */
type PanelZone = "left" | "top" | "bottom";
const PANEL_ZONE_LABELS: { zone: PanelZone; label: string; hint: string }[] = [
  { zone: "left", label: "侧栏", hint: "申请人记录" },
  { zone: "top", label: "上栏", hint: "两个浏览器面板" },
  { zone: "bottom", label: "下栏", hint: "字段对比 / 文件处理 / 提取元素" },
];

interface PersonalPanelProps {
  open: boolean;
  onClose: () => void;
  /** 壁纸是否开启 */
  wallpaperOn: boolean;
  /** 当前壁纸颜色 */
  wallpaperColor: string;
  /** 切换壁纸（on=false 表示关闭壁纸） */
  onWallpaperChange: (on: boolean, color: string) => void;
  /** 自定义壁纸 DataURL（空字符串表示未上传） */
  wallpaperCustom: string;
  /** 设置自定义壁纸（null/空字符串表示移除） */
  onCustomWallpaperChange: (dataUrl: string | null) => void;
  /** 是否使用默认点阵壁纸（勾选时显示壁纸颜色选择，用点阵地图；取消时走自定义图片） */
  useDefaultWallpaper: boolean;
  /** 切换是否使用默认壁纸 */
  onUseDefaultWallpaperChange: (useDefault: boolean) => void;
  /** 「应用」：按当前勾选状态与已上传图片重新启用壁纸（无壁纸时用于一键恢复） */
  onApplyWallpaper: () => void;
  /** 壁纸亮度系数（0.2~2.0，1.0 为原始亮度） */
  wallpaperBrightness: number;
  /** 写入壁纸亮度 */
  onWallpaperBrightnessChange: (v: number) => void;
  /** 面板背景不透明度，按区域分列（0.15~0.8） */
  panelAlpha: Record<PanelZone, number>;
  /** 写入不透明度：只传被勾选区域的键，未勾选的区域保持原值 */
  onPanelAlphaChange: (next: Partial<Record<PanelZone, number>>) => void;
  /** 面板文字颜色模式：dark = 深色字（默认，浅底清晰），light = 浅色字（壁纸深时提升对比度） */
  panelTextMode: "deep" | "light";
  /** 切换面板文字颜色模式 */
  onPanelTextModeChange: (mode: "deep" | "light") => void;
}

export default function PersonalPanel({
  open,
  onClose,
  wallpaperOn,
  wallpaperColor,
  onWallpaperChange,
  wallpaperCustom,
  onCustomWallpaperChange,
  useDefaultWallpaper,
  onUseDefaultWallpaperChange,
  onApplyWallpaper,
  wallpaperBrightness,
  onWallpaperBrightnessChange,
  panelAlpha,
  onPanelAlphaChange,  panelTextMode,
  onPanelTextModeChange,
}: PersonalPanelProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // scrubbing：按住透明度滑条时隐藏浮层，露出底层壁纸，实时预览透明度变化
  const [scrubbing, setScrubbing] = useState(false);
  // alphaZones：滑块要写入哪些区域。默认三个全选（一根滑块控制全部），
  // 取消勾选后滑块只作用于剩余区域，未勾选的区域保持原值不被重置。
  const [alphaZones, setAlphaZones] = useState<PanelZone[]>(["left", "top", "bottom"]);
  // 滑块读数：单选时显示该区域当前值；多选时显示首个勾选区域的值作为代表
  const alphaValue = alphaZones.length > 0 ? panelAlpha[alphaZones[0]] : 0.8;

  // 全局监听 pointerup，确保在任意位置松开鼠标/触摸都结束 scrubbing
  useEffect(() => {
    if (!scrubbing) return;
    const end = () => setScrubbing(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [scrubbing]);

  if (!open) return null;

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件（jpg / png / webp 等）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await readImageAsWallpaper(file);
      onCustomWallpaperChange(dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "处理图片失败");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200"
      style={{
        // scrubbing（按住透明度滑条）时遮罩与卡片淡出，露出底层壁纸/面板。
        // 注意：这里绝不能设 pointerEvents:"none" —— 滑块就在这层遮罩内部，
        // 一旦置 none，pointerdown 触发的重渲染会立刻让滑块失去指针事件，
        // 表现为「按下能选中、但拖不动」（详见下面 scrubbing 容器的处理）。
        backgroundColor: scrubbing ? "transparent" : "rgba(15,23,42,0.4)",
        backdropFilter: scrubbing ? "none" : undefined,
        WebkitBackdropFilter: scrubbing ? "none" : undefined,
      }}
      onClick={scrubbing ? undefined : onClose}
    >
      <div
        className={[
          "w-full max-w-sm overflow-hidden rounded-2xl border bg-white shadow-xl transition-all duration-200",
          scrubbing ? "border-transparent bg-transparent shadow-none" : "border-slate-200 shadow-xl",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏（scrubbing 时隐藏，只留滑块预览底层壁纸） */}
        {!scrubbing && (
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
            <Palette className="h-4 w-4 text-brand-600" />
            <span className="text-sm font-semibold text-slate-800">PERSONAL</span>
            <span className="text-[10px] text-slate-400">壁纸 · 面板不透明度</span>
            <button
              onClick={onClose}
              className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="space-y-4 px-4 py-3">
          {/* 自定义壁纸上传（scrubbing 时隐藏） */}
          {!scrubbing && (
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-slate-500">自定义壁纸</div>
            {wallpaperCustom ? (
              <div className="flex items-center gap-2">
                <div
                  className="h-14 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100"
                  style={{ backgroundImage: `url(${wallpaperCustom})`, backgroundSize: "cover", backgroundPosition: "center" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-slate-700">已上传壁纸</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => fileRef.current?.click()}
                      className="rounded px-2 py-0.5 text-[10px] font-medium ring-1 transition-all bg-slate-900 text-white ring-slate-900 hover:bg-slate-700"
                    >
                      更换
                    </button>
                    <button
                      onClick={onApplyWallpaper}
                      disabled={wallpaperOn}
                      title={wallpaperOn ? "壁纸已在显示中" : "重新启用壁纸"}
                      className={[
                        "inline-flex items-center gap-0.5 rounded px-2 py-0.5 text-[10px] font-medium ring-1 transition-all",
                        wallpaperOn
                          ? "cursor-default bg-slate-100 text-slate-400 ring-slate-200"
                          : "bg-brand-600 text-white ring-brand-600 hover:bg-brand-700",
                      ].join(" ")}
                    >
                      <Check className="h-2.5 w-2.5" /> 应用
                    </button>
                    <button
                      onClick={() => onCustomWallpaperChange(null)}
                      className="inline-flex items-center gap-0.5 rounded px-2 py-0.5 text-[10px] font-medium text-red-600 ring-1 ring-red-200 transition-all hover:bg-red-50"
                    >
                      <Trash2 className="h-2.5 w-2.5" /> 移除
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-[11px] font-medium text-slate-500 transition-all hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 disabled:opacity-50"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                {busy ? "正在处理…" : "上传图片作为壁纸"}
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            {error && <div className="mt-1 text-[10px] text-red-500">{error}</div>}
          </div>
          )}

          {/* 使用默认壁纸开关 + 壁纸颜色内联在同一行。
              这里刻意用 div + htmlFor 而不是 label 包裹：label 内的 button 点击会连带触发
              勾选框的 toggle，导致「点颜色」变成「先关掉壁纸再切颜色」。 */}
          {!scrubbing && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <input
                id="pp-use-default-wallpaper"
                type="checkbox"
                checked={useDefaultWallpaper}
                onChange={(e) => onUseDefaultWallpaperChange(e.target.checked)}
                className="h-3.5 w-3.5 shrink-0 rounded accent-brand-600"
              />
              <label
                htmlFor="pp-use-default-wallpaper"
                className="cursor-pointer text-[11px] font-medium text-slate-700"
              >
                使用默认壁纸
              </label>

              {/* 壁纸颜色：仅勾选时显示，紧跟在勾选框后面 */}
              {useDefaultWallpaper && (
                <div className="flex flex-wrap items-center gap-1">
                  {WALLPAPER_COLORS.map((wp) => {
                    const active = wallpaperOn && wallpaperColor === wp.color;
                    return (
                      <button
                        key={wp.label}
                        onClick={() => onWallpaperChange(true, wp.color)}
                        title={`壁纸颜色：${wp.label}`}
                        className={[
                          "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 transition-all",
                          active
                            ? "bg-slate-900 text-white ring-slate-900"
                            : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                        ].join(" ")}
                      >
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: wp.color }} />
                        {wp.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          )}

          {/* 无壁纸时的恢复入口：只在真的关掉壁纸时才出现，启用状态不占位 */}
          {!scrubbing && !wallpaperOn && (
          <button
            onClick={onApplyWallpaper}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-brand-400 bg-brand-50 px-3 py-2 text-[11px] font-medium text-brand-700 transition-all hover:bg-brand-100"
            title="重新启用壁纸"
          >
            <ImageOff className="h-3.5 w-3.5" />
            当前无壁纸 · 点此恢复
          </button>
          )}

          {/* 壁纸颜色已并入上方「使用默认壁纸」同一行，此处不再单列 */}

          {/* 壁纸亮度：通过 CSS filter: brightness() 作用于壁纸层，20%~200%，按住拖动时隐藏浮层实时预览 */}
          {/* 仅在有壁纸时显示（无壁纸时该滑块无意义） */}
          {wallpaperOn && (
          <div className={["select-none", scrubbing ? "rounded-xl bg-white/95 p-2 shadow-lg ring-1 ring-slate-200" : ""].join(" ")}>
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-slate-500">
              <span>壁纸亮度</span>
              <span className="tabular-nums text-brand-600">{Math.round(wallpaperBrightness * 100)}%</span>
            </div>
            <input
              type="range"
              min={0.2}
              max={2.0}
              step={0.01}
              value={wallpaperBrightness}
              onChange={(e) => onWallpaperBrightnessChange(parseFloat(e.target.value))}
              onPointerDown={() => setScrubbing(true)}
              onDoubleClick={() => onWallpaperBrightnessChange(1.0)}
              className="w-full accent-brand-600"
              aria-label="壁纸亮度"
              title="双击恢复 100%"
            />
            <div className="mt-0.5 flex justify-between text-[9px] text-slate-400">
              <span>20%</span>
              <span>65%</span>
              <span>110%</span>
              <span>155%</span>
              <span>200%</span>
            </div>
          </div>
          )}

          {/* 面板不透明度：勾选要控制的区域，滑块同时写入这些区域（15%~80%），按住时隐藏浮层实时预览 */}
          {/* select-none：按住滑块拖动时不要把周围文字一起框选（滑块本身是原生 input，
              不在 index.css 里 button/[role=button] 的 user-select:none 覆盖范围内） */}
          <div className={["select-none", scrubbing ? "rounded-xl bg-white/95 p-2 shadow-lg ring-1 ring-slate-200" : ""].join(" ")}>
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-slate-500">
              <span>面板不透明度</span>
              {alphaZones.length > 0 ? (
                <span className="tabular-nums text-brand-600">
                  {alphaZones.length === 1
                    ? `${Math.round(panelAlpha[alphaZones[0]] * 100)}%`
                    : `${Math.round(alphaValue * 100)}%`}
                </span>
              ) : null}
            </div>

            {/* 区域勾选：全选 = 三个区域一起调；单选 = 只调那一个 */}
            <div className="mb-2 flex flex-wrap gap-1.5">
              {PANEL_ZONE_LABELS.map(({ zone, label, hint }) => {
                const checked = alphaZones.includes(zone);
                return (
                  <label
                    key={zone}
                    className={[
                      "flex cursor-pointer select-none items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 transition-all",
                      checked
                        ? "bg-slate-900 text-white ring-slate-900"
                        : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                    ].join(" ")}
                    title={hint}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setAlphaZones((prev) =>
                          e.target.checked ? [...prev, zone] : prev.filter((z) => z !== zone)
                        )
                      }
                      className="h-2.5 w-2.5 rounded accent-brand-600"
                    />
                    {label}
                  </label>
                );
              })}
            </div>

            <input
              type="range"
              min={0.15}
              max={0.8}
              step={0.01}
              value={alphaValue}
              disabled={alphaZones.length === 0}
              aria-label="面板不透明度"
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                const patch: Partial<Record<PanelZone, number>> = {};
                for (const z of alphaZones) patch[z] = v;
                onPanelAlphaChange(patch);
              }}
              onPointerDown={() => setScrubbing(true)}
              className="w-full accent-brand-600 disabled:opacity-40"
            />
            <div className="mt-0.5 flex justify-between text-[9px] text-slate-400">
              <span>15%</span>
              <span>31%</span>
              <span>48%</span>
              <span>64%</span>
              <span>80%</span>
            </div>
            {alphaZones.length === 0 && (
              <div className="mt-1.5 text-[9px] text-slate-400">未勾选区域，滑块不生效。</div>
            )}
          </div>

          {/* 面板文字颜色：壁纸较深时切换浅色文字提升对比度 */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-slate-500">
              文字颜色 <span className="text-slate-400">（深色壁纸用浅色字）</span>
            </div>
            <div className="flex gap-1.5">
              {([
                { label: "深色文字", value: "deep" as const, swatch: "#0f172a" },
                { label: "浅色文字", value: "light" as const, swatch: "#f8fafc" },
              ]).map((m) => (
                <button
                  key={m.value}
                  onClick={() => onPanelTextModeChange(m.value)}
                  className={[
                    "flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium ring-1 transition-all",
                    panelTextMode === m.value
                      ? "bg-slate-900 text-white ring-slate-900"
                      : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                  ].join(" ")}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full border border-slate-300"
                    style={{ backgroundColor: m.swatch }}
                  />
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}