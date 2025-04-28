// server.js - Backend for Stripe Checkout & Combined Lead Logging

// Load environment variables from .env file
require('dotenv').config();

// Import required libraries
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Use SECRET key
const cors = require('cors'); // Import CORS middleware
const fs = require('fs'); // Node.js File System module
const path = require('path'); // Node.js Path module

// Create an Express application
const app = express();

// --- Middleware ---

// Enable CORS - Configure origins allowed to access this backend
app.use(cors({
  origin: process.env.YOUR_WEBSITE_URL || '*' // Restrict in production
}));

// Parse JSON bodies sent by the frontend
app.use(express.json());

// --- File Logging Configuration ---
const leadsDir = path.join(__dirname, 'leads'); // 'leads' folder in the same directory
const leadsFilePath = path.join(leadsDir, 'leads.csv');
// Define CSV header columns (ensure this matches the order data is written)
const csvHeader = "Timestamp,Contact Name,Contact Email,Contact Phone,Contact Company,All Stops Details,Package Details,Vehicle Type,Pickup Date,Pickup Time,Urgency,Inside Delivery,Hazardous,Bio-Hazardous,Extra Laborer,Total Miles,Calculated Quote\n";

// Function to ensure the leads directory and file exist
function ensureLeadsFileExists() {
  try {
    if (!fs.existsSync(leadsDir)) {
      fs.mkdirSync(leadsDir);
      console.log(`Created directory: ${leadsDir}`);
    }
    if (!fs.existsSync(leadsFilePath)) {
      fs.writeFileSync(leadsFilePath, csvHeader, 'utf8');
      console.log(`Created leads file with header: ${leadsFilePath}`);
    }
  } catch (err) {
    console.error("Error ensuring leads file/directory exists:", err);
  }
}

// Ensure file exists on server startup
ensureLeadsFileExists();

// --- API Endpoint for Creating Stripe Checkout Session AND Logging Lead ---
app.post('/create-checkout-session', async (req, res) => {
  console.log("Received request for Stripe session & lead logging:", req.body);

  // --- Extract data sent from the frontend ---
  const { calculatedQuote, contactDetails, stopsData, packagesData, serviceDetails, totalMiles } = req.body;

  // --- Basic Validation (Check essential data for both logging and payment) ---
  if (!calculatedQuote || isNaN(parseFloat(calculatedQuote)) ||
      !contactDetails || !contactDetails.email || !contactDetails.name || // Require name and email
      !stopsData || stopsData.length < 2 || // Require at least 2 stops
      !packagesData || packagesData.length < 1 || // Require at least 1 package
      !serviceDetails || !serviceDetails.vehicleType // Require vehicle type
      ) {
     console.error("Incomplete data received for session/logging:", req.body);
     return res.status(400).json({ error: 'Incomplete or invalid data received. Cannot proceed.' });
  }

  // --- ** STEP 1: Log Lead Data to CSV ** ---
  try {
    console.log("Attempting to log lead data...");
    const timestamp = new Date().toISOString();
    // Format data for CSV, ensuring quotes within fields are escaped
    const formatCSVField = (field) => `"${(field || '').toString().replace(/"/g, '""')}"`;

    const contactName = formatCSVField(contactDetails.name);
    const contactEmail = formatCSVField(contactDetails.email);
    const contactPhone = formatCSVField(contactDetails.phone);
    const contactCompany = formatCSVField(contactDetails.company);

    // Serialize Stops
    let allStopsString = '"No stop details provided"';
    if (stopsData && stopsData.length > 0) {
      const stopDetailsFormatted = stopsData.map(stop => {
        const address = (stop.address || 'N/A').replace(/\|/g, '/').replace(/;/g, ',');
        let loadUnload = stop.loadUnload || 'N/A';
        if (loadUnload === 'driver') loadUnload = 'Driver'; else if (loadUnload === 'customer') loadUnload = 'Customer'; else if (loadUnload === 'driver_assist') loadUnload = 'Driver Assist';
        let stairsInfoString = 'No'; if (stop.stairs) { stairsInfoString = `Yes, Fl: ${stop.floor || 'N/A'}`; }
        return `${address}|${loadUnload}|${stairsInfoString}`;
      });
      allStopsString = formatCSVField(stopDetailsFormatted.join(';'));
    }

    // Serialize Packages
    let packagesStr = '"No package details provided"';
    if (packagesData && packagesData.length > 0) {
      packagesStr = formatCSVField(packagesData.map(p => { const cleanDesc = (p.desc || 'N/A').replace(/\|/g, '/').replace(/;/g, ','); return `Qty:${p.qty || 'N/A'}, Desc:${cleanDesc}, Wt:${p.weight || 'N/A'}lbs, Dim:${p.length || 'N/A'}x${p.width || 'N/A'}x${p.height || 'N/A'} ${p.unit || 'N/A'}`; }).join('; '));
    }

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

    // Create the CSV row string (Ensure order matches csvHeader)
    const csvRow = [
      formatCSVField(timestamp),
      contactName, contactEmail, contactPhone, contactCompany,
      allStopsString, packagesStr,
      vehicleType, pickupDate, pickupTime, urgency,
      insideDelivery, hazardous, bioHazardous, extraLaborer,
      totalMilesFormatted, quoteFormatted
    ].join(',') + '\n';

    // Append data to CSV file asynchronously
    fs.appendFile(leadsFilePath, csvRow, 'utf8', (err) => {
      if (err) {
        // Log error but DON'T stop the Stripe process unless logging is absolutely critical
        console.error("Error appending data to leads file (Stripe process will continue):", err);
        // If logging MUST succeed, you could return an error response here:
        // return res.status(500).json({ error: "Failed to log lead data on server." });
      } else {
        console.log("Lead data successfully appended to", leadsFilePath);
      }
    });

  } catch (logError) {
    // Catch synchronous errors during data formatting for logging
    console.error("Error formatting lead data for logging (Stripe process will continue):", logError);
    // Decide if this error should stop the payment process
  }
  // --- ** End of Lead Logging Step ** ---


  // --- ** STEP 2: Create Stripe Checkout Session ** ---
  // (This part remains largely the same, using the validated data)
  const customerEmail = contactDetails.email; // Use validated email
  const orderSummary = `Delivery: ${stopsData.length} stops, ${packagesData.length} pkg types. Miles: ${totalMiles?.toFixed(1) || 'N/A'}`;

  // Calculate Amount in Cents (using the validated quote amount)
  const amountInCents = Math.round(parseFloat(calculatedQuote) * 100);

  // Check against Stripe minimum ($0.50)
  if (amountInCents < 50) {
       console.error("Amount below Stripe minimum:", amountInCents);
       // Send specific error back to frontend
       return res.status(400).json({ error: 'Quote amount is below the minimum charge ($0.50).' });
   }

  // Define Success/Cancel URLs
  const YOUR_DOMAIN = process.env.YOUR_WEBSITE_URL;
  if (!YOUR_DOMAIN) {
      console.error("YOUR_WEBSITE_URL not set in .env file.");
      return res.status(500).json({ error: 'Server configuration error (Website URL missing).' });
  }
  const successUrl = `${YOUR_DOMAIN}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${YOUR_DOMAIN}/payment-cancelled.html`;

  try {
    // Create a Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Delivery Service Quote',
              description: orderSummary,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
      // Optional: Tipping Configuration
      payment_intent_data: {
        tip: {
          amount_eligible: amountInCents,
          suggested_amounts: [ Math.round(amountInCents * 0.10), Math.round(amountInCents * 0.15), Math.round(amountInCents * 0.20) ],
          custom_amount: { enabled: true, minimum_amount: 100 },
        },
        metadata: { tip_intended_for: 'Driver', quote_amount_cents: amountInCents }
      },
    });

    console.log("Stripe Session Created:", session.id);
    // Send session URL back to frontend ONLY after potential logging attempt
    res.json({ url: session.url });

  } catch (stripeError) {
    // Handle errors during Stripe session creation
    console.error('Stripe API Error:', stripeError);
    res.status(500).json({ error: `Failed to create payment session: ${stripeError.message}` });
  }
});


// --- REMOVED /log-lead endpoint ---


// Basic Root Route (for testing if server is running)
app.get('/', (req, res) => {
    res.send('Delivery Quote Backend Server (Combined Stripe & Logging) is Running!');
});


// Start the server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
