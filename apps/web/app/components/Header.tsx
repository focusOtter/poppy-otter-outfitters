import Link from "next/link";
import { getDriver } from "@/lib/poppy";
import { CartLink } from "./CartLink";
import { NavLinks } from "./NavLinks";

export async function Header() {
  const driver = await getDriver();
  // A signed-in agent acts in the customer's account, so it gets Log out like a person.
  const signedIn = driver.kind === "person" || driver.kind === "agent_signed_in";

  return (
    <>
      {/* Tell the customer (and the agent) when an agent is driving. People see no banner. */}
      {driver.kind === "agent_guest" && (
        <div className="driving-banner guest" role="note">
          <span className="banner-tag">Agent</span>
          Shopping via <code>{driver.agent.clientId}</code> as a guest
        </div>
      )}
      {driver.kind === "agent_signed_in" && (
        <div className="driving-banner signed-in" role="note">
          <span className="banner-tag">Agent</span>
          Shopping via <code>{driver.agent.clientId}</code>, signed in as <strong>{driver.name}</strong>
        </div>
      )}
      <header className="site-header">
        <div className="wrap header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden />
            Otter Outfitters
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLinks />
          </nav>
          <div className="auth">
            {driver.kind === "person" && <span className="who">{driver.name}</span>}
            {driver.kind === "guest" && <span className="who">Guest</span>}
            <CartLink />
            {signedIn ? (
              <a href="/auth/logout" className="btn btn-ghost">
                Log out
              </a>
            ) : (
              <>
                <a href="/auth/login" className="btn btn-ghost">
                  Log in
                </a>
                <a href="/auth/login?screen_hint=signup" className="btn btn-primary">
                  Sign up
                </a>
              </>
            )}
          </div>
        </div>
      </header>
    </>
  );
}
