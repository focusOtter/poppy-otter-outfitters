// A simulated payment. No card is charged and no money moves: it decides "paid" or "declined" from a test card number,
// the way a payment provider's test mode does, so checkout has a real step to succeed or fail at.

export interface PaymentRecord {
  status: 'paid';
  /** Always `test_card`: nothing here is a real payment method. */
  method: 'test_card';
  brand: 'visa';
  last4: string;
  amountCents: number;
  /** `sim_` plus random characters, like a provider's charge ID. */
  reference: string;
  simulated: true;
}

export type PaymentResult =
  | { ok: true; payment: PaymentRecord }
  | { ok: false; code: 'card_declined' | 'invalid_card'; message: string };

export const APPROVED_TEST_CARD = '4242424242424242';
export const DECLINED_TEST_CARD = '4000000000000002';

/** Approves the Visa test card, declines 4000 0000 0000 0002, and refuses anything else. */
export function simulatePayment(totalCents: number, input: unknown = {}, newReference = randomReference): PaymentResult {
  const number = input && typeof input === 'object' && !Array.isArray(input)
    ? ('card' in input ? input.card : APPROVED_TEST_CARD)
    : undefined;
  const card = typeof number === 'string' ? number.replace(/\s+/g, '') : undefined;
  if (card === DECLINED_TEST_CARD) {
    return { ok: false, code: 'card_declined', message: 'The test card was declined. Try 4242 4242 4242 4242.' };
  }
  if (card !== APPROVED_TEST_CARD) {
    return { ok: false, code: 'invalid_card', message: 'Use the test card 4242 4242 4242 4242 (approved) or 4000 0000 0000 0002 (declined).' };
  }
  return {
    ok: true,
    payment: { status: 'paid', method: 'test_card', brand: 'visa', last4: card.slice(-4), amountCents: totalCents, reference: newReference(), simulated: true },
  };
}

function randomReference(): string {
  return `sim_${Math.random().toString(36).slice(2, 12)}`;
}
