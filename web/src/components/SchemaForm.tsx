/**
 * components/SchemaForm —— 由 GET /api/schema 元数据驱动的设置表单。
 *
 * 设置页与配置档编辑器共用：
 *  - 按 section 排序分组，widget 决定控件（switch/radio/select/number/text/textarea/tags/json）；
 *  - values 是“层内已有值”，dirty 是本次编辑的差异（页面保存时只提交差异）；
 *  - 不写死任何字段清单——新增设置只要改 core/config/schema.js。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { SchemaItem, SchemaPayload } from '../api/types';
import { getPath } from '../lib/objects';
import { prettyJson } from '../lib/format';
import { Field } from './Field';

type Widget = 'switch' | 'radio' | 'select' | 'number' | 'text' | 'textarea' | 'tags' | 'json';

function optionsOf(item: SchemaItem): Array<{ value: string; label: string }> {
  const raw = item.values ?? [];
  return raw.map((entry) => (typeof entry === 'string' ? { value: entry, label: entry } : entry));
}

function resolveWidget(item: SchemaItem): Widget {
  const explicit = (item.widget || '').toLowerCase();
  if (['switch', 'radio', 'select', 'number', 'text', 'textarea', 'tags', 'json'].includes(explicit)) {
    return explicit as Widget;
  }
  switch ((item.type || '').toLowerCase()) {
    case 'boolean': return 'switch';
    case 'enum': return 'radio';
    case 'number': return 'number';
    case 'stringarray': return 'tags';
    case 'json': return 'json';
    default: return typeof item.default === 'object' && item.default !== null ? 'json' : 'text';
  }
}

const SCOPE_ORDER: Record<string, number> = { global: 10, bot: 20, profile: 30 };

function TagsInput({ id, value, onChange, disabled }: {
  id: string;
  value: unknown;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const tags = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string' && value !== ''
      ? value.split(',').map((part) => part.trim()).filter(Boolean)
      : [];

  const add = () => {
    const pieces = draft.split(/[,，\s]+/).map((part) => part.trim()).filter(Boolean);
    if (pieces.length === 0) return;
    const next = [...tags];
    for (const piece of pieces) if (!next.includes(piece)) next.push(piece);
    onChange(next);
    setDraft('');
  };

  return (
    <div className={'tags-input' + (disabled ? ' disabled' : '')}>
      {tags.length > 0 ? (
        <div className="tag-list">
          {tags.map((tag, index) => (
            <span key={tag + index} className="chip">
              <span className="mono">{tag}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={'移除 ' + tag}
                disabled={disabled}
                onClick={() => onChange(tags.filter((_, i) => i !== index))}
              >×</button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        id={id}
        className="input tags-entry"
        value={draft}
        placeholder="输入后回车添加，支持逗号批量粘贴"
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); add(); }
          if (event.key === 'Backspace' && draft === '' && tags.length > 0) onChange(tags.slice(0, -1));
        }}
        onBlur={() => { if (draft.trim() !== '') add(); }}
      />
    </div>
  );
}

function JsonInput({ id, value, onChange, disabled }: {
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => prettyJson(value ?? {}));
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef(prettyJson(value ?? {}));

  const commit = (next: string) => {
    setText(next);
    if (next.trim() === '') {
      setError(null);
      lastEmitted.current = '';
      onChange({});
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      lastEmitted.current = prettyJson(parsed);
      setError(null);
      onChange(parsed);
    } catch (err) {
      setError('JSON 不合法：' + (err instanceof Error ? err.message : String(err)));
    }
  };

  useEffect(() => {
    const external = prettyJson(value ?? {});
    if (external === lastEmitted.current) return;
    // 外部值变化（切换配置档/丢弃修改）时同步编辑器内容
    lastEmitted.current = external;
    setText(external);
    setError(null);
  }, [value]);

  return (
    <div className="json-input">
      <textarea
        id={id}
        className="input mono textarea json-area"
        rows={5}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => commit(event.target.value)}
      />
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

function WidgetInput({ item, widget, id, value, onChange, disabled }: {
  item: SchemaItem;
  widget: Widget;
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  const options = optionsOf(item);

  if (widget === 'switch') {
    const on = Boolean(value);
    return (
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={on}
        className={'switch' + (on ? ' on' : '')}
        disabled={disabled}
        onClick={() => onChange(!on)}
      >
        <span className="switch-thumb" aria-hidden="true" />
        <span className="switch-text">{on ? '开启' : '关闭'}</span>
      </button>
    );
  }

  if (widget === 'radio') {
    return (
      <div className="segmented" role="group" aria-labelledby={id}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={'seg-btn' + (String(value ?? '') === option.value ? ' active' : '')}
            aria-pressed={String(value ?? '') === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  if (widget === 'select') {
    return (
      <select
        id={id}
        className="input"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">跟随默认 / 留空</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  if (widget === 'number') {
    return (
      <input
        id={id}
        type="number"
        className="input mono"
        value={typeof value === 'number' ? value : value === undefined || value === null || value === '' ? '' : String(value)}
        min={item.min}
        max={item.max}
        step={item.step}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
      />
    );
  }

  if (widget === 'textarea') {
    return (
      <textarea
        id={id}
        className="input textarea"
        rows={4}
        value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (widget === 'tags') {
    return <TagsInput id={id} value={value} disabled={disabled} onChange={onChange} />;
  }

  if (widget === 'json') {
    return <JsonInput id={id} value={value} disabled={disabled} onChange={onChange} />;
  }

  return (
    <input
      id={id}
      type="text"
      className="input"
      value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function SchemaForm({ payload, values, dirty, onChange, scopes, showScope = true, disabled = false }: {
  payload: SchemaPayload;
  values: Record<string, unknown>;
  dirty: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  scopes?: Array<'global' | 'bot' | 'profile'>;
  showScope?: boolean;
  disabled?: boolean;
}) {
  const groups = useMemo(() => {
    const sectionMap = new Map(payload.sections.map((section) => [section.id, section]));
    const items = payload.items.filter((item) => !scopes || (item.scope && scopes.includes(item.scope)));
    const grouped = new Map<string, { section: { id: string; label: string; order: number; desc?: string }; items: SchemaItem[] }>();
    for (const item of items) {
      const sectionId = item.section || 'other';
      let entry = grouped.get(sectionId);
      if (!entry) {
        const section = sectionMap.get(sectionId);
        entry = {
          section: {
            id: sectionId,
            label: section?.label || (sectionId === 'other' ? '其他' : sectionId),
            order: section?.order ?? (sectionId === 'other' ? 999 : 500),
            desc: section?.desc,
          },
          items: [],
        };
        grouped.set(sectionId, entry);
      }
      entry.items.push(item);
    }
    return [...grouped.values()].sort((a, b) => {
      if (a.section.order !== b.section.order) return a.section.order - b.section.order;
      return SCOPE_ORDER[a.section.id] ?? 0;
    });
  }, [payload, scopes]);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="schema-form">
      {groups.map((group) => (
        <section className="schema-section" key={group.section.id}>
          <header className="schema-section-head">
            <h2 className="schema-section-title">{group.section.label}</h2>
            {group.section.desc ? <p className="schema-section-desc">{group.section.desc}</p> : null}
          </header>
          <div className="fields-grid">
            {group.items.map((item) => {
              const widget = resolveWidget(item);
              const value = Object.prototype.hasOwnProperty.call(dirty, item.key)
                ? dirty[item.key]
                : getPath(values, item.key, item.default);
              const wide = widget === 'textarea' || widget === 'json' || widget === 'tags';
              return (
                <Field
                  key={item.key}
                  label={item.label || item.key}
                  htmlFor={'schema-' + item.key}
                  help={item.help}
                  scope={showScope ? item.scope : undefined}
                  wide={wide}
                >
                  <WidgetInput
                    item={item}
                    widget={widget}
                    id={'schema-' + item.key}
                    value={value}
                    disabled={disabled}
                    onChange={(next) => onChange(item.key, next)}
                  />
                </Field>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 设置表单的分组顺序导出给页面做骨架/传参。 */
export type { Widget };
