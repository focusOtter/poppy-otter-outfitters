import type { ApiResult } from "@/lib/carts-api";
import { loginHref } from "@/lib/format";

/** Renders a failed Carts API call as a friendly notice. */
export function ApiNotice({ result, returnTo }: { result: Extract<ApiResult<unknown>, { ok: false }>; returnTo: string }) {
  const showSignIn =
    (result.reason === "sign_in_required" || result.reason === "token_rejected") && result.caller !== "agent_guest";
  return (
    <div className={`notice notice-${result.reason}`}>
      <p>{result.message}</p>
      {showSignIn && (
        <a className="btn btn-primary" href={loginHref(returnTo)}>
          Sign in
        </a>
      )}
    </div>
  );
}
