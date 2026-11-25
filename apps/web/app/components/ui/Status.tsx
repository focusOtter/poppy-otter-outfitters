import type { ReactNode } from "react";

export function Status({ tone, children }: { tone: "live" | "ended" | "refused"; children: ReactNode }) {
  return <span className={`status status-${tone}`}>{children}</span>;
}
