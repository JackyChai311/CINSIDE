/**
 * 点击展开型控件脚本库（选项控件 / 日历控件）
 *
 * 所有函数返回注入网页执行的 JS 脚本字符串，通过 viewExecuteJS 在右侧 BrowserView 中运行。
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
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var opts = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView || window };
    try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
    try { el.focus({ preventScroll: true }); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
    try { if (typeof el.click === 'function') el.click(); } catch (e) {}
  }
  function __wsWait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function __wsNorm(s) { return (s || '').replace(/[\\s ]+/g, '').toLowerCase(); }
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
    var SEL = '[role="option"],[role="menuitem"],[role="radio"],[role="button"],li,[class*="item"],[class*="option"],[class*="choice"],[class*="select"],a,button,label';
    var els;
    try { els = panel.querySelectorAll(SEL); } catch (e) { return out; }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!__wsVisible(el)) continue;
      // 只取叶子级：不包含其他候选子项
      try { if (el.querySelector(SEL)) continue; } catch (e) {}
      var text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (!text || text.length > 60) continue;
      if (seen[text]) continue;
      seen[text] = 1;
      out.push({ el: el, text: text });
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
`;

/** 日历角色自动识别（注入脚本片段）：在面板内找 header / 翻页按钮 / 日格子 */
const CALENDAR_DETECT = `
  function __wsDetectCalendar(panel, panelSel) {
    var cal = { panelSelector: panelSel };
    var detected = {};
    var i, el, t;
    var all;
    try { all = panel.querySelectorAll('*'); } catch (e) { all = []; }
    // 1) header：找包含年月模式的最内层元素
    for (i = 0; i < all.length; i++) {
      el = all[i];
      if (!__wsVisible(el)) continue;
      // 只接受没有元素子节点、或子节点不含年月文本的元素（取最内层）
      var text = (el.textContent || '').trim();
      var ym = __wsParseYearMonth(text);
      if (!ym) continue;
      var inner = false;
      for (var k = 0; k < el.children.length; k++) {
        if (__wsParseYearMonth((el.children[k].textContent || '').trim())) { inner = true; break; }
      }
      if (inner) continue;
      cal.headerSelector = __wsChildSelector(panelSel, panel, el);
      detected.header = text.slice(0, 20);
      break;
    }
    // 1b) 无 header：找单独的年（4位数字）和月元素
    if (!cal.headerSelector) {
      for (i = 0; i < all.length; i++) {
        el = all[i];
        if (!__wsVisible(el)) continue;
        t = (el.textContent || '').trim();
        if (/^\\d{4}\\s*年?$/.test(t) && !cal.yearSelector) {
          cal.yearSelector = __wsChildSelector(panelSel, panel, el);
          detected.year = t.slice(0, 10);
        } else {
          var mo = __wsParseMonthOnly(t);
          if (mo && t.length <= 10 && !cal.monthSelector) {
            cal.monthSelector = __wsChildSelector(panelSel, panel, el);
            detected.month = t.slice(0, 10);
          }
        }
      }
    }
    // 2) 翻页按钮：aria/title/class 含 prev/next，或文本为箭头符号的小元素
    var NAV_TEXT = { '‹': 1, '›': 1, '«': 2, '»': 2, '<': 1, '>': 1, '❮': 1, '❯': 1, '〈': 1, '〉': 1, '<<': 2, '>>': 2, '⟪': 2, '⟫': 2, '←': 1, '→': 1 };
    var navs = [];
    for (i = 0; i < all.length; i++) {
      el = all[i];
      if (!__wsVisible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 80 || r.height > 60) continue;
      var aria = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')) + ' ' + ((el.className && typeof el.className === 'string') ? el.className : '')).toLowerCase();
      t = (el.textContent || '').trim();
      var kind = 0; // 1=月级 2=年级
      var dir = 0;  // -1=prev 1=next
      var explicit = false; // 是否来自 aria/title/class 明确标注（符号猜测的不算）
      if (/prev|backward|left|上一|上个|last/.test(aria)) { dir = -1; explicit = true; }
      if (/next|forward|right|下一|下个/.test(aria)) { dir = 1; explicit = true; }
      if (explicit) { if (/year|年/.test(aria)) kind = 2; else kind = 1; }
      if (!dir && NAV_TEXT[t]) {
        kind = NAV_TEXT[t];
        // 方向由相对 header 的位置决定，先记录
      }
      if (!dir && !kind) continue;
      navs.push({ el: el, dir: dir, kind: kind, text: t.slice(0, 4), x: r.left + r.width / 2, y: r.top + r.height / 2, explicit: explicit });
    }
    if (navs.length) {
      // header 中心 x（无 header 时用面板中心）
      var cx;
      if (cal.headerSelector) {
        try {
          var hEl = panel.querySelector(cal.headerSelector.replace(panelSel + ' > ', ''));
          if (hEl) { var hr = hEl.getBoundingClientRect(); cx = hr.left + hr.width / 2; }
        } catch (e) {}
      }
      if (cx === undefined) { var pr = panel.getBoundingClientRect(); cx = pr.left + pr.width / 2; }
      var prevs = navs.filter(function (n) { return n.dir === -1 || (n.dir === 0 && n.x < cx); });
      var nexts = navs.filter(function (n) { return n.dir === 1 || (n.dir === 0 && n.x >= cx); });
      // 组内按与 header 距离排序：远=年级按钮候选，近=月级按钮候选
      prevs.sort(function (a, b) { return a.x - b.x; });
      nexts.sort(function (a, b) { return b.x - a.x; });
      var usedIdx = {};
      function assignNav(n, roleBase, group) {
        var role = roleBase + (n.kind === 2 ? 'Year' : 'Month');
        if (!cal[role + 'Selector']) {
          cal[role + 'Selector'] = __wsChildSelector(panelSel, panel, n.el);
          detected[role] = n.text || role;
          n.__used = true;
        }
      }
      // 显式 kind=2 的优先占年角色
      prevs.forEach(function (n) { if (n.kind === 2 && !n.__used) assignNav(n, 'prev', prevs); });
      nexts.forEach(function (n) { if (n.kind === 2 && !n.__used) assignNav(n, 'next', nexts); });
      // 显式 kind=1 的占月角色
      prevs.forEach(function (n) { if (n.kind === 1 && !n.__used) assignNav(n, 'prev', prevs); });
      nexts.forEach(function (n) { if (n.kind === 1 && !n.__used) assignNav(n, 'next', nexts); });
      // 同侧 >=2 个按钮且年角色空缺：最远（未占用）的当年级
      if (!cal.prevYearSelector) { for (var pi = 0; pi < prevs.length; pi++) { if (!prevs[pi].__used) { cal.prevYearSelector = __wsChildSelector(panelSel, panel, prevs[pi].el); detected.prevYear = prevs[pi].text || 'prevYear'; prevs[pi].__used = true; break; } } }
      if (!cal.nextYearSelector) { for (var ni = 0; ni < nexts.length; ni++) { if (!nexts[ni].__used) { cal.nextYearSelector = __wsChildSelector(panelSel, panel, nexts[ni].el); detected.nextYear = nexts[ni].text || 'nextYear'; nexts[ni].__used = true; break; } } }
      // 月角色仍空缺：取最近（未占用）的
      if (!cal.prevMonthSelector) { for (var pj = prevs.length - 1; pj >= 0; pj--) { if (!prevs[pj].__used) { cal.prevMonthSelector = __wsChildSelector(panelSel, panel, prevs[pj].el); detected.prevMonth = prevs[pj].text || 'prevMonth'; prevs[pj].__used = true; break; } } }
      if (!cal.nextMonthSelector) { for (var nj = nexts.length - 1; nj >= 0; nj--) { if (!nexts[nj].__used) { cal.nextMonthSelector = __wsChildSelector(panelSel, panel, nexts[nj].el); detected.nextMonth = nexts[nj].text || 'nextMonth'; nexts[nj].__used = true; break; } } }
      // 符号猜测的单按钮降级：年角色来自符号猜测且该侧只有它一个按钮时，改作月级（逐月翻页总是可行）
      if (cal.prevYearSelector && !cal.prevMonthSelector) {
        var onlyP = prevs.length === 1 && prevs[0].__used && !prevs[0].explicit;
        if (onlyP) { cal.prevMonthSelector = cal.prevYearSelector; delete cal.prevYearSelector; detected.prevMonth = detected.prevYear; delete detected.prevYear; }
      }
      if (cal.nextYearSelector && !cal.nextMonthSelector) {
        var onlyN = nexts.length === 1 && nexts[0].__used && !nexts[0].explicit;
        if (onlyN) { cal.nextMonthSelector = cal.nextYearSelector; delete cal.nextYearSelector; detected.nextMonth = detected.nextYear; delete detected.nextYear; }
      }
    }
    // 3) 日格子：文本为 1-31 的叶子可见元素，>=28 个
    var dayEls = [];
    for (i = 0; i < all.length; i++) {
      el = all[i];
      if (!__wsVisible(el)) continue;
      t = (el.textContent || '').trim();
      if (!/^([1-9]|[12]\\d|3[01])$/.test(t)) continue;
      if (el.children.length) {
        // 允许包裹一层同文本节点（如 <td><span>6</span></td>），取最深层
        var deep = el;
        var guard = 0;
        while (deep.firstElementChild && (deep.firstElementChild.textContent || '').trim() === t && guard++ < 4) {
          deep = deep.firstElementChild;
        }
        if (deep !== el) { el = deep; }
      }
      if (dayEls.indexOf(el) === -1) dayEls.push(el);
    }
    if (dayEls.length >= 28) {
      // 公共选择器：取第一个日格子的"去序号"路径（tag + 稳定类，不带 nth-of-type）
      var first = dayEls[0];
      var tag = first.nodeName.toLowerCase();
      var commonSel = tag;
      if (first.className && typeof first.className === 'string') {
        var cls = first.className.trim().split(/\\s+/).filter(function (c) {
          return c && c.indexOf('cinside') !== 0 && !/active|selected|today|current|disabled|outside|prev|next|other|weekend/i.test(c);
        }).slice(0, 2).join('.');
        if (cls) commonSel = tag + '.' + cls;
      }
      // 验证公共选择器命中数
      try {
        var hit = panel.querySelectorAll(commonSel);
        if (hit.length < 20) commonSel = tag;
      } catch (e) { commonSel = tag; }
      cal.dayCellSelector = panelSel + ' ' + commonSel;
      detected.dayCell = String(dayEls.length) + ' 格';
    }
    return { cal: cal, detected: detected };
  }
`;

/** 打开控件面板（点击触发框，不关闭）。角色重选时先执行它再进入拾取模式 */
export function buildWidgetOpenScript(triggerSelector: string): string {
  return `
  ${DEEP_QUERY}
  ${COMMON}
  (function () {
    var trigger = null;
    try { trigger = __cinsideDeepQuery(${JSON.stringify(sanitize(triggerSelector))}); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false, reason: 'trigger_not_found' };
    __wsRealClick(trigger);
    return { ok: true };
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
  ${CALENDAR_DETECT}
  (async function () {
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

    // 2) 点击触发框，等待面板展开
    __wsRealClick(trigger);
    await __wsWait(650);

    // 3) 找新出现 / 新变为可见的弹出层候选
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
    var panel = cands.length ? cands[0] : null;
    // 兜底：未检测到"新出现"的面板时，找当前可见弹出层（排除触发框祖先链）
    if (!panel) {
      panel = __wsFindOpenPanel(roots);
      if (panel && (panel === trigger || panel.contains(trigger))) panel = null;
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
    } else {
      var det = __wsDetectCalendar(panel, panelSel);
      result.calendar = det.cal;
      result.detected = det.detected;
      if (!det.cal.headerSelector && !det.cal.yearSelector) {
        __wsClosePanel(trigger, panel);
        cleanup();
        return { ok: false, reason: 'calendar_header_not_found', calendar: det.cal, detected: det.detected, panelSelector: panelSel };
      }
      if (!det.cal.prevMonthSelector && !det.cal.nextMonthSelector) {
        __wsClosePanel(trigger, panel);
        cleanup();
        return { ok: false, reason: 'calendar_nav_not_found', calendar: det.cal, detected: det.detected, panelSelector: panelSel };
      }
      if (!det.cal.dayCellSelector) {
        __wsClosePanel(trigger, panel);
        cleanup();
        return { ok: false, reason: 'calendar_days_not_found', calendar: det.cal, detected: det.detected, panelSelector: panelSel };
      }
    }

    // 5) 关闭面板并清理标记
    __wsClosePanel(trigger, panel);
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
    var W = ${JSON.stringify(w)};
    var TARGET = ${JSON.stringify(targetValue)};
    var trigger = null;
    try { trigger = __cinsideDeepQuery(W.triggerSelector); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false, reason: 'trigger_not_found' };
    __wsRealClick(trigger);
    await __wsWait(550);
    var panel = null;
    if (W.panelSelector) { try { panel = __cinsideDeepQuery(W.panelSelector); } catch (e) { panel = null; } }
    if (!panel || !__wsVisible(panel)) {
      panel = __wsFindOpenPanel(__wsTriggerRoots(trigger));
      if (panel && (panel === trigger || panel.contains(trigger))) panel = null;
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
    // 1) 别名精确
    for (i2 = 0; i2 < items.length; i2++) { if (items[i2].alias && __wsNorm(items[i2].alias) === tn) { best = items[i2]; break; } }
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
    },
  };
  return `
  ${DEEP_QUERY}
  ${COMMON}
  ${CALENDAR_DETECT}
  (async function () {
    var W = ${JSON.stringify(w)};
    var TY = ${y | 0}, TM = ${m | 0}, TD = ${d | 0};
    var log = [];
    var trigger = null;
    try { trigger = __cinsideDeepQuery(W.triggerSelector); } catch (e) { trigger = null; }
    if (!trigger) return { ok: false, reason: 'trigger_not_found' };
    __wsRealClick(trigger);
    await __wsWait(550);
    var panel = null;
    if (W.calendar.panelSelector) { try { panel = __cinsideDeepQuery(W.calendar.panelSelector); } catch (e) { panel = null; } }
    if (!panel || !__wsVisible(panel)) {
      panel = __wsFindOpenPanel(__wsTriggerRoots(trigger));
      if (panel && (panel === trigger || panel.contains(trigger))) panel = null;
    }
    if (!panel) return { ok: false, reason: 'panel_not_open' };
    var panelSel = W.calendar.panelSelector || __wsBuildSelector(panel) || 'body';

    function q(sel) {
      if (!sel) return null;
      var el = null;
      try { el = __cinsideDeepQuery(sel); } catch (e) { el = null; }
      if (el) return el;
      // 面板选择器可能漂移：退化到面板内相对查找
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
      var y = 0, mo = 0;
      var ye = q(W.calendar.yearSelector);
      var me = q(W.calendar.monthSelector);
      if (ye) { var ym2 = (ye.textContent || '').match(/(\\d{4})/); if (ym2) y = +ym2[1]; }
      if (me) { mo = __wsParseMonthOnly((me.textContent || '').trim()); }
      if (y && mo) return { y: y, m: mo };
      // 自动兜底：重新识别面板 header
      var det = __wsDetectCalendar(panel, panelSel);
      if (det.cal.headerSelector) {
        try {
          var hEl = panel.querySelector(det.cal.headerSelector.replace(panelSel + ' > ', ''));
          if (hEl) { var ym3 = __wsParseYearMonth((hEl.textContent || '').trim()); if (ym3) return ym3; }
        } catch (e) {}
      }
      return null;
    }
    // 点翻页按钮（存储选择器失效时自动重识别一次）
    var redetected = null;
    function clickNav(role) {
      var sel = W.calendar[role + 'Selector'];
      var el = q(sel);
      if (!el || !__wsVisible(el)) {
        if (!redetected) redetected = __wsDetectCalendar(panel, panelSel).cal;
        var rsel = redetected[role + 'Selector'];
        if (rsel) {
          try { el = panel.querySelector(rsel.replace(panelSel + ' > ', '')); } catch (e) { el = null; }
        }
      }
      if (!el) return false;
      __wsRealClick(el);
      return true;
    }

    var iter = 0, arrived = false;
    while (iter++ < 240) {
      var cur = readCur();
      if (!cur) { __wsClosePanel(trigger, panel); return { ok: false, reason: 'header_parse_fail', log: log }; }
      if (cur.y === TY && cur.m === TM) { arrived = true; break; }
      var delta = (TY - cur.y) * 12 + (TM - cur.m);
      var role;
      if (delta >= 12 && W.calendar.nextYearSelector) role = 'nextYear';
      else if (delta <= -12 && W.calendar.prevYearSelector) role = 'prevYear';
      else role = delta > 0 ? 'nextMonth' : 'prevMonth';
      if (!clickNav(role)) {
        role = delta > 0 ? 'nextMonth' : 'prevMonth';
        if (!clickNav(role)) {
          __wsClosePanel(trigger, panel);
          return { ok: false, reason: 'nav_button_missing', log: log };
        }
      }
      log.push(role);
      await __wsWait(130);
    }
    if (!arrived) { __wsClosePanel(trigger, panel); return { ok: false, reason: 'navigate_timeout', log: log }; }

    // 点目标日：严格匹配文本，排除非本月/禁用格
    function findDay(dnum) {
      var cells = [];
      if (W.calendar.dayCellSelector) {
        try {
          var rel = W.calendar.dayCellSelector.replace(panelSel + ' ', '');
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
      return fallback;
    }
    var dayEl = findDay(TD);
    if (!dayEl) { __wsClosePanel(trigger, panel); return { ok: false, reason: 'day_not_found', log: log }; }
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
    return { ok: true, value: val, log: log };
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
    // 1) 别名精确
    for (i2 = 0; i2 < items.length; i2++) { if (items[i2].alias && __wsNorm(items[i2].alias) === tn) { best = items[i2]; break; } }
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
