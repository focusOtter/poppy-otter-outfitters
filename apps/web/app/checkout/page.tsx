import Image from "next/image";
import Link from "next/link";
import { cartsApi } from "@/lib/carts-api";
import { formatPrice } from "@/lib/format";
import { getDriver } from "@/lib/poppy";
import { ApiNotice } from "../components/ApiNotice";
import { EmptyCart } from "../components/cart/EmptyCart";
import { toRows } from "../components/cart/rows";
import { PlaceOrderForm } from "../components/checkout/PlaceOrderForm";
import { PageHeader } from "../components/ui/PageHeader";

export const metadata = { title: "Checkout" };

const NOTES = {
  guest: "Shopping as a guest. Sign in to place the order, and your cart comes with you.",
  agent_guest:
    "Nothing else is missing. The customer has not signed this agent in yet, so Place order asks for their approval first."
};

/** The checkout step: review the items, pick a saved address and test card, place the order. People and agents use it alike. */
export default async function CheckoutPage() {
  const driver = await getDriver();
  if (driver.kind === "visitor") {
    return (
      <>
        <PageHeader title="Checkout" />
        <EmptyCart />
      </>
    );
  }

  const [cart, products] = await Promise.all([cartsApi.cart(), cartsApi.products()]);
  if (!cart.ok) {
    return (
      <>
        <PageHeader title="Checkout" />
        <ApiNotice result={cart} returnTo="/checkout" />
      </>
    );
  }

  const rows = toRows(cart.data, products.ok ? products.data : []);
  if (rows.length === 0) {
    return (
      <>
        <PageHeader title="Checkout" />
        <EmptyCart />
      </>
    );
  }
  const total = formatPrice(rows.reduce((n, r) => n + r.line, 0));
  const guest = driver.kind === "guest" || driver.kind === "agent_guest" ? driver.kind : undefined;

  return (
    <>
      <h1 className="checkout-title">Checkout</h1>
      <div className="cart-layout checkout">
        <section className="review" aria-labelledby="review-heading">
          <h2 id="review-heading">Review your items</h2>
          <ul className="cart-lines">
            {rows.map((r) => (
              <li key={r.productId} className="cart-line">
                {r.image ? <Image src={r.image} alt="" className="cart-thumb" width={224} height={224} sizes="112px" /> : <span className="cart-thumb placeholder" aria-hidden />}
                <div className="cart-line-info">
                  <span className="cart-line-name">{r.name}</span>{" "}
                  <span className="muted">
                    {r.quantity} x {formatPrice(r.price)}
                  </span>
                </div>{" "}
                <span className="cart-line-total">{formatPrice(r.line)}</span>
              </li>
            ))}
          </ul>
        </section>
        <aside className="summary" aria-label="Shipping, payment and place order">
          <PlaceOrderForm total={total} />
          {guest && <div className="summary-note">{NOTES[guest]}</div>}
          <div className="summary-note checkout-back">
            No money moves and nothing ships. <Link href="/cart">Back to cart</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
