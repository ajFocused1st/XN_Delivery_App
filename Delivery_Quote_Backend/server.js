// server.js - Backend for Stripe Checkout & PostgreSQL Lead Logging

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQL client for Node.js

const app = express();

const QUOTE_RULES = Object.freeze({
  vehicleRates: Object.freeze({
    car: 1.50,
    suv: 1.75,
    pickup_truck: 2.00,
    cargo_van: 2.25,
    cargo_van_high_roof: 2.75,
    box_truck: 3.50,
  }),
  vehicleMinimums: Object.freeze({
    car: 30,
    suv: 40,
    pickup_truck: 50,
    cargo_van: 75,
    cargo_van_high_roof: 95,
    box_truck: 150,
  }),
  weightRate: 0.03,
  maxTotalWeight: 4000,
  urgencyFees: Object.freeze({
    standard_9pm: 0,
    asap_2hr: 65,
    expedited_4hr: 50,
    late_night: 75,
  }),
  additionalStopFee: 3.50,
  extraLaborerFee: 35,
  stairFeePerFloor: 5,
});

function parseFiniteNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    throw new Error(fieldName + ' is required.');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(fieldName + ' must be a valid number.');
  }
  return parsed;
}

function isSelected(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function getDriverHandlingFee(totalWeight) {
  if (totalWeight <= 0) return 0;
  if (totalWeight <= 50) return 5;
  if (totalWeight <= 250) return 10;
  if (totalWeight <= 500) return 15;
  if (totalWeight <= 1000) return 20;
  if (totalWeight <= 1500) return 30;
  if (totalWeight <= 2000) return 40;
  if (totalWeight <= 2500) return 50;
  return 60;
}

function calculateAuthoritativeQuote(leadData) {
  if (!leadData || typeof leadData !== 'object') {
    throw new Error('Quote details are required.');
  }

  const totalMiles = parseFiniteNumber(leadData.totalMiles, 'Total miles');
  if (totalMiles < 0 || totalMiles > 2500) {
    throw new Error('Total miles must be between 0 and 2500.');
  }

  const stopsData = leadData.stopsData;
  if (!Array.isArray(stopsData) || stopsData.length < 2) {
    throw new Error('At least two stops are required.');
  }

  const packagesData = leadData.packagesData;
  if (!Array.isArray(packagesData) || packagesData.length < 1) {
    throw new Error('At least one package is required.');
  }

  let totalWeight = 0;
  for (const packageData of packagesData) {
    const quantity = parseFiniteNumber(packageData?.qty, 'Package quantity');
    const weightPerItem = parseFiniteNumber(packageData?.weight, 'Package weight');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new Error('Package quantity must be a whole number between 1 and 999.');
    }
    if (weightPerItem < 0 || weightPerItem > QUOTE_RULES.maxTotalWeight) {
      throw new Error('Package weight is outside the permitted range.');
    }
    totalWeight += quantity * weightPerItem;
  }

  if (totalWeight > QUOTE_RULES.maxTotalWeight) {
    throw new Error('Total weight exceeds the maximum limit of 4000 lbs.');
  }

  const serviceDetails = leadData.serviceDetails || {};
  const vehicleType = serviceDetails.vehicleType;
  const mileageRate = QUOTE_RULES.vehicleRates[vehicleType];
  if (!mileageRate) {
    throw new Error('A valid vehicle type is required.');
  }

  let totalLoadUnloadFee = 0;
  let totalStairCost = 0;
  const driverHandlingFee = getDriverHandlingFee(totalWeight);
  const allowedResponsibilities = new Set(['customer', 'driver', 'driver_assist']);

  for (const stop of stopsData) {
    const responsibility = stop?.loadUnload;
    if (!allowedResponsibilities.has(responsibility)) {
      throw new Error('Each stop must specify a valid loading responsibility.');
    }

    if (responsibility === 'driver') {
      totalLoadUnloadFee += driverHandlingFee;
    } else if (responsibility === 'driver_assist') {
      totalLoadUnloadFee += driverHandlingFee / 2;
    }

    if (isSelected(stop?.stairs)) {
      const floor = parseFiniteNumber(stop?.floor, 'Floor number');
      if (!Number.isInteger(floor) || floor < 1) {
        throw new Error('Floor number must be a positive whole number when stairs are selected.');
      }
      if (floor > 1) {
        totalStairCost += (floor - 1) * QUOTE_RULES.stairFeePerFloor;
      }
    }
  }

  const urgency = serviceDetails.urgency;
  if (!Object.prototype.hasOwnProperty.call(QUOTE_RULES.urgencyFees, urgency)) {
    throw new Error('A valid urgency option is required.');
  }

  const mileageCost = totalMiles * mileageRate;
  const weightCost = totalWeight * QUOTE_RULES.weightRate;

  let servicesMultiplier = 1;
  if (isSelected(serviceDetails.insideDelivery)) servicesMultiplier += 0.05;
  if (isSelected(serviceDetails.hazardousBio) || isSelected(serviceDetails.hazardous) || isSelected(serviceDetails.bioHazardous)) {
    servicesMultiplier += 0.20;
  }
  if (isSelected(serviceDetails.fragileHandling)) servicesMultiplier += 0.05;

  const flatServiceFees = isSelected(serviceDetails.extraLaborer)
    ? QUOTE_RULES.extraLaborerFee
    : 0;
  const urgencyPremium = QUOTE_RULES.urgencyFees[urgency];
  const additionalStopFee = Math.max(0, stopsData.length - 2) * QUOTE_RULES.additionalStopFee;
  const baseCost = mileageCost + weightCost;
  const costAfterMultiplier = baseCost * servicesMultiplier;
  const subtotalBeforeMinimum =
    costAfterMultiplier +
    totalLoadUnloadFee +
    totalStairCost +
    flatServiceFees +
    urgencyPremium +
    additionalStopFee;
  const vehicleMinimum = QUOTE_RULES.vehicleMinimums[vehicleType];
  const minimumAdjustment = Math.max(0, vehicleMinimum - subtotalBeforeMinimum);
  const totalCost = subtotalBeforeMinimum + minimumAdjustment;

  return {
    total: Number(Math.max(0, totalCost).toFixed(2)),
    totalMiles: Number(totalMiles.toFixed(2)),
    totalWeight: Number(totalWeight.toFixed(2)),
    breakdown: {
      mileageCost: Number(mileageCost.toFixed(2)),
      weightCost: Number(weightCost.toFixed(2)),
      servicesMultiplier: Number(servicesMultiplier.toFixed(2)),
      loadUnloadFee: Number(totalLoadUnloadFee.toFixed(2)),
      stairCost: Number(totalStairCost.toFixed(2)),
      flatServiceFees: Number(flatServiceFees.toFixed(2)),
      urgencyPremium: Number(urgencyPremium.toFixed(2)),
      additionalStopFee: Number(additionalStopFee.toFixed(2)),
      vehicleMinimum: Number(vehicleMinimum.toFixed(2)),
      minimumAdjustment: Number(minimumAdjustment.toFixed(2)),
    },
  };
}


// --- Middleware ---
app.use(cors({
  origin: process.env.YOUR_WEBSITE_URL || '*', // Allow configured origin or wildcard
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization, X-Requested-With",
  optionsSuccessStatus: 204 // Standard for successful preflight
}));
console.log("Applied cors() middleware. Allowed origin will be:", process.env.YOUR_WEBSITE_URL || '*');
app.use(express.json()); // To parse JSON request bodies

// --- PostgreSQL Configuration ---
// The DATABASE_URL environment variable will be provided by Render's service environment.
// It typically includes the username, password, host, port, and database name.
// Example format: postgres://user:password@host:port/database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL configuration for Render PostgreSQL (often required for external, good for internal too)
  // Render's free tier might handle SSL internally without this, but it's robust to include.
  // If you encounter SSL errors, you might need to adjust based on Render's specific SSL setup for internal connections.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Test the database connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to PostgreSQL database:', err);
  } else {
    console.log('Successfully connected to PostgreSQL database at:', res.rows[0].now);
  }
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
  // Consider how to handle persistent DB connection errors (e.g., exit, retry logic)
  // process.exit(-1); 
});

// Function to ensure the 'leads' table exists in the database
async function ensureLeadsTableExists() {
  const createTableQuery = `
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
      calculated_quote NUMERIC(10, 2)
    );
  `;
  try {
    await pool.query(createTableQuery);
    console.log("Ensured 'leads' table exists in PostgreSQL database.");
  } catch (err) {
    console.error("Error ensuring 'leads' table exists in PostgreSQL:", err);
    // This is a critical error for the application's logging functionality.
    // You might want to throw the error or handle it more gracefully.
  }
}

// Ensure table exists when the server starts
ensureLeadsTableExists().catch(err => console.error("Failed to initialize database table:", err));


// --- Helper function to log data to PostgreSQL ---
async function logLeadDataToDB(leadData, logType = "CalculatedQuote") {
  console.log(`Attempting to log lead data to PostgreSQL DB (Type: ${logType})...`);
  
  // Prepare data for insertion, using null for missing optional fields
  const contactName = leadData.contactDetails?.name || null;
  const contactEmail = leadData.contactDetails?.email || null;
  const contactPhone = leadData.contactDetails?.phone || null;
  const contactCompany = leadData.contactDetails?.company || null;

  let allStopsString = null; // Default to null if no stop data
  if (leadData.stopsData && leadData.stopsData.length > 0) {
    allStopsString = leadData.stopsData.map(stop => {
      const address = (stop.address || 'N/A').replace(/\|/g, '/').replace(/;/g, ',');
      let loadUnload = stop.loadUnload || 'N/A';
      if (loadUnload === 'driver') loadUnload = 'Driver'; 
      else if (loadUnload === 'customer') loadUnload = 'Customer'; 
      else if (loadUnload === 'driver_assist') loadUnload = 'Driver Assist';
      let stairsInfoString = 'No'; 
      if (stop.stairs) { stairsInfoString = `Yes, Fl: ${stop.floor || 'N/A'}`; }
      return `${address}|${loadUnload}|${stairsInfoString}`;
    }).join(';');
  }

  let packagesStr = null; // Default to null if no package data
  if (leadData.packagesData && leadData.packagesData.length > 0) {
    packagesStr = leadData.packagesData.map(p => {
      const cleanDesc = (p.desc || 'N/A').replace(/\|/g, '/').replace(/;/g, ',');
      return `Qty:${p.qty || 'N/A'}, Desc:${cleanDesc}, Wt:${p.weight || 'N/A'}lbs, Dim:${p.length || 'N/A'}x${p.width || 'N/A'}x${p.height || 'N/A'} ${p.unit || 'N/A'}`;
    }).join('; ');
  }

  const vehicleType = leadData.serviceDetails?.vehicleType || null;
  const pickupDate = leadData.serviceDetails?.pickupDate || null;
  const pickupTime = leadData.serviceDetails?.pickupTime || null;
  const urgency = leadData.serviceDetails?.urgency || null;
  const insideDelivery = leadData.serviceDetails?.insideDelivery || false;
  const hazardous = leadData.serviceDetails?.hazardous || false;
  const bioHazardous = leadData.serviceDetails?.bioHazardous || false;
  const extraLaborer = leadData.serviceDetails?.extraLaborer || false;
  
  // Ensure numerical values are correctly parsed or null
  const totalMiles = (leadData.totalMiles !== undefined && leadData.totalMiles !== null) ? parseFloat(leadData.totalMiles) : null;
  const calculatedQuoteValue = (leadData.calculatedQuote !== undefined && leadData.calculatedQuote !== null) ? parseFloat(leadData.calculatedQuote) : null;

  const insertQuery = `
    INSERT INTO leads (
      log_type, contact_name, contact_email, contact_phone, contact_company,
      all_stops_details, package_details, vehicle_type, pickup_date, pickup_time,
      urgency, inside_delivery, hazardous, bio_hazardous, extra_laborer,
      total_miles, calculated_quote
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING id;
  `;
  const values = [
    logType, contactName, contactEmail, contactPhone, contactCompany,
    allStopsString, packagesStr, vehicleType, pickupDate, pickupTime,
    urgency, insideDelivery, hazardous, bioHazardous, extraLaborer,
    totalMiles, calculatedQuoteValue
  ];

  try {
    const result = await pool.query(insertQuery, values);
    console.log(`Lead data (Type: ${logType}) successfully inserted into PostgreSQL DB with ID: ${result.rows[0].id}`);
  } catch (dbError) {
    console.error(`Error inserting lead data into PostgreSQL DB (Type: ${logType}):`, dbError);
    throw dbError; // Re-throw the error to be handled by the calling endpoint
  }
}

// --- API Endpoint for Logging Calculated Quotes ---
app.post('/log-calculated-quote', async (req, res) => {
  console.log(`POST /log-calculated-quote received at ${new Date().toISOString()}`);
  const leadData = req.body;

  if (!leadData || !leadData.contactDetails) {
    return res.status(400).json({ status: 'error', message: 'Incomplete lead data received.' });
  }

  let authoritativeQuote;
  try {
    authoritativeQuote = calculateAuthoritativeQuote(leadData);
  } catch (error) {
    console.warn('Invalid quote details received for logging:', error.message);
    return res.status(422).json({ status: 'error', message: error.message });
  }

  const submittedQuote = Number(leadData.calculatedQuote);
  if (Number.isFinite(submittedQuote) && Math.abs(submittedQuote - authoritativeQuote.total) > 0.01) {
    console.warn('Browser quote did not match the server quote.', {
      submittedQuote,
      authoritativeQuote: authoritativeQuote.total,
    });
  }

  const verifiedLeadData = {
    ...leadData,
    totalMiles: authoritativeQuote.totalMiles,
    calculatedQuote: authoritativeQuote.total,
  };

  try {
    await logLeadDataToDB(verifiedLeadData, 'CalculatedQuote');
    return res.status(200).json({
      status: 'success',
      message: 'Quote data verified and logged.',
      calculatedQuote: authoritativeQuote.total,
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Failed to log quote data to DB on server.',
    });
  }
});

// --- API Endpoint for Creating Stripe Checkout Session AND Logging Lead ---
app.post('/create-checkout-session', async (req, res) => {
  console.log(`POST /create-checkout-session received at ${new Date().toISOString()}`);
  const leadData = req.body;

  if (
    !leadData ||
    !leadData.contactDetails ||
    !leadData.contactDetails.email ||
    !leadData.contactDetails.name
  ) {
    return res.status(400).json({ error: 'Incomplete or invalid contact details received.' });
  }

  let authoritativeQuote;
  try {
    authoritativeQuote = calculateAuthoritativeQuote(leadData);
  } catch (error) {
    console.warn('Invalid quote details received for checkout:', error.message);
    return res.status(422).json({ error: error.message });
  }

  const submittedQuote = Number(leadData.calculatedQuote);
  if (Number.isFinite(submittedQuote) && Math.abs(submittedQuote - authoritativeQuote.total) > 0.01) {
    console.warn('Browser quote did not match the server quote.', {
      submittedQuote,
      authoritativeQuote: authoritativeQuote.total,
    });
  }

  const verifiedLeadData = {
    ...leadData,
    totalMiles: authoritativeQuote.totalMiles,
    calculatedQuote: authoritativeQuote.total,
  };

  try {
    await logLeadDataToDB(verifiedLeadData, 'CheckoutAttempt');
  } catch (logError) {
    console.error('Error logging lead data during checkout attempt; Stripe checkout will continue:', logError);
  }

  const amountInCents = Math.round(authoritativeQuote.total * 100);
  if (amountInCents < 50) {
    return res.status(400).json({ error: 'Quote amount below minimum charge.' });
  }

  const customerEmail = verifiedLeadData.contactDetails.email;
  const firstStopAddress = String(verifiedLeadData.stopsData[0]?.address || '');
  const orderSummary = `Delivery Quote: ${verifiedLeadData.stopsData.length} stops (${authoritativeQuote.totalMiles.toFixed(1)} miles). Pickup: ${verifiedLeadData.serviceDetails.pickupDate || 'N/A'} at ${verifiedLeadData.serviceDetails.pickupTime || 'N/A'}. Vehicle: ${verifiedLeadData.serviceDetails.vehicleType || 'N/A'}. First Stop: ${firstStopAddress.substring(0, 50)}${firstStopAddress.length > 50 ? '...' : ''}.`.substring(0, 200);

  const YOUR_DOMAIN = process.env.YOUR_WEBSITE_URL;
  if (!YOUR_DOMAIN || YOUR_DOMAIN === 'http://temp.com') {
    console.error('CRITICAL: YOUR_WEBSITE_URL environment variable is not set correctly in Render for redirects!');
  }
  const successUrl = `${YOUR_DOMAIN || 'https://your-default-success-url.com'}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = YOUR_DOMAIN || 'https://your-default-cancel-url.com';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Xpedite Now Delivery Quote',
            description: orderSummary,
          },
          unit_amount: amountInCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
    });
    console.log('Stripe Session Created:', session.id);
    return res.json({
      url: session.url,
      calculatedQuote: authoritativeQuote.total,
    });
  } catch (stripeError) {
    console.error('Stripe API Error:', stripeError);
    return res.status(500).json({ error: `Failed to create payment session: ${stripeError.message}` });
  }
});

// Basic Root Route
app.get('/', (req, res) => {
    res.send('Delivery Quote Backend Server (PostgreSQL Logging) is Running!');
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
