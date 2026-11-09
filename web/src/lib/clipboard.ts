/**
 * lib/clipboard —— 剪贴板复制（非安全上下文/权限拒绝时返回 false，由调用方提示）。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
