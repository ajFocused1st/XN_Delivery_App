'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBookingNotification,
  buildQuoteNotification,
  sendBookingNotification,
  sendQuoteNotification,
} = require('./pushover');

const SAMPLE_LEAD = {
  quoteId: 'XN-20260820-A1B2C3',
  contactDetails: { name: 'Teena Marie', email: 'office@xpeditenow.com', phone: '813-575-0387', company: 'Xpedite Now' },
  stopsData: [
    { address: '7841 Carriage Pointe Dr, Gibsonton, FL', loadUnload: 'customer', stairs: false },
    { address: '4217 Empire Place, Tampa, FL', loadUnload: 'driver_assist', stairs: true, stairFlights: 1 },
  ],
  packagesData: [{ qty: 2, weight: 500, desc: 'Pallets' }],
  serviceDetails: {
    vehicleType: 'cargo_van_high_roof',
    pickupDate: '2026-08-13',
    pickupTime: '07:51',
    deliveryDate: '2026-08-13',
    deliveryTime: '11:51',
    urgency: 'expedited_4hr',
    urgencyLabel: 'Expedited (4 Hours)',
    fragileHandling: true,
  },
  totalMiles: 15,
  calculatedQuote: 95,
};

test('formats a concise quote alert', () => {
  const result = buildQuoteNotification(SAMPLE_LEAD, 42);
  assert.equal(result.title, 'NEW QUOTE | $95.00 | Cargo Van (High Roof)');
  assert.match(result.message, /^<b>Price: \$95\.00<\/b>/);
  assert.match(result.message, /Lead #42/);
  assert.match(result.message, /XN-20260820-A1B2C3/);
  assert.match(result.message, /Teena Marie/);
  assert.match(result.message, /office@xpeditenow\.com/);
  assert.match(result.message, /Phone: 813-575-0387/);
  assert.match(result.message, /Pickup Date: Thu, Aug\. 13, 2026 @ 7:51am/);
  assert.match(result.message, /Delivery Date: Thu, Aug\. 13, 2026 @ 11:51am/);
  assert.match(result.message, /Urgency: Expedited \(4 Hours\)/);
  assert.match(result.message, /Pickup Address: 7841 Carriage Pointe Dr/);
  assert.match(result.message, /Delivery Address: 4217 Empire Place/);
  assert.match(result.message, /2 pc \| 1000 lb \| Pallets/);
  assert.match(result.message, /S2 Driver assist \+ 1 stair flight/);
  assert.ok(Buffer.byteLength(result.message, 'utf8') <= 1024);
});

test('places additional stops between pickup and delivery address lines', () => {
  const lead = {
    ...SAMPLE_LEAD,
    stopsData: [
      SAMPLE_LEAD.stopsData[0],
      { address: '100 Intermediate Ave, Tampa, FL', loadUnload: 'customer' },
      SAMPLE_LEAD.stopsData[1],
    ],
  };
  const message = buildQuoteNotification(lead, 42).message;
  const pickupIndex = message.indexOf('Pickup Address:');
  const stopIndex = message.indexOf('Stop 2: 100 Intermediate Ave');
  const deliveryIndex = message.indexOf('Delivery Address:');
  assert.ok(pickupIndex < stopIndex && stopIndex < deliveryIndex);
});

test('formats paid bookings as a distinct high-priority alert', () => {
  const result = buildBookingNotification(SAMPLE_LEAD, {
    leadId: 42,
    paidAt: '2026-08-20T15:45:00.000Z',
  });
  assert.equal(result.title, 'LOAD PAID & BOOKED | $95.00 | Cargo Van (High Roof)');
  assert.equal(result.priority, '1');
  assert.match(result.message, /Payment: PAID/);
  assert.match(result.message, /Delivery Date: Thu, Aug\. 13, 2026 @ 11:51am/);
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
  assert.equal(request.options.body.get('html'), '1');
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

test('sends booking alerts with high priority', async () => {
  let request;
  await sendBookingNotification(SAMPLE_LEAD, { leadId: 42 }, {
    env: {
      PUSHOVER_NOTIFICATIONS_ENABLED: 'true',
      PUSHOVER_APP_TOKEN: 'app-token',
      PUSHOVER_USER_KEY: 'user-key',
      PUSHOVER_BOOKING_SOUND: 'siren',
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 1, request: 'booking-request' }),
      };
    },
  });
  assert.equal(request.options.body.get('priority'), '1');
  assert.equal(request.options.body.get('sound'), 'siren');
  assert.match(request.options.body.get('title'), /LOAD PAID & BOOKED/);
});
