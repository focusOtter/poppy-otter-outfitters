import Image from "next/image";
import Link from "next/link";
import type { Order, Product } from "@/lib/carts-api";
import { formatPrice, formatWhen } from "@/lib/format";

/** A short, readable order number from the stored ID (`ord_3f9a12c0-…` → `3F9A12C0`). The full ID stays in the URL. */
export function orderNumber(id: string): string {
  return id.replace(/^ord_/, "").replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** The agent that placed the order, by name: its client metadata URL's host, or the Auth0 agent ID as stored. */
function agentName(placedVia: string): string {
  try {
    return new URL(placedVia).host;
  } catch {
    return placedVia;
  }
}

export function OrderCard({ order, catalog = [] }: { order: Order; catalog?: Product[] }) {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const count = order.items.reduce((n, i) => n + i.quantity, 0);
  const { shipping, payment, placedVia } = order;

  return (
    <li className="order">
      <header className="order-head">
        <div>
          <h2 className="order-number">
            <Link href={`/account/orders/${encodeURIComponent(order.id)}`}>Order {orderNumber(order.id)}</Link>
          </h2>
          <p className="order-meta">
            <time dateTime={order.createdAt}>{formatWhen(order.createdAt)}</time> · {count} {count === 1 ? "item" : "items"}
          </p>
        </div>
        <div className="order-total">
          <span className={placedVia ? "order-status agent" : "order-status"}>{placedVia ? "Placed by agent" : "Placed by you"}</span>
          <strong>{formatPrice(order.totalCents)}</strong>
        </div>
      </header>

      <ul className="order-items">
        {order.items.map((i) => {
          const p = byId.get(i.productId);
          const image = p?.images?.[0];
          const price = i.priceCents ?? p?.priceCents;
          return (
            <li key={i.productId} className="order-item">
              {image ? (
                <Image src={image} alt="" className="order-thumb" width={112} height={112} sizes="56px" />
              ) : (
                <span className="order-thumb placeholder" aria-hidden />
              )}
              <span className="order-item-name">{i.name ?? p?.name ?? i.productId}</span>
              <span className="order-item-qty">
                {i.quantity} × {formatPrice(price)}
              </span>
            </li>
          );
        })}
      </ul>

      <dl className="order-facts">
        {shipping && (
          <div>
            <dt>Ship to</dt>
            <dd>
              {shipping.name}
              <br />
              <span className="muted">
                {shipping.line1}, {shipping.city}, {shipping.region} {shipping.postalCode}
              </span>
            </dd>
          </div>
        )}
        {payment && (
          <div>
            <dt>Payment</dt>
            <dd>
              {payment.brand} ending {payment.last4}
              <br />
              <span className="muted">Test card, no charge</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Placed by</dt>
          <dd>
            {placedVia ? (
              <>
                <span title={placedVia}>{agentName(placedVia)}</span>
                <br />
                <span className="muted">Your personal agent</span>
              </>
            ) : (
              <>
                You
                <br />
                <span className="muted">On this site</span>
              </>
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}
