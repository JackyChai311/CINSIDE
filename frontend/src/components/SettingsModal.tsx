import { useEffect, useState } from "react";
import { CheckCircle2, Compass, Download, Eye, EyeOff, Film, Loader2, Maximize2, Minus, Moon, Package, Palette, Plus, RefreshCw, RotateCcw, Save, Settings2, ShieldCheck, ShieldX, Sun, X, XCircle } from "lucide-react";
import { api } from "../api/client";
import type { AppSettings, DepsStatus } from "../types";

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
  browser_use_llm_base: "https://token.sensenova.cn/v1",
  browser_use_llm_key: "",
  browser_use_llm_model: "sensenova-6.7-flash-lite",
  prevent_accidental_close: false,
  ui_scale: 1.0,
  beginner_mode: false,
  theme: "light",
  accent: "indigo",
  browser_brightness: 1.0,
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
  const [umiDownloading, setUmiDownloading] = useState(false);
  const [umiDownloadMsg, setUmiDownloadMsg] = useState<{ ok: boolean; message: string } | null>(null);
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
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
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
          {/* AI API 单一配置 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              AI API（护照 OCR / 视觉比对 / 控制浏览器）
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
                <p className="mt-1 text-[10px] text-slate-400">必须支持 image_url 输入，否则 OCR/视觉任务不可用。</p>
                {/* 常用模型快捷切换：方便证件/OCR 场景避开内容审核 */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {[
                    { tag: "免费", m: "sensenova-6.7-flash-lite", warn: "证件/人脸会被内容审核拦截" },
                    { tag: "推荐", m: "glm-4v-plus", warn: "智谱 GLM-4V，对证件照较宽松" },
                    { tag: "推荐", m: "glm-4v-flash", warn: "智谱 GLM-4V Flash 免费版" },
                    { tag: "备选", m: "qwen-vl-max", warn: "通义千问 VL" },
                    { tag: "备选", m: "qwen-vl-plus", warn: "通义千问 VL Plus" },
                  ].map(({ tag, m, warn }) => (
                    <button
                      key={m}
                      type="button"
                      title={warn}
                      onClick={() => update({ vision_model: m })}
                      className={[
                        "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                        settings.vision_model === m
                          ? tag === "免费"
                            ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300"
                            : "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300"
                          : "bg-slate-100 text-slate-500 hover:bg-slate-200",
                      ].join(" ")}
                    >
                      {m}
                      <span className={`ml-1 ${tag === "免费" ? "text-amber-500" : "text-emerald-500"}`}>{tag}</span>
                    </button>
                  ))}
                </div>
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
            </div>
          </div>

          {/* PPT 配图：SenseNova U1 Fast 生图 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Palette className="h-3.5 w-3.5 text-violet-600" />
              PPT 配图（商汤日日新 U1 Fast 生图）
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium text-slate-500">SenseNova API Key</label>
              <input
                type={showKey ? "text" : "password"}
                value={settings.sensenova_api_key || ""}
                onChange={(e) => update({ sensenova_api_key: e.target.value })}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                placeholder="sk-..."
              />
              <p className="mt-1 text-[10px] text-slate-400">
                留空则生成纯文字 PPT；填入后制作 PPT 时会自动为每页生成信息图配图。
              </p>
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

          {/* 进入新手村 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Compass className="h-3.5 w-3.5 text-brand-600" />
              进入新手村
            </div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={settings.beginner_mode !== false}
                onClick={() => update({ beginner_mode: settings.beginner_mode === false })}
                className={[
                  "relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  settings.beginner_mode !== false ? "bg-brand-500" : "bg-slate-300",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                    settings.beginner_mode !== false ? "translate-x-[18px]" : "translate-x-0.5",
                  ].join(" ")}
                />
              </button>
              <div className="text-xs text-slate-500">
                <div className="font-medium text-slate-700">
                  {settings.beginner_mode !== false ? "已开启" : "已关闭"}
                </div>
                <p className="mt-0.5 leading-relaxed">
                  开启时显示步骤仪表引导，按步骤逐步配置；关闭后直接使用字段对比面板，三个功能区常开无需切换，适合熟练用户。
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
                <p className="mb-1.5 truncate text-[9px] text-slate-400" title={depsStatus.umi_ocr.path}>
                  📁 {depsStatus.umi_ocr.path}
                </p>
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
