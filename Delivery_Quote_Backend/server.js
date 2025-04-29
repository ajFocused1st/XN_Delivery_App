// server.js - Backend for Stripe Checkout & Combined Lead Logging

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors'); // Re-import CORS middleware
const fs = require('fs');
const path = require('path');

const app = express();

// --- Middleware ---

// ** USE SIMPLEST CORS MIDDLEWARE **
app.use(cors());
console.log("Applied simplest cors() middleware.");

// Parse JSON bodies sent by the frontend (AFTER CORS)
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
  console.log(`POST /create-checkout-session received at ${new Date().toISOString()}`);
  // console.log("Request Body:", req.body); // Log body if needed

  const { calculatedQuote, contactDetails, stopsData, packagesData, serviceDetails, totalMiles } = req.body;

  // Basic Validation
  if (!calculatedQuote || isNaN(parseFloat(calculatedQuote)) || !contactDetails || !contactDetails.email || !contactDetails.name || !stopsData || stopsData.length < 2 || !packagesData || packagesData.length < 1 || !serviceDetails || !serviceDetails.vehicleType) {
     console.error("Incomplete data received:", req.body);
     return res.status(400).json({ error: 'Incomplete or invalid data received.' });
  }

  // --- Log Lead Data ---
  try {
    // ... (CSV logging logic remains the same) ...
    console.log("Attempting to log lead data...");
    const timestamp = new Date().toISOString();
    const formatCSVField = (field) => `"${(field || '').toString().replace(/"/g, '""')}"`;
    const contactName = formatCSVField(contactDetails.name);
    const contactEmail = formatCSVField(contactDetails.email);
    const contactPhone = formatCSVField(contactDetails.phone);
    const contactCompany = formatCSVField(contactDetails.company);
    let allStopsString = '"No stop details provided"';
    if (stopsData && stopsData.length > 0) { allStopsString = formatCSVField(stopsData.map(stop => { const address = (stop.address || 'N/A').replace(/\|/g, '/').replace(/;/g, ','); let loadUnload = stop.loadUnload || 'N/A'; if (loadUnload === 'driver') loadUnload = 'Driver'; else if (loadUnload === 'customer') loadUnload = 'Customer'; else if (loadUnload === 'driver_assist') loadUnload = 'Driver Assist'; let stairsInfoString = 'No'; if (stop.stairs) { stairsInfoString = `Yes, Fl: ${stop.floor || 'N/A'}`; } return `${address}|${loadUnload}|${stairsInfoString}`; }).join(';')); }
    let packagesStr = '"No package details provided"';
    if (packagesData && packagesData.length > 0) { packagesStr = formatCSVField(packagesData.map(p => { const cleanDesc = (p.desc || 'N/A').replace(/\|/g, '/').replace(/;/g, ','); return `Qty:${p.qty || 'N/A'}, Desc:${cleanDesc}, Wt:${p.weight || 'N/A'}lbs, Dim:${p.length || 'N/A'}x${p.width || 'N/A'}x${p.height || 'N/A'} ${p.unit || 'N/A'}`; }).join('; ')); }
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

    fs.appendFile(leadsFilePath, csvRow, 'utf8', (err) => {
      if (err) { console.error("Error appending data to leads file (Stripe process will continue):", err); }
      else { console.log("Lead data successfully appended to", leadsFilePath); }
    });
  } catch (logError) { console.error("Error formatting lead data (Stripe process will continue):", logError); }

  // --- Create Stripe Session ---
  const customerEmail = contactDetails.email;
  const orderSummary = `Delivery Quote: ${stopsData.length} stops (${(totalMiles || 0).toFixed(1)} miles). Pickup: ${serviceDetails.pickupDate || 'N/A'} at ${serviceDetails.pickupTime || 'N/A'}. Vehicle: ${serviceDetails.vehicleType || 'N/A'}. First Stop: ${stopsData[0]?.address.substring(0, 50)}${stopsData[0]?.address.length > 50 ? '...' : ''}.`.substring(0, 200);

  const amountInCents = Math.round(parseFloat(calculatedQuote) * 100);
  if (amountInCents < 50) { return res.status(400).json({ error: 'Quote amount below minimum charge.' }); }

  // Use the YOUR_WEBSITE_URL environment variable for success and cancel redirects
  const YOUR_DOMAIN = process.env.YOUR_WEBSITE_URL;
  if (!YOUR_DOMAIN || YOUR_DOMAIN === 'http://temp.com') {
      console.error("CRITICAL: YOUR_WEBSITE_URL environment variable is not set correctly in Render for redirects!");
      // Consider returning an error if the domain is essential
      // return res.status(500).json({ error: 'Server configuration error (Website URL missing or incorrect).' });
  }

  // Define URLs - Success points to a success page, Cancel points back to the main frontend URL
  const successUrl = `${YOUR_DOMAIN || 'https://fallback-url.com'}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`; // Add fallback
  // ** MODIFIED cancelUrl **
  const cancelUrl = YOUR_DOMAIN || 'https://fallback-url.com'; // Point back to the main frontend URL

  console.log(`Stripe Success URL: ${successUrl}`);
  console.log(`Stripe Cancel URL: ${cancelUrl}`);


  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Xpedite Now Delivery Quote',
              description: orderSummary,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl, // Use the updated cancel URL
      customer_email: customerEmail || undefined,
      // Tipping configuration removed previously
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
    res.send('Delivery Quote Backend Server (Combined Stripe & Logging - Simple CORS) is Running!');
});

// Start the server
const PORT = process.env.PORT || 10000; // Render provides PORT env var
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
