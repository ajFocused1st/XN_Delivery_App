'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveSchedule, isLateNightTime } = require('./scheduling');

test('assigns ASAP to a window of two hours or less', () => {
  const result = deriveSchedule({
    pickupDate: '2026-08-20', pickupTime: '09:00',
    deliveryDate: '2026-08-20', deliveryTime: '11:00',
  });
  assert.equal(result.serviceLevel, 'asap_2hr');
  assert.equal(result.windowMinutes, 120);
  assert.equal(result.afterHoursApplied, false);
});

test('assigns expedited to a window over two and up to four hours', () => {
  const result = deriveSchedule({
    pickupDate: '2026-08-20', pickupTime: '09:00',
    deliveryDate: '2026-08-20', deliveryTime: '13:00',
  });
  assert.equal(result.serviceLevel, 'expedited_4hr');
});

test('assigns standard to a window over four hours', () => {
  const result = deriveSchedule({
    pickupDate: '2026-08-20', pickupTime: '09:00',
    deliveryDate: '2026-08-20', deliveryTime: '17:00',
  });
  assert.equal(result.serviceLevel, 'standard_9pm');
});

test('late-night applies when either endpoint is between 10 PM and 4:30 AM', () => {
  assert.equal(isLateNightTime('22:00'), true);
  assert.equal(isLateNightTime('04:30'), true);
  assert.equal(isLateNightTime('04:31'), false);
  const result = deriveSchedule({
    pickupDate: '2026-08-20', pickupTime: '21:30',
    deliveryDate: '2026-08-20', deliveryTime: '22:30',
  });
  assert.equal(result.serviceLevel, 'asap_2hr');
  assert.equal(result.afterHoursApplied, true);
});

test('rejects a deadline that is not after pickup', () => {
  assert.throws(() => deriveSchedule({
    pickupDate: '2026-08-20', pickupTime: '12:00',
    deliveryDate: '2026-08-20', deliveryTime: '11:00',
  }), /must be after/);
});
