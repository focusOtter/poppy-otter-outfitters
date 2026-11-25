CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  details jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS carts (
  cart_id text NOT NULL,
  product_id text NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (cart_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  user_sub text NOT NULL,
  ts timestamptz NOT NULL,
  details jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_sub, ts);
CREATE TABLE IF NOT EXISTS poppy_sessions (
  session_key text PRIMARY KEY,
  details jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_connections (
  session_key text PRIMARY KEY,
  agent text NOT NULL,
  user_sub text,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 1,
  orders integer NOT NULL DEFAULT 0,
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_connections_user_idx ON agent_connections (user_sub);
CREATE TABLE IF NOT EXISTS activity_log (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text CHECK (actor_type IN ('guest_agent', 'user_agent', 'user')),
  caller text NOT NULL,
  user_sub text,
  actor_sub text,
  actor_client_id text,
  poppy_sid text,
  session_key text,
  agent text,
  method text NOT NULL,
  path text NOT NULL,
  status integer NOT NULL,
  outcome text NOT NULL,
  duration_ms integer NOT NULL,
  ts timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_user_idx ON activity_log (user_sub, ts DESC);
CREATE INDEX IF NOT EXISTS activity_session_idx ON activity_log (session_key, ts DESC);
CREATE TABLE IF NOT EXISTS checkout_idempotency (
  scope text NOT NULL,
  key text NOT NULL,
  attempt text NOT NULL,
  fingerprint text NOT NULL,
  status integer,
  body jsonb,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
