"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { checkout } from "@/app/actions";
import type { ActionResult } from "@/lib/action-result";
import { CHECKOUT_ADDRESSES, CHECKOUT_PAYMENT_METHODS } from "@/lib/checkout-options";

// The place-order form. Its markup is the contract personal agents read (the Poppy Playground included): the form is
// `form#place-order`, the address and payment choices are radio groups named `addressId` and `paymentMethodId`, and
// the button reads "Place order · <total>". Keep these names when you restyle it.

function PlaceOrderButton({ total }: { total: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary place-order" disabled={pending}>
      {pending ? "Placing order…" : `Place order · ${total}`}
    </button>
  );
}

export function PlaceOrderForm({ total }: { total: string }) {
  const [state, formAction] = useActionState<ActionResult, FormData>(checkout, { ok: true });
  return (
    <form id="place-order" action={formAction} className="place-order-form">
      <fieldset className="pay-options address-options">
        <legend>Shipping address</legend>
        {CHECKOUT_ADDRESSES.map((a, i) => (
          <label key={a.id} className="pay-option">
            <input type="radio" name="addressId" value={a.id} defaultChecked={i === 0} />
            <span className="pay-card">
              <strong>{a.name}</strong> <span className="address-line">{a.oneLine}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="pay-options">
        <legend>
          Payment method <span className="muted">Saved test cards, no money moves</span>
        </legend>
        {CHECKOUT_PAYMENT_METHODS.map((m, i) => (
          <label key={m.id} className="pay-option">
            <input type="radio" name="paymentMethodId" value={m.id} defaultChecked={i === 0} />
            <span className="pay-card">
              <strong>{m.brand}</strong> {m.last4}
            </span>{" "}
            <span className={`pay-outcome ${m.approves ? "ok" : "no"}`}>{m.approves ? "Approves" : "Declines"}</span>
          </label>
        ))}
      </fieldset>
      <PlaceOrderButton total={total} />
      {state.message && (
        <div className={state.ok ? "form-note ok" : "form-note err"} role="status">
          {state.message}{" "}
          {state.signInReturnTo && (
            // A plain <a>, not <Link>: /auth/login is an SDK route served from proxy.ts, not a page.
            <a href={`/auth/login?returnTo=${encodeURIComponent(state.signInReturnTo)}`}>Sign in</a>
          )}
        </div>
      )}
    </form>
  );
}
