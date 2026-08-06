/**
 * 点击展开型控件脚本库（选项控件 / 日历控件）
 *
 * 所有函数返回注入网页执行的 JS 脚本字符串，通过 viewExecuteJS 在对应侧 BrowserView 中运行。
 * 脚本均为自包含（内嵌辅助函数），异步脚本返回 Promise（Electron executeJavaScript 自动 await）。
 */
import type { CalendarControls, WidgetDef, WidgetOption } from "../types";

/** 清洗选择器：剔除拾取/高亮模式注入的 cinside-* 临时类 */
const sanitize = (sel: string): string =>
  (sel || "").replace(/\.cinside-[a-z0-9_-]+/gi, "");

/** 深度查询辅助（注入页面执行）：支持 ' >>> ' 分段穿透 shadowRoot / iframe contentDocument */
const DEEP_QUERY = `function __cinsideDeepQuery(sel) {
  if (!sel) return null;
  if (sel.indexOf('>>>') === -1) { try { return document.querySelector(sel); } catch (e) { return null; } }
  var segs = sel.split('>>>');
  var ctx = document;
  var el = null;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i].trim();
    if (!s) return null;
    try { el = ctx.querySelector(s); } catch (e) { return null; }
    if (!el) return null;
    if (i < segs.length - 1) {
      var next = null;
      try { if (el.shadowRoot) next = el.shadowRoot; } catch (e) {}
      if (!next) { try { if (el.contentDocument) next = el.contentDocument; } catch (e) {} }
      if (!next) return null;
      ctx = next;
    }
  }
  return el;
};`;

/** 脚本内公共辅助：可见性判断、真实点击序列、等待、选择器构建、文本归一化 */
const COMMON = `
  function __wsVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      return true;
    } catch (e) { return false; }
  }
  function __wsRealClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    var rect = null;
    try { rect = el.getBoundingClientRect(); } catch (e) {}
    var cx = rect ? Math.round(rect.left + rect.width / 2) : 0;
    var cy = rect ? Math.round(rect.top + rect.height / 2) : 0;
    var view = el.ownerDocument.defaultView || window;
    var opts = { bubbles: true, cancelable: true, view: view, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: 1, detail: 1 };
    var popts = { bubbles: true, cancelable: true, view: view, clientX: cx, clientY: cy, screenX: cx, screenY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    var topts = { bubbles: true, cancelable: true, view: view, clientX: cx, clientY: cy, screenX: cx, screenY: cy, touches: [{ identifier: 0, clientX: cx, clientY: cy, pageX: cx, pageY: cy }], targetTouches: [], changedTouches: [{ identifier: 0, clientX: cx, clientY: cy, pageX: cx, pageY: cy }] };
    try { el.dispatchEvent(new PointerEvent('pointerover', popts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseenter', opts)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerenter', popts)); } catch (e) {}
    try { el.dispatchEvent(new TouchEvent('touchstart', topts)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', popts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
    try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', popts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
    try { el.dispatchEvent(new TouchEvent('touchend', topts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerout', popts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseout', opts)); } catch (e) {}
    try { if (typeof el.click === 'function') el.click(); } catch (e) {}
  }
  function __wsWait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function __wsNorm(s) { return (s || '').replace(/[\\s ]+/g, '').toLowerCase(); }
  // 元素中心相对面板左上角的投影坐标（px）；miss 时返回当前面板 rect 供调用方自行计算
  function __wsProj(el, panel) {
    if (!el || !panel) return null;
    var r = el.getBoundingClientRect();
    var pr = panel.getBoundingClientRect();
    return { dx: Math.round(r.left + r.width / 2 - pr.left), dy: Math.round(r.top + r.height / 2 - pr.top) };
  }
  // 面板当前 rect 下，按投影坐标取该点处的可点击元素（对准位置点击）
  function __wsHitAt(panel, dx, dy) {
    if (!panel) return null;
    var pr = panel.getBoundingClientRect();
    var x = pr.left + (dx || 0), y = pr.top + (dy || 0);
    var el = null;
    try { el = panel.ownerDocument ? panel.ownerDocument.elementFromPoint(x, y) : document.elementFromPoint(x, y); } catch (e) { el = null; }
    return el;
  }
  // 同一文档树内构建选择器（id 短路 + 类名 + nth-of-type，向上最多 8 层，不跨 shadow）
  function __wsBuildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    var path = [];
    var cur = el;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
      if (cur.id) { path.unshift('#' + CSS.escape(cur.id)); break; }
      var part = cur.nodeName.toLowerCase();
      if (cur.className && typeof cur.className === 'string') {
        var cls = cur.className.trim().split(/\\s+/)
          .filter(function (c) { return c && c.indexOf('cinside') !== 0 && c.indexOf('is-') !== 0 && c.indexOf('active') !== 0 && c.indexOf('selected') !== 0 && c.indexOf('open') !== 0 && c.indexOf('show') !== 0; })
          .slice(0, 2).join('.');
        if (cls) part += '.' + cls;
      }
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.nodeName === cur.nodeName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      path.unshift(part);
      if (!parent) break;
      cur = parent;
      depth++;
    }
    return path.join(' > ');
  }
  // 面板内元素 → 全局选择器（面板选择器 + 相对路径），执行时用 deepQuery 直接定位
  function __wsChildSelector(panelSel, panel, el) {
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur !== panel && guard++ < 12) {
      var part = cur.nodeName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.nodeName === cur.nodeName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    if (cur !== panel) return '';
    return panelSel + (parts.length ? ' > ' + parts.join(' > ') : '');
  }
  // 弹出层特征
  var __WS_POPUP_RE = /dropdown|popup|popper|picker|panel|calendar|datepicker|date-picker|listbox|menu|overlay|select|options|autocomplete|combo|cascader|popover|drawer|select2|chosen|nice-select/i;
  function __wsPopupScore(el) {
    var score = 0;
    try {
      var cls = (el.className && typeof el.className === 'string') ? el.className : '';
      var role = (el.getAttribute && el.getAttribute('role')) || '';
      if (__WS_POPUP_RE.test(cls)) score += 3;
      if (/^(listbox|menu|dialog|grid|tree|tooltip)$/.test(role)) score += 3;
      var st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (st.position === 'absolute' || st.position === 'fixed') score += 2;
      var z = parseInt(st.zIndex || '0', 10);
      if (z >= 10) score += 1;
      if (z >= 100) score += 1;
    } catch (e) {}
    return score;
  }
  // 在若干文档根中查找当前可见的弹出层（执行期兜底用，无"新出现"判定）
  function __wsFindOpenPanel(roots) {
    var best = null;
    var bestScore = 0;
    var bestArea = 0;
    roots.forEach(function (root) {
      var all;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!__wsVisible(el)) continue;
        var score = __wsPopupScore(el);
        if (score < 3) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) continue;
        var area = r.width * r.height;
        // 跳过整屏容器
        var vw = (root.defaultView || window).innerWidth || 9999;
        var vh = (root.defaultView || window).innerHeight || 9999;
        if (area > vw * vh * 0.9) continue;
        if (score > bestScore || (score === bestScore && area > bestArea)) {
          best = el; bestScore = score; bestArea = area;
        }
      }
    });
    return best;
  }
  // 去掉嵌套候选：若候选被另一候选包含，丢弃内层（保留最外层面板）
  function __wsOutermost(cands) {
    var out = [];
    for (var i = 0; i < cands.length; i++) {
      var inner = false;
      for (var j = 0; j < cands.length; j++) {
        if (i !== j && cands[j].contains && cands[j].contains(cands[i])) { inner = true; break; }
      }
      if (!inner) out.push(cands[i]);
    }
    return out;
  }
  function __wsTriggerRoots(trigger) {
    var roots = [];
    try { var doc = trigger.ownerDocument || document; if (doc) roots.push(doc); } catch (e) {}
    try { var rn = trigger.getRootNode && trigger.getRootNode(); if (rn && rn.querySelectorAll && roots.indexOf(rn) === -1) roots.push(rn); } catch (e) {}
    if (!roots.length) roots.push(document);
    return roots;
  }
  // 关闭已展开的控件面板：Escape → 再点触发框 → 点页面空白
  function __wsClosePanel(trigger, panel) {
    var stillOpen = function () { return panel && __wsVisible(panel); };
    try {
      var doc = trigger.ownerDocument || document;
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      if (doc.activeElement) doc.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      if (doc.activeElement && typeof doc.activeElement.blur === 'function') doc.activeElement.blur();
    } catch (e) {}
    if (stillOpen()) { try { __wsRealClick(trigger); } catch (e) {} }
    if (stillOpen()) { try { var b = (trigger.ownerDocument || document).body; if (b) __wsRealClick(b); } catch (e) {} }
  }
  // 收集面板内的选项可点项（叶子级、可见、带文字）
  function __wsCollectOptionEls(panel) {
    var out = [];
    var seen = {};
    function push(el, text) {
      if (seen[text]) return;
      seen[text] = 1;
      out.push({ el: el, text: text });
    }
    // 优先：直接子元素行级收集（.select-dropdown > div / ul > li 等"每行一个选项"结构）
    // 覆盖候选选择器不含 <div> 的场景（最常见的自定义下拉）
    var kids = panel.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.nodeType !== 1) continue;
      if (!__wsVisible(el)) continue;
      var t = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (!t || t.length > 80) continue;
      push(el, t);
    }
    if (out.length >= 2) return out;
    // 兜底：语义选项选择器（叶子级），适配无语义行级 class 的结构
    out = []; seen = {};
    var SEL = '[role="option"],[role="menuitem"],[role="radio"],[role="button"],li,[class*="item"],[class*="option"],[class*="choice"],[class*="select"],a,button,label';
    var els;
    try { els = panel.querySelectorAll(SEL); } catch (e) { return out; }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!__wsVisible(el)) continue;
      // 只取叶子级：不包含其他候选子项
      try { if (el.querySelector(SEL)) continue; } catch (e) {}
      var text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (!text || text.length > 80) continue;
      push(el, text);
    }
    return out;
  }
  // 从年月文本中解析 {y, m}
  function __wsParseYearMonth(text) {
    var t = (text || '').trim();
    if (!t || t.length > 40) return null;
    var m = t.match(/(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月/);
    if (m) return { y: +m[1], m: +m[2] };
    m = t.match(/(\\d{4})\\s*[-\\/.]\\s*(\\d{1,2})(?!\\d)/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { y: +m[1], m: +m[2] };
    m = t.match(/(\\d{1,2})\\s*月\\s*(\\d{4})/);
    if (m) return { y: +m[2], m: +m[1] };
    var months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    m = t.match(/([A-Za-z]{3,9})[a-z]*\\s*,?\\s*(\\d{4})/);
    if (m) { var mon = months[m[1].slice(0,3).toLowerCase()]; if (mon) return { y: +m[2], m: mon }; }
    m = t.match(/(\\d{4})\\s*,?\\s*([A-Za-z]{3,9})/);
    if (m) { var mon2 = months[m[2].slice(0,3).toLowerCase()]; if (mon2) return { y: +m[1], m: mon2 }; }
    return null;
  }
  // 从月文本中解析月份数字（1-12）
  function __wsParseMonthOnly(text) {
    var t = (text || '').trim();
    var m = t.match(/^(\\d{1,2})\\s*月?$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return +m[1];
    var months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    m = t.match(/^([A-Za-z]{3,9})/);
    if (m) { var mon = months[m[1].slice(0,3).toLowerCase()]; if (mon) return mon; }
    return 0;
  }
  // 日历结构探测：找含「年月文本 + ≥7 个日格子」的最小可见容器。
  // 不要求文本导航字符（兼容 SVG 图标翻页的日历），覆盖 portal 渲染到 body 底部、内联常驻日历等场景。
  function __wsFindCalendarPanel(roots, trigger) {
    var DAY_RE = /^([1-9]|[12]\\d|3[01])$/;
    function isDayCell(el) {
      var t = (el.textContent || '').trim();
      if (!DAY_RE.test(t)) return false;
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) {
        if ((kids[i].textContent || '').trim() === t) return false; // 有更深层同文本节点，取叶子
      }
      return true;
    }
    function countDays(container, limit) {
      var n = 0;
      var all;
      try { all = container.querySelectorAll('td,li,span,div,a,button,[role="gridcell"],[class*="day"],[class*="date"],[class*="cell"]'); } catch (e) { return 0; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!__wsVisible(el)) continue;
        if (isDayCell(el)) { n++; if (n >= limit) return n; }
      }
      return n;
    }
    var best = null, bestScore = -1;
    var tr = null;
    try { tr = trigger ? trigger.getBoundingClientRect() : null; } catch (e) { tr = null; }
    var tcx = tr ? tr.left + tr.width / 2 : 0, tcy = tr ? tr.top + tr.height / 2 : 0;
    var seen = [];
    for (var ri = 0; ri < roots.length; ri++) {
      var all;
      try { all = roots[ri].querySelectorAll('*'); } catch (e) { continue; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!__wsVisible(el)) continue;
        var t = (el.textContent || '').trim();
        if (!t || t.length > 40) continue;
        if (!__wsParseYearMonth(t)) continue;
        // 从年月文本向上找含日格子的最小容器
        var cur = el;
        var guard = 0;
        var found = null;
        while (cur && guard++ < 6) {
          if (seen.indexOf(cur) !== -1) break; // 该容器已评过
          var r = null;
          try { r = cur.getBoundingClientRect(); } catch (e) { r = null; }
          if (r && r.width >= 120 && r.height >= 100 && countDays(cur, 7) >= 7) { found = cur; break; }
          cur = cur.parentElement;
        }
        if (!found || seen.indexOf(found) !== -1) continue;
        seen.push(found);
        // 评分：面积小（更具体）+ 离触发框近
        var fr = found.getBoundingClientRect();
        var area = fr.width * fr.height;
        var fcx = fr.left + fr.width / 2, fcy = fr.top + fr.height / 2;
        var dist = Math.sqrt((fcx - tcx) * (fcx - tcx) + (fcy - tcy) * (fcy - tcy));
        var score = 1000000 / (1 + area / 10000) + 2000000 / (1 + dist);
        if (score > bestScore) { best = found; bestScore = score; }
      }
    }
    return best;
  }
`;

/** 打开控件面板（点击触发框，不关闭）。角色重选时先执行它再进入拾取模式 */
export function buildWidgetOpenScript(triggerSelector: string): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    // 清掉拾取器吞点击标记：程序化 __wsRealClick 不能被拾取器误吞
    try { window.__cinsideJustPicked = false; } catch (e) {}
    var trigger = null;
    try { trigger = __cinsideDeepQuery(${JSON.stringify(sanitize(triggerSelector))}); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false, reason: 'trigger_not_found' };
    __wsRealClick(trigger);
    return { ok: true };
  })();`;
}

/** 智能打开控件面板：仅在面板未打开时点击触发框（避免已打开被点关）。引导式拾取推进时用 */
export function buildWidgetEnsureOpenScript(triggerSelector: string, panelSelector?: string): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (async function () {
    try { window.__cinsideJustPicked = false; } catch (e) {}
    var trigger = null;
    try { trigger = __cinsideDeepQuery(${JSON.stringify(sanitize(triggerSelector))}); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false, reason: 'trigger_not_found' };
    var panel = null;
    var ps = ${JSON.stringify(sanitize(panelSelector || ""))};
    if (ps) { try { panel = __cinsideDeepQuery(ps); } catch (e) { panel = null; } }
    if (!panel || !__wsVisible(panel)) {
      panel = __wsFindOpenPanel(__wsTriggerRoots(trigger));
      if (panel && (panel === trigger || (panel.contains && panel.contains(trigger)))) panel = null;
    }
    if (!panel || !__wsVisible(panel)) {
      // 日历结构兜底：低 popup 评分/portal 渲染的日历面板
      var cp = __wsFindCalendarPanel(__wsTriggerRoots(trigger), trigger);
      if (cp) panel = cp;
    }
    if (panel && __wsVisible(panel)) return { ok: true, opened: false };
    __wsRealClick(trigger);
    var deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (ps) { try { panel = __cinsideDeepQuery(ps); } catch (e) { panel = null; } }
      if (panel && __wsVisible(panel)) return { ok: true, opened: true };
      panel = __wsFindOpenPanel(__wsTriggerRoots(trigger));
      if (panel && panel !== trigger && !(panel.contains && panel.contains(trigger)) && __wsVisible(panel)) return { ok: true, opened: true };
      panel = __wsFindCalendarPanel(__wsTriggerRoots(trigger), trigger);
      if (panel && __wsVisible(panel)) return { ok: true, opened: true };
      await __wsWait(150);
    }
    return { ok: false, reason: 'panel_not_open' };
  })();`;
}

/** 日格子种子收集脚本：用户拾取日格子（可多选）并泛化后，用公共选择器收集面板内所有日格子的文本+投影坐标 */
export function buildDayCellCollectScript(panelSelector: string, dayCellSelectors: string[]): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    var panel = null;
    try { panel = __cinsideDeepQuery(${JSON.stringify(sanitize(panelSelector))}); } catch (e) { panel = null; }
    if (!panel) return { ok: false, reason: 'panel_not_found' };
    var ps = ${JSON.stringify(sanitize(panelSelector))};
    var fullList = ${JSON.stringify(dayCellSelectors.map((s) => sanitize(s)))};
    // 去掉面板前缀，得到面板内相对选择器（多选种子时逐个剥离，再合并为并集选择器）
    var relParts = [];
    for (var fi = 0; fi < fullList.length; fi++) {
      var fs = (fullList[fi] || '').trim();
      if (!fs) continue;
      if (ps && fs.indexOf(ps) === 0) fs = fs.slice(ps.length).replace(/^\s*>\s*/, '').trim();
      if (fs && relParts.indexOf(fs) === -1) relParts.push(fs);
    }
    var rel = relParts.join(', ');
    var cells = [];
    if (rel) { try { var list = panel.querySelectorAll(rel); for (var i = 0; i < list.length; i++) cells.push(list[i]); } catch (e) {} }
    if (!cells.length) {
      // 退化：取第一个种子选择器最后一段的 tag 名兜底
      var tagMatch = (relParts[0] || '').match(/([a-zA-Z][\\w-]*)$/);
      if (tagMatch) { try { var tl = panel.getElementsByTagName(tagMatch[1]); for (var j = 0; j < tl.length; j++) cells.push(tl[j]); } catch (e) {} }
    }
    var dayCells = [];
    for (var k = 0; k < cells.length; k++) {
      var c = cells[k];
      if (!__wsVisible(c)) continue;
      var t = (c.textContent || '').trim();
      if (!/^([1-9]|[12]\\d|3[01])$/.test(t)) continue;
      var proj = __wsProj(c, panel);
      if (proj) dayCells.push({ text: t, dx: proj.dx, dy: proj.dy });
    }
    return { ok: true, dayCells: dayCells, count: dayCells.length };
  })();`;
}

/**
 * 手动面板点选兜底：用户点选日历面板内任意元素（如某个日格子/年月区），
 * 从该种子元素向上找「含年月文本 + ≥7 日格子」的容器作为面板；找不到则用种子本身。
 * 返回 { ok, panelSelector, upgraded }（upgraded=true 表示已从种子向上找到了真正的面板容器）
 */
export function buildCalendarPanelFromSeedScript(seedSelector: string): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    var seed = null;
    try { seed = __cinsideDeepQuery(${JSON.stringify(sanitize(seedSelector))}); } catch (e) { seed = null; }
    if (!seed) return { ok: false, reason: 'seed_not_found' };
    // 从种子向上找日历容器（年月文本 + ≥7 日格子）
    var DAY_RE = /^([1-9]|[12]\\d|3[01])$/;
    function isDayCell(el) {
      var t = (el.textContent || '').trim();
      if (!DAY_RE.test(t)) return false;
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) {
        if ((kids[i].textContent || '').trim() === t) return false;
      }
      return true;
    }
    function countDays(container, limit) {
      var n = 0;
      var all;
      try { all = container.querySelectorAll('td,li,span,div,a,button,[role="gridcell"],[class*="day"],[class*="date"],[class*="cell"]'); } catch (e) { return 0; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!__wsVisible(el)) continue;
        if (isDayCell(el)) { n++; if (n >= limit) return n; }
      }
      return n;
    }
    function hasYM(container) {
      var all;
      try { all = container.querySelectorAll('*'); } catch (e) { return false; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!__wsVisible(el)) continue;
        var t = (el.textContent || '').trim();
        if (t && t.length <= 40 && __wsParseYearMonth(t)) return true;
      }
      return false;
    }
    var cur = seed;
    var guard = 0;
    var found = null;
    while (cur && guard++ < 8) {
      var r = null;
      try { r = cur.getBoundingClientRect(); } catch (e) { r = null; }
      // 日历容器特征：足够大 + ≥7 个日格子（年月文本作为加分项而非硬性条件，兼容年月分开放置的日历）
      if (r && r.width >= 120 && r.height >= 100 && countDays(cur, 7) >= 7) { found = cur; break; }
      cur = cur.parentElement;
    }
    if (!found) {
      // 种子本身也不是日历的一部分（里面连日格子都没有）→ 判定用户点错位置
      var seedDays = 0;
      try { seedDays = countDays(seed, 3); } catch (e) { seedDays = 0; }
      if (seedDays < 1) return { ok: false, reason: 'not_calendar' };
    }
    var panel = found || seed;
    var sel = __wsBuildSelector(panel);
    if (!sel) return { ok: false, reason: 'selector_build_fail' };
    return { ok: true, panelSelector: sel, upgraded: !!found };
  })();`;
}

/**
 * 选项控件手动面板兜底：从用户点选的种子元素（下拉面板内的选项/区域）识别选项面板容器，
 * 收集面板内所有选项（镜像下拉的每一行）。用于自动快照未能检测到面板（程序化点击未展开 / 面板无 popup 特征）的场景。
 * 返回 { ok, panelSelector, options } 或 { ok: false, reason }
 */
export function buildOptionPanelFromSeedScript(seedSelector: string, triggerSelector: string): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    var seed = null;
    try { seed = __cinsideDeepQuery(${JSON.stringify(sanitize(seedSelector))}); } catch (e) { seed = null; }
    if (!seed) return { ok: false, reason: 'seed_not_found' };

    // 收集容器内的选项行：优先按"同辈兄弟行"（每个可见、有短文本的直接子元素=一行选项）
    // 这贴合"每一行一个选项"的下拉结构（.select-dropdown > div / ul > li），避免把多行合并成一个选项
    function collectOptions(container) {
      var out = [];
      var seen = {};
      function push(el, text) {
        if (seen[text]) return;
        seen[text] = 1;
        out.push({ el: el, text: text });
      }
      // 策略1：直接子元素（行级）
      var kids = container.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (el.nodeType !== 1) continue;
        if (!__wsVisible(el)) continue;
        var t = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
        if (!t || t.length > 80) continue;
        push(el, t);
      }
      if (out.length >= 2) return out;
      // 策略2：语义选项选择器（叶子级，兜底无统一行级 class 的结构）
      out = []; seen = {};
      var SEL_STD = '[role="option"],[role="menuitem"],[role="radio"],[role="button"],li,[class*="item"],[class*="option"],[class*="choice"],[class*="select"],a,button,label';
      var els;
      try { els = container.querySelectorAll(SEL_STD); } catch (e) { els = []; }
      for (var j = 0; j < els.length; j++) {
        var el2 = els[j];
        if (!__wsVisible(el2)) continue;
        try { if (el2.querySelector(SEL_STD)) continue; } catch (e) {}
        var t2 = (el2.innerText || el2.textContent || '').trim().replace(/\\s+/g, ' ');
        if (!t2 || t2.length > 80) continue;
        push(el2, t2);
      }
      return out;
    }

    // 1) 种子 → 选项行：种子本身可能是某一行的内部元素，或面板空白处。
    //    先找种子的"行元素"（与兄弟元素同结构、有短文本的可见元素），行元素=面板内一个选项。
    function findOptionRow(el) {
      // 种子自身及其祖先（最多向上 4 层），找第一个"有兄弟行"的元素作为行
      var cur = el;
      var guard = 0;
      while (cur && cur.parentElement && guard++ < 4) {
        var p = cur.parentElement;
        // 父级有 ≥2 个"同标签、有短文本"的可见子元素 → cur 是其中一行
        var kids = p.children;
        var sameTag = 0;
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          if (k.nodeType !== 1 || !__wsVisible(k)) continue;
          if (k.nodeName !== cur.nodeName) continue;
          var kt = (k.innerText || k.textContent || '').trim().replace(/\\s+/g, ' ');
          if (kt && kt.length <= 80) sameTag++;
        }
        if (sameTag >= 2) return cur;
        cur = p;
      }
      return null;
    }

    // 2) 面板识别：优先取"行元素的父级"（最贴近的选项列表容器），否则向上找含 ≥2 行的容器
    var row = findOptionRow(seed);
    var panel = null;
    if (row && row.parentElement && collectOptions(row.parentElement).length >= 2) {
      panel = row.parentElement;
    } else {
      var cur2 = seed;
      var guard2 = 0;
      while (cur2 && guard2++ < 8) {
        if (collectOptions(cur2).length >= 2) { panel = cur2; break; }
        cur2 = cur2.parentElement;
      }
    }
    if (!panel) return { ok: false, reason: 'not_option_panel' };

    var panelSel = __wsBuildSelector(panel);
    if (!panelSel) panelSel = 'body';

    // 3) 镜像面板内所有行 → options（选择器为面板相对路径，执行时用 deepQuery 直接定位）
    var finalItems = collectOptions(panel);
    var options = [];
    for (var i = 0; i < finalItems.length && i < 100; i++) {
      var csel = __wsChildSelector(panelSel, panel, finalItems[i].el);
      options.push({ text: finalItems[i].text, selector: csel || '' });
    }
    if (options.length < 1) return { ok: false, reason: 'options_empty' };

    // 不自动关闭面板：用户手动点开的下拉保持打开，便于对照确认每行选项是否正确
    return { ok: true, panelSelector: panelSel, options: options };
  })();`;
}

/** 关闭控件面板 */
export function buildWidgetCloseScript(triggerSelector: string, panelSelector?: string): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    var trigger = null;
    try { trigger = __cinsideDeepQuery(${JSON.stringify(sanitize(triggerSelector))}); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false };
    var panel = null;
    var ps = ${JSON.stringify(sanitize(panelSelector || ""))};
    if (ps) { try { panel = __cinsideDeepQuery(ps); } catch (e) { panel = null; } }
    __wsClosePanel(trigger, panel);
    return { ok: true };
  })();`;
}

/**
 * 控件快照脚本：点击触发框 → 等待展开 → 识别面板结构（选项列表 / 日历角色）→ 关闭面板
 * 返回 { ok, panelSelector, options?, calendar?, detected?, reason? }
 */
export function buildWidgetSnapshotScript(triggerSelector: string, kind: "option" | "calendar"): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (async function () {
    // 快照脚本自身的点击是程序化触发（用于展开面板），不能被拾取器吞掉：
    // 拾取完成后 __cinsideJustPicked 会短暂为 true，若不重置，紧随其后的 __wsRealClick 会被吞掉，
    // 导致下拉/日历刚展开又被关闭，快照永远找不到面板。这里先清掉该标记。
    try { window.__cinsideJustPicked = false; } catch (e) {}
    var trigger = null;
    try { trigger = __cinsideDeepQuery(${JSON.stringify(sanitize(triggerSelector))}); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false, reason: 'trigger_not_found' };
    var roots = __wsTriggerRoots(trigger);

    // 1) 标记现状元素 + 记录当前可见性
    var marked = [];
    roots.forEach(function (root) {
      var all;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        try {
          el.setAttribute('data-cinside-ws-old', '1');
          if (__wsVisible(el)) el.setAttribute('data-cinside-ws-vis', '1');
          marked.push(el);
        } catch (e) {}
      }
    });

    // 2) 点击触发框，轮询等待面板展开（日历/下拉常有展开动画，最长约 3.5s）
    __wsRealClick(trigger);
    var panel = null;
    var pollDeadline = Date.now() + 3500;
    while (Date.now() < pollDeadline) {
      // 找新出现 / 新变为可见的弹出层候选
      var cands = [];
      roots.forEach(function (root) {
        var all;
        try { all = root.querySelectorAll('*'); } catch (e) { return; }
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var isNew = !el.hasAttribute('data-cinside-ws-old');
          var newlyVisible = el.hasAttribute('data-cinside-ws-old') && !el.hasAttribute('data-cinside-ws-vis');
          if (!isNew && !newlyVisible) continue;
          if (!__wsVisible(el)) continue;
          var score = __wsPopupScore(el);
          if (score < 3) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 20) continue;
          cands.push(el);
        }
      });
      cands = __wsOutermost(cands);
      // 评分排序： popup 特征分高优先，面积大优先
      cands.sort(function (a, b) {
        var d = __wsPopupScore(b) - __wsPopupScore(a);
        if (d) return d;
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      });
      if (cands.length) { panel = cands[0]; break; }
      // 兜底：未检测到"新出现"的面板时，找当前可见弹出层（排除触发框祖先链）
      var fp = __wsFindOpenPanel(roots);
      if (fp && !(fp === trigger || (fp.contains && fp.contains(trigger)))) { panel = fp; break; }
      await __wsWait(150);
    }

    // 日历的特殊处理：即使没找到"弹出层"，也按日历结构找面板（年月文本 + ≥7 日格子）。
    // 覆盖：portal 渲染到 body 底部、内联常驻日历、SVG 图标翻页（无文本导航字符）等场景。
    if (!panel && ${JSON.stringify(kind)} === 'calendar') {
      panel = __wsFindCalendarPanel(roots, trigger);
    }

    var cleanup = function () {
      for (var i = 0; i < marked.length; i++) {
        try { marked[i].removeAttribute('data-cinside-ws-old'); marked[i].removeAttribute('data-cinside-ws-vis'); } catch (e) {}
      }
    };

    if (!panel) {
      cleanup();
      return { ok: false, reason: 'panel_not_found' };
    }
    var panelSel = __wsBuildSelector(panel);
    if (!panelSel) panelSel = 'body';

    var result = { ok: true, kind: ${JSON.stringify(kind)}, panelSelector: panelSel };
    if (${JSON.stringify(kind)} === 'option') {
      var items = __wsCollectOptionEls(panel);
      var options = [];
      for (var i = 0; i < items.length && i < 100; i++) {
        var csel = __wsChildSelector(panelSel, panel, items[i].el);
        options.push({ text: items[i].text, selector: csel || '' });
      }
      result.options = options;
      if (!options.length) {
        __wsClosePanel(trigger, panel);
        cleanup();
        return { ok: false, reason: 'options_empty' };
      }
      // 选项控件：快照后关闭面板
      __wsClosePanel(trigger, panel);
    } else {
      // 日历控件：引导式手动拾取，不自动识别角色；面板保持打开供用户继续拾取各按钮
      result.calendar = {};
    }

    await __wsWait(200);
    cleanup();
    return result;
  })();`;
}

/**
 * 选项控件选择脚本：展开面板 → 按 别名精确 → 文本精确 → 智能包含 匹配目标值 → 点击
 * 返回 { ok, clickedText?, reason?, options? }
 */
export function buildOptionSelectScript(widget: WidgetDef, targetValue: string): string {
  const w = {
    triggerSelector: sanitize(widget.triggerSelector),
    panelSelector: sanitize(widget.panelSelector || ""),
    options: (widget.options || []).map((o) => ({
      text: o.text,
      selector: sanitize(o.selector),
      alias: o.alias || "",
    })),
  };
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (async function () {
    // 清掉拾取器吞点击标记：测试/执行时此处的 __wsRealClick 是程序化触发，
    // 若上一帧拾取刚完成（__cinsideJustPicked=true），click 会被吞掉导致面板无法展开。
    try { window.__cinsideJustPicked = false; } catch (e) {}
    var W = ${JSON.stringify(w)};
    var TARGET = ${JSON.stringify(targetValue)};
    var trigger = null;
    try { trigger = __cinsideDeepQuery(W.triggerSelector); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false, reason: 'trigger_not_found' };

    function optFindPanel() {
      var p = null;
      if (W.panelSelector) { try { p = __cinsideDeepQuery(W.panelSelector); } catch (e) { p = null; } }
      if (p && __wsVisible(p)) return p;
      p = __wsFindOpenPanel(__wsTriggerRoots(trigger));
      if (p && (p === trigger || p.contains(trigger))) p = null;
      return p && __wsVisible(p) ? p : null;
    }

    // 多策略打开选项面板
    var panel = null;
    __wsRealClick(trigger);
    var od = Date.now() + 2000;
    while (Date.now() < od) { panel = optFindPanel(); if (panel) break; await __wsWait(150); }
    if (!panel) {
      try { if (typeof trigger.focus === 'function') trigger.focus({ preventScroll: false }); } catch(e) {}
      await __wsWait(80);
      __wsRealClick(trigger);
      od = Date.now() + 2000;
      while (Date.now() < od) { panel = optFindPanel(); if (panel) break; await __wsWait(150); }
    }
    if (!panel) return { ok: false, reason: 'panel_not_open' };

    // 收集候选项：优先用存储的选择器，失效则按文字重新收集
    var items = [];
    if (W.options && W.options.length) {
      for (var i = 0; i < W.options.length; i++) {
        var o = W.options[i];
        var el = null;
        if (o.selector) { try { el = __cinsideDeepQuery(o.selector); } catch (e) { el = null; } }
        if (el && __wsVisible(el)) items.push({ el: el, text: o.text, alias: o.alias || '' });
      }
    }
    if (!items.length) {
      var els = __wsCollectOptionEls(panel);
      for (var j = 0; j < els.length; j++) {
        // 重新收集时仍尝试套用已存别名（按文字对应）
        var alias = '';
        if (W.options) {
          for (var k = 0; k < W.options.length; k++) {
            if (W.options[k].text === els[j].text && W.options[k].alias) { alias = W.options[k].alias; break; }
          }
        }
        items.push({ el: els[j].el, text: els[j].text, alias: alias });
      }
    }
    if (!items.length) { __wsClosePanel(trigger, panel); return { ok: false, reason: 'options_empty' }; }

    var tn = __wsNorm(TARGET);
    var best = null;
    var i2;
    // 别名展开：斜杠分隔多个触发词（如 FEMALE/F/woman），任一精确命中即匹配
    function aliasWords(a) { return (a || '').split('/').map(function (x) { return __wsNorm(x); }).filter(function (x) { return !!x; }); }
    // 1) 别名精确
    for (i2 = 0; i2 < items.length; i2++) {
      var aw = aliasWords(items[i2].alias);
      for (var ai = 0; ai < aw.length; ai++) { if (aw[ai] === tn) { best = items[i2]; break; } }
      if (best) break;
    }
    // 2) 文本精确
    if (!best) { for (i2 = 0; i2 < items.length; i2++) { if (__wsNorm(items[i2].text) === tn) { best = items[i2]; break; } } }
    // 3) 智能包含（目标长度>=2，避免单字误匹配）
    if (!best && tn.length >= 2) {
      for (i2 = 0; i2 < items.length; i2++) {
        var on = __wsNorm(items[i2].text);
        if (on && (on.indexOf(tn) >= 0 || tn.indexOf(on) >= 0)) { best = items[i2]; break; }
      }
    }
    if (!best) {
      var avail = [];
      for (i2 = 0; i2 < items.length; i2++) avail.push(items[i2].text);
      __wsClosePanel(trigger, panel);
      return { ok: false, reason: 'no_match', options: avail };
    }
    __wsRealClick(best.el);
    await __wsWait(280);
    return { ok: true, clickedText: best.text };
  })();`;
}

/**
 * 日历控件设定脚本：展开日历 → 读取当前年月 → 翻页到目标年月 → 点击目标日
 * 返回 { ok, value?, log?, reason? }
 */
export function buildCalendarSetScript(widget: WidgetDef, y: number, m: number, d: number): string {
  const cal: CalendarControls = widget.calendar || {};
  const w = {
    triggerSelector: sanitize(widget.triggerSelector),
    calendar: {
      panelSelector: sanitize(cal.panelSelector || ""),
      headerSelector: sanitize(cal.headerSelector || ""),
      yearSelector: sanitize(cal.yearSelector || ""),
      monthSelector: sanitize(cal.monthSelector || ""),
      prevYearSelector: sanitize(cal.prevYearSelector || ""),
      nextYearSelector: sanitize(cal.nextYearSelector || ""),
      prevMonthSelector: sanitize(cal.prevMonthSelector || ""),
      nextMonthSelector: sanitize(cal.nextMonthSelector || ""),
      dayCellSelector: sanitize(cal.dayCellSelector || ""),
      headerRect: cal.headerRect || null,
      yearRect: cal.yearRect || null,
      monthRect: cal.monthRect || null,
      prevYearRect: cal.prevYearRect || null,
      nextYearRect: cal.nextYearRect || null,
      prevMonthRect: cal.prevMonthRect || null,
      nextMonthRect: cal.nextMonthRect || null,
      dayCells: cal.dayCells || [],
    },
  };
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (async function () {
    // 清掉拾取器吞点击标记：测试/执行时此处的 __wsRealClick 是程序化触发，
    // 若上一帧拾取刚完成（__cinsideJustPicked=true），click 会被吞掉导致日历无法展开。
    try { window.__cinsideJustPicked = false; } catch (e) {}
    var W = ${JSON.stringify(w)};
    var TY = ${y | 0}, TM = ${m | 0}, TD = ${d | 0};
    var log = [];
    var trigger = null;
    try { trigger = __cinsideDeepQuery(W.triggerSelector); } catch (e) { trigger = null; }
    if (!trigger) { log.push('[calSet] 触发框未找到'); return { ok: false, reason: 'trigger_not_found', log: log }; }

    // 坐标兜底：如果选择器点击失败，记录触发框坐标，用 elementFromPoint 找真实元素再点击
    var triggerRect = null;
    try {
      var r = trigger.getBoundingClientRect();
      triggerRect = { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
      log.push('[calSet] 触发框坐标=' + JSON.stringify(triggerRect));
    } catch (e) { log.push('[calSet] 获取触发框坐标失败'); }

    // 尝试在 body 范围内找日历结构（含已标记选择器和自动扫描）
    function tryFindPanel() {
      var p = null;
      // 1) 优先使用已保存的 panelSelector
      if (W.calendar.panelSelector) { try { p = __cinsideDeepQuery(W.calendar.panelSelector); } catch (e) { p = null; } }
      if (p && __wsVisible(p)) return p;
      // 2) 通用弹出层扫描
      p = __wsFindOpenPanel(__wsTriggerRoots(trigger));
      if (p && (p === trigger || (p.contains && p.contains(trigger)))) p = null;
      if (p && __wsVisible(p)) return p;
      // 3) 日历结构探测：年月文本 + ≥7 日格子（不要求文本导航字符，覆盖 portal/SVG 翻页日历）
      p = __wsFindCalendarPanel(__wsTriggerRoots(trigger), trigger);
      if (p && __wsVisible(p)) return p;
      return null;
    }

    // 多策略打开日历面板
    var panel = null;
    var deadline = 0;

    // 前置点击步骤可能已把日历打开：直接使用，避免重复点击把已开面板点关
    panel = tryFindPanel();
    if (panel) log.push('[calSet] 面板已打开（前置点击步骤），跳过触发框点击');

    // 策略1: 标准点击
    if (!panel) {
      log.push('[calSet] 尝试打开策略: click');
      __wsRealClick(trigger);
      deadline = Date.now() + 2000;
      while (Date.now() < deadline) { panel = tryFindPanel(); if (panel) break; await __wsWait(150); }
    }

    // 策略2: focus + 等待 + 点击
    if (!panel) {
      log.push('[calSet] 尝试打开策略: focus+click');
      try { if (typeof trigger.focus === 'function') trigger.focus({ preventScroll: false }); } catch(e) {}
      await __wsWait(80);
      __wsRealClick(trigger);
      deadline = Date.now() + 2000;
      while (Date.now() < deadline) { panel = tryFindPanel(); if (panel) break; await __wsWait(150); }
    }

    // 策略3: 临时移除 readonly + focus + 点击
    if (!panel) {
      log.push('[calSet] 尝试打开策略: readonly-remove+click');
      var wasReadonly = trigger.getAttribute && trigger.getAttribute('readonly') !== null;
      var wasDisabled = trigger.disabled === true;      if (wasReadonly) try { trigger.removeAttribute('readonly'); } catch(e) {}
      if (wasDisabled) try { trigger.disabled = false; } catch(e) {}
      try { if (typeof trigger.focus === 'function') trigger.focus({ preventScroll: false }); } catch(e) {}
      await __wsWait(80);
      __wsRealClick(trigger);
      if (wasReadonly) try { trigger.setAttribute('readonly', 'readonly'); } catch(e) {}
      if (wasDisabled) try { trigger.disabled = true; } catch(e) {}
      deadline = Date.now() + 2000;
      while (Date.now() < deadline) { panel = tryFindPanel(); if (panel) break; await __wsWait(150); }
    }

    // 策略4: mousedown → 延迟 → mouseup + click（模拟按住再松开）
    if (!panel) {
      log.push('[calSet] 尝试打开策略: down+delay+up');
      var view4 = trigger.ownerDocument.defaultView || window;
      var r4 = trigger.getBoundingClientRect();
      var cx4 = Math.round(r4.left + r4.width/2), cy4 = Math.round(r4.top + r4.height/2);
      var mopts4 = { bubbles: true, cancelable: true, view: view4, clientX: cx4, clientY: cy4, button: 0, buttons: 1 };
      try { trigger.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch(e) {}
      try { trigger.dispatchEvent(new MouseEvent('mousedown', mopts4)); } catch(e) {}
      try { if (typeof trigger.focus === 'function') trigger.focus({ preventScroll: false }); } catch(e) {}
      await __wsWait(120);
      try { trigger.dispatchEvent(new MouseEvent('mouseup', mopts4)); } catch(e) {}
      try { trigger.dispatchEvent(new MouseEvent('click', mopts4)); } catch(e) {}
      try { if (typeof trigger.click === 'function') trigger.click(); } catch(e) {}
      deadline = Date.now() + 2000;
      while (Date.now() < deadline) { panel = tryFindPanel(); if (panel) break; await __wsWait(150); }
    }

    // 策略5: 键盘事件触发（Enter / Space / ArrowDown）
    if (!panel) {
      log.push('[calSet] 尝试打开策略: keyboard');
      try { if (typeof trigger.focus === 'function') trigger.focus({ preventScroll: false }); } catch(e) {}
      await __wsWait(50);
      var doc5 = trigger.ownerDocument || document;
      var kcodes = [
        { key: 'ArrowDown', keyCode: 40 },
        { key: 'Enter', keyCode: 13 },
        { key: ' ', keyCode: 32 },
      ];
      for (var ki = 0; ki < kcodes.length; ki++) {
        var kc = kcodes[ki];
        try { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: kc.key, keyCode: kc.keyCode, bubbles: true, cancelable: true })); } catch(e) {}
        await __wsWait(50);
        try { trigger.dispatchEvent(new KeyboardEvent('keyup', { key: kc.key, keyCode: kc.keyCode, bubbles: true, cancelable: true })); } catch(e) {}
        await __wsWait(200);
        panel = tryFindPanel();
        if (panel) break;
      }
      if (!panel) {
        deadline = Date.now() + 1000;
        while (Date.now() < deadline) { panel = tryFindPanel(); if (panel) break; await __wsWait(150); }
      }
    }

    // 策略6: 坐标兜底点击（用 elementFromPoint 找到触发框坐标的真实元素）
    if (!panel && triggerRect) {
      log.push('[calSet] 尝试打开策略: coord-fallback, 坐标=' + JSON.stringify(triggerRect));
      try {
        var doc6 = trigger.ownerDocument || document;
        var hitEl = doc6.elementFromPoint(triggerRect.x, triggerRect.y);
        if (hitEl && hitEl !== trigger) {
          log.push('[calSet] elementFromPoint 找到不同元素=' + (hitEl.tagName + (hitEl.className ? '.' + hitEl.className.split(' ')[0] : '')));
          __wsRealClick(hitEl);
          deadline = Date.now() + 2000;
          while (Date.now() < deadline) { panel = tryFindPanel(); if (panel) break; await __wsWait(150); }
        } else {
          log.push('[calSet] elementFromPoint 找到相同元素或null');
        }
      } catch (e) { log.push('[calSet] 坐标兜底点击异常=' + e.message); }
    }

    if (panel) log.push('[calSet] 面板打开成功');
    if (!panel) { log.push('[calSet] 面板未打开（所有策略均失败）'); return { ok: false, reason: 'panel_not_open', log: log }; }
    log.push('[calSet] 面板已打开, 目标=' + TY + '-' + TM + '-' + TD);
    var panelSel = W.calendar.panelSelector || __wsBuildSelector(panel) || 'body';

    function q(sel) {
      if (!sel) return null;
      var el = null;
      // 如果已经有面板元素，直接在面板内查找相对路径更稳定（用户手动标记的元素肯定在面板里）
      // 用正则完整去掉面板前缀，匹配任意开头空白
      if (panel) {
        try {
          var panelPrefixRegex = new RegExp('^' + panelSel.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*');
          var relSel = sel.replace(panelPrefixRegex, '');
          if (relSel) {
            el = panel.querySelector(relSel);
            if (el) return el;
          }
        } catch (e) {}
      }
      // 完整路径全局查找兜底
      try { el = __cinsideDeepQuery(sel); } catch (e) { el = null; }
      if (el) return el;
      // 面板选择器可能漂移：退化到面板内相对查找（旧方式）
      try { el = panel.querySelector(sel.replace(panelSel + ' > ', '').replace(panelSel + ' ', '')); } catch (e) { el = null; }
      return el;
    }
    // 读取当前显示的年月
    function readCur() {
      var h = q(W.calendar.headerSelector);
      if (h) {
        var ym = __wsParseYearMonth((h.textContent || '').trim());
        if (ym) return ym;
      }
      // 选择器失效时按投影坐标取 header 元素读文本
      if (!h && W.calendar.headerRect) {
        var hh = __wsHitAt(panel, W.calendar.headerRect.dx, W.calendar.headerRect.dy);
        if (hh) { var ymh = __wsParseYearMonth((hh.textContent || '').trim()); if (ymh) return ymh; }
      }
      var y = 0, mo = 0;
      var ye = q(W.calendar.yearSelector);
      var me = q(W.calendar.monthSelector);
      if (ye) { var ym2 = (ye.textContent || '').match(/(\\d{4})/); if (ym2) y = +ym2[1]; }
      if (me) { mo = __wsParseMonthOnly((me.textContent || '').trim()); }
      if (y && mo) return { y: y, m: mo };
      return null;
    }
    // 从 .cal-head 固定结构精确定位翻页按钮。
    // 注意 .cal-head 直接子元素含 span.title，需先过滤出纯 button，顺序为 [«,‹,›,»]。
    function navBtn(role) {
      var head = null;
      try { head = panel.querySelector('.cal-head'); } catch (e) {}
      if (!head) return null;
      var btns = [];
      for (var i = 0; i < head.children.length; i++) {
        var c = head.children[i];
        if (c.tagName === 'BUTTON') btns.push(c);
      }
      var idx = role === 'prevYear' ? 0 : role === 'prevMonth' ? 1 : role === 'nextMonth' ? 2 : role === 'nextYear' ? 3 : -1;
      if (idx >= 0 && btns[idx] && __wsVisible(btns[idx])) return btns[idx];
      // 兜底：按 title 属性匹配（上一年/上一月/下一月/下一年）
      var titleMap = { prevYear: '上一年', prevMonth: '上一月', nextMonth: '下一月', nextYear: '下一年' };
      var want = titleMap[role];
      for (var j = 0; j < btns.length; j++) {
        if (btns[j].getAttribute && btns[j].getAttribute('title') === want && __wsVisible(btns[j])) return btns[j];
      }
      return null;
    }
    // 点翻页按钮：结构定位优先（最稳）→ 保存的选择器 → 坐标兜底
    function clickNav(role) {
      var el = navBtn(role);
      if (!el) { var sel = W.calendar[role + 'Selector']; if (sel) el = q(sel); }
      if (!el) { var rect = W.calendar[role + 'Rect']; if (rect) { var hit = __wsHitAt(panel, rect.dx, rect.dy); if (hit && __wsVisible(hit)) el = hit; } }
      if (!el || !__wsVisible(el)) return false;
      // 用原生 el.click() 只触发一次 onclick。切勿用 __wsRealClick：
      // 它既 dispatchEvent(click) 又 el.click()，会触发两次 → 月份走2格（只走偶数）
      try { el.click(); } catch (e) { __wsRealClick(el); }
      return true;
    }
    // 面板意外关闭时自动重新打开
    async function reopenPanel() {
      log.push('[calSet] 面板关闭了，重新打开');
      panel = null;
      __wsRealClick(trigger);
      var dl = Date.now() + 2000;
      while (Date.now() < dl) {
        await __wsWait(150);
        panel = tryFindPanel();
        if (panel) { log.push('[calSet] 面板已重新打开'); return true; }
      }
      return false;
    }

    var iter = 0, arrived = false;
    var lastCur = null;
    var failCount = 0;
    var recentTotals = [];
    while (iter++ < 240) {
      // 检查面板是否还在
      if (!panel || !__wsVisible(panel)) {
        if (!(await reopenPanel())) { log.push('[calSet] 面板无法重新打开'); break; }
      }
      var cur = readCur();
      if (!cur) { await __wsWait(200); continue; }
      if (iter === 1) log.push('[calSet] 当前=' + cur.y + '-' + cur.m + ', 目标=' + TY + '-' + TM);
      if (cur.y === TY && cur.m === TM) { arrived = true; break; }
      var curTotal = cur.y * 12 + cur.m;
      recentTotals.push(curTotal);
      if (recentTotals.length > 6) recentTotals.shift();
      var delta = (TY - cur.y) * 12 + (TM - cur.m);
      var lastTotal = lastCur ? lastCur.y * 12 + lastCur.m : -999;
      var noProgress = lastCur && lastCur.y === cur.y && lastCur.m === cur.m;
      var wentWrong = lastCur && !noProgress && (
        (delta > 0 && curTotal < lastTotal) || (delta < 0 && curTotal > lastTotal)
      );
      // 检测振荡: A→B→A 或 A→B→A→B
      var oscillating = false;
      var r = recentTotals, rl = r.length;
      if (rl >= 3 && r[rl-1] === r[rl-3] && r[rl-1] !== r[rl-2]) oscillating = true;

      var extraClick = false;
      if (noProgress || wentWrong || oscillating) {
        failCount++;
        if (oscillating) { log.push('[calSet] 振荡! +1次点击打破'); extraClick = true; }
        await __wsWait(200);
      } else {
        failCount = 0;
      }
      lastCur = { y: cur.y, m: cur.m };
      var role;
      if (delta >= 12 && (W.calendar.nextYearSelector || W.calendar.nextYearRect)) role = 'nextYear';
      else if (delta <= -12 && (W.calendar.prevYearSelector || W.calendar.prevYearRect)) role = 'prevYear';
      else role = delta > 0 ? 'nextMonth' : 'prevMonth';
      log.push('[calSet] #' + iter + ' delta=' + delta + ' role=' + role + (extraClick?' [+1]':''));
      var navOk = clickNav(role);
      // 振荡时再点1次
      if (navOk && extraClick) {
        await __wsWait(150);
        if (panel && __wsVisible(panel)) clickNav(role);
      }
      // 年级按钮失败→降级月级
      if (!navOk && (role === 'prevYear' || role === 'nextYear')) {
        var fb = role === 'prevYear' ? 'prevMonth' : 'nextMonth';
        log.push('[calSet] 年级失败→降级: ' + fb);
        navOk = clickNav(fb);
        if (navOk) role = fb;
      }
      if (!navOk) { await __wsWait(300); continue; }
      await __wsWait(extraClick ? 300 : 200);
    }
    if (!arrived) { log.push('[calSet] 翻页超时'); __wsClosePanel(trigger, panel); return { ok: false, reason: 'navigate_timeout', log: log }; }
    log.push('[calSet] 已到达目标年月, 翻页' + (iter - 1) + '次, 准备点日期=' + TD);

    // 点目标日：先按文本在选择器候选中查找（与网格布局无关，翻月后仍准确）；
    // 投影坐标仅作最后兜底（坐标是按拾取时的月份布局记录的，翻月后网格位移，直接命中可能点到别的日）
    function findDay(dnum) {
      // 策略1: 选择器/文本查找日格子
      var cells = [];
      if (W.calendar.dayCellSelector) {
        try {
          var rel = W.calendar.dayCellSelector.split(',').map(function (sx) { sx = (sx || '').trim(); if (panelSel && sx.indexOf(panelSel) === 0) sx = sx.slice(panelSel.length).replace(/^\\s*>\\s*/, '').trim(); return sx; }).filter(Boolean).join(', ');
          var list = panel.querySelectorAll(rel);
          for (var i = 0; i < list.length; i++) cells.push(list[i]);
        } catch (e) {}
      }
      if (!cells.length) {
        try {
          var all = panel.querySelectorAll('td,li,span,div,a,button,[role="gridcell"],[class*="day"],[class*="date"],[class*="cell"]');
          for (var j = 0; j < all.length; j++) cells.push(all[j]);
        } catch (e) {}
      }
      var fallback = null;
      for (var k = 0; k < cells.length; k++) {
        var c = cells[k];
        var t = (c.textContent || '').trim();
        if (t !== String(dnum)) continue;
        if (!__wsVisible(c)) continue;
        // 取最深层同文本节点
        var guard = 0;
        while (c.firstElementChild && (c.firstElementChild.textContent || '').trim() === t && guard++ < 4) {
          c = c.firstElementChild;
        }
        if (c.children.length) continue; // 非叶子容器跳过
        var cls = ((c.className && typeof c.className === 'string' ? c.className : '') + ' ' +
          (c.parentElement && typeof c.parentElement.className === 'string' ? c.parentElement.className : '') + ' ' +
          (c.getAttribute('aria-disabled') || '') + ' ' + (c.getAttribute('disabled') || '')).toLowerCase();
        var outside = /disabled|outside|prev|next|other|muted|not-current|is-disabled/.test(cls);
        if (!outside) return c;
        if (!fallback) fallback = c;
      }
      if (fallback) return fallback;
      // 策略2(最后兜底): 投影坐标命中。命中后校验该元素文本确为目标日，避免翻月后网格位移误点
      var proj = W.calendar.dayCells || [];
      for (var pi = 0; pi < proj.length; pi++) {
        if (proj[pi].text !== String(dnum)) continue;
        var pc = __wsHitAt(panel, proj[pi].dx, proj[pi].dy);
        if (pc && __wsVisible(pc) && (pc.textContent || '').trim() === String(dnum)) {
          log.push('[calSet] 使用坐标兜底点日期=' + dnum);
          return pc;
        }
      }
      return null;
    }
    var dayEl = findDay(TD);
    if (!dayEl) { log.push('[calSet] 日期未找到: day=' + TD); __wsClosePanel(trigger, panel); return { ok: false, reason: 'day_not_found', log: log }; }
    log.push('[calSet] 点击日期=' + TD + ', 元素=' + (dayEl.tagName + (dayEl.className ? '.' + dayEl.className.split(' ')[0] : '')));
    __wsRealClick(dayEl);
    await __wsWait(280);
    log.push('day:' + TD);

    // 读取触发框现值（验证用）
    var val = '';
    try {
      var tag = trigger.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') val = trigger.value || '';
      else {
        var inner = trigger.querySelector ? trigger.querySelector('input') : null;
        val = inner ? (inner.value || '') : (trigger.textContent || '').trim();
      }
    } catch (e) {}
    log.push('[calSet] 完成, 触发框值=' + val);
    return { ok: true, value: val, log: log };
  })();`;
}

/** 镜像操作的类型 */
export type CalendarMirrorAction =
  | { type: "open" } // 打开面板并读取当前年月
  | { type: "nav"; role: "prevYear" | "nextYear" | "prevMonth" | "nextMonth" } // 点击指定角色按钮
  | { type: "day"; day: number }; // 点击指定日期

/**
 * 日历镜像操作脚本：面板与网页真实日历实时联动。
 * 每次执行：若面板未打开则自动打开 → 执行指定动作（翻页/点日期）→ 读取当前年月返回。
 * 返回 { ok, year?, month?, reason? }
 */
export function buildWidgetCalendarMirrorScript(widget: WidgetDef, action: CalendarMirrorAction): string {
  const cal: CalendarControls = widget.calendar || {};
  const w = {
    triggerSelector: sanitize(widget.triggerSelector),
    calendar: {
      panelSelector: sanitize(cal.panelSelector || ""),
      headerSelector: sanitize(cal.headerSelector || ""),
      yearSelector: sanitize(cal.yearSelector || ""),
      monthSelector: sanitize(cal.monthSelector || ""),
      prevYearSelector: sanitize(cal.prevYearSelector || ""),
      nextYearSelector: sanitize(cal.nextYearSelector || ""),
      prevMonthSelector: sanitize(cal.prevMonthSelector || ""),
      nextMonthSelector: sanitize(cal.nextMonthSelector || ""),
      dayCellSelector: sanitize(cal.dayCellSelector || ""),
      headerRect: cal.headerRect || null,
      yearRect: cal.yearRect || null,
      monthRect: cal.monthRect || null,
      prevYearRect: cal.prevYearRect || null,
      nextYearRect: cal.nextYearRect || null,
      prevMonthRect: cal.prevMonthRect || null,
      nextMonthRect: cal.nextMonthRect || null,
      dayCells: cal.dayCells || [],
    },
  };
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (async function () {
    console.log('[widgetMirror] 脚本开始执行, action=' + ${JSON.stringify(action)} + ', trigger=' + W.triggerSelector);
    try { window.__cinsideJustPicked = false; } catch (e) {}
    var W = ${JSON.stringify(w)};
    var ACTION = ${JSON.stringify(action)};
    var trigger = null;
    try { trigger = __cinsideDeepQuery(W.triggerSelector); } catch (e) { trigger = null; }
    if (!trigger) { console.log('[widgetMirror] 触发框未找到'); return { ok: false, reason: 'trigger_not_found' }; }
    console.log('[widgetMirror] 触发框已找到, tag=' + trigger.tagName + ', class=' + trigger.className);
    // 若面板未打开则先打开
    var panel = null;
    function mirrorFindPanel() {
      var p = null;
      if (W.calendar.panelSelector) { try { p = __cinsideDeepQuery(W.calendar.panelSelector); } catch (e) { p = null; } }
      if (p && __wsVisible(p)) return p;
      p = __wsFindOpenPanel(__wsTriggerRoots(trigger));
      if (p && (p === trigger || (p.contains && p.contains(trigger)))) p = null;
      if (p && __wsVisible(p)) return p;
      // 日历结构探测：年月文本 + ≥7 日格子（覆盖 portal/SVG 翻页日历）
      p = __wsFindCalendarPanel(__wsTriggerRoots(trigger), trigger);
      if (p && __wsVisible(p)) return p;
      return null;
    }
    if (W.calendar.panelSelector) { try { panel = __cinsideDeepQuery(W.calendar.panelSelector); } catch (e) { panel = null; } }
    if (!panel || !__wsVisible(panel)) {
      // 策略1: 标准点击
      __wsRealClick(trigger);
      var od = Date.now() + 2500;
      while (Date.now() < od) { panel = mirrorFindPanel(); if (panel) break; await __wsWait(150); }
      // 策略2: focus+click
      if (!panel) {
        try { if (typeof trigger.focus === 'function') trigger.focus({ preventScroll: false }); } catch(e) {}
        await __wsWait(80);
        __wsRealClick(trigger);
        od = Date.now() + 2000;
        while (Date.now() < od) { panel = mirrorFindPanel(); if (panel) break; await __wsWait(150); }
      }
    }
    if (!panel) { console.log('[widgetMirror] 面板未打开'); return { ok: false, reason: 'panel_not_open' }; }
    console.log('[widgetMirror] 面板已打开, panel=' + (panel.tagName + (panel.id ? '#' + panel.id : '') + (panel.className ? '.' + panel.className.split(' ')[0] : '')));
    // 兜底：如果找到的面板不包含日历结构（年月/翻页/日格子），尝试从触发框向上找日历容器
    var hasCalendarStructure = false;
    var panelAll = [];
    try { panelAll = panel.querySelectorAll('*'); } catch (e) {}
    for (var pi = 0; pi < panelAll.length; pi++) {
      var pel = panelAll[pi];
      if (!__wsVisible(pel)) continue;
      var pt = (pel.textContent || '').trim();
      if (__wsParseYearMonth(pt) || /^[‹›«»<>❮❯〈〉⟪⟫←→]$/.test(pt) || /^([1-9]|[12]\d|3[01])$/.test(pt)) {
        hasCalendarStructure = true;
        break;
      }
    }
    if (!hasCalendarStructure) {
      console.log('[widgetMirror] 面板不包含日历结构，尝试按日历结构重新探测');
      var cp2 = __wsFindCalendarPanel(__wsTriggerRoots(trigger), trigger);
      if (cp2) panel = cp2;
    }
    var panelSel = W.calendar.panelSelector || __wsBuildSelector(panel) || 'body';

    function q(sel) {
      if (!sel) return null;
      var el = null;
      if (panel) {
        try {
          var panelPrefixRegex = new RegExp('^' + panelSel.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*');
          var relSel = sel.replace(panelPrefixRegex, '');
          if (relSel) { el = panel.querySelector(relSel); if (el) return el; }
        } catch (e) {}
      }
      try { el = __cinsideDeepQuery(sel); } catch (e) { el = null; }
      if (el) return el;
      try { el = panel.querySelector(sel.replace(panelSel + ' > ', '').replace(panelSel + ' ', '')); } catch (e) { el = null; }
      return el;
    }
    function readCur() {
      var h = q(W.calendar.headerSelector);
      if (h) { var ym = __wsParseYearMonth((h.textContent || '').trim()); if (ym) return ym; }
      if (!h && W.calendar.headerRect) {
        var hh = __wsHitAt(panel, W.calendar.headerRect.dx, W.calendar.headerRect.dy);
        if (hh) { var ymh = __wsParseYearMonth((hh.textContent || '').trim()); if (ymh) return ymh; }
      }
      var y = 0, mo = 0;
      var ye = q(W.calendar.yearSelector);
      var me = q(W.calendar.monthSelector);
      if (ye) { var ym2 = (ye.textContent || '').match(/(\\d{4})/); if (ym2) y = +ym2[1]; }
      if (me) { mo = __wsParseMonthOnly((me.textContent || '').trim()); }
      if (y && mo) return { y: y, m: mo };
      return null;
    }
    function navBtn(role) {
      var head = null;
      try { head = panel.querySelector('.cal-head'); } catch (e) {}
      if (!head) return null;
      var btns = [];
      for (var i = 0; i < head.children.length; i++) {
        var c = head.children[i];
        if (c.tagName === 'BUTTON') btns.push(c);
      }
      var idx = role === 'prevYear' ? 0 : role === 'prevMonth' ? 1 : role === 'nextMonth' ? 2 : role === 'nextYear' ? 3 : -1;
      if (idx >= 0 && btns[idx] && __wsVisible(btns[idx])) return btns[idx];
      var titleMap = { prevYear: '上一年', prevMonth: '上一月', nextMonth: '下一月', nextYear: '下一年' };
      var want = titleMap[role];
      for (var j = 0; j < btns.length; j++) {
        if (btns[j].getAttribute && btns[j].getAttribute('title') === want && __wsVisible(btns[j])) return btns[j];
      }
      return null;
    }
    function clickNav(role) {
      var el = navBtn(role);
      if (!el) {
        var sel = W.calendar[role + 'Selector'];
        if (sel) el = q(sel);
      }
      if (!el) {
        var rect = W.calendar[role + 'Rect'];
        if (rect) {
          var hit = __wsHitAt(panel, rect.dx, rect.dy);
          if (hit && __wsVisible(hit)) el = hit;
        }
      }
      if (!el || !__wsVisible(el)) return false;
      // 原生 el.click() 只触发一次 onclick，避免 __wsRealClick 双重触发导致月份走2格
      try { el.click(); } catch (e) { __wsRealClick(el); }
      return true;
    }
    function findDay(dnum) {
      var cells = [];
      if (W.calendar.dayCellSelector) {
        try {
          var rel = W.calendar.dayCellSelector.split(',').map(function (sx) { sx = (sx || '').trim(); if (panelSel && sx.indexOf(panelSel) === 0) sx = sx.slice(panelSel.length).replace(/^\\s*>\\s*/, '').trim(); return sx; }).filter(Boolean).join(', ');
          var list = panel.querySelectorAll(rel);
          for (var i = 0; i < list.length; i++) cells.push(list[i]);
        } catch (e) {}
      }
      if (!cells.length) {
        try {
          var all = panel.querySelectorAll('td,li,span,div,a,button,[role="gridcell"],[class*="day"],[class*="date"],[class*="cell"]');
          for (var j = 0; j < all.length; j++) cells.push(all[j]);
        } catch (e) {}
      }
      var fallback = null;
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        var t = (c.textContent || '').trim();
        if (t !== String(dnum)) continue;
        if (!__wsVisible(c)) continue;
        var guard = 0;
        while (c.firstElementChild && (c.firstElementChild.textContent || '').trim() === t && guard++ < 4) { c = c.firstElementChild; }
        if (c.children.length) continue;
        var cls = ((c.className && typeof c.className === 'string' ? c.className : '') + ' ' +
          (c.parentElement && typeof c.parentElement.className === 'string' ? c.parentElement.className : '') + ' ' +
          (c.getAttribute('aria-disabled') || '') + ' ' + (c.getAttribute('disabled') || '')).toLowerCase();
        var outside = /disabled|outside|prev|next|other|muted|not-current|is-disabled/.test(cls);
        if (!outside) return c;
        if (!fallback) fallback = c;
      }
      if (!fallback) {
        // 坐标兜底：命中后校验文本确为目标日（翻月后网格位移，旧坐标可能指向别的日）
        var proj = W.calendar.dayCells || [];
        for (var pi = 0; pi < proj.length; pi++) {
          if (proj[pi].text !== String(dnum)) continue;
          var pc = __wsHitAt(panel, proj[pi].dx, proj[pi].dy);
          if (pc && __wsVisible(pc) && (pc.textContent || '').trim() === String(dnum)) { fallback = pc; break; }
        }
      }
      return fallback;
    }

    // 执行动作
    if (ACTION.type === 'nav') {
      console.log('[widgetMirror] 执行翻页: role=' + ACTION.role);
      if (!clickNav(ACTION.role)) { console.log('[widgetMirror] 翻页按钮未找到: role=' + ACTION.role); return { ok: false, reason: 'nav_button_missing', role: ACTION.role }; }
      await __wsWait(250);
    } else if (ACTION.type === 'day') {
      console.log('[widgetMirror] 执行点日期: day=' + ACTION.day);
      var dayEl = findDay(ACTION.day);
      if (!dayEl) { console.log('[widgetMirror] 日期未找到: day=' + ACTION.day); return { ok: false, reason: 'day_not_found', day: ACTION.day }; }
      __wsRealClick(dayEl);
      await __wsWait(250);
    }
    // 读取当前年月
    var cur = readCur();
    if (cur) { console.log('[widgetMirror] 读取当前年月: ' + cur.y + '-' + cur.m); }
    else { console.log('[widgetMirror] 读取当前年月失败'); }
    return cur ? { ok: true, year: cur.y, month: cur.m } : { ok: false, reason: 'header_parse_fail' };
  })();`;
}

/**
 * 控件当前值读取脚本（审查用）：读触发框显示值；选项控件额外找面板中的选中态
 * 返回 { found, value }
 */
export function buildWidgetReadScript(widget: WidgetDef): string {
  const w = {
    kind: widget.kind,
    triggerSelector: sanitize(widget.triggerSelector),
    panelSelector: sanitize(widget.panelSelector || ""),
  };
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    var W = ${JSON.stringify(w)};
    var trigger = null;
    try { trigger = __cinsideDeepQuery(W.triggerSelector); } catch (e) { trigger = null; }
    if (!trigger) return { found: false, value: '' };
    var val = '';
    var tag = trigger.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (tag === 'SELECT') {
        var so = trigger.options && trigger.options[trigger.selectedIndex];
        val = so ? (so.text || so.value || '') : '';
      } else {
        val = trigger.value || '';
      }
    } else {
      var inner = trigger.querySelector ? trigger.querySelector('input') : null;
      if (inner && inner.value) val = inner.value;
      if (!val) val = (trigger.innerText || trigger.textContent || '').trim();
    }
    // 选项控件：面板 DOM 中找选中态（面板可能隐藏但选中类仍在）
    if (W.kind === 'option' && W.panelSelector) {
      var panel = null;
      try { panel = __cinsideDeepQuery(W.panelSelector); } catch (e) { panel = null; }
      if (panel) {
        var sel = null;
        try {
          sel = panel.querySelector('[class*="selected"],[class*="active"],[class*="checked"],[aria-selected="true"],[aria-checked="true"]');
        } catch (e) {}
        if (sel) {
          var t = (sel.innerText || sel.textContent || '').trim().replace(/\\s+/g, ' ');
          if (t && t.length <= 60) val = t;
        }
      }
    }
    return { found: true, value: (val || '').trim() };
  })();`;
}

/** 快照结果类型（脚本返回值） */
export interface WidgetSnapshotResult {
  ok: boolean;
  kind?: "option" | "calendar";
  panelSelector?: string;
  options?: WidgetOption[];
  calendar?: CalendarControls;
  /** 各角色识别状态/示例文本（面板卡片显示用） */
  detected?: Record<string, string>;
  reason?: string;
}

/** 选项选择结果 */
export interface OptionSelectResult {
  ok: boolean;
  clickedText?: string;
  reason?: string;
  options?: string[];
}

/** 日历设定结果 */
export interface CalendarSetResult {
  ok: boolean;
  value?: string;
  log?: string[];
  reason?: string;
}

/** 控件读取结果 */
export interface WidgetReadResult {
  found: boolean;
  value: string;
}

/**
 * 直接显示型选项组快照脚本：点击的元素所在的容器内收集可点击选项（不需要弹出面板）
 * 适用于：男/女单选按钮组、标签选择组等直接在页面上可见的选项
 * 返回 { ok, options?, reason? }
 */
export function buildInlineOptionSnapshotScript(containerSelector: string): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    var container = null;
    try { container = __cinsideDeepQuery(${JSON.stringify(sanitize(containerSelector))}); } catch (e) { container = null; }
    if (!container) return { ok: false, reason: 'container_not_found' };

    // 向上查找合理的选项组容器（包含多个相似子元素的父级）
    var groupContainer = container;
    // 最多向上找 5 层，找包含 2 个以上可点击元素的容器
    for (var up = 0; up < 5; up++) {
      var clickable = [];
      try {
        var els = groupContainer.querySelectorAll('button, a, [role="button"], [role="radio"], [role="option"], label, input[type="radio"], input[type="checkbox"], li, div, span');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!__wsVisible(el)) continue;
          var t = (el.textContent || el.innerText || '').trim().replace(/\\s+/g, ' ');
          if (t && t.length <= 20 && t.length >= 1) {
            // 检查是否是叶子级或带文本的按钮
            var hasBlockChild = false;
            try {
              var kids = el.children;
              for (var k = 0; k < kids.length; k++) {
                var kt = (kids[k].textContent || '').trim();
                if (kt && kt.length > 5) { hasBlockChild = true; break; }
              }
            } catch(e) {}
            if (!hasBlockChild) clickable.push(el);
          }
        }
      } catch(e) {}
      if (clickable.length >= 2) break;
      if (groupContainer.parentElement) groupContainer = groupContainer.parentElement;
      else break;
    }

    // 收集选项：在找到的容器内找所有可见的、带短文本的可点击元素
    var items = [];
    var seen = {};
    try {
      var all = groupContainer.querySelectorAll('button, a, [role="button"], [role="radio"], [role="option"], [role="tab"], label, input[type="radio"] + *, input[type="checkbox"] + *, li, [class*="item"], [class*="option"], [class*="choice"], [class*="btn"], [class*="radio"], [class*="checkbox"]');
      // 如果上面的选择器找不到足够的元素，直接用 div/span
      if (all.length < 2) {
        all = groupContainer.querySelectorAll('*');
      }
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (!__wsVisible(el)) continue;
        var text = (el.textContent || el.innerText || '').trim().replace(/\\s+/g, ' ');
        if (!text || text.length > 10 || text.length < 1) continue;
        // 过滤掉容器本身和纯图标元素
        if (el === groupContainer) continue;
        if (seen[text]) continue;
        // 检查是否包含其他候选（避免选到父容器）
        var containsOther = false;
        for (var c = 0; c < all.length; c++) {
          if (all[c] !== el && el.contains(all[c])) {
            var ct = (all[c].textContent || '').trim().replace(/\\s+/g, ' ');
            if (ct && ct.length >= 1 && ct.length <= 10 && ct !== text) { containsOther = true; break; }
          }
        }
        if (containsOther) continue;
        // 构建选择器
        var sel = __wsBuildSelector(el);
        if (!sel) {
          // 用容器相对路径
          sel = __wsChildSelector(__wsBuildSelector(groupContainer) || 'body', groupContainer, el);
        }
        items.push({ text: text, selector: sel });
        seen[text] = 1;
        if (items.length >= 20) break;
      }
    } catch (e) { return { ok: false, reason: 'collect_error: ' + e.message }; }

    if (items.length < 2) return { ok: false, reason: 'inline_options_not_found', containerSelector: __wsBuildSelector(groupContainer) };
    return { ok: true, inline: true, panelSelector: __wsBuildSelector(groupContainer), options: items };
  })();`;
}

/**
 * inline 选项控件选择脚本：直接点击匹配的选项元素（不需要展开面板）
 * 返回 { ok, clickedText?, reason?, options? }
 */
export function buildInlineOptionSelectScript(widget: WidgetDef, targetValue: string): string {
  const w = {
    triggerSelector: sanitize(widget.triggerSelector),
    panelSelector: sanitize(widget.panelSelector || ""),
    options: (widget.options || []).map((o) => ({
      text: o.text,
      selector: sanitize(o.selector),
      alias: o.alias || "",
    })),
  };
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    // 清掉拾取器吞点击标记：测试/执行时此处的 __wsRealClick 是程序化触发，
    // 若上一帧拾取刚完成（__cinsideJustPicked=true），click 会被吞掉导致选项点击失败。
    try { window.__cinsideJustPicked = false; } catch (e) {}
    var W = ${JSON.stringify(w)};
    var TARGET = ${JSON.stringify(targetValue)};

    // 收集候选项：优先用存储的选择器，失效则在容器内重新收集
    var container = null;
    if (W.panelSelector) { try { container = __cinsideDeepQuery(W.panelSelector); } catch (e) {} }
    if (!container) { try { container = __cinsideDeepQuery(W.triggerSelector); } catch (e) {} }
    if (!container) return { ok: false, reason: 'container_not_found' };

    var items = [];
    if (W.options && W.options.length) {
      for (var i = 0; i < W.options.length; i++) {
        var o = W.options[i];
        var el = null;
        if (o.selector) { try { el = __cinsideDeepQuery(o.selector); } catch (e) {} }
        // 如果存储的选择器失效，在容器内按文本找
        if (!el || !__wsVisible(el)) {
          try {
            var allInContainer = container.querySelectorAll('*');
            for (var k = 0; k < allInContainer.length; k++) {
              var cel = allInContainer[k];
              var ct = (cel.textContent || '').trim().replace(/\\s+/g, ' ');
              if (ct === o.text && __wsVisible(cel)) { el = cel; break; }
            }
          } catch(e) {}
        }
        if (el && __wsVisible(el)) items.push({ el: el, text: o.text, alias: o.alias || '' });
      }
    }
    if (!items.length) {
      // 兜底：在容器内重新收集
      try {
        var all = container.querySelectorAll('button, a, [role="button"], [role="radio"], [role="option"], label, li, span, div');
        var seen = {};
        for (var j = 0; j < all.length; j++) {
          var el2 = all[j];
          if (!__wsVisible(el2)) continue;
          var t = (el2.textContent || '').trim().replace(/\\s+/g, ' ');
          if (!t || t.length > 10 || seen[t]) continue;
          items.push({ el: el2, text: t, alias: '' });
          seen[t] = 1;
        }
      } catch(e) {}
    }
    if (!items.length) return { ok: false, reason: 'options_empty' };

    var tn = __wsNorm(TARGET);
    var best = null;
    var i2;
    // 别名展开：斜杠分隔多个触发词（如 FEMALE/F/woman），任一精确命中即匹配
    function aliasWords(a) { return (a || '').split('/').map(function (x) { return __wsNorm(x); }).filter(function (x) { return !!x; }); }
    // 1) 别名精确
    for (i2 = 0; i2 < items.length; i2++) {
      var aw = aliasWords(items[i2].alias);
      for (var ai = 0; ai < aw.length; ai++) { if (aw[ai] === tn) { best = items[i2]; break; } }
      if (best) break;
    }
    // 2) 文本精确
    if (!best) { for (i2 = 0; i2 < items.length; i2++) { if (__wsNorm(items[i2].text) === tn) { best = items[i2]; break; } } }
    // 3) 智能包含
    if (!best && tn.length >= 1) {
      for (i2 = 0; i2 < items.length; i2++) {
        var on = __wsNorm(items[i2].text);
        if (on && (on.indexOf(tn) >= 0 || tn.indexOf(on) >= 0)) { best = items[i2]; break; }
      }
    }
    if (!best) {
      var avail = [];
      for (i2 = 0; i2 < items.length; i2++) avail.push(items[i2].text);
      return { ok: false, reason: 'no_match', options: avail };
    }
    __wsRealClick(best.el);
    return { ok: true, clickedText: best.text };
  })();`;
}
