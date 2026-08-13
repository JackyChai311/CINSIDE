import type { WorkflowTemplate, FlowGraph, FlowNode, FlowBranch, FlowNodeKind, PickedMark } from "../types";

/** 生成简单唯一 ID（不依赖 crypto，兼容浏览器/Node） */
export function genId(prefix = "n"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从 WorkflowTemplate 的 marks 自动生成线性流程图（无分支无嵌套） */
export function buildLinearGraph(tpl: WorkflowTemplate): FlowGraph {
  const nodes: FlowNode[] = [];
  const phases: Array<{ key: "data-source" | "review" | "entry"; marks: PickedMark[]; label: string }> = [
    { key: "data-source", marks: tpl.dataSourceMarks, label: "数据源" },
  ];
  if (tpl.mode === "review" || tpl.mode === "loop") {
    phases.push({ key: "review", marks: tpl.reviewMarks, label: "审查" });
  }
  if (tpl.mode === "entry" || tpl.mode === "loop") {
    phases.push({ key: "entry", marks: tpl.entryMarks, label: "录入" });
  }
  for (const ph of phases) {
    const sorted = [...ph.marks].sort((a, b) => a.order - b.order);
    for (const m of sorted) {
      // 文件处理类步骤（文件提取/上传/面板按钮记录）跨泳道居中宽卡片，与普通录入/审查步骤区分
      const wide = !!(m.fileOp || m.docExtract || m.docUpload || m.panelAction);
      nodes.push({
        id: genId("step"),
        kind: "step",
        label: buildStepLabel(m),
        markPhase: ph.key,
        markId: m.id,
        markSide: m.side,
        breakpoint: m.breakpoint,
        wide,
      });
    }
  }
  // 显式加一个回环节点（视觉上闭环）
  nodes.push({
    id: genId("loop"),
    kind: "loopback",
    label: "下一张卡片（回到开头）",
  });
  return { version: 1, nodes, updatedAt: Date.now() };
}

/** 根据 PickedMark 构建步骤的默认显示标签 */
export function buildStepLabel(m: PickedMark): string {
  const actionMap: Record<string, string> = {
    click: "点击",
    input: "输入",
    pick: "取值",
  };
  const phaseTag = m.clickPhase === "post" ? " [收尾]" : m.clickPhase === "mid" ? " [过程]" : m.clickPhase === "pre" ? " [导航]" : "";
  if (m.fileOp) return `🗂 ${m.label || "文件处理"}`;
  if (m.docExtract) return `📄 提取文件${phaseTag}: ${m.label || m.selector}`;
  if (m.docUpload) return `📎 上传文件${phaseTag}: ${m.label || m.selector}`;
  if (m.widget) {
    const wkind = m.widget.kind === "calendar" ? "日历" : "选项";
    return `🎛 ${wkind}控件${phaseTag}: ${m.widget.triggerLabel || m.label || m.selector}`;
  }
  if (m.action === "input" && m.variableField) {
    return `⌨️ ${m.workflow === "entry" ? "填入" : "定位"}「${m.variableField}」→ ${(m.inputTargetLabel || m.label || "").replace(/^输入\s*·?\s*/, "")}`;
  }
  if (m.action === "click") {
    return `🖱 点击${phaseTag}: ${m.label || m.selector}`;
  }
  if (m.action === "input") {
    const w = m.workflow === "entry" ? "录入" : "审查";
    return `⌨️ ${w}${phaseTag}: ${(m.label || m.selector).replace(/^输入\s*·?\s*/, "")}`;
  }
  return `${actionMap[m.action || "pick"] || "步骤"}: ${m.label || m.selector}`;
}

/** 获取或初始化模板的流程图（没有则从 marks 构建） */
export function ensureGraph(tpl: WorkflowTemplate): FlowGraph {
  if (tpl.flowGraph && Array.isArray(tpl.flowGraph.nodes)) return tpl.flowGraph;
  return buildLinearGraph(tpl);
}

// ========== 节点查找 / 遍历 ==========

/** 在节点树中查找指定 id 的节点以及它所在的容器数组和索引 */
export interface NodeLocation {
  node: FlowNode;
  parent: FlowNode[];       // 该节点所在的数组
  index: number;            // 在数组中的索引
  parentBranch?: FlowBranch; // 如果在分支里，是哪个分支
  parentNode?: FlowNode;     // 如果在分支里，父节点
  path: string;             // 路径标识（主:0/分支:b1/...）
}

export function findNode(nodes: FlowNode[], id: string, parentBranch?: FlowBranch, parentNode?: FlowNode, path = "root"): NodeLocation | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const curPath = `${path}[${i}]`;
    if (n.id === id) return { node: n, parent: nodes, index: i, parentBranch, parentNode, path: curPath };
    if (n.branches) {
      for (const b of n.branches) {
        const found = findNode(b.nodes, id, b, n, `${curPath}/branch:${b.id}`);
        if (found) return found;
      }
    }
  }
  return null;
}

/** 深克隆节点（生成新 id，避免冲突） */
export function cloneNodes(nodes: FlowNode[], idMap: Map<string, string> = new Map()): FlowNode[] {
  return nodes.map((n) => {
    const newId = genId(n.kind.slice(0, 3));
    idMap.set(n.id, newId);
    const cloned: FlowNode = { ...n, id: newId };
    if (n.branches) {
      cloned.branches = n.branches.map((b) => ({
        ...b,
        id: genId("br"),
        nodes: cloneNodes(b.nodes, idMap),
      }));
    }
    return cloned;
  });
}

// ========== 编辑操作 ==========

/** 在指定节点后剪开，返回插入位置信息（在 idx 与 idx+1 之间） */
export type InsertPos = { parent: FlowNode[]; index: number };

/** 在指定节点"之后"插入新节点 */
export function insertAfter(parent: FlowNode[], index: number, newNode: FlowNode): void {
  parent.splice(index + 1, 0, newNode);
}

/** 在指定节点"之前"插入新节点 */
export function insertBefore(parent: FlowNode[], index: number, newNode: FlowNode): void {
  parent.splice(index, 0, newNode);
}

/** 删除节点（返回被删除的节点） */
export function removeNode(loc: NodeLocation): FlowNode {
  const [removed] = loc.parent.splice(loc.index, 1);
  return removed;
}

/** 创建子LOOP节点 */
export function makeSubloop(templateId: string, templateName: string, repeat = 1): FlowNode {
  return {
    id: genId("sub"),
    kind: "subloop",
    label: `🔁 子LOOP: ${templateName}`,
    subloopTemplateId: templateId,
    subloopRepeat: repeat,
  };
}

/** 创建 IF/ELSE 节点 */
export function makeIfElse(condition: string = ""): FlowNode {
  return {
    id: genId("if"),
    kind: "ifelse",
    label: condition ? `❓ IF ${condition}` : "❓ IF/ELSE",
    branches: [
      { id: genId("br"), label: "是 (IF)", condition, nodes: [] },
      { id: genId("br"), label: "否 (ELSE)", nodes: [] },
    ],
  };
}

/** 创建 CASE 节点 */
export function makeCase(switchField: string = "", caseLabels: string[] = ["case1", "case2"]): FlowNode {
  return {
    id: genId("case"),
    kind: "case",
    label: switchField ? `🔀 SWITCH ${switchField}` : "🔀 SWITCH/CASE",
    switchField,
    branches: caseLabels.map((lbl) => ({
      id: genId("br"),
      label: lbl,
      nodes: [],
    })),
  };
}

/** 创建注释节点 */
export function makeComment(text: string): FlowNode {
  return { id: genId("cmt"), kind: "comment", label: `💬 ${text}`, note: text };
}

/** 复制一段节点（从 startId 到 endId，包含两端），返回新节点数组（id已重置） */
export function copyRange(nodes: FlowNode[], startId: string, endId: string): FlowNode[] {
  const i1 = nodes.findIndex((n) => n.id === startId);
  const i2 = nodes.findIndex((n) => n.id === endId);
  if (i1 < 0 || i2 < 0) return [];
  const [from, to] = i1 <= i2 ? [i1, i2] : [i2, i1];
  const slice = nodes.slice(from, to + 1);
  return cloneNodes(slice);
}

/** 在 CASE 节点添加一个分支 */
export function addCaseBranch(node: FlowNode, label: string): FlowBranch | null {
  if (node.kind !== "case" || !node.branches) return null;
  const br: FlowBranch = { id: genId("br"), label, nodes: [] };
  node.branches.push(br);
  return br;
}

/** 删除一个分支（至少保留一个） */
export function removeBranch(node: FlowNode, branchId: string): boolean {
  if (!node.branches) return false;
  const idx = node.branches.findIndex((b) => b.id === branchId);
  if (idx < 0 || node.branches.length <= 1) return false;
  node.branches.splice(idx, 1);
  return true;
}

/** 计算节点总数（递归含分支内节点） */
export function countNodes(nodes: FlowNode[]): number {
  let c = 0;
  for (const n of nodes) {
    c++;
    if (n.branches) for (const b of n.branches) c += countNodes(b.nodes);
  }
  return c;
}

/**
 * 将流程图"拍平"成线性步骤序列（仅作参考；真正的条件执行需要执行器支持）。
 * 遇到 subloop 时把传入的 subTemplate 的 nodes 展开插入（简单替换，不递归条件）。
 */
export function flattenNodes(
  nodes: FlowNode[],
  resolveTemplate?: (id: string) => WorkflowTemplate | null,
  visited = new Set<string>(),
): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of nodes) {
    if (n.kind === "subloop" && n.subloopTemplateId && resolveTemplate && !visited.has(n.subloopTemplateId)) {
      const sub = resolveTemplate(n.subloopTemplateId);
      if (sub?.flowGraph) {
        visited.add(n.subloopTemplateId);
        const repeat = n.subloopRepeat || 1;
        for (let i = 0; i < repeat; i++) {
          out.push(...flattenNodes(sub.flowGraph.nodes, resolveTemplate, new Set(visited)));
        }
        visited.delete(n.subloopTemplateId);
      } else {
        out.push(n);
      }
    } else if (n.kind === "ifelse" && n.branches) {
      // 拍平：把两个分支串起来（线性近似）
      out.push(n);
      for (const b of n.branches) out.push(...flattenNodes(b.nodes, resolveTemplate, visited));
    } else if (n.kind === "case" && n.branches) {
      out.push(n);
      for (const b of n.branches) out.push(...flattenNodes(b.nodes, resolveTemplate, visited));
    } else if (n.kind !== "comment") {
      out.push(n);
    }
  }
  return out;
}
