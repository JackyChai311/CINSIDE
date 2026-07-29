"""外挂插件：体外循环引擎。

把 CINSIDE 挂后台，AI 自主循环：
  1. 通过 CDP 连接外部 Chrome（默认 http://localhost:9223）
  2. 周期抓取所有「提取源」标签页的文本内容（多源并行）
  3. 内容变化 → LLM 解析出结构化记录（字段键值对）
  4. 复用同一 CDP 连接在「操作页」标签上自主识别表单并填写
  5. 每条处理结果写入记录（内存 + 磁盘 JSONL），供主窗口「外挂记录」面板展示

优化点：
  - CDP 连接全局复用（_ensure_browser），_fill_target 不再每次重连
  - 启动后立即执行首轮，不等 interval
  - 多提取源并行抓取
  - CDP 断线自动重连
  - LLM prompt 引导常见字段名
  - 页面文本抽取覆盖 table/列表
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from ..config import settings, _USER_DATA_DIR

# 注意：Electron 主进程自身已占用 9222 做 CDP，外部 Chrome 用 9223
DEFAULT_CDP_URL = "http://localhost:9223"
_PLUGIN_DIR = _USER_DATA_DIR / "_plugin"
_RECORDS_FILE = _PLUGIN_DIR / "records.jsonl"
_CONFIG_FILE = _PLUGIN_DIR / "config.json"
_MAX_RECORDS = 500
_MAX_TEXT_LEN = 6000


# ============ 状态 ============

class PluginState:
    def __init__(self) -> None:
        self.cdp_url: str = DEFAULT_CDP_URL
        self.sources: list[dict[str, str]] = []   # [{id, title, url}]
        self.target: dict[str, str] | None = None  # {id, title, url}
        self.interval: float = 8.0
        self.running: bool = False
        self.last_error: str | None = None
        self.current_action: str = ""  # 当前正在做什么，供 UI 实时展示
        self.records: list[dict[str, Any]] = []
        self._seen_hashes: dict[str, str] = {}     # source_url -> content hash
        self._processed: set[str] = set()          # 已处理记录指纹（防重复填写）
        self._task: asyncio.Task | None = None
        self._pw = None
        self._browser = None
        self._fill_session = None  # 复用的 browser-use session


_state = PluginState()


# ============ 配置持久化 ============

def _load_config() -> None:
    try:
        if _CONFIG_FILE.exists():
            data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
            _state.cdp_url = data.get("cdp_url") or DEFAULT_CDP_URL
            _state.sources = data.get("sources") or []
            _state.target = data.get("target") or None
            _state.interval = float(data.get("interval") or 8.0)
    except Exception as e:
        print(f"[plugin] load config failed: {e}")


def _save_config() -> None:
    try:
        _PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
        _CONFIG_FILE.write_text(json.dumps({
            "cdp_url": _state.cdp_url,
            "sources": _state.sources,
            "target": _state.target,
            "interval": _state.interval,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[plugin] save config failed: {e}")


def _load_records() -> None:
    try:
        if not _RECORDS_FILE.exists():
            return
        for line in _RECORDS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                _state.records.append(rec)
                fp = _record_fingerprint(rec.get("fields") or {})
                if fp:
                    _state._processed.add(fp)
            except Exception:
                continue
        _state.records = _state.records[-_MAX_RECORDS:]
    except Exception as e:
        print(f"[plugin] load records failed: {e}")


def _append_record(rec: dict[str, Any]) -> None:
    _state.records.append(rec)
    _state.records = _state.records[-_MAX_RECORDS:]
    try:
        _PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
        with _RECORDS_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[plugin] append record failed: {e}")


_load_config()
_load_records()


# ============ 工具 ============

def _record_fingerprint(fields: dict[str, Any]) -> str:
    if not fields:
        return ""
    raw = json.dumps(fields, ensure_ascii=False, sort_keys=True)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _content_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


async def list_chrome_tabs(cdp_url: str | None = None) -> list[dict[str, str]]:
    """列出外部 Chrome 的所有网页标签（通过 CDP /json 接口）。"""
    url = (cdp_url or _state.cdp_url or DEFAULT_CDP_URL).rstrip("/") + "/json"
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        tabs = resp.json()
    out = []
    for t in tabs:
        if t.get("type") != "page":
            continue
        page_url = t.get("url") or ""
        if page_url.startswith(("chrome://", "devtools://", "chrome-extension://")):
            continue
        out.append({
            "id": t.get("id") or "",
            "title": t.get("title") or page_url,
            "url": page_url,
        })
    return out


async def _llm_extract_records(page_text: str, source_title: str) -> list[dict[str, str]]:
    """调用 LLM 从网页文本中提取结构化记录（JSON 数组）。"""
    if not settings.browser_use_llm_key:
        raise RuntimeError("未配置 AI 模型 Key（BROWSER_USE_LLM_KEY），请在设置中配置")

    prompt = (
        f"以下来自网页「{source_title}」的文本内容。请从中提取可以录入系统的人员/条目信息。\n"
        f"要求：\n"
        f"1. 输出 JSON 数组，每个元素是一条记录的字段键值对（扁平对象）\n"
        f"2. 常见字段名包括：name(姓名)、passport_no(护照号)、nationality(国籍)、"
        f"birth_date(出生日期)、gender(性别)、email(邮箱)、phone(电话)、"
        f"student_id(学号)、id_number(身份证号)、address(地址)、school(学校)、major(专业) 等；"
        f"如果页面有其他字段也一并提取，保持原页面字段名\n"
        f"3. 只提取明确存在的数据，不要猜测、不要编造\n"
        f"4. 日期、号码等保持原文格式\n"
        f"5. 如果内容中没有可提取的记录，输出空数组 []\n"
        f"6. 只输出 JSON，不要任何解释\n\n"
        f"网页文本：\n{page_text[:_MAX_TEXT_LEN]}"
    )
    url = settings.browser_use_llm_base.rstrip("/") + "/chat/completions"
    payload = {
        "model": settings.browser_use_llm_model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, headers={
            "Authorization": f"Bearer {settings.browser_use_llm_key}",
            "Content-Type": "application/json",
        }, json=payload)
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]

    m = re.search(r"\[[\s\S]*\]", text or "")
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except Exception:
        return []
    records = []
    for item in data:
        if isinstance(item, dict) and item:
            records.append({str(k): ("" if v is None else str(v)) for k, v in item.items()})
    return records


# ============ CDP / Playwright 访问 ============

async def _ensure_browser():
    """确保与外部 Chrome 的 CDP 连接可用，断线自动重连。"""
    if _state._browser is not None:
        try:
            if _state._browser.is_connected():
                return _state._browser
        except Exception:
            pass
        # 连接已断开，清理旧连接
        try:
            await _state._browser.close()
        except Exception:
            pass
        _state._browser = None
        _state._fill_session = None  # 旧 session 也失效了

    from playwright.async_api import async_playwright
    if _state._pw is None:
        _state._pw = await async_playwright().start()
    # 重试连接，最多 3 次
    last_err = None
    for attempt in range(3):
        try:
            _state._browser = await _state._pw.chromium.connect_over_cdp(_state.cdp_url)
            return _state._browser
        except Exception as e:
            last_err = e
            await asyncio.sleep(1.0)
    raise RuntimeError(f"连接外部 Chrome 失败（{_state.cdp_url}）: {last_err}")


def _match_page(browser, url: str):
    """按 URL 在已连接浏览器里找标签页。"""
    pages = [p for ctx in browser.contexts for p in ctx.pages]
    for p in pages:
        if p.url == url:
            return p
    for p in pages:
        if url and (p.url.startswith(url) or url.startswith(p.url)):
            return p
    for p in pages:
        try:
            if url and url.split("?")[0].rstrip("/") == p.url.split("?")[0].rstrip("/"):
                return p
        except Exception:
            continue
    return None


# 页面正文抽取 JS：覆盖 main/article/body + table + 列表
_JS_EXTRACT_TEXT = (
    "() => {"
    "  const parts = [];"
    "  const root = document.querySelector('main') || document.querySelector('article') || document.body;"
    "  if (root) parts.push(root.innerText || '');"
    "  // 表格内容单独提取，保证结构完整"
    "  document.querySelectorAll('table').forEach(t => {"
    "    t.querySelectorAll('tr').forEach(tr => {"
    "      const cells = Array.from(tr.querySelectorAll('td,th')).map(c => (c.innerText || '').trim());"
    "      if (cells.length) parts.push(cells.join(' | '));"
    "    });"
    "  });"
    "  return parts.join('\\n').slice(0, 8000);"
    "}"
)


async def _fetch_page_text(url: str) -> str:
    """抓取指定标签页的正文文本。"""
    browser = await _ensure_browser()
    page = _match_page(browser, url)
    if page is None:
        raise RuntimeError(f"未找到标签页: {url}")
    return await page.evaluate(_JS_EXTRACT_TEXT)


# ============ 操作页侧边栏注入 ============

_JS_INJECT_SIDEBAR = """
(data) => {
  const ID = 'cinside-plugin-sidebar';
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ID;
    el.style.cssText = [
      'position:fixed','top:0','right:0','width:280px','height:100vh',
      'z-index:2147483647','font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      'background:rgba(255,255,255,0.97)','backdrop-filter:blur(20px)','-webkit-backdrop-filter:blur(20px)',
      'border-left:1px solid rgba(0,0,0,0.08)','box-shadow:-4px 0 24px rgba(0,0,0,0.08)',
      'display:flex','flex-direction:column','overflow:hidden',
      'transition:transform 0.3s cubic-bezier(0.16,1,0.3,1)',
    ].join(';');

    el.innerHTML = `
      <div style="flex:none;display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,0.05);background:linear-gradient(135deg,#dc2626,#b91c1c);">
        <div style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;flex:none;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:#fff;line-height:1.2;">CINSIDE 外挂</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.7);margin-top:1px;">AI 自主填写中</div>
        </div>
        <button id="cinside-sb-toggle" style="flex:none;width:24px;height:24px;border:none;border-radius:6px;background:rgba(255,255,255,0.15);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="收起/展开">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>
      <div id="cinside-sb-body" style="flex:1;overflow-y:auto;padding:10px 12px;">
      </div>
      <div id="cinside-sb-foot" style="flex:none;display:flex;align-items:center;gap:6px;padding:8px 14px;border-top:1px solid rgba(0,0,0,0.05);background:rgba(248,250,252,0.8);">
        <div id="cinside-sb-dot" style="width:6px;height:6px;border-radius:50%;background:#cbd5e1;"></div>
        <div id="cinside-sb-stat" style="font-size:10px;color:#94a3b8;">待机</div>
      </div>
    `;
    document.body.appendChild(el);

    // 收起/展开
    let collapsed = false;
    el.querySelector('#cinside-sb-toggle').addEventListener('click', function() {
      collapsed = !collapsed;
      const body = el.querySelector('#cinside-sb-body');
      const foot = el.querySelector('#cinside-sb-foot');
      if (collapsed) {
        body.style.display = 'none';
        foot.style.display = 'none';
        el.style.width = '48px';
      } else {
        body.style.display = '';
        foot.style.display = '';
        el.style.width = '280px';
      }
    });
  }

  // 更新内容
  const body = el.querySelector('#cinside-sb-body');
  const dot = el.querySelector('#cinside-sb-dot');
  const stat = el.querySelector('#cinside-sb-stat');

  // 状态灯
  if (data.last_error) {
    dot.style.background = '#ef4444'; dot.style.boxShadow = '0 0 6px rgba(239,68,68,0.5)';
    stat.textContent = data.last_error; stat.style.color = '#ef4444';
  } else if (data.running) {
    dot.style.background = '#22c55e'; dot.style.boxShadow = '0 0 6px rgba(34,197,94,0.5)';
    stat.textContent = (data.current_action || '运行中') + ' · ' + (data.records_count||0) + ' 条'; stat.style.color = '#64748b';
  } else {
    dot.style.background = '#cbd5e1'; dot.style.boxShadow = 'none';
    stat.textContent = '待机 · ' + (data.records_count||0) + ' 条'; stat.style.color = '#94a3b8';
  }

  // 记录列表
  let html = '';
  if (!data.records || !data.records.length) {
    html = '<div style="text-align:center;padding:24px 8px;font-size:11px;color:#cbd5e1;">等待 AI 提取数据…</div>';
  } else {
    data.records.slice(0, 8).forEach(function(r) {
      const statusColor = r.status === 'success' ? '#22c55e' : (r.status === 'partial' ? '#f59e0b' : '#ef4444');
      const statusText = r.status === 'success' ? '已填写' : (r.status === 'partial' ? '部分' : '失败');
      const fieldsHtml = Object.entries(r.fields || {}).slice(0, 6).map(function(kv) {
        const filled = r.filled && r.filled[kv[0]];
        const missing = (r.missing || []).indexOf(kv[0]) >= 0;
        const color = filled ? '#22c55e' : (missing ? '#ef4444' : '#94a3b8');
        return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;margin:2px 0;">'
          + '<span style="color:#94a3b8;min-width:50px;">' + kv[0] + '</span>'
          + '<span style="color:#334155;flex:1;word-break:break-all;">' + (kv[1] || '').toString().slice(0, 40) + '</span>'
          + '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';flex:none;"></span>'
          + '</div>';
      }).join('');
      html += '<div style="border:1px solid rgba(0,0,0,0.06);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:#fff;">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">'
        + '<span style="font-size:10px;color:#94a3b8;font-weight:500;">' + (r.source && r.source.title || '').slice(0, 20) + '</span>'
        + '<span style="font-size:9px;font-weight:700;color:' + statusColor + ';background:' + statusColor + '11;padding:1px 6px;border-radius:4px;">' + statusText + '</span>'
        + '</div>'
        + '<div style="font-size:9px;color:#cbd5e1;margin-bottom:4px;">' + (r.time || '').slice(11) + '</div>'
        + fieldsHtml
        + '</div>';
    });
    if (data.records.length > 8) {
      html += '<div style="text-align:center;font-size:10px;color:#94a3b8;padding:4px;">还有 ' + (data.records.length - 8) + ' 条…</div>';
    }
  }
  body.innerHTML = html;

  return true;
}
"""

_JS_REMOVE_SIDEBAR = """
() => {
  const el = document.getElementById('cinside-plugin-sidebar');
  if (el) { el.remove(); return true; }
  return false;
}
"""


async def _inject_sidebar(page, data: dict) -> None:
    """向操作页注入/更新侧边栏。"""
    try:
        await page.evaluate(_JS_INJECT_SIDEBAR, data)
    except Exception:
        pass


async def _remove_sidebar(page) -> None:
    """从操作页移除侧边栏。"""
    try:
        await page.evaluate(_JS_REMOVE_SIDEBAR)
    except Exception:
        pass


def _sidebar_data() -> dict:
    """构建侧边栏需要的数据。"""
    return {
        "running": _state.running,
        "current_action": _state.current_action,
        "last_error": _state.last_error,
        "records_count": len(_state.records),
        "records": _state.records[-12:],
    }


# ============ 操作页填写（复用 CDP 连接） ============

async def _get_fill_session():
    """获取或创建复用的 browser-use session（共享同一 CDP 连接）。"""
    if _state._fill_session is not None:
        try:
            # 检查 session 是否还活着
            page = await _state._fill_session.get_current_page()
            if page is not None:
                return _state._fill_session
        except Exception:
            pass
        try:
            await _state._fill_session.close()
        except Exception:
            pass
        _state._fill_session = None

    from browser_use.browser import BrowserProfile, BrowserSession
    profile = BrowserProfile(cdp_url=_state.cdp_url, is_local=False)
    session = BrowserSession(browser_profile=profile)
    await session.start()
    _state._fill_session = session
    return session


async def _fill_target(fields: dict[str, str], log: list[str]) -> tuple[dict[str, str], list[str]]:
    """用 browser-use 在操作页自主识别并填写字段，返回 (filled, missing)。

    优化：复用全局 CDP 连接的 session，不再每次创建新连接。
    """
    from browser_use.agent import Agent as BUAgent
    from browser_use.llm.openai.chat import ChatOpenAI

    target_url = (_state.target or {}).get("url", "")
    fields_json = json.dumps(fields, ensure_ascii=False, indent=2)
    task = (
        f"你在一个已经打开的网页（操作页）上，当前页面 URL 应为：{target_url}\n"
        f"请把以下数据填写到页面中语义匹配的表单字段里：\n{fields_json}\n\n"
        f"规则：\n"
        f"1. 根据字段名与页面 label / placeholder / 表头文字做语义匹配，找到对应输入框后填写\n"
        f"2. 只填写上面给出的字段，不要修改其他内容\n"
        f"3. 日期保持页面要求的格式；下拉框选择最匹配的选项\n"
        f"4. 找不到对应输入框的字段列入 missing\n"
        f"5. 不要点击最终提交/保存按钮，除非页面流程必须（如「下一步」）\n"
        f"完成后调用 done，final_result 输出 JSON："
        f'{{"filled": {{"字段": "填入值"}}, "missing": ["字段"]}}'
    )

    llm = ChatOpenAI(
        model=settings.browser_use_llm_model,
        base_url=settings.browser_use_llm_base,
        api_key=settings.browser_use_llm_key,
        remove_min_items_from_schema=True,
        add_schema_to_system_prompt=True,
    )

    session = await _get_fill_session()
    log.append(f"已连接 CDP: {_state.cdp_url}")

    # 聚焦到操作页标签
    try:
        manager = getattr(session, "session_manager", None)
        if manager:
            for t in manager.get_all_page_targets():
                t_url = getattr(t, "url", "") or ""
                if target_url and (t_url == target_url or t_url.startswith(target_url) or target_url.startswith(t_url)):
                    session.agent_focus_target_id = t.target_id
                    log.append(f"已聚焦操作页: {t_url}")
                    break
    except Exception as e:
        log.append(f"聚焦操作页失败（将继续尝试）: {e}")

    agent = BUAgent(
        task=task,
        llm=llm,
        browser_session=session,
        use_vision=settings.browser_use_vision,
        max_failures=3,
        extend_system_message=(
            "你是一个数据录入助手。你只读取给定数据并填写到当前已打开的网页表单中，"
            "不要导航到其他网站，不要提交表单。最终结果输出 JSON：{filled, missing}。"
        ),
    )
    log.append("AI 开始识别操作页并填写")
    result = await agent.run(max_steps=settings.browser_use_max_steps)

    filled: dict[str, str] = {}
    missing: list[str] = []
    final_text = ""
    try:
        final_text = result.final_result() or ""
    except Exception:
        pass
    if final_text:
        m = re.search(r"\{[\s\S]*\}", final_text)
        if m:
            try:
                data = json.loads(m.group(0))
                if isinstance(data.get("filled"), dict):
                    filled = {str(k): str(v) for k, v in data["filled"].items()}
                if isinstance(data.get("missing"), list):
                    missing = [str(x) for x in data["missing"]]
            except Exception:
                pass
    log.append(f"AI 填写完成：{len(filled)} 个字段" + (f"，{len(missing)} 个未匹配" if missing else ""))
    # 不关闭 session，留给下次复用
    return filled, missing


# ============ 主循环 ============

async def _fetch_source(src: dict[str, str]) -> tuple[str, str, str | None]:
    """抓取单个提取源，返回 (url, title, text_or_none)。"""
    src_url = src.get("url", "")
    src_title = src.get("title") or src_url
    if not src_url:
        return src_url, src_title, None
    try:
        text = await _fetch_page_text(src_url)
        return src_url, src_title, text
    except Exception as e:
        _state.last_error = f"抓取提取源「{src_title}」失败: {e}"
        return src_url, src_title, None


async def _run_cycle() -> None:
    """单轮循环：并行抓取所有提取源 → 解析 → 填写操作页。"""
    if not _state.sources:
        return

    # 注入/更新操作页侧边栏
    if _state.target:
        browser = await _ensure_browser()
        tgt_page = _match_page(browser, _state.target["url"])
        if tgt_page:
            await _inject_sidebar(tgt_page, _sidebar_data())

    # 并行抓取所有提取源
    _state.current_action = f"正在抓取 {len(_state.sources)} 个提取源…"
    results = await asyncio.gather(*[_fetch_source(s) for s in list(_state.sources)])

    for src_url, src_title, text in results:
        if not _state.running:
            return
        if not text or not text.strip():
            continue
        h = _content_hash(text)
        if _state._seen_hashes.get(src_url) == h:
            continue  # 内容无变化
        _state._seen_hashes[src_url] = h
        _state.last_error = None

        # LLM 解析
        _state.current_action = f"正在解析「{src_title}」的内容…"
        try:
            records = await _llm_extract_records(text, src_title)
        except Exception as e:
            _state.last_error = f"AI 解析失败: {e}"
            _append_record({
                "id": uuid.uuid4().hex[:8],
                "time": datetime.now().isoformat(timespec="seconds"),
                "source": {"title": src_title, "url": src_url},
                "fields": {}, "filled": {}, "missing": [],
                "status": "failed", "log": [], "error": f"AI 解析失败: {e}",
            })
            continue

        if not records:
            continue  # LLM 没提取到任何记录

        # 逐条填写操作页
        for fields in records:
            if not _state.running:
                return
            fp = _record_fingerprint(fields)
            if fp and fp in _state._processed:
                continue  # 该记录已处理过
            if fp:
                _state._processed.add(fp)
            log: list[str] = [f"从「{src_title}」提取到 {len(fields)} 个字段"]
            rec: dict[str, Any] = {
                "id": uuid.uuid4().hex[:8],
                "time": datetime.now().isoformat(timespec="seconds"),
                "source": {"title": src_title, "url": src_url},
                "fields": fields, "filled": {}, "missing": [],
                "status": "failed", "log": log, "error": None,
            }
            if not _state.target:
                rec["status"] = "failed"
                rec["error"] = "未设置操作页"
                log.append("未设置操作页，跳过填写")
                _append_record(rec)
                continue

            _state.current_action = f"正在填写操作页（{list(fields.values())[:2]}…）"
            try:
                filled, missing = await _fill_target(fields, log)
                rec["filled"] = filled
                rec["missing"] = missing
                if filled and not missing:
                    rec["status"] = "success"
                elif filled:
                    rec["status"] = "partial"
                else:
                    rec["status"] = "failed"
                    rec["error"] = "未填写任何字段"
            except Exception as e:
                rec["status"] = "failed"
                rec["error"] = f"{type(e).__name__}: {e}"
                log.append(f"填写失败: {e}")
            _append_record(rec)
            # 每条记录写入后更新侧边栏
            if _state.target:
                browser2 = await _ensure_browser()
                tgt_page2 = _match_page(browser2, _state.target["url"])
                if tgt_page2:
                    await _inject_sidebar(tgt_page2, _sidebar_data())

    _state.current_action = ""
    # 本轮结束，更新侧边栏
    if _state.target:
        browser3 = await _ensure_browser()
        tgt_page3 = _match_page(browser3, _state.target["url"])
        if tgt_page3:
            await _inject_sidebar(tgt_page3, _sidebar_data())


async def _loop() -> None:
    print("[plugin] 体外循环已启动")
    try:
        while _state.running:
            try:
                await _run_cycle()
            except Exception as e:
                _state.last_error = f"{type(e).__name__}: {e}"
                print(f"[plugin] cycle error: {e}")
            if not _state.running:
                break
            await asyncio.sleep(max(3.0, _state.interval))
    finally:
        print("[plugin] 体外循环已停止")
        _state.current_action = ""
        # 移除操作页侧边栏
        if _state.target:
            try:
                browser = await _ensure_browser()
                tgt_page = _match_page(browser, _state.target["url"])
                if tgt_page:
                    await _remove_sidebar(tgt_page)
            except Exception:
                pass
        # 清理 CDP 连接和 session
        try:
            if _state._fill_session is not None:
                await _state._fill_session.close()
        except Exception:
            pass
        _state._fill_session = None
        try:
            if _state._browser is not None:
                await _state._browser.close()
        except Exception:
            pass
        _state._browser = None
        try:
            if _state._pw is not None:
                await _state._pw.stop()
        except Exception:
            pass
        _state._pw = None


# ============ 对外接口 ============

def get_config() -> dict[str, Any]:
    return {
        "cdp_url": _state.cdp_url,
        "sources": _state.sources,
        "target": _state.target,
        "interval": _state.interval,
    }


def set_config(data: dict[str, Any]) -> dict[str, Any]:
    if "cdp_url" in data and data["cdp_url"]:
        _state.cdp_url = str(data["cdp_url"]).rstrip("/")
    if "sources" in data:
        _state.sources = [
            {"id": str(s.get("id", "")), "title": str(s.get("title", "")), "url": str(s.get("url", ""))}
            for s in (data["sources"] or []) if s.get("url")
        ]
    if "target" in data:
        t = data["target"]
        _state.target = {"id": str(t.get("id", "")), "title": str(t.get("title", "")), "url": str(t.get("url", ""))} if t and t.get("url") else None
    if "interval" in data and data["interval"]:
        _state.interval = max(3.0, float(data["interval"]))
    _save_config()
    return get_config()


def get_status() -> dict[str, Any]:
    return {
        "running": _state.running,
        "cdp_url": _state.cdp_url,
        "sources": _state.sources,
        "target": _state.target,
        "interval": _state.interval,
        "records_count": len(_state.records),
        "last_error": _state.last_error,
        "llm_configured": bool(settings.browser_use_llm_key),
        "current_action": _state.current_action,
    }


async def start() -> dict[str, Any]:
    if _state.running:
        return get_status()
    if not _state.sources:
        raise RuntimeError("请先添加至少一个提取源")
    if not _state.target:
        raise RuntimeError("请先设置操作页")
    if not settings.browser_use_llm_key:
        raise RuntimeError("未配置 AI 模型 Key，请先在 CINSIDE 设置中配置")
    _state.running = True
    _state.last_error = None
    _state.current_action = "正在启动…"
    _state._task = asyncio.create_task(_loop())
    return get_status()


async def stop() -> dict[str, Any]:
    _state.running = False
    if _state._task is not None:
        try:
            await asyncio.wait_for(_state._task, timeout=5.0)
        except Exception:
            _state._task.cancel()
        _state._task = None
    return get_status()


def get_records() -> list[dict[str, Any]]:
    return list(reversed(_state.records))


def clear_records() -> None:
    _state.records = []
    _state._processed = set()
    _state._seen_hashes = {}
    try:
        if _RECORDS_FILE.exists():
            _RECORDS_FILE.unlink()
    except Exception:
        pass
