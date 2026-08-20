// server.js - Backend for Stripe Checkout, User Auth, & PostgreSQL Lead/Order Logging

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQL client
const bcrypt = require('bcrypt'); // For password hashing
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const { normalizeEmail } = require('./email-validation');
const { emailDomainAcceptsMail } = require('./email-domain');

const app = express();
const saltRounds = 10; // Cost factor for bcrypt hashing
const INVALID_EMAIL_DOMAIN_MESSAGE = 'That email domain does not appear to have a working mail service.';
const EMAIL_DOMAIN_CHECK_UNAVAILABLE_MESSAGE = 'Email domain verification is temporarily unavailable. Please try again.';

async function emailDomainIsUsableOrRespond(email, res, { authResponse = false } = {}) {
  const responseBody = message => authResponse
    ? { success: false, message }
    : { status: 'error', message };

  try {
    if (await emailDomainAcceptsMail(email)) return true;
    res.status(422).json(responseBody(INVALID_EMAIL_DOMAIN_MESSAGE));
    return false;
  } catch (error) {
    console.error('Email domain lookup failed:', error);
    res.status(503).json(responseBody(EMAIL_DOMAIN_CHECK_UNAVAILABLE_MESSAGE));
    return false;
  }
}

// --- Middleware ---

const allowedOriginsEnv = process.env.YOUR_WEBSITE_URL || '*';
const allowedOrigins = allowedOriginsEnv.split(',').map(origin => origin.trim()).filter(Boolean);

function deriveDefaultFrontendUrl() {
  if (process.env.FRONTEND_BASE_URL) return process.env.FRONTEND_BASE_URL;
  const candidate = allowedOrigins.find(entry => {
    if (!entry || entry === '*') return false;
    return !(entry.includes('localhost') || entry.includes('127.0.0.1') || entry.includes('::1'));
  });
  if (!candidate) return 'https://delivery-quote-frontend.onrender.com';
  try {
    const url = new URL(candidate);
    return url.origin;
  } catch {
    return candidate.startsWith('http') ? candidate : `https://${candidate}`;
  }
}

const DEFAULT_FRONTEND_URL = deriveDefaultFrontendUrl();
const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL || `${DEFAULT_FRONTEND_URL}/quote.html?checkout=success`;
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL || `${DEFAULT_FRONTEND_URL}/quote.html?checkout=cancelled`;

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || null;
const S3_REGION = process.env.S3_REGION || null;
const S3_UPLOAD_PREFIX = (process.env.S3_UPLOAD_PREFIX || 'uploads/leads').replace(/^\/+|\/+$/g, '');
const S3_PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE || null;
const S3_ENDPOINT = process.env.S3_ENDPOINT || null;
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === 'true';
const SIMULATE_STRIPE_CHECKOUT = process.env.SIMULATE_STRIPE_CHECKOUT === 'true';

function buildSimulatedSessionUrl(successUrl, req) {
  const appendSimulated = (base, hasQuery) =>
    base + (hasQuery ? '&' : '?') + 'simulated=1';

  try {
    const successParsed = new URL(successUrl);
    const hasQuery = Boolean(successParsed.search && successParsed.search.length > 0);
    return appendSimulated(successUrl, hasQuery);
  } catch (parseFailure) {
    const hasQuery = successUrl.includes('?');
    return appendSimulated(successUrl, hasQuery);
  }
}

const MAX_UPLOAD_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 20 * 1024 * 1024);
const RAW_ALLOWED_UPLOAD_MIME_TYPES = process.env.ALLOWED_UPLOAD_MIME_TYPES || 'image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/octet-stream';
const ALLOWED_UPLOAD_MIME_TYPES = new Set(RAW_ALLOWED_UPLOAD_MIME_TYPES.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));

let cachedS3Client = null;
function getS3Client() {
  if (!S3_BUCKET_NAME || !S3_REGION) {
    return null;
  }
  if (!cachedS3Client) {
    const config = { region: S3_REGION };
    if (S3_ENDPOINT) config.endpoint = S3_ENDPOINT;
    if (S3_FORCE_PATH_STYLE) config.forcePathStyle = true;
    cachedS3Client = new S3Client(config);
  }
  return cachedS3Client;
}

function buildUploadKey(extension = '') {
  const prefix = S3_UPLOAD_PREFIX ? `${S3_UPLOAD_PREFIX}/` : '';
  return `${prefix}${uuidv4()}${extension}`;
}

function buildPublicUrl(key) {
  if (S3_PUBLIC_URL_BASE) {
    return `${S3_PUBLIC_URL_BASE.replace(/\/$/, '')}/${key}`;
  }
  if (!S3_BUCKET_NAME || !S3_REGION) return null;
  return `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

function isMimeTypeAllowed(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return false;
  }
  const normalized = mimeType.toLowerCase();
  if (ALLOWED_UPLOAD_MIME_TYPES.has(normalized)) {
    return true;
  }
  if (normalized.includes('/')) {
    const wildcard = `${normalized.split('/')[0]}/*`;
    if (ALLOWED_UPLOAD_MIME_TYPES.has(wildcard)) {
      return true;
    }
  }
  return false;
}

function isOriginAllowed(origin) {

  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const originUrl = new URL(origin);
    return allowedOrigins.some(entry => {
      if (entry === '*') return true;
      try {
        const entryUrl = new URL(entry);
        if (entryUrl.origin === origin) return true;
        return entryUrl.hostname === originUrl.hostname;
      } catch {
        return entry === originUrl.hostname;
      }
    });
  } catch {
    return false;
  }
}

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization, X-Requested-With",
  optionsSuccessStatus: 204
}));
app.use(express.json());

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, '..', 'Delivery_Quote_Frontend')));

// --- Public Configuration Endpoint ---
app.get('/config', (req, res) => {
  const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!googleMapsApiKey) {
    return res.status(500).json({ error: 'Google Maps API key is not configured on the server.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ googleMapsApiKey });
});


// --- PostgreSQL Configuration ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Test DB connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to PostgreSQL database:', err);
  } else {
    console.log('Successfully connected to PostgreSQL database at:', res.rows[0].now);
  }
});

// --- Database Table Initialization ---
async function initializeDatabaseTables() {
  const createUsersTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL, -- 'customer' or 'driver'
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `;
  const createOrdersTableQuery = `
    CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        status VARCHAR(50) DEFAULT 'Awaiting Payment',
        quote_details JSONB,
        total_cost NUMERIC(10, 2),
        stripe_payment_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `;
  const createLeadsTableQuery = `
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      log_type VARCHAR(50),
      contact_name VARCHAR(255),
      contact_email VARCHAR(255),
      contact_phone VARCHAR(50),
      contact_company VARCHAR(255),
      all_stops_details TEXT,
      package_details TEXT,
      vehicle_type VARCHAR(100),
      pickup_date VARCHAR(50),
      pickup_time VARCHAR(50),
      urgency VARCHAR(100),
      inside_delivery BOOLEAN,
      hazardous BOOLEAN,
      bio_hazardous BOOLEAN,
      extra_laborer BOOLEAN,
      total_miles NUMERIC(10, 2),
      calculated_quote NUMERIC(10, 2),
      raw_payload JSONB
    );
  `;

  const ensureLeadsRawPayloadColumnQuery = 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS raw_payload JSONB';

  try {
    await pool.query(createUsersTableQuery);
    console.log("Ensured 'users' table exists.");
    await pool.query(createOrdersTableQuery);
    console.log("Ensured 'orders' table exists.");
    await pool.query(createLeadsTableQuery);
    console.log("Ensured 'leads' table exists.");
    await pool.query(ensureLeadsRawPayloadColumnQuery);
    console.log("Ensured 'raw_payload' column exists on 'leads' table.");
  } catch (err) {
    console.error("Error initializing database tables:", err);
  }
}

initializeDatabaseTables();

// ========== USER AUTHENTICATION API ENDPOINTS ==========
app.post('/api/signup', async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
        return res.status(422).json({ success: false, message: 'Please enter a valid email address.' });
    }
    if (!await emailDomainIsUsableOrRespond(normalizedEmail, res, { authResponse: true })) return;
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
        if (userCheck.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
        }
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const newUser = await pool.query(
            'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
            [name, normalizedEmail, passwordHash, role]
        );
        res.status(201).json({ success: true, message: 'Account created successfully!', user: newUser.rows[0] });
    } catch (error) {
        console.error('Signup Error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
        const { password_hash, ...userWithoutPassword } = user;
        res.status(200).json({ success: true, message: 'Login successful!', user: userWithoutPassword });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// ========== LEAD & PAYMENT ENDPOINTS ==========

const MAX_STOPS = 12;
const MAX_PACKAGES = 25;
const MAX_STRING_LENGTH = 500;

function sanitizePlainText(value, maxLength = MAX_STRING_LENGTH) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function sanitizeBooleanInput(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function sanitizeNumber(value, { min = null, max = null, allowNull = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowNull) return null;
    throw new Error('Expected numeric value.');
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error('Expected numeric value.');
  }
  if (min !== null && numberValue < min) {
    throw new Error(`Number must be greater than or equal to ${min}.`);
  }
  if (max !== null && numberValue > max) {
    throw new Error(`Number must be less than or equal to ${max}.`);
  }
  return Number(numberValue.toFixed(2));
}

function sanitizeInteger(value, { min = null, max = null, allowNull = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowNull) return null;
    throw new Error('Expected integer value.');
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) {
    throw new Error('Expected integer value.');
  }
  if (min !== null && numberValue < min) {
    throw new Error(`Integer must be greater than or equal to ${min}.`);
  }
  if (max !== null && numberValue > max) {
    throw new Error(`Integer must be less than or equal to ${max}.`);
  }
  return numberValue;
}

function sanitizeUrl(value, maxLength = 2000) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.toString().slice(0, maxLength);
  } catch {
    return null;
  }
}

function sanitizeAttachmentMetadata(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const storageKey = sanitizePlainText(raw.storageKey, 600);
  if (!storageKey) {
    return null;
  }
  const originalName = sanitizePlainText(raw.originalName, 255) || null;
  const mimeType = sanitizePlainText(raw.mimeType, 120) || null;
  if (mimeType && !isMimeTypeAllowed(mimeType)) {
    throw new Error('Attachment file type is not permitted.');
  }
  const size = sanitizeInteger(raw.size, { min: 0, max: MAX_UPLOAD_FILE_SIZE_BYTES, allowNull: true });
  const uploadedAt = sanitizePlainText(raw.uploadedAt, 60) || null;
  const publicUrl = sanitizeUrl(raw.publicUrl);
  return {
    storageKey,
    originalName,
    mimeType,
    size,
    publicUrl,
    uploadedAt,
  };
}

function sanitizeStops(rawStops) {
  if (!Array.isArray(rawStops) || rawStops.length === 0) {
    throw new Error('At least one stop is required.');
  }
  if (rawStops.length > MAX_STOPS) {
    throw new Error(`No more than ${MAX_STOPS} stops are allowed.`);
  }
  return rawStops.map((stop, index) => {
    const address = sanitizePlainText(stop?.address, 255);
    if (!address) {
      throw new Error(`Stop ${index + 1} is missing an address.`);
    }
    const loadUnload = sanitizePlainText(stop?.loadUnload, 50);
    const stairs = sanitizeBooleanInput(stop?.stairs);
    const floor = sanitizePlainText(stop?.floor, 30);
    return {
      address,
      loadUnload: loadUnload || null,
      stairs,
      floor: floor || null,
    };
  });
}

function sanitizePackages(rawPackages) {
  if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
    return [];
  }
  if (rawPackages.length > MAX_PACKAGES) {
    throw new Error(`No more than ${MAX_PACKAGES} packages are allowed.`);
  }
  return rawPackages.map((pkg) => {
    let qty = sanitizeInteger(pkg?.qty, { min: 0, max: 999, allowNull: true });
    if (qty === null) qty = 0;
    const desc = sanitizePlainText(pkg?.desc, 255) || 'No description provided';
    const weightValue = sanitizeNumber(pkg?.weight, { min: 0, max: 10000, allowNull: true });
    const lengthValue = sanitizeNumber(pkg?.length, { min: 0, max: 1000, allowNull: true });
    const widthValue = sanitizeNumber(pkg?.width, { min: 0, max: 1000, allowNull: true });
    const heightValue = sanitizeNumber(pkg?.height, { min: 0, max: 1000, allowNull: true });
    const unit = sanitizePlainText(pkg?.unit, 40);
    const legacyFileName = sanitizePlainText(pkg?.fileName, 255) || null;
    const attachment = sanitizeAttachmentMetadata(pkg?.attachment);
    return {
      qty,
      desc,
      weight: weightValue === null ? null : weightValue,
      length: lengthValue === null ? null : lengthValue,
      width: widthValue === null ? null : widthValue,
      height: heightValue === null ? null : heightValue,
      unit: unit || null,
      fileName: attachment?.originalName || legacyFileName,
      attachment: attachment || null,
    };
  });
}

function sanitizeServiceDetails(raw = {}) {
  const vehicleType = sanitizePlainText(raw?.vehicleType, 60);
  const pickupDate = sanitizePlainText(raw?.pickupDate, 40);
  const pickupTime = sanitizePlainText(raw?.pickupTime, 40);
  const urgency = sanitizePlainText(raw?.urgency, 60);
  const specialNotes = sanitizePlainText(raw?.specialNotes, MAX_STRING_LENGTH);
  const insideDelivery = sanitizeBooleanInput(raw?.insideDelivery);
  const fragileHandling = sanitizeBooleanInput(raw?.fragileHandling);
  const extraLaborer = sanitizeBooleanInput(raw?.extraLaborer);
  const hazardousMaterials = sanitizeBooleanInput(raw?.hazardousMaterials ?? raw?.hazardous);
  const hazardousBio = sanitizeBooleanInput(raw?.hazardousBio);

  return {
    vehicleType: vehicleType || null,
    pickupDate: pickupDate || null,
    pickupTime: pickupTime || null,
    urgency: urgency || null,
    specialNotes: specialNotes || null,
    insideDelivery,
    fragileHandling,
    extraLaborer,
    hazardousMaterials,
    hazardousBio,
    hazardous: hazardousMaterials,
  };
}

function normalizeLeadPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be an object.');
  }

  const { requireQuote = false } = options;

  const contactDetailsRaw = payload.contactDetails || {};
  const contactName = sanitizePlainText(contactDetailsRaw.name, 120);
  const contactEmail = normalizeEmail(contactDetailsRaw.email);
  const contactPhone = sanitizePlainText(contactDetailsRaw.phone, 50);
  const contactCompany = sanitizePlainText(contactDetailsRaw.company, 160);

  if (!contactName) {
    throw new Error('Contact name is required.');
  }
  if (!contactEmail) {
    throw new Error('A valid contact email is required.');
  }

  const stopsData = sanitizeStops(payload.stopsData);
  const packagesData = sanitizePackages(payload.packagesData);
  if (!packagesData.length) {
    throw new Error('At least one package must be provided.');
  }
  const serviceDetails = sanitizeServiceDetails(payload.serviceDetails);
  const totalMiles = sanitizeNumber(payload.totalMiles, { min: 0, max: 2500, allowNull: true });
  const calculatedQuote = sanitizeNumber(payload.calculatedQuote, { min: 0, max: 500000, allowNull: !requireQuote });

  if (requireQuote && (calculatedQuote === null || calculatedQuote <= 0)) {
    throw new Error('A positive quote amount is required.');
  }

  return {
    contactDetails: {
      name: contactName,
      email: contactEmail,
      phone: contactPhone || null,
      company: contactCompany || null,
    },
    stopsData,
    packagesData,
    serviceDetails,
    totalMiles,
    calculatedQuote,
  };
}

async function logLeadDataToDB(leadData, logType = 'calculated_quote') {
  if (!leadData || typeof leadData !== 'object') {
    return null;
  }

  const {
    contactDetails = {},
    stopsData = [],
    packagesData = [],
    serviceDetails = {},
    totalMiles = null,
    calculatedQuote = null,
  } = leadData;

  const toTrimmedOrNull = (value) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }
    return value === undefined ? null : value;
  };

  const toNumberOrNull = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const toBooleanOrNull = (value) => {
    if (value === undefined || value === null) return null;
    return Boolean(value);
  };

  const stopsSummary = Array.isArray(stopsData) && stopsData.length > 0
    ? stopsData.map((stop, index) => {
        const address = toTrimmedOrNull(stop?.address) || 'N/A';
        const loadUnload = toTrimmedOrNull(stop?.loadUnload) || 'unspecified';
        const stairs = stop?.stairs ? `Yes${stop?.floor ? ` (Floor ${stop.floor})` : ''}` : 'No';
        return `Stop ${index + 1}: ${address} | Load/Unload: ${loadUnload} | Stairs: ${stairs}`;
      }).join('\n')
    : null;

  const packagesSummary = Array.isArray(packagesData) && packagesData.length > 0
    ? packagesData.map((pkg, index) => {
        const qty = pkg?.qty ?? 0;
        const desc = toTrimmedOrNull(pkg?.desc) || 'No description provided';
        const weight = pkg?.weight !== null && pkg?.weight !== undefined ? `${pkg.weight} lbs each` : 'Weight N/A';
        const dimensions = (pkg?.length !== null && pkg?.length !== undefined) || (pkg?.width !== null && pkg?.width !== undefined) || (pkg?.height !== null && pkg?.height !== undefined)
          ? `${pkg?.length || 0}x${pkg?.width || 0}x${pkg?.height || 0} ${pkg?.unit || ''}`.trim()
          : 'Dimensions N/A';
        const attachmentName = toTrimmedOrNull(pkg?.attachment?.originalName) || toTrimmedOrNull(pkg?.fileName) || 'None';
        const attachmentLink = toTrimmedOrNull(pkg?.attachment?.publicUrl);
        const attachmentSummary = attachmentLink ? `Attachment: ${attachmentName} (${attachmentLink})` : `Attachment: ${attachmentName}`;
        return `Package ${index + 1} (${qty}x): ${desc} | ${weight} | ${dimensions} | ${attachmentSummary}`;
      }).join('\n')
    : null;

  const generalHazardousFlag =
    serviceDetails?.hazardous ?? serviceDetails?.hazardousMaterials ?? serviceDetails?.hazardousBio;

  const extrasSummary = [
    `Special Notes: ${toTrimmedOrNull(serviceDetails?.specialNotes) || 'None'}`,
    `Fragile Handling: ${serviceDetails?.fragileHandling ? 'Yes' : 'No'}`,
    `Inside Delivery: ${serviceDetails?.insideDelivery ? 'Yes' : 'No'}`,
    `Extra Laborer: ${serviceDetails?.extraLaborer ? 'Yes' : 'No'}`,
    `Hazardous Materials: ${generalHazardousFlag ? 'Yes' : 'No'}`,
    `Biohazard: ${serviceDetails?.hazardousBio ? 'Yes' : 'No'}`,
  ].join(' | ');

  let serializedPayload = null;
  try {
    serializedPayload = JSON.stringify(leadData);
  } catch (serializationError) {
    console.error('Failed to serialize lead payload for DB storage:', serializationError);
  }

  const insertQuery = `
    INSERT INTO leads (
      log_type,
      contact_name,
      contact_email,
      contact_phone,
      contact_company,
      all_stops_details,
      package_details,
      vehicle_type,
      pickup_date,
      pickup_time,
      urgency,
      inside_delivery,
      hazardous,
      bio_hazardous,
      extra_laborer,
      total_miles,
      calculated_quote,
      raw_payload
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, $18::jsonb
    )
    RETURNING id, timestamp, log_type;
  `;

  const values = [
    toTrimmedOrNull(logType) || 'calculated_quote',
    toTrimmedOrNull(contactDetails?.name),
    toTrimmedOrNull(contactDetails?.email),
    toTrimmedOrNull(contactDetails?.phone),
    toTrimmedOrNull(contactDetails?.company),
    stopsSummary,
    [packagesSummary, extrasSummary].filter(Boolean).join('\n') || null,
    toTrimmedOrNull(serviceDetails?.vehicleType),
    toTrimmedOrNull(serviceDetails?.pickupDate),
    toTrimmedOrNull(serviceDetails?.pickupTime),
    toTrimmedOrNull(serviceDetails?.urgency),
    toBooleanOrNull(serviceDetails?.insideDelivery),
    toBooleanOrNull(generalHazardousFlag),
    toBooleanOrNull(serviceDetails?.hazardousBio),
    toBooleanOrNull(serviceDetails?.extraLaborer),
    toNumberOrNull(totalMiles),
    toNumberOrNull(calculatedQuote),
    serializedPayload,
  ];

  try {
    const result = await pool.query(insertQuery, values);
    return result.rows[0];
  } catch (error) {
    console.error('Error logging lead data to DB:', error);
    throw error;
  }
}

app.post('/uploads/presign', async (req, res) => {
    const s3Client = getS3Client();
    if (!s3Client) {
      return res.status(503).json({ status: 'error', message: 'File uploads are not configured.' });
    }

    const { fileName, fileType, fileSize } = req.body || {};

    try {
      const sanitizedName = sanitizePlainText(fileName, 255);
      if (!sanitizedName) {
        throw new Error('A fileName is required.');
      }
      const sanitizedMime = sanitizePlainText(fileType, 120) || 'application/octet-stream';
      if (!isMimeTypeAllowed(sanitizedMime)) {
        throw new Error('File type is not permitted.');
      }
      const sanitizedSize = sanitizeInteger(fileSize, { min: 1, max: MAX_UPLOAD_FILE_SIZE_BYTES, allowNull: false });
      const extension = path.extname(sanitizedName || '').toLowerCase();
      const uploadKey = buildUploadKey(extension);

      const command = new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: uploadKey,
        ContentType: sanitizedMime,
        ContentLength: sanitizedSize,
      });

      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 * 5 });
      const publicUrl = buildPublicUrl(uploadKey);

      return res.status(200).json({
        status: 'success',
        uploadUrl,
        fileKey: uploadKey,
        publicUrl,
        expiresIn: 300,
      });
    } catch (error) {
      console.error('Error generating S3 upload URL:', error);
      const message = error instanceof Error ? error.message : 'Failed to prepare upload.';
      if (/required|permitted|expected|less than or equal to/i.test(message)) {
        return res.status(422).json({ status: 'error', message });
      }
      return res.status(500).json({ status: 'error', message: 'Failed to prepare upload.' });
    }
  });

app.post('/log-calculated-quote', async (req, res) => {
    let sanitizedPayload;
    try {
      sanitizedPayload = normalizeLeadPayload(req.body, { requireQuote: false });
    } catch (validationError) {
      return res.status(422).json({ status: 'error', message: validationError.message });
    }
    if (!await emailDomainIsUsableOrRespond(sanitizedPayload.contactDetails.email, res)) return;

    try {
      const record = await logLeadDataToDB(sanitizedPayload, 'calculated_quote');
      return res.status(201).json({
        status: 'success',
        message: 'Quote details logged.',
        lead: {
          id: record?.id ?? null,
          logType: record?.log_type ?? 'calculated_quote',
          createdAt: record?.timestamp ?? null,
        },
      });
    } catch (error) {
      console.error('Error handling /log-calculated-quote:', error);
      return res.status(500).json({ status: 'error', message: 'Failed to log calculated quote.' });
    }
});

app.post('/create-checkout-session', async (req, res) => {
    let sanitizedPayload;
    try {
      sanitizedPayload = normalizeLeadPayload(req.body, { requireQuote: true });
    } catch (validationError) {
      return res.status(422).json({ status: 'error', message: validationError.message });
    }
    if (!await emailDomainIsUsableOrRespond(sanitizedPayload.contactDetails.email, res)) return;

    const { contactDetails, calculatedQuote, serviceDetails, totalMiles } = sanitizedPayload;
    const quoteAmount = Number(calculatedQuote);
    const unitAmount = Math.round(quoteAmount * 100);

    const successUrl = CHECKOUT_SUCCESS_URL;
    const cancelUrl = CHECKOUT_CANCEL_URL;

    try {
      let session;
      if (SIMULATE_STRIPE_CHECKOUT) {
        const fakeSessionId = 'cs_test_' + uuidv4().replace(/-/g, '');
        const simulatedUrl = buildSimulatedSessionUrl(successUrl, req);
        session = {
          id: fakeSessionId,
          url: simulatedUrl,
          expires_at: Math.floor(Date.now() / 1000) + 60 * 10,
          customer_email: contactDetails.email || null,
        };
      } else {
        session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          customer_email: contactDetails.email || undefined,
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: 'Delivery Service Quote',
                  description: `Vehicle: ${serviceDetails.vehicleType || 'N/A'} | Urgency: ${serviceDetails.urgency || 'Standard'}`,
                },
                unit_amount: unitAmount,
              },
              quantity: 1,
            },
          ],
          metadata: {
            quote_amount: quoteAmount.toString(),
            total_miles: totalMiles !== null ? totalMiles.toString() : 'N/A',
            contact_name: contactDetails.name,
            contact_company: contactDetails.company || 'N/A',
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
        });
      }

      const leadRecord = await logLeadDataToDB(sanitizedPayload, 'checkout_session_created');

      let userId = null;
      if (contactDetails.email) {
        const userLookup = await pool.query('SELECT id FROM users WHERE email = $1', [contactDetails.email]);
        userId = userLookup.rows[0]?.id || null;
      }

      const orderInsert = await pool.query(
        `INSERT INTO orders (user_id, status, quote_details, total_cost, stripe_payment_id)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING id, created_at;`,
        [
          userId,
          'Checkout Session Created',
          JSON.stringify(sanitizedPayload),
          quoteAmount,
          session.id,
        ],
      );

      const orderRecord = orderInsert.rows[0] || {};

      return res.status(200).json({
        status: 'success',
        message: 'Checkout session created.',
        checkout: {
          sessionId: session.id,
          url: session.url,
          amount: quoteAmount,
          currency: 'usd',
          expiresAt: session.expires_at ?? null,
          customerEmail: contactDetails.email || null,
        },
        order: {
          id: orderRecord.id ?? null,
          createdAt: orderRecord.created_at ?? null,
          status: 'Checkout Session Created',
        },
        lead: {
          id: leadRecord?.id ?? null,
          logType: leadRecord?.log_type ?? 'checkout_session_created',
          createdAt: leadRecord?.timestamp ?? null,
        },
      });
    } catch (error) {
      console.error('Error handling /create-checkout-session:', error);
      return res.status(500).json({ status: 'error', message: 'Failed to create checkout session.' });
    }
});

// Basic Root Route
app.get('/', (req, res) => {
    res.send('Delivery Quote Backend Server (with User Auth) is Running!');
});

// Catch-all route for client-side routing. This must be after all other API routes.
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'Delivery_Quote_Frontend', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
