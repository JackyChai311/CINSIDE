import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  X, Plus, Scissors, Copy, Clipboard, Trash2, ChevronDown, ChevronRight,
  GitBranch, Split, Repeat, MessageSquare, Save, RotateCcw, CornerDownRight,
  ZoomIn, ZoomOut, MousePointer2,
} from "lucide-react";
import type { WorkflowTemplate, FlowGraph, FlowNode, FlowBranch } from "../types";
import {
  ensureGraph, buildLinearGraph, findNode, cloneNodes,
  makeSubloop, makeIfElse, makeCase, makeComment, addCaseBranch,
  removeBranch, countNodes,
} from "../lib/flowGraph";
import { saveSkill } from "../lib/skills";

// ========== 布局常量 ==========
const NODE_W = 220;
const NODE_H_STEP = 48;
const NODE_H_SUBLOOP = 56;
const NODE_H_BRANCH = 56;
const NODE_H_COMMENT = 36;
const NODE_H_LOOPBACK = 44;
const GAP_Y = 28;
const BRANCH_GAP_X = 40;
const BRANCH_PAD_X = 20;
const BRANCH_PAD_Y = 20;

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
        const bNodes = layoutNodesLinear(b.nodes);
        const bw = Math.max(NODE_W, bNodes.w);
        const bh = bNodes.h;
        branchLayouts.push({ branch: b, x: curX, y: 0, w: bw, h: bh, nodes: bNodes.nodes });
        curX += bw + BRANCH_GAP_X;
        if (bh > maxBranchH) maxBranchH = bh;
        totalW = curX - BRANCH_GAP_X;
      }
    }
    const bodyW = Math.max(NODE_W + 40, totalW + BRANCH_PAD_X * 2);
    const bodyH = NODE_H_BRANCH + (collapsed ? 0 : maxBranchH + BRANCH_PAD_Y * 2 + 30);
    if (!collapsed && branchLayouts.length > 0) {
      const innerW = branchLayouts.reduce((s, b) => s + b.w, 0) + (branchLayouts.length - 1) * BRANCH_GAP_X;
      let curX = (bodyW - innerW) / 2;
      for (const bl of branchLayouts) {
        bl.x = curX;
        bl.y = NODE_H_BRANCH + BRANCH_PAD_Y;
        curX += bl.w + BRANCH_GAP_X;
      }
    }
    return { node, x: 0, y: 0, w: bodyW, h: bodyH, subtreeH: bodyH, branchLayouts };
  }
  const h = node.kind === "subloop" ? NODE_H_SUBLOOP
    : node.kind === "comment" ? NODE_H_COMMENT
    : node.kind === "loopback" ? NODE_H_LOOPBACK
    : NODE_H_STEP;
  return { node, x: 0, y: 0, w: NODE_W, h, subtreeH: h };
}

function layoutNodesLinear(nodes: FlowNode[]): { nodes: LaidNode[]; w: number; h: number } {
  const laid: LaidNode[] = [];
  let curY = 0;
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

function shiftLaidNodeX(ln: LaidNode, dx: number) {
  ln.x += dx;
  if (ln.branchLayouts) {
    for (const b of ln.branchLayouts) {
      b.x += dx;
      for (const sub of b.nodes) shiftLaidNodeX(sub, dx);
    }
  }
}

function nodeStyle(kind: FlowNode["kind"], selected: boolean) {
  const base: Record<string, { fill: string; stroke: string; text: string }> = {
    step:     { fill: "#ffffff", stroke: "#cbd5e1", text: "text-slate-800" },
    subloop:  { fill: "#faf5ff", stroke: "#a78bfa", text: "text-violet-900" },
    ifelse:   { fill: "#fffbeb", stroke: "#fbbf24", text: "text-amber-900" },
    case:     { fill: "#f0f9ff", stroke: "#38bdf8", text: "text-sky-900" },
    comment:  { fill: "#f8fafc", stroke: "#cbd5e1", text: "text-slate-500" },
    loopback: { fill: "#ecfdf5", stroke: "#34d399", text: "text-emerald-800" },
  };
  const s = base[kind] || base.step;
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

  // 收集所有连线
  const edges = useMemo<EdgeInfo[]>(() => {
    const result: EdgeInfo[] = [];

    const collectLinear = (lns: LaidNode[], parentPrefix: string, offX: number, offY: number) => {
      for (let i = 0; i < lns.length; i++) {
        const ln = lns[i];
        const myTopX = offX + ln.x + ln.w / 2;
        const myTopY = offY + ln.y;
        const myBotX = offX + ln.x + ln.w / 2;
        const myBotY = offY + ln.y + ln.h;

        if (i > 0) {
          const prev = lns[i - 1];
          const prevBotX = offX + prev.x + prev.w / 2;
          const prevBotY = offY + prev.y + prev.h;
          const cpY = (prevBotY + myTopY) / 2;
          const d = `M${prevBotX},${prevBotY} C${prevBotX},${cpY} ${myTopX},${cpY} ${myTopX},${myTopY}`;
          result.push({
            id: `${parentPrefix}${prev.node.id}-${ln.node.id}`,
            anchor: { type: "before", nodeId: ln.node.id },
            pathD: d,
            midX: (prevBotX + myTopX) / 2,
            midY: (prevBotY + myTopY) / 2,
          });
        }

        if ((ln.node.kind === "ifelse" || ln.node.kind === "case") && ln.branchLayouts && !ln.node.collapsed) {
          const mergeY = offY + ln.y + ln.h - 20;
          const mergeX = offX + ln.x + ln.w / 2;
          for (const bl of ln.branchLayouts) {
            const brTopX = offX + ln.x + bl.x + bl.w / 2;
            const brTopY = offY + ln.y + bl.y;
            const dTop = `M${myBotX},${myBotY} L${myBotX},${myBotY+8} L${brTopX},${myBotY+8} L${brTopX},${brTopY}`;
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

    // 闭环线
    if (layout.nodes.length > 0) {
      const last = layout.nodes[layout.nodes.length - 1];
      const lastCx = last.x + last.w / 2;
      const lastCy = last.y + last.h / 2;
      const first = layout.nodes[0];
      const firstCx = first.x + first.w / 2;
      const firstTy = first.y;
      const rightX = layout.w + 30;
      const topY = -20;
      result.push({
        id: "loopback",
        anchor: { type: "end" },
        pathD: `M${lastCx + last.w/2 - 10},${lastCy} L${rightX},${lastCy} L${rightX},${topY} L${firstCx},${topY} L${firstCx},${firstTy}`,
        midX: rightX,
        midY: (lastCy + topY) / 2,
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
    const first = layout.nodes[0];
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (first && rect) {
      setView({ x: rect.width / 2 - (first.x + first.w / 2), y: 80, scale: 1 });
    } else {
      setView({ x: 40, y: 40, scale: 1 });
    }
  }, [layout.nodes]);

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

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
    const updated: WorkflowTemplate = { ...template, flowGraph: graph, updatedAt: Date.now() };
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
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" /></marker>
            <marker id="arrow-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#10b981" /></marker>
            <marker id="arrow-indigo" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4f46e5" /></marker>
          </defs>
          <rect x={-100000} y={-100000} width={200000} height={200000} fill="transparent" data-bg="1" />
          <g transform={`translate(${view.x}, ${view.y}) scale(${view.scale})`}>
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
        const w = edge.isLoopback ? 2 : isCut ? 2.5 : 1.5;
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
                <circle r={10} fill="#4f46e5" opacity={0.15} />
                <circle r={6} fill="#4f46e5" />
                {tool !== "cut" && <Plus className="h-3.5 w-3.5 text-white" style={{ transform: "translate(-7px, -7px)" }} />}
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
  const sty = nodeStyle(node.kind, selected);
  const isEditing = editingLabel === node.id;
  const isBranch = node.kind === "ifelse" || node.kind === "case";

  const strokeDash = node.kind === "comment" || node.kind === "loopback" ? "6 3" : undefined;
  let shape: JSX.Element;
  if (isBranch) {
    const cx = w / 2, cy = NODE_H_BRANCH / 2;
    const rx = Math.min(w / 2 - 10, 130), ry = NODE_H_BRANCH / 2 - 4;
    shape = <polygon points={`${cx},${cy-ry} ${cx+rx},${cy} ${cx},${cy+ry} ${cx-rx},${cy}`} fill={sty.fill} stroke={sty.stroke} strokeWidth={sty.strokeWidth} strokeDasharray={strokeDash}
      style={{ filter: selected ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))" : "drop-shadow(0 1px 2px rgba(0,0,0,0.08))" }} />;
  } else if (node.kind === "loopback") {
    shape = <rect x={w/2-90} y={0} width={180} height={h} rx={h/2} fill={sty.fill} stroke={sty.stroke} strokeWidth={sty.strokeWidth} strokeDasharray={strokeDash}
      style={{ filter: selected ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))" : "drop-shadow(0 1px 2px rgba(0,0,0,0.08))" }} />;
  } else {
    const rr = node.kind === "comment" ? 8 : 10;
    const sw = node.kind === "comment" ? 1 : sty.strokeWidth;
    shape = <rect x={w/2-NODE_W/2} y={0} width={NODE_W} height={h} rx={rr} fill={sty.fill} stroke={sty.stroke} strokeWidth={sw} strokeDasharray={strokeDash}
      style={{ filter: selected ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))" : "drop-shadow(0 1px 2px rgba(0,0,0,0.08))" }} />;
  }

  const labelText = node.label || node.kind;

  return (
    <g data-node-click="1">
      <g onClick={(e) => { e.stopPropagation(); props.onSelect(node.id, e.shiftKey); }}
         onDoubleClick={(e) => { e.stopPropagation(); props.onEditLabel(node.id); }}
         style={{ transform: `translate(${x}px, ${y}px)` }}
         className="cursor-pointer">
        {shape}
        <foreignObject x={w/2 - (isBranch ? Math.min(w/2-20, 120) : NODE_W/2-10)} y={isBranch ? 0 : 6}
                       width={isBranch ? Math.min(w-40, 240) : NODE_W-20}
                       height={isBranch ? NODE_H_BRANCH : h-12}>
          <div className="flex h-full w-full items-center justify-center px-2 text-center">
            {isEditing ? (
              <input autoFocus defaultValue={labelText}
                onBlur={(e) => { props.onCommitLabel(node.id, e.target.value); props.onEditLabel(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") props.onEditLabel(null); }}
                onClick={(e) => e.stopPropagation()}
                className="w-full rounded border border-indigo-400 bg-white px-1 py-0.5 text-center text-[11px] outline-none" />
            ) : (
              <span className={`block text-[11px] font-medium leading-tight ${sty.text} ${node.kind === "comment" ? "italic" : ""}`}>{labelText}</span>
            )}
          </div>
        </foreignObject>
        {isBranch && node.branches && (
          <g transform={`translate(${w/2 + Math.min(w/2-20, 120) - 4}, ${NODE_H_BRANCH/2 - 6})`}
             onClick={(e) => { e.stopPropagation(); props.onToggleCollapse(node.id); }}
             className="cursor-pointer">
            <circle r="7" className="fill-white stroke-slate-300" />
            {node.collapsed
              ? <ChevronRight className="h-3 w-3 -translate-x-[6px] -translate-y-[6px] text-slate-500" />
              : <ChevronDown className="h-3 w-3 -translate-x-[6px] -translate-y-[6px] text-slate-500" />}
          </g>
        )}
        {inRange && (
          <rect x={w/2-NODE_W/2-2} y={-2} width={NODE_W+4} height={h+4} rx={12} fill="none" stroke="#6366f1" strokeWidth="2" strokeDasharray="4 3" />
        )}
      </g>

      {node.kind !== "loopback" && (
        <g transform={`translate(${x + w/2 - 12}, ${y + h + 6})`}
           onClick={(e) => { e.stopPropagation(); props.onOpenInsertAfter(node.id, x + w/2, y + h + 14); }}
           className="cursor-pointer">
          {/* 大号透明命中区：保证整个按钮都容易点到 */}
          <circle cx="12" cy="8" r="22" fill="transparent" pointerEvents="all" />
          {/* 白色外圈 + 强调色圆：始终清晰可见，不再依赖选中态 */}
          <circle cx="12" cy="8" r="12" fill="white" stroke="#cbd5e1" strokeWidth="1" />
          <circle cx="12" cy="8" r="10" className="fill-indigo-500 stroke-white" strokeWidth="2" />
          <Plus className="h-4 w-4 text-white" style={{ transform: "translate(8px, 2px)" }} />
        </g>
      )}

      {isBranch && !node.collapsed && ln.branchLayouts && (
        <g>
          <circle cx={x + w/2} cy={y + ln.h - 20} r="3" fill="#94a3b8" />
          {ln.branchLayouts.map((bl) => (
            <g key={bl.branch.id} transform={`translate(${x + bl.x}, ${y + bl.y})`}>
              <foreignObject x={0} y={0} width={bl.w} height={22}>
                <div className="flex h-full w-full items-center justify-between px-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${node.kind === "ifelse" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"}`}>{bl.branch.label}</span>
                  {node.kind === "case" && (node.branches?.length || 0) > 1 && (
                    <button onClick={(e) => { e.stopPropagation(); props.onRemoveBranch(bl.branch.id); }}
                      className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"><X className="h-3 w-3" /></button>
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
                <foreignObject x={10} y={26} width={bl.w-20} height={36}>
                  <div onClick={(e) => { e.stopPropagation(); props.onOpenInsertBranchStart(node.id, bl.branch.id, x + bl.x + bl.w/2, y + bl.y + 44); }}
                    className="flex h-full w-full cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-200 text-[10px] text-slate-400 hover:border-indigo-300 hover:text-indigo-500">
                    <Plus className="mr-1 h-3 w-3" /> 添加步骤
                  </div>
                </foreignObject>
              )}
            </g>
          ))}
        </g>
      )}
      {isBranch && node.collapsed && (
        <text x={x + w/2} y={y + NODE_H_BRANCH + 12} textAnchor="middle" className="fill-slate-400 text-[10px]">（折叠）</text>
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
