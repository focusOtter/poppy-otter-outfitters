import { randomUUID } from 'node:crypto';
import { PoppySessionStore, type PoppySessionRecord } from '@auth0/auth0-api-js';
import { neon } from '@neondatabase/serverless';
import type { ActivityEntry, ActivityStore } from '../activity.js';
import type { Product } from '../catalog.js';
import type { Stores } from './index.js';
import { MAX_QUANTITY, type AgentConnection, type CartLine, type Order } from './types.js';

type Sql = ReturnType<typeof neon<false, false>>;

class NeonSessions extends PoppySessionStore {
  constructor(private readonly sql: Sql) { super(); }

  async get(key: string): Promise<PoppySessionRecord | undefined> {
    const [row] = await this.sql`SELECT details FROM poppy_sessions WHERE session_key = ${key}`;
    return row?.details;
  }

  async set(key: string, record: PoppySessionRecord): Promise<PoppySessionRecord> {
    const [row] = await this.sql`
      INSERT INTO poppy_sessions (session_key, details) VALUES (${key}, ${JSON.stringify(record)}::jsonb)
      ON CONFLICT (session_key) DO UPDATE SET details = poppy_sessions.details
      RETURNING details
    `;
    if (!row) throw new Error('Poppy session write returned no row.');
    return row.details;
  }

  async end(key: string): Promise<void> {
    await this.sql`UPDATE poppy_sessions SET details = details || '{"ended":true}'::jsonb WHERE session_key = ${key}`;
  }
}

const iso = (value: Date | string) => new Date(value).toISOString();

function connection(row: Record<string, any>): AgentConnection {
  return {
    sessionKey: row.session_key, agent: row.agent, account: row.user_sub,
    firstSeen: iso(row.first_seen), lastSeen: iso(row.last_seen),
    requests: row.requests, orders: row.orders, endedAt: row.ended_at ? iso(row.ended_at) : undefined,
  };
}

export function createNeonStores(url: string): Stores & { products: () => Promise<Product[]>; activity: ActivityStore } {
  const sql = neon(url);
  const sessions = new NeonSessions(sql);
  const cartLines = async (key: string) => (
    await sql`SELECT product_id AS "productId", quantity FROM carts WHERE cart_id = ${key} ORDER BY product_id`
  ) as CartLine[];
  return {
    sessions,
    endSession: (key) => sessions.end(key),
    products: async () => (await sql`SELECT details FROM products ORDER BY id`).map((row) => row.details),
    carts: {
      get: cartLines,
      async setItem(key, id, quantity) {
        await sql`
          INSERT INTO carts (cart_id, product_id, quantity) VALUES (${key}, ${id}, ${quantity})
          ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity
        `;
        return cartLines(key);
      },
      async removeItem(key, id) {
        await sql`DELETE FROM carts WHERE cart_id = ${key} AND product_id = ${id}`;
        return cartLines(key);
      },
      async clear(key) { await sql`DELETE FROM carts WHERE cart_id = ${key}`; },
      async take(key) {
        return (await sql`DELETE FROM carts WHERE cart_id = ${key} RETURNING product_id AS "productId", quantity`) as CartLine[];
      },
      async restore(key, lines) {
        if (!lines.length) return;
        await sql`
          INSERT INTO carts (cart_id, product_id, quantity)
          SELECT ${key}, "productId", quantity FROM jsonb_to_recordset(${JSON.stringify(lines)}::jsonb)
            AS line("productId" text, quantity integer) ORDER BY "productId"
          ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = LEAST(${MAX_QUANTITY}, carts.quantity + EXCLUDED.quantity)
        `;
      },
      async merge(from, to) {
        if (from === to) return 0;
        const rows = await sql`
          WITH moved AS (DELETE FROM carts WHERE cart_id = ${from} RETURNING product_id, quantity)
          INSERT INTO carts (cart_id, product_id, quantity) SELECT ${to}, product_id, quantity FROM moved ORDER BY product_id
          ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = LEAST(${MAX_QUANTITY}, carts.quantity + EXCLUDED.quantity)
          RETURNING product_id
        `;
        return rows.length;
      },
    },
    orders: {
      async add(order) {
        await sql`INSERT INTO orders (id, user_sub, ts, details)
          VALUES (${order.id}, ${order.account}, ${order.createdAt}, ${JSON.stringify(order)}::jsonb)`;
        return order;
      },
      async listByAccount(account) {
        return (await sql`SELECT details FROM orders WHERE user_sub = ${account} ORDER BY ts`).map((row) => row.details as Order);
      },
    },
    connections: {
      async touch(event) {
        await sql`
          INSERT INTO agent_connections (session_key, agent, user_sub, first_seen, last_seen, orders)
          VALUES (${event.sessionKey}, ${event.agent}, ${event.account ?? null}, ${event.at}, ${event.at}, ${Number(event.placedOrder)})
          ON CONFLICT (session_key) DO UPDATE SET
            user_sub = COALESCE(agent_connections.user_sub, EXCLUDED.user_sub),
            last_seen = GREATEST(agent_connections.last_seen, EXCLUDED.last_seen),
            requests = agent_connections.requests + 1, orders = agent_connections.orders + EXCLUDED.orders
        `;
      },
      async get(key) {
        const [row] = await sql`SELECT * FROM agent_connections WHERE session_key = ${key}`;
        return row ? connection(row) : undefined;
      },
      async list(account) {
        return (await sql`
          SELECT * FROM agent_connections WHERE ${account ?? null}::text IS NULL OR user_sub = ${account ?? null} ORDER BY last_seen DESC
        `).map(connection);
      },
      async markEnded(key, at) {
        await sql`UPDATE agent_connections SET ended_at = ${at} WHERE session_key = ${key} AND ended_at IS NULL`;
      },
    },
    idempotency: {
      async begin(scope, key, fingerprint, ttlSeconds) {
        const attempt = randomUUID();
        const [row] = await sql`
          INSERT INTO checkout_idempotency (scope, key, attempt, fingerprint, expires_at)
          VALUES (${scope}, ${key}, ${attempt}, ${fingerprint}, now() + make_interval(secs => ${ttlSeconds}))
          ON CONFLICT (scope, key) DO UPDATE SET
            attempt = CASE WHEN checkout_idempotency.expires_at <= now() THEN EXCLUDED.attempt ELSE checkout_idempotency.attempt END,
            fingerprint = CASE WHEN checkout_idempotency.expires_at <= now() THEN EXCLUDED.fingerprint ELSE checkout_idempotency.fingerprint END,
            expires_at = GREATEST(checkout_idempotency.expires_at, CASE
              WHEN checkout_idempotency.expires_at <= now() THEN EXCLUDED.expires_at ELSE checkout_idempotency.expires_at END),
            status = CASE WHEN checkout_idempotency.expires_at <= now() THEN NULL ELSE checkout_idempotency.status END,
            body = CASE WHEN checkout_idempotency.expires_at <= now() THEN NULL ELSE checkout_idempotency.body END
          RETURNING attempt, fingerprint, status, body
        `;
        if (!row) throw new Error('Idempotency write returned no row.');
        return row.attempt === attempt ? undefined : { fingerprint: row.fingerprint, status: row.status ?? undefined, body: row.body };
      },
      async finish(scope, key, result, ttlSeconds) {
        await sql`UPDATE checkout_idempotency SET status = ${result.status ?? null}, body = ${JSON.stringify(result.body ?? null)}::jsonb,
          expires_at = now() + make_interval(secs => ${ttlSeconds}) WHERE scope = ${scope} AND key = ${key}`;
      },
      async abandon(scope, key) {
        await sql`DELETE FROM checkout_idempotency WHERE scope = ${scope} AND key = ${key} AND status IS NULL`;
      },
    },
    activity: {
      async insert(e) {
        await sql`
          INSERT INTO activity_log (actor_type, caller, user_sub, actor_sub, actor_client_id, poppy_sid, session_key, agent,
            method, path, status, outcome, duration_ms, ts)
          VALUES (${e.actorType ?? null}, ${e.caller}, ${e.account ?? null}, ${e.actorSub ?? null}, ${e.actorClientId ?? null},
            ${e.poppySid ?? null}, ${e.sessionKey ?? null}, ${e.agent ?? null}, ${e.method}, ${e.path}, ${e.status},
            ${e.outcome}, ${e.durationMs}, ${e.at})
        `;
      },
      async list({ account, agentOnly, limit = 100 }) {
        const rows = await sql`
          SELECT a.* FROM activity_log a
          WHERE (NOT ${!!agentOnly} OR a.actor_type IN ('guest_agent', 'user_agent'))
            AND (${account ?? null}::text IS NULL OR a.user_sub = ${account ?? null} OR
              (a.actor_type = 'guest_agent' AND EXISTS (
                SELECT 1 FROM agent_connections c WHERE c.session_key = a.session_key AND c.user_sub = ${account ?? null}
              )))
          ORDER BY a.ts DESC, a.id DESC LIMIT ${limit}
        `;
        return rows.map((row): ActivityEntry => ({
          id: row.id, at: iso(row.ts), actorType: row.actor_type ?? undefined, caller: row.caller,
          account: row.user_sub ?? undefined, actorSub: row.actor_sub ?? undefined,
          actorClientId: row.actor_client_id ?? undefined, poppySid: row.poppy_sid ?? undefined,
          sessionKey: row.session_key ?? undefined, agent: row.agent ?? undefined,
          method: row.method, path: row.path, status: row.status, outcome: row.outcome, durationMs: row.duration_ms,
        }));
      },
    },
  };
}
