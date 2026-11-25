import type { Metadata } from "next";
import { cartsApi, type ActivityEntry } from "@/lib/carts-api";
import { formatWhen } from "@/lib/format";
import { getDriver } from "@/lib/poppy";
import { ApiNotice } from "../components/ApiNotice";
import { Notice } from "../components/ui/Notice";
import { PageHeader } from "../components/ui/PageHeader";
import { Status } from "../components/ui/Status";

export const metadata: Metadata = { title: "Activity | Otter Outfitters" };

export default async function ActivityPage() {
  const driver = await getDriver();
  const isAgent = driver.kind === "agent_guest" || driver.kind === "agent_signed_in";
  const activity = driver.kind === "person" ? await cartsApi.activity(false) : undefined;

  return (
    <>
      <PageHeader title="Shopping activity">
        See which requests you made and which ones your personal agent made for you.
      </PageHeader>
      {isAgent ? (
        <Notice>Only the account owner can see this activity.</Notice>
      ) : !activity ? (
        <Notice signInTo="/activity">Sign in to view activity for your account.</Notice>
      ) : !activity.ok ? (
        <ApiNotice result={activity} returnTo="/activity" />
      ) : (
        <div className="activity-lanes">
          <Lane id="agent-activity" title="Personal agent" entries={activity.data.filter((e) => e.actorType === "guest_agent" || e.actorType === "user_agent")} />
          <Lane id="user-activity" title="You" entries={activity.data.filter((e) => e.actorType === "user")} />
        </div>
      )}
    </>
  );
}

function Lane({ id, title, entries }: { id: string; title: string; entries: ActivityEntry[] }) {
  return (
    <section className="activity-lane" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {entries.length ? (
        <ol className="activity-events">
          {entries.map((e) => (
            <li key={e.id}>
              <div className="activity-event-meta">
                <time dateTime={e.at}>{formatWhen(e.at)}</time>
                <span>{e.actorType === "guest_agent" ? "Guest" : e.actorType === "user_agent" ? "Acting for you" : "Account owner"}</span>
              </div>
              <div className="activity-event-request">
                <code>{e.method} {e.path}</code>
                <Status tone={e.status < 400 ? "live" : "refused"}>{e.status} {e.outcome.replaceAll("_", " ")}</Status>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="muted">No requests to show yet.</p>}
    </section>
  );
}
