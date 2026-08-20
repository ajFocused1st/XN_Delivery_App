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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function formatQuoteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : 'Amount unavailable';
}

function formatMiles(value) {
  const miles = Number(value);
  return Number.isFinite(miles) ? `${miles.toFixed(1)} miles` : 'Mileage unavailable';
}

function formatDateTime(dateValue, timeValue) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeValue || ''));
  if (!dateMatch || !timeMatch) return 'Date/time unavailable';
  const year = Number(dateMatch[1]);
  const monthIndex = Number(dateMatch[2]) - 1;
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day || hours > 23 || minutes > 59) {
    return 'Date/time unavailable';
  }
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
  const displayHour = hours % 12 || 12;
  const meridiem = hours < 12 ? 'am' : 'pm';
  return `${weekdays[date.getUTCDay()]}, ${months[monthIndex]} ${day}, ${year} @ ${displayHour}:${String(minutes).padStart(2, '0')}${meridiem}`;
}

function formatStopLines(stops) {
  if (!stops.length) return ['Pickup Address: Unavailable', 'Delivery Address: Unavailable'];
  if (stops.length === 1) {
    return [`Pickup Address: ${cleanText(stops[0]?.address, 120) || 'Unavailable'}`, 'Delivery Address: Unavailable'];
  }
  return stops.map((stop, index) => {
    const address = cleanText(stop?.address, 120) || 'Unavailable';
    if (index === 0) return `Pickup Address: ${address}`;
    if (index === stops.length - 1) return `Delivery Address: ${address}`;
    return `Stop ${index + 1}: ${address}`;
  });
}

function formatPiecesAndWeight(packages) {
  let pieces = 0;
  let totalWeight = 0;
  const descriptions = [];
  for (const item of packages) {
    const quantity = Number(item?.qty) || 0;
    const weight = Number(item?.weight) || 0;
    pieces += quantity;
    totalWeight += quantity * weight;
    const description = cleanText(item?.desc, 35);
    if (description && descriptions.length < 2 && !descriptions.includes(description)) {
      descriptions.push(description);
    }
  }
  const freight = descriptions.length ? descriptions.join(', ') : 'Freight details unavailable';
  return `${pieces || '?'} pc | ${totalWeight.toFixed(0)} lb | ${freight}`;
}

function formatHandling(stops) {
  const labels = {
    customer: 'Customer',
    driver: 'Driver',
    driver_assist: 'Driver assist',
  };
  return stops.map((stop, index) => {
    const responsibility = labels[stop?.loadUnload] || 'Unknown';
    const stairFlights = Number(stop?.stairFlights || Math.max(0, Number(stop?.floor || 1) - 1));
    const stairs = stop?.stairs ? ` + ${stairFlights || '?'} stair flight(s)` : '';
    return `S${index + 1} ${responsibility}${stairs}`;
  }).join('; ');
}

function formatExtras(services) {
  const extras = [];
  if (services.insideDelivery) extras.push('Inside');
  if (services.hazardousBio || services.hazardous || services.bioHazardous) extras.push('Hazmat/Bio');
  if (services.fragileHandling) extras.push('Fragile');
  if (services.extraLaborer) extras.push('Extra laborer');
  if (services.afterHoursApplied) extras.push('Late night');
  return extras.length ? extras.join(', ') : 'None';
}

function buildOperationalMessage(leadData, leadId, bookingDetails = null) {
  const contact = leadData?.contactDetails || {};
  const services = leadData?.serviceDetails || {};
  const stops = Array.isArray(leadData?.stopsData) ? leadData.stopsData : [];
  const packages = Array.isArray(leadData?.packagesData) ? leadData.packagesData : [];
  const serviceLabel = cleanText(services.urgencyLabel || services.urgency, 45) || 'Service unavailable';
  const quoteId = cleanText(leadData?.quoteId, 40) || 'Quote ID unavailable';

  return [
    `Quote: ${quoteId}${leadId !== undefined && leadId !== null ? ` | Lead #${leadId}` : ''}`,
    bookingDetails ? `Payment: PAID${bookingDetails.paidAt ? ` | ${cleanText(bookingDetails.paidAt, 30)}` : ''}` : null,
    `Customer: ${cleanText(contact.name, 70) || 'Unknown'}${contact.company ? ` | ${cleanText(contact.company, 55)}` : ''}`,
    `Email: ${cleanText(contact.email, 100) || 'Unavailable'}`,
    `Phone: ${cleanText(contact.phone, 40) || 'Unavailable'}`,
    `Route: ${formatMiles(leadData?.totalMiles)} | ${stops.length} stops`,
    `Pickup Date: ${formatDateTime(services.pickupDate, services.pickupTime)}`,
    `Delivery Date: ${formatDateTime(services.deliveryDate, services.deliveryTime)}`,
    `Urgency: ${serviceLabel}${services.afterHoursApplied ? ' + Late Night' : ''}`,
    ...formatStopLines(stops),
    `Freight: ${formatPiecesAndWeight(packages)}`,
    `Handling: ${formatHandling(stops) || 'Unavailable'}`,
    `Extras: ${formatExtras(services)}`,
    services.specialNotes ? `Notes: ${cleanText(services.specialNotes, 140)}` : null,
  ].filter(Boolean).join('\n');
}

function buildQuoteNotification(leadData, leadId) {
  const services = leadData?.serviceDetails || {};
  const quoteAmount = formatQuoteAmount(leadData?.calculatedQuote);
  const vehicle = VEHICLE_LABELS[services.vehicleType] || cleanText(services.vehicleType) || 'Vehicle unavailable';

  return {
    title: cleanText(`NEW QUOTE | ${quoteAmount} | ${vehicle}`, 250),
    message: truncateUtf8(`<b>Price: ${escapeHtml(quoteAmount)}</b>\n${escapeHtml(buildOperationalMessage(leadData, leadId))}`, 1024),
    priority: '0',
    html: true,
  };
}

function buildBookingNotification(leadData, bookingDetails = {}) {
  const services = leadData?.serviceDetails || {};
  const quoteAmount = formatQuoteAmount(leadData?.calculatedQuote);
  const vehicle = VEHICLE_LABELS[services.vehicleType] || cleanText(services.vehicleType) || 'Vehicle unavailable';
  return {
    title: cleanText(`LOAD PAID & BOOKED | ${quoteAmount} | ${vehicle}`, 250),
    message: truncateUtf8(`<b>Price: ${escapeHtml(quoteAmount)}</b>\n${escapeHtml(buildOperationalMessage(leadData, bookingDetails.leadId, bookingDetails))}`, 1024),
    priority: '1',
    html: true,
  };
}

async function sendPushoverNotification(notification, options = {}) {
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

  const body = new URLSearchParams({
    token,
    user,
    title: notification.title,
    message: notification.message,
    priority: notification.priority || '0',
  });
  const configuredSound = cleanText(options.sound || env.PUSHOVER_SOUND, 30);
  if (configuredSound) body.set('sound', configuredSound);
  if (notification.html) body.set('html', '1');

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

async function sendQuoteNotification(leadData, leadId, options = {}) {
  return sendPushoverNotification(buildQuoteNotification(leadData, leadId), options);
}

async function sendBookingNotification(leadData, bookingDetails = {}, options = {}) {
  const env = options.env || process.env;
  return sendPushoverNotification(buildBookingNotification(leadData, bookingDetails), {
    ...options,
    sound: env.PUSHOVER_BOOKING_SOUND || env.PUSHOVER_SOUND,
  });
}

module.exports = {
  buildBookingNotification,
  buildQuoteNotification,
  isPushoverEnabled,
  sendBookingNotification,
  sendQuoteNotification,
};
