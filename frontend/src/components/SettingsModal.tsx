import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Maximize2, Minus, Plus, RotateCcw, Save, Settings2, ShieldCheck, ShieldX, X } from "lucide-react";
import { api } from "../api/client";
import type { AppSettings } from "../types";

interface Props {
  initial: AppSettings;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
  onScaleChange?: (scale: number) => void;
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
};

export default function SettingsModal({ initial, onClose, onSaved, onScaleChange }: Props) {
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULTS, ...initial });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings()
      .then((s) => setSettings((prev) => ({ ...prev, ...s })))
      .catch(() => {});
  }, []);

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
  };

  const handleTest = async () => {
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

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings(settings);
      onSaved(settings);
      onClose();
    } catch (e: any) {
      setError(e.message || "保存失败");
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
            onClick={onClose}
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
                      update({ ui_scale: next });
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

          {error && (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
          )}
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            onClick={onClose}
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
