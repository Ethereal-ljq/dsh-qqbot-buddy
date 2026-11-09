/**
 * core/kb/chunk —— Markdown 文本分块（纯函数，无 IO，可单测）。
 *
 * 职责：把知识源文本切成检索友好的块：
 * 1) 标题优先：先按 Markdown 标题（# 到 ######）分节；围栏代码块内的 # 不算标题；
 * 2) 节内滑窗：正文超过 maxChars 时按 maxChars/overlap 滑窗切分，
 *    窗口步长 = maxChars - overlap，overlap 的单位是“字符”（Unicode 码点）；
 * 3) CJK/emoji 安全：所有切片基于码点数组，绝不切断 UTF-16 代理对；
 * 4) 返回 [{ text, heading }]，heading 是该块所属标题（无标题为空串），便于上层展示。
 */
export const DEFAULT_MAX_CHARS = 800;
export const DEFAULT_OVERLAP = 80;

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;

/**
 * Markdown 分块入口。
 * @param {string} markdown 原文
 * @param {{ maxChars?: number, overlap?: number }} [options]
 * @returns {{ text: string, heading: string }[]}
 */
export function chunkMarkdown(markdown, options = {}) {
  const text = normalizeMarkdown(markdown);
  const { maxChars, overlap } = normalizeOptions(options);
  if (!text.trim()) return [];
  const chunks = [];
  for (const section of splitMarkdownSections(text)) {
    const body = section.text.trim();
    if (!body) continue;
    for (const piece of slideByCodePoints(body, maxChars, overlap)) {
      chunks.push({ text: piece, heading: section.heading });
    }
  }
  return chunks;
}

/**
 * 只做分节不滑窗：按 Markdown 标题切段，返回 [{ heading, level, text }]。
 * 第一个标题之前的内容作为 heading='' 的前言段保留。
 */
export function splitMarkdownSections(markdown) {
  const lines = normalizeMarkdown(markdown).split('\n');
  const sections = [];
  let current = { heading: '', level: 0, lines: [] };
  let inFence = false;
  const flush = () => {
    sections.push({
      heading: current.heading,
      level: current.level,
      text: current.lines.join('\n').replace(/^\n+|\n+$/g, ''),
    });
  };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const matched = inFence ? null : HEADING_RE.exec(line);
    if (matched) {
      flush();
      current = { heading: matched[2].trim(), level: matched[1].length, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * 按码点滑窗：窗口长度 maxChars，重叠 overlap。窗口边界不在代理对中间。
 * 长度不超过 maxChars 的正文原样返回一块。
 */
export function slideByCodePoints(text, maxChars = DEFAULT_MAX_CHARS, overlap = DEFAULT_OVERLAP) {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError('slideByCodePoints: maxChars 必须是 >= 1 的整数');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChars) {
    throw new RangeError('slideByCodePoints: overlap 必须是 [0, maxChars) 内的整数');
  }
  const source = String(text ?? '');
  if (!source.trim()) return [];
  const chars = Array.from(source);
  if (chars.length <= maxChars) return [source.trim()];
  const step = maxChars - overlap;
  const windows = [];
  for (let start = 0; start < chars.length; start += step) {
    const end = Math.min(start + maxChars, chars.length);
    const piece = chars.slice(start, end).join('').trim();
    if (piece) windows.push(piece);
    if (end >= chars.length) break;
  }
  return windows;
}

/** 统一换行符并去掉结尾多余空行。 */
export function normalizeMarkdown(markdown) {
  return String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

function normalizeOptions(options) {
  const rawMax = options.maxChars === undefined ? DEFAULT_MAX_CHARS : Number(options.maxChars);
  if (!Number.isInteger(rawMax) || rawMax < 1) {
    throw new RangeError('chunkMarkdown: maxChars 必须是 >= 1 的整数');
  }
  const rawOverlap = options.overlap === undefined
    ? Math.min(DEFAULT_OVERLAP, rawMax - 1)
    : Number(options.overlap);
  if (!Number.isInteger(rawOverlap) || rawOverlap < 0 || rawOverlap >= rawMax) {
    throw new RangeError('chunkMarkdown: overlap 必须是 [0, maxChars) 内的整数');
  }
  return { maxChars: rawMax, overlap: rawOverlap };
}
