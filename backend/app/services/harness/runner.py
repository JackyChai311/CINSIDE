"""HARNESS 智能体循环。

一个任务 = 一条 SSE 流：
    观察两个对象 → 交给 LLM（function calling）决策 → 执行工具 → 把结果回灌 →
    再决策 …… 直到 task_done / 步数用尽 / 用户停止。

设计要点：
  * **动作后可验证**：每次 web_* 动作自动附「页面现在长什么样」，模型能自我纠错，
    不会像传统脚本那样一步点错后面全错。
  * **上下文压缩**：长任务里历史 tool 结果会撑爆窗口，超阈值时把旧结果截断，
    只保留最近若干轮原文。
  * **可中断**：stop 事件在每次决策与每次工具执行之间检查。
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import httpx

from ...config import settings
from .cdp import CDPError, strip_data_url
from .excel_book import ExcelError, ExcelTarget
from .tools import HarnessTools
from .web import WebTarget

Emit = Callable[[dict], Awaitable[None]]

# 历史消息长度阈值（字符）；超过就把较老的 tool 结果截断
_CONTEXT_BUDGET = 90000
_TOOL_RESULT_KEEP = 6


@dataclass
class WebBinding:
    endpoint: str
    url: str = ""
    label: str = "网页"
    exclude_urls: list[str] = field(default_factory=list)


@dataclass
class ExcelBinding:
    path: str
    label: str = "Excel"


@dataclass
class HarnessSession:
    task_id: str
    instruction: str
    web: WebBinding | None = None
    excel: ExcelBinding | None = None
    max_steps: int = 40
    vision: bool = False
    # 用户确认过的执行流程（planner 产出），有则注入提示词
    plan: dict | None = None
    created_at: float = field(default_factory=time.time)
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    _answer_fut: asyncio.Future | None = None
    steps_used: int = 0
    status: str = "running"  # running | done | stopped | error
    summary: str = ""

    def request_stop(self) -> None:
        self.stop_event.set()
        if self._answer_fut and not self._answer_fut.done():
            self._answer_fut.set_result("（用户已停止任务）")

    def answer(self, text: str) -> bool:
        if self._answer_fut and not self._answer_fut.done():
            self._answer_fut.set_result(text or "（已跳过）")
            return True
        return False

    def as_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "instruction": self.instruction,
            "steps_used": self.steps_used,
            "status": self.status,
            "summary": self.summary,
            "created_at": self.created_at,
            "web_url": (self.web.url if self.web else ""),
            "excel_path": (self.excel.path if self.excel else ""),
        }


ACTIVE: dict[str, HarnessSession] = {}
_HISTORY: list[dict] = []


def new_session(**kwargs) -> HarnessSession:
    task_id = uuid.uuid4().hex[:12]
    sess = HarnessSession(task_id=task_id, **kwargs)
    ACTIVE[task_id] = sess
    return sess


def get_session(task_id: str) -> HarnessSession | None:
    return ACTIVE.get(task_id)


def recent_sessions(limit: int = 20) -> list[dict]:
    return _HISTORY[-limit:][::-1]


# ========== 提示词 ==========

_SYSTEM_PROMPT = """你是 HARNESS —— 一个直接操作真实软件界面的执行型智能体（Computer Use Agent）。
你不是在写教程，也不是在给建议：你的每一个工具调用都会真实作用在用户电脑上的对象上。

## 你当前操控的对象
{targets}

## 工作方式（必须遵守）
1. **先观察再动手**：任何 web_click / web_type 之前，必须先用 web_observe 拿到元素引用（e1、e2…）。
   同一个页面内引用保持稳定、可跨多步复用；但页面一旦跳转或刷新，引用全部失效 ——
   看到 `page_navigated` 或「ref 失效」的提示就重新观察，不要凭猜测使用引用。
2. **小步前进**：一次只做一个原子动作。每次动作后系统会返回「页面现在长什么样」
   （地址、报错提示、正文摘要），用它判断下一步，不要凭想象连点。
3. **批量搬运**：把网页数据写进 Excel 时，先用 web_extract(kind="table") 一次拿到结构化数据，
   再用 excel_write / excel_fill_column 一次写完；严禁逐格一次一个工具调用。
   要写进「新的一张表」就先 excel_sheet(action="create", name="表名", headers=["列1","列2"])，再从第 2 行写入。
4. **不编造数据**：只用网页上和 Excel 里真实存在的内容。字段对不上、找不到人，
   就如实记录「未找到」并继续，不要用相似数据凑数。
5. **危险动作先确认**：提交表单、删除数据、覆盖已有内容、付款类操作，先用 ask_user 说明将要做什么，
   得到明确同意再执行（用户原话已明确要求的除外）。
6. **完成即交付**：改过 Excel 就在结束前调用 excel_export 生成文件；最后调用 task_done，
   summary 里写清「做了什么 / 处理了多少条 / 结果文件在哪 / 有没有失败项」。

## 输出纪律
- 需要动作就直接调用工具，不要先长篇解释。
- 需要说明思路时写在 content 里，一句话即可（会展示给用户，但不要长篇大论）。
- 不要调用与当前对象无关的工具，也不要虚构工具名或参数。
"""


def _targets_block(web: WebBinding | None, excel_summary: dict | None, excel_on: bool) -> str:
    lines: list[str] = []
    if web:
        lines.append(
            f"- **网页对象**（{web.label}）：当前地址 {web.url or '（未获取）'}\n"
            f"  用 web_* 工具真实点击/输入/滚动/截图这个页面。"
        )
    else:
        lines.append("- **网页对象**：本次未绑定（没有 web_* 工具，不要尝试操作网页）")
    if excel_summary:
        sheets = excel_summary.get("sheets") or []
        desc = "；".join(
            f"「{s['name']}」{s['rows']}行×{s['cols']}列，表头：{'、'.join(s['headers'][:12]) or '（无）'}"
            for s in sheets[:4]
        )
        lines.append(
            f"- **Excel 对象**：{excel_summary.get('file')}（操作的是工作副本，原文件不会被改动）\n  {desc}\n"
            f"  用 excel_* 工具读写它。"
        )
    elif excel_on:
        lines.append("- **Excel 对象**：已绑定但读取失败，先用 excel_summary 查看结构")
    else:
        lines.append("- **Excel 对象**：本次未绑定（没有 excel_* 工具）")
    return "\n".join(lines)


# ========== 主流程 ==========


async def run(
    session: HarnessSession,
    emit: Emit,
) -> None:
    base, key, model = settings.effective_harness_llm()
    web_target: WebTarget | None = None
    excel_target: ExcelTarget | None = None
    last_shot: dict | None = None

    async def on_screenshot(shot: dict) -> None:
        nonlocal last_shot
        last_shot = shot
        await emit(
            {
                "type": "screenshot",
                "dataUrl": shot.get("data_url"),
                "width": shot.get("width"),
                "height": shot.get("height"),
            }
        )

    async def on_ask(question: str, options: list[str]) -> str:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        session._answer_fut = fut
        await emit({"type": "ask", "question": question, "options": options})
        try:
            # 5 分钟没人回就按最保守策略继续（不能把整条任务无限期挂住）
            return await asyncio.wait_for(fut, timeout=300)
        except asyncio.TimeoutError:
            return "（用户 5 分钟内未回复，请自行做最保守的判断）"
        finally:
            session._answer_fut = None

    try:
        if not base or not key:
            raise RuntimeError(
                "未配置可用的 LLM：HARNESS 与「全局分析 AI」共用配置，"
                "请到「设置 → AI → 全局分析 AI」填写 API 地址、Key 与模型"
                "（需支持 function calling，如 deepseek-chat、glm-4-plus）"
            )

        # ---- 打开对象 ----
        await emit({"type": "phase", "phase": "binding", "message": "正在连接对象…"})
        if session.web:
            web_target = WebTarget(
                session.web.endpoint,
                session.web.url,
                label=session.web.label,
                exclude_urls=session.web.exclude_urls,
            )
        if session.excel:
            excel_target = ExcelTarget(
                session.excel.path,
                work_dir=_work_dir(session.task_id),
                label=session.excel.label,
            )
            await excel_target.open()

        # ---- 初始观察 ----
        excel_summary: dict | None = None
        if excel_target:
            try:
                excel_summary = await excel_target.summary()
            except ExcelError as e:
                await emit({"type": "warn", "message": f"读取 Excel 失败：{e}"})
        web_brief = ""
        if web_target:
            try:
                snap = await web_target.observe(max_elements=60, max_text=2500)
                session.web.url = snap.get("url") or session.web.url
                web_brief = (
                    f"页面标题：{snap.get('title')}\n"
                    f"当前地址：{snap.get('url')}\n"
                    f"可见正文（截断）：\n{(snap.get('text') or '')[:2000]}\n"
                    f"可交互元素数：{snap.get('total_interactive')}"
                )
                await emit(
                    {
                        "type": "phase",
                        "phase": "bound",
                        "message": f"已连接网页：{snap.get('title') or snap.get('url')}",
                    }
                )
            except CDPError as e:
                await emit({"type": "warn", "message": f"连接网页失败：{e}"})
                web_brief = f"（网页连接失败：{e}。后续 web_* 工具可能不可用）"

        tools = HarnessTools(
            web=web_target,
            excel=excel_target,
            on_ask=on_ask,
            on_screenshot=on_screenshot,
        )

        # 两个对象都没绑上就没得做
        if not tools.web and not tools.excel:
            raise RuntimeError("没有可用的对象：请至少选中一个网页或一个 Excel 文件")

        system = _SYSTEM_PROMPT.format(
            targets=_targets_block(session.web, excel_summary, bool(session.excel))
        )
        user_msg = (
            f"# 任务\n{session.instruction.strip()}\n\n"
            f"# 当前状态\n{web_brief or '（未绑定网页）'}\n"
        )
        if excel_summary:
            user_msg += (
                f"\nExcel 结构：{json.dumps(_compact_excel_summary(excel_summary), ensure_ascii=False)}"
            )
        if session.plan:
            from .planner import plan_as_prompt

            approved = plan_as_prompt(session.plan)
            if approved:
                user_msg += f"\n\n# 已确认的执行流程\n{approved}"
        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ]
        await emit(
            {
                "type": "start",
                "taskId": session.task_id,
                "model": model,
                "tools": [t["function"]["name"] for t in tools.schemas()],
            }
        )

        # ---- 决策循环 ----
        for step in range(1, max(1, session.max_steps) + 1):
            if session.stop_event.is_set():
                session.status = "stopped"
                await emit({"type": "stopped", "message": "已被用户停止"})
                return
            session.steps_used = step
            await emit({"type": "step", "index": step, "max": session.max_steps})

            reply = await _chat(base, key, model, messages, tools.schemas(), vision=session.vision and bool(last_shot))
            if reply.get("error"):
                raise RuntimeError(reply["error"])

            msg = reply.get("message") or {}
            content = (msg.get("content") or "").strip()
            tool_calls = msg.get("tool_calls") or []

            if content:
                await emit({"type": "thought", "text": content[:2000], "step": step})

            if not tool_calls:
                # 模型用自然语言收尾
                session.status = "done"
                session.summary = content or "（模型未给出说明）"
                await emit({"type": "final", "summary": session.summary})
                return

            assistant_msg: dict = {"role": "assistant", "content": msg.get("content") or None, "tool_calls": tool_calls}
            messages.append(assistant_msg)

            for tc in tool_calls:
                if session.stop_event.is_set():
                    break
                name = ((tc.get("function") or {}).get("name") or "").strip()
                raw_args = (tc.get("function") or {}).get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                    if not isinstance(args, dict):
                        args = {}
                except (TypeError, ValueError):
                    args = {}
                    await emit(
                        {
                            "type": "warn",
                            "message": f"模型给出的参数不是合法 JSON，已当作空参数：{str(raw_args)[:200]}",
                        }
                    )

                await emit(
                    {
                        "type": "tool_call",
                        "id": tc.get("id"),
                        "name": name,
                        "args": args,
                        "summary": _describe(name, args),
                        "step": step,
                    }
                )
                t0 = time.time()
                result = await tools.run(name, args)
                elapsed = int((time.time() - t0) * 1000)

                ok = bool(result.get("ok", True))
                await emit(
                    {
                        "type": "tool_result",
                        "id": tc.get("id"),
                        "name": name,
                        "ok": ok,
                        "durationMs": elapsed,
                        "result": _for_ui(name, result),
                        "step": step,
                    }
                )

                # 工具结果回灌给模型
                payload = _truncate_for_model(result)
                if session.vision and name == "web_screenshot" and last_shot:
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id") or name,
                            "content": [
                                {"type": "text", "text": payload},
                                {
                                    "type": "image_url",
                                    "image_url": {"url": strip_data_url(last_shot.get("data_url") or "")},
                                },
                            ],
                        }
                    )
                else:
                    messages.append(
                        {"role": "tool", "tool_call_id": tc.get("id") or name, "content": payload}
                    )

                if tools.done_summary:
                    session.status = "done"
                    session.summary = tools.done_summary
                    await emit({"type": "final", "summary": session.summary})
                    return

            messages = _compact_messages(messages)

        session.status = "done"
        session.summary = f"已达到单任务最大步数（{session.max_steps} 步）仍未完成，请拆小任务或提高步数上限后重试。"
        await emit({"type": "final", "summary": session.summary, "truncated": True})

    except Exception as e:  # noqa: BLE001 - 全部转成前端可读的错误事件
        session.status = "error"
        session.summary = str(e)
        # RuntimeError 都是我们自己抛的中文说明，带上类名只是噪音；其他异常保留类名便于定位
        msg = str(e) if isinstance(e, RuntimeError) else f"{type(e).__name__}: {e}"
        await emit({"type": "error", "message": msg})
    finally:
        session.status = "stopped" if session.stop_event.is_set() and session.status == "running" else session.status
        ACTIVE.pop(session.task_id, None)
        _HISTORY.append(session.as_dict())
        if len(_HISTORY) > 100:
            del _HISTORY[: len(_HISTORY) - 100]
        if web_target:
            await web_target.aclose()


# ========== LLM ==========


async def _chat(
    base: str,
    key: str,
    model: str,
    messages: list[dict],
    tools: list[dict],
    *,
    vision: bool,
) -> dict:
    url = base.rstrip("/") + "/chat/completions"
    payload: dict = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
        payload["parallel_tool_calls"] = False
    if not vision:
        # 不支持看图的模型收到 image_url 会直接 400，这里兜底去掉
        payload["messages"] = [_strip_images(m) for m in messages]

    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    last_err = ""
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 400 and tools:
                # 少数端点不支持 parallel_tool_calls / tools，降级重试一次
                body = resp.text[:400]
                if "parallel_tool_calls" in body:
                    payload.pop("parallel_tool_calls", None)
                    continue
            if resp.status_code == 429 or resp.status_code >= 500:
                last_err = _llm_error_hint(resp.status_code, resp.text)
                # 429 多半是额度/并发，重试意义不大：只给一次机会，别让用户干等
                if resp.status_code == 429:
                    return {"error": last_err}
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            if resp.status_code >= 400:
                return {"error": _llm_error_hint(resp.status_code, resp.text)}
            data = resp.json()
            choices = data.get("choices") or []
            if not choices:
                return {"error": f"LLM 返回结构异常：{json.dumps(data, ensure_ascii=False)[:400]}"}
            return {"message": choices[0].get("message") or {}}
        except httpx.HTTPError as e:
            last_err = f"{type(e).__name__}: {e}"
            await asyncio.sleep(1.0 * (attempt + 1))
    return {"error": f"LLM 请求重试 3 次仍失败：{last_err}"}


def _llm_error_hint(status: int, body: str) -> str:
    """把模型服务的英文错误翻译成用户能立刻行动的中文提示。"""
    body_l = (body or "").lower()
    if status == 401 or status == 403:
        return "「全局分析 AI」的 API Key 无效或已过期，请到 设置 → AI 重新填写"
    if status == 404:
        return "模型名或 API Base 地址不对（404），请核对「全局分析 AI」里的模型与地址"
    if status == 429 or "quota" in body_l or "insufficient" in body_l or "balance" in body_l:
        return "模型额度不足或被限流（429）：请检查「全局分析 AI」所用 Key 的余额 / 并发限制"
    return f"LLM 调用失败（HTTP {status}）：{body[:200]}"


def _strip_images(msg: dict) -> dict:
    content = msg.get("content")
    if isinstance(content, list):
        texts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
        return {**msg, "content": "\n".join(t for t in texts if t)}
    return msg


# ========== 辅助 ==========


def _work_dir(task_id: str) -> str:
    from pathlib import Path

    d = Path(settings.upload_dir) / "_harness" / task_id
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def _compact_excel_summary(summary: dict) -> dict:
    return {
        "sheets": [
            {"name": s["name"], "headers": s["headers"][:20], "rows": s["rows"], "sample": s["sample"][:3]}
            for s in (summary.get("sheets") or [])[:5]
        ]
    }


def _truncate_for_model(result: dict) -> str:
    try:
        text = json.dumps(result, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = str(result)
    if len(text) > 14000:
        text = text[:14000] + '…[结果过长已截断，可用更小的范围重试]'
    return text


def _for_ui(name: str, result: dict) -> dict:
    """推给前端的精简版：去掉超长文本，保留可读摘要。"""
    out: dict = {}
    for k, v in result.items():
        if isinstance(v, str) and len(v) > 1200:
            out[k] = v[:1200] + "…"
        elif isinstance(v, list) and len(v) > 30:
            out[k] = v[:30]
            out[k + "_total"] = len(v)
        else:
            out[k] = v
    return out


def _describe(name: str, args: dict) -> str:
    """给用户看的一句话动作描述。"""
    if name == "web_observe":
        return "观察网页"
    if name == "web_click":
        return f"点击 {args.get('ref', '?')}"
    if name == "web_type":
        t = str(args.get("text", ""))
        t = t if len(t) <= 30 else t[:30] + "…"
        return f"在 {args.get('ref', '?')} 输入「{t}」" + ("（回车提交）" if args.get("submit") else "")
    if name == "web_select":
        return f"在 {args.get('ref', '?')} 选择「{args.get('value', '')}」"
    if name == "web_press":
        return f"按键 {args.get('key', '')}"
    if name == "web_scroll":
        return f"滚动{'向下' if (args.get('direction') or 'down') == 'down' else '向上'}"
    if name == "web_navigate":
        return f"打开 {args.get('url', '')}"
    if name == "web_extract":
        kinds = {"text": "正文", "table": "表格", "list": "列表", "links": "链接"}
        return "抽取网页" + kinds.get(str(args.get("kind") or "text"), "内容")
    if name == "web_screenshot":
        return "截图"
    if name == "web_eval":
        return "执行页面脚本"
    if name == "excel_summary":
        return "查看表格结构"
    if name == "excel_sheet":
        acts = {"create": "新建工作表", "list": "列出工作表", "rename": "重命名工作表", "delete": "删除工作表"}
        label = acts.get(str(args.get("action") or "list"), "工作表操作")
        return label + (f"「{args.get('name')}」" if args.get("name") else "")
    if name == "excel_read":
        return f"读取 {args.get('range') or '表格'}"
    if name == "excel_write":
        n = len(args.get("updates") or [])
        return f"写入 {n} 个单元格"
    if name == "excel_fill_column":
        n = len(args.get("values") or [])
        return f"填写「{args.get('column', '')}」列（{n} 行）"
    if name == "excel_append_row":
        return "追加一行"
    if name == "excel_find":
        return f"查找「{args.get('query', '')}」"
    if name == "excel_export":
        return "导出表格"
    if name == "task_done":
        return "任务完成"
    if name == "ask_user":
        return "询问用户"
    return name


def _compact_messages(messages: list[dict]) -> list[dict]:
    """历史过长时只截断较老的 tool 结果，保留最近几轮与所有 assistant 决策。"""
    total = sum(len(json.dumps(m, ensure_ascii=False, default=str)) for m in messages)
    if total <= _CONTEXT_BUDGET:
        return messages
    cutoff = max(0, len(messages) - _TOOL_RESULT_KEEP * 2)
    out: list[dict] = []
    for i, m in enumerate(messages):
        if i < cutoff and m.get("role") == "tool" and isinstance(m.get("content"), str):
            c = m["content"]
            if len(c) > 600:
                m = {**m, "content": c[:600] + "…[较早结果已压缩]"}
        out.append(m)
    return out
