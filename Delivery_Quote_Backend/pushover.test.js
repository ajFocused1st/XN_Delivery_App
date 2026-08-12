'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildQuoteNotification,
  sendQuoteNotification,
} = require('./pushover');

const SAMPLE_LEAD = {
  contactDetails: { name: 'Teena Marie' },
  stopsData: [
    { address: '7841 Carriage Pointe Dr, Gibsonton, FL' },
    { address: '4217 Empire Place, Tampa, FL' },
  ],
  serviceDetails: {
    vehicleType: 'cargo_van_high_roof',
    pickupDate: '2026-08-13',
    pickupTime: '07:51',
  },
  totalMiles: 15,
  calculatedQuote: 95,
};

test('formats a concise quote alert', () => {
  const result = buildQuoteNotification(SAMPLE_LEAD, 42);
  assert.equal(result.title, 'New XN Quote | $95.00');
  assert.match(result.message, /Lead #42/);
  assert.match(result.message, /Teena Marie/);
  assert.match(result.message, /Cargo Van \(High Roof\) \| 15\.0 miles/);
  assert.match(result.message, /Gibsonton, FL.*Tampa, FL/);
  assert.ok(Buffer.byteLength(result.message, 'utf8') <= 1024);
});

test('does not call Pushover when notifications are disabled', async () => {
  let called = false;
  const result = await sendQuoteNotification(SAMPLE_LEAD, 42, {
    env: { PUSHOVER_NOTIFICATIONS_ENABLED: 'false' },
    fetchImpl: async () => {
      called = true;
      throw new Error('unexpected call');
    },
  });

  assert.deepEqual(result, { sent: false, reason: 'disabled' });
  assert.equal(called, false);
});

test('sends the expected form fields without exposing them in logs', async () => {
  let request;
  const result = await sendQuoteNotification(SAMPLE_LEAD, 42, {
    env: {
      PUSHOVER_NOTIFICATIONS_ENABLED: 'true',
      PUSHOVER_APP_TOKEN: 'app-token',
      PUSHOVER_USER_KEY: 'user-key',
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 1, request: 'request-id' }),
      };
    },
  });

  assert.deepEqual(result, { sent: true, requestId: 'request-id' });
  assert.equal(request.url, 'https://api.pushover.net/1/messages.json');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body.get('token'), 'app-token');
  assert.equal(request.options.body.get('user'), 'user-key');
  assert.match(request.options.body.get('message'), /Lead #42/);
});

test('rejects enabled notifications when credentials are missing', async () => {
  await assert.rejects(
    sendQuoteNotification(SAMPLE_LEAD, 42, {
      env: { PUSHOVER_NOTIFICATIONS_ENABLED: 'true' },
      fetchImpl: async () => assert.fail('fetch should not be called'),
    }),
    /credentials are incomplete/
  );
});

test('reports Pushover API rejection', async () => {
  await assert.rejects(
    sendQuoteNotification(SAMPLE_LEAD, 42, {
      env: {
        PUSHOVER_NOTIFICATIONS_ENABLED: 'true',
        PUSHOVER_APP_TOKEN: 'bad-token',
        PUSHOVER_USER_KEY: 'user-key',
      },
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ status: 0, errors: ['application token is invalid'] }),
      }),
    }),
    /application token is invalid/
  );
});
