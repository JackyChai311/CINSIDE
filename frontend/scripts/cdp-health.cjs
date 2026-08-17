/* eslint-disable */
// 一次性 CDP 健康检查：页面加载状态 + IndexedDB + 早期 console 错误
const http = require("http");

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

(async () => {
  const targets = await getJson("http://127.0.0.1:9222/json");
  const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:5173"));
  if (!page) { console.log("NO_PAGE"); process.exit(1); }
  const WSImpl = globalThis.WebSocket; // node 22+ 原生 WebSocket
  if (!WSImpl) { console.log("NO_NATIVE_WS"); process.exit(1); }
  const ws = new WSImpl(page.webSocketDebuggerUrl);
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    listeners.forEach((fn) => fn(m));
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    const onMsg = (m) => {
      if (m.id === mid) {
        listeners.splice(listeners.indexOf(onMsg), 1);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    listeners.push(onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  const errors = [];
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text.slice(0, 200));
      if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception?.description || "").slice(0, 200));
    } catch {}
  });
  await send("Runtime.enable", {});
  await send("Log.enable", {});
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const info = await evalJs(`(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    return {
      title: document.title,
      rootChildren: document.getElementById("root")?.childElementCount ?? -1,
      cardImages: document.querySelectorAll("[data-record-id], li[draggable]").length,
      dbs: dbs.map(d => d.name),
      loadAge: Math.round(performance.now()),
    };
  })()`);
  console.log(JSON.stringify({ info, errors }, null, 2));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
