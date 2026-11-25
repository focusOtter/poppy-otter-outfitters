import { test } from 'node:test';
import assert from 'node:assert/strict';
import { name } from '../src/visitor.js';

test('derives a name from the email when name is the email', () => {
  assert.equal(name({ name: 'jane.doe@atko.email', email: 'jane.doe@atko.email' }), 'Jane Doe');
  assert.equal(name({ email: 'bharath+shop@atko.email' }), 'Bharath');
  assert.equal(name({ email: 'mary_ann-smith@example.com' }), 'Mary Ann Smith');
});

test('keeps a real name', () => {
  assert.equal(name({ name: 'Jane Doe', email: 'jd@example.com' }), 'Jane Doe');
});

test('falls back to the subject without a name or email', () => {
  assert.equal(name({ sub: 'auth0|123' }), 'auth0|123');
});
