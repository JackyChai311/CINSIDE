import { useEffect, useRef, useState } from "react";
import { Check, ImageOff, ImagePlus, Trash2 } from "lucide-react";

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
export type PanelZone = "left" | "top" | "bottom";
const PANEL_ZONE_LABELS: { zone: PanelZone; label: string; hint: string }[] = [
  { zone: "left", label: "侧栏", hint: "申请人记录" },
  { zone: "top", label: "上栏", hint: "两个浏览器面板" },
  { zone: "bottom", label: "下栏", hint: "字段对比 / 文件处理 / 提取元素" },
];

interface AppearanceSectionProps {
  wallpaperOn: boolean;
  wallpaperColor: string;
  onWallpaperChange: (on: boolean, color: string) => void;
  wallpaperCustom: string;
  onCustomWallpaperChange: (dataUrl: string | null) => void;
  useDefaultWallpaper: boolean;
  onUseDefaultWallpaperChange: (useDefault: boolean) => void;
  onApplyWallpaper: () => void;
  wallpaperBrightness: number;
  onWallpaperBrightnessChange: (v: number) => void;
  panelAlpha: Record<PanelZone, number>;
  onPanelAlphaChange: (next: Partial<Record<PanelZone, number>>) => void;
}

/**
 * 外观控制区（原 PERSONAL 的壁纸/不透明度/文字颜色部分，现移入 SETTINGS）：
 * 自定义壁纸上传、默认壁纸+颜色、壁纸亮度、面板不透明度、面板文字颜色。
 * 改即生效（亮度/透明度滑块通过父级 onXxxChange 回调即时应用）。
 */
export default function AppearanceSection({
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
  onPanelAlphaChange,
}: AppearanceSectionProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // scrubbing：按住透明度滑条时隐藏浮层，露出底层壁纸，实时预览透明度变化
  const [scrubbing, setScrubbing] = useState(false);
  // alphaZones：滑块要写入哪些区域。默认三个全选（一根滑块控制全部），
  // 取消勾选后滑块只作用于剩余区域，未勾选的区域保持原值不被重置。
  const [alphaZones, setAlphaZones] = useState<PanelZone[]>(["left", "top", "bottom"]);
  const alphaValue = alphaZones.length > 0 ? panelAlpha[alphaZones[0]] : 0.8;

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
    <div className="space-y-4">
      {/* 自定义壁纸上传 */}
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

      {/* 使用默认壁纸开关 + 壁纸颜色内联在同一行。
          刻意用 div + htmlFor 而不是 label 包裹：label 内的 button 点击会连带触发勾选框 toggle。 */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <input
            id="app-use-default-wallpaper"
            type="checkbox"
            checked={useDefaultWallpaper}
            onChange={(e) => onUseDefaultWallpaperChange(e.target.checked)}
            className="h-3.5 w-3.5 shrink-0 rounded accent-brand-600"
          />
          <label
            htmlFor="app-use-default-wallpaper"
            className="cursor-pointer text-[11px] font-medium text-slate-700"
          >
            使用默认壁纸
          </label>

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

      {/* 无壁纸时的恢复入口 */}
      {!wallpaperOn && (
        <button
          onClick={onApplyWallpaper}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-brand-400 bg-brand-50 px-3 py-2 text-[11px] font-medium text-brand-700 transition-all hover:bg-brand-100"
          title="重新启用壁纸"
        >
          <ImageOff className="h-3.5 w-3.5" />
          当前无壁纸 · 点此恢复
        </button>
      )}

      {/* 壁纸亮度 */}
      {wallpaperOn && (
        <div className="select-none">
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

      {/* 面板不透明度 */}
      <div className="select-none">
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

      {/* 文字颜色已并入主题外观：浅色主题=深色文字，深色主题=浅色文字 */}
    </div>
  );
}
