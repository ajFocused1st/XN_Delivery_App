const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidEmail,
  normalizeEmail,
} = require('./email-validation');

test('accepts common deliverable-looking email formats', () => {
  const validEmails = [
    'customer@example.com',
    'dispatch+overnight@xpedite-now.com',
    'driver.name@operations.example.co.uk',
    'user@xn--bcher-kva.example',
  ];

  validEmails.forEach(email => assert.equal(isValidEmail(email), true, email));
});

test('normalizes surrounding whitespace and letter case', () => {
  assert.equal(normalizeEmail('  Customer@Example.COM  '), 'customer@example.com');
});

test('rejects malformed email addresses', () => {
  const invalidEmails = [
    '',
    'not-an-email',
    'user@localhost',
    'user@example.c',
    'user@@example.com',
    '.user@example.com',
    'user..name@example.com',
    'user@example..com',
    'user@-example.com',
    'user@example-.com',
    'user name@example.com',
  ];

  invalidEmails.forEach(email => assert.equal(isValidEmail(email), false, email));
});

test('rejects addresses longer than the email length limit', () => {
  assert.equal(isValidEmail(`${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.com`), false);
});
