// The saved shipping address and payment methods a customer picks from at checkout. They are samples: nothing ships,
// and a payment method is a test card the Carts API recognises, so no money moves.

export const CHECKOUT_ADDRESSES = [
  { id: "addr_home", name: "Otter Outfitters sample customer", oneLine: "12 Otter Demo Lane, Portland, OR 97201, US" }
] as const;

export const CHECKOUT_PAYMENT_METHODS = [
  { id: "pm_visa_4242", brand: "Visa", last4: "4242", card: "4242424242424242", approves: true },
  { id: "pm_visa_0002", brand: "Visa", last4: "0002", card: "4000000000000002", approves: false }
] as const;

/** The test card for a payment method ID; the approved card when the ID is missing or unknown. */
export function cardFor(paymentMethodId: string | undefined): string {
  return (CHECKOUT_PAYMENT_METHODS.find((m) => m.id === paymentMethodId) ?? CHECKOUT_PAYMENT_METHODS[0]).card;
}
