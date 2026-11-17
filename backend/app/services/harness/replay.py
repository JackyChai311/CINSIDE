"""工作流固化与批量回放：HARNESS 只开荒，CINSIDE 工具跑量。

流程（scheduler._execute 编排）：
  1. 开荒：HARNESS 用 LLM 把名单**第一条**真实跑通，动作被记录成配方（recipe）；
  2. 固化：把记录里的页面引用（e1/e2）解析成稳定 CSS 选择器，行相关值换成 {列名} 占位符；
  3. 回放：其余每一条不再过 LLM —— replay_recipe 逐条替换占位符、按选择器直接执行；
  4. 介入：某条回放失败 → 交回 HARNESS（LLM）处理该条，并把修好的动作更新回配方。

配方 step 形态：
  {"tool": "web_type", "args": {"selector": "#name", "text": "{姓名}"}, "desc": "填姓名"}
  {"tool": "web_click", "args": {"selector": "#submit"}, "desc": "提交"}
  {"tool": "web_press", "args": {"key": "Enter"}}
  {"tool": "web_navigate", "args": {"url": "https://..."}}
  {"tool": "web_wait", "args": {"selector": ".success", "timeout": 8}}
  {"tool": "excel_write", "args": {"updates": [{"cell": "状态{__row__}", "value": "已录入"}]}}
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Awaitable, Callable

from .excel_book import ExcelTarget
from .web import WebTarget

Emit = Callable[[dict], Awaitable[None]]

# 开荒阶段允许录制的工具（其余动作如 observe/screenshot 不进配方）
_RECORDABLE = {
    "web_click", "web_type", "web_select", "web_press", "web_navigate",
    "excel_write", "excel_fill_column", "excel_append_row",
}


class RecipeRecorder:
    """记录开荒 run 的工具调用，供固化成配方。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def record(self, name: str, args: dict, result: dict) -> None:
        if name not in _RECORDABLE:
            return
        if not result.get("ok", False):
            return
        self.calls.append({"tool": name, "args": dict(args or {})})


# ---------- ref → 稳定选择器 ----------

_SELECTOR_JS = (
    "(() => {"
    "  const ref = __REF__;"
    "  const el = document.querySelector('[data-cinside-ref=\"' + ref + '\"]');"
    "  if (!el) return { ok: false };"
    "  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');"
    "  // 1) id 直达"
    "  if (el.id) return { ok: true, selector: '#' + esc(el.id) };"
    "  // 2) name 属性（表单控件最常见）"
    "  const nm = el.getAttribute('name');"
    "  if (nm) {"
    "    const s = el.tagName.toLowerCase() + '[name=\"' + nm.replace(/\"/g, '\\\\\"') + '\"]';"
    "    if (document.querySelectorAll(s).length === 1) return { ok: true, selector: s };"
    "  }"
    "  // 3) 唯一文本（按钮/链接）"
    "  const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();"
    "  if (txt && txt.length <= 30 && /^(BUTTON|A|SUMMARY|LABEL)$/.test(el.tagName)) {"
    "    const same = Array.from(document.querySelectorAll(el.tagName.toLowerCase()))"
    "      .filter((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim() === txt);"
    "    if (same.length === 1) return { ok: true, selector: el.tagName.toLowerCase(), text: txt };"
    "  }"
    "  // 4) 结构路径兜底（nth-of-type 链，最多 6 层）"
    "  const parts = [];"
    "  let cur = el;"
    "  while (cur && cur.nodeType === 1 && parts.length < 6) {"
    "    if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }"
    "    let part = cur.tagName.toLowerCase();"
    "    const parent = cur.parentElement;"
    "    if (parent) {"
    "      const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);"
    "      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';"
    "    }"
    "    parts.unshift(part);"
    "    cur = parent;"
    "  }"
    "  return { ok: true, selector: parts.join(' > ') };"
    "})()"
)


async def resolve_selector(web: WebTarget, ref: str) -> dict | None:
    """把开荒时的 e-ref 解析成可跨行复用的选择器（或唯一文本）。"""
    try:
        page = await web.page()
        js = _SELECTOR_JS.replace("__REF__", json.dumps(ref, ensure_ascii=False))
        info = await page.evaluate(js)
        if isinstance(info, dict) and info.get("ok"):
            return info
    except Exception:  # noqa: BLE001 - 解析失败该步不进配方，回放时由 HARNESS 兜底
        pass
    return None


# ---------- 固化 ----------

_PLACEHOLDER_RE = re.compile(r"\{([^{}]+)\}")


def _templatize(value: Any, row: dict[str, str]) -> Any:
    """把开荒第一条里出现的行值替换成 {列名} 占位符。"""
    if isinstance(value, str):
        out = value
        for col, cell in row.items():
            cell = str(cell).strip()
            if cell and len(cell) >= 2 and cell in out:
                out = out.replace(cell, "{" + col + "}")
        return out
    if isinstance(value, dict):
        return {k: _templatize(v, row) for k, v in value.items()}
    if isinstance(value, list):
        return [_templatize(v, row) for v in value]
    return value


async def solidify(
    recorder: RecipeRecorder,
    web: WebTarget | None,
    first_row: dict[str, str],
) -> list[dict]:
    """开荒记录 → 配方：ref 换选择器、行值换占位符。"""
    steps: list[dict] = []
    for call in recorder.calls:
        tool = call["tool"]
        args = dict(call["args"])
        if tool.startswith("web_") and "ref" in args:
            sel = await resolve_selector(web, str(args.get("ref") or "")) if web is not None else None
            if not sel:
                # 解析不到稳定定位：这一步保留 ref 版本，回放遇到就交 HARNESS
                steps.append({"tool": tool, "args": _templatize(args, first_row), "unstable": True})
                continue
            args.pop("ref", None)
            args["selector"] = sel.get("selector") or ""
            if sel.get("text"):
                args["text_match"] = sel["text"]
        steps.append({"tool": tool, "args": _templatize(args, first_row)})
    return steps


# ---------- 回放 ----------


def _fill(value: Any, row: dict[str, str], row_no: int) -> Any:
    if isinstance(value, str):
        out = value.replace("{__row__}", str(row_no))
        def sub(m: re.Match) -> str:
            key = m.group(1)
            return str(row.get(key, m.group(0)))
        return _PLACEHOLDER_RE.sub(sub, out)
    if isinstance(value, dict):
        return {k: _fill(v, row, row_no) for k, v in value.items()}
    if isinstance(value, list):
        return [_fill(v, row, row_no) for v in value]
    return value


async def _locate(web: WebTarget, args: dict) -> str:
    """选择器/文本 → 临时 ref（每次回放重新定位，页面刷新也不怕）。"""
    page = await web.page()
    selector = str(args.get("selector") or "")
    text_match = str(args.get("text_match") or "")
    js = (
        "(() => {"
        "  const sel = __SEL__, txt = __TXT__;"
        "  let el = null;"
        "  if (sel) el = document.querySelector(sel);"
        "  if (!el && txt) {"
        "    el = Array.from(document.querySelectorAll('button,a,summary,label,[role=button]'))"
        "      .find((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim() === txt) || null;"
        "  }"
        "  if (!el) return { ok: false, error: '回放定位失败：' + (sel || txt) };"
        "  const ref = 'rp' + Math.random().toString(36).slice(2, 8);"
        "  el.setAttribute('data-cinside-ref', ref);"
        "  return { ok: true, ref };"
        "})()"
    ).replace("__SEL__", json.dumps(selector, ensure_ascii=False)).replace(
        "__TXT__", json.dumps(text_match, ensure_ascii=False)
    )
    info = await page.evaluate(js)
    if not isinstance(info, dict) or not info.get("ok"):
        raise RuntimeError((info or {}).get("error") or "回放定位失败")
    return str(info["ref"])


async def replay_row(
    steps: list[dict],
    row: dict[str, str],
    row_no: int,
    *,
    web: WebTarget | None,
    excel: ExcelTarget | None,
    emit: Emit,
    index: int,
    total: int,
) -> dict:
    """按配方回放一条（不经过 LLM）。返回 {ok, failed_step, error}。"""
    for i, step in enumerate(steps):
        tool = step["tool"]
        args = _fill(step.get("args") or {}, row, row_no)
        await emit({
            "type": "tool_call", "id": f"replay-{index}-{i}", "name": tool,
            "args": args, "summary": f"回放 {index}/{total} · {step.get('desc') or tool}",
            "step": index,
        })
        try:
            if step.get("unstable"):
                raise RuntimeError("该步没有稳定定位，需要 HARNESS 介入")
            if tool == "web_wait":
                if web is None:
                    raise RuntimeError("未绑定网页")
                deadline = asyncio.get_event_loop().time() + float(args.get("timeout") or 8)
                while asyncio.get_event_loop().time() < deadline:
                    try:
                        await _locate(web, args)
                        break
                    except RuntimeError:
                        await asyncio.sleep(0.5)
                else:
                    raise RuntimeError("等待元素超时")
                result = {"ok": True}
            elif tool.startswith("web_"):
                if web is None:
                    raise RuntimeError("未绑定网页")
                if tool in ("web_click", "web_type", "web_select"):
                    args["ref"] = await _locate(web, args)
                if tool == "web_click":
                    result = await web.click(args["ref"], click_count=int(args.get("times") or 1))
                elif tool == "web_type":
                    result = await web.type_text(
                        args["ref"], str(args.get("text") or ""),
                        clear=bool(args.get("clear", True)), submit=bool(args.get("submit", False)),
                    )
                elif tool == "web_select":
                    result = await web.select(args["ref"], str(args.get("value") or ""))
                elif tool == "web_press":
                    result = await web.press(str(args.get("key") or "Enter"), times=int(args.get("times") or 1))
                elif tool == "web_navigate":
                    result = await web.navigate(str(args.get("url") or ""))
                    await asyncio.sleep(1.0)
                else:
                    raise RuntimeError(f"配方含不支持的网页动作：{tool}")
            elif tool.startswith("excel_"):
                if excel is None:
                    raise RuntimeError("未绑定表格")
                if tool == "excel_write":
                    result = await excel.write(args.get("updates") or [])
                elif tool == "excel_fill_column":
                    result = await excel.fill_column(
                        str(args.get("sheet") or ""), str(args.get("column") or ""),
                        args.get("values") or [], int(args.get("start_row") or 0),
                    )
                elif tool == "excel_append_row":
                    result = await excel.append_row(str(args.get("sheet") or ""), args.get("values") or [])
                else:
                    raise RuntimeError(f"配方含不支持的表格动作：{tool}")
            else:
                raise RuntimeError(f"配方含未知动作：{tool}")
            if not result.get("ok", False):
                raise RuntimeError(str(result.get("error") or "动作失败"))
            await emit({
                "type": "tool_result", "id": f"replay-{index}-{i}", "name": tool,
                "ok": True, "durationMs": 0, "result": {"ok": True}, "step": index,
            })
            await asyncio.sleep(0.25)
        except Exception as e:  # noqa: BLE001 - 单步失败即整条失败，交 HARNESS 介入
            await emit({
                "type": "tool_result", "id": f"replay-{index}-{i}", "name": tool,
                "ok": False, "durationMs": 0, "result": {"ok": False, "error": str(e)}, "step": index,
            })
            return {"ok": False, "failed_step": i, "error": str(e)}
    return {"ok": True, "failed_step": -1, "error": ""}


# ---------- 名单 ----------


async def read_roster(excel: ExcelTarget) -> tuple[list[str], list[dict[str, str]]]:
    """读表格第一张工作表为任务名单：返回 (列名, 行字典列表)。表头行本身不算数据。

    默认 read 只返回 400 行 × 前若干列；名单可能更宽/更长——
    这里按工作表实际行列数分段读全，避免「Excel 里明明有但 HARNESS 没看见」。
    """
    summary = await excel.summary()
    sheets = summary.get("sheets") or []
    first = sheets[0] if sheets else {}
    total_rows = int(first.get("rows") or 0) + int(first.get("header_row") or 1)
    total_cols = max(1, int(first.get("cols") or 1))
    from .excel_book import MAX_READ_ROWS, index_to_col

    header: list[str] = []
    rows: list[dict[str, str]] = []
    last_col = index_to_col(min(total_cols, 200))
    start = 1
    while start <= max(total_rows, 1):
        end = min(start + MAX_READ_ROWS - 1, max(total_rows, 1))
        data = await excel.read(cell_range=f"A{start}:{last_col}{end}", with_header=(start == 1))
        if start == 1:
            header = [str(h).strip() for h in (data.get("header") or [])]
        for raw in data.get("rows") or []:
            # 每行首元素是起始单元格地址（A2），跳过
            vals = raw[1:] if raw and re.fullmatch(r"[A-Z]+\d+", str(raw[0])) else raw
            row = {header[i] if i < len(header) else f"列{i+1}": ("" if v is None else str(v)) for i, v in enumerate(vals)}
            if not any(str(v).strip() for v in row.values()):
                continue
            # 表头行被 read 一并返回时剔除（与 header 完全一致的行）
            if header and [str(row.get(h, "")).strip() for h in header] == [h.strip() for h in header]:
                continue
            rows.append(row)
        if end >= total_rows:
            break
        start = end + 1
    return header, rows