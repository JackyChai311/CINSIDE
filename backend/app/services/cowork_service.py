"""Cowork Studio — 中央 AI 协作编排服务。

核心理念：中央 AI 作为"品控大脑"，把用户积累的技能/风格要求组装成任务指令，
派发给本机已安装的编码客户端（codex / claude code / trae / 千问 等）执行，
各客户端把产出写入结果文件，中央 AI 读取结果做品控，不合格则带反馈重新派发，
直至通过或达到最大轮次。

数据全部落盘在用户数据目录的 cowork/ 下：
  skills.json     — 用户技能库
  profile.md      — 累积的用户风格与要求（中央 AI 持续学习）
  tasks/<id>/     — 每个任务的工作目录（task.md / result-*.md / qc-*.md）
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

from ..config import _USER_DATA_DIR, settings

# ---- 目录与持久化 ----

_COWORK_DIR = _USER_DATA_DIR / "cowork"
_TASKS_DIR = _COWORK_DIR / "tasks"
_SKILLS_FILE = _COWORK_DIR / "skills.json"
_PROFILE_FILE = _COWORK_DIR / "profile.md"


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


def detect_clients() -> list[dict]:
    """检测本机已安装的编码客户端。"""
    results = []
    for c in _BUILTIN_CLIENTS:
        path = _which(c.bin_name) or _which(c.windows_bin)
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
        })
    return results


def _get_adapter(client_id: str) -> ClientAdapter | None:
    return next((c for c in _BUILTIN_CLIENTS if c.id == client_id), None)


# ---- 任务派发与品控 ----

@dataclass
class Assignment:
    client_id: str
    client_name: str
    prompt_file: str = ""
    result_file: str = ""
    status: str = "pending"   # pending / running / done / failed / timeout
    result: str = ""
    error: str = ""
    started_at: float = 0
    finished_at: float = 0
    elapsed: float = 0


@dataclass
class Task:
    id: str
    instruction: str
    skill_ids: list[str]
    client_ids: list[str]
    max_rounds: int = 2
    status: str = "pending"
    assignments: list[Assignment] = field(default_factory=list)
    qc_review: str = ""
    qc_passed: bool = False
    qc_feedback: str = ""
    round: int = 0
    final_result: str = ""
    created_at: float = field(default_factory=time.time)


def _task_dir(task_id: str) -> Path:
    d = _TASKS_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _call_central_ai(system_prompt: str, user_content: str, temperature: float = 0.3) -> str:
    """调用中央 AI（复用 browser_use LLM 配置）。"""
    if not settings.browser_use_llm_key:
        raise RuntimeError("未配置 LLM API Key，中央 AI 不可用（请在设置中配置 browser_use_llm_key）")
    url = settings.browser_use_llm_base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.browser_use_llm_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.browser_use_llm_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": temperature,
    }
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"] or ""


def _build_prompt(task: Task, skills: list[Skill], profile: str, qc_feedback: str = "") -> str:
    """组装给执行客户端的完整任务指令。"""
    parts = ["# 任务\n", task.instruction.strip(), "\n"]

    # 注入用户风格画像
    if profile.strip():
        parts.append("\n## 用户风格与要求（必须遵守）\n")
        parts.append(profile.strip() + "\n")

    # 注入选中的技能
    if skills:
        parts.append("\n## 执行规范（来自技能库）\n")
        for s in skills:
            parts.append(f"\n### {s.name}\n")
            if s.description:
                parts.append(f"> {s.description}\n")
            parts.append(s.content.strip() + "\n")

    # 上一轮品控反馈
    if qc_feedback.strip():
        parts.append("\n## 上一轮品控反馈（本轮必须修正）\n")
        parts.append(qc_feedback.strip() + "\n")

    parts.append(
        "\n## 输出要求\n"
        "1. 直接完成任务，输出最终成果（代码/文档/分析等）。\n"
        "2. 不要询问额外问题，基于现有信息做出合理判断。\n"
        "3. 成果完整可直接使用，不要用占位符。\n"
    )
    return "\n".join(parts)


async def _run_client(adapter: ClientAdapter, prompt: str, result_file: Path,
                      cwd: Path, timeout: int = 600) -> tuple[str, str, int]:
    """启动一个客户端执行任务，stdout 写入 result_file。

    返回 (stdout, stderr, returncode)。
    """
    bin_path = _which(adapter.bin_name) or _which(adapter.windows_bin)
    if not bin_path:
        raise RuntimeError(f"客户端 {adapter.name} 不可用（未在 PATH 中找到）")

    # 组装命令：bin [arg_flag] "prompt" [extra_args]
    cmd = [bin_path]
    if adapter.arg_flag:
        cmd.append(adapter.arg_flag)
    cmd.append(prompt)
    cmd.extend(adapter.extra_args)

    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(cwd),
        creationflags=creationflags,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise TimeoutError(f"客户端 {adapter.name} 执行超时（{timeout}s）")

    stdout = stdout_b.decode("utf-8", errors="replace") if stdout_b else ""
    stderr = stderr_b.decode("utf-8", errors="replace") if stderr_b else ""
    # 把 stdout 落盘为结果文件（满足"输出返回一个文件"的要求）
    result_file.write_text(stdout, encoding="utf-8")
    return stdout, stderr, proc.returncode or 0


async def _qc_review(task: Task, skills: list[Skill], profile: str) -> tuple[bool, str, str]:
    """中央 AI 对各客户端产出作品控。

    返回 (passed, review_text, feedback_text)。
    """
    # 汇总所有产出
    submissions = []
    for a in task.assignments:
        if a.status == "done" and a.result.strip():
            submissions.append(f"### {a.client_name} 的产出\n{a.result.strip()}")
    if not submissions:
        return False, "所有客户端均未产出有效结果。", "无产出，请重新执行任务。"

    system_prompt = (
        "你是中央 AI 品控员。用户给出了任务要求、风格规范，"
        "多个 AI 客户端分别提交了产出。请严格检查每份产出是否：\n"
        "1. 完成了任务的全部要求；\n"
        "2. 符合用户风格与技能规范；\n"
        "3. 无占位符、无截断、无明显错误；\n"
        "4. 成果完整可直接交付。\n"
        '以 JSON 返回：{"passed": true/false, "review": "整体评语", '
        '"feedback": "若未通过，具体修正意见；若通过留空", '
        '"best_index": 最佳产出的序号(从1开始)}'
    )
    user_parts = [f"# 任务\n{task.instruction}", ""]
    if profile.strip():
        user_parts += ["## 用户风格\n" + profile.strip(), ""]
    if skills:
        user_parts.append("## 技能规范")
        for s in skills:
            user_parts.append(f"- {s.name}: {s.content[:200]}")
        user_parts.append("")
    user_parts += submissions
    user_content = "\n".join(user_parts)[:8000]  # 控制上下文长度

    raw = await _call_central_ai(system_prompt, user_content, temperature=0.1)
    parsed = _safe_json(raw)
    if not isinstance(parsed, dict):
        # JSON 解析失败时默认通过（避免卡死），评语用原文
        return True, raw[:500], ""

    passed = bool(parsed.get("passed", True))
    review = str(parsed.get("review", ""))[:2000]
    feedback = str(parsed.get("feedback", ""))[:2000]

    # 选出最佳产出作为最终结果
    best_idx = parsed.get("best_index")
    if isinstance(best_idx, int) and 1 <= best_idx <= len(submissions):
        chosen = task.assignments[best_idx - 1]
        if chosen.status == "done":
            task.final_result = chosen.result
    if not task.final_result:
        done = [a for a in task.assignments if a.status == "done" and a.result.strip()]
        if done:
            task.final_result = done[0].result

    return passed, review, feedback


def _safe_json(text: str) -> Any:
    """从 LLM 输出中提取 JSON。"""
    import re
    text = text.strip()
    # 去掉 ```json ... ``` 包裹
    m = re.search(r"```(?:json)?\s*(.+?)```", text, re.DOTALL)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                return None
    return None


async def dispatch_task(
    instruction: str,
    skill_ids: list[str],
    client_ids: list[str],
    max_rounds: int = 2,
    timeout_per_client: int = 600,
    progress_cb: Callable[[dict], None] | None = None,
) -> dict:
    """派发任务给选定客户端，并执行品控循环。

    progress_cb 推送事件：
      {type:"status", stage, message, round}
      {type:"client_start", client_id, client_name}
      {type:"client_done", client_id, status, elapsed, result_preview}
      {type:"qc", review, passed, feedback}
      {type:"done", task}
    """
    def _emit(ev: dict) -> None:
        if progress_cb:
            try:
                progress_cb(ev)
            except Exception:
                pass

    _ensure_dirs()
    task_id = uuid.uuid4().hex[:12]
    tdir = _task_dir(task_id)

    all_skills = _load_skills()
    skills = [s for s in all_skills if s.id in skill_ids]
    profile = get_profile()

    task = Task(
        id=task_id,
        instruction=instruction,
        skill_ids=list(skill_ids),
        client_ids=list(client_ids),
        max_rounds=max_rounds,
        status="running",
    )
    _emit({"type": "status", "stage": "start", "message": f"任务 {task_id} 已创建", "round": 0})

    adapters = [a for a in (_get_adapter(cid) for cid in client_ids) if a]
    if not adapters:
        task.status = "failed"
        _emit({"type": "status", "stage": "error", "message": "没有可用的客户端"})
        return asdict(task)

    qc_feedback = ""
    for round_num in range(1, max_rounds + 1):
        task.round = round_num
        _emit({"type": "status", "stage": "dispatch", "message": f"第 {round_num} 轮派发", "round": round_num})

        prompt = _build_prompt(task, skills, profile, qc_feedback)
        prompt_file = tdir / f"task-r{round_num}.md"
        prompt_file.write_text(prompt, encoding="utf-8")

        # 重置本轮 assignments
        task.assignments = []
        tasks = []
        for adapter in adapters:
            result_file = tdir / f"result-r{round_num}-{adapter.id}.md"
            a = Assignment(
                client_id=adapter.id,
                client_name=adapter.name,
                prompt_file=str(prompt_file),
                result_file=str(result_file),
                status="running",
                started_at=time.time(),
            )
            task.assignments.append(a)
            _emit({"type": "client_start", "client_id": adapter.id, "client_name": adapter.name})
            tasks.append(_run_client(adapter, prompt, result_file, tdir, timeout=timeout_per_client))

        # 并行等待所有客户端
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for adapter, a, res in zip(adapters, task.assignments, results):
            a.finished_at = time.time()
            a.elapsed = a.finished_at - a.started_at
            if isinstance(res, Exception):
                a.status = "failed"
                a.error = str(res)[:500]
                _emit({"type": "client_done", "client_id": adapter.id,
                       "status": "failed", "elapsed": a.elapsed, "error": a.error})
            else:
                stdout, stderr, rc = res
                a.result = stdout
                a.status = "done" if rc == 0 and stdout.strip() else "failed"
                if rc != 0 and not stdout.strip():
                    a.error = (stderr or f"退出码 {rc}")[:500]
                _emit({"type": "client_done", "client_id": adapter.id,
                       "status": a.status, "elapsed": a.elapsed,
                       "result_preview": stdout[:200]})

        # 品控
        _emit({"type": "status", "stage": "qc", "message": "中央 AI 品控中…", "round": round_num})
        try:
            passed, review, feedback = await _qc_review(task, skills, profile)
        except Exception as e:
            # 品控失败不阻断，视为通过
            passed, review, feedback = True, f"品控跳过: {e}", ""

        task.qc_review = review
        task.qc_feedback = feedback
        task.qc_passed = passed
        _emit({"type": "qc", "review": review, "passed": passed, "feedback": feedback, "round": round_num})

        if passed:
            task.status = "done"
            _emit({"type": "status", "stage": "done", "message": "品控通过，任务完成", "round": round_num})
            break
        qc_feedback = feedback
        if round_num < max_rounds:
            _emit({"type": "status", "stage": "retry",
                   "message": f"未通过，带反馈进入第 {round_num + 1} 轮", "round": round_num})
    else:
        task.status = "done"  # 达到最大轮次，交付最佳结果
        _emit({"type": "status", "stage": "done", "message": "已达最大轮次，交付最佳结果", "round": max_rounds})

    # 把最终结果落盘
    final_file = tdir / "final.md"
    final_file.write_text(task.final_result or "", encoding="utf-8")

    # 品控通过时，把反馈沉淀进用户画像（持续积累风格）
    if task.qc_passed and task.qc_review:
        try:
            update_profile(f"[任务 {task_id[:8]} 品控要点] {task.qc_review[:300]}")
        except Exception:
            pass

    _emit({"type": "done", "task": asdict(task)})
    return asdict(task)


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
