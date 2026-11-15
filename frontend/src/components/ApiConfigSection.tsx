import { useState } from "react";
import { ChevronDown, Eye, EyeOff, Loader2, Palette, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../api/client";
import type { AppSettings } from "../types";

/**
 * 可折叠 API 卡片外壳：默认收起（只显示标题），点击展开/收起，节省面板纵向空间。
 * 用原生 <details>/<summary> 实现，展开状态由浏览器维护，无需额外 state。
 */
function ApiCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-slate-50/50">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-3 text-[11px] font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
        {icon}
        <span className="flex-1">{title}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}

interface ApiConfigSectionProps {
  settings: AppSettings;
  /** 任一字段变化时回调（父组件负责持久化保存） */
  onChange: (patch: Partial<AppSettings>) => void;
}

/**
 * AI 配置区（原 SETTINGS 的 API 部分，现移入 PERSONAL）：
 * 识图 AI / 文本 AI / 全局分析 AI / PPT 配图 四张卡片，单列堆叠。
 * 纯展示 + 输入，字段变更通过 onChange 上抛；三个「测试」按钮各自独立。
 */
export default function ApiConfigSection({ settings, onChange }: ApiConfigSectionProps) {
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 全局分析模型测试
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

  // 生图模型测试（不实际生图）
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

  // 识图模型测试：先本地校验 URL 协议，再存盘并验证是否支持图片输入
  const handleTest = async () => {
    const base = (settings.vision_api_base || "").trim();
    if (base && !base.startsWith("http://") && !base.startsWith("https://")) {
      setTestResult({ ok: false, message: `API Base URL 格式错误（应以 http:// 或 https:// 开头）：${base.slice(0, 60)}` });
      return;
    }
    setTesting(true);
    setTestResult(null);
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

  return (
    <div className="space-y-3">
      {/* 识图 AI */}
      <ApiCard
        title="AI API（识图：护照 OCR / 视觉比对 / 控制浏览器）"
        icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
      >
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-slate-500">API Base URL</label>
            <input
              type="text"
              value={settings.vision_api_base}
              onChange={(e) => { onChange({ vision_api_base: e.target.value }); setTestResult(null); }}
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
                onChange={(e) => { onChange({ vision_api_key: e.target.value }); setTestResult(null); }}
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
              onChange={(e) => { onChange({ vision_model: e.target.value }); setTestResult(null); }}
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
                testResult.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700",
              ].join(" ")}
            >
              {testResult.ok
                ? "✓ 该模型支持图片输入，OCR / 视觉比对可用。"
                : `✗ ${testResult.message || "该模型不支持图片输入，OCR / 视觉比对将不可用。"}`}
            </div>
          )}
        </div>
      </ApiCard>

      {/* 文本 AI */}
      <ApiCard
        title="文本 AI（OCR 文字排版 / 执行总结）"
        icon={<Sparkles className="h-3.5 w-3.5 text-sky-500" />}
      >
        <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
          识图走上方模型；纯文字任务（UMI-OCR 识别结果的字段排版、左上角执行总结）交给这里的轻量文本模型，更快更省。
          地址和密钥留空时自动沿用上方 AI API（同一把 Key 只换模型名的场景直接可用）。
        </p>
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-slate-500">文本模型</label>
            <input
              type="text"
              value={settings.text_model || ""}
              onChange={(e) => onChange({ text_model: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
              placeholder="deepseek-v4-flash（留空用识图模型）"
            />
          </div>
        </div>
        <details className="mt-2 group">
          <summary className="cursor-pointer select-none text-[10px] font-medium text-slate-400 hover:text-slate-600">
            使用不同的地址 / 密钥（默认同上方 AI API）
          </summary>
          <div className="mt-2 space-y-2">
            <input
              type="text"
              value={settings.text_api_base || ""}
              onChange={(e) => onChange({ text_api_base: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
              placeholder="API Base URL（留空同上方）"
            />
            <input
              type={showKey ? "text" : "password"}
              value={settings.text_api_key || ""}
              onChange={(e) => onChange({ text_api_key: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
              placeholder="API Key（留空同上方）"
            />
          </div>
        </details>
      </ApiCard>

      {/* 全局分析 AI */}
      <ApiCard
        title="全局分析 AI（LOOP 执行分析 / 单卡即时分析）"
        icon={<Sparkles className="h-3.5 w-3.5 text-indigo-500" />}
      >
        <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
          LOOP 运行中对问题卡片的实时分析和结束总结走这里的模型。全部留空时自动沿用识图 / 文本配置；
          填入独立 Key 可与识图流量分开，避免运行中逐卡分析互相限流。
        </p>
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-slate-500">API Base URL</label>
            <input
              type="text"
              value={settings.analysis_api_base || ""}
              onChange={(e) => onChange({ analysis_api_base: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
              placeholder="留空同识图"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-slate-500">API Key</label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={settings.analysis_api_key || ""}
                onChange={(e) => onChange({ analysis_api_key: e.target.value })}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-xs text-slate-700 outline-none focus:border-brand-400"
                placeholder="留空同识图"
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
                onChange={(e) => onChange({ analysis_model: e.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-brand-400"
                placeholder="deepseek-v4-flash（留空继承识图）"
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
      </ApiCard>

      {/* PPT 配图 */}
      <ApiCard
        title="PPT 配图（商汤日日新 U1 Fast 生图）"
        icon={<Palette className="h-3.5 w-3.5 text-violet-600" />}
      >
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-slate-500">API Base URL</label>
            <input
              type="text"
              value={settings.sensenova_api_base || ""}
              onChange={(e) => onChange({ sensenova_api_base: e.target.value })}
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
                onChange={(e) => onChange({ sensenova_api_key: e.target.value })}
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
                onChange={(e) => onChange({ sensenova_model: e.target.value })}
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
      </ApiCard>
    </div>
  );
}
