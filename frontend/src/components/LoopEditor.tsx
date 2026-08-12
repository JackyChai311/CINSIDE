import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  X, Plus, Scissors, Copy, Clipboard, Trash2, ChevronDown, ChevronRight,
  GitBranch, Split, Repeat, MessageSquare, Save, RotateCcw, CornerDownRight,
  ZoomIn, ZoomOut, MousePointer2, CirclePause, AlertOctagon,
} from "lucide-react";
import type { WorkflowTemplate, FlowGraph, FlowNode, FlowBranch } from "../types";
import {
  ensureGraph, buildLinearGraph, findNode, cloneNodes,
  makeSubloop, makeIfElse, makeCase, makeComment, addCaseBranch,
  removeBranch, countNodes,
} from "../lib/flowGraph";
import { saveSkill } from "../lib/skills";

// ========== 布局常量（左右泳道） ==========
const LANE_W = 280;                 // 单侧泳道卡片宽度
const GUTTER = 100;                 // 中间隔带宽度（回归线通道）
const FULL_W = LANE_W * 2 + GUTTER; // 画布总宽 = 660
const LEFT_CX = LANE_W / 2;                             // = 140  左侧泳道卡片中心 x
const RIGHT_CX = LANE_W + GUTTER + LANE_W / 2;          // = 520  右侧泳道卡片中心 x
const MID_CX = FULL_W / 2;                              // = 330  中线（隔带中心）
const WIDE_W = FULL_W - 40;                             // = 620  跨泳道节点宽

const NODE_H_STEP = 72;
const NODE_H_SUBLOOP = 74;
const NODE_H_BRANCH = 74;
const NODE_H_COMMENT = 46;
const NODE_H_LOOPBACK = 56;
const GAP_Y = 36;
const BRANCH_GAP_X = 50;
const BRANCH_PAD_X = 24;
const BRANCH_PAD_Y = 28;
const BR_LABEL_H = 28;

type ToolMode = "select" | "subloop" | "ifelse" | "case" | "comment" | "cut";

/** 插入位置描述符（使用稳定ID，不受clone影响） */
type InsertAnchor =
  | { type: "before"; nodeId: string }
  | { type: "after"; nodeId: string }
  | { type: "branch-start"; parentNodeId: string; branchId: string }
  | { type: "end"; }; // 末尾（loopback之前）

interface LaidNode {
  node: FlowNode;
  x: number;
  y: number;
  w: number;
  h: number;
  subtreeH: number;
  branchLayouts?: LaidBranch[];
}
interface LaidBranch {
  branch: FlowBranch;
  x: number;
  y: number;
  w: number;
  h: number;
  nodes: LaidNode[];
}

interface EdgeInfo {
  id: string;
  anchor: InsertAnchor;
  pathD: string;
  midX: number;
  midY: number;
  isLoopback?: boolean;
}

function anchorEquals(a: InsertAnchor, b: InsertAnchor): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "end" && b.type === "end") return true;
  if (a.type === "before" && b.type === "before") return a.nodeId === b.nodeId;
  if (a.type === "after" && b.type === "after") return a.nodeId === b.nodeId;
  if (a.type === "branch-start" && b.type === "branch-start") return a.parentNodeId === b.parentNodeId && a.branchId === b.branchId;
  return false;
}

/** 节点所在的泳道：step 按 markSide 分左右，wide 步骤与其余节点跨泳道居中 */
function nodeLane(n: FlowNode): "left" | "right" | "center" {
  if (n.kind === "step" && !n.wide) return n.markSide === "right" ? "right" : "left";
  return "center";
}

function laneCx(lane: "left" | "right" | "center"): number {
  return lane === "left" ? LEFT_CX : lane === "right" ? RIGHT_CX : MID_CX;
}

function nodeWidth(n: FlowNode): number {
  if (n.kind === "step" && !n.wide) return LANE_W;
  return WIDE_W;
}

function layoutNode(node: FlowNode): LaidNode {
  if (node.kind === "ifelse" || node.kind === "case") {
    const branches = node.branches || [];
    const collapsed = node.collapsed;
    const branchLayouts: LaidBranch[] = [];
    let totalW = 0;
    let maxBranchH = 0;
    if (!collapsed) {
      let curX = 0;
      for (const b of branches) {
        // 分支内部节点暂不做泳道分流，保持原线性布局（分支体量小，全在跨泳道卡片内）
        const bNodes = layoutNodesLinearInner(b.nodes);
        const bw = Math.max(LANE_W, bNodes.w);
        const bh = bNodes.h;
        branchLayouts.push({ branch: b, x: curX, y: 0, w: bw, h: bh, nodes: bNodes.nodes });
        curX += bw + BRANCH_GAP_X;
        if (bh > maxBranchH) maxBranchH = bh;
        totalW = curX - BRANCH_GAP_X;
      }
    }
    const bodyW = Math.max(WIDE_W, totalW + BRANCH_PAD_X * 2);
    const bodyH = NODE_H_BRANCH + (collapsed ? 0 : maxBranchH + BR_LABEL_H + BRANCH_PAD_Y * 2);
    if (!collapsed && branchLayouts.length > 0) {
      const innerW = branchLayouts.reduce((s, b) => s + b.w, 0) + (branchLayouts.length - 1) * BRANCH_GAP_X;
      let curX = (bodyW - innerW) / 2;
      for (const bl of branchLayouts) {
        bl.x = curX;
        bl.y = NODE_H_BRANCH + BR_LABEL_H;
        curX += bl.w + BRANCH_GAP_X;
      }
    }
    return { node, x: 0, y: 0, w: bodyW, h: bodyH, subtreeH: bodyH, branchLayouts };
  }
  const h = node.kind === "subloop" ? NODE_H_SUBLOOP
    : node.kind === "comment" ? NODE_H_COMMENT
    : node.kind === "loopback" ? NODE_H_LOOPBACK
    : NODE_H_STEP;
  return { node, x: 0, y: 0, w: nodeWidth(node), h, subtreeH: h };
}

/** 分支内部使用的简单线性布局（不做泳道分流，居中对齐） */
function layoutNodesLinearInner(nodes: FlowNode[]): { nodes: LaidNode[]; w: number; h: number } {
  const laid: LaidNode[] = [];
  let curY = BR_LABEL_H + 4; // 留空放分支标签 pill
  let maxW = 0;
  for (const n of nodes) {
    const ln = layoutNode(n);
    ln.x = 0;
    ln.y = curY;
    laid.push(ln);
    curY += ln.h + GAP_Y;
    if (ln.w > maxW) maxW = ln.w;
  }
  for (const ln of laid) {
    if (ln.w < maxW) {
      const offset = (maxW - ln.w) / 2;
      shiftLaidNodeX(ln, offset);
      ln.w = maxW;
    }
  }
  const totalH = laid.length > 0 ? curY - GAP_Y : 0;
  return { nodes: laid, w: maxW, h: totalH };
}

/** 顶层泳道布局：按执行顺序纵向排列，横向按 markSide 分左右 */
function layoutNodesLinear(nodes: FlowNode[]): { nodes: LaidNode[]; w: number; h: number } {
  const laid: LaidNode[] = [];
  const TOP_PAD = 36; // 顶部留出泳道标签空间
  let curY = TOP_PAD;
  for (const n of nodes) {
    const ln = layoutNode(n);
    const lane = nodeLane(n);
    const cx = laneCx(lane);
    ln.x = cx - ln.w / 2;
    ln.y = curY;
    laid.push(ln);
    curY += ln.h + GAP_Y;
  }
  const totalH = laid.length > 0 ? curY - GAP_Y : 0;
  return { nodes: laid, w: FULL_W, h: totalH };
}

function shiftLaidNodeX(ln: LaidNode, dx: number) {
  ln.x += dx;
  if (ln.branchLayouts) {
    for (const b of ln.branchLayouts) {
      b.x += dx;
      for (const sub of b.nodes) shiftLaidNodeX(sub, dx);
    }
  }
}

function nodeStyle(kind: FlowNode["kind"], selected: boolean, side?: "left" | "right", wide?: boolean) {
  const base: Record<string, { fill: string; stroke: string; text: string }> = {
    step:     { fill: "#ffffff", stroke: "#cbd5e1", text: "text-slate-800" },
    subloop:  { fill: "#faf5ff", stroke: "#a78bfa", text: "text-violet-900" },
    ifelse:   { fill: "#fffbeb", stroke: "#fbbf24", text: "text-amber-900" },
    case:     { fill: "#f0f9ff", stroke: "#38bdf8", text: "text-sky-900" },
    comment:  { fill: "#f8fafc", stroke: "#cbd5e1", text: "text-slate-500" },
    loopback: { fill: "#ecfdf5", stroke: "#34d399", text: "text-emerald-800" },
  };
  const s = { ...(base[kind] || base.step) };
  // 左右泳道的步骤卡片用不同描边颜色轻微区分：左蓝右紫；跨泳道文件处理步骤用青色区分
  if (kind === "step") {
    if (wide) { s.stroke = selected ? "#6366f1" : "#2dd4bf"; s.fill = selected ? "#f0fdfa" : "#f8fafc"; }
    else if (side === "left")  { s.stroke = selected ? "#6366f1" : "#93c5fd"; s.fill = selected ? "#eff6ff" : "#ffffff"; }
    else if (side === "right") { s.stroke = selected ? "#6366f1" : "#c4b5fd"; s.fill = selected ? "#f5f3ff" : "#ffffff"; }
  }
  return { ...s, strokeWidth: 2 };
}

const CLIPBOARD_KEY = "cinside_flow_clipboard";
function writeClipboard(nodes: FlowNode[]) {
  localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(cloneNodes(nodes)));
}
function readClipboard(): FlowNode[] | null {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr as FlowNode[] : null;
  } catch { return null; }
}

interface LoopEditorProps {
  template: WorkflowTemplate;
  allTemplates: WorkflowTemplate[];
  onClose: () => void;
  onSave: (updated: WorkflowTemplate) => void;
}

export default function LoopEditor({ template, allTemplates, onClose, onSave }: LoopEditorProps) {
  const [graph, setGraph] = useState<FlowGraph>(() => ensureGraph(template));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolMode>("select");
  const [cutAnchor, setCutAnchor] = useState<InsertAnchor | null>(null);
  const [subloopPicker, setSubloopPicker] = useState<{ anchor: InsertAnchor } | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [history, setHistory] = useState<FlowGraph[]>([]);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);

  const [view, setView] = useState({ x: 40, y: 40, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 2;
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const pushHistory = useCallback((g: FlowGraph) => {
    setHistory((h) => [...h.slice(-30), graph]);
    setGraph(g);
  }, [graph]);

  const commit = useCallback((mutator: (g: FlowGraph) => void) => {
    const copy: FlowGraph = JSON.parse(JSON.stringify(graph));
    mutator(copy);
    copy.updatedAt = Date.now();
    pushHistory(copy);
  }, [graph, pushHistory]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    setGraph(history[history.length - 1]);
    setHistory(history.slice(0, -1));
  }, [history]);

  const layout = useMemo(() => layoutNodesLinear(graph.nodes), [graph]);

  // 根据InsertAnchor在g中找到插入位置（返回数组和索引）
  const resolveAnchor = useCallback((g: FlowGraph, anchor: InsertAnchor): { arr: FlowNode[]; idx: number } | null => {
    if (anchor.type === "end") {
      // 插入到loopback之前
      const lbIdx = g.nodes.findIndex((n) => n.kind === "loopback");
      return { arr: g.nodes, idx: lbIdx >= 0 ? lbIdx : g.nodes.length };
    }
    if (anchor.type === "before") {
      const loc = findNode(g.nodes, anchor.nodeId);
      if (!loc) return null;
      return { arr: loc.parent, idx: loc.index };
    }
    if (anchor.type === "after") {
      const loc = findNode(g.nodes, anchor.nodeId);
      if (!loc) return null;
      return { arr: loc.parent, idx: loc.index + 1 };
    }
    if (anchor.type === "branch-start") {
      const loc = findNode(g.nodes, anchor.parentNodeId);
      if (!loc || !loc.node.branches) return null;
      const br = loc.node.branches.find((b) => b.id === anchor.branchId);
      if (!br) return null;
      return { arr: br.nodes, idx: 0 };
    }
    return null;
  }, []);

  // 画布坐标 -> 屏幕坐标
  const canvasToScreen = useCallback((cx: number, cy: number) => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: rect.left + cx * view.scale + view.x, y: rect.top + cy * view.scale + view.y };
  }, [view]);

  // 收集所有连线（泳道路由）
  const edges = useMemo<EdgeInfo[]>(() => {
    const result: EdgeInfo[] = [];

    /** 在两个锚点之间绘制正交折线：同列走竖线+贝塞尔圆角；跨列走 L 型，经中间隔带 */
    const connectPoints = (
      prevId: string, nextId: string, anchor: InsertAnchor,
      fromX: number, fromY: number, toX: number, toY: number,
      isBranchTop = false,
    ) => {
      const dx = toX - fromX;
      let d: string;
      let midX: number, midY: number;
      if (Math.abs(dx) < 2) {
        // 同列：贝塞尔 S 曲线（与原实现一致）
        const cpY = (fromY + toY) / 2;
        d = `M${fromX},${fromY} C${fromX},${cpY} ${toX},${cpY} ${toX},${toY}`;
        midX = fromX;
        midY = cpY;
      } else {
        // 跨列：L 型路径，拐点取中线
        const turnY = fromY + Math.min((toY - fromY) * 0.5, GAP_Y * 0.7);
        const midLaneX = MID_CX;
        d = `M${fromX},${fromY} L${fromX},${turnY} L${midLaneX},${turnY} L${midLaneX},${toY - 10} C${midLaneX},${toY} ${toX},${toY} ${toX},${toY}`;
        midX = midLaneX;
        midY = turnY;
      }
      result.push({
        id: isBranchTop ? `${prevId}-brtop-${nextId}` : `e-${prevId}-${nextId}`,
        anchor,
        pathD: d,
        midX, midY,
      });
    };

    const collectLinear = (lns: LaidNode[], parentPrefix: string, offX: number, offY: number) => {
      for (let i = 0; i < lns.length; i++) {
        const ln = lns[i];
        const myCx = offX + ln.x + ln.w / 2;
        const myTopY = offY + ln.y;
        const myBotY = offY + ln.y + ln.h;
        const myLane = nodeLane(ln.node);
        // 顶部/底部锚点：step 从卡片顶部/底部中点出线；宽节点从中线（MID_CX）出线
        const myTopX = myLane === "center" ? offX + MID_CX : myCx;
        const myBotX = myLane === "center" ? offX + MID_CX : myCx;

        if (i > 0) {
          const prev = lns[i - 1];
          const prevLane = nodeLane(prev.node);
          const prevCx = offX + prev.x + prev.w / 2;
          const prevBotX = prevLane === "center" ? offX + MID_CX : prevCx;
          const prevBotY = offY + prev.y + prev.h;
          connectPoints(prev.node.id, ln.node.id, { type: "before", nodeId: ln.node.id },
            prevBotX, prevBotY, myTopX, myTopY);
        }

        // 分支：从分支父节点底部中点引出，到各分支顶部
        if ((ln.node.kind === "ifelse" || ln.node.kind === "case") && ln.branchLayouts && !ln.node.collapsed) {
          for (const bl of ln.branchLayouts) {
            const brTopX = offX + ln.x + bl.x + bl.w / 2;
            const brTopY = offY + ln.y + bl.y;
            const dTop = `M${myBotX},${myBotY} L${myBotX},${myBotY + 8} L${brTopX},${myBotY + 8} L${brTopX},${brTopY}`;
            result.push({
              id: `${parentPrefix}brtop-${ln.node.id}-${bl.branch.id}`,
              anchor: { type: "branch-start", parentNodeId: ln.node.id, branchId: bl.branch.id },
              pathD: dTop,
              midX: (myBotX + brTopX) / 2,
              midY: (myBotY + brTopY) / 2,
            });
            collectLinear(bl.nodes, `${parentPrefix}ie-`, offX + ln.x + bl.x, offY + ln.y + bl.y);
          }
        }
      }
    };

    collectLinear(layout.nodes, "e-", 0, 0);

    // 闭环线：从最后一个节点 → 走中线回顶部 → 第一个节点顶部
    if (layout.nodes.length > 0) {
      const last = layout.nodes[layout.nodes.length - 1];
      const lastLane = nodeLane(last.node);
      const lastCx = last.x + last.w / 2;
      const lastBotX = lastLane === "center" ? MID_CX : lastCx;
      const lastBotY = last.y + last.h;
      const first = layout.nodes[0];
      const firstLane = nodeLane(first.node);
      const firstCx = first.x + first.w / 2;
      const firstTopX = firstLane === "center" ? MID_CX : firstCx;
      const firstTopY = first.y;
      const topY = -4;
      // 从最后节点底部 → 中线 → 顶部横线 → 第一个节点顶部
      const d = `M${lastBotX},${lastBotY} L${MID_CX},${lastBotY} L${MID_CX},${topY} L${firstTopX},${topY} L${firstTopX},${firstTopY}`;
      result.push({
        id: "loopback",
        anchor: { type: "end" },
        pathD: d,
        midX: MID_CX,
        midY: (lastBotY + topY) / 2,
        isLoopback: true,
      });
    }

    return result;
  }, [layout]);

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    setView((v) => {
      const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * delta));
      const r = ns / v.scale;
      return { scale: ns, x: mx - (mx - v.x) * r, y: my - (my - v.y) * r };
    });
  }, []);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    // 如果在交互模式（非select）或有剪断点，点击连线时不启动平移
    if ((tool !== "select" || cutAnchor) && t.getAttribute("data-edge-hit")) return;
    if (t.closest("[data-node-click]") || t.closest("button") || t.closest("input") || t.closest("foreignObject")) return;
    if (e.button !== 0) return;
    if (tool === "select" && !cutAnchor) {
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    }
  }, [tool, cutAnchor]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    setView((v) => ({ ...v, x: panStart.current.vx + e.clientX - panStart.current.x, y: panStart.current.vy + e.clientY - panStart.current.y }));
  }, []);

  const handleCanvasMouseUp = useCallback(() => { isPanning.current = false; }, []);

  const zoomBy = useCallback((factor: number) => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = rect.width / 2, my = rect.height / 2;
    setView((v) => {
      const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      const r = ns / v.scale;
      return { scale: ns, x: mx - (mx - v.x) * r, y: my - (my - v.y) * r };
    });
  }, []);

  const resetView = useCallback(() => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (rect) {
      // 将画布水平+垂直居中在容器内
      setView({
        x: rect.width / 2 - FULL_W / 2,
        y: Math.max(20, rect.height / 2 - layout.h / 2),
        scale: 1,
      });
    } else {
      setView({ x: 40, y: 40, scale: 1 });
    }
  }, [layout.h]);

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  // 初次挂载时自动居中画布
  const centeredRef = useRef(false);
  useEffect(() => {
    if (centeredRef.current) return;
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect || layout.h === 0) return;
    setView({
      x: rect.width / 2 - FULL_W / 2,
      y: Math.max(20, rect.height / 2 - layout.h / 2),
      scale: 1,
    });
    centeredRef.current = true;
  }, [layout.h]);

  const selectedLoc = selectedId ? findNode(graph.nodes, selectedId) : null;

  useEffect(() => {
    if (selectedId) return;
    const first = graph.nodes.find((n) => n.kind !== "loopback");
    if (first) setSelectedId(first.id);
  }, []); // eslint-disable-line

  // 插入节点
  const insertNode = useCallback((node: FlowNode, anchor: InsertAnchor) => {
    commit((g) => {
      const pos = resolveAnchor(g, anchor);
      if (!pos) return;
      pos.arr.splice(pos.idx, 0, node);
    });
    setSelectedId(node.id);
    setTool("select");
    setCutAnchor(null);
    setSubloopPicker(null);
  }, [commit, resolveAnchor]);

  // 连线点击
  const handleEdgeClick = useCallback((edge: EdgeInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    if (edge.isLoopback) return;

    // 剪刀工具：剪断连线，记住断点位置
    if (tool === "cut") {
      setCutAnchor(edge.anchor);
      setTool("select");
      return;
    }

    // 如果有剪断点，优先在剪断点插入
    const anchor = cutAnchor || edge.anchor;

    if (tool === "select") {
      // 选择模式下点击连线，如果有剪断点则清除
      if (cutAnchor) setCutAnchor(null);
      return;
    }

    if (tool === "subloop") {
      setSubloopPicker({ anchor });
    } else {
      const node =
        tool === "ifelse" ? makeIfElse() :
        tool === "case" ? makeCase("", ["case1", "else"]) :
        makeComment("在此添加注释...");
      insertNode(node, anchor);
      setCutAnchor(null);
    }
  }, [tool, insertNode, cutAnchor]);

  // 节点+号点击：使用当前选中的工具插入，或默认弹出子LOOP选择（如果在cut模式）
  const openInsertAfterNode = useCallback((nodeId: string, canvasX: number, canvasY: number) => {
    const anchor: InsertAnchor = { type: "after", nodeId };
    const activeAnchor = cutAnchor || anchor;
    if (tool === "subloop" || cutAnchor) {
      setSubloopPicker({ anchor: activeAnchor });
    } else if (tool === "ifelse") {
      insertNode(makeIfElse(), activeAnchor);
      setCutAnchor(null);
    } else if (tool === "case") {
      insertNode(makeCase("", ["case1", "else"]), activeAnchor);
      setCutAnchor(null);
    } else if (tool === "comment") {
      insertNode(makeComment("在此添加注释..."), activeAnchor);
      setCutAnchor(null);
    } else {
      // 选择模式下点击+号，默认插入子LOOP选择器？不，直接弹出子LOOP选择
      setSubloopPicker({ anchor: activeAnchor });
    }
  }, [tool, insertNode, cutAnchor]);

  // 空分支"添加步骤"点击
  const openInsertBranchStart = useCallback((parentNodeId: string, branchId: string, canvasX: number, canvasY: number) => {
    const anchor: InsertAnchor = { type: "branch-start", parentNodeId, branchId };
    const activeAnchor = cutAnchor || anchor;
    if (tool === "subloop" || tool === "select" || cutAnchor) {
      setSubloopPicker({ anchor: activeAnchor });
    } else if (tool === "ifelse") {
      insertNode(makeIfElse(), activeAnchor);
      setCutAnchor(null);
    } else if (tool === "case") {
      insertNode(makeCase("", ["case1", "else"]), activeAnchor);
      setCutAnchor(null);
    } else if (tool === "comment") {
      insertNode(makeComment("在此添加注释..."), activeAnchor);
      setCutAnchor(null);
    }
  }, [tool, insertNode, cutAnchor]);

  const doInsertSubloop = (tpl: WorkflowTemplate) => {
    if (!subloopPicker) return;
    insertNode(makeSubloop(tpl.id, tpl.name, 1), subloopPicker.anchor);
  };

  const handleDelete = () => {
    if (!selectedId) return;
    commit((g) => {
      const loc = findNode(g.nodes, selectedId);
      if (!loc || loc.node.kind === "loopback") return;
      loc.parent.splice(loc.index, 1);
    });
    setSelectedId(null);
  };

  const handleCopy = () => {
    if (!selectedId) return;
    const loc = findNode(graph.nodes, selectedId);
    if (loc) writeClipboard([JSON.parse(JSON.stringify(loc.node))]);
  };

  const handlePaste = () => {
    if (!selectedId) return;
    const clip = readClipboard();
    if (!clip || clip.length === 0) return;
    const pasted = cloneNodes(clip);
    commit((g) => {
      const loc = findNode(g.nodes, selectedId);
      if (!loc) return;
      loc.parent.splice(loc.index + 1, 0, ...pasted);
    });
    if (pasted[0]) setSelectedId(pasted[0].id);
  };

  const handleToggleCollapse = (id: string) => {
    commit((g) => {
      const loc = findNode(g.nodes, id);
      if (loc && (loc.node.kind === "ifelse" || loc.node.kind === "case")) loc.node.collapsed = !loc.node.collapsed;
    });
  };

  /** 循环切换选中节点的断点：无 → 强制 → 条件 → 无 */
  const handleCycleBreakpoint = useCallback(() => {
    if (!selectedId) return;
    commit((g) => {
      const loc = findNode(g.nodes, selectedId);
      if (!loc || loc.node.kind !== "step") return;
      const cur = loc.node.breakpoint;
      loc.node.breakpoint = cur === undefined ? "always" : cur === "always" ? "on-error" : undefined;
    });
  }, [selectedId, commit]);

  const handleAddCaseBranch = () => {
    if (!selectedId) return;
    commit((g) => {
      const loc = findNode(g.nodes, selectedId);
      if (loc && loc.node.kind === "case") addCaseBranch(loc.node, `case${(loc.node.branches?.length || 0) + 1}`);
    });
  };

  const handleRemoveBranch = (branchId: string) => {
    if (!selectedId) return;
    commit((g) => {
      const loc = findNode(g.nodes, selectedId);
      if (loc && loc.node.branches) removeBranch(loc.node, branchId);
    });
  };

  const handleLabelChange = (id: string, label: string) => {
    commit((g) => {
      const loc = findNode(g.nodes, id);
      if (loc) {
        loc.node.label = label;
        if (loc.node.kind === "comment") loc.node.note = label.replace(/^💬\s*/, "");
        if (loc.node.kind === "ifelse") loc.node.branches?.forEach((b, i) => {
          if (i === 0) b.condition = label.replace(/^❓\s*(IF\s*)?/i, "");
        });
      }
    });
  };

  const handleSave = () => {
    // 同步流程图断点到 PickedMark：遍历所有 step 节点，按 markId 写回 breakpoint
    const bpMap = new Map<string, "always" | "on-error" | undefined>();
    const collectBp = (nodes: FlowNode[]) => {
      for (const n of nodes) {
        if (n.kind === "step" && n.markId) bpMap.set(n.markId, n.breakpoint);
        if (n.branches) for (const b of n.branches) collectBp(b.nodes);
      }
    };
    collectBp(graph.nodes);

    const syncMark = (m: { id: string; breakpoint?: "always" | "on-error" }) => {
      if (bpMap.has(m.id)) m.breakpoint = bpMap.get(m.id);
    };
    const tpl: WorkflowTemplate = JSON.parse(JSON.stringify(template));
    tpl.dataSourceMarks?.forEach(syncMark);
    tpl.reviewMarks?.forEach(syncMark);
    tpl.entryMarks?.forEach(syncMark);

    const updated: WorkflowTemplate = { ...tpl, flowGraph: graph, updatedAt: Date.now() };
    saveSkill(updated);
    onSave(updated);
    onClose();
  };

  useEffect(() => {
    (window as any).__cinsideFlowEditorOpen = true;
    const pz = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    window.addEventListener("wheel", pz, { passive: false, capture: true });
    const pkz = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "-" || e.key === "0" || e.key === "+")) e.preventDefault();
    };
    window.addEventListener("keydown", pkz);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // 根治 BrowserView 穿模：打开编辑器时通知主进程彻底移除所有原生 BrowserView
    window.electronAPI?.modalOverlayEnter().catch(() => {});

    return () => {
      (window as any).__cinsideFlowEditorOpen = false;
      window.removeEventListener("wheel", pz, { capture: true } as any);
      window.removeEventListener("keydown", pkz);
      document.body.style.overflow = prev;
      // 关闭编辑器时恢复 BrowserView
      window.electronAPI?.modalOverlayExit().catch(() => {});
      // 触发一次 resize，让 BrowserPane 的 ResizeObserver/IntersectionObserver 重新 sync 显示
      setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
      setTimeout(() => window.dispatchEvent(new Event("resize")), 250);
    };
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingLabel) return;
      const inInput = !!(e.target as HTMLElement)?.closest("input");
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId && tool === "select") { e.preventDefault(); handleDelete(); }
      } else if (e.key === "Escape") {
        setSelectedId(null); setCutAnchor(null); setSubloopPicker(null); setRangeStart(null); setTool("select");
      } else if ((e.ctrlKey || e.metaKey) && e.key === "c") { handleCopy();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "v") { if (selectedId) handlePaste();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo();
      } else if (!inInput && e.key === "v") { setTool("select");
      } else if (!inInput && e.key === "x") { setTool("cut");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [selectedId, editingLabel, tool, cutAnchor]);

  const cursorClass = (tool === "select" && !cutAnchor) ? (isPanning.current ? "cursor-grabbing" : "cursor-grab") : "cursor-crosshair";
  const toolBtn = (active: boolean) =>
    `flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-all ${
      active ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
    }`;

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col bg-white" onClick={() => { setCutAnchor(null); setSubloopPicker(null); }} style={{ transform: "translateZ(0)" }}>
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 shadow-sm">
        <GitBranch className="h-4 w-4 text-indigo-600" />
        <span className="text-sm font-semibold text-slate-800">流程图编辑</span>
        <span className="text-[11px] text-slate-400">· {template.name} · {countNodes(graph.nodes)} 个节点</span>
        <div className="mx-2 h-5 w-px bg-slate-200" />

        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
          <button onClick={() => { setTool("select"); setCutAnchor(null); }} className={toolBtn(tool === "select" && !cutAnchor)} title="选择/平移 (V)"><MousePointer2 className="h-3.5 w-3.5" /> 选择</button>
          <button onClick={() => { if (tool === "subloop" && !cutAnchor) { setTool("select"); setCutAnchor(null); } else { setTool("subloop"); } }} className={toolBtn(tool === "subloop" && !cutAnchor)} title="插入子LOOP"><Repeat className="h-3.5 w-3.5" /> 子LOOP</button>
          <button onClick={() => { if (tool === "ifelse" && !cutAnchor) { setTool("select"); setCutAnchor(null); } else { setTool("ifelse"); } }} className={toolBtn(tool === "ifelse" && !cutAnchor)} title="插入IF/ELSE"><GitBranch className="h-3.5 w-3.5" /> IF/ELSE</button>
          <button onClick={() => { if (tool === "case" && !cutAnchor) { setTool("select"); setCutAnchor(null); } else { setTool("case"); } }} className={toolBtn(tool === "case" && !cutAnchor)} title="插入CASE"><Split className="h-3.5 w-3.5" /> CASE</button>
          <button onClick={() => { if (tool === "comment" && !cutAnchor) { setTool("select"); setCutAnchor(null); } else { setTool("comment"); } }} className={toolBtn(tool === "comment" && !cutAnchor)} title="插入注释"><MessageSquare className="h-3.5 w-3.5" /> 注释</button>
          <button onClick={() => { if (tool === "cut") { setTool("select"); } else { setTool("cut"); setCutAnchor(null); } }} className={cutAnchor ? "flex h-8 items-center gap-1 rounded-md bg-rose-500 px-2 text-[11px] font-medium text-white shadow-sm" : toolBtn(tool === "cut")} title="剪断连线 (X)"><Scissors className="h-3.5 w-3.5" /> 剪断{cutAnchor && " ✓"}</button>
        </div>

        <div className="mx-2 h-5 w-px bg-slate-200" />

        <button onClick={undo} disabled={history.length === 0}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"><RotateCcw className="h-3.5 w-3.5" /> 撤销</button>
        <button onClick={handleCopy} disabled={!selectedId}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"><Copy className="h-3.5 w-3.5" /> 复制</button>
        <button onClick={handlePaste} disabled={!selectedId || !readClipboard()}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"><Clipboard className="h-3.5 w-3.5" /> 粘贴</button>
        <button onClick={handleDelete} disabled={!selectedId || selectedLoc?.node.kind === "loopback"}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /> 删除</button>
        {selectedLoc?.node.kind === "step" && (
          <button onClick={handleCycleBreakpoint} title="循环切换断点：无→强制→条件→无"
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${
              selectedLoc.node.breakpoint === "always"
                ? "bg-rose-100 text-rose-700 hover:bg-rose-200"
                : selectedLoc.node.breakpoint === "on-error"
                ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                : "text-slate-600 hover:bg-slate-100"
            }`}>
            {selectedLoc.node.breakpoint === "on-error" ? <AlertOctagon className="h-3.5 w-3.5" /> : <CirclePause className="h-3.5 w-3.5" />}
            {selectedLoc.node.breakpoint === "always" ? "强制断点" : selectedLoc.node.breakpoint === "on-error" ? "条件断点" : "断点"}
          </button>
        )}
        {selectedLoc?.node.kind === "case" && (
          <button onClick={handleAddCaseBranch} className="flex items-center gap-1 rounded-md bg-sky-100 px-2 py-1 text-[11px] text-sky-700 hover:bg-sky-200"><Plus className="h-3.5 w-3.5" /> 增加分支</button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { if (!confirm("重置流程图？")) return; setGraph(buildLinearGraph(template)); setHistory([]); setSelectedId(null); setTool("select"); }}
            className="rounded-md px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">重置为线性</button>
          <button onClick={onClose} className="rounded-md px-3 py-1 text-[11px] text-slate-600 hover:bg-slate-100">取消</button>
          <button onClick={handleSave} className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-700"><Save className="h-3.5 w-3.5" /> 保存</button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white/60 px-4 py-1.5 text-[10px] text-slate-500">
        {cutAnchor ? (
          <span className="font-medium text-rose-600">✂️ 已剪断连线，选择工具点击放置新模块 · Esc取消断点</span>
        ) : tool === "select" ? (
          <>
            <span>💡 点击节点选中 · 节点下方<Plus className="inline h-3 w-3"/>插入</span>
            <span>· Shift+点击选段 · 双击编辑 · 拖拽平移 · Ctrl滚轮缩放</span>
          </>
        ) : tool === "cut" ? (
          <span className="font-medium text-rose-600">✂️ 剪刀模式：点击连线剪断</span>
        ) : (
          <span className="font-medium text-indigo-600">
            📍 点击连线放置{tool === "subloop" ? "子LOOP" : tool === "ifelse" ? "IF/ELSE分支" : tool === "case" ? "CASE多分支" : "注释"} · Esc取消
          </span>
        )}
        <span className="ml-auto text-indigo-600">CLI: backend/app/services/loop_editor.py</span>
      </div>

      <div ref={canvasContainerRef}
        className={`relative flex-1 overflow-hidden ${cursorClass} bg-slate-100 select-none`}
        style={{
          backgroundImage: "radial-gradient(circle, #cbd5e1 1px, transparent 1px)",
          backgroundSize: "20px 20px",
          backgroundColor: "#f1f5f9",
          contain: "paint",
          isolation: "isolate",
        }}
        onWheel={handleWheel}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleCanvasMouseMove}
        onMouseUp={handleCanvasMouseUp}
        onMouseLeave={handleCanvasMouseUp}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (e.target === e.currentTarget || t.tagName === "svg" || (t.tagName === "rect" && t.getAttribute("data-bg") === "1")) {
            setSelectedId(null); setRangeStart(null); setCutAnchor(null);
            if (tool !== "select") setTool("select");
          }
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="absolute right-3 bottom-3 z-10 flex flex-col gap-1 rounded-lg bg-white/90 p-1 shadow-md ring-1 ring-slate-200 backdrop-blur">
          <button onClick={() => zoomBy(1.2)} className="flex h-7 w-7 items-center justify-center rounded text-slate-600 hover:bg-slate-100"><ZoomIn className="h-4 w-4" /></button>
          <button onClick={() => zoomBy(1/1.2)} className="flex h-7 w-7 items-center justify-center rounded text-slate-600 hover:bg-slate-100"><ZoomOut className="h-4 w-4" /></button>
          <button onClick={resetView} className="flex h-7 w-7 items-center justify-center rounded text-[10px] font-bold text-slate-500 hover:bg-slate-100">{Math.round(view.scale * 100)}%</button>
        </div>
        <div className="absolute left-3 bottom-3 z-10 rounded bg-white/70 px-2 py-1 text-[10px] text-slate-400 backdrop-blur">
          {cutAnchor ? "选择工具点击任意连线/位置放置" : tool === "select" ? "拖拽平移 · Ctrl+滚轮缩放" : "点击连线放置 · Esc取消"}
        </div>

        <svg className="absolute inset-0 h-full w-full">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" /></marker>
            <marker id="arrow-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#10b981" /></marker>
            <marker id="arrow-indigo" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4f46e5" /></marker>
          </defs>
          <rect x={-100000} y={-100000} width={200000} height={200000} fill="transparent" data-bg="1" />
          <g transform={`translate(${view.x}, ${view.y}) scale(${view.scale})`}>
            <LaneBackdrop layoutW={layout.w} layoutH={layout.h} />
            <GhostCardsLayer nodes={layout.nodes} />
            <ConnectionsLayer edges={edges} tool={tool} hoverEdgeId={hoverEdgeId} cutAnchor={cutAnchor} onEdgeHover={setHoverEdgeId} onEdgeClick={handleEdgeClick} />
            {cutAnchor && <CutPointMarker edges={edges} cutAnchor={cutAnchor} />}
            <g>
              {layout.nodes.map((ln) => (
                <LaidNodeView key={ln.node.id} ln={ln} selectedId={selectedId} rangeStart={rangeStart} editingLabel={editingLabel}
                  onSelect={(id, add) => {
                    if (tool !== "select") setTool("select");
                    if (add && selectedId) { setRangeStart(selectedId); setSelectedId(id); }
                    else { setSelectedId(id); if (!add) setRangeStart(null); }
                  }}
                  onEditLabel={setEditingLabel}
                  onCommitLabel={handleLabelChange}
                  onToggleCollapse={handleToggleCollapse}
                  onRemoveBranch={handleRemoveBranch}
                  onSelectBranchNode={(id) => { setTool("select"); setSelectedId(id); }}
                  onOpenInsertAfter={openInsertAfterNode}
                  onOpenInsertBranchStart={openInsertBranchStart}
                />
              ))}
            </g>
          </g>
        </svg>
      </div>

      {subloopPicker && (
        <SubloopPicker templates={allTemplates.filter((t) => t.id !== template.id)}
          onPick={doInsertSubloop}
          onClose={() => setSubloopPicker(null)}
        />
      )}
    </div>
  );
}

// ========== 泳道背景层 ==========
function LaneBackdrop({ layoutW, layoutH }: { layoutW: number; layoutH: number }) {
  const pad = 20;
  const totalH = layoutH + pad;
  return (
    <g>
      {/* 左侧泳道背景 */}
      <rect x={0} y={0} width={LANE_W} height={totalH} fill="#f0f7ff" opacity={0.5} />
      {/* 中间隔带 */}
      <rect x={LANE_W} y={0} width={GUTTER} height={totalH} fill="#fafafa" opacity={0.5} />
      {/* 右侧泳道背景 */}
      <rect x={LANE_W + GUTTER} y={0} width={LANE_W} height={totalH} fill="#faf5ff" opacity={0.5} />
      {/* 中间虚线分界 */}
      <line x1={MID_CX} y1={0} x2={MID_CX} y2={totalH} stroke="#d1d5db" strokeWidth={1} strokeDasharray="4 4" />
      {/* 泳道标签 */}
      <text x={LEFT_CX} y={18} textAnchor="middle" className="fill-sky-500 text-[13px] font-bold">左网页</text>
      <text x={RIGHT_CX} y={18} textAnchor="middle" className="fill-violet-500 text-[13px] font-bold">执行操作</text>
    </g>
  );
}

// ========== 数据来源残影卡片层 ==========
interface GhostEntry {
  realX: number; realY: number; realW: number; realH: number;
  ghostX: number; ghostY: number; ghostW: number; ghostH: number;
  sourceText: string;
}

function walkNodesForGhosts(lns: LaidNode[], offX: number, offY: number, out: GhostEntry[]) {
  for (const ln of lns) {
    if (ln.node.kind === "step") {
      const lane = nodeLane(ln.node);
      const parsed = splitStepLabel(ln.node.label || "");
      const needsGhost =
        (lane === "right" && parsed.sourceSide === "left") ||
        (lane === "left" && parsed.sourceSide === "right");
      if (needsGhost && parsed.sourceText) {
        const realLane = lane;
        const ghostLane = realLane === "right" ? "left" : "right";
        const ghostCx = laneCx(ghostLane as "left" | "right");
        const realX = offX + ln.x;
        const realY = offY + ln.y;
        const ghostX = offX + ghostCx - LANE_W / 2;
        const ghostY = realY;
        out.push({
          realX, realY, realW: ln.w, realH: ln.h,
          ghostX, ghostY, ghostW: LANE_W, ghostH: ln.h,
          sourceText: parsed.sourceText,
        });
      }
    }
    // 注意：分支内部节点不做泳道分流（布局居中），此处不递归绘制残影以避免错位
  }
}

function GhostCardsLayer({ nodes }: { nodes: LaidNode[] }) {
  const ghosts: GhostEntry[] = [];
  walkNodesForGhosts(nodes, 0, 0, ghosts);
  if (ghosts.length === 0) return null;
  return (
    <g>
      {ghosts.map((g, i) => {
        // 残影的右中 / 实卡的左中
        const gRightX = g.ghostX + g.ghostW;
        const gMidY = g.ghostY + g.ghostH / 2;
        const rLeftX = g.realX;
        const rMidY = g.realY + g.realH / 2;
        // S 型虚线穿过隔带
        const cpOff = Math.min(Math.abs(rMidY - gMidY) * 0.4 + 20, GUTTER * 0.6);
        const pathD = `M${gRightX},${gMidY} C${gRightX + cpOff},${gMidY} ${rLeftX - cpOff},${rMidY} ${rLeftX},${rMidY}`;
        return (
          <g key={i} style={{ pointerEvents: "none" }}>
            {/* 数据流虚线 */}
            <path d={pathD} stroke="#93c5fd" strokeWidth={1.5} strokeDasharray="4 3" fill="none" opacity={0.7} />
            {/* 数据流动小圆点动画 */}
            <circle r={3} fill="#60a5fa" opacity={0.85}>
              <animateMotion dur={`${1.8 + i * 0.15}s`} repeatCount="indefinite" path={pathD} />
            </circle>
            {/* 残影卡片 */}
            <rect x={g.ghostX} y={g.ghostY} width={g.ghostW} height={g.ghostH} rx={10}
              fill="#eff6ff" fillOpacity={0.55} stroke="#93c5fd" strokeWidth={1.5} strokeDasharray="5 3" />
            {/* 残影标签：📤 取值 · 来源文字 */}
            <foreignObject x={g.ghostX + 8} y={g.ghostY + 4} width={g.ghostW - 16} height={g.ghostH - 8}>
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center">
                <span className="w-full truncate text-[12px] font-medium leading-tight text-sky-600">📤 取值来源</span>
                <span className="w-full truncate text-[10px] leading-tight text-sky-500/70" title={g.sourceText}>{g.sourceText}</span>
              </div>
            </foreignObject>
          </g>
        );
      })}
    </g>
  );
}

// ========== 连线层 ==========
function ConnectionsLayer({
  edges, tool, hoverEdgeId, cutAnchor, onEdgeHover, onEdgeClick,
}: {
  edges: EdgeInfo[];
  tool: ToolMode;
  hoverEdgeId: string | null;
  cutAnchor: InsertAnchor | null;
  onEdgeHover: (id: string | null) => void;
  onEdgeClick: (edge: EdgeInfo, e: React.MouseEvent) => void;
}) {
  const interactive = tool !== "select" || !!cutAnchor;
  return (
    <g>
      {edges.map((edge) => {
        const hover = hoverEdgeId === edge.id;
        const isCut = cutAnchor && !edge.isLoopback && anchorEquals(edge.anchor, cutAnchor);
        const canInsert = !edge.isLoopback;
        const highlight = (interactive && hover && canInsert) || isCut;
        const color = edge.isLoopback ? "#10b981" : isCut ? "#f43f5e" : "#94a3b8";
        const w = edge.isLoopback ? 2.5 : isCut ? 3 : 2;
        return (
          <g key={edge.id}>
            <path d={edge.pathD}
              stroke={highlight ? (isCut ? "#f43f5e" : "#4f46e5") : color}
              strokeWidth={highlight ? w + 1 : w}
              strokeDasharray={edge.isLoopback ? "6 4" : (isCut ? "8 4" : undefined)}
              fill="none"
              markerEnd={edge.isLoopback ? "url(#arrow-green)" : (isCut ? "none" : (highlight ? "url(#arrow-indigo)" : "url(#arrow)"))}
              style={{ transition: "stroke 0.15s, stroke-width 0.15s", opacity: isCut ? 0.7 : 1 }}
            />
            {interactive && canInsert && (
              <path d={edge.pathD} stroke="transparent" strokeWidth={isCut ? 28 : 24} fill="none" data-edge-hit="1" style={{ cursor: "crosshair" }}
                onMouseEnter={() => onEdgeHover(edge.id)}
                onMouseLeave={() => onEdgeHover(null)}
                onClick={(e) => onEdgeClick(edge, e)}
              />
            )}
            {highlight && !isCut && (
              <g transform={`translate(${edge.midX}, ${edge.midY})`} style={{ pointerEvents: "none" }}>
                <circle r={6} className="fill-indigo-500" />
                {tool !== "cut" && <Plus className="h-3 w-3 text-white" style={{ transform: "translate(-6px, -6px)" }} />}
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ========== 剪断点标记 ==========
function CutPointMarker({ edges, cutAnchor }: { edges: EdgeInfo[]; cutAnchor: InsertAnchor }) {
  const edge = edges.find((e) => !e.isLoopback && anchorEquals(e.anchor, cutAnchor));
  if (!edge) return null;
  const { midX, midY } = edge;
  return (
    <g transform={`translate(${midX}, ${midY})`} style={{ pointerEvents: "none" }}>
      <circle r={14} fill="#f43f5e" opacity={0.15}>
        <animate attributeName="r" values="14;18;14" dur="1.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.15;0.05;0.15" dur="1.2s" repeatCount="indefinite" />
      </circle>
      <circle r={10} fill="#fff" stroke="#f43f5e" strokeWidth={2} />
      <Scissors className="h-4 w-4 text-rose-500" style={{ transform: "translate(-8px, -8px)" }} />
    </g>
  );
}

// ========== 步骤标签拆分 ==========

/** 将步骤节点的超长 label 拆成「主描述 + 来源信息」，用于卡片两行展示。
 *  匹配尾部「... ← 来源「选择器」」格式，例如：
 *  ⌨️ 输入: 录入 · 请输入姓名 ← 左网页「div.media-body > ...」
 *  其他格式（无 ←/「」）则原样返回，仅显示一行。 */
function splitStepLabel(label: string): { main: string; sub: string; sourceSide?: "left" | "right" | "excel" | "other"; sourceText?: string } {
  if (!label) return { main: label, sub: "" };
  const m = label.match(/^(.*)←\s*([^「]+)「([^」]*)」\s*$/);
  if (m) {
    const source = m[2].trim();
    const sel = m[3].trim();
    const sub = sel ? `${source}「${sel}」` : "";
    let sourceSide: "left" | "right" | "excel" | "other" = "other";
    if (/左网页/.test(source)) sourceSide = "left";
    else if (/右网页/.test(source)) sourceSide = "right";
    else if (/Excel|Excel|表格|固定值/.test(source)) sourceSide = "excel";
    return { main: m[1].trim(), sub, sourceSide, sourceText: sel };
  }
  return { main: label, sub: "" };
}

/** 步骤节点卡片：主描述一行 + 选择器明细一行（超长省略，悬停看全文） */
function StepLabel({ label }: { label: string }) {
  const { main, sub } = splitStepLabel(label);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center" title={label}>
      <span className="w-full truncate text-[13px] font-semibold leading-tight text-slate-800">{main}</span>
      {sub && <span className="w-full truncate text-[11px] leading-tight text-slate-400">{sub}</span>}
    </div>
  );
}

// ========== 节点下方的「+」插入按钮 ==========

/** 节点下方小加号：默认是连线上的小灰点，悬停时展开为小蓝圆 + 白色加号，不破坏连线视觉 */
function InsertPlusBtn({ cx, cy, onClick }: { cx: number; cy: number; onClick: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <g
      transform={`translate(${cx}, ${cy})`}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="cursor-pointer"
      style={{ pointerEvents: "all" }}
    >
      {/* 大号透明命中区 */}
      <circle r={16} fill="transparent" />
      {/* 默认：灰色小点（连线上的连接点） */}
      {!hover && <circle r={3} fill="#cbd5e1" />}
      {/* 悬停：小蓝圆 + 白加号 */}
      {hover && (
        <g style={{ pointerEvents: "none" }}>
          <circle r={10} className="fill-indigo-500" style={{ filter: "drop-shadow(0 1px 3px rgba(79,70,229,0.4))" }} />
          <Plus className="h-4 w-4 -translate-x-[8px] -translate-y-[8px] text-white" />
        </g>
      )}
    </g>
  );
}

// ========== 节点渲染 ==========
function LaidNodeView(props: {
  ln: LaidNode;
  selectedId: string | null;
  rangeStart: string | null;
  editingLabel: string | null;
  onSelect: (id: string, addMode: boolean) => void;
  onEditLabel: (id: string | null) => void;
  onCommitLabel: (id: string, label: string) => void;
  onToggleCollapse: (id: string) => void;
  onRemoveBranch: (branchId: string) => void;
  onSelectBranchNode: (id: string) => void;
  onOpenInsertAfter: (nodeId: string, canvasX: number, canvasY: number) => void;
  onOpenInsertBranchStart: (parentNodeId: string, branchId: string, canvasX: number, canvasY: number) => void;
}) {
  const { ln, selectedId, rangeStart, editingLabel } = props;
  const { node, x, y, w, h } = ln;
  const selected = selectedId === node.id;
  const inRange = rangeStart && selectedId && rangeStart !== selectedId && (rangeStart === node.id || selectedId === node.id);
  const side = node.kind === "step" ? (node.markSide || "left") : undefined;
  const sty = nodeStyle(node.kind, selected, side, node.wide);
  const isEditing = editingLabel === node.id;
  const isBranch = node.kind === "ifelse" || node.kind === "case";
  const isWide = node.kind !== "step" || !!node.wide;

  const strokeDash = node.kind === "comment" || node.kind === "loopback" ? "6 3" : undefined;
  let shape: JSX.Element;
  if (isBranch) {
    const cx = w / 2, cy = NODE_H_BRANCH / 2;
    const rx = Math.min(w / 2 - 10, 160), ry = NODE_H_BRANCH / 2 - 4;
    shape = <polygon points={`${cx},${cy-ry} ${cx+rx},${cy} ${cx},${cy+ry} ${cx-rx},${cy}`} fill={sty.fill} stroke={sty.stroke} strokeWidth={sty.strokeWidth} strokeDasharray={strokeDash}
      style={{ filter: selected ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))" : "drop-shadow(0 1px 2px rgba(0,0,0,0.08))" }} />;
  } else if (node.kind === "loopback") {
    shape = <rect x={0} y={0} width={w} height={h} rx={h/2} fill={sty.fill} stroke={sty.stroke} strokeWidth={sty.strokeWidth} strokeDasharray={strokeDash}
      style={{ filter: selected ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))" : "drop-shadow(0 1px 2px rgba(0,0,0,0.08))" }} />;
  } else {
    const rr = node.kind === "comment" ? 8 : 10;
    const sw = node.kind === "comment" ? 1 : sty.strokeWidth;
    shape = <rect x={0} y={0} width={w} height={h} rx={rr} fill={sty.fill} stroke={sty.stroke} strokeWidth={sw} strokeDasharray={strokeDash}
      style={{ filter: selected ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))" : "drop-shadow(0 1px 2px rgba(0,0,0,0.08))" }} />;
  }

  const labelText = node.label || node.kind;
  const textPad = isWide ? 20 : 10;
  const textW = w - textPad * 2;
  const textX = textPad;
  const textY = isBranch ? 0 : 6;
  const textH = isBranch ? NODE_H_BRANCH : h - 12;

  return (
    <g data-node-click="1">
      <g onClick={(e) => { e.stopPropagation(); props.onSelect(node.id, e.shiftKey); }}
         onDoubleClick={(e) => { e.stopPropagation(); props.onEditLabel(node.id); }}
         style={{ transform: `translate(${x}px, ${y}px)` }}
         className="cursor-pointer">
        {shape}
        {node.kind === "step" && node.breakpoint && (
          <g style={{ pointerEvents: "none" }}>
            <circle cx={10} cy={10} r={7}
              fill={node.breakpoint === "always" ? "#ef4444" : "#f59e0b"}
              stroke="white" strokeWidth={2} />
            <circle cx={10} cy={10} r={10}
              fill="none"
              stroke={node.breakpoint === "always" ? "#ef4444" : "#f59e0b"}
              strokeWidth={1.5}
              opacity={0.4}>
              <animate attributeName="r" values="7;12;7" dur="1.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.5;0;0.5" dur="1.8s" repeatCount="indefinite" />
            </circle>
            <text x={10} y={13.5} textAnchor="middle" fontSize={9} fontWeight="bold" fill="white" style={{ userSelect: "none" }}>
              {node.breakpoint === "always" ? "!" : "?"}
            </text>
          </g>
        )}
        <foreignObject x={textX} y={textY} width={textW} height={textH}>
          <div className="flex h-full w-full items-center justify-center px-1 text-center">
            {isEditing ? (
              <input autoFocus defaultValue={labelText}
                onBlur={(e) => { props.onCommitLabel(node.id, e.target.value); props.onEditLabel(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") props.onEditLabel(null); }}
                onClick={(e) => e.stopPropagation()}
                className="w-full rounded border border-indigo-400 bg-white px-1 py-1 text-center text-[13px] outline-none" />
            ) : node.kind === "step" ? (
              <StepLabel label={labelText} />
            ) : (
              <span className={`block text-[13px] font-semibold leading-tight ${sty.text} ${node.kind === "comment" ? "italic" : ""}`}>{labelText}</span>
            )}
          </div>
        </foreignObject>
        {isBranch && node.branches && (
          <g transform={`translate(${w - 22}, ${NODE_H_BRANCH/2 - 7})`}
             onClick={(e) => { e.stopPropagation(); props.onToggleCollapse(node.id); }}
             className="cursor-pointer">
            <circle r="9" className="fill-white stroke-slate-300" />
            {node.collapsed
              ? <ChevronRight className="h-4 w-4 -translate-x-[8px] -translate-y-[8px] text-slate-500" />
              : <ChevronDown className="h-4 w-4 -translate-x-[8px] -translate-y-[8px] text-slate-500" />}
          </g>
        )}
        {inRange && (
          <rect x={-2} y={-2} width={w+4} height={h+4} rx={12} fill="none" stroke="#6366f1" strokeWidth={2} strokeDasharray="4 3" />
        )}
      </g>

      {node.kind !== "loopback" && (
        <InsertPlusBtn
          cx={x + w / 2}
          cy={y + h + 14}
          onClick={() => props.onOpenInsertAfter(node.id, x + w / 2, y + h + 14)}
        />
      )}

      {isBranch && !node.collapsed && ln.branchLayouts && (
        <g>
          <circle cx={x + w/2} cy={y + ln.h - 24} r="4" fill="#94a3b8" />
          {ln.branchLayouts.map((bl) => (
            <g key={bl.branch.id} transform={`translate(${x + bl.x}, ${y + bl.y})`}>
              <foreignObject x={0} y={0} width={bl.w} height={28}>
                <div className="flex h-full w-full items-center justify-between px-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${node.kind === "ifelse" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"}`}>{bl.branch.label}</span>
                  {node.kind === "case" && (node.branches?.length || 0) > 1 && (
                    <button onClick={(e) => { e.stopPropagation(); props.onRemoveBranch(bl.branch.id); }}
                      className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              </foreignObject>
              {bl.nodes.map((sub) => (
                <LaidNodeView key={sub.node.id} ln={sub} selectedId={selectedId} rangeStart={rangeStart} editingLabel={editingLabel}
                  onSelect={props.onSelectBranchNode}
                  onEditLabel={props.onEditLabel}
                  onCommitLabel={props.onCommitLabel}
                  onToggleCollapse={props.onToggleCollapse}
                  onRemoveBranch={props.onRemoveBranch}
                  onSelectBranchNode={props.onSelectBranchNode}
                  onOpenInsertAfter={props.onOpenInsertAfter}
                  onOpenInsertBranchStart={props.onOpenInsertBranchStart}
                />
              ))}
              {bl.nodes.length === 0 && (
                <foreignObject x={10} y={BR_LABEL_H + 4} width={bl.w-20} height={48}>
                  <div onClick={(e) => { e.stopPropagation(); props.onOpenInsertBranchStart(node.id, bl.branch.id, x + bl.x + bl.w/2, y + bl.y + BR_LABEL_H + 28); }}
                    className="flex h-full w-full cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-200 text-[12px] text-slate-400 hover:border-indigo-300 hover:text-indigo-500">
                    <Plus className="mr-1 h-3.5 w-3.5" /> 添加步骤
                  </div>
                </foreignObject>
              )}
            </g>
          ))}
        </g>
      )}
      {isBranch && node.collapsed && (
        <text x={x + w/2} y={y + NODE_H_BRANCH + 14} textAnchor="middle" className="fill-slate-400 text-[12px]">（折叠）</text>
      )}
    </g>
  );
}

// ========== 子LOOP选择器 ==========
function SubloopPicker({ templates, onPick, onClose }: { templates: WorkflowTemplate[]; onPick: (t: WorkflowTemplate) => void; onClose: () => void }) {
  return (
    <div className="fixed left-1/2 top-1/2 z-[60] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-3 shadow-2xl ring-1 ring-slate-200" onClick={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-700">选择子LOOP</span>
        <button onClick={onClose} className="rounded p-0.5 text-slate-400 hover:bg-slate-100"><X className="h-3 w-3" /></button>
      </div>
      {templates.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-400">没有其他已保存的 Loop。</div>
      ) : (
        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          {templates.map((t) => {
            const sc = t.dataSourceMarks.length + t.reviewMarks.length + t.entryMarks.length;
            return (
              <button key={t.id} onClick={() => onPick(t)}
                className="flex w-full items-center gap-2 rounded-lg border border-slate-200 p-2 text-left hover:border-violet-300 hover:bg-violet-50">
                <span className="text-xl">{t.icon || "🔍"}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-slate-800">{t.name}</div>
                  <div className="text-[10px] text-slate-400">{sc} 步 · {t.mode}</div>
                </div>
                <CornerDownRight className="h-3.5 w-3.5 text-violet-400" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
