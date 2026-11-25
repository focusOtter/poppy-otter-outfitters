import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";

export type KeyValueRow = {
  label: ReactNode;
  value: string | null;
  note?: ReactNode;
  copy?: boolean;
};

export function KeyValueList({ rows }: { rows: KeyValueRow[] }) {
  return (
    <dl className="kv">
      {rows.map((row, i) => (
        <div key={i} className="kv-row">
          <dt>{row.label}</dt>
          <dd>
            <div className="kv-value">
              {row.value === null ? <span className="kv-null">null</span> : <code>{row.value}</code>}
              {row.copy !== false && row.value !== null && <CopyButton value={row.value} />}
            </div>
            {row.note && <p className="kv-note">{row.note}</p>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
