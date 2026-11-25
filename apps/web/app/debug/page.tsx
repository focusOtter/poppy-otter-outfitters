import { auth0 } from "@/lib/auth0";
import { cartsApi } from "@/lib/carts-api";
import { getDriver } from "@/lib/poppy";
import { PageHeader } from "../components/ui/PageHeader";
import { CodeBlock } from "../components/debug/CodeBlock";
import { CopyButton } from "../components/debug/CopyButton";
import { KeyValueList } from "../components/debug/KeyValueList";

const DISCOVERY_FILES = ["/.well-known/poppy.json", "/.well-known/oauth-protected-resource"];
// The Carts API's address can be an internal host (docs/deploy.md), so a production build shows it only with
// SHOW_DEBUG_DETAILS=1. Everything else on this page is the viewer's own session.
const SHOW_API_ADDRESS = process.env.NODE_ENV !== "production" || process.env.SHOW_DEBUG_DETAILS === "1";

export default async function DebugPage() {
  const [poppy, session, anon, driver] = await Promise.all([
    auth0.poppy.getContext(),
    auth0.getSession(),
    auth0.getAnonymousSession(),
    getDriver()
  ]);
  const whoami = await cartsApi.whoami();

  // Whose anonymous session this is. Without a user session, auth0.poppy.getContext() reports an agent guest as an agent;
  // with one, a leftover anonymous session is a person's guest cart that proxy.ts merges on the next request.
  const anonOwner = !anon
    ? null
    : session
      ? "Guest session left from before sign-in (merged and ended by proxy.ts)"
      : poppy.kind === "agent"
        ? "Agent guest (Poppy)"
        : "Person's guest session";

  const whoamiStatus = whoami.ok || whoami.status ? ` · ${whoami.status}` : "";

  return (
    <div className="debug">
      <PageHeader title="Debug">Live auth state for this request. Tokens are never shown.</PageHeader>

      <section aria-labelledby="ctx" className="panel">
        <h2 id="ctx">Poppy context</h2>
        <CodeBlock label="auth0.poppy.getContext()" data={poppy} />
      </section>

      <section aria-labelledby="sessions" className="panel">
        <h2 id="sessions">Sessions</h2>
        <KeyValueList
          rows={[
            { label: <code>getSession()</code>, value: session ? session.user.sub : null, note: session && "user.sub" },
            {
              label: <code>getAnonymousSession()</code>,
              value: anon ? anon.id : null,
              note: anon && `${anonOwner} · expires ${new Date(anon.expiresAt * 1000).toISOString()}`
            },
            { label: <code>getDriver()</code>, value: driver.kind, copy: false },
            {
              label: "Anonymous audience",
              value: process.env.AUTH0_AUDIENCE ?? "(tenant default)",
              note: (
                <>
                  Scope <code>cart:write</code>, kept on login so the guest cart can be merged.
                </>
              )
            }
          ]}
        />
      </section>

      <section aria-labelledby="discovery" className="panel">
        <h2 id="discovery">Discovery files</h2>
        <ul className="link-list">
          {DISCOVERY_FILES.map((path) => (
            <li key={path}>
              <a href={path}>
                <code>{path}</code>
              </a>
              <CopyButton value={path} label="Copy path" />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="whoami" className="panel">
        <h2 id="whoami">Carts API</h2>
        <KeyValueList
          rows={[
            ...(SHOW_API_ADDRESS ? [{ label: "Base URL", value: cartsApi.baseUrl }] : []),
            { label: "Called as", value: whoami.caller, copy: false }
          ]}
        />
        <CodeBlock
          label={`GET /whoami${whoamiStatus}`}
          data={whoami.ok ? whoami.data : { reason: whoami.reason, message: whoami.message }}
        />
      </section>
    </div>
  );
}
