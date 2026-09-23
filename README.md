# C&E Pizza — order server

Node 20 + Express + SQLite. Receives orders from the iOS app, re-prices them from `menu.json`,
takes payment (Stripe for cards, PayPal, Zelle handled manually), and shows live orders to staff at `/staff`.

## Run it on your Mac
```bash
npm install
cp .env.example .env        # fill in STAFF_PASSWORD at minimum
npm start                   # http://localhost:3000  ·  staff screen: http://localhost:3000/staff
```
Your iPhone can't reach `localhost`. To test with the phone, expose it with a tunnel:
`brew install cloudflared && cloudflared tunnel --url http://localhost:3000`, then put that https URL in
`PUBLIC_URL` (.env) and `ShopConfig.apiBaseURL` (+ `/api`).

## Deploy (Render — simplest)
1. Push this folder to a GitHub repo.
2. render.com → New → Web Service → pick the repo. Build: `npm install` · Start: `npm start`.
3. Instance type **Starter** (the free tier sleeps and has no disk — orders would be lost).
4. Add a **Disk** mounted at `/var/data`, and set `DB_PATH=/var/data/orders.db`.
5. Add the other environment variables from `.env.example`. `PUBLIC_URL` = your Render URL.
6. In the app: `ShopConfig.apiBaseURL = https://<your-app>.onrender.com/api`, `useDemoBackend = false`.

## Payment accounts (in the shop's name — money goes to them)
**Stripe (cards):** create an account → Developers → API keys → `STRIPE_SECRET_KEY`.
Developers → Webhooks → add endpoint `https://<server>/webhooks/stripe` with events
`checkout.session.completed` and `checkout.session.async_payment_succeeded` → copy its signing secret to `STRIPE_WEBHOOK_SECRET`.
Test with card `4242 4242 4242 4242`, any future date, any CVC. Switch to live keys when ready.

**PayPal:** PayPal Business account → developer.paypal.com → Apps & Credentials → create app →
`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. Test with a sandbox buyer account; set `PAYPAL_ENV=live` + live keys to go live.

**Zelle:** nothing to set up here — put the shop's Zelle email/phone in `ShopConfig.zelleRecipient`.
Staff tap **Zelle received ✓** on the order once the money shows in their bank app.

## Staff screen
Open `https://<server>/staff` on the counter tablet/computer (user `staff`, password `STAFF_PASSWORD`),
tap **Enable sound**, and keep the screen awake. Columns: New → Preparing → Ready → done.
Unpaid Zelle orders wait in their own column. Refunds are done in the Stripe / PayPal dashboards.

## How an order flows
1. App → `POST /api/orders`. Server validates items, sizes, toppings, required choices, delivery minimum, and computes the total itself.
2. Card → Stripe Checkout page · PayPal → PayPal approval page · Zelle → instructions in the app.
3. After paying, the browser returns to `cepizza://payment?status=success&orderId=CE-1001` and the app shows the confirmation.
4. Order is marked paid (Stripe webhook / PayPal capture) and pops up on the staff screen with a chime.
5. Unpaid card/PayPal orders auto-cancel after 45 minutes.

## Keeping the menu in sync
The server prices from its own `menu.json`. Whenever the app's menu changes, copy
`CEPizza/Resources/menu.json` here and redeploy — otherwise orders for changed items are rejected.

## API
| Method | Path | Notes |
|---|---|---|
| POST | `/api/orders` | body = app's `OrderRequest` → `{ orderId, status, checkoutURL }` · 400 with a readable message on bad orders |
| GET | `/api/orders/:orderId` | `{ orderId, status, total }` |
| POST | `/webhooks/stripe` | Stripe webhook |
| GET | `/pay/stripe/return`, `/pay/paypal/return`, `/pay/cancel` | payment redirects → back to the app |
| GET | `/staff`, `/api/staff/orders` · POST `/api/staff/orders/:id/status` | staff screen (basic auth) |
