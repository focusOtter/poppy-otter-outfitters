"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/lib/action-result";

type Props = {
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  label: string;
  pendingLabel?: string;
  hidden?: Record<string, string>;
  variant?: "primary" | "secondary" | "link";
  children?: React.ReactNode;
};

function Submit({ label, pendingLabel, variant }: Pick<Props, "label" | "pendingLabel" | "variant">) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn btn-${variant ?? "primary"}`} disabled={pending}>
      {pending ? pendingLabel ?? "Working…" : label}
    </button>
  );
}

/** A form bound to a server action that renders the action's message inline. */
export function ActionForm({ action, label, pendingLabel, hidden, variant, children }: Props) {
  const [state, formAction] = useActionState(action, { ok: true });
  return (
    <form action={formAction} className="action-form">
      {hidden &&
        Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      {children}
      <Submit label={label} pendingLabel={pendingLabel} variant={variant} />
      {state.message && (
        <p className={state.ok ? "form-note ok" : "form-note err"} role="status">
          {state.message}{" "}
          {state.signInReturnTo && (
            // A plain <a>, not <Link>: /auth/login is an SDK route served from proxy.ts, not a page.
            <>
            <a href={`/auth/login?returnTo=${encodeURIComponent(state.signInReturnTo)}`}>Sign in</a> or{" "}
            <a href={`/auth/login?screen_hint=signup&returnTo=${encodeURIComponent(state.signInReturnTo)}`}>create an account</a>
          </>
          )}
        </p>
      )}
    </form>
  );
}
