'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail } = require('./email-validation');

test('normalizes common valid email addresses', () => {
  assert.equal(normalizeEmail('  Customer+Load@Example.COM  '), 'customer+load@example.com');
});

test('rejects malformed email addresses', () => {
  for (const email of ['john', 'john@', 'john@example', 'john@@example.com', 'john..smith@example.com', 'john@-example.com']) {
    assert.equal(normalizeEmail(email), null, email);
  }
});
