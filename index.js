const express = require('express');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config(); // Load .env variables

const app = express();
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

const SHOP_NAME = process.env.SHOPIFY_SHOP_NAME;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const getAllOrdersCsv = async (orderId) => {
  let orders = [];

  if (orderId) {
    // Fetch single order
    const url = `https://${SHOP_NAME}/admin/api/2025-04/orders/${orderId}.json`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch order ${orderId}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.order) {
      throw new Error(`Order ${orderId} not found`);
    }
    orders.push(data.order);

  } else {
    // Fetch multiple orders with pagination
    let nextPageUrl = `https://${SHOP_NAME}/admin/api/2025-04/orders.json?limit=250&status=any`;

    while (nextPageUrl) {
      const response = await fetch(nextPageUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch orders: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.orders && data.orders.length > 0) {
        orders = orders.concat(data.orders);
      }

      const linkHeader = response.headers.get('link');
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        nextPageUrl = match ? match[1] : null;
      } else {
        nextPageUrl = null;
      }
    }
  }

  // Your CSV generation code below remains unchanged...
  // (Use the orders array to generate CSV rows)

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

  orders.forEach(order => {
    order.line_items.forEach(item => {
      const row = [
        `"${order.name}"`,
        `"${order.email || ''}"`,
        `"${order.financial_status || ''}"`,
        `"${order.processed_at || ''}"`,
        `"${order.fulfillment_status || ''}"`,
        `"${item.fulfilled_at || ''}"`,
        `"${(item.properties && item.properties[0]?.name) || ''}"`,
        `"${(item.properties && item.properties[0]?.value) || ''}"`,
        `"${order.buyer_accepts_marketing}"`,
        `"${order.currency}"`,
        `"${order.subtotal_price}"`,
        `"${order.total_shipping_price_set?.shop_money?.amount || ''}"`,
        `"${order.total_tax}"`,
        `"${order.total_price}"`,
        `"${order.discount_codes?.[0]?.code || ''}"`,
        `"${order.discount_codes?.[0]?.amount || ''}"`,
        `"${order.shipping_lines?.[0]?.title || ''}"`,
        `"${order.created_at}"`,
        `"${item.quantity}"`,
        `"${item.name}"`,
        `"${item.price}"`,
        `"${item.compare_at_price || ''}"`,
        `"${item.sku || ''}"`,
        `"${item.requires_shipping}"`,
        `"${item.taxable}"`,
        `"${item.fulfillment_status || ''}"`,
        `"${order.billing_address?.name || ''}"`,
        `"${order.billing_address?.address1 || ''}"`,
        `"${order.billing_address?.address1 || ''}"`,
        `"${order.billing_address?.address2 || ''}"`,
        `"${order.billing_address?.company || ''}"`,
        `"${order.billing_address?.city || ''}"`,
        `"${order.billing_address?.zip || ''}"`,
        `"${order.billing_address?.province || ''}"`,
        `"${order.billing_address?.country || ''}"`,
        `"${order.billing_address?.phone || ''}"`,
        `"${order.shipping_address?.name || ''}"`,
        `"${order.shipping_address?.address1 || ''}"`,
        `"${order.shipping_address?.address1 || ''}"`,
        `"${order.shipping_address?.address2 || ''}"`,
        `"${order.shipping_address?.company || ''}"`,
        `"${order.shipping_address?.city || ''}"`,
        `"${order.shipping_address?.zip || ''}"`,
        `"${order.shipping_address?.province || ''}"`,
        `"${order.shipping_address?.country || ''}"`,
        `"${order.shipping_address?.phone || ''}"`,
        `"${order.note || ''}"`,
        `"${JSON.stringify(order.note_attributes)}"`,
        `"${order.cancelled_at || ''}"`,
        `"${order.payment_gateway_names?.[0] || ''}"`,
        `"${order.payment_details?.credit_card_number || ''}"`,
        `"${order.refunds?.[0]?.transactions?.[0]?.amount || ''}"`,
        `"${item.vendor || ''}"`,
        `"${order.outstanding_balance || ''}"`,
        `"${order.source_name || ''}"`,
        `"${order.location_id || ''}"`,
        `"${order.device_id || ''}"`,
        `"${order.id}"`,
        `"${order.tags}"`,
        `"${order.risk_level || ''}"`,
        `"${order.source_name || ''}"`,
        `"${item.total_discount || ''}"`,
        `"${item.tax_lines?.[0]?.title || ''}"`,
        `"${item.tax_lines?.[0]?.price || ''}"`,
        `"${item.tax_lines?.[1]?.title || ''}"`,
        `"${item.tax_lines?.[1]?.price || ''}"`,
        `"${item.tax_lines?.[2]?.title || ''}"`,
        `"${item.tax_lines?.[2]?.price || ''}"`,
        `"${item.tax_lines?.[3]?.title || ''}"`,
        `"${item.tax_lines?.[3]?.price || ''}"`,
        `"${item.tax_lines?.[4]?.title || ''}"`,
        `"${item.tax_lines?.[4]?.price || ''}"`,
        `"${order.phone || ''}"`,
        `"${order.receipt_number || ''}"`,
        `"${order.total_duties_set?.shop_money?.amount || ''}"`,
        `"${order.billing_address?.province || ''}"`,
        `"${order.shipping_address?.province || ''}"`,
        `"${order.payment_details?.credit_card_bin || ''}"`,
        `"${order.payment_terms?.name || ''}"`,
        `"${order.payment_terms?.next_payment_due_at || ''}"`,
        `"${JSON.stringify(order.payment_terms?.payment_schedules) || ''}"`
      ];

      csvRows.push(row.join(','));
    });
  });

  return csvRows.join('\n');
};

app.get('/export-orders', async (req, res) => {
  try {
    const { orderId } = req.query;

    const csvContent = await getAllOrdersCsv(orderId);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="shopify_orders.csv"');
    res.send(csvContent);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error generating CSV');
  }
});

function verifyHmac(query) {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const generatedHmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');
  return generatedHmac === hmac;
}

app.get('/auth/callback', async (req, res) => {
  const { shop, hmac, code, state } = req.query;

  if (!verifyHmac(req.query)) {
    return res.status(400).send('HMAC validation failed');
  }

  // Exchange code for access token
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    }),
  });

  const data = await response.json();
  const accessToken = data.access_token;

  // Save access token here if you want to make API calls later

  // Redirect to main app URL
  res.redirect(`https://${shop}/admin/apps/get-ledsy-app`);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/index.html'));
});

app.listen(3000, () => console.log('App listening on port 3000'));

