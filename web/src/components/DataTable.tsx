/**
 * components/DataTable —— 高密度数据表（表头吸顶、加载骨架、空态与错误行）。
 * 所有列表页共用，保证行高、字号、对齐一致。
 */
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  title: ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T, index: number) => ReactNode;
}

export function DataTable<T>({
  columns, rows, rowKey, loading = false, error, empty, footer, skeletonRows = 5, className = '',
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  error?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  skeletonRows?: number;
  className?: string;
}) {
  return (
    <div className={'table-wrap ' + className}>
      <table className="data-table" aria-busy={loading || undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={column.align ? 'align-' + column.align : undefined}
                scope="col"
              >
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: skeletonRows }, (_, rowIndex) => (
              <tr key={'skeleton-' + rowIndex} className="skeleton-row">
                {columns.map((column) => (
                  <td key={column.key}><span className="skeleton" /></td>
                ))}
              </tr>
            ))
          ) : error ? (
            <tr><td colSpan={columns.length}><div className="table-state">{error}</div></td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={columns.length}><div className="table-state">{empty ?? '暂无数据'}</div></td></tr>
          ) : (
            rows.map((row, index) => (
              <tr key={rowKey(row, index)}>
                {columns.map((column) => (
                  <td key={column.key} className={column.align ? 'align-' + column.align : undefined}>
                    {column.render(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {footer ? <div className="table-foot">{footer}</div> : null}
    </div>
  );
}
