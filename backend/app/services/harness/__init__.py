"""HARNESS：双对象（网页 + Excel）Computer Use 智能体。

分层：
    cdp.py        CDP 通道（执行 JS / 截图 / 可信鼠标键盘）
    web.py        网页对象原语（observe / click / type / select / scroll / extract）
    excel_book.py Excel 对象（工作副本读写，绝不改源文件）
    tools.py      工具注册表（function calling schema + 分发）
    runner.py     智能体循环（决策 → 执行 → 观察 → 再决策）、SSE 事件
"""
from .cdp import CDPError, CDPPage, CDPTarget, list_targets, resolve_page_target
from .excel_book import ExcelError, ExcelTarget
from .runner import ACTIVE, ExcelBinding, HarnessSession, WebBinding, get_session, new_session, recent_sessions, run
from .tools import HarnessTools
from .web import WebTarget

__all__ = [
    "CDPError",
    "CDPPage",
    "CDPTarget",
    "list_targets",
    "resolve_page_target",
    "ExcelError",
    "ExcelTarget",
    "WebTarget",
    "HarnessTools",
    "HarnessSession",
    "WebBinding",
    "ExcelBinding",
    "ACTIVE",
    "new_session",
    "get_session",
    "recent_sessions",
    "run",
]
