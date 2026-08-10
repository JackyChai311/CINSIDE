"""PPT Section 拆并核心服务。

移植自 Hansonus 项目的 pptsections-svc.ts，适配 CINSIDE 的 Python 后端。

核心流程：
1. analyze_files — 解析每个 PPT 的幻灯片及文本节点
2. detect_sections — AI 识别 section 章节
3. build_reading_script — 生成 Markdown 阅读稿
4. build_merged_ppt — 合并各 section 为一个总览 PPT
5. modify_content — AI 统一修改内容，输出补丁
6. apply_patches — 一键回填到原始 PPT
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

import httpx

from ..config import settings
from . import officecli

# MarkItDown 快速文本提取（可选依赖）
try:
    from markitdown import MarkItDown
    _MD = MarkItDown()
    _HAS_MARKITDOWN = True
except Exception:
    _MD = None
    _HAS_MARKITDOWN = False

# ---- 类型定义（dataclass 风格的 dict） ----
# TextNode = {"path": str, "text": str}
# SlideNode = {"index": int, "path": str, "title": str, "texts": list[TextNode]}
# FileSlides = {"file_id": str, "file_name": str, "file_path": str, "slides": list[SlideNode]}
# SectionPart = {"file_id": str, "file_name": str, "file_path": str,
#                "slide_start": int, "slide_end": int, "slides": list[SlideNode]}
# Section = {"name": str, "parts": list[SectionPart]}
# TextPatch = {"file_id": str, "file_name": str, "file_path": str,
#              "slide": int, "path": str, "text": str, "new_text": str}


# ---- 临时目录 ----

def _get_work_dir() -> Path:
    """获取 PPT 工作目录（存放合并文件、截图等）。"""
    work = Path(tempfile.gettempdir()) / "cinside-ppt"
    work.mkdir(parents=True, exist_ok=True)
    return work


def _make_file_id(file_path: str) -> str:
    """从文件路径生成简短的 file_id。"""
    return str(abs(hash(file_path)))


# ---- 递归收集文本节点 ----

def _collect_text_nodes(node: Any, out: list[dict] | None = None) -> list[dict]:
    """递归遍历 JSON 节点树，收集 paragraph/table-cell 文本节点。"""
    if out is None:
        out = []
    if not node or not isinstance(node, dict):
        return out

    node_type = node.get("type", "")
    is_text_leaf = node_type in ("paragraph", "table-cell")
    if is_text_leaf:
        text = node.get("text", "")
        if isinstance(text, str) and text.strip():
            out.append({"path": node.get("path", ""), "text": text})

    children = node.get("children", [])
    if isinstance(children, list):
        for child in children:
            _collect_text_nodes(child, out)
    return out


# ---- 步骤 1：解析每个 PPT 的幻灯片及文本 ----

# Progress callback: (current_index, total, file_name, status, extra_dict)
ProgressCb = Callable[[int, int, str, str, dict], None]


def analyze_files(
    file_paths: list[str],
    progress_cb: ProgressCb | None = None,
) -> list[dict]:
    """解析多个 PPT 文件，返回每个文件的幻灯片及文本节点列表。

    优化流程：
    1. 优先用 MarkItDown 一次转换整份 PPT 为 markdown，从中同时提取
       幻灯片数量、标题和正文（无需额外调用 OfficeCLI view_outline）。
    2. MarkItDown 失败或未给出分页标记时，回退到 OfficeCLI view_outline。
    3. 个别页 MarkItDown 未覆盖到的，再用 OfficeCLI get_node 逐页补取。
    """
    def _report(idx: int, total: int, name: str, status: str, **extra: Any) -> None:
        if progress_cb:
            try:
                progress_cb(idx, total, name, status, extra)
            except Exception:
                pass

    result: list[dict] = []
    total = len(file_paths)
    print(f"[PPT-ANALYZE] 开始解析 {total} 个 PPT 文件 (markitdown={_HAS_MARKITDOWN})", flush=True)

    for i, fp in enumerate(file_paths):
        file_path = str(Path(fp).resolve())
        file_name = Path(file_path).name

        if not os.path.exists(file_path):
            _report(i + 1, total, file_name, "error", message="文件不存在")
            raise FileNotFoundError(f"文件不存在: {file_path}")

        file_id = _make_file_id(file_path)
        _report(i, total, file_name, "parsing")
        print(f"[PPT-ANALYZE] [{i+1}/{total}] {file_name}", flush=True)

        # 1) MarkItDown 快速提取全文 markdown
        md_text = ""
        if _HAS_MARKITDOWN:
            try:
                _report(i, total, file_name, "markitdown")
                md_result = _MD.convert(file_path)
                md_text = md_result.text_content or ""
                print(f"[PPT-ANALYZE]   MarkItDown: {len(md_text)} chars", flush=True)
            except Exception as e:
                print(f"[PPT-ANALYZE]   MarkItDown 失败，将用 OfficeCLI: {e}", flush=True)
                md_text = ""

        # 2) 从 markdown 中解析幻灯片大纲（数量 + 标题）和文本
        slides_meta: list[dict] = []
        slide_texts_map: dict[int, list[str]] = {}

        if md_text:
            slides_meta, slide_texts_map = _parse_markdown_slides(md_text)

        # 3) MarkItDown 未能提供幻灯片结构时，回退 OfficeCLI view_outline
        if not slides_meta:
            _report(i, total, file_name, "outline")
            outline = officecli.view_outline(file_path)
            slides_meta = _parse_outline_slides(outline, file_path)
            print(f"[PPT-ANALYZE]   OfficeCLI outline: {len(slides_meta)} slides", flush=True)
            # markdown 有文本但没分页标记时，把全部文本归到第 1 页
            if md_text and not slide_texts_map:
                lines = [ln.strip() for ln in md_text.splitlines() if ln.strip()]
                if lines:
                    slide_texts_map[1] = lines

        _report(i, total, file_name, "outline", slides=len(slides_meta))

        # 4) 组装 slides；MarkItDown 未覆盖到的页用 OfficeCLI 逐页补取
        slides: list[dict] = []
        for s in slides_meta:
            idx = s["index"]
            texts: list[dict] = []

            # 优先用 MarkItDown 的文本
            if idx in slide_texts_map and slide_texts_map[idx]:
                for line in slide_texts_map[idx]:
                    if line.strip():
                        texts.append({"path": f"/slide[{idx}]/md", "text": line.strip()})
            else:
                # 回退：OfficeCLI 逐页 get_node
                try:
                    node_json = officecli.get_node(file_path, f"/slide[{idx}]")
                    slide_node = _extract_slide_node(node_json)
                    if slide_node:
                        texts = _collect_text_nodes(slide_node)
                except Exception as e:
                    print(f"[PPT-ANALYZE]   警告: slide[{idx}] 解析失败: {e}", flush=True)
                    texts = []

            slides.append({
                "index": idx,
                "path": f"/slide[{idx}]",
                "title": s.get("title", ""),
                "texts": texts,
            })

        total_texts = sum(len(s["texts"]) for s in slides)
        print(f"[PPT-ANALYZE]   -> {len(slides)} 张幻灯片, {total_texts} 个文本节点", flush=True)

        result.append({
            "file_id": file_id,
            "file_name": file_name,
            "file_path": file_path,
            "slides": slides,
        })
        _report(i + 1, total, file_name, "done", slides=len(slides), texts=total_texts)

    print("[PPT-ANALYZE] 全部文件解析完成", flush=True)
    return result


def _parse_markdown_slides(md_text: str) -> tuple[list[dict], dict[int, list[str]]]:
    """从 MarkItDown 输出的 markdown 中同时解析幻灯片大纲和文本。

    返回 (slides_meta, slide_texts_map)：
    - slides_meta: [{"index": int, "title": str}, ...]
    - slide_texts_map: {slide_num: [line, ...]}

    MarkItDown 的 pptx 转换器通常用 ``<!-- Slide number: N -->`` 注释分页，
    也可能用 ``## Slide N`` 之类的标题。我们兼容多种标记。
    """
    if not md_text:
        return [], {}

    # 匹配幻灯片分隔标记
    # 形式1: <!-- Slide number: N -->
    # 形式2: <!-- Slide N -->
    # 形式3: ## Slide N  / # Slide N
    slide_pattern = re.compile(
        r"(?:<!--\s*Slide\s*(?:number\s*:\s*)?(\d+)\s*-->|"
        r"^#{1,3}\s*Slide\s+(\d+))",
        re.IGNORECASE | re.MULTILINE,
    )

    matches = list(slide_pattern.finditer(md_text))
    if not matches:
        # 没有明确分页标记，无法确定幻灯片数量，返回空让调用方回退
        return [], {}

    slides_meta: list[dict] = []
    slide_texts_map: dict[int, list[str]] = {}

    for mi, match in enumerate(matches):
        slide_num = int(match.group(1) or match.group(2))
        start = match.end()
        end = matches[mi + 1].start() if mi + 1 < len(matches) else len(md_text)
        chunk = md_text[start:end]

        lines: list[str] = []
        title = ""
        for ln in chunk.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            # 跳过纯 markdown 符号行
            if re.match(r"^[-*#=]+$", ln):
                continue
            # 第一个看起来像标题的行作为幻灯片标题
            if not title:
                heading = re.match(r"^#{1,6}\s+(.+)$", ln)
                if heading:
                    title = heading.group(1).strip()
                elif len(lines) == 0 and len(ln) <= 80:
                    # 第一行且不太长，暂作为标题候选
                    title = ln
            lines.append(ln)

        # 标题也加入文本列表（保持完整内容）
        if lines:
            slide_texts_map[slide_num] = lines
        slides_meta.append({"index": slide_num, "title": title})

    return slides_meta, slide_texts_map


def _split_markdown_by_slide(md_text: str, expected_count: int) -> dict[int, list[str]]:
    """把 MarkItDown 输出的 markdown 按幻灯片切分成文本行列表（兼容保留）。"""
    _, texts = _parse_markdown_slides(md_text)
    return texts


def _parse_outline_slides(outline_json: dict, file_path: str) -> list[dict]:
    """从 outline JSON 或文本中解析幻灯片列表。

    优先从 JSON 结构提取；失败则回退到文本正则。
    """
    # 尝试从 JSON 结构提取
    if isinstance(outline_json, dict):
        # 可能的结构: {"slides": [...]} 或 {"data": {"slides": [...]}}
        slides_data = outline_json.get("slides") or outline_json.get("data", {}).get("slides")
        if isinstance(slides_data, list):
            result = []
            for s in slides_data:
                if isinstance(s, dict):
                    result.append({
                        "index": s.get("index", s.get("number", 0)),
                        "title": s.get("title", s.get("name", "")),
                    })
            if result:
                return result

    # 回退：用文本格式 + 正则解析
    try:
        result = officecli._run(["view", file_path, "outline"], timeout=30)
        text = result.stdout if result.returncode == 0 else ""
    except Exception:
        text = ""

    slides: list[dict] = []
    for m in re.finditer(r"Slide\s+(\d+):\s*(.+)", text):
        slides.append({"index": int(m.group(1)), "title": m.group(2).strip()})

    if not slides:
        # 如果大纲解析失败，尝试获取幻灯片数量
        try:
            stats = officecli._run_json(["view", file_path, "stats", "--json"], timeout=15)
            count = stats.get("slides") or stats.get("slideCount") or stats.get("data", {}).get("slides")
            if isinstance(count, int) and count > 0:
                slides = [{"index": i + 1, "title": ""} for i in range(count)]
        except Exception:
            pass

    return slides


def _extract_slide_node(node_json: dict) -> dict | None:
    """从 get --json 的输出中提取幻灯片节点。"""
    if not isinstance(node_json, dict):
        return None
    # 结构: {"data": {"results": [node]}}
    results = node_json.get("data", {}).get("results")
    if isinstance(results, list) and results:
        return results[0] if isinstance(results[0], dict) else None
    # 也可能直接是节点本身
    if node_json.get("type") == "slide":
        return node_json
    return None


# ---- 步骤 2：AI 识别 section ----

async def detect_sections(file_slides_list: list[dict], instruction: str = "") -> list[dict]:
    """调用 LLM 分析每个 PPT 的幻灯片，归类到 section。

    instruction 为用户的自然语言指令，例如"帮我把读课文部分拆出来"，
    AI 会据此调整识别重点和归类策略。
    """
    sections: list[dict] = []
    print(f"[PPT-DETECT] 开始 AI 识别 section: {len(file_slides_list)} 个文件, instruction={instruction!r}", flush=True)

    for i, fs in enumerate(file_slides_list):
        system_prompt = (
            "你是 PPT 结构分析师。用户提供一批\"同模板\"PPT，每个 PPT 内部由若干逻辑 section（章节）组成，"
            "同一 section 在不同 PPT 中的页数可能不同。\n"
            "请把该 PPT 的每一页归类到某个 section，section 名称用简洁的中文（各 PPT 相同含义的 section 应使用完全一致的名称）。\n"
            "根据幻灯片标题和内容判断归属；相邻页通常属于同一 section，尽量给出连续的范围。\n"
        )
        if instruction.strip():
            system_prompt += (
                f"\n用户特别要求：{instruction.strip()}\n"
                "请优先按照用户的要求来识别和归类章节；如果用户要求提取/拆分某些特定部分，"
                "请确保将相关幻灯片单独归为对应的 section，其余部分也应合理归类。\n"
            )
        system_prompt += (
            "严格以 JSON 返回，格式：{\"sections\":[{\"name\":\"客户背景\",\"slides\":[1,2,3]}]}，"
            "其中 slides 是该 section 的幻灯片序号数组。不要输出任何其他文字。"
        )

        user_content = f"文件名：{fs['file_name']}\n\n幻灯片列表：\n{_slide_summary(fs)}"

        try:
            raw_sections = await _call_llm_json(system_prompt, user_content, temperature=0.2)
            print(f"[PPT-DETECT] [{i+1}/{len(file_slides_list)}] {fs['file_name']} -> "
                  f"AI 识别出 {len(raw_sections)} 个 section", flush=True)

            for raw in raw_sections:
                name = str(raw.get("name", "")).strip()
                if not name:
                    continue
                slide_nums = raw.get("slides", [])
                if not isinstance(slide_nums, list):
                    continue
                slides_sorted = sorted(set(int(n) for n in slide_nums if isinstance(n, (int, float))))
                if not slides_sorted:
                    continue

                part_slides = [s for s in fs["slides"] if s["index"] in slides_sorted]
                part = {
                    "file_id": fs["file_id"],
                    "file_name": fs["file_name"],
                    "file_path": fs["file_path"],
                    "slide_start": slides_sorted[0],
                    "slide_end": slides_sorted[-1],
                    "slides": part_slides,
                }
                _push_section_part(sections, name, part)
                print(f"[PPT-DETECT]   . \"{name}\" -> slides {slides_sorted[0]}-{slides_sorted[-1]} "
                      f"({len(slides_sorted)} 页)", flush=True)
        except Exception as e:
            print(f"[PPT-DETECT] 错误: {fs['file_name']} 识别失败: {e}", flush=True)

    sec_summary = ", ".join(f"{s['name']}({len(s['parts'])}个片段)" for s in sections)
    print(f"[PPT-DETECT] 识别完成，共 {len(sections)} 个全局 section: {sec_summary}", flush=True)
    return sections


def _slide_summary(file_slides: dict) -> str:
    """生成幻灯片摘要文本供 LLM 分析。"""
    lines: list[str] = []
    for s in file_slides["slides"]:
        sample = " / ".join(t["text"] for t in s["texts"])
        sample = re.sub(r"\s+", " ", sample)[:120]
        title = s.get("title") or "(无标题)"
        lines.append(f"Slide {s['index']}: {title}" + (f" | {sample}" if sample else ""))
    return "\n".join(lines)


def _push_section_part(sections: list[dict], name: str, part: dict) -> None:
    """将 section part 添加到对应名称的 section 中（不存在则新建）。"""
    for s in sections:
        if s["name"] == name:
            s["parts"].append(part)
            return
    sections.append({"name": name, "parts": [part]})


# ---- 步骤 3：合并总览 ----

def build_reading_script(sections: list[dict]) -> str:
    """生成 Markdown 格式的阅读稿。"""
    lines = ["# PPT Sections 合并总览", ""]
    total_parts = sum(len(s["parts"]) for s in sections)
    lines.append(f"共 {len(sections)} 个 section，{total_parts} 个文件片段。")
    lines.append("")

    for section in sections:
        lines.append(f"## ▍{section['name']}")
        lines.append("")
        for part in section["parts"]:
            lines.append(f"### {part['file_name']}")
            lines.append(f"> 页面范围：第 {part['slide_start']}–{part['slide_end']} 页")
            lines.append("")
            for slide in part["slides"]:
                title = slide.get("title") or "(无标题)"
                lines.append(f"**第 {slide['index']} 页 · {title}**")
                for t in slide["texts"]:
                    clean = re.sub(r"\s+", " ", t["text"]).strip()
                    if clean:
                        lines.append(f"- {clean}")
                lines.append("")
    return "\n".join(lines)


# ---- 步骤 0：按文字新建 PPT ----

async def create_from_text(text: str) -> dict:
    """根据用户输入的文字（大纲/要点/正文）生成一份新 PPT。

    流程：
    1. 调用 LLM 把文字拆分成多页幻灯片大纲（每页含标题 + 要点）。
    2. 用 officecli 创建空白 PPT，逐页添加 slide 标题 + 正文 shape。
    3. 保存并返回生成文件信息。
    """
    print(f"[PPT-CREATE] 开始按文字新建 PPT: 输入 {len(text)} 字符", flush=True)

    system_prompt = (
        "你是专业 PPT 大纲设计师。用户给出一段文字，请把它组织成一份结构清晰、可直接用于演示的 PPT 大纲。\n"
        "要求：\n"
        "1. 每页只聚焦一个主题，页数 4~12 页，内容较多时适当拆分。\n"
        "2. 每页包含简洁的标题（title）和 3~6 条要点（bullets）。\n"
        "3. 尊重用户原文的信息和语气，不要编造原文没有的事实。\n"
        "4. 中文输出。\n"
        "严格以 JSON 返回，格式：{\"slides\":[{\"title\":\"目录\",\"bullets\":[\"点1\",\"点2\"]}]}。"
        "不要输出任何其他文字。"
    )
    user_content = text

    try:
        raw = await _call_llm_json(system_prompt, user_content, temperature=0.4)
    except Exception as e:
        raise RuntimeError(f"AI 生成 PPT 大纲失败: {e}")

    slides = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        bullets = item.get("bullets", [])
        if not isinstance(bullets, list):
            bullets = []
        bullets = [str(b).strip() for b in bullets if str(b).strip()]
        # 标题为空时用第一条要点兜底
        if not title and bullets:
            title = bullets.pop(0)
        if not title:
            continue
        slides.append({"title": title, "bullets": bullets})

    if not slides:
        raise RuntimeError("AI 未能生成有效的 PPT 大纲")

    work_dir = _get_work_dir()
    out_path = work_dir / f"新建-{int(time.time()*1000)}.pptx"
    print(f"[PPT-CREATE] 生成 {len(slides)} 页大纲 -> {out_path}", flush=True)

    if not officecli.create_document(str(out_path)):
        raise RuntimeError("创建新 PPT 失败")

    for i, slide in enumerate(slides):
        slide_num = i + 1
        # 添加标题
        officecli.add_element(str(out_path), "/", "slide", {"title": slide["title"]})
        # 添加正文（多条要点用换行拼成多段）
        if slide["bullets"]:
            body = "\n".join(slide["bullets"])
            officecli.add_element(
                str(out_path), f"/slide[{slide_num}]", "shape", {"text": body}
            )
        print(f"[PPT-CREATE]   slide[{slide_num}] \"{slide['title']}\" "
              f"({len(slide['bullets'])} 条要点)", flush=True)

    officecli.save_document(str(out_path))

    final_name = out_path.name
    print(f"[PPT-CREATE] 完成: {final_name} ({len(slides)} 页)", flush=True)
    return {
        "file_path": str(out_path),
        "file_name": final_name,
        "total_slides": len(slides),
    }


def build_merged_ppt(sections: list[dict]) -> dict:
    """将各 section 合并为一个总览 PPT。

    返回: {"file_path": str, "file_name": str, "total_slides": int}
    """
    total_parts = sum(len(s["parts"]) for s in sections)
    print(f"[PPT-MERGE] 开始合并: {len(sections)} 个 section, {total_parts} 个文件片段", flush=True)

    work_dir = _get_work_dir()
    temp_path = work_dir / f"merged-{int(time.time()*1000)}.pptx"
    print(f"[PPT-MERGE] 临时合并文件: {temp_path}", flush=True)

    if not officecli.create_document(str(temp_path)):
        raise RuntimeError("创建合并 PPT 失败")

    target_index = 0  # 合并文件当前幻灯片数（0-based 计数，实际 slide[N] 是 1-based）
    failed = 0

    for si, section in enumerate(sections):
        # 插入 section 标题页
        title_ok = officecli.add_element(
            str(temp_path), "/", "slide", {"title": section["name"]}
        )
        if title_ok:
            target_index += 1
            print(f"[PPT-MERGE] 插入 section 标题页 [{si}] \"{section['name']}\" -> target slide {target_index}", flush=True)

        for part in section["parts"]:
            src_path = part["file_path"]
            if not os.path.exists(src_path):
                print(f"[PPT-MERGE] 源文件不存在: {src_path}", flush=True)
                failed += 1
                continue

            for n in range(part["slide_start"], part["slide_end"] + 1):
                src_selector = f"/slide[{n}]"
                try:
                    commands = officecli.dump_element(src_path, src_selector)
                except Exception as e:
                    print(f"[PPT-MERGE] dump 失败: {part['file_name']}{src_selector}: {e}", flush=True)
                    failed += 1
                    continue

                if not commands:
                    failed += 1
                    continue

                target_index += 1
                # 改写路径引用：/slide[src] -> /slide[dst]
                rewritten = _rewrite_slide_paths(commands, n, target_index)

                try:
                    officecli.apply_batch(str(temp_path), rewritten)
                except Exception as e:
                    print(f"[PPT-MERGE] batch 失败: {part['file_name']} slide[{n}]: {e}", flush=True)
                    failed += 1

    # 确保保存
    officecli.save_document(str(temp_path))

    print(f"[PPT-MERGE] 合并完成: {target_index} 页, 失败 {failed} 页", flush=True)

    if target_index == 0:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise RuntimeError("合并结果为空（0 页）")

    final_name = f"合并总览-{int(time.time())}.pptx"
    final_path = work_dir / final_name
    shutil.move(str(temp_path), str(final_path))

    return {
        "file_path": str(final_path),
        "file_name": final_name,
        "total_slides": target_index,
    }


def _rewrite_slide_paths(commands: list[dict], src_index: int, dst_index: int) -> list[dict]:
    """将 dump 命令中的 /slide[src] 引用改写为 /slide[dst]。"""
    src_token = f"/slide[{src_index}]"
    dst_token = f"/slide[{dst_index}]"

    def rewrite(v):
        if isinstance(v, str):
            return v.replace(src_token, dst_token)
        if isinstance(v, list):
            return [rewrite(x) for x in v]
        if isinstance(v, dict):
            return {k: rewrite(val) for k, val in v.items()}
        return v

    return [rewrite(c) for c in commands]


# ---- 步骤 4：AI 统一修改 ----

async def modify_content(sections: list[dict], instruction: str = "") -> list[dict]:
    """AI 统一修改各 PPT 文本内容，返回补丁列表。"""
    patches: list[dict] = []
    all_files = _collect_unique_files(sections)
    print(f"[PPT-MODIFY] 开始统一修改: {len(all_files)} 个文件, 指令: "
          f"{instruction[:80] if instruction else '(默认修正一致性)'}", flush=True)

    overview = build_reading_script(sections)[:12000]

    for fi, file_info in enumerate(all_files):
        file_id = file_info["file_id"]
        file_path = file_info["file_path"]
        file_name = file_info["file_name"]

        # 收集该文件中所有 section 涉及的文本节点
        nodes: list[dict] = []
        for section in sections:
            for part in section["parts"]:
                if part["file_id"] != file_id:
                    continue
                for slide in part["slides"]:
                    for t in slide["texts"]:
                        nodes.append({
                            "section": section["name"],
                            "slide": slide["index"],
                            "path": t["path"],
                            "text": t["text"],
                        })

        if not nodes:
            continue

        print(f"[PPT-MODIFY] [{fi+1}/{len(all_files)}] {file_name} -> {len(nodes)} 个文本节点", flush=True)

        system_prompt = (
            "你是 PPT 内容编辑。用户在合并同一模板的多个 PPT 后，希望对内容做统一修改"
            "（模板一致，无需改版式/字体/配色，只改文字内容）。\n"
            "请对给定文件中的每一条文本节点，在保持原意和结构的前提下，按用户要求修改内容，"
            "并让同一 section 在不同文件间的措辞、数据保持一致。\n"
            "逐条输出，不要漏掉任何节点。严格以 JSON 返回，格式：\n"
            '{"patches":[{"path":"/slide[1]/shape[@id=2]/paragraph[1]","newText":"修改后的文字"}]}\n'
            "path 必须与输入完全一致，newText 为修改后的新文本。未修改的节点 newText 与原文本相同。不要输出其他文字。"
        )

        nodes_text = "\n".join(
            f"[{n['section']}] Slide {n['slide']} | {n['path']} | {n['text']}"
            for n in nodes
        )
        user_content = (
            f"文件：{file_name}\n\n"
            f"用户要求：{instruction or '检查并修正各 section 内容的一致性与明显错误，统一措辞，保持原意。'}\n\n"
            f"跨文件总览参考（用于保持一致）：\n{overview}\n\n"
            f"本文件需修改的文本节点：\n{nodes_text}"
        )

        try:
            raw_patches = await _call_llm_json(system_prompt, user_content, temperature=0.3)
            print(f"[PPT-MODIFY]   AI 返回 {len(raw_patches)} 条补丁", flush=True)

            for rp in raw_patches:
                p_path = rp.get("path", "")
                if not p_path:
                    continue
                node = next((n for n in nodes if n["path"] == p_path), None)
                if not node:
                    continue
                new_text = str(rp.get("newText", "")).strip()
                if new_text == node["text"]:
                    continue
                patches.append({
                    "file_id": file_id,
                    "file_name": file_name,
                    "file_path": file_path,
                    "slide": node["slide"],
                    "path": p_path,
                    "text": node["text"],
                    "new_text": new_text,
                })
        except Exception as e:
            print(f"[PPT-MODIFY] 错误: {file_name} 修改失败: {e}", flush=True)

    print(f"[PPT-MODIFY] 全部完成，累计 {len(patches)} 条补丁", flush=True)
    return patches


def _collect_unique_files(sections: list[dict]) -> list[dict]:
    """从 sections 中收集所有不重复的文件。"""
    seen: dict[str, dict] = {}
    for s in sections:
        for p in s["parts"]:
            if p["file_id"] not in seen:
                seen[p["file_id"]] = {
                    "file_id": p["file_id"],
                    "file_name": p["file_name"],
                    "file_path": p["file_path"],
                }
    return list(seen.values())


# ---- 步骤 5：一键回填 ----

def apply_patches(patches: list[dict]) -> dict:
    """将补丁原位写回各原始 PPT。"""
    applied = 0
    failed = 0
    errors: list[str] = []

    # 按文件分组
    by_file: dict[str, list[dict]] = {}
    for p in patches:
        by_file.setdefault(p["file_path"], []).append(p)

    print(f"[PPT-APPLY] 开始回填: {len(patches)} 条补丁, {len(by_file)} 个文件", flush=True)

    for file_idx, (file_path, file_patches) in enumerate(by_file.items()):
        file_name = file_patches[0]["file_name"]
        if not os.path.exists(file_path):
            failed += len(file_patches)
            errors.append(f"文件不存在: {file_name}")
            continue

        print(f"[PPT-APPLY] [{file_idx+1}/{len(by_file)}] {file_name} -> "
              f"{len(file_patches)} 条补丁", flush=True)

        for i, p in enumerate(file_patches):
            try:
                officecli.set_element(file_path, p["path"], {"text": p["new_text"]})
                applied += 1
            except Exception as e:
                failed += 1
                err_msg = f"{file_name} {p['path']}: {e}"
                errors.append(err_msg)
                print(f"[PPT-APPLY]   失败: {err_msg}", flush=True)

    # 确保所有文件保存
    for file_path in by_file:
        try:
            officecli.save_document(file_path)
        except Exception:
            pass

    print(f"[PPT-APPLY] 回填完成: 成功={applied}, 失败={failed}", flush=True)
    return {"applied": applied, "failed": failed, "errors": errors}


# ---- 截图 ----

def take_screenshot(file_path: str, page: int = 1) -> str:
    """为 PPT 指定页生成截图，返回图片路径。"""
    work_dir = _get_work_dir()
    file_stem = Path(file_path).stem
    out_path = work_dir / f"{file_stem}-p{page}-{int(time.time()*1000)}.png"
    officecli.view_screenshot(file_path, str(out_path), page=page)
    return str(out_path)


# ---- LLM 调用 ----

async def _call_llm_json(system_prompt: str, user_content: str, temperature: float = 0.2) -> list[dict]:
    """调用 LLM 并解析 JSON 数组响应。"""
    if not settings.browser_use_llm_key:
        raise RuntimeError("未配置 LLM API Key（browser_use_llm_key）")

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
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    content = data["choices"][0]["message"]["content"]
    parsed = _safe_json_parse(content)

    # detect_sections 返回 {"sections": [...]}
    if isinstance(parsed, dict) and "sections" in parsed:
        return parsed["sections"] if isinstance(parsed["sections"], list) else []
    # modify_content 返回 {"patches": [...]}
    if isinstance(parsed, dict) and "patches" in parsed:
        return parsed["patches"] if isinstance(parsed["patches"], list) else []
    # 也可能直接是数组
    if isinstance(parsed, list):
        return parsed
    return []


def _safe_json_parse(text: str) -> Any:
    """安全解析 JSON，容忍 markdown 代码块包裹。"""
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 尝试提取 ```json ... ``` 块
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    # 尝试提取第一个 { ... } 或 [ ... ]
    for start_ch, end_ch in [("{", "}"), ("[", "]")]:
        start = text.find(start_ch)
        end = text.rfind(end_ch)
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None
