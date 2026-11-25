"use client";

import Link from "next/link";
import { useActionState, useEffect, useOptimistic, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/lib/action-result";
import { addToCart } from "../actions";
import { useCartCount } from "./CartCountProvider";

const MAX_QUANTITY = 10;

function Spinner() {
  return <span className="spinner" aria-hidden />;
}

function Check() {
  return (
    <svg className="check" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SubmitButton({ added, inCart, variant }: { added: boolean; inCart: number; variant: "primary" | "secondary" }) {
  const { pending } = useFormStatus();
  const state = pending ? "pending" : added ? "added" : inCart > 0 ? "in-cart" : "idle";
  return (
    <button
      type="submit"
      className={`btn btn-${variant} add-btn`}
      data-state={state}
      disabled={pending}
      aria-label={state === "in-cart" ? `${inCart} in cart. Add one more` : undefined}
    >
      {state === "pending" ? (
        <>
          <Spinner /> Adding
        </>
      ) : state === "added" ? (
        <>
          <Check /> Added
        </>
      ) : state === "in-cart" ? (
        <>
          <span className="add-label-rest">
            <Check /> In cart · {inCart}
          </span>
          <span className="add-label-hover" aria-hidden>
            Add one more
          </span>
        </>
      ) : (
        "Add to cart"
      )}
    </button>
  );
}

function QuantityStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { pending } = useFormStatus();
  const set = (n: number) => onChange(Math.min(MAX_QUANTITY, Math.max(1, n)));
  return (
    <div className="stepper" role="group" aria-label="Quantity">
      <button type="button" onClick={() => set(value - 1)} disabled={pending || value <= 1} aria-label="Decrease quantity">
        <span aria-hidden>−</span>
      </button>
      <input
        name="quantity"
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_QUANTITY}
        value={value}
        onChange={(e) => set(Number(e.target.value) || 1)}
        aria-label="Quantity"
        readOnly={pending}
      />
      <button
        type="button"
        onClick={() => set(value + 1)}
        disabled={pending || value >= MAX_QUANTITY}
        aria-label="Increase quantity"
      >
        <span aria-hidden>+</span>
      </button>
    </div>
  );
}

/**
 * "Add to cart" with feedback in the button itself: a spinner while the action runs, then a check and a
 * "View cart" link for a moment. The header badge updates from the same server response.
 */
export function AddToCartForm({
  productId,
  variant = "primary",
  withQuantity = false,
  inCart = 0
}: {
  productId: string;
  variant?: "primary" | "secondary";
  withQuantity?: boolean;
  /** Quantity already in the cart; shows a persistent "In cart" state. */
  inCart?: number;
}) {
  const cartCount = useCartCount();
  const [optimisticInCart, addOptimisticInCart] = useOptimistic(inCart, (current, quantity: number) =>
    Math.min(MAX_QUANTITY, current + quantity)
  );
  // Badge and "In cart" move on click; the server's response then confirms (or quietly corrects) both.
  const [state, formAction] = useActionState(async (prev: ActionResult, formData: FormData) => {
    const quantity = Math.max(0, Math.min(MAX_QUANTITY - inCart, Number(formData.get("quantity") ?? 1)));
    addOptimisticInCart(quantity);
    cartCount.addOptimistic(quantity);
    return addToCart(prev, formData);
  }, { ok: true });
  const [added, setAdded] = useState(false);
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (!state.ok || !state.message) return;
    setAdded(true);
    const t = setTimeout(() => setAdded(false), 2200);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <form action={formAction} className={`add-form${withQuantity ? " with-quantity" : ""}`}>
      <input type="hidden" name="productId" value={productId} />
      <div className="add-row">
        {withQuantity ? <QuantityStepper value={quantity} onChange={setQuantity} /> : <input type="hidden" name="quantity" value="1" />}
        <SubmitButton added={added} inCart={optimisticInCart} variant={variant} />
      </div>
      <p className={`add-note${!state.ok ? " err" : added ? " ok is-visible" : optimisticInCart > 0 ? " ok" : ""}`} role="status">
        {!state.ok ? (
          <>
            {state.message}{" "}
            {state.signInReturnTo && (
              <>
              <a href={`/auth/login?returnTo=${encodeURIComponent(state.signInReturnTo)}`}>Sign in</a> or{" "}
              <a href={`/auth/login?screen_hint=signup&returnTo=${encodeURIComponent(state.signInReturnTo)}`}>create an account</a>
            </>
            )}
          </>
        ) : added ? (
          <>
            {state.message} <Link href="/cart">View cart</Link>
          </>
        ) : optimisticInCart > 0 ? (
          <Link href="/cart">View cart</Link>
        ) : null}
      </p>
    </form>
  );
}
