import type { WorkflowTemplate, PickedMark } from "../types";

/**
 * LOOP 卡片分享码工具
 *
 * 方案：纯离线编码，无需服务器。
 * 模板 JSON → 剥离大体积二进制字段 → gzip 压缩 → base64 → 加版本前缀
 * 对方粘贴后反向解码并导入。
 */

const SHARE_PREFIX = "CSL1:"; // Cinside Share v1

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  // 复制到纯 ArrayBuffer 支撑的 Uint8Array，规避 TS lib 的 SharedArrayBuffer 类型不兼容
  const buf = new Uint8Array(data.byteLength);
  buf.set(data);
  // 写 Uint8Array（而非 .buffer）：浏览器与 Node 的 CompressionStream 都接受，且 Node 拒绝裸 ArrayBuffer。
  // 写入与读取必须并发：大体积数据时 CompressionStream 有背压，先 await write 再读会死锁
  const writePromise = (async () => { await writer.write(buf); await writer.close(); })();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  await writePromise;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const buf = new Uint8Array(data.byteLength);
  buf.set(data);
  const writePromise = (async () => { await writer.write(buf); await writer.close(); })();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  await writePromise;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 递归清理 marks 中不适合分享的大体积/机器相关字段 */
function sanitizeMarks(marks: PickedMark[]): PickedMark[] {
  return marks.map((m) => {
    const copy = { ...m };
    // 本地文件内容（base64）体积巨大且对方机器上不存在，剥离；保留文件名供参考
    if (copy.docLocalFiles) {
      copy.docLocalFiles = copy.docLocalFiles.map((f) => ({ name: f.name }));
    }
    // 本地绝对路径对别人无意义
    delete copy.docLocalRootPath;
    return copy;
  });
}

/** 把模板清理成适合分享的轻量副本 */
function sanitizeTemplate(tpl: WorkflowTemplate): unknown {
  return {
    name: tpl.name,
    description: tpl.description,
    icon: tpl.icon,
    iconImage: tpl.iconImage,
    mode: tpl.mode,
    dataSourceMarks: sanitizeMarks(tpl.dataSourceMarks),
    reviewMarks: sanitizeMarks(tpl.reviewMarks),
    entryMarks: sanitizeMarks(tpl.entryMarks),
    mappings: tpl.mappings,
    customTextEntries: tpl.customTextEntries,
    flowGraph: tpl.flowGraph,
    hasSearchSteps: tpl.hasSearchSteps,
    hasSubmitStep: tpl.hasSubmitStep,
  };
}

/** 生成分享码 */
export async function encodeShareCode(tpl: WorkflowTemplate): Promise<string> {
  const clean = sanitizeTemplate(tpl);
  const json = JSON.stringify(clean);
  const encoded = new TextEncoder().encode(json);
  const compressed = await gzipBytes(encoded);
  return SHARE_PREFIX + bytesToBase64(compressed);
}

export interface DecodeResult {
  ok: boolean;
  template?: WorkflowTemplate;
  error?: string;
}

/** 解析分享码，返回一个新的模板副本（ID 重新生成，避免覆盖本地模板） */
export async function decodeShareCode(code: string): Promise<DecodeResult> {
  try {
    const trimmed = code.trim();
    if (!trimmed.startsWith(SHARE_PREFIX)) {
      return { ok: false, error: "无效的分享码（缺少前缀）" };
    }
    const b64 = trimmed.slice(SHARE_PREFIX.length).replace(/\s+/g, "");
    const compressed = base64ToBytes(b64);
    const raw = await gunzipBytes(compressed);
    const json = new TextDecoder().decode(raw);
    const data = JSON.parse(json);

    const now = Date.now();
    const tpl: WorkflowTemplate = {
      id: `tpl_${now}_${Math.random().toString(36).slice(2, 8)}`,
      name: String(data.name || "未命名模板"),
      description: data.description,
      icon: data.icon,
      iconImage: data.iconImage,
      createdAt: now,
      updatedAt: now,
      mode: data.mode || "loop",
      dataSourceMarks: Array.isArray(data.dataSourceMarks) ? data.dataSourceMarks : [],
      reviewMarks: Array.isArray(data.reviewMarks) ? data.reviewMarks : [],
      entryMarks: Array.isArray(data.entryMarks) ? data.entryMarks : [],
      mappings: Array.isArray(data.mappings) ? data.mappings : undefined,
      customTextEntries: Array.isArray(data.customTextEntries) ? data.customTextEntries : undefined,
      flowGraph: data.flowGraph,
      hasSearchSteps: !!data.hasSearchSteps,
      hasSubmitStep: !!data.hasSubmitStep,
    };
    return { ok: true, template: tpl };
  } catch (e: any) {
    return { ok: false, error: e?.message || "解析失败" };
  }
}
