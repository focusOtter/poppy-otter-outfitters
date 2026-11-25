import type { ReactNode } from "react";

export function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="panel">
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}
