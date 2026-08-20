'use strict';

const SERVICE_LABELS = Object.freeze({
  asap_2hr: 'ASAP (2 Hours)',
  expedited_4hr: 'Expedited (4 Hours)',
  standard_9pm: 'Standard',
});

function parseLocalDateTime(date, time, label) {
  const dateText = String(date || '').trim();
  const timeText = String(time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !/^\d{2}:\d{2}$/.test(timeText)) {
    throw new Error(`${label} date and time are required.`);
  }

  const timestamp = Date.parse(`${dateText}T${timeText}:00`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} date and time are invalid.`);
  }
  return timestamp;
}

function minutesSinceMidnight(time) {
  const [hours, minutes] = String(time).split(':').map(Number);
  return hours * 60 + minutes;
}

function isLateNightTime(time) {
  const minutes = minutesSinceMidnight(time);
  return minutes >= 22 * 60 || minutes <= 4 * 60 + 30;
}

function deriveSchedule(serviceDetails = {}) {
  const pickupAt = parseLocalDateTime(
    serviceDetails.pickupDate,
    serviceDetails.pickupTime,
    'Pickup'
  );
  const deliveryAt = parseLocalDateTime(
    serviceDetails.deliveryDate,
    serviceDetails.deliveryTime,
    'Delivery deadline'
  );
  const windowMinutes = Math.round((deliveryAt - pickupAt) / 60000);

  if (windowMinutes <= 0) {
    throw new Error('The delivery deadline must be after the pickup time.');
  }

  let serviceLevel = 'standard_9pm';
  if (windowMinutes <= 120) serviceLevel = 'asap_2hr';
  else if (windowMinutes <= 240) serviceLevel = 'expedited_4hr';

  const afterHoursApplied =
    isLateNightTime(serviceDetails.pickupTime) ||
    isLateNightTime(serviceDetails.deliveryTime);

  return {
    serviceLevel,
    serviceLabel: SERVICE_LABELS[serviceLevel],
    windowMinutes,
    windowHours: Number((windowMinutes / 60).toFixed(2)),
    afterHoursApplied,
  };
}

module.exports = {
  SERVICE_LABELS,
  deriveSchedule,
  isLateNightTime,
};
