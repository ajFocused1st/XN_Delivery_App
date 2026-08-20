const fs = require('fs');
const path = require('path');

const payloadPath = path.join(__dirname, 'payload-invalid.json');
if (!fs.existsSync(payloadPath)) {
  console.error(`Missing payload file: ${payloadPath}`);
  process.exit(1);
}

const payload = fs.readFileSync(payloadPath, 'utf8');

async function call(endpoint) {
  console.log(`\nPOST ${endpoint}`);
  try {
    const response = await fetch(`http://127.0.0.1:10000${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(text);
  } catch (err) {
    console.error('Request failed:', err);
  }
}

(async () => {
  await call('/log-calculated-quote');
  await call('/create-checkout-session');
})();
