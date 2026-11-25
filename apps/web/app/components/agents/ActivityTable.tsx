import type { ActivityEntry } from "@/lib/carts-api";
import { formatWhen } from "@/lib/format";
import { Status } from "../ui/Status";

export function ActivityTable({ entries }: { entries: ActivityEntry[] }) {
  if (!entries.length) return <p className="muted">Nothing yet.</p>;

  return (
    <div className="table-scroll activity-table">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Request</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 50).map((e) => (
            <tr key={e.id}>
              <td className="nowrap">{formatWhen(e.at)}</td>
              <td>
                <code>{e.agent}</code>
              </td>
              <td>
                <code>
                  {e.method} {e.path}
                </code>
              </td>
              <td>
                <Status tone={e.status < 400 ? "live" : "refused"}>
                  {e.status} {e.outcome}
                </Status>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
