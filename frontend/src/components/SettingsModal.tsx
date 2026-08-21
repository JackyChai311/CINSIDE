import { useEffect, useState } from "react";
import { CheckCircle2, Cpu, Download, Eye, EyeOff, Film, FolderOpen, Globe, Loader2, Maximize2, Minus, MonitorCheck, MonitorOff, Moon, Package, Palette, Plus, RefreshCw, RotateCcw, Save, Settings2, ShieldCheck, ShieldX, Sparkles, Sun, Target, X, XCircle, Zap } from "lucide-react";
import { api } from "../api/client";
import type { AppSettings, DepsStatus, GpuInfo } from "../types";

interface Props {
  initial: AppSettings;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
  onScaleChange?: (scale: number) => void;
  onBrightnessChange?: (brightness: number) => void;
  onAppearanceChange?: (theme: string, accent: string) => void;
}

const DEFAULTS: AppSettings = {
  agent_backend: "browser_use",
  vision_api_base: "https://token.sensenova.cn/v1",
  vision_api_key: "",
  vision_model: "sensenova-6.7-flash-lite",
  text_api_base: "",
  text_api_key: "",
  text_model: "deepseek-v4-flash",
  analysis_api_base: "",
  analysis_api_key: "",
  analysis_model: "",
  sensenova_api_base: "https://token.sensenova.cn/v1",
  sensenova_api_key: "",
  sensenova_model: "sensenova-u1-fast",
  browser_use_llm_base: "https://token.sensenova.cn/v1",
  browser_use_llm_key: "",
  browser_use_llm_model: "sensenova-6.7-flash-lite",
  prevent_accidental_close: false,
  loop_keep_awake: false,
  high_speed_mode: false,
  igpu_acceleration: false,
  ui_scale: 1.0,
  demo_site_enabled: false,
  theme: "light",
  accent: "indigo",
  browser_brightness: 1.0,
  expert_mode: false,
};

// 可选主色调：名称 → 展示色（与 index.css 中 [data-accent] 对应）
const ACCENTS: { key: string; label: string; color: string }[] = [
  { key: "indigo", label: "靛蓝", color: "#6366f1" },
  { key: "sky", label: "天蓝", color: "#0ea5e9" },
  { key: "emerald", label: "翡翠绿", color: "#10b981" },
  { key: "rose", label: "玫红", color: "#f43f5e" },
  { key: "violet", label: "紫罗兰", color: "#8b5cf6" },
  { key: "amber", label: "琥珀", color: "#f59e0b" },
];

// 文件识别 5 档调节杆（准确→速度）：一杆联动 识别引擎 × VIZ兜底 × 自动转正 × 高速模式
const RECOG_GEARS = [
  {
    title: "AI识图\nVIZ·转正",
    desc: "第1档（最准确）：识图 AI 读文件 + 朝向转正 + VIZ 看图兜底——OCR/排版都读不出的字段由视觉模型看图补提。极致准确率，慢（兜底常需 30~90 秒/字段）。",
    patch: { ocr_engine: "vision", vision_auto_orient: true, vision_viz_fallback: true, high_speed_mode: false },
  },
  {
    title: "AI识图\n自动转正",
    desc: "第2档：识图 AI 读文件，朝向自动转正（每张 2~10 秒朝向检测）。方向乱的扫描件首选，VIZ 兜底不启用。",
    patch: { ocr_engine: "vision", vision_auto_orient: true, vision_viz_fallback: false, high_speed_mode: false },
  },
  {
    title: "AI识图\n无自动转正",
    desc: "第3档：识图 AI 读文件，跳过朝向检测。文件基本都是正向时省时提速，识别精度同第2档。",
    patch: { ocr_engine: "vision", vision_auto_orient: false, vision_viz_fallback: false, high_speed_mode: false },
  },
  {
    title: "OCR\n自动转正",
    desc: "第4档：UMI-OCR 本地识别（不耗识图 AI 调用），保留朝向转正。清晰印刷件的速度与准确平衡点。",
    patch: { ocr_engine: "umi", vision_auto_orient: true, vision_viz_fallback: false, high_speed_mode: false },
  },
  {
    title: "OCR\n无转正·高速",
    desc: "第5档（最快）：UMI-OCR + 跳过转正 + OCR 与浏览器步骤并行 + 压缩步骤间等待。批量跑正向清晰文件时每张约省 8~20 秒。",
    patch: { ocr_engine: "umi", vision_auto_orient: false, vision_viz_fallback: false, high_speed_mode: true },
  },
];

export default function SettingsModal({ initial, onClose, onSaved, onScaleChange, onBrightnessChange, onAppearanceChange }: Props) {
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULTS, ...initial });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 依赖与工具状态
  const [depsStatus, setDepsStatus] = useState<DepsStatus | null>(null);
  const [pipInstalling, setPipInstalling] = useState(false);
  const [pipMessage, setPipMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [ocrInstalling, setOcrInstalling] = useState(false);
  const [ocrInstallMsg, setOcrInstallMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [umiDownloading, setUmiDownloading] = useState(false);
  const [umiDownloadMsg, setUmiDownloadMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [umiOpenMsg, setUmiOpenMsg] = useState("");

  // 核显加速：显卡检测结果
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [gpuDetecting, setGpuDetecting] = useState(false);
  const detectGpuInfo = async (refresh = false) => {
    setGpuDetecting(true);
    try {
      if (refresh) {
        // 手动重检：先重跑 GPU 自检（子进程探测，最长约 1 分钟），再取硬件+引擎状态
        try { await api.runGpuSelftest(); } catch { /* 自检失败也继续取状态 */ }
      }
      const info = await api.getGpuInfo(refresh);
      setGpuInfo(info);
    } catch {
      setGpuInfo({
        ok: false, error: "检测请求失败，请确认后端已启动",
        gpus: [], igpu: null, has_igpu: false,
        cpu: { name: "", physical_cores: 0, logical_cores: 0 },
        local_engine: { installed: false, backend: "", tested: false, testing: false, detail: "", gpu_name: "", last_ms: 0, install_error: "" },
        gpu_ocr_supported: false,
      });
    } finally {
      setGpuDetecting(false);
    }
  };

  // 打开 UMI-OCR 所在文件夹（选中 exe，便于手动双击启动）
  const handleOpenUmiFolder = async () => {
    try {
      const res = await api.openUmiOcrFolder();
      setUmiOpenMsg(res.message || "已打开所在文件夹");
    } catch {
      setUmiOpenMsg("打开文件夹请求失败，请确认后端已启动");
    }
  };
  const [umiProgress, setUmiProgress] = useState<{
    stage: "fetching" | "downloading" | "extracting" | "done" | "error";
    percent: number;
    downloadedMB: number;
    totalMB: number;
    message: string;
    mirror: string;
  } | null>(null);
  const [remotionInstalling, setRemotionInstalling] = useState(false);
  const [remotionMsg, setRemotionMsg] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api.getSettings()
      .then((s) => setSettings((prev) => ({ ...prev, ...s })))
      .catch(() => {});
    // 获取依赖状态
    refreshDepsStatus();
    // 检测显卡（后端有会话级缓存，重复打开面板不重查硬件）
    detectGpuInfo();
  }, []);

  const refreshDepsStatus = async () => {
    try {
      const status = await api.getDepsStatus();
      setDepsStatus(status);
    } catch {
      // 后端可能未启动或接口不可用，静默忽略
    }
  };

  const handleInstallPythonDeps = async () => {
    setPipInstalling(true);
    setPipMessage(null);
    try {
      const r = await api.installPythonDeps();
      setPipMessage({ ok: r.ok, message: r.message });
      if (r.ok) {
        await refreshDepsStatus();
      }
    } catch (e: any) {
      setPipMessage({ ok: false, message: e.message || "安装失败" });
    } finally {
      setPipInstalling(false);
    }
  };

  const handleInstallOcrEngine = async () => {
    setOcrInstalling(true);
    setOcrInstallMsg(null);
    try {
      const r = await api.installOcrEngineDeps();
      setOcrInstallMsg({ ok: r.ok, message: r.message });
      if (r.ok) {
        // 安装+自动自检已在后端完成，这里刷新依赖与引擎状态展示
        await Promise.all([refreshDepsStatus(), detectGpuInfo(true)]);
      }
    } catch (e: any) {
      setOcrInstallMsg({ ok: false, message: e.message || "安装失败" });
    } finally {
      setOcrInstalling(false);
    }
  };

  const handleDownloadUmiOcr = async () => {
    setUmiDownloading(true);
    setUmiDownloadMsg(null);
    setUmiProgress({
      stage: "fetching",
      percent: 0,
      downloadedMB: 0,
      totalMB: 0,
      message: "正在连接服务器…",
      mirror: "",
    });

    const apiHost =
      typeof window !== "undefined" && window.electronAPI && !window.location.hostname
        ? "http://localhost:8000"
        : "";

    // 尝试 SSE 流式下载；如果失败（旧后端/网络问题），回退到 POST 同步下载
    let sseReceivedData = false;
    try {
      const controller = new AbortController();
      // 5秒内必须收到第一个字节，否则判定 SSE 不可用，回退 POST
      const connectTimeout = setTimeout(() => {
        if (!sseReceivedData) controller.abort();
      }, 5000);

      const resp = await fetch(`${apiHost}/api/config/download-umi-ocr/stream`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`SSE unavailable (${resp.status})`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseReceivedData = true;
        clearTimeout(connectTimeout);

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            const stage = event.stage as string;
            const downloaded = event.downloaded || 0;
            const total = event.total || 0;
            const pct =
              total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;

            if (stage === "done") {
              setUmiProgress({
                stage: "done",
                percent: 100,
                downloadedMB: total ? Math.round(total / (1024 * 1024)) : 0,
                totalMB: total ? Math.round(total / (1024 * 1024)) : 0,
                message: event.message || "安装完成",
                mirror: event.mirror || "",
              });
              setUmiDownloadMsg({ ok: true, message: event.message });
              await refreshDepsStatus();
            } else if (stage === "error") {
              setUmiProgress({
                stage: "error",
                percent: pct,
                downloadedMB: Math.round(downloaded / (1024 * 1024)),
                totalMB: Math.round(total / (1024 * 1024)),
                message: event.message || "下载失败",
                mirror: event.mirror || "",
              });
              setUmiDownloadMsg({ ok: false, message: event.message });
            } else {
              setUmiProgress({
                stage: stage as any,
                percent: stage === "extracting" ? 100 : pct,
                downloadedMB: Math.round(downloaded / (1024 * 1024)),
                totalMB: Math.round(total / (1024 * 1024)),
                message: event.message || "",
                mirror: event.mirror || "",
              });
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
      clearTimeout(connectTimeout);
    } catch (e: any) {
      // SSE 失败且没收到任何数据 → 回退到 POST 同步接口
      if (!sseReceivedData) {
        try {
          setUmiProgress({
            stage: "downloading",
            percent: 0,
            downloadedMB: 0,
            totalMB: 100,
            message: "正在下载安装（约100MB，请耐心等待）…",
            mirror: "",
          });
          const r = await api.downloadUmiOcr();
          setUmiDownloadMsg({ ok: r.ok, message: r.message });
          if (r.ok) {
            setUmiProgress({
              stage: "done",
              percent: 100,
              downloadedMB: 100,
              totalMB: 100,
              message: "安装完成",
              mirror: "",
            });
            await refreshDepsStatus();
          } else {
            setUmiProgress({
              stage: "error",
              percent: 0,
              downloadedMB: 0,
              totalMB: 0,
              message: r.message,
              mirror: "",
            });
          }
        } catch (e2: any) {
          setUmiDownloadMsg({ ok: false, message: e2.message || "下载失败" });
          setUmiProgress((prev) =>
            prev ? { ...prev, stage: "error", message: e2.message || "下载失败" } : prev
          );
        }
      } else {
        setUmiDownloadMsg({ ok: false, message: e.message || "下载失败" });
        setUmiProgress((prev) =>
          prev ? { ...prev, stage: "error", message: e.message || "下载失败" } : prev
        );
      }
    } finally {
      setUmiDownloading(false);
    }
  };

  const handleInstallRemotion = async () => {
    setRemotionInstalling(true);
    setRemotionMsg(null);
    try {
      const r = await api.installRemotion();
      setRemotionMsg({ ok: r.ok, message: r.message });
      if (r.ok) {
        await refreshDepsStatus();
      }
    } catch (e: any) {
      setRemotionMsg({ ok: false, message: e.message || "安装失败" });
    } finally {
      setRemotionInstalling(false);
    }
  };

  const update = (patch: Partial<AppSettings>) => {
    // 单一 AI 配置：保持三组值同步
    const next = { ...settings, ...patch };
    if ("vision_api_base" in patch || "browser_use_llm_base" in patch) {
      next.vision_api_base = next.browser_use_llm_base = next.vision_api_base || next.browser_use_llm_base;
    }
    if ("vision_api_key" in patch || "browser_use_llm_key" in patch) {
      next.vision_api_key = next.browser_use_llm_key = next.vision_api_key || next.browser_use_llm_key;
    }
    if ("vision_model" in patch || "browser_use_llm_model" in patch) {
      next.vision_model = next.browser_use_llm_model = next.vision_model || next.browser_use_llm_model;
    }
    setSettings(next);
    setTestResult(null);
    setError(null);
    // 主题/主色调：点击即生效，不等待保存按钮
    if ("theme" in patch || "accent" in patch) {
      onAppearanceChange?.(next.theme || "light", next.accent || "indigo");
    }
  };

  // 当前档位：由 引擎 × VIZ兜底 × 自动转正 反推（高速模式只随第5档打开）
  const recogGearPos = (settings.ocr_engine || "vision") === "vision"
    ? (settings.vision_viz_fallback === true ? 0 : settings.vision_auto_orient !== false ? 1 : 2)
    : (settings.vision_auto_orient !== false ? 3 : 4);

  const handleTest = async () => {
    const base = (settings.vision_api_base || "").trim();
    // 本地先校验 URL 协议，填错（如 hhttps://）直接提示，不发起请求干等
    if (base && !base.startsWith("http://") && !base.startsWith("https://")) {
      setTestResult({ ok: false, message: `API Base URL 格式错误（应以 http:// 或 https:// 开头）：${base.slice(0, 60)}` });
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      await api.saveSettings(settings);
      const r = await api.testVision();
      setTestResult({ ok: r.supports_images, message: r.message });
    } catch (e: any) {
      setTestResult({ ok: false, message: e.message || "检测失败" });
    } finally {
      setTesting(false);
    }
  };

  // 全局分析模型测试：按面板当前填写（留空项按已保存配置继承）发极小请求
  const [testAnalysisRunning, setTestAnalysisRunning] = useState(false);
  const [testAnalysisMsg, setTestAnalysisMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handleTestAnalysis = async () => {
    setTestAnalysisRunning(true);
    setTestAnalysisMsg(null);
    try {
      const r = await api.testAnalysis({
        api_base: settings.analysis_api_base || "",
        api_key: settings.analysis_api_key || "",
        model: settings.analysis_model || "",
      });
      setTestAnalysisMsg({ ok: r.ok, text: r.message });
    } catch (e: any) {
      setTestAnalysisMsg({ ok: false, text: e?.message || "测试请求失败" });
    } finally {
      setTestAnalysisRunning(false);
    }
  };

  // 生图模型测试：核对手写型号在端点是否存在（不实际生图，避免耗时与配额消耗）
  const [testImagegenRunning, setTestImagegenRunning] = useState(false);
  const [testImagegenMsg, setTestImagegenMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handleTestImagegen = async () => {
    setTestImagegenRunning(true);
    setTestImagegenMsg(null);
    try {
      const r = await api.testImagegen({
        api_base: settings.sensenova_api_base || "",
        api_key: settings.sensenova_api_key || "",
        model: settings.sensenova_model || "",
      });
      setTestImagegenMsg({ ok: r.ok, text: r.message });
    } catch (e: any) {
      setTestImagegenMsg({ ok: false, text: e?.message || "测试请求失败" });
    } finally {
      setTestImagegenRunning(false);
    }
  };

  const handleClose = () => {
    // 取消时恢复原始主题外观和亮度（因为点击/拖动已即时生效）
    onAppearanceChange?.(initial.theme || "light", initial.accent || "indigo");
    onBrightnessChange?.(initial.browser_brightness ?? 1.0);
    onClose();
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.saveSettings(settings);
      // 后端 persist 失败时返回 ok:false（内存已回滚），必须拦截，否则"保存好了但重启丢失"
      if (!r.ok) {
        throw new Error(r.error || "保存失败（设置未写入磁盘）");
      }
      onSaved(settings);
      onClose();
    } catch (e: any) {
      const msg = e.message || "保存失败";
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        setError("无法连接后端服务，请确认程序已完全启动（等待启动动画结束），或检查是否有代理/VPN 拦截 localhost");
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2 text-slate-800">
            <Settings2 className="h-4 w-4 text-brand-600" />
            <h2 className="text-sm font-semibold">设置</h2>
          </div>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body：可滚动 */}
        <div className="settings-scroll flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {/* AI API：左=识图/排版（原有视图），右=全局分析；模型均为「识别端点可用选项」后下拉选择 */}
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-700">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                AI API（识图：护照 OCR / 视觉比对 / 控制浏览器）
              </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[10px] font-medium text-slate-500">API Base URL</label>
                <input
                  type="text"
                  value={settings.vision_api_base}
                  onChange={(e) => update({ vision_api_base: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                  placeholder="https://token.sensenova.cn/v1"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-slate-500">API Key</label>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={settings.vision_api_key}
                    onChange={(e) => update({ vision_api_key: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-xs text-slate-700 outline-none focus:border-brand-400"
                    placeholder="sk-..."
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-slate-500">模型</label>
                <input
                  type="text"
                  value={settings.vision_model}
                  onChange={(e) => update({ vision_model: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                  placeholder="sensenova-6.7-flash-lite"
                />
                <p className="mt-1 text-[10px] text-slate-400">必须支持 image_url 输入；填好后点下方「检测」验证该模型。</p>
              </div>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {testing ? "检测中…" : "检测该模型是否支持图片"}
              </button>
              {testResult && (
                <div
                  className={[
                    "rounded-lg px-3 py-2 text-xs",
                    testResult.ok
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-rose-50 text-rose-700",
                  ].join(" ")}
                >
                  {testResult.ok
                    ? "✓ 该模型支持图片输入，OCR / 视觉比对可用。"
                    : `✗ ${testResult.message || "该模型不支持图片输入，OCR / 视觉比对将不可用。"}`}
                </div>
              )}
              {/* AI 自动转正 / VIZ 看图兜底均已并入下方「文件识别档位」5档调节杆 */}
              {/* 文本 AI：识图之外的纯文字任务（UMI-OCR 结果排版 / LOOP 执行总结）用轻量文本模型 */}
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                <div className="text-xs font-medium text-slate-700">文本 AI（OCR 文字排版 / 执行总结）</div>
                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                  识图走上方模型；纯文字任务（UMI-OCR 识别结果的字段排版、左上角执行总结）交给这里的轻量文本模型，更快更省。
                  地址和密钥留空时自动沿用上方 AI API（同一把 Key 只换模型名的场景直接可用）。
                </p>
                <div className="mt-2">
                  <label className="mb-1 block text-[10px] font-medium text-slate-500">文本模型</label>
                  <input
                    type="text"
                    value={settings.text_model || ""}
                    onChange={(e) => update({ text_model: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                    placeholder="deepseek-v4-flash（留空用识图模型）"
                  />
                </div>
                <details className="mt-2 group">
                  <summary className="cursor-pointer select-none text-[10px] font-medium text-slate-400 hover:text-slate-600">
                    使用不同的地址 / 密钥（默认同上方 AI API）
                  </summary>
                  <div className="mt-2 space-y-2">
                    <input
                      type="text"
                      value={settings.text_api_base || ""}
                      onChange={(e) => update({ text_api_base: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                      placeholder="API Base URL（留空同上方）"
                    />
                    <input
                      type={showKey ? "text" : "password"}
                      value={settings.text_api_key || ""}
                      onChange={(e) => update({ text_api_key: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                      placeholder="API Key（留空同上方）"
                    />
                  </div>
                </details>
              </div>
            </div>
          </div>

          {/* 右列：全局分析 AI + PPT 配图纵向排列，填满与左侧识图卡片的高度差 */}
          <div className="space-y-3">
            {/* 全局分析 AI：LOOP 运行中逐卡实时分析 + 结束总结，独立 Key 与识图流量分开 */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-700">
                <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                全局分析 AI（LOOP 执行分析 / 单卡即时分析）
              </div>
              <p className="mb-3 text-[10px] leading-relaxed text-slate-400">
                LOOP 运行中对问题卡片的实时分析和结束总结走这里的模型。全部留空时自动沿用左侧识图 / 文本配置；
                填入独立 Key 可与识图流量分开，避免运行中逐卡分析互相限流。
              </p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-slate-500">API Base URL</label>
                  <input
                    type="text"
                    value={settings.analysis_api_base || ""}
                    onChange={(e) => update({ analysis_api_base: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                    placeholder="留空同左侧"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-slate-500">API Key</label>
                  <div className="relative">
                    <input
                      type={showKey ? "text" : "password"}
                      value={settings.analysis_api_key || ""}
                      onChange={(e) => update({ analysis_api_key: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-xs text-slate-700 outline-none focus:border-brand-400"
                      placeholder="留空同左侧"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-slate-500">模型</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={settings.analysis_model || ""}
                      onChange={(e) => update({ analysis_model: e.target.value })}
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                      placeholder="deepseek-v4-flash（留空继承左侧）"
                    />
                    <button
                      type="button"
                      onClick={handleTestAnalysis}
                      disabled={testAnalysisRunning}
                      title="按当前填写的地址/密钥/模型发一次极小请求验证可用性"
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                    >
                      {testAnalysisRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      测试
                    </button>
                  </div>
                  {testAnalysisMsg && (
                    <p className={`mt-1 text-[10px] ${testAnalysisMsg.ok ? "text-emerald-600" : "text-rose-500"}`}>{testAnalysisMsg.text}</p>
                  )}
                  <p className="mt-1 text-[10px] text-slate-400">纯文字分析任务，轻量文本模型即可，无需识图能力。</p>
                </div>
              </div>
            </div>

            {/* PPT 配图：生图端点 URL/Key/模型均可配置（默认商汤 U1 Fast），识别按钮拉取可用生图模型 */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
                <Palette className="h-3.5 w-3.5 text-violet-600" />
                PPT 配图（商汤日日新 U1 Fast 生图）
              </div>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-slate-500">API Base URL</label>
                  <input
                    type="text"
                    value={settings.sensenova_api_base || ""}
                    onChange={(e) => update({ sensenova_api_base: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                    placeholder="https://token.sensenova.cn/v1"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-slate-500">API Key</label>
                  <div className="relative">
                    <input
                      type={showKey ? "text" : "password"}
                      value={settings.sensenova_api_key || ""}
                      onChange={(e) => update({ sensenova_api_key: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-xs text-slate-700 outline-none focus:border-brand-400"
                      placeholder="sk-..."
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-slate-500">生图模型</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={settings.sensenova_model || ""}
                      onChange={(e) => update({ sensenova_model: e.target.value })}
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                      placeholder="sensenova-u1-fast"
                    />
                    <button
                      type="button"
                      onClick={handleTestImagegen}
                      disabled={testImagegenRunning}
                      title="核对手写型号在该端点是否存在（不实际生图）"
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                    >
                      {testImagegenRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      测试
                    </button>
                  </div>
                  {testImagegenMsg && (
                    <p className={`mt-1 text-[10px] ${testImagegenMsg.ok ? "text-emerald-600" : "text-rose-500"}`}>{testImagegenMsg.text}</p>
                  )}
                  <p className="mt-1 text-[10px] text-slate-400">
                    Key 留空则生成纯文字 PPT；填入后制作 PPT 时会自动为每页生成信息图配图。
                  </p>
                </div>
              </div>
            </div>
          </div>
          </div>

          {/* 文件识别档位：准确⇄速度 5档调节杆（引擎 × VIZ兜底 × 自动转正 × 高速模式 一杆定档） */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            {/* 两端语义标签：紧贴轨道最左/最右端（与轨道同宽对齐） */}
            <div className="mb-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600">
                <Target className="h-3 w-3" />准确
              </span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-500">
                速度<Zap className="h-3 w-3" />
              </span>
            </div>

            {/* 轨道 + 滑块 + 5 个透明点击区（点轨道任意处即可换档） */}
            <div className="relative pt-1 pb-0.5">
              <div className="relative h-2.5 rounded-full bg-gradient-to-r from-emerald-400 via-teal-200 to-amber-400 shadow-inner">
                {/* 档位分隔刻度（等分 5 段的 4 条内刻线） */}
                {[20, 40, 60, 80].map((p) => (
                  <span key={p} className="absolute top-1/2 h-1.5 w-px -translate-y-1/2 bg-white/70" style={{ left: `${p}%` }} />
                ))}
              </div>
              {/* 滑块：当前档中心，白圈+主题色描边+光晕 */}
              <div
                className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-200"
                style={{ left: `${recogGearPos * 20 + 10}%` }}
              >
                <span className="block h-5 w-5 rounded-full border-[3px] border-white bg-slate-700 shadow-[0_1px_6px_rgba(15,23,42,0.35)] ring-1 ring-slate-300" />
              </div>
              <div className="absolute inset-0 grid grid-cols-5">
                {RECOG_GEARS.map((g, i) => (
                  <button
                    key={g.title}
                    type="button"
                    onClick={() => update({ ...g.patch })}
                    aria-label={`第${i + 1}档：${g.title.replace("\n", "")}`}
                    title={`第${i + 1}档：${g.title.replace("\n", "")}`}
                    className="cursor-pointer"
                  />
                ))}
              </div>
            </div>

            {/* 5 档标签（紧贴轨道下方，左缘与轨道最左端对齐、右缘与最右端对齐） */}
            <div className="mt-2 grid grid-cols-5 gap-1">
              {RECOG_GEARS.map((g, i) => (
                <button
                  key={g.title}
                  type="button"
                  onClick={() => update({ ...g.patch })}
                  className={[
                    "whitespace-pre-line rounded-lg px-0.5 py-1.5 text-center text-[9px] leading-tight transition-all",
                    i === recogGearPos
                      ? "bg-slate-700 font-semibold text-white shadow-md ring-1 ring-slate-500/40"
                      : "bg-white/70 font-medium text-slate-500 ring-1 ring-slate-200/70 hover:bg-white hover:text-slate-700",
                  ].join(" ")}
                >
                  {g.title}
                </button>
              ))}
            </div>

            {/* 当前档说明：档位小徽标 + 描述文字 */}
            <div className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-white/70 px-2 py-1.5 ring-1 ring-slate-200/70">
              <span className="mt-px shrink-0 rounded bg-slate-700 px-1 py-0.5 text-[9px] font-bold text-white">
                {recogGearPos + 1}档
              </span>
              <p className="text-[10px] leading-relaxed text-slate-500">{RECOG_GEARS[recogGearPos].desc}</p>
            </div>
          </div>

          {/* 防误关：挂后台到系统托盘 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              {settings.prevent_accidental_close ? (
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <ShieldX className="h-3.5 w-3.5 text-slate-400" />
              )}
              防误关保护
            </div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={!!settings.prevent_accidental_close}
                onClick={() => update({ prevent_accidental_close: !settings.prevent_accidental_close })}
                className={[
                  "relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  settings.prevent_accidental_close ? "bg-emerald-500" : "bg-slate-300",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                    settings.prevent_accidental_close ? "translate-x-[18px]" : "translate-x-0.5",
                  ].join(" ")}
                />
              </button>
              <div className="text-xs text-slate-500">
                <div className="font-medium text-slate-700">
                  {settings.prevent_accidental_close ? "已开启" : "已关闭"}
                </div>
                <p className="mt-0.5 leading-relaxed">
                  开启后，点窗口关闭按钮不会真正退出，而是最小化到系统托盘后台运行。
                  点击托盘图标可恢复窗口，右键托盘选「退出 CINSIDE」可真正退出。
                </p>
              </div>
            </label>
          </div>

          {/* LOOP 运行时不息屏 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              {settings.loop_keep_awake ? (
                <MonitorCheck className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <MonitorOff className="h-3.5 w-3.5 text-slate-400" />
              )}
              LOOP 运行不息屏
            </div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={!!settings.loop_keep_awake}
                onClick={() => update({ loop_keep_awake: !settings.loop_keep_awake })}
                className={[
                  "relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  settings.loop_keep_awake ? "bg-emerald-500" : "bg-slate-300",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                    settings.loop_keep_awake ? "translate-x-[18px]" : "translate-x-0.5",
                  ].join(" ")}
                />
              </button>
              <div className="text-xs text-slate-500">
                <div className="font-medium text-slate-700">
                  {settings.loop_keep_awake ? "已开启" : "已关闭"}
                </div>
                <p className="mt-0.5 leading-relaxed">
                  开启后，运行 LOOP 任务期间电脑不会息屏或休眠，任务结束后自动恢复系统默认的息屏策略。适合长时间批量执行时离开电脑。
                </p>
              </div>
            </label>
          </div>

          {/* 高速模式已并入上方「文件识别档位」第4档（OCR+无转正·高速） */}

          {/* 高手模式 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Zap className={`h-3.5 w-3.5 ${settings.expert_mode === true ? "text-amber-500" : "text-slate-400"}`} />
              高手模式
            </div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={settings.expert_mode === true}
                onClick={() => update({ expert_mode: settings.expert_mode !== true })}
                className={[
                  "relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  settings.expert_mode === true ? "bg-amber-500" : "bg-slate-300",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                    settings.expert_mode === true ? "translate-x-[18px]" : "translate-x-0.5",
                  ].join(" ")}
                />
              </button>
              <div className="text-xs text-slate-500">
                <div className="font-medium text-slate-700">
                  {settings.expert_mode === true ? "已开启" : "已关闭（默认模式）"}
                </div>
                <p className="mt-0.5 leading-relaxed">
                  开启后，步骤设置的功能按钮（绑定输入框、前置/过程/收尾点击、录入/审查步骤、文件提取、自定义文本、控件提取）集中到顶部工具栏并标注快捷键，适合熟练使用快捷键操作；关闭为默认模式，按钮显示在字段对比面板各分组标题行内。默认关闭。
                </p>
              </div>
            </label>
          </div>

        {/* 模拟网页 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Globe className="h-3.5 w-3.5 text-brand-600" />
              模拟网页
            </div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={settings.demo_site_enabled === true}
                onClick={() => update({ demo_site_enabled: settings.demo_site_enabled !== true })}
                className={[
                  "relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  settings.demo_site_enabled === true ? "bg-brand-500" : "bg-slate-300",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                    settings.demo_site_enabled === true ? "translate-x-[18px]" : "translate-x-0.5",
                  ].join(" ")}
                />
              </button>
              <div className="text-xs text-slate-500">
                <div className="font-medium text-slate-700">
                  {settings.demo_site_enabled === true ? "已开启" : "已关闭"}
                </div>
                <p className="mt-0.5 leading-relaxed">
                  开启后右侧网页默认载入内置的模拟学校系统（DEMO 演示站点），并显示「审查DEMO / 录入DEMO」快捷入口，适合演示和练习；关闭后右侧为空白，需自行输入真实的学校系统网址。默认关闭。
                </p>
              </div>
            </label>
          </div>

          {/* 主题外观：明暗 + 主色调 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Palette className="h-3.5 w-3.5 text-brand-600" />
              主题外观
            </div>
            <div className="space-y-3">
              {/* 明暗切换 */}
              <div>
                <label className="mb-1.5 block text-[10px] font-medium text-slate-500">明暗主题</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => update({ theme: "light" })}
                    className={[
                      "flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors",
                      settings.theme !== "dark"
                        ? "border-brand-400 bg-brand-50 text-brand-700 ring-1 ring-brand-300"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <Sun className="h-3.5 w-3.5" />
                    浅色
                  </button>
                  <button
                    type="button"
                    onClick={() => update({ theme: "dark" })}
                    className={[
                      "flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors",
                      settings.theme === "dark"
                        ? "border-brand-400 bg-brand-50 text-brand-700 ring-1 ring-brand-300"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <Moon className="h-3.5 w-3.5" />
                    深色
                  </button>
                </div>
              </div>
              {/* 主色调 */}
              <div>
                <label className="mb-1.5 block text-[10px] font-medium text-slate-500">主色调</label>
                <div className="flex flex-wrap gap-2">
                  {ACCENTS.map((a) => {
                    const active = settings.accent === a.key;
                    return (
                      <button
                        key={a.key}
                        type="button"
                        title={a.label}
                        onClick={() => update({ accent: a.key })}
                        className={[
                          "group flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-all",
                          active
                            ? "border-transparent"
                            : "border-transparent text-slate-500 hover:bg-slate-100",
                        ].join(" ")}
                        style={active ? {
                          backgroundColor: `${a.color}1f`,
                          color: a.color,
                        } : undefined}
                      >
                        <span
                          className="h-3.5 w-3.5 rounded-full transition-transform"
                          style={{
                            backgroundColor: a.color,
                            boxShadow: active ? `0 0 0 2px ${a.color}55` : undefined,
                            transform: active ? "scale(1.1)" : undefined,
                          }}
                        />
                        <span className={active ? "" : "group-hover:text-slate-700"}>{a.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* UI 缩放 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Maximize2 className="h-3.5 w-3.5 text-brand-600" />
              界面缩放
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.max(0.6, Math.round(((settings.ui_scale || 1.0) - 0.05) * 20) / 20);
                    update({ ui_scale: next });
                    onScaleChange?.(next);
                    try { localStorage.setItem("cinside-ui-scale", next.toString()); } catch {}
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  disabled={(settings.ui_scale || 1.0) <= 0.6}
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <div className="flex-1">
                  <input
                    type="range"
                    min="0.6"
                    max="1.6"
                    step="0.05"
                    value={settings.ui_scale || 1.0}
                    onChange={(e) => {
                      const next = parseFloat(e.target.value);
                      setSettings((s) => ({ ...s, ui_scale: next }));
                      onScaleChange?.(next);
                      try { localStorage.setItem("cinside-ui-scale", next.toString()); } catch {}
                    }}
                    className="w-full accent-brand-600"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.min(1.6, Math.round(((settings.ui_scale || 1.0) + 0.05) * 20) / 20);
                    update({ ui_scale: next });
                    onScaleChange?.(next);
                    try { localStorage.setItem("cinside-ui-scale", next.toString()); } catch {}
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  disabled={(settings.ui_scale || 1.0) >= 1.6}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <span className="w-12 text-right text-sm font-semibold tabular-nums text-slate-700">
                  {Math.round((settings.ui_scale || 1.0) * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => {
                    update({ ui_scale: 1.0 });
                    onScaleChange?.(1.0);
                    try { localStorage.setItem("cinside-ui-scale", "1.0"); } catch {}
                  }}
                  className="flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                  title="重置为100%"
                >
                  <RotateCcw className="h-3 w-3" />
                  重置
                </button>
              </div>
              <p className="text-[10px] text-slate-400">
                提示：也可以按住 <kbd className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[9px]">Ctrl</kbd> + 鼠标滚轮 快速调整整体界面大小（不影响网页内部缩放）
              </p>
            </div>
          </div>

          {/* 网页亮度 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Sun className="h-3.5 w-3.5 text-brand-600" />
              网页亮度
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.max(0.3, Math.round(((settings.browser_brightness ?? 1.0) - 0.05) * 20) / 20);
                    update({ browser_brightness: next });
                    onBrightnessChange?.(next);
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  disabled={(settings.browser_brightness ?? 1.0) <= 0.3}
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <div className="flex-1">
                  <input
                    type="range"
                    min="0.3"
                    max="2.0"
                    step="0.05"
                    value={settings.browser_brightness ?? 1.0}
                    onChange={(e) => {
                      const next = parseFloat(e.target.value);
                      setSettings((s) => ({ ...s, browser_brightness: next }));
                      onBrightnessChange?.(next);
                    }}
                    className="w-full accent-brand-600"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.min(2.0, Math.round(((settings.browser_brightness ?? 1.0) + 0.05) * 20) / 20);
                    update({ browser_brightness: next });
                    onBrightnessChange?.(next);
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  disabled={(settings.browser_brightness ?? 1.0) >= 2.0}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <span className="w-12 text-right text-sm font-semibold tabular-nums text-slate-700">
                  {Math.round((settings.browser_brightness ?? 1.0) * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => {
                    update({ browser_brightness: 1.0 });
                    onBrightnessChange?.(1.0);
                  }}
                  className="flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                  title="重置为100%"
                >
                  <RotateCcw className="h-3 w-3" />
                  重置
                </button>
              </div>
              <p className="text-[10px] text-slate-400">
                调整 BrowserPane 内嵌网页的亮度（30%~200%），暗色主题下可降低网页亮度减轻刺眼感
              </p>
            </div>
          </div>

          {/* 依赖与工具：Python 包 + UMI-OCR */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <Package className="h-3.5 w-3.5 text-brand-600" />
                依赖与外部工具
              </div>
              <button
                type="button"
                onClick={refreshDepsStatus}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                title="刷新状态"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                刷新
              </button>
            </div>

            {/* Python 依赖 */}
            <div className="mb-3 rounded-lg border border-slate-200 bg-white p-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-slate-600">Python 文档解析依赖</span>
                {depsStatus ? (
                  depsStatus.python_all_installed ? (
                    <span className="flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      全部就绪
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
                      <XCircle className="h-2.5 w-2.5" />
                      有缺失
                    </span>
                  )
                ) : (
                  <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
                )}
              </div>
              {depsStatus?.python_deps.map((dep) => (
                <div key={dep.key} className="flex items-center gap-1.5 py-0.5 text-[10px]">
                  {dep.installed ? (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="h-3 w-3 shrink-0 text-rose-400" />
                  )}
                  <span className={dep.installed ? "text-slate-500" : "text-rose-600 font-medium"}>
                    {dep.name}
                  </span>
                </div>
              ))}
              {!depsStatus?.python_all_installed && (
                <>
                  <button
                    type="button"
                    onClick={handleInstallPythonDeps}
                    disabled={pipInstalling}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {pipInstalling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    {pipInstalling ? "安装中（可能需要1-2分钟）…" : "一键安装缺失依赖"}
                  </button>
                  {pipMessage && (
                    <div className={`mt-1.5 whitespace-pre-line rounded px-2 py-1 text-[10px] ${pipMessage.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                      {pipMessage.message}
                    </div>
                  )}
                </>
              )}
              {pipMessage && depsStatus?.python_all_installed && (
                <div className={`mt-1.5 whitespace-pre-line rounded px-2 py-1 text-[10px] ${pipMessage.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                  {pipMessage.message}
                </div>
              )}
            </div>

            {/* UMI-OCR */}
            <div className="rounded-lg border border-slate-200 bg-white p-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-slate-600">UMI-OCR（本地离线 OCR）</span>
                {depsStatus ? (
                  depsStatus.umi_ocr.installed ? (
                    <span className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium ${depsStatus.umi_ocr.service_online ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      {depsStatus.umi_ocr.service_online ? "服务在线" : "已安装"}
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                      <XCircle className="h-2.5 w-2.5" />
                      未安装
                    </span>
                  )
                ) : (
                  <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
                )}
              </div>
              {depsStatus?.umi_ocr.path && (
                <div className="mb-1.5 flex items-center gap-1">
                  <p className="min-w-0 flex-1 truncate text-[9px] text-slate-400" title={depsStatus.umi_ocr.path}>
                    📁 {depsStatus.umi_ocr.path}
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenUmiFolder}
                    className="flex shrink-0 items-center gap-0.5 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[9px] font-medium text-slate-600 transition-colors hover:bg-slate-100"
                    title="打开 UMI-OCR 所在文件夹，可手动双击 Umi-OCR.exe 启动"
                  >
                    <FolderOpen className="h-2.5 w-2.5" />
                    打开所在文件夹
                  </button>
                </div>
              )}
              {umiOpenMsg && (
                <p className="mb-1.5 whitespace-pre-line text-[9px] text-slate-500">{umiOpenMsg}</p>
              )}
              <p className="mb-2 text-[9px] leading-relaxed text-slate-400">
                UMI-OCR 是免费开源的离线 OCR 软件（基于 PaddleOCR），无需 API Key 即可识别图片文字。
                下载安装后需在软件内开启「HTTP 接口服务」（默认端口 1224）。
              </p>
              {umiDownloading && umiProgress ? (
                <div className="w-full space-y-1.5">
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin text-brand-500" />
                      {umiProgress.stage === "fetching" && "正在获取版本信息…"}
                      {umiProgress.stage === "downloading" && (umiProgress.mirror ? `通过 ${umiProgress.mirror} 下载中` : "下载中…")}
                      {umiProgress.stage === "extracting" && "正在解压安装…"}
                    </span>
                    {umiProgress.totalMB > 0 && (
                      <span className="tabular-nums text-slate-400">
                        {umiProgress.downloadedMB} / {umiProgress.totalMB} MB
                      </span>
                    )}
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ease-out ${
                        umiProgress.stage === "extracting"
                          ? "animate-pulse bg-amber-400"
                          : "bg-brand-500"
                      }`}
                      style={{ width: `${Math.max(2, umiProgress.percent)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[9px] text-slate-400">
                    <span className="truncate pr-2">{umiProgress.message}</span>
                    <span className="shrink-0 tabular-nums font-medium text-brand-500">
                      {umiProgress.percent}%
                    </span>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleDownloadUmiOcr}
                  disabled={umiDownloading}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {umiDownloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  {umiDownloading ? "下载安装中…" : depsStatus?.umi_ocr.installed ? "重新下载安装 UMI-OCR" : "一键下载安装 UMI-OCR"}
                </button>
              )}
              {umiDownloadMsg && !umiDownloading && (
                <div className={`mt-1.5 whitespace-pre-line rounded px-2 py-1 text-[10px] ${umiDownloadMsg.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                  {umiDownloadMsg.message}
                </div>
              )}
              <p className="mt-1.5 text-[9px] text-slate-400">
                💡 如果 GitHub 下载慢，可手动从
                <a
                  href="https://hiroi-sora.lanzoul.com/s/umi-ocr"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mx-0.5 text-brand-500 underline hover:text-brand-600"
                >
                  蓝奏云镜像
                </a>
                下载解压后，在文件处理设置中选择 Umi-OCR.exe。
              </p>
            </div>

            {/* 核显加速：硬件检测 + 偏好开关 */}
            <div className="rounded-lg border border-slate-200 bg-white p-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-600">
                  <Cpu className="h-3 w-3" />
                  核显加速（硬件检测）
                </span>
                <button
                  type="button"
                  onClick={() => detectGpuInfo(true)}
                  disabled={gpuDetecting}
                  className="flex shrink-0 items-center gap-0.5 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[9px] font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-60"
                  title="重新查询本机显卡与 CPU 信息"
                >
                  {gpuDetecting ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RefreshCw className="h-2.5 w-2.5" />}
                  重新检测
                </button>
              </div>

              {/* 检测结果 */}
              {gpuDetecting && !gpuInfo ? (
                <p className="mb-1.5 flex items-center gap-1 text-[9px] text-slate-400">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" /> 正在检测显卡…
                </p>
              ) : gpuInfo?.ok ? (
                <div className="mb-1.5 space-y-1">
                  {(gpuInfo.gpus || []).map((g) => (
                    <div
                      key={g.name}
                      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium ${
                        g.integrated ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-700"
                      }`}
                      title={`${g.name}${g.driver_version ? `（驱动 ${g.driver_version}）` : ""}`}
                    >
                      <span className="shrink-0">{g.integrated ? "核显" : "独显"}</span>
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      {g.status === "OK" && <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />}
                    </div>
                  ))}
                  {(!gpuInfo.gpus || gpuInfo.gpus.length === 0) && (
                    <p className="text-[9px] text-slate-400">未发现显卡设备</p>
                  )}
                  {gpuInfo.cpu?.name && (
                    <p className="truncate text-[9px] text-slate-400" title={gpuInfo.cpu.name}>
                      🖥 {gpuInfo.cpu.name}（{gpuInfo.cpu.physical_cores}核{gpuInfo.cpu.logical_cores}线程）
                    </p>
                  )}
                </div>
              ) : (
                <p className="mb-1.5 text-[9px] text-rose-500">{gpuInfo?.error || "未检测到显卡信息"}</p>
              )}

              {/* 偏好开关 */}
              <label className="flex cursor-pointer items-start gap-2.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!settings.igpu_acceleration}
                  onClick={() => update({ igpu_acceleration: !settings.igpu_acceleration })}
                  className={[
                    "relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                    settings.igpu_acceleration ? "bg-emerald-500" : "bg-slate-300",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                      settings.igpu_acceleration ? "translate-x-[18px]" : "translate-x-0.5",
                    ].join(" ")}
                  />
                </button>
                <div className="text-[10px] leading-relaxed text-slate-500">
                  <div className="font-medium text-slate-700">
                    {settings.igpu_acceleration
                      ? gpuInfo?.local_engine?.backend === "directml"
                        ? `内置引擎已就绪（DirectML${gpuInfo.local_engine.gpu_name ? ` · ${gpuInfo.local_engine.gpu_name}` : ""}）`
                        : gpuInfo?.local_engine?.backend === "openvino"
                          ? "内置引擎已就绪（OpenVINO）"
                          : gpuInfo?.local_engine?.backend === "cpu"
                            ? "内置引擎已就绪（CPU）"
                            : "内置引擎初始化中"
                      : "已关闭（纯 UMI-OCR）"}
                  </div>
                  <p className="mt-0.5">
                    引擎切换：开启 = 所有 OCR 走内置 PP-OCRv6 引擎（单张 ~0.3-1s，不依赖 UMI 开机，失败自动回退
                    UMI）；关闭 = 纯 UMI-OCR（真实证件上识别量比内置引擎多 ~40%，精度更高）。内置引擎自动适配最快推理后端：显卡
                    DirectML（Intel / AMD / NVIDIA 通用）→ OpenVINO CPU（对 Intel CPU 指令级优化）→
                    onnxruntime CPU 兜底。首次启用逐档自检：输出乱码或反而更慢就自动落下一档。
                  </p>
                  {gpuInfo?.local_engine?.detail && settings.igpu_acceleration && (
                    <p className="mt-0.5 text-emerald-600">{gpuInfo.local_engine.detail}</p>
                  )}
                </div>
              </label>

              {/* 加速引擎组件（别人电脑没装时一键下载） */}
              {depsStatus && !depsStatus.ocr_engine_all_installed && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <div className="mb-1 flex items-center gap-0.5 text-[9px] font-medium text-amber-600">
                    <Download className="h-2.5 w-2.5" />
                    加速引擎组件未安装（约 200MB，不装则走 UMI-OCR）
                  </div>
                  {depsStatus.ocr_engine_deps.map((dep) => (
                    <div key={dep.key} className="flex items-center gap-1.5 py-0.5 text-[9px]">
                      {dep.installed ? (
                        <CheckCircle2 className="h-2.5 w-2.5 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircle className="h-2.5 w-2.5 shrink-0 text-rose-400" />
                      )}
                      <span className={dep.installed ? "text-slate-400" : "font-medium text-rose-600"}>{dep.name}</span>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={handleInstallOcrEngine}
                    disabled={ocrInstalling}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {ocrInstalling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    {ocrInstalling ? "下载安装中（数分钟）…" : "一键下载加速引擎"}
                  </button>
                </div>
              )}
              {ocrInstallMsg && (
                <div className={`mt-1.5 whitespace-pre-line rounded px-2 py-1 text-[10px] ${ocrInstallMsg.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                  {ocrInstallMsg.message}
                </div>
              )}
            </div>
          </div>

          {/* Remotion 视频渲染引擎 —— 最下方 */}
          <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <Film className="h-3.5 w-3.5 text-brand-600" />
                Remotion（PPT 转视频渲染引擎）
              </div>
              {depsStatus ? (
                depsStatus.remotion.installed ? (
                  <span className="flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
                    <CheckCircle2 className="h-2.5 w-2.5" />
                    已安装{depsStatus.remotion.version ? ` v${depsStatus.remotion.version}` : ""}
                  </span>
                ) : (
                  <span className="flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                    <XCircle className="h-2.5 w-2.5" />
                    未安装
                  </span>
                )
              ) : (
                <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
              )}
            </div>
            {depsStatus?.remotion.path && (
              <p className="mb-2 truncate text-[9px] text-slate-400" title={depsStatus.remotion.path}>
                📁 {depsStatus.remotion.path}
              </p>
            )}
            <p className="mb-3 text-[9px] leading-relaxed text-slate-400">
              Remotion 是基于 React 的可编程视频渲染框架，用于将 PPT 自动合成为视频。
              首次使用需通过 npm 下载安装（需要 Node.js 环境，约 100-200MB）。
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleInstallRemotion}
                disabled={remotionInstalling}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {remotionInstalling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                {remotionInstalling
                  ? "安装中…"
                  : depsStatus?.remotion.installed
                    ? "重新下载安装 Remotion"
                    : "一键下载 Remotion"}
              </button>
              <button
                type="button"
                onClick={refreshDepsStatus}
                disabled={remotionInstalling}
                className="flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                title="检查 Remotion 是否已安装"
              >
                <ShieldCheck className="h-3 w-3" />
                检查
              </button>
            </div>
            {remotionMsg && (
              <div className={`mt-2 whitespace-pre-line rounded px-2 py-1 text-[10px] ${remotionMsg.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                {remotionMsg.message}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
          )}
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            onClick={handleClose}
            className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
