/**
 * components/Field —— 表单字段外壳：标签、scope 徽标、说明与错误。
 */
import type { ReactNode } from 'react';

const SCOPE_LABEL: Record<string, string> = {
  global: '全局',
  bot: '机器人',
  profile: '配置档',
};

export function ScopeBadge({ scope }: { scope?: 'global' | 'bot' | 'profile' | string }) {
  if (!scope) return null;
  return <span className={'scope scope-' + scope}>{SCOPE_LABEL[scope] || scope}</span>;
}

export function Field({ label, htmlFor, help, error, scope, required = false, wide = false, children }: {
  label?: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  error?: ReactNode;
  scope?: 'global' | 'bot' | 'profile' | string;
  required?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={'field' + (wide ? ' wide' : '')}>
      {(label || scope) ? (
        <div className="field-head">
          {label ? (
            <label className="field-label" htmlFor={htmlFor}>
              {label}
              {required ? <span className="required" aria-hidden="true">*</span> : null}
            </label>
          ) : null}
          <ScopeBadge scope={scope} />
        </div>
      ) : null}
      {children}
      {error ? <p className="field-error">{error}</p> : null}
      {help ? <p className="field-help">{help}</p> : null}
    </div>
  );
}
