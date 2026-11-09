/**
 * components/Mark —— 控制台标记（方框 + 对话缺口），品牌与空态共用。
 */

export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="1.75" y="1.75" width="20.5" height="20.5" rx="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 8.5h11v7.2h-5.4L8.4 18.2v-2.5H6.5z" fill="currentColor" />
    </svg>
  );
}
