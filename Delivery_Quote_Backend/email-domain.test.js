const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EmailDomainLookupError,
  clearEmailDomainCache,
  emailDomainAcceptsMail,
} = require('./email-domain');

test.beforeEach(() => clearEmailDomainCache());

test('accepts a domain with a usable MX record', async () => {
  const acceptsMail = await emailDomainAcceptsMail('customer@example.com', {
    resolveMx: async domain => {
      assert.equal(domain, 'example.com');
      return [{ exchange: 'mail.example.com', priority: 10 }];
    },
  });

  assert.equal(acceptsMail, true);
});

test('rejects empty and null MX responses', async () => {
  assert.equal(await emailDomainAcceptsMail('one@no-mail.example', {
    resolveMx: async () => [],
  }), false);
  assert.equal(await emailDomainAcceptsMail('two@null-mx.example', {
    resolveMx: async () => [{ exchange: '.', priority: 0 }],
  }), false);
});

test('rejects domains that DNS reports do not exist', async () => {
  const error = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  assert.equal(await emailDomainAcceptsMail('user@missing.example', {
    resolveMx: async () => { throw error; },
  }), false);
});

test('does not mislabel temporary DNS failures as invalid domains', async () => {
  const error = Object.assign(new Error('try again'), { code: 'EAI_AGAIN' });
  await assert.rejects(
    emailDomainAcceptsMail('user@temporary.example', {
      resolveMx: async () => { throw error; },
    }),
    EmailDomainLookupError,
  );
});

test('caches successful lookups', async () => {
  let lookupCount = 0;
  const options = {
    resolveMx: async () => {
      lookupCount += 1;
      return [{ exchange: 'mail.cache.example', priority: 10 }];
    },
  };

  assert.equal(await emailDomainAcceptsMail('first@cache.example', options), true);
  assert.equal(await emailDomainAcceptsMail('second@cache.example', options), true);
  assert.equal(lookupCount, 1);
});
