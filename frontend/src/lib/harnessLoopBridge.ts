/**
 * HARNESS ↔ CINSIDE LOOP 桥：前端执行器。
 *
 * HARNESS（后端 LLM 循环）通过 loop_* 工具把「生成人物卡片 / 固化 LOOP 模板 /
 * 试跑第一张 / 批量回放」交给这里，由 App 注入的真正 LOOP 引擎
 * （generateCards / WorkflowTemplate / executeTemplateForRecord / runBatch）执行——
 * 与用户手工教学后跑 CIRCLE 完全同一条链路（前置点击、绑定输入、挂件、文件提取、收尾点击）。
 */
import type {
  ApplicantRecord,
  FieldMapping,
  PickedMark,
  WorkflowTemplate,
} from "../types";

/** HARNESS loop_build_template 传来的一步（selector 已是真实 CSS 选择器） */
export interface HarnessLoopStep {
  kind: "click" | "input" | "review" | "widget" | "doc_extract";
  side: "left" | "right";
  selector: string;
  label?: string;
  column?: string;
  value?: string;
  phase?: "pre" | "mid" | "post";
  widget?: {
    kind: "option" | "calendar";
    trigger_selector?: string;
    panel_selector?: string;
    inline?: boolean;
    options?: Array<{ text?: string; value?: string; selector: string; alias?: string }>;
    calendar?: Record<string, unknown>;
  };
  doc_url?: string;
}

export interface LoopBridgeHandlers {
  /** 当前引擎状态快照 */
  status: () => Record<string, unknown>;
  /** 从 Excel records 生成人物卡片（start/end 为 1-based 数据行号，含端点） */
  makeCards: (startRow: number, endRow: number) => { ok: boolean; error?: string; count?: number; total?: number };
  /** 保存模板并绑定到全部卡片 */
  saveTemplate: (tpl: WorkflowTemplate) => void;
  /** 试跑单张卡片（完整 CIRCLE），返回执行结果 */
  runFirst: (tpl: WorkflowTemplate, record: ApplicantRecord) => Promise<Record<string, unknown>>;
  /** 批量执行（走 runBatch），返回统计 */
  runAll: (tpl: WorkflowTemplate, targetIds: string[]) => Promise<Record<string, unknown>>;
  /** 取当前卡片池（找第一张/其余） */
  getCards: () => ApplicantRecord[];
  /** 取已保存模板 */
  getTemplate: (id: string) => WorkflowTemplate | null;
}

let handlers: LoopBridgeHandlers | null = null;
/** 最近一次 HARNESS 建的模板 id（loop_run_first/all 留空时用） */
let lastTemplateId = "";

export function registerLoopBridge(h: LoopBridgeHandlers): void {
  handlers = h;
}

/** 把 HARNESS 的步骤清单转成真正的 WorkflowTemplate（与教学保存的结构一致） */
export function buildTemplateFromHarnessSteps(
  name: string,
  mode: "entry" | "review" | "loop",
  steps: HarnessLoopStep[],
  sourceRecordId?: string,
): WorkflowTemplate {
  const now = Date.now();
  const dataSourceMarks: PickedMark[] = [];
  const reviewMarks: PickedMark[] = [];
  const entryMarks: PickedMark[] = [];
  const mappings: FieldMapping[] = [];

  steps.forEach((s, i) => {
    const order = i + 1;
    const base: PickedMark = {
      id: `hn-${now}-${i}`,
      order,
      side: s.side === "left" ? "left" : "right",
      source: "web",
      selector: s.selector,
      label: s.label || s.selector,
      workflow: "entry",
      createdAt: now + i,
      recordId: sourceRecordId,
    };
    if (s.kind === "click") {
      const m: PickedMark = { ...base, action: "click", workflow: "data-source" };
      if (s.phase) m.clickPhase = s.phase;
      // 带 phase 的点击按引擎约定归入 dataSourceMarks；无 phase 的普通点击归录入流
      if (s.phase) dataSourceMarks.push(m);
      else entryMarks.push({ ...m, workflow: "entry" });
      return;
    }
    if (s.kind === "input") {
      const m: PickedMark = {
        ...base,
        action: "input",
        workflow: mode === "review" ? "data-source" : "entry",
        inputTarget: s.selector,
        inputTargetLabel: s.label || s.selector,
        value: s.column ? "" : (s.value || ""),
        variableField: s.column || undefined,
        excelField: s.column || undefined,
      };
      if (mode === "review") dataSourceMarks.push(m);
      else entryMarks.push(m);
      if (s.column) {
        mappings.push({
          right_selector: s.selector,
          right_label: s.label || s.selector,
          left_source: "excel",
          left_field: s.column,
          web_side: base.side,
          createdAt: now + i,
        });
      }
      return;
    }
    if (s.kind === "review") {
      reviewMarks.push({ ...base, action: "pick", workflow: "review" });
      if (s.column) {
        mappings.push({
          right_selector: s.selector,
          right_label: s.label || s.selector,
          left_source: "excel",
          left_field: s.column,
          web_side: base.side,
          createdAt: now + i,
        });
      }
      return;
    }
    if (s.kind === "widget" && s.widget) {
      const w = s.widget;
      const trigger = w.trigger_selector || s.selector;
      const widgetDef = {
        id: `hn-wg-${now}-${i}`,
        kind: w.kind,
        side: base.side,
        inline: !!w.inline,
        triggerSelector: trigger,
        triggerLabel: s.label || trigger,
        panelSelector: w.panel_selector,
        options: (w.options || []).map((o) => ({
          text: o.text || o.value || "",
          selector: o.selector,
          alias: o.alias,
        })),
        calendar: w.calendar as never,
        createdAt: now + i,
      };
      entryMarks.push({
        ...base,
        selector: trigger,
        action: "input",
        workflow: "entry",
        inputTarget: trigger,
        inputTargetLabel: s.label || trigger,
        variableField: s.column || undefined,
        excelField: s.column || undefined,
        widget: widgetDef,
      });
      if (s.column) {
        mappings.push({
          right_selector: trigger,
          right_label: s.label || trigger,
          right_input_type: "widget",
          left_source: "excel",
          left_field: s.column,
          web_side: base.side,
          widget: widgetDef,
          createdAt: now + i,
        });
      }
      return;
    }
    if (s.kind === "doc_extract") {
      entryMarks.push({
        ...base,
        action: "click",
        workflow: "entry",
        docExtract: true,
        docSource: "web",
        docUrl: s.doc_url || undefined,
      });
      return;
    }
  });

  return {
    id: `tpl-harness-${now}`,
    name: name || "HARNESS LOOP",
    description: "HARNESS 固化的自动化流程",
    icon: "⚡",
    createdAt: now,
    sourceRecordId,
    mode,
    dataSourceMarks,
    reviewMarks,
    entryMarks,
    mappings: mappings.length > 0 ? mappings : undefined,
    hasSearchSteps: dataSourceMarks.some((m) => m.action === "input" && !!m.variableField),
    hasSubmitStep: [...entryMarks, ...dataSourceMarks].some(
      (m) => m.action === "click" && m.clickPhase === "post",
    ),
  };
}

/** 执行一条 HARNESS 桥请求，返回回执 result */
export async function handleLoopBridgeCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!handlers) return { ok: false, error: "LOOP 执行器未就绪（主界面还没加载完成）" };
  const h = handlers;
  try {
    if (tool === "loop_status") {
      return { ok: true, ...h.status(), last_template_id: lastTemplateId || undefined };
    }
    if (tool === "loop_make_cards") {
      const start = Math.max(1, Number(args.start_row) || 1);
      const end = Math.max(start, Number(args.end_row) || Number.MAX_SAFE_INTEGER);
      const r = h.makeCards(start, end);
      return r.ok
        ? { ok: true, created: r.count, total_cards: r.total, note: "人物卡片已生成，可 loop_build_template + loop_run_first" }
        : { ok: false, error: r.error || "生成卡片失败" };
    }
    if (tool === "loop_build_template") {
      const steps = Array.isArray(args.steps) ? (args.steps as HarnessLoopStep[]) : [];
      if (steps.length === 0) return { ok: false, error: "steps 不能为空" };
      const mode = (args.mode === "entry" || args.mode === "review") ? args.mode : "loop";
      const cards = h.getCards();
      const tpl = buildTemplateFromHarnessSteps(
        String(args.name || "HARNESS LOOP"), mode, steps, cards[0]?.record_id,
      );
      h.saveTemplate(tpl);
      lastTemplateId = tpl.id;
      return {
        ok: true,
        template_id: tpl.id,
        name: tpl.name,
        mode: tpl.mode,
        steps: steps.length,
        cards: cards.length,
        note: cards.length === 0
          ? "模板已保存，但还没有人物卡片：先 loop_make_cards 再 loop_run_first"
          : "模板已保存并绑定全部卡片。下一步 loop_run_first 试跑第一张。",
      };
    }
    if (tool === "loop_run_first" || tool === "loop_run_all") {
      const id = String(args.template_id || "") || lastTemplateId;
      const tpl = id ? h.getTemplate(id) : null;
      if (!tpl) return { ok: false, error: `找不到模板「${id || "(未建)"}」：先 loop_build_template` };
      const cards = h.getCards();
      if (cards.length === 0) return { ok: false, error: "没有人物卡片：先 loop_make_cards" };
      if (tool === "loop_run_first") {
        const r = await h.runFirst(tpl, cards[0]);
        return { ...r, record: cards[0].fields.name || cards[0].record_id, remaining: cards.length - 1 };
      }
      const skipFirst = args.skip_first !== false;
      const targets = (skipFirst ? cards.slice(1) : cards).map((c) => c.record_id);
      if (targets.length === 0) return { ok: true, success: 0, failed: 0, note: "只有第一张卡片且已开荒，无需批量" };
      return await h.runAll(tpl, targets);
    }
    return { ok: false, error: `未知 LOOP 桥工具：${tool}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}