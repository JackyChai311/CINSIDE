"""网页对象（BrowserView）的操控层。

把「Computer Use」拆成模型能理解的原语：
  observe   → 结构化页面快照（带 @e1/@e2 引用 + 可见文本 + 视口/滚动位置）
  click     → CDP 可信鼠标点击（不是 DOM click，跨框架/防抖站点更可靠）
  type      → 聚焦 + 全选 + IME 插入（React/Vue 受控组件能收到 input 事件）
  select    → 原生 select / 自定义下拉按值或文字选中
  press     → 键盘（Enter/Tab/Esc/方向键…）
  scroll    → 滚轮 + 元素滚动兜底
  screenshot→ PNG 截图（供视觉模型看图决策）
  extract   → 表格/列表/文本结构化抽取

所有动作都返回「动作后的观察摘要」，模型据此自检，不需要额外一轮。
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any

# 可视光标：动作前的落点提示色 + 停留时间（让人眼能跟上一帧）
_COLOR_CLICK = "#6366f1"
_COLOR_TYPE = "#10b981"
_COLOR_SELECT = "#0ea5e9"
_AIM_DELAY = 0.14

from .cdp import CDPError, CDPPage, data_url, decode_png_size


# ========== 页面内脚本 ==========

# 通用工具函数：可见性、文本、可交互元素收集（含 shadow DOM 穿透）
_PRELUDE = r"""
const __CI = (() => {
  const seen = new Set();
  const vis = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    // 完全在视口外也算是存在，只是需要滚动
    return true;
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const allRoots = (root = document, out = []) => {
    out.push(root);
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const n of nodes) {
      if (n.shadowRoot) allRoots(n.shadowRoot, out);
    }
    return out;
  };
  const labelOf = (el) => {
    const cand = [
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('placeholder'),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('name'),
    ];
    let t = cand.find((v) => v && String(v).trim());
    if (t) return String(t).trim();
    if (el.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) return txt(l);
      } catch (_) {}
    }
    const wrap = el.closest && el.closest('label');
    if (wrap) return txt(wrap);
    // 前后兄弟文本兜底（表格表单里 label 与 input 并列）
    const prev = el.previousElementSibling;
    if (prev && prev.tagName && /^(LABEL|SPAN|TD|TH|DIV|P)$/.test(prev.tagName)) {
      const pt = txt(prev);
      if (pt && pt.length <= 40) return pt;
    }
    return '';
  };
  const roleOf = (el) => {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'button';
      if (ty === 'file') return 'file';
      if (ty === 'search') return 'searchbox';
      return 'textbox';
    }
    return tag;
  };
  // 可视光标：动作前在目标上闪一个框 + 一个光点，让人能看见"它在点哪里"
  const paint = (rect, color, label) => {
    const ID = '__cinside_aim__';
    let box = document.getElementById(ID);
    if (!box) {
      box = document.createElement('div');
      box.id = ID;
      document.documentElement.appendChild(box);
    }
    box.textContent = '';
    box.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'pointer-events:none',
      'box-sizing:border-box', 'transition:opacity .25s ease',
      'border:2px solid ' + (color || '#6366f1'),
      'background:' + (color || '#6366f1') + '1f',
      'border-radius:6px',
      'left:' + (rect.left - 3) + 'px',
      'top:' + (rect.top - 3) + 'px',
      'width:' + (rect.width + 6) + 'px',
      'height:' + (rect.height + 6) + 'px',
      'opacity:1',
    ].join(';');
    if (label) {
      const tag = document.createElement('div');
      tag.textContent = label;
      // 目标贴着视口顶部时标签画在框上方会被裁掉，改到底部
      const below = rect.top - 3 < 20;
      tag.style.cssText = [
        'position:absolute', 'left:0',
        below ? 'top:100%' : 'top:-17px',
        below ? 'margin-top:2px' : '',
        'max-width:260px', 'overflow:hidden', 'white-space:nowrap',
        'text-overflow:ellipsis', 'font:600 10px/1.5 system-ui,sans-serif',
        'color:#fff', 'background:' + (color || '#6366f1'),
        'padding:0 5px', 'border-radius:4px',
      ].join(';');
      box.appendChild(tag);
    }
    // 光点：落在目标中心，像真的有个鼠标停在那
    const dotID = '__cinside_dot__';
    let dot = document.getElementById(dotID);
    if (!dot) {
      dot = document.createElement('div');
      dot.id = dotID;
      document.documentElement.appendChild(dot);
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    dot.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'pointer-events:none',
      'left:' + (cx - 7) + 'px', 'top:' + (cy - 7) + 'px',
      'width:14px', 'height:14px', 'border-radius:50%',
      'background:radial-gradient(circle at 35% 35%, #fff 0%, ' +
        (color || '#6366f1') + ' 55%, ' + (color || '#6366f1') + ' 100%)',
      'box-shadow:0 0 0 3px ' + (color || '#6366f1') + '33, 0 1px 4px rgba(0,0,0,.35)',
      'transition:opacity .25s ease', 'opacity:1',
    ].join(';');
    clearTimeout(window.__ciAimTimer);
    window.__ciAimTimer = setTimeout(() => {
      box.style.opacity = '0';
      dot.style.opacity = '0';
    }, 1400);
  };
  return { seen, vis, inView, txt, allRoots, labelOf, roleOf, paint };
})();
"""

_OBSERVE_JS = (
    "(() => {"
    + _PRELUDE
    + r"""
  const P = __PARAMS__;
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]',
    '[role=tab]', '[role=menuitem]', '[role=option]', '[role=combobox]',
    '[role=switch]', '[role=textbox]', '[role=searchbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const roots = __CI.allRoots();
  const found = [];
  for (const root of roots) {
    let nodes = [];
    try { nodes = root.querySelectorAll(SELECTOR); } catch (_) { continue; }
    for (const el of nodes) {
      if (el.__ciSkip) continue;
      if (!__CI.vis(el)) continue;
      if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') continue;
      found.push(el);
    }
  }
  // 去重（同一元素可能被多个选择器命中）+ 文档序
  const seen = new Set();
  const uniq = [];
  for (const el of found) {
    if (seen.has(el)) continue;
    seen.add(el);
    uniq.push(el);
  }
  // 超大页面不再对上千个元素逐个量坐标（每次 getBoundingClientRect 都触发重排）
  const bounded = uniq.length > 600 ? uniq.slice(0, 600) : uniq;
  bounded.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.top - rb.top) || (ra.left - rb.left);
  });

  // 引用编号在页面生命周期内保持稳定：同一元素永远是同一个 @eN。
  // 这样「动作后自动复查」重新观察时，模型手里的旧引用不会指到别的元素上。
  if (!window.__ciRefMap || !(window.__ciRefMap instanceof WeakMap)) {
    window.__ciRefMap = new WeakMap();
    window.__ciRefSeq = 0;
  }
  const refMap = window.__ciRefMap;

  const cap = P.max_elements || 200;
  const maxName = 120;
  const items = [];
  for (const el of bounded) {
    if (items.length >= cap) break;
    let ref = refMap.get(el);
    if (!ref) {
      window.__ciRefSeq += 1;
      ref = 'e' + window.__ciRefSeq;
      refMap.set(el, ref);
    }
    el.setAttribute('data-cinside-ref', ref);
    const rect = el.getBoundingClientRect();
    const role = __CI.roleOf(el);
    const name = (__CI.labelOf(el) || __CI.txt(el) || (el.value ? String(el.value) : '')).slice(0, maxName);
    const item = {
      ref,
      role,
      tag: el.tagName.toLowerCase(),
      name,
      in_view: __CI.inView(el),
      rect: {
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (el.getAttribute('aria-expanded') != null) item.expanded = el.getAttribute('aria-expanded');
    if (el.type && /^(checkbox|radio)$/i.test(el.type)) item.checked = !!el.checked;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      item.type = (el.type || 'text').toLowerCase();
      if (el.value) item.value = String(el.value).slice(0, 200);
      if (el.required) item.required = true;
      if (el.readOnly) item.readonly = true;
    }
    if (el.tagName === 'SELECT') {
      item.options = Array.from(el.options).slice(0, 60).map((o) => ({
        v: o.value, t: (o.text || '').trim().slice(0, 60), sel: o.selected,
      }));
      item.value = el.value;
    }
    if (el.getAttribute('contenteditable') != null) item.editable = true;
    if (el.href && el.tagName === 'A') item.href = String(el.href).slice(0, 300);
    items.push(item);
  }

  // 页面级文本：去掉脚本/样式/重复空白
  let bodyText = '';
  try {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg').forEach((n) => n.remove());
    bodyText = (clone.innerText || clone.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } catch (_) {
    bodyText = (document.body?.innerText || '').trim();
  }
  if (bodyText.length > (P.max_text || 6000)) bodyText = bodyText.slice(0, P.max_text || 6000) + '…[已截断]';

  const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
    .slice(0, 25)
    .map((h) => ({ tag: h.tagName.toLowerCase(), text: __CI.txt(h).slice(0, 120) }))
    .filter((h) => h.text);

  const alerts = [];
  for (const sel of ['[role=alert]', '[role=status]', '.ant-message', '.el-message', '.toast', '.alert', '.error', '.ant-form-item-explain-error']) {
    for (const el of document.querySelectorAll(sel)) {
      if (!__CI.vis(el)) continue;
      const t = __CI.txt(el).slice(0, 200);
      if (t && !alerts.includes(t)) alerts.push(t);
    }
  }

  const iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 10).map((f) => {
    let same = false;
    try { same = !!(f.contentDocument && f.contentDocument.body); } catch (_) { same = false; }
    return { src: (f.src || '').slice(0, 200), same_origin: same };
  });

  return {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    scroll: {
      x: Math.round(scrollX), y: Math.round(scrollY),
      max_y: Math.round(Math.max(0, (document.documentElement.scrollHeight || 0) - innerHeight)),
    },
    focused: (() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      return { ref: a.getAttribute('data-cinside-ref') || null, tag: a.tagName.toLowerCase() };
    })(),
    headings,
    alerts: alerts.slice(0, 6),
    elements: items,
    total_interactive: uniq.length,
    truncated: uniq.length > items.length,
    iframes,
    text: bodyText,
  };
})()
"""
)

# 在页面里定位引用元素并返回其视口坐标（点击用真实鼠标事件）
_RECT_JS = (
    "(() => {"
    + _PRELUDE
    + r"""
  const ref = __REF__;
  const el = document.querySelector('[data-cinside-ref="' + ref + '"]');
  if (!el) return { ok: false, error: 'ref 失效（页面已变化），请重新 web_observe' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  // 有 mark 就顺手画一下：用户能看见这一下点在哪儿
  if (__MARK__) __CI.paint(r, __MARK__, __MARKLABEL__);
  return {
    ok: true,
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    w: r.width,
    h: r.height,
    role: __CI.roleOf(el),
    tag: el.tagName.toLowerCase(),
    disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    name: (__CI.labelOf(el) || __CI.txt(el) || '').slice(0, 80),
  };
})()
"""
)


def _js(template: str, **params: Any) -> str:
    out = template
    for key, value in params.items():
        out = out.replace(f"__{key.upper()}__", json.dumps(value, ensure_ascii=False))
    return out


def _rect_js(ref: str, mark: str = "", label: str = "") -> str:
    """定位元素坐标；mark 非空时顺便在页面上画一个可视光标。"""
    return _js(_RECT_JS, ref=ref, mark=mark, marklabel=label)


# 聚焦并把光标放到文本末尾（type 前调用）
_FOCUS_JS = (
    "(() => {"
    + _PRELUDE
    + r"""
  const ref = __REF__;
  const el = document.querySelector('[data-cinside-ref="' + ref + '"]');
  if (!el) return { ok: false, error: 'ref 失效，请重新 web_observe' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (__MARK__) __CI.paint(el.getBoundingClientRect(), __MARK__, __MARKLABEL__);
  try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (__CLEAR__) {
      const setter = Object.getOwnPropertyDescriptor(
        tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
  } else if (el.isContentEditable) {
    if (__CLEAR__) {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  if (__SUBMIT__ && el.form) { /* Enter 由 CDP 键盘事件发出 */ }
  const r = el.getBoundingClientRect();
  return {
    ok: true,
    tag: tag.toLowerCase(),
    name: (__CI.labelOf(el) || '').slice(0, 80),
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    readonly: !!el.readOnly,
    disabled: !!el.disabled,
  };
})()
"""
)

_SELECT_JS = (
    "(() => {"
    + _PRELUDE
    + r"""
  const ref = __REF__, want = __VALUE__;
  const el = document.querySelector('[data-cinside-ref="' + ref + '"]');
  if (!el) return { ok: false, error: 'ref 失效，请重新 web_observe' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (__MARK__) __CI.paint(el.getBoundingClientRect(), __MARK__, __MARKLABEL__);
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(want);

  if (el.tagName === 'SELECT') {
    const opts = Array.from(el.options);
    let hit = opts.find((o) => norm(o.value) === target || norm(o.text) === target);
    if (!hit) hit = opts.find((o) => norm(o.text).includes(target) || norm(o.value).includes(target));
    if (!hit) {
      return { ok: false, error: '下拉里没有匹配项', options: opts.slice(0, 40).map((o) => o.text.trim()) };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, hit.value);
    else el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: (hit.text || '').trim(), value: hit.value, via: 'native-select' };
  }

  // 自定义下拉：先点击展开，再在页面里找同名可点项
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  try { el.focus({ preventScroll: true }); } catch (_) {}
  el.click();
  return { ok: true, pending: true, message: '已展开自定义下拉，请在观察结果里找到目标选项的 ref 并用 web_click 点击' };
})()
"""
)

_SCROLL_JS = (
    "(() => {"
    + _PRELUDE
    + r"""
  const dir = __DIR__, amount = __AMOUNT__, ref = __REF__;
  let target = null;
  if (ref) {
    target = document.querySelector('[data-cinside-ref="' + ref + '"]');
    if (target) target.scrollIntoView({ block: dir === 'up' ? 'start' : 'end', behavior: 'instant' });
  }
  const dy = dir === 'up' ? -amount : amount;
  if (!target) window.scrollBy({ top: dy, left: 0, behavior: 'instant' });
  return {
    ok: true,
    scroll_y: Math.round(scrollY),
    max_y: Math.round(Math.max(0, (document.documentElement.scrollHeight || 0) - innerHeight)),
  };
})()
"""
)

_EXTRACT_JS = (
    "(() => {"
    + _PRELUDE
    + r"""
  const ref = __REF__, kind = __KIND__, limit = __LIMIT__;
  let root = document.body;
  if (ref) {
    const el = document.querySelector('[data-cinside-ref="' + ref + '"]');
    if (!el) return { ok: false, error: 'ref 失效，请重新 web_observe' };
    root = el;
  }
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  if (kind === 'table') {
    const tables = root.tagName === 'TABLE' ? [root] : Array.from(root.querySelectorAll('table'));
    const out = tables.slice(0, 8).map((t) => {
      const rows = Array.from(t.querySelectorAll('tr')).slice(0, limit).map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((c) => clean(c.innerText || c.textContent))
      );
      return rows.filter((r) => r.length);
    });
    return { ok: true, kind, tables: out, count: out.length };
  }
  if (kind === 'list') {
    const sels = 'li,tr,[role=row],[role=listitem]';
    const nodes = root.querySelectorAll ? root.querySelectorAll(sels) : [];
    const out = [];
    for (const n of nodes) {
      if (out.length >= limit) break;
      if (!__CI.vis(n)) continue;
      const t = __CI.txt(n);
      if (t) out.push(t.slice(0, 400));
    }
    return { ok: true, kind, items: out, count: out.length };
  }
  if (kind === 'links') {
    const nodes = (root.querySelectorAll ? root.querySelectorAll('a[href]') : []);
    const out = [];
    for (const n of nodes) {
      if (out.length >= limit) break;
      if (!__CI.vis(n)) continue;
      out.push({ text: __CI.txt(n).slice(0, 100), href: n.href });
    }
    return { ok: true, kind, links: out, count: out.length };
  }
  const text = (root.innerText || root.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { ok: true, kind: 'text', text: text.slice(0, limit * 20), length: text.length };
})()
"""
)

_HIGHLIGHT_JS = (
    "(() => {"
    + r"""
  const ref = __REF__;
  document.querySelectorAll('[data-cinside-harness-hl]').forEach((n) => {
    n.style.outline = '';
    n.removeAttribute('data-cinside-harness-hl');
  });
  if (!ref) return { ok: true };
  const el = document.querySelector('[data-cinside-ref="' + ref + '"]');
  if (!el) return { ok: false, error: 'ref 失效' };
  el.style.outline = '3px solid #f59e0b';
  el.setAttribute('data-cinside-harness-hl', '1');
  return { ok: true };
})()
"""
)


class WebTarget:
    """一个网页目标 = 一个 BrowserView 页面。

    页面可能在任务执行期间导航/刷新，因此每次动作前都做一次轻量存活检查，
    断开则重连并重新解析 target。
    """

    def __init__(
        self,
        endpoint: str,
        preferred_url: str = "",
        *,
        label: str = "网页",
        exclude_urls: list[str] | None = None,
    ):
        self.endpoint = endpoint
        self.preferred_url = preferred_url
        self.label = label
        self.exclude_urls = exclude_urls or []
        self._page: CDPPage | None = None
        self.last_url = preferred_url

    async def page(self) -> CDPPage:
        if self._page is not None and self._page.alive:
            return self._page
        if self._page is not None:
            await self._page.aclose()
            self._page = None
        from .cdp import resolve_page_target

        target = await resolve_page_target(
            self.endpoint, self.preferred_url or self.last_url, exclude_urls=self.exclude_urls
        )
        self._page = await CDPPage(target).connect()
        return self._page

    async def aclose(self) -> None:
        if self._page is not None:
            await self._page.aclose()
            self._page = None

    # ---------- 观察 ----------

    async def observe(self, max_elements: int = 200, max_text: int = 6000) -> dict:
        page = await self.page()
        script = _js(_OBSERVE_JS, params={"max_elements": max_elements, "max_text": max_text})
        data = await page.evaluate(script)
        if not isinstance(data, dict):
            raise CDPError("页面观察返回了非预期结果")
        self.last_url = data.get("url") or self.last_url
        return data

    # ---------- 动作 ----------

    async def click(self, ref: str, *, click_count: int = 1) -> dict:
        page = await self.page()
        info = await page.evaluate(_rect_js(ref, mark=_COLOR_CLICK, label="点击"))
        if not isinstance(info, dict) or not info.get("ok"):
            return {"ok": False, "error": (info or {}).get("error", "元素定位失败")}
        if info.get("disabled"):
            return {"ok": False, "error": f"元素 {ref}（{info.get('name')}）处于 disabled 状态"}
        # 让人先看清落点，再真正按下去
        await asyncio.sleep(_AIM_DELAY)
        # 真鼠标点击；坐标必须落在视口内，先滚到中间已由 JS 保证
        await page.mouse_click(float(info["x"]), float(info["y"]), clicks=click_count)
        return {
            "ok": True,
            "clicked": ref,
            "target": f"{info.get('role')}「{info.get('name')}」",
        }

    async def type_text(self, ref: str, text: str, *, clear: bool = True, submit: bool = False) -> dict:
        page = await self.page()
        info = await page.evaluate(
            _js(_FOCUS_JS, ref=ref, clear=clear, submit=submit, mark=_COLOR_TYPE, marklabel="输入")
        )
        if not isinstance(info, dict) or not info.get("ok"):
            return {"ok": False, "error": (info or {}).get("error", "元素定位失败")}
        if info.get("readonly"):
            return {"ok": False, "error": f"元素 {ref} 是只读的"}
        if info.get("disabled"):
            return {"ok": False, "error": f"元素 {ref} 处于 disabled 状态"}
        await asyncio.sleep(_AIM_DELAY)
        await page.insert_text(text)
        if submit:
            await page.press_key("Enter")
        return {
            "ok": True,
            "filled": ref,
            "target": f"{info.get('tag')}「{info.get('name')}」",
            "value": text[:200],
            "submitted": bool(submit),
        }

    async def select(self, ref: str, value: str) -> dict:
        page = await self.page()
        res = await page.evaluate(
            _js(_SELECT_JS, ref=ref, value=value, mark=_COLOR_SELECT, marklabel="选择")
        )
        await asyncio.sleep(_AIM_DELAY)
        return res if isinstance(res, dict) else {"ok": False, "error": "选择失败"}

    async def press(self, key: str, *, times: int = 1) -> dict:
        page = await self.page()
        for _ in range(max(1, min(times, 10))):
            await page.press_key(key)
        return {"ok": True, "pressed": key, "times": times}

    async def scroll(self, direction: str = "down", amount: int = 600, ref: str = "") -> dict:
        page = await self.page()
        res = await page.evaluate(_js(_SCROLL_JS, dir=direction, amount=int(amount), ref=ref or ""))
        return res if isinstance(res, dict) else {"ok": False, "error": "滚动失败"}

    async def navigate(self, url: str) -> dict:
        page = await self.page()
        if not re.match(r"^(https?|file|about):", url, re.I):
            url = "https://" + url
        await page.navigate(url)
        self.last_url = url
        return {"ok": True, "navigated_to": url}

    async def go_back(self) -> dict:
        page = await self.page()
        await page.evaluate("history.back()", await_promise=False)
        return {"ok": True, "action": "back"}

    async def evaluate(self, js: str) -> Any:
        page = await self.page()
        return await page.evaluate(js)

    async def extract(self, ref: str = "", kind: str = "text", limit: int = 50) -> dict:
        page = await self.page()
        res = await page.evaluate(_js(_EXTRACT_JS, ref=ref or "", kind=kind, limit=int(limit)))
        return res if isinstance(res, dict) else {"ok": False, "error": "抽取失败"}

    async def highlight(self, ref: str = "") -> None:
        try:
            page = await self.page()
            await page.evaluate(_js(_HIGHLIGHT_JS, ref=ref or ""))
        except CDPError:
            pass

    async def screenshot(self, ref: str = "", full_page: bool = False) -> dict:
        page = await self.page()
        clip = None
        if ref:
            info = await page.evaluate(_rect_js(ref))
            if isinstance(info, dict) and info.get("ok"):
                info2 = await page.evaluate(
                    "(() => { const el = document.querySelector('[data-cinside-ref="
                    + json.dumps(ref)
                    + "]'); if (!el) return null; const r = el.getBoundingClientRect();"
                    " return {x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height}; })()"
                )
                if isinstance(info2, dict) and info2.get("width"):
                    clip = info2
        png = await page.screenshot(clip=clip, full_page=full_page)
        w, h = decode_png_size(png)
        return {"data_url": data_url(png), "width": w, "height": h, "ref": ref or None}

    # ---------- 动作后摘要 ----------

    async def post_action_state(self, max_elements: int = 30, max_text: int = 1200) -> dict:
        """动作后的轻量复查：URL 是否变了、有没有报错提示、可见文本变化。

        `page_navigated=true` 时必须提示模型「旧引用全部失效」——
        页面跳转后 window 被重置，引用编号会从头开始，最容易点错元素。
        """
        prev_url = self.last_url
        try:
            snap = await self.observe(max_elements=max_elements, max_text=max_text)
        except CDPError as e:
            return {"ok": False, "error": str(e)}
        els = snap.get("elements") or []
        cur_url = snap.get("url") or ""
        navigated = bool(prev_url) and cur_url.split("#")[0] != prev_url.split("#")[0]
        out: dict = {
            "url": cur_url,
            "title": snap.get("title"),
            "alerts": snap.get("alerts") or [],
            "scroll_y": (snap.get("scroll") or {}).get("y"),
            "headings": [h.get("text") for h in (snap.get("headings") or [])][:6],
            "text": (snap.get("text") or "")[:max_text],
            "element_count": snap.get("total_interactive", 0),
            "has_modal": any(einfo.get("role") in ("dialog", "alertdialog") for einfo in els),
        }
        if navigated:
            out["page_navigated"] = True
            out["important"] = "页面已跳转，之前的元素引用全部失效，请先 web_observe 再操作"
        return out
