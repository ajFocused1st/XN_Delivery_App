// server.js - Backend for Stripe Checkout & Combined Lead Logging

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors'); // Import CORS middleware
const fs = require('fs');
const path = require('path');

const app = express();

// --- Middleware ---

// ** MODIFIED CORS Configuration - More Explicit **
const corsOptions = {
  // For production, replace '*' with your specific frontend origin:
  // origin: process.env.YOUR_WEBSITE_URL,
  origin: '*', // Allow all origins for testing
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS", // Explicitly allow methods
  allowedHeaders: "Content-Type, Authorization, X-Requested-With", // Explicitly allow common headers
  credentials: true, // Allow cookies if needed later (usually not for simple POST)
  optionsSuccessStatus: 204 // Return 204 No Content for successful preflight OPTIONS requests
};
app.use(cors(corsOptions));
// Ensure Express handles OPTIONS requests globally *before* other routes
// This might be redundant with the cors middleware handling it, but can sometimes help.
app.options('*', cors(corsOptions)); // Handle preflight requests for all routes

// Parse JSON bodies sent by the frontend
app.use(express.json());

// --- File Logging Configuration ---
const leadsDir = path.join(__dirname, 'leads');
const leadsFilePath = path.join(leadsDir, 'leads.csv');
const csvHeader = "Timestamp,Contact Name,Contact Email,Contact Phone,Contact Company,All Stops Details,Package Details,Vehicle Type,Pickup Date,Pickup Time,Urgency,Inside Delivery,Hazardous,Bio-Hazardous,Extra Laborer,Total Miles,Calculated Quote\n";

function ensureLeadsFileExists() {
  try {
    if (!fs.existsSync(leadsDir)) { fs.mkdirSync(leadsDir); console.log(`Created directory: ${leadsDir}`); }
    if (!fs.existsSync(leadsFilePath)) { fs.writeFileSync(leadsFilePath, csvHeader, 'utf8'); console.log(`Created leads file with header: ${leadsFilePath}`); }
  } catch (err) { console.error("Error ensuring leads file/directory exists:", err); }
}
ensureLeadsFileExists();

// --- API Endpoint for Creating Stripe Checkout Session AND Logging Lead ---
app.post('/create-checkout-session', async (req, res) => {
  // Add a log right at the beginning to see if POST request hits
  console.log(`POST /create-checkout-session received at ${new Date().toISOString()}`);
  console.log("Request Body:", req.body); // Log the received body

  const { calculatedQuote, contactDetails, stopsData, packagesData, serviceDetails, totalMiles } = req.body;

  // Basic Validation
  if (!calculatedQuote || isNaN(parseFloat(calculatedQuote)) || !contactDetails || !contactDetails.email || !contactDetails.name || !stopsData || stopsData.length < 2 || !packagesData || packagesData.length < 1 || !serviceDetails || !serviceDetails.vehicleType) {
     console.error("Incomplete data received:", req.body);
     return res.status(400).json({ error: 'Incomplete or invalid data received.' });
  }

  // --- Log Lead Data ---
  try {
    console.log("Attempting to log lead data...");
    const timestamp = new Date().toISOString();
    const formatCSVField = (field) => `"${(field || '').toString().replace(/"/g, '""')}"`;
    const contactName = formatCSVField(contactDetails.name);
    const contactEmail = formatCSVField(contactDetails.email);
    const contactPhone = formatCSVField(contactDetails.phone);
    const contactCompany = formatCSVField(contactDetails.company);
    let allStopsString = '"No stop details provided"';
    if (stopsData && stopsData.length > 0) { /* ... serialization ... */ allStopsString = formatCSVField(stopsData.map(stop => { const address = (stop.address || 'N/A').replace(/\|/g, '/').replace(/;/g, ','); let loadUnload = stop.loadUnload || 'N/A'; if (loadUnload === 'driver') loadUnload = 'Driver'; else if (loadUnload === 'customer') loadUnload = 'Customer'; else if (loadUnload === 'driver_assist') loadUnload = 'Driver Assist'; let stairsInfoString = 'No'; if (stop.stairs) { stairsInfoString = `Yes, Fl: ${stop.floor || 'N/A'}`; } return `${address}|${loadUnload}|${stairsInfoString}`; }).join(';')); }
    let packagesStr = '"No package details provided"';
    if (packagesData && packagesData.length > 0) { /* ... serialization ... */ packagesStr = formatCSVField(packagesData.map(p => { const cleanDesc = (p.desc || 'N/A').replace(/\|/g, '/').replace(/;/g, ','); return `Qty:${p.qty || 'N/A'}, Desc:${cleanDesc}, Wt:${p.weight || 'N/A'}lbs, Dim:${p.length || 'N/A'}x${p.width || 'N/A'}x${p.height || 'N/A'} ${p.unit || 'N/A'}`; }).join('; ')); }
    const vehicleType = formatCSVField(serviceDetails.vehicleType);
    const pickupDate = formatCSVField(serviceDetails.pickupDate);
    const pickupTime = formatCSVField(serviceDetails.pickupTime);
    const urgency = formatCSVField(serviceDetails.urgency);
    const insideDelivery = serviceDetails.insideDelivery ? '"Yes"' : '"No"';
    const hazardous = serviceDetails.hazardous ? '"Yes"' : '"No"';
    const bioHazardous = serviceDetails.bioHazardous ? '"Yes"' : '"No"';
    const extraLaborer = serviceDetails.extraLaborer ? '"Yes"' : '"No"';
    const totalMilesFormatted = formatCSVField(totalMiles !== undefined && totalMiles !== null ? totalMiles.toFixed(1) : '');
    const quoteFormatted = formatCSVField(`$${calculatedQuote !== undefined && calculatedQuote !== null ? parseFloat(calculatedQuote).toFixed(2) : ''}`);
    const csvRow = [ formatCSVField(timestamp), contactName, contactEmail, contactPhone, contactCompany, allStopsString, packagesStr, vehicleType, pickupDate, pickupTime, urgency, insideDelivery, hazardous, bioHazardous, extraLaborer, totalMilesFormatted, quoteFormatted ].join(',') + '\n';

    // Use asynchronous appendFile
    fs.appendFile(leadsFilePath, csvRow, 'utf8', (err) => {
      if (err) { console.error("Error appending data to leads file (Stripe process will continue):", err); }
      else { console.log("Lead data successfully appended to", leadsFilePath); }
    });
  } catch (logError) { console.error("Error formatting lead data (Stripe process will continue):", logError); }

  // --- Create Stripe Session ---
  const customerEmail = contactDetails.email;
  const orderSummary = `Delivery: ${stopsData.length} stops, ${packagesData.length} pkg types. Miles: ${totalMiles?.toFixed(1) || 'N/A'}`;
  const amountInCents = Math.round(parseFloat(calculatedQuote) * 100);
  if (amountInCents < 50) { return res.status(400).json({ error: 'Quote amount below minimum charge.' }); }
  const YOUR_DOMAIN = process.env.YOUR_WEBSITE_URL;
  if (!YOUR_DOMAIN) { return res.status(500).json({ error: 'Server config error (Website URL missing).' }); }
  const successUrl = `${YOUR_DOMAIN}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${YOUR_DOMAIN}/payment-cancelled.html`;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [ { price_data: { currency: 'usd', product_data: { name: 'Delivery Service Quote', description: orderSummary, }, unit_amount: amountInCents, }, quantity: 1, }, ],
      mode: 'payment',
      success_url: successUrl, cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
      payment_intent_data: { tip: { amount_eligible: amountInCents, suggested_amounts: [ Math.round(amountInCents * 0.10), Math.round(amountInCents * 0.15), Math.round(amountInCents * 0.20) ], custom_amount: { enabled: true, minimum_amount: 100 }, }, metadata: { tip_intended_for: 'Driver', quote_amount_cents: amountInCents } },
    });
    console.log("Stripe Session Created:", session.id);
    res.json({ url: session.url }); // Send session URL back
  } catch (stripeError) {
    console.error('Stripe API Error:', stripeError);
    res.status(500).json({ error: `Failed to create payment session: ${stripeError.message}` });
  }
});

// Basic Root Route
app.get('/', (req, res) => {
    res.send('Delivery Quote Backend Server (Combined Stripe & Logging - Explicit CORS) is Running!');
});

// Start the server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
