"""HARNESS 的「先出流程，再执行」。

为什么要这一层：
  直接开跑的话，用户只能等结果出来才知道它打算怎么干，错了要重来。
  这里先用真实观察到的页面结构 + 表格结构，让模型把动作拆成一条可读的步骤清单
  （和站内拾取的 点击/输入 步骤同一种心智模型），用户逐条核对、手改、或者让模型改，
  确认之后才落成待执行卡片。

注意：计划是**契约**不是脚本。执行时 HARNESS 仍然每步观察页面，实际与计划不符时
以实际为准，并在结束汇报里说明偏差。
"""
from __future__ import annotations

import json
import re
from typing import Any

from . import runner
from .cdp import CDPError
from .excel_book import ExcelError, ExcelTarget
from .web import WebTarget

# 计划里允许的动作，与前端下拉保持一致
ACTIONS = [
    "click",
    "input",
    "select",
    "press",
    "scroll",
    "navigate",
    "extract",
    "write",
    "verify",
    "wait",
    "render",
    "narrate",
    "compose",
    "export",
]

_ACTION_DOC = """- click   点击某个按钮/标签/链接
- input   在某个输入框里填入内容
- select  在某个下拉框里选择选项
- press   按键盘键（回车、Tab、Esc）
- scroll  滚动页面去找目标
- navigate 打开某个地址
- extract 从页面抽取结构化数据（表格/列表/正文）
- write   往 Excel 写数据（单元格、整列、追加行、新建工作表）；slide 任务=改 PPT 文字/加页；cowork 任务=写成果文件
- verify  核对网页与表格是否一致
- wait    等页面加载/等提示出现
- render  （slide）把某页 PPT 渲染成画面图片
- narrate （slide）为某页生成 TTS 解说配音
- compose （slide）把逐页画面+配音合成 MP4 视频
- export  交付成果文件（PPT / 视频 / 协作文档）"""

_PLAN_PROMPT = """你是 HARNESS 的**流程规划器**。用户给一个任务，你要把它拆成一条可读、可核对的执行流程。

## 对象事实（真实观察所得，不要凭空编造元素）
{context}

## 可用的动作类型（action 只能取这些值）
{actions}

## 输出要求
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{{
  "title": "一句话概括这趟要干什么（不超过 30 字）",
  "steps": [
    {{
      "action": "click",
      "side": "web",
      "target": "左侧「学生管理」标签",
      "value": "",
      "note": "切到学生列表；若已在列表页可跳过"
    }}
  ],
  "risks": ["表单有必填校验，提交前需确认没有漏填"],
  "questions": ["是否需要提交？如果只是暂存请说明"]
}}

规则：
1. **4~12 步**，每步只做一件事；能一步批量做的（比如一次抽取整表）不要拆成十步。
2. `side` 只能是 `web`（网页侧）/ `excel`（表格侧）/ `slide`（PPT）/ `video`（视频合成）/ `workspace`（协作成果文件），指明这步作用在哪个对象上。
3. `target` 用人话指向具体元素（用上面事实里的按钮名/字段名/列名），不要写 CSS 选择器。
4. `value` 写要填的值、抽取范围或写入位置；不需要就留空。
5. `note` 写这一步的判断依据或失败风险，一句话即可。
6. 数据搬运类任务，必须体现「先抽取 → 再写入」的顺序，并说明写入的起点行/列。
7. `risks` 写真实存在的风险（校验、弹窗、登录、覆盖数据）；没有就给空数组。
8. `questions` 只在**真的**影响执行方向时才问（例如「要不要点提交」）；没有就给空数组。
"""

_REVISE_PROMPT = """你是 HARNESS 的流程规划器。用户对当前流程提出了修改意见，请给出修改后的完整流程。

## 对象事实
{context}

## 当前流程
{plan}

## 用户的修改意见
{request}

只输出一个 JSON 对象（不要解释、不要代码块）：
{{
  "title": "...",
  "steps": [ ...完整的新步骤列表，不是增量... ],
  "risks": [...],
  "questions": [...],
  "changes": ["把第 3 步从「滚动找表格」改成「直接抽取整表」", "增加了提交前核对一步"]
}}

规则同前：4~12 步，只做必要的改动，没被要求改的步骤保持原样。
"""


def _extract_json(text: str) -> dict:
    """从模型回复里抠出第一个完整 JSON 对象（容忍 ```json 围栏与前后废话）。"""
    if not text:
        raise ValueError("模型返回了空内容")
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"模型没有返回 JSON：{text[:200]}")
    candidate = raw[start : end + 1]
    try:
        return json.loads(candidate)
    except ValueError:
        # 常见脏数据：尾逗号 / 中文引号
        fixed = re.sub(r",\s*([}\]])", r"\1", candidate).replace("“", '"').replace("”", '"')
        return json.loads(fixed)


def _normalize_plan(data: dict) -> dict:
    """把模型输出收敛成前端能直接渲染的结构（缺字段补默认、动作非法则降级）。"""
    steps_in = data.get("steps")
    if not isinstance(steps_in, list):
        steps_in = []
    steps: list[dict] = []
    for i, raw in enumerate(steps_in[:20]):
        if not isinstance(raw, dict):
            continue
        action = str(raw.get("action") or "").strip().lower()
        if action not in ACTIONS:
            action = "click"
        side = str(raw.get("side") or "").strip().lower()
        if side not in ("web", "excel", "slide", "video", "workspace"):
            side = "web"
        steps.append(
            {
                "id": f"s{i + 1}",
                "action": action,
                "side": side,
                "target": str(raw.get("target") or "").strip()[:200],
                "value": str(raw.get("value") or "").strip()[:300],
                "note": str(raw.get("note") or "").strip()[:300],
            }
        )
    title = str(data.get("title") or "").strip()[:60]
    risks = [str(x)[:200] for x in (data.get("risks") or []) if str(x).strip()][:6]
    questions = [str(x)[:200] for x in (data.get("questions") or []) if str(x).strip()][:6]
    changes = [str(x)[:200] for x in (data.get("changes") or []) if str(x).strip()][:8]
    return {
        "title": title or "（未命名流程）",
        "steps": steps,
        "risks": risks,
        "questions": questions,
        "changes": changes,
    }


# ---------- 观察：让计划贴着真实界面，而不是模型想象 ----------


async def _observe_context(
    web: dict | None, excel: dict | None, slide: dict | None = None, studio: str = "web"
) -> tuple[str, dict]:
    """返回（给模型看的事实文本，给前端看的观察摘要）。"""
    from ...config import settings

    facts: list[str] = []
    meta: dict[str, Any] = {"web": None, "excel": None, "slide": None}

    if web:
        endpoint = settings.effective_harness_cdp()
        if not endpoint:
            facts.append("（网页对象已选择，但当前没有 CDP 端点：无法读取真实页面结构）")
        else:
            target = WebTarget(
                endpoint,
                str(web.get("url") or ""),
                label=str(web.get("label") or "网页"),
                exclude_urls=list(web.get("exclude_urls") or []),
            )
            try:
                snap = await target.observe(max_elements=60, max_text=1500)
                els = snap.get("elements") or []
                lines = [
                    f"- 页面：{snap.get('title') or '（无标题）'} · {snap.get('url')}",
                    f"- 可见正文（截断）：{(snap.get('text') or '')[:900]}",
                    "- 可交互元素（前 40 个）：",
                ]
                for e in els[:40]:
                    name = (e.get("name") or "").strip()[:40]
                    extra = ""
                    if e.get("value"):
                        extra = f" 当前值={str(e.get('value'))[:30]}"
                    elif e.get("options"):
                        extra = f" 选项={'/'.join(str(o.get('t')) for o in (e.get('options') or [])[:6])}"
                    lines.append(f"    · [{e.get('role')}] {name}{extra}")
                heads = [h.get("text") for h in (snap.get("headings") or []) if h.get("text")]
                if heads:
                    lines.append(f"- 页面分区标题：{'、'.join(heads[:8])}")
                facts.append("\n".join(lines))
                meta["web"] = {
                    "title": snap.get("title") or "",
                    "url": snap.get("url") or "",
                    "elements": snap.get("total_interactive") or len(els),
                }
            except CDPError as e:
                facts.append(f"（读取网页失败：{e}）")
            finally:
                await target.aclose()

    if excel:
        target_x = ExcelTarget(
            str(excel.get("path") or ""),
            work_dir=runner._work_dir("plan"),  # noqa: SLF001 - 复用同一套工作副本目录约定
            label=str(excel.get("label") or "Excel"),
        )
        try:
            summary = await target_x.summary()
            sheets = summary.get("sheets") or []
            lines = [f"- 工作簿：{summary.get('file')}（共 {len(sheets)} 个工作表）"]
            for s in sheets[:4]:
                lines.append(
                    f"    · 「{s['name']}」{s['rows']} 行 × {s['cols']} 列，表头：{'、'.join(s['headers'][:14]) or '（无）'}"
                )
            facts.append("\n".join(lines))
            meta["excel"] = {
                "file": summary.get("file") or "",
                "sheets": [s["name"] for s in sheets[:6]],
                "rows": sheets[0]["rows"] if sheets else 0,
            }
        except ExcelError as e:
            facts.append(f"（读取表格失败：{e}）")

    if slide:
        from .slide import SlideError, SlideTarget

        target_s = SlideTarget(
            str(slide.get("path") or ""),
            work_dir=runner._work_dir("plan"),  # noqa: SLF001
            label=str(slide.get("label") or "PPT"),
        )
        try:
            summary = await target_s.open()
            titles = summary.get("titles") or []
            lines = [
                f"- PPT：{summary.get('file')}，共 {summary.get('slides')} 页",
                f"- 各页标题：{'、'.join(str(t)[:30] for t in titles[:24])}",
                f"- 正文摘要：{(summary.get('text_preview') or '')[:800]}",
            ]
            facts.append("\n".join(lines))
            meta["slide"] = {
                "file": summary.get("file") or "",
                "slides": summary.get("slides") or 0,
            }
        except SlideError as e:
            facts.append(f"（读取 PPT 失败：{e}）")

    if studio == "slide":
        from ..video_maker import find_ffmpeg

        ffmpeg_ok = bool(find_ffmpeg())
        facts.append(
            "- 视频合成能力：逐页截图 + Windows TTS 配音 + ffmpeg 合成 MP4"
            + ("（ffmpeg 已就绪）" if ffmpeg_ok else "（ffmpeg 未安装：计划里要提示用户到设置页一键下载）")
        )
    if studio == "cowork":
        facts.append(
            "- 协作工作区：本次任务在专属工作目录里产出成果文件（file_write 写入、file_export 交付），"
            "没有网页/表格对象，不要规划 web/excel 步骤"
        )

    if not facts:
        facts.append("（本次没有可用对象）")
    return "\n\n".join(facts), meta


async def _chat_plain(messages: list[dict]) -> str:
    from ...config import settings

    base, key, model = settings.effective_harness_llm()
    if not (base and key and model):
        raise RuntimeError(
            "未配置可用的 LLM：HARNESS 与「全局分析 AI」共用配置，"
            "请到「设置 → AI → 全局分析 AI」填写 API 地址、Key 与模型"
        )
    reply = await runner._chat(base, key, model, messages, [], vision=False)  # noqa: SLF001
    if reply.get("error"):
        raise RuntimeError(reply["error"])
    msg = reply.get("message") or {}
    content = msg.get("content") or ""
    if isinstance(content, list):
        content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return str(content)


async def draft_plan(
    instruction: str,
    web: dict | None,
    excel: dict | None,
    slide: dict | None = None,
    studio: str = "web",
) -> dict:
    context, meta = await _observe_context(web, excel, slide, studio)
    prompt = _PLAN_PROMPT.format(context=context, actions=_ACTION_DOC)
    content = await _chat_plain(
        [
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"# 任务\n{instruction}"},
        ]
    )
    plan = _normalize_plan(_extract_json(content))
    plan["context"] = meta
    plan["studio"] = studio
    return plan


async def revise_plan(
    plan: dict,
    request: str,
    web: dict | None,
    excel: dict | None,
    slide: dict | None = None,
    studio: str = "web",
) -> dict:
    context, meta = await _observe_context(web, excel, slide, studio)
    current = {k: plan.get(k) for k in ("title", "steps", "risks", "questions")}
    prompt = _REVISE_PROMPT.format(
        context=context,
        plan=json.dumps(current, ensure_ascii=False, indent=1),
        request=request,
    )
    content = await _chat_plain(
        [
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"# 任务\n{plan.get('instruction') or ''}\n\n# 修改意见\n{request}"},
        ]
    )
    new_plan = _normalize_plan(_extract_json(content))
    new_plan["context"] = meta
    new_plan["studio"] = studio
    return new_plan


def plan_as_prompt(plan: dict) -> str:
    """把用户确认过的计划渲染成给执行器看的文本。"""
    steps = plan.get("steps") or []
    if not steps:
        return ""
    lines = [f"用户已确认执行流程（{len(steps)} 步）："]
    acts = {
        "click": "点击",
        "input": "输入",
        "select": "选择",
        "press": "按键",
        "scroll": "滚动",
        "navigate": "打开",
        "extract": "抽取",
        "write": "写入",
        "verify": "核对",
        "wait": "等待",
        "render": "渲染画面",
        "narrate": "生成配音",
        "compose": "合成视频",
        "export": "交付文件",
    }
    sides = {"web": "网页", "excel": "表格", "slide": "PPT", "video": "视频", "workspace": "工作区"}
    for i, s in enumerate(steps, 1):
        side = sides.get(str(s.get("side") or "web"), "网页")
        text = f"{i}. [{side}] {acts.get(s.get('action'), s.get('action'))}：{s.get('target') or ''}"
        if s.get("value"):
            text += f"（值/范围：{s['value']}）"
        if s.get("note"):
            text += f" — {s['note']}"
        lines.append(text)
    lines.append(
        "执行时严格按这个顺序走。若实际页面与计划不符（元素找不到、字段名不同），"
        "以页面实际为准灵活调整，并在最后 task_done 里说明偏离了哪一步、为什么。"
    )
    return "\n".join(lines)
