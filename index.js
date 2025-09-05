const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Config ----------
const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  HOST,
  APP_HANDLE = 'your-app-handle',
} = process.env;

if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !HOST) {
  console.error('Missing required env vars: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, HOST');
  process.exit(1);
}

// Scopes needed for your app
const SCOPES = [
  'read_orders'
].join(',');

// ---------- Tiny JSON "DB" ----------
const DB_FILE = path.join(__dirname, 'shops.json');

// Shape:
// {
//   "example.myshopify.com": {
//     "accessToken": "shpat_...",
//     "installedAt": "2025-09-05T00:00:00.000Z",
//     "chargeId": 12345678,
//     "billingActive": true
//   }
// }

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}
function getShopRec(shop) {
  const db = loadDB();
  return db[shop] || null;
}
function setShopRec(shop, data) {
  const db = loadDB();
  db[shop] = { ...(db[shop] || {}), ...data };
  saveDB(db);
}

// ---------- Install (OAuth) Flow ----------

// Simple state store (per-process). For production, persist this.
const pendingStates = new Map();

function verifyHmacFromQuery(query) {
  const { hmac, signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');

  const generated = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(generated, 'utf-8'), Buffer.from(hmac, 'utf-8'));
}

// Step 1: Merchant clicks your install link:
//   https://YOUR-APP-DOMAIN/auth?shop=STORE.myshopify.com
app.get('/auth', (req, res) => {
  const shop = (req.query.shop || '').toString().trim();

  if (!shop || !shop.endsWith('.myshopify.com')) {
    return res.status(400).send('Missing or invalid ?shop= parameter (e.g., store.myshopify.com)');
  }

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { shop, createdAt: Date.now() });

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(
    SHOPIFY_API_KEY
  )}&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(
    `${HOST}/auth/callback`
  )}&state=${encodeURIComponent(state)}`;

  return res.redirect(installUrl);
});

// Step 2: OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { shop, hmac, code, state } = req.query;

  try {
    // Basic validations
    if (!shop || !code || !state) {
      return res.status(400).send('Missing required query parameters.');
    }
    if (!pendingStates.has(state)) {
      return res.status(400).send('Invalid or expired state parameter.');
    }
    // (optional) you can also check that pendingStates.get(state).shop === shop
    pendingStates.delete(state);

    // Verify HMAC
    if (!verifyHmacFromQuery(req.query)) {
      return res.status(400).send('HMAC validation failed.');
    }

    // Exchange code for access token
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Token exchange failed: ${tokenResp.status} ${text}`);
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error('No access_token returned.');

    // Save/Upsert shop record
    setShopRec(shop, { accessToken, installedAt: new Date().toISOString() });

    // Create a $1/mo Recurring Application Charge
    const createChargeResp = await fetch(
      `https://${shop}/admin/api/2025-04/recurring_application_charges.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recurring_application_charge: {
            name: 'Basic Plan',
            price: 1.0,
            // IMPORTANT: this is where Shopify will redirect after merchant clicks "Approve charge"
            return_url: `${HOST}/billing/confirm?shop=${encodeURIComponent(shop)}`,
            // trial_days: 0, // optional
            // test: true,   // set true for development; remove or set false in production
          },
        }),
      }
    );

    if (!createChargeResp.ok) {
      const text = await createChargeResp.text();
      throw new Error(`Create charge failed: ${createChargeResp.status} ${text}`);
    }

    const chargeData = await createChargeResp.json();
    const confirmationUrl = chargeData?.recurring_application_charge?.confirmation_url;
    if (!confirmationUrl) throw new Error('No confirmation_url for the charge.');

    // Redirect merchant to approve the charge
    return res.redirect(confirmationUrl);
  } catch (err) {
    console.error(err);
    return res.status(500).send('OAuth/Billing initiation error.');
  }
});

// Step 3: Billing confirmation
app.get('/billing/confirm', async (req, res) => {
  const shop = (req.query.shop || '').toString().trim();
  const chargeId = (req.query.charge_id || '').toString().trim();

  try {
    if (!shop || !shop.endsWith('.myshopify.com')) {
      return res.status(400).send('Missing or invalid shop.');
    }
    if (!chargeId) {
      // When Shopify redirects back, it includes charge_id. If absent, fetch latest or error out.
      return res.status(400).send('Missing charge_id.');
    }

    const rec = getShopRec(shop);
    if (!rec || !rec.accessToken) {
      return res.status(400).send('App not installed (no access token).');
    }

    // Verify the charge status
    const chargeResp = await fetch(
      `https://${shop}/admin/api/2025-04/recurring_application_charges/${encodeURIComponent(
        chargeId
      )}.json`,
      {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': rec.accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!chargeResp.ok) {
      const text = await chargeResp.text();
      throw new Error(`Charge lookup failed: ${chargeResp.status} ${text}`);
    }

    const chargeData = await chargeResp.json();
    const status = chargeData?.recurring_application_charges?.status ||
      chargeData?.recurring_application_charge?.status; // API can vary in shape

    if (status === 'active') {
      setShopRec(shop, {
        billingActive: true,
        chargeId: Number(chargeId),
      });

      // Redirect to your app inside Shopify admin (optional)
      return res.redirect(`https://${shop}/admin/apps/${APP_HANDLE}`);
    } else {
      return res.status(402).send(`Charge status is "${status}". Please approve the subscription.`);
    }
  } catch (err) {
    console.error(err);
    return res.status(500).send('Billing confirmation error.');
  }
});

// ---------- Helpers for per-shop API calls ----------
async function getAccessToken(shop) {
  const rec = getShopRec(shop);
  return rec?.accessToken || null;
}

async function ensureBillingActive(shop) {
  const rec = getShopRec(shop);
  return !!(rec && rec.billingActive === true);
}

// ---------- CSV Export (per shop) ----------
async function getAllOrdersCsv({ shop, accessToken, orderId }) {
  // Fetch orders for the specific shop with the provided token
  let orders = [];

  if (orderId) {
    // Single order
    const url = `https://${shop}/admin/api/2025-04/orders/${encodeURIComponent(orderId)}.json`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch order ${orderId}: ${response.status} ${text}`);
    }
    const data = await response.json();
    if (!data.order) {
      throw new Error(`Order ${orderId} not found`);
    }
    orders.push(data.order);
  } else {
    // All orders (paginated)
    let nextPageUrl = `https://${shop}/admin/api/2025-04/orders.json?limit=250&status=any`;
    while (nextPageUrl) {
      const response = await fetch(nextPageUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to fetch orders: ${response.status} ${text}`);
      }
      const data = await response.json();
      if (data.orders && data.orders.length > 0) {
        orders = orders.concat(data.orders);
      }

      const linkHeader = response.headers.get('link') || response.headers.get('Link');
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
        nextPageUrl = match ? match[1] : null;
      } else {
        nextPageUrl = null;
      }
    }
  }

  // CSV headers (same as your original)
  const headers = [
    'Name', 'Email', 'Financial Status', 'Paid at', 'Fulfillment Status', 'Fulfilled at',
    'Property Name', 'Property Value', 'Accepts Marketing', 'Currency', 'Subtotal', 'Shipping',
    'Taxes', 'Total', 'Discount Code', 'Discount Amount', 'Shipping Method', 'Created at',
    'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem compare at price',
    'Lineitem sku', 'Lineitem requires shipping', 'Lineitem taxable', 'Lineitem fulfillment status',
    'Billing Name', 'Billing Street', 'Billing Address1', 'Billing Address2', 'Billing Company',
    'Billing City', 'Billing Zip', 'Billing Province', 'Billing Country', 'Billing Phone',
    'Shipping Name', 'Shipping Street', 'Shipping Address1', 'Shipping Address2', 'Shipping Company',
    'Shipping City', 'Shipping Zip', 'Shipping Province', 'Shipping Country', 'Shipping Phone',
    'Notes', 'Note Attributes', 'Cancelled at', 'Payment Method', 'Payment Reference',
    'Refunded Amount', 'Vendor', 'Outstanding Balance', 'Employee', 'Location', 'Device ID', 'Id',
    'Tags', 'Risk Level', 'Source', 'Lineitem discount', 'Tax 1 Name', 'Tax 1 Value',
    'Tax 2 Name', 'Tax 2 Value', 'Tax 3 Name', 'Tax 3 Value', 'Tax 4 Name', 'Tax 4 Value',
    'Tax 5 Name', 'Tax 5 Value', 'Phone', 'Receipt Number', 'Duties', 'Billing Province Name',
    'Shipping Province Name', 'Payment ID', 'Payment Terms Name', 'Next Payment Due At',
    'Payment References'
  ];

  const csvRows = [headers.join(',')];

  const q = (v) => `"${(v ?? '').toString().replace(/"/g, '""')}"`;

  orders.forEach(order => {
    (order.line_items || []).forEach(item => {
      const row = [
        q(order.name),
        q(order.email || ''),
        q(order.financial_status || ''),
        q(order.processed_at || ''),
        q(order.fulfillment_status || ''),
        q(item.fulfilled_at || ''),
        q((item.properties && item.properties[0]?.name) || ''),
        q((item.properties && item.properties[0]?.value) || ''),
        q(order.buyer_accepts_marketing),
        q(order.currency),
        q(order.subtotal_price),
        q(order.total_shipping_price_set?.shop_money?.amount || ''),
        q(order.total_tax),
        q(order.total_price),
        q(order.discount_codes?.[0]?.code || ''),
        q(order.discount_codes?.[0]?.amount || ''),
        q(order.shipping_lines?.[0]?.title || ''),
        q(order.created_at),
        q(item.quantity),
        q(item.name),
        q(item.price),
        q(item.compare_at_price || ''),
        q(item.sku || ''),
        q(item.requires_shipping),
        q(item.taxable),
        q(item.fulfillment_status || ''),
        q(order.billing_address?.name || ''),
        q(order.billing_address?.address1 || ''),
        q(order.billing_address?.address1 || ''),
        q(order.billing_address?.address2 || ''),
        q(order.billing_address?.company || ''),
        q(order.billing_address?.city || ''),
        q(order.billing_address?.zip || ''),
        q(order.billing_address?.province || ''),
        q(order.billing_address?.country || ''),
        q(order.billing_address?.phone || ''),
        q(order.shipping_address?.name || ''),
        q(order.shipping_address?.address1 || ''),
        q(order.shipping_address?.address1 || ''),
        q(order.shipping_address?.address2 || ''),
        q(order.shipping_address?.company || ''),
        q(order.shipping_address?.city || ''),
        q(order.shipping_address?.zip || ''),
        q(order.shipping_address?.province || ''),
        q(order.shipping_address?.country || ''),
        q(order.shipping_address?.phone || ''),
        q(order.note || ''),
        q(JSON.stringify(order.note_attributes)),
        q(order.cancelled_at || ''),
        q(order.payment_gateway_names?.[0] || ''),
        q(order.payment_details?.credit_card_number || ''),
        q(order.refunds?.[0]?.transactions?.[0]?.amount || ''),
        q(item.vendor || ''),
        q(order.outstanding_balance || ''),
        q(order.source_name || ''),
        q(order.location_id || ''),
        q(order.device_id || ''),
        q(order.id),
        q(order.tags),
        q(order.risk_level || ''),
        q(order.source_name || ''),
        q(item.total_discount || ''),
        q(item.tax_lines?.[0]?.title || ''),
        q(item.tax_lines?.[0]?.price || ''),
        q(item.tax_lines?.[1]?.title || ''),
        q(item.tax_lines?.[1]?.price || ''),
        q(item.tax_lines?.[2]?.title || ''),
        q(item.tax_lines?.[2]?.price || ''),
        q(item.tax_lines?.[3]?.title || ''),
        q(item.tax_lines?.[3]?.price || ''),
        q(item.tax_lines?.[4]?.title || ''),
        q(item.tax_lines?.[4]?.price || ''),
        q(order.phone || ''),
        q(order.receipt_number || ''),
        q(order.total_duties_set?.shop_money?.amount || ''),
        q(order.billing_address?.province || ''),
        q(order.shipping_address?.province || ''),
        q(order.payment_details?.credit_card_bin || ''),
        q(order.payment_terms?.name || ''),
        q(order.payment_terms?.next_payment_due_at || ''),
        q(JSON.stringify(order.payment_terms?.payment_schedules) || '')
      ];
      csvRows.push(row.join(','));
    });
  });

  return csvRows.join('\n');
}

// Protect routes: ensure app installed + billing active
async function requireInstalledAndBilled(req, res, next) {
  const shop = (req.query.shop || '').toString().trim();
  if (!shop || !shop.endsWith('.myshopify.com')) {
    return res.status(400).send('Missing or invalid ?shop= parameter.');
  }
  const token = await getAccessToken(shop);
  if (!token) {
    return res.status(401).send('App not installed for this shop. Install via /auth?shop=STORE.myshopify.com');
  }
  const billed = await ensureBillingActive(shop);
  if (!billed) {
    return res.status(402).send('Billing inactive. Please approve the $1/month charge via /auth?shop=STORE.myshopify.com');
  }
  req.shop = shop;
  req.accessToken = token;
  next();
}

// Export orders endpoint (per-shop)
app.get('/export-orders', requireInstalledAndBilled, async (req, res) => {
  try {
    const { orderId } = req.query;
    const csvContent = await getAllOrdersCsv({
      shop: req.shop,
      accessToken: req.accessToken,
      orderId,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="shopify_orders.csv"');
    return res.send(csvContent);
  } catch (error) {
    console.error(error);
    return res.status(500).send('Error generating CSV');
  }
});

// ---------- Basic UI / Static ----------
app.get('/', (req, res) => {
  res.type('html').send(`
    <html>
      <head><title>Orders CSV Exporter</title></head>
      <body style="font-family: sans-serif; max-width: 640px; margin: 40px auto;">
        <h1>Orders CSV Exporter</h1>
        <p>Install the app on a store:</p>
        <form action="/auth" method="GET" style="margin-bottom:20px">
          <input type="text" name="shop" placeholder="store.myshopify.com" style="padding:8px;width:100%" />
          <button type="submit" style="margin-top:10px;padding:8px 12px;">Install</button>
        </form>
        <hr/>
        <p>Export CSV (after install & billing):</p>
        <form action="/export-orders" method="GET">
          <input type="text" name="shop" placeholder="store.myshopify.com" style="padding:8px;width:100%" />
          <input type="text" name="orderId" placeholder="Optional: order ID" style="padding:8px;width:100%; margin-top:10px;" />
          <button type="submit" style="margin-top:10px;padding:8px 12px;">Download CSV</button>
        </form>
      </body>
    </html>
  `);
});

// (Optional) serve your own frontend if you have one
// app.get('/app', (req, res) => {
//   res.sendFile(path.join(__dirname, 'frontend/index.html'));
// });

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`App listening on ${PORT}`);
  console.log(`Visit ${HOST} to start.`);
});
