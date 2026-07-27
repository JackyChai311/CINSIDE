"""可插拔 Agent 接口与多个实现。

切换实现只需改 .env 的 AGENT_BACKEND：
  - mock         开箱即跑，模拟浏览器流程，用于演示
  - browser_use  真实跑 Browser Use（需装 playwright + LLM key）
  - hermes       调 Hermes Agent HTTP API（需 Hermes 服务）
  - openclaw     调 OpenClaw CLI（需 openclaw 可执行）
"""
from __future__ import annotations

import abc
import asyncio
import base64
import json
import uuid
from typing import AsyncIterator, Optional

from ..config import settings
from ..models import (
    InputBox,
    VerificationResult,
    VerificationStep,
    WebsiteField,
    WebsiteInput,
    WorkflowConfig,
    FieldMapping,
    WorkflowStep,
)


# ========== Electron / CDP 辅助 ==========

def _browser_profile_kwargs() -> dict:
    """构造 BrowserProfile 参数：优先使用 CDP 连接 Electron。"""
    kwargs: dict = {}
    if settings.browser_use_cdp_url:
        kwargs["cdp_url"] = settings.browser_use_cdp_url
        kwargs["is_local"] = False
    else:
        kwargs["headless"] = settings.browser_use_headless
        if settings.browser_use_executable:
            kwargs["executable_path"] = settings.browser_use_executable
    return kwargs


def _is_internal_target_url(url: str | None) -> bool:
    """判断 CDP target 是否是 Electron 自己的 UI（React UI / DevTools 等）。"""
    if not url:
        return True
    return (
        url.startswith(("about:", "chrome://", "devtools://", "file://"))
        or "localhost:5173" in url
    )


async def _focus_browser_view_target(
    session,
    university_url: str | None = None,
    timeout: float = 5.0,
) -> bool:
    """连接 Electron CDP 后，聚焦到嵌入的 BrowserView 页面（避免控制 React UI）。"""
    manager = getattr(session, "session_manager", None)
    if not manager:
        return False

    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        targets = manager.get_all_page_targets()
        if university_url:
            for t in targets:
                if getattr(t, "url", "").startswith(university_url):
                    session.agent_focus_target_id = t.target_id
                    return True
        for t in targets:
            if not _is_internal_target_url(getattr(t, "url", "")):
                session.agent_focus_target_id = t.target_id
                return True
        await asyncio.sleep(0.2)
    return False


# ========== 接口 ==========
class BaseAgent(abc.ABC):
    """所有 Agent 实现必须遵守的接口。"""

    name: str = "base"
    # 由 task_manager 在启动核验时注入，供 Agent 内部回调推送截图等事件
    task_id: Optional[str] = None
    # 可配置工作流（用户主导模式）。
    # 只有 ConfigurableAgent 会用到；其他 Agent 保持原有行为。
    workflow_config: Optional[WorkflowConfig] = None

    def set_workflow_config(self, config: WorkflowConfig) -> None:
        self.workflow_config = config

    @abc.abstractmethod
    async def verify(
        self,
        record_id: str,
        university_url: str,
        expected_fields: dict[str, str],
    ) -> AsyncIterator[VerificationStep]:
        """去 university_url 抓取已填字段，逐步 yield 进度。

        最后必须调用 self.set_extracted_fields() 提交抓取结果。
        """
        ...
        if False:
            yield  # 让 Python 识别为 async generator

    extracted_fields: list[WebsiteField] = []
    # 右侧页面的输入框列表（带 label + selector），供"按页面框对比"视图使用
    extracted_inputs: list[WebsiteInput] = []

    def set_extracted_fields(self, fields: list[WebsiteField]) -> None:
        self.extracted_fields = fields

    def set_extracted_inputs(self, inputs: list[WebsiteInput]) -> None:
        self.extracted_inputs = inputs


# ========== Mock Agent ==========
class MockAgent(BaseAgent):
    """模拟浏览器流程，开箱即跑。

    行为：根据 university_url 的 hash 生成"已填字段"，并故意制造 1-2 个差异，
    方便演示比对效果。
    """

    name = "mock"

    async def verify(
        self,
        record_id: str,
        university_url: str,
        expected_fields: dict[str, str],
    ) -> AsyncIterator[VerificationStep]:
        step = 0

        def nxt(action: str, desc: str, success: bool = True, detail: str | None = None) -> VerificationStep:
            nonlocal step
            step += 1
            return VerificationStep(step=step, action=action, description=desc, success=success, detail=detail)

        yield nxt("navigate", f"打开大学申请页：{university_url}")
        await asyncio.sleep(0.4)

        yield nxt("snapshot", "获取页面可访问性树")
        await asyncio.sleep(0.3)

        yield nxt("login_check", "检测登录状态：已登录")
        await asyncio.sleep(0.3)

        yield nxt("navigate", "进入 Personal Information 表单页")
        await asyncio.sleep(0.4)

        yield nxt("snapshot", "识别表单字段：name / passport_no / birth_date / email ...")
        await asyncio.sleep(0.3)

        # 根据 url hash 决定"网站已填值"，并故意制造差异
        h = (hash(university_url) + hash(record_id)) % 4
        extracted: dict[str, str] = dict(expected_fields)  # 默认与期望一致

        if h == 0 and "name" in extracted:
            # 故意改一个字母
            extracted["name"] = extracted["name"].upper().replace(" ", "  ")
            yield nxt("extract", "抽取字段 name（与期望不符）")
        elif h == 1 and "email" in extracted:
            extracted["email"] = extracted["email"].replace("@", "@")
            extracted["email"] = extracted["email"].replace(".com", ".con")  # 故意打错
            yield nxt("extract", "抽取字段 email（与期望不符）")
        elif h == 2 and "birth_date" in extracted:
            # 日期格式不一致
            extracted["birth_date"] = extracted["birth_date"].replace("-", "/")
            yield nxt("extract", "抽取字段 birth_date（格式不一致）")
        else:
            yield nxt("extract", "抽取所有字段（与期望一致）")
        await asyncio.sleep(0.3)

        yield nxt("screenshot", "保存证据截图")
        await asyncio.sleep(0.2)

        yield nxt("done", "核验完成")

        self.set_extracted_fields([WebsiteField(name=k, value=v) for k, v in extracted.items()])


# ========== Browser Use Agent ==========
class BrowserUseAgent(BaseAgent):
    """真实 Browser Use 实现（适配 browser-use 0.13.6 新 API）。

    新 API：BrowserProfile + BrowserSession 替代旧的 Browser/BrowserConfig。
    Agent 在 browser_use.agent 模块下，不在顶层。

    需要先：
      pip install browser-use langchain-openai
      设置 BROWSER_USE_LLM_KEY 等
      可选：BROWSER_USE_EXECUTABLE 指向系统 Chrome
    """

    name = "browser_use"

    async def verify(
        self,
        record_id: str,
        university_url: str,
        expected_fields: dict[str, str],
    ) -> AsyncIterator[VerificationStep]:
        step = 0

        def nxt(action: str, desc: str, success: bool = True, detail: str | None = None) -> VerificationStep:
            nonlocal step
            step += 1
            return VerificationStep(step=step, action=action, description=desc, success=success, detail=detail)

        try:
            from browser_use.agent import Agent as BUAgent
            from browser_use.browser import BrowserProfile, BrowserSession
            from browser_use.llm.openai.chat import ChatOpenAI
        except ImportError as e:
            yield nxt("error", "缺少依赖", success=False,
                      detail=f"请执行: pip install browser-use\n缺: {e}")
            self.set_extracted_fields([])
            return

        if not settings.browser_use_llm_key:
            yield nxt("error", "未配置 BROWSER_USE_LLM_KEY", success=False,
                      detail="请在 backend/.env 设置 BROWSER_USE_LLM_KEY")
            self.set_extracted_fields([])
            return

        yield nxt("init", f"初始化 Browser Use (model={settings.browser_use_llm_model}, vision={settings.browser_use_vision})")
        await asyncio.sleep(0.2)

        # 构造任务 prompt：明确字段 + 强制 JSON 输出（含 label 和 selector，用于按页面框对比）
        fields_list = ", ".join(expected_fields.keys())
        expected_hint = "\n".join(
            f"  - {k}: {v}" for k, v in expected_fields.items()
        )
        task = (
            f"访问这个大学申请页面：{university_url}\n"
            f"找到 Personal Information（个人信息）部分，抽取以下字段在页面上的当前已填值：\n"
            f"{expected_hint}\n\n"
            f"抽取规则：\n"
            f"1. 只读取页面上已填入的实际值，不要根据记忆或猜测填写\n"
            f"2. 如果某字段为空或不存在，value 返回空字符串\n"
            f"3. 日期保持页面原始格式\n"
            f"4. 同时记录该输入框在页面上的 label 文本（如 Full Name）和定位 selector（如 #full-name 或 input[name=fullname]）\n\n"
            f"完成后必须调用 done 工具，并在 final_result 中以 JSON 输出。"
            f"键为字段名，值为对象 {{value, label, selector}}。例如：\n"
            f'{{"name": {{"value": "ZHANG SAN", "label": "Full Name", "selector": "#full-name"}}, '
            f'"email": {{"value": "", "label": "Email Address", "selector": "#email"}}}}'
        )

        # browser-use 0.13.6 自带 ChatOpenAI（browser_use.llm.openai.chat），
        # 不再依赖 langchain_openai。它实现了 browser_use 自己的 BaseChatModel 接口。
        # remove_min_items_from_schema=True 可避免某些模型对 min_items 约束的解析失败。
        llm = ChatOpenAI(
            model=settings.browser_use_llm_model,
            base_url=settings.browser_use_llm_base,
            api_key=settings.browser_use_llm_key,
            remove_min_items_from_schema=True,
            add_schema_to_system_prompt=True,
        )

        # 构造 BrowserProfile（CDP 优先）
        profile_kwargs = _browser_profile_kwargs()
        profile = BrowserProfile(**profile_kwargs)
        session = BrowserSession(browser_profile=profile)

        # 如果使用 CDP（Electron 嵌入浏览器），先连接并定位到 BrowserView 页面
        if settings.browser_use_cdp_url:
            yield nxt("connect_cdp", f"连接到 Electron CDP: {settings.browser_use_cdp_url}")
            await session.start()
            focused = await _focus_browser_view_target(session, university_url)
            if not focused:
                yield nxt("warn", "未能定位到嵌入的 BrowserView，Agent 可能操作到默认页面")

        # 每步回调：把 browser-use 的截图实时推送到前端 + 抽取 input bbox
        from ..models import ScreenshotEvent, InputBox
        from ..services.task_manager import emit_screenshot

        # 非 local 容器，存最新的 bbox 信息（在 callback 里更新，verify 末尾使用）
        latest_boxes: list[InputBox] = []
        latest_viewport: tuple[int | None, int | None] = (None, None)
        latest_screenshot: str | None = None

        # 抽取页面所有 input 的 bbox 的 JS
        js_bbox = (
            "() => JSON.stringify({"
            "  viewport: { w: window.innerWidth, h: window.innerHeight },"
            "  inputs: Array.from(document.querySelectorAll('input, select, textarea')).map(el => {"
            "    const r = el.getBoundingClientRect();"
            "    let label = '';"
            "    if (el.id) { const l = document.querySelector('label[for=\"' + el.id + '\"]'); if (l) label = (l.textContent || '').trim(); }"
            "    if (!label) { const l = el.closest('label'); if (l) label = (l.textContent || '').trim(); }"
            "    if (!label && el.placeholder) label = el.placeholder;"
            "    if (!label && el.getAttribute('aria-label')) label = el.getAttribute('aria-label');"
            "    let sel = '';"
            "    if (el.id) sel = '#' + el.id;"
            "    else if (el.name) sel = '[name=\"' + el.name + '\"]';"
            "    else sel = el.tagName.toLowerCase();"
            "    return { selector: sel, label: label, value: el.value || '',"
            "             x: r.left, y: r.top, width: r.width, height: r.height };"
            "  })"
            "})"
        )

        # browser-use 的 callback 可能是 sync 或 async；这里用 async
        async def _on_new_step(browser_state, agent_output, step_num: int) -> None:
            """每完成一步：推截图 + 尝试抽取 input bbox（session 此时还活着）。"""
            nonlocal latest_boxes, latest_viewport, latest_screenshot
            if not self.task_id:
                return
            shot = getattr(browser_state, "screenshot", None)
            if not shot:
                return
            latest_screenshot = shot
            hint = None
            try:
                hint = getattr(agent_output, "next_goal", None) or None
            except Exception:
                pass
            url = getattr(browser_state, "url", None)
            title = getattr(browser_state, "title", None)
            # 尝试抽取 bbox（如果失败就静默跳过，不影响主流程）
            boxes_now: list[InputBox] = []
            vw: int | None = None
            vh: int | None = None
            try:
                page = await session.get_current_page()
                if page is not None:
                    raw = await page.evaluate(js_bbox)
                    if raw:
                        import json as _json2
                        data = _json2.loads(raw)
                        vw = data.get("viewport", {}).get("w")
                        vh = data.get("viewport", {}).get("h")
                        for item in data.get("inputs", []):
                            boxes_now.append(InputBox(
                                selector=item.get("selector", ""),
                                label=item.get("label") or None,
                                value=item.get("value") or None,
                                x=float(item.get("x", 0)),
                                y=float(item.get("y", 0)),
                                width=float(item.get("width", 0)),
                                height=float(item.get("height", 0)),
                                match_status="pending",
                            ))
            except Exception:
                pass
            # 更新 nonlocal（每步覆盖，保留最新一次）
            if boxes_now:
                latest_boxes = boxes_now
                latest_viewport = (vw, vh)
            # 推截图事件（含当前 bbox，让前端能看到带 pending 框的画面）
            event = ScreenshotEvent(
                step=int(step_num),
                screenshot=shot,
                url=url,
                title=title,
                action_hint=hint,
                boxes=latest_boxes,
                viewport_width=latest_viewport[0],
                viewport_height=latest_viewport[1],
            )
            try:
                await emit_screenshot(self.task_id, event)
            except Exception:
                pass

        agent = BUAgent(
            task=task,
            llm=llm,
            browser_session=session,
            use_vision=settings.browser_use_vision,
            max_failures=3,
            register_new_step_callback=_on_new_step,
            extend_system_message=(
                "你是一个数据核验助手。任务是从大学申请页面抽取已填写的字段值，"
                "并与期望值对比。不要修改任何表单内容，只读取。"
                "最终结果必须是一个 JSON 对象，键为字段名，值为 {value, label, selector} 对象。"
            ),
        )

        yield nxt("navigate", f"打开 {university_url}")
        yield nxt("run", f"Browser Use 自主执行中（最多 {settings.browser_use_max_steps} 步）...")

        try:
            result = await agent.run(max_steps=settings.browser_use_max_steps)
        except Exception as e:
            yield nxt("error", "Browser Use 执行失败", success=False, detail=str(e))
            self.set_extracted_fields([])
            await session.close()
            return

        yield nxt("snapshot", f"执行完成，共 {result.number_of_steps()} 步")

        # 解析最终结果
        extracted: dict[str, str] = {}
        try:
            final_text = result.final_result() or ""
        except Exception:
            final_text = ""

        if final_text:
            try:
                import re
                # 尝试从 markdown 代码块或裸 JSON 中提取
                m = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", final_text)
                if m:
                    extracted = json.loads(m.group(1))
                else:
                    m = re.search(r"\{[\s\S]*\}", final_text)
                    if m:
                        extracted = json.loads(m.group(0))
            except (json.JSONDecodeError, AttributeError):
                pass

        # 兜底：尝试从 extracted_content 列表里找
        if not extracted:
            try:
                contents = result.extracted_content() or []
                for c in contents:
                    if not c:
                        continue
                    try:
                        import re
                        m = re.search(r"\{[\s\S]*\}", str(c))
                        if m:
                            extracted = json.loads(m.group(0))
                            break
                    except (json.JSONDecodeError, AttributeError):
                        continue
            except Exception:
                pass

        if result.has_errors():
            errs = result.errors()
            yield nxt("warn", f"执行中有 {len(errs)} 个错误", detail="; ".join(str(e) for e in errs[:3]))

        # 解析结构：期望 {field: {value, label, selector}}，兼容旧格式 {field: "value"}
        fields_out: list[WebsiteField] = []
        inputs_out: list[WebsiteInput] = []
        for k, v in extracted.items():
            if isinstance(v, dict):
                val = str(v.get("value", "") or "")
                label = str(v.get("label", "") or "") or k
                selector = v.get("selector") or None
                input_type = v.get("input_type") or v.get("type") or None
            else:
                # 旧格式：值是字符串
                val = str(v) if v is not None else ""
                label = k
                selector = None
                input_type = None
            fields_out.append(WebsiteField(name=k, value=val, selector_hint=selector))
            inputs_out.append(WebsiteInput(
                label=label,
                value=val,
                selector_hint=selector,
                input_type=input_type,
                matched_field=k,
            ))

        yield nxt("extract", f"抽取到 {len(fields_out)} 个字段", detail=json.dumps(extracted, ensure_ascii=False) if extracted else None)

        # 把 callback 里抽取的 bbox 写回 inputs_out（按 selector 匹配）
        if latest_boxes:
            sel_to_bbox = {b.selector: (b.x, b.y, b.width, b.height) for b in latest_boxes}
            for wi in inputs_out:
                if wi.selector_hint and wi.selector_hint in sel_to_bbox:
                    bx, by, bw, bh = sel_to_bbox[wi.selector_hint]
                    wi.bbox_x, wi.bbox_y = float(bx), float(by)
                    wi.bbox_width, wi.bbox_height = float(bw), float(bh)
            yield nxt("snapshot", f"抓取到 {len(latest_boxes)} 个输入框坐标", detail=f"viewport={latest_viewport[0]}x{latest_viewport[1]}")
        else:
            yield nxt("warn", "未能抽取输入框坐标（页面可能已关闭）")

        yield nxt("done", "Browser Use 核验完成")

        self.set_extracted_fields(fields_out)
        self.set_extracted_inputs(inputs_out)
        # 把 boxes 和最后截图存到 agent，供 task_manager 比对后更新颜色并推最终截图
        self.input_boxes: list[InputBox] = latest_boxes  # type: ignore[attr-defined]
        self.viewport_size = latest_viewport  # type: ignore[attr-defined]
        self.last_screenshot: str | None = latest_screenshot  # type: ignore[attr-defined]
        await session.close()


# ========== Hermes Agent (Stub) ==========
class HermesAgent(BaseAgent):
    """通过 Hermes Agent API Server 触发核验。

    Hermes 自带 API Server（默认 http://localhost:8001）。
    完整实现需调用 /api/chat 或 /api/skill 端点，传入任务描述。
    """

    name = "hermes"

    async def verify(
        self,
        record_id: str,
        university_url: str,
        expected_fields: dict[str, str],
    ) -> AsyncIterator[VerificationStep]:
        step = 0

        def nxt(action: str, desc: str, success: bool = True, detail: str | None = None) -> VerificationStep:
            nonlocal step
            step += 1
            return VerificationStep(step=step, action=action, description=desc, success=success, detail=detail)

        yield nxt("init", f"连接 Hermes Agent @ {settings.hermes_api_base}")
        yield nxt("todo", "Hermes 集成待补完：调用 POST /api/chat 发送任务指令",
                  success=False, detail="Hermes 会自动学习每个大学的核验套路并沉淀为 skill")
        self.set_extracted_fields([])


# ========== OpenClaw Agent (Stub) ==========
class OpenClawAgent(BaseAgent):
    """通过 openclaw CLI 触发浏览器核验。

    完整实现需调用: openclaw browser --browser-profile {profile} ...
    """

    name = "openclaw"

    async def verify(
        self,
        record_id: str,
        university_url: str,
        expected_fields: dict[str, str],
    ) -> AsyncIterator[VerificationStep]:
        step = 0

        def nxt(action: str, desc: str, success: bool = True, detail: str | None = None) -> VerificationStep:
            nonlocal step
            step += 1
            return VerificationStep(step=step, action=action, description=desc, success=success, detail=detail)

        yield nxt("init", f"调用 OpenClaw CLI ({settings.openclaw_bin})")
        yield nxt("todo", "OpenClaw 集成待补完：openclaw browser open + snapshot + act 序列",
                  success=False, detail="OpenClaw 视觉+语义识别，可挂到已登录的真实 Chrome")
        self.set_extracted_fields([])


# ========== Configurable Agent（用户主导工作流） ==========
class ConfigurableAgent(BaseAgent):
    """按用户配置的工作流执行，并支持字段映射与 Vision API 验证。

    与 BrowserUseAgent 不同：
      - 不由 LLM 自主规划，而是严格按 workflow 步骤执行
      - 支持从 Excel / 数据库 / 护照 OCR 取值填入右侧
      - 支持用户手动绑定右侧输入框 ←→ 左侧字段
      - 最终用 Vision API 做对比判定（也支持 exact/contains/ocr 规则）
    """

    name = "configurable"

    async def verify(
        self,
        record_id: str,
        university_url: str,
        expected_fields: dict[str, str],
    ) -> AsyncIterator[VerificationStep]:
        step = 0

        def nxt(action: str, desc: str, success: bool = True, detail: str | None = None) -> VerificationStep:
            nonlocal step
            step += 1
            return VerificationStep(step=step, action=action, description=desc, success=success, detail=detail)

        cfg = self.workflow_config
        if cfg is None:
            yield nxt("error", "未提供 workflow_config", success=False)
            self.set_extracted_fields([])
            return

        try:
            from browser_use.browser import BrowserProfile, BrowserSession
        except ImportError as e:
            yield nxt("error", "缺少依赖", success=False, detail=f"请执行: pip install browser-use\n缺: {e}")
            self.set_extracted_fields([])
            return

        yield nxt("init", "初始化 Configurable Agent（用户配置工作流）")

        profile_kwargs = _browser_profile_kwargs()
        profile = BrowserProfile(**profile_kwargs)
        session = BrowserSession(browser_profile=profile)

        # 存储当前页面的 bbox / screenshot，供前端字段映射使用
        latest_boxes: list[InputBox] = []
        latest_viewport: tuple[int | None, int | None] = (None, None)
        latest_screenshot: str | None = None
        latest_inputs: dict[str, WebsiteInput] = {}  # selector -> WebsiteInput

        async def push_screenshot(action_hint: str = "") -> None:
            nonlocal latest_screenshot
            if not self.task_id:
                return
            try:
                shot = await session.take_screenshot()
                latest_screenshot = shot
                url = await session.get_current_page_url()
                title = await session.get_current_page_title()
                # 抽取当前所有 input 的 bbox
                page = await _get_page()
                boxes: list[InputBox] = []
                if page is not None:
                    boxes = await _extract_boxes(page)
                    if boxes:
                        nonlocal latest_boxes
                        latest_boxes = boxes
                        # latest_viewport 已在 _extract_boxes 里更新
                event = ScreenshotEvent(
                    step=step,
                    screenshot=shot,
                    url=url,
                    title=title,
                    action_hint=action_hint,
                    boxes=boxes or latest_boxes,
                    viewport_width=latest_viewport[0],
                    viewport_height=latest_viewport[1],
                )
                from ..services.task_manager import emit_screenshot
                await emit_screenshot(self.task_id, event)
            except Exception:
                pass

        async def _get_page():
            """获取当前 Page 对象，browser-use 0.13.6 中 start 后才有 page。"""
            try:
                page = await session.get_current_page()
                if page is not None:
                    return page
                return await session.must_get_current_page()
            except Exception:
                return None

        async def _extract_boxes(page) -> list[InputBox]:
            """抽取页面所有 input/select/textarea 的 bbox 和当前值。"""
            js = (
                "() => JSON.stringify({"
                "  viewport: { w: window.innerWidth, h: window.innerHeight },"
                "  inputs: Array.from(document.querySelectorAll('input, select, textarea, img, [role=img]')).map((el, idx) => {"
                "    const r = el.getBoundingClientRect();"
                "    let label = '';"
                "    if (el.id) { const l = document.querySelector('label[for=\"' + el.id + '\"]'); if (l) label = (l.textContent || '').trim(); }"
                "    if (!label) { const l = el.closest('label'); if (l) label = (l.textContent || '').trim(); }"
                "    if (!label && el.placeholder) label = el.placeholder;"
                "    if (!label && el.getAttribute('aria-label')) label = el.getAttribute('aria-label');"
                "    let sel = '';"
                "    if (el.id) sel = '#' + el.id;"
                "    else if (el.name) sel = '[name=\"' + el.name + '\"]';"
                "    else sel = el.tagName.toLowerCase() + ':nth-of-type(' + (idx + 1) + ')';"
                "    const isImg = el.tagName === 'IMG' || el.getAttribute('role') === 'img';"
                "    const val = isImg ? (el.src || '') : (el.value || el.textContent || '');"
                "    return { selector: sel, label: label, value: String(val).trim(), input_type: isImg ? 'image' : (el.type || el.tagName.toLowerCase()),"
                "             x: r.left, y: r.top, width: r.width, height: r.height };"
                "  }).filter(item => item.width > 0 && item.height > 0)"
                "})"
            )
            try:
                raw = await page.evaluate(js)
                import json as _json
                data = _json.loads(raw) if raw else {}
                nonlocal latest_viewport
                latest_viewport = (data.get("viewport", {}).get("w"), data.get("viewport", {}).get("h"))
                boxes: list[InputBox] = []
                for item in data.get("inputs", []):
                    boxes.append(InputBox(
                        selector=item.get("selector", ""),
                        label=item.get("label") or None,
                        value=item.get("value") or None,
                        x=float(item.get("x", 0)),
                        y=float(item.get("y", 0)),
                        width=float(item.get("width", 0)),
                        height=float(item.get("height", 0)),
                        match_status="pending",
                    ))
                    latest_inputs[item.get("selector", "")] = WebsiteInput(
                        label=item.get("label") or item.get("selector", ""),
                        value=item.get("value") or "",
                        selector_hint=item.get("selector", ""),
                        input_type=item.get("input_type") or "text",
                    )
                return boxes
            except Exception:
                return []

        async def _resolve_value(value_from: str | None, value: str | None, record_fields: dict[str, str]) -> str:
            """解析 value_from 或 value。"""
            if not value_from:
                return value or ""
            # 格式：source.field，如 excel.student_id / db.passport_no / passport.name
            if "." in value_from:
                source, field = value_from.split(".", 1)
                # 目前 Excel 和 database/manual 都统一在 record_fields 里
                # passport 通过 task_manager 额外传入（见 verify 调用处）
                if source in ("excel", "db", "database", "manual"):
                    return record_fields.get(field, "")
                if source == "passport":
                    # passport 字段在 expected_fields 中以 passport_ 前缀或单独 dict 传入
                    return record_fields.get(field, "")
            return record_fields.get(value_from, value or "")

        async def _execute_step(st: WorkflowStep, record_fields: dict[str, str]) -> str:
            """执行单个工作流步骤，返回 human readable 结果。"""
            page = await _get_page()
            if page is None:
                return "无法获取页面"
            selector = st.selector or ""
            val = await _resolve_value(st.value_from, st.value, record_fields)

            if st.action == "click":
                js = (
                    "(sel) => {"
                    "  const el = document.querySelector(sel);"
                    "  if (!el) throw new Error('Element not found: ' + sel);"
                    "  el.scrollIntoView({block:'center'});"
                    "  el.click();"
                    "  return 'clicked';"
                    "}"
                )
                await page.evaluate(js, selector)
                return f"点击 {selector}"

            if st.action == "type":
                js = (
                    "(args) => {"
                    "  const el = document.querySelector(args[0]);"
                    "  if (!el) throw new Error('Element not found: ' + args[0]);"
                    "  el.scrollIntoView({block:'center'});"
                    "  el.focus();"
                    "  el.value = args[1];"
                    "  el.dispatchEvent(new Event('input', {bubbles:true}));"
                    "  el.dispatchEvent(new Event('change', {bubbles:true}));"
                    "  return 'typed ' + args[1].length + ' chars';"
                    "}"
                )
                await page.evaluate(js, [selector, val])
                return f"在 {selector} 输入 {val[:20]}"

            if st.action == "select":
                js = (
                    "(args) => {"
                    "  const el = document.querySelector(args[0]);"
                    "  if (!el) throw new Error('Element not found: ' + args[0]);"
                    "  el.value = args[1];"
                    "  el.dispatchEvent(new Event('change', {bubbles:true}));"
                    "  return 'selected ' + args[1];"
                    "}"
                )
                await page.evaluate(js, [selector, val])
                return f"在 {selector} 选择 {val[:20]}"

            if st.action == "wait":
                await asyncio.sleep(st.wait_seconds or 1.0)
                return f"等待 {st.wait_seconds or 1.0}s"

            if st.action == "screenshot":
                await push_screenshot("用户要求截图")
                return "已推送截图"

            if st.action == "extract":
                # 按 mapping 提取字段，在 verify 主循环中处理
                return f"准备提取 {selector}"

            return f"未知动作 {st.action}"

        # ===== 主执行流程 =====
        try:
            yield nxt("start", "启动浏览器会话")
            await session.start()

            if settings.browser_use_cdp_url:
                focused = await _focus_browser_view_target(session, university_url)
                if not focused:
                    yield nxt("warn", "未能定位到嵌入的 BrowserView，Agent 可能操作到默认页面")

            yield nxt("navigate", f"打开 {university_url}")
            await session.navigate_to(university_url)
            await asyncio.sleep(2.0)
            await push_screenshot("页面已打开")

            # 执行工作流步骤
            for i, st in enumerate(cfg.workflow):
                desc = st.description or f"{st.action} {st.selector or ''}"
                try:
                    if st.action == "manual":
                        # 人工步骤：推送截图后暂停，等待前端发送继续信号
                        await push_screenshot("等待人工操作")
                        yield nxt("manual", desc, detail="请在新打开的浏览器窗口中完成登录/人工操作，然后点击「继续」")
                        from ..services.task_manager import get_continue_event
                        ev = get_continue_event(self.task_id or "")
                        await ev.wait()
                        yield nxt("manual", f"{desc} 已继续", detail="用户已确认继续")
                    else:
                        result_desc = await _execute_step(st, expected_fields)
                        yield nxt(st.action, desc, detail=result_desc)
                except Exception as e:
                    yield nxt(st.action, f"{desc} 失败", success=False, detail=str(e))
                if st.use_vision or st.action in ("click", "type", "select"):
                    await asyncio.sleep(0.5)
                    await push_screenshot(desc)

            # 最终截图 + 提取所有输入框（用于字段映射）
            await asyncio.sleep(1.0)
            page = await _get_page()
            boxes: list[InputBox] = []
            if page is not None:
                boxes = await _extract_boxes(page)
            await push_screenshot("工作流执行完毕，可开始字段映射")

            async def _screenshot_element(selector: str) -> str:
                """对指定元素截图并返回 base64（用于图片 OCR）。"""
                try:
                    # 优先用 Playwright locator 截图
                    loc = page.locator(selector).first
                    buf = await loc.screenshot(timeout=5000)
                    return base64.b64encode(buf).decode("utf-8")
                except Exception:
                    # 兜底：JS 获取元素位置，然后整页截图裁剪
                    js = (
                        "(sel) => {"
                        "  const el = document.querySelector(sel);"
                        "  if (!el) return null;"
                        "  const r = el.getBoundingClientRect();"
                        "  return {x: r.left, y: r.top, w: r.width, h: r.height};"
                        "}"
                    )
                    pos = await page.evaluate(js, selector)
                    if not pos:
                        return ""
                    full = await page.screenshot()
                    from PIL import Image
                    import io
                    im = Image.open(io.BytesIO(full))
                    crop = im.crop((pos["x"], pos["y"], pos["x"] + pos["w"], pos["y"] + pos["h"]))
                    buf = io.BytesIO()
                    crop.save(buf, format="PNG")
                    return base64.b64encode(buf.getvalue()).decode("utf-8")

            # 按 mapping 提取右侧值
            extracted: dict[str, WebsiteField] = {}
            if cfg.mappings and page is not None:
                for mp in cfg.mappings:
                    try:
                        is_ocr = mp.verify_method == "ocr"
                        is_smart = mp.verify_method == "smart" or mp.verify_method == "vision"
                        is_image = False
                        if is_smart:
                            js_check = (
                                "(sel) => {"
                                "  const el = document.querySelector(sel);"
                                "  return !!(el && (el.tagName === 'IMG' || el.getAttribute('role') === 'img'));"
                                "}"
                            )
                            is_image = await page.evaluate(js_check, mp.right_selector)
                        if is_ocr or (is_smart and is_image):
                            # OCR / 智能匹配遇到图片：对目标元素截图，返回 base64
                            val = await _screenshot_element(mp.right_selector)
                        else:
                            js = (
                                "(sel) => {"
                                "  const el = document.querySelector(sel);"
                                "  if (!el) return null;"
                                "  if (el.tagName === 'IMG' || el.getAttribute('role') === 'img') return el.src;"
                                "  return el.value || el.textContent || '';"
                                "}"
                            )
                            raw = await page.evaluate(js, mp.right_selector)
                            val = str(raw) if raw is not None else ""
                        extracted[mp.right_selector] = WebsiteField(
                            name=mp.left_field,
                            value=val,
                            selector_hint=mp.right_selector,
                        )
                    except Exception as e:
                        yield nxt("extract", f"提取 {mp.right_selector} 失败", success=False, detail=str(e))

            yield nxt("extract", f"按 mapping 提取到 {len(extracted)} 个字段")
            yield nxt("done", "Configurable Agent 执行完成")

            self.set_extracted_fields(list(extracted.values()))
            self.set_extracted_inputs(list(latest_inputs.values()))
            self.input_boxes: list[InputBox] = boxes  # type: ignore[attr-defined]
            self.viewport_size = latest_viewport  # type: ignore[attr-defined]
            self.last_screenshot: str | None = latest_screenshot  # type: ignore[attr-defined]
        except Exception as e:
            detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
            yield nxt("error", "执行异常", success=False, detail=detail)
            self.set_extracted_fields([])
        finally:
            await session.close()


# ========== 工厂 ==========
_REGISTRY: dict[str, type[BaseAgent]] = {
    "mock": MockAgent,
    "browser_use": BrowserUseAgent,
    "configurable": ConfigurableAgent,
    "hermes": HermesAgent,
    "openclaw": OpenClawAgent,
}


def get_agent() -> BaseAgent:
    """根据 settings.agent_backend 返回一个新 Agent 实例。"""
    cls = _REGISTRY.get(settings.agent_backend, MockAgent)
    return cls()
