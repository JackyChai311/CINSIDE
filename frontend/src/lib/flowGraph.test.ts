/**
 * flowGraph 单元测试：锁定流程图构建 / 查找 / 编辑 / 拍平的现有行为。
 * 该模块是纯逻辑（不依赖浏览器 API），全部函数都在 node 环境下直接测试。
 */
import { describe, it, expect } from "vitest";
import type { FlowBranch, FlowGraph, FlowNode, FlowNodeKind, PickedMark, WorkflowTemplate } from "../types";
import {
  genId,
  buildLinearGraph,
  buildStepLabel,
  ensureGraph,
  findNode,
  cloneNodes,
  insertAfter,
  insertBefore,
  removeNode,
  makeSubloop,
  makeIfElse,
  makeCase,
  makeComment,
  copyRange,
  addCaseBranch,
  removeBranch,
  countNodes,
  flattenNodes,
} from "./flowGraph";

/** 取出断言用值，避免非空断言 */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("期望值存在，但为 null/undefined");
  return value;
}

function mark(over: Partial<PickedMark> = {}): PickedMark {
  return {
    id: "m0",
    order: 1,
    side: "right",
    source: "web",
    selector: "#m0",
    label: "标记",
    workflow: "data-source",
    createdAt: 0,
    ...over,
  } as PickedMark;
}

function template(over: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: "tpl-1",
    name: "模板",
    createdAt: 0,
    mode: "review",
    dataSourceMarks: [],
    reviewMarks: [],
    entryMarks: [],
    hasSearchSteps: false,
    hasSubmitStep: false,
    ...over,
  } as WorkflowTemplate;
}

function node(id: string, kind: FlowNodeKind, over: Partial<FlowNode> = {}): FlowNode {
  return { id, kind, ...over } as FlowNode;
}

describe("genId", () => {
  it("默认前缀 n_，结构为 前缀_36进制时间戳_随机串", () => {
    expect(genId()).toMatch(/^n_[0-9a-z]+_[0-9a-z]*$/);
  });

  it("接受自定义前缀", () => {
    expect(genId("step")).toMatch(/^step_[0-9a-z]+_[0-9a-z]*$/);
    expect(genId("loopback")).toMatch(/^loopback_/);
  });

  it("连续生成的 id 互不相同", () => {
    const ids = new Set(Array.from({ length: 100 }, (_, i) => genId(`p${i}`)));
    expect(ids.size).toBe(100);
  });
});

describe("buildStepLabel", () => {
  it("fileOp 优先：文件处理，缺 label 时用默认文案", () => {
    expect(buildStepLabel(mark({ fileOp: "export", label: "导出文件" }))).toBe("🗂 导出文件");
    expect(buildStepLabel(mark({ fileOp: "extract", label: "" }))).toBe("🗂 文件处理");
  });

  it("优先级：fileOp > docExtract > docUpload > widget", () => {
    const m = mark({
      fileOp: "upload",
      docExtract: true,
      docUpload: true,
      widget: { id: "w", kind: "calendar", triggerSelector: "#w", createdAt: 0 },
      label: "L",
    });
    expect(buildStepLabel(m)).toBe("🗂 L");
  });

  it("docExtract：提取文件 + 点击阶段标签，缺 label 用 selector", () => {
    expect(buildStepLabel(mark({ docExtract: true, label: "护照页" }))).toBe("📄 提取文件: 护照页");
    expect(buildStepLabel(mark({ docExtract: true, label: "护照页", clickPhase: "post" }))).toBe("📄 提取文件 [收尾]: 护照页");
    expect(buildStepLabel(mark({ docExtract: true, label: "", selector: "#img" }))).toBe("📄 提取文件: #img");
  });

  it("docUpload：上传文件 + 点击阶段标签", () => {
    expect(buildStepLabel(mark({ docUpload: true, label: "成绩单" }))).toBe("📎 上传文件: 成绩单");
    expect(buildStepLabel(mark({ docUpload: true, label: "", selector: "input[type=file]", clickPhase: "mid" }))).toBe(
      "📎 上传文件 [过程]: input[type=file]",
    );
  });

  it("widget：日历/选项控件标签，取 triggerLabel → label → selector", () => {
    expect(
      buildStepLabel(mark({ widget: { id: "w1", kind: "calendar", triggerSelector: "#d", triggerLabel: "出生日期", createdAt: 0 } })),
    ).toBe("🎛 日历控件: 出生日期");
    expect(buildStepLabel(mark({ label: "性别", widget: { id: "w2", kind: "option", triggerSelector: "#o", triggerLabel: "", createdAt: 0 } }))).toBe(
      "🎛 选项控件: 性别",
    );
    expect(buildStepLabel(mark({ label: "", selector: "#sel", widget: { id: "w3", kind: "option", triggerSelector: "#o", createdAt: 0 } }))).toBe(
      "🎛 选项控件: #sel",
    );
  });

  it("input + variableField：entry 用「填入」，其它用「定位」，并去掉「输入 ·」前缀", () => {
    expect(buildStepLabel(mark({ action: "input", variableField: "name", workflow: "entry", inputTargetLabel: "姓 名", label: "输入 · 姓名" }))).toBe(
      "⌨️ 填入「name」→ 姓 名",
    );
    expect(buildStepLabel(mark({ action: "input", variableField: "sid", workflow: "review", inputTargetLabel: "输入 · 学号" }))).toBe(
      "⌨️ 定位「sid」→ 学号",
    );
    expect(buildStepLabel(mark({ action: "input", variableField: "name", workflow: "entry", inputTargetLabel: "", label: "" }))).toBe(
      "⌨️ 填入「name」→ ",
    );
  });

  it("click：点击 + 点击阶段标签", () => {
    expect(buildStepLabel(mark({ action: "click", label: "下一页" }))).toBe("🖱 点击: 下一页");
    expect(buildStepLabel(mark({ action: "click", label: "下一页", clickPhase: "pre" }))).toBe("🖱 点击 [导航]: 下一页");
    expect(buildStepLabel(mark({ action: "click", label: "下一页", clickPhase: "mid" }))).toBe("🖱 点击 [过程]: 下一页");
    expect(buildStepLabel(mark({ action: "click", label: "下一页", clickPhase: "post" }))).toBe("🖱 点击 [收尾]: 下一页");
    expect(buildStepLabel(mark({ action: "click", label: "", selector: "#next" }))).toBe("🖱 点击: #next");
  });

  it("input 无 variableField：entry 用「录入」，其它用「审查」，并去掉「输入 ·」前缀", () => {
    expect(buildStepLabel(mark({ action: "input", workflow: "entry", label: "输入 · 姓名" }))).toBe("⌨️ 录入: 姓名");
    expect(buildStepLabel(mark({ action: "input", workflow: "review", label: "成绩", clickPhase: "mid" }))).toBe("⌨️ 审查 [过程]: 成绩");
  });

  it("默认分支：pick 映射为「取值」，未设置 action 也按 pick", () => {
    expect(buildStepLabel(mark({ action: "pick", label: "分数" }))).toBe("取值: 分数");
    expect(buildStepLabel(mark({ label: "分数" }))).toBe("取值: 分数");
    expect(buildStepLabel(mark({ action: "pick", label: "", selector: "#a" }))).toBe("取值: #a");
  });

  it("未知 action 回退为「步骤」", () => {
    expect(buildStepLabel(mark({ action: "weird" as PickedMark["action"], label: "L" }))).toBe("步骤: L");
  });
});

describe("buildLinearGraph", () => {
  it("review 模式：数据源 + 审查，末尾补回环节点（录入阶段不参与）", () => {
    const g = buildLinearGraph(
      template({
        mode: "review",
        dataSourceMarks: [mark({ id: "d1", order: 1, label: "A" })],
        reviewMarks: [mark({ id: "r1", order: 1, workflow: "review", label: "B" })],
        entryMarks: [mark({ id: "e1", order: 1, workflow: "entry", label: "E" })],
      }),
    );

    expect(g.version).toBe(1);
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.slice(0, 2).map((n) => n.markId)).toEqual(["d1", "r1"]);
    expect(g.nodes.slice(0, 2).map((n) => n.markPhase)).toEqual(["data-source", "review"]);
    expect(g.nodes.slice(0, 2).map((n) => n.kind)).toEqual(["step", "step"]);
    expect(g.nodes[2].kind).toBe("loopback");
    expect(g.nodes[2].label).toBe("下一张卡片（回到开头）");
    expect(g.nodes[2].id.startsWith("loop_")).toBe(true);
    expect(g.nodes[0].id.startsWith("step_")).toBe(true);
    // 节点标签由 buildStepLabel 生成（label 只有 "A"，无 action → 取值）
    expect(g.nodes[0].label).toBe("取值: A");
    expect(typeof g.updatedAt).toBe("number");
  });

  it("entry 模式：数据源 + 录入（审查阶段不参与）", () => {
    const g = buildLinearGraph(
      template({
        mode: "entry",
        dataSourceMarks: [mark({ id: "d1", order: 1 })],
        reviewMarks: [mark({ id: "r1", order: 1, workflow: "review" })],
        entryMarks: [mark({ id: "e1", order: 1, workflow: "entry" })],
      }),
    );
    expect(g.nodes.slice(0, 2).map((n) => n.markId)).toEqual(["d1", "e1"]);
    expect(g.nodes.slice(0, 2).map((n) => n.markPhase)).toEqual(["data-source", "entry"]);
    expect(g.nodes).toHaveLength(3);
  });

  it("loop 模式：数据源 → 审查 → 录入", () => {
    const g = buildLinearGraph(
      template({
        mode: "loop",
        dataSourceMarks: [mark({ id: "d1", order: 1 })],
        reviewMarks: [mark({ id: "r1", order: 1, workflow: "review" })],
        entryMarks: [mark({ id: "e1", order: 1, workflow: "entry" })],
      }),
    );
    expect(g.nodes.slice(0, 3).map((n) => n.markId)).toEqual(["d1", "r1", "e1"]);
    expect(g.nodes).toHaveLength(4);
  });

  it("同阶段内按 order 升序，且不改动原数组顺序", () => {
    const b = mark({ id: "b", order: 2 });
    const a = mark({ id: "a", order: 1 });
    const arr = [b, a];
    const g = buildLinearGraph(template({ mode: "review", dataSourceMarks: arr }));

    expect(g.nodes.slice(0, 2).map((n) => n.markId)).toEqual(["a", "b"]);
    expect(arr.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("step 节点带 markSide / breakpoint / wide 标记", () => {
    const g = buildLinearGraph(
      template({
        mode: "review",
        dataSourceMarks: [
          mark({ id: "d1", order: 1, side: "left", breakpoint: "always" }),
          mark({ id: "d2", order: 2, docExtract: true }),
          mark({ id: "d3", order: 3, fileOp: "upload" }),
          mark({ id: "d4", order: 4, docUpload: true }),
          mark({ id: "d5", order: 5, panelAction: "doc-web-extract" }),
        ],
      }),
    );

    const n1 = g.nodes[0];
    expect(n1.kind).toBe("step");
    expect(n1.markSide).toBe("left");
    expect(n1.breakpoint).toBe("always");
    expect(n1.wide).toBe(false);
    expect(g.nodes[1].wide).toBe(true);
    expect(g.nodes[2].wide).toBe(true);
    expect(g.nodes[3].wide).toBe(true);
    expect(g.nodes[4].wide).toBe(true);
    expect(g.nodes[4].markSide).toBe("right");
  });

  it("没有任何 marks 时只返回回环节点", () => {
    const g = buildLinearGraph(template({ mode: "entry" }));
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].kind).toBe("loopback");
  });

  it("updatedAt 为当前时间", () => {
    const before = Date.now();
    const g = buildLinearGraph(template({}));
    expect(g.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("ensureGraph", () => {
  it("已有 flowGraph（nodes 为数组）时原样返回同一对象", () => {
    const graph: FlowGraph = { version: 1, nodes: [node("a", "step")], updatedAt: 5 };
    expect(ensureGraph(template({ flowGraph: graph }))).toBe(graph);
  });

  it("没有 flowGraph 时按 marks 构建线性流程图", () => {
    const g = ensureGraph(template({ mode: "review", dataSourceMarks: [mark({ id: "d1", order: 1 })] }));
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes[0].markId).toBe("d1");
  });

  it("flowGraph.nodes 不是数组时回退到线性构建", () => {
    const g = ensureGraph(template({ flowGraph: { version: 1, nodes: null, updatedAt: 0 } as unknown as FlowGraph }));
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].kind).toBe("loopback");
  });
});

describe("findNode", () => {
  const inner = node("inner", "step");
  const b1: FlowBranch = { id: "b1", label: "是", nodes: [inner] };
  const root0 = node("r0", "ifelse", { branches: [b1] });
  const root1 = node("r1", "step");
  const nodes = [root0, root1];

  it("找到顶层节点：返回所在数组、索引与路径", () => {
    const loc = must(findNode(nodes, "r1"));
    expect(loc.node).toBe(root1);
    expect(loc.parent).toBe(nodes);
    expect(loc.index).toBe(1);
    expect(loc.path).toBe("root[1]");
    expect(loc.parentBranch).toBeUndefined();
    expect(loc.parentNode).toBeUndefined();
  });

  it("递归找到分支内节点：带上 parentBranch / parentNode 与分支路径", () => {
    const loc = must(findNode(nodes, "inner"));
    expect(loc.node).toBe(inner);
    expect(loc.parent).toBe(b1.nodes);
    expect(loc.index).toBe(0);
    expect(loc.parentBranch).toBe(b1);
    expect(loc.parentNode).toBe(root0);
    expect(loc.path).toBe("root[0]/branch:b1[0]");
  });

  it("找不到时返回 null", () => {
    expect(findNode(nodes, "nope")).toBeNull();
    expect(findNode([], "r0")).toBeNull();
  });
});

describe("insertAfter / insertBefore / removeNode", () => {
  it("insertAfter 插到指定索引之后（原地修改）", () => {
    const list = [node("a", "step"), node("b", "step")];
    const n = node("new", "comment");
    insertAfter(list, 0, n);
    expect(list.map((x) => x.id)).toEqual(["a", "new", "b"]);
  });

  it("insertBefore 插到指定索引之前（原地修改）", () => {
    const list = [node("a", "step"), node("b", "step")];
    const n = node("new", "comment");
    insertBefore(list, 0, n);
    expect(list.map((x) => x.id)).toEqual(["new", "a", "b"]);
  });

  it("removeNode 返回被删除的节点并从数组移除", () => {
    const list = [node("a", "step"), node("b", "step")];
    const loc = must(findNode(list, "b"));
    const removed = removeNode(loc);
    expect(removed.id).toBe("b");
    expect(list.map((x) => x.id)).toEqual(["a"]);
    expect(findNode(list, "b")).toBeNull();
  });
});

describe("cloneNodes", () => {
  it("深克隆并重置 id（含分支与分支内节点），同时填充 idMap", () => {
    const branch: FlowBranch = { id: "b1", label: "是", condition: "x > 1", nodes: [node("inner", "step", { label: "内部" })] };
    const root = node("root", "ifelse", { label: "根", branches: [branch] });

    const idMap = new Map<string, string>();
    const cloned = cloneNodes([root], idMap);

    expect(cloned).toHaveLength(1);
    const cRoot = cloned[0];
    expect(cRoot).not.toBe(root);
    expect(cRoot.id).not.toBe("root");
    expect(cRoot.id.startsWith("ife_")).toBe(true);
    expect(cRoot.label).toBe("根");

    const cBranch = must(must(cRoot.branches)[0]);
    expect(cBranch.id).not.toBe("b1");
    expect(cBranch.id.startsWith("br_")).toBe(true);
    expect(cBranch.label).toBe("是");
    expect(cBranch.condition).toBe("x > 1");

    const cInner = must(cBranch.nodes[0]);
    expect(cInner.id).not.toBe("inner");
    expect(cInner.id.startsWith("ste_")).toBe(true);
    expect(cInner.label).toBe("内部");

    expect(idMap.get("root")).toBe(cRoot.id);
    expect(idMap.get("inner")).toBe(cInner.id);

    // 原结构不受影响
    expect(must(must(root.branches)[0]).nodes[0].id).toBe("inner");
  });

  it("不传 idMap 时也能克隆", () => {
    const cloned = cloneNodes([node("a", "case")]);
    expect(cloned).toHaveLength(1);
    expect(cloned[0].id).not.toBe("a");
  });

  it("没有分支的节点只换 id", () => {
    const cloned = cloneNodes([node("a", "step", { label: "L", note: "N" })]);
    expect(cloned[0].label).toBe("L");
    expect(cloned[0].note).toBe("N");
    expect(cloned[0].branches).toBeUndefined();
  });
});

describe("copyRange", () => {
  const nodes = [node("a", "step", { label: "A" }), node("b", "step", { label: "B" }), node("c", "step", { label: "C" })];

  it("包含两端，返回新 id 的副本", () => {
    const out = copyRange(nodes, "a", "c");
    expect(out.map((n) => n.label)).toEqual(["A", "B", "C"]);
    expect(out.map((n) => n.id)).not.toEqual(["a", "b", "c"]);
    expect(out.every((n) => !["a", "b", "c"].includes(n.id))).toBe(true);
  });

  it("起始与结束顺序颠倒时自动取区间", () => {
    const out = copyRange(nodes, "c", "a");
    expect(out.map((n) => n.label)).toEqual(["A", "B", "C"]);
  });

  it("单节点区间", () => {
    const out = copyRange(nodes, "b", "b");
    expect(out.map((n) => n.label)).toEqual(["B"]);
  });

  it("任一端点不存在时返回空数组", () => {
    expect(copyRange(nodes, "a", "zzz")).toEqual([]);
    expect(copyRange(nodes, "zzz", "a")).toEqual([]);
    expect(copyRange([], "a", "b")).toEqual([]);
  });
});

describe("节点工厂", () => {
  it("makeSubloop：默认重复 1 次", () => {
    const s = makeSubloop("t2", "子模板");
    expect(s.kind).toBe("subloop");
    expect(s.label).toBe("🔁 子LOOP: 子模板");
    expect(s.subloopTemplateId).toBe("t2");
    expect(s.subloopRepeat).toBe(1);
    expect(s.id.startsWith("sub_")).toBe(true);
    expect(makeSubloop("t2", "子模板", 5).subloopRepeat).toBe(5);
  });

  it("makeIfElse：默认无条件，两个分支标签固定", () => {
    const n = makeIfElse();
    expect(n.kind).toBe("ifelse");
    expect(n.label).toBe("❓ IF/ELSE");
    expect(n.id.startsWith("if_")).toBe(true);

    const branches = must(n.branches);
    expect(branches.map((b) => b.label)).toEqual(["是 (IF)", "否 (ELSE)"]);
    expect(branches[0].condition).toBe("");
    expect(branches[0].id).not.toBe(branches[1].id);
    expect(branches[0].id.startsWith("br_")).toBe(true);
    expect(branches.every((b) => b.nodes.length === 0)).toBe(true);
  });

  it("makeIfElse：带条件时写进标签与首个分支", () => {
    const n = makeIfElse("age > 18");
    expect(n.label).toBe("❓ IF age > 18");
    expect(must(n.branches)[0].condition).toBe("age > 18");
  });

  it("makeCase：默认两个 case 分支", () => {
    const c = makeCase();
    expect(c.kind).toBe("case");
    expect(c.label).toBe("🔀 SWITCH/CASE");
    expect(c.switchField).toBe("");
    expect(must(c.branches).map((b) => b.label)).toEqual(["case1", "case2"]);
    expect(c.id.startsWith("case_")).toBe(true);
  });

  it("makeCase：指定字段与分支标签", () => {
    const c = makeCase("status", ["A", "B", "C"]);
    expect(c.label).toBe("🔀 SWITCH status");
    expect(c.switchField).toBe("status");
    expect(must(c.branches)).toHaveLength(3);
    expect(must(c.branches).every((b) => b.nodes.length === 0)).toBe(true);
  });

  it("makeComment：标签带 💬 前缀，note 保存原文", () => {
    const c = makeComment("注意这里");
    expect(c.kind).toBe("comment");
    expect(c.label).toBe("💬 注意这里");
    expect(c.note).toBe("注意这里");
    expect(c.id.startsWith("cmt_")).toBe(true);
  });
});

describe("addCaseBranch / removeBranch", () => {
  it("case 节点追加分支并返回该分支", () => {
    const c = makeCase("status", ["A"]);
    const br = must(addCaseBranch(c, "B"));
    expect(br.label).toBe("B");
    expect(br.nodes).toEqual([]);
    expect(br.id.startsWith("br_")).toBe(true);
    expect(must(c.branches).map((b) => b.label)).toEqual(["A", "B"]);
  });

  it("非 case 节点返回 null 且不改动", () => {
    const n = node("s", "step");
    expect(addCaseBranch(n, "X")).toBeNull();
    expect(n.branches).toBeUndefined();
  });

  it("case 节点没有 branches 时返回 null", () => {
    expect(addCaseBranch(node("c", "case"), "X")).toBeNull();
  });

  it("removeBranch：正常删除返回 true", () => {
    const c = makeCase("f", ["A", "B", "C"]);
    const branches = must(c.branches);
    expect(removeBranch(c, branches[1].id)).toBe(true);
    expect(branches.map((b) => b.label)).toEqual(["A", "C"]);
  });

  it("removeBranch：分支不存在或只剩一个时返回 false", () => {
    const c = makeCase("f", ["A", "B"]);
    expect(removeBranch(c, "nope")).toBe(false);
    expect(must(c.branches)).toHaveLength(2);

    const single = makeCase("f", ["only"]);
    expect(removeBranch(single, must(single.branches)[0].id)).toBe(false);
    expect(must(single.branches)).toHaveLength(1);
  });

  it("removeBranch：没有 branches 的节点返回 false", () => {
    expect(removeBranch(node("s", "step"), "x")).toBe(false);
  });
});

describe("countNodes", () => {
  it("递归统计含分支内的所有节点", () => {
    const tree = [
      node("a", "step"),
      node("b", "ifelse", {
        branches: [
          { id: "b1", label: "是", nodes: [node("c", "step")] },
          { id: "b2", label: "否", nodes: [node("d", "step"), node("e", "comment")] },
        ],
      }),
    ];
    expect(countNodes(tree)).toBe(5);
  });

  it("空数组为 0", () => {
    expect(countNodes([])).toBe(0);
  });

  it("多层嵌套", () => {
    const tree = [
      node("a", "case", {
        branches: [
          { id: "b1", label: "A", nodes: [node("b", "ifelse", { branches: [{ id: "c1", label: "是", nodes: [node("c", "step")] }] })] },
        ],
      }),
    ];
    expect(countNodes(tree)).toBe(3);
  });
});

describe("flattenNodes", () => {
  it("过滤注释节点，其余按顺序保留", () => {
    const out = flattenNodes([node("a", "step"), node("c", "comment"), node("b", "step")]);
    expect(out.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("ifelse：先输出自身，再依次展开各分支", () => {
    const ifn = node("if", "ifelse", {
      branches: [
        { id: "y", label: "是", nodes: [node("y1", "step")] },
        { id: "n", label: "否", nodes: [node("n1", "step")] },
      ],
    });
    expect(flattenNodes([ifn]).map((n) => n.id)).toEqual(["if", "y1", "n1"]);
  });

  it("case：先输出自身，再依次展开各分支", () => {
    const c = node("case", "case", {
      branches: [
        { id: "c1", label: "A", nodes: [node("a1", "step")] },
        { id: "c2", label: "B", nodes: [node("b1", "comment"), node("b2", "step")] },
      ],
    });
    expect(flattenNodes([c]).map((n) => n.id)).toEqual(["case", "a1", "b2"]);
  });

  it("subloop 无法解析时原样保留", () => {
    const sub = makeSubloop("t2", "子模板", 2);
    expect(flattenNodes([sub]).map((n) => n.id)).toEqual([sub.id]);
    expect(flattenNodes([sub], () => null).map((n) => n.id)).toEqual([sub.id]);
    expect(flattenNodes([sub], () => template({ id: "t2" })).map((n) => n.id)).toEqual([sub.id]);
  });

  it("subloop 展开子模板节点，按 subloopRepeat 次数重复", () => {
    const sub = makeSubloop("t2", "子模板", 3);
    const t2 = template({ id: "t2", flowGraph: { version: 1, nodes: [node("s1", "step")], updatedAt: 0 } });
    expect(flattenNodes([sub], () => t2).map((n) => n.id)).toEqual(["s1", "s1", "s1"]);
  });

  it("subloopRepeat 为 0/未设置时至少展开一次", () => {
    const t2 = template({ id: "t2", flowGraph: { version: 1, nodes: [node("s1", "step")], updatedAt: 0 } });
    expect(flattenNodes([makeSubloop("t2", "子模板", 0)], () => t2).map((n) => n.id)).toEqual(["s1"]);
    expect(flattenNodes([makeSubloop("t2", "子模板")], () => t2).map((n) => n.id)).toEqual(["s1"]);
  });

  it("subloop 没有 subloopTemplateId 时原样保留", () => {
    const sub = node("sub_x", "subloop");
    expect(flattenNodes([sub], () => null).map((n) => n.id)).toEqual(["sub_x"]);
  });

  it("自引用子模板不会无限递归（visited 保护）", () => {
    const sub = makeSubloop("A", "A1", 1);
    const tA = template({ id: "A", flowGraph: { version: 1, nodes: [makeSubloop("A", "A2", 1)], updatedAt: 0 } });
    const out = flattenNodes([sub], () => tA);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("subloop");
    expect(out[0].subloopTemplateId).toBe("A");
  });

  it("多节点混合：注释被丢弃，分支被展开", () => {
    const out = flattenNodes([
      node("n1", "step"),
      node("c1", "comment"),
      node("if1", "ifelse", { branches: [{ id: "b", label: "是", nodes: [node("n2", "comment"), node("n3", "step")] }] }),
      node("n4", "step"),
    ]);
    expect(out.map((n) => n.id)).toEqual(["n1", "if1", "n3", "n4"]);
  });
});
