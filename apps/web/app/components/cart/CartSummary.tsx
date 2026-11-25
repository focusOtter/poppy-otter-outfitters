import Link from "next/link";
import { formatPrice } from "@/lib/format";

const GUEST_NOTES = {
  guest: "Shopping as a guest. Sign in at checkout and your cart comes with you.",
  agent_guest: "You're shopping as an agent guest. Checkout needs the customer's approval."
};

export function CartSummary({
  count,
  totalCents,
  guest
}: {
  count: number;
  totalCents: number;
  guest?: keyof typeof GUEST_NOTES;
}) {
  return (
    <aside className="summary" aria-label="Order summary">
      <h2>Summary</h2>
      <dl className="summary-rows">
        <div>
          <dt>Items</dt>
          <dd>{count}</dd>
        </div>
        <div className="summary-total">
          <dt>Total</dt>
          <dd>{formatPrice(totalCents)}</dd>
        </div>
      </dl>
      {guest && <p className="summary-note">{GUEST_NOTES[guest]}</p>}
      <Link href="/checkout" className="btn btn-primary">
        Check out
      </Link>
    </aside>
  );
}
