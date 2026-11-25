import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { cartsApi } from "@/lib/carts-api";
import { getDriver } from "@/lib/poppy";
import { ActivityTable } from "../components/agents/ActivityTable";
import { AgentList } from "../components/agents/AgentList";
import { ApiNotice } from "../components/ApiNotice";
import { Notice } from "../components/ui/Notice";
import { PageHeader } from "../components/ui/PageHeader";
import { Panel } from "../components/ui/Panel";

export const metadata: Metadata = { title: "Connected agents | Otter Outfitters" };

// The origin the visitor actually reached, so the copied prompt works on previews as well as production.
async function siteOrigin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return process.env.APP_BASE_URL ?? "http://localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// The customer's view of the agents acting for them: who is connected, what they did, and a way to cut them off.
export default async function AgentsPage() {
  const driver = await getDriver();

  if (driver.kind === "agent_guest" || driver.kind === "agent_signed_in") {
    return (
      <>
        <PageHeader title="Connected agents" />
        <Notice>Only the customer can see and manage their connected agents.</Notice>
      </>
    );
  }

  if (driver.kind !== "person") {
    return (
      <>
        <PageHeader title="Connected agents" />
        <Notice signInTo="/agents">Sign in to see the agents that shop for you, and disconnect any of them.</Notice>
      </>
    );
  }

  const [agents, activity, origin] = await Promise.all([cartsApi.agents(), cartsApi.activity(), siteOrigin()]);

  return (
    <div className="agents-page">
      <PageHeader title="Connected agents">
        Agents you approved can shop and check out for you. They can never change your account.{" "}
        <Link href="/orders?via=agent" className="accent-orange-link">
          See orders placed by agents
        </Link>
        .
      </PageHeader>

      <Panel id="agents-heading" title="Agents">
        {agents.ok ? <AgentList agents={agents.data} origin={origin} /> : <ApiNotice result={agents} returnTo="/agents" />}
      </Panel>

      <Panel id="activity-heading" title="Recent agent activity">
        {activity.ok ? <ActivityTable entries={activity.data} /> : <ApiNotice result={activity} returnTo="/agents" />}
      </Panel>
    </div>
  );
}
