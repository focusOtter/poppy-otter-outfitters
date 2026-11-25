// The saved shipping address and payment methods a customer picks from at checkout, the same as
// apps/web/lib/checkout-options.ts. They are samples: nothing ships, and a payment method is a test card the Carts API
// recognises, so no money moves.

export const CHECKOUT_ADDRESSES = [{ id: 'addr_home', name: 'Drift Bean sample customer', oneLine: '12 Drift Bean Lane, Portland, OR 97201, US' }];

export const CHECKOUT_PAYMENT_METHODS = [
  { id: 'pm_visa_4242', brand: 'Visa', last4: '4242', card: '4242424242424242', approves: true },
  { id: 'pm_visa_0002', brand: 'Visa', last4: '0002', card: '4000000000000002', approves: false },
];

/** The test card for a payment method ID; the approved card when the ID is missing or unknown. */
export const cardFor = (id) => (CHECKOUT_PAYMENT_METHODS.find((m) => m.id === id) ?? CHECKOUT_PAYMENT_METHODS[0]).card;
