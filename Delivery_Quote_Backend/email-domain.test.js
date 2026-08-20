'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EmailDomainLookupError, clearEmailDomainCache, emailDomainAcceptsMail } = require('./email-domain');

test.beforeEach(() => clearEmailDomainCache());

test('accepts a domain with a usable MX record', async () => {
  assert.equal(await emailDomainAcceptsMail('customer@example.com', {
    resolveMx: async () => [{ exchange: 'mail.example.com', priority: 10 }],
  }), true);
});

test('rejects a domain without a usable MX record', async () => {
  assert.equal(await emailDomainAcceptsMail('customer@example.com', { resolveMx: async () => [] }), false);
});

test('treats temporary DNS failures as retryable errors', async () => {
  await assert.rejects(emailDomainAcceptsMail('customer@example.com', {
    resolveMx: async () => { throw Object.assign(new Error('try again'), { code: 'EAI_AGAIN' }); },
  }), EmailDomainLookupError);
});
