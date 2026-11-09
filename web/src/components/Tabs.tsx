/**
 * components/Tabs —— 页内分段（下划线指示器，支持计数徽标）。
 */

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({ items, value, onChange }: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          className={'tab' + (item.id === value ? ' active' : '')}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined ? <span className="tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
