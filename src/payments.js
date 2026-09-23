const Stripe = require('stripe');

const money = (c) => (c / 100).toFixed(2);

// ---------------- Stripe (cards; Stripe's page also offers Apple Pay / Google Pay where supported) ----------------
let stripe;
function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Card payments are not configured (STRIPE_SECRET_KEY).');
  return (stripe ??= Stripe(process.env.STRIPE_SECRET_KEY));
}

async function createStripeCheckout(order, publicUrl) {
  const line = (name, amount, quantity = 1) => ({
    quantity,
    price_data: { currency: 'usd', unit_amount: amount, product_data: { name } },
  });
  const lineItems = order.items.map((l) => line([l.name, l.size].filter(Boolean).join(' – '), l.unit, l.quantity));
  if (order.tax) lineItems.push(line('Tax', order.tax));
  if (order.delivery_fee) lineItems.push(line('Delivery fee', order.delivery_fee));
  if (order.card_fee) lineItems.push(line('Credit card fee', order.card_fee));

  const session = await stripeClient().checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    customer_email: order.customer.email || undefined,
    metadata: { orderId: order.orderId },
    payment_intent_data: { description: `C&E Pizza order ${order.orderId}`, metadata: { orderId: order.orderId } },
    success_url: `${publicUrl}/pay/stripe/return?order=${order.orderId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicUrl}/pay/cancel?order=${order.orderId}`,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
  });
  return { url: session.url, ref: session.id };
}

async function isStripeSessionPaid(sessionId) {
  const s = await stripeClient().checkout.sessions.retrieve(sessionId);
  return { paid: s.payment_status === 'paid', orderId: s.metadata?.orderId };
}

function verifyStripeWebhook(rawBody, signature) {
  return stripeClient().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// ---------------- PayPal (Orders v2 REST API) ----------------
const paypalBase = () =>
  process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function paypalToken() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
               'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal auth failed (${r.status})`);
  return (await r.json()).access_token;
}

async function createPayPalOrder(order, publicUrl) {
  const token = await paypalToken();
  const r = await fetch(`${paypalBase()}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
               'PayPal-Request-Id': `ce-${order.orderId}` },   // idempotent per order
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order.orderId,
        description: `C&E Pizza order ${order.orderId}`,
        amount: { currency_code: 'USD', value: money(order.total) },
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: 'C&E Pizza', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
        return_url: `${publicUrl}/pay/paypal/return?order=${order.orderId}`,
        cancel_url: `${publicUrl}/pay/cancel?order=${order.orderId}`,
      } } },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`PayPal order failed: ${data.message || r.status}`);
  const approve = data.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { url: approve.href, ref: data.id };
}

async function capturePayPalOrder(paypalOrderId, expectedTotalCents) {
  const token = await paypalToken();
  const r = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
               'PayPal-Request-Id': `capture-${paypalOrderId}` },
  });
  const data = await r.json();
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  const ok = (data.status === 'COMPLETED' || r.status === 422 && data.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED')
    && (!capture || capture.amount.value === money(expectedTotalCents));
  return ok;
}

module.exports = { createStripeCheckout, isStripeSessionPaid, verifyStripeWebhook, createPayPalOrder, capturePayPalOrder };
