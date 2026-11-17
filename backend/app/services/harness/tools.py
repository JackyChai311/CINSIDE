"""HARNESS 工具注册表（OpenAI / GLM function-calling 格式）。

约定：
  * 工具名与作用域前缀一致：`web_*` 只作用于网页对象，`excel_*` 只作用于 Excel 对象；
    没有绑定对应对象时工具**不会**下发给模型（避免模型硬编造参数乱调）。
  * 所有 handler 返回 dict，会被序列化成 tool 消息内容；失败统一 `{"ok": false, "error": ...}`
    而不是抛异常 —— 让模型看到错误并自我纠正，比中断整个任务好得多。
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Awaitable, Callable

from .cdp import CDPError
from .excel_book import ExcelError, ExcelTarget
from .slide import SlideError, SlideTarget
from .web import WebTarget
from .workspace import WorkspaceError, WorkspaceTarget

# 动作后自动附带的观察摘要（模型不用多花一轮去看页面变了没有）
_POST_ACTION = True


def _schema(props: dict[str, Any], required: list[str] | None = None) -> dict:
    return {
        "type": "object",
        "properties": props,
        "required": required or [],
        "additionalProperties": False,
    }


_S = {"type": "string"}
_I = {"type": "integer"}
_B = {"type": "boolean"}

TOOL_DEFS: list[dict] = [
    # ---------- 网页 ----------
    {
        "name": "web_observe",
        "scope": "web",
        "description": (
            "观察当前网页：返回地址、标题、可见文本、所有可交互元素（每个带 e1/e2 这样的引用编号、"
            "角色、名称、是否在视口内、输入框当前值/下拉选项）。"
            "首次操作前必须调用它拿引用；同一页面内引用稳定可复用，页面跳转/刷新后必须重新观察。"
        ),
        "parameters": _schema({
            "max_elements": {**_I, "description": "最多返回多少个元素，默认 120"},
            "max_text": {**_I, "description": "正文最多返回多少字符，默认 5000"},
        }),
    },
    {
        "name": "web_click",
        "scope": "web",
        "description": "点击网页上某个引用元素（真实鼠标事件，会先自动滚动到可视区）。",
        "parameters": _schema({
            "ref": {**_S, "description": "元素引用，如 e12"},
            "times": {**_I, "description": "连击次数，默认 1（双击填 2）"},
        }, ["ref"]),
    },
    {
        "name": "web_type",
        "scope": "web",
        "description": "在输入框/文本域/可编辑区里输入文本。默认先清空原内容；submit=true 时输入后按回车。",
        "parameters": _schema({
            "ref": _S,
            "text": {**_S, "description": "要输入的文本"},
            "clear": {**_B, "description": "是否先清空，默认 true"},
            "submit": {**_B, "description": "输入后是否按回车，默认 false"},
        }, ["ref", "text"]),
    },
    {
        "name": "web_select",
        "scope": "web",
        "description": (
            "在下拉框中选中一项。原生 <select> 按 value 或显示文字匹配（支持模糊）；"
            "自定义下拉会先展开，然后你需要用 web_click 点击目标选项。"
        ),
        "parameters": _schema({
            "ref": _S,
            "value": {**_S, "description": "选项的 value 或显示文字"},
        }, ["ref", "value"]),
    },
    {
        "name": "web_press",
        "scope": "web",
        "description": "发送键盘按键：Enter / Tab / Escape / Backspace / ArrowDown / ArrowUp / PageDown / Space 等。",
        "parameters": _schema({
            "key": _S,
            "times": _I,
        }, ["key"]),
    },
    {
        "name": "web_scroll",
        "scope": "web",
        "description": (
            "滚动页面（方向 + 像素）。给了 ref 就滚到该元素位置。"
            "left/right 横向滚动：内容被截断在视口右侧时（scroll.max_x>0）先横滚看全，不要断言「页面上没有」。"
        ),
        "parameters": _schema({
            "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
            "amount": {**_I, "description": "像素，默认 600"},
            "ref": {**_S, "description": "可选：滚到该元素"},
        }),
    },
    {
        "name": "web_zoom_fit",
        "scope": "web",
        "description": (
            "把网页缩放到宽度正好放进视口（只缩小不放大，比例合适时不会改动）。"
            "任务开始绑定时系统已自动执行一次；页面跳转/布局变化后仍出现横向截断时可再调用。"
        ),
        "parameters": _schema({}),
    },
    {
        "name": "web_navigate",
        "scope": "web",
        "description": "让网页跳转到指定 URL（注意：会离开当前页面，谨慎使用）。",
        "parameters": _schema({"url": _S}, ["url"]),
    },
    {
        "name": "web_extract",
        "scope": "web",
        "description": (
            "结构化抽取网页内容：kind=text 正文 / table 表格 / list 列表 / links 链接。"
            "给了 ref 就只抽该元素内部。抓表格往 Excel 里搬时优先用 table。"
        ),
        "parameters": _schema({
            "ref": _S,
            "kind": {"type": "string", "enum": ["text", "table", "list", "links"]},
            "limit": {**_I, "description": "最多多少行/项，默认 50"},
        }),
    },
    {
        "name": "web_screenshot",
        "scope": "web",
        "description": (
            "给当前网页截图（可选只截某个元素）。用于布局复杂、文本快照不足以判断时"
            "（如验证码、图形按钮、画布内容）。截图会显示给用户。"
        ),
        "parameters": _schema({
            "ref": _S,
            "full_page": {**_B, "description": "true=整页长截图"},
        }),
    },
    {
        "name": "web_eval",
        "scope": "web",
        "description": (
            "在网页里执行一段 JS 并返回结果（逃生通道）。仅在常规工具做不到时使用，"
            "例如读取某个不存在于快照里的自定义控件状态。"
        ),
        "parameters": _schema({"js": {**_S, "description": "要执行的 JS 表达式"}}, ["js"]),
    },
    # ---------- Excel ----------
    {
        "name": "excel_summary",
        "scope": "excel",
        "description": "查看 Excel 结构：工作表名、表头、行列数、前几行示例。开始操作前先调用它。",
        "parameters": _schema({}),
    },
    {
        "name": "excel_sheet",
        "scope": "excel",
        "description": (
            "管理工作表：action=create 新建（可同时写表头 / list 列出 / rename 改名 / delete 删除）。"
            "要把抓取结果写入「新的一张表」时，先用 create 建表并给 headers，再用 excel_fill_column 或 "
            "excel_write 按行号写入。"
        ),
        "parameters": _schema({
            "action": {"type": "string", "enum": ["create", "list", "rename", "delete"]},
            "name": {**_S, "description": "工作表名（create=新表名；rename/delete=原表名）"},
            "new_name": {**_S, "description": "rename 时的新名字"},
            "headers": {
                "type": "array",
                "items": {},
                "description": "create 时可选：直接写入第一行表头",
            },
        }, ["action"]),
    },
    {
        "name": "excel_read",
        "scope": "excel",
        "description": (
            "读取单元格区域（如 A1:D20），返回每行以单元格地址开头的数据。"
            "默认区域只覆盖表头往下 400 行 × 前若干列；数据可能在更右的列或更下的行——"
            "找不到需要的列/行时，先用 excel_summary 看行列总数，再指定完整区域（如 A1:Z2000）分段读取，"
            "或用 excel_find 全表搜索，不要凭默认读取结果断言「表里没有」。"
        ),
        "parameters": _schema({
            "sheet": {**_S, "description": "工作表名，留空=第一个"},
            "range": {**_S, "description": "区域，如 A1:H30；留空=表头到往下 400 行"},
            "with_header": {**_B, "description": "是否附带表头，默认 true"},
        }),
    },
    {
        "name": "excel_write",
        "scope": "excel",
        "description": (
            "批量写入单元格。cell 支持 A1 记法（B7）或「表头名+行号」（姓名7 / 姓名@7）。"
            "一次调用尽量写完所有格子，比逐格调用快得多。"
        ),
        "parameters": _schema({
            "updates": {
                "type": "array",
                "description": "写入列表",
                "items": _schema({
                    "sheet": {**_S, "description": "工作表名，留空=当前第一个"},
                    "cell": {**_S, "description": "单元格，如 B7 或 姓名7"},
                    "value": {"description": "写入的值（数字/文本）"},
                }, ["cell", "value"]),
            },
        }, ["updates"]),
    },
    {
        "name": "excel_fill_column",
        "scope": "excel",
        "description": "把一组值从上往下填进某一列（整列批量填写的首选）。",
        "parameters": _schema({
            "sheet": _S,
            "column": {**_S, "description": "列字母或表头名，如 C 或 姓名"},
            "values": {"type": "array", "items": {}, "description": "从起始行往下依次写入的值"},
            "start_row": {**_I, "description": "起始行号，默认表头下一行"},
        }, ["column", "values"]),
    },
    {
        "name": "excel_append_row",
        "scope": "excel",
        "description": "在表格末尾追加一行（按列顺序给值）。",
        "parameters": _schema({
            "sheet": _S,
            "values": {"type": "array", "items": {}},
        }, ["values"]),
    },
    {
        "name": "excel_find",
        "scope": "excel",
        "description": "在表格里按文本查找行（可用于定位某个人/某个编号所在行）。",
        "parameters": _schema({
            "sheet": _S,
            "query": _S,
            "column": {**_S, "description": "只在这些列里找（可选）"},
            "limit": _I,
        }, ["query"]),
    },
    {
        "name": "excel_export",
        "scope": "excel",
        "description": (
            "把改好的工作簿另存为 .xlsx。path 留空则存到系统下载目录（文件名带 HARNESS 时间戳）。"
            "任务结束时如果改过表格，调用一次给用户交付文件。"
        ),
        "parameters": _schema({"path": {**_S, "description": "完整保存路径（可选）"}}),
    },
    # ---------- SLIDE STUDIO：PPT ----------
    {
        "name": "slide_summary",
        "scope": "slide",
        "description": "查看 PPT 结构：总页数、每页标题、正文摘要。开始操作前先调用它。",
        "parameters": _schema({}),
    },
    {
        "name": "slide_read",
        "scope": "slide",
        "description": "读取某一页的全部文本节点（带形状路径 path，修改文字时用它定位）。",
        "parameters": _schema({"slide": {**_I, "description": "页码，从 1 开始"}}, ["slide"]),
    },
    {
        "name": "slide_set_text",
        "scope": "slide",
        "description": "替换某页某个文本节点的文字。path 用 slide_read 返回的形状路径。",
        "parameters": _schema({
            "slide": _I,
            "path": {**_S, "description": "形状路径，如 shape[2]/paragraph[1]"},
            "text": _S,
        }, ["slide", "path", "text"]),
    },
    {
        "name": "slide_add_text",
        "scope": "slide",
        "description": "在某页新增一个文本框（位置/尺寸用英寸，如 1.2in）。",
        "parameters": _schema({
            "slide": _I,
            "text": _S,
            "x": _S, "y": _S, "w": _S, "h": _S,
            "font_size": {**_S, "description": "字号，默认 24"},
        }, ["slide", "text"]),
    },
    {
        "name": "slide_add_slide",
        "scope": "slide",
        "description": "在指定页之后插入新页（after=0 表示插到最前），可同时给标题与正文。",
        "parameters": _schema({
            "after": {**_I, "description": "插到第几页之后，0=最前"},
            "title": _S,
            "body": _S,
        }),
    },
    {
        "name": "slide_screenshot",
        "scope": "slide",
        "description": "把某页渲染成 PNG 图片（返回文件路径）。做视频时逐页调用它拿画面。",
        "parameters": _schema({"slide": _I}, ["slide"]),
    },
    {
        "name": "slide_export",
        "scope": "slide",
        "description": (
            "把改好的 PPT 交付为文件。path 留空则存到源文件旁（文件名带 _SLIDE 时间戳，不覆盖原件）。"
            "任务结束时如果改过 PPT，调用一次给用户交付。"
        ),
        "parameters": _schema({"path": {**_S, "description": "完整保存路径（可选）"}}),
    },
    # ---------- SLIDE STUDIO：视频（逐页导图 + TTS + ffmpeg，无 Remotion） ----------
    {
        "name": "video_tts",
        "scope": "video",
        "description": (
            "把一段解说词合成为配音 WAV（Windows 系统语音）。返回音频路径，"
            "供 video_compose 的 pages[].audio 使用。"
        ),
        "parameters": _schema({
            "text": {**_S, "description": "解说词（口语化，别太长，单页建议 80 字内）"},
            "rate": {**_I, "description": "语速 -10..10，默认 0"},
        }, ["text"]),
    },
    {
        "name": "video_compose",
        "scope": "video",
        "description": (
            "把逐页画面合成 MP4：pages 数组每项 {image: slide_screenshot 返回的 PNG 路径, "
            "audio: video_tts 返回的 WAV 路径（可空）, duration: 无配音时的停留秒数（默认 4）}。"
            "每页时长自动取配音时长。需要 ffmpeg（设置页可一键下载）。"
        ),
        "parameters": _schema({
            "pages": {
                "type": "array",
                "items": _schema({
                    "image": _S,
                    "audio": _S,
                    "duration": {"type": "number"},
                }, ["image"]),
                "description": "按播放顺序排列的页面",
            },
            "out_path": {**_S, "description": "输出 MP4 完整路径（可选，默认下载目录）"},
        }, ["pages"]),
    },
    {
        "name": "video_from_frames",
        "scope": "video",
        "description": (
            "HTML 动画录屏路径：把连续截图帧合成 MP4。帧需保存为 frames_dir 下的 "
            "frame-00001.png、frame-00002.png…（可先用 web_screenshot 连拍再逐帧保存）。"
        ),
        "parameters": _schema({
            "frames_dir": {**_S, "description": "帧目录"},
            "fps": {**_I, "description": "帧率，默认 10"},
            "audio": {**_S, "description": "可选配音 WAV 路径"},
            "out_path": _S,
        }, ["frames_dir"]),
    },
    # ---------- COWORK STUDIO：协作工作区 ----------
    {
        "name": "file_list",
        "scope": "workspace",
        "description": "列出协作工作区里的全部文件（相对路径 + 大小）。",
        "parameters": _schema({}),
    },
    {
        "name": "file_read",
        "scope": "workspace",
        "description": "读取工作区里的一个文本文件（代码 / 文档 / 数据）。",
        "parameters": _schema({"path": {**_S, "description": "工作区内相对路径"}}, ["path"]),
    },
    {
        "name": "file_write",
        "scope": "workspace",
        "description": (
            "把成果写入工作区文件（报告 / 代码 / 文案）。append=true 追加。"
            "最终交付物写成完整文件，不要只在对话里贴内容。"
        ),
        "parameters": _schema({
            "path": _S,
            "text": _S,
            "append": _B,
        }, ["path", "text"]),
    },
    {
        "name": "file_export",
        "scope": "workspace",
        "description": "把工作区成果文件复制到用户下载目录（或指定路径）。任务结束时对最终交付物调用一次。",
        "parameters": _schema({
            "path": {**_S, "description": "工作区内相对路径"},
            "dest": {**_S, "description": "目标完整路径（可选）"},
        }, ["path"]),
    },
    # ---------- CINSIDE LOOP（真正的自动化流程引擎，由前端执行器代办） ----------
    {
        "name": "loop_status",
        "scope": "web",
        "description": (
            "查看 CINSIDE LOOP 引擎状态：已生成的人物卡片数、当前/已保存的 LOOP 模板（CIRCLE）、"
            "左右面板网页。批量任务优先走 LOOP 引擎而不是逐条 web_* 手工操作。"
        ),
        "parameters": _schema({}),
    },
    {
        "name": "loop_make_cards",
        "scope": "web",
        "description": (
            "从绑定的 Excel 生成人物卡片（等价于用户在 Excel 框选行范围后点「一键生成卡片」）。"
            "rows 留空=全部数据行。生成的卡片是 LOOP 批量执行的数据源。"
        ),
        "parameters": _schema({
            "start_row": {**_I, "description": "起始数据行（1=第一条数据，不含表头），默认 1"},
            "end_row": {**_I, "description": "结束数据行（含），默认到最后一行"},
        }),
    },
    {
        "name": "loop_build_template",
        "scope": "web",
        "description": (
            "把你观察到的操作固化成 CINSIDE LOOP 模板（CIRCLE）：前置点击(pre)→绑定输入/录入审查→"
            "过程点击(mid)→收尾点击(post)，支持挂件(widget)与文件提取(doc_extract)。"
            "steps 按执行顺序给出，每步 {kind, side, selector, label, column?, value?, phase?, widget?, doc_url?}：\n"
            "- kind=click：真实点击。phase=pre 前置(搜索/进入详情)/mid 过程(NEXT等)/post 收尾(保存/返回)；缺省按普通步骤。\n"
            "- kind=input：绑定输入框。column=Excel 列名（LOOP 逐行取值），或 value=固定值；selector=目标输入框。\n"
            "- kind=review：审查对比。column=Excel 列名，selector=网页上显示该值的元素。\n"
            "- kind=widget：日历/选项挂件。widget={kind:'option'|'calendar', trigger_selector, panel_selector?, options?:[{value,selector}], calendar?:{...}}，column=值来源列。\n"
            "- kind=doc_extract：文件提取（看图/OCR）。selector=图片/PDF链接，doc_url 可选。\n"
            "selector 必须是真实 CSS 选择器（从 web_observe/web_eval 确认），不要编造。"
            "mode：entry=录入 / review=审查 / loop=全流程。"
        ),
        "parameters": _schema({
            "name": {**_S, "description": "模板名，如「学生信息录入」"},
            "mode": {"type": "string", "enum": ["entry", "review", "loop"]},
            "steps": {
                "type": "array",
                "items": _schema({
                    "kind": {"type": "string", "enum": ["click", "input", "review", "widget", "doc_extract"]},
                    "side": {"type": "string", "enum": ["left", "right"]},
                    "selector": _S,
                    "label": _S,
                    "column": {**_S, "description": "Excel 列名（input/review/widget 的值来源）"},
                    "value": {**_S, "description": "固定值（无 column 时用）"},
                    "phase": {"type": "string", "enum": ["pre", "mid", "post"]},
                    "widget": {"type": "object", "additionalProperties": True},
                    "doc_url": _S,
                }, ["kind", "side", "selector"]),
            },
        }, ["name", "steps"]),
    },
    {
        "name": "loop_run_first",
        "scope": "web",
        "description": (
            "用 LOOP 引擎完整试跑第一张人物卡片（开荒）：真实执行模板的全部步骤"
            "（前置点击→输入/挂件/文件提取→过程点击→收尾点击）。返回每一步成败与失败原因。"
            "失败就修模板（loop_build_template 重建）或先用 web_* 排查页面，成功后再 loop_run_all。"
        ),
        "parameters": _schema({
            "template_id": {**_S, "description": "loop_build_template 返回的模板 id；留空=最近建的"},
        }),
    },
    {
        "name": "loop_run_all",
        "scope": "web",
        "description": (
            "用 LOOP 引擎批量执行其余全部卡片（不再逐条调用 AI）：自动逐行替换 Excel 值、"
            "重复整个 CIRCLE。前提：loop_run_first 已成功。返回成功/失败/跳过统计与失败明细。"
        ),
        "parameters": _schema({
            "template_id": {**_S, "description": "留空=最近建的模板"},
            "skip_first": {**_B, "description": "跳过第一张（已开荒成功），默认 true"},
        }),
    },
    # ---------- 控制 ----------
    {
        "name": "task_done",
        "scope": "none",
        "description": (
            "任务目标真正达成时才调用（本调用不占动作步预算，收尾永远可用）。"
            "summary 要说清做了什么、结果如何、文件存在哪。"
            "如果任务卡住/未达成（找不到必需字段、页面异常、流程走不通），不要调用本工具宣称完成，"
            "改用 ask_user 说明卡点，或在 content 里如实说明未完成。"
        ),
        "parameters": _schema({
            "summary": {**_S, "description": "给用户看的完成说明（简洁、具体、可核对）"},
        }, ["summary"]),
    },
    {
        "name": "ask_user",
        "scope": "none",
        "description": (
            "遇到必须由人决定的分叉（如多个同名匹配、要不要覆盖已有数据）时提问，"
            "系统会暂停等你回答。非必要不要用。"
        ),
        "parameters": _schema({
            "question": _S,
            "options": {"type": "array", "items": _S, "description": "建议选项（可选）"},
        }, ["question"]),
    },
]


class HarnessTools:
    """持有两个对象，执行工具调用。"""

    def __init__(
        self,
        web: WebTarget | None = None,
        excel: ExcelTarget | None = None,
        *,
        slide: SlideTarget | None = None,
        workspace: WorkspaceTarget | None = None,
        video: bool = False,
        on_ask: Callable[[str, list[str]], Awaitable[str]] | None = None,
        on_screenshot: Callable[[dict], Awaitable[None]] | None = None,
    ):
        self.web = web
        self.excel = excel
        self.slide = slide
        self.workspace = workspace
        self.video = video
        self.on_ask = on_ask
        self.on_screenshot = on_screenshot
        self.done_summary: str | None = None
        # 视频页画面缓存：slide_screenshot 产出的 PNG 路径（模型直接引用）
        self._shot_seq = 0

    # ---------- 下发 ----------

    @property
    def scopes(self) -> set[str]:
        out = {"none"}
        if self.web:
            out.add("web")
        if self.excel:
            out.add("excel")
        if self.slide:
            out.add("slide")
        if self.workspace:
            out.add("workspace")
        if self.video:
            out.add("video")
        return out

    def schemas(self) -> list[dict]:
        allowed = self.scopes
        out = []
        for t in TOOL_DEFS:
            if t["scope"] not in allowed:
                continue
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t["description"],
                        "parameters": t["parameters"],
                    },
                }
            )
        return out

    # ---------- 执行 ----------

    async def run(self, name: str, args: dict | None) -> dict:
        args = args or {}
        try:
            if name == "web_observe":
                return await self._web_observe(args)
            if name == "web_click":
                return await self._web_action(await self._require_web().click(str(args.get("ref", "")), click_count=int(args.get("times") or 1)))
            if name == "web_type":
                return await self._web_action(
                    await self._require_web().type_text(
                        str(args.get("ref", "")),
                        str(args.get("text", "")),
                        clear=bool(args.get("clear", True)),
                        submit=bool(args.get("submit", False)),
                    ),
                    settle_ms=260,
                )
            if name == "web_select":
                res = await self._require_web().select(str(args.get("ref", "")), str(args.get("value", "")))
                if res.get("pending"):
                    return res
                return await self._web_action(res)
            if name == "web_press":
                return await self._web_action(
                    await self._require_web().press(str(args.get("key", "Enter")), times=int(args.get("times") or 1))
                )
            if name == "web_scroll":
                return await self._web_action(
                    await self._require_web().scroll(
                        str(args.get("direction") or "down"),
                        int(args.get("amount") or 600),
                        str(args.get("ref") or ""),
                    ),
                    light=True,
                )
            if name == "web_zoom_fit":
                res = await self._require_web().autofit_zoom()
                return res if isinstance(res, dict) else {"ok": False, "error": "缩放失败"}
            if name == "web_navigate":
                return await self._web_action(await self._require_web().navigate(str(args.get("url", ""))), settle_ms=900)
            if name == "web_extract":
                return await self._require_web().extract(
                    str(args.get("ref") or ""),
                    str(args.get("kind") or "text"),
                    int(args.get("limit") or 50),
                )
            if name == "web_screenshot":
                shot = await self._require_web().screenshot(
                    str(args.get("ref") or ""), bool(args.get("full_page"))
                )
                if self.on_screenshot:
                    await self.on_screenshot(shot)
                return {
                    "ok": True,
                    "width": shot["width"],
                    "height": shot["height"],
                    "note": "截图已展示给用户（若你支持看图，图像会一并回传）",
                }
            if name == "web_eval":
                value = await self._require_web().evaluate(str(args.get("js", "")))
                return {"ok": True, "result": _truncate(value, 4000)}
            if name == "excel_summary":
                return {"ok": True, **(await self._require_excel().summary())}
            if name == "excel_sheet":
                return await self._require_excel().sheet(
                    str(args.get("action") or "list"),
                    str(args.get("name") or ""),
                    str(args.get("new_name") or ""),
                    args.get("headers") if isinstance(args.get("headers"), list) else None,
                )
            if name == "excel_read":
                res = await self._require_excel().read(
                    str(args.get("sheet") or ""),
                    str(args.get("range") or ""),
                    bool(args.get("with_header", True)),
                )
                return {"ok": True, **res}
            if name == "excel_write":
                ups = args.get("updates") or []
                if not isinstance(ups, list):
                    return {"ok": False, "error": "updates 必须是数组"}
                res = await self._require_excel().write(ups)
                return res
            if name == "excel_fill_column":
                vals = args.get("values") or []
                if not isinstance(vals, list):
                    return {"ok": False, "error": "values 必须是数组"}
                return await self._require_excel().fill_column(
                    str(args.get("sheet") or ""),
                    str(args.get("column") or ""),
                    vals,
                    int(args.get("start_row") or 0),
                )
            if name == "excel_append_row":
                vals = args.get("values") or []
                if not isinstance(vals, list):
                    return {"ok": False, "error": "values 必须是数组"}
                return await self._require_excel().append_row(str(args.get("sheet") or ""), vals)
            if name == "excel_find":
                return await self._require_excel().find(
                    str(args.get("sheet") or ""),
                    str(args.get("query") or ""),
                    int(args.get("limit") or 20),
                    str(args.get("column") or ""),
                )
            if name == "excel_export":
                path = str(args.get("path") or "") or _default_export_path(self._require_excel_path())
                return await self._require_excel().save_as(path)
            # ---------- CINSIDE LOOP 引擎（前端执行器代办） ----------
            if name in ("loop_status", "loop_make_cards", "loop_build_template", "loop_run_first", "loop_run_all"):
                from .frontend_bridge import BridgeError, call_frontend

                if not self.web and name != "loop_status":
                    return {"ok": False, "error": "LOOP 引擎需要绑定网页对象（操作发生在 BrowserPane 里）"}
                # 把 Excel 路径一并传给前端（生成卡片要用同一份数据）
                payload = dict(args or {})
                if self.excel:
                    payload.setdefault("excel_path", self.excel.source_path)
                try:
                    return await call_frontend(name, payload)
                except BridgeError as e:
                    return {"ok": False, "error": str(e)}
            # ---------- SLIDE STUDIO ----------
            if name == "slide_summary":
                return {"ok": True, **(await self._require_slide().summary())}
            if name == "slide_read":
                return {"ok": True, **(await self._require_slide().read_slide(int(args.get("slide") or 1)))}
            if name == "slide_set_text":
                return await self._require_slide().set_text(
                    int(args.get("slide") or 1), str(args.get("path") or ""), str(args.get("text") or "")
                )
            if name == "slide_add_text":
                return await self._require_slide().add_text(
                    int(args.get("slide") or 1), str(args.get("text") or ""),
                    x=str(args.get("x") or "1in"), y=str(args.get("y") or "1in"),
                    w=str(args.get("w") or "8in"), h=str(args.get("h") or "1in"),
                    font_size=str(args.get("font_size") or "24"),
                )
            if name == "slide_add_slide":
                return await self._require_slide().add_slide(
                    after=int(args.get("after") or 0),
                    title=str(args.get("title") or ""),
                    body=str(args.get("body") or ""),
                )
            if name == "slide_screenshot":
                png = await self._require_slide().screenshot(int(args.get("slide") or 1))
                return {"ok": True, "image": png, "note": "PNG 已生成，可直接用于 video_compose 的 pages[].image"}
            if name == "slide_export":
                return await self._require_slide().export(str(args.get("path") or ""))
            # ---------- 视频 ----------
            if name == "video_tts":
                from ..video_maker import tts_to_wav

                self._shot_seq += 1
                out = os.path.join(self._media_dir(), f"narration-{self._shot_seq:03d}.wav")
                return await tts_to_wav(
                    str(args.get("text") or ""), out, rate=int(args.get("rate") or 0)
                )
            if name == "video_compose":
                from ..video_maker import compose_video

                pages = args.get("pages") or []
                if not isinstance(pages, list) or not pages:
                    return {"ok": False, "error": "pages 必须是非空数组"}
                out = str(args.get("out_path") or "") or os.path.join(
                    _downloads_dir(), f"CINSIDE_VIDEO_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
                )
                return await compose_video(pages, out)
            if name == "video_from_frames":
                from ..video_maker import frames_to_video

                out = str(args.get("out_path") or "") or os.path.join(
                    _downloads_dir(), f"CINSIDE_ANIM_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
                )
                return await frames_to_video(
                    str(args.get("frames_dir") or ""), out,
                    fps=int(args.get("fps") or 10),
                    audio=str(args.get("audio") or ""),
                )
            # ---------- COWORK STUDIO ----------
            if name == "file_list":
                return await self._require_workspace().list_files()
            if name == "file_read":
                return await self._require_workspace().read(str(args.get("path") or ""))
            if name == "file_write":
                return await self._require_workspace().write(
                    str(args.get("path") or ""), str(args.get("text") or ""),
                    append=bool(args.get("append")),
                )
            if name == "file_export":
                return await self._require_workspace().export(
                    str(args.get("path") or ""), str(args.get("dest") or "")
                )
            if name == "task_done":
                self.done_summary = str(args.get("summary") or "任务完成")
                return {"ok": True}
            if name == "ask_user":
                if not self.on_ask:
                    return {"ok": False, "error": "当前不接受人工提问，请自行做合理判断"}
                q = str(args.get("question") or "")
                opts = [str(o) for o in (args.get("options") or [])][:6]
                answer = await self.on_ask(q, opts)
                return {"ok": True, "answer": answer}
            return {"ok": False, "error": f"未知工具：{name}"}
        except (CDPError, ExcelError, SlideError, WorkspaceError) as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:  # 工具内部的意外错误也不能炸掉整个循环
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    # ---------- 内部 ----------

    def _require_web(self) -> WebTarget:
        if not self.web:
            raise CDPError("本次任务没有绑定网页对象")
        return self.web

    def _require_excel(self) -> ExcelTarget:
        if not self.excel:
            raise ExcelError("本次任务没有绑定 Excel 对象")
        return self.excel

    def _require_slide(self) -> SlideTarget:
        if not self.slide:
            raise SlideError("本次任务没有绑定 PPT 对象")
        return self.slide

    def _require_workspace(self) -> WorkspaceTarget:
        if not self.workspace:
            raise WorkspaceError("本次任务没有协作工作区")
        return self.workspace

    def _media_dir(self) -> str:
        """视频中间产物（配音 / 帧）目录：跟着 PPT 工作副本或工作区走。"""
        if self.slide:
            d = self.slide.work_dir
        elif self.workspace:
            d = str(self.workspace.root / "_media")
        else:
            d = os.path.join(os.path.expanduser("~"), "Downloads", "cinside-media")
        os.makedirs(d, exist_ok=True)
        return d

    def _require_excel_path(self) -> str:
        return self._require_excel().source_path

    async def _web_observe(self, args: dict) -> dict:
        snap = await self._require_web().observe(
            int(args.get("max_elements") or 120), int(args.get("max_text") or 5000)
        )
        return {"ok": True, **snap}

    async def _web_action(self, res: dict, *, settle_ms: int = 420, light: bool = False) -> dict:
        """动作 + 自动复查：页面变了什么、有没有报错提示。"""
        if not res.get("ok"):
            return res
        if not _POST_ACTION:
            return res
        import asyncio

        await asyncio.sleep(settle_ms / 1000.0)
        state: dict | None = None
        last_err = ""
        # 跳转/重绘期间首次观察可能失败，稍等再试一次（不要把一次瞬时失败当成动作失败）
        for attempt in range(2):
            try:
                state = await self._require_web().post_action_state(
                    max_elements=20 if light else 40, max_text=600 if light else 1500
                )
                break
            except CDPError as e:
                last_err = str(e)
                if attempt == 0:
                    await asyncio.sleep(0.6)
        if state is None:
            return {**res, "post_state_error": last_err}
        merged = {**res, "page_after": state}
        if state.get("alerts"):
            merged["important"] = "页面出现提示信息，见 page_after.alerts"
        return merged


def _default_export_path(source_path: str) -> str:
    home = os.path.expanduser("~")
    dl = os.path.join(home, "Downloads")
    base = dl if os.path.isdir(dl) else os.path.dirname(os.path.abspath(source_path)) or home
    stem = os.path.splitext(os.path.basename(source_path or "harness"))[0] or "harness"
    return os.path.join(base, f"{stem}_HARNESS_{time.strftime('%H%M%S')}.xlsx")


def _downloads_dir() -> str:
    dl = os.path.join(os.path.expanduser("~"), "Downloads")
    return dl if os.path.isdir(dl) else os.path.expanduser("~")


def _truncate(value: Any, limit: int) -> Any:
    if isinstance(value, (dict, list)):
        try:
            s = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            s = str(value)
        return s if len(s) <= limit else s[:limit] + "…[已截断]"
    s = str(value)
    return s if len(s) <= limit else s[:limit] + "…[已截断]"
