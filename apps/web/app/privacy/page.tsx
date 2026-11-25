import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "../components/ui/PageHeader";
import { Panel } from "../components/ui/Panel";

export const metadata: Metadata = {
  title: "Privacy | Otter Outfitters",
  description: "What we keep about you and why."
};

// What the sample keeps, where and for how long. Every statement is checked against the code: keep it true when the
// storage, cookies or logging change. apps/web-express/src/views.js has the same text (`privacy`); change both.
// apps/web-express/test/privacy-text.test.js fails when the two differ, apart from the differences it lists.
export default function PrivacyPage() {
  return (
    <article className="privacy">
      <PageHeader title="Privacy">What we keep about you and why.</PageHeader>

      <div className="privacy-intro">
        <p>
          We keep what we need to run your orders: your name, email address and order history. Otter Outfitters is a demo
          store: nothing ships, every order goes to one sample address, and no money moves.
        </p>
        <p>
          Your account and your orders are kept until they are deleted. Inactive accounts are not deleted automatically.
        </p>
      </div>

      <Panel id="privacy-keep" title="What we keep">
        <ul className="privacy-list">
          <li>
            <strong>Your account.</strong> Your account is a user profile on the store&apos;s Auth0 tenant. Auth0 keeps your
            email address, your name, your password (which the store never sees), when you signed up and last logged in,
            and the IP address of your last login. Auth0 also records sign-ups and logins in the tenant&apos;s logs, and
            keeps those logs for 1 to 30 days, depending on the tenant&apos;s Auth0 plan.
          </li>
          <li>
            <strong>Carts and orders.</strong> The store keeps carts and orders in Neon Postgres. An order records what
            you bought and for how much, when, your account ID, the sample address, the test card used and the agent that
            placed it, if any. Orders don&apos;t expire. If you add to the cart before signing in, the store keeps the
            cart under a guest ID so you can keep shopping after you sign in.
          </li>
          <li>
            <strong>Checkout retries.</strong> When a checkout request carries an Idempotency-Key, the Carts API keeps its
            answer for 24 hours, in the same place as your orders, so a retry gets that answer instead of placing a second
            order. For a placed order, that answer is a copy of the order, with the details listed above.
          </li>
          <li>
            <strong>Request log.</strong> The Carts API keeps activity in Neon Postgres so you can view your own actions
            separately from your agent&apos;s. The log records the time, request method, route, result, and any verified
            account, agent and session identifiers. It holds no tokens or request bodies.
          </li>
          <li>
            <strong>Hosting.</strong> The store runs on Vercel, which keeps request logs, such as the page requested and
            when, under{" "}
            <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">
              Vercel&apos;s privacy policy
            </a>
            . The store&apos;s own code writes only errors and warnings to them.
          </li>
          <li>
            <strong>Analytics.</strong> None. The store&apos;s code includes no analytics, advertising or tracking scripts.
          </li>
        </ul>
      </Panel>

      <Panel id="privacy-cards" title="Payment cards">
        <p>
          Only the test card 4242 4242 4242 4242 is accepted. The test card 4000 0000 0000 0002 is declined, to show a
          failed payment. Payments are simulated: no payment provider is involved and no payment is taken. An order keeps
          the card&apos;s brand, its last four digits and a simulated payment reference, never the full number.
        </p>
      </Panel>

      <Panel id="privacy-agents" title="Personal agents">
        <p>
          When a personal agent shops here, we record which agent it is, when it first and last made a request, how many
          requests and orders it made and, once you sign it in, your account ID. Orders an agent places are marked with the
          agent&apos;s URL or ID. Agents you approve can shop and check out for you; they can&apos;t change your account.
        </p>
        <p>
          On the <Link href="/agents">Agents page</Link> you can see the agents connected to your account and disconnect
          any of them. Disconnecting ends the agent&apos;s session with the store. Agent records stay in the database;
          disconnected sessions are marked as ended.
        </p>
      </Panel>

      <Panel id="privacy-cookies" title="Cookies">
        <p>This site sets cookies only to sign you in and to keep your cart. Its cookies are:</p>
        <ul className="privacy-list">
          <li>a session cookie that keeps you signed in;</li>
          <li>
            a guest cookie, when you add to the cart before signing in or when a personal agent shops as a guest. It is
            removed once your guest cart moves into your account;
          </li>
          <li>short-lived cookies while you sign in.</li>
        </ul>
        <p>
          The session and guest cookies are encrypted. There are no analytics or advertising cookies. While you sign in,
          Auth0 also sets its own cookies on its sign-in domain.
        </p>
      </Panel>

      <Panel id="privacy-delete" title="Deleting your data">
        <p>
          You can remove items from your cart at any time. To delete your account, ask through Okta&apos;s{" "}
          <a href="https://preferences.okta.com/privacy/" target="_blank" rel="noopener noreferrer">
            online privacy form
          </a>{" "}
          or at <a href="mailto:privacy@okta.com">privacy@okta.com</a>. You can also call 888-655-1161 (toll-free in the
          USA) or write to Okta, Inc. (including its subsidiary, Auth0 LLC), ATTN: Okta Data Protection Officer
          (Okta Privacy Team), 100 First Street, Floor 6, San Francisco, CA 94105, USA.
        </p>
        <p>
          Deleting an account permanently removes its Auth0 user profile. Your orders and agent records are kept in the
          store&apos;s own database, not in Auth0, so deleting the account doesn&apos;t remove them: ask for them to be
          deleted too.
        </p>
        <p>
          The full{" "}
          <a href="https://www.okta.com/legal/privacy-policy/" target="_blank" rel="noopener noreferrer">
            Okta Privacy Policy
          </a>{" "}
          lists these contacts and your other privacy rights.
        </p>
      </Panel>
    </article>
  );
}
