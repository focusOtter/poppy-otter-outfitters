import { disconnectAgent } from "@/app/actions";
import type { AgentConnection } from "@/lib/carts-api";
import { formatWhen } from "@/lib/format";
import { ActionForm } from "../ActionForm";
import { Status } from "../ui/Status";
import { AgentEmptyState } from "./AgentEmptyState";

export function AgentList({ agents, origin }: { agents: AgentConnection[]; origin: string }) {
  if (!agents.length) return <AgentEmptyState origin={origin} />;

  return (
    <ul className="agent-list">
      {agents.map((a) => (
        <li key={a.sessionKey} className="agent-row">
          <div className="agent-id">
            <code>{a.agent}</code>
            <span className="muted">
              Last active {formatWhen(a.lastSeen)} · {a.requests} requests · {a.orders} orders
            </span>
          </div>
          {a.endedAt ? (
            <Status tone="ended">Disconnected</Status>
          ) : (
            <div className="agent-actions">
              <Status tone="live">Connected</Status>
              <ActionForm
                action={disconnectAgent}
                label="Disconnect"
                pendingLabel="Disconnecting…"
                variant="secondary"
                hidden={{ sessionKey: a.sessionKey }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
