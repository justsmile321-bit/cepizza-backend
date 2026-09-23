require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { priceOrder, OrderError } = require('./pricing');
const pay = require('./payments');

const app = express();
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const SCHEME = process.env.APP_SCHEME || 'cepizza';
const backToApp = (res, status, orderId) =>
  res.redirect(`${SCHEME}://payment?status=${status}&orderId=${encodeURIComponent(orderId || '')}`);

app.set('trust proxy', 1);

// ---- Stripe webhook needs the raw body, so it's registered before express.json() ----
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try { event = pay.verifyStripeWebhook(req.body, req.headers['stripe-signature']); }
  catch (e) { return res.status(400).send(`Webhook error: ${e.message}`); }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    if (s.payment_status === 'paid') db.markPaid(db.parseId(s.metadata?.orderId));
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '200kb' }));

// ---------------- Customer API (used by the iOS app) ----------------
app.post('/api/orders', async (req, res) => {
  let id;
  try {
    const priced = priceOrder(req.body);
    if (priced.payment_method === 'apple_pay')
      throw new OrderError('Apple Pay is coming soon — please choose card, PayPal or Zelle.');

    const status = priced.payment_method === 'zelle' ? 'awaiting_zelle' : 'pending_payment';
    id = db.insert({ ...priced, status });
    const order = { ...priced, orderId: db.displayId(id) };

    let checkoutURL = null;
    if (priced.payment_method === 'card') {
      const s = await pay.createStripeCheckout(order, PUBLIC_URL);
      db.setRef(id, s.ref); checkoutURL = s.url;
    } else if (priced.payment_method === 'paypal') {
      const p = await pay.createPayPalOrder(order, PUBLIC_URL);
      db.setRef(id, p.ref); checkoutURL = p.url;
    }
    res.status(201).json({ orderId: order.orderId, status, checkoutURL, total: priced.total / 100 });
  } catch (e) {
    if (e instanceof OrderError) return res.status(400).type('text').send(e.message);
    console.error('create order failed', e);
    if (id) db.setStatus(id, 'cancelled');   // don't leave a half-created order behind
    res.status(500).type('text').send('We could not place your order. Please call us.');
  }
});

app.get('/api/orders/:orderId', (req, res) => {
  const o = db.get(db.parseId(req.params.orderId));
  if (!o) return res.sendStatus(404);
  res.json({ orderId: o.orderId, status: o.status, total: o.total / 100 });
});

// ---------------- Payment redirects (browser → back to the app) ----------------
app.get('/pay/stripe/return', async (req, res) => {
  const { order, session_id } = req.query;
  try {
    const { paid, orderId } = await pay.isStripeSessionPaid(session_id);
    if (paid && orderId === order) { db.markPaid(db.parseId(order)); return backToApp(res, 'success', order); }
    backToApp(res, 'pending', order);
  } catch (e) { console.error(e); backToApp(res, 'error', order); }
});

app.get('/pay/paypal/return', async (req, res) => {
  const { order: orderId, token } = req.query;
  const o = db.get(db.parseId(orderId));
  if (!o || o.provider_ref !== token) return backToApp(res, 'error', orderId);
  try {
    if (await pay.capturePayPalOrder(token, o.total)) { db.markPaid(o.id); return backToApp(res, 'success', orderId); }
    backToApp(res, 'error', orderId);
  } catch (e) { console.error(e); backToApp(res, 'error', orderId); }
});

app.get('/pay/cancel', (req, res) => {
  const o = db.get(db.parseId(req.query.order));
  if (o && o.status === 'pending_payment') db.setStatus(o.id, 'cancelled');
  backToApp(res, 'cancelled', req.query.order);
});

// ---------------- Staff screen (password protected) ----------------
function staffAuth(req, res, next) {
  const expected = process.env.STAFF_PASSWORD;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  const [user, pass] = Buffer.from(encoded || '', 'base64').toString().split(':');
  const ok = expected && scheme === 'Basic' && user === 'staff' && pass &&
    pass.length === expected.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(expected));
  if (ok) return next();
  res.set('WWW-Authenticate', 'Basic realm="C&E Pizza Staff"').sendStatus(401);
}

app.get('/staff', staffAuth, (_, res) => res.sendFile(path.join(__dirname, '../public/staff.html')));
app.get('/api/staff/orders', staffAuth, (_, res) => res.json(db.staffList()));
app.post('/api/staff/orders/:id/status', staffAuth, (req, res) => {
  const allowed = { awaiting_zelle: ['new', 'cancelled'], new: ['preparing', 'cancelled'],
                    preparing: ['ready', 'cancelled'], ready: ['completed'] };
  const o = db.get(Number(req.params.id));
  if (!o) return res.sendStatus(404);
  if (!(allowed[o.status] || []).includes(req.body.status)) return res.status(409).send('Invalid status change');
  db.setStatus(o.id, req.body.status);
  res.json({ ok: true });
});

app.get('/', (_, res) => res.type('text').send('C&E Pizza order server is running.'));

setInterval(() => db.expireStale(), 5 * 60 * 1000);
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`C&E Pizza backend on :${port} (public URL ${PUBLIC_URL})`));
