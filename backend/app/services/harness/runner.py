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
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import httpx

from ...config import settings
from .cdp import CDPError, strip_data_url
from .excel_book import ExcelError, ExcelTarget
from .slide import SlideError, SlideTarget
from .tools import HarnessTools
from .web import WebTarget
from .workspace import WorkspaceTarget

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
class SlideBinding:
    path: str
    label: str = "PPT"


@dataclass
class HarnessSession:
    task_id: str
    instruction: str
    web: WebBinding | None = None
    excel: ExcelBinding | None = None
    slide: SlideBinding | None = None
    # studio: web=网页任务（默认）/ slide=SLIDE STUDIO / cowork=COWORK STUDIO
    studio: str = "web"
    # cowork 任务注入的技能与风格（来自协作技能库 / 画像）
    context_note: str = ""
    max_steps: int = 120
    vision: bool = False
    # 用户确认过的执行流程（planner 产出），有则注入提示词
    plan: dict | None = None
    # 开荒模式：只跑名单第一条，动作被 recorder 录制成配方
    pioneer_note: str = ""
    recorder: object | None = None  # replay.RecipeRecorder
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
            "studio": self.studio,
            "web_url": (self.web.url if self.web else ""),
            "excel_path": (self.excel.path if self.excel else ""),
            "slide_path": (self.slide.path if self.slide else ""),
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
3b. **批量网页任务必须走 CINSIDE LOOP 引擎（CIRCLE），不要逐条手工 web_***：
   任务形如「把 Excel 每一行填进网页/逐人核对」时，标准流程是：
   ① loop_make_cards 从 Excel 生成人物卡片；
   ② 用 web_observe/web_eval 摸清页面（搜索框、输入框、按钮、日历/选项挂件的真实 CSS 选择器）；
   ③ loop_build_template 把整个 CIRCLE 固化成模板：前置点击(pre 搜索/进详情)→绑定输入(column=Excel列名)
      /审查对比/挂件(日历、选项)/文件提取(要看图时)→过程点击(mid NEXT等)→收尾点击(post 保存/返回)；
   ④ loop_run_first 用引擎真实试跑第一张卡片（开荒），失败就修模板重跑；
   ⑤ 成功后 loop_run_all 批量执行其余卡片——引擎自动逐行替换值重复 CIRCLE，不再消耗你的动作步。
   只有 LOOP 引擎覆盖不了的零散操作才用 web_* 单步做。
4. **不编造数据**：只用网页上和 Excel 里真实存在的内容。字段对不上、找不到人，
   就如实记录「未找到」并继续，不要用相似数据凑数。
   **「没看见」≠「不存在」**：下结论「页面没有某字段/某选项」之前，必须先确认看全了——
   检查观察结果里的 scroll.max_x / max_y，>0 说明还有内容在视口外，
   用 web_scroll(direction="right"/"down") 或 web_zoom_fit 把内容看全再说；
   Excel 同理：读不到某列时用 excel_read 指定更大区域（如 A1:Z50）或 excel_find 全表查找，
   不要只凭 excel_summary 的前几行样例断定数据缺失。
5. **危险动作先确认**：提交表单、删除数据、覆盖已有内容、付款类操作，先用 ask_user 说明将要做什么，
   得到明确同意再执行（用户原话已明确要求的除外）。
6. **完成即交付**：改过 Excel 就在结束前调用 excel_export 生成文件；改过 PPT 就 slide_export；
   协作任务的成果用 file_write 写成完整文件并 file_export 交付；最后调用 task_done，
   summary 里写清「做了什么 / 处理了多少条 / 结果文件在哪 / 有没有失败项」。
   **卡住不算完成**：如果因找不到字段、页面异常、流程走不通而无法达成任务目标，
   严禁调用 task_done 宣称完成——先尝试滚动/缩放/换定位方式自救；仍不行就 ask_user 说明卡在哪，
   或在收尾说明里如实写「未完成 + 卡点」，绝不能把失败包装成成功。

## 输出纪律
- 需要动作就直接调用工具，不要先长篇解释。
- 需要说明思路时写在 content 里，一句话即可（会展示给用户，但不要长篇大论）。
- 不要调用与当前对象无关的工具，也不要虚构工具名或参数。
"""


def _targets_block(
    web: WebBinding | None,
    excel_summary: dict | None,
    excel_on: bool,
    slide_summary: dict | None = None,
    slide_on: bool = False,
    workspace_root: str = "",
    video_on: bool = False,
) -> str:
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
    if slide_summary:
        titles = slide_summary.get("titles") or []
        lines.append(
            f"- **PPT 对象**（SLIDE STUDIO）：{slide_summary.get('file')}，共 {slide_summary.get('slides')} 页"
            f"（操作的是工作副本，slide_export 才交付）\n"
            f"  各页标题：{'、'.join(str(t)[:30] for t in titles[:20])}\n"
            f"  用 slide_* 工具读取/修改/加页/截图，改完 slide_export 交付。"
        )
    elif slide_on:
        lines.append("- **PPT 对象**：已绑定但读取失败，先用 slide_summary 查看结构")
    if video_on:
        lines.append(
            "- **视频合成**（SLIDE STUDIO）：用 slide_screenshot 逐页拿画面 → video_tts 生成解说配音 → "
            "video_compose 合成 MP4（无 Remotion，走 ffmpeg）。"
            "网页动画也可以 web_screenshot 连拍后 video_from_frames 合成。"
        )
    if workspace_root:
        lines.append(
            f"- **协作工作区**（COWORK STUDIO）：{workspace_root}\n"
            f"  用 file_* 工具在工作区里产出成果文件（报告/代码/文案），最终 file_export 交付到下载目录。"
        )
    return "\n".join(lines)


# ========== 主流程 ==========


async def run(
    session: HarnessSession,
    emit: Emit,
) -> None:
    base, key, model = settings.effective_harness_llm()
    web_target: WebTarget | None = None
    excel_target: ExcelTarget | None = None
    slide_target: SlideTarget | None = None
    workspace_target: WorkspaceTarget | None = None
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
        if session.slide:
            slide_target = SlideTarget(
                session.slide.path,
                work_dir=_work_dir(session.task_id),
                label=session.slide.label,
            )
            await slide_target.open()
        if session.studio == "cowork":
            workspace_target = WorkspaceTarget(
                os.path.join(_work_dir(session.task_id), "workspace"),
                label="协作工作区",
            )

        # ---- 初始观察 ----
        excel_summary: dict | None = None
        if excel_target:
            try:
                excel_summary = await excel_target.summary()
            except ExcelError as e:
                await emit({"type": "warn", "message": f"读取 Excel 失败：{e}"})
        slide_summary: dict | None = None
        if slide_target:
            try:
                slide_summary = await slide_target.summary()
                await emit(
                    {
                        "type": "phase",
                        "phase": "bound",
                        "message": f"已连接 PPT：{slide_summary.get('file')}（{slide_summary.get('slides')} 页）",
                    }
                )
            except SlideError as e:
                await emit({"type": "warn", "message": f"读取 PPT 失败：{e}"})
        web_brief = ""
        if web_target:
            try:
                # 绑定后先自动把页面缩放到合适比例（宽度收进视口；本来就合适则不动），
                # 避免宽表单被截断在视口右侧导致模型「看不见」字段
                try:
                    fit = await web_target.autofit_zoom()
                    if fit.get("changed"):
                        await emit(
                            {
                                "type": "phase",
                                "phase": "zoom",
                                "message": f"已把网页缩放到 {int(round(float(fit.get('applied') or 1) * 100))}%（宽度适配视口）",
                            }
                        )
                except CDPError:
                    pass  # 缩放失败不阻断任务
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
            slide=slide_target,
            workspace=workspace_target,
            video=(session.studio == "slide"),
            on_ask=on_ask,
            on_screenshot=on_screenshot,
        )

        # 所有对象都没绑上就没得做
        if not tools.web and not tools.excel and not tools.slide and not tools.workspace:
            raise RuntimeError("没有可用的对象：请至少选中一个网页、Excel、PPT 或协作任务")

        system = _SYSTEM_PROMPT.format(
            targets=_targets_block(
                session.web, excel_summary, bool(session.excel),
                slide_summary=slide_summary, slide_on=bool(session.slide),
                workspace_root=(str(workspace_target.root) if workspace_target else ""),
                video_on=(session.studio == "slide"),
            )
        )
        user_msg = (
            f"# 任务\n{session.instruction.strip()}\n\n"
            f"# 当前状态\n{web_brief or '（未绑定网页）'}\n"
        )
        if session.context_note:
            user_msg += f"\n\n# 用户技能与风格要求（必须遵守）\n{session.context_note}"
        if slide_summary:
            user_msg += (
                f"\nPPT 结构：{json.dumps({'file': slide_summary.get('file'), 'slides': slide_summary.get('slides'), 'titles': (slide_summary.get('titles') or [])[:30]}, ensure_ascii=False)}"
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
        if session.pioneer_note:
            user_msg += f"\n\n# 开荒模式（必须遵守）\n{session.pioneer_note}"
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
        # 步数预算只算「推进任务的动作」：观察/截图/询问用户等辅助轮不扣步，
        # 避免长表单任务里「看一步走一步」把预算耗光、答完追问就罢工。
        # 防死循环：连续纯辅助轮最多 12 轮（其间没有任何写/点/导航动作就强制收敛）。
        _FREE_TOOLS = {
            "web_observe", "web_screenshot", "web_zoom_fit", "web_scroll",
            "excel_summary", "excel_read", "excel_find", "excel_sheet",
            "slide_summary", "slide_read", "file_list", "file_read",
            "ask_user", "task_done",
        }
        budget = max(1, session.max_steps)
        step = 0
        free_streak = 0
        # 预算用尽后追加一轮「收尾轮」：只下发 task_done / ask_user，
        # 让模型交付成果或如实说明卡点，不至于动作刚好用完连收尾都做不了。
        wrapup_round = False
        while True:
            if session.stop_event.is_set():
                session.status = "stopped"
                await emit({"type": "stopped", "message": "已被用户停止"})
                return
            if step >= budget:
                if wrapup_round:
                    break  # 收尾轮也结束了仍没交付 → 按预算耗尽报错
                wrapup_round = True
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"（系统）动作步预算（{budget} 步）已用尽，这是最后一轮："
                            "若任务已完成，立即调用 task_done 交付并写清结果；"
                            "若未完成，调用 task_done 在 summary 里如实写明「未完成 + 已完成部分 + 卡点」，"
                            "或调用 ask_user 请求用户指示。不要再执行其他动作。"
                        ),
                    }
                )
            step += 1
            session.steps_used = step
            await emit({"type": "step", "index": min(step, budget), "max": budget})

            if wrapup_round:
                schemas = [
                    s for s in tools.schemas()
                    if (s.get("function") or {}).get("name") in ("task_done", "ask_user")
                ]
            else:
                schemas = tools.schemas()
            reply = await _chat(base, key, model, messages, schemas, vision=session.vision and bool(last_shot))
            if reply.get("error"):
                raise RuntimeError(reply["error"])

            msg = reply.get("message") or {}
            content = (msg.get("content") or "").strip()
            tool_calls = msg.get("tool_calls") or []

            if content:
                await emit({"type": "thought", "text": content[:2000], "step": step})

            if not tool_calls:
                # 模型用自然语言收尾：识别「卡住/未完成」式收尾，不能标成 done 宣称完成
                session.summary = content or "（模型未给出说明）"
                stuck_kw = (
                    "无法完成", "未能完成", "没有完成", "任务失败", "卡住", "无法继续",
                    "找不到该", "未找到必填", "无法找到", "不能完成",
                )
                if any(k in session.summary for k in stuck_kw):
                    session.status = "error"
                    await emit({"type": "error", "message": f"任务未完成：{session.summary}"})
                else:
                    session.status = "done"
                    await emit({"type": "final", "summary": session.summary})
                return

            assistant_msg: dict = {"role": "assistant", "content": msg.get("content") or None, "tool_calls": tool_calls}
            messages.append(assistant_msg)

            round_names: list[str] = []
            for tc in tool_calls:
                if session.stop_event.is_set():
                    break
                name = ((tc.get("function") or {}).get("name") or "").strip()
                round_names.append(name)
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

                # 开荒录制：成功的可回放动作进配方
                if session.recorder is not None:
                    try:
                        session.recorder.record(name, args, result)  # type: ignore[attr-defined]
                    except Exception:  # noqa: BLE001 - 录制失败不影响执行
                        pass

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
            # 整轮只有辅助动作（观察/读表/问用户…）：不消耗执行预算，退回这一步。
            # 连续 12 轮纯辅助没有任何推进动作 → 视为原地打转，停止免费额度防止死循环。
            # 收尾轮只许交付/求助，不参与免费回退（否则可能无限追问）。
            if not wrapup_round and round_names and all(n in _FREE_TOOLS for n in round_names):
                free_streak += 1
                if free_streak <= 12:
                    step -= 1
                    session.steps_used = step
            else:
                free_streak = 0

        session.status = "error"
        session.summary = (
            f"已达到单任务执行预算（{budget} 个动作步，观察/询问不计步）仍未完成。"
            "可在设置里提高 HARNESS_MAX_STEPS，或把任务拆小后重试。"
        )
        await emit({"type": "error", "message": session.summary})

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


async def classify_studio(instruction: str, has_slide: bool, has_web_or_excel: bool) -> str:
    """判断任务属于哪个 STUDIO：web / slide / cowork。

    规则先行（快、零成本），拿不准再问 LLM；LLM 不可用时按规则兜底。
    前端自动切换视图就靠这个标签。
    """
    text = (instruction or "").strip()
    low = text.lower()
    slide_kw = ("ppt", "幻灯片", "演示文稿", "slide", "课件", "转视频", "做成视频", "生成视频", "配音", "讲解视频")
    cowork_kw = ("写一份", "写一篇", "报告", "文案", "代码", "组件", "脚本", "方案", "总结", "文章", "周报", "合同", "简历")
    slide_hit = any(k in low for k in slide_kw)
    cowork_hit = any(k in low for k in cowork_kw)

    if has_slide:
        return "slide"
    if slide_hit and not has_web_or_excel:
        return "slide"
    if cowork_hit and not has_web_or_excel and not slide_hit:
        return "cowork"
    if has_web_or_excel:
        return "web"

    # 关键词都不命中：让 LLM 三选一（失败按 cowork 兜底——没有对象的任务多半是产出文档）
    try:
        reply = await _chat(
            *settings.effective_harness_llm(),
            [
                {"role": "system", "content": (
                    "你是任务分类器。判断用户任务属于哪类，只回答一个词：\n"
                    "web = 需要操作网页或表格数据（填表/抓数据/核对）\n"
                    "slide = 制作/修改 PPT、幻灯片、课件，或把内容做成配音视频\n"
                    "cowork = 产出文档/报告/文案/代码等成果文件"
                )},
                {"role": "user", "content": text[:1000]},
            ],
            [],
            vision=False,
        )
        ans = str((reply.get("message") or {}).get("content") or "").strip().lower()
        if "slide" in ans:
            return "slide"
        if "web" in ans:
            return "web"
        if "cowork" in ans:
            return "cowork"
    except Exception:  # noqa: BLE001 - 分类失败不阻断入队
        pass
    return "cowork"


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
        dirs = {"down": "向下", "up": "向上", "left": "向左", "right": "向右"}
        return f"滚动{dirs.get(str(args.get('direction') or 'down'), '向下')}"
    if name == "web_zoom_fit":
        return "缩放网页到合适比例"
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
    if name == "loop_status":
        return "查看 LOOP 引擎状态"
    if name == "loop_make_cards":
        return "从 Excel 生成人物卡片"
    if name == "loop_build_template":
        return f"固化 LOOP 模板「{args.get('name', '')}」（{len(args.get('steps') or [])} 步）"
    if name == "loop_run_first":
        return "LOOP 引擎试跑第一张卡片"
    if name == "loop_run_all":
        return "LOOP 引擎批量执行全部卡片"
    if name == "slide_summary":
        return "查看 PPT 结构"
    if name == "slide_read":
        return f"读取第 {args.get('slide', '?')} 页"
    if name == "slide_set_text":
        return f"修改第 {args.get('slide', '?')} 页文字"
    if name == "slide_add_text":
        return f"第 {args.get('slide', '?')} 页加文本框"
    if name == "slide_add_slide":
        return "新增幻灯片"
    if name == "slide_screenshot":
        return f"渲染第 {args.get('slide', '?')} 页画面"
    if name == "slide_export":
        return "交付 PPT 文件"
    if name == "video_tts":
        t = str(args.get("text", ""))
        return f"生成配音「{t[:24]}{'…' if len(t) > 24 else ''}」"
    if name == "video_compose":
        return f"合成视频（{len(args.get('pages') or [])} 页画面）"
    if name == "video_from_frames":
        return "帧序列合成动画视频"
    if name == "file_list":
        return "查看工作区文件"
    if name == "file_read":
        return f"读取 {args.get('path', '')}"
    if name == "file_write":
        return f"写入 {args.get('path', '')}"
    if name == "file_export":
        return f"交付 {args.get('path', '')}"
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
