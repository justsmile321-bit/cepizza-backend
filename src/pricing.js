// Re-prices every order from the server's copy of menu.json. Client totals are ignored.
const menu = require('../menu.json');

const items = new Map();
for (const c of menu.categories) for (const i of c.items) items.set(i.id, i);

const cents = (n) => Math.round(Number(n) * 100);
const cfg = () => ({
  taxRate: Number(process.env.TAX_RATE ?? 0.0735),
  cardFee: cents(process.env.CARD_FEE ?? 0.5),
  deliveryFee: cents(process.env.DELIVERY_FEE ?? 0),
  deliveryMin: cents(process.env.DELIVERY_MINIMUM ?? 15),
});

class OrderError extends Error {}
const fail = (m) => { throw new OrderError(m); };

function priceOrder(body) {
  const { taxRate, cardFee, deliveryFee, deliveryMin } = cfg();
  const b = body || {};

  const method = b.paymentMethod;
  if (!['card', 'paypal', 'zelle', 'apple_pay'].includes(method)) fail('Unsupported payment method.');
  const fulfillment = b.fulfillment;
  if (!['pickup', 'delivery'].includes(fulfillment)) fail('Choose pickup or delivery.');

  const c = b.customer || {};
  const customer = {
    name: String(c.name || '').trim().slice(0, 80),
    phone: String(c.phone || '').trim().slice(0, 30),
    email: String(c.email || '').trim().slice(0, 120),
    address: String(c.address || '').trim().slice(0, 300),
  };
  if (!customer.name) fail('Name is required.');
  if (customer.phone.replace(/\D/g, '').length < 10) fail('A 10-digit phone number is required.');
  if (fulfillment === 'delivery' && !customer.address) fail('Delivery address is required.');

  if (!Array.isArray(b.items) || b.items.length === 0) fail('Your order is empty.');
  if (b.items.length > 100) fail('Too many lines in one order.');

  const lines = b.items.map((l) => {
    const item = items.get(l.itemId) || fail(`"${l.name || l.itemId}" is no longer on the menu.`);
    const size = item.sizes.find((s) => s.name === l.size) || fail(`Size "${l.size}" isn't available for ${item.name}.`);
    const quantity = Number(l.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) fail(`Invalid quantity for ${item.name}.`);

    let unit = cents(size.price);
    const addOns = (l.addOns || []).map((name) => {
      const a = (item.addOns || []).find((x) => x.name === name) || fail(`"${name}" isn't available on ${item.name}.`);
      unit += cents(a.sizePrices?.[size.name] ?? a.price ?? 0);
      return name;
    });

    const choices = (item.choices || []).map((g) => {
      const picked = (l.choices || []).find((x) => x.group === g.name);
      if (!picked || !g.options.includes(picked.option)) fail(`Please choose ${g.name.toLowerCase()} for ${item.name}.`);
      return { group: g.name, option: picked.option };
    });

    return {
      itemId: item.id, name: item.name, size: item.sizes.length > 1 ? size.name : null,
      addOns, choices, quantity, unit, lineTotal: unit * quantity,
      notes: String(l.notes || '').trim().slice(0, 300),
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  if (fulfillment === 'delivery' && subtotal < deliveryMin)
    fail(`Delivery requires a $${(deliveryMin / 100).toFixed(2)} minimum order.`);

  const delivery_fee = fulfillment === 'delivery' ? deliveryFee : 0;
  const tax = Math.round(subtotal * taxRate);
  const card_fee = method === 'zelle' ? 0 : cardFee;

  return {
    payment_method: method, fulfillment, customer, items: lines,
    notes: String(b.notes || '').trim().slice(0, 500),
    subtotal, tax, delivery_fee, card_fee, total: subtotal + tax + delivery_fee + card_fee,
  };
}

module.exports = { priceOrder, OrderError };
