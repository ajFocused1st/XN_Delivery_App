// server.js - Backend for Stripe Checkout & Lead Logging

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// --- Middleware ---
app.use(cors()); // Simplest CORS for now
console.log("Applied simplest cors() middleware.");
app.use(express.json());

// --- File Logging Configuration ---
const leadsDir = path.join(__dirname, 'leads');
const leadsFilePath = path.join(leadsDir, 'leads.csv');
const csvHeader = "Timestamp,LogType,Contact Name,Contact Email,Contact Phone,Contact Company,All Stops Details,Package Details,Vehicle Type,Pickup Date,Pickup Time,Urgency,Inside Delivery,Hazardous,Bio-Hazardous,Extra Laborer,Total Miles,Calculated Quote\n";

function ensureLeadsFileExists() {
  try {
    if (!fs.existsSync(leadsDir)) { fs.mkdirSync(leadsDir); console.log(`Created directory: ${leadsDir}`); }
    if (!fs.existsSync(leadsFilePath)) {
      fs.writeFileSync(leadsFilePath, csvHeader, 'utf8');
      console.log(`Created leads file with header: ${leadsFilePath}`);
    }
  } catch (err) { console.error("Error ensuring leads file/directory exists:", err); }
}
ensureLeadsFileExists();

// --- Helper function to log data to CSV ---
function logLeadDataToCSV(leadData, logType = "CalculatedQuote") {
  return new Promise((resolve, reject) => {
    try {
      console.log(`Attempting to log lead data (Type: ${logType})...`);
      const timestamp = new Date().toISOString();
      const formatCSVField = (field) => `"${(field || '').toString().replace(/"/g, '""')}"`;

      const contactName = formatCSVField(leadData.contactDetails?.name);
      const contactEmail = formatCSVField(leadData.contactDetails?.email);
      const contactPhone = formatCSVField(leadData.contactDetails?.phone);
      const contactCompany = formatCSVField(leadData.contactDetails?.company);

      let allStopsString = '"No stop details provided"';
      if (leadData.stopsData && leadData.stopsData.length > 0) {
        allStopsString = formatCSVField(leadData.stopsData.map(stop => {
          const address = (stop.address || 'N/A').replace(/\|/g, '/').replace(/;/g, ',');
          let loadUnload = stop.loadUnload || 'N/A';
          if (loadUnload === 'driver') loadUnload = 'Driver'; else if (loadUnload === 'customer') loadUnload = 'Customer'; else if (loadUnload === 'driver_assist') loadUnload = 'Driver Assist';
          let stairsInfoString = 'No'; if (stop.stairs) { stairsInfoString = `Yes, Fl: ${stop.floor || 'N/A'}`; }
          return `${address}|${loadUnload}|${stairsInfoString}`;
        }).join(';'));
      }

      let packagesStr = '"No package details provided"';
      if (leadData.packagesData && leadData.packagesData.length > 0) {
        packagesStr = formatCSVField(leadData.packagesData.map(p => {
          const cleanDesc = (p.desc || 'N/A').replace(/\|/g, '/').replace(/;/g, ',');
          return `Qty:${p.qty || 'N/A'}, Desc:${cleanDesc}, Wt:${p.weight || 'N/A'}lbs, Dim:${p.length || 'N/A'}x${p.width || 'N/A'}x${p.height || 'N/A'} ${p.unit || 'N/A'}`;
        }).join('; '));
      }

      const vehicleType = formatCSVField(leadData.serviceDetails?.vehicleType);
      const pickupDate = formatCSVField(leadData.serviceDetails?.pickupDate);
      const pickupTime = formatCSVField(leadData.serviceDetails?.pickupTime);
      const urgency = formatCSVField(leadData.serviceDetails?.urgency);
      const insideDelivery = leadData.serviceDetails?.insideDelivery ? '"Yes"' : '"No"';
      const hazardous = leadData.serviceDetails?.hazardous ? '"Yes"' : '"No"';
      const bioHazardous = leadData.serviceDetails?.bioHazardous ? '"Yes"' : '"No"';
      const extraLaborer = leadData.serviceDetails?.extraLaborer ? '"Yes"' : '"No"';
      const totalMilesFormatted = formatCSVField(leadData.totalMiles !== undefined && leadData.totalMiles !== null ? parseFloat(leadData.totalMiles).toFixed(1) : '');
      const quoteFormatted = formatCSVField(`$${leadData.calculatedQuote !== undefined && leadData.calculatedQuote !== null ? parseFloat(leadData.calculatedQuote).toFixed(2) : ''}`);
      
      const csvRow = [
        formatCSVField(timestamp), formatCSVField(logType),
        contactName, contactEmail, contactPhone, contactCompany,
        allStopsString, packagesStr,
        vehicleType, pickupDate, pickupTime, urgency,
        insideDelivery, hazardous, bioHazardous, extraLaborer,
        totalMilesFormatted, quoteFormatted
      ].join(',') + '\n';

      fs.appendFile(leadsFilePath, csvRow, 'utf8', (err) => {
        if (err) {
          console.error(`Error appending data to leads file (Type: ${logType}):`, err);
          reject(err);
        } else {
          console.log(`Lead data (Type: ${logType}) successfully appended to ${leadsFilePath}`);
          resolve();
        }
      });
    } catch (logError) {
      console.error(`Error formatting lead data for logging (Type: ${logType}):`, logError);
      reject(logError);
    }
  });
}

// --- NEW API Endpoint for Logging Calculated Quotes ---
app.post('/log-calculated-quote', async (req, res) => {
  console.log(`POST /log-calculated-quote received at ${new Date().toISOString()}`);
  const leadData = req.body;

  if (!leadData || !leadData.contactDetails || !leadData.calculatedQuote) {
    console.warn("Incomplete data for /log-calculated-quote:", leadData);
    return res.status(400).json({ status: "error", message: "Incomplete lead data received." });
  }

  try {
    await logLeadDataToCSV(leadData, "CalculatedQuote");
    res.status(200).json({ status: "success", message: "Quote data logged." });
  } catch (error) {
    res.status(500).json({ status: "error", message: "Failed to log quote data on server." });
  }
});

// --- API Endpoint for Creating Stripe Checkout Session AND Logging Lead (if not already logged) ---
app.post('/create-checkout-session', async (req, res) => {
  console.log(`POST /create-checkout-session received at ${new Date().toISOString()}`);
  const leadData = req.body; // { calculatedQuote, contactDetails, stopsData, packagesData, serviceDetails, totalMiles }

  // Basic Validation (copied from original, can be enhanced)
  if (!leadData.calculatedQuote || isNaN(parseFloat(leadData.calculatedQuote)) || !leadData.contactDetails || !leadData.contactDetails.email || !leadData.contactDetails.name || !leadData.stopsData || leadData.stopsData.length < 2 || !leadData.packagesData || leadData.packagesData.length < 1 || !leadData.serviceDetails || !leadData.serviceDetails.vehicleType) {
     console.error("Incomplete data received for session/logging:", leadData);
     return res.status(400).json({ error: 'Incomplete or invalid data received.' });
  }

  // Log data when proceeding to payment (might be redundant if already logged by /log-calculated-quote, but good as fallback)
  try {
    // Using "CheckoutAttempt" as logType to differentiate if needed
    await logLeadDataToCSV(leadData, "CheckoutAttempt");
  } catch (logError) {
    console.error("Error logging lead data during checkout attempt (Stripe process will continue):", logError);
    // Decide if this error should stop the payment process. For now, we continue.
  }

  // --- Create Stripe Session ---
  const customerEmail = leadData.contactDetails.email;
  const orderSummary = `Delivery Quote: ${leadData.stopsData.length} stops (${(parseFloat(leadData.totalMiles) || 0).toFixed(1)} miles). Pickup: ${leadData.serviceDetails.pickupDate || 'N/A'} at ${leadData.serviceDetails.pickupTime || 'N/A'}. Vehicle: ${leadData.serviceDetails.vehicleType || 'N/A'}. First Stop: ${leadData.stopsData[0]?.address.substring(0, 50)}${leadData.stopsData[0]?.address.length > 50 ? '...' : ''}.`.substring(0, 200);
  const amountInCents = Math.round(parseFloat(leadData.calculatedQuote) * 100);

  if (amountInCents < 50) { return res.status(400).json({ error: 'Quote amount below minimum charge.' }); }

  const YOUR_DOMAIN = process.env.YOUR_WEBSITE_URL;
  if (!YOUR_DOMAIN || YOUR_DOMAIN === 'http://temp.com') { // Check for default placeholder
      console.error("CRITICAL: YOUR_WEBSITE_URL environment variable is not set correctly in Render for redirects!");
      // Provide a default fallback to avoid breaking Stripe, but log the issue
  }
  const successUrl = `${YOUR_DOMAIN || 'https://your-default-success-url.com'}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = YOUR_DOMAIN || 'https://your-default-cancel-url.com';


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
    res.send('Delivery Quote Backend Server (Combined Stripe & Logging - Simple CORS) is Running!');
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
