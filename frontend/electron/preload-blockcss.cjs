"use strict";

// 会话级 preload：document_start 即按 host 同步取屏蔽 CSS + 折叠 JS，
// 在页面首次绘制前生效，消除跳转/刷新时侧边栏（或被屏蔽元素）先闪现再隐藏的问题。
// 规则由主进程按 host 持久化（block-rules.json），无需等前端 renderer 启动推送。
// 无规则的 host 返回 null，直接退出零开销。
const { ipcRenderer } = require("electron");

try {
  const host = location.hostname;
  if (!host) return;
  const res = ipcRenderer.sendSync("cinside-block-css-sync", host);
  if (!res) return;

  // 1) CSS：document_start 时 <html> 可能尚未创建，用 MutationObserver 兜底
  if (res.css) {
    const injectCss = () => {
      if (document.getElementById("cinside-block-early")) return true;
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      const style = document.createElement("style");
      style.id = "cinside-block-early";
      style.textContent = res.css;
      parent.appendChild(style);
      return true;
    };
    if (!injectCss()) {
      const obs = new MutationObserver(() => {
        if (injectCss()) obs.disconnect();
      });
      obs.observe(document, { childList: true, subtree: true });
    }
  }

  // 2) 折叠 JS：立即执行（内部观察者自行兼容 body 未创建的情形）。
  // 与 dom-ready 的再次注入靠 DOM dataset 守卫保持幂等，不会重复折叠。
  if (res.js) {
    try {
      new Function(res.js)();
    } catch (_) {}
  }
} catch (_) {}
