import { describe, expect, test } from 'vitest';
import { APPROVED_TEST_CARD, DECLINED_TEST_CARD, simulatePayment } from '../src/payments.js';

describe('simulatePayment', () => {
  test('approves the Visa test card by default and records a reference', () => {
    const result = simulatePayment(24900, {}, () => 'sim_fixed');
    expect(result).toMatchObject({ ok: true, payment: { status: 'paid', last4: '4242', amountCents: 24900, reference: 'sim_fixed', simulated: true } });
  });

  test('ignores spaces in the card number', () => {
    expect(simulatePayment(100, { card: '4242 4242 4242 4242' }).ok).toBe(true);
  });

  test('declines 4000 0000 0000 0002', () => {
    expect(simulatePayment(100, { card: DECLINED_TEST_CARD })).toMatchObject({ ok: false, code: 'card_declined' });
  });

  test('refuses any other number, so no real card is ever accepted', () => {
    expect(simulatePayment(100, { card: '5555555555554444' })).toMatchObject({ ok: false, code: 'invalid_card' });
    expect(simulatePayment(100, { card: APPROVED_TEST_CARD }).ok).toBe(true);
  });
});
