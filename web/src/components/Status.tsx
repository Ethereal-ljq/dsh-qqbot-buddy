/**
 * components/Status —— 状态点、徽标与来源标签。
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'idle' | 'info';

export function StatusDot({ tone = 'idle', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className={'dot ' + tone + (pulse ? ' pulse' : '')} aria-hidden="true" />;
}

export function Badge({ tone = 'idle', children, mono = false }: { tone?: Tone; children: React.ReactNode; mono?: boolean }) {
  return <span className={'badge ' + tone + (mono ? ' mono' : '')}>{children}</span>;
}

const SOURCE_LABEL: Record<string, string> = {
  host: '宿主',
  plugin: '插件',
  mcp: 'MCP',
  skill: '技能',
  qqbot: 'QQBot',
  builtin: '内置',
  local: '本地',
};

/** 工具/技能来源标签（宿主的工具发现结果）。 */
export function SourceTag({ source }: { source?: string }) {
  const key = (source || 'host').toLowerCase();
  return <span className={'tag source-' + key}>{SOURCE_LABEL[key] || source}</span>;
}

/** 运行状态 → 文案与色调（兼容 starting/stopping/error 等常见值）。 */
export function runtimeTone(status?: string): { tone: Tone; label: string } {
  switch ((status || '').toLowerCase()) {
    case 'online':
    case 'running':
    case 'ready':
    case 'connected':
      return { tone: 'ok', label: '运行中' };
    case 'starting':
    case 'connecting':
      return { tone: 'warn', label: '启动中' };
    case 'stopping':
      return { tone: 'warn', label: '停止中' };
    case 'error':
    case 'failed':
    case 'offline':
      return { tone: 'danger', label: '异常' };
    case 'stopped':
    case 'disabled':
    case 'idle':
      return { tone: 'idle', label: '已停止' };
    default:
      return { tone: 'idle', label: status || '未知' };
  }
}
