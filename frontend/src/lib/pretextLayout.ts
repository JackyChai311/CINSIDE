/**
 * PRETEXT 文本布局封装（@chenglou/pretext）。
 *
 * 用途：在执行步骤气泡里，预先算出「一段文案在固定宽度下会占几行」，从而
 *   1) 把气泡框高度压成固定值（最多 N 行），避免每来一条步骤就触发浏览器重排；
 *   2) 超出行数上限的文本提前截断，避免长文案把气泡撑高、互相遮挡。
 *
 * pretext 用 Canvas 测字 + 纯算术换行，layout() 全程零 DOM 读取，
 * 因此不会像 getBoundingClientRect 那样强制同步重排。
 */
import { prepare, layout } from "@chenglou/pretext";

/** 气泡正文的字体族（与 index.css / tailwind fontFamily.sans 保持一致） */
const BUBBLE_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', Roboto, sans-serif";

/** 气泡正文样式常量：球槽变体为 10px（见 ExecutionBubbles），单行行高按 1.25 计 */
export const BUBBLE_FONT_SIZE = 10;
export const BUBBLE_LINE_HEIGHT = Math.round(BUBBLE_FONT_SIZE * 1.25); // 13px
/** 气泡正文可用宽度（200px 气泡 - 左右 padding 16px - 图标+间距约 20px） */
export const BUBBLE_TEXT_WIDTH = 164;
/** 气泡文案最多显示行数 */
export const BUBBLE_MAX_LINES = 4;

const bubbleFont = `${BUBBLE_FONT_SIZE}px ${BUBBLE_FONT_FAMILY}`;

// 测量结果缓存：同一条文案只 prepare 一次（prepare 内部已做 segment 级缓存，
// 这里再缓存整体行数，避免每条气泡都走一遍 prepare 调用开销）
const lineCountCache = new Map<string, number>();
const CACHE_LIMIT = 500;

/**
 * 计算文本在气泡固定宽度下占用的行数（纯算术，无 DOM 读取）。
 * 文本为空 / pretext 不可用时返回 1，保证调用方拿到安全值。
 */
export function measureBubbleLines(text: string): number {
  const t = (text || "").trim();
  if (!t) return 1;
  const cached = lineCountCache.get(t);
  if (cached !== undefined) return cached;

  let lines = 1;
  try {
    const prepared = prepare(t, bubbleFont);
    const res = layout(prepared, BUBBLE_TEXT_WIDTH, BUBBLE_LINE_HEIGHT);
    lines = Math.max(1, res.lineCount | 0);
  } catch {
    // pretext 在极端环境下（无 Canvas）可能抛错，退回按字数粗估
    lines = Math.max(1, Math.ceil(t.length / 20));
  }

  if (lineCountCache.size >= CACHE_LIMIT) lineCountCache.clear();
  lineCountCache.set(t, lines);
  return lines;
}

/**
 * 把文本截断到最多 maxLines 行（用 pretext 的逐行 API 精确切分），
 * 超出部分以省略号结尾。返回截断后的文本与实际行数。
 */
export function truncateToLines(
  text: string,
  maxLines: number = BUBBLE_MAX_LINES
): { text: string; lines: number; truncated: boolean } {
  const t = (text || "").trim();
  if (!t) return { text: "", lines: 1, truncated: false };

  const total = measureBubbleLines(t);
  if (total <= maxLines) return { text: t, lines: total, truncated: false };

  // 超行：按行容量估算保留字符数（中英文混排按可用宽度与总行数比例切）
  // 用 pretext 的精确行数反推每行平均字符数，避免误截
  const keepRatio = maxLines / total;
  const keepChars = Math.max(1, Math.floor(t.length * keepRatio) - 1);
  const cut = t.slice(0, keepChars).replace(/[\s,，。;；:：]+$/, "");
  return { text: cut + "…", lines: maxLines, truncated: true };
}
