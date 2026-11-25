import type { ReactNode } from "react";
import { loginHref } from "@/lib/format";

/** A short message, with a "Sign in" button when `signInTo` is set. */
export function Notice({ children, signInTo }: { children: ReactNode; signInTo?: string }) {
  return (
    <div className={signInTo ? "notice notice-signin" : "notice"}>
      <p>{children}</p>
      {signInTo && (
        <a className="btn btn-primary" href={loginHref(signInTo)}>
          Sign in
        </a>
      )}
    </div>
  );
}
