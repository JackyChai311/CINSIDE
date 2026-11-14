import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Crosshair,
  FileSpreadsheet,
  Globe,
  HelpCircle,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Table2,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import { api } from "../api/client";
import type { ViewSide } from "../electron";
import type {
  HarnessExcelSource,
  HarnessPage,
  HarnessPlan,
  HarnessPlanStep,
  HarnessQueueTask,
} from "../types";

/**
 * 草案步骤只有一句人话目标（没有 CSS 选择器），所以定位靠文字匹配：
 * 先取「」里的名字，没有就用整句；在网页里找名字最像、面积最小的可见元素，
 * 滚到视口中间并打上临时标记，再用 viewHighlightBoxes 按标记画框
 * （和「字段对比」卡片悬停时是同一套高亮）。
 */
function buildPlanProbeScript(target: string, token: string): string {
  return `(function () {
  var RAW = ${JSON.stringify(target || "")};
  var TOKEN = ${JSON.stringify(token)};
  function norm(s) { return String(s == null ? "" : s).replace(/\\s+/g, " ").trim().toLowerCase(); }
  var quoted = [];
  var re = /[「『“‘]([^」』”’]{1,40})[」』”’]/g, m;
  while ((m = re.exec(RAW))) quoted.push(m[1]);
  var words = (quoted.length ? quoted : [RAW.replace(/^(左侧|右侧|左边|右边|左|右)/, "")]).map(norm).filter(Boolean);
  if (!words.length) return { ok: false, reason: "empty" };
  var SEL = "a[href],button,input,select,textarea,summary,label,option,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=combobox],[role=textbox],[role=searchbox],th,td,li";
  var nodes = [];
  try { nodes = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { nodes = []; }
  var best = null, bestScore = 0, bestArea = 0;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!el || el.disabled) continue;
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    var t = norm(
      el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") ||
      (el.tagName === "INPUT" ? el.value : "") || el.innerText || el.textContent || ""
    );
    if (!t || t.length > 80) continue;
    var score = 0;
    for (var w = 0; w < words.length; w++) {
      var word = words[w];
      if (t === word) score = Math.max(score, 100);
      else if (t.indexOf(word) !== -1) score = Math.max(score, 82 - Math.min(40, t.length - word.length));
      else if (t.length >= 2 && word.indexOf(t) !== -1) score = Math.max(score, 45 - Math.min(25, word.length - t.length));
    }
    if (!score) continue;
    var area = rect.width * rect.height;
    if (score > bestScore || (score === bestScore && best && area < bestArea)) {
      best = el; bestScore = score; bestArea = area;
    }
  }
  if (!best) return { ok: false, reason: "not_found" };
  var olds = document.querySelectorAll("[data-cinside-plan-hit]");
  for (var k = 0; k < olds.length; k++) olds[k].removeAttribute("data-cinside-plan-hit");
  best.setAttribute("data-cinside-plan-hit", TOKEN);
  try { best.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch (e) {}
  return { ok: true, tag: best.tagName, text: norm(best.innerText || best.textContent || "").slice(0, 40) };
})()`;
}

/**
 * 清屏桌面上的「任务调度台」。
 *
 * 交互极简：按 / 或点胶囊 → 一个输入框 → 回车 → 变成一张卡片。
 * 卡片排队，HARNESS 串行执行（同一个浏览器视图不能并行遥控），
 * 状态由后端轮询同步，关掉窗口任务也不会丢（后端落盘）。
 */
export default function DeskTaskBoard({
  onDraftChange,
  autoSummon = 0,
  onDockChange,
  dockEl,
  favorites,
  demoPages,
  onOpenUrl,
}: {
  /** 草案打开时通知父级（用于暂时收起大时钟，把屏幕让给流程核对） */
  onDraftChange?: (open: boolean) => void;
  /** 每 +1 表示"从外部召唤一次输入框"（顶栏 HARNESS 按钮用） */
  autoSummon?: number;
  /** 草案下移去下栏（占「字段对比」那一栏）时通知父级：父级要亮出两个浏览器面板并腾出下栏 */
  onDockChange?: (
    docked: boolean,
    webSide: "left" | "right" | "none",
    backToDesk?: boolean
  ) => void;
  /** 父级在下栏里准备的容器；有它才能把草案 portal 下去 */
  dockEl?: HTMLElement | null;
  /** 两侧收藏站点：面板还停在空白页时，直接在草案里一键打开 */
  favorites?: Partial<Record<"left" | "right", { name: string; url: string }[]>>;
  /** 内置 DEMO 页地址（仅「模拟网页」开启时给） */
  demoPages?: { left: string; right: string } | null;
  /** 让某一侧的浏览器面板打开指定网址 */
  onOpenUrl?: (side: "left" | "right", url: string) => void;
}) {
  const [summoned, setSummoned] = useState(false);
  const [text, setText] = useState("");
  const [tasks, setTasks] = useState<HarnessQueueTask[]>([]);
  const [pages, setPages] = useState<HarnessPage[]>([]);
  const [excelSources, setExcelSources] = useState<HarnessExcelSource[]>([]);
  // 用户从磁盘临时挑的表格（后端清单里没有，自己补进下拉）
  const [pickedExcels, setPickedExcels] = useState<HarnessExcelSource[]>([]);
  const [webSide, setWebSide] = useState<"left" | "right" | "none">("left");
  const [excelPath, setExcelPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answering, setAnswering] = useState<Record<string, string>>({});

  // 流程草案：先给流程，用户核对/手改/让它改，确认后才变成待执行卡片
  const [draft, setDraft] = useState<HarnessPlan | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [revision, setRevision] = useState("");
  // 草案下移：点某一步「查看详细」时把面板挪到下栏，上方同时亮出两个浏览器面板
  const [docked, setDocked] = useState(false);
  // 展开详细的那一步（空 = 都收起）
  const [detailId, setDetailId] = useState("");
  // 悬停定位的序号：异步结果回来时用它判断鼠标是否已经移开
  const hoverSeqRef = useRef(0);
  // 用户主动点「收回大屏」：父级要回到清屏桌面，而不是留在工作区
  const backToDeskRef = useRef(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 草案打开 → 让父级收起大时钟（屏幕矮的时候两者会互相挤），并把草案滚进视野
  useEffect(() => {
    onDraftChange?.(!!draft);
    if (draft) rootRef.current?.scrollIntoView({ block: "center" });
  }, [draft, onDraftChange]);

  // 真正下移的条件：用户点了「查看详细」+ 草案还在 + 父级给了下栏容器
  const dockedLive = docked && !!draft;

  // 下移/收回都通知父级：父级据此亮出或收起两个浏览器面板
  useEffect(() => {
    onDockChange?.(dockedLive, webSide, backToDeskRef.current);
    backToDeskRef.current = false;
  }, [dockedLive, webSide, onDockChange]);

  // 草案被关掉（确认安排 / 跳过核对 / 放弃）→ 自动收回，父级恢复原布局
  useEffect(() => {
    if (!draft) {
      setDocked(false);
      setDetailId("");
    }
  }, [draft]);

  const clearWebHighlight = useCallback(() => {
    const bridge = window.electronAPI;
    if (!bridge) return;
    bridge.viewHighlightBoxes("left", []).catch(() => {});
    bridge.viewHighlightBoxes("right", []).catch(() => {});
  }, []);

  /** 把某一步的目标元素在网页里滚到眼前并亮框（草案只有人话目标，靠文字匹配定位） */
  const focusPlanStep = useCallback(
    async (step: HarnessPlanStep | null) => {
      const bridge = window.electronAPI;
      const seq = ++hoverSeqRef.current;
      if (!bridge) return;
      if (!step || step.side === "excel" || webSide === "none") {
        clearWebHighlight();
        return;
      }
      const side: ViewSide = webSide;
      const token = `s${seq}`;
      let hit: { ok?: boolean } | null = null;
      try {
        hit = (await bridge.viewExecuteJS(side, buildPlanProbeScript(step.target, token))) as
          | { ok?: boolean }
          | null;
      } catch {
        hit = null;
      }
      if (seq !== hoverSeqRef.current) return; // 鼠标已经移开或换了步骤
      if (!hit || !hit.ok) {
        clearWebHighlight();
        return;
      }
      bridge
        .viewHighlightBoxes(side, [
          {
            selector: `[data-cinside-plan-hit="${token}"]`,
            status: "pending",
            label: (step.target || "").slice(0, 26),
          },
        ])
        .catch(() => {});
    },
    [webSide, clearWebHighlight]
  );

  /** 悬停某一步 → 上下两个浏览器面板里对应的那个滚过去并亮起；移开就熄灭 */
  const hoverPlanStep = useCallback(
    (step: HarnessPlanStep | null) => {
      if (!dockedLive) return; // 还在大屏上核对时没有可见的网页面板，不必亮
      if (!step) {
        hoverSeqRef.current += 1;
        clearWebHighlight();
        return;
      }
      void focusPlanStep(step);
    },
    [dockedLive, focusPlanStep, clearWebHighlight]
  );

  /** 点某一步 = 查看详细：面板挪到下栏（占「字段对比」那一栏），并立刻在网页里定位这一步 */
  const openPlanStepDetail = useCallback(
    (step: HarnessPlanStep) => {
      setDetailId((prev) => (prev === step.id ? "" : step.id));
      if (!docked) setDocked(true);
      void focusPlanStep(step);
    },
    [docked, focusPlanStep]
  );

  /** 收回大屏：草案状态留在这里，父级把这层浮层重新铺满屏幕 */
  const undockToDesk = useCallback(() => {
    backToDeskRef.current = true;
    setDocked(false);
  }, []);

  const alivePages = useMemo(() => pages.filter((p) => p.url && p.alive !== false), [pages]);
  const allExcelSources = useMemo(
    () => [...pickedExcels, ...excelSources],
    [pickedExcels, excelSources]
  );
  const currentWeb = alivePages.find((p) => p.side === webSide) || null;
  const currentExcel = allExcelSources.find((s) => s.path === excelPath) || null;
  const webSideLabel = webSide === "left" ? "数据源" : webSide === "right" ? "学校系统" : "";
  // 面板是不是真的开着一个网页：about:blank / 空 URL 都算没开（这时既没法定位，草案也只能靠猜）
  const webBlank =
    webSide !== "none" &&
    !(currentWeb && currentWeb.url && !/^about:/i.test(currentWeb.url));
  const quickLinks = useMemo(() => {
    if (webSide === "none") return [];
    const list = (webSide === "left" ? favorites?.left : favorites?.right) || [];
    const out = list
      .filter((f) => f.url)
      .slice(0, 3)
      .map((f) => ({ name: f.name || f.url, url: f.url }));
    if (demoPages) {
      const url = webSide === "left" ? demoPages.left : demoPages.right;
      if (url) out.push({ name: "DEMO", url });
    }
    return out;
  }, [favorites, demoPages, webSide]);

  // ---------- 队列轮询 ----------
  const refresh = useCallback(async () => {
    try {
      const res = await api.harnessQueue();
      setTasks(res.tasks || []);
    } catch {
      /* 后端没起来时静默：这块是锦上添花，不该弹错误框打断桌面 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // ---------- 对象清单（首次自动挑一侧；草案开着时定时刷新，但不改用户选的侧） ----------
  const loadTargets = useCallback(async (autoPickSide = true) => {
    try {
      const tg = await api.harnessTargets();
      setExcelSources(tg.excel_sources || []);

      const api2 = window.electronAPI;
      let list: HarnessPage[] = tg.pages || [];
      if (api2?.harnessPages) {
        try {
          const local = await api2.harnessPages();
          list = local.map((p) => ({
            side: p.side,
            alive: p.alive,
            title: p.title || (p.side === "left" ? "数据源" : "学校系统"),
            url: p.url,
          }));
        } catch {
          /* 用后端列表兜底 */
        }
      }
      // 后端列表不知道左右侧：按顺序补上，保证浏览器里也能选
      list = list.map((p, i) => ({
        ...p,
        side: p.side || (i === 0 ? "left" : "right"),
      }));
      setPages(list);
      if (autoPickSide) {
        setWebSide((cur) => {
          if (cur !== "none" && list.some((p) => p.side === cur && p.url)) return cur;
          const first = list.find((p) => p.url && p.alive !== false);
          return (first?.side as "left" | "right") || "none";
        });
      }
      setExcelPath((cur) => {
        if (cur) return cur;
        const loaded = tg.excel_sources?.find((s) => s.editable) || tg.excel_sources?.[0];
        return loaded?.path || "";
      });
    } catch {
      /* 同上 */
    }
  }, []);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  // 草案开着时定时刷新对象清单：用户在上方面板把网页打开后，空白提示要及时消失
  useEffect(() => {
    if (!draft) return;
    const timer = window.setInterval(() => void loadTargets(false), 2500);
    return () => window.clearInterval(timer);
  }, [draft, loadTargets]);

  // ---------- 召唤 ----------
  const summon = useCallback(() => {
    setSummoned(true);
    setDraft(null);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  // 顶栏 HARNESS 按钮：直接把输入框弹出来
  useEffect(() => {
    if (autoSummon > 0) summon();
  }, [autoSummon, summon]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        summon();
      } else if (e.key === "Escape" && summoned) {
        setSummoned(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [summon, summoned]);

  /** 从磁盘挑表格：桌面端才有文件选择器 */
  const pickLocalExcel = async () => {
    const api2 = window.electronAPI;
    if (!api2?.harnessPickExcel) return;
    const res = await api2.harnessPickExcel();
    if (res.canceled || !res.file) return;
    const src: HarnessExcelSource = {
      id: `local-${res.file.file_path}`,
      label: "本地文件",
      filename: res.file.file_name,
      path: res.file.file_path,
      kind: "path",
      editable: true,
    };
    setPickedExcels((prev) =>
      prev.some((p) => p.path === src.path) ? prev : [src, ...prev]
    );
    setExcelPath(src.path);
  };

  // ---------- 对象绑定（多次复用） ----------
  const objectsPayload = useCallback(
    () => ({
      web: currentWeb
        ? {
            url: currentWeb.url,
            label: currentWeb.side === "left" ? "数据源" : "学校系统",
            exclude_urls: alivePages.filter((p) => p.side !== currentWeb.side).map((p) => p.url),
          }
        : null,
      excel: currentExcel?.path
        ? { path: currentExcel.path, label: currentExcel.filename }
        : null,
    }),
    [currentWeb, alivePages, currentExcel]
  );

  /**
   * 第一步：只出流程，不执行。
   * 让用户先看到「它打算点哪里、填哪里、写哪张表」，核对无误再变成卡片。
   */
  const makePlan = async (instructionArg?: string) => {
    const instruction = (instructionArg ?? text).trim();
    if (!instruction || drafting || busy) return;
    if (!currentWeb && !currentExcel) {
      setError("先绑定一个对象：网页或表格");
      return;
    }
    setDrafting(true);
    setError("");
    try {
      const res = await api.harnessPlan({ instruction, ...objectsPayload() });
      setDraft(res.plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  // 第二步：让 HARNESS 按意见改流程
  const revisePlan = async () => {
    const req = revision.trim();
    if (!draft || !req || revising) return;
    setRevising(true);
    setError("");
    try {
      const res = await api.harnessPlanRevise({
        plan: draft,
        request: req,
        instruction: text.trim() || draft.instruction || "",
        ...objectsPayload(),
      });
      setDraft(res.plan);
      setRevision("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevising(false);
    }
  };

  // 第三步：确认后才落成待执行卡片
  const confirmPlan = async (withPlan: boolean) => {
    const instruction = text.trim() || draft?.instruction || "";
    if (!instruction || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.harnessEnqueue({
        instruction,
        ...objectsPayload(),
        plan: withPlan && draft ? draft : null,
      });
      if (!res.ok) throw new Error("安排失败");
      setText("");
      setDraft(null);
      setSummoned(false);
      setRevision("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 手动编辑步骤
  const patchStep = (index: number, patch: Partial<HarnessPlanStep>) => {
    setDraft((prev) =>
      prev
        ? { ...prev, steps: prev.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) }
        : prev
    );
  };
  const removeStep = (index: number) => {
    setDraft((prev) =>
      prev ? { ...prev, steps: prev.steps.filter((_, i) => i !== index) } : prev
    );
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      /* 状态冲突（比如刚好结束）不打扰用户 */
    }
    await refresh();
  };

  const stats = useMemo(() => {
    const running = tasks.filter((t) => t.status === "running").length;
    const queued = tasks.filter((t) => t.status === "queued").length;
    return { running, queued };
  }, [tasks]);

  const hasQueued = tasks.some((t) => t.status === "queued");
  const workerIdle = hasQueued && stats.running === 0;

  // 草案面板：点了「查看详细」就 portal 到下栏「字段对比」那一栏，否则留在大屏中央
  const draftPanel = draft ? (
    <DraftPanel
      plan={draft}
      instruction={text}
      busy={busy}
      revising={revising}
      revision={revision}
      onRevision={setRevision}
      onPatchStep={patchStep}
      onRemoveStep={removeStep}
      onRevise={() => void revisePlan()}
      onRegenerate={() => void makePlan(text)}
      onConfirm={() => void confirmPlan(true)}
      onSkip={() => void confirmPlan(false)}
      onClose={() => {
        setDraft(null);
        setError("");
      }}
      docked={dockedLive}
      detailId={detailId}
      onOpenDetail={openPlanStepDetail}
      onHoverStep={hoverPlanStep}
      onLocateStep={(step) => void focusPlanStep(step)}
      onUndock={undockToDesk}
      webSideLabel={webSideLabel}
      webBlank={webBlank}
      quickLinks={quickLinks}
      onOpenQuick={(url) => {
        if (webSide === "left" || webSide === "right") onOpenUrl?.(webSide, url);
      }}
    />
  ) : null;

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto mt-5 flex w-full max-w-[680px] flex-col items-center gap-3"
    >
      {/* ===== 流程草案（核对 / 手改 / 让它改） ===== */}
      {draft ? (
        dockedLive && dockEl ? (
          createPortal(draftPanel, dockEl)
        ) : (
          draftPanel
        )
      ) : !summoned ? (
        <button
          onClick={summon}
          className="group flex items-center gap-2 rounded-full border border-white/50 bg-[var(--panel-bg-top)] px-3.5 py-1.5 text-[11px] font-medium text-slate-500 shadow-[0_10px_30px_-18px_rgba(15,23,42,.6)] backdrop-blur-md transition-all hover:-translate-y-px hover:text-slate-800 dark:border-white/15 dark:text-slate-300 dark:hover:text-white"
          title="按 / 也可以召唤"
        >
          <Plus className="h-3.5 w-3.5" />
          安排一个任务
          <kbd className="ml-1 rounded border border-slate-300/70 px-1 text-[9px] font-normal text-slate-400 dark:border-white/20 dark:text-slate-400">
            /
          </kbd>
        </button>
      ) : (
        <div className="w-full rounded-[22px] border border-white/50 bg-[var(--panel-bg-top)] p-2.5 shadow-[0_24px_60px_-30px_rgba(15,23,42,.65)] backdrop-blur-md dark:border-white/15">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void makePlan();
              }
            }}
            rows={2}
            placeholder="用一句话说清要它做什么，回车先生成流程。例如：把数据源网页里今天的申请逐条填进左边这张表。"
            className="w-full resize-none bg-transparent px-1.5 py-1 text-[12.5px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* 网页对象 */}
            <label className="flex items-center gap-1 rounded-full bg-white/70 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200/80 dark:bg-white/10 dark:text-slate-200 dark:ring-white/10">
              <Globe className="h-3 w-3 text-sky-600 dark:text-sky-400" />
              <select
                value={webSide}
                onChange={(e) => setWebSide(e.target.value as "left" | "right" | "none")}
                className="max-w-[128px] cursor-pointer truncate bg-transparent pr-0.5 focus:outline-none"
              >
                <option value="none">不用网页</option>
                {alivePages.map((p) => (
                  <option key={p.side} value={p.side}>
                    {p.side === "left" ? "数据源" : "学校系统"}
                  </option>
                ))}
              </select>
            </label>

            {/* Excel 对象 */}
            <label className="flex items-center gap-1 rounded-full bg-white/70 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200/80 dark:bg-white/10 dark:text-slate-200 dark:ring-white/10">
              <Table2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              <select
                value={excelPath}
                onChange={(e) => setExcelPath(e.target.value)}
                className="max-w-[150px] cursor-pointer truncate bg-transparent pr-0.5 focus:outline-none"
              >
                <option value="">不用表格</option>
                {allExcelSources.map((s) => (
                  <option key={s.id} value={s.path} disabled={!s.path}>
                    {s.filename}
                  </option>
                ))}
              </select>
            </label>
            {window.electronAPI?.harnessPickExcel && (
              <button
                onClick={() => void pickLocalExcel()}
                className="flex items-center gap-1 rounded-full bg-white/70 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200/80 hover:bg-white dark:bg-white/10 dark:text-slate-200 dark:ring-white/10"
                title="从磁盘挑一个表格（操作的是工作副本，原文件不会被改动）"
              >
                <FileSpreadsheet className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                本地
              </button>
            )}

            <span className="ml-auto hidden text-[9px] text-slate-400 sm:inline">
              Enter 生成流程 · Shift+Enter 换行 · Esc 收起
            </span>
            <button
              onClick={() => void makePlan()}
              disabled={drafting || !text.trim()}
              className="flex items-center gap-1 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 dark:bg-white dark:text-slate-900 dark:disabled:bg-white/20"
            >
              {drafting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CornerDownLeft className="h-3 w-3" />
              )}
              {drafting ? "生成流程…" : "生成流程"}
            </button>
            <button
              onClick={() => {
                setSummoned(false);
                setError("");
              }}
              className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white/60 hover:text-slate-700 dark:hover:bg-white/10"
              title="收起"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex w-full items-start gap-1 rounded-xl bg-rose-50/90 px-2 py-1 text-[10px] leading-relaxed text-rose-700 ring-1 ring-rose-200 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/20">
          <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => setError("")} className="shrink-0 opacity-60 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* ===== 概览 ===== */}
      {tasks.length > 0 && (
        <div className="flex w-full items-center gap-2 px-1 text-[10px] text-slate-500 dark:text-slate-400">
          <Zap className="h-3 w-3" />
          <span>
            {stats.running > 0 ? "1 个执行中" : "空闲"}
            {stats.queued > 0 ? ` · ${stats.queued} 个待执行` : ""}
            {tasks.length - stats.running - stats.queued > 0
              ? ` · ${tasks.length - stats.running - stats.queued} 个已结束`
              : ""}
          </span>
          {workerIdle && (
            <button
              onClick={() => void act(() => api.harnessQueueResume())}
              className="flex items-center gap-1 rounded-full bg-white/70 px-2 py-[2px] text-[9px] font-medium text-slate-600 ring-1 ring-slate-200/80 hover:bg-white dark:bg-white/10 dark:text-slate-200 dark:ring-white/10"
              title="应用重启后队列会停下，点这里继续"
            >
              <Play className="h-2.5 w-2.5" />
              继续执行
            </button>
          )}
          <button
            onClick={() => void act(() => api.harnessQueueClear())}
            className="ml-auto text-[9px] text-slate-400 transition-colors hover:text-rose-600"
          >
            清理已结束
          </button>
        </div>
      )}

      {/* ===== 卡片区 ===== */}
      {tasks.length > 0 && (
        <div className="flex max-h-[38vh] w-full flex-wrap justify-center gap-2 overflow-y-auto px-0.5 pb-1">
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              answerDraft={answering[t.id] || ""}
              onAnswerDraft={(v) => setAnswering((prev) => ({ ...prev, [t.id]: v }))}
              onAnswer={(text2) => {
                setAnswering((prev) => ({ ...prev, [t.id]: "" }));
                void act(() => api.harnessQueueAnswer(t.id, text2));
              }}
              onCancel={() => void act(() => api.harnessQueueCancel(t.id))}
              onDiscard={() => void act(() => api.harnessQueueDiscard(t.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<HarnessPlanStep["action"], string> = {
  click: "点击",
  input: "输入",
  select: "选择",
  press: "按键",
  scroll: "滚动",
  navigate: "打开",
  extract: "抽取",
  write: "写入",
  verify: "核对",
  wait: "等待",
};

/**
 * 流程草案面板：把 HARNESS 打算怎么做一条条摊开给用户核对。
 * 每一行都能直接改（动作 / 目标 / 值 / 备注），也能让模型按一句话重写。
 */
function DraftPanel({
  plan,
  instruction,
  busy,
  revising,
  revision,
  onRevision,
  onPatchStep,
  onRemoveStep,
  onRevise,
  onRegenerate,
  onConfirm,
  onSkip,
  onClose,
  docked,
  detailId,
  onOpenDetail,
  onHoverStep,
  onLocateStep,
  onUndock,
  webSideLabel,
  webBlank,
  quickLinks,
  onOpenQuick,
}: {
  plan: HarnessPlan;
  instruction: string;
  busy: boolean;
  revising: boolean;
  revision: string;
  onRevision: (v: string) => void;
  onPatchStep: (index: number, patch: Partial<HarnessPlanStep>) => void;
  onRemoveStep: (index: number) => void;
  onRevise: () => void;
  onRegenerate: () => void;
  onConfirm: () => void;
  onSkip: () => void;
  onClose: () => void;
  /** 面板已下移到下栏（占「字段对比」那一栏） */
  docked: boolean;
  /** 展开详细的那一步 id */
  detailId: string;
  /** 点某一步：展开详细 + 下移 + 在网页里定位 */
  onOpenDetail: (step: HarnessPlanStep) => void;
  /** 悬停某一步（null=移开）：在网页里滚到该元素并亮框 */
  onHoverStep: (step: HarnessPlanStep | null) => void;
  /** 只定位不展开（行尾的准星按钮） */
  onLocateStep: (step: HarnessPlanStep) => void;
  /** 收回大屏核对 */
  onUndock: () => void;
  /** 「数据源」/「学校系统」：给提示文案用 */
  webSideLabel: string;
  /** 这一侧的浏览器面板还停在空白页（没有可定位的网页） */
  webBlank: boolean;
  /** 一键打开：收藏站点 + DEMO 页 */
  quickLinks: { name: string; url: string }[];
  onOpenQuick: (url: string) => void;
}) {
  const steps = plan.steps || [];
  const listRef = useRef<HTMLDivElement | null>(null);

  // 新一版流程从第一步开始看（浏览器滚动锚定会让列表停在半截）
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [plan]);

  return (
    <div
      className={[
        "flex w-full flex-col border bg-[var(--panel-bg-top)] backdrop-blur-md",
        docked
          ? "h-full min-h-0 rounded-[10px] border-violet-200/70 p-2 dark:border-violet-400/25"
          : "max-h-[72vh] rounded-[22px] border-violet-200/70 p-2.5 shadow-[0_24px_60px_-30px_rgba(76,29,149,.5)] dark:border-violet-400/25",
      ].join(" ")}
    >
      {/* 头部 */}
      <div className="flex shrink-0 items-start gap-1.5 px-1">
        <span className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
          <Wand2 className="h-2.5 w-2.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">
              流程草案
            </span>
            <span className="rounded bg-violet-100 px-1 text-[9px] font-medium text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
              {steps.length} 步
            </span>
            <span className="text-[9px] text-slate-400">
              {docked ? "悬停某一步 → 上方网页滚到该元素并亮框" : "先核对，确认后才会变成待执行卡片"}
            </span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-slate-600 dark:text-slate-300">
            {plan.title}
          </div>
        </div>
        {docked && (
          <button
            onClick={onUndock}
            className="shrink-0 rounded px-1.5 py-1 text-[9px] text-slate-400 hover:bg-white/60 hover:text-slate-700 dark:hover:bg-white/10"
            title="收回大屏继续核对"
          >
            收回大屏
          </button>
        )}
        <button
          onClick={onClose}
          className="shrink-0 rounded p-1 text-slate-400 hover:bg-white/60 hover:text-slate-700 dark:hover:bg-white/10"
          title="放弃这次安排"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 依据 */}
      {(plan.context?.web || plan.context?.excel) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 px-1 text-[9px] text-slate-400">
          <span>依据：</span>
          {plan.context?.web && (
            <span className="rounded bg-sky-50 px-1 py-[1px] text-sky-700 dark:bg-sky-400/10 dark:text-sky-300">
              {plan.context.web.title || plan.context.web.url} · {plan.context.web.elements} 个可操作元素
            </span>
          )}
          {plan.context?.excel && (
            <span className="rounded bg-emerald-50 px-1 py-[1px] text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
              {plan.context.excel.file} · {plan.context.excel.sheets.join("/")} · {plan.context.excel.rows} 行
            </span>
          )}
        </div>
      )}

      {/* 网页面板还停在空白页：没有可定位的元素，先把页面打开再核对 */}
      {webBlank && (
        <div className="mt-1 flex flex-wrap items-center gap-1 rounded-md bg-amber-50 px-1.5 py-1 text-[9.5px] leading-relaxed text-amber-800 ring-1 ring-amber-200/80 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/20">
          <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
          <span className="min-w-0">
            「{webSideLabel}」面板还没打开网页：悬停不会定位元素，流程也只能按描述猜。
          </span>
          {quickLinks.map((l) => (
            <button
              key={l.url}
              onClick={() => onOpenQuick(l.url)}
              className="shrink-0 rounded bg-white/80 px-1 py-[1px] font-medium text-amber-800 ring-1 ring-amber-300/70 transition-colors hover:bg-white dark:bg-white/10 dark:text-amber-100 dark:ring-amber-400/30"
              title={l.url}
            >
              打开 {l.name}
            </button>
          ))}
          {quickLinks.length === 0 && (
            <span className="shrink-0 opacity-70">在上方地址栏输入网址即可</span>
          )}
        </div>
      )}

      {/* 步骤 + 风险 + 改动：一起滚动，底部操作区始终留在视野里 */}
      <div ref={listRef} className="mt-1.5 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {steps.length === 0 && (
          <div className="px-1 py-2 text-[10px] text-slate-400">
            没生成出步骤。换个说法重新生成，或跳过核对直接安排。
          </div>
        )}
        {steps.map((s, i) => (
          <div
            key={s.id || i}
            onMouseEnter={() => onHoverStep(s)}
            onMouseLeave={() => onHoverStep(null)}
            onClick={(e) => {
              // 行内的输入框/下拉/按钮自己处理点击，不算「查看详细」
              if ((e.target as HTMLElement).closest("input, select, textarea, button")) return;
              onOpenDetail(s);
            }}
            className={[
              "cursor-pointer rounded-lg bg-white/70 p-1.5 ring-1 transition-shadow dark:bg-white/5",
              detailId === s.id
                ? "ring-violet-400 shadow-[0_0_0_2px_rgba(139,92,246,.25)]"
                : "ring-slate-200/70 hover:ring-violet-300 dark:ring-white/10",
            ].join(" ")}
          >
            <div className="flex items-center gap-1">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-slate-900 text-[9px] font-semibold text-white dark:bg-white dark:text-slate-900">
                {i + 1}
              </span>
              <button
                onClick={() =>
                  onPatchStep(i, { side: s.side === "excel" ? "web" : "excel" })
                }
                className={[
                  "shrink-0 rounded px-1 text-[9px] font-medium transition-colors",
                  s.side === "excel"
                    ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-400/15 dark:text-emerald-300"
                    : "bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-400/15 dark:text-sky-300",
                ].join(" ")}
                title="点一下切换：网页 / 表格"
              >
                {s.side === "excel" ? "表格" : "网页"}
              </button>
              <select
                value={s.action}
                onChange={(e) =>
                  onPatchStep(i, { action: e.target.value as HarnessPlanStep["action"] })
                }
                className="shrink-0 cursor-pointer rounded bg-slate-100 px-0.5 text-[9px] text-slate-700 focus:outline-none dark:bg-white/10 dark:text-slate-200"
              >
                {(Object.keys(ACTION_LABEL) as HarnessPlanStep["action"][]).map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABEL[a]}
                  </option>
                ))}
              </select>
              <input
                value={s.target}
                onChange={(e) => onPatchStep(i, { target: e.target.value })}
                placeholder="目标元素 / 位置"
                className="min-w-0 flex-1 rounded bg-white px-1 py-[2px] text-[10.5px] text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-violet-400 dark:bg-white/10 dark:text-slate-100 dark:ring-white/10"
              />
              <button
                onClick={() => onLocateStep(s)}
                className="shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-400/10"
                title="在网页里定位这一步（滚到元素并亮框）"
              >
                <Crosshair className="h-2.5 w-2.5" />
              </button>
              <button
                onClick={() => onOpenDetail(s)}
                className="shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-400/10"
                title={detailId === s.id ? "收起详细" : "查看详细（面板会挪到下栏）"}
              >
                {detailId === s.id ? (
                  <ChevronDown className="h-2.5 w-2.5" />
                ) : (
                  <ChevronRight className="h-2.5 w-2.5" />
                )}
              </button>
              <button
                onClick={() => onRemoveStep(i)}
                className="shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-400/10"
                title="删掉这一步"
              >
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            </div>
            <div className="mt-1 flex items-center gap-1 pl-5">
              <input
                value={s.value}
                onChange={(e) => onPatchStep(i, { value: e.target.value })}
                placeholder="值 / 范围 / 位置"
                className="min-w-0 flex-[1.1] rounded bg-white/80 px-1 py-[2px] text-[9.5px] text-slate-600 ring-1 ring-slate-200/80 placeholder:text-slate-300 focus:outline-none focus:ring-violet-300 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10"
              />
              <input
                value={s.note || ""}
                onChange={(e) => onPatchStep(i, { note: e.target.value })}
                placeholder="备注 / 注意点"
                className="min-w-0 flex-1 rounded bg-transparent px-1 py-[2px] text-[9.5px] text-slate-400 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-200 dark:text-slate-400"
              />
            </div>
            {detailId === s.id && (
              <div className="mt-1 space-y-[2px] rounded-md bg-violet-50/80 px-1.5 py-1 text-[9.5px] leading-relaxed text-violet-800/90 dark:bg-violet-400/10 dark:text-violet-200/90">
                <div>
                  <span className="text-violet-500">目标</span> {s.target || "—"}
                </div>
                {s.value && (
                  <div>
                    <span className="text-violet-500">值 / 范围</span> {s.value}
                  </div>
                )}
                {s.note && (
                  <div>
                    <span className="text-violet-500">依据</span> {s.note}
                  </div>
                )}
                <div className="flex items-center gap-1 text-violet-500">
                  <Crosshair className="h-2.5 w-2.5" />
                  {s.side === "excel"
                    ? "表格步骤：在下方表格里核对位置"
                    : "已在上方网页定位；悬停其它步骤可逐个看"}
                </div>
              </div>
            )}
          </div>
        ))}

      {/* 风险 / 疑问 */}
      {(plan.risks?.length > 0 || plan.questions?.length > 0) && (
        <div className="mt-1.5 space-y-[3px] px-1">
          {plan.risks?.map((r, i) => (
            <div key={`r${i}`} className="flex gap-1 text-[9.5px] leading-relaxed text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-[1px] h-2.5 w-2.5 shrink-0" />
              <span className="min-w-0">{r}</span>
            </div>
          ))}
          {plan.questions?.map((q, i) => (
            <div key={`q${i}`} className="flex gap-1 text-[9.5px] leading-relaxed text-violet-700 dark:text-violet-300">
              <HelpCircle className="mt-[1px] h-2.5 w-2.5 shrink-0" />
              <span className="min-w-0">{q}</span>
            </div>
          ))}
        </div>
      )}

      {plan.changes && plan.changes.length > 0 && (
        <div className="mt-1 rounded-md bg-violet-50/80 px-1.5 py-1 dark:bg-violet-400/10">
          <div className="mb-0.5 text-[9px] font-medium text-violet-700 dark:text-violet-300">
            这次改了什么
          </div>
          {plan.changes.map((c, i) => (
            <div key={i} className="text-[9px] leading-relaxed text-violet-800/80 dark:text-violet-200/80">
              · {c}
            </div>
          ))}
        </div>
      )}

      </div>

      {/* 操作区（吸底：不随步骤滚动） */}
      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-full bg-white/80 px-2 py-1 ring-1 ring-slate-200/80 dark:bg-white/10 dark:ring-white/10">
          <Sparkles className="h-3 w-3 shrink-0 text-violet-500" />
          <input
            value={revision}
            onChange={(e) => onRevision(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRevise();
            }}
            placeholder="让它改：例如「第 3 步别新建表，直接追加到现有表」"
            className="min-w-0 flex-1 bg-transparent text-[10px] text-slate-700 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          />
          <button
            onClick={onRevise}
            disabled={revising || !revision.trim()}
            className="shrink-0 rounded-full bg-violet-600 px-2 py-[2px] text-[9px] font-medium text-white hover:bg-violet-700 disabled:bg-slate-300 dark:disabled:bg-white/20"
          >
            {revising ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "改"}
          </button>
        </div>
        <button
          onClick={onRegenerate}
          disabled={busy}
          className="flex items-center gap-1 rounded-full bg-white/80 px-2 py-1 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200/80 hover:bg-white disabled:opacity-50 dark:bg-white/10 dark:text-slate-200 dark:ring-white/10"
          title="按同样的任务重新生成一版流程"
        >
          <RefreshCw className="h-3 w-3" />
          重生成
        </button>
        <button
          onClick={onConfirm}
          disabled={busy || steps.length === 0}
          className="flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-[10.5px] font-semibold text-white shadow-sm transition-all hover:bg-slate-800 disabled:bg-slate-300 dark:bg-white dark:text-slate-900 dark:disabled:bg-white/20"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          确认安排
          <ArrowRight className="h-2.5 w-2.5" />
        </button>
        <button
          onClick={onSkip}
          disabled={busy}
          className="text-[9px] text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
          title="不做核对，直接按任务描述执行"
        >
          跳过核对
        </button>
      </div>
      {instruction.trim() && (
        <div className="mt-1 truncate px-1 text-[9px] text-slate-400" title={instruction}>
          任务：{instruction}
        </div>
      )}
    </div>
  );
}

const STATUS_META: Record<
  HarnessQueueTask["status"],
  { label: string; cls: string; dot: string }
> = {
  queued: {
    label: "待执行",
    cls: "bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300",
    dot: "bg-slate-400",
  },
  running: {
    label: "执行中",
    cls: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  done: {
    label: "已完成",
    cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  error: {
    label: "出错",
    cls: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  canceled: {
    label: "已取消",
    cls: "bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400",
    dot: "bg-slate-300",
  },
};

function TaskCard({
  task,
  answerDraft,
  onAnswerDraft,
  onAnswer,
  onCancel,
  onDiscard,
}: {
  task: HarnessQueueTask;
  answerDraft: string;
  onAnswerDraft: (v: string) => void;
  onAnswer: (text: string) => void;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const meta = STATUS_META[task.status] || STATUS_META.queued;
  const live = task.status === "running";

  return (
    <div
      className={[
        "group relative flex w-full flex-col gap-1.5 rounded-[18px] border bg-[var(--panel-bg-top)] p-2.5 backdrop-blur-md transition-shadow sm:w-[326px]",
        live
          ? "border-sky-300/80 shadow-[0_0_0_1px_rgba(56,189,248,.35),0_18px_40px_-28px_rgba(2,132,199,.8)] dark:border-sky-400/40"
          : "border-white/50 shadow-[0_14px_36px_-26px_rgba(15,23,42,.6)] dark:border-white/12",
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5">
        <span className={`flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[9px] font-medium ${meta.cls}`}>
          {live ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          )}
          {meta.label}
        </span>
        {live && task.steps > 0 && (
          <span className="text-[9px] text-slate-400">第 {task.steps} 步</span>
        )}
        {task.created_at > 0 && (
          <span className="text-[9px] text-slate-400">
            {new Date(task.created_at * 1000).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {task.status === "queued" && (
            <button
              onClick={onCancel}
              className="rounded p-1 text-slate-400 hover:bg-white/70 hover:text-rose-600 dark:hover:bg-white/10"
              title="取消"
            >
              <X className="h-3 w-3" />
            </button>
          )}
          {live && (
            <button
              onClick={onCancel}
              className="rounded p-1 text-slate-400 hover:bg-white/70 hover:text-rose-600 dark:hover:bg-white/10"
              title="停止"
            >
              <Square className="h-3 w-3" />
            </button>
          )}
          {!live && task.status !== "queued" && (
            <button
              onClick={onDiscard}
              className="rounded p-1 text-slate-400 hover:bg-white/70 hover:text-slate-700 dark:hover:bg-white/10"
              title="从桌面移除"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="line-clamp-3 text-[11.5px] leading-relaxed text-slate-800 dark:text-slate-100">
        {task.instruction}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {task.web_label && (
          <span className="flex items-center gap-0.5 rounded bg-sky-50 px-1 py-[1px] text-[9px] text-sky-700 dark:bg-sky-400/10 dark:text-sky-300">
            <Globe className="h-2.5 w-2.5" />
            {task.web_label}
          </span>
        )}
        {task.excel_label && (
          <span className="flex items-center gap-0.5 rounded bg-emerald-50 px-1 py-[1px] text-[9px] text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
            <Table2 className="h-2.5 w-2.5" />
            {task.excel_label}
          </span>
        )}
      </div>

      {live && task.steps > 0 && task.plan?.steps?.length ? (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-slate-400">
            流程 {Math.min(task.steps, task.plan.steps.length)}/{task.plan.steps.length}
          </span>
          <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-slate-200/70 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-sky-500 transition-all"
              style={{
                width: `${Math.min(100, (task.steps / task.plan.steps.length) * 100)}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {live && task.actions.length > 0 && (
        <div className="truncate text-[9px] text-slate-500 dark:text-slate-400">
          {task.actions[task.actions.length - 1]}
        </div>
      )}

      {task.plan?.steps?.length ? (
        <details className="group/plan">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[9px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <ArrowRight className="h-2.5 w-2.5 transition-transform group-open/plan:rotate-90" />
            查看确认过的流程（{task.plan.steps.length} 步）
          </summary>
          <div className="mt-1 space-y-[2px] rounded-md bg-slate-50/80 p-1 dark:bg-white/5">
            {task.plan.steps.map((s, i) => (
              <div key={s.id || i} className="flex gap-1 text-[9px] leading-relaxed text-slate-500 dark:text-slate-400">
                <span className="shrink-0 text-slate-400">{i + 1}.</span>
                <span className="shrink-0 text-slate-400">
                  [{s.side === "excel" ? "表格" : "网页"}]
                </span>
                <span className="min-w-0 break-words">{s.target}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {task.summary && task.status !== "running" && (
        <div
          className={[
            "line-clamp-3 rounded-md px-1.5 py-1 text-[9.5px] leading-relaxed",
            task.status === "done"
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200"
              : "bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300",
          ].join(" ")}
        >
          <span className="mr-1 inline-flex translate-y-[1px]">
            {task.status === "done" ? (
              <CheckCircle2 className="h-2.5 w-2.5" />
            ) : (
              <Pause className="h-2.5 w-2.5" />
            )}
          </span>
          {task.summary}
        </div>
      )}

      {task.error && (
        <div
          title={task.error}
          className="line-clamp-3 rounded-md bg-rose-50 px-1.5 py-1 text-[9.5px] leading-relaxed text-rose-700 dark:bg-rose-400/10 dark:text-rose-300"
        >
          <span className="mr-1 inline-flex translate-y-[1px]">
            <AlertTriangle className="h-2.5 w-2.5" />
          </span>
          {task.error}
        </div>
      )}

      {task.ask && (
        <div className="rounded-md bg-amber-50 px-1.5 py-1 dark:bg-amber-400/10">
          <div className="text-[9.5px] leading-relaxed text-amber-900 dark:text-amber-200">
            {task.ask.question}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {task.ask.options.map((o) => (
              <button
                key={o}
                onClick={() => onAnswer(o)}
                className="rounded-full bg-white px-1.5 py-[1px] text-[9px] text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100 dark:bg-white/10 dark:text-amber-200 dark:ring-amber-400/30"
              >
                {o}
              </button>
            ))}
            <input
              value={answerDraft}
              onChange={(e) => onAnswerDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answerDraft.trim()) onAnswer(answerDraft.trim());
              }}
              placeholder="或直接回答…"
              className="min-w-0 flex-1 rounded-full bg-white px-1.5 py-[1px] text-[9px] ring-1 ring-amber-300 focus:outline-none dark:bg-white/10 dark:text-slate-100 dark:ring-amber-400/30"
            />
          </div>
        </div>
      )}
    </div>
  );
}
