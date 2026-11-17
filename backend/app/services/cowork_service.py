"""Cowork Studio — 技能库 / 风格画像 / 客户端检测 / 人工协作看板。

AI 协作任务已统一由 HARNESS 底座执行（routers/cowork.py 的 /dispatch
直接入 HARNESS 队列，studio=cowork）：本模块不再自己造 Agent——
原「派发给外部 CLI 客户端 + 中央 AI 品控循环」已整体移除。
这里保留的是 HARNESS 执行时要注入的素材与协作周边能力：

数据全部落盘在用户数据目录的 cowork/ 下：
  skills.json     — 用户技能库（注入 HARNESS 执行上下文）
  profile.md      — 累积的用户风格与要求（注入 HARNESS 执行上下文）
  clients.json    — 用户手动设置的客户端可执行文件位置（仅环境检测参考）
  tasks/<id>/     — 统一底座之前的历史任务目录（只读回看，final.md 为当时交付成果）
  human_tasks.json — 人工协作看板任务
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..config import _USER_DATA_DIR

# ---- 目录与持久化 ----

_COWORK_DIR = _USER_DATA_DIR / "cowork"
_TASKS_DIR = _COWORK_DIR / "tasks"
_SKILLS_FILE = _COWORK_DIR / "skills.json"
_PROFILE_FILE = _COWORK_DIR / "profile.md"
_CLIENT_PATHS_FILE = _COWORK_DIR / "clients.json"


def _ensure_dirs() -> None:
    _TASKS_DIR.mkdir(parents=True, exist_ok=True)


# ---- 数据模型 ----

@dataclass
class Skill:
    id: str
    name: str
    description: str = ""
    content: str = ""            # 技能正文：风格要求、工作流程、检查清单等
    category: str = "general"    # general / style / workflow / review
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


@dataclass
class ClientAdapter:
    id: str           # codex / cc / trae / qianwen
    name: str         # 展示名
    bin_name: str     # 可执行文件名（在 PATH 中查找）
    windows_bin: str = ""  # Windows 上的候选 exe 名
    # 命令模板：{bin} {task_file} {result_file} 会被替换
    # 大多数 CLI 支持 -p/--print 非交互模式，把 prompt 作为参数传入并捕获 stdout
    invoke_mode: str = "arg"    # arg=prompt 作为参数 / file=从文件读取
    arg_flag: str = "-p"        # prompt 参数的 flag
    extra_args: list[str] = field(default_factory=list)
    detect_args: list[str] = field(default_factory=lambda: ["--version"])
    hint: str = ""              # 未检测到时的安装提示


# 内置客户端适配器注册表
_BUILTIN_CLIENTS: list[ClientAdapter] = [
    ClientAdapter(
        id="codex",
        name="Codex",
        bin_name="codex",
        windows_bin="codex.exe",
        arg_flag="exec",
        invoke_mode="arg",
        extra_args=["--skip-git-repo-check"],
        hint="npm i -g @openai/codex",
    ),
    ClientAdapter(
        id="cc",
        name="Claude Code",
        bin_name="claude",
        windows_bin="claude.exe",
        arg_flag="-p",
        invoke_mode="arg",
        extra_args=["--output-format", "text"],
        hint="npm i -g @anthropic-ai/claude-code",
    ),
    ClientAdapter(
        id="trae",
        name="Trae",
        bin_name="trae",
        windows_bin="trae.exe",
        arg_flag="-p",
        invoke_mode="arg",
        extra_args=[],
        hint="安装 Trae 后将其 CLI 加入 PATH",
    ),
    ClientAdapter(
        id="qianwen",
        name="通义千问",
        bin_name="qwen",
        windows_bin="qwen.exe",
        arg_flag="-p",
        invoke_mode="arg",
        extra_args=[],
        hint="安装通义灵码 CLI 后加入 PATH",
    ),
]


# ---- 技能库 CRUD ----

def _load_skills() -> list[Skill]:
    _ensure_dirs()
    if not _SKILLS_FILE.exists():
        return []
    try:
        data = json.loads(_SKILLS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return []
        return [Skill(**{k: v for k, v in item.items() if k in Skill.__dataclass_fields__}) for item in data]
    except Exception:
        return []


def _save_skills(skills: list[Skill]) -> None:
    _ensure_dirs()
    _SKILLS_FILE.write_text(
        json.dumps([asdict(s) for s in skills], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_skills() -> list[dict]:
    return [asdict(s) for s in _load_skills()]


def save_skill(skill: dict) -> dict:
    skills = _load_skills()
    sid = skill.get("id") or uuid.uuid4().hex[:12]
    existing = next((s for s in skills if s.id == sid), None)
    now = time.time()
    if existing:
        existing.name = skill.get("name", existing.name)
        existing.description = skill.get("description", existing.description)
        existing.content = skill.get("content", existing.content)
        existing.category = skill.get("category", existing.category)
        existing.updated_at = now
        saved = existing
    else:
        saved = Skill(
            id=sid,
            name=skill.get("name", "未命名技能"),
            description=skill.get("description", ""),
            content=skill.get("content", ""),
            category=skill.get("category", "general"),
        )
        skills.insert(0, saved)
    _save_skills(skills)
    return asdict(saved)


def delete_skill(skill_id: str) -> bool:
    skills = _load_skills()
    before = len(skills)
    skills = [s for s in skills if s.id != skill_id]
    if len(skills) < before:
        _save_skills(skills)
        return True
    return False


# ---- 用户风格画像（中央 AI 持续积累）----

def get_profile() -> str:
    _ensure_dirs()
    if _PROFILE_FILE.exists():
        return _PROFILE_FILE.read_text(encoding="utf-8")
    return ""


def update_profile(append_text: str) -> str:
    _ensure_dirs()
    current = get_profile()
    new = (current + "\n\n" + append_text.strip()).strip() if current else append_text.strip()
    _PROFILE_FILE.write_text(new, encoding="utf-8")
    return new


def set_profile(text: str) -> str:
    _ensure_dirs()
    _PROFILE_FILE.write_text(text or "", encoding="utf-8")
    return text or ""


# ---- 客户端位置（用户手动设置，优先于 PATH 自动检测）----

def _load_client_paths() -> dict[str, str]:
    _ensure_dirs()
    if not _CLIENT_PATHS_FILE.exists():
        return {}
    try:
        data = json.loads(_CLIENT_PATHS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {k: str(v) for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}
    except Exception:
        pass
    return {}


def _save_client_paths(paths: dict[str, str]) -> None:
    _ensure_dirs()
    _CLIENT_PATHS_FILE.write_text(
        json.dumps(paths, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def save_client_path(client_id: str, path: str) -> bool:
    """保存/清除某个客户端的可执行文件位置。path 为空表示清除，恢复自动检测。"""
    if not any(c.id == client_id for c in _BUILTIN_CLIENTS):
        return False
    paths = _load_client_paths()
    if path.strip():
        paths[client_id] = path.strip()
    else:
        paths.pop(client_id, None)
    _save_client_paths(paths)
    return True


def _path_usable(path: str) -> bool:
    """自定义路径是否可用：绝对/相对文件存在，或在 PATH 中可解析。"""
    if not path:
        return False
    return Path(path).exists() or shutil.which(path) is not None


# ---- 客户端检测 ----

def _which(bin_name: str) -> str | None:
    """在 PATH 中查找可执行文件，Windows 上自动补 .exe/.cmd/.bat。"""
    found = shutil.which(bin_name)
    if found:
        return found
    if sys.platform == "win32":
        for ext in (".exe", ".cmd", ".bat"):
            found = shutil.which(bin_name + ext)
            if found:
                return found
    return None


def _resolve_bin(adapter: ClientAdapter) -> tuple[str | None, str]:
    """解析客户端实际启动位置。返回 (路径, 来源 custom/path/none)。

    用户手动设置的位置最优先；设置但无效时视为不可用（不再回退 PATH，避免悄悄用了另一个版本）。
    """
    custom = _load_client_paths().get(adapter.id, "")
    if custom:
        return (custom, "custom") if _path_usable(custom) else (None, "custom")
    found = _which(adapter.bin_name) or _which(adapter.windows_bin)
    return found, ("path" if found else "none")


def detect_clients() -> list[dict]:
    """检测本机已安装的编码客户端（自定义位置优先，其次 PATH）。"""
    results = []
    for c in _BUILTIN_CLIENTS:
        path, source = _resolve_bin(c)
        custom_path = _load_client_paths().get(c.id, "")
        version = ""
        if path:
            try:
                creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                r = subprocess.run(
                    [path] + c.detect_args,
                    capture_output=True, text=True, timeout=15,
                    creationflags=creationflags,
                )
                version = (r.stdout or r.stderr or "").strip().splitlines()[0][:80] if (r.stdout or r.stderr) else ""
            except Exception:
                version = ""
        results.append({
            "id": c.id,
            "name": c.name,
            "available": path is not None,
            "path": path or "",
            "version": version,
            "hint": c.hint,
            "custom_path": custom_path,
            "source": source,
        })
    return results


def _get_adapter(client_id: str) -> ClientAdapter | None:
    return next((c for c in _BUILTIN_CLIENTS if c.id == client_id), None)


# ---- 历史任务回看 ----
# 任务派发与品控循环已移除：AI 协作统一由 HARNESS 底座执行
# （routers/cowork.py 的 /dispatch 直接入 HARNESS 队列，studio=cowork，
#  技能库 + 风格画像注入执行上下文）。这里只保留旧任务目录的读取，
#  供前端回看统一底座之前产生的历史成果。


def get_task(task_id: str) -> dict | None:
    """读取任务目录信息（用于前端回看历史任务）。"""
    tdir = _TASKS_DIR / task_id
    if not tdir.exists():
        return None
    final_file = tdir / "final.md"
    files = sorted(p.name for p in tdir.iterdir() if p.is_file())
    return {
        "id": task_id,
        "dir": str(tdir),
        "files": files,
        "final": final_file.read_text(encoding="utf-8") if final_file.exists() else "",
    }


def list_recent_tasks(limit: int = 20) -> list[dict]:
    _ensure_dirs()
    tasks = []
    if not _TASKS_DIR.exists():
        return tasks
    for d in sorted(_TASKS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        if not d.is_dir():
            continue
        final_file = d / "final.md"
        tasks.append({
            "id": d.name,
            "mtime": d.stat().st_mtime,
            "has_final": final_file.exists(),
            "final_preview": (final_file.read_text(encoding="utf-8")[:120] if final_file.exists() else ""),
        })
    return tasks


# ---- 人工协作：任务看板 + 指定本地文件提取 ----
# 参考 Hannsonus 的模式：任务发起者指定本机文件路径，执行者按提取要求读取该文件并回填结果。

_HUMAN_TASKS_FILE = _COWORK_DIR / "human_tasks.json"

# 支持提取的文件扩展名（与 document_extract 能力对齐）
_HUMAN_EXTRACT_EXTS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tiff", ".heic", ".heif",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".csv", ".rtf",
}


@dataclass
class HumanTask:
    id: str
    title: str
    assignee: str = "未分配"
    status: str = "todo"          # todo / doing / done
    note: str = ""
    # 指定本地文件提取（搬运自 Hannsonus 的 filePath 模式）
    file_path: str = ""           # 发起者指定的本机文件绝对路径
    extract_note: str = ""        # 提取要求：要拿什么（逗号/顿号分隔的字段，或自由描述）
    extract_text: str = ""        # 提取出的全文
    extract_fields: dict = field(default_factory=dict)   # 结构化字段结果
    extract_method: str = ""
    extracted_at: float = 0
    created_at: float = field(default_factory=time.time)


def _load_human_tasks() -> list[HumanTask]:
    _ensure_dirs()
    if not _HUMAN_TASKS_FILE.exists():
        return []
    try:
        data = json.loads(_HUMAN_TASKS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return []
        return [HumanTask(**{k: v for k, v in item.items() if k in HumanTask.__dataclass_fields__})
                for item in data if isinstance(item, dict)]
    except Exception:
        return []


def _save_human_tasks(tasks: list[HumanTask]) -> None:
    _ensure_dirs()
    _HUMAN_TASKS_FILE.write_text(
        json.dumps([asdict(t) for t in tasks], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_human_tasks() -> list[dict]:
    return [asdict(t) for t in _load_human_tasks()]


def save_human_task(task: dict) -> dict:
    tasks = _load_human_tasks()
    tid = task.get("id") or uuid.uuid4().hex[:12]
    existing = next((t for t in tasks if t.id == tid), None)
    if existing:
        for k in ("title", "assignee", "status", "note", "file_path", "extract_note"):
            if k in task:
                setattr(existing, k, str(task.get(k, getattr(existing, k))))
        saved = existing
    else:
        saved = HumanTask(
            id=tid,
            title=task.get("title", "未命名任务"),
            assignee=task.get("assignee", "未分配") or "未分配",
            status=task.get("status", "todo"),
            note=task.get("note", ""),
            file_path=task.get("file_path", ""),
            extract_note=task.get("extract_note", ""),
        )
        tasks.insert(0, saved)
    _save_human_tasks(tasks)
    return asdict(saved)


def delete_human_task(task_id: str) -> bool:
    tasks = _load_human_tasks()
    before = len(tasks)
    tasks = [t for t in tasks if t.id != task_id]
    if len(tasks) < before:
        _save_human_tasks(tasks)
        return True
    return False


def get_human_task(task_id: str) -> HumanTask | None:
    return next((t for t in _load_human_tasks() if t.id == task_id), None)


def set_human_task_extract(task_id: str, text: str, fields: dict, method: str) -> HumanTask | None:
    tasks = _load_human_tasks()
    t = next((x for x in tasks if x.id == task_id), None)
    if not t:
        return None
    t.extract_text = text or ""
    t.extract_fields = fields or {}
    t.extract_method = method or ""
    t.extracted_at = time.time()
    _save_human_tasks(tasks)
    return t


def parse_extract_note(note: str) -> list[str]:
    """把提取要求拆成字段列表：按换行/逗号/顿号/分号分隔，过滤空项。"""
    if not note:
        return []
    import re
    return [s.strip() for s in re.split(r"[，,、;；\n]+", note) if s.strip()][:20]


def check_human_extract_file(file_path: str) -> tuple[Path, str]:
    """校验指定的本地文件可提取。返回 (Path, 错误消息)。"""
    p = Path(file_path.strip().strip('"'))
    if not file_path.strip():
        return p, "未指定文件路径"
    if not p.is_file():
        return p, f"文件不存在：{p}"
    if p.suffix.lower() not in _HUMAN_EXTRACT_EXTS:
        return p, f"不支持的文件类型：{p.suffix or '（无扩展名）'}"
    size = p.stat().st_size
    if size > 30 * 1024 * 1024:
        return p, f"文件过大（{size / 1024 / 1024:.0f}MB > 30MB）"
    if size == 0:
        return p, "文件为空"
    return p, ""
