'use strict';

const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';
const DEFAULT_TIMEOUT_MS = 8000;

const VEHICLE_LABELS = Object.freeze({
  car: 'Car',
  suv: 'SUV',
  pickup_truck: 'Pickup Truck',
  cargo_van: 'Cargo Van',
  cargo_van_high_roof: 'Cargo Van (High Roof)',
  box_truck: 'Box Truck',
});

function isPushoverEnabled(env = process.env) {
  return String(env.PUSHOVER_NOTIFICATIONS_ENABLED || '').trim().toLowerCase() === 'true';
}

function cleanText(value, maxLength = 160) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/g, '').trimEnd();
}

function formatQuoteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : 'Amount unavailable';
}

function formatMiles(value) {
  const miles = Number(value);
  return Number.isFinite(miles) ? `${miles.toFixed(1)} miles` : 'Mileage unavailable';
}

function buildQuoteNotification(leadData, leadId) {
  const contact = leadData?.contactDetails || {};
  const services = leadData?.serviceDetails || {};
  const stops = Array.isArray(leadData?.stopsData) ? leadData.stopsData : [];
  const quoteAmount = formatQuoteAmount(leadData?.calculatedQuote);
  const vehicle = VEHICLE_LABELS[services.vehicleType] || cleanText(services.vehicleType) || 'Vehicle unavailable';
  const customerName = cleanText(contact.name) || 'Unknown customer';
  const pickupAddress = cleanText(stops[0]?.address, 120) || 'Pickup unavailable';
  const deliveryAddress = cleanText(stops[stops.length - 1]?.address, 120) || 'Delivery unavailable';
  const pickupDate = cleanText(services.pickupDate) || 'Date unavailable';
  const pickupTime = cleanText(services.pickupTime) || 'Time unavailable';

  const lines = [
    leadId !== undefined && leadId !== null ? `Lead #${leadId}` : null,
    customerName,
    `${vehicle} | ${formatMiles(leadData?.totalMiles)}`,
    `${pickupAddress} -> ${deliveryAddress}`,
    `Pickup: ${pickupDate} at ${pickupTime}`,
  ].filter(Boolean);

  return {
    title: cleanText(`New XN Quote | ${quoteAmount}`, 250),
    message: truncateUtf8(lines.join('\n'), 1024),
  };
}

async function sendQuoteNotification(leadData, leadId, options = {}) {
  const env = options.env || process.env;
  if (!isPushoverEnabled(env)) {
    return { sent: false, reason: 'disabled' };
  }

  const token = String(env.PUSHOVER_APP_TOKEN || '').trim();
  const user = String(env.PUSHOVER_USER_KEY || '').trim();
  if (!token || !user) {
    throw new Error('Pushover credentials are incomplete.');
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('This Node.js runtime does not provide fetch().');
  }

  const notification = buildQuoteNotification(leadData, leadId);
  const body = new URLSearchParams({
    token,
    user,
    title: notification.title,
    message: notification.message,
    priority: '0',
  });
  const configuredSound = cleanText(env.PUSHOVER_SOUND, 30);
  if (configuredSound) body.set('sound', configuredSound);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(options.endpoint || PUSHOVER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    const responseText = await response.text();
    let responseBody = null;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // A non-JSON error is handled using the HTTP status below.
    }

    if (!response.ok || responseBody?.status !== 1) {
      const details = Array.isArray(responseBody?.errors)
        ? responseBody.errors.join('; ')
        : `HTTP ${response.status}`;
      throw new Error(`Pushover rejected the notification: ${details}`);
    }

    return { sent: true, requestId: responseBody.request || null };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Pushover notification timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  buildQuoteNotification,
  isPushoverEnabled,
  sendQuoteNotification,
};
