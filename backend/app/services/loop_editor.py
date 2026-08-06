#!/usr/bin/env python3
"""
CINSIDE LOOP 流程图编辑器 CLI
==============================
留给未来 AI/自动化调用的命令行入口。前端的 localStorage 数据可通过"导出 JSON"
功能保存到文件，用此 CLI 编辑后再"导入 JSON"回前端。

用法示例：
  # 列出模板中所有节点（树形）
  python loop_editor.py show template.json

  # 在指定节点后插入子LOOP
  python loop_editor.py insert-subloop template.json --after step_xxx --sub sub_loop.json --out out.json

  # 在指定节点后插入 IF/ELSE 节点
  python loop_editor.py insert-ifelse template.json --after step_xxx --out out.json

  # 在指定节点后插入 CASE 节点
  python loop_editor.py insert-case template.json --after step_xxx --cases "case1,case2,else" --out out.json

  # 复制一段节点（含分支内节点）到剪贴板文件
  python loop_editor.py copy template.json --from step_1 --to step_5 --out clip.json

  # 把剪贴板文件中的节点粘贴到指定节点之后
  python loop_editor.py paste template.json --after step_xxx --clip clip.json --out out.json

  # 删除节点
  python loop_editor.py delete template.json --node step_xxx --out out.json

  # 重置为线性流程图（去掉所有分支/子LOOP）
  python loop_editor.py reset template.json --out out.json

  # 给分支添加 case
  python loop_editor.py add-branch template.json --node case_xxx --label "new_case" --out out.json

  # 输出 Mermaid 流程图文本（用于文档/AI 理解）
  python loop_editor.py mermaid template.json
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any


# ---------- 数据结构（与前端 types.ts 对齐） ----------

def _nid(prefix: str = "n") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def build_linear_graph(tpl: dict) -> dict:
    """从 WorkflowTemplate 的 marks 构建线性流程图（与前端 buildLinearGraph 对齐）。"""
    nodes: list[dict] = []
    phases = [("data-source", tpl.get("dataSourceMarks") or [], "数据源")]
    mode = tpl.get("mode", "loop")
    if mode in ("review", "loop"):
        phases.append(("review", tpl.get("reviewMarks") or [], "审查"))
    if mode in ("entry", "loop"):
        phases.append(("entry", tpl.get("entryMarks") or [], "录入"))

    def _step_label(m: dict) -> str:
        label = m.get("label") or m.get("selector") or ""
        phase_tag = " [收尾]" if m.get("clickPhase") == "post" else (" [导航]" if m.get("clickPhase") == "pre" else "")
        if m.get("docExtract"):
            return f"📄 提取文件{phase_tag}: {label}"
        if m.get("docUpload"):
            return f"📎 上传文件{phase_tag}: {label}"
        if m.get("widget"):
            wk = "日历" if m["widget"].get("kind") == "calendar" else "选项"
            return f"🎛 {wk}控件{phase_tag}: {m['widget'].get('triggerLabel') or label}"
        if m.get("action") == "input" and m.get("variableField"):
            return f"⌨️ 填入「{m['variableField']}」→ {m.get('inputTargetLabel') or label}"
        if m.get("action") == "click":
            return f"🖱 点击{phase_tag}: {label}"
        if m.get("action") == "input":
            return f"⌨️ 输入{phase_tag}: {label}"
        return f"步骤: {label}"

    for key, marks, _label in phases:
        for m in sorted(marks, key=lambda x: x.get("order", 0)):
            nodes.append({
                "id": _nid("step"),
                "kind": "step",
                "label": _step_label(m),
                "markPhase": key,
                "markId": m.get("id"),
                "markSide": m.get("side"),
            })
    nodes.append({"id": _nid("loop"), "kind": "loopback", "label": "下一张卡片（回到开头）"})
    return {"version": 1, "nodes": nodes, "updatedAt": 0}


def ensure_graph(tpl: dict) -> dict:
    g = tpl.get("flowGraph")
    if g and isinstance(g.get("nodes"), list):
        return g
    return build_linear_graph(tpl)


# ---------- 节点查找 ----------

def find_node(nodes: list[dict], nid_: str):
    """返回 (node, parent_list, index, parent_branch, parent_node)。"""
    for i, n in enumerate(nodes):
        if n["id"] == nid_:
            return n, nodes, i, None, None
        for b in n.get("branches") or []:
            hit = find_node(b["nodes"], nid_)
            if hit:
                return hit[0], hit[1], hit[2], b, n
    return None


def clone_nodes(nodes: list[dict]) -> list[dict]:
    """深克隆节点并为所有节点/分支重新分配 id，返回新列表。"""
    id_map: dict[str, str] = {}

    def _ren(n: dict) -> dict:
        new_id = _nid(n.get("kind", "n")[:3])
        id_map[n["id"]] = new_id
        c = deepcopy(n)
        c["id"] = new_id
        if c.get("branches"):
            new_branches = []
            for b in c["branches"]:
                bc = deepcopy(b)
                bc["id"] = _nid("br")
                bc["nodes"] = [_ren(x) for x in b["nodes"]]
                new_branches.append(bc)
            c["branches"] = new_branches
        return c

    return [_ren(n) for n in nodes]


# ---------- 打印/可视化 ----------

def print_tree(nodes: list[dict], indent: int = 0):
    pad = "  " * indent
    for i, n in enumerate(nodes):
        kind = n.get("kind")
        label = n.get("label") or f"({kind})"
        prefix = "↳ " if indent else f"{i+1}. "
        print(f"{pad}{prefix}[{kind}] {label}  (id={n['id']})")
        if n.get("branches"):
            for b in n["branches"]:
                print(f"{pad}  ├─ 分支: {b.get('label')} (id={b['id']})")
                print_tree(b["nodes"], indent + 2)


def to_mermaid(nodes: list[dict], lines: list[str] | None = None, parent_end: str | None = None) -> list[str]:
    if lines is None:
        lines = ["flowchart TD"]
    prev_id = parent_end
    for n in nodes:
        nid = n["id"].replace("-", "_")
        label = (n.get("label") or n.get("kind") or "").replace('"', "'")
        shape = {
            "step": (f'{nid}["{label}"]', "rect"),
            "subloop": (f'{nid}[["{label}"]]', "sub"),
            "ifelse": (f'{nid}{{"{label}"}}', "diamond"),
            "case": (f'{nid}{{"{label}"}}', "diamond"),
            "comment": (f'{nid}>"{label}"]', "flag"),
            "loopback": (f'{nid}(("{label}"))', "circle"),
        }.get(n.get("kind"), (f'{nid}["{label}"]', "rect"))[0]
        lines.append("    " + shape)
        if prev_id:
            lines.append(f"    {prev_id.replace('-','_')} --> {nid}")
        if n.get("branches"):
            br_ends = []
            for b in n["branches"]:
                bid = b["id"].replace("-", "_")
                lines.append(f"    subgraph {bid}[{b.get('label')}]")
                br_end = _mermaid_sub(b["nodes"], lines, nid, bid)
                lines.append("    end")
                if br_end:
                    br_ends.append(br_end)
            if br_ends:
                merge_id = _nid("m").replace("-", "_")
                lines.append(f"    {merge_id}(( ))")
                for e in br_ends:
                    lines.append(f"    {e} --> {merge_id}")
                prev_id = merge_id
                continue
        prev_id = nid
    return lines


def _mermaid_sub(nodes, lines, enter_from, subgid) -> str | None:
    prev = None
    for n in nodes:
        nid = n["id"].replace("-", "_")
        label = (n.get("label") or n.get("kind") or "").replace('"', "'")
        if n.get("kind") == "ifelse" or n.get("kind") == "case":
            shape = f'{nid}{{"{label}"}}'
        elif n.get("kind") == "loopback":
            shape = f'{nid}(("🔄 {label}"))'
        elif n.get("kind") == "subloop":
            shape = f'{nid}[["🔁 {label}"]]'
        elif n.get("kind") == "comment":
            shape = f'{nid}>💬 {label}]'
        else:
            shape = f'{nid}["{label}"]'
        lines.append("        " + shape)
        if prev is None:
            lines.append(f"    {enter_from.replace('-','_')} --> {nid}")
        else:
            lines.append(f"        {prev} --> {nid}")
        prev = nid
        if n.get("branches"):
            for b in n["branches"]:
                bid = b["id"].replace("-", "_")
                lines.append(f"        subgraph {bid}[{b.get('label')}]")
                be = _mermaid_sub(b["nodes"], lines, nid, bid)
                lines.append("        end")
                if be:
                    merge = _nid("m").replace("-", "_")
                    lines.append(f"        {merge}(( ))")
                    lines.append(f"        {be} --> {merge}")
                    prev = merge
    return prev


# ---------- 编辑操作 ----------

def cmd_show(tpl: dict, _args) -> None:
    g = ensure_graph(tpl)
    print(f"LOOP: {tpl.get('name')}  (mode={tpl.get('mode')}, nodes={_count(g['nodes'])})")
    print("-" * 60)
    print_tree(g["nodes"])


def cmd_mermaid(tpl: dict, _args) -> None:
    g = ensure_graph(tpl)
    lines = to_mermaid(g["nodes"])
    # 闭环回线：最后一个节点 -> 第一个节点
    if g["nodes"]:
        first_id = g["nodes"][0]["id"].replace("-", "_")
        last_id = g["nodes"][-1]["id"].replace("-", "_")
        lines.append(f"    {last_id} -.->|下一张| {first_id}")
    print("\n".join(lines))


def _require_after(g: dict, after_id: str):
    hit = find_node(g["nodes"], after_id)
    if not hit:
        sys.exit(f"ERROR: node not found: {after_id}")
    return hit


def cmd_insert_subloop(tpl: dict, args) -> dict:
    g = deepcopy(ensure_graph(tpl))
    _n, parent, idx, _, _ = _require_after(g, args.after)
    sub_tpl = _load_template(args.sub)
    sub_g = ensure_graph(sub_tpl)
    node = {
        "id": _nid("sub"),
        "kind": "subloop",
        "label": f"🔁 子LOOP: {sub_tpl.get('name', 'unknown')}",
        "subloopTemplateId": sub_tpl.get("id"),
        "subloopRepeat": 1,
        # 保存子流程图快照（未来执行可直接展开）
        "_embeddedGraph": sub_g,
    }
    parent.insert(idx + 1, node)
    g["updatedAt"] = _now()
    return _finalize(tpl, g, args)


def cmd_insert_ifelse(tpl: dict, args) -> dict:
    g = deepcopy(ensure_graph(tpl))
    _n, parent, idx, _, _ = _require_after(g, args.after)
    node = {
        "id": _nid("if"),
        "kind": "ifelse",
        "label": "❓ IF/ELSE",
        "branches": [
            {"id": _nid("br"), "label": "是 (IF)", "nodes": []},
            {"id": _nid("br"), "label": "否 (ELSE)", "nodes": []},
        ],
    }
    parent.insert(idx + 1, node)
    g["updatedAt"] = _now()
    return _finalize(tpl, g, args)


def cmd_insert_case(tpl: dict, args) -> dict:
    g = deepcopy(ensure_graph(tpl))
    _n, parent, idx, _, _ = _require_after(g, args.after)
    cases = [c.strip() for c in args.cases.split(",") if c.strip()]
    if not cases:
        cases = ["case1", "else"]
    node = {
        "id": _nid("case"),
        "kind": "case",
        "label": "🔀 SWITCH/CASE",
        "branches": [{"id": _nid("br"), "label": c, "nodes": []} for c in cases],
    }
    parent.insert(idx + 1, node)
    g["updatedAt"] = _now()
    return _finalize(tpl, g, args)


def cmd_copy(tpl: dict, args) -> None:
    g = ensure_graph(tpl)
    h1 = find_node(g["nodes"], args.frm)
    h2 = find_node(g["nodes"], args.to)
    if not h1 or not h2:
        sys.exit(f"ERROR: range node not found (from={args.frm}, to={args.to})")
    if h1[1] is not h2[1]:
        sys.exit("ERROR: copy range must be within the same parent list (cross-branch copy not supported yet)")
    parent = h1[1]
    i1, i2 = h1[2], h2[2]
    lo, hi = (i1, i2) if i1 <= i2 else (i2, i1)
    seg = deepcopy(parent[lo:hi + 1])
    cloned = clone_nodes(seg)
    out = {"version": 1, "kind": "clipboard", "nodes": cloned}
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Copied {len(cloned)} nodes to {args.out}")


def cmd_paste(tpl: dict, args) -> dict:
    g = deepcopy(ensure_graph(tpl))
    _n, parent, idx, _, _ = _require_after(g, args.after)
    clip = json.loads(Path(args.clip).read_text(encoding="utf-8"))
    nodes = clip.get("nodes", [])
    cloned = clone_nodes(nodes)
    for c in reversed(cloned):
        parent.insert(idx + 1, c)
    g["updatedAt"] = _now()
    return _finalize(tpl, g, args)


def cmd_delete(tpl: dict, args) -> dict:
    g = deepcopy(ensure_graph(tpl))
    hit = find_node(g["nodes"], args.node)
    if not hit:
        sys.exit(f"ERROR: node not found: {args.node}")
    if hit[0].get("kind") == "loopback":
        sys.exit("ERROR: loopback node cannot be deleted (visual loop closure)")
    hit[1].pop(hit[2])
    g["updatedAt"] = _now()
    return _finalize(tpl, g, args)


def cmd_reset(tpl: dict, args) -> dict:
    g = build_linear_graph(tpl)
    return _finalize(tpl, g, args)


def cmd_add_branch(tpl: dict, args) -> dict:
    g = deepcopy(ensure_graph(tpl))
    hit = find_node(g["nodes"], args.node)
    if not hit:
        sys.exit(f"ERROR: node not found: {args.node}")
    n = hit[0]
    if n.get("kind") not in ("case",):
        sys.exit("ERROR: --add-branch only applies to case nodes")
    n.setdefault("branches", []).append({"id": _nid("br"), "label": args.label, "nodes": []})
    g["updatedAt"] = _now()
    return _finalize(tpl, g, args)


# ---------- 辅助 ----------

def _count(nodes) -> int:
    c = 0
    for n in nodes:
        c += 1
        for b in n.get("branches") or []:
            c += _count(b["nodes"])
    return c


def _now() -> int:
    import time
    return int(time.time() * 1000)


def _load_template(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        sys.exit(f"ERROR: template file not found: {path}")
    return json.loads(p.read_text(encoding="utf-8"))


def _finalize(tpl: dict, g: dict, args) -> dict:
    tpl = deepcopy(tpl)
    tpl["flowGraph"] = g
    if args.out:
        Path(args.out).write_text(json.dumps(tpl, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {args.out} (nodes={_count(g['nodes'])})")
    return tpl


# ---------- CLI 入口 ----------

def main(argv: list[str] | None = None):
    ap = argparse.ArgumentParser(description="CINSIDE LOOP flow editor CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(p, need_out: bool = True):
        p.add_argument("template", help="Path to the exported WorkflowTemplate JSON file")
        if need_out:
            p.add_argument("--out", help="Output JSON file path")

    p_show = sub.add_parser("show", help="Print the flow tree")
    add_common(p_show, need_out=False)

    p_mmd = sub.add_parser("mermaid", help="Print Mermaid flowchart source")
    add_common(p_mmd, need_out=False)

    p_sub = sub.add_parser("insert-subloop", help="Insert a sub-loop node after a given node")
    add_common(p_sub); p_sub.add_argument("--after", required=True); p_sub.add_argument("--sub", required=True, help="Sub-loop template JSON path")

    p_ife = sub.add_parser("insert-ifelse", help="Insert an IF/ELSE branch node")
    add_common(p_ife); p_ife.add_argument("--after", required=True)

    p_case = sub.add_parser("insert-case", help="Insert a SWITCH/CASE branch node")
    add_common(p_case); p_case.add_argument("--after", required=True); p_case.add_argument("--cases", default="case1,case2,else")

    p_cp = sub.add_parser("copy", help="Copy a range of nodes to a clipboard JSON file")
    add_common(p_cp, need_out=False); p_cp.add_argument("--from", dest="frm", required=True); p_cp.add_argument("--to", required=True); p_cp.add_argument("--out", required=True)

    p_p = sub.add_parser("paste", help="Paste a clipboard JSON after a node")
    add_common(p_p); p_p.add_argument("--after", required=True); p_p.add_argument("--clip", required=True)

    p_del = sub.add_parser("delete", help="Delete a node")
    add_common(p_del); p_del.add_argument("--node", required=True)

    p_rst = sub.add_parser("reset", help="Reset to linear flow (drop all branches/sub-loops)")
    add_common(p_rst)

    p_ab = sub.add_parser("add-branch", help="Add a branch to a case node")
    add_common(p_ab); p_ab.add_argument("--node", required=True); p_ab.add_argument("--label", required=True)

    args = ap.parse_args(argv)
    tpl = _load_template(args.template)

    if args.cmd == "show":
        cmd_show(tpl, args)
    elif args.cmd == "mermaid":
        cmd_mermaid(tpl, args)
    elif args.cmd == "insert-subloop":
        cmd_insert_subloop(tpl, args)
    elif args.cmd == "insert-ifelse":
        cmd_insert_ifelse(tpl, args)
    elif args.cmd == "insert-case":
        cmd_insert_case(tpl, args)
    elif args.cmd == "copy":
        cmd_copy(tpl, args)
    elif args.cmd == "paste":
        cmd_paste(tpl, args)
    elif args.cmd == "delete":
        cmd_delete(tpl, args)
    elif args.cmd == "reset":
        cmd_reset(tpl, args)
    elif args.cmd == "add-branch":
        cmd_add_branch(tpl, args)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
