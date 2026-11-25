import { getDriver } from "@/lib/poppy";
import { ActionForm } from "../components/ActionForm";
import { Notice } from "../components/ui/Notice";
import { PageHeader } from "../components/ui/PageHeader";
import { Panel } from "../components/ui/Panel";
import { updateDisplayName } from "../actions";

export default async function AccountPage() {
  const driver = await getDriver();

  if (driver.kind === "agent_guest") {
    return (
      <>
        <PageHeader title="Account" />
        <Notice>An agent guest has no account here. The customer has to approve the agent first.</Notice>
      </>
    );
  }
  if (driver.kind === "visitor" || driver.kind === "guest") {
    return (
      <>
        <PageHeader title="Account" />
        <Notice signInTo="/account">Sign in to see your account.</Notice>
      </>
    );
  }

  const { user } = driver.session;
  return (
    <>
      <PageHeader title="Account" />
      <dl className="profile">
        <dt>Name</dt>
        <dd>{driver.name}</dd>
        <dt>Email</dt>
        <dd>{(user.email as string | undefined) ?? "None on file"}</dd>
        <dt>Auth0 user ID</dt>
        <dd>
          <code>{user.sub}</code>
        </dd>
      </dl>

      <Panel id="display-name-heading" title="Update display name">
        {driver.kind === "agent_signed_in" && (
          <p className="muted">{"You're signed in as an agent. Account changes are for the customer only."}</p>
        )}
        <ActionForm action={updateDisplayName} label="Save" pendingLabel="Saving…">
          <label className="field">
            <span>Display name</span>
            <input name="name" defaultValue={driver.name} maxLength={60} required />
          </label>
        </ActionForm>
      </Panel>
    </>
  );
}
