// What agents did, kept so developers can debug a run and customers can see which agents act for them.
//
// The request log is in memory: one process, gone on restart. In production, write these records to your log pipeline
// or a table. They hold identifiers only, never a Session JWT, an access token or a request body.

import { MemoryConnectionStore } from './storage/memory.js';
import type { AgentConnection, ConnectionStore } from './storage/index.js';
import type { Caller } from './auth.js';

export type { AgentConnection } from './storage/index.js';

/** `unverified`: the request carried a Poppy-Session header or a token that failed verification. */
export type CallerKind = 'agent_guest' | 'agent_signed_in' | 'person' | 'guest' | 'unverified';
export type ActorType = 'guest_agent' | 'user_agent' | 'user';

export interface ActivityEntry {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number;
  /** `ok`, or the `error` code the API answered with (`sign_in_required`, `session_ended`, `policy_denied`, ...). */
  outcome: string;
  /** A one-line human explanation of the outcome. */
  detail?: string;
  caller: CallerKind;
  actorType?: ActorType;
  actorSub?: string;
  actorClientId?: string;
  poppySid?: string;
  /** The agent's client metadata URL, when a `Poppy-Session` header was verified. */
  agent?: string;
  /** `poppy.key`: one Session of one User, built from the Session ID and the User ID. */
  sessionKey?: string;
  /** The account the request ran as, if any. */
  account?: string;
  durationMs: number;
}

const MAX_ENTRIES = 500;
type Event = Omit<ActivityEntry, 'id'>;
type ActivityFilter = { account?: string; agentOnly?: boolean; limit?: number };

export interface ActivityStore {
  insert(event: Event): Promise<void>;
  list(filter: ActivityFilter): Promise<ActivityEntry[]>;
}

export function attribute(who?: Caller): Pick<Event, 'caller' | 'actorType' | 'actorSub' | 'actorClientId' | 'poppySid' | 'agent' | 'sessionKey' | 'account'> {
  const account = who?.account ?? undefined;
  if (!who?.poppy) {
    if (account) return { caller: 'person', actorType: 'user', account };
    return { caller: who?.claims ? 'guest' : 'unverified' };
  }

  const signedIn = who.poppy.state === 'signed_in' && !!account;
  const act = who.claims?.act;
  return {
    caller: signedIn ? 'agent_signed_in' : 'agent_guest',
    actorType: signedIn ? 'user_agent' : 'guest_agent',
    account: signedIn ? account : undefined,
    actorSub: typeof act?.sub === 'string' ? act.sub : undefined,
    actorClientId: act && 'client_id' in act && typeof act.client_id === 'string' ? act.client_id : undefined,
    poppySid: who.poppy.sessionId,
    agent: who.poppy.agent.id,
    sessionKey: who.poppy.key,
  };
}

export class ActivityLog {
  readonly #entries: ActivityEntry[] = [];
  readonly #connections: ConnectionStore;
  #nextId = 1;

  constructor(connections: ConnectionStore = new MemoryConnectionStore(), private readonly store?: ActivityStore) {
    this.#connections = connections;
  }

  async record(entry: Event): Promise<void> {
    if (this.store) await this.store.insert(entry);
    else {
      this.#entries.push({ id: this.#nextId++, ...entry });
      if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    }
    if (entry.agent && entry.sessionKey) {
      await this.#connections.touch({
          sessionKey: entry.sessionKey,
          agent: entry.agent,
          account: entry.account,
          at: entry.at,
          placedOrder: entry.method === 'POST' && entry.path === '/orders' && entry.status === 201,
      });
    }
  }

  /** Newest first. With `account`, only that account's requests and the agent Sessions joined to it. */
  async list(filter: ActivityFilter = {}): Promise<ActivityEntry[]> {
    if (this.store) return this.store.list(filter);
    const sessionKeys = filter.account
      ? new Set((await this.connections(filter.account)).map((connection) => connection.sessionKey))
      : undefined;
    return this.#entries
      .filter((entry) => !filter.agentOnly || entry.agent)
      .filter(
        (entry) =>
          !filter.account ||
          entry.account === filter.account ||
          (entry.sessionKey !== undefined && sessionKeys?.has(entry.sessionKey))
      )
      .slice(-(filter.limit ?? 100))
      .reverse();
  }

  connections(account?: string): Promise<AgentConnection[]> {
    return this.#connections.list(account);
  }

  connection(sessionKey: string): Promise<AgentConnection | undefined> {
    return this.#connections.get(sessionKey);
  }

  markEnded(sessionKey: string): Promise<void> {
    return this.#connections.markEnded(sessionKey, new Date().toISOString());
  }
}
