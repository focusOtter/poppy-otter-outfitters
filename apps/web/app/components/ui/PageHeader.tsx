import type { ReactNode } from "react";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1 className="page-title text-balance">{title}</h1>
      {children && <p className="lede text-pretty">{children}</p>}
    </header>
  );
}
