// server.js - Backend for Stripe Checkout & PostgreSQL Lead Logging

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQL client for Node.js

const app = express();

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

  // Basic validation for essential data
  if (!leadData || !leadData.contactDetails || !leadData.calculatedQuote) {
    console.warn("Incomplete data for /log-calculated-quote:", leadData);
    return res.status(400).json({ status: "error", message: "Incomplete lead data received." });
  }

  try {
    await logLeadDataToDB(leadData, "CalculatedQuote");
    res.status(200).json({ status: "success", message: "Quote data logged to DB." });
  } catch (error) {
    // The error is already logged in logLeadDataToDB
    res.status(500).json({ status: "error", message: "Failed to log quote data to DB on server." });
  }
});

// --- API Endpoint for Creating Stripe Checkout Session AND Logging Lead ---
app.post('/create-checkout-session', async (req, res) => {
  console.log(`POST /create-checkout-session received at ${new Date().toISOString()}`);
  const leadData = req.body; 

  // Basic Validation
  if (!leadData.calculatedQuote || isNaN(parseFloat(leadData.calculatedQuote)) || !leadData.contactDetails || !leadData.contactDetails.email || !leadData.contactDetails.name || !leadData.stopsData || leadData.stopsData.length < 2 || !leadData.packagesData || leadData.packagesData.length < 1 || !leadData.serviceDetails || !leadData.serviceDetails.vehicleType) {
     console.error("Incomplete data received for session/logging:", leadData);
     return res.status(400).json({ error: 'Incomplete or invalid data received.' });
  }

  // Log data when proceeding to payment
  try {
    await logLeadDataToDB(leadData, "CheckoutAttempt");
  } catch (logError) {
    console.error("Error logging lead data to DB during checkout attempt (Stripe process will continue):", logError);
    // Depending on business logic, you might choose to halt payment if logging fails.
    // For now, we allow Stripe process to continue.
  }

  // --- Create Stripe Session ---
  const customerEmail = leadData.contactDetails.email;
  const orderSummary = `Delivery Quote: ${leadData.stopsData.length} stops (${(parseFloat(leadData.totalMiles) || 0).toFixed(1)} miles). Pickup: ${leadData.serviceDetails.pickupDate || 'N/A'} at ${leadData.serviceDetails.pickupTime || 'N/A'}. Vehicle: ${leadData.serviceDetails.vehicleType || 'N/A'}. First Stop: ${leadData.stopsData[0]?.address.substring(0, 50)}${leadData.stopsData[0]?.address.length > 50 ? '...' : ''}.`.substring(0, 200);
  const amountInCents = Math.round(parseFloat(leadData.calculatedQuote) * 100);

  if (amountInCents < 50) { return res.status(400).json({ error: 'Quote amount below minimum charge.' }); }

  const YOUR_DOMAIN = process.env.YOUR_WEBSITE_URL;
  if (!YOUR_DOMAIN || YOUR_DOMAIN === 'http://temp.com') { // Check for default placeholder
      console.error("CRITICAL: YOUR_WEBSITE_URL environment variable is not set correctly in Render for redirects!");
  }
  const successUrl = `${YOUR_DOMAIN || 'https://your-default-success-url.com'}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = YOUR_DOMAIN || 'https://your-default-cancel-url.com'; // Point back to main frontend URL

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [ { price_data: { currency: 'usd', product_data: { name: 'Xpedite Now Delivery Quote', description: orderSummary, }, unit_amount: amountInCents, }, quantity: 1, }, ],
      mode: 'payment',
      success_url: successUrl, cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
    });
    console.log("Stripe Session Created:", session.id);
    res.json({ url: session.url });
  } catch (stripeError) {
    console.error('Stripe API Error:', stripeError);
    res.status(500).json({ error: `Failed to create payment session: ${stripeError.message}` });
  }
});

// Basic Root Route
app.get('/', (req, res) => {
    res.send('Delivery Quote Backend Server (PostgreSQL Logging) is Running!');
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
