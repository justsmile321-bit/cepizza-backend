const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const file = process.env.DB_PATH || './data/orders.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status        TEXT NOT NULL,          -- pending_payment | awaiting_zelle | new | preparing | ready | completed | cancelled
  payment_method TEXT NOT NULL,
  fulfillment   TEXT NOT NULL,
  customer      TEXT NOT NULL,          -- JSON
  items         TEXT NOT NULL,          -- JSON (server-priced)
  notes         TEXT,
  subtotal      INTEGER NOT NULL,       -- all money in cents
  tax           INTEGER NOT NULL,
  delivery_fee  INTEGER NOT NULL,
  card_fee      INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  provider_ref  TEXT                    -- Stripe session id / PayPal order id
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`);

const displayId = (id) => `CE-${1000 + id}`;
const parseId = (s) => {
  const m = /^CE-(\d+)$/.exec(String(s || ''));
  return m ? Number(m[1]) - 1000 : NaN;
};

function row(o) {
  return o && { ...o, orderId: displayId(o.id), customer: JSON.parse(o.customer), items: JSON.parse(o.items) };
}

module.exports = {
  displayId,
  parseId,
  insert(o) {
    const r = db.prepare(`INSERT INTO orders
      (status, payment_method, fulfillment, customer, items, notes, subtotal, tax, delivery_fee, card_fee, total)
      VALUES (@status, @payment_method, @fulfillment, @customer, @items, @notes, @subtotal, @tax, @delivery_fee, @card_fee, @total)`)
      .run({ ...o, customer: JSON.stringify(o.customer), items: JSON.stringify(o.items) });
    return Number(r.lastInsertRowid);
  },
  get: (id) => row(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)),
  setStatus: (id, status) =>
    db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id),
  setRef: (id, ref) => db.prepare('UPDATE orders SET provider_ref = ? WHERE id = ?').run(ref, id),
  /** Pending → new, only once (webhook and redirect may both arrive). */
  markPaid: (id) =>
    db.prepare(`UPDATE orders SET status = 'new', updated_at = datetime('now')
                WHERE id = ? AND status IN ('pending_payment','awaiting_zelle')`).run(id).changes > 0,
  staffList: () => db.prepare(`SELECT * FROM orders
      WHERE status IN ('awaiting_zelle','new','preparing','ready')
         OR (status IN ('completed','cancelled') AND updated_at > datetime('now','-12 hours'))
      ORDER BY id DESC LIMIT 200`).all().map(row),
  expireStale: () => db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
      WHERE status = 'pending_payment' AND created_at < datetime('now','-45 minutes')`).run().changes,
};
